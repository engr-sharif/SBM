/* Field-mode shots (docs/V11_SPEC.md §4.5): field_map, field_layers, field_photo,
   field_3d — on Playwright's `Pixel 7` descriptor, against the field build.

   Not pass/fail. These are the four pictures you look at before believing any
   of the field harness. Run them AFTER the e2e, never beside one: two
   software-GL renderers on a two-core box crash the compositor.

     node test/field_shots.mjs dist/SBMM_Site_Explorer_field.html [outdir]
*/
import { devices } from "playwright";
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res, dirname } from "node:path";
import { existsSync as __ex } from "node:fs";
import { fileURLToPath } from "node:url";
import { unlock } from "./gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const target = process.argv[2] || __res(HERE, "../dist/SBMM_Site_Explorer_field.html");
const out = process.argv[3] || __res(HERE, "shots");
const FIXTURE = __res(HERE, "fixtures/photo_exif.jpg");

const browser = await launch();
const ctx = await browser.newContext({ ...devices["Pixel 7"] });
const page = await ctx.newPage();
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);
await page.goto(__furl(__res(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 300000 });

const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  await page.evaluate(() => {
    const t = document.getElementById("toast"); if (t) t.classList.remove("show");
    document.querySelectorAll(".restorebar").forEach(b => b.remove());
  });
  await wait(300);
  await page.screenshot({ path: out + "/" + n + ".png" });
  console.log("shot", n);
};

/* frame the mine area, and put something of the user's own on the map so the
   pictures show the app in use rather than empty */
await page.evaluate(() => {
  SBMM.map.setView([2128700, 6371900], 1);
  SBMM.water.dropAt(6372100, 2128600, { name: "Swale drop" });
  return null;                       // dropAt returns a promise for a feature
});
await page.waitForFunction(() => SBMM.store.features.some(f => f.type === "flow"), null, { timeout: 180000 });
await wait(1400);
await shot("field_map");

/* the Layers sheet, slid up over the map */
await page.tap('#fieldBar .fbtn[data-fa="layers"]');
await wait(700);
await shot("field_layers");
/* dismiss by tapping the map ABOVE the sheet — the scrim is inset:0, so its
   own centre is under the sheet and a locator tap would never land */
await page.touchscreen.tap(206, 120);
await wait(600);

/* a photo from the EXIF fixture, with its popup up as a bottom card */
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.tap('#fieldBar .fbtn[data-fa="photo"]')
]);
await chooser.setFiles(FIXTURE);
await page.waitForFunction(() => SBMM.store.features.some(f => f.type === "photo"), null, { timeout: 120000 });
await wait(1200);
await page.evaluate(() => {
  const f = SBMM.store.features.find(g => g.type === "photo");
  SBMM.map.setView([f.pts[0][1], f.pts[0][0]], 2);
  /* lift the marker into the half of the stage the card does not cover */
  SBMM.map.panBy([0, 190], { animate: false });
  SBMM.field.card(SBMM.popups.forFeature(f));
  return null;                       // card() hands back a DOM node — not serialisable
});
await wait(900);
await shot("field_photo");
await page.evaluate(() => SBMM.field.closeCard());

/* the 3D view, at the standard detail field mode opens it with */
await page.evaluate(() => { SBMM.viewer3d.openAt(6371900, 2128700); });
await page.waitForFunction(() => SBMM.viewer3d.isOpen(), null, { timeout: 240000 });
await wait(6000);
await shot("field_3d");

await browser.close();
console.log("look at them:", out);
