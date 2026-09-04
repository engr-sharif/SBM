/* SBMM Site Explorer — one set of popup builders, used by every view.

   Before v9 each module wrote its own popup HTML inline in the Leaflet
   `bindPopup` call, which meant the 3D view had nothing to show when you
   clicked the same object: the markup only existed inside a closure in
   js/datasets.js or js/designgis.js. §8 of the spec requires the 3D pick card
   to show "the same popup HTML as 2D", and the only honest way to guarantee
   "the same" is for there to be exactly one function that produces it.

   So the builders live here and both views call them. 2D still binds them
   through Leaflet; js/pick3d.js drops the identical string into a floating
   card anchored to the projected point.

   Everything here is a pure string function: no DOM, no Leaflet, no THREE.
   Actions inside a popup go through `SBMM.popups.action(...)` handles rather
   than inline onclick strings wherever a value has to be passed, because a
   name with an apostrophe in it (there are a few in the CAD layers) breaks an
   inline handler and does it silently. */
"use strict";

SBMM.popups = (function () {

  /* ---------------------------------------------------------------- */
  /* deferred actions                                                  */
  /* ---------------------------------------------------------------- */
  /* A popup is a string, so a button inside it cannot close over anything.
     Registering the callback and referring to it by an integer token keeps
     the HTML free of quoted user data. Tokens are recycled after 5 minutes
     of nobody clicking them. */
  const acts = new Map();
  let actSeq = 0;
  function action(fn) {
    const id = ++actSeq;
    acts.set(id, { fn, t: Date.now() });
    if (acts.size > 300) {
      const cut = Date.now() - 300000;
      for (const [k, v] of acts) if (v.t < cut) acts.delete(k);
    }
    return id;
  }
  function run(id) {
    const a = acts.get(+id);
    if (!a) { toast("that action is no longer available — reopen the popup"); return; }
    try { a.fn(); } catch (e) { console.error(e); toast("action failed: " + e.message); }
  }
  /* one delegated listener for every popup anywhere, 2D or 3D */
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-popact]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    run(b.dataset.popact);
  }, true);

  function btn(label, fn, title) {
    return `<span class="minib" data-popact="${action(fn)}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</span>`;
  }
  function actions(html) { return html ? `<div class="pop-actions">${html}</div>` : ""; }

  /* ---------------------------------------------------------------- */
  /* shared furniture                                                  */
  /* ---------------------------------------------------------------- */
  function val(v) {
    return typeof v === "number" ? (Number.isInteger(v) ? fmt0(v) : fmt(v, 2)) : String(v);
  }
  function attrTable(pairs) {
    const rows = pairs.filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v mono">${esc(val(v))}</td></tr>`).join("");
    return `<div class="dspopwrap"><table class="dspop">${rows ||
      '<tr><td class="mut">no attributes</td></tr>'}</table></div>`;
  }
  /* the coordinate footer every popup in the app ends with */
  function coordLine(x, y, extra) {
    const [z] = SBMM.elev(x, y);
    return `<span class="popcoord">${fmt0(x)} E, ${fmt0(y)} N`
      + (isNaN(z) ? "" : " · ground " + fmt(z, 1) + " ft")
      + (extra ? " · " + esc(extra) : "") + `</span>`;
  }

  /* ---------------------------------------------------------------- */
  /* datasets (wells, borings, imported CSVs)                          */
  /* ---------------------------------------------------------------- */
  function forDataset(d, p) {
    const [z] = SBMM.elev(p.x, p.y);
    const dep = d.depthField ? p.a[d.depthField] : null;
    let head = `<b>${esc(p.id)}</b> <span style="opacity:.7">${esc(d.name)}</span>`;
    if (typeof dep === "number" && !isNaN(z))
      head += `<br><span style="opacity:.8">${fmt(dep, 1)} ft deep · base ≈ ${fmt(z - dep, 1)} ft</span>`;
    return head
      + attrTable(d.fields.map(f => [f, p.a[f]]))
      + coordLine(p.x, p.y);
  }

  /* ---------------------------------------------------------------- */
  /* native EA design geometry (js/designgis.js)                       */
  /* ---------------------------------------------------------------- */
  function forGis(p, g) {
    let h = `<b>${esc(p.name || "Design feature")}</b><br>`;
    const bits = [];
    if (p.sheet) bits.push(`sheet ${esc(p.sheet)}`);
    if (p.feature) bits.push(esc(p.feature));
    if (bits.length) h += `<span style="opacity:.75">${bits.join(" · ")}</span><br>`;
    if (p.area_sf)
      h += `${fmt(p.acres != null ? p.acres : p.area_sf / 43560, 3)} ac · ${fmt0(p.area_sf)} ft²<br>`;
    if (p.length_ft) h += `${fmt0(p.length_ft)} ft<br>`;
    /* the excavation depth this polygon is dug to (§4): set by js/designgis.js
       from the same manifest the excavation-bottom raster was built with */
    if (p.depth_ft != null)
      h += `<b>Excavate ${fmt(p.depth_ft, 1)} ft</b>`
        + `<span style="opacity:.7"> — ${p.depth_ft <= 0.75 ? "6 in call-out" : "sheet-note default"}</span><br>`;
    if (p.z_min_ft != null)
      h += `<span style="opacity:.8">design grade ${fmt(p.z_min_ft, 1)}–${fmt(p.z_max_ft, 1)} ft</span><br>`;
    if (p.apn) h += `<span style="opacity:.7">APN ${esc(p.apn)}</span><br>`;
    if (p.remedy) h += `<span style="opacity:.7">${esc(p.remedy)}</span><br>`;
    if (p.cad_layer)
      h += `<span style="opacity:.55;font-family:var(--mono);font-size:11px">${esc(p.cad_layer)}</span><br>`;
    if (p.note) h += `<span style="opacity:.7">${esc(p.note)}</span><br>`;
    if (p.cad_layer_conflict)
      h += `<span class="warntxt">${esc(p.cad_layer_conflict)}</span><br>`;
    h += `<span style="opacity:.55;font-size:11px">${esc(p.provenance || "")}</span>`;
    if (g && g.type === "Polygon" && p.name) {
      const acts = [];
      /* §5: on a limit of excavation, the question is never "how much material
         is above a fitted base" — it is "how much do we dig out of this". Both
         answers, side by side, because their agreement is the check. */
      /* v10: any water body is a candidate for the overtopping analysis, and
         the click that asks the question is the click on the water itself */
      if (p.layer === "water")
        acts.push(btn("overtopping analysis",
          () => SBMM.water.overtop({ ring: g.coordinates[0].map(q => [q[0], q[1]]), name: p.name }),
          "Where and at what level this water body first spills"));
      if (p.layer === "exc")
        acts.push(btn("volume of this excavation",
          () => SBMM.isopach.excavationVolume(p, g),
          "Area × depth and the excavation-bottom raster, side by side"));
      acts.push(btn("measure volume vs. perimeter TIN",
        () => SBMM.designGIS.volumeOf(p.name)));
      h += actions(acts.join(""));
    }
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* native EA CAD (js/cadnative.js)                                   */
  /* ---------------------------------------------------------------- */
  /* js/cadnative.js delegates its popup() straight to this — there is one
     builder, so "the 3D card shows the same popup as 2D" is a fact about the
     code rather than a claim about two copies. */
  function forCad(f) {
    let h = `<b>${esc(f.layer)}</b><br>`;
    h += `<span style="opacity:.75">${esc(f.type)}`;
    if (f.block) h += ` · block ${esc(f.block)}`;
    h += `</span><br>`;
    if (f.text)
      h += `<div style="white-space:pre-wrap;margin:4px 0">${esc(f.text)}</div>`;
    if (f.depth_ft != null) {
      h += `<b>Excavation depth ${fmt(f.depth_ft, 2)} ft</b>`;
      if (f.depth_uncertain) h += ` <span class="warntxt">(uncertain)</span>`;
      h += `<br><span style="opacity:.7;font-size:11px">${esc(f.depth_source || "")}</span><br>`;
    }
    if (f.z_min != null)
      h += `<span style="opacity:.8">Z ${fmt(f.z_min, 1)}–${fmt(f.z_max, 1)} ft</span><br>`;
    else if (f.z != null)
      h += `<span style="opacity:.8">Z ${fmt(f.z, 1)} ft</span><br>`;
    if (f.attribs) for (const k in f.attribs)
      h += `<span style="opacity:.8">${esc(k)}: ${esc(f.attribs[k])}</span><br>`;
    const meta = [];
    if (f.linetype && f.linetype !== "Continuous") meta.push(esc(f.linetype));
    if (f.lineweight > 0) meta.push(`lw ${f.lineweight / 100} mm`);
    if (f.pattern) meta.push(`hatch ${esc(f.pattern)}`);
    if (meta.length)
      h += `<span style="opacity:.6;font-size:11px">${meta.join(" · ")}</span><br>`;
    h += `<span style="opacity:.55;font-family:var(--mono);font-size:11px">`
      + `${esc(f.file || "")}${f.handle ? " · handle " + esc(f.handle) : ""}</span>`;
    if (f.also_in && f.also_in.length)
      h += `<br><span style="opacity:.5;font-size:11px">also in ${esc(f.also_in.join(", "))}</span>`;
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* project sample locations (js/layers.js)                           */
  /* ---------------------------------------------------------------- */
  function forSample(p) {
    return `<b>${esc(p.id)}</b> <span style="opacity:.7">(${esc(p.src)})</span><br>
      Hg ${p.Hg ?? "—"} mg/kg · As ${p.As ?? "—"} mg/kg<br>
      <span style="opacity:.7">${p.exc ? "exceeds a remediation goal" : "below goals"}</span><br>
      ${coordLine(p.x, p.y)}`;
  }

  /* ---------------------------------------------------------------- */
  /* trees (js/trees.js canopy detection)                              */
  /* ---------------------------------------------------------------- */
  function forTree(t) {
    return `<b>Tree ${esc(String(t.id != null ? t.id : ""))}</b><br>`
      + attrTable([["Height (ft)", t.h], ["Crown radius (ft)", t.r],
                   ["Ground (ft)", isNaN(SBMM.elev(t.x, t.y)[0]) ? null : SBMM.elev(t.x, t.y)[0]]])
      + coordLine(t.x, t.y);
  }

  /* ---------------------------------------------------------------- */
  /* user-drawn features (SBMM.store)                                  */
  /* ---------------------------------------------------------------- */
  /* Store features have never had a 2D popup — clicking one selects it and
     the Properties tab is the detail view. In 3D there is no Properties tab
     under the cursor, so the card carries the same facts the Properties tab
     shows, plus the actions that pane offers. Both views end up going through
     the same SBMM.store calls, so a 3D edit and a 2D edit are the same edit. */
  const TYPE_FULL = {
    spot: "spot elevation", line: "distance", area: "area", volume: "volume",
    profile: "elevation profile", dim: "aligned dimension", text: "annotation",
    surface: "design surface", sections: "cross-section set", flow: "raindrop flow path"
  };
  const PROP_LABEL = {
    length_ft: "Length (ft)", grade_pct: "Grade (%)", area_ft2: "Area (ft²)",
    area_ac: "Area (acres)", perimeter_ft: "Perimeter (ft)", z: "Elevation (ft)",
    src: "DEM source", canopy: "Canopy (ft)", base: "Base surface",
    fill_yd3: "Fill (yd³)", cut_yd3: "Cut (yd³)", net_yd3: "Net (yd³)",
    mean_height_ft: "Mean height (ft)", max_height_ft: "Max height (ft)",
    text: "Label", size_ft: "Text height (ft)",
    drop_z: "Drop elevation (ft)", fall_ft: "Fall (ft)", dem: "Grid",
    catchment_ft2: "Contributing area (ft²)"
  };
  const PROP_SKIP = new Set(["profile", "showCutFill", "kind", "padZ", "ratio", "side",
    "gradePct", "gradeDirDeg", "contourInterval", "showContours", "drape3d",
    "interval", "width", "designId", "showCanopy", "provenance",
    "zs", "grids", "blockRing", "blocked", "steps", "minPondDepth", "searched_ft", "hops"]);

  function forFeature(f) {
    const p = f.props || {};
    let h = `<b>${esc(f.name || TYPE_FULL[f.type] || f.type)}</b>`
      + ` <span style="opacity:.7">${esc(TYPE_FULL[f.type] || f.type)}</span>`;
    if (f.group) h += `<br><span style="opacity:.6">${esc(f.group)}</span>`;
    const prov = p.provenance;
    if (prov && prov.source === "sheet")
      h += `<br><span style="opacity:.75">marked on sheet ${esc(prov.sheet)}</span>`;
    h += "<br>";
    const pairs = Object.keys(p)
      .filter(k => !PROP_SKIP.has(k) && p[k] != null && typeof p[k] !== "object")
      .map(k => [PROP_LABEL[k] || k, p[k]]);
    /* A flow path is a computed run, not a drawn shape: the questions a user
       actually has of it are how far, how far down, where it ends and what it
       ponded in on the way — so it gets its own rows rather than the generic
       property dump (v10 §4.1). */
    if (f.type === "flow") {
      const np = (p.ponds || []).length;
      h += attrTable([
        ["Length (ft)", p.length_ft],
        ["Fall (ft)", p.fall_ft],
        ["Grade (%)", p.grade_pct == null ? null : Math.abs(p.grade_pct)],
        ["Ends", SBMM.water ? SBMM.water.endSentence(p) : (p.end && p.end.reason)],
        ["Ponds crossed", np],
        ["Grid", (p.grids && p.grids.length > 1 ? p.grids.join(" → ") : p.dem) + " lidar"]
      ]);
    } else if (pairs.length) h += attrTable(pairs);
    const acts = [];
    if (f.type === "flow" && SBMM.water) {
      acts.push(btn("profile", () => SBMM.water.makeProfile(f), "Elevation profile along the run"));
      acts.push(btn("catchment", () => SBMM.water.catchment(f), "Everything that drains to the drop"));
      acts.push(btn("retrace", () => SBMM.water.retrace(f), "Run the trace again from the drop"));
      acts.push(btn("3D", () => SBMM.viewer3d.openAt(p.drop[0], p.drop[1])));
    }
    acts.push(btn("select", () => SBMM.store.select(f.id)));
    if (f.type !== "spot" && !f.locked)
      acts.push(btn("edit vertices", () => SBMM.tools.editFeature(f)));
    acts.push(btn("delete", () => SBMM.store.remove(f)));
    if (prov && prov.source === "sheet" && SBMM.sheets)
      acts.push(btn("open " + prov.sheet, () => SBMM.sheets.open(prov.sheet)));
    h += actions(acts.join(""));
    const [x, y] = f.pts[0];
    return h + coordLine(x, y, f.pts.length > 1 ? f.pts.length + " vertices" : null);
  }

  /* ---------------------------------------------------------------- */
  /* terrain — the coordinate card §2/§8 call for                      */
  /* ---------------------------------------------------------------- */
  function forTerrain(x, y, z) {
    const [ez, src] = SBMM.elev(x, y);
    const zz = (z == null || isNaN(z)) ? ez : z;
    const [lo, la] = SBMM.toLL(x, y);
    let sl = null, asp = null;
    try {
      const s = SBMM.slopeAt ? SBMM.slopeAt(x, y) : null;
      if (s) { sl = s.slopePct; asp = s.aspectDeg; }
    } catch (e) { /* outside the DEM */ }
    const ch = SBMM.chm ? SBMM.canopy(x, y) : NaN;
    const pairs = [
      ["Easting (ft)", isNaN(x) ? null : +x.toFixed(2)],
      ["Northing (ft)", isNaN(y) ? null : +y.toFixed(2)],
      ["Elevation (ft)", isNaN(zz) ? null : +zz.toFixed(2)],
      ["Latitude", la == null ? null : la.toFixed(6)],
      ["Longitude", lo == null ? null : lo.toFixed(6)],
      ["Slope (%)", sl == null || isNaN(sl) ? null : +sl.toFixed(1)],
      ["Aspect (°)", asp == null || isNaN(asp) ? null : +asp.toFixed(0)],
      ["Canopy (ft)", ch > 0.5 ? +ch.toFixed(1) : null],
      ["DEM source", src || null]
    ];
    const copyTxt = `${x.toFixed(2)}, ${y.toFixed(2)}, ${isNaN(zz) ? "" : zz.toFixed(2)}`
      + `  (${la.toFixed(6)}, ${lo.toFixed(6)})`;
    return `<b>Point</b><br>` + attrTable(pairs)
      + actions(
        btn("copy", () => copyText(copyTxt), "Copy E, N, Z and lat/long to the clipboard")
        + btn("drop marker", () => {
          const f = SBMM.tools.dropSpot(x, y);
          SBMM.store.select(f.id);
        }, "Create a spot-elevation feature here")
        + btn("trace a raindrop", () => SBMM.water.dropAt(x, y),
              "Follow the water downhill from this point over the lidar ground"));
  }

  function copyText(s) {
    const done = () => toast("copied: " + s);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = s; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); }
      catch (e) { toast("couldn't reach the clipboard — the value is " + s, 5000); }
      ta.remove();
    }
  }

  return { forDataset, forGis, forCad, forSample, forTree, forFeature, forTerrain,
           attrTable, coordLine, action, run, btn, actions, copyText };
})();
