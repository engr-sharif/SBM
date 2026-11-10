/* SBMM Site Explorer — the v45 2D map shots. Not pass-fail: look at them.

     node test/map2d_shots.mjs [index.html] [outdir] [--plain]

   map2d_site        the whole site as a first visit sees it
   map2d_mine        the mine area: relief in the photo
   map2d_lots        the residential lots with buildings, roads, fences and water on
   map2d_shore       the lake shore close up

   --plain writes the same frames with the relief shading off and the plain
   line styles (the 2D map before v45), with a _plain suffix. */
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PLAIN = process.argv.includes("--plain");
const INDEX = args[0] || resolve(HERE, "..", "index.html");
const OUT = args[1] || resolve(HERE, "shots");
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "map2d_shots" });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", e => errs.push(String(e)));
await unlock(page, resolve(INDEX, ".."));
/* a first visit: the curated default layers, not the harness's remembered ones */
await page.addInitScript(() => { try { localStorage.removeItem("sbmm.home.v1"); } catch (e) {} });
await page.goto(pathToFileURL(INDEX).href);
await page.waitForFunction(() => document.getElementById("loading").style.display === "none", null, { timeout: 180000 });
await lateSettled(page);
const wait = ms => page.waitForTimeout(ms);
const shot = async n => { const f = n + (PLAIN ? "_plain" : "") + ".png"; await page.screenshot({ path: resolve(OUT, f) }); console.log("wrote", f); };
await page.evaluate(() => { try { SBMM.home && SBMM.home.hide && SBMM.home.hide(); } catch (e) {} SBMM.shell.collapse("r", true); SBMM.shell.collapse("l", true); });
if (PLAIN) await page.evaluate(() => { if (SBMM.carto && SBMM.carto.setRelief) SBMM.carto.setRelief(false); if (SBMM.carto && SBMM.carto.setStyled) SBMM.carto.setStyled(false); });
const fit = (x0, y0, x1, y1) => page.evaluate(b => { SBMM.map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { animate: false }); }, [x0, y0, x1, y1]);

await fit(6368800, 2125600, 6376400, 2131400); await wait(3500); await shot("map2d_site");
await fit(6371300, 2127300, 6373700, 2129000); await wait(3500); await shot("map2d_mine");
await page.evaluate(() => { for (const id of ["gis_bldg", "gis_road", "gis_fence", "gis_water", "gis_util", "gis_lots"]) SBMM.layerState.set("design", id, { on: true }); });
await fit(6370250, 2128850, 6371150, 2129500); await wait(3500); await shot("map2d_lots");
await fit(6370050, 2128650, 6370550, 2129000); await wait(3500); await shot("map2d_shore");
if (errs.length) console.log("PAGE ERRORS", errs.slice(0, 5));
await browser.close();
