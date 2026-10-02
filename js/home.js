/* SBMM Site Explorer — the first thirty seconds (v26, docs/V26_UI_AUDIT.md §4).
   ---------------------------------------------------------------------------
   Four things, all about what the app looks like when it opens:

   1. THE FIRST-VISIT LAYERS. The engineer's ruling (2026-09-27): the 1.5-ft
      site aerial ON, the 6-in mine-area aerial ON (with the 3-in ABP crop that
      sits inside it — one seamless image, finest wins); decision units, piles,
      borings, the limits of excavation and "my work" OFF. Everything else was
      already off, or is switched off here. Applied ONCE per browser (the
      `defaults` stamp in sbmm.home.v1), and from then on the remembered layer
      state wins, exactly as it always has.
      "My work … can be turned off as well, unless the user wants it on": a
      class row that is off comes back on by itself the moment the user makes
      something in it — a measurement drawn into a hidden class is a silent
      failure, and this app does not do those.

   2. THE WELCOME CARD. The site in one line, four numbers, "pick up where you
      left off", six ways in and the open items. Shown on the first visit of
      each day, gone the moment anything is done, back from the brand button
      or H. The choice (daily / every start / never) is in the card itself.

   3. PLACE NAMES. A map with no names is a picture: Clear Lake, the Herman
      Impoundment, the ponds, the operable units, the repository, the lots and
      the piles, from the payloads' own names, through SBMM.labels so they give
      way to every analytic label.

   4. OPEN ITEMS. The assumptions the app already tracks and the engineer has
      to resolve — the provisional rainfall, the boring contacts that disagree,
      the storm inverts nobody has surveyed — as a chip in the top bar, with
      the recent messages under them.
   --------------------------------------------------------------------------- */
"use strict";

SBMM.home = (function () {
  const KEY = "sbmm.home.v1";
  const day = () => { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };

  function read() {
    try { const o = JSON.parse(localStorage.getItem(KEY) || "null"); return o && typeof o === "object" ? o : {}; }
    catch (e) { return {}; }
  }
  function write(o) { try { localStorage.setItem(KEY, JSON.stringify(Object.assign(read(), o))); } catch (e) {} }

  /* ------------------------------------------------------------------ */
  /* 1. the first-visit layers                                           */
  /* ------------------------------------------------------------------ */
  /* The rule is a function of (group, id): true = on, false = off, and the
     cultural group is never touched — it is off at every start by design and
     only its acknowledgement may turn it on. */
  const CURATED_ON = new Set([
    "base/ortho_site_1_5_ft", "base/ortho_mine_area_6_in", "base/ortho_abp_3_in", "base/place_names"
  ]);
  /* rows left exactly as they are: the 3D sheet-drape master is a switch about
     HOW a sheet is shown when one is asked for, not a layer on the map */
  const CURATED_KEEP = new Set(["design/sheets3d"]);
  function curated(g, id) {
    if (g === "cultural") return null;
    const k = g + "/" + id;
    if (CURATED_KEEP.has(k)) return null;
    return CURATED_ON.has(k);
  }
  function applyDefaults(force) {
    const st = read();
    if (st.defaults && !force) return false;
    const LS = SBMM.layerState;
    const list = [];
    for (const g of LS.groupList()) for (const r of g.layers.values()) {
      const want = curated(g.id, r.id);
      if (want == null || r.on === want) continue;
      list.push({ group: g.id, layer: r.id, on: want });
    }
    if (list.length) LS.batch(list);
    write({ defaults: 1 });
    return true;
  }

  /* my work comes back on for the thing the user just made */
  let known = null;
  function watchMyWork() {
    known = new Set(SBMM.store.features.map(f => f.id));
    SBMM.store.onChange(() => {
      const LS = SBMM.layerState;
      for (const f of SBMM.store.features) {
        if (known.has(f.id)) continue;
        known.add(f.id);
        if (f.props && f.props.ref) continue;
        const cls = SBMM.myWork && SBMM.myWork.classOf ? SBMM.myWork.classOf(f) : null;
        if (cls && LS.rec("mywork", cls) && !LS.isOn("mywork", cls)) LS.set("mywork", cls, { on: true });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 3. place names                                                      */
  /* ------------------------------------------------------------------ */
  function ringCentroid(ring) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const c = x0 * y1 - x1 * y0;
      a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    if (Math.abs(a) < 1e-6) { const p = ring[0]; return [p[0], p[1]]; }
    return [cx / (3 * a), cy / (3 * a)];
  }
  function ringArea(ring) {
    let a = 0;
    for (let i = 0, n = ring.length - 1; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(a / 2);
  }
  function pointIn(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  /* a label point INSIDE the ring: the centroid when it is inside, else the
     midpoint of the widest horizontal chord through the centroid's row */
  function labelPoint(ring) {
    const c = ringCentroid(ring);
    if (pointIn(c[0], c[1], ring)) return c;
    const y = c[1], xs = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      if ((y0 > y) !== (y1 > y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    let best = null, w = -1;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > w) { w = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    return best || c;
  }
  /* The one exception to "centroid": Clear Lake's polygon is the whole lake,
     and its centroid is miles off the survey. Its name goes where the lake
     meets the site — the ring's vertex nearest the site's own centre, pulled
     500 ft out into the water. */
  function lakePoint(ring) {
    const dem = SBMM.demSite && SBMM.demSite.m;
    if (!dem) return labelPoint(ring);
    const sx = dem.x0 + dem.w * dem.cell / 2, sy = dem.y0 + dem.h * dem.cell / 2;
    let best = null, d = Infinity;
    for (const p of ring) { const q = (p[0] - sx) ** 2 + (p[1] - sy) ** 2; if (q < d) { d = q; best = p; } }
    if (!best) return labelPoint(ring);
    const L = Math.sqrt(d) || 1;
    const out = [best[0] + (best[0] - sx) / L * 500, best[1] + (best[1] - sy) / L * 500];
    return pointIn(out[0], out[1], ring) ? out : best;
  }

  function placeSpecs() {
    const D = window.SBMM_DATA || {};
    const out = [];
    const gis = (D.design_gis && D.design_gis.features) || [];
    const byName = new Map();
    for (const f of gis) {
      const p = f.properties || {};
      if (!p.name || /^Unnamed/.test(p.name)) continue;
      if (!["water", "ou", "repo"].includes(p.layer)) continue;
      const g = f.geometry;
      const rings = !g ? [] : g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map(q => q[0]) : [];
      if (!rings.length) continue;
      const k = p.layer + "|" + p.name;
      const big = rings.reduce((a, r) => ringArea(r) > ringArea(a) ? r : a, rings[0]);
      const prev = byName.get(k);
      if (!prev || ringArea(big) > ringArea(prev.ring)) byName.set(k, { layer: p.layer, name: p.name, ring: big });
    }
    for (const v of byName.values()) {
      const lake = v.name === "Clear Lake";
      const pt = lake ? lakePoint(v.ring) : labelPoint(v.ring);
      const area = ringArea(v.ring);
      let name = v.name;
      if (v.layer === "ou" && v.name === "OU-1") name = "Mine area · OU-1";
      out.push({ name, x: pt[0], y: pt[1], cls: lake ? "lake" : v.layer === "water" ? "water" : "area",
                 pri: lake ? 22 : v.layer === "water" ? 18 : 14, minFt: lake ? 0 : Math.sqrt(area) });
    }
    /* the residential lots as one name, at the middle of the lots themselves
       (the bounding box of the limits of excavation falls in the lake: the
       lots sit in an L round the shore) */
    const lots = gis.filter(f => (f.properties || {}).layer === "lots" && f.geometry && f.geometry.type === "Polygon");
    const nExc = gis.filter(f => (f.properties || {}).layer === "exc").length;
    if (lots.length) {
      const cs = lots.map(f => ringCentroid(f.geometry.coordinates[0]));
      const mx = cs.reduce((a, c) => a + c[0], 0) / cs.length, my = cs.reduce((a, c) => a + c[1], 0) / cs.length;
      /* the lot centroid nearest that mean, so the name sits on a lot */
      const at = cs.reduce((a, c) => ((c[0] - mx) ** 2 + (c[1] - my) ** 2 < (a[0] - mx) ** 2 + (a[1] - my) ** 2 ? c : a), cs[0]);
      out.push({ name: "Residential lots", sub: nExc ? nExc + " excavation limits" : "", x: at[0], y: at[1],
                 cls: "area", pri: 16, minFt: 0, maxZoom: 1 });
    }
    /* the traced piles, named, once they are big enough to read */
    for (const p of (D.piles || [])) {
      if (!p.name || !/Pile \d/.test(p.name) || !p.ring) continue;
      const pt = labelPoint(p.ring);
      out.push({ name: p.name.replace(/\s*\(Fig 2\)/, ""), x: pt[0], y: pt[1], cls: "pile", pri: 12, minFt: Math.sqrt(ringArea(p.ring)) });
    }
    return out;
  }

  let placeLayer = null, placeRecs = [];
  function buildPlaces() {
    if (!SBMM.map || !window.L) return;
    if (!SBMM.map.getPane("placelbl")) {
      const p = SBMM.map.createPane("placelbl");
      p.style.zIndex = 585; p.style.pointerEvents = "none";
    }
    placeLayer = L.layerGroup();
    const specs = placeSpecs();
    for (const s of specs) {
      const html = `<span class="plname ${s.cls}">${esc(s.name)}${s.sub ? `<small>${esc(s.sub)}</small>` : ""}</span>`;
      const m = L.marker([s.y, s.x], { pane: "placelbl", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "plicon", html, iconSize: [0, 0] }) });
      m._sbmmPlace = s;
      placeLayer.addLayer(m);
    }
    placeLayer.on("add", registerPlaces);
    placeLayer.on("remove", () => { if (SBMM.labels) SBMM.labels.removeOwner("places"); });
    /* off by the code's default and ON by the first-visit ruling above: the
       rows' own defaults are what every harness boots with (test/gate.mjs
       marks the first visit done), and the curated view is what a person gets */
    SBMM.addLayerRow("base", "Place names", placeLayer, { id: "place_names", checked: false, swatch: "#EAF1F4" });
  }
  function registerPlaces() {
    if (!SBMM.labels || !placeLayer) return;
    SBMM.labels.removeOwner("places");
    placeLayer.eachLayer(m => {
      const s = m._sbmmPlace;
      SBMM.labels.add({ key: "place:" + s.name, priority: s.pri, marker: m, owner: "places",
        /* a name is drawn once the thing it names is at least ~40 px across
           (the lake, always), and a site-wide name goes when you are close */
        gate: () => {
          const z = SBMM.map.getZoom(), ppf = Math.pow(2, z);
          if (s.maxZoom != null && z > s.maxZoom) return false;
          return !s.minFt || s.minFt * ppf >= 40;
        } });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 4. open items                                                       */
  /* ------------------------------------------------------------------ */
  /* Each one is a fact the app already holds, phrased as what is missing. */
  function openItems() {
    const out = [];
    const D = window.SBMM_DATA || {};
    if (D.rainfall && D.rainfall.provisional)
      out.push({ sev: "warn", text: "Rainfall depths are provisional", sub: "NOAA Atlas 14 export not loaded — the design storm uses planning depths",
                 act: () => SBMM.cmd.run("RAIN") });
    const BL = SBMM.borelogs;
    if (BL && BL.has && BL.has() && BL.disagreeCount) {
      const n = BL.disagreeCount();
      if (n) out.push({ sev: "warn", text: `${n} of ${BL.holes().length} borings: the two contact statements differ`,
                        sub: "the logger's remark and the strata rows — reconcile on the LOGS sheet", act: () => SBMM.cmd.run("LOGS") });
    }
    const sn = D.storm_network;
    if (sn && sn.nodes) {
      const inv = sn.nodes.filter(n => n.invert_ft != null).length;
      const nC = (sn.conduits || []).length;
      out.push({ sev: "info", text: `Pipe capacity: no conduit rated yet`,
                 sub: `${inv} of ${sn.nodes.length} structures have a surveyed invert · ${nC} conduits wait on the invert survey`,
                 act: () => { if (SBMM.pipes && SBMM.pipes.card) SBMM.pipes.card(); else SBMM.cmd.run("PIPES"); } });
    }
    const sheets = D.sheets_full && D.sheets_full.sheets;
    if (sheets) {
      const un = sheets.filter(s => /^C-1/.test(s.sheet) && !s.affine).map(s => s.sheet);
      if (un.length) out.push({ sev: "info", text: `${un.join(", ")} is not placed on the map`, sub: "no native geometry or printed nodes to register it with",
                                act: () => SBMM.cmd.run("SHEETS") });
    }
    return out;
  }
  /* v33: the top-bar "open items" chip is gone (the engineer: "not sure what the
     purpose of it is"); openItems() still feeds the first-visit card */
  function paintChip() {}

  /* ------------------------------------------------------------------ */
  /* 2. the welcome card                                                 */
  /* ------------------------------------------------------------------ */
  const ICON = {
    log: '<rect x="5" y="2" width="8" height="14" rx="1.5"/><path d="M5 7h8M5 11h8"/>',
    vol: '<path d="M2 14 7 5l3 5 2-3 4 7z"/>',
    drop: '<path d="M9 2.5s-5 5.3-5 8.6a5 5 0 0 0 10 0C14 7.8 9 2.5 9 2.5z"/>',
    sheet: '<path d="M4 2.5h7l3 3v10H4z M11 2.5v3h3"/>',
    cube: '<path d="M9 2 15.5 5.7v6.6L9 16 2.5 12.3V5.7zM2.5 5.7 9 9.4l6.5-3.7M9 9.4V16"/>',
    fence: '<path d="M2 12 7 6l4 3 5-5"/><path d="M2 15h14"/>',
    ruler: '<path d="M2 11 11 2l3 3-9 9zM5 8l1.5 1.5M7 6l1.5 1.5M9 4l1.5 1.5"/>',
    pen: '<path d="M2.5 13.5 3 10.8 10.8 3a1.5 1.5 0 0 1 2.2 2.2L5.2 13z"/>',
    pin: '<path d="M9 1.8c-2.6 0-4.6 2-4.6 4.5C4.4 9.7 9 16 9 16s4.6-6.3 4.6-9.7C13.6 3.8 11.6 1.8 9 1.8z"/>'
  };
  const svg = (k, s) => `<svg viewBox="0 0 18 18" width="${s || 16}" height="${s || 16}">${ICON[k] || ICON.pin}</svg>`;

  let card = null, dismissedAt = 0;
  function stats() {
    const D = window.SBMM_DATA || {};
    let acres = null;
    if (SBMM.drainage && SBMM.drainage.siteAcres) acres = SBMM.drainage.siteAcres();
    if (acres == null && SBMM.demSite && SBMM.demSite.z) {
      /* the surveyed ground: every 2-ft cell with data (counted once, cached) */
      if (stats.acres == null) {
        const z = SBMM.demSite.z, c = SBMM.demSite.m.cell;
        let n = 0; for (let i = 0; i < z.length; i++) if (z[i] === z[i]) n++;
        stats.acres = n * c * c / 43560;
      }
      acres = stats.acres;
    }
    const exc = ((D.design_gis && D.design_gis.features) || []).filter(f => (f.properties || {}).layer === "exc").length;
    return [
      [acres != null ? Math.round(acres).toLocaleString() : "—", "acres surveyed"],
      [SBMM.borelogs && SBMM.borelogs.has && SBMM.borelogs.has() ? SBMM.borelogs.holes().length : "—", "borings"],
      [(D.points || []).filter(p => p.sampled !== false).length || "—", "sampled locations"],
      [exc || "—", "excavation limits"]
    ];
  }
  function recent() {
    const fs = SBMM.store.features.filter(f => !(f.props && f.props.ref));
    return fs.slice(-3).reverse();
  }
  function sumOf(f) {
    const p = f.props || {};
    if (f.type === "volume" && p.fill_yd3 != null) return `${fmt0(p.fill_yd3)} yd³ fill` + (p.net_yd3 != null ? ` · ${fmt0(p.net_yd3)} net` : "");
    if (f.type === "area" && p.area_ft2 != null) return `${fmt0(p.area_ft2)} ft² · ${fmt(p.area_ft2 / 43560, 2)} ac`;
    if (f.type === "line" && p.length_ft != null) return `${fmt0(p.length_ft)} ft`;
    if (f.type === "flow" && p.length_ft != null) return `raindrop · ${fmt0(p.length_ft)} ft overland`;
    if (f.type === "fence") return `fence · ${fmt0(p.length_ft || 0)} ft · ${p.n_holes || 0} holes`;
    return f.type;
  }
  const iconFor = f => f.type === "volume" ? "vol" : f.type === "flow" ? "drop" : f.type === "fence" ? "fence"
    : (f.type === "line" || f.type === "area") ? "ruler" : "pen";

  function buildCard() {
    const el = document.createElement("aside");
    el.id = "homeCard";
    el.className = "glass";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Welcome");
    document.body.appendChild(el);
    el.addEventListener("click", onCardClick);
    el.addEventListener("change", e => {
      if (e.target.id === "homeFreq") { write({ freq: e.target.value }); toast("welcome card: " + e.target.selectedOptions[0].textContent); }
    });
    return el;
  }
  function paintCard() {
    const wd = new Date().toLocaleDateString(undefined, { weekday: "long" });
    const st = stats();
    const rec = recent();
    const items = openItems();
    const freq = read().freq || "daily";
    const T = [
      ["log", "Boring logs", (SBMM.borelogs && SBMM.borelogs.has && SBMM.borelogs.has()) ? SBMM.borelogs.holes().length + " holes" : "the 2025 logs", "LOGWIN"],
      ["sheet", "Sheets", "20 drawings", "SHEETS"],
      ["vol", "Volume", "vs any surface", "@volume"],
      ["drop", "Water", "where it goes", "WHEREWATER"],
      ["fence", "Fence", "through borings", "FENCE"],
      ["cube", "Fly the site", "20 s in 3D", "@fly"]
    ];
    card.innerHTML =
      `<button class="hclose" data-h="close" title="Close (Esc)" aria-label="Close">×</button>` +
      `<div class="hero"><div class="k">${esc(wd)} · OU1 workbench</div>` +
      `<h1>Sulphur Bank Mercury Mine</h1>` +
      `<p>Lidar Jan 2024 · EA Final design 2025 · 2025 borings · Aug 2026 survey</p></div>` +
      `<div class="hstats">${st.map(s => `<div><b class="mono">${esc(String(s[0]))}</b><span>${esc(s[1])}</span></div>`).join("")}</div>` +
      (rec.length ? `<div class="hblk"><h3>Pick up where you left off</h3>` +
        rec.map(f => `<button class="hcont" data-f="${esc(f.id)}"><span class="hic">${svg(iconFor(f))}</span>` +
          `<span><b>${esc(f.name || f.type)}</b><small class="mono">${esc(sumOf(f))}</small></span></button>`).join("") + `</div>` : "") +
      `<div class="hblk"><h3>Start</h3></div>` +
      `<div class="hquick">${T.map(t => `<button class="hq" data-go="${t[3]}">${svg(t[0], 18)}<b>${esc(t[1])}</b><span>${esc(t[2])}</span></button>`).join("")}</div>` +
      (items.length ? `<div class="htodo"><h3>Open items</h3>` +
        items.map((it, i) => `<button class="htd" data-oi="${i}"><i class="${it.sev}"></i><span>${esc(it.text)}</span></button>`).join("") + `</div>` : "") +
      `<div class="hfoot"><span><kbd>Ctrl K</kbd> search anything</span>` +
      `<label>show <select id="homeFreq" aria-label="When to show this card">` +
      [["daily", "first visit each day"], ["always", "every start"], ["never", "only from the logo"]]
        .map(o => `<option value="${o[0]}"${o[0] === freq ? " selected" : ""}>${o[1]}</option>`).join("") +
      `</select></label></div>`;
  }
  function onCardClick(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.h === "close") { hide(); return; }
    if (t.dataset.f) {
      const f = SBMM.store.byId(t.dataset.f);
      hide();
      if (!f) return;
      const cls = SBMM.myWork && SBMM.myWork.classOf ? SBMM.myWork.classOf(f) : null;
      if (cls && !SBMM.layerState.isOn("mywork", cls)) SBMM.layerState.set("mywork", cls, { on: true });
      SBMM.store.select(f.id);
      if (SBMM.tools && SBMM.tools.zoomTo) SBMM.tools.zoomTo(f);
      return;
    }
    if (t.dataset.oi != null) { hide(); const it = openItems()[+t.dataset.oi]; if (it && it.act) it.act(); return; }
    const go = t.dataset.go;
    if (!go) return;
    hide();
    if (go === "@volume") { SBMM.mode.set("volume"); return; }
    if (go === "@fly") { flySite(); return; }
    SBMM.cmd.run(go);
  }
  function flySite() {
    if (SBMM.viewer3d && SBMM.viewer3d.flyAround) { SBMM.viewer3d.flyAround(); return; }
    if (SBMM.viewer3d && !SBMM.viewer3d.isOpen()) SBMM.viewer3d.toggle();
  }
  function show(opts) {
    const o = opts || {};
    if (document.body.classList.contains("field")) return;
    if (!card) card = buildCard();
    paintCard();
    card.classList.add("on");
    document.body.classList.add("homeopen");
    if (o.frame && SBMM.layersUI && SBMM.layersUI.flyTo) SBMM.layersUI.flyTo("site");
  }
  function hide() {
    if (!card || !card.classList.contains("on")) return;
    card.classList.remove("on");
    document.body.classList.remove("homeopen");
    dismissedAt = Date.now();
  }
  const isOpen = () => !!(card && card.classList.contains("on"));
  function shouldShow() {
    const st = read();
    const freq = st.freq || "daily";
    if (freq === "never") return false;
    if (freq === "always") return true;
    return st.welcome !== day();
  }

  /* "gone the moment anything is done": a tool, a click on the map, a 3D
     view, a drag — anything but the card itself */
  function wireDismiss() {
    SBMM.events.on("mode", ({ to }) => { if (to && to !== "navigate") hide(); });
    SBMM.events.on("view", ({ open }) => { if (open) hide(); });
    const map = document.getElementById("map");
    if (map) {
      map.addEventListener("pointerdown", hide, { passive: true });
      map.addEventListener("wheel", hide, { passive: true });
    }
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && isOpen()) { e.stopPropagation(); hide(); return; }
      if (e.key === "h" || e.key === "H") {
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (t && t.closest && t.closest(".shwin, .modal, #help")) return;
        if (isOpen()) hide(); else show();
      }
    }, true);
  }

  /* ------------------------------------------------------------------ */
  /* the Undo that rides on a destructive action's message (§7)          */
  /* ------------------------------------------------------------------ */
  let undoPill = null, undoT = 0;
  function wireUndoPill() {
    if (!SBMM.undo || !SBMM.undo.onChange) return;
    let lastUndo = null;
    SBMM.undo.onChange(() => {
      const l = SBMM.undo.labels();
      const u = l.undo || null;
      if (u && u !== lastUndo && /^(delete|erase|remove|clear)/i.test(u)) offerUndo(u);
      lastUndo = u;
    });
  }
  function offerUndo(label) {
    if (document.body.classList.contains("field")) return;
    if (!undoPill) {
      undoPill = document.createElement("div");
      undoPill.id = "undoPill";
      undoPill.setAttribute("role", "status");
      undoPill.setAttribute("aria-live", "polite");
      document.body.appendChild(undoPill);
      undoPill.addEventListener("click", e => {
        if (e.target.closest("[data-u]")) { SBMM.undo.pop(); undoPill.classList.remove("show"); }
        if (e.target.closest("[data-x]")) undoPill.classList.remove("show");
      });
    }
    undoPill.innerHTML = `<span>${esc(label.charAt(0).toUpperCase() + label.slice(1))}</span>` +
      `<button data-u="1">Undo</button><button data-x="1" aria-label="Dismiss">×</button>`;
    undoPill.classList.add("show");
    clearTimeout(undoT);
    undoT = setTimeout(() => undoPill.classList.remove("show"), 7000);
  }

  /* ------------------------------------------------------------------ */
  function build() {
    buildPlaces();
  }
  function wire() {
    applyDefaults();
    watchMyWork();
    wireDismiss();
    wireUndoPill();
  }
  /* after the loader hides: the card is the first thing the eye lands on,
     and it must not be painted under the loader */
  function start() {
    if (shouldShow()) { show(); write({ welcome: day() }); }
  }

  return { build, wire, start, show, hide, isOpen, applyDefaults, openItems, curated,
           placeNames: () => placeSpecs().map(s => s.name), paintChip, offerUndo };
})();
