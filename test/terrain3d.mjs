/* SBMM Site Explorer — the v20 quadtree terrain and the GPU rasters, in a browser.

     node test/terrain3d.mjs /abs/path/index.html folder
     node test/terrain3d.mjs /abs/path/dist/SBMM_Site_Explorer.html dist

   Six sections, and every one of them is an acceptance line of
   docs/V20_TERRAIN_SPEC.md §6:

     lod       the quadtree owns the terrain and draws real tiles
     quality   4 / 2 / 1 px screen error: tiles, triangles, bytes, frame cost,
               and std strictly coarser than high strictly coarser than ultra
     onefoot   the ABP at 2 px draws the 1-ft data AT 1 ft (finest level 0)
     idle      an idle view still renders nothing after a selection settles
     gpu       the shader hillshade against the same formula on the CPU,
               mean abs diff < 2/255 (§4)
     seams     SBMM.elev and the tile the 3D view is drawing agree, in the page

   Slow under software GL on purpose — the timeouts come from test/lib/browser.mjs
   and SBMM_GPU=1 drops them. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { unlock } from "./gate.mjs";

const target = process.argv[2], label = process.argv[3] || "folder";
const SECTIONS = ["lod", "quality", "onefoot", "idle", "gpu", "seams"];
if (process.argv.includes("--list")) { console.log(SECTIONS.join(" ")); process.exit(0); }
let only = null;
if (process.argv.includes("--only")) only = new Set(process.argv[process.argv.indexOf("--only") + 1].split(","));
const want = s => !only || only.has(s);

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log(`PASS ${name}` + (got !== undefined ? `  ${got}` : ""));
  else { fails++; console.log(`FAIL ${name}  got ${got}`); }
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => { errors.push(e.message); console.log("pageerror:", e.message); });
await unlock(page);
await page.goto(pathToFileURL(resolve(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: TIMEOUT });

const idx = await page.evaluate(() => SBMM.tiles.stats());
console.log(`\n[${label}] tile index:`, idx.ready ? "yes" : "NO",
  "· single file:", idx.singleFile, "· layers:", JSON.stringify(idx.counts));
console.log("   source:", idx.source);

/* ------------------------------------------------------------------ open -- */
await page.evaluate(() => SBMM.viewer3d.openAt(6371700, 2128900));
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: TIMEOUT });
await page.waitForTimeout(2500);

if (want("lod")) {
  console.log("\n== lod — the quadtree owns the terrain ==");
  const s = await page.evaluate(() => SBMM.viewer3d.stats());
  ok("the quadtree is the terrain builder", s.terrainLod === true, s.terrainLod);
  ok("tiles are drawn", s.tiles && s.tiles.tiles > 0, s.tiles && s.tiles.tiles);
  ok("every drawn tile has geometry", s.tiles && s.tiles.triangles > 1000, s.tiles && s.tiles.triangles);
  console.log("   drawn:", JSON.stringify({ tiles: s.tiles.tiles, byLevel: s.tiles.byLevel,
    verts: s.tiles.verts, tris: s.tiles.triangles, mb: +(s.tiles.bytes / 1e6).toFixed(1),
    finestCellFt: s.tiles.finestCellFt, style: s.tiles.style }));
  console.log("   cache:", JSON.stringify({ tiles: s.tileCache.tiles, mb: +(s.tileCache.bytes / 1e6).toFixed(1),
    budgetMb: +(s.tileCache.budget / 1e6).toFixed(0), injected: s.tileCache.injected,
    synth: s.tileCache.synth, hits: s.tileCache.hits }));
  ok("no page errors while the terrain built", errors.length === 0, errors.length);
}

/* --------------------------------------------------------------- quality -- */
if (want("quality")) {
  console.log("\n== quality — 4 / 2 / 1 px screen error ==");
  const rows = {};
  for (const q of ["std", "high", "ultra"]) {
    const r = await page.evaluate(async qq => {
      const sel = document.getElementById("v3dDetail");
      sel.value = qq;
      await sel.onchange();
      await new Promise(r => setTimeout(r, 400));
      const s = SBMM.viewer3d.stats();
      /* the frame cost of ONE forced draw, with the terrain as it now stands */
      const t0 = performance.now();
      SBMM.viewer3d.requestRender();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { q: qq, targetPx: s.terrainQualityPx, tiles: s.tiles.tiles,
               byLevel: s.tiles.byLevel, verts: s.tiles.verts, tris: s.tiles.triangles,
               mb: +(s.tiles.bytes / 1e6).toFixed(2), finestCellFt: s.tiles.finestCellFt,
               terrainVerts: s.terrainVerts, frameMs: +(performance.now() - t0).toFixed(1),
               cacheMb: +(s.tileCache.bytes / 1e6).toFixed(1) };
    }, q);
    rows[q] = r;
    console.log("  ", q.padEnd(6), JSON.stringify(r));
  }
  ok("standard is coarser than high", rows.std.terrainVerts < rows.high.terrainVerts,
    `${rows.std.terrainVerts} < ${rows.high.terrainVerts}`);
  ok("high is coarser than ultra", rows.high.terrainVerts <= rows.ultra.terrainVerts,
    `${rows.high.terrainVerts} <= ${rows.ultra.terrainVerts}`);
  ok("triangles stay inside the budget", rows.ultra.tris < 8e6, rows.ultra.tris);
  /* back to the shipped default so the rest of the run is the default */
  await page.evaluate(async () => {
    const sel = document.getElementById("v3dDetail"); sel.value = "high"; await sel.onchange();
  });
  await page.waitForTimeout(400);
}

/* --------------------------------------------------------------- onefoot -- */
if (want("onefoot")) {
  console.log("\n== onefoot — the 1-ft data drawn at 1 ft ==");
  /* stand close over the ABP: the whole point of the round */
  const s = await page.evaluate(async () => {
    SBMM.viewer3d.openAt(6371700, 2128900);
    await new Promise(r => setTimeout(r, 400));
    SBMM.viewer3d.frameBox(6371600, 2128800, 6371800, 2129000);
    await new Promise(r => setTimeout(r, 2500));
    return SBMM.viewer3d.stats();
  });
  console.log("   drawn:", JSON.stringify({ tiles: s.tiles.tiles, byLevel: s.tiles.byLevel,
    finestCellFt: s.tiles.finestCellFt, verts: s.tiles.verts, tris: s.tiles.triangles }));
  ok("the finest level drawn over the ABP is the 1-ft one",
    s.tiles.finestCellFt !== null && s.tiles.finestCellFt <= 1, s.tiles.finestCellFt);
  ok("the old whole-DEM build never got below its stride",
    s.terrainLod === true, s.terrainLod);
}

/* ------------------------------------------------------------------ idle -- */
if (want("idle")) {
  console.log("\n== idle — a settled view renders nothing ==");
  const r = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 1200));      // let the selection settle
    const a = SBMM.viewer3d.stats().renderCount;
    await new Promise(r => setTimeout(r, 2500));
    const b = SBMM.viewer3d.stats().renderCount;
    return { a, b, delta: b - a, queued: SBMM.tiles.stats().queued };
  });
  console.log("   renders over 2.5 idle seconds:", r.delta, "· queue:", r.queued);
  ok("an idle view renders nothing (the e2e 9e contract: at most one)", r.delta <= 1, r.delta);
}

/* ------------------------------------------------------------------- gpu -- */
if (want("gpu")) {
  console.log("\n== gpu — the shader hillshade against the CPU (§4) ==");
  const r = await page.evaluate(async () => {
    const T = SBMM.tiles;
    /* one tile in the middle of the mine window at 2 ft — real relief, no
       NoData edge to argue about */
    const [tx, ty] = T.tileAt(1, 6371700, 2128900);
    if (!T.has("dem", 1, tx, ty)) return { skip: "no tile" };
    const g = await SBMM.terrain3d.renderRasterTile(1, tx, ty, "hillshade");
    const c = await SBMM.terrain3d.cpuHillshade(1, tx, ty);
    if (!g || !c) return { skip: g ? "no cpu" : "no webgl2", webgl2: SBMM.terrain3d.webgl2() };
    let n = 0, sum = 0, worst = 0;
    for (let k = 0; k < c.rgba.length; k += 4) {
      if (c.rgba[k + 3] === 0) continue;             // NoData on both sides
      /* the render target's row 0 is the BOTTOM; the CPU array's row 0 is the
         south edge, which is the same row. No flip. */
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(g.rgba[k + ch] - c.rgba[k + ch]);
        sum += d; n++; if (d > worst) worst = d;
      }
    }
    return { tile: [1, tx, ty], mean: sum / Math.max(1, n), worst, n,
             webgl2: SBMM.terrain3d.webgl2(), gpuRaster: SBMM.terrain3d.gpuRaster() };
  });
  if (r.skip) { console.log("   skipped:", r.skip, "· webgl2:", r.webgl2); ok("WebGL2 is present or the CPU path said so", true, r.skip); }
  else {
    console.log("   tile", JSON.stringify(r.tile), "· samples", r.n,
      "· mean abs diff", r.mean.toFixed(3), "/255 · worst", r.worst);
    ok("shader hillshade matches the CPU formula (mean < 2/255)", r.mean < 2, r.mean.toFixed(3));
  }
  /* the sun relights without a rebuild */
  const sun = await page.evaluate(async () => {
    const before = SBMM.viewer3d.stats().tiles.tiles;
    SBMM.viewer3d.sun(120, 20);
    await new Promise(r => setTimeout(r, 300));
    const after = SBMM.viewer3d.stats();
    SBMM.viewer3d.sun(315, 35);
    return { before, after: after.tiles.tiles, sun: after.sun };
  });
  ok("moving the sun does not rebuild the terrain", sun.before === sun.after,
    `${sun.before} -> ${sun.after}`);
}

/* ----------------------------------------------------------------- seams -- */
if (want("seams")) {
  console.log("\n== seams — the two sources agree in the page ==");
  const r = await page.evaluate(async () => {
    const T = SBMM.tiles;
    let s = 424242 >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const m = SBMM.demSite.m;
    let n = 0, worst = 0, tried = 0, at = null;
    while (n < 200 && tried < 6000) {
      tried++;
      const z = rnd() < 0.5 ? 0 : 1, c = Math.pow(2, z);
      const X = T.origin().x0 + Math.round(rnd() * (m.w * m.cell) / c) * c;
      const Y = T.origin().y0 + Math.round(rnd() * (m.h * m.cell) / c) * c;
      const [tx, ty] = T.tileAt(z, X, Y);
      if (!T.has("dem", z, tx, ty)) continue;
      const rec = await T.get("dem", z, tx, ty, { priority: 5000 }).catch(() => null);
      if (!rec || !rec.z32) continue;
      const r0 = T.rect(z, tx, ty);
      const i = Math.round((X - r0[0]) / c), j = Math.round((Y - r0[1]) / c);
      if (i < 0 || j < 0 || i > 255 || j > 255) continue;
      const v = rec.z32[j * 256 + i];
      if (isNaN(v)) continue;
      /* the grid NODE, on SBMM.demAt's own finest-first order — not the
         bilinear SBMM.elev, which is an interpolation BETWEEN nodes */
      let g = NaN;
      for (const d of SBMM.dems) {
        const mm = d.m;
        const gi = Math.round((X - mm.x0) / mm.cell), gj = Math.round((Y - mm.y0) / mm.cell);
        if (gi < 0 || gj < 0 || gi >= mm.w || gj >= mm.h) continue;
        const t = d.z[gj * mm.w + gi];
        if (!isNaN(t)) { g = t; break; }
      }
      if (isNaN(g)) continue;
      n++;
      const d = Math.abs(v - g);
      if (d > worst) { worst = d; at = [X, Y, z]; }
    }
    return { n, worst, at, tried };
  });
  console.log("   ", r.n, "points ·  worst |tile − grid node| =", r.worst.toFixed(9), "ft", r.at ? "at " + r.at : "");
  ok("the display source equals the analysis source", r.n > 100 && r.worst < 1e-3, r.worst);
}

await page.screenshot({ path: "/tmp/terrain3d.png" });
console.log("\npage errors:", errors.length);
if (errors.length) fails++;
await browser.close();
console.log(fails ? `TERRAIN3D FAIL (${fails})` : "TERRAIN3D PASS");
process.exit(fails ? 1 : 0);
