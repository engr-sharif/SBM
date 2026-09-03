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

     opts.release  false keeps the base64 string; by default it is nulled once the
                   Float32Array exists — the three terrain payloads are ~28 MB of
                   string nothing reads twice.

     All three terrain payloads decode inside the loader. Deferring the CHM until
     after the loader cleared was tried and reverted: it bought ~0.55 s of
     time-to-interactive and spent it on a ~0.6 s main-thread block landing one to
     three seconds later, on top of whatever the user had already started doing.
     Banding the getImageData and the drawImage did not fix it — most of the block
     is inside createImageBitmap decoding an 11.1-megapixel PNG, which is not
     divisible on the main thread. A longer spinner that names the step it is on
     is not jank; a stall two seconds into a drag is. If this is ever worth
     another go, the answer is decoding it in a worker, which needs the job
     protocol in compute.js to learn about async kernels first. */
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
