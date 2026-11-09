/* SBMM Site Explorer — run the app's own tree detector outside the app.

   tools/build_trees.py calls this. There is ONE tree detector — the "trees"
   kernel in js/compute.js — and this script runs that same source over a
   canopy height raster, so the baked tree table and a detection run inside
   the app can never disagree about what a tree is.

     node tools/trees_detect.mjs site  OUT.json
         the repo's own canopy model (data/chm.png, the Jan-2024 site lidar)
     node tools/trees_detect.mjs raw   OUT.json  CHM.f32  X0 Y0 CELL W H
         a raw little-endian Float32 canopy raster, SOUTH-UP (row 0 = Y0),
         NaN where there is no canopy model

   Output: { n, x[], y[], h[], area[], radius[], maxima, dropped, ms } */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const file = path.join(REPO, "js", "compute.js");
vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
const C = globalThis.SBMM_COMPUTE;
if (!C) throw new Error("js/compute.js did not define SBMM_COMPUTE");

const [mode, out, ...rest] = process.argv.slice(2);
let grid;
if (mode === "site") {
  const T = await import(path.join(REPO, "test", "lib", "terrain.mjs"));
  const chm = T.loadDem("chm");
  grid = T.gridSpec(chm);
} else if (mode === "raw") {
  const [f32, x0, y0, cell, w, h] = rest;
  const buf = fs.readFileSync(f32);
  const z = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const W = +w, H = +h;
  if (z.length !== W * H) throw new Error(`raster is ${z.length} cells, expected ${W * H}`);
  grid = { x0: +x0, y0: +y0, cell: +cell, w: W, h: H, i0: 0, j0: 0, sw: W, sh: H, z: Float32Array.from(z) };
} else {
  console.error("usage: trees_detect.mjs site|raw OUT.json [CHM.f32 X0 Y0 CELL W H]");
  process.exit(2);
}

const t0 = performance.now();
/* the same job js/trees.js detect() builds: 6-ft minimum, 4-cell minimum crown */
const R = C.runJob("trees", { grid, minH: 6, minCrown: 4 }).result;
const ms = Math.round(performance.now() - t0);
const r1 = v => Math.round(v * 10) / 10;
fs.writeFileSync(out, JSON.stringify({
  n: R.n, maxima: R.maxima, dropped: R.dropped, ms,
  x: Array.from(R.x, r1), y: Array.from(R.y, r1), h: Array.from(R.h, r1),
  area: Array.from(R.area, v => Math.round(v)), radius: Array.from(R.radius, r1)
}));
console.log(`${mode}: ${R.n} trees in ${ms} ms (${R.maxima} maxima, ${R.dropped} dropped)`);
