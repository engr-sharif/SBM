/* v14 Phase 2 design-storm shots (docs/V14_PHASE2_RUNOFF_SPEC.md §3).

   Three pictures: the Design storm card with its catchment table, its pond
   routing rows and the assumptions under them; the land-cover raster with its
   curve-number legend; and a catchment's hydrograph. Not pass/fail — this is
   what "a reader can see which assumption every number rests on" is judged
   against, so look at them.

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
page.setDefaultTimeout(300000);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);
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

/* ---- 1. the card: the 25-year 24-hour storm over the whole site ---- */
const R = await page.evaluate(async () => {
  const res = await SBMM.runoff.run({ storm: "25:24" });
  if (!res) return null;
  SBMM.shell.setRightTab("results");
  SBMM.layerState.set("framework", "runoff_depth", { on: true });
  const m = SBMM.demSite.m;
  SBMM.map.fitBounds([[m.y0, m.x0], [m.y0 + m.h * m.cell, m.x0 + m.w * m.cell]], { animate: false });
  return {
    storm: res.storm.name, P: res.storm.P, provisional: res.provisional,
    grid: res.gridFt, ms: res.ms,
    site: { ac: +res.totals.area_ac.toFixed(1), cn: res.totals.cn,
            acft: +res.totals.volume_acft.toFixed(1), peak: res.totals.qPeak_cfs },
    outlets: res.outlets.slice().sort((a, b) => b.area_ft2 - a.area_ft2).map(c =>
      `${c.name} = ${c.area_ac.toFixed(1)} ac, CN ${Math.round(c.cn)}, `
      + `${c.Q_in.toFixed(2)} in, ${c.volume_acft.toFixed(1)} ac-ft, `
      + `Tc ${c.tc_min} min, SCS ${Math.round(c.qPeak_cfs)} cfs`),
    routing: res.routing.map(r => `${r.name}: peak ${r.peakLevel} ft, rim ${r.rimLevel}, `
      + `${r.overtops ? "OVERTOPS" : r.throughConduit ? "through " + r.conduitId : "contained"}, `
      + `balance ${r.balance_pct} %`)
  };
});
console.log("design storm:", JSON.stringify(R, null, 1));
await wait(2200);
await shot("runoff_card");

/* ---- 2. the cover raster and its curve-number legend ---- */
await page.evaluate(() => {
  SBMM.layerState.set("framework", "runoff_depth", { on: false });
  SBMM.layerState.set("framework", "runoff_cover", { on: true });
  SBMM.shell.setTab("layers");
  /* the mine area, where every class is on screen at once */
  SBMM.map.fitBounds([[2127200, 6370000], [2131200, 6373400]], { animate: false });
});
await wait(2000);
await shot("runoff_cover");

/* ---- 3. one catchment's hydrograph, big enough to read ---- */
await page.evaluate(() => {
  SBMM.layerState.set("framework", "runoff_cover", { on: false });
  const R = SBMM.runoff.result();
  const c = R.outlets.slice().sort((a, b) => b.qPeak_cfs - a.qPeak_cfs)[0];
  const card = [...document.querySelectorAll("#resBody .res")]
    .find(el => /Design storm/.test(el.querySelector("h4").textContent));
  if (card) {
    const sel = card.querySelector(".rnPick");
    if (sel) { sel.value = String(c.label); sel.dispatchEvent(new Event("change")); }
    const svg = card.querySelector(".rnSvg");
    if (svg) { svg.style.transform = "scale(1.6)"; svg.style.transformOrigin = "left top"; }
  }
  SBMM.shell.setRightTab("results");
  /* the card is taller than the panel and the chart is its last element, so the
     PANE is scrolled to it through the app's own helper — never scrollIntoView,
     which scrolls the PAGE and takes every absolutely positioned thing in the
     app with it (CLAUDE.md). scrollIntoPane finds the scrollable ancestor,
     which is the part a guess gets wrong. */
  const chart = card && card.querySelector(".rnChart");
  if (chart && typeof scrollIntoPane === "function") scrollIntoPane(chart);
});
await wait(1200);
await shot("runoff_hydrograph");

console.log("done — look at the three shots in " + out);
await browser.close();
