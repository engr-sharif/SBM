#!/usr/bin/env python3
"""Build datajs/d_cultural.js — the CONFIDENTIAL cultural-resources payload.

Included by an explicit decision of the project lead (v9, §7 of docs/V9_SPEC.md).
Until v9 these layers were deliberately excluded from the app; that exclusion is
now replaced by *controlled inclusion*: the group is off by default, the first
enable of a session raises an acknowledgement dialog, and while any cultural
layer is visible the map, the 3D view, every snapshot and every report figure
carry a red "CONFIDENTIAL — CULTURAL RESOURCES (NHPA §304)" stamp.

Source
------
The same EA file geodatabase that carries the residential design:

    15785_46_0079/GeospatialData/SBMM_ResidentialRD.gdb

Two archaeological layers from the T22-0762 survey of the Elem Indian Colony:

    T22_0762_IsolateCurrent      19 points   artefact isolates
    T22_0762_ResourceCurrentPly  44 polygons recorded resource areas

Every other layer in the geodatabase is listed in the payload's `gdb_layers`
so the record of what was read is in the app, not only in this file.

CRS — the one place this build DOES reproject
---------------------------------------------
The design layers of this geodatabase are EPSG:2226 and the app is EPSG:6418;
those are two realisations of the same State Plane zone, they were checked
empirically to agree to 0.3–1.8 ft on this site, and tools/build_design_gis.py
therefore applies NO transformation (see CLAUDE.md).

**The two cultural layers are not in that frame at all**: they are delivered in
EPSG:26910 (NAD83 / UTM zone 10N, metres) — a different projection with
different units, not a different realisation of the same one. They are
therefore reprojected 26910 → 2226 with pyproj, which is a genuine projection
change and not the "silent reprojection" CLAUDE.md warns against. Verified by
the result landing inside the site window (E 6.369–6.378 M, N 2.123–2.132 M);
an unprojected copy would land near E 528 000, N 4 316 000 and be a thousand
miles off the map, which is a failure nobody could miss.

Confidentiality
---------------
Archaeological site locations are protected information under NHPA §304 and
ARPA §9. This payload is written into a file that gets emailed around, so the
protection has to travel with the data: the payload carries a `confidential`
block that the app reads to build the acknowledgement text and the stamp, and
every feature carries `confidential: true` so nothing downstream can export one
without knowing what it is.

Usage
-----
    python tools/build_cultural.py \
        --gdb /path/to/SBMM_ResidentialRD.gdb \
        --out datajs/d_cultural.js

Also writes data/cultural.json (the readable record) unless --no-json.
"""
import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_GDB = ("/home/claude/ea/gis/15785_46_0079/GeospatialData/"
               "SBMM_ResidentialRD.gdb")

STAMP = "CONFIDENTIAL – CULTURAL RESOURCES (NHPA §304)"

ACK = ("These layers are the recorded locations of archaeological resources and "
       "artefact isolates from the T22-0762 survey of the Elem Indian Colony. "
       "Their locations are protected information under Section 304 of the "
       "National Historic Preservation Act and Section 9 of the Archaeological "
       "Resources Protection Act.\n\n"
       "Project team only. Do not include them in public documents, in figures "
       "issued outside the project, or in anything posted to a public repository. "
       "While they are switched on, every view and every exported image carries a "
       "confidentiality stamp.")

# Which geodatabase layers are cultural. Explicit, so a future layer added to the
# geodatabase is NOT silently swept into the confidential group (nor silently
# left out of it — an unrecognised layer is reported by name at build time).
CULTURAL_LAYERS = [
    dict(gdb="T22_0762_IsolateCurrent", key="iso",
         name="Archaeological isolates", color="#E8B34B", shape="triangle",
         label_field="IO_Field_N",
         note="Isolated artefact finds recorded by GPS during the T22-0762 survey."),
    dict(gdb="T22_0762_ResourceCurrentPly", key="res",
         name="Recorded resource areas", color="#D9534F", shape=None,
         label_field="Label",
         note="Mapped extents of recorded archaeological resources (P-17-* primary numbers)."),
]

# Attributes that are GPS receiver telemetry rather than archaeology. They stay
# in the payload (the spec asks for all attributes) but are pushed to the end of
# the popup so the archaeology reads first.
TELEMETRY = {
    "created_us", "created_da", "last_edite", "last_edi_1", "Position_s",
    "Receiver_N", "Altitude", "Horizontal", "Vertical_A", "Fix_Time",
    "Fix_Type", "Correction", "Station_ID", "Number_of_", "PDOP", "HDOP",
    "VDOP", "Direction_", "Speed__km_", "Compass_re", "Average_Ho",
    "Average_Ve", "Averaged_P", "Standard_D", "GlobalID", "Shape_Leng",
    "Shape_Length", "Shape_Area",
}

# Latitude/Longitude columns are the receiver's own WGS84 fix. They are kept —
# they are part of the record — but they are NOT used to place the feature; the
# geometry is.
NICE = {
    "IO_Field_N": "Field number", "Primary_Nu": "Primary number",
    "Period": "Period", "Historic_C": "Historic class",
    "Prehistori": "Prehistoric class", "Descriptio": "Description",
    "Count": "Count", "Length": "Length", "Width": "Width",
    "Thickness": "Thickness", "Material": "Material", "Use_Wear": "Use wear",
    "Comment": "Comment", "Label": "Resource", "USGS": "USGS quad",
    "Intersects": "Intersects", "Latitude": "Latitude (WGS84)",
    "Longitude": "Longitude (WGS84)",
}


def clean(v):
    """JSON-safe scalar, or None for anything that carries no information."""
    import datetime
    import math
    if v is None:
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()[:19]
    if isinstance(v, float):
        if math.isnan(v):
            return None
        return round(v, 6)
    if isinstance(v, (int, bool)):
        return v
    s = str(v).strip()
    # the survey uses "0", "NA" and "" interchangeably for "not recorded"
    if s == "" or s.lower() in ("nan", "none", "<na>"):
        return None
    return s


def rings_of(geom):
    """[[ [x,y], ... ], ...] outer rings only — holes are not present in this
    layer and a hole would be a silent surprise, so they are counted, not drawn."""
    out, holes = [], 0
    gt = geom.geom_type
    parts = list(geom.geoms) if gt.startswith("Multi") else [geom]
    for p in parts:
        if p.is_empty:
            continue
        ext = list(p.exterior.coords)
        out.append([[round(c[0], 2), round(c[1], 2)] for c in ext])
        holes += len(p.interiors)
    return out, holes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gdb", default=DEFAULT_GDB)
    ap.add_argument("--out", default=os.path.join(ROOT, "datajs", "d_cultural.js"))
    ap.add_argument("--json", default=os.path.join(ROOT, "data", "cultural.json"))
    ap.add_argument("--no-json", action="store_true")
    a = ap.parse_args()

    import geopandas as gpd
    import pyogrio

    if not os.path.isdir(a.gdb):
        sys.exit("geodatabase not found: " + a.gdb)

    all_layers = [dict(name=n, geometry=str(g))
                  for n, g in pyogrio.list_layers(a.gdb)]
    print("geodatabase layers (%d):" % len(all_layers))
    for L in all_layers:
        mark = "  <-- cultural" if any(c["gdb"] == L["name"]
                                       for c in CULTURAL_LAYERS) else ""
        info = pyogrio.read_info(a.gdb, layer=L["name"])
        L["features"] = int(info["features"])
        L["crs"] = str(info["crs"])
        print("  %-32s %-22s %5d  %s%s"
              % (L["name"], L["geometry"], L["features"], L["crs"], mark))

    known = {c["gdb"] for c in CULTURAL_LAYERS}
    missing = known - {L["name"] for L in all_layers}
    if missing:
        sys.exit("expected cultural layer(s) absent from the geodatabase: "
                 + ", ".join(sorted(missing)))

    layers, features = [], []
    for spec in CULTURAL_LAYERS:
        g = gpd.read_file(a.gdb, layer=spec["gdb"], engine="pyogrio")
        src_crs = str(g.crs)
        g = g.to_crs(2226)
        cols = [c for c in g.columns if c != "geometry"]
        n = 0
        holes_total = 0
        for _, row in g.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            attrs, order = {}, []
            for c in cols:
                v = clean(row[c])
                if v is None:
                    continue
                attrs[NICE.get(c, c)] = v
                order.append(NICE.get(c, c))
            lab = clean(row.get(spec["label_field"])) or ("%s %d" % (spec["key"], n + 1))
            f = dict(layer=spec["key"], name=str(lab), confidential=True,
                     attrs=attrs,
                     attr_order=[k for k in order
                                 if k not in {NICE.get(t, t) for t in TELEMETRY}]
                                + [k for k in order
                                   if k in {NICE.get(t, t) for t in TELEMETRY}])
            if geom.geom_type in ("Point", "MultiPoint"):
                p = geom if geom.geom_type == "Point" else list(geom.geoms)[0]
                f["geom"] = "point"
                f["coords"] = [round(p.x, 2), round(p.y, 2)]
            else:
                rings, holes = rings_of(geom)
                holes_total += holes
                if not rings:
                    continue
                f["geom"] = "polygon"
                f["rings"] = rings
                try:
                    f["area_sf"] = round(float(geom.area), 1)
                except Exception:
                    pass
            features.append(f)
            n += 1
        layers.append(dict(
            key=spec["key"], name=spec["name"], gdb_layer=spec["gdb"],
            color=spec["color"], shape=spec["shape"], count=n,
            note=spec["note"], source_crs=src_crs))
        print("%-32s %3d features  %s -> EPSG:2226%s"
              % (spec["gdb"], n, src_crs,
                 "  (%d holes dropped)" % holes_total if holes_total else ""))

    xs, ys = [], []
    for f in features:
        if f["geom"] == "point":
            xs.append(f["coords"][0]); ys.append(f["coords"][1])
        else:
            for r in f["rings"]:
                for c in r:
                    xs.append(c[0]); ys.append(c[1])
    bbox = [min(xs), min(ys), max(xs), max(ys)]
    # a sanity gate on the reprojection: State Plane zone 2 easting for this site
    # is ~6.37 M ft and northing ~2.13 M ft. UTM metres would be ~5.3e5 / 4.3e6.
    if not (6.0e6 < bbox[0] < 6.6e6 and 2.0e6 < bbox[1] < 2.3e6):
        sys.exit("reprojection sanity check failed — bbox %r is not California "
                 "State Plane zone 2 feet" % (bbox,))
    print("bbox (EPSG:2226 ftUS): %.0f %.0f %.0f %.0f" % tuple(bbox))

    payload = {
        "source": ("EA Engineering, Science, and Technology, Inc. — file "
                   "geodatabase SBMM_ResidentialRD.gdb (ArcGIS Pro 3.6.2), "
                   "delivered June 2026. Archaeological survey T22-0762 of the "
                   "Elem Indian Colony."),
        "crs": ("Delivered EPSG:26910 (NAD83 / UTM zone 10N, metres); "
                "reprojected here to EPSG:2226 (NAD83 / California zone 2, US "
                "survey feet) with pyproj, which is the app's working frame. "
                "This is the one layer group in the app that IS reprojected — "
                "the design layers arrive already in EPSG:2226 and are left "
                "alone (see tools/build_design_gis.py)."),
        "confidential": {
            "stamp": STAMP,
            "ack_title": "Cultural resources — protected information",
            "ack_body": ACK,
            "ack_button": "I understand",
            "authorities": ["NHPA §304 (54 U.S.C. §307103)", "ARPA §9 (16 U.S.C. §470hh)"],
        },
        "gdb_layers": all_layers,
        "layers": layers,
        "features": features,
        "bbox": [round(v, 2) for v in bbox],
    }

    if not a.no_json:
        os.makedirs(os.path.dirname(a.json), exist_ok=True)
        with open(a.json, "w") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        print("wrote %s (%.1f kB)" % (a.json, os.path.getsize(a.json) / 1024))

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["cultural"]=')
        fh.write(body)
        fh.write(";\n")
    print("wrote %s (%.1f kB, %d features)"
          % (a.out, os.path.getsize(a.out) / 1024, len(features)))


if __name__ == "__main__":
    main()
