/* v16 layer-tree shots (docs/V16_LAYERS_SPEC.md §3).

   Three pictures: the tree itself with a sub-group open and a row's hover
   toolbar showing, the same tree filtered by a search, and the legend card on
   the map. Not pass/fail — these are the pictures you look at before believing
   the rest of it.

   Run it AFTER the e2e (never beside it): both drive a software-GL renderer and
   two of those on a two-core box crash the compositor.

     node test/layers_shots.mjs /abs/path/index.html [/abs/out/dir]            */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res, dirname } from "node:path";
import { existsSync as __ex } from "node:fs";
import { fileURLToPath } from "node:url";
import { unlock } from "./gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const target = process.argv[2] || __res(HERE, "../index.html");
const out = process.argv[3] || __res(HERE, "shots");

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);
await page.goto(__furl(__res(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  await page.evaluate(() => { const t = document.getElementById("toast"); if (t) t.classList.remove("show"); });
  await wait(260);
  await page.screenshot({ path: out + "/" + n + ".png" });
  console.log("shot", n);
};

await page.evaluate(() => {
  const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  document.querySelectorAll(".restorebar").forEach(b => b.remove());
});

/* ---- 1. the tree: sub-groups, swatches, a hovered row with its toolbar ---- */
await page.evaluate(() => {
  /* open the storm sub-group so a real sub-group is in the picture */
  const sub = [...document.querySelectorAll("#layers .lgsub")]
    .find(s => /Storm drainage/.test(s.querySelector(".subh").textContent));
  if (sub && sub.classList.contains("closed")) sub.querySelector(".subtoggle").click();
});
await wait(400);
const rowBox = await page.evaluate(() => {
  const r = document.querySelector('#projLayers .lyr[data-lid="piles"]')
    || document.querySelector("#projLayers .lyr");
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { x: b.left + b.width * 0.55, y: b.top + b.height / 2 };
});
if (rowBox) { await page.mouse.move(rowBox.x, rowBox.y); await wait(350); }
await shot("layers_tree");

/* ---- 2. search ---- */
/* wrapped in a block that returns nothing: search() hands back the first match,
   which is a row ref holding DOM nodes, and Playwright cannot serialise that
   (the same trap as SBMM.sheets.open) */
await page.evaluate(() => { SBMM.layerTree.search("storm"); });
await page.focus("#ltSearch");
await wait(500);
await shot("layers_search");
await page.evaluate(() => { SBMM.layerTree.search(""); });

/* ---- 3. the legend card on the map ---- */
await page.evaluate(() => {
  SBMM.layerState.set("framework", "storm_nodes", { on: true });
  SBMM.layerTree.legend.toggle(true);
});
await wait(700);
await shot("layers_legend");

console.log("wrote layers_tree.png, layers_search.png, layers_legend.png to", out);
await browser.close();
