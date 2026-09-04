/* SBMM Site Explorer — EA's design surfaces as first-class surface features (§5).

   Agent A recovered four rasterised surfaces from the delivered CAD (see
   `data/design/surfaces.json` and the Surfaces section of CLAUDE.md) and
   `SBMM.CadNative.surfaceElev(id, x, y)` reads them. This module is what makes
   them USABLE: each one is wrapped as a read-only feature of type `surface`
   with `props.ref = true`, so every consumer that already knows how to work
   with a user-drawn pad — the volume engine's design base, cross-sections, the
   3D drape, the Inspector — works with EA's surfaces without a special case.

   Read-only means exactly three things:
     * not deletable and not editable (locked, and the Inspector says why);
     * NOT serialised into a session file — they ship with the app, so a stale
       copy inside somebody's saved session must never win (the same rule the
       baked datasets follow);
     * re-created on boot, so a session saved with a volume measured against
       `res_excbottom` still finds that surface when it is opened.

   The elevation function is `SBMM.CadNative.surfaceElev`, which decodes lazily:
   the first call for a surface returns NaN and kicks the decode off. Anything
   here that needs a number on the first try awaits `surfaceReady(id)` and shows
   a spinner until it lands.

   `repo_fg` and `nlobe_fg` were searched for exhaustively and are not in the
   delivered files. They are listed greyed, with the reason and the remedy, so
   the absence is a visible finding rather than a silent gap. */
"use strict";

SBMM.refSurf = (function () {

  const KIND_BADGE = { existing: "existing", proposed: "proposed", derived: "derived" };
  const byId = {};                 // surface id -> store feature
  let built = false;

  function manifest() {
    try { return (SBMM.CadNative && SBMM.CadNative.surfaces) || []; }
    catch (e) { return []; }
  }
  function notRecovered() {
    try { return (SBMM.CadNative && SBMM.CadNative.notRecovered) || []; }
    catch (e) { return []; }
  }

  /* ------------------------------------------------------------------ */
  /* the features                                                        */
  /* ------------------------------------------------------------------ */
  /* A reference surface's geometry is its footprint; its elevation function is
     the raster. `_surf` (the Float32 node grid a user pad carries) is
     deliberately absent — js/design.js elev() and gridSpecFor() take a
     raster-backed path for these instead, so 11 MB of PNG never has to be
     re-expanded into a second copy on the JS heap. */
  function footprintOf(m) {
    if (m.footprint && m.footprint.length >= 3) return m.footprint.map(p => p.slice());
    const r = m.raster || {};
    const x1 = r.x0 + (r.w || 0) * (r.step || 1), y1 = r.y0 + (r.h || 0) * (r.step || 1);
    return [[r.x0, r.y0], [x1, r.y0], [x1, y1], [r.x0, y1]];
  }

  function build() {
    if (built) return;
    const list = manifest();
    if (!list.length) { built = true; renderList(); return; }
    /* one emit and one autosave for the whole set, not eight (see SBMM.store.batch) */
    SBMM.store.batch(() => {
    for (const m of list) {
      const f = SBMM.tools.newFeature("surface", footprintOf(m), m.label || m.id, {
        style: { color: colorFor(m), weight: 1.6 }, locked: true, visible: false
      });
      Object.assign(f.props, {
        ref: true, refId: m.id, kind: "reference", surface_kind: m.kind,
        method: m.method, confidence: m.confidence,
        source_files: (m.source_files || []).join(", "),
        drape3d: false, showContours: false,
        design_zmin_ft: m.raster ? +m.raster.zmin.toFixed(2) : null,
        design_zmax_ft: m.raster && m.raster.zmax != null ? +m.raster.zmax.toFixed(2) : null,
        cut_yd3: m.volumes_vs_lidar_yd3 ? m.volumes_vs_lidar_yd3.cut : null,
        fill_yd3: m.volumes_vs_lidar_yd3 ? m.volumes_vs_lidar_yd3.fill : null,
        net_yd3: m.volumes_vs_lidar_yd3 ? m.volumes_vs_lidar_yd3.net : null
      });
      f.card = null;                       // reference data does not open a result card
      byId[m.id] = f;
      /* off in 2D by default (§4): they are analysis inputs, not map furniture */
      SBMM.store.setVisible(f, false);
    }
    });
    built = true;
    SBMM.tools.refreshBaseSelects();
    renderList();
  }

  function colorFor(m) {
    return m.kind === "existing" ? "#7FD4A8" : m.kind === "proposed" ? "#FF6B4A" : "#4FD8E6";
  }
  function isRef(f) { return !!(f && f.props && f.props.ref); }
  function featureOf(id) { return byId[id] || null; }
  function all() { return Object.values(byId); }

  /* Elevation, through the one decoder. Synchronous by contract (every caller
     is inside a hot loop), NaN until the lazy decode lands. */
  function elev(f, x, y) {
    const id = f && f.props && f.props.refId;
    if (!id) return NaN;
    return SBMM.CadNative.surfaceElev(id, x, y);
  }
  /* Await this before anything that must be right on the first try. */
  function ready(f) {
    const id = typeof f === "string" ? f : (f && f.props && f.props.refId);
    if (!id) return Promise.resolve(null);
    return SBMM.CadNative.surfaceReady(id);
  }
  function isReady(f) {
    const id = typeof f === "string" ? f : (f && f.props && f.props.refId);
    if (!id) return false;
    /* surfaceElev returns NaN before the decode; a point at the raster centre
       is the cheapest honest probe */
    const m = SBMM.CadNative.surfaceMeta(id);
    if (!m || !m.raster) return false;
    const r = m.raster;
    const v = SBMM.CadNative.surfaceElev(id, r.x0 + r.w / 2, r.y0 + r.h / 2);
    return !isNaN(v);
  }

  /* A transferable raster window for a worker job, in the shape js/compute.js
     designGrid consumers expect ({x0, y0, cell, nx, ny, z}). Built over the
     requested bbox only, so a job over one lot does not ship 13 megapixels. */
  function gridSpec(f, bbox) {
    const id = f && f.props && f.props.refId;
    if (!id) return null;
    const m = SBMM.CadNative.surfaceMeta(id);
    if (!m || !m.raster) return null;
    const r = m.raster;
    const cell = r.step || 1;
    let x0 = r.x0, y0 = r.y0, nx = r.w, ny = r.h;
    if (bbox) {
      const i0 = Math.max(0, Math.floor((bbox[0] - r.x0) / cell) - 1);
      const j0 = Math.max(0, Math.floor((bbox[1] - r.y0) / cell) - 1);
      const i1 = Math.min(r.w - 1, Math.ceil((bbox[2] - r.x0) / cell) + 1);
      const j1 = Math.min(r.h - 1, Math.ceil((bbox[3] - r.y0) / cell) + 1);
      if (i1 < i0 || j1 < j0) return null;
      x0 = r.x0 + i0 * cell; y0 = r.y0 + j0 * cell;
      nx = i1 - i0 + 1; ny = j1 - j0 + 1;
    }
    const z = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      z[j * nx + i] = SBMM.CadNative.surfaceElev(id, x0 + i * cell, y0 + j * cell);
    /* the raster's own vertical quantisation, so the isopach kernel knows how
       small a difference is below this surface's ability to express one (F9) */
    return { x0, y0, cell, nx, ny, z, zstep: r.zstep || 0 };
  }

  /* ------------------------------------------------------------------ */
  /* the list in the Layers tab                                          */
  /* ------------------------------------------------------------------ */
  function badge(m) {
    const conf = m.confidence || "";
    return `<span class="sbadge k-${esc(m.kind)}">${esc(KIND_BADGE[m.kind] || m.kind)}</span>`
      + (conf ? `<span class="sbadge c-${esc(conf)}" title="Confidence in the recovery / derivation">${esc(conf)}</span>` : "");
  }

  function renderList() {
    const host = document.getElementById("refSurfList");
    if (!host) return;
    const list = manifest();
    const nr = notRecovered();
    if (!list.length && !nr.length) {
      host.innerHTML = `<div class="surfnone mut">${SBMM.isField && SBMM.isField()
        ? "EA's design surfaces are not in the field build — the isopach and the design-base volumes need the full build."
        : "No EA design surfaces in this build."}</div>`;
      return;
    }
    host.innerHTML = list.map(m => {
      const f = byId[m.id];
      const on = f && f.visible !== false;
      return `<div class="refrow" data-sid="${esc(m.id)}" title="${esc(m.method || "")}">
        <span class="sw" style="background:${colorFor(m)}"></span>
        <span class="sinfo"><b>${esc(m.label || m.id)}</b>
          <i>${badge(m)}<span class="mono">${m.raster ? fmt0(m.raster.w * m.raster.h / 1e6) + " Mpx · " + (m.raster.step || 1) + " ft" : ""}</span></i></span>
        <span class="sacts">
          <button class="ftb rseye" title="Show the footprint on the map">${on ? "●" : "◌"}</button>
          <button class="ftb rsuse" title="Use as the design base for a new volume">vol</button>
          <button class="ftb rsiso" title="Isopach — cut/fill heat map against the lidar ground">iso</button>
        </span></div>`;
    }).join("") + nr.map(n => `
      <div class="refrow gone" title="${esc(n.why || "")}">
        <span class="sw" style="background:#3A4C58"></span>
        <span class="sinfo"><b>${esc(n.label || n.id)}</b>
          <i><span class="sbadge k-none">not recovered</span><span class="mut">${esc(n.remedy || "")}</span></i></span>
      </div>`).join("");

    host.querySelectorAll(".refrow[data-sid]").forEach(row => {
      const id = row.dataset.sid, f = byId[id];
      row.querySelector(".rseye").onclick = e => {
        e.stopPropagation();
        SBMM.store.setVisible(f, f.visible === false);
        renderList();
      };
      row.querySelector(".rsuse").onclick = e => { e.stopPropagation(); volumeAgainst(id); };
      row.querySelector(".rsiso").onclick = e => { e.stopPropagation(); SBMM.isopach.show(id); };
      row.onclick = e => { if (!e.target.closest(".ftb")) SBMM.store.select(f.id); };
    });
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                             */
  /* ------------------------------------------------------------------ */
  /* "use as design": a volume footprint over the surface's own footprint,
     measured against it. Waits for the decode, because a volume computed while
     surfaceElev still returns NaN is a zero, and a confident zero is worse than
     a spinner. */
  async function volumeAgainst(id, ringIn, nameIn) {
    const f = byId[id];
    if (!f) { toast("that design surface is not in this build"); return null; }
    if (!isReady(id)) toast("decoding " + (f.name || id) + " — one moment…", 12000);
    await ready(id);
    const ring = ringIn || f.pts.map(p => p.slice());
    const v = SBMM.tools.mkVolume(ring, (nameIn || f.name) + " — vs design");
    v.props.baseMode = "design"; v.props.designId = f.id;
    const sel = v.card && v.card.querySelector(".vbase");
    if (sel) sel.value = "design:" + f.id;
    SBMM.tools.compVolume(v);
    SBMM.store.select(v.id);
    SBMM.shell.showResults();
    return v;
  }

  function wire() {
    SBMM.store.onChange(() => renderList());
    SBMM.store.onSelect(() => renderList());
    renderList();
  }

  return { build, wire, renderList, elev, ready, isReady, gridSpec, isRef,
           featureOf, all, volumeAgainst, manifest, notRecovered, colorFor };
})();
