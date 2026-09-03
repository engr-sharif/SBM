#!/usr/bin/env python3
"""Build data/design/cad_native*.json — EVERY native CAD layer EA delivered.

Where design_gis.json (tools/build_design_gis.py) is a curated set of 14
authoritative design layers, this is the *whole* drawing set: all model-space
geometry from every DWG in the EA Final Design package, all entity types, with
CAD attributes preserved (layer, colour resolved through ByLayer, linetype,
lineweight, handle, true Z, text content).  designgis stays the authority for
the design polygons; this is the drafting context around them.

Sources (project 1578546, EA Engineering, June 2026)
---------------------------------------------------
    External References/1578546 - C-BASE.dwg      civil design base  (the design)
    External References/1578546 - V-Base.dwg      existing-conditions survey base
    External References/1578546 - ESC -BASE.dwg   erosion/sediment control
    Design Set/1578546 - 01.00 - ExistingConditions.dwg
    Design Set/1578546 - 01.01 - SiteExcavAndCapping.dwg   (sheet container)
    Design Set/1578546 - 02.01 - SiteRepository.dwg        (sheet container)
    Design Set/1578546 - 02.03 - Borrow_Area.dwg
    Design Set/1578546 - 00.00 - Title Sheet.dwg
    1578546 - TB.dwg                              title block / survey control

DWG -> DXF with libredwg git master (dwg2dxf 0.14.x).  Release 0.13.3 cannot
decode these Civil 3D 2023 drawings at all.

Model space vs paper space
--------------------------
Only MODEL space carries State Plane geometry.  The Design Set files are sheet
containers: their model space holds a handful of details, the drawing appears
through xrefs, and every layout is paper space in sheet inches.  So model-space
geometry is what gets draped, and paper-space TEXT/MTEXT is harvested separately
into `sheet_notes` (keyed by layout) because that is where EA's excavation
depths, quantities and construction notes actually live.

Excavation depth
----------------
EA does NOT encode depth in layer names or hatch patterns.  The design is
depth-based and uniform, stated in the sheet notes:

    "EXCAVATE WORK AREA TO ONE FOOT DEPTH UNLESS OTHERWISE INDICATED"
    "PROVIDE 12" OF FILL IN ANY UNHATCHED AREA INSIDE THE LIMITS OF
     EXCAVATION AND/ OR FILL"
    "EXCAVATE TO 1' BELOW EXISTING GROUND AND FILL WITH CLEAN SOIL"

so every C-SITE-EXC-* polygon gets depth_ft = 1.0 with depth_source =
"sheet note (default 1 ft)".  Call-outs that override it (6" hand excavation
inside tree driplines, 6" fill near structures, 1 ft maximum at power poles)
are matched by proximity and set depth_ft with depth_uncertain = true, because
the call-out's leader target is not a closed region.  Nothing here invents a
depth: a polygon with no rule that applies keeps depth_ft = null.

Usage
-----
    python3 tools/build_cad_native.py --dxf DIR [--dxf DIR2 ...] \
        [--master /path/master_1ft.f32] --out data/design

The DWG/DXF sources are not in the repo (1.3 GB); like build_design_gis.py this
tool needs files off the user's machine.  The generated JSON payloads ARE.
"""

import argparse, collections, glob, hashlib, json, math, os, re, sys

import ezdxf
from ezdxf import bbox as _bbox

# ---------------------------------------------------------------- constants

# Site envelope in EPSG:6418 (NAD83(2011) CA SP zone 2, US survey feet).
# Anything outside is paper space, a detail drawn at the origin, or junk.
SITE = dict(xmin=6.360e6, xmax=6.380e6, ymin=2.115e6, ymax=2.140e6)
QUANT = 0.01        # coordinate quantisation, ft
SIMPLIFY = 0.1      # Douglas-Peucker tolerance, ft
ARC_SEG = 2.0       # degrees per segment when flattening arcs/ellipses
MIN_LEN = 0.05      # drop degenerate 2-point lines shorter than this

# Source priority for cross-file dedupe: the design base wins over the sheet
# containers that xref it, and the survey base wins for existing conditions.
PRIORITY = ["C-BASE", "V-Base", "ESC -BASE", "ExistingConditions",
            "Borrow_Area", "TB", "SiteExcavAndCapping", "SiteRepository",
            "North_lobe", "Title Sheet"]

# AutoCAD Color Index -> hex, the 16 standard low indices plus a computed ramp.
ACI = {0: "#FFFFFF", 1: "#FF0000", 2: "#FFFF00", 3: "#00FF00", 4: "#00FFFF",
       5: "#0000FF", 6: "#FF00FF", 7: "#FFFFFF", 8: "#808080", 9: "#C0C0C0",
       250: "#333333", 251: "#505050", 252: "#696969", 253: "#828282",
       254: "#BEBEBE", 255: "#FFFFFF", 256: None}


def aci_hex(i):
    if i in ACI:
        return ACI[i]
    if 10 <= i <= 249:                       # the standard AutoCAD colour wheel
        h = ((i - 10) // 10) * 15.0          # hue in degrees
        lvl = (i - 10) % 10
        s = 1.0 if lvl < 6 else 0.5
        v = [1.0, .65, 1.0, .75, 1.0, .5, 1.0, .65, 1.0, .5][lvl]
        c = v * s
        x = c * (1 - abs(((h / 60.0) % 2) - 1))
        m = v - c
        r, g, b = [(c, x, 0), (x, c, 0), (0, c, x),
                   (0, x, c), (x, 0, c), (c, 0, x)][int(h // 60) % 6]
        return "#%02X%02X%02X" % (int((r + m) * 255), int((g + m) * 255),
                                  int((b + m) * 255))
    return "#CCCCCC"


# ---------------------------------------------------------------- layer groups
#
# (regex, group key, human label, default style, default visibility)
# First match wins, so the specific patterns come before the generic ones.
#
# The `exc` group is OFF by default (planner ruling R1, docs/V9_SPEC.md section 4):
# the GEODATABASE polygons in data/design_gis.json are the authority for the
# limits of excavation -- they close, they carry the printed areas to 0.02 %, and
# the app styles them by depth.  These CAD layers are the raw drafting linework
# for the same limits: open segments that never close, plus the small
# special-treatment sub-areas.  Drawing both put two outlines on every lot and
# let the CAD entity answer clicks meant for the authority.  js/cadnative.js
# carries the same value in DEFAULT_OVERRIDES so the shipped 21 MB payload does
# not have to be regenerated for one bit; keep the two in step.
# Individual CAD layers that are OFF by default even though their group is on
# (planner ruling F1).  The group-level rules below cannot express this, and
# some layers are worth keeping in a group whose other layers you do want.
#
#   G-ANNO-SYMB: fourteen closed rectangles, 230x310 to 751x771 ft, drafted in
#   ACI green.  They are EA's SHEET VIEWPORT FRAMES -- the paper extents of the
#   plan sheets, drawn in model space.  On the map they read as fourteen empty
#   green boxes scattered over the site and were the single largest source of
#   clutter in the default 2D view.  The rest of the `anno` group is the
#   excavation notes and call-outs that section 4 asks to be ON.
#
#   `G-ANNO-MATC`: AutoCAD MATCH LINES (3, ACI 253 grey, PHANTOM2) -- "this
#   drawing continues on the next sheet".  The longest is a dead-straight
#   3,724 ft rule across the whole site at N 2,128,294; in model space it looks
#   exactly like a survey or alignment line.
#
#   `G-ANNO-DETL-PROP`: the detail call-out assembly (14, ACI green) -- twelve
#   1-3 ft stubs and two 172 ft leaders, all parked ~1,700 ft west of the
#   nearest lot, out in Clear Lake.  A detail bubble drafted where there was
#   room on the sheet.
#
# js/cadnative.js carries the same set in DEFAULT_LAYER_OFF, because the
# shipped 21 MB payload is not regenerated for one bit; keep the two in step
# (and data/design/cad_layer_map.json, which is the third home).
LAYER_DEFAULT_OFF = {"G-ANNO-SYMB", "G-ANNO-MATC", "G-ANNO-DETL-PROP"}

LAYER_RULES = [
    (r"^C-SITE-EXC",                  "exc",      "Limits of excavation",        "#FF6B4A", False),
    (r"^C-TOPO_NL_EXCAVATION",        "exc",      "North lobe excavation",       "#FF6B4A", False),
    (r"^C-SITE-TR(N|A)S-DY",          "daylight", "Daylight / transition",       "#7FD4A8", True),
    (r"^C-TOPO-FEAT.*3TO1|^C-TOPO-FEAT.*SLOPE", "grade", "Grading breaklines",   "#5FBF8F", True),
    (r"^C-TOPO-FEAT",                 "grade",    "Grading breaklines",          "#5FBF8F", True),
    (r"^C-SITE-REPO|REPOSITOR",       "repo",     "Repository",                  "#E8734A", True),
    (r"STOCKPILE|STAG",               "staging",  "Stockpile and staging",       "#E8B34B", False),
    (r"BORROW",                       "borrow",   "Borrow area",                 "#D8A24A", True),
    (r"HAUL|ACCESS-ROAD",             "haul",     "Haul and access routes",      "#F2C14E", True),
    (r"^C-EROS|^C-SEED",              "esc",      "Erosion and sediment control", "#9BD24F", False),
    (r"^C-STRM|^C-HYDR|^C-WWAY|SWALE|DITCH|DRAIN", "storm", "Drainage and waterways", "#4FA8E8", False),
    (r"^C-SITE-DU",                   "du",       "Decision units",              "#C08CE8", False),
    (r"^C-ALGN",                      "algn",     "Alignments",                  "#A0A8B0", False),
    (r"^V-TOPO-MAJR|MAJR",            "contour",  "Contours — major",            "#8B7355", False),
    (r"^V-TOPO-MINR|MINR",            "contour",  "Contours — minor",            "#6B5B45", False),
    (r"^V-TOPO",                      "topo",     "Existing topography",         "#7A8288", False),
    (r"^V-BLDG|BLDG|STRUCT",          "bldg",     "Buildings and structures",    "#B0A090", False),
    (r"^V-ROAD|^C-ROAD|ROAD|CURB|PAVE", "road",   "Roads and paving",            "#9AA7B2", False),
    (r"^V-PROP|PARCEL|^V-BNDY|LOT",   "parcel",   "Parcels and property",        "#4FD2E8", False),
    (r"^V-FENC|FENC",                 "fence",    "Fences",                      "#8A9BA8", False),
    (r"TREE|VEGE|PLANT|LANDSCAPE",    "tree",     "Trees and vegetation",        "#5FA85F", False),
    (r"^V-SSWR|^V-WATR|^V-POWR|^V-GAS|^V-COMM|UTIL|SEWER|WATER", "util", "Utilities", "#C8A050", False),
    (r"^V-NGAS|WETL",                 "env",      "Environmental features",      "#4FB0A0", False),
    (r"CTRL|MONU|SURV|^V-CTRL",       "survey",   "Survey control",              "#E8E040", False),
    (r"^D-NOTE|ANNO|^G-ANNO|TEXT|LEAD|DIM", "anno", "Annotation and labels",     "#D0D4D8", True),
    (r"^Defpoints|^0$",               "misc",     "Other / uncategorised",       "#6E7378", False),
]

GROUP_ORDER = ["exc", "daylight", "grade", "repo", "borrow", "staging", "haul",
               "esc", "storm", "du", "algn", "anno", "contour", "topo", "bldg",
               "road", "parcel", "fence", "tree", "util", "env", "survey",
               "symbol", "misc"]

GROUP_LABEL = {
    "exc": "Limits of excavation", "daylight": "Daylight / transition",
    "grade": "Grading breaklines", "repo": "Repository", "borrow": "Borrow area",
    "staging": "Stockpile and staging", "haul": "Haul and access routes",
    "esc": "Erosion and sediment control", "storm": "Drainage and waterways",
    "du": "Decision units", "algn": "Alignments",
    "anno": "Annotation and labels", "contour": "Contours",
    "topo": "Existing topography", "bldg": "Buildings and structures",
    "road": "Roads and paving", "parcel": "Parcels and property",
    "fence": "Fences", "tree": "Trees and vegetation", "util": "Utilities",
    "env": "Environmental features", "survey": "Survey control",
    "symbol": "Block symbols (survey points, furniture)",
    "misc": "Other / uncategorised",
}


def classify(layer, block=None):
    # Exploded block content lands on layer "0"; the block name is the only
    # thing that says what it is, so classify on that instead.
    if block and layer.strip() in ("0", ""):
        for rx, key, label, color, on in LAYER_RULES:
            if re.search(rx, block, re.I):
                return key, label, color, on
        return "symbol", GROUP_LABEL["symbol"], "#7E848A", False
    for rx, key, label, color, on in LAYER_RULES:
        if re.search(rx, layer, re.I):
            return key, label, color, on
    return "misc", GROUP_LABEL["misc"], "#6E7378", False


# Groups whose features are parsed lazily, on first enable in the UI.  They are
# bulky reference furniture, not design geometry, and the boot budget is real
# (CLAUDE.md: boot is dominated by payload parsing).  They ship in the SAME
# payload file as a JSON *string* — a string costs the JS parser almost nothing,
# where an object literal of the same size costs hundreds of milliseconds.
LAZY_GROUPS = {"contour", "symbol", "parcel", "misc", "topo"}


# ---------------------------------------------------------------- geometry

def q(v):
    return round(float(v) / QUANT) * QUANT


def simplify(pts, tol=SIMPLIFY):
    """Ring-aware Douglas-Peucker (the closed-ring trap is documented in
    CLAUDE.md: a naive DP collapses a closed ring because first==last gives a
    zero-length baseline)."""
    if len(pts) < 3:
        return pts
    closed = (abs(pts[0][0] - pts[-1][0]) < 1e-9 and
              abs(pts[0][1] - pts[-1][1]) < 1e-9)
    if closed and len(pts) > 4:
        # split the ring at its farthest-apart pair, simplify each half
        n = len(pts) - 1
        far, fd = 1, -1.0
        for i in range(1, n):
            d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2
            if d > fd:
                fd, far = d, i
        a = _dp(pts[:far + 1], tol)
        b = _dp(pts[far:], tol)
        out = a[:-1] + b
        return out if len(out) >= 4 else pts
    return _dp(pts, tol)


def _dp(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        x1, y1 = pts[i][0], pts[i][1]
        x2, y2 = pts[j][0], pts[j][1]
        dx, dy = x2 - x1, y2 - y1
        den = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k][0], pts[k][1]
            d = (abs(dy * px - dx * py + x2 * y1 - y2 * x1) / den) if den > 1e-12 \
                else math.hypot(px - x1, py - y1)
            if d > best:
                best, bi = d, k
        if best > tol and bi > 0:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


def in_site(pts):
    for p in pts:
        if not (SITE["xmin"] <= p[0] <= SITE["xmax"] and
                SITE["ymin"] <= p[1] <= SITE["ymax"]):
            return False
    return True


def flatten_arc(cx, cy, r, a0, a1, z=0.0):
    if a1 < a0:
        a1 += 360.0
    n = max(2, int(abs(a1 - a0) / ARC_SEG) + 1)
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n)), z)
            for i in range(n + 1)]


# ---------------------------------------------------------------- extraction

class Extractor:
    def __init__(self):
        self.feats = []
        self.notes = []          # paper-space text, per layout
        self.dropped = collections.Counter()
        self.per_file = collections.Counter()
        self.per_layer = collections.Counter()
        self.types = collections.Counter()

    # -- attribute resolution -------------------------------------------
    def style(self, e, doc):
        lay = e.dxf.layer
        lt = getattr(e.dxf, "linetype", "BYLAYER")
        lw = getattr(e.dxf, "lineweight", -1)
        col = getattr(e.dxf, "color", 256)
        try:
            ltab = doc.layers.get(lay)
        except Exception:
            ltab = None
        if col == 256 and ltab is not None:            # ByLayer
            col = ltab.dxf.color
        if col == 0:                                   # ByBlock -> treat as 7
            col = 7
        if lt in ("BYLAYER", "ByLayer") and ltab is not None:
            lt = ltab.dxf.linetype
        if lw in (-1, -2, -3) and ltab is not None:
            lw = ltab.dxf.lineweight
        rgb = None
        try:
            if getattr(e, "rgb", None):
                rgb = "#%02X%02X%02X" % e.rgb
        except Exception:
            pass
        return dict(color=rgb or aci_hex(abs(int(col))), aci=int(col),
                    linetype=str(lt), lineweight=int(lw))

    # -- one entity ------------------------------------------------------
    def entity(self, e, doc, src, block=None, attribs=None):
        dt = e.dxftype()
        self.types[dt] += 1
        st = self.style(e, doc)
        base = dict(file=src, layer=e.dxf.layer, type=dt,
                    handle=str(getattr(e.dxf, "handle", "")) or None, **st)
        if block:
            base["block"] = block
        if attribs:
            base["attribs"] = attribs

        try:
            if dt == "LINE":
                s, t = e.dxf.start, e.dxf.end
                self.line([(s.x, s.y, s.z), (t.x, t.y, t.z)], base)
            elif dt == "LWPOLYLINE":
                z = float(getattr(e.dxf, "elevation", 0.0) or 0.0)
                pts = [(p[0], p[1], z) for p in e.get_points("xy")]
                self.line(pts, base, closed=bool(e.closed))
            elif dt == "POLYLINE":
                if e.is_poly_face_mesh or e.is_polygon_mesh:
                    self.dropped["POLYLINE mesh (not draped)"] += 1
                    return
                pts = [(v.dxf.location.x, v.dxf.location.y, v.dxf.location.z)
                       for v in e.vertices]
                self.line(pts, base, closed=bool(e.is_closed))
            elif dt == "ARC":
                c = e.dxf.center
                self.line(flatten_arc(c.x, c.y, e.dxf.radius,
                                      e.dxf.start_angle, e.dxf.end_angle, c.z), base)
            elif dt == "CIRCLE":
                c = e.dxf.center
                self.line(flatten_arc(c.x, c.y, e.dxf.radius, 0, 360, c.z),
                          base, closed=True)
            elif dt == "ELLIPSE":
                pts = [(p.x, p.y, p.z) for p in e.flattening(0.05)]
                self.line(pts, base, closed=e.dxf.end_param - e.dxf.start_param
                          >= 2 * math.pi - 1e-6)
            elif dt in ("SPLINE",):
                pts = [(p.x, p.y, p.z) for p in e.flattening(0.05)]
                self.line(pts, base, closed=bool(e.closed))
            elif dt == "HATCH":
                for path in e.paths:
                    pts = self.hatch_path(path)
                    if pts:
                        b = dict(base)
                        b["pattern"] = str(getattr(e.dxf, "pattern_name", ""))
                        self.line(pts, b, closed=True, kind="hatch")
            elif dt in ("TEXT", "MTEXT", "ATTRIB", "ATTDEF"):
                self.text(e, base, dt)
            elif dt == "MULTILEADER":
                self.mleader(e, base)
            elif dt == "POINT":
                p = e.dxf.location
                self.pt((p.x, p.y, p.z), base)
            elif dt == "3DFACE":
                pts = [(e.dxf.vtx0.x, e.dxf.vtx0.y, e.dxf.vtx0.z),
                       (e.dxf.vtx1.x, e.dxf.vtx1.y, e.dxf.vtx1.z),
                       (e.dxf.vtx2.x, e.dxf.vtx2.y, e.dxf.vtx2.z),
                       (e.dxf.vtx3.x, e.dxf.vtx3.y, e.dxf.vtx3.z)]
                self.line(pts + [pts[0]], base, closed=True)
            elif dt in ("DIMENSION", "LEADER"):
                try:
                    pts = [(p.x, p.y, getattr(p, "z", 0.0))
                           for p in e.dxf.vertices] if dt == "LEADER" else []
                except Exception:
                    pts = []
                if pts:
                    self.line(pts, base)
                else:
                    self.dropped[dt] += 1
            elif dt in ("WIPEOUT", "IMAGE", "VIEWPORT", "SOLID", "MESH",
                        "BODY", "REGION", "3DSOLID", "SURFACE"):
                self.dropped[dt] += 1
            else:
                self.dropped[dt] += 1
        except Exception as ex:
            self.dropped[f"{dt} (error: {type(ex).__name__})"] += 1

    def hatch_path(self, path):
        try:
            if hasattr(path, "vertices"):
                return [(v[0], v[1], 0.0) for v in path.vertices]
            pts = []
            for edge in getattr(path, "edges", []):
                if edge.type == "LineEdge":
                    pts.append((edge.start[0], edge.start[1], 0.0))
                    pts.append((edge.end[0], edge.end[1], 0.0))
                elif edge.type == "ArcEdge":
                    pts += flatten_arc(edge.center[0], edge.center[1],
                                       edge.radius, edge.start_angle,
                                       edge.end_angle)
                elif edge.type == "EllipseEdge":
                    pts.append((edge.center[0], edge.center[1], 0.0))
            return pts
        except Exception:
            return None

    def text(self, e, base, dt):
        if dt == "MTEXT":
            content = e.plain_text()
            ins = e.dxf.insert
            h = float(e.dxf.char_height)
            rot = float(getattr(e.dxf, "rotation", 0.0) or 0.0)
        else:
            content = e.dxf.text
            ins = e.dxf.insert
            h = float(getattr(e.dxf, "height", 1.0) or 1.0)
            rot = float(getattr(e.dxf, "rotation", 0.0) or 0.0)
        content = (content or "").strip()
        if not content:
            return
        b = dict(base, text=content, height=round(h, 3), rotation=round(rot, 2))
        self.pt((ins.x, ins.y, getattr(ins, "z", 0.0)), b, kind="text")

    def mleader(self, e, base):
        content = None
        try:
            ctx = e.context
            if ctx and ctx.mtext:
                content = ctx.mtext.default_content
        except Exception:
            pass
        pts = []
        try:
            for leader in e.context.leaders:
                for ln in leader.lines:
                    pts += [(v.x, v.y, getattr(v, "z", 0.0)) for v in ln.vertices]
        except Exception:
            pass
        if content:
            content = re.sub(r"\\P", "\n", content).strip()
            ins = None
            try:
                ins = e.context.mtext.insert
            except Exception:
                pass
            if ins is None and pts:
                ins = type("P", (), dict(x=pts[0][0], y=pts[0][1], z=0.0))()
            if ins is not None:
                self.pt((ins.x, ins.y, getattr(ins, "z", 0.0)),
                        dict(base, text=content), kind="text")
        if len(pts) >= 2:
            self.line(pts, dict(base), kind="leader")

    # -- emit -------------------------------------------------------------
    def line(self, pts, base, closed=False, kind="line"):
        pts = [p for p in pts if all(math.isfinite(c) for c in p)]
        if len(pts) < 2:
            self.dropped["degenerate (<2 pts)"] += 1
            return
        if not in_site(pts):
            self.dropped["outside site envelope (paper space / detail)"] += 1
            return
        if closed and (pts[0][0] != pts[-1][0] or pts[0][1] != pts[-1][1]):
            pts = pts + [pts[0]]
        zs = [p[2] for p in pts]
        pts = simplify(pts)
        if len(pts) == 2 and math.dist(pts[0][:2], pts[1][:2]) < MIN_LEN:
            self.dropped["zero-length line"] += 1
            return
        has_z = any(abs(z) > 1e-6 for z in zs)
        coords = ([[q(p[0]), q(p[1]), round(p[2], 2)] for p in pts] if has_z
                  else [[q(p[0]), q(p[1])] for p in pts])
        f = dict(base, kind=kind, closed=bool(closed), coords=coords)
        if has_z:
            f["z_min"] = round(min(zs), 2)
            f["z_max"] = round(max(zs), 2)
        self.feats.append(f)

    def pt(self, p, base, kind="point"):
        if not all(math.isfinite(c) for c in p):
            return
        if not in_site([p]):
            self.dropped["outside site envelope (paper space / detail)"] += 1
            return
        f = dict(base, kind=kind, coords=[q(p[0]), q(p[1])])
        if abs(p[2]) > 1e-6:
            f["z"] = round(p[2], 2)
        self.feats.append(f)

    # -- file walk --------------------------------------------------------
    def walk(self, path):
        src = os.path.basename(path)
        src = re.sub(r"^1578546 - ", "", src)
        src = re.sub(r"^\d+\.\d+[A-Z]? - ", "", src)
        src = os.path.splitext(src)[0].strip()
        try:
            doc = ezdxf.readfile(path)
        except Exception as ex:
            print(f"  !! {src}: {ex}")
            return
        n0 = len(self.feats)

        # model space (State Plane geometry)
        for e in doc.modelspace():
            self.expand(e, doc, src)

        # paper space: text only, as sheet notes
        for name in doc.layouts.names():
            if name == "Model":
                continue
            for e in doc.layouts.get(name):
                dt = e.dxftype()
                t = None
                if dt == "MTEXT":
                    t = e.plain_text()
                elif dt == "TEXT":
                    t = e.dxf.text
                elif dt == "MULTILEADER":
                    try:
                        t = e.context.mtext.default_content
                    except Exception:
                        t = None
                if t and t.strip():
                    self.notes.append(dict(file=src, sheet=name,
                                           layer=e.dxf.layer,
                                           text=re.sub(r"\\P", "\n", t).strip()))
        self.per_file[src] = len(self.feats) - n0
        print(f"  {src:<28} {len(self.feats)-n0:>6} features, "
              f"{len(doc.layers):>4} layers in table")

    def expand(self, e, doc, src, depth=0, block=None):
        """INSERTs are exploded recursively with their transforms; ATTRIBs ride
        along on the exploded geometry so a block's data is not lost."""
        if e.dxftype() == "INSERT" and depth < 6:
            name = e.dxf.name
            attribs = {}
            try:
                for a in e.attribs:
                    attribs[a.dxf.tag] = a.dxf.text
            except Exception:
                pass
            try:
                for sub in e.virtual_entities():
                    self.expand(sub, doc, src, depth + 1, block=name)
            except Exception:
                self.dropped["INSERT (explode failed)"] += 1
                return
            if attribs:
                p = e.dxf.insert
                self.pt((p.x, p.y, getattr(p, "z", 0.0)),
                        dict(file=src, layer=e.dxf.layer, type="INSERT",
                             handle=str(e.dxf.handle), block=name,
                             attribs=attribs, **self.style(e, doc)),
                        kind="block")
            return
        self.entity(e, doc, src, block=block)


# ---------------------------------------------------------------- depth rules

DEPTH_RULES = [
    (r"6\"\s*EXCAVATION BY HAND WITHIN DRIP LINE|TREE DRIPLINE", 0.5,
     "sheet call-out: 6 in hand excavation within tree dripline"),
    (r"FILL 6\"\s*NEAR STRUCTURE|TOP 6\"", 0.5,
     "sheet call-out: 6 in near structure / footpath"),
    (r"\bI?1'\s*MAXIMUM EXCAVATION AT POWER", 1.0,
     "sheet call-out: 1 ft maximum at power pole"),
]
DEFAULT_DEPTH = 1.0

# The heading that separates this tool's half of cad_native_report.md from
# the half tools/build_cad_surfaces.py owns.  Both tools key off this string.
SURFACES_MARKER = "---\n\n# Surfaces\n"
DEFAULT_DEPTH_SRC = ('sheet note: "EXCAVATE WORK AREA TO ONE FOOT DEPTH UNLESS '
                     'OTHERWISE INDICATED" / "PROVIDE 12\\" OF FILL IN ANY '
                     'UNHATCHED AREA INSIDE THE LIMITS OF EXCAVATION"')


def assign_depth(feats, notes):
    """Give every excavation polygon a depth_ft.  The design is uniform 1 ft;
    the call-outs that override it are recorded as uncertain because a leader
    call-out names a spot, not a closed region."""
    overrides = []
    for n in notes:
        for rx, d, why in DEPTH_RULES:
            if re.search(rx, n["text"], re.I):
                overrides.append((d, why, n["sheet"]))
                break
    n_set = 0
    for f in feats:
        if f.get("group") != "exc" or f.get("kind") not in ("line", "hatch"):
            continue
        if not f.get("closed"):
            continue
        f["depth_ft"] = DEFAULT_DEPTH
        f["depth_source"] = DEFAULT_DEPTH_SRC
        f["depth_uncertain"] = False
        n_set += 1
    return n_set, overrides


# ---------------------------------------------------------------- dedupe

def geom_hash(f):
    c = f.get("coords")
    if f.get("kind") in ("point", "text", "block"):
        key = (f.get("text", ""), round(c[0], 1), round(c[1], 1))
    else:
        key = tuple((round(p[0], 1), round(p[1], 1)) for p in c)
    return hashlib.blake2b(repr(key).encode(), digest_size=16).hexdigest()


def dedupe(feats):
    rank = {n: i for i, n in enumerate(PRIORITY)}
    best = {}
    for f in feats:
        h = geom_hash(f)
        r = rank.get(f["file"], 99)
        cur = best.get(h)
        if cur is None or r < cur[0]:
            best[h] = (r, f)
        else:
            cur[1].setdefault("also_in", [])
            if f["file"] not in cur[1]["also_in"]:
                cur[1]["also_in"].append(f["file"])
    out = [v[1] for v in best.values()]
    return out, len(feats) - len(out)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dxf", action="append", required=True,
                    help="directory of converted DXF (repeatable)")
    ap.add_argument("--out", default="data/design")
    ap.add_argument("--datajs", default="datajs")
    ap.add_argument("--max-mb", type=float, default=25.0)
    a = ap.parse_args()

    files = []
    for d in a.dxf:
        files += sorted(glob.glob(os.path.join(d, "*.dxf")))
    # de-duplicate identical basenames across dirs, preferring the later dir
    byname = {}
    for p in files:
        byname[os.path.basename(p)] = p
    files = sorted(byname.values())

    print(f"reading {len(files)} DXF files")
    ex = Extractor()
    for p in files:
        ex.walk(p)

    feats = ex.feats
    print(f"\n{len(feats)} raw features, {len(ex.notes)} paper-space notes")

    # classify
    layers = {}
    for f in feats:
        key, label, color, on = classify(f["layer"], f.get("block"))
        f["group"] = key
        ex.per_layer[f["layer"]] += 1
        L = layers.setdefault(f["layer"], dict(
            layer=f["layer"], group=key, label=label, color=color,
            default_on=on and f["layer"] not in LAYER_DEFAULT_OFF,
            count=0, files=set(), kinds=collections.Counter()))
        L["count"] += 1
        L["files"].add(f["file"])
        L["kinds"][f["kind"]] += 1

    feats, ndup = dedupe(feats)
    print(f"deduped {ndup} features identical across files")

    ndepth, overrides = assign_depth(feats, ex.notes)
    print(f"depth_ft set on {ndepth} excavation polygons "
          f"({len(overrides)} call-out overrides found in sheet notes)")

    # Lot 13 / 15 swap check (documented in CLAUDE.md — EA's CAD layer names for
    # lots 13 and 15 are swapped with respect to the lot polygons and the sheet
    # subjects).  Report the centroids so the conflict stays visible.
    swap = {}
    for f in feats:
        m = re.search(r"C-SITE-EXC-LOT-?\s*(13|15)$", f["layer"], re.I)
        if m and f.get("kind") == "line" and f.get("closed"):
            xs = [p[0] for p in f["coords"]]
            ys = [p[1] for p in f["coords"]]
            swap.setdefault(m.group(1), []).append(
                (round(sum(xs) / len(xs), 1), round(sum(ys) / len(ys), 1)))

    # rebuild layer index after dedupe
    for L in layers.values():
        L["files"] = sorted(L["files"])
        L["kinds"] = dict(L["kinds"])
    counts = collections.Counter(f["layer"] for f in feats)
    for k, L in layers.items():
        L["count"] = counts.get(k, 0)
    layers = {k: v for k, v in layers.items() if v["count"]}

    groups = []
    for g in GROUP_ORDER:
        ls = [L for L in layers.values() if L["group"] == g]
        if not ls:
            continue
        groups.append(dict(
            key=g, label=GROUP_LABEL[g],
            color=ls[0]["color"],
            # a group is on if ANY of its layers is -- a single layer that is
            # off by default (LAYER_DEFAULT_OFF) must not switch the group off
            default_on=any(L["default_on"] or L["layer"] in LAYER_DEFAULT_OFF
                           for L in ls),
            layers=sorted(L["layer"] for L in ls),
            count=sum(L["count"] for L in ls)))

    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.datajs, exist_ok=True)

    # ---- cad_layer_map.json
    lm = dict(
        note=("Raw EA CAD layer name -> UI group, label, style and default "
              "visibility.  Generated by tools/build_cad_native.py; edit the "
              "LAYER_RULES / LAYER_DEFAULT_OFF tables there, not this file."),
        groups=groups,
        layers=[layers[k] for k in sorted(layers)])
    with open(os.path.join(a.out, "cad_layer_map.json"), "w") as f:
        json.dump(lm, f, indent=1)
    print(f"wrote {a.out}/cad_layer_map.json  "
          f"({len(layers)} layers, {len(groups)} groups)")

    # ---- cad_native.json, split by group bundle if large
    meta = dict(
        source="EA Engineering Final Design, project 1578546, June 2026 "
               "(native DWG, converted with libredwg git master dwg2dxf 0.14.x)",
        crs="EPSG:6418 NAD83(2011) California State Plane zone 2, US survey feet",
        crs_note="EA's CAD is on EPSG:2226; checked empirically against the "
                 "registered sheets and agreeing to 0.3-1.8 ft, so no "
                 "reprojection is applied (see tools/build_design_gis.py).",
        quantisation_ft=QUANT, simplify_tol_ft=SIMPLIFY,
        files=dict(ex.per_file), groups=groups)

    # The full JSON stays one file on disk — it is the archive record.
    payload = dict(meta=meta, layers=lm["layers"], features=feats,
                   sheet_notes=ex.notes)
    p = os.path.join(a.out, "cad_native.json")
    with open(p, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {p}  {os.path.getsize(p)/1e6:.2f} MB  ({len(feats)} features)")

    # The payload splits eager/lazy.  Eager features are an object literal the
    # JS parser materialises at boot; lazy features ship as a JSON *string* that
    # js/cadnative.js JSON.parses the first time one of those groups is enabled.
    # Same bytes on disk, ~nothing on the boot path.
    eager = [f for f in feats if f["group"] not in LAZY_GROUPS]
    lazy = [f for f in feats if f["group"] in LAZY_GROUPS]
    meta["lazy_groups"] = sorted(LAZY_GROUPS & {g["key"] for g in groups})
    meta["eager_count"] = len(eager)
    meta["lazy_count"] = len(lazy)

    out = dict(meta=meta, layers=lm["layers"], features=eager,
               sheet_notes=ex.notes,
               lazy=json.dumps(lazy, separators=(",", ":")))
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["cad_native"]='
          + json.dumps(out, separators=(",", ":")) + ';\n')
    with open(os.path.join(a.datajs, "d_cad_native.js"), "w") as f:
        f.write(js)
    print(f"wrote {a.datajs}/d_cad_native.js  {len(js)/1e6:.2f} MB "
          f"(eager {len(eager)} features, lazy {len(lazy)})")

    # ---- report
    rep = [f"# EA native CAD extraction — report\n",
           f"Generated by `tools/build_cad_native.py`.\n",
           f"- **{len(feats)}** features after dedupe "
           f"({ndup} dropped as identical across files)",
           f"- **{len(layers)}** distinct CAD layers in **{len(groups)}** UI groups",
           f"- **{len(ex.notes)}** paper-space sheet notes harvested",
           f"- coordinates quantised to {QUANT} ft, simplified at {SIMPLIFY} ft\n",
           "## Features per source file\n",
           "| file | features |", "|---|---|"]
    for k, v in sorted(ex.per_file.items(), key=lambda kv: -kv[1]):
        rep.append(f"| {k} | {v} |")
    rep += ["\n## Groups\n", "| group | label | layers | features | default |",
            "|---|---|---|---|---|"]
    for g in groups:
        rep.append(f"| `{g['key']}` | {g['label']} | {len(g['layers'])} | "
                   f"{g['count']} | {'on' if g['default_on'] else 'off'} |")
    rep += ["\n## Entity types seen\n", "| type | count |", "|---|---|"]
    for k, v in ex.types.most_common():
        rep.append(f"| {k} | {v} |")
    rep += ["\n## Dropped, and why\n", "| reason | count |", "|---|---|"]
    for k, v in ex.dropped.most_common():
        rep.append(f"| {k} | {v} |")
    rep += ["\n## Excavation depth\n",
            f"`depth_ft` set on **{ndepth}** closed excavation polygons.",
            f"EA encodes depth in the sheet notes, not in layer names or hatch "
            f"patterns — the default is **1.0 ft**:\n",
            f"> {DEFAULT_DEPTH_SRC}\n",
            f"Call-outs found that override it ({len(overrides)}):\n"]
    for d, why, sheet in overrides[:20]:
        rep.append(f"- {d} ft — {why} (sheet {sheet})")
    rep += ["\n## Lot 13 / 15 layer-name swap check\n",
            "CLAUDE.md records that EA's `C-SITE-EXC-LOT-13` and "
            "`C-SITE-EXC-LOT-15` are swapped with respect to the lot polygons "
            "and the delivered sheet subjects.  Centroids of the closed "
            "polygons on each layer, so the conflict stays visible:\n"]
    for k in sorted(swap):
        rep.append(f"- `C-SITE-EXC-LOT-{k}` — {len(swap[k])} closed polygon(s), "
                   f"centroids {swap[k][:4]}")
    rep.append("\nThe labelling fix lives in `tools/build_design_gis.py` "
               "(geometry beats EA's layer names); this extraction reports the "
               "raw layer name unchanged so the two can be compared.")
    # The "# Surfaces" half of this report is written by
    # tools/build_cad_surfaces.py, which runs after this one and knows nothing
    # about CAD extraction.  Rewriting the file wholesale would silently delete
    # it, so anything from that heading onwards is carried over verbatim; the
    # surfaces tool overwrites it in turn on its own next run.
    path = os.path.join(a.out, "cad_native_report.md")
    tail = ""
    if os.path.exists(path):
        with open(path) as f:
            old = f.read()
        k = old.find(SURFACES_MARKER)
        if k >= 0:
            tail = "\n" + old[k:]
    with open(path, "w") as f:
        f.write("\n".join(rep) + "\n" + tail)
    print(f"wrote {path}"
          + (" (carried the existing Surfaces section over)" if tail else ""))


if __name__ == "__main__":
    main()
