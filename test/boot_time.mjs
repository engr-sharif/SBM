/* Boot to first interaction, and where the time actually goes.

   The v9 guardrail is 3.5 s to first interaction. "First interaction" here is a
   real one: click the Area tool and wait until SBMM.mode says the app is in it,
   so the number covers everything a user has to wait through rather than
   stopping at a hidden loading div.

   Read the stage table before believing any single total. Boot is dominated by
   two things that have nothing to do with the app's own code — parsing the
   vendor bundles (Leaflet + d3-delaunay + three) and decoding the terrain PNGs —
   and those two are typically 3+ of the seconds. `wire-modules`, `build-layers`
   and the tail after them are the app's own share.

     node test/boot_time.mjs /abs/path/index.html [runs]
     node test/boot_time.mjs /abs/path/dist/SBMM_Site_Explorer.html 3        */
import { chromium } from "playwright";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium (npx playwright install chromium)

const target = process.argv[2] || "/home/claude/repo/index.html";
const runs = +(process.argv[3] || 3);
const browser = await chromium.launch({
  executablePath: CHROME
});

const wall = [], done = [];
let stages = null;
for (let i = 0; i < runs; i++) {
  /* a fresh page every run: a warm one measures the page cache, not the boot */
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(300000);
  const t0 = Date.now();
  await page.goto(__furl(__res(target)).href);
  await page.waitForSelector("#loading", { state: "hidden", timeout: 300000 });
  await page.click('.toolbtn[data-mode="measure.area"]');
  await page.waitForFunction(() => SBMM.mode.current() === "measure.area", null, { timeout: 30000 });
  wall.push(Date.now() - t0);
  const rep = await page.evaluate(() => SBMM_PERF.report());
  done.push(rep[rep.length - 1].at_ms);
  stages = rep;
  await page.close();
}

const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.table(stages);
const app = stages.filter(s => ["build-layers", "wire-modules", "boot-done"].includes(s.stage))
  .reduce((n, s) => n + s.delta_ms, 0);
console.log(`wall to first interaction: ${wall.map(v => (v / 1000).toFixed(2)).join(" / ")} s  (median ${(med(wall) / 1000).toFixed(2)} s)`);
console.log(`boot-done mark:            ${done.map(v => (v / 1000).toFixed(2)).join(" / ")} s  (median ${(med(done) / 1000).toFixed(2)} s)`);
console.log(`the app's own share (build-layers + wire-modules + tail): ${(app / 1000).toFixed(2)} s`);
await browser.close();
