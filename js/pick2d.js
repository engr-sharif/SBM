/* SBMM Site Explorer — the 2D pick engine (v29): what the pointer is over is
   what the click opens.

   Before this, a hover and a click were answered by different machinery:
     * the map runs `preferCanvas`, so every pane has its own opaque <canvas>
       and the TOPMOST one owns the pointer. js/map.js hands a CLICK down the
       stack to the first canvas or marker with something under it — which is
       the first thing found from the top, not the nearest. A decision-unit
       outline, a sheet footprint or a catchment in a higher pane won the click
       over the well the pointer was actually on.
     * a MOUSEMOVE was only ever handed to other canvases, never to a marker
       element — and the wells, borings, test pits and storm nodes are all
       marker elements under the vectors canvas. So they showed nothing on
       hover, and Leaflet opened their tooltip on the CLICK instead, beside the
       popup: the name and the whole card at once.

   This module is one answer to "what is under the pointer" and both events
   ask it. It gathers every interactive layer within a few pixels — canvas
   vectors from each pane renderer's own draw list, marker elements from a set
   kept by `layeradd` — ranks them, highlights the winner, puts ITS name in a
   chip beside the cursor, and a click then opens exactly that feature through
   Leaflet's own event path (`map._fireDOMEvent`, the call the canvas renderer
   itself makes), so every module's `on("click")` / `bindPopup` keeps working
   unchanged.

   The ranking, and why:
     1. something that DOES something on click (a popup or a click handler)
        beats something that only has a hover tooltip (a survey contour's
        elevation) — the chip must say what the click will do;
     2. geometry: a point beats a line beats a polygon's outline beats a
        polygon's interior; a layer that asked to stay at the back
        (`options.sbmmBack`, the sheet raster hit) is last of all;
     3. then screen distance; between two areas the pointer is inside, the
        SMALLER (a lot's limit of excavation inside its sheet footprint inside
        a parcel); then draw order (the later-drawn wins a tie, as Leaflet's
        own hit test does).

   Where several actionable things are under the pointer the chip says so and
   Tab cycles them; the popup that opens carries an "also here" row naming the
   others, so an overlap is never a dead end.

   Scope — deliberately narrow, so nothing else has to change:
     * NAVIGATE MODE ONLY. Every drawing and measuring tool keeps the map's
       clicks exactly as before; a sketch never loses a vertex to a popup.
     * Hover is mouse and pen. A finger has no hover, but a TAP is resolved the
       same way (with a wider reach), which is where "picked the wrong thing"
       hurts most.
     * Hover tooltips of the layers themselves are suppressed while the engine
       owns navigate mode — the chip IS the tooltip (it renders the layer's own
       tooltip content), so there is one label, not two. Permanent tooltips
       (labels) are untouched.
     * Nothing here reads or writes a layer's style: the highlight is drawn in
       its own non-interactive SVG pane, and a marker's "lift" is a class on its
       icon element. */
"use strict";

SBMM.pick2d = (function () {

  /* reach, in screen px, beyond the symbol itself */
  const REACH = { mouse: 5, pen: 5, touch: 12 };
  const CLICK_SLOP = 4;                       // px of travel that makes a press a drag
  let map = null, chip = null, hl = null, hlRenderer = null;
  let markers = new Set();                    // interactive L.Marker layers on the map
  let cur = null;                             // { list, idx, cx, cy } — the ranked candidates
  let raf = 0, lastMove = null, down = null, enabled = true, lifted = null;
  const stats = { hovers: 0, clicks: 0, cycles: 0, toolClicks: 0 };

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /* ---------- the questions ---------------------------------------------- */
  function active() {
    if (!enabled || !map) return false;
    if (!SBMM.mode || SBMM.mode.current() !== "navigate") return false;
    if (SBMM.tools && SBMM.tools.active && SBMM.tools.active()) return false;
    if (SBMM.draw && SBMM.draw.armed && SBMM.draw.armed()) return false;   // a modify command's base-point pick
    if (document.body.classList.contains("gated")) return false;
    return true;
  }
  /* v30: is a TOOL collecting this click? Every mode but Navigate, plus a
     pick a modify command opened from Navigate. Redline and Edit own their
     clicks outright (the eraser hits a stroke; a mid handle inserts a vertex)
     and are left alone. */
  function toolMode() {
    if (!enabled || !map || !SBMM.mode) return false;
    const m = SBMM.mode.current();
    if (m === "redline" || m === "edit") return false;
    if (m !== "navigate") return true;
    return !!((SBMM.tools && SBMM.tools.active && SBMM.tools.active())
           || (SBMM.draw && SBMM.draw.armed && SBMM.draw.armed()));
  }
  /* MOVE / OFFSET / JOIN … asking "which drawing" (js/cmdline.js pickFeature):
     only the user's own features answer, so a well on top of the line being
     picked cannot take the click */
  const selecting = () => !!(map && map.getContainer().classList.contains("picksel"));
  const pointerKind = () => (SBMM.touch && SBMM.touch.lastPointer && SBMM.touch.lastPointer()) || "mouse";

  /* A layer "acts" on click when it has a popup, or a click listener that is
     not Leaflet's own tooltip-on-click, on itself or on any event parent (the
     store's FeatureGroups listen on the group). */
  const TIP_OPEN = L.Layer.prototype._openTooltip;
  function listensReal(l, type, depth) {
    if (!l || depth > 4) return false;
    const E = l._events && l._events[type];
    if (E) for (const h of E) if (h && h.fn !== TIP_OPEN) return true;
    if (l._eventParents) for (const k in l._eventParents)
      if (listensReal(l._eventParents[k], type, depth + 1)) return true;
    return false;
  }
  const acts = l => !!(l._popup || listensReal(l, "click", 0));
  const tipOf = l => l._tooltip || null;

  /* ---------- candidates ------------------------------------------------- */
  function rendererPanes() {
    const R = map._paneRenderers || {}, out = [];
    for (const k in R) {
      const r = R[k];
      if (!r || !r._drawFirst || !r._container) continue;
      const z = parseInt((r._container.parentNode && r._container.parentNode.style.zIndex) || 0, 10) || 0;
      out.push({ r, z });
    }
    return out;
  }
  function segDist(p, parts) {
    let best = Infinity;
    for (const ring of parts)
      for (let i = 1; i < ring.length; i++) {
        const d = L.LineUtil.pointToSegmentDistance(p, ring[i - 1], ring[i]);
        if (d < best) best = d;
      }
    return best;
  }
  function ringDist(p, parts) {
    /* a polygon's _parts are open rings; close them for the edge distance */
    let best = Infinity;
    for (const ring of parts) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const d = L.LineUtil.pointToSegmentDistance(p, ring[i], ring[(i + 1) % n]);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /* Every interactive thing within reach of layer point `p`, ranked. */
  function candidates(p, reach) {
    const out = [];
    let order = 0;
    for (const { r, z } of rendererPanes()) {
      for (let o = r._drawFirst; o; o = o.next) {
        order++;
        const l = o.layer;
        if (!l || !l.options || !l.options.interactive) continue;
        if (!l._popup && !l._tooltip && !l._events) continue;
        let geo, d;
        if (l instanceof L.CircleMarker) {
          if (!l._point) continue;
          d = Math.max(0, l._point.distanceTo(p) - (l._radius || 0));
          if (d > reach) continue;
          geo = 3;
        } else if (l instanceof L.Polyline) {
          const b = l._pxBounds;
          if (!b || !l._parts || !l._parts.length) continue;
          const w = (l.options.weight || 1) / 2 + reach;
          if (p.x < b.min.x - w || p.x > b.max.x + w || p.y < b.min.y - w || p.y > b.max.y + w) continue;
          if (l instanceof L.Polygon) {
            const edge = ringDist(p, l._parts);
            if (edge <= w) { d = edge; geo = 1.5; }
            else if (l.options.fill !== false && l._containsPoint(p)) { d = 0; geo = 1; }
            else continue;                        // an unfilled outline answers on its edge only
          } else {
            d = segDist(p, l._parts);
            if (d > w) continue;
            geo = 2;
          }
        } else continue;
        if (l.options.sbmmBack) geo = 0;
        /* nested areas: the smallest one the pointer is inside is the most
           specific answer — a lot inside a sheet footprint inside a parcel */
        const bb = l._pxBounds;
        const area = bb ? (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) : 0;
        out.push({ layer: l, d, geo, z, order, area, acts: acts(l), el: null });
      }
    }
    for (const m of markers) {
      if (!m._map || !m._icon || m.options.interactive === false) continue;
      if (m._icon.style.display === "none" || m._icon.style.visibility === "hidden") continue;
      const q = map.latLngToLayerPoint(m.getLatLng());
      const sz = (m.options.icon && m.options.icon.options && m.options.icon.options.iconSize) || [12, 12];
      const half = Math.max(4, (Array.isArray(sz) ? Math.max(sz[0], sz[1]) : sz.x || 12) / 2);
      const d = Math.max(0, q.distanceTo(p) - half);
      if (d > reach) continue;
      const pane = m._icon.parentNode;
      const z = parseInt((pane && pane.style.zIndex) || 600, 10) || 600;
      out.push({ layer: m, d, geo: 3, z, order: 1e9, area: 0, acts: acts(m), el: m._icon });
    }
    out.sort((a, b) => (b.acts - a.acts) || (b.geo - a.geo) || (a.d - b.d)
      || (a.geo === 1 ? a.area - b.area : 0) || (b.z - a.z) || (b.order - a.order));
    /* one entry per feature: a feature drawn as two layers (a DU in two parts
       shares a name, a store feature is a group) collapses to its best part */
    const seen = new Set(), uniq = [];
    for (const c of out) {
      const key = labelKey(c.layer);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      uniq.push(c);
    }
    return uniq;
  }

  /* ---------- what a candidate is called --------------------------------- */
  function tipHtml(l) {
    const t = tipOf(l);
    if (!t) return "";
    let c = t._content;
    try { if (typeof c === "function") c = c(l); } catch (e) { c = ""; }
    if (c && c.nodeType) return c.outerHTML || c.textContent || "";
    return c == null ? "" : String(c);
  }
  function plainName(l) {
    const h = tipHtml(l);
    if (h) {
      const d = document.createElement("div");
      d.innerHTML = h;
      const b = d.querySelector("b");
      /* a name, not an instruction: "C-203 … · click to open the sheet" and
         "C-203 — open the full sheet" both name the sheet */
      const t = (b ? b.textContent : d.textContent).replace(/\s+/g, " ").trim()
        .replace(/\s*(?:·|—|-)\s*(?:click|open)\b[^·]*$/i, "").trim();
      if (t) return t;
    }
    /* the user's own features carry no tooltip: name them from the store */
    const f = storeFeature(l);
    if (f) return (f.name || f.type || "feature") + (f.type ? " · " + f.type : "");
    const pp = l.feature && l.feature.properties;
    const n = (pp && (pp.name || pp.id)) || (l.options && l.options.title) || popupName(l);
    return n || "feature";
  }
  /* the last resort before "feature": the popup's own heading. Every popup
     builder in js/popups.js opens on the feature's name in <b> */
  function popupName(l) {
    const P = l._popup;
    if (!P) return "";
    let c = P._content;
    try { if (typeof c === "function") c = c(l); } catch (e) { return ""; }
    if (!c) return "";
    const d = document.createElement("div");
    if (c.nodeType) d.appendChild(c.cloneNode(true)); else d.innerHTML = String(c);
    const b = d.querySelector("b");
    return b ? b.textContent.replace(/\s+/g, " ").trim() : "";
  }
  function storeFeature(l) {
    const F = SBMM.store && SBMM.store.features;
    if (!F || !F.length) return null;
    const cands = [l];
    if (l._eventParents) for (const k in l._eventParents) cands.push(l._eventParents[k]);
    for (const f of F) if (f.layer && cands.includes(f.layer)) return f;
    return null;
  }
  function labelKey(l) {
    /* the parts of one user feature are children of one FeatureGroup that owns
       the click (js/tools.js) — one entry for the feature, not one per part */
    if (!l._eventParents) return null;
    for (const k in l._eventParents) {
      const g = l._eventParents[k];
      if (g && g._events && g._events.click && listensReal(g, "click", 3)) return "g" + k;
    }
    return null;
  }

  /* ---------- the chip and the highlight --------------------------------- */
  function stage() { return document.getElementById("stage") || map.getContainer().parentNode; }
  function ensureChip() {
    if (chip) return chip;
    chip = document.createElement("div");
    chip.id = "pickTip";
    chip.setAttribute("role", "status");
    chip.hidden = true;
    stage().appendChild(chip);
    return chip;
  }
  function chipBody(c, n, idx) {
    const h = tipHtml(c.layer);
    let body;
    if (h && /<[a-z]/i.test(h)) body = `<div class="pkrich">${h}</div>`;
    else {
      const txt = h || plainName(c.layer);
      const i = txt.indexOf(" · ");
      body = i > 0
        ? `<b>${esc(txt.slice(0, i))}</b><span class="pkkind">${esc(txt.slice(i + 3))}</span>`
        : `<b>${esc(txt)}</b>`;
    }
    const more = n > 1 ? `<span class="pkmore">${idx + 1} of ${n} here · Tab</span>` : "";
    return body + more;
  }
  function placeChip(cx, cy) {
    if (!chip || chip.hidden) return;
    const S = stage().getBoundingClientRect();
    let x = cx - S.left + 16, y = cy - S.top + 14;
    const w = chip.offsetWidth, h = chip.offsetHeight;
    if (x + w > S.width - 6) x = cx - S.left - w - 14;
    if (y + h > S.height - 6) y = cy - S.top - h - 12;
    chip.style.transform = `translate(${Math.round(Math.max(4, x))}px,${Math.round(Math.max(4, y))}px)`;
  }
  function showChip(c, n, idx, cx, cy) {
    ensureChip();
    chip.innerHTML = chipBody(c, n, idx);
    chip.classList.toggle("info", !c.acts);
    chip.hidden = false;
    placeChip(cx, cy);
  }
  function hideChip() { if (chip) chip.hidden = true; }

  function ensureHl() {
    if (hl) return hl;
    if (!map.getPane("pickhl")) {
      map.createPane("pickhl");
      map.getPane("pickhl").style.zIndex = 480;
      map.getPane("pickhl").style.pointerEvents = "none";
    }
    hlRenderer = L.svg({ pane: "pickhl", padding: 0.2 });
    hl = L.layerGroup().addTo(map);
    return hl;
  }
  function clearHl() {
    if (hl) hl.clearLayers();
    if (lifted) { lifted.classList.remove("pklift"); lifted = null; }
  }
  function drawHl(c) {
    clearHl();
    const l = c.layer;
    if (c.el) { c.el.classList.add("pklift"); lifted = c.el; return; }
    ensureHl();
    const opt = { renderer: hlRenderer, pane: "pickhl", interactive: false };
    if (l instanceof L.CircleMarker) {
      L.circleMarker(l.getLatLng(), Object.assign({}, opt, {
        radius: (l._radius || 4) + 4, color: "#FFE9A8", weight: 2.5, fill: false, className: "pkring"
      })).addTo(hl);
    } else if (l instanceof L.Polyline) {
      const ll = l.getLatLngs();
      const w = l.options.weight || 1;
      const Ctor = l instanceof L.Polygon ? L.polygon : L.polyline;
      Ctor(ll, Object.assign({}, opt, { color: "#0B1013", weight: w + 6, opacity: .55, fill: false })).addTo(hl);
      Ctor(ll, Object.assign({}, opt, {
        color: "#FFE9A8", weight: Math.max(2, w + 1.5), opacity: .95, fill: l instanceof L.Polygon,
        fillColor: "#FFE9A8", fillOpacity: l instanceof L.Polygon ? .08 : 0, className: "pkline"
      })).addTo(hl);
    }
  }

  /* ---------- hover ------------------------------------------------------ */
  function onMove(ev) {
    lastMove = ev;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; hover(lastMove); });
  }
  function overChrome(t) {
    return !!(t && t.closest && t.closest(".leaflet-popup, .leaflet-control, .leaflet-tooltip-pane"));
  }
  /* v35 — a hover tooltip a layer opened while the engine stood aside (Edit,
     Redline, the gate) never hears its mouseout once the engine owns the
     pointer again, and stayed on the map for good: a contour's "1,344.0 ft"
     floating over nothing. Every non-permanent tooltip that opens is tracked
     and closed the next time the engine or a tool owns a pointer move. */
  const hoverTips = new Set();
  function closeStaleTips() {
    if (!hoverTips.size || !(active() || toolMode())) return;
    for (const t of [...hoverTips]) {
      hoverTips.delete(t);
      try { if (t._source && t._source.closeTooltip) t._source.closeTooltip(); else map.closeTooltip(t); } catch (e) {}
    }
  }
  function hover(ev) {
    closeStaleTips();
    if (!ev || !active() || ev.buttons || pointerKind() === "touch" || overChrome(ev.target)
        || map._animatingZoom || (map.dragging && map.dragging.moving())) { clear(); return; }
    const p = map.mouseEventToLayerPoint(ev);
    let list = candidates(p, REACH[pointerKind()] || 5);
    if (selecting()) list = list.filter(c => storeFeature(c.layer));
    stats.hovers++;
    if (!list.length) { clear(); return; }
    /* keep the Tab choice while the pointer stays over the same set */
    let idx = 0;
    if (cur && cur.list.length === list.length && cur.list[cur.idx]
        && list.some(c => c.layer === cur.list[cur.idx].layer)) {
      idx = list.findIndex(c => c.layer === cur.list[cur.idx].layer);
    }
    const nAct = list.filter(c => c.acts).length;
    const top = list[idx];
    const changed = !cur || !cur.list[cur.idx] || cur.list[cur.idx].layer !== top.layer;
    cur = { list, idx, cx: ev.clientX, cy: ev.clientY };
    /* the feature whose popup is already open needs no second label */
    const P = map._popup;
    const shown = P && P.isOpen && P.isOpen() && P._source === top.layer;
    if (shown) hideChip();
    if (changed) { drawHl(top); if (!shown) showChip(top, Math.max(nAct, 1), top.acts ? idx : 0, ev.clientX, ev.clientY); }
    else if (!shown) { if (chip && chip.hidden) showChip(top, Math.max(nAct, 1), top.acts ? idx : 0, ev.clientX, ev.clientY); else placeChip(ev.clientX, ev.clientY); }
    map.getContainer().classList.toggle("pkhot", !!top.acts);
  }
  function clear() {
    if (!cur && !lifted && !(chip && !chip.hidden)) return;
    cur = null;
    clearHl();
    hideChip();
    if (map) map.getContainer().classList.remove("pkhot");
  }
  function cycle(step) {
    if (!cur) return false;
    const acting = cur.list.filter(c => c.acts);
    if (acting.length < 2) return false;
    const now = acting.indexOf(cur.list[cur.idx]);
    const next = acting[(now + step + acting.length) % acting.length];
    cur.idx = cur.list.indexOf(next);
    drawHl(next);
    showChip(next, acting.length, acting.indexOf(next), cur.cx, cur.cy);
    stats.cycles++;
    return true;
  }

  /* ---------- click ------------------------------------------------------ */
  function fireAt(l, ev) {
    /* A fresh MouseEvent with no target: `_findEventTargets` then finds no
       DOM target of its own, so the layer (and, as Leaflet always does, the
       map after it) are the only receivers — never a second layer the real
       event happened to land on. */
    const e = new MouseEvent("click", { bubbles: false, cancelable: true,
      clientX: ev.clientX, clientY: ev.clientY, screenX: ev.screenX, screenY: ev.screenY,
      button: 0, shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, altKey: ev.altKey, metaKey: ev.metaKey });
    map._fireDOMEvent(e, "click", [l]);
  }
  function onDown(ev) { down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; }
  /* v30: a click a TOOL is collecting goes to the tool — never to a feature
     under it. Before this every sketch and pick tool lost its click to the
     well, the sample or the outline it was aimed at: the feature's popup
     opened and the tool collected nothing, so a distance could not be
     measured TO a well at all. The click becomes a plain map click at the
     pointer, and js/draw.js resolves it through the snap engine — which
     puts the vertex on the well head exactly, and says so. */
  function toolClick(ev) {
    if (overChrome(ev.target)) return false;
    if (ev.target && ev.target.closest && ev.target.closest(".vtx")) return false;   // the sketch's own handles
    if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_SLOP) return false;
    if (SBMM.touch && SBMM.touch.clickSwallowed && SBMM.touch.clickSwallowed()) return false;
    ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
    const latlng = map.mouseEventToLatLng(ev);
    stats.toolClicks++;
    map.fire("click", { latlng, layerPoint: map.latLngToLayerPoint(latlng),
                        containerPoint: map.latLngToContainerPoint(latlng), originalEvent: ev });
    return true;
  }
  function onClick(ev) {
    if (ev.__sbmmFwd) return false;
    if (toolMode()) return toolClick(ev);
    if (!active() || overChrome(ev.target)) return false;
    if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_SLOP) return false;
    if (SBMM.touch && SBMM.touch.clickSwallowed && SBMM.touch.clickSwallowed()) return false;
    const p = map.mouseEventToLayerPoint(ev);
    const kind = pointerKind();
    let list = candidates(p, REACH[kind] || 5).filter(c => c.acts);
    if (selecting()) list = list.filter(c => storeFeature(c.layer));
    if (!list.length) { clear(); return false; }
    /* the one the chip is showing (a Tab choice included) — but only if the
       chip was computed HERE. A click can land before the hover has caught up
       with a jump of the pointer, and the chip then still names what was under
       the PREVIOUS position; honouring that sent a click on a lot to the sheet
       footprint the pointer had just left. */
    let pick = list[0];
    if (cur && cur.list[cur.idx] && Math.hypot(ev.clientX - cur.cx, ev.clientY - cur.cy) <= 3) {
      const same = list.find(c => c.layer === cur.list[cur.idx].layer);
      if (same) pick = same;
    }
    ev.stopPropagation(); ev.stopImmediatePropagation(); ev.preventDefault();
    stats.clicks++;
    const others = list.filter(c => c !== pick).slice(0, 6);
    const pt = { clientX: ev.clientX, clientY: ev.clientY, screenX: ev.screenX, screenY: ev.screenY };
    open(pick.layer, pt, others);
    hideChip();
    return true;
  }
  function open(l, pt, others) {
    let opened = null;
    const grab = e => { opened = e.popup; };
    map.on("popupopen", grab);
    try { fireAt(l, pt); } finally { map.off("popupopen", grab); }
    if (opened && others && others.length && !document.body.classList.contains("field")) alsoHere(opened, others, pt, l);
    return opened;
  }
  /* "also here" — the other actionable things under the same click */
  function alsoHere(popup, others, pt, self) {
    const node = popup._contentNode;
    if (!node) return;
    /* one button per name: a sheet is both a footprint and a raster hit */
    const names = new Set([self ? plainName(self) : ""]);
    others = others.filter(c => { const n = plainName(c.layer); if (names.has(n)) return false; names.add(n); return true; });
    if (!others.length) return;
    const selfLayer = self;
    const bar = document.createElement("div");
    bar.className = "pkalso";
    bar.innerHTML = `<span class="pkalsoh">Also here</span>` + others.map((c, i) =>
      `<button type="button" data-pk="${i}" title="${esc(plainName(c.layer))}">${esc(plainName(c.layer))}</button>`).join("");
    node.appendChild(bar);
    bar.addEventListener("click", e => {
      const b = e.target.closest("button[data-pk]");
      if (!b) return;
      e.stopPropagation();
      const c = others[+b.dataset.pk];
      map.closePopup();
      /* the one being left stays in the row, so the user can come back */
      setTimeout(() => open(c.layer, pt, [{ layer: selfLayer }].concat(others.filter(o => o !== c))), 0);
    });
    /* NOT popup.update(): a popup bound to a function re-renders its content
       there and the row is gone. Re-measure and re-place what is there. */
    if (popup._updateLayout) popup._updateLayout();
    if (popup._updatePosition) popup._updatePosition();
    if (popup._adjustPan) try { popup._adjustPan(); } catch (e) { /* off-screen is fine */ }
  }

  /* ---------- keys: Tab cycles what the chip is showing ------------------ */
  function onKey(e) {
    if (e.key !== "Tab" || !cur || !chip || chip.hidden) return;
    const a = document.activeElement;
    if (a && a !== document.body && !map.getContainer().contains(a)) return;
    if (cycle(e.shiftKey ? -1 : 1)) { e.preventDefault(); e.stopPropagation(); }
  }

  /* ---------- wiring ----------------------------------------------------- */
  function track(e) {
    const l = e.layer;
    if (l instanceof L.Marker && !(l.options && l.options.interactive === false)) markers.add(l);
  }
  function untrack(e) { markers.delete(e.layer); if (cur && cur.list.some(c => c.layer === e.layer)) clear(); }

  function wire() {
    map = SBMM.map;
    if (!map) return;
    map.eachLayer(l => track({ layer: l }));
    map.on("layeradd", track);
    map.on("layerremove", untrack);
    const box = map.getContainer();
    box.addEventListener("mousemove", onMove, { passive: true });
    box.addEventListener("pointerdown", onDown, true);
    box.addEventListener("mouseleave", clear);
    map.on("movestart zoomstart popupopen", clear);
    map.on("tooltipopen", e => { if (e.tooltip && !e.tooltip.options.permanent) hoverTips.add(e.tooltip); });
    map.on("tooltipclose", e => { if (e.tooltip) hoverTips.delete(e.tooltip); });
    document.addEventListener("keydown", onKey, true);
    if (SBMM.events) SBMM.events.on("mode", () => { if (!active()) clear(); });

    /* The layers' own hover tooltips give way to the chip while the engine
       owns navigate mode: one label, not two. A permanent tooltip is a label
       and opens through `add`, which this leaves alone. */
    /* It has to be `openTooltip`, not `_openTooltip`: every layer bound its
       hover handler to the ORIGINAL `_openTooltip` when `bindTooltip` ran, so
       replacing that later reaches nothing — but the handler calls
       `this.openTooltip()`, which is looked up at call time. */
    const OPEN = L.Layer.prototype.openTooltip;
    L.Layer.prototype.openTooltip = function (ll) {
      /* and in a tool mode too: the snap glyph names what the vertex will
         land on, and a layer's tooltip beside it is a second, different label */
      if (this._tooltip && !this._tooltip.options.permanent && (active() || toolMode())) return this;
      return OPEN.call(this, ll);
    };
  }

  /* for the harness: the ranked list at a map latlng, as plain data */
  function probe(latlng, kind) {
    if (!map) return [];
    const p = map.latLngToLayerPoint(latlng);
    return candidates(p, REACH[kind || "mouse"]).map(c => ({
      name: plainName(c.layer), acts: c.acts, geo: c.geo, d: +c.d.toFixed(2), marker: !!c.el
    }));
  }
  function state() {
    return { active: active(), chip: !!(chip && !chip.hidden), chipText: chip && !chip.hidden ? chip.textContent : "",
             target: cur && cur.list[cur.idx] ? plainName(cur.list[cur.idx].layer) : null,
             n: cur ? cur.list.filter(c => c.acts).length : 0, markers: markers.size, stats: Object.assign({}, stats) };
  }

  return { wire, onClick, onDown, candidates, probe, state, clear, cycle, nameOf: plainName,
           setEnabled: v => { enabled = !!v; if (!enabled) clear(); } };
})();
