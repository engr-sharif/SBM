/* SBMM Site Explorer — nothing changes the view without saying so (v56).

   The app remembers 23 keys and two dozen named preferences, and a good part
   of them change what is drawn: a see-through ground, a moved sun, a lighter
   rendering, water switched off, a soloed group, storm drains assumed broken.
   Each was added with its own switch in its own corner, several have no switch
   at all, and nothing on screen said any of them was in force. "Why is the
   ground hazy", "where did my sheets go" and "the TEM is not there" were all
   the same report.

   ONE TABLE. A row is a state that
     (i)   changes what is drawn, or what an analysis answers,
     (ii)  is not at the value this device opens with, and
     (iii) has no indicator of its own on screen.
   Each row reads the OWNING MODULE's getter and undoes through its setter —
   there is no second copy of any state here. The table drives three things:

     * the chip in the status bar (`#viewChip`): hidden while every row is at
       its default, otherwise "view · N" with a popover naming each one and an
       undo beside it;
     * "undo all";
     * the harness (block 9zz), which sets every row, reads it back off the
       chip and undoes it.

   Deliberately NOT rows: anything that already says so on screen (TEM on and
   the fence clip box have chips; fly mode, relief, the drape style and mesh
   detail are on the 3D bar; a layer being on or off is what the Layers panel
   shows), and anything that changes nothing drawn (the compute core).

   RESET TO DEFAULTS is the other half, and it is a RELOAD on purpose. Ten of
   the settings are read once, at boot or when their script loads; a reset
   that put the stored values back and left the old ones in memory would be
   the very defect this file exists to remove. What it keeps is the user's
   WORK — drawings, imported data, saved 3D views, saved layer presets,
   scenarios — and the unlock. See reset() for the order, which matters.

   Evaluation is event-driven (layers, view, mode, pref, tem, pit, the store,
   and touch() from the few setters with no event). No timer, no frame. */
"use strict";

SBMM.viewState = (function () {

  const V3 = () => SBMM.viewer3d;
  const LS = () => SBMM.layerState;
  const pref = k => (SBMM.view && SBMM.view.pref ? SBMM.view.pref(k) : undefined);
  const open3d = () => !!(V3() && V3().isOpen && V3().isOpen());
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* the five preferences with no control anywhere: set from the console while
     measuring, and from then on they change the rendering for good */
  const OVERRIDES = ["pixelRatio", "drapeK", "drapeFloor", "terrainTiles", "gpuRaster"];
  function overridesSet() { return OVERRIDES.filter(k => pref(k) !== undefined); }

  /* is this a device whose own default is the lighter rendering? (js/viewer3d.js
     quality() forces it there whatever is stored) */
  function lightDevice() {
    return !!((SBMM.lowMem && SBMM.lowMem()) ||
              (SBMM.touch && SBMM.touch.profile && SBMM.touch.profile() === "phone"));
  }

  function brokenConduits() {
    const S = SBMM.storm, D = S && S.data && S.data();
    if (!D || !D.conduits) return [];
    return D.conduits.filter(c => S.statusOf(c.id) === "broken" && c.status !== "broken").map(c => c.id);
  }
  function hiddenWork() {
    const M = SBMM.myWork;
    if (!M || !M.classOf) return [];
    /* the user's own features only: EA's four reference surfaces are store
       features too (js/refsurf.js) and fall in "drawings" — a class hidden
       with nothing of the user's in it hides nothing */
    const n = {}, out = [];
    for (const f of SBMM.store.features) { if (f.props && f.props.ref) continue; const c = M.classOf(f); n[c] = (n[c] || 0) + 1; }
    for (const c of M.CLASSES) if (n[c[0]] && !LS().isOn("mywork", c[0])) out.push({ id: c[0], label: c[1], n: n[c[0]] });
    return out;
  }
  function faintLayers() {
    const out = [];
    for (const g of LS().groupList()) {
      if (g.id === "cultural") continue;
      for (const r of LS().list(g.id)) if (r.on && r.opacity < 0.15) out.push({ g: g.id, l: r.id, label: r.label });
    }
    return out;
  }
  function forcedLayout() {
    const T = SBMM.touch, F = SBMM.field, out = [];
    const ov = T && T.override ? T.override() : "auto";
    if (ov !== "auto") out.push("touch layout forced " + ov);
    const st = F && F.stored ? F.stored() : null;
    if (st != null && F.sniff && st !== !!F.sniff()) out.push("field layout forced " + (st ? "on" : "off"));
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* THE TABLE                                                           */
  /* ------------------------------------------------------------------ */
  const ROWS = [
    { id: "ground", where: "3d",
      is() {
        const m = V3().ground();
        if (m === "see" || m === "hidden") return true;
        return m === "solid" && !!(SBMM.geophys && SBMM.geophys.anyOn && SBMM.geophys.anyOn());
      },
      say() {
        const m = V3().ground();
        return m === "see" ? "ground see-through" : m === "hidden" ? "ground hidden"
          : "ground solid · the TEM under it is covered";
      },
      undo() { V3().setGround("auto"); } },

    { id: "sun", where: "3d",
      is() { return V3().sunAuto() === false; },
      say() { const s = V3().sun(); return "sun at " + Math.round(s.az) + "° / " + Math.round(s.el) + "°"; },
      undo() { V3().sunAsPhotographed(); } },

    { id: "rendering", where: "3d",
      is() { return !lightDevice() && V3().quality() === "standard"; },
      say() { return "rendering standard"; },
      undo() { V3().setQuality("realistic"); } },

    { id: "water3d", where: "3d",
      is() { return V3().water3d() === false; },
      say() { return "water surfaces off"; },
      undo() { V3().water3d(true); } },

    { id: "names3d", where: "3d",
      is() { return V3().pointNames() === false; },
      say() { return "point names off"; },
      undo() { V3().pointNames(true); } },

    { id: "animwater", where: "3d",
      is() { return V3().animateWater() === false; },
      say() { return "water animation off"; },
      undo() { V3().animateWater(true); } },

    { id: "backdrop", where: "both",
      is() { return !!(SBMM.backdrop && SBMM.backdrop.stats && SBMM.backdrop.stats().enabled === false); },
      say() { return "backdrop off"; },
      undo() { SBMM.backdrop.setEnabled(true); } },

    { id: "overrides", where: "3d",
      is() { return overridesSet().length > 0; },
      say() { return "rendering overrides · " + overridesSet().map(k => k + " " + pref(k)).join(", "); },
      undo() {
        const had = overridesSet();
        SBMM.view.forget(OVERRIDES);
        if (open3d() && V3().applyOverrides) V3().applyOverrides();
        if (had.includes("terrainTiles") || had.includes("gpuRaster")) toast("cleared · the terrain source follows on the next reload");
      } },

    { id: "drains", where: "both",
      is() { return !!(SBMM.storm && SBMM.storm.enabled && !SBMM.storm.enabled()); },
      say() { return "storm drains off · water analyses are ground only"; },
      undo() { SBMM.storm.setEnabled(true, true); } },

    { id: "broken", where: "both",
      is() { return brokenConduits().length > 0; },
      say() { const n = brokenConduits().length; return n + " storm conduit" + (n === 1 ? "" : "s") + " marked broken"; },
      undo() { for (const id of brokenConduits()) SBMM.storm.setStatus(id, "assumed_working", true); } },

    { id: "solo", where: "both",
      is() { return !!(SBMM.layerTree && SBMM.layerTree.soloState && SBMM.layerTree.soloState()); },
      say() { return "solo · " + SBMM.layerTree.soloState().label; },
      undo() { SBMM.layerTree.unsolo(); } },

    { id: "work", where: "both",
      is() { return hiddenWork().length > 0; },
      say() { return hiddenWork().map(c => c.label.toLowerCase() + " hidden · " + c.n).join(", "); },
      undo() { LS().batch(hiddenWork().map(c => ({ group: "mywork", layer: c.id, on: true }))); } },

    { id: "faint", where: "both",
      is() { return faintLayers().length > 0; },
      say() { const f = faintLayers(); return f.length === 1 ? f[0].label + " at " + Math.round(LS().opacity(f[0].g, f[0].l) * 100) + " %"
                                                            : f.length + " layers on at under 15 %"; },
      undo() { for (const f of faintLayers()) LS().set(f.g, f.l, { opacity: 1 }); } },

    { id: "trees", where: "both",
      is() { return !!(SBMM.trees && SBMM.trees.minShow && SBMM.trees.minShow() > 6 && LS().isOn("base", "trees_detected")); },
      say() { return "trees under " + SBMM.trees.minShow() + " ft hidden"; },
      undo() { SBMM.trees.setMinShow(6); } },

    { id: "layout", where: "both",
      is() { return forcedLayout().length > 0; },
      say() { return forcedLayout().join(", "); },
      undo() {
        if (SBMM.touch && SBMM.touch.override && SBMM.touch.override() !== "auto") SBMM.touch.override("auto");
        if (SBMM.field && SBMM.field.auto) SBMM.field.auto();
      } }
  ];

  /* ------------------------------------------------------------------ */
  /* evaluation                                                          */
  /* ------------------------------------------------------------------ */
  let ready = false, queued = false, lastSig = "";
  function active() {
    if (!ready) return [];
    const in3d = open3d(), out = [];
    for (const r of ROWS) {
      if (r.where === "3d" && !in3d) continue;
      let on = false, text = "";
      try { on = !!r.is(); if (on) text = r.say(); } catch (e) { on = false; }
      if (on) out.push({ id: r.id, text });
    }
    return out;
  }
  function undo(id) {
    const r = ROWS.find(q => q.id === id);
    if (!r) return false;
    try { r.undo(); } catch (e) { console.error("viewState undo " + id, e); toast("could not undo that — reset to defaults puts everything back"); return false; }
    paint();
    return true;
  }
  function undoAll() {
    const a = active();
    for (const x of a) { const r = ROWS.find(q => q.id === x.id); try { r.undo(); } catch (e) { console.error("viewState undo " + x.id, e); } }
    paint();
    return a.length;
  }
  /* the setters with no event of their own call this; it coalesces */
  function touch() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; paint(); });
  }

  /* ------------------------------------------------------------------ */
  /* the chip                                                            */
  /* ------------------------------------------------------------------ */
  function els() { return { wrap: document.getElementById("viewChipWrap"), chip: document.getElementById("viewChip"), pop: document.getElementById("viewPop") }; }
  function paint() {
    const E = els();
    if (!E.wrap) return;
    const a = active(), sig = a.map(x => x.id + "=" + x.text).join("|");
    if (sig === lastSig && E.wrap.hidden === !a.length) return;     // nothing to write (a DOM write is not free)
    lastSig = sig;
    E.wrap.hidden = !a.length;
    E.chip.textContent = "view · " + a.length;
    E.chip.title = a.length ? "Settings that are changing what is drawn — " + a.map(x => x.text).join("; ") : "";
    if (!a.length) { E.pop.classList.remove("open"); E.pop.innerHTML = ""; return; }
    E.pop.innerHTML = `<h4>Changing the view</h4>` +
      a.map(x => `<div class="vsrow" data-vs-row="${x.id}"><span>${esc(x.text)}</span><button class="minib" data-vs="${x.id}">undo</button></div>`).join("") +
      `<div class="vsfoot">${a.length > 1 ? `<button class="minib" data-vs-all>undo all</button>` : ""}` +
      `<button class="minib ghost" data-vs-reset>reset to defaults…</button></div>`;
  }

  /* ------------------------------------------------------------------ */
  /* RESET TO DEFAULTS                                                   */
  /* ------------------------------------------------------------------ */
  /* What a reset removes outright. NOT here, each for a reason:
       sbmm.gate.*          the unlock and the idle lock — a reset must not lock
                            the app or change when it locks
       sbmm_session_auto    the drawings (its `layers` are stripped below)
       sbmm_datasets_auto   imported data
       sbmm.wasm.v1         changing it kills the worker pool, and it changes
                            nothing drawn
       sbmm_v9hint          a one-time hint that should stay one-time
       the offline copy and the data stash (Cache Storage): 80+ MB to refill */
  const REMOVE = ["sbmm_osnap", "sbmm_polar", "sbmm.storm.v1", "sbmm_field_v1", "sbmm.touch.v1",
                  "sbmm_dockl", "sbmm_dockr", "sbmm.redline.v1", "sbmm.omni.v1", "sbmm_cmdseen", "sbmm_layer_sections"];
  const FLAG = "sbmm.reset.v1";
  const KEEP_PREFS = ["camBookmarks"];

  function reset() {
    const kept = { drawings: 0, views: 0, presets: 0 };
    try {
      /* 1. the three debounced / in-memory stores: rewritten keeping only the
            work inside them, then frozen — a write queued before this point
            (the view store debounces by 900 ms) would undo the reset */
      const bm = pref("camBookmarks");
      kept.views = Array.isArray(bm) ? bm.length : 0;
      SBMM.view.resetStore(KEEP_PREFS);
      LS().resetDefaults();
      kept.presets = SBMM.layerTree && SBMM.layerTree.resetRecord ? SBMM.layerTree.resetRecord() : 0;
      /* 2. the drawings: saved once more as they are now, WITHOUT the layer
            state the autosave also carries — restoring it would bring the old
            layers straight back */
      const s = SBMM.store && SBMM.store.serialize ? SBMM.store.serialize() : null;
      const n = s && s.features ? s.features.length : 0;      // the user's own: reference surfaces are not serialised
      if (n) {
        delete s.layers;
        localStorage.setItem("sbmm_session_auto", JSON.stringify(s));
        kept.drawings = n;
      }
      /* 3. the first-visit stamp: without it the curated default layers are
            applied again on the next boot. The welcome card's own frequency is
            a choice about a card, not about the view, and stays. */
      try {
        const h = JSON.parse(localStorage.getItem("sbmm.home.v1") || "null");
        if (h && typeof h === "object") { delete h.defaults; localStorage.setItem("sbmm.home.v1", JSON.stringify(h)); }
      } catch (e) { /* a missing record is already a first visit */ }
      /* 4. the plain keys */
      for (const k of REMOVE) localStorage.removeItem(k);
      /* 5. one-shot: the next boot restores the drawings without asking */
      localStorage.setItem(FLAG, JSON.stringify(kept));
    } catch (e) {
      console.error("reset", e);
      toast("could not reset — this browser is not letting the app store settings");
      return false;
    }
    location.reload();
    return true;
  }

  /* boot calls this once the workbench is up: true if a reset just happened
     (the caller then skips its "restore last session?" bar) */
  let lastReset = null;
  function afterReset() {
    let k = null;
    try { const s = localStorage.getItem(FLAG); if (s) { k = JSON.parse(s); localStorage.removeItem(FLAG); } } catch (e) { k = null; }
    if (!k) return false;
    let n = 0;
    try { if (k.drawings) n = SBMM.store.loadAutosave() || 0; } catch (e) { console.error(e); }
    const kept = [];
    if (n) kept.push(n + " drawing" + (n === 1 ? "" : "s"));
    if (k.views) kept.push(k.views + " saved view" + (k.views === 1 ? "" : "s"));
    if (k.presets) kept.push(k.presets + " layer preset" + (k.presets === 1 ? "" : "s"));
    lastReset = { drawings: n, views: k.views || 0, presets: k.presets || 0 };
    toast("reset to defaults" + (kept.length ? " · kept " + kept.join(", ") : ""), 5200);
    return true;
  }

  function confirmReset() {
    if (document.getElementById("resetDlg")) return;
    const box = document.createElement("div");
    box.className = "modal"; box.id = "resetDlg";
    box.innerHTML = `<div class="mbox" role="dialog" aria-modal="true" aria-labelledby="resetDlgT">
      <div class="mhd"><span id="resetDlgT">Reset to defaults</span></div>
      <div class="mbody resetbody">
        <div><b>Goes back to how the app first opens</b><br>layers and their order · panels · every 3D view setting · snaps · the map position and camera · storm drain switches</div>
        <div><b>Kept</b><br>drawings · imported data · saved 3D views · saved layer presets · scenarios · the unlock</div>
        <div class="mut">The page reloads.</div>
        <div class="mbtns"><button class="minib" id="resetNo">cancel</button><button class="minib pri" id="resetYes">reset</button></div>
      </div></div>`;
    document.body.appendChild(box);
    const close = () => { box.remove(); document.removeEventListener("keydown", key, true); };
    const key = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
    document.addEventListener("keydown", key, true);
    box.addEventListener("pointerdown", e => { if (e.target === box) close(); });
    box.querySelector("#resetNo").onclick = close;
    box.querySelector("#resetYes").onclick = () => { close(); reset(); };
    box.querySelector("#resetYes").focus();
  }

  /* ------------------------------------------------------------------ */
  function wire() {
    const E = els();
    if (E.chip) {
      E.chip.onclick = e => { e.stopPropagation(); paint(); E.pop.classList.toggle("open"); };
      E.pop.addEventListener("click", e => {
        e.stopPropagation();
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.vs) undo(b.dataset.vs);
        else if ("vsAll" in b.dataset) undoAll();
        else if ("vsReset" in b.dataset) { E.pop.classList.remove("open"); confirmReset(); }
      });
      document.addEventListener("click", e => { if (!E.pop.contains(e.target) && e.target !== E.chip) E.pop.classList.remove("open"); });
      document.addEventListener("keydown", e => { if (e.key === "Escape" && E.pop.classList.contains("open")) E.pop.classList.remove("open"); });
    }
    const rb = document.getElementById("resetBtn");
    if (rb) rb.onclick = confirmReset;
    const ev = SBMM.events;
    if (ev) for (const n of ["layers", "view", "mode", "pref", "tem", "pit", "field"]) ev.on(n, touch);
    if (SBMM.store && SBMM.store.onChange) SBMM.store.onChange(touch);
    /* the rows read module state that only exists once the workbench is built */
    if (ev) ev.on("boot", () => { ready = true; paint(); });
  }

  return { wire, rows: () => ROWS.map(r => ({ id: r.id, where: r.where })), active, undo, undoAll, touch, paint,
           reset, confirmReset, afterReset, lastReset: () => lastReset,
           /* harness hooks */
           REMOVE, OVERRIDES };
})();
