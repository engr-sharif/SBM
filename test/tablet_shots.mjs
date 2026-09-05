/* The v17 tablet shots (docs/V17_TOUCH_SPEC.md §6). NOT pass-fail — look at them.

     node test/tablet_shots.mjs /abs/path/index.html

   Writes into test/shots/:
     tablet_map.png        the desktop layout with touch chrome — 44-px buttons,
                           the "..." on every layer row, the Field and command
                           buttons in the top bar
     tablet_3d.png         the 3D view with the on-screen nav pad
     tablet_sheet_loupe.png a sheet window, maximised, mid-placement with the
                           loupe up and the Done bar showing
     tablet_layers.png     a layer row's toolbar opened by "..."
     tablet_home_hint.png  the Help panel: Add to Home Screen, the offline copy,
                           the Pencil paragraph and the device diagnostics
     tablet_redline.png    a Pencil redline on the map with its palette

   Run it ALONE — one software-GL renderer at a time on this box.
*/
import { chromium, devices } from "playwright";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unlock } from "./gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = __res(HERE, "..");
const OUT = __res(HERE, "shots");
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_BIN
  || (existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
      ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

const target = process.argv[2] || __res(ROOT, "index.html");
const IPAD = { ...devices["iPad Pro 11 landscape"], isMobile: true, hasTouch: true };
delete IPAD.defaultBrowserType;

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...IPAD });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
await unlock(page);
await page.goto(__furl(__res(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 300000 });
await page.waitForTimeout(2500);

const cdp = await page.context().newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", {
  type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id, radiusX: 6, radiusY: 6, force: 1 }))
});
const pen = (kind, x, y, pressure) => page.evaluate(([kind, x, y, pr]) => {
  const el = document.elementFromPoint(x, y) || document.body;
  el.dispatchEvent(new PointerEvent("pointer" + kind, {
    bubbles: true, cancelable: true, composed: true, view: window,
    pointerId: 99, pointerType: "pen", isPrimary: true,
    clientX: x, clientY: y, buttons: kind === "up" ? 0 : 1, pressure: pr
  }));
}, [kind, Math.round(x), Math.round(y), pressure == null ? 0.5 : pressure]);

const shot = async name => {
  await page.screenshot({ path: __res(OUT, name) });
  console.log("  " + name);
};

console.log("tablet shots ->", OUT);

/* 1. the map */
await page.evaluate(() => { SBMM.shell.setTab("layers"); });
await page.waitForTimeout(900);
await shot("tablet_map.png");

/* 2. a layer row's toolbar, opened by "..." */
await page.evaluate(() => {
  const r = document.querySelectorAll("#layers .lyr")[2] || document.querySelector("#layers .lyr");
  r.querySelector(".ltmore").click();
  r.scrollIntoView ? null : null;
});
await page.waitForTimeout(600);
await shot("tablet_layers.png");
await page.evaluate(() => document.querySelectorAll(".lyr.ltopen").forEach(r => r.classList.remove("ltopen")));

/* 3. a redline, drawn with a pen, with its palette up */
{
  const b = await page.evaluate(() => {
    const r = document.getElementById("map").getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  });
  await page.evaluate(() => SBMM.mode.set("redline"));
  await page.waitForTimeout(400);
  await pen("down", b.cx - 170, b.cy, 0.2);
  for (let i = 1; i <= 24; i++)
    await pen("move", b.cx - 170 + i * 13, b.cy + 46 * Math.sin(i / 3.4), 0.15 + i * 0.033);
  await pen("up", b.cx + 142, b.cy, 0);
  await page.waitForTimeout(700);
  await shot("tablet_redline.png");
  await page.evaluate(() => SBMM.mode.navigate());
  await page.waitForTimeout(300);
}

/* 4. the 3D view with the nav pad */
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => SBMM.viewer3d.isOpen(), null, { timeout: 240000 });
await page.waitForTimeout(6000);
await shot("tablet_3d.png");
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForTimeout(900);

/* 5. a maximised sheet window, mid-placement, loupe up + Done bar */
if (await page.evaluate(() => SBMM.sheets.hasRender("C-106"))) {
  await page.evaluate(() => { SBMM.sheets.open("C-106"); });
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    const st = SBMM.sheets.stateOf("C-106");
    const b = [...st.el.querySelectorAll(".sht")].find(x => x.dataset.sht === "distance");
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  const vb = await page.evaluate(() => {
    const v = document.querySelector(".shwin .shview").getBoundingClientRect();
    return { cx: Math.round(v.left + v.width / 2), cy: Math.round(v.top + v.height / 2) };
  });
  /* one vertex placed, then a second press held so the loupe is on screen */
  await touch("touchStart", [{ x: vb.cx - 140, y: vb.cy - 70, id: 1 }]);
  await page.waitForTimeout(260);
  await touch("touchEnd", []);
  await page.waitForTimeout(260);
  await touch("touchStart", [{ x: vb.cx + 90, y: vb.cy + 50, id: 1 }]);
  await page.waitForTimeout(420);
  await shot("tablet_sheet_loupe.png");
  await touch("touchEnd", []);
  await page.waitForTimeout(400);
  await page.evaluate(() => SBMM.sheets.closeAll());
  await page.waitForTimeout(600);
} else console.log("  (no C-106 render in this build — tablet_sheet_loupe.png skipped)");

/* 6. the Help panel */
await page.evaluate(() => {
  SBMM.touch.paintDiag();
  document.getElementById("help").style.display = "flex";
  const h = document.getElementById("homeHint");
  if (h) h.hidden = false;                 // headless chromium reports standalone=false anyway
  const box = document.querySelector("#help .box");
  const hit = [...box.querySelectorAll("b")].find(b => /On a tablet/.test(b.textContent));
  if (hit) hit.scrollIntoView({ block: "center" });
});
await page.waitForTimeout(700);
await shot("tablet_home_hint.png");

await browser.close();
console.log("done — look at them.");
