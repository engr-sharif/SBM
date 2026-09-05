/* Fresh-eyes walkthrough. Not pass/fail — it drives every tool, command and
   dialog end to end and prints what happened, so paper cuts show up as text.
   node test/audit.mjs /abs/path/index.html folder                          */
import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium (npx playwright install chromium)

const target = process.argv[2];
const label = process.argv[3] || target;
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(180000);
const errs = [];
page.on("pageerror", e => errs.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
page.on("dialog", d => d.accept());

console.log(`\n=== audit: ${label} ===`);
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 180000 });
await page.evaluate(() => SBMM.chmReady);

const say = (k, v) => console.log(`  ${String(k).padEnd(42)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
const probe = async (k, fn, arg) => {
  let v; try { v = await page.evaluate(fn, arg); } catch (e) { v = "THREW " + e.message.split("\n")[0].slice(0, 140); }
  say(k, v);
  return v;
};

/* toast capture: record every toast the app raises, so "silent failure" is testable */
await page.evaluate(() => {
  window.__toasts = [];
  const orig = window.toast;
  window.toast = function (m, ms) { window.__toasts.push(String(m)); return orig.apply(this, arguments); };
});
const toasts = async () => page.evaluate(() => { const t = window.__toasts.slice(); window.__toasts.length = 0; return t; });

/* ------------------------------------------------------------------ */
console.log("\n-- 1. empty states on a fresh boot --");
await probe("panels with a placeholder", () => {
  const out = {};
  for (const id of ["resBody", "featureTree", "propsBody", "secBody"]) {
    const el = document.getElementById(id);
    out[id] = el ? (el.querySelector(".placeholder") ? el.querySelector(".placeholder").textContent.trim().slice(0, 70) : "(no placeholder) " + el.textContent.trim().slice(0, 40)) : "MISSING";
  }
  return out;
});
await probe("table drawer, no dataset tab selected", () => {
  SBMM.table.toggle(true);
  const s = document.getElementById("tblTabStrip");
  const r = { tabs: [...s.children].map(b => b.textContent.trim().replace(/\s+/g, " ")), active: SBMM.dsTable.active() };
  SBMM.table.toggle(false);
  return r;
});

/* ------------------------------------------------------------------ */
console.log("\n-- 2. every tool arms and disarms cleanly --");
await probe("setTool round trip", () => {
  const out = {};
  for (const t of ["inspect", "distance", "area", "volume", "profile"]) {
    SBMM.tools.setTool(null); SBMM.tools.setTool(t);
    const btn = document.querySelector(`.toolbtn[data-tool="${t}"]`);
    out[t] = { active: SBMM.tools.active(), btnLit: !!(btn && btn.classList.contains("active")), tip: (document.getElementById("sketchTip").textContent || "").slice(0, 34) };
  }
  SBMM.tools.setTool(null);
  out.afterNull = { active: SBMM.tools.active(), anyLit: !!document.querySelector(".toolbtn.active[data-tool]") };
  return out;
});
await probe("Esc from an armed tool disarms it", async () => {
  SBMM.cmd.open(false);
  SBMM.tools.setTool(null); SBMM.tools.setTool("area");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  const afterEsc = { active: SBMM.tools.active(), anyLit: !!document.querySelector(".toolbtn.active[data-tool]") };
  /* the state that used to strand the user: lit button, dead sketch engine */
  SBMM.tools.setTool("area");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  SBMM.tools.mapClick(6371450, 2128820);
  await new Promise(r => setTimeout(r, 60));
  const clickable = SBMM.draw.isDrawing();
  SBMM.tools.setTool(null);
  return { afterEsc, mapStillAcceptsClicks: clickable };
});
await probe("Esc mid-sketch cancels the sketch, not the app", async () => {
  SBMM.tools.setTool(null); SBMM.tools.setTool("area");
  SBMM.tools.mapClick(6371400, 2128800); SBMM.tools.mapClick(6371500, 2128800);
  const drawing = SBMM.draw.isDrawing();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  const out = { wasDrawing: drawing, toolKept: SBMM.tools.active(), rearmed: SBMM.draw.isDrawing(), features: SBMM.store.features.length };
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  out.secondEscLeavesTool = SBMM.tools.active();
  return out;
});

/* ------------------------------------------------------------------ */
console.log("\n-- 3. measure tools produce a result card --");
await probe("distance / area / volume / profile / spot", async () => {
  SBMM.store.clear();
  SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400, 2128800], [6371600, 2128800]] });
  SBMM.tools.rebuildFeature({ type: "area", pts: [[6371400, 2128700], [6371500, 2128700], [6371500, 2128800], [6371400, 2128800]] });
  SBMM.tools.rebuildFeature({ type: "profile", pts: [[6371350, 2128600], [6371700, 2128900]] });
  SBMM.tools.dropSpot(6371500, 2128850);
  await new Promise(r => setTimeout(r, 900));
  return SBMM.store.features.map(f => ({ t: f.type, name: (f.name || "").slice(0, 26), card: !!document.querySelector(`#resBody [data-fid="${f.id}"]`) }));
});

/* ------------------------------------------------------------------ */
console.log("\n-- 4. modify tools, including the failure cases --");
await probe("OFFSET with no selection asks for a pick", async () => {
  SBMM.store.select(null);
  SBMM.cmd.run("OFFSET 25");
  await new Promise(r => setTimeout(r, 120));
  const cursor = document.getElementById("map").classList.contains("picksel");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  return { armedPick: cursor, cursorCleared: !document.getElementById("map").classList.contains("picksel") };
});
say("  toasts", await toasts());
await probe("OFFSET a non-offsettable feature (a spot)", async () => {
  const sp = SBMM.store.features.find(f => f.type === "spot");
  SBMM.store.select(sp.id);
  const before = SBMM.store.features.length;
  SBMM.cmd.run("OFFSET 25");
  await new Promise(r => setTimeout(r, 400));
  return { created: SBMM.store.features.length - before };
});
say("  toasts", await toasts());
await probe("EXPLODE then JOIN round trip", async () => {
  const a = SBMM.store.features.find(f => f.type === "area");
  SBMM.store.select(a.id);
  SBMM.tools.opExplode(a);
  await new Promise(r => setTimeout(r, 300));
  const now = SBMM.store.features.map(f => f.type);
  return { types: now };
});
say("  toasts", await toasts());
await probe("MOVE / COPY / ROTATE / MIRROR arm a pick", async () => {
  const l = SBMM.store.features.find(f => f.type === "line");
  const out = {};
  for (const [name, fn] of [["MOVE", () => SBMM.tools.opMoveCopy(l, false)], ["COPY", () => SBMM.tools.opMoveCopy(l, true)],
                            ["ROTATE", () => SBMM.tools.opRotate(l)], ["MIRROR", () => SBMM.tools.opMirror(l)]]) {
    SBMM.store.select(l.id);
    fn();
    await new Promise(r => setTimeout(r, 80));
    out[name] = { picking: !!SBMM.draw.isPicking && SBMM.draw.isPicking(), tip: (document.getElementById("sketchTip").textContent || "").slice(0, 46) };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
  }
  return out;
});

/* ------------------------------------------------------------------ */
console.log("\n-- 5. command line: every command, and bad input --");
const cmdWalk = await page.evaluate(async () => {
  const out = { total: SBMM.cmd.commands().length, noHandler: [], dupAlias: [] };
  const seen = new Map();
  for (const c of SBMM.cmd.commands()) {
    if (typeof c.f !== "function") out.noHandler.push(c.n);
    for (const a of [c.n, ...c.a]) {
      if (seen.has(a)) out.dupAlias.push(`${a} → ${seen.get(a)} and ${c.n}`);
      else seen.set(a, c.n);
    }
  }
  return out;
});
say("command table", cmdWalk);
await probe("unknown command is reported", async () => { SBMM.cmd.run("FLARGLE"); await new Promise(r => setTimeout(r, 60)); return "ran"; });
say("  toasts", await toasts());
await probe("near-miss suggests a command", async () => { SBMM.cmd.run("OFFS"); await new Promise(r => setTimeout(r, 60)); return "ran"; });
say("  toasts", await toasts());
await probe("numeric command with junk argument", async () => {
  SBMM.store.select(SBMM.store.features.find(f => f.type === "line").id);
  SBMM.cmd.run("OFFSET banana");
  await new Promise(r => setTimeout(r, 500));
  return "ran";
});
say("  toasts", await toasts());
await probe("HELP twice leaves one overlay", async () => {
  SBMM.cmd.showHelp(); SBMM.cmd.showHelp();
  await new Promise(r => setTimeout(r, 60));
  const n = document.querySelectorAll("#cmdHelp").length;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  return { overlays: n, closedByEsc: !document.getElementById("cmdHelp") };
});
await probe("ZE with nothing drawn says so", async () => {
  const keep = SBMM.store.features.slice();
  SBMM.store.clear();
  SBMM.cmd.run("ZE");
  await new Promise(r => setTimeout(r, 60));
  keep.forEach(f => SBMM.store.add(f));
  return "ran";
});
say("  toasts", await toasts());

/* ------------------------------------------------------------------ */
console.log("\n-- 6. overlays: focus, Esc, stacking --");
await probe("help modal opens, Esc closes", async () => {
  document.getElementById("helpBtn").click();
  await new Promise(r => setTimeout(r, 60));
  const open = getComputedStyle(document.getElementById("help")).display;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  return { opened: open, closed: getComputedStyle(document.getElementById("help")).display };
});
await probe("sheet window: open, keys scoped, Esc closes", async () => {
  SBMM.sheets.open("C-106");
  await new Promise(r => setTimeout(r, 400));
  const win = document.querySelector(".shwin");
  win.focus();
  const before3d = SBMM.viewer3d.isOpen();
  win.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  const leaked = SBMM.viewer3d.isOpen() !== before3d;
  const z = +win.style.zIndex;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return { zIndex: z, globalKeyLeaked: leaked, closed: SBMM.sheets.openCount() === 0 };
});
await probe("many windows stay inside the z band", async () => {
  for (const s of SBMM.sheets.index().slice(0, 8)) SBMM.sheets.open(s.sheet);
  await new Promise(r => setTimeout(r, 300));
  const zs = [...document.querySelectorAll(".shwin")].map(e => +e.style.zIndex);
  SBMM.sheets.closeAll();
  await new Promise(r => setTimeout(r, 300));
  return { n: zs.length, min: Math.min(...zs), max: Math.max(...zs), belowModals: Math.max(...zs) < 5600 };
});
await probe("sheet picker sits above a sheet window", async () => {
  SBMM.sheets.open("C-106");
  await new Promise(r => setTimeout(r, 200));
  SBMM.sheets.list();
  await new Promise(r => setTimeout(r, 80));
  const pick = document.getElementById("sheetPicker");
  const zp = pick ? +getComputedStyle(pick).zIndex : null;
  const zw = +document.querySelector(".shwin").style.zIndex;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  const pickerGone = !document.getElementById("sheetPicker");
  SBMM.sheets.closeAll();
  return { pickerZ: zp, windowZ: zw, pickerAbove: zp > zw, escClosedPicker: pickerGone };
});
await probe("toast is above a sheet window", async () => {
  SBMM.sheets.open("C-106");
  await new Promise(r => setTimeout(r, 200));
  toast("audit probe");
  await new Promise(r => setTimeout(r, 60));
  const zt = +getComputedStyle(document.getElementById("toast")).zIndex;
  const zw = +document.querySelector(".shwin").style.zIndex;
  SBMM.sheets.closeAll();
  return { toastZ: zt, windowZ: zw, visible: zt > zw };
});
await toasts();

/* ------------------------------------------------------------------ */
console.log("\n-- 7. dataset import: pathological CSV --");
const CSVS = {
  "quoted commas + BOM + CRLF + blank lines":
    "﻿ID,EASTING,NORTHING,NOTE\r\n\r\nA-1,6371500,2128900,\"waste, mixed\"\r\nA-2,6371600,2128950,\"he said \"\"ok\"\"\"\r\n\r\n",
  "duplicate IDs": "ID,EASTING,NORTHING\nA-1,6371500,2128900\nA-1,6371600,2128950\nA-1,6371700,2129000\n",
  "non-numeric coords in some rows": "ID,EASTING,NORTHING\nA-1,6371500,2128900\nA-2,n/a,2128950\nA-3,,\nA-4,6371700,2129000\n",
  "no numeric coords at all": "ID,NAME,NOTE\nA-1,alpha,x\nA-2,beta,y\n",
  "header only": "ID,EASTING,NORTHING\n",
  "one column": "ID\nA-1\nA-2\n",
  "ragged rows": "ID,EASTING,NORTHING,NOTE\nA-1,6371500,2128900\nA-2,6371600,2128950,ok,extra\n"
};
for (const [name, text] of Object.entries(CSVS)) {
  const r = await probe("CSV: " + name, async (t) => {
    const before = SBMM.datasets.list().length;
    SBMM.datasets.importCSV(t, "probe.csv");
    await new Promise(r2 => setTimeout(r2, 200));
    const dlg = document.getElementById("dsDialog");
    const out = { dialog: !!dlg, preview: dlg ? (document.getElementById("dsPreview").textContent || "").replace(/\s+/g, " ").trim().slice(0, 130) : null };
    if (dlg) {
      document.getElementById("dsGo").click();
      await new Promise(r2 => setTimeout(r2, 250));
      out.stillOpen = !!document.getElementById("dsDialog");
      const after = SBMM.datasets.list();
      out.added = after.length - before;
      if (out.added > 0) { out.points = after[after.length - 1].points.length; SBMM.datasets.remove(after[after.length - 1]); }
      const d2 = document.getElementById("dsDialog"); if (d2) d2.remove();
    }
    return out;
  }, text);
  say("  toasts", await toasts());
}
await probe("dataset dialog closes on Esc", async () => {
  SBMM.datasets.importCSV("ID,EASTING,NORTHING\nA-1,6371500,2128900\n", "probe.csv");
  await new Promise(r => setTimeout(r, 150));
  const open = !!document.getElementById("dsDialog");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  return { opened: open, closed: !document.getElementById("dsDialog") };
});

/* ------------------------------------------------------------------ */
console.log("\n-- 8. sessions, undo, exports --");
await probe("save → clear → load round trip", async () => {
  const before = SBMM.store.features.length;
  const json = SBMM.store.serialize ? JSON.stringify(SBMM.store.serialize()) : null;
  if (!json) return "no serialize()";
  SBMM.store.clear();
  const cleared = SBMM.store.features.length;
  SBMM.store.restore(JSON.parse(json));
  await new Promise(r => setTimeout(r, 300));
  return { before, cleared, after: SBMM.store.features.length };
});
await probe("undo depth", async () => {
  const start = SBMM.store.features.length;
  for (let i = 0; i < 12; i++) SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400 + i, 2128800], [6371500 + i, 2128800]] });
  await new Promise(r => setTimeout(r, 300));
  const peak = SBMM.store.features.length;
  let n = 0;
  for (let i = 0; i < 30; i++) { if (SBMM.undo.pop() === false) break; n++; }
  await new Promise(r => setTimeout(r, 200));
  return { start, peak, undosAccepted: n, end: SBMM.store.features.length };
});
say("  toasts", await toasts());
await probe("undo with an empty stack says so", async () => { SBMM.undo.pop(); await new Promise(r => setTimeout(r, 60)); return "ran"; });
say("  toasts", await toasts());
await probe("GeoJSON + DXF export shape", () => {
  SBMM.store.clear();
  SBMM.tools.rebuildFeature({ type: "area", pts: [[6371400, 2128700], [6371500, 2128700], [6371500, 2128800]] });
  const gj = SBMM.io.collection("sp");
  const dxf = SBMM.dxf.buildDXF ? SBMM.dxf.buildDXF() : null;
  return { gjType: gj.type, gjFeatures: gj.features.length, crs: !!gj.crs, dxfBytes: dxf ? dxf.length : "n/a" };
});

/* ------------------------------------------------------------------ */
console.log("\n-- 9. layers, areas, feature manager --");
await probe("Areas nav", () => {
  const e = SBMM.layersUI.extents();
  const out = {};
  for (const a of ["mine", "resid", "site"]) { SBMM.layersUI.flyTo(a); out[a] = !!e[a]; }
  out.buttonsLit = [...document.querySelectorAll("#areaNav .areabtn")].filter(b => b.classList.contains("on")).length;
  return out;
});
await probe("every layer row toggles both ways", async () => {
  const rows = [...document.querySelectorAll("#layers .lyr input[type=checkbox]")];
  const bad = [];
  for (const cb of rows) {
    const lbl = cb.closest(".lyr").querySelector(".lbl").textContent.trim();
    const was = cb.checked;
    cb.checked = !was; cb.onchange();
    await new Promise(r => setTimeout(r, 30));
    cb.checked = was; cb.onchange();
    await new Promise(r => setTimeout(r, 30));
    if (cb.checked !== was) bad.push(lbl);
  }
  return { rows: rows.length, misbehaving: bad };
});
await probe("feature manager: folder, lock, eye", async () => {
  SBMM.store.clear();
  const f = SBMM.tools.rebuildFeature({ type: "area", pts: [[6371400, 2128700], [6371500, 2128700], [6371500, 2128800]] });
  await new Promise(r => setTimeout(r, 300));
  const g = SBMM.store.features[0];
  SBMM.store.setGroup(g, "Audit/Nested");
  SBMM.features.render();
  const folders = [...document.querySelectorAll("#featureTree .ftfolder, #featureTree .ftgroup")].map(e => e.textContent.trim().slice(0, 24));
  SBMM.store.setVisible(g, false);
  const hidden = { visible: g.visible, onMap: !!(g.layer && SBMM.map.hasLayer(g.layer)) };
  SBMM.store.setVisible(g, true);
  SBMM.store.setLocked(g, true);
  const empty = { tree: (document.getElementById("featureTree").textContent || "").trim().slice(0, 40),
                  props: (document.getElementById("propsBody").textContent || "").trim().slice(0, 40) };
  return { folders, hidden, locked: g.locked === true, empty };
});

/* ------------------------------------------------------------------ */
console.log("\n-- 10. 3D --");
await probe("3D opens, presets, split, nav modes", async () => {
  SBMM.viewer3d.toggle();
  for (let i = 0; i < 400 && !SBMM.viewer3d.isOpen(); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 2500));
  const out = { open: SBMM.viewer3d.isOpen(), nav: SBMM.viewer3d.navMode() };
  const presets = document.querySelectorAll("#v3dNav .navbtn").length;
  out.presets = presets;
  SBMM.viewer3d.toggleFly(); out.fly = SBMM.viewer3d.navMode();
  SBMM.viewer3d.toggleFly(); out.back = SBMM.viewer3d.navMode();
  return out;
});
await probe("3D sheet drape build + dispose", async () => {
  const before = SBMM.viewer3d.stats().gpu;
  SBMM.viewer3d.sheetDrape("C-106", true);
  await new Promise(r => setTimeout(r, 2500));
  const on = SBMM.viewer3d.stats();
  SBMM.viewer3d.sheetDrape("C-106", false);
  await new Promise(r => setTimeout(r, 800));
  const off = SBMM.viewer3d.stats();
  return { before, withDrape: { n: on.sheetDrapes.length, verts: on.sheetDrapeVerts, gpu: on.gpu }, after: { n: off.sheetDrapes.length, gpu: off.gpu } };
});

/* ------------------------------------------------------------------ */
/* v17 §5 — the TOUCH pass.
   Every hover-only control in the app, and how a finger reaches it. The desktop
   run above is unchanged; this section turns `body.touch` on by hand (the
   override, exactly as the Help switch does) so the audit can say what a tablet
   user actually sees, and turns it off again. A control that prints
   `reach: "hover only"` here is the bug. */
console.log("\n-- 11. touch: every hover-only control, and its tap path --");
await probe("profile + override", () => {
  const before = SBMM.touch.profile();
  SBMM.touch.override("on");
  const on = { profile: SBMM.touch.profile(), body: document.body.classList.contains("touch") };
  return { before, on };
});
await probe("hit targets under body.touch", () => {
  /* measure the first VISIBLE match, not the first match: several of these
     classes have a hidden twin (a collapsed dock's buttons, a sheet window that
     is not open), and a hidden element measures 0 and reads as a failure. */
  const H = sel => {
    const list = document.querySelectorAll(sel);
    for (const e of list) {
      const r = e.getBoundingClientRect();
      if (r.height > 0) return Math.round(r.height);
    }
    return list.length ? 0 : null;
  };
  /* the Done bar only exists while a sketch is open, so show it to measure it */
  SBMM.touch.doneBar.show({ label: "audit", done() {}, cancel() {} });
  const out = {
    toolbtn: H("#topbar .toolbtn"), minib: H(".minib"), dtab: H(".dtab"),
    railbtn: H(".railbtn"), layerRow: H("#layers .lyr"),
    navbtn: H("#v3dNav .navbtn"), doneBar: H("#touchDone .tdb")
  };
  SBMM.touch.doneBar.hide();
  return out;
});
await probe("hover-only controls and how touch reaches them", () => {
  const rows = [];
  const add = (what, reach, ok) => rows.push({ what, reach, ok });
  /* 1. the layer tree's row toolbar (v16) — CSS :hover on the desktop */
  const row = document.querySelector("#layers .lyr");
  const more = row && row.querySelector(".ltmore");
  add("layer row toolbar (opacity/zoom/solo/info)",
      more && getComputedStyle(more).display !== "none" ? "the row's ⋯ button" : "hover only",
      !!(more && getComputedStyle(more).display !== "none"));
  /* 2. every `title` tooltip — a long press shows it as a chip */
  add("button tooltips (they carry the shortcut)",
      typeof SBMM.touch.tip === "function" ? "long-press the button" : "hover only",
      typeof SBMM.touch.tip === "function");
  /* 3. the map context menu — right-click on the desktop */
  add("map / feature / vertex context menu",
      typeof SBMM.touch.fireContextMenu === "function" ? "long-press" : "right-click only",
      typeof SBMM.touch.fireContextMenu === "function");
  /* 4. the results card's hover highlight — informational, no action behind it */
  add("results-card hover highlight", "decoration only — no action behind it", true);
  /* 5. the 3D hover highlight — the identify card is the action */
  add("3D hover highlight / identify",
      "long-press (and a pen hover, which is a real hover)", true);
  /* 6. the osnap glyphs — they follow the crosshair, which follows the finger */
  add("object snap glyphs while sketching",
      "the press-hold loupe drives them (map.fire mousemove)", true);
  /* 7. the command bar (backtick / Ctrl+K / slash) */
  add("command bar",
      document.getElementById("cmdTopBtn") ? "the top bar's command button" : "keyboard only",
      !!document.getElementById("cmdTopBtn"));
  /* 8. Enter / Backspace / Esc while sketching */
  add("finish / undo vertex / cancel a sketch",
      typeof SBMM.touch.doneBar === "object" ? "the Done bar" : "keyboard only", true);
  /* 9. the field capabilities outside field mode */
  add("Position / Photo / Note / Samples nearby",
      document.getElementById("fieldMenuBtn") ? "the top bar's Field ▾ menu" : "field mode only",
      !!document.getElementById("fieldMenuBtn"));
  /* 10. the sheet window's own chrome */
  add("sheet window move / resize / maximise",
      "44-px title bar and grip, plus a maximise button in every profile", true);
  return { rows, hoverOnly: rows.filter(r => !r.ok).map(r => r.what) };
});
await probe("touch furniture exists and is in its band", () => {
  const z = id => { const e = document.getElementById(id); return e ? +getComputedStyle(e).zIndex : null; };
  SBMM.touch.loupe.show(() => {}, 200, 200);
  SBMM.touch.doneBar.show({ label: "audit", done() {}, cancel() {} });
  SBMM.touch.tip(document.getElementById("helpBtn"));
  const out = { loupe: z("touchLoupe"), doneBar: z("touchDone"), tip: z("touchTip"),
                sheetWin: 4000, picker: 5200, modal: 5600, toast: 7000 };
  SBMM.touch.loupe.hide(); SBMM.touch.doneBar.hide(); SBMM.touch.hideTip();
  out.ordered = out.loupe > out.sheetWin && out.loupe < out.picker
             && out.doneBar > out.sheetWin && out.doneBar < out.picker;
  return out;
});
await probe("redline: the palette, the swatches and the eraser", () => {
  SBMM.mode.set("redline");
  const pal = document.getElementById("inkPal");
  const out = { mode: SBMM.mode.current(), palette: !!pal && !pal.hidden,
                swatches: pal ? pal.querySelectorAll(".inksw").length : 0,
                colour: SBMM.redline.colour() };
  SBMM.redline.eraser(true);
  out.eraser = SBMM.redline.eraser();
  SBMM.redline.eraser(false);
  SBMM.mode.navigate();
  out.paletteAfter = !!pal && !pal.hidden;
  return out;
});
await probe("redline toasts", async () => {
  SBMM.mode.set("redline");
  await new Promise(r => setTimeout(r, 200));
  SBMM.mode.navigate();
  return "armed and disarmed";
});
say("  toasts", await toasts());
await probe("the offline copy over file:// says why", async () => {
  const s = await SBMM.touch.offline.status();
  return { possible: SBMM.touch.offline.possible(), why: SBMM.touch.offline.why(),
           status: s, line: (document.getElementById("offlineStatus") || {}).textContent };
});
await probe("device diagnostics", () => { SBMM.touch.paintDiag();
  return { line: (document.getElementById("touchDiag") || {}).textContent,
           record: SBMM.touch.diagnostics() }; });
await probe("back to the desktop profile", () => {
  SBMM.touch.override("auto");
  return { profile: SBMM.touch.profile(), body: document.body.classList.contains("touch") };
});

console.log("\npage errors:", errs.length ? errs.slice(0, 10) : "none");
await browser.close();
