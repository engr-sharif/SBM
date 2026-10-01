/* SBMM Site Explorer — the world beyond the survey (v32).

   The surveyed ground ends, and until now the map simply stopped there: the
   site sat on a flat near-black field in 2D and on a flat lake-coloured plane
   in 3D. This paints what lies beyond as a quiet "digital terrain" — a deep
   gradient centred on the site, the State Plane survey grid with a crosshair at
   every major intersection, a procedural contour field that NESTS across zoom
   levels (each step in halves the interval, so the lines at one zoom are a
   subset of the next), and a soft glow along the edge of the surveyed ground.

   It is decoration and says so in the code: nothing here is data, nothing is
   pickable, nothing is exported, and the contours are a seeded noise field —
   NEVER the terrain. Inside the survey footprint the grid and the contours are
   cut away (`destination-out` through a mask of the 2-ft DEM's valid cells),
   so in the Plan basemap the real contours are never crossed by invented ones.

   ONE painter, two hosts:
     2D  a canvas in its own pane ("backdrop", z 150 — under the lake fill at
         250 and the rasters at 260), wrapped in a <div> so js/map.js's canvas
         pass-through (".leaflet-pane > canvas") never sees it and js/pick2d.js
         (which walks map._paneRenderers) never sees it either; redrawn on
         moveend, scaled through Leaflet's own zoom animation in between.
     3D  SBMM.backdrop.texture(THREE, opts) — the same painter into a canvas
         texture for js/viewer3d.js's ground plane, built once.

   No frame is ever requested: the 2D host paints on Leaflet's own events and
   the 3D texture is built inside buildEnv(). Block 9e's idle contract holds. */
"use strict";

SBMM.backdrop = (function () {
  /* ---------- a seeded value-noise field, in State Plane feet ------------- */
  function hash(ix, iy) {
    let h = (ix * 374761393 + iy * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy - 0.5;
  }
  /* octaves from 12,000 ft down to 16 ft, each with the same SLOPE (amplitude
     proportional to wavelength), so the contour spacing on screen is the same
     at every zoom; an octave finer than the sampling is faded out rather than
     aliased into wiggles */
  const OCT = [];
  for (let lam = 12000, k = 0; lam >= 16; lam /= 2, k++)
    OCT.push({ lam, amp: lam * 0.09, ox: hash(k, 7) * 1000, oy: hash(k, 11) * 1000 });
  function field(x, y, minLam) {
    let h = 0;
    for (let k = 0; k < OCT.length; k++) {
      const o = OCT[k];
      if (o.lam < minLam * 0.5) break;
      const w = o.lam >= minLam ? 1 : (o.lam - minLam * 0.5) / (minLam * 0.5);
      h += w * o.amp * vnoise(x / o.lam + o.ox, y / o.lam + o.oy);
    }
    return h;
  }

  /* ---------- the survey footprint ---------------------------------------- */
  let mask = null;      // {cv, x0, y0, x1, y1} — alpha = surveyed ground, north up
  function surveyMask() {
    if (mask) return mask;
    const D = SBMM.demSite;
    if (!D || !D.z || !D.m) return null;      // not decoded yet: ask again later
    const m = D.m, S = 8, w = Math.ceil(m.w / S), h = Math.ceil(m.h / S);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d"), img = c.createImageData(w, h), px = img.data;
    for (let r = 0; r < h; r++) {
      const j = Math.min(m.h - 1, (h - 1 - r) * S + (S >> 1));   // row 0 = north
      for (let q = 0; q < w; q++) {
        const i = Math.min(m.w - 1, q * S + (S >> 1));
        if (!isNaN(D.z[j * m.w + i])) px[(r * w + q) * 4 + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    /* a soft copy for the edge glow: downscale and back up is a blur every
       browser has (ctx.filter is not on iOS Safari) */
    const t = document.createElement("canvas");
    t.width = Math.max(1, w >> 3); t.height = Math.max(1, h >> 3);
    const tc = t.getContext("2d");
    tc.imageSmoothingEnabled = true;
    tc.drawImage(cv, 0, 0, t.width, t.height);
    const glow = document.createElement("canvas");
    glow.width = w; glow.height = h;
    const gc = glow.getContext("2d");
    gc.imageSmoothingEnabled = true;
    gc.drawImage(t, 0, 0, w, h);
    gc.globalCompositeOperation = "source-in";
    gc.fillStyle = "#3FA9C0";
    gc.fillRect(0, 0, w, h);
    mask = { cv, glow, x0: m.x0, y0: m.y0, x1: m.x0 + m.w * m.cell, y1: m.y0 + m.h * m.cell };
    return mask;
  }

  const BASE_IN = "#10222B", BASE_OUT = "#070C0F";
  const GRIDS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000];

  /* Paint the world into `c` (W x H device px). The canvas's top-left is State
     Plane (x0, yTop); one device px is `ft` feet. `zoomStep` is the integer the
     contour interval nests on. */
  function paint(c, W, H, x0, yTop, ft, o) {
    o = o || {};
    const X = x => (x - x0) / ft, Y = y => (yTop - y) / ft;
    const M = o.mask === false ? null : surveyMask();
    c.save();
    c.clearRect(0, 0, W, H);

    /* 1. the survey grid: the finest spacing at least ~90 px apart */
    const gpx = o.gridPx || 90;
    let gs = GRIDS[GRIDS.length - 1];
    for (const g of GRIDS) if (g / ft >= gpx) { gs = g; break; }
    const xa = Math.floor(x0 / gs) * gs, xb = x0 + W * ft, yb = yTop - H * ft, ya = Math.ceil(yTop / gs) * gs;
    c.lineWidth = Math.max(1, (o.dpr || 1) * 0.8);
    c.strokeStyle = "rgba(130,185,200,0.055)";
    c.beginPath();
    for (let x = xa; x <= xb; x += gs) { const p = Math.round(X(x)) + 0.5; c.moveTo(p, 0); c.lineTo(p, H); }
    for (let y = ya; y >= yb; y -= gs) { const p = Math.round(Y(y)) + 0.5; c.moveTo(0, p); c.lineTo(W, p); }
    c.stroke();
    /* a crosshair at every second intersection */
    const big = gs * 2, tk = 4 * (o.dpr || 1);
    c.strokeStyle = "rgba(150,205,220,0.26)";
    c.beginPath();
    for (let x = Math.floor(x0 / big) * big; x <= xb; x += big)
      for (let y = Math.ceil(yTop / big) * big; y >= yb; y -= big) {
        const px = Math.round(X(x)) + 0.5, py = Math.round(Y(y)) + 0.5;
        c.moveTo(px - tk, py); c.lineTo(px + tk, py);
        c.moveTo(px, py - tk); c.lineTo(px, py + tk);
      }
    c.stroke();

    /* 2. the contour field — marching squares on a coarse sampling grid */
    const cell = (o.cellPx || 8) * (o.dpr || 1);
    const nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1;
    const cft = cell * ft, minLam = cft * 2.5;
    const v = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = yTop - j * cft;
      for (let i = 0; i < nx; i++) v[j * nx + i] = field(x0 + i * cft, y, minLam);
    }
    const I = (o.interval || 4) * Math.pow(2, -(o.zoomStep || 0)) * (o.intervalFt || 1);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < v.length; k++) { if (v[k] < lo) lo = v[k]; if (v[k] > hi) hi = v[k]; }
    const minor = new Path2D(), major = new Path2D();
    const k0 = Math.ceil(lo / I), k1 = Math.floor(hi / I);
    if (k1 - k0 < 400) {
      /* per cell, only the levels that actually cross it */
      for (let j = 0; j < ny - 1; j++)
        for (let i = 0; i < nx - 1; i++) {
          const a = v[j * nx + i], b = v[j * nx + i + 1], d = v[(j + 1) * nx + i], e = v[(j + 1) * nx + i + 1];
          const mn = Math.min(a, b, d, e), mx = Math.max(a, b, d, e);
          const ka = Math.ceil(mn / I), kb = Math.floor(mx / I);
          if (kb < ka) continue;
          const px = i * cell, py = j * cell;
          for (let kk = ka; kk <= kb; kk++) {
            const L0 = kk * I + 1e-6, P = (kk % 4 === 0) ? major : minor;
            const s = (a > L0 ? 1 : 0) | (b > L0 ? 2 : 0) | (e > L0 ? 4 : 0) | (d > L0 ? 8 : 0);
            if (s === 0 || s === 15) continue;
            const tx = px + cell * (L0 - a) / (b - a), ry = py + cell * (L0 - b) / (e - b);
            const bx = px + cell * (L0 - d) / (e - d), ly = py + cell * (L0 - a) / (d - a);
            switch (s) {
              case 1: case 14: P.moveTo(px, ly); P.lineTo(tx, py); break;
              case 2: case 13: P.moveTo(tx, py); P.lineTo(px + cell, ry); break;
              case 3: case 12: P.moveTo(px, ly); P.lineTo(px + cell, ry); break;
              case 4: case 11: P.moveTo(px + cell, ry); P.lineTo(bx, py + cell); break;
              case 6: case 9: P.moveTo(tx, py); P.lineTo(bx, py + cell); break;
              case 7: case 8: P.moveTo(px, ly); P.lineTo(bx, py + cell); break;
              case 5: P.moveTo(px, ly); P.lineTo(tx, py); P.moveTo(px + cell, ry); P.lineTo(bx, py + cell); break;
              case 10: P.moveTo(tx, py); P.lineTo(px + cell, ry); P.moveTo(px, ly); P.lineTo(bx, py + cell); break;
            }
          }
        }
      c.lineWidth = Math.max(1, (o.dpr || 1) * 0.9);
      c.strokeStyle = "rgba(95,170,190,0.13)";
      c.stroke(minor);
      c.lineWidth = Math.max(1, (o.dpr || 1) * 1.2);
      c.strokeStyle = "rgba(110,195,215,0.26)";
      c.stroke(major);
    }

    /* 3. the edge of the surveyed ground: a glow outside it, and everything
       drawn so far cut away inside it */
    if (M) {
      const mx = X(M.x0), my = Y(M.y1), mw = (M.x1 - M.x0) / ft, mh = (M.y1 - M.y0) / ft;
      c.imageSmoothingEnabled = true;
      c.globalAlpha = 0.42;
      c.globalCompositeOperation = "lighter";
      c.drawImage(M.glow, mx, my, mw, mh);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "destination-out";
      c.drawImage(M.cv, mx, my, mw, mh);
    }

    /* 4. the ground under it all, behind what is already there */
    c.globalCompositeOperation = "destination-over";
    const cx = M ? X((M.x0 + M.x1) / 2) : W / 2, cy = M ? Y((M.y0 + M.y1) / 2) : H / 2;
    const R = M ? Math.max((M.x1 - M.x0), (M.y1 - M.y0)) * 1.6 / ft : Math.max(W, H);
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, R));
    g.addColorStop(0, BASE_IN);
    g.addColorStop(0.45, "#0C181E");
    g.addColorStop(1, BASE_OUT);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.restore();
  }

  /* ---------- the 2D host ------------------------------------------------- */
  let map = null, wrap = null, cv = null, ctx = null, llb = null, enabled = true, raf = 0;
  const stats = { paints: 0, lastMs: 0 };
  const PAD = 0.3;

  function wire(m) {
    map = m;
    if (!map.getPane("backdrop")) {
      const p = map.createPane("backdrop");
      p.style.zIndex = 150;
      p.style.pointerEvents = "none";
    }
    wrap = L.DomUtil.create("div", "sbmm-backdrop leaflet-zoom-animated", map.getPane("backdrop"));
    wrap.style.pointerEvents = "none";
    cv = document.createElement("canvas");
    cv.style.display = "block";
    wrap.appendChild(cv);
    ctx = cv.getContext("2d");
    map.on("moveend zoomend resize viewreset", schedule);
    map.on("zoomanim", onAnim);
    if (SBMM.view && SBMM.view.pref && SBMM.view.pref("backdrop") === false) enabled = false;
    /* the survey mask needs the decoded site DEM: paint once more at boot */
    if (SBMM.events) SBMM.events.on("boot", schedule);
    schedule();
  }
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; repaint(); });
  }
  function repaint() {
    if (!map || !cv) return;
    if (!enabled) { cv.width = cv.height = 0; return; }
    const t0 = performance.now();
    const sz = map.getSize(), pw = Math.round(sz.x * PAD), ph = Math.round(sz.y * PAD);
    const tl = map.containerPointToLayerPoint([-pw, -ph]);
    const W = sz.x + 2 * pw, H = sz.y + 2 * ph;
    const touch = document.body.classList.contains("touch") || document.body.classList.contains("field");
    const dpr = Math.min(window.devicePixelRatio || 1, touch ? 1.5 : 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    L.DomUtil.setPosition(wrap, tl);
    const nw = map.layerPointToLatLng(tl), se = map.layerPointToLatLng(tl.add([W, H]));
    llb = L.latLngBounds(nw, se);
    const z = map.getZoom(), ft = 1 / map.options.crs.scale(z) / dpr;
    paint(ctx, cv.width, cv.height, nw.lng, nw.lat, ft,
          { dpr, zoomStep: Math.round(z), cellPx: touch ? 10 : 8 });
    stats.paints++;
    stats.lastMs = +(performance.now() - t0).toFixed(1);
  }
  /* Leaflet's own ImageOverlay zoom animation: scale the painted canvas while
     the map animates, repaint once it lands */
  function onAnim(e) {
    if (!llb || !wrap) return;
    const scale = map.getZoomScale(e.zoom), off = map._latLngBoundsToNewLayerBounds(llb, e.zoom, e.center).min;
    L.DomUtil.setTransform(wrap, off, scale);
  }
  function setEnabled(on) {
    enabled = !!on;
    if (SBMM.view && SBMM.view.pref) SBMM.view.pref("backdrop", enabled);
    repaint();
  }

  /* ---------- the 3D host ------------------------------------------------- */
  /* A canvas texture of the same world over `spanFt` feet centred on the site,
     north up; js/viewer3d.js maps it onto the ground plane. */
  function texture(THREE, o) {
    o = o || {};
    const M = surveyMask();
    const px = o.px || 2048, span = o.spanFt || 48000;
    const cx = M ? (M.x0 + M.x1) / 2 : 0, cy = M ? (M.y0 + M.y1) / 2 : 0;
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const ft = span / px;
    paint(c.getContext("2d"), px, px, cx - span / 2, cy + span / 2, ft,
          { dpr: 1, zoomStep: 0, intervalFt: ft, gridPx: 40, cellPx: 6, mask: o.mask });
    /* fade the square's edge into the plain ground so the plane beyond it does
       not end in a line */
    const g = c.getContext("2d"), rg = g.createRadialGradient(px / 2, px / 2, px * 0.30, px / 2, px / 2, px * 0.5);
    rg.addColorStop(0, "rgba(7,12,15,0)");
    rg.addColorStop(1, "rgba(7,12,15,1)");
    g.fillStyle = rg;
    g.fillRect(0, 0, px, px);
    const tex = new THREE.CanvasTexture(c);
    if ("colorSpace" in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return { tex, cx, cy, span, base: BASE_OUT };
  }

  return {
    wire, repaint, setEnabled, enabled: () => enabled, texture, field,
    stats: () => Object.assign({ enabled, pane: !!(map && map.getPane("backdrop")),
                                 canvas: cv ? [cv.width, cv.height] : null, mask: !!surveyMask() }, stats)
  };
})();
