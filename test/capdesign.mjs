/* The NW Pit cap design viewer (js/capdesign.js).
   ------------------------------------------------------------------------
   Boots the app over file:// and checks, in order:
     1. the built in design: rows, panel and point readings all come from the
        design file (data/cap_design.json is read here and compared);
     2. the 3D view: every layer that is on draws under its own row (the 3D
        parity rule), the cap mesh, the relief setting, the opacity slider, the
        switch for the cap contours in 3D;
     3. the upload path: the same design with rev "r1-test", one key number
        changed, one layer renamed and one layer removed goes through the real
        file input; panel, rows, layers and the 3D section must follow;
     4. bad files are refused with a reason and nothing in use changes;
     5. the loaded design survives a reload; "Reset to built in design" undoes it;
     6. a schema 1 file (the first export) still loads;
     7. a build with no cap payload boots, says so, and takes an uploaded file;
     8. a stored design that has gone bad is dropped at boot, with a line saying so.

   Usage: node test/capdesign.mjs /abs/path/index.html folder     (or the dist html)
          node test/run.mjs --only capdesign:folder               (the runner)
   Run the browser harnesses one at a time. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
const label = process.argv[3] || "folder";
if (!target) { console.log("usage: node test/capdesign.mjs <index.html | dist html> [label]"); process.exit(2); }

/* THE FIXTURE. Sections 1 to 8 test the module, not the design a build happens to
   ship: test/fixtures/cap_design_r1.json (the first design, kept as it was) is put
   in as the built in design before the page's own payloads run, and any further
   built in design is left out. So a new revision of the shipped design never
   touches these sections. Section 9 then opens the page as shipped and checks the
   designs it really carries (data/cap_design.json and data/cap_design_<x>.json). */
const FILE = JSON.parse(readFileSync(resolve(HERE, "fixtures/cap_design_r1.json"), "utf8"));
const SHIP = ["cap_design.json", "cap_design_r7.json"].map(f => JSON.parse(readFileSync(resolve(HERE, "../data/" + f), "utf8")));
const asBuiltIn = fix => {
  let store;
  Object.defineProperty(window, "SBMM_DATA", { configurable: true, get: () => store,
    set(v) { store = new Proxy(v, { set(o, k, val) { if (k === "cap_design") o[k] = fix; else if (!/^cap_design_/.test(String(k))) o[k] = val; return true; } }); } });
};
const TMP = mkdtempSync(join(tmpdir(), "sbmm-cap-"));
const put = (name, obj) => { const p = join(TMP, name); writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); return p; };
const clone = o => JSON.parse(JSON.stringify(o));

const MOD = clone(FILE);
MOD.rev = "r1-test";
const NEW_FILL = 7.77;
MOD.numbers.find(n => n.key === "fill_limit_ac").value = NEW_FILL;
MOD.layers.find(l => l.key === "fill").name = "Fill limit TEST";
const DROPPED = "isopach";
MOD.layers = MOD.layers.filter(l => l.key !== DROPPED);
const MOD_PATH = put("cap_design_r1-test.json", MOD);

const wrongSize = clone(FILE); wrongSize.rev = "bad-size"; wrongSize.raster.w += 1;
const offSite = clone(FILE); offSite.rev = "bad-xy"; offSite.layers[0].features[0].pts[0][0] += 2e6;
const noLayers = { schema: 2, rev: "bad-empty", numbers: [], params: [] };
const BAD = [
  ["not JSON",                         put("bad_text.json", "this is not json {"),  /not a JSON file/],
  ["no layers",                        put("bad_empty.json", noLayers),             /no layers/],
  ["raster size does not match image", put("bad_size.json", wrongSize),             /says 183 x 235 cells but its image is 182 x 235/],
  ["a coordinate off the site",        put("bad_xy.json", offSite),                 /off the site/],
  ["another schema",                   put("bad_schema.json", Object.assign(clone(FILE), { schema: 9 })), /schema 1 or 2 expected/],
];

/* a schema 1 file, as the first export wrote it */
const pick = k => FILE.layers.find(l => l.key === k);
const OLD = {
  schema: 1, id: FILE.id, rev: "r0-schema1", date: FILE.date, title: FILE.title, status: FILE.status,
  params: Object.fromEntries(FILE.params.map(p => [p.key, p.value])),
  numbers: Object.fromEntries(FILE.numbers.map(p => [p.key, p.value])),
  layers: FILE.layers.filter(l => l.kind === "poly" || (l.kind === "line" && l.key !== "sections")).map(l => { const c = clone(l); delete c.three; return c; }),
  points: pick("points").features.map(f => ({ name: f.props.name, x: f.pt[0], y: f.pt[1], elev_ft: f.props.elev_ft, note: f.props.note })),
  segments: pick("segments").features.map(f => ({ n: f.props.id, x: f.pt[0], y: f.pt[1], name: f.props.name, edge_ft: f.props.edge_ft, text: f.props.note })),
  sections: pick("sections").features.map(f => ({ name: f.props.label, pts: f.pts })),
  raster: FILE.raster
};
const OLD_PATH = put("cap_design_schema1.json", OLD);

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) failed++; };
const errors = [];

const settled = async page => {
  await page.waitForSelector("#loading", { state: "hidden", timeout: TIMEOUT });
  await lateSettled(page);
  await page.evaluate(() => SBMM.capDesign && SBMM.capDesign.whenReady());
};
/* asShipped: leave the page's own cap payloads alone (section 9) */
async function open(browser, init, arg, asShipped) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.setDefaultTimeout(TIMEOUT);
  page.on("pageerror", e => { errors.push("pageerror: " + e.message); console.log("pageerror:", e.message); });
  await unlock(page);
  if (!asShipped) await page.addInitScript(asBuiltIn, FILE);
  if (init) await page.addInitScript(init, arg);
  await page.goto(pathToFileURL(resolve(target)).href);
  await settled(page);
  return page;
}
/* what the page says about the design in use */
const state = page => page.evaluate(() => {
  const C = SBMM.capDesign, d = C.design(), q = s => document.querySelector(s);
  const rows = [...document.querySelectorAll('#projLayers .lyr[data-lid^="cap_"]')];
  const shown = rows.filter(r => !r.classList.contains("capgone"));
  return {
    rev: d && d.rev, src: C.source(), keys: C.layerKeys(),
    rows: rows.length, shown: shown.length,
    labels: Object.fromEntries(shown.map(r => [r.dataset.lid, r.querySelector(".lbl").textContent])),
    sub: !!q('#projLayers .ltsub[data-sub="nw_pit_cap_design"]'),
    active: (q("#capActive") || {}).textContent || "",
    numbers: (q("#capNumbers") || {}).textContent || "",
    params: (q("#capParams") || {}).textContent || "",
    notes: document.querySelectorAll("#capNotes .capn").length,
    msg: (q("#capMsg") || {}).textContent || "",
    resetOff: !!(q("#capReset") && q("#capReset").disabled),
    loadBtn: !!q("#capLoad") && !!q("#capFile"),
    stored: (() => { try { const s = localStorage.getItem(C.STORE_KEY); return s ? JSON.parse(s).design.rev : null; } catch (e) { return "error"; } })(),
    fillOnMap: !!(C.rows().fill && SBMM.map.hasLayer(C.rows().fill.group)),
    fillShapes: C.rows().fill ? C.rows().fill.group.getLayers().length : 0
  };
});
const upload = async (page, path, done) => {
  await page.setInputFiles("#capFile", path);
  await page.waitForFunction(done, null, { timeout: TIMEOUT });
};

console.log(`\n=== capdesign: ${label} ===`);
const browser = await launch();
let page = await open(browser);
console.log("boot: OK");

/* ---- 1. the built in design ------------------------------------------- */
let s = await state(page);
check(s.rev === FILE.rev && s.src.kind === "builtin", `built in design in use: rev ${s.rev}, source ${s.src.kind}`);
check(s.sub, "the rows sit in their own sub-group under Site framework");
check(s.shown === FILE.layers.length + 1, `one row per layer of the file plus the 3D surface row: ${s.shown} (want ${FILE.layers.length + 1})`);
check(FILE.layers.every(l => s.labels["cap_" + l.key] === l.name), "every row is named by the file");
check(s.labels.cap_3d_surface === FILE.surface.name, "the 3D surface row is named by the file: " + s.labels.cap_3d_surface);
check(/Built in design/.test(s.active) && s.active.includes(FILE.rev) && s.active.includes(FILE.date), "the panel says which design is active: " + s.active);
check(FILE.numbers.every(n => s.numbers.includes(n.label)) && s.numbers.includes("5.14") && s.numbers.includes("205,813"),
      "the panel numbers and their labels are the file's");
check(FILE.params.every(n => s.params.includes(n.label)), "the parameters and their labels are the file's");
check(s.notes === pick("segments").features.length, `the perimeter notes are listed from the file: ${s.notes}`);
check(s.loadBtn && s.resetOff, "the load control is there and Reset is off while the built in design is active");
check(s.stored === null, "nothing is stored on the device yet");
const off0 = await page.evaluate(() => [...document.querySelectorAll('#projLayers .lyr[data-lid^="cap_"]')]
  .filter(r => SBMM.layerState.isOn("framework", r.dataset.lid)).length);
check(off0 === 0 && !s.fillOnMap, "every cap row starts off: nothing of the cap is on the map until it is asked for");

const q1 = await page.evaluate(() => {
  const C = SBMM.capDesign;
  C.show();
  return { mid: C.at(6371965, 2128930), out: C.at(6371500, 2128500), notch: C.at(6371968, 2129205),
           fill: C.number("fill_limit_ac"), air: C.number("airspace_cy"),
           chip: SBMM.readout.read("capdesign", 6371965, 2128930, { view: "2d" }),
           chipOut: SBMM.readout.read("capdesign", 6371500, 2128500, { view: "2d" }) };
});
console.log("cap @ (6371965, 2128930):", JSON.stringify(q1.mid));
check(Math.abs(q1.fill - 5.14) < 0.005 && q1.air === 205813, `key numbers: fill limit ${q1.fill} ac, airspace ${q1.air} CY`);
check(Math.abs(q1.mid.cap - 1410.06) < 0.2, `cap surface in the middle of the pit: ${q1.mid.cap.toFixed(2)} ft`);
check(q1.mid.depth > 30 && Math.abs(q1.mid.depth - (q1.mid.cap - q1.mid.ground)) < 1e-6,
      `fill depth there: ${q1.mid.depth.toFixed(2)} ft over ground ${q1.mid.ground.toFixed(2)} ft`);
check(isNaN(q1.out.cap ?? NaN) && !isNaN(q1.out.ground), "outside the fill limit: no cap elevation, the ground is still reported");
check(q1.notch.cap > 1378 && q1.notch.cap < 1392, `tie down at the north notch: ${q1.notch.cap.toFixed(2)} ft`);
check(q1.chip && /cap 1,410\.\d ft, fill \d+\.\d ft/.test(q1.chip.value) && q1.chipOut === null,
      "the point reader answers on the cap and not off it: " + (q1.chip && q1.chip.value));
s = await state(page);
check(s.fillOnMap && s.fillShapes === pick("fill").features.length, `the fill limit is on the 2D map: ${s.fillShapes} shape(s)`);

/* ---- 2. the 3D view --------------------------------------------------- */
await page.evaluate(() => SBMM.viewer3d.openAt(6371965, 2128930));
await page.waitForFunction(() => SBMM.capDesign.stats3d().tris > 0, null, { timeout: TIMEOUT });
let t = await page.evaluate(() => ({ st: SBMM.capDesign.stats3d(), sec: SBMM.viewer3d.overlaySections().cap,
                                     exag: parseFloat(document.getElementById("v3dExag").value) }));
console.log("3D:", JSON.stringify(t.st));
const lineLike = l => (l.kind === "poly" || l.kind === "line") && l.three !== "level";
const drapes = FILE.layers.filter(l => lineLike(l) && l.on !== false).reduce((n, l) => n + l.features.length, 0);
const dots = FILE.layers.filter(l => (l.kind === "point" || l.kind === "note") && l.on !== false).length;
check(t.st.tris > 20000, `the cap mesh is in the 3D overlay: ${t.st.tris} triangles`);
check(t.st.drape === drapes && t.st.dots === dots && t.st.level === 1,
      `draped lines ${t.st.drape} (want ${drapes}), point sets ${t.st.dots} (want ${dots}), level contour sets ${t.st.level}`);
/* the 3D parity rule, as test/e2e.mjs and test/e2e_field.mjs ask it: every cap row, switched on, draws */
const parity = await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('#projLayers .lyr[data-lid^="cap_"]')].map(r => r.dataset.lid);
  const was = rows.filter(id => SBMM.layerState.isOn("framework", id));
  const n0 = SBMM.capDesign.stats3d().calls;
  SBMM.layerState.batch(rows.map(id => ({ group: "framework", layer: id, on: true })));
  SBMM.viewer3d.refreshOverlays("cap");
  for (let i = 0; i < 100 && SBMM.capDesign.stats3d().calls === n0; i++) await new Promise(r => setTimeout(r, 50));
  const drawn = SBMM.viewer3d.stats().layersDrawn;
  const missing = rows.filter(id => !drawn["framework/" + id]);
  const n1 = SBMM.capDesign.stats3d().calls;
  SBMM.layerState.batch(rows.map(id => ({ group: "framework", layer: id, on: was.includes(id) })));
  SBMM.viewer3d.refreshOverlays("cap");
  for (let i = 0; i < 100 && SBMM.capDesign.stats3d().calls === n1; i++) await new Promise(r => setTimeout(r, 50));
  return { rows: rows.length, missing };
});
check(parity.missing.length === 0, `3D parity: all ${parity.rows} cap rows draw in 3D when on` + (parity.missing.length ? ", missing " + parity.missing.join(", ") : ""));
check(!!t.sec, "the 3D overlay has a section of its own for the cap");
check(Math.abs(t.st.reliefZ - t.exag) < 1e-6, `the cap follows the relief setting: drawn at ${t.st.reliefZ} with relief ${t.exag}`);
t = await page.evaluate(async () => {
  const el = document.getElementById("v3dExag");
  el.value = "2.5"; el.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const a = SBMM.capDesign.stats3d().reliefZ;
  el.value = "1.5"; el.dispatchEvent(new Event("input", { bubbles: true }));
  return a;
});
check(Math.abs(t - 2.5) < 1e-6, `relief 2.5 scales the cap by ${t}`);
t = await page.evaluate(async () => {
  /* the first event a row sends after the 3D view opens is taken as a switch
     (js/viewer3d.js rowWasOn), so the slider is moved twice and the second
     move is the one that must not rebuild */
  const C = SBMM.capDesign, sl = C.surfaceRow().row.querySelector(".opac");
  const move = async v => { sl.value = v; sl.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(r => setTimeout(r, 500)); return C.stats3d(); };
  const first = C.stats3d(), before = await move("50"), after = await move("30");
  return { first, before, after };
});
check(Math.abs(t.before.opacity - 0.5) < 1e-6 && Math.abs(t.after.opacity - 0.3) < 1e-6 && t.after.calls === t.before.calls,
      `the opacity slider moves the live surface (${t.first.opacity}, ${t.before.opacity}, ${t.after.opacity}) without a rebuild`);
const flip = (id, on) => page.evaluate(async ([id, on]) => {
  const n = SBMM.capDesign.stats3d().calls;
  SBMM.layerState.set("framework", id, { on });
  for (let i = 0; i < 100 && SBMM.capDesign.stats3d().calls === n; i++) await new Promise(r => setTimeout(r, 50));
  return SBMM.capDesign.stats3d();
}, [id, on]);
const level = on => page.evaluate(async on => {
  const C = SBMM.capDesign, n = C.stats3d().calls, box = document.getElementById("capLevel3d");
  if (box.checked !== on) box.click();
  for (let i = 0; i < 100 && C.stats3d().calls === n; i++) await new Promise(r => setTimeout(r, 50));
  return Object.assign(C.stats3d(), { on2d: SBMM.map.hasLayer(C.rows().contours.group), box: box.checked });
}, on);
let a = await level(false), b = await level(true);
check(a.level === 0 && a.tris > 0 && a.on2d && a.drape === drapes && b.level === 1 && b.box,
      "the cap contours in 3D switch takes the level contours out of the 3D view and leaves the 2D map alone");
a = await flip("cap_contours", false); b = await flip("cap_contours", true);
check(a.level === 0 && b.level === 1, "the contours row switches them in 3D as well");
a = await flip("cap_3d_surface", false); b = await flip("cap_3d_surface", true);
check(a.tris === 0 && b.tris > 0 && Math.abs(b.opacity - 0.3) < 1e-6, "the surface row switches the mesh, and it comes back at the slider's opacity");
a = await flip("cap_fill", false); b = await flip("cap_fill", true);
check(a.drape === drapes - pick("fill").features.length && b.drape === drapes, "a draped layer follows its own row in 3D");
await page.screenshot({ path: resolve(HERE, `.logs/capdesign_${label}_3d.png`) }).catch(() => {});

/* ---- 3. the upload path ----------------------------------------------- */
const calls0 = (await page.evaluate(() => SBMM.capDesign.stats3d())).calls;
await upload(page, MOD_PATH, () => SBMM.capDesign.design().rev === "r1-test");
await page.waitForFunction(n => SBMM.capDesign.stats3d().calls > n, calls0, { timeout: TIMEOUT });
s = await state(page);
t = await page.evaluate(() => ({ st: SBMM.capDesign.stats3d(), n: SBMM.capDesign.number("fill_limit_ac"), mid: SBMM.capDesign.at(6371965, 2128930) }));
check(s.rev === "r1-test" && s.src.kind === "loaded" && s.src.name === "cap_design_r1-test.json", `the uploaded file is the design in use: ${s.rev} from ${s.src.name}`);
check(/Loaded file cap_design_r1-test\.json/.test(s.active) && s.active.includes("r1-test"), "the panel says so: " + s.active);
check(s.numbers.includes("7.77") && !s.numbers.includes("5.14") && t.n === NEW_FILL, "the changed number is on the panel: fill limit " + t.n + " ac");
check(s.labels.cap_fill === "Fill limit TEST", "the renamed layer's row follows: " + s.labels.cap_fill);
check(!("cap_" + DROPPED in s.labels) && s.shown === MOD.layers.length + 1 && !s.keys.includes(DROPPED), `the layer the file no longer has is gone from the list (${s.shown} rows shown)`);
check(s.fillOnMap && s.fillShapes === 1, "the 2D layers were refilled from the new file");
check(t.st.tris > 20000 && Math.abs(t.mid.cap - q1.mid.cap) < 1e-6, `the 3D section was rebuilt from the new file: ${t.st.tris} triangles`);
check(s.stored === "r1-test" && s.src.kept === true && !s.resetOff, "the file is stored on the device and Reset is offered");
await page.screenshot({ path: resolve(HERE, `.logs/capdesign_${label}_loaded.png`) }).catch(() => {});

/* ---- 4. bad files ------------------------------------------------------ */
for (const [name, path, re] of BAD) {
  await page.evaluate(() => { document.getElementById("capMsg").textContent = ""; });
  await upload(page, path, () => /refused/.test(document.getElementById("capMsg").textContent));
  const r = await state(page);
  check(re.test(r.msg) && /was not changed/.test(r.msg), `refused, ${name}: ${r.msg}`);
  check(r.rev === "r1-test" && r.stored === "r1-test" && r.labels.cap_fill === "Fill limit TEST" && r.numbers.includes("7.77"),
        `  and the design in use is untouched (${r.rev})`);
}

/* ---- 5. across a reload, and back -------------------------------------- */
await page.reload();
await page.waitForSelector("#loading", { state: "hidden", timeout: TIMEOUT });
await lateSettled(page);
await page.evaluate(() => SBMM.capDesign.whenReady());
s = await state(page);
t = await page.evaluate(() => ({ ready: SBMM.capDesign.isReady(), mid: SBMM.capDesign.at(6371965, 2128930) }));
check(s.rev === "r1-test" && s.src.kind === "loaded" && /Loaded file/.test(s.active) && s.numbers.includes("7.77"),
      "after a reload the loaded design is still the one in use: " + s.active);
check(s.rows === MOD.layers.length + 1 && s.labels.cap_fill === "Fill limit TEST", `the rows were built from the stored file: ${s.rows}`);
check(t.ready && Math.abs(t.mid.cap - q1.mid.cap) < 1e-6, "its surface was decoded again");
/* the panel is in the catalogue face of the Layers pane: open it there and press the real button */
await page.evaluate(() => SBMM.capDesign.openPanel());
await page.click("#capReset");
await page.waitForFunction(() => SBMM.capDesign.source().kind === "builtin", null, { timeout: TIMEOUT });
s = await state(page);
check(s.rev === FILE.rev && /Built in design/.test(s.active) && s.numbers.includes("5.14") && s.stored === null && s.resetOff,
      "Reset to built in design: " + s.active);
check(s.labels.cap_fill === pick("fill").name && s.labels["cap_" + DROPPED] === pick(DROPPED).name && s.shown === FILE.layers.length + 1,
      "the built in rows are back, the missing one added");

/* ---- 6. a schema 1 file ------------------------------------------------ */
/* dropped on the panel, as a person would */
const drop = (page, sel, path, name) => page.evaluate(([sel, text, name]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: "application/json" }));
  const el = sel ? document.querySelector(sel) : document.body;
  el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [sel, readFileSync(path, "utf8"), name]);
const feats0 = await page.evaluate(() => SBMM.store.features.length);
await drop(page, "#capPanel", OLD_PATH, "cap_design_schema1.json");
await page.waitForFunction(() => SBMM.capDesign.design().rev === "r0-schema1", null, { timeout: TIMEOUT });
s = await state(page);
check(s.src.name === "cap_design_schema1.json" && (await page.evaluate(() => SBMM.store.features.length)) === feats0,
      "a file dropped on the panel is loaded as a cap design and is not imported as features");
check(["points", "segments", "sections"].every(k => s.keys.includes(k)) && s.notes === OLD.segments.length && s.numbers.includes("fill limit ac"),
      "a schema 1 file loads: its points, segments and sections are layers, its number keys are the labels");
/* dropped anywhere else, or picked in File > Import: the app's own import hands it over (js/io.js) */
await drop(page, null, MOD_PATH, "cap_design_r1-test.json");
await page.waitForFunction(() => SBMM.capDesign.design().rev === "r1-test", null, { timeout: TIMEOUT });
check((await page.evaluate(() => SBMM.store.features.length)) === feats0, "a cap design dropped on the map goes to the cap module, not to the feature import");
await page.evaluate(() => { document.getElementById("capMsg").textContent = ""; });
await page.setInputFiles("#importFile", BAD[2][1]);
await page.waitForFunction(() => /refused/.test(document.getElementById("capMsg").textContent), null, { timeout: TIMEOUT });
s = await state(page);
check(s.rev === "r1-test" && BAD[2][2].test(s.msg) && (await page.evaluate(() => SBMM.store.features.length)) === feats0,
      "a bad cap design picked in File > Import is refused by the cap module with its reason");
await page.evaluate(() => SBMM.capDesign.openPanel());
await page.click("#capReset");
await page.waitForFunction(() => SBMM.capDesign.source().kind === "builtin", null, { timeout: TIMEOUT });
await page.close();

/* ---- 7. a build with no cap payload ------------------------------------ */
page = await open(browser, () => {
  /* the payload's own assignment is dropped, as if the build did not carry it */
  let store;
  Object.defineProperty(window, "SBMM_DATA", { configurable: true, get: () => store,
    set(v) { store = new Proxy(v, { set(o, k, val) { if (!/^cap_design/.test(String(k))) o[k] = val; return true; } }); } });
});
s = await state(page);
check(s.rev == null && s.src.kind === "none" && /No cap design in this build/.test(s.active) && s.loadBtn,
      "without the payload the app boots and the panel says so: " + s.active);
check(s.shown === 0 && s.rows === 0, `no cap rows are listed: ${s.shown}`);
await upload(page, MOD_PATH, () => SBMM.capDesign.design() && SBMM.capDesign.design().rev === "r1-test");
s = await state(page);
check(s.shown === MOD.layers.length + 1 && s.labels.cap_fill === "Fill limit TEST" && s.fillOnMap,
      `an uploaded file fills it in: ${s.shown} rows, the fill limit on the map`);
await page.evaluate(() => SBMM.capDesign.reset());
s = await state(page);
check(s.rev == null && s.shown === 0 && s.stored === null && /No cap design in this build/.test(s.active), "and Reset empties it again");
await page.close();

/* ---- 8. a stored design that has gone bad ------------------------------- */
const seed = ([key, text]) => { try { if (!sessionStorage.getItem("capseed")) { localStorage.setItem(key, text); sessionStorage.setItem("capseed", "1"); } } catch (e) {} };
const KEY = "sbmm.capdesign.v1";
for (const [what, design, re] of [["its shape is wrong", noLayers, /no layers/], ["its raster does not match", wrongSize, /says 183 x 235 cells/]]) {
  page = await open(browser, seed, [KEY, JSON.stringify({ name: "old.json", t: 1, design })]);
  await page.waitForFunction(() => SBMM.capDesign.source().kind === "builtin" && SBMM.capDesign.isReady(), null, { timeout: TIMEOUT });
  s = await state(page);
  check(s.rev === FILE.rev && s.stored === null && /stored on this device could not be used/.test(s.msg) && re.test(s.msg),
        `a stored design is dropped at boot when ${what}: ${s.msg}`);
  await page.close();
}

/* ---- 9. the designs this build ships ------------------------------------ */
page = await open(browser, null, null, true);
const shipped = () => page.evaluate(() => {
  const C = SBMM.capDesign, d = C.design();
  return { list: C.builtIns(), rev: d && d.rev, kind: C.source().kind, area: C.number("cap_limit_ac"),
    bad: Object.keys(SBMM_DATA).filter(k => /^cap_design/.test(k)).map(k => k + ": " + C.validate(SBMM_DATA[k])).filter(t => !/: null$/.test(t)),
    btns: [...document.querySelectorAll("#capBuiltins .capbi")].map(sb => sb.dataset.rev + (sb.classList.contains("active") ? "*" : "")),
    mid: C.at(6371965, 2128930).cap };
});
const areaOf = d => d.numbers.find(n => n.key === "cap_limit_ac").value;
let sb = await shipped();
check(sb.bad.length === 0, "every cap design the build ships passes the file checks" + (sb.bad.length ? ": " + sb.bad.join("; ") : ""));
check(sb.list.join() === SHIP.map(d => d.rev).join() && sb.rev === SHIP[0].rev && sb.kind === "builtin",
      `the build carries ${sb.list.join(" and ")}; ${sb.rev} (data/cap_design.json) is the one in use`);
check(sb.btns.join() === SHIP.map((d, i) => d.rev + (i ? "" : "*")).join(), "the panel has one button per built in design, the one in use marked: " + sb.btns.join(" "));
check(sb.area === areaOf(SHIP[0]) && sb.mid > 1300, `its numbers and its surface are read: ${sb.area} ac, ${sb.mid && sb.mid.toFixed(1)} ft at the middle`);
s = await state(page);
check(s.shown === SHIP[0].layers.length + 1 && SHIP[0].layers.every(l => s.labels["cap_" + l.key] === l.name), `its rows are the file's: ${s.shown}`);
await page.evaluate(() => SBMM.capDesign.openPanel());
await page.click(`#capBuiltins .capbi[data-rev="${SHIP[1].rev}"]`);
await page.waitForFunction(r => SBMM.capDesign.design().rev === r && SBMM.capDesign.isReady(), SHIP[1].rev, { timeout: TIMEOUT });
sb = await shipped(); s = await state(page);
check(sb.rev === SHIP[1].rev && sb.kind === "builtin" && sb.area === areaOf(SHIP[1]) && sb.btns.join() === SHIP.map((d, i) => d.rev + (i ? "*" : "")).join(),
      `a button puts the other design in use: ${sb.rev}, ${sb.area} ac`);
check(s.shown === SHIP[1].layers.length + 1 && SHIP[1].layers.every(l => s.labels["cap_" + l.key] === l.name) && s.stored === null && s.resetOff,
      `the rows follow it and nothing is stored as a loaded file: ${s.shown}`);
await page.reload();
await settled(page);
sb = await shipped();
check(sb.rev === SHIP[1].rev && sb.kind === "builtin", "the choice is kept on the device: after a reload " + sb.rev + " is still in use");
await upload(page, MOD_PATH, () => SBMM.capDesign.design().rev === "r1-test");
await page.evaluate(() => SBMM.capDesign.reset());
sb = await shipped();
check(sb.rev === SHIP[1].rev && sb.kind === "builtin", "Reset after a loaded file goes back to the design that was picked: " + sb.rev);
await page.evaluate(r => SBMM.capDesign.pick(r), SHIP[0].rev);
sb = await shipped();
check(sb.rev === SHIP[0].rev && (await page.evaluate(() => SBMM.capDesign.pick("no-such-rev"))).ok === false && (await shipped()).rev === SHIP[0].rev,
      "pick() by rev works from code, and a rev the build does not have changes nothing");
await page.close();

if (errors.length) { console.log("page errors:"); errors.forEach(e => console.log("  " + e)); }
check(errors.length === 0, "no page errors");
await browser.close();
console.log(failed ? `\nCAPDESIGN ${label}: ${failed} FAILED` : `\nCAPDESIGN ${label}: PASS`);
process.exit(failed ? 1 : 0);
