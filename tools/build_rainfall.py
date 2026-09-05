#!/usr/bin/env python3
"""
Bake the design-storm rainfall table into data/rainfall.json + datajs/d_rainfall.js.

    python tools/build_rainfall.py

WHY A BUILDER AND NOT A FETCH
-----------------------------
The app is file:// only (CLAUDE.md): no fetch(), no XHR, ever. Rainfall depths
therefore ship as a <script> payload like every other dataset, and this tool is
the one place they are written. Everything it writes is citable: the source, the
URL it came from, the coordinates it was pulled for and the date.

THE CSV IT WANTS (data/atlas14_sbmm.csv)
----------------------------------------
The NOAA Atlas 14 Point Precipitation Frequency Data Server export, taken at
39.003 N, 122.663 W (the Sulphur Bank Mercury Mine OU1 site), "Precipitation
Frequency Estimates (inches)", PDS-based, English units:

    https://hdsc.nws.noaa.gov/pfds/pfds_map_cont.html?lat=39.0030&lon=-122.6630

The export is a text/CSV file with a header block, then a line naming the
average recurrence intervals and then one row per duration, e.g.

    PRECIPITATION FREQUENCY ESTIMATES
    by duration for ARI (years):, 1, 2, 5, 10, 25, 50, 100, 200, 500, 1000
    5-min:, 0.181, 0.216, 0.262, 0.299, 0.349, 0.388, 0.428, 0.469, 0.525, 0.569
    ...
    24-hr:, 2.71, 3.34, 4.28, 5.06, 6.19, 7.11, 8.09, 9.14, 10.6, 11.8

The parser below is deliberately forgiving: it wants a line carrying the ARI
list and, after it, any line beginning `<number>-<min|hr|day>` followed by that
many numbers. Upper/lower confidence bounds (the two blocks the PFDS export puts
after the estimates) are ignored — the FIRST estimates block wins, which is the
block the tabulated depths come from.

WITHOUT THAT CSV
----------------
The provisional table below is written instead, flagged `provisional: true`, and
the app prints "provisional depths — replace with the Atlas 14 export" in red on
every Design storm card and report sheet until the CSV exists. The depths are
the planner's ruling (docs/V14_PHASE2_RUNOFF_SPEC.md §1) and are approximately
right for this location; they are NOT a substitute for the PFDS export in a
submittal.

The 24-hour temporal distributions are written here too, and are provisional for
the same reason: the shapes are the NRCS Type IA (the Pacific-coast type that
covers Lake County) and Type I curves as cumulative fractions of the 24-hour
depth. Replace them with the published TR-55 / NEH-630 table before a submittal;
the app reads them from this payload and never from a constant.
"""
import csv, datetime, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "datajs")
CSV_IN = os.path.join(DATA, "atlas14_sbmm.csv")

LAT, LON = 39.003, -122.663
URL = "https://hdsc.nws.noaa.gov/pfds/pfds_map_cont.html?lat=39.0030&lon=-122.6630"

# docs/V14_PHASE2_RUNOFF_SPEC.md §1 — the provisional depths, in inches.
PROV_24H = {2: 3.3, 5: 4.2, 10: 5.3, 25: 6.4, 50: 7.3, 100: 8.3}
PROV_1H = {2: 0.55, 10: 0.85, 25: 1.05, 100: 1.45}

# Cumulative fraction of the 24-hour depth. Monotone, starts at 0, ends at 1.
DISTRIBUTIONS = {
    "IA": {
        "name": "NRCS Type IA (Pacific coast)",
        "t_h": [0, 1, 2, 3, 4, 5, 6, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5,
                11, 11.5, 12, 13, 14, 16, 20, 24],
        "f":   [0, .020, .041, .063, .086, .110, .136, .166, .184, .206, .237,
                .268, .425, .520, .577, .624, .664, .697, .751, .791, .856, .938, 1.0],
    },
    "I": {
        "name": "NRCS Type I",
        "t_h": [0, 2, 4, 6, 8, 9, 9.5, 9.75, 10, 10.5, 11, 12, 13, 16, 20, 24],
        "f":   [0, .035, .076, .125, .194, .254, .303, .362, .515, .583, .624,
                .682, .727, .830, .926, 1.0],
    },
    "uniform": {
        "name": "Uniform (constant intensity)",
        "t_h": [0, 24],
        "f":   [0, 1.0],
    },
}

DUR_H = {"min": 1 / 60.0, "hr": 1.0, "hour": 1.0, "day": 24.0}
ROW_RE = re.compile(r"^\s*\"?([0-9.]+)\s*[- ]\s*(min|hr|hour|day)s?\.?\s*:?\"?\s*,(.*)$", re.I)
ARI_RE = re.compile(r"ari\s*\(years\)\s*:?\s*,(.*)$", re.I)


def parse_csv(path):
    """The PFDS export -> {duration_key: {ari: depth_in}} plus the header lines."""
    text = open(path, encoding="utf-8", errors="replace").read()
    lines = text.splitlines()
    aris, table, order, header = None, {}, [], []
    for ln in lines:
        if aris is None:
            m = ARI_RE.search(ln)
            if m:
                aris = [int(float(v)) for v in re.findall(r"[0-9.]+", m.group(1))]
                continue
            if ln.strip() and len(header) < 12:
                header.append(ln.strip())
            continue
        m = ROW_RE.match(ln)
        if not m:
            # the estimates block ends at the first non-row line after it
            if table:
                break
            continue
        n, unit, rest = float(m.group(1)), m.group(2).lower(), m.group(3)
        vals = [float(v) for v in re.findall(r"-?[0-9.]+", rest)]
        if len(vals) < len(aris):
            continue
        hours = n * DUR_H[unit]
        key = ("%g-" % n) + ("min" if unit.startswith("min") else "hr" if unit.startswith("h") else "day")
        if key in table:
            continue
        table[key] = {"hours": round(hours, 6),
                      "depths": {str(a): vals[i] for i, a in enumerate(aris)}}
        order.append(key)
    if not table:
        raise SystemExit("could not find a precipitation-frequency block in " + path)
    return aris, table, order, header


def provisional():
    aris = sorted(set(list(PROV_24H) + list(PROV_1H)))
    table = {
        "1-hr": {"hours": 1.0, "depths": {str(a): PROV_1H[a] for a in sorted(PROV_1H)}},
        "24-hr": {"hours": 24.0, "depths": {str(a): PROV_24H[a] for a in sorted(PROV_24H)}},
    }
    return aris, table, ["1-hr", "24-hr"], []


def main():
    if os.path.exists(CSV_IN):
        aris, table, order, header = parse_csv(CSV_IN)
        prov = False
        src = "NOAA Atlas 14 Volume 6 (California), PFDS export " + os.path.basename(CSV_IN)
        note = ("Point precipitation frequency estimates read from the PFDS export in "
                "data/atlas14_sbmm.csv. Partial-duration series, English units, inches.")
    else:
        aris, table, order, header = provisional()
        prov = True
        src = "provisional (docs/V14_PHASE2_RUNOFF_SPEC.md §1) — NOT the PFDS export"
        note = ("PROVISIONAL DEPTHS. data/atlas14_sbmm.csv is absent, so the planner's "
                "approximate depths for this location are baked instead. Download the "
                "NOAA Atlas 14 point precipitation frequency estimates for "
                "39.003 N, 122.663 W, save them as data/atlas14_sbmm.csv and re-run "
                "tools/build_rainfall.py.")

    obj = {
        "source": src,
        "url": URL,
        "lat": LAT, "lon": LON,
        "crs_note": "the site's approximate centroid in WGS84; the app's CRS is EPSG:6418",
        "units": "in",
        "series": "partial duration (PDS)",
        "provisional": prov,
        "built": datetime.date.today().isoformat(),
        "note": note,
        "header": header,
        "ari": aris,
        "durations": order,
        "table": table,
        "distributions": DISTRIBUTIONS,
        "distributions_provisional": True,
        "distributions_note": (
            "24-hour cumulative fractions of the storm depth. NRCS Type IA is the "
            "Pacific-coast type that covers Lake County (TR-55 figure B-2); Type I and a "
            "uniform intensity are offered beside it. Provisional: replace with the "
            "published TR-55 / NEH-630 table before a submittal."),
    }
    with open(os.path.join(DATA, "rainfall.json"), "w") as f:
        json.dump(obj, f, indent=1)
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["rainfall"]='
          + json.dumps(obj, separators=(",", ":")) + ";\n")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "d_rainfall.js"), "w") as f:
        f.write(js)
    print("data/rainfall.json + datajs/d_rainfall.js  %.1f kB  %s"
          % (len(js) / 1024, "PROVISIONAL" if prov else "from " + os.path.basename(CSV_IN)))
    print("  durations: " + ", ".join(order))
    print("  ARI (years): " + ", ".join(str(a) for a in aris))
    for k in order:
        d = table[k]["depths"]
        print("   %-8s " % k + "  ".join("%s:%s" % (a, d[a]) for a in sorted(d, key=lambda v: int(v))))


if __name__ == "__main__":
    main()
