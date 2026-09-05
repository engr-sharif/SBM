/* E2E: open the app over file:// (the failure mode on the work computer),
   verify boot, tools, and reproduce the memo's Pile 1 volume validation. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { existsSync as __ex, readFileSync as __read } from "node:fs";
import { unlock, gatePassword } from "./gate.mjs";
import { block, S } from "./lib/blocks.mjs";

const target = process.argv[2]; // path to index.html or dist html
const label = process.argv[3] || target;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
/* headless chromium here runs software GL: with the high-detail mesh (~1.56M verts) plus the
   canopy surface and contours in the scene, the render loop can keep the main thread busy
   longer than Playwright's 30 s default actionability window, which made clicks flaky. */
page.setDefaultTimeout(TIMEOUT);
const errors = [];
const f2s = v => v == null || isNaN(v) ? "—" : Math.round(v).toLocaleString("en-US");
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

console.log(`\n=== ${label} ===`);
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto(__furl(__res(target)).href);

/* ---- fixtures (v18 §3) -------------------------------------------------
   State that later blocks need, declared with the code that makes it, so a
   selected block can be given it without running the forty blocks in front.
   In a FULL run each of these is built exactly once, by the block that always
   built it, in the same place — nothing moved. */
S.define("pile1", () => page.evaluate(async () => {
  SBMM.tools.volumeOfPile("Pile 1 (Fig 2)");
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  for (let i = 0; i < 200 && f.props.fill_yd3 == null; i++) await new Promise(r => setTimeout(r, 100));
  return f.props;
}));

/* §9 of docs/V10_WATER_SPEC.md, and the distance helper the water blocks read it
   with. Constants and a pure function, read by four blocks — module scope, so
   that "--only 9t" has them without running 9w. */
const WREF = {
  drop: [6371200, 2128674],          // §9.1, on the app's node convention
  dropZ: 1358.44, dropZTol: 0.05,
  reason: "nodata",
  end: [6370884.5, 2128611.5], endTol: 3,
  lastZ: 1326.10, lastZTol: 0.1,
  lengthRaw: 409.6,                  // simplified path: -3 % / +0.5 %
  ponds: 2,
  pond1: { level: 1330.96, cells: 12 },
  pond2: { level: 1329.76, cells: 19 },
  catchment: 3046,                   // ft2, +/- 3 %
  /* §9.2 — Herman Impoundment on the 2-ft site grid */
  z0: 1336.58, z0Tol: 0.02,
  seedCells: 223969,
  spill: 1343.84, spillTol: 0.05,
  spillAt: [6371927, 2127693], spillTol_ft: 15,
  next: [6371925, 2127693], nextTol: 6,
  freeboard: 7.26, freeboardTol: 0.05,
  storage: 6881929,                  // ft3, +/- 3 %
  areaAtSpill: 22.83,                // ac, +/- 3 %
  rimLow2: { level: 1344.34, at: [6372015, 2127571] },
  routeReason: "nodata",
  routeEnd: [6371177, 2127473], routeEndTol: 50,
  routeLength: 974,                  // ft, +/- 10 %
  stageRows: 42
};
const wdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

await block("1. boot completes (the old app hung here forever)", async () => {
/* 1. boot completes (the old app hung here forever) */
await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 })
  .catch(async () => {
    const txt = await page.textContent("#loading");
    console.log("BOOT FAILED — loader says:", txt.trim().slice(0, 300));
    process.exit(1);
  });
console.log("boot: OK (loader cleared)");
}, { always: true });

await block("1a. THE PASSWORD GATE", async () => {
/* 1a. THE PASSWORD GATE (v9.3).
   A second page, opened with no unlock token, so it meets the gate the way a
   colleague would. The gate must cover at z 9000, must let neither a keystroke
   nor a map click through to the app booting underneath it, must refuse a wrong
   password, and must let the right one in and then take itself out of the DOM.
   The password is not written in this file: test/gate.mjs reads it out of the
   one place the repo documents it and checks it against js/gate.js's hash. */
{
  const gp = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  gp.setDefaultTimeout(TIMEOUT);
  const gerr = [];
  gp.on("pageerror", e => gerr.push("pageerror: " + e.message));
  gp.on("console", m => { if (m.type() === "error") gerr.push("console: " + m.text()); });
  await gp.goto(__furl(__res(target)).href);           // deliberately NOT unlocked
  await gp.waitForSelector("#gate", { timeout: 60000 });

  const g0 = await gp.evaluate(() => {
    const g = document.getElementById("gate"), r = g.getBoundingClientRect();
    return {
      z: getComputedStyle(g).zIndex,
      covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1 && r.top <= 0 && r.left <= 0,
      field: !!document.getElementById("gateCv"),
      foot: (document.querySelector("#gateCard .gfoot") || {}).textContent,
      locked: SBMM.gate.locked(),
      token: localStorage.getItem("sbmm.gate.v1")
    };
  });
  console.log("gate: shown | z:", g0.z, "| covers viewport:", g0.covers,
              "| contour field:", g0.field, "| locked:", g0.locked);
  if (!g0.locked || !g0.covers || g0.z !== "9000" || !g0.field) {
    console.log("FAIL: the gate is not a full-viewport cover at z 9000", g0); process.exit(1); }
  if (g0.foot !== "Developed by Mo Sharif 2026. All rights reserved.") {
    console.log("FAIL: gate footer line is", JSON.stringify(g0.foot)); process.exit(1); }
  if (g0.token) { console.log("FAIL: an unlock token existed before anyone unlocked"); process.exit(1); }

  /* the app keeps booting underneath the gate — the gate covers, it does not pause */
  await gp.waitForSelector("#loading", { state: "hidden", timeout: 180000 });

  /* nothing reaches the app while it is locked */
  await gp.evaluate(() => {
    window.__mapClicks = 0;
    SBMM.map.on("click", () => window.__mapClicks++);
    /* the command bar opens itself on a browser's FIRST visit (cmdline.js), and this
       page is always a first visit — close it, so "did ` reopen it" means something */
    SBMM.cmd.open(false);
  });
  await gp.keyboard.press("3");          // would open 3D
  await gp.keyboard.press("`");          // would open the command bar
  await gp.mouse.click(700, 470);        // would reach the map
  await gp.waitForTimeout(600);
  const g1 = await gp.evaluate(() => ({
    open3d: SBMM.viewer3d.isOpen(),
    cmdOpen: document.body.classList.contains("cmdopen"),
    mapClicks: window.__mapClicks,
    gate: !!document.getElementById("gate")
  }));
  console.log("gate blocks: 3D open:", g1.open3d, "| command bar open:", g1.cmdOpen,
              "| map clicks:", g1.mapClicks, "| gate still up:", g1.gate);
  if (g1.open3d || g1.cmdOpen || g1.mapClicks !== 0 || !g1.gate) {
    console.log("FAIL: input reached the app while the gate was up", g1); process.exit(1); }

  /* a wrong password is refused, quietly */
  await gp.fill("#gatePw", "sulphurbank");
  await gp.click("#gateGo");
  await gp.waitForTimeout(700);
  const g2 = await gp.evaluate(() => ({
    gate: !!document.getElementById("gate"),
    msg: (document.getElementById("gateMsg") || {}).textContent,
    val: (document.getElementById("gatePw") || {}).value,
    shook: !!document.querySelector("#gateCard.shake"),
    token: localStorage.getItem("sbmm.gate.v1")
  }));
  console.log("wrong password:", JSON.stringify(g2.msg), "| field cleared:", g2.val === "",
              "| shaken:", g2.shook, "| gate still up:", g2.gate);
  if (!g2.gate || g2.val !== "" || !g2.shook || g2.token || !/that is not it/.test(g2.msg || "")) {
    console.log("FAIL: a wrong password was not refused properly", g2); process.exit(1); }

  /* the right one lets you in, and the gate leaves */
  await gp.fill("#gatePw", gatePassword());
  await gp.keyboard.press("Enter");
  await gp.waitForFunction(() => !document.getElementById("gate"), null, { timeout: 2000 })
    .catch(() => { console.log("FAIL: the gate was still in the DOM 2 s after the right password"); process.exit(1); });
  const g3 = await gp.evaluate(() => {
    let t = null; try { t = JSON.parse(localStorage.getItem("sbmm.gate.v1") || "null"); } catch (e) {}
    return { token: !!(t && t.h && t.t), locked: SBMM.gate.locked(),
             gate: !!document.getElementById("gate"), stage: !!document.getElementById("map") };
  });
  console.log("unlocked: gate removed:", !g3.gate, "| token stored:", g3.token, "| locked:", g3.locked);
  if (g3.gate || !g3.token || g3.locked || !g3.stage) {
    console.log("FAIL: unlock did not complete cleanly", g3); process.exit(1); }
  if (gerr.length) { console.log("FAIL: errors on the gate page:", gerr.slice(0, 5)); process.exit(1); }
  await gp.close();
}
});

let checks;   /* hoisted — v18 §3 */
await block("2. core readouts", async () => {
/* 2. core readouts */
checks = await page.evaluate(() => {
  const r = {};
  r.elev = SBMM.elev(6371600, 2128900);                       // inside the 1-ft window
  /* ~1100 ft north of the ABP: outside the old 1-ft window, inside the v3 mine-area
     window — must resolve on the 1-ft grid, not fall through to the 2-ft site grid.
     (6370500, 2130500) also lies inside the v3 window rectangle but the survey has no
     coverage in that western corner, so it is NaN in the master and not a valid probe.) */
  r.elevNW = SBMM.elev(6372000, 2130500);
  r.elevNoCover = SBMM.elev(6370500, 2130500);
  const [lo, la] = SBMM.toLL(6371600, 2128900);
  const rt = SBMM.fromLL(lo, la);
  r.llRoundtrip = [Math.abs(rt[0] - 6371600), Math.abs(rt[1] - 2128900)];
  r.layersRows = document.querySelectorAll("#layers .lyr").length;
  r.samples = SBMM.samples.length;
  r.piles = SBMM.pileIndex.length;
  return r;
});
console.log("elev @ABP:", checks.elev, "| affine roundtrip err ft:", checks.llRoundtrip.map(v => v.toFixed(4)));
console.log("layer rows:", checks.layersRows, "| samples:", checks.samples, "| topo pile parts:", checks.piles);
if (isNaN(checks.elev[0])) { console.log("FAIL: no elevation"); process.exit(1); }
console.log("elev @(6372000, 2130500) [new mine-area window]:", checks.elevNW,
            "| (6370500, 2130500) outside survey coverage:", checks.elevNoCover);
if (isNaN(checks.elevNW[0]) || checks.elevNW[1] !== "1-ft DEM") {
  console.log("FAIL: (6372000, 2130500) did not resolve on the 1-ft DEM"); process.exit(1);
}
});

let vol;   /* hoisted — v18 §3 */
await block("3. Pile 1 (Fig 2 traced) volume", async () => {
/* 3. Pile 1 (Fig 2 traced) volume — baseline re-measured on LandXML lidar-derived DEM
      (v3). The old CAD-contour-derived surface gave 260.5/−58.3 (asserted ~261/−57)
      and the memo's scipy analysis 262/−58; the lidar grid resolves pile micro-relief
      the contour interpolation smoothed away, so the baseline legitimately moved. */
vol = await S.get("pile1");
console.log(`Pile 1 volume: fill ${vol.fill_yd3} yd³, net ${vol.net_yd3} yd³ (lidar baseline: 278.4 / −48.1)`);
if (Math.abs(vol.fill_yd3 - 278.4) > 10 || Math.abs(vol.net_yd3 - (-48.1)) > 10) {
  console.log("FAIL: volume validation out of tolerance"); process.exit(1);
}
console.log("volume validation: OK");
});

let wk;   /* hoisted — v18 §3 */
await block("3b. that volume must have gone through the Blob-URL Web Worker", async () => {
/* 3b. that volume must have gone through the Blob-URL Web Worker, not the fallback */
wk = await page.evaluate(async () => {
  await SBMM.compute.probe();
  const st = SBMM.compute.stats;
  return {
    available: st.workerAvailable, workerJobs: st.workerJobs, syncJobs: st.syncJobs,
    failures: st.failures, workers: SBMM.compute.workerCount(),
    srcKernel: /volumeGrid/.test(SBMM.compute.source()) && /installWorker\(self\)/.test(SBMM.compute.source()),
    srcBytes: SBMM.compute.source().length
  };
}, { needs: ["pile1"] });
console.log("compute:", JSON.stringify(wk));
if (!wk.srcKernel) { console.log("FAIL: generated worker source does not contain the compute kernel"); process.exit(1); }
if (wk.available !== true) { console.log("FAIL: Blob-URL workers unavailable over file://"); process.exit(1); }
if (!(wk.workerJobs > 0)) { console.log("FAIL: volume did not run in a worker"); process.exit(1); }
if (wk.syncJobs > 0) { console.log("FAIL: a compute job fell back to the main thread"); process.exit(1); }
if (wk.failures > 0) { console.log("FAIL: compute job failures"); process.exit(1); }
console.log("worker path: OK");
});

let cancelled;   /* hoisted — v18 §3 */
await block("3c. superseded jobs are cancelled (this is what vertex-dragging", async () => {
/* 3c. superseded jobs are cancelled (this is what vertex-dragging relies on) and the
       surviving job still returns the validated number */
cancelled = await page.evaluate(async () => {
  const f = SBMM.store.features.find(x => x.type === "volume");
  const before = SBMM.compute.stats.cancelled;
  f.props.fill_yd3 = null;
  SBMM.tools.compVolume(f);          // job A
  SBMM.tools.compVolume(f);          // job B supersedes A
  SBMM.tools.compVolume(f);          // job C supersedes B
  for (let i = 0; i < 200 && f.props.fill_yd3 == null; i++) await new Promise(r => setTimeout(r, 100));
  return { cancelled: SBMM.compute.stats.cancelled - before, fill: f.props.fill_yd3, sync: SBMM.compute.stats.syncJobs };
}, { needs: ["pile1"] });
console.log("superseded jobs cancelled:", cancelled.cancelled, "| surviving result:", cancelled.fill, "yd\u00b3");
if (cancelled.cancelled < 2) { console.log("FAIL: superseded compute jobs were not cancelled"); process.exit(1); }
if (Math.abs(cancelled.fill - 278.4) > 10) { console.log("FAIL: recompute after cancellation changed the answer"); process.exit(1); }
if (cancelled.sync > 0) { console.log("FAIL: cancellation pushed a job onto the main thread"); process.exit(1); }
});

let meas;   /* hoisted — v18 §3 */
await block("4. distance + area + profile via rebuildFeature", async () => {
/* 4. distance + area + profile via rebuildFeature */
meas = await page.evaluate(async () => {
  SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400, 2128800], [6371700, 2128800]] });
  SBMM.tools.rebuildFeature({ type: "area", pts: [[6371400, 2128700], [6371500, 2128700], [6371500, 2128800], [6371400, 2128800]] });
  SBMM.tools.rebuildFeature({ type: "profile", pts: [[6371350, 2128600], [6371900, 2129100]] });
  await new Promise(r => setTimeout(r, 400));
  const fs = SBMM.store.features;
  return {
    line: fs.find(f => f.type === "line").props,
    area: fs.find(f => f.type === "area").props,
    prof: (fs.find(f => f.type === "profile").props || {}),
    profSvg: !!document.querySelector(".profileCard svg")
  };
});
console.log("distance 300ft check:", meas.line.length_ft, "| area 10000ft² check:", meas.area.area_ft2, "| profile pts:", meas.prof.profile && meas.prof.profile.length, "| chart:", meas.profSvg);
if (Math.abs(meas.line.length_ft - 300) > 0.1 || Math.abs(meas.area.area_ft2 - 10000) > 1) { console.log("FAIL measurement"); process.exit(1); }
});

let gj;   /* hoisted — v18 §3 */
await block("5. GeoJSON export content", async () => {
/* 5. GeoJSON export content */
gj = await page.evaluate(() => {
  const feats = SBMM.store.features;
  // exercise the collection builder through the menu handler path
  const before = feats.length;
  return { nFeatures: before };
});
console.log("features in store:", gj.nFeatures);
});

let rows, rowsF;   /* hoisted — v18 §3 */
await block("6. sample table", async () => {
/* 6. sample table */
await page.click("#tableBtn");
await page.waitForTimeout(300);
rows = await page.evaluate(() => document.querySelectorAll("#tblBody tr").length);
console.log("table rows:", rows);
if (rows < 100) { console.log("FAIL table"); process.exit(1); }
await page.fill("#tblHg", "204");
await page.waitForTimeout(250);
rowsF = await page.evaluate(() => document.querySelectorAll("#tblBody tr").length);
console.log("rows with Hg ≥ 204:", rowsF);
await page.click("#tblClose");
});

let slopeOk;   /* hoisted — v18 §3 */
await block("7. analysis layer", async () => {
/* 7. analysis layer: slope */
slopeOk = await page.evaluate(async () => {
  const cb = [...document.querySelectorAll("#anaLayers .lyr")].find(l => l.textContent.includes("Slope")).querySelector("input");
  cb.click();
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 100));
    let n = 0; SBMM.map.eachLayer(() => n++);
    if (!document.querySelector("#anaLayers .lyr.busy")) return true;
  }
  return false;
});
console.log("slope layer:", slopeOk ? "OK" : "TIMEOUT");
});

let ct;   /* hoisted — v18 §3 */
await block("8. custom contours (small interval only over ABP)", async () => {
/* 8. custom contours (small interval only over ABP) */
ct = await page.evaluate(async () => {
  await SBMM.analysis.makeCustomContours(5);
  return document.querySelectorAll("#anaLayers .lyr").length;
});
console.log("contour gen added layer row (total ana rows now):", ct);
});

let chmGate, chm;   /* hoisted — v18 §3 */
await block("8b. canopy height model (lidar CHM)", async () => {
/* 8b. canopy height model (lidar CHM). Everything that consumes canopy heights
   goes through SBMM.chmReady, so that contract is checked here too — it is what
   would let the decode move off the boot path without a hunt through five
   modules. */
chmGate = await page.evaluate(async () => ({ promise: !!SBMM.chmReady, resolved: !!(await SBMM.chmReady) }));
console.log("SBMM.chmReady gate:", JSON.stringify(chmGate));
if (!chmGate.promise || !chmGate.resolved) { console.log("FAIL: SBMM.chmReady is not a resolved gate on the model"); process.exit(1); }
chm = await page.evaluate(() => {
  const r = { has: !!SBMM.chm };
  if (!SBMM.chm) return r;
  const c = SBMM.chm, m = c.m;
  r.meta = { w: m.w, h: m.h, x0: m.x0, y0: m.y0, cell: m.cell };
  let bi = -1, bj = -1, bh = -Infinity, n = 0;
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
    const v = c.atGrid(i, j);
    if (isNaN(v)) continue;
    n++;
    if (v > bh) { bh = v; bi = i; bj = j; }
  }
  r.coverage = +(100 * n / (m.w * m.h)).toFixed(2);
  r.maxCell = { i: bi, j: bj, h: +bh.toFixed(2), x: m.x0 + bi * m.cell, y: m.y0 + bj * m.cell };
  r.canopyAtMax = SBMM.canopy(r.maxCell.x, r.maxCell.y);
  r.canopyOffGrid = SBMM.canopy(6368500, 2123500);   // outside the CHM window -> NaN
  r.layerRow = [...document.querySelectorAll("#anaLayers .lyr")].some(l => l.textContent.includes("Canopy height (lidar)"));
  /* status-bar readout path */
  const sd = document.getElementById("sDem");
  SBMM.map.fire("mousemove", { latlng: { lng: r.maxCell.x, lat: r.maxCell.y } });
  r.statusText = sd.textContent;
  /* spot tool card picks up the canopy row */
  SBMM.tools.dropSpot(r.maxCell.x, r.maxCell.y);
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  r.spotCanopy = f.props.canopy;
  return r;
});
if (!chm.has) { console.log("FAIL: SBMM.chm missing"); process.exit(1); }
console.log("CHM:", chm.meta.w + "x" + chm.meta.h, "@", chm.meta.cell + " ft, coverage", chm.coverage + "%");
console.log("tallest cell:", chm.maxCell.h, "ft at", chm.maxCell.x + " E,", chm.maxCell.y + " N",
            "| SBMM.canopy there:", chm.canopyAtMax.toFixed(2), "| off-grid:", chm.canopyOffGrid);
console.log("canopy layer row:", chm.layerRow, "| status bar:", JSON.stringify(chm.statusText), "| spot card canopy:", chm.spotCanopy);
if (!(chm.canopyAtMax > 2)) { console.log("FAIL: canopy at vegetated point not > 2 ft"); process.exit(1); }
if (!chm.layerRow) { console.log("FAIL: canopy layer row absent"); process.exit(1); }
if (!isNaN(chm.canopyOffGrid)) { console.log("FAIL: canopy outside window should be NaN"); process.exit(1); }
if (!/veg \d+ ft/.test(chm.statusText)) { console.log("FAIL: status bar missing veg readout"); process.exit(1); }
if (!(chm.spotCanopy > 2)) { console.log("FAIL: spot card missing canopy"); process.exit(1); }
});

let canLayer;   /* hoisted — v18 §3 */
await block("8c. the 2D canopy raster layer actually renders", async () => {
/* 8c. the 2D canopy raster layer actually renders */
canLayer = await page.evaluate(async () => {
  const row = [...document.querySelectorAll("#anaLayers .lyr")].find(l => l.textContent.includes("Canopy height (lidar)"));
  row.querySelector("input[type=checkbox]").click();
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!row.classList.contains("busy")) {
      let imgs = 0; SBMM.map.eachLayer(l => { if (l instanceof L.ImageOverlay) imgs++; });
      return { ok: true, imgs };
    }
  }
  return { ok: false };
});
console.log("canopy 2D layer:", canLayer.ok ? "OK (image overlays on map: " + canLayer.imgs + ")" : "TIMEOUT");
if (!canLayer.ok) { console.log("FAIL: canopy layer did not render"); process.exit(1); }
});

let om;   /* hoisted — v18 §3 */
await block("8d. 6-inch mine-area orthophoto payload + its basemap row", async () => {
/* 8d. 6-inch mine-area orthophoto payload + its basemap row */
om = await page.evaluate(() => ({
  jpg: typeof SBMM_DATA.ortho_mine_jpg === "string" && SBMM_DATA.ortho_mine_jpg.startsWith("data:image/jpeg"),
  geo: SBMM_DATA.ortho_mine,
  row: [...document.querySelectorAll("#baseLayers .lyr")].some(l => l.textContent.includes("Ortho — mine area (6 in)")),
  onMap: !!(SBMM.layers.orthoMine && SBMM.map.hasLayer(SBMM.layers.orthoMine))
}));
console.log("ortho_mine payload:", om.jpg, "| geo:", JSON.stringify(om.geo), "| layer row:", om.row, "| on map:", om.onMap);
if (!om.jpg) { console.log("FAIL: SBMM_DATA.ortho_mine_jpg missing"); process.exit(1); }
if (!om.geo || om.geo.x0 !== 6370069 || om.geo.y1 !== 2131120) { console.log("FAIL: ortho_mine geo wrong"); process.exit(1); }
if (!om.row) { console.log("FAIL: ortho_mine layer row absent"); process.exit(1); }
if (!om.onMap) { console.log("FAIL: ortho_mine not added to map"); process.exit(1); }
});

let tabs, ftab;   /* hoisted — v18 §3 */
await block("8e. workbench shell", async () => {
/* 8e. workbench shell — dock tabs exist and switch.
   v9 (§3): the left dock is Layers / My work / Sheets and the old "props" pane
   moved to the right dock as the Inspector, alongside Results. */
tabs = await page.evaluate(() => ({
  names: [...document.querySelectorAll("#leftTabs .dtab")].map(b => b.dataset.tab),
  panes: [...document.querySelectorAll("#leftBody .dockpane")].map(p => p.dataset.pane),
  rails: [...document.querySelectorAll("#leftRail .railbtn")].map(b => b.dataset.tab),
  rnames: [...document.querySelectorAll("#rightTabs .dtab")].map(b => b.dataset.rtab),
  rpanes: [...document.querySelectorAll("#rightBody .dockpane")].map(p => p.dataset.rpane),
  rrails: [...document.querySelectorAll("#rightRail .railbtn")].map(b => b.dataset.rtab),
  rightDock: !!document.getElementById("rightdock"),
  jobBar: !!document.getElementById("jobBar") && !!document.getElementById("jobCancel")
}));
console.log("dock tabs:", tabs.names.join(" | "), "| panes:", tabs.panes.join(" | "),
            "| rails:", tabs.rails.join(" | "), "| right dock:", tabs.rnames.join(" | "),
            "| job progress area:", tabs.jobBar);
if (tabs.names.join(",") !== "layers,features,sheets") { console.log("FAIL: dock tabs missing"); process.exit(1); }
if (tabs.rnames.join(",") !== "inspector,results") { console.log("FAIL: right dock tabs missing"); process.exit(1); }
if (tabs.rpanes.join(",") !== "inspector,results") { console.log("FAIL: right dock panes missing"); process.exit(1); }
if (tabs.rrails.join(",") !== "inspector,results") { console.log("FAIL: right dock rail buttons missing"); process.exit(1); }
if (!tabs.jobBar) { console.log("FAIL: status-bar job progress area missing"); process.exit(1); }

await page.click('#leftTabs .dtab[data-tab="features"]');
await page.waitForTimeout(250);
ftab = await page.evaluate(() => ({
  featuresShown: !document.getElementById("featuresPane").hidden,
  layersHidden: document.getElementById("layers").hidden,
  rows: document.querySelectorAll("#featureTree .ftrow").length,
  /* v9: EA's reference design surfaces (§5) are store features so the volume
     engine and the sections can use them unchanged, but they are read-only
     project data and live in the Layers tab, not in "My work". */
  storeN: SBMM.store.features.filter(f => !(f.props && f.props.ref)).length,
  refs: SBMM.store.features.filter(f => f.props && f.props.ref).length,
  first: (document.querySelector("#featureTree .ftrow .ftname") || {}).textContent
}));
console.log("features tab:", ftab.featuresShown, "| layers pane hidden:", ftab.layersHidden,
            "| rows:", ftab.rows, "/ store", ftab.storeN, "(+", ftab.refs, "EA reference surfaces)",
            "| first row:", JSON.stringify(ftab.first));
if (!ftab.featuresShown || !ftab.layersHidden) { console.log("FAIL: tab switch did not swap panes"); process.exit(1); }
if (ftab.rows !== ftab.storeN || ftab.rows < 1) { console.log("FAIL: feature manager rows do not match the store"); process.exit(1); }
});

let ren;   /* hoisted — v18 §3 */
await block("8f. rename through the row", async () => {
/* 8f. rename through the row */
await page.evaluate(() => {
  const n = document.querySelector("#featureTree .ftrow .ftname");
  n.focus();
  const r = document.createRange(); r.selectNodeContents(n);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
});
await page.keyboard.type("Pile 1 renamed via row");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
ren = await page.evaluate(() => {
  /* the first row of the tree, which is the first feature that is NOT one of
     EA's reference surfaces (those are read-only and are not listed here) */
  const f = SBMM.store.features.filter(q => !(q.props && q.props.ref))[0];
  return {
    storeName: f.name,
    cardName: (document.querySelector('#resBody .res[data-fid="' + f.id + '"] .rname') || {}).textContent
  };
});
console.log("rename via row -> store:", JSON.stringify(ren.storeName), "| results card:", JSON.stringify(ren.cardName));
if (ren.storeName !== "Pile 1 renamed via row") { console.log("FAIL: row rename did not reach the store"); process.exit(1); }
if (ren.cardName !== "Pile 1 renamed via row") { console.log("FAIL: row rename did not reach the results card"); process.exit(1); }
});

let mine0, hidden, shown;   /* hoisted — v18 §3 */
await block("8g. eye toggles map visibility", async () => {
/* 8g. eye toggles map visibility */
await page.click("#featureTree .ftrow:first-child .ftb.eye");
await page.waitForTimeout(150);
/* "the first feature the user made" — v9 puts EA's four read-only reference
   design surfaces (§5) in the store ahead of anything drawn, so features[0] is
   no longer that. */
await page.addInitScript(() => { window.__mine = () => SBMM.store.features.filter(q => !(q.props && q.props.ref)); });
await page.evaluate(() => { window.__mine = () => SBMM.store.features.filter(q => !(q.props && q.props.ref)); });
mine0 = () => { const f = window.__mine()[0];
                      return { visible: f.visible, onMap: SBMM.map.hasLayer(f.layer) }; };
hidden = await page.evaluate(mine0);
await page.click("#featureTree .ftrow:first-child .ftb.eye");
await page.waitForTimeout(150);
shown = await page.evaluate(mine0);
console.log("eye toggle — hidden:", JSON.stringify(hidden), "| shown again:", JSON.stringify(shown));
if (hidden.visible !== false || hidden.onMap !== false) { console.log("FAIL: eye did not hide the map layer"); process.exit(1); }
if (shown.visible !== true || shown.onMap !== true) { console.log("FAIL: eye did not restore the map layer"); process.exit(1); }
});

let grp;   /* hoisted — v18 §3 */
await block("8h. groups", async () => {
/* 8h. groups: create a folder, move a feature into it, check serialization round-trips */
grp = await page.evaluate(() => {
  const p = SBMM.store.addGroup("Piles/Traced");
  SBMM.store.setGroup(window.__mine()[0], p);
  const ser = SBMM.store.serialize();
  return {
    groups: SBMM.store.allGroups(),
    folderRows: document.querySelectorAll("#featureTree .ftgroup").length,
    serGroup: ser.features[0].group,
    serVersion: ser.version
  };
});
console.log("groups:", grp.groups.join(" / "), "| folder rows:", grp.folderRows,
            "| serialized group:", grp.serGroup, "| session version:", grp.serVersion);
if (grp.folderRows < 2) { console.log("FAIL: nested folders not rendered"); process.exit(1); }
if (grp.serGroup !== "Piles/Traced") { console.log("FAIL: group not serialized"); process.exit(1); }
});

let compat;   /* hoisted — v18 §3 */
await block("8i. an OLD", async () => {
/* 8i. an OLD (v2, no group/style/visible) session still restores */
compat = await page.evaluate(() => {
  const before = SBMM.store.features.length;
  SBMM.store.restore({
    app: "SBMM Site Explorer", version: 2,
    features: [{ name: "Legacy line", type: "line", pts: [[6371400, 2128950], [6371600, 2128950]], props: {} }]
  });
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  return { added: SBMM.store.features.length - before, name: f.name, group: f.group, visible: f.visible, len: f.props.length_ft };
});
console.log("v2 session restore:", JSON.stringify(compat));
if (compat.added !== 1 || compat.name !== "Legacy line" || compat.group !== "" || compat.visible !== true) {
  console.log("FAIL: v2 session did not restore cleanly"); process.exit(1);
}
if (Math.abs(compat.len - 200) > 0.1) { console.log("FAIL: restored legacy feature not measured"); process.exit(1); }
});

let props;   /* hoisted — v18 §3 */
await block("8j. selection populates Properties", async () => {
/* 8j. selection populates Properties */
await page.evaluate(() => SBMM.store.select(window.__mine()[0].id));
await page.click('#rightTabs .dtab[data-rtab="inspector"]');   /* v9 §3: Properties is the right dock's Inspector */
await page.waitForTimeout(250);
props = await page.evaluate(() => ({
  selected: SBMM.store.selected,
  name: (document.getElementById("pName") || {}).value,
  groupSel: (document.getElementById("pGroup") || {}).value,
  hasColor: !!document.getElementById("pColor"),
  hasWeight: !!document.getElementById("pWeight"),
  coordRows: document.querySelectorAll("#propsBody .coordlist tbody tr").length,
  sections: [...document.querySelectorAll("#propsBody .pgroup h4")].map(h => h.textContent.split("—")[0].trim()),
  cardSelected: !!document.querySelector("#resBody .res.sel"),
  rowSelected: !!document.querySelector("#featureTree .ftrow.sel")
}));
console.log("properties:", JSON.stringify({ name: props.name, group: props.groupSel, coords: props.coordRows,
            sections: props.sections, card: props.cardSelected, row: props.rowSelected }));
if (!props.name || !props.hasColor || !props.hasWeight) { console.log("FAIL: properties panel incomplete"); process.exit(1); }
if (!(props.coordRows > 2)) { console.log("FAIL: properties coordinate list empty"); process.exit(1); }
if (!props.cardSelected) { console.log("FAIL: selection did not highlight the results card"); process.exit(1); }
});

let selByMap, afterEsc;   /* hoisted — v18 §3 */
await block("8k. clicking the map layer selects; Esc deselects", async () => {
/* 8k. clicking the map layer selects; Esc deselects */
selByMap = await page.evaluate(() => {
  SBMM.store.select(null);
  const f = SBMM.store.features.find(q => q.type === "area");
  f.layer.fire("click", { latlng: { lat: f.pts[0][1], lng: f.pts[0][0] } });
  return { selected: SBMM.store.selected, isArea: SBMM.store.selected === f.id };
});
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
afterEsc = await page.evaluate(() => ({ selected: SBMM.store.selected, placeholder: !!document.querySelector("#propsBody .pnone") }));
console.log("map click selects:", selByMap.isArea, "| Esc deselects:", afterEsc.selected === null, "| props placeholder:", afterEsc.placeholder);
if (!selByMap.isArea) { console.log("FAIL: clicking a drawn feature did not select it"); process.exit(1); }
if (afterEsc.selected !== null) { console.log("FAIL: Esc did not clear the selection"); process.exit(1); }
});

/* ===================================================================== */
let keepIds, spPage, spClick, draftView;   /* hoisted — v18 §3 */
await block("8L. CAD drafting core", async () => {
/* 8L. CAD drafting core — object snap, ortho/polar, typed input,        */
/*     command line, modify tools, dimensions, DXF round-trip.           */
/*     Everything created here is removed again at the end so the 3D     */
/*     section still finds the Pile 1 volume it screenshots.             */
/* ===================================================================== */
keepIds = await page.evaluate(() => SBMM.store.features.map(f => f.id));
spPage = async function spPage(x, y) {
  return await page.evaluate(([x, y]) => {
    const c = SBMM.map.latLngToContainerPoint([y, x]);
    const r = document.getElementById("map").getBoundingClientRect();
    return { x: r.left + c.x, y: r.top + c.y };
  }, [x, y]);
}
spClick = async function spClick(x, y) {
  const p = await spPage(x, y);
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(70);
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(160);
}
draftView = async function draftView() {
  await page.evaluate(() => { SBMM.tools.setTool(null); SBMM.map.setView([2128850, 6371500], 1); });
  await page.waitForTimeout(700);
}
});

let osnapUi, afterF3, backOn, snapIdx;   /* hoisted — v18 §3 */
await block("8L-a. the OSNAP / POLAR / CMD chrome exists and toggles", async () => {
/* 8L-a. the OSNAP / POLAR / CMD chrome exists and toggles */
osnapUi = await page.evaluate(() => ({
  btn: !!document.getElementById("osnapBtn"),
  polar: !!document.getElementById("polarBtn"),
  cmd: !!document.getElementById("cmdBtn"),
  types: SBMM.snap.types.slice(),
  boxes: document.querySelectorAll("#osnapPop input[data-st]").length,
  on: SBMM.snap.enabled()
}));
await page.evaluate(() => SBMM.snap.setEnabled(true));
await page.keyboard.press("F3");
afterF3 = await page.evaluate(() => SBMM.snap.enabled());
await page.keyboard.press("F3");
backOn = await page.evaluate(() => SBMM.snap.enabled());
console.log("osnap chrome:", JSON.stringify(osnapUi), "| F3 ->", afterF3, "->", backOn);
if (!osnapUi.btn || !osnapUi.polar || !osnapUi.cmd) { console.log("FAIL: drafting status-bar chrome missing"); process.exit(1); }
if (osnapUi.boxes !== 5 || osnapUi.types.length !== 5) { console.log("FAIL: expected 5 per-type snap checkboxes"); process.exit(1); }
if (afterF3 !== false || backOn !== true) { console.log("FAIL: F3 does not toggle object snap"); process.exit(1); }
snapIdx = await page.evaluate(() => { SBMM.snap.buildStatic(); return SBMM.snap.stats(); });
console.log("static snap index:", snapIdx.segs, "segments +", snapIdx.pts, "points in", snapIdx.ms, "ms");
if (!(snapIdx.segs > 1000)) { console.log("FAIL: static snap index looks empty"); process.exit(1); }
});

let snapped;   /* hoisted — v18 §3 */
await block("8L-b. scripted snap", async () => {
/* 8L-b. scripted snap: hover near a drawn endpoint, click, land exactly on it */
await draftView();
await page.evaluate(() => {
  SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400, 2128800], [6371450, 2128840]], name: "ZZ snap target" });
  SBMM.snap.reindexDrawn(); SBMM.snap.setEnabled(true);
  SBMM.tools.setTool("distance");
});
await spClick(6371450 + 1.5, 2128840 - 1.2);            // ~1.9 ft off the endpoint
await spClick(6371560, 2128900);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
snapped = await page.evaluate(() => {
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  return f && f.type === "line" ? f.pts[0] : null;
});
console.log("osnap click landed at:", snapped, "| target vertex: [6371450, 2128840]");
if (!snapped || Math.abs(snapped[0] - 6371450) > 0.001 || Math.abs(snapped[1] - 2128840) > 0.001) {
  console.log("FAIL: object snap did not put the click on the endpoint"); process.exit(1);
}
});

let dynHint, typed;   /* hoisted — v18 §3 */
await block("8L-c. typed input", async () => {
/* 8L-c. typed input: @100<0 makes a 100 ft segment due east */
await page.evaluate(() => { SBMM.tools.setTool(null); SBMM.tools.setTool("distance"); });
await spClick(6371430, 2128810);
await page.keyboard.type("@100<0");
await page.waitForTimeout(150);
dynHint = await page.textContent("#dynHint");
await page.keyboard.press("Enter");
await page.waitForTimeout(120);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
typed = await page.evaluate(() => {
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  return f ? { pts: f.pts, len: f.props.length_ft } : null;
});
console.log("typed @100<0 ->", JSON.stringify(typed), "| hint:", JSON.stringify(dynHint));
if (!typed || Math.abs(typed.len - 100) > 0.02 || Math.abs(typed.pts[1][1] - typed.pts[0][1]) > 0.01) {
  console.log("FAIL: typed @100<0 did not produce a 100 ft due-east segment"); process.exit(1);
}
});

let orthoPts, polarPts;   /* hoisted — v18 §3 */
await block("8L-d. ortho (Shift) and polar tracking constrain the next vertex", async () => {
/* 8L-d. ortho (Shift) and polar tracking constrain the next vertex */
await page.evaluate(() => { SBMM.tools.setTool(null); SBMM.snap.setEnabled(false); SBMM.tools.setTool("distance"); });
await spClick(6371450, 2128800);
await page.keyboard.down("Shift");
await spClick(6371520, 2128830);
await page.keyboard.up("Shift");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
orthoPts = await page.evaluate(() => SBMM.store.features[SBMM.store.features.length - 1].pts);
await page.evaluate(() => { SBMM.draw.setPolar(true); SBMM.tools.setTool(null); SBMM.tools.setTool("distance"); });
await spClick(6371450, 2128780);
await spClick(6371520, 2128786);                          // 4.9° — polar rounds it to 0°
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
polarPts = await page.evaluate(() => { SBMM.draw.setPolar(false); SBMM.snap.setEnabled(true); return SBMM.store.features[SBMM.store.features.length - 1].pts; });
console.log("ortho ->", JSON.stringify(orthoPts), "| polar 15° ->", JSON.stringify(polarPts));
if (Math.abs(orthoPts[1][1] - orthoPts[0][1]) > 0.01) { console.log("FAIL: Shift did not lock ortho"); process.exit(1); }
if (Math.abs(polarPts[1][1] - polarPts[0][1]) > 0.01) { console.log("FAIL: polar tracking did not snap to 0°"); process.exit(1); }
});

let cmdMeta, volArmed, offRes, refused;   /* hoisted — v18 §3 */
await block("8L-e. command line", async () => {
/* 8L-e. command line: VOL arms the volume tool, OFFSET builds a real parallel copy */
cmdMeta = await page.evaluate(() => ({
  n: SBMM.cmd.commands().length,
  aliases: ["PL", "O", "MI", "RO", "CO", "M", "J", "X", "ZE", "DI"].every(a => !!SBMM.cmd.find(a))
}));
await page.evaluate(() => { SBMM.tools.setTool(null); SBMM.cmd.run("VOL"); });
volArmed = await page.evaluate(() => SBMM.tools.active());
console.log("command line:", cmdMeta.n, "commands | AutoCAD aliases resolve:", cmdMeta.aliases, "| VOL armed:", volArmed);
if (!cmdMeta.aliases || volArmed !== "volume") { console.log("FAIL: command line did not run VOL"); process.exit(1); }

await draftView();
await page.evaluate(() => {
  const f = SBMM.tools.rebuildFeature({ type: "area", pts: [[6371420, 2128790], [6371560, 2128790], [6371560, 2128890], [6371420, 2128890]], name: "ZZ box" });
  SBMM.store.select(f.id);
  SBMM.cmd.run("OFFSET 25");
});
await page.waitForTimeout(200);
await spClick(6371490, 2128840);                          // inside -> offset inward
offRes = await page.evaluate(() => {
  const f = SBMM.store.features.find(f => /offset/.test(f.name || ""));
  return f ? { name: f.name, area: f.props.area_ft2, n: f.pts.length } : null;
});
console.log("OFFSET 25 inward on a 140×100 box ->", JSON.stringify(offRes), "(expect 90×50 = 4500 ft²)");
if (!offRes || Math.abs(offRes.area - 4500) > 5) { console.log("FAIL: OFFSET produced the wrong geometry"); process.exit(1); }

/* a distance that would turn the outline inside out must be refused, not shipped */
await page.evaluate(() => {
  SBMM.store.features.filter(f => /^ZZ|offset/.test(f.name || "")).forEach(f => SBMM.store.remove(f));
  const f = SBMM.tools.rebuildFeature({ type: "area", pts: [[6371450, 2128840], [6371550, 2128840], [6371550, 2128860], [6371450, 2128860]], name: "ZZ thin" });
  SBMM.store.select(f.id); SBMM.cmd.run("OFFSET 40");
});
await page.waitForTimeout(200);
await spClick(6371500, 2128850);
refused = await page.evaluate(() => SBMM.store.features.filter(f => /offset/.test(f.name || "")).length);
console.log("OFFSET 40 into a 20 ft-wide strip -> features created:", refused, "(expect 0)");
if (refused !== 0) { console.log("FAIL: OFFSET shipped self-intersecting geometry"); process.exit(1); }
});

let dimRes;   /* hoisted — v18 §3 */
await block("8L-f. dimension between two points reports the right distance and", async () => {
/* 8L-f. dimension between two points reports the right distance and draws CAD furniture */
await page.evaluate(() => { SBMM.tools.setTool(null); SBMM.cmd.run("DIM"); });
await page.waitForTimeout(150);
await spClick(6371420, 2128800);
await spClick(6371520, 2128800);
dimRes = await page.evaluate(() => {
  const f = SBMM.store.features.find(f => f.type === "dim");
  return f ? { len: f.props.length_ft, bearing: f.props.bearing_deg, parts: f.layer.getLayers().length,
               label: (f.layer.getLayers().find(l => l.getIcon) || {}).options } : null;
});
console.log("DIM ->", dimRes && { len: dimRes.len, bearing: dimRes.bearing, layerParts: dimRes.parts });
if (!dimRes || Math.abs(dimRes.len - 100) > 0.01) { console.log("FAIL: dimension distance is wrong"); process.exit(1); }
if (!(dimRes.parts >= 5)) { console.log("FAIL: dimension did not draw its extension/arrow/text furniture"); process.exit(1); }
});

let sessionRT, v2ok;   /* hoisted — v18 §3 */
await block("8L-g. annotation text + session v7 round-trip (and an old v2 file", async () => {
/* 8L-g. annotation text + session v7 round-trip (and an old v2 file still loads) */
sessionRT = await page.evaluate(() => {
  SBMM.store.features.filter(f => f.type === "dim" || f.type === "text").forEach(f => SBMM.store.remove(f));
  SBMM.tools.mkDim([[6371400, 2128700], [6371500, 2128700]]);
  SBMM.tools.mkText([[6371450, 2128750], [6371480, 2128780]], "Stockpile A");
  const before = SBMM.store.features.length;
  const s = SBMM.store.serialize();
  const mine = s.features.filter(f => f.type === "dim" || f.type === "text");
  SBMM.store.features.filter(f => f.type === "dim" || f.type === "text").forEach(f => SBMM.store.remove(f));
  SBMM.store.restore({ app: "SBMM Site Explorer", version: s.version, features: mine });
  const back = SBMM.store.features.filter(f => f.type === "dim" || f.type === "text");
  return {
    version: s.version,
    dim: (back.find(f => f.type === "dim") || { props: {} }).props.length_ft,
    text: (back.find(f => f.type === "text") || { props: {} }).props.text,
    leader: (back.find(f => f.type === "text") || { pts: [] }).pts.length
  };
});
console.log("session round-trip:", JSON.stringify(sessionRT));
/* v7 adds the layer state (§4); every bump so far has been purely additive */
if (sessionRT.version !== 8 || Math.abs(sessionRT.dim - 100) > 0.01 || sessionRT.text !== "Stockpile A" || sessionRT.leader !== 2) {
  console.log("FAIL: dim/text did not survive the session round-trip"); process.exit(1);
}
v2ok = await page.evaluate(() => {
  const n0 = SBMM.store.features.length;
  SBMM.store.restore({ app: "SBMM Site Explorer", version: 2, features: [{ name: "ZZ v2 line", type: "line", pts: [[6371400, 2128700], [6371450, 2128700]], props: {} }] });
  return SBMM.store.features.length - n0;
});
console.log("v2 session still loads:", v2ok === 1);
if (v2ok !== 1) { console.log("FAIL: a v2 session no longer restores"); process.exit(1); }
});

let dxfRT, dxfGuard;   /* hoisted — v18 §3 */
await block("8L-h. DXF round-trip", async () => {
/* 8L-h. DXF round-trip: export, re-import, geometry back within 0.01 ft */
dxfRT = await page.evaluate(() => {
  const mine = SBMM.store.features.filter(f => /^ZZ|Stockpile|Dim |Text /.test(f.name || "") || f.type === "dim" || f.type === "text");
  mine.forEach(f => SBMM.store.remove(f));
  const made = [
    SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400.5, 2128700.25], [6371500.75, 2128760.5], [6371520, 2128800]], name: "ZZ l" }),
    SBMM.tools.rebuildFeature({ type: "area", pts: [[6371600, 2128700], [6371700, 2128700], [6371700, 2128800]], name: "ZZ a", group: "Drafting" }),
    SBMM.tools.rebuildFeature({ type: "spot", pts: [[6371650, 2128850]], name: "ZZ s" }),
    SBMM.tools.mkDim([[6371300, 2128600], [6371400, 2128600]]),
    SBMM.tools.mkText([[6371350, 2128650]], "Stockpile A")
  ];
  const before = made.map(f => ({ t: f.type, pts: f.pts.map(p => p.slice()) }));
  const txt = SBMM.dxf.buildDXF(made);
  made.forEach(f => SBMM.store.remove(f));
  const n0 = SBMM.store.features.length;
  const n = SBMM.dxf.importText(txt, "roundtrip.dxf");
  const after = SBMM.store.features.slice(n0).map(f => ({ t: f.type, pts: f.pts.map(p => p.slice()), text: f.props.text || null }));
  let worst = 0, missing = [];
  for (const b of before) {
    if (b.t === "dim" || b.t === "text") continue;            // exported as exploded lines + TEXT
    let best = null, bestErr = Infinity;
    for (const c of after) {
      if (c.pts.length !== b.pts.length) continue;
      const e = Math.max(...b.pts.map((p, i) => Math.max(Math.abs(p[0] - c.pts[i][0]), Math.abs(p[1] - c.pts[i][1]))));
      if (e < bestErr) { bestErr = e; best = c; }
    }
    if (!best || bestErr > 0.01) missing.push(b.t + " (err " + bestErr.toFixed(4) + ")");
    else worst = Math.max(worst, bestErr);
  }
  return { header: txt.slice(0, 40).replace(/\r?\n/g, "|"), acad: /AC1009/.test(txt), layers: (txt.match(/\nLAYER\r?\n/g) || []).length,
           bytes: txt.length, entities: n, worst, missing,
           textBack: after.filter(a => a.t === "text").map(a => a.text),
           aci: [SBMM.dxf.toACI("#FF0000"), SBMM.dxf.toACI("#4FB3CE"), SBMM.dxf.toACI("#FFFFFF")] };
});
console.log("DXF:", dxfRT.bytes, "bytes |", dxfRT.entities, "entities re-imported | AC1009:", dxfRT.acad,
            "| layer records:", dxfRT.layers, "| worst geometry error:", dxfRT.worst.toFixed(4), "ft");
console.log("DXF text round-trip:", JSON.stringify(dxfRT.textBack), "| ACI red/cyan/white:", JSON.stringify(dxfRT.aci));
if (!dxfRT.acad) { console.log("FAIL: DXF is not R12 (AC1009)"); process.exit(1); }
if (dxfRT.missing.length) { console.log("FAIL: DXF round-trip lost", dxfRT.missing.join(", ")); process.exit(1); }
if (dxfRT.worst > 0.01) { console.log("FAIL: DXF round-trip drifted more than 0.01 ft"); process.exit(1); }
if (!dxfRT.textBack.includes("Stockpile A")) { console.log("FAIL: DXF TEXT did not survive the round-trip"); process.exit(1); }

/* a DXF in the wrong coordinate system must be refused, never guessed at */
dxfGuard = await page.evaluate(() => {
  const mk = (x1, y1, x2, y2) => `0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n0\nENDSEC\n0\nEOF\n`;
  const out = {};
  for (const [k, s] of [["latlong", mk(-122.66, 39.005, -122.65, 39.006)], ["local", mk(0, 0, 250, 180)]]) {
    try { SBMM.dxf.importText(s, "x.dxf"); out[k] = "ACCEPTED"; } catch (e) { out[k] = "refused"; }
  }
  return out;
});
console.log("DXF CRS guard:", JSON.stringify(dxfGuard));
if (dxfGuard.latlong !== "refused" || dxfGuard.local !== "refused") {
  console.log("FAIL: DXF import accepted coordinates that are not State Plane feet"); process.exit(1);
}
console.log("drafting core: OK");
});

/* ==================================================================== */
let EBOX;   /* hoisted — v18 §3 */
await block("8M. earthworks", async () => {
/* 8M. earthworks — design surfaces, balance, range, sections, report   */
/* ==================================================================== */
EBOX = [[6371400, 2128700], [6371700, 2128700], [6371700, 2129000], [6371400, 2129000]];
});

let padRes;   /* hoisted — v18 §3 */
await block("8M-a. a graded pad on known terrain", async () => {
/* 8M-a. a graded pad on known terrain: raster, daylight line, elevation API */
padRes = await page.evaluate(async (BOX) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const st = SBMM.design.rimStats(BOX);
  const f = SBMM.design.mkSurface(BOX.map(p => p.slice()), "ZZ Pad",
    { kind: "pad", padZ: +st.mean.toFixed(2), ratio: 3, side: "out" });
  for (let i = 0; i < 400 && !f._surf; i++) await wait(100);
  const mid = [(BOX[0][0] + BOX[2][0]) / 2, (BOX[0][1] + BOX[2][1]) / 2];
  const dlPts = f._daylight.reduce((n, l) => n + l.length, 0);
  const biggest = f._daylight[0] || [];
  const bx = [Math.min(...biggest.map(p => p[0])), Math.max(...biggest.map(p => p[0]))];
  return {
    id: f.id, padZ: f.props.padZ, hasSurf: !!f._surf, cell: f._surf.cell,
    loops: f._daylight.length, dlPts, biggest: biggest.length, bx,
    elevMid: SBMM.design.elev(f.id, mid[0], mid[1]),
    elevOff: SBMM.design.elev(f.id, 6380000, 2140000),
    cut: f.props.cut_yd3, fill: f.props.fill_yd3,
    onMap: !!f._dlLayer, rowInLayers: !!document.querySelector("#surfList .surfrow"),
    inTree: !!document.querySelector('#featureTree .ftrow[data-fid="' + f.id + '"]')
  };
}, EBOX);
console.log("graded pad:", JSON.stringify({ ...padRes, bx: padRes.bx.map(v => Math.round(v)) }));
if (!padRes.hasSurf) { console.log("FAIL: design raster not built"); process.exit(1); }
if (Math.abs(padRes.elevMid - padRes.padZ) > 0.01) { console.log("FAIL: pad interior is not at the pad elevation"); process.exit(1); }
if (!isNaN(padRes.elevOff)) { console.log("FAIL: design elevation should be NaN off the raster"); process.exit(1); }
if (!padRes.loops || padRes.biggest < 50) { console.log("FAIL: no coherent daylight line"); process.exit(1); }
/* the daylight line must reach outside the 300-ft footprint — that is the point of it */
if (!(padRes.bx[0] < 6371400 - 5 && padRes.bx[1] > 6371700 + 5)) {
  console.log("FAIL: the daylight line does not extend past the pad footprint"); process.exit(1);
}
if (!padRes.onMap || !padRes.rowInLayers || !padRes.inTree) {
  console.log("FAIL: the surface is missing from the map, the Surfaces list or the Features tree"); process.exit(1);
}
});

let dvol;   /* hoisted — v18 §3 */
await block("8M-b. cut/fill of the terrain against that design surface", async () => {
/* 8M-b. cut/fill of the terrain against that design surface */
dvol = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const surf = SBMM.design.list().find(f => f.name === "ZZ Pad");
  const v = SBMM.design.volumeAgainst(surf);
  for (let i = 0; i < 400 && v.props.fill_yd3 == null; i++) await wait(100);
  return { base: v.props.base, cut: v.props.cut_design_yd3, fill: v.props.fill_design_yd3,
           net: v.props.net_yd3, label: v.card.querySelector(".rrow span").textContent };
});
console.log("volume vs design:", JSON.stringify(dvol));
if (!/design surface: ZZ Pad/.test(dvol.base || "")) { console.log("FAIL: volume base is not the design surface"); process.exit(1); }
if (!(dvol.cut > 0 && dvol.fill > 0)) { console.log("FAIL: cut/fill vs design is not plausible"); process.exit(1); }
if (Math.abs((dvol.cut - dvol.fill) - dvol.net) > 1) { console.log("FAIL: net does not equal cut - fill"); process.exit(1); }
if (!/Cut — terrain above design/.test(dvol.label)) { console.log("FAIL: design-base card still uses fitted-base wording"); process.exit(1); }
});

let balRes, balPct;   /* hoisted — v18 §3 */
await block("8M-c. auto-balance converges to cut == fill", async () => {
/* 8M-c. auto-balance converges to cut == fill */
balRes = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const f = SBMM.design.mkSurface(
    [[6371450, 2128750], [6371600, 2128750], [6371600, 2128900], [6371450, 2128900]],
    "ZZ Balance", { kind: "pad", ratio: 3, side: "out" });
  for (let i = 0; i < 400 && !f._surf; i++) await wait(100);
  const before = { z: f.props.padZ, cut: f.props.cut_yd3, fill: f.props.fill_yd3 };
  const after = await SBMM.design.balance(f);
  return { before, after, iters: f.props.balance_iters, box: !!f.card.querySelector(".sbalbox") };
});
balPct = balRes.after
  ? Math.abs(balRes.after.cut - balRes.after.fill) / Math.max(1e-9, (balRes.after.cut + balRes.after.fill) / 2) * 100
  : 999;
console.log("balance:", JSON.stringify(balRes), "| cut vs fill:", balPct.toFixed(2), "%");
if (!balRes.after || !balRes.box) { console.log("FAIL: balance produced no result"); process.exit(1); }
if (balPct > 2) { console.log("FAIL: balance did not reach cut = fill within 2%"); process.exit(1); }
});

let rngRes;   /* hoisted — v18 §3 */
await block("8M-d. uncertainty range", async () => {
/* 8M-d. uncertainty range: low <= best <= high across five base surfaces */
rngRes = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const f = SBMM.store.features.find(x => x.type === "volume" && /Pile 1/.test(x.name || ""));
  f.props.baseMode = "tin"; f.props.designId = null;
  SBMM.tools.compVolume(f);
  for (let i = 0; i < 200 && f.props.fill_yd3 == null; i++) await wait(100);
  const r = await SBMM.tools.volumeRange(f);
  return { r, box: !!f.card.querySelector(".vrangebox"),
           props: [f.props.range_low_yd3, f.props.range_best_yd3, f.props.range_high_yd3] };
});
console.log("uncertainty range: low", rngRes.r.lo.toFixed(1), "| best", rngRes.r.best.toFixed(1),
            "| high", rngRes.r.hi.toFixed(1), "| methods", rngRes.r.methods.length);
if (!(rngRes.r.lo <= rngRes.r.best && rngRes.r.best <= rngRes.r.hi)) {
  console.log("FAIL: low <= best <= high violated"); process.exit(1);
}
if (rngRes.r.methods.length !== 5 || !rngRes.box) { console.log("FAIL: range did not run all five bases"); process.exit(1); }
/* "best" must remain the memo's perimeter-TIN number, i.e. the validated baseline */
if (Math.abs(rngRes.r.best - 278.4) > 10) { console.log("FAIL: the range's best estimate drifted off the memo baseline"); process.exit(1); }
});

let secRes;   /* hoisted — v18 §3 */
await block("8M-e. sections", async () => {
/* 8M-e. sections: 7 stations over 300 ft at 50 ft, end area vs grid within 15% */
secRes = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const surf = SBMM.design.list().find(f => f.name === "ZZ Pad");
  const f = SBMM.sections.mkSections([[6371400, 2128850], [6371700, 2128850]], "ZZ Sections",
    { interval: 50, width: 260, designId: surf.id });
  for (let i = 0; i < 400 && !f._sec; i++) await wait(100);
  for (let i = 0; i < 400 && !f._cross; i++) await wait(100);
  SBMM.sections.openPanel(f);
  await wait(500);
  return {
    ns: f._sec.ns, no: f._sec.no, total: f._sec.total,
    labels: [SBMM.sections.staLabel(0), SBMM.sections.staLabel(50), SBMM.sections.staLabel(300)],
    ea: { cut: f._endArea.cut / 27, fill: f._endArea.fill / 27 },
    cross: f._cross,
    plots: document.querySelectorAll("#secBody .secplot canvas").length,
    open: document.getElementById("secDrawer").classList.contains("open"),
    csvRows: SBMM.sections.csvText(f).trim().split("\n").length - 1
  };
});
console.log("sections:", secRes.ns, "stations |", JSON.stringify(secRes.labels),
            "| end-area cut/fill", secRes.ea.cut.toFixed(0), "/", secRes.ea.fill.toFixed(0),
            "| grid", secRes.cross.grid.cut.toFixed(0), "/", secRes.cross.grid.fill.toFixed(0),
            "| difference", secRes.cross.diffPct.toFixed(1), "%");
if (secRes.ns !== 7) { console.log("FAIL: expected 7 sections at 50 ft over 300 ft, got " + secRes.ns); process.exit(1); }
if (secRes.labels[0] !== "0+00" || secRes.labels[1] !== "0+50" || secRes.labels[2] !== "3+00") {
  console.log("FAIL: CAD stationing labels are wrong"); process.exit(1);
}
if (secRes.plots !== 7 || !secRes.open) { console.log("FAIL: the sections panel did not plot every station"); process.exit(1); }
if (secRes.csvRows !== secRes.ns * secRes.no) { console.log("FAIL: section CSV row count is wrong"); process.exit(1); }
if (!(secRes.cross.diffPct < 15)) {
  console.log("FAIL: end-area and grid volumes differ by more than 15%"); process.exit(1);
}
});

let repRes;   /* hoisted — v18 §3 */
await block("8M-f. report sheet", async () => {
/* 8M-f. report sheet: opens, and carries the title block and the volume table */
repRes = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const v = SBMM.store.features.find(f => f.type === "volume" && /cut\/fill/.test(f.name || ""));
  await SBMM.report.open(v);
  for (let i = 0; i < 100 && !document.getElementById("rmFrame"); i++) await wait(100);
  await wait(1200);
  const doc = document.getElementById("rmFrame").contentDocument;
  const txt = doc.body.textContent;
  const qcells = [...doc.querySelectorAll("table.qt tbody tr")].map(tr => tr.children[0].textContent);
  return {
    modal: !!document.getElementById("reportModal"),
    h1: doc.querySelector("h1").textContent,
    author: /Mohammad Sharif/.test(txt),
    crs: /EPSG:6418/.test(txt),
    planning: /two significant figures/.test(txt),
    tables: doc.querySelectorAll("table.qt").length,
    figure: !!doc.querySelector("figure img"),
    figBytes: doc.querySelector("figure img").src.length,
    hasCut: qcells.some(c => /Cut — terrain above design/.test(c)),
    hasGrid: qcells.some(c => /Integration grid/.test(c)),
    designTable: /Design surface — ZZ Pad/.test(txt)
  };
});
console.log("report:", JSON.stringify({ ...repRes, figBytes: Math.round(repRes.figBytes / 1024) + " kB" }));
if (!repRes.modal || !repRes.figure || repRes.tables < 2) { console.log("FAIL: report sheet incomplete"); process.exit(1); }
if (!repRes.author || !repRes.crs || !repRes.planning) { console.log("FAIL: report is missing the title block or the planning-level caveat"); process.exit(1); }
if (!repRes.hasCut || !repRes.hasGrid || !repRes.designTable) { console.log("FAIL: report volume table is missing rows"); process.exit(1); }
if (repRes.figBytes < 20000) { console.log("FAIL: report figure looks empty"); process.exit(1); }
});

let v5;   /* hoisted — v18 §3 */
await block("8M-g. session v7 round-trip including a design surface and a", async () => {
/* 8M-g. session v7 round-trip including a design surface and a section set.
   EA's reference surfaces (§5) are deliberately NOT serialised and cannot be
   removed, so both sides of this comparison exclude them. */
v5 = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const m = document.getElementById("reportModal"); if (m) m.remove();
  const ser = SBMM.store.serialize();
  const own = f => (f.type === "surface" || f.type === "sections") && !(f.props && f.props.ref);
  const mine = ser.features.filter(f => f.type === "surface" || f.type === "sections");
  SBMM.store.features.filter(own).forEach(f => SBMM.store.remove(f));
  SBMM.store.restore({ app: "SBMM Site Explorer", version: ser.version, features: mine });
  const back = SBMM.store.features.filter(own);
  const refs = SBMM.store.features.filter(f => f.props && f.props.ref).length;
  const surf = back.find(f => f.type === "surface" && f.name === "ZZ Pad");
  const secs = back.find(f => f.type === "sections");
  for (let i = 0; i < 400 && surf && !surf._surf; i++) await wait(100);
  for (let i = 0; i < 400 && secs && !secs._sec; i++) await wait(100);
  return { version: ser.version, saved: mine.length, back: back.length, refs,
           padZ: surf && surf.props.padZ, ratio: surf && surf.props.ratio,
           side: surf && surf.props.side, kind: surf && surf.props.kind,
           regen: !!(surf && surf._surf), loops: surf && surf._daylight ? surf._daylight.length : 0 };
});
console.log("session round-trip (surfaces + sections):", JSON.stringify(v5));
if (v5.version !== 8 || v5.back !== v5.saved) { console.log("FAIL: session round-trip lost a surface or a section set"); process.exit(1); }
if (!v5.regen || !v5.loops) { console.log("FAIL: a restored design surface did not regenerate its raster"); process.exit(1); }
if (v5.ratio !== 3 || v5.side !== "out" || v5.kind !== "pad") { console.log("FAIL: surface parameters did not survive the session"); process.exit(1); }
});

let eExp;   /* hoisted — v18 §3 */
await block("8M-h. exports carry the derived geometry", async () => {
/* 8M-h. exports carry the derived geometry */
eExp = await page.evaluate(() => {
  const dxf = SBMM.dxf.buildDXF(SBMM.store.features.filter(f => f.visible !== false && f.pts && f.pts.length));
  const gj = SBMM.io.collection ? SBMM.io.collection("sp") : null;
  /* match the LAYER NAME (group code 8, then the value), not the "SECTION"
     keyword that delimits every DXF file's own sections */
  const onLayer = n => new RegExp("\r\n8\r\n" + n + "\r\n").test(dxf);
  return { grading: onLayer("GRADING"), section: onLayer("SECTION"),
           gjDaylight: gj ? gj.features.filter(f => f.properties.tool === "daylight").length : -1,
           gjSection: gj ? gj.features.filter(f => f.properties.tool === "section").length : -1 };
});
console.log("earthworks exports:", JSON.stringify(eExp));
if (!eExp.grading || !eExp.section) { console.log("FAIL: DXF is missing the GRADING / SECTION layers"); process.exit(1); }
if (eExp.gjDaylight < 1 || eExp.gjSection < 7) { console.log("FAIL: GeoJSON is missing the derived geometry"); process.exit(1); }
console.log("earthworks: OK");

/* leave a clean stage for the 3D checks that follow */
await page.evaluate(() => {
  SBMM.sections.closePanel();
  SBMM.store.features.filter(f => /^ZZ/.test(f.name || "") || /cut\/fill/.test(f.name || ""))
    .forEach(f => SBMM.store.remove(f));
});

/* put the app back the way section 9 expects to find it */
await page.evaluate(([keep]) => {
  const k = new Set(keep);
  SBMM.store.features.filter(f => !k.has(f.id)).forEach(f => SBMM.store.remove(f));
  SBMM.store.removeGroup("Drafting"); SBMM.store.removeGroup("DXF");
  SBMM.store.allGroups().filter(g => g.startsWith("DXF")).forEach(g => SBMM.store.removeGroup(g));
  SBMM.tools.setTool(null);
  SBMM.map.fitBounds(SBMM.demAbp.bounds());
}, [keepIds]);
await page.waitForTimeout(700);
});

/* ====================================================================== */
await block("8N. phase 4", async () => {
/* 8N. phase 4 — smart boundary tools, canopy v2, tree inventory          */
/* ====================================================================== */
});

let chm2;   /* hoisted — v18 §3 */
await block("8N-a. the CHM payload is the CLEANED v2 raster", async () => {
/* 8N-a. the CHM payload is the CLEANED v2 raster, not the raw max-return grid.
   The despeckle + pit-free close + masked blur lift the median canopy height well
   clear of the raw grid's 0.61 ft and pull the absurd 147-ft noise spike down to a
   plausible tree, so both are asserted rather than just "a CHM loaded". */
chm2 = await page.evaluate(() => {
  const z = SBMM.chm.z;
  let n = 0, mx = 0; const s = [];
  for (let i = 0; i < z.length; i++) {
    const v = z[i];
    if (isNaN(v)) continue;
    n++; if (v > mx) mx = v;
    if ((i % 401) === 0) s.push(v);
  }
  s.sort((a, b) => a - b);
  return { cells: n, max: +mx.toFixed(2), p50: +s[Math.floor(s.length / 2)].toFixed(2),
           w: SBMM.chm.m.w, h: SBMM.chm.m.h, cell: SBMM.chm.m.cell };
});
console.log(`CHM v2 payload: ${chm2.w}x${chm2.h} @${chm2.cell}ft | p50 ${chm2.p50} ft | max ${chm2.max} ft`);
if (chm2.w !== 2872 || chm2.h !== 3882) { console.log("FAIL: CHM grid changed shape"); process.exit(1); }
if (!(chm2.p50 > 1.2)) { console.log("FAIL: CHM looks like the RAW v1 raster (p50 <= 1.2 ft) — cleanup did not ship"); process.exit(1); }
if (!(chm2.max > 60 && chm2.max < 120)) { console.log("FAIL: CHM max " + chm2.max + " ft is not plausible after despeckle"); process.exit(1); }
console.log("CHM v2: OK");
});

let PILE3, PILE3_MEMO_AC, wand, wandErr, wandVol, selfPct;   /* hoisted — v18 §3 */
await block("8N-b. PILE WAND on Pile 3 part 1", async () => {
/* 8N-b. PILE WAND on Pile 3 part 1.
   Two independent assertions:
     • agreement with the MEMO — the traced footprint against the pile part area the
       ABP memo published for the same mound. The memo delineated on a DEM
       interpolated from 1-ft contours and this runs on the raw lidar grid, so exact
       agreement is not expected or wanted; 40% is the band phase 4 was specified to.
     • SELF-consistency — the wand's one-click volume against the same polygon put
       through the ordinary volume pipeline. These share a kernel, so this is really
       a check that the wand hands the rest of the app a well-formed footprint. */
PILE3 = [6371744, 2128677], PILE3_MEMO_AC = 0.184;
wand = await page.evaluate(async ([x, y]) => {
  const f = await SBMM.smartbound.runWand(x, y);
  const first = f.pts[0], last = f.pts[f.pts.length - 1];
  return { type: f.type, id: f.id, n: f.pts.length, area_ac: f.props.area_ac,
           group: f.group, name: f.name,
           /* a polygon feature holds an OPEN ring — closure means first != last and
              the layer is a Leaflet polygon, which closes it for you */
           distinctEnds: Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.01,
           isPolygon: !!(f.layer && f.layer.getLatLngs),
           pts: f.pts };
}, PILE3);
wandErr = 100 * (wand.area_ac - PILE3_MEMO_AC) / PILE3_MEMO_AC;
console.log(`WAND @Pile 3 p1: ${wand.area_ac} ac vs memo ${PILE3_MEMO_AC} ac = ${wandErr >= 0 ? "+" : ""}${wandErr.toFixed(0)}% | ${wand.n} vertices | closed polygon: ${wand.isPolygon && wand.distinctEnds} | folder "${wand.group}"`);
if (wand.type !== "area") { console.log("FAIL: WAND did not produce an area feature"); process.exit(1); }
if (!(wand.n >= 8 && wand.isPolygon && wand.distinctEnds)) { console.log("FAIL: WAND boundary is not a usable closed polygon"); process.exit(1); }
if (Math.abs(wandErr) > 40) { console.log(`FAIL: WAND footprint ${wandErr.toFixed(0)}% off the memo part area (limit 40%)`); process.exit(1); }

/* The wand's ONE-CLICK volume, taken through the real user path — the button the
   wand card offers — against the same footprint integrated on an INDEPENDENTLY
   built perimeter TIN (twice the perimeter sampling density, so a different
   triangulation of a different point set over the same ground). Re-running the
   identical job would agree to the bit and prove nothing; this actually tests that
   the wand's footprint is stable under the base-surface construction. */
wandVol = await page.evaluate(async (fid) => {
  const f = SBMM.store.byId(fid);
  const btn = f.card.querySelector(".sbvol");
  const before = new Set(SBMM.store.features.map(g => g.id));
  btn.click();                                        // the card's one-click volume
  const v = SBMM.store.features.find(g => !before.has(g.id));
  const wait = async g => { for (let i = 0; i < 300 && g.props.fill_yd3 == null; i++) await new Promise(r => setTimeout(r, 100)); return g.props; };
  const oneClick = await wait(v);
  /* same polygon, perimeter sampled a quarter as densely -> a different point set and a different TIN */
  const built = SBMM.tools.buildVolumeJob(v, { baseMode: "tin", perimMul: 4 });
  const dense = await SBMM.compute.run("volume", built.job,
    { transfer: built.transfer, label: "e2e wand cross-check" }).promise;
  return { oneClick: oneClick.fill_yd3, base: oneClick.baseMode, name: v.name,
           nPerim1: oneClick.perimeter_pts || null, nPerim2: built.nPerim,
           dense: +(dense.fill / 27).toFixed(1) };
}, wand.id);
selfPct = Math.abs(wandVol.oneClick - wandVol.dense) / Math.max(1e-9, wandVol.dense) * 100;
console.log(`WAND one-click volume: ${wandVol.oneClick} yd³ fill (base ${wandVol.base}) vs the same footprint on a 1/4-density perimeter TIN ${wandVol.dense} yd³ -> ${selfPct.toFixed(1)}% apart`);
if (!(wandVol.oneClick > 0)) { console.log("FAIL: WAND one-click volume produced nothing"); process.exit(1); }
if (selfPct > 25) { console.log("FAIL: WAND volume is not self-consistent across base constructions (>25%)"); process.exit(1); }
console.log("pile wand: OK");
});

let HERMAN, cb;   /* hoisted — v18 §3 */
await block("8N-c. CBOUND on the Herman impoundment", async () => {
/* 8N-c. CBOUND on the Herman impoundment — the flooded pit, a flat 1336.6-ft water
   plateau about 20.6 acres across. It runs off the east edge of the 1-ft mine-area
   grid, so this also exercises the fallback to the 2-ft site DEM. */
HERMAN = [6372743, 2127834];
cb = await page.evaluate(async ([x, y]) => {
  SBMM.smartbound.params.cbound.win = 1300;
  SBMM.smartbound.params.cbound.level = null;
  const f = await SBMM.smartbound.runCbound(x, y);
  const first = f.pts[0], last = f.pts[f.pts.length - 1];
  return { type: f.type, n: f.pts.length, area_ac: f.props.area_ac,
           closedRing: Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.01 && f.pts.length > 20,
           inside: pointInPoly(x, y, f.pts) };
}, HERMAN);
console.log(`CBOUND @Herman impoundment: ${cb.area_ac} ac | ${cb.n} vertices | closed ring: ${cb.closedRing} | encloses the click: ${cb.inside}`);
if (cb.type !== "area" || !cb.closedRing) { console.log("FAIL: CBOUND did not return a closed ring"); process.exit(1); }
if (!cb.inside) { console.log("FAIL: CBOUND ring does not enclose the clicked point"); process.exit(1); }
if (!(cb.area_ac > 15 && cb.area_ac < 26)) { console.log(`FAIL: CBOUND area ${cb.area_ac} ac is not the impoundment (~20.6 ac)`); process.exit(1); }
console.log("contour boundary: OK");
});

let toe;   /* hoisted — v18 §3 */
await block("8N-d. TOE", async () => {
/* 8N-d. TOE — a slope-magnitude contour near a click, delivered as a line feature */
toe = await page.evaluate(async () => {
  const f = await SBMM.smartbound.runToe(6371744, 2128677);
  return { type: f.type, n: f.pts.length, len: f.props.length_ft, group: f.group };
});
console.log(`TOE: ${f2s(toe.len)} ft line, ${toe.n} vertices, type "${toe.type}"`);
if (toe.type !== "line" || toe.n < 3) { console.log("FAIL: TOE did not return a usable line"); process.exit(1); }
console.log("toe/crest: OK");
});

let stands;   /* hoisted — v18 §3 */
await block("8N-e. STANDS over a scripted polygon in the wooded ground", async () => {
/* 8N-e. STANDS over a scripted polygon in the wooded ground north-west of the pit */
stands = await page.evaluate(async () => {
  const P = [[6371200, 2129000], [6371700, 2129000], [6371700, 2129450], [6371200, 2129450]];
  const made = await SBMM.smartbound.runStands(P, null);
  const tot = made.reduce((s, f) => s + (f.props.area_ft2 || 0), 0);
  return { n: made.length, group: made[0].group, totAc: +(tot / 43560).toFixed(2),
           maxH: made[0].props.canopy_max_ft,
           allAreas: made.every(f => f.props.area_ft2 >= 500) };
});
console.log(`STANDS: ${stands.n} stands, ${stands.totAc} ac canopy, folder "${stands.group}", tallest ${stands.maxH} ft`);
if (!(stands.n >= 1)) { console.log("FAIL: STANDS found nothing"); process.exit(1); }
if (!stands.allAreas) { console.log("FAIL: STANDS kept a stand under the minimum area"); process.exit(1); }
console.log("canopy stands: OK");
});

let trees;   /* hoisted — v18 §3 */
await block("8N-f. tree detection over a scripted sub-window", async () => {
/* 8N-f. tree detection over a scripted sub-window — count and heights plausible */
trees = await page.evaluate(async () => {
  const chm = SBMM.chm, m = chm.m;
  const g = SBMM.compute.gridSpec(chm, [6371000, 2128900, 6371800, 2129700], 2);
  const t0 = performance.now();
  const R = await SBMM.compute.run("trees", { grid: g, minH: 6, minCrown: 4 },
    { transfer: [g.z.buffer], label: "e2e tree detection" }).promise;
  const hs = Array.from(R.h).sort((a, b) => a - b);
  return { n: R.n, maxima: R.maxima, ms: Math.round(performance.now() - t0),
           hmin: +hs[0].toFixed(1), hmed: +hs[Math.floor(hs.length / 2)].toFixed(1),
           hmax: +hs[hs.length - 1].toFixed(1),
           over150: hs.filter(v => v > 150).length,
           crownMed: +Array.from(R.area).sort((a, b) => a - b)[Math.floor(R.n / 2)].toFixed(0) };
});
console.log(`TREES (800x800 ft sub-window): ${trees.n} trees in ${trees.ms} ms | height min ${trees.hmin} / median ${trees.hmed} / max ${trees.hmax} ft | median crown ${trees.crownMed} ft²`);
if (!(trees.n > 50)) { console.log(`FAIL: only ${trees.n} trees detected (expected > 50)`); process.exit(1); }
if (trees.over150 > 0) { console.log(`FAIL: ${trees.over150} trees taller than 150 ft`); process.exit(1); }
if (!(trees.hmin >= 6)) { console.log("FAIL: a detected tree is below the 6-ft minimum"); process.exit(1); }
console.log("tree detection: OK");
});

let sb;   /* hoisted — v18 §3 */
await block("8N-g. every phase-4 result is an ORDINARY feature", async () => {
/* 8N-g. every phase-4 result is an ORDINARY feature: it serialises, restores and
   stays editable. That is the whole design claim, so it gets asserted. */
sb = await page.evaluate(() => {
  const ser = SBMM.store.serialize();
  const kinds = ser.features.filter(f => /^(Pile boundary|Contour boundary|Toe line|Crest line|Stand) /.test(f.name));
  return { total: ser.features.length, phase4: kinds.length,
           types: [...new Set(kinds.map(f => f.type))].sort(),
           groups: [...new Set(kinds.map(f => f.group || ""))].sort(),
           allHavePts: kinds.every(f => Array.isArray(f.pts) && f.pts.length >= 3) };
});
console.log(`phase-4 features serialise: ${sb.phase4} of ${sb.total} | types ${JSON.stringify(sb.types)} | folders ${JSON.stringify(sb.groups)}`);
if (!(sb.phase4 >= 4 && sb.allHavePts)) { console.log("FAIL: phase-4 features did not serialise as ordinary features"); process.exit(1); }
console.log("smart boundaries: OK");

/* tidy up so the 3D section and the screenshots see the same scene as before */
await page.evaluate((k) => {
  const keep = new Set(k);
  SBMM.store.features.filter(f => !keep.has(f.id)).forEach(f => SBMM.store.remove(f));
  ["Smart boundaries", "Canopy stands"].forEach(g => SBMM.store.removeGroup(g));
  SBMM.tools.setTool(null);
  SBMM.map.fitBounds(SBMM.demAbp.bounds());
}, keepIds);
await page.waitForTimeout(600);
});

let v3d, v3dErr;   /* hoisted — v18 §3 */
await block("9. 3D viewer", async () => {
/* 9. 3D viewer */
await page.click("#view3dBtn");
v3d = await page.waitForFunction(() =>
  document.getElementById("v3dStatus").textContent === "" &&
  document.getElementById("view3d").style.display === "block", null, { timeout: 90000 })
  .then(() => true).catch(() => false);
await page.waitForTimeout(1200);
v3dErr = await page.evaluate(() => $("v3dStatus").textContent);
console.log("3D init:", v3d ? "OK" : "FAILED", v3dErr || "");
await page.screenshot({ path: "/tmp/shot_3d_" + label.replace(/\W+/g, "_") + ".png" });
});

let errBefore, ctr;   /* hoisted — v18 §3 */
await block("9a. 3D survey contours", async () => {
/* 9a. 3D survey contours. Since v9 there is no 3D checkbox for them (§3): the
   contour LAYER in the Layers tree drives both views, so this drives the one
   layer state and asserts the 3D scene follows. */
errBefore = errors.length;
ctr = await page.evaluate(async () => {
  if (!SBMM.layerState.rec("base", "contours_abp")) return { missing: true };
  /* the mine-area contours are ON by default, and since v9 that means they are
     already drawn in 3D — so measure from a known-off state */
  SBMM.layerState.set("base", "contours_site", { on: false });
  SBMM.layerState.set("base", "contours_abp", { on: false });
  await new Promise(r => setTimeout(r, 400));
  const before = SBMM.viewer3d.stats();
  SBMM.layerState.set("base", "contours_site", { on: true });
  SBMM.layerState.set("base", "contours_abp", { on: true });
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (document.getElementById("v3dStatus").textContent === "" && SBMM.viewer3d.stats().contourVerts > 1000) break;
  }
  const on = SBMM.viewer3d.stats();
  SBMM.layerState.set("base", "contours_site", { on: false });
  SBMM.layerState.set("base", "contours_abp", { on: false });
  await new Promise(r => setTimeout(r, 300));
  const off = SBMM.viewer3d.stats();
  /* put the mine-area contours back: that is the shipped default */
  SBMM.layerState.set("base", "contours_abp", { on: true });
  return { missing: false, before, on, off };
});
if (ctr.missing) { console.log("FAIL: the lidar contour layers are missing from SBMM.layerState"); process.exit(1); }
console.log("3D contours: scene objects", ctr.before.sceneObjects, "->", ctr.on.sceneObjects,
            "| draw calls:", ctr.on.contourDrawCalls, "| contour verts:", ctr.on.contourVerts,
            "| visible on/off:", ctr.on.contoursVisible + "/" + ctr.off.contoursVisible);
if (!(ctr.on.sceneObjects >= ctr.before.sceneObjects)) { console.log("FAIL: contours added no scene object"); process.exit(1); }
if (!(ctr.on.contourVerts > 1000)) { console.log("FAIL: contour geometry empty"); process.exit(1); }
if (!ctr.on.contoursVisible || ctr.off.contoursVisible) { console.log("FAIL: contour toggle does not control visibility"); process.exit(1); }
if (errors.length > errBefore) { console.log("FAIL: errors while toggling contours:", errors.slice(errBefore)); process.exit(1); }
console.log("terrain vertices @", ctr.on.detail + ":", ctr.on.terrainVerts);
});

let det;   /* hoisted — v18 §3 */
await block("9a-2. detail setting rebuilds the terrain at a different density", async () => {
/* 9a-2. detail setting rebuilds the terrain at a different density */
det = await page.evaluate(async () => {
  const sel = document.getElementById("v3dDetail");
  if (!sel) return { missing: true };
  const high = SBMM.viewer3d.stats();
  sel.value = "std"; await sel.onchange();
  const std = SBMM.viewer3d.stats();
  sel.value = "high"; await sel.onchange();
  return { missing: false, high, std, back: SBMM.viewer3d.stats() };
});
if (det.missing) { console.log("FAIL: v3dDetail select absent"); process.exit(1); }
console.log("detail vertex counts — high:", det.high.terrainVerts, "| standard:", det.std.terrainVerts,
            "| back to high:", det.back.terrainVerts);
if (!(det.std.terrainVerts < det.high.terrainVerts)) { console.log("FAIL: standard detail not coarser"); process.exit(1); }
if (det.back.terrainVerts !== det.high.terrainVerts) { console.log("FAIL: detail rebuild not reversible"); process.exit(1); }
});

let canVis;   /* hoisted — v18 §3 */
await block("9b. 3D canopy surface", async () => {
/* 9b. 3D canopy surface — driven by the Canopy LAYER, not a 3D checkbox (§3) */
canVis = await page.evaluate(async () => {
  if (!SBMM.layerState.rec("base", "canopy")) return { skipped: true };
  SBMM.layerState.set("base", "canopy", { on: true });
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (document.getElementById("v3dStatus").textContent === "" && SBMM.viewer3d.stats().canopyVisible) break;
  }
  return { skipped: false, visible: !!SBMM.viewer3d.stats().canopyVisible };
});
await page.waitForTimeout(2500);
console.log("3D canopy toggle:", canVis.skipped ? "SKIPPED (no CHM)" : "built, visible " + canVis.visible);
if (canVis.skipped) { console.log("FAIL: the canopy layer is missing from SBMM.layerState"); process.exit(1); }
if (!canVis.visible) { console.log("FAIL: the canopy layer did not build the 3D canopy surface"); process.exit(1); }
await page.screenshot({ path: "/tmp/shot_canopy_" + label.replace(/\W+/g, "_") + ".png" });
});
let nav3d, northOff;   /* hoisted — v18 §3 */
await block("9c. 3D navigation rig", async () => {
/* 9c. 3D navigation rig: modes, chrome, presets, preserved APIs, terrain clamp */
nav3d = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const r = {};
  r.compass = !!document.getElementById("v3dCompass");
  r.rose = !!document.getElementById("v3dRose");
  r.flyBtn = !!document.getElementById("v3dFly");
  r.presets = document.querySelectorAll("#v3dNav [data-view]").length;
  r.frame = !!document.getElementById("v3dFrame");
  r.viewSettings = !!document.getElementById("v3dFov") && !!document.getElementById("v3dSens");
  r.navHelp = !!document.getElementById("v3dNavHelp");
  r.apis = ["openAt", "flyTo", "toggle", "stats", "updateSketch", "toggleFly", "preset", "resize"]
    .filter(k => typeof SBMM.viewer3d[k] !== "function");
  r.modeStart = SBMM.viewer3d.stats().navMode;
  SBMM.viewer3d.toggleFly(true); r.modeFly = SBMM.viewer3d.stats().navMode;
  SBMM.viewer3d.toggleFly(false); r.modeBack = SBMM.viewer3d.stats().navMode;
  const rose0 = document.getElementById("v3dRose").getAttribute("transform");
  SBMM.viewer3d.preset("e"); await wait(900);
  r.roseMoved = document.getElementById("v3dRose").getAttribute("transform") !== rose0;
  SBMM.viewer3d.northUp(); await wait(2500);
  r.roseNorth = document.getElementById("v3dRose").getAttribute("transform");
  r.northDeg = parseFloat(/rotate\(([-\d.]+)/.exec(r.roseNorth)[1]);
  SBMM.viewer3d.flyTo(6371600, 2128900); await wait(900);
  r.cam = SBMM.viewer3d.cameraWorld();
  r.groundAtCam = SBMM.elev(r.cam.x, r.cam.y)[0];
  return r;
});
console.log("3D nav — compass:", nav3d.compass, "| fly button:", nav3d.flyBtn, "| presets:", nav3d.presets,
            "| frame:", nav3d.frame, "| view settings:", nav3d.viewSettings, "| nav help:", nav3d.navHelp);
console.log("3D nav — modes:", nav3d.modeStart, "->", nav3d.modeFly, "->", nav3d.modeBack,
            "| compass rotates:", nav3d.roseMoved, "| north-up:", nav3d.roseNorth);
if (nav3d.apis.length) { console.log("FAIL: missing 3D APIs:", nav3d.apis); process.exit(1); }
if (!nav3d.compass || !nav3d.rose || !nav3d.flyBtn) { console.log("FAIL: 3D nav chrome missing"); process.exit(1); }
if (nav3d.presets < 6) { console.log("FAIL: view presets missing"); process.exit(1); }
if (nav3d.modeFly !== "fly" || nav3d.modeBack !== "orbit") { console.log("FAIL: fly-mode toggle broken"); process.exit(1); }
if (!nav3d.roseMoved) { console.log("FAIL: compass does not rotate with the view"); process.exit(1); }
northOff = ((nav3d.northDeg % 360) + 540) % 360 - 180;   // -> [-180, 180)
console.log("north-up leaves the rose at", northOff.toFixed(1), "deg from vertical");
if (Math.abs(northOff) > 8) { console.log("FAIL: north-up did not point the compass north"); process.exit(1); }
});

let cv, cbb, zoomBefore, zoomAfter;   /* hoisted — v18 §3 */
await block("9d. scroll zoom pulls toward the cursor and never sinks below the", async () => {
/* 9d. scroll zoom pulls toward the cursor and never sinks below the terrain */
cv = await page.$("#v3dCanvas");
cbb = await cv.boundingBox();
await page.mouse.move(cbb.x + cbb.width * 0.5, cbb.y + cbb.height * 0.55);
zoomBefore = await page.evaluate(() => SBMM.viewer3d.cameraWorld());
for (let i = 0; i < 32; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(35); }
await page.waitForTimeout(1200);
zoomAfter = await page.evaluate(() => {
  const c = SBMM.viewer3d.cameraWorld();
  return { cam: c, ground: SBMM.elev(c.x, c.y)[0], clearance: c.z - SBMM.elev(c.x, c.y)[0] };
});
console.log("zoom-to-cursor — camera elev", zoomBefore.z.toFixed(0), "->", zoomAfter.cam.z.toFixed(0),
            "ft | ground under camera", isNaN(zoomAfter.ground) ? "n/a" : zoomAfter.ground.toFixed(0),
            "| clearance", isNaN(zoomAfter.clearance) ? "n/a" : zoomAfter.clearance.toFixed(1), "ft");
if (!(zoomAfter.cam.z < zoomBefore.z)) { console.log("FAIL: scroll did not zoom in"); process.exit(1); }
if (!isNaN(zoomAfter.clearance) && zoomAfter.clearance < 2.5) {
  console.log("FAIL: camera sank below the terrain clamp"); process.exit(1);
}
});
let idle;   /* hoisted — v18 §3 */
await block("9e. render-on-demand", async () => {
/* 9e. render-on-demand: an idle 3D view must stop issuing draw calls */
idle = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  /* wait for the camera damping to settle first — software GL runs at a couple of frames
     per second here, so "settled" has to be measured in frames, not wall clock */
  let prev = SBMM.viewer3d.stats().renderCount, settleTries = 0;
  for (; settleTries < 40; settleTries++) {
    await wait(1000);
    const now = SBMM.viewer3d.stats().renderCount;
    if (now - prev <= 1) break;
    prev = now;
  }
  const a = SBMM.viewer3d.stats();
  await wait(4000);                                       // now sit completely idle
  const b = SBMM.viewer3d.stats();
  return { renders: b.renderCount - a.renderCount, frames: b.frameCount - a.frameCount, settleTries };
});
console.log("idle 3D over 4 s — rAF ticks:", idle.frames, "| renders issued:", idle.renders,
            "| settle polls:", idle.settleTries);
if (idle.frames < 2) { console.log("FAIL: render loop is not running at all"); process.exit(1); }
if (idle.renders > 1) { console.log("FAIL: idle 3D view keeps re-rendering (render-on-demand broken)"); process.exit(1); }
console.log("3D navigation: OK");
SBMM_FRAME_CHECK: {
  const framed = await page.evaluate(async () => {
    SBMM.store.select(window.__mine()[0].id);
    SBMM.viewer3d.frame();
    await new Promise(r => setTimeout(r, 900));
    return SBMM.viewer3d.cameraWorld();
  });
  console.log("frame selection -> camera at", framed.x.toFixed(0), "E,", framed.y.toFixed(0), "N,", framed.z.toFixed(0), "ft");
}
});

let design, gis, xcheck, snapD, known;   /* hoisted — v18 §3 */
await block("9b. EA residential Final Design payload", async () => {
/* 9b. EA residential Final Design payload, layer rows, snap index and geometry */
design = await page.evaluate(() => {
  const r = {};
  const D = window.SBMM_DATA && SBMM_DATA.design_ea;
  r.loaded = !!(D && D.features);
  if (!r.loaded) return r;
  r.sheets = Object.keys(D.sheets || {}).length;
  r.features = D.features.length;
  r.polys = D.features.filter(f => f.geometry.type === "Polygon").length;
  r.nodes = D.features.filter(f => f.geometry.type === "Point").length;
  r.validated = D.features.filter(f => f.properties.confidence === "area-validated").length;
  /* no boundary may claim a meaning it could not establish */
  r.badNames = D.features.filter(f => f.properties.confidence === "unclassified"
    && !/boundary$/.test(f.properties.name)).length;
  /* every area-validated polygon must reproduce the area its sheet prints */
  r.worstAreaErr = 0;
  for (const f of D.features) {
    const p = f.properties;
    if (p.confidence !== "area-validated" || !p.printed_sf) continue;
    const ring = f.geometry.coordinates[0];
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++)
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a = Math.abs(a) / 2;
    r.worstAreaErr = Math.max(r.worstAreaErr, Math.abs(a - p.printed_sf) / p.printed_sf);
  }
  /* every sheet raster must have real State Plane bounds */
  r.rasterBadBounds = 0;
  for (const k of Object.keys(D.sheets || {})) {
    const rr = D.sheets[k].raster;
    if (!rr) continue;
    if (!(rr.x1 > rr.x0 && rr.y1 > rr.y0 && rr.x0 > 6.3e6 && rr.y0 > 2.0e6)) r.rasterBadBounds++;
  }
  /* registration residuals as recorded at build time */
  r.worstResid = Math.max(...Object.values(D.sheets).map(s => s.resid_max_ft));
  /* layer rows */
  const rows = [...document.querySelectorAll("#designLayers .lyr")];
  r.rows = rows.length;
  r.vecRow = rows.some(x => /PDF-extracted boundaries/.test(x.textContent));
  /* since v8 the PDF-derived boundaries default OFF — native geometry covers
     the same ground exactly and drawing both is drawing every limit twice */
  r.vecRowChecked = rows.filter(x => /PDF-extracted boundaries/.test(x.textContent))
    .every(x => x.querySelector("input[type=checkbox]").checked);
  r.superseded = D.features.filter(f => f.properties.superseded_by).length;
  /* a superseded boundary must record how far it sits from the native geometry:
     that number is the independent check on this sheet's registration */
  r.supWorstOff = Math.max(0, ...D.features
    .filter(f => f.properties.superseded_by)
    .map(f => f.properties.superseded_off_ft || 0));
  /* a sheet row is the one carrying a 3D drape toggle — the label is now just
     the sheet number and its subject, so match on structure, not on wording */
  r.sheetRowsUnchecked = rows.filter(x => x.querySelector("button.d3d")
    && !x.querySelector("input[type=checkbox]").checked).length;
  r.sliders = rows.filter(x => x.querySelector("input.opac")).length;
  /* the design linework must be in the osnap static index */
  r.snapPaths = SBMM.designEA.snapPaths().rings.length;
  /* provenance: which sheets came from the 90% Pre-Final set, and is that
     carried through to the features and the layer row */
  r.allHaveSet = Object.values(D.sheets).every(s => !!s.design_set);
  r.preFinal = Object.keys(D.sheets).filter(k => D.sheets[k].design_set === "90%").sort();
  r.preFinalFeatsFlagged = D.features
    .filter(f => r.preFinal.includes(f.properties.sheet))
    .every(f => f.properties.design_set === "90%");
  r.preFinalRowBadge = rows.some(x => /90%/.test(x.textContent)
    && r.preFinal.some(k => x.textContent.includes(k)));
  /* per-sheet 3D drape buttons */
  r.drapeBtns = rows.filter(x => x.querySelector("button.d3d")).length;
  return r;
});
console.log("design: sheets", design.sheets, "| features", design.features,
            "(", design.polys, "polygons,", design.nodes, "nodes,",
            design.validated, "area-validated )");
console.log("design: layer rows", design.rows, "| vector row", design.vecRow,
            "| sheet rows off by default", design.sheetRowsUnchecked,
            "| opacity sliders", design.sliders);
console.log("design: worst printed-area error",
            (100 * design.worstAreaErr).toFixed(2) + "%",
            "| worst build-time node residual", design.worstResid, "ft");
console.log("design: sheets from the 90% set", JSON.stringify(design.preFinal),
            "| every sheet declares its design set:", design.allHaveSet);
if (!design.loaded) { console.log("FAIL: design_ea payload absent"); process.exit(1); }
if (design.sheets < 12) { console.log("FAIL: expected 12 registered design sheets"); process.exit(1); }
if (design.polys < 55) { console.log("FAIL: too few design boundary polygons"); process.exit(1); }
if (design.validated < 11) { console.log("FAIL: expected 11 area-validated boundaries"); process.exit(1); }
/* C-110 exists only in the 90% Pre-Final set. It must be present AND must never
   be presentable as part of the Final package. */
if (!design.allHaveSet) { console.log("FAIL: a sheet does not declare which design set it came from"); process.exit(1); }
if (design.preFinal.join() !== "C-110") { console.log("FAIL: expected C-110 and only C-110 to be flagged as 90% set"); process.exit(1); }
if (!design.preFinalFeatsFlagged) { console.log("FAIL: a 90%-set feature is not flagged as such"); process.exit(1); }
if (!design.preFinalRowBadge) { console.log("FAIL: the 90%-set sheet row carries no badge"); process.exit(1); }
if (design.badNames) { console.log("FAIL: an unclassified boundary claims a meaning"); process.exit(1); }
if (design.worstAreaErr > 0.06) { console.log("FAIL: an area-validated boundary does not match its printed area"); process.exit(1); }
if (design.worstResid > 2.0) { console.log("FAIL: a kept sheet's registration residual exceeds 2 ft"); process.exit(1); }
if (design.rasterBadBounds) { console.log("FAIL: a design raster has bad State Plane bounds"); process.exit(1); }
if (!design.vecRow || design.rows < 12) { console.log("FAIL: design layer rows missing"); process.exit(1); }
console.log("design: PDF boundaries superseded by native geometry", design.superseded,
            "| worst PDF-vs-native offset", design.supWorstOff, "ft | row on by default", design.vecRowChecked);
if (design.vecRowChecked) { console.log("FAIL: PDF-extracted boundaries should default off now that native geometry ships"); process.exit(1); }
if (design.superseded < 12) { console.log("FAIL: expected the native geometry to supersede at least 12 PDF boundaries"); process.exit(1); }
/* This is the registration cross-check in aggregate: the PDF boundaries were
   placed from the sheets' printed node tables, the native polygons come from
   EA's geodatabase, and nothing links them. A frame, unit or scale mistake on
   either side shows up here first. */
if (design.supWorstOff > 6) { console.log("FAIL: a superseded boundary is " + design.supWorstOff + " ft from its native counterpart"); process.exit(1); }
if (design.sheetRowsUnchecked !== 12) { console.log("FAIL: sheet overlays should be off by default"); process.exit(1); }
if (design.drapeBtns !== 12) { console.log("FAIL: every sheet row needs a 3D drape toggle"); process.exit(1); }

/* ---------------------------------------------------------------- */
/* Native EA design geometry (v8): the geodatabase + CAD deliverables.
   This payload is the authority; design_ea.json is now the record of how the
   PDF sheets were registered. Three things are asserted: the payload is there
   and populated, the layers a user goes looking for exist with real counts,
   and the native geometry still agrees with the independent PDF registration
   on a known sheet — that last one is the cross-check that would catch a
   silent coordinate-frame or units mistake in a future rebuild.             */
gis = await page.evaluate(() => {
  const D = window.SBMM_DATA && SBMM_DATA.design_gis;
  if (!D) return { loaded: false };
  const byLayer = {};
  for (const f of D.features) {
    const k = f.properties.layer;
    byLayer[k] = (byLayer[k] || 0) + 1;
  }
  const exc = D.features.filter(f => f.properties.layer === "exc");
  const rows = [...document.querySelectorAll("#designLayers .lyr")].length;
  /* v16: a sub-header carries a caret and two count badges beside its name, so
     the name is its own text nodes */
  const subs = [...document.querySelectorAll("#designLayers .lsub:not(.cadnative-sub)")]
    .map(d => [...d.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim());
  /* every feature must say where it came from, and none of the excluded
     cultural-resource layers may have leaked in */
  const noProv = D.features.filter(f => !f.properties.provenance).length;
  const cultural = D.features.filter(f =>
    /T22|isolate|archae/i.test(JSON.stringify(f.properties))).length;
  const sp = SBMM.designGIS.snapPaths();
  const geo = SBMM.designGIS.geoFeatures(p => p);
  const dxf = SBMM.designGIS.dxfEntities();
  return {
    loaded: true, n: D.features.length, byLayer, rows, subs,
    layers: (D.layers || []).length, noProv, cultural,
    excNamed: exc.filter(f => /Lot|Residence|Lot$|North Lobe|Southwest|Northwest/.test(f.properties.name)).length,
    excTotal: exc.length,
    snapRings: sp.rings.length, geo: geo.length,
    dxfLayers: [...new Set(dxf.map(d => d.layer))].sort(),
    crs: D.crs || "", supersedes: !!D.supersedes, excluded: !!D.excluded
  };
});
if (!gis.loaded) { console.log("FAIL: design_gis payload absent"); process.exit(1); }
console.log("native design: " + gis.n + " features in " + gis.layers + " layers |",
            JSON.stringify(gis.byLayer));
console.log("native design: layer rows", gis.rows, "| sub-headings", JSON.stringify(gis.subs),
            "| snap rings", gis.snapRings, "| GeoJSON", gis.geo,
            "| DXF layers", gis.dxfLayers.length);
if (gis.n < 700) { console.log("FAIL: native design payload has too few features"); process.exit(1); }
if (gis.layers < 12) { console.log("FAIL: native design payload has too few layers"); process.exit(1); }
for (const k of ["exc", "repo", "staging", "haul", "lots", "daylight"]) {
  if (!gis.byLayer[k]) { console.log("FAIL: native design layer missing: " + k); process.exit(1); }
}
/* the limits of excavation are the point of the whole deliverable */
if (gis.byLayer.exc < 14) { console.log("FAIL: expected at least 14 limits of excavation"); process.exit(1); }
if (gis.byLayer.lots !== 32) { console.log("FAIL: expected 32 Elem Colony lots"); process.exit(1); }
if (gis.excNamed < gis.excTotal - 1) { console.log("FAIL: a limit of excavation is unnamed"); process.exit(1); }
if (gis.noProv) { console.log("FAIL: " + gis.noProv + " native features carry no provenance"); process.exit(1); }
/* Cultural resources are no longer excluded from the app — v9 §7 replaced the
   exclusion with controlled inclusion — but they are still excluded from THIS
   payload. design_gis.json is the design deliverable and goes out with every
   GeoJSON and DXF export unconditionally; the archaeological survey does not,
   and lives in its own gated payload (checked in section 9g below). A rebuild
   that quietly folds one into the other must still fail loudly. */
if (gis.cultural) { console.log("FAIL: cultural-resource data leaked into the design payload"); process.exit(1); }
if (!/2226/.test(gis.crs)) { console.log("FAIL: native payload does not record its delivered CRS"); process.exit(1); }
if (!gis.supersedes || !gis.excluded) { console.log("FAIL: native payload is missing its provenance notes"); process.exit(1); }
if (gis.rows < 12) { console.log("FAIL: native design layer rows missing"); process.exit(1); }
/* designgis contributes three ("Design areas" / "Boundaries" / "Existing
   conditions"); js/designea.js adds "Sheets (draped)" at the bottom (D2b). */
if (gis.subs.join(",") !== "Design areas,Boundaries,Existing conditions,Sheets (draped)") {
  console.log("FAIL: the residential section's sub-headings are", JSON.stringify(gis.subs)); process.exit(1);
}
/* snapPaths() deliberately follows layer visibility — snapping to a layer the
   user cannot see would be a surprise — so this counts the design layers that
   are on by default (exc + staging + repo + haul), not the whole payload. */
if (gis.snapRings < 25) { console.log("FAIL: native design not in the snap index"); process.exit(1); }
if (gis.geo < 700) { console.log("FAIL: native design not in the GeoJSON export"); process.exit(1); }
if (!gis.dxfLayers.includes("EA-EXC")) { console.log("FAIL: native design not in the DXF export"); process.exit(1); }

/* CAD-vs-PDF cross-check on C-106 (Lot 25). The PDF boundary was placed in v6
   from that sheet's own printed State Plane node table; the native polygon comes
   from EA's geodatabase. Nothing links the two, so their agreement is a real
   independent check — and it is the assertion that fails first if anyone ever
   reprojects, rescales or shifts one side of this. */
xcheck = await page.evaluate(() => {
  const A = SBMM_DATA.design_ea.features.find(f =>
    f.properties.sheet === "C-106" && f.geometry.type === "Polygon"
    && f.properties.superseded_by);
  if (!A) return null;
  const B = SBMM_DATA.design_gis.features.find(f =>
    f.properties.name === A.properties.superseded_by
    && f.geometry.type === "Polygon");
  if (!B) return null;
  /* Proper area-weighted polygon centroid. A vertex average is not the same
     thing and is biased by vertex density — the two rings here are digitised
     very differently, so that shortcut reports a spurious offset. */
  const cen = ring => {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const f = x0 * y1 - x1 * y0;
      a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
    }
    a *= 0.5;
    return Math.abs(a) < 1e-9 ? ring[0] : [cx / (6 * a), cy / (6 * a)];
  };
  const a = cen(A.geometry.coordinates[0]), b = cen(B.geometry.coordinates[0]);
  return { off: Math.hypot(a[0] - b[0], a[1] - b[1]),
           recorded: A.properties.superseded_off_ft,
           name: A.properties.superseded_by };
});
if (!xcheck) { console.log("FAIL: C-106 has no native counterpart to cross-check"); process.exit(1); }
console.log("CAD-vs-PDF cross-check C-106: PDF registration vs native geometry",
            xcheck.off.toFixed(2), "ft (recorded", xcheck.recorded + " ft) ->", xcheck.name);
if (!(xcheck.off < 6)) { console.log("FAIL: C-106 native geometry disagrees with the PDF registration by " + xcheck.off.toFixed(2) + " ft"); process.exit(1); }


/* the osnap static index must contain the design segments */
snapD = await page.evaluate(() => {
  SBMM.snap.buildStatic();
  const P = SBMM.designEA.snapPaths();
  const ring = P.rings.find(r => r.length > 4);
  const v = ring[1];
  /* query right on a design vertex: an endpoint snap must be found there */
  const hit = SBMM.snap.query(v[0], v[1], { tolPx: 40 });
  return { rings: P.rings.length, pts: P.pts.length,
           hit: !!hit, type: hit && hit.type,
           dx: hit ? Math.abs(hit.x - v[0]) : null,
           dy: hit ? Math.abs(hit.y - v[1]) : null };
});
console.log("design snap: rings", snapD.rings, "pts", snapD.pts,
            "| query on a design vertex ->", snapD.type,
            "err", snapD.dx == null ? "—" : (snapD.dx.toFixed(3) + "," + snapD.dy.toFixed(3)));
if (!snapD.hit) { console.log("FAIL: design linework is not in the snap index"); process.exit(1); }

/* one known extracted boundary must have a plausible area (C-108, sheet prints 34,167 ft2) */
known = await page.evaluate(() => {
  const D = SBMM_DATA.design_ea;
  const f = D.features.find(f => f.properties.sheet === "C-108"
    && f.properties.confidence === "area-validated");
  if (!f) return null;
  const ring = f.geometry.coordinates[0];
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return { area: Math.abs(a) / 2, printed: f.properties.printed_sf, name: f.properties.name };
});
console.log("design C-108 boundary:", f2s(known.area), "ft2 vs sheet-printed",
            f2s(known.printed), "ft2");
if (!known || Math.abs(known.area - 34167) > 34167 * 0.05) {
  console.log("FAIL: C-108 extracted boundary area implausible"); process.exit(1);
}
});

let errBeforeDrape, drape;   /* hoisted — v18 §3 */
await block("9c. design sheets draped on the 3D terrain", async () => {
/* 9c. design sheets draped on the 3D terrain.
   Enabling one sheet's "3D" toggle must build exactly one textured mesh over
   that sheet's footprint, the master switch must hide and show the group
   without tearing it down, and switching the sheet off must dispose it. The
   drape is a real mesh sampling the DEM, so its vertex count has to be
   non-trivial - a mesh that silently collapsed to a flat quad would still
   "exist" and would still be wrong. */
errBeforeDrape = errors.length;
drape = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rows = [...document.querySelectorAll("#designLayers .lyr")];
  const btn = rows.map(x => x.querySelector("button.d3d")).find(Boolean);
  if (!btn) return { missing: true };
  const name = btn.dataset.sheet;
  const before = SBMM.viewer3d.stats();
  btn.click();
  await wait(1500);
  const on = SBMM.viewer3d.stats();
  /* master switch hides the group but keeps the mesh — since v9 it is the
     "Sheets draped in 3D" LAYER, not a 3D toolbar checkbox (§3) */
  SBMM.layerState.set("design", "sheets3d", { on: false });
  await wait(300);
  const hidden = SBMM.viewer3d.stats();
  SBMM.layerState.set("design", "sheets3d", { on: true });
  await wait(300);
  const shown = SBMM.viewer3d.stats();
  /* the drape must sit over the sheet's own footprint */
  const r = SBMM_DATA.design_ea.sheets[name].raster;
  btn.click();                       // off again -> disposed
  await wait(700);
  const off = SBMM.viewer3d.stats();
  return {
    name, pressed: btn.getAttribute("aria-pressed"),
    beforeN: before.sheetDrapes.length, onN: on.sheetDrapes.length,
    onNames: on.sheetDrapes, verts: on.sheetDrapeVerts,
    visOn: shown.sheetDrapesVisible, visHidden: hidden.sheetDrapesVisible,
    offN: off.sheetDrapes.length, offVerts: off.sheetDrapeVerts,
    footprintFt: [Math.round(r.x1 - r.x0), Math.round(r.y1 - r.y0)]
  };
});
console.log("3D sheet drape:", drape.missing ? "NO TOGGLE FOUND"
  : `${drape.name} ${drape.beforeN}->${drape.onN} meshes, ${drape.verts} verts`
    + `, footprint ${drape.footprintFt[0]}x${drape.footprintFt[1]} ft`
    + `, master hide/show ${drape.visHidden}/${drape.visOn}`
    + `, disposed on uncheck: ${drape.offN === 0}`);
if (drape.missing) { console.log("FAIL: no per-sheet 3D drape toggle"); process.exit(1); }
if (drape.beforeN !== 0 || drape.onN !== 1) { console.log("FAIL: enabling a sheet did not add exactly one drape mesh"); process.exit(1); }
if (!(drape.verts > 200)) { console.log("FAIL: drape mesh has too few vertices to be following the terrain"); process.exit(1); }
if (drape.visHidden !== false || drape.visOn !== true) { console.log("FAIL: the master 'sheets in 3D' switch does not hide/show the group"); process.exit(1); }
if (drape.offN !== 0 || drape.offVerts !== 0) { console.log("FAIL: disabling a sheet did not dispose its drape mesh"); process.exit(1); }
if (errors.length !== errBeforeDrape) { console.log("FAIL: page errors during 3D sheet draping:", errors.slice(errBeforeDrape, errBeforeDrape + 4)); process.exit(1); }

await page.click("#v3dClose");
});

/* ==================================================================== */
let errBeforeSheets, shIdx, pickRows, shOpen, zoomed, shClosed, fromMap, mapOpened, bpt, prio, prioOK;   /* hoisted — v18 §3 */
await block("9d. the floating sheet viewer (phase B)", async () => {
/* 9d. the floating sheet viewer (phase B)                               */
/*                                                                       */
/* The whole point of the viewer is reading the parts of a drawing the    */
/* map overlay throws away, so "it opened" is not enough: the image has   */
/* to be the full sheet (36x24 aspect, thousands of pixels wide), every   */
/* sheet in the set has to be reachable including the four that are not   */
/* georeferenced, and Esc has to give the window back.                    */
/* ==================================================================== */
errBeforeSheets = errors.length;

shIdx = await page.evaluate(() => {
  const ix = SBMM.sheets.index();
  return {
    n: ix.length,
    registered: ix.filter(s => s.registered).length,
    unregistered: ix.filter(s => !s.registered).map(s => s.sheet),
    pre90: ix.filter(s => s.design_set === "90%").map(s => s.sheet),
    aspect: ix.map(s => +(s.w / s.h).toFixed(3)),
    minW: Math.min(...ix.map(s => s.w)),
    allHaveUrl: ix.every(s => typeof s.url === "string" && s.url.startsWith("data:image/jpeg"))
  };
});
console.log(`sheet index: ${shIdx.n} sheets (${shIdx.registered} georeferenced), `
  + `unplaced ${shIdx.unregistered.join(",")}, 90% set ${shIdx.pre90.join(",") || "none"}, `
  + `${shIdx.minW}px wide`);
if (shIdx.n !== 20) { console.log("FAIL: expected 20 full sheets, got", shIdx.n); process.exit(1); }
if (!shIdx.allHaveUrl) { console.log("FAIL: a sheet has no image payload"); process.exit(1); }
if (shIdx.minW < 3000) { console.log("FAIL: full sheets are too small to read"); process.exit(1); }
if (shIdx.aspect.some(a => Math.abs(a - 1.5) > 0.02)) {
  console.log("FAIL: a sheet is not a full 36x24 plot (aspect", shIdx.aspect.join(" "), ")"); process.exit(1);
}

/* the SHEETS command lists every sheet and opens the one clicked */
await page.evaluate(() => SBMM.cmd.run("SHEETS"));
await page.waitForSelector("#sheetPicker", { timeout: 20000 });
pickRows = await page.evaluate(() => document.querySelectorAll("#sheetPicker .sheetrow").length);
console.log("SHEETS picker rows:", pickRows);
if (pickRows !== 20) { console.log("FAIL: the SHEETS picker does not list the whole set"); process.exit(1); }

/* deliberately open an UNREGISTERED sheet — C-102's staging-area notes are the
   case that motivated carrying all 20 rather than only the placed ones */
await page.click('#sheetPicker .sheetrow[data-sheet="C-102"]');
await page.waitForSelector('.shwin[data-sheet="C-102"] img.shimg', { timeout: 20000 });
await page.waitForTimeout(900);
shOpen = await page.evaluate(() => {
  const w = document.querySelector('.shwin[data-sheet="C-102"]');
  const img = w.querySelector("img.shimg");
  const r = w.getBoundingClientRect();
  return {
    open: SBMM.sheets.openCount(),
    complete: img.complete, natW: img.naturalWidth, natH: img.naturalHeight,
    srcOk: img.src.startsWith("data:image/jpeg"),
    zoom: w.querySelector(".shzoom").textContent,
    title: w.querySelector(".shtitle").textContent,
    locateDisabled: w.querySelector(".shloc").disabled,
    w: Math.round(r.width), h: Math.round(r.height),
    onScreen: r.left > -5 && r.top > -5 && r.width > 300 && r.height > 250,
    transform: getComputedStyle(w).transform
  };
});
console.log(`sheet viewer: C-102 "${shOpen.title}" ${shOpen.natW}x${shOpen.natH} px, `
  + `window ${shOpen.w}x${shOpen.h}, fit ${shOpen.zoom}, locate disabled (unplaced): ${shOpen.locateDisabled}`);
if (!shOpen.complete || !shOpen.srcOk || shOpen.natW < 3000) { console.log("FAIL: sheet image did not load"); process.exit(1); }
if (!shOpen.onScreen) { console.log("FAIL: sheet window is off screen or too small"); process.exit(1); }
if (!shOpen.locateDisabled) { console.log("FAIL: an unregistered sheet must not offer 'locate on map'"); process.exit(1); }

/* wheel zoom toward the cursor, then fit — the transform must actually change */
zoomed = await page.evaluate(async () => {
  const w = document.querySelector('.shwin[data-sheet="C-102"]');
  const v = w.querySelector(".shview"), img = w.querySelector("img.shimg");
  const before = img.style.transform;
  const r = v.getBoundingClientRect();
  v.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, clientX: r.left + 100, clientY: r.top + 80, bubbles: true, cancelable: true }));
  await new Promise(r2 => setTimeout(r2, 120));
  const after = img.style.transform;
  const zAfter = w.querySelector(".shzoom").textContent;
  w.querySelector(".shfit").click();
  await new Promise(r2 => setTimeout(r2, 120));
  return { before, after, zAfter, zFit: w.querySelector(".shzoom").textContent, changed: before !== after };
});
console.log("sheet zoom: fit ->", zoomed.zAfter, "after wheel, back to", zoomed.zFit);
if (!zoomed.changed) { console.log("FAIL: wheel zoom did not move the sheet"); process.exit(1); }

/* Esc closes it, with the reverse animation */
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
shClosed = await page.evaluate(() => ({
  count: SBMM.sheets.openCount(),
  inDom: document.querySelectorAll(".shwin").length
}));
console.log("sheet viewer closes on Esc:", shClosed.count === 0 && shClosed.inDom === 0);
if (shClosed.count !== 0 || shClosed.inDom !== 0) { console.log("FAIL: Esc did not close the sheet viewer"); process.exit(1); }

/* a click on a visible sheet footprint on the 2D map opens that sheet */
fromMap = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.tools.setTool(null);
  const row = [...document.querySelectorAll("#designLayers .lyr")]
    .find(l => /C-106/.test(l.textContent));
  const cb = row.querySelector("input[type=checkbox]");
  if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
  await wait(500);
  /* fly to the sheet, then click inside it — a real hit on the footprint
     rectangle, not a synthetic call into the module. invalidateSize first: the
     3D view was open a moment ago and Leaflet's cached map size is what
     latLngToContainerPoint answers from, so without this the click lands
     somewhere else entirely. */
  SBMM.map.invalidateSize();
  await wait(300);
  const r = SBMM_DATA.design_ea.sheets["C-106"].raster;
  SBMM.map.fitBounds([[r.y0, r.x0], [r.y1, r.x1]], { animate: false });
  await wait(600);
  /* 8% in from the SW corner: inside the footprint but off the lot's own drawn
     boundary, because the boundary is a higher-priority click target there and
     is supposed to win (that ordering is checked right after this) */
  const p = SBMM.map.latLngToContainerPoint([r.y0 + (r.y1 - r.y0) * 0.08,
                                             r.x0 + (r.x1 - r.x0) * 0.08]);
  const box = document.getElementById("map").getBoundingClientRect();
  const scr = { x: Math.round(box.left + p.x), y: Math.round(box.top + p.y) };
  /* prove the screen point really maps back inside the footprint before clicking */
  const back = SBMM.map.containerPointToLatLng([scr.x - box.left, scr.y - box.top]);
  scr.inside = back.lng > r.x0 && back.lng < r.x1 && back.lat > r.y0 && back.lat < r.y1;
  return scr;
});
if (!fromMap.inside) { console.log("FAIL: could not aim at the C-106 footprint", fromMap); process.exit(1); }
await page.mouse.move(fromMap.x, fromMap.y);
await page.waitForTimeout(250);
await page.mouse.click(fromMap.x, fromMap.y);
await page.waitForTimeout(900);
mapOpened = await page.evaluate(() => {
  const w = document.querySelector(".shwin");
  return w ? { sheet: w.dataset.sheet, hasImg: !!w.querySelector("img.shimg"),
               locate: !w.querySelector(".shloc").disabled } : null;
});
console.log("click on the C-106 footprint on the map ->",
  mapOpened ? `${mapOpened.sheet} viewer (locate enabled: ${mapOpened.locate})` : "NOTHING OPENED");
if (!mapOpened || mapOpened.sheet !== "C-106" || !mapOpened.hasImg) {
  console.log("FAIL: clicking a sheet footprint did not open its viewer"); process.exit(1);
}
if (!mapOpened.locate) { console.log("FAIL: a registered sheet must offer 'locate on map'"); process.exit(1); }

/* ...and the footprint must be the LOWEST-priority target inside itself: a
   design boundary drawn on that lot still gets the click and opens its popup.
   (The footprint shares the vectors canvas and is sent to the back; without
   that it swallowed every click over the whole lot.) */
await page.evaluate(() => SBMM.sheets.closeAll());
await page.waitForTimeout(400);
bpt = await page.evaluate(() => {
  const f = SBMM_DATA.design_ea.features.find(f => f.properties.sheet === "C-106" && f.geometry.type === "Polygon");
  const ring = f.geometry.coordinates[0];
  let x = 0, y = 0;
  for (const q of ring) { x += q[0]; y += q[1]; }
  const p = SBMM.map.latLngToContainerPoint([y / ring.length, x / ring.length]);
  const box = document.getElementById("map").getBoundingClientRect();
  return { x: Math.round(box.left + p.x), y: Math.round(box.top + p.y), name: f.properties.name };
});
await page.mouse.click(bpt.x, bpt.y);
await page.waitForTimeout(700);
prio = await page.evaluate(() => ({
  popup: (document.querySelector(".leaflet-popup-content") || {}).textContent || "",
  sheetWins: document.querySelectorAll(".shwin").length
}));
console.log(`click priority inside the footprint: "${prio.popup.trim().split("\n")[0]}" won, sheet windows opened ${prio.sheetWins}`);
/* Two things at once, and both matter.
   The footprint must not win the click — it shares the vectors canvas and is
   sent to the back precisely so a design boundary drawn on that lot answers
   instead.
   And the boundary that DOES answer must name the sheet: the authority for a
   limit of excavation is the geodatabase polygon (planner ruling R1), and EA's
   raw CAD drafting linework for the same limits is off by default so it cannot
   sit on top of the authority and answer in its place. If that default ever
   flips back, this assertion is the thing that catches it. */
prioOK = prio.sheetWins === 0 && /C-106/.test(prio.popup);
if (!prioOK) {
  console.log("FAIL: the sheet footprint swallowed a click meant for a design boundary"); process.exit(1);
}
await page.evaluate(() => { SBMM.map.closePopup(); SBMM.sheets.open("C-106"); });
await page.waitForTimeout(700);

/* screenshot: the light table over the map */
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/shotB_sheet_" + label.replace(/\W+/g, "_") + ".png" });

await page.evaluate(() => SBMM.sheets.closeAll());
await page.waitForTimeout(400);
if (errors.length !== errBeforeSheets) {
  console.log("FAIL: page errors in the sheet viewer:", errors.slice(errBeforeSheets, errBeforeSheets + 4)); process.exit(1);
}
});

/* ==================================================================== */
let wasOpen3d, p3, shared, p3click, p3drag, p3edit;   /* hoisted — v18 §3 */
await block("9f-2. 3D picking and parity", async () => {
/* 9f-2. 3D picking and parity (v9 §8)                                   */
/*                                                                       */
/* The registry has to be populated from the scene the viewer actually    */
/* built, a pick has to produce the SAME popup html the 2D map produces   */
/* for the same object, empty terrain has to fall back to a coordinate    */
/* card, and an edit made in 3D has to be the same edit 2D would make.    */
/* ==================================================================== */
wasOpen3d = await page.evaluate(() => SBMM.viewer3d.isOpen());
if (!wasOpen3d) {
  await page.evaluate(async () => { await SBMM.viewer3d.openAt(6371600, 2128900); });
  await page.waitForTimeout(2500);
}

p3 = await page.evaluate(async () => {
  /* the sample-point cloud is off by default in the 3D toolbar, so switch it on
     before asking the registry what it holds — the point of the check is that
     everything DRAWN is registered, not that everything is drawn. A throwaway
     feature is drawn for the same reason, so the check does not depend on what
     an earlier section happened to leave in the store. */
  const cb = document.getElementById("v3dPts");
  if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
  const probe = SBMM.tools.rebuildFeature({ type: "line",
    pts: [[6371380, 2128660], [6371460, 2128660]], name: "ZZ pick probe" });
  await new Promise(r => setTimeout(r, 500));
  const st = SBMM.pick3d.stats();
  SBMM.store.remove(probe);
  return { attached: SBMM.pick3d.attached(), ...st };
});
console.log("pick3d registry:", JSON.stringify(p3));
if (!p3.attached) { console.log("FAIL: pick3d never attached to the 3D view"); process.exit(1); }
if (!p3.registered) { console.log("FAIL: nothing registered with pick3d"); process.exit(1); }
/* the four kinds of thing a user actually clicks on out there */
for (const k of ["feature", "sample", "dataset", "gis"]) {
  if (!p3.kinds[k]) { console.log("FAIL: pick3d has no " + k + " entries"); process.exit(1); }
}

/* the shared popup builders: one function, both views */
shared = await page.evaluate(() => {
  const out = { api: Object.keys(SBMM.popups) };
  const d = SBMM.datasets.list()[0];
  out.datasetSame = d ? SBMM.datasets.popup(d, d.points[0]) === SBMM.popups.forDataset(d, d.points[0]) : null;
  const g = SBMM_DATA.design_gis.features.find(f => f.geometry.type === "Polygon");
  out.gisHasAction = /data-popact/.test(SBMM.popups.forGis(g.properties, g.geometry));
  const f = window.__mine()[0];
  out.feature = f ? SBMM.popups.forFeature(f).slice(0, 30) : null;
  out.terrain = SBMM.popups.forTerrain(6371600, 2128900, 1387.6);
  return out;
});
console.log("shared popups:", JSON.stringify({ api: shared.api.length, datasetSame: shared.datasetSame,
  gisHasAction: shared.gisHasAction }));
for (const k of ["forFeature", "forDataset", "forCad", "forGis", "forSample", "forTerrain"])
  if (!shared.api.includes(k)) { console.log("FAIL: SBMM.popups." + k + " missing"); process.exit(1); }
if (shared.datasetSame === false) { console.log("FAIL: the 2D dataset popup is not the shared one"); process.exit(1); }
if (!shared.gisHasAction) { console.log("FAIL: the design popup lost its volume action"); process.exit(1); }
/* the terrain card is the §8 fallback: E/N/Z, lat/long, slope, aspect, copy, marker */
for (const want of ["Easting", "Northing", "Elevation", "Latitude", "Longitude", "Slope", "Aspect", "copy", "drop marker"])
  if (!shared.terrain.includes(want)) { console.log("FAIL: the coordinate card has no " + want); process.exit(1); }

/* A click opens an identify card, and Esc closes it. The terrain fallback is
   checked with the registry deliberately emptied, because "click a spot with
   nothing on it" is not something a fixed screen coordinate can promise on a
   site with 22k CAD entities — emptying the registry is the same condition,
   arranged rather than hoped for. syncScene() puts it all back. */
p3click = await page.evaluate(async () => {
  const cv = document.getElementById("v3dCanvas");
  const r = cv.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.62 };
  const fire = t => cv.dispatchEvent(new MouseEvent(t,
    Object.assign({ bubbles: true, button: 0 }, at)));
  const click = async () => {
    fire("mousedown"); fire("mouseup"); fire("click");
    await new Promise(r2 => setTimeout(r2, 250));
  };
  await click();
  const open1 = SBMM.pick3d.cardOpen();
  const html1 = SBMM.pick3d.cardHtml() || "";
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r2 => setTimeout(r2, 150));
  const closed = !SBMM.pick3d.cardOpen();

  const ids = SBMM.pick3d.registered().map(e => e.id);
  ids.forEach(id => SBMM.pick3d.unregister(id));
  await click();
  const html2 = SBMM.pick3d.cardHtml() || "";
  const open2 = SBMM.pick3d.cardOpen();
  SBMM.pick3d.closeCard();
  SBMM.pick3d.syncScene();
  await new Promise(r2 => setTimeout(r2, 200));
  return { open1, closed, first: html1.slice(0, 60).replace(/<[^>]*>/g, "").trim(),
           open2, coord: /Easting/.test(html2) && /Latitude/.test(html2),
           restored: SBMM.pick3d.registered().length };
});
console.log("3D identify card:", JSON.stringify(p3click));
if (!p3click.open1) { console.log("FAIL: a 3D click opened no identify card"); process.exit(1); }
if (!p3click.closed) { console.log("FAIL: Esc did not close the 3D identify card"); process.exit(1); }
if (!p3click.open2 || !p3click.coord) { console.log("FAIL: the terrain fallback is not a coordinate card"); process.exit(1); }
if (!p3click.restored) { console.log("FAIL: syncScene did not repopulate the registry"); process.exit(1); }

/* a drag must NOT be read as a click — the custom orbit rig shares the button */
p3drag = await page.evaluate(async () => {
  const cv = document.getElementById("v3dCanvas");
  const r = cv.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height * 0.6;
  const fire = (t, dx) => cv.dispatchEvent(new MouseEvent(t,
    { bubbles: true, button: 0, clientX: x + (dx || 0), clientY: y }));
  fire("mousedown", 0); fire("mousemove", 30); fire("mouseup", 30); fire("click", 30);
  await new Promise(r2 => setTimeout(r2, 220));
  return { open: SBMM.pick3d.cardOpen() };
});
console.log("3D drag is not a pick:", !p3drag.open);
if (p3drag.open) { console.log("FAIL: a 30 px drag opened an identify card"); process.exit(1); }

/* editing parity: a vertex moved through the 3D path is the same store edit */
p3edit = await page.evaluate(async () => {
  const f = SBMM.tools.rebuildFeature({ type: "line",
    pts: [[6371400, 2128700], [6371500, 2128700]], name: "ZZ 3D edit" });
  SBMM.store.select(f.id);
  await new Promise(r => setTimeout(r, 200));
  const handles = SBMM.pick3d.stats().handles;
  const before = f.props.length_ft;
  f.pts[1] = [6371600, 2128700];
  SBMM.tools.redraw(f); SBMM.tools.recompute(f, false); SBMM.store.emit();
  await new Promise(r => setTimeout(r, 200));
  const out = { handles, before, after: f.props.length_ft,
                onMap2D: !!(f.layer && SBMM.map.hasLayer(f.layer)),
                inTree: !!document.querySelector('.ftrow[data-fid="' + f.id + '"]') };
  SBMM.store.remove(f);
  return out;
});
console.log("3D editing parity:", JSON.stringify(p3edit));
if (!p3edit.handles) { console.log("FAIL: selecting a feature raised no 3D vertex handles"); process.exit(1); }
if (Math.abs(p3edit.before - 100) > 0.01 || Math.abs(p3edit.after - 200) > 0.01) {
  console.log("FAIL: a 3D vertex edit did not recompute through the store"); process.exit(1);
}
if (!p3edit.onMap2D) { console.log("FAIL: the 3D-edited feature is not live in 2D"); process.exit(1); }

if (!wasOpen3d) { await page.evaluate(() => SBMM.viewer3d.toggle()); await page.waitForTimeout(500); }
});

/* ==================================================================== */
let smAff, smMark;   /* hoisted — v18 §3 */
await block("9f-3. sheet measuring and marking", async () => {
/* 9f-3. sheet measuring and marking (v9 §9)                             */
/* ==================================================================== */
smAff = await page.evaluate(() => {
  const D = SBMM_DATA.sheets_full;
  const withAff = D.sheets.filter(s => s.affine);
  const A = SBMM.sheetMarks.affineOf("C-107");
  /* the affine has to round-trip: a pixel -> State Plane -> the same pixel */
  let worst = 0;
  for (const uv of [[100, 100], [2000, 1400], [4100, 2700]]) {
    const sp = SBMM.sheetMarks.toSP("C-107", uv[0], uv[1]);
    const px = SBMM.sheetMarks.toPx("C-107", sp[0], sp[1]);
    worst = Math.max(worst, Math.abs(px[0] - uv[0]), Math.abs(px[1] - uv[1]));
  }
  const corner = SBMM.sheetMarks.toSP("C-107", 2100, 1400);
  return {
    total: D.sheets.length, registered: withAff.length,
    ftPerPx: SBMM.sheetMarks.ftPerPx("C-107"),
    ncc: A ? A.ncc : null, gis: A ? A.gis_check : null,
    roundtripPx: worst,
    unregistered: D.sheets.filter(s => !s.affine).map(s => s.sheet),
    geoC107: SBMM.sheetMarks.georeferenced("C-107"),
    geoC101: SBMM.sheetMarks.georeferenced("C-101"),
    centreInSite: corner[0] > 6.3e6 && corner[0] < 6.4e6 && corner[1] > 2.09e6 && corner[1] < 2.17e6
  };
});
console.log("sheet affines:", JSON.stringify({ total: smAff.total, registered: smAff.registered,
  ftPerPx: smAff.ftPerPx, ncc: smAff.ncc, gis: smAff.gis, roundtripPx: +smAff.roundtripPx.toFixed(6),
  unregistered: smAff.unregistered.length }));
if (smAff.registered !== 12) { console.log("FAIL: expected 12 georeferenced sheets, got " + smAff.registered); process.exit(1); }
if (smAff.roundtripPx > 0.01) { console.log("FAIL: the sheet affine does not round-trip"); process.exit(1); }
if (!smAff.geoC107 || smAff.geoC101) { console.log("FAIL: the wrong sheets are marked georeferenced"); process.exit(1); }
if (!smAff.centreInSite) { console.log("FAIL: a sheet pixel does not map into the site window"); process.exit(1); }
if (!(smAff.ftPerPx > 0.05 && smAff.ftPerPx < 0.5)) { console.log("FAIL: implausible sheet scale"); process.exit(1); }
if (!smAff.gis || smAff.gis.inside_pct < 50) { console.log("FAIL: the sheet affine failed its independent check"); process.exit(1); }

smMark = await page.evaluate(async () => {
  const out = {};
  { SBMM.sheets.open("C-107"); }
  await new Promise(r => setTimeout(r, 500));
  const win = document.querySelector('.shwin[data-sheet="C-107"]');
  out.toolbar = [...win.querySelectorAll(".shtools [data-sht]")].map(b => b.dataset.sht);
  out.disabled = [...win.querySelectorAll(".shtools [data-sht]")].filter(b => b.disabled).length;
  out.canvas = !!win.querySelector("canvas.shmark");
  out.msg = win.querySelector(".shmsg").textContent;

  /* mark a distance on the drawing: 600 sheet px has to come out as 600 px
     worth of ground feet at that sheet's own scale */
  const n0 = SBMM.store.features.length;
  const A = SBMM.sheetMarks.affineOf("C-107");
  const p1 = SBMM.sheetMarks.toSP("C-107", 1800, 1200);
  const p2 = SBMM.sheetMarks.toSP("C-107", 2400, 1200);
  const f = SBMM.tools.rebuildFeature({ type: "line", pts: [p1, p2], name: "C-107 line 1" });
  f.props.provenance = { source: "sheet", sheet: "C-107", px: [[1800, 1200], [2400, 1200]] };
  SBMM.store.emit();
  await new Promise(r => setTimeout(r, 250));
  out.added = SBMM.store.features.length - n0;
  out.lengthFt = f.props.length_ft;
  out.expectFt = 600 * A.ft_per_px;
  out.onMap2D = !!(f.layer && SBMM.map.hasLayer(f.layer));
  out.fromSheet = SBMM.sheetMarks.fromSheet("C-107").length;
  out.popupNamesSheet = /C-107/.test(SBMM.popups.forFeature(f));
  /* provenance survives a session round-trip */
  const ser = SBMM.store.serialize();
  const spec = ser.features.find(x => x.name === "C-107 line 1");
  out.serialised = !!(spec && spec.props && spec.props.provenance && spec.props.provenance.sheet === "C-107");
  SBMM.store.remove(f);
  const back = SBMM.tools.rebuildFeature(spec);
  out.restored = !!(back && back.props.provenance && back.props.provenance.sheet === "C-107");
  out.restoredPx = back && back.props.provenance.px.length;
  SBMM.store.remove(back);

  /* an unregistered sheet refuses to georeference and says so */
  { SBMM.sheets.open("C-101"); }
  await new Promise(r => setTimeout(r, 500));
  const w2 = document.querySelector('.shwin[data-sheet="C-101"]');
  out.nogeoMsg = w2.querySelector(".shmsg").textContent;
  out.nogeoDisabled = [...w2.querySelectorAll(".shtools [data-sht]")]
    .filter(b => b.disabled).map(b => b.dataset.sht).sort();
  out.noteStillOn = !w2.querySelector('.shtools [data-sht="note"]').disabled;
  SBMM.sheets.closeAll();
  await new Promise(r => setTimeout(r, 400));
  return out;
});
console.log("sheet marking:", JSON.stringify(smMark));
if (smMark.toolbar.length < 9) { console.log("FAIL: the sheet toolbar is missing tools"); process.exit(1); }
for (const t of ["inspect", "distance", "area", "point", "line", "polygon", "note", "locate-map", "locate-3d"])
  if (!smMark.toolbar.includes(t)) { console.log("FAIL: sheet toolbar has no " + t); process.exit(1); }
if (!smMark.canvas) { console.log("FAIL: the sheet window has no mark overlay"); process.exit(1); }
if (smMark.disabled) { console.log("FAIL: tools disabled on a georeferenced sheet"); process.exit(1); }
if (smMark.added !== 1 || !smMark.onMap2D) { console.log("FAIL: a sheet mark did not become a live map feature"); process.exit(1); }
if (Math.abs(smMark.lengthFt - smMark.expectFt) > 0.5) {
  console.log("FAIL: a sheet measurement does not match the sheet scale: "
    + smMark.lengthFt + " vs " + smMark.expectFt); process.exit(1);
}
if (!smMark.popupNamesSheet) { console.log("FAIL: a sheet mark's popup does not say which sheet it came from"); process.exit(1); }
if (!smMark.serialised || !smMark.restored || smMark.restoredPx !== 2) {
  console.log("FAIL: sheet provenance did not survive the session round-trip"); process.exit(1);
}
if (!/not georeferenced/.test(smMark.nogeoMsg)) { console.log("FAIL: an unregistered sheet does not say so"); process.exit(1); }
if (!smMark.noteStillOn) { console.log("FAIL: notes should still be allowed on an unregistered sheet"); process.exit(1); }
for (const t of ["distance", "area", "inspect", "line", "point", "polygon"])
  if (!smMark.nogeoDisabled.includes(t)) { console.log("FAIL: " + t + " is offered on an unregistered sheet"); process.exit(1); }
});

let errBeforeC202, c202;   /* hoisted — v18 §3 */
await block("9f-2. C-202 (North Lobe Grading)", async () => {
/* 9f-2. C-202 (North Lobe Grading) — registered from EA's NATIVE polygon,   */
/* not from a printed node table (tools/register_sheet_native.py). The sheet  */
/* draws the North Lobe twice at 1 in = 20 ft, so it carries one affine per   */
/* plan viewport. Asserted: every vertex of the native polygon lands inside   */
/* BOTH viewports and round-trips exactly; a pixel on the title block is      */
/* refused; the map raster contains the polygon; the drape row exists, and    */
/* draping it in 3D builds a real mesh over the lobe.                         */
errBeforeC202 = errors.length;
c202 = await page.evaluate(async () => {
  const out = {};
  const rec = SBMM_DATA.sheets_full.sheets.find(s => s.sheet === "C-202");
  const vps = SBMM.sheetMarks.viewportsOf("C-202") || [];
  out.geo = SBMM.sheetMarks.georeferenced("C-202");
  out.viewports = vps.map(v => v.name);
  out.source = rec && rec.affine_source;
  const gis = SBMM_DATA.design_gis.features.find(f => f.properties.name === "Limit of excavation — North Lobe");
  const ring = gis.geometry.coordinates[0];
  let n = 0, inside = 0, worst = 0;
  for (const vp of vps) for (const q of ring) {
    const hit = SBMM.sheetMarks.toPxAll("C-202", q[0], q[1]).find(h => h.rect === vp.px);
    n++;
    if (!hit) continue;
    const [u, v] = hit.px;
    if (u >= vp.px[0] && u <= vp.px[2] && v >= vp.px[1] && v <= vp.px[3]) inside++;
    const back = SBMM.sheetMarks.toSP("C-202", u, v);
    if (back) worst = Math.max(worst, Math.hypot(back[0] - q[0], back[1] - q[1]));
  }
  out.n = n; out.inside = inside; out.worstFt = worst;
  /* the two plans must agree with each other about the ground: the same
     pixel offset from each plan's copy of vertex 0 maps to the same point */
  const a = SBMM.sheetMarks.toPxAll("C-202", ring[0][0], ring[0][1]);
  const p0 = SBMM.sheetMarks.toSP("C-202", a[0].px[0] + 100, a[0].px[1] + 50);
  const p1 = SBMM.sheetMarks.toSP("C-202", a[1].px[0] + 100, a[1].px[1] + 50);
  out.plansAgreeFt = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
  out.titleBlock = SBMM.sheetMarks.toSP("C-202", 4100, 2700);
  const r = SBMM_DATA.design_ea.sheets["C-202"].raster;
  out.polyInRaster = ring.every(q => q[0] >= r.x0 && q[0] <= r.x1 && q[1] >= r.y0 && q[1] <= r.y1);
  out.rasterFt = [Math.round(r.x1 - r.x0), Math.round(r.y1 - r.y0)];
  out.indexRegistered = !!SBMM.sheets.get("C-202").registered;
  out.nodes = SBMM_DATA.design_ea.features.filter(f => f.properties.sheet === "C-202" && f.properties.kind === "node").length;
  const row = [...document.querySelectorAll("#designLayers .lyr")].find(x => /C-202/.test(x.textContent));
  out.row = !!row;
  const btn = row && row.querySelector("button.d3d");
  out.drapeBtn = !!btn;
  if (btn) {
    const wait = ms => new Promise(res => setTimeout(res, ms));
    const was = SBMM.viewer3d.isOpen();
    if (!was) await SBMM.viewer3d.openAt(6371234, 2130164);
    await wait(500);
    btn.click();
    await wait(2500);
    const st = SBMM.viewer3d.stats();
    out.draped = st.sheetDrapes.includes("C-202");
    out.drapeVerts = st.sheetDrapeVerts;
    btn.click();
    await wait(700);
    out.drapedOff = SBMM.viewer3d.stats().sheetDrapes.includes("C-202");
    if (!was) SBMM.viewer3d.toggle();
    await wait(300);
  }
  return out;
});
console.log("C-202 native registration:", JSON.stringify(c202));
if (!c202.geo || c202.source !== "native") { console.log("FAIL: C-202 is not registered from native geometry"); process.exit(1); }
if (c202.viewports.length !== 2) { console.log("FAIL: C-202 should carry two plan viewports"); process.exit(1); }
if (c202.inside !== c202.n || c202.n < 20) { console.log("FAIL: the North Lobe polygon does not land inside both C-202 plans"); process.exit(1); }
if (c202.worstFt > 1e-6) { console.log("FAIL: the C-202 viewport affines do not round-trip"); process.exit(1); }
if (c202.plansAgreeFt > 0.01) { console.log("FAIL: the two C-202 plans disagree about the ground by " + c202.plansAgreeFt + " ft"); process.exit(1); }
if (c202.titleBlock !== null) { console.log("FAIL: a C-202 title-block pixel was georeferenced"); process.exit(1); }
if (!c202.polyInRaster || !c202.indexRegistered) { console.log("FAIL: the C-202 map raster does not cover the North Lobe"); process.exit(1); }
if (c202.nodes !== 2) { console.log("FAIL: C-202's two printed nodes are not carried as surveyed-node features"); process.exit(1); }
if (!c202.row || !c202.drapeBtn) { console.log("FAIL: no C-202 sheet row with a 3D drape toggle"); process.exit(1); }
if (!c202.draped || !(c202.drapeVerts > 200) || c202.drapedOff) { console.log("FAIL: C-202 did not drape in 3D"); process.exit(1); }
if (errors.length !== errBeforeC202) { console.log("FAIL: page errors around C-202:", errors.slice(errBeforeC202, errBeforeC202 + 4)); process.exit(1); }
});

/* ==================================================================== */
let cult0, cultAck, cult1, cultExport, cultOff;   /* hoisted — v18 §3 */
await block("9g. cultural resources", async () => {
/* 9g. cultural resources — CONFIDENTIAL (v9 §7)                         */
/*                                                                       */
/* The four assertions the spec names, in order: the group exists, it is  */
/* off, NO cultural geometry has reached the map before the              */
/* acknowledgement, and it is there after. Plus the two consequences that */
/* make the acknowledgement worth anything: the stamp appears while the   */
/* layers are visible, and an export carries the notice in its metadata.  */
/* ==================================================================== */
cult0 = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#culturalLayers .lyr")];
  const D = window.SBMM_DATA && SBMM_DATA.cultural;
  /* count Leaflet layers actually on the map that belong to the group */
  let onMap = 0;
  SBMM.map.eachLayer(l => { if (l._cult) onMap++; });
  return {
    payload: !!D,
    features: D ? D.features.length : 0,
    layers: D ? D.layers.length : 0,
    gdbLayers: D ? (D.gdb_layers || []).length : 0,
    crs: D ? D.crs : "",
    stamp: D ? D.confidential.stamp : "",
    groupExists: rows.length > 0,
    headExists: !!document.getElementById("culturalHead"),
    rowLabels: rows.map(r => r.querySelector(".lbl").textContent),
    anyChecked: rows.some(r => r.querySelector("input").checked),
    acknowledged: SBMM.cultural.isAcknowledged(),
    visible: SBMM.cultural.visible(),
    onMap,
    stampShown: !document.getElementById("cultStamp").hidden,
    geoExport: SBMM.cultural.geoFeatures(p => p).length,
    exportMeta: SBMM.cultural.exportMeta()
  };
});
console.log("cultural: payload", cult0.features, "features in", cult0.layers,
            "layers | GDB layers listed", cult0.gdbLayers,
            "| rows", JSON.stringify(cult0.rowLabels));
if (!cult0.payload) { console.log("FAIL: cultural payload absent"); process.exit(1); }
if (cult0.features < 60 || cult0.layers !== 2) { console.log("FAIL: cultural payload is not the two survey layers"); process.exit(1); }
if (cult0.gdbLayers < 9) { console.log("FAIL: the payload does not record every geodatabase layer it read"); process.exit(1); }
if (!/26910/.test(cult0.crs) || !/2226/.test(cult0.crs)) { console.log("FAIL: cultural payload does not record its reprojection"); process.exit(1); }
/* (1) the group exists */
if (!cult0.groupExists || !cult0.headExists) { console.log("FAIL: no cultural-resources layer group"); process.exit(1); }
if (cult0.rowLabels.length !== 2) { console.log("FAIL: expected two cultural layer rows"); process.exit(1); }
/* (2) it is off */
if (cult0.anyChecked || cult0.visible) { console.log("FAIL: a cultural layer is on by default"); process.exit(1); }
/* (3) nothing of it has reached the map, and nothing of it can be exported,
       before the acknowledgement */
if (cult0.onMap) { console.log("FAIL: cultural geometry is on the map before acknowledgement"); process.exit(1); }
if (cult0.acknowledged) { console.log("FAIL: the acknowledgement is pre-accepted"); process.exit(1); }
if (cult0.geoExport) { console.log("FAIL: cultural features exportable before acknowledgement"); process.exit(1); }
if (cult0.exportMeta) { console.log("FAIL: export metadata offered before acknowledgement"); process.exit(1); }
if (cult0.stampShown) { console.log("FAIL: the confidentiality stamp is up with nothing visible"); process.exit(1); }

/* the acknowledgement dialog itself: clicking the row raises it, and declining
   leaves the layer off */
cultAck = await page.evaluate(async () => {
  const row = document.querySelector("#culturalLayers .lyr");
  row.querySelector("input").click();
  await new Promise(r => setTimeout(r, 120));
  const box = document.getElementById("cultAck");
  const out = { dialog: !!box, title: box ? box.querySelector(".mhd").textContent.trim() : "" };
  if (box) box.querySelector("#cultAckNo").click();
  await new Promise(r => setTimeout(r, 120));
  out.afterDecline = {
    checked: document.querySelector("#culturalLayers .lyr input").checked,
    visible: SBMM.cultural.visible(),
    acknowledged: SBMM.cultural.isAcknowledged()
  };
  return out;
});
console.log("cultural acknowledgement:", JSON.stringify(cultAck));
if (!cultAck.dialog) { console.log("FAIL: switching a cultural layer on raised no acknowledgement"); process.exit(1); }
if (!/CONFIDENTIAL/i.test(cultAck.title)) { console.log("FAIL: the acknowledgement does not say what it is about"); process.exit(1); }
if (cultAck.afterDecline.checked || cultAck.afterDecline.visible || cultAck.afterDecline.acknowledged) {
  console.log("FAIL: declining the acknowledgement still switched the layer on"); process.exit(1);
}

/* (4) visible after accepting */
cult1 = await page.evaluate(async () => {
  const row = document.querySelector("#culturalLayers .lyr");
  row.querySelector("input").click();
  await new Promise(r => setTimeout(r, 120));
  const box = document.getElementById("cultAck");
  if (box) box.querySelector("#cultAckYes").click();
  await new Promise(r => setTimeout(r, 250));
  let onMap = 0;
  SBMM.map.eachLayer(l => { if (l._cult) onMap++; });
  const meta = SBMM.cultural.exportMeta();
  return {
    checked: document.querySelector("#culturalLayers .lyr input").checked,
    acknowledged: SBMM.cultural.isAcknowledged(),
    visible: SBMM.cultural.visible(),
    onMap,
    stampShown: !document.getElementById("cultStamp").hidden,
    stampText: document.getElementById("cultStamp").textContent,
    bodyClass: document.body.classList.contains("cultural-on"),
    geoExport: SBMM.cultural.geoFeatures(p => p).length,
    metaNotice: meta && meta.notice,
    popup: SBMM.cultural.popup(SBMM.cultural.features("iso")[0],
                               { name: "Archaeological isolates" })
  };
});
console.log("cultural after acknowledgement:", JSON.stringify({
  checked: cult1.checked, onMap: cult1.onMap, stamp: cult1.stampShown,
  geoExport: cult1.geoExport
}));
if (!cult1.checked || !cult1.acknowledged || !cult1.visible) { console.log("FAIL: accepting the acknowledgement did not switch the layer on"); process.exit(1); }
if (cult1.onMap < 19) { console.log("FAIL: cultural geometry did not reach the map after acknowledgement"); process.exit(1); }
if (!cult1.stampShown || !/NHPA/.test(cult1.stampText)) { console.log("FAIL: no confidentiality stamp with cultural layers visible"); process.exit(1); }
if (!cult1.bodyClass) { console.log("FAIL: the app does not know it is showing protected data"); process.exit(1); }
if (cult1.geoExport < 19) { console.log("FAIL: acknowledged cultural features are not exportable"); process.exit(1); }
if (!/NHPA/.test(cult1.metaNotice || "")) { console.log("FAIL: export metadata carries no notice"); process.exit(1); }
if (!/CONFIDENTIAL/.test(cult1.popup)) { console.log("FAIL: a cultural popup does not mark itself confidential"); process.exit(1); }

/* the GeoJSON export carries both the features and the notice */
cultExport = await page.evaluate(() => {
  const fc = SBMM.io.collection("sp");
  const cult = fc.features.filter(f => f.properties && f.properties.confidential);
  return { n: cult.length, meta: !!(fc.metadata && fc.metadata.confidential),
           notice: fc.metadata && fc.metadata.confidential && fc.metadata.confidential.notice,
           layer: cult.length ? cult[0].properties.layer : null };
});
console.log("cultural in the GeoJSON export:", JSON.stringify(cultExport));
if (!cultExport.n || !cultExport.meta || !/NHPA/.test(cultExport.notice || "")) {
  console.log("FAIL: the export does not carry the cultural notice"); process.exit(1);
}

await page.screenshot({ path: "/tmp/shot_cultural_" + label.replace(/\W+/g, "_") + ".png" });

/* put it back off — nothing after this section should be looking at protected
   geometry, and the stamp would otherwise be burned into every later shot */
cultOff = await page.evaluate(async () => {
  for (const row of document.querySelectorAll("#culturalLayers .lyr")) {
    const cb = row.querySelector("input");
    if (cb.checked) cb.click();
  }
  await new Promise(r => setTimeout(r, 150));
  return { visible: SBMM.cultural.visible(),
           stampShown: !document.getElementById("cultStamp").hidden };
});
if (cultOff.visible || cultOff.stampShown) { console.log("FAIL: cultural layers could not be switched back off"); process.exit(1); }
console.log("cultural: switched back off cleanly");
});

/* ==================================================================== */
let wm, wmCult;   /* hoisted — v18 §3 */
await block("9h. watermark", async () => {
/* 9h. watermark (v9 §10) — element AND burned-in pixels                 */
/* ==================================================================== */
wm = await page.evaluate(() => {
  const el = document.getElementById("watermark");
  const cs = el ? getComputedStyle(el) : null;
  /* burn into a blank white canvas and count the pixels that changed: the
     element alone proves nothing about an exported PNG */
  const cv = document.createElement("canvas");
  cv.width = 600; cv.height = 400;
  const g = cv.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, 600, 400);
  const before = g.getImageData(0, 0, 600, 400).data;
  let blank = 0;
  for (let i = 0; i < before.length; i += 4) if (before[i] !== 255) blank++;
  SBMM.watermark.burn(cv);
  const after = g.getImageData(0, 0, 600, 400).data;
  let changed = 0, inCorner = 0;
  for (let i = 0; i < after.length; i += 4) {
    if (after[i] === 255 && after[i + 1] === 255 && after[i + 2] === 255) continue;
    changed++;
    const px = (i / 4) % 600, py = Math.floor((i / 4) / 600);
    if (px > 300 && py > 300) inCorner++;
  }
  return {
    present: !!el,
    text: el ? el.textContent : "",
    fontPx: cs ? parseFloat(cs.fontSize) : null,
    opacity: cs ? parseFloat(cs.opacity) : null,
    pointerEvents: cs ? cs.pointerEvents : null,
    zIndex: cs ? parseInt(cs.zIndex, 10) : null,
    blank, changed, inCorner,
    apiText: SBMM.watermark.text()
  };
});
console.log("watermark:", JSON.stringify(wm));
if (!wm.present) { console.log("FAIL: no watermark element"); process.exit(1); }
if (wm.text !== "Mo Sharif - Jacobs 2026" || wm.apiText !== wm.text) { console.log("FAIL: watermark text is wrong"); process.exit(1); }
if (Math.abs(wm.fontPx - 11) > 0.6) { console.log("FAIL: watermark is not 11 px"); process.exit(1); }
if (Math.abs(wm.opacity - 0.55) > 0.02) { console.log("FAIL: watermark is not 55% opacity"); process.exit(1); }
if (wm.pointerEvents !== "none") { console.log("FAIL: the watermark takes pointer events"); process.exit(1); }
/* above the map (z 1) and the 3D view (z 5), below the sheet windows (4000) */
if (!(wm.zIndex > 5 && wm.zIndex < 4000)) { console.log("FAIL: watermark z-index is outside its band: " + wm.zIndex); process.exit(1); }
if (wm.blank !== 0) { console.log("FAIL: the burn-in probe canvas was not blank"); process.exit(1); }
if (wm.changed < 40) { console.log("FAIL: nothing was burned into the exported canvas"); process.exit(1); }
if (wm.inCorner < wm.changed * 0.9) { console.log("FAIL: the burned mark is not in the bottom-right corner"); process.exit(1); }

/* and the confidentiality stamp burns in too, on the same path */
wmCult = await page.evaluate(() => {
  const cv = document.createElement("canvas");
  cv.width = 600; cv.height = 400;
  const g = cv.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, 600, 400);
  SBMM.watermark.burn(cv, { confidential: SBMM.cultural.stampText() });
  const d = g.getImageData(0, 0, 600, 120).data;
  let red = 0;
  for (let i = 0; i < d.length; i += 4)
    if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 90) red++;
  return { red };
});
console.log("confidentiality stamp burned in: red pixels across the top =", wmCult.red);
if (wmCult.red < 100) { console.log("FAIL: the confidentiality stamp is not burned into exports"); process.exit(1); }
});

/* ==================================================================== */
let surf5, demStack, excCut, changedSF, excVol;   /* hoisted — v18 §3 */
await block("9i. design surfaces (docs/V9_SPEC.md §5)", async () => {
/* 9i. design surfaces (docs/V9_SPEC.md §5)                              */
/* ==================================================================== */
/* The four recovered surfaces must be present with the §5 manifest keys, must
   be wrapped as read-only surface FEATURES so the volume engine and the
   sections consume them unchanged, must decode lazily (NaN first, a real
   elevation after `surfaceReady`), and the excavation-bottom surface must
   reproduce the cut Agent A validated at build time. */
surf5 = await page.evaluate(async () => {
  const KEYS = ["id", "label", "kind", "method", "source_files", "confidence",
                "raster", "footprint", "stats", "volumes_vs_lidar_yd3", "notes"];
  const list = SBMM.CadNative.surfaces;
  const missing = {};
  for (const m of list) {
    const miss = KEYS.filter(k => m[k] === undefined);
    if (miss.length) missing[m.id] = miss;
  }
  /* lazy decode: the FIRST call must be NaN, and a value must follow */
  const m = SBMM.CadNative.surfaceMeta("res_excbottom").raster;
  const cx = m.x0 + m.w / 2, cy = m.y0 + m.h / 2;
  const first = SBMM.CadNative.surfaceElev("res_excbottom", cx, cy);
  await SBMM.CadNative.surfaceReady("res_excbottom");
  /* the raster carries EG only out to a 60 ft working buffer around the limits,
     so most of its bbox is nodata — scan a coarse grid for the first real cell */
  let after = NaN, hit = 0;
  for (let j = 0; j < m.h && isNaN(after); j += 13)
    for (let i = 0; i < m.w && isNaN(after); i += 13) {
      after = SBMM.CadNative.surfaceElev("res_excbottom", m.x0 + i, m.y0 + j);
      hit++;
      if (!isNaN(after)) { window.__probeXY = [m.x0 + i, m.y0 + j]; }
    }
  return {
    ids: list.map(s => s.id).sort(),
    kinds: list.map(s => s.kind),
    missing,
    notRecovered: SBMM.CadNative.notRecovered.map(n => n.id).sort(),
    remedies: SBMM.CadNative.notRecovered.every(n => /LandXML/i.test(n.remedy || "")),
    firstNaN: isNaN(first), after, probes: hit,
    /* the store features: read-only, locked, not serialised */
    feats: SBMM.store.features.filter(f => f.props && f.props.ref).map(f => ({
      id: f.props.refId, type: f.type, locked: !!f.locked, ref: !!f.props.ref
    })),
    serialised: SBMM.store.serialize().features.filter(f => f.props && f.props.ref).length,
    deletable: (() => {
      const f = SBMM.refSurf.featureOf("eg_ea");
      const n = SBMM.store.features.length;
      SBMM.store.remove(f);
      return SBMM.store.features.length !== n;
    })(),
    /* elev() routes a reference surface through the raster, not a node grid —
       probed at a cell known to carry data (most of the bbox is nodata) */
    designElev: SBMM.design.elev(SBMM.refSurf.featureOf("res_excbottom"),
                                 window.__probeXY[0], window.__probeXY[1]),
    inBaseList: SBMM.design.list().some(f => f.props && f.props.refId === "res_excbottom")
  };
});
console.log("design surfaces:", JSON.stringify(surf5.ids), "| kinds", JSON.stringify(surf5.kinds),
            "| not recovered", JSON.stringify(surf5.notRecovered));
console.log("surfaceElev lazy decode: first call NaN", surf5.firstNaN, "-> after surfaceReady", surf5.after);
if (surf5.ids.join(",") !== "borrow_eg,eg_ea,res_excbottom,res_finish") {
  console.log("FAIL: the four §5 design surfaces are not all present:", surf5.ids); process.exit(1);
}
if (Object.keys(surf5.missing).length) {
  console.log("FAIL: a surface is missing §5 manifest keys:", JSON.stringify(surf5.missing)); process.exit(1);
}
if (!surf5.firstNaN) { console.log("FAIL: surfaceElev should return NaN before the lazy decode lands"); process.exit(1); }
if (!(surf5.after > 1300 && surf5.after < 1400)) { console.log("FAIL: surfaceElev returned no elevation after surfaceReady:", surf5.after); process.exit(1); }
if (surf5.feats.length !== 4 || !surf5.feats.every(f => f.type === "surface" && f.ref && f.locked)) {
  console.log("FAIL: the design surfaces are not read-only surface features:", JSON.stringify(surf5.feats)); process.exit(1);
}
if (surf5.serialised !== 0) { console.log("FAIL: reference surfaces must not be serialised into a session"); process.exit(1); }
if (surf5.deletable) { console.log("FAIL: a reference surface must not be deletable"); process.exit(1); }
if (!surf5.inBaseList) { console.log("FAIL: a reference surface must be offered as a volume base"); process.exit(1); }
if (!(surf5.designElev > 1300 && surf5.designElev < 1400)) {
  console.log("FAIL: SBMM.design.elev did not route a reference surface through its raster:", surf5.designElev); process.exit(1);
}
if (surf5.notRecovered.join(",") !== "nlobe_fg,repo_fg" || !surf5.remedies) {
  console.log("FAIL: the two unrecovered surfaces must be listed with the LandXML remedy"); process.exit(1);
}

/* ---- the DEM stack, and the residential 1-ft window (planner ruling D1) ----
   Before v9's delivery round the residential lots south and west of the mine
   window fell back to the 2-ft site grid. dem_res is a 1-ft window over the
   residential design bbox + a 60 ft buffer; SBMM.dems is the one ordered list
   everything consults, dem_abp first so the mine window's numbers are untouched. */
demStack = await page.evaluate(() => {
  /* Two probes. SOUTH is inside EA's "Southern Residence" limit of excavation,
     ~750 ft south of the mine window and the only part of the residential
     design that was NOT already covered by dem_abp — note that Lot 25 and the
     other named lots always were, so the lots whose numbers this changes are
     the southern ones and the working buffer, not Lot 25. LOT25 is the control:
     it is inside dem_abp, dem_abp wins the tie, and its elevation must not
     move by so much as a quantisation step. */
  const SOUTH = [6370011.0, 2126511.1], LOT25 = [6370541, 2129519];
  const site = SBMM.demSite, res = SBMM.demRes, abp = SBMM.demAbp;
  const probe = p => { const [z, src] = SBMM.elev(p[0], p[1]); return { z, src }; };
  return {
    order: SBMM.dems.map(d => d.m.cell + "/" + d.m.w + "x" + d.m.h),
    haveRes: !!res,
    resMeta: res ? { x0: res.m.x0, y0: res.m.y0, w: res.m.w, h: res.m.h, cell: res.m.cell } : null,
    keyKept: "dem_res_png" in SBMM_DATA,
    keyNulled: SBMM_DATA.dem_res_png === null,
    south: probe(SOUTH),
    southSite: site.at(SOUTH[0], SOUTH[1]),
    southRes: res ? res.at(SOUTH[0], SOUTH[1]) : NaN,
    southInAbp: abp.inside(SOUTH[0], SOUTH[1]),
    lot25: probe(LOT25),
    lot25Abp: abp.at(LOT25[0], LOT25[1]),
    /* the isopach's own ground stack, as the worker receives it */
    jobGrids: SBMM.compute.gridsFor([6369960, 2126110, 6371378, 2130308]).map(g => g.cell),
    slopeSrc: (SBMM.slopeAt(SOUTH[0], SOUTH[1]) || {}).src
  };
});
console.log("DEM stack:", JSON.stringify(demStack.order), "| dem_res", JSON.stringify(demStack.resMeta));
console.log("elev in the Southern Residence lot:", demStack.south.z.toFixed(2), demStack.south.src,
            "| 2-ft site grid said", demStack.southSite.toFixed(2),
            "| Lot 25", demStack.lot25.z.toFixed(2), demStack.lot25.src);
if (!demStack.haveRes) { console.log("FAIL: dem_res did not load — datajs/d_dem_res.js or i_dem_res_png.js is not in the script list"); process.exit(1); }
if (demStack.order.length !== 3 || !/^1\//.test(demStack.order[0]) || !/^1\//.test(demStack.order[1]) || !/^2\//.test(demStack.order[2])) {
  console.log("FAIL: SBMM.dems is not [1-ft mine, 1-ft residential, 2-ft site]:", JSON.stringify(demStack.order)); process.exit(1);
}
if (!demStack.keyKept || !demStack.keyNulled) {
  console.log("FAIL: dem_res_png must keep its key and be nulled after decode (dual-build contract):",
              demStack.keyKept, demStack.keyNulled); process.exit(1);
}
if (demStack.southInAbp) { console.log("FAIL: the southern probe is inside dem_abp — it proves nothing"); process.exit(1); }
if (demStack.south.src !== "1-ft DEM") {
  console.log("FAIL: the Southern Residence lot still reads off the", demStack.south.src); process.exit(1);
}
if (!(Math.abs(demStack.south.z - demStack.southRes) < 1e-6)) {
  console.log("FAIL: SBMM.elev did not return the dem_res value there:", demStack.south.z, demStack.southRes); process.exit(1);
}
/* the point of the exercise: the 2-ft grid was 0.78 ft out here. Ground this
   far off under a 1-ft design raster is what manufactured the isopach's fill. */
if (!(Math.abs(demStack.south.z - demStack.southSite) > 0.25)) {
  console.log("FAIL: the 1-ft and 2-ft grids differ by only",
              Math.abs(demStack.south.z - demStack.southSite).toFixed(3),
              "ft at the southern probe — dem_res is not being read"); process.exit(1);
}
if (demStack.slopeSrc !== "1-ft DEM") {
  console.log("FAIL: SBMM.slopeAt did not follow the same stack:", demStack.slopeSrc); process.exit(1);
}
/* dem_abp wins where the two 1-ft windows overlap, so nothing in the mine
   window — and so no golden number — can move */
if (!(Math.abs(demStack.lot25.z - demStack.lot25Abp) < 1e-6)) {
  console.log("FAIL: Lot 25 no longer reads off dem_abp:", demStack.lot25.z, demStack.lot25Abp); process.exit(1);
}
/* the residential design raster is now backed by 1-ft ground over its whole
   extent — this is what removes the phantom fill below */
if (demStack.jobGrids.join(",") !== "1,1,2") {
  console.log("FAIL: the worker ground stack over the residential design bbox is", JSON.stringify(demStack.jobGrids)); process.exit(1);
}

/* the excavation-bottom cut, integrated in the browser from the shipped raster.
   Agent A validated 7,561.9 yd3 against Sum(area x depth) 7,565.6 at build time;
   this is the same number computed through the PNG decoder and the isopach
   kernel, so it checks the whole chain rather than the manifest. */
excCut = await page.evaluate(async () => {
  const f = SBMM.refSurf.featureOf("res_excbottom");
  await SBMM.refSurf.ready(f);
  const R = await SBMM.isopach.show("res_excbottom");
  return R ? { cut: R.cut_ft3 / 27, fill: R.fill_ft3 / 27, cell: R.cell, intCell: R.intCell, n: R.n,
               nChanged: R.nChanged, nEdge: R.nEdge, hi: R.hi, box: R.changedBox,
               draped: !!SBMM.isopach.drapeSpec(),
               layerOnMap: !!SBMM.isopach.active(),
               card: [...document.querySelectorAll("#resBody .res h4")].some(h => /Isopach/.test(h.textContent)),
               legend: !!document.querySelector("#resBody .isoleg") } : null;
});
if (!excCut) { console.log("FAIL: the isopach produced no result"); process.exit(1); }
console.log("isopach res_excbottom vs lidar: cut", excCut.cut.toFixed(1), "yd3 | fill",
            excCut.fill.toFixed(1), "| cells", excCut.n, "integrated @", excCut.intCell,
            "ft, drawn @", excCut.cell, "ft | 3D drape", excCut.draped, "| legend", excCut.legend);
/* tools/build_cad_surfaces.py validated this surface at 7,561.9 yd3 cut against
   the raw lidar MASTER. In the browser the same integral runs against the
   SHIPPED DEMs and both surfaces are terrain-RGB quantised, so a residual of a
   couple of tenths of a percent is expected and is not slack in the assertion.
   Anything that actually breaks (a bad decode, an inverted sign, an unclipped
   raster) misses by orders of magnitude, not by half a percent.

   The tolerance is 0.5 %, tightened from 1 % once dem_res landed: the whole
   design raster now sits on 1-ft ground (33 % of it used to fall on the 2-ft
   site grid), so the only thing left between this number and the build-time
   one is the two rasters' 0.02 ft quantisation. */
if (!(Math.abs(excCut.cut - 7561.9) <= 7561.9 * 0.005)) {
  console.log("FAIL: res_excbottom cut is", excCut.cut.toFixed(1), "yd3, expected 7,562 within 0.5 %"); process.exit(1);
}
if (excCut.intCell !== 1) { console.log("FAIL: the isopach must integrate at the surface's own 1-ft cell"); process.exit(1); }
/* F9. res_excbottom is existing ground minus a depth INSIDE the limits of
   excavation and existing ground everywhere else out to a 60 ft working
   buffer, so against the ground it is all cut and no fill — by construction.
   Before the comparison tolerance it reported 180 yd3 of fill and a 1.37 ft
   "deepest fill", all of it manufactured by comparing a 1 ft design raster
   against the 2 ft site DEM in the part of the buffer the 1 ft mine DEM does
   not reach, plus one spike on the raster's own nodata boundary. */
/* The 0.6 yd3 that survived F9 was the last of the same thing: the 2-ft grid
   disagreeing with the 1-ft master over the part of the working buffer the mine
   window does not reach. dem_res removed the coarse ground under this surface
   entirely, so the answer is now 0.0 and the assertion says so. */
if (excCut.fill > 0.5) {
  console.log("FAIL: res_excbottom isopach reports", excCut.fill.toFixed(2),
              "yd3 of fill; the design is at or below existing ground everywhere"); process.exit(1);
}
if (excCut.hi > 0.25) {
  console.log("FAIL: deepest fill is", excCut.hi.toFixed(2), "ft — a raster-edge artefact is back"); process.exit(1);
}
if (!excCut.nEdge) { console.log("FAIL: no raster-edge cells were excluded — the nodata guard is not running"); process.exit(1); }
/* the area that actually CHANGES must be the excavation footprint, not the
   whole working buffer: EA prints 204,303 ft2 over the limits of excavation */
changedSF = excCut.nChanged * excCut.intCell * excCut.intCell;
console.log("isopach changed area:", changedSF.toFixed(0), "ft2 vs EA's printed 204,303 ft2 |",
            "raster-edge cells excluded", excCut.nEdge, "| deepest fill", excCut.hi.toFixed(2), "ft");
if (Math.abs(changedSF - 204303) > 204303 * 0.03) {
  console.log("FAIL: the isopach's changed area is", changedSF.toFixed(0),
              "ft2, expected EA's printed 204,303 within 3 %"); process.exit(1);
}
if (!excCut.box) { console.log("FAIL: the isopach reported no bounding box for the change"); process.exit(1); }
if (!excCut.layerOnMap || !excCut.card || !excCut.legend) {
  console.log("FAIL: the isopach did not draw its overlay, card and legend"); process.exit(1);
}
await page.screenshot({ path: "shots/isopach.png" });
await page.evaluate(() => SBMM.isopach.clear());

/* "volume of this excavation": area x depth and the raster method side by side */
excVol = await page.evaluate(async () => {
  const D = SBMM_DATA.design_gis;
  const f = D.features.find(x => x.properties.layer === "exc" && x.properties.name === "Limit of excavation — Lot 15");
  await SBMM.isopach.excavationVolume(f.properties, f.geometry);
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 100));
    const card = [...document.querySelectorAll("#resBody .res")].find(c => /Lot 15 — volume/.test(c.textContent));
    if (card && /Agreement/.test(card.textContent)) {
      const rows = [...card.querySelectorAll(".rrow")].map(r => [r.children[0].textContent, r.children[1].textContent]);
      return { rows, depth: f.properties.depth_ft, area: f.properties.area_sf };
    }
  }
  return null;
});
if (!excVol) { console.log("FAIL: 'volume of this excavation' produced no card"); process.exit(1); }
console.log("volume of this excavation (Lot 15):", JSON.stringify(excVol.rows.filter(r => r[0])));
if (excVol.depth !== 1) { console.log("FAIL: the Lot 15 limit should carry depth_ft = 1.0, got", excVol.depth); process.exit(1); }
{
  const g = t => parseFloat(String(t).replace(/,/g, ""));
  const analytic = g(excVol.rows.find(r => /Area × depth/.test(r[0]))[1]);
  const raster = g(excVol.rows.find(r => /Raster method/.test(r[0]))[1]);
  if (!(analytic > 1000 && raster > 1000 && Math.abs(raster - analytic) / analytic < 0.05)) {
    console.log("FAIL: the two excavation-volume methods disagree:", analytic, raster); process.exit(1);
  }
}
});

/* ==================================================================== */
let errBeforeWater, wmode, wdrop, wexport, duAim, duScr, duPop, wover, w3d, wcatch, wclear, wchain;   /* hoisted — v18 §3 */
await block("9w. water", async () => {
/* 9w. water — raindrop and overtopping (docs/V10_WATER_SPEC.md §4.5)    */
/* ==================================================================== */
/* The reference numbers are §9 of the water spec, computed by the planner with
   an independent Python implementation of §2 on the same PNG-decoded grids.
   They are constants (WREF, at the top of this file beside the fixtures, because
   three later blocks read them too) so a change of terrain source shows up as an
   argument about the numbers rather than a quiet drift in the assertions. */
errBeforeWater = errors.length;

/* --- 1. the mode, the menu and the commands -------------------------- */
wmode = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const key = k => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  SBMM.mode.navigate();
  key("r"); await wait(80);
  const armed = {
    mode: SBMM.mode.current(), tool: SBMM.tools.active(),
    cursor: document.getElementById("stage").dataset.cursor,
    hud: document.querySelector("#modeHud .mhname").textContent,
    btnLit: document.getElementById("waterMenuBtn").classList.contains("active"),
    btnLabel: document.querySelector("#waterMenuBtn .tlbl").textContent,
    tip: (document.getElementById("sketchTip").textContent || "").slice(0, 9)
  };
  key("Escape"); await wait(80);
  const back = { mode: SBMM.mode.current(),
                 btnLabel: document.querySelector("#waterMenuBtn .tlbl").textContent };
  const cmds = ["DROP", "RAIN", "RAINDROP", "WATERDROP", "FLOW", "OVERTOP", "SPILL", "POUR",
                "CATCH", "WATERSHED"].map(n => [n, (SBMM.cmd.find(n) || {}).n || null]);
  const menu = [...document.querySelectorAll("#waterMenu .ci")].map(c => c.dataset.m || c.dataset.a);
  /* the animated flow pane must be SVG and must not take pointer events (§4.3) */
  const pane = SBMM.map.getPane("water");
  return { armed, back, cmds, menu,
           pane: { z: getComputedStyle(pane).zIndex, pe: getComputedStyle(pane).pointerEvents,
                   canvas: !!pane.querySelector("canvas") } };
});
console.log("water mode:", JSON.stringify(wmode.armed), "| Esc ->", JSON.stringify(wmode.back));
console.log("water commands:", wmode.cmds.map(c => c[0] + "->" + c[1]).join(" "), "| menu:", wmode.menu.join(","));
console.log("water pane:", JSON.stringify(wmode.pane));
if (wmode.armed.mode !== "raindrop" || wmode.armed.tool !== "raindrop")
  { console.log("FAIL: R did not arm the raindrop mode"); process.exit(1); }
if (wmode.armed.cursor !== "crosshair" || wmode.armed.hud !== "Raindrop")
  { console.log("FAIL: the raindrop mode did not own the cursor and the HUD"); process.exit(1); }
if (!wmode.armed.btnLit || wmode.armed.btnLabel !== "Raindrop ▾")
  { console.log("FAIL: the Water ▾ button must light and name the active mode (F7)"); process.exit(1); }
if (wmode.back.mode !== "navigate" || wmode.back.btnLabel !== "Water ▾")
  { console.log("FAIL: Esc did not return the Water menu button to its home label"); process.exit(1); }
for (const [alias, cmd] of wmode.cmds)
  if (!cmd) { console.log("FAIL: water command missing:", alias); process.exit(1); }
if (wmode.cmds[0][1] !== "DROP" || wmode.cmds[5][1] !== "OVERTOP" || wmode.cmds[8][1] !== "CATCH")
  { console.log("FAIL: a water alias resolves to the wrong command", wmode.cmds); process.exit(1); }
if (wmode.menu.join(",") !== "raindrop,overtop,overtop-click,storm-toggle,drainage,water-clear")
  { console.log("FAIL: the Water menu is wrong:", wmode.menu); process.exit(1); }
if (wmode.pane.pe !== "none" || wmode.pane.canvas)
  { console.log("FAIL: the water pane must be an SVG pane that takes no pointer events"); process.exit(1); }

/* --- 2. the golden raindrop (§9.1) ----------------------------------- */
wdrop = await page.evaluate(async (D) => {
  const f = await SBMM.water.dropAt(D[0], D[1]);
  if (!f) return { err: "dropAt returned nothing" };
  const p = f.props;
  /* The run must descend, and the only thing that can lift it is crossing a
     depression: it enters at the floor and leaves at the pour point, which is
     higher. So a rise is legitimate exactly when it is no bigger than a pond
     the run crossed — including the ones too shallow to report, which are
     crossed silently and are why "non-increasing except at a REPORTED pond
     level" is not the right test (this run has three rises of 0.02-0.08 ft in
     puddles under the 0.25 ft reporting floor). Anything bigger than that is
     the drop climbing a hill, which is a broken trace. */
  const rises = [];
  for (let i = 1; i < p.zs.length; i++)
    if (p.zs[i] != null && p.zs[i - 1] != null && p.zs[i] > p.zs[i - 1] + 0.01)
      rises.push(+(p.zs[i] - p.zs[i - 1]).toFixed(3));
  const maxPond = Math.max(p.minPondDepth, ...p.ponds.map(q => q.depth_ft));
  const badRises = rises.filter(d => d > maxPond + 0.01);
  return {
    id: f.id, type: f.type, group: f.group, n: f.pts.length,
    dropZ: p.drop_z, length: p.length_ft, fall: p.fall_ft, grade: p.grade_pct,
    reason: p.end.reason, end: [p.end.x, p.end.y], lastZ: p.end.z_last,
    ponds: p.ponds.map(q => ({ level: q.level, cells: q.cells, depth: q.depth_ft,
                               vol: q.volume_ft3, rings: (q.rings || []).length })),
    dem: p.dem, grids: p.grids, hops: p.hops, zs: p.zs.length,
    rises, maxPond, badRises,
    cls: SBMM.myWork.classOf(f),
    inTree: [...document.querySelectorAll("#featureTree .ftrow")].some(r => r.dataset.fid === f.id),
    onMap: SBMM.map.hasLayer(f.layer),
    subLayers: f.layer.getLayers().length,
    animPaths: document.querySelectorAll(".leaflet-pane path.flowanim").length,
    dropMarker: !!document.querySelector(".dropmk"),
    endMarker: !!document.querySelector(".flowend"),
    card: !!(f.card && f.card.querySelector(".flowspark"))
  };
}, WREF.drop);
console.log("raindrop:", JSON.stringify(wdrop));
if (wdrop.err) { console.log("FAIL:", wdrop.err); process.exit(1); }
if (wdrop.type !== "flow" || wdrop.group !== "Water" || wdrop.cls !== "water")
  { console.log("FAIL: a raindrop must be a `flow` feature in the Water class"); process.exit(1); }
if (Math.abs(wdrop.dropZ - WREF.dropZ) > WREF.dropZTol)
  { console.log("FAIL: z at the drop", wdrop.dropZ, "vs", WREF.dropZ); process.exit(1); }
if (wdrop.reason !== WREF.reason)
  { console.log("FAIL: the run should reach Clear Lake, got", wdrop.reason); process.exit(1); }
if (wdist(wdrop.end, WREF.end) > WREF.endTol)
  { console.log("FAIL: the run ends at", wdrop.end, "not", WREF.end); process.exit(1); }
if (Math.abs(wdrop.lastZ - WREF.lastZ) > WREF.lastZTol)
  { console.log("FAIL: last surveyed z", wdrop.lastZ, "vs", WREF.lastZ); process.exit(1); }
{
  const d = (wdrop.length - WREF.lengthRaw) / WREF.lengthRaw * 100;
  console.log("  run length", wdrop.length, "ft vs unsimplified", WREF.lengthRaw, "->", d.toFixed(2), "%");
  if (d < -3 || d > 0.5) { console.log("FAIL: the simplified run length is outside -3 % / +0.5 %"); process.exit(1); }
}
if (wdrop.ponds.length !== WREF.ponds)
  { console.log("FAIL: expected", WREF.ponds, "ponds, got", wdrop.ponds.length); process.exit(1); }
for (const [i, ref] of [[0, WREF.pond1], [1, WREF.pond2]]) {
  const got = wdrop.ponds[i];
  if (Math.abs(got.level - ref.level) > 0.03 || Math.abs(got.cells - ref.cells) > 2)
    { console.log("FAIL: pond", i + 1, JSON.stringify(got), "vs", JSON.stringify(ref)); process.exit(1); }
  if (!got.rings) { console.log("FAIL: pond", i + 1, "has no outline to draw"); process.exit(1); }
}
if (wdrop.badRises.length)
  { console.log("FAIL: the run climbs", wdrop.badRises, "ft — bigger than any depression it crossed"); process.exit(1); }
if (!wdrop.inTree || !wdrop.onMap)
  { console.log("FAIL: the flow is not in the My-work tree / on the map"); process.exit(1); }
if (wdrop.subLayers < 5 || !wdrop.animPaths || !wdrop.dropMarker || !wdrop.endMarker || !wdrop.card)
  { console.log("FAIL: the flow is not fully drawn (glow/line/ponds/drop/end/animation/card)"); process.exit(1); }

/* the exports carry the run AND its ponds, and a session round-trip rebuilds
   both without running a single compute job */
wexport = await page.evaluate(() => {
  const fc = SBMM.io.collection("sp");
  const line = fc.features.find(f => f.properties.tool === "flow");
  const ponds = fc.features.filter(f => f.properties.tool === "pond");
  const dxf = SBMM.dxf.buildDXF ? SBMM.dxf.buildDXF() : null;
  const f = SBMM.store.features.find(g => g.type === "flow");
  const spec = SBMM.store.serialize().features.find(x => x.type === "flow");
  const s0 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  SBMM.store.remove(f);
  const nf = SBMM.tools.rebuildFeature(spec);
  const s1 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  return {
    lineType: line && line.geometry.type, lineN: line && line.geometry.coordinates.length,
    lineLen: line && line.properties.length_ft,
    ponds: ponds.length,
    pondProps: ponds[0] && ["parent", "level", "depth_ft", "area_ft2", "volume_ft3"]
      .every(k => ponds[0].properties[k] != null),
    dxfLayers: dxf ? /WATER-PONDS/.test(dxf) : null,
    rebuilt: { n: nf.pts.length, ponds: nf.props.ponds.length, len: nf.props.length_ft,
               type: nf.type, drawn: SBMM.map.hasLayer(nf.layer) },
    jobs: s1 - s0
  };
});
console.log("flow export / round trip:", JSON.stringify(wexport));
if (wexport.lineType !== "LineString" || !wexport.ponds || !wexport.pondProps)
  { console.log("FAIL: GeoJSON must carry the run as a LineString plus one polygon per pond"); process.exit(1); }
if (wexport.rebuilt.n !== wdrop.n || wexport.rebuilt.ponds !== wdrop.ponds.length || !wexport.rebuilt.drawn)
  { console.log("FAIL: a flow did not survive serialise -> remove -> rebuild"); process.exit(1); }
if (wexport.jobs !== 0)
  { console.log("FAIL: rebuilding a flow ran", wexport.jobs, "compute jobs — it must rebuild from props"); process.exit(1); }

/* --- 3. the new pane must not eat pointer events --------------------- */
/* preferCanvas plus a pane above the drawings is exactly the shape of the bug
   in CLAUDE.md, so the check is a real click on a decision unit with a flow and
   the animated water pane on the map. */
await page.evaluate(() => { SBMM.mode.navigate(); SBMM.map.closePopup(); });
duAim = await page.evaluate(() => {
  const gisAt = (x, y) => {
    const D = SBMM_DATA.design_gis;
    return D && D.features.some(f => f.geometry.type === "Polygon"
      && SBMM.layerState.isOn("design", "gis_" + f.properties.layer)
      && pointInPoly(x, y, f.geometry.coordinates[0]));
  };
  const near = (x, y) => SBMM.samples.some(p => Math.hypot(p.x - x, p.y - y) < 60)
    || SBMM_DATA.piles.some(p => pointInPoly(x, y, p.ring))
    /* v12: the storm structures are DOM markers in the vectors pane and take
       clicks like anything else */
    || ((SBMM_DATA.storm_network || { nodes: [] }).nodes || [])
         .some(n => Math.hypot(n.x - x, n.y - y) < 60)
    || SBMM.store.features.some(f => f.pts.some(q => Math.hypot(q[0] - x, q[1] - y) < 60));
  for (const d of SBMM_DATA.dus) {
    const b = d.ring.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]),
                                       Math.max(a[2], p[0]), Math.max(a[3], p[1])],
                            [1e12, 1e12, -1e12, -1e12]);
    for (let k = 0; k < 40; k++) {
      const x = b[0] + (b[2] - b[0]) * (0.1 + 0.8 * ((k * 7) % 40) / 40);
      const y = b[1] + (b[3] - b[1]) * (0.1 + 0.8 * ((k * 13) % 40) / 40);
      if (!pointInPoly(x, y, d.ring)) continue;
      if ((d.holes || []).some(h => pointInPoly(x, y, h))) continue;
      if (gisAt(x, y) || near(x, y)) continue;
      return { name: d.name, x, y };
    }
  }
  return null;
});
if (!duAim) { console.log("FAIL: could not find a clear point inside a decision unit"); process.exit(1); }
duScr = await page.evaluate(async (t) => {
  SBMM.map.invalidateSize();
  SBMM.map.setView([t.y, t.x], 1, { animate: false });
  await new Promise(r => setTimeout(r, 400));
  const p = SBMM.map.latLngToContainerPoint([t.y, t.x]);
  const box = document.getElementById("map").getBoundingClientRect();
  return { x: Math.round(box.left + p.x), y: Math.round(box.top + p.y) };
}, duAim);
await page.mouse.click(duScr.x, duScr.y);
await page.waitForTimeout(600);
duPop = await page.evaluate(() => ({
  txt: (document.querySelector(".leaflet-popup-content") || {}).textContent || "",
  anim: document.querySelectorAll(".leaflet-pane path.flowanim").length
}));
console.log(`pass-through with the water pane up: clicked ${duAim.name} -> "${duPop.txt.trim().split("\n")[0]}"`,
            "| animated flow paths on the map:", duPop.anim);
if (!duPop.txt.includes(duAim.name))
  { console.log("FAIL: the water pane swallowed a click meant for a decision unit"); process.exit(1); }
await page.evaluate(() => { SBMM.map.closePopup(); });

/* --- 4. the overtopping analysis (§9.2) ------------------------------ */
wover = await page.evaluate(async () => {
  /* survey:false, storm:false — this block checks the PURE-LIDAR §9.2
     reference: no surveyed stages (spec §10, block 9v below) and no storm
     network (v13 §2, block 9t below), so the numbers here are the terrain's
     alone. It is also v13 §4's "with the network off the analysis is
     bit-identical to today's", asserted on Herman. */
  const R = await SBMM.water.overtopHerman({ survey: false, storm: false });
  if (!R) return { err: "overtopHerman returned nothing" };
  const route = SBMM.store.features.find(f => f.type === "flow" && /overflow route/.test(f.name));
  const pool = SBMM.store.features.find(f => f.type === "area" && /at spill/.test(f.name));
  const sl = document.getElementById("wsRange");
  const before = { route: route ? route.visible : null,
                   label: (document.querySelector(".wslabel") || {}).textContent || "" };
  /* below the spill the route is hidden; back at the spill it returns. The
     slider walks the stage table by index (spec §10), so "z0 + 1 ft" is the
     index of the first row at or above that level */
  sl.value = String(Math.max(0, R.stage.findIndex(st => st.level >= R.z0 + 1 - 1e-9)));
  sl.dispatchEvent(new Event("input"));
  await new Promise(r => setTimeout(r, 120));
  const low = { route: route ? route.visible : null,
                label: (document.querySelector(".wslabel") || {}).textContent || "" };
  sl.value = sl.getAttribute("value");
  sl.dispatchEvent(new Event("input"));
  await new Promise(r => setTimeout(r, 120));
  const back = { route: route ? route.visible : null,
                 label: (document.querySelector(".wslabel") || {}).textContent || "" };
  return {
    z0: R.z0, seedCells: R.seedCells, spill: R.primary.level,
    spillAt: [R.primary.x, R.primary.y], next: R.primary.next,
    freeboard: R.freeboard_ft, storage: R.storage_ft3, areaAc: R.area_ft2 / 43560,
    clusters: R.clusters.map(c => ({ rank: c.rank, level: c.level, above: c.above_ft,
                                     at: [c.x, c.y], cells: c.cells })),
    stage: R.stage.length, reason: R.reason,
    sliderLevel: (R.stage[+sl.getAttribute("value")] || {}).level,
    band: !!(R.band && R.band.v), spillCells: R.spillMask
      ? R.spillMask.v.reduce((n, v) => n + (v ? 1 : 0), 0) : 0,
    overlay: !!document.querySelector(".leaflet-pane img.leaflet-image-layer"),
    markers: document.querySelectorAll(".spillmk").length,
    priPulse: !!document.querySelector(".spillmk.pri"),
    rimRows: document.querySelectorAll("table.rimtbl tr[data-x]").length,
    chart: !!document.querySelector(".stagechart"),
    slider: sl ? { min: +sl.min, max: +sl.max, step: +sl.step, val: +sl.value } : null,
    before, low, back,
    route: route ? { name: route.name, len: route.props.length_ft, reason: route.props.end.reason,
                     end: [route.props.end.x, route.props.end.y], dem: route.props.dem,
                     ponds: route.props.ponds.length } : null,
    pool: pool ? { name: pool.name, overtop: pool.props.overtop } : null,
    drape: SBMM.water.drapeSpec() ? "yes" : "no"
  };
});
console.log("overtopping:", JSON.stringify({
  z0: wover.z0, spill: wover.spill, at: wover.spillAt, freeboard: wover.freeboard,
  storage: wover.storage, areaAc: wover.areaAc, clusters: wover.clusters.length,
  stage: wover.stage, markers: wover.markers, spillCells: wover.spillCells, route: wover.route
}));
if (wover.err) { console.log("FAIL:", wover.err); process.exit(1); }
if (Math.abs(wover.z0 - WREF.z0) > WREF.z0Tol)
  { console.log("FAIL: water surface", wover.z0, "vs", WREF.z0); process.exit(1); }
if (Math.abs(wover.seedCells - WREF.seedCells) / WREF.seedCells > 0.005)
  { console.log("FAIL: seed cells", wover.seedCells, "vs", WREF.seedCells); process.exit(1); }
if (Math.abs(wover.spill - WREF.spill) > WREF.spillTol)
  { console.log("FAIL: spill level", wover.spill, "vs", WREF.spill); process.exit(1); }
if (wdist(wover.spillAt, WREF.spillAt) > WREF.spillTol_ft)
  { console.log("FAIL: spill position", wover.spillAt, "vs", WREF.spillAt); process.exit(1); }
if (wdist(wover.next, WREF.next) > WREF.nextTol)
  { console.log("FAIL: primary.next", wover.next, "vs", WREF.next); process.exit(1); }
if (Math.abs(wover.freeboard - WREF.freeboard) > WREF.freeboardTol)
  { console.log("FAIL: freeboard", wover.freeboard, "vs", WREF.freeboard); process.exit(1); }
if (Math.abs(wover.storage - WREF.storage) / WREF.storage > 0.03)
  { console.log("FAIL: storage to spill", wover.storage, "vs", WREF.storage); process.exit(1); }
if (Math.abs(wover.areaAc - WREF.areaAtSpill) / WREF.areaAtSpill > 0.03)
  { console.log("FAIL: area at spill", wover.areaAc, "vs", WREF.areaAtSpill); process.exit(1); }
if (wover.clusters.length < 3)
  { console.log("FAIL: fewer than three rim lows within +3 ft"); process.exit(1); }
{
  const c2 = wover.clusters[1];
  if (Math.abs(c2.level - WREF.rimLow2.level) > 0.05 || wdist(c2.at, WREF.rimLow2.at) > 20)
    { console.log("FAIL: rim low 2", JSON.stringify(c2), "vs", JSON.stringify(WREF.rimLow2)); process.exit(1); }
}
if (wover.stage !== WREF.stageRows)
  { console.log("FAIL: the stage table has", wover.stage, "rows, expected", WREF.stageRows); process.exit(1); }
if (!wover.band || !wover.spillCells || !wover.overlay)
  { console.log("FAIL: the rim band overlay is not on the map"); process.exit(1); }
if (wover.markers !== wover.clusters.length || !wover.priPulse)
  { console.log("FAIL: the ranked rim markers are missing"); process.exit(1); }
if (wover.rimRows !== wover.clusters.length || !wover.chart)
  { console.log("FAIL: the card is missing the rim-lows table or the stage chart"); process.exit(1); }
/* the slider is index-based over the stage table (spec §10): 0 .. rows-1, step 1,
   defaulting to the first row at or above the spill */
if (!wover.slider || wover.slider.min !== 0 || wover.slider.step !== 1
    || wover.slider.max !== wover.stage - 1
    || wover.sliderLevel == null || wover.sliderLevel < wover.spill - 1e-6 || wover.sliderLevel > wover.spill + 0.25 + 1e-9)
  { console.log("FAIL: the level slider is wrong:", JSON.stringify(wover.slider), wover.sliderLevel); process.exit(1); }
if (wover.before.route !== true || wover.low.route !== false || wover.back.route !== true)
  { console.log("FAIL: the slider must hide the overflow route below the spill and show it at it"); process.exit(1); }
if (!/no (overflow|discharge)/.test(wover.low.label) || !/OVERFLOWS/.test(wover.back.label))
  { console.log("FAIL: the slider label does not say whether it overflows:", wover.low.label, "|", wover.back.label); process.exit(1); }
if (!wover.route) { console.log("FAIL: no overflow route feature was created"); process.exit(1); }
if (wover.route.reason !== WREF.routeReason)
  { console.log("FAIL: the overflow route ends", wover.route.reason, "not", WREF.routeReason); process.exit(1); }
if (wdist(wover.route.end, WREF.routeEnd) > WREF.routeEndTol)
  { console.log("FAIL: the overflow route ends at", wover.route.end, "not", WREF.routeEnd); process.exit(1); }
if (Math.abs(wover.route.len - WREF.routeLength) / WREF.routeLength > 0.10)
  { console.log("FAIL: the overflow route is", wover.route.len, "ft, expected", WREF.routeLength); process.exit(1); }
if (wover.route.dem !== "2-ft")
  { console.log("FAIL: the overflow route must run on the same grid as the analysis, got", wover.route.dem); process.exit(1); }
if (!wover.pool || !wover.pool.overtop || Math.abs(wover.pool.overtop.spill - WREF.spill) > WREF.spillTol)
  { console.log("FAIL: the 'at spill' polygon is missing its overtopping record"); process.exit(1); }
if (wover.drape !== "yes") { console.log("FAIL: drapeSpec() is null after an overtopping analysis"); process.exit(1); }

/* --- 5. the flow and the band reach 3D ------------------------------- */
w3d = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const wasOpen = SBMM.viewer3d.isOpen();
  if (!wasOpen) { await SBMM.viewer3d.toggle(); await wait(1400); }
  SBMM.viewer3d.refreshOverlays();
  await wait(500);
  const f = SBMM.store.features.find(g => g.type === "flow" && !/overflow/.test(g.name));
  const kind = () => SBMM.pick3d.registered().filter(r => r.kind === "feature").length;
  const withFlow = kind();
  SBMM.store.setVisible(f, false);
  SBMM.viewer3d.refreshOverlays();
  await wait(400);
  const without = kind();
  SBMM.store.setVisible(f, true);
  SBMM.viewer3d.refreshOverlays();
  await wait(400);
  const back = kind();
  if (SBMM.viewer3d.refreshDrapes) SBMM.viewer3d.refreshDrapes();
  await wait(900);
  const st = SBMM.viewer3d.stats();
  const out = { withFlow, without, back, waterDraped: st.waterDraped, isopachDraped: st.isopachDraped };
  /* the 3D card and the 2D popup are the same builder — the only way "the same
     popup" is a fact about the code rather than a claim about two copies */
  const html = SBMM.popups.forFeature(f);
  out.popupHasLength = /Length/.test(html);
  out.popupHasActions = /retrace/.test(html) && /catchment/.test(html);
  if (!wasOpen) { await SBMM.viewer3d.toggle(); await wait(500); }
  return out;
});
console.log("water in 3D:", JSON.stringify(w3d));
if (w3d.withFlow - w3d.without < 3 || w3d.back !== w3d.withFlow)
  { console.log("FAIL: the flow's 3D objects are not in the pick registry"); process.exit(1); }
if (!w3d.waterDraped) { console.log("FAIL: the rim band is not draped in 3D"); process.exit(1); }
if (!w3d.popupHasLength || !w3d.popupHasActions)
  { console.log("FAIL: the flow popup is missing its rows or actions"); process.exit(1); }

/* --- 6. the catchment (§9.1) ----------------------------------------- */
wcatch = await page.evaluate(async () => {
  const f = SBMM.store.features.find(g => g.type === "flow" && !/overflow/.test(g.name));
  const a = await SBMM.water.catchment(f);
  if (!a) return { err: "catchment returned nothing" };
  return { type: a.type, area: a.props.catchment_ft2, cells: a.props.catchment_cells,
           partial: a.props.catchment_partial, n: a.pts.length, name: a.name };
});
console.log("catchment:", JSON.stringify(wcatch));
if (wcatch.err) { console.log("FAIL:", wcatch.err); process.exit(1); }
if (wcatch.type !== "area" || Math.abs(wcatch.area - WREF.catchment) / WREF.catchment > 0.05)
  { console.log("FAIL: contributing area", wcatch.area, "vs", WREF.catchment); process.exit(1); }

/* --- 7. clearOvertop keeps the two features, drops the overlay -------- */
wclear = await page.evaluate(() => {
  const before = SBMM.store.features.length;
  SBMM.water.clearOvertop();
  return { kept: SBMM.store.features.length === before,
           /* both of these are huge typed-array-bearing objects when they exist,
              and the question here is only whether they still do */
           drape: !!SBMM.water.drapeSpec(), active: !!SBMM.water.active(),
           overlay: document.querySelectorAll(".spillmk").length,
           card: !!document.querySelector("table.rimtbl") };
});
console.log("clear water overlays:", JSON.stringify(wclear));
if (!wclear.kept) { console.log("FAIL: clearing the overlay deleted features"); process.exit(1); }
if (wclear.drape || wclear.active || wclear.overlay || wclear.card)
  { console.log("FAIL: clearOvertop left the overlay behind"); process.exit(1); }

/* --- 8. window chaining, as a manual check (§9.1's note) -------------- */
/* Not a golden: the planner kept this drop precisely because it runs off the
   edge of its window and has to be re-run on the next grid. What is asserted is
   the CHAINING, not a number. */
wchain = await page.evaluate(async () => {
  const f = await SBMM.water.dropAt(6371600, 2128900);
  if (!f) return { err: "no feature" };
  const p = f.props;
  const out = { n: f.pts.length, len: p.length_ft, hops: p.hops, grids: p.grids,
                reason: p.end.reason, ponds: p.ponds.length,
                deepest: Math.max(0, ...p.ponds.map(q => q.depth_ft)) };
  SBMM.store.remove(f);
  return out;
});
console.log("window chaining check (drop 6371600, 2128900):", JSON.stringify(wchain));
if (wchain.err) { console.log("FAIL:", wchain.err); process.exit(1); }
if (!wchain.hops || wchain.grids.length < 1)
  { console.log("FAIL: a run that leaves its window must be re-run on the next one"); process.exit(1); }

if (errors.length !== errBeforeWater) {
  console.log("FAIL: page errors during the water block:",
              errors.slice(errBeforeWater, errBeforeWater + 6)); process.exit(1);
}
});

/* ==================================================================== */
let errBeforeSurvey, survey;   /* hoisted — v18 §3 */
await block("9v. the August-2026 survey (docs/V10_WATER_SPEC.md §10)", async () => {
/* 9v. the August-2026 survey (docs/V10_WATER_SPEC.md §10)               */
/*                                                                       */
/* The survey payload and its dataset load; the pipes carry their inverts;*/
/* and the Herman analysis uses the surveyed water surface as today's    */
/* level with the pipe invert and the sandbag crest as exact stages,     */
/* ahead of the lidar rim spill. Reference numbers: the planner's Python */
/* over the same grid (survey_stage_ref): pipe 1341.55 -> 109.16 ac-ft,  */
/* crest 1343.54 -> 153.84, spill 1343.84 -> 160.67; freeboard 7.39.     */
/* ==================================================================== */
errBeforeSurvey = errors.length;
survey = await page.evaluate(async () => {
  const out = {};
  const D = SBMM_DATA.survey_2026;
  out.layers = D && D.layers ? D.layers.length : 0;
  out.features = D && D.features ? D.features.length : 0;
  out.rowsOn = (D ? D.layers : []).filter(l => SBMM.layerState.isOn("invest", "survey_" + l.key)).length;
  out.subHeader = [...document.querySelectorAll("#investLayers .lsub")].some(h => /Survey/.test(h.textContent));
  const ds = (SBMM_DATA.datasets || []).find(d => d.id === "survey_2026");
  out.points = ds ? ds.points.length : 0;
  const wl = ds && ds.points.find(p => p.id === "Water Level");
  out.waterLevel = wl ? [wl.x, wl.y, wl.a.elevation] : null;
  const pipeN = D.features.find(f => f.properties.layer === "survey_pipe" && /North/.test(f.properties.name));
  out.pipePopup = pipeN ? SBMM.popups.forGis(pipeN.properties, pipeN.geometry) : "";
  out.outlet = SBMM.survey.pipeOutlet();
  out.geo = SBMM.survey.geoFeatures(p => p).length;
  out.dxf = new Set(SBMM.survey.dxfEntities().map(e => e.layer)).size;
  out.snap = SBMM.survey.snapPaths().rings.length;
  /* the Herman analysis with the surveyed stages */
  const ring = SBMM_DATA.design_gis.features.find(f => f.properties.name === "Herman Impoundment").geometry.coordinates[0];
  out.facts = SBMM.water.surveyFacts(ring);
  const R = await SBMM.water.overtop({ ring, name: "Herman Impoundment" });
  await new Promise(r => setTimeout(r, 400));
  out.z0 = R.z0; out.z0lidar = R.z0_lidar; out.spill = R.primary.level; out.freeboard = R.freeboard_ft;
  out.storageSpill = R.storage_ft3;
  const st = lv => R.stage.find(s => Math.abs(s.level - lv) < 1e-6);
  out.pipeStage = st(1341.55) ? { storage: st(1341.55).storage_ft3, area: st(1341.55).area_ft2, extra: !!st(1341.55).extra } : null;
  out.crestStage = st(1343.54) ? { storage: st(1343.54).storage_ft3, extra: !!st(1343.54).extra } : null;
  const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
  out.cardText = card ? card.textContent : "";
  out.pipeRoute = SBMM.store.features.filter(f => f.type === "flow" && /pipe discharge route/.test(f.name))
    .map(f => ({ len: f.props.length_ft, reason: f.props.end.reason, name: f.name,
                 pipe: f.props.pipe_ft, total: f.props.total_ft, outfall: !!f.props.outfall,
                 legs: (f.props.legs || []).map(l => l.id) }));
  out.pipeMarker = document.querySelectorAll(".spillmk.pipe").length;
  const sl = card && card.querySelector("#wsRange");
  out.sliderMax = sl ? +sl.max : -1; out.sliderVal = sl ? +sl.value : -1;
  /* the slider walks the stage table: the pipe row must be reachable exactly */
  const idx = R.stage.findIndex(s => Math.abs(s.level - 1341.55) < 1e-6);
  if (sl && idx >= 0) { sl.value = idx; sl.dispatchEvent(new Event("input")); }
  await new Promise(r => setTimeout(r, 200));
  out.labelAtPipe = card ? card.querySelector(".wslabel").textContent : "";
  /* the LAST of each: the lidar-only block above left its own overflow route
     behind (features survive clearOvertop by design) */
  const flows = SBMM.store.features.filter(f => f.type === "flow");
  const pr = flows.filter(f => /pipe discharge route/.test(f.name)).pop();
  const orr = flows.filter(f => /overflow route/.test(f.name)).pop();
  out.pipeRouteShownAtPipe = pr ? pr.visible !== false : null;
  out.overflowShownAtPipe = orr ? orr.visible !== false : null;
  /* v15 §1: with the surveyed pipes carrying the water below the rim, this
     analysis traces no rim overflow route at all — the one `orr` finds is the
     lidar-only block's, left behind by design. */
  out.routes = SBMM.water.routes();
  out.hermanRimRoutes = SBMM.store.features.filter(f => f.type === "flow"
    && /^Herman Impoundment overflow route/.test(f.name)).length;
  SBMM.water.clearOvertop();
  await new Promise(r => setTimeout(r, 200));
  return out;
});
console.log("survey 2026:", JSON.stringify({ layers: survey.layers, features: survey.features, rowsOn: survey.rowsOn,
  subHeader: survey.subHeader, points: survey.points, waterLevel: survey.waterLevel, outlet: survey.outlet,
  geo: survey.geo, dxfLayers: survey.dxf, snap: survey.snap, facts: survey.facts && { wl: survey.facts.waterLevel,
  pipe: survey.facts.pipeInvert, crest: survey.facts.wallCrest } }));
console.log("Herman with the survey:", JSON.stringify({ z0: survey.z0, z0lidar: survey.z0lidar, spill: survey.spill,
  freeboard: survey.freeboard, storageSpillAcft: +(survey.storageSpill / 43560).toFixed(2),
  pipeStage: survey.pipeStage && { acft: +(survey.pipeStage.storage / 43560).toFixed(2), ac: +(survey.pipeStage.area / 43560).toFixed(2), extra: survey.pipeStage.extra },
  crestStage: survey.crestStage && { acft: +(survey.crestStage.storage / 43560).toFixed(2), extra: survey.crestStage.extra },
  pipeRoute: survey.pipeRoute, pipeMarker: survey.pipeMarker, slider: [survey.sliderVal, survey.sliderMax],
  labelAtPipe: survey.labelAtPipe, pipeRouteShownAtPipe: survey.pipeRouteShownAtPipe, overflowShownAtPipe: survey.overflowShownAtPipe }));
if (survey.layers !== 5 || survey.features !== 30 || survey.rowsOn !== 5 || !survey.subHeader)
  { console.log("FAIL: the survey payload did not build its five rows"); process.exit(1); }
if (survey.points !== 24 || !survey.waterLevel || Math.abs(survey.waterLevel[0] - 6372119.56) > 0.01
    || Math.abs(survey.waterLevel[1] - 2127446.20) > 0.01 || Math.abs(survey.waterLevel[2] - 1336.45) > 1e-9)
  { console.log("FAIL: the survey dataset is missing or its water-level shot is wrong"); process.exit(1); }
if (!/1,?341\.57/.test(survey.pipePopup) || !/trace discharge/.test(survey.pipePopup))
  { console.log("FAIL: the pipe popup does not carry the invert and the discharge action"); process.exit(1); }
if (!survey.outlet || Math.abs(survey.outlet[0] - 6372025.33) > 3 || Math.abs(survey.outlet[1] - 2127481.72) > 3)
  { console.log("FAIL: pipe outlet is not the plotted west end"); process.exit(1); }
if (survey.geo !== 30 || survey.dxf < 4 || survey.snap !== 30) { console.log("FAIL: survey export/snap paths"); process.exit(1); }
if (!survey.facts || Math.abs(survey.facts.pipeInvert - 1341.55) > 1e-9 || Math.abs(survey.facts.wallCrest - 1343.54) > 1e-9)
  { console.log("FAIL: survey facts not read from the dataset"); process.exit(1); }
if (Math.abs(survey.z0 - 1336.45) > 1e-6 || Math.abs(survey.z0lidar - 1336.58) > 0.02)
  { console.log("FAIL: the Herman analysis did not take the surveyed water surface"); process.exit(1); }
if (Math.abs(survey.spill - 1343.84) > 0.05 || Math.abs(survey.freeboard - 7.39) > 0.05)
  { console.log("FAIL: rim spill / freeboard from the surveyed water"); process.exit(1); }
if (Math.abs(survey.storageSpill / 43560 - 160.67) > 160.67 * 0.01) { console.log("FAIL: storage to spill from the surveyed water"); process.exit(1); }
if (!survey.pipeStage || !survey.pipeStage.extra || Math.abs(survey.pipeStage.storage / 43560 - 109.16) > 109.16 * 0.01
    || Math.abs(survey.pipeStage.area / 43560 - 22.18) > 22.18 * 0.01)
  { console.log("FAIL: the pipe stage row"); process.exit(1); }
if (!survey.crestStage || !survey.crestStage.extra || Math.abs(survey.crestStage.storage / 43560 - 153.84) > 153.84 * 0.01)
  { console.log("FAIL: the sandbag crest stage row"); process.exit(1); }
for (const t of ["surveyed, Aug 2026", "First discharge", "1,341.55", "Sandbag wall crest", "1,343.54", "Rim spill", "Pipe discharge route"])
  if (!survey.cardText.includes(t)) { console.log("FAIL: the Herman card lacks '" + t + "'"); process.exit(1); }
if (survey.pipeRoute.length !== 1 || !(survey.pipeRoute[0].len > 50)) { console.log("FAIL: no pipe discharge route"); process.exit(1); }
/* v12 §5.2: with the storm network on, what leaves the surveyed pipes goes down
   EA's drawn storm main to the Clear Lake outfall, and the row says how far of
   it is in pipe rather than reporting the overland stub alone. */
if (!survey.pipeRoute[0].outfall || survey.pipeRoute[0].legs.join(",") !== "pipe_to_main,storm_main_upper,storm_main_lower")
  { console.log("FAIL: the pipe discharge route did not follow the storm main:", JSON.stringify(survey.pipeRoute[0])); process.exit(1); }
if (Math.abs(survey.pipeRoute[0].pipe - 796.8) > 0.5)
  { console.log("FAIL: pipe length of the discharge route", survey.pipeRoute[0].pipe, "vs 796.8"); process.exit(1); }
if (!/storm main/.test(survey.pipeRoute[0].name))
  { console.log("FAIL: the route that reaches the outfall must say so in its name:", survey.pipeRoute[0].name); process.exit(1); }
for (const t of ["in pipe", "Clear Lake outfall"])
  if (!survey.cardText.includes(t)) { console.log("FAIL: the Herman card's pipe route row lacks '" + t + "'"); process.exit(1); }
if (survey.pipeMarker !== 1) { console.log("FAIL: no pipe marker"); process.exit(1); }
if (!/discharging through the 24-in pipes/.test(survey.labelAtPipe) || !/surveyed stage/.test(survey.labelAtPipe))
  { console.log("FAIL: the slider label at the pipe stage: " + survey.labelAtPipe); process.exit(1); }
if (survey.pipeRouteShownAtPipe !== true)
  { console.log("FAIL: the pipe discharge route must show at the pipe stage"); process.exit(1); }
/* v15 §1 */
if (!survey.routes || survey.routes.rim !== false || survey.routes.rimSuppressed !== true)
  { console.log("FAIL: the surveyed Herman analysis must not trace a rim route:",
                JSON.stringify(survey.routes)); process.exit(1); }
if (survey.hermanRimRoutes !== 1)
  { console.log("FAIL: a second Herman rim overflow route was created:", survey.hermanRimRoutes); process.exit(1); }
if (errors.length !== errBeforeSurvey) {
  console.log("FAIL: page errors during the survey block:", errors.slice(errBeforeSurvey, errBeforeSurvey + 6)); process.exit(1);
}
});

/* ==================================================================== */
let errBeforeStorm, stormBase, FROG, stormDrop, stormOff, WLSHOT, stormWater, stormRest;   /* hoisted — v18 §3 */
await block("9s. storm drainage (docs/V12_STORM_SPEC.md §6)", async () => {
/* 9s. storm drainage (docs/V12_STORM_SPEC.md §6)                       */
/* ==================================================================== */
/* The network is read-only project data — 44 structures and 26 conduits out of
   EA's CAD, Jacobs' survey and the project engineer's identification of the
   south-road drain — and it changes exactly one thing about the raindrop: a run
   that reaches an inlet leaves the ground and reappears at the outlet. The
   numbers here are the kernel harness's (test/kernels.mjs section `storm`),
   which computes them from the payload's own conduit lengths. */
errBeforeStorm = errors.length;
stormBase = await page.evaluate(() => {
  const D = SBMM_DATA.storm_network;
  if (!D) return { err: "no storm_network payload" };
  const rowsOn = D.layers.filter(l => SBMM.layerState.isOn("framework", l.key));
  const g8 = D.nodes.find(n => n.id === "grate_8");
  const gj = D.conduits.find(c => c.id === "storm_main_lower");
  return {
    nodes: D.nodes.length, conduits: D.conduits.length,
    layers: D.layers.map(l => [l.key, l.count]),
    rowsOn: rowsOn.length,
    rowLabels: [...document.querySelectorAll("#projLayers .lyr")]
      /* v16 moves the trailing "(44)" out of .lbl into its own monospace span —
         same characters, same row text, so read the row */
      .filter(r => /^storm_/.test(r.dataset.lid)).map(r => r.textContent),
    subHeader: [...document.querySelectorAll("#projLayers .lsub")].some(h => /Storm drainage/.test(h.textContent)),
    glyphs: document.querySelectorAll(".stormnode").length,
    arrows: document.querySelectorAll(".stormarrow").length,
    nodePopup: SBMM.popups.forStorm(g8, null),
    conduitPopup: SBMM.popups.forStorm(null, gj),
    rim: SBMM.storm.rimFor("grate_8"),
    invert: SBMM.storm.rimFor("herman_pipe_n_inv"),
    enabled: SBMM.storm.enabled(),
    captureFt: SBMM.storm.captureFt(),
    /* conduitsFor is what the kernel is handed: inlets inside the box only */
    inBox: SBMM.storm.conduitsFor([6372400, 2127300, 6374000, 2128000]).map(c => c.id),
    /* the sunken pipe mouths (§2, ruling Sep 2026) */
    mouths: Object.keys(SBMM.storm.mouths()).sort(),
    mouthN: SBMM.storm.mouthOf("herman_pipe_n_inv"),
    mouthKernel: SBMM.storm.conduitsFor([6372000, 2127400, 6372100, 2127550])
      .filter(c => c.id === "herman_pipe_n")
      .map(c => [c.ix, c.iy, c.rim, c.mouth_moved_ft])[0],
    snap: SBMM.storm.snapPaths().rings.length + "/" + SBMM.storm.snapPaths().pts.length,
    dxfLayers: [...new Set(SBMM.storm.dxfEntities().map(e => e.layer))].sort(),
    cmd: (SBMM.cmd.find("STORM") || {}).n,
    menu: [...document.querySelectorAll("#waterMenu .ci")].some(c => c.dataset.a === "storm-toggle")
  };
});
console.log("storm network:", JSON.stringify({ nodes: stormBase.nodes, conduits: stormBase.conduits,
  layers: stormBase.layers, rowsOn: stormBase.rowsOn, subHeader: stormBase.subHeader,
  glyphs: stormBase.glyphs, arrows: stormBase.arrows, rim: stormBase.rim, invert: stormBase.invert,
  inBox: stormBase.inBox.length, snap: stormBase.snap, dxf: stormBase.dxfLayers, cmd: stormBase.cmd }));
if (stormBase.err) { console.log("FAIL:", stormBase.err); process.exit(1); }
if (stormBase.nodes !== 44 || stormBase.conduits !== 26)
  { console.log("FAIL: the payload is not 44 nodes / 26 conduits"); process.exit(1); }
if (stormBase.layers.map(l => l.join(":")).join(",") !== "storm_nodes:44,storm_cad:15,storm_inferred:11")
  { console.log("FAIL: the three layers' counts:", JSON.stringify(stormBase.layers)); process.exit(1); }
if (stormBase.rowsOn !== 3 || !stormBase.subHeader || stormBase.rowLabels.length !== 3)
  { console.log("FAIL: the three rows are not on under the Storm drainage sub-header",
                JSON.stringify(stormBase.rowLabels)); process.exit(1); }
for (const [key, n] of stormBase.layers)
  if (!stormBase.rowLabels.some(l => l.includes("(" + n + ")")))
    { console.log("FAIL: no row labelled with", key, "count", n); process.exit(1); }
if (stormBase.glyphs !== 44 || stormBase.arrows !== 26)
  { console.log("FAIL: structures/arrows drawn:", stormBase.glyphs, stormBase.arrows); process.exit(1); }
/* the popup: what it is, where it came from, and the two elevations — one of
   which is honestly "not surveyed" */
for (const t of ["Grate inlet", "STRM INLET SQUARE", "V-Base.dwg", "not surveyed", "Ground (lidar)"])
  if (!stormBase.nodePopup.includes(t))
    { console.log("FAIL: the grate popup lacks '" + t + "'"); process.exit(1); }
for (const t of ["Clear Lake outfall", "mark broken", "assumed working", "no capacity"])
  if (!stormBase.conduitPopup.includes(t))
    { console.log("FAIL: the conduit popup lacks '" + t + "'"); process.exit(1); }
if (Math.abs(stormBase.rim - 1397.33) > 0.05)
  { console.log("FAIL: grate 8's rim is the lidar ground, got", stormBase.rim); process.exit(1); }
if (Math.abs(stormBase.invert - 1341.57) > 1e-9)
  { console.log("FAIL: a surveyed invert must win over the ground, got", stormBase.invert); process.exit(1); }
/* A SUNKEN INLET: the lidar is Jan 2024 and the sandbag wall came after it, so
   the cell at the surveyed invert point reads the top of the sandbags. The
   analysis enters the pipe at the nearest cell the lidar DOES see at or below
   the invert, within 30 ft; the rim stays the survey's. */
console.log("sunken mouths:", stormBase.mouths.join(","), "| N ->", JSON.stringify(stormBase.mouthN),
            "| to the kernel:", JSON.stringify(stormBase.mouthKernel));
if (stormBase.mouths.join(",") !== "herman_pipe_n_inv,herman_pipe_s_inv")
  { console.log("FAIL: exactly the two surveyed pipe ends are sunken inlets"); process.exit(1); }
if (!stormBase.mouthN || Math.abs(stormBase.mouthN.moved - 25.6) > 0.2
    || Math.abs(stormBase.mouthN.ground - 1344.66) > 0.02
    || !(stormBase.mouthN.z <= 1341.57 + 1e-9) || stormBase.mouthN.moved > 30)
  { console.log("FAIL: the North pipe's mouth:", JSON.stringify(stormBase.mouthN)); process.exit(1); }
if (!stormBase.mouthKernel || stormBase.mouthKernel[0] !== 6372065 || stormBase.mouthKernel[1] !== 2127496
    || stormBase.mouthKernel[2] !== 1341.57 || Math.abs(stormBase.mouthKernel[3] - 25.6) > 0.2)
  { console.log("FAIL: conduitsFor must hand the kernel the mouth with the surveyed rim:",
                JSON.stringify(stormBase.mouthKernel)); process.exit(1); }
if (!stormBase.enabled || stormBase.captureFt !== 3)
  { console.log("FAIL: the drains default on with a 3-ft capture"); process.exit(1); }
if (!stormBase.inBox.includes("road_drain_8_9") || stormBase.inBox.includes("storm_main_lower"))
  { console.log("FAIL: conduitsFor must select on the INLET's position:", stormBase.inBox); process.exit(1); }
if (stormBase.dxfLayers.join(",") !== "STORM-CONDUIT,STORM-INFERRED,STORM-STRUCT")
  { console.log("FAIL: the DXF layers:", stormBase.dxfLayers); process.exit(1); }
if (stormBase.cmd !== "STORM" || !stormBase.menu)
  { console.log("FAIL: STORM is not a command / not in the Water menu"); process.exit(1); }

/* --- the raindrop with and without the network ----------------------- */
/* Frog Pond's low — the EAST pond, Spot 5 (EA's geodatabase names, confirmed
   by the engineer). With the drains on it takes the culvert under the paved
   road into the west pond (Green Pond), which overflows through the FES on its
   west shore, piped
   to the Spot 8 grate and down the road drain to the Clear Lake outfall —
   never entering the impoundment; with them off it spills north-east off the
   survey, which is what the bare terrain does. */
FROG = [6374418, 2127912];
stormDrop = await page.evaluate(async (P) => {
  const jobs0 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  const f = await SBMM.water.dropAt(P[0], P[1], { name: "Storm test drop" });
  if (!f) return { err: "dropAt returned nothing" };
  const p = f.props;
  const card = f.card ? f.card.textContent : "";
  /* the session round trip: the legs come back and nothing is recomputed */
  const spec = SBMM.store.serialize().features.find(x => x.name === "Storm test drop");
  const j0 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  SBMM.store.remove(f);
  const nf = SBMM.tools.rebuildFeature(spec);
  const j1 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  const out = {
    legs: (p.legs || []).map(l => l.id), pipe: p.pipe_ft, total: p.total_ft,
    len: p.length_ft, storm: p.storm, reason: p.end.reason, end: [p.end.x, p.end.y],
    outfall: !!p.outfall,
    ponds: p.ponds.length, via: (p.ponds.find(q => q.via) || {}).via || null,
    vias: p.ponds.filter(q => q.via).map(q => q.via),
    card, jobs0,
    rebuilt: { legs: (nf.props.legs || []).length, pipe: nf.props.pipe_ft,
               drawn: SBMM.map.hasLayer(nf.layer), sub: nf.layer.getLayers().length },
    jobs: j1 - j0,
    pipeLabels: document.querySelectorAll(".flowpipe").length
  };
  SBMM.store.remove(nf);
  return out;
}, FROG);
console.log("storm raindrop:", JSON.stringify({ legs: stormDrop.legs, pipe: stormDrop.pipe,
  total: stormDrop.total, len: stormDrop.len, reason: stormDrop.reason, end: stormDrop.end,
  ponds: stormDrop.ponds, via: stormDrop.via, rebuilt: stormDrop.rebuilt, jobs: stormDrop.jobs,
  pipeLabels: stormDrop.pipeLabels }));
if (stormDrop.err) { console.log("FAIL:", stormDrop.err); process.exit(1); }
if (stormDrop.legs.join(",") !== "pond_culvert,green_outlet,road_drain_8_9,road_drain_9_10,road_drain_10_11,road_drain_11_12,road_drain_12_13,road_drain_13_14,road_drain_14_15,road_drain_15_branch,branch,storm_main_lower")
  { console.log("FAIL: the Frog Pond chain is wrong, got", stormDrop.legs); process.exit(1); }
if (Math.abs(stormDrop.pipe - 2969.4) > 0.5)
  { console.log("FAIL: pipe_ft", stormDrop.pipe, "vs 2969.4"); process.exit(1); }
if (!stormDrop.outfall)
  { console.log("FAIL: the Frog Pond drop should reach the Clear Lake outfall"); process.exit(1); }
if (Math.abs(stormDrop.total - (stormDrop.len + stormDrop.pipe)) > 0.2)
  { console.log("FAIL: total_ft must be overland + pipe"); process.exit(1); }
if (stormDrop.vias.join(",") !== "green_outlet")
  { console.log("FAIL: the west pond must drain through its FES (the drop sits on the culvert inlet, so the east pond forms no pond), got", stormDrop.vias); process.exit(1); }
if (wdist(stormDrop.end, [6371177, 2127474]) > 5)
  { console.log("FAIL: the drop should end in Clear Lake, got", stormDrop.end); process.exit(1); }
for (const t of ["In pipes", "Total", "Storm drains", "drains to"])
  if (!stormDrop.card.includes(t)) { console.log("FAIL: the raindrop card lacks '" + t + "'"); process.exit(1); }
if (stormDrop.rebuilt.legs !== stormDrop.legs.length || !stormDrop.rebuilt.drawn || stormDrop.jobs !== 0)
  { console.log("FAIL: a flow with legs did not survive a session round trip without recomputing",
                JSON.stringify(stormDrop.rebuilt), stormDrop.jobs); process.exit(1); }
if (!stormDrop.pipeLabels) { console.log("FAIL: the conduit legs are not drawn"); process.exit(1); }

/* STORM off: the same drop, ground only */
stormOff = await page.evaluate(async (P) => {
  SBMM.cmd.run("STORM");
  const off = !SBMM.storm.enabled();
  const f = await SBMM.water.dropAt(P[0], P[1], { name: "Storm off drop" });
  const p = f.props;
  const out = { off, legs: (p.legs || []).length, pipe: p.pipe_ft, storm: p.storm,
                len: p.length_ft, end: [p.end.x, p.end.y], card: f.card ? f.card.textContent : "",
                empty: SBMM.storm.conduitsFor([6372400, 2127300, 6374000, 2128000]).length };
  SBMM.store.remove(f);
  SBMM.cmd.run("STORM");
  out.backOn = SBMM.storm.enabled();
  return out;
}, FROG);
console.log("storm off:", JSON.stringify(stormOff.end), "legs", stormOff.legs, "len", stormOff.len,
            "| conduitsFor while off:", stormOff.empty, "| back on:", stormOff.backOn);
if (!stormOff.off || stormOff.backOn !== true)
  { console.log("FAIL: STORM did not toggle the master switch both ways"); process.exit(1); }
if (stormOff.legs !== 0 || stormOff.pipe !== 0 || stormOff.storm !== false || stormOff.empty !== 0)
  { console.log("FAIL: with the drains off nothing may reach the kernel"); process.exit(1); }
if (wdist(stormOff.end, [6375216, 2128916]) > 5)
  { console.log("FAIL: with the drains off the drop leaves the survey north-east, got", stormOff.end); process.exit(1); }
if (!stormOff.card.includes("ground only"))
  { console.log("FAIL: the card must say the drains were off"); process.exit(1); }

/* --- the sunken inlet: a drop inside the Herman Impoundment ---------- */
/* The ruling's own case. The surveyed water-level shot of Aug 2026 sits in the
   impoundment; with the network on the pond stops at the lower of the two
   surveyed inverts and leaves through that pipe, EA's storm main and the
   outfall — which is what the overtopping card's "First discharge" row has said
   since v10 §10 and what the raindrop could not say until the mouths moved. */
WLSHOT = [6372119.56, 2127446.20];
stormWater = await page.evaluate(async (P) => {
  const f = await SBMM.water.dropAt(P[0], P[1], { name: "Herman water drop" });
  if (!f) return { err: "dropAt returned nothing" };
  const p = f.props;
  const pond = p.ponds.find(q => q.via) || null;
  const out = {
    legs: (p.legs || []).map(l => l.id), pipe: p.pipe_ft, len: p.length_ft,
    outfall: !!p.outfall, end: [p.end.x, p.end.y],
    pond: pond ? { level: pond.level, via: pond.via, depth: pond.depth_ft } : null,
    card: f.card ? f.card.textContent : "",
    popup: SBMM.popups.forFeature(f)
  };
  SBMM.store.remove(f);
  /* the same drop with the drains off fills to the lidar rim instead */
  SBMM.cmd.run("STORM");
  const g = await SBMM.water.dropAt(P[0], P[1], { name: "Herman water drop (off)" });
  const q = g.props;
  const big = q.ponds.filter(r => r.cells > 200000 && r.depth_ft > 5)[0] || null;
  out.offLevel = big ? big.level : null;
  out.offLen = q.length_ft;
  SBMM.store.remove(g);
  SBMM.cmd.run("STORM");
  out.backOn = SBMM.storm.enabled();
  /* what the overtopping card says the first discharge is — the two tools now
     agree about the impoundment, which is the whole point of the ruling */
  out.facts = SBMM.water.surveyFacts(
    SBMM_DATA.design_gis.features.find(f2 => f2.properties.name === "Herman Impoundment")
      .geometry.coordinates[0]);
  return out;
}, WLSHOT);
console.log("sunken inlet drop:", JSON.stringify({ legs: stormWater.legs, pipe: stormWater.pipe,
  len: stormWater.len, pond: stormWater.pond, end: stormWater.end, offLevel: stormWater.offLevel,
  offLen: stormWater.offLen, firstDischarge: stormWater.facts && stormWater.facts.pipeInvert }));
if (stormWater.err) { console.log("FAIL:", stormWater.err); process.exit(1); }
if (!stormWater.pond || !/^herman_pipe_[ns]$/.test(stormWater.pond.via))
  { console.log("FAIL: the impoundment must drain through a surveyed pipe, got",
                JSON.stringify(stormWater.pond)); process.exit(1); }
if (Math.abs(stormWater.pond.level - 1341.5) > 0.05)
  { console.log("FAIL: the pond must stop at the lower surveyed invert, got", stormWater.pond.level); process.exit(1); }
if (stormWater.legs.join(",") !== stormWater.pond.via + ",pipe_to_main,storm_main_upper,storm_main_lower")
  { console.log("FAIL: the chain out of the impoundment:", stormWater.legs); process.exit(1); }
if (Math.abs(stormWater.pipe - 813.3) > 1 || !stormWater.outfall)
  { console.log("FAIL: pipe_ft", stormWater.pipe, "vs 813.3, outfall", stormWater.outfall); process.exit(1); }
if (wdist(stormWater.end, [6371177, 2127474]) > 5)
  { console.log("FAIL: the drop should end in Clear Lake, got", stormWater.end); process.exit(1); }
if (Math.abs(stormWater.offLevel - 1343.84) > 0.02 || stormWater.backOn !== true)
  { console.log("FAIL: with the drains off the impoundment fills to the lidar rim, got",
                stormWater.offLevel); process.exit(1); }
/* the card names the pipe and says the inlet cell moved */
for (const t of ["drains to", "24 in corrugated HDPE", "inlet cell moved"])
  if (!stormWater.card.includes(t))
    { console.log("FAIL: the raindrop card lacks '" + t + "'"); process.exit(1); }
{
  /* one line: the raindrop and the overtopping card now agree about the
     impoundment's first discharge, to the difference between the surveyed
     invert and the lidar cell the analysis enters the pipe at */
  const d = Math.abs(stormWater.pond.level - stormWater.facts.pipeInvert);
  console.log(`the two tools agree about Herman: the overtopping card's first discharge is `
    + `${stormWater.facts.pipeInvert} ft (surveyed pipe invert) and the raindrop ponds to `
    + `${stormWater.pond.level} ft before taking ${stormWater.pond.via} — ${d.toFixed(2)} ft apart; `
    + `with the drains off the same drop fills to ${stormWater.offLevel} ft and spills over the rim `
    + `(${(stormWater.offLevel - stormWater.pond.level).toFixed(2)} ft higher).`);
  if (d > 0.1) { console.log("FAIL: the raindrop and the overtopping card disagree by", d); process.exit(1); }
}

/* --- a broken conduit, 3D, and the exports --------------------------- */
stormRest = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  /* a broken conduit is not passed to the kernel at all */
  SBMM.storm.setStatus("pond_culvert", "broken");
  const brokenOut = SBMM.storm.conduitsFor([6374000, 2127700, 6374800, 2128100]).length;
  const persisted = JSON.parse(localStorage.getItem("sbmm.storm.v1") || "{}");
  SBMM.storm.setStatus("pond_culvert", "assumed_working");
  const backOut = SBMM.storm.conduitsFor([6374000, 2127700, 6374800, 2128100]).length;
  /* 3D: the conduits and the structures reach the scene */
  const wasOpen = SBMM.viewer3d.isOpen();
  if (!wasOpen) { await SBMM.viewer3d.toggle(); await wait(1400); }
  SBMM.viewer3d.refreshOverlays();
  await wait(600);
  const withNet = SBMM.pick3d.registered().filter(r => r.kind === "gis").length;
  SBMM.layerState.set("framework", "storm_cad", { on: false });
  SBMM.layerState.set("framework", "storm_inferred", { on: false });
  SBMM.viewer3d.refreshOverlays();
  await wait(600);
  const without = SBMM.pick3d.registered().filter(r => r.kind === "gis").length;
  SBMM.layerState.set("framework", "storm_cad", { on: true });
  SBMM.layerState.set("framework", "storm_inferred", { on: true });
  SBMM.viewer3d.refreshOverlays();
  await wait(600);
  const back = SBMM.pick3d.registered().filter(r => r.kind === "gis").length;
  if (!wasOpen) { await SBMM.viewer3d.toggle(); await wait(500); }
  /* the exports */
  const fc = SBMM.io.collection("sp");
  const sf = fc.features.filter(f => /^storm_/.test((f.properties || {}).layer || ""));
  const dxf = SBMM.dxf.buildDXF();
  return {
    brokenOut, backOut, persistedBroken: (persisted.status || {}).pond_culvert || null,
    withNet, without, back,
    geo: sf.length, geoPts: sf.filter(f => f.geometry.type === "Point").length,
    geoSource: sf.every(f => !!f.properties.source),
    dxf: ["STORM-STRUCT", "STORM-CONDUIT", "STORM-INFERRED"].every(l => dxf.includes(l))
  };
});
console.log("storm broken/3D/export:", JSON.stringify(stormRest));
if (stormRest.brokenOut !== stormRest.backOut - 1 || stormRest.persistedBroken !== "broken")
  { console.log("FAIL: a broken conduit must leave the kernel list and persist"); process.exit(1); }
if (stormRest.withNet - stormRest.without !== 26 || stormRest.back !== stormRest.withNet)
  { console.log("FAIL: the 26 conduits are not in the 3D pick registry",
                stormRest.withNet, stormRest.without, stormRest.back); process.exit(1); }
if (stormRest.geo !== 70 || stormRest.geoPts !== 44 || !stormRest.geoSource)
  { console.log("FAIL: the GeoJSON must carry 44 structures + 26 conduits, each with a source",
                JSON.stringify(stormRest)); process.exit(1); }
if (!stormRest.dxf) { console.log("FAIL: the DXF is missing the STORM-* layers"); process.exit(1); }
if (errors.length !== errBeforeStorm) {
  console.log("FAIL: page errors during the storm block:",
              errors.slice(errBeforeStorm, errBeforeStorm + 6)); process.exit(1);
}
});

/* ==================================================================== */
let errBeforeW13, w13, w13d;   /* hoisted — v18 §3 */
await block("9t. overtop + conduits", async () => {
/* 9t. overtop + conduits, and water in 3D (docs/V13_WATER3D_SPEC.md)    */
/* ==================================================================== */
/* Two things. (1) The overtopping analysis now honours the storm network the
   way the raindrop already did: the FIRST discharge is the first inlet whose
   rim the rising water reaches, reported BESIDE the rim spill and never in
   place of it, with its own route. Frog Pond is the case the user reported —
   the natural rim spill at 1,416.04 ft is ten feet from a culvert inlet 0.30 ft
   lower, so without this the overflow ran north over the ground instead of into
   Green Pond. (2) Water moves in 3D: a particle stream on every visible flow,
   and the stage surface at the slider's level.
   The numbers are test/kernels.mjs section `water3d`, which computes them from
   the same payload the app reads. */
errBeforeW13 = errors.length;
w13 = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ringOf = nm => SBMM_DATA.design_gis.features.find(
    f => f.properties.layer === "water" && f.properties.name === nm).geometry.coordinates[0];
  const out = {};
  const run = async (nm) => {
    SBMM.water.clearOvertop();
    await wait(150);
    const R = await SBMM.water.overtop({ ring: ringOf(nm).map(q => [q[0], q[1]]), name: nm });
    if (!R) return null;
    await wait(250);
    const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
    const cr = SBMM.store.features.filter(f => f.type === "flow" && /first-discharge route/.test(f.name)).pop();
    const rr = SBMM.store.features.filter(f => f.type === "flow"
      && f.name.indexOf(nm) === 0 && /overflow route/.test(f.name)).pop();
    return {
      spill: R.primary.level, spillAt: [R.primary.x, R.primary.y],
      cs: R.conduitSpill && { id: R.conduitSpill.id, level: R.conduitSpill.level,
                              at: [R.conduitSpill.x, R.conduitSpill.y] },
      fbCond: R.freeboardConduit_ft, stageRows: R.stage.length,
      viaRows: R.stage.filter(s => s.via).map(s => [s.level, s.via]),
      card: card ? card.textContent : "",
      markerC: document.querySelectorAll(".spillmk.conduit").length,
      route: cr ? { name: cr.name, legs: (cr.props.legs || []).map(l => l.id),
                    end: [cr.props.end.x, cr.props.end.y], reason: cr.props.end.reason,
                    pipe: cr.props.pipe_ft, outfall: !!cr.props.outfall, visible: cr.visible } : null,
      rim: rr ? { name: rr.name, len: rr.props.length_ft, end: [rr.props.end.x, rr.props.end.y],
                  reason: rr.props.end.reason, visible: rr.visible } : null,
      /* v15 §1 — which routes this analysis owns, read from the module rather
         than guessed from feature names other analyses also match */
      routes: SBMM.water.routes(),
      whatIfBtn: !!(card && card.querySelector('[data-w="rimwhatif"]'))
    };
  };
  out.frog = await run("Frog Pond");
  /* v15 §1: the rim overflow is not traced when a conduit carries the water
     first. The button traces it on demand, as a what-if, dashed and muted, and
     the analysis takes it away with it. */
  {
    const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
    const btn = card.querySelector('[data-w="rimwhatif"]');
    out.wiLabel0 = btn ? btn.textContent : "";
    btn.click();
    for (let i = 0; i < 60 && !SBMM.water.routes().rimWhatIf; i++) await wait(500);
    await wait(400);
    const wf = SBMM.store.features.filter(f => f.type === "flow" && /what-if/.test(f.name)).pop();
    out.whatIf = wf ? {
      name: wf.name, whatif: !!wf.props.whatif, len: wf.props.length_ft,
      end: [wf.props.end.x, wf.props.end.y], reason: wf.props.end.reason, visible: wf.visible,
      dashed: !!(wf.layer && wf.layer.getLayers && wf.layer.getLayers()
        .some(l => l.options && l.options.dashArray === "7 6")),
      /* the muted slate, not the water blue */
      color: (wf.layer && wf.layer.getLayers ? (wf.layer.getLayers()
        .find(l => l.options && l.options.dashArray === "7 6") || { options: {} }).options.color : null)
    } : null;
    out.routesWithWhatIf = SBMM.water.routes();
    out.wiLabel1 = btn.textContent;
  }
  /* the slider: below the conduit level the route does not show, at it it does;
     above the rim the label says the drains are assumed to carry it */
  {
    const R = SBMM.water.active();
    const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
    const sl = card.querySelector("#wsRange");
    const cs = R.conduitSpill;
    const iC = R.stage.findIndex(s => Math.abs(s.level - cs.level) < 1e-6);
    const vis = () => {
      const cr = SBMM.store.features.filter(f => f.type === "flow" && /first-discharge route/.test(f.name)).pop();
      const rr = SBMM.store.features.filter(f => f.type === "flow" && /Frog Pond overflow route/.test(f.name)).pop();
      return { c: cr ? cr.visible : null, r: rr ? rr.visible : null,
               rim: SBMM.water.routes().rim,
               label: (card.querySelector(".wslabel") || {}).textContent || "" };
    };
    const set = async i => { sl.value = String(i); sl.dispatchEvent(new Event("input")); await wait(120); };
    out.sliderIdxConduit = iC;
    await set(Math.max(0, iC - 1)); out.below = vis();
    await set(iC); out.atConduit = vis();
    await set(R.stage.length - 1); out.atTop = vis();
    await set(iC); await wait(60);
  }
  /* closing an analysis takes its what-if with it (v15 §1) */
  out.green = await run("Green Pond");
  out.whatIfAfterClear = SBMM.store.features.filter(f => /what-if/.test(f.name)).length;
  /* Herman keeps its §10 card: the conduit spill IS the surveyed pipe, so the
     pipe row gains the via and nothing is traced or listed twice */
  SBMM.water.clearOvertop();
  await wait(150);
  const HR = await SBMM.water.overtop({ ring: ringOf("Herman Impoundment").map(q => [q[0], q[1]]),
                                        name: "Herman Impoundment" });
  await wait(300);
  const hcard = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
  out.herman = {
    spill: HR.primary.level, freeboard: HR.freeboard_ft, stageRows: HR.stage.length,
    cs: HR.conduitSpill && { id: HR.conduitSpill.id, level: HR.conduitSpill.level,
                             stageLevel: HR.conduitSpill.stageLevel },
    viaRows: HR.stage.filter(s => s.via).map(s => [s.level, s.via]),
    card: hcard ? hcard.textContent : "",
    markerC: document.querySelectorAll(".spillmk.conduit").length,
    extraRoutes: SBMM.store.features.filter(f => f.type === "flow"
      && /^Herman Impoundment first-discharge route/.test(f.name)).length,
    routes: SBMM.water.routes(),
    whatIfBtn: !!(hcard && hcard.querySelector('[data-w="rimwhatif"]'))
  };
  /* and the same button on Herman: the surveyed pipes are the overflow, the rim
     route is the what-if */
  {
    const btn = hcard.querySelector('[data-w="rimwhatif"]');
    if (btn) {
      btn.click();
      for (let i = 0; i < 60 && !SBMM.water.routes().rimWhatIf; i++) await wait(500);
      await wait(400);
    }
    const wf = SBMM.store.features.filter(f => f.type === "flow"
      && /^Herman Impoundment rim overflow/.test(f.name)).pop();
    out.hermanWhatIf = wf ? { name: wf.name, whatif: !!wf.props.whatif,
                              len: wf.props.length_ft, reason: wf.props.end.reason } : null;
    out.hermanRoutes = SBMM.water.routes();
  }
  return out;
});
console.log("v13 Frog Pond:", JSON.stringify({ spill: w13.frog.spill, cs: w13.frog.cs,
  fbCond: +w13.frog.fbCond.toFixed(2), viaRows: w13.frog.viaRows, markerC: w13.frog.markerC,
  route: w13.frog.route, rim: w13.frog.rim && { len: w13.frog.rim.len, end: w13.frog.rim.end } }));
console.log("v13 slider:", JSON.stringify({ idx: w13.sliderIdxConduit, below: w13.below,
  atConduit: w13.atConduit, atTop: w13.atTop }));
console.log("v13 Green Pond:", JSON.stringify({ spill: w13.green.spill, cs: w13.green.cs,
  route: w13.green.route && { legs: w13.green.route.legs, end: w13.green.route.end } }));
console.log("v13 Herman:", JSON.stringify({ spill: w13.herman.spill, freeboard: w13.herman.freeboard,
  cs: w13.herman.cs, viaRows: w13.herman.viaRows, markerC: w13.herman.markerC,
  extraRoutes: w13.herman.extraRoutes }));

/* --- Frog Pond ------------------------------------------------------- */
if (!w13.frog || !w13.frog.cs) { console.log("FAIL: Frog Pond has no conduit spill"); process.exit(1); }
if (w13.frog.cs.id !== "pond_culvert" || Math.abs(w13.frog.cs.level - 1415.74) > 0.05)
  { console.log("FAIL: Frog Pond's first discharge", JSON.stringify(w13.frog.cs)); process.exit(1); }
if (Math.abs(w13.frog.spill - 1416.04) > 0.05 || wdist(w13.frog.spillAt, [6374410, 2127918]) > 15)
  { console.log("FAIL: Frog Pond's rim spill moved", w13.frog.spill, w13.frog.spillAt); process.exit(1); }
for (const t of ["First discharge", "through pond culvert", "1,415.74", "pond_culvert",
                 "First-discharge route", "Rim spill", "1,416.04"])
  if (!w13.frog.card.includes(t)) { console.log("FAIL: the Frog Pond card lacks '" + t + "'"); process.exit(1); }
if (w13.frog.markerC !== 1) { console.log("FAIL: no 'C' marker at the conduit spill"); process.exit(1); }
if (!w13.frog.route) { console.log("FAIL: no first-discharge route on Frog Pond"); process.exit(1); }
if (w13.frog.route.legs[0] !== "pond_culvert")
  { console.log("FAIL: the first-discharge route must start in the culvert:", w13.frog.route.legs); process.exit(1); }
if (w13.frog.route.legs[w13.frog.route.legs.length - 1] !== "storm_main_lower" || !w13.frog.route.outfall)
  { console.log("FAIL: the first-discharge route must reach the outfall:", w13.frog.route.legs); process.exit(1); }
if (!w13.frog.route.legs.includes("green_outlet"))
  { console.log("FAIL: the route must leave Green Pond through its FES:", w13.frog.route.legs); process.exit(1); }
if (w13.frog.route.reason !== "nodata" || wdist(w13.frog.route.end, [6371177, 2127474]) > 5)
  { console.log("FAIL: the first-discharge route ends", w13.frog.route.reason, w13.frog.route.end); process.exit(1); }
/* the defect, stated as the user stated it: it does NOT go north */
if (w13.frog.route.end[1] >= 2128000)
  { console.log("FAIL: the first-discharge route still runs north:", w13.frog.route.end); process.exit(1); }
/* v15 §1: the rim route is NOT traced by default when a conduit spills lower */
if (w13.frog.routes.rim !== false || w13.frog.routes.rimSuppressed !== true)
  { console.log("FAIL: Frog Pond's rim route must not be traced by default:",
                JSON.stringify(w13.frog.routes)); process.exit(1); }
if (w13.frog.rim)
  { console.log("FAIL: a rim 'overflow route' feature was created anyway:", w13.frog.rim.name); process.exit(1); }
if (!w13.frog.whatIfBtn) { console.log("FAIL: no 'trace the rim overflow' button on the card"); process.exit(1); }
for (const t of ["not traced; the drains are assumed to handle it",
                 "not traced — the drains are assumed to carry it",
                 "+0.30 ft above pond culvert",
                 "→ Green Pond (fills to 1,394.50) → green outlet"])
  if (!w13.frog.card.includes(t)) { console.log("FAIL: the Frog Pond card lacks '" + t + "'"); process.exit(1); }
if (!w13.whatIf || !w13.whatIf.whatif || !w13.whatIf.dashed)
  { console.log("FAIL: the what-if rim overflow was not traced dashed:", JSON.stringify(w13.whatIf)); process.exit(1); }
if (w13.whatIf.color !== "#93A6B3")
  { console.log("FAIL: the what-if route must be drawn in the muted colour, got", w13.whatIf.color); process.exit(1); }
if (!/what-if: pond culvert blocked/.test(w13.whatIf.name))
  { console.log("FAIL: the what-if route must say what it assumes:", w13.whatIf.name); process.exit(1); }
if (w13.routesWithWhatIf.rimWhatIf !== true)
  { console.log("FAIL: the analysis does not own its what-if route"); process.exit(1); }
if (!/trace the rim overflow/.test(w13.wiLabel0) || !/hide the rim overflow/.test(w13.wiLabel1))
  { console.log("FAIL: the what-if button does not toggle its label:", w13.wiLabel0, "|", w13.wiLabel1); process.exit(1); }
if (w13.whatIfAfterClear !== 0)
  { console.log("FAIL: closing the analysis must take its what-if with it, left", w13.whatIfAfterClear); process.exit(1); }
if (w13.frog.viaRows.length !== 1 || w13.frog.viaRows[0][1] !== "pond_culvert")
  { console.log("FAIL: exactly one stage row carries the via:", JSON.stringify(w13.frog.viaRows)); process.exit(1); }

/* --- the slider ------------------------------------------------------ */
/* v15 §1: `r` is the rim OVERFLOW ROUTE feature, and there is no longer one to
   find — the conduit spills below the rim, so the rim route is not traced at
   all (`rim: false`) and only the what-if button can produce one. */
if (w13.below.c !== false || w13.below.rim !== false || w13.below.r !== null)
  { console.log("FAIL: below the conduit level nothing may show:", JSON.stringify(w13.below)); process.exit(1); }
if (w13.atConduit.c !== true || w13.atConduit.rim !== false || w13.atConduit.r !== null)
  { console.log("FAIL: at the conduit level only the conduit route shows:", JSON.stringify(w13.atConduit)); process.exit(1); }
if (w13.atTop.c !== true || w13.atTop.rim !== false)
  { console.log("FAIL: above the rim the conduit route shows and no rim route is traced:",
                JSON.stringify(w13.atTop)); process.exit(1); }
if (!/the drains are assumed to carry it/.test(w13.atTop.label))
  { console.log("FAIL: the slider label above the rim:", w13.atTop.label); process.exit(1); }
if (!/discharging through pond culvert/.test(w13.atConduit.label))
  { console.log("FAIL: the slider label at the conduit level:", w13.atConduit.label); process.exit(1); }

/* --- Green Pond ------------------------------------------------------ */
if (!w13.green.cs || w13.green.cs.id !== "green_outlet" || Math.abs(w13.green.cs.level - 1394.48) > 0.05)
  { console.log("FAIL: Green Pond's first discharge", JSON.stringify(w13.green.cs)); process.exit(1); }
if (Math.abs(w13.green.spill - 1399.14) > 0.05)
  { console.log("FAIL: Green Pond's rim spill moved", w13.green.spill); process.exit(1); }
if (!w13.green.route || w13.green.route.legs[0] !== "green_outlet" || !w13.green.route.outfall)
  { console.log("FAIL: Green Pond's first-discharge route", JSON.stringify(w13.green.route)); process.exit(1); }

/* --- Herman: unchanged, plus the via --------------------------------- */
if (Math.abs(w13.herman.spill - 1343.84) > 0.05 || Math.abs(w13.herman.freeboard - 7.39) > 0.05)
  { console.log("FAIL: Herman's rim spill / freeboard moved", w13.herman.spill, w13.herman.freeboard); process.exit(1); }
if (!w13.herman.cs || w13.herman.cs.id !== "herman_pipe_s"
    || Math.abs(w13.herman.cs.stageLevel - 1341.55) > 1e-6)
  { console.log("FAIL: Herman's conduit spill", JSON.stringify(w13.herman.cs)); process.exit(1); }
if (w13.herman.viaRows.length !== 1 || Math.abs(w13.herman.viaRows[0][0] - 1341.55) > 1e-6
    || w13.herman.viaRows[0][1] !== "herman_pipe_s")
  { console.log("FAIL: the via must sit on the surveyed 1341.55 row:", JSON.stringify(w13.herman.viaRows)); process.exit(1); }
if (w13.herman.stageRows !== 44)
  { console.log("FAIL: Herman's stage table gained a duplicate row:", w13.herman.stageRows); process.exit(1); }
if (w13.herman.markerC !== 0 || w13.herman.extraRoutes !== 0)
  { console.log("FAIL: Herman must not get a second marker or a second route"); process.exit(1); }
for (const t of ["24-in HDPE pipes", "via herman_pipe_s", "Rim spill"])
  if (!w13.herman.card.includes(t)) { console.log("FAIL: the Herman card lacks '" + t + "'"); process.exit(1); }
/* v15 §1 on Herman: the surveyed pipes are the overflow, the rim route is the
   what-if, and every §10 number above is unchanged */
if (w13.herman.routes.rim !== false || w13.herman.routes.pipe !== true
    || w13.herman.routes.rimSuppressed !== true || !w13.herman.whatIfBtn)
  { console.log("FAIL: Herman's default routes:", JSON.stringify(w13.herman.routes)); process.exit(1); }
if (!w13.herman.card.includes("not traced; the drains are assumed to handle it"))
  { console.log("FAIL: the Herman card does not say the rim spill is not traced"); process.exit(1); }
if (!w13.hermanWhatIf || !w13.hermanWhatIf.whatif || !/24-in pipes blocked/.test(w13.hermanWhatIf.name))
  { console.log("FAIL: Herman's what-if rim overflow:", JSON.stringify(w13.hermanWhatIf)); process.exit(1); }
if (w13.hermanRoutes.rimWhatIf !== true)
  { console.log("FAIL: Herman's what-if is not owned by the analysis"); process.exit(1); }

/* --- water in 3D ----------------------------------------------------- */
/* The particles: precomputed per rebuild, advanced in the render loop, and the
   loop asks for frames ONLY while a visible flow is on screen — which is why
   test/perf.mjs's idle-render count is still 0. */
w13d = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  const wasOpen = SBMM.viewer3d.isOpen();
  if (!wasOpen) { await SBMM.viewer3d.toggle(); await wait(1600); }
  SBMM.viewer3d.animateWater(true);
  /* one visible flow: the first-discharge route, which has conduit legs too */
  const flows = SBMM.store.features.filter(f => f.type === "flow");
  const keep = flows.filter(f => /first-discharge route/.test(f.name)).pop() || flows[0];
  for (const f of flows) SBMM.store.setVisible(f, f === keep);
  SBMM.viewer3d.refreshOverlays();
  await wait(600);
  const st = SBMM.viewer3d.stats();
  out.anim = st.waterAnim;
  out.particles = st.waterParticles;
  out.animOn = st.waterAnimOn;
  out.picked = SBMM.pick3d.registered().filter(r => r.kind === "feature").length;
  /* four seconds, not one: a render under software GL takes about half a second,
     so the loop asking for ~30 fps is served at two or three. What is asserted is
     that it keeps asking and the water keeps moving, against an idle view that
     issues none at all (the same measurement block 9e makes). */
  const a = SBMM.viewer3d.stats();
  await wait(4000);
  const a2 = SBMM.viewer3d.stats();
  out.rendersWithFlow = a2.renderCount - a.renderCount;
  out.animAdvance = +(a2.waterAnimT - a.waterAnimT).toFixed(2);
  out.moved = a.waterSample && a2.waterSample
    ? +Math.hypot(a2.waterSample[0] - a.waterSample[0], a2.waterSample[1] - a.waterSample[1]).toFixed(2)
    : null;
  /* the toggle off stops the frames */
  SBMM.viewer3d.animateWater(false);
  await wait(400);
  const b = SBMM.viewer3d.stats();
  await wait(3000);
  const b2 = SBMM.viewer3d.stats();
  out.rendersToggledOff = b2.renderCount - b.renderCount;
  out.frozen = +(b2.waterAnimT - b.waterAnimT).toFixed(2);
  SBMM.viewer3d.animateWater(true);
  await wait(150);
  /* the stage surface follows the slider */
  const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
  const sl = card && card.querySelector("#wsRange");
  const R = SBMM.water.active();
  out.stageAtDefault = SBMM.viewer3d.stats().waterStage;
  out.zmid = SBMM.viewer3d.stats().zmid;
  if (sl) {
    sl.value = "0"; sl.dispatchEvent(new Event("input"));
    await wait(300);
    out.stageAtZero = SBMM.viewer3d.stats().waterStage;
    out.stageLevelZero = R.stage[0].level;
  }
  /* no visible flow at all: no particles, and no renders */
  for (const f of SBMM.store.features) if (f.type === "flow") SBMM.store.setVisible(f, false);
  SBMM.viewer3d.refreshOverlays();
  await wait(500);
  out.animAfterHide = SBMM.viewer3d.stats().waterAnim.length;
  await wait(700);
  const c = SBMM.viewer3d.stats().renderCount;
  await wait(3000);
  out.rendersNoFlow = SBMM.viewer3d.stats().renderCount - c;
  /* closing the analysis clears the stage surface */
  SBMM.water.clearOvertop();
  await wait(400);
  out.stageAfterClear = SBMM.viewer3d.stats().waterStage;
  for (const f of SBMM.store.features) if (f.type === "flow") SBMM.store.setVisible(f, true);
  SBMM.viewer3d.refreshOverlays();
  await wait(400);
  if (!wasOpen) { await SBMM.viewer3d.toggle(); await wait(500); }
  return out;
});
console.log("v13 water in 3D:", JSON.stringify(w13d));
if (!w13d.anim || w13d.anim.length !== 1 || w13d.anim[0].n < 10)
  { console.log("FAIL: the visible flow has no particle stream:", JSON.stringify(w13d.anim)); process.exit(1); }
if (!w13d.anim[0].pipes)
  { console.log("FAIL: the conduit legs must carry their own particles"); process.exit(1); }
if (w13d.rendersWithFlow < 3)
  { console.log("FAIL: an animated flow must drive the render loop, got", w13d.rendersWithFlow); process.exit(1); }
/* the particles advance at 40 ft/s of WALL clock, and under software GL the loop
   is served about one frame a second, so four seconds is ~160 ft of travel; 20 is
   the floor that separates "moving" from "stuck" without pinning a frame rate */
if (w13d.animAdvance < 20 || !(w13d.moved > 0))
  { console.log("FAIL: the particles did not move:", w13d.animAdvance, w13d.moved); process.exit(1); }
if (w13d.rendersToggledOff > 1 || w13d.frozen !== 0)
  { console.log("FAIL: 'animate water' off must stop the frames, got",
                w13d.rendersToggledOff, w13d.frozen); process.exit(1); }
if (w13d.animAfterHide !== 0 || w13d.rendersNoFlow > 1)
  { console.log("FAIL: with no visible flow the loop must idle, got",
                w13d.animAfterHide, w13d.rendersNoFlow); process.exit(1); }
if (!w13d.stageAtDefault || Math.abs(w13d.stageAtDefault.z - (w13d.stageAtDefault.level - w13d.zmid)) > 0.01)
  { console.log("FAIL: the stage surface is not at level - ZMID:", JSON.stringify(w13d.stageAtDefault)); process.exit(1); }
if (!w13d.stageAtZero || Math.abs(w13d.stageAtZero.level - w13d.stageLevelZero) > 1e-6
    || Math.abs(w13d.stageAtZero.z - w13d.stageAtDefault.z) < 0.5)
  { console.log("FAIL: the stage surface did not follow the slider:",
                JSON.stringify(w13d.stageAtZero), JSON.stringify(w13d.stageAtDefault)); process.exit(1); }
if (w13d.stageAfterClear !== null)
  { console.log("FAIL: closing the analysis must clear the stage surface"); process.exit(1); }
if (errors.length !== errBeforeW13) {
  console.log("FAIL: page errors during the v13 water block:",
              errors.slice(errBeforeW13, errBeforeW13 + 6)); process.exit(1);
}
});

/* ==================================================================== */
let errBeforeRedo, undoBtns, rdraw, b1, rvert, rdel, rdel2, rflow, rpad, rfork, rkeys, rclean;   /* hoisted — v18 §3 */
await block("9u. redo (docs/V11_SPEC.md §1)", async () => {
/* 9u. redo (docs/V11_SPEC.md §1)                                       */
/* ==================================================================== */
/* Undo grew a second stack. What is asserted here is the contract, not the
   wiring: every action that can be undone can be redone, redo restores the SAME
   feature object (same id, same vertices, same card) rather than a look-alike,
   a new action after an undo drops the branch that was left, and the two
   buttons are a view onto the two stacks at every step. */
errBeforeRedo = errors.length;
undoBtns = () => page.evaluate(() => ({
  undo: document.getElementById("undoBtn").disabled,
  redo: document.getElementById("redoBtn").disabled,
  undoT: document.getElementById("undoBtn").title,
  redoT: document.getElementById("redoBtn").title
}));

/* --- 1. draw a line -> undo -> redo -> undo --------------------------- */
rdraw = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.mode.navigate();
  SBMM.undo.clear();
  const n0 = SBMM.store.features.length;
  /* the real drawing path: arm the tool, click vertices, finish the sketch */
  SBMM.tools.setTool("distance");
  SBMM.tools.mapClick(6371300, 2128500);
  SBMM.tools.mapClick(6371400, 2128560);
  const vertexEntries = SBMM.undo.stack.length;
  SBMM.draw.finishSketch();
  await wait(150);
  SBMM.mode.navigate();                       // close the sketch the tool re-armed
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  window.__ru = f;
  const snap = () => ({
    n: SBMM.store.features.length - n0,
    here: SBMM.store.features.indexOf(f) >= 0,
    onMap: !!(f.layer && SBMM.map.hasLayer(f.layer)),
    card: !!(f.card && document.body.contains(f.card)),
    pts: JSON.stringify(f.pts),
    labels: SBMM.undo.labels(), can: [SBMM.undo.canUndo(), SBMM.undo.canRedo()]
  });
  const made = snap();
  const id0 = f.id, len0 = f.props.length_ft;
  SBMM.undo.pop();  await wait(60);
  const undone = snap();
  SBMM.undo.redo(); await wait(60);
  const redone = snap();
  SBMM.undo.pop();  await wait(60);
  const again = snap();
  return { vertexEntries, made, undone, redone, again, id0, len0,
           idAfter: f.id, lenAfter: f.props.length_ft };
});
console.log("redo/draw a line: after draw", JSON.stringify(rdraw.made),
            "\n                  after undo", JSON.stringify(rdraw.undone),
            "\n                  after redo", JSON.stringify(rdraw.redone));
if (rdraw.made.n !== 1 || !rdraw.made.onMap || !rdraw.made.card || rdraw.made.labels.undo === null)
  { console.log("FAIL: drawing a line did not create one undoable feature"); process.exit(1); }
/* the sketch's per-vertex entries die with the sketch — one entry, "draw ..." */
if (rdraw.vertexEntries !== 2 || !/^draw /.test(rdraw.made.labels.undo))
  { console.log("FAIL: the finished sketch should leave exactly one 'draw' entry:", rdraw.vertexEntries, rdraw.made.labels); process.exit(1); }
if (rdraw.undone.n !== 0 || rdraw.undone.onMap || rdraw.undone.card || rdraw.undone.can[1] !== true)
  { console.log("FAIL: undo did not take the line off the map / off the panel"); process.exit(1); }
if (rdraw.redone.n !== 1 || !rdraw.redone.onMap || !rdraw.redone.card)
  { console.log("FAIL: redo did not put the line back on the map with its card"); process.exit(1); }
if (rdraw.idAfter !== rdraw.id0 || rdraw.redone.pts !== rdraw.made.pts || rdraw.lenAfter !== rdraw.len0)
  { console.log("FAIL: redo produced a look-alike, not the same feature", rdraw.id0, rdraw.idAfter); process.exit(1); }
if (rdraw.again.n !== 0) { console.log("FAIL: a second undo did not remove the line again"); process.exit(1); }
b1 = await undoBtns();
console.log("redo/buttons after undo:", JSON.stringify(b1));
if (b1.undo !== true || b1.redo !== false || !/^Redo: draw /.test(b1.redoT))
  { console.log("FAIL: the buttons do not mirror the two stacks"); process.exit(1); }

/* --- 2. drag a vertex through the 2D handle -------------------------- */
/* The handle is a real DOM marker (`.vtx`), so this is the user's own path:
   Leaflet's Draggable listens for mousedown on the handle and mousemove /
   mouseup on the document. */
rvert = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.undo.redo(); await wait(80);                 // the line is back
  const f = window.__ru;
  SBMM.snap.setEnabled(false);
  SBMM.store.select(f.id);
  SBMM.tools.editFeature(f);
  await wait(120);
  const before = JSON.stringify(f.pts);
  const h = document.querySelector("#map .vtx:not(.mid)");
  if (!h) return { err: "no vertex handle" };
  const r = h.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  /* dispatched ON the handle (they bubble to the document listeners Leaflet's
     Draggable installs): a synthetic move whose target is `document` leaves
     Draggable._lastTarget = document, and its finishDrag then reads
     document.className.baseVal and throws — an artefact of the synthetic event,
     not something a real pointer can do */
  const ev = (t, x, y) => h.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  ev("mousedown", cx, cy);
  ev("mousemove", cx + 30, cy + 18);
  ev("mousemove", cx + 55, cy + 34);
  ev("mouseup", cx + 55, cy + 34);
  await wait(200);
  SBMM.draw.endEdit();
  const after = JSON.stringify(f.pts);
  const label = SBMM.undo.labels().undo;
  SBMM.undo.pop();  await wait(80);
  const undone = JSON.stringify(f.pts);
  SBMM.undo.redo(); await wait(80);
  const redone = JSON.stringify(f.pts);
  SBMM.snap.setEnabled(true);
  return { before, after, undone, redone, label, moved: before !== after };
});
console.log("redo/vertex drag:", JSON.stringify({ label: rvert.label, moved: rvert.moved }));
if (rvert.err || !rvert.moved) { console.log("FAIL: the vertex handle drag did not move a vertex:", JSON.stringify(rvert)); process.exit(1); }
if (rvert.label !== "move vertex") { console.log("FAIL: a vertex drag should push one 'move vertex' entry, got", rvert.label); process.exit(1); }
if (rvert.undone !== rvert.before) { console.log("FAIL: undo did not restore the old vertex", rvert.undone); process.exit(1); }
if (rvert.redone !== rvert.after) { console.log("FAIL: redo did not restore the moved vertex", rvert.redone); process.exit(1); }

/* --- 3. delete a feature (ERASE) ------------------------------------- */
rdel = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const f = window.__ru;
  SBMM.store.select(f.id);
  SBMM.cmd.run("ERASE"); await wait(120);
  const gone = { here: SBMM.store.features.indexOf(f) >= 0, label: SBMM.undo.labels().undo };
  SBMM.undo.pop(); await wait(80);
  const back = { here: SBMM.store.features.indexOf(f) >= 0, id: f.id,
                 onMap: !!(f.layer && SBMM.map.hasLayer(f.layer)),
                 card: !!(f.card && document.body.contains(f.card)),
                 inTree: !!document.querySelector('#featureTree .ftrow[data-fid="' + f.id + '"]') };
  SBMM.undo.redo(); await wait(80);
  const goneAgain = SBMM.store.features.indexOf(f) >= 0;
  return { gone, back, goneAgain, id0: f.id };
});
console.log("redo/delete:", JSON.stringify(rdel));
if (rdel.gone.here || !/^delete /.test(rdel.gone.label || ""))
  { console.log("FAIL: ERASE is not an undoable delete"); process.exit(1); }
if (!rdel.back.here || !rdel.back.onMap || !rdel.back.card || !rdel.back.inTree || rdel.back.id !== rdel.id0)
  { console.log("FAIL: undo of a delete did not bring the same feature back"); process.exit(1); }
if (rdel.goneAgain) { console.log("FAIL: redo did not delete the feature again"); process.exit(1); }

/* --- 3b. the other delete paths are the same action (v9.7) ----------
   The results-card ✕, the Features-tree bin and the popup's delete button all
   route through SBMM.tools.deleteFeature now, so each of them undoes. */
rdel2 = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  const mk = () => SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400, 2128600], [6371500, 2128600]] });
  /* results card ✕ */
  let f = mk(); await wait(60);
  const x = f.card && f.card.querySelector('[data-a="del"]');
  if (!x) return { err: "no card ✕" };
  x.click(); await wait(80);
  out.card = { gone: SBMM.store.features.indexOf(f) < 0, label: SBMM.undo.labels().undo };
  SBMM.undo.pop(); await wait(80);
  out.card.back = SBMM.store.features.indexOf(f) >= 0 && !!(f.layer && SBMM.map.hasLayer(f.layer));
  SBMM.tools.deleteFeature(f); await wait(40);
  /* Features-tree bin */
  f = mk(); await wait(120);
  const row = document.querySelector('#featureTree .ftrow[data-fid="' + f.id + '"] .del');
  if (!row) return { err: "no tree row bin", ...out };
  row.click(); await wait(80);
  out.tree = { gone: SBMM.store.features.indexOf(f) < 0, label: SBMM.undo.labels().undo };
  SBMM.undo.pop(); await wait(80);
  out.tree.back = SBMM.store.features.indexOf(f) >= 0 && !!(f.layer && SBMM.map.hasLayer(f.layer));
  SBMM.tools.deleteFeature(f); await wait(40);
  return out;
});
console.log("delete paths undo:", JSON.stringify(rdel2));
if (rdel2.err) { console.log("FAIL: " + rdel2.err); process.exit(1); }
for (const k of ["card", "tree"])
  if (!rdel2[k].gone || !/^delete /.test(rdel2[k].label || "") || !rdel2[k].back)
    { console.log("FAIL: the " + k + " delete is not an undoable action"); process.exit(1); }

/* --- 4. a raindrop, and its animated copy in the water pane ---------- */
rflow = await page.evaluate(async (DROP) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const anim = () => document.querySelectorAll(".flowanim").length;
  const a0 = anim(), n0 = SBMM.store.features.length;
  const f = await SBMM.water.dropAt(DROP[0], DROP[1], { quiet: true });
  await wait(200);
  const made = { n: SBMM.store.features.length - n0, anim: anim() - a0, label: SBMM.undo.labels().undo };
  const pts0 = JSON.stringify(f.pts);
  SBMM.undo.pop(); await wait(150);
  const undone = { n: SBMM.store.features.length - n0, anim: anim() - a0, canRedo: SBMM.undo.canRedo() };
  SBMM.undo.redo(); await wait(150);
  const redone = { n: SBMM.store.features.length - n0, anim: anim() - a0,
                   sameId: SBMM.store.features.indexOf(f) >= 0,
                   drawn: !!(f.layer && SBMM.map.hasLayer(f.layer) && f.layer.getLayers().length > 2),
                   pts: JSON.stringify(f.pts) === pts0,
                   card: !!(f.card && document.body.contains(f.card)) };
  SBMM.undo.pop(); await wait(120);      // leave the map as we found it
  SBMM.undo.clear();
  return { made, undone, redone };
}, WREF.drop);
console.log("redo/raindrop:", JSON.stringify(rflow));
if (rflow.made.n !== 1 || rflow.made.anim !== 1 || !/^raindrop /.test(rflow.made.label || ""))
  { console.log("FAIL: the raindrop did not draw one flow with one animated copy"); process.exit(1); }
if (rflow.undone.n !== 0 || rflow.undone.anim !== 0 || !rflow.undone.canRedo)
  { console.log("FAIL: undo left the flow or its animated pane copy behind"); process.exit(1); }
if (rflow.redone.n !== 1 || rflow.redone.anim !== 1 || !rflow.redone.sameId || !rflow.redone.drawn
    || !rflow.redone.pts || !rflow.redone.card)
  { console.log("FAIL: redo did not bring the raindrop back drawn"); process.exit(1); }

/* --- 5. a graded pad ------------------------------------------------- */
rpad = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const box = [[6371380, 2128480], [6371520, 2128480], [6371520, 2128600], [6371380, 2128600]];
  const src = SBMM.tools.rebuildFeature({ type: "area", pts: box, name: "ZZ redo pad box" });
  SBMM.store.select(src.id);
  SBMM.undo.clear();
  const st = SBMM.design.rimStats(box);
  SBMM.design.cmdPad("pad", (+st.mean.toFixed(2)).toString());
  await wait(100);
  const f = SBMM.design.list().find(s => /ZZ redo pad box/.test(s.name || "") && !s.props.ref);
  if (!f) return { err: "no pad" };
  for (let i = 0; i < 400 && !f._surf; i++) await wait(100);
  const made = { label: SBMM.undo.labels().undo, surf: !!f._surf, dl: !!f._dlLayer,
                 onMap: !!(f.layer && SBMM.map.hasLayer(f.layer)),
                 row: !!document.querySelector('#surfList .surfrow[data-fid="' + f.id + '"]') };
  SBMM.undo.pop(); await wait(120);
  const undone = { here: SBMM.store.features.indexOf(f) >= 0,
                   onMap: !!(f.layer && SBMM.map.hasLayer(f.layer)),
                   dlOnMap: !!(f._dlLayer && SBMM.map.hasLayer(f._dlLayer)) };
  SBMM.undo.redo(); await wait(200);
  for (let i = 0; i < 400 && !f._surf; i++) await wait(100);
  const redone = { here: SBMM.store.features.indexOf(f) >= 0, id: f.id,
                   onMap: !!(f.layer && SBMM.map.hasLayer(f.layer)),
                   surf: !!f._surf, padZ: f.props.padZ,
                   dlOnMap: !!(f._dlLayer && SBMM.map.hasLayer(f._dlLayer)),
                   card: !!(f.card && document.body.contains(f.card)),
                   inList: SBMM.design.list().some(s => s.id === f.id) };
  return { made, undone, redone, srcId: src.id, padId: f.id };
});
console.log("redo/graded pad:", JSON.stringify(rpad));
if (rpad.err || !rpad.made.surf || rpad.made.label !== "design surface")
  { console.log("FAIL: PAD did not create an undoable design surface:", JSON.stringify(rpad)); process.exit(1); }
if (rpad.undone.here || rpad.undone.onMap || rpad.undone.dlOnMap)
  { console.log("FAIL: undo left the pad or its daylight line on the map"); process.exit(1); }
if (!rpad.redone.here || !rpad.redone.onMap || !rpad.redone.surf || !rpad.redone.dlOnMap
    || !rpad.redone.card || !rpad.redone.inList || rpad.redone.id !== rpad.padId)
  { console.log("FAIL: redo did not regenerate the design surface"); process.exit(1); }

/* --- 6. a new action forks history: the redo branch is gone ---------- */
rfork = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.undo.pop(); await wait(120);                    // the pad again -> redo available
  const armed = SBMM.undo.canRedo();
  SBMM.tools.rebuildFeature({ type: "spot", pts: [[6371460, 2128520]], name: "ZZ fork" });
  const f = SBMM.store.features[SBMM.store.features.length - 1];
  SBMM.undo.push("ZZ fork", () => SBMM.store.remove(f), () => SBMM.store.readd(f));
  await wait(60);
  const after = { canRedo: SBMM.undo.canRedo(), btn: document.getElementById("redoBtn").disabled };
  const ok = SBMM.undo.redo();                          // no-op with a toast
  await wait(60);
  const t0 = document.getElementById("toast");
  const toastTxt = (t0 && t0.classList.contains("show")) ? t0.textContent : "";
  SBMM.undo.pop(); await wait(60);                      // take the fork feature away again
  return { armed, after, redoReturned: ok, toastTxt };
});
console.log("redo/fork:", JSON.stringify(rfork));
if (!rfork.armed || rfork.after.canRedo || rfork.after.btn !== true)
  { console.log("FAIL: a new action did not clear the redo stack"); process.exit(1); }
if (rfork.redoReturned !== false || !/nothing to redo/.test(rfork.toastTxt))
  { console.log("FAIL: redo on an empty stack must be a no-op WITH a toast:", JSON.stringify(rfork)); process.exit(1); }

/* --- 7. the keys and the command ------------------------------------- */
rkeys = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.mode.navigate();
  SBMM.undo.clear();
  const n0 = SBMM.store.features.length;
  const f = SBMM.tools.rebuildFeature({ type: "spot", pts: [[6371470, 2128530]], name: "ZZ keys" });
  SBMM.undo.push("ZZ keys", () => SBMM.store.remove(f), () => SBMM.store.readd(f));
  const key = (k, mods) => document.dispatchEvent(new KeyboardEvent("keydown",
    Object.assign({ key: k, bubbles: true }, mods)));
  key("z", { ctrlKey: true }); await wait(80);
  const afterUndo = SBMM.store.features.length - n0;
  key("y", { ctrlKey: true }); await wait(80);
  const afterCtrlY = SBMM.store.features.length - n0;
  key("z", { ctrlKey: true }); await wait(80);
  key("z", { ctrlKey: true, shiftKey: true }); await wait(80);
  const afterCtrlShiftZ = SBMM.store.features.length - n0;
  const cmd = SBMM.cmd.find("REDO");
  const aliases = ["RE", "Y"].map(a => (SBMM.cmd.find(a) || {}).n || null);
  key("z", { ctrlKey: true }); await wait(80);          // clean up
  SBMM.undo.clear();
  return { afterUndo, afterCtrlY, afterCtrlShiftZ, cmd: cmd && cmd.n, aliases,
           left: SBMM.store.features.length - n0 };
});
console.log("redo/keys:", JSON.stringify(rkeys));
if (rkeys.afterUndo !== 0 || rkeys.afterCtrlY !== 1 || rkeys.afterCtrlShiftZ !== 1)
  { console.log("FAIL: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z do not drive the two stacks"); process.exit(1); }
if (rkeys.cmd !== "REDO" || rkeys.aliases.join(",") !== "REDO,REDO")
  { console.log("FAIL: the REDO command or its aliases are missing:", JSON.stringify(rkeys)); process.exit(1); }

/* --- 8. every push carries both closures, and the block raised nothing */
rclean = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  /* tidy: the fixtures this block left behind */
  for (const n of ["ZZ redo pad box", "ZZ fork", "ZZ keys"]) {
    const f = SBMM.store.features.find(x => x.name === n);
    if (f) SBMM.store.remove(f);
  }
  const pad = SBMM.design.list().find(s => /ZZ redo pad box/.test(s.name || "") && !s.props.ref);
  if (pad) SBMM.store.remove(pad);
  const line = window.__ru;
  if (line && SBMM.store.features.indexOf(line) >= 0) SBMM.store.remove(line);
  SBMM.undo.clear();
  await wait(60);
  const b = document.getElementById("undoBtn"), r = document.getElementById("redoBtn");
  return { undoDisabled: b.disabled, redoDisabled: r.disabled,
           undoT: b.title, redoT: r.title,
           canUndo: SBMM.undo.canUndo(), canRedo: SBMM.undo.canRedo() };
});
console.log("redo/cleared:", JSON.stringify(rclean));
if (!rclean.undoDisabled || !rclean.redoDisabled || rclean.canUndo || rclean.canRedo)
  { console.log("FAIL: clear() left the stacks or the buttons armed"); process.exit(1); }
if (errors.length !== errBeforeRedo) {
  console.log("FAIL: page errors during the redo block:", errors.slice(errBeforeRedo, errBeforeRedo + 6)); process.exit(1);
}
console.log("redo: OK — 8 cycles, both closures at every push site");
});

/* ==================================================================== */
let lstate, barClipping, modes;   /* hoisted — v18 §3 */
await block("9j. one layer state (§1/§4) and the tool-mode machine (§2)", async () => {
/* 9j. one layer state (§1/§4) and the tool-mode machine (§2)            */
/* ==================================================================== */
lstate = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const evs = [];
  const off = SBMM.events.on("layers", e => evs.push(e.group + "/" + e.layer));
  /* a layer that is on is on in 2D and in 3D */
  SBMM.layerState.set("framework", "dus", { on: false });
  await wait(500);
  const duOff = { onMap: SBMM.map.hasLayer(SBMM.layers.duGrp), scene: SBMM.viewer3d.stats().sceneObjects };
  SBMM.layerState.set("framework", "dus", { on: true });
  await wait(500);
  const duOn = { onMap: SBMM.map.hasLayer(SBMM.layers.duGrp) };
  /* opacity travels through the same state */
  SBMM.layerState.set("base", "ortho_mine_area_6_in", { opacity: 0.4 });
  const op = SBMM.layerState.get("base", "ortho_mine_area_6_in");
  SBMM.layerState.set("base", "ortho_mine_area_6_in", { opacity: 0.9 });
  /* a group master switch */
  const before = SBMM.layerState.groupState("mywork");
  SBMM.layerState.setGroup("mywork", false);
  const allOff = SBMM.layerState.groupState("mywork");
  SBMM.layerState.setGroup("mywork", true);
  off();
  /* the session carries it, the cultural group deliberately does not */
  const ser = SBMM.store.serialize();
  return {
    duOff, duOn, opacity: op.opacity, before, allOff,
    after: SBMM.layerState.groupState("mywork"),
    events: evs.length,
    groups: SBMM.layerState.groupList().map(g => g.id),
    inSession: !!(ser.layers && ser.layers.design && ser.layers.framework),
    culturalInSession: !!(ser.layers && ser.layers.cultural),
    /* no visibility checkboxes left in the 3D toolbar (§3) */
    v3dCheckboxes: document.querySelectorAll("#view3d .v3dbar input[type=checkbox]").length,
    oldIds: ["v3dDus", "v3dPiles", "v3dDrawn", "v3dDesign", "v3dSheets", "v3dPts",
             "v3dData", "v3dContours", "v3dCanopy"].filter(id => document.getElementById(id))
  };
});
console.log("layer state: groups", JSON.stringify(lstate.groups), "| events fired", lstate.events,
            "| in session", lstate.inSession, "| cultural excluded", !lstate.culturalInSession,
            "| 3D toolbar checkboxes", lstate.v3dCheckboxes);
if (lstate.groups.join(",") !== "base,framework,design,invest,cultural,mywork") {
  console.log("FAIL: SBMM.layerState groups are wrong:", lstate.groups); process.exit(1);
}
if (lstate.duOff.onMap || !lstate.duOn.onMap) { console.log("FAIL: layerState did not drive the 2D map"); process.exit(1); }
if (Math.abs(lstate.opacity - 0.4) > 1e-6) { console.log("FAIL: layerState opacity did not take"); process.exit(1); }
if (lstate.allOff !== "none" || lstate.after !== "all") { console.log("FAIL: the group master switch does not work"); process.exit(1); }
if (!lstate.inSession) { console.log("FAIL: the session file must carry the layer state"); process.exit(1); }
if (lstate.culturalInSession) { console.log("FAIL: the cultural group must not be persisted (§7)"); process.exit(1); }
if (lstate.v3dCheckboxes !== 0 || lstate.oldIds.length) {
  console.log("FAIL: the 3D toolbar still has visibility checkboxes:", lstate.oldIds); process.exit(1);
}

/* ---- F6: nothing in the 3D toolbar may be clipped, at any width ----
   The bar was one non-wrapping row: at 1600 px in full 3D the snapshot button,
   the coordinate readout and "back to 2D" ran off the right-hand edge, and in
   split — half the width — the relief slider and the detail picker went too.
   Nothing errored; the controls were simply not on screen. js/viewer3d.js
   reflowBar() now drops the labels and then parks the drape / relief / detail
   groups in the View settings popover, so every control that is still ON the
   bar has to be inside it. */
barClipping = async function barClipping(label) {
  const bad = await page.evaluate(() => {
    const bar = document.querySelector("#view3d .v3dbar");
    if (!bar) return ["no toolbar"];
    const b = bar.getBoundingClientRect();
    const out = [];
    for (const el of bar.children) {
      if (el.offsetParent === null) continue;              // hidden / parked
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      /* half a pixel of rounding is not clipping; two is */
      if (r.right > b.right + 2 || r.left < b.left - 2)
        out.push((el.id || el.className || el.tagName) + " " + Math.round(r.left) + ".." + Math.round(r.right)
                 + " vs bar " + Math.round(b.left) + ".." + Math.round(b.right));
    }
    return out;
  });
  console.log("3D toolbar @ " + label + ":", bad.length ? "CLIPPED " + bad.join(" | ") : "all controls inside the bar");
  if (bad.length) { console.log("FAIL: the 3D toolbar is clipped at " + label); process.exit(1); }
}
{
  const wasOpen = await page.evaluate(() => SBMM.viewer3d.isOpen());
  if (!wasOpen) { await page.evaluate(() => SBMM.viewer3d.toggle()); await page.waitForTimeout(900); }
  await page.evaluate(() => { if (document.body.classList.contains("v3dsplit")) $("v3dSplit").click(); });
  await page.waitForTimeout(400);
  await barClipping("1600 px full 3D");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(500);
  await barClipping("1280 px full 3D");
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(400);
  await page.click("#v3dSplit");
  await page.waitForTimeout(600);
  await barClipping("1600 px split");
  await page.click("#v3dSplit");
  await page.waitForTimeout(400);
  if (!wasOpen) { await page.evaluate(() => SBMM.viewer3d.toggle()); await page.waitForTimeout(400); }
}

modes = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const seen = [];
  const off = SBMM.events.on("mode", e => seen.push(e.from + "->" + e.to));
  const key = k => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const out = {};
  for (const [k, want] of [["i", "inspect"], ["m", "measure.distance"], ["a", "measure.area"],
                           ["v", "volume"], ["p", "draw.point"], ["l", "draw.line"],
                           ["g", "draw.polygon"]]) {
    key(k); await wait(60);
    out[k] = { mode: SBMM.mode.current(), ok: SBMM.mode.current() === want,
               cursor: document.getElementById("stage").dataset.cursor,
               hud: document.querySelector("#modeHud .mhname").textContent };
  }
  /* Esc from any of them lands on navigate, with the button highlight cleared */
  key("Escape"); await wait(80);
  out.esc = { mode: SBMM.mode.current(), lit: document.querySelectorAll(".toolbtn.active[data-mode]").length,
              cursor: document.getElementById("stage").dataset.cursor,
              esc: document.querySelector("#modeHud .mhesc").textContent };
  /* Space held is a temporary navigate that keeps the sketch */
  SBMM.mode.set("measure.area");
  SBMM.tools.mapClick(6371400, 2128700);
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
  await wait(60);
  out.spaceDown = { mode: SBMM.mode.current(), drawing: SBMM.draw.isDrawing() };
  document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true }));
  await wait(60);
  out.spaceUp = { mode: SBMM.mode.current(), drawing: SBMM.draw.isDrawing() };
  SBMM.mode.navigate();
  off();
  out.events = seen.length;
  out.navHud = document.querySelector("#modeHud .mhname").textContent;
  return out;
});
console.log("modes:", Object.entries(modes).filter(([k]) => k.length === 1)
  .map(([k, v]) => k + "->" + v.mode).join(" "), "| Esc:", JSON.stringify(modes.esc),
  "| Space:", JSON.stringify(modes.spaceDown), "->", JSON.stringify(modes.spaceUp));
for (const k of ["i", "m", "a", "v", "p", "l", "g"])
  if (!modes[k].ok) { console.log("FAIL: shortcut", k, "landed on", modes[k].mode); process.exit(1); }
for (const k of ["i", "m", "a", "v", "p", "l", "g"])
  if (modes[k].cursor !== "crosshair") { console.log("FAIL: mode", modes[k].mode, "did not set the crosshair cursor"); process.exit(1); }
if (modes.esc.mode !== "navigate" || modes.esc.lit !== 1 || modes.esc.cursor !== "grab") {
  console.log("FAIL: Esc did not return to Navigate with the highlight on the Navigate button"); process.exit(1);
}
if (modes.esc.esc !== "") { console.log("FAIL: the Esc hint should be blank in Navigate"); process.exit(1); }
if (modes.spaceDown.mode !== "navigate" || !modes.spaceDown.drawing) {
  console.log("FAIL: Space should be a temporary Navigate that keeps the sketch"); process.exit(1);
}
if (modes.spaceUp.mode !== "measure.area") { console.log("FAIL: releasing Space did not return to the mode"); process.exit(1); }
if (!modes.events) { console.log("FAIL: SBMM.events emitted no 'mode' events"); process.exit(1); }
if (modes.navHud !== "Navigate") { console.log("FAIL: the mode HUD does not name the mode"); process.exit(1); }
});

/* ==================================================================== */
let lman;   /* hoisted — v18 §3 */
await block("9k. Layer manager (§6)", async () => {
/* 9k. Layer manager (§6)                                               */
/* ==================================================================== */
await page.evaluate(() => SBMM.layerMan.open());
await page.waitForTimeout(500);
await page.fill("#layerMan #lmQ", "DYLGHT");
await page.waitForTimeout(300);
await page.screenshot({ path: "shots/layer_manager.png" });
lman = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rows = [...document.querySelectorAll("#lmRows tr[data-ly]")];
  const names = rows.map(r => r.dataset.ly);
  /* recolour and hide the first match, then reset */
  const name = names[0];
  const tr = rows[0];
  tr.querySelector(".lmcol").value = "#00ff88";
  tr.querySelector(".lmcol").dispatchEvent(new Event("input"));
  tr.querySelector(".lmon").checked = false;
  tr.querySelector(".lmon").dispatchEvent(new Event("change"));
  await wait(200);
  const after = SBMM.CadNative.layerOverride(name);
  const info = SBMM.CadNative.layerInfo(name);
  SBMM.CadNative.resetLayerOverrides();
  await wait(200);
  const reset = SBMM.CadNative.layerOverride(name);
  document.querySelector("#layerMan #lmX").click();
  return { names, name, after, reset, info,
           excDefaultOff: SBMM.CadNative.defaultOverrides.exc === false,
           cadExcOn: SBMM.layerState.isOn("design", "cad_exc"),
           gisExcOn: SBMM.layerState.isOn("design", "gis_exc") };
});
console.log("layer manager: search 'DYLGHT' ->", lman.names.length, "layers |",
            lman.name, "colour", lman.after.color, "hidden", lman.after.on === false,
            "| reset", JSON.stringify(lman.reset), "| source", lman.info.file,
            "| handle", lman.info.handle, "| features", lman.info.count);
if (lman.names.length < 4) { console.log("FAIL: the layer manager search found too few CAD layers"); process.exit(1); }
if (lman.after.color !== "#00ff88" || lman.after.on !== false) { console.log("FAIL: the layer manager did not apply an override"); process.exit(1); }
if (Object.keys(lman.reset).length) { console.log("FAIL: 'reset to defaults' left an override behind"); process.exit(1); }
if (!lman.info.file || !lman.info.count) { console.log("FAIL: the layer manager shows no source file or feature count"); process.exit(1); }
/* R1: the geodatabase polygons are the authority; EA's raw CAD linework for the
   same limits is off by default so it cannot answer clicks in their place. */
if (!lman.excDefaultOff || lman.cadExcOn) { console.log("FAIL: the CAD 'exc' group must default OFF (ruling R1)"); process.exit(1); }
if (!lman.gisExcOn) { console.log("FAIL: the geodatabase limits of excavation must be ON by default"); process.exit(1); }
});

/* ==================================================================== */
let ia, WANT_SECS, designOrder, annoOff, chords, collapse, areas;   /* hoisted — v18 §3 */
await block("9e. layers tab information architecture", async () => {
/* 9e. layers tab information architecture                               */
/* ==================================================================== */
/* the left dock was left on another tab by an earlier section */
await page.click('#leftTabs .dtab[data-tab="layers"]');
await page.waitForTimeout(400);

ia = await page.evaluate(() => {
  const secs = [...document.querySelectorAll("#layers .lsec")].map(s => ({
    key: s.dataset.sec,
    title: s.querySelector(".lsectitle").textContent.trim(),
    count: s.querySelector(".lcount").textContent,
    rows: s.querySelectorAll(".lyr, .surfrow, .refrow[data-sid]").length,
    /* §4: every group carries a master checkbox, except the cultural one,
       whose whole point is that it is not switched on by a broad gesture */
    master: !!s.querySelector(".lsecall")
  }));
  return {
    secs,
    /* every container id a test or another module reaches for must still exist,
       and must still be inside the pane */
    ids: ["baseLayers", "terrainLayers", "anaLayers", "projLayers", "designLayers",
          "surfList", "refSurfList", "investLayers", "dataLayers", "culturalLayers",
          "myworkLayers", "ptLegend"]
      .map(id => [id, !!document.querySelector("#layers #" + id)]),
    areaBtns: [...document.querySelectorAll("#areaNav .areabtn")].map(b => b.dataset.area)
  };
});
console.log("layers sections:", ia.secs.map(s => `${s.key} "${s.title}" (${s.count || 0})`).join(" · "));
/* the six §4 groups, in the spec's order */
WANT_SECS = ["base", "framework", "design", "invest", "cultural", "mywork"];
if (ia.secs.map(s => s.key).join(",") !== WANT_SECS.join(",")) {
  console.log("FAIL: the §4 layer groups are wrong:", ia.secs.map(s => s.key)); process.exit(1);
}
if (ia.secs.some(s => !s.title)) { console.log("FAIL: a layer group has no title"); process.exit(1); }
if (ia.secs.some(s => +s.count !== s.rows)) { console.log("FAIL: a section count badge disagrees with its rows", ia.secs); process.exit(1); }
if (ia.secs.filter(s => s.key !== "cultural").some(s => !s.master)) {
  console.log("FAIL: a layer group is missing its master checkbox"); process.exit(1);
}
if (ia.ids.some(p => !p[1])) { console.log("FAIL: a layer container id went missing:", ia.ids.filter(p => !p[1])); process.exit(1); }
if (ia.areaBtns.join(",") !== "mine,resid,site") { console.log("FAIL: Areas quick-nav missing"); process.exit(1); }

/* ---- the residential design group reads top-down (planner ruling D2) ----
   Curated layers first — EA's geodatabase geometry and EA's own CAD groups —
   then the per-sheet raster drapes under their own sub-header at the bottom.
   Twenty "C-103 · Lot 13" rows at the top pushed every authoritative layer
   below the fold, which is how the group was shipped before this round. */
designOrder = await page.evaluate(() => {
  const host = document.getElementById("designLayers");
  /* v16: a sub-group is a real container (`.lgsub` > `.subh.lsub` + `.lgsubb`)
     rather than a bare header followed by its rows, so the reading order of the
     group is the header followed by the rows inside it. Flatten it back to the
     sequence this assertion has always been about. */
  const seq = [];
  /* the sub-group header holds a caret span and a count span beside its name,
     so the name is its own text nodes */
  const subName = h => h ? [...h.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim() : "";
  const walk = el => {
    for (const kid of el.children) {
      if (kid.classList.contains("lgsub")) {
        seq.push({ sub: subName(kid.querySelector(".subh")) });
        walk(kid.querySelector(".lgsubb") || kid);
      } else if (kid.classList.contains("lsub")) seq.push({ sub: kid.textContent.trim() });
      else if (kid.classList.contains("lyr")) seq.push({ row: (kid.querySelector(".lbl") || kid).textContent.trim() });
    }
  };
  walk(host);
  const label = i => seq[i].row || "";
  const isSheet = t => /^[CG]-\d{3}\b/.test(t);
  const subIdx = seq.findIndex(x => x.sub === "Sheets (draped)");
  return {
    title: document.querySelector('#layers .lsec[data-sec="design"] .lsectitle').textContent.trim(),
    first: seq.slice(0, 8).map((x, i) => x.sub ? "[" + x.sub + "]" : label(i)),
    subIdx,
    sheetsBefore: seq.slice(0, subIdx < 0 ? seq.length : subIdx)
      .filter(x => x.row && isSheet(x.row)).map(x => x.row),
    sheetsAfter: subIdx < 0 ? [] : seq.slice(subIdx)
      .filter(x => x.row && isSheet(x.row)).map(x => x.row),
    afterSub: subIdx < 0 ? [] : seq.slice(subIdx + 1).filter(x => x.row).map(x => x.row),
    /* one LINE, and not clipped to get there. getClientRects() is no use here —
       .lsectitle is display:block, so it reports one rect however many lines it
       renders on; the rendered height against the line box is the real test. */
    titleH: (() => {
      const el = document.querySelector('#layers .lsec[data-sec="design"] .lsectitle');
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 14;
      return { h: el.getBoundingClientRect().height, lh,
               clipped: el.scrollWidth > el.clientWidth + 1 };
    })()
  };
});
console.log("design group:", JSON.stringify(designOrder.title), "| first rows",
            JSON.stringify(designOrder.first), "| sheets under the sub-header",
            designOrder.sheetsAfter.length);
if (designOrder.title !== "Residential design (EA 2025)") {
  console.log("FAIL: the design group title is", JSON.stringify(designOrder.title)); process.exit(1);
}
if (designOrder.titleH.h > designOrder.titleH.lh * 1.5 || designOrder.titleH.clipped) {
  console.log("FAIL: the design group title is", designOrder.titleH.h.toFixed(0), "px tall on a",
              designOrder.titleH.lh.toFixed(0), "px line (clipped:", designOrder.titleH.clipped,
              ") — it must fit on one line at the default dock width"); process.exit(1);
}
if (designOrder.subIdx < 1) { console.log("FAIL: no 'Sheets (draped)' sub-header in the design group"); process.exit(1); }
if (designOrder.sheetsBefore.length) {
  console.log("FAIL: sheet rows appear above the curated layers:", designOrder.sheetsBefore); process.exit(1);
}
if (designOrder.sheetsAfter.length < 10) {
  console.log("FAIL: only", designOrder.sheetsAfter.length, "sheet rows under the sub-header"); process.exit(1);
}
if (!designOrder.afterSub.some(t => /Sheets draped in 3D/.test(t))) {
  console.log("FAIL: the 3D drape master switch must sit with the sheet rows it governs"); process.exit(1);
}

/* ---- paper annotation is off by default (rulings F1 / D2a) ----
   Three EA CAD layers are annotation ABOUT the drawings rather than anything on
   the ground, and all three used to draw over the default 2D view: viewport
   frames, match lines and a detail call-out leader parked out in Clear Lake. */
annoOff = await page.evaluate(() => {
  const want = ["G-ANNO-SYMB", "G-ANNO-MATC", "G-ANNO-DETL-PROP"];
  const out = {};
  for (const n of want) {
    const ov = SBMM.CadNative.layerOverride(n) || {};
    const info = SBMM.CadNative.layerInfo(n) || {};
    out[n] = { on: ov.on, count: info.count || 0 };
  }
  SBMM.CadNative.resetLayerOverrides();
  const afterReset = Object.fromEntries(want.map(n => [n, (SBMM.CadNative.layerOverride(n) || {}).on]));
  return { out, afterReset };
});
console.log("paper-annotation layers off by default:", JSON.stringify(annoOff.out));
for (const n of Object.keys(annoOff.out)) {
  if (annoOff.out[n].on !== false) {
    console.log("FAIL:", n, "must default OFF — it is paper annotation, not a site feature"); process.exit(1);
  }
  if (!annoOff.out[n].count) { console.log("FAIL:", n, "is not in the CAD payload at all"); process.exit(1); }
  if (annoOff.afterReset[n] !== false) {
    console.log("FAIL: resetLayerOverrides() turned", n, "back on — reset means the APP's defaults"); process.exit(1);
  }
}

/* survey contours must not carry the straight chords that close them around
   the survey's data boundary — a fan of them used to lie over Clear Lake,
   reading as alignment lines drawn across open water */
await page.evaluate(() => SBMM.layerState.set("base", "contours_site", { on: true }));
await page.waitForTimeout(500);
chords = await page.evaluate(() => {
  let worst = 0, worstMid = null, n = 0, verts = 0, offTerrain = 0;
  SBMM.map.eachLayer(l => {
    if (!l.options || l.options.color !== "#6E8593" || !l.getLatLngs) return;
    const p = l.getLatLngs();
    if (!p || !p.length || p[0].lat === undefined) return;
    n++; verts += p.length;
    for (let i = 0; i < p.length; i++) {
      if (isNaN(SBMM.elev(p[i].lng, p[i].lat)[0])) offTerrain++;
      if (!i) continue;
      const d = Math.hypot(p[i].lng - p[i - 1].lng, p[i].lat - p[i - 1].lat);
      if (d > worst) {
        const mid = [(p[i].lng + p[i - 1].lng) / 2, (p[i].lat + p[i - 1].lat) / 2];
        if (isNaN(SBMM.elev(mid[0], mid[1])[0])) { worst = d; worstMid = mid; }
      }
    }
  });
  return { n, verts, offTerrain, worst, worstMid };
});
console.log("site contours:", chords.n, "polylines,", chords.verts, "vertices |",
            chords.offTerrain, "off terrain | longest segment over nodata",
            chords.worst.toFixed(1), "ft");
if (!chords.n) { console.log("FAIL: no site contours are on the map"); process.exit(1); }
/* a contour vertex with no ground under it is not a contour vertex */
if (chords.offTerrain) {
  console.log("FAIL:", chords.offTerrain, "site-contour vertices are drawn over DEM NoData"); process.exit(1);
}
if (chords.worst > 60) {
  console.log("FAIL: a", chords.worst.toFixed(0), "ft contour chord crosses NoData at",
              JSON.stringify(chords.worstMid)); process.exit(1);
}
if (chords.n > 1200) {
  console.log("FAIL: the contour split produced", chords.n, "polylines — it is shattering real contours"); process.exit(1);
}

collapse = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const sec = document.querySelector('#layers .lsec[data-sec="framework"]');
  const h = sec.querySelector(".lsech");
  const shown0 = sec.querySelector(".lsecb").offsetHeight > 0;
  h.click(); await wait(120);
  const shown1 = sec.querySelector(".lsecb").offsetHeight > 0;
  h.click(); await wait(120);
  const shown2 = sec.querySelector(".lsecb").offsetHeight > 0;
  return { shown0, shown1, shown2 };
});
console.log("section collapse: open", collapse.shown0, "-> closed", !collapse.shown1, "-> open", collapse.shown2);
if (!collapse.shown0 || collapse.shown1 || !collapse.shown2) { console.log("FAIL: section header does not collapse"); process.exit(1); }

/* Areas quick-nav really moves the 2D view */
areas = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const a of ["mine", "resid", "site"]) {
    SBMM.layersUI.flyTo(a);
    await wait(1200);
    const b = SBMM.map.getBounds();
    out[a] = Math.round(b.getEast() - b.getWest());
  }
  return out;
});
console.log("Areas widths ft — mine", areas.mine, "residential", areas.resid, "site", areas.site);
if (!(areas.site > areas.mine)) { console.log("FAIL: 'Full site' is not wider than the mine area"); process.exit(1); }

await page.screenshot({ path: "/tmp/shotB_layers_" + label.replace(/\W+/g, "_") + ".png" });
});

/* ==================================================================== */
let errBeforeDs, seeds, imported, dsTbl, dsIntegration, rt, oldLoad, escArm, aliases, zorder, keyScope, csvGuard, released, demWork, escModals;   /* hoisted — v18 §3 */
await block("9f. datasets", async () => {
/* 9f. datasets — baked seeds, CSV import, table, session round-trip      */
/* ==================================================================== */
errBeforeDs = errors.length;
seeds = await page.evaluate(() => {
  const L = SBMM.datasets.list();
  const w = SBMM.datasets.byId("wells"), b = SBMM.datasets.byId("borings2025");
  const inSite = d => d.points.every(p => p.x > 6.36e6 && p.x < 6.385e6 && p.y > 2.12e6 && p.y < 2.14e6);
  /* a well head must be a real place: its tabulated ground elevation should
     agree with the 2024 lidar surface it is standing on */
  const dz = [];
  for (const p of w.points) {
    const [z] = SBMM.elev(p.x, p.y);
    const g = p.a["Ground elev (ft NAVD88)"];
    if (!isNaN(z) && typeof g === "number") dz.push(Math.abs(z - g));
  }
  dz.sort((a, c) => a - c);
  return {
    n: L.length, names: L.map(d => d.name),
    wells: w && w.points.length, borings: b && b.points.length,
    wellKind: w && w.kind, boringKind: b && b.kind,
    wellDepth: w && w.depthField, boringDepth: b && b.depthField,
    wellsInSite: w && inSite(w), boringsInSite: b && inSite(b),
    demChecked: dz.length, demMed: dz.length ? +dz[dz.length >> 1].toFixed(2) : null,
    demWithin5: dz.filter(v => v < 5).length,
    rows: document.querySelectorAll("#dataLayers .lyr").length,
    tabs: document.querySelectorAll("#tblTabStrip .ttab").length
  };
});
console.log(`baked datasets: ${seeds.names.join(", ")} | wells ${seeds.wells} (${seeds.wellKind}, depth "${seeds.wellDepth}") `
  + `| borings ${seeds.borings} (${seeds.boringKind}) | rows ${seeds.rows} | table tabs ${seeds.tabs}`);
console.log(`well ground elevation vs the 2024 lidar DEM: n=${seeds.demChecked} median ${seeds.demMed} ft, ${seeds.demWithin5} within 5 ft`);
if (seeds.wells < 90 || seeds.borings < 40) { console.log("FAIL: seed datasets did not load"); process.exit(1); }
if (!seeds.wellsInSite || !seeds.boringsInSite) { console.log("FAIL: a seeded point is outside the site window"); process.exit(1); }
if (!(seeds.demMed < 3)) { console.log("FAIL: well coordinates disagree with the terrain — median", seeds.demMed, "ft"); process.exit(1); }
/* three baked datasets since the August-2026 survey (spec §10): wells, borings, survey */
if (seeds.rows !== 3 || seeds.tabs !== 4) { console.log("FAIL: dataset rows/tabs not built (expected 3 datasets, 4 tabs)"); process.exit(1); }

/* import a synthetic CSV through the real file path: a File -> FileReader ->
   the mapping dialog -> "Add to map". Deliberately headed N/E rather than X/Y,
   and carrying one junk row, because that is what a field CSV looks like. */
imported = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const csv = "LOC_ID,NORTHING,EASTING,TOTAL DEPTH (FT),CREW,NOTE\n"
    + "TESTPIT-1,2128900,6371500,12.5,A,\"comma, quoted\"\n"
    + "TESTPIT-2,2128960,6371620,8,A,shallow\n"
    + "TESTPIT-3,2129020,6371740,21.25,B,deep\n"
    + "TESTPIT-4,,,,B,no coordinates\n";
  const file = new File([csv], "testpits.csv", { type: "text/csv" });
  const text = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsText(file); });
  SBMM.datasets.importCSV(text, file.name);
  await wait(300);
  const dlg = document.getElementById("dsDialog");
  if (!dlg) return { noDialog: true };
  const guessed = {
    x: document.getElementById("dsX").selectedOptions[0].textContent,
    y: document.getElementById("dsY").selectedOptions[0].textContent,
    id: document.getElementById("dsIdCol").selectedOptions[0].textContent,
    preview: document.getElementById("dsPreview").textContent.replace(/\s+/g, " ").trim()
  };
  document.getElementById("dsKind").value = "borings";
  document.getElementById("dsGo").click();
  await wait(600);
  const d = SBMM.datasets.list().find(x => x.name === "testpits");
  return {
    guessed,
    got: !!d, id: d && d.id, n: d && d.points.length, kind: d && d.kind,
    depthField: d && d.depthField,
    firstX: d && d.points[0].x, firstY: d && d.points[0].y,
    quoted: d && d.points[0].a["NOTE"],
    markers: d && Object.keys(d.markers).length,
    row: [...document.querySelectorAll("#dataLayers .lyr")].some(l => /testpits/.test(l.textContent)),
    tab: [...document.querySelectorAll("#tblTabStrip .ttab")].some(t => /testpits/.test(t.textContent)),
    dialogGone: !document.getElementById("dsDialog")
  };
});
if (imported.noDialog) { console.log("FAIL: the CSV import dialog never appeared"); process.exit(1); }
console.log(`CSV import: guessed X=${imported.guessed.x} Y=${imported.guessed.y} ID=${imported.guessed.id}`);
console.log(`  -> ${imported.n} points as ${imported.kind}, depth "${imported.depthField}", `
  + `first ${imported.firstX} E / ${imported.firstY} N, quoted field ${JSON.stringify(imported.quoted)}, `
  + `layer row ${imported.row}, table tab ${imported.tab}`);
if (!imported.got || imported.n !== 3) { console.log("FAIL: CSV import produced", imported.n, "points (expected 3, one row has no coordinates)"); process.exit(1); }
if (imported.guessed.x !== "EASTING" || imported.guessed.y !== "NORTHING" || imported.guessed.id !== "LOC_ID") {
  console.log("FAIL: column auto-detection picked the wrong columns"); process.exit(1);
}
if (imported.firstX !== 6371500 || imported.firstY !== 2128900) { console.log("FAIL: N/E columns were not swapped into E,N"); process.exit(1); }
if (imported.quoted !== "comma, quoted") { console.log("FAIL: quoted CSV field mis-parsed"); process.exit(1); }
if (imported.depthField !== "TOTAL DEPTH (FT)") { console.log("FAIL: depth attribute not detected"); process.exit(1); }
if (!imported.row || !imported.tab || imported.markers !== 3) { console.log("FAIL: imported dataset did not build its layer/table"); process.exit(1); }

/* the dataset's own table filters and sorts */
dsTbl = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.table.toggle(true);
  const d = SBMM.datasets.list().find(x => x.name === "testpits");
  SBMM.dsTable.show(d.id);
  await wait(250);
  const pane = document.getElementById("tblPane_" + d.id);
  const all = pane.querySelectorAll("tbody tr").length;
  const heads = [...pane.querySelectorAll("thead th")].map(t => t.textContent);
  const q = pane.querySelector('[data-r="q"]');
  q.value = "deep"; q.dispatchEvent(new Event("input"));
  await wait(200);
  const filtered = pane.querySelectorAll("tbody tr").length;
  q.value = ""; q.dispatchEvent(new Event("input"));
  await wait(150);
  /* sort by depth descending */
  const th = [...pane.querySelectorAll("thead th")].find(t => /TOTAL DEPTH/.test(t.textContent));
  th.click(); await wait(120); th.click(); await wait(120);
  const firstRow = pane.querySelector("tbody tr").textContent;
  const csv = SBMM.datasets.csvOf(d);
  return { all, filtered, heads, firstRow, csvHead: csv.split("\n")[0], csvRows: csv.trim().split("\n").length - 1 };
});
console.log("dataset table:", dsTbl.all, "rows,", dsTbl.filtered, 'after searching "deep"; columns',
  dsTbl.heads.join("|"), "| sorted-desc first row:", dsTbl.firstRow.replace(/\s+/g, " ").trim());
console.log("dataset CSV re-export header:", dsTbl.csvHead, "|", dsTbl.csvRows, "rows");
if (dsTbl.all !== 3 || dsTbl.filtered !== 1) { console.log("FAIL: dataset table filter"); process.exit(1); }
if (!/TESTPIT-3/.test(dsTbl.firstRow)) { console.log("FAIL: dataset table sort by depth"); process.exit(1); }
if (dsTbl.csvRows !== 3 || !/ground_elev_ft/.test(dsTbl.csvHead)) { console.log("FAIL: dataset CSV re-export"); process.exit(1); }
await page.screenshot({ path: "/tmp/shotB_dataset_" + label.replace(/\W+/g, "_") + ".png" });
await page.evaluate(() => SBMM.table.toggle(false));

/* datasets snap, export and render in 3D */
dsIntegration = await page.evaluate(() => {
  SBMM.snap.invalidate();
  SBMM.snap.buildStatic();
  const w = SBMM.datasets.byId("wells").points[0];
  const hit = SBMM.snap.query(w.x, w.y, { tolPx: 40 });
  const gj = SBMM.io.collection("sp");
  const spec = SBMM.datasets.threeSpec();
  const sticks = spec.filter(s => s.stick);
  return {
    snapHit: !!hit, snapType: hit && hit.type,
    gjDatasetFeatures: gj.features.filter(f => f.properties.tool === "dataset").length,
    gjSample: gj.features.find(f => f.properties.tool === "dataset").properties.dataset,
    specs: spec.length, sticks: sticks.length,
    stickPts: sticks.reduce((a, s) => a + s.pts.filter(p => p.depth > 0).length, 0),
    dxfLayers: SBMM.datasets.dxfEntities().map(d => d.layer)
  };
});
console.log("dataset integration: osnap on a well head ->", dsIntegration.snapType,
  "| GeoJSON dataset features", dsIntegration.gjDatasetFeatures,
  "| 3D specs", dsIntegration.specs, "of which", dsIntegration.sticks,
  "draw sticks (" + dsIntegration.stickPts + " with a depth)",
  "| DXF layers", dsIntegration.dxfLayers.join(","));
if (!dsIntegration.snapHit) { console.log("FAIL: dataset points are not in the snap index"); process.exit(1); }
if (dsIntegration.gjDatasetFeatures < 139) { console.log("FAIL: datasets missing from the GeoJSON export"); process.exit(1); }
if (dsIntegration.stickPts < 100) { console.log("FAIL: 3D depth sticks have no depths"); process.exit(1); }

/* session round-trip: an imported dataset must survive save -> reload.
   Baked datasets must NOT be written into the file (they ship with the app). */
rt = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ser = SBMM.store.serialize();
  const written = (ser.datasets || []).map(d => d.name);
  const d = SBMM.datasets.list().find(x => x.name === "testpits");
  SBMM.datasets.remove(d);
  await wait(200);
  const gone = !SBMM.datasets.list().some(x => x.name === "testpits");
  SBMM.store.restore(JSON.parse(JSON.stringify(ser)));
  await wait(400);
  const back = SBMM.datasets.list().find(x => x.name === "testpits");
  return {
    version: ser.version, written, gone,
    restored: !!back, n: back && back.points.length, kind: back && back.kind,
    style: back && back.style.shape,
    row: [...document.querySelectorAll("#dataLayers .lyr")].some(l => /testpits/.test(l.textContent)),
    tab: [...document.querySelectorAll("#tblTabStrip .ttab")].some(t => /testpits/.test(t.textContent))
  };
});
console.log(`session v${rt.version}: writes ${JSON.stringify(rt.written)} (baked excluded), `
  + `removed ok ${rt.gone}, restored ${rt.restored} with ${rt.n} points as ${rt.kind}/${rt.style}, `
  + `row ${rt.row}, tab ${rt.tab}`);
if (rt.version !== 8) { console.log("FAIL: session version did not bump to 8"); process.exit(1); }
if (rt.written.length !== 1 || rt.written[0] !== "testpits") { console.log("FAIL: session should serialise imported datasets only"); process.exit(1); }
if (!rt.restored || rt.n !== 3 || !rt.row || !rt.tab) { console.log("FAIL: dataset did not survive the session round-trip"); process.exit(1); }
if (errors.length !== errBeforeDs) {
  console.log("FAIL: page errors in the dataset pathway:", errors.slice(errBeforeDs, errBeforeDs + 4)); process.exit(1);
}

/* an old session (v5, no datasets key) must still load — backward compatibility
   is a promise this file has kept since v2 */
oldLoad = await page.evaluate(() => {
  const before = SBMM.store.features.length;
  SBMM.store.restore({ app: "SBMM Site Explorer", version: 5, groups: [],
    features: [{ name: "legacy line", type: "line", pts: [[6371500, 2128900], [6371600, 2128950]], props: {} }] });
  return { before, after: SBMM.store.features.length };
});
console.log("v5 session (no datasets key) still loads:", oldLoad.after === oldLoad.before + 1);
if (oldLoad.after !== oldLoad.before + 1) { console.log("FAIL: v5 session no longer loads"); process.exit(1); }

/* ======================================================================
   9c. Phase-C audit regressions. Each of these was a real defect found by
   walking the app in test/audit.mjs; each one is cheap to re-break.
   ====================================================================== */

/* (i) Esc discipline (docs/V9_SPEC.md §2): Esc ALWAYS cancels the in-progress
       sketch, returns to Navigate and clears the tool-button highlight. There
       is no state in which a lit button sits over a torn-down sketch engine —
       that was the original bug — and since v9 there is also no second rule
       for a sketch that has vertices: one key, one destination. A lit tool
       must still accept a click whatever tore the sketch down. */
escArm = await page.evaluate(async () => {
  SBMM.cmd.open(false);
  const base = SBMM.store.features.length;      // leave the drawing alone: the screenshots use it
  const press = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  SBMM.tools.setTool(null); SBMM.tools.setTool("area");
  const armedTip = (document.getElementById("sketchTip").textContent || "").slice(0, 5);
  press(); await new Promise(r => setTimeout(r, 60));
  const emptyEsc = { tool: SBMM.tools.active(), lit: !!document.querySelector(".toolbtn.active[data-tool]") };

  SBMM.tools.setTool("area");
  SBMM.tools.mapClick(6371400, 2128700); SBMM.tools.mapClick(6371520, 2128700);
  press(); await new Promise(r => setTimeout(r, 60));
  const midEsc = { tool: SBMM.tools.active(), drawing: SBMM.draw.isDrawing(),
                   mode: SBMM.mode.current(),
                   lit: !!document.querySelector(".toolbtn.active[data-tool]"),
                   newFeats: SBMM.store.features.length - base };

  /* and a lit tool always accepts a click, whatever tore the sketch down */
  SBMM.mode.set("measure.area");
  SBMM.draw.cancel();
  SBMM.tools.mapClick(6371400, 2128700);
  const healed = SBMM.draw.isDrawing();
  SBMM.tools.setTool(null); SBMM.draw.cancel();
  return { armedTip, emptyEsc: Object.assign(emptyEsc, { mode: SBMM.mode.current() }), midEsc, healed };
});
console.log("Esc on an armed tool:", JSON.stringify(escArm));
if (escArm.emptyEsc.tool !== null || escArm.emptyEsc.lit || escArm.emptyEsc.mode !== "navigate")
  { console.log("FAIL: Esc on an empty sketch did not return to Navigate"); process.exit(1); }
if (escArm.midEsc.tool !== null || escArm.midEsc.drawing || escArm.midEsc.lit
    || escArm.midEsc.mode !== "navigate" || escArm.midEsc.newFeats !== 0)
  { console.log("FAIL: Esc mid-sketch must scrap the shape AND return to Navigate (§2)"); process.exit(1); }
if (!escArm.healed) { console.log("FAIL: a lit tool button swallowed a map click"); process.exit(1); }
if (!escArm.armedTip) { console.log("FAIL: arming a tool gives no on-map instruction"); process.exit(1); }

/* (ii) No command alias may be shadowed by an earlier command — REPORT's
       "SHEET" alias silently ate the sheet viewer's own. */
aliases = await page.evaluate(() => {
  const seen = new Map(), dup = [];
  for (const c of SBMM.cmd.commands())
    for (const a of [c.n, ...c.a]) {
      if (seen.has(a)) dup.push(`${a}: ${seen.get(a)} shadows ${c.n}`); else seen.set(a, c.n);
    }
  return { n: SBMM.cmd.commands().length, dup, sheetGoesTo: SBMM.cmd.find("SHEET").n };
});
console.log("command aliases:", aliases.n, "commands, collisions:", aliases.dup.length, "| SHEET ->", aliases.sheetGoesTo);
if (aliases.dup.length) { console.log("FAIL: shadowed command aliases:", aliases.dup); process.exit(1); }
if (aliases.sheetGoesTo !== "SHEETS") { console.log("FAIL: SHEET should open the drawing set"); process.exit(1); }

/* (iii) Overlay stacking: a sheet window must stay under the modals however
       many times it is brought to the front, and a toast must beat all of them
       (a toast behind a window is a failure report the user never sees). */
zorder = await page.evaluate(async () => {
  for (const s of SBMM.sheets.index().slice(0, 6)) SBMM.sheets.open(s.sheet);
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 40; i++) SBMM.sheets.open(SBMM.sheets.index()[i % 6].sheet);   // 40 raise-to-front
  const zs = [...document.querySelectorAll(".shwin")].map(e => +e.style.zIndex);
  toast("z-order probe");
  const zt = +getComputedStyle(document.getElementById("toast")).zIndex;
  SBMM.sheets.list();
  await new Promise(r => setTimeout(r, 60));
  const zp = +getComputedStyle(document.getElementById("sheetPicker")).zIndex;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  const pickerClosedByEsc = !document.getElementById("sheetPicker");
  SBMM.sheets.closeAll();
  await new Promise(r => setTimeout(r, 300));
  return { windows: zs.length, maxZ: Math.max(...zs), toastZ: zt, pickerZ: zp, pickerClosedByEsc,
           allClosed: SBMM.sheets.openCount() === 0 };
});
console.log("overlay z-order:", JSON.stringify(zorder));
if (!(zorder.maxZ < 5000)) { console.log("FAIL: sheet windows climbed into the modal band"); process.exit(1); }
if (!(zorder.toastZ > zorder.maxZ && zorder.toastZ > zorder.pickerZ))
  { console.log("FAIL: toasts are not above the floating windows"); process.exit(1); }
if (!(zorder.pickerZ > zorder.maxZ)) { console.log("FAIL: the SHEETS picker opens behind its own windows"); process.exit(1); }
if (!zorder.pickerClosedByEsc || !zorder.allClosed) { console.log("FAIL: Esc did not dismiss the sheet overlays"); process.exit(1); }

/* (iv) Focus scope: a focused sheet window owns its keys. Pressing 3 or T while
       reading a drawing used to open the 3D view / the table behind it. */
keyScope = await page.evaluate(async () => {
  SBMM.sheets.open("C-106");
  await new Promise(r => setTimeout(r, 300));
  const win = document.querySelector(".shwin");
  win.focus();
  const before = { d3: SBMM.viewer3d.isOpen(), tool: SBMM.tools.active() };
  for (const k of ["3", "t", "a", "v"])
    win.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const after = { d3: SBMM.viewer3d.isOpen(), tool: SBMM.tools.active() };
  SBMM.sheets.closeAll();
  await new Promise(r => setTimeout(r, 300));
  return { before, after };
});
console.log("keys while a sheet window has focus:", JSON.stringify(keyScope));
if (keyScope.after.d3 !== keyScope.before.d3 || keyScope.after.tool !== keyScope.before.tool)
  { console.log("FAIL: global shortcuts fired from inside a focused sheet window"); process.exit(1); }

/* (v) Pathological CSV: refuse cleanly, never half-import, and never lose a
       point to a repeated ID. */
csvGuard = await page.evaluate(async () => {
  const said = [];
  const orig = window.toast;
  window.toast = function (m) { said.push(String(m)); return orig.apply(this, arguments); };
  const run = async (text) => {
    const before = SBMM.datasets.list().length;
    SBMM.datasets.importCSV(text, "guard.csv");
    await new Promise(r => setTimeout(r, 150));
    const dlg = document.getElementById("dsDialog");
    const prev = dlg ? document.getElementById("dsPreview").textContent.replace(/\s+/g, " ") : "";
    let added = 0, pts = 0, markers = 0;
    if (dlg) {
      document.getElementById("dsGo").click();
      await new Promise(r => setTimeout(r, 200));
      const now = SBMM.datasets.list();
      added = now.length - before;
      if (added > 0) {
        const d = now[now.length - 1];
        pts = d.points.length;
        markers = d.points.filter(p => d.markerOf.get(p)).length;
        /* the points must stay plain JSON — the session file and the autosave
           serialise them verbatim */
        try { JSON.stringify(d.points); } catch (e) { markers = -1; }
        SBMM.datasets.remove(d);
      }
      const d2 = document.getElementById("dsDialog"); if (d2) d2.remove();
    }
    return { dialog: !!dlg, prev, added, pts, markers };
  };
  const dup = await run("ID,EASTING,NORTHING\nW-1,6371500,2128900\nW-1,6371600,2128950\nW-1,6371700,2129000\n");
  const partial = await run("ID,EASTING,NORTHING\nA,6371500,2128900\nB,n/a,2128950\nC,,\nD,6371700,2129000\n");
  const none = await run("ID,NAME\nA,alpha\nB,beta\n");
  const empty = await run("ID,EASTING,NORTHING\n");
  window.toast = orig;
  return { dup, partial, none, empty, said };
});
console.log("CSV guard — duplicate IDs:", JSON.stringify(csvGuard.dup).slice(0, 150));
console.log("CSV guard — partial:", csvGuard.partial.added, "added,", csvGuard.partial.pts, "points |",
            "no coords:", csvGuard.none.added, "added |", "header only:", csvGuard.empty.dialog ? "dialog" : "refused");
if (csvGuard.dup.pts !== 3 || csvGuard.dup.markers !== 3)
  { console.log("FAIL: repeated IDs lost a point or its marker"); process.exit(1); }
if (!/repeated ID/.test(csvGuard.dup.prev)) { console.log("FAIL: repeated IDs are not disclosed before import"); process.exit(1); }
if (csvGuard.partial.pts !== 2 || !/skipped/.test(csvGuard.partial.prev))
  { console.log("FAIL: rows without coordinates were not reported"); process.exit(1); }
if (csvGuard.none.added !== 0 || csvGuard.empty.dialog)
  { console.log("FAIL: a coordinate-free CSV was not refused cleanly"); process.exit(1); }
if (!csvGuard.said.some(m => /skipped/.test(m))) { console.log("FAIL: no toast reported the skipped rows"); process.exit(1); }

/* (vi) The terrain payload strings are released once decoded — 28 MB of base64
       that nothing reads twice. The keys must still exist (dual-build contract). */
released = await page.evaluate(() => ({
  keys: ["dem_site_png", "dem_abp_png", "chm_png"].every(k => k in SBMM_DATA),
  nulled: ["dem_site_png", "dem_abp_png", "chm_png"].filter(k => SBMM_DATA[k] === null),
  elev: SBMM.elev(6371600, 2128900)[0],
  canopy: SBMM.canopy(6371600, 2128900)
}));
console.log("terrain payloads released after decode:", JSON.stringify(released));
if (!released.keys) { console.log("FAIL: a terrain payload key disappeared"); process.exit(1); }
if (released.nulled.length !== 3) { console.log("FAIL: decoded terrain base64 is still retained"); process.exit(1); }
if (isNaN(released.elev) || isNaN(released.canopy)) { console.log("FAIL: releasing the payload broke the terrain"); process.exit(1); }

/* (vi-b) v11: the terrain payloads decode in workers, and the worker path and the
       main-thread fallback produce the SAME Float32Array. The comparison runs on a
       small synthetic terrain-RGB PNG built in the page (including NoData pixels),
       so it needs no real payload and cannot be fooled by one already released. */
demWork = await page.evaluate(async () => {
  const w = 64, h = 48;
  const meta = { w, h, zmin: 1000, step: 0.05, x0: 0, y0: 0, cell: 1 };
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  const im = g.createImageData(w, h);
  for (let i = 0, n = w * h; i < n; i++) {
    const v = (i % 37 === 3) ? 0 : (i * 613) % 65536;   /* a scatter of NoData */
    im.data[i * 4] = v >> 8; im.data[i * 4 + 1] = v & 255;
    im.data[i * 4 + 2] = 0; im.data[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const url = c.toDataURL("image/png");
  SBMM_DATA.__demtest = meta; SBMM_DATA.__demtest_png = url;
  const main = await Dem.load("__demtest", { release: false });
  const wk = await Dem.decodeInWorker("__demtest", meta, url);
  delete SBMM_DATA.__demtest; delete SBMM_DATA.__demtest_png;
  const out = { workers: SBMM.perf.demWorkers, decode: SBMM.perf.demDecode || null,
                viaWorker: !!wk, n: main.z.length, diff: -1, nan: 0 };
  if (!wk) return out;
  let diff = 0, nan = 0;
  for (let i = 0; i < main.z.length; i++) {
    if (isNaN(main.z[i])) nan++;
    if (!Object.is(main.z[i], wk.z[i])) diff++;
  }
  out.diff = diff; out.nan = nan; out.nodata = wk.nodata;
  return out;
});
console.log("terrain decode in workers:", JSON.stringify(demWork));
if (!(demWork.workers >= 3))
  { console.log("FAIL: terrain decode did not run in workers (SBMM.perf.demWorkers =", demWork.workers, ")"); process.exit(1); }
if (!demWork.viaWorker) { console.log("FAIL: the decode worker refused a synthetic payload"); process.exit(1); }
if (demWork.diff !== 0) { console.log("FAIL: worker and main-thread decodes differ in", demWork.diff, "of", demWork.n, "cells"); process.exit(1); }
if (demWork.nan === 0 || demWork.nan !== demWork.nodata)
  { console.log("FAIL: NoData was not carried across identically (", demWork.nan, "vs", demWork.nodata, ")"); process.exit(1); }

/* (vii) Modal overlays all answer Esc, and HELP twice leaves one overlay. */
escModals = await page.evaluate(async () => {
  const press = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const out = {};
  document.getElementById("helpBtn").click();
  await new Promise(r => setTimeout(r, 60));
  out.helpOpened = getComputedStyle(document.getElementById("help")).display === "flex";
  press(); await new Promise(r => setTimeout(r, 60));
  out.helpClosed = getComputedStyle(document.getElementById("help")).display === "none";
  SBMM.cmd.showHelp(); SBMM.cmd.showHelp();
  await new Promise(r => setTimeout(r, 60));
  out.cmdHelpOverlays = document.querySelectorAll("#cmdHelp").length;
  press(); await new Promise(r => setTimeout(r, 60));
  out.cmdHelpClosed = !document.getElementById("cmdHelp");
  SBMM.datasets.importCSV("ID,EASTING,NORTHING\nA,6371500,2128900\n", "esc.csv");
  await new Promise(r => setTimeout(r, 120));
  out.dialogOpened = !!document.getElementById("dsDialog");
  press(); await new Promise(r => setTimeout(r, 80));
  out.dialogClosed = !document.getElementById("dsDialog");
  return out;
});
console.log("Esc across the modal overlays:", JSON.stringify(escModals));
for (const k of ["helpOpened", "helpClosed", "cmdHelpClosed", "dialogOpened", "dialogClosed"])
  if (!escModals[k]) { console.log("FAIL: Esc behaviour inconsistent —", k); process.exit(1); }
if (escModals.cmdHelpOverlays !== 1) { console.log("FAIL: HELP twice stacked two overlays"); process.exit(1); }
});


/* ==================================================================== */
let errBeforeDrain, drainT0, drainRun, drainTip, drainInto, drainAgree, drainExp, drain3d, drainOff, drainSess;   /* hoisted — v18 §3 */
await block("9x. drainage", async () => {
/* 9x. drainage — the whole-site catchment map (v14, docs/V14_DRAINAGE_SPEC.md) */
/* ==================================================================== */
/* The kernel's own acceptance test — 100 raindrops against the label raster —
   lives in test/kernels.mjs, where it runs in node in 145 s. What is proved
   HERE is that the app wires it up: that DRAIN runs the job in a worker and
   builds the rows, the polygons, the card and the popups; that a raindrop
   traced through the app's own code path lands in the catchment the app drew
   under it; that the storm switch invalidates it; and that none of it leaks
   into a session. Ten raindrops rather than the spec's twenty, because each one
   chains up to eight worker jobs on a software-GL box and the hundred are
   already proven in node on the same kernel. */
errBeforeDrain = errors.length;
drainT0 = Date.now();
drainRun = await page.evaluate(async () => {
  SBMM.cmd.open(false);
  const t0 = performance.now();
  const R = await SBMM.drainage.run();
  if (!R) return { failed: true };
  SBMM.drainage.paint();
  SBMM.drainage.showCard();
  SBMM.layerState.set("framework", "drain_outlet", { on: true });
  SBMM.layerState.set("framework", "drain_first", { on: true });
  const polys = R.sinks.reduce((a, s) => a + s.rings.length, 0);
  const firstPolys = R.ponds.reduce((a, p) => a + p.contributing_rings.length, 0)
                   + R.inlets.reduce((a, q) => a + q.rings.length, 0);
  return {
    ms: Math.round(performance.now() - t0),
    grid: R.gridFt, storm: R.storm,
    acres: +(R.surveyedArea_ft2 / 43560).toFixed(1),
    sinks: R.sinks.map(s => SBMM.drainage.sinkName(s)),
    polys, firstPolys,
    ponds: R.ponds.length, inlets: R.inlets.length,
    loops: R.loops, flats: R.flats, pondSinks: R.pondSinks,
    rows: ["drain_outlet", "drain_first", "drain_paths"]
      .map(id => !!document.querySelector(`.lyr[data-lid="${id}"]`)),
    card: [...document.querySelectorAll("#resBody .res h4")]
      .some(h => /Drainage map/.test(h.textContent))
  };
});
console.log("drainage map:", JSON.stringify(drainRun));
if (drainRun.failed) { console.log("FAIL: DRAIN produced no map"); process.exit(1); }
if (Date.now() - drainT0 > 30000) { console.log("FAIL: the drainage map took over 30 s"); process.exit(1); }
if (!drainRun.rows.every(Boolean)) { console.log("FAIL: the three drainage rows are not in the tree"); process.exit(1); }
if (!drainRun.card) { console.log("FAIL: no Drainage map results card"); process.exit(1); }
if (drainRun.polys < 12) { console.log("FAIL: the by-outlet layer has fewer than 12 polygons"); process.exit(1); }
if (drainRun.firstPolys < 8) { console.log("FAIL: the by-first-capture layer is empty"); process.exit(1); }
/* the pointer field must be acyclic and complete. A handful of one-cell CLOSED
   depressions is the grid's own answer, not a defect; a loop or a flat is. */
if (drainRun.loops || drainRun.flats)
  { console.log("FAIL: the pointer field left cells unresolved"); process.exit(1); }
if (drainRun.pondSinks > 8)
  { console.log("FAIL: too many cells drain nowhere:", drainRun.pondSinks); process.exit(1); }
if (!/Clear Lake outfall/.test(drainRun.sinks.join("|")))
  { console.log("FAIL: the storm outfall is not one of the outlets"); process.exit(1); }

/* the tooltip a hover gets: the app's own polygon binding, not a re-derivation */
drainTip = await page.evaluate(() => {
  /* inside the Herman impoundment, whose first capture is the impoundment
     itself — the biggest and least ambiguous catchment on the site */
  const lab = SBMM.drainage.firstAt(6372119.56, 2127446.20);
  const rec = SBMM.drainage.recOf(lab);
  const outLab = SBMM.drainage.labelAt(6372119.56, 2127446.20);
  const outRec = SBMM.drainage.recOf(outLab);
  let tip = null;
  SBMM.map.eachLayer(l => {
    if (tip || !l.getTooltip || !l.getTooltip()) return;
    const c = l.getTooltip().getContent();
    if (typeof c === "string" && rec && c.includes(SBMM.drainage.nameOf(rec))) tip = c;
  });
  return { first: rec ? SBMM.drainage.nameOf(rec) : null,
           outlet: outRec ? SBMM.drainage.nameOf(outRec) : null, tip };
});
console.log("hover inside the impoundment:", JSON.stringify(drainTip));
if (!drainTip.tip || !/ac$/.test(drainTip.tip.trim()))
  { console.log("FAIL: a catchment has no '-> outlet . acres' tooltip"); process.exit(1); }
if (!/outfall|Clear Lake/.test(drainTip.outlet || ""))
  { console.log("FAIL: the impoundment does not drain to the outfall"); process.exit(1); }

/* "show what drains here" on the outfall node, from the storm popup's own action */
drainInto = await page.evaluate(async () => {
  const n = SBMM.storm.node("outfall");
  const hi = await SBMM.drainage.showInto({ node: "outfall", title: n.name });
  const R = SBMM.drainage.result();
  const outfall = R.sinks.find(s => s.kind === "outfall");
  /* the popup really carries the action, rather than the test inventing it */
  const html = SBMM.popups.forStorm(n, null);
  return { catchments: hi ? hi.labels.length : 0, acres: hi ? hi.acres : null,
           rowAcres: outfall ? +(outfall.area_ft2 / 43560).toFixed(3) : null,
           inPopup: /show what drains here/.test(html),
           card: [...document.querySelectorAll("#resBody .res h4")]
             .some(h => /Drains to/.test(h.textContent)) };
});
console.log("show what drains here (outfall):", JSON.stringify(drainInto));
if (!drainInto.inPopup) { console.log("FAIL: a storm popup has no 'show what drains here'"); process.exit(1); }
if (drainInto.catchments < 10) { console.log("FAIL: the outfall highlighted fewer than 10 catchments"); process.exit(1); }
if (Math.abs(drainInto.acres - drainInto.rowAcres) > 0.1)
  { console.log("FAIL: the highlight's acres disagree with the outlet row"); process.exit(1); }
if (!drainInto.card) { console.log("FAIL: 'show what drains here' printed no card"); process.exit(1); }
await page.evaluate(() => SBMM.drainage.paint());

/* the identity, through the app's own raindrop */
drainAgree = await page.evaluate(async () => {
  let seed = 20260904;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const m = SBMM.demSite.m, pts = [];
  while (pts.length < 10) {
    const x = m.x0 + rnd() * (m.w - 1) * m.cell, y = m.y0 + rnd() * (m.h - 1) * m.cell;
    const i = Math.round((x - m.x0) / m.cell), j = Math.round((y - m.y0) / m.cell);
    if (isNaN(SBMM.demSite.atGrid(i, j))) continue;
    pts.push([m.x0 + i * m.cell, m.y0 + j * m.cell]);
  }
  let agree = 0;
  const bad = [];
  for (const [x, y] of pts) {
    const f = await SBMM.water.dropAt(x, y, { quiet: true, storm: true });
    if (!f) { bad.push("no run at " + x.toFixed(0)); continue; }
    const want = SBMM.drainage.labelAt(x, y);
    const end = f.props.end;
    /* The map's own answer where the run stopped. Two cases the label raster
       cannot answer directly: a run that went down a pipe left the model at the
       outfall, and a run that ended ON a NoData cell (the survey edge, Clear
       Lake) has no label there at all — so walk back to the last vertex that
       still has surveyed ground under it. A run the host cut at its window cap
       has not reached a sink either, and the same walk-back is the honest
       comparison: as far as it got, the map keeps it in one catchment. */
    const outfall = f.props.outfall;
    let got = -1;
    if (outfall) got = (SBMM.drainage.result().sinks.find(s => s.kind === "outfall") || {}).label;
    else {
      got = SBMM.drainage.labelAt(end.x, end.y);
      for (let k = f.pts.length - 1; k >= 0 && got < 0; k--)
        got = SBMM.drainage.labelAt(f.pts[k][0], f.pts[k][1]);
    }
    if (got === want) agree++;
    else bad.push(`E${x.toFixed(0)} drop=${SBMM.drainage.nameOf(SBMM.drainage.recOf(got))} `
                + `map=${SBMM.drainage.nameOf(SBMM.drainage.recOf(want))} (${end.reason})`);
    SBMM.tools.deleteFeature(f);
  }
  return { agree, n: pts.length, bad };
});
console.log("raindrops that land in their own catchment:", JSON.stringify(drainAgree));
if (drainAgree.agree < drainAgree.n - 1)
  { console.log("FAIL: the raindrop and the drainage map disagree"); process.exit(1); }

/* the exports */
drainExp = await page.evaluate(() => {
  const P = p => [p[0], p[1]];
  const gj = SBMM.drainage.geoFeatures(P);
  const dxf = SBMM.drainage.dxfEntities();
  return {
    n: gj.length,
    everyOutlet: gj.every(f => typeof f.properties.outlet === "string" && f.properties.outlet.length),
    layers: [...new Set(gj.map(f => f.properties.layer))].sort(),
    dxfLayers: [...new Set(dxf.map(d => d.layer))].sort(),
    source: gj.every(f => f.properties.source === "SBMM drainage v14")
  };
});
console.log("drainage exports:", JSON.stringify(drainExp));
if (!drainExp.everyOutlet || !drainExp.source)
  { console.log("FAIL: a drainage GeoJSON feature has no outlet/source"); process.exit(1); }
for (const L of ["DRAIN-OUTLET", "DRAIN-FIRST", "DRAIN-PATH"]) {
  if (!drainExp.layers.includes(L)) { console.log("FAIL: GeoJSON is missing " + L); process.exit(1); }
  if (!drainExp.dxfLayers.includes(L)) { console.log("FAIL: DXF is missing " + L); process.exit(1); }
}

/* 3D: the catchments are draped and tagged for the pick registry */
drain3d = await page.evaluate(() => {
  const r = SBMM.drainage.rings3d();
  return { rings: r.length, tagged: r.every(q => q.props && q.props.layer && q.geom) };
});
console.log("drainage in 3D:", JSON.stringify(drain3d));
if (drain3d.rings < 12 || !drain3d.tagged)
  { console.log("FAIL: the drainage catchments are not drapeable/pickable in 3D"); process.exit(1); }

/* the storm switch invalidates the map, and the inlet catchments go with it */
drainOff = await page.evaluate(async () => {
  SBMM.storm.setEnabled(false, true);
  const R = await SBMM.drainage.run({ force: true });
  const back = { inletSinks: R.sinks.filter(s => s.kind === "outfall").length,
                 conduits: R.conduits, inlets: R.inlets.length,
                 outlets: R.sinks.map(s => s.kind).sort().join(","),
                 sameGround: R.surveyedCells };
  SBMM.storm.setEnabled(true, true);
  const R2 = await SBMM.drainage.run({ force: true });
  SBMM.drainage.paint();
  back.backAgain = R2.sinks.filter(s => s.kind === "outfall").length;
  back.sameGroundBack = R2.surveyedCells;
  return back;
});
console.log("drainage with the storm drains off:", JSON.stringify(drainOff));
if (drainOff.inletSinks !== 0 || drainOff.conduits !== 0 || drainOff.inlets !== 0)
  { console.log("FAIL: the drains-off map still has inlet catchments"); process.exit(1); }
if (drainOff.backAgain !== 1) { console.log("FAIL: switching the drains back on lost the outfall"); process.exit(1); }
if (drainOff.sameGround !== drainOff.sameGroundBack)
  { console.log("FAIL: the surveyed ground changed with the switch"); process.exit(1); }

/* read-only project analysis: nothing here is a store feature and nothing of it
   serialises (the layer STATE does, like every other layer's) */
drainSess = await page.evaluate(() => {
  const s = JSON.parse(JSON.stringify(SBMM.store.serialize()));
  const txt = JSON.stringify(s);
  return { feats: (s.features || []).filter(f => /drain/i.test(f.type || "")).length,
           mentions: (txt.match(/SBMM drainage v14/g) || []).length,
           layerState: !!(s.layers && s.layers.framework && "drain_outlet" in s.layers.framework),
           /* SBMM.undo.labels() is {undo, redo}, not a list */
           undo: Object.values(SBMM.undo.labels()).filter(l => l && /drain/i.test(l)).length };
});
console.log("drainage in a session:", JSON.stringify(drainSess));
if (drainSess.feats || drainSess.mentions || drainSess.undo)
  { console.log("FAIL: the drainage map leaked into the session or the undo stack"); process.exit(1); }
if (!drainSess.layerState) { console.log("FAIL: the drainage layer state does not serialise"); process.exit(1); }

if (errors.length !== errBeforeDrain) {
  console.log("FAIL: the drainage map raised page errors:", errors.slice(errBeforeDrain, errBeforeDrain + 4));
  process.exit(1);
}
await page.evaluate(() => {
  SBMM.layerState.set("framework", "drain_outlet", { on: false });
  SBMM.layerState.set("framework", "drain_first", { on: false });
});
});

/* ==================================================================== */
let errBeforeRain, rainDlg, rainT0, rainRun, herman, rainOv, rainOut, rainRows, rainSess;   /* hoisted — v18 §3 */
await block("9aa. design storm", async () => {
/* 9aa. design storm — rainfall and runoff (v14 Phase 2,                */
/*      docs/V14_PHASE2_RUNOFF_SPEC.md §3)                              */
/* ==================================================================== */
/* The arithmetic is proved in node (test/kernels.mjs §12, against TR-55's own
   equations and the kernel's own volume identities). What is proved HERE is
   that the app wires it up: RAIN opens the dialog, the run produces the card
   with its catchment and pond rows, the provisional warning tells the truth
   about the baked rainfall, a drawn cover override really changes a curve
   number, the report and the CSV come out, the two layer rows draw, and none
   of it — except the override, which is an ordinary area feature — reaches the
   session or spawns a job on reload. The drainage map computed in 9x is reused,
   so this costs one runoff job and three stage tables.

   It runs BEFORE the 3D-parity table (9y) on purpose: that block turns every
   layer row on and requires each one to draw something in 3D, and the
   runoff-depth row can only draw a catchment once a storm has been run. */
errBeforeRain = errors.length;

/* the command opens the dialog, and RAIN belongs to exactly one command */
rainDlg = await page.evaluate(() => {
  SBMM.cmd.run("RAIN");
  const box = document.getElementById("rainDlg");
  const out = {
    open: !!box,
    storms: box ? [...box.querySelectorAll("#rnStorm option")].map(o => o.textContent.trim()) : [],
    warn: box ? !!box.querySelector(".mnote .bad") : false,
    classes: box ? box.querySelectorAll("#rnCls option").length : 0,
    provisional: SBMM.runoff.provisional()
  };
  if (box) box.remove();
  return out;
});
console.log("RAIN dialog:", JSON.stringify(rainDlg));
if (!rainDlg.open) { console.log("FAIL: RAIN did not open the Design storm dialog"); process.exit(1); }
if (rainDlg.storms.length < 5) { console.log("FAIL: the dialog offers fewer than five storms"); process.exit(1); }
if (rainDlg.classes < 5) { console.log("FAIL: the dialog has no cover classes to assign"); process.exit(1); }
/* the warning is not decoration: it must agree with the payload */
if (rainDlg.warn !== rainDlg.provisional)
  { console.log("FAIL: the provisional-rainfall warning disagrees with the payload"); process.exit(1); }

rainT0 = Date.now();
rainRun = await page.evaluate(async () => {
  const R = await SBMM.runoff.run({ storm: "25:24" });
  if (!R) return { failed: true };
  const rowsFor = re => [...document.querySelectorAll("#resBody .res")]
    .filter(el => re.test(el.querySelector("h4").textContent));
  const cardEl = rowsFor(/Design storm/)[0] || null;
  const tables = cardEl ? [...cardEl.querySelectorAll("table.runoffT")] : [];
  return {
    storm: R.storm.name, P: R.storm.P, provisional: R.provisional,
    outlets: R.outlets.length, first: R.first.length,
    cn: R.totals.cn, volume: +R.totals.volume_acft.toFixed(2),
    peak: R.totals.qPeak_cfs,
    routing: R.routing.map(r => ({ name: r.name, peak: r.peakLevel, rim: r.rimLevel,
                                   conduit: r.conduitLevel, over: r.overtops,
                                   bal: r.balance_pct })),
    card: !!cardEl,
    catchmentRows: tables.length ? tables[0].querySelectorAll("tr").length - 1 : 0,
    pondRows: tables.length > 1 ? tables[1].querySelectorAll("tr").length - 1 : 0,
    warnOnCard: cardEl ? !!cardEl.querySelector(".rnProv") : false,
    chart: cardEl ? !!cardEl.querySelector("svg.hydro path") : false,
    assumptions: cardEl ? /Soil group|soil group/.test(cardEl.textContent) : false,
    hasHydro: R.outlets.every(c => c.hydro && c.hydro.q.length > 10),
    everyCN: R.outlets.every(c => c.cn > 0 && c.cn <= 100)
  };
});
console.log("design storm:", JSON.stringify(rainRun));
if (rainRun.failed) { console.log("FAIL: the design storm produced nothing"); process.exit(1); }
if (Date.now() - rainT0 > 60000) { console.log("FAIL: the design storm took over 60 s"); process.exit(1); }
if (!rainRun.card) { console.log("FAIL: no Design storm results card"); process.exit(1); }
if (rainRun.catchmentRows < 4) { console.log("FAIL: fewer than four catchment rows"); process.exit(1); }
if (rainRun.pondRows < 3) { console.log("FAIL: fewer than three pond routing rows"); process.exit(1); }
/* the routed ponds are the NAMED water bodies, not all 60 lidar depressions */
if (!rainRun.routing.every(r => !/^Depression · /.test(r.name)))
  { console.log("FAIL: an unnamed lidar depression was routed:",
                rainRun.routing.filter(r => /^Depression · /.test(r.name)).map(r => r.name)); process.exit(1); }
if (!rainRun.everyCN) { console.log("FAIL: a catchment has no curve number"); process.exit(1); }
if (!rainRun.hasHydro) { console.log("FAIL: a catchment has no hydrograph"); process.exit(1); }
if (!rainRun.chart) { console.log("FAIL: the card has no hydrograph chart"); process.exit(1); }
if (!rainRun.assumptions) { console.log("FAIL: the card does not print the assumptions"); process.exit(1); }
if (rainRun.warnOnCard !== rainRun.provisional)
  { console.log("FAIL: the card's provisional warning disagrees with the payload"); process.exit(1); }
/* the routing conserves volume — the same identity the node harness asserts */
for (const r of rainRun.routing) {
  if (Math.abs(r.bal) > 0.5) {
    console.log("FAIL: level-pool routing lost volume at " + r.name + ": " + r.bal + " %");
    process.exit(1);
  }
}
/* the impoundment is routed against the surveyed stages, not the lidar's */
herman = rainRun.routing.find(r => /Herman/i.test(r.name));
if (!herman) { console.log("FAIL: the impoundment was not routed"); process.exit(1); }
if (Math.abs(herman.rim - 1343.84) > 0.05)
  { console.log("FAIL: the impoundment's rim moved from 1343.84:", herman.rim); process.exit(1); }
if (herman.conduit == null || Math.abs(herman.conduit - 1341.55) > 0.1)
  { console.log("FAIL: the impoundment's first discharge is not the surveyed pipe:", herman.conduit); process.exit(1); }

/* a drawn cover override really changes a curve number */
rainOv = await page.evaluate(async () => {
  const R = SBMM.runoff.result();
  const big = R.outlets.slice().sort((a, b) => b.area_ft2 - a.area_ft2)[0];
  const before = big.cn;
  /* a square inside the impoundment's catchment, made paved: the CN can only go up */
  const x = 6372119.56, y = 2127446.20, s = 400;
  const f = SBMM.tools.rebuildFeature({ type: "area", name: "Cover override",
    pts: [[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]], props: {} });
  SBMM.runoff.assignCover("paved", f);
  const R2 = await SBMM.runoff.run({});
  const after = (R2.outlets.find(c => c.label === big.label) || {}).cn;
  return { id: f.id, name: big.name, before, after,
           overrides: SBMM.runoff.overrides().length,
           prop: f.props.cover };
});
console.log("cover override:", JSON.stringify(rainOv));
if (rainOv.prop !== "paved") { console.log("FAIL: the override area did not take the cover class"); process.exit(1); }
if (!(rainOv.after > rainOv.before))
  { console.log("FAIL: a paved override did not raise the catchment's CN"); process.exit(1); }

/* the report sheet and the CSV */
rainOut = await page.evaluate(() => {
  const html = SBMM.report.runoffHTML(SBMM.runoff.result());
  const csv = SBMM.runoff.csv();
  const opened = !!SBMM.report.openRunoff(SBMM.runoff.result());
  const modal = !!document.getElementById("reportModal");
  const box = document.getElementById("reportModal");
  if (box) box.remove();
  return {
    opened, modal,
    /* the assumptions table comes FIRST, before any quantity */
    assumptionsFirst: html.indexOf("Assumptions") < html.indexOf("Runoff by catchment"),
    hsg: /D for mine waste/.test(html),
    weir: /3.0/.test(html) && /weir/i.test(html),
    author: /Mohammad Sharif/.test(html),
    csvHead: csv.split("\n")[0],
    csvCat: /catchment,kind,acres,CN/.test(csv),
    csvRoute: /pond routing/.test(csv),
    csvAssume: /assumptions/.test(csv),
    csvCover: /cover class,acres/.test(csv)
  };
});
console.log("design storm report/CSV:", JSON.stringify(rainOut));
if (!rainOut.opened || !rainOut.modal) { console.log("FAIL: the design-storm report did not open"); process.exit(1); }
if (!rainOut.assumptionsFirst) { console.log("FAIL: the report does not lead with the assumptions"); process.exit(1); }
if (!rainOut.hsg || !rainOut.weir) { console.log("FAIL: the report omits an assumption it rests on"); process.exit(1); }
if (!rainOut.author) { console.log("FAIL: the report has no author block"); process.exit(1); }
if (!rainOut.csvCat || !rainOut.csvRoute || !rainOut.csvAssume || !rainOut.csvCover)
  { console.log("FAIL: the design-storm CSV is missing a block"); process.exit(1); }

/* the two layer rows draw */
rainRows = await page.evaluate(async () => {
  /* the cover raster is an image overlay and the site already has several, so
     the honest test is that ticking the row ADDS one */
  const countImgs = () => { let n = 0; SBMM.map.eachLayer(l => { if (l instanceof L.ImageOverlay) n++; }); return n; };
  const imgs0 = countImgs();
  SBMM.layerState.set("framework", "runoff_cover", { on: true });
  SBMM.layerState.set("framework", "runoff_depth", { on: true });
  await new Promise(r => setTimeout(r, 500));
  let polys = 0;
  const imgs = countImgs() - imgs0;
  SBMM.map.eachLayer(l => {
    if (l instanceof L.Polygon && l.options.fillOpacity === 0.34) polys++;
  });
  const legend = document.querySelectorAll(".rnLegend .rnLeg").length;
  const pop = SBMM.popups.forRunoff(SBMM.runoff.result().outlets[0].label);
  return {
    rows: ["runoff_cover", "runoff_depth"].map(id => !!document.querySelector(`.lyr[data-lid="${id}"]`)),
    imgs, polys, legend,
    popup: /Curve number/.test(pop) && /Runoff volume/.test(pop),
    popupAssumption: /provisional|Atlas 14|composite/.test(pop)
  };
});
console.log("design storm layers:", JSON.stringify(rainRows));
if (!rainRows.rows.every(Boolean)) { console.log("FAIL: the design-storm rows are not in the tree"); process.exit(1); }
if (rainRows.polys < 4) { console.log("FAIL: the runoff-depth choropleth drew nothing"); process.exit(1); }
if (rainRows.imgs < 1) { console.log("FAIL: the cover raster did not reach the map"); process.exit(1); }
if (!rainRows.legend) { console.log("FAIL: the cover row has no CN legend"); process.exit(1); }
if (!rainRows.popup) { console.log("FAIL: the runoff popup does not name its numbers"); process.exit(1); }

/* the session: the override rides in it, the analysis does not, and loading a
   session does not re-run the storm.

   The job count is REPORTED rather than asserted at zero, and the reason is not
   the design storm: SBMM.store.restore() rebuilds every feature it reads, and a
   `volume` feature recomputes its quantities from geometry by design
   (js/tools.js rebuildFeature -> compVolume), so a store carrying the blocks
   above spawns a handful of volume jobs whatever this module does. What IS
   asserted is the contract this block owns — the analysis object is untouched,
   so nothing here recomputed. */
rainSess = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ser = JSON.parse(JSON.stringify(SBMM.store.serialize()));
  const txt = JSON.stringify(ser);
  const jobs0 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  const before = SBMM.runoff.result();
  SBMM.store.restore(JSON.parse(JSON.stringify(ser)));
  await wait(600);
  const jobs1 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  /* restore() ADDS features rather than replacing them, so the override comes
     back beside the original — what matters is that it came back at all, with
     its cover class still on it */
  const back = SBMM.store.features.filter(f => f.props && f.props.cover === "paved").length;
  return {
    covers: (txt.match(/"cover":"paved"/g) || []).length,
    analysis: (txt.match(/design storm|qPeak_cfs|tcSegments/gi) || []).length,
    jobs: jobs1 - jobs0, back,
    sameResult: SBMM.runoff.result() === before,
    layerState: !!(ser.layers && ser.layers.framework && "runoff_cover" in ser.layers.framework)
  };
});
console.log("design storm in a session:", JSON.stringify(rainSess),
            "(the jobs are the store's own volume features recomputing on restore)");
if (!rainSess.covers) { console.log("FAIL: the cover override did not serialise"); process.exit(1); }
if (!rainSess.back) { console.log("FAIL: the cover override did not survive the round trip"); process.exit(1); }
if (rainSess.analysis) { console.log("FAIL: the design storm leaked into the session"); process.exit(1); }
if (!rainSess.sameResult) { console.log("FAIL: loading a session re-ran the design storm"); process.exit(1); }
if (!rainSess.layerState) { console.log("FAIL: the design-storm layer state does not serialise"); process.exit(1); }

if (errors.length !== errBeforeRain) {
  console.log("FAIL: the design storm raised page errors:", errors.slice(errBeforeRain, errBeforeRain + 4));
  process.exit(1);
}
await page.evaluate(() => {
  SBMM.layerState.set("framework", "runoff_cover", { on: false });
  SBMM.layerState.set("framework", "runoff_depth", { on: false });
  for (const f of SBMM.store.features.filter(g => g.props && g.props.cover)) SBMM.tools.deleteFeature(f);
});
});

/* ==================================================================== */
let errBeforeAcc, accRun, accHover, accIdent, accStreams, acc3d, pipeRun, pipePop,
    pipeColor, scnRun, scnCmp, scnDiff, scnSess;   /* hoisted — v18 §3 */
await block("9ab. accumulation + pipes", async () => {
/* 9ab. flow accumulation, pipe capacity and scenarios                  */
/*      (v19 Phase 3, docs/V19_HYDRO3_SPEC.md §5)                       */
/* ==================================================================== */
/* The arithmetic is proved in node: the accumulation's conservation and its
   D-infinity proportions in test/kernels.mjs §13, Manning / HEC-22 / the energy
   balance in §14, and THE IDENTITY — what leaves the model at each cell, summed
   by the drainage map's own label, is that outlet's Phase 1 area — in §11.8,
   where it is exact to 0.000 %. What is proved HERE is that the app wires it up:
   ACCUM builds the rows, the raster, the streams and the card; the status bar
   reads the upstream acres under the pointer; the card's own cross-check against
   the drainage map agrees; PIPES rates what can be rated and says "survey
   pending" for the rest, on the card and in the conduit popup; and a pair of
   scenarios runs, compares, diffs and round-trips a session without recomputing
   anything.

   It runs AFTER 9aa and BEFORE 9y on purpose. 9aa's design storm already asks
   js/accum.js for the D8 raster (that is what Phase 2's channel test reads), so
   the accumulation is cached by the time this block opens; and 9y turns every
   row on and requires each to draw something in 3D, which the two new rows can
   only do once the job has run. */
errBeforeAcc = errors.length;

accRun = await page.evaluate(async () => {
  const imgs0 = document.querySelectorAll("#map img.leaflet-image-layer").length;
  SBMM.cmd.run("ACCUM");
  const t0 = performance.now();
  const R = await SBMM.accum.run();
  if (!R) return { failed: true };
  SBMM.accum.paint();
  SBMM.accum.showCard();
  await new Promise(r => setTimeout(r, 400));
  let lines = 0;
  SBMM.map.eachLayer(l => { if (l instanceof L.Polyline && !(l instanceof L.Polygon)
    && l.options && l.options.color === "#3FB9B0") lines++; });
  return {
    ms: Math.round(performance.now() - t0),
    method: R.method, grid: R.gridFt, dCell: R.dCell,
    maxAcc_ac: +R.maxAcc_ac.toFixed(2),
    streams: R.streamCount, links: R.streamLinks, order: R.maxOrder,
    lengthMi: +(R.streamLength_ft / 5280).toFixed(2),
    loops: R.loops, flats: R.flats,
    surveyed_ac: +(R.surveyedArea_ft2 / 43560).toFixed(2),
    exit_ac: +(R.exitTotal_ft2 / 43560).toFixed(2),
    imgs: document.querySelectorAll("#map img.leaflet-image-layer").length - imgs0,
    lines,
    rows: ["accum_raster", "accum_streams"].map(id => !!document.querySelector(`.lyr[data-lid="${id}"]`)),
    legend: document.querySelectorAll(".rnLegend .rnLeg").length > 0,
    card: [...document.querySelectorAll("#resBody .res h4")].some(h => /Flow accumulation/.test(h.textContent))
  };
});
console.log("flow accumulation:", JSON.stringify(accRun));
if (accRun.failed) { console.log("FAIL: ACCUM produced no accumulation"); process.exit(1); }
if (!accRun.rows.every(Boolean)) { console.log("FAIL: the two accumulation rows are not in the tree"); process.exit(1); }
if (!accRun.card) { console.log("FAIL: no Flow accumulation results card"); process.exit(1); }
if (accRun.imgs < 1) { console.log("FAIL: the accumulation raster did not reach the map"); process.exit(1); }
if (accRun.lines < 20) { console.log("FAIL: the stream layer drew", accRun.lines, "lines"); process.exit(1); }
if (accRun.loops || accRun.flats) { console.log("FAIL: the flow field left cells unresolved"); process.exit(1); }
/* the conservation identity, in the app: every square foot leaves exactly once */
if (Math.abs(accRun.exit_ac - accRun.surveyed_ac) > 0.01) {
  console.log("FAIL: what leaves the model is not the surveyed area",
              accRun.exit_ac, accRun.surveyed_ac); process.exit(1); }
if (accRun.order < 2) { console.log("FAIL: the stream network has no order-2 link"); process.exit(1); }

/* THE CARD'S OWN CROSS-CHECK against the drainage map (§2). The app compares
   against the map's DECIMATED label raster, so this is a fraction of a percent
   rather than the harness's exact zero, and the card says so in those words. */
accIdent = await page.evaluate(() => {
  const R = SBMM.accum.result(), D = SBMM.drainage.result();
  if (!R || !D || !R.byLabel) return { none: true };
  const out = [];
  for (const b of R.byLabel) {
    const rec = SBMM.drainage.recOf(b.label);
    if (!rec || rec.t !== "sink" || rec.r.area_ft2 < 43560) continue;
    out.push({ id: rec.r.id, acc: +(b.area_ft2 / 43560).toFixed(2),
               want: +(rec.r.area_ft2 / 43560).toFixed(2),
               d: +(100 * (b.area_ft2 - rec.r.area_ft2) / rec.r.area_ft2).toFixed(3) });
  }
  return { rows: out, checked: R.checked };
});
console.log("accumulation vs the drainage map:", JSON.stringify(accIdent));
if (accIdent.none || !accIdent.rows.length) { console.log("FAIL: the card has no cross-check to print"); process.exit(1); }
for (const r of accIdent.rows) if (Math.abs(r.d) > 1) {
  console.log("FAIL: accumulation disagrees with the catchment it is inside:", JSON.stringify(r));
  process.exit(1);
}

/* the status bar reads the upstream acres under the pointer (§2) */
accHover = await page.evaluate(() => {
  const R = SBMM.accum.result();
  /* the cell the whole site funnels through: the biggest accumulation there is */
  let best = -1, bi = 0, bj = 0;
  for (let j = 0; j < R.h; j++) for (let i = 0; i < R.w; i++) {
    const v = R.acc[j * R.w + i];
    if (v > best) { best = v; bi = i; bj = j; }
  }
  const x = R.x0 + bi * R.dCell, y = R.y0 + bj * R.dCell;
  SBMM.status.at(x, y);
  return { text: document.getElementById("sDem").textContent,
           acres: +(best / 43560).toFixed(2), x: Math.round(x), y: Math.round(y),
           probe: +(SBMM.accum.accAt(x, y) / 43560).toFixed(2) };
});
console.log("status bar over the biggest accumulation:", JSON.stringify(accHover));
if (!/upstream/.test(accHover.text)) { console.log("FAIL: the status bar does not read the upstream area"); process.exit(1); }
if (!/ac$/.test(accHover.text.trim())) { console.log("FAIL: the upstream area is not reported in acres"); process.exit(1); }
if (Math.abs(accHover.probe - accHover.acres) > 0.01) { console.log("FAIL: accAt disagrees with the raster"); process.exit(1); }

/* the streams: every link ends somewhere, and the popup is the app's own */
accStreams = await page.evaluate(() => {
  const R = SBMM.accum.result();
  const ends = {};
  for (const s of R.streams) ends[s.ends] = (ends[s.ends] || 0) + 1;
  const pop = SBMM.popups.forStream(R.streams[0], R);
  return { ends, orders: R.orders,
           popup: /Strahler order/.test(pop) && /Upstream area/.test(pop),
           popupCaveat: /never discharge/.test(pop),
           gj: SBMM.accum.geoFeatures(p => p).length,
           dxf: SBMM.accum.dxfEntities().length,
           csv: SBMM.accum.csv().split("\n")[0] };
});
console.log("streams:", JSON.stringify(accStreams));
if (Object.keys(accStreams.ends).some(k => !["sink", "conduit", "junction"].includes(k))) {
  console.log("FAIL: a stream link ends nowhere:", accStreams.ends); process.exit(1); }
if (!accStreams.popup) { console.log("FAIL: the stream popup does not name its numbers"); process.exit(1); }
if (!accStreams.popupCaveat) { console.log("FAIL: the stream popup does not say it is an area, not a flow"); process.exit(1); }
if (!accStreams.gj || !accStreams.dxf) { console.log("FAIL: the streams do not export"); process.exit(1); }

/* 3D: the raster is a drape and the streams are draped lines (§3.1's rule) */
acc3d = await page.evaluate(() => {
  const d = SBMM.accum.drapeSpec();
  return { drape: !!(d && d.url && d.layer && d.layer.l === "accum_raster"),
           lines: SBMM.accum.lines3d().length };
});
console.log("accumulation in 3D:", JSON.stringify(acc3d));
if (!acc3d.drape) { console.log("FAIL: the accumulation raster has no 3D drape"); process.exit(1); }
if (!acc3d.lines) { console.log("FAIL: the streams draw nothing in 3D"); process.exit(1); }

/* ---- pipe capacity (§3) --------------------------------------------- */
/* WHAT THIS SITE CAN ACTUALLY ANSWER, and it is the point of the module: only
   the two Jacobs pipes have a surveyed invert and only five conduits carry a
   size in EA's CAD, and a slope needs two elevations of the SAME kind — so
   every conduit comes back "unknown, survey pending" WITH ITS REASON, and none
   is guessed. The spec's "a capacity ratio appears on a pipe popup" is proved
   where a rateable pipe exists to prove it on: test/kernels.mjs §14.1/§14.3,
   against Manning's own equation. Here the contract is that the popup and the
   card SAY SO rather than showing a blank. */
pipeRun = await page.evaluate(async () => {
  const R = await SBMM.pipes.run();
  if (!R) return { failed: true };
  SBMM.pipes.showCard();
  const rated = R.conduits.filter(c => c.capacity_cfs != null);
  return {
    total: R.totalConduits, unknown: R.unknownConduits, rated: rated.length,
    reasons: [...new Set(R.conduits.map(c => c.unknown).filter(Boolean))],
    everyUnknownSaysWhy: R.conduits.every(c => c.capacity_cfs != null || !!c.unknown),
    surcharged: R.surcharged.length,
    hasFlows: R.hasFlows,
    withQ: R.conduits.filter(c => c.Q_peak_cfs != null).length,
    hgl: R.nodes.filter(n => n.hgl_ft != null).length,
    inlets: R.inlets.length,
    inletsUnknown: R.inlets.filter(i => i.unknown).length,
    card: [...document.querySelectorAll("#resBody .res h4")].some(h => /Pipe capacity/.test(h.textContent)),
    warn: [...document.querySelectorAll("#resBody .res .note.bad")].some(el => /survey/i.test(el.textContent))
  };
});
console.log("pipe capacity:", JSON.stringify(pipeRun));
if (pipeRun.failed) { console.log("FAIL: PIPES produced nothing"); process.exit(1); }
if (!pipeRun.card) { console.log("FAIL: no Pipe capacity results card"); process.exit(1); }
if (!pipeRun.warn) { console.log("FAIL: the card does not carry the provisional warning"); process.exit(1); }
if (!pipeRun.everyUnknownSaysWhy) { console.log("FAIL: a conduit has no capacity and no reason"); process.exit(1); }
if (pipeRun.inlets && pipeRun.inletsUnknown !== pipeRun.inlets) {
  console.log("FAIL: a grate reported an inlet capacity without a surveyed size"); process.exit(1); }

pipePop = await page.evaluate(() => {
  const c = SBMM.storm.conduit("herman_pipe_s") || SBMM.storm.data().conduits[0];
  const h = SBMM.popups.forStorm(null, c);
  const n = SBMM.storm.node("outfall");
  return { conduit: c.id, hasRow: /Capacity|Full-flow capacity/.test(h),
           saysPending: /survey pending/.test(h),
           method: /Manning|topological shortcut/.test(h),
           node: /Hydraulic grade/.test(SBMM.popups.forStorm(n, null)) };
});
console.log("the conduit popup:", JSON.stringify(pipePop));
if (!pipePop.hasRow) { console.log("FAIL: the conduit popup carries no capacity row"); process.exit(1); }
if (!pipePop.saysPending) { console.log("FAIL: an unrated conduit does not say survey pending"); process.exit(1); }

pipeColor = await page.evaluate(async () => {
  await SBMM.pipes.setColorBy(true);
  const on = SBMM.pipes.colorBy();
  const t1 = (document.getElementById("toast") || {}).textContent || "";
  await SBMM.pipes.setColorBy(false);
  return { on, off: !SBMM.pipes.colorBy(), toast: t1 };
});
console.log("colour by capacity ratio:", JSON.stringify(pipeColor));
if (!pipeColor.on || !pipeColor.off) { console.log("FAIL: the capacity colouring does not toggle"); process.exit(1); }
if (!pipeColor.toast) { console.log("FAIL: the capacity colouring said nothing"); process.exit(1); }

/* ---- scenarios (§4) -------------------------------------------------- */
/* Two scenarios that differ only in the STORM, so the drainage map and the
   accumulation are reused rather than recomputed (js/scenarios.js run()). */
scnRun = await page.evaluate(async () => {
  const a = SBMM.scenarios.add("25-year");
  a.storm = "25:24";
  const b = SBMM.scenarios.add("10-year");
  b.storm = "10:24";
  const jobs0 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  await SBMM.scenarios.run(a.id);
  await SBMM.scenarios.run(b.id);
  const jobs1 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  const L = SBMM.scenarios.list();
  return {
    n: L.length, jobs: jobs1 - jobs0,
    ran: L.map(s => !!s.last),
    storms: L.map(s => s.last ? s.last.storm : null),
    vols: L.map(s => s.last ? +s.last.site.volume_acft.toFixed(1) : null),
    peaks: L.map(s => s.last ? Math.round(s.last.site.peak_cfs) : null),
    ponds: L.map(s => s.last ? s.last.ponds.length : 0),
    over: L.map(s => s.last ? s.last.ponds.filter(p => p.overtops).length : null),
    pipes: L.map(s => s.last && s.last.pipes ? s.last.pipes.rated + "/" + s.last.pipes.total : null)
  };
});
console.log("scenarios:", JSON.stringify(scnRun));
if (scnRun.n !== 2 || !scnRun.ran.every(Boolean)) { console.log("FAIL: the two scenarios did not run"); process.exit(1); }
if (scnRun.vols[0] <= scnRun.vols[1]) {
  console.log("FAIL: the 25-year storm must produce more runoff than the 10-year",
              scnRun.vols); process.exit(1); }

scnCmp = await page.evaluate(() => {
  const L = SBMM.scenarios.list();
  SBMM.scenarios.pick(L.map(s => s.id));
  const rows = SBMM.scenarios.compareRows(L);
  const csv = SBMM.scenarios.csv();
  const card = [...document.querySelectorAll("#resBody .res")]
    .find(el => /Scenarios/.test(el.querySelector("h4").textContent));
  return {
    rows: rows.length,
    labels: rows.map(r => r[0]).slice(0, 6),
    hasPond: rows.some(r => /peak stage/.test(r[0])),
    hasOutfall: rows.some(r => /Outfall peak/.test(r[0])),
    hasPipe: rows.some(r => /Worst pipe ratio/.test(r[0])),
    csvLines: csv.split("\n").length,
    card: !!card,
    table: card ? card.querySelectorAll("table.runoffT").length : 0
  };
});
console.log("the comparison:", JSON.stringify(scnCmp));
if (scnCmp.rows < 6) { console.log("FAIL: the comparison has too few rows"); process.exit(1); }
if (!scnCmp.hasPond || !scnCmp.hasOutfall || !scnCmp.hasPipe) {
  console.log("FAIL: the comparison is missing one of the spec's columns"); process.exit(1); }
if (!scnCmp.card || !scnCmp.table) { console.log("FAIL: the Scenarios card has no comparison table"); process.exit(1); }

scnDiff = await page.evaluate(() => {
  const L = SBMM.scenarios.list();
  const d = SBMM.scenarios.diff(L[0].id, L[1].id);
  if (!d) return { none: true };
  const out = { outlets: d.outlets.length, ponds: d.ponds.length,
                pondNames: d.ponds.map(p => p.name) };
  SBMM.scenarios.showDiff(L[0].id, L[1].id);
  let hi = 0;
  SBMM.map.eachLayer(l => { if (l.options && l.options.color === "#FFD34D") hi++; });
  SBMM.scenarios.clearDiff();
  out.highlighted = hi;
  return out;
});
console.log("the map diff:", JSON.stringify(scnDiff),
            "(the same storm network in both, so the catchments are the same ground —",
            "what moves between a 25-year and a 10-year storm is the pond stages)");
if (scnDiff.none) { console.log("FAIL: the diff refused two scenarios that both ran"); process.exit(1); }
if (!scnDiff.ponds) { console.log("FAIL: a smaller storm moved no pond stage at all"); process.exit(1); }

/* the session: the switches ride, the results do not, and loading one does not
   re-run anything */
scnSess = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ser = JSON.parse(JSON.stringify(SBMM.store.serialize()));
  const txt = JSON.stringify(ser.scenarios || []);
  const jobs0 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  const beforeAcc = SBMM.accum.result(), beforeRun = SBMM.runoff.result();
  SBMM.store.restore(JSON.parse(JSON.stringify(ser)));
  await wait(600);
  const jobs1 = SBMM.compute.stats.workerJobs + SBMM.compute.stats.syncJobs;
  const L = SBMM.scenarios.list();
  return {
    inFile: (ser.scenarios || []).length,
    names: (ser.scenarios || []).map(s => s.name),
    results: /"last"|volume_acft|peak_cfs/.test(txt),
    back: L.length, backNames: L.map(s => s.name),
    backStorms: L.map(s => s.storm),
    jobs: jobs1 - jobs0,
    sameAcc: SBMM.accum.result() === beforeAcc,
    sameRun: SBMM.runoff.result() === beforeRun
  };
});
console.log("scenarios in a session:", JSON.stringify(scnSess),
            "(the jobs are the store's own volume features recomputing on restore)");
if (scnSess.inFile !== 2) { console.log("FAIL: the scenarios did not serialise"); process.exit(1); }
if (scnSess.results) { console.log("FAIL: a scenario's RESULTS leaked into the session"); process.exit(1); }
if (scnSess.back !== 2) { console.log("FAIL: the scenarios did not come back"); process.exit(1); }
if (!scnSess.sameAcc || !scnSess.sameRun) { console.log("FAIL: loading a session re-ran an analysis"); process.exit(1); }

if (errors.length !== errBeforeAcc) {
  console.log("FAIL: v19 raised page errors:", errors.slice(errBeforeAcc, errBeforeAcc + 4));
  process.exit(1);
}
});

/* ==================================================================== */
let errBeforeParity, parity, rowsOn, classesLive, CAD_BASEMAP, exemptReason, parityTable, parityMissing, parityNamed, chrome3d, lbl3d, hasTxt;   /* hoisted — v18 §3 */
await block("9y. 3D parity", async () => {
/* 9y. 3D parity — everything that works in 2D works in 3D (v15 §3.1)   */
/* ==================================================================== */
/* The table: for every layer row that is ON, the 3D scene must contain at least
   one object tagged with that row's (group, id). js/viewer3d.js tags every
   object it builds (`userData.layer`) and `stats().layersDrawn` reports the set.

   Some rows have no overlay object BY CONSTRUCTION, and each of those is
   exempted here with the reason printed beside it rather than quietly skipped:

     * the basemaps and the computed rasters (hillshade, the three orthos,
       slope, aspect, elevation tint) are the 3D TERRAIN DRAPE — one picker in
       the 3D toolbar, the same pixels, not an overlay;
     * a plan sheet's raster is draped on request (the ⛰ button on its row);
       `sheets3d` is the master switch for those and draws nothing on its own;
     * the sheet footprints are 2D click targets that open a drawing — in 3D
       you click the drape itself;
     * EA's CAD BASE MAP groups (contours 3,159 rings, parcels 2,788, roads,
       buildings, fences, trees, utilities, symbols 15,045) are 2D-only: every
       ring in 3D is resampled against the DEM every 10 ft on every overlay
       rebuild, and the viewer's 3,000-ring drape budget exists because of it.
       The DESIGN groups — limits of excavation, daylight, grade, repository,
       borrow, staging, haul — ARE drawn, and they are what the 3D view is for;
     * a My-work class row with no visible feature of that class has nothing to
       draw, so it is only required when such a feature exists.

   Anything else with an ON row and no object is a FAIL and is listed. */
errBeforeParity = errors.length;
parity = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  /* every group on, including the lazily built base layers — the same
     "everything on" test/perf.mjs uses */
  const LS = SBMM.layerState;
  /* put every row back afterwards: turning EA's 22k-entity CAD base map and the
     twelve sheet rasters on is a state the blocks after this one should not
     inherit (and the cultural stamp must not end up in the screenshots) */
  window.__parityState = LS.dump();
  for (const g of ["framework", "design", "invest", "mywork", "cultural"]) LS.setGroup(g, true);
  for (const id of ["contours_site", "contours_abp", "canopy", "trees_detected"])
    if (LS.get("base", id)) LS.set("base", id, { on: true });
  /* the drainage rows run their job on the first tick; it is cached from block
     9x, but wait for it rather than racing it */
  for (let i = 0; i < 120 && SBMM.drainage && !SBMM.drainage.hasResult(); i++) await wait(500);
  /* the CAD groups parse their geometry lazily on first enable */
  await wait(4000);
  const wasOpen = SBMM.viewer3d.isOpen();
  if (!wasOpen) { await SBMM.viewer3d.toggle(); await wait(4000); }
  /* the canopy mesh, the contour sets and the tree detector are all built on
     first need; wait for them rather than racing them into the table */
  for (let i = 0; i < 90; i++) {
    const st = SBMM.viewer3d.stats();
    const okCanopy = !LS.isOn("base", "canopy") || st.canopyVisible;
    const okTrees = !LS.isOn("base", "trees_detected") || !!(SBMM.trees && SBMM.trees.data);
    const okCont = !(LS.isOn("base", "contours_site") || LS.isOn("base", "contours_abp"))
                 || st.contoursVisible;
    if (okCanopy && okTrees && okCont) break;
    await wait(1000);
  }
  /* the tree detector runs over the whole canopy window on first enable; if it
     has not finished, say so and take the row out rather than failing the table
     on a race (the tag itself is checked by the row when it IS ready) */
  let treesSkipped = false;
  if (LS.isOn("base", "trees_detected") && !(SBMM.trees && SBMM.trees.data)) {
    LS.set("base", "trees_detected", { on: false });
    treesSkipped = true;
    await wait(500);
  }
  SBMM.viewer3d.refreshOverlays();
  await wait(4000);
  const drawn = SBMM.viewer3d.stats().layersDrawn;

  /* every row of every group, from the ONE layer state (§1/§4) rather than from
     the DOM — the label is what says whether a row is a raster or a vector */
  const rows = [];
  for (const g of ["base", "framework", "design", "invest", "cultural", "mywork"])
    for (const r of LS.list(g))
      rows.push({ group: g, id: r.id, label: String(r.label || r.id).slice(0, 60), on: !!r.on });
  /* the layer rows that belong to a dataset that still EXISTS — an imported
     dataset that was removed leaves its row behind (see exemptReason) */
  const dsKeys = (SBMM.datasets ? SBMM.datasets.list() : [])
    .map(d => d.rowRef && d.rowRef.key).filter(Boolean);
  return { drawn, rows, wasOpen, treesSkipped, dsKeys };
});
if (parity.treesSkipped)
  console.log("3D parity: the tree detector had not finished, so base/trees_detected is out of this table");
rowsOn = parity.rows.filter(r => r.on);
/* which My-work classes actually have a visible feature */
classesLive = await page.evaluate(() => {
  const out = {};
  for (const f of SBMM.store.features)
    if (f.visible !== false) out[SBMM.myWork.classOf(f)] = (out[SBMM.myWork.classOf(f)] || 0) + 1;
  return out;
});
CAD_BASEMAP = new Set(["cad_contour", "cad_parcel", "cad_road", "cad_bldg", "cad_fence",
  "cad_tree", "cad_util", "cad_env", "cad_symbol", "cad_misc", "cad_topo", "cad_du",
  "cad_storm", "cad_esc", "cad_algn", "cad_anno"]);
exemptReason = function exemptReason(r) {
  if (r.group === "base" && /^(Hillshade|Ortho|Slope|Aspect|Elevation tint)/.test(r.label))
    return "the 3D terrain drape (toolbar picker)";
  if (r.group === "design" && r.id === "sheets3d") return "master switch for the per-sheet drapes";
  if (r.group === "design" && r.id === "sheet_footprints") return "2D click targets; in 3D you click the drape";
  if (r.group === "design" && /^C-\d|^G-\d/.test(r.label)) return "a plan sheet, draped on request (⛰)";
  if (CAD_BASEMAP.has(r.id)) return "EA CAD base map — 2D only (drape budget, see the block header)";
  if (r.group === "mywork" && !classesLive[r.id]) return "no visible feature of this class";
  /* An imported dataset that was REMOVED leaves its layer row behind: nothing
     can undefine a row once SBMM.layerState has it, so the row stays on with no
     data under it. That is a pre-existing leak in the layer state, not a 3D
     parity gap — it is reported here by name so it is not lost, and it belongs
     with the Layers work (docs/V16_LAYERS_SPEC.md), not with this spec. */
  if (r.group === "invest" && r.id !== "samples" && !/^survey_/.test(r.id)
      && !parity.dsKeys.includes(r.group + "/" + r.id))
    return "ORPHAN ROW — its imported dataset was removed (layerState cannot undefine a row; v16)";
  return null;
}
parityTable = rowsOn.map(r => {
  const key = r.group + "/" + r.id;
  const n = parity.drawn[key] || 0;
  return { key, label: r.label, objects: n, exempt: n ? null : exemptReason(r) };
});
console.log("3D parity table — rows ON:", parityTable.length,
            "| with 3D objects:", parityTable.filter(t => t.objects).length,
            "| exempt:", parityTable.filter(t => !t.objects && t.exempt).length);
for (const t of parityTable.filter(t => !t.objects))
  console.log("   " + t.key.padEnd(28) + (t.exempt ? "exempt — " + t.exempt : "*** MISSING ***"));
parityMissing = parityTable.filter(t => !t.objects && !t.exempt);
if (parityMissing.length) {
  console.log("FAIL: 3D parity — these layer rows are on and draw nothing in 3D:",
              JSON.stringify(parityMissing.map(t => t.key)));
  process.exit(1);
}
/* the §3.1 named gaps, each asserted by name rather than by the table alone */
parityNamed = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  const d = SBMM.viewer3d.stats().layersDrawn;
  out.pdf = !!d["design/pdf_boundaries"];
  out.contoursSite = !!d["base/contours_site"];
  out.contoursAbp = !!d["base/contours_abp"];
  out.drainPaths = !!d["framework/drain_paths"];
  out.cultural = Object.keys(d).some(k => k.indexOf("cultural/") === 0);
  /* a dataset's row id is a slug of its LABEL, not its dataset id, so the row
     key is what threeSpec() carries — compare against that, not a prefix */
  const ds = SBMM.datasets ? SBMM.datasets.threeSpec() : [];
  out.datasets = ds.filter(sp => d[sp.rowKey]).length;
  out.datasetsOn = ds.length;
  /* EA's four recovered design surfaces: read-only `surface` features with no
     node grid, so the mesh branch skipped them entirely before v15 */
  out.refSurfaces = SBMM.store.features.filter(f => f.type === "surface" && f.props && f.props.ref).length;
  /* a cross-section set: its station lines and chainages, not just the baseline */
  const sec = SBMM.store.features.filter(f => f.type === "sections").pop();
  if (sec) {
    SBMM.store.setVisible(sec, true);
    SBMM.viewer3d.refreshOverlays();
    await wait(900);
    const st = SBMM.viewer3d.stats();
    out.sectionsRow = !!st.layersDrawn["mywork/sections"];
    out.stationLabels = st.labelTexts.filter(t => /^\d+\+/.test(t)).length;
  }
  return out;
});
console.log("3D parity — the named gaps:", JSON.stringify(parityNamed));
for (const [k, v] of Object.entries({ "EA PDF boundaries": parityNamed.pdf,
    "survey contours (site)": parityNamed.contoursSite,
    "drainage flow paths": parityNamed.drainPaths,
    "cultural layers": parityNamed.cultural }))
  if (!v) { console.log("FAIL: 3D parity gap still open —", k); process.exit(1); }
if (parityNamed.datasetsOn && parityNamed.datasets !== parityNamed.datasetsOn)
  { console.log("FAIL: a dataset row is on and has no 3D object:",
                parityNamed.datasets, "of", parityNamed.datasetsOn); process.exit(1); }
if (parityNamed.sectionsRow === false)
  { console.log("FAIL: a cross-section set draws nothing in 3D"); process.exit(1); }

/* view presets move the camera, and the sun and animate-water controls exist */
chrome3d = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  const before = SBMM.viewer3d.stats().orbit;
  SBMM.viewer3d.preset("w");
  await wait(1400);
  out.moved = JSON.stringify(SBMM.viewer3d.stats().orbit) !== JSON.stringify(before);
  /* the keyboard: 1,2,4,5,6 are presets and Shift+3 is the south one — a bare 3
     has toggled the whole 3D view since v1 (v15 §3.2, and the report says so) */
  const b2 = SBMM.viewer3d.stats().orbit;
  /* keyed on e.code (Shift+3 is "#" on a US keyboard, so e.key cannot carry it) */
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", bubbles: true }));
  await wait(1200);
  out.keyPreset = JSON.stringify(SBMM.viewer3d.stats().orbit) !== JSON.stringify(b2);
  /* a bare 3 still opens and closes the 3D view; Shift+3 is the south preset */
  const b3 = SBMM.viewer3d.stats().orbit;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "#", code: "Digit3", shiftKey: true, bubbles: true }));
  await wait(1200);
  out.keyShift3 = JSON.stringify(SBMM.viewer3d.stats().orbit) !== JSON.stringify(b3);
  out.stillOpen = SBMM.viewer3d.isOpen();
  out.animWater = !!document.getElementById("v3dAnimWater");
  out.sunAz = !!document.getElementById("v3dSunAz");
  out.sunEl = !!document.getElementById("v3dSunEl");
  out.lookAt = !!document.getElementById("v3dLookAt");
  out.elevLegend = (document.getElementById("v3dElevLeg") || { textContent: "" }).textContent.trim().length > 0;
  const s0 = SBMM.viewer3d.sun();
  SBMM.viewer3d.sun(120, 60);
  out.sunSet = SBMM.viewer3d.sun();
  SBMM.viewer3d.sun(s0.az, s0.el);
  out.sky = SBMM.viewer3d.stats().sky;
  out.ground = SBMM.viewer3d.stats().groundPlane;
  return out;
});
console.log("3D chrome:", JSON.stringify(chrome3d));
for (const k of ["moved", "keyPreset", "keyShift3", "stillOpen", "animWater", "sunAz", "sunEl",
                 "lookAt", "elevLegend", "sky", "ground"])
  if (!chrome3d[k]) { console.log("FAIL: 3D chrome —", k); process.exit(1); }
if (chrome3d.sunSet.az !== 120 || chrome3d.sunSet.el !== 60)
  { console.log("FAIL: the sun control does not move the light:", JSON.stringify(chrome3d.sunSet)); process.exit(1); }

/* the stage labels follow the slider (v15 §2.3) */
lbl3d = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ringOf = nm => SBMM_DATA.design_gis.features.find(
    f => f.properties.layer === "water" && f.properties.name === nm).geometry.coordinates[0];
  SBMM.water.clearOvertop();
  await wait(200);
  const R = await SBMM.water.overtop({ ring: ringOf("Frog Pond").map(q => [q[0], q[1]]), name: "Frog Pond" });
  await wait(600);
  await SBMM.viewer3d.openAt(R.conduitSpill.x, R.conduitSpill.y);
  await wait(3000);
  const card = [...document.querySelectorAll("#resBody .res")].find(c => /Overtopping/.test(c.textContent));
  const sl = card.querySelector("#wsRange");
  const at = async lv => {
    const i = R.stage.findIndex(st => st.level >= lv - 1e-9);
    sl.value = String(Math.max(0, i)); sl.dispatchEvent(new Event("input"));
    await wait(1400);
    return SBMM.viewer3d.stats();
  };
  const below = await at(R.conduitSpill.level - 0.5);
  const atRim = await at(R.primary.level + 0.5);
  return {
    belowTexts: below.labelTexts, aboveTexts: atRim.labelTexts,
    registered: atRim.labels3d, visible: atRim.labelsVisible
  };
});
console.log("3D stage labels below the culvert:", JSON.stringify(lbl3d.belowTexts));
console.log("3D stage labels above the rim:   ", JSON.stringify(lbl3d.aboveTexts));
hasTxt = (a, re) => a.some(t => re.test(t));
if (!hasTxt(lbl3d.belowTexts, /first discharge .* ft to go/))
  { console.log("FAIL: below the culvert rim the label must say how far it has to go"); process.exit(1); }
if (!hasTxt(lbl3d.aboveTexts, /first discharge .*discharging/))
  { console.log("FAIL: at the culvert rim the label must say it is discharging"); process.exit(1); }
if (!hasTxt(lbl3d.aboveTexts, /rim spill .*overtopped/))
  { console.log("FAIL: past the rim spill the rim label must say overtopped"); process.exit(1); }
if (!hasTxt(lbl3d.belowTexts, /rim spill .* ft to go/))
  { console.log("FAIL: below the rim spill the rim label must say how far it has to go"); process.exit(1); }
if (!hasTxt(lbl3d.aboveTexts, /^water level /))
  { console.log("FAIL: no water-level label on the stage surface"); process.exit(1); }
/* the collision pass: what is drawn is never more than what is registered */
if (!(lbl3d.visible <= lbl3d.registered) || !lbl3d.visible)
  { console.log("FAIL: the 3D label collision pass:", lbl3d.visible, "of", lbl3d.registered); process.exit(1); }
if (errors.length !== errBeforeParity) {
  console.log("FAIL: page errors during the 3D parity block:",
              errors.slice(errBeforeParity, errBeforeParity + 6)); process.exit(1);
}
await page.evaluate(async () => {
  SBMM.water.clearOvertop();
  if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
  SBMM.layerState.setGroup("cultural", false);
  if (window.__parityState) SBMM.layerState.restore(window.__parityState);
  await new Promise(r => setTimeout(r, 800));
});
});

/* ==================================================================== */
let errBeforeLbl, lab, labDrain;   /* hoisted — v18 §3 */
await block("9z. labels", async () => {
/* 9z. labels — one per fact, and none on top of another (v15 §2.2)     */
/* ==================================================================== */
errBeforeLbl = errors.length;
lab = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ringOf = nm => SBMM_DATA.design_gis.features.find(
    f => f.properties.layer === "water" && f.properties.name === nm).geometry.coordinates[0];
  const out = {};
  /* Frog Pond's overtopping makes a first-discharge route through the culvert
     into Green Pond; a raindrop dropped on the same inlet runs the same way, so
     the two features draw the SAME ponds — which is exactly how the text used
     to stack (v15 §2.1). */
  const R = await SBMM.water.overtop({ ring: ringOf("Frog Pond").map(q => [q[0], q[1]]), name: "Frog Pond" });
  await wait(500);
  /* two drops on the same cell: identical runs, identical ponds, so every pond
     label is stated twice — which is the defect, arranged rather than hoped for */
  await SBMM.water.dropAt(R.conduitSpill.x, R.conduitSpill.y, { name: "ZZ label probe 1" });
  await wait(600);
  await SBMM.water.dropAt(R.conduitSpill.x, R.conduitSpill.y, { name: "ZZ label probe 2" });
  await wait(600);
  /* zoom onto Green Pond (E 6,373,925–6,374,152), where both runs pond */
  SBMM.map.setView([2127900, 6374020], 2, { animate: false });
  await wait(700);
  SBMM.labels.place();
  const vis = SBMM.labels.visible();
  const boxes = SBMM.labels.boxes();
  out.stats = SBMM.labels.stats();
  /* one visible label per pond key */
  const perKey = {};
  for (const v of vis) if (v.key && v.key.indexOf("pond:") === 0) perKey[v.key] = (perKey[v.key] || 0) + 1;
  out.pondKeys = perKey;
  out.pondVisible = Object.keys(perKey).length;
  out.pondMax = Object.values(perKey).reduce((a, b) => Math.max(a, b), 0);
  /* how many were hidden BECAUSE they were duplicates — the defect, measured */
  out.dupHidden = out.stats.dup;
  /* no two visible boxes overlap */
  const over = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (!(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top))
      over.push([a.key || a.id, b.key || b.id]);
  }
  out.overlapZoom = over;
  out.nBoxes = boxes.length;
  /* pan and zoom out, then measure again */
  SBMM.map.fitBounds(SBMM.demSite.bounds(), { animate: false });
  await wait(700);
  SBMM.labels.place();
  const b2 = SBMM.labels.boxes();
  const over2 = [];
  for (let i = 0; i < b2.length; i++) for (let j = i + 1; j < b2.length; j++) {
    const a = b2[i], b = b2[j];
    if (!(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top))
      over2.push([a.key || a.id, b.key || b.id]);
  }
  out.overlapSite = over2;
  out.nBoxesSite = b2.length;
  return out;
});
console.log("2D labels:", JSON.stringify({ stats: lab.stats, pondVisible: lab.pondVisible,
  pondMax: lab.pondMax, dupHidden: lab.dupHidden, boxes: lab.nBoxes, overlaps: lab.overlapZoom.length }));
if (lab.pondMax > 1)
  { console.log("FAIL: a pond has more than one visible label:", JSON.stringify(lab.pondKeys)); process.exit(1); }
if (!lab.dupHidden)
  { console.log("FAIL: two routes over the same pond must produce a deduped label, got", lab.dupHidden); process.exit(1); }
if (lab.overlapZoom.length)
  { console.log("FAIL: two visible labels overlap after a zoom:", JSON.stringify(lab.overlapZoom.slice(0, 4))); process.exit(1); }
if (lab.overlapSite.length)
  { console.log("FAIL: two visible labels overlap after a pan:", JSON.stringify(lab.overlapSite.slice(0, 4))); process.exit(1); }

/* the drainage catchment names, at full-site zoom, must not pile up either */
labDrain = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.layerState.set("framework", "drain_outlet", { on: true });
  for (let i = 0; i < 120 && !SBMM.drainage.hasResult(); i++) await wait(500);
  await wait(1200);
  SBMM.map.fitBounds(SBMM.demSite.bounds(), { animate: false });
  await wait(800);
  SBMM.labels.place();
  const b = SBMM.labels.boxes().filter(q => q.owner === "drainage");
  const all = SBMM.labels.boxes();
  const over = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const x = all[i], y = all[j];
    if (!(x.right < y.left || y.right < x.left || x.bottom < y.top || y.bottom < x.top))
      over.push([x.key, y.key]);
  }
  const st = SBMM.labels.stats();
  SBMM.layerState.set("framework", "drain_outlet", { on: false });
  return { drainVisible: b.length, allVisible: all.length, overlaps: over, stats: st };
});
console.log("2D labels with the drainage map on:", JSON.stringify(labDrain));
if (!labDrain.drainVisible)
  { console.log("FAIL: the drainage catchments have no visible label at site zoom"); process.exit(1); }
if (labDrain.overlaps.length)
  { console.log("FAIL: drainage labels overlap:", JSON.stringify(labDrain.overlaps.slice(0, 4))); process.exit(1); }
if (errors.length !== errBeforeLbl) {
  console.log("FAIL: page errors during the labels block:",
              errors.slice(errBeforeLbl, errBeforeLbl + 6)); process.exit(1);
}
await page.evaluate(async () => {
  SBMM.water.clearOvertop();
  for (const p of SBMM.store.features.filter(f => /^ZZ label probe/.test(f.name))) SBMM.store.remove(p);
  await new Promise(r => setTimeout(r, 200));
});
});

await block("10. screenshot 2D", async () => {
/* 10. screenshot 2D — feature manager open, with the Pile 1 volume drawn */
await page.click('#leftTabs .dtab[data-tab="features"]');
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/shot_2d_" + label.replace(/\W+/g, "_") + ".png" });
await page.click('#rightTabs .dtab[data-rtab="inspector"]');   /* v9 §3: Properties is the right dock's Inspector */
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/shot_props_" + label.replace(/\W+/g, "_") + ".png" });
}, { needs: ["pile1"] });


/* ==================================================================== */
let errBeforeTree, treeBase, tree, treeKeys, treeMissing, treeNew, treeUnexplained, treeSearch, treeSolo, treeActs, gripBox, treeOrder, grip2, treeOrder2, treePreset, treeSess, kbBefore, kbAfter, kbMoved, treeLegend, errBeforeReload, treeReload;   /* hoisted — v18 §3 */
await block("9z. the layer tree", async () => {
/* 9z. the layer tree (v16, docs/V16_LAYERS_SPEC.md §3)                  */
/* ==================================================================== */
/* Runs LAST, after the screenshots, because it ends with a real page
   reload — the only honest way to assert that a dragged row order comes
   back — and a reload throws the accumulated scene away.

   The cultural acknowledgement is asserted in block 9g, which is
   unchanged by v16 and still passes; what this block adds is the other
   half of that guarantee: none of the tree's new bulk switches (solo,
   presets, the group all-on button, the recently-changed chips) can
   reach the cultural group at all. */
errBeforeTree = errors.length;
/* block 10 left the left dock on the My-work tab; the tree needs to be on
   screen for a real drag and for keyboard focus to mean anything */
await page.click('#leftTabs .dtab[data-tab="layers"]');
await page.waitForTimeout(400);

/* ---- every row that existed before v16 exists after, same (group, id) ----
   The baseline is test/fixtures/layer_rows_pre_v16.json, dumped from the
   pre-v16 build (commit 475e302) with the same probe this block uses. */
treeBase = JSON.parse(__read(new URL("fixtures/layer_rows_pre_v16.json", import.meta.url), "utf8"));
tree = await page.evaluate(() => {
  const d = SBMM.layerTree.dump();
  const keys = d.map(r => r.group + "/" + r.id);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  return {
    rows: d, keys, dup,
    domRows: document.querySelectorAll("#layers .lyr").length,
    subs: [...document.querySelectorAll("#layers .lgsub")].map(s => ({
      sub: [...s.querySelector(".subh").childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim(),
      rows: s.querySelectorAll(".lyr, .surfrow, .refrow[data-sid]").length
    })),
    orphans: [...document.querySelectorAll("#layers .lyr")]
      .filter(r => !SBMM.layerState.rec(r.dataset.lgroup, r.dataset.lid))
      .map(r => r.dataset.lgroup + "/" + r.dataset.lid),
    swatches: document.querySelectorAll("#layers .lyr .ltsw svg").length,
    grips: document.querySelectorAll("#layers .lyr .ltgrip").length,
    toolbars: document.querySelectorAll("#layers .lyr .ltacts .ltb").length
  };
});
treeKeys = new Set(tree.keys);
treeMissing = treeBase.keys.filter(k => !treeKeys.has(k));
/* Rows this HARNESS created after boot are the only legitimate additions: the
   CSV datasets block 9f imports (invest) and the contour set the analysis block
   generates (base). Anything new anywhere else would be a row v16 invented.
   ONE exemption beyond those, and it is a dated one: the two design-storm rows
   (v14 Phase 2, v9.13) were added to the app AFTER this baseline was dumped
   from commit 475e302, so they are absent from the fixture by construction
   rather than by accident. The fixture is not edited — a baseline that gets
   rewritten every release stops being a baseline. */
treeNew = tree.keys.filter(k => treeBase.keys.indexOf(k) < 0);
treeUnexplained = treeNew.filter(k => !/^invest\//.test(k) && !/^base\/contours_/.test(k)
                                         && k !== "framework/runoff_cover"
                                         && k !== "framework/runoff_depth");
console.log("layer tree:", tree.rows.length, "rows in the state,", tree.domRows, "in the DOM,",
            tree.subs.length, "sub-groups |", tree.swatches, "symbology swatches |",
            "baseline", treeBase.keys.length, "rows — missing", treeMissing.length,
            "| added by this run", treeNew.length, JSON.stringify(treeNew));
console.log("layer tree sub-groups:", JSON.stringify(tree.subs));
if (treeMissing.length) {
  console.log("FAIL: the tree lost layer rows that existed before v16:", treeMissing.slice(0, 12)); process.exit(1); }
if (treeUnexplained.length) {
  console.log("FAIL: the tree invented layer rows:", treeUnexplained.slice(0, 12)); process.exit(1); }
if (tree.dup.length) { console.log("FAIL: duplicate (group, id) layer keys:", tree.dup); process.exit(1); }
/* every row on screen has a state entry (a dataset removed during the run keeps
   its state entry and loses its row, so the state may be the larger of the two) */
if (tree.domRows > tree.rows.length || tree.orphans.length) {
  console.log("FAIL: a DOM row has no layer state behind it", { dom: tree.domRows, state: tree.rows.length, orphans: tree.orphans }); process.exit(1); }
if (tree.swatches !== tree.domRows || tree.grips !== tree.domRows || tree.toolbars !== tree.domRows * 4) {
  console.log("FAIL: not every row got its swatch, grip and 4-button toolbar", tree); process.exit(1); }
if (tree.subs.length < 8) { console.log("FAIL: the sub-groups did not build:", tree.subs); process.exit(1); }

/* ---- search ----
   Fuzzy over label + sub-group + group + id (§2.1). "storm" therefore also
   matches the three drainage rows, whose sub-group is "Drainage (lidar +
   storm drains)" — that is the rule doing its job, so the assertion is
   "the three storm rows are shown and every shown row really matches",
   not a bare count. */
treeSearch = await page.evaluate(() => {
  SBMM.layerTree.search("storm");
  const shown = [...document.querySelectorAll("#layers .lyr")]
    .filter(r => !r.classList.contains("lthide"))
    .map(r => ({ k: r.dataset.lgroup + "/" + r.dataset.lid,
                 /* the same haystack js/layertree.js searches: label, sub-group,
                    group label, id */
                 hay: [r.querySelector(".lbl").textContent, r.dataset.lsub || "",
                       (SBMM.layerState.GROUP_ORDER.find(g => g[0] === r.dataset.lgroup) || [])[1] || "",
                       r.dataset.lid].join(" ").toLowerCase() }));
  const sec = document.querySelector('#layers .lsec[data-sec="framework"]');
  const stormSub = [...document.querySelectorAll("#layers .lgsub")]
    .find(s => /Storm drainage/.test(s.querySelector(".subh").textContent));
  const out = {
    shown: shown.map(s => s.k),
    allMatch: shown.every(s => s.hay.includes("storm")),
    frameworkShown: !sec.classList.contains("lthide") && sec.classList.contains("ltforce"),
    stormSubShown: !!stormSub && !stormSub.classList.contains("lthide") && !stormSub.classList.contains("closed"),
    designHidden: document.querySelector('#layers .lsec[data-sec="design"]').classList.contains("lthide"),
    hits: (document.getElementById("ltHits") || {}).textContent
  };
  SBMM.layerTree.search("");
  out.afterClear = [...document.querySelectorAll("#layers .lyr")].filter(r => r.classList.contains("lthide")).length;
  return out;
});
console.log("search “storm”:", treeSearch.shown.join(" "), "|", treeSearch.hits,
            "| framework expanded:", treeSearch.frameworkShown, "| storm sub open:", treeSearch.stormSubShown,
            "| design group hidden:", treeSearch.designHidden, "| rows hidden after clear:", treeSearch.afterClear);
for (const k of ["framework/storm_nodes", "framework/storm_cad", "framework/storm_inferred"])
  if (treeSearch.shown.indexOf(k) < 0) { console.log("FAIL: search “storm” did not show", k); process.exit(1); }
if (!treeSearch.allMatch) { console.log("FAIL: search “storm” showed a row that does not match it"); process.exit(1); }
if (!treeSearch.frameworkShown || !treeSearch.stormSubShown || !treeSearch.designHidden) {
  console.log("FAIL: search did not expand the ancestors and hide the rest", treeSearch); process.exit(1); }
if (treeSearch.afterClear) { console.log("FAIL: Esc/clear left", treeSearch.afterClear, "rows hidden"); process.exit(1); }

/* ---- solo, and its restore ---- */
treeSolo = await page.evaluate(() => {
  const before = SBMM.layerState.list("framework").map(r => [r.id, r.on]);
  SBMM.layerTree.solo("framework", "storm_nodes");
  const during = SBMM.layerState.list("framework").map(r => [r.id, r.on]);
  SBMM.layerTree.solo("framework", "storm_nodes");
  const after = SBMM.layerState.list("framework").map(r => [r.id, r.on]);
  const cultId = (SBMM.layerState.list("cultural")[0] || {}).id;
  const cultBefore = cultId ? SBMM.layerState.isOn("cultural", cultId) : null;
  const cultRefused = cultId ? SBMM.layerTree.solo("cultural", cultId) : false;
  const cultToast = (document.getElementById("toast") || {}).textContent || "";
  return {
    cultToast,
    onDuring: during.filter(r => r[1]).map(r => r[0]),
    restored: JSON.stringify(before) === JSON.stringify(after),
    cultId, cultRefused, cultChanged: cultId ? SBMM.layerState.isOn("cultural", cultId) !== cultBefore : false
  };
});
console.log("solo storm_nodes: on during =", treeSolo.onDuring.join(","), "| restored:", treeSolo.restored,
            "| solo refused on cultural:", treeSolo.cultRefused === false, "| cultural moved:", treeSolo.cultChanged);
if (treeSolo.onDuring.length !== 1 || treeSolo.onDuring[0] !== "storm_nodes") {
  console.log("FAIL: solo did not isolate the row", treeSolo); process.exit(1); }
if (!treeSolo.restored) { console.log("FAIL: solo did not put the group back"); process.exit(1); }
if (treeSolo.cultRefused !== false || treeSolo.cultChanged) {
  console.log("FAIL: solo reached the cultural group", treeSolo); process.exit(1); }
if (!/cultural/i.test(treeSolo.cultToast)) {
  console.log("FAIL: solo refused the cultural group silently:", JSON.stringify(treeSolo.cultToast)); process.exit(1); }

/* ---- the row toolbar: opacity, zoom to extent, info ---- */
treeActs = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const row = document.querySelector('#projLayers .lyr[data-lid="dus"]');
  const btn = a => row.querySelector('.ltb[data-a="' + a + '"]');
  const out = {};

  btn("info").click(); await wait(150);
  const pop = document.getElementById("ltPop");
  out.info = { shown: !pop.hidden, z: getComputedStyle(pop).zIndex,
               names: /framework\/dus/.test(pop.textContent),
               crs: /6418/.test(pop.textContent) };

  btn("opacity").click(); await wait(150);
  const sl = document.getElementById("ltOpac");
  out.opacity = { slider: !!sl, was: SBMM.layerState.opacity("framework", "dus") };
  sl.value = 50; sl.dispatchEvent(new Event("input"));
  await wait(150);
  out.opacity.now = SBMM.layerState.opacity("framework", "dus");
  SBMM.layerState.set("framework", "dus", { opacity: out.opacity.was });

  /* Esc closes the popover and stops there */
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(120);
  out.escClosed = document.getElementById("ltPop").hidden;

  /* "zoom to extent" frames the layer — which is as often a zoom OUT as a zoom
     in, depending where the map was left. So the test is the honest one: the
     view moved, and the layer's own geometry is inside it afterwards. */
  const b0 = SBMM.map.getBounds(), c0 = SBMM.map.getCenter();
  out.zoomBefore = Math.round(b0.getEast() - b0.getWest());
  btn("zoom").click();
  await wait(1400);
  const b1 = SBMM.map.getBounds(), c1 = SBMM.map.getCenter();
  out.zoomAfter = Math.round(b1.getEast() - b1.getWest());
  out.zoomMoved = Math.round(Math.hypot(c1.lng - c0.lng, c1.lat - c0.lat));
  const du = SBMM_DATA.dus[0].ring;
  out.zoomFrames = du.every(p => b1.contains([p[1], p[0]]));

  /* a My-work class row has no Leaflet layer of its own — it is a mask — so
     "zoom to extent" has nothing to fly to and must say so */
  document.getElementById("toast").textContent = "";
  out.maskZoom = SBMM.layerTree.zoomTo("mywork", "drawings");
  out.maskToast = document.getElementById("toast").textContent;
  return out;
});
console.log("row toolbar: info popover", JSON.stringify(treeActs.info),
            "| opacity", treeActs.opacity.was, "->", treeActs.opacity.now,
            "| Esc closed it:", treeActs.escClosed,
            "| zoom to extent", treeActs.zoomBefore, "->", treeActs.zoomAfter,
            "ft wide, centre moved", treeActs.zoomMoved, "ft, frames the layer:", treeActs.zoomFrames,
            "| a mask row refuses:", JSON.stringify(treeActs.maskToast));
if (!treeActs.info.shown || !treeActs.info.names || !treeActs.info.crs) {
  console.log("FAIL: the info popover does not identify the layer", treeActs.info); process.exit(1); }
if (treeActs.info.z !== "2500") { console.log("FAIL: the row popover is outside the popover band", treeActs.info.z); process.exit(1); }
if (!treeActs.opacity.slider || Math.abs(treeActs.opacity.now - 0.5) > 1e-6) {
  console.log("FAIL: the opacity popover did not drive the layer state", treeActs.opacity); process.exit(1); }
if (!treeActs.escClosed) { console.log("FAIL: Esc did not close the row popover"); process.exit(1); }
if (!treeActs.zoomFrames || treeActs.zoomMoved < 50) {
  console.log("FAIL: zoom to extent did not frame the layer", treeActs); process.exit(1); }
if (treeActs.maskZoom !== false || !/nothing to zoom to/.test(treeActs.maskToast)) {
  console.log("FAIL: zoom to extent on a row with no geometry refused silently", treeActs); process.exit(1); }

/* ---- drag to reorder, and the order IS the draw order ---- */
gripBox = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#projLayers > .lyr')];
  const dus = rows.find(r => r.dataset.lid === "dus"), piles = rows.find(r => r.dataset.lid === "piles");
  if (!dus || !piles) return null;
  const g = piles.querySelector(".ltgrip").getBoundingClientRect();
  const d = dus.getBoundingClientRect();
  return { gx: g.left + g.width / 2, gy: g.top + g.height / 2, targetY: d.top + 2,
           order: rows.map(r => r.dataset.lid),
           idx: { dus: SBMM.layerTree.drawIndex("framework", "dus"),
                  piles: SBMM.layerTree.drawIndex("framework", "piles") } };
});
if (!gripBox) { console.log("FAIL: the Decision units / Waste piles rows are not in #projLayers"); process.exit(1); }
await page.mouse.move(gripBox.gx, gripBox.gy);
await page.mouse.down();
await page.mouse.move(gripBox.gx, gripBox.gy - 6, { steps: 3 });
await page.mouse.move(gripBox.gx, gripBox.targetY, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(400);
treeOrder = await page.evaluate(() => {
  const order = () => [...document.querySelectorAll('#projLayers > .lyr')].map(r => r.dataset.lid);
  const dragged = order();
  const idx = { dus: SBMM.layerTree.drawIndex("framework", "dus"),
                piles: SBMM.layerTree.drawIndex("framework", "piles") };
  /* what a reload does, without the reload: scramble the DOM back by hand and
     let the tree rebuild the order from its own record */
  const host = document.getElementById("projLayers");
  const dus = host.querySelector('.lyr[data-lid="dus"]');
  host.insertBefore(dus, host.firstChild);
  const scrambled = order();
  SBMM.layerTree.restoreOrder();
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem("sbmm.layertree.v1") || "{}").order; } catch (e) {}
  return { dragged, scrambled, rebuilt: order(), idx, stored };
});
console.log("drag reorder:", gripBox.order.slice(0, 2).join(","), "->", treeOrder.dragged.slice(0, 2).join(","),
            "| draw index dus", gripBox.idx.dus, "->", treeOrder.idx.dus,
            "| piles", gripBox.idx.piles, "->", treeOrder.idx.piles,
            "| rebuilt from the record:", treeOrder.rebuilt.slice(0, 2).join(","));
if (treeOrder.dragged[0] !== "piles" || treeOrder.dragged[1] !== "dus") {
  console.log("FAIL: the drag did not move the row", treeOrder); process.exit(1); }
if (!(treeOrder.idx.piles > treeOrder.idx.dus)) {
  console.log("FAIL: tree order is not draw order — the top row must be drawn last", treeOrder.idx); process.exit(1); }
if (treeOrder.scrambled[0] !== "dus" || treeOrder.rebuilt[0] !== "piles") {
  console.log("FAIL: the tree did not rebuild the row order from its record", treeOrder); process.exit(1); }
if (!treeOrder.stored || !treeOrder.stored["#projLayers"]) {
  console.log("FAIL: the row order was not persisted", treeOrder.stored); process.exit(1); }

/* Drag it back, and THIS is the discriminating half: "Decision units" was
   registered before "Waste piles", so insertion order alone puts the piles in
   front. Put Decision units back on top and its geometry has to be drawn LAST —
   the reverse of the order the app would have had on its own. */
grip2 = await page.evaluate(() => {
  const host = document.getElementById("projLayers");
  const dus = host.querySelector('.lyr[data-lid="dus"]'), piles = host.querySelector('.lyr[data-lid="piles"]');
  const g = dus.querySelector(".ltgrip").getBoundingClientRect(), p = piles.getBoundingClientRect();
  return { gx: g.left + g.width / 2, gy: g.top + g.height / 2, targetY: p.top + 2 };
});
await page.mouse.move(grip2.gx, grip2.gy);
await page.mouse.down();
await page.mouse.move(grip2.gx, grip2.gy - 6, { steps: 3 });
await page.mouse.move(grip2.gx, grip2.targetY, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(400);
treeOrder2 = await page.evaluate(() => ({
  order: [...document.querySelectorAll('#projLayers > .lyr')].map(r => r.dataset.lid),
  idx: { dus: SBMM.layerTree.drawIndex("framework", "dus"),
         piles: SBMM.layerTree.drawIndex("framework", "piles") }
}));
console.log("drag back:", treeOrder2.order.slice(0, 2).join(","), "| draw index", JSON.stringify(treeOrder2.idx),
            "(Decision units was registered FIRST, so this is the reverse of insertion order)");
if (treeOrder2.order[0] !== "dus" || !(treeOrder2.idx.dus > treeOrder2.idx.piles)) {
  console.log("FAIL: the top row is not drawn last", treeOrder2); process.exit(1); }

/* ---- presets: apply, undo, and never the cultural group ---- */
treePreset = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const cultId = (SBMM.layerState.list("cultural")[0] || {}).id;
  const cultBefore = cultId ? SBMM.layerState.isOn("cultural", cultId) : null;
  const before = SBMM.layerTree.snapshot();
  const names = SBMM.layerTree.presetNames();
  SBMM.layerTree.applyPreset("Terrain");
  await wait(250);
  const terrain = {
    hillshade: SBMM.layerState.isOn("base", "hillshade_site"),
    contours: SBMM.layerState.isOn("base", "contours_site"),
    dus: SBMM.layerState.isOn("framework", "dus"),
    gisExc: SBMM.layerState.isOn("design", "gis_exc"),
    samples: SBMM.layerState.isOn("invest", "samples")
  };
  SBMM.undo.pop();                        /* a preset is an undoable action */
  await wait(250);
  const restored = JSON.stringify(SBMM.layerTree.snapshot()) === JSON.stringify(before);
  SBMM.layerTree.applyPreset("Investigations");
  await wait(250);
  const invest = { samples: SBMM.layerState.isOn("invest", "samples"),
                   gisExc: SBMM.layerState.isOn("design", "gis_exc") };
  SBMM.layerTree.applySnapshot(before);
  await wait(250);
  return { names, terrain, restored, invest,
           back: JSON.stringify(SBMM.layerTree.snapshot()) === JSON.stringify(before),
           cultInSnapshot: Object.keys(before).indexOf("cultural") >= 0,
           cultMoved: cultId ? SBMM.layerState.isOn("cultural", cultId) !== cultBefore : false };
});
console.log("presets:", treePreset.names.join(" · "));
console.log("preset Terrain:", JSON.stringify(treePreset.terrain), "| undo restored:", treePreset.restored,
            "| Investigations:", JSON.stringify(treePreset.invest), "| back to where we were:", treePreset.back,
            "| cultural in a preset snapshot:", treePreset.cultInSnapshot, "| cultural moved:", treePreset.cultMoved);
if (treePreset.names.length < 6) { console.log("FAIL: the built-in presets are missing", treePreset.names); process.exit(1); }
if (!treePreset.terrain.hillshade || !treePreset.terrain.contours
    || treePreset.terrain.dus || treePreset.terrain.gisExc || treePreset.terrain.samples) {
  console.log("FAIL: the Terrain preset did not apply", treePreset.terrain); process.exit(1); }
if (!treePreset.restored) { console.log("FAIL: undo did not restore the layer state a preset changed"); process.exit(1); }
if (!treePreset.invest.samples || treePreset.invest.gisExc) {
  console.log("FAIL: the Investigations preset did not apply", treePreset.invest); process.exit(1); }
if (!treePreset.back) { console.log("FAIL: the layer state was not put back after the preset block"); process.exit(1); }
if (treePreset.cultInSnapshot || treePreset.cultMoved) {
  console.log("FAIL: a preset touched the cultural group", treePreset); process.exit(1); }

/* ---- a user preset survives a session round trip, and an old session still loads ---- */
treeSess = await page.evaluate(() => {
  SBMM.layerTree.savePreset("L round trip");
  const s = JSON.parse(JSON.stringify(SBMM.store.serialize()));
  const inFile = !!(s.layers && s.layers._tree && s.layers._tree.presets
                    && s.layers._tree.presets["L round trip"]);
  SBMM.layerTree.deletePreset("L round trip");
  const gone = SBMM.layerTree.presetNames().indexOf("L round trip") < 0;
  SBMM.layerState.restore(s.layers);
  const back = SBMM.layerTree.presetNames().indexOf("L round trip") >= 0;
  /* a pre-v16 session file has no `_tree` at all and must still load */
  const old = SBMM.layerState.restore({ framework: { dus: { on: true, opacity: 1 } } });
  SBMM.layerTree.deletePreset("L round trip");
  return { inFile, gone, back, old, sessVer: s.version };
});
console.log("user preset round trip: in the session file:", treeSess.inFile, "| deleted:", treeSess.gone,
            "| restored:", treeSess.back, "| a pre-v16 session still loads:", treeSess.old >= 1);
if (!treeSess.inFile || !treeSess.gone || !treeSess.back) {
  console.log("FAIL: a user preset did not survive a session round trip", treeSess); process.exit(1); }
if (!(treeSess.old >= 1)) { console.log("FAIL: a session without `_tree` no longer restores layers"); process.exit(1); }

/* ---- keyboard: arrows move, Space toggles ---- */
await page.evaluate(() => {
  document.querySelector('#projLayers .lyr[data-lid="dus"]').focus();
});
kbBefore = await page.evaluate(() => SBMM.layerState.isOn("framework", "dus"));
await page.keyboard.press("Space");
await page.waitForTimeout(250);
kbAfter = await page.evaluate(() => ({
  on: SBMM.layerState.isOn("framework", "dus"),
  focused: (document.activeElement.dataset || {}).lid
}));
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(150);
kbMoved = await page.evaluate(() => (document.activeElement.dataset || {}).lid);
await page.keyboard.press("Space");
await page.waitForTimeout(250);
console.log("keyboard: dus", kbBefore, "-> Space ->", kbAfter.on, "| focus after ArrowDown:", kbMoved);
if (kbAfter.on === kbBefore) { console.log("FAIL: Space on a focused row did not toggle it"); process.exit(1); }
if (!kbMoved || kbMoved === kbAfter.focused) { console.log("FAIL: ArrowDown did not move the focus", kbMoved); process.exit(1); }
await page.evaluate(on => SBMM.layerState.set("framework", "dus", { on }), kbBefore);

/* ---- the legend card lists exactly the visible rows ---- */
treeLegend = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.layerTree.legend.toggle(true);
  await wait(250);
  const el = document.getElementById("mapLegend");
  const listed = [...el.querySelectorAll(".mlonly")].map(b => b.dataset.k).sort();
  const on = [];
  for (const g of SBMM.layerState.groupList())
    for (const r of g.layers.values()) if (r.on) on.push(g.id + "/" + r.id);
  const box = el.getBoundingClientRect(), stage = document.getElementById("stage").getBoundingClientRect();
  SBMM.layerTree.legend.toggle(false);
  return { listed, on: on.sort(), z: getComputedStyle(el).zIndex,
           bottomLeft: box.left - stage.left < 40 && stage.bottom - box.bottom < 80,
           closed: document.getElementById("mapLegend").classList.contains("closed") };
});
console.log("legend card:", treeLegend.listed.length, "rows listed for", treeLegend.on.length,
            "switched on | z", treeLegend.z, "| bottom-left:", treeLegend.bottomLeft,
            "| collapses:", treeLegend.closed);
if (treeLegend.listed.join(",") !== treeLegend.on.join(",")) {
  console.log("FAIL: the legend does not list exactly the visible rows",
              { extra: treeLegend.listed.filter(k => treeLegend.on.indexOf(k) < 0),
                missing: treeLegend.on.filter(k => treeLegend.listed.indexOf(k) < 0) });
  process.exit(1);
}
if (!treeLegend.bottomLeft || !treeLegend.closed) {
  console.log("FAIL: the legend card is not a collapsible bottom-left card", treeLegend); process.exit(1); }

if (errors.length !== errBeforeTree) {
  console.log("FAIL: the layer tree raised page errors:", errors.slice(errBeforeTree, errBeforeTree + 4));
  process.exit(1);
}

/* ---- and it all comes back after a reload ---- */
/* both rows ON first, or the draw-index comparison after the reload is vacuous:
   a layer that is off has no renderer and reports -1 */
await page.evaluate(() => {
  SBMM.layerState.set("framework", "dus", { on: true });
  SBMM.layerState.set("framework", "piles", { on: true });
});
await page.waitForTimeout(400);
errBeforeReload = errors.length;
await page.reload();
await page.waitForSelector("#loading", { state: "hidden", timeout: 300000 });
/* v18: wait on the CONDITION, not on a clock. The rows re-register and the
   tree re-applies its draw order after the loader hides, and under a parallel
   matrix that took longer than the fixed 1.5 s this used to wait (the one flake
   the runner exposed). The assertion below is unchanged; only the wait is. */
await page.waitForFunction(() => {
  const d = SBMM.layerTree.drawIndex("framework", "dus");
  const p = SBMM.layerTree.drawIndex("framework", "piles");
  return p >= 0 && d > p;
}, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(300);
treeReload = await page.evaluate(() => ({
  order: [...document.querySelectorAll('#projLayers > .lyr')].map(r => r.dataset.lid),
  idx: { dus: SBMM.layerTree.drawIndex("framework", "dus"),
         piles: SBMM.layerTree.drawIndex("framework", "piles") },
  rows: document.querySelectorAll("#layers .lyr").length,
  subs: document.querySelectorAll("#layers .lgsub").length,
  analysisClosed: document.querySelector('#layers .lgsub[data-sub="analysis"]').classList.contains("closed")
}));
console.log("after a reload: order", treeReload.order.slice(0, 2).join(","), "| draw index",
            JSON.stringify(treeReload.idx), "|", treeReload.rows, "rows,", treeReload.subs, "sub-groups",
            "| Terrain analysis still closed:", treeReload.analysisClosed);
if (treeReload.order[0] !== "dus" || treeReload.order[1] !== "piles") {
  console.log("FAIL: the dragged row order did not survive a reload", treeReload.order); process.exit(1); }
if (treeReload.idx.piles < 0 || !(treeReload.idx.dus > treeReload.idx.piles)) {
  console.log("FAIL: draw order was not re-applied after a reload", treeReload.idx); process.exit(1); }
if (treeReload.rows < treeBase.keys.length) {
  console.log("FAIL: the reloaded tree has", treeReload.rows, "rows, fewer than the",
              treeBase.keys.length, "the pre-v16 build had"); process.exit(1); }
if (!treeReload.analysisClosed) {
  console.log("FAIL: Terrain analysis must still start closed (ruling F3)"); process.exit(1); }
if (errors.length !== errBeforeReload) {
  console.log("FAIL: the reloaded tree raised page errors:", errors.slice(errBeforeReload, errBeforeReload + 4));
  process.exit(1);
}
/* leave the box as we found it, so the next run does not inherit this drag */
await page.evaluate(() => { try { localStorage.removeItem("sbmm.layertree.v1"); } catch (e) {} });
});

console.log("page errors:", errors.length ? errors.slice(0, 6) : "none");
await browser.close();
if (errors.some(e => !e.includes("favicon"))) { console.log("RESULT: errors present"); process.exit(2); }
console.log("RESULT: PASS");
