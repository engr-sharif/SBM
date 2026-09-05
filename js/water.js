/* SBMM Site Explorer — water: the raindrop and the overtopping analysis (v10).

   Two tools, one idea: the January-2024 lidar bare earth already knows where
   water goes, and nothing here invents anything else. There is no rainfall, no
   infiltration, no hydraulics, no seepage — both tools are *static terrain
   analyses* and every card says so in as many words.

     * **Raindrop** (`raindrop` mode, key R, command DROP). A drop lands where
       you click and runs downhill by steepest descent over the finest DEM that
       covers it. Where it reaches a low point it PONDS: the depression fills to
       its pour point, the pond is drawn with its level, depth, area and volume,
       and the drop carries on from the pour point. It ends at the edge of the
       surveyed terrain (Clear Lake, or the survey limit), in a genuine sink, or
       at the length cap. The run is an ordinary store feature of the new type
       `flow` — My work, Inspector, sessions, GeoJSON/DXF, undo, 2D and 3D.

     * **Overtopping** (command OVERTOP, the Water ▾ menu, the Herman polygon's
       popup). For a water body: the level at which it first spills, WHERE it
       spills, how much water that takes, where the overflow goes, and a ring of
       rim elevations coloured by how far above the spill each stretch of rim
       stands, with the low points ranked. A level slider raises the water from
       today's surface to the spill and beyond.

   The arithmetic is in js/compute.js (kernels `flowpath`, `overtop`,
   `catchment`, docs/V10_WATER_SPEC.md §2/§3). This file is the host: it picks
   the grid, chains the windows, builds the geometry, paints the overlays and
   writes the cards.

   Two things here are easy to get wrong and were got wrong on the way:

     * **One analysis, one grid.** Every window is `SBMM.compute.gridSpec` over
       a single DEM chosen by `SBMM.demAt` / `SBMM.demForBox` — never a mix, so
       a quantity is never half 1-ft and half 2-ft. When a raindrop runs off the
       edge of its window the host re-runs it centred on the exit cell, on
       whatever DEM covers *that* point, and the card lists every grid it used.
     * **The animated flow line is SVG, not canvas.** The map runs
       `preferCanvas`, and a canvas vector has no DOM element, so `className` on
       it reaches nothing (CLAUDE.md). The `water` pane therefore carries its own
       `L.svg` renderer and is `pointer-events:none`, which is also what keeps it
       from eating clicks meant for the layers underneath it. */
"use strict";

SBMM.water = (function () {

  /* §7 — nothing else in the app uses these hues, which is the point */
  const C = {
    line: "#55C1FF", glow: "rgba(85,193,255,.32)", anim: "#DFF4FF",
    pond: "rgba(85,193,255,.28)", drop: "#9FDCFF", spill: "#FF4D3D",
    sel: "#FFD34D",
    /* v15 §1: the rim overflow traced on demand is a WHAT-IF — "the culvert is
       blocked" — and it must not read as the answer. A muted slate, dashed, no
       glow and no animation: visibly a hypothesis rather than a flow. */
    whatif: "#93A6B3"
  };
  /* the storm network's own colour (v12 §5.1): a pipe is infrastructure
     somebody drew, a flow is the terrain's answer, and they must not read as
     the same thing on a map showing both */
  const STORM_COL = "#7FA7C9";
  const MIN_POND = 0.25;        // ft — the lidar noise floor
  const PLATEAU_TOL = 0.3;      // ft — how flat "the water surface" is
  const RIM_RANGE = 3;          // ft above the spill the rim band covers
  const LEVEL_STEP = 0.25;      // ft — the stage table's step and the slider's
  const MAX_HOPS = 8, MAX_LEN = 20000;
  const HALF_FINE = 700, HALF_COARSE = 1400;   // §4.2 window half-sizes
  const RANKS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫";

  const NOTE_FLOW = grid =>
    "Steepest-descent trace on the " + grid + " lidar bare earth; depressions fill to "
    + "their pour point and the drop continues. No rainfall, infiltration or hydraulics "
    + "— a terrain analysis, planning-level.";

  /* ================================================================== */
  /* small helpers                                                      */
  /* ================================================================== */
  function bboxOf(ring) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }
  function ringWidth(ring) { const b = bboxOf(ring); return Math.max(b[2] - b[0], b[3] - b[1]); }
  function gridLabel(dem) { return dem.m.cell + "-ft"; }
  const acft = v => v / 43560;
  /* a closed traced ring comes back with first == last; a store polygon must not */
  function openRing(ring) {
    if (ring.length > 1 && dist2d(ring[0], ring[ring.length - 1]) < 1e-6) return ring.slice(0, -1);
    return ring.slice();
  }

  /* ================================================================== */
  /* the `flow` feature type (§4.1)                                     */
  /* ================================================================== */
  let wrend = null;
  function waterRenderer() {
    if (!wrend) wrend = L.svg({ pane: "water", padding: 0.6 });
    return wrend;
  }

  function dropIcon() {
    /* a teardrop, drawn rather than themed: 18x22, anchored at its point */
    return L.divIcon({
      className: "dropmk", iconSize: [18, 22], iconAnchor: [9, 21],
      html: `<svg viewBox="0 0 18 22" width="18" height="22">
        <path d="M9 21.2C5.1 17.8 1.8 14 1.8 9.9 1.8 5.2 5 1 9 1s7.2 4.2 7.2 8.9c0 4.1-3.3 7.9-7.2 11.3z"
              fill="${C.drop}" stroke="#0E1418" stroke-width="1"/>
        <ellipse cx="6.4" cy="8.2" rx="1.7" ry="2.4" fill="#FFFFFF" opacity=".55"/></svg>`
    });
  }

  /* A pond can be twelve square feet or twelve acres, and one unit cannot say
     both: "0.000 ac" is not a number anyone can act on. */
  function areaTxt(a) { return a < 4356 ? fmt0(a) + " ft²" : fmt(acft(a), 3) + " ac"; }
  function volTxt(v) { return (v < 100 ? fmt(v, 1) : fmt0(v)) + " ft³"; }
  function pondTip(pd) {
    return `pond · ${fmt(pd.depth_ft, 1)} ft deep · ${areaTxt(pd.area_ft2)} · `
      + `${volTxt(pd.volume_ft3)} · level ${fmt(pd.level, 1)} ft`;
  }
  function pondShort(pd) { return `${fmt(pd.level, 1)} ft · ${fmt(pd.depth_ft, 1)} ft deep`; }

  function endText(p) {
    const r = (p.end && p.end.reason) || "steps";
    if (r === "nodata")
      return `reaches Clear Lake / survey limit · ${fmt0(p.length_ft)} ft · ${fmt(p.fall_ft == null ? NaN : -p.fall_ft, 1)} ft`;
    if (r === "pond")
      return `ponds here — no outlet within ${fmt0(p.searched_ft || 1400)} ft`;
    return "stopped at the length cap";
  }
  /* the card has one line; the popup and the note have room for the sentence */
  function endShort(p) {
    const r = (p.end && p.end.reason) || "steps";
    if (r === "nodata") return "reaches Clear Lake / the survey limit";
    if (r === "pond") return "ponds — no outlet in the window";
    if (r === "window") return "left the search window";
    return "stopped at the length cap";
  }
  function endSentence(p) {
    const r = (p.end && p.end.reason) || "steps";
    if (r === "nodata") return "reaches the edge of the surveyed terrain (Clear Lake or the survey limit)";
    if (r === "pond") return "ponds with no outlet inside the search window — a genuine sink";
    if (r === "window") return "left the search window";
    return "stopped at the length cap";
  }

  /* The feature's layer is a FeatureGroup rebuilt whenever the geometry, the
     style or the selection changes — the same shape js/tools.js already uses for
     dim and text, and the reason `flow` is special-cased in applyStyle/redraw
     rather than fighting setStyle over six sub-layers. */
  function buildFlow(f) {
    const g = f.layer;
    if (!g || !g.clearLayers) return;
    g.clearLayers();
    /* every label this feature owns goes with the layers it hung them on
       (v15 §2.2) — otherwise the registry keeps measuring detached elements */
    const LOWN = "flow:" + f.id;
    SBMM.labels.removeOwner(LOWN);
    const p = f.props || {};
    if (!f.pts || f.pts.length < 2) return;
    const sel = SBMM.store.selected === f.id;
    /* v15 §1: a what-if rim overflow is drawn as a hypothesis — muted, dashed,
       no glow, no animation. Everything else about it is an ordinary flow. */
    const whatif = !!p.whatif;
    const col = whatif ? C.whatif : ((f.style && f.style.color) || C.line);
    /* v12: a run that went through a pipe is not one polyline. Each conduit leg
       ends an overland stretch and the next one starts at the outlet, so the
       ground line is drawn per stretch and the pipe is drawn as itself — a
       single polyline through both would draw the pipe as if water ran over
       the ground along it, which is the one thing this must not say. */
    const legs = (p.legs || []).filter(lg => lg.at != null && lg.at >= 0);
    const cuts = [...new Set(legs.map(lg => lg.at))].sort((a, b) => a - b);
    const stretches = [];
    {
      let st = 0;
      for (const cut of cuts) {
        if (cut >= st) stretches.push(f.pts.slice(st, cut + 1));
        st = cut + 1;
      }
      if (st < f.pts.length) stretches.push(f.pts.slice(st));
    }
    const lls = stretches.filter(sq => sq.length > 1).map(sq => sq.map(q => [q[1], q[0]]));

    /* (a) the soft glow — non-interactive, purely so the line reads over the ortho */
    if (!whatif) for (const line of lls)
      L.polyline(line, { pane: "drawings", color: C.glow, weight: 9, opacity: 1,
                         lineCap: "round", lineJoin: "round", interactive: false }).addTo(g);

    /* (c) ponds, under the line */
    for (const pd of (p.ponds || [])) {
      for (const ring of (pd.rings || [])) {
        if (!ring || ring.length < 3) continue;
        const poly = L.polygon(ring.map(q => [q[1], q[0]]), {
          pane: "drawings", color: sel ? C.sel : col, weight: 1.5, dashArray: "4 4",
          fillColor: col, fillOpacity: .28, fillRule: "evenodd"
        });
        poly.bindTooltip(pondTip(pd), { sticky: true, className: "ctip" });
        poly.addTo(g);
        /* the permanent label only earns its place once the pond is big enough
           to read — the same idea as the excavation depth labels */
        const c = centroid(ring);
        const mk = L.marker([c[1], c[0]], {
          pane: "drawings", interactive: false,
          icon: L.divIcon({ className: "pondlbl", iconSize: [0, 0],
                            html: `<span>${esc(pondShort(pd))}</span>` })
        }).addTo(g);
        const wft = ringWidth(ring);
        /* the dedupe key IS the fact: a pond at this cell at this level is one
           pond however many routes crossed it (v15 §2.1) */
        SBMM.labels.add({
          key: `pond:${pd.level.toFixed(2)}:${Math.round(c[0] / 10)}:${Math.round(c[1] / 10)}`,
          priority: SBMM.labels.PRI.pond, marker: mk, owner: LOWN,
          latlng: [c[1], c[0]],
          /* the old zoom gate, unchanged: a label only earns its place once the
             pond is 36 px across */
          gate: () => !!SBMM.map && wft * Math.pow(2, SBMM.map.getZoom()) >= 36
        });
      }
    }

    /* (b) the core line — this is what a click selects */
    for (const line of lls)
      L.polyline(line, { pane: "drawings", color: sel ? C.sel : col,
                         weight: sel ? 4.75 : (whatif ? 2.2 : 2.75),
                         dashArray: whatif ? "7 6" : null, opacity: whatif ? .9 : 1,
                         lineCap: "round", lineJoin: "round" }).addTo(g);

    /* the flow animation: a second, non-interactive copy in the SVG `water`
       pane. Zero JS per frame — CSS walks the dash offset, and
       prefers-reduced-motion turns the movement off in the stylesheet. */
    if (!whatif) for (const line of lls)
      L.polyline(line, { renderer: waterRenderer(), pane: "water", interactive: false,
                         color: C.anim, weight: 1.6, dashArray: "5 11", opacity: .95,
                         className: "flowanim" }).addTo(g);

    /* (c2) the conduit legs — the pipe, drawn as a pipe: straight, dashed, in the
       storm colour, with a hollow ring where the water left the ground and an
       "in pipe" label at the midpoint once there is room for it. */
    for (const lg of legs) {
      const a = lg.from, b = lg.to;
      if (!a || !b) continue;
      L.polyline([[a[1], a[0]], [b[1], b[0]]], {
        pane: "drawings", color: STORM_COL, weight: 2.4, opacity: .95,
        dashArray: "8 5", lineCap: "butt", interactive: false
      }).addTo(g);
      const lab = L.marker([(a[1] + b[1]) / 2, (a[0] + b[0]) / 2], {
        pane: "drawings", interactive: false,
        icon: L.divIcon({ className: "", iconSize: [0, 0],
          html: `<span class="flowpipe">in pipe · ${fmt0(lg.length_ft)} ft</span>` })
      }).addTo(g);
      SBMM.labels.add({
        key: `pipe:${lg.id}`, priority: SBMM.labels.PRI.pipe, marker: lab, owner: LOWN,
        /* §5.2: the words only fit inside a conduit at zoom >= 2 */
        gate: () => !!SBMM.map && SBMM.map.getZoom() >= 2
      });
      L.circleMarker([a[1], a[0]], { pane: "drawings", radius: 4.5, color: STORM_COL,
        weight: 2, fillColor: "#0E1418", fillOpacity: 1, interactive: false }).addTo(g);
    }

    /* (d) the drop marker — drag it to retrace from somewhere else */
    const d = p.drop || f.pts[0];
    const mk = L.marker([d[1], d[0]], {
      pane: "drawings", icon: dropIcon(), draggable: !f.locked, zIndexOffset: 400,
      keyboard: false
    });
    mk.bindTooltip("raindrop — drag to retrace", { direction: "top", className: "ctip", offset: [0, -18] });
    mk.on("dragend", ev => {
      const q = ev.target.getLatLng();
      retrace(f, q.lng, q.lat);
    });
    mk.addTo(g);
    f._dropMarker = mk;

    /* (e) the end marker and its label */
    const e = p.end;
    if (e && e.x != null) {
      const em = L.marker([e.y, e.x], {
        pane: "drawings", interactive: false,
        icon: L.divIcon({ className: "flowend", iconSize: [0, 0],
          html: `<span class="dot"></span><span class="lbl mono">${esc(endText(p))}</span>` })
      }).addTo(g);
      SBMM.labels.add({
        key: `flowend:${Math.round(e.x / 10)}:${Math.round(e.y / 10)}:${e.reason}`,
        priority: SBMM.labels.PRI.flowend, marker: em, owner: LOWN, latlng: [e.y, e.x]
      });
    }
    refreshLabels();
  }

  /* v15 §2.2: the zoom gate and the pile-up are one problem, and js/labels.js
     owns both now. This stays as the name the rest of the app calls. */
  function refreshLabels() { SBMM.labels.refresh(); }

  /* normalise whatever we were handed (a fresh trace, a session, an import) */
  function normProps(props, pts) {
    const p = Object.assign({}, props || {});
    if (!p.drop && pts && pts.length) p.drop = [pts[0][0], pts[0][1]];
    if (!p.end && pts && pts.length) {
      const q = pts[pts.length - 1];
      p.end = { x: q[0], y: q[1], z: null, reason: "steps" };
    }
    if (p.length_ft == null && pts) p.length_ft = +lineLength(pts).toFixed(1);
    if (!Array.isArray(p.ponds)) p.ponds = [];
    if (!Array.isArray(p.zs)) p.zs = [];
    /* v12, and the reason a v8 session still loads: a run traced before the
       storm network existed simply has no legs */
    if (!Array.isArray(p.legs)) p.legs = [];
    if (p.pipe_ft == null) p.pipe_ft = 0;
    if (p.total_ft == null) p.total_ft = p.length_ft;
    if (p.minPondDepth == null) p.minPondDepth = MIN_POND;
    return p;
  }

  /* the rebuildFeature hook — rebuilds from props, never recomputes (a session
     or an import must not spawn a job on load) */
  function mkFlow(pts, name, props, spec) {
    const f = SBMM.tools.newFeature("flow", pts.map(q => q.slice()),
      name || SBMM.tools.nextName("Raindrop"),
      { group: (spec && spec.group) || "Water", style: spec && spec.style, locked: spec && spec.locked });
    f.props = normProps(props, f.pts);
    buildFlow(f);
    f.card = SBMM.results.card(f, f.name, []);
    fillFlowCard(f);
    return f;
  }

  /* ================================================================== */
  /* the trace (§4.2) — host side, with window chaining                 */
  /* ================================================================== */
  function decimate(a, n) {
    if (a.length <= n) return a;
    const out = [];
    for (let i = 0; i < n; i++) out.push(a[Math.round(i * (a.length - 1) / (n - 1))]);
    return out;
  }

  /* Run the kernel, following the drop across as many windows as it needs.
     Returns { pts, props } or null (cancelled / refused, always with a toast). */
  async function traceRun(x, y, opts) {
    opts = opts || {};
    /* `opts.dem` / `opts.window` force the FIRST window. The overflow route uses
       them: §2 says one analysis is computed on one grid, and a route traced on
       a different grid from the spill that produced it is a second analysis
       wearing the first one's answer. Later windows (if the run leaves this one)
       are the ordinary squares, on whatever DEM covers where it left. */
    let dem = opts.dem || SBMM.demAt(x, y);
    if (!dem) { toast("no surveyed terrain under that point"); return null; }
    const minPondDepth = opts.minPondDepth != null ? opts.minPondDepth : MIN_POND;
    const label = opts.label || "Raindrop";
    let cx = x, cy = y, hops = 0, half = HALF_COARSE;
    const pts = [], zraw = [], ponds = [], grids = [];
    let reason = "steps", end = null, steps = 0, zLast = NaN, lengthSum = 0;
    /* v12 §5.2: the storm network, if this build has one and the switch is on.
       `used` is carried ACROSS windows — the kernel can only see the window it
       was given, and "a conduit is used at most once per run" is a statement
       about the run. */
    const stormOn = !!(SBMM.storm && SBMM.storm.data() && SBMM.storm.enabled() && opts.storm !== false);
    const legs = [], used = new Set();
    let pipeFt = 0, prevReason = null;

    let first = true;
    for (;;) {
      half = dem.m.cell <= 1.0 ? HALF_FINE : HALF_COARSE;
      let win = [cx - half, cy - half, cx + half, cy + half];
      if (first && opts.window) {
        win = opts.window;
        half = Math.max(win[2] - win[0], win[3] - win[1]) / 2;
      }
      first = false;
      const grid = SBMM.compute.gridSpec(dem, win, 0);
      if (!grid) { reason = "nodata"; break; }
      const gl = gridLabel(dem);
      if (grids[grids.length - 1] !== gl) grids.push(gl);
      /* conduits whose INLET is in this window and that this run has not already
         been through; the kernel resolves each one's `next` among the list it is
         given, so a chain that runs out of the window ends it with reason
         "conduit" and we re-centre on the outlet below. */
      const cds = stormOn ? SBMM.storm.conduitsFor(win).filter(c => !used.has(c.id)) : [];
      let R;
      try {
        R = await SBMM.compute.run("flowpath",
          { grid, x: cx, y: cy, minPondDepth, blockRing: opts.blockRing || null,
            plateauTol: opts.plateauTol == null ? PLATEAU_TOL : opts.plateauTol,
            conduits: cds.length ? cds : null,
            captureFt: SBMM.storm ? SBMM.storm.captureFt() : 3 },
          { transfer: [grid.z.buffer], label }).promise;
      } catch (e) {
        if (e && e.cancelled) return null;
        toast("raindrop failed: " + e.message);
        return null;
      }
      const n = R.n | 0;
      /* the first vertex of a window repeats the exit cell of the last one — but
         a CONDUIT hop reappears at the outlet, which was never a vertex, so
         nothing is dropped there */
      const skip = (pts.length && prevReason !== "conduit") ? 1 : 0;
      const base = pts.length;
      for (let i = skip; i < n; i++) {
        pts.push([R.pts[i * 3], R.pts[i * 3 + 1]]);
        zraw.push(R.pts[i * 3 + 2]);
      }
      for (const lg of (R.legs || [])) {
        used.add(lg.id);
        legs.push({ id: lg.id, at: base + lg.at - skip, length_ft: +lg.length_ft.toFixed(1),
                    from: [+lg.from[0].toFixed(2), +lg.from[1].toFixed(2)],
                    from_z: lg.from[2] == null ? null : +lg.from[2].toFixed(2),
                    to: [+lg.to[0].toFixed(2), +lg.to[1].toFixed(2)],
                    to_z: lg.to[2] == null ? null : +lg.to[2].toFixed(2),
                    name: SBMM.storm ? SBMM.storm.labelOf(lg.id) : lg.id });
      }
      pipeFt += R.pipe_ft || 0;
      lengthSum += R.length_ft || 0;
      for (const pd of (R.ponds || [])) ponds.push(pd);
      steps += R.steps || 0;
      prevReason = R.reason;
      reason = R.reason; end = R.end;
      /* the kernel's own last SURVEYED z: end[2] is NaN when the run stops on a
         NoData cell, and "fall = NaN" is a worse answer than "fall to the last
         ground we had" */
      if (R.zEnd_ft != null && !isNaN(R.zEnd_ft)) zLast = R.zEnd_ft;
      if (R.reason !== "window" && R.reason !== "conduit") break;
      if (hops >= MAX_HOPS - 1 || lengthSum >= MAX_LEN) { reason = "steps"; break; }
      const ex = R.exit;
      if (!ex) break;
      const nd = SBMM.demAt(ex[0], ex[1]);
      if (!nd) {
        reason = "nodata";                        // ran off the surveyed ground
        /* a pipe that discharges outside the lidar — the Clear Lake outfall is
           exactly this — still gets there: the outlet is where the run ends */
        if (R.reason === "conduit") { pts.push([ex[0], ex[1]]); zraw.push(NaN); end = [ex[0], ex[1], NaN]; }
        break;
      }
      dem = nd; cx = ex[0]; cy = ex[1]; hops++;
    }

    if (pts.length < 2) {
      toast("nowhere to run from there — the drop is already at a low point of a flat");
      return null;
    }
    /* the OVERLAND length: the kernel's per-window `length_ft` already excludes
       the conduit jumps, and consecutive windows share their join vertex, so the
       sum is exactly lineLength(pts) when nothing went through a pipe */
    const length = lengthSum;
    const zA = zraw.find(v => !isNaN(v));
    let zB = zLast;
    if (isNaN(zB)) for (let i = zraw.length - 1; i >= 0; i--) if (!isNaN(zraw[i])) { zB = zraw[i]; break; }
    const fall = (isNaN(zA) || isNaN(zB)) ? null : +(zA - zB).toFixed(2);
    const ez = end && end.length > 2 && !isNaN(end[2]) ? +end[2].toFixed(2) : null;
    const props = {
      drop: [+pts[0][0].toFixed(2), +pts[0][1].toFixed(2)],
      drop_z: isNaN(zA) ? null : +zA.toFixed(2),
      length_ft: +length.toFixed(1),
      fall_ft: fall,
      grade_pct: (fall == null || length <= 0) ? null : +(fall / length * 100).toFixed(2),
      end: { x: +(end ? end[0] : pts[pts.length - 1][0]).toFixed(2),
             y: +(end ? end[1] : pts[pts.length - 1][1]).toFixed(2),
             z: ez, z_last: isNaN(zB) ? null : +zB.toFixed(2), reason },
      ponds: ponds.map(pd => ({
        level: +pd.level.toFixed(2), depth_ft: +pd.depth_ft.toFixed(2),
        area_ft2: +pd.area_ft2.toFixed(0), volume_ft3: +pd.volume_ft3.toFixed(1),
        cells: pd.cells, via: pd.via || null,
        rings: (pd.rings || []).map(r => r.map(q => [+q[0].toFixed(2), +q[1].toFixed(2)]))
      })),
      zs: decimate(zraw, 600).map(v => isNaN(v) ? null : +v.toFixed(2)),
      dem: grids[0] || gridLabel(dem),
      grids, minPondDepth, hops, steps, searched_ft: half * 2,
      /* v12: `length_ft` stays overland and `pipe_ft` is separate, because they
         are different quantities — one is measured off the lidar and the other
         off somebody's drawing. `storm` records whether the network was on when
         this run was traced, so a card years later still says what it assumed. */
      storm: stormOn, legs, pipe_ft: +pipeFt.toFixed(1),
      total_ft: +(length + pipeFt).toFixed(1),
      outfall: legs.some(l => SBMM.storm && SBMM.storm.conduit(l.id)
                              && SBMM.storm.conduit(l.id).to === "outfall")
    };
    if (opts.blockRing) props.blocked = true;
    return { pts, props };
  }

  /* the public entry point: one click, one feature, one card */
  async function dropAt(x, y, opts) {
    opts = opts || {};
    const R = await traceRun(x, y, opts);
    if (!R) return null;
    /* v15 §1: a what-if route says so in its own props, so it is drawn as a
       hypothesis in 2D and in 3D and stays one across a session round trip */
    if (opts.whatif) R.props.whatif = true;
    const f = mkFlow(R.pts, opts.name || SBMM.tools.nextName("Raindrop"), R.props,
                     { group: opts.group || "Water" });
    /* readd puts the whole FeatureGroup back — the line, the ponds, the drop
       marker and the animated copy in the `water` pane are all children of it */
    if (!opts.noUndo)
      SBMM.undo.push("raindrop " + f.name, () => SBMM.store.remove(f), () => SBMM.store.readd(f));
    if (!opts.quiet) SBMM.store.select(f.id);
    if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
    return f;
  }

  /* dragging the drop marker re-runs the trace in place: same feature, same id,
     same card, one undo entry that puts the old run back */
  async function retrace(f, x, y) {
    if (!f || f.type !== "flow") { toast("retrace works on a raindrop flow path"); return null; }
    const prevPts = f.pts.map(p => p.slice());
    const prevProps = JSON.parse(JSON.stringify(f.props || {}));
    const src = (x == null || y == null) ? (f.props.drop || f.pts[0]) : [x, y];
    const R = await traceRun(src[0], src[1],
      { minPondDepth: f.props.minPondDepth, blockRing: f.props.blockRing || null });
    if (!R) { buildFlow(f); return f; }          // put the marker back where it was
    f.pts = R.pts;
    f.props = R.props;
    if (prevProps.blockRing) f.props.blockRing = prevProps.blockRing;
    buildFlow(f);
    fillFlowCard(f);
    /* the new run is captured NOW, not read back at redo time, so a later
       retrace of the same drop cannot walk into this entry */
    const nextPts = f.pts.map(p => p.slice());
    const nextProps = JSON.parse(JSON.stringify(f.props || {}));
    const set = (pts, props) => {
      f.pts = pts.map(p => p.slice());
      f.props = JSON.parse(JSON.stringify(props));
      buildFlow(f); fillFlowCard(f);
      SBMM.store.emit(); SBMM.store.autosave();
      if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
    };
    SBMM.undo.push("retrace " + (f.name || "raindrop"),
      () => set(prevPts, prevProps), () => set(nextPts, nextProps));
    SBMM.store.emit(); SBMM.store.autosave();
    SBMM.props && SBMM.props.refresh && SBMM.props.refresh(f);
    if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
    return f;
  }

  /* ================================================================== */
  /* catchment (§2, the raindrop card's action)                         */
  /* ================================================================== */
  async function catchment(f) {
    if (!f || f.type !== "flow") { toast("select a raindrop flow path first"); return null; }
    const d = f.props.drop || f.pts[0];
    const dem = SBMM.demAt(d[0], d[1]);
    if (!dem) { toast("no surveyed terrain under that drop"); return null; }
    const half = dem.m.cell <= 1.0 ? HALF_FINE : HALF_COARSE;
    const grid = SBMM.compute.gridSpec(dem, [d[0] - half, d[1] - half, d[0] + half, d[1] + half], 0);
    if (!grid) { toast("that drop is outside the surveyed terrain"); return null; }
    let R;
    try {
      R = await SBMM.compute.run("catchment", { grid, x: d[0], y: d[1] },
        { transfer: [grid.z.buffer], label: "Contributing area" }).promise;
    } catch (e) {
      if (e && e.cancelled) return null;
      toast("catchment failed: " + e.message);
      return null;
    }
    if (!R || !R.rings || !R.rings.length) { toast("nothing drains to that point on this grid"); return null; }
    const ring = openRing(R.rings[0]);
    if (ring.length < 3) { toast("the contributing area is a single cell"); return null; }
    const a = SBMM.tools.rebuildFeature({
      type: "area", pts: ring, name: (f.name || "Raindrop") + " — contributing area",
      group: f.group || "Water"
    });
    if (!a) return null;
    a.props.catchment_ft2 = +R.area_ft2.toFixed(0);
    a.props.catchment_cells = R.cells;
    a.props.catchment_window_ft = half * 2;
    a.props.catchment_partial = !!R.touchesEdge;
    SBMM.undo.push("contributing area", () => SBMM.store.remove(a), () => SBMM.store.readd(a));
    SBMM.results.appendNote(a.card,
      "Contributing area (within the " + fmt0(half * 2) + "-ft window): "
      + fmt(acft(R.area_ft2), 3) + " ac · " + fmt0(R.area_ft2) + " ft², D8 on the pit-filled "
      + gridLabel(dem) + " lidar grid."
      + (R.touchesEdge ? " The catchment reaches the window edge, so this is a LOWER BOUND." : "")
      + " " + SBMM.tools.PLANNING_NOTE);
    SBMM.store.select(a.id);
    SBMM.shell.showResults();
    return a;
  }

  /* ================================================================== */
  /* the raindrop results card (§4.4)                                   */
  /* ================================================================== */
  function fillFlowCard(f) {
    if (!f.card) return;
    const p = f.props || {};
    const rows = [
      ["Drop point", `${fmt0(p.drop[0])} E, ${fmt0(p.drop[1])} N`
        + (p.drop_z == null ? "" : ` · ${fmt(p.drop_z, 1)} ft`)],
      ["Run length", fmt0(p.length_ft) + " ft"],
      ["Fall", p.fall_ft == null ? "—" : fmt(p.fall_ft, 1) + " ft"],
      ["Average grade", p.grade_pct == null ? "—" : fmt(Math.abs(p.grade_pct), 1) + " %"],
      ["Ends", endShort(p)],
      ["", `${fmt0(p.end.x)} E, ${fmt0(p.end.y)} N`],
      ["Ponds crossed", String((p.ponds || []).length)]
    ];
    (p.ponds || []).slice(0, 6).forEach((pd, i) => rows.push([
      "pond " + (i + 1),
      `${fmt(pd.level, 1)} ft · ${fmt(pd.depth_ft, 1)} ft deep · ${areaTxt(pd.area_ft2)} · ${volTxt(pd.volume_ft3)}`
        + (pd.via ? ` · ${esc(drainsTo(pd.via))}` : "")
    ]));
    if ((p.ponds || []).length > 6) rows.push(["", `+${p.ponds.length - 6} more`]);
    /* v12 §5.2: the pipe is reported beside the ground, never inside it */
    if (p.pipe_ft > 0) {
      rows.push(["In pipes", fmt0(p.pipe_ft) + " ft"]);
      rows.push(["", legNames(p)]);
      const mv = movedMouths(p);
      if (mv) rows.push(["", mv]);
      rows.push(["Total", fmt0((p.total_ft != null ? p.total_ft : p.length_ft + p.pipe_ft)) + " ft"]);
    }
    rows.push(["Storm drains", p.storm === false ? "off — ground only"
      : (SBMM.storm && SBMM.storm.data() ? "assumed working (STORM to toggle)" : "no network in this build")]);
    rows.push(["Grid", (p.grids && p.grids.length > 1 ? p.grids.join(" → ") : (p.dem || "—"))
      + " lidar grid" + (p.hops ? ` · ${p.hops} window${p.hops === 1 ? "" : "s"} chained` : "")]);
    SBMM.results.setRows(f.card, rows);

    let holder = f.card.querySelector(".flowprof");
    if (!holder) {
      holder = document.createElement("div");
      holder.className = "flowprof";
      f.card.appendChild(holder);
      const btns = document.createElement("div");
      btns.className = "crow btns flowbtns";
      btns.innerHTML = `<button class="minib" data-w="profile">profile</button>`
        + `<button class="minib" data-w="catch">catchment</button>`
        + `<button class="minib" data-w="retrace">retrace</button>`
        + `<button class="minib" data-w="3d">3D</button>`;
      btns.addEventListener("click", ev => {
        const w = ev.target.dataset && ev.target.dataset.w;
        if (!w) return;
        if (w === "profile") makeProfile(f);
        if (w === "catch") catchment(f);
        if (w === "retrace") retrace(f);
        if (w === "3d") SBMM.viewer3d.openAt(f.props.drop[0], f.props.drop[1]);
      });
      f.card.appendChild(btns);
      SBMM.results.appendNote(f.card, NOTE_FLOW(p.dem || "lidar"));
    }
    holder.innerHTML = svgFlowProfile(f);
  }

  /* "drains to grate Spot 8 at 1,397.4 ft" — a pond whose outlet is a grate is
     a different fact from a pond that spills over its rim, and the card has to
     say which (§5.2). */
  function drainsTo(cid) {
    if (!SBMM.storm) return "drains into a pipe";
    const c = SBMM.storm.conduit(cid);
    const n = c ? SBMM.storm.node(c.from) : null;
    if (!n) return "drains into a pipe";
    const r = SBMM.storm.rimFor(n.id);
    return "drains to " + (n.name || n.id) + (r == null ? "" : " at " + fmt(r, 1) + " ft");
  }
  /* v12 ruling: a leg whose inlet is a sunken pipe mouth entered the pipe at a
     cell up to 30 ft from the surveyed point, and the card says so rather than
     leaving the reader to wonder why the run left the ground where it did */
  function movedMouths(p) {
    if (!SBMM.storm || !SBMM.storm.mouthOfConduit) return "";
    const out = [];
    for (const lg of (p.legs || [])) {
      const mo = SBMM.storm.mouthOfConduit(lg.id);
      if (mo && mo.moved) out.push(lg.id.replace(/_/g, " ") + ": inlet cell moved "
        + fmt(mo.moved, 1) + " ft to the channel floor the lidar sees");
    }
    return out.join(" · ");
  }
  function legNames(p) {
    const seen = [];
    for (const lg of (p.legs || [])) {
      const c = SBMM.storm && SBMM.storm.conduit(lg.id);
      const nm = c ? c.id.replace(/_/g, " ") : lg.id;
      if (!seen.includes(nm)) seen.push(nm);
    }
    if (!seen.length) return "—";
    return seen.length > 4 ? seen.slice(0, 4).join(" → ") + ` → +${seen.length - 4} more` : seen.join(" → ");
  }

  function makeProfile(f) {
    const g = SBMM.tools.rebuildFeature({
      type: "profile", pts: f.pts.map(q => q.slice()),
      name: (f.name || "Raindrop") + " — profile", group: f.group || "Water"
    });
    if (g) {
      SBMM.undo.push("flow profile", () => SBMM.store.remove(g), () => SBMM.store.readd(g));
      SBMM.store.select(g.id);
    }
    return g;
  }

  /* the sparkline: distance across, elevation up, ponds shaded between their
     floor and their level — the shape of the run at a glance */
  function svgFlowProfile(f) {
    const p = f.props || {};
    const zs = (p.zs || []).map(v => (v == null ? NaN : v));
    if (zs.length < 2) return "";
    const W = 300, H = 64, L = 30, R = 6, T = 6, B = 14;
    const pw = W - L - R, ph = H - T - B;
    const good = zs.filter(v => !isNaN(v));
    if (good.length < 2) return "";
    let lo = Math.min(...good), hi = Math.max(...good);
    for (const pd of (p.ponds || [])) { if (pd.level > hi) hi = pd.level; if (pd.level - pd.depth_ft < lo) lo = pd.level - pd.depth_ft; }
    const pad = Math.max(0.4, (hi - lo) * 0.08);
    lo -= pad; hi += pad;
    const total = p.length_ft || 1;
    const X = i => L + pw * i / (zs.length - 1);
    const Y = z => T + ph * (1 - (z - lo) / ((hi - lo) || 1));
    let d = "";
    zs.forEach((z, i) => { if (isNaN(z)) return; d += (d ? " L" : "M") + ` ${X(i).toFixed(1)} ${Y(z).toFixed(1)}`; });
    /* ponds: the run crosses each at its own level, so shade the band between
       the pond floor and its water surface at the vertex nearest that level */
    let bands = "";
    for (const pd of (p.ponds || [])) {
      let best = -1, bd = Infinity;
      zs.forEach((z, i) => { if (isNaN(z)) return; const q = Math.abs(z - pd.level); if (q < bd) { bd = q; best = i; } });
      if (best < 0) continue;
      const w = Math.max(3, pw * Math.min(0.14, (pd.area_ft2 / Math.max(total * 30, 1))));
      bands += `<rect x="${(X(best) - w / 2).toFixed(1)}" y="${Y(pd.level).toFixed(1)}" width="${w.toFixed(1)}"
        height="${Math.max(1.5, Y(pd.level - pd.depth_ft) - Y(pd.level)).toFixed(1)}" fill="rgba(85,193,255,.25)"/>`;
    }
    const lastZ = p.end && p.end.z_last != null ? p.end.z_last : good[good.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" class="axis flowspark">
      <line class="gridl" x1="${L}" x2="${W - R}" y1="${Y(hi - pad).toFixed(1)}" y2="${Y(hi - pad).toFixed(1)}"/>
      <line class="gridl" x1="${L}" x2="${W - R}" y1="${Y(lo + pad).toFixed(1)}" y2="${Y(lo + pad).toFixed(1)}"/>
      ${bands}
      <path d="${d}" fill="none" stroke="${C.line}" stroke-width="1.5" stroke-linejoin="round"/>
      <text x="${L - 3}" y="${(Y(hi - pad) + 3).toFixed(1)}" text-anchor="end">${fmt0(hi - pad)}</text>
      <text x="${L - 3}" y="${(Y(lo + pad) + 3).toFixed(1)}" text-anchor="end">${fmt0(lo + pad)}</text>
      <text x="${L}" y="${H - 3}">0</text>
      <text x="${W - R}" y="${H - 3}" text-anchor="end">${fmt0(total)} ft · ends ${fmt(lastZ, 1)} ft</text>
    </svg>`;
  }

  /* ================================================================== */
  /* overtopping (§1.2, §4.3)                                           */
  /* ================================================================== */
  let ov = null;   /* { name, R, dem, band, markers[], water, z0line, card, route, pool, url, bounds, level } */

  function hermanRing() {
    const D = window.SBMM_DATA && SBMM_DATA.design_gis;
    if (!D || !D.features) return null;
    const f = D.features.find(q => q.properties && q.properties.layer === "water"
      && /Herman/i.test(q.properties.name || ""));
    if (!f || !f.geometry || f.geometry.type !== "Polygon") return null;
    return { ring: f.geometry.coordinates[0].map(q => [q[0], q[1]]), name: f.properties.name };
  }
  /* which named water polygon (if any) a click falls in — only used to NAME a
     point-seeded analysis; the computation is still seeded from the point */
  function waterBodyAt(x, y) {
    const D = window.SBMM_DATA && SBMM_DATA.design_gis;
    if (!D || !D.features) return null;
    for (const f of D.features) {
      const p = f.properties || {};
      if (p.layer !== "water" || !f.geometry || f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0];
      if (pointInPoly(x, y, ring)) return { ring: ring.map(q => [q[0], q[1]]), name: p.name || "Water body" };
    }
    return null;
  }

  /* ---------- the August-2026 survey (spec §10) ----------
     Read from the baked dataset, not from a constant: if the survey is
     re-issued the dataset is rebuilt and the card follows. `ring` decides
     whether the facts apply — only when the surveyed water-level shot lies
     inside the water body being analysed. */
  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }
  function distToRing(ring, x, y) {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0], ay = ring[j][1], bx = ring[i][0], by = ring[i][1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d < best) best = d;
    }
    return best;
  }
  function surveyFacts(ring) {
    const sets = (window.SBMM_DATA && SBMM_DATA.datasets) || [];
    const d = sets.find(x => x.id === "survey_2026");
    if (!d || !d.points) return null;
    const by = id => d.points.find(q => q.id === id);
    const wl = by("Water Level");
    /* the water-level shot is taken AT the shoreline ("shore — water ends"),
       which is exactly where a GIS water polygon drawn a year earlier is a few
       feet off; inside the ring, or within 25 ft of its edge, counts */
    if (!wl || !ring || !(ringContains(ring, wl.x, wl.y) || distToRing(ring, wl.x, wl.y) <= 25)) return null;
    const z = q => (q && q.a && typeof q.a.elevation === "number") ? q.a.elevation : null;
    const pn = by("SD PIPE N"), ps = by("SD PIPE S");
    const inv = [z(pn), z(ps)].filter(v => v != null);
    const tops = d.points.filter(q => q.a && /top of sand bags/i.test(q.a.measure_on || "")).map(z).filter(v => v != null);
    return {
      waterLevel: z(wl), waterXY: [wl.x, wl.y],
      pipeInvert: inv.length ? +(inv.reduce((a, b) => a + b, 0) / inv.length).toFixed(2) : null,
      pipeInverts: inv,
      pipeXY: pn ? [(pn.x + (ps ? ps.x : pn.x)) / 2, (pn.y + (ps ? ps.y : pn.y)) / 2] : null,
      wallCrest: tops.length ? Math.min(...tops) : null, wallTops: tops,
      outlet: SBMM.survey && SBMM.survey.pipeOutlet ? SBMM.survey.pipeOutlet() : null,
      source: d.name
    };
  }
  /* a conduit's short human name — "pond culvert", the same words the raindrop
     card uses for a leg. The raw id goes on the card's second line so a reader
     can find it in the payload. */
  function conduitLabel(id) {
    if (SBMM.storm && SBMM.storm.shortLabel) return SBMM.storm.shortLabel(id);
    return String(id).replace(/_/g, " ");
  }
  function stageAt(R, level) {
    return (R.stage || []).find(s => Math.abs(s.level - level) < 1e-6) || null;
  }

  function overtopHerman(opts) {
    const h = hermanRing();
    if (!h) { toast("the Herman Impoundment polygon is not in this build's design payload"); return Promise.resolve(null); }
    return overtop(Object.assign({ ring: h.ring, name: h.name }, opts || {}));
  }
  function overtopAt(x, y) {
    const wb = waterBodyAt(x, y);
    return overtop({ point: [x, y], name: (wb && wb.name) || "Pond" });
  }

  async function overtop(spec) {
    spec = spec || {};
    const ring = spec.ring || null;
    const point = spec.point || null;
    if (!ring && !point) { toast("nothing to analyse — pick a water body or click on a pond"); return null; }
    const name = spec.name || (ring ? "Water body" : "Pond");
    clearOvertop();

    let pad = 800;
    let R = null, dem = null, bbox = null, facts = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const b = ring ? bboxOf(ring) : [point[0], point[1], point[0], point[1]];
      bbox = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
      dem = SBMM.demForBox(bbox) || SBMM.demSite;
      const grid = SBMM.compute.gridSpec(dem, bbox, 0);
      if (!grid) { toast("that water body is outside the surveyed terrain"); return null; }
      const job = { grid, plateauTol: PLATEAU_TOL, rimRange: RIM_RANGE,
                    levelStep: LEVEL_STEP, maxClusters: 12 };
      /* v13 §2: the storm network, the same list the raindrop is handed — the
         conduit spill is recorded BESIDE the rim analysis, so with the drains
         off (or in a build with no network) this is [] and the answer is the
         v10/v12 answer to the bit. */
      const cds = (SBMM.storm && SBMM.storm.data() && spec.storm !== false)
        ? SBMM.storm.conduitsFor(bbox) : [];
      if (cds.length) { job.conduits = cds; job.captureFt = SBMM.storm.captureFt(); }
      if (ring) job.seedRing = ring.map(q => [q[0], q[1]]); else job.seedPoint = [point[0], point[1]];
      /* spec §10: a surveyed water surface is today's level; the pipe invert
         and the sandbag crest become exact stage rows */
      facts = (ring && spec.survey !== false) ? surveyFacts(ring) : null;
      if (facts && facts.waterLevel != null) job.z0Override = facts.waterLevel;
      if (facts) job.levels = [facts.pipeInvert, facts.wallCrest].filter(v => v != null);
      try {
        R = await SBMM.compute.run("overtop", job,
          { transfer: [grid.z.buffer], label: "Overtopping — " + name }).promise;
      } catch (e) {
        if (e && e.cancelled) return null;
        toast("overtopping analysis failed: " + e.message);
        return null;
      }
      if (R.reason === "window" && attempt < 2) { pad += 800; continue; }
      break;
    }
    if (!R) return null;
    if (R.reason === "noseed") {
      toast("no flat water surface there — click on the water itself, not the bank");
      return null;
    }
    if (!R.primary || R.reason === "nospill") {
      toast("no spill point within " + RIM_RANGE + " ft of the water surface — the rim is higher than the search band", 5200);
      return null;
    }
    if (R.reason === "window")
      toast("the spill search filled the window — treat the rim beyond it as unchecked", 5200);

    ov = { name, R, dem, markers: [], level: R.primary.level, facts, ring: ring || null };
    /* v13 §2: the first discharge through a storm conduit. On Herman the
       conduit spill IS the surveyed pipe (1341.53 against the survey's 1341.55),
       so the §10 pipe row and the surveyed pipe route stand and nothing is
       traced twice; anywhere else it is a new row, a new marker and a new
       route. */
    const CS = R.conduitSpill || null;
    ov.conduitSpill = CS;
    ov.conduitLevel = CS ? (CS.stageLevel != null ? CS.stageLevel : CS.level) : null;
    ov.conduitLabel = CS ? conduitLabel(CS.id) : null;
    ov.csIsPipe = !!(CS && facts && facts.pipeInvert != null
                     && Math.abs(CS.level - facts.pipeInvert) <= 0.1);
    /* v15 §1 — the ruling: when the water finds a conduit BELOW the rim, the
       conduit IS the overflow. The rim spill stays a fact on the card and the
       rim band stays drawn, but no rim overflow route is traced by default and
       nothing claims water goes that way. The route is one button away, and it
       is labelled as what it is: a what-if in which the conduit is blocked.
       The rule is generic — Herman's conduit spill is the surveyed pipe, Frog
       Pond's is the culvert into Green Pond, Green Pond's is its FES. */
    ov.rimSuppressed = !!(CS && ov.conduitLevel != null
                          && ov.conduitLevel < R.primary.level - 1e-6);

    /* the rim band + the exact spill cells, one canvas */
    const painted = paintBand(R);
    ov.url = painted.url; ov.bounds = painted.bounds;
    ov.band = L.imageOverlay(painted.url,
      [[painted.bounds[1], painted.bounds[0]], [painted.bounds[3], painted.bounds[2]]],
      { pane: "analysis", opacity: .85, interactive: false }).addTo(SBMM.map);

    /* today's water surface, for reference */
    const s0 = R.stage && R.stage.length ? R.stage[0] : null;
    if (s0 && s0.rings && s0.rings.length) {
      ov.z0line = L.layerGroup(s0.rings.map(r =>
        L.polyline(r.map(q => [q[1], q[0]]),
          { pane: "vectors", color: C.line, weight: 1.2, dashArray: "3 5", opacity: .8, interactive: false })
      )).addTo(SBMM.map);
    }

    /* the water body at the slider level */
    ov.water = L.layerGroup().addTo(SBMM.map);

    /* rank markers */
    (R.clusters || []).forEach(cl => {
      const pri = cl.rank === 1;
      const badge = RANKS[Math.min(cl.rank, RANKS.length) - 1] || String(cl.rank);
      const lbl = pri
        ? `SPILL ${fmt(cl.level, 2)} ft · +${fmt(R.freeboard_ft, 2)} ft`
        : `${badge} +${fmt(cl.above_ft, 2)} ft · ${fmt(cl.level, 2)}`;
      /* the rim lows of one impoundment cluster in the same corner, so five
         labels land inside forty pixels of each other and read as one smear;
         step them down the page by rank so each is still readable */
      const dy = pri ? -8 : (cl.rank - 1) * 14 - 7;
      const mk = L.marker([cl.y, cl.x], {
        pane: "drawings",
        icon: L.divIcon({
          className: "spillmk" + (pri ? " pri" : ""), iconSize: [0, 0],
          html: `<span class="badge">${esc(badge)}</span>`
            + `<span class="lbl mono" style="top:${dy}px">${esc(lbl)}</span>`
            + (pri ? "" : `<span class="lead" style="height:${Math.abs(dy + 7) + 1}px;`
                + `top:${dy < -7 ? dy + 7 : -7}px"></span>`)
        })
      });
      mk.on("click", () => SBMM.map.setView([cl.y, cl.x], Math.max(SBMM.map.getZoom(), 2)));
      mk.addTo(SBMM.map);
      ov.markers.push(mk);
      mk._lbl = { key: "spill:" + Math.round(cl.x / 5) + ":" + Math.round(cl.y / 5),
                  pri: SBMM.labels.PRI.spill - cl.rank, latlng: [cl.y, cl.x] };
    });

    /* the two real features: they belong to the user's work and survive a
       session; the band, markers and slider are recomputed by running again */
    const spillStage = nearestStage(R, R.primary.level);
    if (spillStage && spillStage.rings && spillStage.rings.length) {
      const pool = SBMM.tools.rebuildFeature({
        type: "area", pts: openRing(spillStage.rings[0]),
        name: `${name} at spill ${R.primary.level.toFixed(1)} ft`, group: "Water"
      });
      if (pool) {
        pool.props.overtop = {
          z0: +R.z0.toFixed(2), spill: +R.primary.level.toFixed(2),
          freeboard_ft: +R.freeboard_ft.toFixed(2), storage_ft3: +R.storage_ft3.toFixed(0)
        };
        ov.pool = pool;
      }
    }
    /* the surveyed discharge pipes: a marker at the inverts and the route
       water takes after it leaves them (spec §10.4) */
    if (facts && facts.pipeXY && facts.pipeInvert != null) {
      const mk = L.marker([facts.pipeXY[1], facts.pipeXY[0]], {
        pane: "drawings",
        icon: L.divIcon({
          className: "spillmk pipe", iconSize: [0, 0],
          html: `<span class="badge">P</span><span class="lbl mono" style="top:-8px">`
            + `PIPES ${fmt(facts.pipeInvert, 2)} ft · +${fmt(facts.pipeInvert - R.z0, 2)} ft</span>`
        })
      });
      mk.on("click", () => SBMM.map.setView([facts.pipeXY[1], facts.pipeXY[0]], Math.max(SBMM.map.getZoom(), 3)));
      mk.addTo(SBMM.map);
      ov.markers.push(mk);
      mk._lbl = { key: "spill:pipes", pri: SBMM.labels.PRI.spill,
                  latlng: [facts.pipeXY[1], facts.pipeXY[0]] };
    }
    /* the conduit spill's own marker — "C", beside the rim's ①, so the two
       answers are visibly two answers (v13 §2) */
    if (CS && !ov.csIsPipe) {
      const mk = L.marker([CS.y, CS.x], {
        pane: "drawings",
        icon: L.divIcon({
          className: "spillmk conduit", iconSize: [0, 0],
          /* BELOW the badge, not level with it: the conduit spill is usually a
             few feet from the rim spill, so two labels at the same offset land
             on top of each other and neither can be read (the ranked rim lows
             are stepped down the page for the same reason) */
          html: `<span class="badge">C</span><span class="lbl mono" style="top:10px">`
            + `${esc(ov.conduitLabel.toUpperCase())} ${fmt(ov.conduitLevel, 2)} ft · `
            + `+${fmt(ov.conduitLevel - R.z0, 2)} ft</span>`
        })
      });
      mk.on("click", () => SBMM.map.setView([CS.y, CS.x], Math.max(SBMM.map.getZoom(), 3)));
      mk.addTo(SBMM.map);
      ov.markers.push(mk);
      mk._lbl = { key: "spill:conduit:" + CS.id, pri: SBMM.labels.PRI.spill,
                  latlng: [CS.y, CS.x] };
    }
    if (facts && facts.outlet) {
      const pr = await dropAt(facts.outlet[0], facts.outlet[1], {
        name: `${name} pipe discharge route`, group: "Water", quiet: true,
        blockRing: ring, plateauTol: PLATEAU_TOL
      });
      if (pr) {
        ov.pipeRoute = pr; pr.props.blockRing = null;
        /* the route is no longer "where does this water go" but "it goes down
           EA's storm main", and the feature says so in the tree and the card */
        if (pr.props.outfall) {
          pr.name = `${name} pipe discharge route (storm main)`;
          const rn = pr.card && pr.card.querySelector(".rname");
          if (rn) rn.textContent = pr.name;
          SBMM.store.emit();
        }
      }
    }
    /* the first-discharge route: a raindrop dropped ON the conduit spill's own
       kernel cell with the network on, so its first leg is the conduit and it
       carries on down the chain, and with the water body blocked so a route that
       comes back to it ends there (v13 §2). Herman's is already traced from the
       surveyed pipe outlet, and one route is enough. */
    if (CS && !ov.csIsPipe) {
      const cr = await dropAt(CS.x, CS.y, {
        name: `${name} first-discharge route (${ov.conduitLabel})`, group: "Water", quiet: true,
        dem, window: bbox, plateauTol: PLATEAU_TOL,
        blockRing: ring || (s0 && s0.rings && s0.rings.length ? s0.rings[0] : null)
      });
      if (cr) { ov.conduitRoute = cr; cr.props.blockRing = null; }
    }
    /* v15 §1: the rim overflow. Everything needed to trace it is kept either
       way — the seed cell, the analysis's own grid and window, and the ring to
       treat as blocked — so the what-if button is one job away and runs on the
       same grid the analysis did (§2: one analysis, one grid). */
    const nx = R.primary.next;
    ov.rimSeed = nx || null;
    ov.rimDem = dem; ov.rimWindow = bbox;
    ov.rimBlock = ring || (s0 && s0.rings && s0.rings.length ? s0.rings[0] : null);
    if (nx && !ov.rimSuppressed) {
      const route = await dropAt(nx[0], nx[1], {
        name: `${name} overflow route`, group: "Water", quiet: true,
        dem, window: bbox, plateauTol: PLATEAU_TOL, blockRing: ov.rimBlock
      });
      if (route) { ov.route = route; route.props.blockRing = null; }
    }

    registerOvLabels();
    overtopCard();
    applyLevel(ov.defaultLevel != null ? ov.defaultLevel : R.primary.level);
    if (SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
    SBMM.shell.showResults();
    return R;
  }

  /* The overlay's markers carry their own label spec, so hiding and showing the
     overlay can re-register them in one pass rather than leaving the registry
     measuring elements Leaflet has taken off the map (v15 §2.2). */
  function registerOvLabels() {
    SBMM.labels.removeOwner("overtop");
    if (!ov || ov.hidden) return;
    for (const m of ov.markers)
      if (m._lbl) SBMM.labels.add({ key: m._lbl.key, priority: m._lbl.pri, marker: m,
                                    owner: "overtop", latlng: m._lbl.latlng });
  }

  /* v15 §1 — the what-if. The rim overflow is NOT the answer when a conduit
     carries the water first, so it is traced only on request, named for what it
     assumes, and drawn as a hypothesis (dashed, muted, no animation). It belongs
     to the analysis: closing the analysis takes it with it, which is why it is
     created without an undo entry — there is no user action to undo, and an undo
     stack entry pointing at a feature the analysis has since removed is worse
     than none. */
  async function traceRimWhatIf(btn) {
    if (!ov) { toast("no overtopping analysis is open"); return null; }
    if (ov.rimRoute) {
      const old = ov.rimRoute;
      ov.rimRoute = null;
      SBMM.store.remove(old);
      paintRimBtn();
      toast("the rim overflow what-if is cleared");
      if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
      return null;
    }
    if (!ov.rimSeed) { toast("this analysis has no rim spill to trace an overflow from"); return null; }
    const blocked = ov.csIsPipe ? "the 24-in pipes" : (ov.conduitLabel || "the drains");
    if (btn) { btn.disabled = true; btn.textContent = "tracing…"; }
    const r = await dropAt(ov.rimSeed[0], ov.rimSeed[1], {
      name: `${ov.name} rim overflow — what-if: ${blocked} blocked`,
      group: "Water", quiet: true, noUndo: true, whatif: true,
      dem: ov.rimDem, window: ov.rimWindow, plateauTol: PLATEAU_TOL, blockRing: ov.rimBlock
    });
    if (!r) { paintRimBtn(); return null; }
    r.props.blockRing = null;
    ov.rimRoute = r;
    paintRimBtn();
    toast(`what-if: with ${blocked} blocked the water leaves over the rim at `
      + `${fmt(ov.R.primary.level, 2)} ft — ${fmt0(r.props.length_ft)} ft, ${endShort(r.props)}`, 5200);
    if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
    return r;
  }
  function paintRimBtn() {
    const b = ov && ov.card && ov.card.querySelector('[data-w="rimwhatif"]');
    if (!b) return;
    b.disabled = false;
    b.textContent = ov.rimRoute ? "hide the rim overflow" : "trace the rim overflow";
    b.classList.toggle("active", !!ov.rimRoute);
  }

  function nearestStage(R, level) {
    let best = null, bd = Infinity;
    for (const s of (R.stage || [])) { const d = Math.abs(s.level - level); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  /* the rim band: hot where the rim is at the spill, fading out as it rises.
     `v = level - primary`, NaN outside the band; the exact spill cells are
     painted saturated at full alpha so they survive any zoom. */
  const BAND_STOPS = [
    [0.0, [255, 77, 61]],
    [0.5, [255, 138, 61]],
    [1.5, [255, 209, 102]],
    [RIM_RANGE, [255, 243, 176]]
  ];
  function bandColor(v) {
    let a = BAND_STOPS[0], b = BAND_STOPS[BAND_STOPS.length - 1];
    for (let i = 0; i < BAND_STOPS.length - 1; i++)
      if (v >= BAND_STOPS[i][0] && v <= BAND_STOPS[i + 1][0]) { a = BAND_STOPS[i]; b = BAND_STOPS[i + 1]; break; }
    const t = (b[0] - a[0]) > 0 ? clamp((v - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    return [a[1][0] + (b[1][0] - a[1][0]) * t,
            a[1][1] + (b[1][1] - a[1][1]) * t,
            a[1][2] + (b[1][2] - a[1][2]) * t];
  }
  function paintBand(R) {
    const B = R.band, S = R.spillMask;
    const nx = B.nx, ny = B.ny;
    const c = document.createElement("canvas");
    c.width = nx; c.height = ny;
    const g = c.getContext("2d");
    const img = g.createImageData(nx, ny), px = img.data;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = B.v[j * nx + i];
      const k = ((ny - 1 - j) * nx + i) * 4;      // grid row 0 = south, canvas row 0 = north
      if (isNaN(v)) { px[k + 3] = 0; continue; }
      const t = clamp(v / RIM_RANGE, 0, 1);
      const col = bandColor(v);
      px[k] = col[0] | 0; px[k + 1] = col[1] | 0; px[k + 2] = col[2] | 0;
      px[k + 3] = Math.round(255 * (0.92 + (0.10 - 0.92) * t));
    }
    if (S && S.v) for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
      if (!S.v[j * S.nx + i]) continue;
      const k = ((S.ny - 1 - j) * S.nx + i) * 4;
      px[k] = 255; px[k + 1] = 42; px[k + 2] = 26; px[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    /* x0/y0 are the CENTRE of cell (0,0), so the image rectangle is half a cell
       bigger all round — the kernel hands that over as bx0..by1 rather than
       leaving two places to get it wrong */
    const bx0 = B.bx0 != null ? B.bx0 : B.x0 - B.cell / 2;
    const by0 = B.by0 != null ? B.by0 : B.y0 - B.cell / 2;
    const bx1 = B.bx1 != null ? B.bx1 : B.x0 + (nx - 0.5) * B.cell;
    const by1 = B.by1 != null ? B.by1 : B.y0 + (ny - 0.5) * B.cell;
    return { url: c.toDataURL("image/png"), bounds: [bx0, by0, bx1, by1] };
  }

  /* the slider: raise the water and watch it find the low rim */
  function applyLevel(level) {
    if (!ov) return;
    const R = ov.R;
    ov.level = level;
    const s = nearestStage(R, level);
    ov.water.clearLayers();
    if (s && s.rings && s.rings.length) {
      L.polygon(s.rings.map(r => r.map(q => [q[1], q[0]])), {
        pane: "vectors", color: C.line, weight: 1.5, fillColor: C.line,
        fillOpacity: .22, fillRule: "evenodd", interactive: false
      }).addTo(ov.water);
    }
    const spilling = level >= R.primary.level - 1e-6;
    const F = ov.facts;
    const piping = !!(F && F.pipeInvert != null && level >= F.pipeInvert - 1e-6);
    const overCrest = !!(F && F.wallCrest != null && level >= F.wallCrest - 1e-6);
    /* v13: below the conduit level neither route shows; from it the conduit
       route shows; from the rim spill the rim route shows too. */
    const draining = !!(ov.conduitRoute && ov.conduitLevel != null
                        && level >= ov.conduitLevel - 1e-6);
    const changed = ov.spilling !== spilling || ov.piping !== piping || ov.draining !== draining;
    ov.spilling = spilling; ov.piping = piping; ov.draining = draining;
    if (ov.route) SBMM.store.setVisible(ov.route, spilling);
    if (ov.pipeRoute) SBMM.store.setVisible(ov.pipeRoute, piping);
    if (ov.conduitRoute) SBMM.store.setVisible(ov.conduitRoute, draining);
    /* the what-if is shown from the moment it is asked for: it answers "what if
       the conduit were blocked", which is a question about the rim, not about
       where this slider happens to sit */
    if (ov.rimRoute) SBMM.store.setVisible(ov.rimRoute, true);
    const el = ov.card && ov.card.querySelector(".wslabel");
    if (el) {
      const store = s ? s.storage_ft3 : 0;
      /* v15 §1: above the rim, with a conduit carrying the water below it, the
         honest sentence is not "OVERFLOWS" — it is that the drains are assumed
         to take it and the rim route is a what-if one button away. */
      let state = (spilling && ov.rimSuppressed)
          ? "above the rim · the drains are assumed to carry it (trace the rim overflow to see the what-if)"
        : spilling ? "OVERFLOWS the rim at ①"
        : overCrest ? "above the sandbag crest · discharging through the pipes"
        : piping ? "discharging through the 24-in pipes"
        : draining ? "discharging through " + ov.conduitLabel
        : "no discharge";
      if (level > R.primary.level + 1e-6 && !ov.rimSuppressed) state += " (if the rim at ① were raised)";
      el.textContent = `water level ${fmt(level, 2)} ft · +${fmt(level - R.z0, 2)} ft above today · `
        + `${fmt(acft(store), 1)} ac-ft to store · ` + state
        + (s && s.extra ? " · surveyed stage" : "");
    }
    /* only when the answer changed — a slider drag fires this per pixel, and
       rebuilding every draped ring per pixel is how a smooth control becomes a
       slideshow */
    if (changed && SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
    /* the stage surface in 3D, at the slider's own level (v13 §3.2). This one
       IS cheap to move — one ShapeGeometry at a constant z — so it follows every
       step of the slider rather than only the changes of state. */
    if (SBMM.viewer3d.setWaterStage) SBMM.viewer3d.setWaterStage(stageSpec());
  }

  /* what js/viewer3d.js draws as the water surface: the flooded outline at the
     slider's level, plus the labels the 2D markers carry (v13 §3.2). */
  function stageSpec() {
    if (!ov || ov.hidden || !ov.R || !ov.R.primary) return null;
    const R = ov.R, level = ov.level == null ? R.primary.level : ov.level;
    const s = nearestStage(R, level);
    if (!s || !s.rings || !s.rings.length) return null;
    /* v15 §2.3 — the labels are about the level the user is LOOKING at, so each
       one states where it stands relative to the slider: how far the water still
       has to rise to reach it, or that it has already been passed. The viewer
       diffs these by text, so a slider step only rebuilds the sprites whose
       words actually changed. */
    const L = s.level;
    const state = z => (L >= z - 1e-6 ? " · overtopped" : " · +" + fmt(z - L, 2) + " ft to go");
    const labels = (R.clusters || []).map(cl => ({
      key: "rim" + cl.rank, x: cl.x, y: cl.y, z: cl.level, priority: 80 - cl.rank,
      /* the rim lows of one impoundment cluster in the same corner, so their
         chips are stepped up the screen by rank — the same reason the 2D
         markers step their labels down the page (v10 §4.3) */
      liftPx: 108 + (cl.rank - 1) * 26,
      text: (cl.rank === 1 ? "rim spill" : "rim low " + cl.rank)
        + " · " + fmt(cl.level, 2) + state(cl.level),
      color: L >= cl.level - 1e-6 ? C.spill : "#E8B34B",
      /* §3.2: the chip answers a hover and a click in 3D, like everything else */
      title: (cl.rank === 1 ? "Rim spill" : "Rim low " + cl.rank),
      html: `<b>${cl.rank === 1 ? "Rim spill" : "Rim low " + cl.rank} — ${esc(ov.name)}</b>`
        + `<br>level ${fmt(cl.level, 2)} ft`
        + (cl.rank === 1 ? "" : ` · +${fmt(cl.above_ft, 2)} ft above the spill`)
        + `<br>water at ${fmt(L, 2)} ft — ${L >= cl.level - 1e-6 ? "overtopped"
             : fmt(cl.level - L, 2) + " ft to go"}`
        + `<br>${fmt0(cl.x)} E, ${fmt0(cl.y)} N · ${cl.cells} cells`
        + `<br><span style="opacity:.7">Static spill analysis on the lidar bare earth `
        + `(docs/V10_WATER_SPEC.md §2) — no inflow, wave run-up or seepage.</span>`
    }));
    /* the water surface itself, at the centroid of its largest ring */
    {
      let big = null, ba = -1;
      for (const r of s.rings) {
        if (!r || r.length < 3) continue;
        let a = 0;
        for (let i = 0; i < r.length; i++) { const q = r[i], w = r[(i + 1) % r.length]; a += q[0] * w[1] - w[0] * q[1]; }
        a = Math.abs(a) / 2;
        if (a > ba) { ba = a; big = r; }
      }
      if (big) {
        const c = centroid(big);
        labels.push({ key: "level", x: c[0], y: c[1], z: L, priority: 95, liftPx: 26,
                      text: "water level " + fmt(L, 2) + " ft", color: C.line,
                      title: "Water level",
                      html: `<b>${esc(ov.name)} — water level ${fmt(L, 2)} ft</b>`
                        + `<br>+${fmt(L - R.z0, 2)} ft above today (${fmt(R.z0, 2)} ft)`
                        + (s.storage_ft3 != null ? `<br>${fmt(acft(s.storage_ft3), 1)} ac-ft stored · `
                            + `${fmt(acft(s.area_ft2), 2)} ac` : "") });
      }
    }
    const dis = z => (L >= z - 1e-6 ? " · discharging" : " · +" + fmt(z - L, 2) + " ft to go");
    if (ov.conduitSpill && !ov.csIsPipe)
      labels.push({ key: "cs", x: ov.conduitSpill.x, y: ov.conduitSpill.y, z: ov.conduitLevel,
                    priority: 90, liftPx: 56,
                    text: "first discharge · " + ov.conduitLabel + " · "
                      + fmt(ov.conduitLevel, 2) + dis(ov.conduitLevel),
                    color: STORM_COL, title: "First discharge",
                    html: `<b>First discharge — ${esc(ov.conduitLabel)}</b>`
                      + `<br>rim ${fmt(ov.conduitLevel, 2)} ft · +${fmt(ov.conduitLevel - R.z0, 2)} ft above today`
                      + `<br>water at ${fmt(L, 2)} ft — ${L >= ov.conduitLevel - 1e-6 ? "discharging"
                           : fmt(ov.conduitLevel - L, 2) + " ft to go"}`
                      + `<br><span style="opacity:.7">A conduit is a topological shortcut with an `
                      + `elevation at each end — no capacity, no hydraulic grade line.</span>` });
    if (ov.facts && ov.facts.pipeXY && ov.facts.pipeInvert != null)
      labels.push({ key: "pipes", x: ov.facts.pipeXY[0], y: ov.facts.pipeXY[1],
                    z: ov.facts.pipeInvert, priority: 90, liftPx: 82,
                    text: "24-in pipes · " + fmt(ov.facts.pipeInvert, 2) + dis(ov.facts.pipeInvert),
                    color: STORM_COL, title: "24-in HDPE pipes",
                    html: `<b>24-in HDPE discharge pipes</b>`
                      + `<br>surveyed invert ${fmt(ov.facts.pipeInvert, 2)} ft (Jacobs, Aug 2026)`
                      + `<br>water at ${fmt(L, 2)} ft — ${L >= ov.facts.pipeInvert - 1e-6 ? "discharging"
                           : fmt(ov.facts.pipeInvert - L, 2) + " ft to go"}` });
    return { rings: s.rings, level: s.level, labels };
  }

  /* v15 §1 — the intended system, read back as a sentence. Built from the
     route's own legs and the ponds it filled on the way (each pond that left
     through a conduit carries that conduit's id in `via`), so it describes what
     was actually traced rather than a story about the site:
       "→ Green Pond (fills to 1,394.50) → green outlet → storm main lower →
        Clear Lake outfall". */
  function chainSentence(f) {
    if (!f || !f.props) return "";
    const p = f.props;
    const legs = (p.legs || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
    if (legs.length < 2) return "";
    const parts = [];
    /* the FIRST leg is the first discharge and the row above already names it;
       what this sentence adds is everything after it */
    for (let i = 1; i < legs.length; i++) {
      const pd = (p.ponds || []).find(q => q.via === legs[i].id);
      if (pd) {
        const c = pondCentre(pd);
        const wb = c ? waterBodyAt(c[0], c[1]) : null;
        parts.push(`${wb ? wb.name : "a pond"} (fills to ${fmt(pd.level, 2)})`);
      }
      /* a chain of eight road-drain runs between two grates is ONE thing to a
         reader — collapse consecutive legs of the same family (the label's
         first two words) into that family's name */
      const fam = conduitLabel(legs[i].id).split(" ").slice(0, 2).join(" ");
      if (parts[parts.length - 1] !== fam) parts.push(fam);
    }
    parts.push(p.outfall ? "Clear Lake outfall" : endShort(p));
    return parts.length < 2 ? "" : "→ " + parts.join(" → ");
  }
  function pondCentre(pd) {
    const r = (pd.rings || [])[0];
    if (!r || r.length < 3) return null;
    return centroid(r);
  }

  function overtopCard() {
    const R = ov.R;
    const grid = gridLabel(ov.dem) + " lidar grid";
    const rt = ov.route ? ov.route.props : null;
    const F = ov.facts;
    const rows = [];
    if (F && F.waterLevel != null) {
      rows.push(["Water surface (surveyed, Aug 2026)", fmt(R.z0, 2) + " ft"]);
      rows.push(["Lidar plateau (Jan 2024)", fmt(R.z0_lidar != null ? R.z0_lidar : R.z0, 2) + " ft"]);
    } else rows.push(["Water surface (lidar, Jan 2024)", fmt(R.z0, 2) + " ft"]);
    /* v13 §2: the first discharge through the storm network, ABOVE the rim
       spill, because it happens first. On Herman the conduit spill is the
       surveyed pipe, so the §10 row below carries the `via` instead of a
       second row saying the same thing one hundredth of a foot lower. */
    if (ov.conduitSpill && !ov.csIsPipe) {
      const cst = stageAt(R, ov.conduitLevel);
      rows.push(["First discharge",
        `through ${ov.conduitLabel} at ${fmt(ov.conduitLevel, 2)} ft · `
        + `+${fmt(ov.conduitLevel - R.z0, 2)} ft`
        + (cst ? ` · ${fmt(acft(cst.storage_ft3), 2)} ac-ft` : "")]);
      rows.push(["", `${ov.conduitSpill.id} · ${SBMM.storm ? SBMM.storm.labelOf(ov.conduitSpill.id) : ""}`]);
      const cr = ov.conduitRoute ? ov.conduitRoute.props : null;
      rows.push(["First-discharge route", !cr ? "—"
        : (cr.pipe_ft > 0
            ? `${fmt0(cr.total_ft)} ft · ${fmt0(cr.pipe_ft)} ft in pipe · `
              + (cr.outfall ? "Clear Lake outfall" : endShort(cr))
            : `${fmt0(cr.length_ft)} ft · ${endShort(cr)}`)]);
      const chain = chainSentence(ov.conduitRoute);
      if (chain) rows.push(["", chain]);
    }
    if (F && F.pipeInvert != null) {
      const st = stageAt(R, F.pipeInvert);
      rows.push(["First discharge", `24-in HDPE pipes · invert ${fmt(F.pipeInvert, 2)} ft · +${fmt(F.pipeInvert - R.z0, 2)} ft`
        + (ov.csIsPipe ? ` · via ${ov.conduitSpill.id}` : "")]);
      if (st) rows.push(["Storage to the pipes", `${fmt(acft(st.storage_ft3), 1)} ac-ft · ${fmt(acft(st.area_ft2), 2)} ac`]);
      const pt = ov.pipeRoute ? ov.pipeRoute.props : null;
      /* v12 §5.2: with the storm network on, what leaves the pipes is not a
         raindrop running over the ground — it is 797 ft of EA's storm main and
         then the lake, and the row says how much of it is in pipe. */
      rows.push(["Pipe discharge route", !pt ? "—"
        : (pt.outfall
            ? `${fmt0(pt.total_ft != null ? pt.total_ft : pt.length_ft)} ft · ${fmt0(pt.pipe_ft)} ft in pipe · Clear Lake outfall`
            : (pt.pipe_ft > 0
                ? `${fmt0(pt.total_ft)} ft · ${fmt0(pt.pipe_ft)} ft in pipe · ${endShort(pt)}`
                : `${fmt0(pt.length_ft)} ft · ${endShort(pt)}`))]);
      const chain = chainSentence(ov.pipeRoute);
      if (chain) rows.push(["", chain]);
    }
    if (F && F.wallCrest != null) {
      const st = stageAt(R, F.wallCrest);
      rows.push(["Sandbag wall crest", `${fmt(F.wallCrest, 2)} ft · +${fmt(F.wallCrest - R.z0, 2)} ft`
        + (st ? ` · ${fmt(acft(st.storage_ft3), 1)} ac-ft` : "")]);
    }
    /* v15 §1: with a conduit carrying the water first, the rim spill is a FACT
       on this card and not a route on the map. Say so in the row itself, and say
       what carries it instead, so nobody reads the number as a prediction. */
    const carrier = ov.csIsPipe ? "the 24-in pipes" : ov.conduitLabel;
    rows.push(
      /* "Rim spill" rather than "Spill elevation" the moment there is something
         to tell it apart from — a surveyed pipe, or a storm conduit (v13 §2) */
      [(F || ov.conduitSpill) ? "Rim spill (lidar)" : "Spill elevation",
        fmt(R.primary.level, 2) + " ft"
        + (ov.rimSuppressed
            ? ` · +${fmt(R.primary.level - ov.conduitLevel, 2)} ft above ${carrier}`
              + " — not traced; the drains are assumed to handle it"
            : "")],
      ["Freeboard to the rim", fmt(R.freeboard_ft, 2) + " ft"],
      ["Spills at", `${fmt0(R.primary.x)} E, ${fmt0(R.primary.y)} N`],
      ["Storage to spill", fmt(acft(R.storage_ft3), 1) + " ac-ft"],
      ["", fmt0(R.storage_ft3) + " ft³"],
      ["Area at spill", fmt(acft(R.area_ft2), 2) + " ac"],
      ["Overflow route", ov.rimSuppressed
        ? "not traced — the drains are assumed to carry it"
        : (rt ? `${fmt0(rt.length_ft)} ft · ${endShort(rt)}` : "—")],
      ["Grid", grid + " · " + fmt0(R.seedCells) + " cells of water surface"]
    );
    const el = SBMM.results.card(null, "Overtopping — " + ov.name, rows);
    ov.card = el;

    /* the rim lows, ranked */
    const tbl = document.createElement("table");
    tbl.className = "rimtbl";
    tbl.innerHTML = `<thead><tr><th></th><th>above spill</th><th>level</th><th>E, N</th><th></th></tr></thead>`
      + "<tbody>" + (R.clusters || []).map(cl =>
        `<tr data-x="${cl.x}" data-y="${cl.y}">
           <td class="rk${cl.rank === 1 ? " pri" : ""}">${esc(RANKS[Math.min(cl.rank, RANKS.length) - 1] || cl.rank)}</td>
           <td class="num">${cl.rank === 1 ? "spill" : "+" + fmt(cl.above_ft, 2) + " ft"}</td>
           <td class="num">${fmt(cl.level, 2)}</td>
           <td class="num">${fmt0(cl.x)}, ${fmt0(cl.y)}</td>
           <td><span class="minib" data-zoom="1">zoom</span></td></tr>`).join("") + "</tbody>";
    tbl.addEventListener("click", ev => {
      const tr = ev.target.closest("tr[data-x]");
      if (!tr) return;
      SBMM.map.setView([+tr.dataset.y, +tr.dataset.x], Math.max(SBMM.map.getZoom(), 2));
    });
    el.appendChild(tbl);

    /* the level slider */
    const sl = document.createElement("div");
    sl.className = "wslider";
    /* The slider walks the STAGE TABLE by index rather than a numeric step: the
       regular rows run from z0 every 0.25 ft, and the surveyed rows (a pipe
       invert, a sandbag crest) sit between them at their exact elevations, so
       the thumb snaps onto them. The spill almost never lands on a regular
       step, so the default is the first row AT OR ABOVE the spill — snapping
       the other way would open the card saying "no overflow" about an analysis
       whose whole subject is the overflow. */
    const S = R.stage || [];
    let di = S.findIndex(x => x.level >= R.primary.level - 1e-6);
    if (di < 0) di = S.length - 1;
    sl.innerHTML = `<div class="wslabel mono"></div>
      <input type="range" id="wsRange" min="0" max="${Math.max(0, S.length - 1)}" step="1" value="${di}">`;
    el.appendChild(sl);
    sl.querySelector("#wsRange").addEventListener("input", ev => {
      const st = S[+ev.target.value]; if (st) applyLevel(st.level);
    });
    ov.defaultLevel = S[di] ? S[di].level : R.primary.level;

    /* the stage–storage chart */
    const ch = document.createElement("div");
    ch.className = "wchart";
    ch.innerHTML = svgStage(R);
    el.appendChild(ch);

    /* the band legend */
    const leg = document.createElement("div");
    leg.className = "legend rimleg";
    leg.innerHTML = `<span class="mono">at spill</span>
      <span class="rampbar" style="background:linear-gradient(90deg,#FF4D3D,#FF8A3D,#FFD166,#FFF3B0)"></span>
      <span class="mono">+${RIM_RANGE} ft</span>`;
    el.appendChild(leg);

    const btns = document.createElement("div");
    btns.className = "crow btns";
    btns.innerHTML = `<button class="minib" data-w="hide">hide overlay</button>`
      + (ov.rimSuppressed
          ? `<button class="minib whatif" data-w="rimwhatif" title="What-if: ${esc(carrier)} blocked — `
            + `trace where the water would go over the rim instead">trace the rim overflow</button>`
          : "")
      + `<button class="minib" data-w="3d">3D</button>`
      + `<button class="minib" data-w="clear">clear</button>`;
    btns.addEventListener("click", ev => {
      const w = ev.target.dataset && ev.target.dataset.w;
      if (!w) return;
      if (w === "hide") toggleOverlay(ev.target);
      if (w === "rimwhatif") traceRimWhatIf(ev.target);
      if (w === "3d") SBMM.viewer3d.openAt(R.primary.x, R.primary.y);
      if (w === "clear") { clearOvertop(); toast("water overlays cleared"); }
    });
    el.appendChild(btns);

    SBMM.results.appendNote(el,
      "Static spill analysis on the " + grid + " lidar bare earth: "
      + (F && F.waterLevel != null
        ? "today's water surface is the surveyed level (Jacobs, Aug 2026, " + fmt(R.z0, 2) + " ft) over the lidar's "
          + "water footprint (its flat return read " + fmt(R.z0_lidar != null ? R.z0_lidar : R.z0, 2) + " ft in Jan 2024); "
          + "the first discharge is the surveyed 24-in pipes, the rim spill is the lidar's; "
          + "the sandbag wall beside the pipes is surveyed at " + fmt(F.wallCrest, 2) + " ft, the lidar rim there reads higher (rim low ②) — "
          + "the survey is the current truth for the wall itself. "
        : "the water surface is the lidar's flat return over the pond (" + fmt(R.z0, 1) + " ft), ")
      + "the spill is the lowest rim "
      + "cell from which water drains away (pit-filled DEM), storage is geometric. Above the spill "
      + "the table describes a sealed flood — what would happen if the low rim at ① were raised. "
      + "No inflow, wave run-up, seepage or erosion — planning-level."
      + (F ? " Surveyed levels are used where they exist; the lidar supplies the terrain." : ""));
  }

  function toggleOverlay(btn) {
    if (!ov) return;
    const on = !ov.hidden;
    ov.hidden = on;
    for (const l of [ov.band, ov.z0line, ov.water]) if (l) { if (on) SBMM.map.removeLayer(l); else l.addTo(SBMM.map); }
    for (const m of ov.markers) { if (on) SBMM.map.removeLayer(m); else m.addTo(SBMM.map); }
    registerOvLabels();
    if (btn) btn.textContent = on ? "show overlay" : "hide overlay";
    if (SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
    if (SBMM.viewer3d.setWaterStage) SBMM.viewer3d.setWaterStage(stageSpec());
  }

  /* storage (ac-ft, right axis) and area (ac, left axis) against level, with the
     spill marked — the two curves a dam engineer reads first */
  function svgStage(R) {
    const S = R.stage || [];
    if (S.length < 2) return "";
    const W = 300, H = 110, L = 30, Rr = 32, T = 8, B = 18;
    const pw = W - L - Rr, ph = H - T - B;
    const l0 = S[0].level, l1 = S[S.length - 1].level;
    let aMax = 0, aMin = Infinity, sMax = 0;
    for (const s of S) { aMax = Math.max(aMax, acft(s.area_ft2)); aMin = Math.min(aMin, acft(s.area_ft2)); sMax = Math.max(sMax, acft(s.storage_ft3)); }
    aMax = aMax || 1; sMax = sMax || 1;
    if (!isFinite(aMin) || aMax - aMin < 1e-9) aMin = 0;
    const X = l => L + pw * (l - l0) / ((l1 - l0) || 1);
    const Ya = a => T + ph * (1 - (a - aMin) / (aMax - aMin || 1));
    const Ys = s => T + ph * (1 - s / sMax);
    let ps = "", pa = "";
    S.forEach(s => {
      ps += (ps ? " L" : "M") + ` ${X(s.level).toFixed(1)} ${Ys(acft(s.storage_ft3)).toFixed(1)}`;
      pa += (pa ? " L" : "M") + ` ${X(s.level).toFixed(1)} ${Ya(acft(s.area_ft2)).toFixed(1)}`;
    });
    const xs = X(R.primary.level);
    /* the surveyed stages (spec §10): dashed rules at the pipe invert and the
       sandbag crest, labelled so the chart reads as the sequence of events */
    let rules = "";
    const F = ov && ov.facts;
    if (F) {
      const marks = [[F.pipeInvert, "pipes"], [F.wallCrest, "crest"]];
      for (const [lv, lab] of marks) {
        if (lv == null || lv < l0 || lv > l1) continue;
        const xr = X(lv).toFixed(1);
        rules += `<line x1="${xr}" x2="${xr}" y1="${T}" y2="${T + ph}" stroke="${C.drop}" stroke-width="1" stroke-dasharray="3 3"/>`
          + `<text x="${(+xr + 3).toFixed(1)}" y="${T + ph - 3}" fill="${C.drop}">${lab}</text>`;
      }
    }
    return `<svg viewBox="0 0 ${W} ${H}" class="axis stagechart">${rules}
      <line class="gridl" x1="${L}" x2="${W - Rr}" y1="${T}" y2="${T}"/>
      <line class="gridl" x1="${L}" x2="${W - Rr}" y1="${T + ph}" y2="${T + ph}"/>
      <path d="${pa}" fill="none" stroke="${C.drop}" stroke-width="1.3" stroke-dasharray="4 3"/>
      <path d="${ps}" fill="none" stroke="${C.line}" stroke-width="1.6"/>
      <line x1="${xs.toFixed(1)}" x2="${xs.toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="${C.spill}" stroke-width="1"/>
      <text x="${(xs + 3).toFixed(1)}" y="${T + 9}" fill="${C.spill}">spill</text>
      <text x="${L - 3}" y="${T + 8}" text-anchor="end">${fmt(aMax, 1)}</text>
      <text x="${L - 3}" y="${T + ph}" text-anchor="end">${fmt(aMin, 1)} ac</text>
      <text x="${W - Rr + 3}" y="${T + 8}">${fmt(sMax, 0)}</text>
      <text x="${W - Rr + 3}" y="${T + ph}">ac-ft</text>
      <text x="${L}" y="${H - 4}">${fmt(l0, 1)}</text>
      <text x="${W - Rr}" y="${H - 4}" text-anchor="end">${fmt(l1, 1)} ft</text>
    </svg>`;
  }

  function clearOvertop() {
    if (!ov) return;
    for (const l of [ov.band, ov.z0line, ov.water]) if (l) SBMM.map.removeLayer(l);
    for (const m of ov.markers) SBMM.map.removeLayer(m);
    SBMM.labels.removeOwner("overtop");
    /* the what-if belongs to the analysis (v15 §1) and goes with it; the real
       routes are the user's features and stay, as they always have */
    if (ov.rimRoute) { SBMM.store.remove(ov.rimRoute); ov.rimRoute = null; }
    if (ov.card) ov.card.remove();
    ov = null;
    SBMM.results.checkEmpty();
    if (SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
    if (SBMM.viewer3d.setWaterStage) SBMM.viewer3d.setWaterStage(null);
  }

  /* what js/viewer3d.js drapes on the terrain — the same picture as 2D, so
     there is one rim band and one legend rather than two */
  function drapeSpec() {
    if (!ov || ov.hidden || !ov.url) return null;
    return { url: ov.url, bounds: ov.bounds };
  }
  function active() { return ov ? ov.R : null; }

  /* ================================================================== */
  /* chrome: the Water ▾ menu                                           */
  /* ================================================================== */
  function pickPond() {
    SBMM.mode.navigate();
    toast("click on the water — the pond under the click is analysed");
    SBMM.draw.beginPick({
      count: 1,
      prompts: ["Overtopping — click on the pond or impoundment"],
      onDone: pts => { overtopAt(pts[0][0], pts[0][1]); },
      onCancel: () => toast("overtopping cancelled")
    });
  }

  function wire() {
    /* the pond labels are zoom-gated; nothing is rebuilt, only shown or hidden */
    if (SBMM.map) SBMM.map.on("zoomend", refreshLabels);
    const btn = document.getElementById("waterMenuBtn");
    const menu = document.getElementById("waterMenu");
    if (!btn || !menu) return;
    btn.onclick = e => {
      e.stopPropagation();
      const open = menu.style.display === "block";
      document.querySelectorAll("#drawMenu,#designMenu,#waterMenu,#exportMenu,#ovfMenu")
        .forEach(m => m.style.display = "none");
      menu.style.display = open ? "none" : "block";
      if (!open) {
        const r = btn.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + "px";
        menu.style.right = "auto";
      }
    };
    menu.addEventListener("click", ev => {
      const ci = ev.target.closest(".ci");
      menu.style.display = "none";
      if (!ci) return;
      if (ci.dataset.m) { SBMM.mode.set(ci.dataset.m); return; }
      const a = ci.dataset.a;
      if (a === "overtop") { SBMM.mode.navigate(); overtopHerman(); }
      else if (a === "overtop-click") pickPond();
      else if (a === "drainage") {
        if (!SBMM.drainage) toast("this build has no drainage map");
        else SBMM.drainage.cmd();
      }
      else if (a === "storm-toggle") {
        if (!SBMM.storm || !SBMM.storm.data()) toast("this build has no storm-drainage network");
        else SBMM.storm.toggle();
      }
      else if (a === "water-clear") {
        const had = !!ov;
        clearOvertop();
        toast(had ? "water overlays cleared" : "no water overlay to clear");
      }
    });
    document.addEventListener("click", e => {
      if (!menu.contains(e.target) && e.target !== btn) menu.style.display = "none";
    });
  }

  /* which routes the OPEN analysis owns — the v15 §1 contract, readable rather
     than inferred from feature names that other analyses also match */
  function routes() {
    if (!ov) return null;
    return { rim: !!ov.route, rimWhatIf: !!ov.rimRoute, rimSuppressed: !!ov.rimSuppressed,
             conduit: !!ov.conduitRoute, pipe: !!ov.pipeRoute,
             conduitLabel: ov.conduitLabel || null, conduitLevel: ov.conduitLevel,
             rimLevel: ov.R && ov.R.primary ? ov.R.primary.level : null };
  }

  return { surveyFacts, stageSpec, routes, traceRimWhatIf, chainSentence,
    wire, dropAt, mkFlow, buildFlow, retrace, catchment, makeProfile,
    overtop, overtopHerman, overtopAt, clearOvertop, drapeSpec, active,
    refreshLabels, fillFlowCard, endSentence, endShort, pickPond,
    COLORS: C, MIN_POND, RIM_RANGE
  };
})();
