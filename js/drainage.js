/* SBMM Site Explorer — the drainage map (v14 Phase 1, docs/V14_DRAINAGE_SPEC.md).

   ONE LABEL PER CELL: the outlet that cell drains to. The `drainage` kernel runs
   the raindrop's own physics — the same filled DEM with the same conduit-inlet
   seeds, the same escape test, ponds read at their level, conduits as
   topological shortcuts — once over the whole site instead of from one click.
   So a raindrop dropped anywhere lands inside the catchment drawn under it, and
   that agreement is the acceptance test (test/kernels.mjs `drainage`).

   Three things about it are the whole design:

     * **Terrain only.** No rainfall, no runoff, no curve numbers, no time. The
       map says where water goes, never how much. Every card says so in words,
       and Phase 2 of docs/V14_CATCHMENT_PROPOSAL.md is where the rest lives.
     * **Read-only project analysis**, like js/storm.js and js/designgis.js:
       nothing here is a SBMM.store feature, nothing is editable, nothing
       serialises into a session and nothing touches SBMM.undo. What persists is
       the layer state, the way every other layer's does.
     * **One run per switch state, cached.** The job is 10 s of arithmetic on
       21.6 M cells; it runs when the first row is ticked, and again only when
       the storm network's answer would change (the master switch, or a conduit
       marked broken). Anything else reads the cached result.

   The field build runs the same kernel over the site grid decimated to 4 ft
   (js/jobs.js subGrid) and the card says "4-ft grid"; a worker that cannot
   allocate the 2-ft arrays falls back to the same 4 ft and says so. */
"use strict";

SBMM.drainage = (function () {

  /* §4: one colour per terminal kind, and a per-outlet hue inside a kind. */
  const COL = {
    lake: "#2E6FD6",          // Clear Lake, direct overland
    outfall: "#7FA7C9",       // the storm outfall (--storm)
    off: "#7B8794",           // off the surveyed ground
    pond: "#4FCE9B",          // a depression with no way out
    loop: "#E4796A", flat: "#E8B34B"
  };
  const IMPOUND = "#3FB9B0";                 // the impoundment gets its own teal
  const GREENS = ["#4FCE9B", "#8BE04B", "#59B37A", "#A7D96B", "#3E9E78", "#C3E06B"];
  const FILL_OP = 0.28, EDGE_W = 1.5;
  const NOTE = "Terrain only: steepest descent over the lidar bare earth, depressions filled to "
    + "their pour point, storm conduits as topological shortcuts. No rainfall, runoff or "
    + "hydraulics — the map says where water goes, never how much.";

  let R = null;                      // the last kernel result
  let runKey = null, running = null; // the storm signature this result was computed for
  let card = null, groups = {}, rows = {}, built = false;
  let polyOf = new Map();            // label -> [Leaflet layers]
  let stale = false, staleTimer = null;

  const acft = v => v / 43560;
  const ac = v => fmt(acft(v), v < 43560 ? 3 : 2);
  const on = id => SBMM.layerState.isOn("framework", id);

  /* ------------------------------------------------------------------ */
  /* naming                                                              */
  /* ------------------------------------------------------------------ */
  /* EA's own water polygons name the ponds a card is about to talk about, and
     they are already in the build. A pond whose lowest cell falls inside one
     takes its name; everything else is described by where it is. */
  function waterPolys() {
    const D = window.SBMM_DATA && SBMM_DATA.design_gis;
    if (!D || !D.features) return [];
    const out = [];
    for (const f of D.features) {
      const p = f.properties || {};
      if (p.layer !== "water" || !p.name || p.name === "Unnamed Water Feature") continue;
      const g = f.geometry;
      if (!g || g.type !== "Polygon" || !g.coordinates || !g.coordinates[0]) continue;
      out.push({ name: p.name, ring: g.coordinates[0] });
    }
    return out;
  }
  let WPOLY = null;
  function waterNameAt(x, y) {
    if (!WPOLY) WPOLY = waterPolys();
    for (const q of WPOLY) if (pointInPoly(x, y, q.ring)) return q.name;
    return null;
  }
  function place(x, y) { return `E ${fmt0(x)}, N ${fmt0(y)}`; }

  function sinkName(s) {
    if (s.kind === "lake") return "Clear Lake — direct overland";
    if (s.kind === "off") return "Off the surveyed ground";
    if (s.kind === "loop") return "Unresolved (a conduit loop)";
    if (s.kind === "flat") return "Unresolved (a flat with no route)";
    if (s.kind === "outfall") {
      const c = SBMM.storm && s.via ? SBMM.storm.conduit(s.via) : null;
      const n = c && SBMM.storm ? SBMM.storm.node(c.to) : null;
      return n ? n.name : "Storm outfall";
    }
    const wn = waterNameAt(s.x, s.y);
    return wn ? wn + " — no outlet" : "Closed depression · " + place(s.x, s.y);
  }
  function pondName(p) {
    const wn = waterNameAt(p.entry[0], p.entry[1]);
    return wn || ("Depression · " + place(p.entry[0], p.entry[1]));
  }
  function inletName(q) {
    if (!SBMM.storm) return q.id;
    const c = SBMM.storm.conduit(q.id);
    const n = c ? SBMM.storm.node(c.from) : null;
    return n ? n.name : SBMM.storm.shortLabel(q.id);
  }

  /* the label a record carries, whichever list it came from */
  function recOf(label) {
    if (!R) return null;
    for (const s of R.sinks) if (s.label === label) return { t: "sink", r: s };
    for (const p of R.ponds) if (p.label === label) return { t: "pond", r: p };
    for (const q of R.inlets) if (q.label === label) return { t: "inlet", r: q };
    return null;
  }
  function nameOf(rec) {
    if (!rec) return "unlabelled";
    return rec.t === "sink" ? sinkName(rec.r) : rec.t === "pond" ? pondName(rec.r) : inletName(rec.r);
  }
  function areaOf(rec) {
    if (!rec) return 0;
    return rec.t === "sink" ? rec.r.area_ft2
      : rec.t === "pond" ? rec.r.contributing_area_ft2 : rec.r.area_ft2;
  }
  function colorOf(rec, i) {
    if (!rec) return COL.off;
    if (rec.t === "sink") return COL[rec.r.kind] || COL.pond;
    if (rec.t === "inlet") return COL.outfall;
    return i === 0 ? IMPOUND : GREENS[i % GREENS.length];
  }

  /* ------------------------------------------------------------------ */
  /* the job                                                             */
  /* ------------------------------------------------------------------ */
  function stormOn() {
    return !!(SBMM.storm && SBMM.storm.data() && SBMM.storm.enabled());
  }
  /* what the answer depends on: the master switch and every conduit's status */
  function signature() {
    if (!stormOn()) return "off";
    const ids = SBMM.storm.data().conduits.map(c => c.id + ":" + SBMM.storm.statusOf(c.id));
    return "on|" + ids.join(",");
  }

  function lakeRing() {
    const D = window.SBMM_DATA && SBMM_DATA.design_gis;
    if (!D || !D.features) return null;
    for (const f of D.features) {
      const p = f.properties || {};
      if (p.layer === "water" && p.name === "Clear Lake" && f.geometry
          && f.geometry.type === "Polygon") return f.geometry.coordinates[0];
    }
    return null;
  }

  /* every conduit whose inlet is anywhere on the site, plus the ONE field the
     map needs and a run does not: whether the chain ends where water leaves the
     model (§2) */
  function conduitsForSite(dem) {
    if (!stormOn()) return [];
    const m = dem.m;
    const bbox = [m.x0, m.y0, m.x0 + m.w * m.cell, m.y0 + m.h * m.cell];
    const cds = SBMM.storm.conduitsFor(bbox);
    for (const c of cds) {
      const rec = SBMM.storm.conduit(c.id);
      const to = rec ? SBMM.storm.node(rec.to) : null;
      c.outfall = !!(to && to.kind === "outfall");
    }
    return cds;
  }

  function jobFor(strideCells) {
    const dem = SBMM.demSite;
    if (!dem) return null;
    const grid = strideCells > 1 ? SBMM.compute.subGrid(dem, strideCells)
                                 : SBMM.compute.gridSpec(dem);
    /* the hover raster: about a million cells whatever the grid, so a coarse run
       is not decimated twice */
    const out = Math.max(1, Math.round(Math.sqrt((grid.sw * grid.sh) / 1.5e6)));
    return {
      grid,
      conduits: conduitsForSite(dem),
      captureFt: SBMM.storm ? SBMM.storm.captureFt() : 3,
      lakeRing: lakeRing(),
      minPondDepth: SBMM.water ? SBMM.water.MIN_POND : 0.25,
      stride: out
    };
  }

  /* Run it. Returns the result, or null after a toast. */
  async function run(opts) {
    opts = opts || {};
    if (running) return running;
    if (!SBMM.demSite) { toast("the drainage map needs the site terrain, which did not load"); return null; }
    const key = signature();
    if (R && runKey === key && !opts.force) return R;
    /* the field build AND any phone run at 4 ft, and the card says so (§4) */
    let strideCells = SBMM.lowMem() ? 2 : 1;
    running = (async () => {
      for (;;) {
        const job = jobFor(strideCells);
        if (!job) { toast("the drainage map needs the site terrain, which did not load"); return null; }
        try {
          const t0 = performance.now();
          const res = await SBMM.compute.run("drainage", job,
            { transfer: [job.grid.z.buffer], label: "Drainage map" }).promise;
          res.ms_wall = Math.round(performance.now() - t0);
          res.gridFt = job.grid.cell;
          res.storm = stormOn();
          R = res; runKey = key; stale = false;
          return res;
        } catch (e) {
          if (e && e.cancelled) { toast("drainage map cancelled"); return null; }
          /* §3: the 2-ft run is ~500 MB of typed arrays in the worker; a machine
             that cannot find it gets the 4-ft map and is told which it is. */
          const oom = /alloc|memory|Array buffer|out of/i.test(String(e.message || e));
          if (oom && strideCells < 2) {
            strideCells = 2;
            toast("not enough memory for the 2-ft drainage map — running it at 4 ft", 4200);
            continue;
          }
          toast("drainage map failed: " + (e.message || e));
          return null;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  /* ------------------------------------------------------------------ */
  /* geometry                                                            */
  /* ------------------------------------------------------------------ */
  /* maskRings hands back every ring of a label with no word about which are
     holes, so containment decides: a ring inside an odd number of others is a
     hole and belongs to the smallest ring that contains it. Without this an
     island in the middle of a catchment is painted solid. */
  function toPolys(rings) {
    if (!rings || !rings.length) return [];
    const area = r => Math.abs(polyArea(r));
    const idx = rings.map((r, i) => i).sort((a, b) => area(rings[b]) - area(rings[a]));
    const depth = new Array(rings.length).fill(0), owner = new Array(rings.length).fill(-1);
    for (const i of idx) {
      const p = rings[i][0];
      for (const j of idx) {
        if (j === i || area(rings[j]) <= area(rings[i])) continue;
        if (pointInPoly(p[0], p[1], rings[j])) { depth[i]++; if (owner[i] < 0) owner[i] = j; }
      }
    }
    const polys = new Map();
    for (const i of idx) if (depth[i] % 2 === 0) polys.set(i, [rings[i]]);
    for (const i of idx) {
      if (depth[i] % 2 === 0) continue;
      let o = owner[i];
      /* the smallest even-depth ring containing this one */
      for (const j of idx) if (depth[j] % 2 === 0 && j !== i
        && pointInPoly(rings[i][0][0], rings[i][0][1], rings[j])
        && (o < 0 || area(rings[j]) < area(rings[o]))) o = j;
      if (polys.has(o)) polys.get(o).push(rings[i]);
    }
    return [...polys.values()];
  }
  const toLL = ring => ring.map(p => [p[1], p[0]]);

  /* ------------------------------------------------------------------ */
  /* the layers                                                          */
  /* ------------------------------------------------------------------ */
  function clearLayers() {
    for (const k of ["outlet", "first", "paths"]) if (groups[k]) groups[k].clearLayers();
    SBMM.labels.removeOwner("drainage");
    polyOf = new Map();
  }

  function addPolys(g, rec, i) {
    const col = colorOf(rec, i);
    const rings = rec.t === "pond" ? rec.r.contributing_rings : rec.r.rings;
    const name = nameOf(rec), area = areaOf(rec);
    const layers = [];
    for (const poly of toPolys(rings)) {
      const pl = L.polygon(poly.map(toLL), {
        pane: "vectors", color: col, weight: EDGE_W, opacity: .9,
        fillColor: col, fillOpacity: FILL_OP
      });
      pl.bindTooltip(`→ ${esc(name)} · ${ac(area)} ac`, { sticky: true, className: "ctip" });
      pl.on("mouseover", () => pl.setStyle({ fillOpacity: FILL_OP + 0.22, weight: EDGE_W + 1 }));
      pl.on("mouseout", () => pl.setStyle({ fillOpacity: FILL_OP, weight: EDGE_W }));
      pl.on("click", ev => {
        L.DomEvent.stopPropagation(ev);
        pl.bindPopup(SBMM.popups.forDrainage(rec.r.label)).openPopup();
      });
      pl.addTo(g);
      layers.push(pl);
    }
    polyOf.set(rec.r.label, (polyOf.get(rec.r.label) || []).concat(layers));
    /* the acreage label at the centroid, zoom-gated like every other annotation */
    if (rings && rings.length && area > 43560) {
      const c = centroid(rings[0]);
      const mk = L.marker([c[1], c[0]], {
        pane: "vectors", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "drainlbl", html: `${esc(name)}<br>${ac(area)} ac` })
      }).addTo(g);
      /* v15 §2.2: at full-site zoom every catchment centroid is within a few
         pixels of the next, so the acreages piled up. One name per catchment
         (the key), and the engine drops whichever ones will not fit. */
      SBMM.labels.add({ key: "drain:" + rec.r.label, priority: SBMM.labels.PRI.drainage,
                        marker: mk, owner: "drainage", latlng: [c[1], c[0]] });
    }
  }

  function paint() {
    if (!R) return;
    clearLayers();
    R.sinks.forEach((s, i) => addPolys(groups.outlet, { t: "sink", r: s }, i));
    R.ponds.forEach((p, i) => addPolys(groups.first, { t: "pond", r: p }, i));
    R.inlets.forEach((q, i) => {
      if (q.rings && q.rings.length) addPolys(groups.first, { t: "inlet", r: q }, i);
    });
    for (let i = 0; i < R.sinks.length; i++) {
      const s = R.sinks[i];
      if (!s.path || s.path.length < 2) continue;
      L.polyline(toLL(s.path), { pane: "vectors", color: colorOf({ t: "sink", r: s }, i),
                                 weight: 1.6, opacity: .95, dashArray: "6 4" })
        .bindTooltip(`longest flow path to ${esc(sinkName(s))} · ${fmt0(s.longest_ft)} ft`,
                     { sticky: true, className: "ctip" })
        .addTo(groups.paths);
    }
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
  }

  /* the first tick of any row runs the job (§4) */
  async function ensure(rowId) {
    if (R && runKey === signature()) { paint(); return R; }
    const res = await run();
    if (!res) {
      /* a refusal must never leave a row lit with nothing under it */
      if (rowId) SBMM.layerState.set("framework", rowId, { on: false });
      return null;
    }
    paint();
    showCard();
    return res;
  }

  function build() {
    groups.outlet = L.layerGroup();
    groups.first = L.layerGroup();
    groups.paths = L.layerGroup();
    const mk = (id, label, layer, title) => {
      /* v16: `sub:` declares the sub-group the tree draws the header for. */
      const row = SBMM.addLayerRow("proj", label, layer,
        { id, checked: false, swatch: COL.lake,
          sub: "Drainage (lidar + storm drains)",
          onChange: st => { if (st.on) ensure(id); } });
      row.row.title = title;
      rows[id] = row;
      return row;
    };
    mk("drain_outlet", "Catchments — by outlet", groups.outlet,
       "Where every square foot of the surveyed ground finally drains to. Terrain only.");
    mk("drain_first", "Catchments — by first capture", groups.first,
       "The first pond or storm inlet each square foot reaches on the way.");
    mk("drain_paths", "Flow paths (longest per catchment)", groups.paths,
       "The longest single flow path inside each catchment, drawn as it runs.");
    built = true;
  }

  /* the storm switch, or a conduit going broken, invalidates the map (§4) */
  function markStale() {
    if (!R) return;
    if (signature() === runKey) return;
    stale = true;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(async () => {
      staleTimer = null;
      if (!on("drain_outlet") && !on("drain_first") && !on("drain_paths")) return;
      toast("drainage map is stale — recomputing", 3200);
      const res = await run({ force: true });
      if (res) { paint(); showCard(); }
    }, 400);
  }

  /* ------------------------------------------------------------------ */
  /* the results card                                                    */
  /* ------------------------------------------------------------------ */
  function tableHtml() {
    const tot = R.surveyedArea_ft2 || 1;
    const rowsH = R.sinks.map(s =>
      `<tr><td class="k">${esc(sinkName(s))}</td>`
      + `<td class="v mono">${ac(s.area_ft2)} ac</td>`
      + `<td class="v mono">${fmt(100 * s.area_ft2 / tot, 1)} %</td></tr>`).join("");
    return `<div class="dspopwrap"><table class="dspop">
      <tr><td class="k"><b>outlet</b></td><td class="v"><b>acres</b></td><td class="v"><b>share</b></td></tr>
      ${rowsH}</table></div>`;
  }
  function csv() {
    let out = "outlet,kind,acres,share_pct,longest_flow_path_ft,mean_slope_pct,cells\n";
    const tot = R.surveyedArea_ft2 || 1;
    for (const s of R.sinks)
      out += `"${sinkName(s).replace(/"/g, '""')}",${s.kind},${acft(s.area_ft2).toFixed(3)},`
        + `${(100 * s.area_ft2 / tot).toFixed(2)},${s.longest_ft},${s.meanSlope_pct},${s.cells}\n`;
    out += "\nfirst capture,kind,contributing acres,level ft,depth ft,via\n";
    for (const p of R.ponds)
      out += `"${pondName(p).replace(/"/g, '""')}",pond,${acft(p.contributing_area_ft2).toFixed(3)},`
        + `${p.level},${p.depth_ft},${p.via || ""}\n`;
    for (const q of R.inlets)
      out += `"${inletName(q).replace(/"/g, '""')}",inlet,${acft(q.through_area_ft2).toFixed(3)},,,${q.id}\n`;
    return out;
  }

  function showCard() {
    if (!R) return;
    if (card && card.isConnected) card.remove();
    const tot = R.surveyedArea_ft2;
    card = SBMM.results.card(null, "Drainage map", [
      ["Surveyed area", ac(tot) + " ac"],
      ["Grid", R.gridFt + "-ft lidar grid" + (R.gridFt > 2 ? " (decimated)" : "")],
      ["Cells", fmt0(R.surveyedCells)],
      ["Outlets", fmt0(R.sinks.length)],
      ["Through-ponds", fmt0(R.ponds.length) + " of " + fmt0(R.pondsTotal) + " depressions"],
      ["Storm drains", R.storm ? "assumed working" : "off — ground only"],
      ["Run time", fmt0(R.ms_wall) + " ms"]
    ]);
    const box = document.createElement("div");
    box.innerHTML = tableHtml();
    card.appendChild(box);
    const acts = document.createElement("div");
    acts.className = "pop-actions";
    acts.innerHTML = `<span class="minib" data-d="csv" title="Copy the outlet table as CSV">copy CSV</span>`
      + `<span class="minib" data-d="gj" title="Export both catchment layers as GeoJSON">GeoJSON</span>`
      + `<span class="minib" data-d="dxf" title="Export the catchments as DXF polylines">DXF</span>`
      + `<span class="minib" data-d="re" title="Run the analysis again">recompute</span>`;
    acts.addEventListener("click", async ev => {
      const b = ev.target.closest("[data-d]"); if (!b) return;
      const a = b.dataset.d;
      if (a === "csv") copyText(csv(), "drainage table copied");
      else if (a === "gj") exportGeoJSON();
      else if (a === "dxf") exportDXF();
      else if (a === "re") { const res = await run({ force: true }); if (res) { paint(); showCard(); } }
    });
    card.appendChild(acts);
    SBMM.results.appendNote(card, NOTE);
  }

  /* ------------------------------------------------------------------ */
  /* exports                                                             */
  /* ------------------------------------------------------------------ */
  function props(rec, layer) {
    const r = rec.r;
    return {
      layer, outlet: nameOf(rec), kind: rec.t === "sink" ? r.kind : rec.t,
      acres: +acft(areaOf(rec)).toFixed(3),
      share_pct: R.surveyedArea_ft2 ? +(100 * areaOf(rec) / R.surveyedArea_ft2).toFixed(2) : null,
      longest_flow_path_ft: r.longest_ft, mean_slope_pct: r.meanSlope_pct,
      level_ft: rec.t === "pond" ? r.level : null,
      depth_ft: rec.t === "pond" ? r.depth_ft : null,
      via: r.via || null,
      grid_ft: R.gridFt, storm_drains: R.storm ? "assumed working" : "off",
      source: "SBMM drainage v14"
    };
  }
  function eachRec(fn) {
    R.sinks.forEach((s, i) => fn({ t: "sink", r: s }, "DRAIN-OUTLET", i));
    R.ponds.forEach((p, i) => fn({ t: "pond", r: p }, "DRAIN-FIRST", i));
    R.inlets.forEach((q, i) => { if (q.rings && q.rings.length) fn({ t: "inlet", r: q }, "DRAIN-FIRST", i); });
  }
  function geoFeatures(P) {
    if (!R) return [];
    const out = [];
    eachRec((rec, layer) => {
      const rings = rec.t === "pond" ? rec.r.contributing_rings : rec.r.rings;
      for (const poly of toPolys(rings))
        out.push({ type: "Feature", properties: props(rec, layer),
                   geometry: { type: "Polygon", coordinates: poly.map(r => r.map(P)) } });
    });
    for (const s of R.sinks) if (s.path && s.path.length > 1)
      out.push({ type: "Feature",
                 properties: { layer: "DRAIN-PATH", outlet: sinkName(s),
                               length_ft: s.longest_ft, source: "SBMM drainage v14" },
                 geometry: { type: "LineString", coordinates: s.path.map(P) } });
    return out;
  }
  function dxfEntities() {
    if (!R) return [];
    const out = [];
    eachRec((rec, layer, i) => {
      const rings = rec.t === "pond" ? rec.r.contributing_rings : rec.r.rings;
      for (const ring of (rings || []))
        out.push({ layer, color: colorOf(rec, i), closed: true, pts: ring });
    });
    for (const s of R.sinks) if (s.path && s.path.length > 1)
      out.push({ layer: "DRAIN-PATH", color: COL.lake, closed: false, pts: s.path });
    return out;
  }
  function exportGeoJSON() {
    if (!R) { toast("run the drainage map first (DRAIN)"); return; }
    const P = p => SBMM.toLL(p[0], p[1]);
    const gj = { type: "FeatureCollection",
                 metadata: { source: "SBMM drainage v14", crs: "WGS84",
                             grid_ft: R.gridFt, storm_drains: R.storm ? "assumed working" : "off",
                             note: NOTE },
                 features: geoFeatures(P) };
    download("SBMM_drainage.geojson",
             new Blob([JSON.stringify(gj)], { type: "application/geo+json" }));
    toast("drainage catchments exported as GeoJSON");
  }
  function exportDXF() {
    if (!R) { toast("run the drainage map first (DRAIN)"); return; }
    if (!SBMM.dxf) { toast("DXF export is not available in this build"); return; }
    /* one DXF for the whole workbench (js/dxf.js folds the catchments in on
       DRAIN-OUTLET / DRAIN-FIRST / DRAIN-PATH once the map exists) */
    SBMM.dxf.exportDXF();
  }

  /* ------------------------------------------------------------------ */
  /* "show what drains here"                                             */
  /* ------------------------------------------------------------------ */
  /* Highlight every catchment whose chain passes through a structure or a pond,
     and print the total. `spec` is a conduit id, a node id, or a pond label. */
  function highlight(labels, title, area) {
    if (!on("drain_outlet") && !on("drain_first"))
      SBMM.layerState.set("framework", "drain_first", { on: true });
    for (const [lab, layers] of polyOf)
      for (const pl of layers)
        pl.setStyle(labels.has(lab)
          ? { fillOpacity: FILL_OP + 0.3, weight: EDGE_W + 1.5, color: "#FFD34D" }
          : { fillOpacity: 0.06, weight: 0.6 });
    const el = SBMM.results.card(null, title, [
      ["Contributing area", ac(area) + " ac"],
      ["Catchments", fmt0(labels.size)],
      ["Share of the surveyed site", R.surveyedArea_ft2
        ? fmt(100 * area / R.surveyedArea_ft2, 1) + " %" : "—"]
    ]);
    SBMM.results.appendNote(el, NOTE);
    const b = document.createElement("div");
    b.className = "pop-actions";
    b.innerHTML = `<span class="minib" data-d="clr">clear the highlight</span>`;
    b.addEventListener("click", () => { paint(); toast("highlight cleared"); });
    el.appendChild(b);
    return area;
  }

  /* everything that reaches this conduit, this node, or this pond */
  async function showInto(spec) {
    const res = await ensure();
    if (!res) return null;
    const labels = new Set();
    let area = 0, title = "Drains here";
    const addPond = p => { labels.add(p.label); area += p.contributing_area_ft2; };
    const addInlet = q => { labels.add(q.label); area += q.area_ft2; };

    if (spec.conduit || spec.node) {
      /* the set of conduits that reach this one: walk `next` backwards */
      const want = new Set();
      const seedIds = [];
      if (spec.conduit) seedIds.push(spec.conduit);
      if (spec.node && SBMM.storm) for (const c of SBMM.storm.data().conduits)
        if (c.from === spec.node || c.to === spec.node) seedIds.push(c.id);
      for (const id of seedIds) want.add(id);
      if (SBMM.storm) {
        let grew = true;
        while (grew) {
          grew = false;
          for (const c of SBMM.storm.data().conduits) {
            const nx = SBMM.storm.nextOf(c.id);
            if (nx && want.has(nx) && !want.has(c.id)) { want.add(c.id); grew = true; }
          }
        }
      }
      for (const q of R.inlets) if (want.has(q.id)) addInlet(q);
      for (const p of R.ponds) if (p.via && want.has(p.via)) addPond(p);
      title = "Drains to " + (spec.title || spec.conduit || spec.node);
      /* a terminal outfall also owns a whole by-outlet catchment */
      for (const s of R.sinks) if (s.kind === "outfall" && want.has(s.via)) {
        labels.add(s.label);
        area = Math.max(area, s.area_ft2);
        title = "Drains to " + sinkName(s);
      }
    } else if (spec.pond != null) {
      const p = R.ponds.find(q => q.label === spec.pond);
      if (!p) { toast("that pond is not in the drainage map"); return null; }
      addPond(p);
      title = "Drains into " + pondName(p);
    } else if (spec.xy) {
      const lab = firstAt(spec.xy[0], spec.xy[1]);
      const rec = recOf(lab);
      if (!rec) { toast("nothing drains through that point in the drainage map"); return null; }
      labels.add(lab); area = areaOf(rec);
      title = "Drains into " + nameOf(rec);
    }
    if (!labels.size) {
      toast("nothing on the surveyed ground drains through there");
      return null;
    }
    highlight(labels, title, area);
    return { labels: [...labels], area_ft2: area, acres: +acft(area).toFixed(3) };
  }

  /* ------------------------------------------------------------------ */
  /* raster lookups                                                      */
  /* ------------------------------------------------------------------ */
  function idxAt(x, y) {
    if (!R) return -1;
    const i = Math.round((x - R.x0) / R.dCell), j = Math.round((y - R.y0) / R.dCell);
    if (i < 0 || j < 0 || i >= R.w || j >= R.h) return -1;
    return j * R.w + i;
  }
  function labelAt(x, y) { const k = idxAt(x, y); return k < 0 ? -1 : R.labels[k]; }
  function firstAt(x, y) { const k = idxAt(x, y); return k < 0 ? -1 : R.first[k]; }
  function outletAt(x, y) { const rec = recOf(labelAt(x, y)); return rec ? nameOf(rec) : null; }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  /* A catchment boundary follows the edge of the surveyed ground, so a good part
     of every big one has NO TERRAIN UNDER IT — and `drapeZ` falls back to the
     middle of the site's elevation range there, which draws the boundary as a
     70-ft vertical curtain standing along the survey limit and over Clear Lake.
     js/layers.js already has the rule for the survey contours and this is the
     same rule: drop a vertex with no ground under it (breaking the run), and
     break a run at any segment over BRIDGE_FT whose midpoint is NoData. What
     comes back is open runs rather than closed rings, which is what a boundary
     that genuinely stops at the survey limit is. */
  const STEP_FT = 10;                        // drapedLine's own resampling step
  function groundRuns(ring) {
    const runs = [];
    let cur = [];
    const flush = () => { if (cur.length > 1) runs.push(cur); cur = []; };
    for (const p of ring) {
      const [z] = SBMM.elev(p[0], p[1]);
      if (isNaN(z)) { flush(); continue; }
      if (cur.length) {
        /* Both ends can be on surveyed ground while the drape's own 10-ft
           resampling of the segment between them is not — a boundary running
           along the shore cuts the corner across open water. Test the segment
           the way drapedLine will walk it, not just its midpoint. */
        const q = cur[cur.length - 1];
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d > STEP_FT) {
          const n = Math.ceil(d / STEP_FT);
          let gap = false;
          for (let k = 1; k < n && !gap; k++) {
            const t = k / n;
            const [mz] = SBMM.elev(q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t);
            if (isNaN(mz)) gap = true;
          }
          if (gap) flush();
        }
      }
      cur.push(p);
    }
    flush();
    return runs;
  }

  function rings3d() {
    if (!R) return [];
    const out = [];
    const push = (rec, i, want) => {
      if (!want) return;
      const rings = rec.t === "pond" ? rec.r.contributing_rings : rec.r.rings;
      for (const ring of (rings || []))
        for (const run of groundRuns(ring))
          out.push({ ring: run, color: colorOf(rec, i), width: 3, closed: false,
                     props: props(rec, rec.t === "sink" ? "DRAIN-OUTLET" : "DRAIN-FIRST"),
                     label: rec.r.label,
                     geom: { type: "LineString", coordinates: run } });
    };
    R.sinks.forEach((s, i) => push({ t: "sink", r: s }, i, on("drain_outlet")));
    R.ponds.forEach((p, i) => push({ t: "pond", r: p }, i, on("drain_first")));
    R.inlets.forEach((q, i) => push({ t: "inlet", r: q }, i, on("drain_first")));
    return out;
  }
  function lines3d() {
    if (!R || !on("drain_paths")) return [];
    const out = [];
    R.sinks.forEach((s, i) => {
      if (!s.path || s.path.length < 2) return;
      for (const run of groundRuns(s.path))
        out.push({ ring: run, color: colorOf({ t: "sink", r: s }, i), width: 2, closed: false,
                   props: { layer: "DRAIN-PATH", outlet: sinkName(s), length_ft: s.longest_ft,
                            source: "SBMM drainage v14" },
                   geom: { type: "LineString", coordinates: run } });
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* chrome                                                              */
  /* ------------------------------------------------------------------ */
  async function cmd() {
    if (!built) { toast("the drainage map is not available in this build"); return; }
    const res = await ensure();
    if (!res) return;
    SBMM.layerState.set("framework", "drain_outlet", { on: true });
    paint();
    showCard();
    toast(`drainage map: ${R.sinks.length} outlets over ${ac(R.surveyedArea_ft2)} ac `
          + `on the ${R.gridFt}-ft grid`, 4200);
  }

  function paintChip() {
    const el = document.getElementById("drainChip");
    if (!el) return;
    const show = SBMM.mode && SBMM.mode.current && SBMM.mode.current() === "raindrop" && built;
    el.hidden = !show;
    el.classList.toggle("off", !R);
    el.textContent = R ? (stale ? "drainage map: stale" : "drainage map: " + R.gridFt + " ft")
                       : "drainage map";
    el.title = R ? "The whole-site catchment map this raindrop must agree with. Click to show it."
                 : "Run the whole-site catchment map (DRAIN).";
  }

  function wire() {
    const chip = document.getElementById("drainChip");
    if (chip) chip.addEventListener("click", ev => { ev.stopPropagation(); cmd(); });
    if (SBMM.events) {
      SBMM.events.on("mode", paintChip);
      SBMM.events.on("layers", ({ group, layer }) => {
        if (group !== "framework") return;
        if (layer && /^storm_/.test(layer)) return;
        if (layer && /^drain_/.test(layer)) paint();
      });
    }
    paintChip();
  }

  return {
    build, wire, cmd, run, paint, showCard, showInto, markStale,
    geoFeatures, dxfEntities, rings3d, lines3d, groundRuns, exportGeoJSON, exportDXF,
    result: () => R, hasResult: () => !!R, isStale: () => stale,
    labelAt, firstAt, outletAt, recOf, nameOf, areaOf, sinkName, pondName, inletName,
    paintChip, COLORS: COL, NOTE
  };
})();
