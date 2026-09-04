#!/usr/bin/env python3
"""
Compile data/ into datajs/*.js payloads that load via <script> tags (file://-safe).

Why: fetch() and canvas pixel-reads of file:// images are blocked by browsers when
index.html is double-clicked. Script tags and data: URLs are not. So every JSON file
becomes `SBMM_DATA["name"]={...}` and every image becomes a base64 data URL.

Run from repo root:  python tools/build_data.py

This builder covers the terrain, imagery, DU/pile/sample and design-sheet payloads
only.  Three payloads are built by their own tools and are NOT regenerated here --
running this script does not refresh them:

    datajs/d_cad_native.js    tools/build_cad_native.py    EA's 110 CAD layers
    datajs/d_cad_surfaces.js  tools/build_cad_surfaces.py  design surfaces (spec section 5)
    datajs/d_cultural.js      tools/build_cultural.py      cultural resources (section 7)

Each of those needs source files that are not in the repo, and each writes its own
datajs/ file directly.  If you change one, run that tool, not this one.
"""
import base64, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT  = os.path.join(ROOT, "datajs")

JSON_FILES = ["affine", "dem_site", "dem_abp", "dem_res", "chm", "contours_site", "contours_abp",
              "dus", "piles", "points", "ortho_abp", "ortho_mine", "ortho_site",
              "design_ea", "design_gis", "sheets_full", "survey_2026"]
# cad_native / cad_surfaces are NOT in JSON_FILES: tools/build_cad_native.py and
# tools/build_cad_surfaces.py write datajs/d_cad_native.js and
# datajs/d_cad_surfaces.js themselves, because both need a shape this generic
# JSON->payload path cannot make (an eager/lazy split, and base64 PNGs inlined
# beside their header). Re-run those two tools to regenerate them.
IMG_FILES  = [("dem_site.png",  "image/png"),
              ("dem_abp.png",   "image/png"),
              ("dem_res.png",   "image/png"),
              ("chm.png",       "image/png"),
              ("hs_site.jpg",   "image/jpeg"),
              ("hs_abp.jpg",    "image/jpeg"),
              ("ortho_abp.jpg", "image/jpeg"),
              ("ortho_mine.jpg","image/jpeg"),
              ("ortho_site.jpg","image/jpeg")]
# EA residential design sheet overlays (north-up State Plane rasters).
# Globbed rather than listed: a sheet added to data/design/ must reach the
# payload, and a hand-maintained list silently drops one (which is exactly how
# a new overlay ends up registered, rendered, and invisible in the app).
DESIGN_DIR = os.path.join(DATA, "design")
if os.path.isdir(DESIGN_DIR):
    IMG_FILES += [(os.path.join("design", f), "image/png")
                  for f in sorted(os.listdir(DESIGN_DIR))
                  if f.startswith("design_") and f.endswith(".png")]
    # Full uncropped plan sheets for the floating sheet viewer (js/sheets.js).
    # Same globbing rule and the same reason: an added sheet must reach the payload.
    IMG_FILES += [(os.path.join("design", f), "image/jpeg")
                  for f in sorted(os.listdir(DESIGN_DIR))
                  if f.startswith("sheet_full_") and f.endswith(".jpg")]


def datasets():
    """Every data/datasets/ds_*.json baked into ONE payload.

    One file rather than one-per-dataset on purpose: index.html's script list is
    maintained by hand, so a per-dataset payload would be exactly the trap the
    design-sheet glob already exists to avoid. Dropping a JSON in data/datasets/
    and re-running this script is the whole procedure (see tools/add_dataset.py).
    """
    d = os.path.join(DATA, "datasets")
    if not os.path.isdir(d):
        return []
    out = []
    for f in sorted(os.listdir(d)):
        if f.startswith("ds_") and f.endswith(".json"):
            with open(os.path.join(d, f)) as fh:
                out.append(json.load(fh))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []

    ds = datasets()
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["datasets"]='
          + json.dumps(ds, separators=(",", ":")) + ';\n')
    with open(os.path.join(OUT, "d_datasets.js"), "w") as f:
        f.write(js)
    manifest.append("d_datasets.js")
    print(f"  d_datasets.js  {len(js)/1024:.0f} kB  "
          f"({len(ds)} dataset{'' if len(ds) == 1 else 's'}, "
          f"{sum(len(x.get('points', [])) for x in ds)} points)")

    for name in JSON_FILES:
        p = os.path.join(DATA, name + ".json")
        if not os.path.exists(p):
            print(f"  skip {name}.json (absent)"); continue
        with open(p) as f: obj = json.load(f)
        js = f'window.SBMM_DATA=window.SBMM_DATA||{{}};SBMM_DATA[{json.dumps(name)}]={json.dumps(obj, separators=(",",":"))};\n'
        fn = f"d_{name}.js"
        with open(os.path.join(OUT, fn), "w") as f: f.write(js)
        manifest.append(fn); print(f"  {fn}  {len(js)/1024:.0f} kB")

    for fname, mime in IMG_FILES:
        p = os.path.join(DATA, fname)
        if not os.path.exists(p):
            print(f"  skip {fname} (absent)"); continue
        b64 = base64.b64encode(open(p, "rb").read()).decode()
        key = os.path.basename(fname).replace(".", "_")
        js = f'window.SBMM_DATA=window.SBMM_DATA||{{}};SBMM_DATA[{json.dumps(key)}]="data:{mime};base64,{b64}";\n'
        fn = f"i_{key}.js"
        with open(os.path.join(OUT, fn), "w") as f: f.write(js)
        manifest.append(fn); print(f"  {fn}  {len(js)/1024:.0f} kB")

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"wrote {len(manifest)} payloads -> datajs/")

if __name__ == "__main__":
    main()
