/* SBMM Site Explorer — measurement tools: spot, distance, area, volume, profile.
   Volume reproduces the ABP memo's Attachment E method (perimeter TIN base); the
   integration itself runs in a Web Worker (js/compute.js + js/jobs.js) with the same
   kernel used by the synchronous fallback, so numbers are unchanged. */
"use strict";

SBMM.tools = (function () {
  let tool = null;

  /* ================== tool switching ================== */
  /* What the map says the moment a tool is armed, before the first click. */
  const START_TIP = {
    inspect: "Inspect — click anywhere for a point card. Esc returns to Navigate.",
    point: "Point — click where the point goes. Esc returns to Navigate.",
    distance: "Distance — click each point; double-click or Enter finishes. Esc cancels.",
    area: "Area — click the boundary; double-click or Enter closes it. Esc cancels.",
    volume: "Volume — click a footprint around the pile or excavation; double-click closes it.",
    profile: "Profile — click the start and the end of the line; Enter finishes."
  };
  /* Tools that put a card up rather than opening a sketch. */
  const CLICK_TOOLS = new Set(["inspect", "point"]);
  function setTool(t) {
    tool = (tool === t) ? null : t;
    /* The button highlight belongs to SBMM.mode (§2) — it is the one thing that
       knows which of several modes an armed tool is serving. */
    $("map").classList.toggle("tool-none", !tool);
    SBMM.draw.cancel();
    if (tool && !CLICK_TOOLS.has(tool)) {
      SBMM.draw.begin(sketchOpts(tool));
    } else if (tool) {
      $("sketchTip").textContent = START_TIP[tool];
      $("sketchTip").style.display = "block";
    }
    if (SBMM.mode) SBMM.mode.syncFromTool(tool);
    else document.querySelectorAll(".toolbtn[data-tool]").forEach(b =>
      b.classList.toggle("active", b.dataset.tool === tool));
  }
  function sketchOpts(t) {
    const closed = t === "area" || t === "volume";
    return {
      closed, minPts: closed ? 3 : 2, startTip: START_TIP[t],
      onFinish(pts) {
        if (t === "distance") mkDistance(pts);
        else if (t === "area") mkArea(pts);
        else if (t === "volume") mkVolume(pts);
        else if (t === "profile") mkProfile(pts);
        SBMM.draw.begin(sketchOpts(t));   // ready for the next one
      }
    };
  }
  function active() { return tool; }
  /* Restart the current tool's sketch without toggling the tool off. */
  function rearm() { if (tool && !CLICK_TOOLS.has(tool)) SBMM.draw.begin(sketchOpts(tool)); }
  function mapClick(x, y) {
    if (!tool) return;
    /* §2: Inspect answers with a point card (E, N, Z, lat/long, slope, aspect,
       copy, "drop marker"); the mode that CREATES a point feature is
       draw.point. Before v9 these were the same click, which meant you could
       not read a coordinate without leaving a marker behind. */
    if (tool === "inspect") { inspectAt(x, y); return; }
    if (tool === "point") { const f = dropSpot(x, y); SBMM.store.select(f.id); return; }
    /* Belt and braces: a lit tool button must always accept a click. If anything
       tore the sketch down while the tool stayed selected, start a fresh one
       rather than swallowing the click. */
    if (!SBMM.draw.isDrawing()) SBMM.draw.begin(sketchOpts(tool));
    SBMM.draw.click(x, y);
  }

  /* ================== feature construction ================== */
  const styles = {
    spot:    { color: "#FFD34D", weight: 2 },
    line:    { pane: "drawings", color: "#4FB3CE", weight: 2.5 },
    area:    { pane: "drawings", color: "#4FB3CE", weight: 2, fillOpacity: .10 },
    volume:  { pane: "drawings", color: "#4FCE9B", weight: 2.5, fillOpacity: .12 },
    profile: { pane: "drawings", color: "#C792EA", weight: 2.5 },
    dim:     { pane: "drawings", color: "#E8B34B", weight: 1.4 },
    text:    { pane: "drawings", color: "#E8EEF1", weight: 1.4 },
    /* phase 3 — earthworks */
    surface: { pane: "drawings", color: "#4FD8E6", weight: 2, fillOpacity: .07 },
    sections:{ pane: "drawings", color: "#F0A6D0", weight: 2.5 }
  };
  const SEL_COLOR = "#FFD34D";
  function baseStyle(t) { return styles[t] || styles.area; }
  function defaultColor(t) { return baseStyle(t).color; }

  /* effective style = per-feature override over the type default, plus selection halo */
  function applyStyle(f) {
    if (!f || !f.layer) return;
    if (f.type === "dim" || f.type === "text") { buildAnno(f); return; }
    if (!f.layer.setStyle) return;
    const base = baseStyle(f.type);
    const sel = SBMM.store.selected === f.id;
    const color = (f.style && f.style.color) || base.color;
    const weight = (f.style && f.style.weight != null) ? f.style.weight : base.weight;
    if (f.type === "spot") {
      f.layer.setStyle({ color: sel ? SEL_COLOR : color, weight: sel ? 3.5 : weight });
      if (f.layer.setRadius) f.layer.setRadius(sel ? 7.5 : 5);
      return;
    }
    const s = { color: sel ? SEL_COLOR : color, weight: sel ? weight + 2 : weight, dashArray: sel ? "9 5" : null };
    if (base.fillOpacity != null) { s.fillColor = color; s.fillOpacity = base.fillOpacity; }
    f.layer.setStyle(s);
  }

  function layerFor(f) {
    const ll = f.pts.map(p => [p[1], p[0]]);
    if (f.type === "dim" || f.type === "text") return L.featureGroup([]);
    if (f.type === "spot") {
      return L.circleMarker(ll[0], { pane: "drawings", radius: 5, color: "#FFD34D", weight: 2, fillColor: "#12181C", fillOpacity: 1 });
    }
    if (f.type === "line" || f.type === "profile") return L.polyline(ll, styles[f.type === "line" ? "line" : "profile"]);
    if (f.type === "sections") return L.polyline(ll, styles.sections);
    if (f.type === "surface") return L.polygon(ll, styles.surface);
    return L.polygon(ll, styles[f.type === "volume" ? "volume" : "area"]);
  }
  const OPEN_TYPES = new Set(["line", "profile", "sections"]);
  function redraw(f) {
    if (f.type === "dim" || f.type === "text") { buildAnno(f); return; }
    const ll = f.pts.map(p => [p[1], p[0]]);
    if (f.type === "spot") f.layer.setLatLng(ll[0]);
    else f.layer.setLatLngs(OPEN_TYPES.has(f.type) ? ll : [ll]);
  }
  function newFeature(type, pts, name, spec) {
    const f = { type, pts, name, props: {}, group: (spec && spec.group) || "", style: (spec && spec.style) || null };
    if (spec && spec.locked) f.locked = true;
    f.layer = layerFor(f).addTo(SBMM.map);
    /* clicking a drawing selects it — but only when no tool is armed, so that
       drawing over an existing feature still passes the click to the map */
    f.layer.on("click", ev => {
      /* pass the click through whenever something is collecting points — a tool
         sketch or a modify command must be able to click over its own drawings */
      if (tool || SBMM.draw.isPicking()) return;
      L.DomEvent.stopPropagation(ev);
      SBMM.store.select(f.id);
    });
    SBMM.store.add(f);
    if (spec && spec.visible === false) SBMM.store.setVisible(f, false);
    applyStyle(f);
    return f;
  }
  function zoomTo(f) {
    if (f.type === "spot" || f.pts.length === 1) SBMM.map.setView([f.pts[0][1], f.pts[0][0]], Math.max(SBMM.map.getZoom(), 1));
    else {
      const ll = f.pts.map(p => [p[1], p[0]]);
      SBMM.map.fitBounds(L.latLngBounds(ll).pad(0.4));
    }
  }
  function editFeature(f) {
    if (f.locked) { toast("feature is locked — unlock it in the Features tab"); return; }
    if (f.type === "spot") { toast("spot elevations can't be edited — delete and re-drop"); return; }
    setTool(null);
    SBMM.store.select(f.id);
    SBMM.draw.edit(f,
      (feat, live) => { redraw(feat); recompute(feat, live); },
      feat => recompute(feat, false));
  }

  /* recompute — `live` means "we are mid-drag": cheap metrics update instantly,
     expensive ones (volume integration, profile chart) debounce and cancel the
     superseded worker job. */
  const LIVE_MS = 130;
  function recompute(f, live) {
    if (f.type === "dim") compDim(f);
    else if (f.type === "text") compText(f);
    else if (f.type === "line") compDistance(f);
    else if (f.type === "area") compArea(f);
    else if (f.type === "volume" || f.type === "profile" || f.type === "surface" || f.type === "sections") {
      if (live) { scheduleLive(f); return; }
      if (f._liveT) { clearTimeout(f._liveT); f._liveT = null; }
      if (f.type === "volume") compVolume(f);
      else if (f.type === "profile") compProfile(f);
      else if (f.type === "surface") SBMM.design.regenerate(f);
      else SBMM.sections.regenerate(f);
    }
    SBMM.store.autosave();
  }
  function scheduleLive(f) {
    if (f._liveT) clearTimeout(f._liveT);
    /* whatever is running is already stale */
    for (const h of ["_volHandle", "_surfHandle", "_secHandle"]) if (f[h]) f[h].cancel();
    f._liveT = setTimeout(() => { f._liveT = null; recompute(f, false); }, LIVE_MS);
  }

  /* ================== inspect ==================
     The point card of §2, in a Leaflet popup at the clicked point. The markup
     is js/popups.forTerrain — the same string the 3D identify card shows for
     the same ground, which is the only way "the same card" can be a fact
     rather than a claim. */
  let inspectPop = null;
  function inspectAt(x, y) {
    const [z] = SBMM.elev(x, y);
    if (inspectPop) SBMM.map.closePopup(inspectPop);
    inspectPop = L.popup({ className: "inspectpop", maxWidth: 300, autoPan: false })
      .setLatLng([y, x])
      .setContent(SBMM.popups.forTerrain(x, y, z))
      .openOn(SBMM.map);
  }

  /* ================== spot ================== */
  function dropSpot(x, y) {
    const [z, src] = SBMM.elev(x, y);
    const f = newFeature("spot", [[x, y]], nextName("Spot"));
    f.props = { z: isNaN(z) ? null : +z.toFixed(2), src };
    f.layer.bindTooltip(`${fmt(z, 1)} ft`, { permanent: true, direction: "top", className: "ctip", offset: [0, -6] });
    const [lo, la] = SBMM.toLL(x, y);
    const rows = [
      ["Elevation", fmt(z, 1) + " ft"],
      ["SP E / N", fmt0(x) + " / " + fmt0(y)],
      ["Lat / long", la.toFixed(6) + ", " + lo.toFixed(6)],
      ["Source", src || "—"]];
    const ch = SBMM.chm ? SBMM.canopy(x, y) : NaN;
    if (ch > 0.5) { rows.push(["Canopy above ground", fmt(ch, 1) + " ft"]); f.props.canopy = +ch.toFixed(2); }
    f.card = SBMM.results.card(f, f.name, rows);
    return f;
  }

  /* ================== distance ================== */
  function mkDistance(pts) { const f = newFeature("line", pts, nextName("Line")); f.card = SBMM.results.card(f, f.name, []); compDistance(f); return f; }
  function compDistance(f) {
    const pts = f.pts;
    const len = lineLength(pts);
    let climb = 0, drop = 0;
    let prevZ = SBMM.elev(pts[0][0], pts[0][1])[0];
    const step = Math.max(2, len / 400);
    for (let s = step; s <= len; s += step) {
      const p = pointAlong(pts, s);
      const z = SBMM.elev(p[0], p[1])[0];
      if (!isNaN(z) && !isNaN(prevZ)) { const d = z - prevZ; if (d > 0) climb += d; else drop -= d; }
      if (!isNaN(z)) prevZ = z;
    }
    const zA = SBMM.elev(pts[0][0], pts[0][1])[0], zB = SBMM.elev(pts[pts.length - 1][0], pts[pts.length - 1][1])[0];
    const grade = (!isNaN(zA) && !isNaN(zB) && len > 0) ? (zB - zA) / len * 100 : NaN;
    f.props = { length_ft: +len.toFixed(1), grade_pct: isNaN(grade) ? null : +grade.toFixed(2) };
    SBMM.results.setRows(f.card, [
      ["Length", fmt(len, 1) + " ft"],
      ["", fmt(len * 0.3048, 1) + " m  ·  " + fmt(len / 3, 1) + " yd"],
      ["End-to-end grade", isNaN(grade) ? "—" : fmt(grade, 1) + " %"],
      ["Climb / descent", fmt(climb, 1) + " / " + fmt(drop, 1) + " ft"],
      ["Segments", String(pts.length - 1)]]);
    SBMM.props && SBMM.props.refresh(f);
  }

  /* ================== area ================== */
  function mkArea(pts) { const f = newFeature("area", pts, nextName("Area")); f.card = SBMM.results.card(f, f.name, []); compArea(f); return f; }
  function compArea(f) {
    const A = polyArea(f.pts), per = polyPerimeter(f.pts);
    f.props = { area_ft2: +A.toFixed(0), area_ac: +(A / 43560).toFixed(4), perimeter_ft: +per.toFixed(1) };
    SBMM.results.setRows(f.card, [
      ["Area", fmt(A / 43560, 3) + " ac"],
      ["", fmt0(A) + " ft²  ·  " + fmt(A * 0.092903, 0) + " m²"],
      ["", fmt(A / 9, 0) + " yd²"],
      ["Perimeter", fmt(per, 0) + " ft"]]);
    SBMM.props && SBMM.props.refresh(f);
  }

  /* ================== volume ================== */
  function mkVolume(pts, name, spec) {
    const f = newFeature("volume", pts, name || nextName("Volume"), spec);
    f.props.baseMode = "tin";
    f.card = SBMM.results.card(f, f.name, "computing…");
    addVolumeControls(f);
    compVolume(f);
    return f;
  }

  /* The integration itself lives in js/compute.js. Here we only assemble the job:
     the polygon, the sampled perimeter (with its Delaunay triangulation, which needs
     d3 and so stays on this side), and windowed COPIES of the DEM cells the bounding
     box can reach — never the whole terrain, and never the app's own arrays (their
     buffers get transferred and would be detached). */
  /* Assemble a volume job for one base surface. Factored out of compVolume so the
     uncertainty range can fire several variants of the SAME footprint at once —
     they differ only in baseMode and in how densely the perimeter was sampled. */
  function buildVolumeJob(f, opts) {
    opts = opts || {};
    const pts = f.pts, pr = f.props;
    const baseMode = opts.baseMode || pr.baseMode || "tin";
    const perimMul = opts.perimMul || 1;
    /* the finest DEM that covers the whole footprint (js/dem.js) — one grid for
       the whole polygon, so a volume is never half 1-ft and half 2-ft */
    const bxs = pts.map(p => p[0]), bys = pts.map(p => p[1]);
    const dem = SBMM.demForBox([Math.min(...bxs), Math.min(...bys),
                                Math.max(...bxs), Math.max(...bys)]) || SBMM.demSite;
    /* size the step from the bounding box (not area) so sprawling polygons can't
       explode the integration loop */
    const xs0 = pts.map(p => p[0]), ys0 = pts.map(p => p[1]);
    const bboxCells = s => ((Math.max(...xs0) - Math.min(...xs0)) / s) * ((Math.max(...ys0) - Math.min(...ys0)) / s);
    let step = dem.m.cell;
    while (bboxCells(step) > 400000) step *= 2;

    const per = samplePerimeter(pts, Math.max(1, step * perimMul))
      .map(p => { const [z] = SBMM.elev(p[0], p[1]); return [p[0], p[1], z]; })
      .filter(p => !isNaN(p[2]));
    if (per.length < 6) return null;

    const perZ = per.map(p => p[2]);
    let fixedZ = opts.fixedZ != null ? opts.fixedZ : pr.fixedZ;
    if (baseMode === "lowest") fixedZ = Math.min(...perZ);

    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const nx = Math.max(1, Math.floor((bx1 - bx0) / step)), ny = Math.max(1, Math.floor((by1 - by0) / step));

    const poly = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { poly[i * 2] = p[0]; poly[i * 2 + 1] = p[1]; });
    const perim = new Float64Array(per.length * 3);
    per.forEach((p, i) => { perim[i * 3] = p[0]; perim[i * 3 + 1] = p[1]; perim[i * 3 + 2] = p[2]; });
    let tri = null;
    if (baseMode === "tin") {
      const dl = d3.Delaunay.from(per, p => p[0], p => p[1]);
      tri = new Uint32Array(dl.triangles);
    }
    /* a design surface base ships its own raster; it is a COPY, because the job
       transfers the buffer and would otherwise detach the surface's cache */
    let dgrid = null;
    if (baseMode === "design") {
      /* the bbox lets a reference surface (§5) ship only the window this
         footprint can reach instead of its whole 13-megapixel raster */
      dgrid = SBMM.design.gridSpecFor(opts.designId || pr.designId, [bx0, by0, bx1, by1]);
      if (!dgrid) return null;
    }
    const grids = SBMM.compute.gridsFor([bx0, by0, bx1, by1]);
    const transfer = [poly.buffer, perim.buffer, ...grids.map(g => g.z.buffer)];
    if (tri) transfer.push(tri.buffer);
    if (dgrid) transfer.push(dgrid.z.buffer);

    return {
      job: { poly, perim, tri, baseMode, fixedZ, dgrid, step, bx0, by0, nx, ny, grids },
      transfer, step, dem, fixedZ, baseMode, nPerim: per.length,
      area: polyArea(pts), bx0, by0, nx, ny
    };
  }

  /* human-readable name of a base surface, for cards, properties and the report */
  function baseLabel(baseMode, fixedZ, designId) {
    if (baseMode === "design") {
      const s = designId && SBMM.store.byId(designId);
      return "design surface: " + (s ? s.name : "(missing)");
    }
    return { tin: "perimeter TIN (memo method)", plane: "best-fit plane",
             fixed: `fixed ${fmt(fixedZ, 1)} ft`,
             lowest: `lowest rim (${fmt(fixedZ, 1)} ft)` }[baseMode] || baseMode;
  }

  async function compVolume(f) {
    const pts = f.pts, pr = f.props;
    const baseMode = pr.baseMode || "tin";
    const built = buildVolumeJob(f);
    if (!built) {
      SBMM.results.setRows(f.card, baseMode === "design"
        ? "that design surface is gone — pick another base"
        : "no terrain under this polygon");
      return;
    }
    const { step, dem, fixedZ, bx0, by0, nx, ny } = built;
    const A = built.area;

    if (f._volHandle) f._volHandle.cancel();
    const handle = SBMM.compute.run("volume", built.job,
      { transfer: built.transfer, label: "Volume — " + (f.name || "feature") });
    f._volHandle = handle;

    let R;
    try { R = await handle.promise; }
    catch (e) {
      if (f._volHandle === handle) f._volHandle = null;
      if (e && e.cancelled) return;                       // superseded by a newer drag
      console.error(e);
      if (f.card && f.card.isConnected) SBMM.results.setRows(f.card, "volume failed: " + e.message);
      return;
    }
    if (f._volHandle !== handle) return;                  // a newer job already won
    f._volHandle = null;
    if (!f.card || !f.card.isConnected) return;           // feature deleted mid-flight

    if (!R.n) { SBMM.results.setRows(f.card, "no terrain under this polygon"); return; }
    const { fill, cut, n, hmax, hmin, hsum, zmin, zmax, hGrid } = R;

    const yd3 = v => v / 27;
    const modeName = baseLabel(baseMode, fixedZ, pr.designId);
    Object.assign(pr, {
      base: modeName, fill_yd3: +yd3(fill).toFixed(1), cut_yd3: +yd3(cut).toFixed(1),
      net_yd3: +yd3(fill - cut).toFixed(1), area_ac: +(A / 43560).toFixed(4),
      mean_height_ft: +(hsum / Math.max(1, n)).toFixed(2), max_height_ft: +hmax.toFixed(2),
      grid: `${dem.m.cell}-ft DEM @ ${step} ft`, cells: n
    });
    const density = pr.density_tpy != null ? pr.density_tpy : 1.5;
    /* Against a DESIGN surface the same two integrals mean something different, and
       calling them the wrong thing on an earthworks card would be a real error:
       terrain above the design is material to EXCAVATE (cut), terrain below it is
       material to PLACE (fill). Against a fitted base the neutral wording stands. */
    const dsn = baseMode === "design";
    const rows = dsn ? [
      ["Cut — terrain above design", sig2(yd3(fill)) + " yd³"],
      ["Fill — design above terrain", sig2(yd3(cut)) + " yd³"],
      ["Net (cut − fill)", sig2(yd3(fill - cut)) + " yd³"],
      ["≈ tonnage @ " + density + " t/yd³", sig2(yd3(fill) * density) + " tons"],
      ["Truckloads @ 10 yd³", fmt0(Math.ceil(yd3(fill) / 10)) + " loads"],
      ["Area", fmt(A / 43560, 3) + " ac · " + fmt0(A) + " ft²"],
      ["Mean / max cut depth", fmt(hsum / Math.max(1, n), 1) + " / " + fmt(hmax, 1) + " ft"],
      ["Terrain range", fmt(zmin, 1) + " – " + fmt(zmax, 1) + " ft"],
      ["Grid", `${pr.grid} · ${fmt0(n)} cells`]
    ] : [
      ["Volume above base", sig2(yd3(fill)) + " yd³"],
      ["Volume below base", sig2(yd3(cut)) + " yd³"],
      ["Net (above − below)", sig2(yd3(fill - cut)) + " yd³"],
      ["≈ tonnage @ " + density + " t/yd³", sig2(yd3(fill) * density) + " tons"],
      ["Truckloads @ 10 yd³", fmt0(Math.ceil(yd3(fill) / 10)) + " loads"],
      ["Area", fmt(A / 43560, 3) + " ac · " + fmt0(A) + " ft²"],
      ["Mean / max height", fmt(hsum / Math.max(1, n), 1) + " / " + fmt(hmax, 1) + " ft"],
      ["Terrain range", fmt(zmin, 1) + " – " + fmt(zmax, 1) + " ft"],
      ["Grid", `${pr.grid} · ${fmt0(n)} cells`]];
    if (dsn) { pr.cut_design_yd3 = +yd3(fill).toFixed(1); pr.fill_design_yd3 = +yd3(cut).toFixed(1); }
    SBMM.results.setRows(f.card, rows);
    /* kept for the report generator, which must show exactly what the card showed */
    f._volRows = rows;
    f._volMeta = { baseMode, modeName, step, demCell: dem.m.cell, cells: n, area: A,
                   fill_yd3: yd3(fill), cut_yd3: yd3(cut), net_yd3: yd3(fill - cut),
                   zmin, zmax, hmax, hmin, density, designId: pr.designId || null,
                   hmean: hsum / Math.max(1, n) };
    const hdr = f.card.querySelector(".basename"); if (hdr) hdr.textContent = modeName;

    /* cut/fill raster refresh if visible */
    if (pr.showCutFill) renderCutFill(f, hGrid, nx, ny, bx0, by0, step, hmax, hmin, dsn);
    else removeCutFill(f);
    f._cf = { hGrid, nx, ny, bx0, by0, step, hmax, hmin };
    SBMM.props && SBMM.props.refresh(f);
  }

  const PLANNING_NOTE =
    "Neat in-place topographic volume, no bulking. Perimeter-TIN base reproduces the ABP memo Attachment E method. Planning-level — report to 2 significant figures.";

  /* the base dropdown is rebuilt whenever the set of design surfaces changes, so a
     surface created after this card still shows up as a base without a reload */
  function baseOptionsHtml(f) {
    const surfs = SBMM.design ? SBMM.design.list() : [];
    const cur = f.props.baseMode || "tin", curId = f.props.designId;
    const sel = (v, extra) => (cur === v && !extra) || (extra && cur === "design" && curId === extra) ? " selected" : "";
    return `<option value="tin"${sel("tin")}>perimeter TIN (memo)</option>
      <option value="plane"${sel("plane")}>best-fit plane</option>
      <option value="lowest"${sel("lowest")}>lowest rim point</option>
      <option value="fixed"${sel("fixed")}>fixed elevation…</option>` +
      surfs.map(s => `<option value="design:${s.id}"${sel(null, s.id)}>design surface: ${esc(s.name)}</option>`).join("");
  }
  function refreshBaseSelects() {
    for (const f of SBMM.store.features) {
      if (f.type !== "volume" || !f.card || !f.card.isConnected) continue;
      const sel = f.card.querySelector(".vbase");
      if (sel) sel.innerHTML = baseOptionsHtml(f);
    }
  }

  function addVolumeControls(f) {
    const ctl = document.createElement("div"); ctl.className = "volctl";
    ctl.innerHTML = `
      <div class="crow"><span>base surface</span>
        <select class="vbase">${baseOptionsHtml(f)}</select>
        <input type="number" class="vz" step="0.5" style="width:70px;display:none" placeholder="ft">
        <span class="basename mono"></span></div>
      <div class="crow"><span>density t/yd³</span><input type="number" class="vden" step="0.1" value="${f.props.density_tpy != null ? f.props.density_tpy : 1.5}" style="width:58px">
        <label class="cfl"><input type="checkbox" class="vcf"> cut/fill map</label></div>
      <div class="crow btns"><button class="minib vrange" title="Low / best / high across five base-surface methods">range</button>
        <button class="minib vreport" title="Print-ready report sheet (REPORT)">report</button></div>`;
    const sel = ctl.querySelector(".vbase"), inp = ctl.querySelector(".vz"),
          den = ctl.querySelector(".vden"), cf = ctl.querySelector(".vcf");
    sel.onchange = () => {
      const v = sel.value;
      inp.style.display = v === "fixed" ? "" : "none";
      if (v.startsWith("design:")) { f.props.baseMode = "design"; f.props.designId = v.slice(7); }
      else { f.props.baseMode = v; f.props.designId = null; }
      if (v !== "fixed") compVolume(f);
    };
    inp.onchange = () => { f.props.fixedZ = parseFloat(inp.value); if (!isNaN(f.props.fixedZ)) compVolume(f); };
    den.onchange = () => { f.props.density_tpy = parseFloat(den.value) || 1.5; compVolume(f); };
    cf.onchange = () => {
      f.props.showCutFill = cf.checked;
      if (cf.checked && f._cf) { const c = f._cf; renderCutFill(f, c.hGrid, c.nx, c.ny, c.bx0, c.by0, c.step, c.hmax, c.hmin, f.props.baseMode === "design"); }
      else removeCutFill(f);
    };
    ctl.querySelector(".vrange").onclick = () => volumeRange(f);
    ctl.querySelector(".vreport").onclick = () => SBMM.report.open(f);
    if (f.props.showCutFill) cf.checked = true;
    f.card.appendChild(ctl);
    SBMM.results.appendNote(f.card, PLANNING_NOTE);
  }

  /* ---------------- uncertainty range ----------------
     The memo reports a planning-level volume as low / best / high rather than a
     single number, because the base surface is a modelling choice and not a
     measurement. This reruns the same footprint against five defensible bases in
     parallel and reports the spread — perimeter TIN stays "best" because that is
     the method the memo used. */
  const RANGE_METHODS = [
    { key: "tin",   label: "perimeter TIN (memo method)", opts: { baseMode: "tin" }, best: true },
    { key: "tin2",  label: "perimeter TIN, 2× perimeter density", opts: { baseMode: "tin", perimMul: 0.5 } },
    { key: "tinh",  label: "perimeter TIN, ½× perimeter density", opts: { baseMode: "tin", perimMul: 2 } },
    { key: "plane", label: "best-fit plane", opts: { baseMode: "plane" } },
    { key: "low",   label: "lowest rim point", opts: { baseMode: "lowest" } }
  ];
  async function volumeRange(f) {
    if (f.type !== "volume") { toast("range applies to a volume footprint"); return; }
    const btn = f.card && f.card.querySelector(".vrange");
    if (btn) { btn.disabled = true; btn.textContent = "range…"; }
    const runs = [];
    for (const m of RANGE_METHODS) {
      const built = buildVolumeJob(f, m.opts);
      if (!built) continue;
      const h = SBMM.compute.run("volume", built.job,
        { transfer: built.transfer, label: `Range (${m.key}) — ${f.name || "feature"}` });
      runs.push({ m, built, h });
    }
    let out;
    try { out = await Promise.all(runs.map(r => r.h.promise)); }
    catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "range"; }
      if (!(e && e.cancelled)) toast("range failed: " + e.message);
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = "range"; }
    if (!f.card || !f.card.isConnected) return;

    const yd3 = v => v / 27;
    const rows = out.map((R, i) => ({
      label: runs[i].m.label, best: !!runs[i].m.best,
      fill: yd3(R.fill), cut: yd3(R.cut), net: yd3(R.fill - R.cut)
    })).filter(r => isFinite(r.fill));
    if (!rows.length) { toast("range: nothing integrated"); return; }
    const fills = rows.map(r => r.fill);
    const bestRow = rows.find(r => r.best) || rows[0];
    const range = { lo: Math.min(...fills), hi: Math.max(...fills), best: bestRow.fill,
                    methods: rows.map(r => ({ label: r.label, fill: +r.fill.toFixed(1), net: +r.net.toFixed(1) })) };
    f._range = range;
    f.props.range_low_yd3 = +range.lo.toFixed(1);
    f.props.range_best_yd3 = +range.best.toFixed(1);
    f.props.range_high_yd3 = +range.hi.toFixed(1);

    let box = f.card.querySelector(".vrangebox");
    if (!box) { box = document.createElement("div"); box.className = "vrangebox"; f.card.appendChild(box); }
    box.innerHTML =
      `<div class="rhead">Uncertainty range — ${rows.length} base surfaces</div>
       <div class="rtrip"><span><b>${sig2(range.lo)}</b><i>low</i></span>
         <span class="mid"><b>${sig2(range.best)}</b><i>best</i></span>
         <span><b>${sig2(range.hi)}</b><i>high</i></span></div>
       <table class="rmeth">${rows.map(r =>
         `<tr class="${r.best ? "best" : ""}"><td>${esc(r.label)}</td><td class="num">${sig2(r.fill)}</td></tr>`).join("")}</table>
       <div class="note">yd³ above the base. "Best" is the perimeter-TIN method the ABP memo used; low and high bracket the modelling choice, not survey error.</div>`;
    SBMM.props && SBMM.props.refresh(f);
    toast(`range: ${sig2(range.lo)} – ${sig2(range.hi)} yd³ (best ${sig2(range.best)})`);
    return range;
  }
  /* `dsn` flips the legend wording: h = terrain − base, so a positive h is material
     ABOVE the base. Against a fitted base that reads as "fill"; against a DESIGN
     surface the very same sign means terrain standing above the design, which is
     material to CUT. Same raster, opposite word — worth getting right on a drawing
     someone digs from. */
  function renderCutFill(f, hGrid, nx, ny, bx0, by0, step, hmax, hmin, dsn) {
    removeCutFill(f);
    const c = document.createElement("canvas"); c.width = nx; c.height = ny;
    const g = c.getContext("2d"); const img = g.createImageData(nx, ny); const px = img.data;
    const M = Math.max(hmax, -hmin, 0.1);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const h = hGrid[j * nx + i];
      const k = ((ny - 1 - j) * nx + i) * 4;
      if (isNaN(h)) { px[k + 3] = 0; continue; }
      const rgb = lerpRamp(RAMPS.cutfill, (h / M + 1) / 2);
      px[k] = rgb[0]; px[k + 1] = rgb[1]; px[k + 2] = rgb[2]; px[k + 3] = 185;
    }
    g.putImageData(img, 0, 0);
    const ov = L.imageOverlay(c.toDataURL("image/png"),
      [[by0, bx0], [by0 + ny * step, bx0 + nx * step]], { pane: "analysis", opacity: .8 });
    ov.addTo(SBMM.map);
    f.extraLayers = f.extraLayers || []; f.extraLayers.push(ov); f._cfLayer = ov;
    let leg = f.card.querySelector(".cfleg");
    if (!leg) { leg = document.createElement("div"); leg.className = "cfleg legend"; f.card.appendChild(leg); }
    const loLbl = dsn ? "fill" : "cut", hiLbl = dsn ? "cut" : "fill";
    leg.innerHTML = `<span class="mono">${loLbl} ${fmt(Math.max(0, -hmin), 1)} ft</span>
      <span class="rampbar" style="background:linear-gradient(90deg,${RAMPS.cutfill.map(cc => `rgb(${cc.join(",")})`).join(",")})"></span>
      <span class="mono">${hiLbl} ${fmt(hmax, 1)} ft</span>`;
  }
  function removeCutFill(f) {
    if (f._cfLayer) { SBMM.map.removeLayer(f._cfLayer); if (f.extraLayers) f.extraLayers = f.extraLayers.filter(l => l !== f._cfLayer); f._cfLayer = null; }
    const leg = f.card && f.card.querySelector(".cfleg"); if (leg) leg.remove();
  }

  /* one-click presets */
  function volumeOfPile(ref) {
    let ring, label;
    if (typeof ref === "number" && SBMM.pileIndex[ref]) { ring = SBMM.pileIndex[ref].ring; label = SBMM.pileIndex[ref].label; }
    else { const p = SBMM.tracedPiles.find(q => q.name === ref); if (!p) return; ring = p.ring; label = p.name; }
    const f = mkVolume(ring.map(p => p.slice()), label + " — volume");
    zoomTo(f);
  }
  function volumeOfRing(duName) {
    const d = SBMM_DATA.dus.find(q => q.name === duName); if (!d) return;
    const f = mkVolume(d.ring.map(p => p.slice()), duName + " — volume");
    zoomTo(f);
  }
  /* same one-click preset for any read-only project ring (e.g. the EA design
     boundaries), which carry their geometry rather than a name to look up */
  function volumeOfRingPts(ring, label) {
    if (!ring || ring.length < 3) return;
    const f = mkVolume(ring.map(p => p.slice()), (label || "boundary") + " — volume");
    zoomTo(f);
  }

  /* ================== profile ================== */
  function mkProfile(pts) { const f = newFeature("profile", pts, nextName("Profile")); f.card = SBMM.results.card(f, f.name, []); compProfile(f); return f; }
  function compProfile(f) {
    const pts = f.pts;
    let total = 0; const seg = [0];
    for (let i = 1; i < pts.length; i++) { total += dist2d(pts[i - 1], pts[i]); seg.push(total); }
    const N = Math.min(800, Math.max(150, Math.round(total / 2)));
    const D = [], Z = [], XY = [];
    for (let k = 0; k <= N; k++) {
      const s = total * k / N;
      const p = pointAlong(pts, s, seg);
      const [z] = SBMM.elev(p[0], p[1]);
      D.push(s); Z.push(z); XY.push(p);
    }
    const zs = Z.filter(v => !isNaN(v));
    const zmin = Math.min(...zs), zmax = Math.max(...zs);
    let climb = 0, drop = 0;
    for (let i = 1; i < Z.length; i++) if (!isNaN(Z[i]) && !isNaN(Z[i - 1])) { const d = Z[i] - Z[i - 1]; if (d > 0) climb += d; else drop -= d; }
    f.props = { length_ft: +total.toFixed(1), zmin: +zmin.toFixed(1), zmax: +zmax.toFixed(1), profile: D.map((s, i) => [+s.toFixed(1), isNaN(Z[i]) ? null : +Z[i].toFixed(2)]) };
    SBMM.results.setRows(f.card, [
      ["Length", fmt0(total) + " ft"],
      ["Elevation range", fmt(zmin, 1) + " – " + fmt(zmax, 1) + " ft"],
      ["Relief", fmt(zmax - zmin, 1) + " ft"],
      ["Climb / descent", fmt(climb, 1) + " / " + fmt(drop, 1) + " ft"]]);
    let holder = f.card.querySelector(".profileCard");
    if (!holder) {
      holder = document.createElement("div"); holder.className = "profileCard";
      f.card.appendChild(holder);
      const exp = document.createElement("span"); exp.className = "minib"; exp.textContent = "profile CSV";
      exp.style.marginTop = "6px"; exp.style.display = "inline-block";
      exp.onclick = () => {
        let csv = "station_ft,elev_ft,sp_e,sp_n\n";
        D.forEach((s, i) => csv += `${s.toFixed(1)},${isNaN(Z[i]) ? "" : Z[i].toFixed(2)},${XY[i][0].toFixed(1)},${XY[i][1].toFixed(1)}\n`);
        download((f.name || "profile").replace(/\W+/g, "_") + ".csv", new Blob([csv], { type: "text/csv" }));
      };
      f.card.appendChild(exp);
    }
    holder.innerHTML = svgProfile(D, Z, zmin, zmax, total);
    hookProfileHover(holder, D, Z, XY, total, zmin, zmax);
    SBMM.props && SBMM.props.refresh(f);
  }
  function pointAlong(pts, s, segIn) {
    let seg = segIn;
    if (!seg) { seg = [0]; let t = 0; for (let i = 1; i < pts.length; i++) { t += dist2d(pts[i - 1], pts[i]); seg.push(t); } }
    let i = 1; while (i < seg.length - 1 && seg[i] < s) i++;
    const t = (s - seg[i - 1]) / (seg[i] - seg[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  }
  function svgProfile(D, Z, zmin, zmax, total) {
    const W = 306, H = 170, Lx = 44, R = 8, T = 10, B = 22, pw = W - Lx - R, ph = H - T - B;
    const zpad = (zmax - zmin) * 0.08 + 0.5;
    const X = s => Lx + pw * s / total, Y = z => T + ph * (1 - (z - (zmin - zpad)) / ((zmax + zpad) - (zmin - zpad)));
    let path = "", area = `M ${X(0)} ${T + ph}`;
    Z.forEach((z, i) => {
      if (isNaN(z)) return;
      path += (path ? " L" : "M") + ` ${X(D[i]).toFixed(1)} ${Y(z).toFixed(1)}`;
      area += ` L ${X(D[i]).toFixed(1)} ${Y(z).toFixed(1)}`;
    });
    area += ` L ${X(total)} ${T + ph} Z`;
    let grid = "", lbl = "";
    const zstep = Math.max(2, Math.ceil((zmax - zmin) / 4 / 2) * 2);
    for (let z = Math.ceil(zmin / zstep) * zstep; z <= zmax; z += zstep) {
      grid += `<line class="gridl" x1="${Lx}" x2="${W - R}" y1="${Y(z)}" y2="${Y(z)}"/>`;
      lbl += `<text x="${Lx - 5}" y="${Y(z) + 3}" text-anchor="end">${z}</text>`;
    }
    for (const fr of [0, 0.5, 1])
      lbl += `<text x="${X(total * fr)}" y="${H - 7}" text-anchor="middle">${fmt0(total * fr)} ft</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="axis">${grid}
      <path class="parea" d="${area}"/><path class="pline" d="${path}"/>
      <line class="pfx" x1="0" x2="0" y1="${T}" y2="${T + ph}" stroke="#FFD34D" stroke-width="1" opacity="0"/>
      <circle class="pfc" r="3.5" fill="#FFD34D" opacity="0"/>
      <text class="pft" x="0" y="0" fill="#FFD34D" font-size="10" font-family="monospace"></text>
      ${lbl}<rect x="${Lx}" y="${T}" width="${pw}" height="${ph}" fill="transparent" class="pfhit"/></svg>`;
  }
  function hookProfileHover(holder, D, Z, XY, total, zmin, zmax) {
    const svg = holder.querySelector("svg"), hit = holder.querySelector(".pfhit"),
      fx = holder.querySelector(".pfx"), fc = holder.querySelector(".pfc"), ft = holder.querySelector(".pft");
    const W = 306, Lx = 44, R = 8, T = 10, B = 22, pw = W - Lx - R, ph = 170 - T - B, zpad = (zmax - zmin) * 0.08 + 0.5;
    let mapDot = null;
    hit.addEventListener("mousemove", e => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
      const s = clamp((px - Lx) / pw * total, 0, total);
      const i = Math.round(s / total * (D.length - 1)), z = Z[i]; if (isNaN(z)) return;
      const Xp = Lx + pw * s / total, Yp = T + ph * (1 - (z - (zmin - zpad)) / ((zmax + zpad) - (zmin - zpad)));
      fx.setAttribute("x1", Xp); fx.setAttribute("x2", Xp); fx.style.opacity = 1;
      fc.setAttribute("cx", Xp); fc.setAttribute("cy", Yp); fc.style.opacity = 1;
      ft.textContent = `${fmt(z, 1)} ft @ ${fmt0(s)} ft`;
      ft.setAttribute("x", Math.min(Xp + 6, W - 110)); ft.setAttribute("y", Math.max(Yp - 8, 18));
      const p = XY[i];
      if (!mapDot) mapDot = L.circleMarker([p[1], p[0]], { pane: "drawings", radius: 5, color: "#FFD34D", weight: 2, fillColor: "#12181C", fillOpacity: 1 }).addTo(SBMM.map);
      else mapDot.setLatLng([p[1], p[0]]);
    });
    hit.addEventListener("mouseleave", () => {
      fx.style.opacity = 0; fc.style.opacity = 0; ft.textContent = "";
      if (mapDot) { SBMM.map.removeLayer(mapDot); mapDot = null; }
    });
  }

  /* ================== restore / import ================== */
  function rebuildFeature(spec) {
    const { type, pts, name, props } = spec;
    let f = null;
    if (type === "spot") { f = dropSpot(pts[0][0], pts[0][1]); }
    else if (type === "line") { f = mkDistance(pts); }
    else if (type === "area") { f = mkArea(pts); }
    else if (type === "volume") {
      f = mkVolume(pts, name, spec);
      if (props) {
        f.props.baseMode = props.baseMode || "tin"; f.props.fixedZ = props.fixedZ;
        f.props.density_tpy = props.density_tpy; f.props.designId = props.designId || null;
        f.props.showCutFill = !!props.showCutFill;
        compVolume(f);
      }
    }
    else if (type === "profile") { f = mkProfile(pts); }
    /* v4 additions — an older session simply never contains these */
    else if (type === "dim") { f = mkDim(pts, name, props); }
    else if (type === "text") { f = mkText(pts, (props && props.text) || name || "text", props); }
    /* v5 additions — design surfaces and section sets */
    else if (type === "surface") { f = SBMM.design.mkSurface(pts, name, props, spec); }
    else if (type === "sections") { f = SBMM.sections.mkSections(pts, name, props, spec); }
    else return null;
    if (name) {
      f.name = name;
      const rn = f.card && f.card.querySelector(".rname"); if (rn) rn.textContent = name;
    }
    /* Provenance survives a session round-trip for every feature type. Each
       branch above rebuilds props from the geometry, which is right for the
       computed values and wrong for the record of where the feature came from —
       a mark made on sheet C-107 has to still say so after a reload (§9). */
    if (props && props.provenance) f.props.provenance = props.provenance;
    /* same reasoning for the import flag: it says where the feature came from,
       not what its geometry measures, so the recompute above must not drop it
       (the "Imported" row in My work reads it) */
    if (props && props.imported) f.props.imported = true;
    /* optional session/import metadata — absent in v2 sessions, which is fine */
    if (spec.group) f.group = spec.group;
    if (spec.style) { f.style = spec.style; applyStyle(f); }
    if (spec.locked) f.locked = true;
    if (spec.visible === false) SBMM.store.setVisible(f, false);
    SBMM.store.emit();
    return f;
  }

  /* ================================================================== */
  /* DIM + TEXT — CAD annotation drawn straight onto the map            */
  /* ================================================================== */
  /* Both are FeatureGroups rebuilt from scratch whenever the geometry, the style,
     the selection or the zoom changes. Their graphic furniture (arrowheads,
     extension ticks, leader) is sized in SCREEN pixels converted to map feet, so a
     dimension reads the same at any scale; only the annotation text scales with the
     map, in map units with clamps, the way an annotative CAD text style behaves. */
  function pxPerFt() { return Math.pow(2, SBMM.map.getZoom()); }
  function annoColor(f) {
    const sel = SBMM.store.selected === f.id;
    if (sel) return SEL_COLOR;
    return (f.style && f.style.color) || baseStyle(f.type).color;
  }
  function buildAnno(f) {
    if (!f.layer || !f.layer.clearLayers) return;
    f.layer.clearLayers();
    if (f.type === "dim") buildDim(f); else buildText(f);
  }
  function buildDim(f) {
    if (f.pts.length < 2) return;
    const a = f.pts[0], b = f.pts[1];
    const k = pxPerFt(), px = n => n / k;
    const col = annoColor(f);
    const w = (f.style && f.style.weight) || baseStyle("dim").weight;
    const dx = b[0] - a[0], dy = b[1] - a[1], Lf = Math.hypot(dx, dy);
    if (Lf < 1e-6) return;
    const ux = dx / Lf, uy = dy / Lf, nx = -uy, ny = ux;
    const off = (f.props && f.props.off) || 0;
    const A = [a[0] + nx * off, a[1] + ny * off], B = [b[0] + nx * off, b[1] + ny * off];
    const ext = px(7), gap = px(3), arrow = px(10), half = px(3.4);
    const P = ll => [ll[1], ll[0]];
    const st = { pane: "drawings", color: col, weight: w, interactive: true };

    /* extension lines (offset dim) or end ticks (dim line straight between the points) */
    if (Math.abs(off) > px(4)) {
      const s = off > 0 ? 1 : -1;
      for (const [p, q] of [[a, A], [b, B]])
        L.polyline([P([p[0] + nx * s * gap, p[1] + ny * s * gap]), P([q[0] + nx * s * ext, q[1] + ny * s * ext])], st).addTo(f.layer);
    } else {
      for (const p of [A, B])
        L.polyline([P([p[0] - nx * ext, p[1] - ny * ext]), P([p[0] + nx * ext, p[1] + ny * ext])], st).addTo(f.layer);
    }
    /* dimension line + solid arrowheads pointing outward at each end */
    L.polyline([P(A), P(B)], { ...st, weight: w + .3 }).addTo(f.layer);
    const head = (tip, dirx, diry) => L.polygon([
      P(tip),
      P([tip[0] + dirx * arrow + nx * half, tip[1] + diry * arrow + ny * half]),
      P([tip[0] + dirx * arrow - nx * half, tip[1] + diry * arrow - ny * half])
    ], { pane: "drawings", color: col, weight: 1, fillColor: col, fillOpacity: 1, interactive: false }).addTo(f.layer);
    if (Lf > px(30)) { head(A, ux, uy); head(B, -ux, -uy); }

    /* text, aligned with the dimension line and kept right-way-up */
    let deg = Math.atan2(uy, ux) * 180 / Math.PI;
    if (deg > 90 || deg < -90) deg += 180;
    const mid = [(A[0] + B[0]) / 2 + nx * px(9), (A[1] + B[1]) / 2 + ny * px(9)];
    const txt = fmt(Lf, 2) + " ft";
    L.marker(P(mid), {
      pane: "drawings", interactive: false,
      icon: L.divIcon({
        className: "annolbl", iconSize: [0, 0],
        html: `<span class="dimtxt" style="color:${col};transform:translate(-50%,-50%) rotate(${(-deg).toFixed(1)}deg)">${esc(txt)}</span>`
      })
    }).addTo(f.layer);
  }
  const TEXT_MIN_PX = 9, TEXT_MAX_PX = 34;
  function buildText(f) {
    const p = f.pts[0]; if (!p) return;
    const col = annoColor(f);
    const sizeFt = (f.props && f.props.size_ft) || 20;
    const sizePx = clamp(sizeFt * pxPerFt(), TEXT_MIN_PX, TEXT_MAX_PX);
    const label = (f.props && f.props.text) || f.name || "text";
    if (f.pts.length > 1) {
      const q = f.pts[1];
      L.polyline([[q[1], q[0]], [p[1], p[0]]],
        { pane: "drawings", color: col, weight: (f.style && f.style.weight) || 1.4, interactive: true }).addTo(f.layer);
      L.circleMarker([q[1], q[0]], { pane: "drawings", radius: 3, color: col, weight: 1.5, fillColor: col, fillOpacity: 1, interactive: false }).addTo(f.layer);
    }
    L.marker([p[1], p[0]], {
      pane: "drawings", interactive: true,
      icon: L.divIcon({
        className: "annolbl", iconSize: [0, 0],
        html: `<span class="anntxt" style="color:${col};font-size:${sizePx.toFixed(1)}px">${esc(label)}</span>`
      })
    }).addTo(f.layer);
  }

  function mkDim(pts, name, props) {
    const f = newFeature("dim", pts.slice(0, 2).map(p => p.slice()), name || nextName("Dim"));
    if (props && props.off != null) f.props.off = props.off;
    f.card = SBMM.results.card(f, f.name, []);
    compDim(f);
    return f;
  }
  function compDim(f) {
    const d = dist2d(f.pts[0], f.pts[1]);
    const ang = ((Math.atan2(f.pts[1][1] - f.pts[0][1], f.pts[1][0] - f.pts[0][0]) * 180 / Math.PI) % 360 + 360) % 360;
    const z0 = SBMM.elev(f.pts[0][0], f.pts[0][1])[0], z1 = SBMM.elev(f.pts[1][0], f.pts[1][1])[0];
    const off = f.props.off || 0;
    f.props = { ...f.props, length_ft: +d.toFixed(2), bearing_deg: +ang.toFixed(2), off };
    buildAnno(f);
    if (f.card) SBMM.results.setRows(f.card, [
      ["Dimension", fmt(d, 2) + " ft"],
      ["", fmt(d * 0.3048, 2) + " m  ·  " + fmt(d / 3, 2) + " yd"],
      ["Direction", fmt(ang, 1) + "° (0° = east, CCW)"],
      ["Δ elevation", (isNaN(z0) || isNaN(z1)) ? "—" : fmt(z1 - z0, 1) + " ft"]]);
    SBMM.props && SBMM.props.refresh(f);
  }
  function mkText(pts, label, props) {
    const f = newFeature("text", pts.map(p => p.slice()), label || nextName("Text"));
    f.props.text = label || "text";
    f.props.size_ft = (props && props.size_ft) || 20;
    f.name = label || nextName("Text");
    f.card = SBMM.results.card(f, f.name, []);
    compText(f);
    return f;
  }
  function compText(f) {
    if (!f.props.text) f.props.text = f.name || "text";
    if (!f.props.size_ft) f.props.size_ft = 20;
    const [z] = SBMM.elev(f.pts[0][0], f.pts[0][1]);
    buildAnno(f);
    if (f.card) SBMM.results.setRows(f.card, [
      ["Label", f.props.text],
      ["SP E / N", fmt0(f.pts[0][0]) + " / " + fmt0(f.pts[0][1])],
      ["Text height", fmt(f.props.size_ft, 1) + " ft"],
      ["Ground elevation", isNaN(z) ? "—" : fmt(z, 1) + " ft"],
      ["Leader", f.pts.length > 1 ? "yes" : "none"]]);
    SBMM.props && SBMM.props.refresh(f);
  }
  function setTextLabel(f, s) {
    f.props.text = s;
    if (!f.name || /^Text \d+$/.test(f.name)) f.name = s;
    compText(f);
    SBMM.store.emit(); SBMM.store.autosave();
  }
  function refreshAnnotations() {
    for (const f of SBMM.store.features) if (f.type === "dim" || f.type === "text") buildAnno(f);
  }

  /* ================================================================== */
  /* geometry for the modify tools                                      */
  /* ================================================================== */
  function isClosed(f) { return f.type === "area" || f.type === "volume"; }
  function lineIntersect(p1, d1, p2, d2) {
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-12) return null;
    const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
    return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
  }
  function segProperIntersect(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function signedArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }
  /* per-edge offset with miter joins; bevels past a 10× miter limit. Returns
     { pts, warn } or null when the result collapses. */
  function offsetPath(pts, closed, d) {
    const n = pts.length;
    if (n < 2 || !isFinite(d) || d === 0) return null;
    const edges = [];
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
      if (L < 1e-9) continue;
      const nx = ey / L, ny = -ex / L;                 // right-hand normal
      edges.push({ a: [a[0] + nx * d, a[1] + ny * d], b: [b[0] + nx * d, b[1] + ny * d], u: [ex / L, ey / L], c: a });
    }
    const E = edges.length;
    if (!E) return null;
    const out = [];
    let bevels = 0;
    const joint = (e1, e2, corner) => {
      const p = lineIntersect(e1.a, e1.u, e2.a, e2.u);
      if (!p || Math.hypot(p[0] - corner[0], p[1] - corner[1]) > Math.abs(d) * 10) {
        bevels++; out.push(e1.b.slice()); out.push(e2.a.slice());
      } else out.push(p);
    };
    if (closed) {
      for (let k = 0; k < E; k++) joint(edges[(k - 1 + E) % E], edges[k], pts[k % n]);
    } else {
      out.push(edges[0].a.slice());
      for (let k = 1; k < E; k++) joint(edges[k - 1], edges[k], pts[k]);
      out.push(edges[E - 1].b.slice());
    }
    if (out.length < (closed ? 3 : 2)) return null;
    if (closed && Math.sign(signedArea(out)) !== Math.sign(signedArea(pts))) return null;  // collapsed through itself

    /* self-intersection check — refuse rather than ship a bow-tie */
    let self = false;
    const q = out, N = q.length, lim = closed ? N : N - 1;
    if (N <= 1200) {
      for (let i = 0; i < lim && !self; i++)
        for (let j = i + 2; j < lim; j++) {
          if (closed && i === 0 && j === lim - 1) continue;
          if (segProperIntersect(q[i], q[(i + 1) % N], q[j], q[(j + 1) % N])) { self = true; break; }
        }
    }
    return { pts: out, self, bevels };
  }
  function reflectPt(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    const fx = a[0] + dx * t, fy = a[1] + dy * t;
    return [2 * fx - p[0], 2 * fy - p[1]];
  }
  function rotatePt(p, c, rad) {
    const s = Math.sin(rad), co = Math.cos(rad), dx = p[0] - c[0], dy = p[1] - c[1];
    return [c[0] + dx * co - dy * s, c[1] + dx * s + dy * co];
  }
  /* which side of a path a point falls on: +1 = right-hand normal side */
  function sideOf(pts, closed, q) {
    let bestD = Infinity, bestS = 1;
    const m = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey || 1e-12;
      let t = ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / L2; t = clamp(t, 0, 1);
      const fx = a[0] + ex * t, fy = a[1] + ey * t;
      const dd = Math.hypot(q[0] - fx, q[1] - fy);
      if (dd < bestD) { bestD = dd; const L = Math.sqrt(L2); bestS = ((q[0] - a[0]) * (ey / L) + (q[1] - a[1]) * (-ex / L)) >= 0 ? 1 : -1; }
    }
    return bestS;
  }

  /* ================================================================== */
  /* modify tools — all undoable, all recompute, all preview live       */
  /* ================================================================== */
  function cloneWith(f, pts, suffix) {
    const spec = {
      type: f.type, pts: pts.map(p => p.slice()),
      name: (f.name || f.type) + " " + suffix,
      props: { ...(f.props || {}) },
      group: f.group || "", style: f.style ? { ...f.style } : null
    };
    const nf = rebuildFeature(spec);
    if (nf) { SBMM.undo.push(suffix, () => SBMM.store.remove(nf)); SBMM.store.select(nf.id); }
    return nf;
  }
  function replaceGeom(f, pts, desc) {
    const before = f.pts.map(p => p.slice());
    SBMM.undo.push(desc, () => { f.pts = before; redraw(f); recompute(f, false); SBMM.store.emit(); });
    f.pts = pts.map(p => p.slice());
    redraw(f); recompute(f, false);
    SBMM.store.emit(); SBMM.store.autosave();
  }
  function modifiable(f, what) {
    if (!f) { toast(what + ": no feature selected"); return false; }
    if (f.locked) { toast("feature is locked — unlock it in the Features tab"); return false; }
    return true;
  }
  function ghostOf(f, pts) {
    return { rings: [{ pts, closed: isClosed(f) }] };
  }

  /* ---- OFFSET ---- */
  function opOffset(f, distIn) {
    if (!modifiable(f, "OFFSET")) return;
    if (f.type === "spot" || f.type === "text") { toast("OFFSET needs a line, polygon or dimension"); return; }
    const closed = isClosed(f);
    const go = dist => {
      const d0 = Math.abs(parseFloat(dist));
      if (!isFinite(d0) || d0 <= 0) { toast("offset distance must be a positive number of feet"); return; }
      setTool(null);
      SBMM.draw.beginPick({
        count: 1,
        prompts: [`OFFSET ${fmt(d0, 2)} ft — click the side to offset toward`],
        onMove: (pts, cur) => {
          const s = sideOf(f.pts, closed, cur);
          const r = offsetPath(f.pts, closed, s * d0);
          if (!r) return { label: "OFFSET — that distance collapses the shape" };
          return { rings: [{ pts: r.pts, closed, style: r.self ? { color: "#E4796A" } : null }],
                   label: `OFFSET ${fmt(d0, 2)} ft${r.self ? " — self-intersects, will be refused" : ""}` };
        },
        onDone: pts => {
          const s = sideOf(f.pts, closed, pts[0]);
          const r = offsetPath(f.pts, closed, s * d0);
          if (!r) { toast("OFFSET refused — that distance collapses the shape"); return; }
          if (r.self) { toast("OFFSET refused — the offset outline crosses itself at " + fmt(d0, 1) + " ft; try a smaller distance"); return; }
          const nf = cloneWith(f, r.pts, `offset ${fmt(d0, 1)} ft`);
          if (nf && r.bevels) toast(`offset created — ${r.bevels} sharp corner${r.bevels === 1 ? "" : "s"} bevelled at the miter limit`);
          else if (nf) toast("offset created");
        }
      });
    };
    if (distIn != null && distIn !== "") go(distIn);
    else SBMM.cmd.ask("Offset distance (ft):", go);
  }

  /* ---- MIRROR ---- */
  function opMirror(f) {
    if (!modifiable(f, "MIRROR")) return;
    setTool(null);
    SBMM.draw.beginPick({
      count: 2,
      prompts: ["MIRROR — first point of the mirror axis", "MIRROR — second point of the mirror axis"],
      onMove: (pts, cur) => {
        if (!pts.length) return null;
        const a = pts[0], b = cur;
        return {
          rings: [{ pts: f.pts.map(p => reflectPt(p, a, b)), closed: isClosed(f) },
                  { pts: [a, b], closed: false, style: { color: "#FFD34D", dashArray: "2 6" } }],
          label: `MIRROR — axis ${fmt(dist2d(a, b), 1)} ft`
        };
      },
      onDone: pts => {
        if (dist2d(pts[0], pts[1]) < 1e-6) { toast("MIRROR needs two distinct axis points"); return; }
        cloneWith(f, f.pts.map(p => reflectPt(p, pts[0], pts[1])), "mirrored");
        toast("mirrored copy created");
      }
    });
  }

  /* ---- ROTATE ---- */
  function opRotate(f) {
    if (!modifiable(f, "ROTATE")) return;
    setTool(null);
    const angOf = (base, cur) => Math.atan2(cur[1] - base[1], cur[0] - base[0]);
    SBMM.draw.beginPick({
      count: 2,
      prompts: ["ROTATE — click the base point", "ROTATE — click the rotation angle, or type it in degrees"],
      onMove: (pts, cur) => {
        if (!pts.length) return null;
        const a = angOf(pts[0], cur);
        return {
          rings: [{ pts: f.pts.map(p => rotatePt(p, pts[0], a)), closed: isClosed(f) },
                  { pts: [pts[0], cur], closed: false, style: { color: "#FFD34D", dashArray: "2 6" } }],
          label: `ROTATE ${fmt(((a * 180 / Math.PI) % 360 + 360) % 360, 1)}°`
        };
      },
      /* a bare number after the base point is an angle, not a distance */
      typed: (v, pts) => {
        if (pts.length === 1 && /^-?[\d.]+$/.test(v.trim())) {
          const a = parseFloat(v) * Math.PI / 180;
          return { x: pts[0][0] + Math.cos(a) * 100, y: pts[0][1] + Math.sin(a) * 100 };
        }
        return SBMM.draw.parseTyped(v);
      },
      typedHint: v => (/^-?[\d.]+$/.test(v.trim()) ? { ok: true, text: `rotate by ${fmt(parseFloat(v), 2)}°` } : null),
      onDone: pts => {
        const a = angOf(pts[0], pts[1]);
        replaceGeom(f, f.pts.map(p => rotatePt(p, pts[0], a)), "rotate");
        toast(`rotated ${fmt(((a * 180 / Math.PI) % 360 + 360) % 360, 1)}°`);
      }
    });
  }

  /* ---- MOVE / COPY ---- */
  function opMoveCopy(f, copy) {
    if (!modifiable(f, copy ? "COPY" : "MOVE")) return;
    setTool(null);
    const N = copy ? "COPY" : "MOVE";
    SBMM.draw.beginPick({
      count: 2,
      prompts: [`${N} — click the base point`, `${N} — click the destination (or type @dx,dy)`],
      onMove: (pts, cur) => {
        if (!pts.length) return null;
        const dx = cur[0] - pts[0][0], dy = cur[1] - pts[0][1];
        return {
          rings: [{ pts: f.pts.map(p => [p[0] + dx, p[1] + dy]), closed: isClosed(f) },
                  { pts: [pts[0], cur], closed: false, style: { color: "#FFD34D", dashArray: "2 6" } }],
          label: `${N} Δ${fmt(dx, 1)}, Δ${fmt(dy, 1)} ft  (${fmt(Math.hypot(dx, dy), 1)} ft)`
        };
      },
      onDone: pts => {
        const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
        const moved = f.pts.map(p => [p[0] + dx, p[1] + dy]);
        if (copy) { cloneWith(f, moved, "copy"); toast("copy created"); }
        else { replaceGeom(f, moved, "move"); toast(`moved ${fmt(Math.hypot(dx, dy), 1)} ft`); }
      }
    });
  }

  /* ---- JOIN ---- */
  function opJoin(f) {
    if (!modifiable(f, "JOIN")) return;
    if (f.type !== "line" && f.type !== "profile") { toast("JOIN works on two distance lines"); return; }
    setTool(null);
    toast("JOIN — click the second line to join to \"" + (f.name || "selection") + "\"");
    SBMM.cmd.pickFeature(g => {
      if (!g || g === f) { toast("JOIN cancelled"); return; }
      if (g.type !== "line" && g.type !== "profile") { toast("JOIN needs a second distance line"); return; }
      const A = f.pts, B = g.pts;
      const ends = [
        { d: dist2d(A[A.length - 1], B[0]), a: A, b: B },
        { d: dist2d(A[A.length - 1], B[B.length - 1]), a: A, b: [...B].reverse() },
        { d: dist2d(A[0], B[0]), a: [...A].reverse(), b: B },
        { d: dist2d(A[0], B[B.length - 1]), a: [...A].reverse(), b: [...B].reverse() }
      ].sort((p, q) => p.d - q.d)[0];
      const pts = [...ends.a.map(p => p.slice())];
      const tail = ends.b.map(p => p.slice());
      if (ends.d < 0.01) tail.shift();
      pts.push(...tail);
      const nf = rebuildFeature({ type: "line", pts, name: (f.name || "Line") + " + " + (g.name || "Line"), group: f.group || "" });
      const fs = f, gs = g;
      SBMM.store.remove(fs); SBMM.store.remove(gs);
      if (nf) { SBMM.store.select(nf.id); SBMM.undo.push("join", () => SBMM.store.remove(nf)); }
      toast(`joined — gap ${fmt(ends.d, 2)} ft, ${pts.length} vertices`);
    }, "JOIN — click the second line");
  }

  /* ---- EXPLODE ---- */
  function opExplode(f) {
    if (!modifiable(f, "EXPLODE")) return;
    if (!isClosed(f)) { toast("EXPLODE turns a polygon into an open line — select an area or volume"); return; }
    const pts = [...f.pts.map(p => p.slice()), f.pts[0].slice()];
    const nf = rebuildFeature({ type: "line", pts, name: (f.name || "Area") + " (exploded)", group: f.group || "" });
    SBMM.store.remove(f);
    if (nf) { SBMM.store.select(nf.id); SBMM.undo.push("explode", () => SBMM.store.remove(nf)); }
    toast("exploded to a distance line");
  }

  /* ---- DIM / TEXT placement ---- */
  function opDim() {
    setTool(null);
    SBMM.draw.beginPick({
      count: 2,
      prompts: ["DIM — click the first point", "DIM — click the second point"],
      onMove: (pts, cur) => pts.length
        ? { rings: [{ pts: [pts[0], cur], closed: false, style: { color: "#E8B34B" } }],
            label: `DIM ${fmt(dist2d(pts[0], cur), 2)} ft` }
        : null,
      onDone: pts => {
        if (dist2d(pts[0], pts[1]) < 1e-6) { toast("DIM needs two distinct points"); return; }
        const f = mkDim(pts);
        SBMM.undo.push("dimension", () => SBMM.store.remove(f));
        SBMM.store.select(f.id);
        toast("dimension " + fmt(dist2d(pts[0], pts[1]), 2) + " ft");
      }
    });
  }
  function opText(preset) {
    setTool(null);
    SBMM.draw.beginPick({
      count: 1,
      prompts: ["TEXT — click where the label goes"],
      onDone: pts => {
        const place = label => {
          if (!label) { toast("TEXT cancelled"); return; }
          const f = mkText([pts[0]], label);
          SBMM.undo.push("text", () => SBMM.store.remove(f));
          SBMM.store.select(f.id);
          /* optional leader — Esc finishes without one */
          SBMM.draw.beginPick({
            count: 1,
            prompts: ["TEXT — click a leader target, or press Esc to finish without a leader"],
            onMove: (p2, cur) => ({ rings: [{ pts: [cur, pts[0]], closed: false, style: { color: "#E8EEF1" } }], label: "leader — Esc to skip" }),
            onDone: p2 => { f.pts = [pts[0], p2[0]]; compText(f); SBMM.store.emit(); SBMM.store.autosave(); toast("leader added"); },
            onCancel: () => toast("text placed")
          });
        };
        if (preset) place(preset); else SBMM.cmd.ask("Text:", place);
      }
    });
  }

  /* zoom-dependent annotation redraw */
  function wire() {
    SBMM.map.on("zoomend", refreshAnnotations);
    SBMM.store.onSelect(() => refreshAnnotations());
  }

  let seq = {};
  function nextName(base) { seq[base] = (seq[base] || 0) + 1; return `${base} ${seq[base]}`; }

  return { setTool, active, rearm, mapClick, dropSpot, inspectAt, mkVolume, volumeOfPile, volumeOfRing, volumeOfRingPts,
           editFeature, zoomTo, rebuildFeature, recompute, applyStyle, redraw,
           defaultColor, baseStyle, compVolume, wire,
           /* earthworks (phase 3) */
           buildVolumeJob, baseLabel, volumeRange, refreshBaseSelects, newFeature,
           nextName: b => nextName(b), PLANNING_NOTE, renderCutFill, removeCutFill,
           /* drafting */
           mkDim, mkText, setTextLabel, refreshAnnotations, isClosed,
           opOffset, opMirror, opRotate, opMoveCopy, opJoin, opExplode, opDim, opText,
           offsetPath, reflectPt, rotatePt };
})();
