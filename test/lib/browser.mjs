/* One launcher for every browser harness (v18 §2).
   ------------------------------------------------------------------------
   Before this file, 37 harnesses each carried their own copy of the CHROME_BIN
   line and their own 180 s timeout. The logic is here now, once:

     import { launch, TIMEOUT, device } from "./lib/browser.mjs";
     const browser = await launch();                    // desktop
     const browser = await launch({ device: "Pixel 7" });
     page.setDefaultTimeout(TIMEOUT);

   What it does, in order:

   * takes a BROWSER SLOT (test/lib/lock.mjs) unless the runner already took
     one for this step (SBMM_LOCK_TOKEN in the environment). Two software-GL
     renderers on a two-core box crash the compositor; the lock is what stops
     an agent starting a second Chromium by accident. browser.close() gives
     the slot back, and so does process exit.
   * picks the executable: CHROME_BIN, else the cloud build box's own
     /opt/pw-browsers/chromium-1194 if it is there, else Playwright's chromium.
   * SBMM_GPU=1 — drop the software-GL default and ask for the real GPU
     (--use-gl=angle --use-angle=default|d3d11 --ignore-gpu-blocklist
     --enable-gpu-rasterization). The point of the switch is that the timeouts
     can then drop: TIMEOUT is 180 s under software GL and 60 s with the GPU.
   * SBMM_HEADED=1 — open a window. Headless stays the default.
   * prints ONE line per process saying which path ran, with the renderer
     string out of WEBGL_debug_renderer_info. Every line this file prints is
     prefixed `[browser]` so a log diff can drop them.

   It does NOT change any harness's assertions, viewport or descriptor.
   ------------------------------------------------------------------------ */
import { chromium, devices } from "playwright";
import { existsSync } from "node:fs";
import { acquire } from "./lock.mjs";

const BOX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export const GPU = process.env.SBMM_GPU === "1";
export const HEADED = process.env.SBMM_HEADED === "1";
/* 180 s is deliberate under software GL (a 1.56 M-vertex mesh can hold the main
   thread past Playwright's 30 s default); with a real GPU 60 s is plenty. */
export const TIMEOUT = GPU ? 60000 : 180000;

export function executablePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  return existsSync(BOX_CHROME) ? BOX_CHROME : undefined;   // undefined = Playwright's own
}

export function gpuArgs() {
  if (!GPU) return [];
  const angle = process.platform === "win32" ? "--use-angle=d3d11" : "--use-angle=default";
  return ["--use-gl=angle", angle, "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];
}

/* A Playwright device descriptor by name, with defaultBrowserType removed:
   these harnesses run chromium deliberately (WebKit is not installed here). */
export function device(name) {
  const d = devices[name];
  if (!d) throw new Error(`test/lib/browser.mjs: this Playwright has no \`${name}\` descriptor`);
  const out = { ...d, defaultBrowserType: undefined };
  delete out.defaultBrowserType;
  return out;
}

let announced = false;
async function announce(browser) {
  if (announced) return;
  announced = true;
  let renderer = "unknown";
  try {
    const p = await browser.newPage();
    renderer = await p.evaluate(() => {
      try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
        if (!gl) return "no webgl";
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      } catch (e) { return "error: " + e.message; }
    });
    await p.close();
  } catch (e) { renderer = "unavailable (" + e.message.split("\n")[0] + ")"; }
  const asked = GPU ? "GPU requested" : "software GL (default)";
  const got = /swiftshader|llvmpipe|software/i.test(renderer) ? "software GL" : "hardware";
  console.log(`[browser] ${asked} — renderer: ${renderer} → ${got}`
            + (GPU && got === "software GL" ? " (SBMM_GPU=1 fell back: no GPU on this box)" : "")
            + ` | timeout ${TIMEOUT / 1000}s | ${HEADED ? "headed" : "headless"}`
            + ` | chromium: ${executablePath() || "playwright's own"}`);
}

/* launch({ name, device, args, ...playwrightLaunchOptions }) */
export async function launch(opts = {}) {
  const { name, device: dev, args = [], lock = true, ...rest } = opts;
  let slot = null;
  if (lock && !process.env.SBMM_LOCK_TOKEN) {
    try { slot = await acquire(name || process.argv[1].split("/").pop() || "harness"); }
    catch (e) {
      /* a refusal is a message, not a stack: the holder's name is the answer */
      console.log("[browser] " + e.message);
      process.exit(3);
    }
  }

  const browser = await chromium.launch({
    executablePath: executablePath(),
    headless: !HEADED,
    args: [...gpuArgs(), ...args],
    ...rest
  });
  await announce(browser);

  const close = browser.close.bind(browser);
  browser.close = async (...a) => { try { return await close(...a); } finally { if (slot) slot.release(); } };
  if (dev) browser.sbmmDevice = device(dev);
  return browser;
}

export default { launch, TIMEOUT, GPU, HEADED, device, executablePath, gpuArgs };
