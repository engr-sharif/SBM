#!/usr/bin/env python3
"""Build data/design_gis.json — the EA residential Final Design NATIVE geometry.

This supersedes the PDF-derived extraction in data/design_ea.json wherever the
two overlap.  Two native sources, both delivered by EA in June 2026:

  GIS   "1578546 - Sulphur Bank Mercury Mine - GIS.zip"
        -> 15785_46_0079/GeospatialData/SBMM_ResidentialRD.gdb
        An Esri file geodatabase (ArcGIS Pro 3.6.2).  Authoritative design
        polygons: limits of excavation, repository, stockpiles, staging and
        borrow areas, haul routes, Elem Indian Colony lots, operable units.

  CAD   "1578546 - Sulphur Bank Mercury Mine - FINAL DESIGN.zip"
        -> External References/1578546 - C-BASE.dwg  (civil design base)
        -> External References/1578546 - V-Base.dwg  (existing-conditions base)
        Converted DWG -> DXF with libredwg git master (dwg2dxf 0.14.x).  The
        released 0.13.3 cannot decode these Civil 3D 2018+ drawings.

CRS
---
Every design layer in the geodatabase carries EPSG:2226 (NAD83 / California
zone 2, US survey feet).  The app works in EPSG:6418 (NAD83(2011), same zone
and units).  These are different realisations of NAD83 and are NOT identical in
general, so the frames were checked empirically rather than assumed: each
native limit-of-excavation polygon was compared against the independently
registered PDF sheet boundary for the same area (11 sheets registered in v6/A
from the sheets' own printed State Plane node tables).  Every registered sheet
agreed to 0.3-1.8 ft, which is inside the registration's own residual budget.
The two frames are therefore treated as coincident for this site and NO
reprojection is applied.  If a future deliverable disagrees by more than a
couple of feet, that conclusion has to be revisited -- do not silently reproject.

Cultural resources
------------------
The geodatabase also contains T22_0762_IsolateCurrent (19 points) and
T22_0762_ResourceCurrentPly (44 polygons) in EPSG:26910 -- an archaeological
survey of the Elem Indian Colony: recorded resource areas and artefact
isolates.  These are deliberately NOT baked into the app.  Archaeological site
locations are confidential under NHPA s.304 and ARPA s.9, and this app is a
double-click HTML file that gets emailed around.  If they are ever needed, they
should be a separate, access-controlled deliverable and an explicit decision.

Usage
-----
    python tools/build_design_gis.py \
        --gdb  /path/to/SBMM_ResidentialRD.gdb \
        --dxf  /path/to/dir-of-converted-dxf \
        --out  data/design_gis.json

Neither source archive lives in the repo (1.33 GB + 23 MB); like
build_sheet_fulls.py this tool needs files off the user's machine and is not on
the normal build path.  The generated data/design_gis.json IS in the repo.
"""

import argparse, json, math, os, sys, warnings, collections

warnings.filterwarnings("ignore")

import geopandas as gpd
from shapely.geometry import Polygon, LineString, Point, mapping
from shapely import make_valid

# ---------------------------------------------------------------- helpers

def valid(g):
    g = make_valid(g)
    if not g.is_valid:
        g = g.buffer(0)
    return g


def r2(v):
    return round(float(v), 2)


def rings_of(geom):
    """Return list of exterior rings (list of [x,y]) for a (multi)polygon."""
    out = []
    if geom is None or geom.is_empty:
        return out
    gs = geom.geoms if geom.geom_type.startswith("Multi") else [geom]
    for g in gs:
        if g.geom_type != "Polygon":
            continue
        ring = [[r2(c[0]), r2(c[1])] for c in g.exterior.coords]
        if len(ring) >= 4:
            out.append(ring)
    return out


def lines_of(geom):
    out = []
    if geom is None or geom.is_empty:
        return out
    gs = geom.geoms if geom.geom_type.startswith("Multi") else [geom]
    for g in gs:
        if g.geom_type != "LineString":
            continue
        ln = [[r2(c[0]), r2(c[1])] for c in g.coords]
        if len(ln) >= 2:
            out.append(ln)
    return out


# ---------------------------------------------------------------- layer spec
#
# key         payload layer id
# name        what the Layers tab shows
# group       section within the Residential design block
# color       stroke colour (the app's palette)
#
LAYERS = [
    dict(key="exc",      name="Limits of excavation",        group="design",   color="#FF6B4A", kind="polygon"),
    dict(key="repo",     name="Repository and stockpiles",   group="design",   color="#E8734A", kind="polygon"),
    dict(key="staging",  name="Staging, borrow and access",  group="design",   color="#E8B34B", kind="polygon"),
    dict(key="haul",     name="Haul routes",                 group="design",   color="#F2C14E", kind="line"),
    dict(key="daylight", name="Daylight lines (CAD)",        group="design",   color="#7FD4A8", kind="line"),
    dict(key="grade",    name="Grading breaklines (CAD)",    group="design",   color="#5FBF8F", kind="line"),
    dict(key="lots",     name="Elem Colony lots",            group="bound",    color="#4FD2E8", kind="polygon"),
    dict(key="ou",       name="Operable units",              group="bound",    color="#9AA7B2", kind="polygon"),
    dict(key="parcels",  name="Assessor parcels",            group="bound",    color="#6E7E8C", kind="polygon"),
    dict(key="water",    name="Water features",              group="exist",    color="#4A9BE8", kind="polygon"),
    dict(key="bldg",     name="Buildings and structures",    group="exist",    color="#C8A2C8", kind="polygon"),
    dict(key="road",     name="Roads and drives",            group="exist",    color="#8A939B", kind="line"),
    dict(key="fence",    name="Fences and gates",            group="exist",    color="#B0885A", kind="line"),
    dict(key="util",     name="Utilities and poles",         group="exist",    color="#D4B04A", kind="point"),
]

# how CAD_Design_py "Feature" values map onto payload layers
FEATURE_LAYER = {
    "Limit of Excavation":      "exc",
    "EIC Repository":           "repo",
    "East Temporary Stockpile": "repo",
    "Proposed Soil Stockpile":  "repo",
    "Staging Area":             "staging",
    "Borrow Area":              "staging",
    "Borrow Soil Staging Area": "staging",
    "Gravel Area":              "staging",
    "Construction Entrance":    "staging",
}

GIS_PROV = "EA Final Design GIS deliverable (SBMM_ResidentialRD.gdb, ArcGIS Pro 3.6.2)"
CAD_PROV = "EA Final Design CAD (C-BASE.dwg / V-Base.dwg, DWG->DXF via libredwg master)"

# Canonical name + drawing number for each design area, keyed on the C-BASE
# decision-unit layer the GIS polygon coincides with (IoU 1.000 for all but the
# Lot 31 sliver).  Drawing numbers are from the delivered sheet list
# ("Data Link Files/SHEETS - SBMM.xlsx") and the eTransmit sheet-set report,
# which are the authoritative naming for this set -- not guessed from the plots.
#
# NOTE on Lot 13 / Lot 15: EA's CAD layer names for these two are swapped with
# respect to both the Elem Colony lot polygons and the sheet subjects (the
# polygon on layer C-SITE-DU-LOT-15 lies inside Lot 13 and matches sheet C-103
# "LOT 13 SITE SHEET", and vice versa).  Geometry wins; the CAD layer is kept on
# the feature as recorded fact and the disagreement is flagged.
AREA = {
    "C-SITE-DU-LOT-13":      ("Lot 15",              "C-104", 15),
    "C-SITE-DU-LOT-15":      ("Lot 13",              "C-103", 13),
    "C-SITE-DU-LOT-17":      ("Lot 17",              "C-112", 17),
    "C-SITE-DU-LOT-19":      ("Lot 19",              "C-105", 19),
    "C-SITE-DU-LOT-25":      ("Lot 25",              "C-106", 25),
    "C-SITE-DU-LOT-31":      ("Lot 31",              "C-110", 31),
    "C-SITE-DU-LOTS-1-5-7":  ("Lots 1, 5 and 7",     "C-111", None),
    "C-SITE-DU-SOUTH-RESD":  ("Southern Residence",  "C-107", None),
    "C-SITE-DU-LOT-SW":      ("Southwest Lot",       "C-108", None),
    "C-SITE-DU-LOT-NW":      ("Northwest Lot",       "C-109", None),
    "C-SITE-DU-NORTH-LOBE":  ("North Lobe",          "C-202", None),
}

# Drawing number for the site-wide design areas, from the same sheet list.
FEATURE_SHEET = {
    "Staging Area":             "C-102",
    "Gravel Area":              "C-102",
    "Construction Entrance":    "C-102",
    "Borrow Soil Staging Area": "C-102",
    "East Temporary Stockpile": "C-201",
    "Proposed Soil Stockpile":  "C-201",
    "Borrow Area":              "C-203",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gdb", required=True)
    ap.add_argument("--dxf", required=True, help="directory holding C-BASE.dxf and V-Base.dxf")
    ap.add_argument("--out", default="data/design_gis.json")
    ap.add_argument("--design-ea", default="data/design_ea.json")
    a = ap.parse_args()

    feats = []
    counts = collections.Counter()

    def add(layer, props, geom_type, coords, prov):
        props = {k: v for k, v in props.items() if v not in (None, "")}
        props["layer"] = layer
        props["provenance"] = prov
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": geom_type, "coordinates": coords}})
        counts[layer] += 1

    # ---------------------------------------------------------- GIS: lots first
    lots = gpd.read_file(a.gdb, layer="ElemColony_Lots_py", engine="pyogrio")
    lot_geoms = []
    for r in lots.itertuples():
        g = valid(r.geometry)
        num = None if r.Lot_Num != r.Lot_Num else int(r.Lot_Num)
        lot_geoms.append((num, g))
        for ring in rings_of(g):
            add("lots", dict(name=f"Lot {num}" if num is not None else "Elem Colony lot (unnumbered)",
                             lot=num, area_sf=round(g.area)),
                "Polygon", [ring], GIS_PROV)

    def lot_of(g):
        """Lot number whose polygon contains most of g."""
        best, bn = 0.0, None
        for num, lg in lot_geoms:
            if num is None or not lg.intersects(g):
                continue
            try:
                f = lg.intersection(g).area / g.area if g.area else 0
            except Exception:
                f = 0
            if f > best:
                best, bn = f, num
        return bn if best > 0.3 else None

    # ---------------------------------------------------------- CAD: decision-unit
    # names, used only to label.  Geometry always wins over a CAD layer name --
    # EA's C-SITE-DU-LOT-13 / -LOT-15 layer names are swapped with respect to the
    # lot polygons and the sheet subjects, so the label is derived from lot
    # containment and the CAD layer is carried alongside as recorded fact.
    import ezdxf
    cbase = ezdxf.readfile(os.path.join(a.dxf, "C-BASE.dxf"))
    du = []
    for e in cbase.modelspace():
        if e.dxftype() != "LWPOLYLINE" or not e.dxf.layer.startswith("C-SITE-DU-"):
            continue
        pts = [(p[0], p[1]) for p in e.get_points()]
        if len(pts) < 3:
            continue
        try:
            g = valid(Polygon(pts))
        except Exception:
            continue
        if not g.is_empty and g.area > 5:
            du.append((e.dxf.layer, g))

    def cad_layer_of(g):
        best, bl = 0.0, None
        for lay, dg in du:
            try:
                u = g.union(dg).area
                iou = g.intersection(dg).area / u if u else 0
            except Exception:
                iou = 0
            if iou > best:
                best, bl = iou, lay
        return (bl, round(best, 3)) if best > 0.5 else (None, None)

    # ---------------------------------------------------------- GIS: design areas
    exc_areas = []
    dpy = gpd.read_file(a.gdb, layer="CAD_Design_py", engine="pyogrio")
    for r in dpy.itertuples():
        g = valid(r.geometry)
        feature = r.Feature
        key = FEATURE_LAYER.get(feature, "staging")
        ln = lot_of(g)
        cl, iou = cad_layer_of(g)
        area_nm, sheet, area_lot = AREA.get(cl, (None, None, None))
        nm = feature
        conflict = None
        if key == "exc":
            if area_nm:
                nm = f"Limit of excavation — {area_nm}"
                # geometry is the arbiter; record where EA's CAD label disagrees
                if area_lot is not None and ln is not None and area_lot != ln:
                    conflict = (f"EA's CAD layer {cl} names a different lot than the lot polygon "
                                f"this area sits in (Lot {ln}); the geometry and the sheet subject agree "
                                f"with Lot {area_lot}, so that is what is shown.")
                if ln is None:
                    ln = area_lot
            elif ln is not None:
                nm = f"Limit of excavation — Lot {ln}"
            else:
                nm = "Limit of excavation"
        sheet = sheet or FEATURE_SHEET.get(feature)
        props = dict(name=nm, feature=feature, area=area_nm, lot=ln, sheet=sheet,
                     area_sf=round(g.area), acres=round(g.area / 43560.0, 3),
                     cad_layer=cl, cad_iou=iou, cad_layer_conflict=conflict)
        if g.area < 100:
            props["note"] = "degenerate sliver in the delivered geodatabase (area under 100 ft2)"
        if key == "exc" and g.area >= 100:
            exc_areas.append((area_nm or (f"Lot {ln}" if ln is not None else None), sheet, g))
        for ring in rings_of(g):
            add(key, props, "Polygon", [ring], GIS_PROV)

    dln = gpd.read_file(a.gdb, layer="CAD_Design_ln", engine="pyogrio")
    for r in dln.itertuples():
        g = r.geometry
        for ln in lines_of(g):
            add("haul", dict(name=r.Feature, feature=r.Feature,
                             length_ft=round(g.length)), "LineString", ln, GIS_PROV)

    # ---------------------------------------------------------- GIS: operable units
    ou = gpd.read_file(a.gdb, layer="OperableUnit_py", engine="pyogrio")
    for r in ou.itertuples():
        g = valid(r.geometry)
        for ring in rings_of(g):
            add("ou", dict(name=r.OU_Number, acres=round(g.area / 43560.0, 1)),
                "Polygon", [ring], GIS_PROV)

    # site clip window: everything the app's 2-ft DEM covers, plus a margin
    X0, Y0, X1, Y1 = 6368100 - 500, 2122800 - 500, 6377800 + 500, 2131700 + 500
    clip = Polygon([(X0, Y0), (X1, Y0), (X1, Y1), (X0, Y1)])

    # ---------------------------------------------------------- GIS: water
    wat = gpd.read_file(a.gdb, layer="Water_py", engine="pyogrio")
    seen = set()
    for r in wat.itertuples():
        g = valid(r.geometry)
        if g.is_empty or not g.intersects(clip):
            continue
        k = (round(g.centroid.x, 1), round(g.centroid.y, 1), round(g.area))
        if k in seen:          # the delivered layer repeats several ponds
            continue
        seen.add(k)
        nm = (r.NAME or "").strip() or "Unnamed water feature"
        for ring in rings_of(g.intersection(clip)):
            add("water", dict(name=nm.title(), remedy=(r.REM_ALT_SA or "").strip() or None,
                              area_sf=round(g.area)), "Polygon", [ring], GIS_PROV)

    # ---------------------------------------------------------- GIS: parcels (clipped)
    par = gpd.read_file(a.gdb, layer="Parcels_py", engine="pyogrio", bbox=(X0, Y0, X1, Y1))
    for r in par.itertuples():
        g = valid(r.geometry)
        if g.is_empty or not g.intersects(clip):
            continue
        for ring in rings_of(g):
            add("parcels", dict(name=f"APN {r.APN}" if r.APN else "Parcel",
                                apn=r.APN, acres=round(r.ACRES, 2) if r.ACRES == r.ACRES else None),
                "Polygon", [ring], GIS_PROV)

    # ---------------------------------------------------------- CAD: C-BASE design lines
    CB = {
        "daylight": lambda l: "TRNS-DYLGHT" in l or "TRNS-DYLIGHT" in l,
        "grade":    lambda l: l.startswith("C-TOPO-FEAT"),
    }
    for e in cbase.modelspace():
        t = e.dxftype()
        lay = e.dxf.layer
        key = next((k for k, f in CB.items() if f(lay)), None)
        if key is None:
            continue
        pts = []
        if t == "LWPOLYLINE":
            z = float(getattr(e.dxf, "elevation", 0) or 0)
            pts = [(p[0], p[1], z) for p in e.get_points()]
        elif t == "POLYLINE":
            pts = [tuple(v.dxf.location) for v in e.vertices]
        elif t == "LINE":
            pts = [tuple(e.dxf.start), tuple(e.dxf.end)]
        if len(pts) < 2:
            continue
        zs = [p[2] for p in pts if len(p) > 2]
        # real site elevations are ~1325-2100 ft; anything else in Z is a
        # drafting artefact (several layers sit at a flat 309.1 / 322.5) and is
        # reported as "no elevation" rather than as a bogus grade.
        z_ok = zs and all(1300 < z < 2200 for z in zs)
        # Name the line from the design area it actually sits on, not from the
        # CAD layer text -- EA's per-lot layer names proved unreliable (see the
        # Lot 13 / Lot 15 note above), and geometry is checkable.
        ls = LineString([(p[0], p[1]) for p in pts]) if len(pts) >= 2 else None
        area_nm = sheet = None
        if ls is not None:
            best = 1e18
            for an, sh, ag in exc_areas:
                d = ag.distance(ls)
                if d < best:
                    best, area_nm, sheet = d, an, sh
            if best > 300:            # not attributable to any one design area
                area_nm = sheet = None
        label = area_nm or lay.replace("C-SITE-TRNS-", "").replace("C-TOPO-FEAT", "") \
                              .replace("_", " ").replace("-", " ").strip().title() or lay
        props = dict(name=(("Daylight line — " if key == "daylight" else "Grading breakline — ") + label),
                     area=area_nm, sheet=sheet, cad_layer=lay)
        if z_ok:
            props["z_min_ft"] = r2(min(zs))
            props["z_max_ft"] = r2(max(zs))
        add(key, props, "LineString", [[r2(p[0]), r2(p[1])] for p in pts], CAD_PROV)

    # ---------------------------------------------------------- CAD: V-Base existing
    vbase = ezdxf.readfile(os.path.join(a.dxf, "V-Base.dxf"))
    VB = [
        ("bldg",  ("V-BLDG-OTLN", "V-BLDG-SHED-OTLN", "V-BLDG-DECK", "V-BLDG-OVHG", "V-SITE-CONC", "V-SITE-SDWK")),
        ("road",  ("V-ROAD-GRVL", "V-ROAD-ASPH", "V-ROAD-CONC", "V-ROAD-GRAL", "V-ROAD-CURB", "V-ROAD-CURB-FACE")),
        ("fence", ("V-SITE-FENC", "V-SITE-FENC-GATE", "V-SITE-BLRD")),
    ]
    LAYER_OF = {lay: key for key, lays in VB for lay in lays}
    PRETTY = {"bldg": "Structure", "road": "Road / drive", "fence": "Fence"}
    for e in vbase.modelspace():
        t = e.dxftype()
        key = LAYER_OF.get(e.dxf.layer)
        if key is None:
            continue
        pts = []
        closed = False
        if t == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points()]
            closed = bool(e.closed)
        elif t == "POLYLINE":
            pts = [(v.dxf.location[0], v.dxf.location[1]) for v in e.vertices]
            closed = bool(e.is_closed)
        elif t == "LINE":
            pts = [(e.dxf.start[0], e.dxf.start[1]), (e.dxf.end[0], e.dxf.end[1])]
        if len(pts) < 2:
            continue
        nm = f"{PRETTY[key]} ({e.dxf.layer})"
        spec = next(l for l in LAYERS if l["key"] == key)
        if spec["kind"] == "polygon" and closed and len(pts) >= 3:
            ring = [[r2(x), r2(y)] for x, y in pts]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            add(key, dict(name=nm, cad_layer=e.dxf.layer), "Polygon", [ring], CAD_PROV)
        else:
            add(key, dict(name=nm, cad_layer=e.dxf.layer),
                "LineString", [[r2(x), r2(y)] for x, y in pts], CAD_PROV)

    # point symbols: power poles, monitoring wells, signs
    PT = {"V-POWR-POLE": "Power pole", "V-SITE-MONW": "Monitoring well (surveyed)",
          "V-SITE-SIGN": "Sign", "V-STRM-STRC": "Storm structure",
          "V-SSWR-STRC": "Sewer structure", "V-WATR-STRC": "Water structure",
          "V-CTRL-MONU": "Survey monument", "V-CTRL-TRAV": "Traverse point"}
    for e in vbase.modelspace():
        nm = PT.get(e.dxf.layer)
        if not nm:
            continue
        p = None
        if e.dxftype() == "INSERT":
            p = (e.dxf.insert[0], e.dxf.insert[1])
        elif e.dxftype() == "CIRCLE":
            p = (e.dxf.center[0], e.dxf.center[1])
        if p is None:
            continue
        add("util", dict(name=nm, cad_layer=e.dxf.layer), "Point", [r2(p[0]), r2(p[1])], CAD_PROV)

    # ---------------------------------------------------------- assemble
    layers = []
    for spec in LAYERS:
        n = counts.get(spec["key"], 0)
        if n:
            layers.append({**spec, "count": n,
                           "provenance": CAD_PROV if spec["key"] in ("daylight", "grade", "bldg", "road", "fence", "util") else GIS_PROV})

    out = {
        "source": ("EA Engineering, Science, and Technology, Inc. — Residential Remedial Design, "
                   "Sulphur Bank Mercury Mine Superfund Site. NATIVE deliverables, June 2026: "
                   "file geodatabase SBMM_ResidentialRD.gdb (ArcGIS Pro 3.6.2) and the Final Design "
                   "CAD set (project 1578546). Contract 68HE0318D0005, Task Order 68HE0924F0079."),
        "crs": ("EPSG:2226 as delivered (NAD83 / California zone 2, US survey feet). Verified "
                "against the app's EPSG:6418 frame by comparison with 11 independently registered "
                "PDF sheets: agreement 0.3-1.8 ft. No reprojection applied."),
        "supersedes": ("Native geometry supersedes the PDF-derived extraction in design_ea.json "
                       "wherever the two cover the same area."),
        "excluded": ("T22_0762_IsolateCurrent and T22_0762_ResourceCurrentPly (archaeological "
                     "resources and isolates, EPSG:26910) are deliberately omitted: site locations "
                     "are confidential under NHPA s.304 / ARPA s.9."),
        "layers": layers,
        "features": feats,
    }
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {a.out}  {os.path.getsize(a.out)/1e6:.2f} MB  {len(feats)} features")
    for l in layers:
        print(f"   {l['count']:6d}  {l['key']:9s} {l['name']}")


if __name__ == "__main__":
    main()
