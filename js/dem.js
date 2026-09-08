/* SBMM Site Explorer — DEM handling.
   Terrain-RGB style PNGs: value = R*256+G, z = zmin + (v-1)*step, v==0 => NoData.
   PNG row 0 is north; internal array is south-up (row 0 = y0). All coords are
   NAD83(2011) CA State Plane Zone 2, US survey feet (EPSG:6418). */
"use strict";

class Dem {
  constructor(meta, data) { this.m = meta; this.z = data; }

  /* ---- pixel source -------------------------------------------------------
     Two ways to turn a base64 data-URL into pixels, and they are not close:

       new Image() + await img.decode()   site DEM: 1168 ms
       atob -> Blob -> createImageBitmap  site DEM:  ~290 ms

     `img.decode()` on a `data:` URL re-parses the base64 through the resource
     loader; createImageBitmap gets the bytes handed to it and decodes them off
     the main thread. Measured on the 4850x4450 site DEM this was the single
     largest item in the whole boot (see test/perf.mjs). Both paths are kept —
     createImageBitmap is universal in every browser this app targets, but the
     fallback costs six lines and boot is the one thing that must never fail. */
  static async context(url, meta) {
    if (typeof createImageBitmap === "function") {
      try {
        const bin = atob(url.slice(url.indexOf(",") + 1));
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([buf], { type: "image/png" }));
        const oc = typeof OffscreenCanvas === "function"
          ? new OffscreenCanvas(meta.w, meta.h)
          : Object.assign(document.createElement("canvas"), { width: meta.w, height: meta.h });
        const g = oc.getContext("2d", { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        return g;
      } catch (e) { console.warn("DEM fast decode failed, falling back to <img>", e); }
    }
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = meta.w; c.height = meta.h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return g;
  }

  /* meta from SBMM_DATA[name], pixels from base64 data-URL image (never taints canvas).

     Since v11 this is the FALLBACK path: boot decodes the four terrain payloads
     through Dem.loadAll -> Dem.decodeInWorker (below), and lands here only when
     a browser has no Worker / OffscreenCanvas / createImageBitmap, or a worker
     failed. It is kept byte-for-byte equivalent to the worker's loop on purpose
     — the e2e decodes a payload both ways and compares the arrays.

     opts.release  false keeps the base64 string; by default it is nulled once the
                   Float32Array exists — the terrain payloads are ~31 MB of
                   string nothing reads twice.

     All four terrain payloads decode inside the loader, the CHM included.
     Deferring the CHM until after the loader cleared was tried and reverted: it
     bought ~0.55 s of time-to-interactive and spent it on a ~0.6 s main-thread
     block landing one to three seconds later, on top of whatever the user had
     already started doing. Banding the getImageData and the drawImage did not
     fix it — most of the block is inside createImageBitmap decoding an
     11.1-megapixel PNG, which is not divisible on the main thread. Moving the
     whole decode into a worker is what finally fixed it (v11); the CHM stays in
     the loader because it now costs the boot nothing to keep it there. */
  static async load(name, opts) {
    opts = opts || {};
    const meta = SBMM_DATA[name];
    const url = SBMM_DATA[name + "_png"];
    if (!meta) throw new Error(`DEM payload missing: ${name}`);
    if (!url) throw new Error(`DEM image payload missing or already released: ${name}_png`);
    const g = await Dem.context(url, meta);
    const px = g.getImageData(0, 0, meta.w, meta.h).data;
    const z = new Float32Array(meta.w * meta.h);
    for (let r = 0; r < meta.h; r++) {
      const srcRow = r, dstRow = meta.h - 1 - r;
      for (let cx = 0; cx < meta.w; cx++) {
        const i = (srcRow * meta.w + cx) * 4, v = px[i] * 256 + px[i + 1];
        z[dstRow * meta.w + cx] = v === 0 ? NaN : meta.zmin + (v - 1) * meta.step;
      }
    }
    if (opts.release !== false) SBMM_DATA[name + "_png"] = null;
    return new Dem(meta, z);
  }

  inside(x, y) {
    const m = this.m;
    return x >= m.x0 && y >= m.y0 && x <= m.x0 + (m.w - 1) * m.cell && y <= m.y0 + (m.h - 1) * m.cell;
  }
  bounds() { // [[y0,x0],[y1,x1]] Leaflet order
    const m = this.m;
    return [[m.y0, m.x0], [m.y0 + m.h * m.cell, m.x0 + m.w * m.cell]];
  }
  atGrid(i, j) { return this.z[j * this.m.w + i]; }

  at(x, y) { // bilinear
    const m = this.m, fx = (x - m.x0) / m.cell, fy = (y - m.y0) / m.cell;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= m.w - 1 || j >= m.h - 1) return NaN;
    const a = this.z[j * m.w + i], b = this.z[j * m.w + i + 1],
          c = this.z[(j + 1) * m.w + i], d = this.z[(j + 1) * m.w + i + 1];
    if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) {
      const n = [a, b, c, d].filter(v => !isNaN(v));
      return n.length ? n[0] : NaN;
    }
    const u = fx - i, v = fy - j;
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }

  /* slope (deg) and aspect (deg, 0=N cw) at grid node via central differences */
  slopeAspect(i, j) {
    const m = this.m, w = m.w;
    const zc = this.z[j * w + i];
    if (isNaN(zc)) return [NaN, NaN];
    const zl = this.z[j * w + Math.max(0, i - 1)], zr = this.z[j * w + Math.min(w - 1, i + 1)];
    const zd = this.z[Math.max(0, j - 1) * w + i], zu = this.z[Math.min(m.h - 1, j + 1) * w + i];
    const dzdx = ((isNaN(zr) ? zc : zr) - (isNaN(zl) ? zc : zl)) / (2 * m.cell);
    const dzdy = ((isNaN(zu) ? zc : zu) - (isNaN(zd) ? zc : zd)) / (2 * m.cell);
    const slope = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
    let aspect = Math.atan2(dzdx, dzdy) * 180 / Math.PI; // 0 = +Y = north (grid north)
    if (aspect < 0) aspect += 360;
    return [slope, aspect];
  }

  zRange() {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < this.z.length; k++) { const v = this.z[k]; if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    return [lo, hi];
  }
}

/* ---- worker-side decode (v11) -------------------------------------------
   The four terrain payloads used to decode one after another ON THE MAIN
   THREAD: createImageBitmap is off-thread, but `drawImage + getImageData`
   copies 86 MB for the site DEM alone and the terrain-RGB -> Float32 loop is
   21.6 M iterations, and all of that ran between "decoding terrain…" and the
   first frame the user could touch. That was the "building workbench" wait.

   Now each payload decodes in its own dedicated worker and only `atob` stays
   on the main thread (~40 ms per payload; the bytes are then TRANSFERRED, so
   nothing is copied). The four are started together, so on a multi-core box
   they overlap; on a single core they cost what they always did but off the
   thread that paints.

   The worker source is `demDecodeWorkerMain.toString()` wrapped in a Blob URL
   — the same technique js/jobs.js uses for the compute pool, and the only one
   that works in BOTH shipping shapes of this app: over file:// nothing can be
   fetched, and in the dist tools/build_dist.py inlines this file verbatim so
   the function's source text is byte-identical. This is NOT the compute pool:
   no job protocol, no js/compute.js, one message each way.

   Everything is feature-detected and every failure falls back to the old
   main-thread path (Dem.load below) with the payload string still in place,
   because the release only happens once a Float32Array exists. The two paths
   run the SAME terrain-RGB loop — it was moved, not rewritten — and the e2e
   decodes a payload both ways and compares the arrays element by element. */
/* ---- the tile MESH, built once and used on both threads (v22 §G) --------
   Until v22 js/terrain3d.js built a tile's positions, uvs, normals, index and
   skirt on the MAIN THREAD when the camera settled. Measured on the build box
   that is ~9 ms a tile and ~140 ms for a 24-tile set — small enough to be
   invisible in wall time and large enough to matter, because js/touch.js's
   recogniser classifies a gesture by WALL CLOCK and anything that lands
   between a pointerdown and a pointerup changes what the gesture was.

   So the loop lives here, as ONE function, and the SAME SOURCE runs in both
   places: Dem.workerSource() stringifies this function into the Blob worker
   beside demDecodeWorkerMain, and Dem.tileMesh is this same function called
   inline when there is no worker. There is no second implementation to drift
   — which is the one thing the DEM decode path (two loops kept deliberately
   equal, and an e2e comparing them element by element) has to pay for.

   It is DOM-free, SBMM-free and THREE-free by construction: it takes numbers
   and typed arrays and hands typed arrays back, and js/terrain3d.js wraps them
   in a BufferGeometry. Keep `</scr` + `ipt` out of it — tools/build_dist.py's
   js_safe would mangle the source text this is generated from.

   d = { z32, N, V, step, cell, x0, y0, zmid, drop }
        z32   the tile's Float32 heights, row 0 = SOUTH, N x N
        V     vertices per side (N / step + 1) — the extra row and column sit
              ON the tile edge and repeat the last sample (terrain3d trap 1)
        x0/y0 the tile's south-west corner in SCENE coordinates (already
              centred: State Plane feet minus CX / CY)
        zmid  the scene's elevation datum
        drop  how far the skirt hangs below the border ring
   -> { pos, uv, nrm, idx, ni, verts, side, zlo, zhi } or null for an empty tile */
function demTileMeshMain(d) {
  var z32 = d.z32, N = d.N, V = d.V, step = d.step, cell = d.cell;
  var x0 = d.x0, y0 = d.y0, zmid = d.zmid, drop = d.drop;
  var i, j, k, e;
  var zAt = function (ii, jj) {
    var a = jj * step, b = ii * step;
    if (a > N - 1) a = N - 1;
    if (b > N - 1) b = N - 1;
    return z32[a * N + b];
  };
  var nv = V * V;
  var pos = new Float32Array((nv + 4 * V) * 3);
  var uv = new Float32Array((nv + 4 * V) * 2);
  var lo = Infinity, hi = -Infinity, good = 0;
  for (j = 0; j < V; j++) {
    for (i = 0; i < V; i++) {
      k = j * V + i;
      var zz = zAt(i, j);
      pos[k * 3] = x0 + i * step * cell;
      pos[k * 3 + 1] = y0 + j * step * cell;
      pos[k * 3 + 2] = (isNaN(zz) ? zmid : zz) - zmid;
      uv[k * 2] = i / (V - 1); uv[k * 2 + 1] = j / (V - 1);
      if (!isNaN(zz)) { good++; if (zz < lo) lo = zz; if (zz > hi) hi = zz; }
    }
  }
  if (!good) return null;
  /* THE INDEX IS A TYPED ARRAY, NOT A PUSHED JS ARRAY, and the normals come
     from the height field rather than from traversing the triangles. Both were
     costing ~320 ms per tile before v20 measured them. */
  var maxTri = (V - 1) * (V - 1) * 2 + 4 * (V - 1) * 2;
  var idx = new Uint32Array(maxTri * 3);
  var ni = 0;
  for (j = 0; j < V - 1; j++) {
    for (i = 0; i < V - 1; i++) {
      /* skip any quad touching NoData — the rule the whole-DEM meshes used,
         and the reason the survey limit is an edge rather than a cliff wall */
      if (isNaN(zAt(i, j)) || isNaN(zAt(i + 1, j)) ||
          isNaN(zAt(i, j + 1)) || isNaN(zAt(i + 1, j + 1))) continue;
      var a = j * V + i, b = a + 1, c = a + V, dd = c + 1;
      idx[ni++] = a; idx[ni++] = b; idx[ni++] = dd;
      idx[ni++] = a; idx[ni++] = dd; idx[ni++] = c;
    }
  }
  if (!ni) return null;
  /* the skirt: four strips, each vertex a copy of its border neighbour
     dropped by a few cells */
  var edge = [
    function (t) { return t; },                   // south, j = 0
    function (t) { return (V - 1) * V + t; },     // north
    function (t) { return t * V; },               // west
    function (t) { return t * V + (V - 1); }      // east
  ];
  var s = nv;
  for (e = 0; e < 4; e++) {
    var base = s;
    for (i = 0; i < V; i++) {
      var src = edge[e](i);
      pos[(base + i) * 3] = pos[src * 3];
      pos[(base + i) * 3 + 1] = pos[src * 3 + 1];
      pos[(base + i) * 3 + 2] = pos[src * 3 + 2] - drop;
      uv[(base + i) * 2] = uv[src * 2];
      uv[(base + i) * 2 + 1] = uv[src * 2 + 1];
    }
    for (i = 0; i < V - 1; i++) {
      var ea = edge[e](i), eb = edge[e](i + 1);
      if (isNaN(zAt(ea % V, (ea / V) | 0)) || isNaN(zAt(eb % V, (eb / V) | 0))) continue;
      var ec = base + i, ed = base + i + 1;
      if (e === 0 || e === 3) { idx[ni++] = ea; idx[ni++] = ec; idx[ni++] = ed; idx[ni++] = ea; idx[ni++] = ed; idx[ni++] = eb; }
      else { idx[ni++] = ea; idx[ni++] = ed; idx[ni++] = ec; idx[ni++] = ea; idx[ni++] = eb; idx[ni++] = ed; }
    }
    s += V;
  }
  /* Normals straight off the height field: a heightfield vertex's normal is
     (-dz/dx, -dz/dy, 1) normalised, by central differences over the same
     samples the positions came from. The z scale is applied to the OBJECT and
     three transforms normals by the normal matrix, so these are computed
     unscaled exactly as computeVertexNormals did. */
  var nrm = new Float32Array((nv + 4 * V) * 3);
  var sx = step * cell;
  for (j = 0; j < V; j++) {
    for (i = 0; i < V; i++) {
      k = j * V + i;
      var zc = zAt(i, j);
      if (isNaN(zc)) { nrm[k * 3 + 2] = 1; continue; }
      var zl = zAt(i - 1 < 0 ? 0 : i - 1, j), zr = zAt(i + 1 > V - 1 ? V - 1 : i + 1, j);
      var zd = zAt(i, j - 1 < 0 ? 0 : j - 1), zu = zAt(i, j + 1 > V - 1 ? V - 1 : j + 1);
      if (isNaN(zl)) zl = zc; if (isNaN(zr)) zr = zc;
      if (isNaN(zd)) zd = zc; if (isNaN(zu)) zu = zc;
      var gx = (zr - zl) / (2 * sx), gy = (zu - zd) / (2 * sx);
      var inv = 1 / Math.hypot(gx, gy, 1);
      nrm[k * 3] = -gx * inv; nrm[k * 3 + 1] = -gy * inv; nrm[k * 3 + 2] = inv;
    }
  }
  /* the skirt copies its border neighbour's normal — a curtain lit differently
     from the edge it hangs off is a visible seam */
  for (e = 0, s = nv; e < 4; e++, s += V) {
    for (i = 0; i < V; i++) {
      var ns = edge[e](i), nd = s + i;
      nrm[nd * 3] = nrm[ns * 3];
      nrm[nd * 3 + 1] = nrm[ns * 3 + 1];
      nrm[nd * 3 + 2] = nrm[ns * 3 + 2];
    }
  }
  return { pos: pos, uv: uv, nrm: nrm, idx: idx, ni: ni, verts: nv, side: V, zlo: lo, zhi: hi };
}

function demDecodeWorkerMain() {
  self.onmessage = function (ev) {
    var d = ev.data, id = d.id;
    /* v22 §G — the SECOND kind of message this worker answers: build a tile's
       geometry and transfer the buffers back. `op` is absent on every decode
       message this worker has ever been sent, so the payload path below is
       byte-for-byte what it was. */
    if (d.op === "mesh") {
      var m = demTileMeshMain(d);
      if (!m) { self.postMessage({ id: id, empty: true }); return; }
      self.postMessage({ id: id, mesh: m },
        [m.pos.buffer, m.uv.buffer, m.nrm.buffer, m.idx.buffer]);
      return;
    }
    /* feature-detect INSIDE the worker: a browser can have Worker and still
       lack OffscreenCanvas, and the host cannot see the worker's globals */
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      self.postMessage({ id: id, unsupported: true });
      return;
    }
    createImageBitmap(new Blob([d.bytes], { type: "image/png" })).then(function (bmp) {
      var oc = new OffscreenCanvas(d.w, d.h);
      var g = oc.getContext("2d", { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      var px = g.getImageData(0, 0, d.w, d.h).data;
      var z = new Float32Array(d.w * d.h), nodata = 0;
      for (var r = 0; r < d.h; r++) {
        var srcRow = r, dstRow = d.h - 1 - r;
        for (var cx = 0; cx < d.w; cx++) {
          var i = (srcRow * d.w + cx) * 4, v = px[i] * 256 + px[i + 1];
          if (v === 0) nodata++;
          z[dstRow * d.w + cx] = v === 0 ? NaN : d.zmin + (v - 1) * d.step;
        }
      }
      self.postMessage({ id: id, z: z, nodata: nodata }, [z.buffer]);
    }).catch(function (e) {
      self.postMessage({ id: id, error: (e && e.message) || String(e) });
    });
  };
}

Dem._workerUrl = null;
/* how many payloads actually decoded in a worker this boot — 4 on a healthy
   browser, 0 where the fallback took over. The e2e asserts it. */
SBMM.perf.demWorkers = 0;
/* The worker carries BOTH functions: demTileMeshMain as a top-level
   declaration (v22 §G — one implementation, two threads) and the message pump
   that calls it. Neither may contain the closing script tag; test/check.mjs
   scans both. */
Dem.workerSource = function () {
  return "/* SBMM DEM decode worker — generated at runtime from js/dem.js */\n" +
    '"use strict";\n' + demTileMeshMain.toString() + "\n(" +
    demDecodeWorkerMain.toString() + ")();\n";
};
Dem.workerUrl = function () {
  if (!Dem._workerUrl) Dem._workerUrl = URL.createObjectURL(new Blob([Dem.workerSource()], { type: "text/javascript" }));
  return Dem._workerUrl;
};

/* base64 data-URL -> bytes. The one part of the decode that has to stay on the
   main thread (the string lives here), and the cheapest part of it. */
Dem.bytes = function (url) {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
};

/* Decode one payload in its own worker. Resolves to { z, nodata } or to null,
   which means "use the main-thread path" — no Worker, no OffscreenCanvas, a
   thrown constructor, an error inside, or a timeout. It never rejects: a boot
   must not fail because a worker did. */
Dem.decodeInWorker = function (name, meta, url) {
  return new Promise(resolve => {
    if (typeof Worker !== "function" || typeof URL === "undefined" || !URL.createObjectURL)
      return resolve(null);
    let w = null, settled = false;
    const finish = v => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (w) { try { w.terminate(); } catch (e) {} }
      resolve(v);
    };
    const timer = setTimeout(() => {
      console.warn("DEM decode worker timed out, decoding on the main thread:", name);
      finish(null);
    }, 120000);
    try { w = new Worker(Dem.workerUrl()); }
    catch (e) { console.warn("DEM decode workers unavailable, decoding on the main thread:", e.message); return finish(null); }
    w.onmessage = ev => {
      const d = ev.data || {};
      /* nodata is counted for whoever wants it (the e2e compares it against the
         main-thread path); nothing in the app hangs it on the Dem, so the two
         paths produce identical objects. */
      if (d.z) return finish({ z: d.z, nodata: d.nodata });
      if (d.error) console.warn("DEM decode worker failed on " + name + ":", d.error);
      finish(null);
    };
    w.onerror = e => {
      console.warn("DEM decode worker error on " + name + ":", (e && e.message) || e);
      finish(null);
    };
    let bytes;
    try { bytes = Dem.bytes(url); }
    catch (e) { console.warn("DEM payload could not be decoded:", name, e.message); return finish(null); }
    try { w.postMessage({ id: name, bytes, w: meta.w, h: meta.h, zmin: meta.zmin, step: meta.step }, [bytes.buffer]); }
    catch (e) { console.warn("DEM payload could not be transferred:", name, e.message); finish(null); }
  });
};

/* ---- the tile decode pool (v20 §2) --------------------------------------
   A tile pyramid asks for hundreds of small PNGs, so the per-payload path above
   — one worker per decode, created and terminated — is the wrong shape: the
   worker construction alone costs more than a 256 x 256 decode. This is the
   SAME worker source (demDecodeWorkerMain, the same terrain-RGB loop, so a
   tile and a payload cannot disagree about what a pixel means), held open in a
   small pool and multiplexed by request id.

   It never rejects, for the same reason the payload path never rejects: a
   browser without Worker / OffscreenCanvas decodes on the main thread through
   Dem.context, and a hole in the survey is not a failure. */
Dem._pool = null;
Dem._poolSeq = 0;
Dem._poolWaiting = new Map();
Dem.poolSize = function () {
  const n = (navigator && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, n - 1));
};
Dem.tilePool = function () {
  if (Dem._pool) return Dem._pool;
  if (typeof Worker !== "function" || typeof URL === "undefined" || !URL.createObjectURL) {
    Dem._pool = [];
    return Dem._pool;
  }
  const list = [];
  for (let i = 0; i < Dem.poolSize(); i++) {
    let w;
    try { w = new Worker(Dem.workerUrl()); }
    catch (e) { break; }
    /* the whole reply is handed over, not just `z`: since v22 this pool answers
       two kinds of message (a decode and a mesh build) and each caller picks
       what it asked for */
    w.onmessage = ev => {
      const d = ev.data || {}, f = Dem._poolWaiting.get(d.id);
      if (!f) return;
      Dem._poolWaiting.delete(d.id);
      f(d);
    };
    w.onerror = () => { /* the request times out into the main-thread path */ };
    list.push(w);
  }
  Dem._pool = list;
  return list;
};
/* One request to the pool, multiplexed by id. Resolves to the worker's reply,
   or to null on a timeout / a failed transfer — it never rejects, because both
   callers have a main-thread path. */
Dem._poolSend = function (msg, transfer) {
  const pool = Dem.tilePool();
  if (!pool.length) return Promise.resolve(null);
  const id = "t" + (++Dem._poolSeq);
  const wk = pool[Dem._poolSeq % pool.length];
  return new Promise(res => {
    const timer = setTimeout(() => { Dem._poolWaiting.delete(id); res(null); }, 30000);
    Dem._poolWaiting.set(id, v => { clearTimeout(timer); res(v); });
    try { wk.postMessage(Object.assign({ id }, msg), transfer || []); }
    catch (e) { clearTimeout(timer); Dem._poolWaiting.delete(id); res(null); }
  });
};

/* v22 §G — a tile's geometry, built in the pool where there is one.

   The tile's Float32Array lives in SBMM.tiles' cache and MUST NOT be
   transferred: transferring detaches it and the cached tile silently becomes a
   zero-length array. A copy costs 256 kB and about a twentieth of a
   millisecond, so the copy is transferred instead.

   Resolves to the same object demTileMeshMain returns, or to null for an empty
   tile. A pool that is absent, times out or throws falls through to the same
   function called inline — the geometry is then identical by construction, not
   by comparison. */
Dem.tileMesh = demTileMeshMain;
/* which path each mesh took — the e2e and test/terrain3d.mjs both assert that
   a healthy browser really built them in the pool rather than inline */
Dem.meshStats = { worker: 0, main: 0 };
Dem.tileMeshAsync = async function (args) {
  const pool = Dem.tilePool();
  if (pool.length) {
    let copy = null;
    try { copy = args.z32.slice(); } catch (e) { copy = null; }
    if (copy) {
      const msg = Object.assign({}, args, { op: "mesh", z32: copy });
      const r = await Dem._poolSend(msg, [copy.buffer]);
      if (r && r.mesh) { Dem.meshStats.worker++; return r.mesh; }
      if (r && r.empty) { Dem.meshStats.worker++; return null; }
      /* anything else — no reply, a throw inside, an old worker — falls through */
    }
  }
  Dem.meshStats.main++;
  return demTileMeshMain(args);
};

/* Decode one terrain-RGB tile to a Float32Array, row 0 = SOUTH (the same way
   round as Dem's own array). `url` is a data: URL exactly as a payload is. */
Dem.decodeTile = async function (url, w, h, zmin, step) {
  const pool = Dem.tilePool();
  if (pool.length) {
    let bytes;
    try { bytes = Dem.bytes(url); } catch (e) { bytes = null; }
    if (bytes) {
      const r = await Dem._poolSend({ bytes, w, h, zmin, step }, [bytes.buffer]);
      if (r && r.z && !r.unsupported) return r.z;
    }
  }
  /* main-thread fallback — byte-for-byte the loop in Dem.load */
  const g = await Dem.context(url, { w, h });
  const px = g.getImageData(0, 0, w, h).data;
  const z = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const dstRow = h - 1 - r;
    for (let cx = 0; cx < w; cx++) {
      const i = (r * w + cx) * 4, v = px[i] * 256 + px[i + 1];
      z[dstRow * w + cx] = v === 0 ? NaN : zmin + (v - 1) * step;
    }
  }
  return z;
};

/* Load several payloads at once, one worker each, all started together.

   opts.optional  names whose absence or failure is a warning, not an error
                  (dem_res and the CHM — see js/boot.js)
   opts.onOne     (name, { done, total, ms, worker }) as each one lands; boot
                  uses it for the per-payload perf mark and the loader text.

   Returns { name: Dem }, missing optional payloads simply absent. Required
   payloads still throw, and the throw still reaches boot.js's error screen. */
Dem.loadAll = async function (names, opts) {
  opts = opts || {};
  const optional = new Set(opts.optional || []);
  const out = {};
  const total = names.length;
  let done = 0;
  const one = async name => {
    const meta = SBMM_DATA[name], url = SBMM_DATA[name + "_png"];
    const t0 = performance.now();
    let dem = null, viaWorker = false;
    if (!meta) throw new Error(`DEM payload missing: ${name}`);
    if (!url) throw new Error(`DEM image payload missing or already released: ${name}_png`);
    const r = await Dem.decodeInWorker(name, meta, url);
    if (r) {
      viaWorker = true;
      SBMM.perf.demWorkers = (SBMM.perf.demWorkers || 0) + 1;
      SBMM_DATA[name + "_png"] = null;     /* released only once the array exists */
      dem = new Dem(meta, r.z);
    } else {
      dem = await Dem.load(name);          /* the main-thread path, unchanged */
    }
    out[name] = dem;
    done++;
    const ms = +(performance.now() - t0).toFixed(1);
    SBMM.perf.demDecode = SBMM.perf.demDecode || {};
    SBMM.perf.demDecode[name] = { ms, worker: viaWorker, mpx: +((meta.w * meta.h) / 1e6).toFixed(1) };
    if (opts.onOne) opts.onOne(name, { done, total, ms, worker: viaWorker });
    return dem;
  };
  /* .map starts every job now: each runs synchronously as far as its atob and
     postMessage, so payload 2 is being read while payload 1 is already
     decoding. Promise.allSettled, not all, so one optional failure cannot take
     a required payload's rejection with it. */
  const settled = await Promise.allSettled(names.map(one));
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") return;
    if (optional.has(names[i])) { console.warn("optional terrain payload skipped:", names[i], s.reason); return; }
    throw s.reason;
  });
  return out;
};

/* ---- the DEM stack ------------------------------------------------------
   ONE ordered list, finest first, and everything that asks "what is the ground
   here" walks it in this order: SBMM.elev, SBMM.slopeAt, the worker grid stack
   in js/jobs.js (which is what the isopach compares against), the volume /
   design / smart-boundary DEM pickers and the 3D meshes.

   Order is `abp, res, site`, not merely fine→coarse: dem_abp and dem_res are
   both 1 ft and they overlap, so the tie is broken explicitly in favour of the
   mine-area window — it is the older, more-exercised grid and every golden
   number in the tests was measured on it.

   dem_res (v9) exists because the residential lots south and west of the mine
   window used to fall back to the 2-ft site grid. Comparing a 1-ft design
   raster against a 2-ft ground grid manufactures volume (CLAUDE.md, ruling F9),
   and every residential excavation quantity was being read off the coarse grid.

   Built by SBMM.setDems() at boot; the getters below keep the old two-DEM
   spelling working for the modules that name a grid directly. */
SBMM.dems = [];
SBMM.setDems = function (list) {
  SBMM.dems = (list || []).filter(Boolean);
  return SBMM.dems;
};
/* the finest DEM in the stack that covers (x, y) and has data there */
SBMM.demAt = function (x, y) {
  for (const d of SBMM.dems) {
    if (!d.inside(x, y)) continue;
    if (!isNaN(d.at(x, y))) return d;
  }
  return null;
};
/* the finest DEM that wholly contains a bbox [x0,y0,x1,y1]; null if none does.
   Used by the volume / design / smart-boundary jobs, which need ONE grid for
   the whole footprint rather than a per-cell answer. */
SBMM.demForBox = function (bbox) {
  for (const d of SBMM.dems) {
    if (d.inside(bbox[0], bbox[1]) && d.inside(bbox[2], bbox[3])) return d;
  }
  return null;
};

SBMM.elev = function (x, y) {
  for (const d of SBMM.dems) {
    if (!d.inside(x, y)) continue;
    const z = d.at(x, y);
    if (!isNaN(z)) return [z, d.m.cell + "-ft DEM"];
  }
  return [NaN, ""];
};

/* Slope and aspect at a State Plane point, on the finest DEM that covers it —
   the same "best available grid" rule SBMM.elev uses, so a coordinate card
   never reports its elevation off the 1-ft grid and its slope off the 2-ft one.
   Returns null where there is no terrain. Slope is given both ways because the
   two audiences differ: percent for the earthwork, degrees for the geotech. */
SBMM.slopeAt = function (x, y) {
  for (const d of SBMM.dems) {
    if (!d.inside(x, y)) continue;
    const m = d.m;
    const i = Math.round((x - m.x0) / m.cell), j = Math.round((y - m.y0) / m.cell);
    if (i < 0 || i >= m.w || j < 0 || j >= m.h) continue;
    const [deg, asp] = d.slopeAspect(i, j);
    if (isNaN(deg)) continue;
    return { slopeDeg: deg, slopePct: Math.tan(deg * Math.PI / 180) * 100,
             aspectDeg: asp, src: m.cell + "-ft DEM" };
  }
  return null;
};

/* canopy height above bare earth (ft) from the lidar CHM — NaN outside it */
SBMM.canopy = function (x, y) {
  const c = SBMM.chm;
  if (!c || !c.inside(x, y)) return NaN;
  const h = c.at(x, y);
  return isNaN(h) ? NaN : h;
};
