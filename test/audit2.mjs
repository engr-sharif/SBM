/* Second walkthrough: the paths audit.mjs does not reach — sheet-viewer entry
   points, Properties edits, 3D split / draw-in-3D, the report page, drag-drop
   import, and the tooltip/label consistency sweep. Prints, does not assert.   */
import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium (npx playwright install chromium)

const target = process.argv[2];
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(180000);
const errs = [];
page.on("pageerror", e => errs.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
page.on("dialog", d => d.accept());

console.log(`\n=== audit2: ${process.argv[3] || target} ===`);
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 180000 });
await page.evaluate(() => SBMM.chmReady);
const say = (k, v) => console.log(`  ${String(k).padEnd(44)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
const probe = async (k, fn, arg) => {
  let v; try { v = await page.evaluate(fn, arg); } catch (e) { v = "THREW " + e.message.split("\n")[0].slice(0, 150); }
  say(k, v); return v;
};

console.log("\n-- sheet viewer: all four entry points --");
await probe("1. SHEETS command, bare and with a number", async () => {
  SBMM.cmd.run("SHEETS");
  await new Promise(r => setTimeout(r, 120));
  const picker = !!document.getElementById("sheetPicker");
  SBMM.sheets.closePicker();
  SBMM.cmd.run("SHEETS C-106");
  await new Promise(r => setTimeout(r, 300));
  const one = SBMM.sheets.openCount();
  SBMM.cmd.run("SHEETS c106");              // sloppy spelling
  await new Promise(r => setTimeout(r, 200));
  const same = SBMM.sheets.openCount();
  SBMM.cmd.run("SHEETS Q-999");             // nonsense
  await new Promise(r => setTimeout(r, 120));
  const after = SBMM.sheets.openCount();
  SBMM.sheets.closeAll();
  return { pickerOpened: picker, opened: one, sloppySpellingReused: same === 1, badSheetOpenedNothing: after === 1 };
});
await probe("2. layers row ⤢ button", async () => {
  const btn = [...document.querySelectorAll("#designLayers .minib")].find(b => b.textContent.includes("⤢"));
  if (!btn) return "no ⤢ button on a design row";
  btn.click();
  await new Promise(r => setTimeout(r, 350));
  const n = SBMM.sheets.openCount();
  SBMM.sheets.closeAll();
  return { opened: n };
});
await probe("3. locate flies the map and pulses", async () => {
  SBMM.sheets.open("C-106");
  await new Promise(r => setTimeout(r, 300));
  const before = SBMM.map.getCenter();
  document.querySelector(".shwin .shloc").click();
  await new Promise(r => setTimeout(r, 1200));
  const after = SBMM.map.getCenter();
  const pulse = !!document.querySelector(".sheetpulse, path.sheetpulse");
  SBMM.sheets.closeAll();
  return { moved: Math.hypot(after.lng - before.lng, after.lat - before.lat) > 1, pulse };
});
await probe("4. an unregistered sheet disables 'locate'", async () => {
  const un = SBMM.sheets.index().find(s => !s.registered);
  SBMM.sheets.open(un.sheet);
  await new Promise(r => setTimeout(r, 300));
  const btn = document.querySelector(".shwin .shloc");
  const pill = !!document.querySelector(".shwin .dimpill");
  const dis = btn.disabled;
  SBMM.sheets.closeAll();
  return { sheet: un.sheet, locateDisabled: dis, badged: pill };
});
await probe("prev/next flips in place and refits", async () => {
  SBMM.sheets.open("C-106");
  await new Promise(r => setTimeout(r, 400));
  const el = document.querySelector(".shwin");
  const box = { l: el.style.left, t: el.style.top, w: el.style.width };
  el.querySelector(".shnext").click();
  await new Promise(r => setTimeout(r, 600));
  const now = el.dataset.sheet;
  const same = el.style.left === box.l && el.style.top === box.t && el.style.width === box.w;
  SBMM.sheets.closeAll();
  return { movedTo: now, windowStayedPut: same };
});

console.log("\n-- properties panel edits --");
await probe("rename / recolour / group / coordinate edit", async () => {
  SBMM.store.clear();
  SBMM.tools.rebuildFeature({ type: "area", pts: [[6371400, 2128700], [6371520, 2128700], [6371520, 2128820], [6371400, 2128820]] });
  await new Promise(r => setTimeout(r, 400));
  const f = SBMM.store.features[0];
  SBMM.store.select(f.id);
  await new Promise(r => setTimeout(r, 200));
  const out = { sections: [...document.querySelectorAll("#propsBody .pgroup h4")].map(h => h.textContent.trim()) };
  const nm = document.getElementById("pName");
  nm.value = "Audit polygon"; nm.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  out.renamed = f.name;
  out.cardTitle = (document.querySelector(`#resBody [data-fid="${f.id}"] .rname`) || {}).textContent;
  const col = document.getElementById("pColor");
  if (col) { col.value = "#ff0000"; col.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(r => setTimeout(r, 120)); out.colour = f.style && f.style.color; }
  out.areaShown = (document.querySelector("#propsBody") || {}).textContent.includes("ft²") || (document.querySelector("#propsBody") || {}).textContent.includes("ac");
  return out;
});

console.log("\n-- 3D: split mode, draw-in-3D, presets --");
await probe("open 3D and settle", async () => {
  SBMM.viewer3d.toggle();
  for (let i = 0; i < 500 && !SBMM.viewer3d.isOpen(); i++) await new Promise(r => setTimeout(r, 50));
  for (let i = 0; i < 200 && !SBMM.viewer3d.navMode(); i++) await new Promise(r => setTimeout(r, 100));
  return { open: SBMM.viewer3d.isOpen(), nav: SBMM.viewer3d.navMode(), status: document.getElementById("v3dStatus").textContent };
});
await probe("presets cycle without error", async () => {
  const out = {};
  for (const b of document.querySelectorAll("#v3dNav .navbtn")) {
    const p = b.dataset.p || b.textContent.trim();
    b.click(); await new Promise(r => setTimeout(r, 250));
    out[p] = SBMM.viewer3d.stats().cameraZ;
  }
  return out;
});
await probe("split mode on/off keeps both views alive", async () => {
  document.getElementById("v3dSplit").click();
  await new Promise(r => setTimeout(r, 800));
  const on = { cls: document.body.classList.contains("v3dsplit"), mapW: document.getElementById("map").clientWidth };
  document.getElementById("v3dSplit").click();
  await new Promise(r => setTimeout(r, 800));
  const off = { cls: document.body.classList.contains("v3dsplit"), mapW: document.getElementById("map").clientWidth };
  return { on, off };
});
await probe("draw-in-3D: tool armed while 3D is open", async () => {
  SBMM.tools.setTool(null); SBMM.tools.setTool("distance");
  await new Promise(r => setTimeout(r, 120));
  const armed = SBMM.tools.active();
  SBMM.tools.mapClick(6371400, 2128800);
  SBMM.tools.mapClick(6371600, 2128900);
  await new Promise(r => setTimeout(r, 300));
  const sketchIn3d = !!SBMM.viewer3d.stats().sceneObjects;
  SBMM.tools.setTool(null); SBMM.tools.setTool(null);
  return { armed, drawing: SBMM.draw.isDrawing(), sceneObjects: SBMM.viewer3d.stats().sceneObjects, sketchIn3d };
});
await probe("3D close returns the app to 2D", async () => {
  SBMM.viewer3d.toggle();
  await new Promise(r => setTimeout(r, 600));
  return { open: SBMM.viewer3d.isOpen(), v3don: document.body.classList.contains("v3don"),
           btn: document.getElementById("view3dBtn").classList.contains("active") };
});

console.log("\n-- report page after the new modules --");
await probe("report opens for a measured feature", async () => {
  SBMM.store.clear();
  SBMM.tools.rebuildFeature({ type: "volume", pts: [[6371400, 2128700], [6371520, 2128700], [6371520, 2128820], [6371400, 2128820]] });
  const f = SBMM.store.features[0];
  for (let i = 0; i < 200 && f.props.fill_yd3 == null; i++) await new Promise(r => setTimeout(r, 100));
  SBMM.store.select(f.id);
  const html = SBMM.report.open();
  await new Promise(r => setTimeout(r, 400));
  const box = document.getElementById("reportModal");
  const out = {
    modal: !!box,
    zIndex: box ? +getComputedStyle(box).zIndex : null,
    hasFigure: /data:image\/png/.test(html),
    hasCRS: /EPSG:6418/.test(html),
    hasPlanningNote: /planning/i.test(html),
    author: /Mohammad Sharif/.test(html),
    kB: Math.round(html.length / 1024)
  };
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  out.escClosed = !document.getElementById("reportModal");
  return out;
});
await probe("report with nothing selected explains itself", async () => {
  SBMM.store.select(null);
  window.__t = []; const o = window.toast; window.toast = m => { window.__t.push(String(m)); return o(m); };
  SBMM.report.open();
  await new Promise(r => setTimeout(r, 200));
  window.toast = o;
  return { modal: !!document.getElementById("reportModal"), said: window.__t };
});

console.log("\n-- UI text consistency sweep --");
await probe("buttons without a tooltip", () => {
  const bad = [];
  for (const b of document.querySelectorAll("#topbar button, .panetools button, #v3dNav button, .v3dbar button")) {
    const label = (b.textContent || "").trim();
    if (!b.title && !b.getAttribute("aria-label")) bad.push((b.id || label || b.className).slice(0, 28));
  }
  return bad;
});
await probe("layer rows whose label has no unit or source", () => {
  return [...document.querySelectorAll("#layers .lyr .lbl")].map(e => e.textContent.trim())
    .filter(t => /\d/.test(t) && !/\(|ft|in|%/.test(t));
});
await probe("sentence-case check on visible labels", () => {
  const odd = [];
  for (const e of document.querySelectorAll("#layers .lsech span:first-child, .dockrail button, .panetools button")) {
    const t = (e.textContent || "").trim();
    if (!t || t.length < 3) continue;
    /* flag ALL CAPS words that are not deliberate command names or acronyms */
    if (/^[A-Z][a-z]+ [A-Z][a-z]+/.test(t)) odd.push(t.slice(0, 34));
  }
  return odd;
});

console.log("\npage errors:", errs.length ? errs.slice(0, 10) : "none");
await browser.close();
