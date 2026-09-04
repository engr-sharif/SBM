/* SBMM Site Explorer — the app's terrain, loaded in node.

   test/kernels.mjs runs js/compute.js's kernels directly (no browser, no
   Playwright), which means something has to do in node what js/dem.js and
   js/jobs.js do in the page: decode the terrain-RGB PNGs into the app's exact
   south-up Float32 layout, and cut the windowed grid specs a worker job
   receives. That is all this file is. Everything here is a PORT, and where it
   is a port the original is named — if js/dem.js or js/jobs.js changes, this
   changes with it or the harness is testing a fiction.

   Three things are load-bearing:

     * LAYOUT. `z` is south-up (row 0 = y0) while the PNG is north-up (row 0 =
       north), the value is `v = R*256 + G`, `z = zmin + (v-1)*step`, and
       `v == 0` is NoData -> NaN. Identical to Dem.load().
     * THE STACK. `dems()` is [dem_abp, dem_res, dem_site] — 1-ft mine, 1-ft
       residential, 2-ft site — and the tie between the two 1-ft grids goes to
       dem_abp because every golden number was measured on it (CLAUDE.md).
       gridsFor() ships that same order to a job, which is what compute.js's
       elevOf() relies on.
     * THE CACHE. Decoding the four payloads is ~15 s of the first run and 0 s
       of every run after it, so each decoded grid is written to test/.cache/
       (gitignored) keyed by the PNG's byte size and mtime. Touch the PNG and
       the cache misses; that is the point.

   `loadSurface` reads EA's design rasters out of the SHIPPED payload
   (datajs/d_cad_surfaces.js) rather than data/design/surf_*.png, because the
   payload is what the app actually decodes and the two could in principle
   drift. It is a 11 MB file holding four base64 data-URLs, so the URL for one
   surface is pulled out with a regex rather than by evaluating the file. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG } from "./png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
const CACHE = path.join(REPO, "test", ".cache");

/* ------------------------------------------------------------------ cache -- */
/* Key on the PNG's size + mtime (not a hash: hashing 20 MB costs more than the
   decode saves on a miss, and mtime+size is exactly what a build changes). */
function cacheKey(pngFile, tag) {
  const st = fs.statSync(pngFile);
  return `${tag}-${st.size}-${Math.round(st.mtimeMs)}`;
}
function cacheGet(key, n) {
  const f = path.join(CACHE, key + ".f32");
  try {
    const st = fs.statSync(f);
    if (st.size !== n * 4) return null;
    const b = fs.readFileSync(f);
    return new Float32Array(b.buffer, b.byteOffset, n);
  } catch (e) { return null; }
}
function cachePut(key, z) {
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(path.join(CACHE, key + ".f32"),
      Buffer.from(z.buffer, z.byteOffset, z.byteLength));
  } catch (e) { /* a read-only checkout is slower, not broken */ }
}

/* --------------------------------------------------------- terrain-RGB ----- */
/* The decode loop of js/dem.js Dem.load(), byte for byte: PNG row 0 is north,
   the internal array is south-up, v == 0 is NoData. */
function terrainRGB(px, w, h, channels, zmin, step) {
  const z = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const srcRow = r * w * channels, dstRow = (h - 1 - r) * w;
    for (let cx = 0; cx < w; cx++) {
      const i = srcRow + cx * channels, v = px[i] * 256 + px[i + 1];
      z[dstRow + cx] = v === 0 ? NaN : zmin + (v - 1) * step;
    }
  }
  return z;
}

/* ------------------------------------------------------------------ Dem ---- */
/* The subset of js/dem.js's Dem class the kernels and their call sites use.
   at() is Dem.at() including its "first valid corner" NoData rule. */
class Dem {
  constructor(m, z) { this.m = m; this.z = z; }
  inside(x, y) {
    const m = this.m;
    return x >= m.x0 && y >= m.y0 && x <= m.x0 + (m.w - 1) * m.cell && y <= m.y0 + (m.h - 1) * m.cell;
  }
  atGrid(i, j) { return this.z[j * this.m.w + i]; }
  at(x, y) {
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
  zRange() {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < this.z.length; k++) { const v = this.z[k]; if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    return [lo, hi];
  }
}

const demCache = new Map();
export const loadStats = { decoded: [], cached: [], ms: 0 };

/* loadDem("dem_abp" | "dem_site" | "dem_res" | "chm") -> Dem */
export function loadDem(name) {
  if (demCache.has(name)) return demCache.get(name);
  const t0 = Date.now();
  const meta = JSON.parse(fs.readFileSync(path.join(REPO, "data", name + ".json"), "utf8"));
  const png = path.join(REPO, "data", name + ".png");
  const key = cacheKey(png, name);
  let z = cacheGet(key, meta.w * meta.h);
  if (z) loadStats.cached.push(name);
  else {
    const img = decodePNG(fs.readFileSync(png));
    if (img.w !== meta.w || img.h !== meta.h)
      throw new Error(`${name}.png is ${img.w}x${img.h} but ${name}.json says ${meta.w}x${meta.h}`);
    z = terrainRGB(img.data, img.w, img.h, img.channels, meta.zmin, meta.step);
    cachePut(key, z);
    loadStats.decoded.push(name);
  }
  loadStats.ms += Date.now() - t0;
  const d = new Dem(meta, z);
  demCache.set(name, d);
  return d;
}

/* ------------------------------------------------------------- the stack -- */
/* SBMM.setDems()'s order, and the reason for it, are in CLAUDE.md: the two 1-ft
   windows overlap and dem_abp wins the tie. */
let stack = null;
export function dems() {
  if (!stack) stack = [loadDem("dem_abp"), loadDem("dem_res"), loadDem("dem_site")];
  return stack;
}
export function demAt(x, y) {                       // SBMM.demAt
  for (const d of dems()) { if (!d.inside(x, y)) continue; if (!isNaN(d.at(x, y))) return d; }
  return null;
}
export function demForBox(bbox) {                   // SBMM.demForBox
  for (const d of dems())
    if (d.inside(bbox[0], bbox[1]) && d.inside(bbox[2], bbox[3])) return d;
  return null;
}
export function elev(x, y) {                        // SBMM.elev, value only
  for (const d of dems()) {
    if (!d.inside(x, y)) continue;
    const z = d.at(x, y);
    if (!isNaN(z)) return z;
  }
  return NaN;
}

/* ----------------------------------------------------------- grid specs --- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* Ported VERBATIM from js/jobs.js gridSpec() — full-grid meta plus only the
   sub-rectangle the job can touch, which is what makes gz()/gridAt() in
   js/compute.js keep their exact semantics. */
export function gridSpec(dem, bbox, pad) {
  const m = dem.m;
  let i0 = 0, j0 = 0, i1 = m.w - 1, j1 = m.h - 1;
  if (bbox) {
    const p = pad == null ? 2 : pad;
    i0 = Math.floor((bbox[0] - m.x0) / m.cell) - p;
    j0 = Math.floor((bbox[1] - m.y0) / m.cell) - p;
    i1 = Math.ceil((bbox[2] - m.x0) / m.cell) + p;
    j1 = Math.ceil((bbox[3] - m.y0) / m.cell) + p;
    if (i1 < 0 || j1 < 0 || i0 > m.w - 1 || j0 > m.h - 1) return null;
    i0 = clamp(i0, 0, m.w - 1); j0 = clamp(j0, 0, m.h - 1);
    i1 = clamp(i1, 0, m.w - 1); j1 = clamp(j1, 0, m.h - 1);
  }
  const sw = i1 - i0 + 1, sh = j1 - j0 + 1;
  let z;
  if (sw === m.w && sh === m.h) {
    z = new Float32Array(dem.z);
  } else {
    z = new Float32Array(sw * sh);
    for (let j = 0; j < sh; j++) {
      const src = (j0 + j) * m.w + i0;
      z.set(dem.z.subarray(src, src + sw), j * sw);
    }
  }
  return { x0: m.x0, y0: m.y0, cell: m.cell, w: m.w, h: m.h, i0, j0, sw, sh, z };
}

/* Ported VERBATIM from js/jobs.js gridsFor() — the DEM stack clipped to a bbox,
   finest first, which is the order compute.js's elevOf() depends on. */
export function gridsFor(bbox) {
  const out = [];
  for (const dem of dems()) {
    const g = gridSpec(dem, bbox);
    if (g) out.push(g);
  }
  return out;
}

/* A STANDALONE grid: i0 = j0 = 0 and w/h equal to the window, so the spec is
   its own whole grid. Two kernels — contoursFromGrid and demRasterRGBA — index
   `g.z[j*g.w + i]` and size their output from g.w/g.h rather than going through
   gz()/g.sw, because the app only ever hands them a whole-DEM spec
   (js/analysis.js calls gridSpec(dem) with no bbox). Handing either of them a
   WINDOWED spec silently produces nonsense, so a windowed test case for those
   two has to be built this way instead. */
export function subGrid(dem, bbox) {
  const g = gridSpec(dem, bbox, 0);
  if (!g) return null;
  return { x0: g.x0 + g.i0 * g.cell, y0: g.y0 + g.j0 * g.cell, cell: g.cell,
           w: g.sw, h: g.sh, i0: 0, j0: 0, sw: g.sw, sh: g.sh, z: g.z };
}

/* A grid spec over a synthetic surface — the same shape a whole-DEM gridSpec
   has, so a kernel cannot tell the difference. f(x, y) returns feet or NaN. */
export function synthGrid(x0, y0, cell, w, h, f) {
  const z = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) z[j * w + i] = f(x0 + i * cell, y0 + j * cell, i, j);
  return { x0, y0, cell, w, h, i0: 0, j0: 0, sw: w, sh: h, z };
}

/* ------------------------------------------------- EA's design surfaces ---- */
/* The §5 manifest and the shipped rasters. surfaceElev is NEAREST-CELL, not
   bilinear — js/cadnative.js's comment says why: the rasters ARE the design at
   1 ft, and interpolating would invent precision the source does not have. */
let manifest = null;
export function surfaces() {
  if (!manifest) manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, "data", "design", "surfaces.json"), "utf8"));
  return manifest.surfaces || [];
}
export function surfaceMeta(id) { return surfaces().find(s => s.id === id || s.key === id) || null; }

const surfCache = new Map();
export function loadSurface(id) {
  if (surfCache.has(id)) return surfCache.get(id);
  const m = surfaceMeta(id);
  if (!m) throw new Error("no design surface " + id + " in data/design/surfaces.json");
  const r = m.raster;
  const t0 = Date.now();
  const payload = path.join(REPO, "datajs", "d_cad_surfaces.js");
  const key = cacheKey(payload, "surf-" + id);
  let z = cacheGet(key, r.w * r.h);
  if (z) loadStats.cached.push("surf:" + id);
  else {
    /* the payload holds four data-URLs; pull this surface's out by its key
       rather than evaluating 11 MB of JavaScript */
    const src = fs.readFileSync(payload, "utf8");
    const re = new RegExp('SBMM_DATA\\["' + r.payload + '"\\]\\s*=\\s*"data:image/png;base64,([A-Za-z0-9+/=]+)"');
    const mm = re.exec(src);
    if (!mm) throw new Error("datajs/d_cad_surfaces.js has no payload " + r.payload);
    const img = decodePNG(Buffer.from(mm[1], "base64"));
    if (img.w !== r.w || img.h !== r.h)
      throw new Error(`${r.payload} is ${img.w}x${img.h} but the manifest says ${r.w}x${r.h}`);
    /* NOTE the difference from a DEM: js/cadnative.js keeps a surface raster
       NORTH-up (PNG order) and flips inside surfaceElev. Kept identical here. */
    z = new Float32Array(img.w * img.h);
    for (let i = 0, n = z.length; i < n; i++) {
      const v = img.data[i * img.channels] * 256 + img.data[i * img.channels + 1];
      z[i] = v === 0 ? NaN : r.zmin + (v - 1) * r.zstep;
    }
    cachePut(key, z);
    loadStats.decoded.push("surf:" + id);
  }
  loadStats.ms += Date.now() - t0;
  const s = { z, w: r.w, h: r.h, x0: r.x0, y0: r.y0, step: r.step || 1, zstep: r.zstep || 0, meta: m };
  surfCache.set(id, s);
  return s;
}

/* js/cadnative.js surfaceElev(id, x, y) */
export function surfaceElev(id, x, y) {
  const s = loadSurface(id);
  const i = Math.round((x - s.x0) / s.step);
  const j = Math.round((y - s.y0) / s.step);
  if (i < 0 || i >= s.w || j < 0 || j >= s.h) return NaN;
  return s.z[(s.h - 1 - j) * s.w + i];
}

/* js/refsurf.js gridSpec(f, bbox) — the transferable raster window a job gets,
   in the {x0,y0,cell,nx,ny,z} shape compute.js's dgridAt() consumes. */
export function surfaceGridSpec(id, bbox) {
  const m = surfaceMeta(id);
  if (!m || !m.raster) return null;
  const r = m.raster, cell = r.step || 1;
  let x0 = r.x0, y0 = r.y0, nx = r.w, ny = r.h;
  if (bbox) {
    const i0 = Math.max(0, Math.floor((bbox[0] - r.x0) / cell) - 1);
    const j0 = Math.max(0, Math.floor((bbox[1] - r.y0) / cell) - 1);
    const i1 = Math.min(r.w - 1, Math.ceil((bbox[2] - r.x0) / cell) + 1);
    const j1 = Math.min(r.h - 1, Math.ceil((bbox[3] - r.y0) / cell) + 1);
    if (i1 < i0 || j1 < j0) return null;
    x0 = r.x0 + i0 * cell; y0 = r.y0 + j0 * cell;
    nx = i1 - i0 + 1; ny = j1 - j0 + 1;
  }
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    z[j * nx + i] = surfaceElev(id, x0 + i * cell, y0 + j * cell);
  return { x0, y0, cell, nx, ny, z, zstep: r.zstep || 0 };
}

/* --------------------------------------------------------------- data ------ */
/* a repo-relative (or absolute) JSON file. python's json.dump writes bare NaN
   — the water references carry one, for a run that ends on a NoData cell — so
   it is turned into null rather than being a parse error. */
export function readJSON(file) {
  const f = path.isAbsolute(file) ? file : path.join(REPO, file);
  return JSON.parse(fs.readFileSync(f, "utf8").replace(/\bNaN\b/g, "null"));
}
