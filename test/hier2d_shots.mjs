/* SBMM Site Explorer — the v48 2D hierarchy shots. Not pass-fail: look at them.

     node test/hier2d_shots.mjs [index.html] [outdir]

   hier_lots      limits of excavation (the subject) over lots and parcels (the context)
   hier_mine      decision units and piles over the mine, with a drawn line and area
   hier_storm     the storm network and the survey linework */
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

const browser = await launch({ name: "hier2d_shots" });
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
await page.evaluate(() => {
  const LS = SBMM.layerState;
  for (const id of ["gis_exc", "gis_lots", "gis_parcels", "gis_haul", "gis_staging", "gis_repo"]) LS.set("design", id, { on: true });
  for (const id of ["dus", "piles", "storm_nodes", "storm_cad", "storm_inferred"]) LS.set("framework", id, { on: true });
});
await fit(6370250, 2128850, 6371150, 2129500); await wait(3500); await shot("hier_lots");
/* something of the user's own: a line and an area over the mine */
await page.evaluate(() => {
  const T = SBMM.tools;
  if (T && T.newFeature) {
    try { T.newFeature("line", [[6372000, 2128150], [6372250, 2128300], [6372480, 2128260]], { name: "Line 1" }); } catch (e) {}
    try { T.newFeature("area", [[6372150, 2128450], [6372400, 2128470], [6372420, 2128640], [6372180, 2128620]], { name: "Area 1" }); } catch (e) {}
  }
});
await fit(6371700, 2127950, 6372800, 2128750); await wait(3500); await shot("hier_mine");
await fit(6372000, 2127250, 6374900, 2128500); await wait(3500); await shot("hier_storm");
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
