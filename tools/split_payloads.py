"""v31 — split the two CAD payloads into a boot half and a deferred half.

One-off migration of the payloads as they stood before v31, so the split did
not need EA's DWGs (which are on the user's machine, not in this repo):

    datajs/d_cad_native.js   -> d_cad_native.js (eager core, ~0.8 MB)
                              + d_cad_native_lazy.js (the 21 MB lazy JSON string)
    datajs/d_cad_surfaces.js -> d_cad_surfaces.js (the 18 kB manifest)
                              + d_cad_surfaces_rasters.js (the 11 MB rasters)

It writes through the SAME functions the two builders now write through
(tools/payload_split.py), so a later regeneration produces byte-identical files.
Running it on an already-split payload is a no-op.

    python3 tools/split_payloads.py
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DJ = os.path.join(ROOT, "datajs")


sys.path.insert(0, os.path.join(ROOT, "tools"))
import payload_split  # noqa: E402


def assignments(path):
    """Every `SBMM_DATA[<key>]=<json>;` in a payload, in order."""
    txt = open(path, encoding="utf-8").read()
    out, dec, i = {}, json.JSONDecoder(), 0
    for m in re.finditer(r'SBMM_DATA\[("[^"]+")\]=', txt):
        if m.start() < i:
            continue
        val, end = dec.raw_decode(txt, m.end())
        out[json.loads(m.group(1))] = val
        i = end
    return out


def main():
    nat = assignments(os.path.join(DJ, "d_cad_native.js"))["cad_native"]
    if "lazy" in nat:
        lazy = nat.pop("lazy")
        nat["lazy_payload"] = "cad_native_lazy"
        payload_split.write_cad_native(DJ, nat, lazy)
    else:
        print("d_cad_native.js is already split")

    sf = assignments(os.path.join(DJ, "d_cad_surfaces.js"))
    man = sf.pop("cad_surfaces")
    if sf:
        payload_split.write_cad_surfaces(DJ, man, sf)
    else:
        print("d_cad_surfaces.js is already split")


if __name__ == "__main__":
    sys.exit(main())
