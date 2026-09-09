/* SBMM Site Explorer — the boring-log shots. NOT pass-fail; look at them.

   node test/borelog_shots.mjs [index.html] [outdir]

   Writes borelog_card.png (SB-9's strip log open in the Results pane),
   borelog_3d.png (the class-coloured depth sticks at SB-9) and
   borelog_summary.png (the 44-hole contact table) into test/shots/.

   Both defaults are resolved from THIS FILE'S location, never from a hard-coded
   repo path: in an agent worktree a constant opens the planner's index.html and
   writes the pictures into the planner's tree, which has happened twice. */
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { unlock } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const APP = process.argv[2] || resolve(HERE, "..", "index.html");
const OUT = process.argv[3] || resolve(HERE, "shots");
mkdirSync(OUT, { recursive: true });

const wait = ms => new Promise(r => setTimeout(r, ms));

const browser = await launch({ name: "borelog_shots" });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.setDefaultTimeout(300000);
page.on("pageerror", e => console.log("  page error:", e.message));
await unlock(page);
await page.goto(pathToFileURL(resolve(APP)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
await page.evaluate(() => {
  const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  document.querySelectorAll(".restorebar").forEach(b => b.remove());
  if (SBMM.cmd) SBMM.cmd.open(false);
});
await page.waitForFunction(() => window.SBMM && SBMM.borelogs && SBMM.borelogs.has(),
  null, { timeout: TIMEOUT });
await wait(2500);

/* 1 — the strip log */
await page.evaluate(() => { SBMM.borelogs.open("SB-9"); });
await wait(1200);
await page.screenshot({ path: resolve(OUT, "borelog_card.png") });
console.log("wrote borelog_card.png");

/* 2 — the depth sticks in 3D, looked at from the boring itself */
await page.evaluate(async () => {
  const h = SBMM.borelogs.byId("SB-9");
  await SBMM.viewer3d.openAt(h.x, h.y);
  SBMM.viewer3d.refreshOverlays();
});
await wait(9000);
/* dolly in on the boring itself — a 30-ft stick at the default orbit radius is
   three pixels, and the point of this picture is the colours on it */
const box = await page.locator("#v3dCanvas").boundingBox();
for (let i = 0; i < 5 && box; i++) {
  /* the wheel dollies TOWARD the point under the cursor, so the cursor has to
     be on the boring — screenAt is the hook that answers where it is now */
  const at = await page.evaluate(() => {
    const h = SBMM.borelogs.byId("SB-9");
    const [z] = SBMM.elev(h.x, h.y);
    return SBMM.viewer3d.screenAt(h.x, h.y, isNaN(z) ? 1366 : z);
  });
  if (!at) break;
  await page.mouse.move(at[0], at[1]);
  await page.mouse.wheel(0, -520);
  await wait(1400);
}
/* park the pointer over empty sky: a dwell over a stick opens the pick card,
   and this picture is about the sticks rather than about the card */
if (box) await page.mouse.move(box.x + 60, box.y + 40);
await wait(6000);
await page.screenshot({ path: resolve(OUT, "borelog_3d.png") });
console.log("wrote borelog_3d.png");

/* 3 — the reconciliation table */
await page.evaluate(() => {
  if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
  SBMM.borelogs.close();
  SBMM.borelogs.summary();
});
await wait(2500);
await page.screenshot({ path: resolve(OUT, "borelog_summary.png") });
console.log("wrote borelog_summary.png");

await browser.close();
console.log("shots in", OUT);
