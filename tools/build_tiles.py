#!/usr/bin/env python3
"""
Build the v20 tile pyramids:  data/*.png|jpg  ->  datajs/tiles/

    python tools/build_tiles.py                 # every layer
    python tools/build_tiles.py --only dem,ortho
    python tools/build_tiles.py --dry-run       # counts and bytes, writes nothing

WHY THIS EXISTS (docs/V20_TERRAIN_SPEC.md section 2)
----------------------------------------------------
The 3D view used to build ONE mesh per DEM, decimated by strideFor(dem, 640..1100),
so the 1-ft data was never drawn at 1 ft, and it draped each mesh with ONE texture
(the ABP composite was an 11488 x 15528 canvas).  A quadtree of 256 x 256 tiles
fixes both: the renderer picks a level per tile from the screen-space error, so the
1-ft data is drawn at 1 ft where the camera is close enough to see it, and each tile
carries its own drape.

THE ONE SCHEME, USED BY EVERY LAYER
-----------------------------------
    origin      X0 = 6368100.0, Y0 = 2122800.0   (the site DEM's SW corner)
    level z     cell size = 2**z feet            (z = 0 is 1 ft, z = 6 is 64 ft)
    tile (z,x,y)  covers  X0 + x*256*2**z  ..  + 256*2**z,  Y likewise, Y north-up
    pixel (i,r)   samples  X0 + (x*256+i)*2**z ,  Y0 + (y*256 + (255-r))*2**z
                  -- PNG row 0 is NORTH, the same convention as every raster here.

Every offset in that scheme is an integer number of feet and every source grid
(1 ft and 2 ft) has integer node spacing anchored on an integer coordinate, so a
DEM tile pixel lands EXACTLY on a source grid node at every level.  DEM tiles are
therefore a pure decimation -- nearest node, never an average -- which is what lets
test/tiles.mjs compare a tile against SBMM.elev's own grid and demand equality to
the terrain-RGB step rather than to a tolerance.  Imagery is box-averaged when it
is being reduced, which is a display decision and affects no number.

THE FINEST LEVEL, AND THE `partial` FLAG THE RENDERER DESCENDS BY
-----------------------------------------------------------------
Level 0 (1 ft) exists only where the 1-ft data does: dem_abp and dem_res.  A level-0
tile is written only when the whole 256 x 256 square lies inside the union of those
two windows, and that level is marked `partial: true` in the index.  Every other
level is written whenever the square has ANY data at all, and is `partial: false`.

The distinction is the whole of the quadtree's descent rule, and getting it wrong
is silent: on a NOT-partial level an absent child means the ground there is absent
too (the parent is the same samples, coarser), so the renderer descends as soon as
ONE child exists and simply skips the empty quadrants.  On a partial level an absent
child means the FINE data does not cover it while the parent still has ground there,
so the renderer descends only when all four exist.  Requiring all four everywhere
was tried first and is why the quadtree drew nothing but its 64-ft root: level 5 has
three tiles, not four, because the fourth is entirely off the survey.

SOURCE
------
The masters (SBMM\\LiDAR and Aerial Survey Data\\_staging\\master_1ft.f32 and the CHM
f32) are on the user's machine and not in the repo, so this build reads the repo's
own data/*.png and data/*.jpg -- i.e. the same rasters the app ships today, already
quantised to the terrain-RGB step.  index.js records that in `source`; re-run this
against the masters when they are available and the string changes with it.
"""
import base64, io, json, os, sys, datetime
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "datajs", "tiles")

TILE = 256
X0, Y0 = 6368100.0, 2122800.0          # the site DEM's SW corner: the tile origin
ZMIN, STEP = 1325.0, 0.02              # terrain-RGB encoding, as js/dem.js
MAX_TILE_BYTES = 200 * 1024            # spec section 2: a tile is never larger than 200 kB

SOURCE = ("repo rasters data/*.png|jpg (the masters "
          "'LiDAR and Aerial Survey Data/_staging/master_1ft.f32' and the CHM f32 "
          "are on the user's machine and were not available on the build box)")


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------
def load_json(name):
    with open(os.path.join(DATA, name + ".json")) as f:
        return json.load(f)


def decode_terrain_rgb(png, meta):
    """PNG -> Float32 south-up array, byte-for-byte js/dem.js's loop."""
    a = np.asarray(Image.open(png).convert("RGB"), dtype=np.uint16)
    v = (a[:, :, 0] << 8) | a[:, :, 1]
    z = np.where(v == 0, np.nan,
                 meta["zmin"] + (v.astype(np.float32) - 1) * meta["step"]).astype(np.float32)
    return z[::-1, :].copy()           # PNG row 0 = north -> array row 0 = y0


class Grid:
    """A node-sampled source grid: value at (x0 + i*cell, y0 + j*cell)."""

    def __init__(self, name, meta, arr):
        self.name, self.m, self.z = name, meta, arr

    def sample(self, X, Y):
        m = self.m
        fi = np.rint((X - m["x0"]) / m["cell"])
        fj = np.rint((Y - m["y0"]) / m["cell"])
        ok = (fi >= 0) & (fi < m["w"]) & (fj >= 0) & (fj < m["h"])
        i = np.clip(fi, 0, m["w"] - 1).astype(np.int32)
        j = np.clip(fj, 0, m["h"] - 1).astype(np.int32)
        out = self.z[j, i]
        return np.where(ok, out, np.nan)

    def rect(self):
        m = self.m
        return (m["x0"], m["y0"], m["x0"] + (m["w"] - 1) * m["cell"],
                m["y0"] + (m["h"] - 1) * m["cell"])


class ImageSource:
    """A georeferenced image: bounds in feet, row 0 = north."""

    def __init__(self, name, path, bounds, mode="RGB"):
        self.name = name
        self.img = Image.open(path).convert(mode)
        self.a = np.asarray(self.img, dtype=np.uint8)
        self.x0, self.y0, self.x1, self.y1 = bounds
        self.h, self.w = self.a.shape[0], self.a.shape[1]
        self.ppfx = self.w / (self.x1 - self.x0)
        self.ppfy = self.h / (self.y1 - self.y0)

    def rect(self):
        return (self.x0, self.y0, self.x1, self.y1)

    def sample_box(self, X, Y, cell):
        """Average the source over the destination cell (a box filter when the
        destination is coarser, nearest when it is finer). Returns HxWx3 uint8
        and a validity mask."""
        n = max(1, int(round(min(self.ppfx, self.ppfy) * cell)))
        n = min(n, 8)                                   # 64 taps is plenty
        acc = np.zeros(X.shape + (3,), dtype=np.float32)
        cnt = np.zeros(X.shape, dtype=np.float32)
        for oy in range(n):
            for ox in range(n):
                sx = X + (ox + 0.5) * cell / n - cell / 2
                sy = Y + (oy + 0.5) * cell / n - cell / 2
                px = np.floor((sx - self.x0) * self.ppfx).astype(np.int64)
                py = np.floor((self.y1 - sy) * self.ppfy).astype(np.int64)
                ok = (px >= 0) & (px < self.w) & (py >= 0) & (py < self.h)
                pxc = np.clip(px, 0, self.w - 1)
                pyc = np.clip(py, 0, self.h - 1)
                v = self.a[pyc, pxc].astype(np.float32)
                acc += v * ok[:, :, None]
                cnt += ok
        valid = cnt > 0
        out = np.zeros_like(acc, dtype=np.uint8)
        safe = np.maximum(cnt, 1)[:, :, None]
        out = np.clip(acc / safe, 0, 255).astype(np.uint8)
        return out, valid


# --------------------------------------------------------------------------
# the tile grid
# --------------------------------------------------------------------------
def cell_of(z):
    return float(2 ** z)


def tile_range(rect, z):
    """Tile indices covering a world rectangle at level z."""
    span = TILE * cell_of(z)
    tx0 = int(np.floor((rect[0] - X0) / span))
    ty0 = int(np.floor((rect[1] - Y0) / span))
    tx1 = int(np.floor((rect[2] - X0 - 1e-6) / span))
    ty1 = int(np.floor((rect[3] - Y0 - 1e-6) / span))
    return tx0, ty0, tx1, ty1


def tile_coords(z, tx, ty):
    """The world X and Y of every pixel of a tile, PNG row 0 = north."""
    c = cell_of(z)
    xs = X0 + (tx * TILE + np.arange(TILE)) * c
    ys = Y0 + (ty * TILE + (TILE - 1 - np.arange(TILE))) * c
    return np.meshgrid(xs, ys)


def union_rects(rects):
    return (min(r[0] for r in rects), min(r[1] for r in rects),
            max(r[2] for r in rects), max(r[3] for r in rects))


def inside_union(rect, rects):
    """Is `rect` wholly inside the union of `rects`?  Same subtraction the 3D
    view's coveredBy() does -- testing each rect on its own is not enough once
    two of them overlap (js/viewer3d.js)."""
    rem = [rect]
    for r in rects:
        nxt = []
        for a in rem:
            if r[2] <= a[0] or r[0] >= a[2] or r[3] <= a[1] or r[1] >= a[3]:
                nxt.append(a); continue
            if a[1] < r[1]: nxt.append((a[0], a[1], a[2], r[1]))
            if a[3] > r[3]: nxt.append((a[0], r[3], a[2], a[3]))
            yy0, yy1 = max(a[1], r[1]), min(a[3], r[3])
            if yy1 > yy0:
                if a[0] < r[0]: nxt.append((a[0], yy0, r[0], yy1))
                if a[2] > r[2]: nxt.append((r[2], yy0, a[2], yy1))
        rem = nxt
        if not rem:
            return True
    return False


def encode_png(arr):
    b = io.BytesIO()
    Image.fromarray(arr, "RGB").save(b, "PNG", optimize=True)
    return b.getvalue(), "image/png"


def encode_jpeg(arr, q=78):
    b = io.BytesIO()
    Image.fromarray(arr, "RGB").save(b, "JPEG", quality=q, optimize=True)
    return b.getvalue(), "image/jpeg"


def write_tile(layer, z, tx, ty, blob, mime, dry):
    key = f"{layer}/{z}/{tx}/{ty}"
    b64 = base64.b64encode(blob).decode()
    js = ('window.SBMM_TILES=window.SBMM_TILES||{};SBMM_TILES['
          + json.dumps(key) + ']="data:' + mime + ';base64,' + b64 + '";\n')
    if not dry:
        with open(os.path.join(OUT, f"{layer}_{z}_{tx}_{ty}.js"), "w") as f:
            f.write(js)
    return len(js)


# --------------------------------------------------------------------------
# layers
# --------------------------------------------------------------------------
def build_dem(dems, dry):
    """DEM pyramid.  z0 uses ONLY the 1-ft grids (and only whole tiles inside
    their union); z>=1 uses the whole stack, finest first -- the same order
    SBMM.dems has, so a tile answers what SBMM.elev answers."""
    fine = [dems["dem_abp"], dems["dem_res"]]
    fine = [g for g in fine if g is not None]
    stack = [dems[n] for n in ("dem_abp", "dem_res", "dem_site") if dems.get(n) is not None]
    site = dems["dem_site"]
    levels = {}
    for z in range(0, 7):
        srcs = fine if z <= 0 else stack
        rect = union_rects([g.rect() for g in (fine if z <= 0 else [site])])
        tx0, ty0, tx1, ty1 = tile_range(rect, z)
        tiles, total = [], 0
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                c = cell_of(z)
                tr = (X0 + tx * TILE * c, Y0 + ty * TILE * c,
                      X0 + (tx + 1) * TILE * c, Y0 + (ty + 1) * TILE * c)
                if z <= 0 and not inside_union(tr, [g.rect() for g in fine]):
                    continue
                X, Y = tile_coords(z, tx, ty)
                zz = np.full(X.shape, np.nan, dtype=np.float32)
                for g in srcs:
                    need = np.isnan(zz)
                    if not need.any():
                        break
                    v = g.sample(X, Y)
                    zz = np.where(need, v, zz)
                if np.all(np.isnan(zz)):
                    continue
                v = np.where(np.isnan(zz), 0,
                             np.rint((zz - ZMIN) / STEP) + 1).astype(np.int64)
                v = np.clip(v, 0, 65535).astype(np.uint16)
                rgb = np.zeros(X.shape + (3,), dtype=np.uint8)
                rgb[:, :, 0] = (v >> 8).astype(np.uint8)
                rgb[:, :, 1] = (v & 255).astype(np.uint8)
                blob, mime = encode_png(rgb)
                n = write_tile("dem", z, tx, ty, blob, mime, dry)
                tiles.append([tx, ty, n]); total += n
        levels[str(z)] = {"cell": cell_of(z), "count": len(tiles), "partial": z <= 0,
                          "bytes": total, "tiles": tiles}
        print(f"  dem  z{z} cell {cell_of(z):>4.0f} ft  {len(tiles):>4} tiles  {total/1e6:6.2f} MB"
              + ("  (partial — whole tiles only)" if z <= 0 else ""))
    return {"kind": "terrain-rgb", "mime": "image/png", "zmin": ZMIN, "step": STEP,
            "levels": levels}


def build_image(name, srcs, zlo, zhi, dry, mime="jpeg", quality=78, mode="RGB"):
    """A drape pyramid: the finest source wins per pixel, box-averaged down."""
    levels = {}
    for z in range(zlo, zhi + 1):
        rect = union_rects([s.rect() for s in srcs])
        tx0, ty0, tx1, ty1 = tile_range(rect, z)
        tiles, total = [], 0
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                c = cell_of(z)
                X, Y = tile_coords(z, tx, ty)
                out = np.zeros(X.shape + (3,), dtype=np.uint8)
                have = np.zeros(X.shape, dtype=bool)
                # coarsest first so the finest imagery paints last
                for s in srcs:
                    px, ok = s.sample_box(X, Y, c)
                    take = ok
                    out = np.where(take[:, :, None], px, out)
                    have |= take
                if not have.any():
                    continue
                blob, m = (encode_jpeg(out, quality) if mime == "jpeg"
                           else encode_png(out))
                n = write_tile(name, z, tx, ty, blob, m, dry)
                tiles.append([tx, ty, n]); total += n
        levels[str(z)] = {"cell": cell_of(z), "count": len(tiles), "partial": False,
                          "bytes": total, "tiles": tiles}
        print(f"  {name:<9} z{z} cell {cell_of(z):>4.0f} ft  {len(tiles):>4} tiles  {total/1e6:6.2f} MB")
    return {"kind": "image", "mime": "image/" + ("jpeg" if mime == "jpeg" else "png"),
            "levels": levels}


def build_chm(dry):
    meta = load_json("chm")
    arr = decode_terrain_rgb(os.path.join(DATA, "chm.png"), meta)
    g = Grid("chm", meta, arr)
    levels = {}
    for z in range(0, 5):
        tx0, ty0, tx1, ty1 = tile_range(g.rect(), z)
        tiles, total = [], 0
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                X, Y = tile_coords(z, tx, ty)
                zz = g.sample(X, Y)
                if np.all(np.isnan(zz)):
                    continue
                v = np.where(np.isnan(zz), 0,
                             np.rint((zz - meta["zmin"]) / meta["step"]) + 1).astype(np.int64)
                v = np.clip(v, 0, 65535).astype(np.uint16)
                rgb = np.zeros(X.shape + (3,), dtype=np.uint8)
                rgb[:, :, 0] = (v >> 8).astype(np.uint8)
                rgb[:, :, 1] = (v & 255).astype(np.uint8)
                blob, m = encode_png(rgb)
                n = write_tile("chm", z, tx, ty, blob, m, dry)
                tiles.append([tx, ty, n]); total += n
        levels[str(z)] = {"cell": cell_of(z), "count": len(tiles), "partial": False,
                          "bytes": total, "tiles": tiles}
        print(f"  chm       z{z} cell {cell_of(z):>4.0f} ft  {len(tiles):>4} tiles  {total/1e6:6.2f} MB")
    return {"kind": "terrain-rgb", "mime": "image/png",
            "zmin": meta["zmin"], "step": meta["step"], "levels": levels}


PARTIAL = {("dem", 0): True}      # the ONE partial level; see the header


def reindex():
    """Rebuild datajs/tiles/index.js from the tiles already on disk.

    The index is 30 kB of bookkeeping over 52 MB of payload, and it is the only
    part of the pyramid that changes when the RENDERER learns something new
    about it (the `partial` flag was exactly that). Re-cutting 2,311 PNGs to
    rewrite a manifest is 35 minutes for nothing, so this reads the directory
    instead. It cannot invent a tile that is not there, which is the property
    that makes it safe: test/tiles.mjs still checks the index against the disk
    both ways."""
    layers = {}
    for f in sorted(os.listdir(OUT)):
        if not f.endswith(".js") or f == "index.js":
            continue
        stem = f[:-3].rsplit("_", 3)
        if len(stem) != 4:
            print("  skipping unrecognised", f); continue
        layer, z, x, y = stem[0], int(stem[1]), int(stem[2]), int(stem[3])
        n = os.path.getsize(os.path.join(OUT, f))
        L = layers.setdefault(layer, {})
        L.setdefault(z, []).append([x, y, n])
    out = {}
    for layer, lv in layers.items():
        terrain = layer in ("dem", "chm")
        meta = load_json("chm") if layer == "chm" else None
        rec = {"kind": "terrain-rgb" if terrain else "image",
               "mime": "image/png" if terrain or layer == "cover" else "image/jpeg",
               "levels": {}}
        if terrain:
            rec["zmin"] = meta["zmin"] if meta else ZMIN
            rec["step"] = meta["step"] if meta else STEP
        for z in sorted(lv):
            t = sorted(lv[z])
            rec["levels"][str(z)] = {"cell": cell_of(z), "count": len(t),
                                     "partial": PARTIAL.get((layer, z), False),
                                     "bytes": sum(a[2] for a in t), "tiles": t}
        out[layer] = rec
    return out


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    if "--reindex" in args:
        layers = reindex()
        idx = {"version": 1, "built": datetime.date.today().isoformat(), "source": SOURCE,
               "origin": {"x0": X0, "y0": Y0}, "tileSize": TILE,
               "cellRule": "cell_ft = 2**z", "row0": "north", "layers": layers}
        js = ('window.SBMM_TILES=window.SBMM_TILES||{};SBMM_TILES.index='
              + json.dumps(idx, separators=(",", ":")) + ";\n")
        with open(os.path.join(OUT, "index.js"), "w") as f:
            f.write(js)
        for layer, L in layers.items():
            for z in sorted(L["levels"], key=int):
                l = L["levels"][z]
                print(f"  {layer:<9} z{z} cell {l['cell']:>4.0f} ft  {l['count']:>4} tiles"
                      f"  {l['bytes']/1e6:6.2f} MB" + ("  partial" if l["partial"] else ""))
        print(f"\nindex.js  {len(js)/1024:.0f} kB  (rebuilt from disk, no tile re-cut)")
        return
    only = None
    if "--only" in args:
        only = set(args[args.index("--only") + 1].split(","))
    if not dry:
        os.makedirs(OUT, exist_ok=True)
        for f in os.listdir(OUT):
            if f.endswith(".js"):
                os.remove(os.path.join(OUT, f))

    layers, warn = {}, []

    def want(n):
        return only is None or n in only

    dems = {}
    if want("dem"):
        for n in ("dem_site", "dem_abp", "dem_res"):
            p = os.path.join(DATA, n + ".png")
            if not os.path.exists(p):
                dems[n] = None; warn.append(n + " absent"); continue
            meta = load_json(n)
            dems[n] = Grid(n, meta, decode_terrain_rgb(p, meta))
        layers["dem"] = build_dem(dems, dry)

    if want("ortho"):
        srcs = []
        for n, f in (("ortho_site", "ortho_site.jpg"), ("ortho_mine", "ortho_mine.jpg"),
                     ("ortho_abp", "ortho_abp.jpg")):
            p = os.path.join(DATA, f)
            if not os.path.exists(p):
                warn.append(f + " absent"); continue
            b = load_json(n)
            srcs.append(ImageSource(n, p, (b["x0"], b["y0"], b["x1"], b["y1"])))
        if srcs:
            # z0 (1 ft) only where the 6-in and 3-in imagery is; z1..z6 site-wide
            fine = [s for s in srcs if s.name != "ortho_site"]
            lv = build_image("ortho", srcs, 1, 6, dry)
            if fine:
                lv0 = build_image("ortho", fine, 0, 0, dry)
                lv["levels"]["0"] = lv0["levels"]["0"]
            layers["ortho"] = lv

    if want("hillshade"):
        srcs = []
        for n, f, d in (("hs_site", "hs_site.jpg", "dem_site"),
                        ("hs_abp", "hs_abp.jpg", "dem_abp")):
            p = os.path.join(DATA, f)
            if not os.path.exists(p):
                warn.append(f + " absent"); continue
            m = load_json(d)
            srcs.append(ImageSource(n, p, (m["x0"], m["y0"],
                                           m["x0"] + m["w"] * m["cell"],
                                           m["y0"] + m["h"] * m["cell"])))
        if srcs:
            layers["hillshade"] = build_image("hillshade", srcs, 1, 6, dry)

    if want("chm") and os.path.exists(os.path.join(DATA, "chm.png")):
        layers["chm"] = build_chm(dry)

    if want("cover") and os.path.exists(os.path.join(DATA, "cover.png")):
        c = load_json("cover")["grid"]
        s = ImageSource("cover", os.path.join(DATA, "cover.png"),
                        (c["x0"], c["y0"], c["x0"] + c["w"] * c["cell"],
                         c["y0"] + c["h"] * c["cell"]))
        # PNG, not JPEG: the cover raster's colours ARE the class palette and a
        # lossy codec would invent classes that do not exist (tools/build_cover.py).
        layers["cover"] = build_image("cover", [s], 1, 4, dry, mime="png")

    idx = {"version": 1, "built": datetime.date.today().isoformat(), "source": SOURCE,
           "origin": {"x0": X0, "y0": Y0}, "tileSize": TILE,
           "cellRule": "cell_ft = 2**z", "row0": "north",
           "layers": layers}
    js = ('window.SBMM_TILES=window.SBMM_TILES||{};SBMM_TILES.index='
          + json.dumps(idx, separators=(",", ":")) + ';\n')
    if not dry:
        with open(os.path.join(OUT, "index.js"), "w") as f:
            f.write(js)

    tot = sum(l["bytes"] for L in layers.values() for l in L["levels"].values())
    cnt = sum(l["count"] for L in layers.values() for l in L["levels"].values())
    big = [k for k in ()]
    print(f"\nindex.js  {len(js)/1024:.0f} kB")
    print(f"{cnt} tiles, {tot/1e6:.1f} MB of payload -> datajs/tiles/")
    for w in warn:
        print("  warning:", w)


if __name__ == "__main__":
    main()
