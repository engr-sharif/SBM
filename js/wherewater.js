/* SBMM Site Explorer — "where does the water go" (v22 §C, docs/V22_SPEC.md).

   THE ENGINEER'S QUESTION, in his words: "we basically need an area that
   overland-flows right into Clear Lake, then the area whose flow goes into the
   Herman impoundment, and another area that flows away from the site elsewhere,
   so we can understand the catchment for the Herman impoundment."

   The kernels have known this since v14; nothing said it. This module says it,
   in four classes that partition the surveyed ground exactly:

     1  Straight into Clear Lake      — overland the whole way, no pipe
     2  Into the Herman impoundment   — and out through the two 24-in barrels
     3  Into Frog Pond / Green Pond   — and out through the road drain
     4  Off the surveyed ground       — it leaves the survey somewhere else

   NO KERNEL CHANGE (js/compute.js is untouched). The class of a cell is the
   OUTLET the Phase 1 `drainage` kernel already gives it, read at a finer
   naming: js/drainage.js hands the kernel the conduit list with v22 §S's trunk
   merge applied, so the three pipes that discharge at the one `outfall` node
   are ONE outlet (281.99 ac — the number the engineer already reads). This
   module hands it the SAME list with `{ mergeOutfalls: false }`, so each
   discharge pipe terminates its own chain and the kernel reports one outlet per
   pipe. Same filled DEM, same conduit seeding, same ponds, same first-capture
   labels — only the outlet naming differs, and the two runs' outlets add up to
   the square foot. test/kernels.mjs §11.9 asserts exactly that.

   WHY NOT "THE FIRST CAPTURE IS THE IMPOUNDMENT". Because that is 37.90 ac, and
   it is not a catchment: it is the ground that reaches the impoundment WITHOUT
   pausing in a smaller depression first. The site has 38,994 depressions and
   1,945 of them are deeper than the lidar noise floor, so most of the water
   arrives having filled two or three puddles on the way. The impoundment's real
   catchment is 84.14 ac, and the accumulation kernel says the same thing
   independently (84.09 ac through the surveyed south pipe, v19's `accum`
   probes). The card prints both numbers and says which is which.

   Read-only project analysis, like js/drainage.js and js/storm.js: nothing here
   is a SBMM.store feature, nothing serialises into a session, nothing touches
   SBMM.undo. What persists is the layer state, like every other layer's. */
"use strict";

SBMM.whereWater = (function () {

  /* §C: four classes, one colour each. The teal is the drainage map's own
     impoundment colour and the blue its Clear Lake colour, so a user who has
     both layers on is not asked to learn two palettes. */
  const CLASSES = [
    { id: "lake",    label: "Straight into Clear Lake",     color: "#2E6FD6" },
    { id: "impound", label: "Into the Herman impoundment",  color: "#3FB9B0" },
    { id: "ponds",   label: "Into Frog Pond / Green Pond",  color: "#4FCE9B" },
    { id: "off",     label: "Off the surveyed ground",      color: "#7B8794" }
  ];
  const CBY = Object.fromEntries(CLASSES.map(c => [c.id, c]));
  const FILL_OP = 0.30, EDGE_W = 1.5;
  const NOTE = "Terrain only: steepest descent over the lidar bare earth, depressions filled to "
    + "their pour point, storm conduits as topological shortcuts. Where the water goes, never "
    + "how much — the design storm (RAIN) is the volume question.";

  let R = null;                       // the last kernel result (outlets un-merged)
  let runKey = null, running = null;
  let card = null, group = null, row = null, legendEl = null, built = false;
  let classOfSink = new Map();        // sink label -> class id
  let stale = false, staleTimer = null;

  const acft = v => v / 43560;
  const ac = v => fmt(acft(v), v < 43560 ? 3 : 2);
  const on = () => SBMM.layerState.isOn("framework", "where_water");

  /* ------------------------------------------------------------------ */
  /* the class rule, derived from the network                            */
  /* ------------------------------------------------------------------ */
  /* THE IMPOUNDMENT'S DISCHARGE PIPES ARE THE CONDUITS WHOSE INLET NODE CARRIES
     A SURVEYED INVERT. On this network that is exactly the two 24-in barrels at
     the sandbag wall (`herman_pipe_n`, `herman_pipe_s`) — the only two nodes in
     `data/storm_network.json` with an `invert_ft`, and the two the August-2026
     Jacobs survey plotted. It is derived rather than named so that a future
     invert survey (docs/V19_HYDRO3_SPEC.md §3, `data/storm_survey.csv`) cannot
     silently move the class boundary: if more inverts land, `barrels()` falls
     back to the two ids, which are what the ruling of v22 §S is about. */
  const BARREL_IDS = ["herman_pipe_n", "herman_pipe_s"];
  function barrels() {
    if (!SBMM.storm || !SBMM.storm.data()) return [];
    const cds = SBMM.storm.data().conduits;
    const surveyed = cds.filter(c => {
      const n = SBMM.storm.node(c.from);
      return !!(n && n.invert_ft != null);
    }).map(c => c.id);
    /* the derivation is right while it names exactly the two barrels; anything
       else means the survey grew and the ids are the safer answer */
    const ok = surveyed.length === BARREL_IDS.length
      && BARREL_IDS.every(id => surveyed.indexOf(id) >= 0);
    return ok ? surveyed : BARREL_IDS.filter(id => SBMM.storm.conduit(id));
  }
  /* the id the kernel names an outlet after is the LAST conduit of the chain,
     so walk `next` forward from each barrel and collect the terminals */
  function hermanTerminals() {
    const out = new Set();
    if (!SBMM.storm) return out;
    for (const id of barrels()) {
      let k = id;
      const seen = new Set();
      while (k && !seen.has(k)) {
        seen.add(k);
        const nx = SBMM.storm.nextOf(k);
        if (!nx || nx === k) break;
        k = nx;
      }
      if (k) out.add(k);
    }
    return out;
  }
  /* a sink of the un-merged run -> one of the four classes */
  function classOf(sink, terminals) {
    if (sink.kind === "lake") return "lake";
    if (sink.kind === "outfall") return terminals.has(sink.via) ? "impound" : "ponds";
    /* off, loop, flat and a closed one-cell pit all mean the same thing to
       somebody standing on the ground: the map cannot follow the water off the
       surveyed edge, and a pit holds it where it fell */
    return "off";
  }

  /* ------------------------------------------------------------------ */
  /* the job — js/drainage.js jobFor(), with the outfalls left un-merged  */
  /* ------------------------------------------------------------------ */
  function stormOn() {
    return !!(SBMM.storm && SBMM.storm.data() && SBMM.storm.enabled());
  }
  function signature() {
    if (!stormOn()) return "off";
    const ids = SBMM.storm.data().conduits.map(c => c.id + ":" + SBMM.storm.statusOf(c.id));
    return "on|" + ids.join(",");
  }
  function conduitsForSite(dem) {
    if (!stormOn()) return [];
    const m = dem.m;
    const bbox = [m.x0, m.y0, m.x0 + m.w * m.cell, m.y0 + m.h * m.cell];
    return SBMM.storm.mapConduits(SBMM.storm.conduitsFor(bbox), { mergeOutfalls: false });
  }
  function jobFor(strideCells) {
    const dem = SBMM.demSite;
    if (!dem) return null;
    const grid = strideCells > 1 ? SBMM.compute.subGrid(dem, strideCells)
                                 : SBMM.compute.gridSpec(dem);
    const out = Math.max(1, Math.round(Math.sqrt((grid.sw * grid.sh) / 1.5e6)));
    return {
      grid,
      conduits: conduitsForSite(dem),
      captureFt: SBMM.storm ? SBMM.storm.captureFt() : 3,
      lakeRing: SBMM.drainage ? SBMM.drainage.lakeRing() : null,
      minPondDepth: SBMM.water ? SBMM.water.MIN_POND : 0.25,
      stride: out,
      /* the longest flow path per outlet is the drainage map's row, not this
         one's — and not asking for it is about a tenth of the run */
      longest: false
    };
  }

  async function run(opts) {
    opts = opts || {};
    if (running) return running;
    if (!SBMM.demSite) { toast("where the water goes needs the site terrain, which did not load"); return null; }
    const key = signature();
    if (R && runKey === key && !opts.force) return R;
    let strideCells = SBMM.lowMem() ? 2 : 1;
    running = (async () => {
      for (;;) {
        const job = jobFor(strideCells);
        if (!job) { toast("where the water goes needs the site terrain, which did not load"); return null; }
        try {
          const t0 = performance.now();
          const res = await SBMM.compute.run("drainage", job,
            { transfer: [job.grid.z.buffer], label: "Where the water goes" }).promise;
          res.ms_wall = Math.round(performance.now() - t0);
          res.gridFt = job.grid.cell;
          res.storm = stormOn();
          R = res; runKey = key; stale = false;
          reclass();
          return res;
        } catch (e) {
          if (e && e.cancelled) { toast("where the water goes cancelled"); return null; }
          const oom = /alloc|memory|Array buffer|out of/i.test(String(e.message || e));
          if (oom && strideCells < 2) {
            strideCells = 2;
            toast("not enough memory at 2 ft — running 'where the water goes' at 4 ft", 4200);
            continue;
          }
          toast("where the water goes failed: " + (e.message || e));
          return null;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  function reclass() {
    classOfSink = new Map();
    if (!R) return;
    const terminals = hermanTerminals();
    for (const s of R.sinks) classOfSink.set(s.label, classOf(s, terminals));
  }

  /* ------------------------------------------------------------------ */
  /* the four classes, as numbers                                        */
  /* ------------------------------------------------------------------ */
  /* the water bodies this class's chains pass through, named by EA's own water
     layer — so the sentence says "Frog Pond and Green Pond" because the data
     says so, not because this file does.

     TWO SOURCES, AND THE SECOND IS NOT A FALLBACK FOR NOTHING. js/drainage.js
     pondName() asks which EA water polygon contains the pond's lowest cell, and
     for the Herman impoundment it answers. For FROG POND AND GREEN POND IT DOES
     NOT: EA drew those two polygons at a water line the January-2024 lidar does
     not agree with, so the lidar depression's lowest cell falls just OUTSIDE
     the polygon and the drainage card calls both of them "Depression · E …".
     The storm network knows their names anyway — the conduit that drains each
     one starts at a node EA named ("Frog Pond outlet", "FES — Green Pond outlet
     (west shore)") — so the second source matches EA's own water-layer NAMES
     against that node's name. Both halves are data; neither is a literal. */
  let WNAMES = null;
  function waterNames() {
    if (WNAMES) return WNAMES;
    WNAMES = [];
    const D = window.SBMM_DATA && SBMM_DATA.design_gis;
    for (const f of ((D && D.features) || [])) {
      const p = f.properties || {};
      if (p.layer !== "water" || !p.name || p.name === "Unnamed Water Feature") continue;
      if (WNAMES.indexOf(p.name) < 0) WNAMES.push(p.name);
    }
    return WNAMES;
  }
  function nameFromNetwork(conduitId) {
    if (!SBMM.storm) return null;
    const c = SBMM.storm.conduit(conduitId);
    const n = c ? SBMM.storm.node(c.from) : null;
    if (!n || !n.name) return null;
    for (const w of waterNames()) if (n.name.indexOf(w) >= 0) return w;
    return null;
  }
  function pondsIn(id) {
    if (!R || !SBMM.drainage) return [];
    const names = [];
    for (const p of R.ponds) {
      if (!p.via) continue;
      if (classOfSink.get(p.terminal) !== id) continue;
      let n = SBMM.drainage.pondName(p);
      if (!n || /^Depression/.test(n)) n = nameFromNetwork(p.via);
      if (n && names.indexOf(n) < 0) names.push(n);
    }
    return names;
  }
  const listWords = a => a.length < 2 ? (a[0] || "")
    : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

  /* what the impoundment leaves through, read off the network */
  function barrelWords() {
    const ids = barrels();
    const sizes = [...new Set(ids.map(id => {
      const c = SBMM.storm && SBMM.storm.conduit(id);
      return c && c.size_in ? c.size_in + "-in" : null;
    }).filter(Boolean))];
    const n = ids.length === 2 ? "two" : ids.length === 1 ? "the" : String(ids.length);
    return ids.length ? `the ${n} ${sizes.length === 1 ? sizes[0] + " " : ""}`
      + (ids.length === 1 ? "pipe" : "pipes") : "the discharge pipes";
  }

  function sentence(id, area) {
    const A = ac(area) + " ac";
    if (id === "lake")
      return `${A} run overland into Clear Lake — they never enter a pipe and never leave the survey.`;
    if (id === "impound") {
      const direct = directIntoImpoundment();
      return `${A} drain into the Herman impoundment and leave through ${barrelWords()} to the `
        + `Clear Lake outfall` + (direct != null
          ? ` — of which ${ac(direct)} ac reach it directly, the rest through smaller depressions on the way.`
          : ".");
    }
    if (id === "ponds") {
      const names = pondsIn("ponds");
      return `${A} drain into ${names.length ? listWords(names) : "the eastern ponds"} and leave `
        + `through the road drain to the same Clear Lake outfall.`;
    }
    return `${A} leave the surveyed ground somewhere other than Clear Lake — the lidar stops at the `
      + `survey limit, so the map stops with it.`;
  }

  /* the impoundment's own first-capture area — the drainage card's 37.90 ac,
     which is NOT the catchment and is printed beside it so the two agree */
  function directIntoImpoundment() {
    if (!R) return null;
    const ids = new Set(barrels());
    let a = 0, found = false;
    for (const p of R.ponds) if (p.via && ids.has(p.via)) { a += p.contributing_area_ft2; found = true; }
    return found ? a : null;
  }

  function classes() {
    if (!R) return [];
    const tot = R.surveyedArea_ft2 || 1;
    return CLASSES.map(c => {
      const sinks = R.sinks.filter(s => classOfSink.get(s.label) === c.id);
      const area = sinks.reduce((a, s) => a + s.area_ft2, 0);
      return {
        id: c.id, label: c.label, color: c.color,
        area_ft2: area, acres: +acft(area).toFixed(3),
        share_pct: +(100 * area / tot).toFixed(2),
        outlets: sinks.map(s => s.id),
        sinks,
        sentence: sentence(c.id, area)
      };
    });
  }
  /* the class a point falls in, off the by-outlet raster this run returned */
  function classAt(x, y) {
    if (!R) return null;
    const i = Math.round((x - R.x0) / R.dCell), j = Math.round((y - R.y0) / R.dCell);
    if (i < 0 || j < 0 || i >= R.w || j >= R.h) return null;
    const lab = R.labels[j * R.w + i];
    return lab < 0 ? null : (classOfSink.get(lab) || null);
  }
  function classRec(id) { return classes().find(c => c.id === id) || null; }

  /* ------------------------------------------------------------------ */
  /* the layer                                                           */
  /* ------------------------------------------------------------------ */
  /* maskRings hands back every ring of an outlet with no word about which are
     holes — js/drainage.js toPolys()'s rule, and the same reason: an island in
     the middle of a catchment must not be painted solid. */
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
      for (const j of idx) if (depth[j] % 2 === 0 && j !== i
        && pointInPoly(rings[i][0][0], rings[i][0][1], rings[j])
        && (o < 0 || area(rings[j]) < area(rings[o]))) o = j;
      if (polys.has(o)) polys.get(o).push(rings[i]);
    }
    return [...polys.values()];
  }
  const toLL = ring => ring.map(p => [p[1], p[0]]);

  function clearLayers() {
    if (group) group.clearLayers();
    SBMM.labels.removeOwner("wherewater");
  }

  function paint() {
    if (!R || !group) return;
    clearLayers();
    const recs = classes();
    for (const c of recs) {
      for (const s of c.sinks) {
        for (const poly of toPolys(s.rings)) {
          const pl = L.polygon(poly.map(toLL), {
            pane: "vectors", color: c.color, weight: EDGE_W, opacity: .9,
            fillColor: c.color, fillOpacity: FILL_OP
          });
          pl.bindTooltip(`${esc(c.label)} · ${ac(c.area_ft2)} ac`, { sticky: true, className: "ctip" });
          pl.on("mouseover", () => pl.setStyle({ fillOpacity: FILL_OP + 0.22, weight: EDGE_W + 1 }));
          pl.on("mouseout", () => pl.setStyle({ fillOpacity: FILL_OP, weight: EDGE_W }));
          pl.on("click", ev => {
            L.DomEvent.stopPropagation(ev);
            pl.bindPopup(SBMM.popups.forWhereWater(c.id)).openPopup();
          });
          pl.addTo(group);
        }
      }
      /* one label per CLASS, not per outlet: four facts, four labels (v15 §2.2) */
      const big = c.sinks.slice().sort((a, b) => b.area_ft2 - a.area_ft2)[0];
      if (big && big.rings && big.rings.length && c.area_ft2 > 43560) {
        const p = centroid(big.rings[0]);
        const mk = L.marker([p[1], p[0]], {
          pane: "vectors", interactive: false, keyboard: false,
          icon: L.divIcon({ className: "drainlbl", html: `${esc(c.label)}<br>${ac(c.area_ft2)} ac` })
        }).addTo(group);
        SBMM.labels.add({ key: "ww:" + c.id, priority: SBMM.labels.PRI.drainage,
                          marker: mk, owner: "wherewater", latlng: [p[1], p[0]] });
      }
    }
    paintLegend();
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
  }

  function paintLegend() {
    if (!legendEl) return;
    const recs = R ? classes() : CLASSES.map(c => ({ ...c, area_ft2: null }));
    legendEl.innerHTML = recs.map(c =>
      `<span class="rnLeg" title="${esc(c.sentence || c.label)}"><i style="background:${c.color}"></i>`
      + `${esc(c.label)}${c.area_ft2 == null ? "" : " · " + ac(c.area_ft2) + " ac"}</span>`).join("");
  }

  async function ensure() {
    if (R && runKey === signature()) { paint(); return R; }
    const res = await run();
    if (!res) {
      SBMM.layerState.set("framework", "where_water", { on: false });
      return null;
    }
    paint();
    showCard();
    /* the design storm's card carries a row per class (§C); if it is already on
       screen it must pick the new numbers up rather than wait to be re-run */
    if (SBMM.runoff && SBMM.runoff.refreshCard) SBMM.runoff.refreshCard();
    return res;
  }

  function build() {
    group = L.layerGroup();
    row = SBMM.addLayerRow("proj", "Where the water goes", group,
      { id: "where_water", checked: false, swatch: CBY.impound.color,
        sub: "Drainage (lidar + storm drains)",
        onChange: st => { if (st.on) ensure(); } });
    row.row.title = "The four areas the site drains to: Clear Lake overland, the Herman "
      + "impoundment, Frog/Green Pond, and off the surveyed ground. Terrain only.";
    /* the legend goes AFTER the row, outside it: js/layertree.js reorders the
       `.lyr` elements among themselves and leaves everything else alone */
    if (row.row.parentNode) {
      legendEl = document.createElement("div");
      legendEl.className = "rnLegend wwLegend";
      row.row.parentNode.appendChild(legendEl);
      paintLegend();
    }
    built = true;
  }

  function markStale() {
    if (!R) return;
    if (signature() === runKey) return;
    stale = true;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(async () => {
      staleTimer = null;
      if (!on()) return;
      toast("where the water goes is stale — recomputing", 3200);
      const res = await run({ force: true });
      if (res) { paint(); showCard(); }
    }, 400);
  }

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  function tableHtml() {
    const recs = classes();
    const rowsH = recs.map(c =>
      `<tr><td class="k"><span class="wwsw" style="background:${c.color}"></span>${esc(c.label)}</td>`
      + `<td class="v mono">${ac(c.area_ft2)} ac</td>`
      + `<td class="v mono">${fmt(c.share_pct, 1)} %</td></tr>`
      + `<tr><td class="k wwsay" colspan="3">${esc(c.sentence)}</td></tr>`).join("");
    return `<div class="dspopwrap"><table class="dspop">
      <tr><td class="k"><b>where it goes</b></td><td class="v"><b>acres</b></td><td class="v"><b>share</b></td></tr>
      ${rowsH}</table></div>`;
  }

  function csv() {
    if (!R) return "";
    let out = "SBMM where the water goes\n";
    out += "grid_ft," + R.gridFt + ",storm_drains," + (R.storm ? "assumed working" : "off")
      + ",surveyed_acres," + acft(R.surveyedArea_ft2).toFixed(2) + "\n\n";
    out += "class,acres,share_pct,outlets,what happens\n";
    for (const c of classes())
      out += `"${c.label.replace(/"/g, '""')}",${c.acres.toFixed(3)},${c.share_pct.toFixed(2)},`
        + `"${c.outlets.join(" ")}","${c.sentence.replace(/"/g, '""')}"\n`;
    return out;
  }

  function showCard() {
    if (!R) return;
    if (card && card.isConnected) card.remove();
    card = SBMM.results.card(null, "Where the water goes", [
      ["Surveyed area", ac(R.surveyedArea_ft2) + " ac"],
      ["Grid", R.gridFt + "-ft lidar grid" + (R.gridFt > 2 ? " (decimated)" : "")],
      ["Storm drains", R.storm ? "assumed working" : "off — ground only"],
      ["Run time", fmt0(R.ms_wall) + " ms"]
    ]);
    const box = document.createElement("div");
    box.innerHTML = tableHtml();
    card.appendChild(box);
    const acts = document.createElement("div");
    acts.className = "pop-actions";
    acts.innerHTML = `<span class="minib" data-w="show" title="Show the four areas on the map">show on the map</span>`
      + `<span class="minib" data-w="3d" title="Open the 3D view with the four areas draped on the terrain">show in 3D</span>`
      + `<span class="minib" data-w="csv" title="Copy the four areas as CSV">copy CSV</span>`
      + `<span class="minib" data-w="gj" title="Export the four areas as GeoJSON">GeoJSON</span>`
      + `<span class="minib" data-w="re" title="Run the analysis again">recompute</span>`;
    acts.addEventListener("click", async ev => {
      const b = ev.target.closest("[data-w]"); if (!b) return;
      const a = b.dataset.w;
      if (a === "csv") copyText(csv(), "the four areas copied");
      else if (a === "gj") exportGeoJSON();
      else if (a === "show") { SBMM.layerState.set("framework", "where_water", { on: true }); paint(); }
      else if (a === "3d") show3d();
      else if (a === "re") { const res = await run({ force: true }); if (res) { paint(); showCard(); } }
    });
    card.appendChild(acts);
    SBMM.results.appendNote(card, NOTE);
  }

  function show3d() {
    SBMM.layerState.set("framework", "where_water", { on: true });
    paint();
    if (!SBMM.viewer3d) { toast("this build has no 3D view"); return; }
    if (!SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
    else SBMM.viewer3d.refreshOverlays();
    toast("the four areas are draped on the terrain", 3200);
  }

  /* ------------------------------------------------------------------ */
  /* exports                                                             */
  /* ------------------------------------------------------------------ */
  function props(c, s) {
    return {
      layer: "WATER-GOES", class: c.id, where: c.label,
      acres: c.acres, share_pct: c.share_pct,
      outlet: s ? s.id : null,
      what_happens: c.sentence,
      grid_ft: R.gridFt, storm_drains: R.storm ? "assumed working" : "off",
      source: "SBMM where the water goes v22"
    };
  }
  function geoFeatures(P) {
    if (!R) return [];
    const out = [];
    for (const c of classes())
      for (const s of c.sinks)
        for (const poly of toPolys(s.rings))
          out.push({ type: "Feature", properties: props(c, s),
                     geometry: { type: "Polygon", coordinates: poly.map(r => r.map(P)) } });
    return out;
  }
  function dxfEntities() {
    if (!R) return [];
    const out = [];
    for (const c of classes())
      for (const s of c.sinks)
        for (const ring of (s.rings || []))
          out.push({ layer: "WATER-GOES", color: c.color, closed: true, pts: ring });
    return out;
  }
  function exportGeoJSON() {
    if (!R) { toast("run 'where the water goes' first (WHEREWATER)"); return; }
    const P = p => SBMM.toLL(p[0], p[1]);
    const gj = { type: "FeatureCollection",
                 metadata: { source: "SBMM where the water goes v22", crs: "WGS84",
                             grid_ft: R.gridFt, storm_drains: R.storm ? "assumed working" : "off",
                             note: NOTE },
                 features: geoFeatures(P) };
    download("SBMM_where_the_water_goes.geojson",
             new Blob([JSON.stringify(gj)], { type: "application/geo+json" }));
    toast("the four areas exported as GeoJSON");
  }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  /* Same rule as the drainage map's: a class boundary follows the edge of the
     surveyed ground, and a closed drape there stands up as a 70-ft curtain out
     over Clear Lake. js/drainage.js groundRuns() is that rule, and it is shared
     rather than copied so the two cannot drift. */
  function rings3d() {
    if (!R || !on() || !SBMM.drainage) return [];
    const out = [];
    for (const c of classes())
      for (const s of c.sinks)
        for (const ring of (s.rings || []))
          for (const run2 of SBMM.drainage.groundRuns(ring))
            out.push({ ring: run2, color: c.color, width: 3, closed: false,
                       props: props(c, s), cls: c.id,
                       geom: { type: "LineString", coordinates: run2 } });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* chrome                                                              */
  /* ------------------------------------------------------------------ */
  async function cmd() {
    if (!built) { toast("'where the water goes' is not available in this build"); return; }
    const res = await ensure();
    if (!res) return;
    SBMM.layerState.set("framework", "where_water", { on: true });
    paint();
    showCard();
    const c = classRec("impound");
    toast(`where the water goes: ${c ? ac(c.area_ft2) + " ac into the impoundment" : "four areas"} `
        + `on the ${R.gridFt}-ft grid`, 4200);
  }

  function wire() {
    if (SBMM.events) {
      SBMM.events.on("layers", ({ group: g, layer }) => {
        if (g !== "framework") return;
        if (layer === "where_water") paint();
      });
    }
  }

  return {
    build, wire, cmd, run, paint, showCard, markStale, show3d,
    classes, classRec, classAt, rings3d, geoFeatures, dxfEntities, csv, exportGeoJSON,
    barrels, hermanTerminals, directIntoImpoundment,
    result: () => R, hasResult: () => !!R, isStale: () => stale,
    CLASSES, NOTE
  };
})();
