/* SBMM Site Explorer — the terrain tile pyramid (v20 §2).

   TWO SOURCES, AND THE RULE IS NOT NEGOTIABLE
   -------------------------------------------
   The three whole-site grids (SBMM.dems, reached through SBMM.elev / demAt /
   demForBox) are the ANALYSIS source: every kernel, every golden, every
   quantity someone digs from is measured on them and they are untouched by
   this file. The pyramid built here is the DISPLAY and 3D source. The two
   must agree, and they do by construction: a tile pixel lands exactly on a
   source grid node at every level (tools/build_tiles.py documents the
   arithmetic), so a tile is a decimation of the grid and never a resample of
   it. test/tiles.mjs samples 1,000 surveyed points and requires equality to
   the terrain-RGB step.

   THREE WAYS A TILE ARRIVES, IN THIS ORDER
   ----------------------------------------
     1. already in `window.SBMM_TILES` — inlined by the build, or injected by
        an earlier get(). Resolves without I/O.
     2. `<script src="datajs/tiles/<layer>_<z>_<x>_<y>.js">` injected into the
        head. This is the ONE technique that works over file://, over http and
        inside the offline copy; there is no fetch() in this app and there will
        not be one (CLAUDE.md, hard constraint 1). The folder build takes this
        path.
     3. SYNTHESIS from the resident whole rasters. The single-file builds do
        not inline the tile payloads — measured, they would take the full dist
        from 133 MB to ~206 MB for information it already carries — so in a
        dist `get()` cuts the tile out of the grids and the imagery that are
        already in memory. For a DEM tile that is bit-identical to the payload
        (both are the same grid nodes through the same terrain-RGB step); for
        imagery it is the same box filter the builder runs. The field build,
        which ships no tiles either, works for the same reason.

   The index (`datajs/tiles/index.js`, `SBMM_TILES.index`) is small and always
   loaded: it says which levels exist, which tiles exist at each, and how many
   bytes each one costs. A tile that is not in the index is never requested,
   which is how the NoData holes cost nothing.

   BUDGET
   ------
   An LRU over decoded tiles with a byte budget (256 MB desktop, 96 MB under
   body.touch), evicted by distance from the focus point the renderer sets. The
   request queue is priority-ordered (screen coverage, set by the caller) and
   cancellable on a view change: a queued request that is dropped rejects with
   {cancelled:true}, which every caller treats as "not an error". */
"use strict";

SBMM.tiles = (function () {

  const TILE = 256;
  const store = () => (window.SBMM_TILES || (window.SBMM_TILES = {}));

  let IDX = null, missing = false;
  /* decoded tiles: key -> { key, layer, z, x, y, bytes, z32?, img?, tex?, used } */
  const cache = new Map();
  let cacheBytes = 0, useClock = 0;
  let focus = { x: 0, y: 0 };
  /* in-flight and queued requests */
  const inflight = new Map();          // key -> {promise, resolve, reject}
  let queue = [];                      // [{key, prio, run}]
  let running = 0;
  let MAX_PARALLEL = 4;
  const stat = { hits: 0, injected: 0, synth: 0, evicted: 0, failed: 0, cancelled: 0,
                 decodeMs: 0, requests: 0 };

  /* The cache budget by profile. A phone is not a small tablet — v19.1's
     SBMM.lowMem() is the one answer to that question and this asks it rather
     than inventing a second test.

     The DRAPE side needs no budget of its own: a tile texture is 256 x 256,
     an order below js/viewer3d.js's texBudget() phone cap of 2,048 px, so the
     quadtree cannot breach it however many tiles are drawn — and a phone at
     the standard quality draws ~9 of them, about a megabyte of texture where
     the whole-DEM drape was a single 2,048-square one. */
  function budgetBytes() {
    if (SBMM.tiles._budget) return SBMM.tiles._budget;
    if (SBMM.lowMem && SBMM.lowMem()) return 48e6;
    return document.body.classList.contains("touch") ? 96e6 : 256e6;
  }

  /* ---------------------------------------------------------------- index */
  function index() {
    if (IDX || missing) return IDX;
    const s = store();
    if (s && s.index) IDX = s.index;
    else missing = true;
    return IDX;
  }
  function ready() { return !!index(); }
  function layerInfo(layer) {
    const ix = index();
    return ix && ix.layers ? ix.layers[layer] || null : null;
  }
  /* levels present for a layer, coarsest first */
  function levels(layer) {
    const L = layerInfo(layer);
    if (!L) return [];
    return Object.keys(L.levels).map(Number).sort((a, b) => b - a);
  }
  function levelInfo(layer, z) {
    const L = layerInfo(layer);
    return L && L.levels[String(z)] ? L.levels[String(z)] : null;
  }
  /* the set of tile keys at one level, built once and memoised on the record */
  function levelSet(layer, z) {
    const li = levelInfo(layer, z);
    if (!li) return null;
    if (!li._set) {
      const m = new Map();
      for (const t of li.tiles) m.set(t[0] + "," + t[1], t[2]);
      li._set = m;
    }
    return li._set;
  }
  function has(layer, z, x, y) {
    const s = levelSet(layer, z);
    return !!(s && s.has(x + "," + y));
  }
  function tileBytes(layer, z, x, y) {
    const s = levelSet(layer, z);
    const v = s && s.get(x + "," + y);
    return v || 65536;
  }
  const cellOf = z => Math.pow(2, z);
  function origin() {
    const ix = index();
    return ix ? ix.origin : { x0: 6368100, y0: 2122800 };
  }
  /* the world rectangle a tile covers: [x0, y0, x1, y1] in State Plane feet */
  function rect(z, x, y) {
    const o = origin(), span = TILE * cellOf(z);
    return [o.x0 + x * span, o.y0 + y * span, o.x0 + (x + 1) * span, o.y0 + (y + 1) * span];
  }
  /* the tile index containing a point at a level */
  function tileAt(z, x, y) {
    const o = origin(), span = TILE * cellOf(z);
    return [Math.floor((x - o.x0) / span), Math.floor((y - o.y0) / span)];
  }

  /* ------------------------------------------------------- the payload URL */
  const keyOf = (layer, z, x, y) => layer + "/" + z + "/" + x + "/" + y;
  const fileOf = (layer, z, x, y) => "datajs/tiles/" + layer + "_" + z + "_" + x + "_" + y + ".js";

  /* Inject a payload script. Over file:// nothing can be fetched, and a
     <script src> is the only thing that loads — the same reason every payload
     in this app is a script rather than JSON. Never called in a single-file
     build (there is no datajs/ beside it) — synthesis answers there. */
  function inject(layer, z, x, y) {
    const key = keyOf(layer, z, x, y);
    return new Promise((res, rej) => {
      if (window.SBMM_SINGLE_FILE) return rej(new Error("single-file build"));
      const s = document.createElement("script");
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(t);
        s.remove();
        if (ok && store()[key]) { stat.injected++; res(store()[key]); }
        else rej(new Error("tile payload did not load: " + key));
      };
      const t = setTimeout(() => finish(false), 20000);
      s.onload = () => finish(true);
      s.onerror = () => finish(false);
      s.src = fileOf(layer, z, x, y);
      document.head.appendChild(s);
    });
  }

  /* ------------------------------------------------------------ synthesis */
  /* The resident grids, in the order tools/build_tiles.py used: at 1 ft only
     the two 1-ft windows; at 2 ft and coarser the whole stack, finest first.
     That is SBMM.dems' own order, so a synthesised tile answers exactly what
     SBMM.elev answers. */
  function demSources(z) {
    const fine = [SBMM.demAbp, SBMM.demRes].filter(Boolean);
    if (z <= 0) return fine;
    return (SBMM.dems && SBMM.dems.length) ? SBMM.dems.slice() : fine.concat([SBMM.demSite]).filter(Boolean);
  }
  /* nearest NODE, never an interpolation — a tile is a decimation of the grid */
  function nodeAt(dem, X, Y) {
    const m = dem.m;
    const i = Math.round((X - m.x0) / m.cell), j = Math.round((Y - m.y0) / m.cell);
    if (i < 0 || j < 0 || i >= m.w || j >= m.h) return NaN;
    return dem.z[j * m.w + i];
  }
  /* Float32, row 0 = SOUTH (y0), the same way round as Dem's own array. */
  function synthDem(z, x, y) {
    const o = origin(), c = cellOf(z), srcs = demSources(z);
    const out = new Float32Array(TILE * TILE);
    let any = false;
    for (let j = 0; j < TILE; j++) {
      const Y = o.y0 + (y * TILE + j) * c;
      for (let i = 0; i < TILE; i++) {
        const X = o.x0 + (x * TILE + i) * c;
        let v = NaN;
        for (const d of srcs) { const t = nodeAt(d, X, Y); if (!isNaN(t)) { v = t; break; } }
        if (!isNaN(v)) any = true;
        out[j * TILE + i] = v;
      }
    }
    return any ? out : null;
  }
  function synthChm(z, x, y) {
    const c = SBMM.chm;
    if (!c) return null;
    const o = origin(), cs = cellOf(z);
    const out = new Float32Array(TILE * TILE);
    let any = false;
    for (let j = 0; j < TILE; j++) {
      const Y = o.y0 + (y * TILE + j) * cs;
      for (let i = 0; i < TILE; i++) {
        const X = o.x0 + (x * TILE + i) * cs;
        const v = nodeAt(c, X, Y);
        if (!isNaN(v)) any = true;
        out[j * TILE + i] = v;
      }
    }
    return any ? out : null;
  }

  /* imagery: the whole rasters this build carries, coarsest first so the
     finest paints last — tools/build_tiles.py's own order */
  const imgCache = new Map();
  function loadImg(url) {
    if (imgCache.has(url)) return imgCache.get(url);
    const p = new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej; im.src = url;
    });
    imgCache.set(url, p);
    return p;
  }
  function imgSources(layer) {
    const D = window.SBMM_DATA || {};
    const out = [];
    const push = (url, b) => { if (url && b) out.push({ url, b }); };
    if (layer === "ortho") {
      if (D.ortho_site && D.ortho_site.x0) push(D.ortho_site_jpg, D.ortho_site);
      if (D.ortho_mine && D.ortho_mine.x0) push(D.ortho_mine_jpg, D.ortho_mine);
      if (D.ortho_abp && D.ortho_abp.x0) push(D.ortho_abp_jpg, D.ortho_abp);
    } else if (layer === "hillshade") {
      const bs = d => d && ({ x0: d.m.x0, y0: d.m.y0, x1: d.m.x0 + d.m.w * d.m.cell, y1: d.m.y0 + d.m.h * d.m.cell });
      push(D.hs_site_jpg || D.hs_site_png, bs(SBMM.demSite));
      push(D.hs_abp_jpg || D.hs_abp_png, bs(SBMM.demAbp));
    } else if (layer === "cover") {
      const g = D.cover && D.cover.grid;
      if (g) push(D.cover_png, { x0: g.x0, y0: g.y0, x1: g.x0 + g.w * g.cell, y1: g.y0 + g.h * g.cell });
    }
    return out;
  }
  async function synthImage(layer, z, x, y) {
    const srcs = imgSources(layer);
    if (!srcs.length) return null;
    const r = rect(z, x, y);
    const cv = document.createElement("canvas");
    cv.width = TILE; cv.height = TILE;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = layer !== "cover";   // the cover palette IS the legend
    let any = false;
    for (const s of srcs) {
      if (s.b.x1 <= r[0] || s.b.x0 >= r[2] || s.b.y1 <= r[1] || s.b.y0 >= r[3]) continue;
      let im;
      try { im = await loadImg(s.url); } catch (e) { continue; }
      const sx = (r[0] - s.b.x0) / (s.b.x1 - s.b.x0) * im.width;
      const sw = (r[2] - r[0]) / (s.b.x1 - s.b.x0) * im.width;
      /* canvas row 0 is the tile's NORTH edge, image row 0 is the raster's */
      const sy = (s.b.y1 - r[3]) / (s.b.y1 - s.b.y0) * im.height;
      const sh = (r[3] - r[1]) / (s.b.y1 - s.b.y0) * im.height;
      try { g.drawImage(im, sx, sy, sw, sh, 0, 0, TILE, TILE); any = true; }
      catch (e) { /* a source that does not overlap after rounding */ }
    }
    return any ? cv : null;
  }

  /* ------------------------------------------------------------- decoding */
  const isTerrain = layer => layer === "dem" || layer === "chm";

  async function decode(layer, z, x, y, url) {
    const L = layerInfo(layer) || {};
    if (isTerrain(layer)) {
      const zmin = L.zmin != null ? L.zmin : 1325, step = L.step != null ? L.step : 0.02;
      const arr = await Dem.decodeTile(url, TILE, TILE, zmin, step);
      return { z32: arr, bytes: TILE * TILE * 4 };
    }
    const im = await loadImg(url);
    return { img: im, bytes: TILE * TILE * 4 };
  }

  /* ------------------------------------------------------------ the queue */
  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      queue.sort((a, b) => b.prio - a.prio);
      const j = queue.shift();
      running++;
      j.run().then(() => { running--; pump(); }, () => { running--; pump(); });
    }
  }

  /* Fetch and decode one tile. Resolves to the cache record, or null when the
     tile genuinely has no data (never an exception for that — a hole in the
     survey is not a failure). Rejects with {cancelled:true} when the view
     moved on. */
  function get(layer, z, x, y, opts) {
    opts = opts || {};
    const key = keyOf(layer, z, x, y);
    const hit = cache.get(key);
    if (hit) { hit.used = ++useClock; stat.hits++; return Promise.resolve(hit); }
    if (inflight.has(key)) return inflight.get(key).promise;

    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    const rec = { promise, resolve, reject, cancelled: false, prio: opts.priority || 0 };
    inflight.set(key, rec);
    stat.requests++;

    const run = async () => {
      if (rec.cancelled) { stat.cancelled++; inflight.delete(key); reject({ cancelled: true }); return; }
      const t0 = performance.now();
      try {
        let url = store()[key];
        if (!url && has(layer, z, x, y) && !window.SBMM_SINGLE_FILE) {
          try { url = await inject(layer, z, x, y); } catch (e) { url = null; }
        }
        let out = null;
        if (url) out = await decode(layer, z, x, y, url);
        else {
          /* synthesis — always available, because the whole rasters are */
          stat.synth++;
          if (layer === "dem") { const a = synthDem(z, x, y); out = a ? { z32: a, bytes: a.byteLength } : null; }
          else if (layer === "chm") { const a = synthChm(z, x, y); out = a ? { z32: a, bytes: a.byteLength } : null; }
          else { const cv = await synthImage(layer, z, x, y); out = cv ? { img: cv, bytes: TILE * TILE * 4 } : null; }
        }
        stat.decodeMs += performance.now() - t0;
        if (!out) { inflight.delete(key); resolve(null); return; }
        const r = Object.assign({ key, layer, z, x, y, used: ++useClock }, out);
        cache.set(key, r);
        cacheBytes += r.bytes;
        trim();
        inflight.delete(key);
        resolve(r);
      } catch (e) {
        stat.failed++;
        inflight.delete(key);
        resolve(null);          // a tile that will not decode is a hole, not a crash
      }
    };
    rec.run = run;
    queue.push({ key, prio: rec.prio, run, rec });
    pump();
    return promise;
  }

  /* Drop everything still queued (not the ones already running) — what a view
     change does. Callers see {cancelled:true} and treat it as "not an error". */
  function cancelQueued() {
    for (const j of queue) { j.rec.cancelled = true; }
    const q = queue; queue = [];
    for (const j of q) {
      inflight.delete(j.key);
      stat.cancelled++;
      j.rec.reject({ cancelled: true });
    }
  }

  /* ---------------------------------------------------------------- the LRU */
  function setFocus(x, y) { focus.x = x; focus.y = y; }
  /* Eviction is by distance from the focus point first and recency second: a
     tile behind the camera is worth less than an old one under it. */
  function trim() {
    const budget = budgetBytes();
    if (cacheBytes <= budget) return;
    const all = [...cache.values()];
    for (const r of all) {
      const c = cellOf(r.z), o = origin();
      const cx = o.x0 + (r.x + 0.5) * TILE * c, cy = o.y0 + (r.y + 0.5) * TILE * c;
      r._d = Math.hypot(cx - focus.x, cy - focus.y);
    }
    all.sort((a, b) => (b._d - a._d) || (a.used - b.used));
    for (const r of all) {
      if (cacheBytes <= budget * 0.85) break;
      if (r.pinned) continue;
      cache.delete(r.key);
      cacheBytes -= r.bytes;
      stat.evicted++;
      if (r.tex && r.tex.dispose) r.tex.dispose();
      /* the payload string is dropped too — nothing reads it twice */
      if (store()[r.key]) delete store()[r.key];
    }
  }
  function clear() {
    for (const r of cache.values()) if (r.tex && r.tex.dispose) r.tex.dispose();
    cache.clear(); cacheBytes = 0;
  }

  function stats() {
    const byLayer = {};
    for (const r of cache.values()) {
      const b = byLayer[r.layer] || (byLayer[r.layer] = { tiles: 0, bytes: 0 });
      b.tiles++; b.bytes += r.bytes;
    }
    const ix = index();
    return {
      ready: !!ix,
      source: ix ? ix.source : null,
      built: ix ? ix.built : null,
      budget: budgetBytes(), bytes: cacheBytes, tiles: cache.size,
      byLayer, queued: queue.length, running,
      layers: ix ? Object.keys(ix.layers) : [],
      levels: ix ? Object.fromEntries(Object.keys(ix.layers).map(
        k => [k, levels(k).slice().reverse()])) : {},
      counts: ix ? Object.fromEntries(Object.keys(ix.layers).map(
        k => [k, Object.values(ix.layers[k].levels).reduce((n, l) => n + l.count, 0)])) : {},
      payloadBytes: ix ? Object.fromEntries(Object.keys(ix.layers).map(
        k => [k, Object.values(ix.layers[k].levels).reduce((n, l) => n + l.bytes, 0)])) : {},
      singleFile: !!window.SBMM_SINGLE_FILE,
      ...stat
    };
  }

  return {
    TILE, ready, index, layerInfo, levels, levelInfo, has, tileBytes,
    cellOf, origin, rect, tileAt, keyOf, fileOf,
    get, cancelQueued, setFocus, trim, clear, stats,
    /* the harness sets a small budget to prove eviction happens */
    setBudget(b) { SBMM.tiles._budget = b || 0; trim(); },
    peek(layer, z, x, y) { return cache.get(keyOf(layer, z, x, y)) || null; },
    /* synthesis, exposed so test/tiles.mjs can compare the two sources
       directly rather than inferring which one answered */
    _synthDem: synthDem
  };
})();
