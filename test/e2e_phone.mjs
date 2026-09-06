/* E2E — the FOLDER build ON A PHONE (v19.1).
   ------------------------------------------------------------------------
   THE GAP THIS CLOSES. Three harnesses existed and none of them ran what the
   team actually opens:

     test/e2e.mjs         desktop, folder build + full dist
     test/e2e_tablet.mjs  folder build, iPad 1194 x 834, file:// and http://
     test/e2e_field.mjs   the FIELD DIST, Pixel 7

   The engineer opens the FOLDER build from GitHub Pages on an iPhone — a phone
   viewport over http, which is the one corner of that matrix nothing covered.
   Two defects lived in it, both reported from the field and neither reachable
   by any existing step:

     * the page was a scroll container. Field mode parks the two docks below
       the viewport with translateY(105%), and a transformed box still counts
       towards scrollable overflow: 1292 px of document against an 839 px
       viewport on a Pixel 7. `overflow:hidden` stops a finger, not the
       browser, and iOS scrolls the layout viewport to lift the gate's password
       field above the on-screen keyboard. Every piece of chrome is positioned
       against the initial containing block, so the whole app came up ~250 px
       high: the slim top bar off the top, the desktop command hint and status
       bar in the middle of the screen, and the parked right dock showing.
     * the folder build parsed ~50 MB of base64 the field dist deliberately
       leaves out (tools/build_dist.py FIELD_EXCLUDE) and then drew a 178-
       megapixel drape texture on top. iOS kills a tab at roughly 1-1.5 GB.

   So this harness asserts the LAYOUT INVARIANT (the page can never scroll, at
   boot and after a bottom sheet has been opened and closed), the PAYLOAD
   INVARIANT (a phone does not carry the heavy payloads and every module that
   wanted one says so rather than failing), and a 3D MEMORY BUDGET. It runs the
   folder build over the same kind of static server test/e2e_tablet.mjs starts,
   on Playwright's `iPhone 14 Pro` descriptor, and again over file:// for the
   layout half.

     node test/e2e_phone.mjs /abs/path/index.html phone
     node test/e2e_phone.mjs /abs/path/index.html phone --only "2. the layout"
     node test/e2e_phone.mjs /abs/path/index.html phone --list
   ------------------------------------------------------------------------ */
import { devices } from "playwright";
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res, dirname, join, extname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { unlock } from "./gate.mjs";
import { block, S } from "./lib/blocks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = __res(HERE, "..");

const target = __res(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : __res(ROOT, "index.html"));
const label = (process.argv[3] && !process.argv[3].startsWith("--")) ? process.argv[3] : "phone";
const SITE = dirname(target);

/* Playwright's iPhone 14 Pro: 393 x 659, DPR 3, touch. The 659 is the height
   MobileSafari leaves a page with its toolbars up, which is the height the app
   is actually laid out in. */
const IPHONE = devices["iPhone 14 Pro"];
if (!IPHONE) { console.log("FAIL: this Playwright has no `iPhone 14 Pro` descriptor"); process.exit(1); }
const DEV = { ...IPHONE, defaultBrowserType: undefined, isMobile: true, hasTouch: true };
delete DEV.defaultBrowserType;

/* The heap budget. Measured on this descriptor at 326 MB after boot and 367 MB
   after opening 3D with the fix in, against 484 / 532 without it; the budget is
   set clear of the measurement and well clear of what iOS will tolerate. Note
   that performance.memory counts NEITHER the canvas NOR the GPU texture, which
   is where the 178-megapixel drape lived — hence the texMP assertion below. */
const HEAP_BUDGET_MB = 600;

const fail = (msg, extra) => {
  console.log("FAIL: " + msg, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
};

console.log(`\n=== ${label} — ${DEV.viewport.width}x${DEV.viewport.height} @${DEV.deviceScaleFactor}, touch, FOLDER build ===`);

/* --------------------------------------------------------------------- */
/* the static server — the same shape test/e2e_tablet.mjs uses            */
/* --------------------------------------------------------------------- */
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml"
};
/* The FIRST request for one required payload FAILS — a 503, which the page
   sees as a script error the way it sees a download that a weak signal cut
   short (a bare socket drop is not usable here: Chromium quietly re-sends a
   GET whose connection closed before any response, and the page never knows).
   js/gate.js records the failed tag and js/boot.js retries it; block 1 asserts
   that it did. Every later request for the file is served. */
let droppedOnce = false;
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  if (p === "/datajs/d_dus.js" && !droppedOnce) { droppedOnce = true; res.writeHead(503).end("dropped once"); return; }
  const file = join(SITE, p);
  if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try {
    statSync(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache", "Service-Worker-Allowed": "/"
    });
    res.end(readFileSync(file));
  } catch (e) { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const HTTP = `http://127.0.0.1:${PORT}/index.html`;
console.log(`static server on ${HTTP}`);

/* --------------------------------------------------------------------- */
const browser = await launch();
const ctx = await browser.newContext({ ...DEV });
const page = await ctx.newPage();
page.setDefaultTimeout(TIMEOUT);
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => {
  if (m.type() !== "error") return;
  /* the one 503 is the harness's own (the dropped first request for
     datajs/d_dus.js above) — the retry that follows it is what is asserted */
  if (/status of 503/.test(m.text())) return;
  errors.push("console: " + m.text().slice(0, 200));
});
const wait = ms => page.waitForTimeout(ms);

await unlock(page);
const t0 = Date.now();
await page.goto(HTTP);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 })
  .catch(async () => {
    console.log("BOOT FAILED — loader says:", ((await page.textContent("#loading")) || "").trim().slice(0, 300));
    process.exit(1);
  });
console.log(`boot: OK in ${((Date.now() - t0) / 1000).toFixed(2)} s`);
await wait(1500);

/* the toast recorder — a refusal that does not toast is the bug */
await page.evaluate(() => {
  window.__toasts = [];
  const el = document.getElementById("toast");
  if (!el) return;
  new MutationObserver(() => {
    const s = el.textContent.trim();
    if (s && window.__toasts[window.__toasts.length - 1] !== s) window.__toasts.push(s);
  }).observe(el, { childList: true, characterData: true, subtree: true });
});
const toasts = () => page.evaluate(() => window.__toasts.slice());

const cdp = await page.context().newCDPSession(page);
/* the end is sent `ms` after the start was SENT, not after it was handled: a
   CDP touch is stamped on receipt and the recogniser reads that stamp, so
   awaiting the start's acknowledgement on a stalled renderer lengthens the
   hold past the tap limit (see `hold` in test/e2e_tablet.mjs) */
const tap = async (x, y, ms = 60) => {
  const a = cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }] });
  await wait(ms);
  await Promise.all([a, cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })]);
};

/* the one measurement every layout block makes */
const geom = () => page.evaluate(() => {
  const box = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width),
             shown: getComputedStyle(el).display !== "none" && r.height > 0 };
  };
  return {
    innerW: window.innerWidth, innerH: window.innerHeight,
    scrollH: document.documentElement.scrollHeight,
    scrollW: document.documentElement.scrollWidth,
    scrollY: window.scrollY, scrollX: window.scrollX,
    clientH: document.documentElement.clientHeight,
    field: document.body.classList.contains("field"),
    touch: document.body.classList.contains("touch"),
    cmdopen: document.body.classList.contains("cmdopen"),
    profile: SBMM.touch.profile(),
    fieldOn: SBMM.field.on(),
    stage: box("#stage"), map: box("#map"), fieldTop: box("#fieldTop"),
    fieldBar: box("#fieldBar"), status: box("#status"), cmdbar: box("#cmdbar"),
    rightdock: box("#rightdock"), topbar: box("#topbar")
  };
});

/* ===================================================================== */
let g0;
await block("1. boot and the profile", async () => {
g0 = await geom();
console.log(`profile: ${g0.profile} · body "${(await page.evaluate(() => document.body.className))}"`);
console.log(`viewport ${g0.innerW}x${g0.innerH} · document ${g0.scrollW}x${g0.scrollH}`);
if (g0.profile !== "phone") fail("the iPhone descriptor is not read as a phone", g0.profile);
if (!g0.field) fail("body.field is not on");
if (!g0.touch) fail("body.touch is not on");
if (!g0.fieldOn) fail("SBMM.field.on() is false on a phone");
/* js/touch.js phoneAtBoot() and js/field.js sniff() must answer the same
   machine — the payload loader uses one and the layout the other */
const agree = await page.evaluate(() => ({ heavy: SBMM.touch.phoneAtBoot(), field: SBMM.field.sniff() }));
if (agree.heavy !== agree.field) fail("phoneAtBoot() and field.sniff() disagree", agree);
console.log(`phoneAtBoot ${agree.heavy} === field.sniff ${agree.field}: OK`);
/* the server above dropped the first request for datajs/d_dus.js: the gate
   recorded the failed tag and boot retried it before checking the payloads */
const retried = await page.evaluate(() => ({ list: SBMM.retriedScripts || [], dus: !!(window.SBMM_DATA && SBMM_DATA.dus) }));
if (retried.list.indexOf("d_dus.js") < 0 || !retried.dus)
  fail("a payload whose first request was dropped was not retried at boot", retried);
console.log(`dropped payload retried at boot: ${retried.list.join(", ")}`);
}, { always: true });

/* ===================================================================== */
await block("2. the layout — the page is not a scroll container", async () => {
/* THE defect the engineer photographed. Both halves matter: no overflow to
   scroll into, and nothing scrolled. */
if (g0.scrollH !== g0.innerH)
  fail("the document is taller than the viewport — the app can be scrolled off its own chrome",
       { scrollH: g0.scrollH, innerH: g0.innerH, over: g0.scrollH - g0.innerH });
if (g0.scrollW !== g0.innerW) fail("the document is wider than the viewport", { scrollW: g0.scrollW, innerW: g0.innerW });
if (g0.scrollY !== 0 || g0.scrollX !== 0) fail("the page is scrolled at boot", { y: g0.scrollY, x: g0.scrollX });
console.log(`scrollHeight ${g0.scrollH} === innerHeight ${g0.innerH}, scrollY 0: OK`);

/* and it stays that way when something asks for it. This is what iOS does
   when the on-screen keyboard lifts a focused input. */
const after = await page.evaluate(() => {
  window.scrollTo(0, 400);
  document.documentElement.scrollTop = 400;
  return { y: window.scrollY, top: document.documentElement.scrollTop };
});
if (after.y !== 0 || after.top !== 0) fail("a programmatic scroll moved the page", after);
console.log("scrollTo(0, 400) left the page at 0: OK");

/* the field chrome, where §4.3 says it is */
if (!g0.fieldTop || !g0.fieldTop.shown || g0.fieldTop.t !== 0)
  fail("the slim top bar is not at the top of the screen", g0.fieldTop);
if (!g0.fieldBar || !g0.fieldBar.shown || g0.fieldBar.b !== g0.innerH)
  fail("the action bar is not on the bottom edge", { bar: g0.fieldBar, innerH: g0.innerH });
if (g0.topbar && g0.topbar.shown) fail("the desktop top bar is visible on a phone", g0.topbar);
if (g0.cmdopen) fail("the desktop command bar opened itself on a phone");
if (g0.cmdbar && g0.cmdbar.shown) fail("the command hint strip is visible on a phone", g0.cmdbar);
/* the map is the screen: everything between the two bars */
if (g0.stage.t !== g0.fieldTop.b) fail("the stage does not start under the top bar", { stage: g0.stage, top: g0.fieldTop });
if (g0.stage.b > g0.fieldBar.t) fail("the stage runs under the action bar", { stage: g0.stage, bar: g0.fieldBar });
if (g0.map.h !== g0.stage.h || g0.map.w !== g0.stage.w)
  fail("the map does not fill the stage", { map: g0.map, stage: g0.stage });
const cover = (g0.map.h * g0.map.w) / (g0.innerH * g0.innerW);
if (cover < 0.7) fail("the map covers less than 70% of the screen", { cover: +cover.toFixed(3), map: g0.map });
console.log(`map ${g0.map.w}x${g0.map.h} = ${(cover * 100).toFixed(1)}% of the screen · top bar ${g0.fieldTop.h}px · action bar ${g0.fieldBar.h}px`);
/* The right dock is a bottom sheet, parked BELOW THE STAGE — which is the v11
   contract test/e2e_field.mjs states in those words. It is not parked below the
   VIEWPORT: `bottom:var(--fbarH)` + `translateY(105%)` leaves its top ~56 px
   inside, under the action bar (z 1380 over the dock's 1360). What matters is
   that no part of it covers the map, and that the document does not grow. */
if (g0.rightdock.t <= g0.stage.b) fail("the parked right dock covers the map", { dock: g0.rightdock, stage: g0.stage });
if (g0.rightdock.t < g0.fieldBar.t) fail("the parked right dock is above the action bar", { dock: g0.rightdock, bar: g0.fieldBar });
console.log(`right dock parked at y ${g0.rightdock.t}, below the stage (${g0.stage.b}) and the action bar (${g0.fieldBar.t}): OK`);
}, { always: true });

/* ===================================================================== */
await block("3. a bottom sheet opens and closes without scrolling the page", async () => {
/* the Layers action, by tap — the same path test/e2e_field.mjs uses */
const layers = await page.evaluate(() => {
  const b = [...document.querySelectorAll("#fieldBar .fbtn")].find(x => /layers/i.test(x.textContent));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
if (!layers) fail("no Layers action in the bar");
await tap(layers.x, layers.y);
await wait(600);
const open = await page.evaluate(() => ({
  sheet: document.body.dataset.fsheet || null,
  dockTop: Math.round(document.getElementById("leftdock").getBoundingClientRect().top),
  scrollY: window.scrollY, scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight
}));
if (open.sheet !== "left") fail("the Layers sheet did not open", open);
if (open.dockTop >= open.innerH - 100) fail("the Layers sheet is open but still off-screen", open);
if (open.scrollY !== 0 || open.scrollH !== open.innerH)
  fail("opening the sheet made the page scrollable", open);
console.log(`Layers sheet open at y ${open.dockTop}, document still ${open.scrollH} = viewport: OK`);
/* Dismiss by tapping the map ABOVE the sheet — the same way test/e2e_field.mjs
   does it. NOT the Layers button again (it is under the scrim) and NOT
   #fieldScrim, whose centre is under the sheet. */
await tap(Math.round(g0.innerW / 2), 120);
await wait(900);
const shut = await page.evaluate(() => ({
  sheet: document.body.dataset.fsheet || null,
  scrollY: window.scrollY, scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight
}));
if (shut.sheet) fail("the Layers sheet did not close", shut);
if (shut.scrollY !== 0 || shut.scrollH !== shut.innerH) fail("closing the sheet left the page scrollable", shut);
console.log("Layers sheet closed: parked below the stage, page still unscrollable: OK");
});

/* ===================================================================== */
await block("4. the heavy payloads are not on the phone", async () => {
const p = await page.evaluate(() => ({
  skipped: !!window.SBMM_HEAVY_SKIPPED,
  listed: (window.SBMM_HEAVY || []).length,
  cad_native: typeof SBMM_DATA.cad_native,
  cad_surfaces: typeof SBMM_DATA.cad_surfaces,
  chm: typeof SBMM_DATA.chm,
  chm_png: typeof SBMM_DATA.chm_png,
  sheetFulls: Object.keys(SBMM_DATA).filter(k => /^sheet_full_/.test(k)).length,
  /* the payloads a phone MUST still have */
  demSite: typeof SBMM_DATA.dem_site,
  designGis: typeof SBMM_DATA.design_gis,
  storm: typeof SBMM_DATA.storm_network,
  cover: typeof SBMM_DATA.cover,
  sheetsIndex: typeof SBMM_DATA.sheets_full
}));
if (!p.skipped) fail("the heavy-payload loader did not skip on a phone", p);
if (p.listed !== 24) fail("SBMM_HEAVY is not the 24 payloads FIELD_EXCLUDE names", p);
for (const k of ["cad_native", "cad_surfaces", "chm", "chm_png"])
  if (p[k] !== "undefined") fail(`SBMM_DATA.${k} is present on a phone`, p);
if (p.sheetFulls !== 0) fail("full-sheet renders are present on a phone", p);
for (const k of ["demSite", "designGis", "storm", "cover", "sheetsIndex"])
  if (p[k] === "undefined") fail(`SBMM_DATA.${k} is MISSING on a phone — the field build keeps it`, p);
console.log(`24 heavy payloads skipped · terrain, design GIS, storm, cover and the sheet index all present`);

/* payload tolerance: the modules that wanted one say so, and none of them
   threw. A silent refusal is the one thing this app must not do. */
if (errors.length) fail("page errors with the heavy payloads absent", errors.slice(0, 4));
const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("#leftdock .lyr").forEach(r => {
    const t = r.textContent.trim();
    if (/not in this build|not available|no canopy|not loaded/i.test(t)) out.push(t.slice(0, 80));
  });
  return out;
});
console.log(`layer rows that say the payload is absent: ${rows.length}`);
rows.slice(0, 6).forEach(r => console.log("   " + r));

/* opening a sheet has to REFUSE with a toast, never throw */
const before = (await toasts()).length;
await page.evaluate(() => { try { SBMM.sheets.open("C-103"); } catch (e) { window.__sheetThrew = String(e); } });
await wait(900);
const threw = await page.evaluate(() => window.__sheetThrew || null);
if (threw) fail("SBMM.sheets.open threw with no render", threw);
const t = await toasts();
if (t.length <= before) fail("opening a render-less sheet refused SILENTLY — no toast", t.slice(-3));
console.log(`sheet refusal toast: "${t[t.length - 1].slice(0, 70)}"`);
if (errors.length) fail("page errors after the sheet refusal", errors.slice(0, 4));
});

/* ===================================================================== */
await block("5. 3D opens inside the memory budget", async () => {
const heap0 = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);
await page.evaluate(() => { document.getElementById("view3dBtn").click(); });
await page.waitForFunction(() => SBMM.viewer3d && SBMM.viewer3d.stats && SBMM.viewer3d.stats().terrainVerts > 0,
  null, { timeout: TIMEOUT });
await wait(4000);
const st = await page.evaluate(() => {
  const s = SBMM.viewer3d.stats();
  return { detail: s.detail, verts: s.terrainVerts, pixelRatio: s.pixelRatio, texBudgetPx: s.texBudgetPx,
           texMP: s.texMP, gpuTextures: s.gpuTextures, gpuGeometries: s.gpuGeometries,
           heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null };
});
console.log(`3D: ${st.detail} detail, ${st.verts.toLocaleString()} verts, pixelRatio ${st.pixelRatio}, `
  + `largest drape ${st.texMP} MP (budget ${st.texBudgetPx} px), ${st.gpuTextures} textures / ${st.gpuGeometries} geometries`);
console.log(`heap: ${heap0} MB before 3D → ${st.heapMB} MB after`);
if (st.detail !== "std") fail("3D did not open at STANDARD detail on a phone", st);
if (st.pixelRatio > 2) fail("the renderer pixel ratio is not capped at 2", st);
if (st.texBudgetPx !== 2048) fail("the phone drape-texture budget is not 2048 px", st);
if (st.texMP > 4.3) fail("a drape texture is over the phone budget", st);
if (st.heapMB != null && st.heapMB > HEAP_BUDGET_MB)
  fail(`the heap after 3D is over the ${HEAP_BUDGET_MB} MB budget`, st);
if (errors.length) fail("page errors opening 3D", errors.slice(0, 4));
/* and 3D must not have made the page scrollable either */
const g = await page.evaluate(() => ({ y: window.scrollY, h: document.documentElement.scrollHeight, i: window.innerHeight }));
if (g.y !== 0 || g.h !== g.i) fail("opening 3D made the page scrollable", g);
await page.evaluate(() => { document.getElementById("view3dBtn").click(); });
await wait(800);
});

/* ===================================================================== */
await block("6. the same page on an iPad still carries the payloads", async () => {
/* The other half of the payload rule: the deferral is a PHONE rule, and a
   tablet must be untouched by it. */
const IPAD = devices["iPad Pro 11 landscape"];
const d2 = { ...IPAD, defaultBrowserType: undefined, isMobile: true, hasTouch: true };
delete d2.defaultBrowserType;
const c2 = await browser.newContext({ ...d2 });
const p2 = await c2.newPage();
p2.setDefaultTimeout(TIMEOUT);
const e2 = [];
p2.on("pageerror", e => e2.push("pageerror: " + e.message));
await unlock(p2);
await p2.goto(HTTP);
await p2.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
await p2.waitForTimeout(1200);
const t2 = await p2.evaluate(() => ({
  profile: SBMM.touch.profile(), skipped: !!window.SBMM_HEAVY_SKIPPED,
  cad_native: typeof SBMM_DATA.cad_native, chm: typeof SBMM_DATA.chm,
  sheetFulls: Object.keys(SBMM_DATA).filter(k => /^sheet_full_/.test(k)).length,
  scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight
}));
if (t2.profile !== "tablet") fail("the iPad descriptor is not read as a tablet", t2);
if (t2.skipped) fail("the heavy payloads were skipped on a TABLET", t2);
if (t2.cad_native === "undefined" || t2.chm === "undefined" || t2.sheetFulls !== 20)
  fail("a tablet is missing a heavy payload", t2);
if (t2.scrollH !== t2.innerH) fail("the iPad document is taller than its viewport", t2);
console.log(`iPad: profile ${t2.profile}, cad_native present, ${t2.sheetFulls} sheet renders, document = viewport: OK`);
if (e2.length) fail("page errors on the iPad", e2.slice(0, 3));
await c2.close();
});

/* ===================================================================== */
await block("7. the same layout over file://", async () => {
const c3 = await browser.newContext({ ...DEV });
const p3 = await c3.newPage();
p3.setDefaultTimeout(TIMEOUT);
const e3 = [];
p3.on("pageerror", e => e3.push("pageerror: " + e.message));
await unlock(p3);
await p3.goto(__furl(target).href);
await p3.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
await p3.waitForTimeout(1500);
const g3 = await p3.evaluate(() => {
  window.scrollTo(0, 400);
  return { field: document.body.classList.contains("field"), profile: SBMM.touch.profile(),
           skipped: !!window.SBMM_HEAVY_SKIPPED, cmdopen: document.body.classList.contains("cmdopen"),
           scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight, scrollY: window.scrollY };
});
if (!g3.field || g3.profile !== "phone") fail("file:// does not come up as a phone", g3);
if (!g3.skipped) fail("file:// did not skip the heavy payloads", g3);
if (g3.cmdopen) fail("the command bar opened itself over file://", g3);
if (g3.scrollH !== g3.innerH || g3.scrollY !== 0) fail("file:// document is scrollable", g3);
if (e3.length) fail("page errors over file://", e3.slice(0, 3));
console.log(`file://: phone, heavy skipped, document ${g3.scrollH} = viewport, scrollY 0: OK`);
await c3.close();
});

/* ===================================================================== */
if (errors.length) fail("page errors during the run", errors.slice(0, 6));
console.log(`\nzero page errors\n${label}: ALL CHECKS PASSED`);
await browser.close();
server.close();
process.exit(0);
