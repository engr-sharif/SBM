#!/usr/bin/env python3
"""Sweep a libredwg undecoded object-stream blob for Civil 3D TIN vertex runs.

Records are stride-4 little-endian float64 (x, y, z, id64) at an arbitrary
(bit-shift, byte-offset) alignment.  Earlier passes tested bit shifts OR byte
offsets; the arrays sit at the *product* of the two, so all 64 combinations are
swept.  Contiguous stride-4 runs are then segmented so that distinct surfaces
(which sit in distinct objects, hence distinct runs) come out separately.

Usage
-----
    dwgread -O JSON -o dump.json drawing.dwg          # libredwg git master
    python3 tools/pull_dwg_blob.py dump.json blob.bin # the one giant object
    python3 tools/scan_dwg_surfaces.py blob.bin TAG

Writes TAG_runs.npy (columns x, y, z, id64, run_index) and TAG_runs.json.
The surface point arrays that come out feed tools/build_cad_surfaces.py --tin.
"""
import sys, json
import numpy as np

XLO, XHI = 6.3600e6, 6.3800e6
YLO, YHI = 2.1150e6, 2.1400e6
ZLO, ZHI = 1150.0, 1750.0
MINRUN = 200          # records; below this it is noise


def shifted(b, bit):
    if not bit:
        return b
    nxt = np.empty_like(b)
    nxt[:-1] = b[1:]
    nxt[-1] = 0
    return (((b.astype(np.uint16) << bit) | (nxt.astype(np.uint16) >> (8 - bit)))
            & 0xFF).astype(np.uint8)


def runs_at(d, base_bit, base_byte):
    """d: float64 view.  Return list of runs (start_index, n, points array)."""
    n = len(d)
    if n < 8:
        return []
    x = d[0:n - 3]
    y = d[1:n - 2]
    z = d[2:n - 1]
    ok = ((x > XLO) & (x < XHI) & (y > YLO) & (y < YHI) &
          (z > ZLO) & (z < ZHI))
    idx = np.nonzero(ok)[0]
    if len(idx) < MINRUN:
        return []
    # keep only starts on a stride-4 lattice consistent with their neighbours:
    # split idx into maximal arithmetic runs of common difference 4
    out = []
    diffs = np.diff(idx)
    brk = np.nonzero(diffs != 4)[0]
    starts = np.concatenate([[0], brk + 1])
    ends = np.concatenate([brk + 1, [len(idx)]])
    for s, e in zip(starts, ends):
        cnt = e - s
        if cnt < MINRUN:
            continue
        sel = idx[s:e]
        P = np.column_stack([d[sel], d[sel + 1], d[sel + 2], d[sel + 3]])
        out.append((int(sel[0]), int(cnt), P))
    return out


def main():
    path, tag = sys.argv[1], sys.argv[2]
    b = np.fromfile(path, dtype=np.uint8)
    print(f"{tag}: {len(b)} bytes", flush=True)
    found = []
    for bit in range(8):
        a = shifted(b, bit)
        for byte in range(8):
            m = (len(a) - byte) // 8 * 8
            if m <= 0:
                continue
            d = a[byte:byte + m].view("<f8")
            rr = runs_at(d, bit, byte)
            for st, cnt, P in rr:
                found.append(dict(bit=bit, byte=byte, start=st, n=cnt, P=P))
            if rr:
                print(f"  bit={bit} byte={byte}: {len(rr)} runs, "
                      f"{sum(r[1] for r in rr)} records", flush=True)
        del a
    if not found:
        print("  no runs")
        return
    found.sort(key=lambda r: -r["n"])
    print(f"\n{tag}: {len(found)} runs total, "
          f"{sum(r['n'] for r in found)} records\n")
    meta = []
    for i, r in enumerate(found[:40]):
        P = r["P"]
        ids = P[:, 3]
        # id column: is it monotone / small-integer-like?
        idm = float(np.mean(np.diff(ids) > 0)) if len(ids) > 1 else 0.0
        m = dict(rank=i, bit=r["bit"], byte=r["byte"], start=r["start"],
                 n=int(r["n"]),
                 xmin=round(float(P[:, 0].min()), 2),
                 xmax=round(float(P[:, 0].max()), 2),
                 ymin=round(float(P[:, 1].min()), 2),
                 ymax=round(float(P[:, 1].max()), 2),
                 zmin=round(float(P[:, 2].min()), 2),
                 zmax=round(float(P[:, 2].max()), 2),
                 id_frac_increasing=round(idm, 3),
                 id_min=float(ids.min()), id_max=float(ids.max()))
        meta.append(m)
        print(f"  #{i:<3d} bit{r['bit']} byte{r['byte']} @{r['start']:<12d} "
              f"n={r['n']:<8d} x[{m['xmin']:.0f},{m['xmax']:.0f}] "
              f"y[{m['ymin']:.0f},{m['ymax']:.0f}] z[{m['zmin']:.1f},{m['zmax']:.1f}] "
              f"idinc={idm:.2f}", flush=True)
    big = [r for r in found if r["n"] >= 2000]
    if big:
        np.save(f"{tag}_runs.npy",
                np.concatenate([np.column_stack([r["P"],
                                                 np.full(len(r["P"]), k)])
                                for k, r in enumerate(big)]))
        print(f"\nsaved {tag}_runs.npy ({len(big)} runs >= 2000 recs, "
              f"col4 = run index)")
    with open(f"{tag}_runs.json", "w") as f:
        json.dump(meta, f, indent=1)


if __name__ == "__main__":
    main()
