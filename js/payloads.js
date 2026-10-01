/* SBMM Site Explorer — the deferred payloads (v31).

   The folder build is what the team opens from GitHub Pages, and its first
   visit downloaded ~142 MB before the app could start. Three of those payloads
   are read only on first use — EA's lazy CAD groups (21 MB), the recovered
   design surfaces' rasters (11 MB) and the 20 full-sheet renders (27 MB) — so
   index.html's heavy-payload loader no longer document.writes them on a
   desktop or a tablet: it records them in `window.SBMM_DEFERRED` and this
   module loads them AFTER the app is up, one at a time, at idle.

   Same mechanism as everything else here: a `<script src>`, never a fetch, so
   it works over file://, over http and inside the offline copy. A single-file
   dist inlines every payload and has nothing deferred; a phone skips all of
   them (v19.1) and has nothing deferred either.

   The contract a reader relies on:
     SBMM.payloads.pending(key)  true while a deferred file that defines
                                 SBMM_DATA[key] has not landed (or failed)
     SBMM.payloads.when(key)     a promise that resolves once SBMM_DATA[key]
                                 can be read — at once if nothing is deferred
                                 for it — and moves that file to the FRONT of
                                 the queue. It rejects only when the file
                                 failed twice; every caller toasts then.
     SBMM.payloads.settled()     every deferred file has landed or failed
     SBMM.events "payload"       {src, state, keys} on every state change

   Retry: a failed file is re-requested twice with ?retry=N (sw.js matches with
   ignoreSearch), exactly as js/boot.js retries a static tag. */
"use strict";

SBMM.payloads = (function () {
  const files = (window.SBMM_DEFERRED || []).map(src => ({
    src, state: "queued", tries: 0, ms: 0, bytes: 0, t0: 0, keys: keysOf(src)
  }));
  let started = false, busy = false, waiters = [];

  /* Which SBMM_DATA keys a deferred file defines. Read off the NAME, so a
     caller can ask for a key before the file has ever been requested. */
  function keysOf(src) {
    const b = src.replace(/^.*\//, "").replace(/\.js(\?.*)?$/, "");
    if (b === "d_cad_native_lazy") return ["cad_native_lazy"];
    if (b === "d_cad_surfaces_rasters") return ["surf_*"];
    const m = /^i_(sheet_full_.+)$/.exec(b);
    if (m) return [m[1]];
    return [b.replace(/^[di]_/, "")];
  }
  function fileFor(key) {
    if (!key) return null;
    return files.find(f => f.keys.some(k =>
      k === key || (k.endsWith("*") && key.startsWith(k.slice(0, -1))))) || null;
  }
  const present = key => !!(window.SBMM_DATA && SBMM_DATA[key]);

  function emit(f) {
    try { SBMM.events && SBMM.events.emit("payload", { src: f.src, state: f.state, keys: f.keys }); }
    catch (e) {}
  }

  function inject(f) {
    return new Promise(resolve => {
      const s = document.createElement("script");
      s.src = f.src + (f.tries ? (f.src.indexOf("?") < 0 ? "?" : "&") + "retry=" + f.tries : "");
      s.async = false;
      s.dataset.deferred = "1";
      s.onload = () => resolve(true);
      s.onerror = () => { s.remove(); resolve(false); };
      document.head.appendChild(s);
    });
  }

  async function loadOne(f) {
    f.state = "loading"; f.t0 = performance.now(); emit(f);
    let ok = false;
    while (!ok && f.tries < 3) {
      ok = await inject(f);
      if (!ok) f.tries++;
    }
    f.ms = Math.round(performance.now() - f.t0);
    try {
      const e = performance.getEntriesByName(new URL(f.src, location.href).href, "resource").pop();
      if (e) f.bytes = e.encodedBodySize || e.transferSize || 0;
    } catch (e) {}
    f.state = ok ? "done" : "failed";
    emit(f);
    if (!ok) toast(`${label(f)} did not load — ${f.src} failed three times`);
    flush();
  }

  /* one at a time, at idle: each of these is a large string literal the main
     thread has to parse, and the app is already in someone's hands */
  function idle() {
    return new Promise(r => (window.requestIdleCallback
      ? requestIdleCallback(() => r(), { timeout: 600 }) : setTimeout(r, 30)));
  }
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const f = files.find(x => x.state === "wanted") || files.find(x => x.state === "queued");
        if (!f) break;
        await idle();
        await loadOne(f);
      }
    } finally { busy = false; }
  }

  function flush() {
    waiters = waiters.filter(w => {
      if (present(w.key)) { w.resolve(SBMM_DATA[w.key]); return false; }
      const f = fileFor(w.key);
      if (!f || f.state === "failed") {
        w.reject(new Error((f ? f.src : w.key) + " did not load"));
        return false;
      }
      /* landed but did not define the key: answer rather than hang */
      if (f.state === "done") { w.resolve(undefined); return false; }
      return true;
    });
  }

  /* start once the app is interactive — js/boot.js calls it when the loader
     hides. Asking `when()` before that queues the request and starts at once:
     a user who opens a drawing in the first second should not wait for idle. */
  function start() {
    if (started) return;
    started = true;
    pump();
  }

  function pending(key) {
    if (present(key)) return false;
    const f = fileFor(key);
    return !!f && f.state !== "failed" && f.state !== "done";
  }

  function when(key) {
    if (present(key)) return Promise.resolve(SBMM_DATA[key]);
    const f = fileFor(key);
    if (!f) return Promise.resolve(window.SBMM_DATA ? SBMM_DATA[key] : undefined);
    if (f.state === "failed") return Promise.reject(new Error(f.src + " did not load"));
    if (f.state === "queued") f.state = "wanted";
    const p = new Promise((resolve, reject) => waiters.push({ key, resolve, reject }));
    started = true;
    pump();
    return p;
  }

  function label(f) {
    if (/cad_native/.test(f.src)) return "EA CAD (deferred layers)";
    if (/cad_surfaces/.test(f.src)) return "EA design surfaces";
    const m = /sheet_full_([A-Z]\d+)/.exec(f.src);
    return m ? `Sheet ${m[1].replace(/^([A-Z])/, "$1-")}` : f.src;
  }

  const settled = () => files.every(f => f.state === "done" || f.state === "failed");

  function stats() {
    return {
      deferred: files.length,
      done: files.filter(f => f.state === "done").length,
      failed: files.filter(f => f.state === "failed").map(f => f.src),
      loading: (files.find(f => f.state === "loading") || {}).src || null,
      settled: settled(),
      files: files.map(f => ({ src: f.src, state: f.state, ms: f.ms, bytes: f.bytes, tries: f.tries }))
    };
  }

  return { start, pending, when, settled, stats, label: key => label(fileFor(key) || { src: key }) };
})();
