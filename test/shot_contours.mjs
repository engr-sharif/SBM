import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.goto("file:///home/claude/repo/index.html");
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
await page.evaluate(() => SBMM.viewer3d.openAt(6371550, 2128950));
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: 180000 });
await page.waitForTimeout(1500);
// turn contours on, DUs/piles off so the contours read cleanly
await page.evaluate(async () => {
  for (const id of ["v3dDus","v3dPiles"]) { const c=document.getElementById(id); c.checked=false; c.onchange(); }
  const cb = document.getElementById("v3dContours"); cb.checked = true; await cb.onchange();
});
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: 180000 });
await page.waitForTimeout(1200);
for (const [style, name] of [["ortho","ortho"],["hillshade","hs"]]) {
  await page.evaluate(async s => { const sel=document.getElementById("v3dStyle"); sel.value=s; await sel.onchange(); }, style);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `/tmp/ctr_${name}.png` });
  console.log("shot", name, JSON.stringify(await page.evaluate(()=>SBMM.viewer3d.stats())));
}
await browser.close();
