/*! `contoursFromGrid` -- marching squares over a windowed grid at a level
    interval, with the same endpoint chaining `marchOne` uses, ported line for
    line from js/compute.js.

    Two v9.7 rules live in here and both are reproduced exactly:
      * the sweep is sized from the WINDOW (sw x sh), never from g.w/g.h --
        before v9.7 it read NaN outside the window and painted the wrong place
        with no error;
      * a polyline shorter than a tenth of a sweep cell is a STUB (two crossings
        of one cell whose ends round into different chaining keys) and is
        dropped -- 43 of 262 on the 10-ft site set.

    IDENTITY: bit-identical. The level walk is repeated ADDITION, as the JS
    does it (`lv += interval`), not lv0 + k*interval, because the two differ in
    the last bits and the levels are reported.
*/

use crate::geom::{hypot, march_chain, simplify_path, MarchSegs};
use crate::{out_f64, out_i32, out_reset, out_u32, sf32};

#[inline]
fn frac(a: f64, b: f64, lv: f64) -> f64 {
    if (b - a).abs() < 1e-12 { return 0.5; }
    let t = (lv - a) / (b - a);
    if t < 0.0 { 0.0 } else if t > 1.0 { 1.0 } else { t }
}

/// OUT arena: i32 n_lines, i32 truncated, then
///   n_lines * f64 level, (n_lines+1) * u32 offset, and the coords as f64 pairs
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn contours_from_grid(
    z_ptr: *const f32, w: i32, h: i32, cell: f64, x0: f64, y0: f64,
    interval: f64, stride: i32, max_pts: i32,
) {
    let (w, h) = (w as usize, h as usize);
    let s = stride as usize;
    let z = unsafe { sf32(z_ptr, w * h) };
    let stub_ft = cell * s as f64 * 0.1;

    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut k = 0usize;
    while k < z.len() {
        let v = z[k] as f64;
        if !v.is_nan() { if v < lo { lo = v; } if v > hi { hi = v; } }
        k += 7;
    }

    let mut levels: Vec<f64> = Vec::new();
    let mut offsets: Vec<u32> = vec![0];
    let mut coords: Vec<f64> = Vec::new();
    let mut total_pts = 0i64;
    let mut truncated = false;

    let lv0 = (lo / interval).ceil() * interval;
    let mut segs = MarchSegs::new();
    let mut lv = lv0;
    'outer: while lv <= hi {
        segs.clear();
        let mut j = 0usize;
        while j + s < h {
            let mut i = 0usize;
            while i + s < w {
                let za = z[j * w + i] as f64;
                let zb = z[j * w + i + s] as f64;
                let zc = z[(j + s) * w + i + s] as f64;
                let zd = z[(j + s) * w + i] as f64;
                if za.is_nan() || zb.is_nan() || zc.is_nan() || zd.is_nan() { i += s; continue; }
                let mut idx = 0u8;
                if za >= lv { idx |= 1; }
                if zb >= lv { idx |= 2; }
                if zc >= lv { idx |= 4; }
                if zd >= lv { idx |= 8; }
                if idx == 0 || idx == 15 { i += s; continue; }
                let x = i as f64 * cell + x0;
                let y = j as f64 * cell + y0;
                let c = s as f64 * cell;
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
                i += s;
            }
            j += s;
        }
        let lines = march_chain(&segs, 100000);
        for line in lines {
            let line = if line.len() >= 3 { simplify_path(&line, cell * s as f64 * 0.3) } else { line };
            let mut line_len = 0f64;
            for q in 1..line.len() {
                line_len += hypot(line[q][0] - line[q - 1][0], line[q][1] - line[q - 1][1]);
            }
            if line.len() >= 2 && line_len >= stub_ft {
                levels.push(lv);
                for p in &line { coords.push(p[0]); coords.push(p[1]); }
                offsets.push((coords.len() / 2) as u32);
                total_pts += line.len() as i64;
            }
            if total_pts > max_pts as i64 { truncated = true; break 'outer; }
        }
        lv += interval;
    }

    out_reset();
    out_i32(levels.len() as i32);
    out_i32(if truncated { 1 } else { 0 });
    out_i32(coords.len() as i32);
    for v in &levels { out_f64(*v); }
    for v in &offsets { out_u32(*v); }
    for v in &coords { out_f64(*v); }
}
