/* Close-up screenshots of the CAD drafting chrome, for design review. */
import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const target = process.argv[2] || "/home/claude/repo/index.html";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(60000);
page.on("pageerror", e => console.log("pageerror:", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
await page.evaluate(() => {
  document.querySelectorAll(".restorebar").forEach(b => b.remove());
  SBMM.store.clear();
  SBMM.map.setView([2128870, 6371560], 1);
});
await page.waitForTimeout(800);
async function px(x, y) {
  return await page.evaluate(([x,y]) => { const c = SBMM.map.latLngToContainerPoint([y,x]); const r = document.getElementById("map").getBoundingClientRect(); return {x:r.left+c.x, y:r.top+c.y}; }, [x,y]);
}
async function C(x, y) { const p = await px(x,y); await page.mouse.move(p.x,p.y); await page.waitForTimeout(70); await page.mouse.click(p.x,p.y); await page.waitForTimeout(150); }

/* a small drawing set: an area, a dimension, an annotation */
await page.evaluate(() => {
  SBMM.tools.rebuildFeature({ type:"area", pts:[[6371470,2128810],[6371600,2128810],[6371600,2128900],[6371470,2128900]], name:"Stockpile footprint" });
  SBMM.tools.mkDim([[6371470,2128790],[6371600,2128790]]);
  const t = SBMM.tools.mkText([[6371520,2128930],[6371545,2128900]], "Stockpile A");
  t.props.size_ft = 14; SBMM.tools.applyStyle(t);
  SBMM.store.select(null);
});
await page.waitForTimeout(400);
/* command line open with the autocomplete dropdown showing */
await page.evaluate(() => SBMM.cmd.open(true));
await page.click("#cmdIn");
await page.keyboard.type("O");
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/draft_cmd.png" });
console.log("shot: /tmp/draft_cmd.png");
await page.evaluate(() => { document.getElementById("cmdIn").value = "OFFSET 25"; });

/* live sketch with a snap glyph on a polygon corner */
await page.evaluate(() => { SBMM.snap.setEnabled(true); SBMM.draw.setPolar(true); SBMM.tools.setTool(null); SBMM.tools.setTool("distance"); });
await C(6371440, 2128860);
const hov = await px(6371470 + 1.2, 2128810 + 1.0);
await page.mouse.move(hov.x, hov.y);
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/draft_full.png" });
console.log("shot: /tmp/draft_full.png");
await page.screenshot({ path: "/tmp/draft_zoom.png", clip: { x: 330, y: 380, width: 680, height: 540 } });
console.log("shot: /tmp/draft_zoom.png");
await page.screenshot({ path: "/tmp/draft_status.png", clip: { x: 0, y: 852, width: 1100, height: 98 } });
console.log("shot: /tmp/draft_status.png");
/* the dynamic input, mid-typing */
await page.keyboard.type("150");
await page.waitForTimeout(350);
await page.screenshot({ path: "/tmp/draft_dyn.png", clip: { x: 330, y: 380, width: 700, height: 420 } });
console.log("shot: /tmp/draft_dyn.png");
await browser.close();
