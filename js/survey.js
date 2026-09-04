/* SBMM Site Explorer — the August-2026 limited topographic survey (spec §10).

   Source: Jacobs' own survey of the Herman Impoundment water level, the two
   24-inch corrugated HDPE discharge pipes and their inverts, the sandbag wall
   beside them (top and toe), the Northwest Pit low (spot elevations, contours,
   the staff gauge) and two shore marks. tools/build_survey_2026.py places the
   report's vector plot from its own tabulated points (0.01–0.02 ft residuals)
   and writes two things:

     data/datasets/ds_survey_2026.json   every shot, as a baked dataset — drawn,
                                         tabled, exported and draped by
                                         js/datasets.js with nothing new here
     data/survey_2026.json               the linework, in the design_gis layer
                                         schema — this module

   Like designgis.js this is read-only project data: nothing here is a store
   feature, nothing is editable, nothing serialises. It snaps, drapes in 3D
   and goes out with the GeoJSON and DXF exports. The rows sit under the
   Investigations group behind a "Survey — Aug 2026 (Jacobs)" sub-header and
   start ON: five thin layers around two spots, they drown nothing.

   The numbers that matter to the overtopping analysis (the surveyed water
   surface, the pipe inverts, the sandbag crest) are read from the DATASET, not
   from here — see SBMM.water.surveyFacts(). */
"use strict";

SBMM.survey = (function () {

  let groups = {};       // layer key -> L.layerGroup
  let rows = {};         // layer key -> row handle
  let byLayer = {};

  function data() { return window.SBMM_DATA && SBMM_DATA.survey_2026; }
  function rowOn(key) { return SBMM.layerState.isOn("invest", "survey_" + key); }

  function build() {
    const D = data();
    if (!D || !D.features || !D.layers) return;
    byLayer = {};
    for (const f of D.features) {
      const k = f.properties && f.properties.layer;
      if (k) (byLayer[k] = byLayer[k] || []).push(f);
    }
    const host = document.getElementById("investLayers");
    if (host) {
      const h = document.createElement("div");
      h.className = "lsub";
      h.textContent = "Survey — Aug 2026 (Jacobs)";
      host.appendChild(h);
    }
    for (const spec of D.layers) buildLayer(spec);
    SBMM.survey.counts = Object.fromEntries(D.layers.map(l => [l.key, l.count]));
  }

  function buildLayer(spec) {
    const feats = byLayer[spec.key] || [];
    if (!feats.length) return;
    const grp = L.layerGroup();
    const col = spec.color || "#FF9F1C";
    const heavy = spec.key === "survey_pipe" || spec.key === "survey_wall" || spec.key === "survey_pit";
    for (const f of feats) {
      const p = f.properties || {}, g = f.geometry || {};
      if (g.type !== "LineString") continue;
      const lyr = L.polyline(g.coordinates.map(q => [q[1], q[0]]), {
        pane: "vectors", color: col, weight: heavy ? 2.4 : 1.2,
        dashArray: spec.key === "survey_pipe" ? "8 4" : null, opacity: heavy ? 0.95 : 0.7
      });
      lyr.bindTooltip(tip(p), { sticky: true, className: "ctip" });
      lyr._gis = { props: p, geom: g };
      lyr.on("click", () => lyr.bindPopup(SBMM.popups.forGis(p, g)).openPopup());
      lyr.addTo(grp);
    }
    const row = SBMM.addLayerRow("invest", `${esc(spec.name)} (${spec.count})`, grp,
      { id: "survey_" + spec.key, checked: true, swatch: col });
    row.row.title = `${spec.name} — ${spec.count} features. ${spec.provenance}`;
    groups[spec.key] = grp;
    rows[spec.key] = row;
  }

  function tip(p) {
    let t = `<b>${esc(p.name || "Survey linework")}</b>`;
    if (p.invert_ft != null) t += `<br>invert ${fmt(p.invert_ft, 2)} ft`;
    return t;
  }

  /* ---------- 3D: every visible line, draped ---------- */
  function lines3d() {
    const D = data();
    if (!D) return [];
    const out = [];
    for (const f of D.features) {
      const p = f.properties || {};
      if (f.geometry.type !== "LineString" || !rowOn(p.layer)) continue;
      const spec = (D.layers || []).find(l => l.key === p.layer);
      out.push({ ring: f.geometry.coordinates, color: (spec && spec.color) || "#FF9F1C",
                 props: p, geom: f.geometry,
                 width: (p.layer === "survey_pipe" || p.layer === "survey_wall" || p.layer === "survey_pit") ? 3 : 1.5 });
    }
    return out;
  }

  /* ---------- osnap ---------- */
  function snapPaths() {
    const D = data();
    if (!D) return { rings: [], pts: [] };
    const rings = [];
    for (const f of D.features) {
      const p = f.properties || {};
      if (f.geometry.type === "LineString" && rowOn(p.layer)) rings.push(f.geometry.coordinates);
    }
    return { rings, pts: [] };
  }

  /* ---------- export ---------- */
  function geoFeatures(P) {
    const D = data();
    if (!D) return [];
    return D.features
      .filter(f => f.geometry && f.geometry.type === "LineString")
      .map(f => ({ type: "Feature",
                   properties: { ...(f.properties || {}), source: "Jacobs survey, Aug 2026" },
                   geometry: { type: "LineString", coordinates: f.geometry.coordinates.map(P) } }));
  }
  function dxfEntities() {
    const D = data();
    if (!D) return [];
    const colOf = {};
    for (const l of (D.layers || [])) colOf[l.key] = l.color;
    return D.features
      .filter(f => f.geometry && f.geometry.type === "LineString")
      .map(f => ({ layer: "SURVEY-" + String((f.properties || {}).layer || "LINE").toUpperCase().replace(/^SURVEY_/, ""),
                   color: colOf[(f.properties || {}).layer] || "#FF9F1C",
                   closed: false, pts: f.geometry.coordinates }));
  }

  /* the plotted west end of the North pipe — where pipe discharge leaves the
     pipes and becomes overland flow (spec §10.4) */
  function pipeOutlet() {
    const D = data();
    if (!D) return null;
    const f = D.features.find(x => (x.properties || {}).layer === "survey_pipe"
      && /north/i.test((x.properties || {}).name || ""));
    return f ? f.geometry.coordinates[0].slice() : null;
  }

  function wire() { /* rows are built from js/layers.js; nothing global */ }

  return { build, wire, lines3d, snapPaths, geoFeatures, dxfEntities, pipeOutlet,
           data, rows: () => rows };
})();
