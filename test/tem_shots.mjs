/* v36 — the 2026 TEM2Go geophysics, photographed.

     node test/tem_shots.mjs [index.html] [shots dir]

   Writes into test/shots/:
     tem_slice.png      the depth slice at 30 ft over the ortho, with the card
     tem_deep.png       the same slice at 150 ft, conductivity, viridis
     tem_popup.png      a sounding's popup: its model, the grid beside it, and
                        the nearest boring's logged contacts across it
     tem_3d.png         the soundings and the slice in 3D, from a low oblique
     tem_3d_sections.png  see-through ground, both vertical sections and a stack
     tem_voxels.png     the most conductive quarter of the model as voxels
     tem_fence.png      a fence through three borings with the model behind it
     tem_borings.png    the log window's Geophysics tab: a hole and the table

   Not pass-fail — look at them. It prints what SBMM.geophys said at each shot,
   so a wrong number is visible without opening the picture. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./lib/browser.mjs";
import { unlock, lateSettled } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const target = process.argv[2] || resolve(HERE, "..", "index.html");
const OUT = process.argv[3] || resolve(HERE, "shots");
mkdirSync(OUT, { recursive: true });

const browser = await launch({ name: "tem_shots" });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errs = [];
page.on("pageerror", e => errs.push(String(e)));
await unlock(page, resolve(HERE, ".."));
await page.goto(pathToFileURL(target).href);
await page.waitForFunction(() => document.getElementById("loading").style.display === "none", null, { timeout: 180000 });
await lateSettled(page);

const probe = () => page.evaluate(() => {
  const G = SBMM.geophys, R = G.result(), s = G.slice();
  return { settings: G.settings(), grid: R && [R.nx, R.ny, R.dx, R.nodes, R.method, R.vg && R.vg.range, R.ms_wall],
           range: G.range(), slice: s && [s.W, s.H, s.depth],
           rows: [...document.querySelectorAll(".temcard .rrow")].map(r => r.textContent.trim()).slice(0, 4) };
});

await page.evaluate(() => SBMM.cmd.run("TEM 30"));
await page.waitForFunction(() => SBMM.geophys.slice() && document.querySelector(".temcard"), null, { timeout: 120000 });
await page.evaluate(() => {
  SBMM.layerState.set("invest", "tem_soundings", { on: true });
  const R = SBMM.geophys.result();
  SBMM.map.fitBounds([[R.y0, R.x0], [R.y0 + R.ny * R.dx, R.x0 + R.nx * R.dx]], { padding: [40, 40], animate: false });
});
await page.waitForTimeout(1500);
console.log("slice:", JSON.stringify(await probe()));
await page.screenshot({ path: resolve(OUT, "tem_slice.png") });

await page.evaluate(() => {
  const set = (k, v) => { const el = document.querySelector(`.temcard [data-tem="${k}"]`); el.value = v;
                          el.dispatchEvent(new Event(k === "depth" ? "input" : "change", { bubbles: true })); };
  set("depth", 150); set("prop", "cond"); set("cmap", "viridis");
});
await page.waitForTimeout(1200);
console.log("deep:", JSON.stringify(await probe()));
await page.screenshot({ path: resolve(OUT, "tem_deep.png") });

await page.evaluate(() => {
  const set = (k, v) => { const el = document.querySelector(`.temcard [data-tem="${k}"]`); el.value = v;
                          el.dispatchEvent(new Event(k === "depth" ? "input" : "change", { bubbles: true })); };
  set("prop", "res"); set("cmap", "hydro"); set("depth", 30);
});
await page.waitForTimeout(800);
/* the sounding nearest a 2025 boring, so the popup carries the contacts */
const pick = await page.evaluate(() => {
  const D = SBMM_DATA.tem2026, H = SBMM.borelogs.holes();
  let best = null;
  for (const h of H) for (let i = 0; i < D.n; i++) {
    const d = Math.hypot(D.x[i] - h.x, D.y[i] - h.y);
    /* near a boring, but not under its marker */
    if (d > 25 && (!best || d < best.d)) best = { i, d, h: h.id };
  }
  SBMM.map.setView([D.y[best.i], D.x[best.i]], 1, { animate: false });
  return best;
});
await page.waitForTimeout(800);
const pt = await page.evaluate(i => {
  const D = SBMM_DATA.tem2026, p = SBMM.map.latLngToContainerPoint([D.y[i], D.x[i]]);
  const r = document.getElementById("map").getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, pick.i);
await page.mouse.click(pt.x, pt.y);
await page.waitForTimeout(800);
console.log("popup:", JSON.stringify(pick), await page.evaluate(() => {
  const p = document.querySelector(".leaflet-popup .temPop");
  return p ? { id: p.dataset.tem, contacts: p.querySelectorAll(".temcontact").length,
               model: !!p.querySelector(".temmodel"), grid: !!p.querySelector(".temgrid") } : null;
}));
await page.screenshot({ path: resolve(OUT, "tem_popup.png") });

await page.evaluate(() => { SBMM.map.closePopup(); if (!SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle(); });
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "" &&
  document.getElementById("view3d").style.display === "block", null, { timeout: 120000 });
await page.waitForTimeout(4000);
console.log("3d:", JSON.stringify(await page.evaluate(() => {
  const ld = SBMM.viewer3d.layersDrawn ? SBMM.viewer3d.layersDrawn() : (SBMM.viewer3d.stats().layersDrawn || {});
  return Object.keys(ld).filter(k => /tem_/.test(k));
})));
await page.screenshot({ path: resolve(OUT, "tem_3d.png") });

/* phase 4: see-through ground, both sections and a slice stack, then voxels */
const kick = async () => {           // a real drag, so the rig eases and repaints
  const c = await page.$("#v3dCanvas"), b = await c.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2 + 2, { steps: 3 });
  await page.mouse.up();
};
const m3 = await page.evaluate(() => {
  const G = SBMM.geophys, R = G.result();
  G.set("ew", true); G.set("ns", true); G.set("stack", true); G.set("stackStep", 4); G.set("depth", 60);
  SBMM.viewer3d.setGround("see");
  SBMM.viewer3d.frameBox(R.x0, R.y0, R.x0 + (R.nx - 1) * R.dx, R.y0 + (R.ny - 1) * R.dx);
  SBMM.viewer3d.preset("iso");
  SBMM.viewer3d.refreshOverlays();
  const M = G.model3d();
  return { stack: M.stack.length, sections: M.sections.map(s => s.dir + "@" + Math.round(s.coord)),
           ground: SBMM.viewer3d.ground() };
});
await kick(); await page.waitForTimeout(5000);
console.log("3d model:", JSON.stringify(m3));
await page.screenshot({ path: resolve(OUT, "tem_3d_sections.png") });
await page.evaluate(() => {
  const G = SBMM.geophys;
  G.set("stack", false); G.set("ew", false); G.set("ns", false); G.set("vox", true);
  G.set("voxLo", 0); G.set("voxHi", 25);
  SBMM.viewer3d.setGround("hidden");
  SBMM.viewer3d.refreshOverlays();
});
await kick(); await page.waitForTimeout(5000);
console.log("voxels:", await page.evaluate(() => { const M = SBMM.geophys.model3d(); return M.voxels ? M.voxels.x.length : 0; }));
await page.screenshot({ path: resolve(OUT, "tem_voxels.png") });
await page.evaluate(() => {
  const G = SBMM.geophys;
  G.set("vox", false); G.set("depth", 30);
  SBMM.viewer3d.setGround("solid");
  if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
});

/* phase 5: a fence through two borings inside the survey, with the model
   behind it, and the log window's Geophysics tab */
const fz = await page.evaluate(() => {
  const C = SBMM.geophys.calibrate();
  const ids = C.holes.slice(0, 3).map(r => r.id);
  SBMM.cmd.run("FENCE " + ids.join(" "));
  const f = SBMM.fence.currentFence();
  f.props.tem = true; SBMM.fence.recompute(f);
  SBMM.borewin.open(ids[0], { tab: "fence" });
  const svg = document.querySelector(".blwin svg.fnsvg");
  return { ids, image: !!(svg && svg.querySelector("image.fntem")),
           covered: svg && svg.querySelector("image.fntem") ? svg.querySelector("image.fntem").dataset.covered : null };
});
await page.waitForTimeout(1200);
console.log("fence:", JSON.stringify(fz));
await page.screenshot({ path: resolve(OUT, "tem_fence.png") });
const tb = await page.evaluate(() => {
  SBMM.borewin.open(null, { tab: "tem" });
  const el = document.querySelector(".blwin");
  const C = SBMM.geophys.calibrate();
  return { rows: el.querySelectorAll("tr.temrow").length, prof: !!el.querySelector("svg.temhole"),
           classes: C.classes, threshold: C.threshold };
});
await page.waitForTimeout(800);
console.log("borings:", JSON.stringify(tb));
await page.screenshot({ path: resolve(OUT, "tem_borings.png") });

console.log(errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await browser.close();
