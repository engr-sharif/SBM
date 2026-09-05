/* Focused earthworks test: design surfaces, balance, uncertainty range,
   cross-sections and the report sheet. Faster to iterate on than the full e2e —
   the same assertions are folded into test/e2e.mjs. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";

const target = process.argv[2] || "/home/claude/repo/index.html";
const label = process.argv[3] || "folder";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(TIMEOUT);
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

console.log(`\n=== earthworks: ${label} ===`);
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
console.log("boot: OK");

/* a 300 x 300 ft box on known terrain inside the 1-ft mine-area window */
const BOX = [[6371400, 2128700], [6371700, 2128700], [6371700, 2129000], [6371400, 2129000]];

const pad = await page.evaluate(async (BOX) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const st = SBMM.design.rimStats(BOX);
  const f = SBMM.design.mkSurface(BOX.map(p => p.slice()), "ZZ Test Pad",
    { kind: "pad", padZ: +st.mean.toFixed(2), ratio: 3, side: "out" });
  for (let i = 0; i < 300 && !f._surf; i++) await wait(100);
  const c = SBMM.design.centroidZ ? null : null;
  const mid = [(BOX[0][0] + BOX[2][0]) / 2, (BOX[0][1] + BOX[2][1]) / 2];
  return {
    id: f.id, rim: st,
    hasSurf: !!f._surf, nx: f._surf && f._surf.nx, ny: f._surf && f._surf.ny, cell: f._surf && f._surf.cell,
    daylightLoops: f._daylight ? f._daylight.length : 0,
    daylightPts: f._daylight ? f._daylight.reduce((n, l) => n + l.length, 0) : 0,
    elevMid: SBMM.design.elev(f.id, mid[0], mid[1]),
    elevFar: SBMM.design.elev(f.id, 6380000, 2140000),
    padZ: f.props.padZ, cut: f.props.cut_yd3, fill: f.props.fill_yd3,
    contours: f._contours ? f._contours.length : 0,
    dlLayer: !!f._dlLayer
  };
}, BOX);
console.log("pad:", JSON.stringify(pad));
if (!pad.hasSurf) { console.log("FAIL: no design raster"); process.exit(1); }
if (!pad.daylightLoops) { console.log("FAIL: no daylight line"); process.exit(1); }
if (Math.abs(pad.elevMid - pad.padZ) > 0.01) { console.log("FAIL: pad interior is not at the pad elevation"); process.exit(1); }
if (!isNaN(pad.elevFar)) { console.log("FAIL: design elev should be NaN off the raster"); process.exit(1); }

/* volume of the terrain against that design surface */
const vol = await page.evaluate(async (BOX) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const surf = SBMM.design.list().find(f => f.name === "ZZ Test Pad");
  const v = SBMM.design.volumeAgainst(surf);
  for (let i = 0; i < 300 && v.props.fill_yd3 == null; i++) await wait(100);
  return { base: v.props.base, cut: v.props.cut_design_yd3, fill: v.props.fill_design_yd3,
           net: v.props.net_yd3, rows: [...v.card.querySelectorAll(".rrow span")].map(s => s.textContent) };
}, BOX);
console.log("volume vs design:", JSON.stringify(vol).slice(0, 300));
if (!/design surface/.test(vol.base || "")) { console.log("FAIL: base is not the design surface"); process.exit(1); }
if (!(vol.cut > 0 && vol.fill > 0)) { console.log("FAIL: cut/fill vs design not plausible"); process.exit(1); }

/* auto-balance on a smaller polygon */
const bal = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const BOX2 = [[6371450, 2128750], [6371600, 2128750], [6371600, 2128900], [6371450, 2128900]];
  const f = SBMM.design.mkSurface(BOX2, "ZZ Balance Pad", { kind: "pad", ratio: 3, side: "out" });
  for (let i = 0; i < 300 && !f._surf; i++) await wait(100);
  const before = { z: f.props.padZ, cut: f.props.cut_yd3, fill: f.props.fill_yd3 };
  const r = await SBMM.design.balance(f);
  return { before, after: r, iters: f.props.balance_iters, box: !!f.card.querySelector(".sbalbox") };
});
const balPct = bal.after ? Math.abs(bal.after.cut - bal.after.fill) / Math.max(1e-9, (bal.after.cut + bal.after.fill) / 2) * 100 : 999;
console.log("balance:", JSON.stringify(bal), "| cut-vs-fill diff:", balPct.toFixed(2), "%");
if (!bal.after) { console.log("FAIL: balance returned nothing"); process.exit(1); }
if (balPct > 2) { console.log("FAIL: balance did not converge to cut≈fill within 2%"); process.exit(1); }

/* uncertainty range on the Pile 1 footprint */
const rng = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.tools.volumeOfPile("Pile 1 (Fig 2)");
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  for (let i = 0; i < 300 && f.props.fill_yd3 == null; i++) await wait(100);
  const r = await SBMM.tools.volumeRange(f);
  return { r, box: !!f.card.querySelector(".vrangebox"), props: {
    lo: f.props.range_low_yd3, best: f.props.range_best_yd3, hi: f.props.range_high_yd3 } };
});
console.log("range:", JSON.stringify(rng).slice(0, 400));
if (!rng.r) { console.log("FAIL: no range"); process.exit(1); }
if (!(rng.r.lo <= rng.r.best && rng.r.best <= rng.r.hi)) { console.log("FAIL: low <= best <= high violated"); process.exit(1); }
if (rng.r.methods.length < 5) { console.log("FAIL: fewer than five base methods"); process.exit(1); }

/* sections along a 300-ft alignment at 50-ft stations */
const sec = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const surf = SBMM.design.list().find(f => f.name === "ZZ Test Pad");
  const A = [[6371400, 2128850], [6371700, 2128850]];
  const f = SBMM.sections.mkSections(A, "ZZ Sections", { interval: 50, width: 260, designId: surf.id });
  for (let i = 0; i < 300 && !f._sec; i++) await wait(100);
  for (let i = 0; i < 300 && !f._cross; i++) await wait(100);
  SBMM.sections.openPanel(f);
  await wait(400);
  return {
    ns: f._sec.ns, no: f._sec.no, total: f._sec.total,
    sta0: SBMM.sections.staLabel(0), staLast: SBMM.sections.staLabel(f._sec.sta[f._sec.ns - 1]),
    ea: f._endArea, cross: f._cross,
    plots: document.querySelectorAll("#secBody .secplot canvas").length,
    drawerOpen: document.getElementById("secDrawer").classList.contains("open"),
    lines: f._secLayer ? f._secLayer.getLayers().length : 0,
    csvLines: SBMM.sections.csvText(f).split("\n").length
  };
});
console.log("sections:", JSON.stringify(sec).slice(0, 500));
if (sec.ns !== 7) { console.log("FAIL: expected 7 sections at 50 ft over 300 ft, got " + sec.ns); process.exit(1); }
if (sec.plots !== 7) { console.log("FAIL: section panel did not plot every station"); process.exit(1); }
if (!sec.cross) { console.log("FAIL: no grid cross-check"); process.exit(1); }
console.log("end-area vs grid difference:", sec.cross.diffPct.toFixed(2), "%");
if (sec.cross.diffPct > 15) { console.log("FAIL: end-area and grid volumes disagree by more than 15%"); process.exit(1); }

/* report */
const rep = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const v = SBMM.store.features.find(f => f.type === "volume" && /cut\/fill/.test(f.name));
  await SBMM.report.open(v);
  await wait(1200);
  const fr = document.getElementById("rmFrame");
  const doc = fr.contentDocument;
  return {
    modal: !!document.getElementById("reportModal"),
    title: doc ? doc.title : null,
    h1: doc ? doc.querySelector("h1").textContent : null,
    author: doc ? /Mohammad Sharif/.test(doc.body.textContent) : false,
    tables: doc ? doc.querySelectorAll("table.qt").length : 0,
    qrows: doc ? doc.querySelectorAll("table.qt tbody tr").length : 0,
    hasFigure: doc ? !!doc.querySelector("figure img") : false,
    figBytes: doc ? doc.querySelector("figure img").src.length : 0,
    crs: doc ? /EPSG:6418/.test(doc.body.textContent) : false,
    planning: doc ? /two significant figures/.test(doc.body.textContent) : false
  };
});
console.log("report:", JSON.stringify(rep));
if (!rep.modal || !rep.tables || !rep.hasFigure) { console.log("FAIL: report sheet incomplete"); process.exit(1); }
if (!rep.author || !rep.crs) { console.log("FAIL: report title block missing author or CRS"); process.exit(1); }

/* session v5 round-trip with a surface and a section set */
const rt = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  document.getElementById("reportModal").remove();
  const s = SBMM.store.serialize();
  const mine = s.features.filter(f => f.type === "surface" || f.type === "sections");
  SBMM.store.features.filter(f => f.type === "surface" || f.type === "sections").forEach(f => SBMM.store.remove(f));
  SBMM.store.restore({ app: "SBMM Site Explorer", version: s.version, features: mine });
  const back = SBMM.store.features.filter(f => f.type === "surface" || f.type === "sections");
  const surf = back.find(f => f.type === "surface");
  for (let i = 0; i < 300 && surf && !surf._surf; i++) await wait(100);
  return { version: s.version, saved: mine.length, back: back.length,
           padZ: surf && surf.props.padZ, ratio: surf && surf.props.ratio,
           regen: !!(surf && surf._surf), daylight: surf && surf._daylight ? surf._daylight.length : 0 };
});
console.log("session v5 round-trip:", JSON.stringify(rt));
if (rt.version !== 6 || rt.back !== rt.saved || !rt.regen || !rt.daylight) {
  console.log("FAIL: v5 round-trip lost a design surface"); process.exit(1);
}

/* exports carry the derived geometry */
const exp = await page.evaluate(() => {
  const dxf = SBMM.dxf.buildDXF(SBMM.store.features.filter(f => f.visible !== false && f.pts && f.pts.length));
  return { grading: /\bGRADING\b/.test(dxf), section: /\bSECTION\b/.test(dxf), bytes: dxf.length };
});
console.log("exports:", JSON.stringify(exp));
if (!exp.grading || !exp.section) { console.log("FAIL: DXF is missing GRADING / SECTION layers"); process.exit(1); }

console.log("page errors:", errors.length ? errors.slice(0, 6) : "none");
await browser.close();
if (errors.some(e => !e.includes("favicon"))) { console.log("RESULT: errors present"); process.exit(2); }
console.log("RESULT: PASS");
