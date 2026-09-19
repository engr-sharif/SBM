/* v24 — ZERO TEXT OVERLAPS IN THE BORING-LOG WINDOW, PROVEN.

   The engineer: "something about it seems unfinished, some text are
   overlapping others". A log sheet whose sample reference crosses into the pH
   column is not a log sheet, and the only way to know it never happens is to
   measure every glyph box of every hole at every width the window is read at.

   This sweep does that:

     * every one of the 44 holes, Log tab, at three widths (560 / 900 / 1240),
       rendered OFF-SCREEN through SBMM.borewin.logSvg() — the same builder the
       tab paints, so this measures what ships, and 132 renders cost seconds
       rather than the minutes 132 window repaints would;
     * six Compare sets — pairs and quads across waste areas, SB-10 (the
       deepest) and SB-7 (the two-flag hole) included — painted in the real
       window, because a compare's scale is fitted to the window's own height;
     * the Fence tab's drawing, because the fence is drawn by the same column
       renderer at the stick tier.

   A pair counts as an overlap when their client rectangles intersect by more
   than HALF A PIXEL on BOTH axes. Excluded, and only these: a text inside a
   <title> (never rendered) and a HALO TWIN — the same string at the same spot,
   which is how a stroked outline is drawn when paint-order is not available.

   Not a screenshot test and not a diff: it prints the offenders as
   `hole · width · "textA" × "textB"` and exits non-zero if there are any.

   Both defaults resolve from THIS FILE's own location (CLAUDE.md): a constant
   repo path opens the planner's index.html from an agent worktree.           */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { unlock } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
/* positional arguments, with the flags (--wait) filtered out */
const pos = process.argv.slice(2).filter(a => !a.startsWith("--"));
const target = pos[0] || resolve(HERE, "..", "index.html");
const WIDTHS = (pos[1] || "560,900,1240").split(",").map(Number);

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
page.setDefaultTimeout(TIMEOUT);
const errors = [];
page.on("pageerror", e => { errors.push(e.message); console.log("PAGEERROR", e.message); });
await unlock(page);
await page.goto(pathToFileURL(target).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });

/* the measuring apparatus, installed once in the page */
await page.evaluate(() => {
  const host = document.createElement("div");
  host.id = "ovhost";
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:2000px;visibility:visible;"
    + "font-family:'SF Mono',ui-monospace,Consolas,Menlo,monospace";
  document.body.appendChild(host);
  window.__ov = {
    /* every rendered <text>, as a client rectangle plus its string */
    boxes(root) {
      const out = [];
      for (const t of root.querySelectorAll("text")) {
        if (t.closest("title, defs")) continue;
        const s = (t.textContent || "").trim();
        if (!s) continue;
        const r = t.getBoundingClientRect();
        if (r.width < 0.2 || r.height < 0.2) continue;
        out.push({ s, x: r.left, y: r.top, w: r.width, h: r.height });
      }
      return out;
    },
    /* an overlap is more than half a pixel on BOTH axes. A halo twin — the
       same string at the same place — is the one deliberate duplicate. */
    pairs(bx) {
      const bad = [];
      for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++) {
        const a = bx[i], b = bx[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 0.5 || oy <= 0.5) continue;
        if (a.s === b.s && Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5) continue;
        bad.push({ a: a.s, b: b.s, ox: +ox.toFixed(1), oy: +oy.toFixed(1),
                   at: `${Math.round(a.x)},${Math.round(a.y)}` });
      }
      return bad;
    },
    measureSvg(svg) {
      const host = document.getElementById("ovhost");
      host.innerHTML = svg;
      const bad = window.__ov.pairs(window.__ov.boxes(host));
      host.innerHTML = "";
      return bad;
    }
  };
});

const pay = await page.evaluate(() => ({
  ids: SBMM.borelogs.ids(),
  areas: [...SBMM.borelogs.areas()].map(([a, ids]) => [a, ids])
}));
console.log(`${pay.ids.length} holes · widths ${WIDTHS.join(", ")}`);

let total = 0;
const perWidth = new Map(WIDTHS.map(w => [w, 0]));
const show = [];

/* ---- every hole, every width, the Log tab ---- */
for (const w of WIDTHS) {
  for (const id of pay.ids) {
    const bad = await page.evaluate(([id, w]) => {
      const d = SBMM.borewin.logSvg(id, w);
      if (!d) return [{ a: "no drawing", b: id, ox: 0, oy: 0, at: "" }];
      return window.__ov.measureSvg(d.svg);
    }, [id, w]);
    if (bad.length) {
      total += bad.length;
      perWidth.set(w, perWidth.get(w) + bad.length);
      for (const p of bad) show.push(`${id} · ${w} · "${p.a}" × "${p.b}"  (${p.ox}×${p.oy} px at ${p.at})`);
    }
  }
  console.log(`  width ${w}: ${perWidth.get(w)} overlapping pairs`);
}

/* ---- six Compare sets, in the real window (a compare fits its own scale) ---- */
const SETS = (() => {
  const byArea = pay.areas.filter(([, ids]) => ids.length >= 2);
  const s = [["SB-9", "SB-10"], ["SB-7", "SB-9"],
             ["SB-9", "SB-10", "SB-7", "SB-8"]];
  for (const [, ids] of byArea.slice(0, 2)) s.push(ids.slice(0, 4));
  s.push(pay.ids.slice(0, 4));
  return s.slice(0, 6);
})();
await page.evaluate(() => { SBMM.borewin.open("SB-9"); });
await page.waitForTimeout(400);
let cmpBad = 0;
for (const set of SETS) {
  const bad = await page.evaluate(ids => {
    SBMM.borewin.compare(ids);
    const svg = document.querySelector(".blwin svg.bwcmp");
    return svg ? window.__ov.pairs(window.__ov.boxes(svg)) : [];
  }, set);
  if (bad.length) {
    cmpBad += bad.length;
    for (const p of bad) show.push(`compare ${set.join("+")} · "${p.a}" × "${p.b}"  (${p.ox}×${p.oy} px)`);
  }
}
console.log(`  compare (${SETS.length} sets): ${cmpBad} overlapping pairs`);
total += cmpBad;

/* ---- the fence, drawn by the same column renderer at the stick tier ---- */
const fnBad = await page.evaluate(() => {
  const B = SBMM.borelogs;
  const a = B.byId("SB-9"), b = B.byId("SB-10");
  const f = SBMM.fence.mkFence([[a.x, a.y], [b.x, b.y]], "overlap probe", { swath_ft: 260, ve: 2 });
  const out = {};
  for (const w of [560, 900, 1240]) {
    const d = SBMM.fence.drawSvg(f, { w });
    out[w] = d ? window.__ov.measureSvg(d.svg) : [];
  }
  SBMM.store.remove(f);
  return out;
});
let fnCount = 0;
for (const [w, bad] of Object.entries(fnBad)) {
  fnCount += bad.length;
  for (const p of bad) show.push(`fence · ${w} · "${p.a}" × "${p.b}"  (${p.ox}×${p.oy} px)`);
}
console.log(`  fence (3 widths): ${fnCount} overlapping pairs`);
total += fnCount;

if (show.length) {
  console.log(`\n${show.length} offending pairs:`);
  for (const s of show.slice(0, 120)) console.log("  " + s);
  if (show.length > 120) console.log(`  … and ${show.length - 120} more`);
}
console.log(`\nTOTAL overlapping text pairs: ${total}`);
if (errors.length) console.log(`page errors: ${errors.length}`);
await browser.close();
if (total || errors.length) { console.log("FAIL: the drawing overlaps its own text"); process.exit(1); }
console.log("PASS: no overlapping text in any hole, width, compare or fence");
