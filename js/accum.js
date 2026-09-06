/* SBMM Site Explorer — flow accumulation and the stream network
   (v19 Phase 3, docs/V19_HYDRO3_SPEC.md §2).

   Phase 1 said WHERE the water goes; this says HOW MUCH GROUND drains through
   each point on the way. One number per cell — the contributing area in square
   feet — over the same filled DEM, the same conduit seeding and the same
   pointer field the drainage map is built on, so the two can never disagree.

   Three things about it are the whole design:

     * **Terrain only, still.** Contributing AREA, never discharge. No rainfall
       and no runoff live here; the design storm (js/runoff.js) is what turns an
       area into a flow, and it now reads this raster for its TR-55 channel test
       instead of the linear proxy v14 Phase 2 had to use.
     * **The identity is the acceptance test.** What leaves the model at each
       cell, summed by the drainage map's own label, is that outlet's Phase 1
       area — exactly, for D8 (test/kernels.mjs §11.8, 0.000 % on all three
       outlets over an acre). The card prints that cross-check rather than only
       asserting it in a harness, because it is the one number that says the map
       and the accumulation are the same analysis.
     * **D8 is the default here and D-infinity is one click away.** The spec
       offers both; D8 is the method whose values ARE the contributing area the
       5-acre channel rule names, it is the one the identity is exact for, and
       it draws 108 stream links where D-infinity's dispersion draws more than 1,500. The
       card's "D-infinity" button re-runs and redraws, and every card, popup and
       export says which method produced the number.

   Read-only project analysis, like js/drainage.js: nothing here is a
   SBMM.store feature, nothing serialises into a session, nothing touches
   SBMM.undo. What persists is the layer state, like every other layer's.

   The field build runs the same kernel over the site grid decimated to 4 ft
   (js/jobs.js subGrid) and every card says which grid it is on. */
"use strict";

SBMM.accum = (function () {

  const AC = 43560;
  const SUB = "Drainage (lidar + storm drains)";      // the v16 layer-tree sub-group
  const NOTE = "Terrain only: the contributing area draining through each cell, over the same "
    + "filled lidar surface and the same storm conduits as the drainage map. Contributing AREA, "
    + "never discharge — the design storm is what turns an area into a flow.";
  /* the log ramp: one cell, then decades of acres */
  const RAMP = [[0.02, [30, 52, 74]], [0.2, [46, 111, 214]], [2, [79, 206, 155]],
                [20, [242, 193, 78]], [200, [232, 115, 74]]];
  const STREAM_COL = "#3FB9B0";
  const THRESH_AC = 5;                                 // spec §2: the default threshold

  let R = null;                        // the cached result of the CURRENT method
  let byMethod = {};                   // method -> result, for the storm and the toggle
  let running = null, method = "d8";
  let card = null, groups = {}, rows = {}, built = false, overlay = null;
  let legendEl = null;

  const acft = v => v / AC;
  const ac = v => fmt(acft(v), v < AC ? 3 : 2);
  const on = id => SBMM.layerState.isOn("framework", id);

  /* ------------------------------------------------------------------ */
  /* the job — js/drainage.js jobFor(), with the same grid and the same    */
  /* conduit list, because it must be the same analysis                    */
  /* ------------------------------------------------------------------ */
  function stormOn() { return !!(SBMM.storm && SBMM.storm.data() && SBMM.storm.enabled()); }
  function signature(m) {
    const base = (m || method) + "|" + (SBMM.lowMem() ? "4" : "2");
    if (!stormOn()) return base + "|off";
    return base + "|on|" + SBMM.storm.data().conduits
      .map(c => c.id + ":" + SBMM.storm.statusOf(c.id)).join(",");
  }
  function conduitsForSite(dem) {
    if (!stormOn()) return [];
    const m = dem.m;
    const cds = SBMM.storm.conduitsFor([m.x0, m.y0, m.x0 + m.w * m.cell, m.y0 + m.h * m.cell]);
    for (const c of cds) {
      const rec = SBMM.storm.conduit(c.id);
      const to = rec ? SBMM.storm.node(rec.to) : null;
      c.outfall = !!(to && to.kind === "outfall");
    }
    return cds;
  }
  function jobFor(strideCells, m) {
    const dem = SBMM.demSite;
    if (!dem) return null;
    const grid = strideCells > 1 ? SBMM.compute.subGrid(dem, strideCells)
                                 : SBMM.compute.gridSpec(dem);
    /* the display raster: about a million cells whatever the grid, the same
       rule the drainage map's own hover raster uses */
    const out = Math.max(1, Math.round(Math.sqrt((grid.sw * grid.sh) / 1.5e6)));
    const job = {
      grid, method: m || method,
      conduits: conduitsForSite(dem),
      captureFt: SBMM.storm ? SBMM.storm.captureFt() : 3,
      streamThreshold_ft2: THRESH_AC * AC,
      stride: out
    };
    /* the cross-check the card prints: the drainage map's own labels, when it
       has already been run. Its raster is decimated, so the comparison is
       approximate and the card says so — the exact form is the harness's. */
    const D = SBMM.drainage && SBMM.drainage.result();
    if (D) job.labels = { data: D.labels, w: D.w, h: D.h, cell: D.dCell, x0: D.x0, y0: D.y0 };
    return job;
  }

  async function run(opts) {
    opts = opts || {};
    if (opts.method && opts.method !== method) { method = opts.method; R = byMethod[method] || null; }
    if (running) return running;
    if (!SBMM.demSite) { toast("flow accumulation needs the site terrain, which did not load"); return null; }
    const key = signature(method);
    const cached = byMethod[method];
    if (cached && cached.key === key && !opts.force) { R = cached; return R; }
    let strideCells = SBMM.lowMem() ? 2 : 1;
    running = (async () => {
      for (;;) {
        const job = jobFor(strideCells);
        if (!job) { toast("flow accumulation needs the site terrain, which did not load"); return null; }
        try {
          const t0 = performance.now();
          const res = await SBMM.compute.run("accum", job,
            { transfer: [job.grid.z.buffer], label: "Flow accumulation" }).promise;
          res.ms_wall = Math.round(performance.now() - t0);
          res.gridFt = job.grid.cell;
          res.storm = stormOn();
          res.key = key;
          res.checked = !!job.labels;
          R = res; byMethod[method] = res;
          return res;
        } catch (e) {
          if (e && e.cancelled) { toast("flow accumulation cancelled"); return null; }
          const oom = /alloc|memory|Array buffer|out of/i.test(String(e.message || e));
          if (oom && strideCells < 2) {
            strideCells = 2;
            toast("not enough memory for the 2-ft accumulation — running it at 4 ft", 4200);
            continue;
          }
          toast("flow accumulation failed: " + (e.message || e));
          return null;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  /* the raster js/runoff.js reads for TR-55's channel test: D8, whatever the
     display is set to, because those values ARE the contributing area the rule
     names. Run on demand and cached like any other. */
  async function rasterFor(m) {
    m = m || "d8";
    const cached = byMethod[m];
    if (cached && cached.key === signature(m)) return cached;
    const was = method;
    method = m;
    try { return await run({ force: true }); }
    finally { method = was; R = byMethod[method] || R; }
  }
  /* the shape the runoff kernel takes */
  function rasterSpec(res) {
    if (!res) return null;
    return { data: res.acc, w: res.w, h: res.h, cell: res.dCell, x0: res.x0, y0: res.y0 };
  }

  /* ------------------------------------------------------------------ */
  /* the raster overlay                                                   */
  /* ------------------------------------------------------------------ */
  function colorOf(acres) {
    if (!(acres > 0)) return null;
    const t = Math.log10(Math.max(acres, RAMP[0][0]));
    let a = RAMP[0], b = RAMP[RAMP.length - 1];
    for (let i = 0; i < RAMP.length - 1; i++) {
      const l0 = Math.log10(RAMP[i][0]), l1 = Math.log10(RAMP[i + 1][0]);
      if (t >= l0 && t <= l1) {
        const u = (t - l0) / ((l1 - l0) || 1e-9);
        return RAMP[i][1].map((v, k) => Math.round(v + (RAMP[i + 1][1][k] - v) * u));
      }
    }
    return (t <= Math.log10(RAMP[0][0]) ? a : b)[1];
  }
  function rasterURL() {
    if (!R) return null;
    /* one canvas per result: 1.2 M pixels is not something to repaint on every
       `layers` event, and the raster cannot change without a new run */
    if (R._url) return R._url;
    const cv = document.createElement("canvas");
    cv.width = R.w; cv.height = R.h;
    const g = cv.getContext("2d");
    const img = g.createImageData(R.w, R.h);
    const px = img.data;
    for (let j = 0; j < R.h; j++) {
      const dst = (R.h - 1 - j) * R.w;              // canvas row 0 = north
      for (let i = 0; i < R.w; i++) {
        const v = R.acc[j * R.w + i];
        const k = (dst + i) * 4;
        if (!(v > 0)) { px[k + 3] = 0; continue; }
        const c = colorOf(v / AC);
        px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2];
        /* the channels are opaque, the hillslopes translucent, so the ortho
           underneath is still readable where nothing is happening */
        px[k + 3] = Math.round(90 + 150 * clamp(Math.log10(Math.max(v / AC, 0.02)) / 2.3 + 0.3, 0, 1));
      }
    }
    g.putImageData(img, 0, 0);
    R._url = cv.toDataURL("image/png");
    return R._url;
  }
  function bounds() {
    if (!R) return null;
    /* x0/y0 are cell CENTRES (the same rule the water band records) */
    const half = R.dCell / 2;
    return [R.x0 - half, R.y0 - half, R.x0 + (R.w - 0.5) * R.dCell, R.y0 + (R.h - 0.5) * R.dCell];
  }
  function paintRaster() {
    if (overlay) { SBMM.map.removeLayer(overlay); overlay = null; }
    if (!R || !on("accum_raster")) return;
    const b = bounds(), url = rasterURL();
    if (!url) return;
    overlay = L.imageOverlay(url, [[b[1], b[0]], [b[3], b[2]]],
      { pane: "analysis", opacity: SBMM.layerState.opacity("framework", "accum_raster"),
        interactive: false });
    overlay.addTo(SBMM.map);
  }

  /* ------------------------------------------------------------------ */
  /* the streams                                                          */
  /* ------------------------------------------------------------------ */
  const weightOf = o => 1 + Math.min(4, o) * 0.9;
  function paintStreams() {
    if (!groups.streams) return;
    groups.streams.clearLayers();
    if (!R || !on("accum_streams")) return;
    for (const s of R.streams) {
      if (!s.pts || s.pts.length < 2) continue;
      const ln = L.polyline(s.pts.map(p => [p[1], p[0]]), {
        pane: "vectors", color: STREAM_COL, weight: weightOf(s.order),
        opacity: .92, lineCap: "round", lineJoin: "round"
      });
      ln.bindTooltip(`order ${s.order} · upstream ${ac(s.accMax_ft2)} ac · ${fmt0(s.length_ft)} ft`,
                     { sticky: true, className: "ctip" });
      ln.on("click", ev => {
        L.DomEvent.stopPropagation(ev);
        ln.bindPopup(SBMM.popups.forStream(s, R)).openPopup();
      });
      ln.addTo(groups.streams);
    }
  }
  function paint() { paintRaster(); paintStreams(); }

  /* the first tick of either row runs the job */
  async function ensure(rowId) {
    const res = await run();
    if (!res) {
      if (rowId) SBMM.layerState.set("framework", rowId, { on: false });
      return null;
    }
    paint();
    showCard();
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* the rows                                                             */
  /* ------------------------------------------------------------------ */
  function build() {
    groups.streams = L.layerGroup();
    const rast = SBMM.addLayerRow("proj", "Flow accumulation", null,
      { id: "accum_raster", checked: false, swatch: "#2E6FD6", opacity: 0.75, sub: SUB,
        onChange: async st => {
          if (!st.on) { paintRaster(); return; }
          const res = await ensure("accum_raster");
          if (res) paintRaster();
        } });
    rast.row.title = "How much ground drains through each cell, log-scaled in acres. Terrain only.";
    rows.accum_raster = rast;

    const str = SBMM.addLayerRow("proj", `Streams (≥ ${THRESH_AC} ac)`, groups.streams,
      { id: "accum_streams", checked: false, swatch: STREAM_COL, sub: SUB,
        onChange: async st => {
          if (!st.on) { paintStreams(); return; }
          const res = await ensure("accum_streams");
          if (res) paintStreams();
        } });
    str.row.title = `Every flow path with more than ${THRESH_AC} acres above it, weighted by `
      + "Strahler order. Hover shows the upstream acres.";
    rows.accum_streams = str;

    /* the legend, after both rows — js/layertree.js reorders the `.lyr`
       elements among themselves and leaves everything else where it is, so a
       legend parked between two rows would shuffle with them (v14 Phase 2's
       note, and the same rule applies here). */
    if (str.row.parentNode) {
      legendEl = document.createElement("div");
      legendEl.className = "rnLegend";
      legendEl.innerHTML = [0.02, 0.2, 2, 20, 200].map(a =>
        `<span class="rnLeg"><i style="background:rgb(${colorOf(a).join(",")})"></i>`
        + `${a < 1 ? a : fmt0(a)} ac</span>`).join("");
      str.row.parentNode.appendChild(legendEl);
    }
    built = true;
  }

  /* the status bar (§2): "upstream area 12.4 ac" while the raster is on */
  function hoverText(x, y) {
    if (!R || !on("accum_raster")) return "";
    const v = accAt(x, y);
    if (!(v > 0)) return "";
    return ` · upstream ${ac(v)} ac`;
  }
  function accAt(x, y) {
    if (!R) return NaN;
    const i = Math.round((x - R.x0) / R.dCell), j = Math.round((y - R.y0) / R.dCell);
    if (i < 0 || j < 0 || i >= R.w || j >= R.h) return NaN;
    return R.acc[j * R.w + i];
  }

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  /* THE CROSS-CHECK, AND THE HALF OF IT THE APP CANNOT DO.

     The identity is "what leaves the model at each cell, summed by the catchment
     the drainage map gives that cell, is that catchment's area". Summing it needs
     a label AT THE EXIT CELL — and the label raster the app keeps is decimated for
     display (about a million cells whatever the grid, so 8 ft here). An exit cell
     in the MIDDLE of a catchment samples that raster unambiguously; an exit cell on
     the survey boundary — which is where a lake or an off-survey catchment does all
     of its leaving — lands in an 8-ft label cell that may belong to the catchment
     next door or to no catchment at all. The field build showed exactly that:
     the storm outfall came back 0.01 %, and Clear Lake, whose exits are its whole
     shoreline, came back -60 %.

     So the card compares the outlets whose exits are INTERIOR by construction — a
     conduit outfall leaves through its pipe's capture cells, well inside the
     survey — and says plainly that a boundary outlet cannot be attributed at this
     resolution. The exact form of the identity needs the full-resolution label
     raster, which the harness has: test/kernels.mjs §11.8, 0.000 % on all three
     outlets over an acre. Widening the tolerance until the wrong number fits would
     be the opposite of a check. */
  function boundarySink(rec) {
    return !!(rec && rec.t === "sink" && rec.r.kind !== "outfall");
  }
  function checkRows() {
    if (!R || !R.byLabel || !R.byLabel.length || !SBMM.drainage || !SBMM.drainage.result()) return "";
    let compared = 0;
    const rowsH = R.byLabel.slice(0, 6).map(b => {
      const rec = SBMM.drainage.recOf(b.label);
      if (!rec || rec.t !== "sink") return "";
      const want = rec.r.area_ft2;
      if (boundarySink(rec))
        return `<tr><td class="k">${esc(SBMM.drainage.nameOf(rec))}</td>`
          + `<td class="v mono">${ac(b.area_ft2)}</td>`
          + `<td class="v mono">${ac(want)}</td>`
          + `<td class="v">boundary exits — not attributable at ${R.dCell} ft</td></tr>`;
      compared++;
      const d = want > 0 ? 100 * (b.area_ft2 - want) / want : NaN;
      return `<tr><td class="k">${esc(SBMM.drainage.nameOf(rec))}</td>`
        + `<td class="v mono">${ac(b.area_ft2)}</td>`
        + `<td class="v mono">${ac(want)}</td>`
        + `<td class="v mono">${isNaN(d) ? "—" : fmt(d, 2) + " %"}</td></tr>`;
    }).join("");
    if (!rowsH) return "";
    return `<div class="note">Against the drainage map</div><div class="dspopwrap"><table class="dspop">
      <tr><td class="k"><b>outlet</b></td><td class="v"><b>accumulated ac</b></td>
          <td class="v"><b>catchment ac</b></td><td class="v"><b>d</b></td></tr>
      <tr><td class="k">Everything that leaves the model</td>
          <td class="v mono">${ac(R.exitTotal_ft2)}</td>
          <td class="v mono">${ac(R.surveyedArea_ft2)}</td>
          <td class="v mono">${fmt(100 * (R.exitTotal_ft2 - R.surveyedArea_ft2)
                / (R.surveyedArea_ft2 || 1), 3)} %</td></tr>
      ${rowsH}</table>
      <div class="note">Every square foot of the surveyed ground leaves the model exactly once —
      that row is exact at any resolution. Per outlet, the sum needs a catchment label AT THE
      EXIT CELL, and the label raster on this card is decimated to ${R.dCell} ft for drawing:
      an outlet that leaves through a pipe is attributed exactly (its exits are the pipe's own
      cells), while one that leaves along the survey boundary cannot be, because a boundary
      exit cell falls in a label cell that may belong to its neighbour. The exact identity is
      run at full resolution in test/kernels.mjs §11.8, where it is 0.000 % on every outlet
      over an acre.${compared ? "" : " Nothing on this run leaves through a pipe, so there is"
      + " nothing here to compare."}</div></div>`;
  }

  function csv() {
    if (!R) return "";
    let out = "SBMM flow accumulation," + R.method + "\n";
    out += `grid_ft,${R.gridFt},sampled_ft,${R.dCell},storm_drains,${R.storm ? "assumed working" : "off"}\n`;
    out += `surveyed_acres,${acft(R.surveyedArea_ft2).toFixed(2)},largest_accumulation_acres,`
      + `${R.maxAcc_ac.toFixed(2)},stream_threshold_acres,${R.threshold_ac}\n\n`;
    out += "stream,order,upstream_acres_max,upstream_acres_min,length_ft,ends\n";
    R.streams.forEach((s, i) => {
      out += `${i + 1},${s.order},${acft(s.accMax_ft2).toFixed(3)},`
        + `${acft(s.accMin_ft2).toFixed(3)},${s.length_ft},${s.ends}\n`;
    });
    out += "\nStrahler order,cells\n";
    for (const k of Object.keys(R.orders).sort()) out += `${k},${R.orders[k]}\n`;
    return out;
  }

  function showCard() {
    if (!R) return;
    if (card && card.isConnected) card.remove();
    card = SBMM.results.card(null, "Flow accumulation", [
      ["Method", R.method === "d8" ? "D8 (steepest descent)" : "D-infinity (Tarboton 1997)"],
      ["Grid", R.gridFt + "-ft lidar grid" + (R.gridFt > 2 ? " (decimated)" : "")
        + " · drawn at " + R.dCell + " ft"],
      ["Surveyed area", ac(R.surveyedArea_ft2) + " ac"],
      ["Largest accumulation", fmt(R.maxAcc_ac, 1) + " ac"],
      ["Streams over " + THRESH_AC + " ac", fmt0(R.streamLinks) + " links · "
        + fmt(R.streamLength_ft / 5280, 2) + " mi · to Strahler order " + R.maxOrder],
      ["Storm drains", R.storm ? "assumed working" : "off — ground only"],
      ["Run time", fmt0(R.ms_wall) + " ms"]
    ]);
    const box = document.createElement("div");
    box.innerHTML = checkRows();
    card.appendChild(box);
    const acts = document.createElement("div");
    acts.className = "pop-actions";
    acts.innerHTML = `<span class="minib" data-a="csv" title="Copy the stream table as CSV">copy CSV</span>`
      + `<span class="minib" data-a="gj" title="Export the streams as GeoJSON">GeoJSON</span>`
      + `<span class="minib" data-a="m" title="Run the other method over the same ground">`
      + `${R.method === "d8" ? "D-infinity" : "D8"}</span>`
      + `<span class="minib" data-a="re" title="Run the analysis again">recompute</span>`;
    acts.addEventListener("click", async ev => {
      const b = ev.target.closest("[data-a]"); if (!b) return;
      const a = b.dataset.a;
      if (a === "csv") copyText(csv(), "flow accumulation copied");
      else if (a === "gj") exportGeoJSON();
      else if (a === "m") {
        const other = R.method === "d8" ? "dinf" : "d8";
        const res = await run({ method: other });
        if (res) { paint(); showCard(); toast("flow accumulation: " + (other === "d8" ? "D8" : "D-infinity")); }
      } else if (a === "re") { const res = await run({ force: true }); if (res) { paint(); showCard(); } }
    });
    card.appendChild(acts);
    SBMM.results.appendNote(card, NOTE);
  }

  /* ------------------------------------------------------------------ */
  /* exports                                                             */
  /* ------------------------------------------------------------------ */
  function props(s) {
    return { layer: "STREAM", strahler: s.order,
             upstream_acres: +acft(s.accMax_ft2).toFixed(3),
             length_ft: s.length_ft, ends: s.ends, method: R.method,
             threshold_acres: R.threshold_ac, grid_ft: R.gridFt,
             storm_drains: R.storm ? "assumed working" : "off",
             source: "SBMM flow accumulation v19" };
  }
  function geoFeatures(P) {
    if (!R) return [];
    return R.streams.filter(s => s.pts && s.pts.length > 1).map(s => ({
      type: "Feature", properties: props(s),
      geometry: { type: "LineString", coordinates: s.pts.map(P) }
    }));
  }
  function dxfEntities() {
    if (!R) return [];
    return R.streams.filter(s => s.pts && s.pts.length > 1)
      .map(s => ({ layer: "STREAM", color: STREAM_COL, closed: false, pts: s.pts }));
  }
  function exportGeoJSON() {
    if (!R) { toast("run the flow accumulation first (ACCUM)"); return; }
    const P = p => SBMM.toLL(p[0], p[1]);
    const gj = { type: "FeatureCollection",
                 metadata: { source: "SBMM flow accumulation v19", crs: "WGS84",
                             method: R.method, grid_ft: R.gridFt,
                             threshold_acres: R.threshold_ac, note: NOTE },
                 features: geoFeatures(P) };
    download("SBMM_streams.geojson",
             new Blob([JSON.stringify(gj)], { type: "application/geo+json" }));
    toast("the stream network was exported as GeoJSON");
  }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  /* A stream follows the ground by construction, so unlike a catchment
     boundary it never runs off the surveyed edge — but it is drawn through
     js/drainage.js groundRuns() all the same, because a link that ends at the
     survey limit has its last vertex out over the water. */
  function lines3d() {
    if (!R || !on("accum_streams")) return [];
    const runsOf = SBMM.drainage && SBMM.drainage.groundRuns;
    const out = [];
    for (const s of R.streams) {
      if (!s.pts || s.pts.length < 2) continue;
      for (const run of (runsOf ? runsOf(s.pts) : [s.pts]))
        out.push({ ring: run, color: STREAM_COL, width: weightOf(s.order) + 1, closed: false,
                   props: props(s), geom: { type: "LineString", coordinates: run } });
    }
    return out;
  }
  /* the raster IS a raster over the ground, so in 3D it is a drape (v15 §3.1) */
  function drapeSpec() {
    if (!R || !on("accum_raster")) return null;
    const url = rasterURL(), b = bounds();
    if (!url || !b) return null;
    return { url, bounds: b, layer: { g: "framework", l: "accum_raster" } };
  }

  /* ------------------------------------------------------------------ */
  /* chrome                                                              */
  /* ------------------------------------------------------------------ */
  async function cmd(opts) {
    if (!built) { toast("flow accumulation is not available in this build"); return; }
    const res = await run(opts || {});
    if (!res) return;
    SBMM.layerState.set("framework", "accum_raster", { on: true });
    SBMM.layerState.set("framework", "accum_streams", { on: true });
    paint();
    showCard();
    toast(`flow accumulation: up to ${fmt(R.maxAcc_ac, 1)} ac through one cell, `
        + `${fmt0(R.streamLinks)} stream links over ${THRESH_AC} ac`, 4200);
  }

  /* the storm switch, or a conduit going broken, invalidates it exactly as it
     invalidates the drainage map */
  function markStale() {
    if (!Object.keys(byMethod).length) return;
    byMethod = {}; R = null;
    if (on("accum_raster") || on("accum_streams")) {
      toast("flow accumulation is stale — recomputing", 3200);
      setTimeout(async () => { const res = await run({ force: true }); if (res) { paint(); showCard(); } }, 400);
    }
  }

  function wire() {
    if (!SBMM.events) return;
    SBMM.events.on("layers", ({ group, layer }) => {
      if (group !== "framework") return;
      const mine = layer == null || layer === "accum_raster" || layer === "accum_streams";
      if (!mine) return;
      if (overlay && (layer == null || layer === "accum_raster"))
        overlay.setOpacity(SBMM.layerState.opacity("framework", "accum_raster"));
      if (R) paint();
      if (SBMM.viewer3d && SBMM.viewer3d.isOpen && SBMM.viewer3d.isOpen()) {
        if (SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
        if (SBMM.viewer3d.refreshOverlays) SBMM.viewer3d.refreshOverlays();
      }
    });
  }

  return {
    build, wire, cmd, run, paint, showCard, markStale,
    rasterFor, rasterSpec, accAt, hoverText, lines3d, drapeSpec,
    geoFeatures, dxfEntities, exportGeoJSON, csv,
    result: () => R, hasResult: () => !!R, method: () => method,
    isBuilt: () => built, THRESH_AC, NOTE
  };
})();
