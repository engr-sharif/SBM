/* E2E — the TABLET profile and touch as an INPUT (docs/V17_TOUCH_SPEC.md §6).

   Playwright's `iPad Pro 11 landscape` descriptor (1194 x 834, DPR 2, touch)
   against the FOLDER build, served two ways:

     file://   everything except the offline copy, which cannot exist there
     http://   the manifest, the icons and the service worker, over a static
               server this file starts itself (node http + fs, no dependency)

   Chromium, not WebKit: WebKit is not installed on this box and installing it
   is out of scope. Chromium with the iPad descriptor emulates the touch input,
   the viewport and the DPR, which is what this harness is about; it is NOT a
   claim that Safari renders identically.

   WHY A SEPARATE FILE, like test/e2e_field.mjs before it: test/e2e.mjs is the
   proof that the DESKTOP is untouched, and it has to keep passing UNCHANGED on
   the folder build and the full dist. A build switch inside it would make that
   claim unfalsifiable. Same reasoning, same shape, same test/gate.mjs.

     node test/e2e_tablet.mjs /abs/path/index.html tablet

   Touches are dispatched through CDP `Input.dispatchTouchEvent`, not through
   synthesised PointerEvents: the recogniser depends on the real pointer stream
   (ids, capture, coalescing) and a hand-built event proves the handler runs,
   not that a finger reaches it. Pen events have no CDP equivalent, so the pen
   sections dispatch real `PointerEvent`s with `pointerType:"pen"` — which IS
   the stream the app sees from a Pencil, since Safari delivers exactly that.
*/
import { chromium, devices } from "playwright";
import { pathToFileURL as __furl } from "node:url";
import { resolve as __res, dirname, join, extname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { unlock, gatePassword } from "./gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = __res(HERE, "..");
const CHROME = process.env.CHROME_BIN
  || (existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
      ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

const target = process.argv[2] || __res(ROOT, "index.html");
const label = process.argv[3] || "tablet";
const SITE = dirname(__res(target));

const IPAD = devices["iPad Pro 11 landscape"];
if (!IPAD) { console.log("FAIL: this Playwright has no `iPad Pro 11 landscape` descriptor"); process.exit(1); }
/* the descriptor's defaultBrowserType is webkit; we run chromium deliberately */
const DEV = { ...IPAD, defaultBrowserType: undefined, isMobile: true, hasTouch: true };
delete DEV.defaultBrowserType;

const fail = (msg, extra) => {
  console.log("FAIL: " + msg, extra === undefined ? "" : JSON.stringify(extra));
  process.exit(1);
};
let warned = 0;
const warn = (msg, extra) => { warned++; console.log("  WARN " + msg, extra === undefined ? "" : JSON.stringify(extra)); };

console.log(`\n=== ${label} — ${DEV.viewport.width}x${DEV.viewport.height} @${DEV.deviceScaleFactor}, touch ===`);

/* ===================================================================== */
/* a static server, for the http half only                               */
/* ===================================================================== */
/* Deliberately tiny and deliberately local: the app itself never fetches
   anything (CLAUDE.md's first hard constraint), and the ONE exemption — sw.js —
   needs an origin to exist on. `patch` lets §6.6 rewrite one byte of the served
   index.html to prove the staleness check notices. */
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml"
};
let patchIndex = null;
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = join(SITE, p);
  if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try {
    let body;
    if (p === "/index.html" && patchIndex) body = Buffer.from(patchIndex);
    else { statSync(file); body = readFileSync(file); }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
      /* the service worker must be allowed to control the whole origin */
      "Service-Worker-Allowed": "/"
    });
    res.end(body);
  } catch (e) { res.writeHead(404).end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const HTTP = `http://127.0.0.1:${PORT}/index.html`;
console.log(`static server on ${HTTP}`);

/* ===================================================================== */
const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ...DEV });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
const wait = ms => page.waitForTimeout(ms);

await unlock(page);
const t0 = Date.now();
await page.goto(__furl(__res(target)).href);

await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 })
  .catch(async () => {
    const txt = await page.textContent("#loading");
    console.log("BOOT FAILED — loader says:", (txt || "").trim().slice(0, 300));
    process.exit(1);
  });
console.log(`boot: OK in ${((Date.now() - t0) / 1000).toFixed(2)} s`);

/* the toast recorder — a refusal that does not toast is the bug */
await page.evaluate(() => {
  window.__toasts = [];
  const el = document.getElementById("toast") || (() => { const t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); return t; })();
  new MutationObserver(() => { const s = el.textContent.trim(); if (s && window.__toasts[window.__toasts.length - 1] !== s) window.__toasts.push(s); })
    .observe(el, { childList: true, characterData: true, subtree: true });
});
const toasts = () => page.evaluate(() => window.__toasts.slice());
const clearToasts = () => page.evaluate(() => { window.__toasts.length = 0; });

/* CDP touch — the real pointer stream, ids and all */
const cdp = await page.context().newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", {
  type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id, radiusX: 6, radiusY: 6, force: 1 }))
});
const tap = async (x, y, ms = 60) => {
  await touch("touchStart", [{ x, y, id: 1 }]);
  await wait(ms);
  await touch("touchEnd", []);
};
const longPress = async (x, y) => {
  await touch("touchStart", [{ x, y, id: 1 }]);
  await wait(720);
  await touch("touchEnd", []);
};

/* A pen. CDP has no pen source, so these are real PointerEvents with
   pointerType "pen" — which is exactly the stream Safari delivers from a
   Pencil, `pressure` and all. Dispatched on the element under the point so
   capture-phase listeners on it and on document both see them. */
async function pen(kind, x, y, opts) {
  await page.evaluate(([kind, x, y, o]) => {
    const el = document.elementFromPoint(x, y) || document.body;
    const ev = new PointerEvent("pointer" + kind, {
      bubbles: true, cancelable: true, composed: true, view: window,
      pointerId: 99, pointerType: "pen", isPrimary: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: kind === "move" ? -1 : 0, buttons: (o && o.hover) ? 0 : (kind === "up" ? 0 : 1),
      pressure: (o && o.pressure != null) ? o.pressure : (kind === "up" ? 0 : 0.5)
    });
    el.dispatchEvent(ev);
  }, [kind, Math.round(x), Math.round(y), opts || null]);
}

/* ===================================================================== */
/* 1. boot                                                               */
/* ===================================================================== */
const boot = await page.evaluate(() => {
  const bar = document.getElementById("topbar");
  const btns = [...document.querySelectorAll("#topbar .toolbtn")]
    .filter(b => !b.hidden && b.offsetParent !== null)
    .map(b => ({ id: b.id || b.dataset.mode || b.textContent.trim().slice(0, 12),
                 h: Math.round(b.getBoundingClientRect().height) }));
  const cs = getComputedStyle(document.body);
  const stage = document.getElementById("stage").getBoundingClientRect();
  return {
    profile: SBMM.touch.profile(),
    touchClass: document.body.classList.contains("touch"),
    fieldClass: document.body.classList.contains("field"),
    capable: SBMM.touch.touchCapable(),
    dpr: window.devicePixelRatio,
    btns,
    minBtn: Math.min(...btns.map(b => b.h)),
    manifest: !!document.querySelector('link[rel="manifest"]'),
    appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
    metas: ["apple-mobile-web-app-capable", "apple-mobile-web-app-status-bar-style",
            "apple-mobile-web-app-title", "theme-color"]
      .map(n => !!document.querySelector(`meta[name="${n}"]`)),
    viewportMeta: (document.querySelector('meta[name="viewport"]') || {}).content || "",
    dvh: getComputedStyle(document.documentElement).height,
    stageH: Math.round(stage.height),
    cmdBtn: !!document.getElementById("cmdTopBtn"),
    fieldMenuBtn: !!document.getElementById("fieldMenuBtn"),
    navPad: document.querySelectorAll("#v3dNav [data-nav]").length,
    overscroll: cs.overscrollBehavior || cs.overscrollBehaviorY
  };
});
console.log(`profile ${boot.profile} · body.touch ${boot.touchClass} · body.field ${boot.fieldClass} `
  + `· DPR ${boot.dpr} · ${boot.btns.length} top-bar buttons, smallest ${boot.minBtn} px`);
console.log(`  manifest link ${boot.manifest} · apple-touch-icon ${boot.appleIcon} `
  + `· metas ${boot.metas.filter(Boolean).length}/4 · nav pad ${boot.navPad} buttons`);
if (boot.profile !== "tablet") fail("the iPad descriptor did not come out as the tablet profile", boot);
if (!boot.touchClass) fail("body.touch is not set on a tablet", boot);
if (boot.fieldClass) fail("field mode switched itself on at 1194 px — that is the phone rule", boot);
if (!boot.manifest || !boot.appleIcon) fail("the manifest / apple-touch-icon links are missing", boot);
if (boot.metas.some(m => !m)) fail("an apple/theme meta tag is missing", boot.metas);
if (!/viewport-fit=cover/.test(boot.viewportMeta)) fail("the viewport meta has no viewport-fit=cover", boot.viewportMeta);
if (!/interactive-widget=resizes-content/.test(boot.viewportMeta)) fail("the viewport meta has no interactive-widget", boot.viewportMeta);
if (boot.minBtn < 44) fail("a visible top-bar button is under 44 px on a tablet",
  boot.btns.filter(b => b.h < 44));
if (!boot.cmdBtn || !boot.fieldMenuBtn) fail("the touch-only top-bar buttons are missing", boot);
if (boot.navPad !== 4) fail("the 3D nav pad is not four buttons", boot.navPad);
if (!/none/.test(boot.overscroll || "")) warn("overscroll-behavior is not none", boot.overscroll);
if (errors.length) fail("page errors at boot", errors.slice(0, 6));

/* The CSS carries 100dvh and the safe-area padding.
   Read from the SOURCE, not from `document.styleSheets`: a stylesheet loaded
   by <link> over file:// is cross-origin to the page, so touching its
   `cssRules` throws SecurityError and the probe silently sees an empty
   stylesheet. (It reported "100dvh false · 0 safe-area rules" against a file
   that plainly has both.) The page-side half of the same question — did the
   rules actually parse and apply — is the computed style below. */
const cssSrc = readFileSync(__res(SITE, "css/app.css"), "utf8");
const css = { dvh: /height:\s*100dvh/.test(cssSrc),
              safe: (cssSrc.match(/env\(safe-area-inset/g) || []).length,
              overscroll: /overscroll-behavior:\s*none/.test(cssSrc) };
const applied = await page.evaluate(() => {
  const bar = getComputedStyle(document.getElementById("topbar"));
  const root = getComputedStyle(document.documentElement);
  return { topbarH: parseFloat(bar.height), htmlH: parseFloat(root.height),
           inner: window.innerHeight,
           mapTouch: getComputedStyle(document.getElementById("map")).touchAction,
           canvasTouch: getComputedStyle(document.getElementById("v3dCanvas")).touchAction };
});
console.log(`  css source: 100dvh ${css.dvh} · ${css.safe} safe-area rules · overscroll ${css.overscroll}`);
console.log(`  applied: html ${applied.htmlH}px of ${applied.inner} · top bar ${applied.topbarH}px `
  + `· touch-action map ${applied.mapTouch} / 3D ${applied.canvasTouch}`);
if (!css.dvh) fail("the layout does not use 100dvh");
if (css.safe < 6) fail("too few safe-area rules to be covering the chrome", css.safe);
if (!css.overscroll) fail("overscroll-behavior:none is not set — the page will rubber-band");
/* env() resolves to 0 in a headless browser, so the numbers cannot prove the
   INSET; what they can prove is that the rules parsed and are in effect */
if (Math.abs(applied.htmlH - applied.inner) > 1) fail("100dvh did not resolve to the viewport", applied);
if (applied.mapTouch !== "none" || applied.canvasTouch !== "none")
  fail("the gesture surfaces do not claim their own touches", applied);

/* the unlock, by TAP */
{
  const gctx = await browser.newContext({ ...DEV });
  const gp = await gctx.newPage();
  gp.setDefaultTimeout(180000);
  const gerr = [];
  gp.on("pageerror", e => gerr.push("pageerror: " + e.message));
  await gp.goto(__furl(__res(target)).href);
  await gp.waitForSelector("#gate");
  await gp.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
  await gp.fill("#gatePw", gatePassword(ROOT));
  await gp.tap("#gateGo");
  await gp.waitForFunction(() => !document.getElementById("gate"), null, { timeout: 6000 })
    .catch(() => fail("the gate did not open to a tapped password on a tablet"));
  const g = await gp.evaluate(() => ({ touch: document.body.classList.contains("touch"),
                                       field: document.body.classList.contains("field") }));
  console.log("gate: unlocked by tap · body.touch", g.touch, "· body.field", g.field);
  if (!g.touch || g.field) fail("the tablet profile did not survive the unlock", g);
  if (gerr.length) fail("errors on the gate page", gerr.slice(0, 4));
  await gctx.close();
}

/* ===================================================================== */
/* 2. profiles                                                           */
/* ===================================================================== */
await page.setViewportSize({ width: 507, height: 834 });
await wait(500);
const small = await page.evaluate(() => ({ profile: SBMM.touch.profile(),
  field: document.body.classList.contains("field"), touch: document.body.classList.contains("touch") }));
await page.setViewportSize({ width: 1194, height: 834 });
await wait(500);
const back = await page.evaluate(() => ({ profile: SBMM.touch.profile(),
  field: document.body.classList.contains("field"), touch: document.body.classList.contains("touch") }));
console.log(`profiles: 507 px -> ${small.profile} (field ${small.field}) · 1194 px -> ${back.profile} (field ${back.field})`);
if (small.profile !== "phone" || !small.field) fail("Split View at 507 px did not become the phone", small);
if (back.profile !== "tablet" || back.field) fail("coming back to 1194 px did not become the tablet", back);

/* portrait */
await page.setViewportSize({ width: 834, height: 1194 });
await wait(500);
const port = await page.evaluate(() => ({ profile: SBMM.touch.profile(),
  stage: Math.round(document.getElementById("stage").getBoundingClientRect().height),
  mapH: Math.round(document.getElementById("map").getBoundingClientRect().height) }));
console.log(`portrait 834x1194: ${port.profile}, stage ${port.stage} px, map ${port.mapH} px`);
if (port.profile !== "tablet") fail("portrait is not still a tablet", port);
if (port.mapH < 400) fail("the map did not relayout into portrait", port);
await page.setViewportSize({ width: 1194, height: 834 });
await wait(500);

/* the override */
const ov = await page.evaluate(() => {
  SBMM.touch.override("off");
  const off = { profile: SBMM.touch.profile(), touch: document.body.classList.contains("touch") };
  SBMM.touch.override("auto");
  const on = { profile: SBMM.touch.profile(), touch: document.body.classList.contains("touch") };
  return { off, on };
});
console.log(`override: off -> ${ov.off.profile} (body.touch ${ov.off.touch}) · auto -> ${ov.on.profile}`);
if (ov.off.profile !== "desktop" || ov.off.touch) fail("the override did not force desktop", ov);
if (ov.on.profile !== "tablet" || !ov.on.touch) fail("the override did not release", ov);
if (errors.length) fail("page errors after the profile switches", errors.slice(0, 6));

/* ===================================================================== */
/* 3. the 3D view                                                        */
/* ===================================================================== */
await page.evaluate(() => SBMM.viewer3d.toggle());
await page.waitForFunction(() => SBMM.viewer3d.isOpen(), null, { timeout: 180000 });
await wait(4000);

const box = await page.evaluate(() => {
  const r = document.getElementById("v3dCanvas").getBoundingClientRect();
  return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
           w: Math.round(r.width), h: Math.round(r.height),
           left: Math.round(r.left), top: Math.round(r.top) };
});
const orbit = () => page.evaluate(() => SBMM.viewer3d.stats().orbit);

/* --- one-finger orbit --- */
{
  const a = await orbit();
  await touch("touchStart", [{ x: box.cx, y: box.cy, id: 1 }]);
  for (let i = 1; i <= 8; i++) { await touch("touchMove", [{ x: box.cx - i * 12, y: box.cy - i * 4, id: 1 }]); await wait(45); }
  await touch("touchEnd", []);
  await wait(1500);
  const b = await orbit();
  console.log(`3D one-finger orbit: theta ${a.theta.toFixed(3)} -> ${b.theta.toFixed(3)}, phi ${a.phi.toFixed(3)} -> ${b.phi.toFixed(3)}`);
  if (Math.abs(b.theta - a.theta) < 0.05) fail("a one-finger drag did not orbit", { a, b });
}

/* --- pinch: the ground point under the midpoint stays under it --- */
{
  const mx = box.cx + 80, my = box.cy + 40;
  const before = await page.evaluate(([x, y]) => {
    const p = SBMM.viewer3d.worldAt ? SBMM.viewer3d.worldAt(x, y) : null;
    return p;
  }, [mx, my]);
  const r0 = (await orbit()).r;
  await touch("touchStart", [{ x: mx - 50, y: my, id: 1 }, { x: mx + 50, y: my, id: 2 }]);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [{ x: mx - 50 - i * 12, y: my, id: 1 }, { x: mx + 50 + i * 12, y: my, id: 2 }]);
    await wait(45);
  }
  await touch("touchEnd", []);
  await wait(1800);
  const r1 = (await orbit()).r;
  console.log(`3D pinch: orbit radius ${Math.round(r0)} -> ${Math.round(r1)} ft`);
  if (!(r1 < r0 * 0.95)) fail("a spread did not dolly in", { r0, r1 });

  if (before) {
    const after = await page.evaluate(p => (SBMM.viewer3d.screenAt ? SBMM.viewer3d.screenAt(p[0], p[1], p[2]) : null), before);
    if (after) {
      const dx = Math.abs(after[0] - mx), dy = Math.abs(after[1] - my);
      const tolX = box.w * 0.03, tolY = box.h * 0.03;
      console.log(`  the ground point under the midpoint moved ${dx.toFixed(0)}, ${dy.toFixed(0)} px `
        + `(tolerance ${tolX.toFixed(0)}, ${tolY.toFixed(0)})`);
      if (dx > tolX || dy > tolY) fail("the pinch did not dolly toward the midpoint", { dx, dy, tolX, tolY });
    } else warn("no screen projection for the pinch pivot — skipped the ±3 % check");
  } else warn("no terrain under the pinch midpoint — skipped the ±3 % check");
}

/* --- two-finger drag pans --- */
{
  const t0v = await page.evaluate(() => { const t = SBMM.viewer3d.stats(); return t.orbit; });
  const tg0 = await page.evaluate(() => { const v = SBMM.viewer3d.targetXY ? SBMM.viewer3d.targetXY() : null; return v; });
  await touch("touchStart", [{ x: box.cx - 60, y: box.cy, id: 1 }, { x: box.cx + 60, y: box.cy, id: 2 }]);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [{ x: box.cx - 60 + i * 10, y: box.cy + i * 6, id: 1 },
                              { x: box.cx + 60 + i * 10, y: box.cy + i * 6, id: 2 }]);
    await wait(45);
  }
  await touch("touchEnd", []);
  await wait(1600);
  const tg1 = await page.evaluate(() => (SBMM.viewer3d.targetXY ? SBMM.viewer3d.targetXY() : null));
  if (tg0 && tg1) {
    const moved = Math.hypot(tg1[0] - tg0[0], tg1[1] - tg0[1]);
    console.log(`3D two-finger pan: the orbit target moved ${moved.toFixed(0)} ft`);
    if (moved < 5) fail("a two-finger drag did not pan", { tg0, tg1 });
  } else warn("no targetXY hook — two-finger pan not measured", { t0v });
}

/* --- twist --- */
{
  const a = await orbit();
  const cx = box.cx, cy = box.cy, rr = 120;
  const at = ang => [{ x: cx - rr * Math.cos(ang), y: cy - rr * Math.sin(ang), id: 1 },
                     { x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang), id: 2 }];
  const TW = 40 * Math.PI / 180;
  await touch("touchStart", at(0));
  for (let i = 1; i <= 8; i++) { await touch("touchMove", at(TW * i / 8)); await wait(45); }
  await touch("touchEnd", []);
  await wait(1500);
  const b = await orbit();
  const dth = Math.abs(b.theta - a.theta) * 180 / Math.PI;
  console.log(`3D twist: 40 deg of finger twist moved the azimuth ${dth.toFixed(1)} deg`);
  if (Math.abs(dth - 40) > 5) fail("the twist did not turn the azimuth by the twist angle", { a, b, dth });
}

/* --- three-finger tilt --- */
{
  const a = await orbit();
  const y = box.cy + 100;
  const three = dy => [{ x: box.cx - 90, y: y - dy, id: 1 }, { x: box.cx, y: y - dy, id: 2 }, { x: box.cx + 90, y: y - dy, id: 3 }];
  await touch("touchStart", three(0));
  for (let i = 1; i <= 8; i++) { await touch("touchMove", three(i * 10)); await wait(45); }
  await touch("touchEnd", []);
  await wait(1500);
  const b = await orbit();
  console.log(`3D three-finger tilt: phi ${a.phi.toFixed(3)} -> ${b.phi.toFixed(3)}`);
  if (Math.abs(b.phi - a.phi) < 0.05) fail("a three-finger drag did not tilt", { a, b });
}

/* --- double-tap in, two-finger tap out --- */
{
  const a = await orbit();
  await tap(box.cx, box.cy, 50);
  await wait(90);
  await tap(box.cx, box.cy, 50);
  await wait(1800);
  const b = await orbit();
  console.log(`3D double-tap: r ${Math.round(a.r)} -> ${Math.round(b.r)} ft`);
  if (!(b.r < a.r * 0.95)) fail("a double-tap did not dolly in", { a, b });

  await touch("touchStart", [{ x: box.cx - 50, y: box.cy, id: 1 }, { x: box.cx + 50, y: box.cy, id: 2 }]);
  await wait(60);
  await touch("touchEnd", []);
  await wait(1800);
  const c = await orbit();
  console.log(`3D two-finger tap: r ${Math.round(b.r)} -> ${Math.round(c.r)} ft`);
  if (!(c.r > b.r * 1.05)) fail("a two-finger tap did not dolly out", { b, c });
}

/* --- a flick keeps moving, and then the view goes idle --- */
{
  const n0 = await page.evaluate(() => SBMM.viewer3d.stats().renderCount);
  await touch("touchStart", [{ x: box.cx, y: box.cy, id: 1 }]);
  for (let i = 1; i <= 6; i++) { await touch("touchMove", [{ x: box.cx + i * 22, y: box.cy, id: 1 }]); await wait(16); }
  await touch("touchEnd", []);
  await wait(180);
  const n1 = await page.evaluate(() => SBMM.viewer3d.stats().renderCount);
  await wait(4000);
  const n2 = await page.evaluate(() => SBMM.viewer3d.stats().renderCount);
  await wait(2500);
  const n3 = await page.evaluate(() => SBMM.viewer3d.stats().renderCount);
  console.log(`3D flick: renders ${n0} -> ${n1} (during) -> ${n2} (settled) -> ${n3} (idle)`);
  if (n1 - n0 < 3) fail("a flick did not keep the camera moving for 3 frames", { n0, n1 });
  if (n3 !== n2) fail("the view is still rendering after the momentum settled — perf idle-0 is broken", { n2, n3 });
}

/* --- long-press identifies, and drags a vertex handle --- */
{
  await page.evaluate(() => SBMM.viewer3d.frame());
  await wait(2000);
  await clearToasts();
  await longPress(box.cx, box.cy);
  await wait(900);
  const card = await page.evaluate(() => ({ open: SBMM.pick3d.cardOpen(),
                                            html: (SBMM.pick3d.cardHtml() || "").slice(0, 90) }));
  console.log(`3D long-press: identify card open ${card.open} — ${JSON.stringify(card.html)}`);
  if (!card.open) fail("a long press on the terrain opened no identify card");
  await page.evaluate(() => SBMM.pick3d.closeCard());
}
{
  /* a vertex handle: draw a small area, select it, long-press a handle and drag */
  /* `rebuildFeature` and not `newFeature`: newFeature builds the geometry but
     NOT the results card, and recompute() writes its rows into that card — the
     app never calls one without the other, so a harness that does is testing a
     path the app does not have. test/e2e.mjs builds its "ZZ box" the same way. */
  const made = await page.evaluate(() => {
    const c = SBMM.map.getCenter();
    const x = c.lng, y = c.lat;
    const f = SBMM.tools.rebuildFeature({
      type: "area", name: "Touch area",
      pts: [[x - 90, y - 90], [x + 90, y - 90], [x + 90, y + 90], [x - 90, y + 90]] });
    SBMM.store.select(f.id);
    return { id: f.id, pts: f.pts.map(p => p.slice()) };
  });
  await wait(2500);
  const hs = await page.evaluate(() => {
    const g = SBMM.pick3d.stats();
    return { handles: g.handles };
  });
  if (!hs.handles) fail("selecting a polygon built no 3D vertex handles", hs);
  const hpt = await page.evaluate(() => (SBMM.viewer3d.handleScreen ? SBMM.viewer3d.handleScreen(0) : null));
  if (!hpt) warn("no handleScreen hook — the 3D vertex drag was not driven");
  else {
    await touch("touchStart", [{ x: Math.round(hpt[0]), y: Math.round(hpt[1]), id: 1 }]);
    await wait(720);                              // the long press arms the drag
    for (let i = 1; i <= 6; i++) {
      await touch("touchMove", [{ x: Math.round(hpt[0]) + i * 9, y: Math.round(hpt[1]) + i * 5, id: 1 }]);
      await wait(60);
    }
    await touch("touchEnd", []);
    await wait(900);
    const now = await page.evaluate(id => {
      const f = SBMM.store.byId(id);
      return f ? f.pts.map(p => p.slice()) : null;
    }, made.id);
    const moved = now ? Math.hypot(now[0][0] - made.pts[0][0], now[0][1] - made.pts[0][1]) : 0;
    console.log(`3D vertex by long-press: vertex 0 moved ${moved.toFixed(1)} ft`);
    if (moved < 1) fail("a long-press drag did not move a 3D vertex handle", { before: made.pts[0], after: now && now[0] });
  }
}

/* --- §5a: the pen in 3D --- */
{
  const a = await orbit();
  await pen("down", box.cx, box.cy);
  for (let i = 1; i <= 8; i++) { await pen("move", box.cx - i * 12, box.cy - i * 3); await wait(35); }
  await pen("up", box.cx - 96, box.cy - 24);
  await wait(1500);
  const b = await orbit();
  console.log(`3D pen drag: theta ${a.theta.toFixed(3)} -> ${b.theta.toFixed(3)}`);
  if (Math.abs(b.theta - a.theta) < 0.03) fail("a pen drag did not orbit", { a, b });

  /* pen + one held finger = pan */
  const tg0 = await page.evaluate(() => (SBMM.viewer3d.targetXY ? SBMM.viewer3d.targetXY() : null));
  await pen("down", box.cx, box.cy);
  await touch("touchStart", [{ x: box.left + 40, y: box.top + 40, id: 5 }]);
  for (let i = 1; i <= 8; i++) { await pen("move", box.cx + i * 10, box.cy + i * 6); await wait(35); }
  await pen("up", box.cx + 80, box.cy + 48);
  await touch("touchEnd", []);
  await wait(1400);
  const tg1 = await page.evaluate(() => (SBMM.viewer3d.targetXY ? SBMM.viewer3d.targetXY() : null));
  if (tg0 && tg1) {
    const moved = Math.hypot(tg1[0] - tg0[0], tg1[1] - tg0[1]);
    const c = await orbit();
    console.log(`3D pen + finger: the target moved ${moved.toFixed(0)} ft (theta ${b.theta.toFixed(3)} -> ${c.theta.toFixed(3)})`);
    if (moved < 5) fail("a pen drag with a finger held did not pan", { tg0, tg1 });
    if (Math.abs(c.theta - b.theta) > 0.05) fail("a pen drag with a finger held ALSO orbited", { b, c });
  } else warn("no targetXY hook — the pen+finger pan was not measured");

  /* pen hover highlights (no buttons) */
  await page.evaluate(() => SBMM.pick3d.closeCard());
  await pen("move", box.cx, box.cy, { hover: true });
  await wait(400);
  const hov = await page.evaluate(() => SBMM.pick3d.stats().hoverActive);
  console.log(`3D pen hover: pick3d hover active ${hov}`);
}
await page.evaluate(() => SBMM.viewer3d.toggle());
await wait(800);
if (errors.length) fail("page errors after the 3D block", errors.slice(0, 6));

/* ===================================================================== */
/* 4. the sheet viewer                                                   */
/* ===================================================================== */
{
  const have = await page.evaluate(() => SBMM.sheets.hasRender("C-106"));
  if (!have) { warn("this build has no C-106 render — the sheet block was skipped"); }
  else {
    await page.evaluate(() => { SBMM.sheets.open("C-106"); });
    await wait(2500);
    const w0 = await page.evaluate(() => {
      const el = document.querySelector(".shwin");
      const r = el.getBoundingClientRect();
      const st = document.getElementById("stage").getBoundingClientRect();
      return { maxed: el.classList.contains("maxed"),
               w: Math.round(r.width), h: Math.round(r.height),
               stageW: Math.round(st.width), stageH: Math.round(st.height),
               hasMaxBtn: !!el.querySelector(".shmax"),
               barBtns: [...el.querySelectorAll(".shbar .minib")].map(b => Math.round(b.getBoundingClientRect().height)) };
    });
    console.log(`sheet: opened maximised ${w0.maxed} · ${w0.w}x${w0.h} of stage ${w0.stageW}x${w0.stageH}`);
    if (!w0.maxed) fail("a sheet window did not open maximised on a tablet", w0);
    if (w0.w < w0.stageW - 20) fail("the maximised window does not fill the stage", w0);
    if (!w0.hasMaxBtn) fail("there is no maximise button on the window");

    const vb = await page.evaluate(() => {
      const v = document.querySelector(".shwin .shview").getBoundingClientRect();
      return { left: Math.round(v.left), top: Math.round(v.top),
               cx: Math.round(v.left + v.width / 2), cy: Math.round(v.top + v.height / 2) };
    });
    /* pinch about a point: the sheet pixel under it must stay under it */
    const pxAt = (x, y) => page.evaluate(([x, y]) => {
      const st = SBMM.sheets.stateOf ? SBMM.sheets.stateOf("C-106") : null;
      if (!st) return null;
      const r = st.view.getBoundingClientRect();
      return [(x - r.left - st.tx) / st.scale, (y - r.top - st.ty) / st.scale];
    }, [x, y]);
    const px0 = await pxAt(vb.cx, vb.cy);
    if (!px0) warn("no stateOf hook — the sheet pinch anchor was not measured");
    await touch("touchStart", [{ x: vb.cx - 60, y: vb.cy, id: 1 }, { x: vb.cx + 60, y: vb.cy, id: 2 }]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [{ x: vb.cx - 60 - i * 10, y: vb.cy, id: 1 }, { x: vb.cx + 60 + i * 10, y: vb.cy, id: 2 }]);
      await wait(45);
    }
    await touch("touchEnd", []);
    await wait(500);
    const z1 = await page.evaluate(() => {
      const st = SBMM.sheets.stateOf ? SBMM.sheets.stateOf("C-106") : null;
      return st ? st.scale : null;
    });
    const px1 = await pxAt(vb.cx, vb.cy);
    if (px0 && px1) {
      const drift = Math.hypot(px1[0] - px0[0], px1[1] - px0[1]) * (z1 || 1);
      console.log(`sheet pinch: scale -> ${(z1 || 0).toFixed(3)}, the point under the fingers drifted ${drift.toFixed(1)} screen px`);
      if (drift > 2) fail("the sheet pinch did not keep the point under the fingers", { px0, px1, drift });
    }

    /* two-finger pan */
    const t0 = await page.evaluate(() => { const s = SBMM.sheets.stateOf("C-106"); return [s.tx, s.ty]; });
    await touch("touchStart", [{ x: vb.cx - 60, y: vb.cy, id: 1 }, { x: vb.cx + 60, y: vb.cy, id: 2 }]);
    for (let i = 1; i <= 6; i++) {
      await touch("touchMove", [{ x: vb.cx - 60 + i * 8, y: vb.cy + i * 5, id: 1 },
                                { x: vb.cx + 60 + i * 8, y: vb.cy + i * 5, id: 2 }]);
      await wait(45);
    }
    await touch("touchEnd", []);
    await wait(400);
    const t1 = await page.evaluate(() => { const s = SBMM.sheets.stateOf("C-106"); return [s.tx, s.ty]; });
    console.log(`sheet two-finger pan: tx ${t0[0].toFixed(0)} -> ${t1[0].toFixed(0)}`);
    if (Math.abs(t1[0] - t0[0]) < 4 && Math.abs(t1[1] - t0[1]) < 4)
      warn("the two-finger pan moved less than 4 px (the drawing may be clamped)", { t0, t1 });

    /* double-tap zooms in */
    const z2a = await page.evaluate(() => SBMM.sheets.stateOf("C-106").scale);
    await tap(vb.cx, vb.cy, 50); await wait(90); await tap(vb.cx, vb.cy, 50);
    await wait(500);
    const z2b = await page.evaluate(() => SBMM.sheets.stateOf("C-106").scale);
    console.log(`sheet double-tap: scale ${z2a.toFixed(3)} -> ${z2b.toFixed(3)}`);
    if (!(z2b > z2a * 1.4)) fail("a double-tap did not zoom the sheet in", { z2a, z2b });

    /* a mark placed with the LOUPE, and finished with Done */
    await page.evaluate(() => { SBMM.sheets.stateOf("C-106"); });
    await page.evaluate(() => {
      const st = SBMM.sheets.stateOf("C-106");
      const b = [...st.el.querySelectorAll(".sht")].find(x => x.dataset.sht === "distance");
      b.click();
    });
    await wait(300);
    const nFeat0 = await page.evaluate(() => SBMM.store.features.length);
    /* press, hold (the loupe appears), slide, lift */
    await touch("touchStart", [{ x: vb.cx - 120, y: vb.cy - 60, id: 1 }]);
    await wait(320);
    const loupeUp = await page.evaluate(() => {
      const el = document.getElementById("touchLoupe");
      return !!el && !el.hidden;
    });
    if (!loupeUp) fail("the loupe did not appear while a finger was placing a vertex");
    await page.screenshot({ path: __res(HERE, "shots/tablet_sheet_loupe.png") }).catch(() => {});
    for (let i = 1; i <= 5; i++) { await touch("touchMove", [{ x: vb.cx - 120 + i * 6, y: vb.cy - 60 + i * 3, id: 1 }]); await wait(50); }
    await touch("touchEnd", []);
    await wait(300);
    await tap(vb.cx + 120, vb.cy + 60);
    await wait(400);
    const barUp = await page.evaluate(() => {
      const el = document.getElementById("touchDone");
      return { up: !!el && !el.hidden, label: el ? el.querySelector(".tdlbl").textContent : "" };
    });
    console.log(`sheet mark: loupe shown ${loupeUp} · Done bar ${barUp.up} ${JSON.stringify(barUp.label)}`);
    if (!barUp.up) fail("the Done bar did not appear while a sheet mark was open");
    await page.evaluate(() => document.querySelector('#touchDone [data-td="done"]').click());
    await wait(900);
    const made = await page.evaluate(n => {
      const f = SBMM.store.features[SBMM.store.features.length - 1];
      return { n: SBMM.store.features.length, was: n, type: f.type, len: f.props && f.props.length_ft,
               prov: f.props && f.props.provenance ? f.props.provenance.sheet : null };
    }, nFeat0);
    console.log(`  the mark: ${made.type}, ${made.len == null ? "?" : made.len.toFixed(1)} ft, provenance ${made.prov}`);
    if (made.n <= made.was) fail("Done did not commit the sheet mark", made);
    if (made.prov !== "C-106") fail("the mark carries no sheet provenance", made);
    if (!(made.len > 0.5 && made.len < 4000)) fail("the georeferenced mark is not a plausible length", made);

    /* restore / maximise, and the toolbar by tap */
    await page.evaluate(() => document.querySelector(".shwin .shmax").click());
    await wait(500);
    const rest = await page.evaluate(() => {
      const el = document.querySelector(".shwin");
      return { maxed: el.classList.contains("maxed"), w: Math.round(el.getBoundingClientRect().width) };
    });
    await page.evaluate(() => document.querySelector(".shwin .shmax").click());
    await wait(400);
    const remax = await page.evaluate(() => document.querySelector(".shwin").classList.contains("maxed"));
    console.log(`sheet restore/maximise: restored ${!rest.maxed} (${rest.w} px) · re-maximised ${remax}`);
    if (rest.maxed || !remax) fail("restore / maximise did not round-trip", { rest, remax });

    /* page step, locate, measure, export — every one by tap */
    await clearToasts();
    const beforeSheet = await page.evaluate(() => document.querySelector(".shwin").dataset.sheet);
    await page.tap(".shwin .shnext");
    await wait(1200);
    const afterSheet = await page.evaluate(() => document.querySelector(".shwin").dataset.sheet);
    console.log(`sheet page step by tap: ${beforeSheet} -> ${afterSheet}`);
    if (afterSheet === beforeSheet) fail("the next-sheet button did nothing when tapped");
    await page.tap(".shwin .shprev");
    await wait(1200);
    await page.tap(".shwin .shloc");
    await wait(1200);
    const locTo = await page.evaluate(() => { const c = SBMM.map.getCenter(); return [Math.round(c.lng), Math.round(c.lat)]; });
    console.log(`  locate on map by tap -> ${locTo.join(", ")}`);
    await page.tap(".shwin .shclose");
    await wait(700);
    const shut = await page.evaluate(() => SBMM.sheets.openCount());
    if (shut !== 0) fail("the sheet window did not close when its ✕ was tapped", shut);
  }
}
if (errors.length) fail("page errors after the sheet block", errors.slice(0, 6));

/* ===================================================================== */
/* 5. the map, the pen, and the chrome                                   */
/* ===================================================================== */
const mapBox = await page.evaluate(() => {
  const r = document.getElementById("map").getBoundingClientRect();
  return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
           left: Math.round(r.left), top: Math.round(r.top),
           w: Math.round(r.width), h: Math.round(r.height) };
});

/* --- long-press = right-click --- */
{
  await page.evaluate(() => { document.getElementById("ctxmenu").style.display = "none"; });
  await longPress(mapBox.cx, mapBox.cy);
  await wait(500);
  const cm = await page.evaluate(() => {
    const el = document.getElementById("ctxmenu");
    return { shown: getComputedStyle(el).display !== "none", items: el.querySelectorAll(".ci").length };
  });
  console.log(`map long-press: context menu shown ${cm.shown} with ${cm.items} items`);
  if (!cm.shown || !cm.items) fail("a long press did not open the map context menu", cm);
  await page.evaluate(() => { document.getElementById("ctxmenu").style.display = "none"; });
}

/* --- a polygon by TAPS + Done vs the same polygon by MOUSE clicks --- */
{
  /* Pin the view first, and size the polygon in SCREEN pixels.
     The map restores wherever it was left (js/view.js), and at zoom -2.75 a
     140-ft square is 42 px across — four clicks inside 42 px, a quarter of a
     second apart, are read by the browser as DOUBLE-clicks, and a double-click
     finishes a sketch. The polygon has to be big enough on the glass that two
     consecutive vertices are unambiguously two clicks. */
  await page.evaluate(() => {
    SBMM.map.setView([2128900, 6371600], 1, { animate: false });
  });
  await wait(600);
  const P = await page.evaluate(() => {
    const r = document.getElementById("map").getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = 110;   // 220 px a side
    /* A TRIANGLE, not a square, and that is deliberate. With four corners
       Leaflet delivers only three map `click` events for four mouse clicks —
       the closing one is dropped, identically with `body.touch` on and OFF, so
       it is not v17's and not a touch question at all (reported to the planner
       as a pre-existing oddity). Comparing a shape the mouse path mis-draws
       against one the tap path draws correctly would fail on that, not on the
       thing this block is for: the same three points, two input methods, the
       same area. */
    const scr = [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d]];
    return scr.map(q => {
      const ll = SBMM.map.containerPointToLatLng([q[0] - r.left, q[1] - r.top]);
      return { sp: [ll.lng, ll.lat], x: Math.round(q[0]), y: Math.round(q[1]) };
    });
  });
  {
    const gap = Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y);
    console.log(`  test polygon: ${P.length} corners, ${gap.toFixed(0)} px apart at zoom 1`);
    if (gap < 80) fail("the test polygon is too small on screen — clicks would read as double-clicks", gap);
  }
  /* by mouse */
  await page.evaluate(() => SBMM.mode.set("measure.area"));
  await wait(300);
  for (const p of P) { await page.mouse.click(p.x, p.y); await wait(220); }
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => SBMM.store.features.some(f => f.type === "area" && f.props && f.props.area_ft2), null, { timeout: 60000 });
  await wait(600);
  const byMouse = await page.evaluate(() => {
    const fs = SBMM.store.features.filter(f => f.type === "area" && f.props && f.props.area_ft2);
    return fs[fs.length - 1].props.area_ft2;
  });
  /* by taps + Done.
     Navigate FIRST: `SBMM.mode.set(x)` when the mode is already x emits no
     `mode` event (it diffs), and the Done bar hangs off that event — so
     re-arming a tool the harness is already holding proves nothing about the
     bar. Coming from Navigate is also what a user does. */
  await page.evaluate(() => SBMM.mode.navigate());
  await wait(200);
  const before = await page.evaluate(() => SBMM.store.features.filter(f => f.type === "area").length);
  await page.evaluate(() => SBMM.mode.set("measure.area"));
  await wait(400);
  const armedNow = await page.evaluate(() => ({
    mode: SBMM.mode.current(), tool: SBMM.tools.active(),
    drawing: SBMM.draw.isDrawing(), armed: SBMM.draw.armed(),
    touch: SBMM.touch.on(), bar: SBMM.touch.doneBar.visible()
  }));
  console.log(`  armed for touch: ${JSON.stringify(armedNow)}`);
  if (!armedNow.armed) fail("arming the area tool did not open a sketch", armedNow);
  if (!armedNow.bar) fail("the Done bar did not appear when the tool was armed", armedNow);
  for (const p of P) { await tap(p.x, p.y, 70); await wait(320); }
  const doneUp = await page.evaluate(() => {
    const el = document.getElementById("touchDone");
    return { up: !!el && !el.hidden, label: el ? el.querySelector(".tdlbl").textContent : null,
             verts: SBMM.draw.isDrawing() ? SBMM.tools.sketchPts ? SBMM.tools.sketchPts().length : -1 : -2,
             armed: SBMM.draw.armed(), mode: SBMM.mode.current() };
  });
  console.log(`  after four taps: ${JSON.stringify(doneUp)}`);
  if (!doneUp.up) fail("the Done bar did not appear while sketching on the map by touch", doneUp);
  await page.evaluate(() => document.querySelector('#touchDone [data-td="done"]').click());
  await wait(1500);
  const byTouch = await page.evaluate(n => {
    const fs = SBMM.store.features.filter(f => f.type === "area" && f.props && f.props.area_ft2);
    if (fs.length <= n) return null;              // nothing new: Done did not commit
    return fs[fs.length - 1].props.area_ft2;
  }, before);
  if (byTouch == null) fail("Done did not commit the polygon drawn by taps");
  const err = Math.abs(byTouch - byMouse) / byMouse * 100;
  console.log(`map polygon: mouse ${byMouse.toFixed(1)} ft² vs taps+Done ${byTouch.toFixed(1)} ft² (${err.toFixed(3)} %)`);
  if (err > 0.1) fail("the same polygon drawn by taps differs from the one drawn by clicks", { byMouse, byTouch, err });
  await page.evaluate(() => SBMM.mode.navigate());
}

/* --- a vertex drag by touch --- */
{
  const info = await page.evaluate(() => {
    const fs = SBMM.store.features.filter(f => f.type === "area");
    const f = fs[fs.length - 1];
    SBMM.store.select(f.id);
    SBMM.tools.editFeature(f);
    const r = document.getElementById("map").getBoundingClientRect();
    const q = SBMM.map.latLngToContainerPoint([f.pts[0][1], f.pts[0][0]]);
    return { id: f.id, pts: f.pts.map(p => p.slice()),
             x: Math.round(r.left + q.x), y: Math.round(r.top + q.y) };
  });
  await wait(500);
  await touch("touchStart", [{ x: info.x, y: info.y, id: 1 }]);
  for (let i = 1; i <= 6; i++) { await touch("touchMove", [{ x: info.x + i * 7, y: info.y + i * 4, id: 1 }]); await wait(60); }
  await touch("touchEnd", []);
  await wait(900);
  const after = await page.evaluate(id => SBMM.store.byId(id).pts.map(p => p.slice()), info.id);
  const moved = Math.hypot(after[0][0] - info.pts[0][0], after[0][1] - info.pts[0][1]);
  console.log(`map vertex drag by touch: vertex 0 moved ${moved.toFixed(1)} ft`);
  if (moved < 1) fail("a touch drag did not move a 2D vertex handle", { before: info.pts[0], after: after[0] });
  await page.evaluate(() => SBMM.draw.endEdit());
}

/* --- §5a: the pen on the map --- */
{
  /* a pen tap places a vertex with NO loupe */
  await page.evaluate(() => SBMM.mode.set("measure.distance"));
  await wait(300);
  await pen("down", mapBox.cx - 100, mapBox.cy - 60);
  await wait(120);
  const loupeDuringPen = await page.evaluate(() => {
    const el = document.getElementById("touchLoupe");
    return !!el && !el.hidden;
  });
  await pen("up", mapBox.cx - 100, mapBox.cy - 60);
  await wait(300);
  console.log(`pen on the map: loupe shown during the press ${loupeDuringPen} (it must not be)`);
  if (loupeDuringPen) fail("the loupe appeared for a PEN — a pen is a precise pointer (§5a)");
  const snapK = await page.evaluate(() => SBMM.touch.lastPointer());
  console.log(`  lastPointer() after the pen = ${snapK}`);
  if (snapK !== "pen") fail("lastPointer() did not report the pen", snapK);
  await page.evaluate(() => SBMM.mode.navigate());
}

/* --- §5a: a redline stroke --- */
{
  await clearToasts();
  await page.evaluate(() => SBMM.mode.set("redline"));
  await wait(500);
  const pal = await page.evaluate(() => {
    const el = document.getElementById("inkPal");
    return { up: !!el && !el.hidden, swatches: el ? el.querySelectorAll(".inksw").length : 0 };
  });
  console.log(`redline: palette up ${pal.up} with ${pal.swatches} swatches`);
  if (!pal.up || pal.swatches !== 7) fail("the redline palette is wrong", pal);

  const n0 = await page.evaluate(() => SBMM.store.features.filter(f => f.type === "ink").length);
  await pen("down", mapBox.cx - 150, mapBox.cy, { pressure: 0.2 });
  for (let i = 1; i <= 20; i++)
    await pen("move", mapBox.cx - 150 + i * 12, mapBox.cy + 40 * Math.sin(i / 3), { pressure: 0.15 + i * 0.04 });
  await pen("up", mapBox.cx + 90, mapBox.cy);
  await wait(700);
  const ink = await page.evaluate(() => {
    const fs = SBMM.store.features.filter(f => f.type === "ink");
    const f = fs[fs.length - 1];
    if (!f) return null;
    const w = f.props.widths || [];
    return { n: fs.length, pts: f.pts.length, widths: w.length,
             wMin: Math.min(...w), wMax: Math.max(...w),
             color: f.props.color, pen: f.props.pen,
             cls: SBMM.myWork.classOf(f), undo: SBMM.undo.labels().undo };
  });
  console.log(`redline stroke: ${ink && ink.pts} points, ${ink && ink.widths} widths `
    + `${ink ? ink.wMin.toFixed(2) + "-" + ink.wMax.toFixed(2) : ""}, colour ${ink && ink.color}, `
    + `My-work class ${ink && ink.cls}, undo "${ink && ink.undo}"`);
  if (!ink || ink.n <= n0) fail("a pen stroke made no ink feature", ink);
  if (ink.pts < 4) fail("the stroke was simplified into nothing", ink);
  if (ink.widths !== ink.pts) fail("the widths array does not match the points", ink);
  if (!(ink.wMax > ink.wMin + 0.1)) fail("pressure did not drive the width", ink);
  if (!ink.pen) fail("the stroke did not record that a pen made it", ink);
  /* a redline joins the DRAWINGS class rather than getting a row of its own —
     see the note in js/layers.js: block 9z of test/e2e.mjs baselines every
     (group, id) in the tree and fails on an invented row. */
  if (ink.cls !== "drawings") fail("an ink stroke is not in the Drawings My-work class", ink);
  if (!/redline/i.test(ink.undo || "")) fail("the stroke pushed no undo entry", ink);

  /* a finger during a pen stroke is the palm and must be ignored */
  const n1 = await page.evaluate(() => SBMM.store.features.filter(f => f.type === "ink").length);
  await pen("down", mapBox.cx - 150, mapBox.cy + 100);
  await touch("touchStart", [{ x: mapBox.cx + 200, y: mapBox.cy + 200, id: 4 }]);
  for (let i = 1; i <= 8; i++) { await pen("move", mapBox.cx - 150 + i * 14, mapBox.cy + 100); await wait(20); }
  await touch("touchEnd", []);
  await pen("up", mapBox.cx - 38, mapBox.cy + 100);
  await wait(600);
  const n2 = await page.evaluate(() => SBMM.store.features.filter(f => f.type === "ink").length);
  console.log(`palm rejection: ${n2 - n1} stroke(s) from one pen stroke with a palm down (must be 1)`);
  if (n2 - n1 !== 1) fail("the palm made a stroke of its own", { n1, n2 });

  await page.evaluate(() => SBMM.mode.navigate());
  await wait(300);
  const palGone = await page.evaluate(() => document.getElementById("inkPal").hidden);
  if (!palGone) fail("the palette did not go away with the mode");

  /* the round trip: session, GeoJSON, DXF, 3D */
  const trip = await page.evaluate(async () => {
    const before = SBMM.store.features.filter(f => f.type === "ink");
    const ser = SBMM.store.serialize();
    const json = JSON.stringify(ser);
    SBMM.store.clear();
    SBMM.store.restore(JSON.parse(json));
    const after = SBMM.store.features.filter(f => f.type === "ink");
    const gj = SBMM.io.collection("sp");
    const dxf = SBMM.dxf.buildDXF();
    return {
      version: ser.version,
      before: before.length, after: after.length,
      ptsSame: before.length === after.length
        && before.every((f, i) => f.pts.length === after[i].pts.length),
      widthsKept: after.every(f => (f.props.widths || []).length === f.pts.length),
      geojsonLineStrings: gj ? (gj.features || []).filter(
        x => /Redline/.test((x.properties && x.properties.name) || "")
          && x.geometry && x.geometry.type === "LineString").length : null,
      dxfHasLayer: dxf ? /REDLINE/.test(dxf) : null
    };
  });
  console.log(`redline round trip: session v${trip.version} · ${trip.before} -> ${trip.after} strokes · `
    + `widths kept ${trip.widthsKept} · GeoJSON ${trip.geojsonLineStrings} · DXF REDLINE layer ${trip.dxfHasLayer}`);
  /* the session INTEGER is still 8 — see the note in js/state.js: the ink type
     is additive, and test/e2e.mjs asserts 8 in three places and has to pass
     unchanged. What matters here is that the strokes survive the round trip. */
  if (trip.version !== 8) fail("the session version moved without the e2e being updated with it", trip);
  if (!trip.ptsSame || !trip.widthsKept) fail("an ink stroke did not survive a session round trip", trip);
  if (trip.dxfHasLayer === false) fail("the DXF export has no REDLINE layer", trip);

  /* and it draws in 3D */
  await page.evaluate(() => SBMM.viewer3d.toggle());
  await page.waitForFunction(() => SBMM.viewer3d.isOpen(), null, { timeout: 180000 });
  await wait(3500);
  const drawn3d = await page.evaluate(() => {
    SBMM.layerState.setGroup("mywork", true);
    SBMM.viewer3d.refreshOverlays();
    return new Promise(r => setTimeout(() => r(SBMM.viewer3d.stats().layersDrawn["mywork/drawings"] || 0), 3000));
  });
  console.log(`redline in 3D: ${drawn3d} object(s) tagged mywork/drawings`);
  if (!drawn3d) fail("an ink stroke drew nothing in 3D");
  await page.evaluate(() => SBMM.viewer3d.toggle());
  await wait(700);
}

/* --- Cmd+Z (an iPad keyboard sends metaKey, not ctrlKey) --- */
{
  /* Asserted on the UNDO STACK, not on the feature count. The top of the stack
     at this point is whatever the previous block left there — the redline's
     3D check turns a layer group on, and a layer change is an undoable action
     too — so "one fewer feature" is not what Cmd+Z means. What it means is
     that the key reached SBMM.undo: the undo stack moved and the redo stack
     gained the entry it moved. */
  const before = await page.evaluate(() => ({
    undo: SBMM.undo.labels().undo, redo: SBMM.undo.labels().redo,
    canUndo: SBMM.undo.canUndo(), canRedo: SBMM.undo.canRedo(),
    feats: SBMM.store.features.length }));
  if (!before.canUndo) fail("nothing on the undo stack to test Cmd+Z with", before);
  await page.keyboard.press("Meta+z");
  await wait(700);
  const after = await page.evaluate(() => ({
    undo: SBMM.undo.labels().undo, redo: SBMM.undo.labels().redo,
    canRedo: SBMM.undo.canRedo(), feats: SBMM.store.features.length }));
  console.log(`Cmd+Z: undid "${before.undo}" · stack top now "${after.undo}" · `
    + `redo "${after.redo}" · features ${before.feats} -> ${after.feats}`);
  if (!after.canRedo || after.redo !== before.undo)
    fail("Cmd+Z did not reach the undo stack (an iPad keyboard sends metaKey)", { before, after });
  await page.keyboard.press("Meta+Shift+z");
  await wait(700);
  const redone = await page.evaluate(() => ({
    undo: SBMM.undo.labels().undo, canRedo: SBMM.undo.canRedo(),
    feats: SBMM.store.features.length }));
  console.log(`Cmd+Shift+Z: redid it · stack top "${redone.undo}" · features ${redone.feats}`);
  /* the STACK is the assertion, and the feature count deliberately is not: this
     block runs after the redline's session round trip (store.clear() then
     restore()), and SBMM.store.clear() does not clear the undo stack — so the
     entry on top still closes over a feature object the store no longer holds.
     Undoing it removes nothing and redoing it re-adds one, which is a real
     pre-existing wrinkle worth reporting and not what "Cmd+Z works" means. */
  if (redone.undo !== before.undo || redone.canRedo)
    fail("Cmd+Shift+Z did not redo", { before, after, redone });
}

/* --- the share sheet, stubbed --- */
{
  await page.evaluate(() => {
    window.__shared = [];
    navigator.share = files => { window.__shared.push((files.files || []).map(f => f.name)); return Promise.resolve(); };
    navigator.canShare = () => true;
  });
  await page.evaluate(() => SBMM.dxf.exportDXF());
  await wait(900);
  const sh = await page.evaluate(() => ({ shared: window.__shared, noted: SBMM.touch.shared().length }));
  console.log(`share sheet: navigator.share called with ${JSON.stringify(sh.shared)} · noted ${sh.noted}`);
  if (!sh.shared.length) fail("an export did not reach navigator.share on a touch device", sh);
  /* and without it, the download path still runs */
  const dl = await page.evaluate(() => {
    delete navigator.share; delete navigator.canShare;
    let clicked = 0;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicked++; };
    try { SBMM.dxf.exportDXF(); } catch (e) {}
    HTMLAnchorElement.prototype.click = orig;
    return clicked;
  });
  console.log(`  without navigator.share the download fallback ran ${dl} time(s)`);
  if (!dl) fail("the download fallback did not run without navigator.share");
}

/* --- a dropped CSV imports --- */
{
  const n0 = await page.evaluate(() => (SBMM.datasets.list() || []).length);
  await page.evaluate(() => {
    /* newlines via fromCharCode: this file has been through a couple of
       generators, and a "\\n" that should have been "\n" made the CSV one
       long line, which js/datasets.js correctly refused as having no data
       rows. No escape here, nothing to mangle. */
    const NL = String.fromCharCode(10);
    const csv = ["id,easting,northing", "T1,6371600,2128900", "T2,6371700,2129000"].join(NL) + NL;
    const dt = new DataTransfer();
    dt.items.add(new File([csv], "dropped.csv", { type: "text/csv" }));
    document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  /* the drop goes through a FileReader, so give it a moment rather than a frame */
  await page.waitForFunction(() => !!document.getElementById("dsDialog"), null, { timeout: 15000 })
    .catch(() => {});
  const dropped = await page.evaluate(() => ({
    dialog: !!document.getElementById("dsDialog"),
    cols: document.getElementById("dsDialog")
      ? document.querySelectorAll("#dsDialog select").length : 0,
    n: (SBMM.datasets.list() || []).length
  }));
  const dropToasts = await toasts();
  console.log(`dropped CSV: mapping dialog ${dropped.dialog} (${dropped.cols} column pickers) `
    + `· datasets ${n0} -> ${dropped.n} · toasts ${JSON.stringify(dropToasts.slice(-2))}`);
  if (!dropped.dialog && dropped.n === n0) fail("a dropped CSV reached no importer", { dropped, dropToasts });
  await page.evaluate(() => { const d = document.getElementById("dsDialog"); if (d) d.remove(); });
}

/* --- the layer tree's "⋯", a popup action by tap, the command bar --- */
{
  const row = await page.evaluate(() => {
    const r = document.querySelector("#layers .lyr");
    const b = r.querySelector(".ltmore");
    const box = b.getBoundingClientRect();
    return { has: !!b, visible: getComputedStyle(b).display !== "none",
             x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2),
             w: Math.round(box.width), h: Math.round(box.height) };
  });
  console.log(`layer row "⋯": present ${row.has}, visible ${row.visible}, ${row.w}x${row.h} px`);
  if (!row.has || !row.visible) fail("the layer row has no visible ⋯ on a tablet", row);
  await tap(row.x, row.y);
  await wait(400);
  const opened = await page.evaluate(() => {
    const r = document.querySelector("#layers .lyr");
    return { open: r.classList.contains("ltopen"),
             acts: getComputedStyle(r.querySelector(".ltacts")).display,
             btns: [...r.querySelectorAll(".ltacts .ltb")].map(b => Math.round(b.getBoundingClientRect().height)) };
  });
  console.log(`  the row toolbar opened: ${opened.open} (${opened.acts}), buttons ${opened.btns.join("/")} px`);
  if (!opened.open || opened.acts === "none") fail("tapping ⋯ did not open the row toolbar", opened);
  if (opened.btns.some(h => h < 32)) fail("the row toolbar buttons are too small to tap", opened);
  await page.evaluate(() => document.querySelector("#layers .lyr").classList.remove("ltopen"));
}
{
  /* a popup action by tap: a feature popup carries 44-px buttons */
  await page.evaluate(() => {
    const f = SBMM.store.features.find(g => g.type === "area");
    SBMM.map.openPopup(L.popup().setLatLng([f.pts[0][1], f.pts[0][0]]).setContent(SBMM.popups.forFeature(f)));
  });
  await wait(600);
  const pop = await page.evaluate(() => {
    const b = document.querySelector(".leaflet-popup-content .minib");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { h: Math.round(r.height), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             txt: b.textContent.trim().slice(0, 24) };
  });
  if (!pop) warn("no popup action button to tap");
  else {
    console.log(`popup action: "${pop.txt}" is ${pop.h} px tall`);
    if (pop.h < 44) fail("a popup action button is under 44 px on a tablet", pop);
    await tap(pop.x, pop.y);
    await wait(700);
  }
  await page.evaluate(() => SBMM.map.closePopup());
}
{
  const cb = await page.evaluate(() => {
    const b = document.getElementById("cmdTopBtn");
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), h: Math.round(r.height) };
  });
  await tap(cb.x, cb.y);
  await wait(500);
  const open = await page.evaluate(() => ({ open: document.body.classList.contains("cmdopen"),
                                            font: parseFloat(getComputedStyle(document.getElementById("cmdIn")).fontSize) }));
  console.log(`command bar from its button: open ${open.open}, input ${open.font} px`);
  if (!open.open) fail("the command-bar button did not open the command bar");
  if (open.font < 16) fail("the command input is under 16 px — iOS would zoom the page", open);
  await page.keyboard.press("Escape");
  await wait(300);
}
{
  /* the Field menu (§5b) */
  const fm = await page.evaluate(() => {
    document.getElementById("fieldMenuBtn").click();
    const m = document.getElementById("fieldMenu");
    return { shown: m.style.display === "block", items: [...m.querySelectorAll("[data-fm]")].map(i => i.dataset.fm) };
  });
  console.log(`Field menu: shown ${fm.shown} · ${fm.items.join(", ")}`);
  if (!fm.shown || fm.items.length < 4) fail("the Field menu did not open with its four capabilities", fm);
  await page.evaluate(() => { document.getElementById("fieldMenu").style.display = "none"; });
}
{
  /* §5b: the Help diagnostics line and the reload button */
  const help = await page.evaluate(() => {
    SBMM.touch.paintDiag();
    const d = document.getElementById("touchDiag");
    return { diag: d ? d.textContent : null, reload: !!document.getElementById("reloadApp"),
             hint: (() => { const h = document.getElementById("homeHint"); return h ? !h.hidden : null; })(),
             record: SBMM.touch.diagnostics() };
  });
  console.log(`Help: "${help.diag}"`);
  console.log(`  Add-to-Home hint shown ${help.hint} · Reload app button ${help.reload}`);
  if (!help.diag || !/tablet/.test(help.diag)) fail("the diagnostics line does not name the profile", help.diag);
  if (!help.reload) fail("there is no Reload app button");
  if (help.record.workers == null || help.record.workers < 2)
    fail("the worker pool did not size from the CPU", help.record);
}
{
  /* §5b: a WebGL context loss is recovered, not a dead black canvas */
  await page.evaluate(() => SBMM.viewer3d.toggle());
  await page.waitForFunction(() => SBMM.viewer3d.isOpen(), null, { timeout: 180000 });
  await wait(3000);
  await clearToasts();
  const lost = await page.evaluate(async () => {
    const cv = document.getElementById("v3dCanvas");
    const gl = cv.getContext("webgl2") || cv.getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_lose_context");
    if (!ext) return { skipped: true };
    ext.loseContext();
    await new Promise(r => setTimeout(r, 900));
    const mid = SBMM.viewer3d.stats().contextLost;
    ext.restoreContext();
    await new Promise(r => setTimeout(r, 6000));
    return { skipped: false, mid, after: SBMM.viewer3d.stats().contextLost,
             verts: SBMM.viewer3d.stats().terrainVerts };
  });
  const ctxToasts = await toasts();
  if (lost.skipped) warn("this Chromium has no WEBGL_lose_context — the recovery was not driven");
  else {
    console.log(`WebGL context loss: lost ${lost.mid} -> restored ${!lost.after}, ${lost.verts} terrain vertices`);
    console.log(`  toasts: ${JSON.stringify(ctxToasts)}`);
    if (!lost.mid) fail("the context-loss handler did not fire", lost);
    if (lost.after) fail("the context was never marked restored", lost);
    if (!lost.verts) fail("the scene was not rebuilt after the context came back", lost);
    if (!ctxToasts.some(t => /graphics context|3D view is back/i.test(t)))
      fail("the context loss was silent — every failure the user can see must toast", ctxToasts);
  }
  await page.evaluate(() => SBMM.viewer3d.toggle());
  await wait(600);
}
if (errors.length) fail("page errors after the map / pen block", errors.slice(0, 8));

/* ===================================================================== */
/* 6. the offline copy — http only                                       */
/* ===================================================================== */
{
  /* file:// first: no registration, no error, and the button says why */
  const off = await page.evaluate(async () => {
    const s = await SBMM.touch.offline.status();
    const btn = document.getElementById("offlineBtn");
    return { possible: SBMM.touch.offline.possible(), why: SBMM.touch.offline.why(),
             status: s, line: document.getElementById("offlineStatus").textContent,
             disabled: btn ? btn.disabled : null,
             controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
  });
  console.log(`offline over file://: possible ${off.possible} · "${off.line}"`);
  if (off.possible) fail("a service worker registered over file:// — the ONE fetch exemption is http only", off);
  if (!off.why || !/http/.test(off.why)) fail("the offline button does not say why it cannot work here", off);
  if (off.controller) fail("a service worker is controlling a file:// page");
  if (errors.some(e => /service|worker|manifest/i.test(e)))
    fail("the file:// build logged an error about the worker or the manifest", errors.filter(e => /service|worker|manifest/i.test(e)));
}

{
  console.log("\n-- over http --");
  const hctx = await browser.newContext({ ...DEV, serviceWorkers: "allow" });
  const hp = await hctx.newPage();
  hp.setDefaultTimeout(240000);
  const herr = [];
  hp.on("pageerror", e => herr.push("pageerror: " + e.message));
  hp.on("console", m => { if (m.type() === "error") herr.push("console: " + m.text()); });
  await unlock(hp);
  await hp.goto(HTTP);
  await hp.waitForSelector("#loading", { state: "hidden", timeout: 300000 });
  await hp.waitForFunction(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    null, { timeout: 30000 }).catch(() => {});
  /* a first load registers but may not yet CONTROL the page; one reload does it */
  await hp.reload();
  await hp.waitForSelector("#loading", { state: "hidden", timeout: 300000 });
  const reg = await hp.evaluate(() => ({
    controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    possible: SBMM.touch.offline.possible()
  }));
  console.log(`http: worker registered and controlling ${reg.controller}`);
  if (!reg.controller) fail("the service worker never took control over http", reg);

  /* the manifest and the icons resolve */
  const assets = await hp.evaluate(async () => {
    const out = {};
    for (const u of ["manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
                     "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"]) {
      try { const r = await fetch(u, { cache: "no-store" }); out[u] = r.status; }
      catch (e) { out[u] = "ERR"; }
    }
    try { const m = await (await fetch("manifest.webmanifest")).json();
          out.name = m.name; out.display = m.display; out.icons = (m.icons || []).length; } catch (e) {}
    return out;
  });
  console.log(`  assets: ${JSON.stringify(assets)}`);
  for (const k of Object.keys(assets)) if (typeof assets[k] === "number" && assets[k] !== 200)
    fail("an icon or the manifest did not resolve", { k, status: assets[k] });
  if (assets.display !== "standalone" || assets.icons !== 3) fail("the manifest is not the one v17 asks for", assets);

  /* precache */
  const pre = await hp.evaluate(async () => {
    const prog = [];
    const r = await SBMM.touch.offline.precache(p => { if (prog.length < 3) prog.push(p.done); });
    return { r, prog };
  });
  console.log(`  precache: ${pre.r && pre.r.count} files, ${pre.r ? (pre.r.bytes / 1e6).toFixed(1) : "?"} MB`);
  if (!pre.r || !pre.r.ready) fail("the precache did not complete", pre);
  if (pre.r.count < 40) fail("the precache took fewer than 40 files — the URL list is wrong", pre.r);
  if (!pre.prog.length) fail("the precache reported no progress");

  const st1 = await hp.evaluate(() => SBMM.touch.offline.status());
  console.log(`  status: ready ${st1.ready}, ${st1.count} files, stale ${!!st1.stale}`);
  if (!st1.ready || st1.stale) fail("the status after a precache is wrong", st1);

  /* offline, and it still boots */
  await hctx.setOffline(true);
  const oerr = [];
  hp.on("pageerror", e => oerr.push("pageerror: " + e.message));
  await hp.reload();
  await hp.waitForSelector("#loading", { state: "hidden", timeout: 300000 })
    .catch(async () => fail("the app did not boot from the offline copy"));
  const offBoot = await hp.evaluate(() => ({
    dems: SBMM.dems.map(d => d.m.cell),
    elev: SBMM.elev(6371600, 2128900)[0],
    profile: SBMM.touch.profile()
  }));
  console.log(`  offline boot: grids ${offBoot.dems.join(",")} ft · elevation ${offBoot.elev.toFixed(2)} ft · ${offBoot.profile}`);
  if (offBoot.dems.join(",") !== "1,1,2") fail("the DEM stack did not decode from the cache", offBoot);
  if (!(offBoot.elev > 1200 && offBoot.elev < 1500)) fail("the cached terrain is wrong", offBoot);
  if (oerr.length) fail("errors booting offline", oerr.slice(0, 5));
  await hctx.setOffline(false);

  /* a changed index.html marks it stale */
  patchIndex = readFileSync(__res(SITE, "index.html"), "utf8").replace("<body>", "<body >");
  await hp.reload();
  await hp.waitForSelector("#loading", { state: "hidden", timeout: 300000 });
  await hp.waitForFunction(async () => {
    const s = await SBMM.touch.offline.status();
    return !!s.stale;
  }, null, { timeout: 20000 }).catch(() => {});
  const st2 = await hp.evaluate(() => SBMM.touch.offline.status());
  console.log(`  after one changed byte: stale ${!!st2.stale}`);
  if (!st2.stale) fail("a changed index.html did not mark the offline copy stale", st2);
  patchIndex = null;

  /* remove it */
  const rm = await hp.evaluate(async () => {
    await SBMM.touch.offline.remove();
    return SBMM.touch.offline.status();
  });
  console.log(`  removed: ready ${rm.ready}, ${rm.count} files`);
  if (rm.ready) fail("the offline copy was not removed", rm);

  if (herr.filter(e => !/favicon/.test(e)).length)
    fail("page errors over http", herr.slice(0, 6));
  await hctx.close();
}

/* ===================================================================== */
console.log("\npage errors:", errors.length ? errors.slice(0, 8) : "none");
console.log("warnings:", warned);
server.close();
await browser.close();
if (errors.some(e => !e.includes("favicon"))) { console.log("RESULT: errors present"); process.exit(2); }
console.log("RESULT: PASS");
