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

  const MAX_WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
  const SHOW_AFTER = 220;   // ms before a job earns a status-bar row (no flicker)

  const stats = {
    workerJobs: 0,      // jobs that actually ran in a worker
    syncJobs: 0,        // jobs that fell back to the main thread
    cancelled: 0,
    failures: 0,
    workerAvailable: null,   // null = not probed yet
    lastMs: 0,
    lastKind: null
  };

  let blobUrl = null, seq = 0;
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
    activeCount: () => live.size,
    workerCount: () => slots.length,
    /* handy in the console / used by the tests */
    source: workerSource
  };
})();
