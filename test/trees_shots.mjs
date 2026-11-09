/* SBMM Site Explorer — the v39 tree shots. Not pass-fail: look at them.

     node test/trees_shots.mjs [index.html] [outdir]

   trees_3d_grove      a stand of trees from a low oblique, mine area
   trees_3d_lots       the residential lots (USGS-lidar trees) with houses among them
   trees_3d_site       the whole site from above the lake
   trees_2d_crowns     the 2D crowns at true size
   trees_2d_site       the 2D layer zoomed out (dots) */
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const INDEX = process.argv[2] || resolve(HERE, "..", "index.html");
const OUT = process.argv[3] || resolve(HERE, "shots");
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "trees_shots" });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", e => errs.push(String(e)));
await unlock(page, resolve(INDEX, ".."));
await page.goto(pathToFileURL(INDEX).href);
await page.waitForFunction(() => document.getElementById("loading").style.display === "none", null, { timeout: 180000 });
await lateSettled(page);
const wait = ms => page.waitForTimeout(ms);
const shot = async n => { await page.screenshot({ path: resolve(OUT, n + ".png") }); console.log("wrote", n + ".png"); };

await page.evaluate(() => { SBMM.shell.collapse("r", true); SBMM.shell.collapse("l", true); });
await page.evaluate(() => SBMM.layerState.set("base", "trees_detected", { on: true }));
await page.waitForFunction(() => SBMM.trees && SBMM.trees.data, null, { timeout: 120000 });
console.log("trees:", JSON.stringify(await page.evaluate(() => SBMM.trees.stats())));

/* 2D */
await page.evaluate(() => { SBMM.map.fitBounds([[2128350, 6371050], [2128700, 6371600]], { animate: false }); });
await wait(2500); await shot("trees_2d_crowns");
await page.evaluate(() => { SBMM.map.fitBounds([[2125000, 6369500], [2130500, 6376000]], { animate: false }); });
await wait(2500); await shot("trees_2d_site");

/* 3D — settle(): the terrain refines on a settled camera, so wait for the drawn set */
await page.evaluate(async () => { await SBMM.viewer3d.toggle(); });
const settle = async () => {
  /* the quadtree re-selects on a settled camera and swaps its drawn set whole,
     so wait for a build to start AND finish, twice over, before the shutter */
  for (let k = 0; k < 2; k++) {
    await wait(3500);
    await page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return s && !(s.tiles && s.tiles.building); },
      null, { timeout: 180000 }).catch(() => {});
  }
  await wait(5000);
};
const cam = (x, y, z, tx, ty, tz) => page.evaluate(async a => { await SBMM.viewer3d.lookFrom(...a); }, [x, y, z, tx, ty, tz]);
const has = await page.evaluate(() => typeof SBMM.viewer3d.lookFrom === "function");
if (has) {
  await cam(6371130, 2128180, 1560, 6371420, 2128560, 1450); await settle(); await shot("trees_3d_grove");
  await cam(6370250, 2128700, 1520, 6370700, 2129250, 1370); await settle(); await shot("trees_3d_lots");
  await cam(6369600, 2125400, 3300, 6372400, 2128300, 1400); await settle(); await shot("trees_3d_site");
} else {
  await page.evaluate(() => SBMM.viewer3d.frameBox(6371000, 2128300, 6371700, 2128800));
  await settle(); await shot("trees_3d_grove");
}
console.log("3d:", JSON.stringify(await page.evaluate(() => SBMM.viewer3d.stats().trees)));
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
