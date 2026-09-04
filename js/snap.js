/* SBMM Site Explorer — object snaps (OSNAP) + the drafting overlay canvas.

   Two indexes, both simple uniform grid hashes over State Plane feet:

     static   DU rings, pile rings, both survey contour layers, sample points,
              and the EA residential Final Design boundaries.
              Built once (lazily, off the boot path) and never touched again —
              ~45k segments, so a hover has to be O(cells touched), not O(n).
     dynamic  everything the user has drawn. Rebuilt on every store change, which
              is cheap because it is small.

   A query collects the segments in the cells the tolerance box touches and scores
   endpoint / midpoint / intersection / perpendicular / nearest candidates against
   the cursor, with AutoCAD's priority order. Tolerance is a screen distance
   (default 10 px) converted through the map's zoom, so it feels the same at every
   scale.

   Glyphs are painted on ONE 2D canvas stretched over the map (#snapCanvas), not on
   Leaflet markers: a marker per hover would churn the DOM on every mousemove. The
   same canvas carries the polar/ortho tracking ray and its angle readout. */
"use strict";

SBMM.snap = (function () {

  const TYPES = ["end", "mid", "int", "perp", "near"];
  const LABEL = { end: "endpoint", mid: "midpoint", int: "intersection", perp: "perpendicular", near: "nearest" };
  const PRIO  = { end: 1, int: 2, mid: 3, perp: 4, near: 5 };

  let enabled = true;
  const on = { end: true, mid: true, int: true, perp: true, near: true };

  /* ------------------------------------------------------------------ */
  /* grid hash                                                          */
  /* ------------------------------------------------------------------ */
  const CELL = 250;                       // ft — a few hundred segments per cell

  function newIndex() { return { segs: [], pts: [], smap: new Map(), pmap: new Map() }; }
  const K = (i, j) => i + "," + j;

  function addSeg(ix, ax, ay, bx, by) {
    if (!(isFinite(ax) && isFinite(ay) && isFinite(bx) && isFinite(by))) return;
    if (ax === bx && ay === by) return;
    const id = ix.segs.length;
    ix.segs.push(ax, ay, bx, by);
    const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL);
    const j0 = Math.floor(Math.min(ay, by) / CELL), j1 = Math.floor(Math.max(ay, by) / CELL);
    /* a long contour "bridge" can span many cells; conservative bbox insert is fine */
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = K(i, j); let a = ix.smap.get(k); if (!a) ix.smap.set(k, a = []); a.push(id);
    }
  }
  function addPt(ix, x, y) {
    if (!(isFinite(x) && isFinite(y))) return;
    const id = ix.pts.length; ix.pts.push(x, y);
    const k = K(Math.floor(x / CELL), Math.floor(y / CELL));
    let a = ix.pmap.get(k); if (!a) ix.pmap.set(k, a = []); a.push(id);
  }
  function addPath(ix, pts, closed) {
    if (!pts || pts.length < 2) { if (pts && pts.length === 1) addPt(ix, pts[0][0], pts[0][1]); return; }
    for (let i = 1; i < pts.length; i++) addSeg(ix, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (closed) { const a = pts[pts.length - 1], b = pts[0]; addSeg(ix, a[0], a[1], b[0], b[1]); }
  }
  function gather(ix, x, y, tol) {
    const out = [];
    const i0 = Math.floor((x - tol) / CELL), i1 = Math.floor((x + tol) / CELL);
    const j0 = Math.floor((y - tol) / CELL), j1 = Math.floor((y + tol) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = ix.smap.get(K(i, j)); if (a) for (const id of a) out.push(id);
    }
    return out.length > 1 ? [...new Set(out)] : out;
  }
  function gatherPts(ix, x, y, tol) {
    const out = [];
    const i0 = Math.floor((x - tol) / CELL), i1 = Math.floor((x + tol) / CELL);
    const j0 = Math.floor((y - tol) / CELL), j1 = Math.floor((y + tol) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = ix.pmap.get(K(i, j)); if (a) for (const id of a) out.push(id);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the two indexes                                                    */
  /* ------------------------------------------------------------------ */
  let statix = null, dynix = newIndex();
  let built = null;                       // {segs, pts, ms} once the static index exists

  function buildStatic() {
    if (statix) return statix;
    const t0 = (performance && performance.now) ? performance.now() : 0;
    statix = newIndex();
    try {
      const D = window.SBMM_DATA || {};
      for (const d of (D.dus || [])) {
        addPath(statix, d.ring, true);
        for (const h of (d.holes || [])) addPath(statix, h, true);
      }
      for (const p of (D.piles || [])) addPath(statix, p.ring, true);
      for (const key of ["contours_site", "contours_abp"])
        for (const row of (D[key] || [])) addPath(statix, row[1], false);
      for (const p of (SBMM.samples || [])) addPt(statix, p.x, p.y);
      /* The native EA design geometry snaps like any other project linework —
         this is the one a drafter actually wants to snap to, so it goes in
         first. */
      if (SBMM.designGIS) {
        const dg = SBMM.designGIS.snapPaths();
        for (const r of dg.rings) addPath(statix, r, true);
        for (const q of dg.pts) addPt(statix, q[0], q[1]);
      }
      /* the surveyed pipes, sandbag wall and pit contours (spec §10) */
      if (SBMM.survey) {
        const sv = SBMM.survey.snapPaths();
        for (const r of sv.rings) addPath(statix, r, false);
      }
      /* the storm network (v12): the conduits as paths, the structures as points
         — a grate is exactly the kind of thing a drafter starts a line from */
      if (SBMM.storm) {
        const sm = SBMM.storm.snapPaths();
        for (const r of sm.rings) addPath(statix, r, false);
        for (const q of sm.pts) addPt(statix, q[0], q[1]);
      }
      /* EA design boundaries snap like any other project linework */
      if (SBMM.designEA) {
        const dz = SBMM.designEA.snapPaths();
        for (const r of dz.rings) addPath(statix, r, true);
        for (const q of dz.pts) addPt(statix, q[0], q[1]);
      }
      /* imported and baked datasets snap like any other project point, so a
         drawing can be started exactly on a well head or a boring collar */
      if (SBMM.datasets) for (const q of SBMM.datasets.snapPoints()) addPt(statix, q[0], q[1]);
    } catch (e) { console.warn("snap: static index failed", e); }
    built = {
      segs: statix.segs.length / 4, pts: statix.pts.length / 2,
      ms: +(((performance && performance.now) ? performance.now() : 0) - t0).toFixed(1)
    };
    return statix;
  }

  function reindexDrawn() {
    dynix = newIndex();
    for (const f of SBMM.store.features) {
      if (f.props && f.props.ref) continue;   // §5 footprints are bboxes, not drafted lines
      if (f.visible === false) continue;
      const closed = f.type === "area" || f.type === "volume";
      if (f.type === "spot" || (f.type === "text" && f.pts.length === 1)) addPt(dynix, f.pts[0][0], f.pts[0][1]);
      else addPath(dynix, f.pts, closed);
    }
  }

  /* ------------------------------------------------------------------ */
  /* geometry helpers                                                    */
  /* ------------------------------------------------------------------ */
  function footOnSeg(px, py, ax, ay, bx, by, clampSeg) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) return [ax, ay, 0];
    let t = ((px - ax) * dx + (py - ay) * dy) / L2;
    if (clampSeg !== false) t = t < 0 ? 0 : t > 1 ? 1 : t;
    return [ax + dx * t, ay + dy * t, t];
  }
  function segInt(ax, ay, bx, by, cx, cy, dx2, dy2) {
    const r1 = bx - ax, r2 = by - ay, s1 = dx2 - cx, s2 = dy2 - cy;
    const den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((cx - ax) * s2 - (cy - ay) * s1) / den;
    const u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return [ax + r1 * t, ay + r2 * t];
  }

  /* ------------------------------------------------------------------ */
  /* the query                                                           */
  /* ------------------------------------------------------------------ */
  function pxPerFt() { return SBMM.map ? Math.pow(2, SBMM.map.getZoom()) : 1; }
  function tolFt(px) { return (px || 10) / Math.max(1e-6, pxPerFt()); }

  /* opts: { from:[x,y]|null  previous vertex, for the perpendicular foot
             tolPx:10, skip:[[x,y],...] points to ignore (the live sketch) }      */
  function query(x, y, opts) {
    if (!enabled) return null;
    opts = opts || {};
    const tol = tolFt(opts.tolPx);
    const from = opts.from || null;
    let best = null;
    const take = (type, qx, qy, extra) => {
      if (!on[type]) return;
      const d = Math.hypot(qx - x, qy - y);
      if (d > tol) return;
      const c = { x: qx, y: qy, type, label: LABEL[type], d, prio: PRIO[type] };
      if (extra) Object.assign(c, extra);
      if (!best || c.prio < best.prio || (c.prio === best.prio && c.d < best.d)) best = c;
    };

    buildStatic();
    const pools = [statix, dynix];
    const segsFound = [];                                  // for pairwise intersections

    for (const ix of pools) {
      for (const id of gatherPts(ix, x, y, tol)) take("end", ix.pts[id], ix.pts[id + 1]);
      for (const id of gather(ix, x, y, tol)) {
        const ax = ix.segs[id], ay = ix.segs[id + 1], bx = ix.segs[id + 2], by = ix.segs[id + 3];
        take("end", ax, ay); take("end", bx, by);
        take("mid", (ax + bx) / 2, (ay + by) / 2);
        const f = footOnSeg(x, y, ax, ay, bx, by);
        take("near", f[0], f[1]);
        if (from && on.perp) {
          const g = footOnSeg(from[0], from[1], ax, ay, bx, by);
          take("perp", g[0], g[1]);
        }
        if (on.int && segsFound.length < 60) segsFound.push([ax, ay, bx, by]);
      }
    }
    /* intersections — only among the handful of segments already near the cursor,
       so this stays a tiny pairwise loop rather than a global sweep */
    if (on.int) {
      for (let i = 0; i < segsFound.length; i++)
        for (let j = i + 1; j < segsFound.length; j++) {
          const a = segsFound[i], b = segsFound[j];
          const p = segInt(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]);
          if (p) take("int", p[0], p[1]);
        }
    }
    if (best) { best.x = +best.x; best.y = +best.y; }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* overlay canvas                                                      */
  /* ------------------------------------------------------------------ */
  let cv = null, ctx = null, cw = 0, ch = 0;
  let needSize = true, painted = false;

  /* getBoundingClientRect forces layout, so it runs on resize events only — never
     on the mousemove path, which would reflow the page on every hover */
  function sizeCanvas() {
    if (!cv) return;
    needSize = false;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === cw && h === ch && cv.width === Math.round(w * dpr)) return;
    cw = w; ch = h;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function toPx(x, y) {
    const p = SBMM.map.latLngToContainerPoint([y, x]);
    return [p.x, p.y];
  }
  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    painted = false;
  }

  /* paint({snap, ray:{from:[x,y], to:[x,y], angle:deg, mode}, note}) */
  function paint(o) {
    if (!cv) return;
    if (needSize) sizeCanvas();
    if (!ctx) return;
    if (!o && !painted) return;                     // already blank — nothing to do
    clear();
    if (!o) return;
    if (o.ray && o.ray.from && o.ray.to) drawRay(o.ray);
    if (o.snap) drawGlyph(o.snap);
    painted = true;
  }

  function drawRay(ray) {
    const a = toPx(ray.from[0], ray.from[1]), b = toPx(ray.to[0], ray.to[1]);
    /* extend the ray well past the cursor so it reads as a direction, not a segment */
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const ex = a[0] + dx / L * (L + 260), ey = a[1] + dy / L * (L + 260);
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = ray.mode === "ortho" ? "rgba(255,211,77,.55)" : "rgba(124,208,230,.55)";
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]);
    if (ray.angle != null) {
      const txt = (ray.mode === "ortho" ? "ORTHO " : "") +
        ray.angle.toFixed(0) + "°" + (ray.dist != null ? "  " + fmt(ray.dist, 1) + " ft" : "");
      chip(txt, b[0] + 16, b[1] - 16, ray.mode === "ortho" ? "#FFD34D" : "#7CD0E6");
    }
    ctx.restore();
  }

  function chip(txt, px, py, color) {
    ctx.save();
    ctx.font = "11px ui-monospace, Consolas, monospace";
    const w = ctx.measureText(txt).width + 12;
    const x = Math.min(px, cw - w - 4), y = Math.max(2, Math.min(py, ch - 22));
    ctx.fillStyle = "rgba(18,24,28,.9)";
    ctx.strokeStyle = "rgba(58,76,88,.9)"; ctx.lineWidth = 1;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, 18, 4); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(x, y, w, 18); ctx.strokeRect(x, y, w, 18); }
    ctx.fillStyle = color || "#E8EEF1";
    ctx.fillText(txt, x + 6, y + 13);
    ctx.restore();
  }

  const GLYPH_COLOR = "#FFD34D";
  function drawGlyph(s) {
    const [px, py] = toPx(s.x, s.y);
    if (!isFinite(px) || !isFinite(py)) return;
    const r = 6.5;
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(10,14,17,.85)";   // halo first, same paths
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) { ctx.lineWidth = 1.6; ctx.strokeStyle = GLYPH_COLOR; }
      ctx.beginPath();
      if (s.type === "end") ctx.rect(px - r, py - r, r * 2, r * 2);
      else if (s.type === "mid") { ctx.moveTo(px, py - r - 1); ctx.lineTo(px + r + 1, py + r); ctx.lineTo(px - r - 1, py + r); ctx.closePath(); }
      else if (s.type === "int") { ctx.moveTo(px - r, py - r); ctx.lineTo(px + r, py + r); ctx.moveTo(px + r, py - r); ctx.lineTo(px - r, py + r); }
      else if (s.type === "perp") { ctx.moveTo(px - r, py - r); ctx.lineTo(px - r, py + r); ctx.lineTo(px + r, py + r); ctx.moveTo(px, py + r); ctx.lineTo(px, py - r + 1); }
      else { ctx.arc(px, py, r, 0, Math.PI * 2); }
      ctx.stroke();
    }
    ctx.restore();
    chip(s.label, px + 12, py + 10, GLYPH_COLOR);
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */
  /* ------------------------------------------------------------------ */
  function syncUI() {
    const b = $("osnapBtn");
    if (b) { b.classList.toggle("on", enabled); b.title = "Object snap " + (enabled ? "ON" : "OFF") + " (F3)"; }
    document.querySelectorAll("#osnapPop input[data-st]").forEach(i => { i.checked = !!on[i.dataset.st]; });
  }
  function setEnabled(v) {
    enabled = v == null ? !enabled : !!v;
    if (!enabled) paint(null);
    syncUI();
    try { localStorage.setItem("sbmm_osnap", JSON.stringify({ enabled, on })); } catch (e) {}
    return enabled;
  }
  function setType(t, v) {
    if (!(t in on)) return;
    on[t] = !!v;
    if (!TYPES.some(k => on[k])) { on[t] = true; toast("at least one snap type stays on"); }
    syncUI();
    try { localStorage.setItem("sbmm_osnap", JSON.stringify({ enabled, on })); } catch (e) {}
  }

  function wire() {
    cv = $("snapCanvas");
    sizeCanvas();
    try {
      const s = JSON.parse(localStorage.getItem("sbmm_osnap") || "null");
      if (s) { enabled = !!s.enabled; for (const t of TYPES) if (s.on && t in s.on) on[t] = !!s.on[t]; }
    } catch (e) {}

    const pop = $("osnapPop");
    pop.innerHTML = `<h4>Object snap</h4>` + TYPES.map(t =>
      `<label class="chk"><input type="checkbox" data-st="${t}"> ${LABEL[t]}</label>`).join("") +
      `<div class="popnote">Snaps to drawn features, DU and pile outlines, survey contours and sample
       points. <kbd>F3</kbd> toggles them all.</div>`;
    pop.querySelectorAll("input[data-st]").forEach(i =>
      i.onchange = () => setType(i.dataset.st, i.checked));

    $("osnapBtn").onclick = e => {
      if (e.shiftKey || e.altKey) { pop.classList.toggle("open"); return; }
      setEnabled(null);
      toast("object snap " + (enabled ? "on" : "off"));
    };
    $("osnapMore").onclick = e => { e.stopPropagation(); pop.classList.toggle("open"); };
    document.addEventListener("click", e => {
      if (!pop.contains(e.target) && e.target !== $("osnapMore") && !$("osnapMore").contains(e.target)) pop.classList.remove("open");
    });

    SBMM.store.onChange(reindexDrawn);
    SBMM.map.on("resize zoomend moveend", () => { needSize = true; });
    window.addEventListener("resize", () => { needSize = true; });
    reindexDrawn();
    syncUI();

    /* build the static index off the boot path — it is ~45k segments */
    const idle = window.requestIdleCallback || (fn => setTimeout(fn, 400));
    idle(() => buildStatic());
  }

  return {
    wire, query, paint, clear, reindexDrawn, buildStatic,
    /* a new dataset adds static snap points; drop the cached index so the next
       query rebuilds it rather than silently missing the new geometry */
    invalidate: () => { statix = null; built = null; },
    sizeCanvas: () => { needSize = true; sizeCanvas(); },
    setEnabled, setType, types: TYPES,
    enabled: () => enabled, active: () => on,
    stats: () => built, tolFt
  };
})();
