#!/usr/bin/env python3
"""Bring the data of the engineer's earlier SBMM apps into the site explorer (v28).

Before this app there were five smaller ones, each built for one campaign, and
each holding data this app did not have. Their source files are copied verbatim
into data/imports/<repo>/ (the commit each was read at is in SOURCES below) and
this tool turns them into the app's own formats:

  data/datasets/ds_testpits2025.json   the 51 test pits of 2025 (sbmm-tool)
  data/datasets/ds_borings_hist.json   borings from 1988-2024 that are NOT
                                       already a monitoring well here
                                       (sbmm-explorer-v2)
  data/datasets/ds_ea_testpits.json    EA's five 2023 test pits (sbmm-tool)
  data/datasets/ds_xrf_boulders.json   the 2026 boulder XRF campaign (XRF)
  data/datasets/ds_xrf_soil.json       the 2026 native-vs-waste soil XRF
                                       (SoilXRF)
  data/lab_metals.json                 metals BY DEPTH for the 44 borings and
                                       51 test pits, and the full validated
                                       suite for the 153 ABP / EA samples
  data/site_areas.json                 the named site areas of SBMM.kmz

and writes datajs/d_datasets.js, d_lab_metals.js and d_site_areas.js directly
(the same payload shape tools/build_data.py writes, without re-encoding every
raster in the repo).

    python tools/build_imports.py            # needs openpyxl and pyproj
    python tools/build_dist.py

COORDINATES. Latitude/longitude goes through data/affine.json, the app's own
+-1 ft affine (the same conversion tools/add_dataset.py uses). The boulder
tracker is in UTM 10N metres, so it goes through pyproj 32610 -> 2226 — the one
other place, beside tools/build_cultural.py, where this repo reprojects. Every
point is checked against the site window, and the run fails on one outside it.

WHAT IS NOT CARRIED OVER, and why:
  * the 72 historical borings that ARE monitoring wells here already: the wells
    dataset (SBMM Monitoring Wells.xlsx) is the authority for those;
  * the boulder GPS elevations as a ground elevation: the tracker mixes metres
    (~400) with feet (~1,300) and holds one value (181.7) that is neither, so
    each is kept as recorded with its apparent unit and the app's lidar is the
    ground;
  * the soil borings' own coordinates from sbmm-tool: ds_borings2025 already
    has the surveyed ones — only the metals are joined, by hole id;
  * "Untitled Polygon" from SBMM.kmz.
"""
import datetime
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMP = os.path.join(ROOT, "data", "imports")
DSD = os.path.join(ROOT, "data", "datasets")
OUT = os.path.join(ROOT, "datajs")
sys.path.insert(0, os.path.join(ROOT, "tools"))
from add_dataset import from_ll, load_affine          # noqa: E402
from build_data import datasets as all_datasets       # noqa: E402

SOURCES = {
    "sbmm-tool": "engr-sharif/sbmm-tool @ 819de60",
    "abp": "engr-sharif/ABP @ 5df97ab",
    "sbmm-explorer-v2": "engr-sharif/sbmm-explorer-v2 @ fe82042",
    "xrf": "engr-sharif/XRF @ 7ddf14c",
    "soilxrf": "engr-sharif/SoilXRF @ aeaaae9",
}
CRS = "EPSG:6418 (NAD83(2011) CA SP Zone 2, ftUS)"
XMIN, XMAX, YMIN, YMAX = 6_360_000, 6_385_000, 2_120_000, 2_140_000
BUILT = datetime.date.today().isoformat()

# The two screening levels the ABP master table carries in its own column
# names ("Hg_Exc_ROD_204", "Sb_Exc_PMB_0.52", ...), mg/kg. Read from the
# workbook below and checked against these, so a revised table fails loudly.
ROD = {"Hg": 204, "As": 6.1, "Sb": 51, "Tl": 1.3}
PMB = {"Hg": 58, "As": 6.1, "Sb": 0.52, "Tl": 0.47}

SYM = {"Aluminum": "Al", "Antimony": "Sb", "Arsenic": "As", "Barium": "Ba",
       "Beryllium": "Be", "Cadmium": "Cd", "Calcium": "Ca", "Chromium": "Cr",
       "Cobalt": "Co", "Copper": "Cu", "Iron": "Fe", "Lead": "Pb",
       "Magnesium": "Mg", "Manganese": "Mn", "Mercury": "Hg", "Nickel": "Ni",
       "Potassium": "K", "Selenium": "Se", "Silver": "Ag", "Sodium": "Na",
       "Thallium": "Tl", "Vanadium": "V", "Zinc": "Zn"}


def rd(*p):
    with open(os.path.join(IMP, *p)) as f:
        return json.load(f)


AFF = load_affine()


def ll(lon, lat):
    x, y = from_ll(AFF, lon, lat)
    if not (XMIN < x < XMAX and YMIN < y < YMAX):
        sys.exit("off site: %r %r -> %.1f %.1f" % (lon, lat, x, y))
    return round(x, 2), round(y, 2)


def norm_id(s):
    """MW-01 == MW-1 == MW1; HP10 == HP-10. Only for matching, never stored."""
    s = re.sub(r"[\s\-_]", "", str(s).upper())
    return re.sub(r"(?<=[A-Z])0+(?=\d)", "", s)


def num(v):
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def xl_date(v):
    """Excel serial day (as a number or a string) -> ISO date."""
    try:
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(v)))).isoformat()
    except (TypeError, ValueError):
        return str(v) if v else None


def exceeds(m, table):
    return [k for k, lim in table.items() if m.get(k) is not None and m[k] > lim]


def write_ds(ds):
    ds.setdefault("crs", CRS)
    ds["baked"] = True
    with open(os.path.join(DSD, "ds_%s.json" % ds["id"]), "w") as f:
        json.dump(ds, f, indent=1)
    print("  ds_%s.json  %d points" % (ds["id"], len(ds["points"])))


def payload(name, obj):
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA[%s]=%s;\n'
          % (json.dumps(name), json.dumps(obj, separators=(",", ":"))))
    with open(os.path.join(OUT, "d_%s.js" % name), "w") as f:
        f.write(js)
    print("  d_%s.js  %.0f kB" % (name, len(js) / 1024))


# ---------------------------------------------------------------- the metals --
def boring_metals():
    """2025 soil borings: Hg and As by sampled interval, keyed to OUR hole ids."""
    out = {}
    for h in rd("sbmm-tool", "soil-borings-2025.json"):
        hid = re.sub(r"^SB0*(\d+)", r"SB-\1", h["id"])
        iv = []
        for d in h["depths"]:
            m = {SYM[k]: v for k, v in d["metals"].items() if v is not None and k in SYM}
            if not m:
                continue
            iv.append({"top": d["start"], "base": d["end"], "clp": d.get("clp"), "m": m})
        if iv:
            out[hid] = {"kind": "boring", "src": "sbmm-tool", "intervals": iv}
    return out


def testpit_metals(tps):
    out = {}
    for t in tps:
        iv = [{"top": d["start"], "base": d["end"],
               "m": {SYM[k]: v for k, v in d["metals"].items() if v is not None and k in SYM}}
              for d in t["depths"]]
        out[t["id"]] = {"kind": "testpit", "src": "sbmm-tool", "intervals": iv}
    return out


def sample_metals():
    """The 153 ABP / EA samples the app already plots, with their full results."""
    out = {}
    for f in rd("abp", "abp_samples.geojson")["features"]:
        p = f["properties"]
        if not p.get("sampled"):
            continue
        s = {"src": "ABP R%d" % p["round"], "depth": p.get("depth"),
             "date": p.get("sample_date") or p.get("metals_date"),
             "validated": bool(p.get("validated")), "m": {}, "q": {}, "dl": {}}
        for k in ("Hg", "As", "Sb", "Tl"):
            if p.get(k) is not None:
                s["m"][k] = p[k]
            if p.get(k + "_q"):
                s["q"][k] = p[k + "_q"]
            if p.get(k + "_dl") is not None:
                s["dl"][k] = p[k + "_dl"]
        for sym, r in (p.get("metals") or {}).items():
            if sym not in s["m"] and r.get("v") is not None:
                s["m"][sym] = r["v"]
                if r.get("q"):
                    s["q"][sym] = r["q"]
                if r.get("dl") is not None:
                    s["dl"][sym] = r["dl"]
        deep = {k: p[k + "_deep"] for k in ("Hg", "As", "Sb", "Tl") if p.get(k + "_deep") is not None}
        if deep:
            s["deep"] = {"m": deep, "q": {k: p[k + "_q_deep"] for k in deep if p.get(k + "_q_deep")}}
        if p.get("Hg_OM") is not None:
            s["om"] = {"Hg": p["Hg_OM"], "q": p.get("Hg_OM_q"), "effect": p.get("OM_effect")}
        note = p.get("field_note") or p.get("notes")
        if note:
            s["note"] = note
        out[p["id"]] = s
    for f in rd("abp", "ea_historical_samples.geojson")["features"]:
        p = f["properties"]
        prof = []
        for r in p.get("profile") or []:
            prof.append({"depth": r.get("depth"), "id": r.get("sample_id"),
                         "m": {k: r[k] for k in ("Hg", "As", "Sb", "Tl") if r.get(k) is not None},
                         "q": {k: r[k + "_q"] for k in ("Hg", "As", "Sb", "Tl") if r.get(k + "_q")}})
        s = {"src": "EA historical", "depth": p.get("depth"), "date": xl_date(p.get("sample_date")),
             "m": {k: p[k] for k in ("Hg", "As", "Sb", "Tl") if p.get(k) is not None},
             "q": {k: p[k + "_q"] for k in ("Hg", "As", "Sb", "Tl") if p.get(k + "_q")},
             "profile": prof}
        out[p["id"]] = s
    # The ABP table's own ROD / PMB drivers are the authority: they count a
    # NON-DETECT whose detection limit is above the level (W03: Sb U at 1.5
    # against a PMB of 0.52), which a recomputation from the values alone
    # cannot see. Where the table gives none, the values decide.
    drivers = {}
    for name in ("abp_samples.geojson", "ea_historical_samples.geojson"):
        for f in rd("abp", name)["features"]:
            p = f["properties"]
            drivers[p["id"]] = (p.get("rod_drivers"), p.get("pmb_drivers"), p.get("rod_exceed"), p.get("pmb_exceed"))
    split = lambda v: [x.strip() for x in str(v).split(",") if x.strip()] if v else []
    for sid, s in out.items():
        rod, pmb, rx, px = drivers.get(sid, (None, None, None, None))
        s["rod"] = split(rod) if rx in ("YES", "NO") else exceeds(s["m"], ROD)
        s["pmb"] = split(pmb) if px in ("YES", "NO") else exceeds(s["m"], PMB)
        s["levels_from"] = "ABP table" if rx in ("YES", "NO") else "values"
    return out


def check_thresholds():
    import openpyxl
    wb = openpyxl.load_workbook(os.path.join(IMP, "abp", "SBMM_ABP_Master_Table_R1_R2.xlsx"),
                                read_only=True, data_only=True)
    hdr = next(wb["Round 1 (2025)"].iter_rows(max_row=1, values_only=True))
    for h in hdr:
        m = re.match(r"^(\w+)_Exc_(ROD|PMB)_([\d.]+)$", str(h or ""))
        if m:
            want = (ROD if m.group(2) == "ROD" else PMB)[m.group(1)]
            if abs(float(m.group(3)) - want) > 1e-9:
                sys.exit("the ABP table's %s level for %s is %s, this tool says %s"
                         % (m.group(2), m.group(1), m.group(3), want))


# ------------------------------------------------------------- the datasets --
def ds_testpits(tps, subproject):
    pts = []
    for t in tps:
        x, y = ll(t["lon"], t["lat"])
        iv = t["depths"]
        hg = [d["metals"].get("Mercury") for d in iv if d["metals"].get("Mercury") is not None]
        asn = [d["metals"].get("Arsenic") for d in iv if d["metals"].get("Arsenic") is not None]
        a = {"Ground elev (ft)": t.get("elev"),
             "Total depth (ft)": max(d["end"] for d in iv),
             "Intervals sampled": len(iv),
             "Max Hg (mg/kg)": max(hg) if hg else None,
             "Max As (mg/kg)": max(asn) if asn else None,
             "Exceeds ROD": ", ".join(k for k in ("Hg", "As", "Sb", "Tl")
                                      if any((d["metals"].get({v: k for k, v in SYM.items()}[k]) or 0) > ROD[k]
                                             for d in iv)) or "none",
             "Subproject": subproject.get(t["id"]),
             "Latitude": t["lat"], "Longitude": t["lon"]}
        pts.append({"id": t["id"], "x": x, "y": y, "a": {k: v for k, v in a.items() if v is not None}})
    write_ds({"id": "testpits2025", "name": "Test pits (2025)", "kind": "borings",
              "idField": "Test pit", "depthField": "Total depth (ft)",
              "style": {"color": "#C98B4F", "shape": "square", "size": 6, "labels": False, "stick3d": True},
              "source": "2025 Jacobs test pits: coordinates, ground elevation and metals by depth interval "
                        "from %s (data/test-pits-2025.json); the same 51 pits in %s agree to 0.18 ft. "
                        "tools/build_imports.py." % (SOURCES["sbmm-tool"], SOURCES["sbmm-explorer-v2"]),
              "points": pts})


def ds_borings_hist(wells):
    have = {norm_id(p["id"]) for p in wells["points"]}
    pts, skipped = [], 0
    for f in rd("sbmm-explorer-v2", "borings.geojson")["features"]:
        p = f["properties"]
        if p["campaign"] != "previous":
            continue
        if norm_id(p["id"]) in have:
            skipped += 1
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        x, y = ll(lon, lat)
        a = {"Type": p.get("type") if p.get("type") != "Unknown" else None,
             "Year": p.get("year"), "Firm": p.get("company") if p.get("company") != "Unknown" else None,
             "Subproject": p.get("subproject"), "Total depth (ft)": p.get("depth_ft"),
             "Ground elev (ft)": p.get("elevation_ft"),
             "Groundwater (ft bgs)": p.get("gw_depth_ft"),
             "Screen (ft)": p.get("screen_interval_ft"), "Casing (in)": p.get("casing_in"),
             "Installed": p.get("installation_date"), "Condition": p.get("condition"),
             "Notes": p.get("notes"), "Source document": p.get("source_doc"),
             "Source page": p.get("source_page"),
             "Location confidence": p.get("confidence_score"),
             "Digitised from": p.get("source_polygon_label"),
             "Latitude": lat, "Longitude": lon}
        pts.append({"id": p["id"], "x": x, "y": y, "a": {k: v for k, v in a.items() if v not in (None, "")}})
    write_ds({"id": "borings_hist", "defaultOn": False, "name": "Borings — historical (1988–2024)", "kind": "borings",
              "idField": "Boring", "depthField": "Total depth (ft)",
              "style": {"color": "#9C8FD6", "shape": "boring", "size": 5, "labels": False, "stick3d": True},
              "source": "Previous-investigation borings from %s (data/borings.geojson), digitised from "
                        "SBMM.kmz and the historical figures; each carries its own location confidence. "
                        "%d that are already monitoring wells in this app were left to the wells dataset. "
                        "tools/build_imports.py." % (SOURCES["sbmm-explorer-v2"], skipped),
              "points": pts})
    return skipped


def ds_ea_testpits():
    pts = []
    for t in rd("sbmm-tool", "ea-test-pits.json"):
        x, y = ll(t["lon"], t["lat"])
        pts.append({"id": t["id"], "x": x, "y": y,
                    "a": {k: v for k, v in {"Total depth (ft)": t.get("depth"), "pH": t.get("ph"),
                                            "Notes": t.get("notes"), "Latitude": t["lat"],
                                            "Longitude": t["lon"]}.items() if v not in (None, "")}})
    write_ds({"id": "ea_testpits", "defaultOn": False, "name": "Test pits — EA (2023)", "kind": "borings",
              "idField": "Test pit", "depthField": "Total depth (ft)",
              "style": {"color": "#B07A9E", "shape": "square", "size": 5, "labels": False, "stick3d": True},
              "source": "EA Engineering's ABP test pits, from %s (data/ea-test-pits.json). "
                        "tools/build_imports.py." % SOURCES["sbmm-tool"],
              "points": pts})


def xl_rows(path, sheet, first):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    return [r for r in list(wb[sheet].iter_rows(values_only=True))[first:] if any(c is not None for c in r)]


def ds_xrf_boulders():
    import pyproj
    tr = pyproj.Transformer.from_crs(32610, 2226, always_xy=True)
    path = os.path.join(IMP, "xrf", "SBMM_XRF_Sample_Tracker_2026-05-08.xlsx")
    reads = {}
    for r in xl_rows(path, "XRF Readings Detail", 4):
        if not r[0] or r[3] != "Surface":
            continue
        reads.setdefault(r[0], []).append(r)
    pts, nogps = [], []
    for r in xl_rows(path, "Boulder Sample Log", 4):
        sid = r[4]
        if not sid:
            continue
        if r[5] is None or r[6] is None:
            nogps.append(sid)
            continue
        x, y = tr.transform(float(r[6]), float(r[5]))
        if not (XMIN < x < XMAX and YMIN < y < YMAX):
            sys.exit("boulder %s off site: %.1f %.1f" % (sid, x, y))
        rr = reads.get(sid, [])
        hg = [v for v in (num(q[5]) for q in rr) if v is not None]
        pb = [v for v in (num(q[7]) for q in rr) if v is not None]
        el = num(r[7])
        a = {"Area": r[1], "Grid": r[2], "Boulder": r[3],
             "Date": r[0].date().isoformat() if hasattr(r[0], "date") else r[0],
             "Rock": {"H": "hard", "F": "friable"}.get(r[8], r[8]),
             "Rind": {"Y": "yes", "N": "no"}.get(r[9], r[9]), "Rind (in)": num(r[10]),
             "Surface readings": len(rr) or num(r[15]),
             "Avg Hg (ppm)": num(r[16]), "Max Hg (ppm)": max(hg) if hg else None,
             "Avg As (ppm)": num(r[17]), "Avg Sb (ppm)": num(r[24]) if len(r) > 24 else None,
             "Avg Pb (ppm)": round(sum(pb) / len(pb), 2) if pb else None,
             "Powder sample": r[19] if r[18] == "Y" else None,
             "NCD file": r[21], "Notes": r[23],
             "GPS elev (as recorded)": el,
             "GPS elev unit": None if el is None else ("m?" if el < 1000 else "ft")}
        pts.append({"id": sid, "x": round(x, 2), "y": round(y, 2),
                    "a": {k: v for k, v in a.items() if v not in (None, "")}})
    write_ds({"id": "xrf_boulders", "defaultOn": False, "name": "XRF — boulders (2026)", "kind": "generic",
              "idField": "Sample ID", "depthField": None,
              "style": {"color": "#E06C9F", "shape": "diamond", "size": 5, "labels": False},
              "source": "Tasks 2.1.6 & 2.1.7 boulder XRF (Niton XL5 Plus), from %s "
                        "(SBMM_XRF_Sample_Tracker_2026-05-08.xlsx): the tracker's own averages, plus the max Hg "
                        "and mean Pb of the surface readings. Positions UTM 10N m -> State Plane through pyproj. "
                        "Field XRF, screening only. Left out, no GPS in the tracker: %s. tools/build_imports.py."
                        % (SOURCES["xrf"], ", ".join(nogps) or "none"),
              "points": pts})


def ds_xrf_soil():
    loc = {}
    for r in xl_rows(os.path.join(IMP, "soilxrf", "SBMM - Additional XRF Locations.xlsx"), "Sheet1", 0):
        if r[1] and str(r[1]).startswith("XRF-") and num(r[2]) and num(r[3]):
            loc[r[1]] = (num(r[3]), num(r[2]), r[4])
    pts = []
    for r in xl_rows(os.path.join(IMP, "soilxrf", "SBMM_NativeVsWaste-Soil_Tracker.xlsx"), "Soil Samples Log", 4):
        sid = r[0]
        if not sid or sid not in loc:
            continue
        lon, lat, depth = loc[sid]
        x, y = ll(lon, lat)
        a = {"Group": {"SWRC": "South Waste Rock Cell (NE corner)", "OMB": "Old Mine Buildings"}.get(r[1], r[1]),
             "Depth": depth, "Date": r[2].date().isoformat() if hasattr(r[2], "date") else r[2],
             "Avg Hg (ppm)": num(r[5]), "Avg As (ppm)": num(r[6]), "Avg Pb (ppm)": num(r[7]),
             "Avg Sb (ppm)": num(r[8]), "Shots": 2, "XRF S/N": r[9], "Mode": r[10], "Notes": r[12],
             "Latitude": lat, "Longitude": lon}
        pts.append({"id": sid, "x": x, "y": y, "a": {k: v for k, v in a.items() if v not in (None, "")}})
    write_ds({"id": "xrf_soil", "defaultOn": False, "name": "XRF — soil, native vs waste (2026)", "kind": "generic",
              "idField": "Sample ID", "depthField": None,
              "style": {"color": "#F2A541", "shape": "triangle", "size": 5, "labels": False},
              "source": "Surface-soil XRF of 4 May 2026 (Niton XL5 Plus X501203, Soils mode, two shots averaged), "
                        "from %s. Field XRF, screening only. tools/build_imports.py." % SOURCES["soilxrf"],
              "points": pts})


def site_areas():
    feats = []
    for f in rd("sbmm-explorer-v2", "boundaries.geojson")["features"]:
        name = f["properties"]["name"]
        if name.lower().startswith("untitled"):
            continue
        g = f["geometry"]
        rings = g["coordinates"] if g["type"] == "Polygon" else [r for poly in g["coordinates"] for r in poly]
        out = []
        for ring in rings[:1] if g["type"] == "Polygon" else rings:
            out.append([list(ll(q[0], q[1])) for q in ring])
        feats.append({"name": name, "rings": out})
    obj = {"built": BUILT, "crs": CRS,
           "source": "Named site areas from SBMM.kmz, via %s (data/boundaries.geojson). Outline only — "
                     "drawn from a KMZ, not surveyed." % SOURCES["sbmm-explorer-v2"],
           "features": feats}
    with open(os.path.join(ROOT, "data", "site_areas.json"), "w") as f:
        json.dump(obj, f, indent=1)
    payload("site_areas", obj)
    return len(feats)


def main():
    check_thresholds()
    tps = rd("sbmm-tool", "test-pits-2025.json")
    sub = {f["properties"]["id"]: f["properties"]["subproject"]
           for f in rd("sbmm-explorer-v2", "borings.geojson")["features"]}
    with open(os.path.join(DSD, "ds_wells.json")) as f:
        wells = json.load(f)
    print("datasets:")
    ds_testpits(tps, sub)
    skipped = ds_borings_hist(wells)
    ds_ea_testpits()
    ds_xrf_boulders()
    ds_xrf_soil()

    holes = boring_metals()
    holes.update(testpit_metals(tps))
    samples = sample_metals()
    lab = {"built": BUILT, "units": "mg/kg",
           "levels": {"ROD": ROD, "PMB": PMB},
           "sources": {"borings": SOURCES["sbmm-tool"] + " data/soil-borings-2025.json",
                       "testpits": SOURCES["sbmm-tool"] + " data/test-pits-2025.json",
                       "samples": SOURCES["abp"] + " abp_samples.geojson + ea_historical_samples.geojson"},
           "holes": holes, "samples": samples}
    with open(os.path.join(ROOT, "data", "lab_metals.json"), "w") as f:
        json.dump(lab, f, indent=1)
    print("payloads:")
    payload("lab_metals", lab)
    n_areas = site_areas()

    ds = all_datasets()
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["datasets"]='
          + json.dumps(ds, separators=(",", ":")) + ';\n')
    with open(os.path.join(OUT, "d_datasets.js"), "w") as f:
        f.write(js)
    print("  d_datasets.js  %.0f kB (%d datasets)" % (len(js) / 1024, len(ds)))
    print("holes with metals: %d borings, %d test pits | samples: %d | site areas: %d | "
          "historical borings already wells here: %d"
          % (sum(1 for h in holes.values() if h["kind"] == "boring"),
             sum(1 for h in holes.values() if h["kind"] == "testpit"), len(samples), n_areas, skipped))


if __name__ == "__main__":
    main()
