/* Password-gate shots (not pass/fail — look at them).

   Two pictures:
     shots/gate.png         the locked screen: the living contour field, the card
     shots/gate_unlock.png  mid-unlock: the flood up, the land surfacing through it

   The second one is a timed grab of a 1.38 s animation, so it is a sample, not a
   frame-accurate capture — the console line says how far into the animation the
   shot was taken and whether the gate was still there when it fired.

   Run it AFTER the e2e (never beside it): both drive a browser and two of those
   on a two-core box crash the compositor.

     node test/gate_shots.mjs /abs/path/index.html [outdir]                     */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res } from "node:path";
import { existsSync as __ex } from "node:fs";
import { gatePassword } from "./gate.mjs";

const target = process.argv[2] || "/home/user/SBM/index.html";
const out = process.argv[3] || "/home/user/SBM/test/shots";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("PAGEERROR", e.message));

/* no unlock token on purpose — this harness is the one that meets the gate */
await page.goto(__furl(__res(target)).href);
await page.waitForSelector("#gate", { timeout: 60000 });
await page.waitForTimeout(2600);                       /* let the field drift a little */
await page.screenshot({ path: out + "/gate.png" });
console.log("shot gate.png");

/* let the app finish booting so there is something real behind the reveal */
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
await page.waitForTimeout(800);

await page.fill("#gatePw", gatePassword());
const t0 = Date.now();
await page.keyboard.press("Enter");
/* Nothing between the wait and the shutter: an evaluate() round trip in here was
   enough to push the capture past the end of the 1380 ms animation and photograph
   the app instead. Aim early: waitForTimeout overshoots by 400-500 ms on a busy software-GL
   page, and the console line below says where the shutter actually fell. */
await page.waitForTimeout(600);
const at = Date.now() - t0;
await page.screenshot({ path: out + "/gate_unlock.png" });
console.log("shot gate_unlock.png  shutter at ~" + at + " ms into the 1380 ms animation"
          + " (flood 60-820 ms, reveal 720-1380 ms)");

await page.waitForFunction(() => !document.getElementById("gate"), null, { timeout: 5000 });
await page.waitForTimeout(500);
await browser.close();
