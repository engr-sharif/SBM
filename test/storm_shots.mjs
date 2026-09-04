/* v12 storm-drainage shots (docs/V12_STORM_SPEC.md §6).

   Two pictures: the south-road grate chain with a Green Pond (east pond) raindrop running
   down it in 2D, and the same network draped in 3D. Not pass/fail — this is
   what "the pipe reads as a pipe and the flow reads as water" is judged
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
page.setDefaultTimeout(180000);
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

/* ---- 1. the chain, with a Green Pond raindrop on it ---- */
const run = await page.evaluate(async () => {
  const f = await SBMM.water.dropAt(6374418, 2127912, { name: "Green Pond drop" });
  if (!f) return null;
  SBMM.store.select(null);            // selection paints the run gold; this is about the blues
  SBMM.shell.setRightTab("results");
  /* frame the grate chain and the pipes it feeds, not the whole 3,300-ft run:
     the picture is meant to show what a conduit looks like next to a flow */
  const D = SBMM_DATA.storm_network;
  const ids = ["grate_8", "grate_15", "junction", "outfall", "green_riser"];
  const ns = D.nodes.filter(n => ids.includes(n.id));
  const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
  SBMM.map.fitBounds([[Math.min(...ys) - 400, Math.min(...xs) - 400],
                      [Math.max(...ys) + 400, Math.max(...xs) + 400]], { animate: false });
  return { name: f.name, len: f.props.length_ft, pipe: f.props.pipe_ft,
           total: f.props.total_ft, legs: (f.props.legs || []).map(l => l.id),
           reason: f.props.end.reason };
});
console.log("frog pond drop:", JSON.stringify(run));
await wait(2000);
await shot("storm_2d");

/* ---- 2. the network draped in 3D, over the junction ---- */
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
  && document.getElementById("v3dStatus").textContent === "", null, { timeout: 240000 });
await wait(3000);
await page.evaluate(() => {
  const D = SBMM_DATA.storm_network;
  /* the junction: where the inferred grate chain, EA's drawn branch, the two
     surveyed pipes and the storm main all meet, and the one place a picture can
     show all four kinds of conduit at once */
  const ns = D.nodes.filter(n => ["grate_15", "branch_start", "junction",
                                  "herman_pipe_n_inv", "storm_main_east"].includes(n.id));
  const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
  SBMM.viewer3d.frameBox(Math.min(...xs) - 60, Math.min(...ys) - 60,
                         Math.max(...xs) + 60, Math.max(...ys) + 60);
});
await wait(4000);
await shot("storm_3d");
await page.evaluate(() => SBMM.viewer3d.toggle());
await wait(600);

await browser.close();
console.log("storm shots written to", out);
