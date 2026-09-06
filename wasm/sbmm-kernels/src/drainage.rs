/*! `drainage` -- v14 Phase 1, the drainage map (docs/V14_DRAINAGE_SPEC.md),
    ported line for line from js/compute.js.

    ONE LABEL PER CELL: the outlet that cell drains to. Sections 1-7 of the
    JavaScript are all here, including the polygon tracing, and that is
    deliberate: at 2 ft the grid is 21.6 million cells, so `term`, `firstL`,
    `pointer` and `pondId` are 86 MB EACH, and handing four of them back
    across the ABI would cost more than the loops save. What comes back is
    what the card actually reads -- the decimated label rasters, the sink,
    pond and inlet tables, their rings and their longest flow paths.

    IDENTITY: bit-identical. The three rulings the kernel makes for itself are
    reproduced exactly, and each of them is a place where a lazier port would
    silently differ:

      * the ponds are the connected components of F > z (POND_EPS), and the
        pour level is the MINIMUM F over the component, not the maximum;
      * a pond cell points at parent[c], not at the outlet -- and only while
        the parent is in the same pond or its ground is at or below the pond's
        level, which is the one-cell-component rule the field build found;
      * RIM_EPS is 1e-3 ft, not 1e-9, because F is an f32 and a surveyed
        invert is an f64 and `rim <= level` fails by one ULP on exactly the
        cell the whole analysis turns on.
*/

use crate::fill::fill_dem_inner;
use crate::geom::{mask_rings, simplify_path, trace_mask_inner};
use crate::{mi32, out_f64, out_i32, out_reset, sf32, sf64, si32, su8, W_DD, W_DI, W_DJ};

const POND_EPS: f64 = 1e-3;
const RIM_EPS: f64 = 1e-3;

/* sink kinds, in the order js/compute.js creates the first four */
const K_LAKE: i32 = 0;
const K_OFF: i32 = 1;
const K_LOOP: i32 = 2;
const K_FLAT: i32 = 3;
const K_OUTFALL: i32 = 4;
const K_POND: i32 = 5;

struct Sink { kind: i32, param: i32, x: f64, y: f64, seen: i32 }

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn drainage(
    z_ptr: *const f32, w: i32, h: i32, cell: f64, x0: f64, y0: f64,
    min_pond_depth: f64, stride: i32, want_long: i32,
    cd_ix: *const f64, cd_iy: *const f64, cd_rim: *const f64,
    cd_ox: *const f64, cd_oy: *const f64, cd_next: *const i32,
    cd_outfall: *const u8, cd_out_in_lake: *const u8,
    n_cd: i32, capture_ft: f64,
    lake_ptr: *const u8,
    outline_tol: f64, min_poly_cells: i32, max_polys: i32, max_ponds: i32,
    dterm_out: *mut i32, dfirst_out: *mut i32,
) -> i32 {
    let (wu, hu) = (w as usize, h as usize);
    let n = wu * hu;
    let z = unsafe { sf32(z_ptr, n) };
    let nc = n_cd as usize;
    let (cix, ciy, crim) = unsafe { (sf64(cd_ix, nc), sf64(cd_iy, nc), sf64(cd_rim, nc)) };
    let (cox, coy) = unsafe { (sf64(cd_ox, nc), sf64(cd_oy, nc)) };
    let cnext = unsafe { si32(cd_next, nc) };
    let coutf = unsafe { su8(cd_outfall, nc) };
    let clake = unsafe { su8(cd_out_in_lake, nc) };
    let lake: Option<&[u8]> = if lake_ptr.is_null() { None } else { Some(unsafe { su8(lake_ptr, n) }) };

    let stride = if stride < 1 { 1usize } else { stride as usize };
    let dw = ((wu + stride - 1) / stride).max(1);
    let dh = ((hu + stride - 1) / stride).max(1);
    let dterm = unsafe { mi32(dterm_out, dw * dh) };
    let dfirst = unsafe { mi32(dfirst_out, dw * dh) };

    let wi = wu as i32;
    let hi = hu as i32;
    let idx = |i: i32, j: i32| -> usize { j as usize * wu + i as usize };

    /* ---- 1. the inlet index -------------------------------------------- */
    let has_cd = nc > 0;
    /* i16, not i32: js/compute.js uses an Int16Array here and at 2 ft the
       difference is 43 MB of linear memory on a kernel that already wants
       ~700 MB of it. The conduit count is a couple of dozen. */
    let mut inlet_at = vec![-1i16; if has_cd { n } else { 0 }];
    let mut sink_i: Vec<i32> = Vec::new();
    let mut sink_k: Vec<f64> = Vec::new();
    if has_cd {
        /* The capture discs are a few hundred cells between them, so the
           distances live in a SPARSE map exactly as the JavaScript's own `Map`
           does. A full-grid f64 shadow here was 172 MB of allocation and
           zeroing at 2 ft, and it made the whole kernel slower than the
           JavaScript it replaces -- which is how it was found. */
        let mut dkey = crate::geom::U64Map::new(1024);
        let mut dcell: Vec<usize> = Vec::new();   /* insertion order, the Map's own */
        let mut dval: Vec<f64> = Vec::new();
        let crc = if capture_ft / cell > 0.0 { (capture_ft / cell).ceil() as i32 } else { 0 };
        for k in 0..nc {
            let ki = ((cix[k] - x0) / cell).round() as i32;
            let kj = ((ciy[k] - y0) / cell).round() as i32;
            for cjj in (kj - crc)..=(kj + crc) {
                if cjj < 0 || cjj >= hi { continue; }
                for cii in (ki - crc)..=(ki + crc) {
                    if cii < 0 || cii >= wi { continue; }
                    let kdx = x0 + cii as f64 * cell - cix[k];
                    let kdy = y0 + cjj as f64 * cell - ciy[k];
                    let kd = (kdx * kdx + kdy * kdy).sqrt();
                    if kd > capture_ft { continue; }
                    let kidx = idx(cii, cjj);
                    if z[kidx].is_nan() { continue; }
                    let slot = dkey.entry(kidx as u64, dval.len() as u32);
                    if slot as usize == dval.len() {
                        dval.push(kd); dcell.push(kidx); inlet_at[kidx] = k as i16;
                    } else if kd < dval[slot as usize] {
                        dval[slot as usize] = kd; inlet_at[kidx] = k as i16;
                    }
                }
            }
        }
        /* an inlet's OWN nearest cell is always a capture cell, whatever
           captureFt says -- 3 ft does not reach the centre of a 4-ft cell */
        for k in 0..nc {
            let ni2 = ((cix[k] - x0) / cell).round() as i32;
            let nj2 = ((ciy[k] - y0) / cell).round() as i32;
            if ni2 < 0 || nj2 < 0 || ni2 >= wi || nj2 >= hi { continue; }
            let nidx = idx(ni2, nj2);
            if z[nidx].is_nan() || dkey.has(nidx as u64) { continue; }
            dkey.entry(nidx as u64, dval.len() as u32);
            dval.push(0.0); dcell.push(nidx);
            inlet_at[nidx] = k as i16;
        }
        for ix in &dcell {
            let r = crim[inlet_at[*ix] as usize];
            sink_i.push(*ix as i32);
            sink_k.push(if r.is_finite() { r } else { z[*ix] as f64 });
        }
    }
    let rim_of = |kk: i32, at: usize| -> f64 {
        let r = crim[kk as usize];
        if r.is_finite() { r } else { z[at] as f64 }
    };

    /* ---- 2. the filled DEM, plus the priority-flood parent -------------- */
    let mut parent = vec![0i32; n];
    let mut f = vec![0f32; n];
    fill_dem_inner(z, wu, hu, &sink_i, &sink_k, &mut f, Some(&mut parent));

    /* ---- the sink table -------------------------------------------------- */
    let mut sinks: Vec<Sink> = Vec::new();
    let mut push_sink = |sinks: &mut Vec<Sink>, kind: i32, param: i32, x: f64, y: f64| -> i32 {
        sinks.push(Sink { kind, param, x, y, seen: -1 });
        (sinks.len() - 1) as i32
    };
    let s_lake = push_sink(&mut sinks, K_LAKE, -1, 0.0, 0.0);
    let s_off = push_sink(&mut sinks, K_OFF, -1, 0.0, 0.0);
    let s_loop = push_sink(&mut sinks, K_LOOP, -1, 0.0, 0.0);
    let s_flat = push_sink(&mut sinks, K_FLAT, -1, 0.0, 0.0);

    macro_rules! mark_sink {
        ($s:expr, $ix:expr) => {{
            let s: i32 = $s;
            let ii: usize = $ix;
            let ss = &mut sinks[s as usize];
            if ss.seen < 0 {
                ss.seen = ii as i32;
                ss.x = x0 + (ii % wu) as f64 * cell;
                ss.y = y0 + ((ii - ii % wu) / wu) as f64 * cell;
            }
            s
        }};
    }

    /* ---- 3. the ponds -- the connected components of F > z -------------- */
    let mut pond_id = vec![0i32; n];
    let mut p_level: Vec<f64> = vec![0.0];
    let mut p_outlet: Vec<i32> = vec![-1];
    let mut p_entry: Vec<i32> = vec![-1];
    let mut p_zmin: Vec<f64> = vec![0.0];
    let mut p_count: Vec<i32> = vec![0];
    let mut p_sumz: Vec<f64> = vec![0.0];
    let mut p_bb: Vec<[i32; 4]> = vec![[0, 0, 0, 0]];
    let mut p_via: Vec<i32> = vec![-1];
    let mut stk: Vec<i32> = Vec::with_capacity(1 << 16);

    let wet = |ix: usize, f: &[f32]| -> bool { !z[ix].is_nan() && (f[ix] as f64) > z[ix] as f64 + POND_EPS };

    for j in 0..hu {
        for i in 0..wu {
            let c = j * wu + i;
            if pond_id[c] != 0 || !wet(c, &f) { continue; }
            let pid = p_level.len() as i32;
            stk.clear();
            stk.push(c as i32);
            pond_id[c] = pid;
            let mut level = f[c] as f64;
            let mut zmin = z[c] as f64;
            let mut count = 0i32;
            let mut sumz = 0f64;
            let mut entry = c as i32;
            let mut bb = [i as i32, j as i32, i as i32, j as i32];
            let mut out_f = f64::INFINITY;
            let mut out_z = f64::INFINITY;
            let mut out_idx = -1i32;
            let mut seed_in = -1i32;
            let mut via_k = -1i32;
            let mut via_cell = -1i32;
            let mut via_rim = f64::INFINITY;
            while let Some(u32v) = stk.pop() {
                let u = u32v as usize;
                let ui = (u % wu) as i32;
                let uj = ((u - u % wu) / wu) as i32;
                count += 1;
                sumz += z[u] as f64;
                if (z[u] as f64) < zmin { zmin = z[u] as f64; entry = u as i32; }
                if (f[u] as f64) < level { level = f[u] as f64; }
                if ui < bb[0] { bb[0] = ui; }
                if uj < bb[1] { bb[1] = uj; }
                if ui > bb[2] { bb[2] = ui; }
                if uj > bb[3] { bb[3] = uj; }
                if has_cd && inlet_at[u] >= 0 {
                    let ru = rim_of(inlet_at[u] as i32, u);
                    if ru < via_rim { via_rim = ru; via_k = inlet_at[u] as i32; via_cell = u as i32; }
                }
                if parent[u] < 0 { seed_in = u as i32; }
                for t in 0..8 {
                    let ni = ui + W_DI[t];
                    let nj = uj + W_DJ[t];
                    if ni < 0 || nj < 0 || ni >= wi || nj >= hi { continue; }
                    let vi = idx(ni, nj);
                    if pond_id[vi] == pid { continue; }
                    if z[vi].is_nan() { continue; }
                    if pond_id[vi] == 0 && wet(vi, &f) { pond_id[vi] = pid; stk.push(vi as i32); continue; }
                    if has_cd && inlet_at[vi] >= 0 {
                        let rv = rim_of(inlet_at[vi] as i32, vi);
                        if rv <= level + RIM_EPS && rv < via_rim { via_rim = rv; via_k = inlet_at[vi] as i32; via_cell = vi as i32; }
                    }
                }
                /* THE POUR POINT, taken from the priority flood itself */
                let pu = parent[u];
                if pu >= 0 && pond_id[pu as usize] != pid && !z[pu as usize].is_nan() {
                    let fp = f[pu as usize] as f64;
                    let zp = z[pu as usize] as f64;
                    if fp < out_f || (fp == out_f && zp < out_z) { out_f = fp; out_z = zp; out_idx = pu; }
                }
            }
            if has_cd && via_k >= 0 && (via_rim <= level + RIM_EPS || seed_in >= 0) {
                p_outlet.push(via_cell); p_via.push(via_k);
            } else {
                p_outlet.push(out_idx); p_via.push(-1);
            }
            p_level.push(level);
            p_entry.push(entry);
            p_zmin.push(zmin);
            p_count.push(count);
            p_sumz.push(sumz);
            p_bb.push(bb);
        }
    }
    let pn = p_level.len();
    stk = Vec::new();

    /* ---- 4a. the conduit chains ---------------------------------------- */
    let mut chain_cell = vec![-1i32; nc];
    let mut chain_sink = vec![-1i32; nc];
    let mut outfall_sink = vec![-1i32; nc];
    if has_cd {
        let mut seen_c = vec![-1i32; nc];
        for k in 0..nc {
            let mut cur2 = k;
            let mut last = k;
            loop {
                if seen_c[cur2] == k as i32 { break; }
                seen_c[cur2] = k as i32;
                last = cur2;
                if coutf[cur2] != 0 { break; }
                let nx = cnext[cur2];
                if nx < 0 { break; }
                cur2 = nx as usize;
            }
            if coutf[last] != 0 {
                chain_cell[k] = -1;
                if outfall_sink[last] < 0 {
                    outfall_sink[last] = push_sink(&mut sinks, K_OUTFALL, last as i32, cox[last], coy[last]);
                }
                chain_sink[k] = outfall_sink[last];
            } else {
                let oi = ((cox[last] - x0) / cell).round() as i32;
                let oj = ((coy[last] - y0) / cell).round() as i32;
                if oi >= 0 && oj >= 0 && oi < wi && oj < hi && !z[idx(oi, oj)].is_nan() {
                    chain_cell[k] = idx(oi, oj) as i32;
                    chain_sink[k] = -1;
                } else {
                    chain_cell[k] = -1;
                    chain_sink[k] = if clake[last] != 0 { s_lake } else { s_off };
                }
            }
        }
    }

    /* ---- 4b. the flow pointer ------------------------------------------ */
    let mut pointer = vec![0i32; n];
    let mut flats = 0i64;
    let mut pond_sinks_n = 0i64;
    let mut pond_sink_of = vec![-1i32; pn];
    let chain_target = |kk: i32, chain_cell: &Vec<i32>, chain_sink: &Vec<i32>| -> i32 {
        let k = kk as usize;
        if chain_cell[k] >= 0 { chain_cell[k] } else { -2 - chain_sink[k] }
    };
    for j in 0..hu {
        for i in 0..wu {
            let c = j * wu + i;
            if z[c].is_nan() { pointer[c] = -1; continue; }
            let pk = pond_id[c];
            if pk != 0 {
                if has_cd && inlet_at[c] >= 0
                    && (parent[c] < 0 || rim_of(inlet_at[c] as i32, c) <= p_level[pk as usize] + RIM_EPS) {
                    pointer[c] = chain_target(inlet_at[c] as i32, &chain_cell, &chain_sink);
                    continue;
                }
                let pp0 = parent[c];
                if pp0 >= 0 && pp0 != c as i32 && !z[pp0 as usize].is_nan()
                    && (pond_id[pp0 as usize] == pk || (z[pp0 as usize] as f64) <= p_level[pk as usize] + 1e-9) {
                    pointer[c] = pp0;
                    continue;
                }
            }
            if has_cd && inlet_at[c] >= 0 {
                pointer[c] = chain_target(inlet_at[c] as i32, &chain_cell, &chain_sink);
                continue;
            }
            if i == 0 || j == 0 || i == wu - 1 || j == hu - 1 {
                pointer[c] = -2 - mark_sink!(s_off, c);
                continue;
            }
            let ze = if pk != 0 { p_level[pk as usize] } else { z[c] as f64 };
            let mut best = -1i32;
            let mut bd = -1f64;
            let mut nod_n = -1i32;
            for t in 0..8 {
                let vi = ((j as i32 + W_DJ[t]) as usize) * wu + (i as i32 + W_DI[t]) as usize;
                let zv2 = z[vi];
                if zv2.is_nan() { nod_n = vi as i32; break; }
                let pv = pond_id[vi];
                let dr = (ze - if pv != 0 { p_level[pv as usize] } else { zv2 as f64 }) / W_DD[t];
                if dr > 1e-9 && dr > bd { bd = dr; best = vi as i32; }
            }
            if nod_n >= 0 {
                let s = if lake.map(|l| l[nod_n as usize] != 0).unwrap_or(false) { s_lake } else { s_off };
                pointer[c] = -2 - mark_sink!(s, nod_n as usize);
                continue;
            }
            if best >= 0 { pointer[c] = best; continue; }
            if pk != 0 {
                pond_sinks_n += 1;
                let pku = pk as usize;
                if pond_sink_of[pku] < 0 {
                    let e = p_entry[pku] as usize;
                    pond_sink_of[pku] = push_sink(&mut sinks, K_POND, pk,
                        x0 + (e % wu) as f64 * cell, y0 + ((e - e % wu) / wu) as f64 * cell);
                }
                pointer[c] = -2 - mark_sink!(pond_sink_of[pku], c);
                continue;
            }
            let pp = parent[c];
            if pp >= 0 && pp != c as i32 && !z[pp as usize].is_nan() { pointer[c] = pp; continue; }
            flats += 1;
            pointer[c] = -2 - mark_sink!(s_flat, c);
        }
    }
    drop(f);
    let n_sinks = sinks.len();

    /* ---- 5. labels ------------------------------------------------------ */
    let fb_pond = n_sinks as i32;
    let fb_inlet = n_sinks as i32 + pn as i32;
    let mut term = vec![-1i32; n];
    let mut first_l = vec![-1i32; n];
    let want_dist = want_long != 0;
    let mut dist = vec![0f32; if want_dist { n } else { 0 }];
    let mut onwalk = vec![0u8; n];
    let mut stack: Vec<i32> = Vec::with_capacity(1 << 16);
    let mut loops = 0i64;
    /* the loop sample: (x, y, z, pond, level, inlet) */
    let mut loop_sample: Vec<(f64, f64, f64, i32, f64, i32)> = Vec::new();
    let mut p_rep = vec![0u8; pn];
    for k in 1..pn { p_rep[k] = if p_level[k] - p_zmin[k] >= min_pond_depth { 1 } else { 0 }; }

    for c in 0..n {
        if pointer[c] == -1 || term[c] >= 0 { continue; }
        stack.clear();
        let mut cur = c;
        let mut s_s = -1i32;
        let mut f_down = -1i32;
        let mut d_down = 0f64;
        loop {
            if term[cur] >= 0 {
                s_s = term[cur];
                f_down = first_l[cur];
                d_down = if want_dist { dist[cur] as f64 } else { 0.0 };
                break;
            }
            let p = pointer[cur];
            if p <= -2 || onwalk[cur] != 0 {
                if p > -2 {
                    s_s = mark_sink!(s_loop, cur);
                    loops += 1;
                    if loop_sample.is_empty() {
                        let mut lc = cur as i32;
                        let mut lg = 0;
                        loop {
                            let li = (lc as usize) % wu;
                            let lp2 = pond_id[lc as usize];
                            loop_sample.push((
                                x0 + li as f64 * cell,
                                y0 + ((lc as usize - li) / wu) as f64 * cell,
                                z[lc as usize] as f64,
                                lp2,
                                if lp2 != 0 { p_level[lp2 as usize] } else { f64::NAN },
                                if has_cd { inlet_at[lc as usize] as i32 } else { -1 },
                            ));
                            lc = pointer[lc as usize];
                            let g = lg; lg += 1;
                            if !(lc >= 0 && lc != cur as i32 && g < 40) { break; }
                        }
                    }
                } else {
                    s_s = -p - 2;
                }
                f_down = -1;
                d_down = 0.0;
                onwalk[cur] = 1;
                stack.push(cur as i32);
                break;
            }
            onwalk[cur] = 1;
            stack.push(cur as i32);
            cur = p as usize;
        }
        if f_down < 0 { f_down = s_s; }
        let mut dd = d_down;
        while let Some(qv) = stack.pop() {
            let q = qv as usize;
            onwalk[q] = 0;
            term[q] = s_s;
            let pq = pointer[q];
            if want_dist {
                if pq >= 0 {
                    let qi = (q % wu) as i64;
                    let qj = ((q - q % wu) / wu) as i64;
                    let ppi = (pq as usize % wu) as i64;
                    let ppj = ((pq as usize - pq as usize % wu) / wu) as i64;
                    let piped = has_cd && inlet_at[q] >= 0 && chain_cell[inlet_at[q] as usize] == pq;
                    if !piped {
                        let dx = (ppi - qi) as f64;
                        let dy = (ppj - qj) as f64;
                        dd += (dx * dx + dy * dy).sqrt() * cell;
                    }
                }
                dist[q] = dd as f32;
            }
            let qk = pond_id[q];
            let of2 = if qk != 0 && p_rep[qk as usize] != 0 { fb_pond + qk }
                      else if has_cd && inlet_at[q] >= 0 { fb_inlet + inlet_at[q] as i32 }
                      else { -1 };
            first_l[q] = if of2 >= 0 { of2 } else { f_down };
            f_down = first_l[q];
        }
    }
    drop(onwalk);
    drop(stack);
    drop(parent);

    /* ---- 6. per-label totals ------------------------------------------- */
    let nf = (fb_inlet as usize) + nc;
    let mut f_cells = vec![0i32; nf];
    let mut f_slope = vec![0f64; nf];
    let mut f_long = vec![0f64; nf];
    let mut s_cells = vec![0i32; n_sinks];
    let mut s_slope = vec![0f64; n_sinks];
    let mut s_long = vec![0f64; n_sinks];
    let mut s_long_at = vec![-1i32; n_sinks];
    let mut surveyed = 0i64;
    for j in 0..hu {
        for i in 0..wu {
            let c = j * wu + i;
            let s2 = term[c];
            if s2 < 0 { continue; }
            surveyed += 1;
            let i0s = if i > 0 { i - 1 } else { i };
            let i1s = if i < wu - 1 { i + 1 } else { i };
            let j0s = if j > 0 { j - 1 } else { j };
            let j1s = if j < hu - 1 { j + 1 } else { j };
            let za = z[j * wu + i0s] as f64;
            let zb = z[j * wu + i1s] as f64;
            let zc2 = z[j0s * wu + i] as f64;
            let zd = z[j1s * wu + i] as f64;
            let mut sl = 0f64;
            if !za.is_nan() && !zb.is_nan() && !zc2.is_nan() && !zd.is_nan() {
                let di = (i1s as f64) - (i0s as f64);
                let dj = (j1s as f64) - (j0s as f64);
                let gx = (zb - za) / ((if di != 0.0 { di } else { 1.0 }) * cell);
                let gy = (zd - zc2) / ((if dj != 0.0 { dj } else { 1.0 }) * cell);
                sl = (gx * gx + gy * gy).sqrt() * 100.0;
            }
            let su = s2 as usize;
            s_cells[su] += 1;
            s_slope[su] += sl;
            let dv = if want_dist { dist[c] as f64 } else { 0.0 };
            if dv > s_long[su] || s_long_at[su] < 0 { s_long[su] = dv; s_long_at[su] = c as i32; }
            let f3 = first_l[c];
            if f3 >= 0 && (f3 as usize) < nf {
                let fu = f3 as usize;
                f_cells[fu] += 1;
                f_slope[fu] += sl;
                if dv > f_long[fu] { f_long[fu] = dv; }
            }
        }
    }

    /* ---- 7. polygons ---------------------------------------------------- */
    let d_cell = cell * stride as f64;
    for j in 0..dh {
        for i in 0..dw {
            let sc = (hu - 1).min(j * stride) * wu + (wu - 1).min(i * stride);
            dterm[j * dw + i] = term[sc];
            dfirst[j * dw + i] = first_l[sc];
        }
    }
    let mut d_mask = vec![0u8; dw * dh];
    let tol_r = outline_tol;
    let min_cells = min_poly_cells;
    let mut poly_budget = max_polys;

    macro_rules! rings_of {
        ($src:expr, $label:expr) => {{
            let src: &[i32] = $src;
            let label: i32 = $label;
            if poly_budget <= 0 { Vec::new() } else {
                let (mut b0, mut b1, mut b2, mut b3) = (dw as i32, dh as i32, -1i32, -1i32);
                let mut cnt = 0i32;
                for jj in 0..dh {
                    for ii in 0..dw {
                        let cc = jj * dw + ii;
                        if src[cc] != label { continue; }
                        d_mask[cc] = 1;
                        cnt += 1;
                        if (ii as i32) < b0 { b0 = ii as i32; }
                        if (jj as i32) < b1 { b1 = jj as i32; }
                        if (ii as i32) > b2 { b2 = ii as i32; }
                        if (jj as i32) > b3 { b3 = jj as i32; }
                    }
                }
                let out = if cnt >= min_cells && b2 >= 0 {
                    mask_rings(&d_mask, dw, dh, d_cell, x0, y0, [b0, b1, b2, b3], tol_r)
                } else { Vec::new() };
                if b2 >= 0 {
                    for jj in b1..=b3 { for ii in b0..=b2 { d_mask[jj as usize * dw + ii as usize] = 0; } }
                }
                poly_budget -= 1;
                out
            }
        }};
    }

    /* the longest flow path of a catchment: the pointer chain from the cell
       furthest from the outlet, drawn as it runs */
    let longest_path = |from: i32| -> Vec<[f64; 2]> {
        if from < 0 { return Vec::new(); }
        let mut raw: Vec<[f64; 2]> = Vec::new();
        let mut cur = from;
        let mut guard = 0;
        while cur >= 0 && guard < 400000 {
            guard += 1;
            let ci = (cur as usize) % wu;
            raw.push([x0 + ci as f64 * cell, y0 + ((cur as usize - ci) / wu) as f64 * cell]);
            let nx2 = pointer[cur as usize];
            if nx2 < 0 { break; }
            cur = nx2;
        }
        if raw.len() < 2 { return raw; }
        simplify_path(&raw, cell)
    };

    /* the sinks, biggest first -- the reading order of the card's table */
    let mut order: Vec<usize> = (0..n_sinks).filter(|k| s_cells[*k] > 0).collect();
    order.sort_by(|a, b| s_cells[*b].cmp(&s_cells[*a]));

    out_reset();
    out_i32(dw as i32);
    out_i32(dh as i32);
    out_i32(pn as i32);
    out_i32(loops as i32);
    out_i32(flats as i32);
    out_i32(pond_sinks_n as i32);
    out_i32(surveyed as i32);
    out_i32(n_sinks as i32);
    out_i32(loop_sample.len() as i32);
    for ls in &loop_sample {
        out_f64(ls.0); out_f64(ls.1); out_f64(ls.2);
        out_i32(ls.3); out_f64(ls.4); out_i32(ls.5);
    }

    out_i32(order.len() as i32);
    for qi in 0..order.len() {
        let k = order[qi];
        out_i32(k as i32);
        out_i32(sinks[k].kind);
        out_i32(sinks[k].param);
        out_f64(sinks[k].x);
        out_f64(sinks[k].y);
        out_i32(s_cells[k]);
        out_f64(s_long[k]);
        out_f64(s_slope[k]);
        let rings = rings_of!(&*dterm, k as i32);
        out_rings(&rings);
        let path = longest_path(s_long_at[k]);
        out_i32(path.len() as i32);
        for p in &path { out_f64(p[0]); out_f64(p[1]); }
    }

    /* the through-ponds, and what drains into each */
    let mut p_order: Vec<usize> = (1..pn).filter(|k| p_rep[*k] != 0 && p_count[*k] > 0).collect();
    p_order.sort_by(|a, b| p_count[*b].cmp(&p_count[*a]));
    let mut via_cells = vec![0i64; nc];
    for k in 1..pn {
        if has_cd && p_via[k] >= 0 { via_cells[p_via[k] as usize] += f_cells[(fb_pond + k as i32) as usize] as i64; }
    }
    let np_out = p_order.len().min(max_ponds.max(0) as usize);
    out_i32(np_out as i32);
    for qi in 0..np_out {
        let k = p_order[qi];
        let fl2 = (fb_pond + k as i32) as usize;
        let e = p_entry[k] as usize;
        out_i32(fl2 as i32);
        out_i32(k as i32);
        out_f64(p_level[k]);
        out_f64(p_zmin[k]);
        out_i32(p_count[k]);
        out_f64(p_sumz[k]);
        out_i32(p_via[k]);
        out_i32(p_outlet[k]);
        if p_outlet[k] >= 0 {
            let o = p_outlet[k] as usize;
            out_f64(x0 + (o % wu) as f64 * cell);
            out_f64(y0 + ((o - o % wu) / wu) as f64 * cell);
        } else { out_f64(0.0); out_f64(0.0); }
        out_f64(x0 + (e % wu) as f64 * cell);
        out_f64(y0 + ((e - e % wu) / wu) as f64 * cell);
        out_i32(term[e]);
        out_i32(f_cells[fl2]);
        out_f64(f_long[fl2]);
        out_f64(f_slope[fl2]);
        /* the pond's own outline, on the FULL-resolution raster */
        let rings = pond_rings(&pond_id, k as i32, wu, hu, cell, x0, y0, p_bb[k]);
        out_rings(&rings);
        let crings = rings_of!(&*dfirst, fl2 as i32);
        out_rings(&crings);
    }

    /* the inlets, in k order -- the host sorts them by through_cells */
    let mut n_in = 0i32;
    {
        let mut rows: Vec<(usize, Vec<Vec<[f64; 2]>>)> = Vec::new();
        for k in 0..nc {
            let fl3 = (fb_inlet + k as i32) as usize;
            let via_c = via_cells[k];
            if f_cells[fl3] == 0 && via_c == 0 { continue; }
            let rings = rings_of!(&*dfirst, fl3 as i32);
            rows.push((k, rings));
            n_in += 1;
        }
        out_i32(n_in);
        for (k, rings) in &rows {
            let k = *k;
            let fl3 = (fb_inlet + k as i32) as usize;
            out_i32(fl3 as i32);
            out_i32(k as i32);
            out_i32(if chain_sink[k] >= 0 { chain_sink[k] }
                    else if chain_cell[k] >= 0 { term[chain_cell[k] as usize] } else { -1 });
            out_i32(f_cells[fl3]);
            out_f64(f_long[fl3]);
            out_f64(f_slope[fl3]);
            out_i32(via_cells[k] as i32);
            out_rings(rings);
        }
    }
    0
}

fn out_rings(rings: &[Vec<[f64; 2]>]) {
    out_i32(rings.len() as i32);
    for r in rings {
        out_i32(r.len() as i32);
        for p in r { out_f64(p[0]); out_f64(p[1]); }
    }
}

/* js/compute.js pondRings */
#[allow(clippy::too_many_arguments)]
fn pond_rings(pond_id: &[i32], id: i32, w: usize, h: usize, cell: f64, x0: f64, y0: f64, bb: [i32; 4])
    -> Vec<Vec<[f64; 2]>>
{
    let i0 = (bb[0] - 1).max(0) as usize;
    let j0 = (bb[1] - 1).max(0) as usize;
    let i1 = (bb[2] + 1).min(w as i32 - 1) as usize;
    let j1 = (bb[3] + 1).min(h as i32 - 1) as usize;
    if i1 < i0 || j1 < j0 { return Vec::new(); }
    let bw = i1 - i0 + 1;
    let bh = j1 - j0 + 1;
    if bw < 2 || bh < 2 { return Vec::new(); }
    let mut sub = vec![0u8; bw * bh];
    for j in 0..bh {
        for i in 0..bw { sub[j * bw + i] = if pond_id[(j0 + j) * w + i0 + i] == id { 1 } else { 0 }; }
    }
    trace_mask_inner(&sub, bw, bh, cell, x0 + i0 as f64 * cell, y0 + j0 as f64 * cell, 0.5 * cell)
        .into_iter().map(|r| r.0).collect()
}
