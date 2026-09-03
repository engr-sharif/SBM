/* SBMM Site Explorer — individual tree detection and inventory (phase 4).

   Detection itself is the "trees" kernel in js/compute.js: variable-window local
   maxima on the cleaned canopy height model, then a marker-based region grow that
   cuts at saddles and at 0.3 x apex height. This file is the part that has to stay
   out of the way — running it once on demand, caching the result, drawing it, and
   getting it back out as a CSV a forester or a clearing contractor can use.

   RENDERING. There are thousands of trees over the mine-area window and the design
   has to survive ten times that, so:

     • no DOM per tree. Leaflet markers would mean one <div> each; 4,000 of them
       makes panning visibly stutter and 40,000 makes the tab unusable. Everything
       is painted on ONE 2D canvas stretched over the map, the same technique the
       object-snap overlay uses.
     • no per-tree state changes. Trees are pre-bucketed by height into the colour
       ramp's steps ONCE, at detection time; painting then walks bucket by bucket,
       setting fillStyle once per bucket and issuing fillRect per tree. fillRect
       beats arc() by a wide margin at this count.
     • no per-frame allocation. The visible-set test is an inline bounds compare
       over the typed arrays, not a filter() that builds an array every frame.
     • repaint is rAF-throttled, so a pan that fires forty move events repaints at
       most once per frame.

   Hit-testing a click is a linear scan over typed arrays — a few thousand distance
   compares is nothing next to the click latency, and it avoids a spatial index that
   would have to be kept in step with nothing at all. */
"use strict";

SBMM.trees = (function () {

  /* detection cache — regenerated on demand, never serialised into a session
     (it is derived from a raster that ships with the build, so storing it would
     only be a way to go stale) */
  let data = null;              // { x, y, h, area, radius, n, buckets, ... }
  let running = null;
  let layer = null, rowRef = null;
  let cv = null, ctx = null, cw = 0, ch = 0, needSize = true, rafQ = false;
  let minShow = 6;

  const RAMP = RAMPS.canopy;
  const NB = 10;                                   // colour buckets
  /* Ramp domain. The tallest tree on site is 84 ft, but the median is 19 and p95 is
     48, so stretching the ramp to 90 spent most of its range on heights that barely
     occur and left the whole canopy reading as one pale green. Clamping at 60 puts
     the gradient where the trees are; the handful of giants sit at the top colour. */
  const H_LO = 6, H_HI = 60;                       // ramp domain, ft

  function bucketOf(hv) {
    return clamp(Math.floor((hv - H_LO) / (H_HI - H_LO) * NB), 0, NB - 1);
  }
  function bucketColor(b) {
    const c = lerpRamp(RAMP, (b + 0.5) / NB);
    return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  }

  /* ------------------------------------------------------------------ */
  /* detection                                                           */
  /* ------------------------------------------------------------------ */
  function ready() { return !!data; }
  function stats() {
    return data ? { n: data.n, maxima: data.maxima, dropped: data.dropped, ms: data.ms,
                    minH: data.minH } : null;
  }

  async function detect(opts) {
    opts = opts || {};
    if (running) return running;
    if (data && !opts.force) return data;
    const chm = SBMM.chm;
    if (!chm) throw new Error("this build has no canopy height model");
    const minH = opts.minH == null ? 6 : opts.minH;
    const grid = SBMM.compute.gridSpec(chm);
    const t0 = performance.now();
    running = (async () => {
      const R = await SBMM.compute.run("trees",
        { grid, minH, minCrown: 4 },
        { transfer: [grid.z.buffer], label: "Detecting trees — canopy maxima" }).promise;
      /* pre-bucket by height once, so painting never branches per tree */
      const buckets = [];
      for (let b = 0; b < NB; b++) buckets.push([]);
      for (let i = 0; i < R.n; i++) buckets[bucketOf(R.h[i])].push(i);
      data = { x: R.x, y: R.y, h: R.h, area: R.area, radius: R.radius, n: R.n,
               maxima: R.maxima, dropped: R.dropped, minH: R.minH,
               buckets: buckets.map(b => Int32Array.from(b)),
               ms: Math.round(performance.now() - t0) };
      return data;
    })();
    try { return await running; } finally { running = null; }
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
    const zoom = map.getZoom();
    const size = clamp(Math.round(Math.pow(2, zoom) * 2.6), 3, 9);   // dot size in px
    const half = size / 2;
    let drawn = 0;
    const X = data.x, Y = data.y, H = data.h;

    /* Backing pass. The low end of the canopy ramp is nearly white, and a pale dot
       on sunlit bare ground is invisible — which is exactly where a short tree in a
       clearing needs to be seen. One dark rect under every dot fixes it for the cost
       of a single extra fillStyle change, rather than a per-dot stroke. */
    if (size >= 3) {
      ctx.fillStyle = "rgba(8,14,18,.75)";
      for (let bkt = 0; bkt < NB; bkt++) {
        const idx = data.buckets[bkt];
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k];
          if (H[i] < minShow) continue;
          const x = X[i], y = Y[i];
          if (x < w0 || x > e0 || y < s0 || y > n0) continue;
          ctx.fillRect(p0.x + (x - w0) * sx - half - 1, p0.y + (y - s0) * sy - half - 1, size + 2, size + 2);
        }
      }
    }
    for (let bkt = 0; bkt < NB; bkt++) {
      const idx = data.buckets[bkt];
      if (!idx.length) continue;
      ctx.fillStyle = bucketColor(bkt);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (H[i] < minShow) continue;
        const x = X[i], y = Y[i];
        if (x < w0 || x > e0 || y < s0 || y > n0) continue;
        ctx.fillRect(p0.x + (x - w0) * sx - half, p0.y + (y - s0) * sy - half, size, size);
        drawn++;
      }
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
        SBMM.map.on("click", onMapClick);
        repaint();
      },
      onRemove() {
        SBMM.map.off("move zoom moveend zoomend resize", repaint);
        window.removeEventListener("resize", onWinResize);
        SBMM.map.off("click", onMapClick);
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
  function nearest(x, y, maxFt) {
    if (!data) return -1;
    let best = -1, bd = maxFt * maxFt;
    const X = data.x, Y = data.y;
    for (let i = 0; i < data.n; i++) {
      if (data.h[i] < minShow) continue;
      const dx = X[i] - x, dy = Y[i] - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function onMapClick(ev) {
    if (SBMM.tools.active() || SBMM.draw.isPicking() || SBMM.draw.isDrawing()) return;
    const x = ev.latlng.lng, y = ev.latlng.lat;
    const tolFt = 14 / Math.pow(2, SBMM.map.getZoom());
    const i = nearest(x, y, Math.max(tolFt, 6));
    if (i < 0) return;
    const [lo, la] = SBMM.toLL(data.x[i], data.y[i]);
    const [gz] = SBMM.elev(data.x[i], data.y[i]);
    L.popup({ className: "treepop" })
      .setLatLng([data.y[i], data.x[i]])
      .setContent(
        `<b>Tree #${i + 1}</b><br>` +
        `height <b>${fmt(data.h[i], 1)} ft</b><br>` +
        `crown ${fmt0(data.area[i])} ft² · r ${fmt(data.radius[i], 1)} ft<br>` +
        `<span class="mono">${fmt0(data.x[i])} E · ${fmt0(data.y[i])} N</span><br>` +
        `<span class="mono">${la.toFixed(6)}, ${lo.toFixed(6)}</span><br>` +
        `<span class="mono">ground ${isNaN(gz) ? "—" : fmt(gz, 1) + " ft"} · top ${isNaN(gz) ? "—" : fmt(gz + data.h[i], 1) + " ft"}</span>`)
      .openOn(SBMM.map);
  }

  /* ------------------------------------------------------------------ */
  /* legend + layer row                                                  */
  /* ------------------------------------------------------------------ */
  let legendEl = null;
  function updateLegend(drawn) {
    if (!legendEl) return;
    const on = layer && SBMM.map.hasLayer(layer);
    legendEl.querySelector(".tcount").textContent = !data ? "not run yet"
      : (on ? fmt0(drawn) + " shown of " + fmt0(data.n) : fmt0(data.n) + " detected");
  }

  function buildLayerRow() {
    if (!SBMM.chm) return;
    layer = makeLayer();
    /* Detection is the first-show cost, so it goes through addLayerRow's own
       onFirstShow hook rather than overriding cb.onchange — since v9 the
       checkbox only reports to SBMM.layerState, and replacing its handler would
       have cut this row out of the one layer state entirely. */
    rowRef = SBMM.addLayerRow("ana", "Trees (detected)", layer, {
      id: "trees_detected", checked: false, swatch: "#7FD37F",
      onFirstShow: async () => {
        if (data) return;
        await detect();
        toast(fmt0(data.n) + " trees detected in " + (data.ms / 1000).toFixed(1) + " s");
      },
      onChange: st => { if (st.on && data) repaint(); }
    });

    legendEl = document.createElement("div");
    legendEl.className = "legend";
    legendEl.innerHTML =
      `<span class="rampbar" style="background:linear-gradient(90deg,${RAMP.map(c => `rgb(${c.join(",")})`).join(",")})"></span>` +
      `<span class="mono">${H_LO} → ${H_HI}+ ft</span> · <span class="mono tcount">not run yet</span>` +
      `<div class="genrow" style="margin-top:5px">` +
      `<span class="minib" id="treeGo">detect</span>` +
      `<span class="minib" id="treeCsv">CSV</span>` +
      `min <input type="number" id="treeMin" value="6" min="1" step="1" style="width:46px"> ft</div>`;
    $("anaLayers").appendChild(legendEl);
    legendEl.querySelector("#treeGo").onclick = () => cmdTrees();
    legendEl.querySelector("#treeCsv").onclick = () => exportCsv();
    legendEl.querySelector("#treeMin").onchange = e => {
      minShow = parseFloat(e.target.value) || 6;
      repaint();
    };
  }

  /* ------------------------------------------------------------------ */
  /* commands + export                                                   */
  /* ------------------------------------------------------------------ */
  async function cmdTrees(arg) {
    if (!SBMM.chm && SBMM.chmReady) { toast("waiting for the canopy height model…"); await SBMM.chmReady; }
    if (!SBMM.chm) { toast("this build has no canopy height model"); return; }
    const minH = arg ? parseFloat(arg) : 6;
    const force = data && Math.abs((data.minH || 6) - (isNaN(minH) ? 6 : minH)) > 1e-6;
    toast("detecting trees over the whole canopy window…");
    try {
      await detect({ minH: isNaN(minH) ? 6 : minH, force });
    } catch (e) {
      if (!(e && e.cancelled)) toast("tree detection failed: " + e.message);
      return;
    }
    minShow = data.minH;
    const mi = document.getElementById("treeMin"); if (mi) mi.value = data.minH;
    if (rowRef) SBMM.layerState.set("base", "trees_detected", { on: true });
    repaint();
    const hs = Array.from(data.h).sort((a, b) => a - b);
    const card = SBMM.results.card(null, "Tree inventory", [
      ["Trees", fmt0(data.n)],
      ["Median height", fmt(hs[Math.floor(hs.length / 2)], 1) + " ft"],
      ["Tallest", fmt(hs[hs.length - 1], 1) + " ft"],
      ["Median crown", fmt0(data.area[Math.floor(data.n / 2)]) + " ft² "],
      ["Detection", (data.ms / 1000).toFixed(1) + " s · " + fmt0(data.maxima) + " maxima"]
    ]);
    SBMM.results.appendNote(card,
      "Variable-window local maxima on the cleaned canopy height model (window radius = " +
      "max(4 ft, 0.35 × height), the usual allometric rule), then a marker-based region " +
      "grow cut at saddles and below 0.3 × apex height. Heights are canopy height above " +
      "bare earth, over the mine-area window only. Individual-tree detection from a 1-ft " +
      "CHM is reliable for dominant, well-separated crowns and merges or misses suppressed " +
      "understorey — treat the count as a canopy inventory, not a stem count.");
    const row = document.createElement("div"); row.className = "volctl";
    row.innerHTML = `<div class="crow btns"><button class="minib">export inventory CSV</button></div>`;
    row.querySelector("button").onclick = () => exportCsv();
    card.appendChild(row);
  }

  function exportCsv() {
    if (!data) { toast("run tree detection first"); return; }
    const L2 = ["id,easting_ft,northing_ft,latitude,longitude,height_ft,crown_area_ft2,crown_radius_ft,ground_elev_ft,top_elev_ft"];
    for (let i = 0; i < data.n; i++) {
      const x = data.x[i], y = data.y[i];
      const [lo, la] = SBMM.toLL(x, y);
      const [gz] = SBMM.elev(x, y);
      L2.push([i + 1, x.toFixed(2), y.toFixed(2), la.toFixed(7), lo.toFixed(7),
               data.h[i].toFixed(1), data.area[i].toFixed(0), data.radius[i].toFixed(1),
               isNaN(gz) ? "" : gz.toFixed(2), isNaN(gz) ? "" : (gz + data.h[i]).toFixed(2)].join(","));
    }
    download("SBMM_tree_inventory.csv", new Blob([L2.join("\n")], { type: "text/csv" }));
    toast("exported " + fmt0(data.n) + " trees");
  }

  function wire() { buildLayerRow(); }

  return { detect, ready, stats, cmdTrees, exportCsv, wire, repaint,
           get data() { return data; } };
})();
