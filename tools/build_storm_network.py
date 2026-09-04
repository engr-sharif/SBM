#!/usr/bin/env python3
"""
Build the storm-drainage network — data/storm_network.json and its payload
datajs/d_storm_network.js — from EA's CAD, the geodatabase's storm structures,
Jacobs' August-2026 survey and the user's identification of the south-road
drain (docs/V12_STORM_SPEC.md §1 is the authoritative table; this file is its
executable form).

What it reads
  data/design/cad_native.json   EA V-Base / C-BASE: the V-STRM-STRC storm line
                                (E943C/D/E, E943F/E9440, E9441-E9444), the six
                                V-STRM-MRKG culvert marks, the block geometry of
                                the structures on layer 0 (STRM FES / STRM INLET
                                SQUARE / STRM INLET ROUND), C-STRM-MAIN-PIPE
  data/design_gis.json          the 33 "Storm structure" points of the util layer
                                (the V-STRM-STRC INSERT positions)
  data/survey_2026.json         the two surveyed 24-in HDPE pipes and inverts
  data/dem_*.png + .json        lidar ground, for the direction of the culverts
                                nobody described (higher end -> lower end) and for
                                the report printed at the end. NOT baked into the
                                payload: the app computes rims from SBMM.elev on
                                boot so they follow the DEM stack.
  data/storm_survey.csv         OPTIONAL — the manhole/invert survey when it comes:
                                id, invert_ft, rim_ft, size_in, material, status
                                (any column may be blank). Overrides by node or
                                conduit id. Re-run this tool, then build_dist.

What is inferred, and says so on the feature (`source`):
  frog_green      Frog Pond's outlet end has no CAD structure — the user's Spot 5
  road_drain_*    EA drew the nine grates but no line between them; straight
                  segments between consecutive structures
  pipe_to_main    EA's drawn storm line starts 13 ft west of the surveyed pipe's
                  plotted end; the 13 ft is the connection the user asked for
Nothing here has an invert except the two surveyed pipe nodes. Nothing is
shifted to make the drawing tidy.

Run from the repo root:  python tools/build_storm_network.py
"""
import csv, json, math, os, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT_JSON = os.path.join(DATA, "storm_network.json")
OUT_JS = os.path.join(ROOT, "datajs", "d_storm_network.js")

CAD_PROV = "EA Final Design CAD (V-Base.dwg / C-BASE.dwg, DWG->DXF via libredwg master)"
SURVEY_PROV = "Jacobs, Additional Limited Topographic Survey, Aug 2026 (docs/Sulphur Bank Mine - Additional- (1).pdf)"
USER_PROV = "Identified by the project engineer (Sep 2026) from EA's CAD structures; alignment not drawn in the CAD"

# ---------------------------------------------------------------- terrain ----
class Dem:
    def __init__(self, name):
        from PIL import Image
        import numpy as np
        m = json.load(open(os.path.join(DATA, name + ".json")))
        im = Image.open(os.path.join(DATA, name + ".png")).convert("RGB")
        a = np.asarray(im, dtype=np.int32)
        v = a[:, :, 0] * 256 + a[:, :, 1]
        z = np.where(v == 0, np.nan, m["zmin"] + (v - 1) * m["step"]).astype("float32")
        self.z = z[::-1, :]                       # PNG row 0 = north -> row 0 = south
        self.m = m
    def at(self, x, y):
        m = self.m
        fx = (x - m["x0"]) / m["cell"]; fy = (y - m["y0"]) / m["cell"]
        i = int(math.floor(fx)); j = int(math.floor(fy))
        if i < 0 or j < 0 or i >= m["w"] - 1 or j >= m["h"] - 1: return float("nan")
        a, b, c, d = self.z[j, i], self.z[j, i + 1], self.z[j + 1, i], self.z[j + 1, i + 1]
        vals = [q for q in (a, b, c, d) if not math.isnan(q)]
        if len(vals) < 4: return vals[0] if vals else float("nan")
        u = fx - i; v = fy - j
        return float((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v)

_dems = None
def elev(x, y):
    global _dems
    if _dems is None:
        _dems = [Dem(n) for n in ("dem_abp", "dem_res", "dem_site") if os.path.exists(os.path.join(DATA, n + ".png"))]
    for d in _dems:
        z = d.at(x, y)
        if not math.isnan(z): return z
    return float("nan")

# ---------------------------------------------------------------- helpers ----
def flat(c, out):
    if not c: return
    if isinstance(c[0], (int, float)): out.append(c[:2]); return
    for q in c: flat(q, out)

def dist(a, b): return math.hypot(a[0] - b[0], a[1] - b[1])
def length(pts): return sum(dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
def r2(v): return round(v, 2)

def main():
    cad = json.load(open(os.path.join(DATA, "design", "cad_native.json")))
    feats = cad["features"] if isinstance(cad, dict) else cad
    gis = json.load(open(os.path.join(DATA, "design_gis.json")))
    survey = json.load(open(os.path.join(DATA, "survey_2026.json")))
    byHandle = {f.get("handle"): f for f in feats if f.get("handle")}

    # the structures: the geodatabase points carry the INSERT position, the block
    # geometry on layer 0 says which symbol was drawn there
    blocks = []
    for f in feats:
        b = f.get("block") or ""
        if not b.startswith("STRM"): continue
        pts = []; flat(f.get("coords") or [], pts)
        if pts: blocks.append((b, (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))))
    structs = []
    for f in gis["features"]:
        p = f.get("properties") or {}
        if p.get("name") != "Storm structure": continue
        x, y = f["geometry"]["coordinates"][:2]
        names = sorted(set(b for b, c in blocks if dist(c, (x, y)) < 6))
        structs.append({"x": x, "y": y, "block": names[0] if names else None})
    KIND = {"STRM INLET SQUARE": "grate", "STRM INLET ROUND": "round_inlet", "STRM FES": "fes"}

    nodes, conduits = [], []
    used_struct = set()
    def node(id, kind, x, y, name, **kw):
        n = {"id": id, "kind": kind, "x": r2(x), "y": r2(y), "name": name,
             "invert_ft": kw.get("invert_ft"), "size_in": kw.get("size_in"),
             "cad_block": kw.get("cad_block"), "cad_handle": kw.get("cad_handle"),
             "provenance": kw.get("provenance", CAD_PROV), "note": kw.get("note")}
        nodes.append(n); return n
    def struct_node(id, x, y, name, note=None, provenance=CAD_PROV):
        best = min(structs, key=lambda s: dist((s["x"], s["y"]), (x, y)))
        if dist((best["x"], best["y"]), (x, y)) > 3:
            raise SystemExit(f"no storm structure within 3 ft of {name} at {x},{y}")
        used_struct.add(id_of(best))
        return node(id, KIND.get(best["block"], "fes"), best["x"], best["y"], name,
                    cad_block=best["block"], note=note, provenance=provenance)
    def id_of(s): return (round(s["x"], 1), round(s["y"], 1))
    def conduit(id, frm, to, pts, source, handles=(), **kw):
        c = {"id": id, "from": frm, "to": to, "pts": [[r2(p[0]), r2(p[1])] for p in pts],
             "length_ft": round(length(pts), 1), "size_in": kw.get("size_in"),
             "material": kw.get("material"), "source": source, "cad_handles": list(handles),
             "provenance": kw.get("provenance", CAD_PROV), "note": kw.get("note"),
             "status": "assumed_working"}
        conduits.append(c); return c
    def xy(n): return (n["x"], n["y"])

    # ---- Frog Pond -> Green Pond ---------------------------------------------
    frog = node("frog_outlet", "inferred", 6374418, 2127912, "Frog Pond outlet (inferred)",
                provenance=USER_PROV,
                note="Spot 5: the west shore of Frog Pond. No structure in EA's CAD; the pipe's inlet end is to be surveyed.")
    green_fes = struct_node("green_fes", 6373928.8, 2127878.1, "FES at Green Pond (east shore)",
                            note="Spot 7: the flared end where the Frog Pond pipe discharges into Green Pond.")
    conduit("frog_green", "frog_outlet", "green_fes", [xy(frog), (6374349, 2127915), xy(green_fes)],
            "inferred", provenance=USER_PROV,
            note="The pipe connecting Frog Pond to Green Pond (user, Sep 2026), through Spot 6. Not drawn in the CAD; inverts unknown.")

    # ---- Green Pond riser -> culvert under the road -> toward Herman ----------
    riser = struct_node("green_riser", 6373917.1, 2127966.3, "Round inlet at Green Pond (NW corner)")
    riser_fes = struct_node("green_riser_fes", 6373859.1, 2127987.9, "FES toward Herman (Green Pond culvert)")
    mark = byHandle["E5D2D"]
    conduit("green_riser", "green_riser", "green_riser_fes", [xy(riser), xy(riser_fes)], "cad_mark", ["E5D2D"],
            note="V-STRM-MRKG culvert mark E5D2D, 62 ft under the gravel road between Green Pond and the impoundment.")

    # ---- the south-road drain: nine grates, then the drawn branch -------------
    spots = [(8, 6373831.3, 2127919.1), (9, 6373657.8, 2127751.0), (10, 6373483.9, 2127666.5),
             (11, 6373149.3, 2127447.4), (12, 6372938.3, 2127429.4), (13, 6372790.9, 2127435.7),
             (14, 6372491.9, 2127398.4), (15, 6372095.0, 2127351.9)]
    grates = []
    for k, x, y in spots:
        grates.append(struct_node(f"grate_{k}", x, y, f"Grate inlet — Spot {k}",
                                  note="STRM INLET SQUARE block; one of the nine grates of the south-road drain."))
    for a, b in zip(grates, grates[1:]):
        conduit(f"road_drain_{a['id'].split('_')[1]}_{b['id'].split('_')[1]}", a["id"], b["id"], [xy(a), xy(b)],
                "structures_chain", provenance=USER_PROV,
                note="The culvert along the top of the grates (user, Sep 2026). EA drew the structures, not the line; alignment taken straight between them.")
    bend = node("branch_start", "bend", 6371958.6, 2127426.42, "Branch start (drawn line begins)",
                cad_handle="E943F", note="Spot 16/17: the east end of EA's drawn branch line E943F. No structure drawn here.")
    conduit("road_drain_15_branch", "grate_15", "branch_start", [xy(grates[-1]), xy(bend)], "structures_chain",
            provenance=USER_PROV, note="Straight between the last grate and the start of the drawn branch.")
    junction = struct_node("junction", 6371825.8, 2127494.2, "Junction grate (branch meets the storm main)",
                           note="STRM INLET SQUARE at the end of E943F, on the storm main.")
    e943f = byHandle["E943F"]["coords"]
    conduit("branch", "branch_start", "junction", [xy(bend)] + [tuple(p) for p in e943f[1:-1]] + [xy(junction)],
            "cad_line", ["E943F", "E9440"], note="EA's drawn branch line, 145 ft.")

    # ---- the surveyed Herman discharge pipes ---------------------------------
    pipes = [f for f in survey["features"] if (f.get("properties") or {}).get("layer") == "survey_pipe"]
    pipe_end_n = None
    for f in pipes:
        p = f["properties"]; c = f["geometry"]["coordinates"]
        side = "n" if "North" in p.get("name", "") else "s"
        wall = node(f"herman_pipe_{side}_inv", "pipe_end", c[-1][0], c[-1][1],
                    f"{p['name']} — surveyed invert", invert_ft=p.get("invert_ft"), size_in=p.get("size_in"),
                    provenance=SURVEY_PROV, note="Invert surveyed at the sandbag-wall end.")
        west = node(f"herman_pipe_{side}_end", "pipe_end", c[0][0], c[0][1],
                    f"{p['name']} — plotted west end", size_in=p.get("size_in"), provenance=SURVEY_PROV,
                    note="The plotted extent of the pipe on the survey sheet, not a surveyed point.")
        conduit(f"herman_pipe_{side}", wall["id"], west["id"], [xy(wall), xy(west)], "survey",
                size_in=p.get("size_in"), material=p.get("material"), provenance=SURVEY_PROV,
                note="One of the two 24-in corrugated HDPE barrels through the sandbag wall.")
        if side == "n": pipe_end_n = west
    e943c = byHandle["E943C"]["coords"]
    main_east = node("storm_main_east", "bend", e943c[0][0], e943c[0][1], "Storm main — east end of the drawn line",
                     cad_handle="E943C", note="Where EA's storm line begins, 13 ft west of the surveyed pipe's plotted end.")
    conduit("pipe_to_main", pipe_end_n["id"], "storm_main_east", [xy(pipe_end_n), xy(main_east)], "inferred",
            size_in=24, provenance=USER_PROV,
            note="The connection between the surveyed pipes and EA's drawn storm line (user, Sep 2026): the drawn line starts 13 ft west of the plotted pipe end.")
    # split the main at the junction: the vertex run up to the closest point, then on
    jx = xy(junction)
    best_i, best_d = 0, 1e9
    for i in range(len(e943c) - 1):
        a, b = e943c[i], e943c[i + 1]
        dx, dy = b[0] - a[0], b[1] - a[1]; L2 = dx * dx + dy * dy
        t = max(0, min(1, ((jx[0] - a[0]) * dx + (jx[1] - a[1]) * dy) / L2))
        d = dist(jx, (a[0] + t * dx, a[1] + t * dy))
        if d < best_d: best_d, best_i = d, i
    upper = [tuple(p) for p in e943c[:best_i + 1]] + [jx]
    lower = [jx] + [tuple(p) for p in e943c[best_i + 1:]]
    outfall = node("outfall", "outfall", e943c[-1][0], e943c[-1][1], "Clear Lake outfall (end of the drawn line)",
                   cad_handle="E943C", note="The west end of EA's storm line at the Clear Lake shore. No headwall or FES drawn.")
    conduit("storm_main_upper", "storm_main_east", "junction", upper, "cad_line", ["E943C", "E943D", "E943E", "E9441", "E9442"],
            size_in=24, note=f"EA's storm main, drawn as a 24-in double line with a centreline; the junction grate sits {best_d:.1f} ft off the centreline.")
    conduit("storm_main_lower", "junction", "outfall", lower, "cad_line", ["E943C", "E943D", "E943E", "E9443", "E9444"],
            size_in=24, note="EA's storm main from the junction to the lake.")

    # ---- the culvert south of the road, and every other marked culvert ---------
    def fes_pair(mark_handle, cid, note, prefer=None):
        m = byHandle[mark_handle]["coords"]
        a, b = struct_node(f"{cid}_a", m[0][0], m[0][1], f"FES ({cid})"), struct_node(f"{cid}_b", m[-1][0], m[-1][1], f"FES ({cid})")
        za, zb = elev(*xy(a)), elev(*xy(b))
        frm, to = (a, b) if (prefer == "ab" or (prefer is None and za >= zb)) else (b, a)
        frm["name"] = f"FES — inlet end ({cid})"; to["name"] = f"FES — outlet end ({cid})"
        conduit(cid, frm["id"], to["id"], [xy(frm), xy(to)], "cad_mark", [mark_handle],
                note=note + f" Direction from lidar ground ({za:.1f} -> {zb:.1f} ft)." if prefer is None else note)
    fes_pair("E5D2E", "south_culvert", "V-STRM-MRKG culvert mark E5D2E, 40 ft under the south road; discharges toward the impoundment's south shore. Not part of the grate chain.")
    for h, cid in (("E5D2B", "culvert_north"), ("E5D2C", "culvert_ne"), ("E5D2F", "culvert_sw"), ("E5D30", "culvert_w")):
        fes_pair(h, cid, f"V-STRM-MRKG culvert mark {h}.")
    # unmarked FES pairs (two flared ends within 40 ft = a culvert with no mark)
    free = [s for s in structs if id_of(s) not in used_struct and s["block"] == "STRM FES"]
    k = 0
    while free:
        s = free.pop(0)
        mate = min((t for t in free if dist((s["x"], s["y"]), (t["x"], t["y"])) <= 40), default=None,
                   key=lambda t: dist((s["x"], s["y"]), (t["x"], t["y"])))
        if not mate:
            n = node(f"fes_single_{k}", "fes", s["x"], s["y"], "FES (single, no mate drawn)", cad_block="STRM FES",
                     note="A flared end with no counterpart within 40 ft; the culvert it belongs to is not in the CAD.")
            used_struct.add(id_of(s)); k += 1; continue
        free.remove(mate)
        cid = f"culvert_pair_{k}"; k += 1
        a = node(f"{cid}_a", "fes", s["x"], s["y"], f"FES ({cid})", cad_block="STRM FES")
        b = node(f"{cid}_b", "fes", mate["x"], mate["y"], f"FES ({cid})", cad_block="STRM FES")
        used_struct.add(id_of(s)); used_struct.add(id_of(mate))
        za, zb = elev(*xy(a)), elev(*xy(b))
        frm, to = (a, b) if za >= zb else (b, a)
        frm["name"] = f"FES — inlet end ({cid})"; to["name"] = f"FES — outlet end ({cid})"
        conduit(cid, frm["id"], to["id"], [xy(frm), xy(to)], "cad_pair",
                note=f"Two flared ends {dist(xy(a), xy(b)):.0f} ft apart with no culvert mark; direction from lidar ground ({za:.1f} -> {zb:.1f} ft).")
    # any structure still unused (a lone grate or round inlet) becomes a node
    for s in structs:
        if id_of(s) in used_struct: continue
        node(f"struct_{len(nodes)}", KIND.get(s["block"], "fes"), s["x"], s["y"], f"{s['block'] or 'Storm structure'} (unconnected)",
             cad_block=s["block"], note="EA drew the structure and nothing that connects to it.")

    # ---- the Lot 25 yard drain (C-BASE) ----------------------------------------
    y = byHandle["378C6"]["coords"]
    cb = node("lot25_cb", "grate", y[-1][0], y[-1][1], "Catch basin — Lot 25 yard drain", cad_handle="379EC",
              note="C-STRM-MAIN-PIPE structure symbol at the pipe's east end (C-BASE).")
    yo = node("lot25_out", "pipe_end", y[0][0], y[0][1], "Yard drain outlet — Lot 25", cad_handle="378C8",
              note="The west end of the drawn pipe.")
    conduit("lot25_yard", "lot25_cb", "lot25_out", [tuple(p) for p in reversed(y)], "cad_line", ["378C6", "378C7"],
            note="EA's residential yard drain at Lot 25 (C-BASE C-STRM-MAIN-PIPE), unrelated to the impoundment.")

    # ---- the optional survey overrides -------------------------------------------
    csvp = os.path.join(DATA, "storm_survey.csv")
    overrides = 0
    if os.path.exists(csvp):
        with open(csvp, newline="") as f:
            for row in csv.DictReader(f):
                tid = (row.get("id") or "").strip()
                tgt = next((n for n in nodes if n["id"] == tid), None) or next((c for c in conduits if c["id"] == tid), None)
                if not tgt: print(f"  storm_survey.csv: no node or conduit named {tid!r}"); continue
                for k in ("invert_ft", "rim_ft", "size_in"):
                    if (row.get(k) or "").strip(): tgt[k] = float(row[k])
                for k in ("material", "status"):
                    if (row.get(k) or "").strip(): tgt[k] = row[k].strip()
                tgt["provenance"] = row.get("provenance") or "Jacobs storm-structure survey"
                overrides += 1

    ids = [n["id"] for n in nodes]
    assert len(ids) == len(set(ids)), "duplicate node id"
    for c in conduits:
        assert c["from"] in ids and c["to"] in ids, c["id"]
    cad_n = sum(1 for c in conduits if c["source"] in ("cad_line", "cad_mark", "cad_pair", "survey"))
    inf_n = len(conduits) - cad_n
    out = {
        "source": "EA Final Design CAD (V-STRM-STRC / V-STRM-MRKG / C-STRM-MAIN-PIPE) + the geodatabase storm structures + Jacobs Aug-2026 survey + the project engineer's identification of the south-road drain",
        "crs": "EPSG:6418 (NAD83(2011) CA zone 2, US survey ft)",
        "built": datetime.date.today().isoformat(),
        "spec": "docs/V12_STORM_SPEC.md",
        "nodes": nodes, "conduits": conduits,
        "layers": [
            {"key": "storm_nodes", "name": "Storm structures", "group": "storm", "color": "#7FA7C9", "kind": "point",
             "count": len(nodes), "provenance": CAD_PROV},
            {"key": "storm_cad", "name": "Storm conduits — drawn in CAD / surveyed", "group": "storm", "color": "#7FA7C9", "kind": "line",
             "count": cad_n, "provenance": CAD_PROV},
            {"key": "storm_inferred", "name": "Storm conduits — inferred", "group": "storm", "color": "#7FA7C9", "kind": "line",
             "count": inf_n, "provenance": USER_PROV}
        ]
    }
    with open(OUT_JSON, "w") as f: json.dump(out, f, indent=1)
    js = f'window.SBMM_DATA=window.SBMM_DATA||{{}};SBMM_DATA["storm_network"]={json.dumps(out, separators=(",", ":"))};\n'
    with open(OUT_JS, "w") as f: f.write(js)
    print(f"data/storm_network.json: {len(nodes)} nodes, {len(conduits)} conduits ({cad_n} CAD/survey, {inf_n} inferred), "
          f"{overrides} survey overrides; datajs/d_storm_network.js {len(js)/1024:.0f} kB")
    # the report: every conduit with its lidar fall
    byid = {n["id"]: n for n in nodes}
    for c in conduits:
        a, b = byid[c["from"]], byid[c["to"]]
        za = a["invert_ft"] if a.get("invert_ft") is not None else elev(a["x"], a["y"])
        zb = b["invert_ft"] if b.get("invert_ft") is not None else elev(b["x"], b["y"])
        print(f"  {c['id']:<22} {c['source']:<16} {c['length_ft']:7.1f} ft  {za:8.2f} -> {zb:8.2f}  fall {za - zb:6.2f}  {a['kind']}->{b['kind']}")

if __name__ == "__main__":
    main()
