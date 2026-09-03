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
    reflowTopbar();
  }

  return { wire, setTab, activeTab, collapse, relayout, reflowTopbar,
           setRightTab, activeRightTab, showInspector, showResults };
})();
