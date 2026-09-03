/* SBMM Site Explorer — the table drawer.

   It began as the sample-results table and is now a tabbed drawer: Samples plus
   one tab per dataset (js/datasets.js). The sample tab keeps its own filters
   (Hg/As thresholds, exceedance, source, symbology) because those drive the map
   symbology as well as the rows; a dataset tab gets the generic treatment —
   search, sort, click-to-zoom, CSV — over whatever columns that dataset has. */
"use strict";

SBMM.table = (function () {
  let sortKey = "id", sortDir = 1, open = false;

  function filters() {
    const q = $("tblSearch").value.trim().toLowerCase();
    const hg = parseFloat($("tblHg").value), as = parseFloat($("tblAs").value);
    const excOnly = $("tblExc").checked;
    const srcs = [...document.querySelectorAll("#tblSrcs input:checked")].map(c => c.value);
    return p => {
      if (q && !p.id.toLowerCase().includes(q)) return false;
      if (!isNaN(hg) && !(p.Hg != null && p.Hg >= hg)) return false;
      if (!isNaN(as) && !(p.As != null && p.As >= as)) return false;
      if (excOnly && !p.exc) return false;
      if (srcs.length && !srcs.includes(p.src)) return false;
      return true;
    };
  }
  function render() {
    const f = filters();
    const rows = SBMM.samples.filter(f).sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (va == null) va = -Infinity; if (vb == null) vb = -Infinity;
      return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
    });
    const tb = $("tblBody");
    tb.innerHTML = rows.map(p => `
      <tr data-id="${esc(p.id)}">
        <td><span class="dot" style="background:${p.exc ? "#E4796A" : "#5FBF8F"}"></span>${esc(p.id)}</td>
        <td class="mut">${esc(p.src)}</td>
        <td class="num">${p.Hg ?? "—"}</td>
        <td class="num">${p.As ?? "—"}</td>
        <td class="num mut">${fmt0(p.x)}</td>
        <td class="num mut">${fmt0(p.y)}</td>
      </tr>`).join("");
    $("tblCount").textContent = `${rows.length} / ${SBMM.samples.length}`;
    tb.querySelectorAll("tr").forEach(tr => tr.onclick = () => {
      const p = SBMM.samples.find(q => q.id === tr.dataset.id); if (!p) return;
      SBMM.map.setView([p.y, p.x], Math.max(SBMM.map.getZoom(), 2));
      const mk = SBMM.pointMarkers[p.id]; if (mk) mk.openPopup();
    });
    /* apply same filter to map markers */
    SBMM.symbolizePoints($("tblSym").value, f);
  }

  function toggle(force) {
    open = force != null ? force : !open;
    $("tableDrawer").classList.toggle("open", open);
    $("tableBtn").classList.toggle("active", open);
    if (open) {
      SBMM.dsTable.renderActive();
      /* the sample layer is off by default since v9 (section 4), and a table of
         results whose rows do not appear on the map when you click them is a
         trap — opening the table is the moment you want them shown */
      if (SBMM.layerState && !SBMM.layerState.isOn("invest", "samples"))
        SBMM.layerState.set("invest", "samples", { on: true });
    }
  }

  function wire() {
    const srcs = [...new Set(SBMM.samples.map(p => p.src))];
    $("tblSrcs").innerHTML = srcs.map(s =>
      `<label><input type="checkbox" value="${esc(s)}">${esc(s)}</label>`).join("");
    ["tblSearch", "tblHg", "tblAs"].forEach(id => $(id).addEventListener("input", render));
    $("tblExc").addEventListener("change", render);
    $("tblSym").addEventListener("change", render);
    document.querySelectorAll("#tblSrcs input").forEach(c => c.addEventListener("change", render));
    document.querySelectorAll("#sampleTable th[data-k]").forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "id" || k === "src" ? 1 : -1; }
      document.querySelectorAll("#sampleTable th").forEach(t => t.classList.remove("asc", "desc"));
      th.classList.add(sortDir > 0 ? "asc" : "desc");
      render();
    });
    $("tableBtn").onclick = () => toggle();
    $("tblClose").onclick = () => toggle(false);
    $("tblCsv").onclick = () => SBMM.io.exportSamplesCSV();
    $("tblReset").onclick = () => {
      $("tblSearch").value = ""; $("tblHg").value = ""; $("tblAs").value = ""; $("tblExc").checked = false;
      document.querySelectorAll("#tblSrcs input").forEach(c => c.checked = false);
      render();
    };
    SBMM.dsTable.wire();
  }
  return { wire, toggle, render, isOpen: () => open };
})();


/* ---------------------------------------------------------------------- */
/* The tab strip, and one generic table per dataset.                       */
/* ---------------------------------------------------------------------- */
SBMM.dsTable = (function () {

  let active = "samples";
  const panes = new Map();      // dataset id -> {pane, state}

  function strip() { return $("tblTabStrip"); }

  function tabButton(id, label, count) {
    const b = document.createElement("button");
    b.className = "ttab";
    b.dataset.tab = id;
    b.innerHTML = `${esc(label)}${count != null ? ` <span class="tcount mono">${count}</span>` : ""}`;
    b.onclick = () => show(id);
    return b;
  }

  function show(id) {
    if (!panes.has(id) && id !== "samples") return;
    active = id;
    [...strip().children].forEach(b => b.classList.toggle("active", b.dataset.tab === id));
    $("tblPaneSamples").hidden = id !== "samples";
    for (const [k, v] of panes) v.pane.hidden = k !== id;
    renderActive();
  }

  function renderActive() {
    if (active === "samples") { SBMM.table.render(); return; }
    const p = panes.get(active);
    if (p) renderDs(p);
  }

  function addTab(d) {
    const pane = document.createElement("div");
    pane.className = "tpane";
    pane.id = "tblPane_" + d.id;
    pane.hidden = true;
    pane.innerHTML = `
      <div class="tbar">
        <b>${esc(d.name)}</b> <span class="mut mono" data-r="count"></span>
        <input placeholder="search…" spellcheck="false" data-r="q">
        <span class="mut" title="${esc(d.source || "")}">${esc(d.kind)}${d.baked ? " · baked" : " · imported"}</span>
        <span class="spacer"></span>
        <span class="minib" data-r="zoom">zoom to extent</span>
        <span class="minib" data-r="csv">CSV</span>
        <span class="ic x" data-r="close">✕</span>
      </div>
      <div class="twrap"><table class="dstable"><thead></thead><tbody></tbody></table></div>`;
    $("tableDrawer").appendChild(pane);
    const st = { d, pane, sortKey: "id", sortDir: 1, q: "" };
    panes.set(d.id, st);

    pane.querySelector('[data-r="q"]').addEventListener("input", e => { st.q = e.target.value; renderDs(st); });
    pane.querySelector('[data-r="csv"]').onclick = () => SBMM.datasets.exportCSV(d);
    pane.querySelector('[data-r="zoom"]').onclick = () => SBMM.datasets.zoomTo(d);
    pane.querySelector('[data-r="close"]').onclick = () => SBMM.table.toggle(false);

    strip().appendChild(tabButton(d.id, d.name, d.points.length));
    return st;
  }

  function removeTab(d) {
    const st = panes.get(d.id);
    if (st) { st.pane.remove(); panes.delete(d.id); }
    const b = strip().querySelector(`[data-tab="${CSS.escape(d.id)}"]`);
    if (b) b.remove();
    if (active === d.id) show("samples");
  }

  function cols(d) { return ["id", "x", "y", ...d.fields]; }
  function val(p, k) { return k === "id" ? p.id : k === "x" ? p.x : k === "y" ? p.y : p.a[k]; }

  function renderDs(st) {
    const d = st.d, c = cols(d);
    const q = st.q.trim().toLowerCase();
    const rows = d.points.filter(p => !q || c.some(k => String(val(p, k) ?? "").toLowerCase().includes(q)))
      .sort((a, b) => {
        let va = val(a, st.sortKey), vb = val(b, st.sortKey);
        if (va == null) va = -Infinity; if (vb == null) vb = -Infinity;
        return (va > vb ? 1 : va < vb ? -1 : 0) * st.sortDir;
      });
    const head = st.pane.querySelector("thead");
    head.innerHTML = "<tr>" + c.map(k => {
      const lbl = k === "id" ? (d.idField || "ID") : k === "x" ? "SP E" : k === "y" ? "SP N" : k;
      const num = k === "x" || k === "y" || d.points.some(p => typeof p.a[k] === "number");
      const dir = st.sortKey === k ? (st.sortDir > 0 ? " asc" : " desc") : "";
      return `<th data-k="${esc(k)}" class="${num ? "num" : ""}${dir}">${esc(lbl)}</th>`;
    }).join("") + "</tr>";
    head.querySelectorAll("th").forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (st.sortKey === k) st.sortDir *= -1; else { st.sortKey = k; st.sortDir = 1; }
      renderDs(st);
    });
    st.pane.querySelector("tbody").innerHTML = rows.map(p => "<tr data-id=\"" + esc(p.id) + "\">"
      + c.map(k => {
        const v = val(p, k);
        if (k === "id") return `<td><span class="dot" style="background:${d.style.color}"></span>${esc(p.id)}</td>`;
        if (k === "x" || k === "y") return `<td class="num mut">${fmt0(v)}</td>`;
        return `<td class="${typeof v === "number" ? "num" : ""}">${v == null || v === "" ? "—" : esc(typeof v === "number" ? fmt(v, 2) : v)}</td>`;
      }).join("") + "</tr>").join("");
    st.pane.querySelector('[data-r="count"]').textContent = `${rows.length} / ${d.points.length}`;
    /* row -> point by position in the filtered list, not by id: IDs repeat in real
       tables and a find-by-id sent every duplicate row to the first one's marker */
    st.pane.querySelectorAll("tbody tr").forEach((tr, i) => tr.onclick = () => {
      const p = rows[i]; if (!p) return;
      SBMM.map.setView([p.y, p.x], Math.max(SBMM.map.getZoom(), 2));
      const mk = (d.markerOf && d.markerOf.get(p)) || (d.markers && d.markers[p.id]);
      if (mk) mk.openPopup();
    });
  }

  function wire() {
    strip().prepend(tabButton("samples", "Samples", SBMM.samples ? SBMM.samples.length : null));
    show("samples");
  }

  return { wire, addTab, removeTab, show, renderActive, active: () => active };
})();
