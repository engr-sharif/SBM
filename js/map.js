/* SBMM Site Explorer — map core: Leaflet CRS.Simple with latlng=[Y,X] in SP ft */
"use strict";

SBMM.initMap = function () {
  const map = L.map("map", {
    crs: L.CRS.Simple, minZoom: -5, maxZoom: 6, zoomSnap: 0.25, zoomDelta: 0.5,
    zoomControl: false, doubleClickZoom: false, attributionControl: false,
    preferCanvas: true
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  SBMM.map = map;

  /* panes to keep z-order sane: analysis rasters under vectors, drawings on top */
  map.createPane("raster");   map.getPane("raster").style.zIndex = 260;
  map.createPane("analysis"); map.getPane("analysis").style.zIndex = 320;
  map.createPane("vectors");  map.getPane("vectors").style.zIndex = 420;
  map.createPane("drawings"); map.getPane("drawings").style.zIndex = 460;
  /* The animated flow line (v10) lives above the drawings in its own pane, and
     that pane is deliberately NOT a canvas: js/water.js renders into it with an
     L.svg renderer, because a canvas vector has no DOM element and `className`
     on it reaches nothing (the dead `.sheetpulse` CSS was the same bug). Being
     SVG and pointer-events:none also keeps it out of the pass-through below —
     it never receives an event, so nothing has to be handed down through it. */
  map.createPane("water");    map.getPane("water").style.zIndex = 470;
  map.getPane("water").style.pointerEvents = "none";

  /* ---------- canvas pane pass-through ----------------------------------
     `preferCanvas` gives every pane its own full-size <canvas>, and a canvas is
     an opaque rectangle to the DOM: the topmost pane's canvas receives every
     pointer event, and Leaflet only hit-tests the layers in *that* renderer.
     So the moment anything exists in a higher pane — draw one line and the
     drawings pane appears — every interactive layer below it silently stops
     responding: DU and pile outlines, sample points, design boundaries,
     dataset symbols, the design-sheet footprints. Nothing errors; clicks just
     stop working, which is why it went unnoticed.

     Leaflet has no pass-through for this, so here is one. When the canvas that
     received the event has nothing under the pointer, the event is handed down
     to the first thing below that does — another pane's canvas, or a marker
     element. Clicks walk the whole stack (rare, so the cost does not matter);
     mousemove only checks the other canvases, because the style toggling the
     element walk needs would force a layout on every mouse move. */
  function rendererOf(canvasEl) {
    const R = map._paneRenderers || {};
    for (const k in R) if (R[k] && R[k]._container === canvasEl) return R[k];
    return null;
  }
  function canvasHit(canvasEl, p) {
    const r = rendererOf(canvasEl);
    if (!r || !r._drawFirst) return false;
    for (let o = r._drawFirst; o; o = o.next) {
      const l = o.layer;
      if (l && l.options && l.options.interactive && l._containsPoint && l._containsPoint(p)) return true;
    }
    return false;
  }
  const isPaneCanvas = el => !!el && el.tagName === "CANVAS" && el.parentNode
    && /leaflet-pane/.test(el.parentNode.className || "");
  function forwardTo(el, ev) {
    const clone = new MouseEvent(ev.type, ev);
    clone.__sbmmFwd = true;
    el.dispatchEvent(clone);
  }
  function otherCanvasesBelow(canvasEl) {
    const z = el => parseInt((el.parentNode && el.parentNode.style.zIndex) || 0, 10) || 0;
    const me = z(canvasEl);
    return [...map.getContainer().querySelectorAll(".leaflet-pane > canvas")]
      .filter(c => c !== canvasEl && z(c) < me)
      .sort((a, b) => z(b) - z(a));
  }
  function passThrough(ev) {
    if (ev.__sbmmFwd || !isPaneCanvas(ev.target)) return;
    const p = map.mouseEventToLayerPoint(ev);
    if (canvasHit(ev.target, p)) return;                 // the top canvas owns it
    if (ev.type === "mousemove") {
      for (const c of otherCanvasesBelow(ev.target)) if (canvasHit(c, p)) { forwardTo(c, ev); return; }
      return;
    }
    const disabled = [];
    let found = null, el = ev.target;
    try {
      for (let i = 0; i < 5 && el; i++) {
        el.style.pointerEvents = "none"; disabled.push(el);
        el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!el) break;
        if (isPaneCanvas(el)) { if (canvasHit(el, p)) { found = el; break; } continue; }
        const mk = el.closest && el.closest(".leaflet-marker-icon, .leaflet-interactive");
        if (mk) { found = mk; break; }
        break;                                            // plain ground below
      }
    } finally { disabled.forEach(c => { c.style.pointerEvents = ""; }); }
    if (!found) return;
    ev.stopPropagation();
    forwardTo(found, ev);
  }
  for (const t of ["click", "dblclick", "contextmenu", "mousemove"])
    map.getContainer().addEventListener(t, passThrough, true);

  /* ---------- layer control rows ----------------------------------------
     A row is now a VIEW onto SBMM.layerState (§4), not the state itself. The
     legacy group key a module passes still says which part of the tree the row
     lands in; it also picks the layerState group, because the two are the same
     idea seen from the DOM and from the model. Modules keep calling
     addLayerRow exactly as before and get a row wired into the one state.

     `id` names the layer inside its state group. It defaults to a slug of the
     label, which is fine for rows nothing else addresses; anything the 3D view,
     the exports or the tests need to reach by name passes an explicit id. */
  const HOST = { base: "baseLayers", terr: "terrainLayers", ana: "anaLayers",
                 proj: "projLayers", invest: "investLayers",
                 design: "designLayers", data: "dataLayers",
                 cultural: "culturalLayers", mywork: "myworkLayers" };
  const SGRP = { base: "base", terr: "base", ana: "base",
                 proj: "framework", invest: "invest",
                 design: "design", data: "invest",
                 cultural: "cultural", mywork: "mywork" };
  const hostEl = k => $(HOST[k] || "lyBase");
  const slug = s => String(s).replace(/<[^>]*>/g, "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "layer";

  SBMM.addLayerRow = function (group, label, layer, opts = {}) {
    const { checked = true, swatch = null, opacity = null, onFirstShow = null,
            onChange = null, meta = null } = opts;
    /* opts.sub — v16, optional: the name of the sub-group inside this group the
       row belongs to. opts.subTitle — the sub-group header's tooltip. */
    const gid = SGRP[group] || "base";
    let lid = opts.id || slug(label);
    /* two rows with the same slug (two "Contours — …" say) must not collide */
    if (SBMM.layerState.rec(gid, lid)) {
      let n = 2; while (SBMM.layerState.rec(gid, lid + "_" + n)) n++;
      lid = lid + "_" + n;
    }

    const row = document.createElement("label"); row.className = "lyr";
    row.dataset.lgroup = gid; row.dataset.lid = lid;
    /* `tag` is a short badge AFTER the label — outside it, so it survives the
       label's ellipsis. Putting it inside meant a long name ate its own tag
       ("Drainage and waterways (28) C…"), which is the one thing a badge must
       never do (F4). */
    row.innerHTML = `<input type="checkbox">` +
      (swatch ? `<span class="sw" style="background:${swatch}"></span>` : "") +
      `<span class="lbl">${label}</span>` +
      (opts.tag ? `<span class="rowtag">${esc(opts.tag)}</span>` : "") +
      (opacity != null ? `<input type="range" class="opac" min="0" max="100" title="Layer opacity">` : "");
    const cb = row.querySelector("input[type=checkbox]");
    const op = row.querySelector(".opac");

    let shown = false;
    const show = async () => {
      if (onFirstShow && !shown) {
        shown = true;                      // set first: a second toggle must not re-enter
        row.classList.add("busy");
        try { await onFirstShow(layer); }
        catch (e) { console.error(e); toast("layer failed: " + e.message); }
        row.classList.remove("busy");
      }
      if (layer) layer.addTo(SBMM.map);
    };
    const setOpacity = v => {
      if (!layer) return;
      if (layer.setOpacity) layer.setOpacity(v);
      else if (layer.eachLayer) layer.eachLayer(l => l.setOpacity && l.setOpacity(v));
    };

    const rec = SBMM.layerState.define(gid, lid, {
      label: String(label).replace(/<[^>]*>/g, ""), on: checked, swatch, meta,
      opacity: opacity == null ? 1 : opacity,
      /* `persist: false` keeps a layer out of localStorage AND out of the
         session file — the cultural group uses it, because §7 requires an
         acknowledgement once per session and a remembered checkbox would put
         protected geometry on the map before anyone was asked */
      persist: opts.persist,
      apply(state) {
        cb.checked = state.on;
        row.classList.toggle("off", !state.on);
        if (op) op.value = Math.round(state.opacity * 100);
        if (state.on) show(); else if (layer) SBMM.map.removeLayer(layer);
        setOpacity(state.opacity);
        if (onChange) { try { onChange(state); } catch (e) { console.error(e); } }
      }
    });

    cb.checked = rec.on;
    row.classList.toggle("off", !rec.on);
    if (op) op.value = Math.round(rec.opacity * 100);
    cb.onchange = () => SBMM.layerState.set(gid, lid, { on: cb.checked });
    if (op) op.oninput = () => SBMM.layerState.set(gid, lid, { opacity: op.value / 100 });

    /* first application: honour whatever the state settled on (default, or the
       user's persisted choice), so the row and the map always agree */
    if (rec.on) { show(); setOpacity(rec.opacity); }
    else if (opacity != null) setOpacity(rec.opacity);
    if (onChange) { try { onChange({ on: rec.on, opacity: rec.opacity }); } catch (e) { console.error(e); } }

    /* v16: the tree decides which container inside the module's own host div
       the row belongs in — the host itself with no `sub:`, that sub-group's body
       with one — and then decorates the row (symbology swatch, hover toolbar,
       drag grip, keyboard). `addLayerRow`'s signature is unchanged: `sub:` is
       one more optional key, and a build without js/layertree.js falls straight
       through to the behaviour this had before. */
    const host = (SBMM.layerTree && SBMM.layerTree.hostFor)
      ? SBMM.layerTree.hostFor(hostEl(group), opts) : hostEl(group);
    host.appendChild(row);
    const ref = { layer, row, cb, group: gid, id: lid, key: gid + "/" + lid,
                  uiGroup: group, sub: opts.sub || "",
                  state: () => SBMM.layerState.get(gid, lid) };
    if (SBMM.layerTree && SBMM.layerTree.onRow) SBMM.layerTree.onRow(ref, opts);
    if (SBMM.layersUI && SBMM.layersUI.refreshCounts) SBMM.layersUI.refreshCounts();
    return ref;
  };

  /* ---------- status bar ---------- */
  /* one status bar under one stage: js/mode.js SBMM.status writes it, and the
     3D view calls the same function, so the numbers cannot diverge (§2) */
  map.on("mousemove", e => SBMM.status.at(e.latlng.lng, e.latlng.lat));

  function drawScale() {
    const z = map.getZoom(), pxPerFt = Math.pow(2, z);
    const target = 120 / pxPerFt;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
    $("scaleBar").style.width = (nice * pxPerFt) + "px";
    $("scaleTxt").textContent = nice >= 1000 ? (nice / 1000) + ",000 ft" : nice + " ft";
  }
  /* Zoom-dependent annotation. The excavation depth labels are only readable —
     and only non-overlapping — once a lot fills a useful part of the screen;
     below that they are fifteen identical boxes in a thumbnail. One class on
     the container, so nothing is rebuilt on a zoom. */
  const ZOOM_LABELS = 0;
  function zoomClass() {
    $("map").classList.toggle("zoomfar", map.getZoom() < ZOOM_LABELS);
    if (SBMM.status) SBMM.status.scale();
  }
  map.on("zoomend", () => { drawScale(); zoomClass(); });
  map.whenReady(() => { drawScale(); zoomClass(); });

  /* ---------- right-click context menu ---------- */
  const cm = $("ctxmenu");
  map.on("contextmenu", e => {
    if (SBMM.draw && SBMM.draw.isDrawing()) return; // right-click finishes/undoes while drawing
    const x = e.latlng.lng, y = e.latlng.lat;
    const [z] = SBMM.elev(x, y);
    const [lo, la] = SBMM.toLL(x, y);
    cm.innerHTML = `
      <div class="ci hd">${fmt0(x)} E · ${fmt0(y)} N · ${isNaN(z) ? "—" : fmt(z, 1) + " ft"}</div>
      <div class="ci" data-a="sp">Copy State Plane E, N</div>
      <div class="ci" data-a="ll">Copy lat, long</div>
      <div class="ci" data-a="all">Copy E, N, elev, lat, long</div>
      <div class="ci" data-a="spot">Drop spot elevation here</div>
      <div class="ci" data-a="goto3d">Look here in 3D</div>`;
    cm.style.display = "block";
    /* the menu is positioned against the page, not the map pane (the map now sits
       inside the docked stage, so its origin is not the viewport origin) */
    cm.style.left = Math.max(8, Math.min(e.originalEvent.clientX, window.innerWidth - cm.offsetWidth - 8)) + "px";
    cm.style.top = Math.max(8, Math.min(e.originalEvent.clientY, window.innerHeight - cm.offsetHeight - 8)) + "px";
    cm.onclick = ev => {
      const a = ev.target.dataset.a; cm.style.display = "none";
      if (a === "sp") copyText(`${x.toFixed(1)}, ${y.toFixed(1)}`, "State Plane E, N copied");
      if (a === "ll") copyText(`${la.toFixed(7)}, ${lo.toFixed(7)}`, "lat, long copied");
      if (a === "all") copyText(`E ${x.toFixed(1)} ft, N ${y.toFixed(1)} ft, elev ${isNaN(z) ? "n/a" : z.toFixed(1)} ft, ${la.toFixed(7)}, ${lo.toFixed(7)}`, "coordinates copied");
      if (a === "spot") SBMM.tools.dropSpot(x, y);
      if (a === "goto3d") SBMM.viewer3d.openAt(x, y);
    };
  });
  document.addEventListener("click", () => cm.style.display = "none");
  map.on("movestart zoomstart", () => cm.style.display = "none");

  /* ---------- go-to coordinate ---------- */
  $("gotoBtn").onclick = () => { const b = $("gotoBox"); b.style.display = b.style.display === "flex" ? "none" : "flex"; $("gotoInp").focus(); };
  $("gotoInp").addEventListener("keydown", e => {
    if (e.key === "Escape") { $("gotoBox").style.display = "none"; return; }
    if (e.key !== "Enter") return;
    const p = SBMM.parseCoord($("gotoInp").value);
    if (!p) { toast("couldn't parse — try \"6371500, 2128900\" (SP ft) or \"39.005, -122.66\""); return; }
    const [x, y] = p;
    map.setView([y, x], Math.max(map.getZoom(), 1));
    const [z] = SBMM.elev(x, y);
    const mk = L.circleMarker([y, x], { pane: "drawings", radius: 7, color: "#FFD34D", weight: 2.5, fillColor: "#12181C", fillOpacity: .9 })
      .bindTooltip(`${fmt0(x)}, ${fmt0(y)}${isNaN(z) ? "" : " · " + fmt(z, 1) + " ft"}`, { permanent: true, direction: "top", className: "ctip", offset: [0, -8] })
      .addTo(map);
    setTimeout(() => map.removeLayer(mk), 6000);
    $("gotoBox").style.display = "none";
  });
};
