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


  /* ================================================================== */
  /* THE COLUMN RENDERER (v23 §1) — one implementation, every view       */
  /* ================================================================== */
  /* Every face of the borings — the mini chip in a popup, the stick in a
     compare or a fence, the log sheet in the window and on paper — is THIS
     function placed differently. Nothing draws a stratum twice, and a change to
     what a stratum looks like reaches all of them at once.

       SBMM.borelogs.column(hole, {
         tier   "mini" | "stick" | "sheet",
         ppf    px per foot (a scale, not a fit),
         datum  "depth" (ft bgs, the default) or "elev" (ft NAVD88),
         zTop / zBot   the elevation window, when datum is "elev" — this is
                       what a fence needs: several holes on ONE datum, each
                       clipped to the strip of ground the section draws,
         top / bot     the depth window, when datum is "depth",
         w      the column's own width (sheet: the window's width),
         print  black-on-white rather than the dark theme,
         axes   draw the depth and elevation axes (default: not on mini)
       })
       -> { g, w, h, ppf, top, bot, yOf(ft), defs }

     `g` is an SVG FRAGMENT — a <g> with no transform of its own — so a caller
     places it, and `defs` is the <defs> block it needs. `columnSvg()` wraps the
     two into a standalone <svg> for the callers that want one (the tooltip, a
     table cell, the PNG export).

     TWO AXES, ALWAYS (§1.3). Depth in feet below ground on the left, elevation
     in feet NAVD88 on the right, the second being h.elev - depth. h.elev is the
     SURVEYED ground elevation from the coordinate spreadsheet; deltaLidar()
     asks SBMM.elev for what the January-2024 lidar says at the same point and
     the header prints the difference. A hole whose two elevations differ by
     more than 2 ft gets a warn pill. It is reported, never corrected — the same
     rule the OpenGround coordinate offset is under. */

  /* ---- ASTM D2488 / USCS graphic-log patterns (§1.1) ---------------- */
  /* The CLASS is the tint and the USCS is the PATTERN, so waste that is a
     clayey sand reads as orange-tinted SC and native SC reads green-tinted SC.
     Both facts the log states are visible and neither is conflated with the
     other.

     The graphic-log column is drawn on LIGHT PAPER in both themes. That is
     deliberate: the pattern ink is near-black by convention, a near-black
     hatch on the app's dark panel is invisible, and a second palette for print
     would be a second thing to keep in step. So the one column that carries
     the patterns looks the same on screen as it does on paper, and everything
     around it follows the theme. */
  const PAPER = "#F1EFE8", PINK = "#2A2A2A";
  const TILE = 24;
  const PAT = {
    /* gravel: large open circles, scattered */
    gravel: k => `<circle cx="6" cy="6" r="3.3" fill="none" stroke="${k}" stroke-width=".9"/>`
      + `<circle cx="17.5" cy="15" r="2.6" fill="none" stroke="${k}" stroke-width=".9"/>`
      + `<circle cx="10" cy="19" r="1.9" fill="none" stroke="${k}" stroke-width=".9"/>`,
    /* sand: fine dots */
    sand: k => [[4, 5], [12, 3], [19, 7], [7, 12], [16, 14], [3, 18], [11, 20], [20, 21]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".95" fill="${k}"/>`).join(""),
    /* ML — short horizontal dashes */
    M: k => `<path d="M2 6h7M13 6h7M6 14h7M17 14h5M2 21h6M12 21h8" stroke="${k}" stroke-width=".85" fill="none"/>`,
    /* CL — horizontal lines */
    C: k => `<path d="M0 6h24M0 14h24M0 22h24" stroke="${k}" stroke-width=".85" fill="none"/>`,
    /* MH — long dashes */
    MH: k => `<path d="M1 7h14M9 17h14" stroke="${k}" stroke-width=".95" fill="none"/>`,
    /* CH — close horizontal lines */
    CH: k => `<path d="M0 3h24M0 8h24M0 13h24M0 18h24M0 23h24" stroke="${k}" stroke-width=".8" fill="none"/>`,
    /* organic — grass ticks */
    org: k => `<path d="M4 20v-6M4 14l-2.5-3M4 14l2.5-3M14 22v-7M14 15l-2.5-3M14 15l2.5-3"`
      + ` stroke="${k}" stroke-width=".85" fill="none"/>`,
    /* bedrock — brick */
    rock: k => `<path d="M0 8h24M0 16h24M0 24h24M8 0v8M16 8v8M8 16v8M0 0v8M24 8v8" stroke="${k}" stroke-width=".85" fill="none"/>`,
    /* mudstone — dashed brick */
    rockmd: k => `<path d="M0 8h10M14 8h10M0 16h6M10 16h8M22 16h2M0 24h10M14 24h10M8 0v8M16 8v8M8 16v8"`
      + ` stroke="${k}" stroke-width=".8" stroke-dasharray="3 2" fill="none"/>`,
    /* described but not classified — diagonal hatch, so the reader SEES that
       the logger wrote words and no USCS symbol rather than reading a blank */
    none: k => `<path d="M-6 6L6 -6M0 24L24 0M18 30L30 18" stroke="${k}" stroke-width=".8" fill="none"/>`
  };

  /* the pattern family of one stratum, from its USCS symbol and its type */
  function famOf(s) {
    const u = String(s.uscs || "").toUpperCase().replace(/\s+/g, "");
    const words = String(s.desc || "") + " " + String(s.name || "") + " " + String(s.legend || "");
    if (s.cls === "bedrock" || s.type === "Rock" || /^(BEDROCK|ROCK)$/.test(u))
      return /MUDSTONE|SHALE|CLAYSTONE/i.test(words) ? "rockmd" : "rock";
    if (!u || u === "BEDROCK") return "none";
    const toks = u.split(/[-/]/).filter(Boolean);
    const a = toks[0] || "", p = a[0], q = a[1];
    if (p === "G" || p === "S") {
      const coarse = p === "G" ? "gravel" : "sand";
      let f = (q === "M" || q === "C") ? q : null;
      if (!f) for (const t of toks.slice(1)) { if (t[1] === "M" || t[1] === "C") { f = t[1]; break; } }
      return f ? coarse + "+" + f : coarse;
    }
    /* a fines-only symbol: the second letter is the plasticity, and MH/CH get
       their own denser pattern the way the chart does */
    if (p === "M" || p === "C") return q === "H" ? p + "H" : p;
    if (p === "O" || p === "P") return "org";
    return "none";
  }
  const patId = (fam, cls) => "blp_" + fam.replace("+", "_") + "_" + cls;

  /* A USCS SYMBOL, OR AN EM DASH. The payload carries the logged word where a
     hole logged rock rather than a group symbol ("Bedrock"), and that word is
     wider than the column it is printed in at every tier. The pattern and the
     class tint already say what it is. (v24) */
  function uscsSymbol(u) {
    const t = String(u == null ? "" : u).trim().toUpperCase();
    return /^[A-Z]{1,2}([-/][A-Z]{1,2})?$/.test(t) ? t : "\u2014";
  }

  /* the <defs> for exactly the (family, class) pairs a drawing uses. Every
     colour in it is a presentation ATTRIBUTE — the PNG export serialises this
     SVG into an <img> and a document stylesheet does not travel with it. */
  function defsFor(pairs) {
    const out = [];
    for (const key of pairs) {
      const [fam, cls] = key.split("|");
      const parts = fam.split("+");
      const body = parts.map(p => (PAT[p] || PAT.none)(PINK)).join("");
      out.push(`<pattern id="${patId(fam, cls)}" width="${TILE}" height="${TILE}"`
        + ` patternUnits="userSpaceOnUse">`
        + `<rect width="${TILE}" height="${TILE}" fill="${PAPER}"/>`
        + `<rect width="${TILE}" height="${TILE}" fill="${classColor(cls)}" fill-opacity=".34"/>`
        + body + `</pattern>`);
    }
    return out.length ? `<defs>${out.join("")}</defs>` : "";
  }

  /* what the lidar says at this hole against what the surveyor said (§1.3) */
  function deltaLidar(h) {
    if (!h || h.elev == null || !SBMM.elev) return null;
    let z = NaN;
    try { z = SBMM.elev(h.x, h.y)[0]; } catch (e) { return null; }
    if (!isFinite(z)) return null;
    return { lidar: z, d: z - h.elev, warn: Math.abs(z - h.elev) > 2 };
  }

  /* the waste area lives on the BAKED DATASET, not in the log payload — the
     picker groups by it and the table shows it, so it is read here once rather
     than in three places */
  function areaOf(id) {
    try {
      const d = SBMM.datasets && SBMM.datasets.byId("borings2025");
      if (!d) return null;
      const p = d.points.find(q => normId(q.id) === normId(id));
      return p ? (p.a["Waste area"] || null) : null;
    } catch (e) { return null; }
  }
  function areas() {
    const m = new Map();
    for (const h of holes()) {
      const a = areaOf(h.id) || "not assigned";
      if (!m.has(a)) m.set(a, []);
      m.get(a).push(h.id);
    }
    return m;
  }

  /* ---- the renderer ------------------------------------------------ */
  const TIER_W = { mini: 36, stick: 90, sheet: 900 };
  const THEME = {
    dark: { ax: "#6C7F8A", hd: "#8FA3AE", ink: "#C3D0D7", grid: "rgba(44,59,69,.55)",
            rule: "#3A4C58", box: "#26343D", box2: "#3E5763", halo: "#0D1215" },
    print: { ax: "#444", hd: "#333", ink: "#111", grid: "#ccc",
             rule: "#111", box: "#e6e6e6", box2: "#c9c9c9", halo: "#ffffff" }
  };

  /* ---- the collision rules every per-depth annotation goes through (v24) --
     A LANE is one column's vertical stack. Everything drawn at a depth — the
     sample reference, the N value, the blows, a lab chip, a remark, a line of
     description, a horizon tag — is placed through one, in depth order, and a
     lane never lets two boxes touch: it pushes the next one down by the gap it
     was built with, and refuses (returns null) when the push would carry it
     past the limit the caller set. What is refused is ELIDED, never
     overprinted, and its text is already in the <title> of the shape it
     belongs to and in csvFor(). That is the whole of "zero overlaps": it is a
     property of the placer, not of a set of hand-tuned offsets.

     ONE MEASUREMENT PER FONT, conservatively. SVG has no text metrics without
     a DOM, so a wrapped column's width is estimated from the em advance —
     0.62 em for the monospace faces and 0.58 for the sans, both a little wide,
     because a line that overflows its column lands on its neighbour and a line
     that stops short only looks airy. */
  const MONO_EM = 0.62, SANS_EM = 0.58;
  const perChars = (w, size, mono) => Math.max(4, Math.floor(w / (size * (mono ? MONO_EM : SANS_EM))));
  function lane(gap) {
    let last = -1e9;
    return {
      /* y = where this box's TOP wants to be, hh = its height, limit = the y
         its bottom must not pass (null: no limit) */
      at(y, hh, limit) {
        const yy = Math.max(y, last + gap);
        if (limit != null && yy + hh > limit) return null;
        last = yy + hh;
        return yy;
      },
      reset() { last = -1e9; }
    };
  }

  function column(h, opts) {
    const o = opts || {};
    const tier = o.tier || "sheet";
    const T = o.print ? THEME.print : THEME.dark;
    const W = Math.max(20, o.w || TIER_W[tier] || 90);
    const depth = h.depth || h.strata_base || 1;
    const elev = h.elev;

    /* the window, in DEPTH feet, whichever datum was asked for. An elevation
       window is what a fence hands in: several holes on one datum, each clipped
       to the strip of ground the section draws. */
    let top = o.top != null ? o.top : 0;
    let bot = o.bot != null ? o.bot : depth;
    let y0ft = top;
    const useElev = o.datum === "elev" && elev != null;
    if (useElev) {
      const zT = o.zTop != null ? o.zTop : elev;
      const zB = o.zBot != null ? o.zBot : elev - depth;
      top = elev - zT; bot = elev - zB;      /* may be negative above ground */
      y0ft = top;
    }
    const ppf = o.ppf || (tier === "sheet" ? 19.2 : tier === "stick" ? 3 : 2);
    const PADT = o.padTop != null ? o.padTop : (tier === "sheet" ? (o.headings ? 30 : 16) : 2);
    const yOf = ft => PADT + (ft - y0ft) * ppf;
    const PADB = o.padBot != null ? o.padBot : (tier === "sheet" ? 22 : 2);
    const H = Math.ceil(PADT + (bot - y0ft) * ppf + PADB);
    /* nothing outside the hole is drawn; the window may be bigger than it is */
    const cTop = Math.max(top, 0), cBot = Math.min(bot, depth);

    const p = [], pairs = new Set();
    const esc2 = esc;
    const line = (x1, y1, x2, y2, col, w, dash, cls, at) =>
      `<line${cls ? ` class="${cls}"` : ""} x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}"`
      + ` y2="${y2.toFixed(1)}" stroke="${col}" stroke-width="${w || 1}"`
      + `${dash ? ` stroke-dasharray="${dash}"` : ""}${at || ""}/>`;
    const text = (x, y, s, col, size, anchor, extra) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${col}" font-size="${size || 9}"`
      + `${anchor ? ` text-anchor="${anchor}"` : ""}${extra || ""}>${esc2(s)}</text>`;
    const HL = ` stroke="${T.halo}" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round"`;

    /* ---- the column geometry, by tier ---- */
    const L = layoutFor(tier, W);

    /* ---- column headings, drawn in the top margin ---- */
    /* ONE HEADING BAND, and every name carries its unit (v24 §2.2). The band
       is the top margin and nothing else may be drawn in it: the pH scale's
       own 2 / 4 / 8 used to sit half a line under the headings and collided
       with them at every width, so the rule is named in the heading instead.
       The two narrow left columns (12 px and 8 px) have no room for a word
       and are named by their tooltips. */
    if (o.headings && tier === "sheet") {
      for (const [x, s2, anchor] of headingList(L, useElev))
        p.push(text(x, PADT - 13, s2, T.hd, 8.5, anchor, ' letter-spacing=".06em"'));
      p.push(line(0, PADT - 6, W, PADT - 6, T.grid, 1));
    }

    /* ---- axes (§1.3) ---- */
    const wantAxes = o.axes != null ? o.axes : tier !== "mini";
    if (wantAxes) {
      const step = ppf >= 12 ? 1 : ppf >= 5 ? 2 : ppf >= 2 ? 5 : 10;
      const lab = ppf >= 12 ? 5 : ppf >= 5 ? 10 : ppf >= 2 ? 10 : 20;
      /* THE DATUM DECIDES WHICH AXIS IS TICKED, not merely which label is
         printed. On "depth" the ticks fall on round feet below ground and the
         elevations come out uneven; on "elev" they fall on round elevations —
         which is the axis a section, a fence and a design surface are read on,
         and the reason the control exists. The two label sets swap sides with
         it, so the axis the reader asked for is the one on the left. */
      const ticks = [];
      if (useElev && elev != null) {
        const z0 = elev - cBot, z1 = elev - cTop;
        for (let z = Math.ceil(z0 / step) * step; z <= z1 + 1e-6; z += step)
          ticks.push([elev - z, Math.abs(z / lab - Math.round(z / lab)) < 1e-6]);
      } else {
        for (let ft = Math.ceil(cTop / step) * step; ft <= cBot + 1e-6; ft += step)
          ticks.push([ft, Math.abs(ft / lab - Math.round(ft / lab)) < 1e-6]);
      }
      /* THE TERMINATED DEPTH OWNS ITS OWN LABEL. A round tick at or within a
         label's height of it printed "60" straight through the TD line's
         "60.1" — the same number twice, 2 px apart, on both axes. */
      const tdY = cBot >= depth - 1e-6 ? yOf(depth) : null;
      for (const [ft, big] of ticks) {
        const y = yOf(ft);
        p.push(line(L.ax + (big ? 0 : 4), y, L.ax + 6, y, T.grid, big ? 1 : .7));
        if (big && tdY != null && Math.abs(y - tdY) < 11) continue;
        if (big) {
          const near = String(useElev && elev != null ? fmt0(elev - ft) : Math.round(ft));
          const far = elev != null ? (useElev ? String(Math.round(ft)) : fmt0(elev - ft)) : null;
          p.push(text(L.ax - 2, y + 3, near, T.ax, L.fs, "end"));
          if (far != null && L.eax != null) p.push(text(L.eax, y + 3, far, T.ax, L.fs));
          if (L.grid) p.push(line(L.ax + 7, y, L.eax != null ? L.eax - 4 : W, y, T.grid, .6));
        }
      }
      /* the terminated depth always carries a label — it is the one number a
         reader looks for at the foot of a log */
      if (cBot >= depth - 1e-6) {
        const y = yOf(depth);
        p.push(line(L.ax, y, L.eax != null ? L.eax - 4 : W, y, T.rule, 1.3));
        p.push(text(L.ax - 2, y + 9,
          useElev && elev != null ? fmt0(elev - depth) : fmt(depth, 1), T.ink, L.fs, "end"));
        if (elev != null && L.eax != null)
          p.push(text(L.eax, y + 9, useElev ? fmt(depth, 1) : fmt0(elev - depth), T.ink, L.fs));
      }
    }

    /* ---- method / casing band ---- */
    if (L.met) {
      for (const m of (h.methods || [])) {
        const a = Math.max(cTop, m.top), b = Math.min(cBot, m.base);
        if (b - a < 1e-6) continue;
        const auger = /auger/i.test(m.method || "");
        p.push(`<rect class="blmethod" x="${L.met[0]}" y="${yOf(a).toFixed(1)}"`
          + ` width="${L.met[1] - L.met[0]}" height="${((b - a) * ppf).toFixed(1)}"`
          + ` fill="${auger ? T.box2 : T.box}" stroke="${T.halo}" stroke-width=".5">`
          + `<title>${esc2(m.method || "")} ${fmt(m.top, 1)}–${fmt(m.base, 1)} ft`
          + `${m.driller ? " · " + m.driller : ""}</title></rect>`);
      }
      for (const c of (h.casing || [])) {
        const a = Math.max(cTop, c.top), b = Math.min(cBot, c.base);
        if (b - a < 1e-6) continue;
        const x = L.met[1] - 1.5;
        p.push(`<line class="blcasing" x1="${x}" y1="${yOf(a).toFixed(1)}" x2="${x}"`
          + ` y2="${yOf(b).toFixed(1)}" stroke="#8FA3AE" stroke-width="1.6" stroke-opacity=".8">`
          + `<title>${esc2((c.diam_in ? c.diam_in + ' in casing ' : 'casing ')
            + fmt(c.top, 1) + "–" + fmt(c.base, 1) + " ft")}</title></line>`);
      }
    }

    /* ---- the class profile band (every tier draws it) ---- */
    if (L.prof) {
      for (const r of (h.profile || [])) {
        const a = Math.max(cTop, r.top), b = Math.min(cBot, r.base);
        if (b - a < 1e-6) continue;
        p.push(`<rect class="blprof" data-cls="${esc2(r.cls)}" x="${L.prof[0]}" y="${yOf(a).toFixed(1)}"`
          + ` width="${L.prof[1] - L.prof[0]}" height="${((b - a) * ppf).toFixed(1)}"`
          + ` fill="${classColor(r.cls)}" fill-opacity=".85" stroke="${T.halo}" stroke-width=".5">`
          + `<title>${esc2((CLASS_WORD[r.cls] || r.cls) + " " + fmt(r.top, 1) + "–" + fmt(r.base, 1) + " ft")}</title></rect>`);
      }
    }

    /* ---- the graphic log: pattern by USCS, tint by class (§1.1) ---- */
    if (L.gl) {
      const gw = L.gl[1] - L.gl[0];
      /* at stick width the USCS symbol goes INSIDE the graphic log (there is
         no column for it), so two thin units printed theirs through each
         other on a fence and on the Compare tab — one lane, same rule */
      const gLane = lane(1.4);
      (h.strata || []).forEach((s, i) => {
        if (!s.primary) return;
        const a = Math.max(cTop, s.top), b = Math.min(cBot, s.base);
        if (b - a < 1e-6) return;
        const fam = famOf(s), cls = s.cls || "unknown";
        pairs.add(fam + "|" + cls);
        const hh = (b - a) * ppf;
        p.push(`<rect class="blgl" data-i="${i}" data-top="${s.top}" data-base="${s.base}"`
          + ` data-fam="${esc2(fam)}" x="${L.gl[0]}" y="${yOf(a).toFixed(1)}" width="${gw}"`
          + ` height="${hh.toFixed(1)}" fill="url(#${patId(fam, cls)})" stroke="${PINK}"`
          + ` stroke-width=".7" style="cursor:pointer">`
          + `<title>${esc2(fmt(s.top, 1) + "–" + fmt(s.base, 1) + " ft  " + (s.uscs || "no USCS")
              + "  " + (s.desc || s.name || ""))}</title></rect>`);
        /* the USCS symbol goes in its own column at sheet width and inside the
           graphic log at stick width, where there is no room for a column */
        if (L.uscs == null && s.uscs && hh > 9) {
          /* the same rule the USCS COLUMN is under: a symbol, never a word.
             "Bedrock" is 42 px of bold in a 50-px stick column, and the brick
             pattern under it already says rock. */
          const sym = uscsSymbol(s.uscs);
          if (sym !== "\u2014") {
            const gy = gLane.at(yOf((a + b) / 2) - 4.6, 9.4, null);
            if (gy != null)
              p.push(text(L.gl[0] + gw / 2, gy + 7.8, sym, PINK, 8.5, "middle",
                ' font-weight="700"'));
          }
        }
      });
    }

    /* ---- USCS column ---- */
    if (L.uscs) {
      /* two thin units put their symbols a few pixels apart, so the column is
         a lane like every other: the second is pushed down, and a symbol with
         nowhere to go is dropped (it is in the graphic log's own title) */
      const ul = lane(1.6);
      (h.strata || []).slice().sort((x, y2) => x.top - y2.top).forEach(s => {
        if (!s.primary) return;
        const a = Math.max(cTop, s.top), b = Math.min(cBot, s.base);
        if (b - a < 1e-6) return;
        if ((b - a) * ppf < 8) return;
        const y = ul.at(yOf((a + b) / 2) - 5, 11, yOf(cBot) + 6);
        if (y == null) return;
        /* A SYMBOL, NEVER A WORD. The column is 36 px wide and "Bedrock" —
           which is what the payload carries where a hole logged rock rather
           than a USCS group — is 42 px of bold and ran into the description.
           The graphic log already draws rock as brick and tints it, so the
           word adds nothing; it stays in the title. */
        const sym = uscsSymbol(s.uscs);
        /* NO <title> INSIDE A <text>: a title is part of its parent's
           textContent, which is what every harness and the voice check read,
           so a labelled symbol would stop being "SC". The full word is on the
           graphic log's own rect, where the pattern it names is drawn. */
        p.push(text(L.uscs[0] + 2, y + 8.4, sym, T.ink, 10, null, ' font-weight="650"'));
      });
    }

    /* ---- descriptions, wrapped and STACKED (§2.2 item 9, v24) ----
       The description column is ONE running lane down the page: each unit's
       text starts at its own top or below whatever the unit above it used,
       whichever is lower, and stops where the NEXT unit's text begins. A unit
       with room for no line at all is elided — its words are in the graphic
       log's <title> and in csvFor() — and a unit with room for some of them
       carries the ellipsis ON its last line rather than on a line of its own,
       which is what used to land on the unit below. */
    if (L.desc) {
      const dw = L.desc[1] - L.desc[0];
      const LH = 11.2, FS = 9.4;
      const per = perChars(dw, FS, false), perSub = perChars(dw - 7, FS, false);
      const SANS = ' font-family="system-ui,-apple-system,Segoe UI,sans-serif"';
      const items = (h.strata || []).map((s, i) => ({ s, i }))
        .filter(({ s }) => {
          const a = Math.max(cTop, s.top), b = Math.min(cBot, s.base);
          if (s.primary ? (b - a < 1e-6) : (s.top < cTop || s.top > cBot)) return false;
          return !!(s.desc || s.name);
        })
        .sort((x, y2) => (x.s.top - y2.s.top) || (x.i - y2.i));
      const dl = lane(1.6);
      items.forEach(({ s }, k) => {
        const sub = !s.primary;
        const a = Math.max(cTop, s.top);
        const lines = wrapText((sub ? "— " : "") + (s.desc || s.name || ""), sub ? perSub : per);
        /* the unit below decides how much room this one has; the last one has
           the foot of the drawing */
        const nx = items[k + 1];
        const limit = nx ? yOf(Math.max(cTop, nx.s.top)) + LH * 0.5
                         : yOf(cBot) + PADB - 4;
        let y = dl.at(yOf(a) + 8, LH, limit);
        if (y == null) return;
        const room = Math.max(1, Math.floor((limit - y) / LH));
        const shown = lines.slice(0, room);
        if (lines.length > shown.length && shown.length)
          shown[shown.length - 1] = shown[shown.length - 1].replace(/\s*$/, "") + "…";
        shown.forEach((ln, j) =>
          p.push(text(L.desc[0] + (sub ? 7 : 0), y + j * LH, ln, sub ? T.ax : T.ink, FS, null, SANS)));
        dl.at(y + (shown.length - 1) * LH, LH, null);   /* claim what was drawn */
      });
    }

    /* ---- the sample column: drives, N bars, refusal, recovery ---- */
    if (L.smp) {
      const sw = L.smp[1] - L.smp[0], nw = sw - 20;
      const nLane = lane(1.6);
      for (const s of (h.spt || [])) {
        const a = Math.max(cTop, s.top), b = Math.min(cBot, s.base);
        if (b - a < 1e-6) continue;
        const ya = yOf(a), yb = yOf(b), hh = Math.max(4, yb - ya);
        const kind = /^ST/i.test(s.ref || "") ? "ST" : /^MC/i.test(s.ref || "") ? "MC" : "SS";
        const ref = s.refusal || s.n == null;
        /* the drive box over its own interval, with the tube glyph inside it:
           a Shelby is an open box, a Modified California is cross-hatched and a
           split spoon is the filled one — the three glyphs a log sheet uses */
        p.push(`<rect class="blsmp" data-ref="${esc2(s.ref || "")}" data-kind="${kind}"`
          + ` x="${L.smp[0]}" y="${ya.toFixed(1)}" width="14" height="${hh.toFixed(1)}"`
          + ` fill="${kind === "ST" ? "none" : kind === "MC" ? "rgba(79,179,206,.22)" : "rgba(79,179,206,.42)"}"`
          + ` stroke="#4FB3CE" stroke-width="1">`
          + `<title>${esc2((s.ref || "") + "  " + fmt(s.top, 1) + "–" + fmt(s.base, 1) + " ft  N = "
              + (s.n_text || "—") + (s.rec_pct != null ? "  recovery " + fmt0(s.rec_pct) + "%" : "")
              + (s.blows_6in ? "  blows " + s.blows_6in.join("-") : ""))}</title></rect>`);
        /* recovery as a thin fill up the left edge of the box */
        if (s.rec_pct != null)
          p.push(`<rect x="${L.smp[0] + 1}" y="${(yb - hh * clamp(s.rec_pct / 100, 0, 1) + 1).toFixed(1)}"`
            + ` width="3" height="${Math.max(1, hh * clamp(s.rec_pct / 100, 0, 1) - 2).toFixed(1)}"`
            + ` fill="#7FC77A" fill-opacity=".8"/>`);
        if (L.smp[1] - L.smp[0] > 30) {
          const ym = (ya + yb) / 2;
          const bw = ref ? nw : Math.max(1.5, nw * clamp(s.n / N_MAX, 0, 1));
          p.push(`<rect class="blspt" data-n="${s.n == null ? "" : s.n}" data-refusal="${ref ? 1 : 0}"`
            + ` x="${L.smp[0] + 16}" y="${(ym - 3).toFixed(1)}" width="${bw.toFixed(1)}" height="6"`
            + ` fill="${ref ? "#E4796A" : "#4FB3CE"}" fill-opacity="${ref ? ".9" : ".8"}"/>`);
          /* the N value goes through the lane: at 1 in = 20 ft two drives are
             seven pixels apart and their numbers printed through each other */
          const yn = nLane.at(ym - 4, 9, null);
          if (yn != null)
            p.push(text(L.smp[1], yn + 7, s.n_text || "—", ref ? "#E4796A" : T.ink, 8.5, "end"));
        }
      }
    }
    /* ---- blows per 6 in ---- */
    if (L.blows) {
      const bLane = lane(1.6);
      for (const s of (h.spt || [])) {
        if (!s.blows_6in || !s.blows_6in.length) continue;
        const a = Math.max(cTop, s.top), b = Math.min(cBot, s.base);
        if (b - a < 1e-6) continue;
        const ym = (yOf(a) + yOf(b)) / 2;
        const y = bLane.at(ym - 4, 9, null);
        if (y == null) continue;
        p.push(text(L.blows[0], y + 7, s.blows_6in.map(v => fmt0(v)).join("-"), T.ax, 8.5));
      }
    }

    /* ---- PP on 0–4.5 tsf, pH on 2–8 with the acid rule at 4 ---- */
    if (L.pp) {
      const px = v => L.pp[0] + (L.pp[1] - L.pp[0]) * clamp(v / PP_MAX, 0, 1);
      p.push(line(L.pp[0], yOf(cTop), L.pp[0], yOf(cBot), T.grid, 1));
      for (const q2 of (h.pen || [])) {
        if (q2.depth < cTop || q2.depth > cBot) continue;
        const y = yOf(q2.depth), x = px(q2.tsf);
        p.push(`<path class="blpen" d="M${x.toFixed(1)} ${(y - 3).toFixed(1)} L${(x + 3).toFixed(1)} ${y.toFixed(1)}`
          + ` L${x.toFixed(1)} ${(y + 3).toFixed(1)} L${(x - 3).toFixed(1)} ${y.toFixed(1)} Z"`
          + ` fill="none" stroke="#E8B34B" stroke-width="1.1">`
          + `<title>pocket penetrometer ${fmt(q2.tsf, 2)} tsf @ ${fmt(q2.depth, 2)} ft</title></path>`);
      }
    }
    if (L.ph) {
      const phx = v => L.ph[0] + (L.ph[1] - L.ph[0]) * clamp((v - PH_LO) / (PH_HI - PH_LO), 0, 1);
      p.push(line(L.ph[0], yOf(cTop), L.ph[0], yOf(cBot), T.grid, 1));
      /* pH under 4 is the acid-generating signature of this site's waste — the
         rule is drawn, never the conclusion */
      p.push(line(phx(PH_ACID), yOf(cTop), phx(PH_ACID), yOf(cBot), "#E4796A", 1, "2 3", "blph4"));
      /* the scale's own 2 / 4 / 8 used to sit half a line under the heading
         band and collided with it at every width; the heading reads
         "pH 2–8 · 4" and the red dashed rule IS the 4 (v24) */
      for (const t of (h.tests || [])) {
        if (t.key !== "pH" || t.depth == null || t.depth < cTop || t.depth > cBot) continue;
        p.push(`<circle class="blph" data-ph="${t.value}" cx="${phx(t.value).toFixed(1)}"`
          + ` cy="${yOf(t.depth).toFixed(1)}" r="2.8" fill="${t.value < PH_ACID ? "#E4796A" : "#7CD0E6"}">`
          + `<title>pH ${fmt(t.value, 1)} @ ${fmt(t.depth, 2)} ft</title></circle>`);
      }
    }

    /* ---- lab chips at their sample depth ---- */
    if (L.lab) {
      const at = new Map();
      for (const t of (h.tests || [])) {
        if (t.key === "pH" || t.key === "PP" || t.depth == null) continue;
        if (t.depth < cTop || t.depth > cBot) continue;
        const k = t.depth.toFixed(2);
        if (!at.has(k)) at.set(k, { d: t.depth, v: [], iv: t.interval, m: t.method });
        at.get(k).v.push(`${t.key} ${fmt(t.value, t.value % 1 ? 2 : 0)}${t.unit ? " " + t.unit : ""}`);
      }
      const per = perChars(L.lab[1] - L.lab[0] - 6, 8.5, true);
      const LH = 10.4;
      const ll = lane(2.5);
      const recs = [...at.values()].sort((a2, b2) => a2.d - b2.d);
      for (const rec of recs) {
        const lines = wrapText(rec.v.join(" · "), per).slice(0, 3);
        const boxH = lines.length * LH + 3;
        const title = esc2(rec.v.join(" · ")
          + (rec.iv ? "  over " + fmt(rec.iv[0], 1) + "–" + fmt(rec.iv[1], 1) + " ft" : "")
          + (rec.m ? "  " + rec.m : ""));
        /* a chip that cannot be placed without landing on the one above it is
           dropped rather than overprinted; every value is in the <title> of
           its own tick, in the card's lab table and in csvFor() */
        const y = ll.at(yOf(rec.d) - 5.5, boxH, yOf(cBot) + PADB - 4);
        if (y == null) {
          p.push(line(L.lab[0], yOf(rec.d), L.lab[0] + 5, yOf(rec.d), T.ax, 1, null, "bllabtick",
            ` data-ft="${rec.d}"`) .replace("/>", `><title>${title}</title></line>`));
          continue;
        }
        p.push(`<rect class="bllab" data-ft="${rec.d}" x="${L.lab[0]}" y="${y.toFixed(1)}"`
          + ` width="${L.lab[1] - L.lab[0]}" height="${boxH.toFixed(1)}"`
          + ` fill="${T.box}" fill-opacity=".55" stroke="${T.grid}" stroke-width=".6" rx="2">`
          + `<title>${title}</title></rect>`);
        if (Math.abs(y + 5.5 - yOf(rec.d)) > 1.5)
          p.push(line(L.lab[0] - 4, yOf(rec.d), L.lab[0], y + boxH / 2, T.grid, .7));
        lines.forEach((ln, k) => p.push(text(L.lab[0] + 3, y + 8 + k * LH, ln, T.ink, 8.5)));
      }
    }

    /* ---- remarks at depth ---- */
    if (L.rem) {
      const per = perChars(L.rem[1] - L.rem[0], 8.6, false);
      const LH = 10.2;
      const rl = lane(2.2);
      const notes = (h.notes || []).filter(n => n.depth != null && n.depth >= cTop && n.depth <= cBot)
        .sort((a2, b2) => a2.depth - b2.depth);
      for (const n of notes) {
        const lines = wrapText(n.text, per).slice(0, 3);
        const y = rl.at(yOf(n.depth) - 6, lines.length * LH, yOf(cBot) + PADB - 4);
        p.push(line(L.rem[0] - 4, yOf(n.depth), L.rem[0] - 1, yOf(n.depth), T.ax, 1, null, null,
          "").replace("/>", `><title>${esc2(fmt(n.depth, 1) + " ft — " + n.text)}</title></line>`));
        if (y == null) continue;
        lines.forEach((ln, k) => p.push(text(L.rem[0], y + 7 + k * LH, ln, T.ax, 8.6, null,
          ' font-family="system-ui,-apple-system,Segoe UI,sans-serif"')));
      }
    }

    /* ---- the two contact statements, across the whole column ---- */
    const c = h.contacts || {};
    /* on white the screen palette stops being lines: gold at 55 % luminance is
       invisible on paper and violet is worse. The class TINTS are kept (they
       are the graphic log's own, on its own paper); the horizon lines darken. */
    const HC = o.print ? { contact: "#8A6A00", bedrock: "#4B3E86", water: "#0B6FA8" }
                       : { contact: classColor("contact"), bedrock: classColor("bedrock"), water: "#55C1FF" };
    const across0 = L.ax + 1, across1 = L.eax != null ? L.eax - 3 : W;
    /* THE HORIZON TAG LANE (v24). Until this round each horizon printed a
       sentence across the whole column — "native contact 7.5 ft · logger's
       remark" — straight over the descriptions, the lab chips and the heading
       band, and it was the single biggest source of the overlapping text the
       engineer reported. A horizon is now tagged SHORT, in the one lane of the
       drawing that carries no other text: from the depth axis across the
       method, class and graphic-log columns, which at sheet tier hold patterns
       and no words. The source of the contact, the strata reading and the
       interlayered flag are stated once each in the window's header strip and
       on the printed sheet's header block, so the drawing does not repeat
       them; each tag keeps the full sentence in its own <title>. */
    const tagLane = lane(1.8);
    const tagW = Math.max(40, (L.gl ? L.gl[1] : across1) - across0 - 4);
    const tagRoom = perChars(tagW, 8.5, true);
    /* the tag is a plain <text>: a <title> inside one becomes part of its
       textContent, and the sentence each tag shortens lives on the horizon
       LINE's own title instead (and in the window's header strip) */
    const tag = (y, words, col) => {
      if (tier !== "sheet") return;
      const txt = words.length > tagRoom ? words.slice(0, tagRoom - 1) + "…" : words;
      const at = tagLane.at(Math.max(PADT, y - 11), 10.5, null);
      p.push(text(across0 + 3, at + 8, txt, col, 8.5, null,
        ' font-weight="700" class="bltag"' + HL));
    };
    /* the tags are emitted in DEPTH order, which is what lets one lane keep
       them apart: strata reading, native contact, bedrock, water */
    const tagQ = [];
    if (c.waste_base_strata != null && differs(c.waste_base_strata, c.native_contact)
        && c.waste_base_strata >= cTop && c.waste_base_strata <= cBot) {
      const y = yOf(c.waste_base_strata);
      p.push(line(across0, y, across1, y, T.ink, 1, "5 3", "blstrataline",
        ` data-ft="${c.waste_base_strata}"`)
        .replace("/>", `><title>waste base from the strata rows — `
          + `${fmt(c.waste_base_strata, 1)} ft</title></line>`));
      tagQ.push([c.waste_base_strata, y, `strata ${fmt(c.waste_base_strata, 1)} ft`, T.ink]);
    }
    if (c.native_contact != null && c.native_contact >= cTop && c.native_contact <= cBot) {
      const y = yOf(c.native_contact);
      p.push(line(across0, y, across1, y, HC.contact, tier === "mini" ? 1.4 : 2.2, null,
        "blcontact", ` data-ft="${c.native_contact}" data-src="${esc2(c.source || "")}"`)
        .replace("/>", `><title>native contact ${fmt(c.native_contact, 1)} ft · `
          + `${c.source === "remark" ? "logger's remark" : "from the strata"}`
          + `${c.waste_layered_below_native ? " · waste logged below native — interlayered" : ""}`
          + `</title></line>`));
      tagQ.push([c.native_contact, y, `NATIVE ${fmt(c.native_contact, 1)} ft`, HC.contact]);
    }
    if (c.bedrock_top != null && c.bedrock_top >= cTop && c.bedrock_top <= cBot && tier !== "mini") {
      const y = yOf(c.bedrock_top);
      p.push(line(across0, y, across1, y, HC.bedrock, 1.4, "6 3", "blrockline",
        ` data-ft="${c.bedrock_top}"`)
        .replace("/>", `><title>top of bedrock ${fmt(c.bedrock_top, 1)} ft</title></line>`));
      tagQ.push([c.bedrock_top, y, `BEDROCK ${fmt(c.bedrock_top, 1)} ft`, HC.bedrock]);
    }

    /* ---- water: the standard triangles ---- */
    const w = h.water;
    if (w && w.encountered && w.depth != null && w.depth >= cTop && w.depth <= cBot) {
      const y = yOf(w.depth), wx = (L.gl ? L.gl[0] : L.prof ? L.prof[0] : across0) + 2;
      p.push(line(across0, y, across1, y, HC.water, 1, "4 2"));
      p.push(`<polygon class="blwater" data-ft="${w.depth}" points="${wx},${(y - 7).toFixed(1)} `
        + `${(wx + 11)},${(y - 7).toFixed(1)} ${(wx + 5.5)},${y.toFixed(1)}" fill="#55C1FF">`
        + `<title>groundwater ${fmt(w.depth, 1)} ft bgs${w.perched ? " (perched)" : ""}`
        + `${w.event ? " — " + esc2(w.event) : ""}${w.when ? " · " + esc2(String(w.when).slice(0, 10)) : ""}</title></polygon>`);
      /* "perched" is a qualifier, and it is stated in the window's header
         strip and in the triangle's own title; the tag lane is 95 px wide and
         a truncated qualifier reads worse than none */
      tagQ.push([w.depth, y, `WATER ${fmt(w.depth, 1)} ft`, o.print ? HC.water : "#9FDCFF"]);
    }
    /* the water triangle sits at the graphic log's own left edge, so a tag at
       the same depth starts clear of it */
    tagQ.sort((a2, b2) => a2[0] - b2[0]);
    for (const [, y, words, col] of tagQ) tag(y, words, col);

    return { g: `<g class="blcol" data-hole="${esc2(h.id)}">${p.join("")}</g>`,
             defs: defsFor(pairs), w: W, h: H, ppf, top, bot, yOf,
             pairs: [...pairs] };
  }

  /* the column layout, by tier. A sheet's columns are laid out from BOTH ends —
     the axes and the graphic log from the left, the tests and the elevation
     axis from the right — so the description column takes whatever is left,
     which is the whole reason the window is wide. */
  function layoutFor(tier, W) {
    if (tier === "mini") return { ax: 0, fs: 7, prof: [0, W], gl: null };
    if (tier === "stick") return { ax: 16, fs: 7.5, eax: null, prof: [18, 24],
                                   gl: [26, W - 22], smp: [W - 20, W - 2], grid: false };
    /* sheet — laid out from BOTH ends. The axes and the graphic log are fixed
       widths on the left; the tests and the elevation axis are stacked inward
       from the right edge; and the DESCRIPTION takes whatever is left, which
       is the whole reason the window is wide. The optional columns drop from
       the right in the order a log sheet would give them up — the remarks
       first, then the lab chips — and the description is never dropped. */
    const fs = 9;
    const ax = 30, met = [34, 46], prof = [48, 56], gl = [60, 130], uscs = [136, 172];
    const eax = W - 40;
    let x = eax - 10;
    const put = w => { const b = [x - w, x]; x -= (w + 6); return b; };
    const L = { ax, fs, met, prof, gl, uscs, eax, grid: true };
    if (W >= 1040) L.rem = put(112);
    if (W >= 900) L.lab = put(98);
    L.ph = put(58);
    L.pp = put(54);
    L.blows = put(52);
    L.smp = put(74);
    L.desc = [uscs[1] + 6, x - 4];
    if (L.desc[1] - L.desc[0] < 60) L.desc = null;
    return L;
  }

  /* THE COLUMN HEADINGS, IN ONE PLACE AND WITH THEIR UNITS (v24 §2.2).
     Two callers: column() draws them in its own top margin for the printed
     page, where every sheet repeats them, and headingBand() draws the same
     list into the window's own fixed strip, where they must not scroll away
     with the log. Two copies of this list would drift the first time a column
     moved. The two narrow left columns (12 px and 8 px) have no room for a
     word and are named by their tooltips instead. */
  function headingList(L, useElev) {
    const out = [[0, useElev ? "ELEV ft" : "FT BGS", null]];
    const put = (b, s) => { if (b) out.push([b[0], s, null]); };
    put(L.gl, "GRAPHIC LOG");
    put(L.uscs, "USCS");
    put(L.desc, "DESCRIPTION");
    put(L.smp, "SAMPLE · N");
    put(L.blows, "BLOWS/6\u2033");
    put(L.pp, "PP tsf");
    put(L.ph, "pH 2\u20138 · 4");
    put(L.lab, "LAB");
    put(L.rem, "REMARKS");
    if (L.eax != null) out.push([L.eax, useElev ? "FT BGS" : "ELEV ft NAVD88", null]);
    return out;
  }

  /* the window's fixed heading strip: the same list, its own little SVG, so
     the drawing below it can scroll under a heading row that stays put */
  const HEAD_BAND_H = 22;
  function headingBand(w, o) {
    const oo = o || {};
    const W = Math.max(360, Math.round(w || 900));
    const T = oo.print ? THEME.print : THEME.dark;
    const L = layoutFor("sheet", W);
    const p = [];
    for (const [x, s2, anchor] of headingList(L, oo.datum === "elev"))
      p.push(`<text x="${x.toFixed(1)}" y="13" fill="${T.hd}" font-size="8.5"`
        + `${anchor ? ` text-anchor="${anchor}"` : ""} letter-spacing=".06em">${esc(s2)}</text>`);
    p.push(`<line x1="0" y1="${HEAD_BAND_H - 2.5}" x2="${W}" y2="${HEAD_BAND_H - 2.5}"`
      + ` stroke="${T.grid}" stroke-width="1"/>`);
    return { svg: `<svg class="bwheads" viewBox="0 0 ${W} ${HEAD_BAND_H}" width="${W}"`
      + ` height="${HEAD_BAND_H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
      + `<style>text{font-family:"SF Mono",ui-monospace,Consolas,Menlo,monospace}</style>`
      + p.join("") + `</svg>`, w: W, h: HEAD_BAND_H };
  }

  /* a word wrapper for SVG text, which has none of its own.

     A WORD LONGER THAN THE COLUMN IS BROKEN, not left to run out of it. SVG
     text does not clip, so one long token — a lab method, a hyphen-less
     mineral name — overprinted whatever column was to its right, and the
     wrapper's own line count then said the text fitted. (v24) */
  function wrapText(s, per) {
    const lim = Math.max(3, Math.floor(per));
    const words = [];
    for (let w of String(s == null ? "" : s).split(/\s+/).filter(Boolean)) {
      while (w.length > lim) { words.push(w.slice(0, lim - 1) + "\u2011"); w = w.slice(lim - 1); }
      if (w) words.push(w);
    }
    const out = [];
    let cur = "";
    for (const w of words) {
      if (!cur) { cur = w; continue; }
      if ((cur + " " + w).length <= lim) cur += " " + w;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  }

  /* a standalone <svg> around one column — the tooltip, a table cell and the
     PNG export all want one rather than a fragment */
  function columnSvg(h, opts) {
    const r = column(h, opts);
    const o = opts || {};
    return `<svg class="blcolsvg" viewBox="0 0 ${r.w} ${r.h}" width="${o.cssW || r.w}"`
      + ` height="${o.cssH || r.h}" xmlns="http://www.w3.org/2000/svg" role="img">`
      + `<style>text{font-family:"SF Mono",ui-monospace,Consolas,Menlo,monospace}</style>`
      + r.defs + r.g + `</svg>`;
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

    /* The two statements, as ONE line. v23 voice rule: a card states the
       result, and this one is a result — 18 of the 44 holes disagree and the
       app resolves none of them. The `data-agree` attribute is what the
       harness reads, so the words can change again without a harness edit. */
    const note = document.createElement("div");
    note.className = "note blstate";
    const dStrata = differs(c.waste_base_strata, c.native_contact);
    note.dataset.agree = dStrata ? "0" : "1";
    note.innerHTML = `<b>${fmt(c.native_contact, 1)} ft</b> `
      + (c.source === "remark" ? "logger's remark" : "read off the strata")
      + (dStrata ? ` · strata ${fmt(c.waste_base_strata, 1)} ft`
                 : (c.waste_base_strata != null ? " · strata agree" : ""))
      + (c.waste_layered_below_native ? " · waste below native" : "")
      + (dStrata ? " · not reconciled" : "");
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
    btns.innerHTML = `<button class="minib prim" data-b="win" title="Open the log window (full log sheet, compare, table)">open in window</button>`
      + `<button class="minib" data-b="prev" title="Previous boring">‹ prev</button>`
      + `<button class="minib" data-b="next" title="Next boring">next ›</button>`
      + `<button class="minib" data-b="zoom" title="Zoom the map to this boring">zoom to</button>`
      + `<button class="minib" data-b="3d" title="Open the 3D view at this boring">3D</button>`
      + `<button class="minib" data-b="csv" title="Copy the strata, SPT, penetrometer and lab tables as CSV">copy CSV</button>`
      + `<button class="minib" data-b="png" title="Save the strip log as a PNG">PNG</button>`;
    btns.addEventListener("click", ev => {
      const b = ev.target.dataset && ev.target.dataset.b;
      if (!b) return;
      if (b === "win") { if (SBMM.borewin) SBMM.borewin.open(h.id); else toast("the log window is not in this build"); }
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
      `OpenGround logs, 2025 Jacobs investigation${D.built ? " · " + D.built : ""}`
      + " · class = last word of the logger's description · nothing interpolated");
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
      `${n} of the ${H.length} holes: the logger's remark and the strata rows disagree · not reconciled`);

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
    btns.innerHTML = `<button class="minib prim" data-b="win" title="Open the log window at the full table">open in window</button>`
      + `<button class="minib" data-b="csv" title="Copy this table as CSV">copy CSV</button>`;
    btns.addEventListener("click", ev => {
      const b = ev.target.dataset && ev.target.dataset.b;
      if (b === "csv") copyText(summaryCsv(), `the ${H.length}-hole contact table is on the clipboard`);
      /* v23 §2.1: the Table tab is this sheet at full width, with the waste
         area, the elevations and the filter the card has no room for */
      if (b === "win") {
        if (SBMM.borewin) SBMM.borewin.open(curId || H[0].id, { tab: "table" });
        else toast("the log window is not in this build");
      }
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
    card: () => cardEl, current: () => curId, svgFor: id => { const h = byId(id); return h ? svgLog(h) : ""; },
    /* v23 §1 — the column renderer, and the facts a view needs around it.
       Phase B's fence calls column(h, {tier:"stick", datum:"elev", zTop, zBot,
       ppf}) once per hole and places the returned <g> at its station. */
    column, columnSvg, headingBand, headingList, defsFor, famOf, patternId: patId, wrapText,
    deltaLidar, areaOf, areas, differs, tickStep,
    CLASS_LIST: () => CLASSES.slice()
  };
})();
