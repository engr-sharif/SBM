/* SBMM Site Explorer — the floating sheet viewer (light table).

   The design overlays in designea.js are *crops* of each sheet's plan area,
   de-rotated into State Plane. That is the right thing for a map overlay and
   useless for reading a drawing: the title block, the general notes, the legend,
   the section callouts and the detail bubbles all live outside the plan viewport,
   and half of what you actually need on site is in those.

   So this module carries a second rendering of the same drawings — the whole
   36x24 sheet exactly as plotted, at ~117 dpi — and puts it in a floating window
   that animates up from wherever you asked for it: a sheet's footprint on the 2D
   map, its row in the Layers tab, its drape in 3D, or the SHEETS command.

   Every sheet in the set is here (20 of them), including the four that are not
   georegistered and the two general sheets. Registration is about where a drawing
   belongs on the ground; it has nothing to do with whether the drawing is worth
   reading, and C-102's staging-area notes are wanted on site either way. */
"use strict";

SBMM.sheets = (function () {

  const MIN_SCALE = 0.02, MAX_SCALE = 12;
  const wins = new Map();          // sheet -> window state
  /* Windows live in a fixed 4000-4899 band (see the stacking comment in app.css).
     Bringing one to the front re-stacks the whole set rather than incrementing a
     counter, so a long session cannot climb past the modals and the report. */
  const Z_BASE = 4000;
  let cascade = 0;

  /* ------------------------------------------------------------------ */
  /* the box a floating window is allowed to live in (F8)                 */
  /* ------------------------------------------------------------------ */
  /* The stage — the map / 3D area between the two docks — not the viewport.
     A window that spills over the right dock hides the Inspector, which is
     exactly the panel you are reading while you mark up a sheet. Falls back to
     the viewport if the stage is somehow not there, so this can never be the
     reason a sheet fails to open. */
  function stageBox() {
    const st = document.getElementById("stage");
    if (!st) return { x: 8, y: 8, w: Math.max(200, window.innerWidth - 16), h: Math.max(200, window.innerHeight - 16) };
    const r = st.getBoundingClientRect();
    return { x: r.left, y: r.top, w: Math.max(200, r.width), h: Math.max(200, r.height) };
  }
  function clampToStage(el) {
    const b = stageBox();
    const w = Math.min(el.offsetWidth, b.w - 12), h = Math.min(el.offsetHeight, b.h - 12);
    if (el.offsetWidth > w) el.style.width = Math.round(w) + "px";
    if (el.offsetHeight > h) el.style.height = Math.round(h) + "px";
    el.style.left = Math.round(clamp(el.offsetLeft, b.x + 6, Math.max(b.x + 6, b.x + b.w - w - 6))) + "px";
    el.style.top = Math.round(clamp(el.offsetTop, b.y + 6, Math.max(b.y + 6, b.y + b.h - h - 6))) + "px";
  }
  /* dragging a dock grip, collapsing a dock or resizing the browser all move
     the stage's edges under a window that is already open */
  function clampAll() { for (const st of wins.values()) { clampToStage(st.el); clampPan(st); apply(st); } }

  /* ------------------------------------------------------------------ */
  /* index                                                               */
  /* ------------------------------------------------------------------ */
  function raw() { return (window.SBMM_DATA && SBMM_DATA.sheets_full) || null; }

  function imgUrl(sheet) {
    return SBMM_DATA["sheet_full_" + sheet.replace(/-/g, "") + "_jpg"] || null;
  }

  /* One row per sheet: what it is, and — only if it happens to be registered —
     where it sits. `bounds` is the axis-aligned State Plane footprint of the
     de-rotated raster, which is what "locate on map" and the footprint hit
     target both use. */
  let INDEX = null;
  function index() {
    if (INDEX) return INDEX;
    const D = raw();
    if (!D || !Array.isArray(D.sheets)) { INDEX = []; return INDEX; }
    const reg = (window.SBMM_DATA && SBMM_DATA.design_ea && SBMM_DATA.design_ea.sheets) || {};
    INDEX = D.sheets.map(s => {
      const r = reg[s.sheet] && reg[s.sheet].raster;
      return {
        sheet: s.sheet,
        title: s.title,
        design_set: s.design_set || "Final",
        w: s.w, h: s.h,
        registered: !!r,
        subject: (reg[s.sheet] && reg[s.sheet].subject) || null,
        bounds: r ? [r.x0, r.y0, r.x1, r.y1] : null,
        url: imgUrl(s.sheet)
      };
    });
    /* A sheet with no render still belongs in the index. The FIELD build
       (tools/build_dist.py --field) leaves the 20 full-sheet JPEGs out — 27 MB
       of paper on a phone — but keeps the manifest, so the Sheets tab still
       lists the drawing set and says which ones cannot be opened here. Dropping
       them would make the tab claim the set does not exist. `open()` refuses
       one with a toast; `hasRender()` is the question anything else should ask. */
    return INDEX;
  }
  function hasRender(sheet) { const s = get(sheet); return !!(s && s.url); }
  /* the one sentence every refusal uses, so it reads the same everywhere */
  function noRenderWhy(sheet) {
    return SBMM.isField && SBMM.isField()
      ? sheet + " — the full-sheet renders are not in the field build; its design geometry is"
      : "no full-sheet render for " + sheet;
  }
  function get(sheet) { return index().find(s => s.sheet === sheet) || null; }

  /* ------------------------------------------------------------------ */
  /* the window                                                          */
  /* ------------------------------------------------------------------ */
  function front(st) {
    const order = [...wins.values()].sort((p, q) => (+p.el.style.zIndex || 0) - (+q.el.style.zIndex || 0));
    const i = order.indexOf(st);
    if (i >= 0) order.splice(i, 1);
    order.push(st);
    order.forEach((w, k) => { w.el.style.zIndex = Z_BASE + Math.min(k, 899); });
  }

  function open(sheet, opts) {
    const s = get(sheet);
    if (!s) { toast("no full-sheet render for " + sheet); return null; }
    if (!s.url) { toast(noRenderWhy(sheet), 4200); return null; }
    const o = opts || {};
    const have = wins.get(sheet);
    if (have) {                    // already open — surface it instead of stacking
      front(have);
      have.el.classList.remove("pulse");
      void have.el.offsetWidth;
      have.el.classList.add("pulse");
      return have;
    }

    const el = document.createElement("div");
    el.className = "shwin";
    el.tabIndex = 0;
    el.dataset.sheet = sheet;
    const badge = s.design_set === "90%"
      ? `<span class="warnpill" title="From the 90% Pre-Final Design set (May 2025) — a superseded design">90%</span>`
      : (s.registered ? "" : `<span class="dimpill" title="This sheet is not georeferenced, so it has no place on the map. The drawing is unaffected.">not placed</span>`);
    el.innerHTML = `
      <div class="shbar">
        <span class="shno">${esc(s.sheet)}</span>
        <span class="shtitle">${esc(s.title)}</span>${badge}
        <span class="spacer"></span>
        <button class="minib shprev" title="Previous sheet (Page Up)">‹</button>
        <button class="minib shnext" title="Next sheet (Page Down)">›</button>
        <span class="vsep"></span>
        <button class="minib shfit" title="Fit the whole sheet">fit</button>
        <button class="minib shone" title="Actual pixels">1:1</button>
        <button class="minib shloc" title="Fly the 2D map to this sheet's footprint"${s.registered ? "" : " disabled"}>locate</button>
        <span class="ic x shclose" title="Close (Esc)">✕</span>
      </div>
      <div class="shview"><img class="shimg" alt="${esc(s.sheet)} — ${esc(s.title)}" draggable="false"></div>
      <div class="shfoot">
        <span class="mono shzoom">—</span>
        <span class="mut shprov">${esc(provLine(s))}</span>
        <span class="spacer"></span>
        <span class="mut shhint">scroll to zoom · drag to pan · arrows pan · +/− zoom</span>
      </div>
      <div class="shgrip" title="Drag to resize"></div>`;
    document.body.appendChild(el);

    /* geometry: cascade inside the STAGE, not the viewport (F8).
       A sheet window sized against window.innerWidth sat on top of the right
       dock and hid the Inspector's labels — the two things you most want side
       by side are the drawing and the properties of what you just marked on
       it. The stage is the map/3D box between the docks, so that is the box a
       floating window belongs in. */
    const b = stageBox();
    const W = Math.round(clamp(b.w * 0.86, 420, Math.max(420, b.w - 24)));
    const H = Math.round(clamp(b.h * 0.88, 300, Math.max(300, b.h - 24)));
    const off = (cascade++ % 6) * 26;
    el.style.width = W + "px";
    el.style.height = H + "px";
    /* centred in the stage, then cascaded, then clamped — clamp last, so the
       cascade offset can never push the window (or its grip) outside */
    el.style.left = Math.round(clamp(b.x + (b.w - W) / 2 + off, b.x + 6, Math.max(b.x + 6, b.x + b.w - W - 6))) + "px";
    el.style.top = Math.round(clamp(b.y + (b.h - H) / 2 - 10 + off, b.y + 6, Math.max(b.y + 6, b.y + b.h - H - 6))) + "px";

    const st = {
      sheet, s, el,
      view: el.querySelector(".shview"),
      img: el.querySelector(".shimg"),
      scale: 1, tx: 0, ty: 0, iw: s.w, ih: s.h, loaded: false,
      origin: o.origin || null
    };
    wins.set(sheet, st);
    front(st);
    wireWindow(st);

    /* Animate up from the click point. The transition is set only after the
       start transform has been committed, so the first frame is the small one —
       otherwise the browser coalesces both writes and nothing animates. */
    const r = el.getBoundingClientRect();
    const ox = st.origin ? st.origin.x : r.left + r.width / 2;
    const oy = st.origin ? st.origin.y : r.top + r.height / 2;
    el.style.transition = "none";
    el.style.opacity = "0";
    el.style.transform = `translate(${(ox - (r.left + r.width / 2)).toFixed(1)}px,${(oy - (r.top + r.height / 2)).toFixed(1)}px) scale(.08)`;
    void el.offsetWidth;
    el.style.transition = "transform .25s var(--ease), opacity .18s linear";
    el.style.opacity = "1";
    el.style.transform = "translate(0,0) scale(1)";

    st.img.onload = () => {
      st.iw = st.img.naturalWidth || s.w;
      st.ih = st.img.naturalHeight || s.h;
      st.loaded = true;
      fit(st);
    };
    st.img.onerror = () => {
      st.loaded = false;
      toast(s.sheet + ": the sheet image could not be decoded");
      st.view.classList.add("sherr");
      st.view.setAttribute("data-err", "This sheet's image did not load.");
    };
    st.img.src = s.url;
    /* the marking toolbar and its overlay canvas (§9, js/sheetmarks.js) */
    if (SBMM.sheetMarks) SBMM.sheetMarks.attach(st);
    setTimeout(() => el.focus({ preventScroll: true }), 30);
    return st;
  }

  function provLine(s) {
    return s.design_set === "90%"
      ? "EA 90% Pre-Final Design, May 2025 — superseded"
      : "EA Final Residential Design, September 2025 — 100% Plans for Construction";
  }

  function close(st) {
    if (!st || st.closing) return;
    st.closing = true;
    const el = st.el, r = el.getBoundingClientRect();
    const ox = st.origin ? st.origin.x : r.left + r.width / 2;
    const oy = st.origin ? st.origin.y : r.top + r.height / 2;
    el.style.transition = "transform .2s var(--ease), opacity .18s linear";
    el.style.transform = `translate(${(ox - (r.left + r.width / 2)).toFixed(1)}px,${(oy - (r.top + r.height / 2)).toFixed(1)}px) scale(.08)`;
    el.style.opacity = "0";
    wins.delete(st.sheet);
    if (SBMM.sheetMarks) SBMM.sheetMarks.detach(st);
    setTimeout(() => el.remove(), 230);
  }
  function closeTop() {
    let best = null;
    for (const st of wins.values())
      if (!best || +st.el.style.zIndex > +best.el.style.zIndex) best = st;
    if (best) { close(best); return true; }
    return false;
  }

  /* ---------- zoom / pan ---------- */
  function apply(st) {
    st.img.style.transform = `translate3d(${st.tx.toFixed(1)}px,${st.ty.toFixed(1)}px,0) scale(${st.scale})`;
    const z = st.el.querySelector(".shzoom");
    if (z) z.textContent = Math.round(st.scale * 100) + "%";
  }
  function clampPan(st) {
    /* keep at least a corner of the drawing in view — free panning past the edge
       is how a user loses the sheet entirely and thinks the viewer broke */
    const vw = st.view.clientWidth, vh = st.view.clientHeight;
    const w = st.iw * st.scale, h = st.ih * st.scale;
    const mx = Math.max(0, w - vw), my = Math.max(0, h - vh);
    const padx = w < vw ? (vw - w) / 2 : 0, pady = h < vh ? (vh - h) / 2 : 0;
    st.tx = w < vw ? padx : clamp(st.tx, -mx, 0);
    st.ty = h < vh ? pady : clamp(st.ty, -my, 0);
  }
  function fit(st) {
    const vw = st.view.clientWidth, vh = st.view.clientHeight;
    st.scale = Math.min(vw / st.iw, vh / st.ih) * 0.98;
    st.tx = (vw - st.iw * st.scale) / 2;
    st.ty = (vh - st.ih * st.scale) / 2;
    apply(st);
  }
  function zoomAt(st, k, cx, cy) {
    const ns = clamp(st.scale * k, MIN_SCALE, MAX_SCALE);
    if (ns === st.scale) return;
    st.tx = cx - (cx - st.tx) * (ns / st.scale);
    st.ty = cy - (cy - st.ty) * (ns / st.scale);
    st.scale = ns;
    clampPan(st);
    apply(st);
  }
  function zoomCentre(st, k) {
    zoomAt(st, k, st.view.clientWidth / 2, st.view.clientHeight / 2);
  }

  /* ---------- wiring ----------
     Named wireWindow, not wire: the module already exports a wire() for its
     document-level keys, and two hoisted `function wire` declarations in one
     scope silently leave only the last one. That cost real time — every button
     appeared to work (they are wired elsewhere) while wheel-zoom, pan, drag and
     resize were never attached at all. */
  function wireWindow(st) {
    const el = st.el;
    el.addEventListener("pointerdown", () => front(st), true);
    el.querySelector(".shclose").onclick = () => close(st);
    el.querySelector(".shfit").onclick = () => fit(st);
    el.querySelector(".shone").onclick = () => {
      const cx = st.view.clientWidth / 2, cy = st.view.clientHeight / 2;
      zoomAt(st, 1 / st.scale, cx, cy);
    };
    el.querySelector(".shloc").onclick = () => locate(st.sheet);
    el.querySelector(".shprev").onclick = () => step(st, -1);
    el.querySelector(".shnext").onclick = () => step(st, +1);

    /* wheel zoom toward the cursor */
    st.view.addEventListener("wheel", e => {
      e.preventDefault();
      const r = st.view.getBoundingClientRect();
      zoomAt(st, Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    /* drag pan */
    let drag = null;
    st.view.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty };
      st.view.setPointerCapture(e.pointerId);
      st.view.classList.add("grabbing");
    });
    st.view.addEventListener("pointermove", e => {
      if (!drag) return;
      st.tx = drag.tx + (e.clientX - drag.x);
      st.ty = drag.ty + (e.clientY - drag.y);
      clampPan(st); apply(st);
    });
    const endDrag = () => { drag = null; st.view.classList.remove("grabbing"); };
    st.view.addEventListener("pointerup", endDrag);
    st.view.addEventListener("pointercancel", endDrag);

    /* move by the title bar */
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
      clampToStage(el);
    });
    bar.addEventListener("pointerup", () => { mv = null; });

    /* resize */
    const grip = el.querySelector(".shgrip");
    let rz = null;
    grip.addEventListener("pointerdown", e => {
      rz = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
      grip.setPointerCapture(e.pointerId);
      el.style.transition = "none";
      e.stopPropagation();
    });
    grip.addEventListener("pointermove", e => {
      if (!rz) return;
      const b = stageBox();
      /* never wider or taller than the stage, and never past its right/bottom */
      el.style.width = clamp(rz.w + e.clientX - rz.x, 420, Math.max(420, b.x + b.w - el.offsetLeft - 6)) + "px";
      el.style.height = clamp(rz.h + e.clientY - rz.y, 300, Math.max(300, b.y + b.h - el.offsetTop - 6)) + "px";
      clampToStage(el);
      clampPan(st); apply(st);
    });
    grip.addEventListener("pointerup", () => { rz = null; });

    el.addEventListener("keydown", e => {
      const k = e.key, pan = e.shiftKey ? 240 : 60;
      if (k === "Escape") { close(st); e.stopPropagation(); return; }
      if (k === "ArrowLeft") st.tx += pan;
      else if (k === "ArrowRight") st.tx -= pan;
      else if (k === "ArrowUp") st.ty += pan;
      else if (k === "ArrowDown") st.ty -= pan;
      else if (k === "+" || k === "=") zoomCentre(st, 1.25);
      else if (k === "-" || k === "_") zoomCentre(st, 1 / 1.25);
      else if (k === "PageUp") { step(st, -1); e.preventDefault(); return; }
      else if (k === "PageDown") { step(st, +1); e.preventDefault(); return; }
      else if (k === "0") { fit(st); e.preventDefault(); return; }
      else return;
      e.preventDefault();
      clampPan(st); apply(st);
    });
  }

  /* next/prev walks the sheet list in place — same window, same position, so
     flipping through the set feels like flipping through a set */
  function step(st, dir) {
    const list = index().filter(x => x.url);   // never flip onto a sheet with no render
    const i = list.findIndex(x => x.sheet === st.sheet);
    if (i < 0) return;
    const nx = list[(i + dir + list.length) % list.length];
    if (nx.sheet === st.sheet) return;
    const el = st.el;
    wins.delete(st.sheet);
    wins.set(nx.sheet, st);
    st.sheet = nx.sheet; st.s = nx;
    el.dataset.sheet = nx.sheet;
    el.querySelector(".shno").textContent = nx.sheet;
    el.querySelector(".shtitle").textContent = nx.title;
    el.querySelector(".shprov").textContent = provLine(nx);
    el.querySelector(".shloc").disabled = !nx.registered;
    const old = el.querySelector(".warnpill, .dimpill");
    if (old) old.remove();
    if (nx.design_set === "90%" || !nx.registered) {
      const p = document.createElement("span");
      p.className = nx.design_set === "90%" ? "warnpill" : "dimpill";
      p.textContent = nx.design_set === "90%" ? "90%" : "not placed";
      el.querySelector(".shtitle").after(p);
    }
    st.loaded = false;
    st.img.src = nx.url;
    /* the window kept its identity but changed sheet, so the marking state has
       to follow it — including whether the new sheet is georeferenced at all */
    if (SBMM.sheetMarks) SBMM.sheetMarks.resheet(st);
  }

  /* ------------------------------------------------------------------ */
  /* map linkage                                                         */
  /* ------------------------------------------------------------------ */
  function locate(sheet) {
    const s = get(sheet);
    if (!s || !s.bounds) { toast(sheet + " is not georeferenced — it has no footprint on the map"); return; }
    const [x0, y0, x1, y1] = s.bounds;
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen() && !document.body.classList.contains("split3d"))
      SBMM.viewer3d.frameBox(x0, y0, x1, y1);
    SBMM.map.flyToBounds([[y0, x0], [y1, x1]], { padding: [70, 70], duration: 0.7 });
    pulse(s.bounds);
  }
  /* The map runs `preferCanvas`, so a Leaflet vector has no DOM node and the
     `className` never reaches an element — the CSS keyframes did nothing and
     "locate" drew a plain static rectangle. Animate the style instead, which
     the canvas renderer does honour. */
  function pulse(b) {
    const [x0, y0, x1, y1] = b;
    const rect = L.rectangle([[y0, x0], [y1, x1]], {
      pane: "drawings", color: "#FFD34D", weight: 3, fill: false, interactive: false
    }).addTo(SBMM.map);
    let k = 0;
    const t = setInterval(() => {
      k++;
      rect.setStyle({ weight: k % 2 ? 1.25 : 3, opacity: k % 2 ? 0.45 : 1 });
      if (k >= 7) { clearInterval(t); SBMM.map.removeLayer(rect); }
    }, 260);
    rect._pulseTimer = t;
    return rect;
  }

  /* ------------------------------------------------------------------ */
  /* SHEETS — the whole set, registered or not                           */
  /* ------------------------------------------------------------------ */
  function closePicker() {
    const old = $("sheetPicker");
    if (old) { old.remove(); return true; }
    return false;
  }
  function list() {
    if (closePicker()) return;
    const box = document.createElement("div");
    box.id = "sheetPicker";
    box.className = "menu open sheetpick";
    const rows = index().map(s => `
      <div class="ci sheetrow" data-sheet="${esc(s.sheet)}">
        <b class="mono">${esc(s.sheet)}</b>
        <span class="st">${esc(s.title)}</span>
        ${!s.url ? '<span class="dimpill" title="The full-sheet renders are not in the field build">no render</span>'
          : s.design_set === "90%" ? '<span class="warnpill">90%</span>'
          : s.registered ? '<span class="okpill" title="Georeferenced — has a footprint on the map">placed</span>'
            : '<span class="dimpill" title="Not georeferenced">—</span>'}
      </div>`).join("");
    box.innerHTML = `<div class="ci hd">Drawing set — ${index().length} sheets ·
      EA Residential Design (C-110 from the 90% set)</div>${rows}`;
    document.body.appendChild(box);
    box.addEventListener("click", e => {
      const r = e.target.closest(".sheetrow");
      if (!r) return;
      const rc = r.getBoundingClientRect();
      box.remove();
      open(r.dataset.sheet, { origin: { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 } });
    });
    setTimeout(() => document.addEventListener("click", function once(e) {
      if (!box.contains(e.target)) { box.remove(); document.removeEventListener("click", once); }
    }), 0);
  }

  /* any full-screen modal currently up — these all sit above the windows */
  function modalOpen() {
    if ($("dsDialog") || $("reportModal")) return true;
    for (const id of ["help", "cmdHelp"]) {
      const el = $(id);
      if (el && el.style.display && el.style.display !== "none") return true;
    }
    return !!document.querySelector(".modal");
  }

  function wire() {
    /* Esc closes the top sheet window before anything else claims it. Capture
       phase, because the drawing tools also listen for Esc and would otherwise
       cancel a sketch the user was not touching. */
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      /* A sheet window is not the front-most thing in the app. If the user is
         typing, or a modal is open, Esc belongs to that — closing a sheet window
         they were not touching is exactly the kind of surprise this app should
         not have. */
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (modalOpen()) return;
      if (closePicker()) { e.stopPropagation(); e.preventDefault(); return; }
      if (!wins.size) return;
      /* A window with a mark in progress owns Esc first: this listener is on the
         document in the capture phase, so it runs BEFORE the window's own
         handler and would otherwise close the window out from under a sketch
         the user was only trying to cancel. Same rule as everywhere else — Esc
         reaches the front-most thing, and the front-most thing here is the
         sketch, not the window. */
      if (SBMM.sheetMarks && SBMM.sheetMarks.onEscape()) {
        e.stopPropagation(); e.preventDefault(); return;
      }
      if (closeTop()) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  return {
    wire, index, get, open, list, locate, close, closePicker, clampAll, stageBox, hasRender,
    openCount: () => wins.size,
    closeAll: () => { for (const st of [...wins.values()]) close(st); }
  };
})();
