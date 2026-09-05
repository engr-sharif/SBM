/*! The shared geometry of js/compute.js: `marchOne` (marching squares plus the
    endpoint chaining) and the ring-aware `simplifyPath`.

    This is the highest-leverage piece in the file: `marchOne` is what
    `traceMask` runs, and `traceMask` is what draws every pond outline, every
    stage-table ring of the overtopping analysis, every catchment polygon of
    the drainage map and the smart-boundary tools' own rings.

    THE CHAINING KEY IS JAVASCRIPT'S. js/compute.js chains segments through a
    Map keyed by `Math.round(p*10) + "," + Math.round(p*10)`, and Math.round is
    round-half-UP (towards +Infinity), NOT Rust's round-half-away-from-zero.
    On this site every coordinate is a large positive number in State Plane
    feet so the two agree, but the port says `(v + 0.5).floor()` anyway,
    because the moment one does not the rings would differ in a way nothing
    would catch.

    The hash tables are open-addressed and hand-written, deterministically
    seeded: std's RandomState wants entropy the wasm32-unknown-unknown target
    does not have, and a kernel whose answer depended on a hash seed would not
    be a kernel.
*/

use crate::{out_f64, out_i32, out_reset, sf32};
use core::f64;

#[inline]
pub fn js_round(v: f64) -> i64 { (v + 0.5).floor() as i64 }

#[inline]
pub fn pkey(x: f64, y: f64) -> u64 {
    ((js_round(x * 10.0) as i64 as u64) << 32) | (js_round(y * 10.0) as i64 as u32 as u64)
}

#[inline]
fn mix(mut k: u64) -> u64 {
    k ^= k >> 33; k = k.wrapping_mul(0xff51afd7ed558ccd);
    k ^= k >> 33; k = k.wrapping_mul(0xc4ceb9fe1a85ec53);
    k ^ (k >> 33)
}

/* key -> u32 value, open addressing, linear probe. EMPTY is u64::MAX. */
pub struct U64Map { k: Vec<u64>, v: Vec<u32>, mask: usize, n: usize }
const EMPTY: u64 = u64::MAX;

impl U64Map {
    pub fn new(cap: usize) -> U64Map {
        let mut c = 16usize;
        while c < cap * 2 { c <<= 1; }
        U64Map { k: vec![EMPTY; c], v: vec![0; c], mask: c - 1, n: 0 }
    }
    fn grow(&mut self) {
        let c = self.k.len() * 2;
        let (ok, ov) = (core::mem::take(&mut self.k), core::mem::take(&mut self.v));
        self.k = vec![EMPTY; c]; self.v = vec![0; c]; self.mask = c - 1;
        for i in 0..ok.len() {
            if ok[i] == EMPTY { continue; }
            let mut p = (mix(ok[i]) as usize) & self.mask;
            while self.k[p] != EMPTY { p = (p + 1) & self.mask; }
            self.k[p] = ok[i]; self.v[p] = ov[i];
        }
    }
    #[inline]
    pub fn get(&self, key: u64) -> Option<u32> {
        let mut p = (mix(key) as usize) & self.mask;
        loop {
            if self.k[p] == EMPTY { return None; }
            if self.k[p] == key { return Some(self.v[p]); }
            p = (p + 1) & self.mask;
        }
    }
    /* insert if absent, answering the value that is there afterwards */
    #[inline]
    pub fn entry(&mut self, key: u64, val: u32) -> u32 {
        if self.n * 2 >= self.k.len() { self.grow(); }
        let mut p = (mix(key) as usize) & self.mask;
        loop {
            if self.k[p] == EMPTY { self.k[p] = key; self.v[p] = val; self.n += 1; return val; }
            if self.k[p] == key { return self.v[p]; }
            p = (p + 1) & self.mask;
        }
    }
    #[inline]
    pub fn insert(&mut self, key: u64) -> bool {   /* true = it was new */
        if self.n * 2 >= self.k.len() { self.grow(); }
        let mut p = (mix(key) as usize) & self.mask;
        loop {
            if self.k[p] == EMPTY { self.k[p] = key; self.v[p] = 1; self.n += 1; return true; }
            if self.k[p] == key { return false; }
            p = (p + 1) & self.mask;
        }
    }
    #[inline]
    pub fn has(&self, key: u64) -> bool { self.get(key).is_some() }
}

#[inline]
pub fn hypot(a: f64, b: f64) -> f64 {
    let (x, y) = (a.abs(), b.abs());
    let m = if x > y { x } else { y };
    if m == 0.0 { return 0.0; }
    if m.is_infinite() { return f64::INFINITY; }
    let (x, y) = (x / m, y / m);
    m * (x * x + y * y).sqrt()
}

/* ------------------------------------------ Douglas-Peucker, ring-aware --- */

fn simplify_line(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    let n = pts.len();
    if n < 3 { return pts.to_vec(); }
    let mut keep = vec![0u8; n];
    keep[0] = 1; keep[n - 1] = 1;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((i0, i1)) = stack.pop() {
        let a = pts[i0];
        let b = pts[i1];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let mut l = hypot(dx, dy);
        if l == 0.0 { l = 1e-9; }
        let mut dmax = -1f64;
        let mut imax = usize::MAX;
        let mut i = i0 + 1;
        while i < i1 {
            let d = (dx * (a[1] - pts[i][1]) - dy * (a[0] - pts[i][0])).abs() / l;
            if d > dmax { dmax = d; imax = i; }
            i += 1;
        }
        if dmax > tol && imax != usize::MAX {
            keep[imax] = 1;
            stack.push((i0, imax));
            stack.push((imax, i1));
        }
    }
    let mut out = Vec::with_capacity(n);
    for k in 0..n { if keep[k] != 0 { out.push(pts[k]); } }
    out
}

pub fn simplify_path(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    let n = pts.len();
    if n < 5 { return pts.to_vec(); }
    let a = pts[0];
    let b = pts[n - 1];
    if (a[0] - b[0]).abs() > 1e-9 || (a[1] - b[1]).abs() > 1e-9 { return simplify_line(pts, tol); }
    let mut far = 0usize;
    let mut fd = -1f64;
    for i in 1..n - 1 {
        let d = (pts[i][0] - a[0]) * (pts[i][0] - a[0]) + (pts[i][1] - a[1]) * (pts[i][1] - a[1]);
        if d > fd { fd = d; far = i; }
    }
    if far < 2 || far > n - 3 { return pts.to_vec(); }
    let h1 = simplify_line(&pts[0..far + 1], tol);
    let h2 = simplify_line(&pts[far..], tol);
    let mut out = h1;
    out.extend_from_slice(&h2[1..]);
    out
}

/* --------------------------------------- marching squares + the chaining -- */

#[inline]
pub fn frac(a: f64, b: f64, lv: f64) -> f64 {
    if (b - a).abs() < 1e-12 { return 0.5; }
    let t = (lv - a) / (b - a);
    if t < 0.0 { 0.0 } else if t > 1.0 { 1.0 } else { t }
}

/* The segment list marching squares builds, in js/compute.js's own order. */
pub struct MarchSegs { pub a: Vec<[f64; 2]>, pub b: Vec<[f64; 2]> }
impl MarchSegs {
    pub fn new() -> MarchSegs { MarchSegs { a: Vec::new(), b: Vec::new() } }
    #[inline]
    pub fn push(&mut self, p: [f64; 2], q: [f64; 2]) { self.a.push(p); self.b.push(q); }
    #[inline]
    pub fn clear(&mut self) { self.a.clear(); self.b.clear(); }
    #[inline]
    pub fn len(&self) -> usize { self.a.len() }
}
impl Default for MarchSegs { fn default() -> Self { Self::new() } }

/* The endpoint chaining, shared by `marchOne` and `contoursFromGrid`. Returns
   the raw chained polylines; each caller applies its own simplify tolerance
   and its own keep rule, because the two differ (0.35 * cell and >= 3 vertices
   for marchOne, 0.3 * cell * stride and a stub-length floor for contours).
   `guard` is the per-line step cap, and it is per SEED line and shared across
   the two directions, exactly as the JavaScript declares it. */
pub fn march_chain(segs: &MarchSegs, guard_max: u32) -> Vec<Vec<[f64; 2]>> {
    let ns = segs.len();
    let mut lines: Vec<Vec<[f64; 2]>> = Vec::new();
    if ns == 0 { return lines; }
    let (sa, sb) = (&segs.a, &segs.b);

    /* point ids by the rounded key, in first-seen order (the Map's own order) */
    let mut pmap = U64Map::new(ns * 2);
    let mut npts = 0u32;
    let mut ka: Vec<u32> = Vec::with_capacity(ns);
    let mut kb: Vec<u32> = Vec::with_capacity(ns);
    for e in 0..ns {
        let a = pmap.entry(pkey(sa[e][0], sa[e][1]), npts);
        if a == npts { npts += 1; }
        let b = pmap.entry(pkey(sb[e][0], sb[e][1]), npts);
        if b == npts { npts += 1; }
        ka.push(a);
        kb.push(b);
    }
    /* pools, in insertion order: segs.get(ka).push([a,b]); segs.get(kb).push([b,a]) */
    let mut pool: Vec<Vec<u32>> = vec![Vec::new(); npts as usize];
    for e in 0..ns {
        pool[ka[e] as usize].push((e as u32) << 1);          /* a -> b */
        pool[kb[e] as usize].push(((e as u32) << 1) | 1);    /* b -> a */
    }
    #[inline]
    fn dkey(from: u32, to: u32) -> u64 { ((from as u64) << 32) | to as u64 }

    let mut used = U64Map::new(ns * 4);
    let mut line: std::collections::VecDeque<[f64; 2]> = std::collections::VecDeque::new();

    for e in 0..ns {
        if used.has(dkey(ka[e], kb[e])) { continue; }
        line.clear();
        line.push_back(sa[e]);
        line.push_back(sb[e]);
        let mut head = ka[e];
        let mut tail = kb[e];
        used.insert(dkey(ka[e], kb[e]));
        used.insert(dkey(kb[e], ka[e]));
        let mut guard = 0u32;
        for di in 0..2 {
            let dir_end = di == 0;                 /* dirs = [1, 0] */
            loop {
                let g = guard; guard += 1;
                if g >= guard_max { break; }
                let end = if dir_end { tail } else { head };
                let mut cand: i64 = -1;
                for &pe in pool[end as usize].iter() {
                    let seg = (pe >> 1) as usize;
                    let (f, t) = if pe & 1 == 0 { (ka[seg], kb[seg]) } else { (kb[seg], ka[seg]) };
                    if !used.has(dkey(f, t)) { cand = pe as i64; break; }
                }
                if cand < 0 { break; }
                let pe = cand as u32;
                let seg = (pe >> 1) as usize;
                let (f, t, tp) = if pe & 1 == 0 { (ka[seg], kb[seg], sb[seg]) }
                                 else { (kb[seg], ka[seg], sa[seg]) };
                used.insert(dkey(f, t));
                used.insert(dkey(t, f));
                if dir_end { line.push_back(tp); tail = t; } else { line.push_front(tp); head = t; }
            }
        }
        lines.push(line.iter().copied().collect());
    }
    lines
}

/// The port of `marchOne`. `simp` is the tolerance it applies to a chained
/// line before keeping it (cell * 0.35 in js/compute.js); pass <= 0 for none.
pub fn march_one(z: &[f32], nx: usize, ny: usize, cell: f64, x0: f64, y0: f64, lv: f64, simp: f64)
    -> Vec<Vec<[f64; 2]>>
{
    let mut segs = MarchSegs::new();
    for j in 0..ny.saturating_sub(1) {
        for i in 0..nx.saturating_sub(1) {
            let za = z[j * nx + i] as f64;
            let zb = z[j * nx + i + 1] as f64;
            let zc = z[(j + 1) * nx + i + 1] as f64;
            let zd = z[(j + 1) * nx + i] as f64;
            if za.is_nan() || zb.is_nan() || zc.is_nan() || zd.is_nan() { continue; }
            let mut idx = 0u8;
            if za >= lv { idx |= 1; }
            if zb >= lv { idx |= 2; }
            if zc >= lv { idx |= 4; }
            if zd >= lv { idx |= 8; }
            if idx == 0 || idx == 15 { continue; }
            let x = x0 + i as f64 * cell;
            let y = y0 + j as f64 * cell;
            let c = cell;
            let bot = [x + c * frac(za, zb, lv), y];
            let right = [x + c, y + c * frac(zb, zc, lv)];
            let top = [x + c * frac(zd, zc, lv), y + c];
            let left = [x, y + c * frac(za, zd, lv)];
            match idx {
                1 | 14 => segs.push(left, bot),
                2 | 13 => segs.push(bot, right),
                3 | 12 => segs.push(left, right),
                4 | 11 => segs.push(right, top),
                6 | 9 => segs.push(bot, top),
                7 | 8 => segs.push(left, top),
                5 => { segs.push(left, bot); segs.push(right, top); }
                10 => { segs.push(bot, right); segs.push(left, top); }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    for v in march_chain(&segs, 200000) {
        let v = if v.len() >= 3 && simp > 0.0 { simplify_path(&v, simp) } else { v };
        if v.len() >= 3 { out.push(v); }
    }
    out
}

/// exported: marchOne over an f32 grid, lines into the OUT arena
/// (i32 n_lines; per line i32 npts then npts * (f64 x, f64 y))
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn march_one_f32(
    z_ptr: *const f32, nx: i32, ny: i32, cell: f64, x0: f64, y0: f64, lv: f64, simp: f64,
) {
    let (nxu, nyu) = (nx as usize, ny as usize);
    let z = unsafe { sf32(z_ptr, nxu * nyu) };
    let lines = march_one(z, nxu, nyu, cell, x0, y0, lv, simp);
    out_reset();
    out_i32(lines.len() as i32);
    for l in &lines {
        out_i32(l.len() as i32);
        for p in l { out_f64(p[0]); out_f64(p[1]); }
    }
}
