/* SBMM Site Explorer — the v20 §6 shots.  Not pass-fail; look at them.

     node test/terrain_shots.mjs /abs/path/index.html

   tiles_abp_1ft.png   the mine window close in, drawn at 1 ft from level-0 tiles
   tiles_site.png      the whole site, the quadtree coarsening away from the eye
   gpu_hillshade.png   the shader hillshade with the sun moved, no raster recomputed */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { unlock } from "./gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on("pageerror", e => console.log("pageerror:", e.message, "\n", (e.stack || "").split("\n").slice(0, 4).join("\n")));
await unlock(page);
await page.goto(pathToFileURL(resolve(process.argv[2] || "index.html")).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: TIMEOUT });

const settle = async ms => { await page.waitForTimeout(ms || 3500); };
const say = async tag => {
  const s = await page.evaluate(() => SBMM.viewer3d.stats());
  console.log(tag, JSON.stringify({ tiles: s.tiles.tiles, byLevel: s.tiles.byLevel,
    finestCellFt: s.tiles.finestCellFt, verts: s.tiles.verts, tris: s.tiles.triangles,
    cacheMb: +(s.tileCache.bytes / 1e6).toFixed(1) }));
};

await page.evaluate(() => SBMM.viewer3d.openAt(6371700, 2128900));
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: TIMEOUT });
await settle(4000);

/* 1. the mine window close in — the whole point of the round */
await page.evaluate(() => SBMM.viewer3d.frameBox(6371500, 2128700, 6371900, 2129100));
await settle(5000);
await say("tiles_abp_1ft:");
await page.screenshot({ path: join(SHOTS, "tiles_abp_1ft.png") });

/* 2. the whole site, coarsening away from the eye.
   The camera is placed and then the terrain is asked to catch up EXPLICITLY:
   the quadtree re-selects on a settled camera, and a screenshot taken before
   that has happened photographs the previous framing (which is exactly what
   the first version of this script did — two identical shots). */
await page.evaluate(() => { const m = SBMM.demSite.m;
  SBMM.viewer3d.frameBox(m.x0, m.y0, m.x0 + (m.w - 1) * m.cell, m.y0 + (m.h - 1) * m.cell); });
await settle(4000);
await page.waitForFunction(() => SBMM.tiles.stats().queued === 0, null, { timeout: TIMEOUT });
await settle(3000);
await say("tiles_site   :");
await page.screenshot({ path: join(SHOTS, "tiles_site.png") });

/* 3. the shader raster, relit */
await page.evaluate(async () => {
  await SBMM.viewer3d.openAt(6371700, 2128900);
  await new Promise(r => setTimeout(r, 800));
  const sel = document.getElementById("v3dStyle");
  sel.value = "hillshade";
  /* a real `change` event, not sel.onchange(): the toolbar's four-stage
     reflow can move this control into a popover, and calling the handler by
     hand is how this script used to throw three times a run */
  sel.dispatchEvent(new Event("change"));
  await new Promise(r => setTimeout(r, 1500));
  SBMM.viewer3d.sun(135, 22);
});
await settle(6000);
const g = await page.evaluate(() => ({ gpuRaster: SBMM.terrain3d.gpuRaster(),
                                       webgl2: SBMM.terrain3d.webgl2(),
                                       sun: SBMM.viewer3d.stats().sun }));
console.log("gpu_hillshade:", JSON.stringify(g));
await page.screenshot({ path: join(SHOTS, "gpu_hillshade.png") });

await browser.close();
console.log("wrote tiles_abp_1ft.png, tiles_site.png, gpu_hillshade.png -> test/shots/");
