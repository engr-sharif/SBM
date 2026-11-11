/* SBMM Site Explorer — v55: the TEM model out of the app (SBMM.temexport).

     · GIS GRID — the depth slice, or the derived map on screen, as an ESRI
       ASCII grid (.asc) with its projection file (.prj) and a readme, in ONE
       zip. A .asc cannot carry a comment, so the readme is where the
       provenance goes; a .asc without its .prj is a raster nobody can place.
       The grid's nodes are cell CENTRES (xllcenter / yllcenter).
     · 3D MODEL — the whole interpolated model as a legacy-ASCII VTK
       structured grid (ParaView, VisIt): a point per node and layer at the
       layer's mid-depth below the model's own ground, in State Plane feet
       and NAVD88 feet, with the resistivity, its log10, the depth, the layer
       and a `valid` flag (a structured grid has a point everywhere; outside
       the model's reach the flag is 0 and the resistivity is -1).
     · REPORT — a print-ready sheet of the TEM as it stands: the slice and the
       derived map as figures with the soundings and the 2025 borings on
       them, what the model is, what the map says, the calibration against
       the borings, the two interpretations where they have been run, and the
       pinned probes. Through js/report.js's own frame and presenter.

   Nothing here computes: every number is read off the modules that own it
   (js/geophys.js, js/temmaps.js, js/teminterp.js, js/temprobe.js). The zip is
   written here, stored and not compressed — forty lines, no library, and it
   works over file://. */
"use strict";

SBMM.temexport = (function () {

  const G = () => SBMM.geophys;
  const data = () => window.SBMM_DATA && SBMM_DATA.tem2026;
  const NODATA = -9999;
  /* EPSG:6418 — NAD83(2011) / California zone 2, US survey feet, as ESRI
     writes it. Zone 2: central meridian 122°00' W, standard parallels 38°20'
     and 39°50' N, origin 37°40' N, false easting 2,000,000 m, false northing
     500,000 m. */
  const PRJ = 'PROJCS["NAD_1983_2011_StatePlane_California_II_FIPS_0402_Ft_US",'
    + 'GEOGCS["GCS_NAD_1983_2011",DATUM["D_NAD_1983_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],'
    + 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],'
    + 'PARAMETER["False_Easting",6561666.666666666],PARAMETER["False_Northing",1640416.666666667],'
    + 'PARAMETER["Central_Meridian",-122.0],PARAMETER["Standard_Parallel_1",38.33333333333334],'
    + 'PARAMETER["Standard_Parallel_2",39.83333333333334],PARAMETER["Latitude_Of_Origin",37.66666666666666],'
    + 'UNIT["Foot_US",0.3048006096012192]]';
  const today = () => new Date().toISOString().slice(0, 10);
  const fV = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);

  /* ------------------------------------------------------------------ */
  /* a zip, stored                                                       */
  /* ------------------------------------------------------------------ */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  /* files: [{ name, text }] -> Uint8Array. Method 0 (stored), UTF-8 names. */
  function zip(files) {
    const enc = new TextEncoder(), now = new Date();
    const dt = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dd = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), body = enc.encode(f.text), crc = crc32(body);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true);
      h.setUint32(18, body.length, true); h.setUint32(22, body.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, body);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true);
      c.setUint32(20, body.length, true); c.setUint32(24, body.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + body.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the GIS grid                                                        */
  /* ------------------------------------------------------------------ */
  /* g: { nx, ny, dx, x0, y0, v } — row 0 of the file is the NORTH row */
  function asc(g) {
    const head = `ncols        ${g.nx}\nnrows        ${g.ny}\nxllcenter    ${g.x0.toFixed(3)}\nyllcenter    ${g.y0.toFixed(3)}\n`
      + `cellsize     ${g.dx}\nNODATA_value ${NODATA}\n`;
    const rows = [];
    for (let iy = g.ny - 1; iy >= 0; iy--) {
      const r = new Array(g.nx);
      for (let ix = 0; ix < g.nx; ix++) { const v = g.v[iy * g.nx + ix]; r[ix] = v === v ? String(+(+v).toPrecision(6)) : String(NODATA); }
      rows.push(r.join(" "));
    }
    return head + rows.join("\n") + "\n";
  }
  function gridOf(which) {
    if (!data() || !G() || !G().result()) return null;
    if (which === "map") return SBMM.temmaps && SBMM.temmaps.grid ? SBMM.temmaps.grid() : null;
    return G().sliceGrid();
  }
  function readme(g, base) {
    const D = data(), R = G().result();
    let n = 0;
    for (let i = 0; i < g.v.length; i++) if (g.v[i] === g.v[i]) n++;
    return [
      "SBMM OU1 — Sulphur Bank Mercury Mine · TEM geophysics",
      "",
      `${base}.asc   ${g.what}${g.unit ? ", " + g.unit : ""}`,
      `${base}.prj   its coordinate system`,
      "",
      `Values       ${g.name}${g.unit ? " (" + g.unit + ")" : ""}; ${NODATA} where the model has no value`,
      `Grid         ${g.nx} x ${g.ny} nodes at ${g.dx} ft; a node is a cell centre (xllcenter / yllcenter); ${n} nodes with a value`,
      "Coordinates  EPSG:6418 — NAD83(2011) California State Plane zone 2, US survey feet; elevations NAVD88 ft",
      `Source       ${D.survey}; ${D.n} soundings, ${D.nl} model layers to ${Math.round(D.bot_ft[D.nl - 1])} ft`,
      `Model        ${g.method || ""}, ${R.dx}-ft cell, blanked beyond ${R.blank} ft of a sounding`,
      "Ground       the soundings' own elevations, interpolated",
      "",
      "An interpolation of inverted models. The delivery carries no depth of investigation;",
      "the deepest layers are the least constrained. Interpreted; planning-level.",
      "",
      `Prepared by ${SBMM.report && SBMM.report.AUTHOR ? SBMM.report.AUTHOR : "Mohammad Sharif"} · ${today()} · SBMM Site Explorer`,
      ""
    ].join("\r\n");
  }
  /* { name, bytes, base, files } — what gridZip() downloads (the harness's hook) */
  function gridPackage(which) {
    const g = gridOf(which);
    if (!g) return null;
    const base = "SBMM_TEM_" + String(g.tag).replace(/[^\w.-]+/g, "_");
    const files = [{ name: base + ".asc", text: asc(g) }, { name: base + ".prj", text: PRJ + "\n" },
                   { name: base + "_readme.txt", text: readme(g, base) }];
    return { name: base + ".zip", base, files, bytes: zip(files) };
  }
  function gridZip(which) {
    if (!data()) { toast("the TEM survey is not in this build"); return false; }
    const p = gridPackage(which);
    if (!p) { toast(which === "map" ? "the derived map is not computed yet" : "the depth slice is not computed yet"); return false; }
    download(p.name, new Blob([p.bytes], { type: "application/zip" }));
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* the model for a 3D package                                          */
  /* ------------------------------------------------------------------ */
  function vtk() {
    const R = G() && G().result(), D = data();
    if (!R || !D) return "";
    const nx = R.nx, ny = R.ny, nl = D.nl, N = nx * ny, n = N * nl;
    const out = [
      "# vtk DataFile Version 3.0",
      `SBMM TEM resistivity model; ${G().methodName()}; EPSG:6418 ftUS, NAVD88 ft; a point per node and layer mid-depth; valid=0 outside the model`,
      "ASCII", "DATASET STRUCTURED_GRID", `DIMENSIONS ${nx} ${ny} ${nl}`, `POINTS ${n} double`
    ];
    /* k runs UP: the deepest layer first, so z increases with k */
    const mid = l => (D.top_ft[l] + D.bot_ft[l]) / 2;
    for (let k = 0; k < nl; k++) {
      const l = nl - 1 - k, row = [];
      for (let id = 0; id < N; id++)
        row.push((R.x0 + (id % nx) * R.dx).toFixed(2) + " " + (R.y0 + Math.floor(id / nx) * R.dx).toFixed(2) + " " + (R.surf[id] - mid(l)).toFixed(2));
      out.push(row.join("\n"));
    }
    out.push(`POINT_DATA ${n}`);
    const scalar = (name, type, f) => {
      out.push(`SCALARS ${name} ${type} 1`, "LOOKUP_TABLE default");
      for (let k = 0; k < nl; k++) {
        const l = nl - 1 - k, row = new Array(N);
        for (let id = 0; id < N; id++) row[id] = f(id, l);
        out.push(row.join(" "));
      }
    };
    const ok = (id, l) => R.mask[id] && R.log[l * N + id] === R.log[l * N + id];
    scalar("resistivity_ohm_m", "float", (id, l) => ok(id, l) ? String(+Math.pow(10, R.log[l * N + id]).toPrecision(5)) : "-1");
    scalar("log10_resistivity", "float", (id, l) => ok(id, l) ? R.log[l * N + id].toFixed(4) : "-9");
    scalar("depth_ft", "float", (id, l) => mid(l).toFixed(2));
    scalar("layer", "int", (id, l) => String(l + 1));
    scalar("valid", "int", (id, l) => ok(id, l) ? "1" : "0");
    return out.join("\n") + "\n";
  }
  function modelVtk() {
    if (!data()) { toast("the TEM survey is not in this build"); return false; }
    const s = vtk();
    if (!s) { toast("the model is not computed yet"); return false; }
    download("SBMM_TEM_model.vtk", new Blob([s], { type: "model/vtk" }));
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* the report sheet                                                    */
  /* ------------------------------------------------------------------ */
  const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function rampCss(stops, t) {
    t = Math.max(0, Math.min(1, t));
    const p = t * (stops.length - 1), a = Math.min(stops.length - 2, Math.floor(p)), f = p - a, A = rgb(stops[a]), B = rgb(stops[a + 1]);
    return `rgb(${Math.round(A[0] + (B[0] - A[0]) * f)},${Math.round(A[1] + (B[1] - A[1]) * f)},${Math.round(A[2] + (B[2] - A[2]) * f)})`;
  }
  const niceStep = span => { const raw = span / 4, e = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / e; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e; };
  /* One figure on white paper: the picture in its State Plane frame, the
     soundings, the 2025 borings, grid ticks, a scale bar, north, and the
     colour bar. spec = { canvas, bounds [[y0,x0],[y1,x1]], legend { label,
     lo, hi, log, colorAt(t) } }. Returns a data URL. */
  function figure(spec) {
    const [[y0, x0], [y1, x1]] = spec.bounds, D = data();
    /* drawn at 900 px for a figure printed 3.4 in wide, so the type is sized
       for that: 23 px here is 6.5 pt on paper */
    const Wm = 900, Hm = Math.round(Wm * (y1 - y0) / (x1 - x0)), L = 110, Rr = 22, T = 20, B = 168;
    const cv = document.createElement("canvas");
    cv.width = L + Wm + Rr; cv.height = T + Hm + B;
    const c = cv.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
    const X = x => L + (x - x0) / (x1 - x0) * Wm, Y = y => T + (y1 - y) / (y1 - y0) * Hm;
    c.fillStyle = "#f3f3f1"; c.fillRect(L, T, Wm, Hm);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
    c.drawImage(spec.canvas, L, T, Wm, Hm);
    /* the soundings: the data the picture is made from */
    c.fillStyle = "rgba(0,0,0,.6)";
    for (let i = 0; i < D.n; i++) { c.beginPath(); c.arc(X(D.x[i]), Y(D.y[i]), 1.5, 0, 6.2832); c.fill(); }
    /* the 2025 borings inside the frame */
    const holes = SBMM.borelogs && SBMM.borelogs.has && SBMM.borelogs.has() ? SBMM.borelogs.holes() : [];
    c.font = "600 21px Helvetica, Arial, sans-serif"; c.textBaseline = "middle";
    for (const h of holes) {
      if (!(h.x > x0 && h.x < x1 && h.y > y0 && h.y < y1)) continue;
      const px = X(h.x), py = Y(h.y);
      c.fillStyle = "#fff"; c.fillRect(px - 6, py - 6, 12, 12);
      c.strokeStyle = "#111"; c.lineWidth = 2; c.strokeRect(px - 5, py - 5, 10, 10);
      c.beginPath(); c.moveTo(px - 5, py - 5); c.lineTo(px + 5, py + 5); c.moveTo(px + 5, py - 5); c.lineTo(px - 5, py + 5); c.stroke();
      c.lineWidth = 5; c.strokeStyle = "rgba(255,255,255,.9)"; c.strokeText(h.id, px + 9, py);
      c.fillStyle = "#111"; c.fillText(h.id, px + 9, py);
    }
    /* the frame and its State Plane ticks */
    c.strokeStyle = "#111"; c.lineWidth = 2; c.strokeRect(L, T, Wm, Hm);
    const step = niceStep(Math.max(x1 - x0, y1 - y0) * 4 / 3);
    c.fillStyle = "#222"; c.font = "23px Helvetica, Arial, sans-serif"; c.lineWidth = 1.5;
    c.textAlign = "center"; c.textBaseline = "top";
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      c.beginPath(); c.moveTo(X(x), T + Hm); c.lineTo(X(x), T + Hm + 7); c.stroke();
      c.fillText("E " + Math.round(x).toLocaleString("en-US"), Math.max(L + 70, Math.min(L + Wm - 70, X(x))), T + Hm + 11);
    }
    c.textAlign = "right"; c.textBaseline = "middle";
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      c.beginPath(); c.moveTo(L - 7, Y(y)); c.lineTo(L, Y(y)); c.stroke();
      c.save(); c.translate(L - 13, Math.max(T + 70, Math.min(T + Hm - 70, Y(y)))); c.rotate(-Math.PI / 2); c.textAlign = "center"; c.textBaseline = "bottom";
      c.fillText("N " + Math.round(y).toLocaleString("en-US"), 0, 0); c.restore();
    }
    /* north, top right inside the frame */
    const nxp = L + Wm - 40, nyp = T + 64;
    c.fillStyle = "#111"; c.beginPath(); c.moveTo(nxp, nyp - 44); c.lineTo(nxp + 14, nyp); c.lineTo(nxp, nyp - 10); c.lineTo(nxp - 14, nyp); c.closePath(); c.fill();
    c.font = "700 23px Helvetica, Arial, sans-serif"; c.textAlign = "center"; c.textBaseline = "top"; c.fillText("N", nxp, nyp + 4);
    /* the scale bar and the colour bar, under the frame */
    const by = T + Hm + 96, sFt = niceStep((x1 - x0) * 1.6), sPx = sFt / (x1 - x0) * Wm;
    c.fillStyle = "#111"; c.fillRect(L, by, sPx, 8); c.fillStyle = "#fff"; c.fillRect(L + sPx / 2, by + 2, sPx / 2 - 2, 4);
    c.fillStyle = "#222"; c.font = "23px Helvetica, Arial, sans-serif"; c.textAlign = "left"; c.textBaseline = "top";
    c.fillText("0", L, by + 15); c.textAlign = "center"; c.fillText(Math.round(sFt).toLocaleString("en-US") + " ft", L + sPx, by + 15);
    const lg = spec.legend, lw = 470, lx = L + Wm - lw;
    for (let i = 0; i < lw; i++) { c.fillStyle = lg.colorAt(i / (lw - 1)); c.fillRect(lx + i, by - 8, 1.5, 22); }
    c.strokeStyle = "#111"; c.lineWidth = 1.2; c.strokeRect(lx, by - 8, lw, 22);
    const val = t => lg.log ? lg.lo * Math.pow(lg.hi / lg.lo, t) : lg.lo + (lg.hi - lg.lo) * t;
    c.fillStyle = "#222"; c.textBaseline = "top";
    [0, 0.5, 1].forEach((t, i) => { c.textAlign = i === 0 ? "left" : i === 2 ? "right" : "center"; c.fillText(fV(val(t)), lx + t * lw, by + 19); });
    c.textAlign = "right"; c.textBaseline = "bottom"; c.font = "600 23px Helvetica, Arial, sans-serif";
    c.fillText(lg.label + (lg.log ? " (log scale)" : ""), lx + lw, by - 14);
    if (SBMM.watermark && SBMM.watermark.burn) SBMM.watermark.burn(cv, { size: 18 });
    return cv.toDataURL("image/png");
  }
  /* the two figures the sheet can carry */
  function sliceFigure() {
    const s = G().slice(), r = G().range(), g = G().sliceGrid();
    if (!s || !r || !g) return null;
    const b = s.bounds;
    return { title: g.what, url: figure({ canvas: s.canvas, bounds: [[b[1], b[0]], [b[3], b[2]]],
      legend: { label: g.name + (g.unit ? ", " + g.unit : ""), lo: r.lo, hi: r.hi, log: g.log,
                colorAt: t => G().colorFor(g.log ? r.lo * Math.pow(r.hi / r.lo, t) : r.lo + (r.hi - r.lo) * t) || "#ccc" } }) };
  }
  function mapFigure() {
    const T = SBMM.temmaps;
    if (!T || !T.result() || !T.on()) return null;
    const p = T.picture(), sc = T.scale(), g = T.grid();
    if (!p || !sc || !g) return null;
    return { title: g.what, url: figure({ canvas: p.canvas, bounds: p.bounds,
      legend: { label: sc.name + (sc.unit ? ", " + sc.unit : ""), lo: sc.lo, hi: sc.hi, log: sc.kind === "log", colorAt: t => rampCss(sc.stops, t) } }) };
  }
  const e2 = s => esc(s == null ? "" : String(s));
  const kv = rows => `<table class="qt kv"><tbody>` + rows.map(r => `<tr><td>${e2(r[0])}</td><td class="n">${e2(r[1])}</td></tr>`).join("") + `</tbody></table>`;
  /* the sheet's HTML (the harness's hook) — null with a reason toasted when
     there is nothing to report */
  function reportHTML() {
    const D = data(), R = G() && G().result();
    if (!D || !R || !SBMM.report || !SBMM.report.frame) return null;
    const figs = [];
    if (SBMM.layerState.isOn("invest", "tem_slice")) { const f = sliceFigure(); if (f) figs.push(f); }
    const mf = mapFigure(); if (mf) figs.push(mf);
    if (!figs.length) { const f = sliceFigure(); if (f) figs.push(f); }
    let body = "";
    if (figs.length) {
      body += `<div class="temfigs n${figs.length}">` + figs.map((f, i) =>
        `<figure><img src="${f.url}" alt=""><figcaption><b>Figure ${i + 1}.</b> ${e2(f.title)}. Dots are the soundings; crossed squares the 2025 borings.</figcaption></figure>`).join("") + `</div>`;
    }
    /* the model */
    const S = G().settings(), rows = G().summaryRows().filter(r => r[0] !== "Run time");
    /* a card's first row is its headline and needs no word for what it is; a table row does */
    body += `<h2>The model</h2>` + kv(rows.map((r, i) => [i ? r[0] : r[0] + ", median", r[1]]).concat(S.conf ? [["Shading", "faded with the distance to the nearest sounding"]] : []));
    /* the derived map */
    const T = SBMM.temmaps;
    if (T && T.result() && T.on()) {
      body += `<h2>${e2(T.title().replace("TEM — ", "Derived map — "))}</h2><p>${e2(T.finding().text)}</p>` + kv(T.rows().map(r => [r[0], r[1]]));
    }
    /* against the borings */
    const C = G().calibrate ? G().calibrate() : null;
    if (C && C.holes && C.holes.length) {
      const cl = C.classes, row = k => cl[k] && cl[k].median != null
        ? `<tr><td>${k}</td><td class="n">${fV(cl[k].median)}</td><td class="n">${fV(cl[k].p25)}–${fV(cl[k].p75)}</td><td class="n">${cl[k].holes}</td><td class="n">${cl[k].samples}</td></tr>` : "";
      const t = C.threshold;
      body += `<h2>Against the 2025 borings</h2>`
        + `<table class="qt"><thead><tr><th>logged class</th><th>median, Ω·m</th><th>middle half</th><th>borings</th><th>feet sampled</th></tr></thead><tbody>`
        + row("waste") + row("native") + row("bedrock") + `</tbody></table>`
        + (t ? `<p>Waste reads ${e2(t.dir)} ${fV(t.rho)} Ω·m: the one resistivity that best separates logged waste from native soil, `
             + `${Math.round(t.acc * 100)} % balanced accuracy over ${C.holes.length} borings. Classes are the borings' logged contacts.</p>` : "");
    }
    /* the two interpretations, where they have been run */
    const TI = SBMM.teminterp, said = [];
    if (TI && TI.finding) {
      if (TI.waste()) said.push(["Base of waste", TI.finding("waste")]);
      if (TI.seep()) said.push(["Conductive zones", TI.finding("seep")]);
    }
    if (said.length) body += `<h2>Interpretations</h2>` + said.map(s => `<p><b>${e2(s[0])}.</b> ${e2(s[1])}</p>`).join("");
    /* the pinned probes */
    const TP = SBMM.temprobe, pins = TP && TP.pins ? TP.pins() : [];
    if (pins.length) {
      const pr = pins.map(f => ({ f, p: G().probe(f.pts[0][0], f.pts[0][1], { depth: f.props.provenance.depth }) })).filter(q => q.p.ok);
      if (pr.length) body += `<h2>Pinned probes</h2><table class="qt"><thead><tr><th>probe</th><th>easting, ft</th><th>northing, ft</th><th>depth, ft</th>`
        + `<th>elev, ft</th><th>Ω·m</th><th>nearest sounding</th><th>support</th></tr></thead><tbody>`
        + pr.map(q => `<tr><td>${e2(q.f.name)}</td><td class="n">${fmt0(q.p.x)}</td><td class="n">${fmt0(q.p.y)}</td><td class="n">${fmt(q.p.depth, 1)}</td>`
          + `<td class="n">${fmt(q.p.elev, 1)}</td><td class="n">${fV(q.p.rho)}</td>`
          + `<td class="n">${q.p.snd ? e2(q.p.snd.id) + " · " + Math.round(q.p.snd.dist) + " ft · " + fV(q.p.snd.rho) : "—"}</td>`
          + `<td class="n">${q.p.support ? Math.round(q.p.support.k * 100) + " %" : "—"}</td></tr>`).join("") + `</tbody></table>`;
    }
    body += `<h2>Limits</h2><p>An interpolation of the contractor's inverted resistivity models between soundings. The delivery carries no depth of `
      + `investigation, so the deepest layers are the least constrained. Resistivity does not identify a material: conductive ground is mineralised `
      + `water or clay. Interpreted; planning-level.</p>`;
    return SBMM.report.frame({
      title: "TEM geophysics", sub: "TEM2Go transient electromagnetic survey, LCI resistivity models, May 2026", sheet: "TEM-1",
      cells: [["Coordinate system", "EPSG:6418 · CA SP Zone 2 · ftUS · NAVD88"],
              ["Survey", `${fmt0(D.n)} soundings · ${D.nl} layers to ${fmt0(D.bot_ft[D.nl - 1])} ft`],
              ["Model", `${G().methodName()} · ${fmt0(R.dx)}-ft cell · within ${fmt0(R.blank)} ft of a sounding`]],
      css: `.temfigs{display:flex;gap:10px;align-items:flex-start}.temfigs figure{flex:1;min-width:0}
.temfigs.n1 figure{max-width:4.6in;margin:0 auto 6px}
table.kv td:first-child{width:38%;color:#333}table.kv td.n{white-space:normal}
h2{break-after:avoid}table,figure{break-inside:avoid}`,
      body });
  }
  async function report() {
    if (!data()) { toast("the TEM survey is not in this build"); return null; }
    if (!SBMM.report || !SBMM.report.present) { toast("the report engine is not in this build"); return null; }
    if (!G().result()) await G().run();
    if (!G().result()) return null;
    let html;
    try { html = reportHTML(); }
    catch (e) { console.error(e); toast("the TEM sheet failed: " + e.message); return null; }
    if (!html) { toast("the TEM sheet could not be composed"); return null; }
    return SBMM.report.present("TEM geophysics", html, "sbmm_tem_geophysics.html");
  }

  return { gridZip, gridPackage, asc, zip, crc32, vtk, modelVtk, report, reportHTML, PRJ, NODATA };
})();
