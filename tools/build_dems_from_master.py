#!/usr/bin/env python3
"""
Build the app's terrain rasters from the master 1-ft lidar-derived surface.

Input: the surveyor's LandXML bare-earth TIN (Jan-30-2024 flight, 14 tiles,
42.6M points) rasterized to a single 1-ft float32 grid:

    master_1ft.f32        w=9700 h=8900, x0=6368100 y0=2122800, cell=1.0 ft,
                          row j = y0 + j (south-up), NaN = nodata,
                          EPSG:6418 (CA State Plane Zone 2, US survey feet)
    master_1ft_meta.json  the header above (read if present, else defaults)

Outputs (into repo data/):
    dem_site.png/.json   2-ft site grid   — 2x2 block nanmean of the master
    dem_abp.png/.json    1-ft mine-area window (key kept as "dem_abp")
    dem_res.png/.json    1-ft residential-lots window (v9; see RES_WIN)
    hs_site.jpg          hillshade of the 2-ft site grid
    hs_abp.jpg           hillshade of the 1-ft mine-area window

Pass --only=res (or site/abp) to rebuild one output without touching the others.

DEM encoding is terrain-RGB: v = R*256 + G, z = zmin + (v-1)*step, v == 0 is
nodata, B = 0, and PNG row 0 is NORTH (the master array is south-up, so it is
flipped on write). js/dem.js decodes exactly this.

Rerun after a new survey delivery:
    python3 tools/build_dems_from_master.py [path/to/master_1ft.f32]
Then: python3 tools/build_data.py && python3 tools/build_dist.py
"""
import json, os, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# master grid header (overridden by <master>_meta.json when that file exists)
MASTER_DEFAULT = {"x0": 6368100.0, "y0": 2122800.0, "cell": 1.0, "w": 9700, "h": 8900}

ZMIN, STEP = 1325.0, 0.02          # terrain-RGB encoding, shared by both DEMs
SITE_BLOCK = 2                     # 1 ft -> 2 ft site grid
# 1-ft window over the mine area = the delivered point-cloud tile footprint
ABP_WIN = {"x0": 6370069.0, "y0": 2127238.0, "w": 2872, "h": 3882}
# 1-ft window over the EA residential lots = the residential design bbox + 60 ft
# working buffer.  Added in v9 because the lots south/west of ABP_WIN fell back to
# the 2-ft site grid, which manufactured phantom fill in the isopach and degraded
# every residential excavation volume (see CLAUDE.md, ruling F9 / D1).  It OVERLAPS
# ABP_WIN on purpose — SBMM.elev consults the DEMs finest-first with dem_abp ahead
# of dem_res, so the overlap costs nothing and the window stays a simple rectangle.
RES_WIN = {"x0": 6369890.0, "y0": 2126050.0, "w": 1550, "h": 4320}
AZ, ALT, JPEG_Q, NODATA_GRAY = 315.0, 45.0, 82, 205


def load_master(path):
    meta = dict(MASTER_DEFAULT)
    mp = os.path.splitext(path)[0] + "_meta.json"
    if os.path.exists(mp):
        with open(mp) as f:
            j = json.load(f)
        for k in ("x0", "y0", "cell", "w", "h"):
            if k in j:
                meta[k] = j[k]
    a = np.memmap(path, dtype="<f4", mode="r", shape=(int(meta["h"]), int(meta["w"])))
    return meta, a


def block_mean(a, k, chunk=1000):
    """k x k block nanmean; NaN only where every cell in the block is NaN.
    Chunked over rows so the whole master never has to be materialised."""
    h, w = a.shape
    oh, ow = h // k, w // k
    out = np.empty((oh, ow), dtype=np.float32)
    for r0 in range(0, oh, chunk):
        r1 = min(oh, r0 + chunk)
        blk = np.asarray(a[r0 * k:r1 * k, :ow * k], dtype=np.float32)
        good = ~np.isnan(blk)
        s = np.where(good, blk, 0.0).reshape(r1 - r0, k, ow, k).sum(axis=(1, 3))
        n = good.reshape(r1 - r0, k, ow, k).sum(axis=(1, 3))
        with np.errstate(invalid="ignore", divide="ignore"):
            out[r0:r1] = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    return out


def encode_dem_png(z, path):
    """terrain-RGB PNG, row 0 = north (input array is south-up)."""
    a = np.flipud(z)
    v = np.zeros(a.shape, dtype=np.uint32)
    good = ~np.isnan(a)
    q = np.rint((np.where(good, a, ZMIN) - ZMIN) / STEP).astype(np.int64) + 1
    q = np.clip(q, 1, 65535)
    v[good] = q[good].astype(np.uint32)          # 0 stays nodata
    rgb = np.zeros(a.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = (v >> 8).astype(np.uint8)
    rgb[..., 1] = (v & 255).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(path, optimize=True)
    return os.path.getsize(path)


def hillshade_jpg(z, cell, path):
    """Standard Horn-style hillshade, az 315 / alt 45, row 0 = north."""
    a = np.flipud(z).astype(np.float32)
    bad = np.isnan(a)
    if bad.any():                                 # fill so gradients stay finite
        a = np.where(bad, np.nanmean(a[~bad]) if (~bad).any() else 0.0, a)
    gy, gx = np.gradient(a, cell)                 # gy = d/drow; row increases southward
    dzdx, dzdy = gx, -gy
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(dzdy, -dzdx)
    zen = np.deg2rad(90.0 - ALT)
    azm = np.deg2rad(360.0 - AZ + 90.0)
    hs = (np.cos(zen) * np.cos(slope) +
          np.sin(zen) * np.sin(slope) * np.cos(azm - aspect))
    img = np.clip(hs * 255.0, 0, 255).astype(np.uint8)
    img[bad] = NODATA_GRAY
    Image.fromarray(np.dstack([img] * 3), "RGB").save(path, quality=JPEG_Q, optimize=True)
    return os.path.getsize(path)


def write_json(name, meta):
    p = os.path.join(DATA, name + ".json")
    with open(p, "w") as f:
        json.dump(meta, f)
    return p


def probe(z, meta, x, y):
    """bilinear read out of a south-up array, for the sanity checks"""
    fx, fy = (x - meta["x0"]) / meta["cell"], (y - meta["y0"]) / meta["cell"]
    i, j = int(np.floor(fx)), int(np.floor(fy))
    u, v = fx - i, fy - j
    a, b = z[j, i], z[j, i + 1]
    c, d = z[j + 1, i], z[j + 1, i + 1]
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v


def cut_window(master, mm, win, name):
    """Clip a 1-ft window out of the master, refusing to run off its edge."""
    i0 = int(round((win["x0"] - mm["x0"]) / mm["cell"]))
    j0 = int(round((win["y0"] - mm["y0"]) / mm["cell"]))
    i1, j1 = i0 + win["w"], j0 + win["h"]
    if i0 < 0 or j0 < 0 or i1 > mm["w"] or j1 > mm["h"]:
        sys.exit(f"{name} window falls outside the master raster "
                 f"(i {i0}..{i1} of {mm['w']}, j {j0}..{j1} of {mm['h']})")
    z = np.asarray(master[j0:j1, i0:i1], dtype=np.float32)
    meta = {"x0": win["x0"], "y0": win["y0"], "cell": float(mm["cell"]),
            "w": int(z.shape[1]), "h": int(z.shape[0]), "zmin": ZMIN, "step": STEP}
    return z, meta


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--only=")), None)
    want = (lambda k: only is None or only == k)
    src = args[0] if args else "/home/claude/master_1ft.f32"
    if not os.path.exists(src):
        sys.exit(f"master raster not found: {src}")
    mm, master = load_master(src)
    print(f"master {mm['w']}x{mm['h']} @ {mm['cell']} ft, origin ({mm['x0']}, {mm['y0']})  {src}")

    # ---- b'. 1-ft residential-lots window (v9) ----------------------------
    if want("res"):
        zr, res = cut_window(master, mm, RES_WIN, "dem_res")
        n_res = encode_dem_png(zr, os.path.join(DATA, "dem_res.png"))
        write_json("dem_res", res)
        print(f"  dem_res.png   {res['w']}x{res['h']} @ {res['cell']} ft   {n_res/1e6:.2f} MB")
        px = np.asarray(Image.open(os.path.join(DATA, "dem_res.png")).convert("RGB"))
        v = px[..., 0].astype(np.uint32) * 256 + px[..., 1]
        zz = np.flipud(np.where(v == 0, np.nan, ZMIN + (v.astype(np.float64) - 1) * STEP))
        d = np.abs(zz - zr)
        d = d[~np.isnan(d)]
        print(f"  round-trip max |err| {d.max():.4f} ft over {d.size} cells "
              f"(nodata {100*(1 - d.size/zr.size):.1f} %)")
        if d.max() > STEP:
            sys.exit("dem_res round-trip exceeded one quantisation step")
    if only == "res":
        print("dem_res rebuilt — now run tools/build_data.py, then tools/build_dist.py")
        return

    # ---- a. 2-ft site DEM -------------------------------------------------
    zs = block_mean(master, SITE_BLOCK)
    site = {"x0": float(mm["x0"]), "y0": float(mm["y0"]),
            "cell": float(mm["cell"]) * SITE_BLOCK,
            "w": int(zs.shape[1]), "h": int(zs.shape[0]), "zmin": ZMIN, "step": STEP}
    n_site = encode_dem_png(zs, os.path.join(DATA, "dem_site.png"))
    write_json("dem_site", site)
    print(f"  dem_site.png  {site['w']}x{site['h']} @ {site['cell']} ft   {n_site/1e6:.2f} MB")

    # ---- b. 1-ft mine-area window ----------------------------------------
    i0 = int(round((ABP_WIN["x0"] - mm["x0"]) / mm["cell"]))
    j0 = int(round((ABP_WIN["y0"] - mm["y0"]) / mm["cell"]))
    za = np.asarray(master[j0:j0 + ABP_WIN["h"], i0:i0 + ABP_WIN["w"]], dtype=np.float32)
    abp = {"x0": ABP_WIN["x0"], "y0": ABP_WIN["y0"], "cell": float(mm["cell"]),
           "w": int(za.shape[1]), "h": int(za.shape[0]), "zmin": ZMIN, "step": STEP}
    n_abp = encode_dem_png(za, os.path.join(DATA, "dem_abp.png"))
    write_json("dem_abp", abp)
    print(f"  dem_abp.png   {abp['w']}x{abp['h']} @ {abp['cell']} ft   {n_abp/1e6:.2f} MB")

    # ---- c/d. hillshades --------------------------------------------------
    n_hss = hillshade_jpg(zs, site["cell"], os.path.join(DATA, "hs_site.jpg"))
    print(f"  hs_site.jpg   {n_hss/1e6:.2f} MB")
    n_hsa = hillshade_jpg(za, abp["cell"], os.path.join(DATA, "hs_abp.jpg"))
    print(f"  hs_abp.jpg    {n_hsa/1e6:.2f} MB")

    stale = os.path.join(DATA, "hs_abp.png")      # superseded by the JPEG
    if os.path.exists(stale):
        os.remove(stale)
        print("  removed stale data/hs_abp.png")

    # ---- sanity: decode the encoded PNGs back and probe -------------------
    for fn, meta, pts in (("dem_abp.png", abp, [(6371600, 2128900, 1387.6, 0.5)]),
                          ("dem_site.png", site, [(6374000, 2126000, 1689.8, 1.0)])):
        px = np.asarray(Image.open(os.path.join(DATA, fn)).convert("RGB"))
        v = px[..., 0].astype(np.uint32) * 256 + px[..., 1]
        zz = np.where(v == 0, np.nan, ZMIN + (v.astype(np.float64) - 1) * STEP)
        zz = np.flipud(zz)                        # back to south-up
        for x, y, want, tol in pts:
            got = probe(zz, meta, x, y)
            ok = abs(got - want) <= tol
            print(f"  probe {fn} ({x}, {y}) = {got:.2f} ft  (expect {want}±{tol})  {'OK' if ok else 'MISMATCH'}")
            if not ok:
                sys.exit("sanity probe failed")
    print("rasters rebuilt — now run tools/build_data.py, then tools/build_dist.py")


if __name__ == "__main__":
    main()
