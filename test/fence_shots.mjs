/* v23 Phase B — the three fence shots.

   fence_2d   the drawing in the log window's Fence tab
   fence_map  the cut on the map: the alignment, its swath and the projected holes
   fence_3d   the strip standing in the scene

   NOT pass/fail. They are the check the numbers cannot make: a fence whose
   columns do not hang from the ground line, or whose horizons do not join the
   holes they name, is wrong however well its stations check out.

   Run it AFTER the e2e, never beside it: both drive a software-GL renderer and
   two of those on a two-core box crash the compositor.

   Both defaults are resolved from THIS FILE's own location, never from a
   hard-coded repo path — in an agent worktree a constant opens the planner's
   index.html and writes the pictures into the planner's tree (CLAUDE.md). */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { unlock } from "./gate.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const target = process.argv[2] || resolve(HERE, "..", "index.html");
const out = process.argv[3] || resolve(HERE, "shots");
mkdirSync(out, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);
await page.goto(pathToFileURL(target).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  await page.evaluate(() => {
    const t = document.getElementById("toast"); if (t) t.classList.remove("show");
    document.querySelectorAll(".restorebar").forEach(b => b.remove());
  });
  await wait(300);
  await page.screenshot({ path: resolve(out, n + ".png") });
  console.log("shot", n);
};

/* a fence from SB-9 to SB-10 at a 120-ft swath: a readable handful of holes
   rather than every boring in the north pile stacked on one station */
const made = await page.evaluate(() => {
  SBMM.cmd.open(false);
  const B = SBMM.borelogs;
  const a = B.byId("SB-9"), b = B.byId("SB-10");
  const f = SBMM.fence.mkFence([[a.x, a.y], [b.x, b.y]], "Fence — SB-9 to SB-10",
    { swath_ft: 120, ve: 2 });
  SBMM.store.select(f.id);
  SBMM.fence.setCurrent(f.id);
  SBMM.tools.zoomTo(f);
  return SBMM.fence.stateOf(f);
});
console.log("fence:", JSON.stringify(made));
await wait(900);
await shot("fence_map");

await page.evaluate(() => { SBMM.borewin.open(null, { tab: "fence" }); });
await wait(1200);
await shot("fence_2d");

await page.evaluate(() => { SBMM.borewin.close(); });
await wait(400);
/* THE STRIP IS UNDERGROUND BY DESIGN — its top edge IS the lidar surface, so
   from straight above the terrain draws over all of it and the picture is of
   nothing. The camera has to come down to a low oblique looking INTO the pit,
   and it has to get there through REAL pointer events: the nav rig eases
   towards a destination and only asks for frames while it is being driven, so
   a programmatic nav.place moves the camera and never repaints. */
await page.evaluate(() => {
  const f = SBMM.fence.currentFence();
  const c = f.pts.reduce((a, p) => [a[0] + p[0] / f.pts.length, a[1] + p[1] / f.pts.length], [0, 0]);
  SBMM.store.select(f.id);
  SBMM.viewer3d.openAt(c[0], c[1]);
});
await wait(7000);
{
  const box = await page.locator("#v3dCanvas").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  /* orbit down to a shallow elevation */
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(cx, cy - i * 20, { steps: 2 }); await wait(120); }
  await page.mouse.up();
  await wait(2500);
  /* and in, until the 463-ft cut fills the frame */
  for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, -220); await wait(320); }
  await wait(5000);
}
console.log("3D:", JSON.stringify(await page.evaluate(() => {
  const s = SBMM.viewer3d.stats();
  return { drawn: s.layersDrawn ? Object.keys(s.layersDrawn).filter(k => /mywork/.test(k)) : [],
           cam: SBMM.viewer3d.cameraWorld() };
})));
await shot("fence_3d");

await browser.close();
