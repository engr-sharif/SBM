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
  }

  return { wire, densify, densityAt: kAt, stats: () => JSON.parse(JSON.stringify(stats)), maskFor, maskPixels };
})();
