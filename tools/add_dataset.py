#!/usr/bin/env python3
"""Bake a CSV of coordinates into the app as a permanent dataset.

The in-app "add dataset…" flow (js/datasets.js) is for a table you want on the
map today; this is for a table that should be there every time the app opens —
wells, borings, air stations, anything recurring. It writes
data/datasets/ds_<id>.json, which tools/build_data.py compiles into the single
SBMM_DATA.datasets payload. No new <script> tag is ever needed.

    python tools/add_dataset.py wells.csv --name "Monitoring wells" --kind wells
    python tools/build_data.py && python tools/build_dist.py

Columns: --x/--y/--id name them explicitly; otherwise the same header + magnitude
detection the in-app importer uses is applied and printed, so a wrong guess is
visible before it ships. Coordinates may be State Plane ftUS (EPSG:6418) or
WGS84 lat/long — pass --crs to force one. Every other column becomes an
attribute; numeric-looking values are stored as numbers so the table sorts and
the 3D depth stick works.
"""
import argparse
import csv
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "datasets")

NORTH_RE = re.compile(r"^(northing|north|n|y|sp_?y(_ft)?|y_?ft|lat|latitude)$", re.I)
EAST_RE = re.compile(r"^(easting|east|e|x|sp_?x(_ft)?|x_?ft|lon|long|longitude)$", re.I)
ID_RE = re.compile(r"^(id|loc_?id|location|name|well|well_?id|boring|boring_?id|station|point|sample|label)$", re.I)
DEPTH_RE = re.compile(r"(total\s*depth|^td$|depth)", re.I)

# Site window, EPSG:6418. Used only to warn — a legitimate off-site point is
# possible, a whole table of them means the columns or the CRS are wrong.
XMIN, XMAX, YMIN, YMAX = 6_360_000, 6_385_000, 2_120_000, 2_140_000


def num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def median(vals):
    v = sorted(x for x in vals if x is not None)
    return v[len(v) // 2] if v else None


def guess(hdr, rows):
    xi = next((i for i, h in enumerate(hdr) if EAST_RE.match(h.strip())), None)
    yi = next((i for i, h in enumerate(hdr) if NORTH_RE.match(h.strip())), None)
    if xi is None or yi is None:
        mags = []
        for i in range(len(hdr)):
            m = median([num(r[i]) for r in rows[:40] if i < len(r)])
            if m is not None:
                mags.append((i, abs(m)))
        sp = sorted([c for c in mags if c[1] > 1e5], key=lambda c: -c[1])
        if len(sp) >= 2:
            xi = sp[0][0] if xi is None else xi
            yi = sp[1][0] if yi is None else yi
        else:
            ll = [c for c in mags if 1 < c[1] < 180]
            lon = next((c[0] for c in ll if c[1] > 90), None)
            lat = next((c[0] for c in ll if c[1] <= 90), None)
            if lon is not None and lat is not None:
                xi = lon if xi is None else xi
                yi = lat if yi is None else yi
    ii = next((i for i, h in enumerate(hdr) if ID_RE.match(h.strip())), None)
    return xi, yi, ii


def load_affine():
    with open(os.path.join(ROOT, "data", "affine.json")) as f:
        return json.load(f)


def from_ll(aff, lon, lat):
    A, B, C = aff["lon"]
    D, E, F = aff["lat"]
    det = A * E - B * D
    u, v = lon - C, lat - F
    return (E * u - B * v) / det, (A * v - D * u) / det


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--name", help="display name (default: the file name)")
    ap.add_argument("--id", dest="dsid", help="dataset id / output file stem")
    ap.add_argument("--kind", default="generic", choices=["generic", "wells", "borings"])
    ap.add_argument("--x", help="easting/longitude column name")
    ap.add_argument("--y", help="northing/latitude column name")
    ap.add_argument("--id-col", help="ID/label column name")
    ap.add_argument("--depth-col", help="attribute to use for the 3D depth stick")
    ap.add_argument("--crs", choices=["auto", "sp", "wgs84"], default="auto")
    ap.add_argument("--color")
    ap.add_argument("--shape", choices=["circle", "square", "triangle", "diamond", "well", "boring"])
    ap.add_argument("--source", default="", help="provenance line shown in the UI")
    a = ap.parse_args()

    with open(a.csv, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.reader(f) if any(str(c).strip() for c in r)]
    if len(rows) < 2:
        sys.exit("no data rows in " + a.csv)
    hdr = [h.strip() for h in rows[0]]
    body = rows[1:]

    def col(name, fallback):
        if name is None:
            return fallback
        if name not in hdr:
            sys.exit("no column %r — have: %s" % (name, ", ".join(hdr)))
        return hdr.index(name)

    gx, gy, gi = guess(hdr, body)
    xi, yi, ii = col(a.x, gx), col(a.y, gy), col(a.id_col, gi)
    if xi is None or yi is None:
        sys.exit("couldn't identify coordinate columns — pass --x and --y")

    crs = a.crs
    if crs == "auto":
        mx = median([num(r[xi]) for r in body]) or 0
        crs = "sp" if abs(mx) > 1e5 else "wgs84"
    aff = load_affine() if crs == "wgs84" else None

    pts, bad, offsite = [], 0, 0
    for r in body:
        x, y = num(r[xi]) if xi < len(r) else None, num(r[yi]) if yi < len(r) else None
        if x is None or y is None:
            bad += 1
            continue
        if crs == "wgs84":
            lon, lat = (x, y) if abs(x) > 90 else (y, x)
            x, y = from_ll(aff, lon, lat)
        elif x < y:
            x, y = y, x                       # given N,E
        if not (XMIN < x < XMAX and YMIN < y < YMAX):
            offsite += 1
        attrs = {}
        for i, h in enumerate(hdr):
            if i in (xi, yi, ii) or i >= len(r):
                continue
            v = str(r[i]).strip()
            if not v:
                continue
            n = num(v)
            attrs[h] = n if n is not None and re.fullmatch(r"[-+0-9.eE]+", v) else v
        pts.append({"id": (str(r[ii]).strip() if ii is not None and ii < len(r) else "")
                    or "pt %d" % (len(pts) + 1),
                    "x": round(x, 2), "y": round(y, 2), "a": attrs})
    if not pts:
        sys.exit("no usable coordinates")

    depth = a.depth_col
    if not depth:
        keys = [k for p in pts[:50] for k in p["a"]]
        depth = next((k for k in keys
                      if DEPTH_RE.search(k) and not re.search("screen|water|elev", k, re.I)), None)

    name = a.name or os.path.splitext(os.path.basename(a.csv))[0]
    dsid = a.dsid or re.sub(r"\W+", "_", name.lower()).strip("_")
    style = {"size": 6, "labels": False, "stick3d": a.kind != "generic"}
    if a.color:
        style["color"] = a.color
    if a.shape:
        style["shape"] = a.shape

    ds = {"id": dsid, "name": name, "kind": a.kind, "baked": True,
          "crs": "EPSG:6418 (NAD83(2011) CA SP Zone 2, ftUS)",
          "idField": hdr[ii] if ii is not None else "ID",
          "depthField": depth, "style": style,
          "source": a.source or ("baked from " + os.path.basename(a.csv)),
          "points": pts}

    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, "ds_%s.json" % dsid)
    with open(dst, "w") as f:
        json.dump(ds, f, indent=1)

    print("columns: X=%s  Y=%s  ID=%s  (%s)"
          % (hdr[xi], hdr[yi], hdr[ii] if ii is not None else "—",
             "State Plane ft" if crs == "sp" else "WGS84 lat/long"))
    print("depth attribute: %s" % (depth or "none — no 3D sticks"))
    print("%d points%s%s -> %s"
          % (len(pts),
             ", %d row(s) without coordinates" % bad if bad else "",
             ", %d OUTSIDE the site window (check the columns)" % offsite if offsite else "",
             os.path.relpath(dst, ROOT)))
    print("now run:  python tools/build_data.py && python tools/build_dist.py")


if __name__ == "__main__":
    main()
