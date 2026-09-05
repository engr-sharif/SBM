/* A low, close 3D view of one draped sheet, to judge that the drape follows the
   ground and that its transparent regions composite correctly against the
   terrain (no black paper, no sorting halo at the edges). */
import { launch, TIMEOUT } from "./lib/browser.mjs";
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

await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#designLayers .lyr")];
  for (const nm of ["C-103", "C-104"]) {
    const row = rows.find(x => x.textContent.includes(nm + " "));
    const b = row && row.querySelector("button.d3d");
    if (b && b.getAttribute("aria-pressed") !== "true") b.click();
  }
});
await page.click("#view3dBtn");
await page.waitForTimeout(9000);

const st = await page.evaluate(async () => {
  const ex = document.getElementById("v3dExag");
  ex.value = "1.5"; ex.oninput();
  SBMM.viewer3d.flyTo(6370760, 2129520);
  await new Promise(z => setTimeout(z, 4000));
  return SBMM.viewer3d.stats();
});
console.log("drapes:", JSON.stringify(st.sheetDrapes), "verts", st.sheetDrapeVerts,
            "cameraZ", st.cameraZ);
await page.waitForTimeout(2500);
await page.screenshot({ path: out + "/phaseA_6_close.png" });

/* and with the canopy on, which is the hardest case for transparency sorting */
await page.evaluate(async () => {
  const cb = document.getElementById("v3dCanopy");
  if (cb && !cb.checked) { cb.checked = true; cb.onchange(); }
  await new Promise(z => setTimeout(z, 6000));
});
await page.waitForTimeout(3000);
await page.screenshot({ path: out + "/phaseA_7_close_canopy.png" });

await browser.close();
console.log("done");
