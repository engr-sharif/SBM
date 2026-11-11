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

   It is a VIEW, like the clip box: nothing serialises. Field mode (a phone)
   has no room for a second panel, so there TEMWS opens the results card
   instead.

   v51 — TEM IS ONE THING TO TURN OFF. The panel used to have one way out, a
   cross that hid the panel and the cut and left whatever TEM rows were on —
   so the 3D ground stayed see-through, on every later visit, with nothing on
   screen saying why (the engineer: "even after I turn it off the ground
   doesn't return"). Now:

     off()    every TEM row off, the cut closed, the cards closed, a
              see-through or hidden ground back to auto, the panels back as
              they were. The panel's cross, Data ▾ → TEM geophysics while
              the panel is open, and TEMOFF.
     hide()   the panel and the cut away, the TEM layers left on — what the
              cross used to do. `close()` is this, under its old name.
     the chip while any TEM row is on and the panel is not: "TEM on" with
              "open" and "turn off", bottom-centre of the stage, so a TEM
              layer left on is never a mystery. */
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
  let tab = "model", hidSlice = false, hidCols = false, selfOff = false;
  /* v53: the probe's record while the pointer is on the model (js/temprobe.js
     emits `temprobe`). The core then shows the model under the POINTER — a
     virtual boring that follows the hand — and goes back to the centre of the
     cut when the pointer leaves. */
  let hov = null;

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
    paintChip();
    return true;
  }
  /* hide(): the panel and the cut away, the TEM layers as they are */
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
    paintChip();
    return true;
  }
  /* off(): TEM off as a whole. Works with the panel hidden and on a phone,
     where there is no panel at all. */
  function off(quiet) {
    if (!G()) return false;
    const was = active || G().anyOn();
    stopPlay();
    /* the Model tab's "put the slice back" must not run: it would start a
       job whose card arrives after everything has been turned off */
    hidSlice = false; hidCols = false;
    if (active) close();
    for (const id of G().TEM_ROWS) rowSet(id, false);
    G().closeCards();
    const V = SBMM.viewer3d;
    if (V && V.ground && V.setGround && (V.ground() === "see" || V.ground() === "hidden")) V.setGround("auto");
    paintChip();
    if (was && !quiet) toast("TEM off");
    return was;
  }
  /* Data ▾ → TEM geophysics: opens the workspace, and with it open turns TEM off */
  function toggle(opts) { return active ? (off(), false) : open(opts); }

  /* ------------------------------------------------------------------ */
  /* the chip: TEM is on and the panel is not                            */
  /* ------------------------------------------------------------------ */
  let chip = null;
  function paintChip() {
    const onNow = !!(G() && data() && G().anyOn());
    const mb = document.getElementById("temMenuBtn");
    if (mb) { mb.classList.toggle("on", onNow || active); mb.setAttribute("aria-pressed", String(onNow || active)); }
    const show = onNow && !active;
    if (!show) { if (chip) chip.hidden = true; return; }
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "temChip";
      chip.setAttribute("role", "status");
      chip.innerHTML = `<span class="tchn">TEM on</span><span class="tchw"></span>`
        + `<button class="minib" data-c="open" title="Open the TEM panel">open</button>`
        + `<button class="minib" data-c="off" title="Turn TEM off — every TEM layer off, the ground solid">turn off</button>`;
      chip.addEventListener("click", e => {
        const b = e.target.closest("[data-c]"); if (!b) return;
        if (b.dataset.c === "off") off(); else open();
      });
      document.body.appendChild(chip);
    }
    chip.hidden = false;
    const n = G().rowsOn().length, V = SBMM.viewer3d;
    const see = !!(V && V.isOpen && V.isOpen() && V.groundNow && V.groundNow() !== "solid");
    chip.querySelector(".tchw").textContent = `${n} layer${n === 1 ? "" : "s"}` + (see ? " · ground see-through over the survey" : "");
    chip.dataset.rows = String(n);
    chip.dataset.see = String(see);
    const ob = chip.querySelector('[data-c="open"]');
    if (ob) ob.hidden = document.body.classList.contains("field");
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
  /* v52 — the panel's sections, and the four views                      */
  /* ------------------------------------------------------------------ */
  /* which sections are open: the reading and the view are always shown; the
     interpolation is advanced and starts closed */
  const SEC_DEF = { view: false, colour: true, model: false, borings: true };
  function secState() {
    let st = null;
    try { st = SBMM.view && SBMM.view.pref("temSecs"); } catch (e) { /* ignore */ }
    const out = Object.assign({}, SEC_DEF);
    if (st && typeof st === "object") for (const k in SEC_DEF) if (typeof st[k] === "boolean") out[k] = st[k];
    return out;
  }
  /* A VIEW IS A WHOLE ANSWER. The six "show" boxes fought each other — the
     sounding columns stand in the cut and hide its floor, the slice sheet
     hides the voxels under it — so the panel leads with four views that each
     set all of them, and keeps the boxes under "Customise".
       pit    the ground cut open        slice  the depth-slice row
       snd    the soundings row on       s      the model's 3D settings */
  const PRESETS = {
    cut: { label: "Slice in cut", title: "The ground cut open down to the slice", pit: true, slice: true,
           s: { sheet: true, cols: false, ew: false, ns: false, stack: false, vox: false } },
    sections: { label: "Sections", title: "Two vertical sections through the model, under a see-through ground", pit: false, slice: true,
                s: { sheet: true, cols: false, ew: true, ns: true, stack: false, vox: false } },
    soundings: { label: "Soundings", title: "Each sounding's own measured 20-layer model — nothing interpolated", pit: false, slice: false, snd: true,
                 s: { cols: true, ew: false, ns: false, stack: false, vox: false } },
    volume: { label: "Volume", title: "Every model cell inside the voxel range", pit: false, slice: true,
              s: { sheet: false, cols: false, ew: false, ns: false, stack: false, vox: true } }
  };
  const colsOn = () => !!(G().settings().cols && on("tem_soundings"));
  function presetNow() {
    const S = G().settings();
    for (const k in PRESETS) {
      const p = PRESETS[k];
      if (!!pit.on !== p.pit || on("tem_slice") !== p.slice) continue;
      if (p.snd && !on("tem_soundings")) continue;
      let ok = true;
      for (const key in p.s) {
        const have = key === "cols" ? colsOn() : !!S[key];
        if (have !== p.s[key]) { ok = false; break; }
      }
      if (ok) return k;
    }
    return "";
  }
  function applyPreset(k) {
    const p = PRESETS[k];
    if (!p) return;
    stopPlay();
    pit.on = p.pit;
    if (p.snd) rowOn("tem_soundings");
    rowSet("tem_slice", p.slice);
    const S = G().settings();
    for (const key in p.s) {
      const have = key === "cols" ? colsOn() : !!S[key];
      if (have !== p.s[key]) G().apply(key, p.s[key]);
    }
    applyPit();
    if (p.pit) frameCut();
    paintAll();
  }

  /* ------------------------------------------------------------------ */
  /* the slice's position: a depth, or an elevation                      */
  /* ------------------------------------------------------------------ */
  const DM = () => G().dmax ? G().dmax() : 394;
  /* the ground under the centre of the cut — what turns an elevation into a
     depth on the core, and back */
  function centreGround() {
    if (!isFinite(pit.cx)) return NaN;
    const z = SBMM.elev ? SBMM.elev(pit.cx, pit.cy)[0] : NaN;
    return z;
  }
  /* the slice's depth under the centre of the cut, whichever datum it is in */
  function depthNow() {
    if (!G().byElev()) return G().depth();
    const d = G().depthUnder(centreGround());
    return isFinite(d) ? d : 0;
  }
  /* put the slice at a depth under the centre of the cut */
  function setDepth(d) {
    const dd = Math.max(0, Math.min(Math.floor(DM()), d));
    if (G().byElev()) {
      const zc = centreGround();
      /* floor, so the depth it makes is never ABOVE the one asked for: a
         layer step asks for a layer's top, and half a foot short of it is
         the layer above */
      if (isFinite(zc)) { G().apply("elev", Math.floor(zc - dd)); return; }
    }
    G().apply("depth", Math.round(dd));
  }
  function stepLayer(dir) {
    const D = data(), d = depthNow();
    const tops = D.top_ft.map(Math.round), i = G().layerInfo(d).l;
    const j = Math.max(0, Math.min(D.nl - 1, i + dir));
    setDepth(j === i ? (dir > 0 ? D.bot_ft[D.nl - 1] : 0) : tops[j] + (j ? 0.5 : 0));
  }
  /* a slow descent, one step per tick; anything the user does stops it */
  function play() {
    if (playT) { stopPlay(); return; }
    if (depthNow() >= Math.floor(DM()) - 1) setDepth(0);
    const btn = el && el.querySelector('[data-a="play"]');
    if (btn) { btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); }
    playT = setInterval(() => {
      if (!active) { stopPlay(); return; }
      const d = depthNow() + 4;
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
      /* `toggle` does not bubble: caught on the way down */
      el.addEventListener("toggle", e => {
        const d = e.target;
        if (!d || !d.dataset || !d.dataset.sec) return;
        const st = secState(); st[d.dataset.sec] = d.open;
        try { SBMM.view && SBMM.view.pref("temSecs", st); } catch (err) { /* a preference is a convenience */ }
      }, true);
    }
    el.hidden = false;
    const S = G().settings(), D = data(), R = G().result(), O = G().options();
    const sz = SIZES.includes(pit.w) && pit.w === pit.h ? pit.w : "";
    const secs = secState();
    const det = (k, title, body, cls) =>
      `<details class="twsec${cls ? " " + cls : ""}" data-sec="${k}"${secs[k] ? " open" : ""}><summary>${esc(title)}</summary>`
      + `<div class="twsecb">${body}</div></details>`;
    const [eLo, eHi] = G().elevRange();
    el.innerHTML =
      `<header class="twsh"><div><b>TEM geophysics</b>`
      + `<span class="twssub">TEM2Go · LCI models · May 2026 · ${fmt0(D.n)} soundings to ${fmt0(DM())} ft</span></div>`
      + `<span class="twshb"><button class="minib" data-a="hide" title="Hide the panel — the TEM layers stay on">hide</button>`
      + `<button class="twsx" data-a="off" title="Turn TEM off — every TEM layer off, the cut closed, the ground solid" aria-label="Turn TEM off">×</button></span></header>`
      + `<nav class="twstabs" role="tablist" aria-label="TEM analyses">` + TABS.map(([k, t]) =>
          `<button class="twstab${k === tab ? " on" : ""}" role="tab" data-tab="${k}" aria-selected="${k === tab}">${esc(t)}</button>`).join("") + `</nav>`
      + `<div class="twsb temctl" data-pane="model"${tab === "model" ? "" : " hidden"}>`
      /* THE READING: the core, the slice, the value under the centre of the cut */
      + `<section class="twsdepth">`
      + `<canvas class="twscore" width="60" height="300" role="slider" tabindex="0" aria-label="Slice position"`
      + ` aria-valuemin="0" aria-valuemax="${Math.floor(DM())}" title="The model straight down the centre of the cut"></canvas>`
      + `<div class="twsread">`
      + `<div class="twsseg" role="group" aria-label="Slice by">`
      + `<button class="segb" data-datum="depth" title="A slice at a depth below the ground">depth</button>`
      + `<button class="segb" data-datum="elev" title="A level slice at an elevation (NAVD88)">elevation</button></div>`
      + `<div class="twsdbig mono"><span data-o="depth"></span><small data-o="dunit"></small></div>`
      + `<div class="mut" data-o="layer"></div>`
      + `<div class="twsval mono" data-o="val"></div>`
      + `<div class="mut twsnear" data-o="near"></div>`
      + `<div class="twsbtns">`
      + `<button class="minib" data-a="up" title="Up one model layer [PgUp]">▲ layer</button>`
      + `<button class="minib" data-a="down" title="Down one model layer [PgDn]">▼ layer</button>`
      + `<button class="minib" data-a="play" aria-pressed="false" title="Descend through the model">▶ descend</button></div>`
      + `<input type="range" data-k="depth" min="0" max="${Math.floor(DM())}" step="1" value="${S.depth}" aria-label="Depth below ground">`
      + `<input type="range" class="twselev" data-k="elev" min="${eLo}" max="${eHi}" step="1" value="${S.elev}" aria-label="Slice elevation" hidden>`
      + `</div></section>`
      /* THE VIEW: one of four, or the pieces by hand */
      + `<section><h4>View</h4>`
      + `<div class="twsseg twspre" role="group" aria-label="View">` + Object.keys(PRESETS).map(k =>
          `<button class="segb" data-preset="${k}" title="${esc(PRESETS[k].title)}">${esc(PRESETS[k].label)}</button>`).join("") + `</div>`
      + det("view", "Customise",
          `<div class="twschks">${chk("on", "cut the ground open", pit.on, "Clip the ground over the cut down to the slice", "data-p")}`
        + chk("open", "open toward the view", pit.open, "Run the cut on toward the camera so its floor shows", "data-p")
        + chk("tem_slice", "depth slice", on("tem_slice"), "The slice on the map and in 3D", "data-row")
        + chk("sheet", "slice sheet in 3D", S.sheet, "Draw the slice itself in the 3D view")
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
        + `<div class="temgrid2"><label>Cut size ${sel("size", [["", "custom"]].concat(SIZES.map(v => [v, v + " ft"])), sz, "Width of the cut")}</label>`
        + `<label>Ground ${sel("ground", [["auto", "auto"], ["solid", "solid"], ["see", "see-through"], ["hidden", "hidden"]],
            SBMM.viewer3d ? SBMM.viewer3d.ground() : "auto", "How the terrain draws around the model")}</label></div>`
        + `<div class="twsbtns"><button class="minib" data-a="centre" title="Move the cut to the centre of the 3D view">centre on view</button>`
        + `<button class="minib" data-a="survey" title="Open the whole surveyed area">whole survey</button>`
        + `<button class="minib" data-a="frame" title="Frame the cut">frame</button></div>`
        + `<div class="mut mono" data-o="cut"></div>`, "twsmore")
      + `</section>`
      /* colour */
      + det("colour", "Colour",
          `<div class="temgrid2">`
        + `<label>Property ${sel("prop", [["res", "Resistivity"], ["cond", "Conductivity"], ["sig", "Kriging s.e."]], S.prop, "What the model shows")}</label>`
        + `<label>Colours ${sel("cmap", O.cmap, S.cmap, "Colour map")}</label>`
        + `<label>Classes ${sel("classes", [[0, "continuous"], [5, "5"], [8, "8"], [12, "12"]], S.classes, "Colour classes")}</label>`
        + `<label>Contours ${sel("nCont", [[0, "off"], [8, "8 levels"], [12, "12 levels"], [20, "20 levels"]], S.contours ? S.nCont : 0, "Contour edges across the colour range")}</label>`
        + `</div><div class="twschks">${chk("rev", "reverse colours", S.rev, "Reverse the colour map")}`
        + chk("blend", "blend between layers", S.blend, "Blend between model-layer mid-depths rather than step at layer boundaries") + `</div>`
        + `<div class="twsleg" data-o="legend"></div>`
        + `<div class="twsbtns"><button class="minib" data-a="fit" title="Colour range from 2–98 % of the soundings">fit range</button>`
        + `<span class="mut mono" data-o="range"></span></div>`)
      /* the interpolation */
      + det("model", "Interpolation",
          `<div class="temgrid2">`
        + `<label>Method ${sel("method", O.method, S.method, "Interpolation, one model layer at a time")}</label>`
        + `<label>Variogram ${sel("vgType", O.vgType, S.vgType, "Kriging variogram model, fitted to the data")}</label>`
        + `<label>Grid cell ${sel("cell", [10, 15, 20, 30, 40].map(v => [v, v + " ft"]), S.cell, "Grid node spacing")}</label>`
        + `<label>Blank beyond ${sel("blank", [20, 40, 60, 100, 150, 250].map(v => [v, v + " ft"]), S.blank, "No value farther than this from a sounding")}</label>`
        + `</div><div class="twschks">${chk("per", "variogram per layer", S.per, "Fit a variogram to each layer rather than one to all")}</div>`
        + `<div class="mut mono" data-o="model"></div>`)
      /* the borings */
      + det("borings", "Against the 2025 borings",
          `<div class="mono twscal" data-o="cal"></div>`
        + `<div class="twsbtns"><button class="minib" data-a="cal" title="Resistivity against each boring's logged classes (TEMCAL)">open the table</button></div>`)
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
      if (inp.type === "checkbox") inp.checked = k === "cols" ? colsOn() : !!S[k];
      else if (k === "nCont") inp.value = S.contours ? S.nCont : 0;
      else if (k === "ground") inp.value = SBMM.viewer3d ? SBMM.viewer3d.ground() : "auto";
      else if (k === "size") inp.value = SIZES.includes(pit.w) && pit.w === pit.h ? pit.w : "";
      else if (k === "ewI" || k === "nsI") inp.value = R ? secIdx(k, R) : 0;
      else if (k in S) inp.value = S[k];
    }
    for (const inp of el.querySelectorAll("[data-row]")) inp.checked = on(inp.dataset.row);
    for (const inp of el.querySelectorAll("[data-p]")) inp.checked = !!pit[inp.dataset.p];
    /* the slice: a depth, or an elevation with the depth it makes under the centre */
    const byE = G().byElev(), d = depthNow(), L = G().layerInfo(d);
    setO("depth", fmt0(byE ? S.elev : S.depth));
    setO("dunit", byE ? " ft elevation" : " ft below ground");
    setO("layer", (byE ? `${fmt0(d)} ft under the centre · ` : "") + `layer ${L.l + 1} of ${L.n} · ${fmt1(L.top)}–${fmt1(L.bot)} ft`);
    for (const b of el.querySelectorAll("[data-datum]")) {
      const onB = (b.dataset.datum === "elev") === byE;
      b.classList.toggle("on", onB); b.setAttribute("aria-pressed", String(onB));
    }
    const rD = q('input[data-k="depth"]'), rE = q('input[data-k="elev"]');
    if (rD) rD.hidden = byE;
    if (rE) rE.hidden = !byE;
    const pn = presetNow();
    for (const b of el.querySelectorAll("[data-preset]")) {
      const onB = b.dataset.preset === pn;
      b.classList.toggle("on", onB); b.setAttribute("aria-pressed", String(onB));
    }
    /* NOT data-preset: the panel is an ancestor of every button in it, and the
       click handler finds a view button with closest('[data-preset]') */
    el.dataset.view = pn;
    paintReading();
    if (R) {
      setO("ewI", `N ${fmt0(R.y0 + secIdx("ewI", R) * R.dx)}`);
      setO("nsI", `E ${fmt0(R.x0 + secIdx("nsI", R) * R.dx)}`);
      setO("model", `${R.nx} × ${R.ny} nodes at ${fmt0(R.dx)} ft · ${fmt0(R.nodes)} within ${fmt0(R.blank)} ft of a sounding · ${fmt0(R.ms_wall)} ms`);
    }
    const rg = G().range(), lo = Math.min(S.voxLo, S.voxHi) / 100, hi = Math.max(S.voxLo, S.voxHi) / 100;
    setO("vox", rg ? `${Math.round(lo * 100)}–${Math.round(hi * 100)} % of the scale` : "");
    const lg = q('[data-o="legend"]');
    if (lg) lg.innerHTML = G().legendSvg ? G().legendSvg(300) : "";
    setO("range", rg ? `${fmtV(rg.lo)}–${fmtV(rg.hi)} ${G().unit()}` : "");
    const ps = SBMM.viewer3d && SBMM.viewer3d.pitState ? SBMM.viewer3d.pitState() : null;
    setO("cut", ps && ps.on ? `${fmt0(pit.w)} × ${fmt0(pit.h)} ft at E ${fmt0(pit.cx)} N ${fmt0(pit.cy)}`
      + (ps.ext ? ` · open ${ {n: "north", s: "south", e: "east", w: "west"}[ps.side] || ""} ${fmt0(ps.ext)} ft` : "")
      : pit.on ? "the cut opens in the 3D view" : "ground closed");
    paintCal();
    paintCore();
  }
  /* the two lines under the layer: the value, and what is nearest — at the
     centre of the cut, or under the pointer while it is on the model */
  function paintReading() {
    if (!active || !el) return;
    const D = data(), setO = (k, t) => { const o = el.querySelector(`[data-o="${k}"]`); if (o) o.textContent = t; };
    const px = hov ? hov.x : pit.cx, py = hov ? hov.y : pit.cy, d = hov ? hov.depth : depthNow();
    const where = hov ? "under the pointer" : "at the centre of the cut";
    const inRec = d >= 0 && d <= DM();
    const v = isFinite(px) && inRec ? G().valueAtDepth(px, py, d) : NaN;
    setO("val", isFinite(v) ? `${fmtV(v)} ${G().unit()} ${where}` + (hov ? ` · ${fmt0(d)} ft deep` : "") : `no model ${where}`);
    const ns = nearestSounding(px, py);
    const nb = nearestBoring(px, py);
    setO("near", (ns ? `nearest sounding ${D.id[ns.i]} · ${fmt0(ns.d)} ft` : "")
      + (nb ? ` · ${nb.h.id} ${fmt0(nb.d)} ft (contacts on the core)` : ""));
    el.dataset.reading = hov ? "pointer" : "centre";
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
    const hx = hov ? hov.x : pit.cx, hy = hov ? hov.y : pit.cy;
    const sig = (G().sigKey ? G().sigKey() : "") + "|" + hx + "|" + hy;
    if (!coreCache || coreCache.sig !== sig) coreCache = { sig, c: G().core(hx, hy, 150) };
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
    const nb = nearestBoring(hx, hy);
    if (nb) {
      const c = nb.h.contacts || {};
      const tick = (d, col) => { if (d == null || !(d >= 0)) return; x.fillStyle = col; x.fillRect(CORE.x0 + CORE.w + 1, Math.round(yOf(d)) - 1, 7, 2); };
      tick(c.native_contact, "#E2BA14");
      tick(c.bedrock_top, "#C9D3D6");
    }
    /* the depth marker */
    const yd = yOf(Math.max(0, Math.min(dm, hov ? hov.depth : depthNow())));
    x.fillStyle = hov ? "#FFFFFF" : "#F1CE7A";
    x.fillRect(CORE.x0 - 6, Math.round(yd) - 1, CORE.w + 12, 2);
    x.beginPath(); x.moveTo(CORE.x0 + CORE.w + 6, yd); x.lineTo(CORE.x0 + CORE.w + 12, yd - 5); x.lineTo(CORE.x0 + CORE.w + 12, yd + 5); x.fill();
    cv.setAttribute("aria-valuenow", String(Math.round(depthNow())));
    cv.dataset.depth = String(Math.round(depthNow()));
    cv.dataset.hover = hov ? Math.round(hov.depth) + "@" + Math.round(hov.x) + "," + Math.round(hov.y) : "";
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
      if (k === "ArrowDown" || k === "ArrowUp") { setDepth(depthNow() + (k === "ArrowDown" ? 5 : -5)); e.preventDefault(); e.stopPropagation(); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */
  function onInput(e) {
    const t = e.target, k = t.dataset.k;
    if (!k) return;
    if (k === "depth") { stopPlay(); G().apply("depth", +t.value); return; }
    if (k === "elev") { stopPlay(); G().apply("elev", +t.value); return; }
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
    if (!k || k === "depth" || k === "elev" || k === "ewI" || k === "nsI" || k === "voxLo" || k === "voxHi") return;
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
      if (hidCols) { hidCols = false; G().apply("cols", true); }
    } else {
      if (on("tem_slice")) { hidSlice = true; rowSet("tem_slice", false); }
      /* v52: a thousand model columns in front of the base of waste or the
         conductive band are a fence across exactly what the tab shows */
      if (colsOn()) { hidCols = true; G().apply("cols", false); }
    }
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
    const pb = e.target.closest("[data-preset]");
    if (pb) { applyPreset(pb.dataset.preset); return; }
    const db = e.target.closest("[data-datum]");
    if (db) { stopPlay(); G().apply("datum", db.dataset.datum); return; }
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a !== "play") stopPlay();
    if (a === "off") off();
    else if (a === "hide") close();
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
  /* called once at boot (js/boot.js): the chip and the menu's state follow
     the TEM rows whether or not the panel has ever been opened */
  let chipWired = false;
  function wireChip() {
    if (chipWired || !SBMM.events) return;
    chipWired = true;
    let t = 0;
    const soon = () => { clearTimeout(t); t = setTimeout(paintChip, 60); };
    SBMM.events.on("layers", ({ group }) => { if (group === "invest" || group == null) soon(); });
    SBMM.events.on("view", soon);
    SBMM.events.on("tem", soon);
    SBMM.events.on("field", soon);
    soon();
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
    /* the probe: the core and the reading follow the pointer (two text nodes
       and a 60-px canvas — no layout, no frame) */
    let hovRaf = 0;
    SBMM.events.on("temprobe", ({ rec }) => {
      const next = rec && rec.ok ? rec : null;
      if (!active || tab !== "model") { hov = null; return; }
      if (!next && !hov) return;
      hov = next;
      if (hovRaf) return;
      hovRaf = requestAnimationFrame(() => { hovRaf = 0; paintReading(); paintCore(); });
    });
    /* the cut is a 3D view state: closing 3D takes it away, opening it again
       puts it back */
    SBMM.events.on("view", ({ open: o }) => { if (active && o) { applyPit(); paintAll(); } });
  }

  function state() {
    return { open: active, pit: Object.assign({}, pit), playing: !!playT, tab,
             temOn: !!(G() && data() && G().anyOn()), chip: !!(chip && !chip.hidden),
             reading: hov ? "pointer" : "centre", preset: active ? presetNow() : "", byElev: !!(G() && G().byElev()), depthNow: G() && data() ? depthNow() : null,
             panel: !!(el && !el.hidden), depth: G() ? G().depth() : null };
  }
  if (SBMM.events) SBMM.events.on("boot", () => wireChip());
  return { open, close, hide: close, off, toggle, wireChip, paintChip, applyPreset, presets: () => Object.keys(PRESETS),
           isOpen: () => active, state, setSize, centreOnView, centreOnSurvey: () => centreOnSurvey(true),
           fitSurvey, setPit: p => { Object.assign(pit, p || {}); applyPit(); paintAll(); },
           play, stopPlay, stepLayer, paint: paintAll, setTab: t => setTab(t) };
})();
