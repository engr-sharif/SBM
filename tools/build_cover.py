#!/usr/bin/env python3
"""
Build the land-cover class raster: data/cover.png + data/cover.json
(+ datajs/i_cover_png.js + datajs/d_cover.js).

    python tools/build_cover.py            # the whole 2-ft site grid (~2 min)
    python tools/build_cover.py --no-ortho # skip the green-excess pass (fast, for a smoke test)

WHAT IT IS
----------
One cover class per cell of the `dem_site` grid (2 ft, 4850 x 4450), which is the
grid the drainage map (v14 Phase 1) and the design storm (Phase 2) both work on.
The class chooses the curve number, the Manning n for TR-55 sheet flow and the
Rational C; the class table in data/cover.json carries all of that, so the app
never hard-codes a hydrologic constant.

PRIORITY ORDER (docs/V14_PHASE2_RUNOFF_SPEC.md §1 — highest last, so it wins):

    default grass/weeds
      -> the ortho's green-excess index (vegetated stays grass, bare becomes
         "bare / disturbed")
      -> canopy (CHM >= 6 ft, mine window only)
      -> mine waste: the DU polygons, the traced waste piles and EA's repository
         / stockpile / staging polygons
      -> gravel roads (V-ROAD-GRVL, buffered)
      -> paved roads and concrete (V-ROAD-ASPH / V-SITE-CONC, buffered)
      -> buildings and roofs (EA `bldg` polygons)
      -> open water (EA `water` polygons)

HYDROLOGIC SOIL GROUP is a property of the CLASS here, and that is the ruling
(spec §1): D for mine waste, tailings, waste piles, decision units and compacted
fill; C for everything else. There is no SSURGO on hand, so the "waste" class
carries D and every other class carries C; the app prints both letters on the
card and the dialog can flip a class.

ROADS ARE LINES in EA's CAD, not polygons, so a paved surface has to be given a
width. `ROAD_HALF_FT` below is that assumption (recorded in cover.json), and the
class areas it produces are stated as such.

THE PNG is written as an 8-bit RGB image whose colours ARE the class palette --
one flat colour per class, so it compresses to a few hundred kB, it is what the
map draws as an image overlay with no recolouring, and the node test harness can
read it (test/lib/png.mjs decodes 8-bit RGB/RGBA and nothing else; an indexed
PNG would be unreadable there). Row 0 is NORTH, the same convention as every
other raster in this repo. Cell (i, j) is centred at (x0 + i*cell, y0 + j*cell)
with j counted from the SOUTH, exactly as the DEMs are sampled.
"""
import base64, io, json, math, os, sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "datajs")

# ---------------------------------------------------------------- the classes
# cn: TR-55 table 2-2 (HSG C / HSG D). c: Rational runoff coefficient
# (spec §1). n_sheet: Manning n for TR-55 sheet flow (TR-55 table 3-1).
# paved: 1 selects the paved shallow-concentrated velocity (TR-55 fig 3-1).
CLASSES = [
    dict(id=0, key="nodata", name="Outside the surveyed ground", rgb=[26, 30, 34],
         cn={"C": None, "D": None}, hsg=None, c=None, n_sheet=None, paved=0),
    dict(id=1, key="water", name="Open water", rgb=[74, 155, 232],
         cn={"C": 100, "D": 100}, hsg="C", c=1.00, n_sheet=None, paved=0),
    dict(id=2, key="paved", name="Paved road / concrete", rgb=[122, 126, 132],
         cn={"C": 98, "D": 98}, hsg="C", c=0.95, n_sheet=0.011, paved=1),
    dict(id=3, key="roof", name="Building / roof", rgb=[200, 162, 200],
         cn={"C": 98, "D": 98}, hsg="C", c=0.95, n_sheet=0.011, paved=1),
    dict(id=4, key="gravel", name="Gravel road", rgb=[176, 136, 90],
         cn={"C": 89, "D": 91}, hsg="C", c=0.70, n_sheet=0.050, paved=0),
    dict(id=5, key="waste", name="Mine waste / tailings / decision unit", rgb=[196, 104, 78],
         cn={"C": 91, "D": 94}, hsg="D", c=0.60, n_sheet=0.050, paved=0),
    dict(id=6, key="bare", name="Bare / disturbed ground", rgb=[196, 172, 122],
         cn={"C": 91, "D": 94}, hsg="C", c=0.60, n_sheet=0.050, paved=0),
    dict(id=7, key="grass", name="Grass / weeds, fair", rgb=[124, 180, 96],
         cn={"C": 79, "D": 84}, hsg="C", c=0.35, n_sheet=0.150, paved=0),
    dict(id=8, key="woods", name="Woods / brush, fair", rgb=[58, 112, 70],
         cn={"C": 73, "D": 79}, hsg="C", c=0.25, n_sheet=0.400, paved=0),
]
ID = {c["key"]: c["id"] for c in CLASSES}

ROAD_HALF_FT = {"paved": 8.0, "gravel": 8.0}   # EA draws roads as lines; this is the assumed half-width
GREEN_EXCESS = 12.0        # ExG = 2G - R - B on 0-255 bands; above this a bare cell is called vegetated
CANOPY_MIN_FT = 6.0        # CHM height that counts as woods / brush


def read_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


# --------------------------------------------------------------- rasterising
def poly_mask(mask, rings, cls, meta):
    """Paint closed rings (State Plane ft) into `mask` with a scanline fill."""
    x0, y0, cell, w, h = meta["x0"], meta["y0"], meta["cell"], meta["w"], meta["h"]
    for ring in rings:
        if len(ring) < 3:
            continue
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        j0 = max(0, int(math.floor((min(ys) - y0) / cell)))
        j1 = min(h - 1, int(math.ceil((max(ys) - y0) / cell)))
        for j in range(j0, j1 + 1):
            yc = y0 + j * cell
            xsx = []
            n = len(ring)
            for k in range(n):
                ax, ay = ring[k]
                bx, by = ring[(k + 1) % n]
                if (ay > yc) == (by > yc):
                    continue
                t = (yc - ay) / (by - ay)
                xsx.append(ax + t * (bx - ax))
            if not xsx:
                continue
            xsx.sort()
            for k in range(0, len(xsx) - 1, 2):
                i0 = int(math.ceil((xsx[k] - x0) / cell))
                i1 = int(math.floor((xsx[k + 1] - x0) / cell))
                if i1 < 0 or i0 > w - 1:
                    continue
                mask[j, max(0, i0):min(w - 1, i1) + 1] = cls


def line_mask(mask, lines, half_ft, cls, meta):
    """Paint buffered polylines: every cell whose centre is within `half_ft`."""
    x0, y0, cell, w, h = meta["x0"], meta["y0"], meta["cell"], meta["w"], meta["h"]
    r = half_ft / cell
    rc = int(math.ceil(r)) + 1
    for pts in lines:
        for k in range(len(pts) - 1):
            ax, ay = pts[k][0], pts[k][1]
            bx, by = pts[k + 1][0], pts[k + 1][1]
            ai = (ax - x0) / cell; aj = (ay - y0) / cell
            bi = (bx - x0) / cell; bj = (by - y0) / cell
            i0 = max(0, int(math.floor(min(ai, bi))) - rc); i1 = min(w - 1, int(math.ceil(max(ai, bi))) + rc)
            j0 = max(0, int(math.floor(min(aj, bj))) - rc); j1 = min(h - 1, int(math.ceil(max(aj, bj))) + rc)
            if i1 < i0 or j1 < j0:
                continue
            jj, ii = np.mgrid[j0:j1 + 1, i0:i1 + 1]
            dx = bi - ai; dy = bj - aj
            L2 = dx * dx + dy * dy
            if L2 <= 0:
                d2 = (ii - ai) ** 2 + (jj - aj) ** 2
            else:
                t = np.clip(((ii - ai) * dx + (jj - aj) * dy) / L2, 0.0, 1.0)
                d2 = (ii - (ai + t * dx)) ** 2 + (jj - (aj + t * dy)) ** 2
            sub = mask[j0:j1 + 1, i0:i1 + 1]
            sub[d2 <= r * r] = cls


def decode_terrain_rgb(png_path, meta_json):
    """Terrain-RGB -> float32 grid, row 0 = SOUTH (the app's sampling order)."""
    m = read_json(meta_json)
    im = Image.open(os.path.join(DATA, png_path)).convert("RGB")
    a = np.asarray(im).astype(np.int32)
    v = a[:, :, 0] * 256 + a[:, :, 1]
    z = np.where(v == 0, np.nan, m["zmin"] + (v - 1) * m["step"]).astype(np.float32)
    return np.flipud(z), m          # PNG row 0 is north; flip to south-up


def main():
    no_ortho = "--no-ortho" in sys.argv[1:]
    meta = read_json("dem_site.json")
    w, h, cell, x0, y0 = meta["w"], meta["h"], meta["cell"], meta["x0"], meta["y0"]
    print("cover raster: %d x %d at %g ft (%.1f M cells)" % (w, h, cell, w * h / 1e6))

    cover = np.full((h, w), ID["grass"], dtype=np.uint8)
    gis = read_json("design_gis.json")
    feats = gis["features"]
    src = []

    # ---- the ortho's green-excess split (lowest priority above the default)
    if not no_ortho:
        ob = read_json("ortho_site.json")
        im = Image.open(os.path.join(DATA, "ortho_site.jpg")).convert("RGB")
        ow, oh = im.size
        print("  ortho %d x %d -> green excess" % (ow, oh))
        a = np.asarray(im).astype(np.int16)
        exg = 2 * a[:, :, 1] - a[:, :, 0] - a[:, :, 2]          # row 0 = north
        # nearest-neighbour resample onto the DEM grid (south-up)
        gx = x0 + np.arange(w) * cell
        gy = y0 + np.arange(h) * cell
        oi = np.clip(((gx - ob["x0"]) / (ob["x1"] - ob["x0"]) * (ow - 1)).astype(np.int32), 0, ow - 1)
        oj = np.clip(((ob["y1"] - gy) / (ob["y1"] - ob["y0"]) * (oh - 1)).astype(np.int32), 0, oh - 1)
        veg = exg[np.ix_(oj, oi)] >= GREEN_EXCESS
        cover[~veg] = ID["bare"]
        src.append("ortho_site.jpg (green excess 2G-R-B >= %g)" % GREEN_EXCESS)
        del a, exg, veg

    # ---- canopy: CHM >= 6 ft, inside the mine window only
    if os.path.exists(os.path.join(DATA, "chm.png")):
        chm, cm = decode_terrain_rgb("chm.png", "chm.json")
        ci = np.round((x0 + np.arange(w) * cell - cm["x0"]) / cm["cell"]).astype(np.int64)
        cj = np.round((y0 + np.arange(h) * cell - cm["y0"]) / cm["cell"]).astype(np.int64)
        okI = (ci >= 0) & (ci < cm["w"])
        okJ = (cj >= 0) & (cj < cm["h"])
        sub = chm[np.ix_(np.clip(cj, 0, cm["h"] - 1), np.clip(ci, 0, cm["w"] - 1))]
        inside = np.outer(okJ, okI)
        tall = inside & (np.nan_to_num(sub, nan=-1.0) >= CANOPY_MIN_FT)
        cover[tall] = ID["woods"]
        src.append("chm.png (canopy >= %g ft, mine window only)" % CANOPY_MIN_FT)
        del chm, sub, tall, inside

    # ---- mine waste: the DUs, the traced piles, EA's repository/stockpile/staging
    dus = [d["ring"] for d in read_json("dus.json") if d.get("ring")]
    piles = [p["ring"] for p in read_json("piles.json") if p.get("ring")]
    ea_waste = [f["geometry"]["coordinates"][0] for f in feats
                if f["properties"].get("layer") in ("repo", "staging")
                and f["geometry"]["type"] == "Polygon"]
    poly_mask(cover, dus + piles + ea_waste, ID["waste"], meta)
    src.append("dus.json (%d), piles.json (%d), design_gis repo/staging (%d) -> mine waste, HSG D"
               % (len(dus), len(piles), len(ea_waste)))

    # ---- roads: gravel first, then paved on top
    roads = {"gravel": [], "paved": []}
    for f in feats:
        p = f["properties"]
        if p.get("layer") != "road" or f["geometry"]["type"] != "LineString":
            continue
        lay = (p.get("cad_layer") or "").upper()
        key = "gravel" if "GRVL" in lay or "GRAV" in lay else "paved"
        roads[key].append(f["geometry"]["coordinates"])
    line_mask(cover, roads["gravel"], ROAD_HALF_FT["gravel"], ID["gravel"], meta)
    line_mask(cover, roads["paved"], ROAD_HALF_FT["paved"], ID["paved"], meta)
    src.append("design_gis road lines buffered: %d paved at %g ft, %d gravel at %g ft (half-width)"
               % (len(roads["paved"]), ROAD_HALF_FT["paved"], len(roads["gravel"]), ROAD_HALF_FT["gravel"]))

    # ---- buildings, then open water
    blds = [f["geometry"]["coordinates"][0] for f in feats
            if f["properties"].get("layer") == "bldg" and f["geometry"]["type"] == "Polygon"]
    poly_mask(cover, blds, ID["roof"], meta)
    src.append("design_gis bldg polygons (%d)" % len(blds))
    water = [f["geometry"]["coordinates"][0] for f in feats
             if f["properties"].get("layer") == "water" and f["geometry"]["type"] == "Polygon"]
    poly_mask(cover, water, ID["water"], meta)
    src.append("design_gis water polygons (%d)" % len(water))

    # ---- nodata last: no terrain, no cover
    zsite, _ = decode_terrain_rgb("dem_site.png", "dem_site.json")
    cover[np.isnan(zsite)] = ID["nodata"]
    del zsite

    # ---- the PNG (row 0 = north, flat class colours)
    pal = np.zeros((len(CLASSES), 3), dtype=np.uint8)
    for c in CLASSES:
        pal[c["id"]] = c["rgb"]
    rgb = pal[np.flipud(cover)]
    png = os.path.join(DATA, "cover.png")
    Image.fromarray(rgb, "RGB").save(png, optimize=True, compress_level=9)
    kb = os.path.getsize(png) / 1024
    print("  data/cover.png  %.0f kB" % kb)
    if kb > 1024:
        print("  !! over the 1 MB budget (spec §2) — check the class count")

    counts = np.bincount(cover.ravel(), minlength=len(CLASSES))
    a2 = cell * cell
    areas = {c["key"]: float(counts[c["id"]] * a2) for c in CLASSES}
    surveyed = float((counts.sum() - counts[ID["nodata"]]) * a2)

    # an independent analytic estimate of the paved footprint, for the harness's
    # "the paved class agrees with EA's own geometry" check
    def line_len(ls):
        return sum(math.dist(p[k], p[k + 1]) for p in ls for k in range(len(p) - 1))

    def ring_area(r):
        s = 0.0
        for k in range(len(r)):
            a, b = r[k], r[(k + 1) % len(r)]
            s += a[0] * b[1] - b[0] * a[1]
        return abs(s) / 2

    analytic = {
        "paved_road_ft2": line_len(roads["paved"]) * 2 * ROAD_HALF_FT["paved"],
        "gravel_road_ft2": line_len(roads["gravel"]) * 2 * ROAD_HALF_FT["gravel"],
        "building_ft2": sum(ring_area(r) for r in blds),
        "water_ft2": sum(ring_area(r) for r in water),
        "note": ("length x width for the road lines and the shoelace area for the "
                 "polygons, with no allowance for overlap or for clipping to the "
                 "surveyed ground — an independent check on the rasteriser, not a "
                 "second answer"),
    }

    obj = {
        "source": "SBMM cover raster (docs/V14_PHASE2_RUNOFF_SPEC.md §1), tools/build_cover.py",
        "grid": {"x0": x0, "y0": y0, "cell": cell, "w": w, "h": h},
        "bounds": {"x0": x0 - cell / 2, "y0": y0 - cell / 2,
                   "x1": x0 + (w - 0.5) * cell, "y1": y0 + (h - 0.5) * cell},
        "row0": "north",
        "png": "cover.png",
        "green_excess_threshold": GREEN_EXCESS,
        "canopy_min_ft": CANOPY_MIN_FT,
        "road_half_width_ft": ROAD_HALF_FT,
        "hsg_rule": ("D for mine waste, tailings, waste piles, decision units and compacted "
                     "fill; C for everything else (no SSURGO or infiltration data on hand)"),
        "priority": ["grass (default)", "ortho green excess -> bare", "canopy -> woods",
                     "mine waste", "gravel road", "paved road", "building", "open water"],
        "sources": src,
        "classes": CLASSES,
        "areas_ft2": areas,
        "surveyed_ft2": surveyed,
        "analytic_check": analytic,
    }
    with open(os.path.join(DATA, "cover.json"), "w") as f:
        json.dump(obj, f, indent=1)

    os.makedirs(OUT, exist_ok=True)
    b64 = base64.b64encode(open(png, "rb").read()).decode()
    with open(os.path.join(OUT, "i_cover_png.js"), "w") as f:
        f.write('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["cover_png"]='
                '"data:image/png;base64,%s";\n' % b64)
    with open(os.path.join(OUT, "d_cover.js"), "w") as f:
        f.write('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["cover"]='
                + json.dumps(obj, separators=(",", ":")) + ";\n")

    print("  surveyed %.1f ac" % (surveyed / 43560))
    for c in CLASSES:
        if c["id"] == 0:
            continue
        print("   %-8s %10.2f ac  %5.1f %%  CN %s/%s  HSG %s"
              % (c["key"], areas[c["key"]] / 43560, 100 * areas[c["key"]] / max(surveyed, 1),
                 c["cn"]["C"], c["cn"]["D"], c["hsg"]))
    print("  wrote data/cover.json, datajs/i_cover_png.js, datajs/d_cover.js")


if __name__ == "__main__":
    main()
