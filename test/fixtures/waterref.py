"""Reference implementation of docs/V10_WATER_SPEC.md section 2 (raindrop with ponds, overtop).
Pure python + numpy; slow but independent of the JS kernels. Row 0 = north in the arrays here.
Usage: python waterref.py drops | herman
"""
import json, heapq, sys, numpy as np

SC = '/tmp/claude-0/-home-user-SBM/63f85d97-7536-5128-ab20-1c10e66fbf18/scratchpad/'
R = '/home/user/SBM/'
NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
NBD = [np.hypot(a, b) for a, b in NB]


def load_window(name):
    m = json.load(open(SC + name + '.json'))
    z = np.fromfile(SC + name + '.f32', dtype=np.float32).reshape(m['sh'], m['sw'])[::-1, :].astype(np.float64)
    X = m['x0'] + (m['i0'] + np.arange(m['sw']) + 0.5) * m['cell']
    Y = m['y0'] + (m['j0'] + m['sh'] - np.arange(m['sh']) - 0.5) * m['cell']
    return m, z, X, Y


def trace(z, X, Y, r, c, cell, F=None, minPondDepth=0.25, pondId=None, ponds=None, maxSteps=4000000):
    """Spec 2 (final): D8 on EFFECTIVE elevation (a pond cell reads as its level); a pit floods
    (priority flood) until a dry neighbour below the level ESCAPES (F <= level, i.e. it drains
    to a sink); cells below the level are then completed into the pond; stepping into an
    older pond leaves at that pond's outlet. F = filled DEM from fill_dem()."""
    h, w = z.shape
    nod = np.isnan(z)
    if F is None:
        F = fill_dem(z)
    if pondId is None:
        pondId = np.zeros(z.shape, np.int32)
    if ponds is None:
        ponds = {}
    path = [(r, c)]
    reason = None; steps = 0; exit_rc = None
    nextId = max(ponds.keys()) + 1 if ponds else 1

    def eff(rr, cc):
        k = pondId[rr, cc]
        return ponds[k]['level'] if k else z[rr, cc]

    def steepest(r, c):
        best = None; ze = eff(r, c)
        for (dr, dc), d in zip(NB, NBD):
            rr, cc = r + dr, c + dc
            if not (0 <= rr < h and 0 <= cc < w):
                continue
            if nod[rr, cc]:
                return ('nodata', rr, cc)
            drop = (ze - eff(rr, cc)) / d
            if drop > 1e-9 and (best is None or drop > best[0]):
                best = (drop, rr, cc)
        return best

    while steps < maxSteps:
        steps += 1
        if r in (0, h - 1) or c in (0, w - 1):
            reason = 'window'; exit_rc = (r, c); break
        b = steepest(r, c)
        if b and b[0] == 'nodata':
            path.append((b[1], b[2])); reason = 'nodata'; break
        if b:
            rr, cc = b[1], b[2]
            k = pondId[rr, cc]
            if k:
                path.append((rr, cc))
                if ponds[k]['outlet'] is None:
                    reason = 'pond'; break
                r, c = ponds[k]['outlet']
                path.append((r, c))
                continue
            r, c = rr, cc
            path.append((r, c))
            continue
        # pit: flood until an escaping neighbour appears
        k = nextId; nextId += 1
        P = ponds[k] = dict(level=float(z[r, c]), outlet=None, cells=[], zmin=float(z[r, c]), entry=(r, c))
        heap = [(z[r, c], r, c)]
        level = z[r, c]; outlet = None
        while heap:
            zz, ur, uc = heapq.heappop(heap)
            if pondId[ur, uc]:
                continue
            level = max(level, zz)
            pondId[ur, uc] = k; P['cells'].append((ur, uc)); P['zmin'] = min(P['zmin'], z[ur, uc])
            if ur in (0, h - 1) or uc in (0, w - 1):
                reason = 'window'; exit_rc = (ur, uc); break
            esc = None
            for (dr, dc), d in zip(NB, NBD):
                vr, vc = ur + dr, uc + dc
                if not (0 <= vr < h and 0 <= vc < w):
                    continue
                if nod[vr, vc]:
                    esc = ('nodata', vr, vc); break
                if pondId[vr, vc]:
                    continue
                if z[vr, vc] < level - 1e-9 and F[vr, vc] < level - 1e-6:
                    drop = (level - z[vr, vc]) / d
                    if esc is None or drop > esc[0]:
                        esc = (drop, vr, vc)
            if esc is not None and esc[0] == 'nodata':
                path.append((esc[1], esc[2])); reason = 'nodata'; break
            if esc is not None:
                outlet = (esc[1], esc[2]); break
            for dr, dc in NB:
                vr, vc = ur + dr, uc + dc
                if 0 <= vr < h and 0 <= vc < w and not nod[vr, vc] and not pondId[vr, vc]:
                    heapq.heappush(heap, (z[vr, vc], vr, vc))
        # complete the pond (sealed): every remaining frontier cell at or below the level is under
        # water unless it escapes (then it is a wall). Never cross an escaping cell.
        if outlet is not None:
            while heap and heap[0][0] <= level + 1e-9:
                zz, ur, uc = heapq.heappop(heap)
                if pondId[ur, uc]:
                    continue
                if z[ur, uc] < level - 1e-9 and F[ur, uc] < level - 1e-6:
                    continue                                   # escaping: wall
                pondId[ur, uc] = k; P['cells'].append((ur, uc)); P['zmin'] = min(P['zmin'], z[ur, uc])
                for dr, dc in NB:
                    vr, vc = ur + dr, uc + dc
                    if 0 <= vr < h and 0 <= vc < w and not nod[vr, vc] and not pondId[vr, vc] and z[vr, vc] <= level + 1e-9:
                        heapq.heappush(heap, (z[vr, vc], vr, vc))
        P['level'] = float(level); P['outlet'] = outlet
        if reason:
            break
        if outlet is None:
            reason = 'pond'; break
        r, c = outlet
        path.append((r, c))
    if not reason:
        reason = 'steps'
    pts = [(float(X[cc]), float(Y[rr]), float(z[rr, cc]) if not nod[rr, cc] else float('nan')) for rr, cc in path]
    L = sum(np.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) for i in range(1, len(pts)))
    rep = []
    for k, p in sorted(ponds.items()):
        if 'entry' not in p or not p['cells']:
            continue
        depth = p['level'] - p['zmin']
        if depth < minPondDepth:
            continue
        vol = float(sum(p['level'] - z[a, b_] for a, b_ in p['cells']) * cell * cell)
        rep.append(dict(level=round(p['level'], 2), depth_ft=round(depth, 2), cells=len(p['cells']),
                        area_ft2=len(p['cells']) * cell * cell, volume_ft3=round(vol, 1)))
    return dict(n=len(pts), length_ft=round(float(L), 1), start=pts[0], end=pts[-1], reason=reason,
                ponds=rep, pts=pts, pondId=pondId, pondsRaw=ponds,
                exit=(float(X[exit_rc[1]]), float(Y[exit_rc[0]])) if exit_rc else None)


def fill_dem(z):
    """Barnes priority flood from the sinks (NoData + window edge)."""
    h, w = z.shape
    nod = np.isnan(z)
    F = np.full(z.shape, np.nan); done = nod.copy(); heap = []
    for r in range(h):
        for c in range(w):
            if nod[r, c]:
                continue
            edge = r in (0, h - 1) or c in (0, w - 1)
            if not edge:
                for dr, dc in NB:
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < h and 0 <= cc < w and nod[rr, cc]:
                        edge = True; break
            if edge:
                heapq.heappush(heap, (z[r, c], r, c))
    while heap:
        lv, r, c = heapq.heappop(heap)
        if done[r, c]:
            continue
        done[r, c] = True; F[r, c] = lv
        for dr, dc in NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and not done[rr, cc]:
                heapq.heappush(heap, (max(z[rr, cc], lv), rr, cc))
    return F


def pip(px, py, poly):
    x = poly[:, 0]; y = poly[:, 1]; n = len(poly); inside = np.zeros(px.shape, bool); j = n - 1
    for i in range(n):
        inside ^= ((y[i] > py) != (y[j] > py)) & (px < (x[j] - x[i]) * (py - y[i]) / (y[j] - y[i] + 1e-12) + x[i]); j = i
    return inside


def overtop(z, X, Y, cell, ring, plateauTol=0.3, rimRange=3.0, levelStep=0.25):
    h, w = z.shape; nod = np.isnan(z)
    XX, YY = np.meshgrid(X, Y)
    inside = pip(XX, YY, ring)
    zi = z[inside]; z0 = float(np.median(zi[~np.isnan(zi)]))
    seed = inside & (np.abs(z - z0) <= plateauTol)
    F = fill_dem(z)
    flooded = seed.copy(); level = np.where(seed, z0, np.nan); wall = np.zeros(z.shape, bool)
    heap = []
    for r, c in zip(*np.where(seed)):
        for dr, dc in NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and not flooded[rr, cc] and not nod[rr, cc]:
                heapq.heappush(heap, (z[rr, cc], rr, cc))
    cur = z0; spills = []; primary = None; primary_next = None
    while heap:
        zz, r, c = heapq.heappop(heap)
        if flooded[r, c] or wall[r, c]:
            continue
        cur = max(cur, zz)
        esc = False; best = None
        for dr, dc in NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and not flooded[rr, cc] and not nod[rr, cc] \
                    and z[rr, cc] < cur - 1e-9 and F[rr, cc] < cur - 1e-6:
                esc = True; wall[rr, cc] = True
                if best is None or z[rr, cc] < z[best[0], best[1]]:
                    best = (rr, cc)
        flooded[r, c] = True; level[r, c] = cur
        if esc:
            spills.append((cur, r, c))
            if primary is None:
                primary = (cur, r, c); primary_next = best
        for dr, dc in NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and not flooded[rr, cc] and not nod[rr, cc] and not wall[rr, cc]:
                heapq.heappush(heap, (z[rr, cc], rr, cc))
        if primary and cur > primary[0] + rimRange:
            break
    sp = primary[0]
    mask = flooded & (level <= sp + 1e-9)
    depth = np.clip(np.nan_to_num(sp - z), 0, None) * mask
    # clusters of spill cells (8-connected)
    sm = np.zeros(z.shape, bool)
    for lv, r, c in spills:
        sm[r, c] = True
    lab = np.zeros(z.shape, np.int32); ncl = 0; clusters = []
    for lv, r, c in spills:
        if lab[r, c]:
            continue
        ncl += 1; stack = [(r, c)]; lab[r, c] = ncl; cells = []
        while stack:
            a, b = stack.pop(); cells.append((a, b))
            for dr, dc in NB:
                rr, cc = a + dr, b + dc
                if 0 <= rr < h and 0 <= cc < w and sm[rr, cc] and not lab[rr, cc]:
                    lab[rr, cc] = ncl; stack.append((rr, cc))
        lo = min(cells, key=lambda p: level[p[0], p[1]])
        clusters.append(dict(rank=0, level=float(level[lo[0], lo[1]]), x=float(X[lo[1]]), y=float(Y[lo[0]]), cells=len(cells)))
    clusters.sort(key=lambda d: d['level'])
    for i, d in enumerate(clusters):
        d['rank'] = i + 1; d['above_ft'] = round(d['level'] - sp, 2)
    stage = []
    L = z0
    while L <= sp + rimRange + 1e-9:
        mk = flooded & (level <= L + 1e-9); dd = np.clip(np.nan_to_num(L - z), 0, None) * mk
        stage.append(dict(level=round(L, 2), area_ft2=float(mk.sum() * cell * cell), storage_ft3=float(dd.sum() * cell * cell)))
        L += levelStep
    return dict(z0=z0, seedCells=int(seed.sum()), primary=dict(level=float(sp), x=float(X[primary[2]]), y=float(Y[primary[1]]),
                next=(float(X[primary_next[1]]), float(Y[primary_next[0]]))),
                freeboard_ft=float(sp - z0), storage_ft3=float(depth.sum() * cell * cell), area_ft2=float(mask.sum() * cell * cell),
                clusters=clusters[:12], stage=stage, flooded=flooded, seed=seed, primary_rc=(primary[1], primary[2]),
                next_rc=primary_next, F=F, level=level)


def d8_down(z, F):
    """Steepest-descent D8 on the filled DEM; -1 where none. Vectorised. Ties: first in NB order."""
    h, w = z.shape; nod = np.isnan(z)
    Fp = np.where(nod, np.inf, F)
    best = np.full(z.shape, -1e30); down = np.full(z.shape, -1, np.int64)
    idx = np.arange(h * w).reshape(h, w)
    for (dr, dc), d in zip(NB, NBD):
        drop = np.full(z.shape, -np.inf)
        r0, r1 = max(0, -dr), h - max(0, dr); c0, c1 = max(0, -dc), w - max(0, dc)
        drop[r0:r1, c0:c1] = (Fp[r0:r1, c0:c1] - Fp[r0 + dr:r1 + dr, c0 + dc:c1 + dc]) / d
        tgt = np.full(z.shape, -1, np.int64); tgt[r0:r1, c0:c1] = idx[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        better = (drop > 1e-9) & (drop > best) & ~nod
        best = np.where(better, drop, best); down = np.where(better, tgt, down)
    return down


def catchment(z, F, r, c, cell, down=None):
    """All cells whose D8 path on F reaches (r,c)."""
    h, w = z.shape
    if down is None:
        down = d8_down(z, F)
    flat = down.ravel()
    order = np.argsort(flat, kind='stable'); vals = flat[order]
    starts = np.searchsorted(vals, np.arange(h * w)); ends = np.searchsorted(vals, np.arange(h * w), side='right')
    seen = np.zeros(h * w, bool); stack = [r * w + c]; seen[r * w + c] = True; n = 0; edge = False
    while stack:
        i = stack.pop(); n += 1
        rr, cc = divmod(i, w)
        if rr in (0, h - 1) or cc in (0, w - 1):
            edge = True
        for j in order[starts[i]:ends[i]]:
            if not seen[j]:
                seen[j] = True; stack.append(int(j))
    return dict(cells=n, area_ft2=n * cell * cell, touchesEdge=edge)


def accumulation(z, F, down):
    """Flow accumulation (cells) on the D8 network, processing cells from high F to low."""
    h, w = z.shape; acc = np.ones(h * w, np.int64); flat = down.ravel()
    Fp = np.where(np.isnan(F), -np.inf, F).ravel()
    for i in np.argsort(-Fp, kind='stable'):
        d = flat[i]
        if d >= 0:
            acc[d] += acc[i]
    return acc.reshape(h, w)


if __name__ == '__main__':
    what = sys.argv[1]
    if what == 'drops':
        m, z, X, Y = load_window('fix_swale_window')
        cell = m['cell']; out = {}
        F = fill_dem(z)
        down = d8_down(z, F); acc = accumulation(z, F, down)
        # golden candidates: the reference point, plus the interior cell with accumulation closest to 1 ac (43,560 cells)
        h, w = z.shape
        inner = acc.copy(); inner[:200, :] = 0; inner[-200:, :] = 0; inner[:, :200] = 0; inner[:, -200:] = 0
        tgt = 3000
        cand = np.argwhere((inner > tgt * 0.8) & (inner < tgt * 1.3))
        pts = dict(swale=tuple(m['drop']))
        for name, (x, y) in pts.items():
            c = int(np.argmin(np.abs(X - x))); r = int(np.argmin(np.abs(Y - y)))
            t = trace(z, X, Y, r, c, cell, F=F)
            cat = catchment(z, F, r, c, cell, down=down)
            print(name, (x, y), 'z %.2f' % t['start'][2], 'n', t['n'], 'len', t['length_ft'], 'end',
                  [round(v, 1) for v in t['end']], t['reason'], 'ponds', len(t['ponds']), t['ponds'][:5], 'exit', t['exit'], 'catchment', cat)
            out[name] = dict(drop=[x, y], n=t['n'], length_ft=t['length_ft'], start=t['start'], end=t['end'],
                             reason=t['reason'], ponds=t['ponds'], exit=t['exit'], pts=t['pts'][::3], catchment=cat)
        json.dump(out, open(SC + 'drop_ref.json', 'w'), indent=1)
    elif what == 'herman':
        m, z, X, Y = load_window('fix_herman_window')
        cell = m['cell']
        ring = np.array(json.load(open(SC + 'herman.json'))['geometry']['coordinates'][0])
        o = overtop(z, X, Y, cell, ring)
        print('z0 %.2f seed %d cells' % (o['z0'], o['seedCells']))
        p = o['primary']
        print('PRIMARY SPILL %.2f ft at E %.1f N %.1f, freeboard %.2f ft, next (%.1f, %.1f)' % (p['level'], p['x'], p['y'], o['freeboard_ft'], *p['next']))
        print('storage to spill %.0f ft3 = %.2f ac-ft; area %.2f ac' % (o['storage_ft3'], o['storage_ft3'] / 43560, o['area_ft2'] / 43560))
        for cl in o['clusters']:
            print('  rim low %d: %.2f ft (+%.2f) at E %.1f N %.1f, %d cells' % (cl['rank'], cl['level'], cl['above_ft'], cl['x'], cl['y'], cl['cells']))
        print('stage:', [(s['level'], round(s['area_ft2'] / 43560, 2), round(s['storage_ft3'] / 43560, 2)) for s in o['stage']])
        # overflow route: from `next`, with the seed pre-marked as pond 1 (no outlet)
        pondId = np.zeros(z.shape, np.int32); pondId[o['seed']] = 1
        ponds = {1: dict(level=o['z0'], outlet=None, cells=[], zmin=o['z0'])}
        nr, nc = o['next_rc']
        t = trace(z, X, Y, nr, nc, cell, F=o['F'], pondId=pondId, ponds=ponds)
        print('OVERFLOW ROUTE: n %d, %.0f ft, %.2f -> %.2f, ends %s at E %.1f N %.1f; ponds %s' % (
            t['n'], t['length_ft'], t['start'][2], t['end'][2], t['reason'], t['end'][0], t['end'][1], t['ponds'][:6]))
        o2 = {k: v for k, v in o.items() if k not in ('flooded', 'seed', 'primary_rc', 'next_rc', 'F')}
        o2['route'] = dict(n=t['n'], length_ft=t['length_ft'], end=t['end'], reason=t['reason'], ponds=t['ponds'], pts=t['pts'][::3])
        json.dump(o2, open(SC + 'herman_ref.json', 'w'), indent=1)
