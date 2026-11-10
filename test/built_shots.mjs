/* SBMM Site Explorer — the v43 built-feature shots. Not pass-fail: look at them.

     node test/built_shots.mjs [index.html] [outdir] [--off]

   built_lots        the residential lots: houses, fences, poles among the trees
   built_street      a low oblique along the road through the lots
   built_close       one house close up
   built_site        the built part of the site from above

   --off writes the same frames with the three rows off (the outline, the line
   and the dot the 3D view drew before), under the same names with _off. */
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

const browser = await launch({ name: "built_shots" });
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
await page.evaluate(off => {
  SBMM.layerState.set("base", "trees_detected", { on: true });
  for (const id of ["gis_bldg", "gis_fence", "gis_util"]) SBMM.layerState.set("design", id, { on: !off });
}, OFF);
await page.waitForFunction(() => SBMM.trees && SBMM.trees.data, null, { timeout: 120000 });
await page.evaluate(async () => { await SBMM.viewer3d.toggle(); });
await page.evaluate(() => SBMM.viewer3d.sunAsPhotographed());
const settle = async () => {
  for (let k = 0; k < 2; k++) {
    await wait(3500);
    await page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return s && !(s.tiles && s.tiles.building); },
      null, { timeout: 180000 }).catch(() => {});
  }
  await wait(5000);
};
const cam = (x, y, z, tx, ty, tz) => page.evaluate(async a => { await SBMM.viewer3d.lookFrom(...a); }, [x, y, z, tx, ty, tz]);
console.log("built:", JSON.stringify(await page.evaluate(() => SBMM.viewer3d.stats().built)));

/* the lots: the same camera test/trees_shots.mjs uses, so the two can be laid side by side */
await cam(6370250, 2128700, 1520, 6370700, 2129250, 1370); await settle(); await shot("built_lots");
await cam(6370480, 2128820, 1420, 6370760, 2129200, 1362); await settle(); await shot("built_street");
/* one house: the first plain rectangle over 900 sq ft with a height */
const H = await page.evaluate(() => {
  const G = SBMM_DATA.design_gis.features;
  for (const b of SBMM_DATA.trees_site.buildings) {
    const r = G[b.feature].geometry.coordinates[0];
    if (r.length !== 5 || !(b.h_ft > 10 && b.h_ft < 22)) continue;
    let a = 0; for (let i = 0; i < 4; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    if (Math.abs(a / 2) > 900) {
      const cx = (r[0][0] + r[1][0] + r[2][0] + r[3][0]) / 4, cy = (r[0][1] + r[1][1] + r[2][1] + r[3][1]) / 4;
      return [cx, cy, SBMM.elev(cx, cy)[0]];
    }
  }
  return null;
});
if (H) { await cam(H[0] + 150, H[1] - 160, H[2] + 125, H[0], H[1], H[2] + 8); await settle(); await shot("built_close"); }
await cam(6369700, 2127900, 2300, 6370900, 2129300, 1360); await settle(); await shot("built_site");
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
