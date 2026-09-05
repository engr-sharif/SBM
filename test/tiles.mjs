/* SBMM Site Explorer — the tile pyramid, in node (v20 §2).

   THE ONE QUESTION THIS ANSWERS: do the two sources agree?
   The whole-site grids are the ANALYSIS source — every kernel, every golden,
   every quantity someone digs from is measured on them. The pyramid is the
   DISPLAY and 3D source. If they can disagree, the 3D view is drawing a
   different site from the one the numbers describe, and nobody would ever see
   it. So 1,000 pseudo-random surveyed points are sampled through both, at the
   finest level each point has, and required to be equal to the terrain-RGB
   step (0.02 ft) — not to a tolerance, because the arithmetic in
   tools/build_tiles.py makes them the same grid nodes.

   It also checks the things the loader trusts the index about: that every tile
   the index lists exists on disk and no tile on disk is unlisted, that no tile
   exceeds the 200 kB cap, that a level-0 tile is whole (the coverage rule the
   3D view's quadtree depends on), and that the pyramid's coarse levels are
   decimations of the fine ones rather than averages.

       node test/tiles.mjs                 # every section
       node test/tiles.mjs --only agree
       node test/tiles.mjs --list

   No browser, ~20 s. Run it after any change to tools/build_tiles.py or to
   js/tiles.js's synthesis path. */
import fs from "node:fs";
import path from "node:path";
import { REPO, loadDem, dems, elev } from "./lib/terrain.mjs";
import { decodePNG } from "./lib/png.mjs";

const TILES = path.join(REPO, "datajs", "tiles");
const SECTIONS = ["index", "agree", "coarse", "coverage"];
const argv = process.argv.slice(2);
if (argv.includes("--list")) { console.log(SECTIONS.join(" ")); process.exit(0); }
let only = null;
if (argv.includes("--only")) only = new Set(argv[argv.indexOf("--only") + 1].split(","));
const want = s => !only || only.has(s);

let pass = 0, fail = 0;
function check(name, ok, got, ref, tol) {
  if (ok) { pass++; console.log(`PASS ${name}` + (got !== undefined ? `  got ${got}` : "")); }
  else { fail++; console.log(`FAIL ${name}  got ${got}  ref ${ref}` + (tol !== undefined ? `  tol ${tol}` : "")); }
}

/* ------------------------------------------------------------- the index -- */
function readIndex() {
  const src = fs.readFileSync(path.join(TILES, "index.js"), "utf8");
  const m = src.match(/SBMM_TILES\.index=([\s\S]+);\s*$/);
  if (!m) throw new Error("datajs/tiles/index.js is not the shape js/tiles.js reads");
  return JSON.parse(m[1]);
}
const IDX = readIndex();
const TILE = IDX.tileSize, OX = IDX.origin.x0, OY = IDX.origin.y0;
const cellOf = z => Math.pow(2, z);

function tilePath(layer, z, x, y) {
  return path.join(TILES, `${layer}_${z}_${x}_${y}.js`);
}
/* Decode one tile payload the way js/tiles.js does: a data: URL out of the
   payload, then the terrain-RGB loop, south-up. */
const tileCache = new Map();
function readTile(layer, z, x, y) {
  const key = `${layer}/${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const p = tilePath(layer, z, x, y);
  if (!fs.existsSync(p)) { tileCache.set(key, null); return null; }
  const src = fs.readFileSync(p, "utf8");
  const m = src.match(/base64,([A-Za-z0-9+/=]+)"/);
  const buf = Buffer.from(m[1], "base64");
  const img = decodePNG(buf);
  const L = IDX.layers[layer];
  const zmin = L.zmin, step = L.step;
  const ch = img.channels;
  const out = new Float32Array(TILE * TILE);
  for (let r = 0; r < TILE; r++) {
    for (let i = 0; i < TILE; i++) {
      const k = (r * TILE + i) * ch, v = img.data[k] * 256 + img.data[k + 1];
      out[(TILE - 1 - r) * TILE + i] = v === 0 ? NaN : zmin + (v - 1) * step;
    }
  }
  if (tileCache.size > 40) tileCache.clear();
  tileCache.set(key, out);
  return out;
}
/* the tile a point falls in at a level, and the sample under it */
function tileSample(layer, z, X, Y) {
  const span = TILE * cellOf(z);
  const tx = Math.floor((X - OX) / span), ty = Math.floor((Y - OY) / span);
  const li = IDX.layers[layer].levels[String(z)];
  if (!li) return { miss: "level" };
  if (!li.tiles.some(t => t[0] === tx && t[1] === ty)) return { miss: "tile", tx, ty };
  const a = readTile(layer, z, tx, ty);
  if (!a) return { miss: "file", tx, ty };
  const c = cellOf(z);
  const i = Math.round((X - (OX + tx * span)) / c);
  const j = Math.round((Y - (OY + ty * span)) / c);
  if (i < 0 || j < 0 || i >= TILE || j >= TILE) return { miss: "px", tx, ty };
  return { v: a[j * TILE + i], tx, ty, i, j };
}

/* --------------------------------------------------------------- sections -- */
if (want("index")) {
  const t0 = Date.now();
  console.log("\n== index — what the loader is allowed to trust ==");
  check("index version is 1", IDX.version === 1, IDX.version, 1);
  check("tile size is 256", TILE === 256, TILE, 256);
  check("origin is the site DEM's SW corner",
    OX === 6368100 && OY === 2122800, `${OX},${OY}`, "6368100,2122800");
  check("source names the rasters it was built from",
    /data\/\*\.png/.test(IDX.source), JSON.stringify(IDX.source).slice(0, 60));

  const onDisk = new Set(fs.readdirSync(TILES).filter(f => f.endsWith(".js") && f !== "index.js"));
  let listed = 0, absent = 0, oversize = 0, maxB = 0;
  for (const [layer, L] of Object.entries(IDX.layers)) {
    for (const [z, li] of Object.entries(L.levels)) {
      for (const [x, y, b] of li.tiles) {
        listed++;
        const f = `${layer}_${z}_${x}_${y}.js`;
        if (!onDisk.delete(f)) absent++;
        if (b > 200 * 1024) oversize++;
        if (b > maxB) maxB = b;
      }
    }
  }
  check("every listed tile is on disk", absent === 0, absent, 0);
  check("no tile on disk is unlisted", onDisk.size === 0, onDisk.size, 0);
  check("no tile over the 200 kB cap", oversize === 0,
    `${oversize} over, largest ${(maxB / 1024).toFixed(0)} kB`, 0);
  const bytes = {}, counts = {};
  for (const [layer, L] of Object.entries(IDX.layers)) {
    bytes[layer] = Object.values(L.levels).reduce((n, l) => n + l.bytes, 0);
    counts[layer] = Object.values(L.levels).reduce((n, l) => n + l.count, 0);
  }
  console.log("   tiles per layer:", JSON.stringify(counts));
  console.log("   payload MB    :", JSON.stringify(Object.fromEntries(
    Object.entries(bytes).map(([k, v]) => [k, +(v / 1e6).toFixed(2)]))));
  console.log(`   ${listed} tiles listed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

/* THE ACCEPTANCE TEST (spec §2, "the seams").

   WHAT IS COMPARED, AND WHY IT IS NODE AGAINST NODE.
   A tile pixel IS a grid node — tools/build_tiles.py samples the nearest node
   and never averages — so the comparison that means something is the tile
   against the grid node under it, on the same finest-first stack SBMM.demAt
   walks. Comparing it against the bilinear SBMM.elev at an arbitrary point
   would be comparing a sample with an interpolation between samples: on the
   2-ft grid that is legitimately up to half a cell of relief (1.17 ft was the
   worst of 1,000 here) and it says nothing about whether the two sources
   agree. The bilinear spread is reported beside it for exactly that reason —
   it is the interpolation, not a disagreement. */
if (want("agree")) {
  const t0 = Date.now();
  console.log("\n== agree — the tile pyramid against the analysis grids ==");
  const D = dems();
  /* the grid node under a point, on SBMM.demAt's own order: finest first, the
     first grid that has data there wins */
  const nodeOf = (X, Y) => {
    for (const d of D) {
      const m = d.m;
      const i = Math.round((X - m.x0) / m.cell), j = Math.round((Y - m.y0) / m.cell);
      if (i < 0 || j < 0 || i >= m.w || j >= m.h) continue;
      const v = d.z[j * m.w + i];
      if (!isNaN(v)) return { v, cell: m.cell };
    }
    return null;
  };
  /* a small deterministic PRNG so the 1,000 points are the same every run */
  let s = 20260905 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const site = D[D.length - 1].m;
  const X1 = site.x0 + (site.w - 1) * site.cell, Y1 = site.y0 + (site.h - 1) * site.cell;

  let n = 0, tried = 0, worst = 0, worstAt = null, holes = 0, bilinWorst = 0;
  const levelsUsed = {};
  while (n < 1000 && tried < 60000) {
    tried++;
    let X = Math.round(site.x0 + rnd() * (X1 - site.x0));
    let Y = Math.round(site.y0 + rnd() * (Y1 - site.y0));
    if (!isFinite(elev(X, Y))) continue;             // outside the survey
    /* the finest level the pyramid has here — what the 3D view draws when the
       camera is close enough to ask for it. The point is snapped onto that
       level's lattice, which is where both sources have a sample. */
    let got = null, usedZ = null;
    for (const z of [0, 1, 2, 3, 4, 5, 6]) {
      const c = cellOf(z);
      const sx = OX + Math.round((X - OX) / c) * c, sy = OY + Math.round((Y - OY) / c) * c;
      const r = tileSample("dem", z, sx, sy);
      if (r.miss) continue;
      if (isNaN(r.v)) { if (z <= 1) continue; break; }
      got = r.v; usedZ = z; X = sx; Y = sy; break;
    }
    if (got === null) { holes++; continue; }
    const nd = nodeOf(X, Y);
    if (!nd) { holes++; continue; }
    n++;
    levelsUsed[usedZ] = (levelsUsed[usedZ] || 0) + 1;
    const d = Math.abs(got - nd.v);
    if (d > worst) { worst = d; worstAt = [X, Y, usedZ, nd.v, got]; }
    const b = elev(X, Y);
    if (isFinite(b)) bilinWorst = Math.max(bilinWorst, Math.abs(got - b));
  }
  check("1,000 surveyed points sampled", n === 1000, n, 1000);
  console.log("   finest level used:", JSON.stringify(levelsUsed),
    "· points with no tile:", holes, "of", tried, "tried");
  /* The two must be EQUAL. They are the same grid node through the same
     quantisation, so the only difference possible is the float32 round trip. */
  check("tile equals the grid node to the terrain-RGB step", worst <= 0.02,
    worst.toFixed(6) + " ft" + (worstAt ? " at " + worstAt.slice(0, 3).join(",") : ""), "<= 0.02");
  check("tile equals the grid node exactly (float32)", worst < 1e-3,
    worst.toFixed(9) + " ft", "< 0.001");
  console.log("   bilinear SBMM.elev at the same points differs by up to",
    bilinWorst.toFixed(3), "ft — that is the interpolation between nodes,",
    "not a disagreement between the sources");
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

/* A coarse tile must be a DECIMATION of the fine data, not an average of it —
   that is what lets a coarse tile stand in for a fine one without moving the
   ground under a measurement. */
if (want("coarse")) {
  console.log("\n== coarse — every level is a decimation of the grid ==");
  const D = dems();
  let s = 7654321 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const site = D[D.length - 1].m;
  for (const z of [1, 2, 3, 4]) {
    let n = 0, worst = 0, tried = 0;
    while (n < 120 && tried < 6000) {
      tried++;
      const c = cellOf(z);
      const X = OX + Math.round(rnd() * (site.w * site.cell) / c) * c;
      const Y = OY + Math.round(rnd() * (site.h * site.cell) / c) * c;
      const g = elev(X, Y);
      if (!isFinite(g)) continue;
      const r = tileSample("dem", z, X, Y);
      if (r.miss || isNaN(r.v)) continue;
      n++;
      worst = Math.max(worst, Math.abs(r.v - g));
    }
    check(`z${z} (${cellOf(z)} ft) is the grid node, not a mean`, n > 50 && worst < 1e-3,
      `${n} pts, worst ${worst.toFixed(9)} ft`, "< 0.001");
  }
}

/* The renderer drops a coarse tile only where all four of its children exist.
   That is exact ONLY because a level-0 tile is written whole. */
if (want("coverage")) {
  console.log("\n== coverage — a level-0 tile is whole ==");
  const abp = loadDem("dem_abp").m, res = loadDem("dem_res").m;
  const rects = [
    [abp.x0, abp.y0, abp.x0 + (abp.w - 1) * abp.cell, abp.y0 + (abp.h - 1) * abp.cell],
    [res.x0, res.y0, res.x0 + (res.w - 1) * res.cell, res.y0 + (res.h - 1) * res.cell]];
  const inUnion = (r) => {
    let rem = [r];
    for (const q of rects) {
      const nxt = [];
      for (const a of rem) {
        if (q[2] <= a[0] || q[0] >= a[2] || q[3] <= a[1] || q[1] >= a[3]) { nxt.push(a); continue; }
        if (a[1] < q[1]) nxt.push([a[0], a[1], a[2], q[1]]);
        if (a[3] > q[3]) nxt.push([a[0], q[3], a[2], a[3]]);
        const y0 = Math.max(a[1], q[1]), y1 = Math.min(a[3], q[3]);
        if (y1 > y0) {
          if (a[0] < q[0]) nxt.push([a[0], y0, q[0], y1]);
          if (a[2] > q[2]) nxt.push([q[2], y0, a[2], y1]);
        }
      }
      rem = nxt;
      if (!rem.length) return true;
    }
    return false;
  };
  const l0 = IDX.layers.dem.levels["0"];
  let outside = 0;
  for (const [x, y] of l0.tiles) {
    const span = TILE * 1;
    if (!inUnion([OX + x * span, OY + y * span, OX + (x + 1) * span, OY + (y + 1) * span])) outside++;
  }
  check("every level-0 tile lies wholly inside the 1-ft windows", outside === 0, outside, 0);
  /* and a level-1 parent of four level-0 children must itself exist, or the
     renderer has nothing to fall back to while they load */
  const have0 = new Set(l0.tiles.map(t => t[0] + "," + t[1]));
  const l1 = new Set(IDX.layers.dem.levels["1"].tiles.map(t => t[0] + "," + t[1]));
  let orphan = 0;
  for (const k of have0) {
    const [x, y] = k.split(",").map(Number);
    if (!l1.has(Math.floor(x / 2) + "," + Math.floor(y / 2))) orphan++;
  }
  check("every level-0 tile has its level-1 parent", orphan === 0, orphan, 0);
}

console.log(`\n${pass + fail} checks, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
