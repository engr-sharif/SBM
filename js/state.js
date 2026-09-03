/* SBMM Site Explorer — feature store, selection, undo, session persistence.

   A feature: { id, name, type: spot|line|area|volume|profile,
                pts:[[x,y],...], props:{...},
                group:"" | "Folder" | "Folder/Sub",   organisational path
                style:{color,weight} | null,          per-feature override
                visible, locked,
                layer(Leaflet), card(HTMLElement|null) }

   Session files stay backward compatible in both directions: `group`, `style`,
   `visible` and `locked` are optional on read (old v2 sessions load unchanged) and
   only written when they carry information. */
"use strict";

SBMM.store = {
  features: [],
  groups: [],            // explicit folder paths, so an empty folder can exist
  seq: 0,
  selected: null,
  listeners: [],
  selListeners: [],

  /* While a batch is open every emit and autosave is deferred to one at the
     end. Adding EA's four reference surfaces at boot otherwise fired eight
     emits, and an emit fans out to the feature tree, the two surface lists, the
     My-work mask and the 3D overlays — O(listeners x features) work, eight
     times, before the user has done anything. */
  _batch: 0,
  _dirty: false,
  batch(fn) {
    this._batch++;
    try { return fn(); }
    finally {
      this._batch--;
      if (!this._batch && this._dirty) { this._dirty = false; this.emit(); this.autosave(); }
    }
  },

  add(f) {
    f.id = "f" + (++this.seq);
    if (f.visible == null) f.visible = true;
    if (f.group == null) f.group = "";
    this.features.push(f);
    this.emit(); this.autosave();
    return f;
  },
  remove(f) {
    /* EA's reference design surfaces (§5) are store features so that everything
       downstream works with them unchanged, but they are read-only project
       data: they ship with the app and are re-created on boot, so deleting one
       would only make it come back looking like a bug. */
    if (f && f.props && f.props.ref) { toast(esc(f.name) + " is EA reference data — it can't be deleted"); return; }
    const i = this.features.indexOf(f);
    if (i >= 0) this.features.splice(i, 1);
    if (f.layer) SBMM.map.removeLayer(f.layer);
    if (f.extraLayers) f.extraLayers.forEach(l => SBMM.map.removeLayer(l));
    if (f.card) f.card.remove();
    if (this.selected === f.id) this.select(null);
    SBMM.results.checkEmpty();
    this.emit(); this.autosave();
  },
  clear() {
    [...this.features].forEach(f => this.remove(f));
    this.select(null);
    this.emit(); this.autosave();
  },
  byId(id) { return this.features.find(f => f.id === id); },
  onChange(fn) { this.listeners.push(fn); return () => this.offChange(fn); },
  /* Every long-lived subscriber must be able to leave. Sheet windows come and
     go all session; without this their store listeners accumulated and each
     closed window went on repainting a canvas that no longer existed (made
     inert by hand, which worked and was not the same as unsubscribing). */
  offChange(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); },
  emit() {
    if (this._batch) { this._dirty = true; return; }
    this.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  },

  /* ---- selection (single; phase 2 can widen this without changing callers) ---- */
  select(id) {
    const next = id || null;
    if (next === this.selected) return;
    const prev = this.selected;
    this.selected = next;
    this.selListeners.forEach(fn => { try { fn(next, prev); } catch (e) { console.error(e); } });
  },
  onSelect(fn) { this.selListeners.push(fn); },
  offSelect(fn) { const i = this.selListeners.indexOf(fn); if (i >= 0) this.selListeners.splice(i, 1); },
  selectedFeature() { return this.selected ? this.byId(this.selected) : null; },

  /* ---- visibility / lock ---- */
  setVisible(f, on) {
    f.visible = !!on;
    if (f.layer) { if (on) f.layer.addTo(SBMM.map); else SBMM.map.removeLayer(f.layer); }
    if (f.extraLayers) f.extraLayers.forEach(l => { if (on) l.addTo(SBMM.map); else SBMM.map.removeLayer(l); });
    if (f.card) f.card.style.display = on ? "" : "none";
    this.emit(); this.autosave();
  },
  setLocked(f, on) { f.locked = !!on; this.emit(); this.autosave(); },

  /* ---- groups ---- */
  allGroups() {
    const s = new Set(this.groups);
    for (const f of this.features) if (f.group) s.add(f.group);
    /* every ancestor of a path is itself a folder */
    for (const g of [...s]) {
      const parts = g.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    return [...s].filter(Boolean).sort();
  },
  addGroup(path) {
    path = String(path || "").trim().replace(/^\/+|\/+$/g, "");
    if (!path) return null;
    if (!this.groups.includes(path)) this.groups.push(path);
    this.emit(); this.autosave();
    return path;
  },
  removeGroup(path) {
    this.groups = this.groups.filter(g => g !== path && !g.startsWith(path + "/"));
    for (const f of this.features)
      if (f.group === path || f.group.startsWith(path + "/")) f.group = "";
    this.emit(); this.autosave();
  },
  setGroup(f, path) {
    f.group = String(path || "").replace(/^\/+|\/+$/g, "");
    this.emit(); this.autosave();
  },

  /* ---- session serialization ---- */
  serialize() {
    return {
      /* v6 adds datasets; v5 added the "surface" (design surface) and "sections" feature types on top
         of v4's "dim"/"text". Every bump so far has been purely additive: restore()
         dispatches on each feature's own type, so a v2/v3/v4 file loads unchanged
         here, and a v5 file opened in an older build simply skips the types it does
         not know rather than failing. Design rasters and section samples are NOT
         serialised — they are derived, and regenerating them from the geometry and
         the parameters is both cheaper than storing them and guaranteed current. */
      app: "SBMM Site Explorer", version: 7, saved: new Date().toISOString(),
      crs: "EPSG:6418 (NAD83(2011) CA SP Zone 2, ftUS)",
      groups: this.allGroups(),
      /* v6 adds imported datasets (js/datasets.js). Additive like every bump
         before it: an older build ignores the key, and a v2-v5 file simply has
         no datasets to restore. Baked datasets are never written - they ship
         with the app, so storing them would only let a stale copy win. */
      datasets: SBMM.datasets ? SBMM.datasets.serializeUser() : [],
      /* v7 adds the layer state (docs/V9_SPEC.md §4). Additive like every bump
         before it: an older build ignores the key, and a v2-v6 file simply
         restores no layers and leaves the defaults alone. The cultural group is
         excluded at the source (js/layerstate.js `persist:false`), because §7
         wants an acknowledgement once per session and a restored checkbox would
         put protected geometry on the map before anyone was asked. */
      layers: SBMM.layerState ? SBMM.layerState.serialize() : {},
      /* EA's reference design surfaces are NOT serialised: they ship with the
         app and are re-created on boot, so a stale copy inside a session file
         must never win (the same rule the baked datasets follow). */
      features: this.features.filter(f => !(f.props && f.props.ref)).map(f => {
        const o = {
          name: f.name, type: f.type,
          pts: f.pts.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]),
          props: f.props || {}
        };
        if (f.group) o.group = f.group;
        if (f.style) o.style = f.style;
        if (f.visible === false) o.visible = false;
        if (f.locked) o.locked = true;
        return o;
      })
    };
  },
  restore(obj) {
    if (!obj || !Array.isArray(obj.features)) throw new Error("not a session file");
    if (Array.isArray(obj.groups)) for (const g of obj.groups) if (g && !this.groups.includes(g)) this.groups.push(g);
    for (const s of obj.features) {
      if (!Array.isArray(s.pts) || !s.pts.length) continue;
      SBMM.tools.rebuildFeature(s);
    }
    if (obj.datasets && SBMM.datasets) SBMM.datasets.restoreUser(obj.datasets);
    if (obj.layers && SBMM.layerState) SBMM.layerState.restore(obj.layers);
    this.emit();
  },
  autosave() {
    if (this._batch) { this._dirty = true; return; }
    try {
      localStorage.setItem("sbmm_session_auto", JSON.stringify(this.serialize()));
    } catch (e) { /* file:// or quota — fine, explicit save/load still works */ }
  },
  loadAutosave() {
    try {
      const s = localStorage.getItem("sbmm_session_auto");
      if (!s) return false;
      const obj = JSON.parse(s);
      if (!obj.features || !obj.features.length) return false;
      this.restore(obj);
      return obj.features.length;
    } catch (e) { return false; }
  }
};

/* Undo — stack of {desc, undo()} entries (drawing + edits push here) */
SBMM.undo = {
  stack: [],
  push(desc, fn) { this.stack.push({ desc, fn }); if (this.stack.length > 100) this.stack.shift(); },
  pop() {
    const e = this.stack.pop();
    if (!e) { toast("nothing to undo"); return; }
    try { e.fn(); toast("undid: " + e.desc); } catch (err) { console.error(err); }
  }
};
