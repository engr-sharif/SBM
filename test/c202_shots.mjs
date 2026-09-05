/* C-202 visual check (not pass/fail): the North Lobe grading plan draped on the
   2D map, the same sheet draped in 3D, and the sheet window with a mark made on
   the planting plan landing on the North Lobe. Writes test/shots/c202_*.png.
     node test/c202_shots.mjs /abs/path/index.html */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { unlock } from "./gate.mjs";
const target = process.argv[2];
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("pageerror:", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto(pathToFileURL(resolve(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 120000 });
const wait = ms => page.waitForTimeout(ms);

/* 2D: switch the C-202 row on, footprints on, fly to the lobe */
await page.evaluate(() => {
  const row = [...document.querySelectorAll("#designLayers .lyr")].find(x => /C-202/.test(x.textContent));
  const cb = row.querySelector("input[type=checkbox]");
  if (!cb.checked) cb.click();
  SBMM.layerState.set("design", "sheet_footprints", { on: true });
  SBMM.map.setView([2130164, 6371234], 1);
});
await wait(2500);
await page.screenshot({ path: "test/shots/c202_2d.png" });
console.log("wrote test/shots/c202_2d.png");

/* 3D: drape it and frame the footprint */
await page.evaluate(async () => {
  const row = [...document.querySelectorAll("#designLayers .lyr")].find(x => /C-202/.test(x.textContent));
  row.querySelector("button.d3d").click();
  await SBMM.viewer3d.openAt(6371234, 2130164);
});
await wait(4000);
await page.evaluate(() => { const r = SBMM_DATA.design_ea.sheets["C-202"].raster; SBMM.viewer3d.frameBox(r.x0, r.y0, r.x1, r.y1); });
await wait(3000);
const st = await page.evaluate(() => SBMM.viewer3d.stats());
console.log("3D drapes:", JSON.stringify({ names: st.sheetDrapes, verts: st.sheetDrapeVerts }));
await page.screenshot({ path: "test/shots/c202_3d.png" });
console.log("wrote test/shots/c202_3d.png");
await page.evaluate(() => { if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle(); });
await wait(800);

/* sheet window: a line marked on the PLANTING plan (left) must land on the lobe */
await page.evaluate(() => { SBMM.sheets.open("C-202"); });
await wait(1200);
const mark = await page.evaluate(() => {
  const vps = SBMM.sheetMarks.viewportsOf("C-202");
  const planting = vps.find(v => /Planting/.test(v.name));
  const [u0, v0, u1, v1] = planting.px;
  const a = [u0 + (u1 - u0) * 0.45, v0 + (v1 - v0) * 0.35], b = [u0 + (u1 - u0) * 0.65, v0 + (v1 - v0) * 0.55];
  const p1 = SBMM.sheetMarks.toSP("C-202", a[0], a[1]), p2 = SBMM.sheetMarks.toSP("C-202", b[0], b[1]);
  const f = SBMM.tools.rebuildFeature({ type: "line", pts: [p1, p2], name: "C-202 planting-plan line" });
  f.props.provenance = { source: "sheet", sheet: "C-202", px: [a, b] };
  SBMM.store.emit();
  const win = document.querySelector('.shwin[data-sheet="C-202"]');
  return { msg: win.querySelector(".shmsg").textContent, p1, p2, len: f.props.length_ft };
});
console.log("mark on the planting plan:", JSON.stringify(mark));
await wait(800);
await page.screenshot({ path: "test/shots/c202_sheet_window.png" });
console.log("wrote test/shots/c202_sheet_window.png");
await browser.close();
