/* SBMM Site Explorer — the tree layer and the tree inventory (phase 4, v39).

   WHERE THE TREES COME FROM (v39). The app ships a baked table of every tree on
   the surveyed site (SBMM_DATA.trees_site, tools/build_trees.py):

     * inside the mine-area window, from the app's own canopy model (the
       January-2024 site lidar) — the same "trees" kernel in js/compute.js that
       this file used to run on first show, run once at build time, with the
       detections that sit on a building polygon dropped;
     * outside it, where the app has no canopy model, from the public USGS 3DEP
       lidar through that same kernel.

   Each tree carries its height, crown radius and area, a FORM read off the
   crown's own shape (broadleaf / conifer / brush), a colour sampled from the
   orthophoto, and which survey it came from. A build without the table falls
   back to detecting over the canopy model exactly as before.

   RENDERING. There are well over ten thousand trees, so:

     • no DOM per tree. Everything is painted on ONE 2D canvas stretched over
       the map, the same technique the object-snap overlay uses.
     • a crown is a SPRITE. A tree is drawn at its true crown size as a small
       pre-rendered picture (lobed crown, lit from the north-west, with its own
       ground shadow) picked by form and colour; there are a few dozen sprites
       and each tree is one drawImage. Zoomed out so far that a crown is under
       a couple of pixels, a tree is a dot.
     • no per-frame allocation, an inline bounds test over typed arrays, and a
       repaint that is rAF-throttled.

   The 3D view draws the same table as real trees — js/trees3d.js.

   Hit-testing a click is a linear scan over typed arrays — ten thousand
   distance compares is nothing next to the click latency. */
"use strict";

SBMM.trees = (function () {

  let data = null;              // { x, y, h, area, radius, form, src, tint, n, ... }
  let running = null;
  let layer = null, rowRef = null;
  let cv = null, ctx = null, cw = 0, ch = 0, needSize = true, rafQ = false;
  let minShow = 6;
  let byHeight = false;         // colour by height instead of the natural colours

  const RAMP = RAMPS.canopy;
  const NB = 10;                                   // height colour buckets
  /* Ramp domain. The tallest tree on site is ~85 ft, but the median is 19 and p95 is
     48, so stretching the ramp to 90 spent most of its range on heights that barely
     occur. Clamping at 60 puts the gradient where the trees are. */
  const H_LO = 6, H_HI = 60;                       // ramp domain, ft
  const FORMS = ["broadleaf", "conifer", "brush"];
  const FORM_LABEL = ["Broadleaf", "Conifer", "Brush"];
  /* base foliage colour per form, sRGB: oak olive, pine green, chaparral grey-green */
  const BASE = [[92, 116, 62], [56, 88, 58], [122, 124, 78]];

  function bucketOf(hv) {
    return clamp(Math.floor((hv - H_LO) / (H_HI - H_LO) * NB), 0, NB - 1);
  }
  function rampRGB(b) {
    const c = lerpRamp(RAMP, (b + 0.5) / NB);
    return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
  }
  function hash(i, k) {
    let h = (i * 374761393 + k * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* ONE colour rule, read by the 2D sprites and by the 3D instances.
     The ortho was flown in January: a leafless oak reads grey and a crown in a
     neighbour's shade nearly black. So the photograph sets the hue and the
     tree-to-tree variety, the form sets the base, and the brightness is held
     inside the range foliage actually has. Writes sRGB 0-255 into out. */
  function rgbOf(td, i, out) {
    const f = td.form ? td.form[i] : 0, b = BASE[f];
    let r = b[0], g = b[1], bl = b[2];
    if (td.tint) {
      let tr = td.tint[i * 3], tg = td.tint[i * 3 + 1], tb = td.tint[i * 3 + 2];
      const lum = 0.30 * tr + 0.59 * tg + 0.11 * tb;
      if (lum > 1) {
        const k = clamp(lum, 62, 128) / lum;
        tr *= k; tg *= k; tb *= k;
        tg = Math.max(tg, tr * 1.04, tb * 1.10);       // keep it foliage
        r = r * 0.5 + tr * 0.5; g = g * 0.5 + tg * 0.5; bl = bl * 0.5 + tb * 0.5;
      }
    }
    const v = 0.90 + 0.20 * hash(i, 7), w = 0.96 + 0.08 * hash(i, 11);
    out[0] = clamp(r * v * w, 0, 255); out[1] = clamp(g * v, 0, 255); out[2] = clamp(bl * v / w, 0, 255);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the table                                                           */
  /* ------------------------------------------------------------------ */
  function ready() { return !!data; }
  function hasSource() { return !!(SBMM_DATA && SBMM_DATA.trees_site) || !!SBMM.chm; }
  function stats() {
    if (!data) return null;
    return { n: data.n, maxima: data.maxima, dropped: data.dropped, ms: data.ms, minH: data.minH,
             baked: !!data.baked, counts: data.counts || null };
  }

  function bytes(b64) {
    const s = atob(b64), u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function u16(b64) { const u = bytes(b64); return new Uint16Array(u.buffer, 0, u.length >> 1); }

  /* everything derived once: draw order, sprite key per tree, counts */
  function finish(d) {
    const n = d.n;
    /* shortest first, so a tall crown is painted over the brush beside it */
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const hh = d.h;
    Array.prototype.sort.call(order, (a, b) => hh[a] - hh[b]);
    d.order = order;
    /* natural colours are quantised into a few per form — a sprite per colour */
    const tmp = [0, 0, 0];
    d.nat = new Uint8Array(n);                       // palette slot within the form
    const acc = [];
    for (let f = 0; f < 3; f++) { acc.push([]); for (let k = 0; k < 6; k++) acc[f].push([0, 0, 0, 0]); }
    for (let i = 0; i < n; i++) {
      rgbOf(d, i, tmp);
      const lum = 0.30 * tmp[0] + 0.59 * tmp[1] + 0.11 * tmp[2];
      const warm = tmp[0] > tmp[1] * 0.86 ? 1 : 0;
      const slot = clamp(Math.floor((lum - 70) / 14), 0, 2) * 2 + warm;
      d.nat[i] = slot;
      const a = acc[d.form[i]][slot];
      a[0] += tmp[0]; a[1] += tmp[1]; a[2] += tmp[2]; a[3]++;
    }
    d.palette = acc.map((row, f) => row.map(a => a[3]
      ? [Math.round(a[0] / a[3]), Math.round(a[1] / a[3]), Math.round(a[2] / a[3])] : BASE[f]));
    const c = { total: n, site: 0, usgs: 0, broadleaf: 0, conifer: 0, brush: 0 };
    for (let i = 0; i < n; i++) { c[d.src[i] ? "usgs" : "site"]++; c[FORMS[d.form[i]]]++; }
    d.counts = c;
    return d;
  }

  function fromPayload() {
    const P = SBMM_DATA && SBMM_DATA.trees_site;
    if (!P || !P.cols) return null;
    const t0 = performance.now(), n = P.n;
    const qx = u16(P.cols.x), qy = u16(P.cols.y), qh = u16(P.cols.h), qr = bytes(P.cols.r), qa = u16(P.cols.area);
    const x = new Float64Array(n), y = new Float64Array(n), h = new Float32Array(n),
          radius = new Float32Array(n), area = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = P.x0 + qx[i] * P.q_xy; y[i] = P.y0 + qy[i] * P.q_xy;
      h[i] = qh[i] * P.q_h; radius[i] = qr[i] * P.q_r; area[i] = qa[i];
    }
    return finish({ x, y, h, area, radius, n, form: bytes(P.cols.form), src: bytes(P.cols.src),
                    tint: bytes(P.cols.tint), baked: true, minH: 6, sources: P.sources || [],
                    validation: P.validation || null, built: P.built,
                    ms: Math.round(performance.now() - t0) });
  }

  /* the pre-v39 path, kept for a build that has the canopy model and no table */
  async function fromKernel(minH) {
    const chm = SBMM.chm;
    if (!chm) throw new Error("this build has no tree table and no canopy height model");
    const grid = SBMM.compute.gridSpec(chm);
    const t0 = performance.now();
    const R = await SBMM.compute.run("trees",
      { grid, minH, minCrown: 4 },
      { transfer: [grid.z.buffer], label: "Detecting trees — canopy maxima" }).promise;
    const form = new Uint8Array(R.n);
    for (let i = 0; i < R.n; i++)
      form[i] = R.h[i] < 13 ? 2 : (R.h[i] >= 30 && R.h[i] / Math.max(2 * R.radius[i], 1e-6) > 1.7) ? 1 : 0;
    return finish({ x: R.x, y: R.y, h: R.h, area: R.area, radius: R.radius, n: R.n, form,
                    src: new Uint8Array(R.n), tint: null, baked: false,
                    maxima: R.maxima, dropped: R.dropped, minH: R.minH, sources: [],
                    ms: Math.round(performance.now() - t0) });
  }

  async function detect(opts) {
    opts = opts || {};
    if (running) return running;
    if (data && !opts.force) return data;
    running = (async () => {
      data = fromPayload() || await fromKernel(opts.minH == null ? 6 : opts.minH);
      return data;
    })();
    try { return await running; } finally { running = null; }
  }

  function sourceLabel(i) {
    if (!data) return "";
    const s = data.sources && data.sources[data.src[i]];
    return s ? s.label : (data.src[i] ? "USGS 3DEP lidar (public)" : "Site lidar, Jan 2024");
  }
  /* the record the popup, the 3D pick card and the CSV all read */
  function tree(i) {
    if (!data || i < 0 || i >= data.n) return null;
    return { id: i + 1, x: data.x[i], y: data.y[i], h: data.h[i], r: data.radius[i], area: data.area[i],
             form: FORM_LABEL[data.form[i]], source: sourceLabel(i) };
  }

  /* ------------------------------------------------------------------ */
  /* crown sprites                                                       */
  /* ------------------------------------------------------------------ */
  const SPR = 96, SPR_PAD = 1.3;                    // sprite px; the crown radius is SPR / (2 * PAD)
  const sprites = new Map();
  const css = (c, k) => `rgb(${Math.round(clamp(c[0] * k, 0, 255))},${Math.round(clamp(c[1] * k, 0, 255))},${Math.round(clamp(c[2] * k, 0, 255))})`;

  function sprite(form, variant, col) {
    const key = form + "|" + variant + "|" + col[0] + "," + col[1] + "," + col[2];
    let s = sprites.get(key);
    if (s) return s;
    s = document.createElement("canvas");
    s.width = s.height = SPR;
    const g = s.getContext("2d"), c0 = SPR / 2, R = SPR / (2 * SPR_PAD);
    const rnd = k => hash(form * 31 + variant * 7 + 3, k);
    /* the outline: a ring of lobes for a broadleaf, a star for a conifer, a ragged low blob for brush */
    const outline = () => {
      g.beginPath();
      if (form === 1) {
        const n = 11 + variant * 2;
        for (let i = 0; i < n * 2; i++) {
          const a = i / (n * 2) * Math.PI * 2 + rnd(1), r = i % 2 ? R * (0.60 + 0.10 * rnd(i + 5)) : R * (0.94 + 0.06 * rnd(i + 9));
          g[i ? "lineTo" : "moveTo"](c0 + Math.cos(a) * r, c0 + Math.sin(a) * r);
        }
        g.closePath();
      } else {
        const n = form === 2 ? 6 : 8 + variant;
        for (let i = 0; i < n; i++) {
          const a = i / n * Math.PI * 2 + rnd(2) * 6, lr = R * (form === 2 ? 0.44 : 0.36) * (0.85 + 0.3 * rnd(i + 11));
          const d = R - lr;
          g.moveTo(c0 + Math.cos(a) * d + lr, c0 + Math.sin(a) * d);
          g.arc(c0 + Math.cos(a) * d, c0 + Math.sin(a) * d, lr, 0, Math.PI * 2);
        }
        g.moveTo(c0 + R * 0.7, c0);
        g.arc(c0, c0, R * 0.7, 0, Math.PI * 2);
      }
    };
    /* the ground shadow first, thrown to the south-east like the 2D relief */
    g.save();
    g.translate(R * (form === 2 ? 0.10 : 0.20), R * (form === 2 ? 0.12 : 0.24));
    g.filter = "blur(" + (R * 0.10).toFixed(1) + "px)";
    g.fillStyle = "rgba(4,10,8,.42)";
    outline(); g.fill();
    g.restore();
    /* the crown: dark at the rim, lit from the north-west */
    const grad = g.createRadialGradient(c0 - R * 0.30, c0 - R * 0.32, R * 0.08, c0, c0, R * 1.02);
    grad.addColorStop(0, css(col, 1.30));
    grad.addColorStop(0.55, css(col, 1.0));
    grad.addColorStop(1, css(col, 0.58));
    g.fillStyle = grad;
    outline(); g.fill();
    g.save();
    outline(); g.clip();
    if (form === 1) {
      /* a conifer from above: branches radiating from the leader */
      g.strokeStyle = css(col, 0.62); g.lineWidth = 1.1;
      const n = 11 + variant * 2;
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 + rnd(1);
        g.beginPath(); g.moveTo(c0, c0); g.lineTo(c0 + Math.cos(a) * R, c0 + Math.sin(a) * R); g.stroke();
      }
      g.fillStyle = css(col, 1.45);
      g.beginPath(); g.arc(c0, c0, R * 0.09, 0, Math.PI * 2); g.fill();
    } else {
      /* leaf clumps: lighter towards the light, darker away from it */
      const n = form === 2 ? 9 : 16;
      for (let i = 0; i < n; i++) {
        const a = rnd(i + 20) * Math.PI * 2, d = Math.sqrt(rnd(i + 40)) * R * 0.78;
        const x = c0 + Math.cos(a) * d, y = c0 + Math.sin(a) * d, lr = R * (0.13 + 0.12 * rnd(i + 60));
        const lit = clamp(0.5 - ((x - c0) + (y - c0)) / (2.6 * R), 0, 1);
        g.fillStyle = css(col, 0.74 + 0.62 * lit);
        g.globalAlpha = 0.55;
        g.beginPath(); g.arc(x - lr * 0.2, y - lr * 0.2, lr, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
    g.restore();
    g.strokeStyle = "rgba(10,20,12,.55)"; g.lineWidth = 1;
    if (form === 1) { outline(); g.stroke(); }
    sprites.set(key, s);
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* canvas layer                                                        */
  /* ------------------------------------------------------------------ */
  function sizeCanvas() {
    if (!cv) return;
    needSize = false;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    cw = w; ch = h;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function colourFor(i) {
    return byHeight ? rampRGB(bucketOf(data.h[i])) : data.palette[data.form[i]][data.nat[i]];
  }

  function paint() {
    /* size BEFORE testing ctx — sizeCanvas() is what creates it, so guarding on
       ctx up front means the very first paint returns early and the layer never
       draws anything at all */
    if (!cv) return;
    if (needSize) sizeCanvas();
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (!data || !layer || !SBMM.map.hasLayer(layer)) return;
    const map = SBMM.map, b = map.getBounds();
    const w0 = b.getWest(), e0 = b.getEast(), s0 = b.getSouth(), n0 = b.getNorth();
    /* world -> container pixels is a plain affine here (CRS.Simple), so derive it
       once per paint instead of calling latLngToContainerPoint per tree */
    const p0 = map.latLngToContainerPoint([s0, w0]), p1 = map.latLngToContainerPoint([n0, e0]);
    const sx = (p1.x - p0.x) / (e0 - w0), sy = (p1.y - p0.y) / (n0 - s0);
    const X = data.x, Y = data.y, H = data.h, RA = data.radius, O = data.order;
    const pad = 60 / Math.abs(sx);                 // a crown whose centre is just off screen still shows
    let drawn = 0;
    /* a crown under ~2 px is a dot; from there up it is the crown itself */
    const dotPx = clamp(Math.abs(sx) * 9, 2, 3.2);
    for (let k = 0; k < O.length; k++) {
      const i = O[k];
      if (H[i] < minShow) continue;
      const x = X[i], y = Y[i];
      if (x < w0 - pad || x > e0 + pad || y < s0 - pad || y > n0 + pad) continue;
      const px = p0.x + (x - w0) * sx, py = p0.y + (y - s0) * sy;
      const R = RA[i] * Math.abs(sx);
      if (R < 2.2) {
        const c = colourFor(i);
        ctx.fillStyle = "rgba(8,14,18,.7)";
        ctx.fillRect(px - dotPx / 2 - 0.7, py - dotPx / 2 - 0.7, dotPx + 1.4, dotPx + 1.4);
        ctx.fillStyle = css(c, 1.15);
        ctx.fillRect(px - dotPx / 2, py - dotPx / 2, dotPx, dotPx);
      } else {
        const s = sprite(data.form[i], i & 1, colourFor(i)), D = R * SPR_PAD;
        ctx.drawImage(s, px - D, py - D, D * 2, D * 2);
      }
      drawn++;
    }
    layer._drawn = drawn;
    updateLegend(drawn);
  }
  function repaint() {
    if (rafQ) return;
    rafQ = true;
    requestAnimationFrame(() => { rafQ = false; paint(); });
  }

  /* a Leaflet layer wrapper so the existing layer-row machinery works unchanged */
  function makeLayer() {
    const Lyr = L.Layer.extend({
      onAdd() {
        cv = document.getElementById("treeCanvas");
        if (cv) { cv.style.display = "block"; needSize = true; }
        SBMM.map.on("move zoom moveend zoomend resize", repaint);
        window.addEventListener("resize", onWinResize);
        registerReader();
        repaint();
      },
      onRemove() {
        SBMM.map.off("move zoom moveend zoomend resize", repaint);
        window.removeEventListener("resize", onWinResize);
        if (ctx) ctx.clearRect(0, 0, cw, ch);
        if (cv) cv.style.display = "none";
        updateLegend(0);
      }
    });
    return new Lyr();
  }
  function onWinResize() { needSize = true; repaint(); }

  /* ------------------------------------------------------------------ */
  /* click -> tree popup                                                 */
  /* ------------------------------------------------------------------ */
  /* the tree whose crown the point is in, nearest trunk first; failing that,
     the nearest trunk inside maxFt */
  function nearest(x, y, maxFt) {
    if (!data) return -1;
    let best = -1, bd = Infinity, loose = -1, ld = maxFt * maxFt;
    const X = data.x, Y = data.y, RA = data.radius;
    for (let i = 0; i < data.n; i++) {
      if (data.h[i] < minShow) continue;
      const dx = X[i] - x, dy = Y[i] - y, d = dx * dx + dy * dy;
      if (d < RA[i] * RA[i] && d < bd) { bd = d; best = i; }
      if (d < ld) { ld = d; loose = i; }
    }
    return best >= 0 ? best : loose;
  }
  /* v58: a crown under the pointer says what it is (js/readout.js). The 2D
     layer is one canvas, not Leaflet vectors, so the pick engine never saw a
     tree and a hover said nothing. */
  function registerReader() {
    if (!SBMM.readout) return;
    SBMM.readout.register({ id: "trees", on: () => !!(data && SBMM.layerState.isOn("base", "trees_detected")),
      at(x, y) {
        const i = nearest(x, y, 0);
        const t = i >= 0 ? tree(i) : null;
        return t ? { name: "Tree " + t.id, value: `${fmt0(t.h)} ft ${t.form}`, key: String(t.id),
                     rows: [["Tree " + t.id, `${fmt0(t.h)} ft ${t.form}`]] } : null;
      },
      /* a click on a crown that nothing else answered: the tree's own card
         (js/readout.js opens it — the layer no longer listens for the map's
         click itself). A click may land between crowns, so the trunk nearest
         within a few pixels still counts, as it always did. */
      card(x, y, ctx) {
        const tolFt = ctx.view === "2d" ? 14 / Math.pow(2, SBMM.map.getZoom()) : 0;
        const i = nearest(x, y, Math.max(tolFt, 6));
        return i >= 0 ? { html: SBMM.popups.forTree(tree(i)), at: [data.x[i], data.y[i]], className: "treepop" } : null;
      } });
  }
  /* ------------------------------------------------------------------ */
  /* legend + layer row                                                  */
  /* ------------------------------------------------------------------ */
  let legendEl = null;
  function updateLegend(drawn) {
    if (!legendEl) return;
    const on = layer && SBMM.map.hasLayer(layer);
    legendEl.querySelector(".tcount").textContent = !data ? "not loaded yet"
      : (on ? fmt0(drawn) + " shown of " + fmt0(data.n) : fmt0(data.n) + " trees");
  }
  function paintLegend() {
    if (!legendEl) return;
    const key = legendEl.querySelector(".tkey");
    key.innerHTML = byHeight
      ? `<span class="rampbar" style="background:linear-gradient(90deg,${RAMP.map(c => `rgb(${c.join(",")})`).join(",")})"></span>` +
        `<span class="mono">${H_LO} → ${H_HI}+ ft</span>`
      : FORMS.map((f, k) => `<span class="tsw" style="background:${css(BASE[k], 1.05)}"></span>${FORM_LABEL[k].toLowerCase()}`).join(" ");
    const b = legendEl.querySelector("#treeMode");
    if (b) { b.textContent = byHeight ? "natural colours" : "colour by height"; }
  }

  function buildLayerRow() {
    if (!hasSource()) return;
    layer = makeLayer();
    /* Loading the table is the first-show cost, so it goes through
       addLayerRow's own onFirstShow hook rather than overriding cb.onchange —
       since v9 the checkbox only reports to SBMM.layerState, and replacing its
       handler would have cut this row out of the one layer state entirely. */
    rowRef = SBMM.addLayerRow("ana", "Trees", layer, {
      id: "trees_detected", checked: false, swatch: "#6FA050",
      onFirstShow: async () => {
        if (data) return;
        await detect();
        if (!data.baked) toast(fmt0(data.n) + " trees detected in " + (data.ms / 1000).toFixed(1) + " s");
      },
      onChange: st => { if (st.on && data) repaint(); }
    });

    legendEl = document.createElement("div");
    legendEl.className = "legend treelegend";
    legendEl.innerHTML =
      `<span class="tkey"></span> · <span class="mono tcount">not loaded yet</span>` +
      `<div class="genrow" style="margin-top:5px">` +
      `<span class="minib" id="treeGo">inventory</span>` +
      `<span class="minib" id="treeCsv">CSV</span>` +
      `<span class="minib" id="treeMode">colour by height</span>` +
      `min <input type="number" id="treeMin" value="6" min="1" step="1" style="width:46px"> ft</div>`;
    $("anaLayers").appendChild(legendEl);
    paintLegend();
    legendEl.querySelector("#treeGo").onclick = () => cmdTrees();
    legendEl.querySelector("#treeCsv").onclick = () => exportCsv();
    legendEl.querySelector("#treeMode").onclick = () => { byHeight = !byHeight; paintLegend(); repaint(); };
    legendEl.querySelector("#treeMin").onchange = e => setMinShow(parseFloat(e.target.value) || 6);
  }

  function setMinShow(v) {
    minShow = Math.max(1, +v || 6);
    const mi = document.getElementById("treeMin");
    if (mi && +mi.value !== minShow) mi.value = minShow;
    repaint();
    if (SBMM.viewState) SBMM.viewState.touch();
    if (SBMM.viewer3d && SBMM.viewer3d.refreshOverlays && SBMM.layerState.isOn("base", "trees_detected"))
      SBMM.viewer3d.refreshOverlays("trees");
  }

  /* ------------------------------------------------------------------ */
  /* commands + export                                                   */
  /* ------------------------------------------------------------------ */
  async function cmdTrees(arg) {
    if (!SBMM_DATA.trees_site && !SBMM.chm && SBMM.chmReady) await SBMM.chmReady;
    if (!hasSource()) { toast("this build has no tree table and no canopy height model"); return; }
    const minH = arg ? parseFloat(arg) : NaN;
    try {
      await detect();
    } catch (e) {
      if (!(e && e.cancelled)) toast("the tree inventory failed: " + e.message);
      return;
    }
    if (!isNaN(minH)) setMinShow(minH);
    if (rowRef) SBMM.layerState.set("base", "trees_detected", { on: true });
    repaint();
    const idx = [];
    for (let i = 0; i < data.n; i++) if (data.h[i] >= minShow) idx.push(i);
    const hs = idx.map(i => data.h[i]).sort((a, b) => a - b);
    const as = idx.map(i => data.area[i]).sort((a, b) => a - b);
    const c = { site: 0, usgs: 0, f: [0, 0, 0] };
    for (const i of idx) { c[data.src[i] ? "usgs" : "site"]++; c.f[data.form[i]]++; }
    const rows = [
      ["Trees", fmt0(idx.length) + (minShow > 6 ? " at " + minShow + " ft and over" : "")],
      ["Broadleaf / conifer / brush", fmt0(c.f[0]) + " / " + fmt0(c.f[1]) + " / " + fmt0(c.f[2]),
       "Read off each crown's shape in the lidar: brush under 13 ft; conifer from 30 ft where the crown is pointed or slender; broadleaf otherwise. A form, not a species."],
      ["Median height", hs.length ? fmt(hs[Math.floor(hs.length / 2)], 1) + " ft" : "—"],
      ["Tallest", hs.length ? fmt(hs[hs.length - 1], 1) + " ft" : "—"],
      ["Median crown", as.length ? fmt0(as[Math.floor(as.length / 2)]) + " ft²" : "—"]
    ];
    if (data.baked) {
      rows.push(["Mine area (site lidar, Jan 2024)", fmt0(c.site)]);
      rows.push(["Rest of the site (USGS lidar)", fmt0(c.usgs),
        data.validation ? "Checked in the mine area, where both surveys overlap: " + data.validation.usgs_matched_pct
          + " % of the USGS trees match a site-lidar tree, median height difference "
          + data.validation.height_diff_ft.median + " ft." : ""]);
    } else {
      rows.push(["Detection", (data.ms / 1000).toFixed(1) + " s · " + fmt0(data.maxima) + " maxima"]);
    }
    const card = SBMM.results.card(null, "Tree inventory", rows);
    const n = SBMM.results.appendNote(card,
      "Lidar canopy maxima · heights are canopy above bare earth · detections on a building are dropped · "
      + "a canopy inventory, not a stem count");
    n.title = "Variable-window local maxima on the canopy height model (window radius = max(4 ft, 0.35 × height)), "
      + "then a marker-based region grow cut at saddles and below 0.3 × apex height. Reliable for dominant, "
      + "well-separated crowns; it merges or misses suppressed understorey.";
    const row = document.createElement("div"); row.className = "volctl";
    row.innerHTML = `<div class="crow btns"><button class="minib">export inventory CSV</button></div>`;
    row.querySelector("button").onclick = () => exportCsv();
    card.appendChild(row);
  }

  function exportCsv() {
    if (!data) { toast("turn the tree layer on first"); return; }
    const L2 = ["id,easting_ft,northing_ft,latitude,longitude,height_ft,crown_area_ft2,crown_radius_ft,form,source,ground_elev_ft,top_elev_ft"];
    let nOut = 0;
    for (let i = 0; i < data.n; i++) {
      if (data.h[i] < minShow) continue;
      const x = data.x[i], y = data.y[i];
      const [lo, la] = SBMM.toLL(x, y);
      const [gz] = SBMM.elev(x, y);
      L2.push([i + 1, x.toFixed(2), y.toFixed(2), la.toFixed(7), lo.toFixed(7),
               data.h[i].toFixed(1), data.area[i].toFixed(0), data.radius[i].toFixed(1),
               FORMS[data.form[i]], '"' + sourceLabel(i) + '"',
               isNaN(gz) ? "" : gz.toFixed(2), isNaN(gz) ? "" : (gz + data.h[i]).toFixed(2)].join(","));
      nOut++;
    }
    download("SBMM_tree_inventory.csv", new Blob([L2.join("\n")], { type: "text/csv" }));
    toast("exported " + fmt0(nOut) + " trees");
  }

  function wire() { buildLayerRow(); }

  return { detect, ready, stats, cmdTrees, exportCsv, wire, repaint, tree, rgbOf, setMinShow,
           minShow: () => minShow, FORMS, BASE,
           get data() { return data; } };
})();
