/* SBMM Site Explorer — the basemap, cleaned (v26, docs/V26_UI_AUDIT.md §10).
   ---------------------------------------------------------------------------
   The three orthophotos and the two hillshades ship as JPEGs, and a JPEG has no
   alpha: everything outside the photography is a flat grey (192 in the orthos,
   205 in the hillshades). On the map that grey is the first thing anyone sees —
   the mine-area photo as a hard grey-edged box inside the site photo, and a grey
   slab where Clear Lake should be. The audit called it the biggest visual lie
   on the map.

   The fix is a MASK, computed here in the browser from the image itself, and
   applied to the overlay's own <img> as a CSS mask:

     1. draw the image, scaled, into a canvas (the browser has already decoded
        it for display, so this is a resample, not a second decode);
     2. find the no-data colour: the one neutral grey that owns the border;
     3. flood-fill it IN FROM THE BORDER — only grey that touches the edge is
        no-data, so a grey roof or a gravel pad inside the photo is kept;
     4. grow it by one cell to eat the JPEG fringe, and hand the result to the
        <img> as `mask-image` through a blob: URL (which works over file://).

   No payload changes, no build step, the same answer in all three builds. The
   pixels under the mask are untouched, so nothing that READS an image (the 3D
   drape, the exports) sees a difference. Under the cleared grey sits Clear Lake,
   painted as water from EA's own polygon, so the lake reads as a lake.
   --------------------------------------------------------------------------- */
"use strict";

SBMM.carto = (function () {
  const done = new WeakMap();          // layer -> Promise<blob url | null>
  const stats = {};                    // name -> { ms, w, h, grey, cleared }

  function lowMem() { return !!(SBMM.lowMem && SBMM.lowMem()); }

  /* The mask itself, as a pure function over RGBA bytes — it runs in a
     Blob-URL worker (the js/dem.js technique: nothing can be fetched over
     file://, so the worker's source is this function's own text), and inline
     on the main thread where a worker or OffscreenCanvas is missing. Keep it
     self-contained: no SBMM, no DOM, and never the closing script tag. */
  function maskPixels(d, w, h) {
    const hist = new Map();
    let border = 0;
    const tally = o => {
      border++;
      const r = d[o], gg = d[o + 1], b = d[o + 2];
      if (Math.abs(r - gg) > 2 || Math.abs(gg - b) > 2) return;
      hist.set(r, (hist.get(r) || 0) + 1);
    };
    for (let i = 0; i < w; i++) { tally(i * 4); tally(((h - 1) * w + i) * 4); }
    for (let j = 1; j < h - 1; j++) { tally(j * w * 4); tally((j * w + w - 1) * 4); }
    let grey = -1, best = 0;
    for (const [v, n] of hist) if (n > best) { best = n; grey = v; }
    /* only a grey that owns a real share of the border: an image cropped to its
       photography (the 3-in ABP crop) has none and is left alone */
    if (grey < 0 || best < border * 0.2) return { grey: null, cleared: 0, alpha: null };
    const TOL = 7, N = w * h, nod = new Uint8Array(N), stack = new Int32Array(N);
    let sp = 0;
    const seed = p => {
      if (nod[p]) return;
      const o = p * 4, r = d[o], gg = d[o + 1], b = d[o + 2];
      if (r - grey > TOL || grey - r > TOL || gg - grey > TOL || grey - gg > TOL || b - grey > TOL || grey - b > TOL) return;
      if (r - gg > 4 || gg - r > 4 || gg - b > 4 || b - gg > 4) return;
      nod[p] = 1; stack[sp++] = p;
    };
    for (let i = 0; i < w; i++) { seed(i); seed((h - 1) * w + i); }
    for (let j = 0; j < h; j++) { seed(j * w); seed(j * w + w - 1); }
    while (sp) {
      const p = stack[--sp], x = p % w;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (p >= w) seed(p - w);
      if (p < N - w) seed(p + w);
    }
    /* one cell of growth: the resample blends the grey into the edge of the
       photograph, and left in, that blend is a grey halo */
    const alpha = new Uint8ClampedArray(N * 4);
    let cleared = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const gone = nod[p] || (x > 0 && nod[p - 1]) || (x < w - 1 && nod[p + 1]) || (y > 0 && nod[p - w]) || (y < h - 1 && nod[p + w]);
      if (gone) cleared++;
      alpha[p * 4 + 3] = gone ? 0 : 255;
    }
    return { grey, cleared: cleared / N, alpha };
  }

  function workerMain() {
    self.onmessage = async ev => {
      const { id, bmp, src } = ev.data;
      try {
        const w = bmp.width, h = bmp.height;
        const c = new OffscreenCanvas(w, h), g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        const d = g.getImageData(0, 0, w, h).data;
        const mp = (0, eval)("(" + src + ")");
        const r = mp(d, w, h);
        if (!r.alpha || !r.cleared) { self.postMessage({ id, grey: r.grey, cleared: r.cleared, w, h, blob: null }); return; }
        g.putImageData(new ImageData(r.alpha, w, h), 0, 0);
        const blob = await c.convertToBlob({ type: "image/png" });
        self.postMessage({ id, grey: r.grey, cleared: r.cleared, w, h, blob });
      } catch (e) { self.postMessage({ id, err: String(e && e.message || e) }); }
    };
  }
  let worker = null, wseq = 0;
  const waiting = new Map();
  function getWorker() {
    if (worker !== null) return worker;
    try {
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") throw 0;
      const url = URL.createObjectURL(new Blob(["(" + workerMain.toString() + ")()"], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = ev => { const f = waiting.get(ev.data.id); if (f) { waiting.delete(ev.data.id); f(ev.data); } };
      worker.onerror = () => { for (const f of waiting.values()) f({ err: "worker" }); waiting.clear(); worker = false; };
    } catch (e) { worker = false; }
    return worker;
  }

  async function maskFor(img, name) {
    const t0 = performance.now();
    if (!img.complete || !img.naturalWidth) {
      try { await img.decode(); } catch (e) { return null; }
    }
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return null;
    const cap = lowMem() ? 1024 : 2048;
    const s = Math.min(1, cap / Math.max(nw, nh));
    const w = Math.max(8, Math.round(nw * s)), h = Math.max(8, Math.round(nh * s));
    let res = null;
    const wk = getWorker();
    if (wk && typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
        const id = ++wseq;
        res = await new Promise(r => { waiting.set(id, r); wk.postMessage({ id, bmp, src: maskPixels.toString() }, [bmp]); });
        if (res.err) res = null;
      } catch (e) { res = null; }
    }
    if (!res) {
      /* the fallback: the same function, here */
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0, w, h);
      let d; try { d = g.getImageData(0, 0, w, h).data; } catch (e) { return null; }
      const r = maskPixels(d, w, h);
      let blob = null;
      if (r.alpha && r.cleared) {
        g.putImageData(new ImageData(r.alpha, w, h), 0, 0);
        blob = await new Promise(rr => c.toBlob(rr, "image/png"));
      }
      res = { grey: r.grey, cleared: r.cleared, w, h, blob, inline: true };
    }
    stats[name] = { ms: Math.round(performance.now() - t0), w, h, grey: res.grey, cleared: +(+res.cleared || 0).toFixed(3),
                    worker: !res.inline };
    return res.blob ? URL.createObjectURL(res.blob) : null;
  }

  function applyTo(el, url) {
    if (!el || !url) return;
    const v = `url("${url}")`;
    el.style.webkitMaskImage = v; el.style.maskImage = v;
    el.style.webkitMaskSize = "100% 100%"; el.style.maskSize = "100% 100%";
    el.style.webkitMaskRepeat = "no-repeat"; el.style.maskRepeat = "no-repeat";
    el.classList.add("masked");
  }

  /* Clean one image overlay. Idempotent, and lazy: a layer that is off is
     cleaned the first time it is shown. */
  function clean(layer, name) {
    if (!layer || !layer.on) return;
    const run = () => {
      const el = layer.getElement && layer.getElement();
      if (!el) return;
      if (!done.has(layer)) {
        done.set(layer, new Promise(res => {
          const go = () => maskFor(el, name).then(res, () => res(null));
          (window.requestIdleCallback || (f => setTimeout(f, 60)))(go, { timeout: 1500 });
        }));
      }
      done.get(layer).then(url => applyTo(layer.getElement(), url));
    };
    layer.on("add", run);
    if (layer._map) run();
  }

  /* Clear Lake, painted as water under the photographs. EA's own polygon; SVG
     in a pane below the rasters that never takes a pointer event. */
  let lake = null;
  function paintLake() {
    const map = SBMM.map;
    if (!map || lake) return;
    const D = window.SBMM_DATA && SBMM_DATA.design_gis;
    let ring = null;
    for (const f of (D && D.features) || []) {
      const p = f.properties || {};
      if (p.layer === "water" && p.name === "Clear Lake" && f.geometry && f.geometry.type === "Polygon") { ring = f.geometry.coordinates[0]; break; }
    }
    if (!ring) return;
    if (!map.getPane("lakefill")) {
      const p = map.createPane("lakefill");
      p.style.zIndex = 250; p.style.pointerEvents = "none";
    }
    lake = L.polygon(ring.map(q => [q[1], q[0]]), { pane: "lakefill", renderer: L.svg({ pane: "lakefill" }),
      stroke: false, fillColor: "#1B3A47", fillOpacity: 1, interactive: false }).addTo(map);
  }

  /* v45 — RELIEF IN THE PHOTOGRAPH. The orthophoto is flat: it was flown at
     midday in January and what relief it has is whatever shadow the trees
     cast. The hillshade knows the shape of the ground exactly. So the two
     hillshades are laid over the photographs a second time, in a pane of their
     own that BLENDS with what is under it (overlay: a slope facing the
     light lifts the photo, a slope facing away deepens it, level ground is
     left very nearly alone) — the cut faces, the benches and the gullies read
     in 2D the way they do in the 3D view.

     It is a picture effect and nothing else: it has its own row (Relief
     shading, on by default), it is only ever drawn while a photograph or an
     analysis raster is on (over a bare hillshade or the plan basemap it would
     be relief on relief), it
     takes no pointer event, and nothing that READS an image — the 3D drape,
     the exports, the 2D basemap-stack test, which looks at the raster pane —
     sees it. */
  let relief = null;
  function anyOrtho() {
    const LS = SBMM.layerState;
    if (!LS || !LS.groupList) return true;
    try {
      const g = LS.groupList().find(x => x.id === "base");
      for (const r of g.layers.values()) if (/^ortho/.test(r.id) && r.on) return true;
    } catch (e) { return true; }
    return false;
  }
  /* v50: the computed rasters take the relief too. Slope, the elevation tint,
     the drainage and accumulation maps, the runoff depth, the TEM slice, the
     isopach — every one of them is a colour scale laid flat over the ground,
     and a flat colour hides the very shape it is about. They all live in the
     `analysis` pane, and the relief pane sits just above it (z 325), so
     whatever is drawn there is shaded by the ground under it. The relief is
     therefore drawn while a photograph OR an analysis raster is on. */
  function analysisImages() {
    const p = SBMM.map && SBMM.map.getPane("analysis");
    return p ? p.querySelectorAll("img").length : 0;
  }
  let gateQueued = false;
  function reliefGate() {
    const el = SBMM.map && SBMM.map.getContainer();
    if (el) el.classList.toggle("noortho", !(anyOrtho() || analysisImages() > 0));
  }
  function reliefGateSoon() {
    if (gateQueued) return;
    gateQueued = true;
    (window.requestAnimationFrame || (f => setTimeout(f, 30)))(() => { gateQueued = false; reliefGate(); });
  }
  function paintRelief() {
    const map = SBMM.map, D = window.SBMM_DATA;
    if (!map || relief || !D) return;
    const srcS = D.hs_site_jpg || D.hs_site_png, srcA = D.hs_abp_jpg || D.hs_abp_png;
    if (!srcS && !srcA) return;                     // a build without the hillshades: no row, nothing drawn
    if (!map.getPane("relief")) {
      const p = map.createPane("relief");
      p.style.zIndex = 325; p.style.pointerEvents = "none";     // above `analysis` (320), below `vectors` (420)
      p.classList.add("reliefpane");
    }
    const parts = [];
    if (srcS && SBMM.demSite) parts.push([L.imageOverlay(srcS, SBMM.demSite.bounds(), { pane: "relief", opacity: 1, zIndex: 1, interactive: false }), "hs_site"]);
    if (srcA && SBMM.demAbp) parts.push([L.imageOverlay(srcA, SBMM.demAbp.bounds(), { pane: "relief", opacity: 1, zIndex: 2, interactive: false }), "hs_abp"]);
    const grp = L.layerGroup(parts.map(q => q[0]));
    /* the row's opacity slider moves the PANE, so the two images stay one picture */
    grp.setOpacity = v => { const p = map.getPane("relief"); if (p) p.style.opacity = String(v); };
    relief = { group: grp, parts };
    const row = SBMM.addLayerRow("base", "Relief shading", grp,
      { id: "relief_shade", checked: true, opacity: 0.65, swatch: "#B9B4A6" });
    if (row && row.row) row.row.title = "The hillshade blended into the orthophoto, so the shape of the ground reads in the photograph. Drawn only while a photograph is on.";
    relief.row = row;
    for (const [ly, name] of parts) clean(ly, name);
    reliefGate();
    if (SBMM.events && SBMM.events.on) SBMM.events.on("layers", reliefGateSoon);
    /* an analysis raster arrives when its job lands, not when its row is ticked */
    map.on("layeradd layerremove", ev => { const l = ev.layer; if (l && l.options && l.options.pane === "analysis") reliefGateSoon(); });
  }
  function setRelief(on) { if (SBMM.layerState) SBMM.layerState.set("base", "relief_shade", { on: !!on }); }
  function reliefState() {
    const map = SBMM.map, p = map && map.getPane("relief");
    return { built: !!relief, on: !!(SBMM.layerState && SBMM.layerState.isOn("base", "relief_shade")),
             images: relief ? relief.parts.filter(q => q[0]._map).length : 0,
             analysis: analysisImages(),
             gated: !!(map && map.getContainer().classList.contains("noortho")),
             blend: p ? getComputedStyle(p).mixBlendMode : null,
             shown: !!(p && getComputedStyle(p).display !== "none") };
  }

  /* v48 — A LINE CAN HAVE A CASING. The map is `preferCanvas`, and Leaflet's
     canvas strokes a path once, in one colour. A line that has to be read over
     a photograph wants a dark edge; the way to give it one used to be a second
     layer under the first (v45's roads). This teaches the canvas renderer the
     option instead: `casing: <px each side>` (and `casingColor`,
     `casingOpacity`) on ANY path — the path is filled, stroked wide and dark,
     then stroked as itself. No second layer, so nothing extra to hit-test,
     pick, snap to, restyle on selection or keep in step while a vertex is
     dragged; a path without the option goes through Leaflet's own routine
     untouched.
     Leaflet pads a path's redraw rectangle by its weight + 1 px, so a casing
     of up to weight/2 + 1 is inside it; wider would leave a ghost when a
     neighbour repaints.

     THE HIERARCHY the casing is used for (the same idea as the 3D widths):
       your own drawings, the decision units, the limits of excavation,
       the storm network, the survey          — cased, at full weight
       EA's design lines, the piles            — cased, lighter
       lots, parcels, operable units, site areas — thin, uncased, faint fill
     so the first thing the eye lands on is the thing the map is about. */
  (function casedCanvas() {
    if (!window.L || !L.Canvas || L.Canvas.prototype._sbmmCased) return;
    const F0 = L.Canvas.prototype._fillStroke;
    L.Canvas.include({
      _sbmmCased: true,
      _fillStroke(ctx, layer) {
        const o = layer.options;
        if (!(o.casing > 0) || !o.stroke || o.weight === 0) return F0.call(this, ctx, layer);
        if (o.fill) { ctx.globalAlpha = o.fillOpacity; ctx.fillStyle = o.fillColor || o.color; ctx.fill(o.fillRule || "evenodd"); }
        if (ctx.setLineDash) ctx.setLineDash([]);
        ctx.globalAlpha = o.casingOpacity == null ? 0.55 : o.casingOpacity;
        ctx.lineWidth = o.weight + 2 * o.casing;
        ctx.strokeStyle = o.casingColor || "#0A0F12";
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash(o._dashArray || []);
        ctx.globalAlpha = o.opacity; ctx.lineWidth = o.weight; ctx.strokeStyle = o.color;
        ctx.lineCap = o.lineCap; ctx.lineJoin = o.lineJoin;
        ctx.stroke();
      }
    });
  })();

  /* Density by zoom (§10): a point layer drawn at full size over the whole
     site is a carpet — 140 samples in a few hundred screen pixels. Below
     zoom -1 each circle marker in a registered group is drawn smaller, in
     proportion, down to 55 % and never under 2.5 px; at zoom -1 and above it is
     exactly the radius its builder gave it. Only the RADIUS moves: nothing is
     hidden, so no point stops being clickable or listed. The builder's own
     radius is kept on the marker (`_r0`), so a rebuild is always the truth. */
  const dense = new Set();
  function kAt(z) { return z >= -1 ? 1 : Math.max(0.55, 1 - 0.15 * (-1 - z)); }
  function sizeGroup(g, k) {
    if (!g || !g.eachLayer) return;
    g.eachLayer(m => {
      if (!m.setRadius || m.options == null) return;
      if (m._r0 == null) m._r0 = m.options.radius;
      const r = Math.max(2.5, m._r0 * k);
      if (Math.abs(r - m.options.radius) > 0.05) m.setRadius(r);
    });
  }
  /* register a group, or re-size it after its builder refilled it */
  function densify(g) {
    if (!g) return;
    dense.add(g);
    if (SBMM.map) sizeGroup(g, kAt(SBMM.map.getZoom()));
  }
  function wireDensity() {
    if (!SBMM.map) return;
    SBMM.map.on("zoomend", () => { const k = kAt(SBMM.map.getZoom()); for (const g of dense) sizeGroup(g, k); });
  }

  function wire() {
    wireDensity();
    const Ls = SBMM.layers || {};
    clean(Ls.orthoSite, "ortho_site");
    clean(Ls.orthoMine, "ortho_mine");
    clean(Ls.orthoAbp, "ortho_abp");
    clean(Ls.hsSite, "hs_site");
    clean(Ls.hsAbp, "hs_abp");
    paintLake();
    paintRelief();
  }

  return { wire, densify, densityAt: kAt, stats: () => JSON.parse(JSON.stringify(stats)), maskFor, maskPixels,
           setRelief, relief: reliefState };
})();
