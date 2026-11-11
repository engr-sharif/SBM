/* =====================================================================
   js/readout.js — what a layer READS at a point (v58, step 3 of
   docs/V56_REVIEW_PLAN.md)

   A raster has a legend, and until now most of them had nothing else: slope,
   aspect, the elevation tint, land cover and the isopach could be looked at
   and not asked. The accumulation raster answered in the status bar, the TEM
   slice at the pointer, the rim band after half a second — four different
   places for one question.

   ONE REGISTRY. A module that draws something with a value at every point
   registers a reader:

     SBMM.readout.register({
       id,                 unique; registering it again replaces it
       order,              lower answers first (the table is in ORDER below)
       row: { g, l },      the layer row that switches it — the reader is on
                           while that row is on …
       on(ctx),            … or this decides instead (ctx.view is "2d" | "3d":
                           a 2D row is not always what the 3D ground wears)
       at(x, y, ctx)       null, or { name, value, lines?, dim?, graphic?,
                                      html?, key?, rows?, rec? }
     })

   `name` is what the layer is ("Slope"), `value` what it reads here
   ("12.4° · 22 %"). `rows` are what the Point card lists (default: one row,
   name and value). `html` replaces the chip's standard two lines for a reader
   that draws its own (the TEM probe's core). `rec` is the module's own record
   and rides along on the `readout` event.

   WHO ASKS.
     · the chip at the pointer (js/tip.js), when nothing with a name is under
       it: the first reader that answers, in ORDER. In 2D this module listens
       to the map; in 3D js/viewer3d.js hands over the ground point its
       status read-out has already found — no second raycast.
     · the Point card (SBMM.popups.forTerrain): every reader that answers.

   Navigate mode only, like the pick engines: in a tool the snap glyph is the
   label. Nothing here asks for a frame.
   ===================================================================== */
window.SBMM = window.SBMM || {};
SBMM.readout = (function () {
  /* The order readers answer in — the things an analysis put there on purpose
     first, the terrain's own rasters last. A module passes one of these. */
  const ORDER = {
    water: 10,                                   // the open overtopping analysis: rim band, stage
    tem_slice: 20, tem_map: 22, tem_waste: 24, tem_seep: 26,
    cutfill: 30, isopach: 32,
    accum: 40, cover: 44,
    wherewater: 50, drainage: 52,
    trees: 60,
    slope: 70, aspect: 72, hypso: 74, canopy: 76
  };
  const readers = [];
  const stats = { hovers: 0, answers: 0 };

  function register(r) {
    if (!r || !r.id || typeof r.at !== "function") return;
    if (r.order == null) r.order = ORDER[r.id] != null ? ORDER[r.id] : 90;
    const i = readers.findIndex(q => q.id === r.id);
    if (i >= 0) readers.splice(i, 1);
    readers.push(r);
    readers.sort((a, b) => a.order - b.order);
  }
  function unregister(id) {
    const i = readers.findIndex(q => q.id === id);
    if (i >= 0) readers.splice(i, 1);
  }
  function isOn(r, ctx) {
    try {
      if (r.on) return !!r.on(ctx);
      return !!(r.row && SBMM.layerState && SBMM.layerState.isOn(r.row.g, r.row.l));
    } catch (e) { return false; }
  }
  function ask(r, x, y, ctx) {
    let a = null;
    try { a = r.at(x, y, ctx); } catch (e) { a = null; }
    if (!a || a.value == null || a.value === "") return null;
    a.id = r.id;
    if (a.key == null) a.key = a.value;
    return a;
  }
  /* every reader that answers here, in order */
  function at(x, y, ctx) {
    ctx = ctx || { view: "2d" };
    const out = [];
    if (!isFinite(x) || !isFinite(y)) return out;
    for (const r of readers) {
      if (!isOn(r, ctx)) continue;
      const a = ask(r, x, y, ctx);
      if (a) out.push(a);
    }
    return out;
  }
  /* the first one */
  function top(x, y, ctx) {
    ctx = ctx || { view: "2d" };
    if (!isFinite(x) || !isFinite(y)) return null;
    for (const r of readers) {
      if (!isOn(r, ctx)) continue;
      const a = ask(r, x, y, ctx);
      if (a) return a;
    }
    return null;
  }
  /* THE CARD a click on bare ground opens (3b). A reader may carry its own —
       card(x, y, ctx) -> { html, title?, at?: [x, y], className?, maxWidth?, minWidth? }
     — where a general "Point" card would say less than the layer can (the TEM
     probe's profile, the water's description, a tree). The first reader that
     answers AND has one wins; otherwise the answer is null and the caller
     opens the Point card, which lists every reading. */
  function cardAt(x, y, ctx) {
    ctx = ctx || { view: "2d" };
    if (!isFinite(x) || !isFinite(y)) return null;
    for (const r of readers) {
      if (!r.card || !isOn(r, ctx)) continue;
      let c = null;
      try { c = r.card(x, y, ctx); } catch (e) { c = null; }
      if (c && c.html) { c.id = r.id; return c; }
    }
    return null;
  }
  /* the rows the Point card lists */
  function rows(x, y, ctx) {
    const out = [];
    for (const a of at(x, y, ctx)) {
      if (a.rows) for (const r of a.rows) out.push(r);
      else out.push([a.name, a.value]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* the chip                                                          */
  /* ---------------------------------------------------------------- */
  const T = () => SBMM.tip;
  let lastKey = null;
  function navigating() {
    if (!SBMM.mode || SBMM.mode.current() !== "navigate") return false;
    if (SBMM.tools && SBMM.tools.active && SBMM.tools.active()) return false;
    if (SBMM.draw && ((SBMM.draw.armed && SBMM.draw.armed()) || (SBMM.draw.isDrawing && SBMM.draw.isDrawing()))) return false;
    return !document.body.classList.contains("gated");
  }
  let lastHover = null;              // for the harness: what the chip was last asked about
  function say(a, view, cx, cy) {
    const tip = T();
    if (!tip) return;
    const esc = tip.esc;
    tip.claim("readout", {
      x: cx, y: cy, view, key: a.id + "|" + a.key,
      html: a.html || tip.html({ lead: a.value, kind: a.name, lines: a.lines, dim: a.dim, graphic: a.graphic }),
      line: `<b>${esc(a.value)}</b><span class="pkkind">${esc(a.name)}</span>`
    });
  }
  function note(view, x, y, a) {
    const k = a ? view + "|" + a.id + "|" + a.key : null;
    if (k === lastKey) return;
    lastKey = k;
    if (SBMM.events) SBMM.events.emit("readout", { view, x, y, top: a });
  }
  /* (x, y) is the State Plane point under the pointer, (cx, cy) the pointer */
  function hover(view, x, y, cx, cy) {
    if (!navigating()) { leave(); return null; }
    stats.hovers++;
    const a = top(x, y, { view });
    lastHover = { view, x, y, id: a ? a.id : null, name: a ? a.name : null, value: a ? a.value : null };
    if (a) { stats.answers++; say(a, view, cx, cy); } else if (T()) T().release("readout");
    note(view, x, y, a);
    return a;
  }
  function leave() {
    if (T()) T().release("readout");
    note("", NaN, NaN, null);
  }

  /* 2D: the map's own pointer */
  let raf = 0, last = null;
  function overChrome(t) {
    return !!(t && t.closest && t.closest(".leaflet-popup, .leaflet-control, .leaflet-tooltip-pane"));
  }
  function move2d(ev) {
    const map = SBMM.map;
    const touch = SBMM.touch && SBMM.touch.lastPointer && SBMM.touch.lastPointer() === "touch";
    if (!ev || !map || ev.buttons || touch || overChrome(ev.target) || map._animatingZoom
        || (map.dragging && map.dragging.moving())) { leave(); return; }
    const ll = map.mouseEventToLatLng(ev);
    hover("2d", ll.lng, ll.lat, ev.clientX, ev.clientY);
  }
  /* ---------------------------------------------------------------- */
  /* 2D: a click on bare ground                                        */
  /* ---------------------------------------------------------------- */
  /* The 3D view has always answered a click on the ground with the Point
     card; the 2D map answered with nothing (the Inspect tool, or a right
     click, were the only ways to it), and three layers each listened for the
     map's click on their own (trees, the TEM slice, the rim band). ONE handler
     now, with three rules:
       · a click that CLOSED something — a popup, a selection — only closes it;
       · a feature that answers a click owns it (js/pick2d.js has already
         fired it; the map's own click still arrives here, as Leaflet always
         sends it);
       · the card waits out a double-click, which ends a sketch in this app
         and is not a question. */
  const DBL_MS = 230;
  let downState = null, clickT = 0;
  function noteDown() {
    const map = SBMM.map;
    downState = { popup: !!(map._popup && map._popup.isOpen && map._popup.isOpen()),
                  sel: !!(SBMM.store && SBMM.store.selectedFeature && SBMM.store.selectedFeature()) };
  }
  function click2d(ev) {
    const map = SBMM.map;
    clearTimeout(clickT);
    if (!ev || !ev.latlng || !navigating()) return;
    /* the press belongs to THIS click and to no later one (a click the code
       fires has no press of its own) */
    const closed = downState && (downState.popup || downState.sel);
    downState = null;
    if (closed) return;
    if (SBMM.pick2d && SBMM.pick2d.probe && SBMM.pick2d.probe(ev.latlng).some(c => c.acts)) return;
    const x = ev.latlng.lng, y = ev.latlng.lat;
    clickT = setTimeout(() => {
      if (!navigating() || (map._popup && map._popup.isOpen && map._popup.isOpen())) return;   // something else answered
      const c = cardAt(x, y, { view: "2d" });
      if (!c) { if (isFinite(SBMM.elev(x, y)[0])) SBMM.tools.inspectAt(x, y); return; }
      L.popup({ className: c.className || "", maxWidth: c.maxWidth || 320, minWidth: c.minWidth || 50 })
        .setLatLng(c.at ? [c.at[1], c.at[0]] : [y, x])
        .setContent(c.title ? `<div class="pop"><div class="pop-t">${T().esc(c.title)}</div>${c.html}</div>` : c.html)
        .openOn(map);
    }, DBL_MS);
  }

  function wire() {
    const map = SBMM.map;
    if (!map || wire.done) return;
    wire.done = true;
    const box = map.getContainer();
    box.addEventListener("pointerdown", noteDown, true);
    map.on("click", click2d);
    map.on("dblclick zoomstart", () => clearTimeout(clickT));
    box.addEventListener("mousemove", ev => {
      last = ev;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; move2d(last); });
    }, { passive: true });
    box.addEventListener("mouseleave", leave);
    map.on("movestart zoomstart", leave);
    if (SBMM.events) {
      SBMM.events.on("mode", () => { if (!navigating()) leave(); });
      SBMM.events.on("view", leave);
    }
  }

  return { register, unregister, at, top, rows, cardAt, hover, leave, wire, ORDER,
           list: () => readers.map(r => r.id), stats: () => Object.assign({}, stats), last: () => lastHover };
})();
