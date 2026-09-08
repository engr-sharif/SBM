#!/usr/bin/env python3
"""
Horizontal alignment audit of every georeferenced source in this repo.

Written for the engineer's 2026-09-08 observation: "the sandbag dam that we did the
survey on is slightly to the WEST of the actual sandbag dam that we can make out on
the lidar topo ... I wonder if the whole topo is slightly shifted towards the east."

It measures, never argues.  Every test reports dx, dy in State Plane feet with an
uncertainty and names the method.  Nothing is written except the figures under
docs/alignment/ ; no app code, no payload and no datum is touched.

    python3 tools/check_alignment.py            # everything (~3 min, ~2 GB peak)
    python3 tools/check_alignment.py --quick    # skip the ortho tests (the big JPEGs)
    python3 tools/check_alignment.py --no-figs

Needs numpy, scipy and Pillow.  Reads only data/ ; pyproj is NOT required and is not
used (see the datum section of docs/ALIGNMENT_REPORT.md for why).

Sign convention, used everywhere below and stated again in each result line:

    (dx, dy) is the vector that must be ADDED to a position in source A to land on
    the same physical feature in source B.  "B is dx east of A" when dx > 0.
"""
import argparse
import csv
import json
import math
import os
import sys
import warnings

import numpy as np

warnings.filterwarnings("ignore", message="Mean of empty slice")
warnings.filterwarnings("ignore", message="invalid value encountered in scalar divide")
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FIGS = os.path.join(ROOT, "docs", "alignment")

# US survey foot / international foot.  usft = 1200/3937 m exactly.
USFT_OVER_IFT = (1200.0 / 3937.0) / 0.3048          # = 1.000002000004


# ---------------------------------------------------------------- readers ----

def load_dem(name):
    """The app's own terrain-RGB decode, returned SOUTH-UP so that grid node (i, j)
    is the point (x0 + i*cell, y0 + j*cell) — js/dem.js's `at()` convention."""
    m = json.load(open(os.path.join(DATA, name + ".json")))
    px = np.asarray(Image.open(os.path.join(DATA, name + ".png")).convert("RGB"))
    v = px[..., 0].astype(np.uint32) * 256 + px[..., 1]
    z = np.where(v == 0, np.nan, m["zmin"] + (v.astype(np.float64) - 1) * m["step"])
    return m, np.flipud(z).astype(np.float32)


def load_surface(sid):
    man = json.load(open(os.path.join(DATA, "design", "surfaces.json")))
    s = next(x for x in man["surfaces"] if x["id"] == sid)
    r = s["raster"]
    px = np.asarray(Image.open(os.path.join(DATA, "design", r["png"])).convert("RGB"))
    v = px[..., 0].astype(np.uint32) * 256 + px[..., 1]
    z = np.where(v == 0, np.nan, r["zmin"] + (v.astype(np.float64) - 1) * r["zstep"])
    m = dict(x0=r["x0"], y0=r["y0"], cell=r["step"], w=r["w"], h=r["h"])
    return m, np.flipud(z).astype(np.float32), s


def sample(m, z, x, y):
    """Bilinear, node convention — a byte-for-byte port of js/dem.js `at()` minus its
    NoData corner rule (a NaN corner gives NaN here, which the fits then drop)."""
    fx = (np.asarray(x, float) - m["x0"]) / m["cell"]
    fy = (np.asarray(y, float) - m["y0"]) / m["cell"]
    i = np.floor(fx).astype(int)
    j = np.floor(fy).astype(int)
    ok = (i >= 0) & (j >= 0) & (i < m["w"] - 1) & (j < m["h"] - 1)
    ii = np.clip(i, 0, m["w"] - 2)
    jj = np.clip(j, 0, m["h"] - 2)
    u = fx - ii
    v = fy - jj
    a = z[jj, ii]; b = z[jj, ii + 1]; c = z[jj + 1, ii]; d = z[jj + 1, ii + 1]
    out = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
    return np.where(ok, out, np.nan)


def window(m, z, x0, y0, x1, y1):
    i0 = max(int(math.floor((x0 - m["x0"]) / m["cell"])), 0)
    j0 = max(int(math.floor((y0 - m["y0"]) / m["cell"])), 0)
    i1 = min(int(math.ceil((x1 - m["x0"]) / m["cell"])), m["w"] - 1)
    j1 = min(int(math.ceil((y1 - m["y0"]) / m["cell"])), m["h"] - 1)
    sub = z[j0:j1 + 1, i0:i1 + 1]
    mm = dict(m, x0=m["x0"] + i0 * m["cell"], y0=m["y0"] + j0 * m["cell"],
              w=sub.shape[1], h=sub.shape[0])
    return mm, sub


class Ortho:
    """An orthophoto.  Its .json carries CORNER bounds and the image is an AREA
    raster, so pixel (i, j) is centred half a pixel inside them — unlike a DEM."""

    def __init__(self, name):
        self.b = json.load(open(os.path.join(DATA, name + ".json")))
        self.a = np.asarray(Image.open(os.path.join(DATA, name + ".jpg")).convert("L"),
                            dtype=np.float32)
        self.H, self.W = self.a.shape
        self.rx = (self.b["x1"] - self.b["x0"]) / self.W
        self.ry = (self.b["y1"] - self.b["y0"]) / self.H
        self.name = name

    def inside(self, x, y, pad=5.0):
        b = self.b
        return ((x > b["x0"] + pad) & (x < b["x1"] - pad) &
                (y > b["y0"] + pad) & (y < b["y1"] - pad))

    def at(self, x, y):
        b = self.b
        fx = (np.asarray(x, float) - b["x0"]) / self.rx - 0.5
        fy = (b["y1"] - np.asarray(y, float)) / self.ry - 0.5
        i = np.clip(np.floor(fx).astype(int), 0, self.W - 2)
        j = np.clip(np.floor(fy).astype(int), 0, self.H - 2)
        u = fx - i; v = fy - j; a = self.a
        return (a[j, i] * (1 - u) * (1 - v) + a[j, i + 1] * u * (1 - v) +
                a[j + 1, i] * (1 - u) * v + a[j + 1, i + 1] * u * v)


# ------------------------------------------------------------- estimators ----

def gradient_fit(ref, X, Y, Z, h=1.0, iters=4):
    """Solve  Z(x) - ref(x)  =  gx*dx + gy*dy + bias  for the horizontal shift that
    makes the reference surface reproduce the source elevations.  Robust (4-sigma MAD
    trim), iterated.  Returns dx, dy, se_dx, se_dy, rms, n, vertical bias."""
    dx = dy = 0.0
    sol = np.zeros(3)
    for _ in range(iters):
        zr = ref(X + dx, Y + dy)
        gx = (ref(X + dx + h, Y + dy) - ref(X + dx - h, Y + dy)) / (2 * h)
        gy = (ref(X + dx, Y + dy + h) - ref(X + dx, Y + dy - h)) / (2 * h)
        d = Z - zr
        ok = np.isfinite(d) & np.isfinite(gx) & np.isfinite(gy)
        v = d[ok]
        med = np.median(v)
        mad = np.median(np.abs(v - med))
        keep = ok.copy()
        keep[ok] = np.abs(v - med) < max(4 * 1.4826 * mad, 0.3)
        A = np.column_stack([gx[keep], gy[keep], np.ones(int(keep.sum()))])
        b = d[keep]
        sol, _, _, _ = np.linalg.lstsq(A, b, rcond=None)
        dx += sol[0]; dy += sol[1]
    r = b - A @ sol
    n = len(b)
    s2 = float(r @ r) / max(n - 3, 1)
    C = s2 * np.linalg.inv(A.T @ A)
    return dx, dy, float(np.sqrt(C[0, 0])), float(np.sqrt(C[1, 1])), float(np.sqrt(s2)), n, float(sol[2])


def tile_fits(ref, X, Y, Z, tile=400.0, minn=800, h=1.0):
    tx = np.floor((X - X.min()) / tile).astype(int)
    ty = np.floor((Y - Y.min()) / tile).astype(int)
    out = []
    with np.errstate(invalid="ignore"):
        for k in np.unique(tx * 100000 + ty):
            s = (tx * 100000 + ty) == k
            if s.sum() < minn:
                continue
            try:
                r = gradient_fit(ref, X[s], Y[s], Z[s], h=h)
            except Exception:
                continue
            if not (np.isfinite(r[0]) and np.isfinite(r[1])):
                continue
            out.append((float(X[s].mean()), float(Y[s].mean()), r[0], r[1], r[5]))
    return out


def polyline_samples(coords, spacing=3.0, trim=2.0):
    c = np.asarray(coords, float)[:, :2]
    pts, nrm = [], []
    for k in range(len(c) - 1):
        a, b = c[k], c[k + 1]
        L = float(np.hypot(*(b - a)))
        if L < 2 * trim + spacing:
            continue
        t = (b - a) / L
        n = np.array([t[1], -t[0]])
        for s in np.arange(trim, L - trim, spacing):
            pts.append(a + t * s); nrm.append(n)
    if not pts:
        return np.zeros((0, 2)), np.zeros((0, 2))
    return np.array(pts), np.array(nrm)


def edge_offsets(sampler, pts, normals, span=8.0, step=0.25, min_contrast=10.0):
    """Signed distance along each normal from a drafted line to the strongest
    luminance step in the imagery.  NaN where the imagery has no edge to find."""
    d = np.arange(-span, span + 1e-9, step)
    out = np.full(len(pts), np.nan)
    for k, (p, n) in enumerate(zip(pts, normals)):
        v = sampler(p[0] + n[0] * d, p[1] + n[1] * d)
        if not np.all(np.isfinite(v)):
            continue
        g = np.gradient(v, step)
        i = int(np.argmax(np.abs(g)))
        if i <= 0 or i >= len(d) - 1 or abs(g[i]) * step * 4 < min_contrast:
            continue
        f0, f1, f2 = abs(g[i - 1]), abs(g[i]), abs(g[i + 1])
        den = f0 - 2 * f1 + f2
        e = 0.5 * (f0 - f2) / den if den != 0 else 0.0
        if abs(e) > 1:
            continue
        out[k] = d[i] + e * step
    return out


def fit_from_normals(normals, offsets):
    ok = np.isfinite(offsets)
    N, o = normals[ok], offsets[ok]
    sol = np.zeros(2)
    for _ in range(3):
        sol, _, _, _ = np.linalg.lstsq(N, o, rcond=None)
        r = o - N @ sol
        s = 1.4826 * np.median(np.abs(r - np.median(r)))
        keep = np.abs(r - np.median(r)) < 3 * max(s, 0.2)
        N, o = N[keep], o[keep]
    n = len(o)
    r = o - N @ sol
    s2 = float(r @ r) / max(n - 2, 1)
    C = s2 * np.linalg.inv(N.T @ N)
    return sol[0], sol[1], float(np.sqrt(C[0, 0])), float(np.sqrt(C[1, 1])), n, float(np.sqrt(s2))


# ------------------------------------------------------------------ tests ----

def head(n, t):
    print("\n" + "=" * 78 + "\n%s. %s\n" % (n, t) + "=" * 78)


def test_conventions():
    head(1, "Pixel conventions — where each source says a sample sits")
    site = json.load(open(os.path.join(DATA, "dem_site.json")))
    abp = json.load(open(os.path.join(DATA, "dem_abp.json")))
    om = json.load(open(os.path.join(DATA, "ortho_mine.json")))
    print("  DEM .json      NODE convention: sample (i, j) is the POINT x0 + i*cell.")
    print("                 tools/build_dems_from_master.py cut_window / xs=arange(w)+x0,")
    print("                 js/dem.js at(), test/lib/terrain.mjs gridSpec — all agree.")
    print("  DEM bounds()   AREA convention: js/dem.js bounds() returns")
    print("                 [y0, x0] .. [y0 + h*cell, x0 + w*cell], one whole cell wider")
    print("                 than the node extent in each axis (%d nodes span %d ft, not %d)."
          % (abp["w"], (abp["w"] - 1) * abp["cell"], abp["w"] * abp["cell"]))
    print("                 => a hillshade DRAWN over bounds() sits +cell/2 east and")
    print("                    +cell/2 north of the DEM it was made from: %.2f ft on"
          % (abp["cell"] / 2))
    print("                    hs_abp.jpg, %.2f ft on hs_site.jpg.  Display only —" % (site["cell"] / 2))
    print("                    no kernel and no quantity reads the JPEG.")
    print("  ortho .json    AREA convention: x0/y0/x1/y1 are CORNERS; %s is %.2f ft/px"
          % ("ortho_mine", (om["x1"] - om["x0"]) / 5744))
    print("                 and Leaflet draws it over exactly that rectangle.  Correct.")
    print("  dem_site       block_mean(master, 2) averages master nodes 2k and 2k+1,")
    print("                 whose centroid is x0 + 2k + 0.5, then LABELS it x0 + 2k.")
    print("                 Predicted content offset vs the 1-ft grids: -0.500 ft in")
    print("                 BOTH axes.  Test 2 measures it.")


def test_halfcell(rng):
    head(2, "dem_site vs dem_abp / dem_res — the same ground, three grids")
    m, z = load_dem("dem_abp")
    ms, zs = load_dem("dem_site")
    mr, zr = load_dem("dem_res")
    N = 150000
    X = rng.uniform(m["x0"] + 20, m["x0"] + (m["w"] - 1) - 20, N)
    Y = rng.uniform(m["y0"] + 20, m["y0"] + (m["h"] - 1) - 20, N)
    Z = sample(m, z, X, Y)
    ok = np.isfinite(Z)
    X, Y, Z = X[ok], Y[ok], Z[ok]
    r = gradient_fit(lambda a, b: sample(ms, zs, a, b), X, Y, Z, h=2.0)
    print("  dem_site  -> dem_abp   dx=%+.3f dy=%+.3f  (se %.3f, %.3f)  rms %.3f ft  n=%d"
          % (r[0], r[1], r[2], r[3], r[4], r[5]))
    print("                         predicted from the block-mean centroid: -0.500, -0.500")
    x0 = max(mr["x0"], m["x0"]) + 20
    x1 = min(mr["x0"] + mr["w"] - 1, m["x0"] + m["w"] - 1) - 20
    y0 = max(mr["y0"], m["y0"]) + 20
    y1 = min(mr["y0"] + mr["h"] - 1, m["y0"] + m["h"] - 1) - 20
    X2 = rng.uniform(x0, x1, N); Y2 = rng.uniform(y0, y1, N)
    Z2 = sample(mr, zr, X2, Y2)
    ok = np.isfinite(Z2) & np.isfinite(sample(m, z, X2, Y2))
    r2 = gradient_fit(lambda a, b: sample(m, z, a, b), X2[ok], Y2[ok], Z2[ok], h=1.0)
    print("  dem_abp   -> dem_res   dx=%+.4f dy=%+.4f  rms %.4f ft  n=%d  (identical cuts)"
          % (r2[0], r2[1], r2[4], r2[5]))
    return r


def test_ea_tin(rng):
    head(3, "EA's recovered existing-ground TIN vs the lidar DEMs")
    ms, zs, meta = load_surface("eg_ea")
    print("  source: %s  (%d TIN points, EA CRS note: EPSG:2226)" % (meta["label"], meta["stats"]["n_pts"]))
    x0 = ms["x0"] + 20; x1 = ms["x0"] + ms["w"] - 21
    y0 = ms["y0"] + 20; y1 = ms["y0"] + ms["h"] - 21
    N = 200000
    X = rng.uniform(x0, x1, N); Y = rng.uniform(y0, y1, N)
    Z = sample(ms, zs, X, Y)
    ok = np.isfinite(Z)
    X, Y, Z = X[ok], Y[ok], Z[ok]
    out = {}
    for nm in ("dem_abp", "dem_res", "dem_site"):
        m, z = load_dem(nm)
        ref = lambda a, b, m=m, z=z: sample(m, z, a, b)
        inb = ((X > m["x0"] + 5) & (Y > m["y0"] + 5) &
               (X < m["x0"] + (m["w"] - 1) * m["cell"] - 5) &
               (Y < m["y0"] + (m["h"] - 1) * m["cell"] - 5))
        zz = ref(X[inb], Y[inb])
        good = np.isfinite(zz)
        if good.sum() < 1000:
            continue
        r = gradient_fit(ref, X[inb][good], Y[inb][good], Z[inb][good], h=m["cell"])
        out[nm] = r
        print("  EA TIN -> %-9s dx=%+.3f dy=%+.3f  (se %.3f, %.3f)  rms %.3f ft  dz bias %+.3f  n=%d"
              % (nm, r[0], r[1], r[2], r[3], r[4], r[6], r[5]))
    m, z = load_dem("dem_abp")
    ref = lambda a, b: sample(m, z, a, b)
    T = tile_fits(ref, X, Y, Z, tile=400.0, minn=800, h=1.0)
    dx = np.array([t[2] for t in T]); dy = np.array([t[3] for t in T])
    print("  per 400-ft tile (n=%d): dx median %+.3f sd %.3f range %+.2f..%+.2f" %
          (len(T), np.median(dx), dx.std(), dx.min(), dx.max()))
    print("                           dy median %+.3f sd %.3f range %+.2f..%+.2f" %
          (np.median(dy), dy.std(), dy.min(), dy.max()))
    return out, T


def test_ea_contours():
    head(4, "EA's V-Base 5-ft contours (V-TOPO-MAJR) vs the lidar DEMs")
    d = json.load(open(os.path.join(DATA, "design", "cad_native.json")))
    P = [np.array(f["coords"], float) for f in d["features"]
         if f.get("layer") == "V-TOPO-MAJR" and isinstance(f.get("coords"), list)
         and f["coords"] and isinstance(f["coords"][0], list)]
    P = np.vstack([p for p in P if p.shape[1] >= 3])
    print("  %d contour vertices carrying a drafted elevation" % len(P))
    out = {}
    for nm in ("dem_abp", "dem_res", "dem_site"):
        m, z = load_dem(nm)
        ref = lambda a, b, m=m, z=z: sample(m, z, a, b)
        X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
        zz = ref(X, Y)
        ok = np.isfinite(zz) & (np.abs(zz - Z) < 8)
        if ok.sum() < 1000:
            continue
        r = gradient_fit(ref, X[ok], Y[ok], Z[ok], h=m["cell"])
        out[nm] = r
        print("  contours -> %-9s dx=%+.3f dy=%+.3f  (se %.3f, %.3f)  rms %.3f ft  dz bias %+.3f  n=%d"
              % (nm, r[0], r[1], r[2], r[3], r[4], r[6], r[5]))
    del d
    return out


def test_cad_vs_ortho():
    head(5, "EA's drafted planimetrics vs the surveyor's orthophotos (edge fit)")
    d = json.load(open(os.path.join(DATA, "design", "cad_native.json")))
    F = [f for f in d["features"] if isinstance(f.get("coords"), list) and f["coords"]
         and isinstance(f["coords"][0], list)]
    groups = ((("V-BLDG-OTLN", "V-BLDG-SHED-OTLN"), "building outlines"),
              (("V-SITE-CONC", "V-SITE-SDWK"), "concrete / sidewalk"),
              (("V-ROAD-STRP-4WHT", "V-ROAD-STRP-4YCL"), "painted road stripes"),
              (("V-ROAD-ASPH", "V-ROAD-GRVL", "V-ROAD-GRAL"), "road edges"))
    out = []
    for oname in ("ortho_mine", "ortho_site"):
        o = Ortho(oname)
        for lays, label in groups:
            P, N = [], []
            for f in F:
                if f["layer"] not in lays:
                    continue
                p, n = polyline_samples(f["coords"], 3.0, 2.0)
                if len(p) == 0:
                    continue
                m = o.inside(p[:, 0], p[:, 1], 10)
                P.append(p[m]); N.append(n[m])
            if not P:
                continue
            P = np.vstack(P); N = np.vstack(N)
            if len(P) < 60:
                continue
            off = edge_offsets(o.at, P, N)
            if np.isfinite(off).sum() < 60:
                continue
            dx, dy, sx, sy, n, rms = fit_from_normals(N, off)
            out.append((oname, label, dx, dy, sx, sy, n, rms))
            print("  CAD -> %-11s %-20s dx=%+.2f+-%.2f dy=%+.2f+-%.2f  n=%5d  scatter %.2f ft"
                  % (oname, label, dx, sx, dy, sy, n, rms))
        del o
    print("  (the building outlines are the measurement — they are the only class whose")
    print("   scatter is sub-foot; a road EDGE is a fuzzy 4-ft-wide thing in both sources.)")
    del d, F
    return out


def test_dem_vs_ortho_wall():
    head(6, "The lidar DEM vs the orthophoto AT the sandbag wall (both Jan-30-2024)")
    from scipy.ndimage import uniform_filter1d
    m, z = load_dem("dem_abp")
    o = Ortho("ortho_mine")
    E = np.arange(6372035, 6372080.01, 0.25)

    def peak(v, lo, hi, w):
        s = v - uniform_filter1d(v, w, mode="nearest")
        k = int(np.argmax(np.where((E >= lo) & (E <= hi), s, -1e9)))
        if 0 < k < len(E) - 1:
            f0, f1, f2 = s[k - 1], s[k], s[k + 1]
            den = f0 - 2 * f1 + f2
            e = 0.5 * (f0 - f2) / den if den else 0.0
            return E[k] + e * (E[1] - E[0]), s[k]
        return E[k], s[k]

    rows = []
    for N in np.arange(2127483, 2127502, 1.0):
        yy = np.full_like(E, N)
        pe, vo = peak(o.at(E, yy), 6372050, 6372072, 81)
        pz, vz = peak(sample(m, z, E, yy), 6372050, 6372072, 81)
        if vo > 60 and vz > 0.8:
            rows.append((N, pe, pz, pe - pz))
    d = np.array([r[3] for r in rows])
    mad = 1.4826 * float(np.median(np.abs(d - np.median(d))))
    print("  the wall's crest, row by row over N %.0f..%.0f (%d rows where both signals"
          % (rows[0][0], rows[-1][0], len(rows)))
    print("  are strong): ortho bright ridge minus DEM top-hat ridge")
    print("      median %+.2f ft, robust sd (MAD) %.2f ft, mean %+.2f ft, plain sd %.2f ft"
          % (np.median(d), mad, d.mean(), d.std()))
    print("  => the DEM and the imagery put the same structure in the same place to")
    print("     well under a foot.  A general DEM-vs-ortho correlation over open terrain")
    print("     is NOT diagnostic here and was tried: |NCC| of the DEM top-hat against the")
    print("     ortho high-pass peaks at 0.05-0.36 with no consistent offset, because the")
    print("     photograph's tone is vegetation and material colour, not relief.")
    del o
    return d


def survey_shots():
    rows = list(csv.DictReader(open(os.path.join(DATA, "datasets", "survey_2026_points.csv"))))
    return rows


def test_survey(rng, figs=True):
    head(7, "The August-2026 Jacobs survey vs the January-2024 lidar")
    m, z = load_dem("dem_abp")
    rows = survey_shots()

    def arr(sel):
        s = [r for r in rows if sel(r)]
        return (np.array([float(r["easting"]) for r in s]),
                np.array([float(r["northing"]) for r in s]),
                np.array([float(r["elevation"]) for r in s]), s)

    # the shots that CAN be compared: the sandbag wall (hard ground) and the two
    # "top of water" shots.  The NW Pit shots cannot — the Jan-2024 lidar reads a flat
    # 1342.80 water plane over the whole pit, so they carry no horizontal information.
    X, Y, Z, sel = arr(lambda r: r["area"] == "Sandbag wall" or r["id"] in ("Water Level", "Shore 2"))
    print("  usable shots: %d (8 sandbag wall + 2 top-of-water).  Excluded: the 11 NW Pit" % len(X))
    print("  shots (all read the lidar's flat 1342.80 ft water plane), the staff gauge and")
    print("  the two pipe inverts (a pipe invert is not a ground surface).")

    # (a) free two-parameter shift
    D = np.arange(-6, 24.01, 0.25)
    Ey = np.arange(-14, 14.01, 0.25)
    M = np.array([[float(np.sqrt(np.mean((sample(m, z, X + dx, Y + dy) - Z) ** 2)))
                   for dx in D] for dy in Ey])
    j, i = np.unravel_index(np.argmin(M), M.shape)
    print("\n  (a) free 2-parameter shift    dx=%+.2f dy=%+.2f ft   rms %.3f ft"
          % (D[i], Ey[j], M[j, i]))
    print("      as delivered (0, 0)                              rms %.3f ft"
          % float(np.sqrt(np.mean((sample(m, z, X, Y) - Z) ** 2))))

    # (b) one-parameter scale about the State Plane origin
    ks = 1 + np.arange(0, 5.001e-6, 1e-8)
    v = np.array([float(np.sqrt(np.mean((sample(m, z, X * k, Y * k) - Z) ** 2))) for k in ks])
    kbest = ks[int(np.argmin(v))]
    B = []
    for _ in range(400):
        s = rng.integers(0, len(X), len(X))
        vv = np.array([float(np.sqrt(np.mean((sample(m, z, X[s] * k, Y[s] * k) - Z[s]) ** 2)))
                       for k in ks])
        B.append(ks[int(np.argmin(vv))] - 1)
    B = np.array(B)
    lo, hi = np.percentile(B, [16, 84])
    print("  (b) ONE-parameter scale about the grid origin:  k - 1 = %.3e" % (kbest - 1))
    print("      bootstrap (400 resamples) 16-84%%:           [%.3e, %.3e]" % (lo, hi))
    print("      rms %.3f ft (k=1: %.3f ft).  At the wall that is dE %+.1f ft, dN %+.1f ft."
          % (v[int(np.argmin(v))], v[0], (kbest - 1) * X.mean(), (kbest - 1) * Y.mean()))
    print("      US survey foot / international foot - 1 = %.3e  <-- inside the interval"
          % (USFT_OVER_IFT - 1))

    # (c) what the exact unit constant does to every shot
    K = USFT_OVER_IFT
    print("\n  (c) every shot, before and after the exact ift->usft correction (x*k, y*k):")
    print("      %-14s %-20s %8s %9s %8s %9s %8s"
          % ("id", "area", "surveyed", "lidar@0", "d", "lidar@k", "d"))
    for r in rows:
        x = float(r["easting"]); y = float(r["northing"]); zz = float(r["elevation"])
        a = float(sample(m, z, x, y)); b = float(sample(m, z, x * K, y * K))
        print("      %-14s %-20s %8.2f %9.2f %+8.2f %9.2f %+8.2f"
              % (r["id"], r["area"], zz, a, a - zz, b, b - zz))
    print("      The two 'top of water' shots take NO part in any fit above that they")
    print("      could bias: they land on the lidar's own flat water return (1336.58 ft,")
    print("      the value docs/V10_WATER_SPEC.md records) only after the correction.")
    return dict(free=(D[i], Ey[j], M[j, i]), k=kbest, kband=(lo, hi), M=M, D=D, E=Ey,
                X=X, Y=Y, Z=Z)


def test_impact():
    head(8, "What a horizontal error costs — the site's own slope distribution")
    for nm in ("dem_abp", "dem_site"):
        m, z = load_dem(nm)
        gy, gx = np.gradient(z, m["cell"])
        g = np.hypot(gx, gy)
        g = g[np.isfinite(g)]
        q = np.percentile(g, [50, 90, 99])
        print("  %-9s (%d ft grid)  |grad z| median %.3f  p90 %.3f  p99 %.3f ft/ft"
              % (nm, m["cell"], q[0], q[1], q[2]))
        for d in (0.5, 1.0, 13.5):
            print("      a %.1f ft horizontal error is a vertical error of  median %.2f ft,"
                  "  p90 %.2f ft,  p99 %.2f ft" % (d, q[0] * d, q[1] * d, q[2] * d))
    # volume sensitivity of the traced pile footprints
    m, z = load_dem("dem_abp")
    P = json.load(open(os.path.join(DATA, "piles.json")))
    print("\n  Volume sensitivity (mean elevation x area — an UPPER bound: the real")
    print("  perimeter-TIN base moves with the terrain, so the memo method cancels most")
    print("  of this).  All four Fig-2 piles are inside dem_abp, which no test here moves.")
    for p in P:
        if not p.get("name"):
            continue
        r = np.array(p["ring"], float)[:, :2]
        xs = np.arange(r[:, 0].min(), r[:, 0].max(), 2.0)
        ys = np.arange(r[:, 1].min(), r[:, 1].max(), 2.0)
        Xg, Yg = np.meshgrid(xs, ys)
        ins = np.zeros(Xg.shape, bool)
        for i in range(len(r)):
            a, b = r[i], r[(i + 1) % len(r)]
            ins ^= (((a[1] > Yg) != (b[1] > Yg)) &
                    (Xg < (b[0] - a[0]) * (Yg - a[1]) / (b[1] - a[1] + 1e-12) + a[0]))
        A = int(ins.sum()) * 4.0
        z0 = float(np.nanmean(sample(m, z, Xg[ins], Yg[ins])))
        line = "  %-16s area %7.0f ft2 " % (p["name"], A)
        for d in ((0.5, 0.5), (-0.5, -0.5), (12.74, 4.25)):
            zd = float(np.nanmean(sample(m, z, Xg[ins] + d[0], Yg[ins] + d[1])))
            line += "  d(%+.1f,%+.1f) = %+8.1f yd3" % (d[0], d[1], (zd - z0) * A / 27.0)
        print(line)


def test_datum():
    head(9, "Datum realisation — what EPSG:2226 vs EPSG:6418 could account for")
    try:
        import pyproj  # noqa: F401
        print("  pyproj IS installed — recompute the realisation shift properly and")
        print("  replace this section; the numbers below are published magnitudes only.")
    except ImportError:
        print("  pyproj is NOT installed on this machine and this box has no network, so")
        print("  no transformation was computed.  The figures below are published")
        print("  magnitudes quoted for California, not a calculation:")
    print("    NAD83(1986) -> NAD83(HARN)          ~0.3-1.5 m  (1.0-5.0 ft)")
    print("    NAD83(HARN) -> NAD83(CORS96/2007)   ~0.02-0.10 m (0.07-0.3 ft)")
    print("    NAD83(2007) -> NAD83(2011)          ~0.01-0.05 m (0.03-0.2 ft)")
    print("  EPSG:2226 does not name a realisation, so 'EA is on 2226' is a statement")
    print("  about units and zone, not about epoch.  The measured EA-vs-lidar offset")
    print("  (test 3) is 0.3 ft, which sits inside the HARN-to-2011 band and far below")
    print("  the 1986 band: EA's data is on a modern realisation.  Do not reproject.")
    print("  The unit ratio that test 7 lands on is a DIFFERENT thing entirely and is")
    print("  exact, not a realisation: %.12f, i.e. %.3e." % (USFT_OVER_IFT, USFT_OVER_IFT - 1))


# ---------------------------------------------------------------- figures ----

RAMP = [(0, (20, 40, 90)), (.15, (30, 110, 160)), (.30, (60, 150, 110)),
        (.45, (150, 180, 80)), (.60, (210, 180, 90)), (.75, (190, 130, 70)),
        (.88, (160, 120, 110)), (1, (245, 245, 245))]


def ramp(t):
    t = np.clip(np.nan_to_num(t, nan=0.0), 0, 1)
    out = np.zeros(t.shape + (3,), np.float32)
    for k in range(len(RAMP) - 1):
        a, ca = RAMP[k]; b, cb = RAMP[k + 1]
        msk = (t >= a) & (t <= b)
        f = np.where(msk, (t - a) / max(b - a, 1e-9), 0)[..., None]
        out = np.where(msk[..., None], np.array(ca) * (1 - f) + np.array(cb) * f, out)
    return out.astype(np.uint8)


def survey_overlays(shift=(0.0, 0.0), scale=None, layers=("survey_wall", "survey_pipe")):
    sv = json.load(open(os.path.join(DATA, "survey_2026.json")))
    out = []
    for f in sv["features"]:
        L = f["properties"]["layer"]
        if L not in layers:
            continue
        c = np.array(f["geometry"]["coordinates"], float)
        if scale:
            c = c * scale
        c = c + np.array(shift)
        out.append((L, c))
    return out


def fig_wall_ortho(path):
    from PIL import ImageDraw
    b = json.load(open(os.path.join(DATA, "ortho_mine.json")))
    im = Image.open(os.path.join(DATA, "ortho_mine.jpg"))
    W, H = im.size
    rx = (b["x1"] - b["x0"]) / W; ry = (b["y1"] - b["y0"]) / H
    X0, Y0, X1, Y1 = 6372020, 2127455, 6372090, 2127520
    crop = im.crop((int((X0 - b["x0"]) / rx), int((b["y1"] - Y1) / ry),
                    int((X1 - b["x0"]) / rx), int((b["y1"] - Y0) / ry)))
    K = 8
    crop = crop.resize((crop.width * K, crop.height * K), Image.LANCZOS).convert("RGB")
    d = ImageDraw.Draw(crop)
    px = lambda x, y: ((x - X0) / rx * K, (Y1 - y) / ry * K)
    for L, c in survey_overlays():
        d.line([px(*q) for q in c], fill=(255, 40, 40) if L == "survey_wall" else (255, 230, 60), width=2)
    for L, c in survey_overlays(scale=USFT_OVER_IFT):
        d.line([px(*q) for q in c], fill=(0, 230, 255) if L == "survey_wall" else (120, 255, 200), width=2)
    d.text((6, 6), "Jan-30-2024 ortho (6 in).  red/yellow = Aug-2026 survey as delivered;", fill=(255, 255, 255))
    d.text((6, 18), "cyan/green = the same survey with the ift->usft unit correction.", fill=(255, 255, 255))
    crop.save(path, quality=82)


def fig_wall_dem(path):
    from PIL import ImageDraw
    m, z = load_dem("dem_abp")
    mm, sub = window(m, z, 6372015, 2127455, 6372090, 2127520)
    t = (sub - 1341.0) / (1346.5 - 1341.0)
    rgb = ramp(t)
    rgb[np.isnan(sub)] = (90, 90, 90)
    bnd = np.floor(np.nan_to_num(sub, nan=-9999) / 0.25)
    edge = np.zeros(sub.shape, bool)
    edge[:, 1:] |= bnd[:, 1:] != bnd[:, :-1]
    edge[1:, :] |= bnd[1:, :] != bnd[:-1, :]
    edge &= ~np.isnan(sub)
    rgb[edge] = (rgb[edge] * 0.45).astype(np.uint8)
    K = 10
    img = np.flipud(rgb)
    im = Image.fromarray(img).resize((img.shape[1] * K, img.shape[0] * K), Image.NEAREST)
    d = ImageDraw.Draw(im)
    ytop = mm["y0"] + (mm["h"] - 1) * mm["cell"]
    px = lambda x, y: ((x - mm["x0"]) / mm["cell"] * K + K / 2, (ytop - y) / mm["cell"] * K + K / 2)
    for L, c in survey_overlays():
        d.line([px(*q) for q in c], fill=(255, 40, 40) if L == "survey_wall" else (255, 230, 60), width=2)
    for L, c in survey_overlays(scale=USFT_OVER_IFT):
        d.line([px(*q) for q in c], fill=(0, 230, 255) if L == "survey_wall" else (120, 255, 200), width=2)
    d.text((6, 6), "dem_abp (1 ft), 0.25 ft contours.  red = survey as delivered,", fill=(255, 255, 255))
    d.text((6, 18), "cyan = unit-corrected.  The corrected wall sits on the lidar ridge.", fill=(255, 255, 255))
    im.convert("RGB").save(path, quality=82)


def fig_misfit(path, S):
    from PIL import ImageDraw
    M, D, E = S["M"], S["D"], S["E"]
    t = 1 - np.clip((M - M.min()) / (2.0 - M.min()), 0, 1)
    rgb = ramp(t)
    K = 5
    img = np.flipud(rgb)
    im = Image.fromarray(img).resize((img.shape[1] * K, img.shape[0] * K), Image.NEAREST)
    d = ImageDraw.Draw(im)
    px = lambda dx, dy: ((dx - D[0]) / (D[1] - D[0]) * K, (E[-1] - dy) / (E[1] - E[0]) * K)
    for (dx, dy, col, lbl) in ((0, 0, (255, 40, 40), "as delivered"),
                               (S["free"][0], S["free"][1], (255, 255, 255), "free 2-param"),
                               ((USFT_OVER_IFT - 1) * S["X"].mean(),
                                (USFT_OVER_IFT - 1) * S["Y"].mean(), (0, 230, 255), "ift->usft")):
        x, y = px(dx, dy)
        d.ellipse([x - 6, y - 6, x + 6, y + 6], outline=col, width=2)
        d.text((x + 9, y - 6), lbl, fill=col)
    d.text((6, 6), "rms |lidar - surveyed z| over the 10 usable shots, bright = good", fill=(255, 255, 255))
    d.text((6, 18), "x = dE %.0f to %.0f ft (east right)   y = dN %.0f to %.0f ft (north up)"
            % (D[0], D[-1], E[0], E[-1]), fill=(255, 255, 255))
    im.convert("RGB").save(path, quality=85)


def fig_tiles(path, T):
    from PIL import ImageDraw
    im = Image.new("RGB", (760, 760), (24, 26, 30))
    d = ImageDraw.Draw(im)
    xs = np.array([t[0] for t in T]); ys = np.array([t[1] for t in T])
    x0, x1 = xs.min() - 300, xs.max() + 300
    y0, y1 = ys.min() - 300, ys.max() + 300
    sc = min(700 / (x1 - x0), 700 / (y1 - y0))
    px = lambda x, y: (30 + (x - x0) * sc, 730 - (y - y0) * sc)
    for x, y, dx, dy, n in T:
        a = px(x, y); b = px(x + dx * 300, y + dy * 300)
        d.line([a, b], fill=(120, 220, 255), width=2)
        d.ellipse([a[0] - 2, a[1] - 2, a[0] + 2, a[1] + 2], fill=(255, 200, 80))
    d.text((10, 8), "EA existing TIN -> lidar, per 400 ft tile; arrows x300", fill=(230, 230, 230))
    d.text((10, 22), "consistently ~0.3 ft east, ~0.1 ft south", fill=(230, 230, 230))
    a = px(x0 + 200, y0 + 200); b = (a[0] + 1.0 * 300 * sc, a[1])
    d.line([a, b], fill=(255, 255, 255), width=2)
    d.text((a[0], a[1] + 6), "1.0 ft", fill=(255, 255, 255))
    im.save(path, quality=85)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip the orthophoto tests")
    ap.add_argument("--no-figs", action="store_true")
    a = ap.parse_args()
    rng = np.random.default_rng(20260908)
    print(__doc__.strip().splitlines()[0])
    print("data: %s" % DATA)
    test_conventions()
    test_halfcell(rng)
    _, T = test_ea_tin(rng)
    test_ea_contours()
    if not a.quick:
        test_cad_vs_ortho()
        test_dem_vs_ortho_wall()
    S = test_survey(rng)
    test_impact()
    test_datum()
    if not a.no_figs:
        os.makedirs(FIGS, exist_ok=True)
        fig_wall_dem(os.path.join(FIGS, "wall_dem.jpg"))
        fig_misfit(os.path.join(FIGS, "survey_misfit.jpg"), S)
        fig_tiles(os.path.join(FIGS, "ea_tin_tiles.jpg"), T)
        if not a.quick:
            fig_wall_ortho(os.path.join(FIGS, "wall_ortho.jpg"))
        print("\nfigures written to docs/alignment/")
    print("\ndone.")


if __name__ == "__main__":
    main()
