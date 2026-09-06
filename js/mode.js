/* SBMM Site Explorer — the tool-mode state machine (docs/V9_SPEC.md §2).

   Exactly one mode is active at a time. `SBMM.mode` holds it, every tool button
   in the top bar and every entry in the Draw / Design menus goes through it, and
   `SBMM.events.emit('mode', {from, to})` is how anything else finds out.

   Three rules carry the whole design:

     * **Esc always returns to `navigate`.** It cancels the in-progress sketch,
       drops the tool, and clears the button highlight, in that order. There is no
       state in which the pointer looks like a crosshair and the map answers
       nothing — that dead-button state was a real bug (see CLAUDE.md), and the
       fix before v9 was to re-arm, which left the button lit. §2 settles it the
       other way: one key, one destination, always.
     * **Space held is a temporary `navigate`.** Press it mid-sketch to pan, let
       go and you are back in the mode you were in, with the sketch intact.
     * **The mode owns the cursor and the HUD.** Nothing else sets either.

   The modes are a thin layer over js/tools.js rather than a replacement for it:
   `measure.distance` and `draw.line` are the same sketch engine and produce the
   same feature; what differs is what the user came to do, which is what the HUD
   and the button highlight are for. `syncFromTool` keeps the two honest when a
   command (or a test) reaches for `SBMM.tools.setTool` directly. */
"use strict";

SBMM.mode = (function () {

  /* tool   — the js/tools.js tool this mode arms, if any
     cursor — grab | crosshair | move   (§2 table)
     next   — what the app is waiting for, before the first click
     enter  — anything beyond arming the tool                              */
  const MODES = {
    "navigate": {
      label: "Navigate", cursor: "grab", esc: false,
      /* Navigate means two different sets of gestures depending on which view
         the pointer is over, and printing the 2D ones over a 3D scene is worse
         than printing nothing — the user tries them and the camera does
         something else. `nextFor` (F5) is resolved at paint time. */
      next: "drag to pan · wheel to zoom · click to identify",
      next3d: "drag to orbit · right-drag to pan · wheel to zoom · click to identify",
      enter() { SBMM.tools.setTool(null); }
    },
    "inspect": {
      label: "Inspect", tool: "inspect", cursor: "crosshair", key: "I",
      next: "click anywhere for a point card",
      enter() { SBMM.tools.setTool("inspect"); }
    },
    "measure.distance": {
      label: "Distance", tool: "distance", cursor: "crosshair", key: "M",
      next: "click the first point", more: "Enter or double-click to finish",
      enter() { SBMM.tools.setTool("distance"); }
    },
    "measure.area": {
      label: "Area", tool: "area", cursor: "crosshair", key: "A",
      next: "click the first boundary point", more: "Enter or double-click to close",
      enter() { SBMM.tools.setTool("area"); }
    },
    "measure.profile": {
      label: "Profile", tool: "profile", cursor: "crosshair",
      next: "click the start of the line", more: "Enter to finish",
      enter() { SBMM.tools.setTool("profile"); }
    },
    "volume": {
      label: "Volume", tool: "volume", cursor: "crosshair", key: "V",
      next: "click a footprint around the pile or excavation", more: "double-click to close",
      enter() { SBMM.tools.setTool("volume"); }
    },
    "draw.point": {
      label: "Point", tool: "point", cursor: "crosshair", key: "P",
      next: "click where the point goes",
      enter() { SBMM.tools.setTool("point"); }
    },
    "draw.line": {
      label: "Line", tool: "distance", cursor: "crosshair", key: "L",
      next: "click the first vertex", more: "Enter or double-click to finish",
      enter() { SBMM.tools.setTool("distance"); }
    },
    "draw.polygon": {
      label: "Polygon", tool: "area", cursor: "crosshair", key: "G",
      next: "click the first vertex", more: "Enter or double-click to close",
      enter() { SBMM.tools.setTool("area"); }
    },
    "section": {
      label: "Section", cursor: "crosshair", key: "S", transient: true,
      next: "click the alignment", more: "double-click to finish",
      enter() { SBMM.tools.setTool(null); SBMM.sections.cmdSections(); }
    },
    "dimension": {
      label: "Dimension", cursor: "crosshair", key: "N", transient: true,
      next: "click the first point",
      enter() { SBMM.tools.setTool(null); SBMM.tools.opDim(); }
    },
    "text": {
      label: "Text", cursor: "crosshair", key: "X", transient: true,
      next: "click where the label goes",
      enter() { SBMM.tools.setTool(null); SBMM.tools.opText(); }
    },
    "smartbound": {
      label: "Smart boundary", cursor: "crosshair", key: "B", transient: true,
      next: "click on the pile", more: "the residual is shown while the tool is armed",
      enter() { SBMM.tools.setTool(null); SBMM.smartbound.cmdWand(); }
    },
    "pad": {
      label: "Graded pad", cursor: "crosshair", key: "D", transient: true,
      next: "click the pad footprint", more: "double-click to finish",
      enter() { SBMM.tools.setTool(null); SBMM.design.cmdPad("pad"); }
    },
    /* Water (v10 §4.4). A click tool, not a sketch: every click traces another
       drop and the mode stays armed, which is what makes "where does water go
       from here… and from here" a conversation rather than a command. */
    "raindrop": {
      label: "Raindrop", tool: "raindrop", cursor: "crosshair", key: "R",
      next: "click where the drop lands", more: "every click traces another drop",
      enter() { SBMM.tools.setTool("raindrop"); }
    },
    /* Redline (v17 §5a). A freehand ink mode: no sketch engine, no vertices to
       finish — the stroke IS the gesture, and the mode stays armed so a
       mark-up is a series of strokes rather than a series of commands.
       js/redline.js owns everything it does; this row owns only the state.
       No single-key shortcut: every free letter is one somebody types by
       accident, and a mark-up tool that arms itself under the hand is worse
       than one more click. */
    "redline": {
      label: "Redline", cursor: "crosshair", transient: false,
      next: "draw with the Pencil or a finger", more: "Esc when done · the palette picks the colour",
      enter() { SBMM.tools.setTool(null); }
    },
    "edit": {
      label: "Edit vertices", cursor: "move", transient: true,
      next: "drag a handle to move it", more: "Delete removes a vertex · Enter finishes",
      enter() { /* entered by js/draw.js when a handle is grabbed */ }
    }
  };

  /* Which mode a bare tool name belongs to when something arms it directly
     (a command, a popup action, a test). Only consulted when the current mode
     does not already own that tool, so picking Line and then typing DIST does
     not silently rename what you are doing. */
  const TOOL_HOME = {
    inspect: "inspect", distance: "measure.distance", area: "measure.area",
    volume: "volume", profile: "measure.profile", point: "draw.point",
    raindrop: "raindrop"
  };

  let cur = "navigate";
  let prevForSpace = null;
  let hintText = "";

  function def(name) { return MODES[name] || MODES.navigate; }
  function current() { return cur; }
  function is(name) { return cur === name; }
  function label(name) { return def(name || cur).label; }

  /* ------------------------------------------------------------------ */
  /* the mode HUD (§2)                                                    */
  /* ------------------------------------------------------------------ */
  /* Which view the hint should describe (F5).

     Full 3D is 3D. Plain 2D is 2D. In SPLIT both are on screen at once, so the
     honest answer is "whichever the pointer is over" — and the default before
     the pointer has been anywhere is 2D, the left-hand pane. `overStage` is
     updated from a passive pointermove on the stage, so this costs one
     comparison per paint and nothing per frame. */
  let over3d = false;
  function view() {
    if (!SBMM.viewer3d || !SBMM.viewer3d.isOpen()) return "2d";
    if (!document.body.classList.contains("v3dsplit")) return "3d";
    return over3d ? "3d" : "2d";
  }

  /* Field mode is a touch device, and a prompt that says "wheel to zoom · click
     to identify" on a phone is telling the user to do something they cannot.

     This is a mapping over the FINAL string the HUD paints, not a second set of
     tips: `#sketchTip` keeps the exact words js/draw.js and js/tools.js write
     (the harnesses read those, and they are the machine-readable prompt), and
     the MODES table below is untouched. One place, keyed on `body.field`. */
  const TOUCH_WORDS = [
    [/\bdouble-click\b/g, "double-tap"],
    [/\bright-click\b/g, "press and hold"],
    [/\bright-drag\b/g, "two-finger drag"],
    [/\bright \/ middle-drag\b/g, "two-finger drag"],
    [/\bwheel to zoom\b/g, "pinch to zoom"],
    [/\bscroll to zoom\b/g, "pinch to zoom"],
    [/\bclicks\b/g, "taps"],
    [/\bclick\b/g, "tap"],
    [/\bclicking\b/g, "tapping"]
  ];
  function forTouch(s) {
    if (!s || !document.body.classList.contains("field")) return s;
    let out = s;
    for (const [re, to] of TOUCH_WORDS) out = out.replace(re, to);
    return out;
  }

  function paintHud() {
    const el = document.getElementById("modeHud");
    if (!el) return;
    const d = def(cur);
    el.querySelector(".mhname").textContent = d.label;
    /* the sketch engine's prompt already opens with the tool's name ("Area —
       click the boundary…"), and the HUD is showing that name a centimetre to
       the left; strip it rather than saying it twice */
    let h = hintText;
    if (h) {
      const re = new RegExp("^\\s*" + d.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[—:-]\\s*", "i");
      h = h.replace(re, "");
    }
    const base = (view() === "3d" && d.next3d) ? d.next3d : d.next;
    const next = h || [base, d.more].filter(Boolean).join(" · ");
    el.querySelector(".mhnext").textContent = forTouch(next) || "";
    el.querySelector(".mhesc").textContent = cur === "navigate" ? "" : "Esc → Navigate";
    el.classList.toggle("nav", cur === "navigate");
  }
  /* The live prompt. js/draw.js already writes exactly this sentence into
     #sketchTip on every step of a sketch, so rather than teach five call sites
     about the HUD, the HUD watches that one element. A MutationObserver here is
     safe because nothing in this file writes back into #sketchTip — the trap
     documented in CLAUDE.md is a watcher that mutates what it watches. */
  function hint(t) { hintText = t || ""; paintHud(); }

  /* ------------------------------------------------------------------ */
  /* cursor + button highlight                                            */
  /* ------------------------------------------------------------------ */
  function paintChrome() {
    const d = def(cur);
    const stage = document.getElementById("stage");
    if (stage) stage.dataset.cursor = d.cursor || "grab";
    const map = document.getElementById("map");
    if (map) map.classList.toggle("tool-none", cur === "navigate");
    document.querySelectorAll(".toolbtn[data-mode]").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === cur));
    /* the five buttons that are also js/tools.js tools carry data-tool, and the
       e2e reads `.toolbtn.active[data-tool]` as "a tool is armed" */
    document.querySelectorAll(".toolbtn[data-tool]").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === cur));
    paintMenuButtons();
  }

  /* A mode reached through Draw ▾ or Design ▾ has no button of its own, so
     nothing in the top bar was lit while the HUD said "Dimension" — the user
     could see what they were in but not where it came from or how to leave it
     (F7). The parent button now lights up and wears the mode's name. */
  function paintMenuButtons() {
    for (const [btnId, menuId] of [["drawMenuBtn", "drawMenu"], ["designMenuBtn", "designMenu"],
                                   ["waterMenuBtn", "waterMenu"]]) {
      const btn = document.getElementById(btnId), menu = document.getElementById(menuId);
      if (!btn || !menu) continue;
      const lbl = btn.querySelector(".tlbl");
      if (!lbl) continue;
      if (!btn.dataset.homeLabel) {
        btn.dataset.homeLabel = lbl.textContent;
        btn.dataset.homeTitle = btn.title || "";
      }
      /* mode names carry dots ("measure.area"); the value is quoted in the
         attribute selector, so it needs no escaping — and CSS.escape here
         would actively break it */
      const owns = [...menu.querySelectorAll(".ci[data-m]")].some(ci => ci.dataset.m === cur);
      btn.classList.toggle("active", owns);
      lbl.textContent = owns ? def(cur).label + " ▾" : btn.dataset.homeLabel;
      btn.title = owns
        ? def(cur).label + " is active — Esc returns to Navigate. Click for the rest of this menu."
        : (btn.dataset.homeTitle || "");
    }
  }

  /* ------------------------------------------------------------------ */
  /* the transition                                                       */
  /* ------------------------------------------------------------------ */
  function set(name, opts) {
    opts = opts || {};
    if (!MODES[name]) name = "navigate";
    const from = cur;
    /* Re-picking the mode you are already in restarts it — that is what a CAD
       user expects from clicking an armed button, and it is the cheap way out
       of a half-finished sketch without reaching for Esc. */
    cur = name;
    hintText = "";
    if (!opts.silent) {
      try { def(name).enter(); } catch (e) { console.error("mode " + name, e); toast(def(name).label + " failed: " + e.message); }
    }
    paintChrome(); paintHud();
    if (from !== name) SBMM.events.emit("mode", { from, to: name });
    return cur;
  }

  function navigate(reason) {
    if (SBMM.draw) {
      if (SBMM.draw.isPicking()) SBMM.draw.endPick(true);
      if (SBMM.draw.isDrawing()) SBMM.draw.cancel();
      if (SBMM.draw.isEditing && SBMM.draw.isEditing()) SBMM.draw.endEdit();
    }
    if (SBMM.cmd && SBMM.cmd.cancelPick) SBMM.cmd.cancelPick(true);
    set("navigate");
    if (reason) toast(reason);
    return "navigate";
  }

  /* js/tools.js calls this whenever setTool changes the armed tool, so a
     command line "DIST" or a popup action lands on the right mode without every
     one of them knowing the mode names. */
  function syncFromTool(tool) {
    const d = def(cur);
    if ((d.tool || null) === (tool || null)) { paintChrome(); return; }
    const home = tool ? TOOL_HOME[tool] : "navigate";
    if (!home) { paintChrome(); return; }
    const from = cur;
    cur = home; hintText = "";
    paintChrome(); paintHud();
    if (from !== cur) SBMM.events.emit("mode", { from, to: cur });
  }

  /* js/draw.js announces the edit handle grab and release */
  function beginEdit() { if (cur !== "edit") { editReturn = cur; set("edit", { silent: true }); } }
  function endEdit() { if (cur === "edit") { const back = editReturn || "navigate"; editReturn = null; set(back, { silent: back === "navigate" }); } }
  let editReturn = null;

  /* ------------------------------------------------------------------ */
  /* keyboard                                                             */
  /* ------------------------------------------------------------------ */
  const KEYS = {};
  for (const name in MODES) if (MODES[name].key) KEYS[MODES[name].key.toLowerCase()] = name;

  function typing(t) {
    return !t || t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable;
  }
  function overlayOwnsKeys(t) {
    return !!(t && t.closest && t.closest(".shwin, .modal, #reportModal, #cmdHelp, #help, .sheetpick, #layerMan"));
  }

  function wire() {
    paintChrome(); paintHud();

    document.querySelectorAll(".toolbtn[data-mode]").forEach(b => {
      b.onclick = () => set(b.dataset.mode);
    });

    /* Which pane the pointer is over, for the view-aware Navigate hint (F5).
       Passive, allocation-free, and it only repaints when the answer actually
       changes — a hover path must not do work per pixel. */
    const v3d = document.getElementById("view3d");
    if (v3d) {
      const onto = flag => () => { if (over3d !== flag) { over3d = flag; if (cur === "navigate") paintHud(); } };
      v3d.addEventListener("pointerover", onto(true), { passive: true });
      const map2d = document.getElementById("map");
      if (map2d) map2d.addEventListener("pointerover", onto(false), { passive: true });
    }
    /* opening, closing or splitting the 3D view changes what Navigate means */
    SBMM.events.on("view", () => paintHud());
    /* and so does turning field mode on or off — the same prompt, in the words
       of the device that is in front of the user */
    SBMM.events.on("field", () => paintHud());

    /* the two top-bar drop-downs */
    wireMenu("drawMenuBtn", "drawMenu");
    wireMenu("designMenuBtn", "designMenu");

    /* live prompt: mirror whatever the sketch engine is asking for */
    const tip = document.getElementById("sketchTip");
    if (tip && window.MutationObserver) {
      new MutationObserver(() => {
        const shown = tip.style.display !== "none" && tip.textContent.trim();
        hint(shown ? tip.textContent.trim() : "");
      }).observe(tip, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    }

    document.addEventListener("keydown", e => {
      const t = e.target;
      if (typing(t) || overlayOwnsKeys(t)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      /* Space held = temporary navigate pan, in any mode (§2). The sketch is
         left alone: this is a camera gesture, not a cancel. */
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        if (cur !== "navigate") {
          prevForSpace = cur;
          const d = def(cur);
          cur = "navigate"; paintChrome();
          hint("hold Space to pan — release to return to " + d.label);
        }
        return;
      }
      if (e.key === "/") { e.preventDefault(); SBMM.cmd.open(true); return; }

      const k = e.key.toLowerCase();
      /* the 3D fly rig owns WASD/QE while it is engaged, and F toggles it */
      if (k === "f" && SBMM.viewer3d.isOpen()) { SBMM.viewer3d.toggleFly(); return; }
      if (SBMM.viewer3d.isFly() && "wasdqe".includes(k)) return;
      if (KEYS[k]) { e.preventDefault(); set(KEYS[k]); return; }
      if (k === "t") SBMM.table.toggle();
      if (k === "3") SBMM.viewer3d.toggle();
    });

    document.addEventListener("keyup", e => {
      if (e.code !== "Space" || !prevForSpace) return;
      const back = prevForSpace; prevForSpace = null;
      cur = back; paintChrome(); hint("");
    });
    window.addEventListener("blur", () => {
      if (!prevForSpace) return;
      cur = prevForSpace; prevForSpace = null; paintChrome(); hint("");
    });

    /* Esc: the one key that always lands somewhere known. It runs in the
       BUBBLE phase and only after everything with its own Esc (a modal, a sheet
       window, the typed-input box, the command bar) has had its say and stopped
       the event — that ordering is what keeps Esc from cancelling a sketch that
       happens to be open behind a dialog. */
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (typing(e.target) || overlayOwnsKeys(e.target)) return;
      SBMM.store.select(null);
      navigate();
    });

    SBMM.events.on("mode", () => { if (SBMM.snap && SBMM.snap.redraw) SBMM.snap.redraw(); });
  }

  function wireMenu(btnId, menuId) {
    const btn = document.getElementById(btnId), menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    btn.onclick = e => {
      e.stopPropagation();
      const open = menu.style.display === "block";
      document.querySelectorAll("#drawMenu,#designMenu,#waterMenu,#exportMenu,#ovfMenu").forEach(m => m.style.display = "none");
      menu.style.display = open ? "none" : "block";
      if (!open) {
        const r = btn.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + "px";
        menu.style.right = "auto";
      }
    };
    menu.addEventListener("click", ev => {
      const ci = ev.target.closest(".ci");
      menu.style.display = "none";
      if (!ci) return;
      if (ci.dataset.m) { set(ci.dataset.m); return; }
      const a = ci.dataset.a;
      if (a === "cbound") { navigate(); SBMM.smartbound.cmdCbound(); }
      else if (a === "toe") { navigate(); SBMM.smartbound.cmdToe(); }
      else if (a === "gradepad") { navigate(); SBMM.design.cmdPad("plane"); }
      else if (a === "existing") { navigate(); SBMM.design.cmdExisting(); }
      else if (a === "isopach") SBMM.isopach.dialog();
      else if (a === "volsurf") SBMM.isopach.volumeVsSurface();
      else if (a === "layerman") SBMM.layerMan.open();
    });
    document.addEventListener("click", e => {
      if (!menu.contains(e.target) && e.target !== btn) menu.style.display = "none";
    });
  }

  return { wire, set, current, is, label, navigate, syncFromTool, hint,
           beginEdit, endEdit, MODES, defOf: def };
})();

/* ---------------------------------------------------------------------- */
/* the status bar (§2): E N Z, lat/long, scale and snap state, both views   */
/* ---------------------------------------------------------------------- */
SBMM.status = (function () {
  function at(x, y, zIn) {
    const sx = document.getElementById("sX"); if (!sx) return;
    sx.textContent = fmt0(x);
    document.getElementById("sY").textContent = fmt0(y);
    if (SBMM.AFF) {
      const [lo, la] = SBMM.toLL(x, y);
      document.getElementById("sLL").textContent = la.toFixed(6) + ", " + lo.toFixed(6);
    }
    const [z, src] = SBMM.elev(x, y);
    const zz = (zIn == null || isNaN(zIn)) ? z : zIn;
    document.getElementById("sZ").textContent = isNaN(zz) ? "—" : fmt(zz, 1) + " ft";
    const ch = SBMM.chm ? SBMM.canopy(x, y) : NaN;
    /* v19 §2: "upstream area 12.4 ac" while the flow-accumulation row is on.
       One string from the module that owns the raster — it answers "" when the
       row is off, when there is no result and when the cell has none. */
    const up = (SBMM.accum && SBMM.accum.hoverText) ? SBMM.accum.hoverText(x, y) : "";
    document.getElementById("sDem").textContent = src + (ch > 0.5 ? ` · veg ${fmt(ch, 0)} ft` : "") + up;
  }
  function scale() {
    const el = document.getElementById("sScale");
    if (!el || !SBMM.map) return;
    const pxPerFt = Math.pow(2, SBMM.map.getZoom());
    /* 96 CSS px to the inch is the convention every browser prints at */
    const denom = Math.round(96 / pxPerFt / 12);
    el.textContent = denom >= 1 ? `1" = ${denom} ft` : `${(1 / Math.max(denom, 1e-6)).toFixed(0)}× `;
    el.title = "Approximate plan scale at 96 dpi";
  }
  return { at, scale };
})();
