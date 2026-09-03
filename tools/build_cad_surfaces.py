#!/usr/bin/env python3
"""Build data/design/surf_*.png + data/design/surfaces.json — the design-surface
set of docs/V9_SPEC.md §5, plus datajs/d_cad_surfaces.js.

What is in here, and how each surface was arrived at
====================================================

Three recovery routes were tried for EA's Civil 3D *proposed* grade.  All three
results are recorded, including the negative one, because the previous
conclusion in CLAUDE.md ("locked in AECC_TIN_SURFACE / proprietary .mms, do not
reverse-engineer") turned out to be only half true — the *existing* surfaces
came out byte-for-byte, the proposed ones are genuinely not in the files.

(a) PROXY GRAPHICS — dead, definitively.
    Every AECC_* object in C-BASE / 01.01 / 02.01 / 02.02 carries a `preview`
    blob, and every one of them is 676-688 bytes: an AcDbProxyEntity header plus
    the UTF-16 class name ("AeccDbSurfaceTin (AeccLand1300)").  No AcGi
    world-draw segments at all.  EA saved with PROXYGRAPHICS off.

(b) RAW OBJECT / .mms SCAN — WORKS, and recovers the EXISTING surfaces.
    Civil 3D stores surface points as stride-4 little-endian float64 records
    (x, y, z, id64) starting at an arbitrary BIT offset inside the object
    stream.  Earlier attempts failed because they tried bit-shifts OR byte
    offsets but never the product of the two; the arrays in this project sit at
    bit=1, byte=4.  `tools/scan_dwg_surfaces.py` sweeps all 64
    (bit, byte) combinations across the whole undecoded blob and segments the
    hits into contiguous stride-4 runs, so distinct surfaces come out
    separately.  Two genuine EA TINs came out:

      * 955,387 points from the AECC_TIN_SURFACE object stream, present
        identically in C-BASE.dwg, 01.01 SiteExcavAndCapping.dwg,
        02.01 SiteRepository.dwg and 02.02 North_lobe.dwg (the sheets xref
        C-BASE, so the same surface is bound into each — itself a cross-check).
      * 933,112 points from 02.03 Borrow_Area_193e7.mms, a ZIP whose single
        member is a 272,737,606-byte DEFLATE stream.

    Both validate against the January-2024 lidar master (mean 0.00 / sd 0.16 ft
    and mean +0.12 / sd 0.34 ft), which proves the decode is right — and also
    shows that both are EA's EXISTING ground.

(c) NO PROPOSED TIN IS PRESENT.  This is a result, not a gap in the search.
    Every undecoded blob and every decoded object's `unknown_bits` in C-BASE,
    01.01, 02.01 and 02.02 was swept at all 64 alignments.  Outside the one
    955 k-point existing TIN the only stride-4 runs found are 200-500 point
    sets of dense 3-D linework, and every one of them sits ON existing ground
    (90-94 % of points within 0.3 ft of lidar; the z = 1441.0 cluster in the
    East Stockpile area has lidar 1441.0 underneath it).  They are existing
    contours, not a proposed grade.

    The spec's fallback — constrained Delaunay from the 3-D grading breaklines
    and daylight lines — is NOT used, because its input is not there: the
    `grade` group is 47 features totalling 145 vertices, mostly 2-point contour
    stubs spanning a 40 ft strip of the East Stockpile, and the `daylight`
    group carries a usable Z on 17 of 187 vertices.  A Delaunay over that would
    invent the whole pad shape, which is precisely the failure CLAUDE.md warns
    against ("do not synthesise a surface from the breaklines and call it the
    design").  `repo_fg` and `nlobe_fg` are therefore reported in
    `not_recovered`, with the one-line request that would close it: **ask EA for
    a LandXML export or a proposed-grade raster of the repository and north
    lobe surfaces.**

(d) THE RESIDENTIAL DESIGN IS DEPTH-BASED, and that is what §5 asks for.
    EA's sheets say so:

        "EXCAVATE WORK AREA TO ONE FOOT DEPTH UNLESS OTHERWISE INDICATED"
        "PROVIDE 12in OF FILL IN ANY UNHATCHED AREA INSIDE THE LIMITS OF
         EXCAVATION AND/ OR FILL"
        "TRANSITION TO EXISTING GRADE AT LIMITS OF FILL BOUNDARY"

    so `res_excbottom` = lidar EG - depth_ft inside each limit-of-excavation
    polygon and EG elsewhere, and `res_finish` = lidar EG (excavate, then
    backfill to grade; the 12 in of fill in unhatched areas is what brings those
    back to existing too).  Both are `kind: "derived"`, never `proposed`.

Excavation-limit authority (per §5, "use the designgis excavation polygons as
authority if cad_native polygons are open/ambiguous — document which you used
per lot").  In EA's CAD the limit of excavation is drawn as loose open segments
per lot that never close; the *closed* CAD polygons on those layers are the
small special-treatment sub-areas, and they match EA's own leader labels
(172 SF, 913 SF, 2165 SF...).  Polygonising the CAD segments recovers the
sub-areas and misses the lots entirely — 31.6 k SF instead of 204 k.  The
geodatabase `exc` polygons match EA's printed areas exactly (22,850 / 29,362 /
34,167 / 42,797 SF ...), so **the geodatabase polygon is the authority for every
lot**, and the run prints (and surfaces.json records) the per-polygon table.

Depth attribution is taken exactly as `tools/build_cad_native.py` left it:
every closed excavation polygon carries depth_ft = 1.0 from the sheet note.
The 6-inch call-outs it found (four of them) are sheet-level leader annotations
naming a spot rather than a closed region, so none of them is attached to a polygon;
they are carried into surfaces.json as `depth_overrides_unapplied` so the
0.5 ft areas stay visible instead of silently becoming 1.0 ft.

Raster convention is the app's, unchanged from tools/build_dems_from_master.py:
terrain-RGB PNG, v = R*256 + G, z = zmin + (v-1)*zstep, v == 0 is nodata, B = 0,
PNG row 0 is NORTH.  js/dem.js and js/cadnative.js both decode exactly this.

Usage
-----
    dwgread -O JSON -o dump.json "1578546 - 01.01 - SiteExcavAndCapping.dwg"
    python3 tools/pull_dwg_blob.py     dump.json blob.bin
    python3 tools/scan_dwg_surfaces.py blob.bin  exc      # -> exc_runs.npy
    python3 tools/scan_dwg_objects.py  dump.json excobj   # decoded objects too
    python3 tools/build_cad_surfaces.py \
        --master /path/master_1ft.f32 \
        --tin    /path/exc_tin_ordered.npy \
        --borrow /path/borrow_pts_sp.npy \
        --cad    data/design/cad_native.json \
        --gis    data/design_gis.json \
        --out    data/design --datajs datajs
"""

import argparse, base64, json, math, os

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ZSTEP = 0.02                     # same encoding step as dem_site / dem_abp
MASTER = dict(x0=6368100.0, y0=2122800.0, cell=1.0, w=9700, h=8900)
PAD = 25                         # ft of margin around a surface footprint
DEFAULT_DEPTH = 1.0
WORK_BUFFER_FT = 60          # EG carried this far outside the excavation limits


# ---------------------------------------------------------------- helpers

def load_master(path):
    return np.memmap(path, dtype="<f4", mode="r",
                     shape=(MASTER["h"], MASTER["w"]))


def master_window(M, x0, y0, w, h):
    """EG over a window, NaN where the master has nodata or the window runs
    off the master (a window edge outside the flight is not an error)."""
    eg = np.full((h, w), np.nan)
    i0 = int(round(x0 - MASTER["x0"]))
    j0 = int(round(y0 - MASTER["y0"]))
    si0, sj0 = max(0, i0), max(0, j0)
    si1 = min(MASTER["w"], i0 + w)
    sj1 = min(MASTER["h"], j0 + h)
    if si1 <= si0 or sj1 <= sj0:
        return eg
    src = np.array(M[sj0:sj1, si0:si1], dtype=np.float64)
    src[src <= -9990] = np.nan
    eg[sj0 - j0:sj1 - j0, si0 - i0:si1 - i0] = src
    return eg


def encode_terrain_rgb(z, zmin, step=ZSTEP):
    """z: 2-D float array, row 0 = SOUTH (master convention). NaN -> nodata.
    Returns a PIL image with row 0 = NORTH, per the app's DEM contract."""
    v = np.where(np.isfinite(z), np.rint((z - zmin) / step) + 1.0, 0.0)
    v = np.clip(v, 0, 65535).astype(np.uint32)
    rgb = np.zeros(z.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = (v >> 8).astype(np.uint8)
    rgb[..., 1] = (v & 0xFF).astype(np.uint8)
    return Image.fromarray(rgb[::-1])          # flip to row 0 = north


def grid_points(P, x0, y0, w, h, cell=1.0):
    """Nearest-cell mean of scattered xyz onto a grid (row 0 = south)."""
    i = np.rint((P[:, 0] - x0) / cell).astype(np.int64)
    j = np.rint((P[:, 1] - y0) / cell).astype(np.int64)
    ok = (i >= 0) & (i < w) & (j >= 0) & (j < h)
    i, j, z = i[ok], j[ok], P[ok, 2]
    flat = j * w + i
    s = np.bincount(flat, weights=z, minlength=w * h)
    n = np.bincount(flat, minlength=w * h)
    out = np.full(w * h, np.nan)
    nz = n > 0
    out[nz] = s[nz] / n[nz]
    return out.reshape(h, w)


def tin_grid(P, x0, y0, w, h, max_edge=25.0, chunk=2_000_000):
    """Rasterise a recovered TIN by linear interpolation over its Delaunay
    triangulation, not by dropping points into cells.

    Nearest-cell binning is what the first pass did and it is wrong for these
    surfaces: EA's TINs are ~3.7 ft point spacing, so a 1 ft grid built by
    binning is 84 % nodata and `surfaceElev` returns NaN at most of the
    residential lots — the raster looks like a surface and behaves like
    confetti.  Interpolating the triangulation fills the cells that are
    genuinely inside the TIN and leaves the rest nodata.

    Triangles with an edge longer than `max_edge` are dropped, which is what
    keeps the interpolation from bridging the concave parts of the hull (a
    Delaunay hull is convex; the surface is not).  25 ft is ~7x the point
    spacing — long enough to keep every real triangle, short enough to cut the
    hull-spanning slivers."""
    from scipy.spatial import Delaunay
    from scipy.interpolate import LinearNDInterpolator
    tri = Delaunay(P[:, :2])
    v = P[tri.simplices][:, :, :2]
    e = np.maximum.reduce([
        np.linalg.norm(v[:, 0] - v[:, 1], axis=1),
        np.linalg.norm(v[:, 1] - v[:, 2], axis=1),
        np.linalg.norm(v[:, 2] - v[:, 0], axis=1)])
    keep = e <= max_edge
    interp = LinearNDInterpolator(tri, P[:, 2])
    out = np.full(w * h, np.nan)
    xs = (np.arange(w) + x0).astype(np.float64)
    ys = (np.arange(h) + y0).astype(np.float64)
    rows_per = max(1, int(chunk // w))
    for j0 in range(0, h, rows_per):
        j1 = min(h, j0 + rows_per)
        gx, gy = np.meshgrid(xs, ys[j0:j1])
        pts = np.column_stack([gx.ravel(), gy.ravel()])
        simp = tri.find_simplex(pts)
        ok = (simp >= 0) & keep[np.clip(simp, 0, len(keep) - 1)]
        if ok.any():
            seg = np.full(len(pts), np.nan)
            seg[ok] = interp(pts[ok])
            out[j0 * w:j1 * w] = seg
    g = out.reshape(h, w)
    print(f"    TIN {len(P):,} pts -> {int(np.isfinite(g).sum()):,} cells "
          f"({100 * np.mean(np.isfinite(g)):.1f} % of the window), "
          f"{int(keep.sum()):,}/{len(keep):,} triangles kept")
    return g


def fill_small_gaps(g, iters=3):
    """Close single-cell holes left by scattered-point gridding."""
    for _ in range(iters):
        m = ~np.isfinite(g)
        if not m.any():
            break
        acc = np.zeros_like(g)
        cnt = np.zeros(g.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            s = np.roll(np.where(np.isfinite(g), g, 0.0), (dy, dx), (0, 1))
            c = np.roll(np.isfinite(g).astype(float), (dy, dx), (0, 1))
            acc += s
            cnt += c
        newv = np.where((cnt > 1) & m, acc / np.maximum(cnt, 1), np.nan)
        g = np.where(m & np.isfinite(newv), newv, g)
    return g


def ring_mask(ring, x0, y0, w, h):
    """Scan-convert ONE closed ring to a boolean mask, row 0 = south.

    One ring at a time, OR-ed by the caller.  XOR-ing every ring into a shared
    mask is wrong here and was a real bug: EA's excavation limits overlap and
    nest, and a shared XOR makes overlapping lots cancel each other out — it
    produced a mask about a tenth of the true area."""
    one = np.zeros((h, w), dtype=bool)
    pts = np.asarray(ring, dtype=float)
    if len(pts) < 4:
        return one
    if pts[0][0] != pts[-1][0] or pts[0][1] != pts[-1][1]:
        pts = np.vstack([pts, pts[:1]])
    xs = pts[:, 0] - x0
    ys = pts[:, 1] - y0
    ymin = max(0, int(math.floor(ys.min())))
    ymax = min(h - 1, int(math.ceil(ys.max())))
    for row in range(ymin, ymax + 1):
        yc = float(row)
        xin = []
        for k in range(len(pts) - 1):
            y1, y2 = ys[k], ys[k + 1]
            if (y1 <= yc < y2) or (y2 <= yc < y1):
                t = (yc - y1) / (y2 - y1)
                xin.append(xs[k] + t * (xs[k + 1] - xs[k]))
        if len(xin) < 2:
            continue
        xin.sort()
        for a in range(0, len(xin) - 1, 2):
            ia = max(0, int(math.ceil(xin[a])))
            ib = min(w - 1, int(math.floor(xin[a + 1])))
            if ib >= ia:
                one[row, ia:ib + 1] = True
    return one


def ring_area(ring):
    p = np.asarray(ring, dtype=float)
    if len(p) < 3:
        return 0.0
    x, y = p[:, 0], p[:, 1]
    return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2.0


def volumes_yd3(design, existing, cell=1.0):
    """cut/fill/net in cubic yards, design relative to existing."""
    d = design - existing
    v = np.isfinite(d)
    fill = float(np.sum(np.where(d > 0, d, 0.0)[v])) * cell * cell / 27.0
    cut = float(np.sum(np.where(d < 0, -d, 0.0)[v])) * cell * cell / 27.0
    return dict(cut=round(cut, 1), fill=round(fill, 1),
                net=round(fill - cut, 1))


def point_stats(P, M):
    """Residual of scattered surface points against the lidar master."""
    i = np.rint(P[:, 0] - MASTER["x0"]).astype(np.int64)
    j = np.rint(P[:, 1] - MASTER["y0"]).astype(np.int64)
    ok = (i >= 0) & (i < MASTER["w"]) & (j >= 0) & (j < MASTER["h"])
    zl = np.full(len(P), np.nan)
    zl[ok] = M[j[ok], i[ok]]
    zl[zl <= -9990] = np.nan
    d = P[:, 2] - zl
    v = np.isfinite(d)
    if not v.any():
        return dict(n_pts=int(len(P)), mean_dz_vs_lidar=None, sd_dz=None,
                    pct_within_0p5=None)
    return dict(n_pts=int(len(P)),
                mean_dz_vs_lidar=round(float(np.mean(d[v])), 3),
                sd_dz=round(float(np.std(d[v])), 3),
                pct_within_0p5=round(float(np.mean(np.abs(d[v]) < 0.5)) * 100, 2))


def grid_stats(g, eg):
    """Residual of a raster surface against the lidar EG under it."""
    d = g - eg
    v = np.isfinite(d)
    if not v.any():
        return dict(n_pts=0, mean_dz_vs_lidar=None, sd_dz=None,
                    pct_within_0p5=None)
    return dict(n_pts=int(v.sum()),
                mean_dz_vs_lidar=round(float(np.mean(d[v])), 3),
                sd_dz=round(float(np.std(d[v])), 3),
                pct_within_0p5=round(float(np.mean(np.abs(d[v]) < 0.5)) * 100, 2))


def bbox_ring(x0, y0, w, h):
    return [[float(x0), float(y0)], [float(x0 + w), float(y0)],
            [float(x0 + w), float(y0 + h)], [float(x0), float(y0 + h)],
            [float(x0), float(y0)]]


def mask_ring(mask, x0, y0):
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return bbox_ring(x0 + xs.min(), y0 + ys.min(),
                     int(xs.max() - xs.min()), int(ys.max() - ys.min()))


# ---------------------------------------------------------------- emit

def emit_raster(sid, grid, x0, y0, out, imgs):
    fin = np.isfinite(grid)
    if not fin.any():
        print(f"  !! {sid}: empty raster, skipped")
        return None
    zmin = float(np.nanmin(grid))
    zmax = float(np.nanmax(grid))
    png = f"surf_{sid}.png"
    encode_terrain_rgb(grid, zmin).save(os.path.join(out, png), optimize=True)
    sz = os.path.getsize(os.path.join(out, png))
    imgs.append((f"surf_{sid}", png))
    print(f"  {sid:<16} {grid.shape[1]}x{grid.shape[0]}  z {zmin:.1f}-{zmax:.1f}"
          f"  {sz / 1e6:.2f} MB")
    return dict(payload=f"surf_{sid}", x0=float(x0), y0=float(y0),
                w=int(grid.shape[1]), h=int(grid.shape[0]), step=1.0,
                zmin=round(zmin, 3), zstep=ZSTEP,
                zmax=round(zmax, 3), png=png, png_bytes=sz)


# ---------------------------------------------------------------- excavation

def load_limits(cad_path, gis_path):
    """Returns (limits, cad_subareas, overrides).

    limits: [{name, lot, sheet, area_sf, depth_ft, source, ring}] — the
    authority for where excavation happens.  cad_subareas: the closed CAD
    polygons on the same layers, which are the special-treatment sub-areas and
    carry EA's depth attribution.  overrides: the depth call-outs the CAD
    builder found but could not attach to a region."""
    limits, subareas, overrides = [], [], []
    if os.path.exists(gis_path):
        with open(gis_path) as f:
            gis = json.load(f)
        for ft in gis["features"]:
            p = ft.get("properties", {})
            if p.get("layer") != "exc" or ft["geometry"]["type"] != "Polygon":
                continue
            ring = [[c[0], c[1]] for c in ft["geometry"]["coordinates"][0]]
            limits.append(dict(name=p.get("name"), lot=p.get("lot"),
                               sheet=p.get("sheet"),
                               area_sf=p.get("area_sf"),
                               depth_ft=p.get("depth_ft") or DEFAULT_DEPTH,
                               source="design_gis.json (geodatabase)",
                               ring=ring))
    if os.path.exists(cad_path):
        with open(cad_path) as f:
            cad = json.load(f)
        for ft in cad["features"]:
            if ft.get("group") != "exc" or not ft.get("closed"):
                continue
            ring = [[p[0], p[1]] for p in ft["coords"]]
            subareas.append(dict(name=ft.get("layer"), kind=ft.get("kind"),
                                 handle=ft.get("handle"),
                                 depth_ft=ft.get("depth_ft") or DEFAULT_DEPTH,
                                 source=f"cad_native.json {ft.get('layer')}",
                                 ring=ring))
        seen = set()
        for n in cad.get("sheet_notes", []):
            t = (n.get("text") or "").upper()
            if ('6"' in t and ("HAND" in t or "DRIP" in t or "NEAR STRUCTURE" in t
                               or "TOP 6" in t)):
                k = (n.get("sheet"), t[:60])
                if k in seen:
                    continue
                seen.add(k)
                overrides.append(dict(sheet=n.get("sheet"), depth_ft=0.5,
                                      text=n.get("text")))
    return limits, subareas, overrides


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", required=True)
    ap.add_argument("--tin", help=".npy of the recovered EA existing TIN")
    ap.add_argument("--borrow", help=".npy of the recovered borrow-area TIN")
    ap.add_argument("--cad", default="data/design/cad_native.json")
    ap.add_argument("--gis", default="data/design_gis.json")
    ap.add_argument("--out", default="data/design")
    ap.add_argument("--datajs", default="datajs")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    M = load_master(a.master)
    surfaces, imgs = [], []

    # ------------------------------------------------ eg_ea (recovered TIN)
    if a.tin and os.path.exists(a.tin):
        P = np.load(a.tin)
        x0 = math.floor(P[:, 0].min()) - PAD
        y0 = math.floor(P[:, 1].min()) - PAD
        w = int(math.ceil(P[:, 0].max()) + PAD - x0)
        h = int(math.ceil(P[:, 1].max()) + PAD - y0)
        g = tin_grid(P, x0, y0, w, h)
        eg = master_window(M, x0, y0, w, h)
        r = emit_raster("eg_ea", g, x0, y0, a.out, imgs)
        if r:
            surfaces.append(dict(
                id="eg_ea",
                label="EA existing ground (Civil 3D TIN)",
                kind="existing",
                method="recovered from the AECC_TIN_SURFACE object stream — "
                       "stride-4 float64 (x, y, z, id64) at bit=1 byte=4, all "
                       "64 (bit, byte) alignments swept; rasterised to 1 ft by "
                       "linear interpolation over the TIN's Delaunay "
                       "triangulation, triangles with an edge > 25 ft dropped",
                source_files=["1578546 - C-BASE.dwg",
                              "1578546 - 01.01 - SiteExcavAndCapping.dwg",
                              "1578546 - 02.01 - SiteRepository.dwg",
                              "1578546 - 02.02 - North_lobe.dwg"],
                confidence="high",
                raster=r,
                footprint=mask_ring(np.isfinite(g), x0, y0),
                stats=point_stats(P, M),
                volumes_vs_lidar_yd3=volumes_yd3(g, eg),
                notes="EA's own existing-ground TIN as bound into the design "
                      "drawings — recovered byte-for-byte, not reconstructed. "
                      "The same array is present identically in all four "
                      "drawings, which is itself a cross-check. Residual "
                      "against the Jan-2024 lidar master is the validation: "
                      "near zero is the expected result and is what confirms "
                      "the decode."))

    # ------------------------------------------------ borrow_eg (.mms store)
    if a.borrow and os.path.exists(a.borrow):
        P = np.load(a.borrow)
        x0 = math.floor(P[:, 0].min()) - PAD
        y0 = math.floor(P[:, 1].min()) - PAD
        w = int(math.ceil(P[:, 0].max()) + PAD - x0)
        h = int(math.ceil(P[:, 1].max()) + PAD - y0)
        g = tin_grid(P, x0, y0, w, h)
        eg = master_window(M, x0, y0, w, h)
        r = emit_raster("borrow_eg", g, x0, y0, a.out, imgs)
        if r:
            surfaces.append(dict(
                id="borrow_eg",
                label="Borrow area existing ground (.mms surface store)",
                kind="existing",
                method="recovered from the external surface store — the .mms is "
                       "a ZIP whose single member is a 272,737,606-byte DEFLATE "
                       "stream carrying the same stride-4 float64 records; "
                       "rasterised to 1 ft over its Delaunay triangulation",
                source_files=["1578546 - 02.03 - Borrow_Area_193e7.mms"],
                confidence="high",
                raster=r,
                footprint=mask_ring(np.isfinite(g), x0, y0),
                stats=point_stats(P, M),
                volumes_vs_lidar_yd3=volumes_yd3(g, eg),
                notes="EA's Borrow Area surface store — recovered, not "
                      "reconstructed. The wider residual than eg_ea (sd 0.34 vs "
                      "0.16 ft) is the borrow area's own vegetation and spoil "
                      "relief, not a decode error."))

    # ------------------------------------------------ residential surfaces
    limits, subareas, overrides = load_limits(a.cad, a.gis)
    print(f"  excavation: {len(limits)} limit polygons (geodatabase authority), "
          f"{len(subareas)} closed CAD sub-areas, "
          f"{len(overrides)} unapplied depth call-outs")
    if limits:
        allpts = np.array([p for L in limits + subareas for p in L["ring"]])
        x0 = math.floor(allpts[:, 0].min()) - PAD
        y0 = math.floor(allpts[:, 1].min()) - PAD
        w = int(math.ceil(allpts[:, 0].max()) + PAD - x0)
        h = int(math.ceil(allpts[:, 1].max()) + PAD - y0)
        eg = master_window(M, x0, y0, w, h)

        # Per-polygon depth, deepest-wins where limits and sub-areas overlap.
        # depth[] is the design excavation depth at every cell, 0 outside.
        depth = np.zeros((h, w))
        inside = np.zeros((h, w), dtype=bool)
        table = []
        for L in limits + subareas:
            m = ring_mask(L["ring"], x0, y0, w, h)
            if not m.any():
                continue
            d = float(L["depth_ft"])
            depth = np.where(m, np.maximum(depth, d), depth)
            inside |= m
            cells = int(m.sum())
            table.append(dict(name=L.get("name"), lot=L.get("lot"),
                              authority=L["source"],
                              area_sf_printed=L.get("area_sf"),
                              area_sf_raster=cells,
                              depth_ft=d,
                              cut_yd3_area_x_depth=round(cells * d / 27.0, 1)))
        # deepest-wins means overlaps are not double counted in the raster, but
        # the per-polygon area x depth column is per polygon and does overlap;
        # the honest comparator is the union.
        analytic_cut = float(np.sum(depth[inside])) / 27.0

        # Surface domain.  §5 says "EG elsewhere inside bbox"; the raster
        # instruction says "over its footprint bbox with nodata outside".  Both
        # are honoured by carrying EG out to a working buffer around the limits
        # and leaving the rest of the bbox nodata: any volume polygon, section
        # or isopach drawn around a lot still lands on a continuous surface,
        # while the ~97 % of this tall thin bbox that is nowhere near an
        # excavation stops costing payload for a copy of the site DEM the app
        # already ships as dem_abp / dem_site.  At 1 ft the two residential
        # rasters go from 4.5 MB to well under 1 MB with no analytical loss.
        from scipy import ndimage
        near = ndimage.distance_transform_edt(~inside) <= WORK_BUFFER_FT
        domain = (inside | near) & np.isfinite(eg)
        print(f"    domain: {int(inside.sum()):,} cells inside the limits, "
              f"{int(domain.sum()):,} within {WORK_BUFFER_FT} ft "
              f"({domain.sum() / domain.size * 100:.1f} % of the bbox)")

        # res_excbottom — EG - depth inside the limits, EG in the buffer
        bot = np.where(domain, np.where(inside, eg - depth, eg), np.nan)
        r = emit_raster("res_excbottom", bot, x0, y0, a.out, imgs)
        if r:
            vol = volumes_yd3(bot, eg)
            print(f"    res_excbottom cut {vol['cut']:,.0f} yd3   "
                  f"Sum(area x depth) over the union {analytic_cut:,.0f} yd3   "
                  f"delta {vol['cut'] - analytic_cut:+.1f}")
            surfaces.append(dict(
                id="res_excbottom",
                label="Residential excavation bottom",
                kind="derived",
                method="lidar existing ground minus depth_ft inside each "
                       "limit-of-excavation polygon (1.0 ft default from the "
                       "sheet note; deepest wins where polygons overlap), "
                       f"existing ground out to a {WORK_BUFFER_FT} ft working "
                       "buffer around the limits, nodata beyond",
                source_files=["data/design_gis.json (EA geodatabase, exc layer)",
                              "data/design/cad_native.json (C-SITE-EXC-* closed "
                              "sub-areas and sheet notes)",
                              "master_1ft.f32 (Jan-2024 lidar bare earth)"],
                confidence="medium",
                raster=r,
                footprint=mask_ring(inside, x0, y0),
                stats=grid_stats(bot, eg),
                volumes_vs_lidar_yd3=vol,
                notes='Depth-based design, faithful to EA\'s written intent — '
                      '"EXCAVATE WORK AREA TO ONE FOOT DEPTH UNLESS OTHERWISE '
                      'INDICATED". This is NOT an EA TIN; no proposed TIN for '
                      'the residential lots exists in the delivered files. '
                      f'Raster cut {vol["cut"]:,.0f} yd3 vs Sum(area x depth) '
                      f'over the polygon union {analytic_cut:,.0f} yd3 — the '
                      'two agree because the surface is a pure vertical offset; '
                      'the residual is 1-ft rasterisation of the polygon edges.',
                depth_polygons=table,
                depth_overrides_unapplied=overrides,
                analytic_cut_yd3=round(analytic_cut, 1)))

        # res_finish — finished grade equals existing grade
        fin = np.where(domain, eg, np.nan)
        r = emit_raster("res_finish", fin, x0, y0, a.out, imgs)
        if r:
            surfaces.append(dict(
                id="res_finish",
                label="Residential finished grade",
                kind="derived",
                method="equals the lidar existing ground: the excavated work "
                       "area is backfilled to grade and the unhatched area "
                       "inside the limits gets 12 in of clean fill, so the "
                       "design finished surface is existing grade everywhere; "
                       f"carried out to the same {WORK_BUFFER_FT} ft working "
                       "buffer as res_excbottom",
                source_files=["master_1ft.f32 (Jan-2024 lidar bare earth)",
                              "data/design/cad_native.json (sheet notes)"],
                confidence="medium",
                raster=r,
                footprint=mask_ring(inside, x0, y0),
                stats=grid_stats(fin, eg),
                volumes_vs_lidar_yd3=volumes_yd3(fin, eg),
                notes='Finished grade EQUALS existing grade by design, per EA\'s '
                      'notes: "PROVIDE 12in OF FILL IN ANY UNHATCHED AREA INSIDE '
                      'THE LIMITS OF EXCAVATION AND/ OR FILL" and "TRANSITION TO '
                      'EXISTING GRADE AT LIMITS OF FILL BOUNDARY". It is shipped '
                      'as its own surface so that "volume vs design" and the '
                      'isopach have an explicit finished-grade datum to point '
                      'at, and so the zero residual is visible rather than '
                      'assumed. Volumes against lidar are therefore zero by '
                      'construction.'))

    # ------------------------------------------------ the negative result
    not_recovered = [
        dict(id="repo_fg", label="Repository / East stockpile final grade",
             searched=["1578546 - 02.01 - SiteRepository.dwg"],
             why="All 64 (bit, byte) alignments were swept across the whole "
                 "183,607,588-byte undecoded blob and across every decoded "
                 "object's unknown_bits. The only stride-4 float64 runs outside "
                 "the 955,387-point existing TIN are two dense 3-D linework sets "
                 "(312 and 461 points) in the East Stockpile area, and both sit "
                 "ON existing ground — the z = 1441.0 cluster has lidar 1441.0 "
                 "under it. They are existing contours, not a proposed grade.",
             fallback_not_used="The spec's constrained-Delaunay fallback needs "
                 "3-D grading breaklines and daylight lines. The `grade` group "
                 "is 47 features totalling 145 vertices — mostly 2-point contour "
                 "stubs across a 40 ft strip of the East Stockpile — and the "
                 "`daylight` group carries a usable Z on 17 of 187 vertices. A "
                 "Delaunay over that would invent the entire pad, which is the "
                 "failure CLAUDE.md warns against.",
             remedy="Ask EA for a LandXML export or a proposed-grade raster of "
                    "the repository / stockpile surfaces — a one-line request "
                    "they can satisfy from Civil 3D."),
        dict(id="nlobe_fg", label="North lobe final grade",
             searched=["1578546 - 02.02 - North_lobe.dwg"],
             why="Same sweep, same result: the drawing carries the same "
                 "955,387-point existing TIN and no proposed surface.",
             fallback_not_used="The north lobe work is depth-based like the rest "
                 "of the residential remedy — the 31,105 SF 'Limit of excavation "
                 "— North Lobe' polygon is already carried by res_excbottom and "
                 "res_finish, so there is no distinct proposed grade to build.",
             remedy="Covered by res_excbottom / res_finish; ask EA for LandXML "
                    "if a separate north-lobe design surface is ever needed."),
    ]

    man = dict(
        schema=2,
        crs="EPSG:6418 NAD83(2011) CA State Plane zone 2, US survey feet",
        encoding=dict(kind="terrain-rgb-png",
                      formula="z = zmin + (R*256+G-1)*zstep",
                      nodata="R=G=0", row0="north"),
        note="EA design/existing surfaces for docs/V9_SPEC.md section 5. `kind` "
             "says what a surface IS: `existing` surfaces are EA's own TIN "
             "vertices recovered byte-for-byte from the native files; `derived` "
             "surfaces are built here from EA's polygons and EA's written design "
             "depth over the lidar bare earth, and are not EA TINs. No surface "
             "in this manifest is `proposed` — see not_recovered.",
        surfaces=surfaces,
        not_recovered=not_recovered)
    with open(os.path.join(a.out, "surfaces.json"), "w") as f:
        json.dump(man, f, indent=1)
    print(f"wrote {a.out}/surfaces.json ({len(surfaces)} surfaces, "
          f"{len(not_recovered)} not recovered)")

    # ------------------------------------------------ machine-generated tables
    # The narrative half of the Surfaces section lives in
    # data/design/cad_native_report.md (and build_cad_native.py now carries it
    # over rather than overwriting it).  Every NUMBER in that narrative also
    # comes out here on each run, so a rebuild that moves a figure is visible
    # by diffing this file rather than by trusting prose.
    rep = ["# Surfaces — generated tables",
           "",
           "Regenerated by `tools/build_cad_surfaces.py` on every run. The "
           "narrative, the method write-up and the negative result live in the "
           "`# Surfaces` section of `cad_native_report.md`.",
           "",
           "| id | kind | conf. | raster | origin | z range (ft) | PNG |",
           "|---|---|---|---|---|---|---|"]
    for s in surfaces:
        r = s["raster"]
        rep.append(f"| `{s['id']}` | {s['kind']} | {s['confidence']} | "
                   f"{r['w']} x {r['h']} | {r['x0']:.0f}, {r['y0']:.0f} | "
                   f"{r['zmin']:.1f}-{r['zmax']:.1f} | "
                   f"{r['png_bytes']/1e6:.2f} MB |")
    rep += ["", "| id | n | mean dz vs lidar | sd | % within 0.5 ft | cut yd3 "
            "| fill yd3 | net yd3 |", "|---|---|---|---|---|---|---|---|"]
    for s in surfaces:
        st, v = s["stats"], s["volumes_vs_lidar_yd3"]
        rep.append(f"| `{s['id']}` | {st['n_pts']:,} | "
                   f"{st['mean_dz_vs_lidar']:+.3f} | {st['sd_dz']:.3f} | "
                   f"{st['pct_within_0p5']:.2f} | {v['cut']:,.0f} | "
                   f"{v['fill']:,.0f} | {v['net']:+,.0f} |")
    exc = next((s for s in surfaces if s["id"] == "res_excbottom"), None)
    if exc:
        rc = exc["volumes_vs_lidar_yd3"]["cut"]
        ac = exc["analytic_cut_yd3"]
        rep += ["", "## Excavation-bottom sanity check", "",
                "| method | cut (yd3) |", "|---|---|",
                f"| raster, res_excbottom vs lidar | {rc:,.1f} |",
                f"| Sum(area x depth) over the polygon union | {ac:,.1f} |",
                f"| difference | {rc - ac:+,.1f} "
                f"({abs(rc - ac) / max(ac, 1) * 100:.2f} %) |",
                "", "## Excavation limits used, per lot", "",
                "| polygon | lot | authority | printed SF | raster SF | "
                "depth ft | area x depth yd3 |",
                "|---|---|---|---|---|---|---|"]
        tp = tr = tc = 0
        for q in exc["depth_polygons"]:
            if "geodatabase" not in q["authority"]:
                continue
            tp += q["area_sf_printed"] or 0
            tr += q["area_sf_raster"]
            tc += q["cut_yd3_area_x_depth"]
            rep.append(f"| {q['name']} | {q['lot'] if q['lot'] else '—'} | "
                       f"geodatabase | {q['area_sf_printed']:,} | "
                       f"{q['area_sf_raster']:,} | {q['depth_ft']} | "
                       f"{q['cut_yd3_area_x_depth']:,.1f} |")
        nsub = sum(1 for q in exc["depth_polygons"]
                   if "geodatabase" not in q["authority"])
        rep.append(f"| **total** | | | **{tp:,}** | **{tr:,}** | | "
                   f"**{tc:,.1f}** |")
        rep += ["", f"Plus {nsub} closed CAD sub-area polygons rasterised with "
                    "the same attribution (deepest depth wins on overlap); all "
                    "of them fall inside the limits above.", "",
                "## Depth overrides found but NOT applied", "",
                "| sheet | depth ft | call-out |", "|---|---|---|"]
        for o in exc["depth_overrides_unapplied"]:
            rep.append(f"| {o['sheet']} | {o['depth_ft']} | "
                       + o["text"].replace("\n", " ").replace("|", "/") + " |")
    rep += ["", "## Not recovered", "",
            "| id | label | why |", "|---|---|---|"]
    for n in not_recovered:
        rep.append(f"| `{n['id']}` | {n['label']} | {n['why']} |")
    with open(os.path.join(a.out, "surfaces_report.md"), "w") as f:
        f.write("\n".join(rep) + "\n")
    print(f"wrote {a.out}/surfaces_report.md")

    # ------------------------------------------------ datajs
    # ONE file (index.html's script list is fixed), several SBMM_DATA keys: the
    # manifest under `cad_surfaces`, and one data-URL per surface under the key
    # its raster.payload names, so a raster is reachable as SBMM_DATA[payload].
    parts = ['window.SBMM_DATA=window.SBMM_DATA||{};',
             'SBMM_DATA["cad_surfaces"]='
             + json.dumps(man, separators=(",", ":")) + ';']
    total = 0
    for key, png in imgs:
        with open(os.path.join(a.out, png), "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        total += len(b64)
        parts.append(f'SBMM_DATA[{json.dumps(key)}]='
                     f'"data:image/png;base64,{b64}";')
    js = "\n".join(parts) + "\n"
    path = os.path.join(a.datajs, "d_cad_surfaces.js")
    with open(path, "w") as f:
        f.write(js)
    print(f"wrote {path}  {len(js)/1e6:.2f} MB "
          f"({len(imgs)} rasters, {total/1e6:.2f} MB base64)")


if __name__ == "__main__":
    main()
