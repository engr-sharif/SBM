/* SBMM Site Explorer — pipe hydraulics (v19 Phase 3, docs/V19_HYDRO3_SPEC.md §3).

   v12 said, in those words, that a conduit here is a topological shortcut with
   an elevation at each end and that capacity waits for the invert survey. The
   survey still has not happened. This is what can be computed WITHOUT it, said
   plainly:

     * **Manning full-flow capacity** where the CAD gives a diameter and a
       material, `Q = (1.49/n) A R^(2/3) S^(1/2)`;
     * **a slope** from the surveyed inverts where both ends have one, and from
       the lidar rims where they do not — flagged `provisional` in red wherever
       it is the second;
     * **HEC-22 grate-inlet capacity** where a grate has a surveyed size, which
       today is none of them;
     * **a steady-state HGL/EGL pass** from the outfall upstream for a given set
       of inflows (the design storm's peaks, when one has been run), with
       surcharge flagged where the hydraulic grade stands above a rim.

   NOTHING IS INVENTED. On this site's own network all 26 conduits come back
   "unknown — survey pending", because only the two Jacobs pipes at the sandbag
   wall have a surveyed invert and only five conduits carry a size in EA's CAD.
   That is the answer, and the card prints it as the answer rather than dressing
   a guess up as one. `data/storm_survey.csv` is the intake that changes it —
   `node_id, invert_ft, rim_ft, diameter_in, material, date, source`, read by
   tools/build_storm_network.py when it is present.

   Read-only project analysis: nothing here is a store feature and nothing
   serialises into a session. */
"use strict";

SBMM.pipes = (function () {

  /* Manning's n by material. Only these four appear in EA's CAD and in Jacobs'
     survey; anything else is null and the conduit has no capacity. */
  const PIPE_N = { "corrugated HDPE": 0.024, "HDPE": 0.012, "RCP": 0.013,
                   "reinforced concrete": 0.013, "CMP": 0.024,
                   "corrugated metal": 0.024 };
  const COL_OK = "#4FCE9B", COL_NEAR = "#F2C14E", COL_OVER = "#E4796A";
  const NOTE = "Provisional: Manning full-flow capacity, HEC-22 inlet capacity and a "
    + "steady-state hydraulic grade line. No unsteady routing, no storage in the pipes and "
    + "no time. A slope taken from the lidar rims rather than from surveyed inverts is "
    + "marked provisional, and a conduit with no diameter has no capacity at all — "
    + "unknown, survey pending.";

  let R = null;                 // the last hydraulics result
  let colorBy = false;          // colour the conduit layer by capacity ratio
  let card = null, running = null;

  const conduitOf = id => (R ? R.conduits.find(c => c.id === id) : null);
  const nodeOf = id => (R ? R.nodes.find(n => n.id === id) : null);

  /* ------------------------------------------------------------------ */
  /* the job                                                             */
  /* ------------------------------------------------------------------ */
  /* the design storm's peaks at each first-capture point, routed down the
     chain by ADDING them — peaks summed, never routed in time, which is an
     assumption and is printed as one */
  function flowsFromStorm() {
    const RO = SBMM.runoff && SBMM.runoff.result();
    if (!RO || !RO.first || !SBMM.storm) return null;
    const local = {};
    for (const c of RO.first) {
      if (!c.via || !SBMM.storm.conduit(c.via)) continue;
      local[c.via] = (local[c.via] || 0) + (c.qPeak_cfs || 0);
    }
    if (!Object.keys(local).length) return null;
    const total = {};
    for (const c of SBMM.storm.data().conduits) total[c.id] = 0;
    for (const id of Object.keys(local)) {
      let cur = id, guard = 0;
      const seen = new Set();
      while (cur && !seen.has(cur) && guard++ < 100) {
        seen.add(cur);
        total[cur] = (total[cur] || 0) + local[id];
        cur = SBMM.storm.nextOf(cur);
      }
    }
    return total;
  }

  function jobFor(flows) {
    const D = SBMM.storm && SBMM.storm.data();
    if (!D) return null;
    const rims = SBMM.storm.rims();
    const elev = id => {
      const n = SBMM.storm.node(id);
      if (!n) return { z: null, surveyed: false };
      if (n.invert_ft != null) return { z: n.invert_ft, surveyed: true };
      return { z: rims[id] == null ? null : rims[id], surveyed: false };
    };
    return {
      conduits: D.conduits.map(c => {
        const a = elev(c.from), b = elev(c.to), L = c.length_ft || 0;
        /* A SLOPE NEEDS TWO ELEVATIONS OF THE SAME KIND. Both ends surveyed is
           a real slope; both ends read off the lidar is a provisional one. One
           of each is NOT a slope at all — at the sandbag wall it is the
           surveyed pipe invert against the top of the sandbags, which comes out
           adverse and would report a 24-in pipe as running uphill. That is
           exactly the kind of invented number this module refuses to produce,
           so a mixed pair has no slope and the popup says why. */
        const mixed = (a.z != null && b.z != null) && (a.surveyed !== b.surveyed);
        const S = (a.z != null && b.z != null && L > 0 && !mixed) ? (a.z - b.z) / L : null;
        const broken = SBMM.storm.statusOf(c.id) === "broken";
        return {
          id: c.id, from: c.from, to: c.to, length_ft: L,
          diameter_in: c.size_in == null ? null : c.size_in,
          n: (c.material && PIPE_N[c.material] != null) ? PIPE_N[c.material] : null,
          material: c.material || null,
          slope: S,
          slope_source: mixed ? "mixed invert and lidar ground — not a slope"
                              : (a.surveyed && b.surveyed) ? "invert" : "rim",
          slope_provisional: !(a.surveyed && b.surveyed),
          inflow_cfs: (flows && flows[c.id] > 0 && !broken) ? +flows[c.id].toFixed(2) : null,
          next: SBMM.storm.nextOf(c.id)
        };
      }),
      nodes: D.nodes.map(n => ({ id: n.id, kind: n.kind,
        rim_ft: rims[n.id] == null ? null : rims[n.id],
        invert_ft: n.invert_ft == null ? null : n.invert_ft })),
      /* every grate on this site, so the card can say how many have a size —
         which is none of them, and that is the point */
      inlets: D.nodes.filter(n => n.kind === "grate" || n.kind === "round_inlet")
        .map(n => ({ id: n.id, node: n.id, form: "sag",
                     grate: (n.size_in && n.size_in > 0)
                       ? { P_ft: 4 * n.size_in / 12, A_ft2: (n.size_in / 12) * (n.size_in / 12),
                           length_ft: n.size_in / 12 }
                       : null,
                     depth_ft: null })),
      entranceK: 0.5
    };
  }

  async function run(opts) {
    opts = opts || {};
    if (running) return running;
    if (!SBMM.storm || !SBMM.storm.data()) {
      toast("pipe capacity needs the storm network, which is not in this build");
      return null;
    }
    const flows = opts.flows === null ? null : (opts.flows || flowsFromStorm());
    const job = jobFor(flows);
    if (!job) { toast("pipe capacity needs the storm network, which is not in this build"); return null; }
    running = (async () => {
      try {
        const t0 = performance.now();
        const res = await SBMM.compute.run("hydraulics", job,
          { label: "Pipe capacity", silent: true }).promise;
        res.ms_wall = Math.round(performance.now() - t0);
        res.hasFlows = !!flows;
        res.storm = SBMM.runoff && SBMM.runoff.result()
          ? SBMM.runoff.result().storm.name : null;
        R = res;
        return res;
      } catch (e) {
        if (e && e.cancelled) { toast("pipe capacity cancelled"); return null; }
        toast("pipe capacity failed: " + (e.message || e));
        return null;
      }
    })().finally(() => { running = null; });
    return running;
  }

  /* ------------------------------------------------------------------ */
  /* the conduit colouring (§3 "coloured by capacity ratio")             */
  /* ------------------------------------------------------------------ */
  function colorFor(id) {
    if (!colorBy || !R) return null;
    const c = conduitOf(id);
    if (!c || c.ratio == null) return null;
    return c.ratio < 0.8 ? COL_OK : c.ratio < 1 ? COL_NEAR : COL_OVER;
  }
  async function setColorBy(on) {
    colorBy = !!on;
    if (colorBy && !R) { const res = await run(); if (!res) { colorBy = false; return false; } }
    if (SBMM.storm.rebuildConduits) SBMM.storm.rebuildConduits();
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen()) SBMM.viewer3d.refreshOverlays();
    if (colorBy && R && !R.hasFlows)
      toast("no design storm has been run, so no conduit has a flow to compare — "
          + "run RAIN first", 4200);
    else toast(colorBy ? "storm conduits coloured by capacity ratio"
                       : "storm conduits back to their own colour");
    return colorBy;
  }

  /* ------------------------------------------------------------------ */
  /* the popup rows (§3: "the storm popups gain these rows")             */
  /* ------------------------------------------------------------------ */
  /* Returned as HTML rows for js/popups.js to drop into its own table, so the
     2D popup and the 3D pick card are the same words by construction. */
  function rowsForConduit(id) {
    const c = conduitOf(id);
    if (!c) return "";
    const bad = s => `<span class="bad">${esc(s)}</span>`;
    const out = [];
    if (c.capacity_cfs != null) {
      out.push(["Full-flow capacity", fmt(c.capacity_cfs, 1) + " cfs "
        + `<span class="dim">(${fmt(c.diameter_in, 0)} in, n ${c.n}, S `
        + `${fmt(100 * c.slope, 2)} %)</span>`]);
      if (c.slope_provisional)
        out.push(["Slope", bad("provisional — from the lidar rims, not surveyed inverts")]);
      if (c.Q_peak_cfs != null) {
        out.push(["Peak flow" + (R.storm ? " (" + esc(R.storm) + ")" : ""),
                  fmt(c.Q_peak_cfs, 1) + " cfs"]);
        out.push(["Capacity ratio", (c.ratio >= 1 ? bad(fmt(c.ratio, 2) + " — over capacity")
                                                  : fmt(c.ratio, 2))]);
      }
      if (c.hgl_up_ft != null)
        out.push(["Hydraulic grade", fmt(c.hgl_up_ft, 2) + " ft at the inlet"
          + (c.surcharged ? " — " + bad("surcharged by " + fmt(c.surcharge_ft, 2) + " ft") : "")]);
    } else {
      out.push(["Capacity", bad("unknown — survey pending") + " "
        + `<span class="dim">(no ${esc(c.unknown || "data")})</span>`]);
    }
    return out.map(r => `<tr><td class="k">${r[0]}</td><td class="v">${r[1]}</td></tr>`).join("");
  }
  function rowsForNode(id) {
    if (!R) return "";
    const n = nodeOf(id);
    if (!n || n.hgl_ft == null) return "";
    const s = n.surcharged
      ? `<span class="bad">${fmt(n.hgl_ft, 2)} ft — above the ${fmt(n.rim_ft, 2)}-ft rim</span>`
      : fmt(n.hgl_ft, 2) + " ft";
    return `<tr><td class="k">Hydraulic grade</td><td class="v">${s}</td></tr>`;
  }

  /* ------------------------------------------------------------------ */
  /* the card                                                            */
  /* ------------------------------------------------------------------ */
  function tableHtml() {
    const rowsH = R.conduits.map(c => {
      const name = SBMM.storm ? SBMM.storm.shortLabel(c.id) : c.id;
      const cap = c.capacity_cfs == null
        ? `<span class="bad">unknown</span>` : fmt(c.capacity_cfs, 1);
      const q = c.Q_peak_cfs == null ? "—" : fmt(c.Q_peak_cfs, 1);
      const r = c.ratio == null ? "—"
        : (c.ratio >= 1 ? `<b class="bad">${fmt(c.ratio, 2)}</b>` : fmt(c.ratio, 2));
      return `<tr><td class="k">${esc(name)}</td>`
        + `<td class="v mono">${c.diameter_in == null ? "—" : fmt(c.diameter_in, 0)}</td>`
        + `<td class="v mono">${c.slope == null ? "—" : fmt(100 * c.slope, 2)}</td>`
        + `<td class="v mono">${cap}</td><td class="v mono">${q}</td>`
        + `<td class="v mono">${r}</td></tr>`;
    }).join("");
    return `<div class="dspopwrap"><table class="dspop runoffT">
      <tr><td class="k"><b>conduit</b></td><td class="v"><b>in</b></td><td class="v"><b>S %</b></td>
          <td class="v"><b>cap cfs</b></td><td class="v"><b>Q cfs</b></td><td class="v"><b>ratio</b></td></tr>
      ${rowsH}</table></div>`;
  }
  function csv() {
    if (!R) return "";
    let out = "SBMM pipe capacity (provisional)\n";
    out += "design_storm," + (R.storm || "none run") + "\n\n";
    out += "conduit,from,to,length_ft,diameter_in,material,n,slope,slope_source,provisional,"
      + "capacity_cfs,Q_peak_cfs,ratio,hgl_up_ft,hgl_dn_ft,surcharged,unknown\n";
    for (const c of R.conduits)
      out += `${c.id},${c.from},${c.to},${c.length_ft},${c.diameter_in == null ? "" : c.diameter_in},`
        + `${c.material || ""},${c.n == null ? "" : c.n},${c.slope == null ? "" : c.slope.toFixed(5)},`
        + `${c.slope_source || ""},${c.slope_provisional ? "yes" : "no"},`
        + `${c.capacity_cfs == null ? "" : c.capacity_cfs},${c.Q_peak_cfs == null ? "" : c.Q_peak_cfs},`
        + `${c.ratio == null ? "" : c.ratio},${c.hgl_up_ft == null ? "" : c.hgl_up_ft},`
        + `${c.hgl_dn_ft == null ? "" : c.hgl_dn_ft},${c.surcharged ? "yes" : "no"},`
        + `"${c.unknown || ""}"\n`;
    return out;
  }

  function showCard() {
    if (!R) return;
    if (card && card.isConnected) card.remove();
    const known = R.conduits.filter(c => c.capacity_cfs != null).length;
    const withQ = R.conduits.filter(c => c.Q_peak_cfs != null).length;
    card = SBMM.results.card(null, "Pipe capacity", [
      ["Conduits", fmt0(R.totalConduits) + " in the network"],
      ["With a capacity", fmt0(known) + " — the rest are unknown, survey pending"],
      ["Design storm", R.storm || "none run — capacity only"],
      ["With a peak flow", fmt0(withQ)],
      ["Surcharged", R.surcharged.length ? R.surcharged.join(", ") : "none"],
      ["Worst ratio", R.worst ? fmt(R.worst.ratio, 2) + " (" + esc(R.worst.id) + ")" : "—"],
      ["Inlet capacity", R.inlets.filter(i => i.capacity_cfs != null).length
        + " of " + R.inlets.length + " grates have a surveyed size"]
    ]);
    const warn = document.createElement("div");
    warn.className = "note bad";
    warn.textContent = "Provisional. " + R.unknownConduits + " of " + R.totalConduits
      + " conduits have no diameter, roughness or surveyed slope — no capacity is reported for "
      + "them, and none is guessed. Add data/storm_survey.csv and rebuild the network.";
    card.appendChild(warn);
    const box = document.createElement("div");
    box.innerHTML = tableHtml();
    card.appendChild(box);
    const acts = document.createElement("div");
    acts.className = "pop-actions";
    acts.innerHTML = `<span class="minib" data-p="csv" title="Copy the conduit table as CSV">copy CSV</span>`
      + `<span class="minib" data-p="col" title="Colour the storm conduits by capacity ratio">`
      + `${colorBy ? "plain colours" : "colour by ratio"}</span>`
      + `<span class="minib" data-p="re" title="Run the analysis again">recompute</span>`;
    acts.addEventListener("click", async ev => {
      const b = ev.target.closest("[data-p]"); if (!b) return;
      if (b.dataset.p === "csv") copyText(csv(), "pipe capacity copied");
      else if (b.dataset.p === "col") { await setColorBy(!colorBy); showCard(); }
      else { const res = await run({ force: true }); if (res) showCard(); }
    });
    card.appendChild(acts);
    SBMM.results.appendNote(card, NOTE);
  }

  async function cmd() {
    const res = await run();
    if (!res) return;
    showCard();
    toast(`pipe capacity: ${res.totalConduits - res.unknownConduits} of ${res.totalConduits} `
        + `conduits can be rated — the rest need the invert survey`, 4200);
  }

  function wire() { /* nothing to wire: the card and the popups pull on demand */ }

  return { run, cmd, wire, showCard, csv, colorFor, setColorBy,
           rowsForConduit, rowsForNode, flowsFromStorm,
           result: () => R, hasResult: () => !!R, colorBy: () => colorBy,
           PIPE_N, NOTE };
})();
