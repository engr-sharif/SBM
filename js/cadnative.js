/* SBMM Site Explorer — EA native CAD, the whole drawing set.

   js/designgis.js ships the 14 curated, authoritative design layers from EA's
   geodatabase.  This module ships everything else EA actually drew: all
   model-space geometry from every DWG in the Final Design package (project
   1578546), 22k features across 110 CAD layers, with the CAD attributes
   preserved — layer, colour resolved through ByLayer, linetype, lineweight,
   entity handle, true Z where the entity had it, and text content.

   designgis stays the authority for the design polygons.  This is the drafting
   context around them, plus two things designgis has never had:

     * `sheet_notes` — every paper-space TEXT/MTEXT on every sheet layout, which
       is where EA's excavation depths and construction notes actually live.
     * `surfaces`    — EA design/existing surfaces recovered from the Civil 3D
       AECC_TIN_SURFACE objects and the .mms store (see tools/build_cad_surfaces.py
       for the recovery methods and their validation numbers).

   Like designgis.js this is read-only project data: nothing here is a feature in
   SBMM.store, nothing is editable, nothing serialises into a session.  It is
   snappable, drapes in 3D, and goes out with the GeoJSON and DXF exports.

   Boot cost.  The payload splits eager/lazy.  Design geometry (~1.1k features)
   is a normal object literal.  The bulky reference groups — contours, block
   symbols, parcels, uncategorised — ship in the same payload as a JSON *string*
   and are JSON.parsed the first time one of those groups is switched on.  A
   20 MB string costs the JS parser almost nothing; the same bytes as an object
   literal cost hundreds of milliseconds on every boot. */
"use strict";

SBMM.CadNative = (function () {

  let D = null;               // the payload
  let lazyParsed = false;     // has the deferred half been JSON.parsed
  let features = [];          // all features currently materialised
  const groups = {};          // group key -> L.layerGroup
  const rows = {};            // group key -> layer-row handle
  const byGroup = {};         // group key -> [feature]
  const byHandle = {};        // CAD entity handle -> feature
  const built = {};           // group key -> has its geometry been rendered
  const surfCache = {};       // surface id -> decoded {w,h,z:Float32Array,...}
  const surfPending = {};     // surface id -> in-flight decode promise

  function data() { return window.SBMM_DATA && SBMM_DATA.cad_native; }
  function surfData() { return window.SBMM_DATA && SBMM_DATA.cad_surfaces; }

  /* ---------- payload ---------- */

  function index(list) {
    for (const f of list) {
      (byGroup[f.group] = byGroup[f.group] || []).push(f);
      if (f.handle) byHandle[f.handle] = f;
    }
    features = features.concat(list);
  }

  /* The deferred half. Parsed at most once, on the first enable of any lazy
     group — not at boot, which is the whole point of shipping it as a string. */
  function ensureLazy() {
    if (lazyParsed || !D || !D.lazy) return;
    lazyParsed = true;
    let list = [];
    try {
      list = JSON.parse(D.lazy);
    } catch (e) {
      toast("EA CAD: deferred layers failed to parse");
      return;
    }
    D.lazy = null;                       // 20 MB nothing reads twice
    index(list);
  }

  function isLazy(key) {
    return !!(D && D.meta && D.meta.lazy_groups &&
              D.meta.lazy_groups.indexOf(key) >= 0);
  }

  /* ---------- build ---------- */

  /* ---------- where each CAD group belongs in the §4 tree ----------
     There is no "CAD" group in the layer tree: a fence is site framework and a
     limit of excavation is design, whichever file they were drafted in. These
     are the two §4 groups the 21 CAD groups distribute into. */
  const SECTION = {
    exc: "design", daylight: "design", grade: "design", staging: "design",
    haul: "design", esc: "design", algn: "design", anno: "design",
    contour: "design",
    du: "proj", topo: "proj", bldg: "proj", road: "proj", parcel: "proj",
    fence: "proj", tree: "proj", util: "proj", env: "proj", symbol: "proj",
    storm: "proj", misc: "proj"
  };

  /* ---------- default-visibility overrides (planner ruling R1) ----------
     The payload bakes `default_on` per group at build time, and the payload is
     21 MB — too big to regenerate for a one-bit change, and hand-editing a
     generated file is worse. So the overrides live here, applied at load, and
     tools/build_cad_native.py carries the same values in LAYER_RULES so a real
     regeneration agrees with this table.

     `exc`: the geodatabase excavation polygons (js/designgis.js) are THE
     "Limits of excavation" layer — they reproduce EA's printed areas to 0.02 %
     and carry the depth. This CAD group is the raw drafting linework for the
     same limits: open segments that never close, plus the small
     special-treatment sub-areas. Drawing both put two different outlines on
     every lot and let the CAD entity answer clicks meant for the authority. */
  const DEFAULT_OVERRIDES = { exc: false };

  /* ---------- default-OFF single CAD layers (planner ruling F1) ----------
     One level below DEFAULT_OVERRIDES: a whole group stays on, but one layer
     inside it is suppressed until someone asks for it in the Layer manager.

     `G-ANNO-SYMB`: fourteen closed rectangles, 230 x 310 to 751 x 771 ft,
     drafted in ACI green. They are EA's SHEET VIEWPORT FRAMES — the paper
     extents of the plan sheets, drawn in model space so the drafter could see
     what each sheet would catch. On the map they read as fourteen big green
     boxes scattered over the site with nothing inside them, and they are the
     single largest source of clutter in the default 2D view.

     The rest of the `anno` group is what section 4 asks to be ON by default —
     the excavation notes and call-outs — so the group stays on and only this
     layer goes off. Anyone who wants the frames back has them one search away
     in the Layer manager, and the real sheet extents are now their own layer
     ("Sheet footprints", js/designea.js) with labels and a click target.

     Two more went off in the v9 delivery round, both found the same way — by
     looking at test/shots/2d_default.png and asking what every visible line is:

     `G-ANNO-MATC`: AutoCAD MATCH LINES (three of them, ACI 253 grey, PHANTOM2).
     A match line is a paper device — "this drawing continues on the next sheet"
     — and the longest is a dead-straight 3,724 ft rule running east-west across
     the whole site at N 2,128,294. In model space it is indistinguishable from a
     survey or alignment line, which is exactly the wrong thing for a map someone
     measures off.

     `G-ANNO-DETL-PROP`: the DETAIL CALL-OUT assembly (14 features, ACI green).
     Twelve of them are 1-3 ft stubs and two are 172 ft leaders, all parked at
     (6,369,42x, 2,129,47x) — about 1,700 ft west of the nearest lot, out in
     Clear Lake. It is a detail bubble and its leader, drafted where there was
     room on the sheet; on the map it is a green stub floating on open water.

     All three are annotation *about* the drawings rather than anything on the
     ground, and all three are one Layer-manager search away. */
  const DEFAULT_LAYER_OFF = { "G-ANNO-SYMB": true, "G-ANNO-MATC": true, "G-ANNO-DETL-PROP": true };

  /* CAD groups whose shipped label collides with a curated layer's. Both are
     real and both stay; the CAD one says which it is, so the tree never shows
     the same words twice meaning two different things (F4). */
  const RELABEL = {
    exc:     "Limits of excavation — CAD linework",
    du:      "Decision units — CAD linework",
    haul:    "Haul and access routes — CAD linework",
    staging: "Stockpile and staging — CAD linework",
    tree:    "Trees and vegetation — CAD linework",
    contour: "Contours — CAD (EA drafting)"
  };

  function build() {
    D = data();
    if (!D || !D.features || !D.meta) return;
    index(D.features);
    for (const n in DEFAULT_LAYER_OFF) lyOverride[n] = { on: false };

    for (const spec of (D.meta.groups || [])) {
      const grp = L.layerGroup();
      groups[spec.key] = grp;
      const on = DEFAULT_OVERRIDES[spec.key] != null
        ? DEFAULT_OVERRIDES[spec.key] : !!spec.default_on;
      const label = RELABEL[spec.key] || spec.label;
      /* the tag is what the monospace face used to say — "this row is EA's own
         CAD, not a curated layer" — without giving CAD rows a different
         typeface from everything else in the tree (F4). A row whose relabel
         already carries the word does not need it twice. */
      const tag = /\bCAD\b/.test(label) ? null : "CAD";
      const row = SBMM.addLayerRow(SECTION[spec.key] || "design",
        `${esc(label)} (${spec.count})`, grp,
        { id: "cad_" + spec.key, checked: on, swatch: spec.color, tag,
          meta: { cad: true, key: spec.key, spec },
          /* geometry is rendered on first enable, for every group — a group the
             user never opens costs nothing but its row */
          onFirstShow: () => render(spec.key) });
      rows[spec.key] = row;
      row.row.classList.add("cadrow");
      const offLayers = (spec.layers || []).filter(n => DEFAULT_LAYER_OFF[n]);
      row.row.title = `${label} — ${spec.count} CAD features on `
        + `${spec.layers.length} layer${spec.layers.length === 1 ? "" : "s"}: `
        + spec.layers.slice(0, 8).join(", ")
        + (spec.layers.length > 8 ? " …" : "")
        + (isLazy(spec.key) ? " (loaded on first use)" : "")
        + (DEFAULT_OVERRIDES[spec.key] === false
           ? " — off by default: the geodatabase polygons are the authority for these limits"
           : "")
        + (offLayers.length
           ? ` — ${offLayers.join(", ")} hidden by default (sheet viewport frames, match lines and detail call-outs — paper annotation, not site features); turn ${offLayers.length === 1 ? "it" : "them"} on in the Layer manager`
           : "");
    }
  }

  function render(key) {
    if (built[key]) return;
    if (isLazy(key)) ensureLazy();
    built[key] = true;
    const grp = groups[key];
    const spec = (D.meta.groups || []).find(g => g.key === key);
    if (!grp || !spec) return;
    const feats = byGroup[key] || [];
    const isDesign = ["exc", "daylight", "grade", "repo", "borrow",
                      "staging", "haul"].indexOf(key) >= 0;

    /* Interactivity is deliberately narrow.  This module puts 22k CAD entities
       on the map; if all of them take pointer events, reference furniture
       silently steals clicks from the tools — an annotation leader passing 8 ft
       from a click was enough to break object snap, with no error anywhere.
       So: design linework is clickable (it is few, and it is the point), text
       and point markers are clickable (they are tiny, and their content is the
       value), and every other stroke is display-only. */
    const clickable = f => isDesign || f.kind === "text" ||
      f.kind === "point" || f.kind === "block";

    for (const f of feats) {
      const col = f.color || spec.color || "#ccc";
      const act = clickable(f);
      let lyr = null;
      if (f.kind === "point" || f.kind === "block") {
        lyr = L.circleMarker([f.coords[1], f.coords[0]], {
          pane: "vectors", radius: 2.2, color: "#0D1215", weight: 1,
          fillColor: col, fillOpacity: 0.9, interactive: act
        });
      } else if (f.kind === "text") {
        lyr = L.circleMarker([f.coords[1], f.coords[0]], {
          pane: "vectors", radius: 1.6, color: col, weight: 1,
          fillColor: col, fillOpacity: 0.55, interactive: act
        });
      } else {
        const pts = f.coords.map(p => [p[1], p[0]]);
        if (pts.length < 2) continue;
        if (f.closed) {
          /* Never fill.  CAD linework is linework: a filled polygon is
             clickable over its whole interior, and with `preferCanvas` the
             topmost hit wins — one closed D-NOTE annotation box silently ate
             every map click inside it, which broke object snap with no error
             anywhere (the same class of bug as the pane trap in CLAUDE.md).
             designgis.js owns the filled design polygons; this module draws
             outlines, so only the stroke is a click target. */
          lyr = L.polygon(pts, {
            pane: "vectors", color: col, weight: isDesign ? 2.0 : 1.1,
            fill: false, fillOpacity: 0, interactive: act
          });
        } else {
          lyr = L.polyline(pts, {
            pane: "vectors", color: col, weight: isDesign ? 1.9 : 1.0,
            dashArray: key === "daylight" ? "5 3" : null, interactive: act
          });
        }
      }
      if (!lyr) continue;
      lyr._cad = f;
      if (act) {
        lyr.bindTooltip(tip(f), { sticky: true, className: "ctip" });
        lyr.on("click", () => lyr.bindPopup(popup(f)).openPopup());
      }
      (objByLayer[f.layer] = objByLayer[f.layer] || []).push({ lyr, grp });
      lyr.addTo(grp);
    }
    /* re-apply any per-layer override the Layer manager set before this group's
       geometry existed */
    for (const name in lyOverride) applyLayerOverride(name);
  }

  /* ---------- per-CAD-layer overrides (the Layer manager, §6) ----------
     The layer ROWS in the tree are the 21 UI groups; the Layer manager works
     one level down, on EA's own 110 CAD layer names, because that is the
     vocabulary a CAD user has and the level at which "why is that line there"
     gets answered. Overrides are held here rather than in the dialog so they
     survive it being closed and re-opened, and so a group rendered later picks
     them up. */
  const objByLayer = {};        // CAD layer name -> [{lyr, grp}]
  const lyOverride = {};        // CAD layer name -> {on?, color?, opacity?}

  function layerRecord(name) {
    return ((D && D.layers) || []).find(l => l.layer === name) || null;
  }
  function applyLayerOverride(name) {
    const o = lyOverride[name] || {};
    const rec = layerRecord(name);
    for (const { lyr, grp } of (objByLayer[name] || [])) {
      const on = o.on !== false;
      if (on && !grp.hasLayer(lyr)) grp.addLayer(lyr);
      if (!on && grp.hasLayer(lyr)) grp.removeLayer(lyr);
      if (!lyr.setStyle) continue;
      const col = o.color || (lyr._cad && lyr._cad.color) || (rec && rec.color) || "#ccc";
      const op = o.opacity == null ? 1 : o.opacity;
      const st = { color: col, opacity: op };
      if (lyr.options.fillColor != null || lyr._cad.kind === "point" || lyr._cad.kind === "block" || lyr._cad.kind === "text") {
        st.fillColor = col; st.fillOpacity = (lyr.options.fillOpacity || 0.9) && op * (lyr.options.fillOpacity || 0.9);
      }
      lyr.setStyle(st);
    }
  }
  function setLayerOverride(name, patch) {
    const o = lyOverride[name] = lyOverride[name] || {};
    Object.assign(o, patch);
    applyLayerOverride(name);
    return o;
  }
  function layerOverride(name) { return lyOverride[name] || {}; }
  function resetLayerOverrides() {
    const names = Object.keys(lyOverride);
    for (const n of names) delete lyOverride[n];
    /* "reset to defaults" means the app's defaults, not "everything on" — the
       sheet viewport frames of DEFAULT_LAYER_OFF go back to hidden (F1) */
    for (const n in DEFAULT_LAYER_OFF) { lyOverride[n] = { on: false }; if (!names.includes(n)) names.push(n); }
    for (const n of names) applyLayerOverride(n);
    /* group visibility back to the shipped defaults, with R1's override on top */
    for (const spec of ((D && D.meta && D.meta.groups) || [])) {
      const on = DEFAULT_OVERRIDES[spec.key] != null ? DEFAULT_OVERRIDES[spec.key] : !!spec.default_on;
      SBMM.layerState.set(SECTION[spec.key] === "proj" ? "framework" : "design", "cad_" + spec.key, { on });
    }
    return names.length;
  }
  /* everything the Layer manager shows about one CAD layer */
  function layerInfo(name) {
    const rec = layerRecord(name);
    if (!rec) return null;
    const feats = (features || []).filter(f => f.layer === name);
    const sample = feats.find(f => f.handle) || feats[0] || null;
    return {
      layer: name, group: rec.group, label: rec.label, color: rec.color,
      count: rec.count, files: rec.files || [], kinds: rec.kinds || {},
      rendered: !!(objByLayer[name] && objByLayer[name].length),
      handle: sample && sample.handle ? sample.handle : null,
      file: sample && sample.file ? sample.file : (rec.files || [])[0] || null,
      override: layerOverride(name)
    };
  }

  function tip(f) {
    let t = `<b>${esc(f.text ? f.text.split("\n")[0].slice(0, 60) : f.layer)}</b>`;
    t += `<br><span style="opacity:.75">${esc(f.type)}</span>`;
    if (f.depth_ft != null) t += ` · excavate ${f.depth_ft} ft`;
    return t;
  }

  /* One builder for both views. This used to be a private copy kept identical
     to js/popups.js by hand (and compared by the e2e); it is now the one line
     it should always have been. */
  function popup(f) { return SBMM.popups.forCad(f); }

  /* ---------- surfaces ---------- */
  /* The design-surface set of docs/V9_SPEC.md §5, built by
     tools/build_cad_surfaces.py.  `SBMM_DATA.cad_surfaces` is the manifest
     (the same JSON as data/design/surfaces.json); each surface's raster is a
     separate SBMM_DATA key named by `raster.payload`, holding one terrain-RGB
     data-URL in the app's standard encoding — v = R*256+G,
     z = zmin + (v-1)*zstep, v == 0 nodata, PNG row 0 north, exactly what
     js/dem.js decodes.

     Decoding is lazy and happens at most once per surface: the rasters are
     ~9 MB of PNG between them and nothing should pay for that until something
     asks for an elevation.  `surfaceElev` is the synchronous entry point, so
     the first call for a surface kicks the decode off and returns NaN; use
     `surfaceReady(id)` (or await `loadSurface(id)`) when a caller needs the
     numbers to be there on the first try. */

  function surfaceList() {
    const S = surfData();
    return (S && S.surfaces) || (S && S.manifest && S.manifest.surfaces) || [];
  }

  /* Accepts the §5 `id`; the pre-§5 payload's `key` is still honoured so an
     older datajs/d_cad_surfaces.js does not silently return nothing. */
  function surfaceMeta(id) {
    return surfaceList().find(s => s.id === id || s.key === id) || null;
  }

  function surfaceRasterURL(m) {
    if (!m) return null;
    const key = m.raster && m.raster.payload;
    if (key && window.SBMM_DATA && SBMM_DATA[key]) return SBMM_DATA[key];
    const S = surfData();                       // pre-§5 payload shape
    if (S && S.png && m.png && S.png[m.png]) return S.png[m.png];
    return null;
  }

  async function loadSurface(id) {
    if (surfCache[id]) return surfCache[id];
    if (surfPending[id]) return surfPending[id];
    const m = surfaceMeta(id);
    const url = surfaceRasterURL(m);
    if (!m || !url) return null;
    const r = m.raster || m;                    // §5 nests the header
    surfPending[id] = (async () => {
      try {
        const b = atob(url.slice(url.indexOf(",") + 1));
        const u8 = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u8], { type: "image/png" }));
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const z = new Float32Array(c.width * c.height);
        for (let i = 0, n = z.length; i < n; i++) {
          const v = px[i * 4] * 256 + px[i * 4 + 1];
          z[i] = v === 0 ? NaN : r.zmin + (v - 1) * r.zstep;
        }
        surfCache[id] = { z, w: c.width, h: c.height, x0: r.x0, y0: r.y0,
                          step: r.step || 1, meta: m };
        return surfCache[id];
      } catch (e) {
        toast(`EA surface "${id}" failed to decode`);
        return null;
      } finally {
        surfPending[id] = null;
      }
    })();
    return surfPending[id];
  }

  /* Resolves when the surface is decoded (or immediately if it already is). */
  function surfaceReady(id) {
    return surfCache[id] ? Promise.resolve(surfCache[id]) : loadSurface(id);
  }

  /* Elevation of a design surface at a State Plane point; NaN outside the
     raster, at a nodata cell, and on the first call before the decode lands.
     Mirrors SBMM.design.elev(f, x, y) so the volume engine's design-base path,
     sections and the isopach consume these exactly as they consume a user pad.
     Nearest-cell on a 1 ft grid — the rasters ARE the design at 1 ft, so
     interpolating between cells would invent precision the source does not
     have. */
  function surfaceElev(id, x, y) {
    const s = surfCache[id];
    if (!s) { loadSurface(id); return NaN; }
    const i = Math.round((x - s.x0) / s.step);
    const j = Math.round((y - s.y0) / s.step);
    if (i < 0 || i >= s.w || j < 0 || j >= s.h) return NaN;
    return s.z[(s.h - 1 - j) * s.w + i];      // PNG row 0 is north
  }

  /* ---------- 3D ---------- */
  /* Only the design groups drape; the reference furniture would turn the
     terrain into a wireframe (the same call this module's sibling makes). */
  function rings3d() {
    const out = [];
    const want = ["exc", "daylight", "grade", "repo", "borrow", "staging", "haul"];
    for (const key of want) {
      if (!rows[key] || !rows[key].cb.checked) continue;
      const spec = (D.meta.groups || []).find(g => g.key === key);
      for (const f of (byGroup[key] || [])) {
        if (f.kind !== "line" && f.kind !== "hatch") continue;
        if (f.coords.length < 2) continue;
        out.push({ ring: f.coords, color: f.color || (spec && spec.color),
                   z: f.z_min != null });
      }
    }
    return out;
  }

  /* ---------- osnap ---------- */
  function snapPaths() {
    const rings = [], pts = [];
    for (const key in byGroup) {
      if (!rows[key] || !rows[key].cb.checked) continue;
      for (const f of byGroup[key]) {
        if (f.kind === "point" || f.kind === "block" || f.kind === "text")
          pts.push(f.coords);
        else if (f.coords.length >= 2)
          rings.push(f.coords.map(p => [p[0], p[1]]));
      }
    }
    return { rings, pts };
  }

  /* ---------- export ---------- */
  function geoFeatures(P) {
    const out = [];
    for (const key in byGroup) {
      if (!rows[key] || !rows[key].cb.checked) continue;
      for (const f of byGroup[key]) {
        const props = { layer: f.layer, cad_type: f.type, file: f.file,
                        handle: f.handle, group: f.group,
                        source: "EA Final Design (native CAD)" };
        if (f.text) props.text = f.text;
        if (f.depth_ft != null) props.depth_ft = f.depth_ft;
        let geom = null;
        if (f.kind === "point" || f.kind === "block" || f.kind === "text")
          geom = { type: "Point", coordinates: P(f.coords) };
        else if (f.closed)
          geom = { type: "Polygon", coordinates: [f.coords.map(p => P([p[0], p[1]]))] };
        else
          geom = { type: "LineString", coordinates: f.coords.map(p => P([p[0], p[1]])) };
        if (geom) out.push({ type: "Feature", properties: props, geometry: geom });
      }
    }
    return out;
  }

  /* DXF: raw State Plane feet, EA's own layer name preserved so the drawing
     round-trips into AutoCAD looking like what EA sent. */
  function dxfEntities() {
    const out = [];
    for (const key in byGroup) {
      if (!rows[key] || !rows[key].cb.checked) continue;
      for (const f of byGroup[key]) {
        const layer = f.layer || "EA-CAD";
        if (f.kind === "point" || f.kind === "block" || f.kind === "text")
          out.push({ layer, color: f.color, point: f.coords, text: f.text });
        else if (f.coords.length >= 2)
          out.push({ layer, color: f.color, closed: !!f.closed,
                     pts: f.coords.map(p => [p[0], p[1]]) });
      }
    }
    return out;
  }

  function sheetNotes() { return (D && D.sheet_notes) || []; }

  function provenance() {
    if (!D) return null;
    return { source: D.meta.source, crs: D.meta.crs,
             crs_note: D.meta.crs_note, files: D.meta.files,
             groups: D.meta.groups, layers: D.layers,
             surfaces: surfaceList() };
  }

  return {
    build, render, provenance, rings3d, snapPaths, geoFeatures, dxfEntities,
    sheetNotes, surfaceMeta, loadSurface, surfaceReady, surfaceElev,
    /* Layer manager (§6) */
    layerInfo, layerOverride, setLayerOverride, resetLayerOverrides,
    groupOf: key => rows[key] || null,
    sectionOf: key => (SECTION[key] === "proj" ? "framework" : "design"),
    groupSpecs: () => ((D && D.meta && D.meta.groups) || []),
    defaultOverrides: DEFAULT_OVERRIDES,
    /* `surfaces` is the §5 manifest list: {id, label, kind, method,
       source_files, confidence, raster, footprint, stats,
       volumes_vs_lidar_yd3, notes}.  Read-only project data — Agent C wraps
       each as a read-only surface feature and reads elevations through
       surfaceElev(id, x, y). */
    get surfaces() { return surfaceList(); },
    get notRecovered() { const S = surfData(); return (S && S.not_recovered) || []; },
    get sheet_notes() { return sheetNotes(); },
    get groups() { return groups; },
    get layers() { return (D && D.layers) || []; },
    get features() { return features; },
    byHandle
  };
})();
