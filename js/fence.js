/* SBMM Site Explorer — the fence diagram (v23 Phase B).

   A FENCE is a section through the SUBSURFACE along a line the engineer draws.
   The lidar ground is the top of it, the borings inside a swath are projected
   perpendicular onto the alignment and stand at their own station and their own
   elevation, and the three horizons every log states — the native contact, the
   top of bedrock, the water level — are joined between adjacent holes.

   IT IS ONE MORE PLACEMENT OF THE SAME COLUMN. Nothing here knows what a
   stratum looks like: every column is SBMM.borelogs.column(h, {tier:"stick",
   datum:"elev", zTop, zBot, ppf}) (v23 §1), which is also what the Compare tab
   draws and what Phase C's site views will draw.

   THE SHARED DATUM IS SET BY zTop AND BY NOTHING ELSE. column() maps the
   window's top elevation to padTop, so every column on this drawing starts at
   the same y and each hole's own ground falls where the datum says it does.
   Adding (zTop − h.elev)·ppf to padTop as well counts the datum twice and the
   columns land off the bottom of the drawing, silently — it cost Phase A a
   round, and it is why every column carries data-y0 / data-elev / data-sta /
   data-off for the harness to read the datum back out of rather than eyeball.

   THE CORRELATION IS LINEAR BETWEEN NEIGHBOURS AND SAYS SO. It is the standard
   first fence, not an interpretation: a straight segment between the two holes
   that bound it, dashed where the far hole never reached that horizon. Nothing
   here interpolates a contact where no hole states one, and nothing here
   reconciles the logger's remark with the strata rows (js/borelogs.js).

   A fence is an ordinary store feature: it serialises, it undoes and redoes, it
   exports, it recomputes when its alignment is edited, and it joins My work
   under the "Borings" class row.

   Payload tolerance (v19.1): with SBMM_DATA.borings_logs absent every entry
   point here refuses with a toast and nothing throws.                         */
"use strict";

SBMM.fence = (function () {

  const BL = () => SBMM.borelogs;
  const has = () => !!(BL() && BL().has());
  const staLabel = s => (SBMM.sections && SBMM.sections.staLabel)
    ? SBMM.sections.staLabel(s) : String(Math.round(s));
  /* a hole ON the alignment has no side: the offset prints to the foot, so
     anything that rounds to 0 ft is "0 ft", not "0 ft R" */
  const sideOf = off => Math.abs(off) < 0.5 ? "" : (off < 0 ? "L" : "R");

  /* the swath is a HALF width: "150 ft either side of the line" is how a
     section corridor is stated on a plan, and it is what the offset column
     prints against */
  const DEFAULTS = { swath_ft: 150, ve: 2, ground_step_ft: 2 };
  const VE_CHOICES = [1, 2, 5];

  /* the drawing's own furniture */
  /* The drawing's own furniture. PADB carries three stacked rows — the station
     axis and its labels, the scale bar, then the method line and the horizon
     key — because all three at one y is what the first cut drew, and it was
     unreadable. And the PLOT starts half a column in from PADL: a hole at
     station 0+00 is the commonest fence there is (the engineer draws from one
     boring to another), and its column is centred on its station, so without
     that inset half of it hangs over the elevation axis and off the paper. */
  /* PADB CARRIES SIX STACKED ROWS AND EVERY ONE OF THEM HAS ITS OWN OFFSET.
     The station axis and its labels, the per-span distances, the scale bar,
     the class key, the horizon key and then the rule the drawing is under —
     all of them at one y is what the first cut drew, and the second cut put
     the class key straight through the scale bar because both were computed
     from different ends of the same margin. FOOT is the stack, measured from
     the foot of the drawing, and PADB is its last row plus a line. */
  const FOOT = { axis: 12, staLab: 26, spanRule: 40, span: 50, bar: 68,
                 keyClass: 88, keyHz: 104, note: 120, noteLine: 11 };
  /* PADB reserves the note's SECOND line whether or not this width needs one —
     a footer whose height depends on how the sentence wrapped is a footer that
     lands on the key it sits under at exactly one width. */
  const PADL = 52, PADR = 46, PADT = 34, PADB = 144, CW = 78;
  const C = { ink: "#E8EEF1", ax: "#6C7F8A", hd: "#8FA3AE", grid: "rgba(44,59,69,.55)",
              ground: "#E8EEF1", tick: "#FFD34D", plate: "#0D1215" };

  function list() { return SBMM.store.features.filter(f => f.type === "fence"); }

  /* ------------------------------------------------------------------ */
  /* geometry — the projection, and the ground                           */
  /* ------------------------------------------------------------------ */
  /* Station along the alignment, offset perpendicular to it, sign positive to
     the RIGHT looking up-station (the CAD convention js/sections.js already
     uses). Exported, because Phase C wants the same projection for its
     thickness control points and a second copy of it would drift. */
  function projectPoint(pts, x, y) {
    let best = null, sta0 = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const ux = dx / len, uy = dy / len;
      const t = clamp((x - a[0]) * ux + (y - a[1]) * uy, 0, len);
      const px = a[0] + ux * t, py = a[1] + uy * t;
      const d = Math.hypot(x - px, y - py);
      /* THE OFFSET'S MAGNITUDE IS THE DISTANCE TO THE ALIGNMENT, NOT TO ITS
         INFINITE LINE. A hole past the end of the drawn line has its foot
         CLAMPED to the endpoint, and the perpendicular distance to the segment's
         extension is shorter than the hole really is from the section — a hole
         400 ft beyond the end came inside a 300-ft swath reading "188 ft R".
         So the sign comes from the cross product (positive is RIGHT looking
         up-station, the convention js/sections.js uses) and the magnitude is
         `d`, the true distance to the nearest point ON the alignment. For an
         interior projection the two are identical; at an end they are not, and
         it is the end that decides whether a hole is on the fence at all. */
      const cross = (x - a[0]) * (-uy) + (y - a[1]) * ux;
      if (!best || d < best.d - 1e-9)
        best = { d, sta: sta0 + t, off: (cross > 0 ? -1 : 1) * d, x: px, y: py, seg: i, ux, uy };
      sta0 += len;
    }
    return best;
  }

  /* every logged hole inside the swath, in station order. THE PHASE C SEAM.

     `through` names the holes instead: a fence drawn hole-to-hole takes THOSE
     holes and no others, whatever the swath would have caught, and each one is
     projected onto the polyline it is a vertex of — so its offset is 0 by
     construction and stays honest if the alignment is later edited. */
  function projectHoles(pts, halfFt, through) {
    if (!has() || !pts || pts.length < 2) return [];
    const half = through ? Infinity : Math.max(1, halfFt || DEFAULTS.swath_ft);
    const list = through
      ? through.map(v => BL().byId(v)).filter(Boolean)
      : BL().holes();
    const out = [];
    for (const h of list) {
      if (h.x == null || h.y == null) continue;
      const pr = projectPoint(pts, h.x, h.y);
      if (!pr || Math.abs(pr.off) > half) continue;
      out.push({ id: h.id, sta: pr.sta, off: pr.off, x: h.x, y: h.y,
                 px: pr.x, py: pr.y, elev: h.elev, depth: h.depth });
    }
    out.sort((a, b) => a.sta - b.sta);
    return out;
  }

  /* the lidar surface along the alignment, sampled the way js/sections.js
     samples it: every 2 ft, and a vertex is always a sample */
  function groundProfile(pts, step) {
    const st = Math.max(0.5, step || DEFAULTS.ground_step_ft);
    const out = [];
    let sta = 0;
    const push = (s, x, y) => {
      let z = NaN;
      try { z = SBMM.elev(x, y)[0]; } catch (e) { z = NaN; }
      out.push({ sta: s, x, y, z: isFinite(z) ? z : NaN });
    };
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = dist2d(a, b);
      if (len < 1e-9) continue;
      const n = Math.max(1, Math.round(len / st));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        push(sta + t * len, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      }
      sta += len;
    }
    const last = pts[pts.length - 1];
    push(sta, last[0], last[1]);
    return out;
  }

  /* the horizon a hole states, as an ELEVATION (null when it states none) */
  const HZ = [
    { key: "native", label: "native contact", tone: "contact", dash: null, w: 2,
      ft: h => (h.contacts || {}).native_contact },
    { key: "rock", label: "top of bedrock", tone: "bedrock", dash: "6 3", w: 1.5,
      ft: h => (h.contacts || {}).bedrock_top },
    { key: "water", label: "water level", tone: "water", dash: "4 2", w: 1.3,
      ft: h => (h.water && h.water.encountered && h.water.depth != null ? h.water.depth : null) }
  ];
  const hzColor = tone => tone === "water" ? "#55C1FF" : BL().classColor(tone);
  function horizonZ(hz, id) {
    const h = BL().byId(id);
    if (!h || h.elev == null) return null;
    const ft = hz.ft(h);
    return ft == null ? null : h.elev - ft;
  }

  /* ------------------------------------------------------------------ */
  /* THE CORRELATION (v24 Part 3)                                        */
  /* ------------------------------------------------------------------ */
  /* A fence that draws three straight horizons is a fence that says almost
     nothing about what is between the holes. What an engineer reads off a
     fence is the BODY — how thick the waste is here, where the native comes
     up, where the rock is — so the classes are correlated as FILLED BANDS
     between adjacent holes, and inside a band the logged units are matched by
     the USCS family they share.

     THE BAND BOUNDARIES ARE THE LOGGED CONTACTS AND NOTHING ELSE. Waste is
     ground down to the logger's own native contact, native is that contact
     down to the top of bedrock, bedrock is that down to the hole's terminated
     depth. Deriving a band from the strata runs instead would put a second,
     quieter answer beside the one the app leads with everywhere else — and the
     18 holes whose two statements disagree are exactly the ones a reader is
     looking at. `ended` says a band stops at the hole's own bottom rather than
     at a logged contact, and it is drawn with a dashed edge.

     NOTHING IS INTERPOLATED BEYOND STRAIGHT LINES, and nothing is drawn
     between holes that are not neighbours. */
  const CLASS_ORDER = ["waste", "native", "bedrock"];
  function bandsOf(id) {
    const h = BL().byId(id);
    if (!h || h.elev == null || h.depth == null) return null;
    const c = h.contacts || {};
    const g = h.elev, tdz = h.elev - h.depth;
    const nc = c.native_contact != null ? h.elev - c.native_contact : null;
    const rk = c.bedrock_top != null ? h.elev - c.bedrock_top : null;
    const out = {};
    if (nc != null && nc < g - 0.01) out.waste = { top: g, base: nc, ended: false };
    const nTop = nc != null ? nc : g;
    const nBase = rk != null ? rk : tdz;
    if (nBase < nTop - 0.01) out.native = { top: nTop, base: nBase, ended: rk == null };
    if (rk != null && tdz < rk - 0.01) out.bedrock = { top: rk, base: tdz, ended: true };
    return out;
  }

  /* the primary units inside one class band, top-down, each with the pattern
     family the graphic log draws it with */
  function unitsIn(id, cls) {
    const h = BL().byId(id);
    const b = (bandsOf(id) || {})[cls];
    if (!h || !b) return [];
    const out = [];
    for (const s2 of (h.strata || [])) {
      if (!s2.primary) continue;
      const zt = h.elev - s2.top, zb = h.elev - s2.base;
      const mid = (zt + zb) / 2;
      if (mid > b.top + 0.01 || mid < b.base - 0.01) continue;
      out.push({ top: Math.min(zt, b.top), base: Math.max(zb, b.base),
                 fam: BL().famOf(s2), uscs: String(s2.uscs || "").trim() });
    }
    out.sort((x, y2) => y2.top - x.top);
    return out;
  }

  /* IN-ORDER MATCHING, BY FAMILY. A longest common subsequence over the
     pattern families: it is deterministic, it never crosses two links, and it
     cannot match a sand to a clay. Lists are a dozen units long at most.
     CONFIDENCE is the full USCS symbol: same family AND the same symbol is a
     solid link, same family alone is dashed. */
  function matchUnits(A, B) {
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = A[i].fam === B[j].fam && A[i].fam !== "none"
          ? L[i + 1][j + 1] + 1
          : Math.max(L[i + 1][j], L[i][j + 1]);
    const pairs = [];
    const usedA = new Set(), usedB = new Set();
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i].fam === B[j].fam && A[i].fam !== "none") {
        pairs.push({ a: i, b: j, sure: !!A[i].uscs && A[i].uscs === B[j].uscs });
        usedA.add(i); usedB.add(j); i++; j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
    /* A UNIT WITH NO USCS SYMBOL IS NOT CORRELATED AND DOES NOT PINCH OUT.
       "Described, not classified" is what the graphic log's diagonal hatch
       already says; drawing a wedge for it would claim the unit ends at
       mid-span, which is a statement about ground nobody drilled. Excluding
       them took a three-hole fence from 25 wedges to a readable few. */
    const real = (arr, used) => arr.map((u, k) => k)
      .filter(k => !used.has(k) && arr[k].fam !== "none");
    return { pairs, loneA: real(A, usedA), loneB: real(B, usedB) };
  }

  /* one span's whole correlation, as data — the drawing, the CSV and the DXF
     all read THIS rather than each working it out again */
  function spanCorrelation(idA, idB) {
    const ba = bandsOf(idA), bb = bandsOf(idB);
    if (!ba || !bb) return null;
    const bands = [], units = [], pinch = [];
    for (const cls of CLASS_ORDER) {
      const a = ba[cls], b = bb[cls];
      if (!a || !b) continue;
      bands.push({ cls, a, b, ended: a.ended || b.ended });
      const UA = unitsIn(idA, cls), UB = unitsIn(idB, cls);
      const m = matchUnits(UA, UB);
      for (const p of m.pairs)
        units.push({ cls, sure: p.sure, za: UA[p.a].top, zb: UB[p.b].top,
                     uscs: UA[p.a].uscs || UB[p.b].uscs });
      for (const k of m.loneA) pinch.push({ cls, side: "a", u: UA[k] });
      for (const k of m.loneB) pinch.push({ cls, side: "b", u: UB[k] });
    }
    return { bands, units, pinch };
  }

  /* ------------------------------------------------------------------ */
  /* derive — main-thread arithmetic, no worker job                      */
  /* ------------------------------------------------------------------ */
  /* 44 holes and a few hundred ground samples: measured at well under a
     millisecond on this box, so there is no job here and a session load spawns
     none. `_fen` is DERIVED and is never serialised; props carries the scalars
     the card, the popup and the exports read. */
  function derive(f) {
    const pr = Object.assign({}, DEFAULTS, f.props || {});
    f.props = pr;
    const pts = f.pts;
    if (!pts || pts.length < 2) { f._fen = null; return null; }
    const total = lineLength(pts);
    const holes = has() ? projectHoles(pts, pr.swath_ft, pr.through) : [];
    const ground = groundProfile(pts, pr.ground_step_ft);
    let gLo = Infinity, gHi = -Infinity;
    for (const g of ground) if (isFinite(g.z)) { if (g.z < gLo) gLo = g.z; if (g.z > gHi) gHi = g.z; }
    let deepest = Infinity, tallest = -Infinity;
    for (const q of holes) {
      if (q.elev == null) continue;
      if (q.elev - q.depth < deepest) deepest = q.elev - q.depth;
      if (q.elev > tallest) tallest = q.elev;
    }
    if (!isFinite(gLo)) { gLo = isFinite(deepest) ? deepest : 0; gHi = isFinite(tallest) ? tallest : 100; }
    const zTop = Math.max(gHi, isFinite(tallest) ? tallest : -Infinity) + 5;
    const zBot = Math.min(gLo, isFinite(deepest) ? deepest : Infinity) - 10;
    f._fen = { total, holes, ground, zTop, zBot, gLo, gHi };
    Object.assign(pr, {
      length_ft: +total.toFixed(1),
      n_holes: holes.length,
      holes: holes.map(q => ({ id: q.id, sta: +q.sta.toFixed(2), off: +q.off.toFixed(2) })),
      datum_top_ft: +zTop.toFixed(2), datum_bot_ft: +zBot.toFixed(2)
    });
    if (pr.through) pr.through = pr.through.slice();
    return f._fen;
  }

  /* ------------------------------------------------------------------ */
  /* the drawing                                                         */
  /* ------------------------------------------------------------------ */
  /* ONE renderer: the Fence tab shows it, the PNG serialises it and the 3D
     strip is textured from it. Every colour is a presentation ATTRIBUTE, never
     a CSS class — the PNG hands the serialised SVG to an <img> and a document
     stylesheet does not travel with it (the rule js/borelogs.js states). */
  function drawSvg(f, opts) {
    const o = opts || {};
    const R = f._fen || derive(f);
    if (!R) return null;
    const pr = f.props;
    /* 360 is the floor: PADL + PADR + a column at each end is 184 px before a
       single station is drawn, and below ~360 the axes and the id labels run
       into each other. A phone stage is 393, so the drawing fits it 1:1. */
    const W = Math.max(360, Math.round(o.w || 900));
    const ve = pr.ve || 1;
    const total = Math.max(1, R.total);
    const inset = CW / 2 + 4;
    const hppf = Math.max(1e-6, (W - PADL - PADR - 2 * inset) / total);
    const vppf = hppf * ve;                          /* px per elevation foot */
    const drawH = (R.zTop - R.zBot) * vppf;
    const H = Math.ceil(PADT + drawH + PADB);
    const xOf = s => PADL + inset + s * hppf;
    const yOf = z => PADT + (R.zTop - z) * vppf;
    const p = [], defs = [];
    const esc2 = esc;
    const line = (x1, y1, x2, y2, col, w, dash, cls, at) =>
      `<line${cls ? ` class="${cls}"` : ""} x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}"`
      + ` x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${col}" stroke-width="${w || 1}"`
      + `${dash ? ` stroke-dasharray="${dash}"` : ""}${at || ""}/>`;
    const text = (x, y, s, col, size, anchor, extra) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${col}" font-size="${size || 9}"`
      + `${anchor ? ` text-anchor="${anchor}"` : ""}${extra || ""}>${esc2(s)}</text>`;
    const HALO = ` stroke="${C.plate}" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round"`;

    /* ---- the elevation grid and the two elevation axes ---- */
    const stepFt = vppf >= 6 ? 5 : vppf >= 2.4 ? 10 : vppf >= 1 ? 25 : 50;
    for (let z = Math.ceil(R.zBot / stepFt) * stepFt; z <= R.zTop; z += stepFt) {
      const y = yOf(z);
      p.push(line(PADL - 6, y, W - PADR + 6, y, C.grid, .6));
      p.push(text(PADL - 9, y + 3, fmt0(z), C.ax, 9, "end"));
      p.push(text(W - PADR + 9, y + 3, fmt0(z), C.ax, 9));
    }
    p.push(text(PADL - 9, PADT - 16, "ELEV ft", C.hd, 8, "end", ' letter-spacing=".06em"'));
    p.push(text(W - PADR + 9, PADT - 16, "ELEV ft", C.hd, 8, null, ' letter-spacing=".06em"'));

    /* ---- the station axis along the bottom ---- */
    const yAx = PADT + drawH + FOOT.axis;
    p.push(line(PADL, yAx, W - PADR, yAx, C.ax, 1));
    const staStep = total > 4000 ? 500 : total > 1600 ? 200 : total > 700 ? 100 : total > 240 ? 50 : 25;
    for (let s = 0; s <= total + 1e-6; s += staStep) {
      p.push(line(xOf(s), yAx, xOf(s), yAx + 4, C.ax, 1));
      p.push(text(xOf(s), PADT + drawH + FOOT.staLab, staLabel(s), C.ax, 8.5, "middle"));
    }
    if (total % staStep > staStep * 0.35) {
      p.push(line(xOf(total), yAx, xOf(total), yAx + 4, C.ax, 1));
      p.push(text(xOf(total), PADT + drawH + FOOT.staLab, staLabel(total), C.ax, 8.5, "middle"));
    }

    /* ---- the class bands, correlated between adjacent holes (v24) ----
       One filled polygon per class per span: the band's top and base joined
       linearly to the next hole's, so the waste body reads as one shaded band
       of varying thickness with the native under it and the rock hatched. A
       band that stops at a hole's own bottom rather than at a logged contact
       carries a dashed edge. */
    const spans = [];
    for (let i = 0; i + 1 < R.holes.length; i++) {
      const a = R.holes[i], b = R.holes[i + 1];
      const co = spanCorrelation(a.id, b.id);
      if (!co) continue;
      spans.push({ a, b, co });
    }
    let nBands = 0, nUnits = 0, nPinch = 0;
    for (const sp of spans) {
      const xa = xOf(sp.a.sta), xb = xOf(sp.b.sta);
      for (const bd of sp.co.bands) {
        const col = BL().classColor(bd.cls);
        const pts4 = [[xa, yOf(bd.a.top)], [xb, yOf(bd.b.top)],
                      [xb, yOf(bd.b.base)], [xa, yOf(bd.a.base)]];
        p.push(`<polygon class="fnband" data-cls="${esc2(bd.cls)}"`
          + ` data-a="${esc2(sp.a.id)}" data-b="${esc2(sp.b.id)}"`
          + ` data-ended="${bd.ended ? 1 : 0}" points="${pts4.map(q => q[0].toFixed(1) + "," + q[1].toFixed(1)).join(" ")}"`
          + ` fill="${col}" fill-opacity="${bd.cls === "bedrock" ? ".13" : ".17"}"`
          + ` stroke="none"/>`);
        /* the two edges: the top is a contact, the base is a contact or the
           bottom of what was drilled */
        p.push(line(xa, yOf(bd.a.top), xb, yOf(bd.b.top), col, 1.1, null, "fnbandedge"));
        p.push(line(xa, yOf(bd.a.base), xb, yOf(bd.b.base), col, 1.1,
          bd.ended ? "3 4" : null, "fnbandedge",
          ` data-ended="${bd.ended ? 1 : 0}"`));
        nBands++;
      }
      /* the units inside a band, matched in order by USCS family */
      for (const u of sp.co.units) {
        p.push(line(xa, yOf(u.za), xb, yOf(u.zb), C.hd, u.sure ? 1 : .8,
          u.sure ? null : "2 3", "fnunit",
          ` data-cls="${esc2(u.cls)}" data-sure="${u.sure ? 1 : 0}"`
          + ` data-uscs="${esc2(u.uscs || "")}"`));
        nUnits++;
      }
      /* a unit only one hole logged pinches out to a POINT at mid-span */
      const xm = (xa + xb) / 2;
      for (const pn of sp.co.pinch) {
        const x0 = pn.side === "a" ? xa : xb;
        const u = pn.u, ym = yOf((u.top + u.base) / 2);
        p.push(`<path class="fnpinch" data-cls="${esc2(pn.cls)}" data-side="${pn.side}"`
          + ` d="M${x0.toFixed(1)} ${yOf(u.top).toFixed(1)} L${xm.toFixed(1)} ${ym.toFixed(1)}`
          + ` L${x0.toFixed(1)} ${yOf(u.base).toFixed(1)}" fill="none"`
          + ` stroke="${BL().classColor(pn.cls)}" stroke-width=".9" stroke-dasharray="2 3"`
          + ` stroke-opacity=".8"/>`);
        nPinch++;
      }
    }

    /* ---- the horizon correlations, one segment per neighbouring pair ---- */
    const links = {};
    for (const hz of HZ) {
      links[hz.key] = 0;
      const col = hzColor(hz.tone);
      for (let i = 0; i + 1 < R.holes.length; i++) {
        const a = R.holes[i], b = R.holes[i + 1];
        const za = horizonZ(hz, a.id), zb = horizonZ(hz, b.id);
        if (za == null && zb == null) continue;
        /* dashed where the far hole never reached this horizon: the segment is
           drawn level from the one that did, and it does not pretend to be a
           measurement of the other */
        const miss = za == null || zb == null;
        const y1 = yOf(za == null ? zb : za), y2 = yOf(zb == null ? za : zb);
        p.push(line(xOf(a.sta), y1, xOf(b.sta), y2, col, miss ? 1 : hz.w,
          miss ? "3 4" : (hz.dash || ""), "fncorr",
          ` data-hz="${hz.key}" data-miss="${miss ? 1 : 0}"`
          + ` data-a="${esc2(a.id)}" data-b="${esc2(b.id)}"`));
        links[hz.key]++;
      }
    }

    /* ---- the lidar ground, over the band and under the columns ---- */
    {
      let d = "", pen = false;
      for (const g of R.ground) {
        if (!isFinite(g.z)) { pen = false; continue; }
        d += (pen ? "L" : "M") + xOf(g.sta).toFixed(1) + " " + yOf(g.z).toFixed(1) + " ";
        pen = true;
      }
      if (d) p.push(`<path class="fnground" d="${d.trim()}" fill="none" stroke="${C.ground}"`
        + ` stroke-width="1.8" stroke-linejoin="round"/>`);
    }

    /* ---- each hole: its own logged ground as a tick, then its column ---- */
    for (const q of R.holes) {
      const h = BL().byId(q.id);
      if (!h) continue;
      const x = xOf(q.sta);
      /* the hole's own ground elevation against the lidar's, as a tick on the
         surface line — a disagreement is a fact of this site (Δ lidar), and it
         is shown rather than corrected */
      if (h.elev != null) {
        const yz = yOf(h.elev);
        p.push(line(x - 7, yz, x + 7, yz, C.tick, 1.6, null, "fnelevtick",
          ` data-hole="${esc2(q.id)}" data-elev="${h.elev}"`));
      }
      const r = BL().column(h, { tier: "stick", w: CW, ppf: vppf, datum: "elev",
        zTop: R.zTop, zBot: R.zBot, padTop: PADT, axes: false });
      defs.push(r.defs);
      const y0 = r.yOf(0);
      p.push(`<g class="fncol" data-hole="${esc2(q.id)}" data-y0="${y0.toFixed(2)}"`
        + ` data-elev="${h.elev == null ? "" : h.elev}" data-sta="${q.sta.toFixed(2)}"`
        + ` data-off="${q.off.toFixed(2)}" transform="translate(${(x - CW / 2).toFixed(1)},0)">`
        + r.g + `</g>`);
      /* the id and the offset, above the collar, on a plate so they read over
         the ground line and the band */
      /* the id is 10.5 px and the station line 8.2 px: nine pixels apart is
         one pixel short of the two glyph boxes, on every fence (v24) */
      p.push(text(x, Math.max(11, y0 - 14), q.id, C.ink, 10.5, "middle",
        ' font-weight="700"' + HALO));
      p.push(text(x, Math.max(22, y0 - 3),
        `${staLabel(q.sta)} · ${fmt0(Math.abs(q.off))} ft${sideOf(q.off) ? " " + sideOf(q.off) : ""}`,
        C.hd, 8.2, "middle", HALO));
    }

    /* ---- the true hole-to-hole distance, once per span ---- */
    for (const sp of spans) {
      const d = Math.hypot(sp.a.x - sp.b.x, sp.a.y - sp.b.y);
      const xm = (xOf(sp.a.sta) + xOf(sp.b.sta)) / 2;
      p.push(line(xOf(sp.a.sta) + 4, PADT + drawH + FOOT.spanRule,
        xOf(sp.b.sta) - 4, PADT + drawH + FOOT.spanRule, C.grid, 1));
      p.push(text(xm, PADT + drawH + FOOT.span, `${fmt0(d)} ft`, C.hd, 8.5, "middle", ` class="fnspan"`
        + ` data-a="${esc2(sp.a.id)}" data-b="${esc2(sp.b.id)}" data-ft="${d.toFixed(1)}"`));
    }

    /* ---- the scale bar: BOTH scales, because a fence is exaggerated ---- */
    {
      const y = PADT + drawH + FOOT.bar;
      const barFt = staStep;
      p.push(line(PADL, y, PADL + barFt * hppf, y, C.ax, 2));
      p.push(line(PADL, y - 3, PADL, y + 3, C.ax, 2));
      p.push(line(PADL + barFt * hppf, y - 3, PADL + barFt * hppf, y + 3, C.ax, 2));
      p.push(text(PADL + barFt * hppf + 8, y + 3, `${fmt0(barFt)} ft horizontal`, C.ax, 8.5));
      p.push(text(W - PADR, y + 3, `${ve}× vertical exaggeration · `
        + `1 in = ${fmt0(96 / hppf)} ft H · 1 in = ${fmt0(96 / vppf)} ft V`, C.ax, 8.5, "end"));
    }

    /* ---- the key, then the rule, in the voice the app is under: the result
       is the drawing and this is the one `·` line that says what it means ---- */
    {
      const yC = PADT + drawH + FOOT.keyClass;
      let x = PADL;
      for (const cls of CLASS_ORDER) {
        p.push(`<rect x="${x}" y="${(yC - 6).toFixed(1)}" width="16" height="7"`
          + ` fill="${BL().classColor(cls)}" fill-opacity=".45" stroke="${BL().classColor(cls)}"`
          + ` stroke-width=".8"/>`);
        p.push(text(x + 20, yC, BL().classWord(cls), C.ax, 8.5));
        x += 108;
      }
      const yH = PADT + drawH + FOOT.keyHz;
      x = PADL;
      for (const hz of HZ) {
        p.push(line(x, yH - 3, x + 18, yH - 3, hzColor(hz.tone), hz.w, hz.dash || ""));
        p.push(text(x + 22, yH, hz.label + (links[hz.key] ? "" : " — none"), C.ax, 8.5));
        x += 110;
      }
    }
    {
      /* ONE `·` LINE, the voice rule's form: what the drawing does between the
         holes, and what the ground it hangs from is. Two lines only when the
         drawing is too narrow for one. */
      const rule = ["class bands correlated linearly between adjacent holes",
                    "units matched by USCS family", "pinch-outs at mid-span",
                    "lidar ground Jan 2024"];
      const rows = W >= 900 ? [rule.join(" · ")]
                            : [rule.slice(0, 2).join(" · "), rule.slice(2).join(" · ")];
      const y0 = PADT + drawH + FOOT.note;
      rows.forEach((r2, k) =>
        p.push(text(PADL, y0 + k * FOOT.noteLine, r2, C.ax, 8.5, null, ` class="fnnote"`)));
    }

    const svg = `<svg class="fnsvg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`
      + ` xmlns="http://www.w3.org/2000/svg" role="img">`
      + `<style>text{font-family:"SF Mono",ui-monospace,Consolas,Menlo,monospace}</style>`
      + (o.bg === false ? "" : `<rect x="0" y="0" width="${W}" height="${H}" fill="${o.bg || "#12181C"}"/>`)
      + `<defs>${defs.join("").replace(/<\/?defs>/g, "")}</defs>`
      + p.join("") + `</svg>`;
    /* `bg` is the one thing the 3D strip changes about the drawing: an OPAQUE
       panel standing in the terrain reads as a black wall from any distance
       (the first cut did), and a fully transparent one loses the horizons
       against a bright ortho. A translucent plate is both readable and
       obviously a section through the ground rather than a billboard on it. */
    return { svg, w: W, h: H, drawH, hppf, vppf, xOf, yOf,
             zTop: R.zTop, zBot: R.zBot, total, links, holes: R.holes,
             bands: nBands, units: nUnits, pinch: nPinch, spans: spans.length,
             padTop: PADT, padBot: PADB, padLeft: PADL, padRight: PADR };
  }

  /* ------------------------------------------------------------------ */
  /* the cut on the map                                                  */
  /* ------------------------------------------------------------------ */
  /* preferCanvas means a Leaflet vector has no DOM element, so nothing here is
     styled by className — the band, the ticks and the halo are all options and
     setStyle (the rule that made .sheetpulse dead CSS). */
  function bandRings(pts, half) {
    const rings = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = -dy / len * half, ny = dx / len * half;
      rings.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
                  [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]);
    }
    /* a round cap at every interior vertex, so the band is a real corridor and
       not a chain of rectangles with a notch at each bend. One polygon with
       many rings under fillRule "nonzero" renders as their UNION, which is why
       the overlaps do not darken. */
    for (let i = 1; i + 1 < pts.length; i++) {
      const c = pts[i], ring = [];
      for (let k = 0; k < 24; k++) {
        const t = k / 24 * Math.PI * 2;
        ring.push([c[0] + Math.cos(t) * half, c[1] + Math.sin(t) * half]);
      }
      rings.push(ring);
    }
    /* EVERY RING THE SAME WAY ROUND. Leaflet puts them all in one path and
       fills with `nonzero`, which unions same-wound rings and CANCELS opposite
       ones — a bend whose two rectangles wound the other way would punch a hole
       in the band it is supposed to join. A rectangle's winding follows the
       segment's direction; the caps are always counter-clockwise. */
    const signed = r => { let a = 0;
      for (let i = 0; i < r.length; i++) { const p0 = r[i], p1 = r[(i + 1) % r.length];
        a += p0[0] * p1[1] - p1[0] * p0[1]; }
      return a / 2; };            /* polyArea() in js/util.js is ABSOLUTE */
    for (const r of rings) if (signed(r) < 0) r.reverse();
    return rings;
  }

  function buildFence(f) {
    const g = f.layer;
    if (!g || !g.clearLayers) return;
    g.clearLayers();
    const R = f._fen || derive(f);
    if (!R || !f.pts || f.pts.length < 2) return;
    const sel = SBMM.store.selected === f.id;
    const col = (f.style && f.style.color) || "#C7A6F0";
    const half = f.props.swath_ft || DEFAULTS.swath_ft;

    /* the swath — a fence THROUGH named holes has none: nothing was caught */
    const rings = f.props.through ? [] : bandRings(f.pts, half);
    if (rings.length) {
      L.polygon(rings.map(r => r.map(q => [q[1], q[0]])), {
        pane: "drawings", color: col, weight: 1.2, opacity: .7, dashArray: "7 6",
        fillColor: col, fillOpacity: .13, fillRule: "nonzero", interactive: false
      }).addTo(g);
    }
    /* the alignment */
    L.polyline(f.pts.map(q => [q[1], q[0]]), {
      pane: "drawings", color: sel ? "#FFD34D" : col, weight: sel ? 4.5 : 2.6, opacity: .95
    }).addTo(g);

    /* the projected holes: a tick on the alignment, a tie back to the hole */
    for (const q of R.holes) {
      const u = [q.px - q.x, q.py - q.y];
      const d = Math.hypot(u[0], u[1]);
      const nx = d > 1e-6 ? u[0] / d : 0, ny = d > 1e-6 ? u[1] / d : 0;
      const t = Math.max(18, half * 0.12);
      L.polyline([[q.py - ny * t, q.px - nx * t], [q.py + ny * t, q.px + nx * t]],
        { pane: "drawings", color: col, weight: 2, opacity: .9, interactive: false }).addTo(g);
      if (d > 1) L.polyline([[q.y, q.x], [q.py, q.px]],
        { pane: "drawings", color: col, weight: 1, opacity: .45, dashArray: "3 4",
          interactive: false }).addTo(g);
      const mk = L.circleMarker([q.y, q.x], { pane: "drawings", radius: 4.5, color: col,
        weight: 1.6, fillColor: "#12181C", fillOpacity: 1 })
        .bindTooltip(`${q.id} · ${staLabel(q.sta)} · ${fmt0(Math.abs(q.off))} ft`
          + `${sideOf(q.off) ? " " + sideOf(q.off) : ""}`, { sticky: true, className: "ctip" });
      mk.on("mouseover", () => highlight(q.id));
      mk.on("mouseout", () => highlight(null));
      mk.on("click", ev => { L.DomEvent.stopPropagation(ev);
        if (SBMM.borewin) SBMM.borewin.open(q.id, { tab: "log" }); });
      mk.addTo(g);
    }
  }

  /* the two directions of the cross-highlight (§3.2) */
  let flashLayer = null;
  function flashHole(id) {
    if (flashLayer) { try { SBMM.map.removeLayer(flashLayer); } catch (e) { /* gone */ } flashLayer = null; }
    if (!id || !has() || !SBMM.map) return;
    const h = BL().byId(id);
    if (!h) return;
    flashLayer = L.circleMarker([h.y, h.x], { pane: "drawings", radius: 11, color: "#FFD34D",
      weight: 3, fill: false, interactive: false }).addTo(SBMM.map);
  }
  function highlight(id) {
    for (const el of document.querySelectorAll(".fncolhl")) el.remove();
    for (const el of document.querySelectorAll(".fncol")) el.setAttribute("opacity", "1");
    if (!id) return;
    const gEl = document.querySelector(`.fncol[data-hole="${CSS.escape(id)}"]`);
    if (!gEl) return;
    const box = gEl.getBBox ? gEl.getBBox() : null;
    if (!box) return;
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("class", "fncolhl");
    r.setAttribute("x", (box.x - 4).toFixed(1)); r.setAttribute("y", (box.y - 4).toFixed(1));
    r.setAttribute("width", (box.width + 8).toFixed(1));
    r.setAttribute("height", (box.height + 8).toFixed(1));
    r.setAttribute("fill", "none"); r.setAttribute("stroke", "#FFD34D");
    r.setAttribute("stroke-width", "1.6"); r.setAttribute("rx", "3");
    gEl.parentNode.insertBefore(r, gEl);
  }

  /* ------------------------------------------------------------------ */
  /* the feature                                                         */
  /* ------------------------------------------------------------------ */
  /* mkFence rebuilds from `pts` and `props` and runs NO compute job: the
     projection is 44 dot products and the ground is a few hundred bilinear
     reads, both main-thread arithmetic. That is what keeps a session load at
     zero jobs, which is the invariant `flow` and `photo` are under too. */
  function mkFence(pts, name, props, spec) {
    const f = SBMM.tools.newFeature("fence", pts.map(q => q.slice()),
      name || SBMM.tools.nextName("Fence"),
      { group: (spec && spec.group) || "Borings", style: spec && spec.style,
        locked: spec && spec.locked });
    f.props = Object.assign({}, DEFAULTS, props || {});
    derive(f);
    buildFence(f);
    f.card = SBMM.results.card(f, f.name, []);
    fillCard(f);
    return f;
  }

  /* the alignment moved: re-project, re-sample, redraw. No job. */
  function recompute(f) {
    derive(f);
    buildFence(f);
    fillCard(f);
    if (SBMM.viewer3d && SBMM.viewer3d.isOpen && SBMM.viewer3d.isOpen())
      SBMM.viewer3d.refreshOverlays && SBMM.viewer3d.refreshOverlays();
    if (SBMM.borewin && SBMM.borewin.isOpen() && SBMM.borewin.tab() === "fence")
      SBMM.borewin.tab("fence");
  }

  function rows(f) {
    const R = f._fen, pr = f.props;
    if (!R) return [["Fence", "no alignment"]];
    const nat = R.holes.filter(q => horizonZ(HZ[0], q.id) != null).length;
    let bands = 0, units = 0, pinch = 0;
    for (let i = 0; i + 1 < R.holes.length; i++) {
      const co = spanCorrelation(R.holes[i].id, R.holes[i + 1].id);
      if (!co) continue;
      bands += co.bands.length; units += co.units.length; pinch += co.pinch.length;
    }
    const rows = [
      [pr.through ? "Holes on the line" : "Holes in the swath", `${R.holes.length}`,
       R.holes.map(q => `${q.id} ${staLabel(q.sta)} ${fmt0(Math.abs(q.off))} ft${sideOf(q.off) ? " " + sideOf(q.off) : ""}`).join(" · ")],
      ["Alignment", `${fmt(R.total, 1)} ft (${staLabel(0)} – ${staLabel(R.total)})`]
    ];
    rows.push(pr.through ? ["Drawn", "through the named holes"]
                         : ["Swath", `${fmt0(pr.swath_ft)} ft either side`]);
    rows.push(["Class bands", `${bands} over ${Math.max(0, R.holes.length - 1)} spans`,
      "waste, native and bedrock, where both holes of a span state one"]);
    rows.push(["Units correlated", `${units}`,
      pinch ? `${pinch} pinch out at mid-span` : "none pinch out"]);
    rows.push(["Native contact", `${nat} of ${R.holes.length} holes`]);
    rows.push(["Datum", `${fmt0(R.zBot)} – ${fmt0(R.zTop)} ft NAVD88`]);
    rows.push(["Vertical exaggeration", `${pr.ve}×`]);
    return rows;
  }

  function fillCard(f) {
    if (!f.card || !f.card.isConnected) return;
    SBMM.results.setRows(f.card, rows(f));
    let ctl = f.card.querySelector(".fnctl");
    if (!ctl) {
      ctl = document.createElement("div");
      ctl.className = "volctl fnctl";
      ctl.innerHTML = `
        <div class="crow"><span>swath</span>
          <input type="number" class="fnsw" step="25" min="10" style="width:64px"><span class="mut">ft either side</span></div>
        <div class="crow"><span>vertical ×</span>
          <select class="fnve">${VE_CHOICES.map(v => `<option value="${v}">${v}×</option>`).join("")}</select>
          <span class="spacer"></span></div>
        <div class="crow btns">
          <button class="minib fnopen" title="Open the fence in the boring-log window">open in window</button>
          <button class="minib fnpng" title="Save the drawing as a PNG">PNG</button>
          <button class="minib fncsv" title="Station, offset, ground and every horizon, per hole">CSV</button>
          <button class="minib fndxf" title="Section coordinates: X = station ft, Y = elevation ft">DXF</button></div>`;
      f.card.appendChild(ctl);
      SBMM.results.appendNote(f.card,
        "Class bands correlated linearly between adjacent holes · units matched by USCS "
        + "family · pinch-outs at mid-span · logged contacts, logger's remark leads · "
        + "lidar ground Jan 2024");
      const q = c => ctl.querySelector(c);
      q(".fnsw").onchange = e => {
        f.props.swath_ft = Math.max(10, parseFloat(e.target.value) || DEFAULTS.swath_ft);
        recompute(f); SBMM.store.autosave();
      };
      q(".fnve").onchange = e => {
        f.props.ve = parseFloat(e.target.value) || 1;
        recompute(f); SBMM.store.autosave();
      };
      q(".fnopen").onclick = () => openInWindow(f);
      q(".fnpng").onclick = () => exportPng(f);
      q(".fncsv").onclick = () => exportCsv(f);
      q(".fndxf").onclick = () => exportDxf(f);
    }
    const sw = ctl.querySelector(".fnsw");
    if (sw) {
      sw.value = String(f.props.swath_ft);
      const row = sw.closest(".crow");
      if (row) row.style.display = f.props.through ? "none" : "";
    }
    const veS = ctl.querySelector(".fnve"); if (veS) veS.value = String(f.props.ve);
  }

  function openInWindow(f) {
    if (!SBMM.borewin) { toast("the log window is not in this build"); return; }
    current = f.id;
    const w = SBMM.borewin.open(f._fen && f._fen.holes.length ? f._fen.holes[0].id : null,
      { tab: "fence" });
    if (w) SBMM.borewin.tab("fence");
  }

  /* which fence the window is showing */
  let current = null;
  function currentFence() {
    const f = current ? SBMM.store.byId(current) : null;
    if (f && f.type === "fence") return f;
    const all = list();
    return all.length ? all[all.length - 1] : null;
  }
  function setCurrent(id) { current = id; }

  /* ------------------------------------------------------------------ */
  /* exports                                                             */
  /* ------------------------------------------------------------------ */
  function exportPng(f) {
    const d = drawSvg(f, { w: 1400 });
    if (!d) { toast("this fence has no alignment to draw"); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = d.w * 2; cv.height = d.h * 2 + 36;
        const g = cv.getContext("2d");
        g.fillStyle = "#12181C"; g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = "#E8EEF1"; g.font = "600 20px system-ui,sans-serif";
        g.fillText(`${f.name || "Fence"} — ${d.holes.length} borings, `
          + `${fmt0(d.total)} ft, ${f.props.ve}× vertical`, 12, 26);
        g.drawImage(img, 0, 34, cv.width, d.h * 2);
        if (SBMM.watermark) SBMM.watermark.burn(cv);
        cv.toBlob(b => {
          if (!b) { toast("could not write the PNG — see console"); return; }
          download(`sbmm_fence_${(f.name || "fence").replace(/\W+/g, "_")}.png`, b);
        }, "image/png");
      } catch (e) { console.error(e); toast("PNG export failed: " + e.message); }
    };
    img.onerror = () => toast("could not render the fence to a picture");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(d.svg);
  }

  /* the class-band tops travel with the horizons: a reader who wants the
     shaded body in a spreadsheet wants the elevations it was drawn from */
  const CSV_HEAD = "station_ft,station,hole,offset_ft,side,ground_lidar_ft,ground_logged_ft,"
    + "native_contact_elev_ft,bedrock_elev_ft,water_elev_ft,total_depth_ft,"
    + "waste_top_ft,waste_base_ft,native_top_ft,native_base_ft,bedrock_top_ft,bedrock_base_ft";
  function csvText(f) {
    const R = f._fen || derive(f);
    if (!R) return "";
    const gAt = s => {
      let best = null;
      for (const g of R.ground) if (!best || Math.abs(g.sta - s) < Math.abs(best.sta - s)) best = g;
      return best && isFinite(best.z) ? best.z : null;
    };
    const n = v => v == null || !isFinite(v) ? "" : v.toFixed(2);
    let out = CSV_HEAD + "\n";
    for (const q of R.holes) {
      const h = BL().byId(q.id);
      const bd = bandsOf(q.id) || {};
      const bn = k => bd[k] ? `${n(bd[k].top)},${n(bd[k].base)}` : ",";
      out += `${q.sta.toFixed(2)},${staLabel(q.sta)},${q.id},${Math.abs(q.off).toFixed(2)},`
        + `${sideOf(q.off)},${n(gAt(q.sta))},${n(h ? h.elev : null)},`
        + `${n(horizonZ(HZ[0], q.id))},${n(horizonZ(HZ[1], q.id))},${n(horizonZ(HZ[2], q.id))},`
        + `${n(h ? h.depth : null)},${bn("waste")},${bn("native")},${bn("bedrock")}\n`;
    }
    return out;
  }
  function exportCsv(f) {
    const t = csvText(f);
    if (!t) { toast("this fence has no holes to export"); return; }
    download(`sbmm_fence_${(f.name || "fence").replace(/\W+/g, "_")}.csv`,
      new Blob([t], { type: "text/csv" }));
    toast(`${(f._fen || {}).holes ? f._fen.holes.length : 0} borings exported as CSV`);
  }

  /* THE DXF IS IN SECTION COORDINATES: X = station ft, Y = elevation ft.
     That is not the app's State Plane and it is deliberate — this is the file
     that goes straight into a Civil 3D section view, where the drawing IS a
     station/elevation grid. js/dxf.js writes it through the same R12 writer
     everything else uses (writeEntities), so there is no second DXF writer. */
  function dxfEntities(f) {
    const R = f._fen || derive(f);
    if (!R) return null;
    const ents = [], layers = new Map();
    const lay = (n, c) => { if (!layers.has(n)) layers.set(n, c); return n; };
    const cWaste = BL().classColor("waste");
    /* the ground */
    const run = [];
    const flush = () => {
      if (run.length > 1) ents.push({ kind: "polyline", layer: lay("FENCE-GROUND", "#E8EEF1"),
        pts: run.slice() });
      run.length = 0;
    };
    for (const g of R.ground) { if (isFinite(g.z)) run.push([g.sta, g.z]); else flush(); }
    flush();
    /* the horizons, one polyline through the holes that state them */
    const HL = { native: ["FENCE-CONTACT", hzColor("contact")],
                 rock: ["FENCE-BEDROCK", hzColor("bedrock")],
                 water: ["FENCE-WATER", hzColor("water")] };
    for (const hz of HZ) {
      const pts = [];
      for (const q of R.holes) {
        const z = horizonZ(hz, q.id);
        if (z != null) pts.push([q.sta, z]);
      }
      if (pts.length > 1) ents.push({ kind: "polyline", layer: lay(HL[hz.key][0], HL[hz.key][1]), pts });
      else if (pts.length === 1) ents.push({ kind: "point", layer: lay(HL[hz.key][0], HL[hz.key][1]), point: pts[0] });
    }
    /* THE CLASS BANDS, one CLOSED polyline per class per span, on a layer per
       class — which is what a drafter hatches in Civil 3D — and the pinch-outs
       on one layer of their own. Same geometry the drawing fills. */
    const BANDLAY = { waste: "FENCE-BAND-WASTE", native: "FENCE-BAND-NATIVE",
                      bedrock: "FENCE-BAND-BEDROCK" };
    for (let i = 0; i + 1 < R.holes.length; i++) {
      const a = R.holes[i], b = R.holes[i + 1];
      const co = spanCorrelation(a.id, b.id);
      if (!co) continue;
      for (const bd of co.bands)
        ents.push({ kind: "polyline", closed: true,
                    layer: lay(BANDLAY[bd.cls], BL().classColor(bd.cls)),
                    pts: [[a.sta, bd.a.top], [b.sta, bd.b.top],
                          [b.sta, bd.b.base], [a.sta, bd.a.base]] });
      for (const u of co.units)
        ents.push({ kind: "line", layer: lay("FENCE-UNITS", "#8FA3AE"),
                    a: [a.sta, u.za], b: [b.sta, u.zb] });
      const xm = (a.sta + b.sta) / 2;
      for (const pn of co.pinch) {
        const s0 = pn.side === "a" ? a.sta : b.sta;
        ents.push({ kind: "polyline", layer: lay("FENCE-UNITS", "#8FA3AE"),
                    pts: [[s0, pn.u.top], [xm, (pn.u.top + pn.u.base) / 2], [s0, pn.u.base]] });
      }
    }
    /* the waste band's own outline against the LIDAR ground, kept because it
       is the surface a drafter cuts to rather than the logged collar */
    {
      const nat = HZ[0];
      const have = R.holes.filter(q => horizonZ(nat, q.id) != null);
      if (have.length > 1) {
        const top = [], bot = [];
        for (const g of R.ground) {
          if (g.sta < have[0].sta - 1e-6 || g.sta > have[have.length - 1].sta + 1e-6) continue;
          if (!isFinite(g.z)) continue;
          top.push([g.sta, g.z]);
        }
        for (const q of have) bot.push([q.sta, horizonZ(nat, q.id)]);
        if (top.length > 1)
          ents.push({ kind: "polyline", closed: true, layer: lay("FENCE-WASTE", cWaste),
                      pts: top.concat(bot.reverse()) });
      }
    }
    /* one layer per hole: the column as a vertical line with a tick at every
       stratum boundary, and the id as TEXT at the collar */
    for (const q of R.holes) {
      const h = BL().byId(q.id);
      if (!h || h.elev == null) continue;
      const name = lay("FENCE-" + String(q.id).toUpperCase().replace(/[^A-Z0-9_\-$.]/g, "_"),
        "#8FA3AE");
      ents.push({ kind: "line", layer: name, a: [q.sta, h.elev], b: [q.sta, h.elev - h.depth] });
      const seen = new Set();
      for (const s of (h.strata || [])) {
        if (!s.primary) continue;
        for (const ft of [s.top, s.base]) {
          const k = ft.toFixed(2);
          if (seen.has(k)) continue;
          seen.add(k);
          ents.push({ kind: "line", layer: name,
                      a: [q.sta - 3, h.elev - ft], b: [q.sta + 3, h.elev - ft] });
        }
      }
      ents.push({ kind: "text", layer: name, point: [q.sta + 4, h.elev + 3], h: 4, text: q.id });
    }
    /* the stations, as text on the ground line */
    const staStep = R.total > 1600 ? 200 : R.total > 700 ? 100 : 50;
    for (let s = 0; s <= R.total + 1e-6; s += staStep) {
      let z = null;
      for (const g of R.ground) if (isFinite(g.z) && (z == null || Math.abs(g.sta - s) < 1)) {
        if (Math.abs(g.sta - s) <= 1) { z = g.z; break; }
      }
      if (z == null) continue;
      ents.push({ kind: "text", layer: lay("FENCE-STATION", "#6C7F8A"),
                  point: [s, z + 6], h: 4, text: staLabel(s) });
    }
    return { layers: [...layers].map(([name, color]) => ({ name, color })), entities: ents };
  }
  function exportDxf(f) {
    const spec = dxfEntities(f);
    if (!spec || !spec.entities.length) { toast("this fence has nothing to export"); return; }
    if (!SBMM.dxf || !SBMM.dxf.writeEntities) { toast("the DXF writer is not in this build"); return; }
    const txt = SBMM.dxf.writeEntities(spec.layers, spec.entities);
    download(`sbmm_fence_${(f.name || "fence").replace(/\W+/g, "_")}_section.dxf`,
      new Blob([txt], { type: "application/dxf" }));
    toast(`fence exported as DXF R12 — section coordinates, X = station ft, Y = elevation ft`);
  }

  /* ------------------------------------------------------------------ */
  /* the command and the tool                                            */
  /* ------------------------------------------------------------------ */
  function start(pts, props) {
    /* the sketch is over, so the mode is over: leaving the HUD saying "Fence"
       with nothing armed is the §2 rule broken in the quietest possible way */
    SBMM.mode.navigate();
    const f = mkFence(pts, null, props);
    SBMM.undo.push("fence",
      () => SBMM.store.remove(f),
      () => { SBMM.store.readd(f); derive(f); buildFence(f); fillCard(f); });
    SBMM.store.select(f.id);
    setCurrent(f.id);
    if (!f._fen || !f._fen.holes.length)
      toast(`no boring within ${fmt0(f.props.swath_ft)} ft of that line — widen the swath on the card`);
    return f;
  }

  /* A FENCE THROUGH NAMED HOLES (v24 Part 3.1). The alignment IS the polyline
     hole-to-hole — each hole at its own vertex, station along the polyline,
     offset 0 — and there is no swath, because the holes were named rather than
     caught. `props.through` is what mkFence re-derives from, so a session round
     trip rebuilds exactly this fence with no job. */
  function startThrough(ids) {
    const hs = ids.map(v => BL().byId(v)).filter(Boolean);
    if (hs.length < 2) { toast("a fence through holes needs two of them"); return null; }
    const f = start(hs.map(h => [h.x, h.y]),
      { through: hs.map(h => h.id), swath_ft: 0 });
    if (f) {
      f.name = `Fence — ${hs.map(h => h.id).join(" to ")}`;
      /* the results card's title is an editable .rname span (js/results.js),
         not a heading with a class of its own */
      const t = f.card && f.card.querySelector(".rname");
      if (t) t.textContent = f.name;
      if (SBMM.features && SBMM.features.refresh) SBMM.features.refresh(f);
    }
    return f;
  }

  function cmd(arg) {
    if (!has()) { toast("this build has no boring logs"); return null; }
    const raw = String(arg == null ? "" : arg).trim();
    /* FENCE SB-9 SB-10 SB-11 — anything that is not a bare number is a hole
       list, and an id that names no hole is refused by name rather than
       silently dropped */
    if (raw && !/^[\d.]+$/.test(raw)) {
      const want = raw.split(/[\s,]+/).filter(Boolean);
      const bad = want.filter(v => !BL().byId(v));
      if (bad.length) { toast(`no boring log for ${bad.join(", ")} — type LOGS for the list`); return null; }
      return startThrough(want.map(v => BL().byId(v).id));
    }
    const half = parseFloat(raw);
    const props = {};
    if (!isNaN(half) && half > 0) props.swath_ft = half;
    /* an already-drawn line is an alignment: the same shortcut SEC offers */
    const sel = SBMM.store.selectedFeature();
    if (sel && (sel.type === "line" || sel.type === "profile") && sel.pts.length > 1)
      return start(sel.pts.map(q => q.slice()), props);
    /* the props go in FIRST: SBMM.mode.set runs the mode's enter()
       synchronously, which is what calls beginSketch, which is what reads them
       — set them after and `FENCE 260` silently drew a 150-ft swath */
    pendingProps = props;
    SBMM.mode.set("fence");
    return null;
  }
  let pendingProps = null;

  /* what js/mode.js's "fence" row calls when the mode is entered */
  function beginSketch() {
    if (!has()) { toast("this build has no boring logs"); SBMM.mode.navigate(); return; }
    const props = pendingProps || {};
    pendingProps = null;
    SBMM.tools.setTool(null);
    SBMM.draw.beginPick({
      count: 0, minPts: 2,
      prompts: ["FENCE — click the alignment · Enter to finish"],
      onMove: (pts, cur) => pts.length
        ? { rings: [{ pts: [...pts, cur], closed: false, style: { color: "#C7A6F0" } }],
            label: "fence alignment" }
        : null,
      onDone: pts => { if (pts.length > 1) start(pts, props); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* wire                                                                */
  /* ------------------------------------------------------------------ */
  function wire() {
    /* nothing to wire: every entry point is a command, a mode, a card button or
       the window's Fence tab. The store change hook keeps `current` honest when
       the fence it names is deleted. */
    if (SBMM.store && SBMM.store.onChange)
      SBMM.store.onChange(() => { if (current && !SBMM.store.byId(current)) current = null; });
  }

  return { wire, cmd, beginSketch, mkFence, buildFence, recompute, derive, list,
           startThrough, bandsOf, unitsIn, matchUnits, spanCorrelation, CLASS_ORDER,
           drawSvg, csvText, dxfEntities, exportPng, exportCsv, exportDxf, bandRings,
           projectHoles, projectPoint, groundProfile, horizonZ, flashHole, highlight,
           currentFence, setCurrent, openInWindow, rows, has,
           DEFAULTS, VE_CHOICES,
           /* fields only — a page.evaluate cannot return an object holding DOM
              nodes, and _fen holds none but the feature does */
           stateOf: f => {
             const g = f || currentFence();
             if (!g || !g._fen) return null;
             return { id: g.id, name: g.name, total: g._fen.total,
                      zTop: g._fen.zTop, zBot: g._fen.zBot,
                      swath_ft: g.props.swath_ft, ve: g.props.ve,
                      through: g.props.through ? g.props.through.slice() : null,
                      holes: g._fen.holes.map(q => ({ id: q.id, sta: q.sta, off: q.off })) };
           } };
})();
