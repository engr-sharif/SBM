/* SBMM Site Explorer — ONE layer state, and the event bus it publishes on (§4).

   Before v9 "is this layer on?" had three answers: a Leaflet layer's presence on
   the map, a checkbox in the Layers tab, and a *second* checkbox in the 3D
   toolbar that only the 3D view read. Turning the design on in 2D and finding it
   off in 3D was not a bug in any one module; it was the architecture.

   So there is now exactly one answer:

       SBMM.layerState[groupId][layerId] = { on, opacity }

   and everything — the Leaflet map, the 3D viewer, the sheet windows, the
   exports and the report figures — reads it and subscribes to changes through
   SBMM.events. The 3D toolbar checkboxes are gone (§3); visibility comes from
   the Layers tree and nowhere else.

   Registration. A layer is *defined* by whichever module owns its geometry,
   with an `apply(state, layer)` callback that does the actual showing and
   hiding. `SBMM.addLayerRow` (js/map.js) defines one automatically for every row
   it builds, so most modules need no change at all: they keep calling
   addLayerRow and get a row that is a view onto this state rather than the state
   itself.

   Events. `SBMM.events.emit('layers', {group, layer, state})` fires on every
   change, with the group and layer that changed. Subscribers MUST use that to
   decide whether they care — a toggle in `base` must not make the 3D view
   rebuild its design overlays. js/viewer3d.js keys off (group, layer) for
   exactly this reason.

   Persistence. localStorage for per-user convenience (wrapped, because file://
   and private windows both throw), and the session file for the real record. */
"use strict";

/* ---------------------------------------------------------------------- */
/* the event bus                                                           */
/* ---------------------------------------------------------------------- */
SBMM.events = (function () {
  const subs = new Map();          // name -> Set(fn)
  function on(name, fn) {
    if (!subs.has(name)) subs.set(name, new Set());
    subs.get(name).add(fn);
    return () => off(name, fn);
  }
  function off(name, fn) {
    const s = subs.get(name);
    if (s) s.delete(fn);
  }
  function emit(name, payload) {
    const s = subs.get(name);
    if (!s) return;
    /* copy: a subscriber is allowed to unsubscribe itself from inside its own
       handler (the sheet windows do exactly that when they close) */
    for (const fn of [...s]) {
      try { fn(payload); } catch (e) { console.error("event " + name, e); }
    }
  }
  return { on, off, emit, _subs: subs };
})();

/* ---------------------------------------------------------------------- */
/* the layer state                                                         */
/* ---------------------------------------------------------------------- */
SBMM.layerState = (function () {

  const STORE = "sbmm_layerstate_v9";

  /* groupId -> { id, label, order, layers: Map(layerId -> rec) }
     rec = { id, label, on, opacity, swatch, apply, group, meta } */
  const groups = new Map();
  let restoring = null;            // persisted state waiting to be applied
  let quiet = 0;                   // >0 while a bulk change is in flight

  /* the §4 groups, in the order they appear in the tree */
  const GROUP_ORDER = [
    ["base",      "Base"],
    ["framework", "Site framework"],
    ["design",    "Residential design (EA 2025)"],
    ["invest",    "Investigations"],
    ["cultural",  "Cultural resources — CONFIDENTIAL"],
    ["mywork",    "My work"]
  ];

  function defineGroup(id, label, order) {
    if (!groups.has(id))
      groups.set(id, { id, label: label || id, order: order == null ? 99 : order, layers: new Map() });
    const g = groups.get(id);
    if (label) g.label = label;
    return g;
  }
  GROUP_ORDER.forEach(([id, label], i) => defineGroup(id, label, i));

  function loadPersisted() {
    if (restoring !== null) return restoring;
    let o = null;
    try { o = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { o = null; }
    restoring = (o && typeof o === "object") ? o : {};
    return restoring;
  }
  function persist() {
    if (quiet) return;
    try { localStorage.setItem(STORE, JSON.stringify(serialize())); } catch (e) { /* file:// */ }
  }

  /* Define a layer. `on` / `opacity` are the DEFAULTS; a persisted user choice
     for the same (group, layer) wins over them, which is what makes "the layers
     I left on are still on tomorrow" work without any module knowing about it. */
  function define(groupId, layerId, opts) {
    opts = opts || {};
    const g = defineGroup(groupId);
    const prev = g.layers.get(layerId);
    const saved = loadPersisted();
    const sg = saved[groupId] || {};
    const sl = sg[layerId];
    const rec = prev || {
      group: groupId, id: layerId,
      on: !!opts.on, opacity: opts.opacity == null ? 1 : opts.opacity
    };
    rec.label = opts.label != null ? opts.label : (rec.label || layerId);
    rec.swatch = opts.swatch != null ? opts.swatch : rec.swatch;
    rec.meta = opts.meta || rec.meta || null;
    rec.apply = opts.apply || rec.apply || null;
    if (!prev) {
      if (opts.persist !== false && sl && typeof sl === "object") {
        if (typeof sl.on === "boolean") rec.on = sl.on;
        if (typeof sl.opacity === "number") rec.opacity = sl.opacity;
      }
      rec.persist = opts.persist !== false;
      g.layers.set(layerId, rec);
    }
    return rec;
  }

  function rec(groupId, layerId) {
    const g = groups.get(groupId);
    return g ? g.layers.get(layerId) || null : null;
  }
  function get(groupId, layerId) {
    const r = rec(groupId, layerId);
    return r ? { on: r.on, opacity: r.opacity } : null;
  }
  /* The question every consumer actually asks. Unknown layers read as OFF,
     except that a group nobody defined reads as ON — so a module asking about a
     layer that this build does not ship (no CHM, no cultural payload) is not
     silently switched off by the absence. */
  function isOn(groupId, layerId) {
    const r = rec(groupId, layerId);
    if (r) return !!r.on;
    return !groups.has(groupId);
  }
  function opacity(groupId, layerId) {
    const r = rec(groupId, layerId);
    return r ? r.opacity : 1;
  }

  /* The single mutation point. `patch` is {on?, opacity?}. */
  function set(groupId, layerId, patch, opts) {
    const r = rec(groupId, layerId);
    if (!r) return null;
    opts = opts || {};
    let changed = false;
    if (patch && typeof patch.on === "boolean" && patch.on !== r.on) { r.on = patch.on; changed = true; }
    if (patch && typeof patch.opacity === "number" && patch.opacity !== r.opacity) { r.opacity = patch.opacity; changed = true; }
    if (!changed && !opts.force) return r;
    if (r.apply) {
      try { r.apply({ on: r.on, opacity: r.opacity }, r); }
      catch (e) { console.error("layer apply " + groupId + "/" + layerId, e); }
    }
    persist();
    if (!opts.silent) SBMM.events.emit("layers", { group: groupId, layer: layerId, state: { on: r.on, opacity: r.opacity } });
    return r;
  }
  function toggle(groupId, layerId) { const r = rec(groupId, layerId); return r ? set(groupId, layerId, { on: !r.on }) : null; }

  /* Apply many changes as ONE change (v16). A layer preset, a solo and its
     restore all move dozens of rows at once, and firing a `layers` event per
     row would make js/viewer3d.js queue dozens of overlay rebuilds for a single
     gesture. So the individual sets run silent and one event is emitted per
     group that actually moved — the same `{group, layer: null}` shape a master
     checkbox already emits, which every subscriber has always had to handle.
     `list` is [{group, layer, on?, opacity?}, …]. */
  function batch(list) {
    if (!Array.isArray(list) || !list.length) return 0;
    const touched = new Set();
    let n = 0;
    quiet++;
    for (const it of list) {
      const r = rec(it.group, it.layer);
      if (!r) continue;
      const was = r.on + "|" + r.opacity;
      set(it.group, it.layer, { on: it.on, opacity: it.opacity }, { silent: true });
      if (was !== r.on + "|" + r.opacity) { touched.add(it.group); n++; }
    }
    quiet--;
    persist();
    for (const g of touched)
      SBMM.events.emit("layers", { group: g, layer: null, state: { on: groupState(g) !== "none" } });
    return n;
  }

  /* master checkbox on a group header */
  function setGroup(groupId, on) {
    const g = groups.get(groupId);
    if (!g) return;
    quiet++;
    for (const id of g.layers.keys()) set(groupId, id, { on: !!on }, { silent: true });
    quiet--;
    persist();
    SBMM.events.emit("layers", { group: groupId, layer: null, state: { on: !!on } });
  }
  /* tri-state for the header checkbox: 'all' | 'none' | 'some' | 'empty' */
  function groupState(groupId) {
    const g = groups.get(groupId);
    if (!g || !g.layers.size) return "empty";
    let on = 0, n = 0;
    for (const r of g.layers.values()) { n++; if (r.on) on++; }
    return on === 0 ? "none" : on === n ? "all" : "some";
  }
  function count(groupId) { const g = groups.get(groupId); return g ? g.layers.size : 0; }
  function countOn(groupId) {
    const g = groups.get(groupId);
    if (!g) return 0;
    let n = 0; for (const r of g.layers.values()) if (r.on) n++;
    return n;
  }

  function list(groupId) {
    const g = groups.get(groupId);
    return g ? [...g.layers.values()] : [];
  }
  function groupList() {
    return [...groups.values()].sort((a, b) => a.order - b.order);
  }

  /* ------------------------------------------------------------------ */
  /* persistence                                                         */
  /* ------------------------------------------------------------------ */
  /* One additive extension point for the session file and the localStorage
     record: js/layertree.js registers `{save, load}` here so the tree's row
     order and the user's presets travel with the layer state instead of
     needing their own key in js/state.js. It lands under `_tree`, which is not
     a group id — an older build reading a newer session walks it in restore(),
     finds no layer by that name and skips it, which is exactly the tolerance
     restore() was written with. */
  let extra = null;
  function setExtra(o) { extra = o || null; }

  function serialize() {
    const o = {};
    for (const g of groups.values()) {
      const gg = {};
      for (const r of g.layers.values()) {
        if (r.persist === false) continue;
        gg[r.id] = { on: r.on, opacity: r.opacity };
      }
      if (Object.keys(gg).length) o[g.id] = gg;
    }
    if (extra && extra.save) {
      try { const t = extra.save(); if (t) o._tree = t; } catch (e) { console.error("layerState extra save", e); }
    }
    return o;
  }
  /* Restore is tolerant by design: a session written by a build with layers this
     one does not have simply skips them, and layers this build has that the
     session does not mention keep their current value. */
  function restore(o) {
    if (!o || typeof o !== "object") return 0;
    let n = 0;
    quiet++;
    for (const gid in o) {
      if (gid === "_tree") continue;
      for (const lid in o[gid]) {
        const s = o[gid][lid];
        if (!s || typeof s !== "object") continue;
        if (rec(gid, lid)) { set(gid, lid, { on: s.on, opacity: s.opacity }, { silent: true }); n++; }
      }
    }
    quiet--;
    persist();
    if (o._tree && extra && extra.load) {
      try { extra.load(o._tree); } catch (e) { console.error("layerState extra load", e); }
    }
    SBMM.events.emit("layers", { group: null, layer: null, state: null });
    return n;
  }
  function resetDefaults() {
    try { localStorage.removeItem(STORE); } catch (e) {}
    restoring = {};
  }

  return {
    defineGroup, define, get, set, isOn, opacity, toggle, batch, setExtra, setGroup, groupState,
    count, countOn, list, groupList, serialize, restore, resetDefaults, rec,
    GROUP_ORDER,
    /* debug / test hook: the whole thing as plain data */
    dump: () => serialize()
  };
})();
