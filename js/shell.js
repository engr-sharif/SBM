/* SBMM Site Explorer — workbench shell: dock tabs, collapse, resize, top-bar overflow.
   Pure chrome. Nothing here knows about terrain; it only re-lays-out the stage and tells
   the map / 3D view that their box changed. */
"use strict";

SBMM.shell = (function () {

  const MINW = 200, MAXW = 620;
  let relayoutQueued = false;

  /* the map and the WebGL canvas both need telling when the stage box changes */
  function relayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      if (SBMM.map) SBMM.map.invalidateSize({ animate: false });
      if (SBMM.viewer3d && SBMM.viewer3d.resize) SBMM.viewer3d.resize();
      /* the 3D bar has to re-measure even while the 3D view is shut, so that
         opening it never shows one frame of a clipped bar (F6) */
      if (SBMM.viewer3d && SBMM.viewer3d.reflowBar) SBMM.viewer3d.reflowBar();
      /* the stage's edges just moved under any open sheet window (F8) */
      if (SBMM.sheets && SBMM.sheets.clampAll) SBMM.sheets.clampAll();
      reflowTopbar();
    });
  }

  /* ------------------------------------------------------------------ */
  /* tabs                                                                */
  /* ------------------------------------------------------------------ */
  let curTab = "layers";
  function setTab(name, { expand = true } = {}) {
    /* the old left-dock "props" tab is the right dock's Inspector now (§3) */
    if (name === "props") { setRightTab("inspector"); return; }
    curTab = name;
    document.querySelectorAll("#leftBody .dockpane").forEach(p => { p.hidden = p.dataset.pane !== name; });
    document.querySelectorAll("#leftTabs .dtab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll("#leftRail .railbtn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    if (expand && document.body.classList.contains("lcol")) collapse("l", false);
    if (name === "sheets" && SBMM.sheetCards) SBMM.sheetCards.ensure();
    /* "which sheet covers this?" is a question asked while looking at the
       Sheets tab, so the footprints come up with it and go away with it (F1).
       A borrowed view, not a state change — the layer's own row still owns it. */
    if (SBMM.designEA && SBMM.designEA.autoFootprints) SBMM.designEA.autoFootprints(name === "sheets");
    relayout();
  }
  function activeTab() { return document.body.classList.contains("lcol") ? null : curTab; }

  /* ------------------------------------------------------------------ */
  /* right dock: Inspector / Results (§3)                                */
  /* ------------------------------------------------------------------ */
  /* The auto-switch rules are the point of having two tabs rather than two
     panels: selecting anything is a question about that thing, so the Inspector
     comes forward; starting a computation is a question about a number, so the
     Results do. Both are suppressed while the dock is collapsed — a collapsed
     dock is a deliberate choice and must not spring open on its own. */
  let curRTab = "inspector";
  function setRightTab(name, { expand = true } = {}) {
    curRTab = name;
    document.querySelectorAll("#rightBody .dockpane").forEach(p => { p.hidden = p.dataset.rpane !== name; });
    document.querySelectorAll("#rightTabs .dtab").forEach(b => b.classList.toggle("active", b.dataset.rtab === name));
    document.querySelectorAll("#rightRail .railbtn").forEach(b => b.classList.toggle("active", b.dataset.rtab === name));
    const csv = $("csvBtn"); if (csv) csv.hidden = name !== "results";
    if (expand && document.body.classList.contains("rcol")) collapse("r", false);
    relayout();
  }
  function activeRightTab() { return document.body.classList.contains("rcol") ? null : curRTab; }
  function showInspector() { if (!document.body.classList.contains("rcol")) setRightTab("inspector", { expand: false }); }
  function showResults() { if (!document.body.classList.contains("rcol")) setRightTab("results", { expand: false }); }

  /* ------------------------------------------------------------------ */
  /* collapse                                                            */
  /* ------------------------------------------------------------------ */
  function collapse(side, on) {
    const cls = side === "l" ? "lcol" : "rcol";
    if (on == null) on = !document.body.classList.contains(cls);
    document.body.classList.toggle(cls, on);
    /* a collapsed left dock is not "looking at the Sheets tab" (F1) */
    if (side === "l" && SBMM.designEA && SBMM.designEA.autoFootprints)
      SBMM.designEA.autoFootprints(!on && curTab === "sheets");
    setTimeout(relayout, 200);
    relayout();
  }

  /* ------------------------------------------------------------------ */
  /* drag-resize                                                         */
  /* ------------------------------------------------------------------ */
  function wireGrip(gripId, cssVar, side) {
    const grip = $(gripId);
    if (!grip) return;
    grip.addEventListener("pointerdown", e => {
      e.preventDefault();
      grip.classList.add("drag");
      document.body.classList.add("notrans");
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || 280;
      const move = ev => {
        const dx = side === "l" ? (ev.clientX - startX) : (startX - ev.clientX);
        const w = clamp(start + dx, MINW, MAXW);
        document.documentElement.style.setProperty(cssVar, w + "px");
        relayout();
      };
      const up = () => {
        grip.classList.remove("drag");
        document.body.classList.remove("notrans");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        try { localStorage.setItem("sbmm_dock" + side, document.documentElement.style.getPropertyValue(cssVar)); } catch (err) {}
        relayout();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("dblclick", () => {
      document.documentElement.style.removeProperty(cssVar);
      relayout();
    });
  }

  /* ------------------------------------------------------------------ */
  /* top-bar overflow                                                    */
  /* ------------------------------------------------------------------ */
  /* Four-stage narrowing, in the order that costs the user least.

     The bar carries six mode buttons, two menus, three view buttons and seven
     data commands, and §3 wants the primary tools LABELLED down to 1200 px — an
     icon-only Navigate/Inspect/Distance/Area/Volume/Section row is a guessing
     game. So the shortcut chips go first, then the labels on the ghost (data)
     commands, then all labels, and only then do commands move into the overflow
     menu. Measured against the real right edge of the last button; scrollWidth
     is unreliable on an overflow:visible flex row. */
  const STAGES = ["barnokbd", "barghost", "barcompact"];
  function reflowTopbar() {
    const bar = $("topbar"), menu = $("ovfMenu"), btn = $("ovfBtn");
    if (!bar || !menu || !btn) return;
    const grp = document.querySelector('.tgroup[data-grp="data"]');
    if (!grp) return;
    while (menu.firstElementChild) grp.appendChild(menu.firstElementChild);
    btn.hidden = true;
    menu.style.display = "none";
    STAGES.forEach(c => document.body.classList.remove(c));

    const help = $("helpBtn");
    const fits = () => help.getBoundingClientRect().right <= bar.getBoundingClientRect().right - 6;
    /* v17 §5: under body.touch every button is 44 px and there is one more of
       them (the command-bar button), so the bar starts one stage in. The
       narrowing is still MEASURED after that — a taller, wrapped bar is fine,
       a clipped one is not. */
    if (document.body.classList.contains("touch")) document.body.classList.add(STAGES[0]);
    for (const c of STAGES) {
      if (fits()) return;
      document.body.classList.add(c);
    }
    if (fits()) return;

    btn.hidden = false;
    let guard = 0;
    while (!fits() && grp.children.length > 0 && guard++ < 12) {
      menu.insertBefore(grp.lastElementChild, menu.firstChild);
    }
    btn.hidden = !menu.children.length;
  }

  /* ------------------------------------------------------------------ */
  function wire() {
    /* restore stored dock widths */
    try {
      const l = localStorage.getItem("sbmm_dockl"), r = localStorage.getItem("sbmm_dockr");
      if (l) document.documentElement.style.setProperty("--dockLW", l);
      if (r) document.documentElement.style.setProperty("--dockRW", r);
    } catch (e) {}

    document.querySelectorAll("#leftTabs .dtab").forEach(b => b.onclick = () => setTab(b.dataset.tab));
    document.querySelectorAll("#leftRail .railbtn").forEach(b => b.onclick = () => {
      if (document.body.classList.contains("lcol")) { setTab(b.dataset.tab); return; }
      if (curTab === b.dataset.tab) collapse("l", true); else setTab(b.dataset.tab);
    });
    document.querySelectorAll("#rightTabs .dtab").forEach(b => b.onclick = () => setRightTab(b.dataset.rtab));
    document.querySelectorAll("#rightRail .railbtn").forEach(b => b.onclick = () => {
      if (document.body.classList.contains("rcol")) { setRightTab(b.dataset.rtab); return; }
      if (curRTab === b.dataset.rtab) collapse("r", true); else setRightTab(b.dataset.rtab);
    });
    setRightTab("inspector", { expand: false });

    $("leftCollapse").onclick = () => collapse("l", true);
    $("rightCollapse").onclick = () => collapse("r", true);

    wireGrip("leftGrip", "--dockLW", "l");
    wireGrip("rightGrip", "--dockRW", "r");

    const ovf = $("ovfBtn"), menu = $("ovfMenu");
    ovf.onclick = e => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "block" ? "none" : "block";
    };
    menu.addEventListener("click", () => setTimeout(() => menu.style.display = "none", 0));
    document.addEventListener("click", e => {
      if (!menu.contains(e.target) && e.target !== ovf) menu.style.display = "none";
    });

    window.addEventListener("resize", relayout);
    wireV26();
    reflowTopbar();
  }

  /* ================================================================== */
  /* v26 (docs/V26_UI_AUDIT.md §5) — the floating shell                   */
  /* ================================================================== */

  /* ---- menus: one placement, one "close the others" ----------------- */
  /* Every drop-down in the app is position:fixed now (the bar floats, so a
     menu measured against the page would be off by the bar's own margin).
     `placeMenu` puts one under its button, clamped to the viewport, and marks
     the button expanded; `closeMenus` shuts every other. js/mode.js,
     js/water.js and js/io.js call both, so the four menus that grew up with
     their own copy of this logic now behave as one family. */
  function closeMenus(except) {
    document.querySelectorAll(".menu").forEach(m => {
      if (m === except || m.id === "ctxmenu") return;
      m.style.display = "none";
    });
    document.querySelectorAll('[aria-haspopup="true"][aria-expanded="true"]').forEach(b => {
      if (!except || b.dataset.menuFor !== except.id) b.setAttribute("aria-expanded", "false");
    });
  }
  function placeMenu(btn, menu) {
    const r = btn.getBoundingClientRect();
    menu.style.display = "block";
    menu.style.right = "auto"; menu.style.bottom = "auto";
    const w = menu.offsetWidth || 260;
    menu.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8))) + "px";
    menu.style.top = Math.round(r.bottom + 6) + "px";
    btn.dataset.menuFor = menu.id;
    btn.setAttribute("aria-expanded", "true");
    /* a11y: the menu is a menu, its rows are items, and the keyboard can walk
       them (menuKeys below); the button that opened it gets the focus back */
    menu.setAttribute("role", "menu");
    if (!menu.getAttribute("aria-label")) menu.setAttribute("aria-label", (btn.textContent || btn.title || "").replace("▾", "").trim());
    for (const it of menuItems(menu)) { it.setAttribute("role", "menuitem"); if (!it.hasAttribute("tabindex")) it.tabIndex = -1; }
    menuOpener = btn;
    let kb = false; try { kb = btn.matches(":focus-visible"); } catch (e) {}
    if (kb) { const f = menuItems(menu)[0]; if (f) setTimeout(() => f.focus(), 0); }
  }
  let menuOpener = null;
  function menuItems(menu) {
    return [...menu.querySelectorAll("button, .ci, [data-mode]")]
      .filter(e => !e.disabled && e.offsetParent !== null && !e.closest(".hd"));
  }
  function openMenu() {
    return [...document.querySelectorAll(".menu, .ctx")].find(m => m.style.display === "block" && m.getAttribute("role") === "menu") || null;
  }
  function menuKeys(e) {
    const m = openMenu();
    if (!m) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") && !m.contains(t)) return;
    const items = menuItems(m);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault(); e.stopPropagation();
      const n = e.key === "ArrowDown" ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[n].focus();
    } else if (e.key === "Home" || e.key === "End") {
      if (!items.length || i < 0) return;
      e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1].focus();
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      const b = menuOpener;
      closeMenus(null);
      m.style.display = "none";
      if (b) { b.setAttribute("aria-expanded", "false"); b.focus(); }
    } else if ((e.key === "Enter" || e.key === " ") && i >= 0 && items[i].tagName !== "BUTTON") {
      e.preventDefault(); items[i].click();
    }
  }
  function toggleMenu(btn, menu) {
    const open = menu.style.display === "block";
    closeMenus(open ? null : menu);
    if (open) { menu.style.display = "none"; btn.setAttribute("aria-expanded", "false"); }
    else placeMenu(btn, menu);
  }
  /* a plain menu of buttons: clicking one closes it */
  function wirePlainMenu(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId);
    if (!btn || !menu) return;
    btn.onclick = e => { e.stopPropagation(); toggleMenu(btn, menu); };
    menu.addEventListener("click", () => setTimeout(() => {
      menu.style.display = "none"; btn.setAttribute("aria-expanded", "false"); }, 0));
    document.addEventListener("click", e => {
      if (menu.style.display === "block" && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.style.display = "none"; btn.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---- the frame: the part of the stage no chrome covers ------------- */
  /* Read off the four variables the CSS already computes, so there is one
     definition of it. js/sheets.js and js/borewin.js keep their floating
     windows inside it, which is what "a window never hides the panel you are
     reading" means now that the panels float over the stage. */
  function frame() {
    const st = $("stage");
    const r = st ? st.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    if (document.body.classList.contains("field")) return { x: r.left, y: r.top, w: r.width, h: r.height };
    const cs = getComputedStyle(document.body);
    const px = v => parseFloat(cs.getPropertyValue(v)) || 0;
    /* the custom properties hold calc() expressions; resolve each through a
       throw-away element's box rather than parsing CSS arithmetic here */
    const probe = frame.probe || (frame.probe = (() => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;" +
        "width:var(--dockL);height:var(--dockR);margin-left:var(--fT);margin-top:var(--botH)";
      document.body.appendChild(d);
      return d;
    })());
    const b = probe.getBoundingClientRect(), ms = getComputedStyle(probe);
    const L = b.width, R = b.height, T = parseFloat(ms.marginLeft) || px("--fT"), B = parseFloat(ms.marginTop) || 0;
    const x = r.left + L, y = r.top + T;
    return { x, y, w: Math.max(200, r.width - L - R), h: Math.max(200, r.height - T - B) };
  }

  /* ---- the 2D / 3D / Split control ---------------------------------- */
  function paintViewSeg() {
    const open = SBMM.viewer3d && SBMM.viewer3d.isOpen && SBMM.viewer3d.isOpen();
    const split = document.body.classList.contains("v3dsplit");
    const on = split ? "splitTopBtn" : open ? "view3dBtn" : "view2dBtn";
    for (const id of ["view2dBtn", "view3dBtn", "splitTopBtn"]) {
      const b = $(id); if (!b) continue;
      b.classList.toggle("on", id === on);
      b.setAttribute("aria-pressed", id === on ? "true" : "false");
    }
  }

  /* ---- the contextual right panel (§5) ------------------------------- */
  /* Hidden (body.rauto) while it has nothing to say — no selection, no result
     card — and back the moment it does. A panel the user collapsed on purpose
     (body.rcol) is left alone: that is a choice, not an absence. */
  function rightHasContent() {
    const body = $("resBody");
    const cards = body ? [...body.children].some(c => !c.classList.contains("placeholder")) : false;
    return cards || !!(SBMM.store && SBMM.store.selected);
  }
  let rautoQueued = false;
  function syncRightAuto() {
    if (rautoQueued) return;
    rautoQueued = true;
    requestAnimationFrame(() => {
      rautoQueued = false;
      const was = document.body.classList.contains("rauto");
      const hide = !rightHasContent();
      if (was !== hide) { document.body.classList.toggle("rauto", hide); relayout(); setTimeout(relayout, 260); }
    });
  }

  /* ---- drafting chrome: OSNAP / POLAR show while a drafting tool is armed */
  function syncDrafting() {
    const m = SBMM.mode && SBMM.mode.current ? SBMM.mode.current() : "navigate";
    document.body.classList.toggle("drafting", m !== "navigate" && m !== "inspect");
  }

  function wireV26() {
    document.addEventListener("keydown", menuKeys, true);
    wirePlainMenu("siteMenuBtn", "siteMenu");
    /* the site-data rows that are not one of the old top-bar buttons */
    const lm = $("logsMenuBtn");
    if (lm) lm.onclick = () => { if (SBMM.cmd) SBMM.cmd.run("LOGWIN"); };
    const fm = $("fenceMenuBtn");
    if (fm) fm.onclick = () => { if (SBMM.cmd) SBMM.cmd.run("FENCE"); };
    const dm = $("dsMenuBtn");
    if (dm) dm.onclick = () => { const b = $("dsAddBtn"); if (b) b.click(); };

    const v2 = $("view2dBtn");
    if (v2) v2.onclick = () => {
      if (!SBMM.viewer3d) return;
      if (document.body.classList.contains("v3dsplit") && $("v3dSplit")) $("v3dSplit").click();
      if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
    };
    if (SBMM.events) {
      SBMM.events.on("view", () => { paintViewSeg(); relayout(); });
      SBMM.events.on("mode", syncDrafting);
    }
    paintViewSeg(); syncDrafting();

    const brand = $("brandBtn");
    if (brand) brand.onclick = () => { if (SBMM.home) SBMM.home.show({ frame: true }); };

    const body = $("resBody");
    if (body && window.MutationObserver) new MutationObserver(syncRightAuto).observe(body, { childList: true });
    if (SBMM.store && SBMM.store.onSelect) SBMM.store.onSelect(syncRightAuto);
    if (!document.body.classList.contains("field") && !rightHasContent()) document.body.classList.add("rauto");
  }

  return { wire, setTab, activeTab, collapse, relayout, reflowTopbar,
           setRightTab, activeRightTab, showInspector, showResults,
           closeMenus, placeMenu, toggleMenu, frame, syncRightAuto };
})();
