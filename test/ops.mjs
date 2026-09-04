import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(60000);
const errors=[]; page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type()==="error") errors.push(m.text()); });
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + process.argv[2]);
await page.waitForSelector("#loading", { state: "hidden", timeout: 90000 });
await page.evaluate(() => { SBMM.store.clear(); SBMM.map.setView([2128850, 6371500], 1); });
await page.waitForTimeout(700);
async function C(x, y, opts) {
  const p = await page.evaluate(([x,y]) => { const c = SBMM.map.latLngToContainerPoint([y,x]); const r = document.getElementById("map").getBoundingClientRect(); return {x:r.left+c.x, y:r.top+c.y}; }, [x,y]);
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(60);
  await page.mouse.click(p.x, p.y, opts); await page.waitForTimeout(140);
}
const seed = async () => page.evaluate(() => {
  SBMM.store.clear();
  const f = SBMM.tools.rebuildFeature({ type:"area", pts:[[6371420,2128790],[6371520,2128790],[6371520,2128860],[6371420,2128860]], name:"Box" });
  SBMM.store.select(f.id); return f.id;
});

/* MIRROR about a vertical axis at x=6371550 */
await seed();
await page.evaluate(() => SBMM.cmd.run("MIRROR"));
await C(6371550, 2128790); await C(6371550, 2128870);
const mir = await page.evaluate(() => { const f = SBMM.store.features.find(f=>/mirror/.test(f.name||"")); return f && f.pts; });
console.log("MIRROR ->", JSON.stringify(mir));

/* ROTATE 90 deg typed about (6371420,2128790) */
await seed();
await page.evaluate(() => SBMM.cmd.run("RO"));
await C(6371420, 2128790);
await page.keyboard.type("90"); await page.waitForTimeout(120);
await page.keyboard.press("Enter"); await page.waitForTimeout(400);
const rot = await page.evaluate(() => { const f = SBMM.store.features.find(f=>f.name==="Box"); return f && f.pts.map(p=>[+p[0].toFixed(2),+p[1].toFixed(2)]); });
console.log("ROTATE 90 ->", JSON.stringify(rot));

/* MOVE via typed @50,25 */
await seed();
await page.evaluate(() => SBMM.cmd.run("M"));
await C(6371420, 2128790);
await page.keyboard.type("@50,25"); await page.waitForTimeout(120);
await page.keyboard.press("Enter"); await page.waitForTimeout(400);
const mv = await page.evaluate(() => { const f = SBMM.store.features.find(f=>f.name==="Box"); return f && f.pts[0]; });
console.log("MOVE @50,25 ->", JSON.stringify(mv), "(expect 6371470, 2128815)");

/* COPY */
await seed();
await page.evaluate(() => SBMM.cmd.run("CO"));
await C(6371420, 2128790);
await page.keyboard.type("@0,60"); await page.keyboard.press("Enter"); await page.waitForTimeout(400);
const cp = await page.evaluate(() => ({ n: SBMM.store.features.length, names: SBMM.store.features.map(f=>f.name) }));
console.log("COPY ->", JSON.stringify(cp));

/* EXPLODE */
await seed();
await page.evaluate(() => SBMM.cmd.run("X"));
await page.waitForTimeout(300);
const ex = await page.evaluate(() => SBMM.store.features.map(f=>({t:f.type,n:f.name,v:f.pts.length})));
console.log("EXPLODE ->", JSON.stringify(ex));

/* JOIN */
await page.evaluate(() => {
  SBMM.store.clear();
  const a = SBMM.tools.rebuildFeature({ type:"line", pts:[[6371420,2128800],[6371470,2128800]], name:"A" });
  SBMM.tools.rebuildFeature({ type:"line", pts:[[6371470,2128800],[6371470,2128850]], name:"B" });
  SBMM.store.select(a.id);
  SBMM.cmd.run("JOIN");
});
await page.waitForTimeout(200);
await C(6371470, 2128830);
const jn = await page.evaluate(() => SBMM.store.features.map(f=>({t:f.type,n:f.name,v:f.pts.length,len:f.props.length_ft})));
console.log("JOIN ->", JSON.stringify(jn));

/* OFFSET with ask() — no inline distance */
await seed();
await page.evaluate(() => SBMM.cmd.run("OFFSET"));
await page.waitForTimeout(200);
const askShown = await page.evaluate(() => ({ open: document.body.classList.contains("cmdopen"), prompt: document.getElementById("cmdPrompt").textContent }));
await page.keyboard.type("10"); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
await C(6371470, 2128825);
const off2 = await page.evaluate(() => { const f = SBMM.store.features.find(f=>/offset/.test(f.name||"")); return f && { n:f.name, a:f.props.area_ft2 }; });
console.log("OFFSET ask ->", JSON.stringify(askShown), JSON.stringify(off2), "(expect 80x50=4000)");

/* self-intersection refusal: offset a thin box by more than half its width */
await page.evaluate(() => {
  SBMM.store.clear();
  const f = SBMM.tools.rebuildFeature({ type:"area", pts:[[6371450,2128840],[6371550,2128840],[6371550,2128860],[6371450,2128860]], name:"Thin" });
  SBMM.store.select(f.id); SBMM.cmd.run("OFFSET 40");
});
await page.waitForTimeout(200);
await C(6371500, 2128850);
const bad = await page.evaluate(() => ({ n: SBMM.store.features.length, names: SBMM.store.features.map(f=>f.name) }));
console.log("OFFSET too far ->", JSON.stringify(bad), "(expect only Thin)");

/* ZE / ZW */
await page.evaluate(() => { SBMM.cmd.run("ZE"); });
await page.waitForTimeout(400);
console.log("ZE zoom:", await page.evaluate(() => SBMM.map.getZoom()));

/* polar + ortho */
const pol = await page.evaluate(() => { SBMM.draw.setPolar(true); return SBMM.draw.isPolar(); });
console.log("polar:", pol);
await page.evaluate(() => { SBMM.store.clear(); SBMM.map.setView([2128850, 6371500], 1); });
await page.waitForTimeout(700);
await page.evaluate(() => { SBMM.tools.setTool(null); SBMM.snap.setEnabled(false); SBMM.tools.setTool("distance"); });
await C(6371450, 2128800);
await C(6371520, 2128806);   /* 4.9 deg -> polar snaps to 0 */
await page.keyboard.press("Enter"); await page.waitForTimeout(400);
const pl = await page.evaluate(() => { const f=SBMM.store.features[SBMM.store.features.length-1]; return f && f.pts; });
console.log("polar 15deg snap ->", JSON.stringify(pl), "(y should equal 2128800)");
await page.evaluate(() => { SBMM.draw.setPolar(false); SBMM.snap.setEnabled(true); });

/* ortho with shift */
await page.evaluate(() => { SBMM.store.clear(); SBMM.tools.setTool(null); SBMM.snap.setEnabled(false); SBMM.tools.setTool("distance"); });
await C(6371450, 2128800);
await page.keyboard.down("Shift");
await C(6371520, 2128830);
await page.keyboard.up("Shift");
await page.keyboard.press("Enter"); await page.waitForTimeout(400);
const or = await page.evaluate(() => { const f=SBMM.store.features[SBMM.store.features.length-1]; return f && f.pts; });
console.log("ortho shift ->", JSON.stringify(or), "(y should equal 2128800)");
await page.evaluate(() => SBMM.snap.setEnabled(true));

/* TEXT with label + leader */
await page.evaluate(() => { SBMM.store.clear(); SBMM.tools.setTool(null); SBMM.cmd.run("TEXT Stockpile A"); });
await page.waitForTimeout(200);
await C(6371480, 2128840);
await page.waitForTimeout(200);
await C(6371520, 2128870);
const tx = await page.evaluate(() => { const f = SBMM.store.features.find(f=>f.type==="text"); return f && { t:f.props.text, n:f.pts.length, kids:f.layer.getLayers().length }; });
console.log("TEXT ->", JSON.stringify(tx));

/* session round-trip with dim + text */
const ses = await page.evaluate(() => {
  SBMM.store.clear();
  SBMM.tools.mkDim([[6371400,2128800],[6371500,2128800]]);
  SBMM.tools.mkText([[6371450,2128850],[6371480,2128880]], "Note 1");
  const s = SBMM.store.serialize();
  SBMM.store.clear();
  SBMM.store.restore(s);
  return { version: s.version, types: SBMM.store.features.map(f=>f.type), texts: SBMM.store.features.map(f=>f.props.text||null), dimlen: (SBMM.store.features.find(f=>f.type==="dim")||{props:{}}).props.length_ft };
});
console.log("session v4 roundtrip ->", JSON.stringify(ses));

/* old v2 session still loads */
const old = await page.evaluate(() => {
  SBMM.store.clear();
  SBMM.store.restore({ app:"SBMM Site Explorer", version:2, features:[{ name:"Old", type:"line", pts:[[6371400,2128800],[6371450,2128800]], props:{} }] });
  return SBMM.store.features.map(f=>f.type+":"+f.name);
});
console.log("v2 restore ->", JSON.stringify(old));
console.log("errors:", errors.slice(0,10));
await browser.close();
