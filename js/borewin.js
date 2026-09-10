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
  function stageBox() {
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
        <span class="shno bwid">—</span>
        <span class="shtitle">Boring log</span>
        <span class="spacer"></span>
        <button class="minib bwstep" data-d="-1" title="Previous boring (Left arrow)">‹</button>
        <button class="minib bwstep" data-d="1" title="Next boring (Right arrow)">›</button>
        <span class="vsep"></span>
        <button class="minib shmax bwmax" title="Maximise to the stage">⤢</button>
        <span class="ic x bwclose" title="Close (Esc)">✕</span>
      </div>
      <div class="bwtools">
        <span class="bwpickwrap">
          <input class="bwpick" type="text" placeholder="hole" autocomplete="off"
                 title="Find a boring by id or waste area">
          <div class="bwmenu" hidden></div>
        </span>
        <span class="bwtabs">
          <button class="minib bwtab" data-t="log" title="The log sheet for one hole">Log</button>
          <button class="minib bwtab" data-t="compare" title="Two to six holes on one elevation datum">Compare</button>
          <button class="minib bwtab" data-t="fence" title="A section through the borings along a drawn line">Fence</button>
          <button class="minib bwtab" data-t="table" title="Every hole, sortable and filterable by waste area">Table</button>
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
        <button class="minib" data-b="print" title="Printed log sheet (Print → PDF)">print</button>
        <button class="minib" data-b="printall" title="Every log in id order, as one document">print all</button>
        <button class="minib" data-b="printarea" title="Every log in this hole's waste area">print area</button>
        <button class="minib" data-b="csv" title="Copy this hole's strata, SPT, penetrometer and lab tables">csv</button>
        <button class="minib" data-b="png" title="Save what is drawn as a PNG">png</button>
      </div>
      <div class="bwhead"></div>
      <div class="bwbody"><div class="bwcur" hidden><i></i><b></b></div><div class="bwart"></div></div>
      <div class="shfoot">
        <span class="mono bwfoot">—</span>
        <span class="spacer"></span>
        <span class="mut bwprov">OpenGround logs · 2025 Jacobs investigation</span>
      </div>
      <div class="shgrip" title="Drag to resize"></div>`;
    document.body.appendChild(el);

    const b = stageBox();
    const maxed = !!(SBMM.touch && SBMM.touch.on());
    const w = maxed ? Math.round(b.w - 8) : Math.round(clamp(b.w * 0.94, minW(), Math.max(minW(), b.w - 16)));
    const hh = maxed ? Math.round(b.h - 8) : Math.round(clamp(b.h * 0.92, minH(), Math.max(minH(), b.h - 16)));
    el.style.width = w + "px"; el.style.height = hh + "px";
    el.style.left = Math.round(clamp(b.x + (b.w - w) / 2, b.x + 6, Math.max(b.x + 6, b.x + b.w - w - 6))) + "px";
    el.style.top = Math.round(clamp(b.y + (b.h - hh) / 2, b.y + 6, Math.max(b.y + 6, b.y + b.h - hh - 6))) + "px";
    el.style.zIndex = Z;
    if (maxed) el.classList.add("maxed");

    W = { el, maxed, restore: null,
          head: el.querySelector(".bwhead"), body: el.querySelector(".bwbody"),
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
    W.body.addEventListener("mouseleave", () => { if (W) W.cursor.hidden = true; });
    W.body.addEventListener("click", onArtClick);
    W.body.addEventListener("mouseover", onArtHover);

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

  function setScale(dir) {
    const i = SCALES.indexOf(scale);
    const j = clamp(i + dir, 0, SCALES.length - 1);
    if (j === i) return;
    scale = SCALES[j];
    const sc = W && W.el.querySelector(".bwscale");
    if (sc) sc.value = String(scale);
    paint();
  }
  function step(d) {
    const list = BL().ids();
    const i = list.indexOf(cur);
    if (i < 0) return;
    cur = list[(i + d + list.length) % list.length];
    if (tab === "table") tab = "log";
    paint();
  }

  /* ---- the hole picker: a typeahead over ids and waste areas -------- */
  function wirePicker() {
    const inp = W.el.querySelector(".bwpick"), menu = W.el.querySelector(".bwmenu");
    const shut = () => { menu.hidden = true; };
    const show = () => {
      const q = inp.value.trim().toLowerCase();
      const by = BL().areas();
      const out = [];
      for (const [area, ids] of by) {
        const hit = ids.filter(id => !q || id.toLowerCase().includes(q)
          || id.replace(/^SB-/i, "").toLowerCase() === q || area.toLowerCase().includes(q));
        if (!hit.length) continue;
        out.push(`<div class="bwgrp">${esc(area)} · ${hit.length}</div>`);
        for (const id of hit) {
          const h = BL().byId(id);
          out.push(`<div class="bwopt${id === cur ? " on" : ""}" data-id="${esc(id)}">`
            + `<span class="bwmini">${BL().columnSvg(h, { tier: "mini", ppf: 26 / (h.depth || 1),
                 padTop: 1, cssW: 14, cssH: 28 })}</span>`
            + `<b class="mono">${esc(id)}</b>`
            + `<span class="mut">${fmt(h.depth, 1)} ft`
            + `${h.contacts && h.contacts.native_contact != null
                 ? " · contact " + fmt(h.contacts.native_contact, 1) : ""}</span></div>`);
        }
      }
      menu.innerHTML = out.join("") || `<div class="bwgrp">no match</div>`;
      menu.hidden = false;
    };
    inp.addEventListener("focus", show);
    inp.addEventListener("input", show);
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const first = menu.querySelector(".bwopt");
        if (first) { cur = first.dataset.id; tab = tab === "table" ? "log" : tab; inp.value = ""; shut(); paint(); }
        e.stopPropagation(); e.preventDefault();
      }
    });
    menu.addEventListener("mousedown", e => {
      const r = e.target.closest(".bwopt");
      if (!r) return;
      e.preventDefault();
      if (tab === "compare") {
        const i = cmp.indexOf(r.dataset.id);
        if (i >= 0) cmp.splice(i, 1);
        else if (cmp.length < MAXCMP) cmp.push(r.dataset.id);
        else toast(`compare takes ${MAXCMP} holes at a time`);
      } else cur = r.dataset.id;
      inp.value = ""; shut(); paint();
    });
    inp.addEventListener("blur", () => setTimeout(shut, 120));
  }

  /* ------------------------------------------------------------------ */
  /* paint                                                               */
  /* ------------------------------------------------------------------ */
  function paint() {
    if (!W) return;
    const h = BL().byId(cur);
    W.el.querySelector(".bwid").textContent = cur || "—";
    W.el.querySelector(".shtitle").textContent =
      tab === "log" ? "Boring log" : tab === "compare" ? "Compare"
        : tab === "fence" ? "Fence" : "All borings";
    W.el.querySelectorAll(".bwtab").forEach(b => b.classList.toggle("active", b.dataset.t === tab));
    W.el.classList.toggle("bwtab-table", tab === "table");
    W.cursor.hidden = true;
    if (tab === "log") { paintHead(h); paintLog(h); }
    else if (tab === "compare") { W.head.innerHTML = ""; paintCompare(); }
    else if (tab === "fence") { W.head.innerHTML = ""; paintFence(); }
    else { W.head.innerHTML = ""; paintTable(); }
  }

  /* the header block — every fact a log sheet's header carries, as rows */
  function paintHead(h) {
    if (!h) { W.head.innerHTML = ""; return; }
    const d = BL().deltaLidar(h);
    const c = h.contacts || {}, w = h.water;
    const m0 = (h.methods || [])[0] || {};
    const area = BL().areaOf(h.id);
    const cell = (k, v, extra) => `<div class="bwf"><span>${esc(k)}</span><b${extra || ""}>${v}</b></div>`;
    W.head.innerHTML = `<div class="bwhrow">`
      + `<div class="bwhid"><b class="mono">${esc(h.id)}</b>`
      + `<span class="mut">${esc(area || "waste area not assigned")}</span></div>`
      + cell("Ground", `${fmt(h.elev, 1)} ft`
          + (d ? ` <span class="${d.warn ? "warnpill" : "mut"}" title="Lidar (Jan 2024) reads `
              + `${fmt(d.lidar, 1)} ft here">Δ lidar ${d.d > 0 ? "+" : ""}${fmt(d.d, 1)} ft</span>` : ""))
      + cell("Total depth", `${fmt(h.depth, 1)} ft`)
      + cell("Base", h.elev != null ? `${fmt(h.elev - h.depth, 1)} ft` : "—")
      + cell("Native contact", c.native_contact == null ? "not stated"
          : `${fmt(c.native_contact, 1)} ft`
            + (h.elev != null ? ` <span class="mut">${fmt(h.elev - c.native_contact, 1)} ft</span>` : ""))
      + cell("Bedrock", c.bedrock_top == null ? "not reached" : `${fmt(c.bedrock_top, 1)} ft`)
      + cell("Groundwater", w && w.encountered && w.depth != null
          ? `${fmt(w.depth, 1)} ft${w.perched ? " · perched" : ""}` : "not encountered")
      + cell("E / N", `${fmt0(h.x)}, ${fmt0(h.y)}`)
      + cell("Lat / long", h.lat != null ? `${h.lat.toFixed(6)}, ${h.lon.toFixed(6)}` : "—")
      + cell("Drilled", `${h.date_start || "—"}`
          + (h.date_end && h.date_end !== h.date_start ? `–${h.date_end}` : ""))
      + cell("Method", esc(h.method_words || "—"))
      + cell("Logged / checked", `${esc(h.logger || "—")}${h.checked_by ? " · " + esc(h.checked_by) : ""}`)
      + cell("Driller", esc([m0.driller, m0.contractor].filter(Boolean).join(" · ") || "—"))
      + `</div>`
      + ((c.flags || []).length
          ? `<div class="bwflags warnpill" title="${esc(c.flags.join('; '))}">${esc(c.flags.join(" · "))}</div>`
          : "");
  }

  function artWidth() {
    return Math.max(560, W.body.clientWidth - 18);
  }

  function paintLog(h) {
    if (!h) { W.art.innerHTML = ""; return; }
    const w = artWidth();
    const r = BL().column(h, { tier: "sheet", ppf: ppf(), w, datum, headings: true,
      zTop: h.elev, zBot: h.elev != null ? h.elev - h.depth : null });
    W.art.innerHTML = `<svg class="bwsvg" viewBox="0 0 ${r.w} ${r.h}" width="${r.w}" height="${r.h}"`
      + ` xmlns="http://www.w3.org/2000/svg">`
      + `<style>text{font-family:"SF Mono",ui-monospace,Consolas,Menlo,monospace}</style>`
      + r.defs + r.g + `</svg>`;
    W.geom = { ppf: r.ppf, top: r.top, y0: r.yOf(r.top), h: r.h };
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

  function paintCompare() {
    let list = cmp.map(id => BL().byId(id)).filter(Boolean);
    if (list.length < 2) {
      /* seed from the nearest holes rather than recursing: a payload with one
         hole in it would otherwise recurse for ever */
      cmp = nearest(cur, Math.min(4, BL().holes().length));
      list = cmp.map(id => BL().byId(id)).filter(Boolean);
    }
    if (list.length < 2) {
      W.art.innerHTML = `<div class="note">compare needs two holes</div>`;
      W.el.querySelector(".bwfoot").textContent = `${list.length} hole`;
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
      parts.push(`<text x="${c.x + CW / 2}" y="16" fill="#E8EEF1" font-size="11" text-anchor="middle"`
        + ` font-weight="700">${esc(c.h.id)}</text>`);
      parts.push(`<text x="${c.x + CW / 2}" y="26" fill="#6C7F8A" font-size="8.5" text-anchor="middle">`
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
      + `<div class="bwcmpsel">${BL().holes().map(h => `<label class="bwchip${cmp.includes(h.id) ? " on" : ""}">`
        + `<input type="checkbox" data-id="${esc(h.id)}"${cmp.includes(h.id) ? " checked" : ""}>`
        + `${esc(h.id)}</label>`).join("")}</div>`;
    W.art.querySelectorAll(".bwcmpsel input").forEach(cb => cb.onchange = () => {
      const id = cb.dataset.id, i = cmp.indexOf(id);
      if (cb.checked) { if (cmp.length >= MAXCMP) { cb.checked = false; toast(`compare takes ${MAXCMP} holes at a time`); return; } cmp.push(id); }
      else if (i >= 0) cmp.splice(i, 1);
      if (cmp.length < 2) { cmp.push(id); cb.checked = true; toast("compare needs two holes"); return; }
      paint();
    });
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
      + (all.length ? `<label class="bwlbl">fence <select class="fnpick">`
          + all.map(g => `<option value="${esc(g.id)}"${f && g.id === f.id ? " selected" : ""}>`
              + `${esc(g.name || "Fence")}</option>`).join("") + `</select></label>` : "")
      + (f ? `<label class="bwlbl">swath <input type="number" class="fnsw" step="25" min="10"`
          + ` style="width:64px" value="${f.props.swath_ft}"><span class="mut">ft either side</span></label>`
          + `<label class="bwlbl">vertical <select class="fnve">`
          + FN.VE_CHOICES.map(v => `<option value="${v}"${v === f.props.ve ? " selected" : ""}>${v}\u00d7</option>`).join("")
          + `</select></label>`
          + `<span class="spacer"></span>`
          + `<button class="minib" data-fb="png" title="Save the drawing as a PNG">png</button>`
          + `<button class="minib" data-fb="csv" title="Station, offset, ground and every horizon, per hole">csv</button>`
          + `<button class="minib" data-fb="dxf" title="Section coordinates: X = station ft, Y = elevation ft">dxf</button>`
        : "")
      + `</div>`;
    if (!f) {
      W.art.innerHTML = pick + `<div class="note">No fence drawn yet.</div>`;
      W.el.querySelector(".bwfoot").textContent = "no fence";
    } else {
      /* a fence is drawn at the width it is READ at. On a phone the whole
         stage is 393 px, so a 560-px floor would hand the CSS a drawing to
         scale down — which shrinks the text and keeps the collisions, the
         same lesson the results-card strip log carries. */
      const d = FN.drawSvg(f, { w: Math.max(touchy() ? 330 : 560, W.body.clientWidth - 18) });
      W.art.innerHTML = pick + (d ? d.svg : `<div class="note">this fence has no alignment</div>`);
      W.el.querySelector(".bwfoot").textContent = d
        ? `${d.holes.length} borings \u00b7 ${fmt(d.total, 1)} ft \u00b7 `
          + `${fmt0(d.zBot)}\u2013${fmt0(d.zTop)} ft NAVD88 \u00b7 ${f.props.ve}\u00d7 vertical`
        : "\u2014";
    }
    const q = c => W.art.querySelector(c);
    if (q(".fnnew")) q(".fnnew").onclick = () => { SBMM.cmd.run("FENCE"); };
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
    if (!W || tab !== "log" || !W.geom) return;
    const h = BL().byId(cur);
    if (!h) return;
    const r = W.art.getBoundingClientRect();
    const y = e.clientY - r.top;
    const ft = W.geom.top + (y - W.geom.y0) / W.geom.ppf;
    if (ft < 0 || ft > h.depth) { W.cursor.hidden = true; return; }
    const s = (h.strata || []).find(q => q.primary && ft >= q.top && ft < q.base);
    const drive = (h.spt || []).find(q => ft >= q.top && ft <= q.base);
    const near = (h.tests || []).filter(t => t.depth != null)
      .sort((a, b) => Math.abs(a.depth - ft) - Math.abs(b.depth - ft))[0];
    W.cursor.hidden = false;
    W.cursor.style.top = (y + W.art.offsetTop) + "px";
    W.cursor.querySelector("b").innerHTML =
      `<span class="mono">${fmt(ft, 1)} ft</span>`
      + (h.elev != null ? ` <span class="mono mut">${fmt(h.elev - ft, 1)} ft</span>` : "")
      + (s ? ` · ${esc(s.uscs || "no USCS")} ${esc(BL().classWord(s.cls))}` : "")
      + (drive ? ` · ${esc(drive.ref || "drive")} N ${esc(drive.n_text || "—")}` : "")
      + (near && Math.abs(near.depth - ft) < 2
          ? ` · ${esc(near.key)} ${fmt(near.value, near.value % 1 ? 2 : 0)}` : "");
    W.cursor.dataset.ft = ft.toFixed(2);
    W.cursor.dataset.uscs = s ? (s.uscs || "") : "";
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
        ${f("Ground elev", fmt(h.elev, 1) + " ft" + (d ? " (Δ lidar " + (d.d > 0 ? "+" : "") + fmt(d.d, 1) + ")" : ""))}
        ${f("Total depth", fmt(h.depth, 1) + " ft")}
        ${f("Base elev", h.elev != null ? fmt(h.elev - h.depth, 1) + " ft" : "—")}
        ${f("Native contact", c.native_contact == null ? "not stated" : fmt(c.native_contact, 1) + " ft")}
        ${f("Bedrock", c.bedrock_top == null ? "not reached" : fmt(c.bedrock_top, 1) + " ft")}
        ${f("Groundwater", w && w.encountered && w.depth != null
            ? fmt(w.depth, 1) + " ft" + (w.perched ? " perched" : "") : "not encountered")}
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
    compare: ids => { if (ids) { cmp = ids.slice(0, MAXCMP); tab = "compare"; paint(); } return cmp.slice(); },
    current: () => cur, step,
    sheetHtml, printSheet, pagesFor, tableCsv,
    /* the state a harness may read — FIELDS only, never the object: it holds
       DOM nodes and a page.evaluate cannot return one (CLAUDE.md) */
    stateOf: () => W ? { open: true, id: cur, tab, scale, datum, maxed: W.maxed,
                         cmp: cmp.slice(), z: +W.el.style.zIndex || 0 } : { open: false }
  };
})();
