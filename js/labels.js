/* SBMM Site Explorer — the 2D label engine (v15 §2.2).

   Every permanent label on this map used to be its own Leaflet marker, drawn
   wherever its geometry happened to put it, with nothing in the app aware that
   another label was already there. Two consequences, and the user hit both:

     * **The same words several times.** The overtopping analysis makes several
       `flow` features over the same ponds — the first-discharge route, the rim
       route, whatever raindrop the user dropped — and each one drew its own
       permanent pond label at the same centroid. Three copies of
       "1,415.7 ft · 0.7 ft deep" on one pixel reads as a smear.
     * **Labels on top of labels.** Catchment acreages, excavation depths, rim
       lows and pond levels are all "the number at a centroid", and at any zoom
       where several of them are on screen they overlap.

   So: one registry, two rules.

     * **Dedupe by `key`.** Two labels with the same key are the same fact, so
       only the highest-priority one is shown. `key` is the caller's, and it is
       the ROUNDED position plus the value — a pond at the same cell at the same
       level is one pond however many runs crossed it.
     * **Greedy placement by `priority`.** After every move, every zoom and any
       add or remove (debounced to one animation frame), the kept labels are
       sorted by priority and taken in order: a label is shown if its screen box
       does not touch a box already kept (2 px of padding), and hidden if it
       does. Priorities are the spec's: spill / first-discharge markers 100,
       pond labels 60, drainage catchment labels 50, design depth call-outs 45,
       flow end labels 40, storm "in pipe" labels 30.

   Three things it deliberately does NOT do:

     * **It never removes a label.** Hiding is `visibility:hidden`, so the
       element keeps its box and the next pass can measure it without a reflow
       storm — and a label that stops colliding comes back on its own.
     * **It does not replace zoom gating.** A caller that only wants its label
       above a zoom hands over a `gate()`; a label whose gate is false is hidden
       and does NOT occupy space. The excavation depth labels keep their CSS
       gate (`#map.zoomfar .excdepth{display:none}`) and are measured as absent
       because `display:none` has no box at all.
     * **It is not for tooltips.** A tooltip appears under the pointer, one at a
       time, by definition — hover is not a label.

   Field mode uses exactly the same engine; a phone screen needs it more. */
"use strict";

SBMM.labels = (function () {

  const PAD = 2;                      // px of clearance between two kept labels
  const PRI = { spill: 100, pond: 60, drainage: 50, depth: 45, flowend: 40, pipe: 30 };

  const reg = new Map();              // id -> record
  let seq = 0, raf = 0, wired = false;
  let last = { registered: 0, visible: 0, dup: 0, collided: 0, gated: 0, offscreen: 0 };

  /* ------------------------------------------------------------------ */
  /* the registry                                                        */
  /* ------------------------------------------------------------------ */
  /* `el` may be given directly, or as a Leaflet `marker` whose element only
     exists once it is on the map — which is the normal case here, because every
     one of these labels is a zero-size divIcon. */
  function add(spec) {
    if (!spec || (!spec.el && !spec.marker)) return null;
    const id = spec.id || ("lb" + (++seq));
    reg.set(id, {
      id, key: spec.key || null,
      priority: spec.priority == null ? 50 : spec.priority,
      latlng: spec.latlng || null,
      el: spec.el || null, marker: spec.marker || null,
      owner: spec.owner || null, gate: spec.gate || null,
      /* vis starts FALSE: a label is not shown until a placement pass has
         actually kept it, and `visible()` must never report one that has never
         been placed (its marker may not even be on the map yet) */
      seq: ++seq, vis: false, why: "unplaced"
    });
    schedule();
    return id;
  }
  function remove(id) { if (reg.delete(id)) schedule(); }
  function removeOwner(owner) {
    let n = 0;
    for (const [id, r] of reg) if (r.owner === owner) { reg.delete(id); n++; }
    if (n) schedule();
    return n;
  }
  function clear() { reg.clear(); schedule(); }

  /* ------------------------------------------------------------------ */
  /* placement                                                           */
  /* ------------------------------------------------------------------ */
  function elOf(r) {
    if (r.el) return r.el;
    if (r.marker && r.marker.getElement) { try { return r.marker.getElement(); } catch (e) { return null; } }
    return null;
  }
  /* A zero-size divIcon has no box of its own; its ink is in the children, so
     the union of their rectangles is the box that matters. */
  function boxOf(el) {
    let b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, got = false;
      for (const c of el.children) {
        const q = c.getBoundingClientRect();
        if (q.width < 0.5 || q.height < 0.5) continue;
        got = true;
        if (q.left < x0) x0 = q.left; if (q.top < y0) y0 = q.top;
        if (q.right > x1) x1 = q.right; if (q.bottom > y1) y1 = q.bottom;
      }
      if (!got) return null;
      b = { left: x0, top: y0, right: x1, bottom: y1 };
    }
    if (!(b.right > b.left) || !(b.bottom > b.top)) return null;
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }
  const hit = (a, b) => !(a.right + PAD < b.left || b.right + PAD < a.left
                       || a.bottom + PAD < b.top || b.bottom + PAD < a.top);
  function show(el) { if (el.style.visibility === "hidden") el.style.visibility = ""; }
  function hide(el) { if (el.style.visibility !== "hidden") el.style.visibility = "hidden"; }

  function place() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const map = SBMM.map;
    if (!map) return last;
    const cont = map.getContainer();
    if (!cont) return last;
    const cr = cont.getBoundingClientRect();
    const stat = { registered: reg.size, visible: 0, dup: 0, collided: 0, gated: 0,
                   nobox: 0, offscreen: 0 };

    const live = [];
    for (const [id, r] of [...reg]) {
      const el = elOf(r);
      /* No element yet, or its layer group is off the map: the record stays (the
         layer may come back) but it is NOT visible, and saying otherwise is how
         `visible()` came to report 611 labels while one was on screen. */
      if (!el) { r.vis = false; r.why = "nolayer"; continue; }
      /* a label whose marker was thrown away with its layer group is gone */
      if (!el.isConnected) { reg.delete(id); continue; }
      if (r.gate) {
        let ok = false;
        try { ok = !!r.gate(); } catch (e) { ok = false; }
        if (!ok) { hide(el); r.vis = false; r.why = "gate"; stat.gated++; continue; }
      }
      const b = boxOf(el);
      if (!b) { r.vis = false; r.why = "nobox"; stat.nobox++; continue; }
      if (b.right < cr.left - 60 || b.left > cr.right + 60
          || b.bottom < cr.top - 60 || b.top > cr.bottom + 60) {
        hide(el); r.vis = false; r.why = "offscreen"; stat.offscreen++; continue;
      }
      r._el = el; r._box = b;
      live.push(r);
    }

    /* dedupe: one label per key, the highest priority wins (ties: the oldest,
       so a rebuild does not make the picture jump) */
    const best = new Map();
    for (const r of live) {
      if (!r.key) continue;
      const p = best.get(r.key);
      if (!p || r.priority > p.priority || (r.priority === p.priority && r.seq < p.seq)) best.set(r.key, r);
    }
    const cand = [];
    for (const r of live) {
      if (r.key && best.get(r.key) !== r) { hide(r._el); r.vis = false; r.why = "dup"; stat.dup++; continue; }
      cand.push(r);
    }
    cand.sort((a, b) => b.priority - a.priority || a._box.top - b._box.top || a.seq - b.seq);

    const kept = [];
    for (const r of cand) {
      let clash = false;
      for (let i = 0; i < kept.length; i++) if (hit(r._box, kept[i])) { clash = true; break; }
      if (clash) { hide(r._el); r.vis = false; r.why = "collide"; stat.collided++; }
      else { show(r._el); r.vis = true; r.why = null; kept.push(r._box); stat.visible++; }
    }
    for (const r of live) { r._el = null; r._box = null; }
    last = stat;
    return stat;
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; place(); });
  }

  /* ------------------------------------------------------------------ */
  function wire() {
    if (wired || !SBMM.map) return;
    wired = true;
    SBMM.map.on("moveend zoomend resize", schedule);
    /* a layer coming or going changes what is on screen without moving it */
    SBMM.map.on("layeradd layerremove", schedule);
    if (SBMM.events) SBMM.events.on("layers", schedule);
  }

  /* what the harness reads: how many are registered, how many are actually
     visible, and why each hidden one is hidden */
  function stats() { return Object.assign({}, last, { registered: reg.size }); }
  function visible() {
    const out = [];
    for (const r of reg.values()) if (r.vis) out.push({ id: r.id, key: r.key, priority: r.priority, owner: r.owner });
    return out;
  }
  function boxes() {
    /* the CURRENT screen boxes of the visible labels — the e2e's overlap check */
    const out = [];
    for (const r of reg.values()) {
      if (!r.vis) continue;
      const el = elOf(r);
      if (!el || !el.isConnected) continue;
      const b = boxOf(el);
      if (b) out.push({ id: r.id, owner: r.owner, key: r.key, priority: r.priority,
                        left: b.left, top: b.top, right: b.right, bottom: b.bottom });
    }
    return out;
  }
  function count(owner) {
    let n = 0;
    for (const r of reg.values()) if (r.vis && (!owner || r.owner === owner)) n++;
    return n;
  }

  return { add, remove, removeOwner, clear, place, refresh: schedule, wire,
           stats, visible, boxes, count, PRI, PAD };
})();
