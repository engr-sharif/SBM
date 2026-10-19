#!/usr/bin/env python3
"""The 2026 TEM2Go geophysics survey -> the app's payload.

    python tools/build_tem2026.py        # needs pyproj
    python tools/stamp_sizes.py          # the loader's size table + SBMM_HASHES
    python tools/build_dist.py

SOURCE. The contractor delivered one standalone HTML viewer,
data/source/geophysics_tem2go_2026/SBMM_TEM2Go-visualization_v1.html, kept
verbatim. Its data is the `const D = {...}` literal on one line of that file:
1,032 soundings, each a 20-layer LCI resistivity model (May 2026), with
lat/lon (WGS84), UTM 10N easting/northing and ground elevation in metres, the
layer tops and bottoms in metres, and resistivity in ohm-m as one flat array
r[i*20 + layer]. Nothing else in the file is read.

WRITES
  data/tem2026.json        the record, indented
  datajs/d_tem2026.js      SBMM_DATA["tem2026"], the same object, compact

COORDINATES. UTM 10N metres through pyproj 32610 -> 6418 (US survey feet), the
same route the boulder tracker takes in tools/build_imports.py. It is checked,
not assumed: every sounding's lat/lon through data/affine.json (the app's own
+-1 ft conversion) must land within 1 ft of it, and the run fails otherwise.
Elevations and depths are metres -> US survey feet (x 3937/1200). The
resistivities are carried exactly as delivered.

The lidar agreement (sounding z against the Jan-2024 DEM: median -0.21 ft) is
asserted by test/kernels.mjs --only tem, which has the DEM decoder this tool
does not.
"""
import json
import math
import os
import re
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SRC = os.path.join(REPO, "data", "source", "geophysics_tem2go_2026",
                   "SBMM_TEM2Go-visualization_v1.html")
OUT_JSON = os.path.join(REPO, "data", "tem2026.json")
OUT_JS = os.path.join(REPO, "datajs", "d_tem2026.js")
FT = 3937.0 / 1200.0               # metres -> US survey feet
SITE = (6366000, 2124000, 6378000, 2134000)   # a generous site window, ft


def read_source():
    with open(SRC, encoding="utf-8") as f:
        s = f.read()
    m = re.search(r"const D = (\{.*?\});</script>", s, re.S)
    if not m:
        sys.exit("no `const D = {...}` in " + SRC)
    D = json.loads(m.group(1))
    ns, nl = len(D["id"]), len(D["top"])
    for k in ("lat", "lon", "e", "n", "z"):
        if len(D[k]) != ns:
            sys.exit("%s has %d values for %d soundings" % (k, len(D[k]), ns))
    if len(D["bot"]) != nl or len(D["r"]) != ns * nl:
        sys.exit("layer arrays do not match %d soundings x %d layers" % (ns, nl))
    return D, ns, nl


def affine_xy(lon, lat):
    with open(os.path.join(REPO, "data", "affine.json")) as f:
        A = json.load(f)
    a, b, c = A["lon"]
    d, e, f_ = A["lat"]
    det = a * e - b * d
    u, v = lon - c, lat - f_
    return (e * u - b * v) / det, (-d * u + a * v) / det


def main():
    import pyproj
    D, ns, nl = read_source()
    tr = pyproj.Transformer.from_crs(32610, 6418, always_xy=True)
    X, Y = tr.transform(D["e"], D["n"])
    worst = 0.0
    for i in range(ns):
        ax, ay = affine_xy(D["lon"][i], D["lat"][i])
        worst = max(worst, math.hypot(X[i] - ax, Y[i] - ay))
        if not (SITE[0] < X[i] < SITE[2] and SITE[1] < Y[i] < SITE[3]):
            sys.exit("%s lands outside the site window" % D["id"][i])
    if worst > 1.0:
        sys.exit("UTM and lat/lon disagree by %.2f ft — not placing it" % worst)

    rec = {
        "built": date.today().isoformat(),
        "crs": "EPSG:6418 (NAD83(2011) CA SP Zone 2, ftUS); elevations NAVD88 ft",
        "survey": "TEM2Go, LCI resistivity models, May 2026",
        "source": "data/source/geophysics_tem2go_2026/SBMM_TEM2Go-visualization_v1.html"
                  " (the contractor's viewer, verbatim)",
        "placement": "UTM 10N m -> EPSG:6418 through pyproj; lat/lon through "
                     "data/affine.json agrees to %.2f ft" % worst,
        "n": ns,
        "nl": nl,
        "id": D["id"],
        "x": [round(v, 2) for v in X],
        "y": [round(v, 2) for v in Y],
        "z": [round(v * FT, 2) for v in D["z"]],
        "top_m": D["top"],
        "bot_m": D["bot"],
        "top_ft": [round(v * FT, 2) for v in D["top"]],
        "bot_ft": [round(v * FT, 2) for v in D["bot"]],
        "r": D["r"],
        "unit": "ohm-m",
    }
    with open(OUT_JSON, "w") as f:
        json.dump(rec, f, indent=1)
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["tem2026"]=%s;\n'
          % json.dumps(rec, separators=(",", ":")))
    with open(OUT_JS, "w") as f:
        f.write(js)
    print("tem2026: %d soundings x %d layers, to %.1f ft; E %.0f-%.0f N %.0f-%.0f;"
          " UTM vs lat/lon %.2f ft; d_tem2026.js %.0f kB"
          % (ns, nl, rec["bot_ft"][-1], min(X), max(X), min(Y), max(Y), worst,
             len(js) / 1024))


if __name__ == "__main__":
    main()
