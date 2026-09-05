#!/usr/bin/env python3
"""Register a plan sheet from EA's NATIVE geometry instead of its printed node table.

Why this exists
---------------
Three sheets of the Final set defeated both PDF registration methods (the
account is in README, "Why three sheets are still not registered"):

  * C-202 (North Lobe Grading) prints only two survey nodes and carries TWO
    plan viewports of the same ground, so one affine for the page is wrong by
    construction.
  * C-102 (Staging Area) prints NO coordinate table at all, so only one method
    (imagery) was ever available and one method cannot meet the bar.
  * C-203 (Borrow Source Demonstration Area) prints four nodes that are a plain
    90 x 120 ft axis-aligned rectangle - so unspecific that the vote stage
    emitted ~720,000 candidates, and symmetric enough that a fit is ambiguous
    under a 180 deg turn.

EA's June-2026 native deliverable changes the arithmetic for all three. A
geodatabase polygon is a node table with every vertex surveyed, and there are
more of them than any sheet prints:

  * C-202: "Limit of excavation - North Lobe", 11 vertices of a distinctive
    shape (22 equations against four unknowns), whose two southern vertices ARE
    the sheet's two printed nodes to 0.02 ft.
  * C-102: FIVE polygons of different shapes and sizes on one plan - the
    staging area, the two borrow-soil staging areas, the gravel area and the
    construction entrance: 127 vertices, fitted together as ONE rigid
    transform.
  * C-203: the borrow rectangle (whose four corners ARE printed nodes 83-86)
    plus the 15 ft cell grid the sheet's own work sequence specifies inside it.
    The rectangle alone is ambiguous under a 180 deg turn; the ambiguity is
    broken by geometry that took no part in the fit (the access haul route and
    the staging area) and, independently, by the app orthophoto.

Method, per sheet
-----------------
 1. Coarse: rotation swept through 360 deg at 1 deg with the scale LOCKED to
    the sheet's own plan scale (its printed graphic scale bar, which agrees
    with the /VP measure and with the scales recovered for the rest of the
    set), translation by FFT cross-correlation of the control outline against
    the sheet's heavy ink.
 2. Refine, per viewport: Nelder-Mead over (rotation, scale, translation)
    maximising the mean darkness sampled along the transformed outline. Then
    rotation is LOCKED to the drafting angle and scale to the mean of the free
    fits, and only the translation is re-solved - the same "lock what you know"
    rule the printed-node method uses. The free scale is reported as a percent
    of the nominal: it is a check, not a parameter.
 3. Per-vertex residual: each vertex is moved on a +-6 px grid to the darkest
    corner position; the distance moved is that vertex's residual.
 3b. Null calibration. These sheets are drawn OVER an aerial photograph, so
    "darkness" is high everywhere and an absolute threshold means different
    things on different sheets. The tool therefore measures the darkness of 400
    random placements of the same control inside the same plan viewport and
    reports the fit as a z-score against them. A sheet must clear both an
    absolute floor and MIN_DARK_Z.
 3c. Ambiguity. Where a sheet's control has a symmetry (C-203's rectangle),
    every rival rotation is refined the same way and scored on: the fit
    darkness, the darkness of CONFIRMATION features that took no part in the
    fit, and the ortho correlation. All three must prefer the same answer.
 4. Independent confirmation: the app's own orthophoto (which knows nothing
    about the sheet) is rendered into the plan viewport's ground footprint
    through the recovered transform and correlated with the sheet's embedded
    aerial, in GROUND units at the ortho's own resolution. What is scored is
    how far the imagery MOVES the sheet from where the polygons put it. The
    twelve already-registered sheets, put through this same check, agree to
    0.00-3.16 ft (median 2.0); a wrong registration is 60-130 ft. Run
    `--calibrate` to reprint that table.

Outputs
-------
 * data/design/design_<sheet>.png - north-up State Plane crop of the PRIMARY
   viewport at the sheet's crop resolution, paper outside the plan knocked out
   to alpha. This is the raster the 2D overlay and the 3D drape use; two
   viewports of the same ground cannot both be draped, so the design plan is
   the one that is.
 * data/design_ea.json - the sheet record (raster bbox, scale, rotation, fit
   statistics, method, ambiguity table) and any printed nodes as surveyed-node
   features.
 * data/sheets_full.json - the full-sheet affine for the primary viewport,
   plus `viewports`: one {name, px:[u0,v0,u1,v1], affine} per plan viewport,
   so js/sheetmarks.js can georeference a mark in EITHER plan and refuse one on
   the title block. `affine_source: "native"` tells tools/build_sheet_affine.py
   to leave the record alone.

Then: python tools/build_data.py, add datajs/i_design_<sheet>_png.js to
index.html's script list, and run the tests.

Usage
-----
    python tools/register_sheet_native.py C-102            # writes
    python tools/register_sheet_native.py C-203 --dry-run  # report only
    python tools/register_sheet_native.py --calibrate      # the ortho table
"""
import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# One entry per sheet this tool knows how to register.
#   features      native polygon/line names in data/design_gis.json used AS the
#                 fit control (every feature carrying the name is used).
#   grid          a derived control the sheet itself specifies: the cell grid
#                 inside `feature`, at `cell_ft`. Used by C-203, whose bare
#                 rectangle carries too little signal to find a rotation.
#   confirm       features that take NO part in the fit and are scored after
#                 it - the independent geometric check, and the tie-breaker
#                 for an ambiguous control.
#   resid         which features the reported per-vertex residual is measured
#                 on (default: everything in `features`).
#   ambiguity     rival rotations to refine and score, for a symmetric control.
#   viewports     the plan viewports left-to-right by the control copy each
#                 contains (primary first = the one that becomes the map
#                 raster).
#   viewport_detect  "ink" = the non-paper connected component (C-202, whose
#                 two plans are separated by paper); "colour" = the aerial's
#                 own colour component, for a single-viewport sheet whose plan
#                 touches the sheet border.
#   scale0        the plan scale in ft per full-render px. A 36 in sheet at
#                 4200 px is 116.667 px/in, so 1 in = N ft is N/116.667.
#   coarse_ds     the downsample the 360 deg FFT sweep runs at. 4 is right for
#                 a big heavy outline; C-203's control is a 15 ft grid inside a
#                 90 x 120 ft rectangle, and at ds 4 those lines blur into the
#                 sheet's own orthogonal borders and the sweep answers +90.
SHEETS = {
    "C-202": dict(
        page=15, subject="North Lobe", design_set="Final",
        features=["Limit of excavation — North Lobe"],
        scale0=0.171466, scale_name="1 in = 20 ft",
        drafting_deg=-90.0,
        viewports=[
            dict(key="grading", name="North Lobe Grading Plan", primary=True),
            dict(key="planting", name="North Lobe Restoration Planting Zones"),
        ],
        left_to_right=["planting", "grading"],
        viewport_detect="ink",
        min_darkness=0.85,
        nodes=[  # the sheet's own printed lot table (northing, easting)
            dict(pt=81, n=2130050.03, e=6371156.81),
            dict(pt=82, n=2130048.31, e=6371297.72),
        ],
        crop_ft_per_px=0.5,
    ),
    "C-102": dict(
        page=4, subject="Staging Area", design_set="Final",
        # five polygons of different shapes and sizes on one plan: 127
        # vertices against four unknowns, fitted as ONE rigid transform
        features=["Staging Area", "Borrow Soil Staging Area", "Gravel Area",
                  "Construction Entrance"],
        # C-102 needs no tie-breaker: its control has no symmetry, and five
        # polygons of five different shapes agreeing on one rigid transform is
        # itself the redundancy (4 unknowns against 254 equations). The access
        # haul route, which took no part in the fit, lands along the drawn
        # Sulphur Bank Mine Road - but the road is drawn as a WHITE band with
        # hatch only at its edges, so "ink under the centreline" is not a
        # statistic that says so, and the registration shot is.
        scale0=0.171466, scale_name="1 in = 20 ft",
        drafting_deg=40.0,
        viewports=[dict(key="plan", name="Staging Area Plan", primary=True)],
        viewport_detect="colour",
        # the staging-area limit is drawn as a silt-fence line and the gravel
        # area as a hatch boundary, so the mean ink along the outline is lower
        # than C-202's solid black limit of excavation. The null calibration
        # below is what makes that comparable between sheets.
        min_darkness=0.50,
        nodes=[],   # this sheet prints no coordinate table at all
        crop_ft_per_px=0.75, crop_mask="plan",
    ),
    "C-203": dict(
        page=16, subject="Borrow Source Demonstration Area", design_set="Final",
        features=["Borrow Area"],
        # "ESTABLISH NUMBERED CELLS ... MEASURING 15 FEET X 15 FEET WITHIN
        # 90-FT X 120-FT BORROW AREA" - the sheet's own work sequence, drawn
        # on the plan as a 6 x 8 grid. The bare rectangle peaks nowhere; the
        # grid peaks at exactly one rotation (and its 180 deg twin).
        grid=dict(feature="Borrow Area", cell_ft=15.0),
        confirm=["Access Haul Route (Staging/Borrow Area)", "Staging Area"],
        resid=["Borrow Area"],
        ambiguity=[150.0, 60.0, -120.0],
        scale0=0.428665, scale_name="1 in = 50 ft",
        drafting_deg=-30.0, coarse_ds=2,
        viewports=[dict(key="plan", name="Borrow Source Demonstration Area Plan",
                        primary=True)],
        viewport_detect="colour",
        min_darkness=0.70,
        nodes=[  # printed table, nodes 83-86 = the rectangle's four corners
            dict(pt=83, n=2126340.34, e=6371752.17),
            dict(pt=84, n=2126460.34, e=6371752.17),
            dict(pt=85, n=2126460.34, e=6371662.17),
            dict(pt=86, n=2126340.34, e=6371662.17),
        ],
        crop_ft_per_px=1.0, crop_mask="plan",
    ),
}

INK_THRESHOLD = 70      # grey level below which a pixel is heavy linework
MIN_DARKNESS = 0.85     # mean ink along the outline (absolute floor)
MIN_DARK_Z = 5.0        # ... and how far above 400 random placements it is
MIN_CONFIRM_MARGIN = 1.5  # by how much the INDEPENDENT ortho must separate a
                          # rival rotation from the accepted one
MAX_RESID_MED_FT = 1.0  # per-vertex residual, median
MAX_AGREE_FT = 3.5      # how far the ortho may move the sheet (the twelve
                        # registered sheets span 0.00-3.16 through this check)
MIN_ORTHO_NCC = 0.30    # correlation of app ortho vs the sheet's aerial
MIN_ORTHO_RATIO = 6.0   # ... over the median |ncc| across the search window
ORTHOS = ["ortho_abp", "ortho_mine", "ortho_site"]   # finest first
NULL_N = 400
NULL_SEED = 7


# ------------------------------------------------------------------ geometry
def load_named(gis, names):
    """Every feature carrying one of `names`, as (pts, closed, name)."""
    out = []
    for f in gis["features"]:
        nm = (f.get("properties") or {}).get("name")
        if nm not in names:
            continue
        gm = f["geometry"]
        if gm["type"] == "Polygon":
            r = gm["coordinates"][0]
            if r[0] == r[-1]:
                r = r[:-1]
            out.append((r, True, nm))
        elif gm["type"] == "LineString":
            out.append((gm["coordinates"], False, nm))
    return out


def grid_paths(ring, cell_ft):
    """The cell grid inside an axis-aligned rectangle, as open 2-point paths."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    out = []
    n = int(round((x1 - x0) / cell_ft))
    m = int(round((y1 - y0) / cell_ft))
    for i in range(1, n):
        x = x0 + i * cell_ft
        out.append(([[x, y0], [x, y1]], False, "grid"))
    for j in range(1, m):
        y = y0 + j * cell_ft
        out.append(([[x0, y], [x1, y]], False, "grid"))
    return out, (n, m)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet", nargs="?")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--calibrate", action="store_true",
                    help="run the ortho check over the already-registered "
                         "sheets and print the agreement table")
    args = ap.parse_args()
    if args.calibrate:
        return calibrate()
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
    feats = load_named(gis, set(cfg["features"]))
    if not feats:
        sys.exit("native features not found: " + ", ".join(cfg["features"]))
    control = [(np.array(p, float), c, nm) for p, c, nm in feats]
    gridspec = cfg.get("grid")
    if gridspec:
        base = [p for p, c, nm in feats if nm == gridspec["feature"]][0]
        gp, (gn, gm) = grid_paths(base, gridspec["cell_ft"])
        control += [(np.array(p, float), c, nm) for p, c, nm in gp]
        print("%s: the sheet's own %g ft cell grid inside '%s' adds %d x %d cells"
              % (name, gridspec["cell_ft"], gridspec["feature"], gn, gm))
    confirm = [(np.array(p, float), c, nm)
               for p, c, nm in load_named(gis, set(cfg.get("confirm") or []))]

    allp = np.vstack([p for p, c, nm in control])
    xc, yc = allp.mean(axis=0)
    print("%s: %d native paths / %d vertices (%s), centroid %.2f E %.2f N"
          % (name, len(control), len(allp), ", ".join(sorted(set(nm for _, _, nm in control))),
             xc, yc))
    if confirm:
        print("%s: %d confirmation paths (%s) take no part in the fit"
              % (name, len(confirm), ", ".join(sorted(set(nm for _, _, nm in confirm)))))

    # ---- ground -> page: page = R(theta) @ [(x-xc)/s, -(y-yc)/s] + t ----
    def fwd(params, pts):
        th, s, tu, tv = params
        t = math.radians(th)
        dx = (pts[:, 0] - xc) / s
        dy = -(pts[:, 1] - yc) / s
        return np.stack([dx * math.cos(t) - dy * math.sin(t) + tu,
                         dx * math.sin(t) + dy * math.cos(t) + tv], axis=1)

    def samples(pts, closed=True, step=0.5):
        out = []
        n = len(pts)
        m = n if closed else n - 1
        for i in range(m):
            a, b = pts[i], pts[(i + 1) % n]
            k = max(2, int(math.hypot(*(b - a)) / step))
            for q in np.linspace(0, 1, k, endpoint=False):
                out.append(a + (b - a) * q)
        return np.array(out)

    def darkness(params, paths=None, step=0.5):
        tot = 0.0
        n = 0
        for p, closed, _ in (control if paths is None else paths):
            s = fwd(params, samples(p, closed, step))
            d = ndimage.map_coordinates(dark, [s[:, 1], s[:, 0]], order=1,
                                        mode="constant", cval=0.0)
            tot += float(d.sum())
            n += len(d)
        return tot / max(1, n)

    # ---- 1. coarse sweep at 1/4 resolution ----
    S0 = cfg["scale0"]
    ds = cfg.get("coarse_ds", 4)
    h4, w4 = H // ds, W // ds
    ink4 = ink[:h4 * ds, :w4 * ds].reshape(h4, ds, w4, ds).mean(axis=(1, 3))
    Fi = np.fft.rfft2(ink4)

    def corr(theta):
        tpl = Image.new("F", (w4, h4), 0.0)
        dr = ImageDraw.Draw(tpl)
        for p, closed, _ in control:
            q = fwd((theta, S0, 0.0, 0.0), p) / ds
            pp = [(a[0] + w4 / 2, a[1] + h4 / 2) for a in q]
            if closed:
                pp = pp + [pp[0]]
            dr.line(pp, fill=1.0, width=1)
        T = np.asarray(tpl)
        return np.fft.irfft2(Fi * np.conj(np.fft.rfft2(T)), s=ink4.shape) / T.sum()

    best = []
    for th in np.arange(-180.0, 180.0, 1.0):
        c = corr(th)
        best.append((float(c.max()), float(th)))
    best.sort(reverse=True)
    print("coarse: best rotation %+.0f deg (outline-on-ink %.3f); runner-up %+.0f (%.3f)"
          % (best[0][1], best[0][0], best[1][1], best[1][0]))
    rivals = [float(r) for r in (cfg.get("ambiguity") or [])]
    want = cfg["drafting_deg"]
    keep = 1 + len(rivals)          # a symmetric control peaks once per symmetry
    top = [th for _, th in best[:keep]]
    rank = next((i for i, (_, th) in enumerate(best)
                 if abs(((th - want + 180) % 360) - 180) <= 2.0), None)
    print("coarse: the drafting angle %+.1f is rank %s of 360 (%s kept)"
          % (want, "n/a" if rank is None else rank + 1, keep))
    if rank is None or rank >= keep:
        sys.exit("the drafting angle %+.1f is not among the coarse rotations %s"
                 % (want, top))
    if rivals:
        print("coarse: the control is symmetric - %d rival rotations %s will be "
              "refined and scored beside it"
              % (len(rivals), ", ".join("%+.0f" % r for r in rivals)))

    def peak_at(theta, n=1):
        c = corr(theta).copy()
        out = []
        for _ in range(n):
            k = int(np.argmax(c))
            v, u = divmod(k, w4)
            out.append((((u + w4 // 2) % w4) * ds, ((v + h4 // 2) % h4) * ds,
                        float(c.flat[k])))
            c[max(0, v - 60):v + 60, max(0, u - 60):u + 60] = 0
        return out

    theta0 = want
    peaks = peak_at(theta0, len(cfg["viewports"]))
    peaks.sort()  # left to right on the page
    print("coarse: viewport peaks (u, v, score):",
          [(p[0], p[1], round(p[2], 3)) for p in peaks])

    order = cfg.get("left_to_right") or [v["key"] for v in cfg["viewports"]]
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
        xb, fb = refine(np.array([theta0, S0, float(u), float(v)]))
        vp["free"] = dict(rot=float(xb[0]), scale=float(xb[1]), tu=float(xb[2]),
                          tv=float(xb[3]), darkness=fb)
        print("%-9s free fit: rot %+.4f  scale %.6f ft/px  centre (%.1f, %.1f)  darkness %.3f"
              % (key, xb[0], xb[1], xb[2], xb[3], fb))

    rot = cfg["drafting_deg"]
    scale = float(np.mean([vp["free"]["scale"] for vp in vps.values()]))
    print("free-fit scale is %+.3f%% from the sheet's %s; locking rotation to the "
          "drafting angle %+.1f and scale to the nominal %.6f ft/px"
          % (100 * (scale / S0 - 1), cfg["scale_name"], rot, S0))
    if abs(scale / S0 - 1) > 0.003:
        sys.exit("the free scale is %+.3f%% from the plan scale - refusing"
                 % (100 * (scale / S0 - 1)))
    free_scale = scale
    scale = S0

    def solve_t(theta, t0, paths=None):
        r = optimize.minimize(
            lambda t: -darkness((theta, scale, t[0], t[1]), paths),
            t0, method="Nelder-Mead", options=dict(xatol=1e-3, fatol=1e-7))
        return r.x, -r.fun

    resid_names = set(cfg.get("resid") or cfg["features"])
    resid_paths = [(p, c, nm) for p, c, nm in control if nm in resid_names]

    for key, vp in vps.items():
        f = vp["free"]
        t, d = solve_t(rot, [f["tu"], f["tv"]])
        vp["tu"], vp["tv"] = float(t[0]), float(t[1])
        vp["darkness"] = float(d)
        params = (rot, scale, vp["tu"], vp["tv"])
        # 3. per-vertex residuals
        res = []
        per = {}
        for p, closed, fnm in resid_paths:
            pts = fwd(params, p)
            n = len(pts)
            for i in range(n):
                if closed:
                    a, c_ = pts[i - 1], pts[(i + 1) % n]
                else:
                    a = pts[i - 1] if i > 0 else pts[min(1, n - 1)]
                    c_ = pts[i + 1] if i < n - 1 else pts[max(0, n - 2)]
                bestd = None
                for du in np.arange(-6, 6.01, 0.5):
                    for dv in np.arange(-6, 6.01, 0.5):
                        vv = pts[i] + [du, dv]
                        s1 = samples(np.array([a, vv]), False)
                        s2 = samples(np.array([vv, c_]), False)
                        ss = np.vstack([s1[len(s1) // 2:], s2[:len(s2) // 2]])
                        dd = float(ndimage.map_coordinates(
                            dark, [ss[:, 1], ss[:, 0]], order=1).mean())
                        if bestd is None or dd > bestd[0]:
                            bestd = (dd, du, dv)
                r_ = math.hypot(bestd[1], bestd[2]) * scale
                res.append(r_)
                per.setdefault(fnm, []).append(r_)
        vp["per_feature"] = [dict(name=k, n=len(v), med=round(float(np.median(v)), 2),
                                  max=round(float(np.max(v)), 2))
                             for k, v in per.items()]
        vp["resid_med"] = float(np.median(res))
        vp["resid_max"] = float(np.max(res))
        vp["resid_n"] = len(res)
        print("%-9s locked: centre (%.1f, %.1f)  darkness %.3f  vertex residual "
              "med %.2f / max %.2f ft over %d vertices"
              % (key, vp["tu"], vp["tv"], vp["darkness"], vp["resid_med"],
                 vp["resid_max"], vp["resid_n"]))
        for e in sorted(vp["per_feature"], key=lambda e: -e["n"]):
            print("            %-34s n=%3d  med %.2f  max %.2f ft"
                  % (e["name"], e["n"], e["med"], e["max"]))
        if vp["resid_med"] > MAX_RESID_MED_FT:
            sys.exit("%s viewport residual is not good enough - refusing" % key)

    # ---- the affine per viewport (page px -> State Plane) ----
    def affine_of(vp, theta=None):
        t = math.radians(rot if theta is None else theta)
        ct, st = math.cos(t), math.sin(t)
        a = scale * ct
        b = scale * st
        d = -scale * (-st)
        e = -scale * ct
        return dict(a=a, b=b, c=xc - (a * vp["tu"] + b * vp["tv"]),
                    d=d, e=e, f=yc - (d * vp["tu"] + e * vp["tv"]))

    for key, vp in vps.items():
        A = vp["affine"] = affine_of(vp)
        pts = fwd((rot, scale, vp["tu"], vp["tv"]), allp)
        back = np.stack([A["a"] * pts[:, 0] + A["b"] * pts[:, 1] + A["c"],
                         A["d"] * pts[:, 0] + A["e"] * pts[:, 1] + A["f"]], axis=1)
        err = float(np.hypot(*(back - allp).T).max())
        if err > 1e-6:
            sys.exit("affine self-check failed (%g ft)" % err)

    # ---- viewport pixel rectangles ----
    if cfg.get("viewport_detect") == "colour":
        # a single plan whose viewport touches the sheet border: the aerial's
        # own colour is what separates it from the paper, not its ink.
        sat = sheet_rgb.max(axis=2) - sheet_rgb.min(axis=2)
        d8 = 8
        h8, w8 = H // d8, W // d8
        s8 = sat[:h8 * d8, :w8 * d8].reshape(h8, d8, w8, d8).mean(axis=(1, 3))
        m = ndimage.binary_opening(ndimage.binary_closing(s8 > 12, iterations=4),
                                   iterations=3)
        lab, nlab = ndimage.label(m)
        sizes = ndimage.sum(m, lab, range(1, nlab + 1))
        k = int(np.argmax(sizes)) + 1
        planmask = (lab == k)
        ys, xs = np.where(planmask)
        rect = [int(xs.min() * d8), int(ys.min() * d8),
                int((xs.max() + 1) * d8), int((ys.max() + 1) * d8)]
        for vp in vps.values():
            vp["px"] = rect
            vp["_mask"] = (planmask, d8)
        print("plan viewport (aerial colour component) px %s" % rect)
    else:
        g4 = grey[:h4 * ds, :w4 * ds].reshape(h4, ds, w4, ds).mean(axis=(1, 3))
        m = ndimage.binary_opening(ndimage.binary_closing(g4 < 238, iterations=6),
                                   iterations=3)
        lab, _ = ndimage.label(m)
        for key, vp in vps.items():
            l = lab[int(vp["tv"] / ds), int(vp["tu"] / ds)]
            ys, xs = np.where(lab == l)
            vp["px"] = [int(xs.min() * ds), int(ys.min() * ds),
                        int((xs.max() + 1) * ds), int((ys.max() + 1) * ds)]
            vp["_mask"] = None
            print("%-9s viewport rectangle px %s" % (key, vp["px"]))

    # ---- 3b. null calibration inside the plan viewport ----
    prim = [vp for vp in vps.values() if vp.get("primary")][0]
    u0, v0, u1, v1 = prim["px"]
    rng = np.random.default_rng(NULL_SEED)
    nulls = []
    for _ in range(NULL_N):
        nulls.append(darkness((rng.uniform(-180, 180), scale,
                               rng.uniform(u0 + 300, u1 - 300),
                               rng.uniform(v0 + 300, v1 - 300)), step=2.0))
    nulls = np.array(nulls)
    nmean, nsd = float(nulls.mean()), float(nulls.std())
    zfit = (prim["darkness"] - nmean) / max(1e-9, nsd)
    print("null: %d random placements inside the plan score %.3f +- %.3f "
          "(max %.3f); the fit is %.3f, z = %.1f"
          % (NULL_N, nmean, nsd, float(nulls.max()), prim["darkness"], zfit))
    floor = cfg.get("min_darkness", MIN_DARKNESS)
    if prim["darkness"] < floor or zfit < MIN_DARK_Z:
        sys.exit("the fit is not distinguishable from a random placement - refusing")

    # ---- pick the orthophoto that covers this sheet ----
    def ortho_for(A, px):
        cor = [(px[0], px[1]), (px[2], px[1]), (px[0], px[3]), (px[2], px[3])]
        xs = [A["a"] * u + A["b"] * v + A["c"] for u, v in cor]
        ys = [A["d"] * u + A["e"] * v + A["f"] for u, v in cor]
        cx, cy = 0.5 * (min(xs) + max(xs)), 0.5 * (min(ys) + max(ys))
        for nm in ORTHOS:
            j = json.load(open(os.path.join(ROOT, "data", "%s.json" % nm)))
            if (j["x0"] + 100 < cx < j["x1"] - 100
                    and j["y0"] + 100 < cy < j["y1"] - 100):
                return nm, j
        sys.exit("no orthophoto covers this sheet")

    oname, oj = ortho_for(prim["affine"], prim["px"])
    O = np.asarray(Image.open(os.path.join(ROOT, "data", "%s.jpg" % oname))
                   .convert("L")).astype(np.float32)
    print("independent check against %s (%.2f ft/px)"
          % (oname, (oj["x1"] - oj["x0"]) / O.shape[1]))

    # ---- 4. ortho correlation, in GROUND units at the ortho's resolution ----
    def ortho_check(A, px, label):
        r = ortho_ncc(A, px, grey, O, oj, np)
        print("%-9s ortho: ncc %.3f at the fit, peak %.3f (ratio %.1f) at a shift "
              "of %.2f ft" % (label, r["ncc_at_fit"], r["ncc_peak"], r["ratio"],
                              r["agree_ft"]))
        return r

    for key, vp in vps.items():
        vp["ortho"] = ortho_check(vp["affine"], vp["px"], key)
        if (vp["ortho"]["ncc_peak"] < MIN_ORTHO_NCC
                or vp["ortho"]["ratio"] < MIN_ORTHO_RATIO
                or vp["ortho"]["agree_ft"] > MAX_AGREE_FT):
            sys.exit("%s viewport: the orthophoto does not confirm the polygon "
                     "fit - refusing" % key)

    # ---- 3c. the ambiguity table ----
    def short(nm):
        """A column name for a confirmation feature: its first distinctive word."""
        w = [t for t in nm.replace("(", " ").replace(")", " ").split()
             if t.lower() not in ("the", "of", "and", "area", "route")]
        return (w[0] if w else nm)[:10].lower()
    amb = []
    if rivals or confirm:
        def row(theta, tu, tv, lbl):
            p = (theta, scale, tu, tv)
            e = dict(rot_deg=round(theta, 3), label=lbl,
                     darkness=round(darkness(p), 4))
            for nm in sorted(set(n for _, _, n in confirm)):
                sel = [(a, b, c) for a, b, c in confirm if c == nm]
                e[short(nm)] = round(darkness(p, sel), 4)
            A = dict(affine_of(dict(tu=tu, tv=tv), theta))
            o = ortho_ncc(A, prim["px"], grey, O, oj, np)
            e["ortho_peak"] = o["ncc_peak"]
            e["ortho_agree_ft"] = o["agree_ft"]
            return e
        amb.append(row(rot, prim["tu"], prim["tv"], "accepted"))
        for r in rivals:
            pk = peak_at(r, 1)[0]
            t, _ = solve_t(r, [float(pk[0]), float(pk[1])])
            amb.append(row(r, float(t[0]), float(t[1]), "rival"))
        keys = [k for k in amb[0] if k not in ("rot_deg", "label")]
        print("\nambiguity / confirmation table. The accepted rotation must win "
              "EVERY column, and the orthophoto - which is the independent "
              "method, and knows nothing of any of this geometry - must separate "
              "it from every rival by %.1fx." % MIN_CONFIRM_MARGIN)
        w = max(12, min(20, max(len(k) for k in keys) + 2))
        print("  %-9s %-9s %s" % ("rot", "label",
              "".join(("%-" + str(w) + "s") % k for k in keys)))
        for e in amb:
            print("  %-+9.1f %-9s %s"
                  % (e["rot_deg"], e["label"],
                     "".join(("%-" + str(w) + "s") % ("%.4f" % e[k]) for k in keys)))
        print()
        for k in keys:
            v0_ = amb[0][k]
            for e in amb[1:]:
                better = e[k] < v0_ if k == "ortho_agree_ft" else e[k] > v0_
                if better:
                    sys.exit("the rival at %+.1f beats the accepted rotation on %s "
                             "(%.4f vs %.4f) - refusing"
                             % (e["rot_deg"], k, e[k], v0_))
        for e in amb[1:]:
            if not (amb[0]["ortho_peak"] > e["ortho_peak"] * MIN_CONFIRM_MARGIN
                    and (e["ortho_agree_ft"] > amb[0]["ortho_agree_ft"] * MIN_CONFIRM_MARGIN
                         or e["ortho_agree_ft"] - amb[0]["ortho_agree_ft"] > 5.0)):
                sys.exit("the orthophoto does not separate the rival at %+.1f - refusing"
                         % e["rot_deg"])
        if rivals:
            print("the accepted rotation wins every column - the %d-fold ambiguity "
                  "is broken by geometry that took no part in the fit AND, "
                  "independently, by the orthophoto\n" % (1 + len(rivals)))

    # ---- the primary viewport's north-up crop ----
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
    if cfg.get("crop_mask") == "plan" and prim.get("_mask"):
        # the aerial does not fill its own rectangle on every sheet (C-203's is
        # cut off diagonally), and white paper drawn over the map is worse than
        # nothing. Knock out anything outside the plan's own colour component.
        pm, d8 = prim["_mask"]
        # FILL the component first. It is the aerial's own colour, and a dark
        # tree crown, a shadow or a white label box inside the photograph is
        # not coloured - used raw it punches holes through the middle of the
        # overlay. What is wanted is the plan's OUTLINE, which is what filling
        # and then dilating gives.
        pm = ndimage.binary_dilation(ndimage.binary_fill_holes(pm), iterations=3)
        mm = ndimage.map_coordinates(pm.astype(np.float32),
                                     [V / d8, U / d8], order=1,
                                     mode="constant", cval=0.0)
        inside = inside & (mm > 0.5)
    chans = [ndimage.map_coordinates(sheet_rgb[..., k], [V, U], order=1,
                                     mode="constant", cval=255.0)
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
    nfeat = len(set(nm for _, _, nm in control if nm != "grid"))
    nnat = sum(len(p) for p, _, nm in control if nm != "grid")
    what = ("polygon '%s' (%d vertices)" % (cfg["features"][0], nnat) if nfeat == 1
            else "polygons %s (%d vertices in all)"
                 % (", ".join("'%s'" % f for f in cfg["features"]), nnat))
    if gridspec:
        what += (" together with the %g ft cell grid the sheet's own work sequence "
                 "specifies inside it (%d control vertices in all)"
                 % (gridspec["cell_ft"], len(allp)))
    how = ("native-geometry fit: EA's geodatabase %s matched to the heavy linework "
           "of the plan with rotation locked to the drafting angle and scale to the "
           "sheet's %s%s; confirmed by independent ortho correlation against %s "
           "(tools/register_sheet_native.py)"
           % (what, cfg["scale_name"],
              "; the %d rival rotations its symmetry allows were refined and scored "
              "beside it (see `ambiguity`)" % len(rivals) if rivals else "",
              oname))
    rec = dict(
        page=cfg["page"], sheet=name, subject=cfg["subject"],
        design_set=cfg["design_set"],
        scale_ft_per_pt=round(sx, 5), rot_deg=rot, sx=sx, sy=sx,
        nodes_used=len(allp), nodes_total=len(cfg["nodes"]),
        resid_med_ft=round(prim["resid_med"], 2),
        resid_max_ft=round(prim["resid_max"], 2),
        method=how,
        native_feature=cfg["features"][0] if nfeat == 1 else cfg["features"],
        free_scale_pct=round(100 * (free_scale / S0 - 1), 3),
        darkness=round(prim["darkness"], 3),
        darkness_null=dict(n=NULL_N, mean=round(nmean, 3), sd=round(nsd, 3),
                           z=round(zfit, 1)),
        ortho_source=oname,
        ortho_peak=prim["ortho"]["ncc_peak"],
        ortho_agree_ft=prim["ortho"]["agree_ft"],
        viewports=[dict(name=vp["name"], primary=bool(vp.get("primary")), px=vp["px"],
                        darkness=round(vp["darkness"], 3),
                        resid_med_ft=round(vp["resid_med"], 2),
                        resid_max_ft=round(vp["resid_max"], 2),
                        per_feature=vp["per_feature"],
                        free_fit=dict(rot_deg=round(vp["free"]["rot"], 4),
                                      scale_ft_per_px=round(vp["free"]["scale"], 6)),
                        ortho=dict(ncc_at_fit=vp["ortho"]["ncc_at_fit"],
                                   ncc_peak=vp["ortho"]["ncc_peak"],
                                   ratio=vp["ortho"]["ratio"],
                                   shift_ft=vp["ortho"]["shift_ft"],
                                   agree_ft=vp["ortho"]["agree_ft"]))
                   for vp in vps.values()],
        raster=dict(page=cfg["page"], file=png_name, x0=float(x0), y0=float(y0),
                    x1=float(x1), y1=float(y1), ft_per_px=fpp, w=cw, h=ch, bytes=None),
    )
    if amb:
        rec["ambiguity"] = amb
    node_feats = [dict(type="Feature",
                       properties=dict(sheet=name, subject=cfg["subject"],
                                       design_set=cfg["design_set"],
                                       page=cfg["page"],
                                       name="%s (%s) node %d" % (name, cfg["subject"], nd["pt"]),
                                       kind="node", confidence="surveyed", pt=nd["pt"]),
                       geometry=dict(type="Point", coordinates=[nd["e"], nd["n"]]))
                  for nd in cfg["nodes"]]
    # any printed node must be a vertex of the native geometry - that is the
    # whole premise. A sheet that prints nothing says so instead.
    if cfg["nodes"]:
        for nd in cfg["nodes"]:
            dmin = float(np.hypot(allp[:, 0] - nd["e"], allp[:, 1] - nd["n"]).min())
            print("printed node %d is %.2f ft from the nearest native vertex"
                  % (nd["pt"], dmin))
            if dmin > 0.5:
                sys.exit("printed node %d is not on the native geometry - wrong feature?"
                         % nd["pt"])
    else:
        print("this sheet prints no coordinate table; the native geometry is the "
              "only ground control there has ever been for it")

    def rnd(A):
        return dict(a=round(A["a"], 9), b=round(A["b"], 9), c=round(A["c"], 4),
                    d=round(A["d"], 9), e=round(A["e"], 9), f=round(A["f"], 4))
    aff = dict(rnd(prim["affine"]), ft_per_px=round(scale, 6), rot_deg=-rot,
               ncc=prim["ortho"]["ncc_peak"], signal="native polygon",
               roundtrip_ft=0.0,
               gis_check=dict(n=len(allp), inside_pct=100),
               method=("native-geometry fit of EA's %s to the plan linework, rotation "
                       "locked to the drafting angle and scale to the sheet's %s, "
                       "confirmed by independent ortho correlation against %s "
                       "(agree %.2f ft); see tools/register_sheet_native.py"
                       % (", ".join("'%s'" % f for f in cfg["features"]),
                          cfg["scale_name"], oname, prim["ortho"]["agree_ft"])))
    viewports = [dict(name=vp["name"], primary=bool(vp.get("primary")), px=vp["px"],
                      affine=dict(rnd(vp["affine"]), ft_per_px=round(scale, 6),
                                  rot_deg=-rot))
                 for vp in vps.values()]

    if args.dry_run:
        print("(dry run - nothing written)")
        return

    Image.fromarray(crop, "RGBA").save(png_path, optimize=True)
    rec["raster"]["bytes"] = os.path.getsize(png_path)

    ea_path = os.path.join(ROOT, "data", "design_ea.json")
    ea = json.load(open(ea_path))
    ea["sheets"][name] = rec
    ea["features"] = [f for f in ea["features"]
                      if not ((f.get("properties") or {}).get("sheet") == name
                              and (f.get("properties") or {}).get("kind") == "node")] + node_feats
    ea["registration"] = retail(ea.get("registration", ""), set(ea["sheets"]))
    # design_ea.json is stored compact (one line) - keep it that way so the diff
    # is the change
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
    print("now: python tools/build_data.py, and add datajs/i_design_%s_png.js to "
          "index.html" % tag)


NATIVE_TAIL = (" C-202, C-102 and C-203 were placed from EA's native geodatabase "
               "geometry (tools/register_sheet_native.py) - C-202's two plan "
               "viewports solved separately, C-102 from five polygons fitted "
               "together, C-203 from the borrow rectangle and the 15 ft cell grid "
               "the sheet specifies inside it with the 180 deg ambiguity broken by "
               "the haul route and the orthophoto. C-101, a site index sheet with "
               "no unique geometry of its own, remains unregistered.")


def retail(text, placed):
    """Rewrite the trailing 'what is still unplaced' sentence of the record."""
    for cut in ("C-202 was placed from EA's native geodatabase polygon",
                " C-202, C-102 and C-203 were placed"):
        i = text.find(cut)
        if i >= 0:
            text = text[:i].rstrip()
            break
    else:
        i = text.find("C-101, C-102 and C-202 remain unregistered.")
        if i >= 0:
            text = text[:i].rstrip()
    return text + NATIVE_TAIL


def ortho_ncc(A, px, grey, O, oj, np, fpp=1.0, sigma_ft=12.0, rng_ft=20.0):
    """Correlate the sheet's embedded aerial against the app orthophoto, in
    GROUND units at 1 ft/px. Returns the peak and how far it moves the sheet.

    Scoring in ground units rather than sheet pixels is what makes the number
    comparable between sheets drawn at 1 in = 10 ft and 1 in = 50 ft, and what
    lets --calibrate put the twelve already-registered sheets through exactly
    this check.
    """
    import math as _m
    from scipy import ndimage
    u0, v0, u1, v1 = px
    oh, ow = O.shape
    ofx = (oj["x1"] - oj["x0"]) / ow
    ofy = (oj["y1"] - oj["y0"]) / oh
    cor = [(u0, v0), (u1, v0), (u0, v1), (u1, v1)]
    xs = [A["a"] * u + A["b"] * v + A["c"] for u, v in cor]
    ys = [A["d"] * u + A["e"] * v + A["f"] for u, v in cor]
    pad = rng_ft + 4
    x0 = max(min(xs), oj["x0"] + pad); x1 = min(max(xs), oj["x1"] - pad)
    y0 = max(min(ys), oj["y0"] + pad); y1 = min(max(ys), oj["y1"] - pad)
    if x1 <= x0 or y1 <= y0:
        return dict(ncc_at_fit=0.0, ncc_peak=0.0, ratio=0.0, shift_ft=[0, 0],
                    agree_ft=999.0)
    cw = int((x1 - x0) / fpp); ch = int((y1 - y0) / fpp)
    gx = x0 + (np.arange(cw) + 0.5) * fpp
    gy = y1 - (np.arange(ch) + 0.5) * fpp
    GX, GY = np.meshgrid(gx, gy)
    det = A["a"] * A["e"] - A["b"] * A["d"]
    dxg, dyg = GX - A["c"], GY - A["f"]
    U = (A["e"] * dxg - A["b"] * dyg) / det
    V = (A["a"] * dyg - A["d"] * dxg) / det
    inside = (U >= u0 + 8) & (U <= u1 - 8) & (V >= v0 + 8) & (V <= v1 - 8)
    SH = ndimage.map_coordinates(grey, [V, U], order=1, mode="constant", cval=255.0)
    REN = ndimage.map_coordinates(O, [(oj["y1"] - GY) / ofy, (GX - oj["x0"]) / ofx],
                                  order=1, mode="constant", cval=np.nan)
    ok = inside & np.isfinite(REN) & (SH > 60) & (SH < 250)  # aerial mid-tones only
    if ok.sum() < 5000:
        return dict(ncc_at_fit=0.0, ncc_peak=0.0, ratio=0.0, shift_ft=[0, 0],
                    agree_ft=999.0)
    sig = sigma_ft / fpp
    rr = int(round(rng_ft / fpp))

    def hp(a):
        a = np.where(ok, a, float(a[ok].mean()))
        return np.where(ok, a - ndimage.gaussian_filter(a, sig), 0.0)
    Aim, Bim = hp(SH), hp(REN)
    m = rr + 2

    def ncc(dx, dy):
        a = Aim[m:-m, m:-m]
        b = Bim[m + dy:Bim.shape[0] - m + dy, m + dx:Bim.shape[1] - m + dx]
        a = a - a.mean(); b = b - b.mean()
        den = _m.sqrt(float((a * a).sum()) * float((b * b).sum()))
        return float((a * b).sum() / den) if den else 0.0
    n0 = ncc(0, 0)
    best = (-1.0, 0, 0)
    vals = []
    for dy in range(-rr, rr + 1):
        for dx in range(-rr, rr + 1):
            c = ncc(dx, dy)
            vals.append(c)
            if c > best[0]:
                best = (c, dx, dy)
    vals = np.array(vals)
    ratio = best[0] / max(1e-9, float(np.percentile(np.abs(vals), 50)))
    return dict(ncc_at_fit=round(n0, 3), ncc_peak=round(best[0], 3),
                ratio=round(ratio, 2),
                shift_ft=[round(best[1] * fpp, 2), round(best[2] * fpp, 2)],
                agree_ft=round(_m.hypot(best[1], best[2]) * fpp, 2))


def calibrate():
    """The ortho check, run over every sheet that is already registered.

    This is the "calibrate on the sheets whose answer is known first" rule made
    runnable: a candidate is accepted only where its agreement sits in the class
    these sheets define.
    """
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    sf = json.load(open(os.path.join(ROOT, "data", "sheets_full.json")))
    O = np.asarray(Image.open(os.path.join(ROOT, "data", "ortho_site.jpg"))
                   .convert("L")).astype(np.float32)
    oj = json.load(open(os.path.join(ROOT, "data", "ortho_site.json")))
    from scipy import ndimage
    print("%-7s %8s %8s %8s %9s" % ("sheet", "ncc@fit", "peak", "ratio", "agree ft"))
    worst = 0.0
    for s in sf["sheets"]:
        if not s.get("affine"):
            continue
        tag = s["sheet"].replace("-", "")
        p = os.path.join(ROOT, "data", "design", "sheet_full_%s.jpg" % tag)
        rgb = np.asarray(Image.open(p).convert("RGB")).astype(np.float32)
        grey = rgb.mean(axis=2)
        sat = rgb.max(axis=2) - rgb.min(axis=2)
        d8 = 8
        h8, w8 = grey.shape[0] // d8, grey.shape[1] // d8
        s8 = sat[:h8 * d8, :w8 * d8].reshape(h8, d8, w8, d8).mean(axis=(1, 3))
        m = ndimage.binary_opening(ndimage.binary_closing(s8 > 12, iterations=4),
                                   iterations=3)
        lab, n = ndimage.label(m)
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        k = int(np.argmax(sizes)) + 1
        ys, xs = np.where(lab == k)
        px = [int(xs.min() * d8), int(ys.min() * d8),
              int((xs.max() + 1) * d8), int((ys.max() + 1) * d8)]
        r = ortho_ncc(s["affine"], px, grey, O, oj, np)
        worst = max(worst, r["agree_ft"])
        print("%-7s %8.3f %8.3f %8.2f %9.2f"
              % (s["sheet"], r["ncc_at_fit"], r["ncc_peak"], r["ratio"], r["agree_ft"]))
    print("worst agreement over the already-registered sheets: %.2f ft "
          "(MAX_AGREE_FT is %.1f)" % (worst, MAX_AGREE_FT))


if __name__ == "__main__":
    main()
