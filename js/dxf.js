/* SBMM Site Explorer — DXF round-trip.

   OUT: ASCII DXF R12 (AC1009) — the most widely readable flavour there is. Nothing
   here needs anything newer: R12 POLYLINE/VERTEX/SEQEND, LINE, POINT and TEXT cover
   every feature type the app makes, and every reader from AutoCAD R12 to Civil 3D
   2026, BricsCAD, QGIS and ODA File Converter opens it without a translation step.
   Coordinates go out RAW, in State Plane feet (EPSG:6418) — the same numbers the
   project's AutoCAD drawings carry, so an imported file lands on the survey without
   a transform.

   IN: R12 and 2000 ASCII — LINE, LWPOLYLINE, POLYLINE/VERTEX, TEXT, POINT, CIRCLE
   (→ 32-segment polygon) and ARC (→ polyline). Coordinates are checked before
   anything is created: if they read as latitude/longitude, or as small local model
   coordinates, the import is refused with what it saw rather than guessed at.

   The ACI colour table is the real AutoCAD one, generated rather than pasted: ACI
   10–249 is 24 hues × 5 values × 2 saturations in exactly that order, so nearest-RGB
   matching lands on an index whose true colour is the one we matched. */
"use strict";

SBMM.dxf = (function () {

  /* ------------------------------------------------------------------ */
  /* ACI palette                                                        */
  /* ------------------------------------------------------------------ */
  const ACI = (function () {
    const t = {};
    const std = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255],
                  5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192] };
    for (const k in std) t[k] = std[k];
    const hsv = (h, s, v) => {
      const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
      const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
      return seg.map(u => Math.round((u + m) * 255));
    };
    const VALS = [255, 165, 127, 76, 38];
    for (let h = 0; h < 24; h++) for (let k = 0; k < 5; k++) {
      const idx = 10 + h * 10 + k * 2;
      t[idx] = hsv(h * 15, 1, VALS[k] / 255);
      t[idx + 1] = hsv(h * 15, 0.5, VALS[k] / 255);
    }
    for (let g = 0; g < 6; g++) { const v = [51, 91, 132, 173, 214, 255][g]; t[250 + g] = [v, v, v]; }
    return t;
  })();

  function hexRgb(c) {
    if (!c) return [255, 255, 255];
    let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c).trim());
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(String(c));
    if (m) return [+m[1], +m[2], +m[3]];
    return [255, 255, 255];
  }
  function toACI(color) {
    const [r, g, b] = hexRgb(color);
    let best = 7, bd = Infinity;
    for (const k in ACI) {
      const c = ACI[k];
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bd) { bd = d; best = +k; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */
  const N = v => (Math.round(v * 1e6) / 1e6).toFixed(6);
  function layerName(f) {
    const raw = f.group ? f.group.replace(/\//g, "-") : "SBMM-" + String(f.type).toUpperCase();
    return raw.toUpperCase().replace(/[^A-Z0-9_\-$.]/g, "_").slice(0, 31) || "SBMM";
  }
  function featColor(f) {
    return (f.style && f.style.color) || SBMM.tools.defaultColor(f.type) || "#FFFFFF";
  }

  function buildDXF(featuresIn) {
    const feats = (featuresIn || SBMM.store.features)
      .filter(f => f.visible !== false && f.pts && f.pts.length && !(f.props && f.props.ref));
    const o = [];
    const w = (c, v) => { o.push(String(c)); o.push(String(v)); };

    /* layer table, one per distinct name, coloured by the first feature that uses it */
    const layers = new Map();
    for (const f of feats) {
      const n = layerName(f);
      if (!layers.has(n)) layers.set(n, toACI(featColor(f)));
    }
    if (!layers.size) layers.set("SBMM", 7);
    /* computed geometry lands on its own conventional layers */
    if (feats.some(f => f.type === "surface" && f._daylight && f._daylight.length))
      layers.set("GRADING", toACI("#4FD8E6"));
    if (feats.some(f => f.type === "sections" && f._sec))
      layers.set("SECTION", toACI("#F0A6D0"));
    /* a raindrop's ponds are computed geometry like a daylight line, and land on
       their own layer so a drafter can freeze them apart from the run */
    if (feats.some(f => f.type === "flow" && f.props && (f.props.ponds || []).length))
      layers.set("WATER-PONDS", toACI("#55C1FF"));
    /* datasets get one layer each, named after the dataset — a Civil 3D user
       expects wells and borings on their own layers, not merged into the
       drawings they were measured against */
    const dsets = SBMM.datasets ? SBMM.datasets.dxfEntities() : [];
    for (const d of dsets) layers.set(d.layer, toACI(d.color));
    /* the native EA design goes out on EA-* layers, one per payload layer, so a
       Civil 3D user gets the limits of excavation back as real linework */
    const dgis = SBMM.designGIS ? SBMM.designGIS.dxfEntities() : [];
    for (const d of dgis) layers.set(d.layer, toACI(d.color));

    /* extents */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of feats) for (const p of f.pts) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    for (const d of dsets) for (const p of d.points) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    for (const d of dgis) for (const p of (d.pts || [d.point])) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }

    w(0, "SECTION"); w(2, "HEADER");
    w(9, "$ACADVER"); w(1, "AC1009");
    w(9, "$EXTMIN"); w(10, N(x0)); w(20, N(y0)); w(30, N(0));
    w(9, "$EXTMAX"); w(10, N(x1)); w(20, N(y1)); w(30, N(0));
    w(9, "$LUNITS"); w(70, 2);
    w(0, "ENDSEC");

    w(0, "SECTION"); w(2, "TABLES");
    w(0, "TABLE"); w(2, "LTYPE"); w(70, 1);
    w(0, "LTYPE"); w(2, "CONTINUOUS"); w(70, 0); w(3, "Solid line"); w(72, 65); w(73, 0); w(40, "0.0");
    w(0, "ENDTAB");
    w(0, "TABLE"); w(2, "LAYER"); w(70, layers.size);
    for (const [name, aci] of layers) {
      w(0, "LAYER"); w(2, name); w(70, 0); w(62, aci); w(6, "CONTINUOUS");
    }
    w(0, "ENDTAB");
    w(0, "ENDSEC");

    w(0, "SECTION"); w(2, "ENTITIES");
    for (const f of feats) emitFeature(w, f, layerName(f));
    for (const f of feats) emitDerived(w, f);
    for (const d of dsets) for (const p of d.points) {
      w(0, "POINT"); w(8, d.layer); w(10, N(p.x)); w(20, N(p.y)); w(30, "0.0");
      text(w, d.layer, [p.x + 3, p.y + 3], 6, p.id, 0);
    }
    for (const d of dgis) {
      if (d.point) { w(0, "POINT"); w(8, d.layer); w(10, N(d.point[0])); w(20, N(d.point[1])); w(30, "0.0"); }
      else if (d.pts && d.pts.length > 1) polyline(w, d.layer, d.pts, !!d.closed);
    }
    w(0, "ENDSEC");
    w(0, "EOF");
    return o.join("\r\n") + "\r\n";
  }

  function line(w, lay, a, b) {
    w(0, "LINE"); w(8, lay);
    w(10, N(a[0])); w(20, N(a[1])); w(30, "0.0");
    w(11, N(b[0])); w(21, N(b[1])); w(31, "0.0");
  }
  function polyline(w, lay, pts, closed) {
    w(0, "POLYLINE"); w(8, lay); w(66, 1); w(70, closed ? 1 : 0);
    w(10, "0.0"); w(20, "0.0"); w(30, "0.0");
    for (const p of pts) {
      w(0, "VERTEX"); w(8, lay); w(10, N(p[0])); w(20, N(p[1])); w(30, "0.0");
    }
    w(0, "SEQEND"); w(8, lay);
  }
  function text(w, lay, p, h, s, rotDeg) {
    w(0, "TEXT"); w(8, lay);
    w(10, N(p[0])); w(20, N(p[1])); w(30, "0.0");
    w(40, N(h));
    w(1, String(s).replace(/[\r\n]+/g, " "));
    w(50, N(rotDeg || 0));
  }

  /* A design surface's daylight line and a section set's cut lines are computed,
     not drawn — but they are the geometry a drafter wants in the DWG, so they go out
     on GRADING and SECTION, the layers a Civil 3D user expects to find them on. */
  function emitDerived(w, f) {
    if (f.type === "surface" && f._daylight) {
      for (const line of f._daylight) if (line.length > 1) polyline(w, "GRADING", line, true);
    }
    if (f.type === "flow" && f.props && f.props.ponds) {
      for (const pd of f.props.ponds)
        for (const ring of (pd.rings || []))
          if (ring.length > 2) polyline(w, "WATER-PONDS", ring, true);
    }
    if (f.type === "sections" && f._sec) {
      const R = f._sec;
      for (let s = 0; s < R.ns; s++) {
        const a = [R.cx[s] - R.nx[s] * R.half, R.cy[s] - R.ny[s] * R.half];
        const b = [R.cx[s] + R.nx[s] * R.half, R.cy[s] + R.ny[s] * R.half];
        line(w, "SECTION", a, b);
        const h = Math.max(3, R.half * 0.06);
        text(w, "SECTION", [b[0] + h * 0.4, b[1]], h, SBMM.sections.staLabel(R.sta[s]), 0);
      }
    }
  }

  function emitFeature(w, f, lay) {
    const t = f.type;
    if (t === "spot") { w(0, "POINT"); w(8, lay); w(10, N(f.pts[0][0])); w(20, N(f.pts[0][1])); w(30, "0.0"); return; }
    if (t === "area" || t === "volume" || t === "surface") { polyline(w, lay, f.pts, true); return; }
    if (t === "line" || t === "profile" || t === "sections" || t === "flow") { polyline(w, lay, f.pts, false); return; }
    if (t === "text") {
      const h = (f.props && f.props.size_ft) || 20;
      if (f.pts.length > 1) line(w, lay, f.pts[1], f.pts[0]);
      text(w, lay, f.pts[0], h, (f.props && f.props.text) || f.name || "text", 0);
      return;
    }
    if (t === "dim") {
      /* R12 has a DIMENSION entity, but it needs a block definition to render and
         degrades badly across readers. An exploded dimension — the same lines and the
         same text — opens identically everywhere, which is the point of R12 here. */
      const a = f.pts[0], b = f.pts[1];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
      const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const off = (f.props && f.props.off) || 0;
      const A = [a[0] + nx * off, a[1] + ny * off], B = [b[0] + nx * off, b[1] + ny * off];
      const tick = Math.max(1.5, L * 0.03), th = Math.max(2, L * 0.05);
      line(w, lay, A, B);
      for (const p of [A, B]) line(w, lay, [p[0] - nx * tick, p[1] - ny * tick], [p[0] + nx * tick, p[1] + ny * tick]);
      /* arrow "V"s, drawn as plain lines so no SOLID/BLOCK support is required */
      const v = (tip, sx, sy) => {
        line(w, lay, tip, [tip[0] + sx * tick * 2 + nx * tick * .6, tip[1] + sy * tick * 2 + ny * tick * .6]);
        line(w, lay, tip, [tip[0] + sx * tick * 2 - nx * tick * .6, tip[1] + sy * tick * 2 - ny * tick * .6]);
      };
      v(A, ux, uy); v(B, -ux, -uy);
      let deg = Math.atan2(uy, ux) * 180 / Math.PI;
      if (deg > 90 || deg < -90) deg += 180;
      const mid = [(A[0] + B[0]) / 2 + nx * th * .7 - ux * th * 1.4, (A[1] + B[1]) / 2 + ny * th * .7 - uy * th * 1.4];
      text(w, lay, mid, th, fmt(L, 2) + " ft", deg);
      return;
    }
    /* anything else: fall back to its polyline */
    if (f.pts.length > 1) polyline(w, lay, f.pts, false); else { w(0, "POINT"); w(8, lay); w(10, N(f.pts[0][0])); w(20, N(f.pts[0][1])); w(30, "0.0"); }
  }

  function exportDXF() {
    const vis = SBMM.store.features.filter(f => f.visible !== false && f.pts && f.pts.length && !(f.props && f.props.ref));
    const nds = SBMM.datasets ? SBMM.datasets.list().length : 0;
    const ndg = SBMM.designGIS && SBMM.designGIS.counts
      ? Object.values(SBMM.designGIS.counts).reduce((a, b) => a + b, 0) : 0;
    if (!vis.length && !nds && !ndg) { toast("nothing drawn yet — DXF would be empty"); return; }
    const txt = buildDXF(vis);
    download("sbmm_drawings_stateplane_6418.dxf", new Blob([txt], { type: "application/dxf" }));
    toast(`DXF R12 exported — ${vis.length} feature${vis.length === 1 ? "" : "s"}`
      + (nds ? ` + ${nds} dataset${nds === 1 ? "" : "s"}` : "")
      + (ndg ? ` + EA design (${ndg})` : "")
      + `, State Plane ft (EPSG:6418)`);
  }

  /* ------------------------------------------------------------------ */
  /* import                                                              */
  /* ------------------------------------------------------------------ */
  function pairs(txt) {
    const raw = txt.split(/\r\n|\r|\n/);
    const out = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const c = parseInt(raw[i].trim(), 10);
      if (isNaN(c)) { i--; continue; }                 // resync on a stray line
      out.push([c, raw[i + 1]]);
    }
    return out;
  }

  function parseDXF(txt) {
    const P = pairs(txt);
    const ents = [];
    let sec = null, wantSec = false, cur = null;
    for (const [c, v] of P) {
      const val = v == null ? "" : v.trim();
      if (c === 0) {
        if (val === "SECTION") { wantSec = true; cur = null; continue; }
        if (val === "ENDSEC") { sec = null; cur = null; continue; }
        if (val === "EOF") break;
        cur = (sec === "ENTITIES") ? { type: val.toUpperCase(), g: {} } : null;
        if (cur) ents.push(cur);
        continue;
      }
      if (wantSec && c === 2) { sec = val.toUpperCase(); wantSec = false; continue; }
      if (cur) { (cur.g[c] = cur.g[c] || []).push(v); }
    }
    const num = (e, code, i) => { const a = e.g[code]; return a && a[i || 0] != null ? parseFloat(a[i || 0]) : NaN; };
    const str = (e, code) => { const a = e.g[code]; return a && a[0] != null ? a[0].trim() : ""; };

    const out = [];
    const push = o => { if (o && o.pts && o.pts.every(p => isFinite(p[0]) && isFinite(p[1]))) out.push(o); };
    const arcPts = (cx, cy, r, a0, a1, segs) => {
      let sweep = a1 - a0;
      while (sweep <= 0) sweep += 360;
      const n = Math.max(6, Math.min(96, segs || Math.ceil(sweep / 11.25)));
      const p = [];
      for (let i = 0; i <= n; i++) {
        const a = (a0 + sweep * i / n) * Math.PI / 180;
        p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return p;
    };

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i], lay = str(e, 8) || "DXF";
      if (e.type === "LINE") {
        push({ kind: "line", layer: lay, pts: [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]] });
      } else if (e.type === "LWPOLYLINE") {
        const xs = e.g[10] || [], ys = e.g[20] || [];
        const pts = [];
        for (let k = 0; k < Math.min(xs.length, ys.length); k++) pts.push([parseFloat(xs[k]), parseFloat(ys[k])]);
        const flag = e.g[70] ? parseInt(e.g[70][0], 10) : 0;
        if (pts.length >= 2) push({ kind: (flag & 1) ? "poly" : "line", layer: lay, pts });
      } else if (e.type === "POLYLINE") {
        const flag = e.g[70] ? parseInt(e.g[70][0], 10) : 0;
        const pts = [];
        let j = i + 1;
        for (; j < ents.length && ents[j].type === "VERTEX"; j++) pts.push([num(ents[j], 10), num(ents[j], 20)]);
        if (j < ents.length && ents[j].type === "SEQEND") j++;
        i = j - 1;
        if (pts.length >= 2) push({ kind: (flag & 1) ? "poly" : "line", layer: lay, pts });
      } else if (e.type === "POINT") {
        push({ kind: "point", layer: lay, pts: [[num(e, 10), num(e, 20)]] });
      } else if (e.type === "TEXT" || e.type === "MTEXT") {
        const s = str(e, 1).replace(/\\[A-Za-z][^;]*;/g, "").replace(/[{}]/g, "");
        push({ kind: "text", layer: lay, text: s || "text", h: num(e, 40) || 20, pts: [[num(e, 10), num(e, 20)]] });
      } else if (e.type === "CIRCLE") {
        const cx = num(e, 10), cy = num(e, 20), r = num(e, 40);
        if (isFinite(r) && r > 0) push({ kind: "poly", layer: lay, pts: arcPts(cx, cy, r, 0, 360, 32).slice(0, 32) });
      } else if (e.type === "ARC") {
        const cx = num(e, 10), cy = num(e, 20), r = num(e, 40);
        if (isFinite(r) && r > 0) push({ kind: "line", layer: lay, pts: arcPts(cx, cy, r, num(e, 50) || 0, num(e, 51) || 0) });
      }
    }
    return out;
  }

  /* refuse rather than guess — the whole point of raw State Plane coordinates */
  function checkCRS(objs) {
    const xs = [], ys = [];
    for (const o of objs) for (const p of o.pts) { xs.push(p[0]); ys.push(p[1]); }
    if (!xs.length) return { ok: false, why: "no usable geometry in that DXF" };
    const ax = xs.map(Math.abs), ay = ys.map(Math.abs);
    const mx = Math.max(...ax), my = Math.max(...ay);
    if (mx <= 180 && my <= 90)
      return { ok: false, why: `those look like latitude/longitude (max ${mx.toFixed(3)}, ${my.toFixed(3)}), not State Plane feet — reproject the drawing to EPSG:6418 first` };
    if (mx < 1e5)
      return { ok: false, why: `those look like local model coordinates (max ${fmt0(mx)}, ${fmt0(my)}), not State Plane feet — the drawing needs georeferencing to EPSG:6418 first` };
    if (mx > 2e7 || my > 2e7)
      return { ok: false, why: `coordinates are out of range for State Plane feet (max ${fmt0(mx)}, ${fmt0(my)}) — metres, perhaps?` };
    return { ok: true, mx, my };
  }

  function importText(txt, fname) {
    const objs = parseDXF(txt);
    if (!objs.length) throw new Error("no LINE / POLYLINE / TEXT / POINT / CIRCLE / ARC entities found");
    const chk = checkCRS(objs);
    if (!chk.ok) throw new Error(chk.why);
    const base = (fname || "dxf").replace(/\.[^.]+$/, "");
    let n = 0;
    for (const o of objs) {
      const group = o.layer && o.layer !== "0" ? "DXF/" + o.layer : "DXF";
      if (o.kind === "point") { SBMM.tools.rebuildFeature({ type: "spot", pts: o.pts, group }); n++; }
      else if (o.kind === "text") {
        SBMM.tools.rebuildFeature({ type: "text", pts: o.pts, name: o.text, group, props: { text: o.text, size_ft: o.h } });
        n++;
      } else if (o.kind === "poly") {
        let ring = o.pts;
        if (ring.length > 2 && dist2d(ring[0], ring[ring.length - 1]) < 0.001) ring = ring.slice(0, -1);
        if (ring.length >= 3) { SBMM.tools.rebuildFeature({ type: "area", pts: ring, name: base + " poly", group }); n++; }
      } else {
        if (o.pts.length >= 2) { SBMM.tools.rebuildFeature({ type: "line", pts: o.pts, name: base + " line", group }); n++; }
      }
    }
    SBMM.store.emit();
    return n;
  }

  function importPrompt() {
    const inp = $("importFile");
    inp.click();
    toast("choose a .dxf (State Plane ft) — or drag it onto the map");
  }

  return { buildDXF, exportDXF, parseDXF, importText, importPrompt, toACI, ACI, checkCRS };
})();
