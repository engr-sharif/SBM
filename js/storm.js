/* SBMM Site Explorer — the storm-drainage network (v12, docs/V12_STORM_SPEC.md).

   What the site actually has, as far as anyone has drawn or surveyed it: EA's
   storm structures and storm line out of V-Base.dwg, the six V-STRM-MRKG
   culvert marks, Jacobs' two surveyed 24-in HDPE discharge pipes at the Herman
   sandbag wall, and the south-road drain the project engineer identified along
   the nine grate inlets — Frog Pond (east) → Green Pond (west) → its FES → the
   grates → the junction → the Clear Lake outfall. `tools/build_storm_network.py` assembles all of that
   into data/storm_network.json (44 nodes, 26 conduits); this module renders it
   and answers ONE question for the raindrop: which conduits are in play.

   Three things about it are the whole design:

     * **A conduit is a topological shortcut with an elevation at each end.**
       Nothing here is hydraulics — no capacity, no hydraulic grade line, no
       surcharge, no time. The cards say so, and §7 of the spec puts all of that
       behind the invert survey that has not happened yet.
     * **Never invent an elevation.** `rim_ft` is the lidar ground at the node,
       computed HERE on boot through SBMM.elev so it follows the DEM stack, and
       never baked into the payload. `invert_ft` exists only where somebody
       surveyed one — today that is the two pipe nodes at the sandbag wall and
       nothing else. The kernel's rim is the invert if there is one, else the
       ground; a missing invert is reported as "not surveyed", never guessed.
     * **Read-only project data**, like js/survey.js and js/designgis.js:
       nothing here is a SBMM.store feature, nothing is editable, nothing
       serialises into a session. What DOES persist (localStorage
       "sbmm.storm.v1") is the two switches the user owns — whether the drains
       are assumed to work at all, and whether any one conduit is broken.

   The app must boot without the payload: every entry point below returns empty
   and the layer rows are simply not built. */
"use strict";

SBMM.storm = (function () {

  const LS_KEY = "sbmm.storm.v1";
  const COL = "#7FA7C9";                     // --storm; distinct from --water
  const COL_BROKEN = "#E4796A";
  const CAPTURE_FT = 3;                      // spec ruling: the capture radius
  const MOUTH_SEARCH_FT = 30;                // spec ruling: how far a sunken mouth is looked for

  let byId = {}, conduitById = {}, nextOf = {}, rims = {}, mouths = {};
  let groups = {}, rows = {}, built = false;
  let prefs = { enabled: true, status: {} };

  function data() { return (window.SBMM_DATA && SBMM_DATA.storm_network) || null; }
  function nodes() { const D = data(); return D ? D.nodes : []; }
  function conduits() { const D = data(); return D ? D.conduits : []; }

  /* ------------------------------------------------------------------ */
  /* the two persisted switches                                          */
  /* ------------------------------------------------------------------ */
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === "object") {
          prefs.enabled = p.enabled !== false;
          prefs.status = (p.status && typeof p.status === "object") ? p.status : {};
        }
      }
    } catch (e) { /* a private window is slower to remember, not broken */ }
  }
  function savePrefs() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  function enabled() { return prefs.enabled !== false; }
  function setEnabled(on, quiet) {
    prefs.enabled = !!on;
    savePrefs();
    paintChip();
    /* v14: the drainage map is an answer about this network, so it goes stale */
    if (SBMM.drainage) SBMM.drainage.markStale();
    if (!quiet)
      toast(on ? "storm drains assumed working — a raindrop reaching a grate goes down the pipe"
               : "storm drains off — every analysis is ground only");
    return prefs.enabled;
  }
  function toggle() { return setEnabled(!enabled()); }

  function statusOf(id) {
    const c = conduitById[id];
    const over = prefs.status[id];
    if (over === "broken" || over === "assumed_working") return over;
    return (c && c.status) || "assumed_working";
  }
  function setStatus(id, st) {
    if (!conduitById[id]) { toast("no storm conduit called " + id); return null; }
    if (st !== "broken" && st !== "assumed_working") { toast("a conduit is either working or broken"); return null; }
    prefs.status[id] = st;
    savePrefs();
    rebuildConduits();
    if (SBMM.drainage) SBMM.drainage.markStale();
    toast(conduitById[id].id + " marked " + (st === "broken" ? "broken — water stays on the ground here"
                                                            : "working"));
    if (SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
    return st;
  }

  /* ------------------------------------------------------------------ */
  /* the model: rims from SBMM.elev, and the flattened graph             */
  /* ------------------------------------------------------------------ */
  function computeRims() {
    rims = {};
    for (const n of nodes()) {
      let z = NaN;
      try { z = SBMM.elev(n.x, n.y)[0]; } catch (e) { z = NaN; }
      rims[n.id] = isNaN(z) ? null : +z.toFixed(2);
    }
  }
  /* the elevation the kernel uses: the surveyed invert where one exists, else
     the lidar ground (§2 "Rim for the kernel"). Never anything else. */
  function rimFor(id) {
    const n = byId[id];
    if (!n) return null;
    if (n.invert_ft != null) return n.invert_ft;
    return rims[id] == null ? null : rims[id];
  }
  /* ---- the SUNKEN INLET (ruling, Sep 2026) ---------------------------------
     The lidar is the January-2024 flight. The sandbag wall and the two 24-in
     discharge pipes were surveyed in August 2026 and were built into a regraded
     channel the lidar never saw, which is why the 1-ft cells at the surveyed
     invert points read 1344.66 / 1344.80 — that is the top of the sandbags, not
     the pipe. An inlet whose SURVEYED INVERT lies below the lidar ground at its
     own cell is therefore a pipe mouth the lidar did not see, and it is
     connected to the water it was built to drain.

     So for such an inlet the cell the kernel is given is the NEAREST DEM cell at
     or below the invert within 30 ft of the surveyed point; the rim stays the
     surveyed invert, and `mouth_moved_ft` records how far it went so the popup
     can say so. Nothing is invented: the invert is the survey's, the cell is one
     the lidar actually measured, and if there is no such cell within 30 ft the
     inlet stays exactly where it was surveyed and the popup says that instead.

     This is a HOST rule, not a kernel one — the kernel is handed a point and a
     rim and knows nothing about why. It fires twice today (the two pipe ends at
     the wall, the only nodes with an invert) but is written for any inlet whose
     invert is below its ground. */
  function findMouth(n) {
    if (!n || n.invert_ft == null) return null;
    const dem = SBMM.demAt(n.x, n.y);
    if (!dem) return null;
    const gz = dem.at(n.x, n.y);
    if (isNaN(gz) || gz <= n.invert_ft + 1e-9) return null;       // not sunken
    const m = dem.m, cell = m.cell;
    const rc = Math.ceil(MOUTH_SEARCH_FT / cell);
    const i0 = Math.round((n.x - m.x0) / cell), j0 = Math.round((n.y - m.y0) / cell);
    let best = null, bd = Infinity;
    for (let j = j0 - rc; j <= j0 + rc; j++) {
      if (j < 0 || j >= m.h) continue;
      for (let i = i0 - rc; i <= i0 + rc; i++) {
        if (i < 0 || i >= m.w) continue;
        const z = dem.atGrid(i, j);
        if (isNaN(z) || z > n.invert_ft) continue;
        const x = m.x0 + i * cell, y = m.y0 + j * cell;
        const d = Math.hypot(x - n.x, y - n.y);
        if (d > MOUTH_SEARCH_FT || d >= bd) continue;
        bd = d; best = { x, y, z: +z.toFixed(2), moved: +d.toFixed(1), ground: +gz.toFixed(2) };
      }
    }
    /* sunken but nothing low enough nearby: leave it where it was surveyed and
       say so, rather than dragging it somewhere that only looks right */
    return best || { x: n.x, y: n.y, z: null, moved: null, ground: +gz.toFixed(2), unfound: true };
  }
  function computeMouths() {
    mouths = {};
    for (const n of nodes()) {
      const m = findMouth(n);
      if (m) mouths[n.id] = m;
    }
  }
  function mouthOf(nodeId) { return mouths[nodeId] || null; }
  /* the same, addressed by conduit — what a leg in a flow path needs */
  function mouthOfConduit(cid) {
    const c = conduitById[cid];
    return c ? (mouths[c.from] || null) : null;
  }

  function fallOf(c) {
    const a = rimFor(c.from), b = rimFor(c.to);
    return (a == null || b == null) ? null : +(a - b).toFixed(2);
  }

  function index() {
    byId = {}; conduitById = {}; nextOf = {};
    for (const n of nodes()) byId[n.id] = n;
    for (const c of conduits()) conduitById[c.id] = c;
    /* the graph, flattened the way the kernel wants it: for each conduit, the
       id of the conduit that starts at its OUTLET node (§4). Data order breaks
       a tie, so the answer does not depend on object-key iteration. */
    for (const c of conduits()) {
      const nx = conduits().find(q => q.from === c.to && q.id !== c.id);
      nextOf[c.id] = nx ? nx.id : null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* what js/water.js hands the kernel (§5.1)                            */
  /* ------------------------------------------------------------------ */
  /* Every conduit whose INLET lies inside this window, working, with the master
     switch on. `to` may be anywhere: a chain that leaves the window ends it with
     reason "conduit" and the host re-centres on the outlet. */
  function conduitsFor(bbox) {
    if (!enabled() || !data() || !bbox) return [];
    const out = [];
    for (const c of conduits()) {
      if (statusOf(c.id) !== "assumed_working") continue;
      const a = byId[c.from], b = byId[c.to];
      if (!a || !b) continue;
      if (a.x < bbox[0] || a.x > bbox[2] || a.y < bbox[1] || a.y > bbox[3]) continue;
      /* a sunken pipe mouth is given to the kernel at the channel floor the
         lidar can see; the rim is still the surveyed invert */
      const mo = mouths[c.from];
      const use = (mo && mo.moved != null) ? mo : null;
      out.push({ id: c.id, ix: use ? use.x : a.x, iy: use ? use.y : a.y, rim: rimFor(c.from),
                 ox: b.x, oy: b.y, len: c.length_ft, mouth_moved_ft: use ? use.moved : null,
                 next: (nextOf[c.id] && statusOf(nextOf[c.id]) === "assumed_working") ? nextOf[c.id] : null });
    }
    return out;
  }
  function captureFt() { return CAPTURE_FT; }

  /* a human name for a leg the kernel reports back by id */
  function labelOf(id) {
    const c = conduitById[id];
    if (!c) return id;
    const a = byId[c.from], b = byId[c.to];
    return (a ? a.name : c.from) + " → " + (b ? b.name : c.to);
  }
  function shortLabel(id) {
    const c = conduitById[id];
    if (!c) return id;
    return c.id.replace(/_/g, " ");
  }
  function isOutfall(x, y) {
    const o = byId.outfall;
    return !!(o && Math.hypot(o.x - x, o.y - y) <= 2);
  }

  /* ------------------------------------------------------------------ */
  /* the layers (§5.1)                                                   */
  /* ------------------------------------------------------------------ */
  const GLYPH = {
    grate: '<rect x="2.5" y="2.5" width="9" height="9" fill="none" stroke="{c}" stroke-width="1.8"/>'
         + '<path d="M5 2.5V11.5M8 2.5V11.5" stroke="{c}" stroke-width=".8" opacity=".8"/>',
    round_inlet: '<circle cx="7" cy="7" r="4.6" fill="none" stroke="{c}" stroke-width="1.8"/>',
    fes: '<path d="M3 3L11.5 7L3 11Z" fill="none" stroke="{c}" stroke-width="1.6" stroke-linejoin="round"/>',
    pipe_end: '<path d="M4 4v6M10 4v6" stroke="{c}" stroke-width="1.8" stroke-linecap="round"/>'
            + '<path d="M4 7h6" stroke="{c}" stroke-width="1" opacity=".7"/>',
    bend: '<circle cx="7" cy="7" r="2.6" fill="{c}" opacity=".85"/>',
    junction: '<rect x="2.5" y="2.5" width="9" height="9" fill="none" stroke="{c}" stroke-width="1.8"/>'
            + '<path d="M5 2.5V11.5M8 2.5V11.5" stroke="{c}" stroke-width=".8" opacity=".8"/>',
    outfall: '<path d="M2 3.5V10.5" stroke="{c}" stroke-width="2.4" stroke-linecap="round"/>'
           + '<path d="M3.5 7h8M8.5 4.5L11.5 7L8.5 9.5" fill="none" stroke="{c}" stroke-width="1.5"/>',
    inferred: '<path d="M7 2.2L11.8 7L7 11.8L2.2 7Z" fill="none" stroke="{c}" stroke-width="1.6" stroke-linejoin="round"/>'
  };
  function nodeIcon(kind) {
    const g = (GLYPH[kind] || GLYPH.inferred).replace(/\{c\}/g, COL);
    return L.divIcon({ className: "stormnode", iconSize: [14, 14], iconAnchor: [7, 7],
                       html: `<svg viewBox="0 0 14 14" width="14" height="14">${g}</svg>` });
  }
  /* the arrowhead sits at the OUTLET end and says which way the water goes —
     the one thing about a pipe nobody can read off a line */
  function arrowIcon(deg, broken) {
    return L.divIcon({ className: "stormarrow", iconSize: [12, 12], iconAnchor: [6, 6],
      html: `<svg viewBox="0 0 12 12" width="12" height="12" style="transform:rotate(${deg.toFixed(1)}deg)">`
        + `<path d="M2 2L10 6L2 10Z" fill="${broken ? COL_BROKEN : COL}"/></svg>` });
  }

  function nodeTip(n) {
    const r = rimFor(n.id);
    return `<b>${esc(n.name || n.id)}</b>`
      + (n.invert_ft != null ? `<br>invert ${fmt(n.invert_ft, 2)} ft (surveyed)`
                             : (r == null ? "" : `<br>ground ${fmt(r, 1)} ft (lidar)`));
  }
  function conduitTip(c) {
    const st = statusOf(c.id);
    return `<b>${esc(labelOf(c.id))}</b><br>${fmt0(c.length_ft)} ft`
      + (c.size_in ? ` · ${fmt0(c.size_in)} in` : "")
      + (st === "broken" ? ' · <span style="color:#E4796A">broken</span>' : "");
  }

  function build() {
    const D = data();
    if (!D || !D.nodes || !D.conduits || !D.layers) {
      console.warn("storm: no storm_network payload — the drainage layers are not built");
      return;
    }
    loadPrefs();
    index();
    computeRims();
    computeMouths();

    groups.storm_nodes = L.layerGroup();
    groups.storm_cad = L.layerGroup();
    groups.storm_inferred = L.layerGroup();
    buildNodes();
    buildConduits();

    for (const spec of D.layers) {
      const g = groups[spec.key];
      if (!g) continue;
      /* v16: `sub:` declares the sub-group; the tree builds the header (the
         same `.lsub` text this module used to append by hand) and its count. */
      const row = SBMM.addLayerRow("proj", `${esc(spec.name)} (${spec.count})`, g,
        { id: spec.key, checked: true, swatch: COL,
          sub: "Storm drainage — EA CAD + Jacobs survey" });
      row.row.title = `${spec.name} — ${spec.count}. ${spec.provenance}`;
      rows[spec.key] = row;
    }
    built = true;
  }

  function buildNodes() {
    const g = groups.storm_nodes;
    if (!g) return;
    g.clearLayers();
    for (const n of nodes()) {
      const mk = L.marker([n.y, n.x], { icon: nodeIcon(n.kind), pane: "vectors",
                                        keyboard: false, zIndexOffset: 120 });
      mk.bindTooltip(nodeTip(n), { direction: "top", className: "ctip", offset: [0, -8] });
      mk.on("click", ev => {
        L.DomEvent.stopPropagation(ev);
        mk.bindPopup(SBMM.popups.forStorm(n, null)).openPopup();
      });
      mk.addTo(g);
    }
  }

  function conduitGroupOf(c) {
    return c.source === "inferred" || c.source === "structures_chain"
      ? groups.storm_inferred : groups.storm_cad;
  }
  function buildConduits() {
    groups.storm_cad.clearLayers();
    groups.storm_inferred.clearLayers();
    for (const c of conduits()) {
      const g = conduitGroupOf(c);
      if (!g || !c.pts || c.pts.length < 2) continue;
      const broken = statusOf(c.id) === "broken";
      const drawn = !(c.source === "inferred" || c.source === "structures_chain");
      const ll = c.pts.map(p => [p[1], p[0]]);
      const ln = L.polyline(ll, {
        pane: "vectors", color: broken ? COL_BROKEN : COL, weight: broken ? 3 : 2.5,
        opacity: broken ? 1 : .92, lineCap: "round", lineJoin: "round",
        dashArray: broken ? "2 5" : (drawn ? null : "9 6")
      });
      ln.bindTooltip(conduitTip(c), { sticky: true, className: "ctip" });
      ln.on("click", ev => {
        L.DomEvent.stopPropagation(ev);
        ln.bindPopup(SBMM.popups.forStorm(null, c)).openPopup();
      });
      ln.addTo(g);
      const a = c.pts[c.pts.length - 2], b = c.pts[c.pts.length - 1];
      const deg = Math.atan2(a[1] - b[1], b[0] - a[0]) * 180 / Math.PI;
      L.marker([b[1], b[0]], { icon: arrowIcon(deg, broken), pane: "vectors",
                               interactive: false, keyboard: false }).addTo(g);
    }
  }
  function rebuildConduits() {
    if (!built) return;
    buildConduits();
  }

  /* ------------------------------------------------------------------ */
  /* 3D, snap, export                                                    */
  /* ------------------------------------------------------------------ */
  function rowOn(key) { return SBMM.layerState.isOn("framework", key); }

  function lines3d() {
    if (!data()) return [];
    const out = [];
    for (const c of conduits()) {
      const key = (c.source === "inferred" || c.source === "structures_chain") ? "storm_inferred" : "storm_cad";
      if (!rowOn(key)) continue;
      out.push({ ring: c.pts, color: statusOf(c.id) === "broken" ? COL_BROKEN : COL,
                 width: 3, props: gisProps(null, c), geom: { type: "LineString", coordinates: c.pts } });
    }
    return out;
  }
  function points3d() {
    if (!data() || !rowOn("storm_nodes")) return [];
    return nodes().map(n => ({ x: n.x, y: n.y, id: n.id, name: n.name }));
  }

  function snapPaths() {
    if (!data()) return { rings: [], pts: [] };
    const rings = [], pts = [];
    if (rowOn("storm_cad") || rowOn("storm_inferred"))
      for (const c of conduits()) {
        const key = (c.source === "inferred" || c.source === "structures_chain") ? "storm_inferred" : "storm_cad";
        if (rowOn(key)) rings.push(c.pts);
      }
    if (rowOn("storm_nodes")) for (const n of nodes()) pts.push([n.x, n.y]);
    return { rings, pts };
  }

  /* the properties both the popup and the exports read, in one place */
  function gisProps(n, c) {
    if (n) return {
      layer: "storm_nodes", kind: n.kind, name: n.name, id: n.id,
      rim_ft: rims[n.id], invert_ft: n.invert_ft, size_in: n.size_in,
      cad_block: n.cad_block, cad_handle: n.cad_handle, note: n.note,
      provenance: n.provenance, source: "Storm network (docs/V12_STORM_SPEC.md)"
    };
    return {
      layer: (c.source === "inferred" || c.source === "structures_chain") ? "storm_inferred" : "storm_cad",
      id: c.id, name: labelOf(c.id), from: c.from, to: c.to,
      length_ft: c.length_ft, fall_ft: fallOf(c), size_in: c.size_in, material: c.material,
      cad_handles: (c.cad_handles || []).join(" "), note: c.note, status: statusOf(c.id),
      conduit_source: c.source, provenance: c.provenance,
      source: "Storm network (docs/V12_STORM_SPEC.md)"
    };
  }

  function geoFeatures(P) {
    if (!data()) return [];
    const out = [];
    for (const n of nodes())
      out.push({ type: "Feature", properties: gisProps(n, null),
                 geometry: { type: "Point", coordinates: P([n.x, n.y]) } });
    for (const c of conduits())
      out.push({ type: "Feature", properties: gisProps(null, c),
                 geometry: { type: "LineString", coordinates: c.pts.map(P) } });
    return out;
  }
  function dxfEntities() {
    if (!data()) return [];
    const out = [];
    for (const n of nodes()) out.push({ layer: "STORM-STRUCT", color: COL, point: [n.x, n.y] });
    for (const c of conduits())
      out.push({ layer: (c.source === "inferred" || c.source === "structures_chain")
                   ? "STORM-INFERRED" : "STORM-CONDUIT",
                 color: COL, closed: false, pts: c.pts });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the "storm drains work" chip on the raindrop HUD (§5.1)             */
  /* ------------------------------------------------------------------ */
  function paintChip() {
    const el = document.getElementById("stormChip");
    if (!el) return;
    const show = SBMM.mode && SBMM.mode.current && SBMM.mode.current() === "raindrop" && !!data();
    el.hidden = !show;
    el.classList.toggle("off", !enabled());
    el.textContent = enabled() ? "storm drains: ON" : "storm drains: OFF";
    el.title = enabled()
      ? "A raindrop reaching a grate follows the pipe. Click, or type STORM, to switch it off."
      : "Every analysis is ground only. Click, or type STORM, to switch the drains back on.";
  }

  function wire() {
    const chip = document.getElementById("stormChip");
    if (chip) chip.addEventListener("click", ev => { ev.stopPropagation(); toggle(); });
    if (SBMM.events) SBMM.events.on("mode", paintChip);
    paintChip();
  }

  return { build, wire, data, enabled, setEnabled, toggle, statusOf, setStatus,
           conduitsFor, captureFt, rimFor, fallOf, labelOf, shortLabel, isOutfall,
           mouthOf, mouthOfConduit, mouths: () => mouths, MOUTH_SEARCH_FT,
           node: id => byId[id] || null, conduit: id => conduitById[id] || null,
           nextOf: id => nextOf[id] || null, rims: () => rims,
           lines3d, points3d, snapPaths, geoFeatures, dxfEntities, gisProps,
           paintChip, COLOR: COL, rows: () => rows };
})();
