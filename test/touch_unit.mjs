/* Unit harness for the v17 gesture recogniser — no browser, no Playwright.

     node test/touch_unit.mjs

   `js/touch.js` is a normal SBMM module and it does touch the DOM, but the
   RECOGNISER inside it deliberately does not: it takes pointer-shaped records
   and calls handlers, which is exactly what makes its arithmetic testable in
   node. So this loads the whole file through `vm.runInThisContext` over a
   handful of stubs — the same technique test/kernels.mjs uses on
   js/compute.js — and then drives `SBMM.touch.recognizer(...)` with synthetic
   pointer sequences.

   Why bother when test/e2e_tablet.mjs drives real touches through CDP: because
   the browser harness costs three minutes and one of the two GPU slots on this
   box, and every recogniser bug found here is one that never reaches it. Run
   this after ANY change to the recogniser, before you reach for Playwright.

   Every check prints PASS/FAIL name got ref; any FAIL exits non-zero. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/* ------------------------------------------------------------------ */
/* the stubs: everything js/touch.js touches at LOAD time, and nothing more */
/* ------------------------------------------------------------------ */
const store = new Map();
const el = () => ({
  style: {}, hidden: true, className: "", textContent: "", innerHTML: "",
  offsetWidth: 0, offsetHeight: 0, children: [],
  appendChild() {}, addEventListener() {}, removeEventListener() {},
  querySelector: () => el(), querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {}, getAttribute: () => null, getContext: () => null,
  closest: () => null, contains: () => false, focus() {}, remove() {}
});
const G = {
  window: null,
  document: {
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    documentElement: { style: { setProperty() {} } },
    createElement: () => el(),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    visibilityState: "visible"
  },
  navigator: { maxTouchPoints: 5, hardwareConcurrency: 8 },
  location: { protocol: "file:", href: "file:///x/index.html" },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  },
  performance: { now: () => Date.now() },
  requestAnimationFrame: fn => setTimeout(() => fn(), 0),
  cancelAnimationFrame: id => clearTimeout(id),
  matchMedia: () => ({ matches: false }),
  setTimeout, clearTimeout, console,
  SBMM: { events: { on() {}, emit() {} } },
  toast() {}, copyText() {}
};
G.window = G;
G.globalThis = G;
vm.createContext(G);
vm.runInContext(readFileSync(resolve(ROOT, "js/touch.js"), "utf8"), G, { filename: "js/touch.js" });
const T = G.SBMM.touch;

/* ------------------------------------------------------------------ */
let fails = 0, checks = 0;
function ok(name, got, ref, tol) {
  checks++;
  const good = (tol == null)
    ? JSON.stringify(got) === JSON.stringify(ref)
    : Math.abs(got - ref) <= tol;
  if (!good) fails++;
  console.log(`${good ? "PASS" : "FAIL"} ${name.padEnd(46)} ${JSON.stringify(got)}`
    + (good ? "" : `   want ${JSON.stringify(ref)}${tol == null ? "" : " ±" + tol}`));
}

/* a fake clock, so long-press and double-tap are tested rather than raced */
let T0 = 1000;
const clock = () => T0;
const rec = (h, extra) => T.recognizer(h, Object.assign({ now: clock, penActive: () => false }, extra || {}));
const P = (id, x, y, type) => ({ pointerId: id, clientX: x, clientY: y, pointerType: type || "touch" });

/* ================================================================== */
console.log("\n-- tap, double-tap, two-finger tap --");
{
  const seen = [];
  const r = rec({ tap: g => seen.push(["tap", Math.round(g.x), Math.round(g.y)]),
                  doubletap: g => seen.push(["dbl", Math.round(g.x)]),
                  twofingertap: () => seen.push(["two"]),
                  longpress: () => seen.push(["long"]) });
  T0 = 1000; r.down(P(1, 100, 100)); T0 = 1080; r.up(P(1, 101, 100));
  ok("a short still press is a tap", seen[0], ["tap", 101, 100]);

  T0 = 1200; r.down(P(1, 101, 100)); T0 = 1260; r.up(P(1, 102, 101));
  ok("a second tap in place is a doubletap", seen[1], ["dbl", 102]);

  /* a third tap must NOT chain into another doubletap — the second consumed it */
  T0 = 1300; r.down(P(1, 102, 101)); T0 = 1340; r.up(P(1, 102, 101));
  ok("the tap after a doubletap is a tap", seen[2][0], "tap");

  /* too far apart in time */
  T0 = 3000; r.down(P(1, 102, 101)); T0 = 3050; r.up(P(1, 102, 101));
  T0 = 3600; r.down(P(1, 102, 101)); T0 = 3650; r.up(P(1, 102, 101));
  ok("400 ms apart is two taps, not a doubletap", [seen[3][0], seen[4][0]], ["tap", "tap"]);

  /* a moved press is a pan, not a tap */
  T0 = 4000; r.down(P(1, 200, 200)); T0 = 4030; r.move(P(1, 240, 200)); T0 = 4060; r.up(P(1, 240, 200));
  ok("a 40 px drag is not a tap", seen.length, 5);

  /* two fingers down and up together */
  T0 = 5000; r.down(P(1, 100, 100)); r.down(P(2, 160, 100));
  T0 = 5090; r.up(P(1, 100, 100)); r.up(P(2, 160, 100));
  ok("two fingers, tapped, is a twofingertap", seen[5], ["two"]);
}

console.log("\n-- long-press --");
{
  const seen = [];
  const r = rec({ longpress: g => seen.push(["long", Math.round(g.x)]), tap: () => seen.push(["tap"]) });
  /* the timer is a real setTimeout, so this half of it is asynchronous */
  T0 = 1000; r.down(P(1, 50, 50));
  await new Promise(res => setTimeout(res, 620));
  ok("500 ms still = longpress", seen[0], ["long", 50]);
  T0 = 1700; r.up(P(1, 50, 50));
  ok("the release after a longpress is not a tap", seen.length, 1);

  /* moving cancels it */
  T0 = 2000; r.down(P(1, 50, 50)); T0 = 2050; r.move(P(1, 90, 50));
  await new Promise(res => setTimeout(res, 620));
  T0 = 2700; r.up(P(1, 90, 50));
  ok("a moved press raises no longpress", seen.length, 1);
}

console.log("\n-- pan and flick --");
{
  let total = [0, 0], last = null, flick = null;
  const r = rec({ pan: g => { total = [total[0] + g.dx, total[1] + g.dy]; last = g; },
                  panend: g => { last = g; }, flick: g => { flick = g; } });
  T0 = 1000; r.down(P(1, 100, 100));
  for (let i = 1; i <= 10; i++) { T0 = 1000 + i * 10; r.move(P(1, 100 + i * 12, 100 - i * 4)); }
  T0 = 1110; r.up(P(1, 220, 60));
  ok("pan deltas sum to the whole drag", total, [120, -40]);
  ok("panend carries the total", [last.tx, last.ty], [120, -40]);
  ok("a fast release flicks", !!flick, true);
  ok("the flick velocity has the drag's sign", [Math.sign(flick.vx), Math.sign(flick.vy)], [1, -1]);
  ok("the flick velocity is ~1.2 px/ms", flick.vx, 1.2, 0.35);
}
{
  /* a slow release must NOT flick — a careful drag that stops is a parked view */
  let flick = null;
  const r = rec({ flick: g => { flick = g; } });
  T0 = 1000; r.down(P(1, 100, 100));
  for (let i = 1; i <= 6; i++) { T0 = 1000 + i * 200; r.move(P(1, 100 + i * 2, 100)); }
  T0 = 2400; r.up(P(1, 112, 100));
  ok("a slow drag does not flick", flick, null);
}

console.log("\n-- pinch: scale, midpoint, twist --");
/* A browser delivers ONE pointermove at a time, so a two-finger gesture arrives
   as a pair of half-transformed frames and each `pinch` event reports the frame
   it actually saw. That is what the rig integrates, so it is what is checked
   here: the SUM of the midpoint deltas and the PRODUCT of the per-move scales
   over a pair of moves, plus `totalScale`, which the recogniser measures from
   the gesture's own start and which is therefore exact at any moment. */
{
  let starts = 0, ends = 0, last = null;
  let sumX = 0, sumY = 0, prodK = 1, sumTw = 0;
  const zero = () => { sumX = sumY = sumTw = 0; prodK = 1; };
  const r = rec({ pinchstart: () => starts++, pinchend: () => ends++,
                  pinch: g => { last = g; sumX += g.dcx; sumY += g.dcy; prodK *= g.scale; sumTw += g.twist; } });
  T0 = 1000;
  r.down(P(1, 100, 200)); r.down(P(2, 200, 200));        // 100 px apart, midpoint (150,200)
  ok("pinchstart fired once", starts, 1);

  zero();
  T0 = 1050; r.move(P(1, 50, 200)); r.move(P(2, 250, 200));   // 200 apart, same midpoint
  ok("a doubled gap is scale 2 since the start", last.totalScale, 2, 1e-9);
  ok("the pair of moves scaled by 2", prodK, 2, 1e-9);
  ok("the midpoint did not move over the pair", [Math.round(sumX), Math.round(sumY)], [0, 0]);
  ok("no twist from a pure spread", sumTw, 0, 1e-9);

  zero();
  T0 = 1100; r.move(P(1, 80, 200)); r.move(P(2, 280, 200));   // both +30 px right
  ok("a translation does not scale over the pair", prodK, 1, 1e-9);
  ok("the midpoint moved by the translation", Math.round(sumX), 30);
  ok("totalScale is still 2", last.totalScale, 2, 1e-9);

  zero();
  const cx = 180, cy = 200, rr = 100, a = Math.PI / 6;      // rotate 30 deg about the midpoint
  T0 = 1150;
  r.move(P(1, cx - rr * Math.cos(a), cy - rr * Math.sin(a)));
  r.move(P(2, cx + rr * Math.cos(a), cy + rr * Math.sin(a)));
  ok("a 30 deg rotation reports 30 deg of twist", sumTw * 180 / Math.PI, 30, 0.5);
  ok("rotation alone does not scale over the pair", prodK, 1, 1e-6);
  ok("totalTwist measures from the gesture start", last.totalTwist * 180 / Math.PI, 30, 0.5);

  T0 = 1200; r.up(P(1, 0, 0)); r.up(P(2, 0, 0));
  ok("pinchend fired once", ends, 1);
}
{
  /* lifting ONE finger out of a pinch resumes a pan from where the other IS,
     not from the gap between them — the v11 lurch this replaces */
  let resumed = null, jump = null;
  const r = rec({ panstart: g => { if (g.resumed) resumed = g; }, pan: g => { jump = g; } });
  T0 = 1000; r.down(P(1, 100, 100)); r.down(P(2, 300, 100));
  T0 = 1050; r.up(P(2, 300, 100));
  ok("one finger up resumes a pan", !!resumed, true);
  ok("it resumes at the surviving finger", [resumed.x, resumed.y], [100, 100]);
  T0 = 1100; r.move(P(1, 110, 100));
  ok("the next move is 10 px, not 200", jump.dx, 10, 1e-9);
}

console.log("\n-- three fingers --");
{
  let dy = 0, starts = 0;
  const r = rec({ threestart: () => starts++, three: g => { dy += g.dy; } });
  T0 = 1000; r.down(P(1, 100, 300)); r.down(P(2, 200, 300)); r.down(P(3, 300, 300));
  ok("three fingers start a three-finger gesture", starts, 1);
  T0 = 1050; r.move(P(1, 100, 260)); r.move(P(2, 200, 260)); r.move(P(3, 300, 260));
  ok("the three-finger drag reports the centroid's dy", Math.round(dy), -40);
}

console.log("\n-- the mouse never enters the recogniser --");
{
  let n = 0;
  const r = rec({ tap: () => n++, pan: () => n++, panstart: () => n++, longpress: () => n++ });
  T0 = 1000;
  ok("a mouse pointerdown is refused", r.down(P(9, 10, 10, "mouse")), false);
  r.move(P(9, 40, 10, "mouse"));
  r.up(P(9, 40, 10, "mouse"));
  ok("no handler ran for the mouse", n, 0);
}

console.log("\n-- §5a palm rejection and the pen's finger modifier --");
{
  /* while the pen is live, a finger starts nothing at all */
  let n = 0;
  const r = rec({ tap: () => n++, panstart: () => n++, pan: () => n++, longpress: () => n++ },
                { penActive: () => true });
  ok("a finger is refused while the pen is live", r.down(P(5, 10, 10, "touch")), false);
  r.move(P(5, 60, 10, "touch"));
  r.up(P(5, 60, 10, "touch"));
  ok("it started no gesture", n, 0);
}
{
  /* a pen down, then a finger held: the finger is a MODIFIER, and a pen drag
     with it held is a pan rather than an orbit */
  let mod = null;
  const r = rec({ pan: g => { mod = g; } }, { penActive: () => true });
  T0 = 1000; r.down(P(7, 100, 100, "pen"));
  r.down(P(8, 300, 300, "touch"));
  ok("the held finger is a modifier, not a pointer", [r.count(), r.mods()], [1, 1]);
  T0 = 1030; r.move(P(7, 130, 100, "pen"));
  ok("the pen drag is flagged as a modifier drag", mod.modifier, true);
  ok("its delta is the pen's own", mod.dx, 30, 1e-9);
  r.up(P(8, 300, 300, "touch"));
  ok("lifting the finger drops the modifier", r.mods(), 0);
  T0 = 1060; r.move(P(7, 160, 100, "pen"));
  ok("with the finger lifted it is a plain drag", mod.modifier, false);
  r.up(P(7, 160, 100, "pen"));
}
{
  /* a pen tap is a tap: the Pencil is a pointer, not a gesture-free device */
  let got = null;
  const r = rec({ tap: g => { got = g; } });
  T0 = 1000; r.down(P(3, 40, 40, "pen")); T0 = 1050; r.up(P(3, 41, 40, "pen"));
  ok("a pen tap taps", got && got.pointerType, "pen");
}

console.log("\n-- momentum settles (it must, or the 3D view renders for ever) --");
{
  let steps = 0, done = false;
  const h = T.momentum(2, 0, () => steps++, () => { done = true; });
  await new Promise(res => setTimeout(res, 900));
  ok("momentum stepped", steps > 3, true);
  ok("momentum finished", done, true);
  ok("momentum is no longer active", h.active(), false);
  /* 2 px/ms decaying at 0.92 reaches 0.02 in ln(0.01)/ln(0.92) = 55 frames */
  ok("it took ~55 frames to settle", steps, 55, 4);
}
{
  let steps = 0;
  const h = T.momentum(2, 0, () => steps++);
  h.cancel();
  const at = steps;
  await new Promise(res => setTimeout(res, 200));
  ok("a cancelled momentum stops immediately", steps, at);
}

console.log("\n-- the profile detector --");
/* Real viewports, both axes. The phone test is on the LONGER edge, because an
   iPad in portrait is 834 px WIDE — a width-only rule reads that as a phone and
   lays it out as one, which is the regression test/e2e_tablet.mjs caught. */
{
  const view = (w, h) => { G.window.innerWidth = w; G.window.innerHeight = h; };
  G.navigator.maxTouchPoints = 5;
  view(1194, 834);
  ok("iPad landscape 1194x834 is a tablet", T.sniff(), "tablet");
  view(834, 1194);
  ok("iPad PORTRAIT 834x1194 is still a tablet", T.sniff(), "tablet");
  view(1024, 768);
  ok("an older iPad 1024x768 is a tablet", T.sniff(), "tablet");
  view(507, 834);
  ok("Split View 507x834 is a phone", T.sniff(), "phone");
  view(412, 839);
  ok("a Pixel 7 412x839 is a phone", T.sniff(), "phone");
  view(839, 412);
  ok("the same phone in landscape is still a phone", T.sniff(), "phone");

  view(1194, 834);
  T.override("off");
  ok("the override forces desktop", T.sniff(), "desktop");
  T.override("auto");
  ok("and releases it", T.sniff(), "tablet");
  G.navigator.maxTouchPoints = 0;
  ok("no touch capability at all is desktop", T.sniff(), "desktop");
  T.override("on");
  ok("the override forces touch on regardless", T.sniff(), "tablet");
  T.override("auto");
  G.navigator.maxTouchPoints = 5;
}

console.log("\n-- angDelta wraps the short way --");
{
  const d = T.angDelta;
  /* -3.0 - 3.1 = -6.1 rad; the short way round is -6.1 + 2pi = +0.183 rad */
  ok("+10.5 deg across the seam", d(-3.0, 3.1) * 180 / Math.PI, 10.5, 0.1);
  ok("-10.5 deg across the seam", d(3.1, -3.0) * 180 / Math.PI, -10.5, 0.1);
  ok("no wrap needed", d(0.5, 0.2), 0.3, 1e-9);
}

console.log(`\n${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
