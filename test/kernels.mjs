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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FIX = path.join(HERE, "fixtures");
const AC = 43560;

/* ------------------------------------------------------------------ argv -- */
const argv = process.argv.slice(2);
let only = null, listOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") only = (only || []).concat(String(argv[++i]).split(","));
  else if (a === "--list") listOnly = true;
  else if (a.startsWith("--")) argv[++i];        // tolerate (and ignore) legacy flags
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
function ptsFrom(coords, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [coords[i * 2], coords[i * 2 + 1]];
  if (out.length > 3) {
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
  let worst = 0, worstLv = null;
  for (const g of rings) {
    const r = R0 * (100 - g.lv) / 100;
    const e = Math.abs(g.len - 2 * Math.PI * r) / (2 * Math.PI * r) * 100;
    if (e > worst) { worst = e; worstLv = g.lv; }
  }
  row("every ring length = 2*pi*r", worst.toFixed(3) + " % worst", "< 1 %", worst < 1, "identity",
      "at the " + worstLv + "-ft ring");
  row("stubs are only stubs", Math.max(0, ...all.filter(g => g.len <= 1).map(g => g.len)).toFixed(3) + " ft longest",
      "< 0.1 ft", all.every(g => g.len > 1 || (g.len < 0.1 && g.n === 2)), "2 vertices, < 0.1 ft",
      stubs + " of them");
  for (const g of rings)
    note("level " + String(g.lv).padStart(3) + " ft: r " + (R0 * (100 - g.lv) / 100).toFixed(0) +
         " ft, " + g.n + " vertices, " + g.len.toFixed(1) + " ft (2*pi*r = " +
         (2 * Math.PI * R0 * (100 - g.lv) / 100).toFixed(1) + ")");
  budget("contours (cone)", ms, 4000);

  /* ---- the real 2-ft site grid over the mine area -------------------------
     js/analysis.js contoursFromDem(). NOTE: contoursFromGrid indexes
     z[j*g.w + i] and sizes its sweep from g.w/g.h, so it only ever works on a
     WHOLE-grid spec — the app always hands it gridSpec(dem) with no bbox. A
     windowed spec would silently produce nothing, so the window here is cut as
     a standalone grid (test/lib/terrain.mjs subGrid). Stride is the app's own:
     max(round(interval/cell), ceil(sqrt(cells/1.5e6))) = 5 at 10 ft on 2 ft.  */
  const site = T.loadDem("dem_site"), abp = T.loadDem("dem_abp");
  const mine = T.subGrid(site, [abp.m.x0, abp.m.y0,
                                abp.m.x0 + (abp.m.w - 1) * abp.m.cell,
                                abp.m.y0 + (abp.m.h - 1) * abp.m.cell]);
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
  pct("polylines", rall.length, 262, 5);
  pct("polylines over 10 ft", rall.filter(g => g.len > 10).length, 189, 5);
  row("not truncated", RR.truncated, false, RR.truncated === false, "exact");
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
  const R2 = C.runJob("sections", { align: bAlign, interval, width, offStep,
                                    grids: T.gridsFor(bbox2), dgrid, chm: null }).result;
  let cutSum = 0, fillSum = 0, worstA = 0, nOff = 0, worstNeg = 0;
  for (let s = 0; s < R2.ns; s++) {
    let net = 0;
    for (let o = 0; o + 1 < R2.no; o++) {
      const k1 = s * R2.no + o, k2 = k1 + 1;
      const g1 = R2.ground[k1], g2 = R2.ground[k2], d1 = R2.design[k1], d2 = R2.design[k2];
      if (isNaN(g1) || isNaN(g2) || isNaN(d1) || isNaN(d2)) continue;
      const h1 = g1 - d1, h2 = g2 - d2;
      if (h1 < 0) { nOff++; worstNeg = Math.max(worstNeg, -h1); }
      net += (h1 + h2) / 2 * offStep;
    }
    /* the kernel splits each trapezoid at its zero crossing so cut and fill
       never mix; that partition is exact, so cutA - fillA must equal the plain
       trapezoid to the bit. This is an identity, not a recorded number. */
    worstA = Math.max(worstA, Math.abs(net - (R2.cutA[s] - R2.fillA[s])));
    cutSum += R2.cutA[s]; fillSum += R2.fillA[s];
  }
  row("end areas exist", R2.cutA ? "cutA + fillA" : "missing", "cutA + fillA", !!R2.cutA, "exact");
  row("cutA - fillA = plain trapezoid", worstA, "<= 1e-9 ft2", worstA <= 1e-9, "identity",
      "cut " + cutSum.toFixed(1) + " ft2, fill " + fillSum.toFixed(2) + " ft2 over " + R2.ns + " stations");
  /* res_excbottom is existing ground minus a depth, so real fill is impossible.
     What survives is the two rasters disagreeing at their own quantisation:
     the DEM is bilinear over 0.02-ft steps and dgridAt interpolates the design
     BILINEARLY between nodes that were built nearest-cell, so the difference
     dips a few hundredths below zero on a slope. That is exactly the effect
     ruling F9's isoTol exists for, and the sections kernel has no equivalent —
     recorded here so it stays small rather than becoming a quantity. */
  atMost("design-above-ground, worst", +worstNeg.toFixed(3), 0.1, " ft");
  row("fill vs cut", (100 * fillSum / cutSum).toFixed(2) + " %", "< 2 %",
      fillSum < 0.02 * cutSum, "quantisation only", nOff + " of " + (R2.ns * (R2.no - 1)) + " offsets");
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
  const tpts = ptsFrom(TC.coords, TC.nPts);
  row("a usable line", TC.nPts >= 3, true, TC.nPts >= 3, "exact", tpts.length + " vertices");
  /* recorded from this commit */
  pct("line length", TC.length, 154.1, 3);
  atMost("distance from the click", +TC.distFt.toFixed(1), 60, " ft");
  /* R.length is measured over the kernel's own coords. js/smartbound.js then
     runs them through ptsFrom, which drops a repeated first vertex — and this
     chain IS closed, so the LINE feature the app builds is one segment (2.0 ft)
     shorter than the "Length" row the card prints beside it. Both numbers are
     recorded so the discrepancy is visible rather than latent. */
  const rawLen = (function () { let s = 0; for (let i = 1; i < TC.nPts; i++)
    s += Math.hypot(TC.coords[i * 2] - TC.coords[(i - 1) * 2], TC.coords[i * 2 + 1] - TC.coords[(i - 1) * 2 + 1]); return s; })();
  near("length over the raw coords", rawLen, TC.length, 0.01, " ft");
  near("length after ptsFrom's trim", (function () { let s = 0; for (let i = 1; i < tpts.length; i++) s += dist2d(tpts[i - 1], tpts[i]); return s; })(),
       152.113, 0.05, " ft");
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
  { key: "water", run: secWater }
];

if (listOnly) {
  console.log(SECTIONS.map(s => s.key).join("\n"));
  process.exit(0);
}

const C = loadCompute();
const Delaunay = loadDelaunay();
console.log("SBMM kernel harness — js/compute.js VERSION " + C.VERSION +
            (C.VERSION === 4 ? "" : "  (!! expected 4)"));
if (C.VERSION !== 4) { fails++; checks++; }

/* every kernel runJob dispatches must have a section here (V11 spec §2.4) */
const COVERED = ["volume", "isopach", "raster", "contours", "design", "balance", "sections",
                 "wand", "cbound", "toecrest", "stands", "trees", "flowpath", "overtop", "catchment"];
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

const t0 = Date.now();
for (const s of wanted) {
  const st = Date.now();
  s.run();
  console.log("  ---- " + s.key + " section: " + ((Date.now() - st) / 1000).toFixed(1) + " s");
}
console.log("\nterrain: decoded [" + T.loadStats.decoded.join(" ") + "] cached [" +
            T.loadStats.cached.join(" ") + "] in " + (T.loadStats.ms / 1000).toFixed(1) + " s");
console.log((fails ? "FAILED " + fails + " of " + checks : "PASSED all " + checks) +
            " checks" + (warns ? "; " + warns + " over budget" : "") +
            " in " + ((Date.now() - t0) / 1000).toFixed(1) + " s.");
process.exit(fails ? 1 : 0);
