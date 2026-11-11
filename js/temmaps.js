/* SBMM Site Explorer — v54: maps DERIVED from the 2026 TEM model
   (SBMM.temmaps), reached from the TEM workspace's "Maps" tab, the layer
   row "Derived map" and `TEMMAP`.

   A depth slice is one cut through the model. Two questions it cannot
   answer are answered here, each as ONE value per node:

     · INTERVAL — what the ground between two depths (or two elevations)
       amounts to. A stack of layers has no single resistivity: current that
       runs along the layers meets them in parallel, current that crosses
       them meets them in series. So the map can show the geometric mean,
       the resistivity ALONG the layers (harmonic), ACROSS them (arithmetic),
       the conductance (siemens — what an EM system actually senses of a
       conductor), and the anisotropy the two resistivities imply. A node is
       mapped when the model holds at least half of the interval there.
     · TOP OF THE CONDUCTOR — the depth at which the model first crosses a
       resistivity going down: its depth, its elevation, or its thickness to
       the next crossing back. `above` instead of `below` finds the top of
       the resistor. With the model's "blend between layers" on, the depth is
       where the blended model reads exactly the threshold.

   The kernel is `temmap` (js/compute.js, test/kernels.mjs --only temmap).
   It reads the `tem` job's grid as it stands, so a method, cell or blanking
   change in the model re-runs it. Read-only project analysis, like
   js/teminterp.js: nothing is a store feature, nothing serialises, the
   settings are a view preference. ONE layer row (`invest/tem_map`) shows
   whichever map is chosen. */
"use strict";

SBMM.temmaps = (function () {

  const G = () => SBMM.geophys;
  const UI = () => SBMM.teminterp && SBMM.teminterp.ui;
  const data = () => window.SBMM_DATA && SBMM_DATA.tem2026;
  const SUB = "Geophysics — TEM 2026";
  const SUB_TITLE = "TEM2Go transient electromagnetic soundings, LCI resistivity models, May 2026";
  const ROW = "tem_map";
  const on = () => !!(SBMM.layerState && SBMM.layerState.isOn("invest", ROW));
  const fV = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const ac = ft2 => fmt(ft2 / 43560, 1);
  const NOTE = "TEM2Go LCI models, May 2026, as interpolated · thickness-weighted over the model layers · interpreted · planning-level";

  /* what an interval map can show, and what a top map can */
  const SHOW_I = {
    rhoG: { name: "Geometric mean", long: "geometric-mean resistivity", unit: "Ω·m",
            title: "The thickness-weighted mean of log resistivity — the middle of the three means" },
    rhoL: { name: "Along the layers", long: "resistivity along the layers", unit: "Ω·m",
            title: "Thickness ÷ conductance: what current running along the layers meets (harmonic mean)" },
    rhoT: { name: "Across the layers", long: "resistivity across the layers", unit: "Ω·m",
            title: "What current crossing the layers meets (arithmetic mean)" },
    cond: { name: "Conductance", long: "conductance", unit: "S",
            title: "Σ thickness ÷ resistivity over the interval, in siemens" },
    aniso: { name: "Anisotropy", long: "anisotropy", unit: "",
             title: "√(across ÷ along): 1 is one material, more is layered" }
  };
  const SHOW_T = {
    depth: { name: "Depth", long: "depth", unit: "ft", title: "Depth below ground of the first crossing" },
    elev: { name: "Elevation", long: "elevation", unit: "ft", title: "The model's ground less that depth" },
    thick: { name: "Thickness", long: "thickness", unit: "ft", title: "From the first crossing to the next one back, or to the end of the record" }
  };

  const DEF = { kind: "interval", iDatum: "depth", iTop: 0, iBot: 30, iZTop: 1330, iZBot: 1300, iShow: "rhoG",
                tThr: 10, tDir: "below", tFrom: 0, tShow: "depth" };
  let P = Object.assign({}, DEF);
  try {
    const st = SBMM.view && SBMM.view.pref("temmaps");
    if (st && typeof st === "object") for (const k in DEF) if (st[k] != null && typeof st[k] === typeof DEF[k]) P[k] = st[k];
    if (P.kind !== "top") P.kind = "interval";
    if (P.iDatum !== "elev") P.iDatum = "depth";
    if (!SHOW_I[P.iShow]) P.iShow = "rhoG";
    if (!SHOW_T[P.tShow]) P.tShow = "depth";
    if (P.tDir !== "above") P.tDir = "below";
  } catch (e) { /* a preference is a convenience */ }
  function save() { try { SBMM.view && SBMM.view.pref("temmaps", P); } catch (e) { /* ignore */ } }

  let M = null, mKey = "", mRun = null, pic = null, row = null, group = null, overlay = null, card = null, pane = null;

  /* ------------------------------------------------------------------ */
  /* the job                                                             */
  /* ------------------------------------------------------------------ */
  const blendNow = () => !!(G() && G().settings().blend);
  const iA = () => P.iDatum === "elev" ? P.iZTop : P.iTop;
  const iB = () => P.iDatum === "elev" ? P.iZBot : P.iBot;
  const keyOf = R => P.kind === "interval"
    ? [R.key, "i", P.iDatum, iA(), iB()].join("|")
    : [R.key, "t", P.tThr, P.tDir, P.tFrom, blendNow()].join("|");
  /* test/kernels.mjs §18.5 mirrors this */
  function jobFor(R) {
    const D = data();
    const g = { nx: R.nx, ny: R.ny, dx: R.dx, x0: R.x0, y0: R.y0, nl: D.nl, mask: R.mask, log: R.log, surf: R.surf,
                top_ft: D.top_ft, bot_ft: D.bot_ft };
    if (P.kind === "interval") return Object.assign(g, { what: "interval", datum: P.iDatum, a: iA(), b: iB(), minCover: 0.5 });
    return Object.assign(g, { what: "top", thr: P.tThr, dir: P.tDir, from: P.tFrom, blend: blendNow() });
  }
  async function run(force) {
    if (!data()) { toast("the TEM survey is not in this build"); return null; }
    const R = await G().run();
    if (!R) return null;
    const key = keyOf(R);
    if (M && mKey === key && !force) return M;
    if (mRun) return mRun;
    mRun = (async () => {
      try {
        const t0 = performance.now();
        const res = await SBMM.compute.run("temmap", jobFor(R), { label: "TEM derived map" }).promise;
        res.ms_wall = Math.round(performance.now() - t0);
        res.method = R.method; res.nodes = R.nodes;
        M = res; mKey = key; pic = null;
        return M;
      } catch (e) {
        if (e && e.cancelled) toast("TEM map cancelled");
        else toast("TEM map failed: " + (e.message || e));
        return null;
      }
    })().finally(() => { mRun = null; });
    const out = await mRun;
    /* a setting that moved while the job ran gets its own run */
    const R2 = G().result();
    if (out && R2 && mKey !== keyOf(R2)) return run();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* words                                                               */
  /* ------------------------------------------------------------------ */
  function intervalWords(short) {
    if (P.iDatum === "elev") return `${fmt0(P.iZBot)}–${fmt0(P.iZTop)} ft` + (short ? "" : " elevation");
    return `${fmt0(P.iTop)}–${fmt0(P.iBot)} ft` + (short ? "" : " below ground");
  }
  const topWords = () => `${P.tDir === "above" ? "above" : "below"} ${fV(P.tThr)} Ω·m`
    + (P.tFrom > 0 ? `, from ${fmt0(P.tFrom)} ft down` : "");
  const showNow = () => P.kind === "interval" ? SHOW_I[P.iShow] : SHOW_T[P.tShow];
  const arrNow = () => !M ? null : M.what === "interval" ? M[P.iShow] : M[P.tShow];
  /* the map on screen is the map asked for (a tab can show the last one
     while the next is computed) */
  const current = () => !!(M && M.what === P.kind);
  function title() {
    return P.kind === "interval" ? `TEM — ${intervalWords(true)}, ${showNow().long}` : `TEM — top of the ${P.tDir === "above" ? "resistor" : "conductor"}`;
  }

  /* ------------------------------------------------------------------ */
  /* colour                                                              */
  /* ------------------------------------------------------------------ */
  /* shallow is the notable end of a depth map, so shallow is bright */
  const RAMP_D = ["#FFF3B0", "#F9C74F", "#F08A4B", "#C8553D", "#8A3F66", "#4A3470", "#1E2550"];
  const RAMP_K = ["#E8F6F3", "#B5E2DB", "#7CC8C0", "#45A9A6", "#1F8587", "#0F5F68", "#083F4A"];
  const RAMP_A = ["#F4F1EA", "#E3D3B8", "#D1AE7F", "#BF8750", "#A45F33", "#7F3F22", "#562715"];
  const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const nice = v => { if (!(v > 0)) return +(+v).toPrecision(2);
    const e = Math.pow(10, Math.floor(Math.log10(v))); return +(Math.round(v / e * 10) / 10 * e).toPrecision(3); };
  const up5 = (v, s) => Math.max(s, Math.ceil(v / s) * s);
  function statOf(a) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    return { lo, hi };
  }
  /* { kind: "log" | "lin", lo, hi, stops, unit, name, shared } — `shared`
     says the colours are the depth slice's own, value for value */
  function scaleNow() {
    if (!current()) return null;
    const sh = showNow();
    if (M.what === "interval") {
      const s = M.stats[P.iShow];
      if (!s || !s.n) return null;
      if (P.iShow === "aniso") return { kind: "lin", lo: 1, hi: Math.max(1.1, up5(s.p98, 0.05)), stops: RAMP_A, unit: "", name: sh.name };
      const st = G().cmapStops();
      if (P.iShow === "cond") {
        let lo = nice(s.p02), hi = nice(s.p98);
        if (!(hi > lo)) { lo = s.min * 0.9; hi = s.max * 1.1; }
        /* conductive is the same end of the colours as on the slice */
        return { kind: "log", lo, hi, stops: st.slice().reverse(), unit: "S", name: sh.name };
      }
      const gr = G().range(), same = G().settings().prop === "res" && gr && gr.lo > 0 && gr.hi > gr.lo;
      let lo = same ? gr.lo : nice(s.p02), hi = same ? gr.hi : nice(s.p98);
      if (!(hi > lo)) { lo = s.min * 0.9; hi = s.max * 1.1; }
      return { kind: "log", lo, hi, stops: st, unit: "Ω·m", name: sh.name, shared: !!same };
    }
    const a = arrNow(), mm = statOf(a);
    if (!isFinite(mm.lo)) return null;
    if (P.tShow === "elev") {
      const lo = Math.floor(mm.lo / 10) * 10, hi = Math.max(lo + 10, Math.ceil(mm.hi / 10) * 10);
      return { kind: "lin", lo, hi, stops: RAMP_D.slice().reverse(), unit: "ft", name: sh.name };
    }
    const s = M.stats[P.tShow], hi = up5(Math.max(s.p98, 5), 5);
    return { kind: "lin", lo: 0, hi, stops: P.tShow === "thick" ? RAMP_K : RAMP_D, unit: "ft", name: sh.name };
  }
  const tOf = (sc, v) => sc.kind === "log"
    ? (v > 0 ? (Math.log10(v) - Math.log10(sc.lo)) / (Math.log10(sc.hi) - Math.log10(sc.lo)) : NaN)
    : (v - sc.lo) / (sc.hi - sc.lo);
  /* plan bilinear, as the slice's (js/geophys.js bilin): no value where the
     nearest node has none, the others re-weighted */
  function bilin(f, nx, ny, gx, gy) {
    const ix = Math.max(0, Math.min(nx - 2, Math.floor(gx))), iy = Math.max(0, Math.min(ny - 2, Math.floor(gy)));
    const fx = gx - ix, fy = gy - iy;
    if (!isFinite(f[Math.round(gy) * nx + Math.round(gx)])) return NaN;
    const v = [f[iy * nx + ix], f[iy * nx + ix + 1], f[(iy + 1) * nx + ix], f[(iy + 1) * nx + ix + 1]];
    const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    let s = 0, sw = 0;
    for (let k = 0; k < 4; k++) if (isFinite(v[k])) { s += v[k] * w[k]; sw += w[k]; }
    return sw > 0 ? s / sw : NaN;
  }
  /* the picture: the slice's own painter in miniature — bilinear between
     nodes, a contour edge wherever the level changes. Cached on everything
     that changes a pixel. */
  const N_LEV = 10;
  function picKey() {
    const sc = scaleNow();
    return sc ? [mKey, P.kind === "interval" ? P.iShow : P.tShow, sc.lo, sc.hi, sc.stops.join("")].join("|") : "";
  }
  function picture() {
    if (!current()) return null;
    const key = picKey();
    if (!key) return null;
    if (pic && pic.key === key) return pic;
    const sc = scaleNow(), a = arrNow(), nx = M.nx, ny = M.ny;
    const up = Math.max(2, Math.min(8, Math.floor(900 / Math.max(nx, ny))));
    const W = (nx - 1) * up + 1, H = (ny - 1) * up + 1;
    const st = sc.stops.map(rgb), lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const p = i / 255 * (st.length - 1), k = Math.min(Math.floor(p), st.length - 2), f = p - k;
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(st[k][c] * (1 - f) + st[k + 1][c] * f);
    }
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"), im = ctx.createImageData(W, H), px = im.data;
    const tt = new Float32Array(W * H), lev = new Int32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, t = tOf(sc, bilin(a, nx, ny, x / up, (H - 1 - y) / up));
      tt[i] = t; lev[i] = isFinite(t) ? Math.floor(Math.max(0, Math.min(1, t)) * N_LEV + 1e-6) : -99999;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      if (lev[i] === -99999) { px[o + 3] = 0; continue; }
      const c = Math.round(Math.max(0, Math.min(1, tt[i])) * 255) * 3;
      let r = lut[c], g = lut[c + 1], b = lut[c + 2];
      const e = (x + 1 < W && lev[i + 1] !== -99999 && lev[i + 1] !== lev[i])
             || (y + 1 < H && lev[i + W] !== -99999 && lev[i + W] !== lev[i]);
      if (e) { r = r * 0.3 + 20 * 0.7; g = g * 0.3 + 24 * 0.7; b = b * 0.3 + 26 * 0.7; }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 238;
    }
    ctx.putImageData(im, 0, 0);
    const h = M.dx / up / 2;
    pic = { key, canvas: cv, up, W, H,
            bounds: [[M.y0 - h, M.x0 - h], [M.y0 + (ny - 1) * M.dx + h, M.x0 + (nx - 1) * M.dx + h]] };
    return pic;
  }
  function legendHtml(w) {
    const sc = scaleNow();
    if (!sc || !UI()) return "";
    const sh = showNow(), head = `<div class="tilegh">${esc(sh.name)}${sc.unit ? ", " + sc.unit : ""}`
      + (sc.shared ? ` <span class="mut" title="The depth slice's own colours, value for value">· the slice's colours</span>` : "") + `</div>`;
    if (sc.kind === "log") {
      const mid = +Math.sqrt(sc.lo * sc.hi).toPrecision(2), tk = [sc.lo, mid, sc.hi];
      return head + UI().legendSvg(sc.stops, Math.log10(sc.lo), Math.log10(sc.hi), w, tk.map(Math.log10), tk);
    }
    const mid = +((sc.lo + sc.hi) / 2).toFixed(2);
    return head + UI().legendSvg(sc.stops, sc.lo, sc.hi, w, [sc.lo, mid, sc.hi], [sc.lo, mid, sc.hi]);
  }

  /* ------------------------------------------------------------------ */
  /* the map, the 3D surface                                             */
  /* ------------------------------------------------------------------ */
  function paint() {
    if (!group) group = L.layerGroup();
    const p = on() ? picture() : null;
    if (!p) {
      group.clearLayers(); overlay = null;
      if (SBMM.map.hasLayer(group)) SBMM.map.removeLayer(group);
      return;
    }
    const url = p.canvas.toDataURL("image/png");
    if (overlay) { overlay.setUrl(url); overlay.setBounds(L.latLngBounds(p.bounds)); overlay.setOpacity(SBMM.layerState.opacity("invest", ROW)); }
    else {
      /* over the depth slice when both are on: the map is the later question */
      overlay = L.imageOverlay(url, p.bounds, { pane: "analysis", interactive: false, zIndex: 2,
        opacity: SBMM.layerState.opacity("invest", ROW) });
      group.addLayer(overlay);
    }
    if (!SBMM.map.hasLayer(group)) group.addTo(SBMM.map);
  }
  function soon3d() {
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen && SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshOverlays)
      SBMM.viewer3d.refreshOverlays();
  }
  function emit() { if (SBMM.events) SBMM.events.emit("temmaps", { kind: P.kind }); }
  /* the surface js/viewer3d.js draws: an elevation per node and the map's own
     picture on it. An interval between depths follows the ground at its
     middle; between elevations it is level; a top map IS the surface. The
     ground is the lidar's (SBMM.elev), the model's own where the lidar has
     none. */
  function scene3d() {
    if (!on() || !current()) return null;
    const p = picture(), a = arrNow();
    if (!p || !a) return null;
    const R = G().result(), nx = M.nx, ny = M.ny, N = nx * ny, z = new Float32Array(N).fill(NaN);
    const mid = P.kind === "interval" ? (iA() + iB()) / 2 : 0;
    for (let id = 0; id < N; id++) {
      if (!(a[id] === a[id])) continue;
      if (P.kind === "interval" && P.iDatum === "elev") { z[id] = mid; continue; }
      const x = M.x0 + (id % nx) * M.dx, y = M.y0 + Math.floor(id / nx) * M.dx;
      let [zg] = SBMM.elev ? SBMM.elev(x, y) : [NaN];
      if (!isFinite(zg) && R && R.surf) zg = R.surf[id];
      if (!isFinite(zg)) continue;
      z[id] = zg - (P.kind === "interval" ? mid : M.depth[id]);
    }
    return { nx, ny, dx: M.dx, x0: M.x0, y0: M.y0, z, canvas: p.canvas, up: p.up, W: p.W, H: p.H,
             opacity: SBMM.layerState.opacity("invest", ROW) };
  }
  const wantsSeeThrough = () => on() && current();

  /* ------------------------------------------------------------------ */
  /* what the map says at a point (the status bar, the probe's chip)     */
  /* ------------------------------------------------------------------ */
  function nodeOf(x, y) {
    if (!M) return -1;
    const ix = Math.round((x - M.x0) / M.dx), iy = Math.round((y - M.y0) / M.dx);
    if (ix < 0 || iy < 0 || ix >= M.nx || iy >= M.ny) return -1;
    return iy * M.nx + ix;
  }
  function readAt(what, x, y) {
    if (!current()) return null;
    const id = nodeOf(x, y);
    if (id < 0) return null;
    if (M.what === "interval") {
      if (!(M.rhoG[id] === M.rhoG[id])) return null;
      return { key: "i" + id, head: `${intervalWords(true)}: ${fV(M.rhoG[id])} Ω·m`,
               lines: [`along ${fV(M.rhoL[id])} · across ${fV(M.rhoT[id])} Ω·m · anisotropy ${M.aniso[id].toFixed(2)}`,
                       `conductance ${fV(M.cond[id])} S · ${fmt(M.thick[id], 0)} ft of model`],
               value: M[P.iShow][id] };
    }
    if (!(M.depth[id] === M.depth[id])) return { key: "n" + id, head: `not ${topWords()}`, lines: ["nowhere in the record here"], value: NaN };
    return { key: "t" + id, head: `${topWords()} at ${fmt(M.depth[id], 1)} ft`,
             lines: [(isFinite(M.elev[id]) ? `elev ${fmt0(M.elev[id])} ft · ` : "") + `${fmt(M.thick[id], 0)} ft thick`
                       + (M.open[id] ? " · to the end of the record" : ""),
                     M.atStart[id] ? (P.tFrom > 0 ? "already so at the start depth" : "already so at the surface") : "interpreted"],
             value: M[P.tShow][id] };
  }
  function hoverText(x, y) {
    if (!on()) return "";
    const r = readAt("map", x, y);
    return r ? " · " + r.head : "";
  }
  function pick3d(ix) {
    if (!current() || !ix || !ix.point || !SBMM.viewer3d || !SBMM.viewer3d.toWorld) return null;
    const w = SBMM.viewer3d.toWorld(ix.point), r = readAt("map", w[0], w[1]);
    if (!r) return null;
    return { title: title(), xyz: [w[0], w[1]],
             html: `<div class="tipop"><b class="mono">${esc(r.head)}</b>` + r.lines.map(l => `<div class="mono">${esc(l)}</div>`).join("")
               + `<div class="tisay">${esc(finding().text)}</div></div>` };
  }

  /* ------------------------------------------------------------------ */
  /* the words: one summary, for the card and the workspace tab          */
  /* ------------------------------------------------------------------ */
  const pctOf = (n, d) => d > 0 ? Math.round(100 * n / d) : 0;
  function rowsNow() {
    if (!current()) return [];
    if (M.what === "interval") {
      const S = M.stats;
      const q = {
        rhoG: ["Geometric mean, median", `${fV(S.rhoG.p50)} Ω·m · ${fV(S.rhoG.p10)}–${fV(S.rhoG.p90)}`, "The median over the mapped nodes, and its 10th–90th percentiles"],
        rhoL: ["Along the layers, median", `${fV(S.rhoL.p50)} Ω·m · ${fV(S.rhoL.p10)}–${fV(S.rhoL.p90)}`, "Thickness ÷ conductance (the harmonic mean): its median and 10th–90th percentiles"],
        rhoT: ["Across the layers, median", `${fV(S.rhoT.p50)} Ω·m · ${fV(S.rhoT.p10)}–${fV(S.rhoT.p90)}`, "The arithmetic mean: its median and 10th–90th percentiles"],
        cond: ["Conductance, median", `${fV(S.cond.p50)} S · ${fV(S.cond.p10)}–${fV(S.cond.p90)}`, "Σ thickness ÷ resistivity over the interval"],
        aniso: ["Anisotropy, median · 98 %", `${S.aniso.p50.toFixed(2)} · ${S.aniso.p98.toFixed(2)}`, "√(across ÷ along): 1 is one material"]
      };
      /* the quantity on the map leads (a card's first row is its headline) */
      const r = [q[P.iShow], ["Interval", intervalWords()]];
      for (const k of ["rhoG", "rhoL", "rhoT", "cond", "aniso"]) if (k !== P.iShow) r.push(q[k]);
      r.push(["Mapped", `${fmt0(M.n)} nodes · ${ac(M.area_ft2)} ac` + (M.partial ? ` · ${fmt0(M.partial)} left out` : ""),
              M.partial ? "Left out: nodes where the model holds less than half of the interval" : "Every node holds the whole interval"]);
      return r;
    }
    const S = M.stats, all = M.found + M.never, r = [];
    const dRow = ["Depth, median", `${fmt(S.depth.p50, 1)} ft · ${fmt(S.depth.p10, 0)}–${fmt(S.depth.p90, 0)}`, "The median over the nodes where it was found, and its 10th–90th percentiles"];
    const kRow = ["Thickness, median", `${fmt(S.thick.p50, 1)} ft · ${fmt(S.thick.p10, 0)}–${fmt(S.thick.p90, 0)}`, "To the next crossing back, or to the end of the record"];
    /* the quantity on the map leads (a card's first row is its headline) */
    r.push(P.tShow === "thick" ? kRow : dRow);
    r.push(["Looking for", topWords()]);
    r.push(["Found", `${fmt0(M.found)} of ${fmt0(all)} nodes · ${ac(M.area_ft2)} ac (${pctOf(M.found, all)} %)`]);
    r.push(P.tShow === "thick" ? dRow : kRow);
    r.push([P.tFrom > 0 ? "Already so at the start" : "At the surface", `${fmt0(M.atStartN)} nodes (${pctOf(M.atStartN, M.found)} %)`]);
    r.push(["To the end of the record", `${fmt0(M.openN)} nodes (${pctOf(M.openN, M.found)} %)`, "The model never crosses back above them"]);
    return r;
  }
  /* { k, text } — k is the harness's handle on which sentence this is */
  function finding() {
    if (!current()) return { k: "none", text: "" };
    if (M.what === "interval") {
      const S = M.stats, an = S.aniso.p50;
      const lay = an < 1.05 ? "close to one material" : an < 1.2 ? "mildly layered" : "strongly layered";
      return { k: an < 1.05 ? "uniform" : an < 1.2 ? "mild" : "layered",
               text: `${intervalWords()}: ${fV(S.rhoG.p50)} Ω·m at the median (${fV(S.rhoG.p10)}–${fV(S.rhoG.p90)} across the middle 80 %), `
                 + `${fV(S.cond.p50)} S of conductance. Anisotropy ${an.toFixed(2)} — ${lay}.` };
    }
    const all = M.found + M.never, what = P.tDir === "above" ? "resistor" : "conductor";
    if (!M.found) return { k: "never", text: `Nothing ${topWords()} anywhere in the model.` };
    return { k: M.found === all ? "everywhere" : "partial",
             text: `Ground ${topWords()} under ${pctOf(M.found, all)} % of the survey (${ac(M.area_ft2)} ac): `
               + `the top of the ${what} at ${fmt(M.stats.depth.p50, 0)} ft at the median, ${fmt(M.stats.thick.p50, 0)} ft thick; `
               + `${pctOf(M.atStartN, M.found)} % of it ${P.tFrom > 0 ? "already so at the start depth" : "at the surface"}.` };
  }

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  function actsHtml(tag, withWs) {
    const T = tag || "span", ws = withWs !== false && !document.body.classList.contains("field");
    const b = (a, t, label) => `<${T} class="minib" data-tm-a="${a}" title="${esc(t)}">${label}</${T}>`;
    return b("csv", "Every mapped node, every quantity", "grid CSV")
      + b("png", "The map as a picture, with its legend", "PNG")
      + b("asc", "The map as an ESRI ASCII grid with its projection file, zipped", "GIS grid")
      + b("report", "A print-ready sheet of the TEM as it stands", "report")
      + (ws ? b("ws", "The TEM workspace at this map (TEMMAP)", "workspace") : "");
  }
  function cardBody() {
    const f = finding();
    return `<div class="tifind" data-tem-finding="${f.k}">${esc(f.text)}</div><div class="tilegwrap">${legendHtml(280)}</div>`;
  }
  function showCard() {
    if (card && card.isConnected) card.remove();
    const c = SBMM.results.card(null, title(), rowsNow());
    c.classList.add("ticard"); c.dataset.tm = P.kind;
    /* the title follows the map chosen, so it is an element, not a text node */
    const h = c.querySelector("h4");
    if (h && h.firstChild && h.firstChild.nodeType === 3) {
      const sp = document.createElement("span"); sp.className = "tmtitle"; sp.textContent = title();
      h.replaceChild(sp, h.firstChild);
    }
    const box = document.createElement("div"); box.className = "tibody";
    box.innerHTML = cardBody();
    c.appendChild(box);
    const acts = document.createElement("div"); acts.className = "pop-actions";
    acts.innerHTML = actsHtml();
    c.appendChild(acts);
    c.addEventListener("click", onAction);
    SBMM.results.appendNote(c, NOTE);
    card = c;
    return c;
  }
  function refreshCard() {
    if (!card || !card.isConnected) return;
    const n = card.querySelector(".tmtitle"); if (n) n.textContent = title();
    card.dataset.tm = P.kind;
    SBMM.results.setRows(card, rowsNow());
    const b = card.querySelector(".tibody"); if (b) b.innerHTML = cardBody();
  }

  /* ------------------------------------------------------------------ */
  /* the workspace tab (js/temws.js mounts it)                           */
  /* ------------------------------------------------------------------ */
  const selH = (k, opts, cur, t) => `<select data-tm-k="${k}" title="${esc(t)}">` + opts.map(([v, s]) =>
    `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(s)}</option>`).join("") + `</select>`;
  const numH = (k, v, min, max, step, t) =>
    `<input type="number" class="tmnum mono" data-tm-k="${k}" value="${v}" min="${min}" max="${max}" step="${step}" title="${esc(t)}">`;
  const segH = (k, opts, cur, label) => `<div class="twsseg tmseg" role="group" aria-label="${esc(label)}">` + opts.map(([v, s, t]) =>
    `<button type="button" class="segb${String(v) === String(cur) ? " on" : ""}" data-tm-set="${k}" data-v="${esc(v)}" aria-pressed="${String(v) === String(cur)}" title="${esc(t || "")}">${esc(s)}</button>`).join("") + `</div>`;
  function panelHtml() {
    const DM = G() ? Math.floor(G().dmax()) : 390, [eLo, eHi] = G() ? G().elevRange() : [900, 1500];
    const C = calibHint();
    return `<section><h4>Derived maps</h4>`
      + segH("kind", [["interval", "Interval", "What the ground between two depths or elevations amounts to"],
                      ["top", "Top of conductor", "The depth at which the model first crosses a resistivity"]], P.kind, "Which map")
      + `<div class="twschks"><label class="temchk" title="The map on the 2D map and as a surface in 3D"><input type="checkbox" data-tm-row${on() ? " checked" : ""}> on the map and in 3D</label></div>`
      /* the interval's controls */
      + `<div data-tm-for="interval"${P.kind === "interval" ? "" : " hidden"}>`
      + segH("iDatum", [["depth", "depth below ground"], ["elev", "elevation"]], P.iDatum, "The interval's datum")
      + `<div class="temgrid2" data-tm-datum="depth"${P.iDatum === "depth" ? "" : " hidden"}>`
      + `<label>From, ft ${numH("iTop", P.iTop, 0, DM - 1, 5, "The interval's top, feet below ground")}</label>`
      + `<label>To, ft ${numH("iBot", P.iBot, 1, DM, 5, "The interval's bottom, feet below ground")}</label></div>`
      + `<div class="temgrid2" data-tm-datum="elev"${P.iDatum === "elev" ? "" : " hidden"}>`
      + `<label>Top, ft ${numH("iZTop", P.iZTop, eLo + 1, eHi, 5, "The interval's top elevation, NAVD88")}</label>`
      + `<label>Bottom, ft ${numH("iZBot", P.iZBot, eLo, eHi - 1, 5, "The interval's bottom elevation, NAVD88")}</label></div>`
      + `<div class="temgrid2"><label>Show ${selH("iShow", Object.keys(SHOW_I).map(k => [k, SHOW_I[k].name]), P.iShow, "Which reduction of the interval is drawn")}</label>`
      + `<label>&nbsp;<button class="minib" data-tm-a="slice" title="The interval the Model tab's slice sits in: its model layer">the slice's layer</button></label></div></div>`
      /* the top's controls */
      + `<div data-tm-for="top"${P.kind === "top" ? "" : " hidden"}>`
      + segH("tDir", [["below", "conductor", "The first depth BELOW the threshold"], ["above", "resistor", "The first depth ABOVE the threshold"]], P.tDir, "Which side of the threshold")
      + `<div class="temgrid2"><label>Threshold, Ω·m ${numH("tThr", P.tThr, 0.1, 10000, 1, "The resistivity the model has to cross")}</label>`
      + `<label>From, ft down ${numH("tFrom", P.tFrom, 0, DM - 1, 5, "Start looking this far below the ground")}</label>`
      + `<label>Show ${selH("tShow", Object.keys(SHOW_T).map(k => [k, SHOW_T[k].name]), P.tShow, "What the map is coloured by")}</label>`
      + `<label>&nbsp;<button class="minib" data-tm-a="calib"${C ? "" : " disabled"} title="${esc(C ? C.title : "No calibration against the borings in this build")}">${C ? esc(C.label) : "borings' threshold"}</button></label></div></div>`
      + `<div class="tifind" data-o="find"></div><div class="tirows mono" data-o="rows"></div><div data-o="leg"></div>`
      + `<div class="twsbtns">${actsHtml("button", false)}<button class="minib" data-tm-a="frame" title="Frame the survey">frame</button></div>`
      + `<div class="mut tinote">${esc(NOTE)}</div></section>`;
  }
  /* the one resistivity that best separates logged waste from native
     (js/geophys.js calibrate): offered as a threshold, never applied */
  function calibHint() {
    try {
      const C = G() && G().calibrate ? G().calibrate() : null, T = C && C.threshold;
      if (!T || !isFinite(T.rho)) return null;
      return { rho: +T.rho.toPrecision(3), label: `borings' ${fV(T.rho)} Ω·m`,
               title: `The resistivity that best separates logged waste from native in ${C.holes.length} borings (${Math.round(T.acc * 100)} % balanced accuracy)` };
    } catch (e) { return null; }
  }
  const rowsHtml = rs => rs.map(r => `<div class="tir"${r[2] ? ` title="${esc(r[2])}"` : ""}><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join("");
  function mount(el) {
    pane = el;
    el.innerHTML = panelHtml();
    if (!el._tmWired) {
      el._tmWired = true;
      el.addEventListener("change", onPaneChange);
      el.addEventListener("click", onAction);
    }
    paintPane();
  }
  function paintPane() {
    const el = pane;
    if (!el || !el.isConnected) return;
    const q = s => el.querySelector(s);
    const cb = q("[data-tm-row]"); if (cb) cb.checked = on();
    for (const s of el.querySelectorAll("[data-tm-k]")) if (document.activeElement !== s) s.value = String(P[s.dataset.tmK]);
    for (const b of el.querySelectorAll("[data-tm-set]")) {
      const onB = String(P[b.dataset.tmSet]) === b.dataset.v;
      b.classList.toggle("on", onB); b.setAttribute("aria-pressed", String(onB));
    }
    for (const d of el.querySelectorAll("[data-tm-for]")) d.hidden = d.dataset.tmFor !== P.kind;
    for (const d of el.querySelectorAll("[data-tm-datum]")) d.hidden = d.dataset.tmDatum !== P.iDatum;
    const cal = q('[data-tm-a="calib"]'), C = cal ? calibHint() : null;
    if (cal) { cal.disabled = !C; if (C) { cal.textContent = C.label; cal.title = C.title; } }
    const f = finding(), fe = q('[data-o="find"]');
    if (fe) { fe.textContent = current() ? f.text : busy ? "computing…" : "—"; fe.dataset.temFinding = current() ? f.k : "none"; }
    q('[data-o="rows"]').innerHTML = rowsHtml(rowsNow());
    q('[data-o="leg"]').innerHTML = legendHtml(300);
    el.dataset.tmKind = P.kind;
  }

  /* ------------------------------------------------------------------ */
  /* the one setter                                                      */
  /* ------------------------------------------------------------------ */
  const RERUN = new Set(["kind", "iDatum", "iTop", "iBot", "iZTop", "iZBot", "tThr", "tDir", "tFrom"]);
  function clampP(k) {
    const DM = Math.floor(G().dmax()), [eLo, eHi] = G().elevRange();
    const c = (v, a, b) => Math.max(a, Math.min(b, v));
    P.iTop = c(Math.round(P.iTop), 0, DM - 1); P.iBot = c(Math.round(P.iBot), 1, DM);
    /* the control that moved wins; the other gives way by a foot */
    if (!(P.iBot > P.iTop)) { if (k === "iTop") P.iBot = Math.min(DM, P.iTop + 1); else P.iTop = Math.max(0, P.iBot - 1); }
    if (!(P.iBot > P.iTop)) { P.iTop = 0; P.iBot = Math.min(DM, 30); }
    P.iZTop = c(Math.round(P.iZTop), eLo + 1, eHi); P.iZBot = c(Math.round(P.iZBot), eLo, eHi - 1);
    if (!(P.iZTop > P.iZBot)) { if (k === "iZTop") P.iZBot = P.iZTop - 1; else P.iZTop = P.iZBot + 1; }
    P.tThr = c(+(+P.tThr).toPrecision(4), 0.1, 10000);
    P.tFrom = c(Math.round(P.tFrom), 0, DM - 1);
  }
  async function setP(k, v) {
    if (!(k in DEF) || !data()) return;
    const was = P[k];
    P[k] = typeof DEF[k] === "number" ? +v : String(v);
    if (typeof DEF[k] === "number" && !isFinite(P[k])) P[k] = was;
    if (k === "kind" && P.kind !== "top") P.kind = "interval";
    if (k === "iDatum") {
      P.iDatum = P.iDatum === "elev" ? "elev" : "depth";
      /* the first elevations are the depth interval under the survey's
         median ground, so the picture does not jump */
      if (P.iDatum === "elev" && was !== "elev") {
        const D = data(), zs = Array.from(D.z).sort((a, b) => a - b), z = zs[zs.length >> 1];
        P.iZTop = Math.round(z - P.iTop); P.iZBot = Math.round(z - P.iBot);
      }
    }
    if (k === "iShow" && !SHOW_I[P.iShow]) P.iShow = "rhoG";
    if (k === "tShow" && !SHOW_T[P.tShow]) P.tShow = "depth";
    if (k === "tDir" && P.tDir !== "above") P.tDir = "below";
    clampP(k);
    save();
    if (RERUN.has(k)) {
      paintPane();
      if (on()) await ensure(); else { M = null; mKey = ""; pic = null; paintPane(); }
      return;
    }
    /* a different reduction of the same map: no job */
    paint(); soon3d(); refreshCard(); paintPane(); emit();
  }
  function onPaneChange(e) {
    const t = e.target;
    if (t.hasAttribute("data-tm-row")) { setRow(t.checked); return; }
    if (t.dataset.tmK) setP(t.dataset.tmK, t.value);
  }
  function setRow(want) {
    if (on() === !!want) return;
    if (row && row.cb) row.cb.click(); else SBMM.layerState.set("invest", ROW, { on: !!want });
  }
  let busy = 0;
  async function ensure() {
    busy++; paintPane();
    let res;
    try { res = await run(); } finally { busy--; }
    if (!res || !data()) { SBMM.layerState.set("invest", ROW, { on: false }); return null; }
    paint(); refreshCard(); soon3d(); paintPane(); emit();
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* actions and exports                                                 */
  /* ------------------------------------------------------------------ */
  const fileTag = () => P.kind === "interval"
    ? "interval_" + (P.iDatum === "elev" ? "elev" + P.iZBot + "-" + P.iZTop : P.iTop + "-" + P.iBot) + "ft"
    : "top_" + P.tDir + "_" + String(P.tThr).replace(".", "p") + "ohmm";
  function csv() {
    if (!current()) return "";
    const f = (v, n) => v === v ? (+v).toFixed(n) : "", N = M.nx * M.ny;
    let out;
    if (M.what === "interval") {
      out = `# TEM interval ${intervalWords()}; ${G().options().method.find(m => m[0] === M.method)[1]}; EPSG:6418 ft; `
        + "along = thickness / conductance (harmonic), across = arithmetic, conductance in siemens; interpreted, planning-level\n"
        + "easting_ft,northing_ft,model_thickness_ft,rho_geometric_ohm_m,rho_along_ohm_m,rho_across_ohm_m,conductance_S,anisotropy\n";
      for (let id = 0; id < N; id++) {
        if (!(M.rhoG[id] === M.rhoG[id])) continue;
        out += [(M.x0 + (id % M.nx) * M.dx).toFixed(1), (M.y0 + Math.floor(id / M.nx) * M.dx).toFixed(1), f(M.thick[id], 2),
                (+M.rhoG[id]).toPrecision(4), (+M.rhoL[id]).toPrecision(4), (+M.rhoT[id]).toPrecision(4),
                (+M.cond[id]).toPrecision(4), f(M.aniso[id], 3)].join(",") + "\n";
      }
      return out;
    }
    out = `# TEM top of the ${P.tDir === "above" ? "resistor" : "conductor"}: first depth ${topWords()}; `
      + (M.blend ? "blended between layer mid-depths" : "model layers as inverted") + "; EPSG:6418 ft; elevation from the model's ground; interpreted, planning-level\n"
      + "easting_ft,northing_ft,depth_ft,elev_ft,thickness_ft,to_end_of_record,at_start\n";
    for (let id = 0; id < N; id++) {
      if (!(M.depth[id] === M.depth[id])) continue;
      out += [(M.x0 + (id % M.nx) * M.dx).toFixed(1), (M.y0 + Math.floor(id / M.nx) * M.dx).toFixed(1), f(M.depth[id], 2),
              f(M.elev[id], 2), f(M.thick[id], 2), M.open[id], M.atStart[id]].join(",") + "\n";
    }
    return out;
  }
  function exportPng() {
    const p = picture(), sc = scaleNow();
    if (!p || !sc) { toast("the map is not computed yet"); return; }
    const c = document.createElement("canvas");
    c.width = p.W + 32; c.height = p.H + 60;
    const x = c.getContext("2d");
    x.fillStyle = "#0B1013"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(p.canvas, 16, 16);
    x.fillStyle = "#DDE5E8"; x.font = "13px system-ui, sans-serif";
    x.fillText(title().replace("TEM — ", "TEM "), 16, p.H + 36);
    x.fillStyle = "#9FB0B5"; x.font = "12px system-ui, sans-serif";
    x.fillText(`${showNow().name} ${fV(sc.lo)}–${fV(sc.hi)}${sc.unit ? " " + sc.unit : ""}` + (sc.kind === "log" ? " (log)" : ""), 16, p.H + 53);
    if (SBMM.watermark) SBMM.watermark.burn(c);
    c.toBlob(b => download("SBMM_TEM_" + fileTag() + ".png", b));
  }
  function frame() {
    const R = G().result();
    if (!R) return;
    const x1 = R.x0 + (R.nx - 1) * R.dx, y1 = R.y0 + (R.ny - 1) * R.dx;
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen()) SBMM.viewer3d.frameBox(R.x0, R.y0, x1, y1);
    else SBMM.map.fitBounds([[R.y0, R.x0], [y1, x1]], SBMM.omni && SBMM.omni.fitPad ? SBMM.omni.fitPad() : {});
  }
  function onAction(e) {
    const s = e.target.closest("[data-tm-set]");
    if (s) { setP(s.dataset.tmSet, s.dataset.v); return; }
    const b = e.target.closest("[data-tm-a]");
    if (!b) return;
    const a = b.dataset.tmA;
    if (a === "csv") { if (current()) download("SBMM_TEM_" + fileTag() + ".csv", new Blob([csv()], { type: "text/csv" })); else toast("the map is not computed yet"); return; }
    if (a === "png") { exportPng(); return; }
    if (a === "asc" || a === "report") {
      if (!SBMM.temexport) { toast("that export is not in this build"); return; }
      if (a === "asc") SBMM.temexport.gridZip("map"); else SBMM.temexport.report();
      return;
    }
    if (a === "ws") { if (SBMM.temws) SBMM.temws.open({ tab: "maps" }); return; }
    if (a === "frame") { frame(); return; }
    if (a === "calib") { const C = calibHint(); if (C) setP("tThr", C.rho); return; }
    if (a === "slice") {
      /* the model layer the Model tab's slice sits in, as a depth interval */
      const li = G().layerInfo ? G().layerInfo(G().depth()) : null;
      if (!li) return;
      P.iDatum = "depth"; P.iTop = Math.floor(li.top); P.iBot = Math.max(P.iTop + 1, Math.ceil(li.bot));
      setP("iTop", P.iTop);
    }
  }

  /* ------------------------------------------------------------------ */
  /* the row, the commands' entry point                                  */
  /* ------------------------------------------------------------------ */
  function build() {
    const D = data();
    if (!D || !D.n || row) return;
    row = SBMM.addLayerRow("invest", "Derived map — interval / top of conductor", null,
      { id: ROW, checked: false, swatch: "#3ec8b4", opacity: 0.9, sub: SUB, subTitle: SUB_TITLE,
        onChange: async st => {
          if (!st.on) { paint(); soon3d(); paintPane(); emit(); return; }
          if (current() && overlay) { overlay.setOpacity(st.opacity); soon3d(); return; }
          await ensure();
        } });
    row.row.title = "A map derived from the TEM model: the mean resistivity or conductance of an interval, or the depth to the top of a conductor";
    if (SBMM.events) SBMM.events.on("tem", () => {
      const R = G().result();
      if (!R) return;
      /* a model re-run, or the blend the top map follows, re-runs the map;
         a colour change only repaints it */
      if (on() && M && mKey !== keyOf(R)) { ensure(); return; }
      if (on() && current() && (!pic || pic.key !== picKey())) { paint(); soon3d(); refreshCard(); paintPane(); }
    });
  }
  /* TEMMAP: the workspace at the Maps tab, or on a phone the card */
  async function open(kind) {
    if (!data()) { toast("the TEM survey is not in this build"); return false; }
    if (kind === "interval" || kind === "top") { P.kind = kind; save(); }
    if (!document.body.classList.contains("field") && SBMM.temws) return SBMM.temws.open({ tab: "maps" });
    if (!on()) setRow(true);
    const res = await ensure();
    if (!res) return false;
    showCard();
    return true;
  }
  /* the workspace tab became visible: its layer on, its numbers in */
  async function activate() {
    if (!data()) return null;
    if (!on()) setRow(true);
    paintPane();
    const res = await ensure();
    paintPane();
    return res;
  }

  return {
    build, open, activate, mount, paintPane, run, scene3d, wantsSeeThrough, pick3d, readAt, hoverText,
    setRow, set: setP, settings: () => Object.assign({}, P), result: () => (current() ? M : null),
    card: () => card, cards: () => (card ? [card] : []), showCard, row: () => row, on,
    csv, exportPng, finding, rows: rowsNow, scale: scaleNow, picture, title, frame, ROW,
    /* v55: the map on screen as a grid, with the words an export needs */
    grid() {
      if (!current()) return null;
      const sh = showNow(), sc = scaleNow();
      return { nx: M.nx, ny: M.ny, dx: M.dx, x0: M.x0, y0: M.y0, v: arrNow(), name: sh.name, unit: sh.unit,
               what: P.kind === "interval" ? `${sh.name} of ${intervalWords()}` : `${sh.name} of the first ground ${topWords()}`,
               tag: fileTag() + "_" + (P.kind === "interval" ? P.iShow : P.tShow), log: !!(sc && sc.kind === "log"),
               method: G().methodName ? G().methodName() : "" };
    }
  };
})();
