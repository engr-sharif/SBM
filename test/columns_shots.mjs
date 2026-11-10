/* SBMM Site Explorer — the v47 shots. Not pass-fail: look at them.

     node test/columns_shots.mjs [index.html] [outdir] [--standard]

   columns_far      the borings and wells across the mine area: lines at a distance
   columns_near     a group of borings close up: columns in their log colours
   symbols_2d       the 2D point symbols over the photograph

   --standard writes the 3D frames under the lighter rendering (_standard). */
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

const browser = await launch({ name: "columns_shots" });
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
  const LS = SBMM.layerState, inv = LS.groupList().find(g => g.id === "invest");
  for (const r of inv.layers.values()) if (/wells|borings|test pits/i.test(r.label)) LS.set("invest", r.id, { on: true });
});
if (!STD) {
  await page.evaluate(() => { SBMM.map.fitBounds([[2128050, 6371750], [2128650, 6372650]], { animate: false }); });
  await wait(3000); await shot("symbols_2d");
}
await page.evaluate(async () => { await SBMM.viewer3d.toggle(); });
await page.evaluate(std => { SBMM.viewer3d.sunAsPhotographed(); SBMM.viewer3d.setGround("see"); if (std) SBMM.viewer3d.setQuality("standard"); }, STD);
const settle = async () => {
  for (let k = 0; k < 2; k++) {
    await wait(3500);
    await page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return s && !(s.tiles && s.tiles.building); },
      null, { timeout: 180000 }).catch(() => {});
  }
  await wait(5000);
};
const cam = (x, y, z, tx, ty, tz) => page.evaluate(async a => { await SBMM.viewer3d.lookFrom(...a); }, [x, y, z, tx, ty, tz]);
await cam(6371300, 2127600, 1900, 6372100, 2128500, 1400); await settle(); await shot("columns_far");
/* beside SB-9 */
const B = await page.evaluate(() => { const h = SBMM.borelogs && SBMM.borelogs.byId("SB-9"); return h ? [h.x, h.y, SBMM.elev(h.x, h.y)[0]] : null; });
if (B) { await cam(B[0] + 60, B[1] - 70, B[2] + 20, B[0], B[1], B[2] - 14); await settle(); await shot("columns_near"); }
await page.evaluate(() => { SBMM.viewer3d.setGround("auto"); SBMM.viewer3d.setQuality("realistic"); });
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
