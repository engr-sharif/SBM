/* SBMM Site Explorer — isopach overlay and volume-vs-surface (§5).

   Three things live here, all of them the same question asked at three scales:

     * **Isopach** — the cut/fill thickness of a design surface against the
       January-2024 lidar ground, as a heat map: blue where the design is above
       the ground (fill), red where it is below (cut), legend in feet. Drawn as
       a canvas overlay in 2D and draped on the terrain in 3D.
     * **Volume in polygon vs surface** — the same integral, restricted to any
       polygon the user picks or draws.
     * **Volume of this excavation** — the Inspector action on an EA limit of
       excavation, showing `area x depth` and the raster method side by side,
       because those are two independent answers to the same question and a
       crew is entitled to see that they agree.

   Sign convention throughout: design minus ground. Positive is FILL, negative
   is CUT — the same way round as an earthworks drawing, and the same way round
   as the legend, so the number under the cursor never has to be re-interpreted.

   The integral runs in a worker (`isopach` in js/compute.js) over the design
   raster, not over a re-derivation of it: the raster IS the surface, and
   integrating anything else would mean two definitions of the design. */
"use strict";

SBMM.isopach = (function () {

  /* blue (fill) → transparent (no change) → red (cut) */
  const RAMP_FILL = [79, 140, 230];
  const RAMP_CUT = [228, 90, 74];

  let current = null;          // { id, layer, legend, stats }
  let drape3d = null;          // { url, bounds } handed to js/viewer3d.js

  /* ------------------------------------------------------------------ */
  /* the surface list every entry point needs                            */
  /* ------------------------------------------------------------------ */
  function surfaces() {
    const out = [];
    for (const m of SBMM.refSurf.manifest()) {
      const f = SBMM.refSurf.featureOf(m.id);
      if (f) out.push({ id: f.id, name: m.label || m.id, ref: m.id, kind: m.kind });
    }
    for (const f of SBMM.design.list())
      if (!(f.props && f.props.ref)) out.push({ id: f.id, name: f.name, ref: null, kind: f.props.kind });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* isopach                                                             */
  /* ------------------------------------------------------------------ */
  async function show(refOrFeatureId, opts) {
    opts = opts || {};
    const f = resolve(refOrFeatureId);
    if (!f) { toast("pick a design surface for the isopach"); return null; }
    clear();

    if (f.props.ref && !SBMM.refSurf.isReady(f)) {
      toast("decoding " + f.name + " — the isopach follows in a moment…", 12000);
      await SBMM.refSurf.ready(f);
    }
    const bbox = bboxOf(opts.ring || f.pts);
    const dgrid = SBMM.design.gridSpecFor(f, bbox);
    if (!dgrid) { toast("that surface has no raster to compare"); return null; }

    const grids = SBMM.compute.gridsFor([dgrid.x0, dgrid.y0,
      dgrid.x0 + dgrid.nx * dgrid.cell, dgrid.y0 + dgrid.ny * dgrid.cell]);
    const transfer = [dgrid.z.buffer, ...grids.map(g => g.z.buffer)];
    let poly = null, nPoly = 0;
    if (opts.ring && opts.ring.length > 2) {
      poly = new Float64Array(opts.ring.length * 2);
      opts.ring.forEach((p, i) => { poly[i * 2] = p[0]; poly[i * 2 + 1] = p[1]; });
      nPoly = opts.ring.length;
      transfer.push(poly.buffer);
    }

    let R;
    try {
      R = await SBMM.compute.run("isopach",
        { dgrid, grids, poly, nPoly, ...quant(dgrid) },
        { transfer, label: "Isopach — " + f.name }).promise;
    } catch (e) {
      if (e && e.cancelled) return null;
      toast("isopach failed: " + e.message);
      return null;
    }
    if (!R.n) { toast("no ground under that surface to compare against"); return null; }

    const url = paint(R);
    const bounds = [[R.y0, R.x0], [R.y0 + R.ny * R.cell, R.x0 + R.nx * R.cell]];
    const layer = L.imageOverlay(url, bounds, { pane: "analysis", opacity: .78 }).addTo(SBMM.map);
    drape3d = { url, bounds: [R.x0, R.y0, R.x0 + R.nx * R.cell, R.y0 + R.ny * R.cell] };
    current = { fid: f.id, name: f.name, layer, stats: R };
    if (SBMM.viewer3d.refreshIsopach) SBMM.viewer3d.refreshIsopach();

    card(f, R, opts);
    return R;
  }

  function resolve(id) {
    if (!id) return null;
    const byRef = SBMM.refSurf.featureOf(id);
    if (byRef) return byRef;
    const f = SBMM.store.byId(id);
    return f && f.type === "surface" ? f : null;
  }
  function bboxOf(pts) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /* The two vertical quantisation steps the kernel needs to know how small a
     difference is meaningless (F9). Both surfaces are terrain-RGB PNGs; the
     design carries its own step in the manifest and the DEMs carry theirs in
     their meta. A user pad has no raster and so no quantisation of its own. */
  function quant(dgrid) {
    /* the coarsest quantisation in the DEM stack — the tolerance has to clear
       whichever grid actually answers, and they need not share a step */
    const zg = SBMM.dems.reduce((mx, d) => Math.max(mx, (d.m && d.m.step) || 0), 0);
    return { zstepDesign: (dgrid && dgrid.zstep) || 0, zstepGround: zg };
  }

  /* The heat map itself. Scaled symmetrically about zero so blue and red mean
     the same magnitude — an asymmetric stretch on a cut/fill map reads as a
     design that is mostly fill when it is mostly nothing. */
  function paint(R) {
    const M = Math.max(Math.abs(R.lo), Math.abs(R.hi), 0.25);
    const c = document.createElement("canvas");
    c.width = R.nx; c.height = R.ny;
    const g = c.getContext("2d");
    const img = g.createImageData(R.nx, R.ny), px = img.data;
    for (let j = 0; j < R.ny; j++) for (let i = 0; i < R.nx; i++) {
      const v = R.dz[j * R.nx + i];
      const k = ((R.ny - 1 - j) * R.nx + i) * 4;     // canvas row 0 is north
      if (isNaN(v)) { px[k + 3] = 0; continue; }
      const t = Math.min(1, Math.abs(v) / M);
      const col = v >= 0 ? RAMP_FILL : RAMP_CUT;
      /* fade to transparent at zero: the interesting thing about an isopach is
         where the design departs from the ground, not where it agrees */
      px[k] = col[0]; px[k + 1] = col[1]; px[k + 2] = col[2];
      px[k + 3] = Math.round(28 + 210 * t);
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }

  /* the extent of the change, in the coordinates the user works in */
  function changedBoxLine(R) {
    const b = R.changedBox;
    if (!b) return "nothing outside the comparison tolerance";
    return `${fmt0(b[2] - b[0])} × ${fmt0(b[3] - b[1])} ft at `
      + `${fmt0(b[0])}, ${fmt0(b[1])}`;
  }

  function card(f, R, opts) {
    const yd3 = v => v / 27;
    const M = Math.max(Math.abs(R.lo), Math.abs(R.hi), 0.25);
    const el = SBMM.results.card(null, "Isopach — " + f.name, [
      ["Cut (design below ground)", sig2(yd3(R.cut_ft3)) + " yd³"],
      ["Fill (design above ground)", sig2(yd3(R.fill_ft3)) + " yd³"],
      ["Net (fill − cut)", sig2(yd3(R.fill_ft3 - R.cut_ft3)) + " yd³"],
      ["Deepest cut", fmt(Math.max(0, -R.lo), 2) + " ft"],
      ["Deepest fill", fmt(Math.max(0, R.hi), 2) + " ft"],
      /* The two areas are different questions and were being answered with one
         number (F9): "compared over 15 ac" is the surface's working extent, of
         which two thirds is buffer where the design IS the ground. What a user
         wants is how much ground actually changes. */
      ["Changed area", fmt(R.nChanged * R.intCell * R.intCell / 43560, 3) + " ac"
        + (opts && opts.ring ? " (inside the polygon)" : "")],
      ["", changedBoxLine(R)],
      ["Compared over", fmt(R.n * R.intCell * R.intCell / 43560, 3) + " ac"
        + " · " + fmt(100 * R.nChanged / Math.max(1, R.n), 0) + " % changed"],
      ["Raster", `integrated at ${R.intCell} ft · ${fmt0(R.n)} cells`
        + (R.cell !== R.intCell ? ` · drawn at ${R.cell} ft` : "")
        + (R.nEdge ? ` · ${fmt0(R.nEdge)} raster-edge cells excluded` : "")]
    ]);
    const leg = document.createElement("div");
    leg.className = "cfleg legend isoleg";
    leg.innerHTML = `<span class="mono">cut ${fmt(Math.max(0, -R.lo), 1)} ft</span>
      <span class="rampbar" style="background:linear-gradient(90deg,
        rgb(${RAMP_CUT.join(",")}), rgba(${RAMP_CUT.join(",")},.1),
        rgba(${RAMP_FILL.join(",")},.1), rgb(${RAMP_FILL.join(",")}))"></span>
      <span class="mono">fill ${fmt(Math.max(0, R.hi), 1)} ft</span>`;
    el.appendChild(leg);
    const row = document.createElement("div");
    row.className = "crow btns";
    row.innerHTML = `<button class="minib isoOff">hide overlay</button>`;
    row.querySelector(".isoOff").onclick = () => { clear(); toast("isopach hidden"); };
    el.appendChild(row);
    SBMM.results.appendNote(el,
      "Design minus the January 2024 lidar ground, integrated at "
      + R.intCell + " ft"
      + (R.cell !== R.intCell ? " and drawn at " + R.cell + " ft" : "")
      + " (\u00b1 " + fmt(M, 1) + " ft full scale). "
      + "A cell counts as unchanged where the difference is smaller than the two "
      + "rasters can express: the 0.02 ft terrain-RGB step of each, plus \u2014 only "
      + "where the ground is the 2-ft site grid rather than the 1-ft mine grid \u2014 "
      + "that grid's own interpolation error on the local slope. Cells on the "
      + "design raster's nodata boundary are excluded. "
      + SBMM.tools.PLANNING_NOTE);
    SBMM.shell.showResults();
  }

  function clear() {
    if (current && current.layer) SBMM.map.removeLayer(current.layer);
    current = null; drape3d = null;
    if (SBMM.viewer3d.refreshIsopach) SBMM.viewer3d.refreshIsopach();
  }
  function active() { return current; }
  function drapeSpec() { return drape3d; }

  /* ------------------------------------------------------------------ */
  /* the picker dialog                                                   */
  /* ------------------------------------------------------------------ */
  function dialog() {
    const list = surfaces();
    if (!list.length) { toast("no design surfaces yet — PAD makes one, or EA's are in the Layers tab"); return; }
    const box = document.createElement("div");
    box.className = "modal"; box.id = "isoDlg";
    box.innerHTML = `<div class="mbox" style="width:440px">
      <div class="mhd">Isopach — cut / fill vs the lidar ground
        <span class="spacer"></span><span class="ic x" id="isoX" title="Close (Esc)">✕</span></div>
      <div class="mbody">
        <p class="mut">Blue where the design stands above the ground (fill), red where it is
        below (cut). Computed from the surface's own raster.</p>
        <div class="prow"><span>Surface</span>
          <select id="isoSel">${list.map(s =>
            `<option value="${esc(s.id)}">${esc(s.name)} — ${esc(s.kind || "")}</option>`).join("")}</select></div>
        <div class="prow"><span>Restrict to</span>
          <select id="isoClip">
            <option value="">the whole surface</option>
            <option value="sel">the selected polygon</option>
          </select></div>
      </div>
      <div class="mfoot"><span class="spacer"></span>
        <button class="minib" id="isoCancel">Cancel</button>
        <button class="minib prim" id="isoGo">Show isopach</button></div></div>`;
    document.body.appendChild(box);
    const shut = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(); } };
    document.addEventListener("keydown", onKey, true);
    box.querySelector("#isoX").onclick = shut;
    box.querySelector("#isoCancel").onclick = shut;
    box.addEventListener("click", e => { if (e.target === box) shut(); });
    box.querySelector("#isoGo").onclick = () => {
      const id = box.querySelector("#isoSel").value;
      const clip = box.querySelector("#isoClip").value;
      let ring = null;
      if (clip === "sel") {
        const s = SBMM.store.selectedFeature();
        if (!s || !s.pts || s.pts.length < 3) { toast("select a polygon first, or choose the whole surface"); return; }
        ring = s.pts.map(p => p.slice());
      }
      shut();
      show(id, { ring });
    };
  }

  /* ------------------------------------------------------------------ */
  /* volume in a polygon vs a surface                                    */
  /* ------------------------------------------------------------------ */
  /* This is the existing perimeter-TIN volume engine with its base set to a
     design surface — the same code path, the same numbers, the same card. What
     is new is only that ANY polygon can be pointed at ANY surface without
     going through the volume card's dropdown. */
  function volumeVsSurface(ringIn, nameIn) {
    const list = surfaces();
    if (!list.length) { toast("no design surfaces to measure against"); return; }
    let ring = ringIn, name = nameIn;
    if (!ring) {
      const s = SBMM.store.selectedFeature();
      if (s && s.pts && s.pts.length > 2) { ring = s.pts.map(p => p.slice()); name = s.name; }
    }
    if (!ring) {
      toast("draw the polygon to measure — double-click to close it");
      SBMM.mode.set("navigate");
      SBMM.draw.beginPick({
        count: 0, minPts: 3, closed: true,
        prompts: ["Volume vs surface — click the polygon, double-click to finish"],
        onMove: (pts, cur) => pts.length
          ? { rings: [{ pts: [...pts, cur], closed: true }], label: "volume vs surface" } : null,
        onDone: pts => { if (pts.length > 2) volumeVsSurface(pts, "Polygon"); }
      });
      return;
    }
    pickSurface("Volume in polygon vs surface", list, id => {
      const f = resolve(id);
      if (!f) return;
      /* a reference surface has to finish decoding before the integral runs;
         a user pad already has its node grid in hand */
      if (f.props && f.props.ref) SBMM.refSurf.volumeAgainst(f.props.refId, ring, name || "Polygon");
      else measureAgainst(f, ring, name);
    });
  }

  /* the non-reference path: a user pad needs no decode wait */
  function measureAgainst(f, ring, name) {
    const v = SBMM.tools.mkVolume(ring, (name || "Polygon") + " — vs " + f.name);
    v.props.baseMode = "design"; v.props.designId = f.id;
    const sel = v.card && v.card.querySelector(".vbase");
    if (sel) sel.value = "design:" + f.id;
    SBMM.tools.compVolume(v);
    SBMM.store.select(v.id);
    SBMM.shell.showResults();
    return v;
  }

  function pickSurface(title, list, cb) {
    const box = document.createElement("div");
    box.className = "modal";
    box.innerHTML = `<div class="mbox" style="width:400px">
      <div class="mhd">${esc(title)}<span class="spacer"></span><span class="ic x" data-x="1">✕</span></div>
      <div class="mbody"><div class="prow"><span>Surface</span>
        <select class="pick">${list.map(s =>
          `<option value="${esc(s.id)}">${esc(s.name)} — ${esc(s.kind || "")}</option>`).join("")}</select></div></div>
      <div class="mfoot"><span class="spacer"></span>
        <button class="minib" data-x="1">Cancel</button>
        <button class="minib prim" data-go="1">Measure</button></div></div>`;
    document.body.appendChild(box);
    const shut = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(); } };
    document.addEventListener("keydown", onKey, true);
    box.addEventListener("click", e => {
      if (e.target === box || e.target.closest("[data-x]")) { shut(); return; }
      if (e.target.closest("[data-go]")) { const v = box.querySelector(".pick").value; shut(); cb(v); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* "volume of this excavation" (§5)                                    */
  /* ------------------------------------------------------------------ */
  /* Two methods, side by side, because they answer the same question from
     different directions and their agreement is the check: area x depth is the
     arithmetic EA's own quantity take-off does, and the raster integral is what
     the excavation-bottom surface actually says. They agreed to 0.05 % over
     the whole design when the surface was built (see surfaces.json); showing
     both per polygon is how a user confirms that for the lot in front of them. */
  async function excavationVolume(props, geom) {
    const ring = geom && geom.type === "Polygon" ? geom.coordinates[0] : null;
    if (!ring) { toast("that feature has no polygon to measure"); return; }
    const depth = props.depth_ft != null ? props.depth_ft : 1.0;
    const area = props.area_sf != null ? props.area_sf : polyArea(ring);
    const analytic = area * depth / 27;

    const el = SBMM.results.card(null, (props.name || "Excavation") + " — volume", [
      ["Area × depth", sig2(analytic) + " yd³"],
      ["", `${fmt0(area)} ft² × ${fmt(depth, 1)} ft`],
      ["Raster method", "computing…"]
    ]);
    SBMM.shell.showResults();

    const f = SBMM.refSurf.featureOf("res_excbottom");
    if (!f) {
      SBMM.results.setRows(el, [
        ["Area × depth", sig2(analytic) + " yd³"],
        ["", `${fmt0(area)} ft² × ${fmt(depth, 1)} ft`],
        ["Raster method", "no excavation-bottom surface in this build"]
      ]);
      return;
    }
    if (!SBMM.refSurf.isReady(f)) await SBMM.refSurf.ready(f);

    const bbox = bboxOf(ring);
    const dgrid = SBMM.design.gridSpecFor(f, bbox);
    const grids = SBMM.compute.gridsFor(bbox);
    const poly = new Float64Array(ring.length * 2);
    ring.forEach((p, i) => { poly[i * 2] = p[0]; poly[i * 2 + 1] = p[1]; });
    let R;
    try {
      R = await SBMM.compute.run("isopach",
        { dgrid, grids, poly, nPoly: ring.length, ...quant(dgrid) },
        { transfer: [dgrid.z.buffer, ...grids.map(g => g.z.buffer), poly.buffer],
          label: "Excavation volume — " + (props.name || "") }).promise;
    } catch (e) {
      if (!(e && e.cancelled)) toast("excavation volume failed: " + e.message);
      return;
    }
    const raster = R.cut_ft3 / 27;
    const diff = analytic ? (raster - analytic) / analytic * 100 : 0;
    SBMM.results.setRows(el, [
      ["Area × depth", sig2(analytic) + " yd³"],
      ["", `${fmt0(area)} ft² × ${fmt(depth, 1)} ft`],
      ["Raster method", sig2(raster) + " yd³"],
      ["", `res_excbottom vs lidar, ${R.cell}-ft cells, ${fmt0(R.n)} compared`],
      ["Agreement", fmt(diff, 2) + " %"]
    ]);
    SBMM.results.appendNote(el,
      "Two independent answers to one question: the arithmetic EA's quantity take-off uses, "
      + "and the integral of the excavation-bottom surface against the lidar ground. "
      + (Math.abs(diff) < 2
         ? "They agree, which is the check."
         : "They disagree by more than 2 % — the polygon may extend beyond the surface's working buffer.")
      + " " + SBMM.tools.PLANNING_NOTE);
  }

  function wire() {
    const b = document.getElementById("isoBtn");
    if (b) b.onclick = e => { e.stopPropagation(); dialog(); };
  }

  return { wire, show, clear, dialog, active, drapeSpec, volumeVsSurface,
           excavationVolume, surfaces };
})();
