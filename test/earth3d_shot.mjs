/* Screenshot of a design surface draped in the 3D view. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { existsSync as __ex } from "node:fs";
import { unlock } from "./gate.mjs";
const target = process.argv[2] || "/home/claude/repo/index.html";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("ERR", e.message));
await unlock(page);  /* the password gate — see test/gate.mjs */
await page.goto("file://" + target);
await page.waitForSelector("#loading", { state: "hidden", timeout: 60000 });
const BOX = [[6371400, 2128700], [6371700, 2128700], [6371700, 2129000], [6371400, 2129000]];
const info = await page.evaluate(async (BOX) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const st = SBMM.design.rimStats(BOX);
  const f = SBMM.design.mkSurface(BOX.map(p => p.slice()), "Staging Pad A",
    { kind: "pad", padZ: +(st.mean - 4).toFixed(2), ratio: 3, side: "out" });
  for (let i = 0; i < 400 && !f._surf; i++) await wait(100);
  SBMM.store.select(f.id);
  await SBMM.viewer3d.openAt(6371550, 2128850);
  await wait(5000);
  SBMM.viewer3d.frame();
  await wait(4000);
  const cam = SBMM.viewer3d.cameraWorld();
  const meshes = [];
  return { padZ: f.props.padZ, sceneObjects: SBMM.viewer3d.stats().sceneObjects,
           cam: { x: Math.round(cam.x), y: Math.round(cam.y), z: Math.round(cam.z) },
           open: SBMM.viewer3d.isOpen(), sel: SBMM.store.selected };
}, BOX);
console.log("3D:", JSON.stringify(info));
/* render-on-demand means the canvas can hold a stale frame at capture time —
   nudge the camera so a fresh draw is issued, then let it settle */
await page.evaluate(() => { SBMM.viewer3d.requestRender(); });
await page.waitForTimeout(3000);
await page.mouse.move(660, 450);
await page.mouse.wheel(0, -120);
await page.waitForTimeout(4000);
await page.evaluate(() => { SBMM.viewer3d.requestRender(); });
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/shot_pad_3d.png" });
console.log("shot: /tmp/shot_pad_3d.png");
await browser.close();
