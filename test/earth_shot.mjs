/* Screenshots of the earthworks chrome, for design review:
   the graded pad on the map with its daylight line and cut/fill map, the sections
   drawer, and the report sheet. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { existsSync as __ex } from "node:fs";

const target = process.argv[2] || "/home/claude/repo/index.html";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("ERR", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });

const BOX = [[6371400, 2128700], [6371700, 2128700], [6371700, 2129000], [6371400, 2129000]];

/* pad + volume against it, with the cut/fill map on */
await page.evaluate(async (BOX) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const st = SBMM.design.rimStats(BOX);
  const f = SBMM.design.mkSurface(BOX.map(p => p.slice()), "Staging Pad A",
    { kind: "pad", padZ: +st.mean.toFixed(2), ratio: 3, side: "out" });
  for (let i = 0; i < 300 && !f._surf; i++) await wait(100);
  const v = SBMM.design.volumeAgainst(f);
  for (let i = 0; i < 300 && v.props.fill_yd3 == null; i++) await wait(100);
  v.props.showCutFill = true;
  const cb = v.card.querySelector(".vcf"); if (cb) { cb.checked = true; cb.onchange(); }
  await wait(400);
  SBMM.tools.zoomTo(f);
  await wait(900);
}, BOX);
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/shot_pad_map.png" });
console.log("shot: /tmp/shot_pad_map.png");

/* sections */
await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const surf = SBMM.design.list()[0];
  const f = SBMM.sections.mkSections([[6371380, 2128850], [6371720, 2128850]], "Pad A sections",
    { interval: 50, width: 300, designId: surf.id });
  for (let i = 0; i < 300 && !f._sec; i++) await wait(100);
  for (let i = 0; i < 200 && !f._cross; i++) await wait(100);
  SBMM.sections.openPanel(f);
  await wait(600);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/shot_sections.png" });
console.log("shot: /tmp/shot_sections.png");

/* properties tab on the surface */
await page.evaluate(() => SBMM.store.select(SBMM.design.list()[0].id));
await page.click('#leftTabs .dtab[data-tab="props"]');
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/shot_surf_props.png", clip: { x: 0, y: 0, width: 340, height: 950 } });
console.log("shot: /tmp/shot_surf_props.png");

/* the report sheet — captured standalone at paper width, which is the only honest
   way to judge a print layout */
import { writeFileSync } from "fs";
import { unlock } from "./gate.mjs";
const volHTML = await page.evaluate(async () => {
  const v = SBMM.store.features.find(f => f.type === "volume");
  return await SBMM.report.buildHTML(v);
});
writeFileSync("/tmp/report_volume.html", volHTML);
const secHTML = await page.evaluate(async () => {
  const s = SBMM.store.features.find(f => f.type === "sections");
  return await SBMM.report.buildHTML(s);
});
writeFileSync("/tmp/report_sections.html", secHTML);

/* the modal as the user first sees it */
await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const v = SBMM.store.features.find(f => f.type === "volume");
  await SBMM.report.open(v);
  await wait(1500);
});
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/shot_report_modal.png" });
console.log("shot: /tmp/shot_report_modal.png");

const sheet = await browser.newPage({ viewport: { width: 816, height: 1056 } });
await unlock(sheet);  /* the password gate — see test/gate.mjs */
await sheet.goto("file:///tmp/report_volume.html");
await sheet.waitForTimeout(900);
await sheet.screenshot({ path: "/tmp/shot_report_sheet.png", fullPage: true });
console.log("shot: /tmp/shot_report_sheet.png");
await sheet.goto("file:///tmp/report_sections.html");
await sheet.waitForTimeout(1200);
await sheet.screenshot({ path: "/tmp/shot_report_sections.png", fullPage: true });
console.log("shot: /tmp/shot_report_sections.png");

await browser.close();
