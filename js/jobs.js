/* SBMM Site Explorer — compute host: Web-Worker pool, job protocol, progress UI.

   The workers are built from a Blob URL whose source text is reconstructed at runtime
   from js/compute.js via Function.prototype.toString(). That is the one technique that
   works in BOTH shipping shapes of this app:

     • folder build — js/compute.js is a separate <script src>; fetch()/importScripts()
       of it would be blocked over file://, but the function object is already in
       memory, so .toString() gives us the source with no I/O at all.
     • dist build   — tools/build_dist.py inlines js/compute.js verbatim into a
       <script> tag; the function source text is byte-identical, so nothing changes.

   If Worker construction (or the boot ping) fails for any reason, every job silently
   falls back to running SBMM_COMPUTE.runJob() on the main thread — the exact same
   function the worker would have called, so results can never differ.
*/
"use strict";

SBMM.compute = (function () {

  /* v17 §5b: sized from the CPU, min 2 max 8. An M-series iPad has 8-10 cores
     and was being given one worker; a two-core build box still gets two, which
     is the floor a pool needs to be a pool at all. Above 8 the terrain jobs are
     memory-bound, not core-bound, and Safari kills a page over ~1.5 GB. */
  const MAX_WORKERS = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const SHOW_AFTER = 220;   // ms before a job earns a status-bar row (no flicker)

  const stats = {
    workerJobs: 0,      // jobs that actually ran in a worker
    syncJobs: 0,        // jobs that fell back to the main thread
    cancelled: 0,
    failures: 0,
    workerAvailable: null,   // null = not probed yet
    lastMs: 0,
    lastKind: null,
    /* v21: which core the last kernel job actually ran on, and when it landed.
       js/results.js stamps a card with it -- a card built in a job's own
       continuation is built microtasks after this is written. */
    lastBackend: null,
    lastDoneAt: 0
  };

  let blobUrl = null, seq = 0;

  /* ------------------------------------------------------------------ */
  /* v21: the WASM compute core (docs/V21_WASM_SPEC.md section 3)        */
  /* ------------------------------------------------------------------ */
  /* The module arrives as BASE64 IN A PAYLOAD, never as a file: over file://
     nothing can be fetched, and a .wasm beside the HTML would be a guaranteed
     404 in the single-file dist. So the bytes are decoded once here and a copy
     is handed to every worker at creation, and to this thread for the
     no-worker fallback path. A build without the payload, a browser without
     WebAssembly and a module that will not instantiate all end in the same
     place: the JavaScript kernels, one console.warn, no error. */
  const FORCE_KEY = "sbmm.wasm.v1";
  let wasmBytes = null, wasmMeta = null, wasmMain = false;
  function forcedJs() {
    try { return localStorage.getItem(FORCE_KEY) === "js"; } catch (e) { return false; }
  }
  function decodeWasm() {
    if (wasmBytes !== null) return wasmBytes;
    wasmBytes = false;
    try {
      const b64 = window.SBMM_DATA && SBMM_DATA.wasm_kernels;
      if (!b64) return wasmBytes;
      wasmMeta = SBMM_DATA.wasm_kernels_meta || null;
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      wasmBytes = u;
      /* 400 kB of base64 nothing reads twice, dropped the way the DEM payloads
         are (CLAUDE.md "the payload contract"). The KEY stays -- the dual-build
         contract asserts both halves of that. */
      SBMM_DATA.wasm_kernels = null;
    } catch (e) { console.warn("wasm payload unreadable:", e.message); wasmBytes = false; }
    return wasmBytes;
  }
  /* the main thread compiles asynchronously: synchronous WebAssembly.Module is
     capped at 4 kB there, and only there */
  function initMain() {
    const b = decodeWasm();
    if (!b || forcedJs()) { if (forcedJs()) SBMM_COMPUTE.wasmForce(true); return Promise.resolve(false); }
    return SBMM_COMPUTE.wasmInit(b, wasmMeta).then(ok => { wasmMain = !!ok; return wasmMain; });
  }
  /* every worker gets the bytes as its first message; postMessage is ordered
     and the worker's compile is synchronous, so every job that follows sees it */
  function primeWorker(w) {
    const b = decodeWasm();
    if (!b) return;
    try { w.postMessage({ id: 0, type: "wasm", bytes: b, meta: wasmMeta, forceJs: forcedJs() }); }
    catch (e) { console.warn("could not hand the wasm core to a worker:", e.message); }
  }
  /* "wasm" | "js" -- what a job dispatched right now would run on */
  function backend() { return (wasmMain && !forcedJs()) ? "wasm" : "js"; }
  function wasmInfo() {
    const b = wasmBytes;
    return { backend: backend(), loaded: !!wasmMain, forcedJs: forcedJs(),
             bytes: b && b.length ? b.length : 0,
             version: wasmMeta && wasmMeta.version || null };
  }
  /* the Help switch. Remembered, and it takes the pool down so the next job is
     built by a worker that was told the same thing. */
  function forceJs(on) {
    try { on ? localStorage.setItem(FORCE_KEY, "js") : localStorage.removeItem(FORCE_KEY); } catch (e) {}
    SBMM_COMPUTE.wasmForce(!!on);
    for (const s of slots.slice()) { try { s.w.terminate(); } catch (e) {} }
    slots.length = 0;
    return backend();
  }
  const slots = [];          // { w: Worker, busy: bool, item }
  const pending = [];        // queued items
  const live = new Set();    // handles currently queued or running

  /* ------------------------------------------------------------------ */
  /* worker construction                                                 */
  /* ------------------------------------------------------------------ */
  function workerSource() {
    return "/* SBMM compute worker — generated at runtime from js/compute.js */\n" +
      '"use strict";\n' +
      "var SBMM_COMPUTE = (" + SBMM_COMPUTE.moduleSource + ")();\n" +
      "SBMM_COMPUTE.installWorker(self);\n";
  }
  function ensureBlobUrl() {
    if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
    return blobUrl;
  }
  function spawn() {
    if (stats.workerAvailable === false) return null;
    try {
      const w = new Worker(ensureBlobUrl());
      w.onerror = e => { console.warn("compute worker error", e.message || e); };
      primeWorker(w);
      return w;
    } catch (e) {
      console.warn("Web Workers unavailable — computing on the main thread instead:", e.message);
      stats.workerAvailable = false;
      return null;
    }
  }

  /* One-shot boot probe: proves the Blob-worker path really runs in this build
     before any real job depends on it. Resolves to true/false, never throws. */
  let probed = null;
  function probe() {
    if (probed) return probed;
    probed = new Promise(res => {
      let w;
      try { w = new Worker(ensureBlobUrl()); }
      catch (e) { stats.workerAvailable = false; return res(false); }
      const t = setTimeout(() => { try { w.terminate(); } catch (e) {} stats.workerAvailable = false; res(false); }, 8000);
      w.onmessage = ev => {
        clearTimeout(t);
        const ok = ev.data && ev.data.type === "pong";
        stats.workerAvailable = !!ok;
        try { w.terminate(); } catch (e) {}
        res(!!ok);
      };
      w.onerror = () => { clearTimeout(t); stats.workerAvailable = false; try { w.terminate(); } catch (e) {} res(false); };
      w.postMessage({ id: 0, type: "ping" });
    });
    return probed;
  }

  /* ------------------------------------------------------------------ */
  /* scheduling                                                          */
  /* ------------------------------------------------------------------ */
  function acquire() {
    for (const s of slots) if (!s.busy) return s;
    if (slots.length < MAX_WORKERS) {
      const w = spawn();
      if (!w) return null;                    // no workers at all -> run sync
      const s = { w, busy: false, item: null };
      slots.push(s);
      return s;
    }
    return "wait";                            // all busy -> stay queued
  }

  function drain() {
    while (pending.length) {
      const item = pending[0];
      if (item.h.cancelled) { pending.shift(); continue; }
      const slot = acquire();
      if (slot === "wait") break;
      pending.shift();
      if (slot === null) runSync(item); else dispatch(slot, item);
    }
    paint();
  }

  function settle(item, fn) {
    live.delete(item.h);
    item.h.done = true;
    fn();
    paint();
  }

  function dispatch(slot, item) {
    const h = item.h;
    slot.busy = true; slot.item = item;
    h.slot = slot;
    h.t0 = performance.now();
    stats.workerJobs++;
    slot.w.onmessage = ev => {
      const m = ev.data || {};
      if (m.id !== h.id) return;
      if (m.type === "progress") { h.progress = m.p; if (item.opts.onProgress) item.opts.onProgress(m.p); paint(); return; }
      slot.busy = false; slot.item = null; h.slot = null;
      if (m.type === "done") {
        stats.lastMs = Math.round(performance.now() - h.t0); stats.lastKind = item.kind;
        stats.lastBackend = backend(); stats.lastDoneAt = performance.now();
        settle(item, () => h._res(m.result));
      } else {
        stats.failures++;
        settle(item, () => h._rej(new Error(m.message || "compute failed")));
      }
      drain();
    };
    slot.w.onerror = e => {
      /* a worker that blew up is not trustworthy — drop it and retry on the main thread */
      console.warn("compute worker failed, falling back to main thread:", e.message || e);
      try { slot.w.terminate(); } catch (err) {}
      const i = slots.indexOf(slot); if (i >= 0) slots.splice(i, 1);
      stats.workerJobs--;
      h.slot = null;
      runSync(item);
    };
    try {
      slot.w.postMessage({ id: h.id, kind: item.kind, job: item.job }, item.opts.transfer || []);
    } catch (e) {
      slot.busy = false; slot.item = null;
      stats.workerJobs--;
      runSync(item);
    }
  }

  function runSync(item) {
    const h = item.h;
    stats.syncJobs++;
    h.t0 = performance.now();
    setTimeout(() => {
      if (h.cancelled) { settle(item, () => h._rej(cancelErr())); return; }
      try {
        const out = SBMM_COMPUTE.runJob(item.kind, item.job, p => {
          h.progress = p; if (item.opts.onProgress) item.opts.onProgress(p);
        });
        stats.lastMs = Math.round(performance.now() - h.t0); stats.lastKind = item.kind;
        stats.lastBackend = SBMM_COMPUTE.wasmBackend(); stats.lastDoneAt = performance.now();
        settle(item, () => h._res(out.result));
      } catch (e) {
        stats.failures++;
        settle(item, () => h._rej(e));
      }
      drain();
    }, 0);
  }

  function cancelErr() { const e = new Error("cancelled"); e.cancelled = true; return e; }

  function cancel(h) {
    if (!h || h.done || h.cancelled) return;
    h.cancelled = true;
    stats.cancelled++;
    const qi = pending.findIndex(it => it.h === h);
    if (qi >= 0) { const item = pending.splice(qi, 1)[0]; settle(item, () => h._rej(cancelErr())); return; }
    if (h.slot) {
      const slot = h.slot, item = slot.item;
      try { slot.w.terminate(); } catch (e) {}
      const i = slots.indexOf(slot); if (i >= 0) slots.splice(i, 1);
      h.slot = null;
      if (item) settle(item, () => h._rej(cancelErr()));
      drain();
    }
  }

  /* ------------------------------------------------------------------ */
  /* public: run a job                                                   */
  /* ------------------------------------------------------------------ */
  /* run(kind, job, {transfer, onProgress, label, silent})
     -> handle { promise, cancel(), id, label, progress }                 */
  function run(kind, job, opts) {
    opts = opts || {};
    const h = { id: ++seq, kind, label: opts.label || kind, progress: 0, cancelled: false, done: false,
                silent: !!opts.silent, tCreated: performance.now() };
    h.promise = new Promise((res, rej) => { h._res = res; h._rej = rej; });
    h.cancel = () => cancel(h);
    h.promise.catch(() => {});     // a cancelled job is not an unhandled rejection
    live.add(h);
    pending.push({ h, kind, job, opts });
    drain();
    setTimeout(paint, SHOW_AFTER + 10);   // only long jobs get a progress row
    return h;
  }

  /* ------------------------------------------------------------------ */
  /* grid specs — what actually gets shipped to a worker                  */
  /* ------------------------------------------------------------------ */
  /* A windowed copy of a DEM: full-grid meta (so inside()/at() keep their exact
     semantics) plus only the sub-rectangle a job can touch. The copy is deliberate —
     the buffer is transferred, and transferring dem.z itself would detach the app's
     own terrain array. */
  function gridSpec(dem, bbox, pad) {
    const m = dem.m;
    let i0 = 0, j0 = 0, i1 = m.w - 1, j1 = m.h - 1;
    if (bbox) {
      const p = pad == null ? 2 : pad;
      i0 = Math.floor((bbox[0] - m.x0) / m.cell) - p;
      j0 = Math.floor((bbox[1] - m.y0) / m.cell) - p;
      i1 = Math.ceil((bbox[2] - m.x0) / m.cell) + p;
      j1 = Math.ceil((bbox[3] - m.y0) / m.cell) + p;
      if (i1 < 0 || j1 < 0 || i0 > m.w - 1 || j0 > m.h - 1) return null;   // no overlap
      i0 = clamp(i0, 0, m.w - 1); j0 = clamp(j0, 0, m.h - 1);
      i1 = clamp(i1, 0, m.w - 1); j1 = clamp(j1, 0, m.h - 1);
    }
    const sw = i1 - i0 + 1, sh = j1 - j0 + 1;
    let z;
    if (sw === m.w && sh === m.h) {
      z = new Float32Array(dem.z);                       // whole grid (copy, see above)
    } else {
      z = new Float32Array(sw * sh);
      for (let j = 0; j < sh; j++) {
        const src = (j0 + j) * m.w + i0;
        z.set(dem.z.subarray(src, src + sw), j * sw);
      }
    }
    return { x0: m.x0, y0: m.y0, cell: m.cell, w: m.w, h: m.h, i0, j0, sw, sh, z };
  }

  /* A WHOLE DEM sampled every `stride` cells — a standalone grid spec (i0 = j0 = 0,
     w/h equal to the sample count), so a kernel cannot tell it from a real DEM.
     v14: the field build runs the drainage map over the site grid at 4 ft rather
     than 2, and the card says so. `strideFor`-style sampling, not averaging: the
     terrain has to stay the lidar's own values or the ponds move. */
  function subGrid(dem, stride) {
    const m = dem.m, s = Math.max(1, stride | 0);
    if (s === 1) return gridSpec(dem);
    const w = Math.ceil(m.w / s), h = Math.ceil(m.h / s);
    const z = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      const src = Math.min(m.h - 1, j * s) * m.w;
      for (let i = 0; i < w; i++) z[j * w + i] = dem.z[src + Math.min(m.w - 1, i * s)];
    }
    return { x0: m.x0, y0: m.y0, cell: m.cell * s, w, h, i0: 0, j0: 0, sw: w, sh: h, z };
  }

  /* the DEM stack SBMM.elev() consults, in the same order, clipped to a bbox */
  function gridsFor(bbox) {
    const out = [];
    for (const dem of SBMM.dems) {
      const g = gridSpec(dem, bbox);
      if (g) out.push(g);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* status-bar progress area                                            */
  /* ------------------------------------------------------------------ */
  let paintQueued = false;
  function paint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      /* v17 §5b: a two-minute drainage job on a tablet must not be interrupted
         by the screen going to sleep. Reference-counted by reason in
         js/touch.js, feature-detected there, and released the moment the queue
         empties — this is the one place that knows whether work is in flight. */
      if (window.SBMM && SBMM.touch && SBMM.touch.keepAwake) SBMM.touch.keepAwake("job", live.size > 0);
      const bar = $("jobBar");
      if (!bar) return;
      const now = performance.now();
      const shown = [...live].filter(h => !h.silent && now - h.tCreated > SHOW_AFTER);
      if (!shown.length) { bar.classList.remove("on"); return; }
      const h = shown[shown.length - 1];
      bar.classList.add("on");
      $("jobLabel").textContent = h.label + (shown.length > 1 ? ` (+${shown.length - 1})` : "");
      const pct = Math.round((h.progress || 0) * 100);
      $("jobFill").style.width = pct + "%";
      bar.dataset.n = String(shown.length);
    });
  }
  function wire() {
    const btn = $("jobCancel");
    if (btn) btn.onclick = () => {
      const shown = [...live].filter(h => !h.silent);
      shown.forEach(cancel);
      toast(shown.length ? "cancelled " + shown.length + " job" + (shown.length === 1 ? "" : "s") : "nothing running");
    };
  }

  return {
    run, cancel, probe, wire, stats,
    gridSpec, gridsFor, subGrid,
    /* v21: which core a job dispatched now would run on, and the switch */
    backend, wasmInfo, forceJs, initWasm: initMain,
    activeCount: () => live.size,
    workerCount: () => slots.length,
    /* v17 §5b: what the pool is ALLOWED to grow to, for the Help diagnostics
       line — `workerCount` is how many have actually been spun up so far */
    poolSize: () => MAX_WORKERS,
    /* handy in the console / used by the tests */
    source: workerSource
  };
})();
