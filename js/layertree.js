/* SBMM Site Explorer — the layer TREE (v16).

   `SBMM.layerState` (js/layerstate.js) is, and stays, the one answer to "is this
   layer on". This file is the VIEW of it: the thing a user reads, searches,
   reorders and hands to somebody else. Nothing here owns visibility — every
   toggle in this file ends in `SBMM.layerState.set` or in a real click on the
   row's own checkbox, and every module still registers its rows through
   `SBMM.addLayerRow` exactly as it did before v16.

   What it adds over the six flat sections it grew out of:

     - real sub-groups. A module declares one with `addLayerRow(group, label,
       layer, { sub: "Storm drainage — EA CAD + Jacobs survey" })`; the tree
       builds the container, the collapsible header and the count. The five
       modules that used to append an ad-hoc `.lsub` div and then let the rows
       fall in underneath it now pass `sub:` instead, which is the whole of
       their diff. The header keeps the class `.lsub` it always had.
     - a legend swatch drawn from the layer's REAL symbology — the colour, the
       weight and the dash pattern Leaflet was given — rather than a coloured
       square somebody typed beside it. A row whose geometry is a line looks
       like a line, a polygon like a polygon, a raster like a raster.
     - a hover toolbar per row: opacity, zoom to extent, solo, info.
     - drag to reorder, and the order IS the draw order (see applyDrawOrder).
     - fuzzy search, keyboard navigation, presets, recently-changed chips, and
       a legend card on the map.

   Three rules this file must not break, each of them a scar:

     1. THE CULTURAL GATE. js/cultural.js intercepts the checkbox's `click` in
        the CAPTURE phase and refuses it until the acknowledgement is accepted.
        So every switch this file offers that could turn a cultural row ON goes
        through `row.cb.click()` — never `layerState.set` — and the bulk paths
        (solo, presets, group all-on/all-off) skip the cultural group outright.
        A preset that quietly put protected geometry on the map would be the
        worst bug in the app.
     2. THE COUNT-BADGE OBSERVER. `SBMM.layersUI.refreshCounts` runs from a
        MutationObserver over the whole pane. Anything this file writes into a
        row must therefore be idempotent and must not be written from inside a
        `layers` handler without a guard, or the observer feeds itself.
     3. `.lsub` was already taken (js/designgis.js uses it for a sub-header) and
        `.lsub`-vs-`.lgsub` cost a boot hang once. The sub-group container is
        `.lgsub`, its body `.lgsubb`, its header `.subh.subtoggle` — the exact
        markup the Terrain-analysis sub-section has always used, so
        `refreshCounts` and js/layers.js's collapse wiring pick it up unchanged.

   Draw order deserves its own note, because it is the one place where reading
   the tree top-down has a consequence on the map. See applyDrawOrder.        */
"use strict";

SBMM.layerTree = (function () {

  const STORE = "sbmm.layertree.v1";

  /* open: {key -> bool} for groups ("base") and sub-groups ("sub:framework|Storm…")
     order: {containerKey -> [layerId]}  — see applyDrawOrder
     presets: {name -> snapshot}
     legend: {open: bool}                                                    */
  let S = { open: {}, order: {}, presets: {}, legend: { open: false } };
  let wired = false;
  let uid = 0;

  const refs = new Map();          // "group/id" -> row ref
  const subEls = new Map();        // containerKey -> the .lgsub element
  const recent = [];               // ["group/id", …] most recent first, max 5

  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(STORE) || "null");
      if (o && typeof o === "object") {
        S.open = o.open || {};
        S.order = o.order || {};
        S.presets = o.presets || {};
        S.legend = o.legend || { open: false };
      }
    } catch (e) { /* file://, private window */ }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* file:// */ }
  }
  load();

  /* ------------------------------------------------------------------ */
  /* open / closed state — one store for groups AND sub-groups            */
  /* ------------------------------------------------------------------ */
  /* js/layers.js's section wiring reads and writes through here, so "the tree
     remembers what you had open" is one record rather than two. */
  function openState(key, val) {
    if (val === undefined) return S.open[key];
    S.open[key] = !!val; save();
    return S.open[key];
  }

  /* ------------------------------------------------------------------ */
  /* sub-groups                                                          */
  /* ------------------------------------------------------------------ */
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 40) || "sub";

  function containerKey(el) {
    if (!el) return "";
    if (el.classList && el.classList.contains("lgsubb"))
      return el.parentNode.dataset.subkey || "";
    return "#" + (el.id || "");
  }

  /* Called by SBMM.addLayerRow before it appends the row: hands back the
     element the row belongs in. With no `sub:` that is the module's own host
     div, exactly as before. */
  function hostFor(host, opts) {
    if (!host || !opts || !opts.sub) return host;
    const key = (host.id || "?") + "|" + opts.sub;
    if (subEls.has(key)) return subEls.get(key).querySelector(".lgsubb");
    const wrap = document.createElement("div");
    wrap.className = "lgsub ltsub";
    wrap.dataset.sub = slug(opts.sub);
    wrap.dataset.subkey = key;
    /* `.lsub` on the header keeps every selector that ever asked "is there a
       sub-heading called Storm drainage in this group" answering yes. */
    wrap.innerHTML =
      `<div class="subh subtoggle lsub" role="button" tabindex="0" aria-expanded="true"` +
      (opts.subTitle ? ` title="${esc(opts.subTitle)}"` : "") + `>` +
      `<span class="caret"></span>${esc(opts.sub)}<span class="lcount mono subcount"></span></div>` +
      `<div class="lgsubb"></div>`;
    host.appendChild(wrap);
    subEls.set(key, wrap);
    wireSub(wrap);
    return wrap.querySelector(".lgsubb");
  }

  /* Terrain analysis starts closed and always has (ruling F3): six rows plus
     five legends plus three controls, open by default, pushed Site framework off
     the bottom of the dock. Everything else starts open. */
  const SUB_CLOSED_BY_DEFAULT = { analysis: true };

  function wireSub(wrap) {
    const h = wrap.querySelector(".subtoggle");
    const key = "sub:" + wrap.dataset.subkey;
    const set = open => {
      wrap.classList.toggle("closed", !open);
      h.setAttribute("aria-expanded", open ? "true" : "false");
    };
    set(S.open[key] === undefined ? !SUB_CLOSED_BY_DEFAULT[wrap.dataset.sub] : !!S.open[key]);
    const toggle = () => { const open = wrap.classList.contains("closed"); set(open); openState(key, open); };
    h.onclick = e => {
      /* the header carries its own controls — "isopach…", "all 20 sheets…",
         "add dataset…" — and those are not a collapse gesture */
      if (e && e.target && e.target.closest && e.target.closest(".minib")) return;
      toggle();
    };
    h.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  }

  /* ------------------------------------------------------------------ */
  /* the legend swatch — drawn from what Leaflet was actually given       */
  /* ------------------------------------------------------------------ */
  /* Walk the row's layer for the first thing that can describe itself, and
     draw that: a polyline in its colour, weight and dash; a polygon with its
     fill; a point at its radius; a raster as a band. A row with no layer at
     all (the My-work class masks, the 3D drape switch) gets the mask glyph. */
  function probe(layer, depth) {
    if (!layer || depth > 3) return null;
    if (layer.getUrl && layer.getBounds) return { kind: "raster" };
    if (layer.eachLayer) {
      let found = null, n = 0;
      layer.eachLayer(l => { if (found || n++ > 60) return; found = probe(l, depth + 1); });
      return found;
    }
    const o = layer.options || {};
    if (layer.getLatLngs) {
      const closed = !!(layer._latlngs && (o.fill || layer instanceof L.Polygon));
      return { kind: closed ? "poly" : "line", color: o.color, weight: o.weight,
               dash: o.dashArray, fill: o.fillColor || o.color, fillOpacity: o.fillOpacity,
               opacity: o.opacity };
    }
    if (layer.getLatLng) {
      return { kind: "point", color: o.fillColor || o.color, ring: o.color,
               radius: o.radius, marker: !layer.setStyle };
    }
    return null;
  }

  function svgFor(ref, idSuffix) {
    const rec = SBMM.layerState.rec(ref.group, ref.id);
    const base = (rec && rec.swatch) || "#8FA3AE";
    const p = probe(ref.layer, 0) || (ref.layer ? null : { kind: "mask" });
    const k = p ? p.kind : "chip";
    const col = (p && p.color) || base;
    const a = [`<svg class="ltswg" viewBox="0 0 16 12" aria-hidden="true">`];
    if (k === "line") {
      const w = Math.max(1.2, Math.min(3, p.weight || 1.5));
      a.push(`<path d="M1 9.4 5 4.6 9.6 8 15 2.6" fill="none" stroke="${esc(col)}" stroke-width="${w}"` +
             (p.dash ? ` stroke-dasharray="${esc(p.dash)}"` : "") +
             ` stroke-linecap="round" stroke-linejoin="round" opacity="${p.opacity == null ? 1 : p.opacity}"/>`);
    } else if (k === "poly") {
      a.push(`<path d="M1.6 9.6 3.4 2.6 12.2 2 14.4 9.8Z" fill="${esc(p.fill || col)}" ` +
             `fill-opacity="${p.fillOpacity == null ? 0.18 : Math.max(0.14, p.fillOpacity)}" ` +
             `stroke="${esc(col)}" stroke-width="${Math.max(1, Math.min(2.4, p.weight || 1.6))}"` +
             (p.dash ? ` stroke-dasharray="${esc(p.dash)}"` : "") + `/>`);
    } else if (k === "point") {
      const r = Math.max(2.4, Math.min(4.2, p.radius || 3.4));
      a.push(`<circle cx="8" cy="6" r="${r}" fill="${esc(col)}" stroke="${esc(p.ring || "#0D1215")}" stroke-width="1"/>`);
    } else if (k === "raster") {
      /* a DETERMINISTIC id: a counter here would make every repaint a real DOM
         write, and every DOM write in the Layers pane wakes the count-badge
         MutationObserver (rule 2) */
      const id = "ltg_" + ref.group + "_" + ref.id + (idSuffix || "");
      a.push(`<defs><linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${esc(base)}" stop-opacity=".25"/>` +
             `<stop offset="1" stop-color="${esc(base)}" stop-opacity=".95"/></linearGradient></defs>` +
             `<rect x="1" y="1.6" width="14" height="8.8" rx="1.5" fill="url(#${id})" stroke="${esc(base)}" stroke-opacity=".5"/>`);
    } else if (k === "mask") {
      a.push(`<rect x="1.6" y="2" width="12.8" height="8" rx="2" fill="${esc(base)}" fill-opacity=".28" ` +
             `stroke="${esc(base)}" stroke-width="1.2" stroke-dasharray="2.4 1.8"/>`);
    } else {
      a.push(`<rect x="2.4" y="2" width="11.2" height="8" rx="2" fill="${esc(base)}"/>`);
    }
    a.push(`</svg>`);
    return { html: a.join(""), kind: k, color: col };
  }

  function paintSwatch(ref) {
    const el = ref.row.querySelector(".ltsw");
    if (!el) return;
    const s = svgFor(ref);
    if (el.dataset.sig === s.html) return;           // idempotent: rule 2
    el.dataset.sig = s.html;
    el.innerHTML = s.html;
    el.dataset.kind = s.kind;
  }

  /* ------------------------------------------------------------------ */
  /* a row                                                               */
  /* ------------------------------------------------------------------ */
  const CRS_NOTE = "EPSG:6418 — NAD83(2011) California State Plane zone 2, US survey feet";

  /* A row that registers AFTER the stored order was applied (a module that
     builds its rows late in boot, or after a reload under load) has never been
     ordered: applyStoredOrder ran once, and nothing re-ran it. So every
     registration into a container the user has ordered re-applies the order,
     debounced to one pass per burst. This was the "9z flake": the tree's
     draw-order assertion after a reload measured with one row not yet
     registered, and no later event ever put it in its place. */
  let orderTimer = 0;
  function orderSoon() {
    if (!Object.keys(S.order).length) return;
    clearTimeout(orderTimer);
    orderTimer = setTimeout(() => { orderTimer = 0; try { applyStoredOrder(); } catch (e) {} }, 60);
  }

  function onRow(ref, opts) {
    refs.set(ref.group + "/" + ref.id, ref);
    orderSoon();
    const row = ref.row;
    row.dataset.lsub = (opts && opts.sub) || "";
    row.dataset.uigroup = ref.uiGroup || "";
    row.tabIndex = 0;
    row.classList.add("ltrow");

    /* the drag grip: a pointer target of its own, so a drag never reads as a
       click on the label (which would toggle the layer) */
    const grip = document.createElement("span");
    grip.className = "ltgrip";
    grip.title = "Drag to reorder — the order here is the draw order";
    grip.innerHTML = "<i></i><i></i>";
    grip.addEventListener("pointerdown", e => beginDrag(e, ref));
    grip.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); });
    row.insertBefore(grip, row.firstChild);

    /* the real symbology, in front of the flat colour chip addLayerRow made.
       The chip stays in the DOM: js/datasets.js writes its background when a
       dataset is restyled, and removing it would make that a silent no-op. */
    const sw = document.createElement("span");
    sw.className = "ltsw";
    const chip = row.querySelector(".sw");
    row.insertBefore(sw, chip || row.querySelector(".lbl"));
    paintSwatch(ref);

    /* a trailing "(140)" is a count, not part of the name: same characters, own
       element, monospace, and it survives the label's ellipsis */
    const lbl = row.querySelector(".lbl");
    if (lbl && !lbl.children.length) {
      const m = lbl.textContent.match(/^(.*?)(\s\(\d[\d,]*\))$/);
      if (m) {
        lbl.textContent = m[1];
        const n = document.createElement("span");
        n.className = "ltn mono";
        n.textContent = m[2];
        lbl.after(n);
      }
    }

    /* the hover toolbar */
    const acts = document.createElement("span");
    acts.className = "ltacts";
    /* the glyphs come from CSS `content`, not from a text node: a row's
       textContent is read by several harnesses and by the legend, and a toolbar
       that appended four characters to every layer name would quietly change
       what all of them see */
    acts.innerHTML =
      `<button type="button" class="ltb" data-a="opacity" aria-label="Opacity" title="Opacity"></button>` +
      `<button type="button" class="ltb" data-a="zoom" aria-label="Zoom to this layer" title="Zoom to this layer"></button>` +
      `<button type="button" class="ltb" data-a="solo" aria-label="Solo" title="Solo — everything else in this group off (alt-click the tick box does the same)"></button>` +
      `<button type="button" class="ltb" data-a="info" aria-label="What is this layer?" title="What is this layer?"></button>`;
    acts.addEventListener("click", e => {
      const b = e.target.closest(".ltb");
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const a = b.dataset.a;
      if (a === "opacity") opacityPop(ref, b);
      else if (a === "zoom") zoomTo(ref.group, ref.id);
      else if (a === "solo") solo(ref.group, ref.id);
      else infoPop(ref, b);
    });
    row.appendChild(acts);

    /* v17 §5: hover has no touch equivalent, so under `body.touch` the toolbar
       hides behind a visible "..." at the end of the row and this button opens
       it. The button carries no text — a row's `textContent` is read by several
       harnesses and by the legend, and the four toolbar glyphs are CSS
       `content` for exactly that reason. It is in the DOM in every profile
       (`display:none` off touch) so the tree does not have to be rebuilt when
       an iPad is put into Split View and back. */
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ltmore";
    more.setAttribute("aria-label", "Row actions");
    more.title = "Row actions — opacity, zoom to this layer, solo, what is this?";
    more.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const wasOpen = row.classList.contains("ltopen");
      /* one row at a time: two open toolbars on a narrow dock overlap */
      for (const r of document.querySelectorAll(".lyr.ltopen")) r.classList.remove("ltopen");
      row.classList.toggle("ltopen", !wasOpen);
    });
    row.appendChild(more);

    /* alt-click on the tick box = solo. Registered here, which is BEFORE
       js/cultural.js registers its capture-phase gate on the same element, so
       a plain click still reaches the gate untouched. */
    ref.cb.addEventListener("click", e => {
      if (!e.altKey) return;
      e.preventDefault(); e.stopPropagation();
      ref.cb.checked = SBMM.layerState.isOn(ref.group, ref.id);
      solo(ref.group, ref.id);
    }, true);

    if (wired) { applyFilter(); legendSoon(); }
  }

  /* ------------------------------------------------------------------ */
  /* drag to reorder — and what the order means                          */
  /* ------------------------------------------------------------------ */
  /* Order is DRAW ORDER: the row at the top of a container is drawn on top of
     the rows below it. It is applied by calling `bringToFront` from the bottom
     of the list upwards, so the top row is the last one brought forward.

     It is applied ONLY to a container the user has actually reordered. The
     app's existing z-order is deliberate — the three orthophotos carry explicit
     `zIndex` options, the sheet click rectangles call `bringToBack()` on add so
     only empty ground opens a drawing, and every pane has its own band — and a
     blanket bringToFront pass at boot would silently undo all of it for no
     gain. Reordering is a thing the user does; until he does it, this file
     touches nothing. A layer that must stay at the back of its own group says
     so with `options.sbmmBack` and is put back rather than brought forward. */
  let drag = null;

  function beginDrag(e, ref) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const row = ref.row, cont = row.parentNode;
    /* Terrain analysis interleaves each row with its own legend and its own
       controls (js/analysis.js, js/trees.js append them as siblings), so moving
       the rows there would leave every legend under the wrong layer. Refuse it,
       out loud — a grip that does nothing is worse than one that says why. */
    if (cont.querySelector(":scope > .legend, :scope > .genrow")) {
      toast("these rows carry their own legend and controls — they cannot be reordered");
      return;
    }
    drag = { row, cont, moved: false };
    row.classList.add("ltdragging");
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    const move = ev => {
      const y = ev.clientY;
      for (const other of [...cont.children]) {
        if (other === row || !other.classList.contains("lyr")) continue;
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const rowAfter = !!(other.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (y < mid && rowAfter) { cont.insertBefore(row, other); drag.moved = true; break; }
        if (y > mid && !rowAfter) { cont.insertBefore(row, other.nextSibling); drag.moved = true; break; }
      }
    };
    const up = () => {
      row.classList.remove("ltdragging");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (drag && drag.moved) {
        const key = containerKey(cont);
        S.order[key] = [...cont.children].filter(c => c.classList.contains("lyr"))
          .map(c => c.dataset.lgroup + "/" + c.dataset.lid);
        save();
        applyDrawOrder(ref.group);
        legendSoon();
      }
      drag = null;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function containersOf(gid) {
    const out = [];
    document.querySelectorAll("#layers .lyr[data-lgroup='" + gid + "']").forEach(r => {
      if (out.indexOf(r.parentNode) < 0) out.push(r.parentNode);
    });
    return out;
  }

  /* Put the rows back in the stored order WITHOUT moving them past anything
     else in the container. A plain appendChild loop would drop every row below
     the sub-group containers and the legends that share the div with them — the
     rows have to land back in the slots the rows currently occupy, in the new
     order, and nothing else may move. */
  function applyStoredOrder() {
    for (const key in S.order) {
      const ids = S.order[key];
      let cont = null;
      if (key[0] === "#") cont = document.getElementById(key.slice(1));
      else if (subEls.has(key)) cont = subEls.get(key).querySelector(".lgsubb");
      if (!cont) continue;
      const cur = [...cont.children].filter(c => c.classList.contains("lyr"));
      if (cur.length < 2) continue;
      const want = [];
      for (const k of ids) {
        const r = refs.get(k);
        if (r && cur.indexOf(r.row) >= 0 && want.indexOf(r.row) < 0) want.push(r.row);
      }
      for (const r of cur) if (want.indexOf(r) < 0) want.push(r);   // rows added since
      const marks = cur.map(r => { const m = document.createComment("lt"); cont.replaceChild(m, r); return m; });
      marks.forEach((m, i) => cont.replaceChild(want[i], m));
    }
    for (const g of SBMM.layerState.GROUP_ORDER) applyDrawOrder(g[0]);
  }

  function front(l) {
    if (!l) return;
    if (l.options && l.options.sbmmBack) { if (l.bringToBack) l.bringToBack(); return; }
    if (l.eachLayer) { l.eachLayer(front); return; }
    if (l.bringToFront) l.bringToFront();
  }

  function applyDrawOrder(gid) {
    const conts = containersOf(gid);
    if (!conts.some(c => S.order[containerKey(c)])) return 0;
    const rows = [];
    for (const c of conts)
      for (const el of c.children) if (el.classList.contains("lyr")) rows.push(el);
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = refs.get(rows[i].dataset.lgroup + "/" + rows[i].dataset.lid);
      if (r && r.layer) { front(r.layer); n++; }
    }
    return n;
  }

  /* the honest probe for a test: where a row's geometry sits in its canvas
     renderer's draw list. Larger index = drawn later = on top. */
  function drawIndex(group, id) {
    const ref = refs.get(group + "/" + id);
    if (!ref || !ref.layer) return -1;
    let best = -1;
    const scan = l => {
      if (l.eachLayer) { l.eachLayer(scan); return; }
      const r = l._renderer;
      if (!r || !r._drawFirst) return;
      let i = 0;
      for (let o = r._drawFirst; o; o = o.next, i++)
        if (o.layer === l) { if (i > best) best = i; return; }
    };
    scan(ref.layer);
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* row actions                                                         */
  /* ------------------------------------------------------------------ */
  function boundsOf(layer) {
    let b = null;
    const add = ll => { if (!ll) return; b = b ? b.extend(ll) : L.latLngBounds(ll, ll); };
    const scan = (l, d) => {
      if (!l || d > 4) return;
      if (l.eachLayer) { l.eachLayer(x => scan(x, d + 1)); return; }
      if (l.getBounds) { const x = l.getBounds(); if (x && x.isValid()) { b = b ? b.extend(x) : L.latLngBounds(x.getSouthWest(), x.getNorthEast()); } return; }
      if (l.getLatLng) add(l.getLatLng());
    };
    scan(layer, 0);
    return b && b.isValid() ? b : null;
  }

  function zoomTo(group, id) {
    const ref = refs.get(group + "/" + id);
    if (!ref) return false;
    const b = boundsOf(ref.layer);
    if (!b) {
      toast(SBMM.layerState.isOn(group, id)
        ? "nothing to zoom to — this layer has no geometry on the map"
        : "nothing to zoom to — switch the layer on first");
      return false;
    }
    SBMM.map.flyToBounds(b, { padding: [30, 30], duration: 0.7 });
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen())
      SBMM.viewer3d.frameBox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
    return true;
  }

  /* Solo: everything else in the group off, click again to put it back.
     The cultural group is never touched, in either direction — its rows go on
     only through their own checkbox and its acknowledgement (§7). */
  let soloed = null;                 // {group, id, prev:{id:on}}
  function solo(group, id) {
    if (group === "cultural") { toast("cultural resources are not part of solo — tick the layer yourself"); return false; }
    const g = SBMM.layerState.list(group);
    if (!g.length) return false;
    if (soloed && soloed.group === group && soloed.id === id) {
      const list = g.map(r => ({ group, layer: r.id, on: !!soloed.prev[r.id] }));
      soloed = null;
      SBMM.layerState.batch(list);
      toast("solo off — the group is back as it was");
      return true;
    }
    const prev = {};
    for (const r of g) prev[r.id] = r.on;
    soloed = { group, id, prev };
    SBMM.layerState.batch(g.map(r => ({ group, layer: r.id, on: r.id === id })));
    const rec = SBMM.layerState.rec(group, id);
    toast("solo: " + ((rec && rec.label) || id) + " — click solo again to restore");
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* popovers                                                            */
  /* ------------------------------------------------------------------ */
  function pop() {
    let el = document.getElementById("ltPop");
    if (!el) {
      el = document.createElement("div");
      el.id = "ltPop";
      el.hidden = true;
      document.body.appendChild(el);
      document.addEventListener("mousedown", e => {
        if (!el.hidden && !el.contains(e.target) && !e.target.closest(".ltb")) closePop();
      });
      document.addEventListener("keydown", e => { if (e.key === "Escape" && !el.hidden) { e.stopPropagation(); closePop(); } }, true);
    }
    return el;
  }
  function closePop() { const el = document.getElementById("ltPop"); if (el) { el.hidden = true; el.innerHTML = ""; } }
  function showPop(html, anchor) {
    const el = pop();
    el.innerHTML = html;
    el.hidden = false;
    const r = anchor.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left - 4, window.innerWidth - el.offsetWidth - 10)) + "px";
    el.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 10)) + "px";
    return el;
  }

  function opacityPop(ref, anchor) {
    const st = SBMM.layerState.get(ref.group, ref.id) || { opacity: 1 };
    const el = showPop(
      `<div class="lthd">${esc(labelOf(ref))}</div>` +
      `<div class="ltoprow"><input type="range" id="ltOpac" min="0" max="100" value="${Math.round(st.opacity * 100)}">` +
      `<span class="mono" id="ltOpacV">${Math.round(st.opacity * 100)}%</span></div>` +
      `<div class="ltnote">Opacity applies wherever the layer draws — 2D, 3D and the exports.</div>`, anchor);
    const sl = el.querySelector("#ltOpac"), out = el.querySelector("#ltOpacV");
    sl.oninput = () => {
      out.textContent = sl.value + "%";
      SBMM.layerState.set(ref.group, ref.id, { opacity: sl.value / 100 });
    };
    sl.focus();
  }

  function labelOf(ref) {
    const rec = SBMM.layerState.rec(ref.group, ref.id);
    return (rec && rec.label) || ref.id;
  }

  function infoPop(ref, anchor) {
    const rec = SBMM.layerState.rec(ref.group, ref.id);
    const gl = (SBMM.layerState.GROUP_ORDER.find(g => g[0] === ref.group) || [])[1] || ref.group;
    const prov = (ref.row.dataset.baseTitle || ref.row.title || "").trim();
    const cad = rec && rec.meta && rec.meta.cad;
    const nEl = ref.row.querySelector(".ltn");
    const html =
      `<div class="lthd">${esc(labelOf(ref))}</div>` +
      `<table class="ltinfo">` +
      `<tr><td>group</td><td>${esc(gl)}</td></tr>` +
      (ref.row.dataset.lsub ? `<tr><td>sub-group</td><td>${esc(ref.row.dataset.lsub)}</td></tr>` : "") +
      `<tr><td>id</td><td class="mono">${esc(ref.group)}/${esc(ref.id)}</td></tr>` +
      (nEl ? `<tr><td>features</td><td class="mono">${esc(nEl.textContent.trim())}</td></tr>` : "") +
      `<tr><td>state</td><td>${SBMM.layerState.isOn(ref.group, ref.id) ? "on" : "off"} · ` +
      `${Math.round(SBMM.layerState.opacity(ref.group, ref.id) * 100)}% opacity</td></tr>` +
      `<tr><td>CRS</td><td>${esc(CRS_NOTE)}</td></tr>` +
      `</table>` +
      (prov ? `<div class="ltnote">${esc(prov)}</div>` : "") +
      (cad ? `<div class="ltacts2"><button type="button" class="minib" id="ltLman">Layer manager…</button></div>` : "");
    const el = showPop(html, anchor);
    const b = el.querySelector("#ltLman");
    if (b) b.onclick = () => {
      closePop();
      if (!SBMM.layerMan || !SBMM.layerMan.open) { toast("the Layer manager is not in this build"); return; }
      SBMM.layerMan.open();
      /* steer it at this group: its own search matches the group key */
      const q = document.getElementById("lmQ");
      if (q && rec.meta.key) { q.value = rec.meta.key; q.dispatchEvent(new Event("input")); }
    };
  }

  /* ------------------------------------------------------------------ */
  /* search                                                              */
  /* ------------------------------------------------------------------ */
  /* Fuzzy, in two steps, and the second one is deliberately narrow.

     A SUBSTRING anywhere in label + sub-group + group + id scores best: that is
     what makes "storm" find the three storm rows AND the drainage rows, whose
     sub-group is "Drainage (lidar + storm drains)".

     A SUBSEQUENCE ("stnd" for "Storm nodes") is matched against the LABEL ONLY
     and only when the letters land close together. Matched loosely over the
     whole haystack it is not a search: the group label is in there, so
     "s...t...o...r...m" spread across "Decision units (rev7) Site framework" is
     a hit, and typing "storm" would light up half the tree. Label-only, with a
     span cap, keeps the abbreviation search and drops the noise. */
  const SPAN_SLACK = 4;
  function fuzzy(hay, label, needle) {
    if (!needle) return 0;
    const n = needle.toLowerCase();
    const i = hay.toLowerCase().indexOf(n);
    if (i >= 0) return 1000 - i;
    if (n.length < 3) return -1;
    const h = String(label).toLowerCase();
    let j = 0, first = -1, last = 0;
    for (let k = 0; k < h.length && j < n.length; k++) {
      if (h[k] === n[j]) { if (first < 0) first = k; last = k; j++; }
    }
    if (j < n.length) return -1;
    const span = last - first + 1;
    if (span > n.length * 2 + SPAN_SLACK) return -1;
    return 400 - span;
  }

  let query = "";
  function applyFilter() {
    const pane = document.getElementById("layers");
    if (!pane) return;
    const q = query.trim();
    pane.classList.toggle("ltfiltering", !!q);
    let n = 0, firstHit = null;
    for (const [, ref] of refs) {
      const row = ref.row;
      if (!q) { row.classList.remove("lthide", "lthit"); continue; }
      const gl = (SBMM.layerState.GROUP_ORDER.find(g => g[0] === ref.group) || [])[1] || ref.group;
      const hay = [labelOf(ref), row.dataset.lsub || "", gl, ref.id].join(" ");
      const hit = fuzzy(hay, labelOf(ref), q) >= 0;
      row.classList.toggle("lthide", !hit);
      row.classList.toggle("lthit", hit);
      if (hit) { n++; if (!firstHit) firstHit = ref; }
    }
    /* ancestors: a sub-group or a group with no hit inside it is hidden, one
       with a hit is forced open for as long as the search lasts */
    document.querySelectorAll("#layers .lgsub").forEach(sub => {
      const hit = !q || !!sub.querySelector(".lyr.lthit");
      sub.classList.toggle("lthide", !hit);
      sub.classList.toggle("ltforce", !!q && hit);
    });
    document.querySelectorAll("#layers .lsec").forEach(sec => {
      const hit = !q || !!sec.querySelector(".lyr.lthit");
      sec.classList.toggle("lthide", !hit);
      sec.classList.toggle("ltforce", !!q && hit);
    });
    const c = document.getElementById("ltClear");
    if (c) c.hidden = !q;
    const st = document.getElementById("ltHits");
    if (st) { st.hidden = !q; st.textContent = q ? (n + (n === 1 ? " layer" : " layers")) : ""; }
    return { n, first: firstHit };
  }

  function search(q) { query = q == null ? "" : String(q); const inp = document.getElementById("ltSearch"); if (inp && inp.value !== query) inp.value = query; return applyFilter(); }

  /* ------------------------------------------------------------------ */
  /* keyboard                                                            */
  /* ------------------------------------------------------------------ */
  function navRows() {
    return [...document.querySelectorAll("#layers .lyr")]
      .filter(r => !r.classList.contains("lthide") && r.offsetParent);
  }
  function focusRow(delta, from) {
    const list = navRows();
    if (!list.length) return;
    let i = list.indexOf(from);
    i = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + delta));
    list[i].focus();
    if (typeof scrollIntoPane === "function") scrollIntoPane(list[i]);
  }

  function onKey(e) {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
    const row = t && t.closest ? t.closest(".lyr") : null;

    if (t && t.id === "ltSearch") {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); search(""); t.blur(); return; }
      if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        const r = applyFilter();
        if (r && r.first) toggleRow(r.first);
        else toast("nothing matches “" + query + "”");
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); focusRow(1, null); return; }
      return;
    }
    if (typing) return;

    if (e.key === "/") {
      const inp = document.getElementById("ltSearch");
      if (inp) { e.preventDefault(); e.stopPropagation(); inp.focus(); inp.select(); }
      return;
    }
    if (!row) return;
    const ref = refs.get(row.dataset.lgroup + "/" + row.dataset.lid);
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); focusRow(1, row); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); focusRow(-1, row); return; }
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (ref) toggleRow(ref); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault(); e.stopPropagation();
      const box = row.closest(".lgsub") || row.closest(".lsec");
      if (!box) return;
      const want = e.key === "ArrowRight";
      const h = box.querySelector(".subtoggle") || box.querySelector(".lsech");
      if (box.classList.contains("closed") === want && h) h.click();
      else if (!want && h) { h.focus && h.focus(); }
      return;
    }
  }

  /* every toggle this file offers goes through the row's own checkbox, so the
     cultural acknowledgement (a capture-phase listener on that element) always
     gets its chance */
  function toggleRow(ref) { ref.cb.click(); }

  /* ------------------------------------------------------------------ */
  /* recently changed                                                    */
  /* ------------------------------------------------------------------ */
  function noteChange(group, id) {
    if (group === "cultural") return;          // never offer a one-click way back on
    const k = group + "/" + id;
    const i = recent.indexOf(k);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(k);
    while (recent.length > 5) recent.pop();
    paintRecent();
  }
  function paintRecent() {
    const box = document.getElementById("ltRecent");
    if (!box) return;
    const html = recent.map(k => {
      const ref = refs.get(k);
      if (!ref) return "";
      const on = SBMM.layerState.isOn(ref.group, ref.id);
      return `<button type="button" class="ltchip${on ? " on" : ""}" data-k="${esc(k)}" ` +
             `title="${on ? "Switch off" : "Switch on"} ${esc(labelOf(ref))}">${esc(labelOf(ref))}</button>`;
    }).join("");
    if (box.innerHTML !== html) box.innerHTML = html;
    box.hidden = !recent.length;
  }

  /* ------------------------------------------------------------------ */
  /* presets                                                             */
  /* ------------------------------------------------------------------ */
  /* A rule answers true (on), false (off) or null (leave alone) per row. The
     cultural group is never in the list at all. */
  const BUILTIN = [
    ["Terrain", "The ground and nothing else — hillshade, imagery, the survey contours.",
      (r, g) => g === "base" ? /^(hillshade|ortho)/.test(r.id) || r.id === "contours_site" : false],
    ["Design review", "EA's native design geometry and the drawing set, over the site framework.",
      (r, g) => g === "design" ? /^gis_|^sheets3d$|^sheet_footprints$/.test(r.id)
        : g === "framework" ? /^(dus|piles)$/.test(r.id)
        : g === "base" ? /^hillshade_site|^ortho_abp/.test(r.id) : false],
    ["Water & drainage", "The storm network, the drainage map and your own water work.",
      (r, g) => g === "framework" ? /^storm_|^drain_outlet$|^dus$/.test(r.id)
        : g === "invest" ? /^survey_/.test(r.id)
        : g === "mywork" ? r.id === "water"
        : g === "base" ? /^hillshade_site$|^contours_site$/.test(r.id) : false],
    ["Investigations", "Sample results, the datasets and the 2026 survey.",
      (r, g) => g === "invest" ? true
        : g === "framework" ? /^(dus|piles)$/.test(r.id)
        : g === "base" ? /^hillshade_site|^ortho_abp/.test(r.id) : false],
    ["Field", "What the field build needs in your hand: ground, imagery, the framework and your work.",
      (r, g) => g === "base" ? /^(hillshade|ortho)/.test(r.id)
        : g === "framework" ? /^(dus|piles)$|^storm_/.test(r.id)
        : g === "invest" ? /^samples$|^survey_/.test(r.id)
        : g === "mywork" ? true : false],
    ["Everything on", "Every layer in every group except the protected one. Heavy layers compute when they draw.",
      () => true]
  ];

  function snapshot() {
    const o = {};
    for (const g of SBMM.layerState.groupList()) {
      if (g.id === "cultural") continue;
      const gg = {};
      for (const r of g.layers.values()) gg[r.id] = { on: r.on, opacity: r.opacity };
      o[g.id] = gg;
    }
    return o;
  }
  function applySnapshot(snap) {
    const list = [];
    for (const gid in snap) {
      if (gid === "cultural") continue;
      for (const lid in snap[gid]) list.push({ group: gid, layer: lid, on: snap[gid][lid].on, opacity: snap[gid][lid].opacity });
    }
    return SBMM.layerState.batch(list);
  }

  function presetNames() { return BUILTIN.map(p => p[0]).concat(Object.keys(S.presets).sort()); }

  function applyPreset(name) {
    const b = BUILTIN.find(p => p[0] === name);
    const before = snapshot();
    let after = null;
    if (b) {
      const list = [];
      for (const g of SBMM.layerState.groupList()) {
        if (g.id === "cultural") continue;
        for (const r of g.layers.values()) {
          const want = b[2](r, g.id);
          if (want === null || want === undefined) continue;
          list.push({ group: g.id, layer: r.id, on: !!want });
        }
      }
      SBMM.layerState.batch(list);
      after = snapshot();
    } else if (S.presets[name]) {
      applySnapshot(S.presets[name]);
      after = snapshot();
    } else {
      toast("no preset called “" + name + "”");
      return false;
    }
    SBMM.undo.push("apply layer preset " + name,
      () => applySnapshot(before), () => applySnapshot(after));
    toast("layer preset: " + name);
    paintPresets(name);
    legendSoon();
    return true;
  }

  function savePreset(name) {
    name = String(name || "").trim();
    if (!name) { toast("a preset needs a name"); return false; }
    if (BUILTIN.some(p => p[0] === name)) { toast("“" + name + "” is a built-in preset — pick another name"); return false; }
    S.presets[name] = snapshot();
    save();
    paintPresets(name);
    toast("saved the layer preset “" + name + "”");
    return true;
  }
  function deletePreset(name) {
    if (!S.presets[name]) { toast("“" + name + "” is not one of your presets"); return false; }
    delete S.presets[name];
    save(); paintPresets("");
    toast("deleted the layer preset “" + name + "”");
    return true;
  }
  function renamePreset(from, to) {
    to = String(to || "").trim();
    if (!S.presets[from]) { toast("“" + from + "” is not one of your presets"); return false; }
    if (!to || BUILTIN.some(p => p[0] === to)) { toast("pick a name that is not a built-in preset"); return false; }
    S.presets[to] = S.presets[from];
    delete S.presets[from];
    save(); paintPresets(to);
    toast("renamed the preset to “" + to + "”");
    return true;
  }

  function paintPresets(sel) {
    const s = document.getElementById("ltPreset");
    if (!s) return;
    const cur = sel != null ? sel : s.value;
    const mine = Object.keys(S.presets).sort();
    s.innerHTML = `<option value="">Presets…</option>` +
      BUILTIN.map(p => `<option value="${esc(p[0])}" title="${esc(p[1])}">${esc(p[0])}</option>`).join("") +
      (mine.length ? `<optgroup label="Mine">` + mine.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("") + `</optgroup>` : "");
    s.value = cur || "";
    const del = document.getElementById("ltPreDel");
    const ren = document.getElementById("ltPreRen");
    const own = !!S.presets[s.value];
    if (del) del.hidden = !own;
    if (ren) ren.hidden = !own;
  }

  /* ------------------------------------------------------------------ */
  /* the legend card on the map                                          */
  /* ------------------------------------------------------------------ */
  let legendTimer = null;
  function legendSoon() {
    /* Trailing-edge: a burst of layer adds (boot, a session restore, a group
       switch) runs this ONCE, after the last of them, so the draw-order pass
       below always sees every layer the burst put on the map. */
    if (legendTimer) clearTimeout(legendTimer);
    legendTimer = setTimeout(() => {
      legendTimer = null;
      /* Re-assert the draw order FIRST, on its own try. Adding a layer to a
         canvas renderer puts it at the END of that renderer's draw list — so
         switching a layer off and on again would jump it in front of everything
         the user had ordered above it, and the session restore at the end of
         boot re-adds every layer that was on. Cheap: applyDrawOrder returns
         immediately for a group the user has never reordered, which is every
         group until he drags something. It runs before the paints because a
         paint that throws must never cost the map its order — that was the
         one way block 9z's post-reload assertion could see insertion order
         with the stored order present. */
      try { for (const g of SBMM.layerState.GROUP_ORDER) applyDrawOrder(g[0]); }
      catch (e) { console.error("layer tree draw order", e); }
      try { paintLegend(); } catch (e) { console.error("layer tree legend", e); }
      try { paintRecent(); } catch (e) { console.error("layer tree recent", e); }
      try { paintCounts(); } catch (e) { console.error("layer tree counts", e); }
    }, 80);
  }

  function legendEl() {
    let el = document.getElementById("mapLegend");
    if (el) return el;
    const stage = document.getElementById("stage");
    if (!stage) return null;
    el = document.createElement("div");
    el.id = "mapLegend";
    el.innerHTML =
      `<div class="mlhead" id="mlHead" role="button" tabindex="0" title="Show or hide the legend">` +
      `<span class="caret"></span><span class="mlt">Legend</span><span class="mono mln" id="mlN"></span></div>` +
      `<div class="mlbody" id="mlBody"></div>`;
    stage.appendChild(el);
    el.classList.toggle("closed", !S.legend.open);
    document.body.classList.toggle("legendopen", !!S.legend.open);
    const h = el.querySelector("#mlHead");
    const toggle = () => {
      S.legend.open = el.classList.contains("closed");
      el.classList.toggle("closed", !S.legend.open);
      document.body.classList.toggle("legendopen", S.legend.open);
      save();
      if (S.legend.open) paintLegend();
    };
    h.onclick = toggle;
    h.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
    el.querySelector("#mlBody").addEventListener("click", e => {
      const b = e.target.closest(".mlonly");
      if (!b) return;
      const ref = refs.get(b.dataset.k);
      if (ref) solo(ref.group, ref.id);
    });
    return el;
  }

  function paintLegend() {
    const el = legendEl();
    if (!el) return;
    const on = [];
    for (const g of SBMM.layerState.groupList())
      for (const r of g.layers.values())
        if (r.on && refs.has(g.id + "/" + r.id)) on.push([g, r]);
    const n = el.querySelector("#mlN");
    if (n && n.textContent !== String(on.length)) n.textContent = String(on.length);
    if (el.classList.contains("closed")) return;
    let html = "", lastG = null;
    for (const [g, r] of on) {
      if (g.id !== lastG) { html += `<div class="mlg">${esc(g.label)}</div>`; lastG = g.id; }
      const ref = refs.get(g.id + "/" + r.id);
      html += `<div class="mlr"><span class="ltsw">${svgFor(ref, "_lg").html}</span>` +
        `<span class="mll">${esc(r.label)}</span>` +
        `<button type="button" class="mlonly" data-k="${esc(g.id + "/" + r.id)}" title="Hide everything else in ${esc(g.label)}">only</button></div>`;
    }
    if (!on.length) html = `<div class="mlempty">Nothing is switched on.</div>`;
    const body = el.querySelector("#mlBody");
    if (body.innerHTML !== html) body.innerHTML = html;
  }

  function toggleLegend(force) {
    const el = legendEl();
    if (!el) { toast("no legend on this screen"); return false; }
    const open = force == null ? el.classList.contains("closed") : !!force;
    S.legend.open = open;
    el.classList.toggle("closed", !open);
    document.body.classList.toggle("legendopen", open);
    save();
    if (open) paintLegend();
    return open;
  }

  /* ------------------------------------------------------------------ */
  /* group headers: "n of m on" and the header toolbar                   */
  /* ------------------------------------------------------------------ */
  /* A group with nothing in it says why rather than showing a blank body — in
     the field build the CAD payload is not shipped, and a silently empty group
     reads as a broken app rather than a smaller one (§2.2). */
  const EMPTY_WHY = {
    design: "No EA CAD in this build — the field copy leaves the 21 MB payload out.",
    cultural: "No cultural-resources payload in this build."
  };
  function paintEmpty(sec) {
    const gid = sec.dataset.sec;
    const body = sec.querySelector(".lsecb");
    if (!body) return;
    const n = body.querySelectorAll(".lyr, .surfrow, .refrow[data-sid]").length;
    let note = body.querySelector(":scope > .ltempty");
    if (n) { if (note) note.remove(); return; }
    if (note) return;                                        // rule 2: idempotent
    note = document.createElement("div");
    note.className = "ltempty mut";
    note.textContent = EMPTY_WHY[gid] || "Nothing in this group in this build.";
    body.appendChild(note);
  }

  function paintCounts() {
    document.querySelectorAll("#layers .lsec").forEach(sec => {
      paintEmpty(sec);
      const gid = sec.dataset.sec;
      const el = sec.querySelector(".ltonof");
      if (!el) return;
      const m = SBMM.layerState.count(gid), k = SBMM.layerState.countOn(gid);
      /* compact on purpose: the header is a wrapping flex row about 247 px wide,
         and "5 of 20 on" spelled out pushed every long group name onto a second
         line */
      const txt = m ? k + "/" + m + " on" : "";
      if (el.textContent !== txt) el.textContent = txt;      // rule 2: only on a real change
    });
    document.querySelectorAll("#layers .lgsub").forEach(sub => {
      const el = sub.querySelector(".ltsubon");
      if (!el) return;
      const rows = [...sub.querySelectorAll(".lyr")];
      const k = rows.filter(r => SBMM.layerState.isOn(r.dataset.lgroup, r.dataset.lid)).length;
      const txt = rows.length ? k + "/" + rows.length : "";
      if (el.textContent !== txt) el.textContent = txt;
    });
  }

  function buildHeaders() {
    document.querySelectorAll("#layers .lsec").forEach(sec => {
      const gid = sec.dataset.sec;
      const h = sec.querySelector(".lsech");
      if (!h || h.querySelector(".ltonof")) return;
      const on = document.createElement("span");
      on.className = "ltonof mono";
      h.appendChild(on);
      /* the cultural group has no master checkbox by design (§4) and gets no
         all-on button either — it is switched on one row at a time, by hand */
      if (gid === "cultural") return;
      const bar = document.createElement("span");
      bar.className = "ltgacts";
      bar.innerHTML =
        `<button type="button" class="minib lsecbtn ltgb" data-a="on" title="Show every layer in this group">all on</button>` +
        `<button type="button" class="minib lsecbtn ltgb" data-a="off" title="Hide every layer in this group">all off</button>` +
        `<button type="button" class="minib lsecbtn ltgb" data-a="exp" title="Expand every sub-group here">＋</button>` +
        `<button type="button" class="minib lsecbtn ltgb" data-a="col" title="Collapse every sub-group here">－</button>`;
      bar.addEventListener("click", e => {
        const b = e.target.closest(".ltgb");
        if (!b) return;
        e.preventDefault(); e.stopPropagation();
        const a = b.dataset.a;
        if (a === "on" || a === "off") SBMM.layerState.setGroup(gid, a === "on");
        else sec.querySelectorAll(".lgsub").forEach(sub => {
          const want = a === "exp";
          if (sub.classList.contains("closed") === want) {
            const t = sub.querySelector(".subtoggle");
            if (t) t.click();
          }
        });
      });
      h.appendChild(bar);
    });
  }

  /* ------------------------------------------------------------------ */
  /* the search / preset bar                                             */
  /* ------------------------------------------------------------------ */
  function wireBar() {
    const inp = document.getElementById("ltSearch");
    if (inp) {
      inp.oninput = () => { query = inp.value; applyFilter(); };
    }
    const clr = document.getElementById("ltClear");
    if (clr) clr.onclick = e => { e.preventDefault(); search(""); if (inp) inp.focus(); };

    paintPresets("");
    const sel = document.getElementById("ltPreset");
    if (sel) sel.onchange = () => { if (sel.value) applyPreset(sel.value); paintPresets(sel.value); };

    const name = document.getElementById("ltPreName");
    let pending = null;                       // "save" | "rename"
    const startName = (what, initial) => {
      pending = what;
      name.hidden = false; name.value = initial || ""; name.focus(); name.select();
    };
    const endName = ok => {
      if (!pending) return;
      const v = name.value;
      const was = pending;
      pending = null; name.hidden = true; name.value = "";
      if (!ok) { toast("preset " + (was === "save" ? "not saved" : "not renamed")); return; }
      if (was === "save") savePreset(v);
      else renamePreset(sel.value, v);
    };
    if (name) {
      name.onkeydown = e => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); endName(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endName(false); }
      };
      name.onblur = () => { if (pending) endName(false); };
    }
    const sv = document.getElementById("ltPreSave");
    if (sv) sv.onclick = e => { e.preventDefault(); startName("save", ""); };
    const rn = document.getElementById("ltPreRen");
    if (rn) rn.onclick = e => {
      e.preventDefault();
      if (!S.presets[sel.value]) { toast("pick one of your own presets to rename"); return; }
      startName("rename", sel.value);
    };
    const dl = document.getElementById("ltPreDel");
    if (dl) dl.onclick = e => {
      e.preventDefault();
      if (!S.presets[sel.value]) { toast("pick one of your own presets to delete"); return; }
      deletePreset(sel.value);
    };
    const lg = document.getElementById("ltLegendBtn");
    if (lg) lg.onclick = e => { e.preventDefault(); toggleLegend(); };

    const box = document.getElementById("ltRecent");
    if (box) box.addEventListener("click", e => {
      const b = e.target.closest(".ltchip");
      if (!b) return;
      e.preventDefault();
      const ref = refs.get(b.dataset.k);
      if (ref) toggleRow(ref);
    });
  }

  /* ------------------------------------------------------------------ */
  /* session                                                             */
  /* ------------------------------------------------------------------ */
  /* Additive, and tolerant both ways: an old session has no `_tree` and this
     leaves the tree alone; a new session read by an older build lands in
     layerState.restore's group loop, finds no layer called `_tree` and skips
     it. */
  function serialize() { return { order: S.order, presets: S.presets, open: S.open }; }
  function restoreSession(o) {
    if (!o || typeof o !== "object") return 0;
    if (o.order) S.order = o.order;
    if (o.presets) S.presets = Object.assign({}, S.presets, o.presets);
    if (o.open) S.open = Object.assign({}, S.open, o.open);
    save();
    if (wired) { applyStoredOrder(); paintPresets(""); }
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* dump — what the acceptance test compares before and after            */
  /* ------------------------------------------------------------------ */
  function dump() {
    const out = [];
    for (const g of SBMM.layerState.groupList())
      for (const r of g.layers.values())
        out.push({ group: g.id, id: r.id, label: r.label,
                   sub: (refs.get(g.id + "/" + r.id) || { row: { dataset: {} } }).row.dataset.lsub || "",
                   on: !!r.on });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* wire                                                                */
  /* ------------------------------------------------------------------ */
  function wire() {
    if (wired) return;
    wired = true;
    /* the static sub-groups written into index.html get the same wiring the
       dynamic ones get, and the same open/closed record */
    document.querySelectorAll("#layers .lgsub").forEach(sub => {
      if (!sub.dataset.subkey) sub.dataset.subkey = "#static|" + sub.dataset.sub;
      wireSub(sub);
      const h = sub.querySelector(".subtoggle");
      if (h && !h.querySelector(".ltsubon")) {
        const s = document.createElement("span");
        s.className = "ltsubon mono";
        h.appendChild(s);
      }
    });
    buildHeaders();
    wireBar();
    applyStoredOrder();
    const pane = document.getElementById("layers");
    if (pane) pane.addEventListener("keydown", onKey);

    SBMM.events.on("layers", e => {
      if (e && e.group && e.layer) noteChange(e.group, e.layer);
      /* swatches follow the layer, not the row: a dataset restyled or a group
         rendered on first show changes what the glyph should say */
      for (const [, ref] of refs) paintSwatch(ref);
      legendSoon();
    });
    if (SBMM.events.on) SBMM.events.on("field", () => legendSoon());
    /* the precise trigger for "something jumped the draw queue": Leaflet fires
       layeradd for every add, including the ones nothing here asked for (the
       zoom gate, the sheet-tab footprint borrow, the boot session restore).
       Only armed once the user has actually ordered something. */
    if (SBMM.map) SBMM.map.on("layeradd", () => { if (Object.keys(S.order).length) legendSoon(); });
    /* and once more when boot has finished: every row is registered and every
       remembered layer is on the map by then, whatever order the payloads and
       the workers landed in, so this is the one pass that cannot be early */
    if (SBMM.events.on) SBMM.events.on("boot", () => { if (Object.keys(S.order).length) { try { applyStoredOrder(); } catch (e) {} } });
    legendEl();
    legendSoon();
  }

  return {
    hostFor, onRow, wire, openState, dump, refs: () => refs,
    applyDrawOrder, drawIndex, order: () => S.order, restoreOrder: applyStoredOrder,
    solo, zoomTo, search, toggleRow,
    presetNames, applyPreset, savePreset, deletePreset, renamePreset,
    snapshot, applySnapshot,
    legend: { toggle: toggleLegend, paint: paintLegend, visible: () => !!S.legend.open },
    serialize, restoreSession,
    recent: () => recent.slice()
  };
})();

/* The tree's own record — row order, presets, open/closed — travels with the
   layer state rather than in a key of its own: js/state.js writes
   `SBMM.layerState.serialize()` into the session file and this lands under
   `_tree` inside it. Additive both ways (js/layerstate.js `setExtra`). */
SBMM.layerState.setExtra({
  save: () => SBMM.layerTree.serialize(),
  load: o => SBMM.layerTree.restoreSession(o)
});
