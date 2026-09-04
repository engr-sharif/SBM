import { chromium } from "playwright";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const CHROME = process.env.CHROME_BIN || (__ex("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined); // undefined = Playwright's own chromium
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(300000);
const errs=[]; page.on("pageerror",e=>errs.push(e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file:///home/claude/repo/index.html");
await page.waitForSelector("#loading",{state:"hidden",timeout:120000});
const wait = ms => page.waitForTimeout(ms);

/* ---- 1. WAND result on a pile, with the residual preview visible ---- */
await page.evaluate(()=>{ SBMM.map.setView([2128700,6371744], 1); });
await wait(900);
await page.evaluate(()=>SBMM.smartbound.cmdWand());
await wait(3500);                                   // let the residual preview build
await page.evaluate(async()=>{ await SBMM.smartbound.runWand(6371744,2128677); });
await wait(1800);
await page.screenshot({path:"/tmp/p4_wand.png"});
console.log("shot 1 wand:", await page.evaluate(()=>({
  preview: !!document.querySelector(".leaflet-image-layer[src^='data:image/png']"),
  feats: SBMM.store.features.length })));
await page.evaluate(()=>SBMM.smartbound.disarm(true));
await wait(400);

/* ---- 2. canopy stands over the DU-3 area ---- */
await page.evaluate(()=>{ SBMM.map.setView([2128840,6372320], 1); });
await wait(900);
await page.evaluate(async()=>{
  const P=[[6372142,2128600],[6372527,2128600],[6372527,2129076],[6372142,2129076]];
  await SBMM.smartbound.runStands(P,null);
});
await wait(1500);
await page.screenshot({path:"/tmp/p4_stands.png"});
console.log("shot 2 stands:", await page.evaluate(()=>
  SBMM.store.features.filter(f=>f.group==="Canopy stands").length + " stands"));

/* ---- 3. tree dots zoomed to a wooded slope ---- */
await page.evaluate(async()=>{
  await SBMM.trees.detect();
  const row=[...document.querySelectorAll("#anaLayers .lyr")].find(r=>/Trees/.test(r.textContent));
  const cb=row.querySelector("input[type=checkbox]"); cb.checked=true; cb.onchange();
});
await wait(2500);
await page.evaluate(()=>{ SBMM.map.setView([2129260,6371380], 0); });
await wait(1600);
await page.screenshot({path:"/tmp/p4_trees.png"});
console.log("shot 3 trees:", await page.evaluate(()=>{
  const s=SBMM.trees.stats(); return s.n+" detected, "+(document.getElementById("treeCanvas").style.display); }));

/* ---- 4. 3D canopy coloured by height ---- */
await page.evaluate(()=>SBMM.viewer3d.openAt(6371400,2129200));
await page.waitForFunction(()=>document.getElementById("v3dStatus").textContent==="",null,{timeout:180000});
await wait(1500);
await page.evaluate(()=>{ const c=document.getElementById("v3dCanopy"); c.checked=true; c.onchange(); });
await page.waitForFunction(()=>document.getElementById("v3dStatus").textContent==="",null,{timeout:180000});
await wait(2500);
await page.screenshot({path:"/tmp/p4_canopy3d.png"});
console.log("shot 4 3D canopy done");
console.log("errors:", errs.length?errs.slice(0,4):"none");
await browser.close();
