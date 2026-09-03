/* SBMM Site Explorer — water kernels, checked in node against the golden numbers.

   docs/V10_WATER_SPEC.md §3.4. No browser and no Playwright: js/compute.js is a
   context-free module (that is the whole point of it — js/jobs.js turns it into a
   Web Worker with Function.prototype.toString() and nothing else), so it loads
   into a plain `vm` context and the three water kernels can be exercised directly
   over a fixture window of the real lidar grid. This is the fast loop for anyone
   touching flowpath / overtop / catchment: seconds, not minutes, and it prints
   every §9 quantity next to the reference the planner produced with an
   independent Python implementation of §2.

     node test/water_kernels.mjs [scratchDir]
     node test/water_kernels.mjs --swale <base> --herman <base>
                                 --dropref <file> --hermanref <file> --gis <file>

   `<base>` names a fixture PAIR: <base>.json (the gridSpec: x0,y0,cell,w,h,
   i0,j0,sw,sh — plus `drop` on the raindrop fixture) and <base>.f32 (little-endian
   Float32, `sw` per row, rows south->north, NaN = NoData) — exactly the shape
   js/jobs.js ships to a worker.

   A NOTE ON THE HALF CELL. The fixtures state positions at the CENTRE of a cell in
   the reference's own convention, x0 + (i + 0.5)*cell. This app samples the DEM at
   x0 + i*cell (Dem.at(), gridAt(), pileWand — the sample IS the cell centre and the
   raster spans half a cell either side of it), so every position the kernels report
   sits half a cell south-west of the reference's label for the same DEM sample:
   0.5 ft on the 1-ft grid, 1.0 ft on the 2-ft grid. That is inside every tolerance
   in §9 by a wide margin, and the drop point below is converted so that both
   implementations start on the same sample rather than on neighbouring ones.
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEF_DIR = "/tmp/claude-0/-home-user-SBM/63f85d97-7536-5128-ab20-1c10e66fbf18/scratchpad";

/* ---------------------------------------------------------------- argv ---- */
const argv = process.argv.slice(2);
let dir = DEF_DIR;
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
  else dir = a;
}
const P = {
  swale: flags.swale || path.join(dir, "fix_swale_window"),
  herman: flags.herman || path.join(dir, "fix_herman_window"),
  dropref: flags.dropref || path.join(dir, "drop_ref.json"),
  hermanref: flags.hermanref || path.join(dir, "herman_ref.json"),
  gis: flags.gis || path.join(REPO, "data", "design_gis.json"),
  compute: flags.compute || path.join(REPO, "js", "compute.js")
};

/* ------------------------------------------------- load js/compute.js ----- */
function loadCompute(file) {
  const src = fs.readFileSync(file, "utf8");
  /* runInThisContext, NOT runInContext: js/compute.js declares one plain
     `var SBMM_COMPUTE = (function(){...})()`, so running it in the main realm's
     global scope is enough to get it — and it is also the only way the timings
     below mean anything. A vm.createContext() sandbox is a second V8 context and
     runs this arithmetic about six times slower (fillDem over the Herman window:
     2.4 s sandboxed vs 0.38 s here), which is an artefact of the sandbox, not of
     the kernels: in the app they run in a Worker, i.e. an ordinary realm. */
  vm.runInThisContext(src, { filename: file });
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

/* python's json.dump writes bare NaN (the reference end vertex is a NoData cell) */
const readJSON = f => JSON.parse(fs.readFileSync(f, "utf8").replace(/\bNaN\b/g, "null"));

function loadFixture(base) {
  const meta = readJSON(base + ".json");
  const buf = fs.readFileSync(base + ".f32");
  const n = meta.sw * meta.sh;
  if (buf.length !== n * 4) throw new Error(base + ".f32 is " + buf.length + " bytes, expected " + n * 4);
  const z = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  return { meta, grid: { x0: meta.x0, y0: meta.y0, cell: meta.cell, w: meta.w, h: meta.h,
                         i0: meta.i0, j0: meta.j0, sw: meta.sw, sh: meta.sh, z } };
}

function hermanRing(file) {
  const gis = readJSON(file);
  const f = gis.features.find(x => x.properties && x.properties.layer === "water" &&
                                   x.properties.name === "Herman Impoundment");
  if (!f) throw new Error('no water-layer feature named "Herman Impoundment" in ' + file);
  return f.geometry.coordinates[0];
}

/* ------------------------------------------------------------ reporting -- */
let fails = 0, checks = 0, warns = 0;
const AC = 43560;
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
const dist = (name, gx, gy, rx, ry, tol) =>
  row(name, "E " + gx.toFixed(1) + " N " + gy.toFixed(1), "E " + rx.toFixed(0) + " N " + ry.toFixed(0),
      Math.hypot(gx - rx, gy - ry) <= tol, "within " + tol + " ft",
      "d=" + Math.hypot(gx - rx, gy - ry).toFixed(2) + " ft");
/* a simplified path may shed length but must not gain it (§9) */
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

/* ============================================================== run ======= */
const C = loadCompute(P.compute);
console.log("SBMM water kernels — js/compute.js VERSION " + C.VERSION +
            (C.VERSION === 4 ? "" : "  (!! expected 4)"));
if (C.VERSION !== 4) { fails++; checks++; }

/* ---- §9.1 raindrop ------------------------------------------------------- */
const swale = loadFixture(P.swale);
const dref = readJSON(P.dropref).swale;
const sc = swale.grid.cell;
/* the fixture's drop is stated at the reference's cell centre; the same DEM
   sample is half a cell south-west of it in this app's convention (header note) */
const dropX = swale.meta.drop[0] - sc / 2, dropY = swale.meta.drop[1] - sc / 2;

console.log("\n§9.1  raindrop — " + swale.meta.sw + " x " + swale.meta.sh + " cells of the " +
            sc + "-ft grid, drop at E " + dropX + " N " + dropY);
const [fpOut, fpMs] = timed(() => C.runJob("flowpath", { grid: swale.grid, x: dropX, y: dropY }));
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
  console.log("        pond " + (i + 1) + ": depth " + fp.ponds[i].depth_ft.toFixed(2) +
              " ft, area " + fp.ponds[i].area_ft2.toFixed(0) + " ft2, volume " +
              fp.ponds[i].volume_ft3.toFixed(1) + " ft3 (ref " + dref.ponds[i].volume_ft3 +
              "), rings " + fp.ponds[i].rings.length);
}
console.log("        path " + fp.n + " vertices (unsimplified " + fp.lengthRaw_ft.toFixed(1) +
            " ft over " + fp.steps + " steps), fall " + fp.fall_ft.toFixed(2) + " ft");
budget("flowpath", fpMs, 1000);

const [caOut, caMs] = timed(() => C.runJob("catchment", { grid: swale.grid, x: dropX, y: dropY }));
const ca = caOut.result;
pct("catchment cells", ca.cells, dref.catchment.cells, 3);
console.log("        area " + ca.area_ft2.toFixed(0) + " ft2, touchesEdge " + ca.touchesEdge +
            " (ref " + dref.catchment.touchesEdge + "), rings " + ca.rings.length);
budget("catchment", caMs, 2000);

/* ---- §9.2 Herman Impoundment -------------------------------------------- */
const herman = loadFixture(P.herman);
const href = readJSON(P.hermanref);
const ring = hermanRing(P.gis);
console.log("\n§9.2  overtopping — " + herman.meta.sw + " x " + herman.meta.sh + " cells of the " +
            herman.meta.cell + "-ft grid, seed ring " + ring.length + " vertices");

const [ovOut, ovMs] = timed(() => C.runJob("overtop", { grid: herman.grid, seedRing: ring }));
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
  console.log("        rim low " + c.rank + ": " + c.level.toFixed(2) + " ft (+" +
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
console.log("        stage rings at the spill: " + (stageAt(ov.stage, 1343.83) || { rings: [] }).rings.length +
            ";  band cells " + ov.band.v.reduce((a, v) => a + (Number.isNaN(v) ? 0 : 1), 0) +
            ";  spill cells " + ov.spillMask.v.reduce((a, v) => a + v, 0));
budget("overtop", ovMs, 4000);

/* the overflow route: a raindrop from primary.next with the impoundment blocked */
const [rtOut, rtMs] = timed(() => C.runJob("flowpath",
  { grid: herman.grid, x: ov.primary.next[0], y: ov.primary.next[1], blockRing: ring }));
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
  console.log("        route pond " + (i + 1) + ": depth " + rt.ponds[i].depth_ft.toFixed(2) +
              " ft, " + rt.ponds[i].area_ft2.toFixed(0) + " ft2, " +
              rt.ponds[i].volume_ft3.toFixed(1) + " ft3 (ref " + href.route.ponds[i].volume_ft3 + ")");
}
console.log("        route " + rt.n + " vertices, unsimplified " + rt.lengthRaw_ft.toFixed(1) +
            " ft, ends " + rt.reason + " at " + rt.end[0].toFixed(0) + " / " + rt.end[1].toFixed(0));
budget("flowpath (overflow route)", rtMs, 1000);

/* ---- cross-checks beyond §9 --------------------------------------------
   Not golden numbers, but each one guards a path §9 does not reach and each is
   checked against something independent rather than against itself.          */
console.log("\ncross-checks (beyond §9)");

/* the unsimplified run must be the reference path vertex for vertex — the
   strongest single statement that the descent and the ponding agree with §2 */
const raw = C.runJob("flowpath", { grid: swale.grid, x: dropX, y: dropY, simplifyFt: 0 }).result;
exact("raw path vertices", raw.n, dref.n);
near("raw path length", raw.length_ft, dref.length_ft, 0.05, " ft");

/* a point seed (the "pond under a click" entry point) must find the same spill
   as the polygon seed — same terrain, different way in */
const ctr = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
const [pOut, pMs] = timed(() => C.runJob("overtop",
  { grid: herman.grid, seedPoint: ctr }));
const pv = pOut.result;
near("point-seed z0", pv.z0, ov.z0, 0.02, " ft");
near("point-seed spill level", pv.primary.level, ov.primary.level, 0.05, " ft");
dist("point-seed spill cell", pv.primary.x, pv.primary.y, ov.primary.x, ov.primary.y, 15);
pct("point-seed storage", pv.storage_ft3, ov.storage_ft3, 3);
budget("overtop (point seed)", pMs, 4000);

/* §9.1's note: the drop at E 6371600 N 2128900 falls into a 4.5-ft-deep,
   1,878-cell pond and then leaves the window. The note's 1,069 ft is measured in
   a window centred on THAT drop; here the same drop sits off-centre in the swale
   fixture, so it reaches the window edge sooner — the pond is the check. */
const wc = C.runJob("flowpath", { grid: swale.grid, x: 6371600 - sc / 2, y: 2128900 - sc / 2 }).result;
exact("window-chain reason", wc.reason, "window");
row("window-chain exit", wc.exit ? "present" : "null", "present", !!wc.exit, "not null");
near("window-chain pond depth", wc.ponds[0].depth_ft, 4.46, 0.05, " ft");
near("window-chain pond cells", wc.ponds[0].cells, 1878, 2, "");

/* refusals must be refusals, not silent nonsense */
row("seed off the grid", C.runJob("overtop", { grid: herman.grid, seedRing: [[0, 0], [1, 0], [1, 1]] }).result.reason,
    "noseed", C.runJob("overtop", { grid: herman.grid, seedRing: [[0, 0], [1, 0], [1, 1]] }).result.reason === "noseed", "exact");
let threw = "";
try { C.runJob("flowpath", { grid: herman.grid, x: herman.grid.x0, y: herman.grid.y0 }); }
catch (e) { threw = e.message; }
row("drop outside the window", threw ? "throws" : "silent", "throws", !!threw, "exact", threw);

console.log("\n" + (fails ? "FAILED " + fails + " of " + checks : "PASSED all " + checks) +
            " checks" + (warns ? "; " + warns + " over budget" : "") + ".");
process.exit(fails ? 1 : 0);
