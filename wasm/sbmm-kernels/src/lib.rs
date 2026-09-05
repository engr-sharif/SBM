/*! SBMM Site Explorer — the WASM compute core (docs/V21_WASM_SPEC.md).

    THE RULE THIS CRATE LIVES BY: js/compute.js is the reference and the
    fallback, and every function here is a line-for-line port of one of its
    kernels — same loop order, same comparisons, same widths. Where the JS
    holds a value in a `var` it is an f64 and the port says `f64`; where it
    writes into a Float32Array the port writes `as f32`. That is what makes
    the harness's identity check meaningful rather than a tolerance.

    ABI: plain `extern "C"` over linear memory. No wasm-bindgen, no JS glue,
    nothing that loads a file — the host hands the module bytes to
    `WebAssembly.instantiate` and calls these exports with typed-array views
    onto `memory` (see the `wasm` section of js/compute.js).

      alloc(n)      -> ptr        bytes, 8-aligned
      free(ptr, n)                give them back
      out_ptr() / out_len()       the variable-length output arena, valid
                                  until the next kernel call

    No threads, no SIMD, no floating-point fast math: the arithmetic is
    IEEE-754 double and single exactly as V8 does it, so a sum in the same
    order gives the same bits.
*/

use std::alloc::{alloc as ralloc, dealloc as rdealloc, Layout};

mod heap;
mod fill;
mod volume;
mod contours;
mod flowpath;
mod overtop;
mod drainage;
mod runoff;

/* ----------------------------------------------------------------- memory - */

const ALIGN: usize = 8;

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    if n == 0 { return ALIGN as *mut u8; }
    unsafe { ralloc(Layout::from_size_align_unchecked(n, ALIGN)) }
}

#[no_mangle]
pub extern "C" fn free(p: *mut u8, n: usize) {
    if n == 0 || p.is_null() { return; }
    unsafe { rdealloc(p, Layout::from_size_align_unchecked(n, ALIGN)) }
}

/* ------------------------------------------------------- the output arena - */
/* Kernels whose output size is not known to the caller (contours, the drainage
   sink table) push their result here; the host reads out_ptr()/out_len() after
   the call and copies before calling anything else. */

static mut OUT: Vec<u8> = Vec::new();

#[inline]
#[allow(static_mut_refs)]
pub(crate) fn outv() -> &'static mut Vec<u8> { unsafe { &mut OUT } }

pub(crate) fn out_reset() { outv().clear(); }
pub(crate) fn out_u32(v: u32) { outv().extend_from_slice(&v.to_le_bytes()); }
pub(crate) fn out_i32(v: i32) { out_u32(v as u32) }
pub(crate) fn out_f64(v: f64) { outv().extend_from_slice(&v.to_le_bytes()); }
pub(crate) fn out_f32(v: f32) { outv().extend_from_slice(&v.to_le_bytes()); }

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 { outv().as_ptr() }
#[no_mangle]
pub extern "C" fn out_len() -> usize { outv().len() }

/* The api version this crate implements — must equal js/compute.js VERSION, and
   js/compute.js refuses the module if it does not. */
#[no_mangle]
pub extern "C" fn api_version() -> i32 { 9 }

/* ----------------------------------------------------------------- slices - */

#[inline]
pub(crate) unsafe fn sf32<'a>(p: *const f32, n: usize) -> &'a [f32] {
    if n == 0 { &[] } else { core::slice::from_raw_parts(p, n) }
}
#[inline]
pub(crate) unsafe fn sf64<'a>(p: *const f64, n: usize) -> &'a [f64] {
    if n == 0 { &[] } else { core::slice::from_raw_parts(p, n) }
}
#[inline]
pub(crate) unsafe fn si32<'a>(p: *const i32, n: usize) -> &'a [i32] {
    if n == 0 { &[] } else { core::slice::from_raw_parts(p, n) }
}
#[inline]
pub(crate) unsafe fn mf32<'a>(p: *mut f32, n: usize) -> &'a mut [f32] {
    if n == 0 { &mut [] } else { core::slice::from_raw_parts_mut(p, n) }
}
#[inline]
pub(crate) unsafe fn mi32<'a>(p: *mut i32, n: usize) -> &'a mut [i32] {
    if n == 0 { &mut [] } else { core::slice::from_raw_parts_mut(p, n) }
}
#[inline]
pub(crate) unsafe fn mu8<'a>(p: *mut u8, n: usize) -> &'a mut [u8] {
    if n == 0 { &mut [] } else { core::slice::from_raw_parts_mut(p, n) }
}

/* the D8 neighbourhood, in js/compute.js's own order (W_DI / W_DJ / W_DD) */
pub(crate) const W_DI: [i32; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];
pub(crate) const W_DJ: [i32; 8] = [1, 1, 1, 0, 0, -1, -1, -1];
pub(crate) const W_SQ: f64 = 1.4142135623730951;
pub(crate) const W_DD: [f64; 8] = [W_SQ, 1.0, W_SQ, 1.0, 1.0, W_SQ, 1.0, W_SQ];
