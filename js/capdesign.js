/* SBMM Site Explorer: Northwest Pit cap design viewer.
   Mohammad Sharif, Jacobs. SBMM OU1.

   ONE design file drives everything here. The built in copy ships as the script
   payload SBMM_DATA.cap_design (datajs/d_cap_design.js, the same bytes as
   data/cap_design.json). It is written by the export scripts in the SBMM drive
   folder "NW Pit Cap Extent/04_Analysis". A build can carry MORE designs beside
   it, as options for the same cap: every payload named SBMM_DATA.cap_design_<x>
   is another built in design, and the panel then has one button per design
   ("Built in designs"). The choice is kept on the device. A newer file can be
   loaded at run time with "Load cap design file" or by dropping it on the panel
   (FileReader, never fetch), so the hosted app shows a new revision without a
   rebuild. The last loaded file is kept on the device and comes back on reload.

   NOTHING ABOUT THE DESIGN IS WRITTEN IN THIS FILE. The layer rows, their
   colours and popups, the 3D surface, the panel numbers with their labels and
   the perimeter notes are all read from the design file in use (see "the
   design file" below for the shape, and CLAUDE.md "NW Pit cap design").

   What it shows:
     2D  one row per layer of the file under Site framework (all off until
         asked for), with popups. A
         click on a filled layer reports cap elevation, existing ground and
         fill depth at that point; the pointer chip reports the same.
     3D  every layer of the file, each under its own row (the app's rule: a
         layer that is on is on in 2D and in 3D). Lines and polygon outlines
         are draped on the ground, points and notes are dots on the ground,
         and a layer the file marks "level" (the cap contours) is drawn at its
         own elevation. The cap surface is a translucent mesh with a row of
         its own that carries the opacity slider. All of it sits in the
         overlay group, so it follows the relief setting.
   Read only project data, like the EA design: nothing here is a feature in
   SBMM.store and nothing is saved into a session file.

   The cap surface raster uses the same encoding as the terrain PNGs (see
   js/dem.js) and is wrapped in a Dem, so SBMM.capDesign.at(x, y) is a plain
   bilinear lookup. It is NOT added to SBMM.dems: the ground stays the ground. */
"use strict";

SBMM.capDesign = (function () {

  const GROUP = "proj", SG = "framework";      // the Site framework section and its state group
  const SUB = "NW Pit cap design";             // the sub-group the rows sit in
  const STORE_KEY = "sbmm.capdesign.v1";       // the last loaded design file
  const KEEP_MAX = 1400000;                    // characters; over this a file is used but not stored
  const UI_KEY = "sbmm.capdesign.ui.v1";       // this module's own switches
  const ROW_SURF = "cap_3d_surface";
  const KINDS = { poly: 1, line: 1, point: 1, note: 1 };
  const MAX_SIDE = 2048, MAX_CELLS = 2000000, MAX_PTS = 400000;

  let D = null;                    // the design in use (normalised)
  let SRC = { kind: "none", name: "", kept: false };
  let capDem = null;               // Dem over the cap surface raster of D
  let builtIn = null;              // the normalised built in design in use (or to go back to), when the build has one
  const builtIns = [];             // every built in design of the build: SBMM_DATA.cap_design first, then cap_design_<x>
  let ready = Promise.resolve(null);
  const H = {};                    // layer key -> { key, group, ref }
  let surfRow = null, headEl = null;
  const UI = { level3d: true, builtin: "" };   // level3d: draw the "level" layers (the cap contours) in 3D. builtin: rev of the built in design picked
  let built = false, panel = null, lastMsg = "";
  let meshGeom = null, meshKey = "", liveMat = null, liveMesh = null;
  const last3d = { calls: 0, objects: 0, tris: 0, drape: 0, dots: 0, level: 0, opacity: null };

  const ll = p => [p[1], p[0]];    // State Plane [x, y] to Leaflet [lat, lng]
  const fin = v => typeof v === "number" && isFinite(v);
  const nf = (v, dp) => !fin(v) ? "n/a"
    : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const str = (v, n) => v == null ? "" : String(v).slice(0, n || 200);
  const rowOn = id => !!(SBMM.layerState && SBMM.layerState.isOn(SG, id));
  const isOn = key => rowOn("cap_" + key);

  /* ------------------------------------------------------------------ */
  /* the design file                                                     */
  /* ------------------------------------------------------------------ */
  /* {
       schema: 2, id, rev, date, title, status, author, crs, basis,
       numbers: [{ key, label, value, unit?, dp? }],     the panel, in this order
       params:  [{ key, label, value, unit?, dp? }],
       surface: { name, color, opacity, on },            the 3D surface row
       layers:  [{ key, name, kind, color, weight?, dash?, fill?, on?, three?, color3d?,
                   features: [{ pts | pt, closed?, props }] }],
       raster:  { png, w, h, x0, y0, cell, zmin, step }  cap elevation, terrain PNG encoding
     }
     kind   "poly" filled polygon, "line" polyline, "point" marker, "note" numbered note
     three  "level" = in 3D this layer is drawn at each feature's props.elev_ft (the cap
            contours) and not draped on the ground like every other line
     A schema 1 file (the first export) is read too: its points, segments and
     sections become layers and its number keys become their own labels.

     norm() returns a clean copy or throws an Error whose message says, in plain
     words, what is wrong. Everything that reaches the page goes through here:
     text is cut to length and escaped where it is used, colours and dashes must
     look like colours and dashes, every coordinate must be a number on the site. */
  function siteBox() {
    const m = SBMM.demSite && SBMM.demSite.m;
    if (!m) return null;
    const pad = 1000;
    return [m.x0 - pad, m.y0 - pad, m.x0 + m.w * m.cell + pad, m.y0 + m.h * m.cell + pad];
  }
  const bad = msg => { throw new Error(msg); };
  const color = (v, dflt) => /^#[0-9a-fA-F]{6}$/.test(v || "") ? v : dflt;

  function entries(v, what) {
    /* [{ key, label, value, unit, dp }] or, in a schema 1 file, { key: value } */
    let list = [];
    if (Array.isArray(v)) list = v;
    else if (v && typeof v === "object") list = Object.keys(v).map(k => ({ key: k, value: v[k] }));
    else if (v != null) bad(`"${what}" is not a list`);
    if (list.length > 60) bad(`"${what}" has more than 60 entries`);
    const seen = new Set();
    return list.map((e, i) => {
      if (!e || typeof e !== "object") bad(`"${what}" entry ${i + 1} is not an object`);
      const key = str(e.key, 40);
      if (!key || seen.has(key)) bad(`"${what}" entry ${i + 1} has no key of its own`);
      seen.add(key);
      const value = typeof e.value === "number" ? e.value : str(e.value, 80);
      if (typeof value === "number" && !isFinite(value)) bad(`"${what}" value "${key}" is not a number`);
      const dp = fin(e.dp) ? Math.max(0, Math.min(6, Math.round(e.dp))) : null;
      return { key, label: str(e.label, 80) || key.replace(/_/g, " "), value, unit: str(e.unit, 20), dp };
    });
  }

  function props(p) {
    const out = {};
    if (!p || typeof p !== "object") return out;
    let n = 0;
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (n >= 16) break;
      if (typeof v === "number" ? isFinite(v) : typeof v === "boolean") out[str(k, 30)] = v;
      else if (typeof v === "string") out[str(k, 30)] = str(v, 600);
      else continue;
      n++;
    }
    return out;
  }

  function norm(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("the file is not a cap design (no design object in it)");
    if (raw.schema !== 1 && raw.schema !== 2) bad("the file is not a cap design (schema 1 or 2 expected)");
    const rev = str(raw.rev, 40).trim();
    if (!rev) bad("the design has no revision id (rev)");
    if (!Array.isArray(raw.layers) || !raw.layers.length) bad("the design has no layers");
    if (raw.layers.length > 60) bad("the design has more than 60 layers");
    const B = siteBox();
    let npts = 0;
    const xy = (p, where) => {
      if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1])) bad(`a coordinate in ${where} is not a number`);
      if (B && (p[0] < B[0] || p[1] < B[1] || p[0] > B[2] || p[1] > B[3]))
        bad(`a coordinate in ${where} is off the site (E ${Math.round(p[0])}, N ${Math.round(p[1])}). State Plane feet expected`);
      if (++npts > MAX_PTS) bad("the design has more than " + MAX_PTS + " points");
      return [p[0], p[1]];
    };
    const src = raw.layers.slice();
    if (raw.schema === 1) {
      /* the first export carried these three beside the layers */
      const has = k => src.some(l => l && l.key === k);
      if (Array.isArray(raw.points) && !has("points")) src.push({ key: "points", name: "Rim low points and survey", kind: "point",
        color: "#FFD400", features: raw.points.map(p => ({ pt: [p.x, p.y], props: p })) });
      if (Array.isArray(raw.segments) && !has("segments")) src.push({ key: "segments", name: "Perimeter segment notes", kind: "note",
        color: "#FFFFFF", features: raw.segments.map(s => ({ pt: [s.x, s.y],
          props: { id: s.n, name: s.name, edge_ft: s.edge_ft, note: s.text } })) });
      if (Array.isArray(raw.sections) && !has("sections")) src.push({ key: "sections", name: "Section lines", kind: "line",
        color: "#00E5FF", dash: "8 6", on: false, features: raw.sections.map(s => ({ pts: s.pts, closed: false,
          props: { name: "Section " + str(s.name, 20), label: s.name } })) });
    }
    const seen = new Set();
    const layers = src.map((l, i) => {
      if (!l || typeof l !== "object") bad(`layer ${i + 1} is not an object`);
      const key = str(l.key, 24);
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) bad(`layer ${i + 1} has no usable key (lower case letters, digits, underscore)`);
      if (seen.has(key)) bad(`two layers share the key "${key}"`);
      seen.add(key);
      if (!KINDS[l.kind]) bad(`layer "${key}" has the kind "${str(l.kind, 20)}" (poly, line, point or note expected)`);
      if (!Array.isArray(l.features)) bad(`layer "${key}" has no features list`);
      if (l.features.length > 20000) bad(`layer "${key}" has more than 20,000 features`);
      const marks = l.kind === "point" || l.kind === "note";
      const features = l.features.map((f, k) => {
        const where = `layer "${key}", feature ${k + 1}`;
        if (!f || typeof f !== "object") bad(where + " is not an object");
        const p = props(f.props);
        if (marks) return { pt: xy(f.pt, where), props: p };
        if (!Array.isArray(f.pts) || f.pts.length < (l.kind === "poly" ? 3 : 2)) bad(where + " has too few points");
        return { pts: f.pts.map(q => xy(q, where)), closed: l.kind === "poly" || !!f.closed, props: p };
      });
      const three = l.three === "level" ? "level" : "";
      if (three && marks) bad(`layer "${key}" is a ${l.kind} layer and cannot be drawn as "${three}" in 3D`);
      if (three === "level" && !features.some(f => fin(f.props.elev_ft)))
        bad(`layer "${key}" is marked "level" for 3D but none of its features has an elev_ft`);
      return { key, name: str(l.name, 80) || key, kind: l.kind, color: color(l.color, "#D40000"),
               color3d: color(l.color3d, ""), weight: fin(l.weight) ? Math.max(0.3, Math.min(8, l.weight)) : 1.5,
               dash: /^[0-9. ]{1,24}$/.test(l.dash || "") ? l.dash : "",
               fill: fin(l.fill) ? Math.max(0, Math.min(1, l.fill)) : 0.1,
               on: l.on !== false, three, features };
    });

    const r = raw.raster;
    if (!r || typeof r !== "object") bad("the design has no cap surface raster");
    if (typeof r.png !== "string" || r.png.indexOf("data:image/png;base64,") !== 0) bad("the cap surface raster is not a PNG data URL");
    const whole = v => fin(v) && Math.round(v) === v;
    if (!whole(r.w) || !whole(r.h) || r.w < 2 || r.h < 2) bad("the cap surface raster has no usable size (w, h)");
    if (r.w > MAX_SIDE || r.h > MAX_SIDE || r.w * r.h > MAX_CELLS)
      bad(`the cap surface raster is ${r.w} x ${r.h} cells. The most this viewer takes is ${MAX_SIDE} on a side and ${MAX_CELLS} in all`);
    if (!fin(r.cell) || r.cell <= 0 || r.cell > 200) bad("the cap surface raster has no usable cell size (ft)");
    if (!fin(r.x0) || !fin(r.y0)) bad("the cap surface raster has no origin (x0, y0)");
    xy([r.x0, r.y0], "the cap surface raster origin");
    xy([r.x0 + (r.w - 1) * r.cell, r.y0 + (r.h - 1) * r.cell], "the cap surface raster far corner");
    if (!fin(r.zmin) || !fin(r.step) || r.step <= 0 || r.step > 10) bad("the cap surface raster has no usable zmin and step");
    if (r.zmin < -1500 || r.zmin + 65535 * r.step > 40000) bad("the cap surface raster elevations are out of range (ft)");

    const s = raw.surface && typeof raw.surface === "object" ? raw.surface : {};
    return {
      schema: raw.schema, id: str(raw.id, 40), rev, date: str(raw.date, 20), title: str(raw.title, 120) || "Cap design",
      status: str(raw.status, 300), author: str(raw.author, 80), crs: str(raw.crs, 120), basis: str(raw.basis, 200),
      numbers: entries(raw.numbers, "numbers"), params: entries(raw.params, "params"),
      surface: { name: str(s.name, 60) || "Cap surface in 3D", color: color(s.color, "#3B82F6"),
                 opacity: fin(s.opacity) ? Math.max(0.05, Math.min(1, s.opacity)) : 0.62, on: s.on !== false },
      layers,
      raster: { png: r.png, w: r.w, h: r.h, x0: r.x0, y0: r.y0, cell: r.cell, zmin: r.zmin, step: r.step }
    };
  }
  /* Is this parsed JSON meant as a cap design file? js/io.js asks before it
     treats a dropped or imported .json as GeoJSON, so a cap design dropped
     anywhere on the app lands here, and one that is wrong is refused here, with
     the reason, instead of failing as a GeoJSON import. */
  function looksLike(o) {
    return !!(o && typeof o === "object" && !Array.isArray(o) && typeof o.schema === "number"
      && o.rev != null && o.raster && typeof o.raster === "object" && Array.isArray(o.layers));
  }
  /* null when the object is a usable design, otherwise the reason (no raster decode) */
  function validate(raw) { try { norm(raw); return null; } catch (e) { return e.message; } }

  /* The raster: the PNG's own header must agree with w and h before a pixel is
     read (a canvas would stretch or crop without a word), and there must be at
     least one cap elevation in it. */
  async function decode(r) {
    let bin = "";
    try { bin = atob(r.png.slice(r.png.indexOf(",") + 1)); } catch (e) { bad("the cap surface raster is not valid base64"); }
    const b = i => bin.charCodeAt(i);
    if (bin.length < 33 || b(0) !== 0x89 || b(1) !== 0x50 || b(2) !== 0x4E || b(3) !== 0x47) bad("the cap surface raster is not a PNG image");
    const u32 = i => ((b(i) << 24) | (b(i + 1) << 16) | (b(i + 2) << 8) | b(i + 3)) >>> 0;
    const pw = u32(16), ph = u32(20);
    if (pw !== r.w || ph !== r.h) bad(`the cap surface raster says ${r.w} x ${r.h} cells but its image is ${pw} x ${ph}`);
    let g = null;
    try { g = await Dem.context(r.png, { w: r.w, h: r.h }); } catch (e) { bad("the cap surface raster image could not be read"); }
    const px = g.getImageData(0, 0, r.w, r.h).data;
    const z = new Float32Array(r.w * r.h);
    let n = 0, lo = Infinity, hi = -Infinity;
    for (let row = 0; row < r.h; row++) {
      const dst = r.h - 1 - row;                       // row 0 of the image is the north edge
      for (let c = 0; c < r.w; c++) {
        const i = (row * r.w + c) * 4, v = px[i] * 256 + px[i + 1];
        if (v === 0) { z[dst * r.w + c] = NaN; continue; }
        const e = r.zmin + (v - 1) * r.step;
        z[dst * r.w + c] = e; n++;
        if (e < lo) lo = e;
        if (e > hi) hi = e;
      }
    }
    if (!n) bad("the cap surface raster has no cap elevations in it");
    const dem = new Dem({ x0: r.x0, y0: r.y0, cell: r.cell, w: r.w, h: r.h, zmin: r.zmin, step: r.step }, z);
    dem.capStats = { cells: n, lo, hi };
    return dem;
  }

  /* cap elevation, existing ground and fill depth at a State Plane point */
  function at(x, y) {
    let cap = NaN;
    if (capDem && capDem.inside(x, y)) {
      /* nearest node first: the raster is no data outside the fill limit, and
         bilinear across that edge would invent a value */
      const m = capDem.m, i = Math.round((x - m.x0) / m.cell), j = Math.round((y - m.y0) / m.cell);
      if (i >= 0 && j >= 0 && i < m.w && j < m.h && !isNaN(capDem.atGrid(i, j))) cap = capDem.at(x, y);
    }
    const g = SBMM.elev ? SBMM.elev(x, y) : [NaN, ""];
    const ground = g[0];
    return { cap, ground, src: g[1], depth: (isNaN(cap) || isNaN(ground)) ? NaN : cap - ground };
  }
  function number(key) {
    if (!D) return null;
    const e = D.numbers.find(q => q.key === key) || D.params.find(q => q.key === key);
    return e ? e.value : null;
  }

  /* ------------------------------------------------------------------ */
  /* the last loaded file, kept on the device                            */
  /* ------------------------------------------------------------------ */
  function stored() {
    try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function remember(raw, name) {
    let ok = false;
    try {
      const s = JSON.stringify({ name, t: Date.now(), design: raw });
      if (s.length <= KEEP_MAX) { localStorage.setItem(STORE_KEY, s); ok = true; }
    } catch (e) { ok = false; }
    if (!ok) forget();
    return ok;
  }
  function forget() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }

  /* ------------------------------------------------------------------ */
  /* 2D                                                                  */
  /* ------------------------------------------------------------------ */
  function attr(pairs) {
    return '<table class="capattr">' + pairs.filter(p => p[1] != null && p[1] !== "")
      .map(p => `<tr><td>${esc(p[0])}</td><td>${esc(p[1])}</td></tr>`).join("") + "</table>";
  }
  function head() { return `<b>${esc(D.title)}, ${esc(D.rev)}</b>`; }
  function reading(x, y) {
    const q = at(x, y);
    if (isNaN(q.cap)) return [];
    return [["Cap surface here (ft)", nf(q.cap, 1)],
            ["Existing ground (ft)", nf(q.ground, 1) + (q.src ? "  " + q.src : "")],
            ["Fill depth (ft)", isNaN(q.depth) ? null : nf(q.depth, 1)]];
  }
  function featPopup(layer, f, x, y) {
    const p = f.props;
    const pairs = [["Layer", layer.name]];
    if (p.id != null) pairs.push(["Note", String(p.id)]);
    if (fin(p.area_ac)) pairs.push(["Area (ac)", nf(p.area_ac, 2)]);
    if (fin(p.elev_ft)) pairs.push([layer.three === "level" ? "Cap elevation (ft)" : "Elevation (ft)", nf(p.elev_ft, p.elev_ft % 1 ? 2 : 0)]);
    if (fin(p.depth_ft)) pairs.push(["Fill depth (ft)", nf(p.depth_ft, 0)]);
    if (p.edge_ft != null) pairs.push(["Cap edge (ft)", String(p.edge_ft)]);
    if (layer.kind === "poly" && fin(x)) for (const r of reading(x, y)) pairs.push(r);
    if (fin(x)) pairs.push(["Easting (ft)", nf(x, 1)], ["Northing (ft)", nf(y, 1)]);
    return head() + `<br>${esc(p.name || layer.name)}` + attr(pairs)
      + (p.note ? `<span class="capnote">${esc(p.note)}</span>` : "");
  }
  function tipOf(layer, f) {
    const p = f.props;
    if (layer.kind === "note") return `<b>${esc(p.id != null ? p.id + ". " : "")}${esc(p.name || layer.name)}</b>`;
    if (layer.kind === "point") return `<b>${esc(p.name || layer.name)}</b>` + (fin(p.elev_ft) ? " " + nf(p.elev_ft, 1) + " ft" : "");
    if (fin(p.elev_ft)) return "Cap " + nf(p.elev_ft, 0) + " ft";
    if (fin(p.depth_ft)) return "Fill depth " + nf(p.depth_ft, 0) + " ft";
    return esc(p.name || layer.name);
  }

  function fill(layer) {
    const grp = H[layer.key].group;
    grp.clearLayers();
    for (const f of layer.features) {
      const p = f.props;
      let lyr;
      if (layer.kind === "point") {
        lyr = L.circleMarker(ll(f.pt), { pane: "vectors", radius: 6, color: "#12181C", weight: 1.5,
          fillColor: color(p.color, layer.color), fillOpacity: 1 });
      } else if (layer.kind === "note") {
        lyr = L.marker(ll(f.pt), { pane: "vectors", icon: L.divIcon({ className: "capseg", iconSize: [22, 22], iconAnchor: [11, 11],
          html: `<span style="border-color:${layer.color === "#FFFFFF" ? "#D40000" : layer.color}">${esc(str(p.id != null ? p.id : "", 3))}</span>` }) });
      } else {
        const st = { pane: "vectors", color: layer.color, weight: layer.weight * (p.major ? 1.9 : 1), dashArray: layer.dash || null };
        const pts = f.pts.map(ll);
        if (layer.kind === "poly") lyr = L.polygon(pts, Object.assign(st, { fillColor: layer.color, fillOpacity: layer.fill }));
        else lyr = f.closed ? L.polygon(pts, Object.assign(st, { fill: false })) : L.polyline(pts, st);
      }
      lyr.bindTooltip(tipOf(layer, f), { sticky: true, className: "ctip" });
      lyr.on("click", e => {
        const at2 = f.pt ? { lng: f.pt[0], lat: f.pt[1] } : e.latlng;
        L.popup().setLatLng(f.pt ? ll(f.pt) : e.latlng).setContent(featPopup(layer, f, at2.lng, at2.lat)).openOn(SBMM.map);
      });
      lyr.addTo(grp);
    }
  }

  /* A row per layer of the file. EVERY ROW STARTS OFF: this is a draft concept
     and nobody's map should change because the app was updated. "show cap
     layers" (and loading a file) switches on what the file marks `on`.
     Rows cannot be taken out of the layer state
     once made, so a row whose layer the design in use does not have is hidden
     and emptied, and comes back if a later file has that key again. */
  function ensureRow(layer) {
    let h = H[layer.key];
    const id = "cap_" + layer.key;
    if (!h) {
      const group = L.layerGroup();
      const ref = SBMM.addLayerRow(GROUP, esc(layer.name), group,
        { id, checked: false, swatch: layer.color, sub: SUB, subTitle: "The cap design file in use, layer by layer" });
      h = H[layer.key] = { key: layer.key, group, ref };
    } else {
      const lbl = h.ref.row.querySelector(".lbl"), sw = h.ref.row.querySelector(".sw");
      if (lbl) lbl.textContent = layer.name;
      if (sw) sw.style.background = layer.color;
      SBMM.layerState.define(SG, id, { label: layer.name, swatch: layer.color });
    }
    h.ref.row.classList.remove("capgone");
    h.ref.row.title = D ? D.title + ": " + layer.name : layer.name;
    return h;
  }
  /* the 3D surface row: made with the first design, because a row that is on
     must have something to draw (the 3D parity rule) */
  function surfaceRow() {
    if (surfRow || !D) return;
    const s = D.surface;
    surfRow = SBMM.addLayerRow(GROUP, esc(s.name), null,
      { id: ROW_SURF, checked: false, swatch: s.color, opacity: s.opacity, sub: SUB,
        onChange: st => {
          /* the slider moves the live material: an opacity change does not rebuild the 3D overlay */
          if (!liveMat || !st) return;
          setOpacity(liveMat, st.opacity);
          if (SBMM.viewer3d && SBMM.viewer3d.requestRender) SBMM.viewer3d.requestRender();
        } });
    surfRow.row.title = "The cap surface as a see-through mesh in the 3D view. The slider sets how solid it is.";
  }
  /* a row whose layer the design in use does not have: hidden, emptied, off */
  function hideRow(ref) {
    ref.row.classList.add("capgone");
    if (SBMM.layerState.isOn(SG, ref.id)) SBMM.layerState.set(SG, ref.id, { on: false });
  }
  function setOpacity(mat, v) {
    const o = Math.max(0.05, Math.min(1, fin(v) ? v : 0.62));
    mat.opacity = o; mat.transparent = o < 1; mat.depthWrite = o >= 1; mat.needsUpdate = true;
    last3d.opacity = o;
  }

  function bbox() {
    const r = D && D.raster;
    return r ? [r.x0, r.y0, r.x0 + (r.w - 1) * r.cell, r.y0 + (r.h - 1) * r.cell] : null;
  }
  function zoomTo() {
    const b = bbox();
    if (b && SBMM.map) SBMM.map.fitBounds([[b[1] - 60, b[0] - 60], [b[3] + 60, b[2] + 60]]);
  }
  /* open the Layers pane on the catalogue, at this module's rows and panel */
  function openPanel() {
    if (SBMM.layersPanel && SBMM.layersPanel.findInCatalog) SBMM.layersPanel.findInCatalog(SG, ROW_SURF);
    requestAnimationFrame(() => { if (panel && typeof scrollIntoPane === "function") scrollIntoPane(panel); });
  }
  /* switch on what the file says is on by default, and the 3D surface */
  function show() {
    if (!D) return;
    const list = D.layers.filter(l => l.on).map(l => ({ group: SG, layer: "cap_" + l.key, on: true }));
    if (D.surface.on) list.push({ group: SG, layer: ROW_SURF, on: true });
    SBMM.layerState.batch(list);
  }

  /* ------------------------------------------------------------------ */
  /* the panel                                                           */
  /* ------------------------------------------------------------------ */
  function activeLine() {
    if (!D) return "No cap design in use";
    const what = SRC.kind === "loaded"
      ? "Loaded file " + SRC.name + (SRC.kept ? ", kept on this device" : ", this visit only")
      : "Built in design";
    return what + ". Rev " + D.rev + (D.date ? ", " + D.date : "");
  }
  function numRows(list) {
    return attr(list.map(e => [e.label + (e.unit ? " (" + e.unit + ")" : ""),
      typeof e.value === "number" ? nf(e.value, e.dp != null ? e.dp : (e.value % 1 ? 2 : 0)) : e.value]));
  }
  function renderPanel() {
    if (!panel) return;
    /* the heading, which design is active, then the controls: the load button
       must not sit below a long list of notes */
    let h = D
      ? `<div class="caprev"><b>${esc(D.title)}</b></div>`
        + `<div class="capactive" id="capActive" data-src="${esc(SRC.kind)}" data-rev="${esc(D.rev)}">${esc(activeLine())}</div>`
        + (D.status ? `<div class="capnote">${esc(D.status)}</div>` : "")
      : `<div class="capactive" id="capActive" data-src="none" data-rev="">No cap design in this build. Load a cap design file to see one.</div>`;
    h += '<div class="capbtns">'
      + (D ? '<button class="minib" id="capZoom" title="Zoom the 2D map to the cap">zoom to cap</button>'
           + '<button class="minib" id="capShow" title="Switch on the layers the design file shows by default">show cap layers</button>' : "")
      + '<button class="minib" id="capLoad" title="Load a cap design json file from this computer. Nothing is uploaded: the file is read in the browser.">Load cap design file</button>'
      + `<button class="minib" id="capReset" title="Forget the loaded file and go back to the design that ships with the app"${SRC.kind === "loaded" ? "" : " disabled"}>Reset to built in design</button>`
      + '<input type="file" id="capFile" accept=".json,application/json" style="display:none"></div>'
      + '<div class="capnote capdrop">Or drop a cap design file on this panel.</div>'
      + (builtIns.length > 1
          ? '<div class="capbis" id="capBuiltins"><span>Built in designs</span>' + builtIns.map(d =>
              `<button class="minib capbi${SRC.kind === "builtin" && D === d ? " active" : ""}" data-rev="${esc(d.rev)}" title="${esc(d.title + ", " + d.rev)}">${esc(d.rev)}</button>`).join("") + "</div>" : "")
      + (D && D.layers.some(l => l.three === "level")
          ? `<label class="capopt" title="Draw the cap contours at their own elevation in the 3D view. Off leaves them on the 2D map only."><input type="checkbox" id="capLevel3d"${UI.level3d ? " checked" : ""}> cap contours in 3D</label>` : "")
      + `<div class="capmsg" id="capMsg">${esc(lastMsg)}</div>`;
    if (D) {
      h += (D.numbers.length ? `<div id="capNumbers">${numRows(D.numbers)}</div>` : "")
        + (D.params.length ? `<div class="capsub">Parameters</div><div id="capParams">${numRows(D.params)}</div>` : "");
      const notes = [];
      for (const l of D.layers) if (l.kind === "note") for (const f of l.features) notes.push(f.props);
      if (notes.length) h += `<details class="capnotes" id="capNotes"><summary>Perimeter notes (${notes.length})</summary>`
        + notes.map(p => `<div class="capn"><b>${esc(p.id != null ? p.id + ". " : "")}${esc(p.name || "")}</b>`
          + (p.edge_ft != null ? ` <span class="mut">cap edge ${esc(String(p.edge_ft))} ft</span>` : "")
          + `<br>${esc(p.note || "")}</div>`).join("") + "</details>";
      const small = [D.basis, D.crs, D.author].filter(Boolean).join(" ");
      if (small) h += `<div class="capnote">${esc(small)}</div>`;
    }
    panel.innerHTML = h;
    const q = id => panel.querySelector("#" + id);
    if (q("capZoom")) q("capZoom").onclick = zoomTo;
    if (q("capShow")) q("capShow").onclick = () => { show(); zoomTo(); };
    const inp = q("capFile");
    q("capLoad").onclick = () => inp.click();
    inp.onchange = () => { if (inp.files && inp.files[0]) loadFile(inp.files[0]); inp.value = ""; };
    q("capReset").onclick = () => reset();
    if (q("capLevel3d")) q("capLevel3d").onchange = e => setLevel3d(e.target.checked);
    panel.querySelectorAll(".capbi").forEach(b => { b.onclick = () => pick(b.dataset.rev); });
  }
  function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(UI)); } catch (e) {} }
  function setLevel3d(on) {
    UI.level3d = !!on;
    saveUI();
    const el = panel && panel.querySelector("#capLevel3d");
    if (el) el.checked = UI.level3d;
    refresh3d();
  }
  function say(msg, ms) {
    lastMsg = msg || "";
    const el = panel && panel.querySelector("#capMsg");
    if (el) el.textContent = lastMsg;
    if (msg && typeof toast === "function") toast(msg, ms || 5200);
  }

  /* ------------------------------------------------------------------ */
  /* putting a design in use                                             */
  /* ------------------------------------------------------------------ */
  function dropMesh() {
    if (meshGeom) meshGeom.dispose();
    meshGeom = null; meshKey = ""; liveMat = null; liveMesh = null;
  }
  function refresh3d() {
    if (SBMM.viewer3d && SBMM.viewer3d.refreshOverlays) SBMM.viewer3d.refreshOverlays("cap");
  }
  /* the rows and their contents follow the design; the panel is redrawn */
  function use(design, dem, src) {
    D = design; capDem = dem || null; SRC = src;
    dropMesh();
    const keys = new Set();
    if (D) for (const l of D.layers) { keys.add(l.key); ensureRow(l); fill(l); }
    for (const k in H) if (!keys.has(k)) { H[k].group.clearLayers(); hideRow(H[k].ref); }
    surfaceRow();
    if (surfRow) {
      if (D) {
        const lbl = surfRow.row.querySelector(".lbl");
        if (lbl) lbl.textContent = D.surface.name;
        SBMM.layerState.define(SG, ROW_SURF, { label: D.surface.name, swatch: D.surface.color });
        surfRow.row.classList.remove("capgone");
      } else hideRow(surfRow);
    }
    place();
    renderPanel();
    refresh3d();
    if (SBMM.events && SBMM.events.emit) SBMM.events.emit("capdesign", { rev: D ? D.rev : null, source: SRC.kind });
  }
  /* The panel sits last in the rows' own sub-group. A build with no design has
     no rows and so no sub-group yet: the panel then stands under a heading of
     its own at the end of Site framework, and moves when a file is loaded. */
  function place() {
    if (!panel) return;
    const body = surfRow && surfRow.row.parentNode;
    if (body) {
      if (headEl) { headEl.remove(); headEl = null; }
      body.appendChild(panel);
      return;
    }
    const host = $("projLayers");
    if (!headEl) { headEl = document.createElement("div"); headEl.className = "lsub caphead"; headEl.textContent = SUB; }
    host.appendChild(headEl); host.appendChild(panel);
  }

  /* Load a design object (what a file parses to). Nothing in use is touched
     until the whole file has passed: the checks in norm() and the raster decode.
       opts.keep  false = do not store it on the device
       opts.show  false = leave the layer switches as they are
     Resolves { ok: true, rev } or { ok: false, error }. */
  async function load(raw, name, opts) {
    opts = opts || {};
    name = str(name, 120) || "file";
    let cand = null, dem = null;
    try { cand = norm(raw); dem = await decode(cand.raster); }
    catch (e) { return refuse(name, e && e.message ? e.message : String(e)); }
    const kept = opts.keep === false ? false : remember(raw, name);
    use(cand, dem, { kind: "loaded", name, kept });
    ready = Promise.resolve(dem);
    if (opts.show !== false) show();
    say(`Cap design ${cand.rev} loaded from ${name}.` + (kept || opts.keep === false ? "" : " It could not be stored on this device, so it lasts for this visit only."));
    return { ok: true, rev: cand.rev, kept };
  }
  function refuse(name, why) {
    say(`Cap design file refused (${name}): ${why}. The design in use was not changed.`, 8000);
    return { ok: false, error: why };
  }
  function loadText(text, name) {
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) { return Promise.resolve(refuse(str(name, 120) || "file", "it is not a JSON file")); }
    return load(obj, name);
  }
  function loadFile(file) {
    return new Promise(res => {
      if (!file) { res({ ok: false, error: "no file" }); return; }
      if (file.size > 30e6) { res(refuse(file.name, "it is larger than 30 MB")); return; }
      const rd = new FileReader();
      rd.onerror = () => res(refuse(file.name, "the browser could not read it"));
      rd.onload = () => loadText(String(rd.result), file.name).then(res);
      rd.readAsText(file);
    });
  }
  /* back to the design that ships with the app; the stored file is forgotten */
  async function reset() {
    forget();
    if (!builtIn) { use(null, null, { kind: "none", name: "", kept: false }); say("The loaded cap design was removed. This build has no built in design."); return { ok: true, rev: null }; }
    let dem = null;
    try { dem = await decode(builtIn.raster); } catch (e) { console.warn("cap design: built in raster", e); }
    use(builtIn, dem, { kind: "builtin", name: "", kept: false });
    ready = Promise.resolve(dem);
    say(`Back to the built in cap design, ${builtIn.rev}.`);
    return { ok: true, rev: builtIn.rev };
  }

  /* one of the built in designs, by its rev: it becomes the design in use and
     the one Reset goes back to. A loaded file is forgotten, as with Reset. */
  async function pick(rev) {
    const d = builtIns.find(b => b.rev === rev);
    if (!d) return { ok: false, rev: D ? D.rev : null };
    builtIn = d; UI.builtin = d.rev; saveUI();
    const r = await reset();
    say(`Built in cap design ${d.rev}.`);
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* build (called once from js/boot.js)                                 */
  /* ------------------------------------------------------------------ */
  function css() {
    const st = document.createElement("style");
    st.textContent = ".capseg span{display:block;width:20px;height:20px;line-height:20px;border-radius:50%;background:#fff;"
      + "border:2px solid #D40000;color:#111;font:700 12px/20px sans-serif;text-align:center}"
      + ".capattr{border-collapse:collapse;margin:4px 0;font-size:11px}.capattr td{padding:1px 8px 1px 0;vertical-align:top}"
      + ".capattr td:last-child{font-variant-numeric:tabular-nums;white-space:nowrap}"
      + ".capnote{display:block;opacity:.75;font-size:11px;max-width:280px;white-space:normal}"
      + ".capinfo{margin:4px 2px 8px 22px;font-size:11px;border:1px dashed transparent;border-radius:6px;padding:2px 4px}"
      + ".capinfo.capover{border-color:#4F9BFF;background:rgba(79,155,255,.10)}"
      + ".capactive{margin:2px 0;font-weight:600}.capactive[data-src=loaded]{color:#E8B34B}"
      + ".capsub{margin-top:5px;opacity:.7;text-transform:uppercase;font-size:10px;letter-spacing:.04em}"
      + ".capnotes{margin:4px 0}.capnotes summary{cursor:pointer}.capn{margin:4px 0 4px 8px;max-width:270px;white-space:normal}"
      + ".capbtns{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}.capbtns .minib[disabled]{opacity:.45;cursor:default}"
      + ".capopt{display:flex;align-items:center;gap:6px;margin:5px 0 2px;cursor:pointer}.caphead{margin:8px 0 2px 2px}"
      + ".capmsg{margin-top:4px;font-size:11px;max-width:280px;white-space:normal;color:#E8B34B}.capmsg:empty{display:none}"
      + ".capbis{margin:6px 0 2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.capbis span{opacity:.75}"
      + ".lyr.capgone{display:none !important}";
    document.head.appendChild(st);
  }
  function build() {
    if (built) return;
    built = true;
    if (!$("projLayers") || !SBMM.addLayerRow) return;
    css();
    try {
      const u = JSON.parse(localStorage.getItem(UI_KEY) || "null");
      if (u && typeof u.level3d === "boolean") UI.level3d = u.level3d;
      if (u && typeof u.builtin === "string") UI.builtin = u.builtin;
    } catch (e) {}
    /* the built in designs: cap_design is the default, cap_design_<x> are further options, in name order */
    const pay = window.SBMM_DATA || {};
    const names = Object.keys(pay).filter(k => /^cap_design_/.test(k)).sort();
    if (pay.cap_design) names.unshift("cap_design");
    for (const k of names) {
      try { const d = norm(pay[k]); if (!builtIns.some(b => b.rev === d.rev)) builtIns.push(d); }
      catch (e) { console.warn("cap design: the built in design " + k + " was refused:", e.message); }
    }
    builtIn = builtIns.find(b => b.rev === UI.builtin) || builtIns[0] || null;
    let start = builtIn, src = { kind: builtIn ? "builtin" : "none", name: "", kept: false }, note = "";
    const st = stored();
    if (st && st.design) {
      try { start = norm(st.design); src = { kind: "loaded", name: str(st.name, 120) || "file", kept: true }; }
      catch (e) { forget(); note = `The cap design stored on this device could not be used (${e.message}). Showing the built in design.`; }
    }
    panel = document.createElement("div");
    panel.className = "capinfo"; panel.id = "capPanel";
    /* a file dropped on the panel is a cap design; anywhere else it is the app's own import */
    panel.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); panel.classList.add("capover"); });
    panel.addEventListener("dragleave", () => panel.classList.remove("capover"));
    panel.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation(); panel.classList.remove("capover");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    lastMsg = note;
    use(start, null, src);
    if (start) {
      const mine = start;
      ready = decode(start.raster).then(dem => {
        if (D !== mine) return capDem;             // another design was put in use meanwhile
        capDem = dem; dropMesh(); refresh3d();
        return dem;
      }).catch(async e => {
        console.warn("cap design raster", e);
        if (D !== mine) return capDem;
        if (src.kind === "loaded") {               // the stored file went bad: the built in design takes over
          const why = `The cap design stored on this device could not be used (${e.message}). Showing the built in design.`;
          await reset(); say(why);
          return capDem;
        }
        say("The built in cap surface could not be read: " + e.message);
        return null;
      });
    }
    /* what the cap reads at a point: the pointer chip and the Point card (js/readout.js) */
    if (SBMM.readout) SBMM.readout.register({ id: "capdesign", order: 34,
      on: () => !!(D && capDem && (rowOn(ROW_SURF) || D.layers.some(l => isOn(l.key)))),
      at(x, y) {
        const q = at(x, y);
        if (isNaN(q.cap)) return null;
        const d = isNaN(q.depth) ? "" : ", fill " + nf(q.depth, 1) + " ft";
        return { name: "Cap design " + D.rev, value: "cap " + nf(q.cap, 1) + " ft" + d, key: q.cap.toFixed(1),
                 rows: [["Cap surface (" + D.rev + ")", nf(q.cap, 1) + " ft"]].concat(isNaN(q.depth) ? [] : [["Fill depth to cap", nf(q.depth, 1) + " ft"]]) };
      } });
  }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  /* Called from the "cap" section of js/overlays3d.js with that pass's frame
     ({ CX, CY, ZMID }). Returns what the section adds, each with the layer row
     that switches it:
       { row, object }                       a finished THREE object
       { row, pts, color, closed, width }    a line for the section to drape
       { row, points, color, size }          dots for the section to put on the ground
     EVERY LAYER THAT IS ON DRAWS SOMETHING, under its own row: that is the
     app's 3D parity rule, and both e2e harnesses check it with every row on.
     Everything lands in the overlay group, which carries the relief setting.
     The mesh geometry is built once per design and frame and marked shared, so
     a layer switch does not rebuild it; its material is new each pass because
     the section disposes the materials of what it replaces. */
  function meshGeometry(c) {
    const key = D.rev + "|" + D.raster.png.length + "|" + c.CX + "|" + c.CY + "|" + c.ZMID;
    if (meshGeom && key === meshKey) return meshGeom;
    if (meshGeom) meshGeom.dispose();
    const m = capDem.m, w = m.w, hh = m.h, mid = (capDem.capStats.lo + capDem.capStats.hi) / 2;
    const pos = new Float32Array(w * hh * 3);
    for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 3, zz = capDem.z[j * w + i];
      pos[k] = m.x0 + i * m.cell - c.CX; pos[k + 1] = m.y0 + j * m.cell - c.CY;
      pos[k + 2] = (isNaN(zz) ? mid : zz) - c.ZMID + 0.6;
    }
    const idx = [];
    for (let j = 0; j < hh - 1; j++) for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, cc = a + w, d = cc + 1;
      if (isNaN(capDem.z[a]) || isNaN(capDem.z[b]) || isNaN(capDem.z[cc]) || isNaN(capDem.z[d])) continue;
      idx.push(a, b, cc, b, d, cc);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.userData.shared = true;                       // the section must not dispose it (js/viewer3d.js disposeSection)
    meshGeom = g; meshKey = key;
    return g;
  }
  function objects3d(c) {
    const out = [];
    last3d.calls++; last3d.objects = 0; last3d.tris = 0; last3d.drape = 0; last3d.dots = 0; last3d.level = 0;
    liveMat = null; liveMesh = null;
    if (!D || !c || typeof THREE === "undefined") return out;
    const hex = s => new THREE.Color(s).getHex();
    if (capDem && rowOn(ROW_SURF)) {
      const g = meshGeometry(c);
      const mat = new THREE.MeshLambertMaterial({ color: hex(D.surface.color), side: THREE.DoubleSide });
      const st = SBMM.layerState.get ? SBMM.layerState.get(SG, ROW_SURF) : null;
      setOpacity(mat, st && fin(st.opacity) ? st.opacity : D.surface.opacity);
      const o = new THREE.Mesh(g, mat);
      o.renderOrder = 3;
      o.userData.capDesign = "surface";
      liveMat = mat; liveMesh = o;
      last3d.tris = g.index ? g.index.count / 3 : 0;
      out.push({ row: ROW_SURF, object: o });
    }
    for (const l of D.layers) {
      if (!isOn(l.key)) continue;
      const row = "cap_" + l.key, col = hex(l.color3d || l.color);
      if (l.kind === "point" || l.kind === "note") {
        out.push({ row, points: l.features.map(f => f.pt), color: col, size: l.kind === "note" ? 11 : 14 });
        last3d.dots++;
      } else if (l.three === "level" && UI.level3d) {
        /* a contour's level is its elevation: constant z, one LineSegments object */
        const pos = [];
        for (const f of l.features) {
          if (!fin(f.props.elev_ft)) continue;
          const zz = f.props.elev_ft - c.ZMID + 0.9;
          for (let i = 1; i < f.pts.length; i++) {
            const a = f.pts[i - 1], b = f.pts[i];
            pos.push(a[0] - c.CX, a[1] - c.CY, zz, b[0] - c.CX, b[1] - c.CY, zz);
          }
        }
        if (!pos.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 }));
        o.userData.capDesign = l.key;
        out.push({ row, object: o });
        last3d.level++;
      } else if (l.three !== "level") {
        for (const f of l.features) {
          out.push({ row, pts: f.pts, color: col, closed: !!f.closed, width: Math.max(2, l.weight + 0.5) });
          last3d.drape++;
        }
      }
    }
    last3d.objects = out.length;
    return out;
  }

  return {
    build, load, loadText, loadFile, reset, pick, validate, looksLike, at, number, objects3d, zoomTo, show, openPanel, bbox,
    design: () => D, builtIn: () => builtIn, builtIns: () => builtIns.map(d => d.rev), source: () => Object.assign({}, SRC), activeLine,
    isReady: () => !!capDem, whenReady: () => ready,
    rows: () => Object.assign({}, H), surfaceRow: () => surfRow,
    level3d: () => UI.level3d, setLevel3d,
    layerKeys: () => (D ? D.layers.map(l => l.key) : []),
    /* what the last 3D pass was handed, for the harness; reliefZ is the vertical
       scale the cap mesh is drawn at (the view's relief setting) */
    stats3d: () => {
      let reliefZ = null;
      if (liveMesh && liveMesh.parent) { liveMesh.updateWorldMatrix(true, false); reliefZ = liveMesh.getWorldScale(new THREE.Vector3()).z; }
      return Object.assign({ reliefZ }, last3d);
    },
    STORE_KEY, ROW_SURF
  };
})();
