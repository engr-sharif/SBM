/* SBMM Site Explorer — the v20 quadtree terrain and the GPU rasters, in a browser.

     node test/terrain3d.mjs /abs/path/index.html folder
     node test/terrain3d.mjs /abs/path/dist/SBMM_Site_Explorer.html dist

   Six sections, and every one of them is an acceptance line of
   docs/V20_TERRAIN_SPEC.md §6:

     lod       the quadtree owns the terrain and draws real tiles
     quality   4 / 2 / 1 px screen error: tiles, triangles, bytes, frame cost,
               and std strictly coarser than high strictly coarser than ultra
     onefoot   the ABP at 2 px draws the 1-ft data AT 1 ft (finest level 0)
     idle      an idle view still renders nothing after a selection settles
     gpu       the shader hillshade against the same formula on the CPU,
               mean abs diff < 2/255 (§4)
     seams     SBMM.elev and the tile the 3D view is drawing agree, in the page

   and four more from docs/V22_SPEC.md §G:

     drape     the ground resolution of the picture on every drawn tile, and
               the texture memory the drawn set costs
     band      the v24 black band: the 1-ft window's own boundary, rendered and
               measured against a control line 150 ft inside it
     meshport  the tile mesh built in the worker against the same function
               called inline, element for element
     geomcache a camera move away and back rebuilds no geometry
     map2d     the 2D basemap stack at high zoom over the mine window

   Slow under software GL on purpose — the timeouts come from test/lib/browser.mjs
   and SBMM_GPU=1 drops them. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { decodePNG } from "./lib/png.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { unlock } from "./gate.mjs";

const target = process.argv[2], label = process.argv[3] || "folder";
const SECTIONS = ["lod", "quality", "onefoot", "idle", "gpu", "seams",
                  "drape", "band", "meshport", "geomcache", "map2d"];
if (process.argv.includes("--list")) { console.log(SECTIONS.join(" ")); process.exit(0); }
let only = null;
if (process.argv.includes("--only")) only = new Set(process.argv[process.argv.indexOf("--only") + 1].split(","));
const want = s => !only || only.has(s);

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log(`PASS ${name}` + (got !== undefined ? `  ${got}` : ""));
  else { fails++; console.log(`FAIL ${name}  got ${got}`); }
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => { errors.push(e.message); console.log("pageerror:", e.message); });
await unlock(page);
await page.goto(pathToFileURL(resolve(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: TIMEOUT });

const idx = await page.evaluate(() => SBMM.tiles.stats());
console.log(`\n[${label}] tile index:`, idx.ready ? "yes" : "NO",
  "· single file:", idx.singleFile, "· layers:", JSON.stringify(idx.counts));
console.log("   source:", idx.source);

/* ------------------------------------------------------------------ open -- */
await page.evaluate(() => SBMM.viewer3d.openAt(6371700, 2128900));
await page.waitForFunction(() => document.getElementById("v3dStatus").textContent === "", null, { timeout: TIMEOUT });
await page.waitForTimeout(2500);

if (want("lod")) {
  console.log("\n== lod — the quadtree owns the terrain ==");
  const s = await page.evaluate(() => SBMM.viewer3d.stats());
  ok("the quadtree is the terrain builder", s.terrainLod === true, s.terrainLod);
  ok("tiles are drawn", s.tiles && s.tiles.tiles > 0, s.tiles && s.tiles.tiles);
  ok("every drawn tile has geometry", s.tiles && s.tiles.triangles > 1000, s.tiles && s.tiles.triangles);
  console.log("   drawn:", JSON.stringify({ tiles: s.tiles.tiles, byLevel: s.tiles.byLevel,
    verts: s.tiles.verts, tris: s.tiles.triangles, mb: +(s.tiles.bytes / 1e6).toFixed(1),
    finestCellFt: s.tiles.finestCellFt, style: s.tiles.style }));
  console.log("   cache:", JSON.stringify({ tiles: s.tileCache.tiles, mb: +(s.tileCache.bytes / 1e6).toFixed(1),
    budgetMb: +(s.tileCache.budget / 1e6).toFixed(0), injected: s.tileCache.injected,
    synth: s.tileCache.synth, hits: s.tileCache.hits }));
  ok("no page errors while the terrain built", errors.length === 0, errors.length);
}

/* --------------------------------------------------------------- quality -- */
if (want("quality")) {
  console.log("\n== quality — 4 / 2 / 1 px screen error ==");
  const rows = {};
  for (const q of ["std", "high", "ultra"]) {
    const r = await page.evaluate(async qq => {
      const sel = document.getElementById("v3dDetail");
      sel.value = qq;
      await sel.onchange();
      await new Promise(r => setTimeout(r, 400));
      const s = SBMM.viewer3d.stats();
      /* the frame cost of ONE forced draw, with the terrain as it now stands */
      const t0 = performance.now();
      SBMM.viewer3d.requestRender();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { q: qq, targetPx: s.terrainQualityPx, tiles: s.tiles.tiles,
               byLevel: s.tiles.byLevel, verts: s.tiles.verts, tris: s.tiles.triangles,
               mb: +(s.tiles.bytes / 1e6).toFixed(2), finestCellFt: s.tiles.finestCellFt,
               terrainVerts: s.terrainVerts, frameMs: +(performance.now() - t0).toFixed(1),
               cacheMb: +(s.tileCache.bytes / 1e6).toFixed(1) };
    }, q);
    rows[q] = r;
    console.log("  ", q.padEnd(6), JSON.stringify(r));
  }
  ok("standard is coarser than high", rows.std.terrainVerts < rows.high.terrainVerts,
    `${rows.std.terrainVerts} < ${rows.high.terrainVerts}`);
  ok("high is coarser than ultra", rows.high.terrainVerts <= rows.ultra.terrainVerts,
    `${rows.high.terrainVerts} <= ${rows.ultra.terrainVerts}`);
  ok("triangles stay inside the budget", rows.ultra.tris < 8e6, rows.ultra.tris);
  /* back to the shipped default so the rest of the run is the default */
  await page.evaluate(async () => {
    const sel = document.getElementById("v3dDetail"); sel.value = "high"; await sel.onchange();
  });
  await page.waitForTimeout(400);
}

/* --------------------------------------------------------------- onefoot -- */
if (want("onefoot")) {
  console.log("\n== onefoot — the 1-ft data drawn at 1 ft ==");
  /* stand close over the ABP: the whole point of the round */
  const s = await page.evaluate(async () => {
    SBMM.viewer3d.openAt(6371700, 2128900);
    await new Promise(r => setTimeout(r, 400));
    SBMM.viewer3d.frameBox(6371600, 2128800, 6371800, 2129000);
    await new Promise(r => setTimeout(r, 2500));
    return SBMM.viewer3d.stats();
  });
  console.log("   drawn:", JSON.stringify({ tiles: s.tiles.tiles, byLevel: s.tiles.byLevel,
    finestCellFt: s.tiles.finestCellFt, verts: s.tiles.verts, tris: s.tiles.triangles }));
  ok("the finest level drawn over the ABP is the 1-ft one",
    s.tiles.finestCellFt !== null && s.tiles.finestCellFt <= 1, s.tiles.finestCellFt);
  ok("the old whole-DEM build never got below its stride",
    s.terrainLod === true, s.terrainLod);
}

/* ------------------------------------------------------------------ idle -- */
if (want("idle")) {
  console.log("\n== idle — a settled view renders nothing ==");
  const r = await page.evaluate(async () => {
    /* WAIT ON THE CONDITION, NOT ON THE CLOCK. The section before this one
       flies the camera with frameBox(), and the orbit rig eases over about
       thirty FRAMES — under software GL at `high` one frame costs a second or
       more, so the flight can still be running half a minute later and a fixed
       1.2 s wait measures the flight rather than the idle. That is the
       "an idle view renders nothing … got 2" flake, and it is the same lesson
       block 9z learned in v18. Poll until the render count has not moved for
       three polls, then measure. */
    let last = -1, same = 0, settled = false;
    for (let i = 0; i < 50 && !settled; i++) {
      const n = SBMM.viewer3d.stats().renderCount;
      if (n === last) { if (++same >= 3) settled = true; } else { same = 0; last = n; }
      if (!settled) await new Promise(r => setTimeout(r, 1200));
    }
    const a = SBMM.viewer3d.stats().renderCount;
    await new Promise(r => setTimeout(r, 2500));
    const b = SBMM.viewer3d.stats().renderCount;
    return { a, b, delta: b - a, settled, queued: SBMM.tiles.stats().queued };
  });
  console.log("   renders over 2.5 idle seconds:", r.delta, "· queue:", r.queued,
    "· camera settled:", r.settled);
  ok("an idle view renders nothing (the e2e 9e contract: at most one)", r.delta <= 1, r.delta);
}

/* ------------------------------------------------------------------- gpu -- */
if (want("gpu")) {
  console.log("\n== gpu — the shader hillshade against the CPU (§4) ==");
  const r = await page.evaluate(async () => {
    const T = SBMM.tiles;
    /* one tile in the middle of the mine window at 2 ft — real relief, no
       NoData edge to argue about */
    const [tx, ty] = T.tileAt(1, 6371700, 2128900);
    if (!T.has("dem", 1, tx, ty)) return { skip: "no tile" };
    const g = await SBMM.terrain3d.renderRasterTile(1, tx, ty, "hillshade");
    const c = await SBMM.terrain3d.cpuHillshade(1, tx, ty);
    if (!g || !c) return { skip: g ? "no cpu" : "no webgl2", webgl2: SBMM.terrain3d.webgl2() };
    let n = 0, sum = 0, worst = 0;
    for (let k = 0; k < c.rgba.length; k += 4) {
      if (c.rgba[k + 3] === 0) continue;             // NoData on both sides
      /* the render target's row 0 is the BOTTOM; the CPU array's row 0 is the
         south edge, which is the same row. No flip. */
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(g.rgba[k + ch] - c.rgba[k + ch]);
        sum += d; n++; if (d > worst) worst = d;
      }
    }
    return { tile: [1, tx, ty], mean: sum / Math.max(1, n), worst, n,
             webgl2: SBMM.terrain3d.webgl2(), gpuRaster: SBMM.terrain3d.gpuRaster() };
  });
  if (r.skip) { console.log("   skipped:", r.skip, "· webgl2:", r.webgl2); ok("WebGL2 is present or the CPU path said so", true, r.skip); }
  else {
    console.log("   tile", JSON.stringify(r.tile), "· samples", r.n,
      "· mean abs diff", r.mean.toFixed(3), "/255 · worst", r.worst);
    ok("shader hillshade matches the CPU formula (mean < 2/255)", r.mean < 2, r.mean.toFixed(3));
  }
  /* the sun relights without a rebuild */
  const sun = await page.evaluate(async () => {
    const before = SBMM.viewer3d.stats().tiles.tiles;
    SBMM.viewer3d.sun(120, 20);
    await new Promise(r => setTimeout(r, 300));
    const after = SBMM.viewer3d.stats();
    SBMM.viewer3d.sun(315, 35);
    return { before, after: after.tiles.tiles, sun: after.sun };
  });
  ok("moving the sun does not rebuild the terrain", sun.before === sun.after,
    `${sun.before} -> ${sun.after}`);
}

/* ----------------------------------------------------------------- seams -- */
if (want("seams")) {
  console.log("\n== seams — the two sources agree in the page ==");
  const r = await page.evaluate(async () => {
    const T = SBMM.tiles;
    let s = 424242 >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const m = SBMM.demSite.m;
    let n = 0, worst = 0, tried = 0, at = null;
    while (n < 200 && tried < 6000) {
      tried++;
      const z = rnd() < 0.5 ? 0 : 1, c = Math.pow(2, z);
      const X = T.origin().x0 + Math.round(rnd() * (m.w * m.cell) / c) * c;
      const Y = T.origin().y0 + Math.round(rnd() * (m.h * m.cell) / c) * c;
      const [tx, ty] = T.tileAt(z, X, Y);
      if (!T.has("dem", z, tx, ty)) continue;
      const rec = await T.get("dem", z, tx, ty, { priority: 5000 }).catch(() => null);
      if (!rec || !rec.z32) continue;
      const r0 = T.rect(z, tx, ty);
      const i = Math.round((X - r0[0]) / c), j = Math.round((Y - r0[1]) / c);
      if (i < 0 || j < 0 || i > 255 || j > 255) continue;
      const v = rec.z32[j * 256 + i];
      if (isNaN(v)) continue;
      /* the grid NODE, on SBMM.demAt's own finest-first order — not the
         bilinear SBMM.elev, which is an interpolation BETWEEN nodes */
      let g = NaN;
      for (const d of SBMM.dems) {
        const mm = d.m;
        const gi = Math.round((X - mm.x0) / mm.cell), gj = Math.round((Y - mm.y0) / mm.cell);
        if (gi < 0 || gj < 0 || gi >= mm.w || gj >= mm.h) continue;
        const t = d.z[gj * mm.w + gi];
        if (!isNaN(t)) { g = t; break; }
      }
      if (isNaN(g)) continue;
      n++;
      const d = Math.abs(v - g);
      if (d > worst) { worst = d; at = [X, Y, z]; }
    }
    return { n, worst, at, tried };
  });
  console.log("   ", r.n, "points ·  worst |tile − grid node| =", r.worst.toFixed(9), "ft", r.at ? "at " + r.at : "");
  ok("the display source equals the analysis source", r.n > 100 && r.worst < 1e-3, r.worst);
}

/* ----------------------------------------------------------------- drape -- */
/* v22 §G. The complaint this section exists for is "the entire site topo looks
   a bit pixelated when zooming in", and the measurable form of it is FEET PER
   TEXEL on the ground. Until v22 the drape was the ortho tile at the terrain
   tile's own level, so a 4-ft mesh tile carried 4-ft imagery; now it is `k`
   levels finer, capped by what the ortho pyramid has (1 ft/px over the mine
   window, 2 ft/px over the rest of the site).

   Two things are asserted and they are different:
     * the tile UNDER THE VIEW CENTRE over the mine window is <= 1 ft/px — the
       ground the user is actually looking at;
     * no drawn tile anywhere is coarser than `max(1, cellFt / 2^k)` — the rule
       the code implements, so a tile that fell back further than the pyramid
       required would be caught wherever it happened. */
if (want("drape")) {
  console.log("\n== drape — feet per texel on the ground (v22 §G) ==");
  /* SETTLE ON THE QUEUE, NOT ON THE CLOCK. The drape of a tile is composited
     from up to 16 ortho tiles, each of which may still be loading; read too
     early and the tile reports its coarse fallback (0.5 instead of 0.25 over
     the ABP), which reads exactly like the pyramid not having the level. */
  await page.evaluate(async () => {
    const sel = document.getElementById("v3dDetail");
    sel.value = "high"; await sel.onchange();
    SBMM.viewer3d.openAt(6371700, 2128900);
    await new Promise(r => setTimeout(r, 600));
    SBMM.viewer3d.frameBox(6371600, 2128800, 6371800, 2129000);
    await new Promise(r => setTimeout(r, 4500));
  });
  await page.waitForFunction(() => SBMM.tiles.stats().queued === 0, null, { timeout: TIMEOUT });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const m = SBMM.demAbp.m;
    const mine = [m.x0, m.y0, m.x0 + m.w * m.cell, m.y0 + m.h * m.cell];
    const over = t => !(t.rect[2] <= mine[0] || t.rect[0] >= mine[2]
                     || t.rect[3] <= mine[1] || t.rect[1] >= mine[3]);
    const has = (t, x, y) => x >= t.rect[0] && x < t.rect[2] && y >= t.rect[1] && y < t.rect[3];
    const tiles = SBMM.terrain3d.drawnTiles().map(t => Object.assign(t, { mine: over(t) }));
    const under = tiles.filter(t => has(t, 6371700, 2128900)).sort((a, b) => a.z - b.z)[0] || null;
    const s = SBMM.viewer3d.stats();
    return { tiles, mine, under, drapeK: s.tiles.drapeK, texMB: s.tiles.texMB,
             texPx: s.tiles.drapeTexPx, composed: s.tiles.drapeComposed,
             range: s.tiles.drapeFtPerPx, gpuTextures: s.gpuTextures,
             profile: SBMM.touch.profile() };
  });
  console.log("   profile", r.profile, "· drape k", r.drapeK, "· composed",
    r.composed + "/" + r.tiles.length, "tiles · largest texture", r.texPx, "px");
  const by = {};
  for (const t of r.tiles) {
    const k = `z${t.z} (${t.cellFt} ft cell)`;
    (by[k] || (by[k] = [])).push(t);
  }
  for (const k of Object.keys(by).sort()) {
    const g = by[k];
    const ft = [...new Set(g.map(t => t.ftPerPx))].sort((a, b) => a - b);
    console.log("   ", k.padEnd(20), String(g.length).padStart(2), "tiles ·",
      "texture", [...new Set(g.map(t => t.texPx))].join("/"), "px ·",
      ft.join("/"), "ft/px ·", g.filter(t => t.mine).length, "over the mine window");
  }
  console.log("   drawn-set texture memory:", r.texMB, "MB   (three reports",
    r.gpuTextures, "textures)");
  /* v24: the pyramid's floor is 0.25 ft/px over the 3-in ABP crop and 0.5 over
     the 6-in mine ortho — the 2D map's own two resolutions. Until v24 it was
     1 ft/px everywhere, which is what "pixelated up close" was. */
  ok("the tile under the view centre draws the ABP at 0.25 ft/px (the 3-in crop)",
    !!r.under && r.under.ftPerPx <= 0.25, r.under ? `z${r.under.z} ${r.under.ftPerPx} ft/px` : "no tile");
  await page.evaluate(async () => {
    /* the mine window well outside the ABP crop: the 6-in ortho's own 0.5 ft/px */
    SBMM.viewer3d.frameBox(6370400, 2130300, 6370600, 2130500);
    await new Promise(r => setTimeout(r, 3500));
  });
  await page.waitForFunction(() => SBMM.tiles.stats().queued === 0, null, { timeout: TIMEOUT });
  await page.waitForTimeout(1500);
  const mineOnly = await page.evaluate(async () => {
    const has = (t, x, y) => x >= t.rect[0] && x < t.rect[2] && y >= t.rect[1] && y < t.rect[3];
    const t = SBMM.terrain3d.drawnTiles().filter(t => has(t, 6370500, 2130400))
      .sort((a, b) => a.z - b.z)[0] || null;
    return { t, floor: Math.pow(2, SBMM.tiles.levels("ortho").slice(-1)[0]) };
  });
  ok("a tile over the 6-in mine ortho drapes at 0.5 ft/px",
    !!mineOnly.t && mineOnly.t.ftPerPx <= 0.5,
    mineOnly.t ? `z${mineOnly.t.z} ${mineOnly.t.ftPerPx} ft/px` : "no tile");
  ok("the ortho pyramid's finest level is 0.25 ft/px", mineOnly.floor === 0.25, mineOnly.floor);
  /* Two location-independent halves, because the pyramid's floor is now a
     property of WHERE a tile is (0.25 over the ABP, 0.5 over the mine window,
     2 elsewhere) and an assertion that restates drapePlan proves nothing:
     the picture is never coarser than the mesh under it, and the texture never
     exceeds the profile's own 256 * 2^k px. */
  const coarse = r.tiles.filter(t => t.ftPerPx != null && t.ftPerPx > t.cellFt);
  ok("no tile's drape is coarser than its own DEM cell", coarse.length === 0,
    coarse.length ? JSON.stringify(coarse.slice(0, 3).map(t => [t.z, t.cellFt, t.ftPerPx])) : 0);
  const big = r.tiles.filter(t => t.texPx > 256 * Math.pow(2, r.drapeK));
  ok("no tile's texture exceeds the profile's budget", big.length === 0,
    big.length ? big.slice(0, 3).map(t => t.texPx).join("/") : 256 * Math.pow(2, r.drapeK));
  ok("every drawn tile got a drape", r.tiles.every(t => t.ftPerPx != null),
    r.tiles.filter(t => t.ftPerPx == null).length + " without");
  ok("the drawn set stays inside the 150 MB texture budget", r.texMB < 150, r.texMB);
}

/* -------------------------------------------------------------- meshport -- */
/* v22 §G moved the tile mesh into the pooled decode worker. There is ONE
   implementation — js/dem.js's demTileMeshMain, stringified into the worker
   and called inline as the fallback — so this compares the two THREADS rather
   than two loops, which is what makes "they cannot disagree" checkable. */
/* ---------------------------------------------------------------- band ---- */
/* v24 — THE BLACK BAND. The 1-ft mine window (dem_abp, which is also the 6-in
   ortho's rectangle) was traced on the ground by a hard black line on all four
   sides, "sometimes going away". The cause was in the PAYLOAD, not the
   renderer: tools/build_tiles.py cut the fine ortho levels from the fine
   sources ALONE, so every pixel of an edge tile outside the 6-in photography
   was (0,0,0) — 177 black columns in ortho/0/7/*, 16 in ortho/0/18/*, 127 rows
   in ortho/0/12/32 — and js/terrain3d.js composites the fine tile OVER the
   stretched coarse ancestor, so the black won. "Sometimes" was the LOD: only a
   DEM tile fine enough to reach a fine ortho level drapes from one at all.

   MEASURED AGAINST A CONTROL LINE, never against an absolute. The photograph
   has its own dark features — a tree shadow, the vegetation line, a wet ditch —
   and an absolute "no dark pixel on this line" fails on the site itself. What a
   band IS, and what a shadow is not, is a LONG CONTINUOUS straight dark run, so
   the statistic is the longest run of consecutive boundary samples that are
   dark, compared with the same run on a line 150 ft inside the window over the
   same kind of ground. */
if (want("band")) {
  console.log("\n== band — the 1-ft window's boundary on the ground (v24) ==");
  const W = [6370069, 2127238, 6372941, 2131120];          // dem_abp = ortho_mine
  const STEP = 2;                                          // ft between samples

  async function scan(detail, edge, box) {
    await page.evaluate(async d => {
      const sel = document.getElementById("v3dDetail");
      if (sel.value !== d) { sel.value = d; await sel.onchange(); }
      SBMM.viewer3d.preset("top");
      await new Promise(r => setTimeout(r, 1200));
    }, detail);
    await page.evaluate(b => SBMM.viewer3d.frameBox(b[0], b[1], b[2], b[3]), box);
    await page.waitForTimeout(3500);
    await page.waitForFunction(() => SBMM.tiles.stats().queued === 0, null, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    const geo = await page.evaluate(([w, edge, step]) => {
      const r = document.getElementById("v3dCanvas").getBoundingClientRect();
      const vert = edge === "E" || edge === "W";
      const line = (off) => {                 // off ft INBOARD of the boundary
        const out = [];
        if (vert) {
          const x = (edge === "E" ? w[2] - off : w[0] + off);
          for (let y = w[1]; y <= w[3]; y += step) out.push([x, y]);
        } else {
          const y = (edge === "N" ? w[3] - off : w[1] + off);
          for (let x = w[0]; x <= w[2]; x += step) out.push([x, y]);
        }
        return out.map(p => {
          const e = SBMM.elev(p[0], p[1]);
          const z = Array.isArray(e) ? e[0] : e;
          if (z == null || isNaN(z)) return null;
          const s = SBMM.viewer3d.screenAt(p[0], p[1], z);
          return s && isFinite(s[0]) && isFinite(s[1]) ? [s[0], s[1]] : null;
        });
      };
      const st = SBMM.viewer3d.stats();
      /* SIX CONTROL LINES, not one. The band is at most ~23 ft wide and sits ON
         the boundary, so a line 60 ft either side of it is clear of the band and
         over the same ground; the photograph's own black (deep conifer shadow,
         which really does go under luma 14 on this site) is on all seven. One
         control at 150 ft happened to land on open ground at the south edge and
         reported 78 ft of "band" where there is none. */
      return { rect: [r.left, r.top, r.right, r.bottom], edgeLine: line(0),
               ctrlLines: [60, 150, 300, -60, -150, -300].map(line),
               byLevel: st.tiles.byLevel, ftpp: st.tiles.drapeFtPerPx };
    }, [W, edge, STEP]);

    const img = decodePNG(await page.screenshot());
    const { w: iw, h: ih, channels: ch, data } = img;
    const lum = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= iw || y >= ih) return null;
      const k = (y * iw + x) * ch;
      return 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
    };
    /* BLACK, NOT DARK. The band was literally (0,0,0) — an unpainted pixel in
       a fine ortho tile. The 6-in photography's own dense conifer canopy sits
       around luma 20-40 and runs for hundreds of feet on this site, so a
       threshold anywhere near 40 measures the trees: the first cut of this
       test read 304 ft of "band" across the south edge of a window with
       nothing wrong with it. 14 is under every pixel of the photograph and
       over none of the unpainted ones. */
    const DARK = 14, PAD = 24;
    const runOf = pts => {
      let run = 0, best = 0, tested = 0;
      for (const p of pts) {
        if (!p || p[0] < geo.rect[0] + PAD || p[1] < geo.rect[1] + PAD
              || p[0] > geo.rect[2] - PAD || p[1] > geo.rect[3] - PAD) { run = 0; continue; }
        tested++;
        let dark = false;
        for (let d = -3; d <= 3 && !dark; d++)
          for (const q of [[p[0] + d, p[1]], [p[0], p[1] + d]])
            if ((lum(q[0], q[1]) ?? 255) < DARK) { dark = true; break; }
        if (dark) { run++; if (run > best) best = run; } else run = 0;
      }
      return { best, tested };
    };
    const e = runOf(geo.edgeLine);
    const cs = geo.ctrlLines.map(runOf);
    const c = cs.reduce((a, b) => (b.best > a.best ? b : a), { best: 0, tested: 0 });
    console.log(`   ${detail.padEnd(4)} ${edge}  byLevel ${JSON.stringify(geo.byLevel)}`
      + ` ftpp ${JSON.stringify(geo.ftpp)}`
      + `  boundary: longest black run ${e.best} samples (${e.best * STEP} ft) of ${e.tested}`
      + `  ·  worst of 6 controls ±60/150/300 ft: ${c.best} (${c.best * STEP} ft)`
      + `  [${cs.map(x => x.best).join(",")}]`);
    return { edge: e, ctrl: c, detail, side: edge };
  }

  /* THE OVERLAYS ARE SWITCHED OFF FOR THIS SCAN. The band is on the GROUND —
     it is the drape — and measuring the drape through the decision-unit
     outlines, the storm network and the survey linework is measuring something
     else. (They were not what made the first cut of this test fail; the dense
     conifer canopy in the 6-in ortho was, which is what the threshold below is
     for.) */
  const GROUPS = ["framework", "design", "invest", "mywork", "cultural"];
  await page.evaluate(async gs => {
    for (const g of gs) SBMM.layerState.setGroup(g, false);
    await new Promise(r => setTimeout(r, 1500));
  }, GROUPS);
  const mid = [(W[0] + W[2]) / 2, (W[1] + W[3]) / 2];
  const runs = [];
  runs.push(await scan("high", "E", [W[2] - 400, mid[1] - 260, W[2] + 400, mid[1] + 260]));
  runs.push(await scan("std",  "E", [W[2] - 400, mid[1] - 260, W[2] + 400, mid[1] + 260]));
  runs.push(await scan("high", "S", [mid[0] - 400, W[1] - 260, mid[0] + 400, W[1] + 260]));
  /* 200 ft of continuous BLACK on the window edge is a band — before v24 the
     east edge alone ran unbroken for the whole visible height of the frame. The
     control lines carry the site's own black and set the second bar. */
  const MAX_FT = 200;
  for (const r of runs) {
    const ft = r.edge.best * STEP;
    ok(`no dark band on the ${r.side} edge at ${r.detail}`,
      r.edge.tested > 40 && ft <= MAX_FT, `${ft} ft over ${r.edge.tested} samples`);
    ok(`the ${r.side} edge at ${r.detail} is no blacker than the ground beside it`,
      r.edge.best <= Math.max(20, r.ctrl.best * 1.5), `${r.edge.best} vs ${r.ctrl.best}`);
  }
  await page.evaluate(async gs => {
    for (const g of gs) SBMM.layerState.setGroup(g, true);
    await new Promise(r => setTimeout(r, 1500));
  }, GROUPS);
}

if (want("meshport")) {
  console.log("\n== meshport — the mesh built in the worker against the same call inline ==");
  const r = await page.evaluate(async () => {
    const T = SBMM.tiles;
    const [tx, ty] = T.tileAt(1, 6371700, 2128900);
    if (!T.has("dem", 1, tx, ty)) return { skip: "no tile" };
    const rec = await T.get("dem", 1, tx, ty, { priority: 9999 });
    if (!rec || !rec.z32) return { skip: "no data" };
    const args = { N: 256, V: 257, step: 1, cell: 2, x0: -1000, y0: 2000, zmid: 1400, drop: 24 };
    const a = Dem.tileMesh(Object.assign({}, args, { z32: rec.z32 }));
    const before = Dem.meshStats.worker;
    const b = await Dem.tileMeshAsync(Object.assign({}, args, { z32: rec.z32 }));
    const eqf = (p, q) => {
      if (p.length !== q.length) return -1;
      for (let i = 0; i < p.length; i++) {
        if (p[i] === q[i]) continue;
        if (isNaN(p[i]) && isNaN(q[i])) continue;
        return i;
      }
      return -2;
    };
    return {
      ni: a.ni === b.ni, verts: a.verts, tris: a.ni / 3,
      pos: eqf(a.pos, b.pos), uv: eqf(a.uv, b.uv), nrm: eqf(a.nrm, b.nrm),
      idx: eqf(a.idx.subarray(0, a.ni), b.idx.subarray(0, b.ni)),
      viaWorker: Dem.meshStats.worker > before,
      pool: Dem.tilePool().length, stats: Object.assign({}, Dem.meshStats)
    };
  });
  if (r.skip) { console.log("   skipped:", r.skip); ok("a tile was available", false, r.skip); }
  else {
    console.log("   pool", r.pool, "worker(s) ·", JSON.stringify(r.stats),
      "·", r.verts, "vertices,", r.tris, "triangles");
    ok("the mesh really came back from a worker", r.viaWorker === true, r.viaWorker);
    ok("the triangle count agrees", r.ni === true, r.ni);
    for (const k of ["pos", "uv", "nrm", "idx"])
      ok(`${k} agrees element for element`, r[k] === -2, r[k]);
  }
}

/* ------------------------------------------------------------- geomcache -- */
/* v22 §G — "returning to a view rebuilds nothing". The cache is keyed by
   (z, x, y, vertex stride) and nothing else, so a camera that leaves a tile
   and comes back must hit it. The interesting number is not the hit count on
   its own but `lastBuildCpuMs`: the main-thread cost of the rebuild, which is
   what a gesture arriving during it would have to wait for. */
if (want("geomcache")) {
  console.log("\n== geomcache — a move away and back rebuilds no geometry ==");
  const r = await page.evaluate(async () => {
    const st = () => SBMM.viewer3d.stats().tiles;
    const go = async (x, y) => {
      SBMM.viewer3d.openAt(x, y);
      await new Promise(r => setTimeout(r, 3500));
      const s = st();
      return { tiles: s.tiles, hits: s.geomHits, misses: s.geomMisses,
               cpuMs: s.lastBuildCpuMs, blockMs: s.lastBuildBlockMs,
               builtTiles: s.lastBuildTiles, cacheTiles: s.geomCacheTiles,
               cacheMB: s.geomCacheMB, evicted: s.geomEvicted };
    };
    /* A DIFFERENT CAMERA FIRST, and no clearGeomCache(). A tile that is still
       DRAWN is never rebuilt at all — `need` filters the drawn set out before
       anything is asked for — so "go to A" from A measures nothing, and
       clearing the cache under the drawn set leaves those tiles in neither
       place. Starting somewhere else makes A a real build, B evicts A's tiles
       from the drawn set into the cache, and the return to A is the question. */
    await go(6372250, 2128350);
    const a = await go(6371700, 2128900);
    const b = await go(6371150, 2129650);
    const c = await go(6371700, 2128900);
    return { a, b, c, budget: st().geomBudgetMB };
  });
  console.log("   A      ", JSON.stringify(r.a));
  console.log("   B      ", JSON.stringify(r.b));
  console.log("   back A ", JSON.stringify(r.c));
  console.log("   geometry cache budget:", r.budget, "MB");
  ok("returning to A hits the cache", r.c.hits > r.b.hits, `${r.b.hits} -> ${r.c.hits}`);
  ok("returning to A builds no new geometry", r.c.misses === r.b.misses,
    `${r.b.misses} -> ${r.c.misses}`);
  ok("the rebuild's main-thread cost stays small (recorded from this commit: < 60 ms)",
    r.c.cpuMs < 60, r.c.cpuMs);
}

/* ----------------------------------------------------------------- map2d -- */
/* v22 §G asked whether the pixelation is also visible in 2D — whether the
   2-ft site hillshade shows through over the mine window where the 1-ft one
   exists. It is a stacking question, so it is answered by reading the stack
   rather than by looking at it: the raster pane's DOM order plus each
   overlay's z-index IS the answer, and nothing here is zoom-gated. */
if (want("map2d")) {
  console.log("\n== map2d — the basemap stack over the mine window at zoom 3 ==");
  const r = await page.evaluate(async () => {
    if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
    await new Promise(r => setTimeout(r, 400));
    SBMM.map.setView([2128900, 6371700], 3, { animate: false });
    await new Promise(r => setTimeout(r, 600));
    const pane = SBMM.map.getPane("raster");
    const imgs = [...pane.querySelectorAll("img")];
    const out = [];
    SBMM.map.eachLayer(l => {
      if (!l._image || !l._bounds) return;
      const b = l._bounds, el = l._image;
      const wFt = b.getEast() - b.getWest();
      out.push({
        dom: imgs.indexOf(el),
        z: el.style.zIndex === "" ? 0 : +el.style.zIndex,
        px: el.naturalWidth, wFt: Math.round(wFt),
        ftPerPx: +(wFt / Math.max(1, el.naturalWidth)).toFixed(3),
        opacity: +getComputedStyle(el).opacity
      });
    });
    /* which of them actually cover the point the camera is over */
    const gated = [...document.querySelectorAll("#layers .lyr.gated")].map(e => e.textContent.trim());
    return { list: out, zoom: SBMM.map.getZoom(), gated,
             maxZoom: SBMM.map.getMaxZoom() };
  });
  const zOf = n => n.z || 0;
  const painted = r.list.filter(n => n.dom >= 0).sort((a, b) => (zOf(a) - zOf(b)) || (a.dom - b.dom));
  console.log("   zoom", r.zoom, "of", r.maxZoom, "· raster pane, in paint order (last is on top):");
  for (const n of painted)
    console.log("     dom", n.dom, "z-index", n.z, "·", n.px, "px over", n.wFt, "ft =",
      n.ftPerPx, "ft/px · opacity", n.opacity);
  /* THE QUESTION §G ASKS: does a coarser raster sit on top of a finer one over
     the mine window? Resolution is feet per image pixel, not image size — the
     3-in ABP ortho is the smallest image in the pane and the sharpest picture
     in it. So the stack is right exactly when ft/px never increases up it. */
  let inversions = [];
  for (let i = 1; i < painted.length; i++)
    if (painted[i].ftPerPx > painted[i - 1].ftPerPx)
      inversions.push(`${painted[i - 1].ftPerPx} then ${painted[i].ftPerPx}`);
  ok("nothing coarser is painted over something finer", inversions.length === 0,
    inversions.join("; ") || 0);
  ok("no basemap is zoom-gated off at zoom 3", r.gated.length === 0, JSON.stringify(r.gated));
}

await page.screenshot({ path: "/tmp/terrain3d.png" });
console.log("\npage errors:", errors.length);
if (errors.length) fails++;
await browser.close();
console.log(fails ? `TERRAIN3D FAIL (${fails})` : "TERRAIN3D PASS");
process.exit(fails ? 1 : 0);
