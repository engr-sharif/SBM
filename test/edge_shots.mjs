/* SBMM Site Explorer — the v46 survey-edge shots. Not pass-fail: look at them.

     node test/edge_shots.mjs [index.html] [outdir] [--standard]

   edge_east     the eastern limit of the survey from above the hills
   edge_south    the southern limit, low and oblique
   edge_site     the whole site: land limits fade, the lake shore does not

   --standard writes the same frames under the lighter rendering, where the
   ground still ends in a cut (suffix _standard) — the before. */
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const STD = process.argv.includes("--standard");
const INDEX = args[0] || resolve(HERE, "..", "index.html");
const OUT = args[1] || resolve(HERE, "shots");
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "edge_shots" });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", e => errs.push(String(e)));
await unlock(page, resolve(INDEX, ".."));
await page.goto(pathToFileURL(INDEX).href);
await page.waitForFunction(() => document.getElementById("loading").style.display === "none", null, { timeout: 180000 });
await lateSettled(page);
const wait = ms => page.waitForTimeout(ms);
const shot = async n => { const f = n + (STD ? "_standard" : "") + ".png"; await page.screenshot({ path: resolve(OUT, f) }); console.log("wrote", f); };
await page.evaluate(() => { SBMM.shell.collapse("r", true); SBMM.shell.collapse("l", true); });
await page.evaluate(() => SBMM.layerState.set("base", "trees_detected", { on: true }));
await page.waitForFunction(() => SBMM.trees && SBMM.trees.data, null, { timeout: 120000 });
await page.evaluate(async () => { await SBMM.viewer3d.toggle(); });
await page.evaluate(std => { SBMM.viewer3d.sunAsPhotographed(); if (std) SBMM.viewer3d.setQuality("standard"); }, STD);
const settle = async () => {
  for (let k = 0; k < 2; k++) {
    await wait(3500);
    await page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return s && !(s.tiles && s.tiles.building); },
      null, { timeout: 180000 }).catch(() => {});
  }
  await wait(5000);
};
const cam = (x, y, z, tx, ty, tz) => page.evaluate(async a => { await SBMM.viewer3d.lookFrom(...a); }, [x, y, z, tx, ty, tz]);
console.log("edge:", JSON.stringify(await page.evaluate(() => SBMM.terrain3d.edgeInfo ? SBMM.terrain3d.edgeInfo() : null)));
await cam(6374300, 2125200, 3000, 6376600, 2127000, 1700); await settle(); await shot("edge_east");
await cam(6372200, 2123900, 2100, 6373400, 2125200, 1500); await settle(); await shot("edge_south");
await cam(6369600, 2125400, 3300, 6372400, 2128300, 1400); await settle(); await shot("edge_site");
if (STD) await page.evaluate(() => SBMM.viewer3d.setQuality("realistic"));
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
