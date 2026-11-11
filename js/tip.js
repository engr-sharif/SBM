/* =====================================================================
   js/tip.js — the ONE chip at the pointer (v58, docs/V56_REVIEW_PLAN.md step 3)

   Before this there were four: #pickTip (the 2D pick engine), #pick3dTip (the
   3D pick registry), #temTip (the TEM probe) and #waterTip (the overtopping
   analysis, after a dwell). Four elements in three containers with three
   placement rules, and two of them could be up at once.

   There is one element now, `#tip`, fixed on <body>, and three kinds of thing
   that may want it — in this order:

     feature   something with a name is under the pointer (js/pick2d.js, and
               js/pick3d.js for an object)
     surface   a 3D surface that reads differently at every point of itself
               (the TEM sheets, sections, walls: js/temprobe.js)
     readout   nothing with a name, but a layer that is on can be read here
               (js/readout.js: slope, the accumulation raster, the TEM slice…)

   Each source CLAIMS the chip when it has something to say and RELEASES it
   when it has not; the chip shows the highest claim. So nobody has to know
   who else is talking, and the order two rAF callbacks run in cannot matter.

   One addition to "highest wins": inside a POLYGON (a decision unit, a lot, a
   catchment) the raster under the pointer is still what the engineer is
   looking at, so a feature claim marked `soft` carries the readout's one line
   under its own.

   A move that changes nothing writes two style properties and no HTML; the
   chip never asks for a frame.
   ===================================================================== */
window.SBMM = window.SBMM || {};
SBMM.tip = (function () {
  const ORDER = ["feature", "surface", "readout"];
  const claims = { feature: null, surface: null, readout: null };
  let el = null, shownKey = "", shownSrc = "", px = 0, py = 0;

  function ensure() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "tip";
    el.setAttribute("role", "status");
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* The chip's own grammar, for a source that has facts rather than markup:
       lead    bold — a feature's name, a reading's value
       kind    dim, after it — what the thing is, what the value is of
       lines   further lines, in order
       dim     a last, quieter line
       graphic markup placed to the left (a mini log, a core)                */
  function html(o) {
    const one = `<div class="tp1"><b>${esc(o.lead)}</b>${o.kind ? `<span class="pkkind">${esc(o.kind)}</span>` : ""}</div>`;
    const more = (o.lines || []).filter(Boolean).map(l => `<div class="tp2">${esc(l)}</div>`).join("");
    return (o.graphic || "") + `<div class="tpt">${one}${more}${o.dim ? `<div class="tp3">${esc(o.dim)}</div>` : ""}</div>`;
  }

  /* o: { x, y (client px), html, key, view: "2d" | "3d",
          info (does not act on a click: drawn dashed), soft (a polygon's
          interior: the readout's line rides along), line (a readout's one
          line, for that) } */
  function claim(src, o) {
    if (!(src in claims) || !o || !o.html) { release(src); return; }
    claims[src] = o;
    if (o.x != null) { px = o.x; py = o.y; }
    paint();
  }
  function release(src) {
    if (!claims[src]) return;
    claims[src] = null;
    paint();
  }
  function releaseAll() {
    let any = false;
    for (const s of ORDER) if (claims[s]) { claims[s] = null; any = true; }
    if (any) paint();
  }
  /* a source that only moved: no claim changes, the chip follows */
  function moveTo(x, y) { px = x; py = y; if (el && !el.hidden) place(); }

  function paint() {
    const src = ORDER.find(s => claims[s]);
    if (!src) {
      if (el && !el.hidden) el.hidden = true;
      shownKey = ""; shownSrc = "";
      return;
    }
    const c = claims[src], r = claims.readout;
    /* .trow is the graphic beside the text; a second row may sit under it */
    let body = `<div class="trow">${c.html}</div>`, key = src + "|" + c.key;
    if (src === "feature" && c.soft && r && r.line) {
      body += `<div class="talso">${r.line}</div>`;
      key += "|+" + r.key;
    }
    ensure();
    if (key !== shownKey) {
      el.innerHTML = body;
      el.classList.toggle("info", !!c.info);
      el.dataset.src = src;
      el.dataset.view = c.view || "";
      shownKey = key; shownSrc = src;
    }
    if (el.hidden) el.hidden = false;
    place();
  }
  /* below-right of the pointer; flips where it would leave the window */
  function place() {
    const w = el.offsetWidth, h = el.offsetHeight, W = window.innerWidth, H = window.innerHeight;
    let x = px + 16, y = py + 16;
    if (x + w > W - 6) x = px - w - 14;
    if (y + h > H - 6) y = py - h - 12;
    el.style.transform = `translate(${Math.round(Math.max(4, x))}px,${Math.round(Math.max(4, y))}px)`;
  }

  /* for the harnesses, and for a source that asks "am I the one showing" */
  function state() {
    const on = !!(el && !el.hidden);
    return {
      shown: on, src: on ? shownSrc : "", view: on ? el.dataset.view : "", key: on ? shownKey : "",
      text: on ? el.textContent : "", html: on ? el.innerHTML : "",
      claims: ORDER.filter(s => claims[s])
    };
  }
  const showing = src => !!(el && !el.hidden && shownSrc === src);

  return { claim, release, releaseAll, moveTo, html, state, showing, esc };
})();
