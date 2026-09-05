/* v15 rehearsal — the two NEW e2e blocks (9y 3D parity, 9z labels) run on their
   own, so a gap in either is found in four minutes rather than after the
   twenty-five it takes to reach them inside test/e2e.mjs. The logic here is a
   copy of those blocks; it is a development loop, not part of the acceptance
   set (docs/V15_3D_POLISH_SPEC.md §4 lists what is).

     node test/v15_smoke.mjs /abs/path/index.html                            */
import { chromium } from "playwright";
import { pathToFileURL as furl } from "node:url";
import { resolve as pres } from "node:path";
import { existsSync as ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);
const target = process.argv[2] || "/home/user/SBM/index.html";
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(240000);
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await unlock(page);
await page.goto(furl(pres(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
console.log("booted; errors:", errors.slice(0, 6));

/* ---------------- 9y. the parity table ---------------- */
const parity = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const LS = SBMM.layerState;
  window.__parityState = LS.dump();
  for (const g of ["framework", "design", "invest", "mywork", "cultural"]) LS.setGroup(g, true);
  for (const id of ["contours_site", "contours_abp", "canopy", "trees_detected"])
    if (LS.get("base", id)) LS.set("base", id, { on: true });
  for (let i = 0; i < 120 && SBMM.drainage && !SBMM.drainage.hasResult(); i++) await wait(500);
  await wait(4000);
  if (!SBMM.viewer3d.isOpen()) { await SBMM.viewer3d.toggle(); await wait(4000); }
  for (let i = 0; i < 90; i++) {
    const st = SBMM.viewer3d.stats();
    const okCanopy = !LS.isOn("base", "canopy") || st.canopyVisible;
    const okTrees = !LS.isOn("base", "trees_detected") || !!(SBMM.trees && SBMM.trees.data);
    const okCont = !(LS.isOn("base", "contours_site") || LS.isOn("base", "contours_abp"))
                 || st.contoursVisible;
    if (okCanopy && okTrees && okCont) break;
    await wait(1000);
  }
  let treesSkipped = false;
  if (LS.isOn("base", "trees_detected") && !(SBMM.trees && SBMM.trees.data)) {
    LS.set("base", "trees_detected", { on: false });
    treesSkipped = true;
    await wait(500);
  }
  SBMM.viewer3d.refreshOverlays();
  await wait(4000);
  const drawn = SBMM.viewer3d.stats().layersDrawn;
  const rows = [];
  for (const g of ["base", "framework", "design", "invest", "cultural", "mywork"])
    for (const r of LS.list(g))
      rows.push({ group: g, id: r.id, label: String(r.label || r.id).slice(0, 60), on: !!r.on });
  const live = {};
  for (const f of SBMM.store.features)
    if (f.visible !== false) live[SBMM.myWork.classOf(f)] = 1;
  /* the layer rows that belong to a dataset that still EXISTS */
  const dsKeys = (SBMM.datasets ? SBMM.datasets.list() : [])
    .map(d => d.rowRef && d.rowRef.key).filter(Boolean);
  const st = SBMM.viewer3d.stats();
  return { drawn, rows, treesSkipped, live, dsKeys, labels3d: st.labels3d,
           labelsVisible: st.labelsVisible, sun: st.sun, sky: st.sky, ground: st.groundPlane,
           picks: SBMM.pick3d.stats() };
});
const CAD_BASEMAP = new Set(["cad_contour", "cad_parcel", "cad_road", "cad_bldg", "cad_fence",
  "cad_tree", "cad_util", "cad_env", "cad_symbol", "cad_misc", "cad_topo", "cad_du",
  "cad_storm", "cad_esc", "cad_algn", "cad_anno"]);
function exemptReason(r) {
  if (r.group === "base" && /^(Hillshade|Ortho|Slope|Aspect|Elevation tint)/.test(r.label))
    return "the 3D terrain drape (toolbar picker)";
  if (r.group === "design" && r.id === "sheets3d") return "master switch for the per-sheet drapes";
  if (r.group === "design" && r.id === "sheet_footprints") return "2D click targets";
  if (r.group === "design" && /^C-\d|^G-\d/.test(r.label)) return "a plan sheet, draped on request";
  if (CAD_BASEMAP.has(r.id)) return "EA CAD base map — 2D only";
  if (r.group === "mywork" && !parity.live[r.id]) return "no visible feature of this class";
  if (r.group === "invest" && r.id !== "samples" && !/^survey_/.test(r.id)
      && !parity.dsKeys.includes(r.group + "/" + r.id))
    return "ORPHAN ROW — its imported dataset was removed (v16 Layers work)";
  return null;
}
const on = parity.rows.filter(r => r.on);
const table = on.map(r => ({ key: r.group + "/" + r.id, label: r.label,
  objects: parity.drawn[r.group + "/" + r.id] || 0,
  exempt: (parity.drawn[r.group + "/" + r.id] || 0) ? null : exemptReason(r) }));
console.log(`\nparity: ${table.length} rows on | ${table.filter(t => t.objects).length} with objects `
  + `| ${table.filter(t => !t.objects && t.exempt).length} exempt`
  + (parity.treesSkipped ? " | trees_detected excluded (detector unfinished)" : ""));
for (const t of table.filter(t => !t.objects))
  console.log("   " + t.key.padEnd(30) + (t.exempt ? "exempt — " + t.exempt : "*** MISSING ***  " + t.label));
const missing = table.filter(t => !t.objects && !t.exempt);
console.log("MISSING ROWS:", missing.length ? missing.map(t => t.key).join(", ") : "none");
console.log("3D:", JSON.stringify({ labels3d: parity.labels3d, labelsVisible: parity.labelsVisible,
  sun: parity.sun, sky: parity.sky, ground: parity.ground, picks: parity.picks }));

/* the named §3.1 gaps */
const named = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const d = SBMM.viewer3d.stats().layersDrawn;
  const out = { pdf: !!d["design/pdf_boundaries"], contoursSite: !!d["base/contours_site"],
                contoursAbp: !!d["base/contours_abp"], drainPaths: !!d["framework/drain_paths"],
                cultural: Object.keys(d).some(k => k.indexOf("cultural/") === 0),
                datasets: (SBMM.datasets ? SBMM.datasets.threeSpec() : []).filter(sp => d[sp.rowKey]).length,
                datasetsOn: (SBMM.datasets ? SBMM.datasets.threeSpec() : []).length,
                refSurfaces: SBMM.store.features.filter(f => f.type === "surface" && f.props && f.props.ref).length };
  const sec = SBMM.store.features.filter(f => f.type === "sections").pop();
  out.hasSections = !!sec;
  if (sec) {
    SBMM.store.setVisible(sec, true);
    SBMM.viewer3d.refreshOverlays();
    await wait(1200);
    const st = SBMM.viewer3d.stats();
    out.sectionsRow = !!st.layersDrawn["mywork/sections"];
    out.stationLabels = st.labelTexts.filter(t => /^\d+\+/.test(t)).length;
  }
  return out;
});
console.log("named gaps:", JSON.stringify(named));

/* chrome */
const chrome3d = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  const before = SBMM.viewer3d.stats().orbit;
  SBMM.viewer3d.preset("w"); await wait(1400);
  out.moved = JSON.stringify(SBMM.viewer3d.stats().orbit) !== JSON.stringify(before);
  const b2 = SBMM.viewer3d.stats().orbit;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", bubbles: true }));
  await wait(1200);
  out.keyPreset = JSON.stringify(SBMM.viewer3d.stats().orbit) !== JSON.stringify(b2);
  const b3 = SBMM.viewer3d.stats().orbit;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "#", code: "Digit3", shiftKey: true, bubbles: true }));
  await wait(1200);
  out.keyShift3 = JSON.stringify(SBMM.viewer3d.stats().orbit) !== JSON.stringify(b3);
  out.stillOpen = SBMM.viewer3d.isOpen();
  out.animWater = !!document.getElementById("v3dAnimWater");
  out.sunAz = !!document.getElementById("v3dSunAz");
  out.lookAt = !!document.getElementById("v3dLookAt");
  out.elevLegend = (document.getElementById("v3dElevLeg") || { textContent: "" }).textContent.trim().length > 0;
  const s0 = SBMM.viewer3d.sun();
  SBMM.viewer3d.sun(120, 60);
  out.sunSet = SBMM.viewer3d.sun();
  SBMM.viewer3d.sun(s0.az, s0.el);
  return out;
});
console.log("chrome:", JSON.stringify(chrome3d));

/* the stage labels follow the slider */
const lbl = await page.evaluate(async () => {
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
  return { belowTexts: below.labelTexts, aboveTexts: atRim.labelTexts,
           registered: atRim.labels3d, visible: atRim.labelsVisible };
});
console.log("below the culvert:", JSON.stringify(lbl.belowTexts));
console.log("above the rim:   ", JSON.stringify(lbl.aboveTexts));
console.log("label counts:", lbl.visible, "of", lbl.registered);

/* ---------------- 9z. the 2D label engine ---------------- */
await page.evaluate(async () => {
  SBMM.water.clearOvertop();
  if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
  SBMM.layerState.setGroup("cultural", false);
  if (window.__parityState) SBMM.layerState.restore(window.__parityState);
  await new Promise(r => setTimeout(r, 800));
});
const lab = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ringOf = nm => SBMM_DATA.design_gis.features.find(
    f => f.properties.layer === "water" && f.properties.name === nm).geometry.coordinates[0];
  const out = {};
  const R = await SBMM.water.overtop({ ring: ringOf("Frog Pond").map(q => [q[0], q[1]]), name: "Frog Pond" });
  await wait(500);
  await SBMM.water.dropAt(R.conduitSpill.x, R.conduitSpill.y, { name: "ZZ label probe 1" });
  await wait(600);
  await SBMM.water.dropAt(R.conduitSpill.x, R.conduitSpill.y, { name: "ZZ label probe 2" });
  await wait(600);
  SBMM.map.setView([2127900, 6374020], 2, { animate: false });
  await wait(700);
  SBMM.labels.place();
  const vis = SBMM.labels.visible(), boxes = SBMM.labels.boxes();
  out.stats = SBMM.labels.stats();
  const perKey = {};
  for (const v of vis) if (v.key && v.key.indexOf("pond:") === 0) perKey[v.key] = (perKey[v.key] || 0) + 1;
  out.pondKeys = perKey;
  out.pondMax = Object.values(perKey).reduce((a, b) => Math.max(a, b), 0);
  out.dupHidden = out.stats.dup;
  const ov = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (!(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top))
      ov.push([a.key || a.id, b.key || b.id]);
  }
  out.overlapZoom = ov; out.nBoxes = boxes.length;
  SBMM.map.fitBounds(SBMM.demSite.bounds(), { animate: false });
  await wait(700);
  SBMM.labels.place();
  const b2 = SBMM.labels.boxes();
  const ov2 = [];
  for (let i = 0; i < b2.length; i++) for (let j = i + 1; j < b2.length; j++) {
    const a = b2[i], b = b2[j];
    if (!(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top))
      ov2.push([a.key || a.id, b.key || b.id]);
  }
  out.overlapSite = ov2; out.nBoxesSite = b2.length;
  return out;
});
console.log("2D labels:", JSON.stringify({ stats: lab.stats, pondKeys: lab.pondKeys,
  pondMax: lab.pondMax, dup: lab.dupHidden, boxes: lab.nBoxes,
  overlapsZoom: lab.overlapZoom.length, boxesSite: lab.nBoxesSite, overlapsSite: lab.overlapSite.length }));

const labDrain = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  SBMM.layerState.set("framework", "drain_outlet", { on: true });
  for (let i = 0; i < 120 && !SBMM.drainage.hasResult(); i++) await wait(500);
  await wait(1200);
  SBMM.map.fitBounds(SBMM.demSite.bounds(), { animate: false });
  await wait(800);
  SBMM.labels.place();
  const b = SBMM.labels.boxes().filter(q => q.owner === "drainage");
  const all = SBMM.labels.boxes();
  const ov = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const x = all[i], y = all[j];
    if (!(x.right < y.left || y.right < x.left || x.bottom < y.top || y.bottom < x.top))
      ov.push([x.key, y.key]);
  }
  SBMM.layerState.set("framework", "drain_outlet", { on: false });
  return { drainVisible: b.length, allVisible: all.length, overlaps: ov, stats: SBMM.labels.stats() };
});
console.log("with the drainage map on:", JSON.stringify(labDrain));
console.log("errors:", errors.length ? errors.slice(0, 8) : "none");
await browser.close();
