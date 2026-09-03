/* Close-up screenshots of the workbench chrome, for design review. */
import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const target = process.argv[2], tag = process.argv[3] || "folder";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(180000);
page.on("pageerror", e => console.log("pageerror:", e.message));
page.on("console", m => { if (m.type() === "error") console.log("console:", m.text()); });
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
await page.evaluate(() => { SBMM.tools.volumeOfPile("Pile 1 (Fig 2)"); });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400,2128800],[6371700,2128800]] });
  SBMM.tools.rebuildFeature({ type: "profile", pts: [[6371350,2128600],[6371900,2129100]] });
  const g = SBMM.store.addGroup("Waste piles");
  SBMM.store.setGroup(SBMM.store.features[0], g);
  SBMM.store.select(SBMM.store.features[0].id);
});
await page.waitForTimeout(900);
await page.click('#leftTabs .dtab[data-tab="features"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `/tmp/shell_top_${tag}.png`, clip: { x: 0, y: 0, width: 1500, height: 120 } });
await page.screenshot({ path: `/tmp/shell_left_${tag}.png`, clip: { x: 0, y: 40, width: 380, height: 500 } });
await page.click('#leftTabs .dtab[data-tab="props"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `/tmp/shell_props_${tag}.png`, clip: { x: 0, y: 40, width: 380, height: 780 } });
await page.screenshot({ path: `/tmp/shell_right_${tag}.png`, clip: { x: 1100, y: 40, width: 400, height: 700 } });
/* status-bar job progress: kick off a big raster and catch the bar mid-flight */
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(400);
await page.evaluate(() => {
  const row = [...document.querySelectorAll("#anaLayers .lyr")].find(l => l.textContent.includes("Elevation tint"));
  row.querySelector("input[type=checkbox]").click();
});
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(200);
  if (await page.evaluate(() => document.getElementById("jobBar").classList.contains("on"))) break;
}
await page.screenshot({ path: `/tmp/shell_job_${tag}.png`, clip: { x: 700, y: 900, width: 800, height: 50 } });
console.log("job bar visible:", await page.evaluate(() => document.getElementById("jobBar").classList.contains("on")),
            "| label:", await page.evaluate(() => document.getElementById("jobLabel").textContent));

/* narrow window -> top bar overflow */
await page.setViewportSize({ width: 900, height: 800 });

await page.waitForTimeout(700);
await page.screenshot({ path: `/tmp/shell_narrow_${tag}.png` });
await browser.close();
console.log("shots written");
