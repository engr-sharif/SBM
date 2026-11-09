#!/usr/bin/env python3
"""Build the site-wide tree table (data/trees_site.json -> datajs/d_trees_site.js).

    python3 tools/fetch_usgs_lidar.py WORK/usgs        # once, ~1 GB, public data
    python3 tools/build_trees.py WORK [--usgs WORK/usgs]

WHAT IT MAKES. One row per tree for the whole surveyed site: position, height,
crown radius and area, a form (broadleaf / conifer / brush), a colour sampled
from the orthophoto, and which survey the tree came from. The app draws its
tree layer from this table in 2D and 3D, in every build.

TWO SOURCES, AND WHICH ONE WINS.

  * INSIDE the mine window the trees come from the app's own canopy model
    (data/chm.png — the January-2024 site lidar, 1 ft). That model is the
    authority there, exactly as before.
  * OUTSIDE it the app has no canopy model: only one tile of the surveyor's
    point cloud was ever delivered. Those trees come from the public USGS 3DEP
    lidar (project CA_NorthCoastRanges_2_B23), fetched by
    tools/fetch_usgs_lidar.py. Its returns are turned into a 2-ft canopy model
    over the APP'S OWN GROUND (the DEM stack), so a tree stands on the terrain
    the app draws.

ONE DETECTOR. Both canopy models go through the "trees" kernel in
js/compute.js, run by tools/trees_detect.mjs. Nothing here re-implements it.

THE CHECK. The two surveys overlap across the whole mine window, so the USGS
trees are compared with the site trees there before any of them is trusted
outside it; the match rate and the height difference are printed and stored in
the payload's `validation`.

WHAT IS DROPPED. A canopy model cannot tell a roof from a crown, so any
detection whose top is on one of EA's building polygons is dropped (262 of the
4,179 inside the mine window). Buildings are instead given a height each
(`buildings`), for the 3D view to extrude.

Needs: numpy, scipy, Pillow, pyproj, laspy[lazrs]; node on the path.
"""
import argparse
import base64
import datetime
import glob
import json
import os
import subprocess
import sys

os.environ.setdefault("PROJ_NETWORK", "OFF")   # PROJ would otherwise try to download grids

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
FT_PER_M = 3937.0 / 1200.0            # US survey foot
PROJECT = "CA_NorthCoastRanges_2_B23"

MIN_H = 6.0                           # the detector's minimum, ft
BRUSH_H = 13.0                        # below this a detection is brush
CONIFER_MIN_H = 30.0


# ----------------------------------------------------------------------------
# the app's rasters
# ----------------------------------------------------------------------------
def load_terrain_rgb(name):
    """data/<name>.png + .json -> (meta, z south-up float32, NaN = no data)"""
    meta = json.load(open(os.path.join(REPO, "data", name + ".json")))
    im = np.asarray(Image.open(os.path.join(REPO, "data", name + ".png")))
    v = im[:, :, 0].astype(np.int32) * 256 + im[:, :, 1].astype(np.int32)
    z = (meta["zmin"] + (v - 1) * meta["step"]).astype(np.float32)
    z[v == 0] = np.nan
    return meta, z[::-1].copy()


def bilinear(meta, z, x, y):
    """the app's Dem.at(): nodes at x0 + i*cell; NaN if any corner is NaN"""
    fx = (x - meta["x0"]) / meta["cell"]
    fy = (y - meta["y0"]) / meta["cell"]
    i0 = np.floor(fx).astype(np.int64)
    j0 = np.floor(fy).astype(np.int64)
    ok = (i0 >= 0) & (j0 >= 0) & (i0 < meta["w"] - 1) & (j0 < meta["h"] - 1)
    out = np.full(x.shape, np.nan, dtype=np.float64)
    i, j = i0[ok], j0[ok]
    tx, ty = fx[ok] - i, fy[ok] - j
    out[ok] = (z[j, i] * (1 - tx) * (1 - ty) + z[j, i + 1] * tx * (1 - ty)
               + z[j + 1, i] * (1 - tx) * ty + z[j + 1, i + 1] * tx * ty)
    return out


class Ground:
    """SBMM.elev: the DEM stack, finest first"""

    def __init__(self):
        self.stack = [load_terrain_rgb(n) for n in ("dem_abp", "dem_res", "dem_site")]
        self.site = self.stack[2]

    def at(self, x, y):
        out = np.full(x.shape, np.nan)
        for meta, z in self.stack:
            need = np.isnan(out)
            if not need.any():
                break
            out[need] = bilinear(meta, z, x[need], y[need])
        return out


def sample_nearest(meta, z, x, y):
    i = np.rint((x - meta["x0"]) / meta["cell"]).astype(np.int64)
    j = np.rint((y - meta["y0"]) / meta["cell"]).astype(np.int64)
    ok = (i >= 0) & (j >= 0) & (i < meta["w"]) & (j < meta["h"])
    out = np.full(x.shape, np.nan)
    out[ok] = z[j[ok], i[ok]]
    return out


# ----------------------------------------------------------------------------
# USGS returns -> a 2-ft canopy model over the app's ground
# ----------------------------------------------------------------------------
def usgs_chm(usgs_dir, G, work):
    cache = os.path.join(work, "usgs_chm.npz")
    if os.path.exists(cache):
        d = np.load(cache)
        print("usgs canopy model: cached")
        return d["chm"], d["bld"], json.loads(str(d["info"]))
    import laspy
    from pyproj import Transformer
    from scipy import ndimage

    meta, zsite = G.site
    W, H, cell, X0, Y0 = meta["w"], meta["h"], meta["cell"], meta["x0"], meta["y0"]
    tr = Transformer.from_crs(3857, 6418, always_xy=True)
    top = np.full(W * H, -np.inf, dtype=np.float32)      # max (z - ground), any return
    bld = np.full(W * H, -np.inf, dtype=np.float32)      # the same, building class only
    cnt = np.zeros(W * H, dtype=np.uint16)
    gsum, gn = 0.0, 0
    gsamples = []
    classes = {}
    files = sorted(glob.glob(os.path.join(usgs_dir, "ept-data", "*.laz")))
    if not files:
        sys.exit("no USGS nodes in " + usgs_dir + " — run tools/fetch_usgs_lidar.py first")
    npts = 0
    for k, f in enumerate(files):
        las = laspy.read(f)
        if not len(las.points):
            continue
        x, y = tr.transform(np.asarray(las.x), np.asarray(las.y))
        zf = np.asarray(las.z) * FT_PER_M
        cls = np.asarray(las.classification)
        i = np.rint((x - X0) / cell).astype(np.int64)
        j = np.rint((y - Y0) / cell).astype(np.int64)
        ok = (i >= 0) & (j >= 0) & (i < W) & (j < H)
        if not ok.any():
            continue
        x, y, zf, cls, i, j = x[ok], y[ok], zf[ok], cls[ok], i[ok], j[ok]
        npts += len(x)
        for c, n in zip(*np.unique(cls, return_counts=True)):
            classes[int(c)] = classes.get(int(c), 0) + int(n)
        g = G.at(x, y)
        hag = (zf - g).astype(np.float32)
        good = np.isfinite(hag) & (cls != 7) & (cls != 18) & (hag > -10) & (hag < 220)
        idx = j * W + i
        np.maximum.at(top, idx[good], hag[good])
        np.add.at(cnt, idx[good], 1)
        b = good & (cls == 6)
        if b.any():
            np.maximum.at(bld, idx[b], hag[b])
        gr = good & (cls == 2)
        if gr.any():
            d = hag[gr]
            gsum += float(d.sum())
            gn += int(d.size)
            if len(gsamples) < 400:
                gsamples.append(np.random.default_rng(k).choice(d, size=min(2000, d.size), replace=False))
        if k % 200 == 0:
            print(f"  {k}/{len(files)} nodes, {npts / 1e6:.1f} M points on the site", flush=True)
    gs = np.concatenate(gsamples) if gsamples else np.zeros(1)
    dz = float(np.median(gs))
    info = dict(project=PROJECT, points=npts, classes=classes,
                ground_offset_ft=round(dz, 3), ground_offset_iqr_ft=[round(float(v), 3) for v in np.percentile(gs, [25, 75])],
                ground_points=gn, cell_ft=cell)
    print(f"  USGS ground minus the app's ground: median {dz:+.2f} ft "
          f"(IQR {info['ground_offset_iqr_ft']}) over {gn / 1e6:.1f} M ground returns")
    print("  classes:", classes)

    top = top.reshape(H, W)
    bld = bld.reshape(H, W)
    cnt = cnt.reshape(H, W)
    chm = np.where(np.isfinite(top), top - dz, np.nan).astype(np.float32)
    bldh = np.where(np.isfinite(bld), bld - dz, np.nan).astype(np.float32)
    # a cell with no return takes its neighbours' highest (a 2-ft cell can fall between scan lines)
    hole = ~np.isfinite(chm) & np.isfinite(zsite)
    filled = ndimage.maximum_filter(np.where(np.isfinite(chm), chm, -np.inf), size=3)
    chm[hole & np.isfinite(filled)] = filled[hole & np.isfinite(filled)]
    chm[~np.isfinite(zsite)] = np.nan                      # no ground, no canopy model
    v = np.where(np.isfinite(chm), chm, 0.0)
    v[v < 0] = 0
    # wires and stray returns: a cell standing far above what a 2x2 opening leaves is not a crown
    opened = ndimage.grey_opening(v, size=(2, 2))
    spike = (v - opened) > 12
    v[spike] = opened[spike]
    # pit-free close, then a light blur, the same treatment the site model had
    v = ndimage.grey_closing(v, size=(3, 3))
    v = ndimage.gaussian_filter(v, 0.6)
    v[v < 0.5] = 0
    chm = np.where(np.isfinite(chm), v, np.nan).astype(np.float32)
    info["cells_with_returns"] = int((cnt > 0).sum())
    info["returns_per_cell_median"] = float(np.median(cnt[cnt > 0]))
    np.savez_compressed(cache, chm=chm, bld=bldh, info=json.dumps(info))
    return chm, bldh, info


# ----------------------------------------------------------------------------
# geometry helpers
# ----------------------------------------------------------------------------
def pip_mask(poly, x, y):
    """even-odd point-in-polygon for many points; poly = [[x, y], ...]"""
    px = np.asarray([p[0] for p in poly])
    py = np.asarray([p[1] for p in poly])
    inside = np.zeros(x.shape, dtype=bool)
    n = len(px)
    j = n - 1
    for i in range(n):
        cond = ((py[i] > y) != (py[j] > y)) & \
               (x < (px[j] - px[i]) * (y - py[i]) / (py[j] - py[i] + 1e-30) + px[i])
        inside ^= cond
        j = i
    return inside


def buildings():
    d = json.load(open(os.path.join(REPO, "data", "design_gis.json")))
    out = []
    for k, f in enumerate(d["features"]):
        if f["properties"].get("layer") != "bldg" or f["geometry"]["type"] != "Polygon":
            continue
        out.append((k, f["geometry"]["coordinates"][0]))
    return out


def detect(mode, out, *args):
    subprocess.run(["node", os.path.join(HERE, "trees_detect.mjs"), mode, out, *[str(a) for a in args]], check=True)
    return json.load(open(out))


def ring_ratio(meta, z, x, y, r, h):
    """mean canopy height on a ring at half the crown radius, over the apex height.
       A cone gives ~0.5, a dome ~0.85: the shape of the crown, from the lidar."""
    acc = np.zeros(len(x))
    n = np.zeros(len(x))
    for a in np.linspace(0, 2 * np.pi, 12, endpoint=False):
        v = sample_nearest(meta, z, x + 0.5 * r * np.cos(a), y + 0.5 * r * np.sin(a))
        ok = np.isfinite(v)
        acc[ok] += v[ok]
        n[ok] += 1
    return np.where(n > 0, acc / np.maximum(n, 1) / np.maximum(h, 1e-6), 1.0)


def classify(h, r, q):
    """0 broadleaf, 1 conifer, 2 brush — from the crown's own shape"""
    slender = h / np.maximum(2 * r, 1e-6)
    form = np.zeros(len(h), dtype=np.uint8)
    form[h < BRUSH_H] = 2
    conifer = (h >= CONIFER_MIN_H) & (((q < 0.62) & (slender > 0.9)) | (slender > 1.7))
    form[conifer] = 1
    return form


def tints(x, y, r):
    """mean orthophoto colour over the middle of each crown"""
    b = json.load(open(os.path.join(REPO, "data", "ortho_site.json")))
    im = np.asarray(Image.open(os.path.join(REPO, "data", "ortho_site.jpg")).convert("RGB")).astype(np.float32)
    Hh, Ww = im.shape[:2]
    sx = Ww / (b["x1"] - b["x0"])
    sy = Hh / (b["y1"] - b["y0"])
    # summed-area table, so every crown is four reads whatever its size
    sat = np.zeros((Hh + 1, Ww + 1, 3), dtype=np.float64)
    sat[1:, 1:] = im.cumsum(0).cumsum(1)
    half = np.maximum(1.5, 0.5 * r)
    c0 = np.clip(np.floor((x - half - b["x0"]) * sx).astype(int), 0, Ww - 1)
    c1 = np.clip(np.ceil((x + half - b["x0"]) * sx).astype(int), 1, Ww)
    r0 = np.clip(np.floor((b["y1"] - (y + half)) * sy).astype(int), 0, Hh - 1)
    r1 = np.clip(np.ceil((b["y1"] - (y - half)) * sy).astype(int), 1, Hh)
    c1 = np.maximum(c1, c0 + 1)
    r1 = np.maximum(r1, r0 + 1)
    s = sat[r1, c1] - sat[r0, c1] - sat[r1, c0] + sat[r0, c0]
    n = ((r1 - r0) * (c1 - c0))[:, None]
    return np.clip(np.rint(s / n), 0, 255).astype(np.uint8)


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode("ascii")


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("--usgs", help="directory tools/fetch_usgs_lidar.py wrote")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    from scipy.spatial import cKDTree

    G = Ground()
    smeta, _ = G.site
    cmeta, chm_site = load_terrain_rgb("chm")
    win = (cmeta["x0"], cmeta["y0"], cmeta["x0"] + (cmeta["w"] - 1) * cmeta["cell"],
           cmeta["y0"] + (cmeta["h"] - 1) * cmeta["cell"])
    blds = buildings()

    # ---- inside the mine window: the app's own canopy model -----------------
    S = detect("site", os.path.join(a.work, "site_trees.json"))
    sx, sy = np.array(S["x"]), np.array(S["y"])
    sh, sr, sa = np.array(S["h"]), np.array(S["radius"]), np.array(S["area"])
    roof = np.zeros(len(sx), dtype=bool)
    for _, poly in blds:
        roof |= pip_mask(poly, sx, sy)
    print(f"site canopy model: {len(sx)} detections, {int(roof.sum())} on a building polygon -> dropped")
    keep = ~roof
    sx, sy, sh, sr, sa = sx[keep], sy[keep], sh[keep], sr[keep], sa[keep]
    sq = ring_ratio(cmeta, chm_site, sx, sy, sr, sh)

    # ---- outside it: the USGS lidar -----------------------------------------
    validation, info = None, None
    ux = uy = uh = ur = ua = uq = np.zeros(0)
    bld_usgs = chm_u = None
    if a.usgs:
        chm_u, bld_usgs, info = usgs_chm(a.usgs, G, a.work)
        if info["classes"].get(6, 0) > 0:
            # where the highest return is a classified building, it is not canopy
            roofcell = np.isfinite(bld_usgs) & (bld_usgs >= chm_u - 1.5)
            chm_u = np.where(roofcell, 0, chm_u).astype(np.float32)
        raw = os.path.join(a.work, "usgs_chm.f32")
        chm_u.astype("<f4").tofile(raw)
        U = detect("raw", os.path.join(a.work, "usgs_trees.json"), raw,
                   smeta["x0"], smeta["y0"], smeta["cell"], smeta["w"], smeta["h"])
        ax, ay = np.array(U["x"]), np.array(U["y"])
        ah, ar, aa = np.array(U["h"]), np.array(U["radius"]), np.array(U["area"])
        roof = np.zeros(len(ax), dtype=bool)
        for _, poly in blds:
            roof |= pip_mask(poly, ax, ay)
        ax, ay, ah, ar, aa = ax[~roof], ay[~roof], ah[~roof], ar[~roof], aa[~roof]
        inside = (ax >= win[0]) & (ax <= win[2]) & (ay >= win[1]) & (ay <= win[3])

        # the check: inside the mine window both surveys saw the same trees
        t = cKDTree(np.c_[sx, sy])
        d, j = t.query(np.c_[ax[inside], ay[inside]])
        tol = np.maximum(5.0, 0.6 * np.maximum(ar[inside], sr[j]))
        hit = d <= tol
        dh = ah[inside][hit] - sh[j][hit]
        tall_s = sh >= 20
        t2 = cKDTree(np.c_[ax[inside], ay[inside]])
        d2, j2 = t2.query(np.c_[sx[tall_s], sy[tall_s]])
        found_tall = d2 <= np.maximum(5.0, 0.6 * sr[tall_s])
        validation = dict(
            window="mine area (the site canopy model's extent)",
            site_trees=int(len(sx)), usgs_trees_in_window=int(inside.sum()),
            usgs_matched_to_site=int(hit.sum()),
            usgs_matched_pct=round(100 * float(hit.mean()), 1),
            site_trees_20ft_found_pct=round(100 * float(found_tall.mean()), 1),
            height_diff_ft=dict(median=round(float(np.median(dh)), 2),
                                p25=round(float(np.percentile(dh, 25)), 2),
                                p75=round(float(np.percentile(dh, 75)), 2)))
        print("validation in the mine window:", json.dumps(validation))

        # outside the window, and not a second copy of a site tree whose crown straddles the edge
        out = ~inside
        d3, j3 = t.query(np.c_[ax[out], ay[out]])
        dup = d3 <= np.maximum(ar[out], sr[j3])
        sel = np.where(out)[0][~dup]
        ux, uy, uh, ur, ua = ax[sel], ay[sel], ah[sel], ar[sel], aa[sel]
        uq = ring_ratio(smeta, chm_u, ux, uy, ur, uh)
        print(f"USGS: {len(ax)} detections, {int(inside.sum())} inside the window (not used), "
              f"{int(dup.sum())} straddling its edge, {len(ux)} kept outside it")

    # ---- one table -----------------------------------------------------------
    x = np.concatenate([sx, ux])
    y = np.concatenate([sy, uy])
    h = np.concatenate([sh, uh])
    r = np.concatenate([sr, ur])
    area = np.concatenate([sa, ua])
    q = np.concatenate([sq, uq])
    src = np.concatenate([np.zeros(len(sx), np.uint8), np.ones(len(ux), np.uint8)])
    form = classify(h, r, q)
    tint = tints(x, y, r)
    n = len(x)
    counts = dict(total=n, site_lidar=int((src == 0).sum()), usgs_lidar=int((src == 1).sum()),
                  broadleaf=int((form == 0).sum()), conifer=int((form == 1).sum()), brush=int((form == 2).sum()))
    print("trees:", counts)

    # ---- a height for every building (for the 3D view to extrude) ------------
    bout = []
    for k, poly in blds:
        px = np.array([p[0] for p in poly])
        py = np.array([p[1] for p in poly])
        gx, gy = np.meshgrid(np.arange(px.min(), px.max() + 1, 1.0), np.arange(py.min(), py.max() + 1, 1.0))
        gx, gy = gx.ravel(), gy.ravel()
        m = pip_mask(poly, gx, gy)
        if not m.any():
            continue
        hv, which = None, None
        v = sample_nearest(cmeta, chm_site, gx[m], gy[m])
        if np.isfinite(v).mean() > 0.8:
            hv, which = v[np.isfinite(v)], 0
        elif chm_u is not None:
            # outside the mine window the USGS canopy model is the only height there is
            vb = sample_nearest(smeta, chm_u, gx[m], gy[m])
            if np.isfinite(vb).mean() > 0.5:
                hv, which = vb[np.isfinite(vb)], 1
        if hv is None or not len(hv):
            continue
        bout.append(dict(feature=k, h_ft=round(float(np.percentile(hv, 75)), 1), src=which))
    print(f"buildings: a height for {len(bout)} of {len(blds)} polygons")

    X0, Y0 = smeta["x0"], smeta["y0"]
    payload = dict(
        built=datetime.date.today().isoformat(),
        crs="EPSG:6418 (NAD83(2011) CA SP Zone 2, ftUS); heights ft above the app's ground",
        sources=[
            dict(id="site2024", label="Site lidar, Jan 2024 (1-ft canopy model)",
                 note="data/chm.png — the mine-area window; the authority where it exists"),
            dict(id="usgs3dep", label="USGS 3DEP lidar (public)",
                 note=("project " + PROJECT + ", point cloud from the public bucket usgs-lidar-public; "
                       "a 2-ft canopy model over the app's own ground, used outside the mine-area window"))],
        detector="js/compute.js 'trees' kernel, minH 6 ft, minCrown 4 cells (tools/trees_detect.mjs)",
        forms=["broadleaf", "conifer", "brush"],
        form_rule=("brush under %g ft; conifer from %g ft where the crown is pointed "
                   "(ring/apex height under 0.62) or slender; broadleaf otherwise" % (BRUSH_H, CONIFER_MIN_H)),
        counts=counts, usgs=info, validation=validation, buildings=bout,
        n=n, x0=X0, y0=Y0, q_xy=0.5, q_h=0.1, q_r=0.25,
        cols=dict(
            x=b64(np.rint((x - X0) / 0.5).astype("<u2")),
            y=b64(np.rint((y - Y0) / 0.5).astype("<u2")),
            h=b64(np.rint(h / 0.1).astype("<u2")),
            r=b64(np.clip(np.rint(r / 0.25), 0, 255).astype("u1")),
            area=b64(np.clip(np.rint(area), 0, 65535).astype("<u2")),
            form=b64(form), src=b64(src), tint=b64(tint)))
    js = json.dumps(payload, separators=(",", ":"))
    with open(os.path.join(REPO, "data", "trees_site.json"), "w") as f:
        f.write(js)
    with open(os.path.join(REPO, "datajs", "d_trees_site.js"), "w") as f:
        f.write('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["trees_site"]=' + js + ";\n")
    print(f"wrote data/trees_site.json and datajs/d_trees_site.js ({len(js) / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
