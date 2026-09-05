/* SBMM Site Explorer — the design storm (v14 Phase 2, docs/V14_PHASE2_RUNOFF_SPEC.md).

   Phase 1 answered "where does the water go". This answers "how much, in a
   design storm" — and it does it over Phase 1's own catchments, so the two can
   never disagree about which ground drains where.

   EVERY NUMBER HERE RESTS ON AN ASSUMPTION, AND EVERY ASSUMPTION IS PRINTED.
   The rainfall depths, the temporal distribution, the hydrologic soil group,
   the curve numbers, the cover raster's priority order, the TR-55 segment rule
   and the pond outlet ratings are all rulings of the spec's §1 table; the
   Design storm dialog can change every one of them, the card prints them all,
   and the report sheet leads with them. While `data/atlas14_sbmm.csv` is
   absent the rainfall payload says `provisional: true` and the card carries a
   red warning — the depths are approximately right for this location and are
   NOT the PFDS export.

   What is where:
     * the arithmetic          js/compute.js `runoff` (api VERSION 9)
     * the catchments          js/drainage.js (the Phase 1 label raster)
     * the stage-storage       js/water.js stageTable() -> the `overtop` kernel
     * the routing             this file, `route()` — level-pool (Modified Puls)
     * the cover raster        tools/build_cover.py -> SBMM_DATA.cover/cover_png
     * the rainfall            tools/build_rainfall.py -> SBMM_DATA.rainfall

   Read-only project analysis, like js/drainage.js: nothing here is a store
   feature and nothing serialises — EXCEPT the cover override areas, which are
   ordinary `area` features carrying `props.cover` and therefore ride in the
   session like anything else the user drew.

   NOT IN SCOPE (spec §5): a rain-on-grid solver, continuous simulation,
   evaporation, seepage, water quality. And no pipe capacity: the conduits have
   no surveyed size or invert, so a pond that discharges through one is reported
   as passing its inflow with "capacity unknown — survey pending". */
"use strict";

SBMM.runoff = (function () {

  const AC = 43560;
  const NOTE = "Planning-level: NRCS curve-number runoff over the lidar catchments, "
    + "TR-55 time of concentration, an SCS unit hydrograph and level-pool routing. "
    + "No infiltration model, no pipe capacity, no continuous simulation — every "
    + "assumption is listed above and can be changed in the Design storm dialog.";
  const WEIR_C = 3.0;          // broad-crested weir coefficient, Q = C·L·H^1.5

  let R = null;                // the last run { outlets, first, storm, routing, ... }
  let cover = null;            // { data:Uint8Array, w, h, cell, x0, y0 }
  let coverBusy = null;
  let rows = {}, groups = {}, built = false, card = null;
  let overlay = null;          // the cover image overlay
  let pending = null;          // "draw a cover area" — the class the next area gets
  let opts = null;             // the dialog's settings, remembered for the session

  const acft = v => v / AC;
  const ac = v => fmt(acft(v), v < AC ? 3 : 2);
  const DATA = () => window.SBMM_DATA || {};
  const RAIN = () => DATA().rainfall || null;
  const COVER = () => DATA().cover || null;

  /* ------------------------------------------------------------------ */
  /* the settings — the spec §1 rulings, all changeable                  */
  /* ------------------------------------------------------------------ */
  function defaults() {
    return {
      storm: "25:24",              // "<ari>:<duration hours>" or "custom"
      customP: 6.4, customD: 24,
      dist: "IA",
      hsgOf: {},                   // classId -> "C"|"D", empty = the class's own
      cn: {},                      // classId -> {C,D} override
      sheetMax_ft: 100, channelStart_ac: 5, channelN: 0.035, channelR_ft: 1.0,
      minTc_min: 6, rationalMaxAc: 200, dt_min: 6,
      route: true
    };
  }
  function settings() { if (!opts) opts = defaults(); return opts; }

  /* ------------------------------------------------------------------ */
  /* rainfall                                                            */
  /* ------------------------------------------------------------------ */
  function durKeyHours(k) {
    const t = RAIN() && RAIN().table && RAIN().table[k];
    return t ? t.hours : NaN;
  }
  /* the depth for an ARI at a duration: the table's own row where there is one,
     else log-log interpolation across the durations it does have */
  function depthFor(ari, hours) {
    const rain = RAIN();
    if (!rain || !rain.table) return NaN;
    const pts = [];
    for (const k of (rain.durations || Object.keys(rain.table))) {
      const row = rain.table[k];
      if (!row || !row.depths) continue;
      const v = row.depths[String(ari)];
      if (v == null) continue;
      pts.push([row.hours, +v]);
    }
    if (!pts.length) return NaN;
    pts.sort((a, b) => a[0] - b[0]);
    for (const p of pts) if (Math.abs(p[0] - hours) < 1e-9) return p[1];
    if (pts.length === 1) return pts[0][1];
    let a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length; i++) {
      if (hours <= pts[i][0]) { a = pts[i - 1]; b = pts[i]; break; }
      if (i === pts.length - 1) { a = pts[i - 1]; b = pts[i]; }
    }
    const t = (Math.log(Math.max(hours, 1e-6)) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
    return Math.exp(Math.log(a[1]) + t * (Math.log(b[1]) - Math.log(a[1])));
  }
  /* the ARI's own depth-duration curve, which is what the Rational intensity
     is read off at Tc */
  function idfFor(ari) {
    const rain = RAIN();
    const out = [];
    if (!rain || !rain.table) return out;
    for (const k of (rain.durations || Object.keys(rain.table))) {
      const row = rain.table[k];
      if (!row || !row.depths) continue;
      const v = row.depths[String(ari)];
      if (v == null) continue;
      out.push([row.hours, +v]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }
  /* the storms the dialog offers (spec §1 "Storms offered") */
  function storms() {
    const rain = RAIN();
    const list = [];
    if (rain) {
      for (const ari of [2, 10, 25, 100]) {
        const P = depthFor(ari, 24);
        if (!isNaN(P)) list.push({ id: ari + ":24", ari, hours: 24, P,
                                   name: ari + "-year, 24-hour" });
      }
      const p1 = depthFor(25, 1);
      if (!isNaN(p1)) list.push({ id: "25:1", ari: 25, hours: 1, P: p1,
                                  name: "25-year, 1-hour (the pipes)" });
    }
    return list;
  }
  function stormOf(s) {
    if (s.storm === "custom")
      return { id: "custom", ari: null, hours: s.customD, P: s.customP,
               name: `custom ${fmt(s.customP, 2)} in in ${fmt(s.customD, 2)} h` };
    return storms().find(q => q.id === s.storm) || storms()[0] || null;
  }
  function provisional() { return !!(RAIN() && RAIN().provisional); }

  /* ------------------------------------------------------------------ */
  /* the cover raster                                                    */
  /* ------------------------------------------------------------------ */
  function classes() {
    const c = COVER();
    return (c && c.classes) ? c.classes : [];
  }
  function classOf(id) { return classes().find(c => c.id === id) || null; }
  function classByKey(k) { return classes().find(c => c.key === k) || null; }

  /* decode once, lazily; the payload is an 8-bit RGB PNG whose colours ARE the
     class palette, so the decode is a colour->id lookup and the same PNG is
     what the map draws */
  async function coverRaster() {
    if (cover) return cover;
    if (coverBusy) return coverBusy;
    const meta = COVER(), url = DATA().cover_png;
    if (!meta || !url) return null;
    coverBusy = (async () => {
      try {
        const g = await Dem.context(url, meta.grid);
        const px = g.getImageData(0, 0, meta.grid.w, meta.grid.h).data;
        const w = meta.grid.w, h = meta.grid.h;
        const key = new Map();
        for (const c of meta.classes) key.set((c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2], c.id);
        const out = new Uint8Array(w * h);
        for (let r = 0; r < h; r++) {
          const dst = (h - 1 - r) * w;                 // PNG row 0 = north
          for (let i = 0; i < w; i++) {
            const k = (r * w + i) * 4;
            const id = key.get((px[k] << 16) | (px[k + 1] << 8) | px[k + 2]);
            out[dst + i] = id == null ? 0 : id;
          }
        }
        cover = { data: out, w, h, cell: meta.grid.cell, x0: meta.grid.x0, y0: meta.grid.y0 };
        return cover;
      } catch (e) {
        console.warn("cover raster decode failed", e);
        toast("the land-cover raster did not decode — the storm would have no curve numbers");
        return null;
      } finally { coverBusy = null; }
    })();
    return coverBusy;
  }

  /* every cover override the user has drawn: an ordinary `area` feature with
     props.cover = a class key */
  function overrides() {
    const out = [];
    for (const f of SBMM.store.features) {
      if (f.type !== "area" || !f.props || !f.props.cover) continue;
      const c = classByKey(f.props.cover);
      if (!c || !f.pts || f.pts.length < 3) continue;
      out.push({ ring: f.pts.map(p => [p[0], p[1]]), cls: c.id, key: c.key,
                 name: f.name, id: f.id });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* building the job the way the card reports it                        */
  /* ------------------------------------------------------------------ */
  /* A sink's longest flow path comes straight out of Phase 1; the z's come from
     SBMM.elev here rather than in the kernel, which keeps the kernel free of
     terrain (it is pure arithmetic over two rasters and a list). */
  function liftPath(path) {
    const out = [];
    for (const p of (path || [])) {
      const [z] = SBMM.elev(p[0], p[1]);
      if (isNaN(z)) continue;
      out.push([p[0], p[1], z]);
    }
    return out;
  }
  /* A first-capture catchment (a pond, an inlet) has no path polyline in Phase
     1 — only its LENGTH and mean slope. So the path handed to the kernel is a
     straight line into the pond of exactly that length, carrying the real fall
     between the catchment's farthest ring vertex and the pond: TR-55 wants a
     length and a slope, and both are then Phase 1's own numbers. The card says
     so. */
  function synthPath(rec, entry) {
    const rings = rec.contributing_rings || rec.rings || [];
    let far = null, fd = -1;
    for (const ring of rings) for (const p of ring) {
      const d = Math.hypot(p[0] - entry[0], p[1] - entry[1]);
      if (d > fd) { fd = d; far = p; }
    }
    if (!far || !(rec.longest_ft > 0)) return [];
    const [zf] = SBMM.elev(far[0], far[1]);
    const [ze] = SBMM.elev(entry[0], entry[1]);
    if (isNaN(zf) || isNaN(ze)) return [];
    const L = rec.longest_ft, dx = (entry[0] - far[0]) / (fd || 1), dy = (entry[1] - far[1]) / (fd || 1);
    return [[entry[0] - dx * L, entry[1] - dy * L, zf], [entry[0], entry[1], ze]];
  }

  function jobFor(labels, cats, st, storm) {
    const rain = RAIN();
    const grass = classByKey("grass");
    return {
      labels, cover,
      classes: classes().map(c => ({
        id: c.id, key: c.key, hsg: c.hsg, c: c.c, n_sheet: c.n_sheet, paved: c.paved,
        cn: (st.cn && st.cn[c.id]) ? st.cn[c.id] : c.cn
      })),
      hsgOf: st.hsgOf || {},
      overrides: overrides().map(o => ({ ring: o.ring, cls: o.cls })),
      catchments: cats,
      storm: { name: storm.name, P_in: storm.P, duration_h: storm.hours,
               dt_min: st.dt_min, distName: st.dist,
               dist: (rain && rain.distributions && rain.distributions[st.dist]) || null },
      idf: idfFor(storm.ari || 25),
      P2_24_in: depthFor(2, 24),
      defaultClass: grass ? grass.id : -1,
      sheetMax_ft: st.sheetMax_ft, channelStart_ac: st.channelStart_ac,
      channelN: st.channelN, channelR_ft: st.channelR_ft,
      minTc_min: st.minTc_min, rationalMaxAc: st.rationalMaxAc
    };
  }

  /* ------------------------------------------------------------------ */
  /* the run                                                             */
  /* ------------------------------------------------------------------ */
  async function run(o) {
    o = o || {};
    const st = settings();
    if (o.storm) st.storm = o.storm;
    const storm = stormOf(st);
    if (!storm) { toast("this build has no rainfall table — the design storm needs datajs/d_rainfall.js"); return null; }
    if (!SBMM.drainage) { toast("the design storm needs the drainage map, which is not in this build"); return null; }
    const cv = await coverRaster();
    if (!cv) { toast("this build has no land-cover raster — the design storm needs datajs/i_cover_png.js"); return null; }
    const D = await SBMM.drainage.run();
    if (!D) return null;                       // drainage already toasted

    /* the by-outlet catchments — Phase 1's sinks, with its own areas */
    const outletCats = D.sinks.map(s => ({
      label: s.label, kind: s.kind, name: SBMM.drainage.sinkName(s),
      area_ft2: s.area_ft2, path: liftPath(s.path)
    })).filter(c => c.area_ft2 > 0);

    /* the by-first-capture catchments — the ponds and the inlets */
    const firstCats = [];
    for (const p of D.ponds) {
      if (!(p.contributing_area_ft2 > 0)) continue;
      firstCats.push({ label: p.label, kind: "pond", name: SBMM.drainage.pondName(p),
                       area_ft2: p.contributing_area_ft2, path: synthPath(p, p.entry),
                       via: p.via || null, level: p.level, pondRef: p });
    }
    for (const q of D.inlets) {
      if (!(q.area_ft2 > 0)) continue;
      firstCats.push({ label: q.label, kind: "inlet", name: SBMM.drainage.inletName(q),
                       area_ft2: q.area_ft2, path: synthPath(q, [q.x, q.y]), via: q.id });
    }

    const labels = { data: D.labels, w: D.w, h: D.h, cell: D.dCell, x0: D.x0, y0: D.y0 };
    const first = { data: D.first, w: D.w, h: D.h, cell: D.dCell, x0: D.x0, y0: D.y0 };

    let A, B;
    try {
      const t0 = performance.now();
      A = await SBMM.compute.run("runoff", jobFor(labels, outletCats, st, storm),
        { label: "Design storm — " + storm.name }).promise;
      B = firstCats.length
        ? await SBMM.compute.run("runoff", jobFor(first, firstCats, st, storm),
            { label: "Design storm — ponds and inlets", silent: true }).promise
        : { catchments: [], totals: null };
      A.ms_wall = Math.round(performance.now() - t0);
    } catch (e) {
      if (e && e.cancelled) { toast("design storm cancelled"); return null; }
      toast("the design storm failed: " + (e.message || e));
      return null;
    }

    R = {
      storm, settings: JSON.parse(JSON.stringify(st)),
      outlets: A.catchments, totals: A.totals, first: B.catchments,
      assumptions: A.assumptions, gridFt: D.gridFt, dCell: D.dCell,
      provisional: provisional(), rain: RAIN(), cover: COVER(),
      overrides: overrides(), drains: D.storm, ms: A.ms_wall,
      dt_min: A.catchments.length ? A.catchments[0].hydro.dt_min : st.dt_min,
      routing: []
    };
    for (const c of R.first) {
      const src = firstCats.find(q => q.label === c.label);
      if (src) { c.via = src.via; c.kindSrc = src.kind; c.pondRef = src.pondRef || null; }
    }
    if (st.route) {
      try { R.routing = await routeAll(D); }
      catch (e) { console.warn(e); toast("pond routing failed: " + (e.message || e)); }
    }
    paintDepth();
    showCard();
    return R;
  }

  /* ------------------------------------------------------------------ */
  /* level-pool routing (Modified Puls)                                  */
  /* ------------------------------------------------------------------ */
  /* Storage from the overtopping kernel's own stage table, outflow from a
     broad-crested weir over the rim (Q = 3.0·L·H^1.5, L = the width of the rim
     low cluster) plus, once the level reaches a conduit inlet, that conduit
     PASSING ITS INFLOW: the pipes have no surveyed size or invert, so there is
     no rating to apply and the card says "capacity unknown — survey pending"
     rather than inventing one. The step is implicit and solved by bisection,
     which is what makes the volume identity exact rather than approximate. */
  function interp(stage, level, key) {
    if (!stage.length) return 0;
    if (level <= stage[0].level) return stage[0][key] * 0;
    for (let i = 1; i < stage.length; i++) {
      if (level <= stage[i].level) {
        const t = (level - stage[i - 1].level) / ((stage[i].level - stage[i - 1].level) || 1e-9);
        return stage[i - 1][key] + t * (stage[i][key] - stage[i - 1][key]);
      }
    }
    /* above the table: keep going at the top row's surface area */
    const top = stage[stage.length - 1];
    if (key === "storage_ft3") return top.storage_ft3 + (level - top.level) * top.area_ft2;
    return top.area_ft2;
  }
  function levelFor(stage, storage) {
    if (!stage.length) return NaN;
    let lo = stage[0].level, hi = stage[stage.length - 1].level + 20;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (interp(stage, mid, "storage_ft3") < storage) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function routeOne(spec) {
    const { name, stage, rimLevel, weirLen, conduitLevel, conduitId, inflow, dtMin } = spec;
    const dt = dtMin * 60;                                   // seconds
    const outQ = level => {
      let q = 0;
      if (rimLevel != null && level > rimLevel)
        q += WEIR_C * Math.max(1, weirLen) * Math.pow(level - rimLevel, 1.5);
      return q;
    };
    const passes = level => conduitLevel != null && level >= conduitLevel;
    let S = interp(stage, stage[0].level, "storage_ft3");
    let level = stage[0].level, O = 0;
    let peakLevel = level, peakT = 0, peakO = 0, overT = null, conduitT = null;
    const series = [];
    let volIn = 0, volOut = 0;
    for (let i = 1; i < inflow.length; i++) {
      const I0 = inflow[i - 1], I1 = inflow[i];
      /* the conduit's pass-through depends on the inflow at the END of the
         step, which keeps O(S) monotone and the bisection valid */
      const pass = I1;
      const f = Sx => {
        const lx = levelFor(stage, Sx);
        const Ox = outQ(lx) + (passes(lx) ? pass : 0);
        return Sx - S - dt * ((I0 + I1) / 2 - (O + Ox) / 2);
      };
      let lo = Math.max(0, S - dt * (O + 1)), hi = S + dt * (I0 + I1 + 1);
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < 0) lo = mid; else hi = mid;
      }
      const Sn = (lo + hi) / 2;
      const ln = levelFor(stage, Sn);
      const On = outQ(ln) + (passes(ln) ? pass : 0);
      volIn += dt * (I0 + I1) / 2;
      volOut += dt * (O + On) / 2;
      S = Sn; level = ln; O = On;
      if (level > peakLevel) { peakLevel = level; peakT = i * dtMin / 60; }
      if (O > peakO) peakO = O;
      if (overT == null && rimLevel != null && level > rimLevel) overT = i * dtMin / 60;
      if (conduitT == null && passes(level)) conduitT = i * dtMin / 60;
      series.push(level);
    }
    const S0 = interp(stage, stage[0].level, "storage_ft3");
    return {
      name, stage0: stage[0].level, rimLevel, conduitLevel, conduitId, weirLen,
      peakLevel: +peakLevel.toFixed(2), peakT_h: +peakT.toFixed(2),
      peakOut_cfs: +peakO.toFixed(1),
      overtops: overT != null, overtopT_h: overT == null ? null : +overT.toFixed(2),
      throughConduit: conduitT != null, conduitT_h: conduitT == null ? null : +conduitT.toFixed(2),
      freeboard_ft: rimLevel == null ? null : +(rimLevel - peakLevel).toFixed(2),
      volIn_acft: +(volIn / AC).toFixed(2), volOut_acft: +(volOut / AC).toFixed(2),
      dStorage_acft: +((S - S0) / AC).toFixed(2),
      balance_pct: volIn > 0 ? +(100 * (volIn - volOut - (S - S0)) / volIn).toFixed(3) : 0,
      inflowPeak_cfs: +Math.max.apply(null, inflow).toFixed(1),
      series, dt_min: dtMin, capacityUnknown: conduitLevel != null
    };
  }

  /* EA's own water polygon around a point, if there is one — the seed a stage
     table wants (see routeAll). Named polygons only: an unnamed sliver is not
     the pond anyone is routing. */
  function waterRingAt(x, y) {
    const D = DATA().design_gis;
    if (!D || !D.features) return null;
    for (const f of D.features) {
      const p = f.properties || {};
      if (p.layer !== "water" || !p.name || p.name === "Unnamed Water Feature") continue;
      if (!f.geometry || f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0];
      if (pointInPoly(x, y, ring)) return { name: p.name, ring: ring.map(q => [q[0], q[1]]) };
    }
    return null;
  }

  /* Which ponds get routed, in chain order, and where each one's inflow comes
     from. The chain is read off the network rather than named here: a pond
     whose conduit discharges INSIDE another routed pond is upstream of it. */
  async function routeAll(D) {
    const wanted = R.first.filter(c => c.kindSrc === "pond" && c.pondRef
                                    && c.pondRef.area_ft2 > 20000);
    if (!wanted.length) return [];
    const out = [];
    const tables = new Map();
    for (const c of wanted) {
      const p = c.pondRef;
      /* Seed the stage table with EA's own water polygon where the pond has
         one: a ring seed is what lets js/water.js apply the AUGUST-2026 SURVEY
         (the impoundment's surveyed water surface and the exact stage rows at
         the two 24-in pipe inverts and the sandbag crest). A point seed would
         route the impoundment off the lidar's January-2024 water surface and
         lose the 1341.55 row the card is checked against. */
      const wr = waterRingAt(p.entry[0], p.entry[1]);
      const T = await SBMM.water.stageTable(wr
        ? { ring: wr.ring, name: wr.name }
        : { point: p.entry, name: c.name });
      if (!T || !T.stage || !T.stage.length) continue;
      tables.set(c.label, T);
    }
    /* the chain: pond -> the routed pond its conduit discharges into, if any */
    const downstream = new Map();
    for (const c of wanted) {
      if (!c.via || !SBMM.storm) continue;
      const cd = SBMM.storm.conduit(c.via);
      const to = cd ? SBMM.storm.node(cd.to) : null;
      if (!to) continue;
      for (const q of wanted) {
        if (q === c) continue;
        const rings = (q.pondRef.rings || []);
        if (rings.some(r => pointInPoly(to.x, to.y, r))) { downstream.set(c.label, q.label); break; }
      }
    }
    /* head ponds first */
    const order = [], seen = new Set();
    const visit = c => {
      if (seen.has(c.label)) return;
      seen.add(c.label);
      order.push(c);
      const d = downstream.get(c.label);
      if (d) { const q = wanted.find(x => x.label === d); if (q) visit(q); }
    };
    for (const c of wanted) if (![...downstream.values()].includes(c.label)) visit(c);
    for (const c of wanted) visit(c);

    const extra = new Map();                 // label -> an upstream outflow series
    for (const c of order) {
      const T = tables.get(c.label);
      if (!T) continue;
      const base = (c.hydro && c.hydro.q) ? c.hydro.q.slice() : [];
      const add = extra.get(c.label);
      if (add) for (let i = 0; i < base.length; i++) base[i] += (add[i] || 0);
      if (!base.length) continue;
      const cl = T.conduitSpill
        ? (T.conduitSpill.stageLevel != null ? T.conduitSpill.stageLevel : T.conduitSpill.level)
        : null;
      const cluster = (T.clusters && T.clusters.length) ? T.clusters[0] : null;
      const rr = routeOne({
        name: c.name, stage: T.stage, rimLevel: T.primary.level,
        weirLen: cluster ? Math.max(T.cell, cluster.cells * T.cell) : T.cell,
        conduitLevel: cl, conduitId: T.conduitSpill ? T.conduitSpill.id : null,
        /* the INFLOW's own step, not the outlet run's: each job picks a step no
           coarser than a tenth of the shortest Tp it was given, and the two
           jobs were given different catchments */
        inflow: base, dtMin: c.hydro.dt_min
      });
      rr.label = c.label;
      rr.area_ac = c.area_ac;
      rr.volume_acft = c.volume_acft;
      out.push(rr);
      /* what leaves this pond arrives at the next one down the chain */
      const d = downstream.get(c.label);
      if (d) {
        const series = [];
        let O = 0;
        /* the routed outflow series, reconstructed from the stage series */
        for (let i = 0; i < rr.series.length; i++) {
          const lv = rr.series[i];
          O = (rr.rimLevel != null && lv > rr.rimLevel)
            ? WEIR_C * Math.max(1, rr.weirLen) * Math.pow(lv - rr.rimLevel, 1.5) : 0;
          if (rr.conduitLevel != null && lv >= rr.conduitLevel) O += base[i + 1] || 0;
          series.push(O);
        }
        extra.set(d, series);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  function hydroSVG(c) {
    const q = c.hydro && c.hydro.q ? c.hydro.q : [];
    if (q.length < 3) return "";
    const W = 300, H = 96, Lm = 34, Rm = 6, Tm = 8, Bm = 16;
    const n = Math.min(400, q.length);
    const step = q.length / n;
    const pk = Math.max.apply(null, q) || 1;
    const tEnd = (q.length - 1) * (c.hydro.dt_min / 60);
    const X = t => Lm + (t / (tEnd || 1)) * (W - Lm - Rm);
    const Y = v => H - Bm - (v / pk) * (H - Tm - Bm);
    let d = "";
    for (let i = 0; i < n; i++) {
      const k = Math.min(q.length - 1, Math.round(i * step));
      d += (i ? "L" : "M") + X(k * c.hydro.dt_min / 60).toFixed(1) + " " + Y(q[k]).toFixed(1) + " ";
    }
    return `<svg class="hydro" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      <path d="${d}" fill="none" stroke="var(--acc)" stroke-width="1.4"/>
      <line x1="${Lm}" y1="${H - Bm}" x2="${W - Rm}" y2="${H - Bm}" stroke="var(--line2)"/>
      <line x1="${Lm}" y1="${Tm}" x2="${Lm}" y2="${H - Bm}" stroke="var(--line2)"/>
      <text x="${Lm - 3}" y="${Tm + 8}" text-anchor="end">${fmt(pk, 0)}</text>
      <text x="${Lm - 3}" y="${H - Bm}" text-anchor="end">0</text>
      <text x="${Lm}" y="${H - 3}">0 h</text>
      <text x="${W - Rm}" y="${H - 3}" text-anchor="end">${fmt(tEnd, 0)} h · cfs</text>
    </svg>`;
  }

  function tableHtml() {
    const rowsH = R.outlets.slice().sort((a, b) => b.area_ft2 - a.area_ft2).map(c =>
      `<tr><td class="k">${esc(c.name)}</td>`
      + `<td class="v mono">${fmt(c.area_ac, 2)}</td>`
      + `<td class="v mono">${fmt(c.cn, 0)}</td>`
      + `<td class="v mono">${fmt(c.Q_in, 2)}</td>`
      + `<td class="v mono">${fmt(c.volume_acft, 2)}</td>`
      + `<td class="v mono">${fmt(c.tc_min, 0)}</td>`
      + `<td class="v mono">${c.qRational_cfs == null ? "—" : fmt(c.qRational_cfs, 0)}</td>`
      + `<td class="v mono">${fmt(c.qPeak_cfs, 0)}</td></tr>`).join("");
    return `<div class="dspopwrap"><table class="dspop runoffT">
      <tr><td class="k"><b>catchment</b></td><td class="v"><b>ac</b></td><td class="v"><b>CN</b></td>
          <td class="v"><b>Q in</b></td><td class="v"><b>ac-ft</b></td><td class="v"><b>Tc min</b></td>
          <td class="v"><b>Rational cfs</b></td><td class="v"><b>SCS cfs</b></td></tr>
      ${rowsH}</table></div>`;
  }
  function routeHtml() {
    if (!R.routing.length) return "";
    const rowsH = R.routing.map(r =>
      `<tr><td class="k">${esc(r.name)}</td>`
      + `<td class="v mono">${fmt(r.peakLevel, 2)}</td>`
      + `<td class="v mono">${r.freeboard_ft == null ? "—" : fmt(r.freeboard_ft, 2)}</td>`
      + `<td class="v mono">${fmt(r.peakT_h, 1)}</td>`
      + `<td class="v">${r.overtops ? `<b class="bad">overtops at ${fmt(r.overtopT_h, 1)} h</b>`
          : r.throughConduit ? `discharges through ${esc(r.conduitId || "the conduit")}` : "contained"}</td></tr>`).join("");
    return `<div class="dspopwrap"><table class="dspop runoffT">
      <tr><td class="k"><b>pond (level-pool)</b></td><td class="v"><b>peak ft</b></td>
          <td class="v"><b>freeboard</b></td><td class="v"><b>t peak h</b></td><td class="v"><b>outcome</b></td></tr>
      ${rowsH}</table>
      <div class="note">Outlet ratings: a broad-crested weir over the rim (Q = 3.0·L·H^1.5). A conduit with
      no surveyed size or invert passes its inflow — capacity unknown, survey pending.</div></div>`;
  }
  function assumptionRows() {
    const st = R.settings, a = R.assumptions;
    const cv = R.cover || {};
    return [
      ["Storm", R.storm.name + " · " + fmt(R.storm.P, 2) + " in"],
      ["Rainfall", (R.rain && R.rain.provisional) ? "PROVISIONAL — replace with the Atlas 14 export"
        : "NOAA Atlas 14 · " + (R.rain ? R.rain.built : "—")],
      ["Distribution", (R.rain && R.rain.distributions && R.rain.distributions[st.dist]
        ? R.rain.distributions[st.dist].name : st.dist)],
      ["Runoff", "NRCS curve number, Ia = 0.2S, AMC II"],
      ["Soil group", "D for mine waste, tailings, waste piles and decision units; C elsewhere"],
      ["Cover", "2-ft raster, " + (cv.priority ? cv.priority.length : 0) + " sources"
        + (R.overrides.length ? ` · ${R.overrides.length} drawn override${R.overrides.length === 1 ? "" : "s"}` : "")],
      ["Time of concentration", `TR-55: sheet ≤ ${a.sheetMax_ft} ft, shallow concentrated, `
        + `channel above ${a.channelStart_ac} ac (n ${a.channelN}, R ${a.channelR_ft} ft)`],
      ["Peaks", `Rational to ${a.rationalMaxAc} ac; SCS unit hydrograph (PRF 484) for every catchment`],
      ["Catchments", `Phase 1 drainage map, ${R.gridFt}-ft lidar grid (sampled at ${R.dCell} ft)`],
      ["Clear Lake", "free outfall"]
    ];
  }

  function showCard() {
    if (!R) return;
    if (card && card.isConnected) card.remove();
    const t = R.totals || {};
    card = SBMM.results.card(null, "Design storm — " + R.storm.name, [
      ["Runoff volume", fmt(t.volume_acft, 1) + " ac-ft"],
      ["Rainfall", fmt(R.storm.P, 2) + " in over " + fmt(R.storm.hours, 0) + " h"],
      ["Area", ac(t.area_ft2) + " ac · composite CN " + fmt(t.cn, 0)],
      ["Site peak (SCS)", fmt(t.qPeak_cfs, 0) + " cfs at " + fmt(t.tPeak_h, 1) + " h"],
      ["Catchments", fmt0(R.outlets.length) + " outlets, " + fmt0(R.first.length) + " ponds and inlets"],
      ["Run time", fmt0(R.ms) + " ms"]
    ]);
    if (R.provisional) {
      const w = document.createElement("div");
      w.className = "note bad rnProv";
      w.textContent = "provisional depths — replace with the Atlas 14 export "
        + "(data/atlas14_sbmm.csv, then tools/build_rainfall.py)";
      card.appendChild(w);
    }
    const box = document.createElement("div");
    box.innerHTML = tableHtml() + routeHtml()
      + `<div class="note">${esc("Assumptions")}</div>`
      + `<div class="dspopwrap"><table class="dspop">${assumptionRows().map(r =>
          `<tr><td class="k">${esc(r[0])}</td><td class="v">${esc(r[1])}</td></tr>`).join("")}</table></div>`;
    card.appendChild(box);
    /* the biggest catchment's hydrograph, and a picker for the rest */
    const big = R.outlets.slice().sort((a, b) => b.area_ft2 - a.area_ft2)[0];
    if (big) {
      const h = document.createElement("div");
      h.className = "rnChart";
      h.innerHTML = `<select class="rnPick">${R.outlets.slice()
        .sort((a, b) => b.area_ft2 - a.area_ft2)
        .map(c => `<option value="${c.label}">${esc(c.name)}</option>`).join("")}</select>`
        + `<div class="rnSvg">${hydroSVG(big)}</div>`;
      h.querySelector(".rnPick").onchange = ev => {
        const c = R.outlets.find(q => String(q.label) === ev.target.value);
        h.querySelector(".rnSvg").innerHTML = c ? hydroSVG(c) : "";
      };
      card.appendChild(h);
    }
    const acts = document.createElement("div");
    acts.className = "pop-actions";
    acts.innerHTML = `<span class="minib" data-r="csv" title="Copy the catchment table as CSV">copy CSV</span>`
      + `<span class="minib" data-r="rep" title="Open the printable design-storm sheet">report</span>`
      + `<span class="minib" data-r="dlg" title="Change the storm and the assumptions">assumptions…</span>`
      + `<span class="minib" data-r="re" title="Run the storm again">recompute</span>`;
    acts.addEventListener("click", ev => {
      const b = ev.target.closest("[data-r]"); if (!b) return;
      const a = b.dataset.r;
      if (a === "csv") copyText(csv(), "design storm table copied");
      else if (a === "rep") report();
      else if (a === "dlg") dialog();
      else if (a === "re") run({});
    });
    card.appendChild(acts);
    SBMM.results.appendNote(card, NOTE);
  }

  /* ------------------------------------------------------------------ */
  /* CSV + report                                                        */
  /* ------------------------------------------------------------------ */
  function csv() {
    if (!R) return "";
    const st = R.settings, a = R.assumptions;
    let out = "SBMM design storm," + R.storm.name + "\n";
    out += "rainfall_in," + R.storm.P + ",duration_h," + R.storm.hours
      + ",distribution," + st.dist + (R.provisional ? ",PROVISIONAL DEPTHS" : "") + "\n";
    out += "grid_ft," + R.gridFt + ",sampled_ft," + R.dCell
      + ",storm_drains," + (R.drains ? "assumed working" : "off") + "\n\n";
    out += "catchment,kind,acres,CN,Q_in,volume_acft,Tc_min,i_inhr,rational_cfs,scs_cfs,tp_h,path_ft\n";
    for (const c of R.outlets.slice().sort((x, y) => y.area_ft2 - x.area_ft2))
      out += `"${String(c.name).replace(/"/g, '""')}",${c.kind || ""},${c.area_ac.toFixed(3)},`
        + `${fmt(c.cn, 1)},${c.Q_in.toFixed(3)},${c.volume_acft.toFixed(3)},${c.tc_min},`
        + `${c.i_inhr == null ? "" : c.i_inhr},${c.qRational_cfs == null ? "" : c.qRational_cfs},`
        + `${c.qPeak_cfs},${c.tp_h},${c.pathLen_ft}\n`;
    out += "\nfirst capture (ponds and inlets),kind,acres,CN,Q_in,volume_acft,scs_cfs,via\n";
    for (const c of R.first)
      out += `"${String(c.name).replace(/"/g, '""')}",${c.kindSrc || ""},${c.area_ac.toFixed(3)},`
        + `${fmt(c.cn, 1)},${c.Q_in.toFixed(3)},${c.volume_acft.toFixed(3)},${c.qPeak_cfs},${c.via || ""}\n`;
    if (R.routing.length) {
      out += "\npond routing (level-pool),start_ft,rim_ft,conduit_ft,peak_ft,freeboard_ft,t_peak_h,peak_out_cfs,overtops,volume_balance_pct\n";
      for (const r of R.routing)
        out += `"${String(r.name).replace(/"/g, '""')}",${r.stage0},${r.rimLevel},`
          + `${r.conduitLevel == null ? "" : r.conduitLevel},${r.peakLevel},`
          + `${r.freeboard_ft == null ? "" : r.freeboard_ft},${r.peakT_h},${r.peakOut_cfs},`
          + `${r.overtops ? "yes" : "no"},${r.balance_pct}\n`;
    }
    out += "\ncover class,acres,CN(HSG),share_pct\n";
    const tot = {};
    for (const c of R.outlets) for (const k of c.classes)
      tot[k.key] = (tot[k.key] || 0) + k.area_ac;
    const sum = Object.values(tot).reduce((x, y) => x + y, 0) || 1;
    for (const k of Object.keys(tot).sort((x, y) => tot[y] - tot[x])) {
      const cl = classByKey(k);
      out += `${k},${tot[k].toFixed(3)},${cl ? cl.cn[cl.hsg] + "(" + cl.hsg + ")" : ""},`
        + `${(100 * tot[k] / sum).toFixed(1)}\n`;
    }
    out += "\nassumptions\n";
    for (const r of assumptionRows()) out += `"${r[0]}","${String(r[1]).replace(/"/g, '""')}"\n`;
    return out;
  }

  function report() {
    if (!R) { toast("run a design storm first (RAIN)"); return; }
    if (SBMM.cultural && SBMM.cultural.gateExport && !SBMM.cultural.gateExport("report")) return;
    if (SBMM.report && SBMM.report.openRunoff) SBMM.report.openRunoff(R);
    else toast("the report sheet is not available in this build");
  }

  /* ------------------------------------------------------------------ */
  /* the layers                                                          */
  /* ------------------------------------------------------------------ */
  const DEPTH_STOPS = [[0, [46, 111, 214]], [1, [79, 206, 155]], [2, [242, 193, 78]],
                       [4, [232, 115, 74]], [7, [196, 60, 60]]];
  function depthColor(q) {
    let a = DEPTH_STOPS[0], b = DEPTH_STOPS[DEPTH_STOPS.length - 1];
    for (let i = 0; i < DEPTH_STOPS.length - 1; i++)
      if (q >= DEPTH_STOPS[i][0] && q <= DEPTH_STOPS[i + 1][0]) { a = DEPTH_STOPS[i]; b = DEPTH_STOPS[i + 1]; break; }
    const t = (b[0] - a[0]) > 0 ? clamp((q - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    const c = [0, 1, 2].map(i => Math.round(a[1][i] + (b[1][i] - a[1][i]) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function paintDepth() {
    if (!groups.depth) return;
    groups.depth.clearLayers();
    if (!R || !SBMM.drainage || !SBMM.drainage.result()) return;
    const D = SBMM.drainage.result();
    for (const s of D.sinks) {
      const c = R.outlets.find(q => q.label === s.label);
      if (!c || !s.rings || !s.rings.length) continue;
      const col = depthColor(c.Q_in);
      for (const ring of s.rings) {
        const pl = L.polygon(ring.map(p => [p[1], p[0]]), {
          pane: "vectors", color: col, weight: 1.2, opacity: .9,
          fillColor: col, fillOpacity: .34
        });
        pl.bindTooltip(`${esc(c.name)} · ${fmt(c.Q_in, 2)} in · ${fmt(c.volume_acft, 1)} ac-ft`,
                       { sticky: true, className: "ctip" });
        pl.on("click", ev => {
          L.DomEvent.stopPropagation(ev);
          pl.bindPopup(SBMM.popups.forRunoff(c.label)).openPopup();
        });
        pl.addTo(groups.depth);
      }
    }
  }

  function coverOverlay() {
    if (overlay) return overlay;
    const meta = COVER(), url = DATA().cover_png;
    if (!meta || !url) return null;
    const b = meta.bounds;
    overlay = L.imageOverlay(url, [[b.y0, b.x0], [b.y1, b.x1]],
      { pane: "analysis", opacity: .65, interactive: false });
    return overlay;
  }

  function legendHtml() {
    return classes().filter(c => c.id !== 0).map(c =>
      `<span class="rnLeg"><i style="background:rgb(${c.rgb.join(",")})"></i>${esc(c.key)} `
      + `<b>${c.cn[c.hsg]}</b></span>`).join("");
  }

  function build() {
    if (!COVER() && !RAIN()) return;            // neither payload: no rows at all
    const host = document.getElementById("projLayers");
    if (host) {
      const hh = document.createElement("div");
      hh.className = "lsub";
      hh.textContent = "Design storm (rainfall + runoff)";
      host.appendChild(hh);
    }
    groups.cover = L.layerGroup();
    groups.depth = L.layerGroup();
    const cv = coverOverlay();
    if (cv) {
      const row = SBMM.addLayerRow("proj", "Land cover (curve number)", groups.cover,
        { id: "runoff_cover", checked: false, swatch: "#7CB460", opacity: 0.65,
          onChange: st => {
            if (st.on) {
              if (!COVER()) { toast("this build has no land-cover raster"); return; }
              cv.addTo(SBMM.map);
              cv.setOpacity(SBMM.layerState.opacity("framework", "runoff_cover"));
            } else SBMM.map.removeLayer(cv);
          } });
      row.row.title = "The cover class behind every curve number, on the 2-ft site grid.";
      rows.runoff_cover = row;
      const leg = document.createElement("div");
      leg.className = "rnLegend";
      leg.innerHTML = legendHtml();
      row.row.parentNode.insertBefore(leg, row.row.nextSibling);
    } else {
      const row = SBMM.addLayerRow("proj", "Land cover (not in this build)", null,
        { id: "runoff_cover", checked: false, swatch: "#5A6570",
          onChange: st => { if (st.on) { toast("the land-cover raster is not in this build"); SBMM.layerState.set("framework", "runoff_cover", { on: false }); } } });
      row.row.title = "The cover raster payload is absent from this build.";
      rows.runoff_cover = row;
    }
    const rd = SBMM.addLayerRow("proj", "Runoff depth (design storm)", groups.depth,
      { id: "runoff_depth", checked: false, swatch: "#F2C14E",
        onChange: async st => {
          if (!st.on) return;
          if (!R) { const res = await run({}); if (!res) { SBMM.layerState.set("framework", "runoff_depth", { on: false }); return; } }
          paintDepth();
        } });
    rd.row.title = "Each catchment shaded by the runoff depth of the chosen storm.";
    rows.runoff_depth = rd;
    built = true;
  }

  /* ------------------------------------------------------------------ */
  /* cover overrides — "draw a cover area"                               */
  /* ------------------------------------------------------------------ */
  function assignCover(key, f) {
    const c = classByKey(key);
    if (!c) { toast("unknown cover class: " + key); return null; }
    const t = f || SBMM.store.selectedFeature();
    if (!t || t.type !== "area" || !t.pts || t.pts.length < 3) {
      toast("select an area first, or draw one (Design storm → draw a cover area)");
      return null;
    }
    const before = t.props.cover || null;
    t.props.cover = key;
    if (!/cover/i.test(t.name || "")) t.name = (t.name || "Area") + " — cover: " + c.key;
    SBMM.store.emit(); SBMM.store.autosave();
    SBMM.undo.push("set cover " + c.key,
      () => { if (before) t.props.cover = before; else delete t.props.cover; SBMM.store.emit(); SBMM.store.autosave(); },
      () => { t.props.cover = key; SBMM.store.emit(); SBMM.store.autosave(); });
    toast(`${esc(t.name)} counts as ${c.name} (CN ${c.cn[c.hsg]}) — recompute the storm to use it`);
    return t;
  }
  function drawCoverArea(key) {
    const c = classByKey(key);
    if (!c) { toast("pick a cover class first"); return; }
    pending = key;
    toast("draw the cover area — double-click to close it");
    SBMM.mode.set("measure.area");
  }
  /* the sketch engine finishes an `area` like any other; this tags the next one */
  function claimIfPending(f) {
    if (!pending || !f || f.type !== "area") return;
    const key = pending; pending = null;
    assignCover(key, f);
  }

  /* ------------------------------------------------------------------ */
  /* the dialog                                                          */
  /* ------------------------------------------------------------------ */
  function dialog() {
    const st = settings();
    const list = storms();
    if (!list.length) { toast("this build has no rainfall table — the design storm needs datajs/d_rainfall.js"); return; }
    const rain = RAIN();
    const box = document.createElement("div");
    box.className = "modal"; box.id = "rainDlg";
    const dists = (rain && rain.distributions) ? Object.keys(rain.distributions) : ["IA"];
    box.innerHTML = `<div class="mbox" style="width:min(560px,94vw)">
      <div class="mhd">Design storm — rainfall, cover and runoff
        <span class="spacer"></span><span class="ic x" id="rnX" title="Close (Esc)">✕</span></div>
      <div class="mbody">
        ${provisional() ? `<div class="mnote"><span class="bad">Provisional rainfall depths.</span>
          Download the NOAA Atlas 14 point estimates for 39.003 N, 122.663 W, save them as
          <b>data/atlas14_sbmm.csv</b> and run <b>tools/build_rainfall.py</b>.</div>` : ""}
        <div class="mrow"><span>Storm</span>
          <select id="rnStorm">${list.map(s =>
            `<option value="${s.id}"${st.storm === s.id ? " selected" : ""}>${esc(s.name)} — ${fmt(s.P, 2)} in</option>`).join("")}
            <option value="custom"${st.storm === "custom" ? " selected" : ""}>custom depth / duration…</option>
          </select></div>
        <div class="mrow" id="rnCustom" ${st.storm === "custom" ? "" : "hidden"}><span>Custom</span>
          <input id="rnP" type="number" step="0.01" value="${st.customP}" title="Depth, inches">
          <input id="rnD" type="number" step="0.25" value="${st.customD}" title="Duration, hours"></div>
        <div class="mrow"><span>Distribution</span>
          <select id="rnDist">${dists.map(d =>
            `<option value="${d}"${st.dist === d ? " selected" : ""}>${esc(rain.distributions[d].name || d)}</option>`).join("")}
          </select></div>
        <div class="mrule"></div>
        <div class="mrow"><span>Soil group</span>
          <select id="rnHsg">
            <option value="ruling">D for mine waste, C elsewhere (the ruling)</option>
            <option value="C">C everywhere</option>
            <option value="D">D everywhere</option>
          </select></div>
        <div class="mrow"><span>Sheet flow</span>
          <input id="rnSheet" type="number" step="10" value="${st.sheetMax_ft}" title="Maximum sheet-flow length, ft">
          <span style="width:auto">ft · channel above</span>
          <input id="rnChan" type="number" step="1" value="${st.channelStart_ac}" title="Contributing area at which channel flow starts, acres">
          <span style="width:auto">ac</span></div>
        <div class="mrow"><span>Cover areas</span>
          <select id="rnCls">${classes().filter(c => c.id !== 0).map(c =>
            `<option value="${c.key}">${esc(c.name)} — CN ${c.cn[c.hsg]}</option>`).join("")}</select>
          <button class="minib" id="rnDraw" title="Draw an area that overrides the cover raster">draw</button>
          <button class="minib" id="rnAssign" title="Give the selected area this cover class">assign</button></div>
        <div class="mnote">Curve numbers are TR-55 table 2-2 for the hydrologic soil group above;
          runoff is <b>Q = (P − 0.2S)² / (P + 0.8S)</b>, S = 1000/CN − 10, AMC II. Time of
          concentration is TR-55 chapter 3 along the Phase 1 flow path. Peaks are reported both
          ways: Rational up to ${st.rationalMaxAc} ac and an SCS unit hydrograph everywhere.
          ${overrides().length ? `<b>${overrides().length}</b> drawn cover override(s) are in play.` : ""}</div>
      </div>
      <div class="mfoot"><span class="spacer"></span>
        <button class="minib" id="rnCancel">Cancel</button>
        <button class="minib prim" id="rnGo">Run the storm</button></div></div>`;
    document.body.appendChild(box);
    const shut = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(); } };
    document.addEventListener("keydown", onKey, true);
    box.querySelector("#rnX").onclick = shut;
    box.querySelector("#rnCancel").onclick = shut;
    box.addEventListener("click", e => { if (e.target === box) shut(); });
    box.querySelector("#rnStorm").onchange = ev => {
      box.querySelector("#rnCustom").hidden = ev.target.value !== "custom";
    };
    box.querySelector("#rnDraw").onclick = () => { const k = box.querySelector("#rnCls").value; shut(); drawCoverArea(k); };
    box.querySelector("#rnAssign").onclick = () => { assignCover(box.querySelector("#rnCls").value); };
    box.querySelector("#rnGo").onclick = () => {
      st.storm = box.querySelector("#rnStorm").value;
      st.customP = +box.querySelector("#rnP").value || st.customP;
      st.customD = +box.querySelector("#rnD").value || st.customD;
      st.dist = box.querySelector("#rnDist").value;
      st.sheetMax_ft = +box.querySelector("#rnSheet").value || 100;
      st.channelStart_ac = +box.querySelector("#rnChan").value || 5;
      const h = box.querySelector("#rnHsg").value;
      st.hsgOf = {};
      if (h === "C" || h === "D") for (const c of classes()) st.hsgOf[String(c.id)] = h;
      shut();
      run({});
    };
    return box;
  }

  /* ------------------------------------------------------------------ */
  /* chrome                                                              */
  /* ------------------------------------------------------------------ */
  async function cmd() {
    if (!RAIN()) { toast("this build has no rainfall table — the design storm needs datajs/d_rainfall.js"); return; }
    dialog();
  }

  function wire() {
    /* tag an area drawn straight after "draw a cover area" */
    if (SBMM.store && SBMM.store.onChange) {
      let seen = SBMM.store.features.length;
      SBMM.store.onChange(() => {
        const n = SBMM.store.features.length;
        if (pending && n > seen) {
          const f = SBMM.store.features[n - 1];
          claimIfPending(f);
        }
        seen = n;
      });
    }
    if (SBMM.events) {
      SBMM.events.on("layers", ({ group, layer }) => {
        if (group === "framework" && layer === "runoff_cover" && overlay)
          overlay.setOpacity(SBMM.layerState.opacity("framework", "runoff_cover"));
      });
    }
  }

  return {
    build, wire, cmd, dialog, run, report, csv,
    assignCover, drawCoverArea, overrides, classes, classByKey, coverRaster,
    storms, stormOf, depthFor, idfFor, provisional, settings,
    result: () => R, hasResult: () => !!R, isBuilt: () => built,
    routing: () => (R ? R.routing : []),
    waterRingAt,
    catchment: label => R ? (R.outlets.find(c => c.label === label)
      || R.first.find(c => c.label === label) || null) : null,
    paintDepth, showCard, NOTE
  };
})();
