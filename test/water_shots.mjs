/* v10 water shots (docs/V10_WATER_SPEC.md §4.5).

   Four pictures: a raindrop run in 2D and draped in 3D, and the Herman
   overtopping analysis in 2D and in 3D. Not pass/fail — these are what "build
   that into it beautifully" is judged against, so look at them.

   Run it AFTER the e2e (never beside it): both drive a software-GL renderer and
   two of those on a two-core box crash the compositor. */
import { chromium } from "playwright";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

const target = process.argv[2] || "/home/user/SBM/index.html";
const out = process.argv[3] || "/home/user/SBM/test/shots";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(180000);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto(__furl(__res(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  await page.evaluate(() => { const t = document.getElementById("toast"); if (t) t.classList.remove("show"); });
  await page.waitForTimeout(280);
  await page.screenshot({ path: out + "/" + n + ".png" });
  console.log("shot", n);
};
await page.evaluate(() => {
  const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  document.querySelectorAll(".restorebar").forEach(b => b.remove());
  SBMM.cmd.open(false);
});

/* ---- 1. a raindrop on the north mine slope, zoomed to the run ---- */
const drop = await page.evaluate(async () => {
  /* the §9.1 golden drop: a swale on the north side of the mine that runs 400 ft
     through two shallow ponds and reaches Clear Lake */
  const f = await SBMM.water.dropAt(6371200, 2128674);
  if (!f) return null;
  SBMM.tools.zoomTo(f);
  /* deliberately NOT left selected: selection paints the run gold, and the
     point of the picture is that a flow reads as water */
  SBMM.store.select(null);
  SBMM.shell.setRightTab("results");
  return { name: f.name, len: f.props.length_ft, ponds: f.props.ponds.length,
           reason: f.props.end.reason };
});
console.log("raindrop:", JSON.stringify(drop));
await wait(1600);
await shot("water_drop");

/* ---- 2. the same run in 3D ---- */
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
  && document.getElementById("v3dStatus").textContent === "", null, { timeout: 240000 });
await wait(3000);
await page.evaluate(() => {
  const f = SBMM.store.features.find(g => g.type === "flow");
  const xs = f.pts.map(p => p[0]), ys = f.pts.map(p => p[1]);
  SBMM.viewer3d.frameBox(Math.min(...xs) - 120, Math.min(...ys) - 120,
                         Math.max(...xs) + 120, Math.max(...ys) + 120);
});
await wait(2600);
await shot("water_drop_3d");
await page.evaluate(() => SBMM.viewer3d.toggle());
await wait(900);

/* ---- 3. the Herman overtopping analysis in 2D ---- */
const over = await page.evaluate(async () => {
  const R = await SBMM.water.overtopHerman();
  if (!R) return null;
  /* frame the impoundment, the rim band, the ranked lows and the route together */
  /* the band raster spans the whole ±800 ft analysis window, most of which is
     transparent; frame the water body and the route instead, or the rim ring is
     a sub-pixel line in the picture that is supposed to show it */
  const pool = SBMM.store.features.find(f => f.type === "area" && /at spill/.test(f.name));
  const src = pool ? pool.pts : [[R.primary.x, R.primary.y]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of src) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  const route = SBMM.store.features.find(f => f.type === "flow" && /overflow route/.test(f.name));
  if (route) for (const p of route.pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  SBMM.store.select(null);
  SBMM.map.fitBounds([[y0, x0], [y1, x1]], { animate: false, padding: [30, 30] });
  return { z0: R.z0, spill: R.primary.level, freeboard: R.freeboard_ft,
           lows: R.clusters.length, route: route ? route.props.length_ft : null };
});
console.log("overtopping:", JSON.stringify(over));
await wait(2200);
await shot("water_overtop");

/* ---- 4. and draped on the terrain ---- */
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
  && document.getElementById("v3dStatus").textContent === "", null, { timeout: 240000 });
await wait(3000);
await page.evaluate(() => {
  const R = SBMM.water.active();
  /* frame the spill itself: a 1,200 ft box around the low rim, so the band and
     the route are both legible rather than a smudge on the far shore */
  SBMM.viewer3d.frameBox(R.primary.x - 340, R.primary.y - 340,
                         R.primary.x + 340, R.primary.y + 340);
});
await wait(3000);
console.log("3D drape:", JSON.stringify(await page.evaluate(() => {
  const s = SBMM.viewer3d.stats();
  return { waterDraped: s.waterDraped, sceneObjects: s.sceneObjects };
})));
await shot("water_overtop_3d");

/* spec §10.6: the surveyed pipes, the sandbag wall and the pipe-stage marker at
   the impoundment's south rim, 2D */
await page.evaluate(async () => {
  if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
  await new Promise(r => setTimeout(r, 600));
  const ring = SBMM_DATA.design_gis.features.find(f => f.properties.name === "Herman Impoundment").geometry.coordinates[0];
  await SBMM.water.overtop({ ring, name: "Herman Impoundment" });
  const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
  const sl = card && card.querySelector("#wsRange");
  const R = SBMM.water.active();
  const idx = R.stage.findIndex(s => Math.abs(s.level - 1341.55) < 1e-6);
  if (sl && idx >= 0) { sl.value = idx; sl.dispatchEvent(new Event("input")); }
  SBMM.map.setView([2127488, 6372040], 3);
});
await page.waitForTimeout(2500);
await shot("water_survey");

await browser.close();
