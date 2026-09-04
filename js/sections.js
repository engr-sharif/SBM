/* SBMM Site Explorer — cross-sections.

   A section set is a store feature of type "sections": its geometry is the
   alignment polyline, its properties are the station interval and the swath width,
   and everything else — the station points, the sampled ground, the design overlay,
   the end-area quantities — is derived and cached. Editing the alignment re-cuts
   the sections the same way editing a volume footprint re-integrates it.

   Stationing is CAD-conventional: station 0+00 at the start of the alignment, then
   0+50, 1+00 … at the typed interval, offsets running left(−) to right(+) looking
   up-station.

   The end-area volume is computed by the average-end-area rule over the section
   series and cross-checked against the grid integration of the same corridor. The
   two are different numerical methods over the same terrain, so agreement is a
   genuine check on both — that is why the panel shows the pair and the percentage
   difference rather than quietly reporting one of them.                            */
"use strict";

SBMM.sections = (function () {

  const OFF_STEP = 2;            // ft between samples across a section
  let openId = null;             // which section set the drawer is showing

  function list() { return SBMM.store.features.filter(f => f.type === "sections"); }

  /* CAD stationing: 1350 ft -> "13+50" */
  function staLabel(s) {
    const sign = s < 0 ? "-" : "";
    s = Math.abs(s);
    const hun = Math.floor(s / 100), rem = s - hun * 100;
    return `${sign}${hun}+${rem.toFixed(0).padStart(2, "0")}`;
  }

  /* ------------------------------------------------------------------ */
  /* creation                                                            */
  /* ------------------------------------------------------------------ */
  const DEFAULTS = { interval: 50, width: 200, designId: null, showCanopy: false };

  function mkSections(pts, name, props, spec) {
    const f = SBMM.tools.newFeature("sections", pts, name || SBMM.tools.nextName("Sections"), spec);
    Object.assign(f.props, DEFAULTS, props || {});
    f.card = SBMM.results.card(f, f.name, "cutting sections…");
    addSectionControls(f);
    regenerate(f);
    return f;
  }

  /* ------------------------------------------------------------------ */
  /* sampling                                                            */
  /* ------------------------------------------------------------------ */
  async function regenerate(f) {
    if (!f || f.type !== "sections") return;
    const pr = f.props;
    const pts = f.pts;
    if (pts.length < 2) return;

    const align = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { align[i * 2] = p[0]; align[i * 2 + 1] = p[1]; });

    const half = (pr.width || 200) / 2;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const bbox = [Math.min(...xs) - half, Math.min(...ys) - half,
                  Math.max(...xs) + half, Math.max(...ys) + half];
    const grids = SBMM.compute.gridsFor(bbox);
    const transfer = [align.buffer, ...grids.map(g => g.z.buffer)];

    /* the design overlay, if a surface is attached */
    let dgrid = null;
    if (pr.designId) {
      /* bbox-windowed, so a reference surface (§5) ships only the strip this
         alignment crosses rather than its whole raster */
      dgrid = SBMM.design.gridSpecFor(pr.designId, bbox);
      if (dgrid) transfer.push(dgrid.z.buffer);
    }
    /* the canopy height model, if it exists and the user asked for it */
    let chm = null;
    if (pr.showCanopy && SBMM.chm) {
      const g = SBMM.compute.gridSpec(SBMM.chm, bbox);
      if (g) { chm = [g]; transfer.push(g.z.buffer); }
    }

    /* the two vertical quantisation steps the end-area tolerance needs (F9,
       the same pair js/isopach.js ships): the design raster's own step from its
       spec, the coarsest step in the DEM stack for the ground; a user pad has
       no raster and so no step */
    const zstepGround = SBMM.dems.reduce((mx, d) => Math.max(mx, (d.m && d.m.step) || 0), 0);
    const zstepDesign = (dgrid && dgrid.zstep) || 0;

    if (f._secHandle) f._secHandle.cancel();
    const handle = SBMM.compute.run("sections",
      { align, interval: pr.interval || 50, width: pr.width || 200, offStep: OFF_STEP,
        grids, dgrid, chm, zstepDesign, zstepGround },
      { transfer, label: "Sections — " + (f.name || "alignment") });
    f._secHandle = handle;

    let R;
    try { R = await handle.promise; }
    catch (e) {
      if (f._secHandle === handle) f._secHandle = null;
      if (e && e.cancelled) return;
      console.error(e);
      if (f.card && f.card.isConnected) SBMM.results.setRows(f.card, "sections failed: " + e.message);
      return;
    }
    if (f._secHandle !== handle) return;
    f._secHandle = null;
    if (!f.card || !f.card.isConnected) return;

    f._sec = R;
    f._secDesignId = pr.designId || null;

    /* average-end-area volume over the section series */
    let ceaCut = 0, ceaFill = 0;
    if (R.cutA) {
      for (let s = 0; s + 1 < R.ns; s++) {
        const L = R.sta[s + 1] - R.sta[s];
        ceaCut += (R.cutA[s] + R.cutA[s + 1]) / 2 * L;
        ceaFill += (R.fillA[s] + R.fillA[s + 1]) / 2 * L;
      }
    }
    f._endArea = { cut: ceaCut, fill: ceaFill };

    const yd3 = v => v / 27;
    Object.assign(pr, {
      stations: R.ns, station_interval_ft: R.interval, swath_width_ft: R.half * 2,
      alignment_length_ft: +R.total.toFixed(1)
    });
    if (R.cutA) {
      pr.endarea_cut_yd3 = +yd3(ceaCut).toFixed(1);
      pr.endarea_fill_yd3 = +yd3(ceaFill).toFixed(1);
    } else { delete pr.endarea_cut_yd3; delete pr.endarea_fill_yd3; }

    const rows = [
      ["Sections", `${R.ns} at ${fmt0(R.interval)} ft`],
      ["Alignment length", fmt(R.total, 1) + " ft (" + staLabel(0) + " – " + staLabel(R.total) + ")"],
      ["Swath width", fmt0(R.half * 2) + " ft"],
      ["Design surface", R.design ? esc(SBMM.store.byId(pr.designId) ? SBMM.store.byId(pr.designId).name : "—") : "none"]
    ];
    if (R.cutA) {
      rows.push(["End-area cut", sig2(yd3(ceaCut)) + " yd³"]);
      rows.push(["End-area fill", sig2(yd3(ceaFill)) + " yd³"]);
    }
    SBMM.results.setRows(f.card, rows);
    f._rows = rows;
    renderMap(f);
    if (openId === f.id) renderPanel(f);
    SBMM.props && SBMM.props.refresh(f);
    /* the grid cross-check runs on its own and updates the card when it lands */
    if (R.cutA) gridCrossCheck(f);
  }

  /* ---------------- corridor grid volume, as a cross-check ----------------
     The corridor is the polygon the sections actually cover: the left edge of every
     station, then the right edge back. Integrating that polygon against the same
     design surface on the DEM grid is a genuinely independent numerical method, so
     the two answers agreeing is evidence and not a tautology. */
  function corridorPolygon(R) {
    const left = [], right = [];
    for (let s = 0; s < R.ns; s++) {
      left.push([R.cx[s] - R.nx[s] * R.half, R.cy[s] - R.ny[s] * R.half]);
      right.push([R.cx[s] + R.nx[s] * R.half, R.cy[s] + R.ny[s] * R.half]);
    }
    return left.concat(right.reverse());
  }
  async function gridCrossCheck(f) {
    const R = f._sec, pr = f.props;
    if (!R || !pr.designId) return;
    const ring = corridorPolygon(R);
    if (ring.length < 4) return;
    const probe = { type: "volume", pts: ring, props: { baseMode: "design", designId: pr.designId } };
    const built = SBMM.tools.buildVolumeJob(probe, { baseMode: "design", designId: pr.designId });
    if (!built) return;
    if (f._xcHandle) f._xcHandle.cancel();
    const h = SBMM.compute.run("volume", built.job,
      { transfer: built.transfer, label: "Section cross-check — " + (f.name || "") , silent: true });
    f._xcHandle = h;
    let G;
    try { G = await h.promise; } catch (e) { return; }
    if (f._xcHandle !== h) return;
    f._xcHandle = null;
    if (!f.card || !f.card.isConnected) return;
    const yd3 = v => v / 27;
    /* volumeGrid's "fill" is terrain above the base = cut against a design surface */
    const grid = { cut: yd3(G.fill), fill: yd3(G.cut) };
    const ea = { cut: yd3(f._endArea.cut), fill: yd3(f._endArea.fill) };
    const net = v => v.cut - v.fill;
    const denom = Math.max(1e-6, Math.abs(grid.cut) + Math.abs(grid.fill));
    const diffPct = (Math.abs(ea.cut - grid.cut) + Math.abs(ea.fill - grid.fill)) / denom * 100;
    f._cross = { grid, ea, diffPct, netGrid: net(grid), netEa: net(ea) };
    pr.gridcheck_cut_yd3 = +grid.cut.toFixed(1);
    pr.gridcheck_diff_pct = +diffPct.toFixed(1);
    renderCross(f);
    if (openId === f.id) renderPanel(f);
    SBMM.props && SBMM.props.refresh(f);
  }
  function renderCross(f) {
    if (!f._cross || !f.card) return;
    const c = f._cross;
    let box = f.card.querySelector(".xcbox");
    if (!box) { box = document.createElement("div"); box.className = "vrangebox xcbox"; f.card.appendChild(box); }
    const ok = c.diffPct < 15;
    box.innerHTML =
      `<div class="rhead">End-area vs grid integration</div>
       <table class="rmeth"><tr><td>average end area</td><td class="num">${sig2(c.ea.cut)} / ${sig2(c.ea.fill)}</td></tr>
        <tr><td>grid integration</td><td class="num">${sig2(c.grid.cut)} / ${sig2(c.grid.fill)}</td></tr>
        <tr class="${ok ? "best" : "warn"}"><td>difference</td><td class="num">${fmt(c.diffPct, 1)} %</td></tr></table>
       <div class="note">cut / fill in yd³ over the section corridor. Two independent numerical
        methods over the same terrain and the same design surface; a few percent apart is normal —
        end areas are a coarser sampling of the same solid.</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* map: station cut lines + labels                                     */
  /* ------------------------------------------------------------------ */
  function clearMap(f) {
    if (f._secLayer) { SBMM.map.removeLayer(f._secLayer); if (f.extraLayers) f.extraLayers = f.extraLayers.filter(l => l !== f._secLayer); f._secLayer = null; }
  }
  function renderMap(f) {
    clearMap(f);
    if (f.visible === false || !f._sec) return;
    const R = f._sec, col = (f.style && f.style.color) || "#F0A6D0";
    const g = L.layerGroup();
    for (let s = 0; s < R.ns; s++) {
      const a = [R.cx[s] - R.nx[s] * R.half, R.cy[s] - R.ny[s] * R.half];
      const b = [R.cx[s] + R.nx[s] * R.half, R.cy[s] + R.ny[s] * R.half];
      const pl = L.polyline([[a[1], a[0]], [b[1], b[0]]],
        { pane: "drawings", color: col, weight: 1.3, opacity: .85 })
        .bindTooltip("Sta " + staLabel(R.sta[s]), { sticky: true, className: "ctip" });
      pl.on("click", ev => { L.DomEvent.stopPropagation(ev); openPanel(f, s); });
      pl.addTo(g);
      /* label every other station when they are dense, so the map stays readable */
      const every = R.ns > 24 ? 4 : R.ns > 12 ? 2 : 1;
      if (s % every === 0) {
        L.marker([b[1], b[0]], {
          pane: "drawings", interactive: false,
          icon: L.divIcon({ className: "stalbl", html: staLabel(R.sta[s]), iconSize: [46, 14], iconAnchor: [-3, 7] })
        }).addTo(g);
      }
    }
    g.addTo(SBMM.map);
    f._secLayer = g;
    f.extraLayers = f.extraLayers || []; f.extraLayers.push(g);
  }

  /* ------------------------------------------------------------------ */
  /* the sections drawer                                                 */
  /* ------------------------------------------------------------------ */
  function openPanel(f, focusIdx) {
    openId = f.id;
    const d = $("secDrawer");
    d.classList.add("open");
    renderPanel(f);
    if (focusIdx != null) {
      const el = $("secBody").querySelector(`.secplot[data-s="${focusIdx}"]`);
      /* same reason as js/features.js: scroll the drawer, never the page */
      if (el) scrollIntoPane(el);
    }
    SBMM.shell.relayout();
  }
  function closePanel() {
    openId = null;
    $("secDrawer").classList.remove("open");
    SBMM.shell.relayout();
  }
  function toggle() {
    const f = SBMM.store.selectedFeature();
    const target = (f && f.type === "sections") ? f : list()[list().length - 1];
    if (!target) { toast("no sections yet — run SEC to cut some"); return; }
    if (openId === target.id && $("secDrawer").classList.contains("open")) closePanel();
    else openPanel(target);
  }

  /* one section plot, drawn on its own small canvas */
  const PW = 250, PH = 150, PADL = 34, PADR = 8, PADT = 16, PADB = 20;
  function drawPlot(cv, f, s) {
    const R = f._sec, no = R.no;
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    /* vertical range across ground + design at this station */
    let lo = Infinity, hi = -Infinity;
    for (let o = 0; o < no; o++) {
      const k = s * no + o;
      for (const v of [R.ground[k], R.design ? R.design[k] : NaN]) if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!isFinite(lo)) { g.fillStyle = "#6C7F8A"; g.fillText("no terrain", 10, H / 2); return; }
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = m - 2; hi = m + 2; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const X = o => PADL + (W - PADL - PADR) * o / (no - 1);
    const Y = z => PADT + (H - PADT - PADB) * (1 - (z - lo) / (hi - lo));

    /* frame + grid */
    g.strokeStyle = "#2C3B45"; g.lineWidth = 1;
    g.strokeRect(PADL + .5, PADT + .5, W - PADL - PADR - 1, H - PADT - PADB - 1);
    g.fillStyle = "#8FA3AE"; g.font = "9px " + PLOT_MONO;
    const nT = 4;
    for (let t = 0; t <= nT; t++) {
      const z = lo + (hi - lo) * t / nT, y = Y(z);
      g.strokeStyle = "rgba(58,76,88,.55)";
      g.beginPath(); g.moveTo(PADL, y); g.lineTo(W - PADR, y); g.stroke();
      g.fillText(z.toFixed(0), 3, y + 3);
    }
    /* centreline */
    const xc = X((no - 1) / 2);
    g.strokeStyle = "rgba(143,163,174,.5)"; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(xc, PADT); g.lineTo(xc, H - PADB); g.stroke();
    g.setLineDash([]);

    /* cut / fill shading between ground and design */
    if (R.design) {
      for (let o = 0; o + 1 < no; o++) {
        const k1 = s * no + o, k2 = k1 + 1;
        const g1 = R.ground[k1], g2 = R.ground[k2], d1 = R.design[k1], d2 = R.design[k2];
        if (isNaN(g1) || isNaN(g2) || isNaN(d1) || isNaN(d2)) continue;
        const cut = (g1 + g2) / 2 > (d1 + d2) / 2;
        g.fillStyle = cut ? "rgba(228,121,106,.30)" : "rgba(91,143,249,.30)";
        g.beginPath();
        g.moveTo(X(o), Y(g1)); g.lineTo(X(o + 1), Y(g2));
        g.lineTo(X(o + 1), Y(d2)); g.lineTo(X(o), Y(d1));
        g.closePath(); g.fill();
      }
    }
    const stroke = (arr, color, w, dash) => {
      g.strokeStyle = color; g.lineWidth = w; g.setLineDash(dash || []);
      g.beginPath();
      let pen = false;
      for (let o = 0; o < no; o++) {
        const v = arr[s * no + o];
        if (isNaN(v)) { pen = false; continue; }
        if (!pen) { g.moveTo(X(o), Y(v)); pen = true; } else g.lineTo(X(o), Y(v));
      }
      g.stroke(); g.setLineDash([]);
    };
    /* canopy first so the ground line reads on top of it */
    if (R.canopy) {
      const top = new Float32Array(no);
      for (let o = 0; o < no; o++) {
        const k = s * no + o, c = R.canopy[k], gr = R.ground[k];
        top[o] = (isNaN(c) || isNaN(gr) || c <= 2) ? NaN : gr + c;
      }
      g.strokeStyle = "#5FBF8F"; g.lineWidth = 1; g.beginPath();
      let pen = false;
      for (let o = 0; o < no; o++) {
        if (isNaN(top[o])) { pen = false; continue; }
        if (!pen) { g.moveTo(X(o), Y(top[o])); pen = true; } else g.lineTo(X(o), Y(top[o]));
      }
      g.stroke();
    }
    if (R.design) stroke(R.design, "#4FD8E6", 1.6, [5, 3]);
    stroke(R.ground, "#E8EEF1", 1.6);

    /* header */
    g.fillStyle = "#C3D0D7"; g.font = "10px " + PLOT_MONO;
    g.fillText("Sta " + staLabel(R.sta[s]), PADL, 11);
    if (R.cutA) {
      g.fillStyle = "#E4796A";
      g.fillText("C " + fmt0(R.cutA[s]), W - PADR - 84, 11);
      g.fillStyle = "#5B8FF9";
      g.fillText("F " + fmt0(R.fillA[s]), W - PADR - 36, 11);
    }
  }
  const PLOT_MONO = 'ui-monospace,"SF Mono",Consolas,monospace';

  function renderPanel(f) {
    const body = $("secBody");
    if (!f || !f._sec) { body.innerHTML = '<div class="placeholder">No sections cut yet.</div>'; return; }
    const R = f._sec;
    $("secTitle").textContent = f.name || "Sections";
    const surf = f.props.designId && SBMM.store.byId(f.props.designId);
    $("secMeta").textContent =
      `${R.ns} sections · ${fmt0(R.interval)} ft interval · ${fmt0(R.half * 2)} ft swath` +
      (surf ? ` · vs ${surf.name}` : " · existing ground only") +
      (f._cross ? ` · end-area vs grid ${fmt(f._cross.diffPct, 1)}%` : "");

    body.innerHTML = "";
    for (let s = 0; s < R.ns; s++) {
      const wrap = document.createElement("div");
      wrap.className = "secplot"; wrap.dataset.s = String(s);
      /* the plot maths is written in CSS pixels; the backing store is DPR-scaled and
         the context transform absorbs the difference, so nothing below knows */
      const cv = document.createElement("canvas");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(PW * dpr); cv.height = Math.round(PH * dpr);
      cv.style.width = PW + "px"; cv.style.height = PH + "px";
      const g2 = cv.getContext("2d");
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPlot({ width: PW, height: PH, getContext: () => g2 }, f, s);
      const read = document.createElement("div");
      read.className = "secread mono";
      read.textContent = "hover for offset / elevation";
      cv.addEventListener("mousemove", ev => {
        const r = cv.getBoundingClientRect();
        const px = (ev.clientX - r.left) * (PW / r.width);
        const o = Math.round((px - PADL) / (PW - PADL - PADR) * (R.no - 1));
        if (o < 0 || o >= R.no) { read.textContent = "—"; return; }
        const k = s * R.no + o;
        const off = -R.half + o * R.offStep;
        const gz = R.ground[k], dz = R.design ? R.design[k] : NaN;
        read.textContent = `off ${off > 0 ? "+" : ""}${off.toFixed(0)} ft · ground ${isNaN(gz) ? "—" : gz.toFixed(1)}` +
          (isNaN(dz) ? "" : ` · design ${dz.toFixed(1)} · Δ ${(gz - dz).toFixed(1)}`);
      });
      cv.addEventListener("mouseleave", () => { read.textContent = "hover for offset / elevation"; });
      cv.addEventListener("click", () => {
        SBMM.map.setView([R.cy[s], R.cx[s]], Math.max(SBMM.map.getZoom(), 2));
      });
      wrap.appendChild(cv); wrap.appendChild(read);
      body.appendChild(wrap);
    }
  }

  /* ------------------------------------------------------------------ */
  /* card controls + CSV                                                 */
  /* ------------------------------------------------------------------ */
  function addSectionControls(f) {
    const pr = f.props;
    const ctl = document.createElement("div"); ctl.className = "volctl secctl";
    ctl.innerHTML = `
      <div class="crow"><span>interval</span>
        <input type="number" class="si" step="5" min="5" style="width:62px" value="${pr.interval || 50}"><span class="mut">ft</span>
        <span>swath</span><input type="number" class="sw2" step="10" min="10" style="width:62px" value="${pr.width || 200}"><span class="mut">ft</span></div>
      <div class="crow"><span>vs design</span>
        <select class="sd"><option value="">— existing ground only —</option></select></div>
      <div class="crow"><label class="cfl"><input type="checkbox" class="sc"${pr.showCanopy ? " checked" : ""}> canopy line</label></div>
      <div class="crow btns"><button class="minib sopen">open panel</button>
        <button class="minib scsv">CSV</button>
        <button class="minib sreport">REPORT</button></div>`;
    const q = c => ctl.querySelector(c);
    q(".si").onchange = e => { pr.interval = Math.max(5, parseFloat(e.target.value) || 50); regenerate(f); };
    q(".sw2").onchange = e => { pr.width = Math.max(10, parseFloat(e.target.value) || 200); regenerate(f); };
    q(".sd").onchange = e => { pr.designId = e.target.value || null; regenerate(f); };
    q(".sc").onchange = e => { pr.showCanopy = e.target.checked; regenerate(f); };
    q(".sopen").onclick = () => openPanel(f);
    q(".scsv").onclick = () => exportCSV(f);
    q(".sreport").onclick = () => SBMM.report.open(f);
    f.card.appendChild(ctl);
    SBMM.results.appendNote(f.card,
      "Sections are cut perpendicular to the alignment at the station interval. End-area volumes " +
      "use the average-end-area rule and are cross-checked against the grid integration of the same corridor.");
    refreshDesignSelects();
  }
  function refreshDesignSelects() {
    const surfs = SBMM.design ? SBMM.design.list() : [];
    for (const f of SBMM.store.features) {
      if (f.type !== "sections" || !f.card || !f.card.isConnected) continue;
      const sel = f.card.querySelector(".sd");
      if (!sel) continue;
      sel.innerHTML = `<option value="">— existing ground only —</option>` +
        surfs.map(s => `<option value="${s.id}"${f.props.designId === s.id ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    }
  }

  function csvText(f) {
    const R = f._sec;
    if (!R) return "";
    let out = "station_ft,station,offset_ft,easting_ft,northing_ft,ground_ft";
    if (R.design) out += ",design_ft,delta_ft";
    if (R.canopy) out += ",canopy_ft";
    out += "\n";
    for (let s = 0; s < R.ns; s++) {
      for (let o = 0; o < R.no; o++) {
        const k = s * R.no + o, off = -R.half + o * R.offStep;
        const x = R.cx[s] + R.nx[s] * off, y = R.cy[s] + R.ny[s] * off;
        const gz = R.ground[k];
        out += `${R.sta[s].toFixed(1)},${staLabel(R.sta[s])},${off.toFixed(1)},${x.toFixed(2)},${y.toFixed(2)},${isNaN(gz) ? "" : gz.toFixed(2)}`;
        if (R.design) {
          const d = R.design[k];
          out += `,${isNaN(d) ? "" : d.toFixed(2)},${(isNaN(d) || isNaN(gz)) ? "" : (gz - d).toFixed(2)}`;
        }
        if (R.canopy) { const c = R.canopy[k]; out += `,${isNaN(c) ? "" : c.toFixed(2)}`; }
        out += "\n";
      }
    }
    return out;
  }
  function exportCSV(f) {
    const t = csvText(f);
    if (!t) { toast("no sections to export"); return; }
    download(`sbmm_sections_${(f.name || "alignment").replace(/\W+/g, "_")}.csv`,
      new Blob([t], { type: "text/csv" }));
  }

  /* ------------------------------------------------------------------ */
  /* command                                                             */
  /* ------------------------------------------------------------------ */
  function cmdSections(arg) {
    const iv = parseFloat(arg);
    const f = SBMM.store.selectedFeature();
    const start = pts => {
      const props = {};
      if (!isNaN(iv) && iv > 0) props.interval = iv;
      /* attach the only design surface automatically — it is almost always what
         the user wants, and the dropdown on the card can undo it in one click */
      const surfs = SBMM.design.list();
      if (surfs.length === 1) props.designId = surfs[0].id;
      const s = mkSections(pts, null, props);
      SBMM.undo.push("sections",
        () => SBMM.store.remove(s),
        () => { SBMM.store.readd(s); if (!s._sec) regenerate(s); });
      SBMM.store.select(s.id);
      openPanel(s);
      return s;
    };
    if (f && (f.type === "line" || f.type === "profile") && f.pts.length > 1) {
      start(f.pts.map(p => p.slice()));
      return;
    }
    SBMM.tools.setTool(null);
    SBMM.draw.beginPick({
      count: 0, minPts: 2,
      prompts: ["SECTIONS — click the alignment, double-click to finish"],
      onMove: (pts, cur) => pts.length
        ? { rings: [{ pts: [...pts, cur], closed: false, style: { color: "#F0A6D0" } }], label: "section alignment" }
        : null,
      onDone: pts => { if (pts.length > 1) start(pts); }
    });
  }

  function wire() {
    if ($("secClose")) $("secClose").onclick = () => closePanel();
    if ($("secCsvBtn")) $("secCsvBtn").onclick = () => { const f = SBMM.store.byId(openId); if (f) exportCSV(f); };
    if ($("secReportBtn")) $("secReportBtn").onclick = () => { const f = SBMM.store.byId(openId); if (f) SBMM.report.open(f); };
    SBMM.store.onChange(() => refreshDesignSelects());
  }

  return { wire, mkSections, regenerate, list, toggle, openPanel, closePanel, cmdSections,
           exportCSV, csvText, staLabel, renderMap, drawPlot, corridorPolygon,
           isOpen: () => !!openId && $("secDrawer").classList.contains("open") };
})();
