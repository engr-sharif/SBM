/* Screenshots for the EA residential Final Design integration:
   1. a remedy sheet raster over the ortho at a lot (alignment must read as good)
   2. the vector boundary layer over the terrain
   3. the 3D view with the boundaries draped */
import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium (npx playwright install chromium)

const target = process.argv[2];
const out = process.argv[3] || "/tmp";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(180000);
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
console.log("boot ok");

/* ---- 1. C-111 sheet overlay on the ortho ---- */
const info = await page.evaluate(async () => {
  const D = SBMM_DATA.design_ea;
  const r = D.sheets["C-111"].raster;
  /* turn on the C-111 sheet row */
  const rows = [...document.querySelectorAll("#designLayers .lyr")];
  const row = rows.find(x => x.textContent.includes("C-111 sheet"));
  const cb = row.querySelector("input[type=checkbox]");
  if (!cb.checked) { cb.checked = true; cb.onchange(); }
  SBMM.map.fitBounds([[r.y0, r.x0], [r.y1, r.x1]], { animate: false });
  await new Promise(z => setTimeout(z, 1500));
  return { win: [r.x0, r.y0, r.x1, r.y1], zoom: SBMM.map.getZoom(),
           rows: rows.length };
});
console.log("C-111 overlay on:", info);
await page.waitForTimeout(1200);
await page.screenshot({ path: out + "/design_1_sheet_overlay.png" });

/* zoomed further in on the lot, to judge alignment against the ortho */
await page.evaluate(async () => {
  SBMM.map.setView([2129830, 6371180], 2, { animate: false });
  await new Promise(z => setTimeout(z, 1200));
});
await page.waitForTimeout(1000);
await page.screenshot({ path: out + "/design_2_sheet_zoom.png" });

/* ---- 2. vector boundaries only, over the terrain ---- */
await page.evaluate(async () => {
  const rows = [...document.querySelectorAll("#designLayers .lyr")];
  for (const x of rows) {
    const cb = x.querySelector("input[type=checkbox]");
    const wantOn = x.textContent.includes("Design boundaries");
    if (cb.checked !== wantOn) { cb.checked = wantOn; cb.onchange(); }
  }
  SBMM.map.setView([2129700, 6370900], 0, { animate: false });
  await new Promise(z => setTimeout(z, 1200));
});
await page.waitForTimeout(1000);
await page.screenshot({ path: out + "/design_3_vectors.png" });

/* ---- 3. 3D with the boundaries draped ---- */
await page.click("#view3dBtn");
await page.waitForTimeout(6000);
await page.evaluate(async () => {
  const cb = document.getElementById("v3dDesign");
  if (cb && !cb.checked) { cb.checked = true; cb.onchange(); }
  SBMM.viewer3d.flyTo && SBMM.viewer3d.flyTo(6371000, 2129700);
  await new Promise(z => setTimeout(z, 2500));
  SBMM.viewer3d.refreshOverlays();
  await new Promise(z => setTimeout(z, 1200));
});
await page.waitForTimeout(3000);
await page.screenshot({ path: out + "/design_4_3d.png" });

const counts = await page.evaluate(() => SBMM.designEA.counts);
console.log("counts:", counts);
await browser.close();
console.log("shots written to", out);
