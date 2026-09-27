/* SBMM Site Explorer — the omnibox (v26, docs/V26_UI_AUDIT.md §5).
   ---------------------------------------------------------------------------
   ONE search box for everything the app can find or do. Before v26 a user had
   to know which of four boxes a thing lived in: the command bar (commands), the
   Go-to box (coordinates), the layer search (layers) and the SHEETS picker
   (drawings). This box asks all of them, plus the places on the site by name,
   the 44 borings and the 140 sample locations, and ranks what it finds by kind.

     Ctrl K  or  /        open it (the backtick still opens the command bar)
     ↑ ↓  Enter  Esc      pick, run, close
     > text               hand the line to the command bar verbatim

   Nothing here is a second implementation of anything: a command runs through
   SBMM.cmd.run, a layer toggles through its own row (so the cultural gate still
   asks first), a sheet opens through SBMM.sheets.open, a boring through the log
   window, a coordinate through SBMM.parseCoord. It is an INDEX over the app.
   --------------------------------------------------------------------------- */
"use strict";

SBMM.omni = (function () {
  const RECENT_KEY = "sbmm.omni.v1";
  const MAX_PER_GROUP = 6, MAX_ALL = 40;
  let box, inp, list, items = [], sel = 0, open = false;

  /* ---------------- geometry helpers ---------------- */
  function bboxOf(ring) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return [x0, y0, x1, y1];
  }
  function ringsOf(g) {
    if (!g) return [];
    if (g.type === "Polygon") return [g.coordinates[0]];
    if (g.type === "MultiPolygon") return g.coordinates.map(p => p[0]);
    if (g.type === "LineString") return [g.coordinates];
    if (g.type === "MultiLineString") return g.coordinates;
    if (g.type === "Point") return [[g.coordinates, g.coordinates]];
    return [];
  }
  function union(bs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bs) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    return [x0, y0, x1, y1];
  }

  /* Fit a box into the FRAME — the part of the map no floating panel covers.
     Every "take me there" in the app should land the thing where it can be
     seen, not under the layer panel. */
  function fitPad() {
    if (document.body.classList.contains("field")) return { padding: [24, 24] };
    const f = SBMM.shell && SBMM.shell.frame ? SBMM.shell.frame() : null;
    const st = document.getElementById("stage").getBoundingClientRect();
    if (!f) return { padding: [24, 24] };
    return { paddingTopLeft: [f.x - st.left + 24, f.y - st.top + 24],
             paddingBottomRight: [st.right - (f.x + f.w) + 24, st.bottom - (f.y + f.h) + 24] };
  }
  function flyBox(b, opts) {
    const o = opts || {};
    const pad = Math.max(40, Math.max(b[2] - b[0], b[3] - b[1]) * 0.15);
    const bb = [[b[1] - pad, b[0] - pad], [b[3] + pad, b[2] + pad]];
    if (SBMM.map) SBMM.map.flyToBounds(bb, Object.assign({ duration: 0.8, maxZoom: o.maxZoom != null ? o.maxZoom : 3 }, fitPad()));
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen() && SBMM.viewer3d.frameBox)
      SBMM.viewer3d.frameBox(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
    if (o.rings) flash(o.rings);
    else flash([[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]], true);
  }
  /* a short glow on what was found, so the eye knows where to land. SVG in the
     water pane, which never takes a pointer event (CLAUDE.md, v10 trap 4). */
  let flashLayer = null;
  function flash(rings, isBox) {
    if (!SBMM.map || !window.L) return;
    if (flashLayer) { SBMM.map.removeLayer(flashLayer); flashLayer = null; }
    const R = L.svg({ pane: "water" });
    const ll = rings.map(r => r.map(p => [p[1], p[0]]));
    flashLayer = L.polygon(ll, { renderer: R, pane: "water", color: "#8BD8EA", weight: 3, opacity: 1,
      fill: !isBox, fillColor: "#5CC0DB", fillOpacity: 0.12, dashArray: isBox ? "6 6" : null,
      interactive: false }).addTo(SBMM.map);
    const lay = flashLayer;
    let t = 0;
    const iv = setInterval(() => {
      t += 1;
      if (lay !== flashLayer) { clearInterval(iv); return; }
      lay.setStyle({ opacity: Math.max(0, 1 - t / 30), fillOpacity: Math.max(0, 0.12 * (1 - t / 30)) });
      if (t >= 30) { clearInterval(iv); if (flashLayer === lay) { SBMM.map.removeLayer(lay); flashLayer = null; } }
    }, 100);
  }
  function flyPoint(x, y, label) {
    const r = 90;
    flyBox([x - r, y - r, x + r, y + r], { maxZoom: 3, rings: [circle(x, y, 18)] });
  }
  function circle(x, y, r) {
    const out = [];
    for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI * 2; out.push([x + r * Math.cos(a), y + r * Math.sin(a)]); }
    return out;
  }

  /* ---------------- the index ---------------- */
  /* Built lazily, once, the first time the box opens: the payloads are all in
     memory by then and the index is a few hundred records. Layers and
     commands are read live because both grow after boot. */
  let placeIdx = null;
  function places() {
    if (placeIdx) return placeIdx;
    const out = [];
    const D = window.SBMM_DATA || {};
    /* the areas the job is worked in */
    if (SBMM.layersUI && SBMM.layersUI.extents) {
      const e = SBMM.layersUI.extents();
      const nm = { mine: "Mine area (OU1)", resid: "Residential cleanup area", site: "Full site" };
      for (const k in e) {
        const b = e[k]; if (!b) continue;
        out.push({ kind: "place", label: nm[k] || k, sub: "area", key: "area",
          run: () => { SBMM.layersUI.flyTo(k); } });
      }
    }
    /* EA's named features: water bodies, excavation limits, the repository,
       staging and the operable units */
    const gis = D.design_gis && D.design_gis.features || [];
    const WORD = { water: "water", exc: "limit of excavation", repo: "repository / stockpile",
                   staging: "staging and borrow", ou: "operable unit", lots: "lot" };
    const byName = new Map();
    for (const f of gis) {
      const p = f.properties || {};
      if (!WORD[p.layer] || !p.name || /^Unnamed/.test(p.name)) continue;
      const rings = ringsOf(f.geometry);
      if (!rings.length) continue;
      const k = p.layer + "|" + p.name;
      if (!byName.has(k)) byName.set(k, { layer: p.layer, name: p.name, rings: [] });
      byName.get(k).rings.push(...rings);
    }
    for (const v of byName.values()) {
      const b = union(v.rings.map(bboxOf));
      out.push({ kind: "place", label: v.name, sub: WORD[v.layer], key: v.layer === "lots" ? "lot" : "EA",
        run: () => flyBox(b, { rings: v.rings }) });
    }
    /* decision units and the traced piles */
    const dus = new Map();
    for (const d of (D.dus || [])) {
      if (!d.name || !d.ring) continue;
      if (!dus.has(d.name)) dus.set(d.name, []);
      dus.get(d.name).push(d.ring);
    }
    for (const [name, rings] of dus) {
      const b = union(rings.map(bboxOf));
      out.push({ kind: "place", label: name, sub: "decision unit (rev 7)", key: "DU",
        run: () => { turnOn("framework", "dus"); flyBox(b, { rings }); } });
    }
    for (const p of (D.piles || [])) {
      if (!p.name || !p.ring) continue;
      const b = bboxOf(p.ring);
      out.push({ kind: "place", label: p.name, sub: "waste pile", key: "pile",
        run: () => { turnOn("framework", "piles"); flyBox(b, { rings: [p.ring] }); } });
    }
    /* the storm structures by name */
    const sn = D.storm_network && D.storm_network.nodes || [];
    for (const n of sn) {
      if (!n.name) continue;
      out.push({ kind: "place", label: n.name, sub: "storm structure", key: "storm",
        run: () => flyPoint(n.x, n.y) });
    }
    /* sample locations */
    for (const s of (D.points || [])) {
      if (!s.id) continue;
      const bits = [];
      if (s.Hg != null) bits.push("Hg " + s.Hg);
      if (s.As != null) bits.push("As " + s.As);
      out.push({ kind: "sample", label: s.id, sub: (s.src || "sample") + (bits.length ? " · " + bits.join(" · ") + " mg/kg" : ""),
        key: "sample", run: () => { turnOn("invest", "samples"); flyPoint(s.x, s.y); } });
    }
    placeIdx = out;
    return out;
  }
  function turnOn(g, id) {
    const LS = SBMM.layerState;
    if (!LS || !LS.rec || !LS.rec(g, id) || LS.isOn(g, id)) return;
    LS.set(g, id, { on: true });
  }

  function borings() {
    const BL = SBMM.borelogs;
    if (!BL || !BL.has || !BL.has()) return [];
    return BL.holes().map(h => {
      const c = BL.contactOf ? BL.contactOf(h.id) : null;
      const bits = [];
      if (h.depth != null) bits.push(fmt(h.depth, 1) + " ft deep");
      if (c && c.depth != null) bits.push("native at " + fmt(c.depth, 1) + " ft");
      const area = BL.areaOf ? BL.areaOf(h.id) : "";
      if (area) bits.push(area);
      return { kind: "boring", label: h.id, sub: bits.join(" · ") || "boring log", key: "log",
        alt: "SB" + String(h.id).replace(/^SB-?/i, ""),
        run: () => {
          if (h.x != null && h.y != null) flyPoint(h.x, h.y);
          if (SBMM.borewin && SBMM.borewin.open) SBMM.borewin.open(h.id);
        } };
    });
  }

  function sheets() {
    const S = SBMM.sheets;
    if (!S || !S.index) return [];
    let idx = [];
    try { idx = S.index() || []; } catch (e) { return []; }
    return idx.map(s => ({ kind: "sheet", label: s.sheet + " — " + (s.title || ""), sub: (s.subject || s.lot || s.design_set || "drawing"),
      key: "sheet", run: () => { try { S.open(s.sheet); } catch (e) { toast("could not open " + s.sheet); } } }));
  }

  function layers() {
    const T = SBMM.layerTree, LS = SBMM.layerState;
    if (!T || !T.refs || !LS) return [];
    const out = [];
    const GW = { base: "Base", framework: "Site framework", design: "Residential design", invest: "Investigations",
                 cultural: "Cultural (protected)", mywork: "My work" };
    for (const ref of T.refs().values()) {
      const r = LS.rec(ref.group, ref.id);
      const lbl = (r && r.label) || (ref.row && ref.row.querySelector(".lbl") ? ref.row.querySelector(".lbl").textContent : ref.id);
      const sub = ref.row && ref.row.dataset.lsub;
      out.push({ kind: "layer", label: lbl, sub: (GW[ref.group] || ref.group) + (sub ? " · " + sub : ""),
        key: () => LS.isOn(ref.group, ref.id) ? "on" : "off",
        run: () => {
          /* through the row's own checkbox: the cultural gate intercepts
             that click in the capture phase and must keep winning (v16) */
          if (ref.row && ref.row.querySelector("input[type=checkbox]")) ref.row.querySelector("input[type=checkbox]").click();
          else LS.set(ref.group, ref.id, { on: !LS.isOn(ref.group, ref.id) });
          toast(lbl + (LS.isOn(ref.group, ref.id) ? " — on" : " — off"));
        } });
    }
    return out;
  }

  function commands() {
    const C = SBMM.cmd;
    if (!C || !C.commands) return [];
    return C.commands().map(c => ({ kind: "command", label: c.n, sub: c.d || "", alt: (c.a || []).join(" "),
      key: (c.a || []).slice(0, 2).join(" · "), run: () => C.run(c.n) }));
  }

  /* ---------------- matching ---------------- */
  /* A subsequence match, scored so that a prefix beats a word start beats a
     scatter, and a shorter label beats a longer one. Case-insensitive, and the
     separators engineers type interchangeably (space, dash, dot) are ignored. */
  const norm = s => String(s || "").toLowerCase().replace(/[\s\-_.·—,]+/g, "");
  function score(q, label, alt) {
    const L = norm(label), A = alt ? norm(alt) : "";
    let best = sub(q, L);
    if (A) best = Math.max(best, sub(q, A) - 4);
    return best;
  }
  function sub(q, s) {
    if (!q) return 1;
    if (!s) return -1;
    if (s === q) return 1000;
    if (s.startsWith(q)) return 800 - s.length;
    const at = s.indexOf(q);
    if (at >= 0) return 600 - at * 4 - s.length;
    let i = 0, j = 0, gaps = 0, last = -1;
    while (i < q.length && j < s.length) {
      if (q[i] === s[j]) { if (last >= 0 && j - last > 1) gaps += j - last - 1; last = j; i++; }
      j++;
    }
    if (i < q.length) return -1;
    return 300 - gaps * 6 - s.length;
  }

  const KIND_ORDER = ["coord", "place", "boring", "sheet", "layer", "command", "sample"];
  const KIND_WORD = { coord: "Coordinate", place: "Places", boring: "Borings", sheet: "Sheets", layer: "Layers",
                      command: "Commands", sample: "Sample locations", recent: "Recent", hint: "Start here" };
  const ICON = {
    coord: '<path d="M8 1.6c-2.3 0-4.1 1.8-4.1 4 0 3 4.1 8.8 4.1 8.8s4.1-5.8 4.1-8.8c0-2.2-1.8-4-4.1-4z"/>',
    place: '<path d="M1.6 12.8V3.6l4.3-1.4 4.2 1.4 4.3-1.4v9.2l-4.3 1.4-4.2-1.4z M5.9 2.2v9.2M10.1 3.6v9.2"/>',
    boring: '<rect x="5" y="1.6" width="6" height="12.8" rx="1.2"/><path d="M5 6h6M5 10h6"/>',
    sheet: '<path d="M3.4 1.8h6l3.2 3.2v9.2H3.4z"/><path d="M9.4 1.8V5h3.2"/>',
    layer: '<path d="M8 1.6 14.6 5 8 8.4 1.4 5z"/><path d="M1.4 8.4 8 11.8l6.6-3.4"/>',
    command: '<path d="M2.4 3.6 6.6 8l-4.2 4.4M8.2 12.4h5.4"/>',
    sample: '<path d="M6.3 1.8v4L2.5 12a1.6 1.6 0 0 0 1.4 2.4h8.2A1.6 1.6 0 0 0 13.5 12L9.7 5.8v-4z"/>',
    recent: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
    hint: '<path d="M8 1.8v12.4M1.8 8h12.4"/>'
  };

  function query(qRaw) {
    const q0 = qRaw.trim();
    if (q0.startsWith(">")) {
      const line = q0.slice(1).trim();
      const cmds = commands();
      const word = norm(line.split(/\s+/)[0] || "");
      const hits = cmds.map(c => ({ c, s: score(word, c.label, c.alt) })).filter(o => o.s >= 0)
        .sort((a, b) => b.s - a.s).slice(0, 12).map(o => o.c);
      const out = [];
      if (line) out.push({ kind: "command", label: "> " + line, sub: "run this line in the command bar", key: "Enter",
        run: () => { if (SBMM.cmd) SBMM.cmd.run(line); } });
      return out.concat(hits.map(h => Object.assign({}, h, { group: "command" })));
    }
    if (!q0) return starter();
    const q = norm(q0);
    const res = [];
    const coord = SBMM.parseCoord ? SBMM.parseCoord(q0) : null;
    if (coord) {
      const [x, y] = coord;
      let zt = "";
      try { const z = SBMM.elev(x, y)[0]; if (isFinite(z)) zt = " · " + fmt(z, 1) + " ft"; } catch (e) {}
      res.push({ kind: "coord", label: fmt0(x) + " E, " + fmt0(y) + " N", sub: "State Plane ft (EPSG:6418)" + zt, key: "go",
        run: () => { flyPoint(x, y); dropPin(x, y); }, s: 2000 });
    }
    for (const src of [places(), borings(), sheets(), layers(), commands()]) {
      for (const it of src) {
        const s = score(q, it.label, it.alt);
        if (s >= 0) res.push(Object.assign({}, it, { s }));
      }
    }
    /* sub-line matches count too, weaker: "tailings" should find the holes
       whose line says so, "C-106" the lot sheet */
    if (q.length >= 3) {
      for (const src of [borings(), places()]) for (const it of src) {
        if (res.some(r => r.label === it.label && r.kind === it.kind)) continue;
        if (norm(it.sub).includes(q)) res.push(Object.assign({}, it, { s: 150 }));
      }
    }
    return group(res);
  }
  function group(res) {
    const byKind = {};
    for (const r of res) (byKind[r.kind] = byKind[r.kind] || []).push(r);
    const out = [];
    /* the kind whose best hit is best goes first; ties keep KIND_ORDER */
    const kinds = KIND_ORDER.filter(k => byKind[k]).sort((a, b) => {
      const sa = Math.max(...byKind[a].map(r => r.s)), sb = Math.max(...byKind[b].map(r => r.s));
      return (sb >= 800) !== (sa >= 800) ? (sb >= 800 ? 1 : -1) : KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b);
    });
    for (const k of kinds) {
      const g = byKind[k].sort((a, b) => b.s - a.s).slice(0, MAX_PER_GROUP);
      for (const r of g) out.push(Object.assign(r, { group: k }));
      if (out.length >= MAX_ALL) break;
    }
    return out.slice(0, MAX_ALL);
  }
  function starter() {
    const out = [];
    for (const r of readRecent()) {
      const hit = findByLabel(r.kind, r.label);
      if (hit) out.push(Object.assign({}, hit, { group: "recent" }));
    }
    const S = [
      { kind: "hint", label: "Boring logs", sub: "the 44 holes of the 2025 investigation", key: "LOGWIN", run: () => SBMM.cmd.run("LOGWIN") },
      { kind: "hint", label: "Sheets", sub: "the 20-drawing EA design set", key: "SHEETS", run: () => SBMM.cmd.run("SHEETS") },
      { kind: "hint", label: "Where does the water go", sub: "the site in four drainage areas", key: "WHEREWATER", run: () => SBMM.cmd.run("WHEREWATER") },
      { kind: "hint", label: "3D terrain", sub: "the lidar surface with the imagery draped", key: "3", run: () => { if (!SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle(); } },
      { kind: "hint", label: "Type a coordinate", sub: "6371500, 2128900 · or 39.005, -122.66", key: "E, N", run: () => { inp.value = ""; inp.focus(); } },
      { kind: "hint", label: "Type > for the command line", sub: "AutoCAD aliases: PL, VOL, DIM, OFFSET…", key: ">", run: () => { inp.value = "> "; paint(); inp.focus(); } }
    ];
    for (const s of S) out.push(Object.assign(s, { group: "hint" }));
    return out;
  }
  function findByLabel(kind, label) {
    const src = kind === "place" || kind === "sample" ? places() : kind === "boring" ? borings() : kind === "sheet" ? sheets()
      : kind === "layer" ? layers() : kind === "command" ? commands() : [];
    return src.find(i => i.label === label) || null;
  }
  function readRecent() {
    try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(a) ? a.slice(0, 5) : []; }
    catch (e) { return []; }
  }
  function pushRecent(it) {
    if (!it || it.kind === "hint" || it.kind === "coord" || /^> /.test(it.label)) return;
    const a = readRecent().filter(r => !(r.kind === it.kind && r.label === it.label));
    a.unshift({ kind: it.kind, label: it.label });
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(a.slice(0, 5))); } catch (e) {}
  }
  let pin = null;
  function dropPin(x, y) {
    if (!SBMM.map || !window.L) return;
    if (pin) SBMM.map.removeLayer(pin);
    let z = NaN; try { z = SBMM.elev(x, y)[0]; } catch (e) {}
    pin = L.circleMarker([y, x], { pane: "drawings", radius: 7, color: "#FFD34D", weight: 2.5, fillColor: "#12181C", fillOpacity: .9 })
      .bindTooltip(`${fmt0(x)}, ${fmt0(y)}${isNaN(z) ? "" : " · " + fmt(z, 1) + " ft"}`, { permanent: true, direction: "top", className: "ctip", offset: [0, -8] })
      .addTo(SBMM.map);
    const p = pin;
    setTimeout(() => { if (pin === p) { SBMM.map.removeLayer(p); pin = null; } }, 8000);
  }

  /* ---------------- the list ---------------- */
  function paint() {
    items = query(inp.value);
    sel = 0;
    let h = "", g = null;
    if (!items.length) h = `<div class="oempty">Nothing matches “${esc(inp.value.trim())}”. Try a boring (SB-9), a lot (Lot 25), a sheet (C-106), a layer or a command.</div>`;
    items.forEach((it, i) => {
      if (it.group !== g) { g = it.group; h += `<div class="ogrp">${KIND_WORD[g] || g}</div>`; }
      const key = typeof it.key === "function" ? it.key() : it.key;
      h += `<div class="oitem${i === sel ? " sel" : ""}" data-i="${i}" role="option">` +
        `<span class="oi"><svg viewBox="0 0 16 16">${ICON[it.kind] || ICON.hint}</svg></span>` +
        `<span><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span>` +
        `<span class="ok">${esc(key || "")}</span></div>`;
    });
    h += `<div class="ofoot"><span><kbd>↑</kbd> <kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> go</span>` +
         `<span><kbd>&gt;</kbd> command line</span><span><kbd>Esc</kbd> close</span></div>`;
    list.innerHTML = h;
    place();
  }
  function place() {
    const r = box.getBoundingClientRect();
    const w = Math.max(r.width, Math.min(520, innerWidth - 24));
    list.style.width = w + "px";
    list.style.left = Math.round(Math.max(12, Math.min(r.left, innerWidth - w - 12))) + "px";
    list.style.top = Math.round(r.bottom + 6) + "px";
  }
  function mark() {
    list.querySelectorAll(".oitem").forEach(el => el.classList.toggle("sel", +el.dataset.i === sel));
    const el = list.querySelector(".oitem.sel");
    if (el && SBMM.scrollIntoPane) SBMM.scrollIntoPane(el);
    else if (el) {
      const top = el.offsetTop, bot = top + el.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top - 30;
      else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight + 6;
    }
  }
  function show(seed) {
    if (!box) return;
    if (seed != null) inp.value = seed;
    open = true;
    box.classList.add("focus");
    box.setAttribute("aria-expanded", "true");
    list.classList.add("on");
    paint();
    if (document.activeElement !== inp) inp.focus({ preventScroll: true });
    if (seed != null) inp.setSelectionRange(inp.value.length, inp.value.length);
  }
  function hide() {
    if (!open) return;
    open = false;
    box.classList.remove("focus");
    box.setAttribute("aria-expanded", "false");
    list.classList.remove("on");
    if (document.activeElement === inp) inp.blur();
  }
  function pick(i) {
    const it = items[i];
    if (!it) return;
    hide();
    inp.value = "";
    pushRecent(it);
    try { it.run(); } catch (e) { console.error("omni", e); toast("could not open “" + it.label + "”: " + e.message); }
  }

  function wire() {
    box = document.getElementById("omni");
    inp = document.getElementById("omniIn");
    if (!box || !inp) return;
    list = document.createElement("div");
    list.id = "omniList";
    list.setAttribute("role", "listbox");
    document.body.appendChild(list);

    box.addEventListener("mousedown", e => { if (e.target !== inp) { e.preventDefault(); show(); } });
    inp.addEventListener("focus", () => show());
    inp.addEventListener("input", () => { if (!open) show(); else paint(); });
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; mark(); } return; }
      if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; mark(); } return; }
      if (e.key === "Enter") { e.preventDefault(); pick(sel); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (inp.value) { inp.value = ""; paint(); } else hide(); return; }
      /* the single-letter tool keys and the 3D view's arrows must not see the
         keys typed here */
      e.stopPropagation();
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== inp) hide(); }, 120));
    list.addEventListener("mousedown", e => e.preventDefault());
    list.addEventListener("click", e => {
      const el = e.target.closest(".oitem");
      if (el) pick(+el.dataset.i);
    });
    list.addEventListener("mousemove", e => {
      const el = e.target.closest(".oitem");
      if (el && +el.dataset.i !== sel) { sel = +el.dataset.i; mark(); }
    });
    window.addEventListener("resize", () => { if (open) place(); });

    /* Ctrl K and "/" open this box on the desktop and the tablet. The field
       layout has no top bar; there the command bar keeps both keys. */
    document.addEventListener("keydown", e => {
      if (document.body.classList.contains("field")) return;
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault(); e.stopImmediatePropagation(); show(); return;
      }
      if (!typing && e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey &&
          !(t && t.closest && t.closest(".shwin, .modal, #help, #layerMan, #layers"))) {
        e.preventDefault(); e.stopImmediatePropagation(); show();
      }
    }, true);
  }

  return { wire, show, hide, isOpen: () => open, query: q => query(q).map(i => ({ kind: i.kind, label: i.label, sub: i.sub, group: i.group })),
           pick: (q, i) => { inp.value = q; items = query(q); pick(i || 0); }, flyBox, flyPoint, fitPad };
})();
