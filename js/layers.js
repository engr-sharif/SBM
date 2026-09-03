/* SBMM Site Explorer — project data layers (basemaps, contours, DUs, piles, samples) */
"use strict";

SBMM.layers = {};

/* Zoom at which the minor (2-ft) contour set becomes readable. Leaflet zoom z
   means 2^z screen pixels per survey foot, so z = -1 is 1 px per 2 ft — about
   1" = 200 ft on screen. Below that the 2-ft set is a wash. */
const MINOR_CONTOUR_ZOOM = -1;

/* Keep a layer OFF the map while the view is zoomed further out than `minZoom`,
   without touching its state: the row stays checked, the row explains itself,
   and the geometry comes back the moment the map is close enough (F2).

   The gate re-reads SBMM.layerState rather than remembering, so a user who
   switches the layer off while it is gated does not get it back on zoom-in. */
SBMM.zoomGate = function (row, layer, minZoom, why) {
  if (!row || !layer) return;
  const apply = () => {
    const on = SBMM.layerState.isOn(row.group, row.id);
    const near = SBMM.map.getZoom() >= minZoom;
    if (on && near) { if (!SBMM.map.hasLayer(layer)) layer.addTo(SBMM.map); }
    else if (SBMM.map.hasLayer(layer)) SBMM.map.removeLayer(layer);
    row.row.classList.toggle("gated", on && !near);
    row.row.title = on && !near ? why : (row.row.dataset.baseTitle || "");
  };
  row.row.dataset.baseTitle = row.row.title || "";
  SBMM.map.on("zoomend", apply);
  SBMM.events.on("layers", e => { if (!e.group || (e.group === row.group && (!e.layer || e.layer === row.id))) apply(); });
  apply();
};

SBMM.buildLayers = function () {
  const map = SBMM.map;
  const bS = SBMM.demSite.bounds(), bA = SBMM.demAbp.bounds();

  /* ---------- basemaps ---------- */
  SBMM.addLayerRow("base", "Hillshade — site", L.imageOverlay(SBMM_DATA.hs_site_jpg || SBMM_DATA.hs_site_png, bS, { pane: "raster", opacity: 1 }), { opacity: 1 });
  SBMM.addLayerRow("base", "Hillshade — mine area (1 ft)", L.imageOverlay(SBMM_DATA.hs_abp_jpg || SBMM_DATA.hs_abp_png, bA, { pane: "raster", opacity: 1 }), { opacity: 1 });
  /* the three orthophotos share the raster pane, so give them explicit z-order —
     finest imagery on top — instead of letting DOM insertion order decide */
  if (SBMM_DATA.ortho_abp && SBMM_DATA.ortho_abp_jpg) {
    const ob = SBMM_DATA.ortho_abp;
    SBMM.layers.orthoAbp = L.imageOverlay(SBMM_DATA.ortho_abp_jpg, [[ob.y0, ob.x0], [ob.y1, ob.x1]], { pane: "raster", opacity: .9, zIndex: 3 });
    SBMM.addLayerRow("base", "Ortho — ABP (3 in)", SBMM.layers.orthoAbp, { checked: true, opacity: .9 });
  }
  if (SBMM_DATA.ortho_mine && SBMM_DATA.ortho_mine.x0 && SBMM_DATA.ortho_mine_jpg) {
    const ob = SBMM_DATA.ortho_mine;
    SBMM.layers.orthoMine = L.imageOverlay(SBMM_DATA.ortho_mine_jpg, [[ob.y0, ob.x0], [ob.y1, ob.x1]], { pane: "raster", opacity: .9, zIndex: 2 });
    SBMM.addLayerRow("base", "Ortho — mine area (6 in)", SBMM.layers.orthoMine, { checked: true, opacity: .9 });
  }
  if (SBMM_DATA.ortho_site && SBMM_DATA.ortho_site.x0 && SBMM_DATA.ortho_site_jpg) {
    const ob = SBMM_DATA.ortho_site;
    SBMM.layers.orthoSite = L.imageOverlay(SBMM_DATA.ortho_site_jpg, [[ob.y0, ob.x0], [ob.y1, ob.x1]], { pane: "raster", opacity: .9, zIndex: 1 });
    SBMM.addLayerRow("base", "Ortho — site (1.5 ft)", SBMM.layers.orthoSite, { checked: false, opacity: .9 });
  }

  /* The survey contours run out over Clear Lake and around the survey's own data
     boundary, where the app has no terrain at all: 7,627 of the 10-ft site set's
     38,414 vertices (20 %) sit on DEM NoData, and the polylines that close
     around the boundary carry straight CHORDS — the longest 4,766 ft — from
     where they left the terrain back to where they re-entered. In the default
     residential view that shows up as a fan of thin grey diagonals across open
     water, reading as survey or alignment lines.

     A contour at z lies ON the ground at z, so both tests are exact rather than
     length heuristics:
       1. a vertex with no terrain under it is not a contour vertex — drop it,
          and break the run there;
       2. within a run, break at any segment over 60 ft whose MIDPOINT is over
          NoData (that is the closing chord: both ends are on the shore).
     Over the shipped data that leaves 451 polylines from 290 originals and
     30,701 of the 38,414 vertices — fewer objects than the chord rule alone
     produced (2,146), because most of what it was cutting up was lake — and it
     keeps every real segment; the longest survivor is 387 ft with a midpoint
     elevation of 1,329.9 ft against a contour level of 1,330.

     Display only — `data/contours_site.json` is untouched and nothing measures
     off these. The 3D contour drape in js/viewer3d.js has done the equivalent
     since v8 (`BRIDGE_FT` / `TOL_FT`); it drops the segment, this splits the
     polyline, because in 2D the tooltip and the hit target belong to the run. */
  const CHORD_MIN_FT = 60;
  function splitOverNodata(pts) {
    const runs = [];
    let cur = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (isNaN(SBMM.elev(p[0], p[1])[0])) {   // no ground here: not a contour vertex
        if (cur) { runs.push(cur); cur = null; }
        continue;
      }
      if (cur) {
        const a = cur[cur.length - 1];
        const d = Math.hypot(p[0] - a[0], p[1] - a[1]);
        if (d > CHORD_MIN_FT && isNaN(SBMM.elev((a[0] + p[0]) / 2, (a[1] + p[1]) / 2)[0])) {
          runs.push(cur); cur = [p]; continue;
        }
      } else cur = [];
      cur.push(p);
    }
    if (cur) runs.push(cur);
    return runs;
  }

  /* ---------- survey contours ----------
     Section 4: "Contours (lidar, major …; minor auto-hide by zoom)". The site
     set at 10 ft IS the major set and is on by default; the 2-ft ABP set is
     the minor one and is off by default AND zoom-gated, because 2-ft contours
     over the whole mine window at site zoom are a grey wash that hides the
     imagery underneath them (F2).

     "Gated" means the layer stays in the user's control — switching it on is
     honoured — but it only *draws* once the map is zoomed in far enough to
     read it, and the row says so while it is waiting. */
  for (const [key, label, color, on] of [
    ["contours_site", "Contours — 10 ft (site)", "#6E8593", true],
    ["contours_abp", "Contours — 2 ft (ABP)", "#87A9B8", false]]) {
    const data = SBMM_DATA[key];
    const grp = L.layerGroup();
    for (const [lv, pts] of data) {
      const heavy = lv % (key.includes("site") ? 50 : 10) === 0;
      for (const run of splitOverNodata(pts)) {
        if (run.length < 2) continue;
        L.polyline(run.map(p => [p[1], p[0]]), { pane: "vectors", color, weight: heavy ? 1.5 : .7, opacity: heavy ? .85 : .5, interactive: true })
          .bindTooltip(`${lv} ft`, { sticky: true, className: "ctip" }).addTo(grp);
      }
    }
    /* explicit ids: the 3D contour drape keys off these two entries */
    const row = SBMM.addLayerRow("terr", label, grp, { id: key, checked: on, swatch: color });
    if (key === "contours_abp") SBMM.zoomGate(row, grp, MINOR_CONTOUR_ZOOM,
      "2-ft contours appear when you zoom in past 1\" = 100 ft");
  }

  /* ---------- decision units ---------- */
  const DU_COLOR = { "DU-1N": "#E4796A", "DU-1S": "#E4796A", "DU-2": "#5B8FF9", "DU-3": "#4FCE9B" };
  const duGrp = L.layerGroup();
  for (const d of SBMM_DATA.dus) {
    const c = DU_COLOR[d.name] || "#ccc";
    const rings = [d.ring.map(p => [p[1], p[0]]), ...(d.holes || []).map(h => h.map(p => [p[1], p[0]]))];
    const poly = L.polygon(rings, { pane: "vectors", color: c, weight: 2, fillColor: c, fillOpacity: .14 })
      .bindTooltip(d.name, { sticky: true, className: "ctip" }).addTo(duGrp);
    poly.on("click", () => {
      const A = polyArea(d.ring);
      poly.bindPopup(`<b>${esc(d.name)}</b><br>${fmt(A / 43560, 2)} ac · ${fmt0(A)} ft²
        <div class="pop-actions"><span class="minib" onclick="SBMM.tools.volumeOfRing('${esc(d.name)}')">volume vs. perimeter TIN</span></div>`).openPopup();
    });
  }
  SBMM.addLayerRow("proj", "Decision units (rev7)", duGrp, { id: "dus", checked: true, swatch: "#E4796A" });
  SBMM.layers.duGrp = duGrp;

  /* ---------- waste piles ---------- */
  const pileGrp = L.layerGroup();
  SBMM.pileIndex = [];  // for presets: {label, ring, props}
  for (const p of SBMM_DATA.piles) {
    const traced = (p.name || "").includes("Fig 2");
    const label = p.name || (p.props ? `${p.props.pile} — part ${p.props.part} (topo)` : "pile");
    if (!traced) SBMM.pileIndex.push({ label, ring: p.ring, props: p.props || {} });
    const poly = L.polygon(p.ring.map(q => [q[1], q[0]]),
      { pane: "vectors", color: traced ? "#E8B34B" : "#8BE04B", weight: traced ? 1.5 : 2, dashArray: traced ? "5 4" : null, fill: true, fillOpacity: 0.001 })
      .bindTooltip(label + (p.props && p.props.pile_vol_yd3_best ? ` · best ${fmt0(p.props.pile_vol_yd3_best)} yd³ (whole pile)` : ""),
        { sticky: true, className: "ctip" }).addTo(pileGrp);
    const idx = traced ? -1 : SBMM.pileIndex.length - 1;
    poly.on("click", () => {
      const pr = p.props || {};
      let html = `<b>${esc(label)}</b>`;
      if (pr.pile_vol_yd3_best) html += `<br>whole-pile best ${fmt0(pr.pile_vol_yd3_best)} yd³ (${fmt0(pr.pile_vol_yd3_low)}–${fmt0(pr.pile_vol_yd3_high)})<br>
        footprint ${pr.pile_footprint_area_ac} ac · mean ${pr.pile_mean_height_ft} ft · max ${pr.pile_max_height_ft} ft`;
      html += `<div class="pop-actions"><span class="minib" onclick="SBMM.tools.volumeOfPile(${idx >= 0 ? idx : `'${esc(p.name || "")}'`})">measure volume now</span></div>`;
      poly.bindPopup(html).openPopup();
    });
    if (traced) poly._tracedRing = p.ring, poly._tracedName = p.name;
  }
  SBMM.layers.pileGrp = pileGrp;
  SBMM.tracedPiles = SBMM_DATA.piles.filter(p => (p.name || "").includes("Fig 2"));
  SBMM.addLayerRow("proj", "Waste piles (topo / Fig-2)", pileGrp, { id: "piles", checked: true, swatch: "#8BE04B" });

  /* ---------- sample points ----------
     Investigations (§4 group 4), not Site framework: a sample result is a
     measurement of the ground, not part of the ground. */
  SBMM.samples = SBMM_DATA.points.filter(p => p.sampled);
  SBMM.layers.ptGrp = L.layerGroup();
  SBMM.symbolizePoints("exc");   // default symbology
  /* Off by default (section 4, F2): 140 filled circles over the mine area is
     the loudest thing on the map and it is a *result*, not the ground — you
     ask for it when you are asking about chemistry. The Samples table (T) and
     the symbology control both switch it on. */
  SBMM.addLayerRow("invest", `Sample results (${SBMM.samples.length})`, SBMM.layers.ptGrp,
    { id: "samples", checked: false, swatch: "#5FBF8F" });

  /* ---------- EA residential cleanup Final Design ----------
     Order is the reading order of the group (planner ruling D2b): the CURATED
     layers first — EA's native geodatabase geometry, then EA's own 110 CAD
     layers — and only then the per-sheet raster drapes, which js/designea.js
     puts under a "Sheets (draped)" sub-header at the bottom together with the
     3D drape master switch. Before v9's delivery round the twenty sheet rows
     came first and pushed every authoritative layer below the fold.

     Nothing here depends on build order: designGIS's curated "Limits of
     excavation" and CadNative's "Limits of excavation — CAD linework" are
     disambiguated by RELABEL, not by which was registered first. */
  if (SBMM.designGIS) SBMM.designGIS.build();
  if (SBMM.CadNative) SBMM.CadNative.build();
  if (SBMM.designEA) SBMM.designEA.build();

  /* ---------- datasets (baked + whatever was imported last session) ---------- */
  if (SBMM.datasets) SBMM.datasets.build();

  /* ---------- cultural resources — CONFIDENTIAL, off by default ----------
     Built last so its rows land at the bottom of the Site-wide section, and
     because nothing else depends on it. js/cultural.js gates the first enable
     behind an acknowledgement and stamps every view and export while any of
     its layers is visible (NHPA §304 / ARPA §9). */
  if (SBMM.cultural) SBMM.cultural.build();

  /* ---------- My work (§4 group 6) ---------- */
  SBMM.myWork.build();
};


/* ====================================================================== */
/* My work — the user's own features, as five layer rows.

   Everything drawn is already a feature in SBMM.store with its own visibility;
   these rows are a CLASS mask over the top, so "hide every measurement while I
   look at the design" does not have to be done one feature at a time and does
   not destroy the per-feature choices when it is switched back on. Both masks
   have to be true for a feature to be drawn, in 2D and in 3D alike.          */
/* ====================================================================== */
SBMM.myWork = (function () {
  const CLASSES = [
    ["drawings",     "Drawings",       "#4FB3CE", f => ["spot", "dim", "text"].includes(f.type)],
    ["measurements", "Measurements",   "#4FCE9B", f => ["line", "area", "volume", "profile"].includes(f.type)],
    ["sections",     "Sections",       "#F0A6D0", f => f.type === "sections"],
    ["pads",         "Design pads",    "#4FD8E6", f => f.type === "surface" && !(f.props && f.props.ref)],
    ["imported",     "Imported",       "#E8B34B", f => !!(f.props && f.props.imported) || /^(DXF|Import)/i.test(f.group || "")]
  ];
  let built = false;

  function classOf(f) {
    /* imported wins: where a feature came from says more about it than what
       shape it happens to be */
    const imp = CLASSES[4];
    if (imp[3](f)) return imp[0];
    for (const c of CLASSES) if (c[3](f)) return c[0];
    return "drawings";
  }
  /* the class mask — js/state.js setVisible owns the per-feature one */
  function shown(f) {
    if (!built) return true;
    return SBMM.layerState.isOn("mywork", classOf(f));
  }
  function apply() {
    if (!built) return;
    for (const f of SBMM.store.features) {
      const on = shown(f) && f.visible !== false;
      if (!f.layer) continue;
      if (on) f.layer.addTo(SBMM.map); else SBMM.map.removeLayer(f.layer);
      if (f.extraLayers) f.extraLayers.forEach(l => { if (on) l.addTo(SBMM.map); else SBMM.map.removeLayer(l); });
      if (f.card) f.card.style.display = on ? "" : "none";
    }
  }
  function build() {
    if (built) return;
    for (const [key, label, color] of CLASSES) {
      /* no Leaflet layer of its own: the row drives a mask over features that
         each own their layer already */
      SBMM.addLayerRow("mywork", label, null,
        { id: key, checked: true, swatch: color, onChange: () => { if (built) apply(); } });
    }
    built = true;
    SBMM.store.onChange(() => apply());
    apply();
  }
  function counts() {
    const o = {};
    for (const [k] of CLASSES) o[k] = 0;
    for (const f of SBMM.store.features) o[classOf(f)] = (o[classOf(f)] || 0) + 1;
    return o;
  }
  return { build, classOf, shown, apply, counts, CLASSES };
})();


/* ====================================================================== */
/* Layers tab information architecture.

   The tab grew out of the ABP volume analysis and still read like it: a flat
   run of headings in the order features were built. The work is now site-wide
   and organised by *place* — the mine area, the residential lots, the site as a
   whole — so the tab is organised that way too, with the two things that are
   about the ground itself (basemap, terrain analysis) kept above the areas.

   The section containers keep their original ids. Nothing about SBMM.addLayerRow
   changed: it still takes a group key and appends to that group's div. All that
   moved is which section of the DOM each div sits in.                          */
/* ====================================================================== */
SBMM.layersUI = (function () {

  const STORE = "sbmm_layer_sections";

  /* what "Areas" flies to. The mine window is the 1-ft DEM footprint; the
     residential extent is the union of the registered design sheets (so it
     follows the drawing set rather than a number typed here); the site is the
     survey. */
  function extents() {
    const mine = SBMM.demAbp.bounds();          // [[y0,x0],[y1,x1]]
    const site = SBMM.demSite.bounds();
    let resid = null;
    const D = window.SBMM_DATA && SBMM_DATA.design_ea;
    if (D && D.sheets) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const k in D.sheets) {
        const r = D.sheets[k].raster;
        if (!r) continue;
        x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0);
        x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
      }
      if (x1 > x0) resid = [[y0 - 120, x0 - 120], [y1 + 120, x1 + 120]];
    }
    return { mine, site, resid: resid || mine };
  }

  function flyTo(area) {
    const e = extents()[area];
    if (!e) return;
    SBMM.map.flyToBounds(e, { padding: [24, 24], duration: 0.8 });
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen())
      SBMM.viewer3d.frameBox(e[0][1], e[0][0], e[1][1], e[1][0]);
    document.querySelectorAll("#areaNav .areabtn")
      .forEach(b => b.classList.toggle("on", b.dataset.area === area));
  }

  /* Count every row a section owns, whatever module put it there.

     The observer that drives this watches the whole pane, and writing a badge is
     itself a mutation of the pane — so this must be idempotent AND must not
     re-arm the observer. Writing only on a real change is what stops it; the
     first version wrote unconditionally and spun the main thread forever, which
     looked exactly like the app hanging on the next background job. */
  let obs = null;
  function refreshCounts() {
    if (obs) obs.disconnect();
    document.querySelectorAll("#layers .lsec").forEach(sec => {
      /* a group's count is the layers it can show: rows, user surfaces, and
         EA's recovered surfaces — but not the two that were searched for and
         are not in the delivered files (those are a finding, not a layer) */
      const n = sec.querySelectorAll(".lyr, .surfrow, .refrow[data-sid]").length;
      const badge = sec.querySelector(".lcount");
      const txt = n ? String(n) : "";
      if (badge && badge.textContent !== txt) badge.textContent = txt;
      /* the group master checkbox is tri-state: all / none / some (§4) */
      const all = sec.querySelector(".lsecall");
      if (all) {
        const st = SBMM.layerState.groupState(sec.dataset.sec);
        const want = st === "all", ind = st === "some";
        if (all.checked !== want) all.checked = want;
        if (all.indeterminate !== ind) all.indeterminate = ind;
        if (st === "empty" && !all.disabled) all.disabled = true;
        else if (st !== "empty" && all.disabled) all.disabled = false;
      }
    });
    /* a closed sub-section must still say how many rows it is hiding, or it
       reads as empty rather than collapsed (F3) */
    document.querySelectorAll("#layers .lgsub").forEach(sub => {
      const n = sub.querySelectorAll(".lyr").length;
      const badge = sub.querySelector(".subcount");
      const txt = n ? String(n) : "";
      if (badge && badge.textContent !== txt) badge.textContent = txt;
    });
    if (obs) obs.observe($("layers"), { childList: true, subtree: true });
  }

  function setOpen(sec, open) {
    sec.classList.toggle("closed", !open);
    const h = sec.querySelector(".lsech");
    if (h) h.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /* Which groups start open (F3). The rule is "open if you would look at it on
     an ordinary day": the ground, the site, the design and the investigation
     work, but not the protected cultural group (section 7 wants that asked for,
     not offered) and not the terrain-analysis sub-section. A stored choice
     always wins over these — they are only the first run. */
  const OPEN_DEFAULT = {
    base: true, framework: true, design: true, invest: true,
    cultural: false, mywork: true,
    "sub:analysis": false
  };

  function wire() {
    const pane = $("layers");
    if (!pane) return;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (e) { saved = {}; }
    const save = () => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch (e) { /* file:// */ } };
    const wanted = k => (saved[k] != null ? saved[k] : (OPEN_DEFAULT[k] !== false));

    /* nested sub-sections inside a group (Terrain analysis) */
    pane.querySelectorAll(".lgsub").forEach(sub => {
      const key = "sub:" + sub.dataset.sub;
      const h = sub.querySelector(".subtoggle");
      const setSubOpen = open => {
        sub.classList.toggle("closed", !open);
        h.setAttribute("aria-expanded", open ? "true" : "false");
      };
      setSubOpen(wanted(key));
      const toggle = () => {
        const open = sub.classList.contains("closed");
        setSubOpen(open); saved[key] = open; save();
      };
      h.onclick = toggle;
      h.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
    });

    pane.querySelectorAll(".lsec").forEach(sec => {
      const key = sec.dataset.sec;
      const h = sec.querySelector(".lsech");
      setOpen(sec, wanted(key));
      h.setAttribute("role", "button");
      h.tabIndex = 0;
      const toggle = () => {
        const open = sec.classList.contains("closed");
        setOpen(sec, open);
        saved[key] = open;
        save();
      };
      /* the header collapses the section; the master checkbox and the "manage…"
         button inside it are their own controls and must not also collapse it */
      h.onclick = e => { if (e.target.closest(".lsecall, .lsecbtn")) return; toggle(); };
      h.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
      const all = sec.querySelector(".lsecall");
      if (all) all.onchange = e => {
        e.stopPropagation();
        SBMM.layerState.setGroup(key, all.checked);
        refreshCounts();
      };
    });
    /* the badges and the tri-state masters follow the state, not the DOM */
    SBMM.events.on("layers", () => refreshCounts());

    document.querySelectorAll("#areaNav .areabtn").forEach(b => b.onclick = () => flyTo(b.dataset.area));
    const sb = $("sheetsBtn");
    if (sb) sb.onclick = e => { e.stopPropagation(); SBMM.sheets.list(); };

    /* Rows arrive late and from several modules — analysis layers on first use,
       trees after detection, datasets on import — so watch rather than count once. */
    obs = new MutationObserver(refreshCounts);
    refreshCounts();
  }

  return { wire, refreshCounts, flyTo, extents };
})();

/* point symbology: mode = exc | Hg | As ; filter = fn(p) or null */
SBMM.symbolizePoints = function (mode, filter) {
  const grp = SBMM.layers.ptGrp;
  grp.clearLayers();
  SBMM.pointMarkers = {};
  const vals = SBMM.samples.map(p => p[mode]).filter(v => v != null && !isNaN(v));
  const lo = Math.log10(Math.max(1e-3, Math.min(...vals))), hi = Math.log10(Math.max(...vals) || 1);
  for (const p of SBMM.samples) {
    if (filter && !filter(p)) continue;
    let c, r = 4.5;
    if (mode === "exc") c = p.exc ? "#E4796A" : "#5FBF8F";
    else {
      const v = p[mode];
      if (v == null || isNaN(v)) c = "#5b6a72";
      else {
        const t = (Math.log10(Math.max(1e-3, v)) - lo) / Math.max(1e-9, hi - lo);
        const rgb = lerpRamp(RAMPS.heat, t); c = `rgb(${rgb.map(Math.round).join(",")})`;
        r = 3.5 + 3.5 * t;
      }
    }
    /* markup shared with the 3D pick card — see js/popups.js */
    const mk = L.circleMarker([p.y, p.x], { pane: "vectors", radius: r, color: "#0D1215", weight: 1, fillColor: c, fillOpacity: .95 })
      .bindPopup(() => SBMM.popups.forSample(p))
      .addTo(grp);
    SBMM.pointMarkers[p.id] = mk;
  }
  const leg = $("ptLegend");
  if (leg) {
    if (mode === "exc") leg.innerHTML = `<span class="chip" style="background:#E4796A"></span>exceeds RG <span class="chip" style="background:#5FBF8F"></span>below`;
    else leg.innerHTML = `${mode} mg/kg: <span class="rampbar" style="background:linear-gradient(90deg,${RAMPS.heat.map(c => `rgb(${c.join(",")})`).join(",")})"></span> <span class="mono">${fmt(Math.pow(10, lo), 1)}–${fmt0(Math.pow(10, hi))}</span> (log)`;
  }
};
