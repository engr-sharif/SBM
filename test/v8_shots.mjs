/* Screenshots for the v8 native-geometry integration. Not pass-fail — look at them.

   1. native limits of excavation over the ortho at a lot (alignment must read
      as good against roofs and driveways)
   2. the staging area (sheet C-102) — one of the four areas the PDF pass could
      never register, now carrying exact native geometry
   3. the north lobe (sheet C-202) — likewise
   4. the whole residential design, all native layers on
   5. 3D with the native design layers draped                                */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";

const target = process.argv[2];
const out = process.argv[3] || "/tmp";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("pageerror:", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
console.log("boot ok");

/* centre of a named native design area, in State Plane ft */
async function centreOf(name) {
  return page.evaluate((nm) => {
    const f = SBMM_DATA.design_gis.features.find(f =>
      f.properties.name === nm && f.geometry.type === "Polygon");
    if (!f) return null;
    const r = f.geometry.coordinates[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of r) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  }, name);
}

async function flyTo(name, pad = 90, file = null) {
  const c = await centreOf(name);
  if (!c) { console.log("MISSING:", name); return null; }
  await page.evaluate(async (a) => {
    SBMM.map.fitBounds([[a.y - a.h / 2 - a.pad, a.x - a.w / 2 - a.pad],
                        [a.y + a.h / 2 + a.pad, a.x + a.w / 2 + a.pad]], { animate: false });
    await new Promise(z => setTimeout(z, 1200));
  }, { ...c, pad });
  await page.waitForTimeout(900);
  if (file) await page.screenshot({ path: out + "/" + file });
  console.log(`${file || name}: ${name} — ${Math.round(c.w)}x${Math.round(c.h)} ft at ${Math.round(c.x)} E ${Math.round(c.y)} N`);
  return c;
}

/* make sure the ortho is the basemap so alignment is judgeable */
await page.evaluate(async () => {
  const rows = [...document.querySelectorAll("#baseLayers .lyr")];
  const o = rows.find(r => /ortho/i.test(r.textContent));
  if (o) { const cb = o.querySelector("input[type=checkbox]"); if (!cb.checked) { cb.checked = true; cb.onchange(); } }
  await new Promise(z => setTimeout(z, 800));
});

/* ---- 1. a lot, native limits of excavation over the ortho ---- */
await flyTo("Limit of excavation — Lot 15", 70, "v8_1_lot15_native.png");

/* ---- 2. C-102 staging area: previously unregisterable ---- */
await flyTo("Staging Area", 160, "v8_2_staging_C102.png");

/* ---- 3. C-202 north lobe: previously unregisterable ---- */
await flyTo("Limit of excavation — North Lobe", 160, "v8_3_northlobe_C202.png");

/* ---- 4. the whole residential design with every native layer on ---- */
const all = await page.evaluate(async () => {
  const rows = [...document.querySelectorAll("#designLayers .lyr")];
  let on = 0;
  for (const r of rows) {
    const cb = r.querySelector("input[type=checkbox]");
    /* every native layer on; the sheet rasters stay off so the vectors read */
    const isSheet = /sheet|C-\d\d\d\s·/.test(r.textContent) && r.querySelector(".shopen");
    const want = !isSheet;
    if (cb.checked !== want) { cb.checked = want; cb.onchange(); }
    if (want) on++;
  }
  const e = SBMM.layersUI.extents ? null : null;
  SBMM.map.fitBounds([[2128850, 6370350], [2130250, 6371500]], { animate: false });
  await new Promise(z => setTimeout(z, 1600));
  return { rowsOn: on, total: rows.length };
});
console.log("all native layers on:", all);
await page.waitForTimeout(1200);
await page.screenshot({ path: out + "/v8_4_all_layers.png" });

/* ---- 5. 3D with the native design draped ---- */
await page.click("#view3dBtn");
await page.waitForTimeout(7000);
const three = await page.evaluate(async () => {
  const c = SBMM.designGIS.rings3d().length;
  if (SBMM.viewer3d && SBMM.viewer3d.flyTo) {
    try { SBMM.viewer3d.flyTo(6371000, 2129500, 1500); } catch (e) {}
  }
  await new Promise(z => setTimeout(z, 3000));
  return { draped: c };
});
console.log("3D draped native rings:", three);
await page.waitForTimeout(3000);
await page.screenshot({ path: out + "/v8_5_3d_design.png" });

await browser.close();
console.log("shots written to " + out);
