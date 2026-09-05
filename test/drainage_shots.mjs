/* v14 drainage shots (docs/V14_DRAINAGE_SPEC.md §5).

   Three pictures: the whole site coloured by the outlet each acre drains to, the
   storm outfall's contributing area picked out of it, and the same catchments
   draped in 3D. Not pass/fail — this is what "the map reads as a map, and the
   three answers read as three different answers" is judged against, so look at
   them.

   Run it AFTER the e2e (never beside it): both drive a software-GL renderer and
   two of those on a two-core box crash the compositor. */
import { launch } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";

const target = process.argv[2] || "/home/user/SBM/index.html";
const out = process.argv[3] || "/home/user/SBM/test/shots";
const browser = await launch();
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

/* ---- 1. the whole site, by outlet ---- */
const R = await page.evaluate(async () => {
  const res = await SBMM.drainage.run();
  if (!res) return null;
  SBMM.drainage.paint();
  SBMM.drainage.showCard();
  SBMM.layerState.set("framework", "drain_outlet", { on: true });
  SBMM.shell.setRightTab("results");
  /* the whole surveyed ground: the map is a site-wide answer and a picture of
     one corner of it says nothing */
  const m = SBMM.demSite.m;
  SBMM.map.fitBounds([[m.y0, m.x0], [m.y0 + m.h * m.cell, m.x0 + m.w * m.cell]], { animate: false });
  return { grid: res.gridFt, ms: res.ms_wall, cells: res.surveyedCells,
           outlets: res.sinks.map(s => SBMM.drainage.sinkName(s) + " = "
                                     + (s.area_ft2 / 43560).toFixed(1) + " ac") };
});
console.log("drainage map:", JSON.stringify(R, null, 1));
await wait(2500);
await shot("drainage_2d");

/* ---- 2. the outfall's contributing area, picked out ---- */
const hi = await page.evaluate(async () => {
  const n = SBMM.storm.node("outfall");
  return await SBMM.drainage.showInto({ node: "outfall", title: n ? n.name : "outfall" });
});
console.log("show what drains here (outfall):", JSON.stringify(hi));
await wait(2000);
await shot("drainage_click");

/* ---- 3. the catchments draped in 3D ---- */
await page.evaluate(() => {
  SBMM.drainage.paint();
  SBMM.layerState.set("framework", "drain_paths", { on: true });
});
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
  && document.getElementById("v3dStatus").textContent === "", null, { timeout: 300000 });
await wait(4000);
await page.evaluate(() => {
  /* the impoundment and the storm main below it: where the by-outlet map, the
     ponds and the pipes all meet */
  SBMM.viewer3d.frameBox(6371100, 2127200, 6372800, 2128200);
});
await wait(5000);
await shot("drainage_3d");
await page.evaluate(() => SBMM.viewer3d.toggle());
await wait(600);

await browser.close();
console.log("drainage shots written to", out);
