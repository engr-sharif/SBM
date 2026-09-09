#!/usr/bin/env python3
"""
Build the boring logs from the OpenGround export -- data/borings_logs.json, its
payload datajs/d_borings_logs.js, and the log-derived attributes on the baked
borings dataset data/datasets/ds_borings2025.json.

Input (as delivered, dropped in data/source/borings_openground/ on 2026-09-09):
the per-table CSV export of the 2025 Jacobs geotechnical investigation's 44
soil borings (SB-1 .. SB-46, no SB-27/SB-30, SB-6 is SB-6A). Thirteen tables;
the ones that carry something:

    Location Details                       44 holes: coordinates, elevation, final depth, dates
    Depth Related Exploratory Hole Info    method by depth (hand auger / sonic), logger, driller
    Field Geological Descriptions          526 strata rows, WASTE / NATIVE / BEDROCK in the text
    Standard Penetration Test Results      519 drives: N, "50/5"", REF, recovery
    In Situ Hand Penetrometer Tests        179 pocket-penetrometer readings (tsf)
    Depth Related Remarks                  563 remarks: pH, PP, WC, LL/PI, gradation, DD, Su, ...
    Water Levels and ...                   41 holes: depth at time of drilling or "Not Encountered"
    Casing Diameter by Depth               the hand-auger / 6-in casing intervals
    UnitMappings                           ft, in, %, tsf, psf ...

THE COORDINATES ARE THE BAKED ONES, NOT OPENGROUND'S. OpenGround's Easting /
Northing sit a constant (-3.8, +1.9) ft from the State Plane coordinates in the
December-2025 coordinate spreadsheet the dataset was baked from, while its
latitude / longitude are identical to that spreadsheet's. A uniform 4.2-ft shift
between two projections of one lat/long is a datum realisation difference
(WGS84 vs NAD83(2011) is about 1.2 m in California), and the baked coordinates
are the ones that check against the lidar (README: 0.2 ft median). The offset
is measured on every run and written into the payload beside the hole.

THE CLASS OF A STRATUM IS THE LAST WORD OF ITS DESCRIPTION. The logger ended
every description with WASTE, NATIVE or BEDROCK; a sub-row (a colour change
inside a stratum) that carries no word inherits its stratum's. THE CONTACT THE
APP LEADS WITH IS THE LOGGER'S OWN "@ 23' NATIVE CONTACT" REMARK, which every
one of the 44 holes has; the class profile read off the strata rows at their
finest resolution, and the older field-interpreted waste depth already in the
dataset, are carried beside it and every disagreement is flagged, not resolved
(see the comment above the contacts block in main()).

Run from the repo root:  python3 tools/build_borings.py
Then, if the dataset changed:  python3 tools/build_data.py && python3 tools/build_dist.py
"""
import csv, json, os, re, sys, collections, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "source", "borings_openground")
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "datajs")
DS_PATH = os.path.join(DATA, "datasets", "ds_borings2025.json")

CLASS_RE = re.compile(r"\b(WASTE|NATIVE|BEDROCK)\b\s*\.?\s*$", re.I)
CLASS_ANY_RE = re.compile(r"\b(WASTE|NATIVE|BEDROCK)\b", re.I)


def rd(name):
    p = os.path.join(SRC, name + ".csv")
    with open(p, encoding="utf-8-sig", newline="") as f:
        return [{k: (v or "").strip() for k, v in r.items()} for r in csv.DictReader(f)]


def num(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def r2(v):
    return None if v is None else round(v, 2)


def hole_key(h):
    m = re.match(r"SB-(\d+)([A-Z]?)", h)
    return (int(m.group(1)), m.group(2)) if m else (9999, h)


def fix_method(s):
    s = re.sub(r"\s+", " ", s or "").strip()
    return {"Hand Aguer": "Hand Auger"}.get(s, s)


# ----------------------------------------------------------------- remarks --
# key = value pairs, with the spellings the loggers actually used
KEYS = [
    (r"Liquid Limit \(LL\)|\bLL\b", "LL", None),
    (r"Plasticity Index \(PI\)|Plasticity Index PI|Index \(PI\)|\bPI\b", "PI", None),
    (r"Water Content \(WC\)|Water Contact \(WC\)|\bWC\b", "WC", "%"),
    (r"\bpH\b", "pH", None),
    (r"\bPP\b", "PP", "tsf"),
    (r"\bGravel\b", "Gravel", "%"),
    (r"\bSand\b", "Sand", "%"),
    (r"\b[Ff]ines\b", "Fines", "%"),
    (r"\bDD\b", "DD", "pcf"),
    (r"\bSu\b", "Su", "psf"),
    (r"\bC\b", "C", "psf"),
    (r"\bphi\b", "phi", "deg"),
    (r"\bCc\b", "Cc", None),
    (r"\bCr\b", "Cr", None),
]
KEY_RE = re.compile(
    r"(" + "|".join(k for k, _, _ in KEYS) + r")\s*=\s*(-?\d+(?:\.\d+)?)\s*"
    r"(%|tsf|TSF|psf|pcf|degrees|deg|pH)?", re.I)
INTERVAL_RE = re.compile(r"\(\s*(\d+(?:\.\d+)?)\s*ft\s+to\s+(\d+(?:\.\d+)?)\s*ft\s*\)")
CONTACT_RE = re.compile(r"@\s*(\d+(?:\.\d+)?)\s*'?\s*(NATIVE|WASTE|BEDROCK)\s*CONTACT", re.I)
METHOD_TAG_RE = re.compile(r"(?:,\s*|\s+)(UC|DS|CO|CU|UU)\s*$")
TAG_WORDS = {"UC": "unconfined compression", "DS": "direct shear", "CO": "consolidation",
             "CU": "consolidated undrained", "UU": "unconsolidated undrained"}


def parse_remark(text):
    """-> (tests, contact, note). Every k = v pair becomes a test; what is left is the note."""
    tests = []
    iv = INTERVAL_RE.search(text)
    interval = [float(iv.group(1)), float(iv.group(2))] if iv else None
    tag = METHOD_TAG_RE.search(text)
    method = TAG_WORDS.get(tag.group(1).upper()) if tag else None
    for m in KEY_RE.finditer(text):
        raw_key, val, unit = m.group(1), float(m.group(2)), (m.group(3) or "")
        key = None
        for pat, name, default in KEYS:
            if re.fullmatch(pat, raw_key, re.I):
                key = name
                if not unit or unit.lower() == "ph":
                    unit = default or ""
                break
        if key is None:
            continue
        u = unit.lower()
        if u in ("degrees", "deg"):
            u = "deg"
        if key == "Su" and u == "pcf":
            u = "psf"                      # a typo on the log: Su is a strength
        if u == "tsf":
            u = "tsf"
        t = {"key": key, "value": val, "unit": u or None}
        if method:
            t["method"] = method
        tests.append(t)
    contact = None
    c = CONTACT_RE.search(text)
    if c:
        contact = {"depth": float(c.group(1)), "cls": c.group(2).lower()}
    rest = KEY_RE.sub("", text)
    rest = INTERVAL_RE.sub("", rest)
    rest = CONTACT_RE.sub("", rest)
    rest = METHOD_TAG_RE.sub("", rest)
    rest = re.sub(r"[,\s]+", " ", rest).strip(" ,;")
    note = rest if len(rest) > 2 else None
    return tests, interval, contact, note


# --------------------------------------------------------------------- main --
def main():
    loc = rd("Location Details")
    info = rd("Depth Related Exploratory Hole Information")
    geol = rd("Field Geological Descriptions")
    spt = rd("Standard Penetration Test Results")
    pen = rd("In Situ Hand Penetrometer Tests")
    rem = rd("Depth Related Remarks")
    wat = rd("Water Levels and Boring-Drilling Progress by Time")
    cas = rd("Casing Diameter by Depth")

    with open(DS_PATH) as f:
        ds = json.load(f)
    baked = {p["id"]: p for p in ds["points"]}

    holes = {}
    offsets = []
    for r in loc:
        h = r["Location ID"]
        ex, ny = num(r["Easting"]), num(r["Northing"])
        b = baked.get(h)
        if b is None:
            print(f"  !! {h} is in OpenGround and not in the baked dataset -- placed from OpenGround's own coordinates")
            x, y = ex, ny
        else:
            x, y = b["x"], b["y"]
            if ex is not None and ny is not None:
                offsets.append((ex - x, ny - y))
        holes[h] = {
            "id": h, "x": x, "y": y,
            "og_xy": [ex, ny],
            "elev": num(r["Elevation"]),
            "depth": num(r["Final Depth"]),
            "lat": num(r["Latitude Decimal"]), "lon": num(r["Longitude Decimal"]),
            "date_start": r["Date Start"] or None, "date_end": r["Date End"] or None,
            "checked_by": r["Checked by"] or None,
            "type": r["Location Type"] or None,
            "methods": [], "strata": [], "notes": [], "spt": [], "pen": [], "tests": [],
            "water": None, "casing": [],
        }
    for h in baked:
        if h not in holes:
            print(f"  !! {h} is in the baked dataset and not in OpenGround -- kept as it was")

    # ---- method by depth, logger, driller
    for r in info:
        h = holes.get(r["Location ID"])
        if not h:
            continue
        m = fix_method(r["Method"])
        if not m and not r["Logger"]:
            continue
        rec = {"top": num(r["Depth Top"]), "base": num(r["Depth Base"]), "method": m or None,
               "logger": r["Logger"] or None, "driller": r["Driller Name"] or None,
               "contractor": re.sub(r"Drillling", "Drilling", r["Drilling Contractor"]) or None,
               "equipment": re.sub(r"MidRoto Sonic", "MidRotoSonic", r["Equipment"]) or None,
               "start": r["Date Time Start"] or None, "end": r["Date Time End"] or None}
        h["methods"].append(rec)
    for h in holes.values():
        h["methods"].sort(key=lambda m: (m["top"] if m["top"] is not None else 1e9))
        loggers = [m["logger"] for m in h["methods"] if m["logger"]]
        h["logger"] = max(set(loggers), key=loggers.count) if loggers else None
        h["method_words"] = " / ".join(dict.fromkeys(m["method"] for m in h["methods"] if m["method"]))

    for r in cas:
        h = holes.get(r["Location ID"])
        if h:
            h["casing"].append({"top": num(r["Depth Top"]), "base": num(r["Depth Base"]),
                                "diam_in": num(r["Diameter"]), "note": r["Remarks"] or None})

    # ---- strata
    by = collections.defaultdict(list)
    for r in geol:
        by[r["Location ID"]].append(r)
    n_inherit = n_unknown = 0
    for hid, rows in by.items():
        h = holes.get(hid)
        if not h:
            continue
        rows.sort(key=lambda r: (num(r["Depth Top"]) if num(r["Depth Top"]) is not None else 1e9,
                                 0 if r["USCS"] else 1))
        current = None
        for r in rows:
            top, base = num(r["Depth Top"]), num(r["Depth Base"])
            desc = re.sub(r"\s+", " ", r["Description"]).strip()
            if top is None:
                continue
            if base is None or (base == top and not r["USCS"] and re.match(r"Terminated|Refusal|Boring terminated", desc, re.I)):
                # the termination line: a note, not a layer
                h["notes"].append({"depth": top, "text": desc})
                continue
            m = CLASS_RE.search(desc)
            cls = m.group(1).lower() if m else None
            if cls is None:
                m2 = CLASS_ANY_RE.search(desc)
                cls = m2.group(1).lower() if m2 else None
            explicit = cls is not None
            if cls is None and current and current["top"] <= top and (current["base"] is None or top < current["base"] or top == current["top"]):
                cls = current["cls"]; n_inherit += 1
            if cls is None:
                cls = "unknown"; n_unknown += 1
            text = CLASS_RE.sub("", desc).strip(" ,;")
            s = {"top": top, "base": base, "type": (r["Type"] or None), "cls": cls,
                 "uscs": r["USCS"] or None, "legend": r["Legend Code"] or None,
                 "name": r["Soil Name"] or None, "desc": text,
                 "moisture": r["Moisture"] or None, "plasticity": r["Plasticity"] or None,
                 "primary": bool(r["USCS"]) or r["Boundary"] == "Solid"}
            if not explicit:
                s["cls_inherited"] = True
            h["strata"].append(s)
            if s["primary"] or current is None:
                current = s
    # ---- SPT
    for r in spt:
        h = holes.get(r["Location ID"])
        top = num(r["Depth Top"])
        if not h or top is None:
            continue
        nt = re.sub(r"\s+", "", r["N Value Text"])
        rec = {"top": top, "base": num(r["Depth Base"]), "ref": r["Sample Reference"] or None,
               "n_text": r["N Value Text"] or None, "n": None, "refusal": False,
               "rec_pct": num(r["Recovery"]), "rec_in": num(r["Recovery Length"])}
        if re.fullmatch(r"\d+", nt):
            rec["n"] = int(nt)
        elif re.fullmatch(r'(\d+)/(\d+(?:\.\d+)?)"?', nt):
            m = re.fullmatch(r'(\d+)/(\d+(?:\.\d+)?)"?', nt)
            rec["refusal"] = True
            rec["blows"] = int(m.group(1)); rec["pen_in"] = float(m.group(2))
        elif nt.upper() == "REF":
            rec["refusal"] = True
        blows = [num(r.get("Blows Main %d" % i, "")) for i in (1, 2, 3, 4)]
        blows = [b for b in blows if b is not None]
        if blows:
            rec["blows_6in"] = blows
        h["spt"].append(rec)
    # ---- pocket penetrometer
    for r in pen:
        h = holes.get(r["Location ID"])
        d, v = num(r["Depth"]), num(r["Hand Penetrometer value"])
        if h and d is not None and v is not None:
            h["pen"].append({"depth": d, "tsf": v})
    # ---- remarks -> tests / contacts / notes
    n_tests = 0
    for r in rem:
        h = holes.get(r["Location ID"])
        if not h:
            continue
        d = num(r["Depth Top"])
        tests, interval, contact, note = parse_remark(r["Remarks"])
        for t in tests:
            t["depth"] = d
            if interval:
                t["interval"] = interval
            h["tests"].append(t); n_tests += 1
        if contact:
            h.setdefault("contact_remarks", []).append(contact)
        if note:
            h["notes"].append({"depth": d, "text": note})
    # ---- water
    for r in wat:
        h = holes.get(r["Location ID"])
        if not h:
            continue
        v = num(r["Depth Water value"])
        note = r["Remarks"]
        perched = bool(re.search(r"perched", note, re.I))
        if v is None:
            m = re.search(r"(\d+(?:\.\d+)?)\s*ft", note) or re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*", note)
            if m:
                v = float(m.group(1))
        enc = v is not None
        if re.search(r"not\s+encountered", note, re.I):
            enc = False; v = None
        h["water"] = {"depth": v, "encountered": enc, "perched": perched,
                      "when": r["Date Time"] or None,
                      "event": r["Event Type When Measuring Water Depth"] or None,
                      "note": note or None}

    # ---- contacts, sorting, checks
    #
    # THREE STATEMENTS ABOUT THE WASTE / NATIVE CONTACT LIVE IN THIS EXPORT, and
    # they do not always agree, so all three are carried and the disagreement is
    # flagged rather than resolved here:
    #   (a) the class words on the strata rows, read at the FINEST resolution the
    #       log has -- a sub-row (a colour or consistency change inside a primary
    #       stratum) carries its own WASTE / NATIVE word and overrides the primary
    #       row it sits in (SB-10's primary 7-40 ft says WASTE and its sub-rows
    #       say NATIVE from 30 ft);
    #   (b) the logger's own "@ 23' NATIVE CONTACT" remark, where one was written
    #       (the deepest one when there are two, SB-7);
    #   (c) the older field-interpreted waste depth spreadsheet, already baked
    #       into the dataset as "Interpreted waste depth (ft)".
    # `contacts.native_contact` is (b) where it exists and (a) otherwise, with
    # `source` saying which; the dataset carries all three columns.
    n_gap = 0
    for h in holes.values():
        h["strata"].sort(key=lambda s: (s["top"], 0 if s["primary"] else 1))
        h["spt"].sort(key=lambda s: s["top"]); h["pen"].sort(key=lambda s: s["depth"])
        h["tests"].sort(key=lambda t: (t["depth"] if t["depth"] is not None else 1e9))
        h["notes"].sort(key=lambda n: (n["depth"] if n["depth"] is not None else 1e9))
        S = h["strata"]
        prim = [s for s in S if s["primary"]]
        # (a) the class profile at the finest resolution: elementary intervals
        # between every top and base, each classed by the SMALLEST explicit row
        # covering its midpoint
        ex = [s for s in S if not s.get("cls_inherited") and s["cls"] != "unknown" and s["base"] is not None and s["base"] > s["top"]]
        cuts = sorted(set([s["top"] for s in ex] + [s["base"] for s in ex]))
        prof = []
        for a, b in zip(cuts, cuts[1:]):
            mid = (a + b) / 2
            cov = [s for s in ex if s["top"] <= mid < s["base"]]
            if not cov:
                continue
            best = min(cov, key=lambda s: (s["base"] - s["top"]))
            if prof and prof[-1]["cls"] == best["cls"] and abs(prof[-1]["base"] - a) < 1e-6:
                prof[-1]["base"] = b
            else:
                prof.append({"top": a, "base": b, "cls": best["cls"]})
        h["profile"] = prof
        ws = [p["base"] for p in prof if p["cls"] == "waste"]
        nt = [p["top"] for p in prof if p["cls"] == "native"]
        bt = [p["top"] for p in prof if p["cls"] == "bedrock"]
        classed = bool(prof)
        layered = bool(ws and nt and max(ws) > min(nt) + 1e-6)
        wt = sum(p["base"] - p["top"] for p in prof if p["cls"] == "waste")
        c = {"waste_base_strata": (max(ws) if ws else (0.0 if classed else None)),
             "native_top_strata": (min(nt) if nt else None),
             "bedrock_top": (min(bt) if bt else None),
             "waste_thickness_strata": r2(wt),
             "waste_layered_below_native": layered}
        cr = sorted([x["depth"] for x in h.get("contact_remarks", []) if x["cls"] == "native"])
        if cr:
            c["native_remark"] = cr[-1]
            c["native_remarks_all"] = cr
        # the contact the app leads with
        if cr:
            c["native_contact"] = cr[-1]; c["source"] = "remark"
        elif c["native_top_strata"] is not None:
            c["native_contact"] = c["native_top_strata"]; c["source"] = "strata"
        elif c["waste_base_strata"] is not None:
            c["native_contact"] = c["waste_base_strata"]; c["source"] = "strata"
        else:
            c["native_contact"] = None; c["source"] = None
        flags = []
        if cr and c["native_top_strata"] is not None and abs(c["native_top_strata"] - cr[-1]) > 0.05:
            flags.append("remark and strata differ")
        if layered:
            flags.append("waste logged below native")
        old = baked.get(h["id"], {}).get("a", {}).get("Interpreted waste depth (ft)")
        if old is not None and c["native_contact"] is not None and abs(old - c["native_contact"]) > 0.05:
            flags.append("older interpretation differs")
        c["flags"] = flags
        h["contacts"] = c
        # coverage: do the primary strata tile the hole?
        prev_base = 0.0
        for s in prim:
            if s["top"] > prev_base + 0.05:
                n_gap += 1
            prev_base = max(prev_base, s["base"] or prev_base)
        h["strata_base"] = prev_base

    dx = [o[0] for o in offsets]; dy = [o[1] for o in offsets]
    off = {"n": len(offsets), "dE_mean": r2(sum(dx) / len(dx)), "dN_mean": r2(sum(dy) / len(dy)),
           "dE_range": [r2(min(dx)), r2(max(dx))], "dN_range": [r2(min(dy)), r2(max(dy))]} if offsets else None

    ordered = sorted(holes.values(), key=lambda h: hole_key(h["id"]))
    out = {
        "built": datetime.date.today().isoformat(),
        "source": "OpenGround per-table CSV export of the 2025 Jacobs geotechnical investigation "
                  "(data/source/borings_openground/, dropped 2026-09-09); coordinates from the "
                  "baked dataset (December-2025 coordinate spreadsheet), which check against the lidar.",
        "crs": "EPSG:6418 (NAD83(2011) CA SP Zone 2, ftUS); depths ft bgs; elevations ft NAVD88 as delivered",
        "openground_offset_ft": off,
        "class_rule": "the last word of a primary description (WASTE / NATIVE / BEDROCK); "
                      "sub-rows inherit; contacts are the deepest waste base, the shallowest native top, the shallowest bedrock top",
        "counts": {"holes": len(ordered), "strata": sum(len(h["strata"]) for h in ordered),
                   "spt": sum(len(h["spt"]) for h in ordered), "pen": sum(len(h["pen"]) for h in ordered),
                   "tests": n_tests, "notes": sum(len(h["notes"]) for h in ordered),
                   "water": sum(1 for h in ordered if h["water"]), "inherited_class": n_inherit,
                   "unknown_class": n_unknown, "strata_gaps": n_gap},
        "holes": ordered,
    }
    for h in ordered:
        h.pop("contact_remarks", None)

    # ---- the dataset gains the log-derived attributes
    n_upd = 0
    for p in ds["points"]:
        h = holes.get(p["id"])
        if not h:
            continue
        a = p["a"]
        old_td = a.get("Total depth (ft)")
        if h["depth"] is not None:
            a["Total depth (ft)"] = h["depth"]
        c = h["contacts"]
        a["Native contact (ft)"] = c["native_contact"]
        a["Native contact source"] = c["source"]
        a["Native contact — log remark (ft)"] = c.get("native_remark")
        a["Waste base — log strata (ft)"] = c["waste_base_strata"]
        a["Waste thickness — log strata (ft)"] = c["waste_thickness_strata"]
        a["Bedrock (ft)"] = c["bedrock_top"]
        a["Contact flags"] = "; ".join(c["flags"]) or None
        w = h["water"]
        a["Groundwater (ft bgs)"] = (w["depth"] if w and w["encountered"] else ("not encountered" if w else None))
        a["Drilling method"] = h["method_words"] or None
        a["Drilled"] = h["date_start"]
        a["Logged by"] = h["logger"]
        n_upd += 1
    ds["source"] = re.sub(r"\s*Log-derived.*$", "", ds.get("source", ""))
    ds["source"] += (" Log-derived attributes (total depth, waste base and thickness, native contact, "
                     "bedrock, groundwater, method, dates, logger) from the OpenGround export, tools/build_borings.py.")

    with open(os.path.join(DATA, "borings_logs.json"), "w") as f:
        json.dump(out, f, indent=1)
    with open(DS_PATH, "w") as f:
        json.dump(ds, f, indent=1)
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["borings_logs"]='
          + json.dumps(out, separators=(",", ":")) + ";\n")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "d_borings_logs.js"), "w") as f:
        f.write(js)

    # ---- the report
    print(f"data/borings_logs.json: {out['counts']}")
    print(f"datajs/d_borings_logs.js  {len(js)/1024:.0f} kB; ds_borings2025.json: {n_upd} points updated")
    if off:
        print(f"OpenGround easting/northing vs the baked coordinates: mean ({off['dE_mean']}, {off['dN_mean']}) ft, "
              f"range E {off['dE_range']} N {off['dN_range']} over {off['n']} holes -- the baked ones are kept")
    print("\n  hole    depth  contact src     remark  strata_native  waste_base  bedrock  GW      old_interp  method")
    for h in ordered:
        c = h["contacts"]; a = baked[h["id"]]["a"] if h["id"] in baked else {}
        w = h["water"]
        gw = ("%.1f" % w["depth"] if w and w["encountered"] else ("none" if w else "-"))
        flag = ("  [" + "; ".join(c["flags"]) + "]") if c["flags"] else ""
        print(f"  {h['id']:6s} {h['depth']!s:>6}  {c['native_contact']!s:>7} {c['source']!s:>6}  {c.get('native_remark')!s:>7}  "
              f"{c['native_top_strata']!s:>13}  {c['waste_base_strata']!s:>10}  {c['bedrock_top']!s:>7}  {gw:>6}  "
              f"{a.get('Interpreted waste depth (ft)')!s:>10}  {h['method_words']}{flag}")


if __name__ == "__main__":
    main()
