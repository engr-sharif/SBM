/* E2E — the FIELD build and FIELD MODE (docs/V11_SPEC.md §4.5).

   Runs against dist/SBMM_Site_Explorer_field.html on Playwright's `Pixel 7`
   device descriptor (touch, 412 x 839, DPR 2.625), which is the only way to
   test a mode whose whole trigger is "a coarse pointer on a narrow screen".

   WHY THIS IS A SEPARATE FILE and not a section switch inside test/e2e.mjs:
   e2e.mjs is 4,200 lines of FLAT top-level statements sharing one `page`, one
   feature store and one accumulating scene — sections routinely draw something
   section N+6 then measures, and the screenshot at the end frames the Pile 1
   volume drawn near the top. Wrapping twenty of those blocks in build guards
   would have meant re-deriving every one of those dependencies, on the one file
   the delivery procedure requires to pass UNCHANGED on the folder build and the
   full dist. So this harness re-states the six sections §4.5 names — boot, the
   gate, terrain, the golden volume, water, the survey — against the field
   build, shares test/gate.mjs with every other harness, and adds the field-mode
   and field-capability assertions of §4.3 / §4.4.

   Run it AFTER the desktop harnesses, never beside one: two software-GL
   renderers on a two-core box crash the compositor.

     node test/e2e_field.mjs dist/SBMM_Site_Explorer_field.html field
     node test/e2e_field.mjs dist/SBMM_Site_Explorer_field.html field \
                             dist/SBMM_Site_Explorer.html      # + boot comparison
*/
import { chromium, devices } from "playwright";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res, dirname } from "node:path";
import { existsSync as __ex } from "node:fs";
import { fileURLToPath } from "node:url";
import { unlock, gatePassword } from "./gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = __res(HERE, "..");
const FIXTURE = __res(HERE, "fixtures/photo_exif.jpg");
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

const target = process.argv[2] || "dist/SBMM_Site_Explorer_field.html";
const label = process.argv[3] || "field";
const compareTo = process.argv[4] || null;   // optional: the full dist, for the boot comparison

/* the fixture's own numbers — tools/make_photo_fixture.py writes them */
const FIX_SP = [6371600.0, 2128900.0];
const FIX_TAKEN = "2026-08-14 09:41:07";

const PIXEL7 = devices["Pixel 7"];
if (!PIXEL7) { console.log("FAIL: this Playwright has no `Pixel 7` device descriptor"); process.exit(1); }

const fail = (msg, extra) => {
  console.log("FAIL: " + msg, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
};

console.log(`\n=== ${label} — ${PIXEL7.viewport.width}x${PIXEL7.viewport.height} @${PIXEL7.deviceScaleFactor}, touch ===`);

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...PIXEL7 });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
const wait = ms => page.waitForTimeout(ms);

await unlock(page);                       /* the password gate — see test/gate.mjs */
const t0 = Date.now();
await page.goto(__furl(__res(target)).href);

/* ===================================================================== */
/* 1. boot                                                               */
/* ===================================================================== */
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 })
  .catch(async () => {
    const txt = await page.textContent("#loading");
    console.log("BOOT FAILED — loader says:", (txt || "").trim().slice(0, 300));
    process.exit(1);
  });
const bootMs = Date.now() - t0;
console.log(`boot: OK (loader cleared) in ${(bootMs / 1000).toFixed(2)} s`);

/* the toast recorder, installed as soon as there is a document to install it in */
await page.evaluate(() => {
  window.__toasts = [];
  const el = document.getElementById("toast") || (() => { const t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); return t; })();
  new MutationObserver(() => { const s = el.textContent.trim(); if (s && window.__toasts[window.__toasts.length - 1] !== s) window.__toasts.push(s); })
    .observe(el, { childList: true, characterData: true, subtree: true });
});
const toasts = () => page.evaluate(() => window.__toasts.slice());
const clearToasts = () => page.evaluate(() => { window.__toasts.length = 0; });

const build = await page.evaluate(() => ({
  build: SBMM_DATA.build, isField: SBMM.isField(),
  single: !!window.SBMM_SINGLE_FILE
}));
console.log("build stamp:", build.build, "| isField():", build.isField, "| single file:", build.single);
if (build.build !== "field" || !build.isField) fail("this is not the field build", build);

/* ===================================================================== */
/* 1a. the gate, with touch                                              */
/* ===================================================================== */
{
  const gctx = await browser.newContext({ ...PIXEL7 });
  const gp = await gctx.newPage();
  gp.setDefaultTimeout(180000);
  const gerr = [];
  gp.on("pageerror", e => gerr.push("pageerror: " + e.message));
  gp.on("console", m => { if (m.type() === "error") gerr.push("console: " + m.text()); });
  await gp.goto(__furl(__res(target)).href);      // deliberately NOT unlocked
  await gp.waitForSelector("#gate", { timeout: 60000 });
  const g0 = await gp.evaluate(() => {
    const g = document.getElementById("gate"), r = g.getBoundingClientRect();
    const go = document.getElementById("gateGo").getBoundingClientRect();
    const pw = document.getElementById("gatePw");
    return { z: getComputedStyle(g).zIndex, locked: SBMM.gate.locked(),
             covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1,
             btn: [Math.round(go.width), Math.round(go.height)],
             pwFont: parseFloat(getComputedStyle(pw).fontSize),
             token: localStorage.getItem("sbmm.gate.v1") };
  });
  console.log("gate on touch: z", g0.z, "| covers:", g0.covers, "| Enter button",
              g0.btn.join("x"), "px | password field", g0.pwFont + "px");
  if (!g0.locked || !g0.covers || g0.z !== "9000") fail("the gate is not a full-viewport cover at z 9000", g0);
  /* the gate is the first thing a thumb touches — same 44 px / 16 px rule */
  if (g0.btn[1] < 44) fail("the gate's Enter button is under 44 px on a phone", g0.btn);
  if (g0.pwFont < 16) fail("the gate's password field is under 16 px — iOS will zoom the page", g0.pwFont);
  if (g0.token) fail("an unlock token existed before anyone unlocked");
  await gp.waitForSelector("#loading", { state: "hidden", timeout: 240000 });

  /* a TAP is the only input a phone has: it must reach the button (the gate
     stops pointer events in the capture phase on itself, and the delegation
     handler is a second listener on that same node) */
  await gp.fill("#gatePw", "sulphurbank");
  await gp.tap("#gateGo");
  await gp.waitForTimeout(700);
  const g1 = await gp.evaluate(() => ({ gate: !!document.getElementById("gate"),
    msg: (document.getElementById("gateMsg") || {}).textContent,
    val: (document.getElementById("gatePw") || {}).value }));
  console.log("wrong password by tap:", JSON.stringify(g1.msg), "| field cleared:", g1.val === "");
  if (!g1.gate || g1.val !== "" || !/that is not it/.test(g1.msg || ""))
    fail("a tapped wrong password was not refused properly", g1);

  await gp.fill("#gatePw", gatePassword(ROOT));
  await gp.tap("#gateGo");
  await gp.waitForFunction(() => !document.getElementById("gate"), null, { timeout: 4000 })
    .catch(() => fail("the gate was still in the DOM 4 s after the right password was tapped"));
  const g2 = await gp.evaluate(() => {
    let t = null; try { t = JSON.parse(localStorage.getItem("sbmm.gate.v1") || "null"); } catch (e) {}
    return { token: !!(t && t.h && t.t), locked: SBMM.gate.locked(), field: document.body.classList.contains("field") };
  });
  console.log("unlocked by tap: token stored:", g2.token, "| locked:", g2.locked, "| field mode:", g2.field);
  if (!g2.token || g2.locked || !g2.field) fail("the tapped unlock did not complete cleanly", g2);
  if (gerr.length) fail("errors on the gate page", gerr.slice(0, 5));
  await gctx.close();
}

/* ===================================================================== */
/* 2. terrain — the DEM stack, in the field build                        */
/* ===================================================================== */
const terr = await page.evaluate(() => ({
  elev: SBMM.elev(6371600, 2128900),
  elevNW: SBMM.elev(6372000, 2130500),
  elevRes: SBMM.elev(6370800, 2129000),
  dems: SBMM.dems.map(d => d.name || (d.m && d.m.cell)),
  cells: SBMM.dems.map(d => d.m.cell),
  workers: SBMM.perf.demWorkers,
  chm: !!SBMM.chm
}));
console.log(`terrain: ${terr.elev[1]} ${terr.elev[0].toFixed(2)} ft · NW ${terr.elevNW[1]} `
  + `· residential ${terr.elevRes[1]} · grids ${terr.cells.join(",")} ft `
  + `· decoded in workers: ${terr.workers} · CHM: ${terr.chm}`);
if (!(terr.elev[0] > 1200 && terr.elev[0] < 1500)) fail("elevation out of range", terr.elev);
if (terr.cells.join(",") !== "1,1,2") fail("the DEM stack is not [1ft abp, 1ft res, 2ft site]", terr.cells);
if (terr.chm) fail("the field build must not carry the canopy height model");
if (!(terr.workers >= 3)) fail("terrain did not decode in workers", terr.workers);

/* ===================================================================== */
/* 3. the golden volume — Pile 1, perimeter TIN                          */
/* ===================================================================== */
await page.evaluate(() => SBMM.tools.volumeOfPile("Pile 1 (Fig 2)"));
await page.waitForFunction(() => {
  const f = SBMM.store.features.find(g => g.type === "volume");
  return f && f.props && f.props.fill_yd3 != null;
}, null, { timeout: 180000 });
const vol = await page.evaluate(() => {
  const f = SBMM.store.features.find(g => g.type === "volume");
  return { fill: f.props.fill_yd3, cut: f.props.cut_yd3, net: f.props.net_yd3, base: f.props.base };
});
console.log(`golden Pile 1: fill ${vol.fill.toFixed(1)} yd³, cut ${vol.cut.toFixed(1)}, `
  + `net ${vol.net.toFixed(1)} — base ${vol.base}`);
if (Math.abs(vol.fill - 278.4) > 10 || Math.abs(vol.net + 48.1) > 10)
  fail("the golden Pile 1 volume moved in the field build", vol);

/* ===================================================================== */
/* 4. water — a raindrop, and the survey                                 */
/* ===================================================================== */
/* the returned object holds Leaflet layers, so the block returns nothing —
   `page.evaluate` also AWAITS a returned promise, which would block here */
await page.evaluate(() => { SBMM.water.dropAt(6372100, 2128600, { name: "Field drop" }); });
await page.waitForFunction(() => SBMM.store.features.some(f => f.type === "flow"), null, { timeout: 180000 });
const drop = await page.evaluate(() => {
  const f = SBMM.store.features.find(g => g.type === "flow");
  return { pts: f.pts.length, len: f.props.length_ft, fall: f.props.fall_ft,
           end: f.props.end && f.props.end.reason, dem: f.props.dem };
});
console.log(`raindrop: ${drop.pts} vertices, ${Math.round(drop.len)} ft, `
  + `${drop.fall == null ? "—" : drop.fall.toFixed(1)} ft of fall, ends "${drop.end}" on the ${drop.dem} grid`);
if (!(drop.pts > 5 && drop.len > 50)) fail("the raindrop did not run", drop);

const surv = await page.evaluate(() => {
  const ds = SBMM.datasets.list().find(d => /survey/i.test(d.id || d.name || ""));
  const D = SBMM.survey && SBMM.survey.data ? SBMM.survey.data() : null;
  return { rows: D ? D.features.length : null, layers: D ? D.layers.length : null,
           shots: ds ? ds.points.length : null, name: ds ? ds.name : null };
});
console.log("survey (Aug 2026):", surv.rows, "line features in", surv.layers, "layers ·",
            surv.shots, "shots in", JSON.stringify(surv.name));
if (!surv.rows || surv.rows < 20) fail("the August-2026 survey linework is missing", surv);
if (surv.shots !== 24) fail("the survey's 24 shots are not in the field build", surv);

/* the storm-drainage network (v12 §5.1): ~27 kB, so it stays in the field build
   — the rows, the master switch and the kernel list all work out on site */
const storm = await page.evaluate(() => {
  const D = SBMM_DATA.storm_network;
  if (!D) return { err: "no payload" };
  const before = SBMM.storm.enabled();
  SBMM.storm.setEnabled(false, true);
  const off = SBMM.storm.conduitsFor([6372400, 2127300, 6374000, 2128000]).length;
  SBMM.storm.setEnabled(true, true);
  const on = SBMM.storm.conduitsFor([6372400, 2127300, 6374000, 2128000]).length;
  SBMM.storm.setEnabled(before, true);
  return { nodes: D.nodes.length, conduits: D.conduits.length,
           rowsOn: D.layers.filter(l => SBMM.layerState.isOn("framework", l.key)).length,
           glyphs: document.querySelectorAll(".stormnode").length,
           chip: !!document.getElementById("stormChip"), off, on };
});
console.log("storm network:", JSON.stringify(storm));
if (storm.err) fail("the storm network is missing from the field build", storm);
if (storm.nodes !== 44 || storm.conduits !== 26 || storm.rowsOn !== 3 || storm.glyphs !== 44)
  fail("the storm rows did not build in field mode", storm);
if (!storm.chip || storm.off !== 0 || storm.on < 1)
  fail("the storm master switch does not work in field mode", storm);

/* ===================================================================== */
/* 5. the four excluded payloads — tolerated, never an error             */
/* ===================================================================== */
await clearToasts();
const absent = await page.evaluate(async () => {
  const out = {};
  out.surfaces = (SBMM.CadNative.surfaces || []).length;
  out.cadGroups = (SBMM.CadNative.groupSpecs() || []).length;
  out.cadLayers = (SBMM.CadNative.layers || []).length;
  out.sheets = SBMM.sheets.index().length;
  out.sheetsWithRender = SBMM.sheets.index().filter(s => s.url).length;
  out.chm = !!SBMM.chm;
  out.designGis = (SBMM_DATA.design_gis && SBMM_DATA.design_gis.features || []).length;
  out.designSheets = Object.keys((SBMM_DATA.design_ea && SBMM_DATA.design_ea.sheets) || {}).length;
  out.refSurfText = (document.getElementById("refSurfList") || {}).textContent || "";
  /* Every command that needs one of the four has to REFUSE with a toast. One at
     a time with a gap between: there is ONE toast element, so two refusals in the
     same task overwrite each other and only the last is ever seen. */
  const pause = () => new Promise(r => setTimeout(r, 200));
  SBMM.sheets.open("C-106");            await pause();
  SBMM.layerMan.open();                 await pause();
  out.layerManOpen = !!document.getElementById("layerMan");
  SBMM.isopach.dialog();                await pause();
  await SBMM.trees.cmdTrees();          await pause();
  await SBMM.smartbound.cmdStands();    await pause();
  return out;
});
await wait(400);
const absentToasts = await toasts();
console.log(`absent payloads: surfaces ${absent.surfaces}, CAD groups ${absent.cadGroups}, `
  + `CHM ${absent.chm}, sheet renders ${absent.sheetsWithRender} of ${absent.sheets} listed`);
console.log("  still present: design GIS", absent.designGis, "features ·",
            absent.designSheets, "registered sheet overlays");
console.log("  refusals:", JSON.stringify(absentToasts));
if (absent.surfaces || absent.cadGroups || absent.chm) fail("an excluded payload is present", absent);
if (absent.sheets !== 20 || absent.sheetsWithRender !== 0)
  fail("the sheet manifest should list all 20 with no renders", absent);
if (!absent.designGis || absent.designGis < 500) fail("the native design GIS is missing", absent);
if (absent.layerManOpen) fail("the Layer manager opened with no CAD payload to manage");
for (const re of [/field build|full-sheet render/i, /native CAD payload/i,
                  /design surface/i, /canopy height model/i])
  if (!absentToasts.some(t => re.test(t)))
    fail("a refusal was silent — every one must toast (" + re + ")", absentToasts);
if (!/field build/i.test(absent.refSurfText)) fail("the surfaces list does not say why it is empty", absent.refSurfText);

/* ===================================================================== */
/* 6. field mode — the layout (§4.3)                                     */
/* ===================================================================== */
const layout = await page.evaluate(() => {
  const R = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const btns = [...document.querySelectorAll("#fieldBar .fbtn")].map(b => {
    const r = b.getBoundingClientRect();
    return { a: b.dataset.fa, w: Math.round(r.width), h: Math.round(r.height) };
  });
  const cs = getComputedStyle(document.getElementById("cmdIn"));
  return {
    field: document.body.classList.contains("field"),
    api: SBMM.field.on(),
    topbarShown: getComputedStyle(document.getElementById("topbar")).display !== "none",
    top: R("#fieldTop"), bar: R("#fieldBar"), stage: R("#stage"),
    btns,
    hudBottom: Math.round(document.getElementById("modeHud").getBoundingClientRect().bottom),
    barTop: Math.round(document.getElementById("fieldBar").getBoundingClientRect().top),
    cmdFont: parseFloat(cs.fontSize),
    watermark: !!document.getElementById("watermark")
  };
});
console.log(`field mode: body.field ${layout.field} (API ${layout.api}) · desktop top bar hidden `
  + `${!layout.topbarShown} · action bar ${layout.bar.join("x")} · stage ${layout.stage.join("x")}`);
console.log("  buttons:", layout.btns.map(b => `${b.a} ${b.w}x${b.h}`).join(", "));
if (!layout.field || !layout.api) fail("field mode did not switch itself on", layout);
if (layout.topbarShown) fail("the desktop top bar is still shown in field mode");
const want = ["position", "inspect", "raindrop", "photo", "note", "layers"];
for (const k of want) {
  const b = layout.btns.find(x => x.a === k);
  if (!b) fail("the " + k + " action button is missing");
  if (b.w < 44 || b.h < 44) fail(`the ${k} button is smaller than 44 px`, b);
}
if (!layout.btns.some(b => b.a === "more")) fail("the More button is missing");
if (layout.cmdFont < 16) fail("a control font is under 16 px — iOS will zoom the page", layout.cmdFont);
if (layout.hudBottom > layout.barTop) fail("the Mode HUD is not above the action bar", layout);
if (!layout.watermark) fail("the watermark is gone in field mode");

/* the Layers sheet opens and closes by tap */
await page.tap('#fieldBar .fbtn[data-fa="layers"]');
await wait(900);                                     // the slide-up transition, and then some
const openSheet = await page.evaluate(() => {
  const el = document.getElementById("leftdock");
  const d = el.getBoundingClientRect();
  return { which: document.body.dataset.fsheet, top: Math.round(d.top), bottom: Math.round(d.bottom),
           h: Math.round(d.height), vh: innerHeight,
           transform: getComputedStyle(el).transform,
           barTop: Math.round(document.getElementById("fieldBar").getBoundingClientRect().top),
           scrim: !document.getElementById("fieldScrim").hidden,
           rows: document.querySelectorAll("#layers .lyr").length };
});
console.log(`Layers sheet: ${openSheet.which}, ${openSheet.h} px tall, y ${openSheet.top}..${openSheet.bottom} `
  + `of ${openSheet.vh} · ${openSheet.rows} layer rows · scrim ${openSheet.scrim}`);
if (openSheet.which !== "left" || !openSheet.scrim) fail("the Layers sheet did not open", openSheet);
if (!openSheet.rows) fail("the Layers sheet came up empty");
/* it has to be ON the screen and sitting on top of the action bar — a sheet
   whose head is above y=0 has its tabs and its first rows off the display */
if (openSheet.top < 0 || openSheet.top > openSheet.vh - 200)
  fail("the Layers sheet is not on screen", openSheet);
if (Math.abs(openSheet.bottom - openSheet.barTop) > 2)
  fail("the Layers sheet does not sit on the action bar", openSheet);
/* tapping the map above the sheet dismisses it. NOT page.tap("#fieldScrim"):
   the scrim is inset:0, so its centre is under the sheet and Playwright would
   wait forever for the sheet to stop intercepting. */
await page.touchscreen.tap(206, 120);
await wait(700);
const shutSheet = await page.evaluate(() => ({
  which: document.body.dataset.fsheet || null,
  top: Math.round(document.getElementById("leftdock").getBoundingClientRect().top),
  barTop: Math.round(document.getElementById("fieldBar").getBoundingClientRect().top),
  vh: innerHeight,
  scrim: !document.getElementById("fieldScrim").hidden
}));
console.log("Layers sheet closed:", shutSheet.which === null,
            "| parked below the stage: top", shutSheet.top, "vs action bar", shutSheet.barTop);
if (shutSheet.which !== null || shutSheet.scrim) fail("the Layers sheet did not close by tap", shutSheet);
/* parked: its top edge is at or below the action bar, so none of it is on the stage */
if (shutSheet.top < shutSheet.barTop) fail("the closed sheet is still on the stage", shutSheet);

/* a popup becomes a bottom card carrying the SAME js/popups.js html */
await page.evaluate(() => {
  SBMM.field.closeCard();
  const f = SBMM.store.features.find(g => g.type === "flow");
  SBMM.map.openPopup(L.popup().setLatLng([f.pts[0][1], f.pts[0][0]]).setContent(SBMM.popups.forFeature(f)));
  return null;
});
await wait(350);
const cardCheck = await page.evaluate(() => {
  const c = document.getElementById("fieldCard");
  const r = c.getBoundingClientRect();
  return { shown: !c.hidden, w: Math.round(r.width), full: Math.round(r.width) >= innerWidth - 1,
           leafletPopups: document.querySelectorAll(".leaflet-popup").length,
           hasFlowRows: /Ponds crossed/.test(c.textContent),
           fovl: document.body.classList.contains("fovl") };
});
console.log(`popup as bottom card: shown ${cardCheck.shown}, full width ${cardCheck.full}, `
  + `leaflet popups left open ${cardCheck.leafletPopups}, same builder ${cardCheck.hasFlowRows}`);
if (!cardCheck.shown || !cardCheck.full || cardCheck.leafletPopups || !cardCheck.hasFlowRows)
  fail("the popup did not become a bottom card", cardCheck);
await page.evaluate(() => SBMM.field.closeCard());

/* ===================================================================== */
/* 7. a raindrop by tap                                                  */
/* ===================================================================== */
const flowsBefore = await page.evaluate(() => SBMM.store.features.filter(f => f.type === "flow").length);
await page.evaluate(() => { SBMM.map.setView([2128600, 6372100], 1); });
await wait(500);
await page.tap('#fieldBar .fbtn[data-fa="raindrop"]');
await wait(250);
const armed = await page.evaluate(() => ({ mode: SBMM.mode.current(), tool: SBMM.tools.active() }));
if (armed.mode !== "raindrop" || armed.tool !== "raindrop") fail("the Raindrop button did not arm the mode", armed);
const p = await page.evaluate(() => {
  const c = SBMM.map.latLngToContainerPoint([2128560, 6372060]);
  const r = document.getElementById("map").getBoundingClientRect();
  return { x: Math.round(r.left + c.x), y: Math.round(r.top + c.y) };
});
await page.touchscreen.tap(p.x, p.y);
await page.waitForFunction(n => SBMM.store.features.filter(f => f.type === "flow").length > n,
  flowsBefore, { timeout: 180000 });
const tapped = await page.evaluate(() => {
  const fs = SBMM.store.features.filter(f => f.type === "flow");
  const f = fs[fs.length - 1];
  return { n: fs.length, len: f.props.length_ft, name: f.name, cls: SBMM.myWork.classOf(f) };
});
console.log(`raindrop by tap: ${tapped.n} flows, newest "${tapped.name}" ${Math.round(tapped.len)} ft `
  + `(My work class: ${tapped.cls})`);
if (tapped.n <= flowsBefore) fail("a tap on the map did not trace a raindrop");
await page.evaluate(() => SBMM.mode.navigate());

/* ===================================================================== */
/* 8. POSITION — refused, then granted (§4.4)                            */
/* ===================================================================== */
await clearToasts();
const featsBefore = await page.evaluate(() => SBMM.store.features.length);
await page.tap('#fieldBar .fbtn[data-fa="position"]');
await wait(2500);
const denied = await page.evaluate(() => ({
  fix: SBMM.field.fix(), watching: SBMM.field.watching(),
  feats: SBMM.store.features.length,
  dots: document.querySelectorAll(".fixdot").length
}));
const deniedToasts = await toasts();
/* Headless Chromium with no grant does not fire the error callback at all — the
   watch simply never calls back — so what has to be true here is what §4.4
   actually promises: nothing is placed, and the user is told something. */
console.log("position, no permission: fix", denied.fix, "· marker", denied.dots,
            "· features created", denied.feats - featsBefore, "· toasts", JSON.stringify(deniedToasts));
if (denied.fix) fail("a position was invented without a permission grant", denied);
if (denied.feats !== featsBefore) fail("Position created a feature without a fix");
if (!deniedToasts.length) fail("Position refused silently — every refusal must toast");

await ctx.grantPermissions(["geolocation"]);
await ctx.setGeolocation({ latitude: 39.00603339, longitude: -122.66888086, accuracy: 12 });
await page.evaluate(() => { if (SBMM.field.watching()) SBMM.field.stopLocate(); });
await page.tap('#fieldBar .fbtn[data-fa="position"]');
await page.waitForFunction(() => !!SBMM.field.fix(), null, { timeout: 30000 })
  .catch(() => fail("no fix arrived after the geolocation permission was granted"));
await wait(400);
const fixed = await page.evaluate(() => {
  const f = SBMM.field.fix();
  return { f, dot: document.querySelectorAll(".fixmk .fixdot").length,
           m: SBMM.field.markers(),
           live: !!document.querySelector('#fieldBar .fbtn[data-fa="position"].live') };
});
const dev = Math.hypot(fixed.f.x - 6371600, fixed.f.y - 2128900);
console.log(`position, granted: ${fixed.f.x.toFixed(1)} E, ${fixed.f.y.toFixed(1)} N `
  + `(${dev.toFixed(2)} ft from the seeded point) · accuracy ${fixed.f.acc_ft.toFixed(1)} ft `
  + `· marker drawn ${fixed.dot === 1} · accuracy circle ${fixed.m.accuracy_ft && fixed.m.accuracy_ft.toFixed(1)} ft `
  + `· button live ${fixed.live}`);
if (dev > 2) fail("the fix did not convert to the right State Plane point", { dev });
if (fixed.dot !== 1) fail("the position marker is not on the map", fixed);
if (!(fixed.f.acc_ft > 20 && fixed.f.acc_ft < 60)) fail("the accuracy is not 12 m in feet", fixed.f);
/* the marker IS the centre of its accuracy circle, so it is inside it by
   construction; what has to be true is that the circle exists and matches */
if (!fixed.m.inCircle || Math.abs(fixed.m.accuracy_ft - fixed.f.acc_ft) > 0.01)
  fail("the accuracy circle is missing or does not match the fix", fixed.m);
await page.evaluate(() => SBMM.field.stopLocate());

/* ===================================================================== */
/* 9. PHOTO — EXIF placement, thumb, session round-trip, export          */
/* ===================================================================== */
await clearToasts();
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.tap('#fieldBar .fbtn[data-fa="photo"]')
]);
await chooser.setFiles(FIXTURE);
await page.waitForFunction(() => SBMM.store.features.some(f => f.type === "photo"), null, { timeout: 60000 });
await wait(500);
const photo = await page.evaluate(() => {
  const f = SBMM.store.features.find(g => g.type === "photo");
  const p = f.props;
  return { id: f.id, name: f.name, group: f.group, pts: f.pts,
           source: p.source, taken: p.taken, w: p.w, h: p.h,
           img: (p.img || "").slice(0, 22), imgLen: (p.img || "").length,
           thumb: (p.thumb || "").slice(0, 22), thumbLen: (p.thumb || "").length,
           cls: SBMM.myWork.classOf(f),
           marker: document.querySelectorAll(".photomk").length,
           inTree: !!document.querySelector(`.ftrow[data-fid="${f.id}"]`)
             || [...document.querySelectorAll("#featTree .ftrow")].length > 0,
           popup: SBMM.popups.forFeature(f) };
});
const perr = Math.hypot(photo.pts[0][0] - FIX_SP[0], photo.pts[0][1] - FIX_SP[1]);
console.log(`photo: "${photo.name}" placed ${photo.source} at ${photo.pts[0][0].toFixed(1)} E, `
  + `${photo.pts[0][1].toFixed(1)} N — ${perr.toFixed(2)} ft from the fixture's EXIF position`);
console.log(`  taken ${photo.taken} · ${photo.w}x${photo.h} px · image ${(photo.imgLen / 1024).toFixed(0)} kB `
  + `· thumb ${(photo.thumbLen / 1024).toFixed(0)} kB · group "${photo.group}" · My work class "${photo.cls}"`);
if (photo.source !== "exif") fail("the photo was not placed from its own EXIF GPS", photo.source);
if (perr > 2) fail("the photo did not land within 2 ft of its EXIF position", { perr });
if (photo.taken !== FIX_TAKEN) fail("DateTimeOriginal was not read", photo.taken);
if (!photo.thumb.startsWith("data:image/jpeg")) fail("the photo has no thumbnail", photo.thumb);
if (!(photo.thumbLen < photo.imgLen)) fail("the thumbnail is not smaller than the image");
if (!(photo.h > photo.w)) fail("EXIF orientation 6 was not applied — the frame should be portrait", photo);
if (!(Math.max(photo.w, photo.h) <= 1600)) fail("the photo was not downscaled to 1600 px", photo);
if (photo.cls !== "field") fail("the photo is not in the Field My-work class", photo.cls);
if (photo.marker !== 1) fail("the photo marker is not on the map", photo.marker);
if (!/photofull/.test(photo.popup)) fail("the photo popup does not carry the image full width");

/* the My-work "Field" row exists, and appending it left CLASSES[4] alone */
const mywork = await page.evaluate(() => ({
  classes: SBMM.myWork.CLASSES.map(c => c[0]),
  row: !!SBMM.layerState.rec("mywork", "field"),
  counts: SBMM.myWork.counts()
}));
console.log("My work classes:", mywork.classes.join(","), "| Field row:", mywork.row,
            "| photos:", mywork.counts.field);
if (mywork.classes[4] !== "imported") fail("CLASSES[4] is no longer `imported` — classOf() reads that index", mywork.classes);
if (!mywork.row || mywork.counts.field !== 1) fail("the Field class row is wrong", mywork);

/* undo/redo of a photo, the two-closure contract */
const ur = await page.evaluate(() => {
  const f = SBMM.store.features.find(g => g.type === "photo");
  const id = f.id;
  /* walk back to the photo entry */
  let guard = 0;
  while (SBMM.undo.canUndo() && SBMM.undo.labels().undo !== "photo " + f.name && guard++ < 20) SBMM.undo.pop();
  const label = SBMM.undo.labels().undo;
  SBMM.undo.pop();
  const gone = !SBMM.store.byId(id);
  SBMM.undo.redo();
  const back = SBMM.store.byId(id);
  return { label, gone, back: !!back, sameId: back && back.id === id,
           marker: document.querySelectorAll(".photomk").length,
           img: !!(back && back.props.img) };
});
console.log(`photo undo/redo: "${ur.label}" → removed ${ur.gone} → back ${ur.back} `
  + `(same id ${ur.sameId}, marker ${ur.marker}, image kept ${ur.img})`);
if (!ur.gone || !ur.back || !ur.sameId || ur.marker !== 1 || !ur.img)
  fail("the photo undo/redo cycle is broken", ur);

/* session round-trip: v8, rebuilt from props, no jobs spawned */
const rt = await page.evaluate(async () => {
  const ser = SBMM.store.serialize();
  const mine = ser.features.filter(f => f.type === "photo");
  const jobs0 = SBMM.compute.stats.workerJobs;
  SBMM.store.features.filter(f => f.type === "photo").forEach(f => SBMM.store.remove(f));
  SBMM.store.restore({ app: "SBMM Site Explorer", version: ser.version, features: mine });
  await new Promise(r => setTimeout(r, 300));
  const f = SBMM.store.features.find(g => g.type === "photo");
  return { version: ser.version, saved: mine.length,
           back: SBMM.store.features.filter(g => g.type === "photo").length,
           pts: f && f.pts, taken: f && f.props.taken, source: f && f.props.source,
           thumb: !!(f && f.props.thumb), img: !!(f && f.props.img),
           marker: document.querySelectorAll(".photomk").length,
           jobsBefore: jobs0, jobsAfter: SBMM.compute.stats.workerJobs };
});
console.log(`session v${rt.version}: ${rt.saved} photo written, ${rt.back} restored — `
  + `taken ${rt.taken}, placed ${rt.source}, image ${rt.img}, thumb ${rt.thumb}`);
if (rt.version !== 8) fail("the session version did not bump to 8", rt.version);
if (rt.back !== 1 || !rt.img || !rt.thumb) fail("the photo did not survive the round trip", rt);
if (Math.hypot(rt.pts[0][0] - FIX_SP[0], rt.pts[0][1] - FIX_SP[1]) > 0.02)
  fail("the restored photo moved", rt.pts);
if (rt.marker !== 1) fail("the restored photo has no marker");
if (rt.jobsBefore != null && rt.jobsAfter !== rt.jobsBefore)
  fail("restoring a photo spawned a compute job", rt);

/* exports: the record always, the image only behind the checkbox */
const exp = await page.evaluate(() => {
  const plain = SBMM.io.collection("sp").features.find(f => f.properties.tool === "photo");
  const withImg = SBMM.io.collection("sp", { photoImages: true }).features.find(f => f.properties.tool === "photo");
  return {
    geom: plain.geometry.type, coords: plain.geometry.coordinates,
    keys: Object.keys(plain.properties).sort(),
    plainImg: plain.properties.img !== undefined,
    withImg: typeof withImg.properties.img === "string" && withImg.properties.img.length > 1000
  };
});
console.log("GeoJSON:", exp.geom, "· properties", exp.keys.join(","),
            "· image without the checkbox:", exp.plainImg, "· with it:", exp.withImg);
if (exp.geom !== "Point") fail("a photo did not export as a Point", exp.geom);
for (const k of ["taken", "note", "source"])
  if (!exp.keys.includes(k)) fail("the photo export is missing " + k, exp.keys);
if (exp.plainImg) fail("the image went out without the checkbox being ticked");
if (!exp.withImg) fail("the image did not go out when the checkbox was ticked");

/* the export dialog itself, since it is the only way a user reaches that flag */
const dlg = await page.evaluate(async () => {
  const p = SBMM.field.askPhotoExport(1);
  await new Promise(r => setTimeout(r, 120));
  const box = document.getElementById("photoExportAsk");
  const cb = box && box.querySelector("#peImg");
  const has = !!box && !!cb;
  if (box) box.querySelector("#peNo").click();
  return { has, answer: await p };
});
console.log("photo export dialog: checkbox present", dlg.has, "· cancel returns", JSON.stringify(dlg.answer));
if (!dlg.has) fail("the photo export dialog has no checkbox");

/* ===================================================================== */
/* 10. NOTE                                                              */
/* ===================================================================== */
await page.evaluate(() => { SBMM.map.setView([2128900, 6371600], 1); });
await wait(500);
const notePrompt = await page.evaluate(async () => {
  const before = SBMM.store.features.filter(f => f.type === "text").length;
  SBMM.field.note();
  await new Promise(r => setTimeout(r, 150));
  const box = document.querySelector(".fmodal .fask");
  if (!box) return { box: false };
  const ta = box.querySelector("#fkIn");
  const font = parseFloat(getComputedStyle(ta).fontSize);
  ta.value = "seep at the toe of the west berm";
  box.querySelector("#fkOk").click();
  await new Promise(r => setTimeout(r, 250));
  return { box: true, font, before, picking: SBMM.draw.isPicking() };
});
if (!notePrompt.box) fail("the note prompt did not open");
if (notePrompt.font < 16) fail("the note field is under 16 px — iOS will zoom", notePrompt.font);
if (!notePrompt.picking) fail("the note did not ask for a tap when there was no device fix");
/* no device fix (the watch was stopped), so it asks where — tap the map */
const np = await page.evaluate(() => {
  const c = SBMM.map.latLngToContainerPoint([2128950, 6371700]);
  const r = document.getElementById("map").getBoundingClientRect();
  return { x: Math.round(r.left + c.x), y: Math.round(r.top + c.y) };
});
await page.touchscreen.tap(np.x, np.y);
await wait(700);
const noteRes = await page.evaluate(before => {
  const after = SBMM.store.features.filter(f => f.type === "text");
  const f = after[after.length - 1];
  return { made: after.length > before, text: f && f.props && f.props.text,
           undo: SBMM.undo.labels().undo, cls: f && SBMM.myWork.classOf(f) };
}, notePrompt.before);
console.log(`note: prompt shown, ${notePrompt.font}px field, asked for a tap, `
  + `made ${noteRes.made} — "${noteRes.text}" (undo: ${noteRes.undo}, class ${noteRes.cls})`);
if (!noteRes.made || noteRes.text !== "seep at the toe of the west berm") fail("the note was not placed", noteRes);
if (noteRes.undo !== "note") fail("placing a note is not undoable", noteRes.undo);

/* ===================================================================== */
/* 11. SAMPLES NEARBY                                                    */
/* ===================================================================== */
const near = await page.evaluate(() => {
  const list = SBMM.field.nearbySamples(20);
  const c = document.getElementById("fieldCard");
  return { n: list ? list.length : 0, sorted: list ? list.every((p, i) => !i || p.d >= list[i - 1].d) : false,
           card: !c.hidden, rows: c.querySelectorAll(".fnrow").length };
});
console.log(`samples nearby: ${near.n} listed, sorted ${near.sorted}, ${near.rows} tappable rows`);
if (near.n !== 20 || !near.sorted || near.rows !== 20) fail("samples nearby is wrong", near);
await page.evaluate(() => SBMM.field.closeCard());

/* ===================================================================== */
/* 12. the command surface                                               */
/* ===================================================================== */
const cmds = await page.evaluate(() => {
  const seen = new Map(), dup = [];
  for (const c of SBMM.cmd.commands())
    for (const w of [c.n, ...c.a]) { if (seen.has(w)) dup.push(w + " (" + seen.get(w) + " vs " + c.n + ")"); else seen.set(w, c.n); }
  return { n: SBMM.cmd.commands().length, dup,
           field: (SBMM.cmd.find("FIELD") || {}).n, gps: (SBMM.cmd.find("GPS") || {}).n,
           photo: (SBMM.cmd.find("PHOTO") || {}).n, note: (SBMM.cmd.find("NOTE") || {}).n,
           mobile: (SBMM.cmd.find("MOBILE") || {}).n };
});
console.log(`commands: ${cmds.n}, alias collisions ${cmds.dup.length} · FIELD→${cmds.field}, `
  + `GPS→${cmds.gps}, PHOTO→${cmds.photo}, NOTE→${cmds.note}, MOBILE→${cmds.mobile}`);
if (cmds.dup.length) fail("shadowed command aliases", cmds.dup);
if (cmds.field !== "FIELD" || cmds.gps !== "GPS" || cmds.photo !== "PHOTO" || cmds.note !== "NOTE")
  fail("a field command is missing", cmds);

/* FIELD turns it off and on again, and the switch in help follows */
const fieldCmd = await page.evaluate(() => {
  SBMM.cmd.run("FIELD");
  const off = { body: document.body.classList.contains("field"), api: SBMM.field.on(),
                sw: document.getElementById("fieldSwitch").checked,
                topbar: getComputedStyle(document.getElementById("topbar")).display !== "none" };
  SBMM.cmd.run("FIELD");
  const on = { body: document.body.classList.contains("field"), api: SBMM.field.on(),
               sw: document.getElementById("fieldSwitch").checked };
  return { off, on };
});
console.log("FIELD off:", JSON.stringify(fieldCmd.off), "· back on:", JSON.stringify(fieldCmd.on));
if (fieldCmd.off.body || fieldCmd.off.api || fieldCmd.off.sw || !fieldCmd.off.topbar)
  fail("FIELD did not turn field mode off (and give the desktop bar back)", fieldCmd.off);
if (!fieldCmd.on.body || !fieldCmd.on.api || !fieldCmd.on.sw) fail("FIELD did not turn it back on", fieldCmd.on);

/* ===================================================================== */
/* 13. the 3D view, on touch                                             */
/* ===================================================================== */
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => SBMM.viewer3d.isOpen(), null, { timeout: 180000 });
await wait(2500);
const v3d = await page.evaluate(() => ({
  open: SBMM.viewer3d.isOpen(),
  detail: document.getElementById("v3dDetail").value,
  touchAction: getComputedStyle(document.getElementById("v3dCanvas")).touchAction,
  barShown: [...document.querySelectorAll("#view3d .v3dbar > *")]
    .filter(e => getComputedStyle(e).display !== "none")
    .map(e => e.id || (e.querySelector("select") ? "drape" : e.tagName.toLowerCase())),
  orbit: SBMM.viewer3d.stats().orbit,
  /* v13 §3.1: "animate water" is on in the field build too — the particles are
     cheap, the terrain is the cost */
  animBox: !!document.getElementById("v3dAnimWater"),
  animChecked: !!(document.getElementById("v3dAnimWater") || {}).checked,
  animOn: SBMM.viewer3d.stats().waterAnimOn,
  stage3d: typeof SBMM.viewer3d.setWaterStage
}));
console.log(`3D on touch: open ${v3d.open} · detail "${v3d.detail}" · canvas touch-action `
  + `"${v3d.touchAction}" · bar shows ${JSON.stringify(v3d.barShown)}`
  + ` · animate water ${v3d.animBox ? "present" : "MISSING"}/${v3d.animOn}`);
if (!v3d.open) fail("the 3D view did not open");
if (!v3d.animBox || !v3d.animChecked || v3d.animOn !== true || v3d.stage3d !== "function")
  fail("the field build must carry the 'animate water' toggle, on, and setWaterStage", v3d);
if (v3d.detail !== "std") fail("3D did not open at standard detail in field mode", v3d.detail);
if (v3d.touchAction !== "none") fail("the 3D canvas does not take touch gestures", v3d.touchAction);

/* One finger orbits, two fingers pinch. Driven through CDP's own touch input
   rather than synthetic PointerEvents, so the browser produces the real pointer
   stream (ids, capture, coalescing) the rig listens to — a hand-built
   PointerEvent proves the handler runs, not that a finger reaches it. */
const cdp = await page.context().newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", {
  type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id, radiusX: 6, radiusY: 6, force: 1 }))
});
const box = await page.evaluate(() => {
  const r = document.getElementById("v3dCanvas").getBoundingClientRect();
  return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
});
const before3d = await page.evaluate(() => SBMM.viewer3d.stats().orbit);

await touch("touchStart", [{ x: box.cx, y: box.cy, id: 1 }]);
for (let i = 1; i <= 8; i++) {
  await touch("touchMove", [{ x: box.cx - i * 12, y: box.cy - i * 4, id: 1 }]);
  await wait(40);
}
await touch("touchEnd", []);
await wait(700);
const after3d = await page.evaluate(() => SBMM.viewer3d.stats().orbit);
const dth = Math.abs(after3d.theta - before3d.theta);
console.log(`one-finger orbit: theta ${before3d.theta.toFixed(3)} → ${after3d.theta.toFixed(3)} `
  + `(Δ ${dth.toFixed(3)} rad), phi ${before3d.phi.toFixed(3)} → ${after3d.phi.toFixed(3)}`);
if (dth < 0.05) fail("a one-finger touch drag did not orbit the 3D camera", { before3d, after3d });

const r0 = after3d.r;
await touch("touchStart", [{ x: box.cx - 40, y: box.cy, id: 1 }, { x: box.cx + 40, y: box.cy, id: 2 }]);
for (let i = 1; i <= 8; i++) {
  await touch("touchMove", [{ x: box.cx - 40 - i * 12, y: box.cy, id: 1 },
                            { x: box.cx + 40 + i * 12, y: box.cy, id: 2 }]);
  await wait(40);
}
await touch("touchEnd", []);
await wait(700);
const pinched = await page.evaluate(() => SBMM.viewer3d.stats().orbit.r);
console.log(`two-finger pinch: orbit radius ${Math.round(r0)} → ${Math.round(pinched)} ft`);
if (Math.abs(pinched - r0) < r0 * 0.05) fail("a two-finger pinch did not zoom", { r0, pinched });

await page.evaluate(() => SBMM.viewer3d.toggle());
await wait(600);

/* ===================================================================== */
/* 14. boot comparison, full vs field, same box, same descriptor         */
/* ===================================================================== */
if (compareTo) {
  const cctx = await browser.newContext({ ...PIXEL7 });
  const cp = await cctx.newPage();
  cp.setDefaultTimeout(300000);
  await unlock(cp);
  const s = Date.now();
  await cp.goto(__furl(__res(compareTo)).href);
  await cp.waitForSelector("#loading", { state: "hidden", timeout: 300000 });
  const fullMs = Date.now() - s;
  const marks = await cp.evaluate(() => SBMM.perf.report().find(r => r.stage === "boot-done"));
  await cctx.close();
  console.log(`\nboot on ${PIXEL7.viewport.width}x${PIXEL7.viewport.height}: `
    + `field ${(bootMs / 1000).toFixed(2)} s, full ${(fullMs / 1000).toFixed(2)} s `
    + `(full boot-done mark ${marks ? (marks.at_ms / 1000).toFixed(2) : "?"} s)`);
  if (bootMs > fullMs + 1000)
    fail("the field build boots more than 1 s slower than the full build", { bootMs, fullMs });
}


/* ===================================================================== */
/* the drainage map on a phone (v14 §4): the same kernel over the site grid
   DECIMATED TO 4 FT, and the card has to say which grid it is — a 978-acre
   answer computed at half the resolution is still the right answer, but only
   if it says so. The rows exist from boot like every other layer row.        */
{
  const t0 = Date.now();
  const D = await page.evaluate(async () => {
    const rows = ["drain_outlet", "drain_first", "drain_paths"]
      .map(id => !!document.querySelector(`.lyr[data-lid="${id}"]`));
    const R = await SBMM.drainage.run();
    if (!R) return { rows, failed: true };
    SBMM.drainage.showCard();
    const card = [...document.querySelectorAll("#resBody .res")]
      .find(el => /Drainage map/.test(el.querySelector("h4").textContent));
    return { rows, grid: R.gridFt, ms: R.ms_wall,
             acres: +(R.surveyedArea_ft2 / 43560).toFixed(1),
             outlets: R.sinks.length, loops: R.loops, flats: R.flats,
             cardSays: card ? card.textContent.replace(/\s+/g, " ") : null };
  });
  const wall = Date.now() - t0;
  console.log(`\ndrainage map (field): ${JSON.stringify(D)} in ${(wall / 1000).toFixed(1)} s`);
  if (D.failed) fail("the field build could not compute the drainage map", D);
  if (!D.rows.every(Boolean)) fail("the drainage rows are missing in field mode", D.rows);
  if (D.grid !== 4) fail("the field build did not run the drainage map at 4 ft", D);
  if (!/4-ft lidar grid/.test(D.cardSays || "")) fail("the field card does not name the 4-ft grid", D.cardSays);
  if (wall > 30000) fail("the field drainage map took over 30 s", wall);
  /* the pointer field must be acyclic at 4 ft as well as at 2 (a one-cell "pond"
     reached by the flood from above its own level used to point uphill into the
     neighbour that pointed back at it). A one-cell CLOSED depression is not a
     defect at this resolution and is reported as the sink it is. */
  if (D.loops || D.flats) fail("the 4-ft pointer field left cells unresolved", D);
  if (D.outlets < 2) fail("the 4-ft map found no outlets", D);
}

/* ===================================================================== */
/* the design storm on a phone (v14 Phase 2 §2 "Field build"): the dialog and
   the card work, and the cover raster IS in the field build — it is a few
   hundred kB, and without it every curve number would be a guess. The storm
   runs over the 4-ft drainage map above, and the card says which grid it is. */
{
  const t0 = Date.now();
  const S = await page.evaluate(async () => {
    SBMM.runoff.dialog();
    const box = document.getElementById("rainDlg");
    const dlg = { open: !!box, storms: box ? box.querySelectorAll("#rnStorm option").length : 0 };
    if (box) box.remove();
    const R = await SBMM.runoff.run({ storm: "25:24" });
    if (!R) return { dlg, failed: true };
    const card = [...document.querySelectorAll("#resBody .res")]
      .find(el => /Design storm/.test(el.querySelector("h4").textContent));
    return { dlg, grid: R.gridFt, storm: R.storm.name, provisional: R.provisional,
             outlets: R.outlets.length, ponds: R.routing.length,
             volume: +R.totals.volume_acft.toFixed(1), peak: R.totals.qPeak_cfs,
             cover: !!(window.SBMM_DATA && SBMM_DATA.cover_png),
             rows: ["runoff_cover", "runoff_depth"]
               .map(id => !!document.querySelector(`.lyr[data-lid="${id}"]`)),
             cardSays: card ? card.textContent.replace(/\s+/g, " ").slice(0, 1400) : null };
  });
  const wall = Date.now() - t0;
  console.log(`\ndesign storm (field): ${JSON.stringify(S)} in ${(wall / 1000).toFixed(1)} s`);
  if (S.failed) fail("the field build could not run the design storm", S);
  if (!S.dlg.open || S.dlg.storms < 5) fail("the Design storm dialog is not usable in field mode", S.dlg);
  if (!S.cover) fail("the cover raster is not in the field build", S);
  if (!S.rows.every(Boolean)) fail("the design-storm rows are missing in field mode", S.rows);
  if (S.outlets < 3) fail("the field design storm found no catchments", S);
  if (!(S.volume > 0)) fail("the field design storm produced no runoff volume", S);
  if (S.grid !== 4) fail("the field storm did not run over the 4-ft map", S);
  if (!/4-ft lidar grid/.test(S.cardSays || "")) fail("the field storm card does not name the grid", S.cardSays);
  if (wall > 60000) fail("the field design storm took over 60 s", wall);
}

/* ===================================================================== */
console.log("\npage errors:", errors.length ? errors.slice(0, 8) : "none");
await browser.close();
if (errors.some(e => !e.includes("favicon"))) { console.log("RESULT: errors present"); process.exit(2); }
console.log("RESULT: PASS");
