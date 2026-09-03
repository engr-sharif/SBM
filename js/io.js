/* SBMM Site Explorer — import/export: GeoJSON (WGS84 + State Plane), session files, CSV */
"use strict";

SBMM.io = (function () {

  function featGeom(f, project) {
    const P = project;   // p -> coordinate pair
    if (f.type === "spot" || f.type === "text") return { type: "Point", coordinates: P(f.pts[0]) };
    if (f.type === "line" || f.type === "profile" || f.type === "dim" || f.type === "sections")
      return { type: "LineString", coordinates: f.pts.map(P) };
    return { type: "Polygon", coordinates: [[...f.pts, f.pts[0]].map(P)] };
  }
  /* annotations carry their payload in properties; a text feature's leader is a
     second vertex, which a Point geometry can't hold, so it goes out as a property */
  function extraProps(f, P) {
    if (f.type === "text" && f.pts.length > 1) {
      const l = P(f.pts[1]);
      return { leader_x: l[0], leader_y: l[1] };
    }
    return {};
  }
  /* Derived geometry that is computed rather than drawn — a design surface's
     daylight line and a section set's cut lines — goes out alongside the features
     that produced it. It is what the recipient actually needs in GIS: the drawn
     footprint says what was asked for, the daylight line says where the grading
     really lands. */
  function derived(f, P) {
    const out = [];
    if (f.type === "surface" && f._daylight) {
      f._daylight.forEach((line, i) => out.push({
        type: "Feature",
        properties: { name: `${f.name} — daylight line${f._daylight.length > 1 ? " " + (i + 1) : ""}`,
                      tool: "daylight", parent: f.name, pad_z_ft: f.props.padZ,
                      slope_HV: f.props.ratio, layer: "GRADING" },
        geometry: { type: "LineString", coordinates: line.map(P) }
      }));
    }
    if (f.type === "sections" && f._sec) {
      const R = f._sec;
      for (let s = 0; s < R.ns; s++) {
        const a = [R.cx[s] - R.nx[s] * R.half, R.cy[s] - R.ny[s] * R.half];
        const b = [R.cx[s] + R.nx[s] * R.half, R.cy[s] + R.ny[s] * R.half];
        out.push({
          type: "Feature",
          properties: { name: `${f.name} — Sta ${SBMM.sections.staLabel(R.sta[s])}`,
                        tool: "section", parent: f.name, station_ft: +R.sta[s].toFixed(1),
                        station: SBMM.sections.staLabel(R.sta[s]), layer: "SECTION" },
          geometry: { type: "LineString", coordinates: [a, b].map(P) }
        });
      }
    }
    return out;
  }

  function collection(mode) {  // mode: "wgs84" | "sp"
    const P = mode === "wgs84"
      ? p => SBMM.toLL(p[0], p[1]).map(v => +v.toFixed(7))
      : p => [+p[0].toFixed(2), +p[1].toFixed(2)];
    const feats = [];
    /* datasets go out with the drawings: a GeoJSON of "what I measured" that
       omits the wells the measurement was about is half a deliverable */
    if (SBMM.datasets) for (const d of SBMM.datasets.geoFeatures(P)) feats.push(d);
    /* and so does the native EA design — the geometry the measurements were
       made against belongs in the same file as the measurements */
    if (SBMM.designGIS) for (const d of SBMM.designGIS.geoFeatures(P)) feats.push(d);
    /* EA's reference design surfaces (§5) are store features so the volume
       engine can use them, but their geometry here is only a footprint bbox and
       the design itself already goes out through js/designgis.js — exporting
       them again would put a meaningless rectangle in the deliverable. */
    SBMM.store.features.filter(f => !(f.props && f.props.ref)).forEach((f, i) => {
      feats.push({
        type: "Feature",
        properties: { name: f.name || f.type + " " + (i + 1), tool: f.type, ...scrubProps(f.props), ...extraProps(f, P) },
        geometry: featGeom(f, P)
      });
      for (const d of derived(f, P)) feats.push(d);
    });
    /* Cultural resources go out only when they are switched on AND the
       acknowledgement has been given, and when they do, the file says so —
       the protection has to travel with the data, not only with the screen it
       was made on (§7). */
    let cultMeta = null;
    if (SBMM.cultural && SBMM.cultural.visible() && SBMM.cultural.isAcknowledged()) {
      for (const d of SBMM.cultural.geoFeatures(P)) feats.push(d);
      cultMeta = SBMM.cultural.exportMeta();
    }
    const fc = { type: "FeatureCollection", features: feats };
    if (mode === "sp") fc.crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::6418" } };
    else fc.note = "WGS84 via local site affine (±1 ft). Feature measurements in properties are State-Plane-based.";
    if (cultMeta) fc.metadata = { confidential: cultMeta };
    return fc;
  }
  function scrubProps(p) {
    if (!p) return {};
    const o = {};
    for (const k in p) if (k !== "profile" && k !== "showCutFill" && typeof p[k] !== "object") o[k] = p[k];
    return o;
  }

  async function exportGeoJSON(mode) {
    const nds = SBMM.datasets ? SBMM.datasets.list().length : 0;
    if (!SBMM.store.features.length && !nds) { toast("nothing drawn yet"); return; }
    if (SBMM.cultural && !(await SBMM.cultural.gateExport("GeoJSON export"))) {
      toast("export cancelled");
      return;
    }
    const fc = collection(mode);
    download(`sbmm_features_${mode === "sp" ? "stateplane_6418" : "wgs84"}.geojson`,
      new Blob([JSON.stringify(fc, null, 1)], { type: "application/geo+json" }));
    if (fc.metadata && fc.metadata.confidential)
      toast("this file contains cultural-resource locations — handle accordingly", 5000);
  }
  function exportSession() {
    download("sbmm_session_" + new Date().toISOString().slice(0, 10) + ".sbmm.json",
      new Blob([JSON.stringify(SBMM.store.serialize(), null, 1)], { type: "application/json" }));
  }
  function exportResultsCSV() {
    const csv = SBMM.results.csv();
    if (csv.split("\n").length < 3) { toast("no results yet"); return; }
    download("sbmm_results.csv", new Blob([csv], { type: "text/csv" }));
  }
  function exportSamplesCSV() {
    let csv = "id,source,sp_e_ft,sp_n_ft,lat,lon,elev_ft,Hg_mgkg,As_mgkg,exceeds_RG\n";
    for (const p of SBMM.samples) {
      const [lo, la] = SBMM.toLL(p.x, p.y);
      const [z] = SBMM.elev(p.x, p.y);
      csv += `${p.id},${p.src},${p.x},${p.y},${la.toFixed(7)},${lo.toFixed(7)},${isNaN(z) ? "" : z.toFixed(1)},${p.Hg ?? ""},${p.As ?? ""},${p.exc ? "Y" : "N"}\n`;
    }
    download("sbmm_sample_locations.csv", new Blob([csv], { type: "text/csv" }));
  }

  /* ---------------- import ---------------- */
  function looksLikeSP(c) { return Math.abs(c[0]) > 1000 || Math.abs(c[1]) > 1000; }
  function importGeoJSON(obj, fname) {
    let feats = obj.type === "FeatureCollection" ? obj.features :
                obj.type === "Feature" ? [obj] : null;
    if (!feats) throw new Error("not GeoJSON");
    let added = 0;
    for (const ft of feats) {
      const g = ft.geometry; if (!g) continue;
      const conv = c => looksLikeSP(c) ? [c[0], c[1]] : SBMM.fromLL(c[0], c[1]);
      const nm = (ft.properties && (ft.properties.name || ft.properties.Name || ft.properties.id)) || fname;
      if (g.type === "Point") { SBMM.tools.rebuildFeature({ type: "spot", pts: [conv(g.coordinates)], props: { imported: true } }); added++; }
      else if (g.type === "LineString") { SBMM.tools.rebuildFeature({ type: "line", pts: g.coordinates.map(conv), name: nm, props: { imported: true } }); added++; }
      else if (g.type === "Polygon") {
        let ring = g.coordinates[0].map(conv);
        if (ring.length > 1 && dist2d(ring[0], ring[ring.length - 1]) < 0.01) ring = ring.slice(0, -1);
        SBMM.tools.rebuildFeature({ type: "area", pts: ring, name: nm, props: { imported: true } }); added++;
      }
      else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) {
          let ring = poly[0].map(conv);
          if (ring.length > 1 && dist2d(ring[0], ring[ring.length - 1]) < 0.01) ring = ring.slice(0, -1);
          SBMM.tools.rebuildFeature({ type: "area", pts: ring, name: nm, props: { imported: true } }); added++;
        }
      }
    }
    toast(`imported ${added} feature${added === 1 ? "" : "s"} — measurements computed`);
  }
  function handleFile(file) {
    const rd = new FileReader();
    const isDxf = /\.dxf$/i.test(file.name);
    const isCsv = /\.(csv|tsv|txt)$/i.test(file.name);
    rd.onload = () => {
      try {
        if (isCsv) { SBMM.datasets.importCSV(rd.result, file.name); return; }
        if (isDxf) {
          const n = SBMM.dxf.importText(rd.result, file.name);
          toast(`DXF imported — ${n} entit${n === 1 ? "y" : "ies"} as features`);
          return;
        }
        const obj = JSON.parse(rd.result);
        if (obj.app === "SBMM Site Explorer") { SBMM.store.restore(obj); toast(`session loaded — ${obj.features.length} features`); }
        else importGeoJSON(obj, file.name.replace(/\.[^.]+$/, ""));
      } catch (e) { toast((isDxf ? "DXF import refused — " : "couldn't read " + file.name + ": ") + e.message, 6000); }
    };
    rd.readAsText(file);
  }

  function wire() {
    /* export menu */
    const menu = $("exportMenu");
    $("exportBtn").onclick = e => { e.stopPropagation(); menu.style.display = menu.style.display === "block" ? "none" : "block"; };
    document.addEventListener("click", () => menu.style.display = "none");
    menu.onclick = e => {
      const a = e.target.dataset.a; if (!a) return;
      menu.style.display = "none";
      if (a === "gj-wgs") exportGeoJSON("wgs84");
      if (a === "gj-sp") exportGeoJSON("sp");
      if (a === "dxf") SBMM.dxf.exportDXF();
      if (a === "session") exportSession();
      if (a === "rescsv") exportResultsCSV();
      if (a === "ptscsv") exportSamplesCSV();
      if (a === "dscsv") {
        const ds = SBMM.datasets ? SBMM.datasets.list() : [];
        if (!ds.length) { toast("no datasets loaded"); return; }
        ds.forEach(d => SBMM.datasets.exportCSV(d));
      }
    };
    /* import */
    $("importBtn").onclick = () => $("importFile").click();
    $("importFile").onchange = e => { [...e.target.files].forEach(handleFile); e.target.value = ""; };
    document.addEventListener("dragover", e => { e.preventDefault(); });
    document.addEventListener("drop", e => {
      e.preventDefault();
      [...e.dataTransfer.files].forEach(f => { if (/\.((geo)?json|dxf|csv|tsv)$/i.test(f.name)) handleFile(f); else toast("drop .geojson, .json, .dxf or .csv files"); });
    });
  }
  return { wire, exportSamplesCSV, collection };
})();
