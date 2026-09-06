/* Phone shots (v19.1): phone_map, phone_layers — Playwright's `iPhone 14 Pro`
   descriptor (393 x 659, DPR 3, touch) against the FOLDER build, served over
   the same kind of local http server test/e2e_phone.mjs starts, because that is
   what the team opens: GitHub Pages on a phone.

   Not pass/fail. These are the two pictures you look at before believing the
   phone harness — and the ones to compare with the screenshot the engineer
   sent, where the map filled 60 % of the screen and the desktop command hint,
   the status bar and the parked right dock were stacked under it.

     node test/phone_shots.mjs [/abs/path/index.html] [outdir]
*/
import { devices } from "playwright";
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { resolve as __res, dirname, join, extname } from "node:path";
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { unlock } from "./gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/* skip flags — the runner and an agent both pass --wait, and argv[3] is the
   OUTDIR: `node test/phone_shots.mjs index.html --wait` used to write the
   pictures into a directory literally called "--wait" */
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const target = __res(args[0] || __res(HERE, "../index.html"));
const out = args[1] || __res(HERE, "shots");
const SITE = dirname(target);
mkdirSync(out, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = join(SITE, p);
  if (!f.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try { statSync(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
    res.end(readFileSync(f));
  } catch (e) { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const HTTP = `http://127.0.0.1:${server.address().port}/index.html`;

const DEV = { ...devices["iPhone 14 Pro"], defaultBrowserType: undefined, isMobile: true, hasTouch: true };
delete DEV.defaultBrowserType;

const browser = await launch();
const ctx = await browser.newContext({ ...DEV });
const page = await ctx.newPage();
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);
await page.goto(HTTP);
await page.waitForSelector("#loading", { state: "hidden", timeout: 300000 });

const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  await page.evaluate(() => {
    const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  });
  await wait(300);
  await page.screenshot({ path: join(out, n + ".png") });
  console.log("shot", n);
};

/* a block, not an expression: setView RETURNS the Leaflet map, and Playwright
   cannot serialise it ("object reference chain is too long") */
await page.evaluate(() => { SBMM.map.setView([2128700, 6371900], 1); });
await wait(1600);
await shot("phone_map");

await page.tap('#fieldBar .fbtn[data-fa="layers"]');
await wait(800);
await shot("phone_layers");

console.log(JSON.stringify(await page.evaluate(() => ({
  profile: SBMM.touch.profile(),
  scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight,
  heavySkipped: !!window.SBMM_HEAVY_SKIPPED,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null
}))));

await browser.close();
server.close();
