/* v9 audit shots (docs/V9_SPEC.md §11).

   Seven pictures, in the order the spec names them: the 2D default view, the 3D
   default view, split, a sheet window with a mark on it, the cultural
   acknowledgement dialog, the Layer manager and the isopach. Not pass/fail —
   these are the pictures you look at before believing any of the rest of it.

   Run it AFTER the e2e (never beside it): both drive a software-GL renderer and
   two of those on a two-core box crash the compositor. */
import { chromium } from "playwright";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium (npx playwright install chromium)

const target = process.argv[2] || "/home/claude/repo/index.html";
const out = process.argv[3] || "/home/claude/repo/test/shots";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(180000);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await page.goto(__furl(__res(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
const wait = ms => page.waitForTimeout(ms);
/* a toast is transient chrome that would sit over the mode HUD in a still */
const shot = async n => {
  await page.evaluate(() => { const t = document.getElementById("toast"); if (t) t.classList.remove("show"); });
  await page.waitForTimeout(260);
  await page.screenshot({ path: out + "/" + n + ".png" });
  console.log("shot", n);
};

/* the boot toast and the restore bar are transient chrome, not the app */
await page.evaluate(() => {
  const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  document.querySelectorAll(".restorebar").forEach(b => b.remove());
});

/* ---- 1. 2D default view, over the residential design ---- */
await page.evaluate(() => { SBMM.cmd.open(false); SBMM.layersUI.flyTo("resid"); });
await wait(2200);
await shot("2d_default");

/* the same view with the Inspector showing a real selection, so the right dock
   is not an empty placeholder in the audit */
await page.evaluate(() => {
  const f = SBMM_DATA.design_gis.features.find(x => x.properties.layer === "exc"
    && /Lot 15/.test(x.properties.name));
  const ring = f.geometry.coordinates[0];
  const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
  SBMM.map.setView([c[1], c[0]], 2);
});
await wait(1200);
await shot("2d_excavation");

/* ---- 2. 3D default view ---- */
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
  && document.getElementById("v3dStatus").textContent === "", null, { timeout: 240000 });
await wait(3500);
await shot("3d_default");

/* ---- 3. split ---- */
await page.evaluate(() => document.getElementById("v3dSplit").click());
await wait(3000);
await shot("split");

/* ---- 7. isopach (2D + draped in 3D, so it is taken while split is up) ---- */
await page.evaluate(async () => {
  await SBMM.refSurf.ready("res_excbottom");
  await SBMM.isopach.show("res_excbottom");
});
await wait(3500);
await shot("isopach");
await page.evaluate(() => {
  SBMM.isopach.clear();
  document.getElementById("v3dSplit").click();
  SBMM.viewer3d.toggle();
});
await wait(1500);

/* ---- 4. a sheet window with a mark on it ---- */
await page.evaluate(() => { SBMM.sheets.open("C-107"); });
await wait(2000);
await page.evaluate(async () => {
  const w = document.querySelector(".shwin");
  const btn = w.querySelector('.shtools [data-sht="distance"]');
  if (btn) btn.click();
  const v = w.querySelector(".shview");
  const r = v.getBoundingClientRect();
  /* js/sheetmarks.js decides click-vs-pan from pointerdown/pointerup, so a bare
     click event reaches nothing */
  const tap = async (x, y) => {
    for (const t of ["pointerdown", "pointerup"])
      v.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, button: 0,
        bubbles: true, cancelable: true }));
    await new Promise(res => setTimeout(res, 260));
  };
  await tap(r.left + r.width * 0.30, r.top + r.height * 0.42);
  await tap(r.left + r.width * 0.52, r.top + r.height * 0.55);
  document.querySelector(".shwin").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
});
await wait(1600);
await shot("sheet_window_mark");
await page.evaluate(() => SBMM.sheets.closeAll());
await wait(600);

/* ---- 5. the cultural acknowledgement dialog ---- */
await page.evaluate(() => {
  /* .click() runs the checkbox's activation behaviour, so the gate in
     js/cultural.js sees `checked === true` the way it does for a real click.
     Setting .checked first and THEN dispatching is wrong: the activation
     toggles it straight back to false and the gate returns without asking. */
  const row = document.querySelector("#culturalLayers .lyr input[type=checkbox]");
  row.click();
});
await wait(900);
await shot("cultural_ack");
await page.evaluate(() => {
  const no = document.querySelector("#cultAckNo"); if (no) no.click();
});
await wait(500);

/* ---- 6. the Layer manager ---- */
await page.evaluate(() => SBMM.layerMan.open());
await wait(700);
await page.fill("#layerMan #lmQ", "EXC");
await wait(500);
await shot("layer_manager");
await page.evaluate(() => { const x = document.querySelector("#layerMan #lmX"); if (x) x.click(); });
await wait(400);

/* ---- extras that are cheap and worth eyeballing ---- */
await page.evaluate(() => SBMM.shell.setTab("sheets"));
await wait(4000);
await shot("sheets_tab");
await page.evaluate(() => { SBMM.shell.setTab("layers"); SBMM.mode.set("measure.area"); });
await wait(500);
await shot("mode_hud");
await page.evaluate(() => SBMM.mode.navigate());

console.log("v9 audit shots written to", out);
await browser.close();
