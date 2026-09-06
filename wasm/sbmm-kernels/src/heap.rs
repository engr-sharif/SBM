/*! The shared min-heap of js/compute.js — heapNew / heapPush / heapPop, with
    its tie-break intact.

    The payload is the cell's NORTH-MAJOR index nmi = (h-1-j)*w + i, not the
    storage index, so ties break "top-left first" and the §9 water goldens are
    reproducible cell for cell. Keys are f64 because the JS array is a
    Float64Array and a surveyed invert arrives as an f64. */

pub struct Heap {
    pub k: Vec<f64>,
    pub v: Vec<i32>,
    pub n: usize,
    pub top_key: f64,
}

impl Heap {
    pub fn new(cap: usize) -> Heap {
        let c = if cap < 64 { 64 } else { cap };
        Heap { k: vec![0.0; c], v: vec![0; c], n: 0, top_key: 0.0 }
    }
    #[inline]
    pub fn clear(&mut self) { self.n = 0; }
    /* Unchecked indexing throughout: every index below is provably in
       0..self.n <= len, and the bounds checks are the difference between this
       and the JIT'd JavaScript on a 21-million-cell flood. */
    #[inline]
    pub fn push(&mut self, key: f64, val: i32) {
        if self.n == self.k.len() {
            let m = self.k.len() * 2;
            self.k.resize(m, 0.0);
            self.v.resize(m, 0);
        }
        let mut i = self.n;
        self.n += 1;
        unsafe {
            let k = self.k.as_mut_ptr();
            let v = self.v.as_mut_ptr();
            *k.add(i) = key;
            *v.add(i) = val;
            while i > 0 {
                let p = (i - 1) >> 1;
                if *k.add(i) < *k.add(p) || (*k.add(i) == *k.add(p) && *v.add(i) < *v.add(p)) {
                    core::ptr::swap(k.add(p), k.add(i));
                    core::ptr::swap(v.add(p), v.add(i));
                    i = p;
                } else { break; }
            }
        }
    }
    /* returns the payload; its key lands in self.top_key */
    #[inline]
    pub fn pop(&mut self) -> i32 {
        self.n -= 1;
        let n = self.n;
        unsafe {
            let k = self.k.as_mut_ptr();
            let v = self.v.as_mut_ptr();
            let rv = *v;
            self.top_key = *k;
            if n > 0 {
                *k = *k.add(n);
                *v = *v.add(n);
                let mut i = 0usize;
                loop {
                    let l = i * 2 + 1;
                    let r = l + 1;
                    let mut m = i;
                    if l < n && (*k.add(l) < *k.add(m) || (*k.add(l) == *k.add(m) && *v.add(l) < *v.add(m))) { m = l; }
                    if r < n && (*k.add(r) < *k.add(m) || (*k.add(r) == *k.add(m) && *v.add(r) < *v.add(m))) { m = r; }
                    if m == i { break; }
                    core::ptr::swap(k.add(m), k.add(i));
                    core::ptr::swap(v.add(m), v.add(i));
                    i = m;
                }
            }
            rv
        }
    }
}
