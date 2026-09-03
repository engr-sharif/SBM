/* SBMM Site Explorer — EA residential Final Design, NATIVE geometry.

   Source: EA Engineering's own deliverables, June 2026 — the file geodatabase
   SBMM_ResidentialRD.gdb (ArcGIS Pro 3.6.2) and the Final Design CAD set
   (project 1578546), not a plot of them.  This is exact design geometry in real
   State Plane coordinates, so it SUPERSEDES the PDF-derived extraction in
   js/designea.js everywhere the two cover the same ground.  See
   tools/build_design_gis.py for how the payload is made and why no
   reprojection is applied.

   What that means for the two modules:

     designgis.js  (this file)  native geometry, on by default, the authority.
     designea.js               the PDF-derived boundaries and the surveyed node
                               tables, plus every sheet raster and the sheet
                               viewer's registration.  Its boundary layer now
                               defaults OFF and each boundary that has a native
                               counterpart is labelled as superseded — the
                               extraction is kept because it is the record of
                               how the sheets were registered, and because a
                               future sheet set may again arrive without native
                               files.

   Like designea.js this is read-only project data: nothing here is a feature in
   SBMM.store, nothing is editable, and nothing serialises into a session.  It
   is snappable, drapes in 3D, and goes out with the GeoJSON and DXF exports. */
"use strict";

SBMM.designGIS = (function () {

  /* Layer rows are grouped under three sub-headings inside the existing
     "Residential — EA design" section.  The group keys come from the payload. */
  const GROUPS = [
    ["design", "Design areas"],
    ["bound", "Boundaries"],
    ["exist", "Existing conditions"]
  ];

  /* Which layers start visible.  The design areas are the point of the app;
     the reference layers are there when wanted and would otherwise bury the
     ortho under 500 lines of parcel and utility furniture. */
  const ON = { exc: true, repo: true, staging: true, haul: true };

  let groups = {};        // key -> L.layerGroup
  let rows = {};          // key -> row handle
  let byLayer = {};       // key -> [feature]

  function data() { return window.SBMM_DATA && SBMM_DATA.design_gis; }

  /* ---------- build ---------- */

  function build() {
    const D = data();
    if (!D || !D.features || !D.layers) return;

    byLayer = {};
    for (const f of D.features) {
      const k = f.properties && f.properties.layer;
      if (!k) continue;
      (byLayer[k] = byLayer[k] || []).push(f);
    }

    const host = document.getElementById("designLayers");

    for (const [gkey, gname] of GROUPS) {
      const specs = D.layers.filter(l => l.group === gkey);
      if (!specs.length) continue;
      if (host) {
        const h = document.createElement("div");
        h.className = "lsub";
        h.textContent = gname;
        host.appendChild(h);
      }
      for (const spec of specs) buildLayer(spec);
    }

    SBMM.designGIS.counts = Object.fromEntries(
      D.layers.map(l => [l.key, l.count]));
  }

  /* ---------- excavation depth (§4 group 3, planner ruling R1) ----------
     These polygons are THE "Limits of excavation" layer: EA's own geodatabase
     geometry, reproducing the printed areas to 0.02 %. The depth is not on the
     polygon — the residential remedy is depth-based and the depth lives in a
     sheet note ("EXCAVATE WORK AREA TO ONE FOOT DEPTH UNLESS OTHERWISE
     INDICATED") — so it is read back from the design-surface manifest, which is
     where tools/build_cad_surfaces.py recorded the depth it actually used for
     each polygon when it built res_excbottom. One number, one source, and the
     styling here can never disagree with the raster the volumes come from. */
  let depthMap = null;
  function depthOf(p) {
    if (!depthMap) {
      depthMap = {};
      try {
        const m = SBMM.CadNative && SBMM.CadNative.surfaceMeta("res_excbottom");
        for (const d of ((m && m.depth_polygons) || []))
          if (d.area_sf_printed) depthMap[d.name + "|" + d.area_sf_printed] = d.depth_ft;
      } catch (e) { /* no surfaces payload in this build */ }
    }
    const k = (p.name || "") + "|" + (p.area_sf || 0);
    return depthMap[k] != null ? depthMap[k] : 1.0;    // the sheet-note default
  }
  const EXC_1FT = "#FF4A2E", EXC_HALF = "#FFA23E";
  function excStyle(depth) {
    /* §4: 1.0 ft solid red, 0.5 ft dashed orange */
    return depth <= 0.75
      ? { color: EXC_HALF, weight: 2.4, dashArray: "7 4", fillColor: EXC_HALF, fillOpacity: 0.10 }
      : { color: EXC_1FT, weight: 2.6, dashArray: null, fillColor: EXC_1FT, fillOpacity: 0.13 };
  }

  function buildLayer(spec) {
    const feats = byLayer[spec.key] || [];
    if (!feats.length) return;
    const grp = L.layerGroup();
    const col = spec.color || "#ccc";
    const isExc = spec.key === "exc";

    for (const f of feats) {
      const p = f.properties || {}, g = f.geometry || {};
      let lyr = null;
      if (g.type === "Polygon") {
        const rings = g.coordinates.map(r => r.map(q => [q[1], q[0]]));
        if (isExc) {
          const d = depthOf(p);
          p.depth_ft = d;                       // so the popup and the Inspector see it
          lyr = L.polygon(rings, Object.assign({ pane: "vectors" }, excStyle(d)));
          /* The depth label at the polygon centroid — the number a crew digs
             to. Only for polygons big enough to hold it, and only once the map
             is zoomed in far enough for the labels not to pile on top of each
             other: at site zoom fifteen "1.0 ft" boxes across two hundred feet
             of screen is noise, not information (the CSS hides them off a class
             the zoom handler sets). */
          const c = ringCentroid(g.coordinates[0]);
          if (c && polyAreaOf(g.coordinates[0]) > 900) {
            L.marker([c[1], c[0]], {
              pane: "vectors", interactive: false,
              icon: L.divIcon({ className: "excdepth", iconSize: [0, 0],
                html: `<span>${d === 1 ? "1.0" : fmt(d, 1)} ft</span>` })
            }).addTo(grp);
          }
        } else {
          lyr = L.polygon(rings, {
            pane: "vectors", color: col, weight: spec.group === "design" ? 2.2 : 1.3,
            fillColor: col, fillOpacity: spec.group === "design" ? 0.12 : 0.05
          });
        }
      } else if (g.type === "LineString") {
        lyr = L.polyline(g.coordinates.map(q => [q[1], q[0]]), {
          pane: "vectors", color: col, weight: spec.key === "haul" ? 2.6 : 1.8,
          dashArray: spec.key === "daylight" ? "5 3" : null
        });
      } else if (g.type === "Point") {
        lyr = L.circleMarker([g.coordinates[1], g.coordinates[0]], {
          pane: "vectors", radius: 2.8, color: "#0D1215", weight: 1,
          fillColor: col, fillOpacity: 0.95
        });
      }
      if (!lyr) continue;
      lyr.bindTooltip(tip(p), { sticky: true, className: "ctip" });
      lyr._gis = { props: p, geom: g };
      lyr.on("click", () => lyr.bindPopup(popup(p, g)).openPopup());
      lyr.addTo(grp);
    }

    /* the four 0.5-ft call-outs EA drew but never delineated as a region */
    if (isExc) addHalfFootCallouts(grp);

    const on = !!ON[spec.key];
    const row = SBMM.addLayerRow("design", `${esc(spec.name)} (${spec.count})`, grp,
      { id: "gis_" + spec.key, checked: on, swatch: isExc ? EXC_1FT : col });
    row.row.title = `${spec.name} — ${spec.count} features. ${spec.provenance}`
      + (isExc ? " Styled by excavation depth: 1.0 ft solid, 0.5 ft dashed." : "");
    groups[spec.key] = grp;
    rows[spec.key] = row;
  }

  function ringCentroid(ring) {
    if (!ring || !ring.length) return null;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const f = p[0] * q[1] - q[0] * p[1];
      a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
    }
    if (Math.abs(a) < 1e-9) return ring[0].slice();
    return [cx / (3 * a), cy / (3 * a)];
  }
  function polyAreaOf(ring) {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(s) / 2;
  }

  /* ---------- the 6-inch call-outs (planner ruling R1) ----------
     EA's sheets carry four notes asking for 6 inches rather than a foot — by a
     tree drip line, along a fence, near a structure, on a foot path. They are
     leader call-outs pointing at a SPOT, not a delineated region, so
     tools/build_cad_surfaces.py could not apply them to res_excbottom and
     recorded them as `depth_overrides_unapplied`. They still have to be
     visible: someone planning that lot needs to know the note exists.

     Anchoring: the notes survive only as PAPER-SPACE text (sheet + wording;
     model space carries no 0.5-ft entity anywhere in the delivered CAD), so the
     leader tip does not exist in any file we have. The marker therefore sits at
     the centroid of that sheet's own limit-of-excavation polygon and says so.
     If EA ever sends the leaders as geometry, this is the one function to
     change. */
  function addHalfFootCallouts(grp) {
    let ovr = [];
    try {
      const m = SBMM.CadNative && SBMM.CadNative.surfaceMeta("res_excbottom");
      ovr = (m && m.depth_overrides_unapplied) || [];
    } catch (e) { return; }
    if (!ovr.length) return;
    const D = data();
    for (const o of ovr) {
      const host = (D.features || []).find(f => (f.properties || {}).layer === "exc"
        && (f.properties || {}).sheet === o.sheet && f.geometry.type === "Polygon");
      if (!host) continue;
      const c = ringCentroid(host.geometry.coordinates[0]);
      if (!c) continue;
      /* Offset from the centroid, for two reasons: the depth label already
         occupies that exact point, and a sheet with two call-outs (C-111) would
         otherwise stack them. */
      const seen = (addHalfFootCallouts._n = addHalfFootCallouts._n || {});
      const k = o.sheet; const i = (seen[k] = (seen[k] || 0) + 1) - 1;
      const px = c[0] + 34 + i * 30, py = c[1] - 34 - i * 30;
      const mk = L.circleMarker([py, px], {
        pane: "vectors", radius: 5, color: "#12181C", weight: 1.4,
        fillColor: EXC_HALF, fillOpacity: 1
      });
      mk.bindTooltip(`<b>6 in call-out</b> — sheet ${esc(o.sheet)}`
        + `<br><span class="warntxt">region not delineated by EA — verify</span>`,
        { sticky: true, className: "ctip" });
      mk.on("click", () => mk.bindPopup(
        `<b>6 in call-out — sheet ${esc(o.sheet)}</b><br>`
        + `<span style="opacity:.8">${fmt(o.depth_ft, 1)} ft (6 in) instead of the 1 ft default</span>`
        + `<div style="white-space:pre-wrap;margin:5px 0">${esc(o.text)}</div>`
        + `<span class="warntxt">Region not delineated by EA — verify.</span>`
        + `<br><span style="opacity:.65;font-size:11px">A leader call-out points at a spot, `
        + `not an area, so this depth is NOT applied to the excavation-bottom surface. `
        + `The marker sits at the centroid of this sheet's limit of excavation because `
        + `the leader itself survives only as paper-space text.</span>`).openPopup());
      mk.addTo(grp);
      L.marker([py, px], {
        pane: "vectors", interactive: false,
        icon: L.divIcon({ className: "excdepth half", iconSize: [0, 0], html: `<span>6 in</span>` })
      }).addTo(grp);
    }
  }

  function tip(p) {
    let t = `<b>${esc(p.name || "Design feature")}</b>`;
    if (p.sheet) t += `<br><span style="opacity:.75">${esc(p.sheet)}</span>`;
    if (p.area_sf) t += ` · ${fmt0(p.area_sf)} ft²`;
    if (p.length_ft) t += ` · ${fmt0(p.length_ft)} ft`;
    return t;
  }

  /* The markup lives in js/popups.js: js/pick3d.js shows the identical string
     for the same feature clicked in 3D (§8). It also drops the old inline
     onclick, which passed the feature name through a quoted attribute — a name
     with an apostrophe in it broke the button silently. */
  function popup(p, g) { return SBMM.popups.forGis(p, g); }

  /* volume reuses the perimeter-TIN engine, exactly like the DUs and piles */
  function volumeOf(name) {
    const D = data();
    if (!D) return;
    const f = D.features.find(f => f.properties && f.properties.name === name
      && f.geometry.type === "Polygon");
    if (!f) { toast("design area not found"); return; }
    SBMM.tools.volumeOfRingPts(f.geometry.coordinates[0], name);
  }

  /* ---------- 3D ---------- */
  /* Only the design areas drape; the reference furniture would turn the
     terrain into a wireframe. */
  function rings3d() {
    const D = data();
    if (!D) return [];
    const out = [];
    for (const f of D.features) {
      const p = f.properties || {};
      if (f.geometry.type !== "Polygon") continue;
      const spec = (D.layers || []).find(l => l.key === p.layer);
      if (!spec || spec.group !== "design") continue;
      if (rows[p.layer] && !rows[p.layer].cb.checked) continue;
      /* the properties ride along so the 3D pick registry can build the same
         popup a 2D click builds (§8) without looking the feature up again */
      out.push({ ring: f.geometry.coordinates[0],
                 color: p.layer === "exc" ? (depthOf(p) <= 0.75 ? EXC_HALF : EXC_1FT) : spec.color,
                 props: p, geom: f.geometry });
    }
    return out;
  }

  /* ---------- osnap ---------- */
  function snapPaths() {
    const D = data();
    if (!D) return { rings: [], pts: [] };
    const rings = [], pts = [];
    for (const f of D.features) {
      const p = f.properties || {}, g = f.geometry;
      if (rows[p.layer] && !rows[p.layer].cb.checked) continue;   // only what is shown
      if (g.type === "Polygon") rings.push(g.coordinates[0]);
      else if (g.type === "LineString") rings.push(g.coordinates);
      else if (g.type === "Point") pts.push(g.coordinates);
    }
    return { rings, pts };
  }

  /* ---------- export ---------- */
  /* GeoJSON: the native design goes out with the drawings. A deliverable that
     omits the design the measurements were made against is half a deliverable
     (same reasoning as the datasets). */
  function geoFeatures(P) {
    const D = data();
    if (!D) return [];
    const out = [];
    for (const f of D.features) {
      const p = f.properties || {}, g = f.geometry;
      const props = { ...p, source: "EA Final Design (native)" };
      let geom = null;
      if (g.type === "Polygon") geom = { type: "Polygon", coordinates: g.coordinates.map(r => r.map(P)) };
      else if (g.type === "LineString") geom = { type: "LineString", coordinates: g.coordinates.map(P) };
      else if (g.type === "Point") geom = { type: "Point", coordinates: P(g.coordinates) };
      if (geom) out.push({ type: "Feature", properties: props, geometry: geom });
    }
    return out;
  }

  /* DXF: raw State Plane feet, one AutoCAD layer per payload layer, named the
     way a CAD user would expect to find them. */
  function dxfEntities() {
    const D = data();
    if (!D) return [];
    const out = [];
    const colOf = {};
    for (const l of (D.layers || [])) colOf[l.key] = l.color;
    for (const f of D.features) {
      const p = f.properties || {}, g = f.geometry;
      const layer = "EA-" + String(p.layer || "DESIGN").toUpperCase();
      const color = colOf[p.layer] || "#CCCCCC";
      if (g.type === "Polygon") out.push({ layer, color, closed: true, pts: g.coordinates[0] });
      else if (g.type === "LineString") out.push({ layer, color, closed: false, pts: g.coordinates });
      else if (g.type === "Point") out.push({ layer, color, point: g.coordinates });
    }
    return out;
  }

  function provenance() {
    const D = data();
    if (!D) return null;
    return { source: D.source, crs: D.crs, supersedes: D.supersedes,
             excluded: D.excluded, layers: D.layers };
  }

  return { build, volumeOf, rings3d, snapPaths, geoFeatures, dxfEntities,
           provenance, counts: null };
})();
