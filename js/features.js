/* SBMM Site Explorer — Features tab (feature manager tree) and Properties tab.

   Both are pure views over SBMM.store: they re-render on store change and on
   selection change, and they never hold their own copy of anything. Phase 2 can add
   row types (design surfaces, alignments) by extending TYPE_META and the row builder.
*/
"use strict";

const TYPE_META = {
  spot:    { label: "spot",    full: "spot elevation",  icon: "i-pin" },
  line:    { label: "dist",    full: "distance",        icon: "i-ruler" },
  area:    { label: "area",    full: "area",            icon: "i-poly" },
  volume:  { label: "vol",     full: "volume",          icon: "i-vol" },
  profile: { label: "profile", full: "elevation profile", icon: "i-profile" },
  dim:     { label: "dim",     full: "aligned dimension", icon: "i-ruler" },
  text:    { label: "text",    full: "annotation",        icon: "i-pencil" },
  surface: { label: "surf",    full: "design surface (grading)", icon: "i-pad" },
  sections:{ label: "sect",    full: "cross-section set", icon: "i-section" },
  flow:    { label: "flow",    full: "raindrop flow path", icon: "i-drop" },
  photo:   { label: "photo",   full: "field photo",        icon: "i-camera" }
};

/* ===================================================================== */
/* Features tab                                                          */
/* ===================================================================== */
SBMM.features = (function () {
  const collapsed = new Set();
  let host = null, pendingRender = false;

  function svgIcon(id, cls) { return `<svg class="${cls || "ic16"}"><use href="#${id}"/></svg>`; }

  function directChildren(path) {
    const all = SBMM.store.allGroups();
    const pre = path ? path + "/" : "";
    const out = new Set();
    for (const g of all) {
      if (!g.startsWith(pre)) continue;
      const rest = g.slice(pre.length);
      if (!rest || rest.indexOf("/") >= 0) continue;
      out.add(pre + rest);
    }
    return [...out].sort();
  }
  /* "My work" is the user's own work. EA's reference design surfaces (§5) are
     store features so that the volume engine, sections and the 3D view can use
     them unchanged, but they are read-only project data and belong in the
     Layers tab, not in this tree. */
  function mine() { return SBMM.store.features.filter(f => !(f.props && f.props.ref)); }
  function featuresIn(path) { return mine().filter(f => (f.group || "") === path); }
  function countIn(path) {
    const pre = path ? path + "/" : "";
    return mine().filter(f => path ? (f.group === path || (f.group || "").startsWith(pre)) : true).length;
  }

  /* ---------------- one feature row ---------------- */
  function rowFor(f) {
    const meta = TYPE_META[f.type] || { label: f.type, icon: "i-poly" };
    const color = (f.style && f.style.color) || SBMM.tools.defaultColor(f.type);
    const el = document.createElement("div");
    el.className = "ftrow" + (SBMM.store.selected === f.id ? " sel" : "") + (f.visible === false ? " hidden" : "");
    el.dataset.fid = f.id;
    el.draggable = true;
    el.innerHTML =
      `<span class="sw" style="background:${color}"></span>` +
      `<span class="ftname" contenteditable="true" spellcheck="false" title="Click to rename">${esc(f.name || meta.label)}</span>` +
      `<span class="ftt">${meta.icon ? svgIcon(meta.icon, "ic14") : ""}${esc(meta.label)}</span>` +
      `<span class="ftacts">` +
        `<button class="ftb eye" title="${f.visible === false ? "Show" : "Hide"}">${svgIcon(f.visible === false ? "i-eyeoff" : "i-eye")}</button>` +
        `<button class="ftb lock${f.locked ? " on" : ""}" title="${f.locked ? "Unlock" : "Lock"}">${svgIcon(f.locked ? "i-lock" : "i-unlock")}</button>` +
        `<button class="ftb zoom" title="Zoom to">${svgIcon("i-target")}</button>` +
        `<button class="ftb del" title="Delete">${svgIcon("i-trash")}</button>` +
      `</span>`;

    el.addEventListener("click", e => {
      if (e.target.closest(".ftb") || e.target.classList.contains("ftname")) return;
      SBMM.store.select(f.id);
    });
    const nm = el.querySelector(".ftname");
    nm.addEventListener("focus", () => SBMM.store.select(f.id));
    nm.addEventListener("blur", () => {
      const v = nm.textContent.trim();
      if (v && v !== f.name) {
        f.name = v;
        const rn = f.card && f.card.querySelector(".rname"); if (rn) rn.textContent = v;
        SBMM.store.autosave();
        SBMM.props.render(true);
      } else nm.textContent = f.name || meta.label;
      if (pendingRender) { pendingRender = false; render(); }
    });
    nm.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); nm.blur(); }
      if (e.key === "Escape") { nm.textContent = f.name || meta.label; nm.blur(); }
      e.stopPropagation();
    });
    el.querySelector(".eye").onclick = e => { e.stopPropagation(); SBMM.store.setVisible(f, f.visible === false); };
    el.querySelector(".lock").onclick = e => { e.stopPropagation(); SBMM.store.setLocked(f, !f.locked); };
    el.querySelector(".zoom").onclick = e => { e.stopPropagation(); SBMM.store.select(f.id); SBMM.tools.zoomTo(f); };
    el.querySelector(".del").onclick = e => { e.stopPropagation(); SBMM.store.remove(f); };

    el.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", f.id);
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    return el;
  }

  /* ---------------- a folder and everything under it ---------------- */
  function groupNode(path) {
    const wrap = document.createElement("div");
    wrap.className = "ftgroup" + (collapsed.has(path) ? " collapsed" : "");
    const name = path.split("/").pop();
    const head = document.createElement("div");
    head.className = "ftghead";
    head.innerHTML = `<span class="caret">▼</span>${svgIcon("i-folder")}` +
      `<span class="gname">${esc(name)}</span><span class="gn">${countIn(path)}</span>` +
      `<button class="ftb gdel" title="Delete folder (features move to the root)">${svgIcon("i-trash")}</button>`;
    head.onclick = e => {
      if (e.target.closest(".gdel")) return;
      if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
      wrap.classList.toggle("collapsed");
    };
    head.querySelector(".gdel").onclick = e => { e.stopPropagation(); SBMM.store.removeGroup(path); };
    makeDropTarget(head, path);
    wrap.appendChild(head);
    const kids = document.createElement("div");
    kids.className = "ftkids";
    fillContainer(kids, path);
    wrap.appendChild(kids);
    return wrap;
  }

  function makeDropTarget(el, path) {
    el.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; el.classList.add("dropok"); });
    el.addEventListener("dragleave", () => el.classList.remove("dropok"));
    el.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove("dropok");
      const f = SBMM.store.byId(e.dataTransfer.getData("text/plain"));
      if (f) SBMM.store.setGroup(f, path);
    });
  }

  function fillContainer(el, path) {
    for (const g of directChildren(path)) el.appendChild(groupNode(g));
    for (const f of featuresIn(path)) el.appendChild(rowFor(f));
  }

  /* ---------------- render ---------------- */
  /* Selection alone never rebuilds the tree — it just re-flags the rows. A full
     rebuild would rip the DOM out from under a name field the user is editing
     (focusing that field selects the feature). */
  function updateSel() {
    if (!host) return;
    const sel = SBMM.store.selected;
    host.querySelectorAll(".ftrow").forEach(r => r.classList.toggle("sel", r.dataset.fid === sel));
  }
  function render() {
    if (!host) return;
    const ae = document.activeElement;
    if (ae && ae.isContentEditable && host.contains(ae)) { pendingRender = true; return; }
    const n = mine().length;
    $("ftCount").textContent = n + (n === 1 ? " feature" : " features");
    host.innerHTML = "";
    if (!n && !SBMM.store.allGroups().length) {
      host.innerHTML = `<div class="ftempty">Nothing drawn yet.<br>
        Pick a measure tool and draw on the map — every drawing shows up here, where you can
        rename it, hide it, lock it, zoom to it, and drag it into folders.</div>`;
      return;
    }
    fillContainer(host, "");
    makeDropTarget(host, "");
  }

  function wire() {
    host = $("featureTree");
    $("ftNewGroup").onclick = () => {
      const base = prompt("Folder name (use / for nesting, e.g. \"Design/Cut\"):", "Group " + (SBMM.store.allGroups().length + 1));
      if (!base) return;
      const p = SBMM.store.addGroup(base);
      const sel = SBMM.store.selectedFeature();
      if (p && sel) SBMM.store.setGroup(sel, p);
    };
    $("ftExpand").onclick = () => {
      if (collapsed.size) collapsed.clear();
      else SBMM.store.allGroups().forEach(g => collapsed.add(g));
      render();
    };
    SBMM.store.onChange(render);
    SBMM.store.onSelect(updateSel);
    render();
  }

  return { wire, render, updateSel };
})();

/* ===================================================================== */
/* Properties tab                                                        */
/* ===================================================================== */
SBMM.props = (function () {
  let host = null;

  const PROP_LABEL = {
    length_ft: "Length (ft)", grade_pct: "Grade (%)", area_ft2: "Area (ft²)",
    area_ac: "Area (acres)", perimeter_ft: "Perimeter (ft)", z: "Elevation (ft)",
    src: "DEM source", canopy: "Canopy (ft)", base: "Base surface",
    fill_yd3: "Fill (yd³)", cut_yd3: "Cut (yd³)", net_yd3: "Net (yd³)",
    mean_height_ft: "Mean height (ft)", max_height_ft: "Max height (ft)",
    grid: "Grid", cells: "Cells integrated", zmin: "Min elevation (ft)",
    zmax: "Max elevation (ft)", density_tpy: "Density (t/yd³)", baseMode: "Base mode",
    fixedZ: "Fixed elevation (ft)",
    text: "Label", size_ft: "Text height (ft)", off: "Dimension offset (ft)",
    bearing_deg: "Direction (°, 0 = east)",
    /* earthworks */
    surface_kind: "Surface kind", pad_z_ft: "Pad elevation (ft)", slope_HV: "Side slope (H:V)",
    slope_side: "Slope direction", design_zmin_ft: "Design min (ft)", design_zmax_ft: "Design max (ft)",
    balance_z_ft: "Balanced elevation (ft)", balance_iters: "Bisection steps",
    cut_design_yd3: "Cut vs design (yd³)", fill_design_yd3: "Fill vs design (yd³)",
    range_low_yd3: "Range low (yd³)", range_best_yd3: "Range best (yd³)", range_high_yd3: "Range high (yd³)",
    stations: "Stations", station_interval_ft: "Station interval (ft)",
    swath_width_ft: "Swath width (ft)", alignment_length_ft: "Alignment length (ft)",
    endarea_cut_yd3: "End-area cut (yd³)", endarea_fill_yd3: "End-area fill (yd³)",
    gridcheck_cut_yd3: "Grid-check cut (yd³)", gridcheck_diff_pct: "End-area vs grid (%)",
    /* water (v10) */
    drop_z: "Drop elevation (ft)", fall_ft: "Fall (ft)", dem: "Grid",
    minPondDepth: "Smallest pond reported (ft)", hops: "Windows chained",
    steps: "Cells stepped", searched_ft: "Search window (ft)",
    catchment_ft2: "Contributing area (ft²)", catchment_cells: "Contributing cells",
    catchment_window_ft: "Catchment window (ft)", catchment_partial: "Reaches the window edge"
  };
  const SKIP = new Set(["profile", "showCutFill", "kind", "padZ", "ratio", "side",
    "gradePct", "gradeDirDeg", "contourInterval", "showContours", "drape3d",
    "interval", "width", "designId", "showCanopy", "baseMode", "fixedZ",
    /* water: geometry and bookkeeping, not properties anyone reads in a table */
    "zs", "grids", "blockRing", "blocked", "steps"]);

  function svgIcon(id) { return `<svg class="ic16"><use href="#${id}"/></svg>`; }

  function render(force) {
    if (!host) return;
    /* don't yank the DOM out from under a field the user is typing in */
    if (!force && host.contains(document.activeElement) && document.activeElement !== document.body) return;
    const f = SBMM.store.selectedFeature();
    if (!f) {
      host.innerHTML = `<div class="pnone">No feature selected.<br><br>
        Click a drawing on the map or in 3D, or a row in the <b>My work</b> tab, to see and
        edit its type, folder, style, coordinates and computed results here.
        <kbd>Esc</kbd> clears the selection and returns to Navigate.</div>`;
      return;
    }
    const meta = TYPE_META[f.type] || { label: f.type };
    const color = (f.style && f.style.color) || SBMM.tools.defaultColor(f.type);
    const weight = (f.style && f.style.weight != null) ? f.style.weight : (SBMM.tools.baseStyle(f.type).weight || 2);
    const groups = SBMM.store.allGroups();

    host.innerHTML =
      `<div class="pactions">
         <button class="minib" data-a="zoom">${svgIcon("i-target")} Zoom to</button>
         <button class="minib" data-a="edit">${svgIcon("i-pencil")} Edit vertices</button>
         <button class="minib" data-a="del">${svgIcon("i-trash")} Delete</button>
       </div>
       <div class="pgroup"><h4>Identity</h4>
         <div class="prow"><span>Name</span><input type="text" id="pName" value="${esc(f.name || "")}"></div>
         <div class="prow"><span>Type</span><b>${esc(meta.full || meta.label)}</b></div>
         <div class="prow"><span>Folder</span>
           <select id="pGroup">
             <option value="">— root —</option>
             ${groups.map(g => `<option value="${esc(g)}"${g === (f.group || "") ? " selected" : ""}>${esc(g)}</option>`).join("")}
             <option value="__new">＋ new folder…</option>
           </select></div>
         <div class="prow"><span>Visible</span><input type="checkbox" id="pVis"${f.visible === false ? "" : " checked"}></div>
         <div class="prow"><span>Locked</span><input type="checkbox" id="pLock"${f.locked ? " checked" : ""}></div>
       </div>
       <div class="pgroup"><h4>Style</h4>
         <div class="prow"><span>Colour</span><input type="color" id="pColor" value="${hex(color)}">
           <button class="minib" id="pColorReset">reset</button></div>
         <div class="prow"><span>Line weight</span><input type="range" id="pWeight" min="1" max="8" step="0.5" value="${weight}">
           <b class="pv" id="pWeightVal">${weight}</b></div>
       </div>
       ${annoBlock(f)}
       ${designBlock(f)}
       ${computedBlock(f)}
       ${coordBlock(f)}`;

    if (f.type === "text") {
      const tv = $("pText"), th = $("pTextH");
      tv.onchange = () => SBMM.tools.setTextLabel(f, tv.value.trim() || "text");
      th.oninput = () => {
        f.props.size_ft = clamp(parseFloat(th.value) || 20, 1, 500);
        $("pTextHVal").textContent = fmt(f.props.size_ft, 0) + " ft";
        SBMM.tools.applyStyle(f); SBMM.store.autosave();
      };
    }
    if (f.type === "dim") {
      const off = $("pDimOff");
      off.oninput = () => {
        f.props.off = parseFloat(off.value) || 0;
        $("pDimOffVal").textContent = fmt(f.props.off, 0) + " ft";
        SBMM.tools.applyStyle(f); SBMM.store.autosave();
      };
    }
    wireDesignBlock(f);

    host.querySelector('[data-a="zoom"]').onclick = () => SBMM.tools.zoomTo(f);
    host.querySelector('[data-a="edit"]').onclick = () => SBMM.tools.editFeature(f);
    host.querySelector('[data-a="del"]').onclick = () => SBMM.store.remove(f);

    const nm = $("pName");
    nm.onchange = nm.onblur = () => {
      const v = nm.value.trim();
      if (v && v !== f.name) {
        f.name = v;
        const rn = f.card && f.card.querySelector(".rname"); if (rn) rn.textContent = v;
        SBMM.store.emit(); SBMM.store.autosave();
      }
    };
    $("pGroup").onchange = e => {
      if (e.target.value === "__new") {
        const p = prompt("Folder name (use / for nesting):", "Group " + (groups.length + 1));
        if (!p) { render(true); return; }
        SBMM.store.setGroup(f, SBMM.store.addGroup(p));
      } else SBMM.store.setGroup(f, e.target.value);
      render(true);
    };
    $("pVis").onchange = e => SBMM.store.setVisible(f, e.target.checked);
    $("pLock").onchange = e => SBMM.store.setLocked(f, e.target.checked);
    $("pColor").oninput = e => {
      f.style = f.style || {}; f.style.color = e.target.value;
      SBMM.tools.applyStyle(f); SBMM.features.render(); SBMM.store.autosave();
      if (SBMM.viewer3d.refreshOverlays) SBMM.viewer3d.refreshOverlays();
    };
    $("pColorReset").onclick = () => {
      if (f.style) delete f.style.color;
      SBMM.tools.applyStyle(f); SBMM.features.render(); SBMM.store.autosave(); render(true);
    };
    const wr = $("pWeight");
    wr.oninput = () => {
      f.style = f.style || {}; f.style.weight = parseFloat(wr.value);
      $("pWeightVal").textContent = wr.value;
      SBMM.tools.applyStyle(f); SBMM.store.autosave();
    };
  }

  /* annotation editing — the label, its height, and a dimension's offset are the
     three things a drafter actually reaches for after placing one */
  function annoBlock(f) {
    if (f.type === "text") {
      const p = f.props || {};
      return `<div class="pgroup"><h4>Annotation</h4>
        <div class="prow"><span>Label</span><input type="text" id="pText" value="${esc(p.text || f.name || "")}"></div>
        <div class="prow"><span>Height</span><input type="range" id="pTextH" min="2" max="200" step="1" value="${p.size_ft || 20}">
          <b class="pv" id="pTextHVal">${fmt(p.size_ft || 20, 0)} ft</b></div>
        </div>`;
    }
    if (f.type === "dim") {
      const p = f.props || {};
      return `<div class="pgroup"><h4>Dimension</h4>
        <div class="prow"><span>Line offset</span><input type="range" id="pDimOff" min="-200" max="200" step="1" value="${p.off || 0}">
          <b class="pv" id="pDimOffVal">${fmt(p.off || 0, 0)} ft</b></div>
        <div class="prow"><span class="mut">Edit vertices to re-measure.</span></div>
        </div>`;
    }
    return "";
  }

  /* Design surfaces and section sets are parameter-driven: changing a slope ratio or
     a station interval here regenerates the surface or re-cuts the sections, exactly
     as the equivalent control on the results card does. Both write to the same
     props and call the same regenerate(), so the two views can never disagree. */
  function designBlock(f) {
    if (f.type === "surface") {
      const p = f.props || {};
      const surfKind = p.kind || "pad";
      return `<div class="pgroup"><h4>Design surface</h4>
        <div class="prow"><span>Kind</span>
          <select id="pSKind">
            <option value="pad"${surfKind === "pad" ? " selected" : ""}>flat pad</option>
            <option value="plane"${surfKind === "plane" ? " selected" : ""}>sloped plane pad</option>
            <option value="existing"${surfKind === "existing" ? " selected" : ""}>existing-ground copy</option>
          </select></div>
        <div class="prow"><span>Pad elevation</span>
          <input type="number" id="pSZ" step="0.5" value="${p.padZ != null ? p.padZ : ""}"${surfKind === "existing" ? " disabled" : ""}></div>
        <div class="prow"><span>Side slope (H:V)</span>
          <input type="number" id="pSR" step="0.5" min="0.25" value="${p.ratio || 3}"${surfKind === "existing" ? " disabled" : ""}></div>
        <div class="prow"><span>Slopes run</span>
          <select id="pSSide"${surfKind === "existing" ? " disabled" : ""}>
            <option value="out"${p.side !== "in" ? " selected" : ""}>outward (daylight)</option>
            <option value="in"${p.side === "in" ? " selected" : ""}>inward (batter)</option>
          </select></div>
        ${surfKind === "plane" ? `<div class="prow"><span>Grade (%)</span>
          <input type="number" id="pSG" step="0.5" value="${p.gradePct || 0}"></div>
        <div class="prow"><span>Direction (°)</span>
          <input type="number" id="pSGD" step="5" value="${p.gradeDirDeg || 0}"></div>` : ""}
        <div class="prow"><span>Design contours</span><input type="checkbox" id="pSCt"${p.showContours ? " checked" : ""}></div>
        <div class="prow"><span>Drape in 3D</span><input type="checkbox" id="pS3D"${p.drape3d !== false ? " checked" : ""}></div>
        <div class="prow"><button class="minib" id="pSBal">balance cut/fill</button>
          <button class="minib" id="pSRep">REPORT</button></div>
      </div>`;
    }
    if (f.type === "sections") {
      const p = f.props || {};
      const surfs = SBMM.design.list();
      return `<div class="pgroup"><h4>Cross-sections</h4>
        <div class="prow"><span>Station interval</span><input type="number" id="pXI" step="5" min="5" value="${p.interval || 50}"></div>
        <div class="prow"><span>Swath width</span><input type="number" id="pXW" step="10" min="10" value="${p.width || 200}"></div>
        <div class="prow"><span>Design surface</span>
          <select id="pXD"><option value="">— none —</option>
          ${surfs.map(sf => `<option value="${sf.id}"${p.designId === sf.id ? " selected" : ""}>${esc(sf.name)}</option>`).join("")}
          </select></div>
        <div class="prow"><span>Canopy line</span><input type="checkbox" id="pXC"${p.showCanopy ? " checked" : ""}></div>
        <div class="prow"><button class="minib" id="pXOpen">open panel</button>
          <button class="minib" id="pXRep">REPORT</button></div>
      </div>`;
    }
    return "";
  }

  function wireDesignBlock(f) {
    if (f.type === "surface") {
      const regen = () => { SBMM.design.regenerate(f); SBMM.store.autosave(); };
      const num = (id, key, min) => { const el = $(id); if (el) el.onchange = () => {
        const v = parseFloat(el.value);
        if (!isNaN(v)) { f.props[key] = min != null ? Math.max(min, v) : v; regen(); }
      }; };
      const kd = $("pSKind");
      if (kd) kd.onchange = () => { f.props.kind = kd.value; regen(); render(true); };
      num("pSZ", "padZ"); num("pSR", "ratio", 0.25); num("pSG", "gradePct"); num("pSGD", "gradeDirDeg");
      const sd = $("pSSide"); if (sd) sd.onchange = () => { f.props.side = sd.value; regen(); };
      const ct = $("pSCt"); if (ct) ct.onchange = () => { f.props.showContours = ct.checked; regen(); };
      const d3 = $("pS3D"); if (d3) d3.onchange = () => {
        f.props.drape3d = d3.checked;
        if (SBMM.viewer3d.refreshOverlays) SBMM.viewer3d.refreshOverlays();
        SBMM.store.autosave();
      };
      const bal = $("pSBal"); if (bal) bal.onclick = () => SBMM.design.balance(f);
      const rep = $("pSRep"); if (rep) rep.onclick = () => SBMM.report.open(f);
    }
    if (f.type === "sections") {
      const regen = () => { SBMM.sections.regenerate(f); SBMM.store.autosave(); };
      const iv = $("pXI"); if (iv) iv.onchange = () => { f.props.interval = Math.max(5, parseFloat(iv.value) || 50); regen(); };
      const wd = $("pXW"); if (wd) wd.onchange = () => { f.props.width = Math.max(10, parseFloat(wd.value) || 200); regen(); };
      const dd = $("pXD"); if (dd) dd.onchange = () => { f.props.designId = dd.value || null; regen(); };
      const cc = $("pXC"); if (cc) cc.onchange = () => { f.props.showCanopy = cc.checked; regen(); };
      const op = $("pXOpen"); if (op) op.onclick = () => SBMM.sections.openPanel(f);
      const rp = $("pXRep"); if (rp) rp.onclick = () => SBMM.report.open(f);
    }
  }

  function computedBlock(f) {
    const p = f.props || {};
    const keys = Object.keys(p).filter(k => !SKIP.has(k) && p[k] != null && typeof p[k] !== "object");
    if (!keys.length) return "";
    return `<div class="pgroup"><h4>Computed</h4>` +
      keys.map(k => `<div class="prow"><span>${esc(PROP_LABEL[k] || k)}</span><b>${esc(fmtVal(p[k]))}</b></div>`).join("") +
      `</div>`;
  }
  function fmtVal(v) {
    if (typeof v === "number") return Number.isInteger(v) ? fmt0(v) : fmt(v, 2);
    return String(v);
  }

  function coordBlock(f) {
    /* no thousands separators here — three 7-digit columns have to fit a narrow dock */
    const rows = f.pts.map((p, i) => {
      const [z] = SBMM.elev(p[0], p[1]);
      return `<tr><td>${i + 1}</td><td>${p[0].toFixed(2)}</td><td>${p[1].toFixed(2)}</td><td>${isNaN(z) ? "—" : z.toFixed(1)}</td></tr>`;
    }).join("");
    return `<div class="pgroup"><h4>Coordinates — ${f.pts.length} vertex${f.pts.length === 1 ? "" : "es"} (EPSG:6418 ft)</h4>
      <div class="coordlist"><table>
        <thead><tr><th>#</th><th>E</th><th>N</th><th>Z</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
  }

  /* accept "#rrggbb" or "rgb(...)" and always give the colour input a hex */
  function hex(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    const m = /rgb\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c || "");
    if (!m) return "#4FB3CE";
    return "#" + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, "0")).join("");
  }

  function refresh(f) {
    if (!f || SBMM.store.selected === f.id) render();
  }

  function wire() {
    host = $("propsBody");
    SBMM.store.onSelect(() => render(true));
    SBMM.store.onChange(() => render());
    render(true);
  }

  return { wire, render, refresh };
})();

/* ---------------------------------------------------------------------
   Selection plumbing shared by the map, the results cards and the 3D view.
   Kept here so every view reacts to exactly one event.
--------------------------------------------------------------------- */
SBMM.wireSelection = function () {
  SBMM.store.onSelect((next, prev) => {
    for (const id of [prev, next]) {
      const f = id && SBMM.store.byId(id);
      if (f) SBMM.tools.applyStyle(f);
    }
    document.querySelectorAll("#resBody .res").forEach(el =>
      el.classList.toggle("sel", el.dataset.fid === next));
    if (next) {
      const card = document.querySelector(`#resBody .res[data-fid="${next}"]`);
      /* NOT scrollIntoView — see scrollIntoPane in js/util.js: it would scroll
         the document when the Results panel is off-screen, which in field mode
         it is until the sheet is opened */
      if (card) scrollIntoPane(card);
    }
    /* the 3D view listens to onSelect itself, so nothing to do for it here */
  });
  /* clicking empty map clears the selection */
  SBMM.map.on("click", () => {
    if (!SBMM.tools.active() && !SBMM.draw.isPicking()) SBMM.store.select(null);
  });
};
