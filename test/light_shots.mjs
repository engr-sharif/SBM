/* SBMM Site Explorer — the v40 light shots. Not pass-fail: look at them.

     node test/light_shots.mjs [index.html] [outdir]

   light_grove        trees and their cast shadows, the sun as photographed (180 / 33)
   light_lots         the residential lots under the same sun
   light_site         the whole site, haze to the horizon
   light_low_sun      the first pose again with the sun low in the west
   light_standard     the first pose under standard rendering (no shadow map) */
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const INDEX = process.argv[2] || resolve(HERE, "..", "index.html");
const OUT = process.argv[3] || resolve(HERE, "shots");
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "light_shots" });
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
await page.evaluate(() => { SBMM.layerState.set("base", "trees_detected", { on: true }); });
await page.waitForFunction(() => SBMM.trees && SBMM.trees.data, null, { timeout: 120000 });
await page.evaluate(async () => { await SBMM.viewer3d.toggle(); });
const settle = async () => {
  for (let k = 0; k < 2; k++) {
    await wait(3500);
    await page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return s && !(s.tiles && s.tiles.building); },
      null, { timeout: 180000 }).catch(() => {});
  }
  await wait(5000);
};
const cam = (...a) => page.evaluate(async q => { await SBMM.viewer3d.lookFrom(...q); }, a);
const auto0 = await page.evaluate(() => SBMM.viewer3d.sunAuto()), sun0 = await page.evaluate(() => SBMM.viewer3d.sun());
await page.evaluate(() => { SBMM.viewer3d.sunAsPhotographed(); });
await cam(6371130, 2128180, 1560, 6371420, 2128560, 1450); await settle(); await shot("light_grove");
await cam(6370250, 2128700, 1520, 6370700, 2129250, 1370); await settle(); await shot("light_lots");
await cam(6369600, 2125400, 3300, 6372400, 2128300, 1400); await settle(); await shot("light_site");
await cam(6371130, 2128180, 1560, 6371420, 2128560, 1450);
await page.evaluate(() => { SBMM.viewer3d.sun(255, 9); }); await settle(); await shot("light_low_sun");
await page.evaluate(() => { SBMM.viewer3d.sunAsPhotographed(); SBMM.viewer3d.setQuality("standard"); }); await settle(); await shot("light_standard");
await page.evaluate(q => { SBMM.viewer3d.setQuality("realistic"); if (!q.auto) SBMM.viewer3d.sun(q.az, q.el); }, { auto: auto0, az: sun0.az, el: sun0.el });
console.log("3d:", JSON.stringify(await page.evaluate(() => { const s = SBMM.viewer3d.stats(); return { light: s.light, shadows: s.shadows, trees: s.trees }; })));
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
