/* SBMM Site Explorer — the v44 wide-line shots. Not pass-fail: look at them.

     node test/lines_shots.mjs [index.html] [outdir] [--standard]

   lines_lots       the residential lots: limits of excavation, lot lines, the storm network
   lines_close      the same linework close up, where a one-pixel line stair-steps
   lines_mine       decision units, piles and the 10-ft contours over the mine
   lines_far        the whole site: widths hold at any distance

   --standard writes the same frames under the lighter rendering (WebGL's own
   one-pixel lines and the drop shadow), with a _standard suffix — the before. */
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

const browser = await launch({ name: "lines_shots" });
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
await page.evaluate(() => {
  const LS = SBMM.layerState;
  for (const id of ["gis_exc", "gis_lots", "gis_repo", "gis_staging", "gis_haul"]) LS.set("design", id, { on: true });
  for (const id of ["dus", "piles", "storm_nodes", "storm_cad", "storm_inferred"]) LS.set("framework", id, { on: true });
  LS.set("base", "contours_site", { on: true });
});
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
await wait(3000);
console.log("wide:", JSON.stringify(await page.evaluate(() => SBMM.viewer3d.wideProbe ? SBMM.viewer3d.wideProbe() : null)));

await cam(6370250, 2128700, 1520, 6370700, 2129250, 1370); await settle(); await shot("lines_lots");
await cam(6370560, 2129020, 1420, 6370700, 2129230, 1362); await settle(); await shot("lines_close");
await cam(6371300, 2127600, 1900, 6372100, 2128500, 1400); await settle(); await shot("lines_mine");
await cam(6369600, 2125400, 3300, 6372400, 2128300, 1400); await settle(); await shot("lines_far");
if (STD) await page.evaluate(() => SBMM.viewer3d.setQuality("realistic"));
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
