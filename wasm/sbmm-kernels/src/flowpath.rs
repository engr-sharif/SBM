/*! `flowpath` -- the raindrop of docs/V10_WATER_SPEC.md section 2, with v12's
    conduit shortcut rule, ported line for line from js/compute.js.

    WHAT IS HERE AND WHAT STAYED IN JAVASCRIPT. The walk is here: the inlet
    index, the fill, the descent, the fill-spill pond flood, the escape test
    and the conduit chain. The parts that are not loops over the grid stayed
    where they were -- ringMask/medianOf for the blocked ring (the host hands
    the mask and the level in), traceMask for the pond outlines, simplifyPath
    and the assembly of `pts`/`legs`/`ponds` into the result object. Porting a
    ring trace would buy nothing and cost the one thing this file is for.

    IDENTITY: bit-identical. Every comparison is reproduced with its own width
    and its own epsilon, and the only arithmetic is the drop ratio
    (level - z) / W_DD[t] and the pond's running sums -- all of them f64 in the
    same order, so the same bits come out.

    The output goes into the OUT arena, little-endian:
      i32  reason   0 none 1 window 2 nodata 3 pond 4 conduit 5 steps
      i32  steps
      i32  exit_idx          (-1 = none)
      i32  has_exit_xy
      f64  exit_x, exit_y
      i32  n_segs   then per segment: i32 count, count * i32 cell index
      i32  n_legs   then per leg: i32 cd, i32 seg, f64 len,
                                  f64 fx, fy, fz, ox, oy, oz   (NaN = none)
      i32  n_ponds  then per pond: f64 level, i32 outlet, i32 entry, f64 zmin,
                                   i32 count, f64 sum_z, i32 bb0..bb3,
                                   i32 blocked, i32 via_conduit (-1)
*/

use crate::fill::fill_dem_inner;
use crate::heap::Heap;
use crate::{mi32, out_f64, out_i32, out_reset, sf32, sf64, si32, mu8, W_DD, W_DI, W_DJ};

pub struct Cd<'a> {
    pub ix: &'a [f64], pub iy: &'a [f64], pub rim: &'a [f64],
    pub ox: &'a [f64], pub oy: &'a [f64], pub len: &'a [f64],
    pub next: &'a [i32],
}

struct Pond {
    level: f64, outlet: i32, entry: i32, zmin: f64,
    count: i32, sum_z: f64, bb: [i32; 4], blocked: i32, via: i32,
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn flowpath(
    z_ptr: *const f32, w: i32, h: i32, cell: f64, x0: f64, y0: f64,
    si: i32, sj: i32, max_steps: i32,
    cd_ix: *const f64, cd_iy: *const f64, cd_rim: *const f64,
    cd_ox: *const f64, cd_oy: *const f64, cd_len: *const f64, cd_next: *const i32,
    n_cd: i32, capture_ft: f64,
    block_mask: *mut u8, block_level: f64,
    pond_id_out: *mut i32,
) -> i32 {
    let (wu, hu) = (w as usize, h as usize);
    let n = wu * hu;
    let z = unsafe { sf32(z_ptr, n) };
    let pond_id = unsafe { mi32(pond_id_out, n) };
    let nc = n_cd as usize;
    let cd = Cd {
        ix: unsafe { sf64(cd_ix, nc) }, iy: unsafe { sf64(cd_iy, nc) },
        rim: unsafe { sf64(cd_rim, nc) }, ox: unsafe { sf64(cd_ox, nc) },
        oy: unsafe { sf64(cd_oy, nc) }, len: unsafe { sf64(cd_len, nc) },
        next: unsafe { si32(cd_next, nc) },
    };
    let bmask = if block_mask.is_null() { None } else { Some(unsafe { mu8(block_mask, n) }) };
    run(z, wu, hu, cell, x0, y0, si, sj, max_steps, &cd, nc, capture_ft, bmask, block_level, pond_id)
}

#[allow(clippy::too_many_arguments)]
fn run(
    z: &[f32], w: usize, h: usize, cell: f64, x0: f64, y0: f64,
    si: i32, sj: i32, max_steps: i32,
    cd: &Cd, nc: usize, capture_ft: f64,
    bmask: Option<&mut [u8]>, block_level: f64,
    pond_id: &mut [i32],
) -> i32 {
    let n = w * h;
    let (wi, hi) = (w as i32, h as i32);
    let idx = |i: i32, j: i32| -> usize { j as usize * w + i as usize };

    /* ---- v12: the inlet index (built BEFORE the fill, which it seeds) ---- */
    let has_cd = nc > 0;
    let mut inlet_at = vec![-1i32; if has_cd { n } else { 0 }];
    let mut inlet_d = vec![f32::INFINITY; if has_cd { n } else { 0 }];
    let mut cd_used = vec![0u8; nc];
    let mut cd_seen = vec![0u8; nc];
    let mut cd_cell = vec![0i32; nc];
    let mut sink_i: Vec<i32> = Vec::new();
    let mut sink_k: Vec<f64> = Vec::new();
    if has_cd {
        let crc = if capture_ft / cell > 0.0 { (capture_ft / cell).ceil() as i32 } else { 0 };
        for k in 0..nc {
            let ki = ((cd.ix[k] - x0) / cell).round() as i32;
            let kj = ((cd.iy[k] - y0) / cell).round() as i32;
            for cjj in (kj - crc)..=(kj + crc) {
                if cjj < 0 || cjj >= hi { continue; }
                for cii in (ki - crc)..=(ki + crc) {
                    if cii < 0 || cii >= wi { continue; }
                    let kdx = x0 + cii as f64 * cell - cd.ix[k];
                    let kdy = y0 + cjj as f64 * cell - cd.iy[k];
                    let kd = (kdx * kdx + kdy * kdy).sqrt();
                    if kd > capture_ft { continue; }
                    let kidx = idx(cii, cjj);
                    if z[kidx].is_nan() { continue; }
                    if (kd as f32) < inlet_d[kidx] { inlet_d[kidx] = kd as f32; inlet_at[kidx] = k as i32; }
                }
            }
        }
        for i in 0..n {
            if inlet_at[i] >= 0 {
                let r = cd.rim[inlet_at[i] as usize];
                sink_i.push(i as i32);
                sink_k.push(if r.is_finite() { r } else { z[i] as f64 });
            }
        }
    }

    let mut f = vec![0f32; n];
    fill_dem_inner(z, w, h, &sink_i, &sink_k, &mut f, None);

    for v in pond_id.iter_mut() { *v = 0; }
    let mut ponds: Vec<Pond> = Vec::new();
    ponds.push(Pond { level: 0.0, outlet: -1, entry: -1, zmin: 0.0, count: 0, sum_z: 0.0,
                      bb: [0, 0, 0, 0], blocked: 0, via: -1 });   /* ponds[0] unused */

    /* the impoundment, pre-marked as a pond with no outlet: the host hands in
       the ring mask and the plateau level, because ringMask/medianOf are not
       loops over the whole grid and stay in js/compute.js */
    if let Some(bm) = bmask {
        let bz0 = block_level;
        let mut p0 = Pond { level: bz0, outlet: -1, entry: -1, zmin: bz0, count: 0, sum_z: 0.0,
                            bb: [wi, hi, -1, -1], blocked: 1, via: -1 };
        for j in 0..h {
            for i in 0..w {
                let vi = j * w + i;
                if bm[vi] == 0 { continue; }
                p0.count += 1;
                pond_id[vi] = 1;
            }
        }
        ponds.push(p0);
    }

    if si < 0 || sj < 0 || si >= wi || sj >= hi { return -1; }
    let mut cur = idx(si, sj);
    if z[cur].is_nan() { return -2; }

    let mut segs: Vec<Vec<i32>> = vec![vec![cur as i32]];
    /* legs: (cd, seg, len, fx, fy, fz, ox, oy, oz) */
    let mut legs: Vec<(i32, i32, f64, f64, f64, f64, f64, f64, f64)> = Vec::new();
    let mut reason = 0i32;
    let mut steps = 0i32;
    let mut exit_idx = -1i32;
    let mut exit_xy: Option<(f64, f64)> = None;
    let mut hp = Heap::new(1 << 14);
    let mut stamp = vec![0i32; n];

    macro_rules! eff {
        ($i:expr) => {{ let k = pond_id[$i]; if k != 0 { ponds[k as usize].level } else { z[$i] as f64 } }};
    }

    /* Follow the conduit chain from k0, departing the ground at from_idx.
       Returns the cell the water reappears in, or -1 when the last outlet is
       outside the window / on NoData -- in which case exit_xy carries it. */
    macro_rules! follow_chain {
        ($k0:expr, $from:expr) => {{
            let mut kk: i32 = $k0;
            let from_idx: usize = $from;
            let seg_ix = (segs.len() - 1) as i32;
            let fi = (from_idx % w) as i32;
            let fj = ((from_idx - from_idx % w) / w) as i32;
            let mut fx = x0 + fi as f64 * cell;
            let mut fy = y0 + fj as f64 * cell;
            let mut fz = z[from_idx] as f64;
            let (mut oi, mut oj) = (-1i32, -1i32);
            let (mut ox, mut oy) = (fx, fy);
            let mut inside = false;
            let mut oz = f64::NAN;
            while kk >= 0 && cd_used[kk as usize] == 0 {
                let c1 = kk as usize;
                cd_used[c1] = 1;
                ox = cd.ox[c1]; oy = cd.oy[c1];
                oi = ((ox - x0) / cell).round() as i32;
                oj = ((oy - y0) / cell).round() as i32;
                inside = oi >= 0 && oj >= 0 && oi < wi && oj < hi;
                oz = if inside { z[idx(oi, oj)] as f64 } else { f64::NAN };
                let l = if cd.len[c1].is_finite() { cd.len[c1] } else { hypot(ox - fx, oy - fy) };
                legs.push((c1 as i32, seg_ix, l, fx, fy, fz, ox, oy, oz));
                fx = ox; fy = oy; fz = oz;
                let nx = cd.next[c1];
                kk = if nx >= 0 && cd_used[nx as usize] == 0 { nx } else { -1 };
            }
            if inside && !oz.is_nan() { idx(oi, oj) as i32 } else { exit_xy = Some((ox, oy)); -1 }
        }};
    }

    while steps < max_steps {
        steps += 1;
        let i = (cur % w) as i32;
        let j = ((cur - cur % w) / w) as i32;
        if i == 0 || j == 0 || i == wi - 1 || j == hi - 1 { reason = 1; exit_idx = cur as i32; break; }

        /* v12 section 2 "the shortcut rule", tested at the TOP of the step */
        if has_cd && inlet_at[cur] >= 0 && cd_used[inlet_at[cur] as usize] == 0 {
            let oc = follow_chain!(inlet_at[cur], cur);
            if oc < 0 { reason = 4; break; }
            segs.push(vec![oc]);
            cur = oc as usize;
            continue;
        }

        /* steepest descent on EFFECTIVE elevation */
        let ze = eff!(cur);
        let (mut b_drop, mut b_idx, mut nod) = (-1f64, -1i32, -1i32);
        for t in 0..8 {
            let ni = i + W_DI[t];
            let nj = j + W_DJ[t];
            if ni < 0 || nj < 0 || ni >= wi || nj >= hi { continue; }
            let vi = idx(ni, nj);
            if z[vi].is_nan() { nod = vi as i32; break; }
            let dr = (ze - eff!(vi)) / W_DD[t];
            if dr > 1e-9 && dr > b_drop { b_drop = dr; b_idx = vi as i32; }
        }
        if nod >= 0 { segs.last_mut().unwrap().push(nod); reason = 2; break; }

        if b_idx >= 0 {
            let pk = pond_id[b_idx as usize];
            if pk != 0 {
                segs.last_mut().unwrap().push(b_idx);
                if ponds[pk as usize].outlet < 0 { reason = 3; break; }
                cur = ponds[pk as usize].outlet as usize;
                segs.last_mut().unwrap().push(cur as i32);
            } else {
                cur = b_idx as usize;
                segs.last_mut().unwrap().push(cur as i32);
            }
            continue;
        }

        /* ---- a pit: flood it until water escapes ---- */
        let pid = ponds.len() as i32;
        ponds.push(Pond { level: z[cur] as f64, outlet: -1, entry: cur as i32, zmin: z[cur] as f64,
                          count: 0, sum_z: 0.0, bb: [wi, hi, -1, -1], blocked: 0, via: -1 });
        hp.clear();
        hp.push(z[cur] as f64, ((h - 1 - j as usize) * w + i as usize) as i32);
        stamp[cur] = pid;
        let mut level = z[cur] as f64;
        let mut outlet = -1i32;
        let mut pend: Vec<usize> = Vec::new();
        let mut via_inlet = -1i32;
        if has_cd { for v in cd_seen.iter_mut() { *v = 0; } }

        while hp.n > 0 {
            let nm = hp.pop() as usize;
            let rr = nm / w;
            let ui = (nm - rr * w) as i32;
            let uj = (h - 1 - rr) as i32;
            let uidx = idx(ui, uj);
            if pond_id[uidx] != 0 { continue; }
            if hp.top_key > level { level = hp.top_key; }
            pond_id[uidx] = pid;
            {
                let p = &mut ponds[pid as usize];
                p.count += 1;
                p.sum_z += z[uidx] as f64;
                if (z[uidx] as f64) < p.zmin { p.zmin = z[uidx] as f64; }
                if ui < p.bb[0] { p.bb[0] = ui; }
                if uj < p.bb[1] { p.bb[1] = uj; }
                if ui > p.bb[2] { p.bb[2] = ui; }
                if uj > p.bb[3] { p.bb[3] = uj; }
            }
            if ui == 0 || uj == 0 || ui == wi - 1 || uj == hi - 1 { reason = 1; exit_idx = uidx as i32; break; }

            if has_cd {
                /* reach(uidx) */
                let kk = inlet_at[uidx];
                if kk >= 0 && cd_used[kk as usize] == 0 {
                    let ku = kk as usize;
                    if cd_seen[ku] == 0 { cd_seen[ku] = 1; cd_cell[ku] = uidx as i32; pend.push(ku); }
                    else if inlet_d[uidx] < inlet_d[cd_cell[ku] as usize] { cd_cell[ku] = uidx as i32; }
                }
                let mut best_rim = f64::INFINITY;
                for pi in 0..pend.len() {
                    let pk = pend[pi];
                    if cd_used[pk] != 0 { continue; }
                    let mut prim = cd.rim[pk];
                    if !prim.is_finite() { prim = z[cd_cell[pk] as usize] as f64; }
                    if prim <= level + 1e-9 && prim < best_rim { best_rim = prim; via_inlet = cd_cell[pk]; }
                }
                if via_inlet >= 0 { outlet = via_inlet; break; }
            }

            let (mut e_nod, mut e_idx, mut e_drop) = (-1i32, -1i32, -1f64);
            for t in 0..8 {
                let ni = ui + W_DI[t];
                let nj = uj + W_DJ[t];
                if ni < 0 || nj < 0 || ni >= wi || nj >= hi { continue; }
                let vi = idx(ni, nj);
                if z[vi].is_nan() { e_nod = vi as i32; break; }
                if pond_id[vi] != 0 { continue; }
                if (z[vi] as f64) < level - 1e-9 && (f[vi] as f64) < level - 1e-6 {
                    let ed = (level - z[vi] as f64) / W_DD[t];
                    if ed > e_drop { e_drop = ed; e_idx = vi as i32; }
                }
            }
            if e_nod >= 0 { segs.last_mut().unwrap().push(e_nod); reason = 2; break; }
            if e_idx >= 0 { outlet = e_idx; break; }
            for t in 0..8 {
                let ni = ui + W_DI[t];
                let nj = uj + W_DJ[t];
                if ni < 0 || nj < 0 || ni >= wi || nj >= hi { continue; }
                let vi = idx(ni, nj);
                if z[vi].is_nan() || pond_id[vi] != 0 || stamp[vi] == pid { continue; }
                stamp[vi] = pid;
                hp.push(z[vi] as f64, ((h - 1 - nj as usize) * w + ni as usize) as i32);
            }
        }
        /* completion: everything still under the pour level is under water
           unless it escapes (then it is a wall, and the flood never crosses it) */
        if outlet >= 0 {
            while hp.n > 0 && hp.k[0] <= level + 1e-9 {
                let nm = hp.pop() as usize;
                let rr = nm / w;
                let ui = (nm - rr * w) as i32;
                let uj = (h - 1 - rr) as i32;
                let uidx = idx(ui, uj);
                if pond_id[uidx] != 0 { continue; }
                if (z[uidx] as f64) < level - 1e-9 && (f[uidx] as f64) < level - 1e-6 { continue; }
                pond_id[uidx] = pid;
                {
                    let p = &mut ponds[pid as usize];
                    p.count += 1;
                    p.sum_z += z[uidx] as f64;
                    if (z[uidx] as f64) < p.zmin { p.zmin = z[uidx] as f64; }
                    if ui < p.bb[0] { p.bb[0] = ui; }
                    if uj < p.bb[1] { p.bb[1] = uj; }
                    if ui > p.bb[2] { p.bb[2] = ui; }
                    if uj > p.bb[3] { p.bb[3] = uj; }
                }
                for t in 0..8 {
                    let ni = ui + W_DI[t];
                    let nj = uj + W_DJ[t];
                    if ni < 0 || nj < 0 || ni >= wi || nj >= hi { continue; }
                    let vi = idx(ni, nj);
                    if z[vi].is_nan() || pond_id[vi] != 0 || stamp[vi] == pid { continue; }
                    if (z[vi] as f64) > level + 1e-9 { continue; }
                    stamp[vi] = pid;
                    hp.push(z[vi] as f64, ((h - 1 - nj as usize) * w + ni as usize) as i32);
                }
            }
        }
        ponds[pid as usize].level = level;
        ponds[pid as usize].outlet = outlet;
        if reason != 0 { break; }
        if outlet < 0 { reason = 3; break; }
        cur = outlet as usize;
        segs.last_mut().unwrap().push(cur as i32);
        if via_inlet >= 0 {
            ponds[pid as usize].via = inlet_at[via_inlet as usize];
            let oc2 = follow_chain!(inlet_at[via_inlet as usize], via_inlet as usize);
            if oc2 < 0 { reason = 4; break; }
            segs.push(vec![oc2]);
            cur = oc2 as usize;
        }
    }
    if reason == 0 { reason = 5; }

    /* ---- the OUT arena ---------------------------------------------------- */
    out_reset();
    out_i32(reason);
    out_i32(steps);
    out_i32(exit_idx);
    out_i32(if exit_xy.is_some() { 1 } else { 0 });
    let (ex, ey) = exit_xy.unwrap_or((0.0, 0.0));
    out_f64(ex);
    out_f64(ey);
    out_i32(segs.len() as i32);
    for s in &segs {
        out_i32(s.len() as i32);
        for c in s { out_i32(*c); }
    }
    out_i32(legs.len() as i32);
    for l in &legs {
        out_i32(l.0); out_i32(l.1);
        out_f64(l.2); out_f64(l.3); out_f64(l.4); out_f64(l.5);
        out_f64(l.6); out_f64(l.7); out_f64(l.8);
    }
    out_i32(ponds.len() as i32);
    for p in &ponds {
        out_f64(p.level); out_i32(p.outlet); out_i32(p.entry); out_f64(p.zmin);
        out_i32(p.count); out_f64(p.sum_z);
        out_i32(p.bb[0]); out_i32(p.bb[1]); out_i32(p.bb[2]); out_i32(p.bb[3]);
        out_i32(p.blocked); out_i32(p.via);
    }
    0
}

/* Math.hypot, and the JavaScript one: it is not sqrt(a*a+b*b), it scales by the
   larger magnitude first. The lengths it produces are compared against a
   golden, so the port has to be the same function. */
#[inline]
pub(crate) fn hypot(a: f64, b: f64) -> f64 {
    let (x, y) = (a.abs(), b.abs());
    let m = if x > y { x } else { y };
    if m == 0.0 { return 0.0; }
    if m.is_infinite() { return f64::INFINITY; }
    let (x, y) = (x / m, y / m);
    m * (x * x + y * y).sqrt()
}
