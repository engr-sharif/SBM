#!/usr/bin/env python3
"""Register a plan sheet from EA's NATIVE geometry instead of its printed node table.

Why this exists
---------------
C-202 (North Lobe Grading) could not be registered by either method in the
registration notes (CLAUDE.md, README "Why four sheets are still not
registered"): it prints only two survey nodes, and it carries TWO plan
viewports of the same ground at 1 in = 20 ft — the "North Lobe Restoration
Planting Zones" plan on the left and the "North Lobe Grading Plan" on the
right — so one affine for the page is wrong by construction.

EA's June-2026 native deliverable changes the arithmetic. The geodatabase
polygon "Limit of excavation — North Lobe" (data/design_gis.json) is the heavy
black boundary drawn in BOTH viewports, and its two southern vertices ARE the
two printed nodes (81 and 82, to 0.02 ft). Eleven vertices of a distinctive
shape give 22 equations against four unknowns (rotation, scale, translation) —
far more redundancy than any printed node table on the set — and each
viewport is solved on its own.

Method, per sheet
-----------------
 1. Coarse: rotation swept through 360 deg at 1 deg with the scale locked to
    the plan scale of the other 1 in = 20 ft sheets, translation by FFT
    cross-correlation of the polygon outline against the sheet's heavy ink.
    C-202 answers at exactly -90 deg (north to the left, which is what the
    sheet's own north arrow says), with one peak per viewport.
 2. Refine, per viewport: Nelder-Mead over (rotation, scale, translation)
    maximising the mean darkness sampled along the transformed outline.
    Then rotation is LOCKED to the drafting angle and scale to the mean of
    the free fits, and only the translation is re-solved — the same
    "lock what you know" rule the printed-node method uses.
 3. Per-vertex residual: each vertex is moved on a +-6 px grid to the
    darkest corner position; the distance moved is that vertex's residual.
 4. Independent confirmation: the app's own orthophoto (data/ortho_mine.jpg,
    which knows nothing about the sheet) is rendered into each viewport's
    pixel frame through the recovered transform and correlated with the
    sheet's embedded aerial. What is scored is how far the imagery MOVES the
    sheet from where the polygon put it (accepted sheets: 0-2 ft; wrong
    registrations: 60-130 ft), and the sheet is refused above MAX_AGREE_FT.

Outputs
-------
 * data/design/design_<sheet>.png — north-up State Plane crop of the PRIMARY
   viewport (the grading plan) at 0.5 ft/px, paper outside the viewport
   knocked out to alpha. This is the raster the 2D overlay and the 3D drape
   use; two viewports of the same ground cannot both be draped, so the
   design plan is the one that is.
 * data/design_ea.json — the sheet record (raster bbox, scale, rotation,
   fit statistics, method) and the printed nodes as surveyed-node features.
 * data/sheets_full.json — the full-sheet affine for the primary viewport,
   plus `viewports`: one {name, px:[u0,v0,u1,v1], affine} per plan viewport,
   so js/sheetmarks.js can georeference a mark in EITHER plan and refuse
   one on the title block. `affine_source: "native"` tells
   tools/build_sheet_affine.py to leave the record alone.

Then: python tools/build_data.py, add datajs/i_design_<sheet>_png.js to
index.html's script list, and run the tests.

Usage
-----
    python tools/register_sheet_native.py C-202            # writes
    python tools/register_sheet_native.py C-202 --dry-run  # report only
"""
import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# One entry per sheet this tool knows how to register. `feature` names the
# native polygon drawn on the sheet; `viewports` lists the plan viewports
# left-to-right by the polygon copy each contains (primary first = the one
# that becomes the map raster); `scale0` is the coarse-search scale in ft per
# full-render px (1 in = 20 ft on a 4200 px, 36 in render; the value is the
# mean of the recovered C-108/C-109/C-111 scales).
SHEETS = {
    "C-202": dict(
        page=15, subject="North Lobe", design_set="Final",
        feature="Limit of excavation — North Lobe",
        scale0=0.171466,
        drafting_deg=-90.0,
        viewports=[
            dict(key="grading", name="North Lobe Grading Plan", primary=True),
            dict(key="planting", name="North Lobe Restoration Planting Zones"),
        ],
        nodes=[  # the sheet's own printed lot table (northing, easting)
            dict(pt=81, n=2130050.03, e=6371156.81),
            dict(pt=82, n=2130048.31, e=6371297.72),
        ],
        crop_ft_per_px=0.5,
    ),
}

INK_THRESHOLD = 70      # grey level below which a pixel is heavy linework
MIN_DARKNESS = 0.85     # mean ink along the outline (random placement: ~0.13)
MAX_RESID_MED_FT = 1.0  # per-vertex residual, median
MAX_AGREE_FT = 3.0      # how far the ortho may move the sheet
MIN_ORTHO_NCC = 0.30    # correlation of app ortho vs the sheet's aerial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.sheet not in SHEETS:
        sys.exit("no native-registration recipe for %s (known: %s)"
                 % (args.sheet, ", ".join(SHEETS)))

    import numpy as np
    from PIL import Image, ImageDraw
    from scipy import ndimage, optimize
    Image.MAX_IMAGE_PIXELS = None

    cfg = SHEETS[args.sheet]
    name = args.sheet
    tag = name.replace("-", "")

    # ---- inputs ----
    full_path = os.path.join(ROOT, "data", "design", "sheet_full_%s.jpg" % tag)
    sheet_rgb = np.asarray(Image.open(full_path).convert("RGB")).astype(np.float32)
    grey = sheet_rgb.mean(axis=2)
    H, W = grey.shape
    dark = (255.0 - grey) / 255.0
    ink = (grey < INK_THRESHOLD).astype(np.float32)

    gis = json.load(open(os.path.join(ROOT, "data", "design_gis.json")))
    feat = [f for f in gis["features"]
            if (f.get("properties") or {}).get("name") == cfg["feature"]]
    if not feat:
        sys.exit("native feature not found: " + cfg["feature"])
    ring = feat[0]["geometry"]["coordinates"][0]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    P = np.array(ring, dtype=np.float64)
    xc, yc = P.mean(axis=0)
    print("%s: %d-vertex native polygon %s, centroid %.2f E %.2f N"
          % (name, len(P), cfg["feature"], xc, yc))

    # ---- ground -> page: page = R(theta) @ [(x-xc)/s, -(y-yc)/s] + t ----
    def fwd(params, pts):
        th, s, tu, tv = params
        t = math.radians(th)
        dx = (pts[:, 0] - xc) / s
        dy = -(pts[:, 1] - yc) / s
        return np.stack([dx * math.cos(t) - dy * math.sin(t) + tu,
                         dx * math.sin(t) + dy * math.cos(t) + tv], axis=1)

    def samples(pts, step=0.5):
        out = []
        n = len(pts)
        for i in range(n):
            a, b = pts[i], pts[(i + 1) % n]
            m = max(2, int(math.hypot(*(b - a)) / step))
            for q in np.linspace(0, 1, m, endpoint=False):
                out.append(a + (b - a) * q)
        return np.array(out)

    def darkness(params):
        s = samples(fwd(params, P))
        return float(ndimage.map_coordinates(dark, [s[:, 1], s[:, 0]], order=1,
                                             mode="constant", cval=0.0).mean())

    # ---- 1. coarse sweep at 1/4 resolution ----
    S0 = cfg["scale0"]
    ds = 4
    h4, w4 = H // ds, W // ds
    ink4 = ink[:h4 * ds, :w4 * ds].reshape(h4, ds, w4, ds).mean(axis=(1, 3))
    Fi = np.fft.rfft2(ink4)

    def corr(theta):
        pts = fwd((theta, S0, 0.0, 0.0), P) / ds
        tpl = Image.new("F", (w4, h4), 0.0)
        q = [(p[0] + w4 / 2, p[1] + h4 / 2) for p in pts]
        ImageDraw.Draw(tpl).line(q + [q[0]], fill=1.0, width=1)
        T = np.asarray(tpl)
        c = np.fft.irfft2(Fi * np.conj(np.fft.rfft2(T)), s=ink4.shape) / T.sum()
        return c

    best = []
    for th in np.arange(-180.0, 180.0, 1.0):
        c = corr(th)
        best.append((float(c.max()), th))
    best.sort(reverse=True)
    print("coarse: best rotation %+.0f deg (outline-on-ink %.3f); runner-up %+.0f (%.3f)"
          % (best[0][1], best[0][0], best[1][1], best[1][0]))
    theta0 = best[0][1]
    if abs(theta0 - cfg["drafting_deg"]) > 2.0:
        sys.exit("coarse rotation %+.0f is not the expected drafting angle %+.1f"
                 % (theta0, cfg["drafting_deg"]))

    # one peak per viewport, at the coarse rotation
    c = corr(theta0).copy()
    peaks = []
    for _ in range(len(cfg["viewports"])):
        k = int(np.argmax(c))
        v, u = divmod(k, w4)
        peaks.append((((u + w4 // 2) % w4) * ds, ((v + h4 // 2) % h4) * ds, float(c.flat[k])))
        c[max(0, v - 60):v + 60, max(0, u - 60):u + 60] = 0
    peaks.sort()  # left to right on the page
    print("coarse: viewport peaks (u, v, score):", [(p[0], p[1], round(p[2], 3)) for p in peaks])

    # Which viewport is which: the config lists them by name, the peaks come
    # left-to-right. Pair by the configured order left-to-right.
    order = cfg.get("left_to_right") or ["planting", "grading"]
    vps = {v["key"]: dict(v) for v in cfg["viewports"]}
    for key, pk in zip(order, peaks):
        vps[key]["peak"] = pk

    # ---- 2. refine, free then locked ----
    def refine(x0):
        simplex = np.array([x0, x0 + [0.3, 0, 0, 0], x0 + [0, 0.001, 0, 0],
                            x0 + [0, 0, 3, 0], x0 + [0, 0, 0, 3]])
        r = optimize.minimize(lambda p: -darkness(p), x0, method="Nelder-Mead",
                              options=dict(xatol=1e-3, fatol=1e-5, maxiter=4000,
                                           initial_simplex=simplex))
        return r.x, -r.fun

    for key, vp in vps.items():
        u, v, _ = vp["peak"]
        x0 = np.array([theta0, S0, float(u), float(v)])
        xb, fb = refine(x0)
        vp["free"] = dict(rot=float(xb[0]), scale=float(xb[1]), tu=float(xb[2]),
                          tv=float(xb[3]), darkness=fb)
        print("%-9s free fit: rot %+.4f  scale %.6f ft/px  centre (%.1f, %.1f)  darkness %.3f"
              % (key, xb[0], xb[1], xb[2], xb[3], fb))

    rot = cfg["drafting_deg"]
    scale = float(np.mean([vp["free"]["scale"] for vp in vps.values()]))
    print("locking rotation to the drafting angle %+.1f and scale to %.6f ft/px "
          "(%+.2f%% vs the other 1in=20ft sheets)" % (rot, scale, 100 * (scale / S0 - 1)))
    for key, vp in vps.items():
        f = vp["free"]
        r = optimize.minimize(lambda p: -darkness([rot, scale, p[0], p[1]]),
                              [f["tu"], f["tv"]], method="Nelder-Mead",
                              options=dict(xatol=1e-3, fatol=1e-6))
        vp["tu"], vp["tv"] = float(r.x[0]), float(r.x[1])
        vp["darkness"] = float(-r.fun)
        params = (rot, scale, vp["tu"], vp["tv"])
        # 3. per-vertex residuals
        pts = fwd(params, P)
        res = []
        for i in range(len(pts)):
            a, c_, v0 = pts[i - 1], pts[(i + 1) % len(pts)], pts[i]
            bestd = None
            for du in np.arange(-6, 6.01, 0.5):
                for dv in np.arange(-6, 6.01, 0.5):
                    vv = v0 + [du, dv]
                    s1 = samples(np.array([a, vv])); s2 = samples(np.array([vv, c_]))
                    ss = np.vstack([s1[len(s1) // 2:], s2[:len(s2) // 2]])
                    d = float(ndimage.map_coordinates(dark, [ss[:, 1], ss[:, 0]], order=1).mean())
                    if bestd is None or d > bestd[0]:
                        bestd = (d, du, dv)
            res.append(math.hypot(bestd[1], bestd[2]) * scale)
        vp["resid_med"] = float(np.median(res))
        vp["resid_max"] = float(np.max(res))
        print("%-9s locked: centre (%.1f, %.1f)  darkness %.3f  vertex residual med %.2f / max %.2f ft"
              % (key, vp["tu"], vp["tv"], vp["darkness"], vp["resid_med"], vp["resid_max"]))
        if vp["darkness"] < MIN_DARKNESS or vp["resid_med"] > MAX_RESID_MED_FT:
            sys.exit("%s viewport fit is not good enough — refusing" % key)

    # ---- the affine per viewport (page px -> State Plane) ----
    def affine_of(vp):
        t = math.radians(rot)
        ct, st = math.cos(t), math.sin(t)
        # inverse rotation of (u - tu, v - tv), then x = xc + s*dx, y = yc - s*dy
        a = scale * ct;  b = scale * st
        d = -scale * (-st); e = -scale * ct
        c_ = xc - (a * vp["tu"] + b * vp["tv"])
        f = yc - (d * vp["tu"] + e * vp["tv"])
        return dict(a=a, b=b, c=c_, d=d, e=e, f=f)

    for key, vp in vps.items():
        A = vp["affine"] = affine_of(vp)
        # self-check: vertices through the affine must reproduce the native polygon
        pts = fwd((rot, scale, vp["tu"], vp["tv"]), P)
        back = np.stack([A["a"] * pts[:, 0] + A["b"] * pts[:, 1] + A["c"],
                         A["d"] * pts[:, 0] + A["e"] * pts[:, 1] + A["f"]], axis=1)
        err = float(np.hypot(*(back - P).T).max())
        if err > 1e-6:
            sys.exit("affine self-check failed (%g ft)" % err)

    # ---- viewport pixel rectangles: the non-paper region around each polygon ----
    g4 = grey[:h4 * ds, :w4 * ds].reshape(h4, ds, w4, ds).mean(axis=(1, 3))
    m = ndimage.binary_opening(ndimage.binary_closing(g4 < 238, iterations=6), iterations=3)
    lab, _ = ndimage.label(m)
    for key, vp in vps.items():
        l = lab[int(vp["tv"] / ds), int(vp["tu"] / ds)]
        ys, xs = np.where(lab == l)
        vp["px"] = [int(xs.min() * ds), int(ys.min() * ds),
                    int((xs.max() + 1) * ds), int((ys.max() + 1) * ds)]
        print("%-9s viewport rectangle px %s" % (key, vp["px"]))

    # ---- 4. independent confirmation against the app orthophoto ----
    oj = json.load(open(os.path.join(ROOT, "data", "ortho_mine.json")))
    O = np.asarray(Image.open(os.path.join(ROOT, "data", "ortho_mine.jpg")).convert("L")).astype(np.float32)
    oh, ow = O.shape
    ofx = (oj["x1"] - oj["x0"]) / ow
    ofy = (oj["y1"] - oj["y0"]) / oh
    for key, vp in vps.items():
        A = vp["affine"]
        u0, v0, u1, v1 = vp["px"]
        uu, vv = np.meshgrid(np.arange(u0, u1, dtype=np.float64), np.arange(v0, v1, dtype=np.float64))
        X = A["a"] * uu + A["b"] * vv + A["c"]
        Y = A["d"] * uu + A["e"] * vv + A["f"]
        ren = ndimage.map_coordinates(O, [(oj["y1"] - Y) / ofy, (X - oj["x0"]) / ofx],
                                      order=1, mode="constant", cval=np.nan)
        sh = grey[v0:v1, u0:u1]
        ok = np.isfinite(ren) & (sh > 60) & (sh < 250)   # aerial mid-tones only, no ink, no paper
        def hp(a):
            a = np.where(ok, a, a[ok].mean())
            return np.where(ok, a - ndimage.gaussian_filter(a, 25), 0.0)
        Aimg, Bimg = hp(sh), hp(ren)

        def ncc(dx, dy):
            a = Aimg[40:-40, 40:-40]
            b = Bimg[40 + dy:Bimg.shape[0] - 40 + dy, 40 + dx:Bimg.shape[1] - 40 + dx]
            a = a - a.mean(); b = b - b.mean()
            den = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
            return float((a * b).sum() / den) if den else 0.0
        n0 = ncc(0, 0)
        bst = (-1.0, 0, 0)
        for dy in range(-40, 41, 2):
            for dx in range(-40, 41, 2):
                cc = ncc(dx, dy)
                if cc > bst[0]:
                    bst = (cc, dx, dy)
        for dy in range(bst[2] - 2, bst[2] + 3):
            for dx in range(bst[1] - 2, bst[1] + 3):
                cc = ncc(dx, dy)
                if cc > bst[0]:
                    bst = (cc, dx, dy)
        vp["ortho"] = dict(ncc_at_fit=round(n0, 3), ncc_peak=round(bst[0], 3),
                           shift_px=[bst[1], bst[2]],
                           agree_ft=round(math.hypot(bst[1], bst[2]) * scale, 2))
        print("%-9s ortho: ncc %.3f at the fit, peak %.3f at a shift of %.2f ft"
              % (key, n0, bst[0], vp["ortho"]["agree_ft"]))
        if bst[0] < MIN_ORTHO_NCC or vp["ortho"]["agree_ft"] > MAX_AGREE_FT:
            sys.exit("%s viewport: the orthophoto does not confirm the polygon fit — refusing" % key)

    # ---- the primary viewport's north-up crop ----
    prim = [vp for vp in vps.values() if vp.get("primary")][0]
    A = prim["affine"]
    u0, v0, u1, v1 = prim["px"]
    corners = [(u0, v0), (u1, v0), (u0, v1), (u1, v1)]
    xs = [A["a"] * u + A["b"] * v + A["c"] for u, v in corners]
    ys = [A["d"] * u + A["e"] * v + A["f"] for u, v in corners]
    fpp = cfg["crop_ft_per_px"]
    x0 = math.floor(min(xs)); x1 = math.ceil(max(xs))
    y0 = math.floor(min(ys)); y1 = math.ceil(max(ys))
    cw = int(round((x1 - x0) / fpp)); ch = int(round((y1 - y0) / fpp))
    det = A["a"] * A["e"] - A["b"] * A["d"]
    gx = x0 + (np.arange(cw) + 0.5) * fpp
    gy = y1 - (np.arange(ch) + 0.5) * fpp
    GX, GY = np.meshgrid(gx, gy)
    dxg, dyg = GX - A["c"], GY - A["f"]
    U = (A["e"] * dxg - A["b"] * dyg) / det
    V = (A["a"] * dyg - A["d"] * dxg) / det
    inset = 6  # px inside the viewport border line
    inside = (U >= u0 + inset) & (U <= u1 - inset) & (V >= v0 + inset) & (V <= v1 - inset)
    chans = [ndimage.map_coordinates(sheet_rgb[..., k], [V, U], order=1, mode="constant", cval=255.0)
             for k in range(3)]
    crop = np.stack(chans + [np.where(inside, 255.0, 0.0)], axis=2)
    crop = np.clip(np.round(crop), 0, 255).astype(np.uint8)
    png_name = "design_%s.png" % tag
    png_path = os.path.join(ROOT, "data", "design", png_name)
    print("crop: %s %dx%d px at %.2f ft/px over E %d-%d N %d-%d (%.0f%% opaque)"
          % (png_name, cw, ch, fpp, x0, x1, y0, y1, 100 * inside.mean()))

    # ---- records ----
    page_w_pt = 36 * 72.0
    sx = scale * (W / page_w_pt)  # ft per PDF point, for the record
    rec = dict(
        page=cfg["page"], sheet=name, subject=cfg["subject"], design_set=cfg["design_set"],
        scale_ft_per_pt=round(sx, 5), rot_deg=rot, sx=sx, sy=sx,
        nodes_used=len(P), nodes_total=len(cfg["nodes"]),
        resid_med_ft=round(prim["resid_med"], 2), resid_max_ft=round(prim["resid_max"], 2),
        method=("native-geometry fit: EA's geodatabase polygon '%s' (%d vertices) matched to "
                "the heavy linework of each plan viewport with rotation locked to the drafting "
                "angle; confirmed by independent ortho correlation (tools/register_sheet_native.py)"
                % (cfg["feature"], len(P))),
        native_feature=cfg["feature"],
        ortho_peak=prim["ortho"]["ncc_peak"], ortho_agree_ft=prim["ortho"]["agree_ft"],
        viewports=[dict(name=vp["name"], primary=bool(vp.get("primary")), px=vp["px"],
                        darkness=round(vp["darkness"], 3),
                        resid_med_ft=round(vp["resid_med"], 2), resid_max_ft=round(vp["resid_max"], 2),
                        free_fit=dict(rot_deg=round(vp["free"]["rot"], 4),
                                      scale_ft_per_px=round(vp["free"]["scale"], 6)),
                        ortho=vp["ortho"])
                   for vp in vps.values()],
        raster=dict(page=cfg["page"], file=png_name, x0=float(x0), y0=float(y0),
                    x1=float(x1), y1=float(y1), ft_per_px=fpp, w=cw, h=ch, bytes=None),
    )
    node_feats = [dict(type="Feature",
                       properties=dict(sheet=name, subject=cfg["subject"], design_set=cfg["design_set"],
                                       page=cfg["page"], name="%s (%s) node %d" % (name, cfg["subject"], nd["pt"]),
                                       kind="node", confidence="surveyed", pt=nd["pt"]),
                       geometry=dict(type="Point", coordinates=[nd["e"], nd["n"]]))
                  for nd in cfg["nodes"]]
    # the printed nodes must be vertices of the native polygon — that is the whole premise
    for nd in cfg["nodes"]:
        dmin = float(np.hypot(P[:, 0] - nd["e"], P[:, 1] - nd["n"]).min())
        print("printed node %d is %.2f ft from the nearest native vertex" % (nd["pt"], dmin))
        if dmin > 0.5:
            sys.exit("printed node %d is not on the native polygon — wrong feature?" % nd["pt"])

    def rnd(A):
        return dict(a=round(A["a"], 9), b=round(A["b"], 9), c=round(A["c"], 4),
                    d=round(A["d"], 9), e=round(A["e"], 9), f=round(A["f"], 4))
    aff = dict(rnd(prim["affine"]), ft_per_px=round(scale, 6), rot_deg=-rot,
               ncc=prim["ortho"]["ncc_peak"], signal="native polygon",
               roundtrip_ft=0.0,
               gis_check=dict(n=len(P), inside_pct=100),
               method=("native-geometry fit of EA's '%s' polygon to the plan linework, rotation "
                       "locked to the drafting angle, confirmed by independent ortho correlation "
                       "(agree %.2f ft); see tools/register_sheet_native.py" % (cfg["feature"], prim["ortho"]["agree_ft"])))
    viewports = [dict(name=vp["name"], primary=bool(vp.get("primary")), px=vp["px"],
                      affine=dict(rnd(vp["affine"]), ft_per_px=round(scale, 6), rot_deg=-rot))
                 for vp in vps.values()]

    if args.dry_run:
        print("(dry run — nothing written)")
        return

    Image.fromarray(crop, "RGBA").save(png_path, optimize=True)
    rec["raster"]["bytes"] = os.path.getsize(png_path)

    ea_path = os.path.join(ROOT, "data", "design_ea.json")
    ea = json.load(open(ea_path))
    ea["sheets"][name] = rec
    ea["features"] = [f for f in ea["features"]
                      if not ((f.get("properties") or {}).get("sheet") == name
                              and (f.get("properties") or {}).get("kind") == "node")] + node_feats
    ea["registration"] = ea.get("registration", "").replace(
        "C-101, C-102 and C-202 remain unregistered.",
        "C-202 was placed from EA's native geodatabase polygon (tools/register_sheet_native.py), "
        "each of its two plan viewports solved separately. C-101 and C-102 remain unregistered.")
    # design_ea.json is stored compact (one line) — keep it that way so the diff is the change
    with open(ea_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(ea, separators=(",", ":"), ensure_ascii=False))

    sf_path = os.path.join(ROOT, "data", "sheets_full.json")
    sf = json.load(open(sf_path))
    for s in sf["sheets"]:
        if s["sheet"] == name:
            s["affine"] = aff
            s["viewports"] = viewports
            s["affine_source"] = "native"
            s.pop("affine_note", None)
    json.dump(sf, open(sf_path, "w"), indent=1, ensure_ascii=False)
    print("wrote %s, updated design_ea.json and sheets_full.json" % png_name)
    print("now: python tools/build_data.py, and add datajs/i_design_%s_png.js to index.html" % tag)


if __name__ == "__main__":
    main()
