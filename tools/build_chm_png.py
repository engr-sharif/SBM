#!/usr/bin/env python3
"""
Encode the lidar canopy-height model (CHM) into the app's terrain-RGB PNG payload.

Input: chm_1ft.f32 — float32 canopy height above bare earth, on the mine-area grid
    x0=6370069 y0=2127238 cell=1.0 ft, w=2872 h=3882, row j = y0 + j (south-up),
    NaN = nodata.  Built from the raw LAS point cloud (208.3M returns): per-cell
    maximum first-return elevation (the DSM) minus the bare-earth master surface.

Output (into repo data/):
    chm.png / chm.json   same terrain-RGB encoding js/dem.js already decodes:
                         v = R*256 + G, h = zmin + (v-1)*step, v == 0 is nodata,
                         B = 0, PNG row 0 is NORTH (the array is south-up).

CLEANUP (v2, on by default — pass --raw to reproduce the untouched v1 raster).
The raw grid is a per-cell max-return DSM minus ground, so it carries two artefacts
that every downstream consumer (stand polygonisation, tree detection, the 3D canopy
mesh) has to fight:

  1. despeckle      single-cell returns standing alone in open ground — a bird, a
                    powerline, a stray high return. Any cell > 0 whose eight
                    neighbours are ALL 0 (or nodata) is set to 0. Only genuinely
                    isolated cells qualify, so a real 1-ft sapling next to any other
                    vegetation survives.
  2. pit-free close grey-scale morphological closing (dilate then erode) with a 3-ft
                    disc. Fills within-crown pits — the cells where the laser found a
                    gap through the foliage and reported near-ground height in the
                    middle of a crown. This is the standard "pit-free CHM" step and
                    it is what makes local-maximum tree detection stop finding two
                    apexes on one tree.
  3. masked blur    a light 1.5-ft-sigma Gaussian applied ONLY where height > 2 ft,
                    with the weights themselves masked to that region (normalised
                    convolution). A plain blur would drag canopy height out over the
                    clearing edge and inflate every stand polygon; masking the
                    weights means a crown edge stays where the lidar put it.

Morphology and blur are deliberately numpy-only (no scipy) so this tool runs
anywhere numpy + Pillow do, including the field laptop.

Run from repo root:  python3 tools/build_chm_png.py [path/to/chm_1ft.f32] [--raw]
Then: python3 tools/build_data.py && python3 tools/build_dist.py
"""
import json, os, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# must match the app's 1-ft mine-area DEM (dem_abp) cell for cell
GRID = {"x0": 6370069.0, "y0": 2127238.0, "cell": 1.0, "w": 2872, "h": 3882}
ZMIN, STEP = 0.0, 0.05          # 0.05-ft height quantum, 0 - 3276 ft representable


def encode_png(a, path):
    """terrain-RGB PNG, row 0 = north (input array is south-up)."""
    a = np.flipud(a)
    good = ~np.isnan(a)
    q = np.rint((np.where(good, a, ZMIN) - ZMIN) / STEP).astype(np.int64) + 1
    q = np.clip(q, 1, 65535)
    v = np.zeros(a.shape, dtype=np.uint32)
    v[good] = q[good].astype(np.uint32)           # 0 stays nodata
    rgb = np.zeros(a.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = (v >> 8).astype(np.uint8)
    rgb[..., 1] = (v & 255).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(path, optimize=True)
    return os.path.getsize(path)


# ---------------------------------------------------------------- cleanup v2
def disc(r):
    """offsets (dj, di) inside a radius-r disc, r in cells"""
    rr = int(np.ceil(r))
    return [(dj, di) for dj in range(-rr, rr + 1) for di in range(-rr, rr + 1)
            if dj * dj + di * di <= r * r + 1e-9]


def shifted(a, dj, di, fill):
    """a translated by (dj, di), edges filled with `fill` — no wraparound"""
    out = np.full_like(a, fill)
    h, w = a.shape
    sj0, sj1 = max(0, -dj), min(h, h - dj)
    si0, si1 = max(0, -di), min(w, w - di)
    if sj0 >= sj1 or si0 >= si1:
        return out
    out[sj0 + dj:sj1 + dj, si0 + di:si1 + di] = a[sj0:sj1, si0:si1]
    return out


def grey_close(a, ok, r):
    """grey-scale close (dilate then erode) with a radius-r disc, nodata-aware.

    Dilation ignores nodata by treating it as -inf, erosion by treating it as +inf,
    so a nodata hole neither donates height nor eats into a real crown."""
    offs = disc(r)
    lo = np.where(ok, a, -np.inf)
    dil = lo.copy()
    for dj, di in offs:
        if dj or di:
            np.maximum(dil, shifted(lo, dj, di, -np.inf), out=dil)
    hi = np.where(np.isfinite(dil), dil, np.inf)
    ero = hi.copy()
    for dj, di in offs:
        if dj or di:
            np.minimum(ero, shifted(hi, dj, di, np.inf), out=ero)
    return np.where(ok & np.isfinite(ero), ero, a)


def gauss1d(sigma, trunc=3.0):
    r = int(np.ceil(trunc * sigma))
    x = np.arange(-r, r + 1, dtype=np.float64)
    k = np.exp(-0.5 * (x / sigma) ** 2)
    return k / k.sum()


def sep_blur(a, k):
    """separable convolution with 1-D kernel k, zero-padded (weights carry the edge)"""
    r = len(k) // 2
    out = np.zeros_like(a, dtype=np.float64)
    for t, kv in enumerate(k):
        if kv:
            out += kv * shifted(a, t - r, 0, 0.0)
    tmp = out
    out = np.zeros_like(a, dtype=np.float64)
    for t, kv in enumerate(k):
        if kv:
            out += kv * shifted(tmp, 0, t - r, 0.0)
    return out


def masked_blur(a, ok, sigma, thresh):
    """normalised-convolution Gaussian applied only where a > thresh.

    Both the signal and the weights are masked to the >thresh region, so the result
    is an average of canopy cells only — no clearing height bleeds inward, and no
    canopy height bleeds out over the edge. Cells at or below the threshold are
    returned untouched."""
    m = ok & (a > thresh)
    k = gauss1d(sigma)
    num = sep_blur(np.where(m, a, 0.0), k)
    den = sep_blur(m.astype(np.float64), k)
    sm = np.where(den > 1e-9, num / np.maximum(den, 1e-9), a)
    return np.where(m, sm.astype(a.dtype), a)


def clean_chm(a, cell=1.0, close_r_ft=3.0, sigma_ft=1.5, blur_above=2.0, log=print):
    """despeckle -> pit-free close -> masked blur. Returns the cleaned array."""
    ok = ~np.isnan(a)
    out = a.copy()

    # 1. despeckle — a positive cell with no positive neighbour is noise
    pos = ok & (out > 0)
    nb = np.zeros(out.shape, dtype=np.int16)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            if dj or di:
                nb += shifted(pos, dj, di, False).astype(np.int16)
    lone = pos & (nb == 0)
    out[lone] = 0.0
    log(f"  despeckle: {int(lone.sum()):,} isolated cells zeroed "
        f"({100 * lone.sum() / max(1, pos.sum()):.3f}% of positive cells)")

    # 2. pit-free closing on heights
    before = out.copy()
    out = grey_close(out, ok, close_r_ft / cell)
    d = out[ok] - before[ok]
    log(f"  pit-free close (r={close_r_ft:g} ft disc): {int((d > 0.01).sum()):,} cells raised, "
        f"mean rise {d[d > 0.01].mean() if (d > 0.01).any() else 0:.2f} ft, max {d.max():.2f} ft")

    # 3. mask-aware light Gaussian above the blur threshold
    before = out.copy()
    out = masked_blur(out, ok, sigma_ft / cell, blur_above)
    d = np.abs(out[ok] - before[ok])
    log(f"  masked blur (sigma={sigma_ft:g} ft, only h > {blur_above:g} ft): "
        f"mean |Δ| {d.mean():.3f} ft, max {d.max():.2f} ft")

    out[~ok] = np.nan
    return out


def stats(a, tag, log=print):
    ok = ~np.isnan(a)
    v = a[ok]
    log(f"  {tag:<9} coverage {100 * ok.mean():5.2f}%  p50 {np.percentile(v, 50):6.2f}  "
        f"p95 {np.percentile(v, 95):6.2f}  max {v.max():6.2f}  "
        f">2ft {100 * (v > 2).mean():5.2f}%  >6ft {100 * (v > 6).mean():5.2f}%")
    return dict(cov=100 * ok.mean(), p50=float(np.percentile(v, 50)),
                p95=float(np.percentile(v, 95)), mx=float(v.max()),
                c2=100 * float((v > 2).mean()), c6=100 * float((v > 6).mean()))


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    raw_only = "--raw" in sys.argv
    src = argv[0] if argv else "/home/claude/chm_1ft.f32"
    if not os.path.exists(src):
        sys.exit(f"CHM raster not found: {src}")
    w, h = GRID["w"], GRID["h"]
    a = np.fromfile(src, dtype="<f4")
    if a.size != w * h:
        sys.exit(f"CHM size {a.size} != {w}x{h} = {w*h}")
    a = a.reshape(h, w)

    print(f"chm {w}x{h} @ {GRID['cell']} ft   source: {src}")
    before = stats(a, "raw")

    if raw_only:
        print("  --raw: shipping the untouched raster (v1 reproduction)")
    else:
        a = clean_chm(a, cell=GRID["cell"])
        after = stats(a, "cleaned")
        print(f"  delta: p50 {after['p50']-before['p50']:+.2f} ft  "
              f"p95 {after['p95']-before['p95']:+.2f} ft  "
              f">6ft coverage {after['c6']-before['c6']:+.2f} pp")

    ok = ~np.isnan(a)
    n = encode_png(a, os.path.join(DATA, "chm.png"))
    meta = dict(GRID); meta["zmin"] = ZMIN; meta["step"] = STEP
    with open(os.path.join(DATA, "chm.json"), "w") as f:
        json.dump(meta, f)
    print(f"  data/chm.png  {n/1e6:.2f} MB")

    # sanity: decode the PNG back and compare against the source raster
    px = np.asarray(Image.open(os.path.join(DATA, "chm.png")).convert("RGB"))
    vv = px[..., 0].astype(np.uint32) * 256 + px[..., 1]
    hh = np.where(vv == 0, np.nan, ZMIN + (vv.astype(np.float64) - 1) * STEP)
    hh = np.flipud(hh)                            # back to south-up
    same_mask = (~np.isnan(hh)) == ok
    err = np.abs(hh[ok] - a[ok]).max()
    # half a quantum is the exact bound for round-to-nearest; the slack absorbs the
    # float32 -> float64 rounding on the way back, which can land a hair over it
    print(f"  roundtrip: nodata mask {'OK' if same_mask.all() else 'MISMATCH'}, "
          f"max abs error {err:.4f} ft (expect <= {STEP/2})")
    if not same_mask.all() or err > STEP / 2 + 1e-3:
        sys.exit("sanity check failed")
    print("CHM encoded — now run tools/build_data.py, then tools/build_dist.py")


if __name__ == "__main__":
    main()
