/* SBMM Site Explorer — generic datasets: feed any coordinate table into the twin.

   The app grew around a fixed set of project layers (DUs, piles, samples). Every
   new table — wells, borings, air stations, test pits, whatever next month brings —
   used to mean a new hand-written layer module. This is the general case of that:
   a dataset is a named list of points with arbitrary attributes, and once it is
   registered it behaves like everything else in the workbench. It gets a styled
   map layer, attribute popups, its own tab in the table drawer, CSV re-export,
   GeoJSON and DXF export, object snap, and a 3D rendering.

   Two ways in:
     imported   CSV dropped on the map, the Import button, or the DATASET command.
                Column mapping is offered, not guessed silently — the guess is
                pre-selected and shown, so a wrong header name is visible before
                anything lands on the map. Imported datasets live in the session
                file and in localStorage autosave.
     baked      data/datasets/ds_*.json, compiled into SBMM_DATA.datasets by
                tools/build_data.py (tools/add_dataset.py writes one from a CSV).
                These ship with the app and are not user-editable.

   Kinds. "generic" is the default; "wells" and "borings" only change defaults —
   symbol, popup ordering, and whether a depth attribute is offered as a 3D stick.
   Nothing downstream branches on kind, so a kind that turns out to be wrong is a
   cosmetic mistake rather than a structural one. */
"use strict";

SBMM.datasets = (function () {

  const AUTOSAVE = "sbmm_datasets_auto";
  const SHAPES = ["circle", "square", "triangle", "diamond", "well", "boring"];
  const KINDS = [
    ["generic", "generic points"],
    ["wells", "wells"],
    ["borings", "borings / test pits"]
  ];
  const KIND_DEFAULT = {
    generic: { color: "#7CD0E6", shape: "circle" },
    wells: { color: "#4FD2E8", shape: "well" },
    borings: { color: "#E8B34B", shape: "boring" }
  };
  /* attributes a wells/borings popup leads with when they are present. Anything
     not listed still shows, just after these. */
  const LEAD = {
    wells: ["Total depth (ft)", "Screen top (ft bgs)", "Screen bottom (ft bgs)",
            "TOC elev (ft NAVD88)", "Ground elev (ft NAVD88)", "Installed",
            "Casing diameter (in)", "Lithology at screen"],
    borings: ["Total depth (ft)", "Interpreted waste depth (ft)", "Waste area",
              "Ground elev (ft)", "Waste depth basis"],
    generic: []
  };
  const DEPTH_RE = /(^|[^a-z])(total\s*depth|td|depth|bottom\s*depth|boring\s*depth)([^a-z]|$)/i;

  const list = [];
  let seq = 0;

  const byId = id => list.find(d => d.id === id) || null;
  const userSets = () => list.filter(d => !d.baked);

  /* ================================================================== */
  /* CSV                                                                 */
  /* ================================================================== */
  /* Small, deliberate parser: quoted fields with embedded commas, doubled
     quotes, CRLF, and a BOM. Not a general RFC-4180 library — it does not need
     to be — but every one of those four appears in exports off this project. */
  function parseCSV(text) {
    const s = text.replace(/^﻿/, "");
    const rows = [];
    let row = [], cur = "", q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.length && r.some(v => String(v).trim() !== ""));
  }

  const NORTH_RE = /^(northing|north|n|y|sp_?y(_ft)?|y_?ft|lat|latitude)$/i;
  const EAST_RE = /^(easting|east|e|x|sp_?x(_ft)?|x_?ft|lon|long|longitude)$/i;
  const ID_RE = /^(id|loc_?id|location|name|well|well_?id|boring|boring_?id|station|point|sample|label)$/i;

  function guessColumns(hdr, rows) {
    const norm = hdr.map(h => String(h).trim());
    let xi = norm.findIndex(h => EAST_RE.test(h));
    let yi = norm.findIndex(h => NORTH_RE.test(h));
    /* Header names decide first; magnitude decides when they don't, or when they
       disagree with the numbers (an "X"/"Y" pair holding lat/long is common). */
    const nums = i => rows.slice(0, 40).map(r => parseFloat(r[i])).filter(v => !isNaN(v));
    const med = a => a.length ? a.slice().sort((p, q2) => p - q2)[a.length >> 1] : NaN;
    if (xi < 0 || yi < 0) {
      const cand = [];
      for (let i = 0; i < norm.length; i++) {
        const v = nums(i);
        if (v.length >= Math.max(2, Math.min(rows.length, 5))) cand.push([i, Math.abs(med(v))]);
      }
      const sp = cand.filter(c => c[1] > 1e5);
      if (sp.length >= 2) {
        sp.sort((a, b) => b[1] - a[1]);
        xi = xi < 0 ? sp[0][0] : xi; yi = yi < 0 ? sp[1][0] : yi;   // easting is the bigger one here
      } else {
        const ll = cand.filter(c => c[1] > 1 && c[1] < 180);
        if (ll.length >= 2) {
          const lon = ll.find(c => c[1] > 90), lat = ll.find(c => c[1] <= 90);
          if (lon && lat) { xi = xi < 0 ? lon[0] : xi; yi = yi < 0 ? lat[0] : yi; }
        }
      }
    }
    let ii = norm.findIndex(h => ID_RE.test(h));
    if (ii < 0) ii = norm.findIndex((h, i) => i !== xi && i !== yi && nums(i).length === 0);
    return { xi, yi, ii };
  }

  /* SP ftUS vs WGS84, from the numbers rather than from a header promise —
     the same rule io.js uses for GeoJSON, so an import behaves the same whichever
     door it comes through. */
  function detectCRS(xs, ys) {
    const ax = Math.abs(median(xs)), ay = Math.abs(median(ys));
    if (ax > 1e5 || ay > 1e5) return "sp";
    if (ax <= 180 && ay <= 90) return "wgs84";
    return "sp";
  }
  function median(a) {
    const v = a.filter(x => !isNaN(x)).sort((p, q) => p - q);
    return v.length ? v[v.length >> 1] : NaN;
  }

  function rowsToPoints(rows, hdr, map, crs) {
    const pts = [], bad = [];
    for (const r of rows) {
      let x = parseFloat(r[map.xi]), y = parseFloat(r[map.yi]);
      if (isNaN(x) || isNaN(y)) { bad.push(r); continue; }
      if (crs === "wgs84") {
        /* accept either order — a "lat,long" column pair is at least as common
           in this project's tables as "long,lat" */
        const lon = Math.abs(x) > 90 ? x : y, lat = Math.abs(x) > 90 ? y : x;
        const p = SBMM.fromLL(lon, lat);
        x = p[0]; y = p[1];
      } else if (x < y) {
        [x, y] = [y, x];              // N,E given instead of E,N
      }
      const a = {};
      for (let i = 0; i < hdr.length; i++) {
        if (i === map.xi || i === map.yi || i === map.ii) continue;
        const v = String(r[i] == null ? "" : r[i]).trim();
        if (!v) continue;
        const n = Number(v);
        a[hdr[i]] = (v !== "" && !isNaN(n) && /^[-+0-9.eE]+$/.test(v)) ? n : v;
      }
      pts.push({
        id: map.ii >= 0 ? String(r[map.ii] || "").trim() || ("pt " + (pts.length + 1))
          : "pt " + (pts.length + 1),
        x: +x.toFixed(2), y: +y.toFixed(2), a
      });
    }
    return { pts, bad: bad.length };
  }

  /* ================================================================== */
  /* registration                                                        */
  /* ================================================================== */
  function add(ds, opts) {
    const o = opts || {};
    if (!ds || !Array.isArray(ds.points) || !ds.points.length) {
      toast("dataset has no usable points"); return null;
    }
    const kind = KINDS.some(k => k[0] === ds.kind) ? ds.kind : "generic";
    const kd = KIND_DEFAULT[kind];
    const d = {
      id: ds.id || ("ds" + (++seq)),
      name: ds.name || "Dataset " + (list.length + 1),
      kind,
      baked: !!ds.baked,
      source: ds.source || "",
      crs: ds.crs || "EPSG:6418 (NAD83(2011) CA SP Zone 2, ftUS)",
      idField: ds.idField || "ID",
      depthField: ds.depthField || guessDepthField(ds.points),
      style: Object.assign({ color: kd.color, shape: kd.shape, size: 6, labels: false,
                             stick3d: kind !== "generic" }, ds.style || {}),
      points: ds.points.map(p => ({ id: String(p.id), x: +p.x, y: +p.y, a: p.a || {} }))
    };
    while (byId(d.id)) d.id = d.id + "_" + (++seq);
    d.fields = fieldsOf(d);
    list.push(d);
    buildLayer(d);
    buildRow(d);
    if (SBMM.dsTable) SBMM.dsTable.addTab(d);
    if (SBMM.snap && SBMM.snap.invalidate) SBMM.snap.invalidate();
    if (SBMM.viewer3d) SBMM.viewer3d.refreshOverlays();
    if (o.persist !== false && !d.baked) autosave();
    return d;
  }

  function guessDepthField(pts) {
    const seen = new Set();
    for (const p of pts.slice(0, 50)) for (const k in (p.a || {})) seen.add(k);
    for (const k of seen) if (DEPTH_RE.test(k) && !/screen|water|elev/i.test(k)) return k;
    return null;
  }
  function fieldsOf(d) {
    const seen = [];
    for (const p of d.points) for (const k in p.a) if (!seen.includes(k)) seen.push(k);
    const lead = LEAD[d.kind] || [];
    seen.sort((a, b) => {
      const ia = lead.indexOf(a), ib = lead.indexOf(b);
      if (ia < 0 && ib < 0) return 0;
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
    return seen;
  }

  function remove(d) {
    if (!d) return;
    if (d.layer) SBMM.map.removeLayer(d.layer);
    if (d.rowRef && d.rowRef.row) d.rowRef.row.remove();
    if (SBMM.dsTable) SBMM.dsTable.removeTab(d);
    const i = list.indexOf(d);
    if (i >= 0) list.splice(i, 1);
    if (SBMM.snap && SBMM.snap.invalidate) SBMM.snap.invalidate();
    if (SBMM.viewer3d) SBMM.viewer3d.refreshOverlays();
    if (SBMM.layersUI) SBMM.layersUI.refreshCounts();
    autosave();
  }

  /* ---------- symbols ---------- */
  function svgSymbol(shape, color, size) {
    const s = size * 2, c = size, r = size - 1;
    const stroke = `stroke="#0D1215" stroke-width="1"`;
    let body;
    switch (shape) {
      case "square": body = `<rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="${color}" ${stroke}/>`; break;
      case "triangle": body = `<polygon points="${c},1 ${s - 1},${s - 1} 1,${s - 1}" fill="${color}" ${stroke}/>`; break;
      case "diamond": body = `<polygon points="${c},0.5 ${s - 0.5},${c} ${c},${s - 0.5} 0.5,${c}" fill="${color}" ${stroke}/>`; break;
      /* the two survey symbols people expect on a site plan */
      case "well": body = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="1.8"/>
        <circle cx="${c}" cy="${c}" r="${Math.max(1, r * .38)}" fill="${color}"/>`; break;
      case "boring": body = `<rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="none" stroke="${color}" stroke-width="1.8"/>
        <path d="M1 1 L${s - 1} ${s - 1} M${s - 1} 1 L1 ${s - 1}" stroke="${color}" stroke-width="1.2"/>`; break;
      default: body = `<circle cx="${c}" cy="${c}" r="${r}" fill="${color}" ${stroke}/>`;
    }
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${body}</svg>`;
  }

  function marker(d, p) {
    const st = d.style, s = st.size * 2;
    const html = svgSymbol(st.shape, st.color, st.size)
      + (st.labels ? `<span class="dslbl">${esc(p.id)}</span>` : "");
    const mk = L.marker([p.y, p.x], {
      pane: "vectors",
      icon: L.divIcon({ className: "dsmk", html, iconSize: [s, s], iconAnchor: [st.size, st.size] }),
      keyboard: false
    });
    mk.bindTooltip(`${esc(p.id)} · ${esc(d.name)}`, { sticky: true, className: "ctip" });
    mk.bindPopup(() => popup(d, p), { maxWidth: 340 });
    return mk;
  }

  /* The popup markup itself lives in js/popups.js so the 3D pick card can show
     exactly the same thing — "the same popup HTML as 2D" is only guaranteed if
     there is one function that writes it (§8). */
  function popup(d, p) { return SBMM.popups.forDataset(d, p); }

  function buildLayer(d) {
    if (d.layer) SBMM.map.removeLayer(d.layer);
    d.layer = L.layerGroup();
    d.markers = {};
    /* Real coordinate tables repeat IDs (a re-drilled boring, a well pair sharing
       a label). Keying only by id meant the second point's marker replaced the
       first in the lookup, so its table row pointed at the wrong dot. The id map
       stays for anything that still wants it; `markerOf` is keyed by the point
       object itself, which is unique per row.

       It has to be a side map, not a field on the point: `points` is serialised
       verbatim into the session file and the localStorage autosave, and a Leaflet
       marker on the point makes that structure circular — JSON.stringify throws,
       and the autosave is inside a try/catch, so it would have failed silently. */
    d.markerOf = new Map();
    for (const p of d.points) {
      const mk = marker(d, p).addTo(d.layer);
      d.markerOf.set(p, mk);
      if (!d.markers[p.id]) d.markers[p.id] = mk;
    }
  }
  function restyle(d) {
    const on = d.rowRef && d.rowRef.cb.checked;
    if (on) SBMM.map.removeLayer(d.layer);
    buildLayer(d);
    if (on) d.layer.addTo(SBMM.map);
    if (d.rowRef) {
      const sw = d.rowRef.row.querySelector(".sw");
      if (sw) sw.style.background = d.style.color;
    }
    if (SBMM.viewer3d) SBMM.viewer3d.refreshOverlays();
    autosave();
  }

  /* ---------- the Layers row ---------- */
  function buildRow(d) {
    const ref = SBMM.addLayerRow("data", `${esc(d.name)} (${d.points.length})`, d.layer,
      { checked: true, swatch: d.style.color });
    ref.row.title = (d.source || "imported dataset") + (d.baked ? "" : " — imported this session");
    d.rowRef = ref;

    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "minib dsgear";
    gear.textContent = "⋯";
    gear.title = `Style, table, export and remove — ${d.name}`;
    gear.onclick = e => { e.preventDefault(); e.stopPropagation(); menu(d, gear); };
    ref.row.appendChild(gear);

    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "minib dszoom";
    zoom.textContent = "⤢";
    zoom.title = `Zoom to ${d.name}`;
    zoom.onclick = e => { e.preventDefault(); e.stopPropagation(); zoomTo(d); };
    ref.row.appendChild(zoom);

    if (SBMM.layersUI) SBMM.layersUI.refreshCounts();
    return ref;
  }

  function bounds(d) {
    const xs = d.points.map(p => p.x), ys = d.points.map(p => p.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  function zoomTo(d) {
    const [x0, y0, x1, y1] = bounds(d);
    SBMM.map.flyToBounds([[y0, x0], [y1, x1]], { padding: [60, 60], duration: 0.7 });
  }

  function menu(d, anchor) {
    const old = $("dsMenu"); if (old) old.remove();
    const m = document.createElement("div");
    m.id = "dsMenu";
    m.className = "menu open dsmenu";
    m.innerHTML = `
      <div class="ci hd">${esc(d.name)} — ${d.points.length} points · ${esc(d.kind)}</div>
      <div class="dsrowopt"><label>colour <input type="color" id="dsColor" value="${d.style.color}"></label>
        <label>symbol <select id="dsShape">${SHAPES.map(s => `<option value="${s}"${s === d.style.shape ? " selected" : ""}>${s}</option>`).join("")}</select></label></div>
      <div class="dsrowopt"><label>size <input type="range" id="dsSize" min="3" max="12" step="1" value="${d.style.size}"></label>
        <label class="chk"><input type="checkbox" id="dsLabels"${d.style.labels ? " checked" : ""}> labels</label></div>
      <div class="dsrowopt"><label class="chk" title="${d.depthField ? "Draw a vertical stick from the ground down " + esc(d.depthField) : "This dataset has no depth attribute"}">
        <input type="checkbox" id="dsStick"${d.style.stick3d ? " checked" : ""}${d.depthField ? "" : " disabled"}> 3D depth sticks${d.depthField ? ` <span class="mut">(${esc(d.depthField)})</span>` : ""}</label></div>
      <div class="ci" data-a="table">Open its table</div>
      <div class="ci" data-a="zoom">Zoom to extent</div>
      <div class="ci" data-a="csv">Export as CSV</div>
      ${d.baked ? '<div class="ci dis" title="Baked datasets ship with the app">Remove (baked — edit data/datasets/ instead)</div>'
        : '<div class="ci" data-a="del">Remove from this session</div>'}`;
    document.body.appendChild(m);
    /* clamp on both sides: on a short window the menu is taller than the space
       below its row, and a Math.min alone put it off the top of the screen */
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
    m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8)) + "px";

    $("dsColor").oninput = e => { d.style.color = e.target.value; restyle(d); };
    $("dsShape").onchange = e => { d.style.shape = e.target.value; restyle(d); };
    $("dsSize").oninput = e => { d.style.size = +e.target.value; restyle(d); };
    $("dsLabels").onchange = e => { d.style.labels = e.target.checked; restyle(d); };
    $("dsStick").onchange = e => {
      d.style.stick3d = e.target.checked;
      if (SBMM.viewer3d) SBMM.viewer3d.refreshOverlays();
      autosave();
    };
    m.onclick = e => {
      const a = e.target.dataset.a; if (!a) return;
      m.remove();
      if (a === "table") { SBMM.table.toggle(true); SBMM.dsTable.show(d.id); }
      if (a === "zoom") zoomTo(d);
      if (a === "csv") exportCSV(d);
      if (a === "del" && confirm(`Remove “${d.name}” from this session?`)) remove(d);
    };
    setTimeout(() => document.addEventListener("click", function once(e) {
      if (!m.contains(e.target)) { m.remove(); document.removeEventListener("click", once); }
    }), 0);
  }

  /* ================================================================== */
  /* import dialog                                                       */
  /* ================================================================== */
  function importCSV(text, fname) {
    let rows;
    try { rows = parseCSV(text); } catch (e) { toast("couldn't read that CSV: " + e.message); return; }
    if (rows.length < 2) { toast("that CSV has no data rows"); return; }
    const hdr = rows[0].map(h => String(h).trim() || "col" + (Math.random() * 1e4 | 0));
    const body = rows.slice(1);
    dialog(hdr, body, (fname || "dataset").replace(/\.[^.]+$/, ""));
  }

  function dialog(hdr, body, name) {
    const old = $("dsDialog"); if (old) old.remove();
    const g = guessColumns(hdr, body);
    const box = document.createElement("div");
    box.id = "dsDialog";
    box.className = "modal";
    const opts = (sel, allowNone) =>
      (allowNone ? `<option value="-1">— none —</option>` : "")
      + hdr.map((h, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${esc(h)}</option>`).join("");
    box.innerHTML = `<div class="mbox">
      <div class="mhd">Add dataset <span class="spacer"></span><span class="ic x" id="dsCancel">✕</span></div>
      <div class="mbody">
        <label class="mrow"><span>Name</span><input id="dsName" value="${esc(name)}" spellcheck="false"></label>
        <label class="mrow"><span>Kind</span><select id="dsKind">${KINDS.map(k => `<option value="${k[0]}">${k[1]}</option>`).join("")}</select></label>
        <div class="mrule"></div>
        <label class="mrow"><span>Easting / X</span><select id="dsX">${opts(g.xi, false)}</select></label>
        <label class="mrow"><span>Northing / Y</span><select id="dsY">${opts(g.yi, false)}</select></label>
        <label class="mrow"><span>ID / label</span><select id="dsIdCol">${opts(g.ii, true)}</select></label>
        <label class="mrow"><span>Coordinates</span><select id="dsCrs">
          <option value="auto">detect automatically</option>
          <option value="sp">State Plane ft (EPSG:6418)</option>
          <option value="wgs84">latitude / longitude (WGS84)</option></select></label>
        <div class="mnote" id="dsPreview"></div>
      </div>
      <div class="mfoot"><span class="mut">${body.length} rows · ${hdr.length} columns · everything else becomes an attribute</span>
        <span class="spacer"></span>
        <button class="minib" id="dsCancel2">Cancel</button>
        <button class="minib prim" id="dsGo">Add to map</button></div>
    </div>`;
    document.body.appendChild(box);

    const read = () => ({
      xi: +$("dsX").value, yi: +$("dsY").value, ii: +$("dsIdCol").value
    });
    function preview() {
      const map = read();
      const xs = body.map(r => parseFloat(r[map.xi]));
      const ys = body.map(r => parseFloat(r[map.yi]));
      const crs = $("dsCrs").value === "auto" ? detectCRS(xs, ys) : $("dsCrs").value;
      const { pts, bad } = rowsToPoints(body, hdr, map, crs);
      const inSite = pts.filter(p => p.x > 6.3e6 && p.x < 6.4e6 && p.y > 2.09e6 && p.y < 2.17e6).length;
      const seen = new Set(), dup = new Set();
      for (const p of pts) { if (seen.has(p.id)) dup.add(p.id); else seen.add(p.id); }
      $("dsPreview").innerHTML = pts.length
        ? `<b>${pts.length}</b> point${pts.length === 1 ? "" : "s"} read as
           <b>${crs === "sp" ? "State Plane ft" : "latitude/longitude"}</b>${bad ? ` · <span class="warn">${bad} row${bad === 1 ? "" : "s"} skipped — no usable coordinates</span>` : ""}
           <br><span class="${inSite === pts.length ? "ok" : inSite ? "warn" : "bad"}">${inSite} of ${pts.length} land inside the site window</span>
           ${dup.size ? `<br><span class="warn">${dup.size} repeated ID${dup.size === 1 ? "" : "s"} (e.g. ${esc([...dup][0])}) — kept, but they will not be unique</span>` : ""}
           <br><span class="mut mono">first: ${esc(pts[0].id)} — ${fmt0(pts[0].x)} E, ${fmt0(pts[0].y)} N</span>`
        : `<span class="bad">no usable coordinates in those two columns — pick the Easting and Northing columns above</span>`;
      return { pts, crs, bad };
    }
    ["dsX", "dsY", "dsIdCol", "dsCrs"].forEach(id => $(id).onchange = preview);
    preview();

    const shut = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = e => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(); }
      else if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); $("dsGo").click(); }
    };
    document.addEventListener("keydown", onKey, true);
    $("dsCancel").onclick = shut;
    $("dsCancel2").onclick = shut;
    box.addEventListener("click", e => { if (e.target === box) shut(); });
    setTimeout(() => { const n = $("dsName"); if (n) { n.focus(); n.select(); } }, 20);
    $("dsGo").onclick = () => {
      const { pts, bad } = preview();
      if (!pts.length) { toast("nothing to add — pick the Easting and Northing columns"); return; }
      const d = add({
        name: $("dsName").value.trim() || "Dataset",
        kind: $("dsKind").value,
        idField: read().ii >= 0 ? hdr[read().ii] : "ID",
        source: "imported CSV, this session",
        points: pts
      });
      shut();
      if (d) {
        toast(`${d.name}: ${d.points.length} points added`
          + (bad ? ` · ${bad} row${bad === 1 ? "" : "s"} skipped (no usable coordinates)` : ""), bad ? 4200 : 2600);
        zoomTo(d);
      }
    };
  }

  function pickFile() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".csv,.txt,.tsv";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => importCSV(rd.result, f.name);
      rd.readAsText(f);
    };
    inp.click();
  }

  /* ================================================================== */
  /* export / integration                                                */
  /* ================================================================== */
  function csvOf(d) {
    const cols = ["id", "sp_e_ft", "sp_n_ft", "lat", "lon", "ground_elev_ft", ...d.fields];
    const q = v => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let out = cols.map(q).join(",") + "\n";
    for (const p of d.points) {
      const [lo, la] = SBMM.toLL(p.x, p.y);
      const [z] = SBMM.elev(p.x, p.y);
      out += [p.id, p.x, p.y, la.toFixed(7), lo.toFixed(7), isNaN(z) ? "" : z.toFixed(1),
        ...d.fields.map(f => p.a[f] == null ? "" : p.a[f])].map(q).join(",") + "\n";
    }
    return out;
  }
  function exportCSV(d) {
    download("sbmm_" + d.id.replace(/\W+/g, "_") + ".csv",
      new Blob([csvOf(d)], { type: "text/csv" }));
  }

  /* GeoJSON features for io.js — every dataset point, tagged with its dataset so
     the recipient can tell a well from a boring without opening the app */
  function geoFeatures(project) {
    const out = [];
    for (const d of list) for (const p of d.points) {
      out.push({
        type: "Feature",
        properties: { name: p.id, tool: "dataset", dataset: d.name, dataset_kind: d.kind,
                      layer: "DS_" + d.name.toUpperCase().replace(/\W+/g, "_"), ...p.a },
        geometry: { type: "Point", coordinates: project([p.x, p.y]) }
      });
    }
    return out;
  }
  /* DXF: one POINT per record on a per-dataset layer, plus its id as TEXT */
  function dxfEntities() {
    return list.map(d => ({
      layer: "DS_" + d.name.toUpperCase().replace(/\W+/g, "_"),
      color: d.style.color,
      points: d.points.map(p => ({ id: p.id, x: p.x, y: p.y }))
    }));
  }
  function snapPoints() {
    const out = [];
    for (const d of list) for (const p of d.points) out.push([p.x, p.y]);
    return out;
  }

  /* 3D spec — viewer3d owns THREE, this owns what is worth drawing */
  function threeSpec() {
    return list.filter(d => d.rowRef && d.rowRef.cb.checked).map(d => ({
      /* v15 §3.1: the LAYER ROW this dataset draws under, so a 3D object can be
         matched against the row that is on (the row id is a slug of the label,
         not the dataset id) */
      id: d.id, rowKey: d.rowRef.key, name: d.name, color: d.style.color, size: d.style.size * 2.4,
      stick: !!(d.style.stick3d && d.depthField),
      pts: d.points.map(p => ({
        x: p.x, y: p.y,
        depth: d.depthField ? (typeof p.a[d.depthField] === "number" ? p.a[d.depthField] : null) : null
      }))
    }));
  }

  /* ================================================================== */
  /* persistence                                                         */
  /* ================================================================== */
  function serializeUser() {
    return userSets().map(d => ({
      id: d.id, name: d.name, kind: d.kind, source: d.source, crs: d.crs,
      idField: d.idField, depthField: d.depthField, style: d.style,
      points: d.points
    }));
  }
  function restoreUser(arr) {
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const ds of arr) {
      if (list.some(d => d.name === ds.name && !d.baked)) continue;   // idempotent reload
      if (add(Object.assign({}, ds, { baked: false }), { persist: false })) n++;
    }
    if (n) autosave();
    return n;
  }
  function autosave() {
    try { localStorage.setItem(AUTOSAVE, JSON.stringify(serializeUser())); }
    catch (e) { /* file:// or quota — session export still works */ }
  }
  function loadAutosave() {
    try {
      const s = localStorage.getItem(AUTOSAVE);
      return s ? restoreUser(JSON.parse(s)) : 0;
    } catch (e) { return 0; }
  }

  /* ================================================================== */
  function build() {
    const baked = (window.SBMM_DATA && SBMM_DATA.datasets) || [];
    for (const ds of baked) add(Object.assign({}, ds, { baked: true }), { persist: false });
    loadAutosave();
  }

  function wire() {
    const b = $("dsAddBtn");
    if (b) b.onclick = pickFile;
  }

  return {
    build, wire, add, remove, list: () => list.slice(), byId,
    importCSV, pickFile, dialog, parseCSV, guessColumns, detectCRS,
    csvOf, exportCSV, geoFeatures, dxfEntities, snapPoints, threeSpec,
    serializeUser, restoreUser, zoomTo, bounds, restyle, popup
  };
})();
