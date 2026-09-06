/*! `fillDem` -- the outside-in priority flood of js/compute.js, ported line for
    line (docs/V10_WATER_SPEC.md section 2 "Filled DEM F", v12's conduit
    seeding, v14's optional parent forest).

    IDENTITY: bit-identical, by construction. Every value written into F is a
    copy of a z, a copy of a level already in F, or the f32 of a caller's f64
    sink key -- there is no arithmetic anywhere in this kernel -- and the
    traversal order is fixed by the heap's north-major tie-break, so the parent
    forest matches cell for cell too. NaN cells stay NaN.
*/

use crate::heap::Heap;
use crate::{mf32, mi32, sf32, sf64, si32, W_DI, W_DJ};

/// z: w*h f32 (NaN = NoData).  sinks: n_sinks pairs (cell index, key).
/// f_ptr: w*h f32 out.  parent_ptr: w*h i32 out, or null for "not wanted".
#[no_mangle]
pub extern "C" fn fill_dem(
    z_ptr: *const f32, w: i32, h: i32,
    sink_idx: *const i32, sink_key: *const f64, n_sinks: i32,
    f_ptr: *mut f32, parent_ptr: *mut i32,
) {
    let (w, h) = (w as usize, h as usize);
    let n = w * h;
    let z = unsafe { sf32(z_ptr, n) };
    let f = unsafe { mf32(f_ptr, n) };
    let want_parent = !parent_ptr.is_null();
    let parent = unsafe { mi32(parent_ptr, if want_parent { n } else { 0 }) };
    let sidx = unsafe { si32(sink_idx, n_sinks as usize) };
    let skey = unsafe { sf64(sink_key, n_sinks as usize) };
    fill_dem_inner(z, w, h, sidx, skey, f, if want_parent { Some(parent) } else { None });
}

pub fn fill_dem_inner(
    z: &[f32], w: usize, h: usize,
    sidx: &[i32], skeys: &[f64],
    f: &mut [f32], parent: Option<&mut [i32]>,
) {
    let n = w * h;
    let mut closed = vec![0u8; n];
    let mut hp = Heap::new(1 << 15);
    let mut q: Vec<i32> = vec![0; n];
    let (mut qh, mut qt) = (0usize, 0usize);

    for v in f.iter_mut() { *v = f32::NAN; }
    let mut empty: [i32; 0] = [];
    let par: &mut [i32] = match parent {
        Some(p) => { for v in p.iter_mut() { *v = -1; } p }
        None => &mut empty,
    };
    let has_par = !par.is_empty();

    /* v12: a conduit inlet is a SINK at its rim. */
    for k in 0..sidx.len() {
        let sk = sidx[k] as usize;
        let mut key = skeys[k];
        if closed[sk] != 0 || z[sk].is_nan() { continue; }
        if !(key > z[sk] as f64) { key = z[sk] as f64; }
        closed[sk] = 1;
        f[sk] = key as f32;
        let si = sk % w;
        let sj = (sk - si) / w;
        hp.push(key, ((h - 1 - sj) * w + si) as i32);
    }

    /* NOTE, and it is deliberate: the JS does NOT test `closed` in this loop,
       so a seeded sink that is also an edge cell is closed again, has its key
       overwritten with z and is pushed a SECOND time. Reproduced exactly --
       "the JavaScript is the reference" includes its corners. */
    for j in 0..h {
        for i in 0..w {
            let k = j * w + i;
            if z[k].is_nan() { closed[k] = 1; continue; }
            let mut edge = i == 0 || j == 0 || i == w - 1 || j == h - 1;
            if !edge {
                for t in 0..8 {
                    let ni = i as i32 + W_DI[t];
                    let nj = j as i32 + W_DJ[t];
                    if ni < 0 || nj < 0 || ni >= w as i32 || nj >= h as i32 { continue; }
                    if z[nj as usize * w + ni as usize].is_nan() { edge = true; break; }
                }
            }
            if edge {
                closed[k] = 1;
                f[k] = z[k];
                hp.push(z[k] as f64, ((h - 1 - j) * w + i) as i32);
            }
        }
    }

    /* The hot loop. Unchecked indexing: ci/cj and ni/nj are bounds-tested above
       every use, so the checks here are pure overhead -- and they are most of
       the difference between this and the JIT'd JavaScript on 21 M cells. */
    unsafe {
        let zp = z.as_ptr();
        let fp = f.as_mut_ptr();
        let cp = closed.as_mut_ptr();
        let qp = q.as_mut_ptr();
        let pp = par.as_mut_ptr();
        let wi = w as i32;
        let hi = h as i32;
        while hp.n > 0 || qh < qt {
            let (c, ci, cj, lev);
            if qh < qt {
                c = *qp.add(qh) as usize; qh += 1;
                ci = (c % w) as i32; cj = ((c - ci as usize) / w) as i32;
                lev = *fp.add(c) as f64;
            } else {
                let nm = hp.pop() as usize;
                let rr = nm / w;
                ci = (nm - rr * w) as i32;
                cj = (h - 1 - rr) as i32;
                c = cj as usize * w + ci as usize;
                lev = hp.top_key;
            }
            for t in 0..8 {
                let ni = ci + W_DI[t];
                let nj = cj + W_DJ[t];
                if ni < 0 || nj < 0 || ni >= wi || nj >= hi { continue; }
                let vi = nj as usize * w + ni as usize;
                if *cp.add(vi) != 0 { continue; }
                *cp.add(vi) = 1;
                if has_par { *pp.add(vi) = c as i32; }
                let zv = *zp.add(vi);
                if (zv as f64) <= lev {
                    *fp.add(vi) = lev as f32;
                    *qp.add(qt) = vi as i32; qt += 1;
                } else {
                    *fp.add(vi) = zv;
                    hp.push(zv as f64, ((h - 1 - nj as usize) * w + ni as usize) as i32);
                }
            }
        }
    }
}
