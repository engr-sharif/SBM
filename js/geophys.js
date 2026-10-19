/* SBMM Site Explorer — the 2026 TEM2Go geophysics survey (v36).

   SBMM_DATA.tem2026 (tools/build_tem2026.py, from the contractor's own viewer
   kept verbatim in data/source/geophysics_tem2go_2026/): 1,032 soundings, each
   a 20-layer LCI resistivity model to 394 ft, in State Plane feet.

   Two rows under Investigations, in one sub-group:
     · TEM soundings — a dot per sounding, coloured by its OWN inverted model
       at the slice depth, on the same scale as the slice, so a dot that
       disagrees with the ground around it is a dot worth reading;
     · Resistivity — depth slice — the `tem` kernel's grid (js/compute.js, the
       viewer's own interpolation, proven identical to it by test/kernels.mjs
       --only tem), sliced at a depth below ground and painted with the
       viewer's colour maps, classes and contour edges.
   The first tick of either runs the job; a changed method, cell or blanking
   distance re-runs it, and a changed depth or colour only repaints.

   The card carries the controls (the viewer's panel, in feet), the legend and
   the exports. A sounding's popup carries its model as a step plot with the
   interpolated grid beside it, and the nearest 2025 boring's logged contacts
   drawn across it when one is within reach — the first place the two
   investigations meet.

   Read-only project data in the manner of js/siteareas.js: nothing here is a
   store feature and nothing serialises; the settings are a view preference. */
"use strict";

SBMM.geophys = (function () {

  const FT = 3937 / 1200;
  const SUB = "Geophysics — TEM 2026";
  const SUB_TITLE = "TEM2Go transient electromagnetic soundings, LCI resistivity models, May 2026";
  const PTS_COL = "#E2BA14";
  const NOTE = "TEM2Go LCI models (May 2026) · log10 resistivity interpolated layer by layer · "
    + "no depth of investigation delivered, so the deepest layers are the least constrained · planning-level";

  /* the viewer's eight colour maps, verbatim */
  const CMAPS = {
    hydro: ["#1b2a8f", "#1f5fc9", "#27a0e3", "#3ec8b4", "#7fd857", "#d9e23a", "#f6b42c", "#ec6a1f", "#c8232a", "#9e1068", "#6f2a8c"],
    turbo: ["#30123b", "#4145ab", "#4675ed", "#39a2fc", "#1bcfd4", "#24eca6", "#61fc6c", "#a4fc3b", "#d1e834", "#f3c63a", "#fe9b2d", "#f36315", "#d93806", "#b11901", "#7a0403"],
    viridis: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"],
    plasma: ["#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921"],
    cividis: ["#00224e", "#123570", "#3b496c", "#575d6d", "#707173", "#8a8779", "#a69d75", "#c4b56c", "#e4cf5b", "#fee838"],
    spectral: ["#9e0142", "#d53e4f", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#e6f598", "#abdda4", "#66c2a5", "#3288bd", "#5e4fa2"],
    jet: ["#00007f", "#0000ff", "#007fff", "#00ffff", "#7fff7f", "#ffff00", "#ff7f00", "#ff0000", "#7f0000"],
    grey: ["#141414", "#f2f2f2"]
  };
  const CMAP_NAME = { hydro: "Hydrogeophysics", turbo: "Turbo", viridis: "Viridis", plasma: "Plasma",
                      cividis: "Cividis", spectral: "Spectral", jet: "Rainbow", grey: "Greyscale" };
  const METHOD_NAME = { krig: "Ordinary kriging", mc: "Minimum curvature",
                        idw: "Inverse distance", nn: "Nearest neighbour" };
  const VG_NAME = { sph: "spherical", exp: "exponential", gau: "Gaussian" };
  const PROP = {
    res: { name: "Resistivity", unit: "Ω·m", scale: "log" },
    cond: { name: "Conductivity", unit: "mS/m", scale: "log" },
    sig: { name: "Kriging standard error", unit: "log10 Ω·m", scale: "lin" }
  };

  /* the settings: the viewer's defaults, in feet (6 m cell, 18 m blanking) */
  const DEF = { method: "krig", vgType: "sph", per: false, cell: 20, blank: 60, depth: 30,
                blend: true, prop: "res", cmap: "hydro", rev: false, classes: 0,
                contours: true, nCont: 12 };
  let S = Object.assign({}, DEF);
  try {
    const st = SBMM.view && SBMM.view.pref("tem");
    if (st && typeof st === "object") for (const k in DEF) if (st[k] != null && typeof st[k] === typeof DEF[k]) S[k] = st[k];
  } catch (e) { /* a preference is a convenience */ }
  function save() { try { SBMM.view && SBMM.view.pref("tem", S); } catch (e) { /* ignore */ } }

  let R = null, running = null, overlay = null, ptsGroup = null, markers = [];
  let card = null, rows = {}, range = null, slice = null, built = false;

  const data = () => window.SBMM_DATA && SBMM_DATA.tem2026;
  const on = id => SBMM.layerState.isOn("invest", id);
  const NL = () => data().nl;
  const LOG = (function () { let cache = null, src = null;
    return () => { const D = data(); if (!D) return null;
      if (src !== D) { src = D; cache = Float64Array.from(D.r, v => Math.log10(Math.max(v, 1e-3))); }
      return cache; }; })();
  const midFt = l => (data().top_ft[l] + data().bot_ft[l]) / 2;
  const dmax = () => data().bot_ft[data().nl - 1];

  /* ------------------------------------------------------------------ */
  /* the job                                                             */
  /* ------------------------------------------------------------------ */
  function jobFor() {
    const D = data();
    /* test/kernels.mjs temAppJob mirrors this: the viewer's metric defaults
       converted to feet exactly, the variogram fitted to the pooled
       experimental first (the viewer's own start-up) */
    return {
      x: D.x, y: D.y, z: D.z, r: D.r, nl: D.nl,
      method: S.method, cell: S.cell, blank: S.blank,
      vg: { type: S.vgType, fit: true, k: 16, per: S.per, lag: 8 * FT, nb: 20,
            rmin: 10 * FT, rmax: 400 * FT, rstep: 5 * FT },
      mc: { t: 0.35, it: 300 }, idw: { p: 2, k: 12 }
    };
  }
  const keyOf = () => [S.method, S.vgType, S.per, S.cell, S.blank].join("|");

  async function run(force) {
    if (!data()) { toast("the TEM survey is not in this build"); return null; }
    if (R && R.key === keyOf() && !force) return R;
    if (running) return running;
    const key = keyOf();
    running = (async () => {
      try {
        const t0 = performance.now();
        const res = await SBMM.compute.run("tem", jobFor(), { label: "TEM resistivity" }).promise;
        res.ms_wall = Math.round(performance.now() - t0);
        res.key = key;
        R = res;
        if (!range) autoRange();
        return R;
      } catch (e) {
        if (e && e.cancelled) { toast("TEM interpolation cancelled"); return null; }
        toast("TEM interpolation failed: " + (e.message || e));
        return null;
      }
    })().finally(() => { running = null; });
    const out = await running;
    /* a setting that moved while the job ran gets its own run */
    if (out && out.key !== keyOf()) return run();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the slice                                                           */
  /* ------------------------------------------------------------------ */
  function layerAt(d) { const B = data().bot_ft; let l = 0; while (l < B.length - 1 && d >= B[l]) l++; return l; }
  /* the viewer's baseAt: a layer's value, or a blend between layer mid-depths */
  function baseAt(arr, id, N, depth) {
    const nl = NL();
    if (!S.blend) return arr[layerAt(depth) * N + id];
    if (depth <= midFt(0)) return arr[id];
    if (depth >= midFt(nl - 1)) return arr[(nl - 1) * N + id];
    let l = 0;
    while (l < nl - 2 && depth >= midFt(l + 1)) l++;
    const f = (depth - midFt(l)) / (midFt(l + 1) - midFt(l));
    return arr[l * N + id] * (1 - f) + arr[(l + 1) * N + id] * f;
  }
  /* a sounding's own model at a depth, through the same rule */
  function soundingAt(i, depth) {
    const lg = LOG(), nl = NL();
    const at = l => lg[i * nl + l];
    if (!S.blend) return at(layerAt(depth));
    if (depth <= midFt(0)) return at(0);
    if (depth >= midFt(nl - 1)) return at(nl - 1);
    let l = 0;
    while (l < nl - 2 && depth >= midFt(l + 1)) l++;
    const f = (depth - midFt(l)) / (midFt(l + 1) - midFt(l));
    return at(l) * (1 - f) + at(l + 1) * f;
  }
  const propArr = () => S.prop === "sig" ? R.sig : R.log;
  const toProp = b => S.prop === "res" ? Math.pow(10, b) : S.prop === "cond" ? Math.pow(10, 3 - b) : b;
  function field(depth) {
    const arr = propArr(); if (!arr) return null;
    const N = R.nx * R.ny, f = new Float32Array(N);
    for (let i = 0; i < N; i++) f[i] = R.mask[i] ? baseAt(arr, i, N, depth) : NaN;
    return f;
  }
  function bilin(f, nx, ny, gx, gy) {
    const ix = Math.max(0, Math.min(nx - 2, Math.floor(gx))), iy = Math.max(0, Math.min(ny - 2, Math.floor(gy)));
    const fx = gx - ix, fy = gy - iy;
    const near = f[Math.round(gy) * nx + Math.round(gx)];
    if (!isFinite(near)) return NaN;
    const v = [f[iy * nx + ix], f[iy * nx + ix + 1], f[(iy + 1) * nx + ix], f[(iy + 1) * nx + ix + 1]];
    const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    let s = 0, sw = 0;
    for (let k = 0; k < 4; k++) if (isFinite(v[k])) { s += v[k] * w[k]; sw += w[k]; }
    return sw > 0 ? s / sw : NaN;
  }

  /* ------------------------------------------------------------------ */
  /* colour                                                              */
  /* ------------------------------------------------------------------ */
  let LUT = null, lutKey = "";
  function lut() {
    const k = S.cmap + "|" + S.rev;
    if (LUT && lutKey === k) return LUT;
    let st = (CMAPS[S.cmap] || CMAPS.hydro).map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    if (S.rev) st = st.slice().reverse();
    LUT = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const p = i / 255 * (st.length - 1), a = Math.min(Math.floor(p), st.length - 2), f = p - a;
      for (let c = 0; c < 3; c++) LUT[i * 3 + c] = Math.round(st[a][c] * (1 - f) + st[a + 1][c] * f);
    }
    lutKey = k;
    return LUT;
  }
  const scale = () => PROP[S.prop].scale;
  function tRaw(v) {
    if (!isFinite(v) || !range) return NaN;
    if (scale() === "log") {
      if (v <= 0 || range.lo <= 0 || range.hi <= 0) return NaN;
      return (Math.log10(v) - Math.log10(range.lo)) / (Math.log10(range.hi) - Math.log10(range.lo));
    }
    return (v - range.lo) / (range.hi - range.lo);
  }
  function tCol(t) {
    t = Math.max(0, Math.min(1, t));
    if (S.classes > 1) { const c = Math.min(S.classes - 1, Math.floor(t * S.classes)); t = c / (S.classes - 1); }
    return Math.round(t * 255) * 3;
  }
  function colorOf(v) {
    const t = tRaw(v);
    if (!isFinite(t)) return null;
    const L = lut(), c = tCol(t);
    return `rgb(${L[c]},${L[c + 1]},${L[c + 2]})`;
  }
  function percentile(a, p) {
    const s = a.filter(isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : NaN;
  }
  function nice(v) {
    if (!(v > 0)) return +(+v).toPrecision(2);
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    return +(Math.round(v / e * 10) / 10 * e).toPrecision(3);
  }
  /* the viewer's "fit range to data": 2-98 % of every sounding's value, or of
     the kriging error when that is the property */
  function autoRange() {
    let vals = [];
    if (S.prop === "sig") { if (R && R.sig) for (let i = 0; i < R.sig.length; i += 3) vals.push(R.sig[i]); }
    else vals = Array.from(LOG() || [], toProp);
    let lo = percentile(vals, 0.02), hi = percentile(vals, 0.98);
    if (!(hi > lo)) { lo = 0; hi = 1; }
    range = { lo: nice(lo), hi: nice(hi), prop: S.prop };
  }

  /* the viewer's paint(): a colour per pixel and a contour edge wherever the
     level index changes between neighbours */
  function upFactor(n) { return Math.max(2, Math.min(8, Math.floor(900 / n))); }
  function paintSlice() {
    if (!R) return null;
    const f = field(S.depth);
    if (!f) return null;
    const { nx, ny } = R, up = upFactor(Math.max(nx, ny)), W = (nx - 1) * up + 1, H = (ny - 1) * up + 1;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"), im = ctx.createImageData(W, H), px = im.data;
    const lev = new Int32Array(W * H), tt = new Float32Array(W * H), L = lut();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, t = tRaw(toProp(bilin(f, nx, ny, x / up, (H - 1 - y) / up)));
      tt[i] = t; lev[i] = isFinite(t) ? Math.floor(t * S.nCont + 1e-6) : -99999;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      if (lev[i] === -99999) { px[o + 3] = 0; continue; }
      const c = tCol(tt[i]);
      let r = L[c], g = L[c + 1], b = L[c + 2];
      if (S.contours) {
        const lv = lev[i];
        const e = (x + 1 < W && lev[i + 1] !== -99999 && lev[i + 1] !== lv)
               || (y + 1 < H && lev[i + W] !== -99999 && lev[i + W] !== lv);
        if (e) { r = r * 0.25 + 20 * 0.75; g = g * 0.25 + 24 * 0.75; b = b * 0.25 + 26 * 0.75; }
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    const h = R.dx / up / 2;
    slice = { canvas: cv, f, depth: S.depth, up, W, H,
              bounds: [R.x0 - h, R.y0 - h, R.x0 + (nx - 1) * R.dx + h, R.y0 + (ny - 1) * R.dx + h] };
    return slice;
  }

  /* ------------------------------------------------------------------ */
  /* the map                                                             */
  /* ------------------------------------------------------------------ */
  let paintRaf = 0, refresh3dT = 0;
  function paint() {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(() => { paintRaf = 0; paintNow(); });
  }
  function paintNow() {
    recolourPoints();
    if (!R || !on("tem_slice")) {
      if (overlay) { SBMM.map.removeLayer(overlay); overlay = null; }
      slice = null;
    } else {
      const s = paintSlice();
      if (s) {
        const b = s.bounds, url = s.canvas.toDataURL("image/png");
        const bb = [[b[1], b[0]], [b[3], b[2]]];
        if (overlay) { overlay.setUrl(url); overlay.setBounds(L.latLngBounds(bb)); }
        else {
          overlay = L.imageOverlay(url, bb, { pane: "analysis", interactive: false,
            opacity: SBMM.layerState.opacity("invest", "tem_slice") });
          overlay.addTo(SBMM.map);
        }
      }
    }
    refreshCard();
  }
  function soon3d() {
    clearTimeout(refresh3dT);
    refresh3dT = setTimeout(() => {
      if (SBMM.viewer3d && SBMM.viewer3d.refreshOverlays && (on("tem_slice") || on("tem_soundings")))
        SBMM.viewer3d.refreshOverlays();
    }, 250);
  }

  function tipFor(i) {
    const D = data(), v = toProp(soundingAt(i, S.depth));
    const u = PROP[S.prop].unit;
    return `<b>${esc(D.id[i])}</b> · TEM sounding`
      + (S.prop === "sig" ? "" : ` · ${fmtV(v)} ${u} at ${fmt(S.depth, 0)} ft`);
  }
  const fmtV = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1)
    : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2);

  function buildPoints() {
    const D = data();
    ptsGroup = L.layerGroup();
    markers = [];
    for (let i = 0; i < D.n; i++) {
      const m = L.circleMarker([D.y[i], D.x[i]], {
        pane: "vectors", radius: 3.2, weight: 0.8, color: "#1D2A2E", opacity: 0.85,
        fillColor: PTS_COL, fillOpacity: 0.95
      });
      m.bindTooltip(() => tipFor(i), { sticky: true, className: "ctip" });
      m.bindPopup(() => popupHtml(i), { maxWidth: 340, minWidth: 280 });
      m._temIdx = i;
      m.addTo(ptsGroup);
      markers.push(m);
    }
    if (SBMM.carto && SBMM.carto.densify) SBMM.carto.densify(ptsGroup);
  }
  function recolourPoints() {
    if (!markers.length || !on("tem_soundings")) return;
    const byProp = S.prop !== "sig";
    for (let i = 0; i < markers.length; i++) {
      const c = byProp ? colorOf(toProp(soundingAt(i, S.depth))) : null;
      markers[i].setStyle({ fillColor: c || PTS_COL });
    }
  }

  /* the status bar while the slice is on: "ρ 23.4 Ω·m at 30 ft" */
  function hoverText(x, y) {
    if (!slice || !R || !on("tem_slice")) return "";
    const gx = (x - R.x0) / R.dx, gy = (y - R.y0) / R.dx;
    if (gx < -0.5 || gy < -0.5 || gx > R.nx - 0.5 || gy > R.ny - 0.5) return "";
    const v = toProp(bilin(slice.f, R.nx, R.ny, Math.max(0, Math.min(R.nx - 1, gx)), Math.max(0, Math.min(R.ny - 1, gy))));
    if (!isFinite(v)) return "";
    return ` · ${S.prop === "res" ? "ρ" : S.prop === "cond" ? "σ" : "s.e."} ${fmtV(v)} ${PROP[S.prop].unit} at ${fmt(S.depth, 0)} ft`;
  }
  /* the value at a point at the current depth, for the harness and the 3D card */
  function valueAt(x, y) {
    if (!R) return NaN;
    const f = (slice && slice.depth === S.depth) ? slice.f : field(S.depth);
    if (!f) return NaN;
    const gx = (x - R.x0) / R.dx, gy = (y - R.y0) / R.dx;
    if (gx < 0 || gy < 0 || gx > R.nx - 1 || gy > R.ny - 1) return NaN;
    return toProp(bilin(f, R.nx, R.ny, gx, gy));
  }

  /* ------------------------------------------------------------------ */
  /* a sounding: the popup and its profile                               */
  /* ------------------------------------------------------------------ */
  function nearestBoring(x, y, within) {
    const B = SBMM.borelogs;
    if (!B || !B.has || !B.has()) return null;
    let best = null, bd = within;
    for (const h of B.holes()) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) { bd = d; best = h; }
    }
    return best ? { h: best, d: bd } : null;
  }
  function gridModelAt(i) {
    if (!R) return null;
    const D = data();
    const ix = Math.round((D.x[i] - R.x0) / R.dx), iy = Math.round((D.y[i] - R.y0) / R.dx);
    if (ix < 0 || iy < 0 || ix >= R.nx || iy >= R.ny) return null;
    const id = iy * R.nx + ix, N = R.nx * R.ny;
    if (!R.mask[id]) return null;
    const out = [];
    for (let l = 0; l < NL(); l++) out.push(Math.pow(10, R.log[l * N + id]));
    return out;
  }
  /* the viewer's profile, as SVG: the inverted model solid, the interpolated
     grid at the nearest node dashed, log resistivity across, depth down */
  function profileSvg(i, w, h) {
    const D = data(), nl = NL();
    w = w || 300; h = h || 230;
    const r = [];
    for (let l = 0; l < nl; l++) r.push(D.r[i * nl + l]);
    const gm = gridModelAt(i);
    const all = r.concat(gm || []);
    const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...all)))), hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...all))));
    const Lp = 44, Rp = 10, Tp = 18, Bp = 8, DM = dmax();
    const X = v => Lp + (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (w - Lp - Rp);
    const Y = d => Tp + d / DM * (h - Tp - Bp);
    const ink = "#9FB0B5", rule = "rgba(159,176,181,.28)";
    let s = `<svg class="temprof" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui,sans-serif" font-size="10">`;
    for (let e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e++) {
      const x = X(Math.pow(10, e));
      s += `<line x1="${x}" y1="${Tp}" x2="${x}" y2="${h - Bp}" stroke="${rule}"/>`
        + `<text x="${x}" y="${Tp - 6}" fill="${ink}" text-anchor="middle">${+Math.pow(10, e).toPrecision(3)}</text>`;
    }
    for (let d = 0; d <= DM; d += 50) {
      const y = Y(d);
      s += `<line x1="${Lp}" y1="${y}" x2="${w - Rp}" y2="${y}" stroke="${rule}"/>`
        + `<text x="${Lp - 4}" y="${y + 3.5}" fill="${ink}" text-anchor="end">${d} ft</text>`;
    }
    const nb = nearestBoring(D.x[i], D.y[i], 150);
    if (nb) {
      const c = nb.h.contacts || {};
      const ln = (ft, col, label) => {
        if (ft == null || ft > DM) return "";
        const y = Y(ft);
        return `<line class="temcontact" data-ft="${ft}" x1="${Lp}" y1="${y}" x2="${w - Rp}" y2="${y}" stroke="${col}" stroke-dasharray="2 2"><title>${esc(nb.h.id)} ${label} ${fmt(ft, 1)} ft</title></line>`
          + `<text x="${w - Rp - 2}" y="${y - 2}" fill="${col}" text-anchor="end" font-size="9">${esc(nb.h.id)} ${label}</text>`;
      };
      s += ln(c.native_contact, SBMM.borelogs.classColor("contact"), "native")
        + ln(c.bedrock_top, SBMM.borelogs.classColor("bedrock"), "bedrock");
    }
    const step = (vals, dash, col, sw, cls) => {
      let p = "";
      for (let l = 0; l < nl; l++) {
        const x = X(vals[l]);
        p += (l === 0 ? `M${x.toFixed(1)},${Y(D.top_ft[l]).toFixed(1)}` : `L${x.toFixed(1)},${Y(D.top_ft[l]).toFixed(1)}`)
          + `L${x.toFixed(1)},${Y(D.bot_ft[l]).toFixed(1)}`;
      }
      return `<path class="${cls}" d="${p}" fill="none" stroke="${col}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
    };
    if (gm) s += step(gm, "4 3", "#C9D3D6", 1.4, "temgrid");
    s += step(r, "", "#E4796A", 2.2, "temmodel");
    const yd = Y(Math.min(S.depth, DM));
    s += `<line class="temdepth" x1="${Lp}" y1="${yd}" x2="${w - Rp}" y2="${yd}" stroke="#E2BA14" stroke-width="1"><title>slice depth ${fmt(S.depth, 0)} ft</title></line>`;
    s += `<text x="${w - Rp}" y="${h - Bp - 3}" fill="${ink}" text-anchor="end">Ω·m</text></svg>`;
    return s;
  }
  function popupHtml(i) {
    const D = data();
    const [zl] = SBMM.elev(D.x[i], D.y[i]);
    const nb = nearestBoring(D.x[i], D.y[i], 150);
    let html = `<div class="pop temPop" data-tem="${esc(D.id[i])}"><b>${esc(D.id[i])}</b> · TEM sounding<br>`
      + `<span class="mono">E ${fmt(D.x[i], 1)} · N ${fmt(D.y[i], 1)} · ground ${fmt(D.z[i], 1)} ft`
      + (isFinite(zl) ? ` (lidar ${fmt(zl, 1)})` : "") + `</span><br>`
      + `${fmtV(Math.pow(10, soundingAt(i, S.depth)))} Ω·m at ${fmt(S.depth, 0)} ft`
      + (nb ? ` · ${esc(nb.h.id)} ${fmt0(nb.d)} ft away` : "")
      + `<div class="temProfWrap">${profileSvg(i, 300, 220)}</div>`
      + `<div class="tempKey"><i class="k1"></i>inverted model <i class="k2"></i>interpolated grid`
      + (nb ? ` <i class="k3"></i>${esc(nb.h.id)} logged contacts` : "") + `</div>`
      + `<div class="pop-actions"><span class="minib" data-tem-a="csv" data-tem-i="${i}" title="Copy this sounding's 20 layers as CSV">copy CSV</span>`
      + `<span class="minib" data-tem-a="card" title="The depth-slice card">slice card</span></div></div>`;
    return html;
  }
  function soundingCsv(i) {
    const D = data(), nl = NL();
    let out = `sounding,${D.id[i]}\neasting_ft,${D.x[i]}\nnorthing_ft,${D.y[i]}\nground_ft,${D.z[i]}\n\n`
      + "layer,top_ft,bottom_ft,top_m,bottom_m,resistivity_ohm_m\n";
    for (let l = 0; l < nl; l++)
      out += `${l + 1},${D.top_ft[l]},${D.bot_ft[l]},${D.top_m[l]},${D.bot_m[l]},${D.r[i * nl + l]}\n`;
    return out;
  }
  document.addEventListener("click", ev => {
    const b = ev.target.closest && ev.target.closest("[data-tem-a]");
    if (!b) return;
    const a = b.dataset.temA;
    if (a === "csv") copyText(soundingCsv(+b.dataset.temI), "sounding copied as CSV");
    else if (a === "card") open();
  });

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  function legendSvg(w) {
    if (!range) return "";
    w = w || 268;
    const st = (CMAPS[S.cmap] || CMAPS.hydro).slice();
    if (S.rev) st.reverse();
    const id = "temg_" + S.cmap + (S.rev ? "r" : "");
    let s = `<svg class="temleg" xmlns="http://www.w3.org/2000/svg" width="${w}" height="34" viewBox="0 0 ${w} 34" font-family="system-ui,sans-serif" font-size="10">`
      + `<defs><linearGradient id="${id}">`
      + st.map((c, k) => `<stop offset="${(k / (st.length - 1) * 100).toFixed(1)}%" stop-color="${c}"/>`).join("")
      + `</linearGradient></defs>`;
    if (S.classes > 1) {
      for (let c = 0; c < S.classes; c++) {
        const col = colorOf(fromT((c + 0.5) / S.classes));
        s += `<rect x="${4 + (w - 8) * c / S.classes}" y="4" width="${(w - 8) / S.classes + 0.5}" height="12" fill="${col}"/>`;
      }
    } else s += `<rect x="4" y="4" width="${w - 8}" height="12" fill="url(#${id})"/>`;
    for (const v of ticks()) {
      const x = 4 + (w - 8) * tRaw(v);
      s += `<line x1="${x}" y1="16" x2="${x}" y2="20" stroke="#9FB0B5"/>`
        + `<text x="${x}" y="31" fill="#9FB0B5" text-anchor="middle">${+v.toPrecision(3)}</text>`;
    }
    return s + "</svg>";
  }
  function fromT(t) {
    if (scale() === "log") return Math.pow(10, Math.log10(range.lo) + t * (Math.log10(range.hi) - Math.log10(range.lo)));
    return range.lo + t * (range.hi - range.lo);
  }
  function ticks() {
    const out = [];
    if (scale() === "log") {
      const a = Math.floor(Math.log10(range.lo)), b = Math.ceil(Math.log10(range.hi));
      for (let e = a; e <= b; e++) for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, e);
        if (v >= range.lo * 0.999 && v <= range.hi * 1.001) out.push(v);
      }
    } else {
      const span = range.hi - range.lo, st = Math.pow(10, Math.floor(Math.log10(span / 5)));
      const step = [1, 2, 5, 10].map(m => m * st).find(q => span / q <= 6);
      for (let v = Math.ceil(range.lo / step) * step; v <= range.hi + 1e-9; v += step) out.push(+v.toPrecision(6));
    }
    return out;
  }
  function sliceStats() {
    if (!slice) return null;
    const v = [];
    for (let i = 0; i < slice.f.length; i++) if (isFinite(slice.f[i])) v.push(toProp(slice.f[i]));
    if (!v.length) return null;
    return { n: v.length, med: percentile(v, 0.5), p5: percentile(v, 0.05), p95: percentile(v, 0.95) };
  }
  function selectHtml(name, opts, cur, title) {
    return `<select data-tem="${name}" title="${esc(title)}">`
      + opts.map(([v, t]) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${esc(t)}</option>`).join("")
      + "</select>";
  }
  function controlsHtml() {
    const DM = Math.floor(dmax());
    return `<div class="temctl">`
      + `<label class="temrow" title="Depth below the ground at each node">Depth <output data-tem-o="depth">${fmt(S.depth, 0)} ft</output>`
      + `<input type="range" data-tem="depth" min="0" max="${DM}" step="1" value="${S.depth}"></label>`
      + `<div class="temgrid2">`
      + `<label>Property ${selectHtml("prop", [["res", "Resistivity"], ["cond", "Conductivity"], ["sig", "Kriging s.e."]], S.prop, "What the slice shows")}</label>`
      + `<label>Colours ${selectHtml("cmap", Object.keys(CMAPS).map(k => [k, CMAP_NAME[k]]), S.cmap, "Colour map")}</label>`
      + `<label>Method ${selectHtml("method", Object.keys(METHOD_NAME).map(k => [k, METHOD_NAME[k]]), S.method, "Interpolation, one model layer at a time")}</label>`
      + `<label>Variogram ${selectHtml("vgType", Object.keys(VG_NAME).map(k => [k, VG_NAME[k]]), S.vgType, "Kriging variogram model, fitted to the data")}</label>`
      + `<label>Grid cell ${selectHtml("cell", [10, 15, 20, 30, 40].map(v => [v, v + " ft"]), S.cell, "Grid node spacing")}</label>`
      + `<label>Blank beyond ${selectHtml("blank", [20, 40, 60, 100, 150, 250].map(v => [v, v + " ft"]), S.blank, "No value farther than this from a sounding")}</label>`
      + `<label>Classes ${selectHtml("classes", [[0, "continuous"], [5, "5"], [8, "8"], [12, "12"]], S.classes, "Colour classes")}</label>`
      + `<label>Contours ${selectHtml("nCont", [[0, "off"], [8, "8 levels"], [12, "12 levels"], [20, "20 levels"]], S.contours ? S.nCont : 0, "Contour edges across the colour range")}</label>`
      + `</div>`
      + `<label class="temchk" title="Blend between model-layer mid-depths rather than step at layer boundaries"><input type="checkbox" data-tem="blend"${S.blend ? " checked" : ""}> blend between layers</label>`
      + `<label class="temchk" title="Fit a variogram to each layer rather than one to all"><input type="checkbox" data-tem="per"${S.per ? " checked" : ""}> variogram per layer</label>`
      + `<label class="temchk" title="Reverse the colour map"><input type="checkbox" data-tem="rev"${S.rev ? " checked" : ""}> reverse colours</label>`
      + `<div class="temlegwrap">${legendSvg()}</div>`
      + `<div class="temrange mono" title="Colour range, 2–98 % of the soundings">${range ? `${fmtV(range.lo)} – ${fmtV(range.hi)} ${PROP[S.prop].unit}` : ""}</div>`
      + `</div>`;
  }
  function cardRows() {
    const st = sliceStats(), D = data(), l = layerAt(S.depth);
    const P = PROP[S.prop];
    const vgTxt = R.method === "krig"
      ? (R.vgs ? `${VG_NAME[R.vg.type]}, fitted per layer`
               : `${VG_NAME[R.vg.type]} · range ${fmt0(R.vg.range)} ft · nugget ${R.vg.nug} of sill ${R.vg.sill}`)
      : null;
    const out = [
      [`${P.name} at ${fmt(S.depth, 0)} ft`, st ? `${fmtV(st.med)} ${P.unit}` : "—",
       st ? `median of ${fmt0(st.n)} nodes · 5–95 %: ${fmtV(st.p5)}–${fmtV(st.p95)}` : ""],
      ["5–95 % across the slice", st ? `${fmtV(st.p5)} – ${fmtV(st.p95)} ${P.unit}` : "—"],
      ["Model layer", `${l + 1} of ${D.nl} · ${fmt(D.top_ft[l], 1)}–${fmt(D.bot_ft[l], 1)} ft`
        + (S.blend ? " · blended" : "")],
      ["Method", METHOD_NAME[R.method] + (vgTxt ? " · " + vgTxt : "")],
      ["Grid", `${R.nx} × ${R.ny} at ${fmt0(R.dx)} ft · ${fmt0(R.nodes)} nodes within ${fmt0(R.blank)} ft of a sounding`],
      ["Soundings", `${fmt0(D.n)} · ${D.nl} layers to ${fmt0(dmax())} ft`],
      ["Run time", fmt0(R.ms_wall) + " ms"]
    ];
    return out;
  }
  function refreshCard() {
    if (!card || !card.isConnected || !R) return;
    SBMM.results.setRows(card, cardRows());
    const o = card.querySelector('[data-tem-o="depth"]');
    if (o) o.textContent = fmt(S.depth, 0) + " ft";
    const lg = card.querySelector(".temlegwrap"); if (lg) lg.innerHTML = legendSvg();
    const rg = card.querySelector(".temrange");
    if (rg) rg.textContent = range ? `${fmtV(range.lo)} – ${fmtV(range.hi)} ${PROP[S.prop].unit}` : "";
  }
  function showCard() {
    if (!R) return;
    if (card && card.isConnected) card.remove();
    card = SBMM.results.card(null, "TEM resistivity — depth slice", cardRows());
    card.classList.add("temcard");
    const box = document.createElement("div");
    box.innerHTML = controlsHtml();
    card.appendChild(box);
    box.addEventListener("input", ev => {
      const t = ev.target;
      if (t.dataset.tem !== "depth") return;
      S.depth = +t.value;
      save(); paint(); soon3d();
    });
    box.addEventListener("change", ev => {
      const t = ev.target, k = t.dataset.tem;
      if (!k || k === "depth") return;
      const rerun = ["method", "vgType", "cell", "blank", "per"].includes(k);
      if (t.type === "checkbox") S[k] = t.checked;
      else if (k === "nCont") { const n = +t.value; S.contours = n > 0; if (n > 0) S.nCont = n; }
      else S[k] = typeof DEF[k] === "number" ? +t.value : t.value;
      if (k === "prop") autoRange();
      if (k === "prop" && S.prop === "sig" && S.method !== "krig") toast("kriging standard error comes with the kriging method only");
      save();
      if (rerun) {
        run().then(res => { if (res) { if (S.prop === "sig") autoRange(); paintNow(); soon3d(); } });
      } else { paintNow(); soon3d(); }
    });
    const acts = document.createElement("div");
    acts.className = "pop-actions";
    acts.innerHTML = `<span class="minib" data-a="png" title="The slice as a PNG">PNG</span>`
      + `<span class="minib" data-a="csv" title="The slice as CSV (easting, northing, value)">slice CSV</span>`
      + `<span class="minib" data-a="model" title="Every node and every layer as CSV">model CSV</span>`
      + `<span class="minib" data-a="fit" title="Colour range from 2–98 % of the soundings">fit range</span>`;
    acts.addEventListener("click", ev => {
      const b = ev.target.closest("[data-a]"); if (!b) return;
      const a = b.dataset.a;
      if (a === "png") exportPng();
      else if (a === "csv") download("SBMM_TEM_slice_" + S.depth + "ft.csv", new Blob([sliceCsv()], { type: "text/csv" }));
      else if (a === "model") download("SBMM_TEM_model.csv", new Blob([modelCsv()], { type: "text/csv" }));
      else if (a === "fit") { autoRange(); paintNow(); soon3d(); }
    });
    card.appendChild(acts);
    SBMM.results.appendNote(card, NOTE);
  }

  /* ------------------------------------------------------------------ */
  /* exports                                                             */
  /* ------------------------------------------------------------------ */
  function sliceCsv() {
    if (!R) return "";
    const f = field(S.depth), N = R.nx * R.ny;
    let out = `# TEM2Go ${PROP[S.prop].name} (${PROP[S.prop].unit}) at ${S.depth} ft below ground; ${METHOD_NAME[R.method]}; EPSG:6418 ft\n`
      + "easting_ft,northing_ft,value\n";
    for (let id = 0; id < N; id++) {
      if (!isFinite(f[id])) continue;
      out += `${(R.x0 + (id % R.nx) * R.dx).toFixed(2)},${(R.y0 + Math.floor(id / R.nx) * R.dx).toFixed(2)},${+toProp(f[id]).toPrecision(5)}\n`;
    }
    return out;
  }
  function modelCsv() {
    if (!R) return "";
    const D = data(), N = R.nx * R.ny, nl = NL();
    let out = `# TEM2Go resistivity (ohm-m) by model layer; ${METHOD_NAME[R.method]}; EPSG:6418 ft; ground by IDW of the soundings\n`
      + "easting_ft,northing_ft,ground_ft";
    for (let l = 0; l < nl; l++) out += `,L${l + 1}_${D.top_ft[l]}_${D.bot_ft[l]}ft`;
    out += "\n";
    for (let id = 0; id < N; id++) {
      if (!R.mask[id]) continue;
      out += `${(R.x0 + (id % R.nx) * R.dx).toFixed(2)},${(R.y0 + Math.floor(id / R.nx) * R.dx).toFixed(2)},${R.surf[id].toFixed(2)}`;
      for (let l = 0; l < nl; l++) out += "," + (+Math.pow(10, R.log[l * N + id]).toPrecision(5));
      out += "\n";
    }
    return out;
  }
  function exportPng() {
    if (!slice) { toast("the depth slice is not on the map"); return; }
    const pad = 44, c = document.createElement("canvas");
    c.width = slice.W + 2 * 16; c.height = slice.H + pad + 16;
    const x = c.getContext("2d");
    x.fillStyle = "#0B1013"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(slice.canvas, 16, 16);
    x.fillStyle = "#DDE5E8"; x.font = "13px system-ui, sans-serif";
    x.fillText(`TEM ${PROP[S.prop].name.toLowerCase()} at ${S.depth} ft below ground · `
      + `${range ? fmtV(range.lo) + "–" + fmtV(range.hi) : ""} ${PROP[S.prop].unit} · ${CMAP_NAME[S.cmap]}`, 16, slice.H + 36);
    if (SBMM.watermark) SBMM.watermark.burn(c);
    c.toBlob(b => download("SBMM_TEM_slice_" + S.depth + "ft.png", b));
  }

  /* ------------------------------------------------------------------ */
  /* the rows                                                            */
  /* ------------------------------------------------------------------ */
  async function ensure(rowId) {
    const res = await run();
    if (!res) { if (rowId) SBMM.layerState.set("invest", rowId, { on: false }); return null; }
    paintNow();
    if (!card || !card.isConnected) showCard();
    soon3d();
    return res;
  }
  function build() {
    const D = data();
    if (!D || !D.n) return;
    autoRange();                 // the soundings alone set the default scale
    buildPoints();
    rows.tem_soundings = SBMM.addLayerRow("invest", `TEM soundings (${fmt0(D.n)})`, ptsGroup,
      { id: "tem_soundings", checked: false, swatch: PTS_COL, sub: SUB, subTitle: SUB_TITLE,
        onChange: st => { if (st.on) { recolourPoints(); if (!R) run().then(r => { if (r) paintNow(); }); } } });
    rows.tem_soundings.row.title = "Each dot coloured by its own inverted model at the slice depth";
    rows.tem_slice = SBMM.addLayerRow("invest", "Resistivity — depth slice", null,
      { id: "tem_slice", checked: false, swatch: "#27a0e3", opacity: 0.85, sub: SUB, subTitle: SUB_TITLE,
        onChange: async st => {
          if (!st.on) { paintNow(); soon3d(); return; }
          /* an opacity step arrives here too: no job, no repaint */
          if (R && overlay) { overlay.setOpacity(st.opacity); return; }
          await ensure("tem_slice");
        } });
    rows.tem_slice.row.title = "log10 resistivity interpolated layer by layer, sliced at a depth below ground";
    built = true;
  }

  /* TEM / GEOPHYS / RESISTIVITY [depth ft] */
  async function open(depth) {
    if (!data()) { toast("the TEM survey is not in this build"); return; }
    if (depth != null && isFinite(depth)) { S.depth = Math.max(0, Math.min(Math.floor(dmax()), +depth)); save(); }
    if (!on("tem_slice")) {
      const row = rows.tem_slice;
      if (row && row.cb) row.cb.click(); else SBMM.layerState.set("invest", "tem_slice", { on: true });
    }
    const res = await run();
    if (!res) return;
    paintNow();
    showCard();
    soon3d();
  }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  /* what js/viewer3d.js draws: the soundings as dots at the ground, and the
     slice as a sheet following the ground at the slice depth below it — under
     the terrain, so it reads through the fence clip box's trench */
  function points3d() {
    const D = data();
    if (!D || !on("tem_soundings")) return null;
    const col = [];
    for (let i = 0; i < D.n; i++) {
      const c = S.prop !== "sig" ? colorOf(toProp(soundingAt(i, S.depth))) : null;
      col.push(c || PTS_COL);
    }
    return { x: D.x, y: D.y, id: D.id, color: col };
  }
  function slice3d() {
    if (!R || !on("tem_slice")) return null;
    if (!slice || slice.depth !== S.depth) paintSlice();
    if (!slice) return null;
    return { canvas: slice.canvas, nx: R.nx, ny: R.ny, dx: R.dx, x0: R.x0, y0: R.y0,
             mask: R.mask, depth: S.depth,
             opacity: SBMM.layerState.opacity("invest", "tem_slice") };
  }
  function pick3d(i) {
    const D = data();
    if (!D || !D.id[i]) return null;
    return { title: D.id[i], html: popupHtml(i), xyz: [D.x[i], D.y[i]] };
  }
  function snapItems() {
    const D = data();
    if (!D) return [];
    const out = [];
    for (let i = 0; i < D.n; i++) out.push({ x: D.x[i], y: D.y[i], name: D.id[i] + " · TEM" });
    return out;
  }

  return {
    build, open, run, data, hoverText, valueAt, points3d, slice3d, pick3d, snapItems,
    popupHtml, profileSvg, soundingCsv, sliceCsv, modelCsv, legendSvg,
    settings: () => Object.assign({}, S),
    set(k, v) { if (k in DEF) { S[k] = v; save(); } },
    result: () => R, hasResult: () => !!R, slice: () => slice, range: () => range,
    card: () => card, rows: () => rows, built: () => built
  };
})();
