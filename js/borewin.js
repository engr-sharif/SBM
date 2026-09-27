/* SBMM Site Explorer — the boring-log window (v23 Phase A).

   The 2025 investigation is 44 holes, 476 strata, 516 SPT drives, 774 lab
   values and a logged waste/native contact in every one of them. Until v23 it
   was a 300-px strip in a results card. This is the instrument: a floating
   window on the sheet-window chassis carrying three faces of the same data —

     Log       one hole as a log sheet, drawn at a real scale (1 in = 5 ft by
               default), every column a gINT/LogPlot sheet carries, with a
               depth cursor that reads both axes at once;
     Compare   two to six holes standing on ONE elevation datum, their true
               horizontal separations printed between them, the native
               contact / bedrock top / water level correlated across;
     Table     the 44-hole reconciliation sheet at full width.

   ONE WINDOW. Opening another hole reuses it — a log viewer that stacks
   windows is a light table, and a light table is what js/sheets.js already is.

   Everything is drawn by SBMM.borelogs.column() (v23 §1). Nothing here knows
   what a stratum looks like; it knows where to put one.

   THE CHASSIS IS js/sheets.js's. The element carries `.shwin` as well as
   `.blwin`, which buys the title bar, the grip, the maximise behaviour, the
   4000-4899 stacking band, `body.touch` opening maximised, `body.field`
   becoming a full-screen sheet — and, because js/mode.js tests for `.shwin`,
   the single-letter tool shortcuts are swallowed while the window has focus
   (without that, pressing `3` while reading a log opens the 3D view behind
   it). Esc is shared: js/sheets.js asks ownsEscape() before it claims one.

   Payload tolerance: SBMM_DATA.borings_logs is small and is in every build,
   but if it is ever absent open() refuses with a toast and nothing throws. */
"use strict";

SBMM.borewin = (function () {

  const BL = () => SBMM.borelogs;
  const Z = 4890;                       /* inside the sheet-window band       */
  const SCALES = [2, 5, 10, 20];        /* 1 in = N ft                        */
  const DPI = 96;
  /* THE PAGE HEIGHT IS ARITHMETIC, NOT A TASTE. Letter is 11 in; at 0.35 in
     margins 10.3 in of it prints. The header block is ~1.15 in, so 9.1 in is
     left for the drawing, and at 1 in = 5 ft (19.2 px/ft, the browser's own
     96 dpi) that is 43 ft plus the 30 px heading strip and a 10 px foot.
     Change any of those four numbers and re-do this division — a log sheet
     that silently spills onto a second sheet of paper is worse than a coarser
     scale. SB-10, the deepest hole at 126.4 ft, comes out at 3 pages. */
  const PAGE_FT = 43;
  const MAXCMP = 6;

  let W = null;                         /* the ONE window state               */
  let cur = null, tab = "log", scale = 5, datum = "depth";
  let cmp = [];                         /* the compare selection, hole ids    */
  let cmpCleared = false;               /* the user emptied it on purpose     */
  let fnPick = [];                      /* holes ticked for a through-fence   */

  const ppf = () => DPI / scale;
  const has = () => !!(BL() && BL().has());
  /* The desktop minimum is a readable log sheet; a PHONE's whole stage is
     narrower than that, and a CSS min-width of 520 px on a 412-px stage makes
     the window wider than the screen it is maximised into. Under body.touch
     the window fills the stage, so the floor comes off. */
  const touchy = () => !!(SBMM.touch && SBMM.touch.on());
  const minW = () => touchy() ? 240 : 520;
  const minH = () => touchy() ? 200 : 340;

  /* ------------------------------------------------------------------ */
  /* geometry — the stage box, borrowed from js/sheets.js                */
  /* ------------------------------------------------------------------ */
  /* v26 (docs/V26_UI_AUDIT.md §5, §8): A SPECIALIST VIEW TAKES THE STAGE. The
     log window opens over the whole stage below the top bar — the floating
     layer panel included — because a log sheet, its navigator and its rail
     need the width, and the map is one Esc away. In field mode (the phone) the
     stage is the stage, as it always was. */
  function stageBox() {
    const b = document.body;
    if (!b.classList.contains("field") && document.getElementById("topbar")) {
      const cs = getComputedStyle(b);
      const gap = parseFloat(cs.getPropertyValue("--gap")) || 12;
      const tb = document.getElementById("topbar").getBoundingClientRect();
      const y = Math.round(tb.bottom + gap);
      return { x: gap, y, w: Math.max(200, innerWidth - 2 * gap), h: Math.max(200, innerHeight - y - gap) };
    }
    if (SBMM.sheets && SBMM.sheets.stageBox) return SBMM.sheets.stageBox();
    return { x: 8, y: 8, w: Math.max(200, innerWidth - 16), h: Math.max(200, innerHeight - 16) };
  }
  function clampToStage() {
    if (!W) return;
    const el = W.el, b = stageBox();
    const w = Math.min(el.offsetWidth, b.w - 12), h = Math.min(el.offsetHeight, b.h - 12);
    if (el.offsetWidth > w) el.style.width = Math.round(w) + "px";
    if (el.offsetHeight > h) el.style.height = Math.round(h) + "px";
    el.style.left = Math.round(clamp(el.offsetLeft, b.x + 6, Math.max(b.x + 6, b.x + b.w - w - 6))) + "px";
    el.style.top = Math.round(clamp(el.offsetTop, b.y + 6, Math.max(b.y + 6, b.y + b.h - h - 6))) + "px";
  }
  function follow() {                   /* the stage moved under the window   */
    if (!W) return;
    if (W.maxed) {
      const b = stageBox(), el = W.el;
      el.style.left = Math.round(b.x + 4) + "px"; el.style.top = Math.round(b.y + 4) + "px";
      el.style.width = Math.round(b.w - 8) + "px"; el.style.height = Math.round(b.h - 8) + "px";
    } else clampToStage();
    paint();
  }

  /* ------------------------------------------------------------------ */
  /* open / close                                                        */
  /* ------------------------------------------------------------------ */
  function open(id, opts) {
    if (!has()) { toast("this build has no boring logs"); return null; }
    const o = opts || {};
    const h = id ? BL().byId(id) : (cur ? BL().byId(cur) : BL().holes()[0]);
    if (id && !h) { toast(`no boring log for “${id}” — type LOGS for the list`); return null; }
    cur = (h || BL().holes()[0]).id;
    if (o.tab) tab = o.tab;
    if (!W) build(o);
    front();
    if (tab === "compare" && !cmp.length) cmp = nearest(cur, 4);
    paint();
    setTimeout(() => { if (W) W.el.focus({ preventScroll: true }); }, 30);
    return W;
  }

  function build(o) {
    const el = document.createElement("div");
    el.className = "shwin blwin";
    el.tabIndex = 0;
    el.dataset.borewin = "1";
    el.innerHTML = `
      <div class="shbar">
        <span class="bwcrumb"><span>Borings</span><i>/</i><span class="bwarea0">—</span><i>/</i></span>
        <span class="shno bwid" title="Find a boring">—</span>
        <span class="shtitle">Boring log</span>
        <span class="spacer"></span>
        <button class="minib bwstep" data-d="-1" title="Previous boring (Left arrow)" aria-label="Previous boring">‹</button>
        <button class="minib bwstep" data-d="1" title="Next boring (Right arrow)" aria-label="Next boring">›</button>
        <span class="vsep"></span>
        <button class="minib shmax bwmax" title="Restore the window to its previous size" aria-label="Maximise">⤢</button>
        <span class="ic x bwclose" title="Close (Esc)" role="button" aria-label="Close">✕</span>
      </div>
      <div class="bwtools">
        <span class="bwtabs" role="tablist">
          <button class="minib bwtab" data-t="log" role="tab" title="The log sheet for one hole">Log</button>
          <button class="minib bwtab" data-t="compare" role="tab" title="Two to six holes on one elevation datum">Compare</button>
          <button class="minib bwtab" data-t="fence" role="tab" title="A section through the borings along a drawn line">Fence</button>
          <button class="minib bwtab" data-t="table" role="tab" title="Every hole, sortable and filterable by waste area">Table</button>
        </span>
        <label class="bwlbl">scale
          <select class="bwscale" title="Drawing scale (+ / − to change)">
            ${SCALES.map(s => `<option value="${s}">1" = ${s}'</option>`).join("")}
          </select></label>
        <label class="bwlbl">datum
          <select class="bwdatum" title="Depth below ground, or elevation NAVD88">
            <option value="depth">depth</option><option value="elev">elevation</option>
          </select></label>
        <span class="spacer"></span>
        <button class="minib bwghost" data-b="story" aria-pressed="false" title="What this hole found, both contact statements, the profiles and the location — as a panel over the sheet">summary</button>
        <button class="minib bwghost" data-b="map" title="Show this boring on the map and on its 3D stick">show on map</button>
        <button class="minib bwghost" data-b="csv" title="Copy this hole's strata, SPT, penetrometer and lab tables">csv</button>
        <button class="minib bwghost" data-b="png" title="Save what is drawn as a PNG">png</button>
        <button class="minib bwghost" data-b="printarea" title="Every log in this hole's waste area">print area</button>
        <button class="minib bwghost" data-b="printall" title="Every log in id order, as one document">print all</button>
        <button class="minib bwpri" data-b="print" title="Printed log sheet at 1 in = 5 ft (Print → PDF)">Print log sheet</button>
      </div>
      <div class="bwmain">
        <aside class="bwnav" aria-label="Borings">
          <span class="bwpickwrap">
            <input class="bwpick" type="search" placeholder="Search holes, areas, USCS…" autocomplete="off"
                   spellcheck="false" title="Find a boring by id, waste area or USCS symbol">
            <div class="bwflt" role="group" aria-label="Filter">
              <button class="bwfc on" data-f="">All</button>
              <button class="bwfc" data-f="differ" title="The logger's remark and the strata rows put the contact at different depths">Contacts differ</button>
              <button class="bwfc" data-f="water">Water</button>
              <button class="bwfc" data-f="refusal">Refusal</button>
            </div>
            <div class="bwmenu" role="listbox"></div>
          </span>
        </aside>
        <section class="bwcenter">
          <div class="bwpaper">
            <div class="bwhead">
              <div class="bwfacts"></div>
              <div class="bwmorebox" hidden></div>
              <div class="bwcurrow"></div>
              <div class="bwheadstrip" hidden></div>
            </div>
            <div class="bwbody"><div class="bwcur" hidden><i></i></div><div class="bwart"></div></div>
          </div>
        </section>
        <aside class="bwrail" aria-label="What this hole found"></aside>
      </div>
      <div class="shfoot">
        <span class="mono bwfoot">—</span>
        <span class="spacer"></span>
        <span class="mut bwprov">OpenGround logs · 2025 Jacobs investigation · approved</span>
      </div>
      <div class="shgrip" title="Drag to resize"></div>`;
    document.body.appendChild(el);

    const b = stageBox();
    /* v26: the stage view is the default everywhere; ⤢ restores a floating
       window for anyone who wants the map beside the log */
    const maxed = true;
    const w = maxed ? Math.round(b.w - 8) : Math.round(clamp(b.w * 0.94, minW(), Math.max(minW(), b.w - 16)));
    const hh = maxed ? Math.round(b.h - 8) : Math.round(clamp(b.h * 0.92, minH(), Math.max(minH(), b.h - 16)));
    el.style.width = w + "px"; el.style.height = hh + "px";
    el.style.left = Math.round(clamp(b.x + (b.w - w) / 2, b.x + 6, Math.max(b.x + 6, b.x + b.w - w - 6))) + "px";
    el.style.top = Math.round(clamp(b.y + (b.h - hh) / 2, b.y + 6, Math.max(b.y + 6, b.y + b.h - hh - 6))) + "px";
    el.style.zIndex = Z;
    if (maxed) {
      el.classList.add("maxed");
      const bt = el.querySelector(".bwmax");
      if (bt) { bt.textContent = "⤡"; bt.classList.add("on"); }
    }

    W = { el, maxed, restore: maxed ? { l: Math.round(b.x + b.w * 0.08), t: Math.round(b.y + b.h * 0.05),
                                         w: Math.round(b.w * 0.84), h: Math.round(b.h * 0.9) } : null, pin: null,
          nav: el.querySelector(".bwnav"), rail: el.querySelector(".bwrail"), center: el.querySelector(".bwcenter"),
          head: el.querySelector(".bwhead"), facts: el.querySelector(".bwfacts"),
          currow: el.querySelector(".bwcurrow"),
          more: el.querySelector(".bwmorebox"), strip: el.querySelector(".bwheadstrip"),
          body: el.querySelector(".bwbody"),
          art: el.querySelector(".bwart"), cursor: el.querySelector(".bwcur") };
    wireWindow();

    /* the same rise js/sheets.js gives a drawing */
    const r = el.getBoundingClientRect();
    const ox = (o && o.origin) ? o.origin.x : r.left + r.width / 2;
    const oy = (o && o.origin) ? o.origin.y : r.top + r.height / 2;
    el.style.transition = "none"; el.style.opacity = "0";
    el.style.transform = `translate(${(ox - (r.left + r.width / 2)).toFixed(1)}px,`
      + `${(oy - (r.top + r.height / 2)).toFixed(1)}px) scale(.08)`;
    void el.offsetWidth;
    el.style.transition = "transform .25s var(--ease), opacity .18s linear";
    el.style.opacity = "1"; el.style.transform = "translate(0,0) scale(1)";
    return W;
  }

  function close() {
    if (!W) return false;
    const el = W.el;
    el.style.transition = "transform .18s var(--ease), opacity .16s linear";
    el.style.opacity = "0"; el.style.transform = "scale(.94)";
    setTimeout(() => { try { el.remove(); } catch (e) { /* gone */ } }, 200);
    W = null;
    if (SBMM.viewer3d && SBMM.viewer3d.highlightStratum) SBMM.viewer3d.highlightStratum(null);
    return true;
  }
  function front() { if (W) W.el.style.zIndex = Z; }
  const isOpen = () => !!W;

  /* js/sheets.js asks this before it claims Esc: the front-most floating thing
     owns it, and while the log window has the focus that is this one. */
  function ownsEscape() {
    if (!W) return false;
    const a = document.activeElement;
    if (a && a.closest && a.closest(".blwin")) return true;
    return !(SBMM.sheets && SBMM.sheets.openCount && SBMM.sheets.openCount() > 0);
  }

  function maximise(want) {
    if (!W) return false;
    const el = W.el;
    want = want == null ? !W.maxed : !!want;
    if (want === W.maxed) return W.maxed;
    if (want) {
      W.restore = { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      const b = stageBox();
      el.style.transition = "none";
      el.style.left = Math.round(b.x + 4) + "px"; el.style.top = Math.round(b.y + 4) + "px";
      el.style.width = Math.round(b.w - 8) + "px"; el.style.height = Math.round(b.h - 8) + "px";
      el.classList.add("maxed");
    } else {
      const r = W.restore;
      el.style.transition = "none";
      if (r) { el.style.left = r.l + "px"; el.style.top = r.t + "px";
               el.style.width = r.w + "px"; el.style.height = r.h + "px"; }
      el.classList.remove("maxed");
      clampToStage();
    }
    W.maxed = want;
    const bt = el.querySelector(".bwmax");
    if (bt) { bt.textContent = want ? "⤡" : "⤢"; bt.classList.toggle("on", want);
              bt.title = want ? "Restore the window to its previous size" : "Maximise to the stage"; }
    paint();
    return W.maxed;
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */
  function wireWindow() {
    const el = W.el;
    el.addEventListener("pointerdown", front, true);
    el.querySelector(".bwclose").onclick = close;
    el.querySelector(".bwmax").onclick = () => maximise();
    el.querySelectorAll(".bwstep").forEach(b => b.onclick = () => step(+b.dataset.d));
    el.querySelectorAll(".bwtab").forEach(b => b.onclick = () => { tab = b.dataset.t; paint(); });
    const sc = el.querySelector(".bwscale");
    sc.value = String(scale);
    sc.onchange = () => { scale = +sc.value; paint(); };
    const dt = el.querySelector(".bwdatum");
    dt.value = datum;
    dt.onchange = () => { datum = dt.value; paint(); };
    el.querySelector(".bwtools").addEventListener("click", ev => {
      const b = ev.target.dataset && ev.target.dataset.b;
      if (!b) return;
      if (b === "print") printSheet([cur]);
      if (b === "printall") printSheet(BL().ids());
      if (b === "printarea") printArea();
      if (b === "csv") {
        const t = csvNow();
        if (!t) { toast("nothing on this tab to copy"); return; }
        copyText(t, tab === "table" ? `${BL().holes().length} holes copied as CSV`
          : tab === "fence" ? "the fence copied as CSV" : `${cur} log copied as CSV`);
      }
      if (b === "png") exportPng();
      if (b === "story") {
        const on = !W.el.classList.contains("bwpeek");
        W.el.classList.toggle("bwpeek", on);
        ev.target.setAttribute("aria-pressed", String(on));
        if (on) paintRail(BL().byId(cur));
      }
      if (b === "map") showOnMap();
    });
    wirePicker();

    /* move by the title bar, resize by the grip — the sheet-window gestures */
    const bar = el.querySelector(".shbar");
    let mv = null;
    bar.addEventListener("pointerdown", e => {
      if (e.target.closest("button, .ic")) return;
      mv = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop };
      bar.setPointerCapture(e.pointerId);
      el.style.transition = "none";
    });
    bar.addEventListener("pointermove", e => {
      if (!mv) return;
      el.style.left = (mv.l + e.clientX - mv.x) + "px";
      el.style.top = (mv.t + e.clientY - mv.y) + "px";
      clampToStage();
    });
    bar.addEventListener("pointerup", () => { mv = null; });

    const grip = el.querySelector(".shgrip");
    let rz = null;
    grip.addEventListener("pointerdown", e => {
      rz = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
      grip.setPointerCapture(e.pointerId); el.style.transition = "none"; e.stopPropagation();
    });
    grip.addEventListener("pointermove", e => {
      if (!rz) return;
      const b = stageBox();
      el.style.width = clamp(rz.w + e.clientX - rz.x, minW(), Math.max(minW(), b.x + b.w - el.offsetLeft - 6)) + "px";
      el.style.height = clamp(rz.h + e.clientY - rz.y, minH(), Math.max(minH(), b.y + b.h - el.offsetTop - 6)) + "px";
      clampToStage(); paint();
    });
    grip.addEventListener("pointerup", () => { rz = null; paint(); });

    /* the depth cursor: one rule across every column, reading both axes and
       naming the stratum, the drive and the nearest test under it */
    W.body.addEventListener("mousemove", onCursor);
    W.body.addEventListener("mouseleave", () => {
      if (W && W.pin == null) { W.cursor.hidden = true; railCursor(null, null); }
    });
    W.body.addEventListener("click", ev => {
      if (tab === "log" && !(ev.target.closest && ev.target.closest("button, a, input, select"))) {
        const y = ev.clientY - W.art.getBoundingClientRect().top;
        if (y > 0 && y < W.art.offsetHeight) pinCursor(y);
      }
      onArtClick(ev);
    });
    W.body.addEventListener("mouseover", onArtHover);
    W.rail.addEventListener("click", e => {
      const d = e.target.closest && e.target.closest(".bwloc");
      if (d) { cur = d.dataset.id; paint(); }
    });
    if (window.ResizeObserver) {
      let rq = 0;
      new ResizeObserver(() => { cancelAnimationFrame(rq); rq = requestAnimationFrame(() => {
        if (!W) return;
        const had = W.el.className; layoutCols();
        if (W.el.className !== had) paint();
      }); }).observe(el);
    }

    /* keys. An arrow inside the window must never reach js/viewer3d.js's
       orbit — its handler already leaves a focused element outside #stage
       alone, and this window is a child of <body>, so stopping propagation
       here is belt and braces rather than the mechanism. */
    el.addEventListener("keydown", e => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") { t.blur(); e.stopPropagation(); e.preventDefault(); }
        return;
      }
      const k = e.key;
      if (k === "Escape") { close(); e.stopPropagation(); e.preventDefault(); return; }
      if (k === "ArrowLeft") step(-1);
      else if (k === "ArrowRight") step(1);
      else if (k === "ArrowUp") W.body.scrollTop -= e.shiftKey ? 400 : 90;
      else if (k === "ArrowDown") W.body.scrollTop += e.shiftKey ? 400 : 90;
      else if (k === "+" || k === "=") setScale(-1);
      else if (k === "-" || k === "_") setScale(1);
      else if (k === "Home") W.body.scrollTop = 0;
      else if (k === "End") W.body.scrollTop = W.body.scrollHeight;
      else return;
      e.stopPropagation(); e.preventDefault();
    });

    /* the heading band is a separate element, so it has to follow the body's
       own horizontal scroll or it stops naming the columns under it */
    W.body.addEventListener("scroll", () => {
      if (W && W.strip) W.strip.scrollLeft = W.body.scrollLeft;
    }, { passive: true });

    /* CTRL+WHEEL ZOOMS ABOUT THE POINTER, keeping the depth under it fixed —
       the same contract the map's wheel has. The scale menu is discrete
       (1 in = 2 / 5 / 10 / 20 ft), so the step is one entry of it and the
       scroll is re-solved for the depth that was under the pointer. */
    W.body.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (tab !== "log" || !W.geom) return;
      /* SOLVE IN SCREEN COORDINATES, not in scrollTop arithmetic. The drawing
         sits inside a padded, scrolled box under a header whose height is not
         a constant, and every one of those is a term the offsetTop form has to
         get right; the client rectangle after the repaint already carries all
         of them, so the correction is simply "how far did this depth move". */
      /* AND THE DRAWING'S TOP MARGIN IS PART OF THE MAPPING. y = 0 in the
         SVG is the top of the heading margin, not depth zero: leaving y0 out
         of the inverse put the anchor PADT/ppf feet too deep — 1.56 ft at
         1 in = 5 ft — and the depth under the pointer walked on every step. */
      const ftAt = W.geom.top
        + ((e.clientY - W.art.getBoundingClientRect().top) - W.geom.y0) / W.geom.ppf;
      if (!setScale(e.deltaY < 0 ? -1 : 1)) return;
      if (!W.geom) return;
      const yWant = W.geom.y0 + (ftAt - W.geom.top) * W.geom.ppf;
      W.body.scrollTop = Math.max(0,
        W.body.scrollTop + (W.art.getBoundingClientRect().top + yWant) - e.clientY);
    }, { passive: false });

    /* touch: pinch changes the scale, which is what a drawing scale means on a
       tablet. ONE recogniser (js/touch.js) — there is no second pinch here. */
    if (SBMM.touch && SBMM.touch.gestures) {
      let acc = 1;
      SBMM.touch.gestures(W.body, {
        pinchstart() { acc = 1; },
        pinch(g) {
          acc *= g.scale;
          if (acc > 1.6) { acc = 1; setScale(-1); }
          else if (acc < 0.62) { acc = 1; setScale(1); }
        }
      });
    }
  }

  /* returns whether the scale actually moved — the wheel needs to know before
     it re-solves the scroll position */
  function setScale(dir) {
    const i = SCALES.indexOf(scale);
    const j = clamp(i + dir, 0, SCALES.length - 1);
    if (j === i) return false;
    scale = SCALES[j];
    const sc = W && W.el.querySelector(".bwscale");
    if (sc) sc.value = String(scale);
    paint();
    return true;
  }

  /* ---- states (v24 §2 item 6): a control with nothing to do says so ---- */
  function syncButtons() {
    if (!W) return;
    const fence = tab === "fence" ? (SBMM.fence && SBMM.fence.currentFence()) : null;
    const dis = (sel, off, why) => {
      const b = W.el.querySelector(sel);
      if (!b) return;
      b.disabled = !!off;
      b.classList.toggle("off", !!off);
      if (off && why) b.dataset.why = why;
    };
    dis('[data-b="png"]', tab === "table" || (tab === "fence" && !fence),
        tab === "table" ? "the table exports as CSV" : "no fence drawn yet");
    dis('[data-b="csv"]', tab === "fence" && !fence, "no fence drawn yet");
    dis(".fnthru", tab === "fence" && fnPick.length < 2, "tick two holes or more");
    dis('[data-b="print"]', tab === "fence" || tab === "compare", "the printed sheet is one hole");
    dis('[data-b="printall"]', tab === "fence" || tab === "compare", "the printed sheet is one hole");
    dis('[data-b="printarea"]', tab === "fence" || tab === "compare", "the printed sheet is one hole");
    W.el.querySelectorAll(".bwstep").forEach(b => {
      b.disabled = tab === "fence";
      b.classList.toggle("off", tab === "fence");
    });
  }
  function step(d) {
    const list = BL().ids();
    const i = list.indexOf(cur);
    if (i < 0) return;
    cur = list[(i + d + list.length) % list.length];
    if (tab === "table") tab = "log";
    paint();
  }

  /* pull a row into view inside the menu WITHOUT scrollIntoView, which moves
     the page (the rule this app is under) */
  function scrollRow(menu, row) {
    const a = row.offsetTop, b = a + row.offsetHeight;
    if (a < menu.scrollTop) menu.scrollTop = a - 4;
    else if (b > menu.scrollTop + menu.clientHeight) menu.scrollTop = b - menu.clientHeight + 4;
  }

  /* one hole chosen, from the keyboard or the pointer: on Compare it joins or
     leaves the selection, everywhere else it becomes the hole */
  function takeRow(id) {
    if (!id) return;
    if (tab === "compare") {
      const i = cmp.indexOf(id);
      if (i >= 0) { if (cmp.length <= 2) { toast("compare needs two holes"); return; } cmp.splice(i, 1); }
      else if (cmp.length < MAXCMP) cmp.push(id);
      else { toast(`compare takes ${MAXCMP} holes at a time`); return; }
    } else { cur = id; if (tab === "table") tab = "log"; }
    paint();
  }

  /* ---- the navigator (v26 §8): every hole, grouped by waste area -------
     It used to be a typeahead that showed the list only while its box had
     focus. The list is the first step of every log task — which hole, which
     neighbours to compare, which to put on a fence — so it is ALWAYS there:
     44 rows, each with a class bar drawn to depth (waste / native / bedrock by
     the logger's own contact), the total depth, and an amber dot where the two
     contact statements differ. The search box and the four filter chips narrow
     it; ↑ ↓ Enter walk it from the box. On Compare a row ticks the hole in or
     out of the comparison rather than opening it. On a narrow window the
     navigator folds and the list drops down from the box, as the picker did. */
  let navQ = "", navF = "";
  function navHoles() {
    const q = navQ.trim().toLowerCase();
    const hit = h => {
      if (navF === "differ" && !((h.contacts || {}).flags || []).length) return false;
      if (navF === "water" && !(h.water && h.water.encountered)) return false;
      if (navF === "refusal" && !(h.spt || []).some(s => s.refusal)) return false;
      if (!q) return true;
      const id = h.id.toLowerCase();
      if (id.includes(q) || id.replace(/^sb-/, "") === q.replace(/^sb-?/, "")) return true;
      if ((BL().areaOf(h.id) || "").toLowerCase().includes(q)) return true;
      return (h.strata || []).some(s => String(s.uscs || "").toLowerCase() === q);
    };
    const out = [];
    for (const [area, ids] of BL().areas()) {
      const list = ids.map(id => BL().byId(id)).filter(h => h && hit(h))
        .sort((x, y) => (+x.id.replace(/\D/g, "")) - (+y.id.replace(/\D/g, "")));
      if (list.length) out.push([area, list]);
    }
    return out.sort((a, b) => b[1].length - a[1].length);
  }
  function classBar(h) {
    const d = h.depth || 1;
    return `<span class="bwbar">` + (h.profile || []).map(p =>
      `<i style="flex:${Math.max(0.01, (p.base - p.top) / d).toFixed(3)};background:${BL().classColor(p.cls)}"></i>`).join("")
      + `</span>`;
  }
  function paintNav() {
    if (!W) return;
    const menu = W.el.querySelector(".bwmenu");
    if (!menu) return;
    const groups = navHoles();
    const selId = (menu.querySelector(".bwopt.sel") || {}).dataset ? (menu.querySelector(".bwopt.sel") || {}).dataset.id : null;
    const out = [];
    for (const [area, list] of groups) {
      out.push(`<div class="bwgrp"><span>${esc(area)}</span><span class="mono">${list.length}</span></div>`);
      for (const h of list) {
        const on = tab === "compare" ? cmp.includes(h.id) : h.id === cur;
        const flag = ((h.contacts || {}).flags || []).length;
        out.push(`<div class="bwopt${on ? " on" : ""}${h.id === selId ? " sel" : ""}" data-id="${esc(h.id)}" role="option"`
          + ` aria-selected="${on}" title="${esc(h.id + " — " + fmt(h.depth, 1) + " ft" + (flag ? " · the two contact statements differ" : ""))}">`
          + (tab === "compare" ? `<span class="bwtick">${on ? "✓" : ""}</span>` : "")
          + `<b class="mono">${esc(h.id)}${flag ? '<i class="bwdot"></i>' : ""}</b>`
          + classBar(h)
          + `<span class="mut">${fmt0(h.depth)}′</span></div>`);
      }
    }
    menu.innerHTML = out.join("") || `<div class="bwgrp">no match</div>`;
    W.el.querySelectorAll(".bwfc").forEach(b => b.classList.toggle("on", b.dataset.f === navF));
    /* keep the open hole in view without moving the page (scrollIntoPane) */
    const onRow = menu.querySelector(".bwopt.on");
    if (onRow && navDocked() && !menu.dataset.kept) { menu.dataset.kept = "1"; scrollRow(menu, onRow); }
  }
  /* the navigator is docked when the window is wide enough to give it a column */
  const navDocked = () => !!(W && W.el.classList.contains("bwnavon"));

  function wirePicker() {
    const inp = W.el.querySelector(".bwpick"), menu = W.el.querySelector(".bwmenu");
    const shut = () => { if (!navDocked()) menu.hidden = true; };
    const show = () => { navQ = inp.value; paintNav(); menu.hidden = false; };
    inp.addEventListener("focus", show);
    inp.addEventListener("input", show);
    /* up / down walk the list, Enter takes the highlighted row — a typeahead
       whose only key is Enter is a text box with a menu behind it */
    const move = d => {
      if (menu.hidden) { show(); return; }
      const rows = [...menu.querySelectorAll(".bwopt")];
      if (!rows.length) return;
      let i = rows.findIndex(r => r.classList.contains("sel"));
      if (i < 0) i = rows.findIndex(r => r.classList.contains("on"));
      i = clamp(i + d, 0, rows.length - 1);
      rows.forEach(r => r.classList.remove("sel"));
      rows[i].classList.add("sel");
      scrollRow(menu, rows[i]);
    };
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { move(1); e.stopPropagation(); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { move(-1); e.stopPropagation(); e.preventDefault(); return; }
      if (e.key === "Enter") {
        const row = menu.querySelector(".bwopt.sel") || menu.querySelector(".bwopt");
        if (row) takeRow(row.dataset.id);
        inp.value = ""; navQ = ""; shut(); paintNav();
        e.stopPropagation(); e.preventDefault();
        return;
      }
      if (e.key === "Escape") { if (inp.value) { inp.value = ""; navQ = ""; paintNav(); } else { shut(); inp.blur(); }
                                e.stopPropagation(); e.preventDefault(); }
    });
    menu.addEventListener("mousedown", e => {
      const r = e.target.closest(".bwopt");
      if (!r) return;
      e.preventDefault();
      takeRow(r.dataset.id);
      if (!navDocked()) { inp.value = ""; navQ = ""; shut(); }
    });
    inp.addEventListener("blur", () => setTimeout(shut, 120));
    W.el.querySelector(".bwflt").addEventListener("click", e => {
      const b = e.target.closest(".bwfc");
      if (!b) return;
      navF = b.dataset.f || "";
      paintNav();
    });
    /* the id chip in the title bar is the other way in */
    const chip = W.el.querySelector(".bwid");
    if (chip) chip.onclick = () => { inp.focus(); inp.select(); show(); };
  }

  /* ---- the insight rail (v26 §8): the hole in one glance -------------- */
  const HEXC = cls => BL().classColor(cls);
  function story(h) {
    /* ONE SENTENCE PER HOLE, generated from the record, not from a model:
       the three class intervals, the water and the refusal, in the order a
       geologist would say them */
    const P = h.profile || [];
    const bits = [];
    const words = { waste: "mine waste", native: "native soil", bedrock: "bedrock" };
    const first = P[0];
    if (first) {
      const nc = (h.contacts || {}).native_contact;
      if (first.cls === "waste" && nc != null) bits.push(`${fmt(nc, 1)} ft of mine waste`);
      else bits.push(`${words[first.cls] || "unclassed ground"} at the surface`);
    }
    const bed = (h.contacts || {}).bedrock_top;
    const nat = P.find(p => p.cls === "native");
    if (nat && first && first.cls !== "native") {
      const s = (h.strata || []).find(q => q.primary && q.cls === "native" && q.uscs);
      bits.push(`over native ${s ? (s.name || s.uscs).replace(/\s*\(.*$/, "").toLowerCase() : "soil"}`);
    }
    if (bed != null) bits.push(`bedrock at ${fmt(bed, 1)} ft`);
    const w = h.water;
    if (w && w.encountered && w.depth != null) bits.push(`${w.perched ? "perched " : ""}water at ${fmt(w.depth, 1)} ft`);
    const ref = (h.spt || []).filter(s => s.refusal);
    if (ref.length) bits.push(`refusal at ${fmt(ref[0].top, 1)} ft`);
    bits.push(`bottom of hole ${fmt(h.depth, 1)} ft`);
    const s = bits.join("; ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }
  function paintRail(h) {
    if (!W || !W.rail) return;
    if (tab !== "log" || !h) { W.rail.innerHTML = ""; return; }
    const c = h.contacts || {};
    const bar = (h.profile || []).map(p =>
      `<i style="flex:${Math.max(.01, p.base - p.top)};background:${HEXC(p.cls)}"></i>`).join("");
    const rows = (h.profile || []).map(p =>
      `<div class="bwsr"><b style="color:${HEXC(p.cls)}">${esc(BL().classWord(p.cls).replace(/^./, m => m.toUpperCase()))}</b>`
      + `<span class="mono">${fmt(p.top, 1)} – ${fmt(p.base, 1)} ft</span><em class="mono">${fmt(p.base - p.top, 1)} ft</em></div>`).join("");
    const agree = !(c.flags && c.flags.length);
    const nRef = (h.spt || []).filter(s => s.refusal).length;
    const R = [];
    R.push(`<div class="bwcard bwstory"><h3><span>What this hole found</span><span class="mono">${fmt(h.depth, 1)} ft</span></h3>`
      + `<p class="bwsent">${esc(story(h))}</p>`
      + `<div class="bwstrow"><div class="bwsbar">${bar}</div><div>${rows}</div></div>`
      + `<div class="bwleg"><span><i style="background:#2A7DC4"></i>water ${h.water && h.water.encountered && h.water.depth != null ? fmt(h.water.depth, 1) + " ft" : "none"}</span>`
      + `<span><i style="background:var(--bad)"></i>${nRef} refusal${nRef === 1 ? "" : "s"}</span></div></div>`);
    R.push(`<div class="bwcard"><h3><span>Contact statements</span></h3><div class="bwagree${agree ? "" : " bad"}"`
      + ` data-agree="${agree ? "1" : "0"}"><i>${agree ? "✓" : "!"}</i><div>`
      + (agree
        ? `The logger's remark and the strata agree at <b class="mono">${fmt(c.native_contact, 1)} ft</b>.`
        : `Remark <b class="mono">${c.native_contact == null ? "—" : fmt(c.native_contact, 1) + " ft"}</b> · strata `
          + `<b class="mono">${c.waste_base_strata == null ? "—" : fmt(c.waste_base_strata, 1) + " ft"}</b> · not reconciled`)
      + `</div></div></div>`);
    R.push(`<div class="bwcard bwcurcard"><h3><span>Depth cursor</span><span class="mono">${esc(h.id)}</span></h3>`
      + `<div class="bwcurbody"><span class="mut">point at the log</span></div></div>`);
    R.push(`<div class="bwcard"><h3><span>Profiles</span><span>ft bgs</span></h3>${profilesSvg(h)}`
      + `<div class="bwleg"><span><i style="background:#5CC0DB"></i>SPT N</span><span><i style="background:#E5584C"></i>pH &lt; 4</span>`
      + `<span><i style="background:#8FA3B0"></i>WC · PL–LL</span></div></div>`);
    R.push(`<div class="bwcard"><h3><span>Location</span><span>${esc(BL().areaOf(h.id) || "")}</span></h3>${locatorSvg(h)}</div>`);
    W.rail.innerHTML = R.join("");
  }
  function railCursor(h, ft) {
    if (!W || !W.rail) return;
    const box = W.rail.querySelector(".bwcurbody");
    if (!box) return;
    if (ft == null || !h) { box.innerHTML = `<span class="mut">—</span>`; return; }
    const s = (h.strata || []).filter(q => q.primary && q.top <= ft && q.base > ft).pop();
    const p = (h.profile || []).find(q => q.top <= ft && q.base > ft);
    const sp = (h.spt || []).find(q => q.top <= ft + .01 && q.base >= ft - .01);
    const lab = (h.tests || []).filter(t => t.depth != null && Math.abs(t.depth - ft) < .6)
      .map(t => `${t.key} ${t.key === "pH" ? fmt(t.value, 1) : fmt0(t.value)}${t.unit === "%" ? "%" : ""}`);
    const kind = sp ? ({ ST: "Shelby tube", MC: "Mod. California", SS: "split spoon" }[String(sp.ref || "").slice(0, 2)] || "drive") : "";
    box.innerHTML = `<div><span class="bwbig mono">${fmt(ft, 1)}</span> ft bgs`
      + (h.elev != null ? ` · <span class="mono">${fmt(h.elev - ft, 1)}</span> ft` : "") + `</div>`
      + `<div class="bwgrid">`
      + `<span>Class</span><b style="color:${p ? HEXC(p.cls) : "inherit"}">${p ? esc(BL().classWord(p.cls)) : "—"}</b>`
      + `<span>Stratum</span><b>${s ? esc((s.uscs ? s.uscs + " · " : "") + (s.name || String(s.desc || "").split(",")[0])) : "—"}</b>`
      + `<span>Sample</span><b class="mono">${sp ? esc(sp.ref + " · " + (sp.n_text ? "N " + sp.n_text : kind) + (sp.rec_pct != null ? " · " + fmt0(sp.rec_pct) + "% rec" : "")) : "—"}</b>`
      + `<span>Lab</span><b class="mono">${lab.length ? esc(lab.join(" · ")) : "—"}</b></div>`;
  }
  function profilesSvg(h) {
    const Wd = 300, Hh = 236, top = 22, bot = Hh - 14, dmax = Math.ceil((h.depth || 1) / 10) * 10;
    const yy = d => top + d / dmax * (bot - top);
    const P = [];
    const panel = (x0, title, ticks, fx) => {
      P.push(`<text x="${x0}" y="10" font-size="10" font-weight="600" fill="#C6D3DA">${title}</text>`);
      ticks.forEach((t, i) => {
        P.push(`<line x1="${fx(t).toFixed(1)}" x2="${fx(t).toFixed(1)}" y1="${top}" y2="${bot}" stroke="#26343C"/>`);
        P.push(`<text x="${fx(t).toFixed(1)}" y="${bot + 11}" font-size="8" fill="#6F838E" text-anchor="${i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}">${t}</text>`);
      });
    };
    for (let d = 0; d <= dmax; d += dmax > 60 ? 20 : 10) P.push(`<text x="0" y="${(yy(d) + 3).toFixed(1)}" font-size="8" fill="#6F838E">${d}</text>`);
    for (const p of (h.profile || [])) P.push(`<rect x="17" y="${yy(p.top).toFixed(1)}" width="4" height="${Math.max(.5, yy(p.base) - yy(p.top)).toFixed(1)}" fill="${HEXC(p.cls)}"/>`);
    const nx = v => 27 + Math.min(v, 50) / 50 * 74;
    panel(27, "SPT N", [0, 25, 50], nx);
    const pts = (h.spt || []).filter(s => s.n != null || s.refusal)
      .map(s => [s.refusal ? nx(50) : nx(s.n || 0), yy((s.top + s.base) / 2), s.refusal]);
    if (pts.length > 1) P.push(`<polyline points="${pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ")}" fill="none" stroke="#5CC0DB" stroke-width="1.4" stroke-linejoin="round"/>`);
    for (const p of pts) P.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.4" fill="${p[2] ? "#E5584C" : "#8BD8EA"}"/>`);
    const px = v => 121 + (Math.max(2, Math.min(8, v)) - 2) / 6 * 70;
    panel(121, "pH", [2, 4, 6, 8], px);
    P.push(`<rect x="${px(2)}" y="${top}" width="${(px(4) - px(2)).toFixed(1)}" height="${bot - top}" fill="#E5584C" opacity=".12"/>`);
    for (const t of (h.tests || []).filter(t => t.key === "pH" && t.depth != null))
      P.push(`<circle cx="${px(t.value).toFixed(1)}" cy="${yy(t.depth).toFixed(1)}" r="2.6" fill="${t.value < 4 ? "#E5584C" : "#C6D3DA"}"><title>pH ${fmt(t.value, 1)} @ ${fmt(t.depth, 1)} ft</title></circle>`);
    const wx = v => 212 + Math.min(v, 60) / 60 * 84;
    panel(212, "WC · PL–LL", [0, 30, 60], wx);
    const byD = {};
    for (const t of (h.tests || [])) if (t.depth != null) (byD[t.depth] = byD[t.depth] || {})[t.key] = t.value;
    for (const d in byD) {
      const o = byD[d], yv = yy(+d);
      if (o.LL != null && o.PI != null) P.push(`<line x1="${wx(o.LL - o.PI).toFixed(1)}" x2="${wx(o.LL).toFixed(1)}" y1="${yv.toFixed(1)}" y2="${yv.toFixed(1)}" stroke="#8FA3B0" stroke-width="3" stroke-linecap="round" opacity=".6"/>`);
      if (o.WC != null) P.push(`<circle cx="${wx(o.WC).toFixed(1)}" cy="${yv.toFixed(1)}" r="2.6" fill="#EAF1F4"><title>WC ${fmt0(o.WC)}% @ ${fmt(+d, 1)} ft</title></circle>`);
    }
    if (h.water && h.water.encountered && h.water.depth != null)
      P.push(`<line x1="17" x2="${Wd}" y1="${yy(h.water.depth).toFixed(1)}" y2="${yy(h.water.depth).toFixed(1)}" stroke="#2A7DC4" stroke-dasharray="3 3"/>`);
    return `<svg class="bwprof" viewBox="0 0 ${Wd} ${Hh}" width="100%" style="display:block;font-family:var(--sans)">${P.join("")}</svg>`;
  }
  function locatorSvg(me) {
    const HS = BL().holes();
    const xs = HS.map(h => h.x), ys = HS.map(h => h.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const Wd = 300, Hh = 170, pad = 16, s = Math.min((Wd - 2 * pad) / Math.max(1, x1 - x0), (Hh - 2 * pad) / Math.max(1, y1 - y0));
    const ox = ((Wd - 2 * pad) - (x1 - x0) * s) / 2, oy = ((Hh - 2 * pad) - (y1 - y0) * s) / 2;
    const px = x => pad + ox + (x - x0) * s, py = y => Hh - pad - oy - (y - y0) * s;
    const P = [`<rect width="${Wd}" height="${Hh}" rx="8" fill="#0F171C"/>`];
    for (const h of HS) {
      if (h === me) continue;
      const c = HEXC(((h.profile || [])[0] || {}).cls || "unknown");
      P.push(`<circle class="bwloc" data-id="${esc(h.id)}" cx="${px(h.x).toFixed(1)}" cy="${py(h.y).toFixed(1)}" r="3.4" fill="${c}" opacity=".8" style="cursor:pointer"><title>${esc(h.id)}</title></circle>`);
    }
    P.push(`<circle cx="${px(me.x).toFixed(1)}" cy="${py(me.y).toFixed(1)}" r="6.5" fill="#5CC0DB" stroke="#fff" stroke-width="1.5"/>`);
    const lx = px(me.x) + 10 > Wd - 44 ? px(me.x) - 10 : px(me.x) + 10;
    P.push(`<text x="${lx.toFixed(1)}" y="${(py(me.y) + 4).toFixed(1)}" font-size="11" font-weight="700" fill="#EAF1F4" text-anchor="${lx < px(me.x) ? "end" : "start"}">${esc(me.id)}</text>`);
    P.push(`<text x="${Wd - 10}" y="${Hh - 8}" font-size="9" fill="#6F838E" text-anchor="end">dot colour = class at the surface</text>`);
    return `<svg class="bwlocsvg" viewBox="0 0 ${Wd} ${Hh}" width="100%" style="display:block;font-family:var(--sans)">${P.join("")}</svg>`;
  }

  /* ------------------------------------------------------------------ */
  /* paint                                                               */
  /* ------------------------------------------------------------------ */
  function paint() {
    if (!W) return;
    const h = BL().byId(cur);
    /* the id chip names the HOLE, and the Fence tab is not about one hole —
       it is hidden there and the title carries the fence's own name instead */
    const fnCur = tab === "fence" && SBMM.fence ? SBMM.fence.currentFence() : null;
    W.el.querySelector(".bwid").textContent = cur || "—";
    W.el.querySelector(".shtitle").textContent =
      tab === "log" ? "Boring log" : tab === "compare" ? "Compare"
        : tab === "fence" ? (fnCur && fnCur.name ? fnCur.name : "Fence") : "All borings";
    W.el.querySelectorAll(".bwtab").forEach(b => {
      b.classList.toggle("active", b.dataset.t === tab);
      b.setAttribute("aria-selected", b.dataset.t === tab ? "true" : "false");
    });
    W.el.classList.toggle("bwtab-table", tab === "table");
    W.el.classList.toggle("bwtab-fence", tab === "fence");
    W.el.classList.toggle("bwtab-log", tab === "log");
    W.el.classList.toggle("bwtab-compare", tab === "compare");
    const ar = W.el.querySelector(".bwarea0");
    if (ar) ar.textContent = tab === "log" && h ? (BL().areaOf(h.id) || "not in a waste area")
      : tab === "compare" ? "Compare" : tab === "fence" ? "Fence" : "All holes";
    layoutCols();
    W.cursor.hidden = true;
    paintNav();
    if (tab === "log") { paintHead(h); paintLog(h); paintStrip(h); paintRail(h); }
    else {
      W.facts.innerHTML = ""; W.currow.innerHTML = ""; W.more.innerHTML = ""; W.more.hidden = true;
      W.strip.hidden = true; W.strip.innerHTML = "";
      paintRail(null);
      if (tab === "compare") paintCompare();
      else if (tab === "fence") paintFence();
      else paintTable();
    }
    syncButtons();
  }

  /* v26: which of the three columns the window has room for. The navigator
     needs ~900 px of window to leave the log a real width, the rail ~1,180;
     below those they fold, and the navigator's list drops down from its search
     box the way the picker always did. */
  function layoutCols() {
    if (!W) return;
    const w = W.el.clientWidth;
    const navOn = w >= 900 && (tab === "log" || tab === "compare");
    const railOn = w >= 1180 && tab === "log";
    W.el.classList.toggle("bwnavon", navOn);
    W.el.classList.toggle("bwrailon", railOn);
    const menu = W.el.querySelector(".bwmenu");
    if (menu && navOn) menu.hidden = false;
    else if (menu && document.activeElement !== W.el.querySelector(".bwpick")) menu.hidden = true;
  }

  /* THE HEADER STRIP (v24 §2.2 item 2). Six labelled facts and nothing else:
     the hole, its waste area, the ground elevation with the lidar difference,
     the native contact, the bedrock top and the groundwater — the six a reader
     checks before reading a single stratum. The other nine a log sheet's
     header carries (coordinates, dates, driller, logger, method) are one click
     away behind `details`, because they are looked up rather than read, and
     the printed sheet prints all fifteen on every page.

     The strip does not scroll: it is a flex sibling of the scrolling body, and
     under it sits the fixed column-heading band (SBMM.borelogs.headingBand),
     so the reader 80 ft down a log still knows which column is which. */
  function paintHead(h) {
    if (!h) { W.facts.innerHTML = ""; W.currow.innerHTML = ""; W.more.innerHTML = "";
              W.more.hidden = true; return; }
    const d = BL().deltaLidar(h);
    const c = h.contacts || {}, w = h.water;
    const m0 = (h.methods || [])[0] || {};
    const area = BL().areaOf(h.id);
    const cell = (k, v, cls) => `<div class="bwf${cls ? " " + cls : ""}"><span>${esc(k)}</span><b>${v}</b></div>`;
    W.facts.innerHTML = `<div class="bwhid"><b class="mono">${esc(h.id)}</b>`
      + `<span class="mut">${esc(area || "waste area not assigned")}</span>`
      + `<small>SBMM OU1 · 2025 geotechnical investigation</small></div>`
      + cell("Ground", `${fmt(h.elev, 1)} ft`
          + (d ? ` <span class="${d.warn ? "warnpill" : "mut"}" title="Lidar (Jan 2024) reads `
              + `${fmt(d.lidar, 1)} ft here">Δ lidar ${d.d > 0 ? "+" : ""}${fmt(d.d, 1)}</span>` : ""))
      + cell("Native contact", c.native_contact == null ? "not stated"
          : `${fmt(c.native_contact, 1)} ft`
            + (h.elev != null ? ` <span class="mut">${fmt(h.elev - c.native_contact, 1)}</span>` : ""))
      + cell("Bedrock", c.bedrock_top == null ? "not reached" : `${fmt(c.bedrock_top, 1)} ft`)
      + cell("Groundwater", w && w.encountered && w.depth != null
          ? `${fmt(w.depth, 1)} ft${w.perched ? " · perched" : ""}` : "not encountered")
      + ((c.flags || []).length
          ? `<div class="bwflags warnpill" title="${esc(c.flags.join('; '))}">${esc(c.flags.join(" · "))}</div>`
          : "");
    W.currow.innerHTML = `<div class="bwf bwread" data-ft=""><span>Depth cursor</span><b>—</b></div>`
      + `<button class="minib bwmoreb" aria-expanded="false"`
      + ` title="The rest of the log header: coordinates, dates, driller and method">more</button>`;
    W.more.innerHTML = cell("Total depth", `${fmt(h.depth, 1)} ft`)
      + cell("Base", h.elev != null ? `${fmt(h.elev - h.depth, 1)} ft` : "—")
      + cell("Waste base — strata", c.waste_base_strata == null ? "—"
          : `${fmt(c.waste_base_strata, 1)} ft`)
      + cell("Contact source", c.source === "remark" ? "logger's remark"
          : c.source ? esc(c.source) : "—")
      + cell("E / N", `${fmt0(h.x)}, ${fmt0(h.y)}`)
      + cell("Lat / long", h.lat != null ? `${h.lat.toFixed(6)}, ${h.lon.toFixed(6)}` : "—")
      + cell("Drilled", `${h.date_start || "—"}`
          + (h.date_end && h.date_end !== h.date_start ? `–${h.date_end}` : ""))
      + cell("Method", esc(h.method_words || "—"))
      + cell("Logged / checked", `${esc(h.logger || "—")}${h.checked_by ? " · " + esc(h.checked_by) : ""}`)
      + cell("Driller", esc([m0.driller, m0.contractor].filter(Boolean).join(" · ") || "—"));
    const mb = W.currow.querySelector(".bwmoreb");
    W.more.hidden = W.more.hidden !== false;      /* the panel keeps its state */
    if (mb) {
      mb.setAttribute("aria-expanded", String(!W.more.hidden));
      mb.classList.toggle("on", !W.more.hidden);
      mb.onclick = () => {
        W.more.hidden = !W.more.hidden;
        mb.setAttribute("aria-expanded", String(!W.more.hidden));
        mb.classList.toggle("on", !W.more.hidden);
      };
    }
  }

  /* the fixed column-heading band under the facts — the same list column()
     prints on paper, drawn once and never scrolled */
  function paintStrip(h) {
    if (!W) return;
    if (tab !== "log" || !h) { W.strip.hidden = true; W.strip.innerHTML = ""; return; }
    const b = BL().headingBand(artWidth(), { datum, print: true });
    W.strip.innerHTML = b.svg;
    W.strip.hidden = false;
  }

  function artWidth() {
    return Math.max(560, W.body.clientWidth - 18);
  }

  /* ONE builder for the Log tab's drawing, so the overlap harness can render
     the same SVG off-screen at any width without opening a window
     (test/borewin_overlap.mjs, and block 9ah of the e2e, which sweeps 44 holes
     at three widths — repainting a real window 132 times costs minutes). */
  function logSvg(id, w, o) {
    const h = typeof id === "string" ? BL().byId(id) : id;
    if (!h) return null;
    const oo = o || {};
    /* the headings are drawn ONCE, in the window's fixed strip, and the
       drawing keeps their margin so nothing is jammed against its own top;
       the printed sheet passes headings:true because every page repeats them */
    /* v26: on PAPER — the print palette, black ink on white, on screen as in
       the printed appendix. A log is read on paper; the dark panel around it
       is the desk it lies on. */
    const r = BL().column(h, { tier: "sheet", ppf: oo.ppf || ppf(), w: Math.max(360, w || 900),
      datum: oo.datum || datum, headings: !!oo.headings, padTop: 30, print: oo.print != null ? !!oo.print : true,
      zTop: h.elev, zBot: h.elev != null ? h.elev - h.depth : null });
    return { svg: `<svg class="bwsvg" viewBox="0 0 ${r.w} ${r.h}" width="${r.w}" height="${r.h}"`
      + ` xmlns="http://www.w3.org/2000/svg">`
      + `<style>text{font-family:"SBMM Mono","SF Mono",ui-monospace,Consolas,Menlo,monospace}</style>`
      + r.defs + r.g + `</svg>`, w: r.w, h: r.h, ppf: r.ppf, top: r.top, y0: r.yOf(r.top) };
  }

  function paintLog(h) {
    if (!h) { W.art.innerHTML = ""; return; }
    const d = logSvg(h, artWidth());
    if (!d) { W.art.innerHTML = ""; return; }
    W.art.innerHTML = d.svg;
    W.geom = { ppf: d.ppf, top: d.top, y0: d.y0, h: d.h };
    W.el.querySelector(".bwfoot").textContent =
      `1" = ${scale}' · ${(h.strata || []).filter(s => s.primary).length} units · `
      + `${(h.spt || []).length} drives · ${(h.tests || []).length} lab values`;
  }

  /* ---- compare (§2.4) ---------------------------------------------- */
  function nearest(id, n) {
    const h = BL().byId(id);
    if (!h) return [];
    return BL().holes().slice()
      .sort((a, b) => Math.hypot(a.x - h.x, a.y - h.y) - Math.hypot(b.x - h.x, b.y - h.y))
      .slice(0, n).map(q => q.id);
  }

  function chipsHtml() {
    return `<div class="bwcmpsel">`
      + `<button class="minib bwcmpclr" title="Take every hole off the comparison">clear</button>`
      + `<button class="minib bwcmpnear" title="The four holes nearest ${esc(cur || "")}">nearest four</button>`
      + BL().holes().map(h => `<label class="bwchip${cmp.includes(h.id) ? " on" : ""}">`
        + `<input type="checkbox" data-id="${esc(h.id)}"${cmp.includes(h.id) ? " checked" : ""}>`
        + `${esc(h.id)}</label>`).join("") + `</div>`;
  }
  function wireChips() {
    const clr = W.art.querySelector(".bwcmpclr");
    if (clr) clr.onclick = () => { cmp = []; cmpCleared = true; paint(); };
    const nr = W.art.querySelector(".bwcmpnear");
    if (nr) nr.onclick = () => { cmp = nearest(cur, Math.min(4, BL().holes().length));
                                 cmpCleared = false; paint(); };
    W.art.querySelectorAll(".bwcmpsel input").forEach(cb => cb.onchange = () => {
      const id = cb.dataset.id, i = cmp.indexOf(id);
      if (cb.checked) {
        if (cmp.length >= MAXCMP) { cb.checked = false; toast(`compare takes ${MAXCMP} holes at a time`); return; }
        cmp.push(id); cmpCleared = false;
      } else if (i >= 0) cmp.splice(i, 1);
      paint();
    });
  }

  function paintCompare() {
    let list = cmp.map(id => BL().byId(id)).filter(Boolean);
    if (list.length < 2 && !cmpCleared) {
      /* seed from the nearest holes rather than recursing: a payload with one
         hole in it would otherwise recurse for ever */
      cmp = nearest(cur, Math.min(4, BL().holes().length));
      cmp = cmp.filter((id, i) => cmp.indexOf(id) === i);
      list = cmp.map(id => BL().byId(id)).filter(Boolean);
    }
    if (list.length < 2) {
      /* THE EMPTY STATE (v24 §2 item 6). A blank panel reads as a broken tab;
         this one names what is missing and carries the two ways out. */
      W.art.innerHTML = `<div class="bwempty"><b>${list.length ? "One hole chosen"
        : "No holes chosen"}</b><span class="mut">Compare stands two to six logs on one`
        + ` elevation datum.</span></div>` + chipsHtml();
      wireChips();
      W.el.querySelector(".bwfoot").textContent = `${list.length} of 2 holes`;
      return;
    }
    /* ONE elevation datum for every column — the tallest ground at the top.
       That is the whole point: two logs read side by side at their own zeros
       say nothing about which horizon is which. */
    const zTop = Math.max(...list.map(h => (h.elev == null ? 0 : h.elev))) + 2;
    const zBot = Math.min(...list.map(h => (h.elev == null ? -100 : h.elev - h.depth))) - 2;
    const CW = 92, GAP = 74, PADL = 46, PADT = 34;
    /* compare FITS by default: the point of it is the whole set of columns on
       one datum, and a scale that puts three of the four below the fold is not
       a comparison. The sheet's own scale is the ceiling, never the floor. */
    const room = Math.max(220, (W ? W.body.clientHeight : 600) - PADT - 76);
    const P = Math.min(ppf() / 2.2, room / Math.max(1, zTop - zBot));
    const H = Math.ceil(PADT + (zTop - zBot) * P + 56);
    const Wt = PADL + list.length * CW + (list.length - 1) * GAP + 60;
    const yOfZ = z => PADT + (zTop - z) * P;
    const parts = [], defs = [];

    /* the shared elevation axis, once, on the left */
    const stepFt = P >= 6 ? 5 : P >= 2 ? 10 : 25;
    for (let z = Math.ceil(zBot / stepFt) * stepFt; z <= zTop; z += stepFt) {
      const y = yOfZ(z);
      parts.push(`<line x1="${PADL - 6}" y1="${y.toFixed(1)}" x2="${Wt - 8}" y2="${y.toFixed(1)}"`
        + ` stroke="rgba(44,59,69,.45)" stroke-width=".6"/>`);
      parts.push(`<text x="${PADL - 9}" y="${(y + 3).toFixed(1)}" fill="#6C7F8A" font-size="9"`
        + ` text-anchor="end">${fmt0(z)}</text>`);
    }

    const cols = list.map((h, i) => {
      const x = PADL + i * (CW + GAP);
      /* the SHARED zTop is what places the collar: column() maps the window's
         top elevation to padTop, so every column here starts at the same y and
         each hole's own ground falls where the datum says it does. Adding a
         per-hole offset on top of that counted the datum twice, and three of
         the four columns landed off the bottom of the drawing. */
      const r = BL().column(h, { tier: "stick", w: CW, ppf: P, datum: "elev",
        zTop, zBot, padTop: PADT, axes: false });
      defs.push(r.defs);
      return { h, x, r };
    });
    /* the correlation lines, drawn BEFORE the columns so a column sits on top */
    const HZ = [
      { key: "native", label: "native contact", col: BL().classColor("contact"), dash: null,
        get: h => (h.contacts || {}).native_contact },
      { key: "rock", label: "top of bedrock", col: BL().classColor("bedrock"), dash: "6 3",
        get: h => (h.contacts || {}).bedrock_top },
      { key: "water", label: "water level", col: "#55C1FF", dash: "4 2",
        get: h => (h.water && h.water.encountered && h.water.depth != null ? h.water.depth : null) }
    ];
    const links = {};
    for (const hz of HZ) {
      links[hz.key] = 0;
      for (let i = 0; i + 1 < cols.length; i++) {
        const a = cols[i], b = cols[i + 1];
        const za = a.h.elev != null && hz.get(a.h) != null ? a.h.elev - hz.get(a.h) : null;
        const zb = b.h.elev != null && hz.get(b.h) != null ? b.h.elev - hz.get(b.h) : null;
        if (za == null && zb == null) continue;
        /* dashed where a hole did not reach the horizon — the correlation is
           linear between neighbours and does not pretend otherwise */
        const miss = za == null || zb == null;
        const y1 = yOfZ(za == null ? zb : za), y2 = yOfZ(zb == null ? za : zb);
        parts.push(`<line class="bwcorr" data-hz="${hz.key}" x1="${a.x + CW}" y1="${y1.toFixed(1)}"`
          + ` x2="${b.x}" y2="${y2.toFixed(1)}" stroke="${hz.col}" stroke-width="${miss ? 1 : 1.6}"`
          + ` stroke-dasharray="${miss ? "3 4" : (hz.dash || "")}" stroke-opacity="${miss ? ".5" : ".9"}"/>`);
        links[hz.key]++;
      }
    }
    for (const c of cols) {
      /* data-y0 is the y this hole's COLLAR lands at on the shared datum — the
         one number that says whether the columns really stand on one datum,
         and what the harness reads rather than guessing it back out of a
         stratum's own top */
      parts.push(`<g class="bwcolwrap" data-hole="${esc(c.h.id)}" data-y0="${c.r.yOf(0).toFixed(2)}"`
        + ` data-elev="${c.h.elev}" transform="translate(${c.x},0)">${c.r.g}</g>`);
      /* 11 px of id on y 16 and 8.5 px of ground on y 26 is ten pixels for two
         glyph boxes that need eleven — they overlapped by a pixel on every
         compare this app can draw (v24) */
      parts.push(`<text x="${c.x + CW / 2}" y="15" fill="#E8EEF1" font-size="11" text-anchor="middle"`
        + ` font-weight="700">${esc(c.h.id)}</text>`);
      parts.push(`<text x="${c.x + CW / 2}" y="27" fill="#6C7F8A" font-size="8.5" text-anchor="middle">`
        + `${fmt(c.h.elev, 1)} ft · ${fmt(c.h.depth, 1)} ft deep</text>`);
    }
    /* the true horizontal separation between neighbours, printed between them:
       the columns are evenly spaced and the ground is not */
    for (let i = 0; i + 1 < cols.length; i++) {
      const a = cols[i], b = cols[i + 1];
      const dist = Math.hypot(a.h.x - b.h.x, a.h.y - b.h.y);
      const xm = (a.x + CW + b.x) / 2;
      parts.push(`<text class="bwsep" data-ft="${dist.toFixed(1)}" x="${xm}" y="${H - 16}"`
        + ` fill="#8FA3AE" font-size="9" text-anchor="middle">${fmt0(dist)} ft</text>`);
      parts.push(`<line x1="${a.x + CW + 4}" y1="${H - 26}" x2="${b.x - 4}" y2="${H - 26}"`
        + ` stroke="#3A4C58" stroke-width="1"/>`);
    }

    /* the three horizons named once, at the foot, rather than in a caption */
    const keyY = H - 4;
    HZ.forEach((hz, i) => {
      const x = PADL + i * 170;
      parts.push(`<line x1="${x}" y1="${keyY - 3}" x2="${x + 20}" y2="${keyY - 3}"`
        + ` stroke="${hz.col}" stroke-width="1.6" stroke-dasharray="${hz.dash || ""}"/>`);
      parts.push(`<text x="${x + 25}" y="${keyY}" fill="#8FA3AE" font-size="8.5">${hz.label}`
        + `${links[hz.key] ? "" : " — none"}</text>`);
    });
    W.art.innerHTML = `<svg class="bwsvg bwcmp" viewBox="0 0 ${Wt} ${H}" width="${Wt}" height="${H}"`
      + ` xmlns="http://www.w3.org/2000/svg">`
      + `<style>text{font-family:"SF Mono",ui-monospace,Consolas,Menlo,monospace}</style>`
      + `<defs>${defs.join("").replace(/<\/?defs>/g, "")}</defs>`
      + parts.join("") + `</svg>`
      + chipsHtml();
    wireChips();
    W.cmpLinks = links;
    W.el.querySelector(".bwfoot").textContent =
      `${cols.length} holes · datum ${fmt0(zBot)}–${fmt0(zTop)} ft NAVD88 · 1" = ${fmt0(DPI / P)}'`;
  }

  /* ---- the fence (§3, js/fence.js) ---------------------------------- */
  /* The window SHOWS the fence; js/fence.js owns it. Everything here is the
     list of what exists, the two controls and the button that arms the tool —
     the drawing is one call to SBMM.fence.drawSvg(). */
  function paintFence() {
    const FN = SBMM.fence;
    if (!FN) { W.art.innerHTML = `<div class="note">the fence diagram is not in this build</div>`;
               W.el.querySelector(".bwfoot").textContent = "\u2014"; return; }
    const all = FN.list();
    const f = FN.currentFence();
    const pick = `<div class="bwfnbar">`
      + `<button class="minib fnnew" title="Draw a fence alignment on the map (FENCE)">draw a fence</button>`
      + `<button class="minib fnthru" title="A fence through the holes ticked below, in the order`
      + ` they were ticked (FENCE SB-9 SB-10)">through ${fnPick.length || "the ticked"} holes</button>`
      + (all.length ? `<label class="bwlbl">fence <select class="fnpick">`
          + all.map(g => `<option value="${esc(g.id)}"${f && g.id === f.id ? " selected" : ""}>`
              + `${esc(g.name || "Fence")}</option>`).join("") + `</select></label>` : "")
      + (f ? (f.props.through
            ? `<span class="mut">through ${esc(f.props.through.join(" · "))}</span>`
            : `<label class="bwlbl">swath <input type="number" class="fnsw" step="25" min="10"`
              + ` style="width:64px" value="${f.props.swath_ft}"><span class="mut">ft either side</span></label>`)
          + `<label class="bwlbl">vertical <select class="fnve">`
          + FN.VE_CHOICES.map(v => `<option value="${v}"${v === f.props.ve ? " selected" : ""}>${v}\u00d7</option>`).join("")
          + `</select></label>`
          + `<span class="spacer"></span>`
          + `<button class="minib" data-fb="png" title="Save the drawing as a PNG">png</button>`
          + `<button class="minib" data-fb="csv" title="Station, offset, ground and every horizon, per hole">csv</button>`
          + `<button class="minib" data-fb="dxf" title="Section coordinates: X = station ft, Y = elevation ft">dxf</button>`
        : "")
      + `</div>`;
    /* the hole list: ticking two or more and pressing `through N holes` builds
       the alignment hole-to-hole, which is the second way in (v24 §3.1) */
    const chips = `<div class="bwcmpsel bwfnsel">`
      + BL().holes().map(h => `<label class="bwchip${fnPick.includes(h.id) ? " on" : ""}">`
        + `<input type="checkbox" data-id="${esc(h.id)}"${fnPick.includes(h.id) ? " checked" : ""}>`
        + `${esc(h.id)}</label>`).join("") + `</div>`;
    if (!f) {
      W.art.innerHTML = pick + `<div class="bwempty"><b>No fence yet</b>`
        + `<span class="mut">A fence is a section through the subsurface along a line.</span></div>`
        + chips;
      W.el.querySelector(".bwfoot").textContent = "no fence";
    } else {
      /* a fence is drawn at the width it is READ at. On a phone the whole
         stage is 393 px, so a 560-px floor would hand the CSS a drawing to
         scale down — which shrinks the text and keeps the collisions, the
         same lesson the results-card strip log carries. */
      const d = FN.drawSvg(f, { w: Math.max(touchy() ? 330 : 560, W.body.clientWidth - 18) });
      W.art.innerHTML = pick + (d ? d.svg : `<div class="note">this fence has no alignment</div>`) + chips;
      W.el.querySelector(".bwfoot").textContent = d
        ? `${d.holes.length} borings \u00b7 ${fmt(d.total, 1)} ft \u00b7 `
          + `${fmt0(d.zBot)}\u2013${fmt0(d.zTop)} ft NAVD88 \u00b7 ${f.props.ve}\u00d7 vertical \u00b7 `
          + `${d.bands} class bands \u00b7 ${d.units} units correlated`
        : "\u2014";
    }
    const q = c => W.art.querySelector(c);
    if (q(".fnnew")) q(".fnnew").onclick = () => { SBMM.cmd.run("FENCE"); };
    if (q(".fnthru")) {
      const b = q(".fnthru");
      b.disabled = fnPick.length < 2;
      b.classList.toggle("off", fnPick.length < 2);
      b.onclick = () => {
        const made = FN.startThrough(fnPick.slice());
        if (made) { fnPick = []; paintFence(); }
      };
    }
    W.art.querySelectorAll(".bwfnsel input").forEach(cb => cb.onchange = () => {
      const id = cb.dataset.id, i = fnPick.indexOf(id);
      if (cb.checked) { if (i < 0) fnPick.push(id); } else if (i >= 0) fnPick.splice(i, 1);
      paintFence();
    });
    if (q(".fnpick")) q(".fnpick").onchange = e => { FN.setCurrent(e.target.value); paintFence(); };
    if (q(".fnsw")) q(".fnsw").onchange = e => {
      f.props.swath_ft = Math.max(10, parseFloat(e.target.value) || FN.DEFAULTS.swath_ft);
      FN.recompute(f); SBMM.store.autosave(); paintFence();
    };
    if (q(".fnve")) q(".fnve").onchange = e => {
      f.props.ve = parseFloat(e.target.value) || 1;
      FN.recompute(f); SBMM.store.autosave(); paintFence();
    };
    W.art.querySelectorAll("[data-fb]").forEach(b => b.onclick = () => {
      if (b.dataset.fb === "png") FN.exportPng(f);
      if (b.dataset.fb === "csv") FN.exportCsv(f);
      if (b.dataset.fb === "dxf") FN.exportDxf(f);
    });
    /* the cross-highlight: a column under the pointer flags its boring on the
       map, and the map's own tick flags the column (js/fence.js owns both) */
    W.art.querySelectorAll(".fncol").forEach(gEl => {
      gEl.addEventListener("mouseenter", () => FN.flashHole(gEl.dataset.hole));
      gEl.addEventListener("mouseleave", () => FN.flashHole(null));
      gEl.addEventListener("click", () => { cur = gEl.dataset.hole; tab = "log"; paint(); });
    });
  }

  /* ---- the table (§2.5) -------------------------------------------- */
  const TCOLS = [
    ["id", "hole", h => h.id, h => h.id],
    ["area", "waste area", h => BL().areaOf(h.id) || "—", h => BL().areaOf(h.id) || "~"],
    ["elev", "ground", h => fmt(h.elev, 1), h => h.elev],
    ["depth", "total depth", h => fmt(h.depth, 1), h => h.depth],
    ["nc", "native contact", h => fmt(h.contacts.native_contact, 1), h => h.contacts.native_contact],
    ["nce", "contact elev", h => h.elev != null && h.contacts.native_contact != null
        ? fmt(h.elev - h.contacts.native_contact, 1) : "—",
      h => h.elev != null && h.contacts.native_contact != null ? h.elev - h.contacts.native_contact : -1e9],
    ["strata", "waste base (strata)", h => fmt(h.contacts.waste_base_strata, 1), h => h.contacts.waste_base_strata],
    ["rock", "bedrock", h => fmt(h.contacts.bedrock_top, 1), h => h.contacts.bedrock_top],
    ["rocke", "bedrock elev", h => h.elev != null && h.contacts.bedrock_top != null
        ? fmt(h.elev - h.contacts.bedrock_top, 1) : "—",
      h => h.elev != null && h.contacts.bedrock_top != null ? h.elev - h.contacts.bedrock_top : -1e9],
    ["gw", "groundwater", h => (h.water && h.water.encountered && h.water.depth != null)
        ? fmt(h.water.depth, 1) : "—", h => (h.water && h.water.depth != null) ? h.water.depth : -1],
    ["logger", "logged by", h => h.logger || "—", h => h.logger || "~"],
    ["date", "drilled", h => h.date_start || "—", h => h.date_start || ""],
    ["flags", "flags", h => (h.contacts.flags || []).join(" · "), h => (h.contacts.flags || []).length]
  ];
  let tSort = "id", tDir = 1, tArea = "";

  function tableRows() {
    let rows = BL().holes().slice();
    if (tArea) rows = rows.filter(h => (BL().areaOf(h.id) || "not assigned") === tArea);
    const col = TCOLS.find(c => c[0] === tSort) || TCOLS[0];
    return rows.sort((a, b) => {
      const va = col[3](a), vb = col[3](b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * tDir;
      return String(va).localeCompare(String(vb)) * tDir;
    });
  }

  function paintTable() {
    const rows = tableRows();
    const areaList = [...BL().areas().keys()].sort();
    const n = BL().disagreeCount();
    W.art.innerHTML = `<div class="bwtbar">`
      + `<label class="bwlbl">waste area <select class="bwarea">`
      + `<option value="">all · ${BL().holes().length}</option>`
      + areaList.map(a => `<option value="${esc(a)}"${a === tArea ? " selected" : ""}>${esc(a)}</option>`).join("")
      + `</select></label>`
      + `<span class="mut">${rows.length} shown · ${n} of ${BL().holes().length} disagree</span></div>`
      + `<table class="bltbl bwtbl sortable"><thead><tr><th></th>`
      + TCOLS.map(c => `<th data-k="${c[0]}" class="${tSort === c[0] ? "on " + (tDir > 0 ? "asc" : "desc") : ""}">`
        + `${esc(c[1])}</th>`).join("")
      + `</tr></thead><tbody>`
      + rows.map(h => `<tr data-id="${esc(h.id)}" class="${(h.contacts.flags || []).length ? "warn" : ""}">`
        + `<td class="bwminicell">${BL().columnSvg(h, { tier: "mini", ppf: 20 / (h.depth || 1),
             padTop: 1, cssW: 12, cssH: 22 })}</td>`
        + TCOLS.map(c => `<td class="${c[0] === "id" || c[0] === "area" || c[0] === "logger"
            || c[0] === "flags" || c[0] === "date" ? "" : "num"}">${esc(c[2](h))}</td>`).join("")
        + `</tr>`).join("")
      + `</tbody></table>`;
    W.art.querySelector(".bwarea").onchange = e => { tArea = e.target.value; paintTable(); };
    W.art.querySelectorAll("th[data-k]").forEach(th => th.onclick = () => {
      if (tSort === th.dataset.k) tDir = -tDir; else { tSort = th.dataset.k; tDir = 1; }
      paintTable();
    });
    W.art.querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => {
      cur = tr.dataset.id; tab = "log"; paint();
    });
    W.el.querySelector(".bwfoot").textContent = `${rows.length} of ${BL().holes().length} holes`;
  }

  function tableCsv() {
    const q = v => v == null || v === "" ? "" : `"${String(v).replace(/"/g, '""')}"`;
    let out = TCOLS.map(c => c[1]).join(",") + "\n";
    for (const h of tableRows()) out += TCOLS.map(c => q(c[2](h))).join(",") + "\n";
    return out;
  }
  function csvNow() {
    if (tab === "table") return tableCsv();
    if (tab === "fence") {
      const f = SBMM.fence && SBMM.fence.currentFence();
      return f ? SBMM.fence.csvText(f) : "";
    }
    return BL().csvFor(cur);
  }

  /* ------------------------------------------------------------------ */
  /* the depth cursor, the stratum hover and the map flash               */
  /* ------------------------------------------------------------------ */
  function onCursor(e) {
    if (!W || tab !== "log" || !W.geom || W.pin != null) return;
    const r = W.art.getBoundingClientRect();
    showCursor(e.clientY - r.top);
  }

  /* ONE readout, in the header strip, never a floating chip: a label that
     follows the pointer is a label that can land on the drawing it describes,
     which is the whole of what this round is about. A click pins the cursor
     where it is; a second click releases it. */
  function showCursor(y) {
    if (!W || !W.geom) return;
    const h = BL().byId(cur);
    const out = W.el.querySelector(".bwread");
    if (!h || !out) return;
    const ft = W.geom.top + (y - W.geom.y0) / W.geom.ppf;
    if (ft < 0 || ft > h.depth) { W.cursor.hidden = true; return; }
    const s2 = (h.strata || []).find(q => q.primary && ft >= q.top && ft < q.base);
    const drive = (h.spt || []).find(q => ft >= q.top && ft <= q.base)
      || (h.spt || []).slice().sort((a, b) => Math.abs((a.top + a.base) / 2 - ft)
                                             - Math.abs((b.top + b.base) / 2 - ft))[0];
    const near = (h.tests || []).filter(t => t.depth != null)
      .sort((a, b) => Math.abs(a.depth - ft) - Math.abs(b.depth - ft))[0];
    W.cursor.hidden = false;
    W.cursor.style.top = (y + W.art.offsetTop) + "px";
    /* FOUR DECIMALS, NOT TWO. The readout prints fmt(ft, 1) of the real value
       and a harness re-derives that from this attribute — at two decimals a
       depth of 6.2499 is stored as "6.25", which formats to 6.3 while the
       readout says 6.2, and the assertion fails on a rounding boundary rather
       than on anything about the cursor. */
    W.cursor.dataset.ft = ft.toFixed(4);
    W.cursor.dataset.uscs = s2 ? (s2.uscs || "") : "";
    /* v26 §8: the cursor is LINKED — the rail reads it out, and the stratum
       under it lights on the hole's 3D stick (one reusable object, moved) */
    railCursor(h, ft);
    if (s2 && SBMM.viewer3d && SBMM.viewer3d.highlightStratum && W.hiS !== s2) {
      W.hiS = s2; SBMM.viewer3d.highlightStratum(cur, s2.top, s2.base);
    }
    out.dataset.ft = ft.toFixed(4);
    out.querySelector("b").innerHTML =
      `<span class="mono gold">${fmt(ft, 1)} ft</span>`
      + (h.elev != null ? ` <span class="mono">${fmt(h.elev - ft, 1)} ft</span>` : "")
      + (s2 ? ` <span class="mut">${esc(s2.uscs || "no USCS")} ${esc(BL().classWord(s2.cls))}</span>` : "")
      + (drive ? ` <span class="mut">${esc(drive.ref || "drive")} N ${esc(drive.n_text || "—")}</span>` : "")
      + (near ? ` <span class="mut">${esc(near.key)} ${fmt(near.value, near.value % 1 ? 2 : 0)}`
          + ` @ ${fmt(near.depth, 1)}</span>` : "");
  }

  function pinCursor(y) {
    if (!W || tab !== "log") return;
    const lbl = W.el.querySelector(".bwread span");
    if (W.pin != null) { W.pin = null; W.cursor.classList.remove("pinned");
                         if (lbl) lbl.textContent = "Depth cursor"; return; }
    W.pin = y;
    W.cursor.classList.add("pinned");
    if (lbl) lbl.textContent = "Depth cursor · pinned";
    showCursor(y);
  }

  /* hovering a stratum highlights the same interval on the hole's 3D stick */
  function onArtHover(e) {
    if (!W || tab !== "log") return;
    const r = e.target.closest && e.target.closest(".blgl");
    if (!SBMM.viewer3d || !SBMM.viewer3d.highlightStratum) return;
    if (!r) { SBMM.viewer3d.highlightStratum(null); return; }
    SBMM.viewer3d.highlightStratum(cur, +r.dataset.top, +r.dataset.base);
  }
  /* clicking one flashes the boring on the map */
  function onArtClick(e) {
    if (!W) return;
    const r = e.target.closest && e.target.closest(".blgl");
    if (!r) return;
    const h = BL().byId(cur);
    if (!h || !SBMM.map) return;
    SBMM.map.setView([h.y, h.x], Math.max(SBMM.map.getZoom(), 4));
    const mk = L.circleMarker([h.y, h.x], { pane: "drawings", radius: 12, color: "#FFD34D",
      weight: 3, fill: false, interactive: false }).addTo(SBMM.map);
    let k = 0;
    const t = setInterval(() => {
      k++; mk.setStyle({ radius: k % 2 ? 7 : 13, opacity: k % 2 ? .5 : 1 });
      if (k >= 6) { clearInterval(t); SBMM.map.removeLayer(mk); }
    }, 220);
  }

  /* show the hole: fly the map (and 3D, when it is open) to it and ring it */
  function showOnMap() {
    const h = BL().byId(cur);
    if (!h) return;
    if (SBMM.omni && SBMM.omni.flyPoint) SBMM.omni.flyPoint(h.x, h.y);
    else if (SBMM.map) SBMM.map.setView([h.y, h.x], Math.max(SBMM.map.getZoom(), 3));
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen() && SBMM.viewer3d.flyTo) SBMM.viewer3d.flyTo(h.x, h.y);
    if (W && W.maxed) maximise(false);
  }

  /* ------------------------------------------------------------------ */
  /* PNG                                                                 */
  /* ------------------------------------------------------------------ */
  function exportPng() {
    /* .bwsvg is the DRAWING; the Table tab's rows carry mini columns of their
       own and querySelector("svg") would hand back the first of those */
    if (tab === "fence") {
      const f = SBMM.fence && SBMM.fence.currentFence();
      if (!f) { toast("no fence drawn yet"); return; }
      SBMM.fence.exportPng(f); return;
    }
    const svg = W && tab !== "table" ? W.art.querySelector("svg.bwsvg") : null;
    if (!svg) { toast(tab === "table" ? "the table exports as csv, not as a picture"
                                      : "nothing to export on this tab"); return; }
    const s = new XMLSerializer().serializeToString(svg);
    const vb = (svg.getAttribute("viewBox") || "0 0 600 800").split(/\s+/).map(Number);
    const w = vb[2] || 600, hh = vb[3] || 800, k = 2;
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = Math.round(w * k); cv.height = Math.round(hh * k) + 40;
        const g = cv.getContext("2d");
        g.fillStyle = "#161E23"; g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = "#E8EEF1"; g.font = "600 22px system-ui,sans-serif";
        g.fillText(tab === "compare" ? "Borings — " + cmp.join(", ") : "Boring log — " + cur, 12, 28);
        g.drawImage(img, 0, 38, Math.round(w * k), Math.round(hh * k));
        if (SBMM.watermark) SBMM.watermark.burn(cv);
        cv.toBlob(b => {
          if (!b) { toast("could not write the PNG — see console"); return; }
          download(`boring_${tab}_${tab === "compare" ? cmp.join("-") : cur}.png`, b);
        }, "image/png");
      } catch (e) { console.error(e); toast("PNG export failed: " + e.message); }
    };
    img.onerror = () => toast("could not render the log to a picture");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
  }

  /* ------------------------------------------------------------------ */
  /* the printed log sheet (§2.3)                                        */
  /* ------------------------------------------------------------------ */
  /* One Letter page per PAGE_FT of hole at 1 in = 5 ft, the header block
     repeated on every page, "page 2 of 3", the legend on the last page of the
     document, and the watermark every export carries. Black on white with the
     class tints and the USCS patterns kept — this is the appendix the team
     hands out, so it has to look like one. */
  const PRINT_CSS = `
    @page { size: letter portrait; margin: 0.35in; }
    *{box-sizing:border-box}
    body{margin:0;background:#fff;color:#111;font:11px/1.45 "Helvetica Neue",Helvetica,Arial,sans-serif;
      -webkit-print-color-adjust:exact;print-color-adjust:exact}
    .pg{width:720px;margin:0 auto 18px;padding:0 0 8px;page-break-after:always;position:relative}
    .pg:last-child{page-break-after:auto}
    .hd{border:1.3px solid #111;margin-bottom:8px}
    .hd .r1{display:flex;border-bottom:1px solid #111}
    .hd .who{padding:4px 9px;flex:1}
    .hd .who h1{font-size:14px;margin:0;font-weight:700;letter-spacing:.02em;line-height:1.2}
    .hd .who .sub{font-size:9.5px;color:#444;line-height:1.3}
    .hd .pgno{padding:4px 9px;border-left:1px solid #111;min-width:1.15in;text-align:right;
      font-size:9.5px;line-height:1.3}
    .hd .grid{display:flex;flex-wrap:wrap;font-size:9.5px}
    .hd .grid div{padding:1px 8px;border-right:1px solid #ccc;border-top:1px solid #eee;min-width:118px}
    .hd .grid span{color:#666;display:block;font-size:8px;text-transform:uppercase;letter-spacing:.05em;
      line-height:1.3}
    .hd .grid b{font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.3}
    .flags{border:1px solid #b00;color:#b00;padding:1px 8px;font-size:9.5px;margin:0 0 5px}
    /* 720 px = 7.5 in at the browser's 96 dpi, so 19.2 px/ft prints at exactly
       1 in = 5 ft. Do NOT put width:100% on it — the drawing would print at
       whatever the paper happened to be, and a log sheet at "about" a scale is
       a picture rather than a log sheet. */
    svg{display:block;width:720px;height:auto}
    .lg{display:flex;flex-wrap:wrap;gap:10px;font-size:9.5px;margin-top:8px;border-top:1px solid #111;padding-top:6px}
    .lg i{display:inline-block;width:11px;height:11px;border:1px solid #111;vertical-align:-1px;margin-right:3px}
    .ft{position:absolute;bottom:-2px;right:0;font-size:8.5px;color:#666}
    .ft2{position:absolute;bottom:-2px;left:0;font-size:8.5px;color:#666}
  `;

  function headerHtml(h, page, pages) {
    const d = BL().deltaLidar(h);
    const c = h.contacts || {}, w = h.water;
    const m0 = (h.methods || [])[0] || {};
    const f = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
    return `<div class="hd">
      <div class="r1">
        <div class="who"><h1>Boring ${esc(h.id)}</h1>
          <div class="sub">SBMM OU1 — Sulphur Bank Mercury Mine · ${esc(BL().areaOf(h.id) || "waste area not assigned")}
            · 2025 geotechnical investigation</div></div>
        <div class="pgno">page ${page} of ${pages}<br>1&Prime; = 5&prime;<br>${new Date().toISOString().slice(0, 10)}</div>
      </div>
      <div class="grid">
        ${/* THE PRINTED HEADER LEADS WITH THE SAME SIX FACTS THE WINDOW'S
             STRIP DOES, in the same order (v24 §2 item 7): the hole and its
             waste area are the title block above, then ground, contact,
             bedrock and water. A sheet whose header reads in a different
             order from the screen it was read on is a second document. */ ""}
        ${f("Ground elev", fmt(h.elev, 1) + " ft" + (d ? " (Δ lidar " + (d.d > 0 ? "+" : "") + fmt(d.d, 1) + ")" : ""))}
        ${f("Native contact", c.native_contact == null ? "not stated" : fmt(c.native_contact, 1) + " ft")}
        ${f("Bedrock", c.bedrock_top == null ? "not reached" : fmt(c.bedrock_top, 1) + " ft")}
        ${f("Groundwater", w && w.encountered && w.depth != null
            ? fmt(w.depth, 1) + " ft" + (w.perched ? " perched" : "") : "not encountered")}
        ${f("Total depth", fmt(h.depth, 1) + " ft")}
        ${f("Base elev", h.elev != null ? fmt(h.elev - h.depth, 1) + " ft" : "—")}
        ${f("E / N", fmt0(h.x) + ", " + fmt0(h.y))}
        ${f("Lat / long", h.lat != null ? h.lat.toFixed(6) + ", " + h.lon.toFixed(6) : "—")}
        ${f("Drilled", (h.date_start || "—") + (h.date_end && h.date_end !== h.date_start ? "–" + h.date_end : ""))}
        ${f("Method", esc(h.method_words || "—"))}
        ${f("Logged / checked", esc((h.logger || "—") + (h.checked_by ? " · " + h.checked_by : "")))}
        ${f("Driller", esc([m0.driller, m0.contractor].filter(Boolean).join(" · ") || "—"))}
      </div></div>
      ${(c.flags || []).length ? `<div class="flags">${esc(c.flags.join(" · "))} — not reconciled</div>` : ""}`;
  }

  function legendHtml() {
    const cls = ["waste", "native", "bedrock", "unknown"];
    return `<div class="lg">`
      + cls.map(k => `<span><i style="background:${BL().classColor(k)}"></i>${esc(BL().classWord(k))}</span>`).join("")
      + `<span><i style="background:${BL().classColor("contact")}"></i>native contact (logger's remark)</span>`
      + `<span><i style="background:#55C1FF"></i>groundwater</span>`
      + `<span>USCS pattern per ASTM D2488 · tint = logged class</span>`
      + `<span>N = SPT blows/ft · PP tsf · pH rule at 4</span>`
      + `</div>`;
  }

  function pagesFor(h) {
    const pgs = [];
    const n = Math.max(1, Math.ceil((h.depth || 1) / PAGE_FT));
    for (let i = 0; i < n; i++) pgs.push([i * PAGE_FT, Math.min(h.depth, (i + 1) * PAGE_FT)]);
    return pgs;
  }

  function sheetHtml(ids) {
    const list = ids.map(id => BL().byId(id)).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    const mark = SBMM.watermark ? SBMM.watermark.text() : "";
    let pages = [], total = 0;
    for (const h of list) total += pagesFor(h).length;
    let k = 0;
    for (const h of list) {
      const pgs = pagesFor(h);
      pgs.forEach((rng, i) => {
        k++;
        const r = BL().column(h, { tier: "sheet", ppf: DPI / 5, w: 720, print: true,
          headings: true, top: rng[0], bot: rng[1], padTop: 30, padBot: 10 });
        pages.push(`<div class="pg">${headerHtml(h, i + 1, pgs.length)}`
          + `<svg viewBox="0 0 ${r.w} ${r.h}" width="${r.w}" height="${r.h}"`
          + ` xmlns="http://www.w3.org/2000/svg"><style>text{font-family:ui-monospace,Consolas,monospace}</style>`
          + r.defs + r.g + `</svg>`
          + (k === total ? legendHtml() : "")
          + `<div class="ft2">Jacobs · SBMM OU1 · Task 2.1.5 · ${today}</div>`
          + `<div class="ft">${esc(mark)}</div></div>`);
      });
    }
    const title = list.length === 1 ? `Boring log ${list[0].id}` : `Boring logs — ${list.length} holes`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — SBMM OU1</title>`
      + `<style>${PRINT_CSS}</style></head><body>${pages.join("")}</body></html>`;
  }

  function printSheet(ids) {
    if (!has()) { toast("this build has no boring logs"); return null; }
    const list = (ids || []).filter(id => BL().byId(id));
    if (!list.length) { toast("no boring to print"); return null; }
    if (!SBMM.report || !SBMM.report.present) { toast("the report engine is not in this build"); return null; }
    const html = sheetHtml(list);
    SBMM.report.present(list.length === 1 ? "Boring log " + list[0] : `Boring logs — ${list.length} holes`,
      html, `boring_log_${list.length === 1 ? list[0] : "set"}.html`);
    return html;
  }
  function printArea() {
    const a = BL().areaOf(cur);
    if (!a) { toast(`${cur} has no waste area — print prints this hole`); return printSheet([cur]); }
    const ids = (BL().areas().get(a) || [cur]);
    toast(`${a} — ${ids.length} logs`);
    return printSheet(ids);
  }

  /* ------------------------------------------------------------------ */
  /* wire                                                                */
  /* ------------------------------------------------------------------ */
  function wire() {
    /* Esc, in the capture phase, the way js/sheets.js takes it. sheets.js runs
       first (it is wired first) and steps aside through ownsEscape(). */
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !W) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ($("dsDialog") || $("reportModal") || document.querySelector(".modal")) return;
      if (!ownsEscape()) return;
      if (close()) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    window.addEventListener("resize", () => { if (W) follow(); });
    if (SBMM.events && SBMM.events.on) SBMM.events.on("field", () => { if (W) follow(); });
  }

  return {
    wire, open, close, isOpen, ownsEscape, maximise, follow,
    tab: t => { if (t) { tab = t; paint(); } return tab; },
    scale: s => { if (s) { scale = s; const el = W && W.el.querySelector(".bwscale");
                           if (el) el.value = String(s); paint(); } return scale; },
    datum: d => { if (d) { datum = d; const el = W && W.el.querySelector(".bwdatum");
                           if (el) el.value = d; paint(); } return datum; },
    compare: ids => { if (ids) { cmp = ids.slice(0, MAXCMP); cmpCleared = !cmp.length;
                                 tab = "compare"; paint(); } return cmp.slice(); },
    current: () => cur, step,
    sheetHtml, printSheet, pagesFor, tableCsv, logSvg,
    /* the state a harness may read — FIELDS only, never the object: it holds
       DOM nodes and a page.evaluate cannot return one (CLAUDE.md) */
    stateOf: () => W ? { open: true, id: cur, tab, scale, datum, maxed: W.maxed,
                         cmp: cmp.slice(), z: +W.el.style.zIndex || 0,
                         pinned: W.pin != null,
                         /* the drawing's own mapping, so a harness can ask what
                            depth is at a screen y without driving a mousemove */
                         geom: W.geom ? { ppf: W.geom.ppf, top: W.geom.top, y0: W.geom.y0 } : null }
                      : { open: false },
    /* the depth at a CLIENT y — the ctrl+wheel anchor is stated in exactly
       these terms, so this is what proves it held (v24 §2 item 5) */
    depthAtClientY: y => {
      if (!W || !W.geom) return null;
      const r = W.art.getBoundingClientRect();
      return W.geom.top + ((y - r.top) - W.geom.y0) / W.geom.ppf;
    }
  };
})();
