import { chromium } from "playwright";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", e => console.log("pageerror:", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto(__furl(__res(process.argv[2])).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });

/* site DEM is now 2-ft everywhere */
const site = await page.evaluate(() => {
  const m = SBMM.demSite.m;
  return { cell: m.cell, w: m.w, h: m.h, elevOutsideAbp: SBMM.elev(6374000, 2126000) };
});
console.log("site DEM:", site.cell + "ft", site.w + "x" + site.h, "| elev outside ABP:", site.elevOutsideAbp);

/* volume outside the ABP must use the 2-ft grid */
const vol = await page.evaluate(async () => {
  SBMM.tools.rebuildFeature({ type: "volume", pts: [[6374000, 2126000], [6374300, 2126000], [6374300, 2126300], [6374000, 2126300]] });
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  for (let i = 0; i < 100 && f.props.fill_yd3 == null; i++) await new Promise(r => setTimeout(r, 100));
  return f.props.grid;
});
console.log("volume grid outside ABP:", vol);

/* open 3D, go split, draw a volume by clicking in the 3D canvas */
await page.evaluate(() => SBMM.viewer3d.openAt(6371700, 2128900));
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: 120000 });
await page.waitForTimeout(1000);
await page.click("#v3dSplit");
await page.waitForTimeout(600);
await page.click('.toolbtn[data-tool="volume"]');
const c = await page.$("#v3dCanvas");
const bb = await c.boundingBox();
const pts = [[0.45, 0.55], [0.55, 0.5], [0.58, 0.62], [0.47, 0.66]];
for (const [fx, fy] of pts) {
  await page.mouse.click(bb.x + bb.width * fx, bb.y + bb.height * fy);
  await page.waitForTimeout(250);
}
await page.mouse.dblclick(bb.x + bb.width * 0.5, bb.y + bb.height * 0.58);
const drawn = await page.evaluate(async () => {
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  const t0 = performance.now();
  while (f.props.fill_yd3 == null && performance.now() - t0 < 40000) await new Promise(r => setTimeout(r, 250));
  return { type: f.type, n: f.pts.length, fill: f.props.fill_yd3, grid: f.props.grid };
});
console.log("feature drawn via 3D clicks:", drawn);
await page.screenshot({ path: "/tmp/shot_split.png" });
await browser.close();
console.log(drawn.type === "volume" && drawn.n >= 3 && drawn.fill != null ? "SPLIT-3D PASS" : "SPLIT-3D FAIL");
