/* SBMM Site Explorer — the v42 water shots. Not pass-fail: look at them.

     node test/water3d_shots.mjs [index.html] [outdir] [--off]

   water_lake       Clear Lake from above the mine's west shore
   water_herman     the Herman impoundment from a low oblique
   water_ponds      Frog Pond and Green Pond
   water_lowsun     the lake under a low western sun
   water_stage      the overtopping stage surface on the impoundment
   water_site       the whole site from above the lake

   --off writes the same frames with the water surfaces switched off, under
   the same names with an _off suffix — the before of a before/after. */
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const OFF = process.argv.includes("--off");
const INDEX = args[0] || resolve(HERE, "..", "index.html");
const OUT = args[1] || resolve(HERE, "shots");
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "water3d_shots" });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", e => errs.push(String(e)));
await unlock(page, resolve(INDEX, ".."));
await page.goto(pathToFileURL(INDEX).href);
await page.waitForFunction(() => document.getElementById("loading").style.display === "none", null, { timeout: 180000 });
await lateSettled(page);
const wait = ms => page.waitForTimeout(ms);
const shot = async n => { const f = n + (OFF ? "_off" : "") + ".png"; await page.screenshot({ path: resolve(OUT, f) }); console.log("wrote", f); };

await page.evaluate(() => { SBMM.shell.collapse("r", true); SBMM.shell.collapse("l", true); });
await page.evaluate(() => SBMM.layerState.set("base", "trees_detected", { on: true }));
await page.waitForFunction(() => SBMM.trees && SBMM.trees.data, null, { timeout: 120000 });
await page.evaluate(async () => { await SBMM.viewer3d.toggle(); });
await page.evaluate(off => { if (SBMM.viewer3d.water3d) SBMM.viewer3d.water3d(!off); SBMM.viewer3d.sunAsPhotographed(); }, OFF);
const settle = async () => {
  for (let k = 0; k < 2; k++) {
    await wait(3500);
    await page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return s && !(s.tiles && s.tiles.building); },
      null, { timeout: 180000 }).catch(() => {});
  }
  await wait(5000);
};
const cam = (x, y, z, tx, ty, tz) => page.evaluate(async a => { await SBMM.viewer3d.lookFrom(...a); }, [x, y, z, tx, ty, tz]);

console.log("water:", JSON.stringify(await page.evaluate(() => SBMM.viewer3d.stats().water)));

await cam(6371250, 2128650, 1520, 6369900, 2129300, 1326); await settle(); await shot("water_lake");
await cam(6373900, 2127150, 1560, 6372700, 2127850, 1337); await settle(); await shot("water_herman");
await cam(6374900, 2127500, 1620, 6374300, 2127980, 1400); await settle(); await shot("water_ponds");
await cam(6369600, 2125400, 3300, 6372400, 2128300, 1400); await settle(); await shot("water_site");

/* a low sun in the west: the lake takes the sky's colour and the glint */
await page.evaluate(() => SBMM.viewer3d.sun(262, 9));
await cam(6372300, 2128500, 1500, 6370300, 2128650, 1326); await settle(); await shot("water_lowsun");
await page.evaluate(() => SBMM.viewer3d.sunAsPhotographed());

/* the overtopping analysis on the impoundment: the stage surface at the slider's level */
if (!OFF) {
  const ok = await page.evaluate(async () => {
    const f = SBMM_DATA.design_gis.features.find(f => f.properties.layer === "water" && /Herman/.test(f.properties.name));
    if (!f || !SBMM.water || !SBMM.water.overtop) return false;
    try { await SBMM.water.overtop({ ring: f.geometry.coordinates[0], name: "Herman Impoundment" }); return true; }
    catch (e) { return String(e); }
  });
  console.log("overtop:", ok);
  if (ok === true) {
    await cam(6373900, 2127150, 1560, 6372700, 2127850, 1337); await settle(); await shot("water_stage");
  }
}
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
