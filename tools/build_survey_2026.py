#!/usr/bin/env python3
"""Extract the August-2026 Jacobs limited topographic survey from its PDF plot.

Source: docs/Sulphur Bank Mine - Additional- (1).pdf — one 34x22 sheet, a CAD plot
(vector linework, not a scan) at 1 in = 8 ft with a 1 in = 16 ft inset of the
Northwest Pit. Datum CCS83 zone 2 USSF / NAVD88, i.e. the app's own CRS. It
carries five tabulated survey points (Appendix 1 of the report, copied into
TABULATED below) and a plot of everything else that was shot: the sandbag wall
(top and toe), the two 24-inch corrugated HDPE discharge pipes and their
inverts, the Northwest Pit low with spot elevations and contours, the staff
gauge, and two "shore (water ends)" marks on the Herman Impoundment.

Georeferencing
--------------
The sheet has no coordinate grid, but it does not need one: it is a CAD plot at
a known scale, north up, and the tabulated points are drawn on it as vectors.
Each plan viewport is solved on its own with the scale LOCKED to the plan scale
(9 pt/ft on the main plan, 4.5 pt/ft on the pit inset) and rotation locked to
0, leaving only a translation, which the tabulated points fix:

  viewport A (main plan)  control = pipe N invert, pipe S invert, water level
                          residuals 0.01 ft; the pipe pair reproduces the
                          scale to 9.000 pt/ft and the pipe-to-water distance
                          to 0.01 %
  viewport B (pit inset)  control = staff gauge, lowest ground
                          residuals 0.02 ft; scale from the pair 4.499 pt/ft

A free rotation sweep on either viewport returns 0.00 +/- 0.02 deg, which is the
independent check: three (two) surveyed points and the plan scale agree.

What comes out
--------------
  data/datasets/survey_2026_points.csv   every shot as a row (tabulated ones
                                         verbatim; plot-derived ones flagged)
  data/survey_2026.json                  the linework as a FeatureCollection in
                                         the design_gis.json layer schema
Then:  python tools/add_dataset.py data/datasets/survey_2026_points.csv \
           --name "Survey — Aug 2026 (Jacobs)" --id survey_2026 --x easting \
           --y northing --id-col id --color "#FF9F1C"
       python tools/build_data.py

Labels are text-as-outlines on the sheet (no text layer), so the elevation
beside each circle was read off the plot by eye and is keyed here by the
circle's drawing index (LABELS). Re-check that table against the plot if the
PDF is ever re-issued. Needs: pymupdf, numpy.
"""
import csv
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, "docs", "Sulphur Bank Mine - Additional- (1).pdf")
OUT_JSON = os.path.join(ROOT, "data", "survey_2026.json")
OUT_CSV = os.path.join(ROOT, "data", "datasets", "survey_2026_points.csv")

# Appendix 1 of the survey report, verbatim (northing, easting, elevation, ft).
TABULATED = [
    ("Gauge", "Staff gauge at NW Pit", "Center of the 1.0-foot graduation mark", 2128869.80, 6371830.65, 1344.90, "NW Pit"),
    ("Lowest Ground", "NW Pit ground shot", "Lowest ground shot", 2128782.35, 6371833.75, 1339.03, "NW Pit"),
    ("Water Level", "Water level at the Herman Impoundment", "Top of water", 2127446.20, 6372119.56, 1336.45, "Herman Impoundment"),
    ("SD PIPE N", "Corrugated HDPE pipe (North), 24 in", "Invert", 2127486.62, 6372041.23, 1341.57, "Herman Impoundment"),
    ("SD PIPE S", "Corrugated HDPE pipe (South), 24 in", "Invert", 2127483.07, 6372041.80, 1341.53, "Herman Impoundment"),
]

# Plot labels keyed by the circle's index in page.get_drawings() (see the
# module docstring). Wall: kind + elevation. Pit: elevation.
LABELS_WALL = {144: ("Top of sand bags", 1343.57), 217: ("Toe", 1343.4), 226: ("Toe", 1343.0),
               160: ("Top of sand bags", 1343.54), 234: ("Toe", 1343.0), 208: ("Toe", 1342.6),
               176: ("Top of sand bags", 1343.65), 192: ("Top of sand bags", 1344.25)}
LABELS_PIT = {560: 1340.9, 553: 1339.5, 511: 1339.03, 546: 1339.5, 574: 1341.0, 518: 1340.1,
              525: 1340.0, 532: 1341.8, 567: 1341.9, 581: 1342.4, 539: 1341.8}
LOWEST_CIRCLE = 511          # the "1339.03 OG (LOWEST)" shot = the tabulated Lowest Ground
# drawing indices of the linework (identified by weight, extent and position)
PIPE_N, PIPE_S = 130, 129    # the two long parallel lines ending at the wall
WALL_HEAVY = (123, 128, 127, 132, 131)                 # 0.72-pt outline / crest lines
WALL_THIN = (138, 136, 137, 139, 133, 134, 140, 142)   # 0.12-pt surveyed contours
PIT_HEAVY = ((437, "NW Pit low area — surveyed outline"),
             (439, "NW Pit — surveyed contour (heavy)"),
             (438, "NW Pit — lowest contour (closed)"))
PIT_THIN = (446, 444, 441, 442, 448, 449, 440, 443, 445, 450, 447, 451)
GAUGE_POLY = 452             # the hourglass symbol's outline; its bbox centre is the shot
X_MARKS = ((0, 1), (38, 39))  # the two "SHORE (WATER ENDS)" X marks, as line pairs
SCALE_A, SCALE_B = 9.0, 4.5  # pt per ft: 1 in = 8 ft, 1 in = 16 ft
PLOT_TOL_NOTE = "plot-derived (georeferenced sheet, ±0.1 ft)"

LAYERS = [
    dict(key="survey_pipe", name="Discharge pipes — 24 in HDPE (surveyed)", group="survey", color="#FFD34D", kind="line"),
    dict(key="survey_wall", name="Sandbag wall — surveyed outline", group="survey", color="#FF9F1C", kind="line"),
    dict(key="survey_wall_contour", name="Sandbag wall — surveyed contours", group="survey", color="#C98A3A", kind="line"),
    dict(key="survey_pit", name="NW Pit low — surveyed outline", group="survey", color="#FF9F1C", kind="line"),
    dict(key="survey_pit_contour", name="NW Pit low — surveyed contours", group="survey", color="#C98A3A", kind="line"),
]
PROV = "Jacobs, Additional Limited Topographic Survey, Aug 2026 (docs/Sulphur Bank Mine - Additional- (1).pdf)"


def main():
    import numpy as np
    import pymupdf

    doc = pymupdf.open(PDF)
    page = doc[0]
    M = page.rotation_matrix          # unrotated drawing space -> the sheet as displayed

    def disp(pt):
        q = pymupdf.Point(pt) * M
        return (q.x, q.y)

    drawings = page.get_drawings()
    circles, polys, lines = {}, {}, {}
    for k, dr in enumerate(drawings):
        items = dr["items"]
        types = [it[0] for it in items]
        r = dr["rect"]
        if types and all(t == "c" for t in types) and len(types) >= 4 and r.width < 30 and abs(r.width - r.height) < 1:
            circles[k] = disp(((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
        elif types and all(t == "l" for t in types):
            pts = [disp(items[0][1])] + [disp(it[2]) for it in items]
            (polys if len(items) >= 3 else lines)[k] = pts
    if len(circles) != 19:
        sys.exit("expected 19 survey circles on the plot, found %d — the PDF changed; re-check LABELS" % len(circles))

    # ---- control points on the page ----
    pipe_n_end = lines[PIPE_N][0]
    pipe_s_end = lines[PIPE_S][0]
    xs = [((lines[a][0][0] + lines[a][1][0] + lines[b][0][0] + lines[b][1][0]) / 4,
           (lines[a][0][1] + lines[a][1][1] + lines[b][0][1] + lines[b][1][1]) / 4) for a, b in X_MARKS]
    g = polys[GAUGE_POLY]
    gauge = ((min(p[0] for p in g) + max(p[0] for p in g)) / 2, (min(p[1] for p in g) + max(p[1] for p in g)) / 2)
    tab = {t[0]: t for t in TABULATED}

    def solve(ctrl, s):
        cx = np.mean([X - u / s for (u, v), (X, Y) in ctrl])
        fy = np.mean([Y + v / s for (u, v), (X, Y) in ctrl])
        res = max(math.hypot(u / s + cx - X, -v / s + fy - Y) for (u, v), (X, Y) in ctrl)
        return cx, fy, res

    ctrlA = [(pipe_n_end, (tab["SD PIPE N"][4], tab["SD PIPE N"][3])),
             (pipe_s_end, (tab["SD PIPE S"][4], tab["SD PIPE S"][3])),
             (xs[0], (tab["Water Level"][4], tab["Water Level"][3]))]
    ctrlB = [(gauge, (tab["Gauge"][4], tab["Gauge"][3])),
             (circles[LOWEST_CIRCLE], (tab["Lowest Ground"][4], tab["Lowest Ground"][3]))]
    cxA, fyA, resA = solve(ctrlA, SCALE_A)
    cxB, fyB, resB = solve(ctrlB, SCALE_B)
    # scale check from the control pairs themselves
    sA = math.hypot(pipe_n_end[0] - xs[0][0], pipe_n_end[1] - xs[0][1]) / math.hypot(
        tab["SD PIPE N"][4] - tab["Water Level"][4], tab["SD PIPE N"][3] - tab["Water Level"][3])
    sB = math.hypot(gauge[0] - circles[LOWEST_CIRCLE][0], gauge[1] - circles[LOWEST_CIRCLE][1]) / math.hypot(
        tab["Gauge"][4] - tab["Lowest Ground"][4], tab["Gauge"][3] - tab["Lowest Ground"][3])
    print("viewport A: %.4f pt/ft from the control pair (locked %.1f), worst residual %.2f ft" % (sA, SCALE_A, resA))
    print("viewport B: %.4f pt/ft from the control pair (locked %.1f), worst residual %.2f ft" % (sB, SCALE_B, resB))
    if resA > 0.1 or resB > 0.1 or abs(sA / SCALE_A - 1) > 0.002 or abs(sB / SCALE_B - 1) > 0.002:
        sys.exit("registration does not close — refusing to write")

    def spA(p): return (round(p[0] / SCALE_A + cxA, 2), round(-p[1] / SCALE_A + fyA, 2))
    def spB(p): return (round(p[0] / SCALE_B + cxB, 2), round(-p[1] / SCALE_B + fyB, 2))

    # ---- points ----
    rows = []
    for n, desc, mo, N, E, Z, area in TABULATED:
        rows.append(dict(id=n, description=desc, measure_on=mo, northing=N, easting=E, elevation=Z,
                         area=area, source="tabulated (Appendix 1)"))
    for k, (kind, z) in LABELS_WALL.items():
        x, y = spA(circles[k])
        rows.append(dict(id="SB-%d" % k, description="Sandbag wall — %s" % kind.lower(), measure_on=kind,
                         northing=y, easting=x, elevation=z, area="Sandbag wall", source=PLOT_TOL_NOTE))
    for k, z in LABELS_PIT.items():
        if k == LOWEST_CIRCLE:
            continue
        x, y = spB(circles[k])
        rows.append(dict(id="NWP-%d" % k, description="NW Pit spot elevation", measure_on="Ground",
                         northing=y, easting=x, elevation=z, area="NW Pit", source=PLOT_TOL_NOTE))
    x, y = spA(xs[1])
    rows.append(dict(id="Shore 2", description="Shore (water ends) at the Herman Impoundment", measure_on="Top of water",
                     northing=y, easting=x, elevation=1336.44, area="Herman Impoundment", source=PLOT_TOL_NOTE))

    # ---- lines ----
    feats = []

    def add(layer, name, coords, props=None):
        pr = dict(props or {})
        pr.update(name=name, layer=layer, provenance=PROV)
        feats.append(dict(type="Feature", properties=pr, geometry=dict(type="LineString", coordinates=[list(c) for c in coords])))

    note = "invert surveyed at the wall end; the west end is the plotted extent, not a surveyed point"
    add("survey_pipe", "24 in corrugated HDPE pipe (North)", [spA(p) for p in reversed(lines[PIPE_N])],
        dict(invert_ft=1341.57, size_in=24, material="corrugated HDPE", note=note))
    add("survey_pipe", "24 in corrugated HDPE pipe (South)", [spA(p) for p in reversed(lines[PIPE_S])],
        dict(invert_ft=1341.53, size_in=24, material="corrugated HDPE", note=note))
    for k in WALL_HEAVY:
        add("survey_wall", "Sandbag wall (surveyed outline)", [spA(p) for p in polys[k]])
    for k in WALL_THIN:
        add("survey_wall_contour", "Sandbag wall — surveyed contour (unlabelled)", [spA(p) for p in polys[k]])
    for k, nm in PIT_HEAVY:
        add("survey_pit", nm, [spB(p) for p in polys[k]])
    for k in PIT_THIN:
        add("survey_pit_contour", "NW Pit — surveyed contour (unlabelled)", [spB(p) for p in polys[k]])
    for l in LAYERS:
        l["count"] = sum(1 for f in feats if f["properties"]["layer"] == l["key"])
        l["provenance"] = PROV

    out = dict(
        source=PROV,
        crs="EPSG:6418 (NAD83 CA zone 2, US survey ft); sheet datum CCS83 zone 2 USSF / NAVD88",
        registration=dict(
            method="vector plot georeferenced by its own tabulated survey points; scale locked to the plan scale, rotation 0 (north up)",
            viewportA=dict(scale_pt_per_ft=SCALE_A, control=["SD PIPE N", "SD PIPE S", "Water Level"],
                           scale_from_pair=round(sA, 4), resid_ft=round(resA, 3)),
            viewportB=dict(scale_pt_per_ft=SCALE_B, control=["Gauge", "Lowest Ground"],
                           scale_from_pair=round(sB, 4), resid_ft=round(resB, 3))),
        layers=LAYERS, features=feats)
    with open(OUT_JSON, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    with open(OUT_CSV, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["id", "description", "measure_on", "northing", "easting", "elevation", "area", "source"])
        w.writeheader()
        w.writerows(rows)
    print("wrote %s (%d line features) and %s (%d points)" % (OUT_JSON, len(feats), OUT_CSV, len(rows)))


if __name__ == "__main__":
    main()
