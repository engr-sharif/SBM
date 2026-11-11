/* =====================================================================
   js/legend.js — ONE legend (v59, docs/V56_REVIEW_PLAN.md step 4c)

   The app had sixteen legends drawn four ways: CSS gradient bars with a line
   of text beside them, rows of class chips, SVG bars with ticks, and the one
   on the TEM slice that also shows where the value under the pointer sits on
   its scale. That last thing is what a legend is for, and only one had it.

   SBMM.legend.make(spec) -> { el, setMarker(v), update(spec), spec }

     kind     "ramp"     a continuous or stepped colour bar
              "classes"  a row of swatches with labels
     title, units, sub   the heading line (all optional)
     cls                 extra class names on the wrapper (a harness hook, or
                         the old legend's own class)
     -- ramp --
     stops    [css | [r,g,b] ...] evenly spaced, or [[t, css], ...] at 0..1;
              a stop may be "transparent" (the isopach's middle)
     min, max            the values the two ends of the bar stand for
     scale    "lin" (default) | "log"
     steps    n          a classed bar: n flat bands
     vertical true       the bar stands up, max at the top (the 3D view's
                         elevation scale)
     ends     [lo, hi]   the two end labels (default: min and max, formatted)
     ticks    [{ v, label }]   labels along the bar instead of the two ends
     -- classes --
     classes  [{ id, color, label, value?, title?, shape? }]
              shape: "sq" (default) | "dot" | "line"
     -- the pointer --
     reader   the id of a reader in js/readout.js. While the legend is on
              screen its marker follows the pointer: a tick on the bar at the
              reader's `v` there, or the matching class lit by its `cls`.
     read     (x, y, ctx) -> value | null, instead of `reader`, where the
              legend belongs to ONE of several things a reader answers for
              (a volume's own cut/fill map)
     row      { g, l }  the layer row this is the legend of: the legend card
              on the map then draws this scale under the row's name

   THE MARKER COSTS ONE STYLE WRITE, and only when it moved. `track()` is
   called from js/readout.js's hover — the frame the chip is already being
   worked out in — and asks each legend's own reader, so a legend follows the
   pointer whether or not its layer is the one the chip is naming. Nothing
   here asks for a frame.

   A legend is drawn with CSS gradients, not SVG: no gradient ids to collide
   (three id schemes had grown up, and one of them could), and a
   "transparent" stop is just a stop.
   ===================================================================== */
window.SBMM = window.SBMM || {};
SBMM.legend = (function () {
  const live = new Set();                 // legends that follow the pointer
  const byRow = new Map();                // "group/layer" -> a spec, for the legend card on the map
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cssOf = c => Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : String(c);
  const num = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US")
    : Math.abs(v) >= 10 ? (+v.toFixed(1)).toString() : (+v.toFixed(2)).toString();

  /* where a value sits on the bar, 0..1 (clamped), or null */
  function posOf(o, v) {
    if (v == null || !isFinite(v) || !(o.max > o.min)) return null;
    let t;
    if (o.scale === "log") {
      if (!(v > 0) || !(o.min > 0)) return null;
      t = (Math.log(v) - Math.log(o.min)) / (Math.log(o.max) - Math.log(o.min));
    } else t = (v - o.min) / (o.max - o.min);
    return Math.max(0, Math.min(1, t));
  }
  /* a stop is a colour, or [t, colour] with t in 0..1 (an [r, g, b] colour has
     three numbers, a pair has two entries) */
  function stopsOf(o) {
    const a = o.stops || [];
    return a.map((s, i) => Array.isArray(s) && s.length === 2
      ? [s[0], cssOf(s[1])] : [a.length > 1 ? i / (a.length - 1) : 0, cssOf(s)]);
  }
  function gradient(o) {
    const S = stopsOf(o);
    if (!S.length) return "none";
    if (o.steps > 1) {
      /* n flat bands, each the colour at its own middle */
      const at = t => {
        let k = 0; while (k < S.length - 2 && S[k + 1][0] < t) k++;
        return t <= S[0][0] ? S[0][1] : t >= S[S.length - 1][0] ? S[S.length - 1][1]
          : `color-mix(in srgb, ${S[k][1]} ${Math.round(100 * (S[k + 1][0] - t) / Math.max(1e-9, S[k + 1][0] - S[k][0]))}%, ${S[k + 1][1]})`;
      };
      const parts = [];
      for (let i = 0; i < o.steps; i++) {
        const c = at((i + 0.5) / o.steps);
        parts.push(`${c} ${(100 * i / o.steps).toFixed(2)}%`, `${c} ${(100 * (i + 1) / o.steps).toFixed(2)}%`);
      }
      return `linear-gradient(${o.vertical ? "0deg" : "90deg"}, ${parts.join(", ")})`;
    }
    return `linear-gradient(${o.vertical ? "0deg" : "90deg"}, ${S.map(s => `${s[1]} ${(100 * s[0]).toFixed(2)}%`).join(", ")})`;
  }
  function head(o) {
    if (!o.title && !o.units && !o.sub) return "";
    return `<div class="lgh">${o.title ? `<span class="lgt">${esc(o.title)}</span>` : ""}`
      + `${o.units ? `<span class="lgu">${esc(o.units)}</span>` : ""}${o.sub ? `<span class="lgs">${esc(o.sub)}</span>` : ""}</div>`;
  }
  /* the legend's body as a string: `bare` leaves the heading out (the legend
     card on the map names the row itself) */
  function body(o, bare) {
    const h = bare ? "" : head(o);
    if (o.kind === "classes") {
      return h + `<div class="lgcs">` + (o.classes || []).map(c =>
        `<span class="lgc rnLeg" data-c="${esc(c.id)}"${c.title ? ` title="${esc(c.title)}"` : ""}>`
        + `<i class="lgsw ${c.shape || "sq"}" style="background:${esc(cssOf(c.color))}"></i>${esc(c.label)}`
        + `${c.value != null && c.value !== "" ? ` <b>${esc(c.value)}</b>` : ""}</span>`).join("") + `</div>`;
    }
    const ends = o.ends || [num(o.min), num(o.max)];
    if (o.vertical)
      return `<span class="lgvend">${esc(ends[1])}</span>`
        + `<div class="lgbar" style="background:${gradient(o)}"><i class="lgmk" hidden></i></div>`
        + `<span class="lgvend">${esc(ends[0])}</span>`;
    const ticks = (o.ticks || []).map(t => {
      const p = posOf(o, t.v);
      if (p == null) return "";
      return `<span${p < 0.03 ? ` class="a0"` : p > 0.97 ? ` class="a1"` : ""} style="left:${(100 * p).toFixed(2)}%">`
        + `${esc(t.label != null ? t.label : num(t.v))}</span>`;
    }).join("");
    return h
      + `<div class="lgbar" style="background:${gradient(o)}"><i class="lgmk" hidden></i></div>`
      + (ticks ? `<div class="lgticks">${ticks}</div>`
               : `<div class="lgends"><span>${esc(ends[0])}</span><span>${esc(ends[1])}</span></div>`);
  }
  function render(el, o) {
    el.className = "lg lg-" + o.kind + (o.vertical ? " lgv" : "") + (o.cls ? " " + o.cls : "");
    el.innerHTML = body(o);
    if (o.row) byRow.set(o.row.g + "/" + o.row.l, o);
  }
  /* for the legend card on the map: a row's scale, as markup, or "" */
  function rowHtml(g, l) {
    const o = byRow.get(g + "/" + l);
    return o ? `<div class="lg lg-${o.kind} mlscale">${body(o, true)}</div>` : "";
  }

  function make(spec) {
    const o = Object.assign({ kind: "ramp" }, spec);
    const el = document.createElement("div");
    render(el, o);
    let shown = null;                    // what the marker is showing now
    const api = {
      el, spec: o,
      setMarker(v) {
        if (o.kind === "classes") {
          const id = v == null ? null : String(v);
          if (id === shown) return;
          shown = id;
          for (const c of el.querySelectorAll(".lgc")) c.classList.toggle("on", id != null && c.dataset.c === id);
          el.dataset.mark = id == null ? "" : id;
          return;
        }
        const p = posOf(o, v), key = p == null ? null : (100 * p).toFixed(1);
        if (key === shown) return;
        shown = key;
        const mk = el.querySelector(".lgmk");
        if (!mk) return;
        if (key == null) { mk.hidden = true; el.dataset.mark = ""; return; }
        mk.style[o.vertical ? "bottom" : "left"] = key + "%";
        mk.hidden = false;
        el.dataset.mark = String(v);
      },
      update(n) { Object.assign(o, n); shown = null; render(el, o); return api; },
      remove() { live.delete(api); el.remove(); }
    };
    if (o.reader || o.read) live.add(api);
    return api;
  }

  /* the pointer moved to (x, y): each legend on screen asks its own reader */
  function track(view, x, y) {
    if (!live.size || !SBMM.readout) return;
    for (const l of live) {
      if (!l.el.isConnected) { if (live.size > 40) live.delete(l); continue; }
      if (!l.el.offsetParent) continue;                       // folded, or in a hidden pane
      const o = l.spec;
      if (o.read) { let v = null; try { v = o.read(x, y, { view }); } catch (e) { v = null; } l.setMarker(v); continue; }
      const a = SBMM.readout.read(o.reader, x, y, { view });
      l.setMarker(a ? (o.kind === "classes" ? a.cls : a.v) : null);
    }
  }
  function clear() { for (const l of live) l.setMarker(null); }

  return { make, track, clear, rowHtml, posOf, gradient, count: () => live.size,
           rows: () => [...byRow.keys()] };
})();
