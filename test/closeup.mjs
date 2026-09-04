import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", e => console.log("pageerror:", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + process.argv[2]);
await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

/* volume with cut/fill map on Pile 3 */
await page.evaluate(async () => {
  SBMM.tools.volumeOfPile("Pile 3 (Fig 2)");
  const f = SBMM.store.features[0];
  for (let i = 0; i < 100 && f.props.fill_yd3 == null; i++) await new Promise(r => setTimeout(r, 100));
  f.card.querySelector(".vcf").click();
  SBMM.tools.zoomTo(f);
});
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/shot_cutfill.png" });

/* edit mode handles */
await page.evaluate(() => SBMM.tools.editFeature(SBMM.store.features[0]));
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/shot_edit.png" });
await page.keyboard.press("Enter");

/* 3D close-up over the ABP */
await page.evaluate(() => SBMM.viewer3d.openAt(6371700, 2128900));
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: 90000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/shot_3d_abp.png" });

/* sample table with graduated symbology */
await page.evaluate(() => document.getElementById("v3dClose").click());
await page.click("#tableBtn");
await page.selectOption("#tblSym", "Hg");
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/shot_table.png" });
await browser.close();
console.log("done");
