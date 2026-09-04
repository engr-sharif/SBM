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
  /* Put a removed feature back — the SAME object with the SAME id, so a
     selection, a provenance record, a results card and anything holding a
     reference all survive a delete/undo round trip (that identity is what makes
     redo of a delete the same feature rather than a look-alike).
     `remove()` DETACHES and never destroys: the Leaflet layer, the extra layers
     (a cut/fill overlay, a design raster, a section band) and the card element
     are all still on the object, so putting them back is the whole job. Only a
     feature whose layer was never built or was thrown away needs a new one, and
     that comes from the type's own builder through `SBMM.tools.relayer` —
     the same builder `rebuildFeature` uses, with NOTHING recomputed. */
  readd(f) {
    if (!f) return null;
    if (this.features.indexOf(f) >= 0) return f;
    if (f.visible == null) f.visible = true;
    this.features.push(f);
    if (!f.layer && SBMM.tools && SBMM.tools.relayer) SBMM.tools.relayer(f, true);
    if (f.visible !== false) {
      if (f.layer) f.layer.addTo(SBMM.map);
      if (f.extraLayers) f.extraLayers.forEach(l => l.addTo(SBMM.map));
    }
    if (f.card && !f.card.isConnected) {
      const body = $("resBody");
      if (body) {
        const ph = body.querySelector(".placeholder"); if (ph) ph.remove();
        body.prepend(f.card);
      }
    }
    this.emit(); this.autosave();
    return f;
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

/* Undo / redo — two stacks of { desc, undo(), redo() } entries.

   BOTH closures are required. An action that can be undone but not redone is a
   bug, not a design choice, so a push with a missing or non-function `redoFn`
   reports itself in the console and is dropped rather than quietly leaving a
   dead entry on the stack. A push also CLEARS the redo stack: a new action
   after an undo forks history and the abandoned branch is gone, which is what
   every editor does. Depth 100 each way. */
SBMM.undo = {
  stack: [],
  redoStack: [],
  DEPTH: 100,
  subs: [],

  /* fired after every push / pop / redo / clear — and once on subscribe, so a
     button wired at boot starts in the right state without a second call */
  onChange(fn) {
    if (typeof fn !== "function") return () => {};
    this.subs.push(fn);
    try { fn(); } catch (e) { console.error(e); }
    return () => { const i = this.subs.indexOf(fn); if (i >= 0) this.subs.splice(i, 1); };
  },
  changed() { this.subs.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); },

  push(desc, undoFn, redoFn) {
    if (typeof undoFn !== "function" || typeof redoFn !== "function") {
      console.error('SBMM.undo.push("' + desc + '") needs BOTH an undo and a redo closure — entry dropped');
      return null;
    }
    const e = { desc, undo: undoFn, redo: redoFn };
    this.stack.push(e);
    if (this.stack.length > this.DEPTH) this.stack.shift();
    this.redoStack.length = 0;
    this.changed();
    return e;
  },
  /* Forget the last n entries WITHOUT running them. The sketch engine uses it
     when a sketch ends: the per-vertex entries belong to a sketch that no
     longer exists, and one "draw Line 3" entry is what the user means by "undo
     that". Nothing is undone here, so the redo stack is not touched. */
  drop(n, desc) {
    let k = 0;
    while (k < n && this.stack.length
           && (desc == null || this.stack[this.stack.length - 1].desc === desc)) {
      this.stack.pop(); k++;
    }
    if (k) this.changed();
    return k;
  },
  canUndo() { return this.stack.length > 0; },
  canRedo() { return this.redoStack.length > 0; },
  labels() {
    return {
      undo: this.stack.length ? this.stack[this.stack.length - 1].desc : null,
      redo: this.redoStack.length ? this.redoStack[this.redoStack.length - 1].desc : null
    };
  },
  pop() {
    const e = this.stack.pop();
    if (!e) { toast("nothing to undo"); this.changed(); return false; }
    try { e.undo(); } catch (err) {
      console.error(err); toast("undo failed: " + e.desc); this.changed(); return false;
    }
    this.redoStack.push(e);
    if (this.redoStack.length > this.DEPTH) this.redoStack.shift();
    toast("undid: " + e.desc);
    this.changed();
    return true;
  },
  redo() {
    const e = this.redoStack.pop();
    if (!e) { toast("nothing to redo"); this.changed(); return false; }
    try { e.redo(); } catch (err) {
      console.error(err); toast("redo failed: " + e.desc); this.changed(); return false;
    }
    this.stack.push(e);
    if (this.stack.length > this.DEPTH) this.stack.shift();
    toast("redid: " + e.desc);
    this.changed();
    return true;
  },
  clear() { this.stack.length = 0; this.redoStack.length = 0; this.changed(); }
};
