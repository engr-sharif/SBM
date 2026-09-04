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
    sel: "#FFD34D"
  };
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
    f._pondLabels = [];
    const p = f.props || {};
    if (!f.pts || f.pts.length < 2) return;
    const sel = SBMM.store.selected === f.id;
    const col = (f.style && f.style.color) || C.line;
    const ll = f.pts.map(q => [q[1], q[0]]);

    /* (a) the soft glow — non-interactive, purely so the line reads over the ortho */
    L.polyline(ll, { pane: "drawings", color: C.glow, weight: 9, opacity: 1,
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
          pane: "drawings", interactive: false, opacity: 0,
          icon: L.divIcon({ className: "pondlbl", iconSize: [0, 0],
                            html: `<span>${esc(pondShort(pd))}</span>` })
        }).addTo(g);
        f._pondLabels.push({ mk, wft: ringWidth(ring) });
      }
    }

    /* (b) the core line — this is what a click selects */
    L.polyline(ll, { pane: "drawings", color: sel ? C.sel : col,
                     weight: sel ? 4.75 : 2.75, lineCap: "round", lineJoin: "round" }).addTo(g);

    /* the flow animation: a second, non-interactive copy in the SVG `water`
       pane. Zero JS per frame — CSS walks the dash offset, and
       prefers-reduced-motion turns the movement off in the stylesheet. */
    L.polyline(ll, { renderer: waterRenderer(), pane: "water", interactive: false,
                     color: C.anim, weight: 1.6, dashArray: "5 11", opacity: .95,
                     className: "flowanim" }).addTo(g);

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
      L.marker([e.y, e.x], {
        pane: "drawings", interactive: false,
        icon: L.divIcon({ className: "flowend", iconSize: [0, 0],
          html: `<span class="dot"></span><span class="lbl mono">${esc(endText(p))}</span>` })
      }).addTo(g);
    }
    refreshLabels();
  }

  /* zoom gate for the pond labels — one pass, no rebuild */
  function refreshLabels() {
    if (!SBMM.map) return;
    const k = Math.pow(2, SBMM.map.getZoom());       // screen px per ground ft
    for (const f of SBMM.store.features) {
      if (f.type !== "flow" || !f._pondLabels) continue;
      for (const l of f._pondLabels) {
        try { l.mk.setOpacity(l.wft * k >= 36 ? 1 : 0); } catch (err) {}
      }
    }
  }

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
    let reason = "steps", end = null, steps = 0, zLast = NaN;

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
      let R;
      try {
        R = await SBMM.compute.run("flowpath",
          { grid, x: cx, y: cy, minPondDepth, blockRing: opts.blockRing || null,
            plateauTol: opts.plateauTol == null ? PLATEAU_TOL : opts.plateauTol },
          { transfer: [grid.z.buffer], label }).promise;
      } catch (e) {
        if (e && e.cancelled) return null;
        toast("raindrop failed: " + e.message);
        return null;
      }
      const n = R.n | 0;
      const skip = pts.length ? 1 : 0;          // the first vertex repeats the exit
      for (let i = skip; i < n; i++) {
        pts.push([R.pts[i * 3], R.pts[i * 3 + 1]]);
        zraw.push(R.pts[i * 3 + 2]);
      }
      for (const pd of (R.ponds || [])) ponds.push(pd);
      steps += R.steps || 0;
      reason = R.reason; end = R.end;
      /* the kernel's own last SURVEYED z: end[2] is NaN when the run stops on a
         NoData cell, and "fall = NaN" is a worse answer than "fall to the last
         ground we had" */
      if (R.zEnd_ft != null && !isNaN(R.zEnd_ft)) zLast = R.zEnd_ft;
      if (R.reason !== "window") break;
      if (hops >= MAX_HOPS - 1 || lineLength(pts) >= MAX_LEN) { reason = "steps"; break; }
      const ex = R.exit;
      if (!ex) break;
      const nd = SBMM.demAt(ex[0], ex[1]);
      if (!nd) { reason = "nodata"; break; }      // ran off the surveyed ground
      dem = nd; cx = ex[0]; cy = ex[1]; hops++;
    }

    if (pts.length < 2) {
      toast("nowhere to run from there — the drop is already at a low point of a flat");
      return null;
    }
    const length = lineLength(pts);
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
        cells: pd.cells, rings: (pd.rings || []).map(r => r.map(q => [+q[0].toFixed(2), +q[1].toFixed(2)]))
      })),
      zs: decimate(zraw, 600).map(v => isNaN(v) ? null : +v.toFixed(2)),
      dem: grids[0] || gridLabel(dem),
      grids, minPondDepth, hops, steps, searched_ft: half * 2
    };
    if (opts.blockRing) props.blocked = true;
    return { pts, props };
  }

  /* the public entry point: one click, one feature, one card */
  async function dropAt(x, y, opts) {
    opts = opts || {};
    const R = await traceRun(x, y, opts);
    if (!R) return null;
    const f = mkFlow(R.pts, opts.name || SBMM.tools.nextName("Raindrop"), R.props,
                     { group: opts.group || "Water" });
    SBMM.undo.push("raindrop " + f.name, () => SBMM.store.remove(f));
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
    SBMM.undo.push("retrace " + (f.name || "raindrop"), () => {
      f.pts = prevPts; f.props = prevProps;
      buildFlow(f); fillFlowCard(f);
      SBMM.store.emit(); SBMM.store.autosave();
    });
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
    SBMM.undo.push("contributing area", () => SBMM.store.remove(a));
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
    ]));
    if ((p.ponds || []).length > 6) rows.push(["", `+${p.ponds.length - 6} more`]);
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

  function makeProfile(f) {
    const g = SBMM.tools.rebuildFeature({
      type: "profile", pts: f.pts.map(q => q.slice()),
      name: (f.name || "Raindrop") + " — profile", group: f.group || "Water"
    });
    if (g) { SBMM.undo.push("flow profile", () => SBMM.store.remove(g)); SBMM.store.select(g.id); }
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

  function overtopHerman() {
    const h = hermanRing();
    if (!h) { toast("the Herman Impoundment polygon is not in this build's design payload"); return Promise.resolve(null); }
    return overtop({ ring: h.ring, name: h.name });
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
    let R = null, dem = null, bbox = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const b = ring ? bboxOf(ring) : [point[0], point[1], point[0], point[1]];
      bbox = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
      dem = SBMM.demForBox(bbox) || SBMM.demSite;
      const grid = SBMM.compute.gridSpec(dem, bbox, 0);
      if (!grid) { toast("that water body is outside the surveyed terrain"); return null; }
      const job = { grid, plateauTol: PLATEAU_TOL, rimRange: RIM_RANGE,
                    levelStep: LEVEL_STEP, maxClusters: 12 };
      if (ring) job.seedRing = ring.map(q => [q[0], q[1]]); else job.seedPoint = [point[0], point[1]];
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

    ov = { name, R, dem, markers: [], level: R.primary.level };

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
    const nx = R.primary.next;
    if (nx) {
      const route = await dropAt(nx[0], nx[1], {
        name: `${name} overflow route`, group: "Water", quiet: true,
        dem, window: bbox, plateauTol: PLATEAU_TOL,
        blockRing: ring || (s0 && s0.rings && s0.rings.length ? s0.rings[0] : null)
      });
      if (route) { ov.route = route; route.props.blockRing = null; }
    }

    overtopCard();
    applyLevel(ov.defaultLevel != null ? ov.defaultLevel : R.primary.level);
    if (SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
    SBMM.shell.showResults();
    return R;
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
    const changed = ov.spilling !== spilling;
    ov.spilling = spilling;
    if (ov.route && changed) SBMM.store.setVisible(ov.route, spilling);
    const el = ov.card && ov.card.querySelector(".wslabel");
    if (el) {
      const store = s ? s.storage_ft3 : 0;
      el.textContent = `water level ${fmt(level, 2)} ft · +${fmt(level - R.z0, 2)} ft above today · `
        + `${fmt(acft(store), 1)} ac-ft to store · `
        + (spilling ? "OVERFLOWS at ①" : "no overflow")
        + (level > R.primary.level + 1e-6 ? " (if the rim at ① were raised)" : "");
    }
    /* only when the answer changed — a slider drag fires this per pixel, and
       rebuilding every draped ring per pixel is how a smooth control becomes a
       slideshow */
    if (changed && SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
  }

  function overtopCard() {
    const R = ov.R;
    const grid = gridLabel(ov.dem) + " lidar grid";
    const rt = ov.route ? ov.route.props : null;
    const rows = [
      ["Water surface (lidar, Jan 2024)", fmt(R.z0, 2) + " ft"],
      ["Spill elevation", fmt(R.primary.level, 2) + " ft"],
      ["Freeboard", fmt(R.freeboard_ft, 2) + " ft"],
      ["Spills at", `${fmt0(R.primary.x)} E, ${fmt0(R.primary.y)} N`],
      ["Storage to spill", fmt(acft(R.storage_ft3), 1) + " ac-ft"],
      ["", fmt0(R.storage_ft3) + " ft³"],
      ["Area at spill", fmt(acft(R.area_ft2), 2) + " ac"],
      ["Overflow route", rt ? `${fmt0(rt.length_ft)} ft · ${endShort(rt)}` : "—"],
      ["Grid", grid + " · " + fmt0(R.seedCells) + " cells of water surface"]
    ];
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
    const lo = R.z0, hi = R.primary.level + RIM_RANGE;
    /* the slider's steps run from z0, and the spill almost never lands exactly on
       one — so the default is the first step AT OR ABOVE the spill. Snapping the
       other way would open the card saying "no overflow" about an analysis whose
       whole subject is the overflow. */
    const dflt = lo + Math.ceil((R.primary.level - lo) / LEVEL_STEP) * LEVEL_STEP;
    sl.innerHTML = `<div class="wslabel mono"></div>
      <input type="range" id="wsRange" min="${lo}" max="${Math.max(hi, dflt)}" step="${LEVEL_STEP}" value="${dflt}">`;
    el.appendChild(sl);
    sl.querySelector("#wsRange").addEventListener("input", ev => applyLevel(+ev.target.value));
    ov.defaultLevel = dflt;

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
      + `<button class="minib" data-w="3d">3D</button>`
      + `<button class="minib" data-w="clear">clear</button>`;
    btns.addEventListener("click", ev => {
      const w = ev.target.dataset && ev.target.dataset.w;
      if (!w) return;
      if (w === "hide") toggleOverlay(ev.target);
      if (w === "3d") SBMM.viewer3d.openAt(R.primary.x, R.primary.y);
      if (w === "clear") { clearOvertop(); toast("water overlays cleared"); }
    });
    el.appendChild(btns);

    SBMM.results.appendNote(el,
      "Static spill analysis on the " + grid + " lidar bare earth: the water surface is the "
      + "lidar's flat return over the pond (" + fmt(R.z0, 1) + " ft), the spill is the lowest rim "
      + "cell from which water drains away (pit-filled DEM), storage is geometric. Above the spill "
      + "the table describes a sealed flood — what would happen if the low rim at ① were raised. "
      + "No inflow, wave run-up, seepage or erosion — planning-level.");
  }

  function toggleOverlay(btn) {
    if (!ov) return;
    const on = !ov.hidden;
    ov.hidden = on;
    for (const l of [ov.band, ov.z0line, ov.water]) if (l) { if (on) SBMM.map.removeLayer(l); else l.addTo(SBMM.map); }
    for (const m of ov.markers) { if (on) SBMM.map.removeLayer(m); else m.addTo(SBMM.map); }
    if (btn) btn.textContent = on ? "show overlay" : "hide overlay";
    if (SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
  }

  /* storage (ac-ft, right axis) and area (ac, left axis) against level, with the
     spill marked — the two curves a dam engineer reads first */
  function svgStage(R) {
    const S = R.stage || [];
    if (S.length < 2) return "";
    const W = 300, H = 110, L = 30, Rr = 32, T = 8, B = 18;
    const pw = W - L - Rr, ph = H - T - B;
    const l0 = S[0].level, l1 = S[S.length - 1].level;
    let aMax = 0, sMax = 0;
    for (const s of S) { aMax = Math.max(aMax, acft(s.area_ft2)); sMax = Math.max(sMax, acft(s.storage_ft3)); }
    aMax = aMax || 1; sMax = sMax || 1;
    const X = l => L + pw * (l - l0) / ((l1 - l0) || 1);
    const Ya = a => T + ph * (1 - a / aMax);
    const Ys = s => T + ph * (1 - s / sMax);
    let ps = "", pa = "";
    S.forEach(s => {
      ps += (ps ? " L" : "M") + ` ${X(s.level).toFixed(1)} ${Ys(acft(s.storage_ft3)).toFixed(1)}`;
      pa += (pa ? " L" : "M") + ` ${X(s.level).toFixed(1)} ${Ya(acft(s.area_ft2)).toFixed(1)}`;
    });
    const xs = X(R.primary.level);
    return `<svg viewBox="0 0 ${W} ${H}" class="axis stagechart">
      <line class="gridl" x1="${L}" x2="${W - Rr}" y1="${T}" y2="${T}"/>
      <line class="gridl" x1="${L}" x2="${W - Rr}" y1="${T + ph}" y2="${T + ph}"/>
      <path d="${pa}" fill="none" stroke="${C.drop}" stroke-width="1.3" stroke-dasharray="4 3"/>
      <path d="${ps}" fill="none" stroke="${C.line}" stroke-width="1.6"/>
      <line x1="${xs.toFixed(1)}" x2="${xs.toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="${C.spill}" stroke-width="1"/>
      <text x="${(xs + 3).toFixed(1)}" y="${T + 9}" fill="${C.spill}">spill</text>
      <text x="${L - 3}" y="${T + 8}" text-anchor="end">${fmt(aMax, 0)}</text>
      <text x="${L - 3}" y="${T + ph}" text-anchor="end">ac</text>
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
    if (ov.card) ov.card.remove();
    ov = null;
    SBMM.results.checkEmpty();
    if (SBMM.viewer3d.isOpen() && SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
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

  return {
    wire, dropAt, mkFlow, buildFlow, retrace, catchment, makeProfile,
    overtop, overtopHerman, overtopAt, clearOvertop, drapeSpec, active,
    refreshLabels, fillFlowCard, endSentence, endShort, pickPond,
    COLORS: C, MIN_POND, RIM_RANGE
  };
})();
