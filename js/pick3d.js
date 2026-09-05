/* SBMM Site Explorer — 3D picking registry, hover, identify card and 3D editing.

   §8 of the v9 spec: "a layer that is on is on in 2D, 3D, the sheet viewer and
   exports" is only half true if clicking a well in 3D does nothing. This is the
   other half: one registry that anything drawn into the 3D scene can join, one
   raycast that resolves it, and — the part that matters — the SAME popup HTML
   the 2D map shows, because both views ask js/popups.js for it.

   The registry API is exactly as specified:

       SBMM.pick3d.register({ id, object3d, kind, priority,
                              hit(intersect) -> { title, html, featureId?, xyz } })
       SBMM.pick3d.unregister(id)

   `priority` breaks ties when two things are within a pixel of each other:
   points 3 > lines 2 > polygons 1 > terrain 0. A raycast against a Line and a
   Points cloud does not return them in a sensible order on its own — a boring's
   depth stick passes through the marker cap, and without the priority the stick
   wins every click on the cap, which is the wrong answer for the same record.

   Registration is driven from js/viewer3d.js: rebuildOverlays() tags each
   object it makes with `userData.pick`, and syncScene() below turns those tags
   into registry entries. Modules that build their own 3D objects (the CAD
   module is the case §8 names) can call register() directly at any time.

   Three performance rules, because hover runs on every mouse move:
     * no allocation in the hover path — the Vector2, the ray and the results
       array are all reused;
     * the terrain mesh (1.5 M vertices) is NEVER raycast on hover, only on a
       click that hit nothing else;
     * render-on-demand is preserved: hover asks for a render only when the
       highlighted object actually changed. */
"use strict";

SBMM.pick3d = (function () {

  /* id -> { id, object3d, kind, priority, hit } */
  const reg = new Map();
  let ctx = null;                  // the viewer3d handles
  let card = null, tipEl = null;
  let hovered = null;              // { id, index } of the entry under the cursor
  let cardAnchor = null;           // scene-space Vector3 the open card is pinned to
  let sceneIds = [];               // registry ids owned by the last syncScene()
  let seq = 0;

  /* reused every hover — see the "no allocation" rule above */
  let V2 = null, HITS = [], TMPV = null;

  /* ------------------------------------------------------------------ */
  /* registry                                                            */
  /* ------------------------------------------------------------------ */
  function register(spec) {
    if (!spec || !spec.object3d || typeof spec.hit !== "function") return null;
    const id = spec.id || ("p3_" + (++seq));
    reg.set(id, {
      id, object3d: spec.object3d, kind: spec.kind || "other",
      priority: spec.priority != null ? spec.priority : 1,
      hit: spec.hit
    });
    return id;
  }
  function unregister(id) { reg.delete(id); }
  function registered() { return [...reg.values()].map(e => ({ id: e.id, kind: e.kind, priority: e.priority })); }

  function attach(handles) {
    ctx = handles;
    if (!V2) { V2 = new THREE.Vector2(); TMPV = new THREE.Vector3(); }
    wireCanvas();
  }
  function attached() { return !!ctx; }

  /* ------------------------------------------------------------------ */
  /* scene sync — turn viewer3d's userData.pick tags into registry rows   */
  /* ------------------------------------------------------------------ */
  function syncScene() {
    if (!ctx) return;
    for (const id of sceneIds) reg.delete(id);
    sceneIds = [];
    /* v15 §2.3/§3.2: the label layer is a second root. Its chips are ordinary
       tagged objects — a rim-low chip answers a hover and a click the same way
       the geometry under it does. */
    const roots = [ctx.overlayGroup && ctx.overlayGroup(),
                   ctx.labelGroup && ctx.labelGroup()].filter(Boolean);
    if (!roots.length) return;
    for (const grp of roots) grp.traverse(o => {
      const t = o.userData && o.userData.pick;
      if (!t) return;
      const spec = specFor(o, t);
      if (!spec) return;
      const id = register(spec);
      if (id) sceneIds.push(id);
    });
    /* a rebuild throws away the object the card was pinned to */
    if (card && cardAnchor && !cardAnchor.parent) closeCard();
  }

  /* points 3 > lines 2 > polys 1 > terrain 0 */
  function priorityOf(o) {
    if (o.isPoints || o.isSprite) return 3;
    if (o.isLine || o.isLineSegments) return 2;
    return 1;
  }

  function specFor(o, t) {
    const P = priorityOf(o);
    switch (t.kind) {
      case "feature": return {
        object3d: o, kind: "feature", priority: P,
        hit() {
          const f = SBMM.store.byId(t.fid);
          if (!f) return null;
          return { title: f.name || f.type, html: SBMM.popups.forFeature(f),
                   featureId: f.id, xyz: [f.pts[0][0], f.pts[0][1]] };
        }
      };
      case "gis": return {
        object3d: o, kind: "gis", priority: P,
        hit() {
          return { title: (t.props && t.props.name) || "Design feature",
                   html: SBMM.popups.forGis(t.props || {}, t.geom) };
        }
      };
      case "cad": return {
        object3d: o, kind: "cad", priority: P,
        hit() {
          const f = cadByCoords(t.coords);
          if (!f) return null;
          return { title: f.layer, html: SBMM.popups.forCad(f) };
        }
      };
      case "dataset": return {
        object3d: o, kind: "dataset", priority: P,
        hit(ix) {
          const d = SBMM.datasets.byId(t.dsId);
          if (!d) return null;
          /* a Points cloud reports the vertex index; a LineSegments stick
             reports the segment index, and each stick is two vertices of the
             filtered "has a depth" subset */
          let i = ix && ix.index != null ? ix.index : 0;
          if (t.stick) i = t.idx[Math.floor(i / 2)];
          const p = d.points[i];
          if (!p) return null;
          return { title: p.id, html: SBMM.popups.forDataset(d, p), xyz: [p.x, p.y] };
        }
      };
      case "sample": return {
        object3d: o, kind: "sample", priority: P,
        hit(ix) {
          const p = SBMM.samples[ix && ix.index != null ? ix.index : 0];
          if (!p) return null;
          return { title: p.id, html: SBMM.popups.forSample(p), xyz: [p.x, p.y] };
        }
      };
      case "tree": return {
        object3d: o, kind: "tree", priority: P,
        hit(ix) {
          const d = SBMM.trees && SBMM.trees.data;
          const i = ix && ix.index != null ? ix.index : -1;
          if (!d || i < 0 || i >= d.n) return null;
          const t2 = { id: i + 1, x: d.x[i], y: d.y[i], h: d.h[i], r: d.radius[i] };
          return { title: "Tree " + t2.id, html: SBMM.popups.forTree(t2), xyz: [t2.x, t2.y] };
        }
      };
      case "cultural": return {
        object3d: o, kind: "cultural", priority: P,
        hit() {
          const D = window.SBMM_DATA && SBMM_DATA.cultural;
          const spec = D && (D.layers || []).find(l => l.key === t.feature.layer);
          return { title: t.feature.name,
                   html: SBMM.cultural.popup(t.feature, spec || { name: "Cultural resource" }) };
        }
      };
      /* v15 §3.1: a whole reference layer merged into one LineSegments (or one
         Points cloud). The hit's index maps back to the feature through the
         owner array the batch builder recorded, so one draw call still answers
         "what did I click" with the right popup. */
      case "gisBatch": return {
        object3d: o, kind: "gis", priority: P,
        hit(ix) {
          const own = o.userData.owner || [];
          const seg = ix && ix.index != null ? Math.floor(ix.index / 2) : 0;
          const it = t.items[own[seg] == null ? 0 : own[seg]];
          if (!it) return null;
          return { title: (it.props && it.props.name) || "Design feature",
                   html: SBMM.popups.forGis(it.props || {}, it.geom) };
        }
      };
      case "gisPts": return {
        object3d: o, kind: "gis", priority: P,
        hit(ix) {
          const it = t.items[ix && ix.index != null ? ix.index : 0];
          if (!it) return null;
          return { title: (it.props && it.props.name) || "Design feature",
                   html: SBMM.popups.forGis(it.props || {}, it.geom), xyz: [it.x, it.y] };
        }
      };
      /* v15: a 3D label chip. Whatever built it said what it is about, so the
         card is that text — no lookup, and nothing to keep in step. */
      case "label": return {
        object3d: o, kind: "label", priority: 3,
        hit() { return { title: t.title || "Label", html: t.html || ("<b>" + esc(t.title || "") + "</b>") }; }
      };
      case "culturalPt": return {
        object3d: o, kind: "cultural", priority: P,
        hit(ix) {
          const rec = t.pts[ix && ix.index != null ? ix.index : 0];
          if (!rec) return null;
          const D = window.SBMM_DATA && SBMM_DATA.cultural;
          const spec = D && (D.layers || []).find(l => l.key === rec.feature.layer);
          return { title: rec.feature.name,
                   html: SBMM.cultural.popup(rec.feature, spec || { name: "Cultural resource" }),
                   xyz: [rec.x, rec.y] };
        }
      };
      default: return null;
    }
  }

  /* CadNative hands its own coords array to viewer3d by reference, so identity
     is a valid key. The index is built once and thrown away whenever the module
     materialises more features (its lazy groups parse on first enable). */
  let cadIndex = null, cadIndexN = -1;
  function cadByCoords(coords) {
    if (!coords || !SBMM.CadNative) return null;
    const feats = SBMM.CadNative.features || [];
    if (!cadIndex || cadIndexN !== feats.length) {
      cadIndex = new Map();
      for (const f of feats) if (f.coords) cadIndex.set(f.coords, f);
      cadIndexN = feats.length;
    }
    return cadIndex.get(coords) || null;
  }

  /* A hook for a module that draws its own 3D objects — §8 names cadnative as
     the case. It is deliberately tiny: hand over the object and the CAD record,
     and the popup, the hover and the card all follow from the registry. */
  function registerCad(object3d, feature, id) {
    return register({
      id, object3d, kind: "cad", priority: priorityOf(object3d),
      hit: () => ({ title: feature.layer, html: SBMM.popups.forCad(feature) })
    });
  }

  /* ------------------------------------------------------------------ */
  /* raycasting                                                          */
  /* ------------------------------------------------------------------ */
  /* Thresholds scale with camera distance: at 6 000 ft out a Points cloud
     rendered 14 px wide is a few tens of feet across in world units, and a
     fixed threshold either misses everything when zoomed out or grabs half the
     site when zoomed in. Tying it to the distance from the camera to the orbit
     target keeps the *screen* tolerance roughly constant, which is what the
     hand actually aims with. */
  function setThresholds() {
    const rc = ctx.raycaster;
    /* the orbit radius is exactly "how far away is what I am looking at", which
       is the number a screen-space tolerance has to be built from */
    const dist = Math.max(60, (ctx.camDist && ctx.camDist()) || 1000);
    const t = clamp(dist * 0.006, 3, 90);
    rc.params.Points = rc.params.Points || {};
    rc.params.Line = rc.params.Line || {};
    rc.params.Points.threshold = t;
    rc.params.Line.threshold = t * 0.7;
    return t;
  }

  function ndc(e) {
    const r = ctx.dom.getBoundingClientRect();
    V2.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    V2.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    return V2;
  }

  /* Nearest registered object under the pointer, or null. Terrain is excluded:
     it is the fallback, tested separately and only on a click. */
  function raycast(e) {
    if (!ctx || !reg.size) return null;
    setThresholds();
    ctx.raycaster.setFromCamera(ndc(e), ctx.camera);
    let best = null;
    for (const entry of reg.values()) {
      if (!entry.object3d.visible) continue;
      HITS.length = 0;
      try { ctx.raycaster.intersectObject(entry.object3d, false, HITS); }
      catch (err) { continue; }
      if (!HITS.length) continue;
      const h = HITS[0];
      /* Priority first, distance second. Two objects the ray genuinely passes
         through at almost the same depth (a depth stick and its marker cap) are
         resolved by what the user is more likely to be aiming at. */
      if (!best || entry.priority > best.entry.priority
          || (entry.priority === best.entry.priority && h.distance < best.hit.distance)) {
        best = { entry, hit: { distance: h.distance, index: h.index, point: h.point.clone() } };
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* hover                                                               */
  /* ------------------------------------------------------------------ */
  let hoverRAF = 0, hoverEvt = null;
  function onMove(e) {
    hoverEvt = e;
    if (hoverRAF) return;
    hoverRAF = requestAnimationFrame(() => { hoverRAF = 0; doHover(hoverEvt); });
  }
  function doHover(e) {
    if (!ctx || !ctx.isOpen() || !e) return;
    if (SBMM.tools.active()) { clearHover(); return; }   // a tool owns the cursor
    const got = raycast(e);
    const id = got ? got.entry.id : null;
    const idx = got ? got.hit.index : null;
    if (hovered && hovered.id === id && hovered.index === idx) { moveTip(e); return; }
    clearHover(true);
    if (!got) { ctx.dom.style.cursor = ""; return; }
    let info = null;
    try { info = got.entry.hit(got.hit); } catch (err) { info = null; }
    if (!info) { ctx.dom.style.cursor = ""; return; }
    hovered = { id, index: idx, obj: got.entry.object3d };
    highlight(got.entry.object3d, true);
    ctx.dom.style.cursor = "pointer";
    showTip(info.title || "", e);
    ctx.requestRender();
  }
  function clearHover(quiet) {
    if (hovered) {
      highlight(hovered.obj, false);
      hovered = null;
      if (!quiet) ctx.requestRender();
    }
    hideTip();
  }
  /* Highlight without allocating: the emissive/opacity change is done on the
     material already there, and the original values are stashed on the object
     the first time it is highlighted. */
  function highlight(o, on) {
    if (!o || !o.material) return;
    const m = o.material;
    if (on) {
      if (o.userData._hl) return;
      o.userData._hl = { opacity: m.opacity, transparent: m.transparent, color: m.color && m.color.getHex() };
      m.transparent = true;
      m.opacity = Math.min(1, (m.opacity == null ? 1 : m.opacity) * 0.55 + 0.45);
      if (m.color) m.color.setHex(0xFFD34D);
      m.needsUpdate = true;
    } else if (o.userData._hl) {
      const s = o.userData._hl;
      m.opacity = s.opacity; m.transparent = s.transparent;
      if (m.color && s.color != null) m.color.setHex(s.color);
      m.needsUpdate = true;
      delete o.userData._hl;
    }
  }

  function showTip(txt, e) {
    if (!txt) { hideTip(); return; }
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "pick3dTip";
      (document.getElementById("view3d") || document.body).appendChild(tipEl);
    }
    tipEl.textContent = txt;
    tipEl.hidden = false;
    moveTip(e);
  }
  function moveTip(e) {
    if (!tipEl || tipEl.hidden || !e) return;
    const host = tipEl.offsetParent || document.body;
    const r = host.getBoundingClientRect();
    tipEl.style.left = (e.clientX - r.left) + "px";
    tipEl.style.top = (e.clientY - r.top) + "px";
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }

  /* ------------------------------------------------------------------ */
  /* the identify card                                                   */
  /* ------------------------------------------------------------------ */
  /* Anchored to the picked point in SCENE space, not to a screen position, so
     it follows the object as the camera moves instead of drifting off it. */
  function openCard(html, scenePoint, title) {
    closeCard();
    card = document.createElement("div");
    card.id = "pick3dCard";
    card.innerHTML = `<span class="p3close" title="Close (Esc)">✕</span>`
      + `<div class="p3body">${html}</div>`;
    (document.getElementById("view3d") || document.body).appendChild(card);
    card.querySelector(".p3close").onclick = closeCard;
    cardAnchor = scenePoint ? scenePoint.clone() : null;
    placeCard();
    setTimeout(() => {
      document.addEventListener("pointerdown", awayHandler, true);
      document.addEventListener("keydown", escHandler, true);
    }, 0);
  }
  function closeCard() {
    if (!card) return;
    document.removeEventListener("pointerdown", awayHandler, true);
    document.removeEventListener("keydown", escHandler, true);
    card.remove();
    card = null; cardAnchor = null;
  }
  function awayHandler(e) {
    if (card && !card.contains(e.target)) closeCard();
  }
  function escHandler(e) {
    if (e.key !== "Escape" || !card) return;
    /* Esc closes the card and stops there. Without stopping it, the same Esc
       also reaches js/draw.js and clears the selection or drops the tool —
       the "Esc must reach the front-most thing" rule in CLAUDE.md. */
    e.stopPropagation(); e.preventDefault();
    closeCard();
  }
  /* re-project on every camera change; called from the render loop's compass tick */
  function placeCard() {
    if (!card || !cardAnchor || !ctx) return;
    TMPV.copy(cardAnchor).project(ctx.camera);
    const host = card.offsetParent || document.body;
    const r = ctx.dom.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const sx = (TMPV.x * 0.5 + 0.5) * r.width + (r.left - hr.left);
    const sy = (-TMPV.y * 0.5 + 0.5) * r.height + (r.top - hr.top);
    const w = card.offsetWidth || 240, h = card.offsetHeight || 120;
    /* behind the camera, or off the canvas: hide rather than draw a card
       pointing at nothing */
    if (TMPV.z > 1 || sx < -w || sy < -h || sx > hr.width + w || sy > hr.height + h) {
      card.style.visibility = "hidden";
      return;
    }
    card.style.visibility = "";
    let top = sy - h - 12, above = false;
    if (top < 4) { top = sy + 14; above = true; }
    const left = clamp(sx - w / 2, 4, Math.max(4, hr.width - w - 4));
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
    card.style.setProperty("--tipx", Math.round(clamp(sx - left, 10, w - 10)) + "px");
    card.classList.toggle("above", above);
  }

  /* ------------------------------------------------------------------ */
  /* click                                                               */
  /* ------------------------------------------------------------------ */
  /* Returns true when the click was consumed. viewer3d calls this only after
     its own click-vs-drag threshold has passed and only when no tool is armed. */
  function click(e) {
    if (!ctx) return false;
    const got = raycast(e);
    if (got) {
      let info = null;
      try { info = got.entry.hit(got.hit); } catch (err) { console.error(err); }
      if (info) {
        openCard(info.html, got.hit.point, info.title);
        if (info.featureId) SBMM.store.select(info.featureId);
        return true;
      }
    }
    /* terrain fallback — the coordinate card §2 and §8 ask for */
    const p = ctx.pickWorld(e);
    if (!p) { closeCard(); return false; }
    const sp = ctx.pickScene(e);
    openCard(SBMM.popups.forTerrain(p[0], p[1], p[2]), sp, "Point");
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 3D vertex editing (parity with the 2D handles)                      */
  /* ------------------------------------------------------------------ */
  /* Everything below writes through SBMM.store / SBMM.tools, so a vertex moved
     in 3D is the same edit as a vertex moved in 2D: the map redraws, the
     results card recomputes, the Features tree updates and the session saves.
     There is deliberately no separate 3D geometry model. */
  let handleGroup = null, dragging = null;

  function editHandles() {
    if (!ctx || !ctx.isOpen()) return;
    const f = SBMM.store.selectedFeature();
    clearHandles();
    if (!f || f.locked || f.type === "spot" || !f.pts || f.pts.length < 2) return;
    const { CX, CY, ZMID } = ctx.center();
    handleGroup = new THREE.Group();
    handleGroup.scale.z = ctx.exag();
    const geo = new THREE.SphereGeometry(1, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xFFD34D, depthTest: false });
    const r = clamp(ctx.camera.position.length() * 0.004, 3, 40);
    f.pts.forEach((p, i) => {
      const [z] = SBMM.elev(p[0], p[1]);
      const m = new THREE.Mesh(geo, mat);
      m.scale.setScalar(r);
      m.position.set(p[0] - CX, p[1] - CY, (isNaN(z) ? ZMID : z) - ZMID + 4);
      m.renderOrder = 6;
      m.userData.vtx = { fid: f.id, i };
      handleGroup.add(m);
    });
    ctx.scene.add(handleGroup);
    ctx.requestRender();
  }
  function clearHandles() {
    if (!handleGroup) return;
    ctx.scene.remove(handleGroup);
    handleGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    handleGroup = null;
  }
  function handleUnder(e) {
    if (!handleGroup) return null;
    setThresholds();
    ctx.raycaster.setFromCamera(ndc(e), ctx.camera);
    HITS.length = 0;
    ctx.raycaster.intersectObject(handleGroup, true, HITS);
    return HITS.length ? HITS[0].object.userData.vtx : null;
  }

  function onDown(e) {
    if (e.button !== 0 || !ctx || !ctx.isOpen()) return;
    const v = handleUnder(e);
    if (!v) return;
    const f = SBMM.store.byId(v.fid);
    if (!f) return;
    /* stop the nav rig from also treating this drag as an orbit */
    e.stopPropagation();
    /* the entry is pushed on pointer UP, where the "after" state exists — see
       the same rule in js/draw.js */
    dragging = { f, i: v.i, before: f.pts.map(q => q.slice()) };
    ctx.dom.setPointerCapture && ctx.dom.setPointerCapture(e.pointerId);
  }
  function onDrag(e) {
    if (!dragging) return;
    const p = ctx.pickWorld(e);
    if (!p) return;
    e.stopPropagation();
    dragging.f.pts[dragging.i] = [p[0], p[1]];
    commitEdit(dragging.f, true);
  }
  function onUp() {
    if (!dragging) return;
    const f = dragging.f, before = dragging.before;
    dragging = null;
    commitEdit(f, false);
    const after = f.pts.map(q => q.slice());
    if (JSON.stringify(before) === JSON.stringify(after)) return;   // a click, not a move
    /* every restore hands over a fresh copy: the drag writes through f.pts */
    const set = v => { f.pts = v.map(q => q.slice()); commitEdit(f, false); editHandles(); };
    SBMM.undo.push("move vertex (3D)", () => set(before), () => set(after));
  }
  function commitEdit(f, live) {
    SBMM.tools.redraw(f);
    SBMM.tools.recompute(f, live);
    SBMM.store.emit();
  }

  /* Delete: the selected feature, or — when the cursor is over one — a single
     vertex, matching the 2D right-click-a-vertex behaviour. */
  function onKey(e) {
    if (!ctx || !ctx.isOpen()) return;
    if (e.key !== "Delete") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (SBMM.draw.isDrawing() || SBMM.draw.isPicking()) return;
    const f = SBMM.store.selectedFeature();
    if (!f) return;
    e.preventDefault();
    /* the undoable delete — the same one ERASE runs (js/tools.js) */
    if (SBMM.tools.deleteFeature(f)) toast("deleted " + (f.name || f.type));
  }

  function wireCanvas() {
    const dom = ctx.dom;
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerleave", () => clearHover());
    dom.addEventListener("pointerdown", onDown, true);
    dom.addEventListener("pointermove", onDrag, true);
    dom.addEventListener("pointerup", onUp, true);
    dom.addEventListener("pointercancel", onUp, true);
    document.addEventListener("keydown", onKey);
    SBMM.store.onSelect(() => editHandles());
    SBMM.store.onChange(() => { if (handleGroup) editHandles(); });
  }

  /* called from viewer3d's render loop so the card tracks the camera */
  function onCamera() { placeCard(); }

  function stats() {
    return {
      registered: reg.size, sceneOwned: sceneIds.length,
      kinds: [...reg.values()].reduce((a, e) => { a[e.kind] = (a[e.kind] || 0) + 1; return a; }, {}),
      cardOpen: !!card, hoverActive: !!hovered, handles: handleGroup ? handleGroup.children.length : 0
    };
  }

  return {
    register, unregister, registered, registerCad, attach, attached, syncScene,
    click, onCamera, closeCard, editHandles, stats,
    cardOpen: () => !!card,
    cardHtml: () => (card ? card.querySelector(".p3body").innerHTML : null)
  };
})();
