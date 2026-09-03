#!/usr/bin/env python3
"""Flag every PDF-derived design boundary that the native geometry supersedes.

Run after tools/build_design_gis.py.  For each Polygon feature in
data/design_ea.json it finds the best-overlapping native polygon in
data/design_gis.json and, above an IoU threshold, records:

    superseded_by      the native feature's name
    superseded_iou     the overlap
    superseded_off_ft  centroid separation, ft

That last number is the independent check on the v6/A sheet registrations: the
PDF boundary was placed from the sheet's own printed node table, the native
polygon comes from EA's geodatabase, and nothing links the two.  Boundaries with
no native counterpart keep their PDF provenance and are left alone.
"""
import json, collections
from shapely.geometry import shape
from shapely import make_valid

def V(g):
    g = make_valid(g)
    return g.buffer(0) if not g.is_valid else g

ea = json.load(open("data/design_ea.json"))
gis = json.load(open("data/design_gis.json"))

nat = []
for f in gis["features"]:
    if f["geometry"]["type"] != "Polygon":
        continue
    p = f["properties"]
    if p.get("layer") not in ("exc", "repo", "staging"):
        continue
    nat.append((p.get("name"), V(shape(f["geometry"]))))

per_sheet = collections.defaultdict(list)
n = 0
for f in ea["features"]:
    if f["geometry"]["type"] != "Polygon":
        continue
    g = V(shape(f["geometry"]))
    best = (0.0, None, None)
    for nm, ng in nat:
        try:
            u = g.union(ng).area
            iou = g.intersection(ng).area / u if u else 0.0
        except Exception:
            iou = 0.0
        if iou > best[0]:
            best = (iou, nm, ng)
    iou, nm, ng = best
    pr = f["properties"]
    if iou >= 0.5:
        off = g.centroid.distance(ng.centroid)
        pr["superseded_by"] = nm
        pr["superseded_iou"] = round(iou, 3)
        pr["superseded_off_ft"] = round(off, 2)
        per_sheet[pr.get("sheet")].append(off)
        n += 1
    else:
        pr.pop("superseded_by", None)
        pr.pop("superseded_iou", None)
        pr.pop("superseded_off_ft", None)

ea["supersession"] = (
    "Native EA geometry (data/design_gis.json) is the authority. Each boundary "
    "below that carries superseded_by was matched to a native polygon; "
    "superseded_off_ft is the centroid separation between the PDF registration "
    "and the native geometry, which is an independent check on the registration.")
json.dump(ea, open("data/design_ea.json", "w"), separators=(",", ":"))

print(f"{n} PDF boundaries superseded by native geometry\n")
print(f"{'sheet':8s} {'n':>3s} {'median_off_ft':>14s} {'max_off_ft':>11s}")
for s in sorted(per_sheet, key=lambda x: (x is None, x)):
    v = sorted(per_sheet[s])
    print(f"{str(s):8s} {len(v):3d} {v[len(v)//2]:14.2f} {max(v):11.2f}")
