/* SBMM Site Explorer — v37: the TEM workspace (SBMM.temws).

   The 2026 TEM2Go survey given a place of its own: Data ▾ → TEM geophysics
   (or TEMWS) opens the 3D view with the ground CUT OPEN over the model, and
   puts every TEM control in one panel where the right dock was. The engineer:
   "when the depth of my slider goes below the ground surface it disappears
   under the map … the surface should disappear and show a hole in the ground
   where the slider keeps going, with a cut-away from the nearby area so we can
   see into the hole."

   Three pieces, and each lives where it belongs:

     · the EXCAVATION is the 3D view's (SBMM.viewer3d.setPit — the fence clip
       box's second source): a rectangle of ground clipped away, its floor the
       slice, its walls painted with the model, the side facing the camera
       opened into a notch. This module owns only its centre, size and switch.
     · every SETTING is the geophys module's (SBMM.geophys.apply — the one
       setter the results card also goes through), so the card and this panel
       can never disagree; `tem` events keep both showing the same values.
     · the CORE on the left of the panel is a virtual boring at the centre of
       the cut: the model straight down that point, the depth marker on it,
       the 20 layer boundaries and the nearest 2025 boring's contacts. Dragging
       it moves the depth.

   It is a VIEW, like the clip box: nothing serialises. Closing it puts the
   panels back as they were and takes the cut away; the TEM layer rows stay as
   the Layers tree has them. Field mode (a phone) has no room for a second
   panel, so there TEMWS opens the results card instead. */
window.SBMM = window.SBMM || {};
SBMM.temws = (function () {
  "use strict";
  const G = () => SBMM.geophys;
  const data = () => window.SBMM_DATA && SBMM_DATA.tem2026;
  const LS = () => SBMM.layerState;
  const on = id => !!(LS() && LS().isOn("invest", id));
  const fmt0 = v => isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—";
  const fmt1 = v => isFinite(v) ? (+v).toFixed(1) : "—";
  const fmtV = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

  const SIZES = [150, 250, 400, 600, 800, 1000, 1400, 2000];
  let el = null, active = false, pit = { on: true, open: true, cx: NaN, cy: NaN, w: 600, h: 600 };
  let before = null, coreCache = null, playT = 0, wired = false;
  /* v38: the panel's three tabs — the model, and the two interpretations
     js/teminterp.js mounts. Under an interpretation the cut and the depth
     slice step aside (both come back with the Model tab): the base of waste
     and the conductive band are read through a see-through ground, and a cut
     and a slice in front of them hide exactly what they show. */
  const TABS = [["model", "Model"], ["waste", "Base of waste"], ["seep", "Conductive zones"]];
  let tab = "model", hidSlice = false, selfOff = false;

  /* ------------------------------------------------------------------ */
  /* open / close                                                        */
  /* ------------------------------------------------------------------ */
  async function open(opts) {
    const o = opts || {};
    if (!data() || !G()) { toast("the TEM survey is not in this build"); return false; }
    if (document.body.classList.contains("field")) {
      /* a phone: the card, which carries the same controls; 3D stays a tap
         away rather than costing a phone its memory unasked */
      await G().open(o.depth);
      return false;
    }
    if (o.depth != null && isFinite(o.depth)) G().apply("depth", +o.depth);
    if (active) { if (o.tab) setTab(o.tab); paintAll(); return true; }
    const res = await G().run();
    if (!res) return false;
    wire();
    /* the slice is the floor of the cut; the sounding models stay as the
       Layers tree has them — dense along the survey lines, they stand in
       the cut like a fence and hide its floor, so they are one tick away
       rather than on by default */
    rowOn("tem_slice");
    before = { lcol: document.body.classList.contains("lcol"), v3d: SBMM.viewer3d && SBMM.viewer3d.isOpen() };
    active = true;
    document.body.classList.add("temws");
    if (!before.lcol && SBMM.shell) SBMM.shell.collapse("l", true);
    build();
    if (!isFinite(pit.cx)) centreOnSurvey(false);
    if (SBMM.viewer3d && !SBMM.viewer3d.isOpen()) await SBMM.viewer3d.toggle();
    applyPit();
    frameCut();
    paintAll();
    if (SBMM.shell) { SBMM.shell.relayout(); setTimeout(() => SBMM.shell.relayout(), 260); }
    if (o.tab && o.tab !== "model") setTab(o.tab);
    return true;
  }
  function close() {
    if (!active) return false;
    stopPlay();
    if (tab !== "model") setTab("model", true);
    active = false;
    if (SBMM.viewer3d) SBMM.viewer3d.setPit(null);
    document.body.classList.remove("temws");
    if (el) el.hidden = true;
    if (before && !before.lcol && SBMM.shell) SBMM.shell.collapse("l", false);
    if (before && !before.v3d && SBMM.viewer3d && SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
    before = null;
    if (SBMM.shell) { SBMM.shell.relayout(); setTimeout(() => SBMM.shell.relayout(), 260); }
    return true;
  }
  function rowOn(id) {
    if (on(id)) return;
    const rows = G().rows ? G().rows() : {}, r = rows[id];
    if (r && r.cb) r.cb.click(); else LS().set("invest", id, { on: true });
  }
  function rowSet(id, want) {
    if (on(id) === !!want) return;
    const rows = G().rows ? G().rows() : {}, r = rows[id];
    if (r && r.cb) r.cb.click(); else LS().set("invest", id, { on: !!want });
  }

  /* ------------------------------------------------------------------ */
  /* the excavation                                                      */
  /* ------------------------------------------------------------------ */
  function applyPit() {
    if (!SBMM.viewer3d) return;
    /* taking the cut away ourselves must not read as a fence replacing it
       (the `pit` listener below) — that would switch it off for good */
    if (!active || !pit.on || tab !== "model") { selfOff = true; try { SBMM.viewer3d.setPit(null); } finally { selfOff = false; } return; }
    SBMM.viewer3d.setPit({ cx: pit.cx, cy: pit.cy, w: pit.w, h: pit.h, open: pit.open });
  }
  /* the centre of the soundings (their medians — the survey is lines, and a
     mean would sit in the gap between two of them as readily as on one) */
  function surveyCentre() {
    const D = data(), xs = D.x.slice().sort((a, b) => a - b), ys = D.y.slice().sort((a, b) => a - b);
    return [xs[xs.length >> 1], ys[ys.length >> 1]];
  }
  function centreOnSurvey(apply) {
    const [cx, cy] = surveyCentre();
    pit.cx = cx; pit.cy = cy;
    if (apply !== false) { applyPit(); coreCache = null; paintAll(); }
  }
  function fitSurvey() {
    const R = G().result();
    if (!R) return;
    const x1 = R.x0 + (R.nx - 1) * R.dx, y1 = R.y0 + (R.ny - 1) * R.dx;
    pit.cx = (R.x0 + x1) / 2; pit.cy = (R.y0 + y1) / 2;
    pit.w = Math.round(x1 - R.x0 + 40); pit.h = Math.round(y1 - R.y0 + 40);
    applyPit(); coreCache = null; frameCut(); paintAll();
  }
  function centreOnView() {
    const t = SBMM.viewer3d && SBMM.viewer3d.targetXY ? SBMM.viewer3d.targetXY() : null;
    if (!t) { toast("open the 3D view to centre the cut on it"); return; }
    pit.cx = t[0]; pit.cy = t[1];
    applyPit(); coreCache = null; paintAll();
  }
  function setSize(w) {
    pit.w = pit.h = Math.max(100, Math.min(4000, +w || 600));
    applyPit(); paintAll();
  }
  /* look into the cut from the south-west and lower than the iso preset,
     so its walls read as walls */
  function frameCut() {
    const V = SBMM.viewer3d;
    if (!V || !V.isOpen() || !isFinite(pit.cx)) return;
    const r = Math.max(pit.w, pit.h) * 0.75;
    V.frameBox(pit.cx - r, pit.cy - r, pit.cx + r, pit.cy + r);
    if (V.orbitTo) V.orbitTo(-2.36, 1.08); else V.preset("iso");
  }

  /* ------------------------------------------------------------------ */
  /* depth                                                               */
  /* ------------------------------------------------------------------ */
  const DM = () => G().dmax ? G().dmax() : 394;
  function setDepth(d) { G().apply("depth", Math.max(0, Math.min(Math.floor(DM()), Math.round(d)))); }
  function stepLayer(dir) {
    const D = data(), d = G().depth();
    const tops = D.top_ft.map(Math.round), i = G().layerInfo(d).l;
    const j = Math.max(0, Math.min(D.nl - 1, i + dir));
    setDepth(j === i ? (dir > 0 ? D.bot_ft[D.nl - 1] : 0) : tops[j] + (j ? 0.5 : 0));
  }
  /* a slow descent, one step per tick; anything the user does stops it */
  function play() {
    if (playT) { stopPlay(); return; }
    if (G().depth() >= Math.floor(DM()) - 1) setDepth(0);
    const btn = el && el.querySelector('[data-a="play"]');
    if (btn) { btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); }
    playT = setInterval(() => {
      if (!active) { stopPlay(); return; }
      const d = G().depth() + 4;
      if (d >= Math.floor(DM())) { setDepth(DM()); stopPlay(); return; }
      setDepth(d);
    }, 160);
  }
  function stopPlay() {
    if (!playT) return;
    clearInterval(playT); playT = 0;
    const btn = el && el.querySelector('[data-a="play"]');
    if (btn) { btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); }
  }

  /* ------------------------------------------------------------------ */
  /* the panel                                                           */
  /* ------------------------------------------------------------------ */
  function sel(k, opts, cur, title) {
    return `<select data-k="${k}" title="${esc(title)}">` + opts.map(([v, t]) =>
      `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(t)}</option>`).join("") + `</select>`;
  }
  function chk(k, label, onv, title, attr) {
    return `<label class="temchk" title="${esc(title)}"><input type="checkbox" ${attr || "data-k"}="${k}"${onv ? " checked" : ""}> ${esc(label)}</label>`;
  }
  function build() {
    if (!el) {
      el = document.createElement("aside");
      el.id = "temWs";
      el.className = "glass";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", "TEM geophysics");
      document.body.appendChild(el);
      el.addEventListener("input", onInput);
      el.addEventListener("change", onChange);
      el.addEventListener("click", onClick);
    }
    el.hidden = false;
    const S = G().settings(), D = data(), R = G().result(), O = G().options();
    const sz = SIZES.includes(pit.w) && pit.w === pit.h ? pit.w : "";
    el.innerHTML =
      `<header class="twsh"><div><b>TEM geophysics</b>`
      + `<span class="twssub">TEM2Go · LCI models · May 2026 · ${fmt0(D.n)} soundings to ${fmt0(DM())} ft</span></div>`
      + `<button class="twsx" data-a="close" title="Close the TEM workspace" aria-label="Close the TEM workspace">×</button></header>`
      + `<nav class="twstabs" role="tablist" aria-label="TEM analyses">` + TABS.map(([k, t]) =>
          `<button class="twstab${k === tab ? " on" : ""}" role="tab" data-tab="${k}" aria-selected="${k === tab}">${esc(t)}</button>`).join("") + `</nav>`
      + `<div class="twsb temctl" data-pane="model"${tab === "model" ? "" : " hidden"}>`
      /* depth: the core and the readout */
      + `<section class="twsdepth">`
      + `<canvas class="twscore" width="60" height="300" role="slider" tabindex="0" aria-label="Depth below ground"`
      + ` aria-valuemin="0" aria-valuemax="${Math.floor(DM())}" title="The model straight down the centre of the cut"></canvas>`
      + `<div class="twsread">`
      + `<div class="twsdbig mono"><span data-o="depth"></span><small> ft below ground</small></div>`
      + `<div class="mut" data-o="layer"></div>`
      + `<div class="twsval mono" data-o="val"></div>`
      + `<div class="mut twsnear" data-o="near"></div>`
      + `<div class="twsbtns">`
      + `<button class="minib" data-a="up" title="Up one model layer [PgUp]">▲ layer</button>`
      + `<button class="minib" data-a="down" title="Down one model layer [PgDn]">▼ layer</button>`
      + `<button class="minib" data-a="play" aria-pressed="false" title="Descend through the model">▶ descend</button></div>`
      + `<input type="range" data-k="depth" min="0" max="${Math.floor(DM())}" step="1" value="${S.depth}" aria-label="Depth">`
      + `</div></section>`
      /* the cut */
      + `<section><h4>Excavation</h4>`
      + `<div class="twschks">${chk("on", "cut the ground open", pit.on, "Clip the ground over the cut down to the slice depth", "data-p")}`
      + chk("open", "open toward the view", pit.open, "Run the cut on toward the camera so its floor shows", "data-p") + `</div>`
      + `<div class="temgrid2"><label>Size ${sel("size", [["", "custom"]].concat(SIZES.map(v => [v, v + " ft"])), sz, "Width of the cut")}</label>`
      + `<label>Ground ${sel("ground", [["auto", "auto"], ["solid", "solid"], ["see", "see-through"], ["hidden", "hidden"]],
          SBMM.viewer3d ? SBMM.viewer3d.ground() : "auto", "How the terrain draws around the cut")}</label></div>`
      + `<div class="twsbtns"><button class="minib" data-a="centre" title="Move the cut to the centre of the 3D view">centre on view</button>`
      + `<button class="minib" data-a="survey" title="Open the whole surveyed area">whole survey</button>`
      + `<button class="minib" data-a="frame" title="Frame the cut">frame</button></div>`
      + `<div class="mut mono" data-o="cut"></div></section>`
      /* what is drawn */
      + `<section><h4>Show</h4><div class="twschks">`
      + chk("tem_slice", "depth slice", on("tem_slice"), "The slice at the depth — the floor of the cut", "data-row")
      + chk("cols", "sounding models", S.cols && on("tem_soundings"), "Each sounding's own 20-layer model as a column")
      + chk("ew", "E–W section", S.ew, "A vertical east–west section through the model")
      + chk("ns", "N–S section", S.ns, "A vertical north–south section through the model")
      + chk("stack", "slice stack", S.stack, "A slice at every chosen layer")
      + chk("vox", "voxels", S.vox, "Every model cell inside the voxel range")
      + `</div>`
      + `<label class="temrow" title="Northing of the east–west section">E–W at <output data-o="ewI"></output>`
      + `<input type="range" data-k="ewI" min="0" max="${R ? R.ny - 1 : 0}" step="1"></label>`
      + `<label class="temrow" title="Easting of the north–south section">N–S at <output data-o="nsI"></output>`
      + `<input type="range" data-k="nsI" min="0" max="${R ? R.nx - 1 : 0}" step="1"></label>`
      + `<label class="temrow" title="Voxels shown, as positions across the colour range">Voxels <output data-o="vox"></output>`
      + `<span class="tempair"><input type="range" data-k="voxLo" min="0" max="100" step="1" value="${S.voxLo}">`
      + `<input type="range" data-k="voxHi" min="0" max="100" step="1" value="${S.voxHi}"></span></label>`
      + `</section>`
      /* colour */
      + `<section><h4>Colour</h4><div class="temgrid2">`
      + `<label>Property ${sel("prop", [["res", "Resistivity"], ["cond", "Conductivity"], ["sig", "Kriging s.e."]], S.prop, "What the model shows")}</label>`
      + `<label>Colours ${sel("cmap", O.cmap, S.cmap, "Colour map")}</label>`
      + `<label>Classes ${sel("classes", [[0, "continuous"], [5, "5"], [8, "8"], [12, "12"]], S.classes, "Colour classes")}</label>`
      + `<label>Contours ${sel("nCont", [[0, "off"], [8, "8 levels"], [12, "12 levels"], [20, "20 levels"]], S.contours ? S.nCont : 0, "Contour edges across the colour range")}</label>`
      + `</div><div class="twschks">${chk("rev", "reverse colours", S.rev, "Reverse the colour map")}`
      + chk("blend", "blend between layers", S.blend, "Blend between model-layer mid-depths rather than step at layer boundaries") + `</div>`
      + `<div class="twsleg" data-o="legend"></div>`
      + `<div class="twsbtns"><button class="minib" data-a="fit" title="Colour range from 2–98 % of the soundings">fit range</button></div>`
      + `</section>`
      /* the interpolation */
      + `<section><h4>Model</h4><div class="temgrid2">`
      + `<label>Method ${sel("method", O.method, S.method, "Interpolation, one model layer at a time")}</label>`
      + `<label>Variogram ${sel("vgType", O.vgType, S.vgType, "Kriging variogram model, fitted to the data")}</label>`
      + `<label>Grid cell ${sel("cell", [10, 15, 20, 30, 40].map(v => [v, v + " ft"]), S.cell, "Grid node spacing")}</label>`
      + `<label>Blank beyond ${sel("blank", [20, 40, 60, 100, 150, 250].map(v => [v, v + " ft"]), S.blank, "No value farther than this from a sounding")}</label>`
      + `</div><div class="twschks">${chk("per", "variogram per layer", S.per, "Fit a variogram to each layer rather than one to all")}</div>`
      + `<div class="mut mono" data-o="model"></div></section>`
      /* the borings */
      + `<section><h4>Against the 2025 borings</h4><div class="mono twscal" data-o="cal"></div>`
      + `<div class="twsbtns"><button class="minib" data-a="cal" title="Resistivity against each boring's logged classes (TEMCAL)">open the table</button></div></section>`
      /* out */
      + `<section class="twsacts"><button class="minib" data-a="png" title="The slice as a PNG">slice PNG</button>`
      + `<button class="minib" data-a="csv" title="The slice as CSV (easting, northing, value)">slice CSV</button>`
      + `<button class="minib" data-a="model" title="Every node and every layer as CSV">model CSV</button>`
      + `<button class="minib" data-a="card" title="The results card">card</button></section>`
      + `</div>`
      + `<div class="twsb temctl" data-pane="waste" data-ti-pane="waste"${tab === "waste" ? "" : " hidden"}></div>`
      + `<div class="twsb temctl" data-pane="seep" data-ti-pane="seep"${tab === "seep" ? "" : " hidden"}></div>`;
    wireCore();
    if (SBMM.teminterp) {
      SBMM.teminterp.mount("waste", el.querySelector('[data-pane="waste"]'));
      SBMM.teminterp.mount("seep", el.querySelector('[data-pane="seep"]'));
    }
  }

  /* everything the panel shows that a setting can move */
  function paintAll() {
    if (!active || !el) return;
    const S = G().settings(), R = G().result(), D = data();
    const q = s => el.querySelector(s);
    const setO = (k, t) => { const o = q(`[data-o="${k}"]`); if (o) o.textContent = t; };
    for (const inp of el.querySelectorAll("[data-k]")) {
      const k = inp.dataset.k;
      if (document.activeElement === inp && inp.type === "range") continue;
      if (inp.type === "checkbox") inp.checked = k === "cols" ? !!(S.cols && on("tem_soundings")) : !!S[k];
      else if (k === "nCont") inp.value = S.contours ? S.nCont : 0;
      else if (k === "ground") inp.value = SBMM.viewer3d ? SBMM.viewer3d.ground() : "auto";
      else if (k === "size") inp.value = SIZES.includes(pit.w) && pit.w === pit.h ? pit.w : "";
      else if (k === "ewI" || k === "nsI") inp.value = R ? secIdx(k, R) : 0;
      else if (k in S) inp.value = S[k];
    }
    for (const inp of el.querySelectorAll("[data-row]")) inp.checked = on(inp.dataset.row);
    for (const inp of el.querySelectorAll("[data-p]")) inp.checked = !!pit[inp.dataset.p];
    const d = S.depth, L = G().layerInfo(d);
    setO("depth", fmt0(d));
    setO("layer", `layer ${L.l + 1} of ${L.n} · ${fmt1(L.top)}–${fmt1(L.bot)} ft`);
    const v = isFinite(pit.cx) ? G().valueAtDepth(pit.cx, pit.cy, d) : NaN;
    setO("val", isFinite(v) ? `${fmtV(v)} ${G().unit()} at the centre of the cut` : "no model at the centre of the cut");
    const ns = nearestSounding(pit.cx, pit.cy);
    const nb = nearestBoring(pit.cx, pit.cy);
    setO("near", (ns ? `nearest sounding ${D.id[ns.i]} · ${fmt0(ns.d)} ft` : "")
      + (nb ? ` · ${nb.h.id} ${fmt0(nb.d)} ft (contacts on the core)` : ""));
    if (R) {
      setO("ewI", `N ${fmt0(R.y0 + secIdx("ewI", R) * R.dx)}`);
      setO("nsI", `E ${fmt0(R.x0 + secIdx("nsI", R) * R.dx)}`);
      setO("model", `${R.nx} × ${R.ny} nodes at ${fmt0(R.dx)} ft · ${fmt0(R.nodes)} within ${fmt0(R.blank)} ft of a sounding · ${fmt0(R.ms_wall)} ms`);
    }
    const rg = G().range(), lo = Math.min(S.voxLo, S.voxHi) / 100, hi = Math.max(S.voxLo, S.voxHi) / 100;
    setO("vox", rg ? `${Math.round(lo * 100)}–${Math.round(hi * 100)} % of the scale` : "");
    const lg = q('[data-o="legend"]');
    if (lg) lg.innerHTML = G().legendSvg ? G().legendSvg(300) : "";
    const ps = SBMM.viewer3d && SBMM.viewer3d.pitState ? SBMM.viewer3d.pitState() : null;
    setO("cut", ps && ps.on ? `${fmt0(pit.w)} × ${fmt0(pit.h)} ft at E ${fmt0(pit.cx)} N ${fmt0(pit.cy)}`
      + (ps.ext ? ` · open ${ {n: "north", s: "south", e: "east", w: "west"}[ps.side] || ""} ${fmt0(ps.ext)} ft` : "")
      : pit.on ? "the cut opens in the 3D view" : "ground closed");
    paintCal();
    paintCore();
  }
  function secIdx(k, R) {
    const S = G().settings(), n = k === "ewI" ? R.ny : R.nx, v = S[k];
    return v < 0 || v >= n ? Math.floor(n / 2) : Math.round(v);
  }
  function nearestSounding(x, y) {
    const D = data();
    if (!D || !isFinite(x)) return null;
    let bi = -1, bd = Infinity;
    for (let i = 0; i < D.n; i++) { const d = Math.hypot(D.x[i] - x, D.y[i] - y); if (d < bd) { bd = d; bi = i; } }
    return bi < 0 ? null : { i: bi, d: bd };
  }
  function paintCal() {
    const o = el && el.querySelector('[data-o="cal"]');
    if (!o) return;
    const C = G().calibrate ? G().calibrate() : null;
    if (!C || !C.holes.length) { o.textContent = "no 2025 boring inside the survey"; return; }
    const c = C.classes, m = k => c[k] && c[k].median != null ? fmtV(c[k].median) : "—", T = C.threshold;
    o.innerHTML = `${C.holes.length} borings inside the survey<br>`
      + `waste ${m("waste")} · native ${m("native")} · bedrock ${m("bedrock")} Ω·m (medians)`
      + (T ? `<br>waste ${T.dir} ${fmtV(T.rho)} Ω·m · ${Math.round(T.acc * 100)} % balanced accuracy` : "")
      + `<br><span class="mut">interpreted · planning-level</span>`;
  }

  /* ------------------------------------------------------------------ */
  /* the core: a virtual boring at the centre of the cut                  */
  /* ------------------------------------------------------------------ */
  const CORE = { top: 14, bot: 10, x0: 26, w: 22 };
  function nearestBoring(x, y) {
    const B = SBMM.borelogs;
    if (!B || !B.holes || !B.has || !B.has()) return null;
    let best = null;
    for (const h of B.holes()) {
      if (!isFinite(h.x)) continue;
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= 150 && (!best || d < best.d)) best = { h, d };
    }
    return best;
  }
  function paintCore() {
    const cv = el && el.querySelector(".twscore");
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), CW = 60, CH = 300;
    if (cv.width !== CW * dpr) { cv.width = CW * dpr; cv.height = CH * dpr; }
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, CW, CH);
    const H = CH - CORE.top - CORE.bot, dm = DM(), yOf = d => CORE.top + d / dm * H;
    const sig = (G().sigKey ? G().sigKey() : "") + "|" + pit.cx + "|" + pit.cy;
    if (!coreCache || coreCache.sig !== sig) coreCache = { sig, c: G().core(pit.cx, pit.cy, 150) };
    const C = coreCache.c;
    /* the column */
    x.fillStyle = "#1A1612"; x.fillRect(CORE.x0, CORE.top, CORE.w, H);
    for (let i = 0; i < C.length; i++) {
      const y0 = CORE.top + i / C.length * H, y1 = CORE.top + (i + 1) / C.length * H;
      if (C[i].color) { x.fillStyle = C[i].color; x.fillRect(CORE.x0, y0, CORE.w, y1 - y0 + 0.6); }
    }
    /* the 20 layer boundaries */
    const D = data();
    x.fillStyle = "rgba(0,0,0,.35)";
    for (let l = 0; l < D.nl - 1; l++) x.fillRect(CORE.x0, Math.round(yOf(D.bot_ft[l])), CORE.w, 1);
    x.strokeStyle = "rgba(255,255,255,.25)"; x.lineWidth = 1;
    x.strokeRect(CORE.x0 + 0.5, CORE.top + 0.5, CORE.w - 1, H - 1);
    /* the depth axis */
    x.fillStyle = "#93A7B2"; x.font = "9px ui-monospace, monospace"; x.textAlign = "right"; x.textBaseline = "middle";
    for (let d = 0; d <= dm; d += 100) { x.fillText(String(d), CORE.x0 - 4, yOf(d)); x.fillRect(CORE.x0 - 3, Math.round(yOf(d)), 3, 1); }
    /* the nearest boring's logged contacts */
    const nb = nearestBoring(pit.cx, pit.cy);
    if (nb) {
      const c = nb.h.contacts || {};
      const tick = (d, col) => { if (d == null || !(d >= 0)) return; x.fillStyle = col; x.fillRect(CORE.x0 + CORE.w + 1, Math.round(yOf(d)) - 1, 7, 2); };
      tick(c.native_contact, "#E2BA14");
      tick(c.bedrock_top, "#C9D3D6");
    }
    /* the depth marker */
    const yd = yOf(G().depth());
    x.fillStyle = "#F1CE7A";
    x.fillRect(CORE.x0 - 6, Math.round(yd) - 1, CORE.w + 12, 2);
    x.beginPath(); x.moveTo(CORE.x0 + CORE.w + 6, yd); x.lineTo(CORE.x0 + CORE.w + 12, yd - 5); x.lineTo(CORE.x0 + CORE.w + 12, yd + 5); x.fill();
    cv.setAttribute("aria-valuenow", String(G().depth()));
    cv.dataset.depth = String(G().depth());
    cv.dataset.boring = nb ? nb.h.id : "";
    cv.dataset.cells = String(C.filter(c => c.color).length);
  }
  function wireCore() {
    const cv = el.querySelector(".twscore");
    if (!cv) return;
    let drag = false, raf = 0, lastY = 0;
    const depthAt = cy => {
      const r = cv.getBoundingClientRect(), H = r.height * (300 - CORE.top - CORE.bot) / 300;
      const top = r.top + r.height * CORE.top / 300;
      return Math.max(0, Math.min(1, (cy - top) / H)) * DM();
    };
    const go = () => { raf = 0; setDepth(depthAt(lastY)); };
    cv.addEventListener("pointerdown", e => {
      stopPlay(); drag = true; lastY = e.clientY;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      go();
    });
    cv.addEventListener("pointermove", e => {
      if (!drag) return;
      lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(go);
    });
    const up = () => { drag = false; };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("keydown", e => {
      const k = e.key;
      if (k === "ArrowDown" || k === "ArrowUp") { setDepth(G().depth() + (k === "ArrowDown" ? 5 : -5)); e.preventDefault(); e.stopPropagation(); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */
  function onInput(e) {
    const t = e.target, k = t.dataset.k;
    if (!k) return;
    if (k === "depth") { stopPlay(); setDepth(+t.value); return; }
    if (k === "ewI" || k === "nsI" || k === "voxLo" || k === "voxHi") G().apply(k, +t.value);
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.p) {
      pit[t.dataset.p] = t.checked;
      applyPit(); paintAll();
      return;
    }
    if (t.dataset.row) { rowSet(t.dataset.row, t.checked); setTimeout(paintAll, 0); return; }
    const k = t.dataset.k;
    if (!k || k === "depth" || k === "ewI" || k === "nsI" || k === "voxLo" || k === "voxHi") return;
    if (k === "size") { if (t.value) setSize(+t.value); return; }
    if (k === "ground") { if (SBMM.viewer3d) SBMM.viewer3d.setGround(t.value); paintAll(); return; }
    if (k === "cols") {
      if (t.checked && !on("tem_soundings")) rowOn("tem_soundings");
      G().apply("cols", t.checked);
      return;
    }
    G().apply(k, t.type === "checkbox" ? t.checked : t.value);
  }
  /* the tab: its pane shown, and under an interpretation the cut and the
     slice out of the way and the interpretation computed */
  function setTab(t, quiet) {
    if (!TABS.some(x => x[0] === t)) return;
    tab = t;
    if (el) {
      for (const b of el.querySelectorAll(".twstab")) { const onT = b.dataset.tab === t; b.classList.toggle("on", onT); b.setAttribute("aria-selected", String(onT)); }
      for (const p of el.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== t;
    }
    if (t === "model") {
      if (hidSlice) { hidSlice = false; rowSet("tem_slice", true); }
    } else if (on("tem_slice")) { hidSlice = true; rowSet("tem_slice", false); }
    applyPit();
    if (quiet) return;
    if (t !== "model" && SBMM.teminterp) SBMM.teminterp.activate(t).then(() => { if (active && tab === t) frameTab(t); });
    else frameCut();
    paintAll();
  }
  function frameTab(t) {
    const b = el && el.querySelector(`[data-pane="${t}"] [data-ti-a="${t === "waste" ? "wframe" : "sframe"}"]`);
    if (b) b.click();
  }
  function onClick(e) {
    const tb = e.target.closest("[data-tab]");
    if (tb) { stopPlay(); setTab(tb.dataset.tab); return; }
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a !== "play") stopPlay();
    if (a === "close") close();
    else if (a === "up") stepLayer(-1);
    else if (a === "down") stepLayer(1);
    else if (a === "play") play();
    else if (a === "centre") centreOnView();
    else if (a === "survey") fitSurvey();
    else if (a === "frame") frameCut();
    else if (a === "card") G().open();
    else G().action(a);
  }
  function onKey(e) {
    if (!active || (e.key !== "PageUp" && e.key !== "PageDown")) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    stepLayer(e.key === "PageDown" ? 1 : -1);
    e.preventDefault();
  }
  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener("keydown", onKey);
    if (!SBMM.events) return;
    SBMM.events.on("tem", ({ key }) => {
      if (!active) return;
      if (key !== "depth") coreCache = null;
      paintAll();
    });
    SBMM.events.on("pit", ps => {
      if (!active) return;
      /* a fence clip box took the cut's place (the spec is gone while the
         view is open — closing 3D keeps it, to put the cut back on reopen) */
      if (!selfOff && ps && !ps.on && !ps.spec && pit.on && SBMM.viewer3d && SBMM.viewer3d.isOpen()) pit.on = false;
      paintAll();
    });
    SBMM.events.on("layers", ({ group }) => { if (active && (group === "invest" || group == null)) paintAll(); });
    /* the cut is a 3D view state: closing 3D takes it away, opening it again
       puts it back */
    SBMM.events.on("view", ({ open: o }) => { if (active && o) { applyPit(); paintAll(); } });
  }

  function state() {
    return { open: active, pit: Object.assign({}, pit), playing: !!playT, tab,
             panel: !!(el && !el.hidden), depth: G() ? G().depth() : null };
  }
  return { open, close, isOpen: () => active, state, setSize, centreOnView, centreOnSurvey: () => centreOnSurvey(true),
           fitSurvey, setPit: p => { Object.assign(pit, p || {}); applyPit(); paintAll(); },
           play, stopPlay, stepLayer, paint: paintAll, setTab: t => setTab(t) };
})();
