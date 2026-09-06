/* SBMM Site Explorer — the password gate.
   ------------------------------------------------------------------------
   A DETERRENT, not security. Everything in this app ships to the browser, so
   anyone who opens the file in an editor can read past this. The point is that
   a colleague who is handed the file — or finds it on a share — is asked for a
   word before the site data is on their screen.

   Load order: this is the FIRST script in index.html, before vendor/leaflet.js
   and before the ~130 MB of datajs payloads. It therefore paints while the rest
   of the page is still parsing, which is the only moment at which a gate can
   honestly claim to have covered anything.

   Contract:
   - #gate is a fixed full-viewport element at z-index 9000 (above the toast at
     7000; see the stacking comment at the top of css/app.css). The app keeps
     booting underneath it — the gate covers and blocks, it does not pause.
   - Pointer, wheel and keyboard never reach the app while locked. Keys are
     stopped in the CAPTURE phase on `document`, and because gate.js is the
     first script its listener is the first one registered on that node, so
     stopImmediatePropagation() there beats every handler in mode.js, sheets.js,
     cmdline.js and the rest. Typing still works: stopping propagation does not
     stop the browser's default action of inserting the character.
   - The password is checked as SHA-256(SALT + password) against HASH below.
     The plaintext is nowhere in the repo. tools/set_password.py rewrites HASH.
   - An unlock is remembered per browser in localStorage "sbmm.gate.v1" for 30
     days. LOCK / LOGOUT in the command bar clears it. There is no URL bypass.
   - The test harnesses pre-set that key (test/gate.mjs) — the gate is never
     weakened for them.
   ------------------------------------------------------------------------ */
(function () {
  "use strict";

  var SALT = "SBMM/OU1/gate/v1|";
  /* tools/set_password.py rewrites the next line; keep it on one line. */
  var HASH = "a962a82650e5c36c08e052630ff208fa69412ecc2921c177e260f20638c87906";

  var LSKEY  = "sbmm.gate.v1";
  var MAXAGE = 30 * 24 * 3600 * 1000;   /* 30 days */

  window.SBMM = window.SBMM || {};

  /* A <script src> that fails to load leaves nothing behind but a resource
     `error` event that does not bubble — so it is caught HERE, in the capture
     phase on window, from the first script in the page, and js/boot.js retries
     each recorded file before it decides the app is broken. A 14 MB payload
     over a phone's signal drops once and the tag has no retry of its own. */
  SBMM.failedScripts = [];
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (t && t.tagName === "SCRIPT" && t.src) SBMM.failedScripts.push(t.src);
  }, true);

  /* ==================================================================== */
  /* SHA-256 — crypto.subtle where it exists, a pure-JS fallback where not */
  /* ==================================================================== */

  var K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  function utf8(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  function jsSha256(str) {
    var b = utf8(str), bl = b.length, i, j;
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var withOne = bl + 1, blocks = Math.ceil((withOne + 8) / 64), total = blocks * 64;
    var m = new Uint8Array(total);
    m.set(b); m[bl] = 0x80;
    var bits = bl * 8;
    /* length is 64-bit big-endian; a password is never near 2^32 bits, so the
       high word is zero and the low word is written exactly. */
    m[total - 4] = (bits >>> 24) & 255; m[total - 3] = (bits >>> 16) & 255;
    m[total - 2] = (bits >>> 8) & 255;  m[total - 1] = bits & 255;

    var w = new Int32Array(64);
    for (i = 0; i < total; i += 64) {
      for (j = 0; j < 16; j++)
        w[j] = (m[i + j * 4] << 24) | (m[i + j * 4 + 1] << 16) | (m[i + j * 4 + 2] << 8) | m[i + j * 4 + 3];
      for (j = 16; j < 64; j++) {
        var g0 = w[j - 15], g1 = w[j - 2];
        var s0 = ((g0 >>> 7) | (g0 << 25)) ^ ((g0 >>> 18) | (g0 << 14)) ^ (g0 >>> 3);
        var s1 = ((g1 >>> 17) | (g1 << 15)) ^ ((g1 >>> 19) | (g1 << 13)) ^ (g1 >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[j] + w[j]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var mj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0;  H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0;  H[5] = (H[5] + f) | 0;  H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = "";
    for (i = 0; i < 8; i++) out += ("00000000" + (H[i] >>> 0).toString(16)).slice(-8);
    return out;
  }

  function sha256Hex(msg) {
    /* file:// IS a secure context in Chrome, so crypto.subtle is normally there —
       but never rely on it: a stricter browser, or a copy served over plain http
       on someone's LAN, has to keep working. */
    try {
      if (window.crypto && crypto.subtle && crypto.subtle.digest && window.TextEncoder) {
        var p = crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
        if (p && typeof p.then === "function") {
          return p.then(function (buf) {
            var u = new Uint8Array(buf), s = "", i;
            for (i = 0; i < u.length; i++) s += (u[i] < 16 ? "0" : "") + u[i].toString(16);
            return s;
          })["catch"](function () { return jsSha256(msg); });
        }
      }
    } catch (e) { /* fall through to the pure-JS path */ }
    return Promise.resolve(jsSha256(msg));
  }

  /* ==================================================================== */
  /* remembered unlock                                                    */
  /* ==================================================================== */

  function remembered() {
    try {
      var raw = localStorage.getItem(LSKEY);
      if (!raw) return false;
      var o = JSON.parse(raw);
      return !!o && o.h === HASH && typeof o.t === "number" && (Date.now() - o.t) < MAXAGE;
    } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(LSKEY, JSON.stringify({ h: HASH, t: Date.now() })); } catch (e) {}
  }
  function forget() {
    try { localStorage.removeItem(LSKEY); } catch (e) {}
  }

  /* ==================================================================== */
  /* the living background — a procedural topographic contour field       */
  /* ==================================================================== */
  /* Value noise (written here rather than pulled in: no CDNs, ever), three
     octaves, each drifting at its own rate, plus a slow global rise so the
     contours creep across the screen like a survey drawing breathing.
     The field is evaluated on a coarse grid; contours come out of marching
     squares over that grid, and the hillshade out of its own gradient — the
     same two things this app does to real terrain, which is the joke.        */

  function hash2(ix, iy, seed) {
    var n = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
    n = (n ^ (n >>> 13)) | 0;
    n = Math.imul(n, 1274126177);
    n = (n ^ (n >>> 16)) >>> 0;
    return n / 4294967295;
  }
  function vnoise(x, y, seed) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
    var c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }

  var CELL = 11;            /* field grid, CSS px */
  var STEP = 0.042;         /* contour interval in normalised field units */
  var INDEX_EVERY = 5;      /* every fifth line is an index contour */

  function Field() {
    this.gw = 0; this.gh = 0; this.z = null; this.shade = null;
  }
  Field.prototype.size = function (w, h) {
    this.gw = Math.ceil(w / CELL) + 2;
    this.gh = Math.ceil(h / CELL) + 2;
    this.z = new Float32Array(this.gw * this.gh);
  };
  Field.prototype.sample = function (t) {
    var gw = this.gw, gh = this.gh, z = this.z, i, j;
    /* three octaves; each drifts on its own heading so the pattern never
       repeats visibly over the seconds anyone looks at it */
    var d0x = t * 0.0065, d0y = t * -0.0031;
    var d1x = t * -0.0122, d1y = t * 0.0074;
    var d2x = t * 0.0205, d2y = t * 0.0168;
    var breathe = 0.055 * Math.sin(t * 0.21) + 0.03 * Math.sin(t * 0.083 + 1.7);
    var k = 0;
    for (j = 0; j < gh; j++) {
      var y = j * CELL * 0.0042;
      for (i = 0; i < gw; i++) {
        var x = i * CELL * 0.0042;
        var v = 0.55 * vnoise(x * 1.0 + d0x, y * 1.0 + d0y, 1)
              + 0.30 * vnoise(x * 2.3 + d1x, y * 2.3 + d1y, 2)
              + 0.15 * vnoise(x * 4.9 + d2x, y * 4.9 + d2y, 3);
        /* a broad tilt so the "terrain" has a fall line rather than sitting flat */
        z[k++] = v + breathe + 0.16 * (1 - y * 0.22) - 0.05 * x * 0.18;
      }
    }
  };

  /* ==================================================================== */
  /* the gate itself                                                      */
  /* ==================================================================== */

  var el = null, cv = null, ctx = null, card = null, inp = null, msg = null;
  var shadeCv = null, shadeCtx = null, shadeImg = null;
  var field = new Field();
  var locked = false, raf = 0, t0 = 0, dpr = 1, W = 0, H = 0;
  var wrong = 0, waitUntil = 0, waitTimer = 0, busy = false;
  var reduce = false;
  /* unlock animation state: -1 = not running, else ms since it started */
  var anim = -1, animStart = 0, onDone = null;

  var DUR_FLOOD_IN = 60, DUR_FLOOD = 760;      /* water rises  60 →  820 ms */
  var DUR_REVEAL_IN = 720, DUR_REVEAL = 660;   /* land surfaces 720 → 1380 ms */
  var DUR_TOTAL = 1380;

  function ease(u) { return u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u); }
  function easeOut(u) { return u < 0 ? 0 : u > 1 ? 1 : 1 - (1 - u) * (1 - u) * (1 - u); }

  function build() {
    el = document.createElement("div");
    el.id = "gate";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "SBMM Site Explorer — locked");
    el.innerHTML =
      '<canvas id="gateCv" aria-hidden="true"></canvas>' +
      '<div id="gateVig" aria-hidden="true"></div>' +
      '<div id="gateCard">' +
        '<div class="gmark" aria-hidden="true">' +
          '<svg viewBox="0 0 44 44"><g class="gring"><circle cx="22" cy="22" r="19"/></g>' +
          '<path class="gtopo" d="M5 28c4-6 8-2 12-7s7 1 11-4 6-1 11-5"/>' +
          '<path class="gtopo" d="M6 34c4-6 8-2 12-7s7 1 11-4 6-1 10-5"/>' +
          '<path class="gtopo gtopo3" d="M8 21c3-4 6-1 9-5s5 .6 8-3"/></svg>' +
        '</div>' +
        '<h1 class="gtitle">SBMM <span>Site Explorer</span></h1>' +
        '<p class="gsub">Sulphur Bank Mercury Mine · OU1 terrain workbench</p>' +
        '<div class="grow">' +
          '<input id="gatePw" type="password" placeholder="password" aria-label="Password" ' +
                 'autocomplete="current-password" spellcheck="false" autocapitalize="off">' +
          '<button id="gateGo" type="button">Enter</button>' +
        '</div>' +
        '<div id="gateMsg" role="status" aria-live="polite"></div>' +
        '<div class="gfoot">Developed by Mo Sharif 2026. All rights reserved.</div>' +
      '</div>';
    document.body.appendChild(el);

    cv = el.querySelector("#gateCv");
    ctx = cv.getContext("2d");
    card = el.querySelector("#gateCard");
    inp = el.querySelector("#gatePw");
    msg = el.querySelector("#gateMsg");

    shadeCv = document.createElement("canvas");
    shadeCtx = shadeCv.getContext("2d");

    /* --- blocking. Registered on the gate in the capture phase: the app's own
       document handlers never see a pointer while this is up. The delegation
       handler below is a SECOND listener on the same node, so stopPropagation
       (which stops descendants, not siblings) does not disarm the button. --- */
    ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "click", "dblclick",
     "wheel", "contextmenu", "touchstart", "touchmove", "touchend", "drop", "dragover"
    ].forEach(function (type) {
      el.addEventListener(type, function (e) { e.stopPropagation(); }, true);
    });
    el.addEventListener("wheel", function (e) { e.preventDefault(); }, { capture: true, passive: false });

    el.addEventListener("click", function (e) {
      var tgt = e.target;
      if (tgt && tgt.closest && tgt.closest("#gateGo")) { submit(); return; }
      /* a stray click anywhere on the gate puts the caret back in the field */
      if (!tgt || !tgt.closest || !tgt.closest("#gatePw")) focusField();
    }, true);

    window.addEventListener("resize", resize);
    resize();
    reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    t0 = performance.now();
    if (reduce) { draw(0); } else { raf = requestAnimationFrame(frame); }
    focusField();
  }

  function focusField() {
    if (!inp) return;
    try { inp.focus({ preventScroll: true }); } catch (e) { try { inp.focus(); } catch (e2) {} }
  }

  function resize() {
    if (!el) return;
    W = window.innerWidth; H = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    cv.style.width = W + "px"; cv.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    field.size(W, H);
    shadeCv.width = field.gw; shadeCv.height = field.gh;
    shadeImg = shadeCtx.createImageData(field.gw, field.gh);
    if (reduce) draw(0);
  }

  /* --- one frame ---------------------------------------------------- */

  function frame(now) {
    raf = requestAnimationFrame(frame);
    draw((now - t0) / 1000);
  }

  function waterYAt(x, base, t) {
    return base + 5.5 * Math.sin(x * 0.0115 + t * 2.1) + 3.5 * Math.sin(x * 0.0287 - t * 1.35);
  }

  function draw(t) {
    if (!ctx) return;
    field.sample(t);

    /* --- hillshade, painted at grid resolution and scaled up soft ------- */
    var gw = field.gw, gh = field.gh, z = field.z, d = shadeImg.data, i, j, k = 0, p = 0;
    for (j = 0; j < gh; j++) {
      for (i = 0; i < gw; i++) {
        var zx = z[k + (i < gw - 1 ? 1 : 0)] - z[k - (i > 0 ? 1 : 0)];
        var zy = z[k + (j < gh - 1 ? gw : 0)] - z[k - (j > 0 ? gw : 0)];
        /* light from the north-west, the convention on every plan in this app */
        var lum = 0.5 + 2.6 * (-zx * 0.62 - zy * 0.62);
        if (lum < 0) lum = 0; else if (lum > 1) lum = 1;
        d[p++] = 11 + lum * 20;
        d[p++] = 20 + lum * 32;
        d[p++] = 26 + lum * 40;
        d[p++] = 255;
        k++;
      }
    }
    shadeCtx.putImageData(shadeImg, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0B1015";
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = 0.9;
    ctx.drawImage(shadeCv, 0, 0, gw, gh, -CELL, -CELL, gw * CELL, gh * CELL);
    ctx.globalAlpha = 1;

    /* --- flood level --------------------------------------------------- */
    var flood = anim < 0 ? -1 : easeOut((anim - DUR_FLOOD_IN) / DUR_FLOOD);
    var baseY = flood < 0 ? H + 400 : H + 40 - flood * (H + 120);

    /* --- contours, by marching squares over the field ------------------- */
    var above = new Path2D(), below = new Path2D();
    var aboveIx = new Path2D(), belowIx = new Path2D();
    for (j = 0; j < gh - 1; j++) {
      var y0 = j * CELL - CELL, y1 = y0 + CELL;
      for (i = 0; i < gw - 1; i++) {
        var x0 = i * CELL - CELL, x1 = x0 + CELL;
        var a = z[j * gw + i], b = z[j * gw + i + 1], c = z[(j + 1) * gw + i + 1], dd = z[(j + 1) * gw + i];
        var lo = Math.min(a, b, c, dd), hi = Math.max(a, b, c, dd);
        var l0 = Math.ceil(lo / STEP), l1 = Math.floor(hi / STEP);
        if (l1 < l0) continue;
        var wet = (y0 + CELL * 0.5) > waterYAt(x0, baseY, t);
        for (var L = l0; L <= l1; L++) {
          var lev = L * STEP;
          var idx = (((L % INDEX_EVERY) + INDEX_EVERY) % INDEX_EVERY) === 0;
          var pth = wet ? (idx ? belowIx : below) : (idx ? aboveIx : above);
          /* corner sides: 1 = at or above the level */
          var s = (a >= lev ? 1 : 0) | (b >= lev ? 2 : 0) | (c >= lev ? 4 : 0) | (dd >= lev ? 8 : 0);
          if (s === 0 || s === 15) continue;
          /* edge crossings, linear along each edge */
          var tx, ty;
          var eT = null, eR = null, eB = null, eL = null;
          if ((s & 1) !== (s & 2) >> 1) { tx = (lev - a) / (b - a); eT = [x0 + tx * CELL, y0]; }
          if ((s & 2) >> 1 !== (s & 4) >> 2) { ty = (lev - b) / (c - b); eR = [x1, y0 + ty * CELL]; }
          if ((s & 8) >> 3 !== (s & 4) >> 2) { tx = (lev - dd) / (c - dd); eB = [x0 + tx * CELL, y1]; }
          if ((s & 1) !== (s & 8) >> 3) { ty = (lev - a) / (dd - a); eL = [x0, y0 + ty * CELL]; }
          var ends = [];
          if (eT) ends.push(eT); if (eR) ends.push(eR); if (eB) ends.push(eB); if (eL) ends.push(eL);
          if (ends.length === 2) { pth.moveTo(ends[0][0], ends[0][1]); pth.lineTo(ends[1][0], ends[1][1]); }
          else if (ends.length === 4) {
            /* saddle: join the pairs that keep the high corners together */
            pth.moveTo(eT[0], eT[1]); pth.lineTo(eL[0], eL[1]);
            pth.moveTo(eB[0], eB[1]); pth.lineTo(eR[0], eR[1]);
          }
        }
      }
    }

    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(124,208,230,0.13)"; ctx.lineWidth = 0.8; ctx.stroke(above);
    ctx.strokeStyle = "rgba(124,208,230,0.26)"; ctx.lineWidth = 1.25; ctx.stroke(aboveIx);

    /* --- the flood ----------------------------------------------------- */
    if (flood > 0) {
      ctx.save();
      var wp = new Path2D();
      wp.moveTo(-4, H + 4);
      for (var x = -4; x <= W + 8; x += 8) wp.lineTo(x, waterYAt(x, baseY, t));
      wp.lineTo(W + 8, H + 4);
      wp.closePath();
      ctx.clip(wp);

      var gwt = ctx.createLinearGradient(0, baseY, 0, H);
      gwt.addColorStop(0, "rgba(85,193,255,0.30)");
      gwt.addColorStop(0.35, "rgba(85,193,255,0.16)");
      gwt.addColorStop(1, "rgba(28,86,124,0.34)");
      ctx.fillStyle = gwt;
      ctx.fillRect(0, Math.max(-4, baseY - 40), W, H + 60);

      /* the drowned contours shimmer: a moving highlight band along the lines */
      var sh = ((t * 240) % (W + 600)) - 300;
      var gsh = ctx.createLinearGradient(sh - 260, 0, sh + 260, 0);
      gsh.addColorStop(0, "rgba(159,220,255,0.22)");
      gsh.addColorStop(0.5, "rgba(223,244,255,0.72)");
      gsh.addColorStop(1, "rgba(159,220,255,0.22)");
      ctx.strokeStyle = "rgba(159,220,255,0.30)"; ctx.lineWidth = 0.9; ctx.stroke(below);
      ctx.strokeStyle = gsh; ctx.lineWidth = 1.5; ctx.stroke(belowIx);
      ctx.restore();

      /* the surface line itself, with a soft glow */
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(-4, waterYAt(-4, baseY, t));
      for (var x2 = 4; x2 <= W + 8; x2 += 8) ctx.lineTo(x2, waterYAt(x2, baseY, t));
      ctx.strokeStyle = "rgba(223,244,255,0.55)";
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "rgba(85,193,255,0.85)";
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* --- the reveal: the terrain surfacing through the water ------------- */
  /* The gate is clipped to a polygon whose lower edge follows the field, so the
     app is uncovered along a contour rather than a straight line. One style
     write per frame, transform/opacity/clip-path only — no layout. */
  function revealClip(u, t) {
    var y = H + 30 - easeOut(u) * (H + 90);
    var pts = [], n = 46, i;
    for (i = 0; i <= n; i++) {
      var x = (i / n) * W;
      var v = vnoise(x * 0.0042 + t * 0.02, y * 0.0042, 1)
            + 0.5 * vnoise(x * 0.0119 - t * 0.03, y * 0.0119, 2);
      pts.push(Math.round(x) + "px " + Math.round(y + (v - 0.75) * 46) + "px");
    }
    return "polygon(0px -20px, " + pts.join(", ") + ", " + W + "px -20px)";
  }

  function animate(now) {
    anim = now - animStart;
    var u = anim / DUR_TOTAL;
    if (!reduce) {
      draw((now - t0) / 1000);
      if (anim >= DUR_REVEAL_IN) {
        el.style.clipPath = revealClip((anim - DUR_REVEAL_IN) / DUR_REVEAL, (now - t0) / 1000);
      }
    }
    if (u >= 1) { finish(); return; }
    raf = requestAnimationFrame(animate);
  }

  function finish() {
    if (raf) cancelAnimationFrame(raf);
    if (waitTimer) { clearInterval(waitTimer); waitTimer = 0; }
    raf = 0; anim = -1;
    window.removeEventListener("resize", resize);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = cv = ctx = card = inp = msg = null;
    locked = false;
    /* hand the keyboard to the map — the app is a keyboard tool */
    try {
      var m = (window.SBMM && SBMM.map && SBMM.map.getContainer && SBMM.map.getContainer())
            || document.getElementById("map");
      if (m && m.focus) m.focus({ preventScroll: true });
    } catch (e) {}
    if (onDone) { var f = onDone; onDone = null; try { f(); } catch (e) {} }
  }

  function unlockAnimation() {
    remember();
    if (inp) inp.disabled = true;
    if (card) card.classList.add("gone");
    if (reduce) {
      el.classList.add("fadeout");
      setTimeout(finish, 320);
      return;
    }
    if (raf) cancelAnimationFrame(raf);
    animStart = performance.now();
    anim = 0;
    raf = requestAnimationFrame(animate);
  }

  /* --- submit --------------------------------------------------------- */

  function say(text, bad) {
    if (!msg) return;
    msg.textContent = text || "";
    msg.className = bad ? "bad" : "";
  }

  function submit() {
    if (!locked || busy || !inp) return;
    if (Date.now() < waitUntil) return;
    var pw = inp.value;
    if (!pw) { shake(); return; }
    busy = true;
    sha256Hex(SALT + pw).then(function (h) {
      busy = false;
      if (h === HASH) { wrong = 0; say(""); unlockAnimation(); return; }
      wrong++;
      inp.value = "";
      shake();
      if (wrong >= 3) { penalty(); } else { say("that is not it", true); }
    })["catch"](function () {
      busy = false;
      say("could not check that — reload the page", true);
    });
  }

  function shake() {
    if (!card) return;
    card.classList.remove("shake");
    /* force a reflow so the animation restarts on a second wrong try */
    void card.offsetWidth;
    card.classList.add("shake");
  }

  function penalty() {
    waitUntil = Date.now() + 3000;
    wrong = 0;
    if (inp) inp.disabled = true;
    if (waitTimer) clearInterval(waitTimer);
    var tick = function () {
      var left = Math.ceil((waitUntil - Date.now()) / 1000);
      if (left > 0) { say("that is not it — wait " + left + " s", true); return; }
      clearInterval(waitTimer); waitTimer = 0;
      say("");
      if (inp) { inp.disabled = false; focusField(); }
    };
    tick();
    waitTimer = setInterval(tick, 250);
  }

  /* --- keyboard. Capture on document, and gate.js is the first script, so
     this listener is the first one on that node: stopImmediatePropagation()
     here beats every other handler in the app, including the capture-phase
     ones in cmdline.js / layerman.js / cultural.js. Typing is unaffected —
     default actions are not prevented. -------------------------------- */
  function onKeyCapture(e) {
    if (!locked) return;
    if (e.type === "keydown") {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); if (inp) { inp.value = ""; } focusField(); }
    }
    e.stopImmediatePropagation();
  }
  document.addEventListener("keydown", onKeyCapture, true);
  document.addEventListener("keyup", onKeyCapture, true);
  document.addEventListener("keypress", onKeyCapture, true);

  /* --- focus trap. This is not politeness, it is the whole thing working:
     cmdline.js opens the command bar by itself on a browser's FIRST visit and
     calls inp.focus() while doing it, which lands a few seconds into boot —
     i.e. while someone is already typing their password. Without this the
     characters go into the command bar behind the gate (the default action of
     a keystroke is unaffected by stopping its propagation) and Enter submits
     an empty field. Anything that pulls focus out of the gate gets it taken
     straight back. ------------------------------------------------------- */
  document.addEventListener("focusin", function (e) {
    if (!locked || !el) return;
    if (el.contains(e.target)) return;
    focusField();
  }, true);

  /* ==================================================================== */
  /* public surface                                                       */
  /* ==================================================================== */

  function show(cb) {
    onDone = cb || null;
    if (locked) return;
    locked = true;
    wrong = 0; waitUntil = 0; busy = false;
    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build);
  }

  SBMM.gate = {
    locked: function () { return locked; },
    lock: function () { forget(); show(); },
    forget: forget,
    hash: function () { return HASH; }
  };

  if (!remembered()) show();

})();
