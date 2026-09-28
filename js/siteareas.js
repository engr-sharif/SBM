/* SBMM Site Explorer — the named site areas of SBMM.kmz (v28).

   The earlier boring explorer drew the site's named areas over its map — the
   South / West / North waste rock cells, the Northwest Pit, West Rock Dam, the
   two borrow-soil staging areas and the approximate borrow area — from the
   project's SBMM.kmz. tools/build_imports.py brings them over as
   SBMM_DATA.site_areas: eight closed rings in State Plane feet, outline only.

   Read-only project data in the manner of js/survey.js: one row under
   Investigations (off by default — it is context, not a result), draped in 3D,
   snappable, and out with the GeoJSON and DXF exports. The outlines were drawn
   in a KMZ, not surveyed, and the popup says so. */
"use strict";

SBMM.siteAreas = (function () {

  const COLOR = "#C9B37E";
  let group = null, row = null;

  function data() { return window.SBMM_DATA && SBMM_DATA.site_areas; }
  function on() { return SBMM.layerState.isOn("invest", "site_areas"); }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function areaAc(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
      a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return Math.abs(a / 2) / 43560;
  }
  function props(f) {
    const ac = areaAc(f.rings[0]);
    return { name: f.name, acres: +ac.toFixed(2), area_sf: Math.round(ac * 43560),
             note: "outline from SBMM.kmz · not surveyed" };
  }
  function geom(f) { return { type: "Polygon", coordinates: f.rings }; }

  function build() {
    const D = data();
    if (!D || !D.features || !D.features.length) return;
    group = L.layerGroup();
    for (const f of D.features) {
      const p = props(f), g = geom(f);
      const lyr = L.polygon(f.rings.map(r => r.map(q => [q[1], q[0]])), {
        pane: "vectors", color: COLOR, weight: 1.6, dashArray: "6 4",
        fill: true, fillOpacity: 0.04, opacity: 0.9
      });
      lyr.bindTooltip(`<b>${esc(f.name)}</b>`, { sticky: true, className: "ctip" });
      lyr._gis = { props: p, geom: g };
      lyr.on("click", () => lyr.bindPopup(SBMM.popups.forGis(p, g)).openPopup());
      lyr.addTo(group);
    }
    row = SBMM.addLayerRow("invest", `Site areas — SBMM.kmz (${D.features.length})`, group,
      { id: "site_areas", checked: false, swatch: COLOR });
    row.row.title = D.source || "";
  }

  function lines3d() {
    const D = data();
    if (!D || !on()) return [];
    return D.features.map(f => ({ ring: f.rings[0], color: COLOR, props: props(f), geom: geom(f), width: 2 }));
  }
  function snapPaths() {
    const D = data();
    if (!D || !on()) return { rings: [], pts: [] };
    return { rings: D.features.map(f => f.rings[0]), pts: [] };
  }
  function geoFeatures(P) {
    const D = data();
    if (!D) return [];
    return D.features.map(f => ({ type: "Feature",
      properties: { ...props(f), source: "SBMM.kmz" },
      geometry: { type: "Polygon", coordinates: f.rings.map(r => r.map(P)) } }));
  }
  function dxfEntities() {
    const D = data();
    if (!D) return [];
    return D.features.map(f => ({ layer: "SITE-AREAS", color: COLOR, closed: true, pts: f.rings[0] }));
  }

  return { build, lines3d, snapPaths, geoFeatures, dxfEntities, data, row: () => row, COLOR };
})();
