/* SBMM Site Explorer — scenarios (v19 Phase 3, docs/V19_HYDRO3_SPEC.md §4).

   A scenario is a NAMED SET OF THE ASSUMPTIONS THIS APP ALREADY HAS, and
   nothing else. Every one of its fields is something the user can set by hand
   today — the storm and its distribution, the soil-group rule, curve-number
   overrides, whether the storm drains are assumed to work, which conduits are
   broken, which are blocked as a what-if, whether the August-2026 surveyed
   stages apply — and running one applies exactly those settings and calls
   exactly the kernels the dialogs call. So:

     **a scenario can never produce a number the dialogs could not.**

   That is the whole design rule, and it is why there is no scenario-only
   arithmetic anywhere in this file: `run()` sets the switches, waits for the
   drainage map, the design storm and the pipe capacity, and then READS their
   results. What it adds is the record, the comparison and the diff.

   The record rides in the session under the additive key `scenarios` (an older
   build ignores it, and a session without it restores exactly as before), and
   is otherwise ordinary read-only project state: no store features, no undo. */
"use strict";

SBMM.scenarios = (function () {

  const AC = 43560;
  const NOTE = "A scenario is a named set of the assumptions the dialogs already offer, and "
    + "running one calls the same kernels they call. Every caveat those cards carry — "
    + "provisional rainfall, provisional pipe slopes, terrain-only catchments — carries "
    + "here unchanged.";

  let list = [];                 // the scenarios, in the order they were made
  let activeId = null;           // the one whose settings the app is wearing
  let card = null, seq = 1, diffLayer = null;

  const acft = v => v / AC;
  const byId = id => list.find(s => s.id === id) || null;

  /* ------------------------------------------------------------------ */
  /* the record                                                          */
  /* ------------------------------------------------------------------ */
  /* Everything below is READ off the app, never invented: this is a snapshot of
     the switches as they stand. */
  function capture(name) {
    const st = SBMM.runoff ? SBMM.runoff.settings() : {};
    const D = SBMM.storm && SBMM.storm.data();
    const broken = [];
    if (D) for (const c of D.conduits)
      if (SBMM.storm.statusOf(c.id) === "broken") broken.push(c.id);
    return {
      id: "scn" + (seq++), name: name || ("Scenario " + seq),
      created: new Date().toISOString(),
      storm: st.storm || "25:24", customP: st.customP, customD: st.customD,
      dist: st.dist || "IA",
      hsg: hsgRuleOf(st), cn: JSON.parse(JSON.stringify(st.cn || {})),
      drains: SBMM.storm ? SBMM.storm.enabled() : false,
      broken: broken, blocked: [],
      survey: true,
      surface: null,             // a proposed design surface, when one exists (none do — CLAUDE.md)
      last: null                 // the results of its last run
    };
  }
  /* the dialog offers three soil-group rules and stores the result as a per-class
     map; this reads that map back as the rule that produced it */
  function hsgRuleOf(st) {
    const h = st.hsgOf || {};
    const vals = Object.values(h);
    if (!vals.length) return "ruling";
    if (vals.every(v => v === "C")) return "C";
    if (vals.every(v => v === "D")) return "D";
    return "ruling";
  }
  function hsgMapFor(rule) {
    if (rule !== "C" && rule !== "D") return {};
    const out = {};
    for (const c of (SBMM.runoff ? SBMM.runoff.classes() : [])) out[String(c.id)] = rule;
    return out;
  }

  function add(name) {
    const s = capture(name);
    list.push(s);
    showCard();
    return s;
  }
  function duplicate(id) {
    const s = byId(id);
    if (!s) { toast("no scenario called that"); return null; }
    const c = JSON.parse(JSON.stringify(s));
    c.id = "scn" + (seq++);
    c.name = s.name + " (copy)";
    c.created = new Date().toISOString();
    c.last = null;
    list.push(c);
    showCard();
    return c;
  }
  function rename(id, name) {
    const s = byId(id);
    if (!s) { toast("no scenario called that"); return null; }
    if (!name) { toast("a scenario needs a name"); return null; }
    s.name = name;
    showCard();
    return s;
  }
  function remove(id) {
    const i = list.findIndex(s => s.id === id);
    if (i < 0) { toast("no scenario called that"); return false; }
    const gone = list.splice(i, 1)[0];
    if (activeId === id) activeId = null;
    toast("scenario “" + gone.name + "” deleted");
    showCard();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* applying and running                                                */
  /* ------------------------------------------------------------------ */
  /* Apply the record to the app's own switches. Nothing here is a private copy
     of anything: these are the same setters the dialogs use. */
  function apply(s) {
    if (!s) return false;
    if (SBMM.storm) {
      SBMM.storm.setEnabled(s.drains, true);
      const off = new Set([...(s.broken || []), ...(s.blocked || [])]);
      for (const c of SBMM.storm.data().conduits) {
        const want = off.has(c.id) ? "broken" : "assumed_working";
        if (SBMM.storm.statusOf(c.id) !== want) SBMM.storm.setStatus(c.id, want);
      }
    }
    if (SBMM.runoff) {
      const st = SBMM.runoff.settings();
      st.storm = s.storm; st.customP = s.customP; st.customD = s.customD;
      st.dist = s.dist;
      st.hsgOf = hsgMapFor(s.hsg);
      st.cn = JSON.parse(JSON.stringify(s.cn || {}));
    }
    activeId = s.id;
    return true;
  }

  /* Run one, all the way through, and record what came back. The only thing
     this adds to the cards is the ORDER: the drainage map first (the storm
     switches moved), then the design storm over it, then the pipe capacity for
     the storm's own peaks. */
  async function run(id) {
    const s = byId(id) || (list.length ? list[0] : null);
    if (!s) { toast("no scenario to run — make one first (SCENARIO)"); return null; }
    if (!SBMM.drainage || !SBMM.runoff) {
      toast("scenarios need the drainage map and the design storm, which are not in this build");
      return null;
    }
    apply(s);
    /* NOT `{force:true}`: the drainage map's own cache key is the storm master
       switch plus every conduit's status, which is exactly what a scenario
       changes about it. A scenario that only moves the storm depth therefore
       reuses the map (and the accumulation with it) instead of spending twenty
       seconds proving it is the same map. */
    const D = await SBMM.drainage.run();
    if (!D) return null;                             // drainage already toasted
    /* the accumulation is cached on the same signature and js/storm.js already
       marks it stale when a switch really moves, so nothing is invalidated here
       — a scenario that reuses the map reuses the accumulation with it. */
    const RO = await SBMM.runoff.run({});
    if (!RO) return null;                            // runoff already toasted
    let P = null;
    if (SBMM.pipes) P = await SBMM.pipes.run({});

    const outfall = RO.outlets.find(c => /outfall/i.test(String(c.kind || "")) || /outfall/i.test(c.name))
                 || RO.outlets.slice().sort((a, b) => b.area_ft2 - a.area_ft2)[0] || null;
    s.last = {
      when: new Date().toISOString(),
      storm: RO.storm.name, P_in: RO.storm.P, provisional: RO.provisional,
      gridFt: D.gridFt, drains: D.storm,
      site: { area_ac: RO.totals.area_ac, cn: RO.totals.cn,
              volume_acft: RO.totals.volume_acft, peak_cfs: RO.totals.qPeak_cfs },
      outfall: outfall ? { name: outfall.name, peak_cfs: outfall.qPeak_cfs,
                           volume_acft: outfall.volume_acft, area_ac: outfall.area_ac,
                           tc_min: outfall.tc_min } : null,
      ponds: (RO.routing || []).map(r => ({ name: r.name, peak: r.peakLevel, rim: r.rimLevel,
                                            conduit: r.conduitLevel,
                                            freeboard: r.freeboard_ft, overtops: r.overtops,
                                            overtopT_h: r.overtopT_h,
                                            through: r.throughConduit })),
      outlets: D.sinks.map(k => ({ label: k.label, id: k.id, name: SBMM.drainage.sinkName(k),
                                   acres: +acft(k.area_ft2).toFixed(3),
                                   rings: k.rings || [] })),
      pipes: P ? { worst: P.worst, surcharged: P.surcharged.slice(),
                   rated: P.totalConduits - P.unknownConduits, total: P.totalConduits } : null
    };
    showCard();
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* the comparison (§4)                                                 */
  /* ------------------------------------------------------------------ */
  function comparable(ids) {
    const out = [];
    for (const id of ids) {
      const s = byId(id);
      if (s && s.last) out.push(s);
    }
    return out;
  }
  function compareRows(sel) {
    const pondNames = [];
    for (const s of sel) for (const p of s.last.ponds)
      if (!pondNames.includes(p.name)) pondNames.push(p.name);
    const rows = [];
    rows.push(["Storm", sel.map(s => s.last.storm + " · " + fmt(s.last.P_in, 2) + " in")]);
    rows.push(["Storm drains", sel.map(s => s.last.drains ? "assumed working" : "off")]);
    rows.push(["Blocked / broken", sel.map(s => {
      const n = (s.broken || []).length + (s.blocked || []).length;
      return n ? n + " conduit" + (n === 1 ? "" : "s") : "none";
    })]);
    rows.push(["Site runoff volume", sel.map(s => fmt(s.last.site.volume_acft, 1) + " ac-ft")]);
    rows.push(["Site peak (SCS)", sel.map(s => fmt(s.last.site.peak_cfs, 0) + " cfs")]);
    rows.push(["Outfall peak", sel.map(s => s.last.outfall
      ? fmt(s.last.outfall.peak_cfs, 0) + " cfs" : "—")]);
    rows.push(["Outfall volume", sel.map(s => s.last.outfall
      ? fmt(s.last.outfall.volume_acft, 1) + " ac-ft" : "—")]);
    for (const nm of pondNames) {
      rows.push([nm + " — peak stage", sel.map(s => {
        const p = s.last.ponds.find(q => q.name === nm);
        return p ? fmt(p.peak, 2) + " ft" : "—";
      })]);
      rows.push(["  freeboard", sel.map(s => {
        const p = s.last.ponds.find(q => q.name === nm);
        return p && p.freeboard != null ? fmt(p.freeboard, 2) + " ft" : "—";
      })]);
      rows.push(["  overtops?", sel.map(s => {
        const p = s.last.ponds.find(q => q.name === nm);
        if (!p) return "—";
        return p.overtops ? "YES at " + fmt(p.overtopT_h, 1) + " h"
             : p.through ? "no — discharges" : "no";
      })]);
    }
    rows.push(["Worst pipe ratio", sel.map(s => s.last.pipes && s.last.pipes.worst
      ? fmt(s.last.pipes.worst.ratio, 2) + " (" + s.last.pipes.worst.id + ")"
      : "unknown — survey pending")]);
    rows.push(["Surcharged conduits", sel.map(s => s.last.pipes
      ? (s.last.pipes.surcharged.length ? s.last.pipes.surcharged.join(", ") : "none")
      : "—")]);
    return rows;
  }

  /* what MOVED between two scenarios: an outlet whose catchment changed size,
     and a pond whose peak stage changed by more than the spec's 0.1 ft */
  function diff(aId, bId) {
    const A = byId(aId), B = byId(bId);
    if (!A || !B || !A.last || !B.last) { toast("run both scenarios before comparing them"); return null; }
    const outlets = [];
    const ids = new Set([...A.last.outlets.map(o => o.id), ...B.last.outlets.map(o => o.id)]);
    for (const id of ids) {
      const a = A.last.outlets.find(o => o.id === id), b = B.last.outlets.find(o => o.id === id);
      const da = (b ? b.acres : 0) - (a ? a.acres : 0);
      if (Math.abs(da) < 0.05) continue;
      outlets.push({ id, name: (b || a).name, a: a ? a.acres : 0, b: b ? b.acres : 0,
                     d: +da.toFixed(3), rings: (b || a).rings });
    }
    outlets.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const ponds = [];
    for (const p of B.last.ponds) {
      const q = A.last.ponds.find(z => z.name === p.name);
      if (!q) continue;
      const dz = p.peak - q.peak;
      if (Math.abs(dz) <= 0.1) continue;
      ponds.push({ name: p.name, a: q.peak, b: p.peak, d: +dz.toFixed(2),
                   overtopsChanged: p.overtops !== q.overtops });
    }
    return { a: A, b: B, outlets, ponds };
  }

  /* the diff on the map: the catchments that moved, outlined in amber */
  function showDiff(aId, bId) {
    const d = diff(aId, bId);
    if (!d) return null;
    clearDiff();
    diffLayer = L.layerGroup().addTo(SBMM.map);
    for (const o of d.outlets)
      for (const ring of (o.rings || []))
        L.polygon(ring.map(p => [p[1], p[0]]),
          { pane: "vectors", color: "#FFD34D", weight: 2.4, opacity: .95,
            fillColor: "#FFD34D", fillOpacity: .12, dashArray: "7 5" })
          .bindTooltip(`${esc(o.name)} · ${fmt(o.a, 2)} → ${fmt(o.b, 2)} ac `
            + `(${o.d > 0 ? "+" : ""}${fmt(o.d, 2)})`, { sticky: true, className: "ctip" })
          .addTo(diffLayer);
    if (!d.outlets.length && !d.ponds.length)
      toast("the two scenarios drain the same ground and hold the same stages");
    else
      toast(`${d.outlets.length} catchment${d.outlets.length === 1 ? "" : "s"} and `
          + `${d.ponds.length} pond stage${d.ponds.length === 1 ? "" : "s"} changed`, 4200);
    return d;
  }
  function clearDiff() {
    if (diffLayer) { SBMM.map.removeLayer(diffLayer); diffLayer = null; }
  }

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  function summary(s) {
    if (!s.last) return "not run";
    const over = s.last.ponds.filter(p => p.overtops).length;
    return `${fmt(s.last.site.volume_acft, 0)} ac-ft · peak ${fmt(s.last.site.peak_cfs, 0)} cfs`
      + (over ? ` · <b class="bad">${over} pond${over === 1 ? "" : "s"} overtop</b>` : " · no overtopping");
  }
  function listHtml() {
    if (!list.length)
      return `<div class="note">No scenarios yet. “capture” takes the switches as they stand `
           + `— the storm, the soil-group rule, the storm-drain master switch and every broken `
           + `conduit — and names them.</div>`;
    return `<div class="dspopwrap"><table class="dspop">
      <tr><td class="k"><b>scenario</b></td><td class="v"><b>result</b></td><td class="v"></td></tr>`
      + list.map(s =>
        `<tr><td class="k">${s.id === activeId ? "▸ " : ""}${esc(s.name)}</td>`
        + `<td class="v">${summary(s)}</td>`
        + `<td class="v"><span class="minib" data-s="run" data-id="${s.id}" title="Apply and run">run</span>`
        + `<span class="minib" data-s="dup" data-id="${s.id}" title="Duplicate">copy</span>`
        + `<span class="minib" data-s="ren" data-id="${s.id}" title="Rename">name</span>`
        + `<span class="minib" data-s="del" data-id="${s.id}" title="Delete">✕</span></td></tr>`).join("")
      + `</table></div>`;
  }
  function compareHtml(sel) {
    if (sel.length < 2) return "";
    const rows = compareRows(sel);
    return `<div class="note">Compare</div><div class="dspopwrap"><table class="dspop runoffT">
      <tr><td class="k"><b></b></td>${sel.map(s => `<td class="v"><b>${esc(s.name)}</b></td>`).join("")}</tr>
      ${rows.map(r => `<tr><td class="k">${esc(r[0])}</td>`
        + r[1].map(v => `<td class="v mono">${v}</td>`).join("") + `</tr>`).join("")}
      </table></div>`;
  }

  let picked = [];
  function showCard() {
    if (card && card.isConnected) card.remove();
    card = SBMM.results.card(null, "Scenarios", [
      ["Scenarios", fmt0(list.length)],
      ["Active", activeId ? esc((byId(activeId) || {}).name || "—") : "none applied"],
      ["Compared", picked.length ? picked.length + " selected" : "pick 2–4 to compare"]
    ]);
    const box = document.createElement("div");
    box.innerHTML = listHtml();
    card.appendChild(box);
    /* the picker: 2-4 scenarios, as checkboxes, because a comparison of one is
       a card that already exists */
    if (list.length > 1) {
      const pick = document.createElement("div");
      pick.className = "note";
      pick.innerHTML = "Compare: " + list.map(s =>
        `<label class="scnPick"><input type="checkbox" data-c="${s.id}"`
        + `${picked.includes(s.id) ? " checked" : ""}> ${esc(s.name)}</label>`).join(" ");
      pick.addEventListener("change", ev => {
        const cb = ev.target.closest("[data-c]"); if (!cb) return;
        const id = cb.dataset.c;
        if (cb.checked) { if (picked.length >= 4) { cb.checked = false; toast("compare at most four scenarios"); return; } picked.push(id); }
        else picked = picked.filter(q => q !== id);
        showCard();
      });
      card.appendChild(pick);
      const sel = comparable(picked);
      if (picked.length >= 2 && sel.length < picked.length)
        SBMM.results.appendNote(card, "One of the picked scenarios has not been run — "
          + "run it and the comparison fills in.");
      if (sel.length >= 2) {
        const cmp = document.createElement("div");
        cmp.innerHTML = compareHtml(sel);
        card.appendChild(cmp);
      }
    }
    const acts = document.createElement("div");
    acts.className = "pop-actions";
    acts.innerHTML = `<span class="minib" data-a="new" title="Capture the switches as they stand">capture</span>`
      + `<span class="minib" data-a="diff" title="Highlight what changed between the first two picked">map diff</span>`
      + `<span class="minib" data-a="clr" title="Clear the map diff">clear diff</span>`
      + `<span class="minib" data-a="rep" title="Open the printable comparison sheet">report</span>`
      + `<span class="minib" data-a="csv" title="Copy the comparison as CSV">copy CSV</span>`;
    acts.addEventListener("click", async ev => {
      const b = ev.target.closest("[data-a]"); if (!b) return;
      const a = b.dataset.a;
      if (a === "new") {
        const nm = prompt("Name this scenario", "Scenario " + (list.length + 1));
        if (nm) { add(nm); toast("scenario “" + nm + "” captured — run it to fill it in"); }
      } else if (a === "diff") {
        if (picked.length < 2) { toast("pick two scenarios to diff"); return; }
        showDiff(picked[0], picked[1]);
      } else if (a === "clr") { clearDiff(); toast("map diff cleared"); }
      else if (a === "rep") report();
      else if (a === "csv") copyText(csv(), "scenario comparison copied");
    });
    card.appendChild(acts);
    box.addEventListener("click", async ev => {
      const b = ev.target.closest("[data-s]"); if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.s === "run") { toast("running " + esc((byId(id) || {}).name || id) + "…"); await run(id); }
      else if (b.dataset.s === "dup") duplicate(id);
      else if (b.dataset.s === "del") remove(id);
      else if (b.dataset.s === "ren") {
        const nm = prompt("Rename the scenario", (byId(id) || {}).name || "");
        if (nm) rename(id, nm);
      }
    });
    SBMM.results.appendNote(card, NOTE);
    return card;
  }

  /* ------------------------------------------------------------------ */
  /* CSV and the report sheet                                            */
  /* ------------------------------------------------------------------ */
  function csv() {
    const sel = comparable(picked.length >= 2 ? picked : list.map(s => s.id));
    if (!sel.length) return "";
    let out = "SBMM scenarios\n\n," + sel.map(s => `"${s.name.replace(/"/g, '""')}"`).join(",") + "\n";
    for (const r of compareRows(sel))
      out += `"${r[0]}",` + r[1].map(v => `"${String(v).replace(/<[^>]*>/g, "").replace(/"/g, '""')}"`).join(",") + "\n";
    return out;
  }
  function report() {
    const sel = comparable(picked.length >= 2 ? picked : list.map(s => s.id));
    if (sel.length < 1) { toast("run a scenario first"); return null; }
    if (SBMM.cultural && SBMM.cultural.gateExport && !SBMM.cultural.gateExport("report")) return null;
    if (!SBMM.report || !SBMM.report.openScenarios) {
      toast("the report sheet is not available in this build");
      return null;
    }
    return SBMM.report.openScenarios(sel, compareRows(sel));
  }

  /* ------------------------------------------------------------------ */
  /* the session (additive key `scenarios`)                              */
  /* ------------------------------------------------------------------ */
  /* The RESULTS are kept out of the file on purpose: they are the output of a
     run, they are large (every catchment ring), and a stale one loaded beside a
     newer terrain or network would be a number nobody can trace. A restored
     scenario is a set of switches waiting to be run, which is what it is. */
  function serialize() {
    return list.map(s => ({
      id: s.id, name: s.name, created: s.created,
      storm: s.storm, customP: s.customP, customD: s.customD, dist: s.dist,
      hsg: s.hsg, cn: s.cn, drains: s.drains,
      broken: s.broken, blocked: s.blocked, survey: s.survey, surface: s.surface
    }));
  }
  function restore(arr) {
    if (!Array.isArray(arr)) return 0;
    list = arr.filter(s => s && s.id && s.name).map(s => Object.assign({ last: null }, s));
    for (const s of list) {
      const n = +String(s.id).replace(/\D+/g, "");
      if (n >= seq) seq = n + 1;
    }
    activeId = null;
    if (card && card.isConnected) showCard();
    return list.length;
  }

  /* ------------------------------------------------------------------ */
  /* chrome                                                              */
  /* ------------------------------------------------------------------ */
  function cmd(arg) {
    if (!SBMM.runoff || !SBMM.drainage) {
      toast("scenarios need the drainage map and the design storm, which are not in this build");
      return;
    }
    if (arg && /^new\b/i.test(arg)) { add(arg.replace(/^new\s*/i, "") || null); return; }
    if (!list.length) add("Baseline");
    showCard();
  }
  function wire() { /* the card is opened by the command; nothing to listen for */ }

  return { cmd, wire, add, duplicate, rename, remove, apply, run, diff, showDiff, clearDiff,
           compareRows, showCard, csv, report, serialize, restore,
           list: () => list, active: () => activeId, pick: ids => { picked = ids.slice(0, 4); showCard(); },
           picked: () => picked.slice(), NOTE };
})();
