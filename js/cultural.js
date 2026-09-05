/* SBMM Site Explorer — cultural resources (CONFIDENTIAL).

   Recorded archaeological resource areas and artefact isolates from the
   T22-0762 survey of the Elem Indian Colony, delivered inside EA's residential
   geodatabase. Until v9 these were deliberately kept OUT of the app (see the
   note in tools/build_design_gis.py and the guard in test/e2e.mjs, which used
   to fail if they ever appeared). They are in now by an explicit decision of
   the project lead, and the exclusion is replaced by controlled inclusion:

     * the group is OFF by default;
     * the first time anything in it is switched on in a session, an
       acknowledgement dialog explains the protection and has to be accepted —
       declining puts the checkbox back;
     * while any cultural layer is visible a red "CONFIDENTIAL — CULTURAL
       RESOURCES (NHPA §304)" stamp sits over the map and the 3D view, and is
       burned into every image the app exports (js/watermark.js does the burn);
     * an export that would carry cultural geometry re-asks for the
       acknowledgement and writes the stamp text into the file's metadata.

   Protection: NHPA §304 (54 U.S.C. §307103) and ARPA §9 (16 U.S.C. §470hh).

   Like designgis.js and cadnative.js this is READ-ONLY project data: nothing
   here is a feature in SBMM.store, nothing is editable, and nothing serialises
   into a session file. What a user draws over it is theirs; the survey is not.

   CRS: the payload is reprojected EPSG:26910 → EPSG:2226 at build time. That
   is the one reprojection in this app and tools/build_cultural.py explains why
   it is not the "silent reprojection" CLAUDE.md forbids (26910 is a different
   projection in different units, not a different realisation of the same one). */
"use strict";

SBMM.cultural = (function () {

  let acknowledged = false;          // per session, per the spec
  let built = false;
  const groups = {};                 // layer key -> L.layerGroup
  const rows = {};                   // layer key -> layer-row handle
  const byLayer = {};                // layer key -> [feature]
  let stampEl = null;
  let stamp3dEl = null;

  function data() { return window.SBMM_DATA && SBMM_DATA.cultural; }
  function conf() {
    const D = data();
    return (D && D.confidential) || {
      stamp: "CONFIDENTIAL – CULTURAL RESOURCES (NHPA §304)",
      ack_title: "Cultural resources — protected information",
      ack_body: "Project team only; do not include in public documents.",
      ack_button: "I understand"
    };
  }
  function stampText() { return conf().stamp; }
  function isAcknowledged() { return acknowledged; }

  /* ------------------------------------------------------------------ */
  /* the acknowledgement                                                 */
  /* ------------------------------------------------------------------ */
  /* Resolves true if the user accepts, false if they decline or Esc out.
     Once accepted it resolves immediately for the rest of the session — the
     spec asks for one acknowledgement per session, not one per click. */
  function acknowledge(reason) {
    if (acknowledged) return Promise.resolve(true);
    const existing = document.getElementById("cultAck");
    if (existing) return existing._promise || Promise.resolve(false);

    const c = conf();
    const box = document.createElement("div");
    box.id = "cultAck";
    box.className = "modal";
    box.innerHTML = `<div class="mbox cultack">
      <div class="mhd"><span class="cultmark">CONFIDENTIAL</span> ${esc(c.ack_title)}
        <span class="spacer"></span><span class="ic x" id="cultAckX" title="Cancel (Esc)">✕</span></div>
      <div class="mbody">
        ${reason ? `<p class="cultwhy">${esc(reason)}</p>` : ""}
        <p class="cultbody">${esc(c.ack_body).replace(/\n\n/g, "</p><p class=\"cultbody\">")}</p>
        <p class="mut cultauth">${esc((c.authorities || []).join(" · "))}</p>
      </div>
      <div class="mfoot"><span class="mut">Switching these layers on stamps every view and every export.</span>
        <span class="spacer"></span>
        <button class="minib" id="cultAckNo">Cancel</button>
        <button class="minib prim" id="cultAckYes">${esc(c.ack_button || "I understand")}</button></div>
    </div>`;
    document.body.appendChild(box);

    let done;
    const p = new Promise(res => { done = res; });
    box._promise = p;
    const shut = ok => {
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      if (ok) acknowledged = true;
      done(ok);
    };
    const onKey = e => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(false); }
      else if (e.key === "Enter") { e.preventDefault(); shut(true); }
    };
    document.addEventListener("keydown", onKey, true);
    box.querySelector("#cultAckX").onclick = () => shut(false);
    box.querySelector("#cultAckNo").onclick = () => shut(false);
    box.querySelector("#cultAckYes").onclick = () => shut(true);
    box.addEventListener("click", e => { if (e.target === box) shut(false); });
    setTimeout(() => { const b = box.querySelector("#cultAckYes"); if (b) b.focus(); }, 20);
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* build                                                               */
  /* ------------------------------------------------------------------ */
  function build() {
    const D = data();
    if (!D || !D.features || !D.layers) return;
    built = true;

    for (const f of D.features) (byLayer[f.layer] = byLayer[f.layer] || []).push(f);

    for (const spec of D.layers) {
      const grp = L.layerGroup();
      groups[spec.key] = grp;
      for (const f of (byLayer[spec.key] || [])) {
        const lyr = geometryFor(f, spec);
        if (!lyr) continue;
        lyr.bindTooltip(tip(f, spec), { sticky: true, className: "ctip" });
        lyr.on("click", () => lyr.bindPopup(popup(f, spec), { maxWidth: 360 }).openPopup());
        lyr._cult = f;
        lyr.addTo(grp);
      }
      /* OFF by default — this is the whole point, so it is not a parameter.
         `persist: false` keeps it out of localStorage and out of the session
         file too: the acknowledgement is per session (§7), so a remembered
         checkbox would put protected geometry on the map at the next boot
         before anyone had been asked. */
      const row = SBMM.addLayerRow("cultural", `${esc(spec.name)} (${spec.count})`, grp,
        { id: spec.key, checked: false, persist: false, swatch: spec.color });
      row.row.classList.add("cultrow");
      row.row.title = `${spec.name} — ${spec.count} features. ${spec.note} `
        + `Protected under NHPA §304 / ARPA §9; project team only.`;
      rows[spec.key] = row;
      gateRow(row, spec);
    }
    buildStamps();
  }

  /* The acknowledgement has to happen BEFORE the geometry reaches the map, and
     Leaflet's own change handler (installed by SBMM.addLayerRow) runs on the
     same event. So this listens in the capture phase, stops the event dead,
     and re-dispatches a plain change once the user has accepted — at which
     point addLayerRow's handler does the normal thing. */
  function gateRow(row, spec) {
    row.cb.addEventListener("click", e => {
      if (!row.cb.checked) return;              // switching OFF never asks
      if (acknowledged) return;
      e.preventDefault();
      e.stopPropagation();
      row.cb.checked = false;
      acknowledge(`You are switching on “${spec.name}” (${spec.count} recorded locations).`)
        .then(ok => {
          if (!ok) { toast("cultural resources stay hidden"); return; }
          row.cb.checked = true;
          row.cb.dispatchEvent(new Event("change"));
          onVisibilityChanged();
          toast("cultural resources visible — every view and export is now stamped", 4200);
        });
    }, true);
    row.cb.addEventListener("change", onVisibilityChanged);
  }

  function geometryFor(f, spec) {
    if (f.geom === "point") {
      return L.circleMarker([f.coords[1], f.coords[0]], {
        pane: "vectors", radius: 4.5, color: "#0D1215", weight: 1.2,
        fillColor: spec.color, fillOpacity: 0.95
      });
    }
    if (f.geom === "polygon" && f.rings && f.rings.length) {
      /* Each entry in `rings` is the OUTER ring of one part of a multipolygon
         (tools/build_cultural.py drops holes and reports the count). Leaflet
         reads a flat array-of-rings as "outer plus holes", which would punch
         every part after the first out of the first one — so each ring is
         wrapped as its own polygon. */
      return L.polygon(f.rings.map(r => [r.map(q => [q[1], q[0]])]), {
        pane: "vectors", color: spec.color, weight: 1.8,
        fillColor: spec.color, fillOpacity: 0.14, dashArray: "4 3"
      });
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* popups                                                              */
  /* ------------------------------------------------------------------ */
  function tip(f, spec) {
    return `<b>${esc(f.name)}</b><br><span style="opacity:.75">${esc(spec.name)}</span>`
      + `<br><span class="warntxt">confidential</span>`;
  }
  function popup(f, spec) {
    const order = f.attr_order && f.attr_order.length ? f.attr_order : Object.keys(f.attrs || {});
    const pairs = order.map(k => [k, (f.attrs || {})[k]]);
    let h = `<div class="cultpop"><span class="cultmark">${esc(stampText())}</span></div>`;
    h += `<b>${esc(f.name)}</b> <span style="opacity:.7">${esc(spec.name)}</span><br>`;
    if (f.area_sf) h += `${fmt0(f.area_sf)} ft² · ${fmt(f.area_sf / 43560, 3)} ac<br>`;
    h += SBMM.popups.attrTable(pairs);
    const c = centroid(f);
    if (c) h += SBMM.popups.coordLine(c[0], c[1]);
    return h;
  }

  function centroid(f) {
    if (f.geom === "point") return f.coords;
    const r = f.rings && f.rings[0];
    if (!r || !r.length) return null;
    let sx = 0, sy = 0;
    for (const p of r) { sx += p[0]; sy += p[1]; }
    return [sx / r.length, sy / r.length];
  }

  /* ------------------------------------------------------------------ */
  /* the stamp                                                           */
  /* ------------------------------------------------------------------ */
  function buildStamps() {
    if (stampEl) return;
    stampEl = document.createElement("div");
    stampEl.className = "cultstamp";
    stampEl.id = "cultStamp";
    stampEl.textContent = stampText();
    stampEl.hidden = true;
    (document.getElementById("stage") || document.body).appendChild(stampEl);

    stamp3dEl = document.createElement("div");
    stamp3dEl.className = "cultstamp cultstamp3d";
    stamp3dEl.id = "cultStamp3d";
    stamp3dEl.textContent = stampText();
    stamp3dEl.hidden = true;
    const v3 = document.getElementById("view3d");
    (v3 || document.body).appendChild(stamp3dEl);
  }

  /* any cultural layer currently on the map */
  function visible() {
    for (const k in rows) if (rows[k].cb && rows[k].cb.checked) return true;
    return false;
  }
  function visibleLayers() {
    return Object.keys(rows).filter(k => rows[k].cb && rows[k].cb.checked);
  }

  function onVisibilityChanged() {
    const on = visible();
    if (stampEl) stampEl.hidden = !on;
    if (stamp3dEl) stamp3dEl.hidden = !on;
    document.body.classList.toggle("cultural-on", on);
    if (SBMM.viewer3d && SBMM.viewer3d.refreshOverlays) SBMM.viewer3d.refreshOverlays();
  }

  /* ------------------------------------------------------------------ */
  /* export gating                                                       */
  /* ------------------------------------------------------------------ */
  /* Called by anything that is about to write a file. Resolves true when the
     export may proceed. When no cultural layer is on there is nothing to gate
     and it resolves immediately, so ordinary exports pay nothing. */
  function gateExport(what) {
    if (!visible()) return Promise.resolve(true);
    if (acknowledged) return Promise.resolve(true);
    return acknowledge(`This ${what || "export"} will contain cultural-resource locations.`);
  }
  /* Metadata block every gated export writes, so the protection travels with
     the file rather than only with the screen it was made on. */
  function exportMeta() {
    if (!visible()) return null;
    const D = data();
    return {
      confidential: true,
      notice: stampText(),
      authorities: conf().authorities || [],
      handling: "Project team only. Do not include in public documents.",
      source: (D && D.source) || "",
      layers: visibleLayers().map(k => {
        const s = (D.layers || []).find(l => l.key === k);
        return s ? s.name : k;
      })
    };
  }

  /* GeoJSON, only for a gated export and only for layers that are on. Callers
     must await gateExport() first; this does not gate itself, because the
     caller is the one that knows whether it is writing a file. */
  function geoFeatures(P) {
    if (!visible() || !acknowledged) return [];
    const out = [];
    for (const k of visibleLayers()) {
      for (const f of (byLayer[k] || [])) {
        const props = Object.assign({ name: f.name, layer: "CULTURAL_" + k.toUpperCase(),
          confidential: true, notice: stampText() }, f.attrs || {});
        let geom = null;
        if (f.geom === "point") geom = { type: "Point", coordinates: P(f.coords) };
        else if (f.rings) geom = { type: "MultiPolygon", coordinates: f.rings.map(r => [r.map(P)]) };
        if (geom) out.push({ type: "Feature", properties: props, geometry: geom });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  /* Same shape as SBMM.designGIS.rings3d(): the viewer owns THREE, this owns
     what is worth drawing. Points come back separately so they can be drawn as
     markers rather than as degenerate rings. */
  function rings3d() {
    if (!visible()) return [];
    const D = data();
    const out = [];
    for (const k of visibleLayers()) {
      const spec = (D.layers || []).find(l => l.key === k);
      for (const f of (byLayer[k] || [])) {
        if (f.geom !== "polygon" || !f.rings) continue;
        for (const r of f.rings) out.push({ ring: r, color: (spec && spec.color) || "#D9534F", feature: f });
      }
    }
    return out;
  }
  /* v15 §3.1: which layer each point belongs to, so js/viewer3d.js can build one
     cloud per ROW and tag it — a single merged cloud can only claim one row. */
  function points3d() {
    if (!visible()) return [];
    const D = data();
    const out = [];
    for (const k of visibleLayers()) {
      const spec = (D.layers || []).find(l => l.key === k);
      for (const f of (byLayer[k] || [])) {
        if (f.geom !== "point") continue;
        out.push({ x: f.coords[0], y: f.coords[1], color: (spec && spec.color) || "#E8B34B",
                   layer: k, feature: f });
      }
    }
    return out;
  }

  function featureAt(x, y, tolFt) {
    const tol = tolFt || 25;
    let best = null, bd = Infinity;
    for (const k of visibleLayers()) {
      for (const f of (byLayer[k] || [])) {
        const c = centroid(f);
        if (!c) continue;
        const d = Math.hypot(c[0] - x, c[1] - y);
        if (d < bd) { bd = d; best = { f, spec: (data().layers || []).find(l => l.key === k) }; }
      }
    }
    return best && bd <= tol ? best : null;
  }

  function counts() {
    const D = data();
    return D ? Object.fromEntries((D.layers || []).map(l => [l.key, l.count])) : {};
  }
  function provenance() {
    const D = data();
    if (!D) return null;
    return { source: D.source, crs: D.crs, gdb_layers: D.gdb_layers,
             layers: D.layers, confidential: D.confidential };
  }

  return {
    build, acknowledge, isAcknowledged, visible, visibleLayers, stampText,
    gateExport, exportMeta, geoFeatures, rings3d, points3d, featureAt,
    popup, counts, provenance, onVisibilityChanged,
    isBuilt: () => built,
    layerRows: () => rows,
    features: k => (byLayer[k] || []).slice(),
    /* test hook: the e2e has to be able to accept the dialog without a click */
    _ack: () => { acknowledged = true; }
  };
})();
