/* SBMM Site Explorer — smart boundary tools (phase 4).

   Four tools that turn one click into an editable outline, so that the boring,
   error-prone part of a take-off — tracing a footprint by hand at 200 vertices a
   pile — is done by the terrain itself:

     WAND    pile delineation by morphological top-hat (the ABP memo's own method)
     CBOUND  the closed terrain contour through a clicked point (ponds, benches)
     TOE     the line where slope crosses a threshold (toe / crest break lines)
     STANDS  canopy stands over a threshold height (clearing limits)

   Every one of them produces an ORDINARY feature — an "area" or a "line" — with a
   name, a folder, a style, Properties, session serialisation, DXF/GeoJSON export
   and the existing vertex editor. Nothing here is a special layer the user cannot
   touch afterwards; the tools are a starting outline, not a black box. That matters
   because none of these methods is right every time, and the user is the one who
   knows which mound is one pile and which is two.

   All raster work runs in the compute worker (js/compute.js kernels "wand",
   "cbound", "toecrest", "stands"), so the UI never blocks and a superseded preview
   is cancelled rather than queued. */
"use strict";

SBMM.smartbound = (function () {

  /* current tool state: { kind, opts, card, preview, handle } */
  let live = null;
  let previewLayer = null, previewJob = null, previewTimer = null;

  /* ------------------------------------------------------------------ */
  /* defaults — every one of these is exposed in the tool-options row     */
  /* ------------------------------------------------------------------ */
  const DEF = {
    wand:   { r: 35, thresh: 0.75, smooth: 18, slopeCut: 0.30, win: 420 },
    cbound: { level: null, smooth: 3, win: 1300 },
    toe:    { thresh: 0.15, smooth: 12, win: 320, mode: "toe" },
    stands: { thresh: 6, minArea: 500, closeR: 1 }
  };
  const P = { wand: { ...DEF.wand }, cbound: { ...DEF.cbound }, toe: { ...DEF.toe }, stands: { ...DEF.stands } };

  const RESID_RAMP = [[26, 52, 92], [40, 120, 190], [90, 200, 205], [235, 205, 90], [232, 110, 70]];

  /* ------------------------------------------------------------------ */
  /* grid plumbing                                                       */
  /* ------------------------------------------------------------------ */
  /* Pick the DEM the way buildVolumeJob does — the 1-ft mine-area grid when the
     whole window fits inside it, the 2-ft site grid otherwise. It is not a detail:
     the Herman impoundment runs 1,880 ft east-west and off the east edge of the
     1-ft window, so on the fine grid its shoreline never closes. */
  function demFor(bbox) {
    return SBMM.demForBox(bbox) || SBMM.demSite;
  }
  function windowSpec(cx, cy, halfFt, demOverride) {
    const bbox = [cx - halfFt, cy - halfFt, cx + halfFt, cy + halfFt];
    const dem = demOverride || demFor(bbox);
    const g = SBMM.compute.gridSpec(dem, bbox, 4);
    if (!g) throw new Error("that point is outside the surveyed terrain");
    return { g, dem };
  }

  /* ------------------------------------------------------------------ */
  /* tool-options row — same shape as the volume card's controls          */
  /* ------------------------------------------------------------------ */
  function optionsCard(title, note, fields, onChange) {
    const card = SBMM.results.card(null, title, note);
    card.classList.add("toolopt");
    const ctl = document.createElement("div"); ctl.className = "volctl";
    ctl.innerHTML = fields.map(f => f.type === "select"
      ? `<div class="crow"><span>${esc(f.label)}</span><select data-k="${f.key}" style="width:${f.width || 96}px">${
          f.options.map(o => `<option value="${o[0]}"${o[0] === f.value ? " selected" : ""}>${esc(o[1])}</option>`).join("")}</select></div>`
      : `<div class="crow"><span>${esc(f.label)}</span><input type="number" data-k="${f.key}" step="${f.step}" ${
          f.min != null ? `min="${f.min}"` : ""} value="${f.value == null ? "" : f.value}" style="width:${f.width || 66}px"${
          f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}><span class="basename">${esc(f.unit || "")}</span></div>`
    ).join("") + `<div class="crow btns"><button class="minib sbdone">done</button></div>`;
    ctl.querySelectorAll("[data-k]").forEach(el => {
      el.onchange = () => {
        const k = el.dataset.k;
        const v = el.tagName === "SELECT" ? el.value : (el.value === "" ? null : parseFloat(el.value));
        onChange(k, v);
      };
    });
    ctl.querySelector(".sbdone").onclick = () => disarm(true);
    card.appendChild(ctl);
    return card;
  }

  /* ------------------------------------------------------------------ */
  /* arming / disarming                                                  */
  /* ------------------------------------------------------------------ */
  function disarm(quiet) {
    clearPreview();
    if (live && live.card) live.card.remove();
    if (live) live = null;
    SBMM.draw.cancel();
    SBMM.draw.endPick(true);
    SBMM.results.checkEmpty();
    if (!quiet) toast("tool cancelled");
  }
  function armed() { return live ? live.kind : null; }

  /* re-arm the click picker after each result, so a user can wand pile after pile */
  function rearm(kind, prompt, onPoint) {
    if (!live || live.kind !== kind) return;
    SBMM.draw.beginPick({
      count: 1, prompts: [prompt],
      onDone: pts => {
        const [x, y] = pts[0];
        Promise.resolve().then(() => onPoint(x, y)).catch(e => {
          if (!(e && e.cancelled)) toast(e.message || String(e));
        }).then(() => rearm(kind, prompt, onPoint));
      },
      onCancel: () => disarm(true)
    });
  }

  /* ------------------------------------------------------------------ */
  /* residual preview overlay (WAND)                                     */
  /* ------------------------------------------------------------------ */
  function clearPreview() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    if (previewJob) { previewJob.cancel(); previewJob = null; }
    if (previewLayer) { SBMM.map.removeLayer(previewLayer); previewLayer = null; }
  }
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { previewTimer = null; buildPreview(); }, 260);
  }
  /* Show the top-hat residual over the current view while WAND is armed, so the
     user can see what a click will grab before committing to it. The preview is a
     job like any other: superseded ones are cancelled, so panning stays cheap. */
  async function buildPreview() {
    if (!live || live.kind !== "wand") return;
    if (previewJob) { previewJob.cancel(); previewJob = null; }
    const b = SBMM.map.getBounds();
    const cx = (b.getWest() + b.getEast()) / 2, cy = (b.getSouth() + b.getNorth()) / 2;
    /* cap the previewed window: the opening is the expensive part and a whole-site
       preview would be neither fast nor readable */
    const half = Math.min(700, Math.max(180, (b.getEast() - b.getWest()) / 2));
    let spec;
    try { spec = windowSpec(cx, cy, half); } catch (e) { return; }
    const job = { grid: spec.g, mode: "preview", r: P.wand.r, thresh: P.wand.thresh,
                  smooth: P.wand.smooth, ramp: RESID_RAMP, alpha: 165 };
    const hnd = SBMM.compute.run("wand", job,
      { transfer: [spec.g.z.buffer], label: "Pile-wand preview", silent: true });
    previewJob = hnd;
    let R;
    try { R = await hnd.promise; } catch (e) { return; }
    if (previewJob !== hnd || !live || live.kind !== "wand") return;
    previewJob = null;
    const c = document.createElement("canvas"); c.width = R.W; c.height = R.H;
    c.getContext("2d").putImageData(new ImageData(R.rgba, R.W, R.H), 0, 0);
    if (previewLayer) SBMM.map.removeLayer(previewLayer);
    previewLayer = L.imageOverlay(c.toDataURL("image/png"),
      [[R.by0, R.bx0], [R.by1, R.bx1]], { pane: "analysis", opacity: 0.62, interactive: false });
    previewLayer.addTo(SBMM.map);
  }

  /* ------------------------------------------------------------------ */
  /* feature helpers                                                     */
  /* ------------------------------------------------------------------ */
  function ptsFrom(coords, n, keepClosed) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [coords[i * 2], coords[i * 2 + 1]];
    /* a marching-squares ring repeats its first vertex; a polygon feature must
       not — but a LINE built from a closed chain must keep it, or it loses its
       closing segment and is one segment shorter than the kernel measured */
    if (out.length > 3 && !keepClosed) {
      const a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
    }
    return out;
  }
  function makeArea(pts, name, group, note) {
    const f = SBMM.tools.newFeature("area", pts, name, group ? { group } : null);
    f.card = SBMM.results.card(f, f.name, []);
    SBMM.tools.recompute(f, false);
    if (note) SBMM.results.appendNote(f.card, note);
    SBMM.undo.push("smart boundary “" + name + "”", () => SBMM.store.remove(f), () => SBMM.store.readd(f));
    return f;
  }
  function makeLine(pts, name, group, note) {
    const f = SBMM.tools.newFeature("line", pts, name, group ? { group } : null);
    f.card = SBMM.results.card(f, f.name, []);
    SBMM.tools.recompute(f, false);
    if (note) SBMM.results.appendNote(f.card, note);
    SBMM.undo.push("smart boundary “" + name + "”", () => SBMM.store.remove(f), () => SBMM.store.readd(f));
    return f;
  }

  /* ================================================================== */
  /* 1. PILE WAND                                                        */
  /* ================================================================== */
  const WAND_NOTE =
    "Method: morphological top-hat — the DEM is opened with a disc of the stated " +
    "radius to build a base surface, and the footprint is the closed contour of the " +
    "residual at the stated threshold, with rim faces steeper than the slope cutoff " +
    "excluded. That is the delineation method the ABP technical memo used for the " +
    "waste-rock piles, run here on the lidar terrain rather than the contour-derived " +
    "surface the memo had. Planning-level: check the outline against the imagery and " +
    "edit the vertices where the terrain is ambiguous.";

  function cmdWand() {
    SBMM.tools.setTool(null);
    disarm(true);
    live = { kind: "wand" };
    live.card = optionsCard("Pile wand", "Click a mound. The wash shows the top-hat residual — what a click will capture.", [
      { key: "r", label: "opening radius", value: P.wand.r, step: 5, min: 5, unit: "ft" },
      { key: "thresh", label: "residual threshold", value: P.wand.thresh, step: 0.05, min: 0.05, unit: "ft" },
      { key: "smooth", label: "pre-smooth", value: P.wand.smooth, step: 1, min: 0, unit: "ft" },
      { key: "slopeCut", label: "rim slope cutoff", value: P.wand.slopeCut, step: 0.05, min: 0, unit: "rise/run" },
      { key: "win", label: "search window", value: P.wand.win, step: 20, min: 100, unit: "ft" }
    ], (k, v) => { if (v != null) { P.wand[k] = v; schedulePreview(); } });
    SBMM.map.on("moveend", schedulePreview);
    schedulePreview();
    toast("WAND — click a mound to delineate it");
    rearm("wand", "PILE WAND — click on a mound", runWand);
  }

  async function runWand(x, y) {
    const spec = windowSpec(x, y, P.wand.win);
    const job = { grid: spec.g, mode: "wand", r: P.wand.r, thresh: P.wand.thresh,
                  smooth: P.wand.smooth, slopeCut: P.wand.slopeCut, cx: x, cy: y, tol: 1.0 };
    const R = await SBMM.compute.run("wand", job,
      { transfer: [spec.g.z.buffer], label: "Pile wand — delineating" }).promise;
    const pts = ptsFrom(R.coords, R.nPts);
    if (pts.length < 3) throw new Error("the traced boundary was too small to use");
    const name = SBMM.tools.nextName("Pile boundary");
    const f = makeArea(pts, name, "Smart boundaries", WAND_NOTE);
    const A = polyArea(pts);
    SBMM.results.setRows(f.card, [
      ["Area", fmt(A / 43560, 3) + " ac"],
      ["", fmt0(A) + " ft²"],
      ["Peak above base", fmt(R.peak, 1) + " ft"],
      ["Boundary", R.nPts + " vertices · " + fmt(polyPerimeter(pts), 0) + " ft"],
      ["Rim on steep ground", fmt(R.steepPct, 0) + " %"],
      ["Method", "top-hat r=" + fmt(P.wand.r, 0) + " ft @ " + fmt(P.wand.thresh, 2) + " ft"]
    ]);
    addVolumeOffer(f, "one-click volume (perimeter TIN — the memo base surface)");
    if (R.touchedEdge)
      toast("the mound reaches the edge of the search window — raise “search window” and click again");
    if (R.rings > 1)
      SBMM.results.appendNote(f.card, "The residual formed " + R.rings +
        " separate rings in this window; the one enclosing your click was taken. Where the memo " +
        "split a pile into parts, a single click returns whichever connected part-complex you hit.");
    SBMM.store.select(f.id);
    return f;
  }

  /* the wand's whole point is that a footprint is one step from a quantity */
  function addVolumeOffer(f, label) {
    const row = document.createElement("div"); row.className = "volctl";
    row.innerHTML = `<div class="crow btns"><button class="minib sbvol">${esc(label)}</button></div>`;
    row.querySelector(".sbvol").onclick = () => {
      const v = SBMM.tools.mkVolume(f.pts.map(p => [p[0], p[1]]), f.name + " — volume",
                                    { group: f.group });
      SBMM.store.select(v.id);
      SBMM.tools.zoomTo(v);
      row.remove();
    };
    f.card.appendChild(row);
  }

  /* ================================================================== */
  /* 2. CONTOUR-SNAP BOUNDARY                                            */
  /* ================================================================== */
  function cmdCbound(arg) {
    SBMM.tools.setTool(null);
    disarm(true);
    const typed = arg == null || arg === "" ? null : parseFloat(arg);
    P.cbound.level = (typed != null && !isNaN(typed)) ? typed : null;
    live = { kind: "cbound" };
    live.card = optionsCard("Contour boundary",
      "Click a point: the closed terrain contour through it becomes an area. Leave the elevation blank to use the clicked ground.", [
      { key: "level", label: "elevation", value: P.cbound.level, step: 0.5, unit: "ft", placeholder: "clicked" },
      { key: "smooth", label: "pre-smooth", value: P.cbound.smooth, step: 1, min: 0, unit: "ft" },
      { key: "win", label: "search window", value: P.cbound.win, step: 100, min: 100, unit: "ft" }
    ], (k, v) => { P.cbound[k] = v; });
    toast("CBOUND — click inside the pond or bench to trace");
    rearm("cbound", "CONTOUR BOUNDARY — click a point", runCbound);
  }

  async function runCbound(x, y) {
    const spec = windowSpec(x, y, P.cbound.win);
    const job = { grid: spec.g, cx: x, cy: y,
                  level: (P.cbound.level == null || isNaN(P.cbound.level)) ? null : P.cbound.level,
                  smooth: P.cbound.smooth };
    const R = await SBMM.compute.run("cbound", job,
      { transfer: [spec.g.z.buffer], label: "Contour boundary — tracing" }).promise;
    const pts = ptsFrom(R.coords, R.nPts);
    if (pts.length < 3) throw new Error("the traced contour was too small to use");
    const name = SBMM.tools.nextName("Contour boundary");
    const f = makeArea(pts, name, "Smart boundaries",
      "The closed " + fmt(R.level, 2) + "-ft terrain contour enclosing the clicked point, on the " +
      spec.dem.m.cell + "-ft grid. " + (R.autoLevel
        ? "The level was taken from the clicked ground (" + fmt(R.sampled, 2) + " ft) and nudged up " +
          fmt(R.level - R.sampled, 2) + " ft, because a click sitting exactly on its own contour is " +
          "ambiguous about which side it is on."
        : "The level was typed."));
    const A = polyArea(pts);
    SBMM.results.setRows(f.card, [
      ["Area", fmt(A / 43560, 3) + " ac"],
      ["", fmt0(A) + " ft²"],
      ["Contour level", fmt(R.level, 2) + " ft"],
      ["Boundary", R.nPts + " vertices · " + fmt(polyPerimeter(pts), 0) + " ft"],
      ["Closed rings found", String(R.rings) + (R.openLines ? "  (" + R.openLines + " open)" : "")]
    ]);
    if (!R.enclosing)
      toast("no closed contour encloses that click in this window — took the largest closed ring instead");
    addVolumeOffer(f, "one-click volume");
    SBMM.store.select(f.id);
    return f;
  }

  /* ================================================================== */
  /* 3. TOE / CREST LINE                                                 */
  /* ================================================================== */
  function cmdToe(arg) {
    SBMM.tools.setTool(null);
    disarm(true);
    const typed = arg == null || arg === "" ? NaN : parseFloat(arg);
    if (!isNaN(typed)) P.toe.thresh = typed > 1 ? typed / 100 : typed;
    live = { kind: "toe" };
    live.card = optionsCard("Toe / crest line",
      "Click on a slope: the line where the slope crosses the threshold becomes a line feature.", [
      { key: "mode", label: "label", type: "select", value: P.toe.mode,
        options: [["toe", "toe (bottom of slope)"], ["crest", "crest (top of slope)"]] },
      { key: "thresh", label: "slope threshold", value: P.toe.thresh, step: 0.05, min: 0.01, unit: "rise/run" },
      { key: "smooth", label: "pre-smooth", value: P.toe.smooth, step: 1, min: 0, unit: "ft" },
      { key: "win", label: "search window", value: P.toe.win, step: 20, min: 80, unit: "ft" }
    ], (k, v) => { P.toe[k] = (k === "mode") ? v : v; });
    toast("TOE — click on the slope near the break you want");
    rearm("toe", "TOE / CREST — click on the slope", runToe);
  }

  async function runToe(x, y) {
    const spec = windowSpec(x, y, P.toe.win);
    const job = { grid: spec.g, cx: x, cy: y, thresh: P.toe.thresh, smooth: P.toe.smooth };
    const R = await SBMM.compute.run("toecrest", job,
      { transfer: [spec.g.z.buffer], label: "Toe / crest — tracing" }).promise;
    /* keepClosed: a toe or crest that goes all the way round a pile is a closed
       chain, and the line feature keeps the closing segment (the card's Length
       and the drawn line are then the same number) */
    const pts = ptsFrom(R.coords, R.nPts, true);
    if (pts.length < 2) throw new Error("no usable break line near that click");
    const label = P.toe.mode === "crest" ? "Crest" : "Toe";
    const name = SBMM.tools.nextName(label + " line");
    const f = makeLine(pts, name, "Smart boundaries",
      "The " + (P.toe.thresh * 100).toFixed(0) + "% slope contour nearest the click, measured on the " +
      "terrain smoothed over " + fmt(P.toe.smooth, 0) + " ft. This is a slope-magnitude contour, not a " +
      "hydrologically conditioned break line — it finds where the ground changes steepness, which " +
      "is what a toe or a crest is, but it has no idea which side is uphill. Check it before you use it.");
    SBMM.results.setRows(f.card, [
      /* the feature's own length — the one number the line, the Inspector and
         the card all agree on */
      ["Length", fmt(f.props.length_ft, 0) + " ft"],
      ["Vertices", String(R.nPts)],
      ["Threshold", (P.toe.thresh * 100).toFixed(0) + " % (" + label.toLowerCase() + ")"],
      ["Nearest to click", fmt(R.distFt, 0) + " ft"]
    ]);
    if (R.chains > 1)
      toast("slope crossed the threshold on " + R.chains + " separate chains here — took the one nearest your click");
    SBMM.store.select(f.id);
    return f;
  }

  /* ================================================================== */
  /* 4. CANOPY STANDS                                                    */
  /* ================================================================== */
  async function cmdStands() {
    if (!SBMM.chm && SBMM.chmReady) { toast("waiting for the canopy height model…"); await SBMM.chmReady; }
    if (!SBMM.chm) { toast("the canopy height model is not loaded in this build"); return; }
    SBMM.tools.setTool(null);
    disarm(true);
    live = { kind: "stands" };
    live.card = optionsCard("Canopy stands",
      "Sketch a polygon over the area to clear (double-click to close), or press “whole view”.", [
      { key: "thresh", label: "canopy height ≥", value: P.stands.thresh, step: 1, min: 1, unit: "ft" },
      { key: "minArea", label: "drop stands under", value: P.stands.minArea, step: 100, min: 0, unit: "ft²" },
      { key: "closeR", label: "gap close", value: P.stands.closeR, step: 1, min: 0, unit: "cells" }
    ], (k, v) => { if (v != null) P.stands[k] = v; });
    const btnRow = document.createElement("div"); btnRow.className = "volctl";
    btnRow.innerHTML = `<div class="crow btns"><button class="minib sbview">whole view</button></div>`;
    btnRow.querySelector(".sbview").onclick = () => {
      const b = SBMM.map.getBounds();
      runStands(null, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
        .catch(e => { if (!(e && e.cancelled)) toast(e.message || String(e)); });
    };
    live.card.appendChild(btnRow);
    toast("STANDS — sketch the area, or use “whole view”");
    SBMM.draw.beginPick({
      count: 0, prompts: ["CANOPY STANDS — click the area outline, double-click to close"],
      onMove: (pts, cur) => pts.length ? { rings: [{ pts: pts.concat([cur]), closed: true }], label: "canopy stands area" } : null,
      onDone: pts => {
        if (pts.length < 3) { toast("need at least three points"); return; }
        runStands(pts, null).catch(e => { if (!(e && e.cancelled)) toast(e.message || String(e)); });
      }
    });
  }

  async function runStands(poly, bboxIn) {
    const chm = SBMM.chm;
    if (!chm) throw new Error("no canopy height model in this build");
    let bbox = bboxIn;
    if (poly) {
      const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    /* the CHM only covers the mine-area window; clip rather than fail */
    const m = chm.m;
    const cx0 = Math.max(bbox[0], m.x0), cy0 = Math.max(bbox[1], m.y0);
    const cx1 = Math.min(bbox[2], m.x0 + (m.w - 1) * m.cell), cy1 = Math.min(bbox[3], m.y0 + (m.h - 1) * m.cell);
    if (cx1 <= cx0 || cy1 <= cy0) throw new Error("that area is outside the canopy height model (mine-area window only)");
    const g = SBMM.compute.gridSpec(chm, [cx0, cy0, cx1, cy1], 3);
    if (!g) throw new Error("that area is outside the canopy height model");
    let flat = null;
    if (poly) { flat = new Float64Array(poly.length * 2); poly.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; }); }
    const transfer = [g.z.buffer]; if (flat) transfer.push(flat.buffer);
    const R = await SBMM.compute.run("stands",
      { grid: g, poly: flat, thresh: P.stands.thresh, minArea: P.stands.minArea, closeR: P.stands.closeR },
      { transfer, label: "Canopy stands — polygonising" }).promise;
    if (!R.stands.length) throw new Error("no canopy stand at or above " + P.stands.thresh +
      " ft larger than " + P.stands.minArea + " ft² in that area");
    const group = "Canopy stands";
    SBMM.store.addGroup(group);
    const made = [];
    for (let i = 0; i < R.stands.length; i++) {
      const s = R.stands[i];
      const pts = ptsFrom(s.coords, s.nPts);
      if (pts.length < 3) continue;
      const f = SBMM.tools.newFeature("area", pts, "Stand " + (i + 1), { group });
      f.props = { area_ft2: +s.cellArea.toFixed(0), area_ac: +(s.cellArea / 43560).toFixed(4),
                  ring_area_ft2: +s.ringArea.toFixed(0),
                  canopy_mean_ft: +s.meanH.toFixed(1), canopy_max_ft: +s.maxH.toFixed(1) };
      made.push(f);
    }
    if (!made.length) throw new Error("stands were found but none traced a usable ring");
    const totAc = R.totalArea / 43560;
    const card = SBMM.results.card(null, "Canopy stands", [
      ["Stands", String(made.length)],
      ["Canopy area", fmt(totAc, 2) + " ac"],
      ["", fmt0(R.totalArea) + " ft²"],
      ["Threshold", "≥ " + fmt(P.stands.thresh, 0) + " ft canopy height"],
      ["Dropped as too small", String(R.dropped) + " under " + fmt0(P.stands.minArea) + " ft²"]
    ]);
    SBMM.results.appendNote(card,
      "Clearing limits from the lidar canopy height model. Areas are the CANOPY-CELL area — the " +
      "polygon rings are outer boundaries and enclose internal clearings, so a ring's own area reads " +
      "larger. Stands are ordinary area features in the “Canopy stands” folder: edit, measure " +
      "and export them like any other drawing.");
    SBMM.undo.push(made.length + " canopy stands",
      () => made.forEach(f => SBMM.store.remove(f)),
      () => made.forEach(f => SBMM.store.readd(f)));
    toast(made.length + (made.length === 1 ? " stand — " : " stands — ") + fmt(totAc, 2) +
          " ac of canopy ≥ " + P.stands.thresh + " ft");
    disarm(true);
    return made;
  }

  /* ------------------------------------------------------------------ */
  function wire() {
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && live) disarm(false);
    });
  }

  return { cmdWand, cmdCbound, cmdToe, cmdStands, wire, disarm, armed,
           runWand, runCbound, runToe, runStands, params: P };
})();
