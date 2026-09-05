/* SBMM Site Explorer — every kernel in js/compute.js, checked in node.

   docs/V11_SPEC.md §2. No browser, no Playwright, no npm dependency beyond what
   the repo already ships: js/compute.js is a context-free module (that is the
   whole point of it — js/jobs.js turns it into a Web Worker with
   Function.prototype.toString() and nothing else), so it loads into a plain `vm`
   and every kernel can be driven directly over the real terrain.

     node test/kernels.mjs                  every section
     node test/kernels.mjs --only water     one or more sections (comma or repeated)
     node test/kernels.mjs --list           the section names

   Two rules this file lives by.

   1. BUILD THE JOB THE WAY THE APP BUILDS IT. Every section names the call site
      it mirrors (js/tools.js buildVolumeJob, js/isopach.js show, js/design.js
      jobFor, js/smartbound.js runWand, …) and derives the same parameters the
      same way — the step from the bbox, the DEM from demForBox, the perimeter
      sampling, the coarsening. A harness that invents its own job proves the
      kernel runs, not that the app is right.
   2. EVERY NUMBER HAS A PROVENANCE. A reference is either a published golden
      (the Pile 1 volume, EA's printed excavation area, docs/V10_WATER_SPEC.md
      §9), an independent arithmetic identity (2*pi*r for a cone's contour, a
      bilinear port for a section's ground), or — where §2.3 says so — a value
      RECORDED FROM THIS COMMIT and thereafter asserted as a regression guard.
      Those are marked `recorded from this commit` and say what they guard.

   Terrain comes from test/lib/terrain.mjs (js/dem.js's layout, js/jobs.js's
   gridSpec/gridsFor) over test/lib/png.mjs, cached under test/.cache/. The
   water section reads its references from test/fixtures/ and cuts its windows
   from the real PNGs, so the planner's scratchpad fixtures are gone. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as T from "./lib/terrain.mjs";
import { decodePNG } from "./lib/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FIX = path.join(HERE, "fixtures");
const AC = 43560;

/* ------------------------------------------------------------------ argv -- */
const argv = process.argv.slice(2);
let only = null, listOnly = false, backendArg = "both";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") only = (only || []).concat(String(argv[++i]).split(","));
  else if (a === "--list") listOnly = true;
  /* v21 (docs/V21_WASM_SPEC.md §5): every section runs on BOTH backends by
     default, so a golden is a golden whichever core computed it. SBMM_WASM=0
     is the environment's way of saying the same thing the Help switch says. */
  else if (a === "--backend") backendArg = String(argv[++i]);
  else if (a.startsWith("--")) argv[++i];        // tolerate (and ignore) legacy flags
}
if (process.env.SBMM_WASM === "0") backendArg = "js";
if (!["js", "wasm", "both"].includes(backendArg)) {
  console.error("--backend takes js | wasm | both");
  process.exit(2);
}

/* --------------------------------------------------- load js/compute.js ---- */
function loadCompute() {
  const file = path.join(REPO, "js", "compute.js");
  /* runInThisContext, NOT runInContext: js/compute.js declares one plain
     `var SBMM_COMPUTE = (function(){...})()`, so running it in the main realm's
     global scope is enough to get it — and it is also the only way the timings
     below mean anything. A vm.createContext() sandbox is a second V8 context and
     runs this arithmetic about six times slower (fillDem over the Herman window:
     2.4 s sandboxed vs 0.38 s here), which is an artefact of the sandbox, not of
     the kernels: in the app they run in a Worker, i.e. an ordinary realm. */
  vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
  const api = globalThis.SBMM_COMPUTE;
  if (!api) throw new Error("js/compute.js did not define SBMM_COMPUTE");
  /* the dual-build contract: the worker is rebuilt from moduleSource alone
     (js/jobs.js workerSource()), so prove that text still evaluates on its own */
  const ctx2 = vm.createContext({ console });
  vm.runInContext("var SBMM_COMPUTE = (" + api.moduleSource + ")();", ctx2, { filename: "worker-source" });
  if (!ctx2.SBMM_COMPUTE || ctx2.SBMM_COMPUTE.VERSION !== api.VERSION)
    throw new Error("moduleSource round-trip does not rebuild the module");
  return api;
}

/* --------------------------------------------- the WASM core (v21) -------- */
/* The payload the app ships, read the way the app reads it: bytes, never a
   file path, because over file:// nothing can be fetched (CLAUDE.md). Node has
   no 4 kB synchronous-compile limit, so this is the worker's own path. */
function loadWasm(api) {
  const f = path.join(REPO, "datajs", "w_kernels.js");
  if (!fs.existsSync(f)) return { ok: false, why: "datajs/w_kernels.js is not in this checkout" };
  const txt = fs.readFileSync(f, "utf8");
  const mb = txt.match(/SBMM_DATA\["wasm_kernels_meta"\]=(\{.*?\});/);
  const bb = txt.match(/SBMM_DATA\["wasm_kernels"\]="([A-Za-z0-9+/=]*)"/);
  if (!bb) return { ok: false, why: "datajs/w_kernels.js carries no wasm_kernels payload" };
  const meta = mb ? JSON.parse(mb[1]) : null;
  const bytes = Buffer.from(bb[1], "base64");
  const ok = api.wasmInitSync ? api.wasmInitSync(bytes, meta) : false;
  return { ok, meta, bytes: bytes.length, why: ok ? null : "the module did not instantiate" };
}

/* bitwise identity between two typed arrays, NaN counted as equal to NaN --
   which is what "the same raster" means for a grid whose NoData IS NaN */
function sameArray(a, b) {
  if (!a || !b || a.length !== b.length) return { ok: false, n: -1, at: -1 };
  let bad = 0, at = -1;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (bad === 0) at = i;
    bad++;
  }
  return { ok: bad === 0, n: bad, at };
}
/* the largest relative difference, for the kernels whose summation order moves */
function maxRel(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y || (Number.isNaN(x) && Number.isNaN(y))) continue;
    const d = Math.abs(x - y) / Math.max(1e-12, Math.abs(y));
    if (d > m) m = d;
  }
  return m;
}
/* vendor/d3-delaunay.min.js — the volume job's perimeter TIN is triangulated by
   the HOST, not the kernel (js/tools.js buildVolumeJob), so the harness has to
   do the same. It is a UMD bundle and defines globalThis.d3 when loaded with
   neither `module` nor `define` in scope, which is the case inside an ES module. */
function loadDelaunay() {
  const f = path.join(REPO, "vendor", "d3-delaunay.min.js");
  vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
  if (!globalThis.d3 || !globalThis.d3.Delaunay) throw new Error("vendor/d3-delaunay.min.js did not define d3.Delaunay");
  return globalThis.d3.Delaunay;
}

/* --------------------------------------------------- geometry (js/util.js) - */
const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function polyArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function polyPerimeter(p) { let s = 0; for (let i = 0; i < p.length; i++) s += dist2d(p[i], p[(i + 1) % p.length]); return s; }
function pointInPoly(x, y, p) {
  let inn = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inn = !inn;
  }
  return inn;
}
/* shortest distance from a point to a closed ring's edge */
function ringDist(x, y, p) {
  let best = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[j], b = p[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0;
    t = clamp(t, 0, 1);
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)));
  }
  return best;
}
function centroid(p) { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; }
function samplePerimeter(p, step) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], d = dist2d(a, b), n = Math.max(1, Math.round(d / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/* js/smartbound.js ptsFrom — including its trim: a marching-squares ring
   repeats its first vertex and a polygon feature must not, so the traced
   vertex COUNT the app reports is one below the kernel's nPts. */
function ptsFrom(coords, n, keepClosed) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [coords[i * 2], coords[i * 2 + 1]];
  if (out.length > 3 && !keepClosed) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
  }
  return out;
}

/* ------------------------------------------------------------ reporting --- */
let fails = 0, checks = 0, warns = 0;
const fmt = v => (v === null || v === undefined || Number.isNaN(v)) ? String(v)
  : (typeof v === "number" ? (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(3)).replace(/\.?0+$/, m => m.includes(".") ? "" : m) : String(v));

function row(name, got, ref, ok, tolText, extra) {
  checks++;
  if (!ok) fails++;
  const g = typeof got === "number" ? fmt(got) : String(got);
  const r = typeof ref === "number" ? fmt(ref) : String(ref);
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name.padEnd(34) +
              g.padStart(14) + "   ref " + r.padStart(13) + "   " + (tolText || "") +
              (extra ? "   " + extra : ""));
}
const near = (name, got, ref, tol, unit) =>
  row(name, got, ref, Math.abs(got - ref) <= tol, "+/- " + tol + (unit || ""));
const pct = (name, got, ref, p) =>
  row(name, got, ref, Math.abs(got - ref) <= Math.abs(ref) * p / 100, "+/- " + p + " %",
      "d=" + (100 * (got - ref) / ref).toFixed(2) + " %");
const exact = (name, got, ref) => row(name, got, ref, got === ref, "exact");
const atMost = (name, got, ref, unit) => row(name, got, ref, got <= ref, "<= " + ref + (unit || ""));
const dist = (name, gx, gy, rx, ry, tol) =>
  row(name, "E " + gx.toFixed(1) + " N " + gy.toFixed(1), "E " + rx.toFixed(0) + " N " + ry.toFixed(0),
      Math.hypot(gx - rx, gy - ry) <= tol, "within " + tol + " ft",
      "d=" + Math.hypot(gx - rx, gy - ry).toFixed(2) + " ft");
/* a simplified path may shed length but must not gain it (V10 spec §9) */
const simpLen = (name, got, ref) =>
  row(name, got, ref, got >= ref * 0.97 && got <= ref * 1.005, "-3 % / +0.5 %",
      "d=" + (100 * (got - ref) / ref).toFixed(2) + " %");
function budget(name, ms, limitMs) {
  const over = ms > limitMs;
  if (over) warns++;
  console.log("  " + (over ? "OVER" : "time") + "  " + name.padEnd(34) +
              (ms.toFixed(0) + " ms").padStart(14) + "   budget " + (limitMs / 1000) + " s");
}
const timed = (fn) => { const t = Date.now(); const r = fn(); return [r, Date.now() - t]; };
const note = s => console.log("        " + s);

/* ============================ 1. VOLUME ================================== */
/* Mirrors js/tools.js buildVolumeJob(f, {baseMode:"tin"}) exactly: the DEM from
   SBMM.demForBox over the footprint, the integration step sized from the BBOX
   (never the area — CLAUDE.md), the perimeter sampled at that step and lifted
   onto SBMM.elev, and the Delaunay triangulation done host-side. */
function buildVolumeJob(pts, opts) {
  opts = opts || {};
  const baseMode = opts.baseMode || "tin";
  const perimMul = opts.perimMul || 1;
  const bxs = pts.map(p => p[0]), bys = pts.map(p => p[1]);
  const dem = T.demForBox([Math.min(...bxs), Math.min(...bys), Math.max(...bxs), Math.max(...bys)])
            || T.loadDem("dem_site");
  const bboxCells = s => ((Math.max(...bxs) - Math.min(...bxs)) / s) * ((Math.max(...bys) - Math.min(...bys)) / s);
  let step = dem.m.cell;
  while (bboxCells(step) > 400000) step *= 2;

  const per = samplePerimeter(pts, Math.max(1, step * perimMul))
    .map(p => [p[0], p[1], T.elev(p[0], p[1])])
    .filter(p => !isNaN(p[2]));
  if (per.length < 6) return null;

  const perZ = per.map(p => p[2]);
  let fixedZ = opts.fixedZ != null ? opts.fixedZ : null;
  if (baseMode === "lowest") fixedZ = Math.min(...perZ);

  const bx0 = Math.min(...bxs), bx1 = Math.max(...bxs), by0 = Math.min(...bys), by1 = Math.max(...bys);
  const nx = Math.max(1, Math.floor((bx1 - bx0) / step)), ny = Math.max(1, Math.floor((by1 - by0) / step));

  const poly = new Float64Array(pts.length * 2);
  pts.forEach((p, i) => { poly[i * 2] = p[0]; poly[i * 2 + 1] = p[1]; });
  const perim = new Float64Array(per.length * 3);
  per.forEach((p, i) => { perim[i * 3] = p[0]; perim[i * 3 + 1] = p[1]; perim[i * 3 + 2] = p[2]; });
  let tri = null;
  if (baseMode === "tin") tri = new Uint32Array(Delaunay.from(per, p => p[0], p => p[1]).triangles);
  const grids = T.gridsFor([bx0, by0, bx1, by1]);
  return { job: { poly, perim, tri, baseMode, fixedZ, dgrid: opts.dgrid || null,
                  step, bx0, by0, nx, ny, grids },
           step, dem, nPerim: per.length, area: polyArea(pts) };
}

function secVolume() {
  /* the ring the app measures for the golden number: SBMM.tracedPiles is
     SBMM_DATA.piles filtered on "Fig 2" (js/layers.js), and
     SBMM.tools.volumeOfPile("Pile 1 (Fig 2)") takes that ring verbatim */
  const piles = T.readJSON("data/piles.json");
  const p1 = piles.find(p => (p.name || "") === "Pile 1 (Fig 2)");
  if (!p1) throw new Error('data/piles.json has no "Pile 1 (Fig 2)"');
  const built = buildVolumeJob(p1.ring.map(p => p.slice()), { baseMode: "tin" });
  console.log("\nvolume — Pile 1 (Fig 2), perimeter-TIN base, " + built.dem.m.cell +
              "-ft DEM @ " + built.step + " ft, " + built.nPerim + " perimeter samples");
  const [out, ms] = timed(() => C.runJob("volume", built.job));
  const R = out.result;
  const yd3 = v => v / 27;
  /* THE golden number (CLAUDE.md): if a change moves this, the change is wrong. */
  near("fill", +yd3(R.fill).toFixed(1), 278.4, 10, " yd3");
  near("net (fill - cut)", +yd3(R.fill - R.cut).toFixed(1), -48.1, 10, " yd3");
  /* recorded from this commit — guards the footprint and the integration grid,
     which the two yd3 numbers above are insensitive to at +/- 10 */
  near("footprint area", built.area / AC, 0.16734, 0.0002, " ac");
  exact("integration step", built.step, 1);
  /* dem_res does not reach this footprint, so the stack over it is the 1-ft
     mine grid and the 2-ft site grid — recorded from this commit */
  exact("grids shipped (finest first)", built.job.grids.map(g => g.cell).join(","), "1,2");
  note("cut " + yd3(R.cut).toFixed(1) + " yd3, " + R.n + " cells, terrain " +
       R.zmin.toFixed(1) + "-" + R.zmax.toFixed(1) + " ft, max height " + R.hmax.toFixed(2) + " ft");

  /* SELF-CONSISTENCY, the same cross-check the e2e makes: the identical
     footprint on an independently built perimeter TIN (a quarter of the
     sampling density, so a different point set and a different triangulation).
     Re-running the same job would agree to the bit and prove nothing. */
  const b4 = buildVolumeJob(p1.ring.map(p => p.slice()), { baseMode: "tin", perimMul: 4 });
  const R4 = C.runJob("volume", b4.job).result;
  pct("same ring, 1/4-density TIN", +yd3(R4.fill).toFixed(1), +yd3(R.fill).toFixed(1), 25);
  /* a fixed base at the ring's lowest perimeter point can only be BELOW the
     TIN everywhere, so it can only report more fill — an independent identity */
  const bl = buildVolumeJob(p1.ring.map(p => p.slice()), { baseMode: "lowest" });
  const Rl = C.runJob("volume", bl.job).result;
  row("lowest-rim base >= TIN fill", +yd3(Rl.fill).toFixed(1), ">= " + yd3(R.fill).toFixed(1),
      Rl.fill >= R.fill, "identity");
  budget("volume", ms, 4000);
}

/* ============================ 2. ISOPACH ================================= */
/* Mirrors js/isopach.js show("res_excbottom"): the surface's footprint bbox,
   the raster window through js/refsurf.js gridSpec, the DEM stack through
   gridsFor, and quant() = the design's own zstep plus the coarsest zstep in
   the stack (planner ruling F9). */
function secIsopach() {
  const id = "res_excbottom";
  const m = T.surfaceMeta(id);
  const r = m.raster;
  /* js/refsurf.js footprintOf(): the manifest footprint, else the raster bbox */
  const fp = (m.footprint && m.footprint.length >= 3) ? m.footprint
    : [[r.x0, r.y0], [r.x0 + r.w * r.step, r.y0], [r.x0 + r.w * r.step, r.y0 + r.h * r.step], [r.x0, r.y0 + r.h * r.step]];
  const xs = fp.map(p => p[0]), ys = fp.map(p => p[1]);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const [dgrid, dms] = timed(() => T.surfaceGridSpec(id, bbox));
  const grids = T.gridsFor([dgrid.x0, dgrid.y0, dgrid.x0 + dgrid.nx * dgrid.cell, dgrid.y0 + dgrid.ny * dgrid.cell]);
  const zstepGround = T.dems().reduce((mx, d) => Math.max(mx, (d.m && d.m.step) || 0), 0);
  console.log("\nisopach — " + id + " (" + dgrid.nx + "x" + dgrid.ny + " @ " + dgrid.cell +
              " ft) vs the DEM stack [" + grids.map(g => g.cell).join(",") + "], raster window " + dms + " ms");
  const [out, ms] = timed(() => C.runJob("isopach",
    { dgrid, grids, poly: null, nPoly: 0, zstepDesign: dgrid.zstep, zstepGround }));
  const R = out.result;
  const cut = R.cut_ft3 / 27, fill = R.fill_ft3 / 27;
  /* V11 spec §2.3. tools/build_cad_surfaces.py validated this surface at
     7,561.9 yd3 against the raw lidar MASTER; 7,556.1 is the same integral
     against the SHIPPED, quantised DEMs, which is what the app compares. */
  pct("cut", cut, 7556.1, 0.5);
  atMost("fill", +fill.toFixed(2), 0.5, " yd3");
  /* res_excbottom is existing ground minus a depth inside the limits of
     excavation and existing ground everywhere else, so it is all cut by
     construction: any fill at all is a comparison artefact (ruling F9). */
  atMost("deepest fill", +R.hi.toFixed(2), 0.7, " ft");
  const changed = R.nChanged * R.intCell * R.intCell;
  pct("changed area", changed, 203975, 0.5);
  exact("integration cell", R.intCell, 1);
  row("raster-edge cells excluded", R.nEdge, "> 0", R.nEdge > 0, "the nodata guard runs");
  /* EA's printed area over the limits of excavation, for scale */
  note("EA prints 204,303 ft2 over the limits of excavation; the changed area is " +
       changed.toFixed(0) + " ft2 (" + (100 * (changed - 204303) / 204303).toFixed(2) + " %)");
  note("compared over " + R.n + " cells, deepest cut " + R.lo.toFixed(2) +
       " ft, drawn at " + R.cell + " ft");
  budget("isopach", ms, 20000);
}

/* ============================ 3. RASTER ================================== */
/* demRasterRGBA returns COLOURS, so a number has to be read back out of one.
   Two ramps do it: a plain black->white ramp fixes the value to one part in 255
   of the kernel's own domain, and a sawtooth of N teeth over the same domain
   turns each 1/N of it into a full 0-255 sweep — a vernier, N times finer. The
   coarse read says which tooth, the fine read says where in it. Both are real
   runs of the kernel with nothing but the `ramp` job parameter changed. */
const COARSE = [[0, 0, 0], [255, 255, 255]];
function sawtooth(n) {
  const s = [];
  for (let k = 0; k <= n; k++) s.push(k % 2 ? [255, 255, 255] : [0, 0, 0]);
  return s;
}
/* t in [0,1] of the kernel's domain, from the coarse and fine pixel values */
function vernier(rCoarse, rFine, n) {
  const tc = rCoarse / 255;
  let k = Math.floor(tc * n);
  k = clamp(k, 0, n - 1);
  const u = (k % 2) ? 1 - rFine / 255 : rFine / 255;
  let t = (k + u) / n;
  /* a value within a coarse quantum of a tooth boundary can land in the
     neighbouring tooth; take whichever of the three agrees with the coarse read */
  let best = t, bd = Math.abs(t - tc);
  for (const kk of [k - 1, k + 1]) {
    if (kk < 0 || kk >= n) continue;
    const uu = (kk % 2) ? 1 - rFine / 255 : rFine / 255;
    const tt = (kk + uu) / n;
    if (Math.abs(tt - tc) < bd) { bd = Math.abs(tt - tc); best = tt; }
  }
  return best;
}
/* RGB -> hue in degrees. Written from the HSL definition, not from
   js/compute.js's hsl2rgb, so the aspect check is an inversion rather than a
   restatement of the code it is checking. */
function hueOf(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-12) return NaN;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function secRaster() {
  /* ---- slope + aspect over a synthetic plane -------------------------------
     10 % grade facing 135 deg in the kernel's own aspect convention
     (aspect = atan2(dzdx, dzdy), 0 = grid north, clockwise), so
     dz/dx = 0.10*sin(135), dz/dy = 0.10*cos(135). The kernel's slope is
     atan(|grad|) in DEGREES and its ramp domain is slope/45. */
  const G = 0.10, A = 135 * Math.PI / 180;
  const gx = G * Math.sin(A), gy = G * Math.cos(A);
  const plane = T.synthGrid(6371000, 2128000, 1, 200, 200,
    (x, y) => 1400 + gx * (x - 6371000) + gy * (y - 2128000));
  const slopeDeg = Math.atan(G) * 180 / Math.PI;
  console.log("\nraster — synthetic 200x200 plane, " + (100 * G).toFixed(2) + " % grade facing " +
              135 + " deg (true slope " + slopeDeg.toFixed(4) + " deg)");

  const NT = 64;                                   // vernier teeth over 0..45 deg
  const [cOut, cMs] = timed(() => C.runJob("raster",
    { grid: plane, stride: 1, alpha: 255, kind: "slope", ramp: COARSE, zlo: 0, zhi: 1, nanColor: null }));
  const fOut = C.runJob("raster",
    { grid: plane, stride: 1, alpha: 255, kind: "slope", ramp: sawtooth(NT), zlo: 0, zhi: 1, nanColor: null });
  const W = cOut.result.W, H = cOut.result.H;
  exact("raster size", W + "x" + H, "200x200");
  /* "everywhere inside the border": slopeAspect clamps at the grid edge, so the
     one-cell frame is a different quantity by construction and is excluded. */
  let lo = Infinity, hi = -Infinity, nIn = 0;
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const k = (j * W + i) * 4;
    const t = vernier(cOut.result.rgba[k], fOut.result.rgba[k], NT);
    const pctSlope = Math.tan(t * 45 * Math.PI / 180) * 100;
    if (pctSlope < lo) lo = pctSlope; if (pctSlope > hi) hi = pctSlope;
    nIn++;
  }
  near("slope, min inside the border", lo, 10.0, 0.05, " %");
  near("slope, max inside the border", hi, 10.0, 0.05, " %");
  note(nIn + " interior cells, vernier of " + NT + " teeth = " +
       (45 / NT / 255).toFixed(5) + " deg per level");
  /* the border IS different, and saying so is part of the check: a kernel that
     had stopped clamping would make the frame equal the interior */
  const kEdge = 0;
  const tEdge = vernier(cOut.result.rgba[kEdge], fOut.result.rgba[kEdge], NT);
  row("corner cell differs (clamped)", (Math.tan(tEdge * 45 * Math.PI / 180) * 100).toFixed(2) + " %",
      "!= 10.00 %", Math.abs(Math.tan(tEdge * 45 * Math.PI / 180) * 100 - 10) > 0.5, "clamped edge");

  const aOut = C.runJob("raster",
    { grid: plane, stride: 1, alpha: 255, kind: "aspect", ramp: null, zlo: 0, zhi: 1, nanColor: null });
  const ka = ((H >> 1) * W + (W >> 1)) * 4;
  const asp = hueOf(aOut.result.rgba[ka], aOut.result.rgba[ka + 1], aOut.result.rgba[ka + 2]);
  near("aspect at the centre", asp, 135, 0.5, " deg");
  budget("raster (slope, 200x200)", cMs, 2000);

  /* ---- hypso over a real window -------------------------------------------
     The colour is (z - zlo)/(zhi - zlo) through the ramp, and zlo/zhi are job
     parameters, so the vernier here is the kernel's own domain: a first pass
     over the whole window's range locates the extremes, a second pass over a
     narrow bracket resolves them to better than the DEM's 0.02 ft step. */
  const abp = T.loadDem("dem_abp");
  const win = T.subGrid(abp, [6371200, 2128600, 6371800, 2129200]);
  let wlo = Infinity, whi = -Infinity;
  for (let k = 0; k < win.z.length; k++) { const v = win.z[k]; if (!isNaN(v)) { if (v < wlo) wlo = v; if (v > whi) whi = v; } }
  console.log("\nraster — hypso over a real 600x600 ft window of dem_abp, z " +
              wlo.toFixed(2) + " to " + whi.toFixed(2) + " ft");
  const readBack = (zlo, zhi) => {
    const R = C.runJob("raster", { grid: win, stride: 1, alpha: 255, kind: "hypso",
                                   ramp: COARSE, zlo, zhi, nanColor: null }).result;
    let mn = Infinity, mx = -Infinity;
    for (let p = 0; p < R.W * R.H; p++) {
      if (R.rgba[p * 4 + 3] === 0) continue;
      const z = zlo + (R.rgba[p * 4] / 255) * (zhi - zlo);
      if (z < mn) mn = z; if (z > mx) mx = z;
    }
    return [mn, mx];
  };
  const q = (whi - wlo) / 255;
  const [c0, c1] = readBack(wlo, whi);                       // coarse: locate
  const [f0] = readBack(c0 - 2 * q, c0 + 2 * q);             // fine: the minimum
  const [, f1] = readBack(c1 - 2 * q, c1 + 2 * q);           // fine: the maximum
  near("hypso min = window z min", f0, wlo, abp.m.step, " ft");
  near("hypso max = window z max", f1, whi, abp.m.step, " ft");
  note("coarse quantum " + q.toFixed(3) + " ft, refined bracket +/- " + (2 * q).toFixed(3) + " ft");
  /* identity: the same window shipped as a WINDOW of dem_abp (i0/j0/sw/sh)
     must paint the same bytes as the standalone sub-grid — the kernel used to
     size its output from g.w/g.h and read NaN outside the window */
  const winSpec = T.gridSpec(abp, [6371200, 2128600, 6371800, 2129200], 0);
  const RA = C.runJob("raster", { grid: win, stride: 1, alpha: 255, kind: "slope",
                                  ramp: COARSE, zlo: 0, zhi: 1, nanColor: null }).result;
  const RB = C.runJob("raster", { grid: winSpec, stride: 1, alpha: 255, kind: "slope",
                                  ramp: COARSE, zlo: 0, zhi: 1, nanColor: null }).result;
  let bytesOff = 0;
  if (RA.W === RB.W && RA.H === RB.H) { for (let k = 0; k < RA.rgba.length; k++) if (RA.rgba[k] !== RB.rgba[k]) bytesOff++; }
  else bytesOff = -1;
  row("windowed spec = standalone sub-grid (slope)", bytesOff < 0 ? "size differs" : bytesOff + " bytes differ",
      "0 bytes", bytesOff === 0, "identity", RB.W + "x" + RB.H + " from window " + winSpec.i0 + "/" + winSpec.j0);
  /* NoData must stay transparent, not become a colour */
  const site = T.loadDem("dem_site");
  const lake = T.subGrid(site, [6368900, 2125200, 6369500, 2125800]);
  const LR = C.runJob("raster", { grid: lake, stride: 1, alpha: 200, kind: "hypso",
                                  ramp: COARSE, zlo: 1300, zhi: 1400, nanColor: null }).result;
  let nan = 0, opaque = 0;
  for (let k = 0; k < lake.z.length; k++) if (isNaN(lake.z[k])) nan++;
  for (let p = 0; p < LR.W * LR.H; p++) if (LR.rgba[p * 4 + 3] !== 0) opaque++;
  row("NoData stays transparent", LR.W * LR.H - opaque, nan, LR.W * LR.H - opaque === nan, "exact",
      nan + " NoData cells in the window");
}

/* ============================ 4. CONTOURS ================================ */
function secContours() {
  /* ---- a synthetic cone: every ring's length is 2*pi*r, exactly ------------
     apex 100 ft at the centre, base radius 400 ft, 1-ft cells. The ring at
     level lv has radius 4*(100 - lv), so each level is an arithmetic identity
     rather than a recorded number.

     The centre sits on a half-cell (400.5, 400.5) deliberately. Put it on a
     node and the 10-ft levels fall exactly on node values along the axes,
     every one of which makes marching squares emit a ZERO-length segment; the
     ring is still right, but the output gains 58 degenerate two-vertex
     polylines. That is a real (harmless) property of the kernel, not of the
     cone, and it is worth not confusing with the thing being measured. */
  const R0 = 400, CXY = 400.5, N = 2 * R0 + 1;
  const cone = T.synthGrid(0, 0, 1, N, N, (x, y) => {
    const d = Math.hypot(x - CXY, y - CXY);
    return d <= R0 ? 100 - 100 * d / R0 : NaN;
  });
  console.log("\ncontours — synthetic cone, apex 100 ft, base radius 400 ft, 1-ft cells, 10-ft interval");
  const [out, ms] = timed(() => C.runJob("contours", { grid: cone, interval: 10, stride: 1, maxPts: 500000 }));
  const R = out.result;
  const unpack = RR => {
    const o = [];
    for (let k = 0; k < RR.levels.length; k++) {
      const a = RR.offsets[k], b = RR.offsets[k + 1];
      let len = 0;
      for (let q = a + 1; q < b; q++)
        len += Math.hypot(RR.coords[q * 2] - RR.coords[(q - 1) * 2],
                          RR.coords[q * 2 + 1] - RR.coords[(q - 1) * 2 + 1]);
      o.push({ lv: RR.levels[k], n: b - a, len });
    }
    return o;
  };
  const all = unpack(R);
  /* The kernel also emits two-vertex STUBS a few hundredths of a foot long:
     a marching-squares cell whose two crossings almost coincide produces a
     segment whose ends round into different 0.1-ft chaining keys from their
     neighbours', so it never joins a ring. They draw as nothing and they are
     not what "ring count" means, so the rings are the polylines over 1 ft. */
  const rings = all.filter(g => g.len > 1);
  const stubs = all.length - rings.length;
  exact("ring count", rings.length, 9);
  /* the kernel now drops any polyline shorter than half a sweep cell, so the
     stubs never leave it: a DXF of these contours has nine entities, not
     nine plus a scatter of sub-0.1-ft two-vertex fragments */
  exact("stubs emitted", stubs, 0);
  let worst = 0, worstLv = null;
  for (const g of rings) {
    const r = R0 * (100 - g.lv) / 100;
    const e = Math.abs(g.len - 2 * Math.PI * r) / (2 * Math.PI * r) * 100;
    if (e > worst) { worst = e; worstLv = g.lv; }
  }
  row("every ring length = 2*pi*r", worst.toFixed(3) + " % worst", "< 1 %", worst < 1, "identity",
      "at the " + worstLv + "-ft ring");
  for (const g of rings)
    note("level " + String(g.lv).padStart(3) + " ft: r " + (R0 * (100 - g.lv) / 100).toFixed(0) +
         " ft, " + g.n + " vertices, " + g.len.toFixed(1) + " ft (2*pi*r = " +
         (2 * Math.PI * R0 * (100 - g.lv) / 100).toFixed(1) + ")");
  budget("contours (cone)", ms, 4000);

  /* ---- the real 2-ft site grid over the mine area -------------------------
     js/analysis.js contoursFromDem() hands the kernel gridSpec(dem) with no
     bbox, i.e. the whole grid. The kernel also honours a WINDOWED spec now
     (i0/j0/sw/sh) — it used to size its sweep from g.w/g.h and read nothing —
     so the window here is shipped both ways, as a standalone grid (subGrid)
     and as a window of the site grid, and the two results must be identical.
     Stride is the app's own: max(round(interval/cell), ceil(sqrt(cells/1.5e6)))
     = 5 at 10 ft on 2 ft. */
  const site = T.loadDem("dem_site"), abp = T.loadDem("dem_abp");
  const mineBox = [abp.m.x0, abp.m.y0,
                   abp.m.x0 + (abp.m.w - 1) * abp.m.cell,
                   abp.m.y0 + (abp.m.h - 1) * abp.m.cell];
  const mine = T.subGrid(site, mineBox);
  const mineWin = T.gridSpec(site, mineBox, 0);
  const stride = Math.max(Math.max(1, Math.round(10 / site.m.cell)),
                          Math.ceil(Math.sqrt(mine.w * mine.h / 1.5e6)));
  console.log("\ncontours — the real 2-ft site grid over the mine-area window (" +
              mine.w + "x" + mine.h + "), 10-ft interval, stride " + stride);
  const [rout, rms] = timed(() => C.runJob("contours", { grid: mine, interval: 10, stride, maxPts: 500000 }));
  const RR = rout.result;
  const rall = unpack(RR);
  let vtx = 0; for (const g of rall) vtx += g.n;
  /* recorded from this commit — a regression guard on the marching-squares
     chaining and the ring-aware simplify over real terrain, where there is no
     closed form to compare against */
  pct("polylines", rall.length, 218, 5);                 // 262 before the stub floor: 43 stubs under 0.1 ft and one under 1 ft
  pct("polylines over 10 ft", rall.filter(g => g.len > 10).length, 189, 5);
  row("not truncated", RR.truncated, false, RR.truncated === false, "exact");
  /* identity: the same ground shipped as a window of the site grid */
  const RW = C.runJob("contours", { grid: mineWin, interval: 10, stride, maxPts: 500000 }).result;
  let wdiff = 0;
  const same = RW.coords.length === RR.coords.length && RW.levels.length === RR.levels.length;
  if (same) for (let k = 0; k < RR.coords.length; k++) wdiff = Math.max(wdiff, Math.abs(RW.coords[k] - RR.coords[k]));
  row("windowed spec = standalone sub-grid", same ? wdiff.toFixed(6) + " ft worst" : "shape differs",
      "identical", same && wdiff < 1e-6, "identity",
      "window i0/j0 " + mineWin.i0 + "/" + mineWin.j0 + ", " + mineWin.sw + "x" + mineWin.sh);
  note(vtx + " vertices over " + new Set(Array.from(RR.levels)).size + " levels (" +
       Math.min(...RR.levels) + " to " + Math.max(...RR.levels) + " ft), total length " +
       rall.reduce((a, g) => a + g.len, 0).toFixed(0) + " ft");
  budget("contours (real window)", rms, 20000);
}

/* ======================= 5. DESIGN + BALANCE ============================= */
/* Mirrors js/design.js jobFor(f) and balance(f): the apron from rimStats, the
   MAX_NODES coarsening, then the balance job's own extra coarsening to 90,000
   nodes and its bracket from the rim. */
const MAX_NODES = 260000;
function rimStats(pts) {
  const zs = samplePerimeter(pts, 4).map(p => T.elev(p[0], p[1])).filter(v => !isNaN(v));
  if (!zs.length) return null;
  return { lo: Math.min(...zs), hi: Math.max(...zs), mean: zs.reduce((a, b) => a + b, 0) / zs.length, n: zs.length };
}
function apronFor(pts, padZ, ratio, kind, gradePct) {
  const st = rimStats(pts);
  if (!st) return 200;
  const spread = Math.max(Math.abs(st.hi - padZ), Math.abs(st.lo - padZ), 5);
  const tilt = kind === "plane" ? Math.abs(gradePct || 0) / 100 * polyPerimeter(pts) / 4 : 0;
  return clamp((spread + tilt + 10) * ratio * 1.35, 40, 2500);
}
function designJobFor(pts, pr) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const dem = T.demForBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]) || T.loadDem("dem_site");
  const inward = pr.side === "in", existing = pr.kind === "existing";
  const ap = (inward || existing) ? dem.m.cell * 2 : apronFor(pts, pr.padZ, pr.ratio || 3, pr.kind, pr.gradePct);
  const bx0 = Math.min(...xs) - ap, bx1 = Math.max(...xs) + ap;
  const by0 = Math.min(...ys) - ap, by1 = Math.max(...ys) + ap;
  let cell = dem.m.cell;
  while (((bx1 - bx0) / cell + 1) * ((by1 - by0) / cell + 1) > MAX_NODES) cell *= 2;
  const nx = Math.floor((bx1 - bx0) / cell) + 1, ny = Math.floor((by1 - by0) / cell) + 1;
  const poly = new Float64Array(pts.length * 2);
  pts.forEach((p, i) => { poly[i * 2] = p[0]; poly[i * 2 + 1] = p[1]; });
  const c = centroid(pts);
  const grids = T.gridsFor([bx0, by0, bx1, by1]);
  return { job: { poly, kind: pr.kind, padZ: pr.padZ, ratio: pr.ratio || 3, side: pr.side || "out",
                  gradePct: pr.gradePct || 0, gradeDirDeg: pr.gradeDirDeg || 0,
                  anchorX: c[0], anchorY: c[1], x0: bx0, y0: by0, cell, nx, ny, grids,
                  contourInterval: pr.showContours ? (pr.contourInterval || 1) : 0 },
           cell, dem };
}

/* a 200-ft square pad on real ground in the mine window; the centre is on the
   bench north-west of the pit, chosen because it has terrain everywhere and
   enough relief for a balance to have something to solve */
const PAD = (() => {
  const cx = 6371400, cy = 2129100, h = 100;
  return [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
})();

function secDesign() {
  const st = rimStats(PAD);
  const padZ0 = +st.mean.toFixed(2);
  const built = designJobFor(PAD, { kind: "pad", ratio: 3, side: "out", padZ: padZ0,
                                    showContours: true, contourInterval: 1 });
  console.log("\ndesign — 200-ft square pad at E 6371400 N 2129100, 3:1 daylight outward, " +
              built.job.nx + "x" + built.job.ny + " nodes @ " + built.job.cell +
              " ft, rim " + st.lo.toFixed(1) + "-" + st.hi.toFixed(1) + " ft");
  const [out, ms] = timed(() => C.runJob("design", built.job));
  const R = out.result;
  const yd3 = v => v / 27;
  /* recorded from this commit — regression guards on preparePad/evalPad and on
     the daylight extraction, all three of which are pure functions of the DEM */
  near("mean-rim pad elevation", padZ0, 1382.71, 0.01, " ft");
  pct("cut at the mean-rim pad", yd3(R.cut), 2055.8, 1);
  pct("fill at the mean-rim pad", yd3(R.fill), 2341.6, 1);
  row("a daylight loop was found", R.dlOffsets.length - 1 > 0, true, R.dlOffsets.length - 1 > 0, "exact",
      (R.dlOffsets.length - 1) + " loops, " + R.dlDropped + " specks dropped");
  /* the design must never be outside the pad-plus-apron envelope */
  row("design range brackets the pad", R.zmin <= padZ0 && R.zmax >= padZ0, true,
      R.zmin <= padZ0 && R.zmax >= padZ0, "identity",
      R.zmin.toFixed(1) + " to " + R.zmax.toFixed(1) + " ft");
  budget("design", ms, 20000);

  /* ---- balance: solve the level where cut = fill --------------------------
     js/design.js balance(): the same job with contours off, coarsened to
     90,000 nodes, bracketed from the rim, target net 0, 40 iterations. */
  const bb = designJobFor(PAD, { kind: "pad", ratio: 3, side: "out", padZ: padZ0, showContours: false });
  const j = bb.job;
  let coarse = 1;
  while ((j.nx / coarse) * (j.ny / coarse) > 90000) coarse *= 2;
  if (coarse > 1) {
    j.cell *= coarse;
    j.nx = Math.max(4, Math.floor(j.nx / coarse));
    j.ny = Math.max(4, Math.floor(j.ny / coarse));
  }
  j.targetNet_ft3 = 0;
  j.zLo = st.lo - Math.abs(st.hi - st.lo) - 60;
  j.zHi = st.hi + Math.abs(st.hi - st.lo) + 60;
  j.iters = 40;
  console.log("\nbalance — the same pad on a " + j.cell + "-ft raster (" + j.nx + "x" + j.ny +
              "), bracket " + j.zLo.toFixed(1) + " to " + j.zHi.toFixed(1) + " ft");
  const [bout, bms] = timed(() => C.runJob("balance", j));
  const B = bout.result;
  row("solver converged", B.ok, true, B.ok === true, "exact", B.ok ? B.iters + " iterations" : B.reason);
  if (!B.ok) return;
  note("solved pad elevation " + B.z.toFixed(4) + " ft after " + B.iters + " bisections");
  near("balanced elevation", +B.z.toFixed(2), 1382.55, 0.05, " ft");
  row("net at the solved level", Math.abs(B.net) / Math.max(B.cut, B.fill) * 100,
      "< 1 % of the larger", Math.abs(B.net) <= 0.01 * Math.max(B.cut, B.fill), "1 %",
      "cut " + yd3(B.cut).toFixed(0) + " / fill " + yd3(B.fill).toFixed(0) + " yd3 on the coarse raster");
  budget("balance", bms, 30000);

  /* the confirmation js/design.js runs after adopting the solved elevation:
     regenerate at FULL resolution and the answer must still balance */
  const conf = designJobFor(PAD, { kind: "pad", ratio: 3, side: "out",
                                   padZ: +B.z.toFixed(2), showContours: false });
  const [cout, cms] = timed(() => C.runJob("design", conf.job));
  const CR = cout.result;
  const net = CR.cut - CR.fill;
  row("confirmed on the fine grid", Math.abs(net) / Math.max(CR.cut, CR.fill) * 100,
      "< 1 % of the larger", Math.abs(net) <= 0.01 * Math.max(CR.cut, CR.fill), "1 %",
      "cut " + yd3(CR.cut).toFixed(0) + " / fill " + yd3(CR.fill).toFixed(0) + " yd3 @ " + conf.job.cell + " ft");
  budget("design (confirmation)", cms, 20000);
}

/* ============================ 6. SECTIONS ================================ */
/* Mirrors js/sections.js regenerate(): the alignment, the swath bbox, the DEM
   stack over it, OFF_STEP = 2 ft. The check is the strongest kind available —
   the kernel's sampled ground against this harness's own port of Dem.at over
   the same stack, which is a different code path to the same definition. */
function secSections() {
  const a = [[6371300, 2128700], [6371300 + 300 * Math.cos(0.6), 2128700 + 300 * Math.sin(0.6)]];
  const align = new Float64Array([a[0][0], a[0][1], a[1][0], a[1][1]]);
  const width = 200, half = width / 2, interval = 50, offStep = 2;
  const xs = a.map(p => p[0]), ys = a.map(p => p[1]);
  const bbox = [Math.min(...xs) - half, Math.min(...ys) - half, Math.max(...xs) + half, Math.max(...ys) + half];
  const grids = T.gridsFor(bbox);
  console.log("\nsections — a 300-ft alignment, " + interval + "-ft stations, " + width +
              "-ft swath @ " + offStep + " ft, grids [" + grids.map(g => g.cell).join(",") + "]");
  const [out, ms] = timed(() => C.runJob("sections",
    { align, interval, width, offStep, grids, dgrid: null, chm: null }));
  const R = out.result;
  exact("stations", R.ns, 7);
  exact("offsets per station", R.no, 101);
  near("alignment length", R.total, 300, 0.01, " ft");
  let worst = 0, nCmp = 0, nNaN = 0;
  for (let s = 0; s < R.ns; s++) {
    const ux = (a[1][0] - a[0][0]) / R.total, uy = (a[1][1] - a[0][1]) / R.total;
    const X = a[0][0] + ux * R.sta[s], Y = a[0][1] + uy * R.sta[s];
    for (let o = 0; o < R.no; o++) {
      const off = -half + o * offStep;
      const px = X + (-uy) * off, py = Y + ux * off;
      const mine = T.elev(px, py), got = R.ground[s * R.no + o];
      if (isNaN(mine) || isNaN(got)) { nNaN++; continue; }
      worst = Math.max(worst, Math.abs(mine - got));
      nCmp++;
    }
  }
  row("ground = the harness's Dem.at port", worst, "<= 0.02 ft", worst <= 0.02, "+/- 0.02 ft",
      nCmp + " samples compared, " + nNaN + " NoData");
  /* the station geometry is an identity, not a recorded number */
  let stWorst = 0;
  for (let s = 0; s < R.ns; s++) {
    const ux = (a[1][0] - a[0][0]) / R.total, uy = (a[1][1] - a[0][1]) / R.total;
    stWorst = Math.max(stWorst, Math.hypot(R.cx[s] - (a[0][0] + ux * R.sta[s]),
                                           R.cy[s] - (a[0][1] + uy * R.sta[s])));
  }
  row("station centres on the alignment", stWorst, "<= 1e-6 ft", stWorst <= 1e-6, "identity");
  budget("sections", ms, 4000);

  /* ---- the design overlay and the end areas -------------------------------
     The same kernel with a design surface attached (js/sections.js passes
     SBMM.design.gridSpecFor(pr.designId, bbox)). res_excbottom is existing
     ground minus a depth, so ground - design >= 0 at every offset: there are
     no zero crossings, and the kernel's crossing-splitting trapezoid must
     therefore equal a plain trapezoid, which is an identity rather than a
     recorded number. Cut is real, fill must be nothing. */
  const b = [[6370000, 2126140], [6370300, 2126140]];
  const bAlign = new Float64Array([b[0][0], b[0][1], b[1][0], b[1][1]]);
  const bbox2 = [b[0][0] - half, b[0][1] - half, b[1][0] + half, b[1][1] + half];
  const dgrid = T.surfaceGridSpec("res_excbottom", bbox2);
  console.log("\nsections — the same kernel with res_excbottom attached, over the Southern Residence");
  /* the two quantisation steps js/sections.js ships (the same pair the
     isopach ships): the design raster's own, and the coarsest in the DEM stack */
  const zstepGround = T.dems().reduce((mx, d) => Math.max(mx, (d.m && d.m.step) || 0), 0);
  const secJob = { align: bAlign, interval, width, offStep, grids: T.gridsFor(bbox2), dgrid, chm: null,
                   zstepDesign: dgrid.zstep || 0, zstepGround };
  const R2 = C.runJob("sections", secJob).result;
  let cutSum = 0, fillSum = 0, worstA = 0, nOff = 0, worstNeg = 0, tolMax = 0, nDead = 0;
  for (let s = 0; s < R2.ns; s++) {
    let net = 0;
    for (let o = 0; o + 1 < R2.no; o++) {
      const k1 = s * R2.no + o, k2 = k1 + 1;
      const g1 = R2.ground[k1], g2 = R2.ground[k2], d1 = R2.design[k1], d2 = R2.design[k2];
      if (isNaN(g1) || isNaN(g2) || isNaN(d1) || isNaN(d2)) continue;
      let h1 = g1 - d1, h2 = g2 - d2;
      if (h1 < 0) { nOff++; worstNeg = Math.max(worstNeg, -h1); }
      /* the kernel's dead band, re-applied here from the `tol` it reports */
      tolMax = Math.max(tolMax, R2.tol[k1]);
      if (Math.abs(h1) <= R2.tol[k1]) { if (h1 !== 0) nDead++; h1 = 0; }
      if (Math.abs(h2) <= R2.tol[k2]) h2 = 0;
      net += (h1 + h2) / 2 * offStep;
    }
    /* the kernel splits each trapezoid at its zero crossing so cut and fill
       never mix; that partition is exact, so cutA - fillA must equal the plain
       trapezoid of the dead-banded differences to the bit. This is an identity,
       not a recorded number. */
    worstA = Math.max(worstA, Math.abs(net - (R2.cutA[s] - R2.fillA[s])));
    cutSum += R2.cutA[s]; fillSum += R2.fillA[s];
  }
  row("end areas exist", R2.cutA ? "cutA + fillA + tol" : "missing", "cutA + fillA + tol", !!(R2.cutA && R2.tol), "exact");
  row("cutA - fillA = plain trapezoid", worstA, "<= 1e-9 ft2", worstA <= 1e-9, "identity",
      "cut " + cutSum.toFixed(1) + " ft2, fill " + fillSum.toFixed(2) + " ft2 over " + R2.ns + " stations");
  /* res_excbottom is existing ground minus a depth, so real fill is impossible.
     What the raw profiles carry is the two rasters disagreeing at their own
     quantisation: the DEM is bilinear over 0.02-ft steps and dgridAt
     interpolates the design BILINEARLY between nodes that were built
     nearest-cell, so the difference dips a few hundredths below zero on a
     slope. The PROFILE keeps that (it is what the rasters say); the END AREAS
     dead-band it with the isopach's isoTol (ruling F9), so the fill a section
     quotes on this surface is nothing rather than 1.3 %. */
  atMost("design-above-ground in the raw profile, worst", +worstNeg.toFixed(3), 0.1, " ft");
  row("tolerance applied", tolMax.toFixed(3) + " ft max", "< 0.2 ft", tolMax > 0 && tolMax < 0.2, "isoTol",
      nDead + " offsets dead-banded of " + nOff + " below ground");
  row("fill vs cut", (100 * fillSum / cutSum).toFixed(3) + " %", "< 0.05 %",
      fillSum < 0.0005 * cutSum, "F9 dead band", "was 1.33 % before the tolerance");
  /* and the tolerance cannot eat more than it is allowed to: the cut it
     removes is bounded by the dead band itself — sum of tol x offStep over the
     offsets it zeroed — which is an inequality that holds by construction,
     against the same run with no tolerance. (Here that is 1.4 % of a 99.5 ft2
     cut, because this alignment crosses mostly the 1-ft-to-0 transition at the
     limit of excavation, where the difference is small by design.) */
  const R3 = C.runJob("sections", { ...secJob, zstepDesign: 0, zstepGround: 0 }).result;
  let cutRaw = 0; for (let s = 0; s < R3.ns; s++) cutRaw += R3.cutA[s];
  let bound = 0;
  for (let k = 0; k < R2.ns * R2.no; k++) {
    const h = R2.ground[k] - R2.design[k];
    if (!isNaN(h) && Math.abs(h) <= R2.tol[k]) bound += R2.tol[k] * offStep;
  }
  row("cut removed <= the dead band", (cutRaw - cutSum).toFixed(2) + " ft2", "<= " + bound.toFixed(2) + " ft2",
      cutRaw - cutSum <= bound + 1e-9, "inequality", (100 * cutSum / cutRaw).toFixed(2) + " % of the raw " + cutRaw.toFixed(1) + " ft2 kept");
}

/* ==================== 7. SMART BOUNDARIES ================================= */
/* Mirrors js/smartbound.js windowSpec()/runWand()/runCbound()/runToe()/runStands()
   with that file's own DEF parameters. */
function windowSpec(cx, cy, halfFt, dem) {
  const bbox = [cx - halfFt, cy - halfFt, cx + halfFt, cy + halfFt];
  const d = dem || T.demForBox(bbox) || T.loadDem("dem_site");
  const g = T.gridSpec(d, bbox, 4);
  if (!g) throw new Error("that point is outside the surveyed terrain");
  return { g, dem: d };
}
const DEF = {
  wand: { r: 35, thresh: 0.75, smooth: 18, slopeCut: 0.30, win: 420 },
  cbound: { level: null, smooth: 3, win: 1300 },
  toe: { thresh: 0.15, smooth: 12, win: 320, mode: "toe" },
  stands: { thresh: 6, minArea: 500, closeR: 1 }
};

function secSmart() {
  /* ---- WAND on Pile 3 part 1, the e2e's own case -------------------------- */
  const [PX, PY] = [6371744, 2128677];
  const ws = windowSpec(PX, PY, DEF.wand.win);
  console.log("\nwand — Pile 3 part 1 at E " + PX + " N " + PY + ", " + ws.g.sw + "x" + ws.g.sh +
              " cells of the " + ws.g.cell + "-ft grid");
  const [wout, wms] = timed(() => C.runJob("wand",
    { grid: ws.g, mode: "wand", r: DEF.wand.r, thresh: DEF.wand.thresh, smooth: DEF.wand.smooth,
      slopeCut: DEF.wand.slopeCut, cx: PX, cy: PY, tol: 1.0 }));
  const W = wout.result;
  const wpts = ptsFrom(W.coords, W.nPts);
  pct("traced area", polyArea(wpts) / AC, 0.2248, 2);
  near("vertices", wpts.length, 51, 5, "");
  row("closed ring", Math.hypot(wpts[0][0] - wpts[wpts.length - 1][0],
                                wpts[0][1] - wpts[wpts.length - 1][1]) > 0.01 && wpts.length > 8,
      true, Math.hypot(wpts[0][0] - wpts[wpts.length - 1][0], wpts[0][1] - wpts[wpts.length - 1][1]) > 0.01 && wpts.length > 8,
      "open ring, distinct ends");
  /* The click is NOT inside the ring here, and that is worth being explicit
     about: the residual forms ONE ring in this window, the click sits 2.3 ft
     outside it (it is on the pile's edge), so pileWand takes its documented
     fallback — "the ring the click sits inside, else the biggest". The area
     above says it took the right mound. The distance is the real check. */
  exact("residual rings in the window", W.rings, 1);
  atMost("click to the traced ring", +ringDist(PX, PY, wpts).toFixed(2), 5, " ft");
  row("click inside the ring", pointInPoly(PX, PY, wpts), false, pointInPoly(PX, PY, wpts) === false,
      "recorded: it is not", "the 'else the biggest' branch is what runs here");
  /* the ABP memo's published part area for the same mound — the phase-4 band */
  pct("vs the memo's part area", polyArea(wpts) / AC, 0.184, 40);
  note("peak above base " + W.peak.toFixed(2) + " ft, rim on steep ground " + W.steepPct.toFixed(0) +
       " %, " + W.rings + " residual ring(s), touched the window edge: " + !!W.touchedEdge);
  budget("wand", wms, 10000);

  /* ---- CBOUND on the Herman impoundment ----------------------------------
     20.6 acres of flat water that runs off the east edge of the 1-ft mine
     window, so this also exercises the fall-back to the 2-ft site grid. */
  const [HX, HY] = [6372743, 2127834];
  const cs = windowSpec(HX, HY, DEF.cbound.win);
  console.log("\ncbound — Herman impoundment at E " + HX + " N " + HY + ", " + cs.g.sw + "x" + cs.g.sh +
              " cells of the " + cs.g.cell + "-ft grid");
  const [cout, cms] = timed(() => C.runJob("cbound",
    { grid: cs.g, cx: HX, cy: HY, level: null, smooth: DEF.cbound.smooth }));
  const CB = cout.result;
  const cpts = ptsFrom(CB.coords, CB.nPts);
  exact("fell back to the 2-ft grid", cs.g.cell, 2);
  row("area is the impoundment", +(polyArea(cpts) / AC).toFixed(3), "15 to 26 ac",
      polyArea(cpts) / AC > 15 && polyArea(cpts) / AC < 26, "the e2e's band");
  /* recorded from this commit — the contour-snap level and the ring it traces */
  near("traced area", polyArea(cpts) / AC, 20.363, 0.4, " ac");
  near("contour level", CB.level, 1336.83, 0.05, " ft");
  row("encloses the click", pointInPoly(HX, HY, cpts), true, pointInPoly(HX, HY, cpts), "exact");
  row("a closed ring encloses it", CB.enclosing, true, !!CB.enclosing, "exact");
  note("clicked ground " + CB.sampled.toFixed(2) + " ft, nudged to " + CB.level.toFixed(2) +
       " ft (a click sitting on its own contour is ambiguous); " + CB.nPts + " vertices, " +
       CB.rings + " closed rings" + (CB.openLines ? ", " + CB.openLines + " open" : ""));
  budget("cbound", cms, 20000);

  /* ---- TOE / CREST at the same pile --------------------------------------- */
  const ts = windowSpec(PX, PY, DEF.toe.win);
  console.log("\ntoecrest — the 15 % slope contour nearest E " + PX + " N " + PY);
  const [tout, tms] = timed(() => C.runJob("toecrest",
    { grid: ts.g, cx: PX, cy: PY, thresh: DEF.toe.thresh, smooth: DEF.toe.smooth }));
  const TC = tout.result;
  const tpts = ptsFrom(TC.coords, TC.nPts, true);        // runToe keeps a closed chain closed
  row("a usable line", TC.nPts >= 3, true, TC.nPts >= 3, "exact", tpts.length + " vertices");
  /* recorded from this commit */
  pct("line length", TC.length, 154.1, 3);
  atMost("distance from the click", +TC.distFt.toFixed(1), 60, " ft");
  /* R.length is measured over the kernel's own coords. js/smartbound.js runToe
     hands them to ptsFrom with keepClosed, so a chain that goes all the way
     round the pile keeps its closing segment and the LINE feature the app
     builds is the length the card prints — an identity. (Before v9.7 ptsFrom
     dropped the repeated vertex here and the line was one segment, 2.0 ft,
     shorter than its own card.) */
  const rawLen = (function () { let s = 0; for (let i = 1; i < TC.nPts; i++)
    s += Math.hypot(TC.coords[i * 2] - TC.coords[(i - 1) * 2], TC.coords[i * 2 + 1] - TC.coords[(i - 1) * 2 + 1]); return s; })();
  near("length over the raw coords", rawLen, TC.length, 0.01, " ft");
  near("the app's line = the kernel's length", (function () { let s = 0; for (let i = 1; i < tpts.length; i++) s += dist2d(tpts[i - 1], tpts[i]); return s; })(),
       TC.length, 1e-6, " ft");
  note(TC.chains + " chains crossed the threshold in this window; the one nearest the click was taken");
  budget("toecrest", tms, 10000);

  /* ---- STANDS over the e2e's polygon in the wooded ground ----------------- */
  const chm = T.loadDem("chm"), m = chm.m;
  const poly = [[6371200, 2129000], [6371700, 2129000], [6371700, 2129450], [6371200, 2129450]];
  const pxs = poly.map(p => p[0]), pys = poly.map(p => p[1]);
  const bb = [Math.min(...pxs), Math.min(...pys), Math.max(...pxs), Math.max(...pys)];
  const cx0 = Math.max(bb[0], m.x0), cy0 = Math.max(bb[1], m.y0);
  const cx1 = Math.min(bb[2], m.x0 + (m.w - 1) * m.cell), cy1 = Math.min(bb[3], m.y0 + (m.h - 1) * m.cell);
  const sg = T.gridSpec(chm, [cx0, cy0, cx1, cy1], 3);
  const flat = new Float64Array(poly.length * 2);
  poly.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
  console.log("\nstands — canopy >= " + DEF.stands.thresh + " ft inside a 500x450 ft polygon, " +
              sg.sw + "x" + sg.sh + " cells of the CHM");
  const [sout, sms] = timed(() => C.runJob("stands",
    { grid: sg, poly: flat, thresh: DEF.stands.thresh, minArea: DEF.stands.minArea, closeR: DEF.stands.closeR }));
  const S = sout.result;
  near("stands", S.stands.length, 7, 1, "");
  pct("total canopy area", S.totalArea / AC, 3.81, 2);
  pct("tallest in the largest stand", S.stands[0].maxH, 72.3, 2);
  row("none under the minimum area", S.stands.every(s => s.cellArea >= DEF.stands.minArea), true,
      S.stands.every(s => s.cellArea >= DEF.stands.minArea), "exact",
      "smallest " + Math.min(...S.stands.map(s => s.cellArea)).toFixed(0) + " ft2");
  row("every stand traced a ring", S.stands.every(s => s.nPts >= 4), true,
      S.stands.every(s => s.nPts >= 4), "exact");
  for (const s of S.stands.slice(0, 7))
    note("stand: " + s.cellArea.toFixed(0) + " ft2 (ring " + s.ringArea.toFixed(0) + "), mean " +
         s.meanH.toFixed(1) + " ft, max " + s.maxH.toFixed(1) + " ft, " + s.nPts + " vertices");
  budget("stands", sms, 10000);
}

/* ============================ 8. TREES =================================== */
function secTrees() {
  const chm = T.loadDem("chm");
  const g = T.gridSpec(chm, [6371000, 2128900, 6371800, 2129700], 2);
  console.log("\ntrees — the e2e's 800x800 ft CHM window (" + g.sw + "x" + g.sh + " cells @ " + g.cell + " ft)");
  const [out, ms] = timed(() => C.runJob("trees", { grid: g, minH: 6, minCrown: 4 }));
  const R = out.result;
  const hs = Array.from(R.h).sort((a, b) => a - b);
  pct("trees detected", R.n, 548, 2);
  near("median height", +hs[Math.floor(hs.length / 2)].toFixed(1), 27.9, 0.2, " ft");
  near("tallest", +hs[hs.length - 1].toFixed(1), 72.3, 0.1, " ft");
  row("nothing below the 6-ft minimum", +hs[0].toFixed(2), ">= 6", hs[0] >= 6, "exact");
  row("nothing implausibly tall", hs.filter(v => v > 150).length, 0, hs.filter(v => v > 150).length === 0, "exact");
  /* every detection must sit inside the window it was cut from */
  const X0 = g.x0 + g.i0 * g.cell, Y0 = g.y0 + g.j0 * g.cell;
  let outside = 0;
  for (let i = 0; i < R.n; i++)
    if (R.x[i] < X0 || R.x[i] > X0 + (g.sw - 1) * g.cell || R.y[i] < Y0 || R.y[i] > Y0 + (g.sh - 1) * g.cell) outside++;
  exact("all inside the window", outside, 0);
  note(R.maxima + " local maxima, " + R.dropped + " dropped below the minimum crown, median crown " +
       Array.from(R.area).sort((a, b) => a - b)[Math.floor(R.n / 2)].toFixed(0) + " ft2");
  budget("trees", ms, 20000);
}

/* ============================ 9. WATER =================================== */
/* docs/V10_WATER_SPEC.md §9 and §10, the 59 checks that used to live in
   test/water_kernels.mjs. Two changes and no others: the references come from
   test/fixtures/ (in the repo now, not the planner's scratchpad) and the two
   windows are cut from the real PNGs with the same gridSpec the app uses, so
   the fixture .f32 files are gone. Both windows assert their own shape first —
   if a window ever came out a different size, every number below it would be
   quietly measuring different ground.

   A NOTE ON THE HALF CELL. The references state positions at the centre of a
   cell in their own convention, x0 + (i + 0.5)*cell. This app samples the DEM
   at x0 + i*cell (Dem.at, gridAt, pileWand — the sample IS the cell centre and
   the raster spans half a cell either side of it), so every position the
   kernels report sits half a cell south-west of the reference's label for the
   same DEM sample. That is inside every §9 tolerance by a wide margin, and the
   drop point is converted so both implementations start on the same sample. */
function hermanRing() {
  const gis = T.readJSON("data/design_gis.json");
  const f = gis.features.find(x => x.properties && x.properties.layer === "water" &&
                                   x.properties.name === "Herman Impoundment");
  if (!f) throw new Error('no water-layer feature named "Herman Impoundment" in data/design_gis.json');
  return f.geometry.coordinates[0];
}
function shape(name, g, i0, j0, sw, sh) {
  const got = [g.i0, g.j0, g.sw, g.sh].join("/");
  row(name, got, [i0, j0, sw, sh].join("/"), got === [i0, j0, sw, sh].join("/"), "exact");
}

function secWater() {
  const readRef = f => T.readJSON(path.join(FIX, f));
  const dref = readRef("drop_ref.json").swale;
  const href = readRef("herman_ref.json");
  const ring = hermanRing();

  /* ---- §9.1 raindrop --------------------------------------------------- */
  /* the swale window: the reference's drop +/- 700 ft on dem_abp, pad 0 */
  const abp = T.loadDem("dem_abp");
  const D = dref.drop;
  const swale = T.gridSpec(abp, [D[0] - 700, D[1] - 700, D[0] + 700, D[1] + 700], 0);
  const sc = swale.cell;
  const dropX = D[0] - sc / 2, dropY = D[1] - sc / 2;
  console.log("\n§9.1  raindrop — " + swale.sw + " x " + swale.sh + " cells of the " + sc +
              "-ft grid, drop at E " + dropX + " N " + dropY);
  shape("swale window shape (i0/j0/sw/sh)", swale, 431, 736, 1402, 1402);

  const [fpOut, fpMs] = timed(() => C.runJob("flowpath", { grid: swale, x: dropX, y: dropY }));
  const fp = fpOut.result;
  near("z at the drop", fp.pts[2], dref.start[2], 0.05, " ft");
  exact("reason", fp.reason, dref.reason);
  dist("end (last vertex)", fp.end[0], fp.end[1], dref.end[0], dref.end[1], 3);
  near("last surveyed z on the run", fp.zEnd_ft, 1326.10, 0.1, " ft");
  simpLen("run length", fp.length_ft, dref.length_ft);
  exact("ponds >= 0.25 ft", fp.ponds.length, dref.ponds.length);
  for (let i = 0; i < Math.min(fp.ponds.length, dref.ponds.length); i++) {
    near("pond " + (i + 1) + " level", fp.ponds[i].level, dref.ponds[i].level, 0.03, " ft");
    near("pond " + (i + 1) + " cells", fp.ponds[i].cells, dref.ponds[i].cells, 2, "");
    note("pond " + (i + 1) + ": depth " + fp.ponds[i].depth_ft.toFixed(2) +
         " ft, area " + fp.ponds[i].area_ft2.toFixed(0) + " ft2, volume " +
         fp.ponds[i].volume_ft3.toFixed(1) + " ft3 (ref " + dref.ponds[i].volume_ft3 +
         "), rings " + fp.ponds[i].rings.length);
  }
  note("path " + fp.n + " vertices (unsimplified " + fp.lengthRaw_ft.toFixed(1) +
       " ft over " + fp.steps + " steps), fall " + fp.fall_ft.toFixed(2) + " ft");
  budget("flowpath", fpMs, 1000);

  const [caOut, caMs] = timed(() => C.runJob("catchment", { grid: swale, x: dropX, y: dropY }));
  const ca = caOut.result;
  pct("catchment cells", ca.cells, dref.catchment.cells, 3);
  note("area " + ca.area_ft2.toFixed(0) + " ft2, touchesEdge " + ca.touchesEdge +
       " (ref " + dref.catchment.touchesEdge + "), rings " + ca.rings.length);
  budget("catchment", caMs, 2000);

  /* ---- §9.2 Herman Impoundment ----------------------------------------- */
  /* the Herman window: the water polygon's bbox +/- 800 ft on dem_site, pad 0 */
  const site = T.loadDem("dem_site");
  const rxs = ring.map(p => p[0]), rys = ring.map(p => p[1]);
  const herman = T.gridSpec(site, [Math.min(...rxs) - 800, Math.min(...rys) - 800,
                                   Math.max(...rxs) + 800, Math.max(...rys) + 800], 0);
  console.log("\n§9.2  overtopping — " + herman.sw + " x " + herman.sh + " cells of the " +
              herman.cell + "-ft grid, seed ring " + ring.length + " vertices");
  shape("Herman window shape (i0/j0/sw/sh)", herman, 1471, 1914, 1753, 1204);

  const [ovOut, ovMs] = timed(() => C.runJob("overtop", { grid: herman, seedRing: ring }));
  const ov = ovOut.result;
  exact("reason", ov.reason, "ok");
  near("water surface z0", ov.z0, href.z0, 0.02, " ft");
  pct("seed cells", ov.seedCells, href.seedCells, 0.5);
  near("primary spill level", ov.primary.level, href.primary.level, 0.05, " ft");
  dist("primary spill cell", ov.primary.x, ov.primary.y, href.primary.x, href.primary.y, 15);
  dist("primary.next", ov.primary.next[0], ov.primary.next[1], href.primary.next[0], href.primary.next[1], 6);
  near("freeboard", ov.freeboard_ft, href.freeboard_ft, 0.05, " ft");
  pct("storage to spill (ft3)", ov.storage_ft3, href.storage_ft3, 3);
  pct("area at spill (ac)", ov.area_ft2 / AC, href.area_ft2 / AC, 3);
  row("rim lows within +3 ft", ov.clusters.length, href.clusters.length,
      ov.clusters.length >= 4 && ov.clusters.length <= 6, "4 to 6");
  if (ov.clusters[1] && href.clusters[1]) {
    near("rim low 2 level", ov.clusters[1].level, href.clusters[1].level, 0.05, " ft");
    dist("rim low 2 position", ov.clusters[1].x, ov.clusters[1].y, href.clusters[1].x, href.clusters[1].y, 20);
    near("rim low 2 cells", ov.clusters[1].cells, href.clusters[1].cells, 25, "");
  }
  for (const c of ov.clusters)
    note("rim low " + c.rank + ": " + c.level.toFixed(2) + " ft (+" +
         c.above_ft.toFixed(2) + ") at E " + c.x.toFixed(0) + " N " + c.y.toFixed(0) +
         ", " + c.cells + " cells");
  const stageAt = (tbl, L) => tbl.find(s => Math.abs(s.level - L) < 0.13);
  for (const L of [1340.08, 1343.83]) {
    const g = stageAt(ov.stage, L), r = stageAt(href.stage, L);
    if (!g || !r) { row("stage at " + L, g ? "-" : "missing", r ? "-" : "missing", false, "present"); continue; }
    pct("stage " + L.toFixed(2) + " area (ac)", g.area_ft2 / AC, r.area_ft2 / AC, 3);
    pct("stage " + L.toFixed(2) + " storage (ac-ft)", g.storage_ft3 / AC, r.storage_ft3 / AC, 3);
  }
  row("stage rows", ov.stage.length, href.stage.length, ov.stage.length === href.stage.length, "exact");
  note("stage rings at the spill: " + (stageAt(ov.stage, 1343.83) || { rings: [] }).rings.length +
       ";  band cells " + ov.band.v.reduce((a, v) => a + (Number.isNaN(v) ? 0 : 1), 0) +
       ";  spill cells " + ov.spillMask.v.reduce((a, v) => a + v, 0));
  budget("overtop", ovMs, 4000);

  /* the overflow route: a raindrop from primary.next with the impoundment blocked */
  const [rtOut, rtMs] = timed(() => C.runJob("flowpath",
    { grid: herman, x: ov.primary.next[0], y: ov.primary.next[1], blockRing: ring }));
  const rt = rtOut.result;
  console.log("\n§9.2  overflow route");
  exact("route reason", rt.reason, href.route.reason);
  dist("route end", rt.end[0], rt.end[1], href.route.end[0], href.route.end[1], 30);
  simpLen("route length", rt.length_ft, href.route.length_ft);
  /* §9's table says 6 ponds; that number is `t['ponds'][:6]` from the planner's log —
     the reference JSON itself carries 14. The two REAL ponds it names are ranks 1-2. */
  row("route ponds >= 0.25 ft", rt.ponds.length, href.route.ponds.length,
      Math.abs(rt.ponds.length - href.route.ponds.length) <= 1, "+/- 1",
      "(the §9 table's 6 is a truncated print)");
  for (let i = 0; i < 2 && i < rt.ponds.length; i++) {
    near("route pond " + (i + 1) + " level", rt.ponds[i].level, href.route.ponds[i].level, 0.03, " ft");
    near("route pond " + (i + 1) + " cells", rt.ponds[i].cells, href.route.ponds[i].cells, 5, "");
    note("route pond " + (i + 1) + ": depth " + rt.ponds[i].depth_ft.toFixed(2) +
         " ft, " + rt.ponds[i].area_ft2.toFixed(0) + " ft2, " +
         rt.ponds[i].volume_ft3.toFixed(1) + " ft3 (ref " + href.route.ponds[i].volume_ft3 + ")");
  }
  note("route " + rt.n + " vertices, unsimplified " + rt.lengthRaw_ft.toFixed(1) +
       " ft, ends " + rt.reason + " at " + rt.end[0].toFixed(0) + " / " + rt.end[1].toFixed(0));
  budget("flowpath (overflow route)", rtMs, 1000);

  /* ---- cross-checks beyond §9 --------------------------------------------
     Not golden numbers, but each one guards a path §9 does not reach and each is
     checked against something independent rather than against itself.          */
  console.log("\ncross-checks (beyond §9)");

  /* the unsimplified run must be the reference path vertex for vertex — the
     strongest single statement that the descent and the ponding agree with §2 */
  const raw = C.runJob("flowpath", { grid: swale, x: dropX, y: dropY, simplifyFt: 0 }).result;
  exact("raw path vertices", raw.n, dref.n);
  near("raw path length", raw.length_ft, dref.length_ft, 0.05, " ft");

  /* a point seed (the "pond under a click" entry point) must find the same spill
     as the polygon seed — same terrain, different way in */
  const ctr = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
  const [pOut, pMs] = timed(() => C.runJob("overtop", { grid: herman, seedPoint: ctr }));
  const pv = pOut.result;
  near("point-seed z0", pv.z0, ov.z0, 0.02, " ft");
  near("point-seed spill level", pv.primary.level, ov.primary.level, 0.05, " ft");
  dist("point-seed spill cell", pv.primary.x, pv.primary.y, ov.primary.x, ov.primary.y, 15);
  pct("point-seed storage", pv.storage_ft3, ov.storage_ft3, 3);
  budget("overtop (point seed)", pMs, 4000);

  /* §9.1's note: the drop at E 6371600 N 2128900 falls into a 4.5-ft-deep,
     1,878-cell pond and then leaves the window. The note's 1,069 ft is measured in
     a window centred on THAT drop; here the same drop sits off-centre in the swale
     window, so it reaches the edge sooner — the pond is the check. */
  const wc = C.runJob("flowpath", { grid: swale, x: 6371600 - sc / 2, y: 2128900 - sc / 2 }).result;
  exact("window-chain reason", wc.reason, "window");
  row("window-chain exit", wc.exit ? "present" : "null", "present", !!wc.exit, "not null");
  near("window-chain pond depth", wc.ponds[0].depth_ft, 4.46, 0.05, " ft");
  near("window-chain pond cells", wc.ponds[0].cells, 1878, 2, "");

  /* refusals must be refusals, not silent nonsense */
  const noseed = C.runJob("overtop", { grid: herman, seedRing: [[0, 0], [1, 0], [1, 1]] }).result.reason;
  row("seed off the grid", noseed, "noseed", noseed === "noseed", "exact");
  let threw = "";
  try { C.runJob("flowpath", { grid: herman, x: herman.x0, y: herman.y0 }); }
  catch (e) { threw = e.message; }
  row("drop outside the window", threw ? "throws" : "silent", "throws", !!threw, "exact", threw);

  /* spec §10: the surveyed water surface (Aug 2026) as today's level, and exact
     stage rows at the pipe invert and the sandbag crest. Reference: the planner's
     Python (test/fixtures/survey_stage_ref.py) with seed cells' ground = the water
     surface: pipe 1341.55 -> 22.18 ac / 4,755,100 ft3; crest 1343.54 ->
     6,701,338 ft3; spill 1343.84 -> 6,998,937 ft3; freeboard 7.39 ft. */
  console.log("\n§10   surveyed water surface 1336.45 ft, pipe invert 1341.55, sandbag crest 1343.54");
  const [svOut, svMs] = timed(() => C.runJob("overtop",
    { grid: herman, seedRing: ring, z0Override: 1336.45, levels: [1341.55, 1343.54] }));
  const sv = svOut.result;
  near("z0 (surveyed override)", sv.z0, 1336.45, 1e-6, " ft");
  near("z0_lidar kept", sv.z0_lidar, ov.z0, 1e-6, " ft");
  near("spill level unchanged", sv.primary.level, ov.primary.level, 1e-6, " ft");
  near("freeboard from surveyed water", sv.freeboard_ft, 7.39, 0.02, " ft");
  pct("storage to spill (surveyed z0)", sv.storage_ft3, 6998937, 0.5);
  const stPipe = sv.stage.find(s => s.extra && Math.abs(s.level - 1341.55) < 1e-6);
  const stCrest = sv.stage.find(s => s.extra && Math.abs(s.level - 1343.54) < 1e-6);
  row("extra stage rows present", stPipe && stCrest ? 2 : 0, 2, !!(stPipe && stCrest), "exact");
  if (stPipe) { pct("pipe stage area (ac)", stPipe.area_ft2 / AC, 22.18, 0.5); pct("pipe stage storage", stPipe.storage_ft3, 4755100, 0.5); }
  if (stCrest) pct("crest stage storage", stCrest.storage_ft3, 6701338, 0.5);
  const sorted = sv.stage.every((s, i) => !i || s.level >= sv.stage[i - 1].level - 1e-9);
  row("stage table stays sorted", sorted ? "sorted" : "unsorted", "sorted", sorted, "exact");
  budget("overtop (surveyed z0 + extra levels)", svMs, 4000);
}


/* ============================ 10. STORM ================================== */
/* docs/V12_STORM_SPEC.md §6. `flowpath` is covered by the water section above;
   this one covers its `conduits` path — the storm network as a set of
   topological shortcuts with an elevation at each end.

   The call site mirrored is js/water.js traceRun() + js/storm.js conduitsFor():
   the same window squares (700 ft on a 1-ft grid, 1,400 ft on the 2-ft), the
   same "conduits whose INLET is inside this window, minus the ones this run has
   already used", the same flattening of the node graph into `next`, and the same
   re-centring on `exit` for reason "window" AND reason "conduit". A harness that
   invented its own job would prove the kernel runs, not that the app is right. */

/* --- js/storm.js, in node ------------------------------------------------ */
function stormModel() {
  const NET = T.readJSON("data/storm_network.json");
  const byId = Object.fromEntries(NET.nodes.map(n => [n.id, n]));
  const rims = {};
  for (const n of NET.nodes) { const z = T.elev(n.x, n.y); rims[n.id] = Number.isNaN(z) ? null : +z.toFixed(2); }
  const nextOf = {};
  for (const c of NET.conduits) {
    const nx = NET.conduits.find(q => q.from === c.to && q.id !== c.id);
    nextOf[c.id] = nx ? nx.id : null;
  }
  /* §2 "Rim for the kernel": the surveyed invert where one exists, else the
     lidar ground. Never anything else. */
  const rimFor = id => byId[id].invert_ft != null ? byId[id].invert_ft : rims[id];
  /* §2 "a sunken inlet" — js/storm.js findMouth(), ported. The lidar is Jan 2024
     and the two discharge pipes were built into a channel it never saw, so the
     cells at the surveyed invert points read the top of the sandbag wall. An
     inlet whose invert is below the lidar ground at its own cell enters the pipe
     at the NEAREST cell at or below the invert within 30 ft; the rim stays the
     survey's, and nothing moves if no such cell exists. */
  const MOUTH_SEARCH_FT = 30;
  const mouths = {};
  for (const n of NET.nodes) {
    if (n.invert_ft == null) continue;
    const dem = T.demAt(n.x, n.y);
    if (!dem) continue;
    const gz = dem.at(n.x, n.y);
    if (Number.isNaN(gz) || gz <= n.invert_ft + 1e-9) continue;
    const m = dem.m, cell = m.cell, rc = Math.ceil(MOUTH_SEARCH_FT / cell);
    const i0 = Math.round((n.x - m.x0) / cell), j0 = Math.round((n.y - m.y0) / cell);
    let best = null, bd = Infinity;
    for (let j = j0 - rc; j <= j0 + rc; j++) {
      if (j < 0 || j >= m.h) continue;
      for (let i = i0 - rc; i <= i0 + rc; i++) {
        if (i < 0 || i >= m.w) continue;
        const z = dem.atGrid(i, j);
        if (Number.isNaN(z) || z > n.invert_ft) continue;
        const x = m.x0 + i * cell, y = m.y0 + j * cell;
        const d = Math.hypot(x - n.x, y - n.y);
        if (d > MOUTH_SEARCH_FT || d >= bd) continue;
        bd = d; best = { x, y, z: +z.toFixed(2), moved: +d.toFixed(1), ground: +gz.toFixed(2) };
      }
    }
    mouths[n.id] = best || { x: n.x, y: n.y, z: null, moved: null, ground: +gz.toFixed(2) };
  }
  const conduitsFor = bbox => NET.conduits
    .filter(c => {
      const a = byId[c.from];
      return a.x >= bbox[0] && a.x <= bbox[2] && a.y >= bbox[1] && a.y <= bbox[3];
    })
    .map(c => {
      const a = byId[c.from], mo = mouths[c.from];
      const use = (mo && mo.moved != null) ? mo : null;
      return { id: c.id, ix: use ? use.x : a.x, iy: use ? use.y : a.y, rim: rimFor(c.from),
               ox: byId[c.to].x, oy: byId[c.to].y, len: c.length_ft,
               mouth_moved_ft: use ? use.moved : null, next: nextOf[c.id] };
    });
  return { NET, byId, rims, rimFor, mouths, conduitsFor };
}

/* js/water.js traceRun(), the window chain and all */
function hostRun(M, x, y, storm) {
  let dem = T.demAt(x, y);
  if (!dem) return null;
  let cx = x, cy = y, hops = 0, prevReason = null, pipeFt = 0, lengthSum = 0;
  const pts = [], ponds = [], legs = [], used = new Set(), grids = [];
  let reason = "steps", end = null;
  for (;;) {
    const half = dem.m.cell <= 1.0 ? 700 : 1400;
    const win = [cx - half, cy - half, cx + half, cy + half];
    const grid = T.gridSpec(dem, win, 0);
    if (!grid) { reason = "nodata"; break; }
    const gl = dem.m.cell + "-ft";
    if (grids[grids.length - 1] !== gl) grids.push(gl);
    const cds = storm ? M.conduitsFor(win).filter(c => !used.has(c.id)) : [];
    const R = C.runJob("flowpath", { grid, x: cx, y: cy,
      conduits: cds.length ? cds : null, captureFt: 3 }).result;
    const skip = (pts.length && prevReason !== "conduit") ? 1 : 0;
    const base = pts.length;
    for (let i = skip; i < R.n; i++) pts.push([R.pts[i * 3], R.pts[i * 3 + 1]]);
    for (const lg of (R.legs || [])) { used.add(lg.id); legs.push({ ...lg, at: base + lg.at - skip }); }
    pipeFt += R.pipe_ft || 0;
    lengthSum += R.length_ft || 0;
    for (const p of R.ponds) ponds.push(p);
    prevReason = R.reason; reason = R.reason; end = R.end;
    if (R.reason !== "window" && R.reason !== "conduit") break;
    if (hops >= 7 || lengthSum >= 20000) { reason = "steps"; break; }
    const ex = R.exit;
    if (!ex) break;
    const nd = T.demAt(ex[0], ex[1]);
    if (!nd) {
      reason = "nodata";
      if (R.reason === "conduit") { pts.push([ex[0], ex[1]]); end = [ex[0], ex[1], NaN]; }
      break;
    }
    dem = nd; cx = ex[0]; cy = ex[1]; hops++;
  }
  return { pts, reason, end, ponds, legs, pipeFt, length: lengthSum, hops, grids };
}

/* §6.6, recorded from this commit: the Frog Pond drop's overland length and the west pond's depth when it overflows through its FES */
const RECORDED_GP_OVERLAND = 629.9, RECORDED_WP_DEPTH = 3.08;
function secStorm() {
  /* ---- the identity (§6, first bullet) -------------------------------- */
  /* Absent, and empty, must be the v10 kernel to the bit. This is the check
     that lets every water number above stay a golden rather than becoming an
     argument about whether v12 moved it. */
  const abp = T.loadDem("dem_abp");
  const D = T.readJSON(path.join(FIX, "drop_ref.json")).swale.drop;
  const mk = () => T.gridSpec(abp, [D[0] - 700, D[1] - 700, D[0] + 700, D[1] + 700], 0);
  const sc = mk().cell, dx = D[0] - sc / 2, dy = D[1] - sc / 2;
  console.log("\n§6.1  the identity — conduits absent vs conduits: []");
  const A = C.runJob("flowpath", { grid: mk(), x: dx, y: dy }).result;
  const B = C.runJob("flowpath", { grid: mk(), x: dx, y: dy, conduits: [], captureFt: 3 }).result;
  /* NaN-safe: a run that ends on a NoData cell carries a NaN z on its last
     vertex, and NaN !== NaN would call two identical arrays different */
  const same = (u, v) => u.length === v.length &&
    u.every((q, i) => q === v[i] || (Number.isNaN(q) && Number.isNaN(v[i])));
  exact("identical vertex count", B.n, A.n);
  row("identical pts", same(Array.from(A.pts), Array.from(B.pts)) ? "identical" : "DIFFER",
      "identical", same(Array.from(A.pts), Array.from(B.pts)), "bit for bit");
  row("identical ponds", JSON.stringify(A.ponds) === JSON.stringify(B.ponds) ? "identical" : "DIFFER",
      "identical", JSON.stringify(A.ponds) === JSON.stringify(B.ponds), "bit for bit");
  exact("identical reason", B.reason, A.reason);
  exact("no legs without a network", B.legs.length, 0);
  exact("no pipe without a network", B.pipe_ft, 0);
  near("length_ft unchanged", B.length_ft, A.length_ft, 0, " ft");

  /* ---- a synthetic basin (§6, second bullet) --------------------------- */
  /* A paraboloid pit 40 ft across with its natural pour point 6 ft above the
     floor, an inlet on its side 2 ft above the floor, and the outlet out on the
     far slope. Every number here is an arithmetic identity of that surface, not
     a measurement of anything. */
  console.log("\n§6.2  a synthetic basin — an inlet 2 ft up a bowl whose rim is 6 ft up");
  const R0 = 40, ZF = 100, RIMZ = 106;
  const bowl = T.synthGrid(0, 0, 1, 300, 300, (x, y) => {
    const r = Math.hypot(x - 150, y - 150);
    return r < R0 ? ZF + 6 * (r / R0) * (r / R0) : RIMZ - (r - R0) * 0.05;
  });
  /* the inlet: the cell nearest 2 ft above the floor, due east of the centre */
  const ri = Math.round(R0 * Math.sqrt(2 / 6));            // r where z = floor + 2
  const ix = 150 + ri, iy = 150;
  const izRaw = bowl.z[Math.round(iy) * bowl.sw + Math.round(ix)];
  const oxy = [150 - 120, 150];                            // out on the far slope
  const bj = { grid: bowl, x: 150, y: 150, simplifyFt: 0, minPondDepth: 0.25,
               conduits: [{ id: "syn", ix, iy, rim: izRaw, ox: oxy[0], oy: oxy[1], next: null }],
               captureFt: 3 };
  const [bOut, bMs] = timed(() => C.runJob("flowpath", bj));
  const bR = bOut.result;
  exact("one conduit leg", bR.legs.length, 1);
  near("pond level = the inlet rim", bR.ponds[0].level, izRaw, 1e-6, " ft");
  near("pond depth = rim - floor", bR.ponds[0].depth_ft, izRaw - ZF, 1e-4, " ft");
  /* the pour point is the flooded capture cell nearest the structure at the
     instant the level reaches the rim — 1 ft short of the inlet's own cell here,
     because the ring of cells at exactly the rim elevation pops in a fixed
     tie-break order and the inlet's own cell is not the first of them */
  const bd = Math.hypot(bR.legs[0].from[0] - ix, bR.legs[0].from[1] - iy);
  row("the leg leaves from the inlet", bd.toFixed(2), "<= 3", bd <= 3, "captureFt");
  near("pipe_ft = the straight distance", bR.pipe_ft,
       Math.hypot(oxy[0] - bR.legs[0].from[0], oxy[1] - bR.legs[0].from[1]), 1e-6, " ft");
  {
    /* the run continues from the outlet: the vertex after the leg is the outlet
       cell, and the run then descends the far slope to the window edge */
    const at = bR.legs[0].at;
    const nx = [bR.pts[(at + 1) * 3], bR.pts[(at + 1) * 3 + 1]];
    row("the run resumes at the outlet", "E " + nx[0].toFixed(1) + " N " + nx[1].toFixed(1),
        "E " + oxy[0].toFixed(1) + " N " + oxy[1].toFixed(1),
        Math.hypot(nx[0] - oxy[0], nx[1] - oxy[1]) <= 1.5, "within 1.5 ft");
    exact("reason after the pipe", bR.reason, "window");
  }
  /* the same basin with NO network fills to its rim and spills over the ground */
  const bNo = C.runJob("flowpath", { grid: bowl, x: 150, y: 150, simplifyFt: 0 }).result;
  /* the rim is 106 by construction; the cell nearest it is a fraction under,
     because the cells sit on integer coordinates and r = 40 falls between them */
  near("without the pipe the pond fills to the rim", bNo.ponds[0].level, RIMZ, 0.1, " ft");
  exact("without the pipe there is no leg", bNo.legs.length, 0);
  budget("flowpath (synthetic basin)", bMs, 1500);

  /* ---- a slope with an inlet 20 ft downhill (§6, third bullet) ---------- */
  console.log("\n§6.3  a plane slope — an inlet 20 ft downhill of the drop");
  /* z falls to the EAST, so the drop runs east and the inlet is downhill of it */
  const slope = T.synthGrid(0, 0, 1, 300, 300, (x) => 200 - x * 0.1);
  const sIn = [170, 150], sOut = [240, 150];
  const sR = C.runJob("flowpath", { grid: slope, x: 150, y: 150, simplifyFt: 0,
    conduits: [{ id: "syn", ix: sIn[0], iy: sIn[1], rim: 200 - sIn[0] * 0.1,
                 ox: sOut[0], oy: sOut[1], next: null }], captureFt: 3 }).result;
  exact("one leg on the slope", sR.legs.length, 1);
  const sd = Math.hypot(sR.legs[0].from[0] - sIn[0], sR.legs[0].from[1] - sIn[1]);
  row("the leg starts within captureFt of the inlet", sd.toFixed(2), "<= 3", sd <= 3, "captureFt");
  near("pipe_ft = the straight distance from there", sR.pipe_ft,
       Math.hypot(sOut[0] - sR.legs[0].from[0], sOut[1] - sR.legs[0].from[1]), 1e-6, " ft");
  /* the overland length is the two walked stretches and nothing else: the drop
     to the capture cell, then the outlet to the window's east edge */
  near("overland length excludes the pipe", sR.length_ft,
       (sR.legs[0].from[0] - 150) + (slope.sw - 1 - sOut[0]), 1e-6, " ft");
  exact("the leg starts at the last overland vertex", sR.legs[0].at,
        Math.round(sR.legs[0].from[0] - 150));

  /* ---- an outlet outside the window (§6, fourth bullet) ----------------- */
  console.log("\n§6.4  an outlet outside the window");
  const oR = C.runJob("flowpath", { grid: slope, x: 150, y: 150, simplifyFt: 0,
    conduits: [{ id: "syn", ix: sIn[0], iy: sIn[1], rim: 200 - sIn[0] * 0.1,
                 ox: 800, oy: 150, next: null }], captureFt: 3 }).result;
  exact("reason", oR.reason, "conduit");
  row("exit is the outlet", "E " + oR.exit[0] + " N " + oR.exit[1], "E 800 N 150",
      oR.exit[0] === 800 && oR.exit[1] === 150, "exact");
  exact("one leg before the window ended", oR.legs.length, 1);

  /* ---- the real network (§6, fifth bullet) ------------------------------ */
  /* RECORDED FROM THIS COMMIT and thereafter asserted as regression guards.
     What is NOT recorded but derived: the pipe lengths are the conduits' own
     `length_ft` out of data/storm_network.json, summed along the chain, so the
     pipe totals below are arithmetic on the payload rather than a measurement —
     if the network is rebuilt and a length moves, this fails and says so. */
  const M = stormModel();
  const chain = ids => ids.reduce((a, id) => a + M.NET.conduits.find(c => c.id === id).length_ft, 0);

  /* ---- the sunken inlets (§2 "a sunken inlet", ruling Sep 2026) --------- */
  /* The lidar is Jan 2024; the sandbag wall and the two 24-in pipes were built
     afterwards, so the 1-ft cells at the surveyed invert points read the top of
     the sandbags. RECORDED FROM THIS COMMIT, but every number is checkable: the
     grounds are SBMM.elev at the surveyed points, the mouths are DEM cells at or
     below the surveyed inverts, and both are inside the 30-ft search. */
  console.log("\n§6.0  the sunken pipe mouths");
  exact("inlets moved", Object.keys(M.mouths).length, 2);
  for (const [id, ref] of [["herman_pipe_n_inv", { g: 1344.66, inv: 1341.57, x: 6372065, y: 2127496, z: 1341.54, d: 25.6 }],
                           ["herman_pipe_s_inv", { g: 1344.80, inv: 1341.53, x: 6372065, y: 2127497, z: 1341.50, d: 27.1 }]]) {
    const mo = M.mouths[id];
    near(id + " lidar ground", mo.ground, ref.g, 0.02, " ft");
    near(id + " mouth moved", mo.moved, ref.d, 0.2, " ft");
    dist(id + " mouth cell", mo.x, mo.y, ref.x, ref.y, 1.5);
    near(id + " mouth cell z", mo.z, ref.z, 0.02, " ft");
    row(id + " mouth is at or below the invert", mo.z, "<= " + ref.inv, mo.z <= ref.inv + 1e-9, "exact");
    row(id + " rim is still the survey's", M.rimFor(id), ref.inv, M.rimFor(id) === ref.inv, "exact");
    row(id + " is within the 30-ft search", mo.moved, "<= 30", mo.moved <= 30, "exact");
  }
  {
    /* an inlet with no invert, or one whose invert is not below its ground, is
       not moved — the rule is about a pipe mouth the lidar did not see */
    const notMoved = ["grate_8", "green_riser", "herman_pipe_n_end", "outfall"]
      .filter(id => M.mouths[id]).length;
    exact("inlets without a sunken invert stay put", notMoved, 0);
    const c = M.conduitsFor([6372000, 2127400, 6372100, 2127550]).find(q => q.id === "herman_pipe_n");
    row("conduitsFor hands the kernel the mouth", c ? "E " + c.ix + " N " + c.iy : "missing",
        "E 6372065 N 2127496", !!c && c.ix === 6372065 && c.iy === 2127496, "exact",
        "mouth_moved_ft " + (c && c.mouth_moved_ft));
    row("and the surveyed invert as its rim", c && c.rim, 1341.57, !!c && c.rim === 1341.57, "exact");
  }

  console.log("\n§6.5  the real network — a drop at the Spot 8 grate (E 6,373,831 N 2,127,919)");
  const g8 = M.byId.grate_8;
  const [s8, s8ms] = timed(() => hostRun(M, g8.x, g8.y, true));
  const s8chain = ["road_drain_8_9", "road_drain_9_10", "road_drain_10_11", "road_drain_11_12",
                   "road_drain_12_13", "road_drain_13_14", "road_drain_14_15",
                   "road_drain_15_branch", "branch", "storm_main_lower"];
  exact("legs, grate 8 -> the outfall", s8.legs.length, s8chain.length);
  row("the chain it took", s8.legs.map(l => l.id).join(","), s8chain.join(","),
      s8.legs.map(l => l.id).join(",") === s8chain.join(","), "exact");
  near("pipe_ft = the summed conduit lengths", s8.pipeFt, chain(s8chain), 0.5, " ft");
  exact("the last leg ends at the outfall",
        M.NET.conduits.find(c => c.id === s8.legs[s8.legs.length - 1].id).to, "outfall");
  exact("reason", s8.reason, "nodata");
  dist("ends in Clear Lake", s8.end[0], s8.end[1], 6371177, 2127474, 3);
  near("overland length (recorded)", s8.length, 137.0, 1, " ft");
  note("Spot 8: " + s8.length.toFixed(1) + " ft overland + " + s8.pipeFt.toFixed(1) +
       " ft in pipe = " + (s8.length + s8.pipeFt).toFixed(1) + " ft, " + s8.ponds.length +
       " ponds, " + s8.hops + " windows chained [" + s8.grids + "]");
  budget("the Spot 8 drop (storm on)", s8ms, 12000);

  const s8off = hostRun(M, g8.x, g8.y, false);
  exact("with the drains off, no legs", s8off.legs.length, 0);
  exact("with the drains off, reason", s8off.reason, "nodata");
  near("with the drains off, overland (recorded)", s8off.length, 2267.6, 3, " ft");
  row("with the drains off it crosses the impoundment",
      s8off.ponds.some(p => p.cells > 200000) ? "yes" : "no", "yes",
      s8off.ponds.some(p => p.cells > 200000), "exact",
      "the 22.8-ac Herman pond at 1,343.84 ft");
  note("Spot 8, drains off: " + s8off.length.toFixed(1) + " ft overland, " +
       s8off.ponds.length + " ponds, deepest " +
       Math.max(...s8off.ponds.map(p => p.depth_ft)).toFixed(2) + " ft");

  console.log("\n§6.6  the real network — a drop at Frog Pond's low (the EAST pond, Spot 5, E 6,374,418 N 2,127,912)");
  /* The engineer's reading (Sep 2026), with EA's names (Frog Pond = the east
     pond, Green Pond = the west, confirmed by him): Frog Pond drains through
     a culvert under the paved road into Green Pond; Green Pond overflows
     through the FES on its west shore, piped to the Spot 8 grate and the road
     drain, never into the impoundment. */
  const fp = M.byId.frog_out;
  const [fr, frms] = timed(() => hostRun(M, fp.x, fp.y, true));
  const frChain = ["pond_culvert", "green_outlet", "road_drain_8_9", "road_drain_9_10", "road_drain_10_11",
                   "road_drain_11_12", "road_drain_12_13", "road_drain_13_14", "road_drain_14_15",
                   "road_drain_15_branch", "branch", "storm_main_lower"];
  row("the chain it took", fr.legs.map(l => l.id).join(","), frChain.join(","),
      fr.legs.map(l => l.id).join(",") === frChain.join(","), "exact");
  exact("legs", fr.legs.length, frChain.length);
  near("pipe_ft = the summed conduit lengths", fr.pipeFt, chain(frChain), 0.5, " ft");
  exact("and it reaches the outfall",
        M.NET.conduits.find(c => c.id === fr.legs[fr.legs.length - 1].id).to, "outfall");
  /* the drop sits on the culvert's own inlet cell, so the east pond forms no
     pond of its own; the west pond has two lobes — the water arrives in the
     east lobe, fills it to the saddle (a natural spill, no via) and pours into
     the west lobe, which drains through the FES. Two ponds, one via. This is
     what the "inlet is a sink in the filled DEM" rule buys: without it the
     one flood took both lobes to the saddle and reported the FES at 1402.4. */
  const vias = fr.ponds.filter(p => p.via).map(p => p.via);
  row("the west pond drains through its FES to the Spot 8 grate",
      vias.join(","), "green_outlet", vias.join(",") === "green_outlet", "exact");
  const wp = fr.ponds.find(p => p.via === "green_outlet");
  near("the west pond's level = the FES rim (lidar ground at the FES)", wp ? wp.level : NaN,
       M.rimFor("green_outlet_fes"), 0.05, " ft");
  const eastLobe = fr.ponds.find(p => !p.via && Math.abs(p.level - 1402.44) < 0.05);
  row("the east lobe stops at its saddle, above the FES, with no via",
      eastLobe ? eastLobe.level.toFixed(2) + " (" + eastLobe.depth_ft.toFixed(2) + " ft deep)" : "none",
      "1402.44, no via", !!eastLobe && wp && eastLobe.level > wp.level, "recorded from this commit");
  row("it never enters the impoundment", fr.ponds.some(p => p.cells > 200000) ? "yes" : "no", "no",
      !fr.ponds.some(p => p.cells > 200000), "exact");
  exact("reason", fr.reason, "nodata");
  dist("ends in Clear Lake", fr.end[0], fr.end[1], 6371177, 2127474, 3);
  near("overland length (recorded)", fr.length, RECORDED_GP_OVERLAND, 3, " ft");
  near("the west pond's depth at overflow (recorded)", wp ? wp.depth_ft : NaN, RECORDED_WP_DEPTH, 0.05, " ft");
  note("Frog Pond (east): " + fr.length.toFixed(1) + " ft overland + " + fr.pipeFt.toFixed(1) +
       " ft in pipe, " + fr.ponds.length + " ponds, " + fr.hops + " windows [" + fr.grids + "]. " +
       "East pond level " + fr.ponds[0].level.toFixed(2) + " (" + fr.ponds[0].depth_ft.toFixed(2) + " ft deep), " +
       "west pond level " + (wp ? wp.level.toFixed(2) + " (" + wp.depth_ft.toFixed(2) + " ft deep)" : "n/a"));
  budget("the Frog Pond drop (storm on)", frms, 20000);

  const froff = hostRun(M, fp.x, fp.y, false);
  exact("with the drains off, no legs", froff.legs.length, 0);
  row("with the drains off it leaves the survey to the north-east",
      "E " + froff.end[0].toFixed(0) + " N " + froff.end[1].toFixed(0), "E 6375216 N 2128916",
      Math.hypot(froff.end[0] - 6375216, froff.end[1] - 2128916) <= 3, "within 3 ft",
      "recorded from this commit; §1 predicts it spills north-east off the survey");
  near("with the drains off, overland (recorded)", froff.length, 1468.6, 3, " ft");

  console.log("\n§6.7  the Herman pipe discharge route (the plotted west end of the North pipe)");
  const pw = M.byId.herman_pipe_n_end;
  const hp = hostRun(M, pw.x, pw.y, true);
  const hpChain = ["pipe_to_main", "storm_main_upper", "storm_main_lower"];
  row("the chain it took", hp.legs.map(l => l.id).join(","), hpChain.join(","),
      hp.legs.map(l => l.id).join(",") === hpChain.join(","), "exact");
  near("pipe_ft = 13.2 + 194.7 + 588.9", hp.pipeFt, chain(hpChain), 0.5, " ft");
  dist("ends in Clear Lake", hp.end[0], hp.end[1], 6371177, 2127474, 3);
  near("overland length (recorded)", hp.length, 137.0, 1, " ft");
  note("Herman pipe discharge: " + hp.length.toFixed(1) + " ft overland + " +
       hp.pipeFt.toFixed(1) + " ft in pipe = " + (hp.length + hp.pipeFt).toFixed(1) + " ft to the lake");
  const hpoff = hostRun(M, pw.x, pw.y, false);
  near("with the drains off, overland (recorded)", hpoff.length, 1091.0, 3, " ft");
  exact("with the drains off, no legs", hpoff.legs.length, 0);

  /* ---- the Herman water-level shot (the ruling's own case) -------------- */
  /* The surveyed water-level shot of Aug 2026, inside the impoundment. With the
     network on, the pond stops at the LOWER of the two surveyed inverts and
     leaves through that pipe, the storm main and the outfall — which is what the
     overtopping tool has said since v10 §10 and what the raindrop could not say
     until the sunken-inlet rule. Recorded from this commit; the pipe total is
     arithmetic on the payload's conduit lengths. */
  console.log("\n§6.8  a raindrop inside the Herman Impoundment (the surveyed water-level shot)");
  const WL = [6372119.56, 2127446.20];
  const [hw, hwms] = timed(() => hostRun(M, WL[0], WL[1], true));
  const via = (hw.ponds.find(p => p.via) || {}).via || null;
  row("the impoundment drains through a surveyed pipe", via, "herman_pipe_s or _n",
      via === "herman_pipe_s" || via === "herman_pipe_n", "either");
  near("pond level = the lower surveyed invert", (hw.ponds.find(p => p.via) || {}).level,
       1341.5, 0.05, " ft");
  const hwChain = [via, "pipe_to_main", "storm_main_upper", "storm_main_lower"];
  row("the chain it took", hw.legs.map(l => l.id).join(","), hwChain.join(","),
      hw.legs.map(l => l.id).join(",") === hwChain.join(","), "exact");
  near("pipe_ft = 16.5 + 13.2 + 194.7 + 588.9", hw.pipeFt, chain(hwChain), 1, " ft");
  exact("it ends at the outfall",
        M.NET.conduits.find(c => c.id === hw.legs[hw.legs.length - 1].id).to, "outfall");
  exact("reason", hw.reason, "nodata");
  dist("then overland to Clear Lake", hw.end[0], hw.end[1], 6371177, 2127474, 3);
  near("overland length (recorded)", hw.length, 2637.5, 3, " ft");
  note("Herman water level: " + hw.length.toFixed(1) + " ft overland + " + hw.pipeFt.toFixed(1) +
       " ft in pipe, via " + via + ", pond " +
       (hw.ponds.find(p => p.via) || {}).level.toFixed(2) + " ft (" +
       (hw.ponds.find(p => p.via) || {}).depth_ft.toFixed(2) + " ft deep, " +
       (hw.ponds.find(p => p.via) || {}).cells + " cells)");
  budget("the Herman water-level drop (storm on)", hwms, 20000);

  const hwoff = hostRun(M, WL[0], WL[1], false);
  exact("with the drains off, no legs", hwoff.legs.length, 0);
  /* the impoundment, not the flat lidar water surface the drop starts on (which
     is also a large "pond", 0.34 ft deep, and comes first in trace order) */
  near("with the drains off it fills to the lidar rim (recorded)",
       (hwoff.ponds.find(p => p.cells > 200000 && p.depth_ft > 5) || {}).level, 1343.84, 0.02, " ft");
  near("with the drains off, overland (recorded)", hwoff.length, 3520.6, 3, " ft");
  note("Herman water level, drains off: " + hwoff.length.toFixed(1) + " ft overland, spills over the " +
       "1,343.84-ft rim; the 2.30-ft difference from the pipe invert is what the sunken-inlet rule buys");

  /* ---- a broken conduit is simply not passed --------------------------- */
  /* js/storm.js drops a "broken" conduit from conduitsFor(), so the kernel is
     never told about it — with EVERY conduit broken the analysis is bit for bit
     the ground-only one, and with only the first of a chain broken the water
     stays on the ground until it meets the next inlet downstream. */
  const allBrk = { ...M, conduitsFor: () => [] };
  const s8none = hostRun(allBrk, g8.x, g8.y, true);
  exact("every conduit broken: no legs", s8none.legs.length, 0);
  near("and reproduces the drains-off answer", s8none.length, s8off.length, 0.01, " ft");
  const brk = { ...M, conduitsFor: bbox => M.conduitsFor(bbox).filter(c => c.id !== "road_drain_8_9") };
  const s8b = hostRun(brk, g8.x, g8.y, true);
  row("one broken conduit is not used", s8b.legs.some(l => l.id === "road_drain_8_9") ? "used" : "skipped",
      "skipped", !s8b.legs.some(l => l.id === "road_drain_8_9"), "exact");
  row("and the water runs on to the next inlet downstream",
      s8b.legs.length ? s8b.legs[0].id : "none", "herman_pipe_s",
      !!s8b.legs.length && s8b.legs[0].id === "herman_pipe_s", "exact",
      "overland into the impoundment, then out through the surveyed pipe");
}

/* ======================= 11. WATER3D (v13 §4) ============================ */
/* docs/V13_WATER3D_SPEC.md §2/§4 — `overtop` gains the CONDUIT SPILL. The call
   site mirrored is js/water.js overtop(): the water polygon's bbox +/- 800 ft on
   SBMM.demForBox, plateauTol 0.3, rimRange 3, levelStep 0.25, and the conduit
   list from SBMM.storm.conduitsFor(bbox) — the same flattening the storm section
   above ports out of js/storm.js.

   The first check of every case is the IDENTITY: the conduit spill is ADDED
   beside the rim analysis and never in place of it, so `primary`, `clusters`,
   the band bytes, the spill mask, the storage and the area must be the
   no-conduit run's, field for field. Everything else in this file's water and
   storm sections is a golden measured on that run. */
function waterRing(name) {
  const gis = T.readJSON("data/design_gis.json");
  const f = gis.features.find(x => x.properties && x.properties.layer === "water" &&
                                   x.properties.name === name);
  if (!f) throw new Error('no water-layer feature named "' + name + '" in data/design_gis.json');
  return f.geometry.coordinates[0].map(q => [q[0], q[1]]);
}
/* js/water.js overtop(): one job, run twice — with the network and without */
function overtopPair(M, ring, opts) {
  opts = opts || {};
  const b = ring.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]),
                                   Math.max(a[2], p[0]), Math.max(a[3], p[1])],
                        [1e12, 1e12, -1e12, -1e12]);
  const pad = 800;
  const bbox = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  const dem = T.demForBox(bbox) || T.loadDem("dem_site");
  const base = { plateauTol: 0.3, rimRange: 3, levelStep: 0.25, maxClusters: 12,
                 seedRing: ring };
  if (opts.z0Override != null) base.z0Override = opts.z0Override;
  if (opts.levels) base.levels = opts.levels;
  const cds = M.conduitsFor(bbox);
  const A = C.runJob("overtop", Object.assign({ grid: T.gridSpec(dem, bbox, 0) }, base)).result;
  const B = C.runJob("overtop", Object.assign({ grid: T.gridSpec(dem, bbox, 0) }, base,
                     { conduits: cds, captureFt: 3 })).result;
  return { A, B, cds, dem, bbox };
}
const sameArr = (u, v) => u.length === v.length &&
  u.every((q, i) => q === v[i] || (Number.isNaN(q) && Number.isNaN(v[i])));
function identity(tag, A, B) {
  row(tag + ": primary", JSON.stringify(B.primary) === JSON.stringify(A.primary) ? "identical" : "DIFFER",
      "identical", JSON.stringify(B.primary) === JSON.stringify(A.primary), "field for field");
  row(tag + ": clusters", JSON.stringify(B.clusters) === JSON.stringify(A.clusters) ? "identical" : "DIFFER",
      "identical", JSON.stringify(B.clusters) === JSON.stringify(A.clusters), "field for field");
  row(tag + ": band bytes", sameArr(Array.from(A.band.v), Array.from(B.band.v)) ? "identical" : "DIFFER",
      "identical", sameArr(Array.from(A.band.v), Array.from(B.band.v)), "cell for cell");
  row(tag + ": spill mask", sameArr(Array.from(A.spillMask.v), Array.from(B.spillMask.v)) ? "identical" : "DIFFER",
      "identical", sameArr(Array.from(A.spillMask.v), Array.from(B.spillMask.v)), "cell for cell");
  near(tag + ": freeboard", B.freeboard_ft, A.freeboard_ft, 0, " ft");
  near(tag + ": storage", B.storage_ft3, A.storage_ft3, 0, " ft3");
  near(tag + ": area", B.area_ft2, A.area_ft2, 0, " ft2");
  near(tag + ": z0", B.z0, A.z0, 0, " ft");
  /* the stage table apart from the one row the conduit adds or tags */
  const strip = s => s.map(r => [+r.level.toFixed(6), +r.area_ft2.toFixed(6), +r.storage_ft3.toFixed(6)]);
  const extraRow = B.stage.length - A.stage.length;
  const bStripped = strip(B.stage.filter((r, i) => !(r.via && B.stage.length > A.stage.length)));
  row(tag + ": stage rows", B.stage.length, A.stage.length + extraRow,
      extraRow === 0 || extraRow === 1, "0 or 1 added");
  row(tag + ": stage levels/areas/storage", JSON.stringify(bStripped) === JSON.stringify(strip(A.stage))
        ? "identical" : "DIFFER", "identical",
      JSON.stringify(bStripped) === JSON.stringify(strip(A.stage)), "apart from the conduit row");
}
function secWater3d() {
  const M = stormModel();

  /* ---- §4, first bullet: Frog Pond ------------------------------------- */
  /* The defect this spec exists for: the rim spill is 10 ft from the culvert
     inlet and 0.30 ft above it, so without the conduit rule the overflow route
     runs north over the ground instead of into Green Pond. */
  console.log("\n§4.1  Frog Pond (the EAST pond) — the culvert under the paved road");
  const fp = overtopPair(M, waterRing("Frog Pond"));
  note("conduits in the window: " + fp.cds.map(c => c.id).join(", "));
  row("conduit spill id", fp.B.conduitSpill && fp.B.conduitSpill.id, "pond_culvert",
      !!fp.B.conduitSpill && fp.B.conduitSpill.id === "pond_culvert", "exact");
  near("first discharge level", fp.B.conduitSpill.level, 1415.74, 0.05, " ft");
  near("rim spill unchanged", fp.B.primary.level, 1416.04, 0.05, " ft");
  dist("rim spill cell", fp.B.primary.x, fp.B.primary.y, 6374410, 2127918, 15);
  dist("the conduit spill cell is the inlet", fp.B.conduitSpill.x, fp.B.conduitSpill.y,
       M.byId.frog_out.x, M.byId.frog_out.y, 3);
  near("freeboard to first discharge", fp.B.freeboardConduit_ft, fp.B.conduitSpill.level - fp.B.z0, 1e-9, " ft");
  row("the outlet is the culvert's own", "E " + fp.B.conduitSpill.outlet[0] + " N " + fp.B.conduitSpill.outlet[1],
      "E " + M.byId.frog_culvert_out.x + " N " + M.byId.frog_culvert_out.y,
      fp.B.conduitSpill.outlet[0] === M.byId.frog_culvert_out.x
      && fp.B.conduitSpill.outlet[1] === M.byId.frog_culvert_out.y, "exact");
  {
    const vr = fp.B.stage.find(s => s.via === "pond_culvert");
    row("one stage row carries the via", vr ? "yes" : "none", "yes", !!vr, "exact");
    if (vr) {
      near("the via row is at the conduit level", vr.level, fp.B.conduitSpill.level, 1e-9, " ft");
      row("and is an exact row", !!vr.extra, true, !!vr.extra, "exact");
      note("first discharge " + vr.level.toFixed(2) + " ft: " + (vr.area_ft2 / AC).toFixed(3) +
           " ac, " + (vr.storage_ft3 / AC).toFixed(2) + " ac-ft (recorded from this commit)");
      pct("via row storage (recorded)", vr.storage_ft3 / AC, 0.82, 2);
      pct("via row area (recorded)", vr.area_ft2 / AC, 1.135, 2);
    }
  }
  identity("Frog Pond", fp.A, fp.B);

  /* ---- §4, second bullet: Green Pond ----------------------------------- */
  console.log("\n§4.2  Green Pond (the WEST pond) — the FES on its west shore");
  const gp = overtopPair(M, waterRing("Green Pond"));
  row("conduit spill id", gp.B.conduitSpill && gp.B.conduitSpill.id, "green_outlet",
      !!gp.B.conduitSpill && gp.B.conduitSpill.id === "green_outlet", "exact");
  near("first discharge level", gp.B.conduitSpill.level, 1394.48, 0.05, " ft");
  near("= the lidar ground at the FES", gp.B.conduitSpill.level, M.rimFor("green_outlet_fes"), 1e-9, " ft");
  near("rim spill unchanged", gp.B.primary.level, 1399.14, 0.05, " ft");
  row("the first discharge is 4.6 ft below the rim spill",
      (gp.B.primary.level - gp.B.conduitSpill.level).toFixed(2), "> 4",
      gp.B.primary.level - gp.B.conduitSpill.level > 4, "the defect, in one number");
  identity("Green Pond", gp.A, gp.B);

  /* ---- §4, third bullet: Herman, with the §10 surveyed levels ---------- */
  /* Every §9.2/§10 number must be untouched, and the surveyed 1341.55 row must
     carry the via rather than a second row 0.02 ft under it. */
  console.log("\n§4.3  Herman Impoundment — the surveyed stages of §10, plus the via");
  const hm = overtopPair(M, hermanRing().map(q => [q[0], q[1]]),
                         { z0Override: 1336.45, levels: [1341.55, 1343.54] });
  near("z0 (surveyed override)", hm.B.z0, 1336.45, 1e-6, " ft");
  near("rim spill unchanged", hm.B.primary.level, 1343.84, 0.05, " ft");
  near("freeboard from surveyed water", hm.B.freeboard_ft, 7.39, 0.02, " ft");
  pct("storage to spill (surveyed z0)", hm.B.storage_ft3, 6998937, 0.5);
  row("conduit spill id", hm.B.conduitSpill && hm.B.conduitSpill.id, "herman_pipe_s",
      !!hm.B.conduitSpill && hm.B.conduitSpill.id === "herman_pipe_s", "exact");
  near("its level = the lower surveyed invert", hm.B.conduitSpill.level, 1341.53, 1e-9, " ft");
  near("it merges onto the surveyed row", hm.B.conduitSpill.stageLevel, 1341.55, 1e-9, " ft");
  exact("no duplicate row", hm.B.stage.length, hm.A.stage.length);
  {
    const vr = hm.B.stage.filter(s => s.via);
    exact("exactly one row carries a via", vr.length, 1);
    near("and it is the surveyed 1341.55", vr[0].level, 1341.55, 1e-9, " ft");
    pct("pipe stage storage unchanged", vr[0].storage_ft3 / AC, 109.16, 0.5);
    pct("pipe stage area unchanged", vr[0].area_ft2 / AC, 22.18, 0.5);
  }
  identity("Herman", hm.A, hm.B);

  /* ---- §4, fourth bullet: the stage rings ------------------------------- */
  /* The rings are what 2D fills and 3D builds its water surface from, so they
     have to close and to bound the area the same row reports. */
  console.log("\n§4.4  stage rings");
  {
    const sp = hm.B.stage.reduce((best, s) =>
      Math.abs(s.level - hm.B.primary.level) < Math.abs(best.level - hm.B.primary.level) ? s : best,
      hm.B.stage[0]);
    row("the rim-spill row has rings", sp.rings.length, ">= 1", sp.rings.length >= 1, "at least one");
    const closed = sp.rings.every(r => r.length > 3 &&
      Math.abs(r[0][0] - r[r.length - 1][0]) < 1e-6 && Math.abs(r[0][1] - r[r.length - 1][1]) < 1e-6);
    row("every ring closes", closed ? "closed" : "OPEN", "closed", closed, "first == last");
    /* outer rings first (traceMask sorts by area), so outer minus holes */
    const ar = sp.rings.map(polyArea);
    const net = ar[0] - ar.slice(1).reduce((a, v) => a + v, 0);
    pct("ring area = the row's area_ft2", net, sp.area_ft2, 2);
    note("rim-spill stage " + sp.level.toFixed(2) + " ft: " + sp.rings.length + " rings, " +
         (net / AC).toFixed(2) + " ac net against " + (sp.area_ft2 / AC).toFixed(2) + " ac");
  }

  /* ---- §4, fifth bullet: absent and empty ------------------------------- */
  /* The strongest statement in this section: with no network the v13 kernel is
     the v12 kernel, so every §9.2/§10 golden above is still a golden. */
  console.log("\n§4.5  the identity — conduits absent vs conduits: []");
  {
    const ring = hermanRing().map(q => [q[0], q[1]]);
    const b = ring.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]),
                                     Math.max(a[2], p[0]), Math.max(a[3], p[1])],
                          [1e12, 1e12, -1e12, -1e12]);
    const bbox = [b[0] - 800, b[1] - 800, b[2] + 800, b[3] + 800];
    const dem = T.demForBox(bbox) || T.loadDem("dem_site");
    const base = { plateauTol: 0.3, rimRange: 3, levelStep: 0.25, maxClusters: 12, seedRing: ring };
    const [E, ems] = timed(() => C.runJob("overtop",
      Object.assign({ grid: T.gridSpec(dem, bbox, 0) }, base, { conduits: [], captureFt: 3 })).result);
    const A = C.runJob("overtop", Object.assign({ grid: T.gridSpec(dem, bbox, 0) }, base)).result;
    row("conduitSpill is null", String(E.conduitSpill), "null", E.conduitSpill === null, "exact");
    row("freeboardConduit is null", String(E.freeboardConduit_ft), "null",
        E.freeboardConduit_ft === null, "exact");
    identity("empty list", A, E);
    row("no row carries a via", E.stage.filter(s => s.via).length, 0,
        E.stage.filter(s => s.via).length === 0, "exact");
    budget("overtop (conduits: [])", ems, 5000);
  }
}


/* ============================ 11. DRAINAGE =============================== */
/* docs/V14_DRAINAGE_SPEC.md §5. One label per cell: the outlet that cell drains
   to. The call sites mirrored are js/drainage.js jobFor() + conduitsForSite()
   (the whole `dem_site` grid, every conduit whose inlet is on the site, plus the
   one field a map needs and a run does not — `outfall`) and, for the identity,
   js/water.js traceRun() PINNED TO THE SITE GRID, because §3 runs the map on the
   2-ft site grid and the raindrop must be compared on the same ground.

   THE ACCEPTANCE TEST is the identity below: 100 seeded pseudo-random surveyed
   points, each traced by `flowpath` the way the app traces it, must land in the
   catchment the label raster draws under them. It is not a smoke test — the
   whole reason the map reuses the raindrop's physics is so that it cannot
   disagree, and a disagreement means the kernel is wrong. */

/* js/drainage.js conduitsForSite(): js/storm.js conduitsFor() over the whole
   site, plus `outfall` — true when the conduit discharges at an outfall node,
   which is where water leaves the model (§2 "Sink / inlet"). */
function drainConduits(M, grid) {
  const bbox = [grid.x0, grid.y0, grid.x0 + grid.w * grid.cell, grid.y0 + grid.h * grid.cell];
  return M.conduitsFor(bbox).map(c => {
    const rec = M.NET.conduits.find(q => q.id === c.id);
    const to = M.byId[rec.to];
    return { ...c, outfall: !!(to && to.kind === "outfall") };
  });
}
/* js/drainage.js lakeRing(): EA's own Clear Lake polygon, which is what splits
   "left the survey into the lake" from "left the survey somewhere else" */
function clearLakeRing() {
  const D = T.readJSON("data/design_gis.json");
  const f = D.features.find(q => (q.properties || {}).layer === "water"
                              && (q.properties || {}).name === "Clear Lake");
  return f ? f.geometry.coordinates[0].map(p => [p[0], p[1]]) : null;
}
/* js/jobs.js subGrid(): the site grid sampled every `s` cells — the field run */
function decimateGrid(g, s) {
  if (s <= 1) return g;
  const w = Math.ceil(g.sw / s), h = Math.ceil(g.sh / s);
  const z = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const src = Math.min(g.sh - 1, j * s) * g.sw;
    for (let i = 0; i < w; i++) z[j * w + i] = g.z[src + Math.min(g.sw - 1, i * s)];
  }
  return { x0: g.x0, y0: g.y0, cell: g.cell * s, w, h, i0: 0, j0: 0, sw: w, sh: h, z };
}
/* js/water.js traceRun(), pinned to ONE grid (§5: "on the same 2-ft site grid") */
function hostRunOn(M, dem, x, y, storm) {
  let cx = x, cy = y, hops = 0, prevReason = null, lengthSum = 0;
  const pts = [], ponds = [], legs = [], used = new Set();
  let reason = "steps", end = null;
  for (;;) {
    const half = dem.m.cell <= 1.0 ? 700 : 1400;
    const win = [cx - half, cy - half, cx + half, cy + half];
    const grid = T.gridSpec(dem, win, 0);
    if (!grid) { reason = "nodata"; break; }
    const cds = storm ? M.conduitsFor(win).filter(c => !used.has(c.id)) : [];
    const R = C.runJob("flowpath", { grid, x: cx, y: cy,
      conduits: cds.length ? cds : null, captureFt: 3 }).result;
    const skip = (pts.length && prevReason !== "conduit") ? 1 : 0;
    for (let i = skip; i < R.n; i++) pts.push([R.pts[i * 3], R.pts[i * 3 + 1]]);
    for (const lg of (R.legs || [])) { used.add(lg.id); legs.push(lg); }
    lengthSum += R.length_ft || 0;
    for (const p of R.ponds) ponds.push(p);
    prevReason = R.reason; reason = R.reason; end = R.end;
    if (R.reason !== "window" && R.reason !== "conduit") break;
    if (hops >= 7 || lengthSum >= 20000) { reason = "steps"; break; }
    const ex = R.exit;
    if (!ex) break;
    if (!dem.inside(ex[0], ex[1]) || Number.isNaN(dem.at(ex[0], ex[1]))) {
      reason = "nodata";
      if (R.reason === "conduit") { pts.push([ex[0], ex[1]]); end = [ex[0], ex[1], NaN]; }
      break;
    }
    cx = ex[0]; cy = ex[1]; hops++;
  }
  return { pts, reason, end, ponds, legs, hops, length: lengthSum };
}

/* §5, RECORDED FROM THIS COMMIT and thereafter asserted as regression guards.
   Every one of them is checkable by hand off the map: the three sinks partition
   the surveyed ground, the sum identity below proves the partition, and the pond
   levels are the raindrop's own (the §6 storm section measures the same three). */
const DRAIN_REC = {
  surveyed_ac: 978.49,
  lake_ac: 403.05, off_ac: 293.45, outfall_ac: 282.00,
  lake_off_ac: 521.28, off_off_ac: 457.21,      // with the drains off
  herman_level: 1341.53, herman_ac: 22.18, herman_contrib_ac: 37.90,
  frog_level: 1415.74, frog_contrib_ac: 14.52,
  green_level: 1394.50, green_depth: 3.08, green_contrib_ac: 2.62,
  herman_off_level: 1343.84
};

function secDrainage() {
  const AC = 43560;
  const site = T.loadDem("dem_site");
  const M = stormModel();
  const LR = clearLakeRing();
  const full = () => T.gridSpec(site, null, 0);
  const cds = drainConduits(M, full());

  console.log("\n§11.1  the whole-site map, 2-ft grid, storm drains on");
  const g2 = full();
  const [R, ms2] = timed(() => C.runJob("drainage",
    { grid: g2, conduits: cds, captureFt: 3, lakeRing: LR, stride: 1, maxPolys: 0 }).result);
  note(`${R.gw}x${R.gh} at ${R.cell} ft, ${(R.gw * R.gh / 1e6).toFixed(1)} M cells, `
     + `${R.pondsTotal} depressions, ${R.sinks.length} outlets, ${R.ponds.length} through-ponds, `
     + `${R.inlets.length} inlets`);
  budget("drainage, 2-ft site grid", ms2, 20000);

  /* the partition identity: every surveyed cell drains somewhere, exactly once */
  const sum = R.sinks.reduce((a, s) => a + s.cells, 0);
  exact("every surveyed cell has exactly one outlet", sum, R.surveyedCells);
  near("surveyed area (recorded)", R.surveyedArea_ft2 / AC, DRAIN_REC.surveyed_ac, 0.05, " ac");
  exact("no unresolved loops", R.loops, 0);
  exact("no unresolved flats", R.flats, 0);
  /* A one-cell "pond" on the grid whose every neighbour is higher is a genuine
     closed pit at this resolution, not a defect — it is reported as the sink it
     is, and what matters is that there are a handful of cells of them and not a
     region. (Before the uphill-parent fix these cells were half of a two-cell
     CYCLE instead, which is the thing that must never happen.) */
  row("closed one-cell depressions", R.pondSinks + " cells",
      "<= 8 cells", R.pondSinks <= 8, "at most 8",
      (R.pondSinks * R.cell * R.cell).toFixed(0) + " ft2 in total");

  const sinkOf = id => R.sinks.find(s => s.id === id);
  const kinds = R.sinks.map(s => s.kind).join(",");
  row("the outlets are the lake, the survey edge and the storm outfall",
      kinds, "lake,off,outfall", ["lake", "off", "outfall"].every(k => kinds.includes(k)), "contains");
  for (const [id, ref] of [["lake", DRAIN_REC.lake_ac], ["off", DRAIN_REC.off_ac],
                           ["outfall:storm_main_lower", DRAIN_REC.outfall_ac]]) {
    const s = sinkOf(id);
    row(id + " catchment (recorded)", s ? +(s.area_ft2 / AC).toFixed(2) : NaN, ref,
        !!s && Math.abs(s.area_ft2 / AC - ref) <= 0.5, "+/- 0.5 ac",
        s ? s.rings.length + " rings, longest path " + fmt(s.longest_ft) + " ft" : "missing");
  }

  /* §5: the ponds must be the raindrop's ponds — the same three the storm
     section measures through flowpath, to the same two decimals */
  console.log("\n§11.2  the named ponds are the raindrop's ponds");
  const pondNear = (x, y) => R.ponds.find(p => Math.hypot(p.entry[0] - x, p.entry[1] - y) < 400);
  const herman = R.ponds.find(p => p.via === "herman_pipe_s" || p.via === "herman_pipe_n");
  near("the impoundment's level = the lower surveyed invert", herman ? herman.level : NaN,
       DRAIN_REC.herman_level, 0.02, " ft");
  exact("and it leaves through the surveyed south pipe", herman ? herman.via : null, "herman_pipe_s");
  near("the impoundment's water surface (recorded)", herman ? herman.area_ft2 / AC : NaN,
       DRAIN_REC.herman_ac, 0.1, " ac");
  near("what drains into it (recorded)", herman ? herman.contributing_area_ft2 / AC : NaN,
       DRAIN_REC.herman_contrib_ac, 0.3, " ac");
  const frog = R.ponds.find(p => p.via === "pond_culvert");
  near("Frog Pond's level (the raindrop's 1415.74)", frog ? frog.level : NaN,
       DRAIN_REC.frog_level, 0.02, " ft");
  near("what drains into Frog Pond (recorded)", frog ? frog.contributing_area_ft2 / AC : NaN,
       DRAIN_REC.frog_contrib_ac, 0.3, " ac");
  const green = R.ponds.find(p => p.via === "green_outlet");
  near("Green Pond's level (the raindrop's 1394.50)", green ? green.level : NaN,
       DRAIN_REC.green_level, 0.02, " ft");
  near("Green Pond's depth at overflow (the §6 storm number)", green ? green.depth_ft : NaN,
       DRAIN_REC.green_depth, 0.05, " ft");
  near("what drains into Green Pond (recorded)", green ? green.contributing_area_ft2 / AC : NaN,
       DRAIN_REC.green_contrib_ac, 0.3, " ac");
  note("through-ponds, biggest first: " + R.ponds.slice(0, 6).map(p =>
    `${fmt(p.level, 2)} ft / ${(p.area_ft2 / AC).toFixed(2)} ac${p.via ? " via " + p.via : ""}`).join("; "));

  /* §5: what drains to each structure. On this site the answer is small and it
     is a FINDING, not a bug: the road ditch runs past the grates into the
     impoundment, and a 3-ft capture disc only takes the flow lines that cross
     it. `through_area` adds the ponds that pour into a structure, which is how
     the water actually reaches most of them. */
  console.log("\n§11.3  what drains to each storm structure");
  const inl = id => R.inlets.find(q => q.id === id);
  const grates = ["road_drain_8_9", "road_drain_9_10", "road_drain_10_11", "road_drain_11_12",
                  "road_drain_12_13", "road_drain_13_14", "road_drain_14_15", "road_drain_15_branch"];
  const gAc = grates.reduce((a, id) => a + ((inl(id) || {}).through_area_ft2 || 0), 0) / AC;
  note("the eight road-drain grates take " + gAc.toFixed(3) + " ac between them overland; "
     + "the road ditch runs past them into the impoundment, which then discharges "
     + "through the surveyed pipes — that is the site's answer, not a missing catchment");
  for (const id of ["pond_culvert", "green_outlet", "green_riser", "south_culvert", "herman_pipe_s"]) {
    const q = inl(id);
    note("  " + id.padEnd(16) + (q ? (q.through_area_ft2 / AC).toFixed(3) + " ac" : "no contributing area"));
  }
  /* the outfall's catchment IS everything that reaches it, by construction */
  const outf = sinkOf("outfall:storm_main_lower");
  const viaOutfall = R.ponds.filter(p => p.via && p.terminal === (outf || {}).label)
    .reduce((a, p) => a + p.contributing_area_ft2, 0) / AC;
  row("the ponds that pour into the storm system are inside the outfall's catchment",
      viaOutfall.toFixed(2), "<= " + (outf ? (outf.area_ft2 / AC).toFixed(2) : "n/a"),
      !!outf && viaOutfall <= outf.area_ft2 / AC + 0.01, "identity");

  /* ---- the identity (§5, first bullet) --------------------------------- */
  console.log("\n§11.4  THE IDENTITY — 100 raindrops against the label raster");
  /* the points: a seeded LCG over the site bbox, keeping surveyed ground, so the
     set is reproducible from this file alone */
  let seed = 20260904;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const PTS = [];
  while (PTS.length < 100) {
    const x = g2.x0 + rnd() * (g2.w - 1) * g2.cell;
    const y = g2.y0 + rnd() * (g2.h - 1) * g2.cell;
    const i = Math.round((x - g2.x0) / g2.cell), j = Math.round((y - g2.y0) / g2.cell);
    if (Number.isNaN(g2.z[j * g2.w + i])) continue;
    PTS.push([g2.x0 + i * g2.cell, g2.y0 + j * g2.cell]);
  }
  const labAt = (x, y) => {
    const i = Math.round((x - R.x0) / R.cell), j = Math.round((y - R.y0) / R.cell);
    if (i < 0 || j < 0 || i >= R.gw || j >= R.gh) return "(outside)";
    const v = R.labels[j * R.gw + i];
    return v < 0 ? "(nodata)" : ((R.sinks.find(s => s.label === v) || {}).id || "#" + v);
  };
  const inLake = (x, y) => LR && (pointInPoly(x, y, LR) || ringDist(x, y, LR) <= 10);
  const t0 = Date.now();
  let agree = 0, truncated = 0;
  const bad = [], keep = [];
  for (let q = 0; q < PTS.length; q++) {
    const [x, y] = PTS[q];
    const D = hostRunOn(M, site, x, y, true);
    keep.push(D);
    const lastLeg = D.legs.length ? D.legs[D.legs.length - 1] : null;
    const lastC = lastLeg ? cds.find(c => c.id === lastLeg.id) : null;
    let got;
    if (lastC && lastC.outfall) got = "outfall:" + lastC.id;
    else if (D.reason === "nodata" || D.reason === "window")
      got = inLake(D.end[0], D.end[1]) ? "lake" : "off";
    else if (D.reason === "steps") {
      /* the host stops a run at 8 windows / 20,000 ft; it has not reached a sink,
         so what it can still say is that as far as it got, the map keeps it in
         the same catchment. That is the same claim, made over a shorter path. */
      truncated++;
      got = labAt(D.end[0], D.end[1]);
    } else got = D.reason;
    const want = labAt(x, y);
    if (got === want) agree++;
    else bad.push(`#${q} E${x.toFixed(0)} N${y.toFixed(0)}: the drop says ${got}, `
                + `the map says ${want} (reason ${D.reason}, ${D.hops} windows, `
                + `legs ${D.legs.map(l => l.id).join(">") || "-"})`);
  }
  const ms = Date.now() - t0;
  row("raindrops that land in their own catchment", agree, ">= 97", agree >= 97, "97 of 100",
      truncated + " of them hit the host's window cap and were compared where they stopped");
  for (const b of bad) note("DISAGREE " + b);
  budget("100 raindrops (flowpath, chained)", ms, 240000);

  /* the first capture the drop meets is the first-capture label under it */
  const firstAt = (x, y) => {
    const i = Math.round((x - R.x0) / R.cell), j = Math.round((y - R.y0) / R.cell);
    if (i < 0 || j < 0 || i >= R.gw || j >= R.gh) return -1;
    return R.first[j * R.gw + i];
  };
  /* §5, second half: the map's first capture at the drop is the FIRST conduit
     the drop itself goes down. A first-capture record is either an inlet (its
     own conduit) or a pond that pours into one (`via`); a pond with no `via`
     spills over the ground and names no conduit, so those points say nothing
     about the network and are not counted. */
  let capChecked = 0, capOk = 0;
  const capBad = [];
  for (let q = 0; q < PTS.length; q++) {
    const rec = ((lab) => {
      const p = R.ponds.find(z => z.label === lab);
      if (p) return p.via;
      const i2 = R.inlets.find(z => z.label === lab);
      return i2 ? i2.id : null;
    })(firstAt(PTS[q][0], PTS[q][1]));
    if (!rec) continue;
    capChecked++;
    const legs = keep[q].legs;
    if (legs.length && legs[0].id === rec) capOk++;
    else capBad.push(`#${q}: the map's first capture is ${rec}, the drop's first leg is `
                   + (legs.length ? legs[0].id : "none"));
  }
  row("the first conduit a drop goes down is its first-capture label",
      capOk + " of " + capChecked, ">= " + Math.max(0, capChecked - 2),
      capOk >= capChecked - 2, "at most 2 off",
      "over the 100 points, those whose first capture names a conduit at all");
  for (const b of capBad) note("FIRST-CAPTURE " + b);

  /* ---- the drains off (§5, fourth bullet) ------------------------------ */
  console.log("\n§11.5  the same map with the storm drains off");
  const [Roff, msOff] = timed(() => C.runJob("drainage",
    { grid: full(), conduits: null, lakeRing: LR, stride: 1, maxPolys: 0 }).result);
  exact("no inlet sinks", Roff.sinks.filter(s => s.kind === "outfall").length, 0);
  exact("no conduits reported", Roff.conduits, 0);
  exact("still a partition", Roff.sinks.reduce((a, s) => a + s.cells, 0), Roff.surveyedCells);
  exact("the surveyed ground is the same ground", Roff.surveyedCells, R.surveyedCells);
  const offLake = Roff.sinks.find(s => s.id === "lake"), offOff = Roff.sinks.find(s => s.id === "off");
  near("Clear Lake, drains off (recorded)", offLake ? offLake.area_ft2 / AC : NaN,
       DRAIN_REC.lake_off_ac, 0.5, " ac");
  near("off-survey, drains off (recorded)", offOff ? offOff.area_ft2 / AC : NaN,
       DRAIN_REC.off_off_ac, 0.5, " ac");
  /* the impoundment, not the flat 32-ac pond that comes first by area (the same
     "cells > 200000 AND deeper than 5 ft" the §6 storm section uses) */
  const hOff = Roff.ponds.find(p => p.cells > 200000 && p.depth_ft > 5);
  near("the impoundment fills to the lidar rim instead (v12's 1343.84)",
       hOff ? hOff.level : NaN, DRAIN_REC.herman_off_level, 0.02, " ft");
  note("with the drains off the outfall's " + DRAIN_REC.outfall_ac + " ac go to the lake "
     + "(+" + (DRAIN_REC.lake_off_ac - DRAIN_REC.lake_ac).toFixed(2) + " ac) and off the survey "
     + "(+" + (DRAIN_REC.off_off_ac - DRAIN_REC.off_ac).toFixed(2) + " ac): the impoundment "
     + "spills over its 1,343.84-ft rim rather than through the pipes");
  budget("drainage, drains off", msOff, 20000);

  /* ---- the 4-ft field run (§3, §5 last bullet) ------------------------- */
  console.log("\n§11.6  the field build's 4-ft run");
  const g4 = decimateGrid(full(), 2);
  const cds4 = drainConduits(M, g4);
  const [R4, ms4] = timed(() => C.runJob("drainage",
    { grid: g4, conduits: cds4, captureFt: 3, lakeRing: LR, stride: 1, maxPolys: 0 }).result);
  exact("the 4-ft run is a 4-ft run", R4.cell, 4);
  budget("drainage, 4-ft site grid", ms4, 6000);
  exact("still a partition", R4.sinks.reduce((a, s) => a + s.cells, 0), R4.surveyedCells);
  /* the pointer field has to be acyclic at EVERY resolution, not just the one it
     was developed on: at 4 ft a one-cell "pond" (the filled DEM rounding, not a
     depression) was reached by the flood from ground above its own level, so its
     `parent` pointed uphill and it and its neighbour pointed at each other. */
  exact("no unresolved loops at 4 ft", R4.loops, 0);
  exact("no unresolved flats at 4 ft", R4.flats, 0);
  note("closed one-cell depressions at 4 ft: " + R4.pondSinks
     + " (a genuine pit with no lower neighbour on a 4-ft grid, reported as a sink)");
  let worst = 0, worstId = "";
  for (const s of R.sinks) {
    if (s.area_ft2 < AC) continue;
    const t = R4.sinks.find(q => q.id === s.id);
    const d = t ? Math.abs(t.area_ft2 - s.area_ft2) / s.area_ft2 * 100 : 100;
    if (d > worst) { worst = d; worstId = s.id; }
    note("  " + s.id.padEnd(26) + (s.area_ft2 / AC).toFixed(2).padStart(8) + " ac at 2 ft, "
       + (t ? (t.area_ft2 / AC).toFixed(2) : "missing").padStart(8) + " ac at 4 ft ("
       + d.toFixed(2) + " %)");
  }
  row("every outlet over an acre agrees between 2 ft and 4 ft", worst.toFixed(2) + " % (" + worstId + ")",
      "<= 3 %", worst <= 3, "+/- 3 %");
  const h4 = R4.ponds.find(p => p.via === "herman_pipe_s" || p.via === "herman_pipe_n");
  near("the impoundment still leaves at the surveyed invert at 4 ft",
       h4 ? h4.level : NaN, DRAIN_REC.herman_level, 0.05, " ft");

  /* ---- the output rasters and the polygons ----------------------------- */
  console.log("\n§11.7  the output rasters, decimated");
  const Rs = C.runJob("drainage",
    { grid: full(), conduits: cds, captureFt: 3, lakeRing: LR, stride: 4 }).result;
  exact("the label raster is decimated by the stride", Rs.stride, 4);
  exact("its width", Rs.w, Math.ceil(R.gw / 4));
  exact("labels and first are the same shape", Rs.first.length, Rs.labels.length);
  near("the areas are the FULL-resolution counts, not the decimated ones",
       Rs.surveyedCells, R.surveyedCells, 0, " cells");
  const polys = Rs.sinks.reduce((a, s) => a + s.rings.length, 0);
  row("the by-outlet layer has enough polygons to be a map", polys, ">= 12", polys >= 12, ">= 12");
  const firstPolys = Rs.ponds.reduce((a, p) => a + p.contributing_rings.length, 0)
                   + Rs.inlets.reduce((a, q) => a + q.rings.length, 0);
  row("and so does the by-first-capture layer", firstPolys, ">= 8", firstPolys >= 8, ">= 8");
  row("every sink carries its longest flow path",
      Rs.sinks.filter(s => s.path && s.path.length > 1).length, Rs.sinks.length,
      Rs.sinks.every(s => s.path && s.path.length > 1), "exact");
}

/* ============================ 12. RUNOFF ================================= */
/* docs/V14_PHASE2_RUNOFF_SPEC.md §3. A design storm over the Phase 1
   catchments. The call sites mirrored are js/runoff.js jobFor() (the class
   table out of data/cover.json, the overrides, the storm and the ARI's own
   depth curve out of data/rainfall.json, the catchments out of the `drainage`
   kernel with their paths lifted onto SBMM.elev) and js/runoff.js routeOne()
   (level-pool, ported below because the routing lives on the host).

   Every reference here is one of three things and says which: TR-55's own
   equation restated (the curve-number identity, the sheet-flow and shallow-
   concentrated arithmetic), an exact arithmetic identity of the kernel's own
   construction (the unit hydrograph's volume and peak, the routing's volume
   balance), or a value RECORDED FROM THIS COMMIT as a regression guard. */

function coverRasterN() {
  if (coverRasterN._c) return coverRasterN._c;
  const meta = T.readJSON("data/cover.json");
  const png = path.join(REPO, "data", "cover.png");
  if (!fs.existsSync(png)) throw new Error("data/cover.png is missing — run tools/build_cover.py");
  const st = fs.statSync(png);
  const cdir = path.join(HERE, ".cache");
  const cf = path.join(cdir, `cover_${st.size}_${Math.round(st.mtimeMs)}.bin`);
  const n = meta.grid.w * meta.grid.h;
  let data = null;
  if (fs.existsSync(cf) && fs.statSync(cf).size === n) data = new Uint8Array(fs.readFileSync(cf));
  if (!data) {
    const img = decodePNG(fs.readFileSync(png));
    if (img.w !== meta.grid.w || img.h !== meta.grid.h)
      throw new Error(`cover.png is ${img.w}x${img.h} but cover.json says ${meta.grid.w}x${meta.grid.h}`);
    const key = new Map();
    for (const c of meta.classes) key.set((c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2], c.id);
    data = new Uint8Array(n);
    for (let r = 0; r < img.h; r++) {
      const dst = (img.h - 1 - r) * img.w;              // PNG row 0 = north
      for (let i = 0; i < img.w; i++) {
        const k = (r * img.w + i) * img.channels;
        const id = key.get((img.data[k] << 16) | (img.data[k + 1] << 8) | img.data[k + 2]);
        data[dst + i] = id == null ? 0 : id;
      }
    }
    try { fs.mkdirSync(cdir, { recursive: true }); fs.writeFileSync(cf, Buffer.from(data)); } catch (e) {}
  }
  coverRasterN._c = { meta,
    cover: { data, w: meta.grid.w, h: meta.grid.h, cell: meta.grid.cell,
             x0: meta.grid.x0, y0: meta.grid.y0 } };
  return coverRasterN._c;
}

/* js/runoff.js depthFor()/idfFor() — the rainfall payload, read the same way */
function rainTable() { return T.readJSON("data/rainfall.json"); }
function depthFor(rain, ari, hours) {
  const pts = [];
  for (const k of rain.durations) {
    const row = rain.table[k];
    const v = row && row.depths ? row.depths[String(ari)] : null;
    if (v != null) pts.push([row.hours, +v]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  for (const p of pts) if (Math.abs(p[0] - hours) < 1e-9) return p[1];
  if (pts.length < 2) return pts.length ? pts[0][1] : NaN;
  let a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length; i++) {
    if (hours <= pts[i][0]) { a = pts[i - 1]; b = pts[i]; break; }
    if (i === pts.length - 1) { a = pts[i - 1]; b = pts[i]; }
  }
  const t = (Math.log(hours) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
  return Math.exp(Math.log(a[1]) + t * (Math.log(b[1]) - Math.log(a[1])));
}
function idfFor(rain, ari) {
  const out = [];
  for (const k of rain.durations) {
    const row = rain.table[k];
    const v = row && row.depths ? row.depths[String(ari)] : null;
    if (v != null) out.push([row.hours, +v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
/* js/runoff.js jobFor() */
function runoffJobFor(labels, cats, o) {
  o = o || {};
  const { meta, cover } = coverRasterN();
  const rain = rainTable();
  const grass = meta.classes.find(c => c.key === "grass");
  const ari = o.ari == null ? 25 : o.ari;
  const hours = o.hours == null ? 24 : o.hours;
  return {
    labels, cover: o.cover === null ? null : cover,
    classes: meta.classes.map(c => ({ id: c.id, key: c.key, hsg: c.hsg, c: c.c,
                                      n_sheet: c.n_sheet, paved: c.paved, cn: c.cn })),
    hsgOf: o.hsgOf || {}, overrides: o.overrides || [],
    catchments: cats,
    storm: { name: ari + "-year, " + hours + "-hour",
             P_in: o.P == null ? depthFor(rain, ari, hours) : o.P,
             duration_h: hours, dt_min: 6, distName: o.dist || "IA",
             dist: rain.distributions[o.dist || "IA"] },
    idf: idfFor(rain, ari), P2_24_in: depthFor(rain, 2, 24),
    defaultClass: grass ? grass.id : -1,
    sheetMax_ft: 100, channelStart_ac: 5, channelN: 0.035, channelR_ft: 1.0,
    minTc_min: 6, rationalMaxAc: 200
  };
}

/* js/runoff.js routeOne() — level-pool (Modified Puls) with the step solved by
   bisection, which is what makes the volume balance exact rather than nearly */
function routeOneRef(spec) {
  const { stage, rimLevel, conduitLevel, inflow, dtMin, weirLen } = spec;
  const dt = dtMin * 60, WEIR_C = 3.0;
  const interp = (level, key) => {
    if (level <= stage[0].level) return 0;
    for (let i = 1; i < stage.length; i++)
      if (level <= stage[i].level) {
        const t = (level - stage[i - 1].level) / ((stage[i].level - stage[i - 1].level) || 1e-9);
        return stage[i - 1][key] + t * (stage[i][key] - stage[i - 1][key]);
      }
    const top = stage[stage.length - 1];
    return key === "storage_ft3" ? top.storage_ft3 + (level - top.level) * top.area_ft2 : top.area_ft2;
  };
  const levelFor = S => {
    let lo = stage[0].level, hi = stage[stage.length - 1].level + 100;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (interp(m, "storage_ft3") < S) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const outQ = l => (rimLevel != null && l > rimLevel)
    ? WEIR_C * Math.max(1, weirLen) * Math.pow(l - rimLevel, 1.5) : 0;
  let S = 0, level = stage[0].level, O = 0, volIn = 0, volOut = 0;
  let peakLevel = level, peakT = 0, overT = null, conduitT = null, peakO = 0;
  for (let i = 1; i < inflow.length; i++) {
    const I0 = inflow[i - 1], I1 = inflow[i], pass = I1;
    const f = Sx => {
      const lx = levelFor(Sx);
      const Ox = outQ(lx) + (conduitLevel != null && lx >= conduitLevel ? pass : 0);
      return Sx - S - dt * ((I0 + I1) / 2 - (O + Ox) / 2);
    };
    let lo = Math.max(0, S - dt * (O + 1)), hi = S + dt * (I0 + I1 + 1);
    for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; }
    const Sn = (lo + hi) / 2, ln = levelFor(Sn);
    const On = outQ(ln) + (conduitLevel != null && ln >= conduitLevel ? pass : 0);
    volIn += dt * (I0 + I1) / 2; volOut += dt * (O + On) / 2;
    S = Sn; level = ln; O = On;
    if (level > peakLevel) { peakLevel = level; peakT = i * dtMin / 60; }
    if (O > peakO) peakO = O;
    if (overT == null && rimLevel != null && level > rimLevel) overT = i * dtMin / 60;
    if (conduitT == null && conduitLevel != null && level >= conduitLevel) conduitT = i * dtMin / 60;
  }
  return { peakLevel, peakT, peakOut: peakO, overtops: overT != null, overtopT: overT,
           throughConduit: conduitT != null, volIn, volOut, dS: S,
           balance: volIn > 0 ? (volIn - volOut - S) / volIn : 0 };
}

/* js/water.js stageTable() — the same job overtop() builds, headless */
function stageForRing(M, ring, name, opts) {
  opts = opts || {};
  const b = ring.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]),
                                   Math.max(a[2], p[0]), Math.max(a[3], p[1])],
                        [1e12, 1e12, -1e12, -1e12]);
  const pad = 800;
  const bbox = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  const dem = T.demForBox(bbox) || T.loadDem("dem_site");
  const job = { grid: T.gridSpec(dem, bbox, 0), plateauTol: 0.3, rimRange: 3,
                levelStep: 0.25, maxClusters: 12, seedRing: ring };
  const cds = M.conduitsFor(bbox);
  if (cds.length) { job.conduits = cds; job.captureFt = 3; }
  if (opts.z0Override != null) job.z0Override = opts.z0Override;
  if (opts.levels) job.levels = opts.levels;
  const R = C.runJob("overtop", job).result;
  R.name = name;
  return R;
}

/* §3(f), RECORDED FROM THIS COMMIT and thereafter asserted as regression
   guards. The 25-year 24-hour storm at the PROVISIONAL depth of 6.4 in over
   the Phase 1 catchments; if the Atlas 14 export replaces the provisional
   table these move, and they should — re-record them and say so. */
/* §3(g), recorded from this commit: the cover split the curve numbers rest on.
   Re-record it whenever tools/build_cover.py changes a threshold or a source. */
const COVER_REC = {
  water: 26.16, paved: 11.90, roof: 6.22, gravel: 37.75,
  waste: 11.11, bare: 167.52, grass: 660.87, woods: 56.97
};

const RUNOFF_REC = {
  /* the storm: the PROVISIONAL 25-year 24-hour depth, NRCS Type IA, over the
     Phase 1 catchments sampled at 8 ft. Replace data/atlas14_sbmm.csv and every
     one of these moves — re-record them and say so in the commit. */
  P_in: 6.4, area_ac: 978.49, cn: 82.2, volume_acft: 356.69, qPeak_cfs: 1396.3,
  outlets: {
    /* id: volume (ac-ft) and the SCS peak (cfs). All three are over 200 ac, so
       the Rational method is not reported for any of them — the rule doing its
       job rather than a missing number. */
    "lake": { vol: 146.49, peak: 565.4 },
    "off": { vol: 103.87, peak: 428.6 },
    "outfall:storm_main_lower": { vol: 106.34, peak: 425.0 }
  },
  ponds: {
    /* rim and conduit are the v13 goldens (they are the `overtop` kernel's, not
       this storm's); peak is the routed stage, recorded from this commit.
       NONE of the three overtops in the 25-year storm — the impoundment does
       not even reach its surveyed 1,341.55-ft discharge invert, and Frog Pond
       leaves through its culvert 0.29 ft below the rim. */
    "herman_pipe_s": { rim: 1343.84, conduit: 1341.55, peak: 1337.27, overtops: false },
    "pond_culvert": { rim: 1416.04, conduit: 1415.74, peak: 1415.75, overtops: false },
    "green_outlet": { rim: 1399.14, conduit: 1394.50, peak: 1393.11, overtops: false }
  }
};

function secRunoff() {
  const rain = rainTable();
  const { meta } = coverRasterN();
  console.log("\n§12.1  the curve-number arithmetic (TR-55 / NEH-630 ch. 10)");
  /* (a) the identity itself: Q = (P - 0.2S)^2 / (P + 0.8S), S = 1000/CN - 10.
     A synthetic one-class catchment through the kernel must reproduce it.

     A SPEC CORRECTION, accepted by the planner: §3(a) prints 2.17 in for
     P = 4.0 / CN = 85. That is a transcription error — the value does not
     satisfy the equation (2.17 is the answer for CN ~ 81.4), and the equation
     gives 2.458. The equation is the authority and both the kernel and the
     reference below use it; the spec's other number, CN 70 -> 1.33 in, agrees
     exactly. */
  const cnQ = (P, cn) => { const S = 1000 / cn - 10; return (P - 0.2 * S) ** 2 / (P + 0.8 * S); };
  for (const cn of [85, 70]) {
    const cls = [{ id: 0, key: "nodata", cn: { C: null, D: null }, hsg: null, c: null, n_sheet: null, paved: 0 },
                 { id: 1, key: "x", cn: { C: cn, D: cn }, hsg: "C", c: 0.5, n_sheet: 0.15, paved: 0 }];
    const w = 40, h = 40, cell = 10;
    const lab = new Int32Array(w * h).fill(7);
    const cov = new Uint8Array(w * h).fill(1);
    const area = w * h * cell * cell;
    const J = { labels: { data: lab, w, h, cell, x0: 0, y0: 0 },
                cover: { data: cov, w, h, cell, x0: 0, y0: 0 },
                classes: cls, catchments: [{ label: 7, name: "synthetic", area_ft2: area, path: [] }],
                storm: { name: "P=4", P_in: 4.0, duration_h: 24, dt_min: 6,
                         dist: rain.distributions.uniform },
                idf: [[1, 1], [24, 4]], P2_24_in: 3.3, defaultClass: 1 };
    const c = C.runJob("runoff", J).result.catchments[0];
    near("Q at P 4.0 in, CN " + cn, +c.Q_in.toFixed(4), +cnQ(4.0, cn).toFixed(4), 0.01, " in");
    near("  its composite CN", c.cn, cn, 0, "");
  }
  /* (b) the composite CN of a two-class catchment is the area-weighted value */
  {
    const cls = [{ id: 0, key: "nodata", cn: { C: null, D: null }, hsg: null, c: null, n_sheet: null, paved: 0 },
                 { id: 1, key: "a", cn: { C: 98, D: 98 }, hsg: "C", c: 0.95, n_sheet: 0.011, paved: 1 },
                 { id: 2, key: "b", cn: { C: 79, D: 84 }, hsg: "C", c: 0.35, n_sheet: 0.15, paved: 0 }];
    const w = 100, h = 100, cell = 10;
    const lab = new Int32Array(w * h).fill(3);
    const cov = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) cov[j * w + i] = i < 30 ? 1 : 2;
    const area = w * h * cell * cell;
    const J = { labels: { data: lab, w, h, cell, x0: 0, y0: 0 },
                cover: { data: cov, w, h, cell, x0: 0, y0: 0 }, classes: cls,
                catchments: [{ label: 3, name: "two-class", area_ft2: area, path: [] }],
                storm: { name: "P=4", P_in: 4.0, duration_h: 24, dt_min: 6, dist: rain.distributions.uniform },
                idf: [[1, 1], [24, 4]], P2_24_in: 3.3, defaultClass: 2 };
    const R2 = C.runJob("runoff", J).result.catchments[0];
    near("composite CN, 30 % paved + 70 % grass", R2.cn, 0.3 * 98 + 0.7 * 79, 0.001, "");
    near("  and the Rational C with it", R2.rationalC, 0.3 * 0.95 + 0.7 * 0.35, 0.001, "");
    near("  class shares add to 1", R2.classes.reduce((a, k) => a + k.frac, 0), 1, 1e-9, "");
    /* the same catchment with an override ring over all of it is one class */
    const ring = [[-100, -100], [3000, -100], [3000, 3000], [-100, 3000]];
    const R3 = C.runJob("runoff", Object.assign({}, J, { overrides: [{ ring, cls: 1 }] })).result.catchments[0];
    near("an override ring makes it all paved", R3.cn, 98, 0.001, "");
  }

  console.log("\n§12.2  time of concentration (TR-55 ch. 3) on a 500-ft path");
  /* (c) sheet flow over the first 100 ft, shallow concentrated over the rest;
     the reference is TR-55's own arithmetic, written out. */
  {
    const cls = [{ id: 0, key: "nodata", cn: { C: null, D: null }, hsg: null, c: null, n_sheet: null, paved: 0 },
                 { id: 7, key: "grass", cn: { C: 79, D: 84 }, hsg: "C", c: 0.35, n_sheet: 0.15, paved: 0 }];
    const w = 60, h = 20, cell = 10;
    const lab = new Int32Array(w * h).fill(5);
    const cov = new Uint8Array(w * h).fill(7);
    const path = [];
    for (let k = 0; k <= 10; k++) path.push([k * 50, 0, 100 - 0.02 * k * 50]);   // 500 ft at 2 %
    const area = 0.5 * AC;                       // small: never reaches the 5-ac channel rule
    const J = { labels: { data: lab, w, h, cell, x0: 0, y0: 0 },
                cover: { data: cov, w, h, cell, x0: 0, y0: 0 }, classes: cls,
                catchments: [{ label: 5, name: "500-ft path", area_ft2: area, path }],
                storm: { name: "P=4", P_in: 4.0, duration_h: 24, dt_min: 6, dist: rain.distributions.uniform },
                idf: [[1, 1], [24, 4]], P2_24_in: 3.3, defaultClass: 7,
                sheetMax_ft: 100, channelStart_ac: 5, minTc_min: 6 };
    const c = C.runJob("runoff", J).result.catchments[0];
    const s = 0.02, P2 = 3.3;
    const tSheet = 0.007 * Math.pow(0.15 * 100, 0.8) / (Math.pow(P2, 0.5) * Math.pow(s, 0.4));
    const vSc = 16.1345 * Math.sqrt(s);
    const tSc = 400 / (3600 * vSc);
    const segs = c.tcSegments;
    exact("segments", segs.length, 2);
    exact("  the first is sheet flow", segs[0].kind, "sheet");
    near("  sheet 100 ft, TR-55 eq 3-3", segs[0].t_min, tSheet * 60, 0.02, " min");
    exact("  the second is shallow concentrated", segs[1].kind, "shallow");
    near("  unpaved velocity 16.1345*sqrt(s)", segs[1].v_fps, vSc, 0.01, " fps");
    near("  400 ft of it", segs[1].t_min, tSc * 60, 0.02, " min");
    near("Tc = the sum of the segments", c.tc_min, (tSheet + tSc) * 60, 0.03, " min");
    /* a big catchment on the same path goes into channel flow, and its Tc is
       shorter for it — the 5-acre rule, doing what it is for */
    const big = C.runJob("runoff", Object.assign({}, J, {
      catchments: [{ label: 5, name: "big", area_ft2: 200 * AC, path }] })).result.catchments[0];
    row("200 ac on the same path uses channel flow",
        big.tcSegments.map(q => q.kind).join(">"), "sheet>channel",
        big.tcSegments.some(q => q.kind === "channel"), "contains channel");
    row("  and its Tc is shorter", fmt(big.tc_min) + " min", "< " + fmt(c.tc_min) + " min",
        big.tc_min < c.tc_min, "identity");
  }

  console.log("\n§12.3  the SCS unit hydrograph");
  /* (d) volume = Q x A within 1 %, peak = 484*A*Q/Tp within 1 % */
  {
    const cls = [{ id: 0, key: "nodata", cn: { C: null, D: null }, hsg: null, c: null, n_sheet: null, paved: 0 },
                 { id: 7, key: "grass", cn: { C: 80, D: 84 }, hsg: "C", c: 0.35, n_sheet: 0.15, paved: 0 }];
    const w = 50, h = 50, cell = 20;
    const lab = new Int32Array(w * h).fill(2);
    const cov = new Uint8Array(w * h).fill(7);
    const path = [];
    for (let k = 0; k <= 20; k++) path.push([k * 200, 0, 200 - 0.03 * k * 200]);   // 4,000 ft at 3 %
    const area = 40 * AC;
    const J = { labels: { data: lab, w, h, cell, x0: 0, y0: 0 },
                cover: { data: cov, w, h, cell, x0: 0, y0: 0 }, classes: cls,
                catchments: [{ label: 2, name: "uh", area_ft2: area, path }],
                storm: { name: "25-yr 24-h", P_in: 6.4, duration_h: 24, dt_min: 6,
                         dist: rain.distributions.IA },
                idf: idfFor(rain, 25), P2_24_in: depthFor(rain, 2, 24), defaultClass: 7 };
    const c = C.runJob("runoff", J).result.catchments[0];
    const dtH = c.hydro.dt_min / 60;
    const uhVol = c.uh.q.reduce((a, b) => a + b, 0) * dtH * 3600;
    pct("unit hydrograph volume = 1 in over the area", uhVol, area / 12, 1);
    const uhPeak = Math.max.apply(null, c.uh.q) * c.Q_in;
    pct("its peak x Q = 484*A*Q/Tp", uhPeak, 484 * (c.area_ac / 640) * c.Q_in / c.tp_h, 1);
    const hVol = c.hydro.q.reduce((a, b) => a + b, 0) * dtH * 3600;
    pct("the storm hydrograph's volume = Q x A", hVol, c.volume_ft3, 1);
    row("and the storm peak is at or below the single-burst peak",
        fmt(c.qPeak_cfs) + " cfs", "<= " + fmt(c.qUH_cfs) + " cfs",
        c.qPeak_cfs <= c.qUH_cfs * 1.001, "identity");
    note(`Tc ${c.tc_min} min, Tp ${c.tp_h} h, step ${fmt(c.hydro.dt_min, 2)} min, `
       + `Q ${fmt(c.Q_in, 2)} in over ${fmt(c.area_ac, 1)} ac`);
  }

  console.log("\n§12.4  level-pool routing conserves volume");
  /* (e) a prismatic pond with a known stage-storage: with the rim above every
     stage nothing leaves and the storage IS the inflow volume; with the rim
     inside the range the balance still closes. */
  {
    const A0 = 10000;                                   // ft2, constant area
    const stage = [];
    for (let k = 0; k <= 480; k++) stage.push({ level: k * 0.25, area_ft2: A0, storage_ft3: k * 0.25 * A0 });
    const dtMin = 6;
    const inflow = [];
    for (let i = 0; i <= 240; i++) inflow.push(i < 60 ? i * 0.5 : Math.max(0, 30 - (i - 60) * 0.25));
    const dry = routeOneRef({ stage, rimLevel: 999, conduitLevel: null, inflow, dtMin, weirLen: 20 });
    pct("nothing leaves: storage = inflow volume", dry.dS, dry.volIn, 0.5);
    near("  and the peak stage is that volume / the area", dry.peakLevel, dry.volIn / A0, 0.02, " ft");
    const wet = routeOneRef({ stage, rimLevel: 4, conduitLevel: null, inflow, dtMin, weirLen: 20 });
    row("inflow - outflow = change in storage", fmt(100 * wet.balance, 4) + " %", "0 %",
        Math.abs(wet.balance) < 0.005, "+/- 0.5 %");
    row("  and it overtopped the 4-ft rim", wet.overtops ? "yes at " + fmt(wet.overtopT, 1) + " h" : "no",
        "yes", wet.overtops, "identity");
    row("  peak outflow below the weir's own rating", fmt(wet.peakOut, 1) + " cfs",
        fmt(3.0 * 20 * Math.pow(wet.peakLevel - 4, 1.5), 1) + " cfs",
        Math.abs(wet.peakOut - 3.0 * 20 * Math.pow(wet.peakLevel - 4, 1.5)) < 0.5, "Q = 3.0 L H^1.5");
    const conduit = routeOneRef({ stage, rimLevel: 999, conduitLevel: 2, inflow, dtMin, weirLen: 20 });
    row("a conduit at 2 ft passes the inflow", conduit.throughConduit ? "yes" : "no", "yes",
        conduit.throughConduit, "identity");
    row("  so the pond stops rising near it", fmt(conduit.peakLevel, 2) + " ft", "< 3 ft",
        conduit.peakLevel < 3, "identity");
  }

  console.log("\n§12.5  the real site — 25-year, 24-hour");
  const site = T.loadDem("dem_site");
  const M = stormModel();
  const LR = clearLakeRing();
  const g2 = T.gridSpec(site, null, 0);
  const cds = drainConduits(M, g2);
  const [D, dms] = timed(() => C.runJob("drainage",
    { grid: T.gridSpec(site, null, 0), conduits: cds, captureFt: 3, lakeRing: LR,
      stride: 4, maxPolys: 60 }).result);
  note(`the Phase 1 map: ${D.sinks.length} outlets over ${(D.surveyedArea_ft2 / AC).toFixed(1)} ac, `
     + `label raster ${D.w}x${D.h} at ${D.dCell} ft (${(dms / 1000).toFixed(1)} s)`);

  const lift = p => {
    const out = [];
    for (const q of (p || [])) { const z = T.elev(q[0], q[1]); if (!Number.isNaN(z)) out.push([q[0], q[1], z]); }
    return out;
  };
  const cats = D.sinks.map(s => ({ label: s.label, kind: s.kind, name: s.id,
                                   area_ft2: s.area_ft2, path: lift(s.path) }));
  const labels = { data: D.labels, w: D.w, h: D.h, cell: D.dCell, x0: D.x0, y0: D.y0 };
  const [RO, rms] = timed(() => C.runJob("runoff", runoffJobFor(labels, cats, { ari: 25, hours: 24 })).result);
  budget("runoff, the whole site", rms, 20000);
  const by = id => RO.catchments.find(c => c.label === (D.sinks.find(s => s.id === id) || {}).label);

  near("the storm's depth (the provisional 25-yr 24-h)", RO.storm.P_in, RUNOFF_REC.P_in, 0.001, " in");
  near("site area (Phase 1's own)", RO.totals.area_ac, RUNOFF_REC.area_ac, 0.05, " ac");
  near("site composite CN (recorded)", RO.totals.cn, RUNOFF_REC.cn, 0.5, "");
  near("site runoff volume (recorded)", RO.totals.volume_acft, RUNOFF_REC.volume_acft, 1, " ac-ft");
  near("site peak, SCS (recorded)", RO.totals.qPeak_cfs, RUNOFF_REC.qPeak_cfs, RUNOFF_REC.qPeak_cfs * 0.02, " cfs");
  for (const c of RO.catchments.slice().sort((a, b) => b.area_ft2 - a.area_ft2))
    note(`  ${String(c.name).padEnd(26)} ${c.area_ac.toFixed(2).padStart(8)} ac  CN `
       + `${fmt(c.cn, 0).padStart(3)}  Q ${c.Q_in.toFixed(2)} in  ${c.volume_acft.toFixed(2)} ac-ft  `
       + `Tc ${String(c.tc_min).padStart(5)} min  Rational `
       + `${c.qRational_cfs == null ? "n/a" : fmt(c.qRational_cfs, 0)}  SCS ${fmt(c.qPeak_cfs, 0)} cfs`);
  for (const [id, ref] of Object.entries(RUNOFF_REC.outlets)) {
    const c = by(id);
    row(id + " volume (recorded)", c ? +c.volume_acft.toFixed(2) : NaN, ref.vol,
        !!c && Math.abs(c.volume_acft - ref.vol) <= 0.5, "+/- 0.5 ac-ft",
        c ? `CN ${fmt(c.cn, 0)}, Q ${fmt(c.Q_in, 2)} in, Tc ${c.tc_min} min, SCS ${fmt(c.qPeak_cfs, 0)} cfs` : "missing");
    if (c) near("  " + id + " peak, SCS (recorded)", c.qPeak_cfs, ref.peak, Math.max(1, ref.peak * 0.03), " cfs");
  }
  /* the identity every catchment table has to satisfy: the volumes are a
     partition of the site's, because the catchments are */
  const sumVol = RO.catchments.reduce((a, c) => a + c.volume_ft3, 0);
  near("the catchment volumes add to the site's", sumVol / AC, RO.totals.volume_acft, 0.01, " ac-ft");
  row("every catchment has a curve number", RO.catchments.filter(c => !isNaN(c.cn)).length,
      RO.catchments.length, RO.catchments.every(c => !isNaN(c.cn)), "exact");

  console.log("\n§12.6  the ponds, routed");
  /* the three named ponds, each seeded with EA's own water polygon so the
     August-2026 survey applies to the impoundment (js/runoff.js routeAll) */
  const firstCats = D.ponds.filter(p => p.contributing_area_ft2 > 0).map(p => ({
    label: p.label, kind: "pond", name: p.via || ("pond " + p.label),
    area_ft2: p.contributing_area_ft2,
    path: [[p.entry[0], p.entry[1], T.elev(p.entry[0], p.entry[1])]]
  }));
  const first = { data: D.first, w: D.w, h: D.h, cell: D.dCell, x0: D.x0, y0: D.y0 };
  const RF = C.runJob("runoff", runoffJobFor(first, firstCats, { ari: 25, hours: 24 })).result;
  const inflowOf = via => {
    const p = D.ponds.find(q => q.via === via);
    if (!p) return null;
    const c = RF.catchments.find(q => q.label === p.label);
    return c ? c.hydro : null;
  };
  const PONDS = [
    ["Herman Impoundment", "herman_pipe_s", { z0Override: 1336.45, levels: [1341.55, 1343.54] }],
    ["Frog Pond", "pond_culvert", {}],
    ["Green Pond", "green_outlet", {}]
  ];
  for (const [nm, via, opt] of PONDS) {
    const ring = waterRing(nm);
    const S = stageForRing(M, ring, nm, opt);
    const hy = inflowOf(via);
    const ref = RUNOFF_REC.ponds[via] || null;
    if (!hy) { row(nm + ": an inflow hydrograph", "none", "one", false, "exact"); continue; }
    const cl = S.conduitSpill ? (S.conduitSpill.stageLevel != null ? S.conduitSpill.stageLevel : S.conduitSpill.level) : null;
    const cluster = S.clusters && S.clusters.length ? S.clusters[0] : null;
    const rr = routeOneRef({ stage: S.stage, rimLevel: S.primary.level, conduitLevel: cl,
                             inflow: hy.q, dtMin: hy.dt_min,
                             weirLen: cluster ? Math.max(S.cell, cluster.cells * S.cell) : S.cell });
    note(`  ${nm}: start ${fmt(S.stage[0].level, 2)}, rim ${fmt(S.primary.level, 2)}, `
       + `conduit ${cl == null ? "none" : fmt(cl, 2)}, routed peak ${rr.peakLevel.toFixed(2)} ft, `
       + `${rr.overtops ? "OVERTOPS" : rr.throughConduit ? "through the conduit" : "contained"}, `
       + `inflow ${fmt(rr.volIn / AC, 1)} ac-ft, peak ${fmt(Math.max.apply(null, hy.q), 1)} cfs`);
    if (!ref) { note("  (not yet recorded — see RUNOFF_REC)"); continue; }
    near(nm + ": rim spill (the v13 golden)", S.primary.level, ref.rim, 0.02, " ft");
    if (ref.conduit != null) near("  its conduit spill (the v13 golden)", cl, ref.conduit, 0.02, " ft");
    near("  routed peak stage (recorded)", +rr.peakLevel.toFixed(2), ref.peak, 0.05, " ft");
    row("  overtops the rim?", rr.overtops ? "yes" : "no", ref.overtops ? "yes" : "no",
        rr.overtops === ref.overtops, "recorded",
        `inflow peak ${fmt(Math.max.apply(null, hy.q), 1)} cfs, ${fmt(rr.volIn / AC, 1)} ac-ft in`);
    row("  volume balance", fmt(100 * rr.balance, 4) + " %", "0 %",
        Math.abs(rr.balance) < 0.005, "+/- 0.5 %");
  }

  console.log("\n§12.7  the cover raster");
  /* §3(g). Two halves, and the second one is a DEVIATION FROM THE SPEC'S
     WORDING, stated here rather than quietly:

       * the classes are a partition of the surveyed ground — the areas add up
         to the drainage map's own surveyed area, cell for cell;
       * the paved class really is where EA's paved geometry is.

     The spec asks for the second as "the paved class area agrees with EA's
     paved polygons within 5 %". EA has no paved POLYGONS — it draws roads as
     LINES, two of them per road, so an analytic length x width estimate double
     counts every road while the raster merges the overlap, and the raster is
     additionally clipped to the surveyed ground and overpainted by buildings
     and water. The area comparison is therefore one-sided by construction
     (the raster can only be smaller) and on this site it is 16.7 % smaller,
     which says nothing about placement. So placement is tested directly and
     the area is reported beside it: a point ON an EA paved centreline must read
     `paved`, unless a higher-priority class (a building, open water) or the
     survey edge legitimately took that cell. */
  {
    const { meta, cover } = coverRasterN();
    const counts = new Float64Array(64);
    for (let i = 0; i < cover.data.length; i++) counts[cover.data[i]]++;
    const a2 = cover.cell * cover.cell;
    const surveyed = (cover.data.length - counts[0]) * a2;
    near("the class areas add to the surveyed ground", surveyed / AC,
         meta.surveyed_ft2 / AC, 0.01, " ac");
    near("  which is the drainage map's surveyed area", surveyed / AC,
         D.surveyedArea_ft2 / AC, 1.0, " ac");
    const idOf = k => (meta.classes.find(c => c.key === k) || {}).id;
    const classAt = (x, y) => {
      const i = Math.round((x - cover.x0) / cover.cell), j = Math.round((y - cover.y0) / cover.cell);
      if (i < 0 || j < 0 || i >= cover.w || j >= cover.h) return -1;
      return cover.data[j * cover.w + i];
    };
    /* every 10 ft along every paved road line EA drew */
    const gis = T.readJSON("data/design_gis.json");
    const pts = [];
    for (const f of gis.features) {
      const p = f.properties || {};
      if (p.layer !== "road" || f.geometry.type !== "LineString") continue;
      if (/GRVL|GRAV/i.test(p.cad_layer || "")) continue;
      const cs = f.geometry.coordinates;
      for (let i = 1; i < cs.length; i++) {
        const d = Math.hypot(cs[i][0] - cs[i - 1][0], cs[i][1] - cs[i - 1][1]);
        const n = Math.max(1, Math.round(d / 10));
        for (let k = 0; k < n; k++)
          pts.push([cs[i - 1][0] + (cs[i][0] - cs[i - 1][0]) * k / n,
                    cs[i - 1][1] + (cs[i][1] - cs[i - 1][1]) * k / n]);
      }
    }
    const tally = {};
    for (const q of pts) { const c = classAt(q[0], q[1]); tally[c] = (tally[c] || 0) + 1; }
    const higher = [idOf("roof"), idOf("water"), 0, -1];       // legitimately overpainted
    const eligible = pts.length - higher.reduce((a, k) => a + (tally[k] || 0), 0);
    const hit = tally[idOf("paved")] || 0;
    row("a point on an EA paved road reads `paved`", hit + " of " + eligible,
        ">= 95 %", hit >= 0.95 * eligible, "95 % of the eligible points",
        pts.length + " points at 10 ft, " + (pts.length - eligible)
        + " on a building, on water or off the survey");
    const paved = (counts[idOf("paved")] + counts[idOf("roof")]) * a2;
    const an = meta.analytic_check;
    const ref = an.paved_road_ft2 + an.building_ft2;
    row("paved + roofs vs EA's own geometry", (paved / AC).toFixed(2) + " ac",
        "<= " + (ref / AC).toFixed(2) + " ac", paved <= ref, "one-sided (see above)",
        "d=" + (100 * (paved - ref) / ref).toFixed(1) + " %; overlapping road buffers, "
        + "clipping to the survey and overpainting can only remove area");
    /* recorded from this commit: the class split the curve numbers rest on */
    for (const [k, ref2] of Object.entries(COVER_REC))
      near("  " + k + " (recorded)", counts[idOf(k)] * a2 / AC, ref2, 0.05, " ac");
    note(`green-excess threshold ${meta.green_excess_threshold}, canopy >= `
       + `${meta.canopy_min_ft} ft, road half-width ${meta.road_half_width_ft.paved} ft`);
  }
}

/* ====================== 14. THE WASM CORE (v21) =========================== */
/* docs/V21_WASM_SPEC.md §2: identity is the acceptance. Every ported kernel is
   run TWICE on one job -- once with the module forced off, once with it on --
   and the two outputs are compared field by field. Where the arithmetic is a
   copy, an integer or an order-independent comparison the requirement is
   BIT-IDENTICAL and this section says so; where a floating summation order
   moves it is <= 1e-6 relative, and the row names which and why.

   The speed-up printed beside each is this box, node, warm cache. */
const WASM_REC = {};   /* filled as the section runs, printed as a table */

function ab(name, fn, warm) {
  /* Run `fn()` on each backend and return [jsOut, wasmOut, jsMs, wasmMs].
     Both get a warm-up run first unless the caller says otherwise: V8 needs
     one to JIT the kernel and wasm needs one to grow linear memory, so a
     first-run comparison flatters whichever went second. */
  const one = (js) => { C.wasmForce(js); if (warm !== false) fn(); const t = Date.now(); const r = fn(); return [r, Date.now() - t]; };
  const [j, jms] = one(true);
  const [wo, wms] = one(false);
  C.wasmForce(false);
  WASM_REC[name] = { jms, wms };
  return [j, wo, jms, wms];
}
function speed(name, jms, wms) {
  const x = wms > 0 ? jms / wms : Infinity;
  console.log("        " + name.padEnd(28) + ("js " + jms + " ms").padStart(14) +
              ("   wasm " + wms + " ms").padStart(18) + "   " +
              (x >= 1 ? x.toFixed(2) + "x faster" : (1 / x).toFixed(2) + "x SLOWER"));
  return x;
}
function identical(name, a, b, what) {
  const r = sameArray(a, b);
  row(name, r.ok ? "identical (" + (a ? a.length : 0) + ")" : r.n + " cells differ (first at " + r.at + ")",
      "bit-identical", r.ok, "exact", what || "");
}

function secWasm() {
  console.log("\nwasm — the v21 compute core, identity against the JavaScript kernels");
  if (!WASM.ok) {
    row("the module instantiates", WASM.why || "no", "instantiated", false, "exact",
        "build it with `python tools/build_wasm.py`");
    return;
  }
  const info = C.wasmInfo();
  row("the module instantiates", "v" + (info.version || "?") + ", " + WASM.bytes + " b64 bytes",
      "instantiated", true, "exact", "api " + C.VERSION);
  atMost("payload size", WASM.bytes, 400 * 1024, " bytes (field build)");
  row("wasmForce(true) is the JavaScript path", C.wasmForce(true), "js", C.wasmBackend() === "js", "exact");
  row("wasmForce(false) is the wasm path", C.wasmForce(false), "wasm", C.wasmBackend() === "wasm", "exact");

  /* ---- fillDem: shared by flowpath, overtop and drainage ------------------
     Driven exactly as js/water.js drives it, through the Herman window the
     water section cuts, and again with the storm network's capture cells as
     sinks and the parent forest asked for -- the two things v12 and v14 added. */
  {
    const g = hermanWindow();
    const [a, b, jms, wms] = ab("fillDem", () => {
      const par = new Int32Array(g.sw * g.sh);
      const F = C.fillDem(g.z, g.sw, g.sh, null, 0, 1, null, par);
      return { F, par };
    });
    speed("fillDem " + g.sw + "x" + g.sh, jms, wms);
    identical("fillDem F", a.F, b.F, "no arithmetic: F is a copy of z or of a level");
    identical("fillDem parent forest", a.par, b.par, "the heap tie-break fixes the order");

    const sk = fillSinks(g);
    const [a2, b2, jms2, wms2] = ab("fillDem+sinks", () => {
      const par = new Int32Array(g.sw * g.sh);
      const F = C.fillDem(g.z, g.sw, g.sh, null, 0, 1, sk, par);
      return { F, par };
    });
    speed("fillDem, " + sk.length + " conduit sinks", jms2, wms2);
    identical("fillDem F (seeded)", a2.F, b2.F, "the v12 conduit seeding");
    identical("fillDem parent (seeded)", a2.par, b2.par, "");
    row("the seeding changes F", sameArray(a.F, a2.F).n + " cells", "> 0",
        sameArray(a.F, a2.F).n > 0, "identity", "so the seeded case is really exercised");
  }

  /* ---- flowpath: the descent, the fill-spill flood and the conduit chain --
     Three jobs, because three different halves of the kernel run in each: the
     section-9.1 raindrop is pure v10 descent, the Herman drop with the network
     on takes the pond rule and a conduit chain, and the overflow route adds
     the blocked ring (whose mask and plateau level stay in JavaScript). */
  {
    const D = T.readJSON(path.join(FIX, "drop_ref.json")).swale.drop;
    const abp = T.loadDem("dem_abp");
    const swale = T.gridSpec(abp, [D[0] - 700, D[1] - 700, D[0] + 700, D[1] + 700], 0);
    const sc = swale.cell;
    const [a, b, jms, wms] = ab("flowpath", () =>
      C.runJob("flowpath", { grid: swale, x: D[0] - sc / 2, y: D[1] - sc / 2 }).result);
    speed("flowpath, section 9.1 drop", jms, wms);
    identicalResult("flowpath (no conduits)", a, b, a.n + " vertices, " + a.ponds.length + " ponds");

    /* The section-6.8 run whole: the surveyed Herman water-level shot with the
       network on, chained window by window the way js/water.js traceRun chains
       it. That is the run that takes the pond rule AND a conduit chain, and
       comparing the WHOLE chained result is the only way to see the legs. */
    const M = stormModel();
    const WL = [6372119.56, 2127446.20];
    const ring = hermanRing().map(q => [q[0], q[1]]);
    const [a2, b2, jms2, wms2] = ab("flowpath+storm", () => hostRun(M, WL[0], WL[1], true));
    speed("flowpath, chained + storm", jms2, wms2);
    identicalResult("flowpath (conduits, chained)", a2, b2,
      a2.legs.length + " legs, " + a2.ponds.length + " ponds, " + a2.hops + " hops, reason " + a2.reason);
    row("the chained run really used the network", a2.legs.map(l => l.id).join(","),
        "a conduit chain", a2.legs.length > 0, "identity");

    /* and the blocked ring, whose mask and plateau level stay in JavaScript */
    const hg = hermanWindow();
    const seed = ringCentroid(ring);
    const [a3, b3, jms3, wms3] = ab("flowpath+block", () =>
      C.runJob("flowpath", { grid: hg, x: seed[0], y: seed[1], blockRing: ring }).result);
    speed("flowpath, blocked ring", jms3, wms3);
    identicalResult("flowpath (blocked ring)", a3, b3, "reason " + a3.reason);
  }

  /* ---- marchOne, through the kernels that run it -------------------------
     `marchOne` is not a runJob kind, so it is exercised the way the app runs
     it: the overtopping analysis (42 stage rings and a rim band through
     traceMask/maskRings), and CBOUND, which is one contour of the terrain
     followed by the ring-aware simplify. */
  {
    const g = hermanWindow();
    const ring = hermanRing().map(q => [q[0], q[1]]);
    const [a, b, jms, wms] = ab("overtop", () =>
      C.runJob("overtop", { grid: g, seedRing: ring }).result, false);
    speed("overtop, Herman", jms, wms);
    identicalResult("overtop (rim, 42 stage rows)", a, b,
      a.stage.length + " stage rows, " + a.clusters.length + " rim lows");

    const M = stormModel();
    const X0 = g.x0 + g.i0 * g.cell, Y0 = g.y0 + g.j0 * g.cell;
    const win = [X0, Y0, X0 + (g.sw - 1) * g.cell, Y0 + (g.sh - 1) * g.cell];
    const cds = M.conduitsFor(win);
    const [a2, b2, jms2, wms2] = ab("overtop+conduits", () =>
      C.runJob("overtop", { grid: g, seedRing: ring, conduits: cds, captureFt: 3 }).result, false);
    speed("overtop, " + cds.length + " conduits", jms2, wms2);
    identicalResult("overtop (conduit spill)", a2, b2,
      a2.conduitSpill ? "spills through " + a2.conduitSpill.id : "no conduit spill");
    row("the conduit spill is really found", a2.conduitSpill ? a2.conduitSpill.id : "none",
        "a conduit", !!a2.conduitSpill, "identity");
  }

  /* ---- contoursFromGrid ---------------------------------------------------
     The same two jobs the `contours` section runs: the analytic cone (where a
     ring's length is 2*pi*r and the identity is arithmetic) and the real 10-ft
     site window, which is the set the v9.7 stub rule was written for. */
  {
    const cone = T.synthGrid(0, 0, 2, 400, 400, (x, y) => {
      const r = Math.hypot(x - 400, y - 400);
      return r > 380 ? NaN : 100 - r * 0.25;
    });
    const [a, b, jms, wms] = ab("contours", () =>
      C.runJob("contours", { grid: cone, interval: 5, stride: 1, maxPts: 500000 }).result);
    speed("contours, 400x400 cone", jms, wms);
    identicalResult("contours (cone)", a, b, a.levels.length + " polylines");

    const site = T.loadDem("dem_site");
    const win = T.gridSpec(site, [6371000, 2127000, 6373000, 2129000], 0);
    const [a2, b2, jms2, wms2] = ab("contours+site", () =>
      C.runJob("contours", { grid: win, interval: 10, stride: 5, maxPts: 500000 }).result);
    speed("contours, " + win.sw + "x" + win.sh + " at 10 ft", jms2, wms2);
    identicalResult("contours (real terrain)", a2, b2,
      a2.levels.length + " polylines, " + (a2.coords.length / 2) + " vertices");
  }

  /* ---- drainage -----------------------------------------------------------
     The whole map, both cores, on the FIELD build's 4-ft grid: it is the same
     kernel over the same site (the section-11 run is the 2-ft one and takes
     five minutes a side), it exercises the two rules the 4-ft grid is the only
     one to hit -- an inlet's own nearest cell counting as a capture cell, and
     the uphill-parent one-cell component -- and it asks for the polygons and
     the flow paths, which the 2-ft section switches off. */
  {
    const site = T.loadDem("dem_site");
    const M = stormModel();
    const LR = clearLakeRing();
    const g4 = decimateGrid(T.gridSpec(site, null, 0), 2);
    const cds = drainConduits(M, g4);
    const [a, b, jms, wms] = ab("drainage", () =>
      C.runJob("drainage", { grid: g4, conduits: cds, captureFt: 3, lakeRing: LR,
                             stride: 4 }).result, false);
    speed("drainage, " + a.gw + "x" + a.gh + " at " + a.cell + " ft", jms, wms);
    /* `ms` is the kernel's own wall clock and differs by construction */
    const strip = r => { const c = { ...r }; delete c.ms; return c; };
    identicalResult("drainage (whole site, 4 ft)", strip(a), strip(b),
      a.sinks.length + " outlets, " + a.ponds.length + " ponds, " + a.inlets.length +
      " inlets, " + a.pondsTotal + " depressions");
    row("the map really has polygons and paths",
        a.sinks.reduce((n, s) => n + s.rings.length, 0) + " rings, " +
        a.sinks.reduce((n, s) => n + (s.path ? 1 : 0), 0) + " paths",
        "> 0 rings", a.sinks.reduce((n, s) => n + s.rings.length, 0) > 0, "identity");
    exact("no unresolved loops on either core", a.loops + "/" + b.loops, "0/0");
  }

  /* ---- volumeGrid ---------------------------------------------------------
     THE golden number goes through this one, so it is checked on the ring the
     golden is measured on and on two of the other bases: the perimeter TIN
     (the memo method), and a fixed base at the ring's lowest perimeter point,
     which takes the `fixed` branch and the plane-free path. */
  {
    const piles = T.readJSON("data/piles.json");
    const p1 = piles.find(p => (p.name || "") === "Pile 1 (Fig 2)");
    const jt = buildVolumeJob(p1.ring.map(p => p.slice()), { baseMode: "tin" });
    const [a, b, jms, wms] = ab("volume", () => C.runJob("volume", jt.job).result);
    speed("volume, Pile 1 TIN " + jt.job.nx + "x" + jt.job.ny, jms, wms);
    identicalResult("volume (perimeter TIN)", a, b,
      "fill " + (a.fill / 27).toFixed(1) + " yd3 over " + a.n + " cells");
    /* and it really is the golden, on the core that just computed it */
    near("the golden through the core", +(b.fill / 27).toFixed(1), 278.4, 10, " yd3");

    const jl = buildVolumeJob(p1.ring.map(p => p.slice()), { baseMode: "lowest" });
    const [a2, b2, jms2, wms2] = ab("volume+fixed", () => C.runJob("volume", jl.job).result);
    speed("volume, fixed base", jms2, wms2);
    identicalResult("volume (fixed base)", a2, b2, "fill " + (a2.fill / 27).toFixed(1) + " yd3");

    const jp = buildVolumeJob(p1.ring.map(p => p.slice()), { baseMode: "plane" });
    const [a3, b3, jms3, wms3] = ab("volume+plane", () => C.runJob("volume", jp.job).result);
    speed("volume, least-squares plane", jms3, wms3);
    identicalResult("volume (plane base)", a3, b3, "fill " + (a3.fill / 27).toFixed(1) + " yd3");
  }
}

/* the Herman ring's bbox +/- 800 ft, the window js/water.js cuts for the
   overtopping analysis -- a standalone grid spec */
let _hw = null;
function hermanWindow() {
  if (_hw) return _hw;
  const ring = hermanRing();
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const bb = [Math.min(...xs) - 800, Math.min(...ys) - 800, Math.max(...xs) + 800, Math.max(...ys) + 800];
  _hw = T.gridSpec(T.demForBox(bb) || T.loadDem("dem_site"), bb);
  return _hw;
}
/* every capture cell of the storm network inside that window, at its rim --
   js/water.js conduitsFor + the kernel's own inlet index (v12 section 2) */
function fillSinks(g) {
  const M = stormModel();
  const X0 = g.x0 + g.i0 * g.cell, Y0 = g.y0 + g.j0 * g.cell;
  const win = [X0, Y0, X0 + (g.sw - 1) * g.cell, Y0 + (g.sh - 1) * g.cell];
  const out = [], seen = new Set();
  for (const cd of M.conduitsFor(win)) {
    const ki = Math.round((cd.ix - X0) / g.cell), kj = Math.round((cd.iy - Y0) / g.cell);
    const rc = Math.max(0, Math.ceil(3 / g.cell));
    for (let j = kj - rc; j <= kj + rc; j++) {
      if (j < 0 || j >= g.sh) continue;
      for (let i = ki - rc; i <= ki + rc; i++) {
        if (i < 0 || i >= g.sw) continue;
        if (Math.hypot(X0 + i * g.cell - cd.ix, Y0 + j * g.cell - cd.iy) > 3) continue;
        const k = j * g.sw + i;
        if (Number.isNaN(g.z[k]) || seen.has(k)) continue;
        seen.add(k);
        out.push([k, (cd.rim == null || !isFinite(cd.rim)) ? g.z[k] : cd.rim]);
      }
    }
  }
  return out;
}

/* a deep structural comparison of two kernel results -- what "identity" means
   for a kernel whose output is an object graph rather than one raster */
function deepDiff(a, b, path, out) {
  path = path || "";
  out = out || [];
  if (a === b) return out;
  if (a == null || b == null) { out.push(path + ": " + a + " vs " + b); return out; }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    const r = sameArray(a, b);
    if (!r.ok) out.push(path + ": " + (r.n < 0 ? "length " + a.length + " vs " + b.length
                                               : r.n + " of " + a.length + " differ, first at " + r.at));
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push(path + ": array " + (a && a.length) + " vs " + (b && b.length));
      return out;
    }
    for (let i = 0; i < a.length && out.length < 8; i++) deepDiff(a[i], b[i], path + "[" + i + "]", out);
    return out;
  }
  const ta = typeof a, tb = typeof b;
  if (ta === "number" && tb === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return out;
    out.push(path + ": " + a + " vs " + b);
    return out;
  }
  if (ta === "object" && tb === "object") {
    const ks = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of ks) { if (out.length >= 8) break; deepDiff(a[k], b[k], path ? path + "." + k : k, out); }
    return out;
  }
  out.push(path + ": " + String(a) + " vs " + String(b));
  return out;
}
function identicalResult(name, a, b, what) {
  const d = deepDiff(a, b, "");
  row(name, d.length ? d.length + " field(s) differ" : "identical", "bit-identical", d.length === 0, "exact",
      d.length ? d.slice(0, 3).join(" | ") : (what || ""));
}

function ringCentroid(r) {
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length];
}
/* ============================== run ====================================== */
const SECTIONS = [
  { key: "volume", run: secVolume },
  { key: "isopach", run: secIsopach },
  { key: "raster", run: secRaster },
  { key: "contours", run: secContours },
  { key: "design", run: secDesign },
  { key: "sections", run: secSections },
  { key: "smart", run: secSmart },
  { key: "trees", run: secTrees },
  { key: "water", run: secWater },
  { key: "storm", run: secStorm },
  { key: "water3d", run: secWater3d },
  { key: "drainage", run: secDrainage },
  { key: "runoff", run: secRunoff },
  { key: "wasm", run: secWasm }
];

if (listOnly) {
  console.log(SECTIONS.map(s => s.key).join("\n"));
  process.exit(0);
}

const C = loadCompute();
const Delaunay = loadDelaunay();
const WASM = loadWasm(C);
console.log("SBMM kernel harness — js/compute.js VERSION " + C.VERSION +
            (C.VERSION === 9 ? "" : "  (!! expected 9)"));
if (C.VERSION !== 9) { fails++; checks++; }
console.log("wasm core: " + (WASM.ok
  ? "v" + (WASM.meta && WASM.meta.version) + ", " + WASM.bytes + " bytes"
  : "NOT LOADED (" + WASM.why + ")"));
if (!WASM.ok && backendArg !== "js") {
  console.error("--backend " + backendArg + " needs the module; run `python tools/build_wasm.py`");
  process.exit(2);
}

/* every kernel runJob dispatches must have a section here (V11 spec §2.4) */
const COVERED = ["volume", "isopach", "raster", "contours", "design", "balance", "sections",
                 "wand", "cbound", "toecrest", "stands", "trees", "flowpath", "overtop", "catchment",
                 "drainage", "runoff"];
{
  const src = fs.readFileSync(path.join(REPO, "js", "compute.js"), "utf8");
  const dispatched = [...src.matchAll(/if \(kind === "([a-z]+)"\) return /g)].map(m => m[1]);
  const missing = dispatched.filter(k => !COVERED.includes(k));
  row("every runJob kernel is covered", missing.length ? missing.join(",") : dispatched.length + " kernels",
      "0 uncovered", missing.length === 0, "exact",
      "a new kernel gets a section here before it ships");
}

const wanted = SECTIONS.filter(s => !only || only.includes(s.key));
if (!wanted.length) { console.log("no section matches --only " + only.join(",")); process.exit(2); }

/* v21 §5: every section on both backends -- a golden is a golden whichever
   core computed it. The `wasm` section drives both itself and is run once. */
const backends = backendArg === "both" ? ["js", "wasm"] : [backendArg];
const t0 = Date.now();
for (const be of backends) {
  C.wasmForce(be === "js");
  if (backends.length > 1 || backendArg !== "js")
    console.log("\n================== backend: " + C.wasmBackend().toUpperCase() +
                " ==================");
  const first = be === backends[0];
  for (const s of wanted) {
    if (s.key === "wasm" && !first) continue;      // it is the A/B itself
    const st = Date.now();
    s.run();
    console.log("  ---- " + s.key + " section: " + ((Date.now() - st) / 1000).toFixed(1) + " s");
  }
}
C.wasmForce(false);
console.log("\nterrain: decoded [" + T.loadStats.decoded.join(" ") + "] cached [" +
            T.loadStats.cached.join(" ") + "] in " + (T.loadStats.ms / 1000).toFixed(1) + " s");
console.log((fails ? "FAILED " + fails + " of " + checks : "PASSED all " + checks) +
            " checks" + (warns ? "; " + warns + " over budget" : "") +
            " in " + ((Date.now() - t0) / 1000).toFixed(1) + " s.");
process.exit(fails ? 1 : 0);
