/* v15 shots (docs/V15_3D_POLISH_SPEC.md §4).

   Four pictures, and they are the whole judgement of "it looks and functions
   beautifully": the 3D view as it now stands, the Frog Pond and Herman stages
   with their labels reading against the slider, and the 2D map with several
   label sources on screen at once. Not pass/fail — look at them.

   Run it AFTER the e2e, never beside it: two software-GL renderers on a
   two-core box crash the compositor.

     node test/v15_shots.mjs /abs/path/index.html                            */
import { chromium } from "playwright";
import { pathToFileURL as furl } from "node:url";
import { resolve as pres } from "node:path";
import { existsSync as ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

const target = process.argv[2] || "/home/user/SBM/index.html";
const out = process.argv[3] || "/home/user/SBM/test/shots";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(240000);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);
await page.goto(furl(pres(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  await page.evaluate(() => { const t = document.getElementById("toast"); if (t) t.classList.remove("show"); });
  await wait(300);
  await page.screenshot({ path: out + "/" + n + ".png" });
  console.log("shot", n);
};
await page.evaluate(() => {
  const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  document.querySelectorAll(".restorebar").forEach(b => b.remove());
  SBMM.cmd.open(false);
});

/* ---- 1. the 2D map with several label sources at once ---- */
const lab = await page.evaluate(async () => {
  const w = ms => new Promise(r => setTimeout(r, ms));
  const ringOf = nm => SBMM_DATA.design_gis.features.find(
    f => f.properties.layer === "water" && f.properties.name === nm).geometry.coordinates[0];
  const R = await SBMM.water.overtop({ ring: ringOf("Frog Pond").map(q => [q[0], q[1]]), name: "Frog Pond" });
  await w(500);
  /* a second run over the same ponds — this is what used to stack the text */
  await SBMM.water.dropAt(R.conduitSpill.x, R.conduitSpill.y, { name: "Raindrop — Frog Pond outlet" });
  await w(600);
  SBMM.store.select(null);
  SBMM.map.setView([2127760, 6374180], 1, { animate: false });
  await w(800);
  SBMM.labels.place();
  SBMM.shell.setRightTab("results");
  return SBMM.labels.stats();
});
console.log("2D labels:", JSON.stringify(lab));
await wait(1200);
await shot("labels_2d");

/* ---- 2. the 3D view over the mine, everything the site framework has on ---- */
await page.evaluate(async () => {
  const w = ms => new Promise(r => setTimeout(r, ms));
  SBMM.layerState.setGroup("framework", true);
  await w(600);
  await SBMM.viewer3d.openAt(6371900, 2128200);
});
await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
  && document.getElementById("v3dStatus").textContent === "", null, { timeout: 240000 });
await wait(6000);
await page.evaluate(() => { SBMM.viewer3d.preset("iso"); });
await wait(4000);
await shot("3d_overview");

/* ---- 3. Frog Pond's stage, one step below the culvert rim ---- */
await page.evaluate(async () => {
  const w = ms => new Promise(r => setTimeout(r, ms));
  const R = SBMM.water.active();
  await SBMM.viewer3d.openAt(R.conduitSpill.x, R.conduitSpill.y);
  await w(2500);
  const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
  const sl = card.querySelector("#wsRange");
  const i = R.stage.findIndex(st => st.level >= R.conduitSpill.level - 1e-9);
  sl.value = String(Math.max(0, i - 2)); sl.dispatchEvent(new Event("input"));
});
await wait(6000);
await shot("3d_frog_stage");

/* ---- 4. Herman, at the surveyed pipe stage ---- */
await page.evaluate(async () => {
  const w = ms => new Promise(r => setTimeout(r, ms));
  const ringOf = nm => SBMM_DATA.design_gis.features.find(
    f => f.properties.layer === "water" && f.properties.name === nm).geometry.coordinates[0];
  const R = await SBMM.water.overtop({ ring: ringOf("Herman Impoundment").map(q => [q[0], q[1]]),
                                       name: "Herman Impoundment" });
  await w(900);
  await SBMM.viewer3d.openAt(R.primary.x, R.primary.y);
  await w(2500);
  const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
  const sl = card.querySelector("#wsRange");
  const i = R.stage.findIndex(st => Math.abs(st.level - 1341.55) < 1e-6);
  if (i >= 0) { sl.value = String(i); sl.dispatchEvent(new Event("input")); }
});
await wait(7000);
await shot("3d_herman_stage");

const fin = await page.evaluate(() => {
  const st = SBMM.viewer3d.stats();
  return { labels3d: st.labels3d, visible: st.labelsVisible, texts: st.labelTexts,
           sun: st.sun, renders: st.renderCount };
});
console.log("3D at the end:", JSON.stringify(fin, null, 1));
await browser.close();
