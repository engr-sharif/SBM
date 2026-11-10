/* SBMM Site Explorer — the v50 shots. Not pass-fail: look at them.

     node test/analysis_shots.mjs [index.html] [outdir]

   analysis_2d_cover     the land-cover raster in 2D, shaded by the ground
   analysis_2d_elev      the elevation tint in 2D, shaded by the ground
   analysis_3d_cover     the land-cover drape in 3D, taking the relief */
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const INDEX = args[0] || resolve(HERE, "..", "index.html");
const OUT = args[1] || resolve(HERE, "shots");
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "analysis_shots" });
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
const fit = (x0, y0, x1, y1) => page.evaluate(b => { SBMM.map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { animate: false }); }, [x0, y0, x1, y1]);

await page.evaluate(() => { SBMM.layerState.set("framework", "runoff_cover", { on: true }); });
await fit(6371300, 2127300, 6373700, 2129000); await wait(4000); await shot("analysis_2d_cover");
await page.evaluate(() => {
  const LS = SBMM.layerState;
  LS.set("framework", "runoff_cover", { on: false });
  const base = LS.groupList().find(g => g.id === "base");
  for (const r of base.layers.values()) if (/elevation tint/i.test(r.label)) LS.set("base", r.id, { on: true });
});
await wait(9000); await shot("analysis_2d_elev");
await page.evaluate(() => {
  const LS = SBMM.layerState, base = LS.groupList().find(g => g.id === "base");
  for (const r of base.layers.values()) if (/elevation tint/i.test(r.label)) LS.set("base", r.id, { on: false });
  LS.set("framework", "runoff_cover", { on: true });
});
await page.evaluate(async () => { await SBMM.viewer3d.toggle(); });
await page.evaluate(() => SBMM.viewer3d.sunAsPhotographed());
await page.evaluate(async () => { await SBMM.viewer3d.lookFrom(6371300, 2127600, 1900, 6372100, 2128500, 1400); });
for (let k = 0; k < 2; k++) {
  await wait(3500);
  await page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return s && !(s.tiles && s.tiles.building); }, null, { timeout: 180000 }).catch(() => {});
}
await wait(6000); await shot("analysis_3d_cover");
console.log("drapes:", JSON.stringify(await page.evaluate(() => SBMM.viewer3d.stats().drapes)));
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
