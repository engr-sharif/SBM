/* SBMM Site Explorer — the command line.

   One collapsible line above the status bar. Backtick or Ctrl+K focuses it; the ⌘
   button in the status bar toggles it. Commands carry AutoCAD-familiar aliases, so
   PL, O, MI, RO, CO, M, X, ZE all do what a Civil 3D user expects.

   Three interaction shapes, all through this one bar:
     run       "OFFSET 25"        — a command with inline arguments
     ask       "Offset distance:" — a command asking for one more value
     pick      "select a feature" — a command waiting for a map click

   The map-click pick reuses the existing selection event rather than a second
   hit-testing path: whatever the user clicks selects normally, and the pending
   command picks that selection up. */
"use strict";

SBMM.cmd = (function () {

  let bar, inp, list, promptEl;
  let pending = null;          // {prompt, cb} — ask() in flight
  let picker = null;           // {cb, prompt} — pickFeature() in flight
  const history = [];
  let histIdx = -1, sel = -1, matches = [];

  /* Every command that arms a tool goes through the mode machine (§2), so the
     command line, the top-bar buttons and the keyboard all put the app in the
     SAME state — including the HUD, the cursor and the Esc route out. */
  const mode = m => SBMM.mode.set(m);
  const arm = t => { SBMM.mode.navigate(); SBMM.tools.setTool(t); };
  const selected = () => SBMM.store.selectedFeature();

  /* need a target: use the selection, else wait for the next map click */
  function withTarget(name, fn) {
    const f = selected();
    if (f) { fn(f); return; }
    pickFeature(g => { if (g) fn(g); }, name + " — select a feature (click it on the map)");
  }

  /* ------------------------------------------------------------------ */
  /* the command table                                                   */
  /* ------------------------------------------------------------------ */
  const CMDS = [
    { n: "PLINE",   a: ["PL", "LINE", "L"],       d: "polyline — a line feature you can measure and edit", f: () => mode("draw.line") },
    { n: "DIST",    a: ["DI", "DISTANCE"],        d: "distance between points",                f: () => mode("measure.distance") },
    { n: "POLY",    a: ["POLYGON", "AREA", "AR"], d: "closed area sketch",                     f: () => mode("measure.area") },
    { n: "VOL",     a: ["VOLUME"],                d: "volume footprint (cut/fill vs a base surface)", f: () => mode("volume") },
    { n: "PROFILE", a: ["PR"],                    d: "elevation profile along a line",         f: () => mode("measure.profile") },
    { n: "ID",      a: ["INSPECT", "SPOT"],       d: "point card at a click — E, N, Z, lat/long, slope", f: () => mode("inspect") },
    { n: "POINT",   a: ["PT", "MARKER"],          d: "drop a point feature at a click",        f: () => mode("draw.point") },
    { n: "NAV",     a: ["NAVIGATE", "PAN"],       d: "back to Navigate (same as Esc)",         f: () => SBMM.mode.navigate() },

    { n: "OFFSET",  a: ["O"],   d: "parallel copy of the selection at a distance", arg: "distance",
      f: v => withTarget("OFFSET", f => SBMM.tools.opOffset(f, v)) },
    { n: "MIRROR",  a: ["MI"],  d: "mirror the selection about a 2-point axis",
      f: () => withTarget("MIRROR", f => SBMM.tools.opMirror(f)) },
    { n: "ROTATE",  a: ["RO"],  d: "rotate the selection about a base point",
      f: () => withTarget("ROTATE", f => SBMM.tools.opRotate(f)) },
    { n: "MOVE",    a: ["M"],   d: "move the selection, base point → destination",
      f: () => withTarget("MOVE", f => SBMM.tools.opMoveCopy(f, false)) },
    { n: "COPY",    a: ["CO", "CP"], d: "copy the selection, base point → destination",
      f: () => withTarget("COPY", f => SBMM.tools.opMoveCopy(f, true)) },
    { n: "JOIN",    a: ["J"],   d: "join the selected line to a second line",
      f: () => withTarget("JOIN", f => SBMM.tools.opJoin(f)) },
    { n: "EXPLODE", a: ["X"],   d: "polygon → open line",
      f: () => withTarget("EXPLODE", f => SBMM.tools.opExplode(f)) },
    { n: "ERASE",   a: ["E", "DEL"], d: "delete the selected feature",
      f: () => withTarget("ERASE", f => SBMM.tools.deleteFeature(f)) },

    { n: "DIM",  a: ["DIMALIGNED", "DIMLINEAR"], d: "aligned dimension between two points", f: () => mode("dimension") },
    { n: "TEXT", a: ["MTEXT", "TX"], d: "place an annotation (optional leader)", arg: "label",
      f: v => v ? SBMM.tools.opText(v) : mode("text") },

    /* ---- earthworks ---- */
    { n: "PAD",   a: ["GRADING"], d: "graded pad — flat Z with daylighting side slopes", arg: "pad elevation",
      f: v => SBMM.design.cmdPad("pad", v) },
    { n: "GRADE", a: ["SLOPEPAD"], d: "sloped-plane pad — Z plus a typed grade and direction", arg: "pad elevation",
      f: v => SBMM.design.cmdPad("plane", v) },
    { n: "EXIST", a: ["EGCOPY"], d: "freeze a copy of existing ground under a polygon",
      f: () => SBMM.design.cmdExisting() },
    { n: "BAL",   a: ["BALANCE"], d: "solve the pad elevation where cut = fill (or a net yd³ target)", arg: "net yd³",
      f: v => SBMM.design.cmdBalance(v) },
    { n: "SURF",  a: ["SURFACES"], d: "list the design surfaces", f: () => SBMM.design.cmdList() },
    { n: "ISOPACH", a: ["ISO", "CUTFILL"], d: "cut/fill heat map of a design surface vs the lidar ground",
      f: v => v ? SBMM.isopach.show(v) : SBMM.isopach.dialog() },
    { n: "VOLSURF", a: ["VS"], d: "volume in a polygon against a design surface",
      f: () => SBMM.isopach.volumeVsSurface() },
    { n: "LAYERS", a: ["LAYER", "LA", "LM"], d: "layer manager — search, toggle and recolour EA's CAD layers",
      f: () => SBMM.layerMan.open() },
    { n: "SEC",   a: ["SECTIONS", "XS"], d: "cross-sections along an alignment", arg: "station interval ft",
      f: v => SBMM.sections.cmdSections(v) },
    /* "SHEET" belongs to the drawing set now that all 20 plans are in the app —
       REPORT kept it as an alias and won the lookup, so SHEETS' own alias was dead. */
    { n: "REPORT", a: ["RPT", "REPORTSHEET"], d: "print-ready report sheet for the selection",
      f: () => SBMM.report.open() },

    /* ---- smart boundaries (phase 4) ---- */
    { n: "WAND",   a: ["PILEWAND", "MAGIC"], d: "pile wand — delineate a mound by top-hat residual (the memo method)",
      f: () => SBMM.smartbound.cmdWand() },
    { n: "CBOUND", a: ["CONTOURBOUND", "CB"], d: "trace the closed terrain contour through a clicked point", arg: "elevation ft",
      f: v => SBMM.smartbound.cmdCbound(v) },
    { n: "TOE",    a: ["CREST", "BREAKLINE"], d: "toe / crest line where slope crosses a threshold", arg: "slope (0.15 or 15)",
      f: v => SBMM.smartbound.cmdToe(v) },
    { n: "STANDS", a: ["CANOPY", "CLEARING"], d: "polygonise canopy stands over a height threshold (clearing limits)",
      f: () => SBMM.smartbound.cmdStands() },
    { n: "TREES",  a: ["TREE", "INVENTORY"], d: "detect individual trees over the canopy window", arg: "min height ft",
      f: v => SBMM.trees.cmdTrees(v) },

    /* ---- water (v10) ---- */
    { n: "DROP",    a: ["RAIN", "RAINDROP", "WATERDROP", "FLOW"],
      d: "raindrop — trace where water flows downhill from a click, ponding on the way",
      f: () => mode("raindrop") },
    { n: "OVERTOP", a: ["SPILL", "POUR"],
      d: "overtopping analysis of the Herman Impoundment — spill level, where, and where it goes",
      f: () => SBMM.water.overtopHerman() },
    { n: "STORM",   a: ["DRAINS", "STORMDRAIN"],
      d: "storm drains work — assume the CAD/surveyed network carries water (v12)",
      f: () => {
        if (!SBMM.storm || !SBMM.storm.data()) { toast("this build has no storm-drainage network"); return; }
        SBMM.storm.toggle();
      } },
    { n: "CATCH",   a: ["WATERSHED"],
      d: "contributing area upslope of the selected raindrop",
      f: () => {
        const f = selected();
        if (f && f.type === "flow") { SBMM.water.catchment(f); return; }
        const all = SBMM.store.features.filter(g => g.type === "flow");
        if (all.length === 1) { SBMM.water.catchment(all[0]); return; }
        toast(all.length ? "select the raindrop you want the catchment of" : "trace a raindrop first (DROP), then CATCH");
      } },

    { n: "DXFOUT", a: ["DXFEXPORT"], d: "export drawn features to DXF R12 (State Plane ft)", f: () => SBMM.dxf.exportDXF() },
    { n: "DXFIN",  a: ["DXFIMPORT"], d: "import a DXF file", f: () => SBMM.dxf.importPrompt() },
    { n: "SAVE",   a: ["SAVESESSION"], d: "save the session to a file", f: () => SBMM.io.exportSession() },
    { n: "OPEN",   a: ["LOAD"], d: "open a session, GeoJSON or DXF file", f: () => $("importFile").click() },

    { n: "ZE", a: ["ZOOMEXTENTS", "EXTENTS"], d: "zoom to everything drawn", f: () => zoomExtents() },
    { n: "ZW", a: ["ZOOMWINDOW"], d: "zoom to a window you drag", f: () => zoomWindow() },
    { n: "3D", a: ["VIEW3D"], d: "toggle the 3D terrain view", f: () => SBMM.viewer3d.toggle() },
    { n: "TABLE", a: ["SAMPLES"], d: "toggle the sample results table", f: () => SBMM.table.toggle() },

    { n: "SHEETS", a: ["SHEET", "PLANS", "DWG"], d: "open a design sheet — the whole drawing set, registered or not", arg: "sheet no. (e.g. C-106)",
      f: v => {
        if (!v) { SBMM.sheets.list(); return; }
        const want = String(v).trim().toUpperCase().replace(/^([A-Z])[- ]?(\d)/, "$1-$2");
        const s = SBMM.sheets.index().find(x => x.sheet.toUpperCase() === want)
          || SBMM.sheets.index().find(x => (x.title || "").toUpperCase().includes(String(v).trim().toUpperCase()));
        if (!s) { toast(`no sheet “${v}” — type SHEETS with no argument for the list`); return; }
        SBMM.sheets.open(s.sheet);
      } },
    { n: "DATASET", a: ["DATA", "IMPORTCSV", "CSVIN"], d: "import a CSV of coordinates as a dataset (wells, borings, anything)",
      f: () => SBMM.datasets.pickFile() },

    /* ---- field mode (v11 §4.4) ---- */
    { n: "FIELD", a: ["MOBILE", "PHONE"], d: "field mode — big-target touch layout for a phone in the field",
      f: () => SBMM.field.toggle() },
    { n: "GPS", a: ["POSITION", "WHEREAMI"], d: "show the device position on the map (and follow it)",
      f: () => SBMM.field.locate() },
    { n: "PHOTO", a: ["PIC", "CAMERA"], d: "take a photo and place it on the map",
      f: () => SBMM.field.photo() },
    { n: "NOTE", a: ["MEMO"], d: "type a note and tap where it goes",
      f: () => SBMM.field.note() },

    { n: "OSNAP", a: ["OS", "SNAP"], d: "toggle object snap (F3)", f: () => { SBMM.snap.setEnabled(null); toast("object snap " + (SBMM.snap.enabled() ? "on" : "off")); } },
    { n: "POLAR", a: ["PO"], d: "toggle polar tracking, 15° (F10)", f: () => { SBMM.draw.setPolar(null); toast("polar tracking " + (SBMM.draw.isPolar() ? "on" : "off")); } },
    { n: "UNDO",  a: ["U"], d: "undo the last action", f: () => SBMM.undo.pop() },
    { n: "REDO",  a: ["RE", "Y"], d: "redo the last undone action (Ctrl+Y)", f: () => SBMM.undo.redo() },
    { n: "CLEAR", a: [], d: "remove every drawn feature", f: () => $("clearBtn").click() },
    { n: "HELP",  a: ["?", "H"], d: "list every command", f: () => showHelp() },
    /* the password gate (js/gate.js). Forgetting the remembered unlock and
       putting the screen back up is one action, so it is one command. */
    { n: "LOCK",  a: ["LOGOUT", "SIGNOUT"], d: "lock the app — forget this browser's unlock and show the password screen",
      f: () => { if (SBMM.gate) SBMM.gate.lock(); else toast("no password gate in this build"); } }
  ];

  function find(word) {
    const w = word.toUpperCase();
    return CMDS.find(c => c.n === w || c.a.includes(w)) || null;
  }

  /* ------------------------------------------------------------------ */
  /* built-in helpers                                                    */
  /* ------------------------------------------------------------------ */
  function zoomExtents() {
    const pts = [];
    for (const f of SBMM.store.features) if (f.visible !== false) for (const p of f.pts) pts.push([p[1], p[0]]);
    if (!pts.length) { SBMM.map.fitBounds(SBMM.demAbp.bounds()); toast("nothing drawn — zoomed to the mine area"); return; }
    SBMM.map.fitBounds(L.latLngBounds(pts).pad(0.15));
  }
  function zoomWindow() {
    SBMM.tools.setTool(null);
    SBMM.draw.beginPick({
      count: 2,
      prompts: ["ZOOM WINDOW — click one corner", "ZOOM WINDOW — click the opposite corner"],
      onMove: (pts, cur) => pts.length
        ? { rings: [{ pts: [pts[0], [cur[0], pts[0][1]], cur, [pts[0][0], cur[1]]], closed: true }], label: "zoom window" }
        : null,
      onDone: pts => SBMM.map.fitBounds(L.latLngBounds([[pts[0][1], pts[0][0]], [pts[1][1], pts[1][0]]]))
    });
  }
  function showHelp() {
    const rows = CMDS.map(c =>
      `<tr><td class="cmdn">${esc(c.n)}</td><td class="cmda">${esc(c.a.join(", ") || "—")}</td><td>${esc(c.d)}</td></tr>`).join("");
    const dupe = $("cmdHelp"); if (dupe) dupe.remove();   // HELP twice used to stack two overlays
    const box = document.createElement("div");
    box.id = "cmdHelp";
    box.innerHTML = `<div class="box"><span class="close">✕</span>
      <h2>Command line</h2>
      <p class="mut">Type a command and press Enter. <kbd>\`</kbd> or <kbd>Ctrl</kbd><kbd>K</kbd> focuses the bar,
      <kbd>↑</kbd> walks history, <kbd>Tab</kbd> completes. Commands that act on a drawing use the current
      selection, or ask you to click one.</p>
      <table class="cmdhelp"><thead><tr><th>Command</th><th>Aliases</th><th>Does</th></tr></thead><tbody>${rows}</tbody></table>
      <h2>While you draw</h2>
      <table class="cmdhelp"><tbody>
        <tr><td class="cmdn">150</td><td colspan="2">distance along the current direction from the last vertex</td></tr>
        <tr><td class="cmdn">@150,75</td><td colspan="2">relative Δeast, Δnorth in feet</td></tr>
        <tr><td class="cmdn">@150&lt;45</td><td colspan="2">relative polar — feet, then degrees CCW from east</td></tr>
        <tr><td class="cmdn">6371500,2128900</td><td colspan="2">absolute State Plane (works for the first vertex too)</td></tr>
        <tr><td class="cmdn">Shift</td><td colspan="2">ortho — lock to 0/90/180/270°</td></tr>
        <tr><td class="cmdn">F10</td><td colspan="2">polar tracking, 15° increments</td></tr>
        <tr><td class="cmdn">F3</td><td colspan="2">object snap on/off</td></tr>
      </tbody></table></div>`;
    document.body.appendChild(box);
    const close = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true);
    box.querySelector(".close").onclick = close;
    box.addEventListener("click", e => { if (e.target === box) close(); });
    box.tabIndex = -1;
    setTimeout(() => box.focus({ preventScroll: true }), 20);
  }

  /* ------------------------------------------------------------------ */
  /* ask() / pickFeature()                                               */
  /* ------------------------------------------------------------------ */
  function ask(promptText, cb) {
    open(true);
    pending = { prompt: promptText, cb };
    promptEl.textContent = promptText;
    promptEl.classList.add("ask");
    inp.value = ""; inp.placeholder = "";
    inp.focus();
    hideList();
  }
  function clearAsk() {
    pending = null;
    promptEl.textContent = "⌘";
    promptEl.classList.remove("ask");
    inp.placeholder = "";
  }

  function pickFeature(cb, promptText) {
    cancelPick();
    SBMM.tools.setTool(null);
    toast(promptText || "select a feature — click it on the map");
    $("map").classList.add("picksel");
    const onSel = id => {
      if (!id) return;
      cancelPick(true);
      const f = SBMM.store.byId(id);
      cb(f || null);
    };
    picker = { cb, onSel };
    SBMM.store.onSelect(onSel);
    picker.esc = e => { if (e.key === "Escape") { cancelPick(); cb(null); } };
    document.addEventListener("keydown", picker.esc);
  }
  function cancelPick(quiet) {
    if (!picker) return;
    if (!quiet) toast("cancelled");
    SBMM.store.offSelect(picker.onSel);
    document.removeEventListener("keydown", picker.esc);
    $("map").classList.remove("picksel");
    picker = null;
  }

  /* ------------------------------------------------------------------ */
  /* run                                                                 */
  /* ------------------------------------------------------------------ */
  function run(text) {
    const s = String(text || "").trim();
    if (!s) return;
    if (history[history.length - 1] !== s) history.push(s);
    histIdx = history.length;
    const sp = s.indexOf(" ");
    const word = sp < 0 ? s : s.slice(0, sp);
    const rest = sp < 0 ? "" : s.slice(sp + 1).trim();
    const c = find(word);
    if (!c) {
      const near = CMDS.filter(x => x.n.startsWith(word.toUpperCase())).slice(0, 4).map(x => x.n);
      toast(`unknown command "${word}"` + (near.length ? ` — did you mean ${near.join(", ")}?` : " — type HELP"));
      return;
    }
    echo(c.n + (rest ? " " + rest : ""));
    try { c.f(rest); } catch (e) { console.error(e); toast(c.n + " failed: " + e.message); }
  }
  function echo(s) { promptEl.title = "last: " + s; }

  /* ------------------------------------------------------------------ */
  /* autocomplete                                                        */
  /* ------------------------------------------------------------------ */
  function updateList() {
    if (pending) { hideList(); return; }
    const v = inp.value.trim();
    const word = (v.split(" ")[0] || "").toUpperCase();
    if (!word) { hideList(); return; }
    matches = CMDS.filter(c => c.n.startsWith(word) || c.a.some(a => a.startsWith(word))).slice(0, 8);
    if (!matches.length) { hideList(); return; }
    sel = Math.max(0, Math.min(sel, matches.length - 1));
    list.innerHTML = matches.map((c, i) =>
      `<div class="cmdopt${i === sel ? " on" : ""}" data-i="${i}">
         <b>${esc(c.n)}</b>${c.a.length ? `<span class="al">${esc(c.a.slice(0, 3).join(" "))}</span>` : ""}
         ${c.arg ? `<span class="ar">&lt;${esc(c.arg)}&gt;</span>` : ""}
         <span class="de">${esc(c.d)}</span></div>`).join("");
    list.style.display = "block";
    list.querySelectorAll(".cmdopt").forEach(el => {
      el.onmousedown = e => { e.preventDefault(); accept(matches[+el.dataset.i]); };
    });
  }
  function hideList() { list.style.display = "none"; matches = []; sel = -1; }
  function accept(c) {
    if (!c) return;
    const parts = inp.value.trim().split(" ");
    parts[0] = c.n;
    inp.value = parts.join(" ") + (c.arg && parts.length === 1 ? " " : "");
    hideList();
    inp.focus();
    if (!c.arg) { const t = inp.value; inp.value = ""; run(t); }
  }

  /* ------------------------------------------------------------------ */
  /* placeholder that keeps teaching                                     */
  /* ------------------------------------------------------------------ */
  const EXAMPLES = [
    "type a command…  PL, POLY, VOL, DIM, OFFSET 25, HELP",
    "OFFSET 25 — parallel copy of the selected outline",
    "DIM — aligned dimension between two clicked points",
    "TEXT Stockpile A — annotation with an optional leader",
    "MI · RO · M · CO · J · X — mirror, rotate, move, copy, join, explode",
    "DXFOUT — State Plane DXF for AutoCAD · DXFIN imports one",
    "DROP — a raindrop that runs downhill · OVERTOP — where an impoundment spills",
    "ZE zoom extents · ZW zoom window · 3D · TABLE",
    "while sketching: 150 · @150,75 · @150<45 · Shift = ortho"
  ];
  let exIdx = 0, exTimer = null;
  function cycleExamples(on) {
    clearInterval(exTimer);
    if (!on) return;
    inp.placeholder = EXAMPLES[exIdx];
    exTimer = setInterval(() => {
      if (document.activeElement === inp || inp.value) return;
      exIdx = (exIdx + 1) % EXAMPLES.length;
      inp.placeholder = EXAMPLES[exIdx];
    }, 4200);
  }

  /* ------------------------------------------------------------------ */
  function open(on) {
    if (on == null) on = !document.body.classList.contains("cmdopen");
    document.body.classList.toggle("cmdopen", on);
    $("cmdBtn").classList.toggle("on", on);
    if (on) { inp.focus(); cycleExamples(true); } else { hideList(); clearInterval(exTimer); }
    /* the bar takes a row out of the stage, so the map and the overlay canvas resize */
    SBMM.shell.relayout();
    setTimeout(() => SBMM.snap.sizeCanvas(), 60);
    return on;
  }

  function wire() {
    bar = $("cmdbar"); inp = $("cmdIn"); list = $("cmdList"); promptEl = $("cmdPrompt");
    cycleExamples(true);

    inp.addEventListener("input", () => { sel = -1; updateList(); });
    inp.addEventListener("blur", () => setTimeout(hideList, 120));
    inp.addEventListener("focus", updateList);
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const v = inp.value;
        if (pending) { const p = pending; clearAsk(); inp.value = ""; p.cb(v.trim()); return; }
        if (list.style.display === "block" && sel >= 0) { accept(matches[sel]); return; }
        inp.value = ""; hideList(); run(v);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (pending) { const p = pending; clearAsk(); inp.value = ""; toast("cancelled"); if (p.cb) p.cb(null); return; }
        if (list.style.display === "block") { hideList(); return; }
        inp.value = ""; inp.blur(); open(false); return;
      }
      if (pending) return;
      if (e.key === "Tab") { e.preventDefault(); if (matches.length) accept(matches[Math.max(0, sel)]); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (matches.length) { sel = (sel + 1) % matches.length; updateList(); }
        else if (histIdx < history.length - 1) { inp.value = history[++histIdx]; }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (matches.length && sel > 0) { sel--; updateList(); return; }
        if (histIdx > 0) { inp.value = history[--histIdx]; hideList(); }
        else if (histIdx === 0) inp.value = history[0];
        return;
      }
    });

    $("cmdBtn").onclick = () => open(null);

    document.addEventListener("keydown", e => {
      const t = e.target;
      const typing = t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(true); return; }
      if (typing) return;
      if (e.key === "`" || e.key === "~") { e.preventDefault(); open(true); }
    });

    /* the bar is open by default the first time, so it is discoverable at all */
    let seen = false;
    try { seen = localStorage.getItem("sbmm_cmdseen") === "1"; localStorage.setItem("sbmm_cmdseen", "1"); } catch (err) {}
    if (!seen) open(true);
  }

  return { wire, run, ask, pickFeature, cancelPick, open, commands: () => CMDS, find, showHelp, zoomExtents };
})();
