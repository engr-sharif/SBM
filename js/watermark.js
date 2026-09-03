/* SBMM Site Explorer — the attribution watermark, and the one place any canvas
   leaving the app gets stamped.

   Two halves of the same requirement (§10, and the export half of §7):

     element   a small "Mo Sharif - Jacobs 2026" mark in the bottom-right of the
               stage, 11 px, 55 % opacity, pointer-events:none, above the map and
               the 3D canvas and below every dialog and toast.

     burn-in   the same string drawn INTO every canvas the app exports — the 3D
               snapshot, the report's site figure, the report's section strips —
               because an element is not in a PNG. A screenshot that leaves the
               building without the mark is the failure this exists to prevent,
               so the burn is done by one function that every export calls rather
               than by each export remembering to.

   The confidentiality stamp rides along the same path: when a cultural-resource
   layer is visible, `burn()` also draws the red NHPA §304 stamp, so no export
   route can carry protected geometry without carrying its warning. That check is
   asked of js/cultural.js at burn time, not cached — a layer switched on between
   two exports must affect the second one. */
"use strict";

SBMM.watermark = (function () {

  const TEXT = "Mo Sharif - Jacobs 2026";
  let el = null;

  /* ---------------------------------------------------------------- */
  /* the on-screen element                                             */
  /* ---------------------------------------------------------------- */
  function mount() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "watermark";
    el.textContent = TEXT;
    /* The stage holds the map and the 3D canvas; the status bar sits below it.
       Anchoring to the stage rather than the viewport keeps the mark off the
       status bar's numbers at every dock width, and out of the way of the
       bottom-centre mode HUD §3 puts there. */
    (document.getElementById("stage") || document.body).appendChild(el);
    return el;
  }
  function text() { return TEXT; }

  /* ---------------------------------------------------------------- */
  /* the burn                                                          */
  /* ---------------------------------------------------------------- */
  /* Scale with the canvas: an 1100 px report figure and a 3000 px 3D snapshot
     both want a mark that reads at about the same physical size on paper. */
  function sizeFor(w, h) { return clamp(Math.round(Math.min(w, h) / 62), 10, 30); }

  function culturalStamp() {
    try {
      return (SBMM.cultural && SBMM.cultural.visible()) ? SBMM.cultural.stampText() : null;
    } catch (e) { return null; }
  }

  /* Draw the attribution (and, when it applies, the confidentiality stamp)
     into a 2D context that is already sized w x h. Safe to call more than once
     — it draws, it does not accumulate state. */
  function stamp(g, w, h, opts) {
    const o = opts || {};
    const fs = o.size || sizeFor(w, h);
    const pad = Math.round(fs * 0.8);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.textBaseline = "alphabetic";
    g.font = `${fs}px Helvetica, Arial, sans-serif`;
    g.textAlign = "right";
    /* a hairline of the opposite tone behind the text, so the mark survives
       being drawn over white paper and over a dark orthophoto alike */
    g.globalAlpha = 0.35;
    g.fillStyle = o.dark ? "#ffffff" : "#000000";
    g.fillText(TEXT, w - pad + 1, h - pad + 1);
    g.globalAlpha = 0.55;
    g.fillStyle = o.dark ? "#0E1418" : "#ffffff";
    g.fillText(TEXT, w - pad, h - pad);
    g.restore();

    const cs = o.confidential === undefined ? culturalStamp() : o.confidential;
    if (cs) drawConfidential(g, w, h, cs);
    return g;
  }

  /* The confidentiality stamp is deliberately loud: red, upper-case, boxed,
     across the top of the image. It is a legal notice, not decoration, and the
     one thing worse than an ugly figure is a figure whose reader does not know
     the locations on it are protected. */
  function drawConfidential(g, w, h, txt) {
    const fs = clamp(Math.round(Math.min(w, h) / 34), 11, 40);
    const pad = Math.round(fs * 0.55);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.font = `700 ${fs}px Helvetica, Arial, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "top";
    const tw = g.measureText(txt).width;
    const bw = Math.min(w - 8, tw + pad * 3), bh = fs + pad * 2;
    const bx = (w - bw) / 2, by = Math.round(fs * 0.5);
    g.globalAlpha = 0.86;
    g.fillStyle = "#ffffff";
    g.fillRect(bx, by, bw, bh);
    g.globalAlpha = 1;
    g.lineWidth = Math.max(2, fs / 8);
    g.strokeStyle = "#C62828";
    g.strokeRect(bx, by, bw, bh);
    g.fillStyle = "#C62828";
    g.fillText(txt, w / 2, by + pad);
    g.restore();
  }

  /* Stamp a canvas in place and hand it back, so an export can be written as
     `SBMM.watermark.burn(cv).toDataURL(...)`. `dark` picks the light-on-dark
     variant for the 3D snapshot; report figures are white paper. */
  function burn(cv, opts) {
    if (!cv || !cv.getContext) return cv;
    try { stamp(cv.getContext("2d"), cv.width, cv.height, opts); }
    catch (e) { console.error("watermark burn", e); }
    return cv;
  }

  /* A WebGL canvas has no 2D context, so the mark cannot be drawn onto it.
     Copy it into a 2D canvas, stamp that, and export from there — which also
     means the export is unaffected by whatever the GL context does next. */
  function burnWebGL(glCanvas, opts) {
    const cv = document.createElement("canvas");
    cv.width = glCanvas.width; cv.height = glCanvas.height;
    const g = cv.getContext("2d");
    g.drawImage(glCanvas, 0, 0);
    stamp(g, cv.width, cv.height, Object.assign({ dark: true }, opts || {}));
    return cv;
  }

  function wire() { mount(); }

  return { wire, mount, text, stamp, burn, burnWebGL, drawConfidential, element: () => el };
})();
