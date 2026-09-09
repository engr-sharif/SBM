/* SBMM Site Explorer — the 2025 boring logs (OpenGround export).

   44 soil borings were drilled in October–December 2025 and logged in
   OpenGround. tools/build_borings.py turns the per-table CSV export into
   SBMM_DATA.borings_logs — strata, SPT drives, pocket-penetrometer readings,
   the lab values the loggers wrote into the remarks column, the water level and
   the drilling method by depth — and hangs the headline numbers off the baked
   dataset ds_borings2025 so the map symbol already answers the common question.
   This module is what draws the LOG: a strip log in the results card, one hole
   at a time, plus the 44-row reconciliation table.

   THE TWO CONTACT NUMBERS, AND WHY THE REMARK LEADS. "How deep is the waste
   here" has two answers in the approved logs and they do not always agree:

     1. the logger's own remark  "@ 23' NATIVE CONTACT", written on the rig by
        the person looking at the core. Every one of the 44 holes has one, and
        it is the number the app leads with.
     2. the strata rows          the deepest stratum whose description ends in
        WASTE (`contacts.waste_base_strata`) — a second reading of the same
        log, derived rather than stated.

   The older field-interpreted waste depth spreadsheet was a third statement
   until 2026-09-09 and is RETIRED: the logs are the approved record and the
   spreadsheet answered a different question (blow counts, pH, soil type). It is
   no longer in the dataset and nothing here reads it.

   NOTHING HERE RESOLVES A DISAGREEMENT. 18 of the 44 holes carry at least one
   flag; the log draws both lines, the card names each one, and the summary
   table (LOGS) is the sheet the engineer reconciles them on. Inventing a third
   number by averaging or by preferring the "cleaner" source would hide exactly
   the thing he needs to look at.

   THE COORDINATES ARE THE BAKED ONES. OpenGround plots every hole a constant
   (-3.8, +1.9) ft from the December-2025 coordinate spreadsheet the dataset was
   baked from, while its lat/long is identical to that spreadsheet's — a datum
   realisation difference, not a survey disagreement. The baked coordinates are
   the ones that check against the lidar, so they are the ones used; the offset
   is measured on every build and the card says so in one line rather than
   silently dropping it.

   Payload tolerance (v19.1): SBMM_DATA.borings_logs is small (~300 kB) and is
   in every build, folder and phone included — but if it is ever absent, every
   entry point here refuses with a toast and nothing throws. `has()` is the one
   question; every caller outside this file asks it through a guard. */
"use strict";

SBMM.borelogs = (function () {

  /* The payload is read LIVE rather than captured at parse time, and the index
     is rebuilt only when the object identity changes — so `has()` is an honest
     answer to "is the payload here" in a build that never shipped it, and the
     harness can prove the refusal by deleting the key. It costs one identity
     comparison per call. */
  let D = null, HOLES = [], BY = new Map();
  function sync() {
    const d = (window.SBMM_DATA && SBMM_DATA.borings_logs) || null;
    if (d === D) return;
    D = d;
    HOLES = (D && Array.isArray(D.holes)) ? D.holes : [];
    BY = new Map(HOLES.map(h => [h.id, h]));
  }

  const has = () => { sync(); return HOLES.length > 0; };
  const data = () => { sync(); return D; };
  const ids = () => { sync(); return HOLES.map(h => h.id); };
  const byId = id => { sync(); return BY.get(normId(id)) || null; };
  const holes = () => { sync(); return HOLES; };

  let cardEl = null, curId = null, sumEl = null;
  let sortKey = "id", sortDir = 1;

  function normId(v) {
    let s = String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "");
    if (/^\d+[A-Z]?$/.test(s)) s = "SB-" + s;
    return s.replace(/^SB[-_]?/, "SB-");
  }

  /* ------------------------------------------------------------------ */
  /* the class palette — ONE source of truth                             */
  /* ------------------------------------------------------------------ */
  /* The strip log, the 3D stick and the legend all have to agree about what
     "waste" looks like, so the colours live in css/app.css :root next to the
     water and storm tokens and everything asks for them here. js/viewer3d.js
     calls classColor() rather than carrying a second copy: a duplicated palette
     is a palette that drifts. The literals below are the fallback for a build
     whose stylesheet did not load, and nothing else. */
  const CLASSES = ["waste", "native", "bedrock", "unknown"];
  const VARS = { waste: "--bl-waste", native: "--bl-native", bedrock: "--bl-rock",
                 unknown: "--bl-unknown", contact: "--bl-contact" };
  const FALLBACK = { waste: "#E0733F", native: "#7FC77A", bedrock: "#9B8BD6",
                     unknown: "#6C7F8A", contact: "#FFD34D" };
  let palette = null;
  function classColor(cls) {
    if (!palette) {
      palette = {};
      let cs = null;
      try { cs = getComputedStyle(document.documentElement); } catch (e) { /* no DOM yet */ }
      for (const k in VARS) {
        const v = cs ? (cs.getPropertyValue(VARS[k]) || "").trim() : "";
        palette[k] = v || FALLBACK[k];
      }
    }
    return palette[cls] || palette.unknown;
  }
  const CLASS_WORD = { waste: "mine waste", native: "native soil",
                       bedrock: "bedrock", unknown: "not classed" };

  /* ------------------------------------------------------------------ */
  /* the facts a caller wants without opening a card                     */
  /* ------------------------------------------------------------------ */
  function profileOf(id) {
    const h = byId(id);
    return h && Array.isArray(h.profile) && h.profile.length ? h.profile : null;
  }
  function contactOf(id) { const h = byId(id); return h ? h.contacts || null : null; }
  function waterOf(id) { const h = byId(id); return h ? h.water || null : null; }

  const differs = (a, b) => a != null && b != null && Math.abs(a - b) > 0.01;

  function summaryLine(h) {
    const c = h.contacts || {};
    const bits = [];
    if (c.native_contact != null)
      bits.push(`native contact ${fmt(c.native_contact, 1)} ft (${c.source === "remark" ? "logger's remark" : "from strata"})`);
    if (c.waste_thickness_strata != null)
      bits.push(`${fmt(c.waste_thickness_strata, 1)} ft of waste logged`);
    const w = h.water;
    bits.push(w && w.encountered && w.depth != null
      ? `groundwater ${fmt(w.depth, 1)} ft bgs${w.perched ? " (perched)" : ""}`
      : "groundwater not encountered");
    return bits;
  }

  /* ================================================================== */
  /* the strip log                                                       */
  /* ================================================================== */
  /* Geometry. Every colour is written as a presentation ATTRIBUTE rather than a
     CSS class, because the PNG export serialises this SVG and hands it to an
     <img>: a document stylesheet does not travel with it, and a log exported in
     four shades of black is worse than no export at all. Classes are here for
     the harness and for hit-testing only. */
  /* The card is ~300 px wide in the right dock, and every column below was
     sized against that: at 336 the headings ran into each other, the SPT
     labels crossed into the pH column and the profile band's own word
     overflowed it. Nothing is squeezed by scaling — the SVG is drawn at the
     width it is read at. */
  const W = 300, TOPM = 26, BOTM = 22;
  const AX = 20;                 /* depth labels end here            */
  const MET = [22, 26];          /* drilling-method strip            */
  const PROF = [29, 47];         /* the class profile band           */
  const STR = [50, 106];         /* the primary strata boxes         */
  const SPT = [110, 190];        /* SPT N (0–50) and PP (0–4.5 tsf)  */
  const SPT_TXT = 28;            /* room kept at its right for the N */
  const PHC = [194, 244];        /* pH, 2–8                          */
  const EAX = 248;               /* elevation labels start here      */
  const N_MAX = 50, PP_MAX = 4.5, PH_LO = 2, PH_HI = 8, PH_ACID = 4;
  /* a dark halo under any label that crosses a column, so an annotation is
     readable over whatever it happens to lie on */
  const HALO = ' stroke="#0D1215" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round"';

  function tickStep(depth) { return depth <= 30 ? 5 : depth <= 80 ? 10 : 20; }

  function svgLog(h) {
    const depth = h.depth || h.strata_base || 1;
    /* 6 px/ft is the floor the card scrolls at; a short hole is drawn bigger so
       an 11-ft log is not a postage stamp */
    const ppf = clamp(520 / depth, 6, 14);
    const Y = ft => TOPM + ft * ppf;
    const H = TOPM + depth * ppf + BOTM;
    const el = h.elev;
    const p = [];
    const line = (x1, y1, x2, y2, col, w, dash, cls, attrs) =>
      `<line class="${cls || ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"`
      + ` stroke="${col}" stroke-width="${w || 1}"${dash ? ` stroke-dasharray="${dash}"` : ""}${attrs || ""}/>`;
    const text = (x, y, s, col, size, anchor, extra) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${col}" font-size="${size || 9}"`
      + `${anchor ? ` text-anchor="${anchor}"` : ""}${extra || ""}>${esc(s)}</text>`;

    /* --- column headings ------------------------------------------- */
    p.push(text(PROF[0], 10, "cls", "#8FA3AE", 8.5));
    p.push(text(STR[0], 10, "strata", "#8FA3AE", 8.5));
    p.push(text(SPT[0], 10, "SPT · PP", "#8FA3AE", 8.5));
    p.push(text(PHC[0], 10, "pH", "#8FA3AE", 8.5));
    p.push(text(EAX, 10, "elev", "#8FA3AE", 8.5));
    p.push(text(AX, 10, "ft bgs", "#8FA3AE", 8.5, "end"));

    /* --- the depth / elevation axes -------------------------------- */
    const step = tickStep(depth);
    for (let ft = 0; ft <= depth + 1e-6; ft += step) {
      const y = Y(Math.min(ft, depth));
      p.push(line(AX + 1, y, EAX - 3, y, "rgba(44,59,69,.55)", 1));
      p.push(text(AX - 2, y + 3, String(Math.round(ft)), "#6C7F8A", 8.5, "end"));
      if (el != null) p.push(text(EAX, y + 3, fmt0(el - ft), "#6C7F8A", 8.5));
    }
    /* the last foot is where the hole was terminated — always labelled */
    const yEnd = Y(depth);
    p.push(line(AX + 1, yEnd, EAX - 3, yEnd, "#3A4C58", 1.2));
    p.push(text(AX - 2, yEnd + 9, fmt(depth, 1), "#C3D0D7", 8.5, "end"));

    /* --- the drilling-method strip (hand auger vs sonic) ------------ */
    for (const m of (h.methods || [])) {
      const y0 = Y(Math.max(0, m.top)), y1 = Y(Math.min(depth, m.base));
      if (y1 - y0 < 0.5) continue;
      const auger = /auger/i.test(m.method || "");
      p.push(`<rect class="blmethod" x="${MET[0]}" y="${y0.toFixed(1)}" width="${MET[1] - MET[0]}"`
        + ` height="${(y1 - y0).toFixed(1)}" fill="${auger ? "#3E5763" : "#26343D"}"`
        + ` stroke="#0D1215" stroke-width=".5"><title>${esc(m.method || "")} `
        + `${fmt(m.top, 1)}–${fmt(m.base, 1)} ft</title></rect>`);
    }

    /* --- column 1: the class profile -------------------------------- */
    for (const r of (h.profile || [])) {
      const y0 = Y(Math.max(0, r.top)), y1 = Y(Math.min(depth, r.base));
      if (y1 - y0 < 0.4) continue;
      p.push(`<rect class="blprof" data-cls="${esc(r.cls)}" x="${PROF[0]}" y="${y0.toFixed(1)}"`
        + ` width="${PROF[1] - PROF[0]}" height="${(y1 - y0).toFixed(1)}" fill="${classColor(r.cls)}"`
        + ` fill-opacity=".85" stroke="#0D1215" stroke-width=".6">`
        + `<title>${esc(CLASS_WORD[r.cls] || r.cls)} ${fmt(r.top, 1)}–${fmt(r.base, 1)} ft</title></rect>`);
      /* the band carries no word: at 18 px it would overflow into the strata
         column, and the legend under the SVG plus the tooltip already name it */
    }

    /* --- column 2: the primary strata ------------------------------- */
    (h.strata || []).forEach((s, i) => {
      const y0 = Y(Math.max(0, s.top)), y1 = Y(Math.min(depth, s.base));
      if (!s.primary) {
        /* a sub-row (a colour or moisture change inside a stratum) is a tick on
           the right edge, not a box — the box is the stratum */
        if (y0 > TOPM && y0 < Y(depth))
          p.push(`<line class="blsub" data-i="${i}" x1="${(STR[1] - 9).toFixed(1)}" y1="${y0.toFixed(1)}"`
            + ` x2="${STR[1]}" y2="${y0.toFixed(1)}" stroke="#8FA3AE" stroke-width="1">`
            + `<title>${esc((s.name || s.uscs || "sub-unit") + " @ " + fmt(s.top, 1) + " ft")}</title></line>`);
        return;
      }
      if (y1 - y0 < 0.4) return;
      p.push(`<rect class="blstrat" data-i="${i}" x="${STR[0]}" y="${y0.toFixed(1)}"`
        + ` width="${STR[1] - STR[0]}" height="${(y1 - y0).toFixed(1)}" fill="${classColor(s.cls)}"`
        + ` fill-opacity=".22" stroke="${classColor(s.cls)}" stroke-width=".8" style="cursor:pointer">`
        + `<title>${esc(fmt(s.top, 1) + "–" + fmt(s.base, 1) + " ft  " + (s.uscs || "") + "  " + (s.desc || s.name || ""))}</title></rect>`);
      /* the USCS symbol only: the unit's name and its full description are one
         click away in the expander, and a second line here crosses the column */
      if (y1 - y0 > 10 && s.uscs)
        p.push(text(STR[0] + 3, (y0 + y1) / 2 + 3.2, s.uscs, "#E8EEF1", 9, null, ' font-weight="600"'));
    });

    /* --- column 3: SPT and the pocket penetrometer ------------------- */
    /* the N axis stops SPT_TXT short of the column's right edge, so a 50-blow
       bar and the number printed beside it can never sit on top of each other */
    const nW = SPT[1] - SPT_TXT - SPT[0];
    const nx = n => SPT[0] + nW * clamp(n / N_MAX, 0, 1);
    p.push(line(SPT[0], TOPM, SPT[0], Y(depth), "rgba(44,59,69,.9)", 1));
    for (const s of (h.spt || [])) {
      const y = Y(clamp((s.top + s.base) / 2, 0, depth));
      const ref = s.refusal || s.n == null;
      const w = ref ? nW : Math.max(1.5, nx(s.n) - SPT[0]);
      p.push(`<rect class="blspt" data-ref="${esc(s.ref || "")}" data-n="${s.n == null ? "" : s.n}"`
        + ` data-refusal="${ref ? 1 : 0}" x="${SPT[0]}" y="${(y - 2.5).toFixed(1)}" width="${w.toFixed(1)}"`
        + ` height="5" fill="${ref ? "#E4796A" : "#4FB3CE"}" fill-opacity="${ref ? ".9" : ".8"}">`
        + `<title>${esc((s.ref || "") + "  " + fmt(s.top, 1) + "–" + fmt(s.base, 1) + " ft  N = " + (s.n_text || "—")
            + (s.rec_pct != null ? "  rec " + fmt0(s.rec_pct) + "%" : "")
            + (s.blows_6in ? "  " + s.blows_6in.map(b => fmt0(b)).join("-") : ""))}</title></rect>`);
      /* the number, not the sample reference — that is in the tooltip and in
         the CSV, and printing it here is what crossed into the pH column */
      p.push(text(SPT[1], y + 3, s.n_text || "—", ref ? "#E4796A" : "#C3D0D7", 8, "end"));
    }
    for (const q of (h.pen || [])) {
      const y = Y(clamp(q.depth, 0, depth));
      const x = SPT[0] + nW * clamp(q.tsf / PP_MAX, 0, 1);
      p.push(`<path class="blpen" d="M${x.toFixed(1)} ${(y - 3).toFixed(1)} L${(x + 3).toFixed(1)} ${y.toFixed(1)} `
        + `L${x.toFixed(1)} ${(y + 3).toFixed(1)} L${(x - 3).toFixed(1)} ${y.toFixed(1)} Z" fill="none"`
        + ` stroke="#E8B34B" stroke-width="1"><title>pocket penetrometer ${fmt(q.tsf, 2)} tsf @ ${fmt(q.depth, 2)} ft</title></path>`);
    }

    /* --- column 4: pH, with the acid-generating threshold ------------ */
    const phx = v => PHC[0] + (PHC[1] - PHC[0]) * clamp((v - PH_LO) / (PH_HI - PH_LO), 0, 1);
    p.push(line(PHC[0], TOPM, PHC[0], Y(depth), "rgba(44,59,69,.9)", 1));
    /* pH under 4 is the acid-generating signature of the mine waste on this
       site — the one lab value measured on nearly every drive, so it is the one
       that belongs in the strip rather than in the table underneath */
    p.push(line(phx(PH_ACID), TOPM, phx(PH_ACID), Y(depth), "#E4796A", 1, "2 3", "blph4"));
    p.push(text(phx(PH_ACID) + 2, TOPM - 2, "pH 4", "#E4796A", 8));
    for (const t of (h.tests || [])) {
      if (t.key !== "pH" || t.depth == null) continue;
      const y = Y(clamp(t.depth, 0, depth)), x = phx(t.value);
      p.push(`<circle class="blph" data-ph="${t.value}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"`
        + ` fill="${t.value < PH_ACID ? "#E4796A" : "#7CD0E6"}">`
        + `<title>pH ${fmt(t.value, 1)} @ ${fmt(t.depth, 2)} ft</title></circle>`);
    }

    /* --- the two contact statements --------------------------------- */
    const c = h.contacts || {};
    const nc = c.native_contact, sc = c.waste_base_strata;
    if (sc != null && differs(sc, nc)) {
      const y = Y(clamp(sc, 0, depth));
      p.push(line(AX + 1, y, EAX - 3, y, "#C3D0D7", 1, "5 3", "blstrataline", ` data-ft="${sc}"`));
      p.push(text(EAX - 4, y - 3, `strata ${fmt(sc, 1)} ft`, "#C3D0D7", 8, "end", HALO));
    }
    if (nc != null) {
      const y = Y(clamp(nc, 0, depth));
      p.push(line(AX + 1, y, EAX - 3, y, classColor("contact"), 2, null, "blcontact",
        ` data-ft="${nc}" data-src="${esc(c.source || "")}"`));
      p.push(text(AX + 3, y - 4,
        `native contact ${fmt(nc, 1)} ft · ${c.source === "remark" ? "remark" : "strata"}`,
        classColor("contact"), 8.5, null, ' font-weight="600"' + HALO));
    }

    /* --- the water level -------------------------------------------- */
    const w = h.water;
    if (w && w.encountered && w.depth != null) {
      const y = Y(clamp(w.depth, 0, depth));
      p.push(line(AX + 1, y, EAX - 3, y, "#55C1FF", 1, "4 2"));
      /* the standard inverted triangle, sitting on the level it marks */
      const wx = STR[0] + 2;
      p.push(`<polygon class="blwater" data-ft="${w.depth}" points="${wx},${(y - 6).toFixed(1)} `
        + `${(wx + 10)},${(y - 6).toFixed(1)} ${(wx + 5)},${y.toFixed(1)}" fill="#55C1FF">`
        + `<title>groundwater ${fmt(w.depth, 1)} ft bgs${w.perched ? " (perched)" : ""}`
        + `${w.event ? " — " + esc(w.event) : ""}</title></polygon>`);
      p.push(text(wx + 13, y - 1, `GW ${fmt(w.depth, 1)} ft${w.perched ? " (perched)" : ""}`,
        "#9FDCFF", 8, null, HALO));
    }

    return `<svg class="blsvg" viewBox="0 0 ${W} ${Math.ceil(H)}" width="${W}" height="${Math.ceil(H)}"`
      + ` xmlns="http://www.w3.org/2000/svg" role="img">`
      + `<style>text{font-family:"SF Mono",ui-monospace,Consolas,Menlo,monospace;font-size:9px}</style>`
      + `<rect x="0" y="0" width="${W}" height="${Math.ceil(H)}" fill="none"/>`
      + p.join("") + `</svg>`;
  }

  /* ------------------------------------------------------------------ */
  /* the tables under the strip                                          */
  /* ------------------------------------------------------------------ */
  function descHtml(h) {
    const rows = (h.strata || []).map((s, i) =>
      `<tr data-i="${i}" class="${s.primary ? "" : "sub"}">`
      + `<td class="num">${fmt(s.top, 1)}–${fmt(s.base, 1)}</td>`
      + `<td class="u">${esc(s.uscs || "")}</td>`
      + `<td><span class="cdot" style="background:${classColor(s.cls)}"></span>`
      + `${esc(s.desc || s.name || "")}${s.cls_inherited ? ' <span class="mut">(class inherited)</span>' : ""}</td></tr>`).join("");
    return `<details class="bldesc"><summary>descriptions — ${(h.strata || []).length} logged units</summary>`
      + `<div class="blscroll"><table class="bltbl">${rows}</table></div></details>`;
  }

  function labHtml(h) {
    const t = (h.tests || []).filter(x => x.key !== "pH" && x.key !== "PP");
    if (!t.length) return "";
    const at = new Map();
    for (const x of t) {
      const k = x.depth == null ? "—" : fmt(x.depth, 2);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(`${esc(x.key)} ${fmt(x.value, x.value % 1 ? 2 : 0)}${x.unit ? " " + esc(x.unit) : ""}`);
    }
    const rows = [...at.entries()].map(([d, v]) =>
      `<tr><td class="num">${esc(d)}</td><td>${v.join(" · ")}</td></tr>`).join("");
    return `<details class="bldesc"><summary>lab values — ${t.length} results</summary>`
      + `<div class="blscroll"><table class="bltbl">${rows}</table></div></details>`;
  }

  function notesHtml(h) {
    if (!(h.notes || []).length) return "";
    const rows = h.notes.map(n =>
      `<tr><td class="num">${n.depth == null ? "" : fmt(n.depth, 1)}</td><td>${esc(n.text)}</td></tr>`).join("");
    return `<details class="bldesc"><summary>log notes — ${h.notes.length}</summary>`
      + `<div class="blscroll"><table class="bltbl">${rows}</table></div></details>`;
  }

  /* ------------------------------------------------------------------ */
  /* CSV                                                                 */
  /* ------------------------------------------------------------------ */
  /* One long table with a `table` column rather than four files: a hole's log is
     one thing, and a spreadsheet reader filters a column faster than it opens
     four downloads. The four table names are strata / spt / pen / tests. */
  const q = v => v == null || v === "" ? "" : `"${String(v).replace(/"/g, '""')}"`;
  function csvFor(id) {
    const h = byId(id);
    if (!h) return "";
    let out = "table,hole,top_ft,base_ft,depth_ft,key,value,unit,text\n";
    for (const s of (h.strata || []))
      out += `strata,${q(h.id)},${s.top},${s.base},,${q(s.uscs)},,,${q((s.primary ? "" : "[sub-unit] ") + (s.desc || s.name || ""))}\n`;
    for (const s of (h.spt || []))
      out += `spt,${q(h.id)},${s.top},${s.base},,${q(s.ref)},${s.n == null ? "" : s.n},${q("blows/ft")},`
        + `${q((s.n_text || "") + (s.refusal ? " refusal" : "") + (s.rec_pct != null ? ", rec " + s.rec_pct + "%" : "")
              + (s.blows_6in ? ", " + s.blows_6in.join("-") : ""))}\n`;
    for (const p of (h.pen || []))
      out += `pen,${q(h.id)},,,${p.depth},PP,${p.tsf},tsf,\n`;
    for (const t of (h.tests || []))
      out += `tests,${q(h.id)},${t.interval ? t.interval[0] : ""},${t.interval ? t.interval[1] : ""},`
        + `${t.depth == null ? "" : t.depth},${q(t.key)},${t.value},${q(t.unit)},${q(t.method)}\n`;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* open                                                                */
  /* ------------------------------------------------------------------ */
  function open(id) {
    if (!has()) { toast("this build has no boring logs"); return null; }
    const h = byId(id);
    if (!h) { toast(`no boring log for “${id}” — type LOGS for the list`); return null; }
    if (cardEl) { try { cardEl.remove(); } catch (e) { /* already gone */ } cardEl = null; }

    const c = h.contacts || {}, w = h.water;
    const m0 = (h.methods || [])[0] || {};
    const rows = [];
    rows.push(["Native contact", c.native_contact == null ? "not stated"
      : `${fmt(c.native_contact, 1)} ft · ${c.source === "remark" ? "logger's remark" : "from the strata"}`]);
    if (c.waste_base_strata != null)
      rows.push(["Waste base — strata", `${fmt(c.waste_base_strata, 1)} ft`
        + (c.waste_thickness_strata != null ? ` · ${fmt(c.waste_thickness_strata, 1)} ft of waste` : "")]);
    rows.push(["Bedrock", c.bedrock_top == null ? "not reached" : `${fmt(c.bedrock_top, 1)} ft`]);
    rows.push(["Groundwater", w && w.encountered && w.depth != null
      ? `${fmt(w.depth, 1)} ft bgs${w.perched ? " · perched" : ""}${w.event ? " · " + w.event.toLowerCase() : ""}`
      : (w ? "not encountered" : "not recorded")]);
    rows.push(["Total depth", `${fmt(h.depth, 1)} ft`
      + (h.elev != null ? ` · base ${fmt(h.elev - h.depth, 1)} ft` : "")]);
    if (h.elev != null) rows.push(["Ground elevation", `${fmt(h.elev, 1)} ft`]);
    rows.push(["Drilled", `${h.date_start || "—"}${h.date_end && h.date_end !== h.date_start ? " to " + h.date_end : ""}`
      + ` · ${h.method_words || "—"}`]);
    rows.push(["Logged by", `${h.logger || "—"}${h.checked_by ? " · checked " + h.checked_by : ""}`]);
    if (m0.driller || m0.contractor)
      rows.push(["Driller", [m0.driller, m0.contractor, m0.equipment].filter(Boolean).join(" · ")]);
    if ((c.flags || []).length)
      rows.push(["Flags", c.flags.join(" · ")]);

    const el = SBMM.results.card(null, "Boring log — " + h.id, rows);
    cardEl = el; curId = h.id;
    el.classList.add("blcard");
    const x = el.querySelector('[data-a="del"]');
    if (x) x.onclick = () => close();

    /* the strip */
    const wrap = document.createElement("div");
    wrap.className = "blwrap";
    wrap.innerHTML = svgLog(h);
    el.appendChild(wrap);

    /* the legend — three colours and what they mean */
    const leg = document.createElement("div");
    leg.className = "legend blleg";
    leg.innerHTML = CLASSES.filter(k => (h.profile || []).some(r => r.cls === k))
      .map(k => `<span class="lg"><i style="background:${classColor(k)}"></i>${esc(CLASS_WORD[k])}</span>`).join("");
    el.appendChild(leg);

    /* the two statements, in words, because the lines alone do not say which
       is which and 18 of the 44 holes disagree */
    const note = document.createElement("div");
    note.className = "note blstate";
    /* every one of the 44 holes in this payload has a remark, but the source is
       DATA and the sentence follows it rather than assuming it */
    const dStrata = differs(c.waste_base_strata, c.native_contact);
    note.innerHTML = `<b>${fmt(c.native_contact, 1)} ft</b> is `
      + (c.source === "remark" ? "the logger's own remark on the rig" : "read off the strata rows")
      + (dStrata
          ? `; the strata rows put the base of the waste at <b>${fmt(c.waste_base_strata, 1)} ft</b>`
          : (c.waste_base_strata != null ? `, and the strata rows agree` : ""))
      + (c.waste_layered_below_native
          ? `. Waste is logged BELOW native here — the profile is interlayered, not a single contact` : "")
      + (dStrata
          ? `. Nothing is reconciled: both are drawn.`
          : `. Both statements agree on this hole.`);
    el.appendChild(note);

    el.insertAdjacentHTML("beforeend", descHtml(h) + labHtml(h) + notesHtml(h));

    /* clicking a stratum box opens the descriptions and flashes its row */
    wrap.addEventListener("click", ev => {
      const r = ev.target.closest && ev.target.closest("[data-i]");
      if (!r) return;
      const det = el.querySelector("details.bldesc");
      if (!det) return;
      det.open = true;
      const tr = det.querySelector(`tr[data-i="${r.dataset.i}"]`);
      if (!tr) return;
      scrollIntoPane(tr);
      tr.classList.add("flash");
      setTimeout(() => tr.classList.remove("flash"), 1400);
    });

    /* the buttons */
    const btns = document.createElement("div");
    btns.className = "crow btns";
    btns.innerHTML = `<button class="minib" data-b="prev" title="Previous boring">‹ prev</button>`
      + `<button class="minib" data-b="next" title="Next boring">next ›</button>`
      + `<button class="minib" data-b="zoom" title="Zoom the map to this boring">zoom to</button>`
      + `<button class="minib" data-b="3d" title="Open the 3D view at this boring">3D</button>`
      + `<button class="minib" data-b="csv" title="Copy the strata, SPT, penetrometer and lab tables as CSV">copy CSV</button>`
      + `<button class="minib" data-b="png" title="Save the strip log as a PNG">PNG</button>`;
    btns.addEventListener("click", ev => {
      const b = ev.target.dataset && ev.target.dataset.b;
      if (!b) return;
      if (b === "prev" || b === "next") step(b === "next" ? 1 : -1);
      if (b === "zoom") zoomTo(h);
      if (b === "3d") { if (SBMM.viewer3d) SBMM.viewer3d.openAt(h.x, h.y); }
      if (b === "csv") copyText(csvFor(h.id), `${h.id} log copied as CSV`);
      if (b === "png") exportPng(h);
    });
    el.appendChild(btns);

    /* provenance, and the coordinate decision in one line */
    const off = D.openground_offset_ft || {};
    SBMM.results.appendNote(el,
      `${fmt0(h.x)} E, ${fmt0(h.y)} N (EPSG:6418) · ${h.lat != null ? h.lat.toFixed(6) + ", " + h.lon.toFixed(6) : ""}`
      + (off.dE_mean != null
          ? ` — OpenGround plots this hole ${fmt(Math.abs(off.dE_mean), 1)} ft `
            + `${off.dE_mean < 0 ? "W" : "E"} / ${fmt(Math.abs(off.dN_mean), 1)} ft `
            + `${off.dN_mean < 0 ? "S" : "N"} of the surveyed coordinate; the surveyed one is used.`
          : ""));
    SBMM.results.appendNote(el,
      "OpenGround export of the 2025 Jacobs geotechnical investigation, "
      + (D.built || "") + ". The class of each unit is the last word of the logger's own description "
      + "(WASTE / NATIVE / BEDROCK); no depth here is interpolated or interpreted by the app.");
    /* results.card PREPENDS, so the new card is the pane's first child — and a
       log taller than the pane must show its HEAD (the contact, the depth, the
       dates), not its foot, which is what scrolling it "into view" would do */
    const pane = scrollIntoPane(el);
    if (pane) pane.scrollTop = 0;
    return el;
  }

  function close() {
    if (cardEl) { try { cardEl.remove(); } catch (e) { /* gone */ } }
    cardEl = null; curId = null;
    if (SBMM.results) SBMM.results.checkEmpty();
  }
  function step(d) {
    const list = ids();
    const i = list.indexOf(curId);
    if (i < 0) return;
    open(list[(i + d + list.length) % list.length]);
  }
  function zoomTo(h) {
    if (!SBMM.map) return;
    SBMM.map.setView([h.y, h.x], Math.max(SBMM.map.getZoom(), 4));
  }

  /* the strip log as a picture. Every canvas export in this app goes through
     SBMM.watermark.burn (v9 §watermark) — an element is not in a PNG. */
  function exportPng(h) {
    const svg = svgLog(h);
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    const w = m ? +m[1] : W, hh = m ? +m[2] : 600, k = 2;
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = w * k; cv.height = hh * k;
        const g = cv.getContext("2d");
        g.fillStyle = "#161E23"; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        g.fillStyle = "#E8EEF1"; g.font = "600 22px system-ui,sans-serif";
        g.fillText("Boring log — " + h.id, 12, 26);
        if (SBMM.watermark) SBMM.watermark.burn(cv);
        cv.toBlob(b => {
          if (!b) { toast("could not write the PNG — see console"); return; }
          download(`boring_log_${h.id}.png`, b);
        }, "image/png");
      } catch (e) { console.error(e); toast("PNG export failed: " + e.message); }
    };
    img.onerror = () => toast("could not render the strip log to a picture");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  /* ================================================================== */
  /* the summary — the sheet the two statements get reconciled on        */
  /* ================================================================== */
  /* Seven columns in ~300 px, which is what decided two things. The SOURCE
     column is gone — all 44 holes are "remark", so it carried no information
     here and the log card states it per hole; and the flags are two short
     tokens with the sentence in the cell's tooltip, because the sentences
     wrapped to three lines each and made the table unreadable. */
  const FLAG_TOK = {
    "remark and strata differ": "R≠S",
    "waste logged below native": "W<N"
  };
  const COLS = [
    ["id", "hole", h => h.id, h => h.id],
    ["depth", "TD", h => fmt(h.depth, 1), h => h.depth],
    ["nc", "rmk", h => fmt(h.contacts.native_contact, 1), h => h.contacts.native_contact],
    ["strata", "str", h => fmt(h.contacts.waste_base_strata, 1), h => h.contacts.waste_base_strata],
    ["rock", "rck", h => fmt(h.contacts.bedrock_top, 1), h => h.contacts.bedrock_top],
    ["gw", "GW", h => (h.water && h.water.encountered && h.water.depth != null) ? fmt(h.water.depth, 1) : "—",
      h => (h.water && h.water.depth != null) ? h.water.depth : -1],
    ["flags", "flags", h => (h.contacts.flags || []).map(f => FLAG_TOK[f] || f).join(" "),
      h => (h.contacts.flags || []).length]
  ];
  const flagTitle = h => (h.contacts.flags || []).join("; ");
  /* the heads are abbreviated to fit seven columns in the card, so each one
     carries its full name as a tooltip rather than leaving the reader to guess */
  const COL_TITLE = {
    id: "boring", depth: "total depth drilled, ft",
    nc: "native contact — the logger's own remark, ft",
    strata: "base of waste — derived from the strata rows, ft",
    rock: "top of bedrock, ft", gw: "groundwater, ft bgs",
    flags: "R≠S remark and strata differ · W<N waste logged below native"
  };

  function disagreeCount() { return holes().filter(h => ((h.contacts || {}).flags || []).length > 0).length; }

  function summaryCsv() {
    let out = COLS.map(c => c[1]).join(",") + "\n";
    for (const h of sorted()) out += COLS.map(c => q(c[2](h))).join(",") + "\n";
    return out;
  }
  function sorted() {
    const col = COLS.find(c => c[0] === sortKey) || COLS[0];
    const key = col[3];
    return holes().slice().sort((a, b) => {
      const va = key(a), vb = key(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sortDir;
      return String(va).localeCompare(String(vb)) * sortDir;
    });
  }

  function summary() {
    if (!has()) { toast("this build has no boring logs"); return null; }
    if (sumEl) { try { sumEl.remove(); } catch (e) { /* gone */ } sumEl = null; }
    const n = disagreeCount();
    const H = holes();
    const el = SBMM.results.card(null, "Boring logs — all " + H.length, [
      ["Holes", String(H.length)],
      ["Contacts that disagree", `${n} of ${H.length}`],
      ["Source", "OpenGround export, " + (D.built || "")]
    ]);
    sumEl = el;
    el.classList.add("blsum");
    const x = el.querySelector('[data-a="del"]');
    if (x) x.onclick = () => { el.remove(); sumEl = null; SBMM.results.checkEmpty(); };

    SBMM.results.appendNote(el,
      `${n} of the ${H.length} holes have a waste/native contact that disagrees between the logger's `
      + `remark and the strata rows. Nothing here resolves one — `
      + `click a boring to read its log, and the flags column says which statements differ.`);

    const box = document.createElement("div");
    box.className = "blscroll blsumtbl";
    el.appendChild(box);
    const paint = () => {
      box.innerHTML = `<table class="bltbl sortable"><thead><tr>`
        + COLS.map(c => `<th data-k="${c[0]}" title="${esc(COL_TITLE[c[0]] || c[1])} — click to sort"`
          + ` class="${sortKey === c[0] ? "on " + (sortDir > 0 ? "asc" : "desc") : ""}">`
          + `${esc(c[1])}</th>`).join("") + `</tr></thead><tbody>`
        + sorted().map(h => `<tr data-id="${esc(h.id)}" class="${((h.contacts || {}).flags || []).length ? "warn" : ""}"`
          + ` title="${esc(h.id + (flagTitle(h) ? " — " + flagTitle(h) : " — the two statements agree"))}">`
          + COLS.map(c => `<td class="${c[0] === "flags" ? "flg" : "num"}">${esc(c[2](h))}</td>`).join("")
          + `</tr>`).join("") + `</tbody></table>`;
    };
    paint();
    box.addEventListener("click", ev => {
      const th = ev.target.closest && ev.target.closest("th[data-k]");
      if (th) {
        if (sortKey === th.dataset.k) sortDir = -sortDir; else { sortKey = th.dataset.k; sortDir = 1; }
        paint();
        return;
      }
      const tr = ev.target.closest && ev.target.closest("tr[data-id]");
      if (tr) open(tr.dataset.id);
    });

    const btns = document.createElement("div");
    btns.className = "crow btns";
    btns.innerHTML = `<button class="minib" data-b="csv" title="Copy this table as CSV">copy CSV</button>`;
    btns.addEventListener("click", ev => {
      if (ev.target.dataset && ev.target.dataset.b === "csv")
        copyText(summaryCsv(), "the 44-hole contact table is on the clipboard");
    });
    el.appendChild(btns);
    const pane2 = scrollIntoPane(el);
    if (pane2) pane2.scrollTop = 0;
    return el;
  }

  /* ------------------------------------------------------------------ */
  /* the commands                                                        */
  /* ------------------------------------------------------------------ */
  function cmd(v) {
    if (!has()) { toast("this build has no boring logs"); return; }
    const s = String(v == null ? "" : v).trim();
    if (!s) {
      const list = ids();
      toast(`${list.length} borings: ${list.slice(0, 10).join(", ")}… — type LOG SB-9`, 4200);
      summary();
      return;
    }
    open(s);
  }

  function wire() { /* nothing to wire: every entry point is a command, a popup
                       button or a table row. Kept for symmetry with the other
                       modules boot.js starts. */ }

  return {
    has, data, ids, holes, byId, profileOf, contactOf, waterOf, summaryLine,
    classColor, classWord: c => CLASS_WORD[c] || c,
    open, close, step, summary, cmd, csvFor, summaryCsv, disagreeCount, wire,
    card: () => cardEl, current: () => curId, svgFor: id => { const h = byId(id); return h ? svgLog(h) : ""; }
  };
})();
