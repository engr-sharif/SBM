/* v38 — the TEM interpretations, photographed.

     node test/teminterp_shots.mjs [index.html] [shots dir]

   Writes into test/shots/:
     teminterp_waste.png      Data ▾ → TEM geophysics → Base of waste: the
                              workspace tab and the base-of-waste surface in 3D
     teminterp_waste_map.png  the thickness map, the proposed borings and the
                              card on the 2D map
     teminterp_seep.png       the Conductive zones tab and the band sheet with
                              the least-resistive route in 3D
     teminterp_seep_map.png   the band map and the route on the 2D map, with
                              the card and its section

   Not pass-fail — look at them. It prints what SBMM.teminterp said at each
   shot, so a wrong number is visible without opening the picture. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const target = process.argv[2] || resolve(HERE, "..", "index.html");
const OUT = process.argv[3] || resolve(HERE, "shots");
mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "teminterp_shots" });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errs = [];
page.on("pageerror", e => errs.push(String(e)));
await unlock(page, resolve(HERE, ".."));
await page.goto(pathToFileURL(target).href);
await page.waitForFunction(() => document.getElementById("loading").style.display === "none", null, { timeout: 180000 });
await lateSettled(page);
const settle = () => page.waitForFunction(() => { const s = SBMM.viewer3d.stats(); return !(s.tiles && s.tiles.building); },
  null, { timeout: 60000 }).then(() => page.waitForTimeout(2500)).catch(() => {});

await page.click("#siteMenuBtn");
await page.waitForTimeout(250);
await page.click("#temWasteMenuBtn");
await page.waitForFunction(() => SBMM.teminterp.waste() && SBMM.temws.state().tab === "waste" && SBMM.viewer3d.isOpen(), null, { timeout: 180000 });
await settle();
console.log("waste:", JSON.stringify(await page.evaluate(() => {
  const W = SBMM.teminterp.waste();
  return { method: W.method, cv: W.cv, vol: W.volume_yd3, area: W.area_ft2, mean: W.mean_ft, max: W.max_ft,
           targets: W.targets.map(t => [Math.round(t.x), Math.round(t.y), +t.depth.toFixed(1), +t.se.toFixed(1)]),
           finding: document.querySelector('#temWs [data-o="wfind"]').textContent, ground: SBMM.viewer3d.ground() };
})));
await page.screenshot({ path: resolve(OUT, "teminterp_waste.png") });

await page.click('#temWs [data-tab="seep"]');
await page.waitForFunction(() => SBMM.teminterp.seep() && SBMM.temws.state().tab === "seep", null, { timeout: 120000 });
await settle();
console.log("seep:", JSON.stringify(await page.evaluate(() => {
  const S = SBMM.teminterp.seep(), r = S.route;
  return { band: [S.zTop, S.zBot], thr: S.thr, stats: S.stats, linked: S.linkedZones, area: S.area_ft2,
           route: r && { len: r.length_ft, bottleneck: r.bottleneck, median: r.median, below: r.belowFrac },
           finding: document.querySelector('#temWs [data-o="sfind"]').textContent };
})));
await page.screenshot({ path: resolve(OUT, "teminterp_seep.png") });

/* the 2D map: close the workspace, one interpretation on the map at a time,
   with its card in the Results tab */
await page.evaluate(async () => {
  SBMM.temws.close();
  if (SBMM.viewer3d.isOpen()) await SBMM.viewer3d.toggle();
  SBMM.layerState.set("invest", "tem_seep", { on: false });
  SBMM.layerState.set("invest", "tem_waste", { on: true });
  SBMM.shell.setRightTab("results");
  SBMM.teminterp.showCard("waste");
  const W = SBMM.teminterp.waste();
  SBMM.map.fitBounds([[W.y0, W.x0], [W.y0 + W.ny * W.dx, W.x0 + W.nx * W.dx]], Object.assign({ animate: false }, SBMM.omni.fitPad()));
});
await page.waitForTimeout(2500);
await page.screenshot({ path: resolve(OUT, "teminterp_waste_map.png") });
await page.evaluate(async () => {
  SBMM.layerState.set("invest", "tem_waste", { on: false });
  SBMM.layerState.set("invest", "tem_seep", { on: true });
  SBMM.teminterp.showCard("seep");
});
await page.waitForTimeout(2500);
await page.screenshot({ path: resolve(OUT, "teminterp_seep_map.png") });
console.log("page errors:", errs.length ? errs : "none");
await browser.close();
