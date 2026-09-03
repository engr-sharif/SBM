import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium (npx playwright install chromium)
const target = process.argv[2];
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(120000);
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
const fail = m => { console.log("FAIL:", m); };

/* helper: SP coords -> page px */
async function toPage(x, y) {
  return await page.evaluate(([x, y]) => {
    const p = SBMM.map.latLngToContainerPoint([y, x]);
    const r = document.getElementById("map").getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [x, y]);
}

/* ---- 1. osnap: line, then snap a new sketch to its endpoint ---- */
await page.evaluate(() => {
  SBMM.store.clear();
  SBMM.map.setView([2128850, 6371500], 1);
  SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400, 2128800], [6371450, 2128840]], name: "SnapTarget" });
  SBMM.snap.buildStatic(); SBMM.snap.reindexDrawn(); SBMM.snap.setEnabled(true);
});
await page.waitForTimeout(600);
await page.evaluate(() => SBMM.tools.setTool("distance"));
const near = await toPage(6371450 + 1.5, 2128840 - 1.2);
await page.mouse.move(near.x, near.y);
await page.waitForTimeout(150);
const hov = await page.evaluate(() => SBMM.draw.resolve ? null : null);
await page.mouse.click(near.x, near.y);
await page.waitForTimeout(150);
const snapRes = await page.evaluate(() => {
  const w = SBMM._dbgWork ? SBMM._dbgWork() : null;
  return null;
});
/* read the sketch vertex through a second click + finish */
const p2 = await toPage(6371560, 2128900);
await page.mouse.click(p2.x, p2.y);
await page.waitForTimeout(100);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const snapped = await page.evaluate(() => {
  const f = SBMM.store.features.find(f => f.name && f.name.startsWith("Line"));
  return f ? f.pts[0] : null;
});
console.log("snapped first vertex:", snapped, "target:", [6371450, 2128840]);
if (!snapped || Math.abs(snapped[0]-6371450) > 0.001 || Math.abs(snapped[1]-2128840) > 0.001) fail("osnap did not land on the endpoint");
else console.log("osnap: OK");

/* ---- 2. typed @100<0 ---- */
await page.evaluate(() => { SBMM.store.clear(); SBMM.tools.setTool(null); SBMM.tools.setTool("distance"); });
const s0 = await toPage(6371430, 2128810);
await page.mouse.move(s0.x, s0.y);
await page.mouse.click(s0.x, s0.y);
await page.waitForTimeout(120);
await page.keyboard.type("@100<0");
await page.waitForTimeout(120);
const hint = await page.textContent("#dynHint");
await page.keyboard.press("Enter");
await page.waitForTimeout(120);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const typed = await page.evaluate(() => {
  const f = SBMM.store.features[SBMM.store.features.length-1];
  return f ? { pts: f.pts, len: f.props.length_ft } : null;
});
console.log("typed hint:", JSON.stringify(hint), "| result:", JSON.stringify(typed));
if (!typed || Math.abs(typed.len - 100) > 0.02) fail("typed @100<0 did not make a 100 ft segment");
else console.log("typed input: OK");

/* ---- 3. command line ---- */
const cmds = await page.evaluate(() => ({ n: SBMM.cmd.commands().length, pl: !!SBMM.cmd.find("PL"), o: !!SBMM.cmd.find("O") }));
console.log("commands:", cmds);
await page.evaluate(() => { SBMM.store.clear(); SBMM.cmd.run("VOL"); });
const volArmed = await page.evaluate(() => SBMM.tools.active());
console.log("VOL armed tool:", volArmed);

/* ---- 4. DIM ---- */
await page.evaluate(() => { SBMM.tools.setTool(null); SBMM.store.clear(); SBMM.tools.opDim(); });
const d1 = await toPage(6371420, 2128800), d2 = await toPage(6371520, 2128800);
await page.mouse.move(d1.x, d1.y); await page.mouse.click(d1.x, d1.y);
await page.waitForTimeout(100);
await page.mouse.move(d2.x, d2.y); await page.mouse.click(d2.x, d2.y);
await page.waitForTimeout(400);
const dim = await page.evaluate(() => {
  const f = SBMM.store.features.find(f => f.type === "dim");
  return f ? { len: f.props.length_ft, kids: f.layer.getLayers().length, pts: f.pts } : null;
});
console.log("dim:", JSON.stringify(dim));

/* ---- 5. OFFSET via command line ---- */
await page.evaluate(() => {
  SBMM.store.clear();
  const f = SBMM.tools.rebuildFeature({ type: "area", pts: [[6371420,2128790],[6371560,2128790],[6371560,2128890],[6371420,2128890]], name: "Box" });
  SBMM.store.select(f.id);
  SBMM.cmd.run("OFFSET 25");
});
await page.waitForTimeout(200);
const inside = await toPage(6371490, 2128840);
await page.mouse.move(inside.x, inside.y);
await page.waitForTimeout(120);
await page.mouse.click(inside.x, inside.y);
await page.waitForTimeout(600);
const off = await page.evaluate(() => {
  const f = SBMM.store.features.find(f => /offset/.test(f.name||""));
  return f ? { name: f.name, area: f.props.area_ft2, pts: f.pts } : null;
});
console.log("offset:", off && { name: off.name, area: off.area, n: off.pts.length });
/* 140x100 box offset 25 inward -> 90x50 = 4500 */
if (!off || Math.abs(off.area - 4500) > 5) fail("offset area wrong (expected 4500 ft²)");
else console.log("offset: OK");

/* ---- 6. DXF round trip ---- */
const rt = await page.evaluate(() => {
  SBMM.store.clear();
  SBMM.tools.rebuildFeature({ type: "line", pts: [[6371400.5,2128800.25],[6371500.75,2128860.5],[6371520,2128900]], name: "L1" });
  SBMM.tools.rebuildFeature({ type: "area", pts: [[6371600,2128800],[6371700,2128800],[6371700,2128900]], name: "A1" });
  SBMM.tools.rebuildFeature({ type: "spot", pts: [[6371650,2128950]] });
  SBMM.tools.mkDim([[6371300,2128700],[6371400,2128700]]);
  SBMM.tools.mkText([[6371350,2128760]], "Stockpile A");
  const before = SBMM.store.features.map(f => ({ t: f.type, pts: f.pts.map(p=>p.slice()) }));
  const txt = SBMM.dxf.buildDXF();
  SBMM.store.clear();
  const n = SBMM.dxf.importText(txt, "roundtrip.dxf");
  const after = SBMM.store.features.map(f => ({ t: f.type, pts: f.pts.map(p=>p.slice()) }));
  return { bytes: txt.length, n, before, after, head: txt.slice(0, 120) };
});
console.log("dxf bytes:", rt.bytes, "| entities imported:", rt.n);
console.log("before:", JSON.stringify(rt.before.map(b=>b.t)));
console.log("after :", JSON.stringify(rt.after.map(b=>b.t)));
/* match line + polygon geometry within 0.01 ft */
function findMatch(src, list) {
  for (const c of list) {
    if (c.pts.length !== src.pts.length) continue;
    if (src.pts.every((p,i) => Math.abs(p[0]-c.pts[i][0])<0.01 && Math.abs(p[1]-c.pts[i][1])<0.01)) return c;
  }
  return null;
}
for (const b of rt.before) {
  if (b.t === "dim" || b.t === "text") continue;
  const m = findMatch(b, rt.after);
  console.log("  roundtrip", b.t, m ? "matched" : "MISSING");
  if (!m) fail("dxf roundtrip lost a " + b.t);
}
const crs = await page.evaluate(() => {
  try { SBMM.dxf.importText("0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n-122.66\n20\n39.005\n30\n0\n11\n-122.65\n21\n39.006\n31\n0\n0\nENDSEC\n0\nEOF\n","ll.dxf"); return "ACCEPTED (bad)"; }
  catch(e) { return "refused: " + e.message; }
});
console.log("latlong dxf:", crs);
console.log("errors:", errors.slice(0,8));
await browser.close();
