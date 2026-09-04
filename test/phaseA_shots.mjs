/* Phase-A screenshots:
   1. a NEWLY registered sheet (C-103, Lot 13) over the ortho at high zoom —
      alignment is judged by eye against roads, curbs and buildings
   2. the same for C-107 (Southern Residence)
   3. the 3D view with design sheets draped on the residential terrain */
import { chromium } from "playwright";
import { unlock } from "./gate.mjs";

const target = process.argv[2];
const out = process.argv[3] || "/tmp";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN
    || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(180000);
page.on("pageerror", e => console.log("pageerror:", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
console.log("boot ok");

async function showSheet(name, only = true) {
  return page.evaluate(async ({ name, only }) => {
    const rows = [...document.querySelectorAll("#designLayers .lyr")];
    for (const x of rows) {
      const cb = x.querySelector("input[type=checkbox]");
      const isSheet = !!x.querySelector("button.d3d");
      const want = isSheet ? x.textContent.includes(name + " ")
        : !only && x.textContent.includes("Design boundaries");
      if (cb.checked !== want) { cb.checked = want; cb.onchange(); }
    }
    const r = SBMM_DATA.design_ea.sheets[name].raster;
    SBMM.map.fitBounds([[r.y0, r.x0], [r.y1, r.x1]], { animate: false });
    await new Promise(z => setTimeout(z, 1600));
    return { win: [r.x0, r.y0, r.x1, r.y1], zoom: SBMM.map.getZoom() };
  }, { name, only });
}

/* base map -> 6 in / 1.5 ft ortho so alignment can be judged against imagery */
await page.evaluate(async () => {
  const rows = [...document.querySelectorAll("#baseLayers .lyr")];
  const o = rows.find(x => /ortho/i.test(x.textContent));
  if (o) { const cb = o.querySelector("input[type=checkbox]"); if (!cb.checked) { cb.checked = true; cb.onchange(); } }
  await new Promise(z => setTimeout(z, 800));
});

console.log("C-103:", JSON.stringify(await showSheet("C-103")));
await page.waitForTimeout(1500);
await page.screenshot({ path: out + "/phaseA_1_C103_fit.png" });

/* high zoom on the south-west corner, where the boundary runs along Pomo Road */
await page.evaluate(async () => {
  SBMM.map.setView([2129420, 6370760], 2.5, { animate: false });
  await new Promise(z => setTimeout(z, 1400));
});
await page.waitForTimeout(1200);
await page.screenshot({ path: out + "/phaseA_2_C103_zoom.png" });

console.log("C-107:", JSON.stringify(await showSheet("C-107")));
await page.waitForTimeout(1500);
await page.screenshot({ path: out + "/phaseA_3_C107.png" });

/* ---- 3D drape over the residential terrain ---- */
await page.evaluate(async () => {
  /* enable a cluster of residential sheets in 3D */
  const rows = [...document.querySelectorAll("#designLayers .lyr")];
  for (const nm of ["C-103", "C-104", "C-109", "C-110"]) {
    const row = rows.find(x => x.textContent.includes(nm + " "));
    const b = row && row.querySelector("button.d3d");
    if (b && b.getAttribute("aria-pressed") !== "true") b.click();
  }
  await new Promise(z => setTimeout(z, 600));
});
await page.click("#view3dBtn");
await page.waitForTimeout(9000);
const st = await page.evaluate(async () => {
  const ex = document.getElementById("v3dExag");
  ex.value = "2.0"; ex.oninput();
  SBMM.viewer3d.flyTo(6370800, 2129600);
  await new Promise(z => setTimeout(z, 4000));
  return SBMM.viewer3d.stats();
});
console.log("3D drapes:", JSON.stringify(st.sheetDrapes), "verts", st.sheetDrapeVerts,
            "visible", st.sheetDrapesVisible);
await page.waitForTimeout(3500);
await page.screenshot({ path: out + "/phaseA_4_3d_drape.png" });

/* a closer, lower camera so the drape is seen following the ground */
await page.evaluate(async () => {
  SBMM.viewer3d.flyTo(6370700, 2129500);
  await new Promise(z => setTimeout(z, 3500));
});
await page.waitForTimeout(3000);
await page.screenshot({ path: out + "/phaseA_5_3d_close.png" });

await browser.close();
console.log("shots written to", out);
