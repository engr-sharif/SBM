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
    /* the surveyed discharge pipes (spec §10): the invert is the number, and
       "where does what comes out of this pipe go" is the question */
    if (p.invert_ft != null)
      h += `<b>Invert ${fmt(p.invert_ft, 2)} ft</b>`
        + (p.size_in ? `<span style="opacity:.7"> · ${fmt0(p.size_in)} in ${esc(p.material || "")}</span>` : "") + `<br>`;
    if (p.note) h += `<span style="opacity:.7">${esc(p.note)}</span><br>`;
    if (p.cad_layer_conflict)
      h += `<span class="warntxt">${esc(p.cad_layer_conflict)}</span><br>`;
    h += `<span style="opacity:.55;font-size:11px">${esc(p.provenance || "")}</span>`;
    if (g && g.type === "LineString" && p.layer === "survey_pipe" && SBMM.water) {
      const outlet = g.coordinates[0];
      h += actions(btn("trace discharge", () => SBMM.water.dropAt(outlet[0], outlet[1],
        { name: SBMM.tools.nextName("Pipe discharge route"), group: "Water" }),
        "Trace where water leaving this pipe runs (a raindrop from the plotted outlet end)"));
    }
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
    surface: "design surface", sections: "cross-section set", flow: "raindrop flow path",
    photo: "field photo"
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
    "zs", "grids", "blockRing", "blocked", "steps", "minPondDepth", "searched_ft", "hops",
    /* a photo's payload is the picture, not a property row */
    "img", "thumb", "w", "h"]);

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
        /* v12: the pipe never hides inside the overland length */
        ["In pipes (ft)", p.pipe_ft > 0 ? p.pipe_ft : null],
        ["Total (ft)", p.pipe_ft > 0 ? p.total_ft : null],
        ["Fall (ft)", p.fall_ft],
        ["Grade (%)", p.grade_pct == null ? null : Math.abs(p.grade_pct)],
        ["Ends", SBMM.water ? SBMM.water.endSentence(p) : (p.end && p.end.reason)],
        ["Ponds crossed", np],
        ["Storm drains", p.storm === false ? "off — ground only" : (p.storm ? "assumed working" : null)],
        ["Grid", (p.grids && p.grids.length > 1 ? p.grids.join(" → ") : p.dem) + " lidar"]
      ]);
    } else if (f.type === "photo" && SBMM.field) {
      /* §4.4: the image full width, then the note, the time and how it was
         placed. One builder, so the 2D popup, the 3D pick card and the field
         bottom card are the same thing rather than three that look alike. */
      h += SBMM.field.popupBody(f);
    } else if (pairs.length) h += attrTable(pairs);
    const acts = [];
    if (f.type === "flow" && SBMM.water) {
      acts.push(btn("profile", () => SBMM.water.makeProfile(f), "Elevation profile along the run"));
      acts.push(btn("catchment", () => SBMM.water.catchment(f), "Everything that drains to the drop"));
      acts.push(btn("retrace", () => SBMM.water.retrace(f), "Run the trace again from the drop"));
      acts.push(btn("3D", () => SBMM.viewer3d.openAt(p.drop[0], p.drop[1])));
    }
    acts.push(btn("select", () => SBMM.store.select(f.id)));
    /* Only offer what the tools will actually accept: `SBMM.tools` owns the one
       list (a photo and a spot are single points, a flow is traced not drawn),
       and where vertex editing is refused a translation is the action that is
       meaningful instead. A button whose only outcome is a toast is worse than
       no button. */
    if (SBMM.tools.canEditVertices(f))
      acts.push(btn("edit vertices", () => SBMM.tools.editFeature(f)));
    else if (SBMM.tools.canMove(f))
      acts.push(btn("move", () => SBMM.tools.opMoveCopy(f, false),
                    "Pick a base point and a destination to move this where it belongs"));
    acts.push(btn("delete", () => SBMM.tools.deleteFeature(f)));
    if (prov && prov.source === "sheet" && SBMM.sheets)
      acts.push(btn("open " + prov.sheet, () => SBMM.sheets.open(prov.sheet)));
    h += actions(acts.join(""));
    const [x, y] = f.pts[0];
    return h + coordLine(x, y, f.pts.length > 1 ? f.pts.length + " vertices" : null);
  }

  /* ---------------------------------------------------------------- */
  /* the storm network (js/storm.js, v12 §5.1)                         */
  /* ---------------------------------------------------------------- */
  /* One builder for both halves of the network, because a click on a grate and
     a click on the pipe leaving it are the same question asked twice. The rim
     is labelled "ground (lidar)" and the invert says "not surveyed" where there
     is none: this app never invents an elevation, and a blank row would read as
     one. */
  /* A SUNKEN INLET (v12 ruling): the lidar is Jan 2024 and the pipe was built
     into a channel it never saw, so the analysis enters the pipe at the nearest
     cell the lidar DOES see at or below the surveyed invert. Saying so is the
     whole point — a number that moved 25 ft and does not admit it is worse than
     no number. */
  function mouthNote(mo) {
    if (!mo) return "";
    if (mo.moved == null)
      return `<span class="warntxt">Surveyed invert ${fmt(mo.ground, 2)} ft below the lidar ground here, `
        + `and no cell at or under it within ${fmt0(SBMM.storm.MOUTH_SEARCH_FT)} ft — the analysis enters `
        + `the pipe at the surveyed point.</span><br>`;
    return `<span style="opacity:.75">Sunken mouth: the lidar (Jan 2024) reads `
      + `${fmt(mo.ground, 2)} ft here — the sandbag wall, built after the flight. Inlet cell moved `
      + `${fmt(mo.moved, 1)} ft to the channel floor the lidar sees (${fmt(mo.z, 2)} ft); the rim `
      + `stays the surveyed invert.</span><br>`;
  }

  function forStorm(n, c) {
    const S = SBMM.storm;
    if (!S || !S.data()) return "<b>Storm network</b><br><span style=\"opacity:.7\">not in this build</span>";
    if (n) {
      const rim = S.rims()[n.id];
      const h = `<b>${esc(n.name || n.id)}</b> <span style="opacity:.7">${esc(n.kind.replace(/_/g, " "))}</span><br>`
        + attrTable([
          ["Ground (lidar)", rim == null ? "outside the survey" : fmt(rim, 2) + " ft"],
          ["Invert", n.invert_ft == null ? "not surveyed" : fmt(n.invert_ft, 2) + " ft"],
          ["Size (in)", n.size_in],
          ["CAD block", n.cad_block],
          ["CAD handle", n.cad_handle]
        ])
        + mouthNote(S.mouthOf(n.id))
        + (n.note ? `<span style="opacity:.75">${esc(n.note)}</span><br>` : "")
        + `<span style="opacity:.55;font-size:11px">${esc(n.provenance || "")}</span>`;
      const nacts = [btn("trace a raindrop", () => SBMM.water.dropAt(n.x, n.y),
                         "Follow the water from this structure — through the pipes if the drains are on")];
      /* v14 §4: everything the drainage map says arrives here */
      if (SBMM.drainage)
        nacts.push(btn("show what drains here",
          () => SBMM.drainage.showInto({ node: n.id, title: n.name || n.id }),
          "Highlight every catchment whose water passes through this structure"));
      return h + actions(nacts.join("")) + coordLine(n.x, n.y);
    }
    const st = S.statusOf(c.id);
    const a = S.node(c.from), b = S.node(c.to);
    const fall = S.fallOf(c);
    const inv = (S.rimFor(c.from) != null && a && a.invert_ft != null) ? " (surveyed invert)" : " (lidar ground)";
    let h = `<b>${esc(S.labelOf(c.id))}</b><br>`
      + `<span style="opacity:.7">storm conduit · ${esc(c.source.replace(/_/g, " "))}</span><br>`
      + attrTable([
        ["Length (ft)", c.length_ft],
        ["Fall (ft)", fall == null ? "unknown — no invert" : fall + inv],
        ["Size (in)", c.size_in],
        ["Material", c.material],
        ["From", a ? a.name : c.from],
        ["To", b ? b.name : c.to],
        ["CAD handles", (c.cad_handles || []).join(" ")],
        ["Status", st === "broken" ? "broken" : "assumed working"]
      ])
      + mouthNote(S.mouthOf(c.from))
      + (c.note ? `<span style="opacity:.75">${esc(c.note)}</span><br>` : "")
      + `<span style="opacity:.55;font-size:11px">${esc(c.provenance || "")}</span>`
      + `<br><span style="opacity:.6;font-size:11px">A topological shortcut with an elevation at each `
      + `end — no capacity, no hydraulic grade, no time.</span>`;
    const acts = [];
    acts.push(btn(st === "broken" ? "mark working" : "mark broken",
      () => S.setStatus(c.id, st === "broken" ? "assumed_working" : "broken"),
      st === "broken" ? "Let water through this conduit again"
                      : "Water reaching this inlet stays on the ground"));
    if (a) acts.push(btn("trace from the inlet", () => SBMM.water.dropAt(a.x, a.y),
                         "A raindrop at this conduit's upstream structure"));
    if (SBMM.drainage)
      acts.push(btn("show what drains here",
        () => SBMM.drainage.showInto({ conduit: c.id, title: S.labelOf(c.id) }),
        "Highlight every catchment whose water passes through this conduit"));
    h += actions(acts.join(""));
    return h + coordLine(c.pts[0][0], c.pts[0][1], c.pts.length + " vertices");
  }


  /* ---------------------------------------------------------------- */
  /* the drainage map (v14 §4)                                         */
  /* ---------------------------------------------------------------- */
  function forDrainage(label) {
    const D = SBMM.drainage;
    if (!D || !D.hasResult()) return "<b>Drainage</b><br><span style=\"opacity:.7\">the map has not been computed — type DRAIN</span>";
    const rec = D.recOf(label);
    if (!rec) return "<b>Drainage</b><br><span style=\"opacity:.7\">that catchment is no longer in the map</span>";
    const R = D.result(), r = rec.r, area = D.areaOf(rec);
    const acres = area / 43560;
    const kind = rec.t === "sink" ? "catchment — by outlet" : "catchment — by first capture";
    const pairs = [
      ["Outlet", D.nameOf(rec)],
      ["Area", (acres < 1 ? fmt(acres, 3) : fmt(acres, 2)) + " ac"],
      ["Share of the surveyed site", R.surveyedArea_ft2
        ? fmt(100 * area / R.surveyedArea_ft2, 1) + " %" : null],
      ["Longest flow path", r.longest_ft == null ? null : fmt0(r.longest_ft) + " ft (overland)"],
      ["Mean slope", r.meanSlope_pct == null ? null : fmt(r.meanSlope_pct, 1) + " %"],
      ["Pond level", rec.t === "pond" ? fmt(r.level, 2) + " ft" : null],
      ["Pond depth", rec.t === "pond" ? fmt(r.depth_ft, 2) + " ft" : null],
      ["Drains on through", r.via && SBMM.storm ? SBMM.storm.labelOf(r.via) : null],
      ["Grid", R.gridFt + "-ft lidar grid"],
      ["Storm drains", R.storm ? "assumed working" : "off — ground only"]
    ];
    let h = `<b>${esc(D.nameOf(rec))}</b><br><span style="opacity:.7">${esc(kind)}</span><br>`
      + attrTable(pairs);
    const acts = [];
    /* a pond is addressed by its label; an inlet by the conduit it IS, so the
       highlight picks up everything further upstream that pours into it too */
    if (rec.t === "pond")
      acts.push(btn("show what drains here", () => SBMM.drainage.showInto({ pond: label }),
                    "Highlight everything upstream of this pond and total the acres"));
    else if (rec.t === "inlet")
      acts.push(btn("show what drains here",
                    () => SBMM.drainage.showInto({ conduit: r.id, title: D.nameOf(rec) }),
                    "Highlight everything upstream of this inlet and total the acres"));
    acts.push(btn("trace a raindrop", () => SBMM.water.dropAt(r.x != null ? r.x : (r.entry ? r.entry[0] : 0),
                                                             r.y != null ? r.y : (r.entry ? r.entry[1] : 0)),
                  "The single flow line this catchment says it agrees with"));
    h += actions(acts.join(""));
    h += `<br><span style="opacity:.6;font-size:11px">${esc(SBMM.drainage.NOTE)}</span>`;
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* the design storm (v14 Phase 2)                                    */
  /* ---------------------------------------------------------------- */
  /* Every number here carries the assumption it rests on, in the row beside
     it: the storm and its depth, the composite CN with the soil group, and the
     two peaks labelled with the method that produced each. */
  function forRunoff(label) {
    const RU = SBMM.runoff;
    if (!RU || !RU.hasResult())
      return "<b>Design storm</b><br><span style=\"opacity:.7\">no storm has been run — type RAIN</span>";
    const R = RU.result(), c = RU.catchment(label);
    if (!c) return "<b>Design storm</b><br><span style=\"opacity:.7\">that catchment is not in this run</span>";
    const top = (c.classes || []).slice(0, 3)
      .map(k => `${esc(k.key)} ${fmt(100 * k.frac, 0)} %`).join(", ");
    const pairs = [
      ["Storm", R.storm.name + " · " + fmt(R.storm.P, 2) + " in"
        + (R.provisional ? " (provisional depths)" : "")],
      ["Area", fmt(c.area_ac, c.area_ac < 1 ? 3 : 2) + " ac"],
      ["Cover", top || null],
      ["Curve number", fmt(c.cn, 0) + " (composite, HSG per class)"],
      ["Runoff depth", fmt(c.Q_in, 2) + " in"],
      ["Runoff volume", fmt(c.volume_acft, 2) + " ac-ft"],
      ["Time of concentration", fmt(c.tc_min, 0) + " min over " + fmt0(c.pathLen_ft) + " ft"],
      ["Peak — Rational", c.qRational_cfs == null
        ? "not reported above " + c.rationalLimit_ac + " ac"
        : fmt(c.qRational_cfs, 0) + " cfs (C " + fmt(c.rationalC, 2) + ", i "
          + fmt(c.i_inhr, 2) + " in/h" + (c.i_extrapolated ? ", extrapolated" : "") + ")"],
      ["Peak — SCS", fmt(c.qPeak_cfs, 0) + " cfs at " + fmt(c.tPeak_h, 1) + " h (Tp "
        + fmt(c.tp_h, 2) + " h)"]
    ];
    let h = `<b>${esc(c.name)}</b><br><span style="opacity:.7">design storm — runoff</span><br>`
      + attrTable(pairs);
    const acts = [];
    acts.push(btn("assumptions…", () => SBMM.runoff.dialog(),
                  "Change the storm, the soil group or the TR-55 segments"));
    acts.push(btn("report", () => SBMM.runoff.report(), "The printable design-storm sheet"));
    /* the catchment's own outlet point comes from the Phase 1 record, not from
       the runoff row — a runoff catchment carries quantities, not a position */
    const D = SBMM.drainage && SBMM.drainage.hasResult() ? SBMM.drainage.result() : null;
    const sink = D ? D.sinks.find(q => q.label === label) : null;
    if (sink)
      acts.push(btn("what drains here", () => SBMM.drainage.showInto({ xy: [sink.x, sink.y] }),
                    "Highlight the contributing catchments"));
    h += actions(acts.join(""));
    h += `<br><span style="opacity:.6;font-size:11px">${esc(SBMM.runoff.NOTE)}</span>`;
    return h;
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

  return { forDataset, forGis, forCad, forSample, forTree, forFeature, forTerrain, forStorm,
           forDrainage, forRunoff,
           attrTable, coordLine, action, run, btn, actions, copyText };
})();
