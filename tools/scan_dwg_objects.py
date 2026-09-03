#!/usr/bin/env python3
"""Scan every `unknown_bits` blob of a libredwg JSON dump for TIN vertex runs.

Complements scan_surfaces.py, which sweeps the one giant undecoded blob.  This
one covers the objects libredwg *did* decode but whose payload it could not
interpret — a Civil 3D surface can land in either place.

Usage
-----
    python3 tools/scan_dwg_objects.py dump.json TAG

Writes TAG_objruns.npy and TAG_objruns.json.
"""
import json, sys, collections
import numpy as np

XLO, XHI = 6.3600e6, 6.3800e6
YLO, YHI = 2.1150e6, 2.1400e6
ZLO, ZHI = 1150.0, 1750.0
MINRUN = 40


def shifted(a, bit):
    if not bit:
        return a
    nxt = np.empty_like(a)
    nxt[:-1] = a[1:]
    nxt[-1] = 0
    return (((a.astype(np.uint16) << bit) | (nxt.astype(np.uint16) >> (8 - bit)))
            & 0xFF).astype(np.uint8)


def runs(d):
    n = len(d)
    if n < 8:
        return []
    ok = ((d[0:n-3] > XLO) & (d[0:n-3] < XHI) &
          (d[1:n-2] > YLO) & (d[1:n-2] < YHI) &
          (d[2:n-1] > ZLO) & (d[2:n-1] < ZHI))
    idx = np.nonzero(ok)[0]
    if len(idx) < MINRUN:
        return []
    out = []
    for stride in (4, 3):
        df = np.diff(idx)
        brk = np.nonzero(df != stride)[0]
        starts = np.concatenate([[0], brk + 1])
        ends = np.concatenate([brk + 1, [len(idx)]])
        for s, e in zip(starts, ends):
            if e - s < MINRUN:
                continue
            sel = idx[s:e]
            out.append((stride, np.column_stack([d[sel], d[sel+1], d[sel+2]])))
        if out:
            break
    return out


def objects(path):
    buf = None
    with open(path) as f:
        for line in f:
            if line.startswith('    {'):
                buf = [line]
            elif buf is not None:
                buf.append(line)
                if line.startswith('    }'):
                    s = ''.join(buf).rstrip().rstrip(',')
                    buf = None
                    try:
                        yield json.loads(s)
                    except Exception:
                        pass


def main():
    src, tag = sys.argv[1], sys.argv[2]
    per = collections.Counter()
    keep = []
    nobj = 0
    for o in objects(src):
        nobj += 1
        h = o.get('unknown_bits')
        if not h or len(h) < 4000:
            continue
        if len(h) > 60_000_000:      # the giant blob, handled by scan_surfaces
            print(f"  [skip giant {len(h)//2} B object type={o.get('type')}]",
                  flush=True)
            continue
        raw = np.frombuffer(bytes.fromhex(h if len(h) % 2 == 0 else h[:-1]),
                            dtype=np.uint8)
        best = None
        for bit in range(8):
            a = shifted(raw, bit)
            for byte in range(8):
                m = (len(a) - byte) // 8 * 8
                if m <= 0:
                    continue
                for stride, P in runs(a[byte:byte+m].view('<f8')):
                    if best is None or len(P) > len(best[2]):
                        best = (bit, byte, P, stride)
        if best:
            bit, byte, P, stride = best
            per[o.get('type')] += len(P)
            keep.append(dict(type=o.get('type'), handle=o.get('handle'),
                             bit=bit, byte=byte, stride=stride, P=P))
            print(f"  {o.get('type')} h={o.get('handle')} bit{bit} byte{byte} "
                  f"stride{stride} n={len(P)} "
                  f"x[{P[:,0].min():.0f},{P[:,0].max():.0f}] "
                  f"y[{P[:,1].min():.0f},{P[:,1].max():.0f}] "
                  f"z[{P[:,2].min():.1f},{P[:,2].max():.1f}]", flush=True)
    print(f"\n{tag}: {nobj} objects scanned; hits by class: {dict(per)}")
    if keep:
        np.save(f"{tag}_objruns.npy",
                np.concatenate([np.column_stack([k["P"],
                                                 np.full(len(k["P"]), i)])
                                for i, k in enumerate(keep)]))
        with open(f"{tag}_objruns.json", "w") as f:
            json.dump([{kk: vv for kk, vv in k.items() if kk != "P"}
                       | dict(n=len(k["P"]),
                              bbox=[round(float(k["P"][:, c].min()), 2)
                                    for c in range(3)] +
                                   [round(float(k["P"][:, c].max()), 2)
                                    for c in range(3)])
                       for k in keep], f, indent=1)
        print(f"saved {tag}_objruns.npy / .json ({len(keep)} objects)")


if __name__ == "__main__":
    main()
