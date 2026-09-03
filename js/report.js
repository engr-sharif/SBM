/* SBMM Site Explorer — print-ready report sheets.

   One click on a volume, design surface or section set produces a document, not a
   screenshot of a web page: title block, a georeferenced figure with a scale bar and
   a north arrow, the quantities table, the method and caveat notes the memo uses,
   and — where sections exist — a sections sheet at a stated scale. Black on white,
   letter portrait, Print → Save as PDF.

   The figure is composed here rather than captured, because there is no html2canvas
   and no network: the visible Leaflet image overlays are drawn into a canvas through
   their own georeferencing (the map is CRS.Simple with latlng = [northing, easting],
   so world → pixel is a plain affine), then the vector work is redrawn on top in
   print styling — heavier lines, black labels — instead of the dark screen palette.

   The sheet is shown in a same-origin iframe rather than a popped window: popups are
   blocked often enough, and over file:// a written-into window can lose its origin.
   The Print button drives the iframe; "open in a window" is there for anyone who
   wants the browser's own print preview chrome.                                    */
"use strict";

SBMM.report = (function () {

  const AUTHOR = "Mohammad Sharif";
  const PROJECT = "SBMM OU1 — Sulphur Bank Mercury Mine";
  const CRS_NOTE = "NAD83(2011) California State Plane Zone 2, US survey feet (EPSG:6418); elevations in feet, survey datum.";
  const SURVEY_NOTE = "Terrain: 30 January 2024 aerial lidar survey — surveyor's 1-ft gridded LandXML surface, regridded to 2 ft site-wide and held at 1 ft over the mine area.";

  /* ------------------------------------------------------------------ */
  /* figure composition                                                  */
  /* ------------------------------------------------------------------ */
  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("image failed"));
      im.src = src;
    });
  }

  /* every image overlay currently on the map, back-to-front */
  function rasterLayers() {
    const out = [];
    SBMM.map.eachLayer(l => {
      if (!(l instanceof L.ImageOverlay)) return;
      if (!l._url || !l.getBounds) return;
      const pane = (l.options && l.options.pane) || "overlayPane";
      const paneZ = { raster: 260, analysis: 320, vectors: 420, drawings: 460 }[pane] || 400;
      out.push({ l, z: paneZ * 100 + ((l.options && l.options.zIndex) || 0) });
    });
    out.sort((a, b) => a.z - b.z);
    return out.map(o => o.l);
  }

  /* bbox of whatever the sheet is about, padded and squared to the figure box */
  function figureBBox(f, W, H) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const eat = pts => { for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } };
    eat(f.pts);
    /* frame the daylight line too — the graded area reaches well outside the
       footprint that was drawn, and a figure that crops it off is misleading */
    const dl = f._daylight ? f._daylight
      : (f.props && f.props.designId && SBMM.design.byId(f.props.designId)
         && SBMM.design.byId(f.props.designId)._daylight) || null;
    if (dl) dl.forEach(eat);
    if (f._sec) {
      const R = f._sec;
      for (let s = 0; s < R.ns; s++) {
        eat([[R.cx[s] - R.nx[s] * R.half, R.cy[s] - R.ny[s] * R.half],
             [R.cx[s] + R.nx[s] * R.half, R.cy[s] + R.ny[s] * R.half]]);
      }
    }
    const padf = 0.16;
    const w = Math.max(60, x1 - x0), h = Math.max(60, y1 - y0);
    x0 -= w * padf; x1 += w * padf; y0 -= h * padf; y1 += h * padf;
    /* match the figure's aspect so nothing is stretched */
    const want = W / H, have = (x1 - x0) / (y1 - y0);
    if (have < want) { const need = (y1 - y0) * want, cx = (x0 + x1) / 2; x0 = cx - need / 2; x1 = cx + need / 2; }
    else { const need = (x1 - x0) / want, cy = (y0 + y1) / 2; y0 = cy - need / 2; y1 = cy + need / 2; }
    return [x0, y0, x1, y1];
  }

  /* a "nice" scale-bar length: 1, 2 or 5 × a power of ten, ≈ a fifth of the figure */
  function niceLen(span) {
    const raw = span / 5;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
    return 10 * p;
  }

  async function composeFigure(f, W, H) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);

    const [x0, y0, x1, y1] = figureBBox(f, W, H);
    const s = W / (x1 - x0);
    const PX = x => (x - x0) * s, PY = y => H - (y - y0) * s;

    /* raster backdrop, lightened so black line work reads over it */
    g.save();
    g.beginPath(); g.rect(0, 0, W, H); g.clip();
    for (const l of rasterLayers()) {
      let im;
      try { im = await loadImage(l._url); } catch (e) { continue; }
      const b = l.getBounds();
      const bx0 = b.getWest(), bx1 = b.getEast(), by0 = b.getSouth(), by1 = b.getNorth();
      const dx = PX(bx0), dy = PY(by1), dw = (bx1 - bx0) * s, dh = (by1 - by0) * s;
      if (dx > W || dy > H || dx + dw < 0 || dy + dh < 0) continue;
      g.globalAlpha = (l.options && l.options.opacity != null) ? l.options.opacity : 1;
      try { g.drawImage(im, dx, dy, dw, dh); } catch (e) { /* skip an undecodable payload */ }
    }
    g.globalAlpha = 1;
    /* wash the imagery back so the drafting on top is legible in print */
    g.fillStyle = "rgba(255,255,255,.24)"; g.fillRect(0, 0, W, H);
    g.restore();

    /* ---- vector work, in print styling ---- */
    const ring = (pts, closed, style) => {
      if (!pts || pts.length < 2) return;
      g.save();
      Object.assign(g, style.ctx || {});
      g.strokeStyle = style.color; g.lineWidth = style.w || 1.4;
      if (style.dash) g.setLineDash(style.dash);
      g.beginPath();
      g.moveTo(PX(pts[0][0]), PY(pts[0][1]));
      for (let i = 1; i < pts.length; i++) g.lineTo(PX(pts[i][0]), PY(pts[i][1]));
      if (closed) g.closePath();
      if (style.fill) { g.fillStyle = style.fill; g.fill(); }
      g.stroke();
      g.restore();
    };

    /* context: decision units and pile outlines, if they are switched on */
    if (SBMM.layers.duGrp && SBMM.map.hasLayer(SBMM.layers.duGrp))
      for (const d of SBMM_DATA.dus) ring(d.ring, true, { color: "rgba(60,60,60,.55)", w: 0.8, dash: [6, 4] });
    if (SBMM.layers.pileGrp && SBMM.map.hasLayer(SBMM.layers.pileGrp))
      for (const p of SBMM_DATA.piles) ring(p.ring, true, { color: "rgba(60,60,60,.5)", w: 0.8, dash: [3, 3] });

    /* other drawn features, quietly */
    for (const o of SBMM.store.features) {
      if (o === f || o.visible === false || !o.pts || o.pts.length < 2) continue;
      if (o.type === "surface" && o._daylight) continue;
      ring(o.pts, o.type === "area" || o.type === "volume" || o.type === "surface",
        { color: "rgba(90,90,90,.55)", w: 0.8 });
    }

    /* the subject itself */
    if (f.type === "sections" && f._sec) {
      const R = f._sec;
      ring(f.pts, false, { color: "#000", w: 1.8 });
      for (let i = 0; i < R.ns; i++) {
        const a = [R.cx[i] - R.nx[i] * R.half, R.cy[i] - R.ny[i] * R.half];
        const b = [R.cx[i] + R.nx[i] * R.half, R.cy[i] + R.ny[i] * R.half];
        ring([a, b], false, { color: "#111", w: 0.9 });
        const every = R.ns > 20 ? 2 : 1;
        if (i % every === 0) {
          g.save();
          g.font = "600 11px ui-monospace,Consolas,monospace";
          g.lineWidth = 3; g.strokeStyle = "#fff"; g.lineJoin = "round";
          const lbl = SBMM.sections.staLabel(R.sta[i]);
          g.strokeText(lbl, PX(b[0]) + 5, PY(b[1]) + 3);
          g.fillStyle = "#000";
          g.fillText(lbl, PX(b[0]) + 5, PY(b[1]) + 3);
          g.restore();
        }
      }
    } else {
      ring(f.pts, true, { color: "#000", w: 2, fill: "rgba(0,0,0,.05)" });
    }
    /* A volume measured against a design surface is really a drawing OF that design:
       the daylight line belongs on the figure even though it hangs off the surface
       feature rather than off the volume the sheet is about. */
    const dlSource = f._daylight ? f
      : (f.type === "volume" && f.props.baseMode === "design" && SBMM.design.byId(f.props.designId))
      || (f.type === "sections" && f.props.designId && SBMM.design.byId(f.props.designId)) || null;
    if (dlSource && dlSource._daylight)
      for (const line of dlSource._daylight) ring(line, true, { color: "#0a5f74", w: 1.7, dash: [8, 4] });

    /* ---- north arrow ---- */
    g.save();
    g.translate(W - 46, 44);
    g.fillStyle = "#000"; g.strokeStyle = "#000"; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, -24); g.lineTo(8, 12); g.lineTo(0, 5); g.lineTo(-8, 12); g.closePath();
    g.fill();
    g.font = "600 12px Helvetica,Arial,sans-serif"; g.textAlign = "center";
    g.fillText("N", 0, 28);
    g.restore();

    /* ---- scale bar ---- */
    const barFt = niceLen(x1 - x0), barPx = barFt * s;
    g.save();
    const bx = 16, by = H - 22;
    g.fillStyle = "rgba(255,255,255,.86)";
    g.fillRect(bx - 6, by - 20, barPx + 62, 30);
    g.strokeStyle = "#000"; g.lineWidth = 1;
    g.strokeRect(bx - 6, by - 20, barPx + 62, 30);
    /* alternating black/white segments, the surveying convention */
    const seg = barPx / 4;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? "#fff" : "#000";
      g.fillRect(bx + i * seg, by - 12, seg, 6);
      g.strokeRect(bx + i * seg, by - 12, seg, 6);
    }
    g.fillStyle = "#000";
    g.font = "10px Helvetica,Arial,sans-serif";
    g.fillText("0", bx - 2, by + 6);
    g.fillText(fmt0(barFt) + " ft", bx + barPx - 10, by + 6);
    g.restore();

    /* The attribution mark — and, while cultural layers are visible, the
       confidentiality stamp — are burned into the figure itself. A report sheet
       is printed and handed round; an element on the screen would not survive
       that trip, and the notice has to (§7, §10). */
    SBMM.watermark.burn(cv);
    return { url: cv.toDataURL("image/png"), bbox: [x0, y0, x1, y1], scaleFt: barFt };
  }

  /* ------------------------------------------------------------------ */
  /* sections sheet                                                      */
  /* ------------------------------------------------------------------ */
  /* Each section is drawn at a stated scale: 1 in = N ft horizontal, with the
     vertical exaggerated by a round factor so relief is readable — and the
     exaggeration is printed on the sheet, because an unlabelled exaggerated
     section is a misleading drawing. */
  function sectionSheet(f) {
    const R = f._sec;
    if (!R) return { imgs: [], hScale: 0, vExag: 1 };
    const W = 520, H = 190, L = 52, Rr = 14, T = 22, B = 30;
    const plotW = W - L - Rr, plotH = H - T - B;
    const hFtPerPx = (R.half * 2) / plotW;
    /* choose a vertical exaggeration from the relief actually present */
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < R.ground.length; k++) {
      const v = R.ground[k]; if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (R.design) { const d = R.design[k]; if (!isNaN(d)) { if (d < lo) lo = d; if (d > hi) hi = d; } }
    }
    if (!isFinite(lo)) return { imgs: [], hScale: 0, vExag: 1 };
    const relief = Math.max(6, hi - lo);
    let vExag = 1;
    for (const e of [1, 2, 5, 10, 20]) { if (relief * e / hFtPerPx < plotH * 0.85) vExag = e; }
    const vFtPerPx = hFtPerPx / vExag;

    const imgs = [];
    for (let s = 0; s < R.ns; s++) {
      const cv = document.createElement("canvas");
      const dpr = 2;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);

      /* vertical window centred on this station's own ground */
      let slo = Infinity, shi = -Infinity;
      for (let o = 0; o < R.no; o++) {
        const k = s * R.no + o;
        for (const v of [R.ground[k], R.design ? R.design[k] : NaN])
          if (!isNaN(v)) { if (v < slo) slo = v; if (v > shi) shi = v; }
      }
      if (!isFinite(slo)) { slo = 0; shi = 10; }
      const mid = (slo + shi) / 2;
      const half = Math.max((shi - slo) / 2 * 1.25, plotH * vFtPerPx / 2);
      const zlo = mid - half, zhi = mid + half;
      const X = o => L + plotW * o / (R.no - 1);
      const Y = z => T + plotH * (1 - (z - zlo) / (zhi - zlo));

      /* grid: every 5 or 10 ft, whichever keeps the sheet clean */
      const span = zhi - zlo;
      const gi = span > 60 ? 20 : span > 30 ? 10 : span > 12 ? 5 : 2;
      g.strokeStyle = "#dcdcdc"; g.lineWidth = .6;
      g.fillStyle = "#333"; g.font = "9px ui-monospace,Consolas,monospace";
      for (let z = Math.ceil(zlo / gi) * gi; z <= zhi; z += gi) {
        g.beginPath(); g.moveTo(L, Y(z)); g.lineTo(W - Rr, Y(z)); g.stroke();
        g.fillText(z.toFixed(0), 8, Y(z) + 3);
      }
      const offGi = R.half * 2 > 400 ? 100 : R.half * 2 > 160 ? 50 : 20;
      for (let off = -R.half; off <= R.half + 1e-6; off += offGi) {
        const o = (off + R.half) / R.offStep;
        g.beginPath(); g.moveTo(X(o), T); g.lineTo(X(o), T + plotH); g.stroke();
        g.fillText((off > 0 ? "+" : "") + off.toFixed(0), X(o) - 8, T + plotH + 12);
      }
      g.strokeStyle = "#000"; g.lineWidth = 1;
      g.strokeRect(L + .5, T + .5, plotW - 1, plotH - 1);

      /* cut / fill hatch */
      if (R.design) {
        for (let o = 0; o + 1 < R.no; o++) {
          const k1 = s * R.no + o, k2 = k1 + 1;
          const g1 = R.ground[k1], g2 = R.ground[k2], d1 = R.design[k1], d2 = R.design[k2];
          if (isNaN(g1) || isNaN(g2) || isNaN(d1) || isNaN(d2)) continue;
          const cut = (g1 + g2) / 2 > (d1 + d2) / 2;
          g.fillStyle = cut ? "rgba(0,0,0,.16)" : "rgba(0,0,0,.06)";
          g.beginPath();
          g.moveTo(X(o), Y(g1)); g.lineTo(X(o + 1), Y(g2));
          g.lineTo(X(o + 1), Y(d2)); g.lineTo(X(o), Y(d1));
          g.closePath(); g.fill();
        }
      }
      const poly = (arr, color, w, dash) => {
        g.strokeStyle = color; g.lineWidth = w; g.setLineDash(dash || []);
        g.beginPath();
        let pen = false;
        for (let o = 0; o < R.no; o++) {
          const v = arr[s * R.no + o];
          if (isNaN(v)) { pen = false; continue; }
          if (!pen) { g.moveTo(X(o), Y(v)); pen = true; } else g.lineTo(X(o), Y(v));
        }
        g.stroke(); g.setLineDash([]);
      };
      if (R.canopy) {
        const top = new Float32Array(R.no);
        for (let o = 0; o < R.no; o++) {
          const k = s * R.no + o, c = R.canopy[k], gr = R.ground[k];
          top[o] = (isNaN(c) || isNaN(gr) || c <= 2) ? NaN : gr + c;
        }
        poly(top, "#4a7d55", .9, [4, 3]);
      }
      if (R.design) poly(R.design, "#000", 1.5, [6, 3]);
      poly(R.ground, "#000", 1.7);

      g.fillStyle = "#000"; g.font = "600 11px Helvetica,Arial,sans-serif";
      g.fillText("STA " + SBMM.sections.staLabel(R.sta[s]), L, 14);
      if (R.cutA) {
        g.font = "10px ui-monospace,Consolas,monospace";
        g.fillText(`cut ${fmt0(R.cutA[s])} ft²   fill ${fmt0(R.fillA[s])} ft²`, L + 120, 14);
      }
      g.font = "9px Helvetica,Arial,sans-serif"; g.fillStyle = "#555";
      g.fillText("offset (ft)", L + plotW / 2 - 22, H - 6);
      SBMM.watermark.burn(cv, { size: 11 * dpr });
      imgs.push({ url: cv.toDataURL("image/png"), sta: R.sta[s] });
    }
    return { imgs, hScale: hFtPerPx * 96, vExag };
  }

  /* ------------------------------------------------------------------ */
  /* sheet assembly                                                      */
  /* ------------------------------------------------------------------ */
  function esc2(s) { return esc(s == null ? "" : s); }

  function quantitiesTable(f) {
    if (f.type === "volume") {
      const m = f._volMeta;
      if (!m) return "<p class='none'>No volume computed yet.</p>";
      const yd = v => sig2(v) + " yd³";
      const dsn = m.baseMode === "design";
      const rows = [
        [dsn ? "Cut — terrain above design" : "Volume above base", yd(m.fill_yd3)],
        [dsn ? "Fill — design above terrain" : "Volume below base", yd(m.cut_yd3)],
        [dsn ? "Net (cut − fill)" : "Net (above − below)", yd(m.net_yd3)],
        ["Tonnage @ " + m.density + " t/yd³", sig2(m.fill_yd3 * m.density) + " tons"],
        ["Truckloads @ 10 yd³", fmt0(Math.ceil(m.fill_yd3 / 10)) + " loads"],
        ["Footprint area", fmt(m.area / 43560, 3) + " ac (" + fmt0(m.area) + " ft²)"],
        [dsn ? "Mean / max cut depth" : "Mean / max height",
         fmt(m.hmean || 0, 1) + " / " + fmt(m.hmax || 0, 1) + " ft"],
        ["Terrain range", fmt(m.zmin, 1) + " – " + fmt(m.zmax, 1) + " ft"],
        ["Integration grid", `${m.demCell}-ft DEM sampled at ${m.step} ft · ${fmt0(m.cells)} cells`]
      ];
      let out = table(["Quantity", "Value"], rows);
      /* the design the quantities were measured against is part of the answer */
      const surf = dsn && SBMM.design.byId(m.designId);
      if (surf) {
        const p = surf.props;
        out += `<h3>Design surface — ${esc2(surf.name)}</h3>` + table(["Parameter", "Value"], [
          ["Pad type", p.kind === "plane" ? `sloped plane, ${fmt(p.gradePct, 2)} % toward ${fmt0(p.gradeDirDeg)}°` : p.kind === "existing" ? "existing-ground copy" : "flat pad"],
          ["Pad elevation", p.kind === "existing" ? "existing ground" : fmt(p.padZ, 2) + " ft"],
          ["Side slope", p.kind === "existing" ? "—" : `${p.ratio || 3}:1 (H:V), ${p.side === "in" ? "inward batter" : "daylighting outward"}`],
          ["Design elevation range", fmt(p.design_zmin_ft, 1) + " – " + fmt(p.design_zmax_ft, 1) + " ft"],
          ["Whole-surface cut / fill", sig2(p.cut_yd3) + " / " + sig2(p.fill_yd3) + " yd³"]
        ].concat(p.balance_z_ft != null ? [["Balanced at", fmt(p.balance_z_ft, 2) + " ft"]] : []));
      }
      return out;
    }
    if (f.type === "surface") {
      const p = f.props;
      const rows = [
        ["Cut (excavate)", sig2(p.cut_yd3) + " yd³"],
        ["Fill (place)", sig2(p.fill_yd3) + " yd³"],
        ["Net (cut − fill)", sig2(p.net_yd3) + " yd³"],
        ["Pad elevation", p.kind === "existing" ? "existing ground" : fmt(p.padZ, 2) + " ft"],
        ["Side slope", p.kind === "existing" ? "—" : `${p.ratio || 3}:1 (H:V), ${p.side === "in" ? "inward batter" : "daylighting outward"}`],
        ["Pad type", p.kind === "plane" ? `sloped plane, ${fmt(p.gradePct, 2)} % toward ${fmt0(p.gradeDirDeg)}° (0° = east)` : p.kind === "existing" ? "existing-ground copy" : "flat pad"],
        ["Design elevation range", fmt(p.design_zmin_ft, 1) + " – " + fmt(p.design_zmax_ft, 1) + " ft"],
        ["Footprint area", fmt(polyArea(f.pts) / 43560, 3) + " ac"],
        ["Design raster", esc2(p.grid)]
      ];
      if (p.balance_z_ft != null)
        rows.push(["Balanced at", fmt(p.balance_z_ft, 2) + " ft (" + p.balance_iters + " bisection steps)"]);
      return table(["Quantity", "Value"], rows);
    }
    if (f.type === "sections") {
      const R = f._sec;
      if (!R) return "<p class='none'>No sections cut yet.</p>";
      const rows = [
        ["Sections", `${R.ns} at ${fmt0(R.interval)} ft`],
        ["Alignment length", fmt(R.total, 1) + " ft (" + SBMM.sections.staLabel(0) + " to " + SBMM.sections.staLabel(R.total) + ")"],
        ["Swath width", fmt0(R.half * 2) + " ft"]
      ];
      if (f._endArea) {
        rows.push(["End-area cut", sig2(f._endArea.cut / 27) + " yd³"]);
        rows.push(["End-area fill", sig2(f._endArea.fill / 27) + " yd³"]);
      }
      if (f._cross) {
        rows.push(["Grid-integration cut", sig2(f._cross.grid.cut) + " yd³"]);
        rows.push(["Grid-integration fill", sig2(f._cross.grid.fill) + " yd³"]);
        rows.push(["End-area vs grid", fmt(f._cross.diffPct, 1) + " %"]);
      }
      return table(["Quantity", "Value"], rows);
    }
    return "";
  }
  function table(head, rows) {
    return `<table class="qt"><thead><tr>${head.map(h => `<th>${esc2(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc2(r[0])}</td><td class="num">${esc2(r[1])}</td></tr>`).join("")}</tbody></table>`;
  }

  function rangeTable(f) {
    if (!f._range) return "";
    const r = f._range;
    return `<h3>Uncertainty range</h3>
      <p>The base surface under a topographic volume is a modelling choice, not a measurement.
      The same footprint was integrated against five defensible bases; the spread below is the
      range that choice produces. The perimeter-TIN result is the one to quote — it is the method
      the ABP technical memorandum used.</p>
      <div class="triple"><div><b>${sig2(r.lo)}</b><span>low</span></div>
        <div class="best"><b>${sig2(r.best)}</b><span>best estimate</span></div>
        <div><b>${sig2(r.hi)}</b><span>high</span></div></div>
      ${table(["Base surface", "Volume above base (yd³)"], r.methods.map(m => [m.label, sig2(m.fill)]))}`;
  }

  function notesFor(f) {
    const bits = [
      "Volumes are <b>neat in-place topographic quantities</b> — no bulking factor, no allowance for material lying below surrounding grade, no subgrade preparation. They are planning-level figures and are reported to two significant figures.",
      SURVEY_NOTE,
      "The DEM is only as good as the survey: bare earth from the January 2024 flight, with the usual lidar limitations under dense canopy. The 2-ft site grid resolves features down to about 4 ft; the 1-ft mine-area window about 2 ft."
    ];
    if (f.type === "volume" && f._volMeta && f._volMeta.baseMode === "tin")
      bits.splice(1, 0, "The base surface is a Delaunay TIN interpolated through the footprint perimeter — the ABP technical memorandum Attachment E method.");
    if (f.type === "surface" || (f.type === "volume" && f._volMeta && f._volMeta.baseMode === "design"))
      bits.splice(1, 0, "Cut and fill are measured between existing ground and the design surface. Side slopes daylight into existing ground; beyond the daylight line the design surface is existing ground, so no quantity accrues there.");
    if (f.type === "sections")
      bits.splice(1, 0, "End-area quantities use the average-end-area rule between consecutive stations, and are cross-checked against an independent grid integration of the same corridor.");
    bits.push("A tonnage line, where shown, is volume × the density entered on screen — pick the density appropriate to the material.");
    return "<ul>" + bits.map(b => `<li>${b}</li>`).join("") + "</ul>";
  }

  const SHEET_CSS = `
    @page { size: letter portrait; margin: 0.6in; }
    *{box-sizing:border-box}
    body{margin:0;background:#fff;color:#111;
      font:11.5px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif;
      -webkit-print-color-adjust:exact;print-color-adjust:exact}
    .sheet{max-width:7.3in;margin:0 auto;padding:18px 4px 40px}
    .tblock{border:1.4px solid #111;margin-bottom:16px}
    .tblock .row1{display:flex;align-items:stretch;border-bottom:1px solid #111}
    .tblock .who{padding:9px 12px;flex:1}
    .tblock .who h1{font-size:16px;letter-spacing:.02em;margin:0 0 2px;font-weight:700}
    .tblock .who .sub{font-size:11px;color:#333}
    .tblock .stamp{padding:9px 12px;border-left:1px solid #111;min-width:2.0in;font-size:10.5px}
    .tblock .stamp div{display:flex;justify-content:space-between;gap:10px}
    .tblock .stamp span{color:#555}
    .tblock .row2{display:flex;font-size:10px}
    .tblock .row2 div{padding:5px 12px;border-right:1px solid #ccc}
    .tblock .row2 div:last-child{border-right:0}
    h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.09em;margin:20px 0 7px;
      padding-bottom:3px;border-bottom:1.2px solid #111}
    h3{font-size:11.5px;margin:15px 0 5px;font-weight:700}
    p{margin:0 0 8px}
    figure{margin:0 0 6px}
    figure img{width:100%;border:1px solid #111;display:block}
    figcaption{font-size:10px;color:#444;margin-top:4px}
    table.qt{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:11px}
    table.qt th{text-align:left;background:#eee;border:1px solid #999;padding:4px 7px;font-size:10px;
      text-transform:uppercase;letter-spacing:.05em}
    table.qt td{border:1px solid #bbb;padding:4px 7px}
    table.qt td.num{text-align:right;font-family:ui-monospace,Consolas,monospace;white-space:nowrap}
    table.qt tbody tr:nth-child(odd){background:#fafafa}
    .triple{display:flex;gap:8px;margin:8px 0 10px}
    .triple div{flex:1;border:1px solid #999;padding:7px;text-align:center;background:#fafafa}
    .triple div.best{border-width:1.8px;border-color:#111;background:#fff}
    .triple b{display:block;font-size:16px;font-family:ui-monospace,Consolas,monospace}
    .triple span{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:#555}
    ul{margin:4px 0 8px 16px;padding:0} li{margin-bottom:4px}
    .secgrid{display:flex;flex-direction:column;gap:8px}
    .secgrid img{width:100%;border:1px solid #999;display:block}
    .foot{margin-top:20px;border-top:1px solid #111;padding-top:6px;font-size:9.5px;color:#555;
      display:flex;justify-content:space-between}
    .none{color:#777;font-style:italic}
    @media print{ .secgrid img{break-inside:avoid} figure{break-inside:avoid} h2{break-after:avoid} }
  `;

  async function buildHTML(f) {
    const fig = await composeFigure(f, 1100, 760);
    const dlSurf = f._daylight ? f
      : ((f.props.baseMode === "design" || f.type === "sections") && f.props.designId
         && SBMM.design.byId(f.props.designId)) || null;
    const dlShown = !!(dlSurf && dlSurf._daylight && dlSurf._daylight.length);
    const today = new Date().toISOString().slice(0, 10);
    const kindLabel = { volume: "Volume calculation", surface: "Grading design", sections: "Cross-sections" }[f.type] || "Feature";
    const c = centroid(f.pts);

    let secBlock = "";
    if (f.type === "sections" && f._sec) {
      const sh = sectionSheet(f);
      if (sh.imgs.length) {
        secBlock = `<h2>Sections</h2>
          <p>Sections cut perpendicular to the alignment, looking up-station; offsets negative to the
          left. Horizontal scale 1 in ≈ ${fmt0(sh.hScale)} ft, vertical exaggeration ${sh.vExag}×.
          Solid line existing ground${f._sec.design ? ", dashed line design surface" : ""}${f._sec.canopy ? ", fine dashed line canopy top" : ""}.</p>
          <div class="secgrid">${sh.imgs.map(im => `<img src="${im.url}" alt="Station ${SBMM.sections.staLabel(im.sta)}">`).join("")}</div>`;
      }
    }
    /* a volume that sits on a design surface gets that surface's sections too, when
       one of the section sets covers it — that is the sheet an engineer actually wants */
    const [lo, la] = SBMM.toLL(c[0], c[1]);

    return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc2(f.name)} — SBMM OU1</title><style>${SHEET_CSS}</style></head><body>
<div class="sheet">
  <div class="tblock">
    <div class="row1">
      <div class="who">
        <h1>${esc2(f.name || kindLabel)}</h1>
        <div class="sub">${esc2(kindLabel)} · ${esc2(PROJECT)}</div>
      </div>
      <div class="stamp">
        <div><span>Prepared by</span><b>${esc2(AUTHOR)}</b></div>
        <div><span>Date</span><b>${today}</b></div>
        <div><span>Task</span><b>2.1.5</b></div>
        <div><span>Sheet</span><b>1 of 1</b></div>
      </div>
    </div>
    <div class="row2">
      <div><b>Coordinate system</b><br>EPSG:6418 · CA SP Zone 2 · ftUS</div>
      <div><b>Centroid</b><br>${fmt0(c[0])} E, ${fmt0(c[1])} N &nbsp;(${la.toFixed(5)}, ${lo.toFixed(5)})</div>
      <div><b>Source</b><br>30 Jan 2024 lidar survey</div>
    </div>
  </div>

  <h2>Figure 1 — ${esc2(f.name || kindLabel)}</h2>
  <figure><img src="${fig.url}" alt="Site figure">
    <figcaption>Existing-ground hillshade / orthophotography from the 30 January 2024 survey.
    Heavy solid line: ${f.type === "sections" ? "alignment, with section cut lines and station labels" : "the feature footprint"}.
    ${dlShown ? "Dashed line: computed daylight line, where the design side slopes meet existing ground. " : ""}
    ${f._cfLayer ? "Colour wash: cut/fill depth against the base surface — red where terrain stands above it, blue where it lies below. " : ""}
    Scale bar ${fmt0(fig.scaleFt)} ft. ${esc2(CRS_NOTE)}</figcaption></figure>

  <h2>Quantities</h2>
  ${quantitiesTable(f)}
  ${rangeTable(f)}
  ${secBlock}

  <h2>Method and caveats</h2>
  ${notesFor(f)}

  <div class="foot"><span>Jacobs · SBMM OU1 · Task 2.1.5</span>
    <span>Generated by SBMM Site Explorer · ${today}</span></div>
</div></body></html>`;
  }

  /* ------------------------------------------------------------------ */
  /* presentation                                                        */
  /* ------------------------------------------------------------------ */
  let lastHTML = "";

  async function open(f) {
    f = f || SBMM.store.selectedFeature();
    if (!f) { toast("select a volume, design surface or section set first"); return; }
    if (!["volume", "surface", "sections"].includes(f.type)) {
      toast("REPORT works on a volume, a design surface or a section set");
      return;
    }
    /* A report is a document that leaves the project. If cultural-resource
       locations are on screen they will be in its figures, so the same
       acknowledgement the layer group asked for is asked again here (§7). */
    if (SBMM.cultural && !(await SBMM.cultural.gateExport("report"))) {
      toast("report cancelled");
      return;
    }
    toast("composing the report sheet…");
    let html;
    try { html = await buildHTML(f); }
    catch (e) { console.error(e); toast("report failed: " + e.message); return; }
    lastHTML = html;

    let box = $("reportModal");
    if (box) box.remove();
    box = document.createElement("div");
    box.id = "reportModal";
    box.innerHTML = `<div class="rmbox">
      <div class="rmbar"><b>Report — ${esc(f.name || f.type)}</b><span class="spacer"></span>
        <button class="minib" id="rmPrint">Print / Save as PDF</button>
        <button class="minib" id="rmWin">open in a window</button>
        <button class="minib" id="rmHtml">save .html</button>
        <span class="ic x" id="rmClose" title="Close (Esc)">✕</span></div>
      <iframe id="rmFrame" title="Report preview"></iframe></div>`;
    document.body.appendChild(box);
    const frame = $("rmFrame");
    frame.srcdoc = html;
    const shut = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(); } };
    document.addEventListener("keydown", onKey, true);
    $("rmClose").onclick = shut;
    box.addEventListener("click", e => { if (e.target === box) shut(); });
    setTimeout(() => { const b2 = $("rmClose"); if (b2) b2.focus(); }, 30);
    $("rmPrint").onclick = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch (e) { toast("printing blocked — use 'open in a window'"); }
    };
    $("rmWin").onclick = () => {
      const w = window.open("", "_blank");
      if (!w) { toast("the browser blocked the window — use Print here instead"); return; }
      w.document.write(html); w.document.close();
    };
    $("rmHtml").onclick = () => download(
      `sbmm_report_${(f.name || f.type).replace(/\W+/g, "_")}.html`,
      new Blob([html], { type: "text/html" }));
    return html;
  }

  return { open, buildHTML, composeFigure, sectionSheet, lastHTML: () => lastHTML, AUTHOR };
})();
