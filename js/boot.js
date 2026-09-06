/* SBMM Site Explorer — boot sequence with visible progress and real error reporting */
"use strict";

/* v21: the Help panel's "force JavaScript kernels" switch. It is remembered in
   localStorage by js/jobs.js and it takes the worker pool down, so the next job
   is built by a worker that was told the same thing. */
function wireWasmSwitch() {
  const cb = $("wasmSwitch"), st = $("wasmStatus");
  if (!cb) return;
  const paint = () => {
    const i = SBMM.compute.wasmInfo();
    cb.checked = !!i.forcedJs;
    if (st) st.textContent = i.backend === "wasm"
      ? "running the WebAssembly core" + (i.version ? " v" + i.version : "")
      : (i.forcedJs ? "JavaScript kernels (forced)"
                    : "JavaScript kernels" + (i.bytes ? " — the core did not load" : " — no core in this build"));
  };
  cb.onchange = () => { SBMM.compute.forceJs(cb.checked); paint(); toast("compute core: " + SBMM.compute.backend()); };
  paint();
  setTimeout(paint, 1500);          // the async compile lands after boot
}

(async function () {
  const lp = $("loadMsg");
  const fail = (msg, detail) => {
    $("loading").innerHTML = `<div class="loaderr"><h2>Couldn't start</h2><p>${esc(msg)}</p>
      ${detail ? `<pre>${esc(detail)}</pre>` : ""}
      <p class="mut">If you copied the app, make sure the whole folder came along (js/, datajs/, vendor/).
      The single-file build (dist) has no such dependency.</p></div>`;
  };
  try {
    /* Retry every <script src> that failed to load (js/gate.js recorded them),
       twice each and in page order, BEFORE the checks below decide the app is
       broken. Over GitHub Pages on a phone a 14 MB payload drops once on a weak
       signal and the symptom was "missing data payload: dem_site_png" with
       nothing wrong on the server; over file:// a missing file fails again in a
       millisecond and the message below is the one it always was. The query
       string defeats a cached failure; sw.js matches with ignoreSearch. */
    const failed = (SBMM.failedScripts || []).splice(0);
    SBMM.retriedScripts = [];
    for (const src of failed) {
      const name = src.split("/").pop().split("?")[0];
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        lp.textContent = `retrying ${name} (${attempt} of 2)…`;
        ok = await new Promise(res => {
          const s = document.createElement("script");
          s.src = src.split("?")[0] + "?retry=" + attempt + "-" + Date.now();
          s.onload = () => res(true);
          s.onerror = () => res(false);
          document.head.appendChild(s);
        });
      }
      if (ok) SBMM.retriedScripts.push(name);
      else console.warn("could not load " + src + " after two retries");
    }
    lp.textContent = "checking data payloads…";
    if (!window.SBMM_DATA) throw new Error("data payloads did not load (SBMM_DATA missing) — datajs/*.js absent or blocked");
    for (const k of ["affine", "dem_site", "dem_abp", "dem_site_png", "dem_abp_png", "dus", "piles", "points"])
      /* hs_site may be .jpg or .png — checked in layers.js */
      if (!SBMM_DATA[k]) throw new Error("missing data payload: " + k);
    if (typeof L === "undefined") throw new Error("Leaflet failed to load (vendor/leaflet.js)");
    if (typeof d3 === "undefined") throw new Error("d3-delaunay failed to load (vendor/d3-delaunay.min.js)");
    if (typeof SBMM_COMPUTE === "undefined") throw new Error("compute kernel failed to load (js/compute.js)");

    SBMM.AFF = SBMM_DATA.affine;

    /* prove the Blob-URL worker path in this build before anything depends on it —
       if it can't run (locked-down policy, ancient browser) every job just runs inline */
    lp.textContent = "starting compute workers…";
    SBMM.compute.probe().then(ok => {
      if (!ok) console.warn("compute workers unavailable — running analysis on the main thread");
    });
    /* v21: the WASM core, for this thread's own no-worker fallback path. The
       workers get the bytes at creation instead (js/jobs.js primeWorker), so
       nothing waits on this — a refusal is a console.warn and the JavaScript
       kernels, which is the same answer a build without the payload gives. */
    SBMM.compute.initWasm().then(ok => {
      SBMM_PERF.mark("wasm-" + (ok ? "ready" : "js"));
    });

    SBMM_PERF.mark("boot-start");
    /* The four terrain payloads decode in FOUR WORKERS, started together (v11).
       Only the atob stays on the main thread; see the worker-side decode section
       of js/dem.js for why and for the fallback. The names are canonical, the
       marks keep the names the perf harnesses have always printed, and the
       loader names the step it is on rather than going blank.

       dem_res and the CHM are optional in the same sense they always were: an
       older datajs/ without them must still boot — the stack goes two deep and
       everything falls back to the 2-ft grid, and the canopy row disappears. */
    const DEM_MARK = { dem_site: "dem-site", dem_abp: "dem-abp", dem_res: "dem-res", chm: "chm" };
    const want = ["dem_site", "dem_abp"];
    if (SBMM_DATA.dem_res && SBMM_DATA.dem_res_png) want.push("dem_res");
    if (SBMM_DATA.chm && SBMM_DATA.chm_png) want.push("chm");
    lp.textContent = `decoding terrain · 0 of ${want.length}…`;
    const terrain = await Dem.loadAll(want, {
      optional: ["dem_res", "chm"],
      onOne: (name, p) => {
        SBMM_PERF.mark(DEM_MARK[name] || name);
        lp.textContent = p.done < p.total
          ? `decoding terrain · ${p.done} of ${p.total}…`
          : "decoding terrain · done";
      }
    });
    SBMM.demSite = terrain.dem_site;
    SBMM.demAbp = terrain.dem_abp;
    SBMM.demRes = terrain.dem_res || null;
    SBMM.chm = terrain.chm || null;
    /* keep the stage table's shape when an optional payload is absent */
    for (const n of ["dem_res", "chm"]) if (!terrain[n]) SBMM_PERF.mark(DEM_MARK[n]);
    /* finest first, dem_abp ahead of dem_res where they overlap — see js/dem.js */
    SBMM.setDems([SBMM.demAbp, SBMM.demRes, SBMM.demSite]);
    /* unchanged contract: everything that consumes canopy heights awaits this */
    SBMM.chmReady = Promise.resolve(SBMM.chm || null);
    if (!SBMM.chm && $("v3dCanopyLbl")) $("v3dCanopyLbl").style.display = "none";
    lp.textContent = "building workbench…";
    /* v17 §1: the touch profile FIRST, because `body.touch` changes what every
       button measures and the top bar's four-stage narrowing is measured, not
       assumed. It sets a class and nothing else here; SBMM.touch.wire() below
       does the rest, once the map exists. */
    SBMM.touch.autoDetect();
    SBMM.shell.wire();
    SBMM.compute.wire();
    wireWasmSwitch();
    SBMM_PERF.mark("wire-shell");
    SBMM.initMap();
    SBMM_PERF.mark("init-map");
    SBMM.buildLayers();
    SBMM_PERF.mark("build-layers");
    SBMM.buildAnalysisLayers();
    SBMM.labels.wire();
    SBMM.snap.wire();
    SBMM.draw.wire();
    SBMM.tools.wire();
    SBMM.cmd.wire();
    SBMM.io.wire();
    SBMM.table.wire();
    SBMM.design.wire();
    SBMM.sections.wire();
    SBMM.features.wire();
    SBMM.props.wire();
    SBMM.smartbound.wire();
    SBMM.trees.wire();
    SBMM.sheets.wire();
    SBMM.datasets.wire();
    SBMM.layersUI.wire();
    SBMM.watermark.wire();
    SBMM.sheetMarks.wire();
    if (SBMM.survey) SBMM.survey.wire();
    if (SBMM.storm) SBMM.storm.wire();
    SBMM.water.wire();
    if (SBMM.drainage) SBMM.drainage.wire();
    if (SBMM.runoff) SBMM.runoff.wire();
    if (SBMM.accum) SBMM.accum.wire();
    if (SBMM.pipes) SBMM.pipes.wire();
    if (SBMM.scenarios) SBMM.scenarios.wire();
    /* EA's recovered design surfaces become read-only surface features (§5) —
       after SBMM.design.wire() so the surfaces list exists, and before
       refSurf.wire() so the first render has something to show. */
    SBMM.refSurf.build();
    SBMM.refSurf.wire();
    SBMM.isopach.wire();
    SBMM.layerMan.wire();
    SBMM.sheetCards.wire();
    /* Field mode (v11 §4.3). autoDetect() switches it on by itself on a touch
       device with a narrow viewport, unless a stored preference says otherwise;
       `body.field` is the one switch, and desktop is untouched without it.
       Before SBMM.mode.wire() so the Mode HUD paints once, in the right box. */
    /* v17 §5a: freehand ink. Before the mode machine, which owns its mode row. */
    SBMM.redline.wire();
    SBMM.field.autoDetect();
    SBMM.field.wire();
    /* v17: the gesture surfaces, the loupe, the Done bar, the Help controls and
       — over http(s) only, never over file:// — the offline copy's service
       worker. After field.wire() so the profile knows whether the phone half is
       on, and after initMap() because it wires the map's own long-press. */
    SBMM.touch.wire();
    SBMM.wireSelection();
    /* the tool-mode machine owns the tool buttons, the cursor, the mode HUD and
       every single-key shortcut (§2) */
    SBMM.mode.wire();
    SBMM_PERF.mark("wire-modules");

    /* Right dock auto-switch (§3): selecting anything is a question about that
       thing; running a computation is a question about a number. */
    SBMM.store.onSelect(id => { if (id) SBMM.shell.showInspector(); });
    $("clearBtn").onclick = () => {
      if (!SBMM.store.features.length) return;
      if (confirm("Remove all drawn features and results?")) {
        SBMM.store.clear();
        $("resBody").innerHTML = '<div class="placeholder">Cleared. Pick a tool and draw.</div>';
      }
    };
    $("undoBtn").onclick = () => SBMM.undo.pop();
    $("redoBtn").onclick = () => SBMM.undo.redo();
    /* Both buttons are a VIEW onto the two stacks: enabled when there is
       something on that side, and their tooltip names what it is. onChange
       fires once on subscribe, so this also sets the opening state. */
    SBMM.undo.onChange(() => {
      const l = SBMM.undo.labels();
      const u = $("undoBtn"), r = $("redoBtn");
      u.disabled = !SBMM.undo.canUndo();
      r.disabled = !SBMM.undo.canRedo();
      u.title = l.undo ? "Undo: " + l.undo + " (Ctrl+Z)" : "Undo the last action (Ctrl+Z)";
      r.title = l.redo ? "Redo: " + l.redo + " (Ctrl+Y)" : "Redo the last undone action (Ctrl+Y)";
    });
    $("splitTopBtn").onclick = async () => {
      if (!SBMM.viewer3d.isOpen()) await SBMM.viewer3d.toggle();
      $("v3dSplit").click();
    };
    const helpBox = $("help");
    const helpOpen = () => { helpBox.style.display = "flex"; helpBox.tabIndex = -1; helpBox.focus({ preventScroll: true }); };
    const helpShut = () => { helpBox.style.display = "none"; };
    $("helpBtn").onclick = helpOpen;
    helpBox.addEventListener("click", e => { if (e.target.id === "help") helpShut(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && helpBox.style.display === "flex") { e.stopPropagation(); e.preventDefault(); helpShut(); }
    }, true);
    $("csvBtn").onclick = () => { copyText(SBMM.results.csv(), "results copied as CSV"); };
    $("view3dBtn").onclick = () => SBMM.viewer3d.toggle();

    /* Where the user was last time (F11). A stored view is a convenience, so
       every part of it is optional and every failure falls back to the default
       framing — a bad or stale value must never be the reason the app opens on
       a blank grey square. The 3D camera is restored by js/viewer3d.js when the
       view is next opened, from the same store. */
    SBMM.view.restore2d() || SBMM.map.fitBounds(SBMM.demAbp.bounds());
    SBMM.view.watch();
    SBMM.shell.reflowTopbar();

    /* offer to restore last session */
    const n = (function () { try { const s = localStorage.getItem("sbmm_session_auto"); return s ? (JSON.parse(s).features || []).length : 0; } catch (e) { return 0; } })();
    if (n) {
      const bar = document.createElement("div"); bar.className = "restorebar";
      bar.innerHTML = `Last session had <b>${n}</b> drawn feature${n === 1 ? "" : "s"}.
        <span class="minib" id="rsYes">restore</span><span class="minib" id="rsNo">dismiss</span>`;
      document.body.appendChild(bar);
      $("rsYes").onclick = () => { SBMM.store.loadAutosave(); bar.remove(); };
      $("rsNo").onclick = () => bar.remove();
      setTimeout(() => bar.remove(), 20000);
    }

    /* First-run hint: ONE toast, naming the one rule that gets a user out of
       anything (§2). More than one toast at boot is noise nobody reads. */
    let hinted = true;
    try { hinted = localStorage.getItem("sbmm_v9hint") === "1"; localStorage.setItem("sbmm_v9hint", "1"); }
    catch (e) { hinted = false; }
    if (!hinted) setTimeout(() => toast("Esc always returns to Navigate", 5200), 900);

    SBMM_PERF.mark("boot-done");
    if (/[?&]perf/.test(location.search)) console.table(SBMM_PERF.report());
    $("loading").style.display = "none";
    /* the one signal that every row is registered and every remembered layer
       is on the map (js/layertree.js re-applies the stored draw order on it) */
    try { if (SBMM.events && SBMM.events.emit) SBMM.events.emit("boot", {}); } catch (e) { console.error(e); }
  } catch (e) {
    console.error(e);
    fail(e.message, e.stack ? String(e.stack).split("\n").slice(0, 4).join("\n") : "");
  }
})();
