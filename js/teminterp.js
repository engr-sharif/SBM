/* SBMM Site Explorer — v38: two interpretations of the 2026 TEM survey
   (SBMM.teminterp), reached from Data ▾ → TEM geophysics and from the TEM
   workspace's own tabs.

     · BASE OF WASTE — the logged native contact of the 2025 borings mapped
       across the surveyed ground, by kriging. With the TEM as an EXTERNAL
       DRIFT where it helps: the depth of the steepest drop in resistivity in
       the top 60 ft (resistive waste over conductive native soil, which is
       what the borings say this site is, on balance). Which of the two maps is
       drawn is decided by leave-one-out cross-validation over the holes inside
       the survey, and the TEM has to cut that error by a tenth to be used —
       so the card can say plainly when it does not. The kriging standard error
       is the second map, and the new borings are placed where it is largest.
     · CONDUCTIVE ZONES — the harmonic-mean resistivity of an ELEVATION band
       below the impoundment's surveyed water level, the ground under the
       threshold, and the least-resistive route from the Herman impoundment to
       Clear Lake: the route whose most resistive point is least resistive.
       That point's resistivity is the lowest threshold at which one continuous
       conductive zone joins the two waters. Conductive ground can be
       mineralised water or clay; the TEM does not tell them apart and the card
       says so.

   The kernels are `temwaste` and `temseep` (js/compute.js, test/kernels.mjs
   --only teminterp). Both read the `tem` job's grid as it stands, so a
   method, cell or blanking change in the model re-runs them. Read-only
   project analysis like js/geophys.js: nothing is a store feature, nothing
   serialises, the settings are a view preference. */
"use strict";

SBMM.teminterp = (function () {

  const G = () => SBMM.geophys;
  const data = () => window.SBMM_DATA && SBMM_DATA.tem2026;
  const SUB = "Geophysics — TEM 2026";
  const SUB_TITLE = "TEM2Go transient electromagnetic soundings, LCI resistivity models, May 2026";
  const on = id => !!(SBMM.layerState && SBMM.layerState.isOn("invest", id));
  const fmtV = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const ac = ft2 => fmt(ft2 / 43560, 2);

  const NOTE_W = "logged native contacts, 2025 borings · TEM2Go LCI models, May 2026 · kriging, variogram chosen by "
    + "leave-one-out · interpreted · planning-level";
  const NOTE_S = "harmonic-mean resistivity of the band · conductive ground is mineralised water or clay, "
    + "the TEM does not tell them apart · interpreted · planning-level";

  /* the elevation bands, as depths below the impoundment's water level */
  const BANDS = [
    { id: "w0_50", top: 0, bot: 50 }, { id: "w0_100", top: 0, bot: 100 },
    { id: "w50_150", top: 50, bot: 150 }, { id: "w100_200", top: 100, bot: 200 }
  ];
  const DEF = { wMethod: "auto", wShow: "thick", wTargets: 5, sBand: "w0_100", sThr: 0 };
  let P = Object.assign({}, DEF);
  try {
    const st = SBMM.view && SBMM.view.pref("teminterp");
    if (st && typeof st === "object") for (const k in DEF) if (st[k] != null && typeof st[k] === typeof DEF[k]) P[k] = st[k];
  } catch (e) { /* a preference is a convenience */ }
  function save() { try { SBMM.view && SBMM.view.pref("teminterp", P); } catch (e) { /* ignore */ } }

  let W = null, Sp = null, wKey = "", sKey = "", wRun = null, sRun = null;
  let rows = {}, wGroup = null, sGroup = null, wOverlay = null, sOverlay = null, cards = {}, panes = {};
  let wCanvas = null, sCanvas = null;

  /* ------------------------------------------------------------------ */
  /* the waters                                                          */
  /* ------------------------------------------------------------------ */
  function waterRing(name) {
    const D = window.SBMM_DATA && SBMM_DATA.design_gis;
    if (!D || !D.features) return null;
    for (const f of D.features) {
      const p = f.properties || {};
      if (p.layer === "water" && p.name === name && f.geometry && f.geometry.type === "Polygon") return f.geometry.coordinates[0];
    }
    return null;
  }
  function inRing(r, x, y) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  /* the impoundment's water level: the August-2026 survey's shot, or, failing
     that, the median TEM ground over the impoundment, said so */
  let wlCache = null;
  function waterLevel() {
    if (wlCache) return wlCache;
    const ring = waterRing("Herman Impoundment");
    const f = ring && SBMM.water && SBMM.water.surveyFacts ? SBMM.water.surveyFacts(ring) : null;
    if (f && isFinite(f.waterLevel)) return (wlCache = { z: f.waterLevel, src: "surveyed Aug 2026" });
    const R = G() && G().result();
    if (R && ring) {
      const zs = [];
      for (let iy = 0; iy < R.ny; iy++) for (let ix = 0; ix < R.nx; ix++) {
        const id = iy * R.nx + ix;
        if (R.mask[id] && inRing(ring, R.x0 + ix * R.dx, R.y0 + iy * R.dx)) zs.push(R.surf[id]);
      }
      zs.sort((a, b) => a - b);
      if (zs.length) return (wlCache = { z: +zs[zs.length >> 1].toFixed(2), src: "TEM ground over the impoundment" });
    }
    return null;
  }
  const bandOf = id => BANDS.find(b => b.id === id) || BANDS[1];
  function bandWords(b, short) {
    const wl = waterLevel();
    if (!wl) return `${b.top}–${b.bot} ft below the water level`;
    const el = `${fmt0(wl.z - b.top)}–${fmt0(wl.z - b.bot)} ft`;
    return short ? el : `${el} · ${b.top}–${b.bot} ft below the impoundment`;
  }

  /* ------------------------------------------------------------------ */
  /* the jobs                                                            */
  /* ------------------------------------------------------------------ */
  function holesNear(R) {
    const B = SBMM.borelogs;
    if (!B || !B.has || !B.has()) return [];
    const pad = 400, x1 = R.x0 + (R.nx - 1) * R.dx, y1 = R.y0 + (R.ny - 1) * R.dx, out = [];
    for (const h of B.holes()) {
      const c = h.contacts || {};
      if (c.native_contact == null || !isFinite(h.x) || !isFinite(h.y)) continue;
      if (h.x < R.x0 - pad || h.x > x1 + pad || h.y < R.y0 - pad || h.y > y1 + pad) continue;
      out.push({ id: h.id, x: h.x, y: h.y, d: +c.native_contact });
    }
    return out;
  }
  /* the survey's nodes less open water: a thickness of waste under the
     impoundment or the lake is not a quantity anyone digs, so the map, the
     volume and the proposed borings all stop at EA's water polygons */
  let dryOf = null;
  function dryMask(R) {
    if (dryOf && dryOf.R === R) return dryOf;
    const D = window.SBMM_DATA && SBMM_DATA.design_gis, rings = [];
    const x1 = R.x0 + (R.nx - 1) * R.dx, y1 = R.y0 + (R.ny - 1) * R.dx;
    for (const f of (D && D.features) || []) {
      const p = f.properties || {};
      if (p.layer !== "water" || !f.geometry || f.geometry.type !== "Polygon") continue;
      const r = f.geometry.coordinates[0];
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const q of r) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); }
      if (c < R.x0 || a > x1 || d < R.y0 || b > y1) continue;
      rings.push({ r, a, b, c, d });
    }
    const m = new Uint8Array(R.mask);
    let wet = 0;
    for (let iy = 0; iy < R.ny; iy++) for (let ix = 0; ix < R.nx; ix++) {
      const id = iy * R.nx + ix;
      if (!m[id]) continue;
      const x = R.x0 + ix * R.dx, y = R.y0 + iy * R.dx;
      for (const g of rings) if (x >= g.a && x <= g.c && y >= g.b && y <= g.d && inRing(g.r, x, y)) { m[id] = 0; wet++; break; }
    }
    dryOf = { R, mask: m, wet };
    return dryOf;
  }
  const gridOf = (R, D) => ({ nx: R.nx, ny: R.ny, dx: R.dx, x0: R.x0, y0: R.y0, nl: D.nl,
                              mask: R.mask, log: R.log, top_ft: D.top_ft, bot_ft: D.bot_ft });
  async function runWaste(force) {
    if (!data()) { toast("the TEM survey is not in this build"); return null; }
    if (!SBMM.borelogs || !SBMM.borelogs.has || !SBMM.borelogs.has()) { toast("this build has no boring logs"); return null; }
    const R = await G().run();
    if (!R) return null;
    const key = R.key + "|" + P.wMethod + "|" + P.wTargets;
    if (W && wKey === key && !force) return W;
    if (wRun) return wRun;
    wRun = (async () => {
      try {
        const dm = dryMask(R);
        const job = Object.assign(gridOf(R, data()), { mask: dm.mask, holes: holesNear(R), method: P.wMethod,
          breakFt: 60, targets: P.wTargets, spacing: 200 });
        const t0 = performance.now();
        const res = await SBMM.compute.run("temwaste", job, { label: "TEM base of waste" }).promise;
        res.ms_wall = Math.round(performance.now() - t0);
        res.wetNodes = dm.wet;
        W = res; wKey = key; wCanvas = null;
        return W;
      } catch (e) {
        if (e && e.cancelled) toast("base of waste cancelled");
        else toast("base of waste failed: " + (e.message || e));
        return null;
      }
    })().finally(() => { wRun = null; });
    const out = await wRun;
    if (out && wKey !== R.key + "|" + P.wMethod + "|" + P.wTargets) return runWaste();
    return out;
  }
  function masksFor(R) {
    const N = R.nx * R.ny, src = new Uint8Array(N), dst = new Uint8Array(N);
    const H = waterRing("Herman Impoundment"), Lk = waterRing("Clear Lake");
    for (let iy = 0; iy < R.ny; iy++) for (let ix = 0; ix < R.nx; ix++) {
      const id = iy * R.nx + ix, x = R.x0 + ix * R.dx, y = R.y0 + iy * R.dx;
      if (!R.mask[id]) continue;
      if (H && inRing(H, x, y)) src[id] = 1;
      if (Lk && inRing(Lk, x, y)) dst[id] = 1;
    }
    return { src, dst, herman: !!H, lake: !!Lk };
  }
  const seepKey = R => R.key + "|" + P.sBand + "|" + P.sThr;
  async function runSeep(force) {
    if (!data()) { toast("the TEM survey is not in this build"); return null; }
    const R = await G().run();
    if (!R) return null;
    const wl = waterLevel();
    if (!wl) { toast("the Herman impoundment is not in this build"); return null; }
    const key = seepKey(R);
    if (Sp && sKey === key && !force) return Sp;
    if (sRun) return sRun;
    sRun = (async () => {
      try {
        const b = bandOf(P.sBand), m = masksFor(R);
        const job = Object.assign(gridOf(R, data()), { surf: R.surf, zTop: wl.z - b.top, zBot: wl.z - b.bot,
          thr: P.sThr > 0 ? P.sThr : 0, thrPct: 0.1, src: m.src, dst: m.dst });
        const t0 = performance.now();
        const res = await SBMM.compute.run("temseep", job, { label: "TEM conductive zones" }).promise;
        res.ms_wall = Math.round(performance.now() - t0);
        res.band = b; res.wl = wl;
        Sp = res; sKey = key; sCanvas = null;
        return Sp;
      } catch (e) {
        if (e && e.cancelled) toast("conductive zones cancelled");
        else toast("conductive zones failed: " + (e.message || e));
        return null;
      }
    })().finally(() => { sRun = null; });
    const out = await sRun;
    if (out && sKey !== seepKey(R)) return runSeep();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* colour                                                              */
  /* ------------------------------------------------------------------ */
  const RAMP_T = ["#FFF1BF", "#FDD589", "#F9AE52", "#EB7F2E", "#C9561D", "#963813", "#5E230B"];
  const RAMP_E = ["#E6F0F4", "#B8D2DF", "#88B3CA", "#5A93B4", "#33729A", "#1C5177"];
  const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    const p = t * (stops.length - 1), a = Math.min(stops.length - 2, Math.floor(p)), f = p - a;
    const A = rgb(stops[a]), B = rgb(stops[a + 1]);
    return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
  }
  const niceTop = (v, step) => Math.max(step, Math.ceil(v / step) * step);
  function wScale() {
    if (!W) return null;
    if (P.wShow === "se") {
      let mx = 0;
      for (let i = 0; i < W.se.length; i++) if (W.se[i] > mx) mx = W.se[i];
      return { stops: RAMP_E, lo: 0, hi: niceTop(mx, 5), unit: "ft", name: "Standard error" };
    }
    let mn = Infinity;
    for (let i = 0; i < W.depth.length; i++) if (W.depth[i] < mn) mn = W.depth[i];
    const lo = isFinite(mn) ? Math.max(0, Math.floor(mn / 5) * 5) : 0;
    return { stops: RAMP_T, lo, hi: Math.max(lo + 5, niceTop(W.max_ft, 5)), unit: "ft", name: "Waste thickness" };
  }
  /* the band map: resistivity on the hydrogeophysics scale every TEM view
     uses (blue conductive, red resistive), log between the band's 2nd and
     98th percentiles; the ground under the threshold is OUTLINED, in white,
     and the zones that join both waters in yellow (gridCanvas edges) */
  const HYDRO = ["#1b2a8f", "#1f5fc9", "#27a0e3", "#3ec8b4", "#7fd857", "#d9e23a", "#f6b42c", "#ec6a1f", "#c8232a", "#9e1068"];
  function seepScale() {
    const v = Array.from(Sp.rho).filter(isFinite).sort((p, q) => p - q);
    const q = f => v[Math.min(v.length - 1, Math.round(f * (v.length - 1)))];
    const nice = x => +x.toPrecision(2);
    return { lo: nice(q(0.02)), hi: nice(q(0.98)) };
  }
  function seepRGBA(v, sc) {
    if (!isFinite(v)) return null;
    const t = (Math.log10(v) - Math.log10(sc.lo)) / (Math.log10(sc.hi) - Math.log10(sc.lo));
    const c = ramp(HYDRO, t);
    return [c[0], c[1], c[2], 225];
  }

  /* one canvas per map, north up, a pixel per node scaled up and smoothed */
  function gridCanvas(nx, ny, colorAt, edges) {
    const cv = document.createElement("canvas"); cv.width = nx; cv.height = ny;
    const x = cv.getContext("2d"), im = x.createImageData(nx, ny);
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const c = colorAt(iy * nx + ix), o = ((ny - 1 - iy) * nx + ix) * 4;
      if (!c) continue;
      im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = c[3] == null ? 230 : c[3];
    }
    x.putImageData(im, 0, 0);
    const up = Math.max(2, Math.min(8, Math.floor(1200 / Math.max(nx, ny))));
    const big = document.createElement("canvas"); big.width = nx * up; big.height = ny * up;
    const bx = big.getContext("2d");
    bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = "high";
    bx.drawImage(cv, 0, 0, big.width, big.height);
    /* outlines: an edge wherever a flagged node meets an unflagged one;
       later passes draw over earlier ones */
    for (const E of edges || []) {
      bx.strokeStyle = E.color; bx.lineWidth = E.width || 1.5; bx.beginPath();
      const f = (ix, iy) => ix >= 0 && iy >= 0 && ix < nx && iy < ny && E.flag(iy * nx + ix);
      for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
        if (!f(ix, iy)) continue;
        const X0 = ix * up, X1 = (ix + 1) * up, Y0 = (ny - 1 - iy) * up, Y1 = Y0 + up;
        if (!f(ix + 1, iy)) { bx.moveTo(X1, Y0); bx.lineTo(X1, Y1); }
        if (!f(ix - 1, iy)) { bx.moveTo(X0, Y0); bx.lineTo(X0, Y1); }
        if (!f(ix, iy + 1)) { bx.moveTo(X0, Y0); bx.lineTo(X1, Y0); }
        if (!f(ix, iy - 1)) { bx.moveTo(X0, Y1); bx.lineTo(X1, Y1); }
      }
      bx.stroke();
    }
    return big;
  }
  function wasteCanvas() {
    if (!W) return null;
    if (wCanvas && wCanvas.show === P.wShow) return wCanvas.cv;
    const sc = wScale(), arr = P.wShow === "se" ? W.se : W.depth;
    const cv = gridCanvas(W.nx, W.ny, id => {
      const v = arr[id];
      if (!isFinite(v)) return null;
      const c = ramp(sc.stops, (v - sc.lo) / (sc.hi - sc.lo));
      return [c[0], c[1], c[2], P.wShow === "thick" && v < 0.5 ? 70 : 215];
    });
    wCanvas = { cv, show: P.wShow };
    return cv;
  }
  function seepCanvas() {
    if (!Sp) return null;
    if (sCanvas) return sCanvas;
    const sc = seepScale();
    sCanvas = gridCanvas(Sp.nx, Sp.ny, id => seepRGBA(Sp.rho[id], sc), [
      { flag: id => Sp.below[id] === 1, color: "rgba(255,255,255,.95)", width: 1.6 },
      { flag: id => Sp.linked[id] === 1, color: "#F2D04B", width: 2.4 }]);
    return sCanvas;
  }
  const boundsOf = r => { const h = r.dx / 2;
    return [[r.y0 - h, r.x0 - h], [r.y0 + (r.ny - 1) * r.dx + h, r.x0 + (r.nx - 1) * r.dx + h]]; };

  /* a horizontal legend bar: `ticks` in the bar's own units, `labels` the
     words printed under them (the ticks themselves when absent) */
  function legendSvg(stops, lo, hi, w, ticks, labels) {
    w = w || 280;
    const id = "tilg" + stops.length + stops[0].slice(1);
    let s = `<svg class="tileg" xmlns="http://www.w3.org/2000/svg" width="${w}" height="34" viewBox="0 0 ${w} 34" font-family="system-ui,sans-serif" font-size="10">`
      + `<defs><linearGradient id="${id}">` + stops.map((c, i) => `<stop offset="${(i / (stops.length - 1) * 100).toFixed(1)}%" stop-color="${c}"/>`).join("")
      + `</linearGradient></defs><rect x="6" y="4" width="${w - 12}" height="12" rx="2" fill="url(#${id})"/>`;
    const tk = ticks || [lo, (lo + hi) / 2, hi];
    tk.forEach((v, i) => {
      const x = 6 + (v - lo) / (hi - lo) * (w - 12), anchor = i === 0 ? "start" : i === tk.length - 1 ? "end" : "middle";
      const lab = labels ? labels[i] : v;
      s += `<text x="${x.toFixed(1)}" y="29" fill="#9FB0B5" text-anchor="${anchor}">${typeof lab === "number" ? (Number.isInteger(lab) ? lab : fmtV(lab)) : lab}</text>`;
    });
    return s + `</svg>`;
  }
  function wasteLegend(w) {
    const sc = wScale();
    if (!sc) return "";
    return `<div class="tilegh">${sc.name}, ft</div>` + legendSvg(sc.stops, sc.lo, sc.hi, w);
  }
  function seepLegend(w) {
    if (!Sp) return "";
    const sc = seepScale(), t = Sp.thr;
    const tk = [sc.lo, Math.round(Math.sqrt(sc.lo * sc.hi) * 10) / 10, sc.hi];
    const lg = legendSvg(HYDRO, Math.log10(sc.lo), Math.log10(sc.hi), w, tk.map(Math.log10), tk);
    const sw = (style, label) => `<span class="tisw"><i style="${style}"></i>${label}</span>`;
    return `<div class="tilegh">Band resistivity, Ω·m</div>${lg}<div class="tikey">`
      + sw("background:transparent;box-shadow:inset 0 0 0 1.6px #fff", `below ${fmtV(t)} Ω·m`)
      + sw("background:transparent;box-shadow:inset 0 0 0 2px #F2D04B", "below it and joining both waters")
      + `<span class="tisw"><i class="tiroute"></i>least-resistive route</span></div>`;
  }

  /* ------------------------------------------------------------------ */
  /* the map                                                             */
  /* ------------------------------------------------------------------ */
  function wTip(t, i) {
    return `<b>Proposed boring T${i + 1}</b> · base of waste ${fmt(t.depth, 0)} ± ${fmt(t.se, 0)} ft`;
  }
  function wPopup(t, i) {
    const [lat, lon] = SBMM.toLL ? SBMM.toLL(t.x, t.y) : [NaN, NaN];
    return `<div class="tipop"><b>Proposed boring T${i + 1}</b>`
      + `<div class="mono">E ${fmt0(t.x)} · N ${fmt0(t.y)}</div>`
      + `<div class="mono">${isFinite(lat) ? lat.toFixed(6) + ", " + lon.toFixed(6) : ""}</div>`
      + `<div>Predicted base of waste <b>${fmt(t.depth, 1)} ft</b> · standard error ${fmt(t.se, 1)} ft</div>`
      + `<div class="mut">largest uncertainty on the map, ${fmt0(W.spacing)} ft or more from the other proposals</div></div>`;
  }
  function paintWaste() {
    if (!wGroup) wGroup = L.layerGroup();
    wGroup.clearLayers(); wOverlay = null;
    if (!W || !on("tem_waste")) { if (SBMM.map.hasLayer(wGroup)) SBMM.map.removeLayer(wGroup); return; }
    const cv = wasteCanvas();
    wOverlay = L.imageOverlay(cv.toDataURL("image/png"), boundsOf(W), { pane: "analysis", interactive: false,
      opacity: SBMM.layerState.opacity("invest", "tem_waste") });
    wGroup.addLayer(wOverlay);
    W.targets.forEach((t, i) => {
      const m = L.marker([t.y, t.x], { pane: "vectors", keyboard: false,
        icon: L.divIcon({ className: "titgt", html: `<span>T${i + 1}</span>`, iconSize: [26, 18], iconAnchor: [13, 9] }) });
      m.bindTooltip(wTip(t, i), { sticky: true, className: "tiptip" });
      m.bindPopup(() => wPopup(t, i));
      m._tiTarget = i;
      wGroup.addLayer(m);
    });
    if (!SBMM.map.hasLayer(wGroup)) wGroup.addTo(SBMM.map);
  }
  function routeTip() {
    const r = Sp.route;
    return `<b>Least-resistive route</b> · Herman impoundment → Clear Lake · ${fmt0(r.length_ft)} ft · `
      + `most resistive point ${fmtV(r.bottleneck)} Ω·m`;
  }
  function paintSeep() {
    if (!sGroup) sGroup = L.layerGroup();
    sGroup.clearLayers(); sOverlay = null;
    if (!Sp || !on("tem_seep")) { if (SBMM.map.hasLayer(sGroup)) SBMM.map.removeLayer(sGroup); return; }
    sOverlay = L.imageOverlay(seepCanvas().toDataURL("image/png"), boundsOf(Sp), { pane: "analysis", interactive: false,
      opacity: SBMM.layerState.opacity("invest", "tem_seep") });
    sGroup.addLayer(sOverlay);
    const r = Sp.route;
    if (r && r.pts.length > 1) {
      const ll = r.pts.map(p => [p[1], p[0]]);
      sGroup.addLayer(L.polyline(ll, { pane: "vectors", color: "#0B1013", weight: 7, opacity: 0.55, interactive: false }));
      const line = L.polyline(ll, { pane: "vectors", color: "#F2D04B", weight: 3.5, opacity: 0.95 });
      line.bindTooltip(routeTip(), { sticky: true, className: "tiptip" });
      line.bindPopup(() => `<div class="tipop">${routeTip()}<div class="mut">${esc(bandWords(Sp.band))}</div></div>`);
      sGroup.addLayer(line);
      const bn = L.circleMarker([r.at[1], r.at[0]], { pane: "vectors", radius: 6, color: "#F2D04B", weight: 2,
        fillColor: "#0B1013", fillOpacity: 0.9 });
      bn.bindTooltip(`<b>Most resistive point on the route</b> · ${fmtV(r.bottleneck)} Ω·m`, { sticky: true, className: "tiptip" });
      bn.bindPopup(() => `<div class="tipop"><b>Most resistive point on the route</b>`
        + `<div>${fmtV(r.bottleneck)} Ω·m · the lowest threshold that joins the two waters</div>`
        + `<div class="mono">E ${fmt0(r.at[0])} · N ${fmt0(r.at[1])}</div></div>`);
      sGroup.addLayer(bn);
    }
    if (!SBMM.map.hasLayer(sGroup)) sGroup.addTo(SBMM.map);
  }
  function soon3d() {
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen && SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshOverlays)
      SBMM.viewer3d.refreshOverlays();
  }
  function emit(kind) { if (SBMM.events) SBMM.events.emit("teminterp", { kind }); }
  async function ensure(kind) {
    const res = kind === "waste" ? await runWaste() : await runSeep();
    if (!res || !data()) { SBMM.layerState.set("invest", kind === "waste" ? "tem_waste" : "tem_seep", { on: false }); return null; }
    if (kind === "waste") paintWaste(); else paintSeep();
    refreshCard(kind);
    soon3d();
    emit(kind);
    return res;
  }

  /* the status-bar reading under the pointer */
  function nodeOf(r, x, y) {
    const ix = Math.round((x - r.x0) / r.dx), iy = Math.round((y - r.y0) / r.dx);
    if (ix < 0 || iy < 0 || ix >= r.nx || iy >= r.ny) return -1;
    return iy * r.nx + ix;
  }
  function hoverText(x, y) {
    let s = "";
    if (W && on("tem_waste")) {
      const id = nodeOf(W, x, y);
      if (id >= 0 && isFinite(W.depth[id])) s += ` · waste ${fmt(W.depth[id], 0)} ± ${fmt(W.se[id], 0)} ft`;
    }
    if (Sp && on("tem_seep")) {
      const id = nodeOf(Sp, x, y);
      if (id >= 0 && isFinite(Sp.rho[id])) s += ` · band ρ ${fmtV(Sp.rho[id])} Ω·m`;
    }
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* the words: one summary each, for the card and the workspace tab      */
  /* ------------------------------------------------------------------ */
  const MWORD = { borings: "borings only", tem: "borings + TEM" };
  function wasteRows() {
    if (!W) return [];
    const cv = W.cv, b = cv.borings, t = cv.tem, M = W.method === "tem" ? t : b;
    const nIn = W.holes.filter(h => h.inSurvey).length, used = k => W.method === k ? " · used" : "";
    const loo = `leave-one-out over the ${nIn} holes inside the survey`;
    return [
      ["Waste volume", sig2(W.volume_yd3) + " yd³", `over the ${ac(W.cells * W.dx * W.dx)} dry acres of the survey footprint (open water left out) · planning-level, 2 significant figures`],
      ["Waste ≥ 1 ft thick", ac(W.area_ft2) + " ac"],
      ["Thickness, mean · max", `${fmt(W.mean_ft, 1)} · ${fmt(W.max_ft, 1)} ft`],
      ["Map from", `${MWORD[W.method]} · ${fmt0(M.holes)} holes`,
       W.method === "tem" ? `kriging with the TEM break depth as an external drift · base = ${fmt(t.a, 1)} + ${fmt(t.b, 2)} × break`
                          : "ordinary kriging of the logged native contacts" + (W.asked === "auto" ? " · chosen by cross-validation" : "")],
      ["Error, borings only", `±${fmt(b.rmse, 1)} ft${used("borings")}`, loo],
      ["Error, borings + TEM", `±${fmt(t.rmse, 1)} ft${used("tem")}`,
       loo + `; the TEM is used only when it cuts the error by ${Math.round(W.gain * 100)} %`],
      ["Error, average of holes", `±${fmt(cv.mean.rmse, 1)} ft`, loo + "; each hole predicted by the plain average of the others"],
      ["TEM break vs contact", `r = ${fmt(t.r, 2)} · ${fmt0(t.holes)} holes`,
       `depth of the steepest drop in resistivity in the top ${fmt0(W.breakFt)} ft against each hole's logged native contact`],
      ["Variogram", `exp · ${fmt0(M.range)} ft · nugget ${Math.round(M.nugRatio * 100)} %`, "exponential, range and nugget share of the sill chosen by cross-validation"]
    ];
  }
  /* the one-line finding — data-tem-finding carries it for the harness */
  function wasteFinding() {
    if (!W) return { k: "", text: "" };
    const b = W.cv.borings, t = W.cv.tem, m = W.cv.mean;
    if (W.method === "tem") return { k: "tem", text: `TEM improves the map: ±${fmt(t.rmse, 1)} ft against ±${fmt(b.rmse, 1)} ft from the borings alone.` };
    const k = Math.min(b.rmse, t.rmse) >= m.rmse * 0.95 ? "flat" : "borings";
    if (k === "flat") return { k, text: `Between holes the logged base varies more than ${fmt0(W.cv.mean.n)} borings resolve: `
      + `the map's error is ±${fmt(b.rmse, 1)} ft against ±${fmt(m.rmse, 1)} ft for their plain average, and the TEM does not close the gap (±${fmt(t.rmse, 1)} ft).` };
    return { k, text: `TEM does not improve on the borings here: ±${fmt(t.rmse, 1)} ft against ±${fmt(b.rmse, 1)} ft.` };
  }
  function targetsHtml() {
    if (!W || !W.targets.length) return "";
    return `<table class="titab mono"><thead><tr><th></th><th>Easting</th><th>Northing</th><th>Base, ft</th><th>±, ft</th></tr></thead><tbody>`
      + W.targets.map((t, i) => `<tr data-tgt="${i}"><td>T${i + 1}</td><td>${fmt0(t.x)}</td><td>${fmt0(t.y)}</td>`
        + `<td>${fmt(t.depth, 0)}</td><td>${fmt(t.se, 0)}</td></tr>`).join("") + `</tbody></table>`;
  }
  function holesHtml() {
    if (!W) return "";
    const hs = W.holes.filter(h => h.inSurvey);
    return `<table class="titab mono"><thead><tr><th>Boring</th><th>Logged, ft</th><th>Predicted, ft</th><th>TEM break, ft</th></tr></thead><tbody>`
      + hs.map(h => `<tr><td>${esc(h.id)}</td><td>${fmt(h.d, 1)}</td><td>${fmt(h.loo, 1)}</td><td>${fmt(h.s, 1)}</td></tr>`).join("")
      + `</tbody></table>`;
  }
  function seepRows() {
    if (!Sp) return [];
    const r = Sp.route, st = Sp.stats;
    const out = [["Band", bandWords(Sp.band, true), `${Sp.band.top}–${Sp.band.bot} ft below the impoundment's water level, ${fmt(Sp.wl.z, 2)} ft (${Sp.wl.src})`],
      ["Conductive below", `${fmtV(Sp.thr)} Ω·m`, Sp.thrAuto ? "the band's most conductive tenth" : "set by hand"]];
    if (r) {
      out.push(["Lowest connecting ρ", `${fmtV(r.bottleneck)} Ω·m`,
                "the most resistive point on the least-resistive route: under this no continuous zone joins the two waters"]);
      out.push(["Route length", `${fmt0(r.length_ft)} ft`]);
      out.push(["Route median ρ", `${fmtV(r.median)} Ω·m`]);
      out.push(["Route below threshold", `${Math.round(r.belowFrac * 100)} %`]);
    } else out.push(["Route", "none in this band"]);
    out.push(["Conductive area", `${ac(Sp.area_ft2)} ac`]);
    out.push(["Zones joining both", Sp.linkedZones ? String(Sp.linkedZones) : "none"]);
    out.push(["Band median ρ", `${fmtV(st.p50)} Ω·m`, `${fmt0(st.n)} nodes`]);
    out.push(["Band 10–90 %", `${fmtV(st.p10)}–${fmtV(st.p90)} Ω·m`]);
    return out;
  }
  function seepFinding() {
    if (!Sp) return { k: "", text: "" };
    const r = Sp.route;
    if (!r) return { k: "none", text: "The model does not reach both waters in this band." };
    if (Sp.linkedZones) return { k: "joined", text: `A continuous zone below ${fmtV(Sp.thr)} Ω·m joins the Herman impoundment to Clear Lake in this band.` };
    const rel = r.bottleneck / Sp.stats.p50;
    return { k: rel < 1 ? "path" : "weak",
             text: `The most conductive connection reaches ${fmtV(r.bottleneck)} Ω·m at its worst point — `
               + (rel < 1 ? `${Math.round((1 - rel) * 100)} % below the band's median of ${fmtV(Sp.stats.p50)} Ω·m.`
                          : `no lower than the band's median of ${fmtV(Sp.stats.p50)} Ω·m.`) };
  }

  /* the section along the route: the model from the ground down past the
     band, the band's two elevations, the impoundment's water level, the
     route's conductive stretches as a strip along the top */
  function sectionSvg(w, h) {
    if (!Sp || !Sp.route || Sp.route.pts.length < 2) return "";
    w = w || 300; h = h || 190;
    const pts = Sp.route.pts, gp = [];
    let sta = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) {
        const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(d / 10));
        for (let k = 1; k <= n; k++) {
          const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
          sta += d / n;
          const [z] = SBMM.elev(x, y);
          gp.push({ sta, x, y, z, node: i });
        }
      } else { const [z] = SBMM.elev(pts[0][0], pts[0][1]); gp.push({ sta: 0, x: pts[0][0], y: pts[0][1], z, node: 0 }); }
    }
    const zs = gp.map(q => q.z).filter(isFinite);
    if (!zs.length) return "";
    const zTop = Math.ceil((Math.max(...zs) + 8) / 10) * 10, zBot = Math.floor((Sp.zBot - 25) / 10) * 10;
    const img = G().sectionImage(gp, zTop, zBot);
    const Lp = 42, Rp = 8, Tp = 22, Bp = 26, PW = w - Lp - Rp, PH = h - Tp - Bp, L = sta;
    const X = s => Lp + s / L * PW, Y = z => Tp + (zTop - z) / (zTop - zBot) * PH;
    const ink = "#9FB0B5", rule = "rgba(159,176,181,.22)";
    let s = `<svg class="tisec" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui,sans-serif" font-size="9.5">`
      + `<rect width="${w}" height="${h}" rx="4" fill="#0F1518"/>`;
    if (img && img.url) s += `<image href="${img.url}" x="${Lp}" y="${Tp}" width="${PW}" height="${PH}" preserveAspectRatio="none" opacity=".92"/>`;
    const zStep = (zTop - zBot) > 250 ? 100 : 50;
    for (let z = Math.ceil(zBot / zStep) * zStep; z <= zTop; z += zStep)
      s += `<line x1="${Lp}" y1="${Y(z).toFixed(1)}" x2="${w - Rp}" y2="${Y(z).toFixed(1)}" stroke="${rule}"/>`
        + `<text x="${Lp - 4}" y="${(Y(z) + 3).toFixed(1)}" fill="${ink}" text-anchor="end">${fmt0(z)}</text>`;
    /* the band */
    for (const z of [Sp.zTop, Sp.zBot])
      s += `<line class="tiband" x1="${Lp}" y1="${Y(z).toFixed(1)}" x2="${w - Rp}" y2="${Y(z).toFixed(1)}" stroke="#F2D04B" stroke-width="1.2" stroke-dasharray="5 3"/>`;
    /* the water level */
    s += `<line class="tiwl" x1="${Lp}" y1="${Y(Sp.wl.z).toFixed(1)}" x2="${X(L * 0.35).toFixed(1)}" y2="${Y(Sp.wl.z).toFixed(1)}" stroke="#5CC0DB" stroke-width="1.6"/>`
      + `<text x="${Lp + 3}" y="${(Y(Sp.wl.z) - 3).toFixed(1)}" fill="#5CC0DB">water ${fmt(Sp.wl.z, 1)}</text>`;
    /* the ground */
    let d = "";
    gp.forEach((q, i) => { if (isFinite(q.z)) d += (d ? "L" : "M") + X(q.sta).toFixed(1) + "," + Y(q.z).toFixed(1); });
    s += `<path d="${d}" fill="none" stroke="#E8EEF1" stroke-width="1.4"/>`;
    /* the conductive stretches of the route, along the top */
    const R0 = Sp.route;
    let st0 = 0;
    for (let i = 1; i < R0.pts.length; i++) {
      const seg = Math.hypot(R0.pts[i][0] - R0.pts[i - 1][0], R0.pts[i][1] - R0.pts[i - 1][1]);
      if (R0.rho[i] < Sp.thr && R0.rho[i - 1] < Sp.thr)
        s += `<rect class="tibelow" x="${X(st0).toFixed(1)}" y="${Tp - 8}" width="${Math.max(1, X(st0 + seg) - X(st0)).toFixed(1)}" height="4" fill="#E4572E"/>`;
      st0 += seg;
    }
    s += `<text x="${Lp}" y="${h - 9}" fill="${ink}">Herman impoundment</text>`
      + `<text x="${w - Rp}" y="${h - 9}" fill="${ink}" text-anchor="end">Clear Lake · ${fmt0(L)} ft</text>`
      + `<text x="${Lp}" y="11" fill="${ink}">ft NAVD88 · ${img ? esc(img.label) : ""}</text></svg>`;
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* the cards                                                           */
  /* ------------------------------------------------------------------ */
  /* the exports, as card chips (span) or panel buttons (button) */
  function actsHtml(kind, tag, withWs) {
    const T = tag || "span", ws = withWs !== false && !document.body.classList.contains("field");
    const b = (a, t, label) => `<${T} class="minib" data-ti-a="${a}" title="${esc(t)}">${label}</${T}>`;
    if (kind === "waste")
      return b("wcsv", "Every node: thickness, base elevation, standard error", "grid CSV")
        + b("tcsv", "The proposed borings", "borings CSV")
        + b("wgj", "The proposed borings as GeoJSON", "GeoJSON")
        + (ws ? b("ws", "The TEM workspace at this analysis (TEMWASTE)", "workspace") : "");
    return b("scsv", "Every node: band resistivity, conductance, conductive", "grid CSV")
      + b("rcsv", "The route, node by node", "route CSV")
      + b("sgj", "The route as GeoJSON", "GeoJSON")
      + (ws ? b("ws", "The TEM workspace at this analysis (TEMSEEP)", "workspace") : "");
  }
  function cardBody(kind) {
    if (kind === "waste") {
      const f = wasteFinding();
      return `<div class="tifind" data-tem-finding="${f.k}">${esc(f.text)}</div>`
        + `<div class="tilegwrap">${wasteLegend(280)}</div>`
        + `<div class="tisub">Proposed borings</div>${targetsHtml()}`
        + `<details class="tidet"><summary>Cross-validation, hole by hole</summary>${holesHtml()}</details>`;
    }
    const f = seepFinding();
    return `<div class="tifind" data-tem-finding="${f.k}">${esc(f.text)}</div>`
      + `<div class="tilegwrap">${seepLegend(280)}</div>`
      + `<div class="tisub">Section along the route</div><div class="tisecwrap">${sectionSvg(300, 190)}</div>`;
  }
  function showCard(kind) {
    if (cards[kind] && cards[kind].isConnected) cards[kind].remove();
    const title = kind === "waste" ? "TEM — base of waste" : "TEM — impoundment to Clear Lake";
    const c = SBMM.results.card(null, title, kind === "waste" ? wasteRows() : seepRows());
    c.classList.add("ticard"); c.dataset.ti = kind;
    const box = document.createElement("div"); box.className = "tibody";
    box.innerHTML = cardBody(kind);
    c.appendChild(box);
    const acts = document.createElement("div"); acts.className = "pop-actions";
    acts.innerHTML = actsHtml(kind);
    c.appendChild(acts);
    c.addEventListener("click", onAction);
    SBMM.results.appendNote(c, kind === "waste" ? NOTE_W : NOTE_S);
    cards[kind] = c;
    return c;
  }
  function refreshCard(kind) {
    const c = cards[kind];
    if (!c || !c.isConnected) return;
    SBMM.results.setRows(c, kind === "waste" ? wasteRows() : seepRows());
    const b = c.querySelector(".tibody"); if (b) b.innerHTML = cardBody(kind);
  }

  /* ------------------------------------------------------------------ */
  /* the workspace tabs (js/temws.js mounts these)                        */
  /* ------------------------------------------------------------------ */
  function selH(k, opts, cur, title) {
    return `<select data-ti-k="${k}" title="${esc(title)}">` + opts.map(([v, t]) =>
      `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(t)}</option>`).join("") + `</select>`;
  }
  function chkH(label, onv, title) {
    return `<label class="temchk" title="${esc(title)}"><input type="checkbox" data-ti-row${onv ? " checked" : ""}> ${esc(label)}</label>`;
  }
  function panelHtml(kind) {
    if (kind === "waste") {
      return `<section><h4>Base of waste</h4><div class="twschks">${chkH("on the map and in 3D", on("tem_waste"), "The thickness map, the base surface in 3D and the proposed borings")}</div>`
        + `<div class="temgrid2"><label>Map from ${selH("wMethod", [["auto", "best by cross-validation"], ["borings", "borings only"], ["tem", "borings + TEM"]], P.wMethod, "Which map is drawn")}</label>`
        + `<label>Show ${selH("wShow", [["thick", "thickness"], ["se", "standard error"]], P.wShow, "The map's colour")}</label>`
        + `<label>Proposed borings ${selH("wTargets", [[0, "none"], [3, "3"], [5, "5"], [8, "8"]], P.wTargets, "New borings where the map knows least")}</label></div>`
        + `<div class="tifind" data-o="wfind"></div><div class="tirows mono" data-o="wrows"></div>`
        + `<div data-o="wleg"></div><div class="tisub">Proposed borings</div><div data-o="wtgt"></div>`
        + `<details class="tidet"><summary>Cross-validation, hole by hole</summary><div data-o="wholes"></div></details>`
        + `<div class="twsbtns">${actsHtml("waste", "button", false)}`
        + `<button class="minib" data-ti-a="wframe" title="Frame the survey">frame</button></div>`
        + `<div class="mut tinote">${esc(NOTE_W)}</div></section>`;
    }
    return `<section><h4>Conductive zones — impoundment to Clear Lake</h4><div class="twschks">${chkH("on the map and in 3D", on("tem_seep"), "The band map, the route and its section")}</div>`
      + `<div class="temgrid2"><label>Band ${selH("sBand", BANDS.map(b => [b.id, bandWords(b, true) + " (" + b.top + "–" + b.bot + " ft down)"]), P.sBand, "Elevations below the impoundment's water level")}</label>`
      + `<label>Conductive below ${selH("sThr", [[0, "lowest 10 %"], [4, "4 Ω·m"], [5, "5 Ω·m"], [6, "6 Ω·m"], [8, "8 Ω·m"], [10, "10 Ω·m"]], P.sThr, "The resistivity under which ground counts as conductive")}</label></div>`
      + `<div class="tifind" data-o="sfind"></div><div class="tirows mono" data-o="srows"></div>`
      + `<div data-o="sleg"></div><div class="tisub">Section along the route</div><div class="tisecwrap" data-o="ssec"></div>`
      + `<div class="twsbtns">${actsHtml("seep", "button", false)}`
      + `<button class="minib" data-ti-a="sframe" title="Frame the route">frame</button></div>`
      + `<div class="mut tinote">${esc(NOTE_S)}</div></section>`;
  }
  function rowsHtml(rs) {
    return rs.map(r => `<div class="tir"${r[2] ? ` title="${esc(r[2])}"` : ""}><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join("");
  }
  function mount(kind, el) {
    panes[kind] = el;
    el.innerHTML = panelHtml(kind);
    if (!el._tiWired) {
      el._tiWired = true;
      el.addEventListener("change", onPaneChange);
      el.addEventListener("click", onAction);
    }
    paintPane(kind);
  }
  function paintPane(kind) {
    const el = panes[kind];
    if (!el || !el.isConnected) return;
    const q = s => el.querySelector(s);
    const cb = q("[data-ti-row]"); if (cb) cb.checked = on(kind === "waste" ? "tem_waste" : "tem_seep");
    for (const s of el.querySelectorAll("[data-ti-k]")) s.value = String(P[s.dataset.tiK]);
    const busy = kind === "waste" ? !!wRun : !!sRun;
    if (kind === "waste") {
      const f = wasteFinding(), fe = q('[data-o="wfind"]');
      if (fe) { fe.textContent = W ? f.text : busy ? "computing…" : "—"; fe.dataset.temFinding = f.k; }
      q('[data-o="wrows"]').innerHTML = rowsHtml(wasteRows());
      q('[data-o="wleg"]').innerHTML = wasteLegend(300);
      q('[data-o="wtgt"]').innerHTML = targetsHtml();
      q('[data-o="wholes"]').innerHTML = holesHtml();
    } else {
      const f = seepFinding(), fe = q('[data-o="sfind"]');
      if (fe) { fe.textContent = Sp ? f.text : busy ? "computing…" : "—"; fe.dataset.temFinding = f.k; }
      q('[data-o="srows"]').innerHTML = rowsHtml(seepRows());
      q('[data-o="sleg"]').innerHTML = seepLegend(300);
      q('[data-o="ssec"]').innerHTML = sectionSvg(316, 200);
    }
  }
  async function setP(k, v) {
    if (!(k in DEF)) return;
    P[k] = typeof DEF[k] === "number" ? +v : v;
    save();
    if (k === "wShow") { wCanvas = null; paintWaste(); soon3d(); refreshCard("waste"); paintPane("waste"); emit("waste"); return; }
    if (k[0] === "w") { if (on("tem_waste")) await ensure("waste"); else { W = null; } paintPane("waste"); return; }
    if (on("tem_seep")) await ensure("seep"); else { Sp = null; }
    paintPane("seep");
  }
  function onPaneChange(e) {
    const t = e.target;
    const kind = t.closest("[data-ti-pane]") ? t.closest("[data-ti-pane]").dataset.tiPane : null;
    if (t.hasAttribute("data-ti-row")) { setRow(kind, t.checked); return; }
    if (t.dataset.tiK) setP(t.dataset.tiK, t.value);
  }
  function setRow(kind, want) {
    const id = kind === "waste" ? "tem_waste" : "tem_seep";
    if (on(id) === !!want) return;
    const r = rows[id];
    if (r && r.cb) r.cb.click(); else SBMM.layerState.set("invest", id, { on: !!want });
  }

  /* ------------------------------------------------------------------ */
  /* actions and exports                                                 */
  /* ------------------------------------------------------------------ */
  function wasteCsv() {
    if (!W) return "";
    let out = "# TEM base of waste; " + MWORD[W.method] + "; EPSG:6418 ft; ground from SBMM.elev (lidar Jan 2024); interpreted, planning-level\n"
      + "easting_ft,northing_ft,thickness_ft,std_error_ft,base_elev_ft,tem_break_ft\n";
    for (let iy = 0; iy < W.ny; iy++) for (let ix = 0; ix < W.nx; ix++) {
      const id = iy * W.nx + ix;
      if (!isFinite(W.depth[id])) continue;
      const x = W.x0 + ix * W.dx, y = W.y0 + iy * W.dx, [z] = SBMM.elev(x, y);
      out += [x.toFixed(1), y.toFixed(1), W.depth[id].toFixed(2), W.se[id].toFixed(2),
              isFinite(z) ? (z - W.depth[id]).toFixed(2) : "", isFinite(W.cov[id]) ? W.cov[id].toFixed(1) : ""].join(",") + "\n";
    }
    return out;
  }
  function targetsCsv() {
    if (!W) return "";
    let out = "# TEM base of waste — proposed borings, largest standard error first; EPSG:6418 ft\nid,easting_ft,northing_ft,lat,lon,predicted_base_ft,std_error_ft\n";
    W.targets.forEach((t, i) => {
      const [lat, lon] = SBMM.toLL(t.x, t.y);
      out += [`T${i + 1}`, t.x.toFixed(1), t.y.toFixed(1), lat.toFixed(7), lon.toFixed(7), t.depth.toFixed(1), t.se.toFixed(1)].join(",") + "\n";
    });
    return out;
  }
  function seepCsv() {
    if (!Sp) return "";
    let out = `# TEM conductive zones; band ${fmt(Sp.zTop, 2)}–${fmt(Sp.zBot, 2)} ft NAVD88; threshold ${fmtV(Sp.thr)} ohm-m; EPSG:6418 ft; interpreted, planning-level\n`
      + "easting_ft,northing_ft,band_rho_ohm_m,conductance_S,conductive,joins_both\n";
    for (let iy = 0; iy < Sp.ny; iy++) for (let ix = 0; ix < Sp.nx; ix++) {
      const id = iy * Sp.nx + ix;
      if (!isFinite(Sp.rho[id])) continue;
      out += [(Sp.x0 + ix * Sp.dx).toFixed(1), (Sp.y0 + iy * Sp.dx).toFixed(1), Sp.rho[id].toPrecision(4),
              Sp.cond[id].toPrecision(4), Sp.below[id], Sp.linked[id]].join(",") + "\n";
    }
    return out;
  }
  function routeCsv() {
    if (!Sp || !Sp.route) return "";
    let out = `# TEM least-resistive route, Herman impoundment to Clear Lake; band ${fmt(Sp.zTop, 2)}–${fmt(Sp.zBot, 2)} ft NAVD88; EPSG:6418 ft\n`
      + "station_ft,easting_ft,northing_ft,band_rho_ohm_m\n";
    let sta = 0;
    Sp.route.pts.forEach((p, i) => {
      if (i) sta += Math.hypot(p[0] - Sp.route.pts[i - 1][0], p[1] - Sp.route.pts[i - 1][1]);
      out += [sta.toFixed(1), p[0].toFixed(1), p[1].toFixed(1), Sp.route.rho[i].toPrecision(4)].join(",") + "\n";
    });
    return out;
  }
  function geojson(kind) {
    const LL = p => { const [la, lo] = SBMM.toLL(p[0], p[1]); return [+lo.toFixed(7), +la.toFixed(7)]; };
    const feats = [];
    if (kind === "waste" && W)
      W.targets.forEach((t, i) => feats.push({ type: "Feature", geometry: { type: "Point", coordinates: LL([t.x, t.y]) },
        properties: { id: `T${i + 1}`, easting_ft: +t.x.toFixed(1), northing_ft: +t.y.toFixed(1),
                      predicted_base_ft: +t.depth.toFixed(1), std_error_ft: +t.se.toFixed(1) } }));
    if (kind === "seep" && Sp && Sp.route)
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: Sp.route.pts.map(LL) },
        properties: { name: "Least-resistive route, Herman impoundment to Clear Lake", band_top_ft: Sp.zTop, band_bottom_ft: Sp.zBot,
                      length_ft: +Sp.route.length_ft.toFixed(1), most_resistive_ohm_m: +Sp.route.bottleneck.toPrecision(4),
                      threshold_ohm_m: +Sp.thr.toPrecision(4) } });
    return { type: "FeatureCollection", metadata: { source: "SBMM TEM interpretation v38", crs: "WGS84",
             note: kind === "waste" ? NOTE_W : NOTE_S }, features: feats };
  }
  function frame(kind) {
    const r = kind === "waste" ? W : Sp;
    if (!r) return;
    if (kind === "seep" && Sp && Sp.route && SBMM.viewer3d && SBMM.viewer3d.isOpen()) {
      const xs = Sp.route.pts.map(p => p[0]), ys = Sp.route.pts.map(p => p[1]), pad = 150;
      SBMM.viewer3d.frameBox(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad);
      return;
    }
    const x1 = r.x0 + (r.nx - 1) * r.dx, y1 = r.y0 + (r.ny - 1) * r.dx;
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen()) SBMM.viewer3d.frameBox(r.x0, r.y0, x1, y1);
    else SBMM.map.fitBounds([[r.y0, r.x0], [y1, x1]], SBMM.omni && SBMM.omni.fitPad ? SBMM.omni.fitPad() : {});
  }
  function onAction(e) {
    const b = e.target.closest("[data-ti-a]");
    if (!b) return;
    const a = b.dataset.tiA, dl = (name, txt, type) => download(name, new Blob([txt], { type }));
    if (a === "wcsv") { if (W) dl("SBMM_TEM_base_of_waste.csv", wasteCsv(), "text/csv"); return; }
    if (a === "tcsv") { if (W) dl("SBMM_TEM_proposed_borings.csv", targetsCsv(), "text/csv"); return; }
    if (a === "wgj") { if (W) dl("SBMM_TEM_proposed_borings.geojson", JSON.stringify(geojson("waste")), "application/geo+json"); return; }
    if (a === "scsv") { if (Sp) dl("SBMM_TEM_conductive_zones.csv", seepCsv(), "text/csv"); return; }
    if (a === "rcsv") { if (Sp && Sp.route) dl("SBMM_TEM_route.csv", routeCsv(), "text/csv"); else toast("no route in this band"); return; }
    if (a === "sgj") { if (Sp && Sp.route) dl("SBMM_TEM_route.geojson", JSON.stringify(geojson("seep")), "application/geo+json"); else toast("no route in this band"); return; }
    if (a === "ws") { const c = b.closest("[data-ti]"); if (SBMM.temws) SBMM.temws.open({ tab: c ? c.dataset.ti : "waste" }); return; }
    if (a === "wframe") { frame("waste"); return; }
    if (a === "sframe") { frame("seep"); return; }
    const tr = e.target.closest("[data-tgt]");
    if (tr && W) { const t = W.targets[+tr.dataset.tgt]; if (t) flyTo(t.x, t.y); }
  }
  function flyTo(x, y) {
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen()) SBMM.viewer3d.frameBox(x - 150, y - 150, x + 150, y + 150);
    else SBMM.map.setView([y, x], Math.max(SBMM.map.getZoom(), 1));
  }

  /* ------------------------------------------------------------------ */
  /* 3D: what js/viewer3d.js draws                                       */
  /* ------------------------------------------------------------------ */
  function scene3d() {
    const out = { waste: null, seep: null };
    if (W && on("tem_waste")) {
      const sc = wScale(), arr = P.wShow === "se" ? W.se : W.depth, N = W.nx * W.ny, color = new Float32Array(N * 3);
      for (let id = 0; id < N; id++) {
        const v = arr[id];
        if (!isFinite(v)) continue;
        const c = ramp(sc.stops, (v - sc.lo) / (sc.hi - sc.lo));
        color[id * 3] = c[0] / 255; color[id * 3 + 1] = c[1] / 255; color[id * 3 + 2] = c[2] / 255;
      }
      out.waste = { nx: W.nx, ny: W.ny, dx: W.dx, x0: W.x0, y0: W.y0, depth: W.depth, color,
                    targets: W.targets, opacity: SBMM.layerState.opacity("invest", "tem_waste") };
    }
    if (Sp && on("tem_seep")) {
      out.seep = { nx: Sp.nx, ny: Sp.ny, dx: Sp.dx, x0: Sp.x0, y0: Sp.y0, canvas: seepCanvas(), ok: Sp.rho,
                   z: (Sp.zTop + Sp.zBot) / 2, route: Sp.route ? Sp.route.pts : null,
                   opacity: SBMM.layerState.opacity("invest", "tem_seep") };
    }
    return out;
  }
  const wantsSeeThrough = () => !!((W && on("tem_waste")) || (Sp && on("tem_seep")));
  function pick3d(kind, i) {
    if (kind === "target" && W && W.targets[i]) return { title: `Proposed boring T${i + 1}`, html: wPopup(W.targets[i], i), xyz: [W.targets[i].x, W.targets[i].y] };
    if (kind === "route" && Sp && Sp.route) return { title: "Least-resistive route", html: `<div class="tipop">${routeTip()}</div>`, xyz: Sp.route.at };
    if (kind === "waste" && W) return { title: "TEM — base of waste", html: `<div class="tipop">${esc(wasteFinding().text)}</div>`, xyz: null };
    if (kind === "seep" && Sp) return { title: "TEM — conductive zones", html: `<div class="tipop">${esc(seepFinding().text)}</div>`, xyz: null };
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* the rows, the commands' entry point                                 */
  /* ------------------------------------------------------------------ */
  function build() {
    const D = data();
    if (!D || !D.n || rows.tem_waste) return;
    rows.tem_waste = SBMM.addLayerRow("invest", "Base of waste — borings + TEM", null,
      { id: "tem_waste", checked: false, swatch: "#EB7F2E", opacity: 0.85, sub: SUB, subTitle: SUB_TITLE,
        onChange: async st => {
          if (!st.on) { paintWaste(); soon3d(); emit("waste"); return; }
          if (W && wOverlay) { wOverlay.setOpacity(st.opacity); soon3d(); return; }
          await ensure("waste");
        } });
    rows.tem_waste.row.title = "The 2025 borings' logged native contact mapped across the survey, with the TEM where it helps";
    rows.tem_seep = SBMM.addLayerRow("invest", "Conductive zones — impoundment to lake", null,
      { id: "tem_seep", checked: false, swatch: "#E4572E", opacity: 0.85, sub: SUB, subTitle: SUB_TITLE,
        onChange: async st => {
          if (!st.on) { paintSeep(); soon3d(); emit("seep"); return; }
          if (Sp && sOverlay) { sOverlay.setOpacity(st.opacity); soon3d(); return; }
          await ensure("seep");
        } });
    rows.tem_seep.row.title = "Low-resistivity ground below the impoundment's water level, and the least-resistive route to Clear Lake";
    if (SBMM.events) SBMM.events.on("tem", ({ key }) => {
      /* a model re-run invalidates both; a colour or depth change touches neither */
      const R = G().result();
      if (!R) return;
      if (W && wKey.split("|")[0] !== R.key && on("tem_waste")) ensure("waste").then(() => paintPane("waste"));
      if (Sp && sKey.split("|")[0] !== R.key && on("tem_seep")) ensure("seep").then(() => paintPane("seep"));
      if (key === "method" || key === "cell" || key === "blank") wlCache = null;
    });
    if (SBMM.events) SBMM.events.on("teminterp", ({ kind }) => paintPane(kind));
  }
  /* TEMWASTE / TEMSEEP: the workspace at that tab, or on a phone the card */
  async function open(kind) {
    if (!data()) { toast("the TEM survey is not in this build"); return false; }
    const id = kind === "waste" ? "tem_waste" : "tem_seep";
    if (!document.body.classList.contains("field") && SBMM.temws) return SBMM.temws.open({ tab: kind });
    if (!on(id)) setRow(kind, true);
    const res = await ensure(kind);
    if (!res) return false;
    showCard(kind);
    return true;
  }
  /* the workspace tab became visible: its layer on, its numbers in */
  async function activate(kind) {
    if (!data()) return null;
    const id = kind === "waste" ? "tem_waste" : "tem_seep";
    /* a tab shows its own analysis: the other one steps off */
    setRow(kind === "waste" ? "seep" : "waste", false);
    if (!on(id)) setRow(kind, true);
    paintPane(kind);
    const res = await ensure(kind);
    paintPane(kind);
    return res;
  }

  return {
    build, open, activate, mount, paintPane, runWaste, runSeep, scene3d, wantsSeeThrough, pick3d,
    hoverText, waterLevel, sectionSvg, wasteCsv, targetsCsv, seepCsv, routeCsv, geojson,
    waste: () => W, seep: () => Sp, card: k => cards[k] || null, showCard, rows: () => rows,
    settings: () => Object.assign({}, P), set: setP, BANDS
  };
})();
