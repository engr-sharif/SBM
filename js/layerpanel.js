/* SBMM Site Explorer — the Layers pane's MAP face (v26, docs/V26_UI_AUDIT.md §6).
   ---------------------------------------------------------------------------
   The v16 tree is complete and it is an 80-row wall: every EA CAD group, every
   sheet, every sub-group, all at once, with an opacity slider on every raster.
   That is the right CATALOGUE and the wrong first page. So the pane opens on
   what a person actually asks of a map, in this order:

     Basemap      four picture tiles — Imagery, Hillshade, Elevation, Plan —
                  one choice, not five checkboxes
     On the map   ONLY what is on now: a switch, a line of what it is, the
                  legend swatch that IS its symbology, and a ⋯ for opacity,
                  zoom to, solo and "find in the catalogue"
     Add from     the six topics, each opening the catalogue on that group
     Views        the presets as named rows, and "save this view"

   It is a VIEW over SBMM.layerState and the tree's own rows, like the tree is:
   a switch here toggles the tree row's own checkbox (so the cultural
   acknowledgement keeps winning, v16 rule 1), and nothing here keeps state of
   its own beyond which face is showing.
   --------------------------------------------------------------------------- */
"use strict";

SBMM.layersPanel = (function () {
  const LS = () => SBMM.layerState;
  const T = () => SBMM.layerTree;
  let view = "home", topic = null, beforeSearch = null;

  /* ------------------------------------------------------------------ */
  /* the basemap: four tiles over the raster rows                        */
  /* ------------------------------------------------------------------ */
  const ORTHO = ["ortho_site_1_5_ft", "ortho_mine_area_6_in", "ortho_abp_3_in"];
  const HILL = ["hillshade_site", "hillshade_mine_area_1_ft"];
  const TINT = "elevation_tint";
  const BASEMAP_ROWS = new Set(ORTHO.concat(HILL, [TINT]));
  const TILES = [
    ["imagery", "Imagery", "3 in · 6 in · 1.5 ft"],
    ["hillshade", "Hillshade", "1-ft lidar"],
    ["elevation", "Elevation", "tint over relief"],
    ["plan", "Plan", "contours only"]
  ];
  function has(id) { return !!LS().rec("base", id); }
  function on(id) { return has(id) && LS().isOn("base", id); }
  function currentBasemap() {
    if (ORTHO.some(on)) return "imagery";
    if (on(TINT)) return "elevation";
    if (HILL.some(on)) return "hillshade";
    return "plan";
  }
  function setBasemap(k) {
    const list = [];
    const put = (id, v) => { if (has(id)) list.push({ group: "base", layer: id, on: v }); };
    ORTHO.forEach(id => put(id, k === "imagery"));
    HILL.forEach(id => put(id, k === "hillshade" || k === "elevation"));
    put(TINT, k === "elevation");
    if (k === "plan") put("contours_site", true);
    LS().batch(list);
    paint();
  }
  /* each tile's picture is drawn from the real image the first time the pane
     is shown, and kept — an icon of a map is not a map */
  const thumbs = {};
  function thumbFor(k) {
    if (thumbs[k]) return thumbs[k];
    const D = window.SBMM_DATA || {};
    const src = k === "imagery" ? (D.ortho_mine_jpg || D.ortho_site_jpg) : k === "hillshade" || k === "elevation" ? (D.hs_abp_jpg || D.hs_site_jpg) : null;
    const c = document.createElement("canvas");
    c.width = 144; c.height = 88;
    const g = c.getContext("2d");
    const done = () => { try { thumbs[k] = c.toDataURL("image/jpeg", 0.82); } catch (e) {} paintTiles(); };
    if (k === "plan") {
      g.fillStyle = "#101920"; g.fillRect(0, 0, 144, 88);
      g.strokeStyle = "rgba(139,216,234,.55)"; g.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        g.beginPath();
        for (let x = 0; x <= 144; x += 6) { const y = 12 + i * 11 + Math.sin((x + i * 23) / 19) * 6 + Math.cos((x - i * 9) / 33) * 5; x ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
      }
      done(); return null;
    }
    if (!src) return null;
    const img = new Image();
    img.onload = () => {
      /* the middle of the image, where the site is */
      const sw = img.naturalWidth * 0.36, sh = sw * 88 / 144;
      g.drawImage(img, img.naturalWidth * 0.34, img.naturalHeight * 0.4, sw, sh, 0, 0, 144, 88);
      if (k === "elevation") {
        const gr = g.createLinearGradient(0, 88, 144, 0);
        gr.addColorStop(0, "rgba(47,109,93,.62)"); gr.addColorStop(.45, "rgba(224,194,113,.55)");
        gr.addColorStop(.75, "rgba(201,118,78,.55)"); gr.addColorStop(1, "rgba(242,237,230,.5)");
        g.fillStyle = gr; g.fillRect(0, 0, 144, 88);
      }
      done();
    };
    img.src = src;
    return null;
  }
  function paintTiles() {
    const el = document.getElementById("bmTiles");
    if (!el) return;
    const cur = currentBasemap();
    const html = TILES.map(([k, name, sub]) => {
      const u = thumbs[k] || thumbFor(k);
      return `<button class="bmt${k === cur ? " on" : ""}" data-bm="${k}" role="radio" aria-checked="${k === cur}" title="${name} — ${sub}">` +
        `<span class="bmth"${u ? ` style="background-image:url(${u})"` : ""}></span><span class="bmtn">${name}</span></button>`;
    }).join("");
    if (el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; }
  }

  /* ------------------------------------------------------------------ */
  /* on the map                                                          */
  /* ------------------------------------------------------------------ */
  const GROUP_WORD = { base: "Base", framework: "Site framework", design: "Residential design",
                       invest: "Investigations", cultural: "Cultural — protected", mywork: "My work" };
  function onRefs() {
    const out = [];
    const tree = T();
    if (!tree || !tree.refs) return out;
    for (const g of LS().groupList()) for (const r of g.layers.values()) {
      if (!r.on) continue;
      if (g.id === "base" && BASEMAP_ROWS.has(r.id)) continue;
      if (g.id === "design" && r.id === "sheets3d") continue;      // a switch about 3D, not a layer
      const ref = tree.refs().get(g.id + "/" + r.id);
      if (!ref) continue;
      out.push({ g: g.id, r, ref });
    }
    return out;
  }
  function descOf(g, r, ref) {
    const sub = ref.row && ref.row.dataset.lsub;
    const cnt = ref.row && ref.row.querySelector(".ltn");
    return (sub ? sub : GROUP_WORD[g] || g) + (cnt && cnt.textContent.trim() ? " · " + cnt.textContent.trim().replace(/[()]/g, "") : "");
  }
  function cleanLabel(s) { return String(s || "").replace(/\s*\(\d[\d,]*\)\s*$/, ""); }
  function paintOnMap() {
    const box = document.getElementById("onMap");
    if (!box) return;
    const list = onRefs();
    const n = document.getElementById("onMapN");
    if (n) n.textContent = list.length ? String(list.length) : "";
    let html = "";
    if (!list.length) html = `<div class="omempty">Only the basemap. Add layers from a topic below, or search.</div>`;
    for (const { g, r, ref } of list) {
      const sw = ref.row.querySelector(".ltsw");
      html += `<div class="omrow" data-k="${esc(g + "/" + r.id)}">` +
        `<span class="omsw">${sw ? sw.innerHTML : ""}</span>` +
        `<span class="omt"><b>${esc(cleanLabel(r.label))}</b><small>${esc(descOf(g, r, ref))}</small></span>` +
        `<button class="omsw2 on" data-a="off" role="switch" aria-checked="true" title="Switch off"></button>` +
        `<button class="ommore" data-a="more" title="Opacity, zoom to, solo…" aria-label="More">⋯</button></div>`;
    }
    if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
  }

  /* the ⋯ menu of one row */
  let menu = null;
  function rowMenu(k, anchor) {
    const ref = T().refs().get(k);
    if (!ref) return;
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "omMenu"; menu.className = "menu tmenu";
      document.body.appendChild(menu);
      document.addEventListener("mousedown", e => { if (menu && !menu.contains(e.target) && !e.target.closest(".ommore")) menu.style.display = "none"; });
      menu.addEventListener("input", e => {
        if (e.target.dataset.op != null) { const [g, id] = menu.dataset.k.split("/"); LS().set(g, id, { opacity: e.target.value / 100 }); }
      });
      menu.addEventListener("click", e => {
        const a = e.target.closest("[data-m]"); if (!a) return;
        const [g, id] = menu.dataset.k.split("/");
        menu.style.display = "none";
        if (a.dataset.m === "zoom") T().zoomTo(g, id);
        else if (a.dataset.m === "solo") T().solo(g, id);
        else if (a.dataset.m === "find") findInCatalog(g, id);
      });
    }
    const r = LS().rec(ref.group, ref.id);
    const hasOp = !!(ref.row && ref.row.querySelector(".opac"));
    menu.dataset.k = k;
    menu.innerHTML = `<div class="ci hd">${esc(cleanLabel(r.label))}</div>` +
      (hasOp ? `<label class="omop">opacity <input type="range" min="0" max="100" value="${Math.round(r.opacity * 100)}" data-op="1"></label>` : "") +
      `<div class="ci" data-m="zoom">Zoom to</div>` +
      (ref.group !== "cultural" ? `<div class="ci" data-m="solo">Solo — only this in its group</div>` : "") +
      `<div class="ci" data-m="find">Find in the catalogue</div>`;
    SBMM.shell.closeMenus(menu);
    SBMM.shell.placeMenu(anchor, menu);
  }

  /* ------------------------------------------------------------------ */
  /* topics and views                                                    */
  /* ------------------------------------------------------------------ */
  const TOPICS = [
    ["base", "Imagery & terrain", "contours · slope · canopy · trees"],
    ["framework", "Site framework", "DUs · piles · storm · drainage"],
    ["design", "Residential design", "EA native · CAD · 14 sheets"],
    ["invest", "Investigations", "samples · borings · survey"],
    ["mywork", "My work", "drawings · measurements · water"],
    ["cultural", "Cultural", "protected · acknowledge first"]
  ];
  function paintTopics() {
    const el = document.getElementById("lpTopics");
    if (!el) return;
    let total = 0;
    const html = TOPICS.map(([g, name, sub]) => {
      const list = LS().list(g);
      const onN = list.filter(r => r.on).length;
      total += list.length;
      return `<button class="lptopic${g === "cultural" ? " gated" : ""}" data-topic="${g}">` +
        (g === "cultural" ? `<span class="lk">GATED</span>` : onN ? `<span class="tn mono">${onN}/${list.length}</span>` : `<span class="tn mono dim">${list.length}</span>`) +
        `<b>${esc(name)}</b><span>${esc(sub)}</span></button>`;
    }).join("");
    if (el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; }
    const n = document.getElementById("topicN");
    if (n) n.textContent = total + " layers";
  }
  const VIEW_WORD = {
    "Terrain": "the ground — hillshade, imagery, contours",
    "Design review": "EA geometry and the drawing set over the framework",
    "Water & drainage": "the storm network, the drainage map, your water work",
    "Investigations": "samples, datasets and the 2026 survey",
    "Field": "ground, imagery, the framework and your work",
    "Everything on": "every layer but the protected ones — heavy"
  };
  function paintViews() {
    const el = document.getElementById("lpViews");
    if (!el || !T().presetNames) return;
    const names = T().presetNames();
    const html = `<button class="lpview" data-view="@home"><b>Site overview</b><span>imagery and place names — the first-visit view</span></button>` +
      names.map(n => `<button class="lpview" data-view="${esc(n)}"><b>${esc(n)}</b><span>${esc(VIEW_WORD[n] || "saved view")}</span></button>`).join("");
    if (el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; }
  }

  /* ------------------------------------------------------------------ */
  /* the two faces                                                       */
  /* ------------------------------------------------------------------ */
  const pane = () => document.getElementById("layers");
  function field() { return document.body.classList.contains("field"); }
  function show(v, t) {
    const p = pane(); if (!p) return;
    view = field() ? "catalog" : (v || "home");
    topic = view === "catalog" ? (t || null) : null;
    p.classList.toggle("lpv-home", view === "home");
    p.classList.toggle("lpv-cat", view === "catalog");
    if (topic) p.dataset.topic = topic; else delete p.dataset.topic;
    const crumb = document.getElementById("lpCrumb");
    if (crumb) crumb.hidden = field() || view !== "catalog";
    const tt = document.getElementById("lpTopic");
    if (tt) {
      const T0 = TOPICS.find(x => x[0] === topic);
      tt.textContent = T0 ? T0[1] : "All layers";
    }
    const all = document.getElementById("lpAll");
    if (all) all.hidden = !topic;
    if (topic) {
      /* the topic's own section opens, whatever the tree remembered */
      const sec = p.querySelector(`.lsec[data-sec="${topic}"]`);
      if (sec && sec.classList.contains("closed")) { const h = sec.querySelector(".lsech"); if (h) h.click(); }
    }
    p.scrollTop = 0;
    if (view === "home") paint();
    if (SBMM.events) SBMM.events.emit("layerspanel", { view, topic });
  }
  function findInCatalog(g, id) {
    show("catalog", g);
    const ref = T().refs().get(g + "/" + id);
    if (!ref) return;
    const sub = ref.row.closest(".lgsub");
    if (sub && sub.classList.contains("closed")) { const h = sub.querySelector(".subtoggle"); if (h) h.click(); }
    requestAnimationFrame(() => {
      if (typeof scrollIntoPane === "function") scrollIntoPane(ref.row);
      ref.row.classList.add("lpflash");
      setTimeout(() => ref.row.classList.remove("lpflash"), 1600);
    });
  }

  let paintQ = false;
  function paint() {
    if (paintQ) return;
    paintQ = true;
    requestAnimationFrame(() => {
      paintQ = false;
      if (view !== "home" || field()) return;
      try { paintTiles(); paintOnMap(); paintTopics(); paintViews(); } catch (e) { console.error("layers panel", e); }
    });
  }

  function wire() {
    const p = pane(); if (!p) return;
    p.addEventListener("click", e => {
      const bm = e.target.closest("[data-bm]");
      if (bm) { e.preventDefault(); setBasemap(bm.dataset.bm); return; }
      const tp = e.target.closest("[data-topic]");
      if (tp && tp.classList.contains("lptopic")) { e.preventDefault(); show("catalog", tp.dataset.topic); return; }
      const vw = e.target.closest("[data-view]");
      if (vw) {
        e.preventDefault();
        if (vw.dataset.view === "@home") { if (SBMM.home) SBMM.home.applyDefaults(true); toast("view: site overview"); }
        else { T().applyPreset(vw.dataset.view); toast("view: " + vw.dataset.view); }
        paint(); return;
      }
      const om = e.target.closest(".omrow");
      if (om) {
        const a = e.target.closest("[data-a]");
        const ref = T().refs().get(om.dataset.k);
        if (!ref) return;
        e.preventDefault();
        if (a && a.dataset.a === "off") { ref.cb.click(); return; }
        if (a && a.dataset.a === "more") { rowMenu(om.dataset.k, a); return; }
        const [g, id] = om.dataset.k.split("/");
        T().zoomTo(g, id);
      }
    });
    const back = document.getElementById("lpBack");
    if (back) back.onclick = e => { e.preventDefault(); if (T().search) T().search(""); show("home"); };
    const all = document.getElementById("lpAll");
    if (all) all.onclick = e => { e.preventDefault(); show("catalog", null); };

    /* one search box for both faces: typing opens the catalogue on the hits,
       clearing it goes back to wherever it was */
    const inp = document.getElementById("ltSearch");
    if (inp) inp.addEventListener("input", () => {
      if (field()) return;
      if (inp.value.trim()) { if (view !== "catalog" || topic) { beforeSearch = beforeSearch || { view, topic }; show("catalog", null); } }
      else if (beforeSearch) { const b = beforeSearch; beforeSearch = null; show(b.view, b.topic); }
    });

    /* views: "save this view" names it inline, the v16 preset store keeps it */
    const sv = document.getElementById("lpSaveView"), nm = document.getElementById("lpViewName");
    if (sv && nm) {
      sv.onclick = e => { e.preventDefault(); nm.hidden = false; nm.value = ""; nm.focus(); };
      nm.onkeydown = e => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); const v = nm.value.trim(); nm.hidden = true; if (v) T().savePreset(v); paint(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); nm.hidden = true; }
      };
      nm.onblur = () => { nm.hidden = true; };
    }

    SBMM.events.on("layers", paint);
    SBMM.events.on("field", () => show(field() ? "catalog" : "home"));
    show(field() ? "catalog" : "home");
  }

  return { wire, show, view: () => view, topic: () => topic, setBasemap, basemap: currentBasemap,
           onMap: () => onRefs().map(o => o.g + "/" + o.r.id), findInCatalog, paint };
})();
