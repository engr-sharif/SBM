/* SBMM Site Explorer — lab metals by depth (v28).

   One payload, SBMM_DATA.lab_metals, from tools/build_imports.py over the
   engineer's earlier apps (sbmm-tool, ABP):

     holes    { "SB-1": {kind, intervals:[{top, base, clp?, m:{Hg, As, …}}]},
                "TP01": {…} }            the 2025 borings (Hg, As) and the
                                         2025 test pits (the full metals suite)
     samples  { "SS-01": {src, depth, m, q, dl, deep?, om?, rod, pmb, …} }
                                         the 153 ABP / EA sample locations the
                                         Samples layer already plots, with the
                                         validated suite, qualifiers and the
                                         deep and organic-matter results
     levels   { ROD:{Hg,As,Sb,Tl}, PMB:{…} }   mg/kg, read from the ABP table

   Read-only project data; nothing here is a store feature. A build without the
   payload (it is small and in every build, but the rule is the rule) answers
   has() false and every builder returns "" — the popups simply carry no
   metals section. */
"use strict";

SBMM.labMetals = (function () {

  const ORDER = ["Hg", "As", "Sb", "Tl", "Pb", "Cu", "Zn", "Cr", "Ni", "Co", "Cd", "Se", "Ag",
                 "Ba", "Be", "V", "Mn", "Fe", "Al", "Ca", "Mg", "K", "Na"];
  const LEAD = ["Hg", "As", "Sb", "Tl"];

  function data() { return window.SBMM_DATA && SBMM_DATA.lab_metals; }
  function has() { return !!data(); }
  function levels() { const D = data(); return (D && D.levels) || { ROD: {}, PMB: {} }; }
  function hole(id) { const D = data(); return (D && D.holes && D.holes[id]) || null; }
  function sample(id) { const D = data(); return (D && D.samples && D.samples[id]) || null; }

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function fmtV(v) {
    if (v == null) return "—";
    const a = Math.abs(v);
    return a >= 1000 ? Math.round(v).toLocaleString() : a >= 10 ? (+v.toFixed(1)).toString()
      : (+v.toPrecision(2)).toString();
  }

  /* "rod" above the ROD cleanup level, "pmb" above the PMB level, "" below.
     Only the four metals the ABP table screens carry a level. */
  function level(sym, v) {
    if (v == null) return "";
    const L = levels();
    if (L.ROD && L.ROD[sym] != null && v > L.ROD[sym]) return "rod";
    if (L.PMB && L.PMB[sym] != null && v > L.PMB[sym]) return "pmb";
    return "";
  }
  /* a non-detect shows its detection limit, "<1.5", with its qualifier */
  function cell(sym, v, q, dl) {
    const c = level(sym, v);
    const txt = v == null && dl != null ? "<" + fmtV(dl) : fmtV(v);
    return `<td class="v mono${c ? " lm" + c : ""}">${txt}${q ? `<sup>${esc(q)}</sup>` : ""}</td>`;
  }
  function cols(rows) {
    const seen = new Set();
    for (const r of rows) for (const k in r) if (r[k] != null) seen.add(k);
    return ORDER.filter(k => seen.has(k));
  }
  function legend() {
    const L = levels(), bits = [];
    if (L.ROD) bits.push(`<span class="lmrod">ROD</span> ${LEAD.map(k => k + " " + L.ROD[k]).join(" · ")}`);
    if (L.PMB) bits.push(`<span class="lmpmb">PMB</span> ${LEAD.map(k => k + " " + L.PMB[k]).join(" · ")}`);
    return `<div class="lmkey">mg/kg · ${bits.join(" · ")}</div>`;
  }

  /* worst Hg down a hole, for the 3D stick and the summary line */
  function maxOf(id, sym) {
    const h = hole(id);
    if (!h) return null;
    let m = null;
    for (const iv of h.intervals) if (iv.m[sym] != null && (m == null || iv.m[sym] > m)) m = iv.m[sym];
    return m;
  }

  /* ONE table per hole: an interval per row, the four screened metals first
     and every other metal the hole has behind a disclosure. */
  function holeHTML(id) {
    const h = hole(id);
    if (!h || !h.intervals.length) return "";
    const rows = h.intervals;
    const all = cols(rows.map(r => r.m));
    const lead = all.filter(k => LEAD.includes(k) || k === "Pb");
    const rest = all.filter(k => !lead.includes(k));
    const table = ks => `<div class="dspopwrap"><table class="dspop lmtab"><tr><th>ft</th>`
      + ks.map(k => `<th>${k}</th>`).join("") + `</tr>`
      + rows.map(r => `<tr><td class="k mono">${fmtV(r.top)}–${fmtV(r.base)}</td>`
        + ks.map(k => cell(k, r.m[k])).join("") + `</tr>`).join("")
      + `</table></div>`;
    return `<div class="lmsec" data-lab="${esc(id)}"><div class="lmhead">Lab metals by depth`
      + `<span class="mut"> · ${rows.length} interval${rows.length === 1 ? "" : "s"}</span></div>`
      + table(lead)
      + (rest.length ? `<details class="lmmore"><summary>${rest.length} more metals</summary>${table(rest)}</details>` : "")
      + legend() + `</div>`;
  }

  /* a sample location: the validated four with qualifiers, the deep and OM
     results where Round 2 took them, EA's depth profile, and the rest */
  function sampleHTML(id) {
    const s = sample(id);
    if (!s) return "";
    const lead = LEAD.filter(k => s.m[k] != null || (s.dl && s.dl[k] != null) || (s.deep && s.deep.m[k] != null));
    let rows = `<tr><td class="k">${esc(s.depth && /deep/i.test(s.depth) ? "shallow" : (s.depth || "result"))}</td>`
      + lead.map(k => cell(k, s.m[k], s.q && s.q[k], s.dl && s.dl[k])).join("") + `</tr>`;
    if (s.deep)
      rows += `<tr><td class="k">deep</td>` + lead.map(k => cell(k, s.deep.m[k], s.deep.q && s.deep.q[k])).join("") + `</tr>`;
    for (const p of s.profile || [])
      rows += `<tr><td class="k mono">${esc(p.depth)} ft</td>` + lead.map(k => cell(k, p.m[k], p.q && p.q[k])).join("") + `</tr>`;
    let h = `<div class="lmsec" data-lab="${esc(id)}"><div class="lmhead">${esc(s.src)}`
      + (s.date ? `<span class="mut"> · ${esc(s.date)}</span>` : "")
      + (s.validated ? `<span class="mut"> · validated</span>` : "") + `</div>`
      + `<div class="dspopwrap"><table class="dspop lmtab"><tr><th></th>${lead.map(k => `<th>${k}</th>`).join("")}</tr>${rows}</table></div>`;
    const ex = [];
    if (s.rod && s.rod.length) ex.push(`<span class="lmrod">ROD</span> ${esc(s.rod.join(", "))}`);
    if (s.pmb && s.pmb.length) ex.push(`<span class="lmpmb">PMB</span> ${esc(s.pmb.join(", "))}`);
    if (ex.length) h += `<div class="lmex" data-rod="${esc((s.rod || []).join(","))}">exceeds · ${ex.join(" · ")}</div>`;
    if (s.om) h += `<div class="lmline">Hg with organics ${fmtV(s.om.Hg)}${s.om.q ? `<sup>${esc(s.om.q)}</sup>` : ""} mg/kg`
      + (s.om.effect ? ` · ${esc(s.om.effect)}` : "") + `</div>`;
    const rest = ORDER.filter(k => !LEAD.includes(k) && s.m[k] != null);
    if (rest.length)
      h += `<details class="lmmore"><summary>${rest.length} more metals</summary><div class="dspopwrap"><table class="dspop lmtab">`
        + rest.map(k => `<tr><td class="k">${k}</td>${cell(k, s.m[k], s.q && s.q[k], s.dl && s.dl[k])}</tr>`).join("")
        + `</table></div></details>`;
    if (s.note) h += `<div class="lmline mut">${esc(s.note)}</div>`;
    return h + legend() + `</div>`;
  }

  /* the CSV a table view or a harness can read: one row per interval */
  function csv() {
    const D = data();
    if (!D) return "";
    const out = ["id,kind,top_ft,base_ft," + ORDER.join(",")];
    for (const id in D.holes)
      for (const iv of D.holes[id].intervals)
        out.push([id, D.holes[id].kind, iv.top, iv.base].concat(ORDER.map(k => iv.m[k] == null ? "" : iv.m[k])).join(","));
    return out.join("\n");
  }

  function counts() {
    const D = data();
    if (!D) return { holes: 0, samples: 0 };
    const H = Object.values(D.holes || {});
    return { holes: H.length, borings: H.filter(h => h.kind === "boring").length,
             testpits: H.filter(h => h.kind === "testpit").length,
             intervals: H.reduce((s, h) => s + h.intervals.length, 0),
             samples: Object.keys(D.samples || {}).length };
  }

  return { has, hole, sample, levels, level, maxOf, holeHTML, sampleHTML, csv, counts };
})();
