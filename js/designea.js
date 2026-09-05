/* SBMM Site Explorer — EA residential cleanup Final Design overlays.

   Source: EA Engineering, "Appendix A. Engineering Drawings", Final Residential
   Design, September 2025 (100% Plans for Construction), project 1578546.

   Two kinds of content, both read-only project data (they are NOT features in
   SBMM.store — nothing here is user-drawn or editable):

     rasters   one north-up State-Plane-aligned PNG per registered plan sheet.
               Leaflet's imageOverlay cannot rotate and these sheets are drafted
               on a rotated plan grid, so the rotation is baked into the image at
               build time and the stored raster is axis-aligned. Off by default.

     vectors   boundaries lifted from the sheets' own vector linework, plus the
               surveyed polygon nodes printed in each sheet's coordinate table.
               Confidence is carried honestly on every feature:
                 surveyed        exact State Plane values off the printed table
                 area-validated  extracted boundary whose area reproduces the
                                 area the sheet itself prints in square feet
                 unclassified    a real drafted boundary whose meaning could not
                                 be determined from the sheet text or legend */
"use strict";

SBMM.designEA = (function () {

  const COLOR = {
    "area-validated": "#FF6B4A",
    "unclassified": "#E8B34B",
    "surveyed": "#4FD2E8"
  };

  let vecGrp = null, rasterRows = [];

  function data() { return window.SBMM_DATA && SBMM_DATA.design_ea; }

  /* ---------- build ---------- */

  function build() {
    const D = data();
    if (!D || !D.features) return;

    /* Sheet numbers, once: the per-sheet drape rows are built LAST (below) so
       the curated design layers come first in the tree — see buildSheetRows. */
    const sheets = Object.keys(D.sheets || {}).sort();


    /* ----- vector boundaries ----- */
    vecGrp = L.layerGroup();
    let nPoly = 0, nPt = 0, nSup = 0;
    for (const f of D.features) {
      const p = f.properties || {}, g = f.geometry || {};
      const col = COLOR[p.confidence] || "#ccc";
      if (g.type === "Point") {
        const mk = L.circleMarker([g.coordinates[1], g.coordinates[0]],
          { pane: "vectors", radius: 3.2, color: "#0D1215", weight: 1,
            fillColor: col, fillOpacity: .95 })
          .bindTooltip(`${esc(p.name)} · surveyed node`, { sticky: true, className: "ctip" })
          .addTo(vecGrp);
        mk.bindPopup(popupPoint(p, g));
        nPt++;
      } else if (g.type === "Polygon") {
        const rings = g.coordinates.map(r => r.map(q => [q[1], q[0]]));
        const poly = L.polygon(rings, {
          pane: "vectors", color: col, weight: p.confidence === "unclassified" ? 1.4 : 2.2,
          dashArray: p.confidence === "unclassified" ? "4 3" : null,
          fillColor: col, fillOpacity: .10
        }).bindTooltip(tip(p), { sticky: true, className: "ctip" }).addTo(vecGrp);
        poly._ea = { ring: g.coordinates[0], props: p };
        poly.on("click", () => poly.bindPopup(popupPoly(poly)).openPopup());
        nPoly++;
        if (p.superseded_by) nSup++;
      }
    }
    SBMM.designEA.counts = { polygons: nPoly, points: nPt, sheets: sheets.length,
                             superseded: nSup };
    /* Off by default since v8. EA's native geometry (js/designgis.js) covers the
       same ground exactly, so leaving both on draws every excavation limit twice
       — once right and once approximately. The extraction stays available
       because it is the record of how the sheets were registered, and because
       the surveyed node tables are still the only printed coordinates in the
       app. */
    const row = SBMM.addLayerRow("design",
      `PDF-extracted boundaries (${nPoly} areas, ${nPt} nodes)`, vecGrp,
      { id: "pdf_boundaries", checked: false, swatch: COLOR["area-validated"] });
    row.row.title = nSup
      ? `Boundaries traced from the plan sheets and placed by per-sheet registration. `
        + `${nSup} of ${nPoly} are superseded by EA's native geometry, which is shown above; `
        + `the rest have no native counterpart. Kept as the record of the registration.`
      : `Boundaries traced from the plan sheets and placed by per-sheet registration.`;
    SBMM.layers.designVec = vecGrp;

    buildFootprints(D, sheets);

    /* The per-sheet drape rows go LAST (planner ruling D2b). The design group
       is read top-down as "what is the remedy here" — the limits of excavation,
       the daylight lines, the grading, the repository, the haul route, EA's
       annotation and the recovered design surfaces — and twenty rows of "C-103
       · Lot 13" pushed all of that below the fold. Sheets are a way of LOOKING
       at the design, not a layer of it, so they sit under their own sub-header
       at the bottom, next to the 3D drape master switch that governs them. */
    buildSheetRows(D, sheets);
  }

  /* One raster overlay row per registered sheet, under a "Sheets (draped)"
     sub-header, followed by the master switch for the 3D drapes. */
  const SHEET_SUB = "Sheets (draped)";
  function buildSheetRows(D, sheets) {
    /* ----- raster sheet overlays ----- */
    for (const nm of sheets) {
      const s = D.sheets[nm], r = s.raster;
      if (!r) continue;
      const url = SBMM_DATA["design_" + nm.replace("-", "") + "_png"];
      if (!url) continue;
      const img = L.imageOverlay(url, [[r.y0, r.x0], [r.y1, r.x1]],
        { pane: "raster", opacity: .85, zIndex: 6 });
      /* A visible sheet is a click target for the full-sheet viewer. The
         rectangle carries the click rather than the image overlay because
         Leaflet image overlays are not interactive and, more to the point, a
         thin outline that appears on hover is the only honest way to say "there
         is something to click here" before the pointer is over it.

         It has to live in the *vectors* pane, not a pane of its own. The map
         runs preferCanvas, and a canvas renderer is one opaque <canvas> per
         pane: whichever pane is on top swallows the DOM click, so a rectangle
         in a lower pane is never hit-tested at all. Sharing the vectors canvas
         puts it in the same hit test as everything else — and bringToBack()
         then makes it the lowest-priority target there, so a design boundary,
         a sample point or a drawing inside the footprint still wins the click.
         Only empty ground opens the sheet. */
      const hit = L.rectangle([[r.y0, r.x0], [r.y1, r.x1]], {
        pane: "vectors",
        color: "#FFD34D", weight: 0, opacity: 0,
        fill: true, fillOpacity: 0.001, fillColor: "#FFD34D",
        /* v16: this rectangle belongs at the BACK of the vectors canvas, and it
           says so, because the layer tree's drag-to-reorder brings a row's
           geometry to the front and would otherwise hand this invisible
           rectangle every click inside the footprint. */
        sbmmBack: true
      });
      hit.on("add", () => hit.bringToBack());
      hit.bindTooltip(`${nm} — open the full sheet`, { sticky: true, className: "ctip" });
      /* setStyle works on the canvas renderer; a CSS `className` does not reach
         anything (there is no DOM node for a canvas-drawn vector), so the
         "there is something to click here" cursor is set on the map container. */
      hit.on("mouseover", () => {
        hit.setStyle({ weight: 1.6, opacity: .85, fillOpacity: .05 });
        if (!(SBMM.tools && SBMM.tools.active())) SBMM.map.getContainer().style.cursor = "zoom-in";
      });
      hit.on("mouseout", () => {
        hit.setStyle({ weight: 0, opacity: 0, fillOpacity: 0.001 });
        SBMM.map.getContainer().style.cursor = "";
      });
      hit.on("click", e => {
        if (SBMM.tools && SBMM.tools.active()) return;   // a tool is armed: that click is a vertex
        L.DomEvent.stop(e);
        SBMM.sheets.open(nm, { origin: { x: e.originalEvent.clientX, y: e.originalEvent.clientY } });
      });
      const ov = L.layerGroup([img, hit]);
      /* Label the sheet by what it actually shows, and mark anything that came
         from the 90% Pre-Final set — that design is not the one being built,
         so it must never read as part of the Final package. */
      const subj = s.subject ? ` · ${esc(s.subject)}` : "";
      const pre = s.design_set === "90%" ? ` <span class="warnpill">90%</span>` : "";
      /* The row now also carries an opacity slider, an "open the full sheet"
         button and a 3D drape toggle, so the label has to earn its width: the
         sheet number and what it shows, and nothing else. The raster resolution
         moved into the tooltip, where it was always the more useful place. */
      /* v16: `sub:` declares the sub-group; the tree draws the header. */
      const row = SBMM.addLayerRow("design", `${nm}${subj}${pre}`, ov,
        { checked: false, opacity: .85, sub: SHEET_SUB });
      row.row.title = (s.design_set === "90%"
        ? `${nm} — ${s.subject || ""}. From the 90% Pre-Final Design set (May 2025); absent from the Final set.`
        : `${nm} — ${s.subject || ""}. EA Final Residential Design, September 2025.`)
        + ` Overlay raster ${r.ft_per_px} ft/px.`;
      addOpenButton(row, nm);
      addDrapeButton(row, nm);
      rasterRows.push(row);
    }
    /* Master switch for the draped sheets in 3D. It is a LAYER, not a 3D toolbar
       checkbox (§3): which sheets drape is chosen per sheet on the rows above,
       and this says whether the drapes are shown at all. Defined here, with the
       rows it governs, rather than in js/layers.js where it used to sit above
       them. */
    SBMM.addLayerRow("design", "Sheets draped in 3D", null,
      { id: "sheets3d", checked: true, swatch: "#9FB6C2", sub: SHEET_SUB }).row.title =
      "Show the design sheets you have draped (the \u26f0 button on each sheet row) on the 3D terrain.";
  }

  /* ====================================================================== */
  /* Sheet footprints (planner ruling F1)                                   */
  /* ====================================================================== */
  /* Where each registered plan sheet lands on the ground, as its own layer.

     Before this, the only footprint on the map was the invisible click
     rectangle hidden inside each sheet's overlay group — so a sheet you had
     not switched on had no footprint at all, and the fourteen green boxes that
     LOOKED like sheet extents in the default view were actually EA's CAD
     viewport frames (js/cadnative.js DEFAULT_LAYER_OFF), which is a different
     thing drawn on a different layer for a different reason.

     So: one honest layer, OFF by default, showing the registered plan
     areas with their sheet numbers and a click that opens the drawing. And
     because "which sheet covers this?" is a question you ask exactly while you
     are looking at the Sheets tab, the footprints also appear on their own
     while that tab is open, and the one under the cursor lights up when you
     hover its card — a highlight, not a state change, so leaving the tab puts
     the map back exactly as you left it. */
  let fpGrp = null, fpRow = null, fpAuto = false, fpHot = null;
  const fpByName = new Map();
  const FP_COLOR = "#8FD3E8";

  function buildFootprints(D, sheets) {
    fpGrp = L.layerGroup();
    let n = 0;
    for (const nm of sheets) {
      const s = D.sheets[nm], r = s.raster;
      if (!r) continue;
      const rect = L.rectangle([[r.y0, r.x0], [r.y1, r.x1]], {
        pane: "vectors", color: FP_COLOR, weight: 1.2, opacity: .75,
        dashArray: "6 4", fill: true, fillColor: FP_COLOR, fillOpacity: .04
      });
      rect.bindTooltip(`${nm}${s.subject ? " — " + esc(s.subject) : ""} · click to open the sheet`,
        { sticky: true, className: "ctip" });
      rect.on("click", e => {
        if (SBMM.tools && SBMM.tools.active()) return;   // a tool is armed: that click is a vertex
        L.DomEvent.stop(e);
        SBMM.sheets.open(nm, { origin: { x: e.originalEvent.clientX, y: e.originalEvent.clientY } });
      });
      /* the sheet number, permanently, at the footprint's north-west corner —
         a footprint with no number on it is a rectangle, not a footprint */
      const lbl = L.marker([r.y1, r.x0], {
        pane: "vectors", interactive: false,
        icon: L.divIcon({ className: "fplbl", iconSize: [0, 0],
                          html: `<span>${esc(nm)}</span>` })
      });
      fpGrp.addLayer(rect); fpGrp.addLayer(lbl);
      fpByName.set(nm, rect);
      n++;
    }
    fpRow = SBMM.addLayerRow("design", `Sheet footprints (${n})`, fpGrp,
      { id: "sheet_footprints", checked: false, swatch: FP_COLOR });
    fpRow.row.title = "Where each registered plan sheet lands on the ground. "
      + "Click a footprint to open that drawing. Shown automatically while the "
      + "Sheets tab is open.";
  }

  /* The temporary showing. `SBMM.layerState` stays untouched: this is a view
     the Sheets tab borrows, and the row's own checkbox is still the answer to
     "is this layer on". */
  function autoFootprints(on) {
    if (!fpGrp) return;
    const owned = SBMM.layerState.isOn("design", "sheet_footprints");
    if (on && !owned && !fpAuto) { fpGrp.addTo(SBMM.map); fpAuto = true; }
    else if (!on && fpAuto) { SBMM.map.removeLayer(fpGrp); fpAuto = false; hotFootprint(null); }
  }
  function hotFootprint(nm) {
    if (fpHot && fpByName.has(fpHot))
      fpByName.get(fpHot).setStyle({ weight: 1.2, opacity: .75, fillOpacity: .04 });
    fpHot = null;
    if (!nm || !fpByName.has(nm)) return;
    fpByName.get(nm).setStyle({ weight: 2.6, opacity: 1, fillOpacity: .16 });
    fpHot = nm;
  }

  /* Per-sheet "open" button — the full, uncropped drawing in a floating window.
     The overlay on the map is a crop of the plan area; this is the whole sheet,
     title block and notes included (js/sheets.js). */
  function addOpenButton(row, name) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "minib shopen";
    b.textContent = "⤢";
    b.title = `Open the full ${name} sheet — title block, notes and legend included`;
    b.dataset.sheet = name;
    b.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      const r = b.getBoundingClientRect();
      SBMM.sheets.open(name, { origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
    };
    row.row.appendChild(b);
    return b;
  }

  /* Per-sheet "3D" toggle. It is deliberately independent of the row's own 2D
     checkbox: a sheet is often wanted draped in 3D while the 2D map shows the
     ortho underneath it, and vice versa. The button is a plain toggle so it
     does not steal the click from the row's <label>. */
  function addDrapeButton(row, name) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "minib d3d";
    b.textContent = "3D";
    b.title = `Drape ${name} over the terrain in the 3D view`;
    b.setAttribute("aria-pressed", "false");
    b.dataset.sheet = name;
    b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("active", on);
      if (SBMM.viewer3d) SBMM.viewer3d.sheetDrape(name, on);
      if (on && SBMM.viewer3d && !SBMM.viewer3d.isOpen())
        toast(`${name} will appear draped when you open the 3D view`);
    };
    row.row.appendChild(b);
    return b;
  }

  function tip(p) {
    let t = `<b>${esc(p.name)}</b><br><span style="opacity:.75">${esc(p.sheet)}</span>`;
    if (p.area_sf) t += ` · ${fmt0(p.area_sf)} ft²`;
    if (p.confidence === "unclassified") t += `<br><span style="opacity:.7">meaning not determined from the sheet</span>`;
    if (p.superseded_by) t += `<br><span style="opacity:.7">superseded by native geometry</span>`;
    return t;
  }

  function popupPoint(p, g) {
    return `<b>${esc(p.name)}</b><br>
      <span style="opacity:.75">${esc(p.sheet)} · surveyed polygon node</span><br>
      <span style="opacity:.6;font-family:var(--mono);font-size:11px">${fmt0(g.coordinates[0])} E, ${fmt0(g.coordinates[1])} N</span>`;
  }

  function popupPoly(poly) {
    const p = poly._ea.props, ring = poly._ea.ring;
    const A = polyArea(ring);
    let html = `<b>${esc(p.name)}</b><br>
      <span style="opacity:.75">${esc(p.sheet)} — EA Final Design, Sept 2025</span><br>
      ${fmt(A / 43560, 3)} ac · ${fmt0(A)} ft²`;
    if (p.printed_sf) html += `<br><span style="opacity:.7">sheet prints ${fmt0(p.printed_sf)} ft² (${fmt(100 * Math.abs(A - p.printed_sf) / p.printed_sf, 1)}% difference)</span>`;
    if (p.confidence === "unclassified")
      html += `<br><span style="opacity:.7">Meaning not determined from the sheet text or legend.</span>`;
    /* The honest headline on a superseded boundary: EA's own geometry says the
       same thing exactly, and the gap between the two is the independent check
       on this sheet's registration. */
    if (p.superseded_by)
      html += `<br><span class="warntxt">Superseded by “${esc(p.superseded_by)}” in EA's native `
        + `deliverable. That geometry is authoritative; this one was traced from the plot. `
        + `The two agree to ${fmt(p.superseded_off_ft, 2)} ft.</span>`;
    html += `<div class="pop-actions"><span class="minib" onclick="SBMM.designEA.volumeOf('${esc(p.name)}')">measure volume vs. perimeter TIN</span></div>`;
    return html;
  }

  /* volume reuses the existing perimeter-TIN engine, exactly like DUs/piles */
  function volumeOf(name) {
    const D = data();
    if (!D) return;
    const f = D.features.find(f => f.properties && f.properties.name === name
      && f.geometry.type === "Polygon");
    if (!f) { toast("design boundary not found"); return; }
    SBMM.tools.volumeOfRingPts(f.geometry.coordinates[0], name);
  }

  /* ---------- 3D ---------- */
  function rings3d() {
    const D = data();
    if (!D) return [];
    const out = [];
    for (const f of D.features) {
      if (f.geometry.type !== "Polygon") continue;
      out.push({ ring: f.geometry.coordinates[0], conf: f.properties.confidence });
    }
    return out;
  }

  /* ---------- osnap ---------- */
  function snapPaths() {
    const D = data();
    if (!D) return { rings: [], pts: [] };
    const rings = [], pts = [];
    for (const f of D.features) {
      if (f.geometry.type === "Polygon") rings.push(f.geometry.coordinates[0]);
      else if (f.geometry.type === "Point") pts.push(f.geometry.coordinates);
    }
    return { rings, pts };
  }

  function provenance() {
    const D = data();
    if (!D) return null;
    return { source: D.source, crs: D.crs, registration: D.registration,
             sheets: D.sheets };
  }

  return { build, volumeOf, rings3d, snapPaths, provenance, counts: null,
           autoFootprints, hotFootprint };
})();
