/* Phase B verification shots: the sheet viewer as a light table (fitted and
   zoomed into the general notes, which is the whole reason the full sheets are
   carried), the reorganised Layers tab, the tabbed table drawer, and the
   datasets in 3D with their depth sticks. Not a pass/fail test — these are the
   pictures you look at before believing any of it. */
import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium (npx playwright install chromium)

const target = process.argv[2] || "/home/claude/repo/index.html";
const out = process.argv[3] || "/tmp";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(120000);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 180000 });
const wait = ms => page.waitForTimeout(ms);

/* 1. the sheet viewer over the residential lots, fitted */
await page.evaluate(() => {
  SBMM.layersUI.flyTo("resid");
  const row = [...document.querySelectorAll("#designLayers .lyr")].find(l => /C-111/.test(l.textContent));
  const cb = row.querySelector("input[type=checkbox]");
  cb.checked = true; cb.dispatchEvent(new Event("change"));
});
await wait(1800);
await page.evaluate(() => { SBMM.sheets.open("C-111"); });
await wait(1600);
await page.screenshot({ path: out + "/pB_sheet_fit.png" });

/* 2. zoomed into the sheet's notes — is the small text actually readable? */
await page.evaluate(async () => {
  const w = document.querySelector(".shwin");
  const v = w.querySelector(".shview");
  const r = v.getBoundingClientRect();
  for (let i = 0; i < 6; i++) {
    v.dispatchEvent(new WheelEvent("wheel", { deltaY: -260, clientX: r.left + r.width * 0.78,
      clientY: r.top + r.height * 0.28, bubbles: true, cancelable: true }));
    await new Promise(res => setTimeout(res, 60));
  }
});
await wait(700);
await page.screenshot({ path: out + "/pB_sheet_zoom.png" });

/* 3. two windows at once, cascaded */
await page.evaluate(() => { SBMM.sheets.open("G-002"); });
await wait(1200);
await page.screenshot({ path: out + "/pB_sheet_two.png" });
await page.evaluate(() => SBMM.sheets.closeAll());
await wait(600);

/* 4. the Layers tab */
await page.click('#leftTabs .dtab[data-tab="layers"]');
await page.evaluate(() => { SBMM.layersUI.flyTo("mine"); });
await wait(1600);
await page.screenshot({ path: out + "/pB_layers.png", clip: { x: 0, y: 40, width: 330, height: 940 } });

/* 5. wells + borings on the map, labels on, with the table open */
await page.evaluate(async () => {
  const w = SBMM.datasets.byId("wells");
  w.style.labels = true; w.style.size = 7;
  SBMM.datasets.restyle(w);
  /* frame a real cluster of wells so the symbols and labels are actually in shot */
  SBMM.map.setView([2128450, 6371150], 0.5);
  SBMM.table.toggle(true);
  SBMM.dsTable.show("wells");
});
await wait(1400);
await page.screenshot({ path: out + "/pB_datasets_2d.png" });
await page.evaluate(() => SBMM.table.toggle(false));

/* 6. the same wells in 3D as depth sticks */
await page.evaluate(() => { SBMM.viewer3d.toggle(); });
await wait(9000);
await page.evaluate(() => {
  const c = document.getElementById("v3dPts"); if (c && c.checked) { c.checked = false; c.dispatchEvent(new Event("change")); }
  document.getElementById("v3dExag").value = "2.5";
  document.getElementById("v3dExag").dispatchEvent(new Event("input"));
  SBMM.viewer3d.frameBox(6370900, 2128300, 6372200, 2129300);
});
await wait(6000);
await page.screenshot({ path: out + "/pB_datasets_3d.png" });

console.log("shots written to", out);
await browser.close();
