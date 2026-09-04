/* SBMM Site Explorer — design surfaces (grading).

   A design surface is a named elevation function over a region, stored as a normal
   store feature of type "surface". Making it a feature rather than a parallel
   registry is what buys the whole phase for free: it appears in the Features tree,
   it has a colour, a folder, a visibility toggle and a Properties page, it
   serialises into the session file, it exports, and it selects like anything else.

   Three kinds, all of them the Civil-3D grading primitive in one form or another:

     pad       flat pad at elevation Z inside the footprint, side slopes at a ratio
               H:V running OUTWARD until they daylight into existing ground (or
               INWARD as a batter contained by the footprint)
     plane     the same, but the pad is a plane at a typed grade and direction
     existing  a frozen copy of the current terrain under the footprint — the
               "before" surface to compare a later design against

   The surface itself is a Float32 raster on a node grid (js/compute.js designGrid),
   computed in a worker and cached on the feature. Everything downstream — volume
   against a design base, cross-sections, the 3D drape — samples that one raster, so
   there is exactly one definition of what the design surface IS.

   The daylight line falls out of the raster rather than being searched for: outside
   it the design is clipped to existing ground, so contouring |design − ground| at a
   small tolerance encloses precisely the graded area.                              */
"use strict";

SBMM.design = (function () {

  const MAX_NODES = 260000;      // raster budget per surface; coarsen past it
  const DL_COLOR = "#4FD8E6";    // daylight line
  const CT_COLOR = "#3FA8BC";    // design contour preview

  /* ------------------------------------------------------------------ */
  /* the surface list                                                    */
  /* ------------------------------------------------------------------ */
  function list() { return SBMM.store.features.filter(f => f.type === "surface"); }
  function byId(id) { const f = SBMM.store.byId(id); return f && f.type === "surface" ? f : null; }

  /* elevation of a design surface at a point — NaN outside its raster.

     Two kinds of surface answer this. A surface the user graded carries a
     Float32 node grid on the feature (`_surf`), built by the worker. EA's own
     recovered surfaces (§5) carry no node grid at all: they ARE a raster
     already, 13 megapixels of it, and expanding that into a second copy on the
     JS heap to satisfy an interface would be pure waste. So a reference surface
     takes the raster path through SBMM.CadNative.surfaceElev, and every
     consumer downstream — the volume engine's design base, sections, the 3D
     drape, the isopach — keeps calling this one function. */
  function elev(surfId, x, y) {
    const f = typeof surfId === "object" ? surfId : byId(surfId);
    if (!f) return NaN;
    if (f.props && f.props.ref) return SBMM.refSurf.elev(f, x, y);
    if (!f._surf) return NaN;
    return SBMM_COMPUTE.dgridAt(f._surf, x, y);
  }

  /* a transferable COPY of the raster, for shipping into a worker job (the job
     transfers the buffer, and handing over the cache itself would detach it).
     `bbox` lets a reference surface ship only the window the job can reach. */
  function gridSpecFor(surfId, bbox) {
    const f = typeof surfId === "object" ? surfId : byId(surfId);
    if (!f) return null;
    if (f.props && f.props.ref) return SBMM.refSurf.gridSpec(f, bbox);
    if (!f._surf) return null;
    const s = f._surf;
    return { x0: s.x0, y0: s.y0, cell: s.cell, nx: s.nx, ny: s.ny, z: new Float32Array(s.z) };
  }

  /* ------------------------------------------------------------------ */
  /* creation                                                            */
  /* ------------------------------------------------------------------ */
  const DEFAULTS = { kind: "pad", ratio: 3, side: "out", gradePct: 0, gradeDirDeg: 0,
                     contourInterval: 1, showContours: true, drape3d: true };

  function mkSurface(pts, name, props, spec) {
    const f = SBMM.tools.newFeature("surface", pts, name || SBMM.tools.nextName("Pad"), spec);
    Object.assign(f.props, DEFAULTS, props || {});
    f.card = SBMM.results.card(f, f.name, "grading…");
    addSurfaceControls(f);
    regenerate(f);
    return f;
  }

  /* pad-elevation presets measured off the footprint rim */
  function rimStats(pts) {
    const zs = samplePerimeter(pts, 4).map(p => SBMM.elev(p[0], p[1])[0]).filter(v => !isNaN(v));
    if (!zs.length) return null;
    const sum = zs.reduce((a, b) => a + b, 0);
    return { lo: Math.min(...zs), hi: Math.max(...zs), mean: sum / zs.length, n: zs.length };
  }

  /* ------------------------------------------------------------------ */
  /* raster generation                                                   */
  /* ------------------------------------------------------------------ */
  /* How far the side slopes can reach before they daylight, so the raster is big
     enough to contain the whole graded area. The design is clipped to ground
     anyway, so an over-generous apron only costs cells — an under-generous one
     would truncate the daylight line, which is the error that actually matters. */
  function apronFor(pts, padZ, ratio, kind, gradePct) {
    const st = rimStats(pts);
    if (!st) return 200;
    const spread = Math.max(Math.abs(st.hi - padZ), Math.abs(st.lo - padZ), 5);
    /* a sloped pad reaches further on the downhill side */
    const tilt = kind === "plane" ? Math.abs(gradePct || 0) / 100 * polyPerimeter(pts) / 4 : 0;
    return clamp((spread + tilt + 10) * ratio * 1.35, 40, 2500);
  }

  function jobFor(f, over) {
    const pr = Object.assign({}, f.props, over || {});
    const pts = f.pts;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    /* finest DEM covering the whole pad footprint — see SBMM.demForBox (js/dem.js) */
    const dem = SBMM.demForBox([Math.min(...xs), Math.min(...ys),
                                Math.max(...xs), Math.max(...ys)]) || SBMM.demSite;
    const inward = pr.side === "in", existing = pr.kind === "existing";
    const ap = (inward || existing) ? dem.m.cell * 2
      : apronFor(pts, pr.padZ, pr.ratio || 3, pr.kind, pr.gradePct);

    const bx0 = Math.min(...xs) - ap, bx1 = Math.max(...xs) + ap;
    const by0 = Math.min(...ys) - ap, by1 = Math.max(...ys) + ap;
    let cell = dem.m.cell;
    while (((bx1 - bx0) / cell + 1) * ((by1 - by0) / cell + 1) > MAX_NODES) cell *= 2;
    const nx = Math.floor((bx1 - bx0) / cell) + 1, ny = Math.floor((by1 - by0) / cell) + 1;

    const poly = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { poly[i * 2] = p[0]; poly[i * 2 + 1] = p[1]; });
    const c = centroid(pts);
    const grids = SBMM.compute.gridsFor([bx0, by0, bx1, by1]);
    return {
      job: {
        poly, kind: pr.kind, padZ: pr.padZ, ratio: pr.ratio || 3, side: pr.side || "out",
        gradePct: pr.gradePct || 0, gradeDirDeg: pr.gradeDirDeg || 0,
        anchorX: c[0], anchorY: c[1],
        x0: bx0, y0: by0, cell, nx, ny, grids,
        contourInterval: pr.showContours ? (pr.contourInterval || 1) : 0
      },
      transfer: [poly.buffer, ...grids.map(g => g.z.buffer)],
      cell, dem
    };
  }

  async function regenerate(f) {
    if (!f || f.type !== "surface") return;
    const pr = f.props;
    if (pr.kind !== "existing" && (pr.padZ == null || isNaN(pr.padZ))) {
      const st = rimStats(f.pts);
      pr.padZ = st ? +st.mean.toFixed(2) : 1400;
    }
    const built = jobFor(f);
    if (f._surfHandle) f._surfHandle.cancel();
    const handle = SBMM.compute.run("design", built.job,
      { transfer: built.transfer, label: "Grading — " + (f.name || "surface") });
    f._surfHandle = handle;

    let R;
    try { R = await handle.promise; }
    catch (e) {
      if (f._surfHandle === handle) f._surfHandle = null;
      if (e && e.cancelled) return;
      console.error(e);
      if (f.card && f.card.isConnected) SBMM.results.setRows(f.card, "grading failed: " + e.message);
      return;
    }
    if (f._surfHandle !== handle) return;      // superseded
    f._surfHandle = null;
    if (!f.card || !f.card.isConnected) return;

    f._surf = { x0: R.x0, y0: R.y0, cell: R.cell, nx: R.nx, ny: R.ny, z: R.z };
    f._daylight = unpack(R.dlOffsets, R.dlCoords);
    f._contours = unpack(R.cOffsets, R.cCoords);
    f._cLevels = R.cLevels;

    const yd3 = v => v / 27;
    Object.assign(pr, {
      surface_kind: pr.kind, pad_z_ft: pr.padZ != null ? +pr.padZ.toFixed(2) : null,
      slope_HV: pr.kind === "existing" ? null : (pr.ratio || 3) + ":1",
      slope_side: pr.kind === "existing" ? null : (pr.side === "in" ? "inward batter" : "daylight outward"),
      cut_yd3: +yd3(R.cut).toFixed(1), fill_yd3: +yd3(R.fill).toFixed(1),
      net_yd3: +yd3(R.cut - R.fill).toFixed(1),
      design_zmin_ft: +R.zmin.toFixed(2), design_zmax_ft: +R.zmax.toFixed(2),
      grid: `${R.cell}-ft nodes · ${R.nx}×${R.ny}`
    });

    f._dlDropped = R.dlDropped || 0;
    const dlLen = f._daylight.reduce((s, l) => s + polyPerimeter(l), 0);
    const rows = [
      ["Cut (excavate)", sig2(yd3(R.cut)) + " yd³"],
      ["Fill (place)", sig2(yd3(R.fill)) + " yd³"],
      ["Net (cut − fill)", sig2(yd3(R.cut - R.fill)) + " yd³"],
      ["Pad elevation", pr.kind === "existing" ? "existing ground" : fmt(pr.padZ, 2) + " ft"],
      ["Side slope", pr.kind === "existing" ? "—" : `${pr.ratio || 3}:1 ${pr.side === "in" ? "inward" : "outward"}`],
      ["Design range", fmt(R.zmin, 1) + " – " + fmt(R.zmax, 1) + " ft"],
      ["Daylight line", f._daylight.length
        ? `${f._daylight.length} loop${f._daylight.length === 1 ? "" : "s"} · ${fmt0(dlLen)} ft` +
          (f._dlDropped ? ` · ${f._dlDropped} islands < 100 ft² ignored` : "")
        : "—"],
      ["Footprint", fmt(polyArea(f.pts) / 43560, 3) + " ac"],
      ["Raster", pr.grid]
    ];
    SBMM.results.setRows(f.card, rows);
    f._rows = rows;
    render(f);
    SBMM.tools.refreshBaseSelects();
    renderList();
    SBMM.props && SBMM.props.refresh(f);
    if (SBMM.viewer3d.refreshOverlays) SBMM.viewer3d.refreshOverlays();
    /* any volume already using this surface as its base is now stale */
    for (const v of SBMM.store.features)
      if (v.type === "volume" && v.props.baseMode === "design" && v.props.designId === f.id)
        SBMM.tools.compVolume(v);
    for (const s of SBMM.store.features)
      if (s.type === "sections" && s.props.designId === f.id) SBMM.sections.regenerate(s);
  }

  function unpack(offsets, coords) {
    const out = [];
    for (let i = 0; i + 1 < offsets.length; i++) {
      const a = offsets[i], b = offsets[i + 1], line = [];
      for (let k = a; k < b; k++) line.push([coords[k * 2], coords[k * 2 + 1]]);
      if (line.length > 1) out.push(line);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* map rendering                                                       */
  /* ------------------------------------------------------------------ */
  function clearLayers(f) {
    if (f._dlLayer) { SBMM.map.removeLayer(f._dlLayer); f._dlLayer = null; }
    if (f._ctLayer) { SBMM.map.removeLayer(f._ctLayer); f._ctLayer = null; }
    if (f.extraLayers) f.extraLayers = f.extraLayers.filter(l => l !== f._dlLayer && l !== f._ctLayer);
  }
  function render(f) {
    clearLayers(f);
    if (f.visible === false) return;
    const col = (f.style && f.style.color) || DL_COLOR;
    if (f._daylight && f._daylight.length) {
      const g = L.layerGroup();
      for (const line of f._daylight) {
        const ll = line.map(p => [p[1], p[0]]);
        /* a dark casing under the dashed line so it survives a busy orthophoto —
           the same trick a cartographer uses for a route line */
        L.polyline(ll, { pane: "drawings", color: "#06222C", weight: 4.5, opacity: .55, interactive: false }).addTo(g);
        L.polyline(ll, { pane: "drawings", color: col, weight: 2.4, dashArray: "8 4", opacity: 1 })
          .bindTooltip("daylight line — " + (f.name || "pad"), { sticky: true, className: "ctip" })
          .addTo(g);
      }
      g.addTo(SBMM.map);
      f._dlLayer = g;
      f.extraLayers = f.extraLayers || []; f.extraLayers.push(g);
    }
    if (f.props.showContours && f._contours && f._contours.length) {
      const g = L.layerGroup();
      f._contours.forEach((line, i) => {
        const lv = f._cLevels ? f._cLevels[i] : null;
        const heavy = lv != null && Math.abs(lv % 5) < 1e-6;
        L.polyline(line.map(p => [p[1], p[0]]),
          { pane: "drawings", color: CT_COLOR, weight: heavy ? 1.1 : .6, opacity: heavy ? .85 : .55 })
          .addTo(g);
      });
      g.addTo(SBMM.map);
      f._ctLayer = g;
      f.extraLayers = f.extraLayers || []; f.extraLayers.push(g);
    }
  }

  /* ------------------------------------------------------------------ */
  /* card controls                                                       */
  /* ------------------------------------------------------------------ */
  function addSurfaceControls(f) {
    const pr = f.props;
    const ctl = document.createElement("div"); ctl.className = "volctl surfctl";
    ctl.innerHTML = `
      <div class="crow"><span>pad elev</span>
        <input type="number" class="sz" step="0.5" style="width:78px" value="${pr.padZ != null ? pr.padZ : ""}">
        <button class="minib szlow" title="Match the lowest rim elevation">lowest</button>
        <button class="minib szmean" title="Match the mean rim elevation">mean</button></div>
      <div class="crow"><span>side slope</span>
        <input type="number" class="sr" step="0.5" min="0.5" style="width:56px" value="${pr.ratio || 3}"><span class="mut">:1 H:V</span>
        <select class="sside">
          <option value="out"${pr.side !== "in" ? " selected" : ""}>daylight out</option>
          <option value="in"${pr.side === "in" ? " selected" : ""}>inward batter</option>
        </select></div>
      <div class="crow gradrow" style="display:${pr.kind === "plane" ? "" : "none"}"><span>grade</span>
        <input type="number" class="sg" step="0.5" style="width:56px" value="${pr.gradePct || 0}"><span class="mut">% toward</span>
        <input type="number" class="sgd" step="5" style="width:56px" value="${pr.gradeDirDeg || 0}"><span class="mut">° (0 = east)</span></div>
      <div class="crow"><label class="cfl"><input type="checkbox" class="sct"${pr.showContours ? " checked" : ""}> 1-ft design contours</label>
        <label class="cfl"><input type="checkbox" class="s3d"${pr.drape3d !== false ? " checked" : ""}> drape in 3D</label></div>
      <div class="crow btns">
        <button class="minib sbal" title="Solve the pad elevation where cut = fill">balance cut/fill</button>
        <button class="minib svol" title="Volume of the terrain against this design surface">volume vs design</button>
        <button class="minib sreport">REPORT</button></div>`;
    const q = c => ctl.querySelector(c);
    const set = (k, v) => { pr[k] = v; regenerate(f); };
    q(".sz").onchange = e => set("padZ", parseFloat(e.target.value));
    q(".szlow").onclick = () => { const st = rimStats(f.pts); if (st) { q(".sz").value = st.lo.toFixed(2); set("padZ", +st.lo.toFixed(2)); } };
    q(".szmean").onclick = () => { const st = rimStats(f.pts); if (st) { q(".sz").value = st.mean.toFixed(2); set("padZ", +st.mean.toFixed(2)); } };
    q(".sr").onchange = e => set("ratio", Math.max(0.25, parseFloat(e.target.value) || 3));
    q(".sside").onchange = e => set("side", e.target.value);
    q(".sg").onchange = e => set("gradePct", parseFloat(e.target.value) || 0);
    q(".sgd").onchange = e => set("gradeDirDeg", parseFloat(e.target.value) || 0);
    q(".sct").onchange = e => { pr.showContours = e.target.checked; regenerate(f); };
    q(".s3d").onchange = e => {
      pr.drape3d = e.target.checked;
      if (SBMM.viewer3d.refreshOverlays) SBMM.viewer3d.refreshOverlays();
    };
    q(".sbal").onclick = () => balance(f);
    q(".svol").onclick = () => volumeAgainst(f);
    q(".sreport").onclick = () => SBMM.report.open(f);
    if (pr.kind === "existing") {
      ctl.querySelectorAll(".sz,.szlow,.szmean,.sr,.sside,.sbal").forEach(el => el.disabled = true);
    }
    f.card.appendChild(ctl);
    SBMM.results.appendNote(f.card,
      "Design surface: flat/sloped pad inside the footprint, side slopes daylighting into existing ground. " +
      "Quantities are neat in-place topographic volumes against the January 2024 lidar surface — no bulking, planning-level.");
  }

  /* one-click: a volume footprint over this pad, measured against this design */
  function volumeAgainst(f) {
    const v = SBMM.tools.mkVolume(f.pts.map(p => p.slice()), (f.name || "pad") + " — cut/fill");
    v.props.baseMode = "design"; v.props.designId = f.id;
    const sel = v.card.querySelector(".vbase");
    if (sel) sel.value = "design:" + f.id;
    SBMM.tools.compVolume(v);
    SBMM.store.select(v.id);
    return v;
  }

  /* ------------------------------------------------------------------ */
  /* auto-balance                                                        */
  /* ------------------------------------------------------------------ */
  /* Solve the pad elevation where cut = fill (or where net = a requested borrow /
     surplus). net(Z) rises monotonically with Z, so the solver bisects on Z.

     The bisection runs INSIDE one worker job rather than as a job per iteration:
     every iteration shares the same expensive per-node preparation (ground,
     distance to the footprint, nearest-edge ground), and re-shipping the DEM window
     thirty times would cost far more than the arithmetic it saved. The job reports
     progress per iteration, and a final full-resolution regenerate confirms the
     answer on the fine grid the surface actually uses. */
  async function balance(f, targetYd3) {
    if (f.type !== "surface") { toast("balance applies to a design surface"); return; }
    if (f.props.kind === "existing") { toast("an existing-ground copy has nothing to balance"); return; }
    const btn = f.card && f.card.querySelector(".sbal");
    if (btn) { btn.disabled = true; btn.textContent = "solving…"; }

    const st = rimStats(f.pts);
    if (!st) { toast("no terrain under this footprint"); if (btn) { btn.disabled = false; btn.textContent = "balance cut/fill"; } return; }
    const target = (targetYd3 || 0) * 27;         // yd³ -> ft³, net = cut − fill

    /* balance on a coarsened raster: the solved elevation is what matters here, and
       a coarse grid gets it to a few hundredths of a foot in a fraction of the time */
    const built = jobFor(f, { showContours: false });
    const j = built.job;
    let coarse = 1;
    while ((j.nx / coarse) * (j.ny / coarse) > 90000) coarse *= 2;
    if (coarse > 1) {
      const nx = Math.max(4, Math.floor(j.nx / coarse)), ny = Math.max(4, Math.floor(j.ny / coarse));
      j.cell *= coarse; j.nx = nx; j.ny = ny;
    }
    /* the kernel solves net(Z) = fill − cut; our target is expressed as cut − fill */
    j.targetNet_ft3 = -target;
    j.zLo = st.lo - Math.abs(st.hi - st.lo) - 60;
    j.zHi = st.hi + Math.abs(st.hi - st.lo) + 60;
    j.iters = 40;

    const h = SBMM.compute.run("balance", j,
      { transfer: built.transfer, label: "Balance — " + (f.name || "pad") });
    let R;
    try { R = await h.promise; }
    catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "balance cut/fill"; }
      if (!(e && e.cancelled)) toast("balance failed: " + e.message);
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = "balance cut/fill"; }
    if (!R.ok) {
      toast("balance: " + R.reason, 5000);
      return;
    }
    /* adopt the solved elevation and re-run the surface at full resolution */
    f.props.padZ = +R.z.toFixed(2);
    const zin = f.card && f.card.querySelector(".sz"); if (zin) zin.value = f.props.padZ;
    await regenerate(f);

    const yd3 = v => v / 27;
    const cut = f.props.cut_yd3, fill = f.props.fill_yd3, net = f.props.net_yd3;
    const pct = Math.abs(net) / Math.max(1e-9, (cut + fill) / 2) * 100;
    f.props.balance_z_ft = f.props.padZ;
    f.props.balance_iters = R.iters;
    let box = f.card.querySelector(".sbalbox");
    if (!box) { box = document.createElement("div"); box.className = "vrangebox sbalbox"; f.card.appendChild(box); }
    box.innerHTML =
      `<div class="rhead">Balanced pad elevation</div>
       <div class="rtrip"><span><b>${fmt(f.props.padZ, 2)}</b><i>ft</i></span>
         <span class="mid"><b>${sig2(cut)}</b><i>cut yd³</i></span>
         <span><b>${sig2(fill)}</b><i>fill yd³</i></span></div>
       <div class="note">${targetYd3
         ? `Solved for a net of ${sig2(targetYd3)} yd³ (${targetYd3 > 0 ? "surplus to haul off" : "borrow to import"}); residual ${sig2(net)} yd³.`
         : `Net ${sig2(net)} yd³ — <b>haul ≈ 0</b>, cut and fill agree to ${fmt(pct, 1)}%.`}
         Bisection on pad elevation, ${R.iters} iterations on a ${fmt0(j.cell)}-ft raster, confirmed on the ${fmt0(f._surf.cell)}-ft design grid.</div>`;
    SBMM.props && SBMM.props.refresh(f);
    toast(`balanced at ${fmt(f.props.padZ, 2)} ft — cut ${sig2(cut)} / fill ${sig2(fill)} yd³`);
    return { z: f.props.padZ, cut, fill, net };
  }

  /* ------------------------------------------------------------------ */
  /* commands                                                            */
  /* ------------------------------------------------------------------ */
  /* PAD / GRADE: use the selected polygon if there is one, else sketch a footprint */
  function cmdPad(kind, arg) {
    const f = SBMM.store.selectedFeature();
    const usable = f && f.pts && f.pts.length > 2 &&
      (f.type === "area" || f.type === "volume" || f.type === "surface");
    if (usable) { fromPolygon(f.pts.map(p => p.slice()), kind, arg, f.name); return; }
    toast("sketch the pad footprint — double-click to close it");
    SBMM.tools.setTool(null);
    SBMM.draw.beginPick({
      count: 0, minPts: 3,
      closed: true,
      prompts: [(kind === "plane" ? "GRADE" : "PAD") + " — click the footprint, double-click to finish"],
      onMove: (pts, cur) => pts.length
        ? { rings: [{ pts: [...pts, cur], closed: true, style: { color: DL_COLOR } }], label: "pad footprint" }
        : null,
      onDone: pts => { if (pts.length > 2) fromPolygon(pts, kind, arg); else toast("a pad needs at least 3 points"); }
    });
  }

  function fromPolygon(pts, kind, arg, srcName) {
    const st = rimStats(pts);
    if (!st) { toast("no terrain under that footprint"); return; }
    const mk = z => {
      const props = { kind, padZ: z };
      if (kind === "plane") props.gradePct = 2;
      const f = mkSurface(pts, srcName ? srcName + " — pad" : null, props);
      /* redo puts the same surface back with the raster it already generated;
         it regenerates only if that raster was thrown away meanwhile */
      SBMM.undo.push("design surface",
        () => SBMM.store.remove(f),
        () => { SBMM.store.readd(f); if (!f._surf) regenerate(f); });
      SBMM.store.select(f.id);
      SBMM.tools.zoomTo(f);
      return f;
    };
    const preset = parseFloat(arg);
    if (!isNaN(preset)) { mk(preset); return; }
    SBMM.cmd.ask(`Pad elevation in ft (rim ${fmt(st.lo, 1)}–${fmt(st.hi, 1)}, mean ${fmt(st.mean, 1)}) — or "low" / "mean":`, v => {
      const s = String(v || "").trim().toLowerCase();
      let z = parseFloat(s);
      if (s === "low" || s === "lowest") z = st.lo;
      else if (s === "mean" || s === "avg") z = st.mean;
      else if (s === "high") z = st.hi;
      if (isNaN(z)) { toast("PAD cancelled"); return; }
      mk(+z.toFixed(2));
    });
  }

  /* existing-ground copy under a polygon */
  function cmdExisting() {
    const f = SBMM.store.selectedFeature();
    const go = pts => {
      const s = mkSurface(pts, "Existing ground copy", { kind: "existing" });
      SBMM.undo.push("existing-ground surface",
        () => SBMM.store.remove(s),
        () => { SBMM.store.readd(s); if (!s._surf) regenerate(s); });
      SBMM.store.select(s.id);
    };
    if (f && f.pts && f.pts.length > 2) { go(f.pts.map(p => p.slice())); return; }
    SBMM.draw.beginPick({
      count: 0, minPts: 3, closed: true,
      prompts: ["EXISTING — click the region, double-click to finish"],
      onMove: (pts, cur) => pts.length ? { rings: [{ pts: [...pts, cur], closed: true }], label: "existing ground copy" } : null,
      onDone: pts => { if (pts.length > 2) go(pts); }
    });
  }

  function cmdBalance(arg) {
    let f = SBMM.store.selectedFeature();
    if (!f || f.type !== "surface") f = list()[list().length - 1];
    if (!f) { toast("no design surface to balance — run PAD first"); return; }
    const t = parseFloat(arg);
    balance(f, isNaN(t) ? 0 : t);
  }

  function cmdList() {
    const ls = list();
    if (!ls.length) { toast("no design surfaces yet — PAD creates one"); return; }
    toast(ls.map(f => `${f.name}: ${f.props.kind === "existing" ? "existing ground" :
      fmt(f.props.padZ, 1) + " ft @ " + (f.props.ratio || 3) + ":1"}`).join(" · "), 7000);
    SBMM.shell.setTab("layers");
  }

  /* ------------------------------------------------------------------ */
  /* the Surfaces list in the Layers tab                                 */
  /* ------------------------------------------------------------------ */
  function renderList() {
    const host = $("surfList");
    if (!host) return;
    /* EA's reference surfaces (§5) are surfaces too — they are in list(), so
       they show up as a volume base like any other — but they are read-only
       project data and have their own list (js/refsurf.js). This one is the
       surfaces the user graded. */
    const ls = list().filter(f => !(f.props && f.props.ref));
    if (!ls.length) {
      host.innerHTML = `<div class="surfnone mut">No design surfaces.
        <button class="minib" id="surfNew">＋ graded pad</button></div>`;
      $("surfNew").onclick = () => cmdPad("pad");
      return;
    }
    host.innerHTML = ls.map(f => {
      const p = f.props;
      const sub = p.kind === "existing" ? "existing ground copy"
        : `${fmt(p.padZ, 1)} ft · ${p.ratio || 3}:1 ${p.side === "in" ? "in" : "out"}${p.kind === "plane" ? ` · ${fmt(p.gradePct, 1)}%` : ""}`;
      return `<div class="surfrow${SBMM.store.selected === f.id ? " sel" : ""}" data-fid="${f.id}">
        <span class="sw" style="background:${(f.style && f.style.color) || DL_COLOR}"></span>
        <span class="sinfo"><b>${esc(f.name)}</b><i>${esc(sub)}</i></span>
        <span class="sacts">
          <button class="ftb seye" title="Show / hide">${f.visible === false ? "◌" : "●"}</button>
          <button class="ftb sbal2" title="Balance cut/fill">⇄</button>
          <button class="ftb sdel" title="Delete">✕</button></span></div>`;
    }).join("") + `<div class="surfnone"><button class="minib" id="surfNew">＋ graded pad</button>
      <button class="minib" id="surfNewG">sloped</button>
      <button class="minib" id="surfNewE">existing copy</button></div>`;
    host.querySelectorAll(".surfrow").forEach(row => {
      const f = SBMM.store.byId(row.dataset.fid);
      row.onclick = e => { if (!e.target.closest(".ftb")) SBMM.store.select(f.id); };
      row.querySelector(".seye").onclick = e => { e.stopPropagation(); SBMM.store.setVisible(f, f.visible === false); render(f); };
      row.querySelector(".sbal2").onclick = e => { e.stopPropagation(); balance(f); };
      row.querySelector(".sdel").onclick = e => { e.stopPropagation(); SBMM.tools.deleteFeature(f); };
    });
    $("surfNew").onclick = () => cmdPad("pad");
    $("surfNewG").onclick = () => cmdPad("plane");
    $("surfNewE").onclick = () => cmdExisting();
  }

  function wire() {
    SBMM.store.onChange(() => renderList());
    SBMM.store.onSelect(() => renderList());
    renderList();
  }

  return {
    wire, list, byId, elev, gridSpecFor, mkSurface, regenerate, render, renderList,
    balance, rimStats, volumeAgainst,
    cmdPad, cmdExisting, cmdBalance, cmdList,
    DL_COLOR
  };
})();
