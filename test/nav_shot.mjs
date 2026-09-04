/* 3D navigation chrome close-up, for design review. */
import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const target = process.argv[2], tag = process.argv[3] || "folder";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(180000);
page.on("pageerror", e => console.log("pageerror:", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
await page.evaluate(() => SBMM.viewer3d.openAt(6371700, 2128900));
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: 150000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { SBMM.viewer3d.northUp(); });
await page.waitForTimeout(2500);
await page.screenshot({ path: `/tmp/nav_full_${tag}.png` });
const nb = await (await page.$("#v3dNav")).boundingBox();
await page.screenshot({ path: `/tmp/nav_chrome_${tag}.png`, clip: { x: nb.x - 10, y: nb.y - 10, width: nb.width + 20, height: nb.height + 20 } });
/* the two popovers */
await page.click("#v3dNavHelp");
await page.waitForTimeout(400);
const hp = await (await page.$("#v3dHelpPop")).boundingBox();
await page.screenshot({ path: `/tmp/nav_help_${tag}.png`, clip: { x: hp.x - 8, y: hp.y - 8, width: hp.width + 16, height: hp.height + 16 } });
await page.click("#v3dViewSet");
await page.waitForTimeout(400);
const vp = await (await page.$("#v3dViewPop")).boundingBox();
await page.screenshot({ path: `/tmp/nav_set_${tag}.png`, clip: { x: vp.x - 8, y: vp.y - 8, width: vp.width + 16, height: vp.height + 16 } });
/* fly mode badge */
await page.click("#v3dFly");
await page.waitForTimeout(600);
await page.screenshot({ path: `/tmp/nav_fly_${tag}.png`, clip: { x: 320, y: 48, width: 800, height: 60 } });
await browser.close();
console.log("nav shots written");
