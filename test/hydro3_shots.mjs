/* v19 Phase 3 shots (docs/V19_HYDRO3_SPEC.md §5).

   Four pictures: the flow accumulation over the whole site with the streams on
   it, the same streams draped in 3D, the pipe-capacity card with the storm
   conduits coloured by ratio, and a scenario comparison. Not pass/fail — these
   are what "the accumulation reads as a drainage network rather than as noise"
   and "the card is honest about what it cannot answer" are judged against, so
   look at them.

   Run it AFTER the e2e, never beside it: both drive a software-GL renderer and
   two of those on a two-core box crash the compositor.

     node test/hydro3_shots.mjs [/abs/path/index.html] [/abs/out/dir]          */
import { launch } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
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

/* ---- 1. the accumulation and the streams over the whole site ---- */
const A = await page.evaluate(async () => {
  const R = await SBMM.accum.run();
  if (!R) return { failed: true };
  SBMM.layerState.set("framework", "accum_raster", { on: true });
  SBMM.layerState.set("framework", "accum_streams", { on: true });
  SBMM.accum.paint();
  SBMM.accum.showCard();
  SBMM.map.fitBounds([[SBMM.demSite.m.y0, SBMM.demSite.m.x0],
                      [SBMM.demSite.m.y0 + SBMM.demSite.m.h * SBMM.demSite.m.cell,
                       SBMM.demSite.m.x0 + SBMM.demSite.m.w * SBMM.demSite.m.cell]]);
  return { method: R.method, max_ac: +R.maxAcc_ac.toFixed(1), links: R.streamLinks,
           mi: +(R.streamLength_ft / 5280).toFixed(2), order: R.maxOrder, ms: R.ms_wall };
});
console.log("accumulation:", JSON.stringify(A));
await wait(1600);
await shot("accum_2d");

/* ---- 2. the streams in 3D ---- */
await page.evaluate(() => { SBMM.viewer3d.open(); });
await wait(4500);
await page.evaluate(() => {
  SBMM.viewer3d.refreshDrapes();
  SBMM.viewer3d.refreshOverlays();
});
await wait(3500);
await shot("streams_3d");
await page.evaluate(() => { SBMM.viewer3d.close(); });
await wait(1200);

/* ---- 3. the pipe capacity, with the conduits coloured by ratio ---- */
const P = await page.evaluate(async () => {
  const R = await SBMM.pipes.run();
  if (!R) return { failed: true };
  SBMM.pipes.showCard();
  await SBMM.pipes.setColorBy(true);
  /* the impoundment and the storm main, which is where the pipes are */
  SBMM.map.setView([2127600, 6372100], 1);
  return { total: R.totalConduits, unknown: R.unknownConduits,
           surcharged: R.surcharged.length };
});
console.log("pipes:", JSON.stringify(P));
await wait(1400);
await shot("pipe_capacity");
await page.evaluate(async () => { await SBMM.pipes.setColorBy(false); });

/* ---- 4. two scenarios, compared ---- */
const S = await page.evaluate(async () => {
  const a = SBMM.scenarios.add("25-year, drains working");
  a.storm = "25:24";
  await SBMM.scenarios.run(a.id);
  const b = SBMM.scenarios.add("25-year, drains off");
  b.storm = "25:24"; b.drains = false;
  await SBMM.scenarios.run(b.id);
  SBMM.scenarios.pick([a.id, b.id]);
  SBMM.scenarios.showDiff(a.id, b.id);
  return { n: SBMM.scenarios.list().length,
           vols: SBMM.scenarios.list().map(s => s.last ? +s.last.site.volume_acft.toFixed(1) : null),
           peaks: SBMM.scenarios.list().map(s => s.last ? Math.round(s.last.site.peak_cfs) : null) };
});
console.log("scenarios:", JSON.stringify(S));
await wait(1600);
await shot("scenario_compare");

await browser.close();
console.log("shots in", out);
