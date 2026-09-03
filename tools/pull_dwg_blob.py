#!/usr/bin/env python3
"""Pull the single largest `unknown_bits` blob out of a libredwg JSON dump.

libredwg derails on one object in each of EA's Civil 3D drawings and emits the
whole remainder of the AcDbObjects section as that object's `unknown_bits` — in
these files ~183.6 MB of hex.  That blob is where the surface point arrays are,
so getting it out as raw bytes is step one of the recovery.  Line-oriented on
purpose: the dumps are ~400 MB and json.load on one is not worth the memory.

    python3 tools/pull_dwg_blob.py dump.json blob.bin
"""
import sys

src, out = sys.argv[1], sys.argv[2]
best = None
with open(src) as f:
    for line in f:
        s = line.strip()
        if s.startswith('"unknown_bits"'):
            h = s.split(":", 1)[1].strip().strip(",").strip('"')
            if best is None or len(h) > len(best):
                best = h
print("largest unknown_bits hex len", len(best) if best else 0)
if best:
    b = bytes.fromhex(best if len(best) % 2 == 0 else best[:-1])
    with open(out, "wb") as f:
        f.write(b)
    print("wrote", out, len(b))
