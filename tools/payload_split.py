"""v31 — the two split CAD payloads, written in ONE place.

tools/build_cad_native.py, tools/build_cad_surfaces.py and the one-off
tools/split_payloads.py all write through these, so a regeneration and the
migration produce byte-identical files. Standard library only: the builders'
own dependencies (ezdxf, numpy, PIL) are not needed to write a payload.

WHY TWO FILES EACH: the folder build is what the team opens from GitHub Pages,
and the first visit downloaded ~142 MB before the app could start. The halves
written to the *_lazy / *_rasters files are read only on first use, so
index.html loads them AFTER the app is up (js/payloads.js); both single-file
dists inline every half exactly as before.
"""
import json, os


def write_cad_native(datajs, core, lazy_json):
    """d_cad_native.js (the eager core, ~0.8 MB) + d_cad_native_lazy.js (the
    ~21 MB JSON string js/cadnative.js parses on the first enable of a lazy
    group). `core` must not carry `lazy`; it names `lazy_payload` instead."""
    core = dict(core)
    core.pop("lazy", None)
    core["lazy_payload"] = "cad_native_lazy"
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["cad_native"]='
          + json.dumps(core, separators=(",", ":")) + ';\n')
    with open(os.path.join(datajs, "d_cad_native.js"), "w") as f:
        f.write(js)
    lz = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["cad_native_lazy"]='
          + json.dumps(lazy_json) + ';\n')
    with open(os.path.join(datajs, "d_cad_native_lazy.js"), "w") as f:
        f.write(lz)
    print(f"wrote {datajs}/d_cad_native.js  {len(js)/1e6:.2f} MB + "
          f"d_cad_native_lazy.js  {len(lz)/1e6:.2f} MB")


def write_cad_surfaces(datajs, man, rasters):
    """d_cad_surfaces.js (the 18 kB manifest) + d_cad_surfaces_rasters.js (one
    data-URL per surface under the key its raster.payload names)."""
    js = ('window.SBMM_DATA=window.SBMM_DATA||{};SBMM_DATA["cad_surfaces"]='
          + json.dumps(man, separators=(",", ":")) + ';\n')
    with open(os.path.join(datajs, "d_cad_surfaces.js"), "w") as f:
        f.write(js)
    parts = ['window.SBMM_DATA=window.SBMM_DATA||{};']
    for key, url in rasters.items():
        parts.append(f'SBMM_DATA[{json.dumps(key)}]={json.dumps(url)};')
    rj = "\n".join(parts) + "\n"
    with open(os.path.join(datajs, "d_cad_surfaces_rasters.js"), "w") as f:
        f.write(rj)
    print(f"wrote {datajs}/d_cad_surfaces.js  {len(js)/1e6:.3f} MB + "
          f"d_cad_surfaces_rasters.js  {len(rj)/1e6:.2f} MB ({len(rasters)} rasters)")
