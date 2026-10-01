/* v31 — the loading screen, photographed in each of its states.

     node test/loader_shots.mjs [index.html] [shots dir]

   Serves the FOLDER build over a local http server with a throttled
   connection (Chromium's own network emulation, ~4 MB/s) so the download is
   slow enough to see, and writes into test/shots/:

     loader_download.png   mid-download: the bar, the rate, the file on its way
     loader_relief.png     the relief the plate draws from the decoded site grid
     loader_gate.png       the password card with its one-line progress
     loader_stall.png      a payload that never answers: the stall warning
     loader_fail.png       a required payload missing: "Couldn't start"
     loader_late.png       after boot: the chip for the deferred payloads

   Not pass-fail — look at them. It prints what SBMM.loader.stats() said at
   each shot, so a wrong number is visible without opening the picture. */
import { createServer } from "node:http";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/browser.mjs";
import { unlock, GATE_KEY } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const target = process.argv[2] || resolve(HERE, "..", "index.html");
const OUT = process.argv[3] || resolve(HERE, "shots");
const SITE = dirname(resolve(target));
mkdirSync(OUT, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
               ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json" };
let hang = null, drop = null;          // a path to never answer / to 404
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  if (hang && p.endsWith(hang)) return;                 // the stall: no answer, ever
  if (drop && p.endsWith(drop)) { res.writeHead(404).end("gone"); return; }
  const file = join(SITE, p);
  if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try {
    statSync(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
                         "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  } catch (e) { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const URL0 = `http://127.0.0.1:${server.address().port}/index.html`;
console.log("serving", SITE, "at", URL0);

const browser = await launch();
const wait = ms => new Promise(r => setTimeout(r, ms));
const stats = page => page.evaluate(() => {
  const s = window.SBMM && SBMM.loader && SBMM.loader.stats();
  return s && { phase: s.phase, stages: s.stages, bytes: s.bytes, waitingOn: s.waitingOn, warning: s.warning };
}).catch(() => null);

async function fresh({ throttle = 4e6, locked = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  if (!locked) await unlock(page);
  else await page.addInitScript(k => { try { localStorage.removeItem(k); } catch (e) {} }, GATE_KEY);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  if (throttle) await cdp.send("Network.emulateNetworkConditions",
    { offline: false, latency: 40, downloadThroughput: throttle, uploadThroughput: 1e6 });
  return { ctx, page, cdp };
}
async function shot(page, name) {
  await page.screenshot({ path: join(OUT, name + ".png") });
  console.log(name.padEnd(18), JSON.stringify(await stats(page)));
}

/* 1. mid-download, then the terrain */
{
  const { ctx, page, cdp } = await fresh({ throttle: 4e6 });
  page.goto(URL0).catch(() => {});
  await page.waitForFunction(() => window.SBMM && SBMM.loader && SBMM.loader.stats().bytes.arrived > 15e6,
                             null, { timeout: 120000 });
  await shot(page, "loader_download");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
  await page.waitForTimeout(400);
  await shot(page, "loader_late");
  /* the relief the plate draws, rendered again into a canvas of its own: on a
     fast machine the plate is on screen for under a second */
  const url = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 808; c.height = 412;
    SBMM.loader.preview(SBMM.demSite, c); return c.toDataURL();
  });
  writeFileSync(join(OUT, "loader_relief.png"), Buffer.from(url.split(",")[1], "base64"));
  console.log("loader_relief      the plate's relief, 808 x 412");
  await ctx.close();
}

/* 2. the gate, while the payloads download underneath it */
{
  const { ctx, page } = await fresh({ throttle: 3e6, locked: true });
  page.goto(URL0).catch(() => {});
  await page.waitForFunction(() => {
    const g = document.querySelector("#gateLoad span");
    return g && /of/.test(g.textContent) && SBMM.loader.stats().bytes.arrived > 8e6;
  }, null, { timeout: 120000 });
  await shot(page, "loader_gate");
  await ctx.close();
}

/* 3. a payload that never answers */
{
  hang = "datajs/i_ortho_mine_jpg.js";
  const { ctx, page } = await fresh({ throttle: 0 });
  page.goto(URL0).catch(() => {});
  await page.waitForFunction(() => window.SBMM && SBMM.loader && SBMM.loader.stats().warning, null, { timeout: 120000 });
  await shot(page, "loader_stall");
  hang = null;
  await ctx.close();
}

/* 4. a required payload that is gone */
{
  drop = "datajs/d_dus.js";
  const { ctx, page } = await fresh({ throttle: 0 });
  await page.goto(URL0).catch(() => {});
  await page.waitForFunction(() => window.SBMM && SBMM.loader && SBMM.loader.stats().phase === "failed",
                             null, { timeout: 120000 });
  await shot(page, "loader_fail");
  drop = null;
  await ctx.close();
}

await browser.close();
server.close();
console.log("shots in", OUT);
