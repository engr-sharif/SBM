/* Registration shots for the two sheets v9.16 placed from EA's native geometry
   (tools/register_sheet_native.py): C-102 Staging Area and C-203 Borrow Source
   Demonstration Area.

   Four pictures — each sheet's raster on the orthophoto at a zoom where the
   linework is readable, and each sheet draped on the 3D terrain. NOT pass/fail:
   they are the check the numbers cannot make. A sheet whose linework does not
   sit on the ortho's own features here is not registered whatever its residuals
   say, and that is the whole reason this file exists.

   Run it AFTER the e2e, never beside it: both drive a software-GL renderer and
   two of those on a two-core box crash the compositor. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { unlock } from "./gate.mjs";

const target = process.argv[2] || "/home/claude/repo/index.html";
const out = process.argv[3] || "/home/claude/repo/test/shots";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto(__furl(__res(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  await page.evaluate(() => {
    const t = document.getElementById("toast"); if (t) t.classList.remove("show");
    document.querySelectorAll(".restorebar").forEach(b => b.remove());
  });
  await wait(260);
  await page.screenshot({ path: out + "/" + n + ".png" });
  console.log("shot", n);
};

await page.evaluate(() => {
  SBMM.cmd.open(false);
  /* Both of these sheets are SOUTH of the 6-inch mine-area orthophoto (which
     starts at N 2,127,238), so the only imagery under them is the 1.5 ft site
     ortho — and that row is off by default. Without it the shot shows the
     hillshade, and "does the linework sit on the ortho's own features" is
     exactly the question these pictures exist to answer. */
  const row = [...document.querySelectorAll("#baseLayers .lyr, .lyr")]
    .find(x => /Ortho — site/.test(x.textContent));
  const cb = row && row.querySelector('input[type="checkbox"]');
  if (cb && !cb.checked) cb.click();
});
await wait(1200);

for (const sheet of ["C-102", "C-203"]) {
  const tag = sheet.replace("-", "");

  /* ---- 2D: the raster over the orthophoto ---- */
  const where = await page.evaluate(nm => {
    const r = SBMM_DATA.design_ea.sheets[nm].raster;
    const row = [...document.querySelectorAll("#designLayers .lyr")]
      .find(x => x.textContent.indexOf(nm) === 0 || new RegExp("^" + nm).test(x.textContent.trim()));
    if (row) { const cb = row.querySelector('input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); }
    SBMM.map.fitBounds([[r.y0, r.x0], [r.y1, r.x1]], { padding: [40, 40] });
    return { row: !!row, ft: [Math.round(r.x1 - r.x0), Math.round(r.y1 - r.y0)],
             cx: (r.x0 + r.x1) / 2, cy: (r.y0 + r.y1) / 2 };
  }, sheet);
  console.log(sheet, "raster", where.ft.join(" x "), "ft, layer row:", where.row);
  await wait(2200);
  await shot("sheet_" + tag + "_map");

  /* ---- 3D: the same raster draped on the terrain ---- */
  await page.evaluate(async c => {
    if (!SBMM.viewer3d.isOpen()) await SBMM.viewer3d.openAt(c.cx, c.cy);
    else SBMM.viewer3d.flyTo(c.cx, c.cy);
  }, where);
  await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
    && document.getElementById("v3dStatus").textContent === "", null, { timeout: 240000 });
  await wait(2500);
  const draped = await page.evaluate(async nm => {
    const row = [...document.querySelectorAll("#designLayers .lyr")]
      .find(x => new RegExp("^" + nm).test(x.textContent.trim()));
    const b = row && row.querySelector("button.d3d");
    if (b) b.click();
    await new Promise(r => setTimeout(r, 3000));
    return SBMM.viewer3d.stats().sheetDrapes;
  }, sheet);
  /* re-frame AFTER the drape is built: openAt flew here before the mesh
     existed, and on this sheet's scale the patch is small in the default
     framing. flyTo puts the camera 1,940 ft off the sheet's own centre. */
  await page.evaluate(c => SBMM.viewer3d.flyTo(c.cx, c.cy), where);
  await wait(1800);
  /* flyTo's framing is the app's standard 1,940 ft stand-off, which is right
     for a lot sheet and too far for these two. Dolly in with the rig's own
     wheel handler (there is no camera setter, and driving the real input is
     the honest way to move it anyway). */
  const cv = await page.$("#v3dCanvas");
  const bb = await cv.boundingBox();
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.wheel(0, -300);
    await wait(350);
  }
  await wait(2200);
  console.log(sheet, "draped in 3D:", JSON.stringify(draped));
  await wait(1500);
  await shot("sheet_" + tag + "_3d");

  /* leave the view as it was for the next sheet */
  await page.evaluate(async nm => {
    const row = [...document.querySelectorAll("#designLayers .lyr")]
      .find(x => new RegExp("^" + nm).test(x.textContent.trim()));
    const b = row && row.querySelector("button.d3d");
    if (b) b.click();
    await new Promise(r => setTimeout(r, 600));
    if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
  }, sheet);
  await wait(900);
}

await browser.close();
console.log("sheets shots written to", out);
