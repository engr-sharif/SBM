/*! `volumeGrid` -- the perimeter-TIN memo method of js/compute.js, ported line
    for line, with its four other bases (plane, fixed, lowest, design).

    THE GOLDEN NUMBER LIVES HERE: Pile 1 (Fig 2 traced) = 278.4 yd3 fill,
    -48.1 net. If a change moves it, the change is wrong (CLAUDE.md). So the
    port keeps the JavaScript's own order of operations everywhere it could
    matter -- the row-major sweep (jy outer, ix inner) so `fill` and `cut`
    accumulate in exactly the same order, the bucket grid's 32 x 32 shape and
    its insertion order so `tinBase` returns the SAME triangle where two
    overlap, and `pointInPoly`'s half-open crossing rule to the character.

    IDENTITY: bit-identical. Every accumulation is f64 in the same sequence
    and every sample is the same bilinear read, so there is no summation-order
    tolerance to claim.

    The Delaunay triangulation itself is NOT here -- it is done by the host,
    the way js/tools.js buildVolumeJob does it, and its `triangles` index
    array is handed in.
*/

use crate::{mf32, sf32, sf64, si32, su32};

/* the grid stack, flattened: one entry per gspec, z in one concatenated
   buffer with per-grid offsets */
struct Grids<'a> {
    x0: &'a [f64], y0: &'a [f64], cell: &'a [f64],
    w: &'a [i32], h: &'a [i32], i0: &'a [i32], j0: &'a [i32],
    sw: &'a [i32], sh: &'a [i32], off: &'a [i32],
    z: &'a [f32],
    n: usize,
}

impl<'a> Grids<'a> {
    /* js/compute.js gz(): full-grid indices, NaN outside the shipped window */
    #[inline]
    fn gz(&self, k: usize, i: i32, j: i32) -> f64 {
        let ii = i - self.i0[k];
        let jj = j - self.j0[k];
        if ii < 0 || jj < 0 || ii >= self.sw[k] || jj >= self.sh[k] { return f64::NAN; }
        self.z[(self.off[k] + jj * self.sw[k] + ii) as usize] as f64
    }
    #[inline]
    fn inside(&self, k: usize, x: f64, y: f64) -> bool {
        x >= self.x0[k] && y >= self.y0[k]
            && x <= self.x0[k] + (self.w[k] - 1) as f64 * self.cell[k]
            && y <= self.y0[k] + (self.h[k] - 1) as f64 * self.cell[k]
    }
    /* bilinear, including Dem.at's "first valid corner" NoData rule */
    fn at(&self, k: usize, x: f64, y: f64) -> f64 {
        let fx = (x - self.x0[k]) / self.cell[k];
        let fy = (y - self.y0[k]) / self.cell[k];
        let i = fx.floor();
        let j = fy.floor();
        if i < 0.0 || j < 0.0 || i >= (self.w[k] - 1) as f64 || j >= (self.h[k] - 1) as f64 {
            return f64::NAN;
        }
        let (i, j) = (i as i32, j as i32);
        let a = self.gz(k, i, j);
        let b = self.gz(k, i + 1, j);
        let c = self.gz(k, i, j + 1);
        let d = self.gz(k, i + 1, j + 1);
        if a.is_nan() || b.is_nan() || c.is_nan() || d.is_nan() {
            for v in [a, b, c, d] { if !v.is_nan() { return v; } }
            return f64::NAN;
        }
        let u = fx - i as f64;
        let v = fy - j as f64;
        a * (1.0 - u) * (1.0 - v) + b * u * (1.0 - v) + c * (1.0 - u) * v + d * u * v
    }
    /* js/compute.js elevOf(): the stack in the order jobs.js shipped it */
    fn elev(&self, x: f64, y: f64) -> f64 {
        for k in 0..self.n {
            if !self.inside(k, x, y) { continue; }
            let z = self.at(k, x, y);
            if !z.is_nan() { return z; }
        }
        f64::NAN
    }
}

#[inline]
fn clamp_i(v: f64, a: i32, b: i32) -> i32 {
    let v = v as i32;
    if v < a { a } else if v > b { b } else { v }
}

/* js/compute.js pointInPoly, crossing rule and all */
fn point_in_poly(x: f64, y: f64, px: &[f64], py: &[f64]) -> bool {
    let n = px.len();
    let mut inn = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi, xj, yj) = (px[i], py[i], px[j], py[j]);
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) { inn = !inn; }
        j = i;
    }
    inn
}

/* the perimeter TIN with the same 32 x 32 uniform index the JavaScript builds,
   so where two triangles overlap a query cell the SAME one wins */
const G: usize = 32;
struct Tin {
    /* per triangle: the three vertices and the bbox, in the JS's own T layout */
    tri: Vec<[f64; 13]>,   /* ax ay az bx by bz cx cy cz  minx miny maxx maxy */
    cells: Vec<Vec<u32>>,
    x0: f64, y0: f64, gw: f64, gh: f64,
    perim: Vec<[f64; 3]>,
}

impl Tin {
    fn new(perim: Vec<[f64; 3]>, tri_idx: &[u32]) -> Tin {
        let n = tri_idx.len() / 3;
        let (mut x0, mut y0) = (f64::INFINITY, f64::INFINITY);
        let (mut x1, mut y1) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in &perim {
            if p[0] < x0 { x0 = p[0]; }
            if p[0] > x1 { x1 = p[0]; }
            if p[1] < y0 { y0 = p[1]; }
            if p[1] > y1 { y1 = p[1]; }
        }
        let gw = { let v = (x1 - x0) / G as f64; if v == 0.0 || v.is_nan() { 1.0 } else { v } };
        let gh = { let v = (y1 - y0) / G as f64; if v == 0.0 || v.is_nan() { 1.0 } else { v } };
        let mut t = Tin { tri: Vec::with_capacity(n), cells: vec![Vec::new(); G * G],
                          x0, y0, gw, gh, perim };
        for k in 0..n {
            let a = t.perim[tri_idx[3 * k] as usize];
            let b = t.perim[tri_idx[3 * k + 1] as usize];
            let c = t.perim[tri_idx[3 * k + 2] as usize];
            let rec = [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
                       a[0].min(b[0]).min(c[0]), a[1].min(b[1]).min(c[1]),
                       a[0].max(b[0]).max(c[0]), a[1].max(b[1]).max(c[1])];
            let i0 = clamp_i(((rec[9] - x0) / gw).floor(), 0, G as i32 - 1);
            let i1 = clamp_i(((rec[11] - x0) / gw).floor(), 0, G as i32 - 1);
            let j0 = clamp_i(((rec[10] - y0) / gh).floor(), 0, G as i32 - 1);
            let j1 = clamp_i(((rec[12] - y0) / gh).floor(), 0, G as i32 - 1);
            let id = t.tri.len() as u32;
            t.tri.push(rec);
            for j in j0..=j1 { for i in i0..=i1 { t.cells[j as usize * G + i as usize].push(id); } }
        }
        t
    }
    fn at(&self, x: f64, y: f64) -> f64 {
        let gi = clamp_i(((x - self.x0) / self.gw).floor(), 0, G as i32 - 1);
        let gj = clamp_i(((y - self.y0) / self.gh).floor(), 0, G as i32 - 1);
        for &id in self.cells[gj as usize * G + gi as usize].iter() {
            let t = &self.tri[id as usize];
            if x < t[9] || x > t[11] || y < t[10] || y > t[12] { continue; }
            let (ax, ay, az) = (t[0], t[1], t[2]);
            let (bx, by, bz) = (t[3], t[4], t[5]);
            let (cx, cy, cz) = (t[6], t[7], t[8]);
            let d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if d.abs() < 1e-9 { continue; }
            let w1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
            let w2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
            let w3 = 1.0 - w1 - w2;
            if w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6 { continue; }
            return w1 * az + w2 * bz + w3 * cz;
        }
        /* outside the hull: the nearest perimeter sample */
        let mut best = 1e30f64;
        let mut bz = f64::NAN;
        for p in &self.perim {
            let dd = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y);
            if dd < best { best = dd; bz = p[2]; }
        }
        bz
    }
}

/* js/compute.js planeBase: the same normal equations in the same order */
fn plane_base(perim: &[[f64; 3]]) -> (f64, f64, f64, f64, f64) {
    let n = perim.len() as f64;
    let (x0, y0) = (perim[0][0], perim[0][1]);
    let (mut sx, mut sy, mut sz) = (0f64, 0f64, 0f64);
    let (mut sxx, mut sxy, mut syy) = (0f64, 0f64, 0f64);
    let (mut sxz, mut syz) = (0f64, 0f64);
    for p in perim {
        let x = p[0] - x0;
        let y = p[1] - y0;
        let z = p[2];
        sx += x; sy += y; sz += z;
        sxx += x * x; sxy += x * y; syy += y * y;
        sxz += x * z; syz += y * z;
    }
    let mut det = sxx * (syy * n - sy * sy) - sxy * (sxy * n - sx * sy) + sx * (sxy * sy - syy * sx);
    if det == 0.0 { det = 1e-9; }
    let a = (sxz * (syy * n - sy * sy) - sxy * (syz * n - sy * sz) + sx * (syz * sy - syy * sz)) / det;
    let b = (sxx * (syz * n - sy * sz) - sxz * (sxy * n - sx * sy) + sx * (sxy * sz - syz * sx)) / det;
    let c = (sxx * (syy * sz - sy * syz) - sxy * (sxy * sz - sx * syz) + sxz * (sxy * sy - syy * sx)) / det;
    (a, b, c, x0, y0)
}

/* js/compute.js dgridAt: NODE-based, bilinear, NaN outside */
#[allow(clippy::too_many_arguments)]
fn dgrid_at(z: &[f32], dx0: f64, dy0: f64, dcell: f64, nx: i32, ny: i32, x: f64, y: f64) -> f64 {
    let fx = (x - dx0) / dcell;
    let fy = (y - dy0) / dcell;
    let i = fx.floor();
    let j = fy.floor();
    if i < 0.0 || j < 0.0 || i >= (nx - 1) as f64 || j >= (ny - 1) as f64 { return f64::NAN; }
    let (i, j) = (i as i32, j as i32);
    let a = z[(j * nx + i) as usize] as f64;
    let b = z[(j * nx + i + 1) as usize] as f64;
    let c = z[((j + 1) * nx + i) as usize] as f64;
    let e = z[((j + 1) * nx + i + 1) as usize] as f64;
    if a.is_nan() || b.is_nan() || c.is_nan() || e.is_nan() { return f64::NAN; }
    let u = fx - i as f64;
    let v = fy - j as f64;
    a * (1.0 - u) * (1.0 - v) + b * u * (1.0 - v) + c * (1.0 - u) * v + e * u * v
}

/// base_mode: 0 tin, 1 plane, 2 fixed (also "lowest": the host resolves it), 3 design
/// out: [fill, cut, n, hmax, hmin, hsum, zmin, zmax] as f64
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn volume_grid(
    poly_ptr: *const f64, n_poly: i32,
    perim_ptr: *const f64, n_perim: i32,
    tri_ptr: *const u32, n_tri: i32,
    base_mode: i32, fixed_z: f64,
    dg_z: *const f32, dg_x0: f64, dg_y0: f64, dg_cell: f64, dg_nx: i32, dg_ny: i32,
    g_x0: *const f64, g_y0: *const f64, g_cell: *const f64,
    g_w: *const i32, g_h: *const i32, g_i0: *const i32, g_j0: *const i32,
    g_sw: *const i32, g_sh: *const i32, g_off: *const i32,
    g_z: *const f32, n_grids: i32, n_gz: i32,
    step: f64, bx0: f64, by0: f64, nx: i32, ny: i32,
    hgrid_out: *mut f32, out_ptr: *mut f64,
) {
    let np = n_poly as usize;
    let pxy = unsafe { sf64(poly_ptr, np * 2) };
    let mut px = Vec::with_capacity(np);
    let mut py = Vec::with_capacity(np);
    for i in 0..np { px.push(pxy[i * 2]); py.push(pxy[i * 2 + 1]); }

    let pm = unsafe { sf64(perim_ptr, n_perim as usize * 3) };
    let mut perim: Vec<[f64; 3]> = Vec::with_capacity(n_perim as usize);
    for i in 0..n_perim as usize { perim.push([pm[i * 3], pm[i * 3 + 1], pm[i * 3 + 2]]); }

    let ng = n_grids as usize;
    let grids = Grids {
        x0: unsafe { sf64(g_x0, ng) }, y0: unsafe { sf64(g_y0, ng) },
        cell: unsafe { sf64(g_cell, ng) },
        w: unsafe { si32(g_w, ng) }, h: unsafe { si32(g_h, ng) },
        i0: unsafe { si32(g_i0, ng) }, j0: unsafe { si32(g_j0, ng) },
        sw: unsafe { si32(g_sw, ng) }, sh: unsafe { si32(g_sh, ng) },
        off: unsafe { si32(g_off, ng) },
        z: unsafe { sf32(g_z, n_gz as usize) },
        n: ng,
    };

    let tin = if base_mode == 0 {
        Some(Tin::new(perim.clone(), unsafe { su32(tri_ptr, n_tri as usize) }))
    } else { None };
    let plane = if base_mode == 1 { Some(plane_base(&perim)) } else { None };
    let dz = if base_mode == 3 {
        unsafe { sf32(dg_z, (dg_nx * dg_ny) as usize) }
    } else { &[] };

    let (nxu, nyu) = (nx as usize, ny as usize);
    let hgrid = unsafe { mf32(hgrid_out, nxu * nyu) };
    for v in hgrid.iter_mut() { *v = f32::NAN; }

    let (mut fill, mut cut) = (0f64, 0f64);
    let mut n = 0i64;
    let (mut hmax, mut hmin, mut hsum) = (0f64, 0f64, 0f64);
    let (mut zmin, mut zmax) = (1e9f64, -1e9f64);
    let cell_a = step * step;

    for jy in 0..nyu {
        let y = by0 + step / 2.0 + jy as f64 * step;
        for ix in 0..nxu {
            let x = bx0 + step / 2.0 + ix as f64 * step;
            if !point_in_poly(x, y, &px, &py) { continue; }
            let z = grids.elev(x, y);
            if z.is_nan() { continue; }
            let b = match base_mode {
                0 => tin.as_ref().unwrap().at(x, y),
                1 => { let p = plane.unwrap(); p.0 * (x - p.3) + p.1 * (y - p.4) + p.2 }
                3 => dgrid_at(dz, dg_x0, dg_y0, dg_cell, dg_nx, dg_ny, x, y),
                _ => fixed_z,
            };
            if b.is_nan() { continue; }
            let hh = z - b;
            hgrid[jy * nxu + ix] = hh as f32;
            if hh > 0.0 {
                fill += hh * cell_a;
                hsum += hh;
                if hh > hmax { hmax = hh; }
            } else {
                cut += -hh * cell_a;
                if hh < hmin { hmin = hh; }
            }
            if z < zmin { zmin = z; }
            if z > zmax { zmax = z; }
            n += 1;
        }
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, 8) };
    out[0] = fill; out[1] = cut; out[2] = n as f64;
    out[3] = hmax; out[4] = hmin; out[5] = hsum;
    out[6] = zmin; out[7] = zmax;
}
