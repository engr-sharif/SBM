/* SBMM Site Explorer — drawing, vertex editing, and the drafting input stack.

   Everything that turns a pointer into a coordinate goes through resolve():

       object snap  →  ortho (Shift) / polar tracking  →  raw cursor

   Object snap wins, exactly as it does in AutoCAD. resolve() is the ONE place that
   decision is made, so sketching, vertex dragging, the modify tools and typed input
   all agree by construction.

   The pick engine (beginPick) is the same event loop as sketching, just with a fixed
   point count and a caller-supplied ghost — that is what OFFSET / MIRROR / ROTATE /
   MOVE / COPY / JOIN / DIM / TEXT are built on, rather than a second interaction
   system. */
"use strict";

SBMM.draw = (function () {
  let work = null;       // active sketch
  let editing = null;    // active edit session
  let picking = null;    // active point-pick sequence (modify tools, dim, text)

  const workStyle  = { pane: "drawings", color: "#FFD34D", weight: 2, dashArray: "6 5", fill: false };
  const ghostStyle = { pane: "drawings", color: "#7CD0E6", weight: 2, dashArray: "5 4", fill: false, interactive: false };

  /* drafting modes */
  let polar = false;                 // polar tracking (F10)
  const POLAR_STEP = 15;             // degrees
  let modShift = false;              // ortho while held
  let lastRes = null;                // last resolved cursor {x,y,snap,ray}
  let lastPx = { x: 0, y: 0 };       // last cursor position in page px (dyn input anchor)

  function isDrawing() { return !!work; }
  function isEditing() { return !!editing; }
  function isPicking() { return !!picking; }
  function armed() { return !!(work || picking); }

  function vertexIcon(cls) {
    return L.divIcon({ className: "vtx " + (cls || ""), iconSize: [12, 12] });
  }
  const norm360 = a => ((a % 360) + 360) % 360;

  /* ------------------------------------------------------------------ */
  /* coordinate resolution: snap > ortho/polar > raw                     */
  /* ------------------------------------------------------------------ */
  function anchor() {
    if (work && work.pts.length) return work.pts[work.pts.length - 1];
    if (picking) {
      if (picking.pts.length) return picking.pts[picking.pts.length - 1];
      if (picking.opts.anchor) return picking.opts.anchor;
    }
    return null;
  }
  function resolve(x, y) {
    const from = anchor();
    let snap = null;
    try { snap = SBMM.snap.query(x, y, { from }); } catch (e) { /* index not ready */ }
    if (snap) { lastRes = { x: snap.x, y: snap.y, snap, ray: null }; return lastRes; }
    if (from && (modShift || polar)) {
      const dx = x - from[0], dy = y - from[1];
      const step = modShift ? 90 : POLAR_STEP;
      const ang = Math.round(Math.atan2(dy, dx) * 180 / Math.PI / step) * step;
      const rad = ang * Math.PI / 180, cx = Math.cos(rad), cy = Math.sin(rad);
      const proj = dx * cx + dy * cy;                    // project onto the locked ray
      const nx = from[0] + proj * cx, ny = from[1] + proj * cy;
      lastRes = { x: nx, y: ny, snap: null,
        ray: { from, to: [nx, ny], angle: norm360(ang), dist: Math.abs(proj), mode: modShift ? "ortho" : "polar" } };
      return lastRes;
    }
    lastRes = { x, y, snap: null, ray: null };
    return lastRes;
  }
  function paintOverlay() {
    if (!armed() && !editing) { SBMM.snap.paint(null); return; }
    SBMM.snap.paint(lastRes ? { snap: lastRes.snap, ray: lastRes.ray } : null);
  }
  /* unit direction the cursor currently defines from the anchor (for typed distance) */
  function currentDir() {
    const from = anchor(); if (!from || !lastRes) return null;
    const dx = lastRes.x - from[0], dy = lastRes.y - from[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return null;
    return [dx / L, dy / L];
  }

  /* ---------------- sketching ---------------- */
  function begin(opts) {
    cancel();
    work = {
      opts, pts: [],
      line: L.polyline([], workStyle).addTo(SBMM.map),
      rubber: L.polyline([], { ...workStyle, opacity: .45, weight: 1.5 }).addTo(SBMM.map),
      markers: [], tip: null
    };
    /* Shift is ortho while sketching, so it must not also start Leaflet's zoom box */
    if (SBMM.map.boxZoom) SBMM.map.boxZoom.disable();
    /* Say what to do before the first click. Until this, arming a tool lit a
       button and said nothing — the running readout only appeared once a vertex
       existed, so the one moment a new user needs the instruction was the one
       moment there wasn't one. */
    if (opts && opts.startTip) {
      $("sketchTip").textContent = opts.startTip;
      $("sketchTip").style.display = "block";
    }
  }
  function click(x, y) {
    if (!work) return;
    work.pts.push([x, y]);
    const mk = L.circleMarker([y, x], { pane: "drawings", radius: 4, color: "#FFD34D", weight: 2, fillColor: "#1B2429", fillOpacity: 1 }).addTo(SBMM.map);
    work.markers.push(mk);
    SBMM.undo.push("add vertex", () => removeLast());
    refresh();
  }
  function removeLast() {
    if (!work || !work.pts.length) return;
    work.pts.pop();
    const mk = work.markers.pop(); if (mk) SBMM.map.removeLayer(mk);
    refresh();
  }
  function refresh() {
    if (!work) return;
    const closed = work.opts.closed && work.pts.length > 2;
    const ll = work.pts.map(p => [p[1], p[0]]);
    work.line.setLatLngs(closed ? [...ll, ll[0]] : ll);
    liveTip();
    SBMM.viewer3d.updateSketch(work.pts, work.opts.closed);
  }
  /* 3D-side hooks */
  function previewAt(x, y) { if (work && work.pts.length) SBMM.viewer3d.updateSketch(work.pts, work.opts.closed, [x, y]); }
  function finishSketch() { if (work && work.pts.length >= (work.opts.minPts || 2)) finish(); }
  function removeLastVertex() { removeLast(); }

  function move(x, y) {
    if (!work || !work.pts.length) { return; }
    const last = work.pts[work.pts.length - 1];
    const seg = [[last[1], last[0]], [y, x]];
    if (work.opts.closed && work.pts.length > 1) seg.push([work.pts[0][1], work.pts[0][0]]);
    work.rubber.setLatLngs(seg);
    liveTip(x, y);
  }
  function liveTip(cx, cy) {
    if (!work || !work.pts.length) return;
    const pts = cx != null ? [...work.pts, [cx, cy]] : work.pts;
    let txt;
    if (work.opts.closed && pts.length > 2) {
      txt = `${fmt(polyArea(pts) / 43560, 3)} ac · ${fmt0(polyArea(pts))} ft²`;
    } else {
      txt = `${fmt(lineLength(pts), 1)} ft`;
    }
    const hint = polar ? " · polar 15°" : "";
    $("sketchTip").textContent = txt + `  ·  ${pts.length} vtx — type a distance or @dx,dy · double-click / Enter to finish, Esc cancels${hint}`;
    $("sketchTip").style.display = "block";
  }
  function finish() {
    if (!work) return;
    const { opts, pts } = work;
    if (pts.length < (opts.minPts || 2)) { toast(`need at least ${opts.minPts || 2} points`); return; }
    teardown();
    opts.onFinish(pts);
  }
  function cancel() {
    if (!work) return;
    teardown();
  }
  function teardown() {
    if (!work) return;
    SBMM.map.removeLayer(work.line); SBMM.map.removeLayer(work.rubber);
    work.markers.forEach(m => SBMM.map.removeLayer(m));
    work = null;
    $("sketchTip").style.display = "none";
    closeTyped();
    SBMM.snap.paint(null);
    if (SBMM.map.boxZoom && !picking) SBMM.map.boxZoom.enable();
    SBMM.viewer3d.updateSketch(null);
  }

  /* ------------------------------------------------------------------ */
  /* pick engine — the modify tools, DIM and TEXT run on this            */
  /* ------------------------------------------------------------------ */
  /* opts: { count, prompts:[...], onMove(pts,cursor)->ghost, onDone(pts),
             onCancel(), anchor:[x,y], typed(str,pts)->{x,y}|"commit"|null,
             rubberFrom:bool }
     ghost: { rings:[{pts, closed, style}], label } | null                     */
  function beginPick(opts) {
    cancel(); endEdit(); endPick(true);
    picking = { opts, pts: [], ghost: L.layerGroup().addTo(SBMM.map) };
    if (SBMM.map.boxZoom) SBMM.map.boxZoom.disable();
    $("map").classList.add("picking");
    promptStep();
    return picking;
  }
  function promptStep() {
    if (!picking) return;
    const p = picking.opts.prompts || [];
    const msg = p[picking.pts.length] || p[p.length - 1] || "click a point";
    $("sketchTip").textContent = msg + " — Esc cancels";
    $("sketchTip").style.display = "block";
  }
  function pickClick(x, y) {
    if (!picking) return;
    picking.pts.push([x, y]);
    /* count 0 = open-ended: keep collecting until a double-click, Enter, or the
       command's own minimum is reached and the user says so (PAD footprints) */
    if (!picking.opts.count) { promptStep(); pickMove(x, y); return; }
    if (picking.pts.length >= picking.opts.count) {
      const pts = picking.pts, o = picking.opts;
      endPick(true);
      try { o.onDone(pts); } catch (e) { console.error(e); toast("command failed: " + e.message); }
    } else promptStep();
  }
  function pickMove(x, y) {
    if (!picking || !picking.opts.onMove) return;
    let g = null;
    try { g = picking.opts.onMove(picking.pts, [x, y]); } catch (e) { g = null; }
    drawGhost(g);
  }
  function drawGhost(g) {
    if (!picking) return;
    picking.ghost.clearLayers();
    if (!g) return;
    for (const r of (g.rings || [])) {
      if (!r.pts || r.pts.length < 2) continue;
      const ll = r.pts.map(p => [p[1], p[0]]);
      const st = { ...ghostStyle, ...(r.style || {}) };
      if (r.closed) L.polygon([ll], { ...st, fill: false }).addTo(picking.ghost);
      else L.polyline(ll, st).addTo(picking.ghost);
    }
    for (const p of (g.dots || [])) {
      L.circleMarker([p[1], p[0]], { pane: "drawings", radius: 4, color: "#7CD0E6", weight: 2, fillColor: "#12181C", fillOpacity: 1, interactive: false }).addTo(picking.ghost);
    }
    if (g.label) { $("sketchTip").textContent = g.label + " — Esc cancels"; }
  }
  /* finish an open-ended pick with whatever has been collected */
  function finishPick() {
    if (!picking || picking.opts.count) return;
    const pts = picking.pts, o = picking.opts;
    if (pts.length < (o.minPts || 2)) { toast(`need at least ${o.minPts || 2} points`); return; }
    endPick(true);
    try { o.onDone(pts); } catch (e) { console.error(e); toast("command failed: " + e.message); }
  }

  function endPick(silent) {
    if (!picking) return;
    const o = picking.opts;
    picking.ghost.clearLayers();
    SBMM.map.removeLayer(picking.ghost);
    picking = null;
    $("map").classList.remove("picking");
    $("sketchTip").style.display = "none";
    closeTyped();
    SBMM.snap.paint(null);
    if (SBMM.map.boxZoom && !work) SBMM.map.boxZoom.enable();
    if (!silent && o.onCancel) o.onCancel();
  }

  /* ------------------------------------------------------------------ */
  /* typed input (AutoCAD dynamic input)                                 */
  /* ------------------------------------------------------------------ */
  /*  150            distance along the current cursor direction
      @150,75        relative dx,dy ft
      @150<45        relative polar, degrees CCW from east
      150<45         same, tolerated without the @
      6371500,2128900  absolute State Plane ft                                */
  function parseTyped(s) {
    s = String(s || "").trim();
    if (!s) return null;
    const from = anchor();
    let m;
    if ((m = /^@\s*(-?[\d.]+)\s*<\s*(-?[\d.]+)$/.exec(s))) {
      if (!from) return null;
      const d = +m[1], a = +m[2] * Math.PI / 180;
      return { x: from[0] + d * Math.cos(a), y: from[1] + d * Math.sin(a),
               desc: `relative polar — ${fmt(+m[1], 1)} ft @ ${fmt(+m[2], 0)}°` };
    }
    if ((m = /^@\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)$/.exec(s))) {
      if (!from) return null;
      return { x: from[0] + +m[1], y: from[1] + +m[2],
               desc: `relative — Δ${fmt(+m[1], 1)}, Δ${fmt(+m[2], 1)} ft` };
    }
    if ((m = /^(-?[\d.]+)\s*<\s*(-?[\d.]+)$/.exec(s))) {
      if (!from) return null;
      const d = +m[1], a = +m[2] * Math.PI / 180;
      return { x: from[0] + d * Math.cos(a), y: from[1] + d * Math.sin(a),
               desc: `polar — ${fmt(+m[1], 1)} ft @ ${fmt(+m[2], 0)}°` };
    }
    if ((m = /^(-?[\d.]+)\s*,\s*(-?[\d.]+)$/.exec(s))) {
      return { x: +m[1], y: +m[2], desc: "absolute State Plane (EPSG:6418 ft)" };
    }
    if ((m = /^(-?[\d.]+)$/.exec(s))) {
      if (!from) return null;
      const dir = currentDir();
      if (!dir) return null;
      const d = +m[1];
      return { x: from[0] + d * dir[0], y: from[1] + d * dir[1],
               desc: `${fmt(d, 1)} ft along ${fmt(norm360(Math.atan2(dir[1], dir[0]) * 180 / Math.PI), 0)}°` };
    }
    return null;
  }

  function typedOpen() { return $("dynInput") && $("dynInput").classList.contains("open"); }
  function openTyped(seed) {
    if (!armed()) return;
    const box = $("dynInput"), inp = $("dynIn");
    box.classList.add("open");
    const stage = $("stage").getBoundingClientRect();
    const x = clamp(lastPx.x - stage.left + 20, 8, stage.width - 250);
    const y = clamp(lastPx.y - stage.top + 20, 8, stage.height - 70);
    box.style.left = x + "px"; box.style.top = y + "px";
    inp.value = seed || "";
    inp.focus();
    typedHint();
  }
  function closeTyped() {
    const box = $("dynInput"); if (!box) return;
    box.classList.remove("open");
    $("dynIn").value = "";
    if (document.activeElement === $("dynIn")) $("dynIn").blur();
  }
  function typedHint() {
    const v = $("dynIn").value;
    const h = $("dynHint");
    if (!v) { h.textContent = "distance · @dx,dy · @dist<ang · E,N"; h.className = "dynhint"; return; }
    if (picking && picking.opts.typedHint) { const t = picking.opts.typedHint(v); if (t) { h.textContent = t.text; h.className = "dynhint " + (t.ok ? "ok" : "bad"); return; } }
    const p = parseTyped(v);
    if (!p) { h.textContent = "can't read that yet…"; h.className = "dynhint bad"; return; }
    h.textContent = `${p.desc}  →  ${fmt0(p.x)} E, ${fmt0(p.y)} N`;
    h.className = "dynhint ok";
    /* live ghost of where Enter would land */
    if (picking) pickMove(p.x, p.y);
    else if (work) move(p.x, p.y);
    SBMM.snap.paint({ snap: { x: p.x, y: p.y, type: "end", label: "typed" }, ray: null });
  }
  function commitTyped() {
    const v = $("dynIn").value;
    if (picking && picking.opts.typed) {
      const r = picking.opts.typed(v, picking.pts);
      if (r === null || r === undefined) { toast("couldn't read \"" + v + "\""); return; }
      closeTyped();
      if (r === "done") return;
      pickClick(r.x, r.y);
      return;
    }
    const p = parseTyped(v);
    if (!p) { toast("couldn't read \"" + v + "\" — try 150, @150,75, @150<45 or an E,N pair"); return; }
    closeTyped();
    if (picking) pickClick(p.x, p.y);
    else if (work) { click(p.x, p.y); move(p.x, p.y); }
  }

  /* ---------------- vertex editing ---------------- */
  function edit(f, onChange, onDone) {
    endEdit();
    const closed = f.type === "area" || f.type === "volume" || f.type === "import-poly";
    editing = { f, onChange, onDone, closed, vmarks: [], mids: [] };
    buildHandles();
    toast("editing — drag vertices (snapping) · click a midpoint to insert · right-click a vertex to delete · Enter when done");
    $("map").classList.add("editing");
    if (SBMM.mode) SBMM.mode.beginEdit();       // §2: the `edit` mode, cursor + HUD
  }
  function buildHandles() {
    clearHandles();
    const { f, closed } = editing;
    f.pts.forEach((p, i) => {
      const mk = L.marker([p[1], p[0]], { icon: vertexIcon(), draggable: true, pane: "drawings" }).addTo(SBMM.map);
      mk.on("drag", e => {
        const ll = e.target.getLatLng();
        /* snap the dragged vertex — the neighbouring vertex is the perpendicular anchor */
        const prev = f.pts[(i - 1 + f.pts.length) % f.pts.length];
        let s = null;
        try { s = SBMM.snap.query(ll.lng, ll.lat, { from: prev }); } catch (err) {}
        const nx = s ? s.x : ll.lng, ny = s ? s.y : ll.lat;
        if (s) { e.target.setLatLng([ny, nx]); SBMM.snap.paint({ snap: s }); } else SBMM.snap.paint(null);
        f.pts[i] = [nx, ny];
        applyEdit(false);
      });
      mk.on("dragstart", () => {
        const before = f.pts.map(q => q.slice());
        SBMM.undo.push("move vertex", () => { f.pts = before; applyEdit(true); });
      });
      mk.on("dragend", () => { SBMM.snap.paint(null); applyEdit(true); });
      mk.on("contextmenu", e => {
        L.DomEvent.stop(e);
        if (f.pts.length <= (closed ? 3 : 2)) { toast("can't delete — too few vertices"); return; }
        const before = f.pts.map(q => q.slice());
        SBMM.undo.push("delete vertex", () => { f.pts = before; applyEdit(true); });
        f.pts.splice(i, 1);
        applyEdit(true);
      });
      editing.vmarks.push(mk);
    });
    const n = f.pts.length, last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = f.pts[i], b = f.pts[(i + 1) % n];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const mk = L.marker([mid[1], mid[0]], { icon: vertexIcon("mid"), pane: "drawings" }).addTo(SBMM.map);
      mk.on("click", () => {
        const before = f.pts.map(q => q.slice());
        SBMM.undo.push("insert vertex", () => { f.pts = before; applyEdit(true); });
        f.pts.splice(i + 1, 0, mid);
        applyEdit(true);
      });
      editing.mids.push(mk);
    }
  }
  function applyEdit(rebuildHandles) {
    const { f, onChange } = editing;
    onChange(f, !rebuildHandles);      // live=true while dragging
    if (rebuildHandles) buildHandles();
    SBMM.store.autosave();
  }
  function clearHandles() {
    if (!editing) return;
    editing.vmarks.forEach(m => SBMM.map.removeLayer(m));
    editing.mids.forEach(m => SBMM.map.removeLayer(m));
    editing.vmarks = []; editing.mids = [];
  }
  function endEdit() {
    if (!editing) return;
    clearHandles();
    const { f, onDone } = editing;
    editing = null;
    $("map").classList.remove("editing");
    SBMM.snap.paint(null);
    if (SBMM.mode) SBMM.mode.endEdit();
    if (onDone) onDone(f);
  }

  /* ---------------- drafting mode toggles ---------------- */
  function setPolar(v) {
    polar = v == null ? !polar : !!v;
    const b = $("polarBtn");
    if (b) { b.classList.toggle("on", polar); b.title = "Polar tracking " + (polar ? "ON" : "OFF") + " — 15° increments (F10)"; }
    try { localStorage.setItem("sbmm_polar", polar ? "1" : "0"); } catch (e) {}
    return polar;
  }

  /* ---------------- map + key wiring ---------------- */
  function wire() {
    const map = SBMM.map;
    try { polar = localStorage.getItem("sbmm_polar") === "1"; } catch (e) {}
    setPolar(polar);

    map.on("click", e => {
      const r = resolve(e.latlng.lng, e.latlng.lat);
      if (picking) { pickClick(r.x, r.y); return; }
      if (!SBMM.tools.active()) return;
      SBMM.tools.mapClick(r.x, r.y);
    });
    map.on("mousemove", e => {
      const oe = e.originalEvent;
      if (oe) { modShift = !!oe.shiftKey; lastPx = { x: oe.clientX, y: oe.clientY }; }
      /* only pay for a snap query when something is actually collecting a point */
      if (!armed()) { SBMM.snap.paint(null); return; }
      const r = resolve(e.latlng.lng, e.latlng.lat);
      if (picking) pickMove(r.x, r.y); else move(r.x, r.y);
      paintOverlay();
    });
    map.on("mouseout", () => SBMM.snap.paint(null));
    map.on("dblclick", () => {
      if (work && work.pts.length >= 2) { finish(); return; }
      if (picking && !picking.opts.count) finishPick();
    });
    map.on("contextmenu", e => {
      if (picking) { L.DomEvent.stop(e); endPick(); return; }
      if (work) { L.DomEvent.stop(e); removeLast(); }
    });

    /* typed input box */
    const inp = $("dynIn");
    inp.addEventListener("input", typedHint);
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commitTyped(); }
      else if (e.key === "Escape") { e.preventDefault(); closeTyped(); }
      else if (e.key === "Tab") { e.preventDefault(); closeTyped(); }
    });

    document.addEventListener("keydown", e => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
        if (e.key === "Escape" && e.target.id !== "dynIn") e.target.blur();
        return;
      }
      if (e.key === "Shift") modShift = true;
      if (e.key === "F3") { e.preventDefault(); SBMM.snap.setEnabled(null); toast("object snap " + (SBMM.snap.enabled() ? "on" : "off")); return; }
      if (e.key === "F10") { e.preventDefault(); setPolar(null); toast("polar tracking " + (polar ? "on — 15°" : "off")); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); SBMM.undo.pop(); return; }
      /* start typed input from the keyboard, AutoCAD-style */
      if (armed() && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9@.\-]$/.test(e.key)) {
        e.preventDefault(); openTyped(e.key); return;
      }
      if (e.key === "Enter") {
        if (work) finish();
        else if (picking && !picking.opts.count) finishPick();
        else if (editing) endEdit();
      }
      if (e.key === "Escape") {
        if (typedOpen()) { closeTyped(); return; }
        /* §2: Esc ALWAYS cancels the in-progress sketch, returns to Navigate and
           clears the tool highlight. Before v9 an Esc mid-sketch re-armed the
           same tool, which fixed the dead-button bug (a lit button over a torn
           down sketch engine) at the price of a second rule to remember. The
           spec settles it: one key, one destination. SBMM.mode.navigate() tears
           the sketch, the pick and the edit down together, so nothing is left
           half-armed whichever of them was live. */
        if (picking || work || editing) {
          SBMM.mode.navigate();
          return;
        }
        SBMM.store.select(null);
        SBMM.mode.navigate();
      }
      if (e.key === "Backspace" || e.key === "Delete") { if (work) removeLast(); }
    });
    document.addEventListener("keyup", e => { if (e.key === "Shift") modShift = false; });
    window.addEventListener("blur", () => { modShift = false; });

    /* status-bar drafting toggles */
    if ($("polarBtn")) $("polarBtn").onclick = () => { setPolar(null); toast("polar tracking " + (polar ? "on — 15°" : "off")); };
  }

  return {
    begin, click, finish, cancel, edit, endEdit, isDrawing, isEditing, wire,
    previewAt, finishSketch, removeLastVertex,
    /* drafting stack */
    beginPick, endPick, finishPick, isPicking, drawGhost, resolve, parseTyped,
    openTyped, closeTyped,
    setPolar, isPolar: () => polar, isOrtho: () => modShift
  };
})();
