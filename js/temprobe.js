/* SBMM Site Explorer — v53: the TEM probe (SBMM.temprobe).

   "When the mouse moves over a layer, it lets me know what I'm looking at and
   the values of that layer or section I'm looking at." Before this the only
   reading was a note in the status bar, in 2D; in 3D the slice, the cut's
   floor and walls, the sections, the stack and the voxels answered nothing,
   and the two interpretation surfaces answered with a general sentence.

   ONE READING, THREE DEPTHS OF IT:

     hover   a chip at the pointer — the value, its range, the depth and the
             elevation, the layer, the nearest sounding and what it measured
             there, with the model down that point as a small core beside it.
             2D: over the slice. 3D: over any TEM surface, at the point hit.
     click   the card — the same record in full (the nearest boring's logged
             material at that depth, which side of the calibration it reads
             on, the water level) and the profile: the model against the
             nearest sounding's own inverted model, on one log axis.
     pin     the card's "pin" keeps it: a point feature, so it is in My work,
             in the session, in the exports and undoable like any other, and
             a "TEM probes" card compares the pinned profiles on one chart.

   The record itself is SBMM.geophys.probe(x, y, at) — everything here is how
   it is shown. Nothing is interpolated in this file.

   Three rules:

     · The chip is one element, moved, for 2D and 3D alike; a move writes its
       position and, when the reading changed, its text. It asks for no frame.
     · It steps aside for the pick engine: where a well, a boring or anything
       else that answers a click is under the pointer, that thing's chip is
       the chip (js/pick2d.js in 2D; priority in js/pick3d.js in 3D).
     · In 3D a TEM surface answers only where it can be SEEN: inside the cut,
       or anywhere the ground is not solid. The pick engine never raycasts
       the terrain, so without that the part of a slice still under solid
       ground would answer through it. */
window.SBMM = window.SBMM || {};
SBMM.temprobe = (function () {
  "use strict";
  const G = () => SBMM.geophys;
  const data = () => window.SBMM_DATA && SBMM_DATA.tem2026;
  const on = id => !!(SBMM.layerState && SBMM.layerState.isOn("invest", id));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
  const f0 = v => isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—";
  const f1 = v => isFinite(v) ? (+v).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—";
  const fV = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2);
  const emit = rec => { if (SBMM.events) SBMM.events.emit("temprobe", { rec: rec || null }); };

  /* ------------------------------------------------------------------ */
  /* the small core: the model down the point, a tick at the depth        */
  /* ------------------------------------------------------------------ */
  function coreSvg(p, w, h) {
    const DM = G().dmax(), y = d => (d / DM * h).toFixed(1);
    let s = `<svg class="tpcore" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`
      + `<rect width="${w}" height="${h}" fill="#1A1612"/>`;
    for (const c of p.col) if (c.color) s += `<rect x="0" y="${y(c.top)}" width="${w}" height="${(+y(c.bot) - +y(c.top) + 0.4).toFixed(1)}" fill="${c.color}"/>`;
    if (p.inRecord) s += `<rect x="0" y="${(+y(p.depth) - 1).toFixed(1)}" width="${w}" height="2" fill="#fff"/>`
      + `<rect x="0" y="${(+y(p.depth) - 2).toFixed(1)}" width="${w}" height="1" fill="#000" opacity=".6"/>`
      + `<rect x="0" y="${(+y(p.depth) + 1).toFixed(1)}" width="${w}" height="1" fill="#000" opacity=".6"/>`;
    return s + "</svg>";
  }

  /* ------------------------------------------------------------------ */
  /* the chip                                                            */
  /* ------------------------------------------------------------------ */
  let chip = null, chipKey = "", shown = false;
  function lines(p) {
    const a = `<b class="mono">${fV(p.rho)} Ω·m</b>`
      + (p.lo != null ? `<span class="tpr mono">${fV(p.lo)}–${fV(p.hi)}</span>` : "")
      + `<span class="tpc mono">${fV(p.cond)} mS/m</span>`;
    const b = `${f0(p.depth)} ft deep · elev ${f0(p.elev)} ft · layer ${p.layer.l + 1}`;
    const c = p.snd ? `${esc(p.snd.id)} ${f0(p.snd.dist)} ft away · measured ${fV(p.snd.rho)}` : "";
    return [a, b, c];
  }
  function chipHtml(p, extra) {
    if (!p.ok) return "";
    const [a, b, c] = lines(p);
    return coreSvg(p, 9, 58)
      + `<div class="tpt"><div class="tp1">${a}</div><div class="tp2">${esc(b)}</div>`
      + (extra ? `<div class="tp2">${extra}</div>` : "")
      + (c ? `<div class="tp3">${c}</div>` : "") + `</div>`;
  }
  function ensureChip() {
    if (chip) return chip;
    chip = document.createElement("div");
    chip.id = "temTip";
    chip.setAttribute("role", "status");
    chip.hidden = true;
    document.body.appendChild(chip);
    return chip;
  }
  /* html is what to show; key says when it changed (a move over one value
     writes two style properties and nothing else) */
  function showChip(cx, cy, html, key) {
    const el = ensureChip();
    if (key !== chipKey) { el.innerHTML = html; chipKey = key; }
    el.hidden = false; shown = true;
    const w = el.offsetWidth, h = el.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    let x = cx + 16, y = cy + 18;
    if (x + w > W - 6) x = cx - w - 14;
    if (y + h > H - 6) y = cy - h - 12;
    el.style.left = Math.max(4, x) + "px";
    el.style.top = Math.max(4, y) + "px";
  }
  function hideChip() {
    if (chip && !chip.hidden) chip.hidden = true;
    if (shown) { shown = false; emit(null); }
  }
  const keyOf = p => [p.x.toFixed(1), p.y.toFixed(1), p.depth.toFixed(1), G().sigKey()].join("|");

  /* ------------------------------------------------------------------ */
  /* 2D: over the slice                                                  */
  /* ------------------------------------------------------------------ */
  let raf2 = 0, last2 = null;
  const active2d = () => !!(data() && G() && G().hasResult() && on("tem_slice")
    && !document.body.classList.contains("field"));
  function onMove2d(ev) {
    last2 = ev;
    if (raf2) return;
    raf2 = requestAnimationFrame(() => { raf2 = 0; move2d(last2); });
  }
  function move2d(ev) {
    if (!ev || !active2d()) { hideChip(); return; }
    /* a feature's own chip is the chip; so is a pressed button (a pan) */
    if ((ev.originalEvent && ev.originalEvent.buttons) || (SBMM.pick2d && SBMM.pick2d.state().chip)) { hideChip(); return; }
    const p = G().probe(ev.latlng.lng, ev.latlng.lat);
    if (!p.ok) { hideChip(); return; }
    const oe = ev.originalEvent;
    showChip(oe.clientX, oe.clientY, chipHtml(p), keyOf(p));
    emit(p);
  }
  function onClick2d(ev) {
    if (!active2d() || !ev.latlng) return;
    if (SBMM.mode && SBMM.mode.current && SBMM.mode.current() !== "navigate") return;
    if (SBMM.tools.active() || SBMM.draw.isPicking() || SBMM.draw.isDrawing()) return;
    /* anything else under the pointer that answers a click owns it */
    if (SBMM.pick2d && SBMM.pick2d.probe && SBMM.pick2d.probe(ev.latlng).some(c => c.acts)) return;
    const p = G().probe(ev.latlng.lng, ev.latlng.lat);
    if (!p.ok) return;
    hideChip();
    L.popup({ className: "tempop tppop", maxWidth: 340, minWidth: 300 })
      .setLatLng([p.y, p.x]).setContent(cardHtml(p)).openOn(SBMM.map);
  }
  let wired = false;
  function wire() {
    if (wired || !SBMM.map || !data()) return;
    wired = true;
    SBMM.map.on("mousemove", onMove2d);
    SBMM.map.on("mouseout movestart zoomstart", hideChip);
    SBMM.map.on("click", onClick2d);
    document.addEventListener("click", onAction);
    if (SBMM.events) {
      /* a slice or colour change while the pointer rests on the map */
      SBMM.events.on("tem", () => { chipKey = ""; refreshPins(); });
      SBMM.events.on("layers", ({ group }) => { if (group === "invest" || group == null) { if (!active2d()) hideChip(); } });
      SBMM.events.on("view", hideChip);
    }
    if (SBMM.store && SBMM.store.onChange) SBMM.store.onChange(() => { clearTimeout(decT); decT = setTimeout(refreshPins, 80); });
    refreshPins();
  }
  let decT = 0;

  /* ------------------------------------------------------------------ */
  /* 3D: any TEM surface, at the point the ray hit                       */
  /* ------------------------------------------------------------------ */
  /* `pick` is the object's own tag: { kind: "temsurf", what, depth?, elev?,
     vox? }. A surface says what DEPTH the hit is at in one of three ways:
     the slice and a stack sheet know theirs; a section, a wall and the floor
     take it from the hit's own height under the model's ground; a voxel is
     its cell. */
  function world(hit) {
    const V = SBMM.viewer3d;
    return V && V.toWorld ? V.toWorld(hit.point) : null;
  }
  function at3d(pick, hit) {
    const w = world(hit);
    if (!w) return null;
    const what = pick.what;
    if (what === "slice") return { x: w[0], y: w[1], at: null };
    if (what === "stack") return { x: w[0], y: w[1], at: { depth: pick.depth } };
    if (what === "vox") {
      const k = hit.index, v = pick.vox;
      if (!v || !(k >= 0) || k >= v.x.length) return null;
      return { x: v.x[k], y: v.y[k], at: { depth: v.depth[k] } };
    }
    /* a section, a wall, the floor: the hit's height. The model's own ground
       is what its depths hang from, so it is asked first. */
    const p0 = G().probe(w[0], w[1], { depth: 0 });
    if (!isFinite(p0.ground)) return null;
    return { x: w[0], y: w[1], at: { depth: Math.max(0, p0.ground - w[2]) } };
  }
  const WHAT = { slice: "depth slice", stack: "slice stack", section: "section", wall: "cut wall", floor: "cut floor", vox: "voxel" };
  /* can this hit be seen? */
  function accept3d(pick, q) {
    if (pick.what === "wall" || pick.what === "floor") return true;
    const V = SBMM.viewer3d;
    if (!V) return true;
    if (V.groundNow && V.groundNow() !== "solid") return true;
    const w = V.toWorld ? V.toWorld(q.point) : null;
    return !!(w && V.clipContains && V.clipContains(w[0], w[1]));
  }
  function hover3d(pick, hit, e) {
    const a = at3d(pick, hit);
    const p = a ? G().probe(a.x, a.y, a.at) : null;
    if (!p || !p.ok) { end3d(); return false; }
    showChip(e.clientX, e.clientY, chipHtml(p, `<i class="tpw">${esc(WHAT[pick.what] || "model")}</i>`), keyOf(p) + pick.what);
    const V = SBMM.viewer3d;
    if (V && V.probeMark) V.probeMark(hit.point);
    emit(p);
    return true;
  }
  function end3d() {
    hideChip();
    const V = SBMM.viewer3d;
    if (V && V.probeMark) V.probeMark(null);
  }
  function click3d(pick, hit) {
    const a = at3d(pick, hit);
    const p = a ? G().probe(a.x, a.y, a.at) : null;
    if (!p || !p.ok) return null;
    end3d();
    return { title: "TEM probe", html: cardHtml(p), xyz: [p.x, p.y] };
  }
  /* the two interpretation surfaces: the value at the point, not a sentence */
  function hoverInterp(what, hit, e) {
    const w = world(hit), T = SBMM.teminterp;
    const r = w && T && T.readAt ? T.readAt(what, w[0], w[1]) : null;
    if (!r) { end3d(); return false; }
    showChip(e.clientX, e.clientY, `<div class="tpt"><div class="tp1"><b class="mono">${esc(r.head)}</b></div>`
      + r.lines.map(l => `<div class="tp2">${esc(l)}</div>`).join("") + `</div>`, what + "|" + r.key);
    const V = SBMM.viewer3d;
    if (V && V.probeMark) V.probeMark(hit.point);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* the profile: the model against the nearest sounding's own model      */
  /* ------------------------------------------------------------------ */
  const PIN_COL = ["#F1CE7A", "#6FD3E8", "#E88BC4", "#9BE08A", "#F09A62", "#B9A7F5"];
  /* cols: [{ col, color, name, dash }] — step lines on one log-resistivity
     axis, depth down. marks: [{ depth, color }] horizontal ticks. */
  function profileSvg(series, marks, w, h, extra) {
    const DM = G().dmax(), Lp = 34, Rp = 8, Tp = 16, Bp = 6;
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const c of s.col) if (isFinite(c.rho) && c.rho > 0) { lo = Math.min(lo, c.rho); hi = Math.max(hi, c.rho); }
    if (!(hi > lo)) { lo = 1; hi = 100; }
    const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi)), span = Math.max(1, b - a);
    const X = v => Lp + (Math.log10(Math.max(v, 1e-6)) - a) / span * (w - Lp - Rp);
    const Y = d => Tp + d / DM * (h - Tp - Bp);
    const ink = "#8FA2AA";
    let s = `<svg class="tpprof" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace,monospace" font-size="9">`
      + `<rect x="${Lp}" y="${Tp}" width="${w - Lp - Rp}" height="${h - Tp - Bp}" fill="#0E1418" stroke="rgba(255,255,255,.14)"/>`;
    for (let e = a; e <= b; e++) {
      const x = X(Math.pow(10, e));
      s += `<line x1="${x.toFixed(1)}" y1="${Tp}" x2="${x.toFixed(1)}" y2="${h - Bp}" stroke="rgba(255,255,255,.10)"/>`
        + `<text x="${x.toFixed(1)}" y="${Tp - 5}" fill="${ink}" text-anchor="middle">${Math.pow(10, e)}</text>`;
      if (e < b) for (const m of [2, 5]) { const xm = X(m * Math.pow(10, e)); s += `<line x1="${xm.toFixed(1)}" y1="${Tp}" x2="${xm.toFixed(1)}" y2="${h - Bp}" stroke="rgba(255,255,255,.05)"/>`; }
    }
    for (let d = 0; d <= DM; d += 100) s += `<line x1="${Lp - 3}" y1="${Y(d).toFixed(1)}" x2="${Lp}" y2="${Y(d).toFixed(1)}" stroke="${ink}"/>`
      + `<text x="${Lp - 5}" y="${(Y(d) + 3).toFixed(1)}" fill="${ink}" text-anchor="end">${d}</text>`;
    if (extra) s += extra(X, Y, Lp, w - Rp);
    for (const sr of series) {
      let p = "", open = false;
      for (const c of sr.col) {
        if (!isFinite(c.rho)) { open = false; continue; }
        const x = X(c.rho).toFixed(1);
        p += (open ? "L" : "M") + x + "," + Y(c.top).toFixed(1) + "L" + x + "," + Y(c.bot).toFixed(1);
        open = true;
      }
      s += `<path d="${p}" fill="none" stroke="${sr.color}" stroke-width="${sr.w || 2}"${sr.dash ? ` stroke-dasharray="${sr.dash}"` : ""} stroke-linejoin="round"><title>${esc(sr.name)}</title></path>`;
    }
    for (const m of marks || []) if (m.depth >= 0 && m.depth <= DM)
      s += `<line x1="${Lp}" y1="${Y(m.depth).toFixed(1)}" x2="${w - Rp}" y2="${Y(m.depth).toFixed(1)}" stroke="${m.color}" stroke-width="1"${m.dash ? ` stroke-dasharray="${m.dash}"` : ""}><title>${esc(m.name || "")}</title></line>`;
    return s + `<text x="${w - Rp}" y="${h - Bp - 3}" fill="${ink}" text-anchor="end">Ω·m · ft below ground</text></svg>`;
  }
  function soundingCol(i) {
    const D = data(), out = [];
    for (let l = 0; l < D.nl; l++) out.push({ top: D.top_ft[l], bot: D.bot_ft[l], rho: D.r[i * D.nl + l] });
    return out;
  }
  function profileOf(p, w, h) {
    const series = [];
    if (p.snd) series.push({ col: soundingCol(p.snd.i), color: "#C9D3D6", w: 1.3, dash: "4 3", name: p.snd.id + " — the sounding's own model" });
    series.push({ col: p.col, color: "#E4796A", w: 2.2, name: "the model here" });
    const marks = [{ depth: p.depth, color: "#F1CE7A", name: "this depth" }];
    if (p.boring) {
      if (p.boring.native != null) marks.push({ depth: p.boring.native, color: "#E2BA14", dash: "2 3", name: p.boring.id + " native contact" });
      if (p.boring.bedrock != null) marks.push({ depth: p.boring.bedrock, color: "#9FB7C2", dash: "2 3", name: p.boring.id + " top of bedrock" });
    }
    return profileSvg(series, marks, w, h);
  }

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  function rowsOf(p) {
    const rows = [];
    rows.push(["Resistivity", `${fV(p.rho)} Ω·m` + (p.lo != null ? ` · ${fV(p.lo)}–${fV(p.hi)}` : ""),
               p.lo != null ? "The range is the kriging standard error either side, on the log scale" : ""]);
    rows.push(["Conductivity", `${fV(p.cond)} mS/m`]);
    rows.push(["Depth · elevation", `${f1(p.depth)} ft · ${f1(p.elev)} ft`]);
    rows.push(["Ground", `${f1(p.ground)} ft` + (isFinite(p.lidar) ? ` · lidar ${f1(p.lidar)}` : ""),
               "The model's ground is the soundings' own elevations, interpolated"]);
    rows.push(["Model layer", `${p.layer.l + 1} of ${p.layer.n} · ${f1(p.layer.top)}–${f1(p.layer.bot)} ft`]);
    if (p.snd) rows.push(["Nearest sounding", `${p.snd.id} · ${f0(p.snd.dist)} ft · ${fV(p.snd.rho)} Ω·m`,
                          "What that sounding's own inverted model reads at this depth"]);
    if (p.boring) rows.push(["Nearest boring", `${p.boring.id} · ${f0(p.boring.dist)} ft · `
      + (p.boring.cls ? `logged ${p.boring.cls}` : p.depth > (p.boring.total || 0) ? "below its depth" : "not classed here"),
      "From the boring's logged contacts"]);
    if (p.reads) rows.push(["Reads like", `${p.reads.like} · ${p.reads.like === "waste" ? p.reads.dir : (p.reads.dir === "above" ? "below" : "above")} ${fV(p.reads.rho)} Ω·m`,
                            `Interpreted: the one resistivity that best separates logged waste from native in ${p.reads.holes} borings, ${Math.round(p.reads.acc * 100)} % balanced accuracy`]);
    if (p.water != null) rows.push(["Water level", `${p.wet ? "below" : "above"} ${f1(p.water)} ft`, "The impoundment's surveyed level"]);
    return rows;
  }
  const rowHtml = r => `<tr${r[2] ? ` title="${esc(r[2])}"` : ""}><td>${esc(r[0])}</td><td class="mono">${esc(r[1])}</td></tr>`;
  /* the record in a card: a popup on the map, the identify card in 3D */
  let lastCard = null;
  function cardHtml(p, name) {
    lastCard = p;
    return `<div class="pop tpcard" data-tp-x="${p.x.toFixed(2)}" data-tp-y="${p.y.toFixed(2)}" data-tp-d="${p.depth.toFixed(2)}">`
      + `<b>${esc(name || "TEM probe")}</b><span class="mono tpxy"> E ${f0(p.x)} · N ${f0(p.y)}</span>`
      + `<table class="tptab">${rowsOf(p).map(rowHtml).join("")}</table>`
      + `<div class="tpprofw">${profileOf(p, 300, 190)}</div>`
      + `<div class="tpkey"><i class="k1"></i>model here` + (p.snd ? `<i class="k2"></i>${esc(p.snd.id)}` : "")
      + (p.boring ? `<i class="k3"></i>${esc(p.boring.id)} contacts` : "") + `</div>`
      + `<div class="tpnote">interpreted · planning-level</div>`
      + `<div class="pop-actions">`
      + (name ? "" : `<span class="minib" data-tp-a="pin" title="Keep this probe as a point in My work">pin</span>`)
      + `<span class="minib" data-tp-a="csv" title="Copy this probe — the point and its 20 layers — as CSV">copy CSV</span>`
      + `<span class="minib" data-tp-a="slice" title="Put the slice at this depth">slice here</span>`
      + `</div></div>`;
  }
  function recOf(el) {
    const c = el.closest(".tpcard");
    if (!c) return null;
    return G().probe(+c.dataset.tpX, +c.dataset.tpY, { depth: +c.dataset.tpD });
  }
  function onAction(e) {
    const b = e.target.closest && e.target.closest("[data-tp-a]");
    if (!b) return;
    const a = b.dataset.tpA;
    if (a === "all") { probesCard(); return; }
    if (a === "allcsv") { copyText(probesCsv()); toast("probes copied as CSV"); return; }
    const p = recOf(b);
    if (!p) return;
    if (a === "pin") { pin(p); if (SBMM.map) SBMM.map.closePopup(); if (SBMM.pick3d && SBMM.pick3d.closeCard) SBMM.pick3d.closeCard(); }
    else if (a === "csv") { copyText(G().probeCsv(p)); toast("probe copied as CSV"); }
    else if (a === "slice") { G().apply("depth", Math.round(p.depth)); }
  }
  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).catch(() => {}); return; } } catch (e) { /* fall through */ }
    const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing more to try */ }
    ta.remove();
  }

  /* ------------------------------------------------------------------ */
  /* pinned probes: point features that carry a depth                     */
  /* ------------------------------------------------------------------ */
  /* A pin is a `spot` — the point feature the app already has — whose
     provenance says it is a TEM probe and at what depth. That is what puts
     it in My work, the session file, the GeoJSON and DXF exports and the
     undo stack with no new feature type; `rebuildFeature` copies
     `props.provenance` across, so the depth survives a session round trip.
     What a pin SHOWS is derived here, from the model as it stands. */
  const isPin = f => !!(f && f.type === "spot" && f.props && f.props.provenance && f.props.provenance.source === "tem");
  function pins() {
    const out = [];
    const S = SBMM.store;
    if (!S || !S.features) return out;
    for (const f of S.features) if (isPin(f)) out.push(f);
    return out;
  }
  const recOfPin = f => G().probe(f.pts[0][0], f.pts[0][1], { depth: f.props.provenance.depth });
  function pin(p) {
    const T = SBMM.tools;
    const n = pins().reduce((m, f) => Math.max(m, +(String(f.name).match(/P(\d+)$/) || [0, 0])[1]), 0) + 1;
    const f = T.dropSpot(p.x, p.y);
    f.name = "TEM P" + n;
    f.props.provenance = { source: "tem", depth: +p.depth.toFixed(2), elev: +p.elev.toFixed(2) };
    if (T.pushCreate) T.pushCreate(f, "pin " + f.name);
    decorate(f);
    if (SBMM.store.emit) SBMM.store.emit();
    SBMM.store.select(f.id);
    if (SBMM.shell && SBMM.shell.showResults) SBMM.shell.showResults();
    return f;
  }
  /* a pin's label and its card's TEM block, from the model as it stands */
  function decorate(f) {
    if (!isPin(f) || !G() || !G().hasResult()) return;
    const p = recOfPin(f);
    const txt = p.ok ? `${f.name.replace(/^TEM /, "")} · ${fV(p.rho)} Ω·m` : f.name.replace(/^TEM /, "");
    if (f.layer && f._tpLabel !== txt) {
      try { f.layer.unbindTooltip(); f.layer.bindTooltip(txt, { permanent: true, direction: "top", className: "ctip tppin", offset: [0, -6] }); } catch (e) { /* a label is a courtesy */ }
      f._tpLabel = txt;
    }
    const card = f.card;
    if (!card || !card.isConnected) return;
    /* the card was titled when the point was dropped, before it was named */
    const rn = card.querySelector(".rname");
    if (rn && rn.textContent !== f.name && document.activeElement !== rn) rn.textContent = f.name;
    let box = card.querySelector(".tpbox");
    if (!box) { box = document.createElement("div"); box.className = "tpbox"; card.appendChild(box); }
    const sig = G().sigKey() + "|" + f.props.provenance.depth + "|" + f.name;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = p.ok ? cardHtml(p, f.name) + `<div class="pop-actions"><span class="minib" data-tp-a="all" title="Every pinned probe on one chart">compare probes</span></div>`
      : `<div class="mut">no model at this point${p.why ? " — " + esc(p.why) : ""}</div>`;
  }
  function refreshPins() {
    if (!data() || !G() || !G().hasResult()) return;
    for (const f of pins()) decorate(f);
    if (allCard && allCard.isConnected) fillAll();
  }

  /* ------------------------------------------------------------------ */
  /* every pin on one chart                                              */
  /* ------------------------------------------------------------------ */
  let allCard = null;
  function fillAll() {
    const P = pins().map((f, i) => ({ f, p: recOfPin(f), color: PIN_COL[i % PIN_COL.length] })).filter(q => q.p.col);
    const body = allCard.querySelector(".tpall");
    if (!P.length) { body.innerHTML = `<div class="mut">no pinned probes</div>`; return; }
    const series = P.map(q => ({ col: q.p.col, color: q.color, w: 2, name: q.f.name }));
    const marks = P.filter(q => q.p.inRecord).map(q => ({ depth: q.p.depth, color: q.color, dash: "3 3", name: q.f.name + " depth" }));
    body.innerHTML = profileSvg(series, marks, 320, 220)
      + `<table class="tptab tpallt"><tr><th></th><th>depth</th><th>Ω·m</th><th>layer</th><th>sounding</th></tr>`
      + P.map(q => `<tr><td><i class="sw" style="background:${q.color}"></i>${esc(q.f.name.replace(/^TEM /, ""))}</td>`
        + `<td class="mono">${q.p.inRecord ? f0(q.p.depth) : "—"}</td><td class="mono">${q.p.ok ? fV(q.p.rho) : "—"}</td>`
        + `<td class="mono">${q.p.ok ? q.p.layer.l + 1 : "—"}</td><td class="mono">${q.p.snd ? esc(q.p.snd.id) + " " + f0(q.p.snd.dist) + " ft" : "—"}</td></tr>`).join("")
      + `</table><div class="pop-actions"><span class="minib" data-tp-a="allcsv" title="Every pinned probe, layer by layer, as CSV">copy CSV</span></div>`;
    SBMM.results.setRows(allCard, [["Pinned", String(P.length)], ["Model", G().propName ? "resistivity · " + f0(G().dmax()) + " ft of record" : ""]]);
  }
  function probesCard() {
    if (!data() || !G() || !G().hasResult()) { toast("the TEM model is not loaded — turn the TEM slice on"); return null; }
    if (!pins().length) { toast("no pinned TEM probes"); return null; }
    if (allCard && allCard.isConnected) allCard.remove();
    allCard = SBMM.results.card(null, "TEM probes", []);
    allCard.classList.add("tpallcard");
    const d = document.createElement("div"); d.className = "tpall"; allCard.appendChild(d);
    SBMM.results.appendNote(allCard, "interpreted · planning-level");
    fillAll();
    if (SBMM.shell && SBMM.shell.showResults) SBMM.shell.showResults();
    return allCard;
  }
  function probesCsv() {
    const P = pins().map(f => ({ f, p: recOfPin(f) })).filter(q => q.p.col), D = data();
    let out = "# TEM probes — resistivity (ohm-m) by model layer; EPSG:6418 ft, NAVD88; planning-level\n"
      + "probe,easting_ft,northing_ft,model_ground_ft,depth_ft,resistivity_at_depth";
    for (let l = 0; l < D.nl; l++) out += `,L${l + 1}_${D.top_ft[l]}_${D.bot_ft[l]}ft`;
    out += "\n";
    for (const q of P) {
      out += [q.f.name, q.p.x.toFixed(2), q.p.y.toFixed(2), isFinite(q.p.ground) ? q.p.ground.toFixed(2) : "",
              q.p.inRecord ? q.p.depth.toFixed(1) : "", q.p.ok ? +q.p.rho.toPrecision(4) : ""].join(",");
      for (const c of q.p.col) out += "," + (isFinite(c.rho) ? +c.rho.toPrecision(4) : "");
      out += "\n";
    }
    return out;
  }

  if (SBMM.events) SBMM.events.on("boot", () => wire());

  return { wire, read: (x, y, at) => G().probe(x, y, at), chipHtml, cardHtml, profileOf, profileSvg,
           hover3d, end3d, click3d, accept3d, hoverInterp,
           pin, pins, isPin, probesCard, probesCsv, decorate, refreshPins,
           state: () => ({ chip: !!(chip && !chip.hidden), text: chip && !chip.hidden ? chip.textContent : "", pins: pins().length,
                           card: !!(allCard && allCard.isConnected) }) };
})();
