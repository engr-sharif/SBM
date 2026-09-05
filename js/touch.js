/* SBMM Site Explorer — TOUCH: three profiles, one gesture recogniser, the loupe,
   the Done bar, and the (opt-in) offline copy.  docs/V17_TOUCH_SPEC.md

   The problem this file solves is not "the phone" — docs/V11_SPEC.md §4 solved
   that, and `body.field` is untouched here. It is the iPad: 1024–1366 px wide,
   a coarse pointer, and therefore left in the DESKTOP layout by the v11 sniff,
   which is exactly what the user likes. What the desktop layout assumes is a
   MOUSE — hover toolbars, right-click menus, wheel zoom, 22-px buttons — and
   none of that exists under a thumb.

   Three profiles, one detector (§1):

     phone    coarse pointer AND innerWidth <= 900   -> body.field + body.touch
     tablet   touch-capable AND innerWidth > 900     -> body.touch only
     desktop  everything else                        -> neither

   `body.touch` is the ONE switch every touch style keys off, the same way
   `body.field` is for the phone. Nothing in css/app.css's touch block applies
   without it, and nothing in this file runs without either the profile or an
   event whose `pointerType` says a finger sent it — which is what makes "the
   desktop is untouched" a property of the code. test/e2e.mjs, unchanged, is
   the proof; test/e2e_field.mjs, unchanged, is the proof for the phone.

   PER EVENT, NOT PER PROFILE. A Surface has a mouse and a screen; an iPad with
   a Magic Keyboard reports `pointer: fine` while `any-pointer` is still
   coarse; an Apple Pencil is `pen` and may hover. So every gesture surface
   branches on `e.pointerType` — touch/pen take the touch rules, mouse takes
   today's rules — whatever the profile says. The profile only sizes chrome and
   picks defaults.

   ONE RECOGNISER. `gestures(el, handlers)` is the only implementation of tap /
   double-tap / two-finger tap / long-press / pan / pinch / twist / three-finger
   drag / flick in this app. The 3D rig, the sheet viewer and the map sketch all
   use it. Writing a second pinch is how two surfaces come to disagree about
   what a pinch is.

   THE ONE fetch() EXEMPTION. CLAUDE.md's first hard constraint is that no app
   code may fetch anything, because the app runs from file://. `sw.js` is the
   single exception the spec grants, and it is not the app: it is registered
   ONLY when `location.protocol` is http: or https: (GitHub Pages, or the
   harness's own static server), it caches its OWN origin only, and over
   file:// nothing here registers, nothing fetches, and the Help button says
   why. */
"use strict";

SBMM.touch = (function () {

  const OV_KEY = "sbmm.touch.v1";          // "auto" | "on" | "off"
  const SW_URL = "sw.js";

  let lastProfile = null;
  let lastTouch = 0;                       // performance.now() of the last touch/pen event
  let lastKind = "mouse";                  // "mouse" | "touch" | "pen" — the last pointerdown
  let penAt = 0;                           // performance.now() of the last pen event
  let penButtons = 0;                      // >0 while a pen tip is on the glass
  let wired = false;

  /* §5a — palm rejection. While the tip is down, or within PALM_MS of it having
     been down, a `touch` pointer is the hand resting on the glass, not a
     gesture. Every gesture surface asks this ONE question; two fingers with no
     pen in play are still a pinch. */
  const PALM_MS = 150;
  function penDown() { return penButtons > 0; }
  function penRecent(ms) { return penButtons > 0 || (DEF.now() - penAt) < (ms || PALM_MS); }
  /* What the user is holding right now. The chrome sizes hit targets from THIS
     rather than from the profile: an iPad with a Pencil in hand is a precise
     pointer on the same screen a thumb was coarse on a second ago. */
  function lastPointer() { return lastKind; }
  function precise() { return lastKind !== "touch"; }

  /* ================================================================== */
  /* 1. the detector                                                     */
  /* ================================================================== */
  /* iPadOS reports a DESKTOP user agent, so a UA sniff is worse than useless
     here — it is actively wrong. Two capability questions instead, and either
     one is enough: `any-pointer: coarse` is true whenever ANY attached pointer
     is coarse (a trackpad does not hide the touchscreen), and maxTouchPoints
     answers on the browsers whose media query lies. */
  function touchCapable() {
    try {
      if (window.matchMedia && window.matchMedia("(any-pointer: coarse)").matches) return true;
    } catch (e) {}
    return (navigator.maxTouchPoints || 0) > 1;
  }

  function override(v) {
    if (v === undefined) {
      try { const s = localStorage.getItem(OV_KEY); return s === "on" || s === "off" ? s : "auto"; }
      catch (e) { return "auto"; }
    }
    v = (v === "on" || v === "off") ? v : "auto";
    try { v === "auto" ? localStorage.removeItem(OV_KEY) : localStorage.setItem(OV_KEY, v); } catch (e) {}
    apply(true);
    return v;
  }

  /* HOW BIG IS THE GLASS — and it is not `innerWidth`.

     Two corrections to the obvious answer, both of them found by
     test/e2e_tablet.mjs and both of them real on hardware, not test artefacts:

     (i) THE LONGER EDGE, not the width. An iPad in PORTRAIT is 834 x 1194:
     834 px wide, which a width-only rule reads as a phone and lays out as one
     — the exact thing v17 exists to avoid. A viewport with 1194 px on some
     axis holds the desktop layout in the other orientation, so it is a tablet
     in both. Split View at 507 x 834 has 834 as its longer edge and IS a
     phone, which is what §1 asks for; a Pixel 7 at 412 x 839 is 839 and stays
     one. The 900-px threshold is v11's, unmoved.

     (ii) `innerWidth` IS THE LAYOUT VIEWPORT, AND A PAGE CAN FORCE IT WIDER
     THAN THE SCREEN. Ask this app at 507 x 834 and it answers 828 x 1361: the
     top bar under `body.touch` carries 22 buttons at 44 px, its min-content
     width is ~828 px, and the browser widens the layout viewport (and scales
     the page down) rather than clip it. So the app measured its own top bar
     and concluded it was on a tablet. `screen` is not the answer on its own
     either — iPadOS reports the whole 1194-px screen to a 507-px Split View
     pane. The smaller of the two on each axis is right in both directions: a
     page can be laid out wider than the glass, and the glass is never wider
     than the screen. */
  function edge() {
    const sw = (window.screen && window.screen.width) || Infinity;
    const sh = (window.screen && window.screen.height) || Infinity;
    const w = Math.min(window.innerWidth || Infinity, sw);
    const h = Math.min(window.innerHeight || Infinity, sh);
    return Math.max(isFinite(w) ? w : 0, isFinite(h) ? h : 0);
  }
  function sniff() {
    const ov = override();
    if (ov === "off") return "desktop";
    if (ov !== "on" && !touchCapable()) return "desktop";
    return edge() <= 900 ? "phone" : "tablet";
  }

  /* What the APP is running as. Field mode wins the phone half, because a
     stored field preference is a decision someone made and the viewport is
     only a guess — someone who turned field mode on at a desk meant it. */
  function profile() {
    if (SBMM.field && SBMM.field.on()) return "phone";
    return sniff();
  }
  function on() { return document.body.classList.contains("touch"); }

  /* Set body.touch, and — only when the device is genuinely touch-capable and
     the user has expressed no preference — follow the viewport across the
     phone/tablet line. An iPad in Split View at 507 px IS a phone. */
  function apply(fromOverride) {
    const p = profile();
    document.body.classList.toggle("touch", p !== "desktop");
    if (p !== lastProfile) {
      lastProfile = p;
      if (SBMM.events) SBMM.events.emit("touch", { profile: p });
    }
    if (fromOverride && SBMM.shell) SBMM.shell.relayout();
    return p;
  }

  function autoDetect() {
    lastProfile = null;
    return apply(false);
  }

  /* the resize / rotation / Split View path (§2) */
  let rt = 0;
  function onResize() {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const want = sniff();
      /* the phone half: v11 owns body.field, so ask it rather than setting it.
         Never against a stored preference, and never with `persist` — an
         orientation change must not rewrite what the user chose. */
      if (SBMM.field && override() !== "off" && touchCapable()
          && (!SBMM.field.stored || SBMM.field.stored() == null)) {
        const wantField = want === "phone";
        if (wantField !== SBMM.field.on()) SBMM.field.set(wantField, { persist: false });
      }
      apply(false);
      syncViewport();
      if (SBMM.shell) SBMM.shell.relayout();
    }, 150);
  }

  /* The on-screen keyboard shrinks the VISUAL viewport, not innerHeight. The
     command bar and every modal are positioned off `--kbInset` so they stay
     above it rather than under it. */
  function syncViewport() {
    const vv = window.visualViewport;
    let inset = 0;
    if (vv) inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kbInset", inset + "px");
    return inset;
  }

  /* ================================================================== */
  /* 2. the gesture recogniser (§1)                                      */
  /* ================================================================== */
  /* Deliberately free of the DOM so test/touch_unit.mjs can drive it with
     synthetic pointer records and check the arithmetic without a browser.
     `gestures(el, h)` below is the thin part that wires real events to it. */
  const DEF = {
    longPressMs: 500, longPressPx: 8,
    tapMs: 300, tapPx: 20,
    doubleMs: 300, doublePx: 20,
    panPx: 4,
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    /* overridden by test/touch_unit.mjs, which has no pen and no document */
    penActive: () => penRecent()
  };

  function angDelta(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function recognizer(h, opts) {
    h = h || {};
    const o = Object.assign({}, DEF, opts || {});
    const pts = new Map();                 // id -> {x,y,x0,y0,t0,type}
    let mode = null;                       // "pan" | "pinch" | "three"
    let base = null;                       // the two-finger frame at the last move
    let baseStart = null;                  // the two-finger frame at gesture start
    let three0 = null;                     // {cy, y}
    let maxN = 0, moved = false, longFired = false, startT = 0, cancelled = false;
    const mods = new Set();                // §5a: fingers held down while the pen draws
    let vx = 0, vy = 0, vt = 0;
    let longTimer = null;
    let lastTap = null;
    let anchor = null;                     // the single-pointer position at the last move

    const clearLong = () => { if (longTimer) { clearTimeout(longTimer); longTimer = null; } };
    const call = (k, a) => { const f = h[k]; if (f) f(a); };

    function two() {
      const a = [...pts.values()];
      if (a.length < 2) return null;
      const dx = a[1].x - a[0].x, dy = a[1].y - a[0].y;
      return { d: Math.hypot(dx, dy) || 1e-6,
               cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2,
               ang: Math.atan2(dy, dx) };
    }
    function centre() {
      let sx = 0, sy = 0;
      for (const p of pts.values()) { sx += p.x; sy += p.y; }
      const n = pts.size || 1;
      return { cx: sx / n, cy: sy / n };
    }

    function down(e) {
      if (e.pointerType === "mouse") return false;
      /* §5a palm rejection: a finger that arrives while the pen is (or has just
         been) on the glass is the hand, not a gesture. It is remembered as a
         MODIFIER instead of being dropped, because "pen drag with a finger
         held" is a real gesture — the pan — and the pen surfaces read
         `g.modifier` to tell the two apart. */
      if (e.pointerType === "touch" && o.penActive()) { mods.add(e.pointerId); return false; }
      const t = o.now();
      if (!pts.size) { maxN = 0; moved = false; longFired = false; cancelled = false; startT = t; vx = vy = 0; vt = t; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: t, type: e.pointerType });
      maxN = Math.max(maxN, pts.size);

      if (pts.size === 1) {
        anchor = { x: e.clientX, y: e.clientY };
        mode = "pan";
        call("panstart", { x: e.clientX, y: e.clientY, pointerType: e.pointerType, orig: e.orig || e });
        clearLong();
        longTimer = setTimeout(() => {
          longTimer = null;
          if (pts.size !== 1 || moved || cancelled) return;
          longFired = true;
          const p = [...pts.values()][0];
          call("longpress", { x: p.x, y: p.y, pointerType: p.type, orig: e.orig || e });
        }, o.longPressMs);
      } else if (pts.size === 2) {
        clearLong();
        if (mode === "pan") call("panend", { x: anchor.x, y: anchor.y, cancelled: true });
        mode = "pinch";
        base = baseStart = two();
        call("pinchstart", { cx: base.cx, cy: base.cy, d: base.d });
      } else if (pts.size === 3) {
        clearLong();
        if (mode === "pinch") call("pinchend", { cancelled: true });
        mode = "three";
        const c = centre();
        three0 = { cy: c.cy, cx: c.cx };
        call("threestart", { cx: c.cx, cy: c.cy });
      }
      return true;
    }

    function move(e) {
      if (mods.has(e.pointerId)) return false;
      const p = pts.get(e.pointerId);
      if (!p) return false;
      const t = o.now();
      const px = p.x, py = p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(p.x - p.x0, p.y - p.y0) > o.panPx) { moved = true; clearLong(); }

      if (mode === "pinch" && pts.size >= 2) {
        const now = two();
        if (!now || !base) return true;
        call("pinch", {
          scale: now.d / base.d,                       // since the last move
          totalScale: now.d / baseStart.d,             // since the gesture began
          cx: now.cx, cy: now.cy,
          dcx: now.cx - base.cx, dcy: now.cy - base.cy,
          twist: angDelta(now.ang, base.ang),
          totalTwist: angDelta(now.ang, baseStart.ang),
          d: now.d, startCx: baseStart.cx, startCy: baseStart.cy
        });
        base = now;
        return true;
      }
      if (mode === "three" && pts.size >= 3) {
        const c = centre();
        call("three", { cx: c.cx, cy: c.cy, dy: c.cy - three0.cy, dx: c.cx - three0.cx });
        three0 = c;
        return true;
      }
      if (mode === "pan" && pts.size === 1) {
        const dt = Math.max(1, t - vt);
        const dx = p.x - px, dy = p.y - py;
        /* an EMA, so one jittery sample cannot throw a flick */
        vx = vx * 0.7 + (dx / dt) * 0.3;
        vy = vy * 0.7 + (dy / dt) * 0.3;
        vt = t;
        call("pan", { x: p.x, y: p.y, dx, dy, tx: p.x - p.x0, ty: p.y - p.y0,
                      vx, vy, pointerType: p.type, moved,
                      /* §5a: a pen drag with a finger held down is a PAN */
                      modifier: p.type === "pen" && mods.size > 0 });
        anchor = { x: p.x, y: p.y };
        return true;
      }
      return true;
    }

    function up(e, isCancel) {
      if (mods.delete(e.pointerId)) return false;
      const p = pts.get(e.pointerId);
      if (!p) return false;
      const t = o.now();
      /* a pointerup carries a final position of its own, and on a tap it is the
         only position after the down — without this a tap reports where the
         finger LANDED rather than where it left, which is a pixel or two out on
         every tap and the whole gesture out on a slow drag that ends between
         two moves */
      if (e.clientX != null) { p.x = e.clientX; p.y = e.clientY; }
      pts.delete(e.pointerId);
      clearLong();

      if (mode === "pinch" && pts.size < 2) {
        call("pinchend", { cancelled: !!isCancel });
        if (pts.size === 1) {
          /* one finger lifted out of a pinch: carry on panning from where the
             other one IS, not from the gap between them */
          const a = [...pts.values()][0];
          a.x0 = a.x; a.y0 = a.y;
          anchor = { x: a.x, y: a.y };
          vx = vy = 0; vt = t;
          mode = "pan";
          call("panstart", { x: a.x, y: a.y, pointerType: a.type, resumed: true });
          return true;
        }
        mode = null;
      } else if (mode === "three" && pts.size < 3) {
        call("threeend", { cancelled: !!isCancel });
        mode = pts.size === 2 ? "pinch" : (pts.size === 1 ? "pan" : null);
        if (mode === "pinch") { base = baseStart = two(); }
        if (mode === "pan") { const a = [...pts.values()][0]; a.x0 = a.x; a.y0 = a.y; anchor = { x: a.x, y: a.y }; }
        if (pts.size) return true;
      } else if (mode === "pan" && !pts.size) {
        const flick = !isCancel && moved && Math.hypot(vx, vy) > 0.15;
        call("panend", { x: p.x, y: p.y, tx: p.x - p.x0, ty: p.y - p.y0,
                         vx, vy, flick, cancelled: !!isCancel });
        if (flick) call("flick", { vx, vy, x: p.x, y: p.y });
        mode = null;
      }

      if (pts.size) return true;

      /* every finger is up: decide what the whole gesture was */
      const dur = t - startT;
      const drift = Math.hypot(p.x - p.x0, p.y - p.y0);
      if (!isCancel && !longFired && !moved && dur <= o.tapMs && drift <= o.tapPx) {
        if (maxN === 1) {
          const dbl = lastTap && (t - lastTap.t) <= o.doubleMs
            && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) <= o.doublePx;
          if (dbl) { lastTap = null; call("doubletap", { x: p.x, y: p.y, pointerType: p.type }); }
          else { lastTap = { x: p.x, y: p.y, t }; call("tap", { x: p.x, y: p.y, pointerType: p.type }); }
        } else if (maxN === 2) {
          lastTap = null;
          call("twofingertap", { x: p.x, y: p.y, pointerType: p.type });
        }
      }
      mode = null; base = baseStart = null; maxN = 0; moved = false; longFired = false;
      call("end", {});
      return true;
    }

    function cancel(e) { cancelled = true; return up(e, true); }
    function reset() { pts.clear(); mods.clear(); clearLong(); mode = null; base = baseStart = null; maxN = 0; moved = false; }

    return { down, move, up, cancel, reset,
             count: () => pts.size, mods: () => mods.size, mode: () => mode,
             points: () => [...pts.values()].map(p => ({ x: p.x, y: p.y })) };
  }

  /* Wire a real element to a recogniser. `touch-action: none` is set here as
     well as in CSS: without it the browser claims a two-finger drag for a page
     scroll before the rig ever sees it. */
  function gestures(el, h, opts) {
    const rec = recognizer(h, opts);
    const note = e => { if (e.pointerType !== "mouse") lastTouch = DEF.now(); };
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", e => {
      note(e);
      if (e.pointerType === "mouse") return;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      rec.down(e);
    });
    el.addEventListener("pointermove", e => { note(e); if (e.pointerType !== "mouse") rec.move(e); });
    el.addEventListener("pointerup", e => { note(e); if (e.pointerType !== "mouse") rec.up(e); });
    el.addEventListener("pointercancel", e => { note(e); if (e.pointerType !== "mouse") rec.cancel(e); });
    return rec;
  }

  /* ================================================================== */
  /* 3. momentum                                                         */
  /* ================================================================== */
  /* A decaying step per frame (v *= 0.92, stop under 0.02 px/ms), cancelled by
     any touch. It MUST end: an animation that keeps asking for frames leaves
     the 3D view rendering for ever, and test/perf.mjs fails an idle view that
     still renders. Nothing is allocated per frame. */
  function momentum(vx, vy, step, done) {
    let id = 0, killed = false;
    function tick() {
      id = 0;
      if (killed) return;
      if (Math.hypot(vx, vy) < 0.02) { if (done) done(); return; }
      step(vx * 16, vy * 16);
      vx *= 0.92; vy *= 0.92;
      id = requestAnimationFrame(tick);
    }
    id = requestAnimationFrame(tick);
    return {
      cancel() { killed = true; if (id) cancelAnimationFrame(id); id = 0; },
      active() { return !killed && !!id; }
    };
  }

  /* ================================================================== */
  /* 4. the loupe (§4/§5)                                                */
  /* ================================================================== */
  /* ONE canvas, reused by the map and by the sheet viewer. A finger covers the
     point it is placing, so the only way to place a vertex precisely by hand is
     to show, somewhere the finger is not, what is under it. 2.5x, 120 px, above
     and to the left of the touch, with a crosshair at the exact point.
     It lives in the 4900-4999 touch-furniture band (see css/app.css), which is
     above the sheet windows (4000-4899) and below the modals. */
  const LOUPE_PX = 120, LOUPE_ZOOM = 2.5;
  const loupe = (function () {
    let el = null, cv = null, ctx = null, painter = null, shown = false;

    function ensure() {
      if (el) return el;
      el = document.createElement("div");
      el.id = "touchLoupe";
      el.hidden = true;
      cv = document.createElement("canvas");
      cv.width = cv.height = LOUPE_PX;
      el.appendChild(cv);
      const cross = document.createElement("span");
      cross.className = "lpcross";
      el.appendChild(cross);
      document.body.appendChild(el);
      ctx = cv.getContext("2d");
      return el;
    }

    /* `paint(ctx, size, zoom)` draws the magnified content with the point of
       interest at the CENTRE of the canvas. Callers do the source maths — the
       loupe knows nothing about sheets or maps. */
    function show(paint, x, y) {
      ensure();
      painter = paint;
      shown = true;
      el.hidden = false;
      at(x, y);
      return el;
    }
    function at(x, y) {
      if (!shown) return;
      draw();
      /* above-left of the finger; flipped when that would leave the viewport */
      let lx = x - LOUPE_PX - 18, ly = y - LOUPE_PX - 18;
      if (lx < 6) lx = Math.min(window.innerWidth - LOUPE_PX - 6, x + 18);
      if (ly < 6) ly = Math.min(window.innerHeight - LOUPE_PX - 6, y + 18);
      el.style.left = Math.round(lx) + "px";
      el.style.top = Math.round(ly) + "px";
    }
    function draw() {
      if (!ctx || !painter) return;
      ctx.save();
      ctx.clearRect(0, 0, LOUPE_PX, LOUPE_PX);
      ctx.fillStyle = "#0E1418";
      ctx.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
      try { painter(ctx, LOUPE_PX, LOUPE_ZOOM); } catch (e) { /* never break a gesture */ }
      ctx.restore();
    }
    function hide() { shown = false; painter = null; if (el) el.hidden = true; }
    return { show, at, hide, visible: () => shown, size: LOUPE_PX, zoom: LOUPE_ZOOM,
             el: () => el };
  })();

  /* A flat snapshot of everything drawable inside a box — the map's tile,
     raster and vector canvases plus its image overlays. `html2canvas` does not
     exist in this app and never will (no CDNs), so this walks the DOM itself
     and composites what it finds, in document order, at its own screen
     rectangle. It is taken ONCE at the start of a press: re-reading a dozen
     canvases per pointermove is what makes a loupe stutter. */
  function snapshot(host) {
    const r = host.getBoundingClientRect();
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(r.width));
    c.height = Math.max(1, Math.round(r.height));
    const g = c.getContext("2d");
    g.fillStyle = "#0E1418";
    g.fillRect(0, 0, c.width, c.height);
    const nodes = host.querySelectorAll("canvas, img");
    for (const n of nodes) {
      const nr = n.getBoundingClientRect();
      if (!nr.width || !nr.height) continue;
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      g.globalAlpha = parseFloat(cs.opacity);
      if (!(g.globalAlpha > 0)) { g.globalAlpha = 1; continue; }
      try { g.drawImage(n, nr.left - r.left, nr.top - r.top, nr.width, nr.height); }
      catch (e) { /* a tainted or not-yet-decoded source is skipped, not fatal */ }
    }
    g.globalAlpha = 1;
    return { canvas: c, rect: r };
  }
  /* The painter a snapshot gives you: magnify around a CLIENT point. The point
     is carried on the function itself (`painter.at(x, y)`) so a pointermove
     re-aims it without rebuilding the closure or re-reading the DOM. */
  function snapPainter(snap) {
    const p = { x: 0, y: 0 };
    const fn = (ctx, size, zoom) => {
      const src = size / zoom;
      const sx = (p.x - snap.rect.left) - src / 2;
      const sy = (p.y - snap.rect.top) - src / 2;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(snap.canvas, sx, sy, src, src, 0, 0, size, size);
    };
    fn.at = (x, y) => { p.x = x; p.y = y; return fn; };
    return fn;
  }

  /* ================================================================== */
  /* 5. the Done bar (§4/§5)                                             */
  /* ================================================================== */
  /* Enter, Backspace and Esc have no touch equivalent, so a sketch open under
     body.touch gets the three of them as 44-px buttons. One element, shared by
     the map and by every sheet window, in the same band as the loupe. */
  const doneBar = (function () {
    let el = null, cur = null;
    function ensure() {
      if (el) return el;
      el = document.createElement("div");
      el.id = "touchDone";
      el.hidden = true;
      el.innerHTML =
        `<span class="tdlbl"></span>` +
        `<button type="button" class="tdb" data-td="undo">Undo vertex</button>` +
        `<button type="button" class="tdb" data-td="cancel">Cancel</button>` +
        `<button type="button" class="tdb prim" data-td="done">Done</button>`;
      document.body.appendChild(el);
      el.addEventListener("click", e => {
        const b = e.target.closest(".tdb");
        if (!b || !cur) return;
        const fn = cur[b.dataset.td];
        if (fn) fn();
      });
      return el;
    }
    function show(spec) {
      ensure();
      cur = spec || {};
      el.querySelector(".tdlbl").textContent = cur.label || "";
      el.querySelector('[data-td="undo"]').hidden = !cur.undo;
      el.hidden = false;
      return el;
    }
    function hide() { cur = null; if (el) el.hidden = true; }
    return { show, hide, visible: () => !!(el && !el.hidden), el: () => el };
  })();

  /* ================================================================== */
  /* 6. long-press = right-click, and the tooltip chip (§5)              */
  /* ================================================================== */
  /* Leaflet 1.9 does not synthesise `contextmenu` for touch, so a long press on
     the map, on a feature or on a vertex reaches nothing at all. The
     recogniser does it: 500 ms, <= 8 px of drift, cancelled by movement, and
     dispatched as a real `contextmenu` MouseEvent at the same client point so
     every existing handler answers it unchanged. */
  function fireContextMenu(x, y, target) {
    const el = target || document.elementFromPoint(x, y);
    if (!el) return false;
    const ev = new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 2, buttons: 2
    });
    el.dispatchEvent(ev);
    return true;
  }

  /* A tooltip has no touch equivalent either, and the app's tooltips carry the
     keyboard shortcut — the one place a tablet user finds out a key exists. So
     a long press on a button SHOWS it and swallows the tap that would
     otherwise have fired the button. */
  let chip = null, chipT = 0;
  function tip(el) {
    const txt = el && el.getAttribute("title");
    if (!txt) return false;
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "touchTip";
      chip.hidden = true;
      document.body.appendChild(chip);
    }
    chip.textContent = txt;
    chip.hidden = false;
    const r = el.getBoundingClientRect();
    chip.style.left = Math.round(Math.max(6, Math.min(window.innerWidth - chip.offsetWidth - 6,
      r.left + r.width / 2 - chip.offsetWidth / 2))) + "px";
    chip.style.top = Math.round(r.bottom + 8 > window.innerHeight - 40 ? r.top - chip.offsetHeight - 8 : r.bottom + 8) + "px";
    clearTimeout(chipT);
    chipT = setTimeout(hideTip, 2600);
    return true;
  }
  function hideTip() { if (chip) chip.hidden = true; }

  /* Every pointer event in the app passes through here first, in the capture
     phase on `document`, so `lastPointer()` and the palm clock are true for
     every surface without any of them having to report in. */
  function wirePointerKind() {
    const note = e => {
      if (e.pointerType === "pen") {
        lastKind = "pen"; penAt = DEF.now(); lastTouch = penAt;
        if (e.type === "pointerdown") penButtons = 1;
        else if (e.type === "pointerup" || e.type === "pointercancel") { penButtons = 0; penAt = DEF.now(); }
        return;
      }
      if (e.type !== "pointerdown" && e.type !== "pointermove") return;
      if (e.pointerType === "touch") { lastKind = "touch"; lastTouch = DEF.now(); }
      else if (e.type === "pointerdown") lastKind = "mouse";
    };
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
      document.addEventListener(t, note, true);
  }

  /* the document-level long-press that serves both of the above */
  function wireLongPress() {
    let armed = null, timer = null, fired = false;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; armed = null; };
    document.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse") return;
      lastTouch = DEF.now();
      if (!on()) return;
      const t = e.target;
      const btn = t && t.closest && t.closest("button[title], .minib[title], .toolbtn[title], .navbtn[title], .railbtn[title], .dtab[title]");
      fired = false;
      armed = { x: e.clientX, y: e.clientY, btn, target: t };
      timer = setTimeout(() => {
        timer = null;
        if (!armed) return;
        if (armed.btn) { fired = tip(armed.btn); }
        armed = null;
      }, DEF.longPressMs);
    }, true);
    document.addEventListener("pointermove", e => {
      if (e.pointerType === "mouse" || !armed) return;
      if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) > DEF.longPressPx) clear();
    }, true);
    for (const t of ["pointerup", "pointercancel"])
      document.addEventListener(t, () => clear(), true);
    /* the press showed a tooltip; the tap that follows it must not also fire
       the button it was asking about */
    document.addEventListener("click", e => {
      if (!fired) return;
      fired = false;
      e.stopPropagation(); e.preventDefault();
    }, true);
  }

  /* ================================================================== */
  /* 7. the offline copy — the ONE fetch exemption (§2)                  */
  /* ================================================================== */
  const offline = (function () {
    let reg = null, warned = false;

    function possible() {
      return !!(navigator.serviceWorker && /^https?:$/.test(location.protocol));
    }
    function why() {
      if (!navigator.serviceWorker) return "this browser has no service worker — there is no offline copy to make";
      if (!/^https?:$/.test(location.protocol))
        return "the offline copy only works over http(s) — this copy is already a local file, so it is already offline";
      return null;
    }

    async function register() {
      if (!possible()) return null;
      try {
        reg = await navigator.serviceWorker.register(SW_URL);
        return reg;
      } catch (e) {
        console.warn("service worker did not register:", e && e.message);
        return null;
      }
    }

    /* one round trip to the worker, over a MessageChannel so the reply cannot
       be confused with anyone else's */
    function ask(msg, onProgress) {
      return new Promise((res, rej) => {
        const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!sw) { rej(new Error("no service worker is controlling this page yet — reload once and try again")); return; }
        const ch = new MessageChannel();
        ch.port1.onmessage = e => {
          const d = e.data || {};
          if (d.type === "progress") { if (onProgress) onProgress(d); return; }
          ch.port1.close();
          if (d.type === "error") rej(new Error(d.message || "the offline copy failed"));
          else res(d);
        };
        sw.postMessage(msg, [ch.port2]);
      });
    }

    async function status() {
      if (!possible()) return { supported: false, why: why() };
      try { const s = await ask({ type: "status" }); return Object.assign({ supported: true }, s); }
      catch (e) { return { supported: true, ready: false, error: e.message }; }
    }
    async function precache(onProgress) {
      if (!possible()) { toast(why(), 5200); return null; }
      try { return await ask({ type: "precache" }, onProgress); }
      catch (e) { toast("the offline copy failed: " + e.message, 5200); return null; }
    }
    async function remove() {
      if (!possible()) { toast(why(), 5200); return null; }
      try { const r = await ask({ type: "clear" }); toast("offline copy removed"); return r; }
      catch (e) { toast("the offline copy could not be removed: " + e.message, 5200); return null; }
    }
    /* the worker tells the page when the served index.html no longer matches
       the cached one — once, so a reload is not a scolding */
    function listen(onStale) {
      if (!navigator.serviceWorker) return;
      navigator.serviceWorker.addEventListener("message", e => {
        const d = e.data || {};
        if (d.type !== "stale" || warned) return;
        warned = true;
        toast("the offline copy is out of date — an update is available, refresh to load it", 6000);
        if (onStale) onStale(d);
      });
    }
    return { possible, why, register, status, precache, remove, listen };
  })();

  /* ================================================================== */
  /* 7b. the iPad's hardware (§5b)                                       */
  /* ================================================================== */
  /* The screen must not sleep while the device is being carried around a site
     with Position on, or while a two-minute drainage job is running. Feature-
     detected, reference-counted by REASON (two callers, one lock), released the
     moment the last reason goes — a lock nobody releases is a flat battery —
     and re-acquired on `visibilitychange`, because the browser drops it when
     the tab is hidden and never gives it back on its own. Every failure is
     silent by design: this is a convenience, not a capability the app needs. */
  let wakeLock = null;
  const wakeReasons = new Set();
  async function acquireWake() {
    if (wakeLock || !navigator.wakeLock || !wakeReasons.size) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function keepAwake(reason, want) {
    if (want) wakeReasons.add(reason); else wakeReasons.delete(reason);
    if (wakeReasons.size) acquireWake();
    else if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    return wakeReasons.size;
  }

  /* what `download()` shared, so test/e2e_tablet.mjs can assert the share sheet
     was reached rather than inferring it from a missing file */
  const shared = [];
  function noteShared(name) { shared.push({ name, at: Date.now() }); }

  /* The line the engineer reads back when something is slow (§5b). Everything
     in it is asked at the moment it is painted — a cached GPU string outlives
     the context it came from. */
  function diagnostics() {
    const v = (SBMM.viewer3d && SBMM.viewer3d.stats) ? (function () {
      try { return SBMM.viewer3d.stats(); } catch (e) { return {}; }
    })() : {};
    return {
      build: (window.SBMM_DATA && SBMM_DATA.build) || "folder",
      profile: profile(),
      pointer: lastPointer(),
      viewport: window.innerWidth + "x" + window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      cores: navigator.hardwareConcurrency || null,
      workers: SBMM.compute && SBMM.compute.poolSize ? SBMM.compute.poolSize() : null,
      webgl2: v.webgl2 == null ? null : !!v.webgl2,
      gpu: v.gpuName || null,
      anisotropy: v.anisotropy || null,
      memoryMB: (performance && performance.memory)
        ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
      standalone: standalone(),
      offlineCapable: offline.possible()
    };
  }
  function paintDiag() {
    const el = document.getElementById("touchDiag");
    if (!el) return;
    const d = diagnostics();
    el.textContent = [
      d.build + " build", d.profile, d.viewport + " @" + (+d.dpr).toFixed(1) + "x",
      d.cores ? d.cores + " cores" : null, d.workers ? d.workers + " workers" : null,
      d.webgl2 == null ? null : (d.webgl2 ? "WebGL2" : "WebGL1"),
      d.gpu ? d.gpu.slice(0, 52) : null,
      d.anisotropy ? d.anisotropy + "x aniso" : null,
      d.memoryMB ? d.memoryMB + " MB heap" : null,
      d.standalone ? "home-screen app" : null
    ].filter(Boolean).join(" · ");
  }

  /* Standalone = added to the home screen. iOS uses navigator.standalone;
     everything else answers the display-mode query. */
  function standalone() {
    if (navigator.standalone === true) return true;
    try { return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches); }
    catch (e) { return false; }
  }

  /* ================================================================== */
  /* 8. the Help panel's touch controls                                  */
  /* ================================================================== */
  function paintOffline(s) {
    const line = document.getElementById("offlineStatus");
    const btn = document.getElementById("offlineBtn");
    const rm = document.getElementById("offlineRm");
    if (!line || !btn) return;
    if (!s || !s.supported) {
      line.textContent = (s && s.why) || offline.why() || "offline copy: not available here";
      btn.disabled = true;
      if (rm) rm.hidden = true;
      return;
    }
    btn.disabled = false;
    if (!s.ready) {
      line.textContent = "offline copy: none";
      btn.textContent = "Make available offline";
      if (rm) rm.hidden = true;
      return;
    }
    const mb = (s.bytes || 0) / 1e6;
    line.textContent = s.stale
      ? `offline copy: stale — an update is available, refresh to load it (${s.count} files · ${mb.toFixed(0)} MB)`
      : `offline copy: ready · ${s.count} files · ${mb.toFixed(0)} MB · ${(s.at || "").slice(0, 10)}`;
    btn.textContent = s.stale ? "Update offline copy" : "Refresh offline copy";
    if (rm) rm.hidden = false;
  }

  async function refreshOfflineUI() { paintOffline(await offline.status()); }

  function wireHelp() {
    const sw = document.getElementById("touchSwitch");
    if (sw) {
      sw.value = override();
      sw.onchange = () => {
        override(sw.value);
        toast("touch controls: " + (sw.value === "auto" ? "automatic — " + profile() : sw.value));
      };
      if (SBMM.events) SBMM.events.on("touch", () => { sw.value = override(); });
    }
    /* "Add to Home Screen" — only in a browser, on a touch device */
    const hint = document.getElementById("homeHint");
    if (hint) hint.hidden = !(on() && !standalone());

    const btn = document.getElementById("offlineBtn");
    if (btn) {
      btn.onclick = async () => {
        const line = document.getElementById("offlineStatus");
        btn.disabled = true;
        const r = await offline.precache(p => {
          if (line) line.textContent = `offline copy: ${p.done} of ${p.total} files · ${(p.bytes / 1e6).toFixed(0)} MB…`;
        });
        btn.disabled = false;
        if (r) toast(`offline copy ready — ${r.count} files, ${(r.bytes / 1e6).toFixed(0)} MB`, 4200);
        refreshOfflineUI();
      };
    }
    const rm = document.getElementById("offlineRm");
    if (rm) rm.onclick = async () => { await offline.remove(); refreshOfflineUI(); };
    refreshOfflineUI();

    /* §5b: a home-screen app has no reload button and no address bar, so when
       an update is waiting there is otherwise no way to take it */
    const rl = document.getElementById("reloadApp");
    if (rl) rl.onclick = () => location.reload();
    paintDiag();
    const dg = document.getElementById("touchDiag");
    if (dg) dg.onclick = () => {
      copyText(JSON.stringify(diagnostics(), null, 1), "diagnostics copied");
    };
  }

  /* §5b — the Field menu. Position, Photo, Note and Samples-nearby are the four
     field capabilities of v11 §4.4, and none of them is a phone-only idea: an
     iPad with cellular has GPS and a camera. In the PHONE profile they are the
     action bar and this menu is not shown; in the TABLET profile this is their
     one entry point, and it calls exactly the same js/field.js functions. */
  function wireFieldMenu() {
    const btn = document.getElementById("fieldMenuBtn");
    const menu = document.getElementById("fieldMenu");
    if (!btn || !menu) return;
    btn.onclick = e => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "block" ? "none" : "block";
      const r = btn.getBoundingClientRect();
      menu.style.left = Math.round(Math.min(r.left, window.innerWidth - 220)) + "px";
      menu.style.top = Math.round(r.bottom + 4) + "px";
    };
    menu.addEventListener("click", e => {
      const it = e.target.closest("[data-fm]");
      menu.style.display = "none";
      if (!it || !SBMM.field) return;
      const k = it.dataset.fm;
      if (k === "position") SBMM.field.locate();
      else if (k === "photo") SBMM.field.photo();
      else if (k === "note") SBMM.field.note();
      else if (k === "samples") SBMM.field.nearbySamples();
      else if (k === "field") SBMM.field.toggle();
    });
    document.addEventListener("click", e => {
      if (e.target !== btn && !menu.contains(e.target)) menu.style.display = "none";
    });
  }

  /* ================================================================== */
  /* 9. the map: long-press = right-click, and sketching by finger (§5)   */
  /* ================================================================== */
  /* Two things the desktop map assumes and a tablet does not have.

     (i) A RIGHT-CLICK. Leaflet 1.9 does not synthesise `contextmenu` from a
     long press, so the map's coordinate menu, a feature's menu and a vertex's
     menu are all simply unreachable by finger. The recogniser's long-press
     dispatches a real `contextmenu` MouseEvent at the same client point, so
     every existing handler answers it unchanged — there is no second menu.

     (ii) PRECISION. A fingertip is ~44 px across and it sits ON the point it is
     placing, so "tap where you want the vertex" is a lie at 1 in = 20 ft. The
     rule is the sheet viewer's: press, the loupe appears above-left with a
     crosshair on the exact ground point, slide until it is right, and the
     vertex lands where the finger LIFTS. A tap without a slide is the same
     thing with a zero-length slide. Two fingers cancel the placement and
     become the map's own pinch-zoom.

     While a sketch is armed the map's one-finger DRAG belongs to the crosshair,
     not to panning, so `map.dragging` is disabled for the duration and restored
     the moment the sketch ends or a second finger arrives. */
  function wireMap() {
    const map = SBMM.map;
    const host = map && map.getContainer && map.getContainer();
    if (!host) return;

    let press = null, painter = null, dragWas = null, swallowUntil = 0;
    const armed = () => on() && drawArmed();

    /* Leaflet's own event object, built from a client point, so `map.fire`
       reaches exactly the handlers a real click reaches */
    function leafletEv(x, y) {
      const p = map.mouseEventToContainerPoint({ clientX: x, clientY: y });
      return { latlng: map.containerPointToLatLng(p), containerPoint: p,
               layerPoint: map.containerPointToLayerPoint(p),
               originalEvent: { clientX: x, clientY: y, shiftKey: false } };
    }
    function restoreDrag() {
      if (dragWas === true && map.dragging && !map.dragging.enabled()) map.dragging.enable();
      dragWas = null;
    }
    function endPress(place, x, y) {
      if (!press) return;
      press = null; painter = null;
      loupe.hide();
      restoreDrag();
      if (!place) return;
      /* Leaflet will synthesise a click from the same tap; it must not place a
         second vertex on top of the one this is about to place */
      swallowUntil = DEF.now() + 700;
      map.fire("click", leafletEv(x, y));
      sketchBar();
    }

    /* THE SAME recogniser the 3D rig and the sheet viewer use — but fed from
       our own listeners rather than `gestures(host, ...)`, and that is
       deliberate: `gestures` calls `setPointerCapture` on the element it is
       attached to, and capturing on the MAP CONTAINER would redirect every
       subsequent pointer event away from Leaflet's own marker elements. A
       vertex handle is a draggable marker; it would stop dragging by finger
       the moment the container captured the pointer. Same gesture semantics,
       no capture. */
    const rec = recognizer({
      panstart(g) {
        /* §5a: a PEN is a precise pointer — its tap places a vertex
           immediately, with no loupe and at mouse-size snap tolerance, through
           Leaflet's own click. Only a finger needs the crosshair, and only a
           finger's press is taken away from the map's pan. */
        if (g.pointerType !== "touch" || g.resumed || !armed()) return;
        dragWas = !!(map.dragging && map.dragging.enabled());
        if (dragWas) map.dragging.disable();
        const snap = snapshot(host);
        painter = snapPainter(snap).at(g.x, g.y);
        press = { x: g.x, y: g.y };
        loupe.show(painter, g.x, g.y);
        map.fire("mousemove", leafletEv(g.x, g.y));
      },
      pan(g) {
        if (!press) return;
        press.x = g.x; press.y = g.y;
        painter.at(g.x, g.y);
        loupe.at(g.x, g.y);
        /* the rubber band, the osnap glyphs and the typed-input hint all hang
           off the map's own mousemove, so the crosshair drives them */
        map.fire("mousemove", leafletEv(g.x, g.y));
      },
      /* a second finger, or a cancelled pointer, drops the placement — and the
         map's own pinch takes over, which is exactly the rule §4/§5 states */
      panend(g) { endPress(!g.cancelled, g.x, g.y); },
      pinchstart() { endPress(false); },
      longpress(g) {
        if (!on() || press) return;
        /* Leaflet 1.9 does not synthesise `contextmenu` for touch, so the map's
           coordinate menu, a feature's menu and a vertex's menu are unreachable
           by finger. A real MouseEvent at the same client point means every
           existing handler answers it unchanged — there is no second menu. */
        fireContextMenu(g.x, g.y, document.elementFromPoint(g.x, g.y));
        /* AND THE MENU HAS TO SURVIVE THE FINGER COMING OFF THE GLASS. A long
           press fires at 500 ms with the finger still DOWN; the lift then
           produces a synthetic `click`, and js/map.js closes the context menu
           on any document click. So the menu opened, fully built, and vanished
           on release — it looked like the long-press had not worked at all.
           The click-swallow below already exists for the vertex placement;
           this arms it for the same reason. */
        swallowUntil = DEF.now() + 700;
      }
    });
    host.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse") return;
      lastTouch = DEF.now();
      if (e.pointerType === "touch" && penRecent()) return;     // palm
      rec.down(e);
    }, true);
    host.addEventListener("pointermove", e => { if (e.pointerType !== "mouse") rec.move(e); }, true);
    host.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") rec.up(e); }, true);
    host.addEventListener("pointercancel", e => { if (e.pointerType !== "mouse") rec.cancel(e); }, true);

    /* The synthetic click a touch produces has to be swallowed twice over: it
       would place a second vertex on top of the one the lift just placed, and
       it would close the context menu the long-press just opened. Capture
       phase on the MAP CONTAINER, which runs before js/map.js's document-level
       bubble listener — and not on the menu itself, which is a sibling in
       <body>, so choosing an item still works. */
    host.addEventListener("click", e => {
      if (DEF.now() > swallowUntil) return;
      e.stopPropagation(); e.preventDefault();
    }, true);

    /* the Done bar follows the sketch, because Enter/Backspace/Esc do not exist */
    SBMM.events.on("mode", () => setTimeout(sketchBar, 0));
    SBMM.events.on("touch", sketchBar);
  }

  /* "Is the sketch engine collecting points right now?" — a sketch or a pick.
     js/draw.js exports `armed()`; the fallback is the same two questions asked
     separately, so a build whose draw module predates that export degrades to
     the right answer instead of throwing inside an event handler (which is
     exactly how this was found: a `touch` event, a TypeError, and a profile
     switch that half-happened). */
  function drawArmed() {
    const d = SBMM.draw;
    if (!d) return false;
    if (typeof d.armed === "function") return !!d.armed();
    return !!((d.isDrawing && d.isDrawing()) || (d.isPicking && d.isPicking()));
  }

  /* Done / Undo vertex / Cancel for the MAP sketch. js/sheetmarks.js drives the
     same bar for a sheet window; whichever armed last owns it. */
  function sketchBar() {
    if (!on() || !SBMM.draw) { doneBar.hide(); return; }
    if (!drawArmed()) {
      /* a sheet window may still be marking — leave its bar alone */
      if (!(SBMM.sheetMarks && SBMM.sheetMarks.activeCount())) doneBar.hide();
      return;
    }
    doneBar.show({
      label: SBMM.mode ? SBMM.mode.label() : "sketch",
      done: () => { SBMM.draw.isPicking() ? SBMM.draw.finishPick() : SBMM.draw.finishSketch(); setTimeout(sketchBar, 0); },
      undo: () => { SBMM.draw.removeLastVertex(); },
      cancel: () => { SBMM.mode.navigate(); setTimeout(sketchBar, 0); }
    });
  }

  /* ================================================================== */
  function wire() {
    if (wired) return;
    wired = true;
    apply(false);
    syncViewport();
    wirePointerKind();
    wireLongPress();

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => { syncViewport(); if (SBMM.shell) SBMM.shell.relayout(); });
      window.visualViewport.addEventListener("scroll", syncViewport);
    }
    if (SBMM.events) SBMM.events.on("field", () => { apply(false); });

    /* the offline copy: registered over http(s) only, never over file:// */
    offline.listen(() => refreshOfflineUI());
    offline.register().then(() => refreshOfflineUI());

    wireHelp();
    wireFieldMenu();
    wireMap();
    /* the browser takes the wake lock away when the tab is hidden and never
       hands it back — ask again the moment we are visible with a reason live */
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") acquireWake();
    });

    /* the command bar has no backtick under a thumb (§5) */
    const cb = document.getElementById("cmdTopBtn");
    if (cb) cb.onclick = () => SBMM.cmd.open(true);

    /* §3: a tablet opens 3D at STANDARD detail, like the phone — the high mesh
       is 1.5 M vertices and an A10 iPad is not a workstation. A REMEMBERED
       choice beats the guess in both directions, because only the owner knows
       which iPad this is. Set here rather than in js/viewer3d.js because the
       3D view is built lazily on first open and the select is in the DOM from
       the start. */
    const det = document.getElementById("v3dDetail");
    if (det) {
      const rem = SBMM.view && SBMM.view.pref ? SBMM.view.pref("detail") : undefined;
      if (rem === "std" || rem === "high") det.value = rem;
      else if (on()) det.value = "std";
    }
  }

  return {
    wire, autoDetect, apply, profile, sniff, on, override, touchCapable, standalone,
    /* §5a — the per-EVENT hook the chrome sizes from, and the palm clock */
    lastPointer, precise, penDown, penRecent,
    gestures, recognizer, momentum, angDelta, sketchBar, edge,
    loupe, snapshot, snapPainter, doneBar, fireContextMenu, tip, hideTip,
    offline, refreshOfflineUI, syncViewport,
    /* §5b */
    keepAwake, wakeHeld: () => !!wakeLock, wakeReasons: () => [...wakeReasons],
    noteShared, shared: () => shared.slice(), diagnostics, paintDiag,
    lastTouchAt: () => lastTouch,
    /* "did a finger just do that?" — the one question a click handler shared by
       both input kinds has to ask, because a tap also produces a click */
    touchRecent: (ms) => DEF.now() - lastTouch < (ms || 700),
    LOUPE_PX, LOUPE_ZOOM
  };
})();
