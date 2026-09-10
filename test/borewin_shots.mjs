/* SBMM Site Explorer — the boring-log window shots (v23 Phase A).
   NOT pass-fail; look at them.

   node test/borewin_shots.mjs [index.html] [outdir]

   Writes borewin_log.png (SB-9's log sheet at 1" = 5', with the depth cursor
   parked on a stratum), borewin_compare.png (four holes on one elevation datum
   with the correlation lines) and borewin_print.png (the printed log sheet in
   the report preview) into test/shots/.

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

const browser = await launch({ name: "borewin_shots" });
const page = await browser.newPage({ viewport: { width: 1620, height: 1000 } });
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
await page.waitForFunction(() => window.SBMM && SBMM.borewin && SBMM.borelogs && SBMM.borelogs.has(),
  null, { timeout: TIMEOUT });
await wait(1500);

/* 1 — the log sheet, with the depth cursor over a stratum */
await page.evaluate(() => { SBMM.borewin.open("SB-9"); });
await wait(1200);
const gl = await page.locator(".blwin .blgl").nth(2).boundingBox();
if (gl) await page.mouse.move(gl.x + gl.width / 2, gl.y + gl.height / 2);
await wait(400);
await page.screenshot({ path: resolve(OUT, "borewin_log.png") });
console.log("wrote borewin_log.png");

/* 2 — compare, four holes on one elevation datum */
await page.evaluate(() => { SBMM.borewin.compare(["SB-9", "SB-11", "SB-12", "SB-17"]); });
await wait(1200);
await page.screenshot({ path: resolve(OUT, "borewin_compare.png") });
console.log("wrote borewin_compare.png");

/* 3 — the printed log sheet */
await page.evaluate(() => { SBMM.borewin.tab("log"); SBMM.borewin.printSheet(["SB-10"]); });
await wait(2500);
await page.screenshot({ path: resolve(OUT, "borewin_print.png") });
console.log("wrote borewin_print.png");

await browser.close();
console.log("done — look at the three pictures in", OUT);
