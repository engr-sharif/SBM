/* Boot + interaction performance probe. Not pass/fail — prints numbers.
   node test/perf.mjs /abs/path/index.html folder                  */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";

const target = process.argv[2];
const label = process.argv[3] || target;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(TIMEOUT);
const errs = [];
page.on("pageerror", e => errs.push(e.message));

console.log(`\n=== perf: ${label} ===`);
const t0 = Date.now();
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 180000 });
const wall = Date.now() - t0;

const marks = await page.evaluate(() => SBMM.perf.report());
console.log("TTI (wall, nav→loader hidden):", wall, "ms");
console.log("boot stages:");
for (const m of marks) console.log(`  ${String(m.stage).padEnd(16)} at ${String(m.at_ms).padStart(9)}   +${m.delta_ms}`);

const mem = await page.evaluate(() => {
  const m = performance.memory || {};
  return { usedMB: +(m.usedJSHeapSize / 1e6).toFixed(1), totalMB: +(m.totalJSHeapSize / 1e6).toFixed(1) };
});
console.log("JS heap after boot:", JSON.stringify(mem));

const imgs = await page.evaluate(() => {
  const a = [...document.images].filter(i => i.src && i.src.startsWith("data:"));
  return { count: a.length, megapixels: +(a.reduce((s, i) => s + (i.naturalWidth * i.naturalHeight), 0) / 1e6).toFixed(1) };
});
console.log("decoded data-URL <img> in DOM after boot:", JSON.stringify(imgs));

const vec = await page.evaluate(() => {
  let n = 0;
  SBMM.map.eachLayer(l => { n++; });
  return { leafletLayersOnMap: n };
});
console.log("map:", JSON.stringify(vec));

/* Let boot settle before measuring interaction. The four default basemap images
   (~84 megapixels of base64) finish decoding after the loader hides, and the GC of
   the terrain decode buffers lands somewhere in the second after that; probing
   through it produced a phantom 1.3 s "layer toggle" that was nothing of the kind. */
await page.evaluate(async () => {
  await Promise.all([...document.images].filter(i => i.src.startsWith("data:")).map(i => i.decode().catch(() => {})));
  await new Promise(r => setTimeout(r, 1500));
});

/* ---- interaction probes ---- */
const probe = async (name, fn, arg) => {
  let v;
  try { v = await page.evaluate(fn, arg); } catch (e) { v = "ERR " + e.message.slice(0, 120); }
  console.log(`  ${name.padEnd(36)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
};
console.log("interaction:");

await probe("status-bar lookups x500 (ms)", () => {
  const t = performance.now();
  for (let i = 0; i < 500; i++) { SBMM.elev(6371400 + i * 0.3, 2128800 + i * 0.3); SBMM.canopy(6371400 + i * 0.3, 2128800 + i * 0.3); }
  return +(performance.now() - t).toFixed(1);
});

/* page.evaluate serialises the function, so the pattern has to travel as an
   argument — a closed-over RegExp arrives as `undefined` in the page. */
const toggleFn = async ({ pat, on }) => {
  const row = [...document.querySelectorAll("#layers .lyr")].find(r => new RegExp(pat).test(r.textContent));
  if (!row) return "no such row";
  const cb = row.querySelector("input[type=checkbox]");
  if (cb.checked === on) return "already " + on;
  const t = performance.now();
  cb.checked = on; cb.onchange();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return +(performance.now() - t).toFixed(1);
};
await probe("contours 10 ft (site) ON (ms)", toggleFn, { pat: "Contours — 10 ft", on: true });
await probe("contours 10 ft (site) OFF (ms)", toggleFn, { pat: "Contours — 10 ft", on: false });
await probe("contours 2 ft (ABP) OFF (ms)", toggleFn, { pat: "Contours — 2 ft", on: false });
await probe("contours 2 ft (ABP) ON (ms)", toggleFn, { pat: "Contours — 2 ft", on: true });

await probe("snap static index build (ms)", () => {
  SBMM.snap.invalidate();
  const t = performance.now(); SBMM.snap.buildStatic();
  return { ms: +(performance.now() - t).toFixed(1), stats: SBMM.snap.stats() };
});
await probe("snap query x500 (ms)", () => {
  const t = performance.now();
  for (let i = 0; i < 500; i++) SBMM.snap.query(6371400 + (i % 300), 2128800 + (i % 300), { tolPx: 10 });
  return +(performance.now() - t).toFixed(1);
});

await probe("dataset table render, 95 wells (ms)", () => {
  const d = SBMM.datasets.list().find(x => x.points.length > 50) || SBMM.datasets.list()[0];
  if (!d) return "no dataset";
  SBMM.table.toggle(true);
  const t = performance.now(); SBMM.dsTable.show(d.id);
  return { ms: +(performance.now() - t).toFixed(1), rows: d.points.length };
});
await page.evaluate(() => SBMM.table.toggle(false));

await probe("sheet viewer open (ms)", () => {
  const t = performance.now();
  SBMM.sheets.open("C-106");
  return +(performance.now() - t).toFixed(1);
});
await probe("sheet viewer close", () => { SBMM.sheets.closeAll && SBMM.sheets.closeAll(); return "ok"; });

/* ---- 3D ---- */
const three = await page.evaluate(async () => {
  const t0 = performance.now();
  SBMM.viewer3d.toggle();
  for (let i = 0; i < 400 && !SBMM.viewer3d.isOpen(); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 4000));
  return { openMs: +(performance.now() - t0).toFixed(0), stats: SBMM.viewer3d.stats() };
});
console.log("3D open:", JSON.stringify(three.stats && { openMs: three.openMs, verts: three.stats.terrainVerts, gpu: three.stats.gpu, renders: three.stats.renderCount, frames: three.stats.frameCount }));

const idle = await page.evaluate(() => new Promise(res => {
  const a = SBMM.viewer3d.stats();
  setTimeout(() => { const b = SBMM.viewer3d.stats(); res({ rendersIn2s: b.renderCount - a.renderCount, rafIn2s: b.frameCount - a.frameCount }); }, 2000);
}));
console.log("3D idle 2 s:", JSON.stringify(idle));

/* ---- the hitch after a camera move (v22 §G) ----------------------------
   THE NUMBER THAT MATTERS IS THE LONGEST SYNCHRONOUS SPAN, not the wall time
   of the rebuild: a build that yields between tiles can take a second of wall
   clock and never block anything, and a build that does not yield blocks a
   gesture for as long as it runs. Two independent readings, because neither
   alone is enough here:

     buildBlockMs   the terrain module's own measurement of its longest
                    synchronous span (js/terrain3d.js stat.lastBuildBlockMs) —
                    the hitch this round exists to remove, and the one number
                    that is comparable before and after.
     longTaskMs     what a PerformanceObserver sees. Under SOFTWARE GL one
                    rendered frame is itself a 0.5-1 s task, so this is
                    dominated by the renderer on this box and is reported
                    rather than compared; on a GPU (SBMM_GPU=1) it is the
                    honest reading of the same thing.
   Four camera moves over the mine window, the last one BACK to the first, so
   the last row also says whether the geometry cache answered. */
const hitch = await page.evaluate(async () => {
  const tasks = [];
  let po = null;
  try {
    po = new PerformanceObserver(l => { for (const e of l.getEntries()) tasks.push(e.duration); });
    po.observe({ entryTypes: ["longtask"] });
  } catch (e) { /* not every browser has it */ }
  let gaps = [], last = performance.now(), stop = false;
  const tick = () => { const t = performance.now(); gaps.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const spots = [[6371700, 2128900], [6371150, 2129650], [6372250, 2128350], [6371700, 2128900]];
  const rows = [];
  for (const [x, y] of spots) {
    tasks.length = 0; gaps.length = 0; last = performance.now();
    SBMM.viewer3d.openAt(x, y);
    await new Promise(r => setTimeout(r, 6000));
    const s = SBMM.viewer3d.stats();
    const t = s.tiles || {};
    rows.push({
      at: [x, y],
      buildBlockMs: t.lastBuildBlockMs == null ? null : t.lastBuildBlockMs,
      buildCpuMs: t.lastBuildCpuMs == null ? null : t.lastBuildCpuMs,
      buildWallMs: t.lastBuildMs == null ? null : t.lastBuildMs,
      builtTiles: t.lastBuildTiles == null ? null : t.lastBuildTiles,
      geomCache: t.geomHits == null ? null : { hits: t.geomHits, misses: t.geomMisses },
      longTaskMs: tasks.length ? +Math.max.apply(null, tasks).toFixed(1) : 0,
      tasksOver100: tasks.filter(v => v > 100).length,
      frameGapMs: gaps.length ? +Math.max.apply(null, gaps).toFixed(1) : 0,
      tiles: t.tiles, verts: t.verts
    });
  }
  stop = true; if (po) po.disconnect();
  return rows;
});
console.log("3D hitch after a camera move (v22 §G):");
for (const r of hitch) console.log("  ", JSON.stringify(r));
{
  const bb = hitch.map(r => r.buildBlockMs || 0);
  console.log("   longest synchronous terrain-build span over the four moves:",
    Math.max.apply(null, bb).toFixed(1), "ms   (median",
    bb.slice().sort((a, b) => a - b)[Math.floor(bb.length / 2)].toFixed(1) + " ms)");
}

/* everything on, then measure a forced render */
const heavy = await page.evaluate(async () => {
  /* there are no 3D checkboxes any more (v9 §1/§4): SBMM.layerState is the one
     answer to "is this layer on", in 2D and in 3D alike, so "everything on" is
     every group switched on plus the three lazily-built base layers */
  const LS = SBMM.layerState;
  for (const g of ["framework", "design", "invest", "mywork"]) LS.setGroup(g, true);
  for (const id of ["canopy", "contours_site", "contours_abp"]) if (LS.get("base", id)) LS.set("base", id, { on: true });
  if (LS.get("design", "sheets3d")) LS.set("design", "sheets3d", { on: true });
  const d = document.getElementById("v3dDetail"); if (d) { d.value = "high"; d.onchange && d.onchange(); }
  await new Promise(r => setTimeout(r, 6000));
  const a = SBMM.viewer3d.stats();
  /* THE FIRST FRAME IS NOT THE FRAME COST. Everything was just switched on,
     so frame 1 pays for uploading every new geometry and every new drape
     texture (and generating its mipmaps) — with the v22 §G drape that is 20+
     textures at up to 1,024 px. Averaging it into ten frames reads as a
     steady-state regression that is not one, so it is reported on its own. */
  const t = performance.now();
  SBMM.viewer3d.requestRender();
  await new Promise(r => requestAnimationFrame(r));
  const first = performance.now() - t;
  const t2 = performance.now();
  for (let i = 0; i < 9; i++) { SBMM.viewer3d.requestRender(); await new Promise(r => requestAnimationFrame(r)); }
  const ms = (performance.now() - t2) / 9;
  return { msPerFrame: +ms.toFixed(1), firstFrameMs: +first.toFixed(1), stats: a };
});
console.log("3D everything-on frame cost:", heavy.msPerFrame, "ms  (first frame after the switch-on, which pays for every upload:",
            heavy.firstFrameMs, "ms) | gpu:", JSON.stringify(heavy.stats.gpu),
            "| sheetDrapes:", (heavy.stats.sheetDrapes || []).length, "| contourVerts:", heavy.stats.contourVerts);

/* leak check: 10 toggle cycles of the lazily-built things */
const leak = await page.evaluate(async () => {
  const LS = SBMM.layerState;
  const cyc = async ([g, id]) => {
    if (!LS.get(g, id)) return;
    LS.set(g, id, { on: !LS.isOn(g, id) });
    await new Promise(r => setTimeout(r, 120));
  };
  const before = SBMM.viewer3d.stats().gpu;
  const lazy = [["base", "canopy"], ["base", "contours_abp"], ["design", "sheets3d"]];
  for (let i = 0; i < 10; i++) { for (const l of lazy) { await cyc(l); await cyc(l); } }
  await new Promise(r => setTimeout(r, 1500));
  const after = SBMM.viewer3d.stats().gpu;
  return { before, after };
});
console.log("3D 10x toggle cycles (canopy/contours/sheets):", JSON.stringify(leak));

const mem2 = await page.evaluate(() => {
  const m = performance.memory || {};
  return { usedMB: +(m.usedJSHeapSize / 1e6).toFixed(1) };
});
console.log("JS heap after everything:", JSON.stringify(mem2));
if (errs.length) console.log("page errors:", errs.slice(0, 6));
await browser.close();
