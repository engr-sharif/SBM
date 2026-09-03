/* SBMM Site Explorer — computed terrain layers: slope, aspect, elevation tint,
   custom-interval contours (marching squares). All derived client-side from the DEMs.

   The pixel loops and the marching-squares pass live in js/compute.js and run in a
   Web Worker; this file only packs the job, paints the returned RGBA into a canvas,
   and wires the Leaflet layers. */
"use strict";

SBMM.analysis = (function () {

  /* human-readable job names for the status-bar progress row */
  const KIND_NAME = { slope: "Slope", aspect: "Aspect", hypso: "Elevation tint", canopy: "Canopy height" };

  /* Render a per-node colormap of a DEM to a canvas data-URL image overlay.
     `spec` is a plain description the worker understands — no closures cross the wire.
       { kind:"slope"|"aspect"|"hypso"|"canopy", ramp:[[r,g,b]…], zlo, zhi, nanColor }
     stride>1 downsamples (used for the big site DEM — visually identical, much faster) */
  async function demRaster(dem, spec, alpha = 200, stride = 1, label) {
    const grid = SBMM.compute.gridSpec(dem);
    const job = {
      grid, stride, alpha, kind: spec.kind,
      ramp: spec.ramp || null, zlo: spec.zlo || 0, zhi: spec.zhi || 1,
      nanColor: spec.nanColor || null
    };
    const R = await SBMM.compute.run("raster", job, {
      transfer: [grid.z.buffer],
      label: label || ((KIND_NAME[spec.kind] || spec.kind) + " raster")
    }).promise;
    const c = document.createElement("canvas"); c.width = R.W; c.height = R.H;
    c.getContext("2d").putImageData(new ImageData(R.rgba, R.W, R.H), 0, 0);
    return c.toDataURL("image/png");
  }

  function specFor(kind, dem) {
    if (kind === "slope") return { kind: "slope", ramp: RAMPS.slope };
    if (kind === "aspect") return { kind: "aspect" };
    const zr = dem === SBMM.demSite ? SBMM._zrSite : SBMM._zrAbp;
    return { kind: "hypso", ramp: RAMPS.hypso, zlo: zr[0], zhi: zr[1] };
  }

  async function buildComposite(kind) {
    const mk = dem => demRaster(dem, specFor(kind, dem), 200,
      dem === SBMM.demSite ? 2 : 1,
      `${KIND_NAME[kind] || kind} — ${dem === SBMM.demSite ? "site" : "mine area"}`);
    const urlS = await mk(SBMM.demSite);
    const urlA = await mk(SBMM.demAbp);
    return L.layerGroup([
      L.imageOverlay(urlS, SBMM.demSite.bounds(), { pane: "analysis", opacity: .75 }),
      L.imageOverlay(urlA, SBMM.demAbp.bounds(), { pane: "analysis", opacity: .75 })
    ]);
  }

  /* ---------- marching squares contours (worker) ---------- */
  async function contoursFromDem(dem, interval, stride, label) {
    const grid = SBMM.compute.gridSpec(dem);
    const R = await SBMM.compute.run("contours",
      { grid, interval, stride, maxPts: 500000 },
      { transfer: [grid.z.buffer], label: label || `Contours ${interval} ft` }).promise;
    const lines = [];
    for (let k = 0; k < R.levels.length; k++) {
      const a = R.offsets[k], b = R.offsets[k + 1], pts = new Array(b - a);
      for (let q = a; q < b; q++) pts[q - a] = [R.coords[q * 2], R.coords[q * 2 + 1]];
      lines.push([R.levels[k], pts]);
    }
    return { lines, truncated: R.truncated };
  }

  let customGrp = null, customRow = null;
  async function makeCustomContours(interval) {
    if (!(interval > 0.24)) { toast("interval must be ≥ 0.25 ft"); return; }
    if (customGrp) { SBMM.map.removeLayer(customGrp); if (customRow) customRow.remove(); customGrp = null; }
    toast(`generating ${interval}-ft contours…`);
    await new Promise(r => setTimeout(r, 30));
    const grp = L.layerGroup();
    const heavyEvery = interval * 5;
    const addSet = (res, color) => {
      for (const [lv, pts] of res.lines) {
        const heavy = Math.abs(lv / heavyEvery - Math.round(lv / heavyEvery)) < 1e-6;
        L.polyline(pts.map(p => [p[1], p[0]]), { pane: "vectors", color, weight: heavy ? 1.6 : .8, opacity: heavy ? .9 : .55 })
          .bindTooltip(`${lv} ft`, { sticky: true, className: "ctip" }).addTo(grp);
      }
      return res.truncated;
    };
    // mine-area window at fine stride; rest of site coarser (cap cells so big intervals stay quick)
    const trA = addSet(await contoursFromDem(SBMM.demAbp, interval,
      Math.max(1, Math.round(interval / SBMM.demAbp.m.cell)), `Contours ${interval} ft — mine area`), "#D9A44F");
    const mS = SBMM.demSite.m;
    const strideS = Math.max(Math.max(1, Math.round(interval / mS.cell)), Math.ceil(Math.sqrt(mS.w * mS.h / 1.5e6)));
    const trS = interval >= 2
      ? addSet(await contoursFromDem(SBMM.demSite, interval, strideS, `Contours ${interval} ft — site`), "#B08A45")
      : false;
    customGrp = grp;
    const rowRef = SBMM.addLayerRow("ana", `Contours — ${interval} ft (computed)`, grp, { checked: true, swatch: "#D9A44F" });
    customRow = rowRef.row;
    if (trA || trS) toast("dense output — some contours truncated; try a larger interval");
    if (interval < 2) toast("interval < 2 ft: drawn for the mine-area window only (site DEM is 2-ft)");
  }

  return { buildComposite, makeCustomContours, demRaster, specFor, contoursFromDem, KIND_NAME };
})();

SBMM.buildAnalysisLayers = function () {
  SBMM._zrSite = SBMM.demSite.zRange();
  SBMM._zrAbp = SBMM.demAbp.zRange();
  for (const [kind, label, legendHtml] of [
    ["slope", "Slope (0–45°+)",
      `<span class="rampbar" style="background:linear-gradient(90deg,${RAMPS.slope.map(c => `rgb(${c.join(",")})`).join(",")})"></span><span class="mono">0° → 45°+</span>`],
    ["aspect", "Aspect (grid north)", `<span class="mono">hue = facing direction</span>`],
    ["hypso", "Elevation tint",
      `<span class="rampbar" style="background:linear-gradient(90deg,${RAMPS.hypso.map(c => `rgb(${c.join(",")})`).join(",")})"></span><span class="mono">low → high</span>`]]) {
    const holder = L.layerGroup();  // placeholder; children attach on first show
    SBMM.addLayerRow("ana", label, holder, {
      checked: false, opacity: .75,
      onFirstShow: async (grp) => {
        const built = await SBMM.analysis.buildComposite(kind);
        built.eachLayer(l => grp.addLayer(l));
        grp.setOpacity = v => grp.eachLayer(l => l.setOpacity(v));
      }
    });
    const lg = document.createElement("div"); lg.className = "legend"; lg.innerHTML = legendHtml;
    $("anaLayers").appendChild(lg);
  }
  // custom contour generator UI
  const box = document.createElement("div"); box.className = "genrow";
  box.id = "anaGenRow";
  box.innerHTML = `<input type="number" id="ctInt" value="1" min="0.25" step="0.25" style="width:56px"> ft
    <span class="minib" id="ctGo">generate contours</span>`;
  $("anaLayers").appendChild(box);
  $("ctGo").onclick = () => SBMM.analysis.makeCustomContours(parseFloat($("ctInt").value));

  if (SBMM.chm) SBMM.buildCanopyLayer();
};

/* lidar canopy height — optional payload, so its row is built by a named function
   rather than inline: it is called from buildAnalysisLayers when the model is
   already there, and would be called by whatever loads the CHM later if it ever
   moves off the boot path again. It inserts itself above the contour generator so
   the section keeps reading layers-then-tools. */
SBMM.buildCanopyLayer = function () {
  if (!SBMM.chm || $("anaCanopyRow")) return;
  const holder = L.layerGroup();
  const r = SBMM.addLayerRow("ana", "Canopy height (lidar)", holder, {
    /* one row, both views: js/viewer3d.js builds the 3D canopy surface off the
       same layerState entry, so "canopy is on" has one answer (§1) */
    id: "canopy", checked: false, opacity: .75,
    onFirstShow: async (grp) => {
      const chm = SBMM.chm;
      const url = await SBMM.analysis.demRaster(chm, { kind: "canopy", ramp: RAMPS.canopy }, 200, 1, "Canopy height — mine area");
      grp.addLayer(L.imageOverlay(url, chm.bounds(), { pane: "analysis", opacity: .75 }));
      grp.setOpacity = v => grp.eachLayer(l => l.setOpacity(v));
    }
  });
  r.row.id = "anaCanopyRow";
  const lg = document.createElement("div"); lg.className = "legend";
  lg.innerHTML = `<span class="rampbar" style="background:linear-gradient(90deg,${RAMPS.canopy.map(c => `rgb(${c.join(",")})`).join(",")})"></span><span class="mono">2 → 100+ ft</span>`;
  const anchor = $("anaGenRow");
  if (anchor) { $("anaLayers").insertBefore(r.row, anchor); $("anaLayers").insertBefore(lg, anchor); }
  else $("anaLayers").appendChild(lg);
  if (SBMM.layersUI) SBMM.layersUI.refreshCounts();
};
