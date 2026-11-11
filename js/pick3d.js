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
  let card = null;
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
      hit: spec.hit,
      /* v53 — a LIVE surface (the TEM model's sheets, sections and walls):
         what it says depends on WHERE on it the pointer is, so its reading
         is asked on every move rather than once per object, it is never
         tinted as a whole, and `accept` lets it refuse a hit on a part of
         itself that cannot be seen. `live(hit, event)` shows its own chip
         and answers whether it had anything to say; `liveEnd()` puts it away. */
      live: typeof spec.live === "function" ? spec.live : null,
      liveEnd: typeof spec.liveEnd === "function" ? spec.liveEnd : null,
      accept: typeof spec.accept === "function" ? spec.accept : null
    });
    return id;
  }
  function unregister(id) { reg.delete(id); }
  function temSurfSpec(o, t, P) {
    const TP = SBMM.temprobe;
    return {
      object3d: o, kind: "temsurf", priority: P != null ? P : 1,
      hit: ix => TP.click3d(t, ix),
      live: (hit, e) => TP.hover3d(t, hit, e),
      liveEnd: () => TP.end3d(),
      accept: q => TP.accept3d(t, q)
    };
  }
  /* for an object outside the overlay group (the cut's walls and floor) */
  function registerTem(o, t) { return SBMM.temprobe ? register(temSurfSpec(o, t, 1)) : null; }
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

  /* v58: a 2D tooltip string as a chip, read the way js/pick2d.js reads it —
     markup is shown as is, plain "name · kind" text goes to the two-part
     chip (showTip escapes it there, as pick2d does) */
  function asChip(s) {
    if (s == null || s === "") return undefined;
    s = String(s);
    if (/<[a-z]/i.test(s)) return s;
    const i = s.indexOf(" · ");
    return { lead: i > 0 ? s.slice(0, i) : s, kind: i > 0 ? s.slice(i + 3) : "" };
  }
  /* gisBatch / gisPts / gisSolid are built from js/designgis.js batch3d only */
  function gisChip(props) {
    return SBMM.designGIS && SBMM.designGIS.tip ? asChip(SBMM.designGIS.tip(props || {})) : undefined;
  }

  function specFor(o, t) {
    const P = priorityOf(o);
    switch (t.kind) {
      case "feature": return {
        object3d: o, kind: "feature", priority: P,
        hit() {
          const f = SBMM.store.byId(t.fid);
          if (!f) return null;
          /* v58: "name · type", the 2D chip's words for a store feature */
          return { title: (f.name || f.type) + (f.type ? " · " + f.type : ""), html: SBMM.popups.forFeature(f),
                   featureId: f.id, xyz: [f.pts[0][0], f.pts[0][1]],
                   /* the user's own drawing: a click selects it and the
                      Inspector is its card (a photo keeps its picture) */
                   own: f.type !== "photo" };
        }
      };
      /* v23 Phase B — the fence strip. The card is the fence's own popup with
         the boring nearest the point that was actually hit named at the top:
         a wall 900 ft long answering "fence diagram" says nothing a reader
         standing at one hole wants to know. The strip carries its own centring
         constants because the scene is drawn about (cx, cy) and only the
         viewer knows them. */
      case "fence": return {
        object3d: o, kind: "fence", priority: P,
        hit(inx) {
          const f = SBMM.store.byId(t.fid);
          if (!f) return null;
          let near = null, bd = Infinity;
          if (inx && inx.point) {
            const wx = inx.point.x + (t.cx || 0), wy = inx.point.y + (t.cy || 0);
            for (const q of (t.holes || [])) {
              const d = Math.hypot(q.x - wx, q.y - wy);
              if (d < bd) { bd = d; near = q; }
            }
          }
          const head = near
            ? `<b>${esc(near.id)}</b> <span style="opacity:.7">nearest boring, `
              + `${fmt0(bd)} ft along the cut</span><br>` : "";
          return { title: near ? near.id + " · " + (f.name || "fence") : (f.name || "fence"),
                   html: head + SBMM.popups.forFeature(f),
                   featureId: f.id, xyz: near ? [near.x, near.y] : [f.pts[0][0], f.pts[0][1]] };
        }
      };
      case "gis": return {
        object3d: o, kind: "gis", priority: P,
        hit() {
          /* v58: the tag carries the owning module's chip (designGIS, the
             survey, the site areas); kinds without one fall back to title */
          return { title: (t.props && t.props.name) || "Design feature",
                   html: SBMM.popups.forGis(t.props || {}, t.geom), chip: asChip(t.chip) };
        }
      };
      case "cad": return {
        object3d: o, kind: "cad", priority: P,
        hit() {
          const f = cadByCoords(t.coords);
          if (!f) return null;
          return { title: f.layer, html: SBMM.popups.forCad(f),
                   chip: asChip(SBMM.CadNative && SBMM.CadNative.tip ? SBMM.CadNative.tip(f) : null) };
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
          return { title: p.id, html: SBMM.popups.forDataset(d, p), xyz: [p.x, p.y],
                   chip: asChip(SBMM.datasets.tipFor ? SBMM.datasets.tipFor(d, p) : null) };
        }
      };
      /* v36: a TEM sounding — the same popup the 2D dot opens */
      case "tem": return {
        object3d: o, kind: "tem", priority: P,
        hit(ix) {
          return SBMM.geophys ? SBMM.geophys.pick3d(ix && ix.index != null ? ix.index : 0) : null;
        }
      };
      /* a layer of a sounding's model column (one InstancedMesh: instance
         k = sounding k/nl, layer k%nl) */
      case "temcol": return {
        object3d: o, kind: "temcol", priority: P,
        hit(ix) {
          return SBMM.geophys && SBMM.geophys.pickColumn ? SBMM.geophys.pickColumn(ix && ix.index != null ? ix.index : -1) : null;
        }
      };
      /* v38: the TEM interpretations — a proposed boring, the route, the
         base-of-waste surface and the band sheet. v53: the two SURFACES are
         live — they answer with the value at the point, not a sentence. */
      /* v54: a derived TEM map's surface (js/temmaps.js) — live, like the
         two interpretation surfaces */
      case "temmap":
        return {
          object3d: o, kind: "temmap", priority: P,
          hit(ix) { return SBMM.temmaps ? SBMM.temmaps.pick3d(ix) : null; },
          live: SBMM.temprobe ? (hit, e) => SBMM.temprobe.hoverInterp("map", hit, e) : null,
          liveEnd: SBMM.temprobe ? () => SBMM.temprobe.end3d() : null
        };
      case "teminterp": {
        const pk = o.userData.pick, surf = pk.what === "waste" || pk.what === "seep";
        return {
          object3d: o, kind: "teminterp", priority: P,
          hit(ix) {
            return SBMM.teminterp ? SBMM.teminterp.pick3d(pk.what, ix && ix.index != null ? Math.floor(ix.index / (pk.per || 1)) : 0, ix) : null;
          },
          live: surf && SBMM.temprobe ? (hit, e) => SBMM.temprobe.hoverInterp(pk.what, hit, e) : null,
          liveEnd: surf && SBMM.temprobe ? () => SBMM.temprobe.end3d() : null
        };
      }
      /* v53: a surface of the TEM model — the slice, a stack sheet, a
         section, a voxel cloud; the cut's walls and floor register
         themselves (js/viewer3d.js), with the same four functions */
      case "temsurf": return SBMM.temprobe ? temSurfSpec(o, t, P) : null;
      case "sample": return {
        object3d: o, kind: "sample", priority: P,
        hit(ix) {
          const p = SBMM.samples[ix && ix.index != null ? ix.index : 0];
          if (!p) return null;
          return { title: p.id, html: SBMM.popups.forSample(p), xyz: [p.x, p.y],
                   chip: asChip(SBMM.sampleTip ? SBMM.sampleTip(p) : null) };
        }
      };
      case "tree": return {
        object3d: o, kind: "tree", priority: P,
        hit(ix) {
          /* v39: a tree is an INSTANCE of one of js/trees3d.js's meshes, and the
             mesh carries which tree each instance is */
          const map = o.userData.treeIdx;
          const k = ix && ix.index != null ? ix.index : -1;
          const t2 = SBMM.trees && SBMM.trees.tree ? SBMM.trees.tree(map && k >= 0 ? map[k] : k) : null;
          if (!t2) return null;
          /* v58: the 2D crowns carry no tooltip; the chip names the height and form */
          return { title: "Tree " + t2.id, html: SBMM.popups.forTree(t2), xyz: [t2.x, t2.y],
                   chip: { lead: "Tree " + t2.id,
                           kind: fmt0(t2.h) + " ft" + (t2.form ? " " + String(t2.form).toLowerCase() : "") } };
        }
      };
      case "cultural": return {
        object3d: o, kind: "cultural", priority: P,
        hit() {
          const D = window.SBMM_DATA && SBMM_DATA.cultural;
          const spec = D && (D.layers || []).find(l => l.key === t.feature.layer);
          return { title: t.feature.name,
                   html: SBMM.cultural.popup(t.feature, spec || { name: "Cultural resource" }),
                   chip: asChip(SBMM.cultural.tip ? SBMM.cultural.tip(t.feature, spec || { name: "Cultural resource" }) : null) };
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
                   html: SBMM.popups.forGis(it.props || {}, it.geom), chip: gisChip(it.props) };
        }
      };
      /* v43: a layer stood up as solids (js/built3d.js: the buildings, the
         fences, the power poles). One mesh per layer; the triangle a click
         lands on maps back to EA's feature through the owner array, so the
         answer is the popup the 2D map gives for that feature. */
      case "gisSolid": return {
        object3d: o, kind: "gis", priority: t.points ? 3 : 2,
        hit(ix) {
          const own = o.userData.owner || [];
          const it = t.items[ix && ix.face != null && own[ix.face] != null ? own[ix.face] : 0];
          if (!it) return null;
          return { title: (it.props && it.props.name) || "Design feature",
                   html: SBMM.popups.forGis(it.props || {}, it.geom),
                   xyz: it.x != null ? [it.x, it.y] : undefined, chip: gisChip(it.props) };
        }
      };
      case "gisPts": return {
        object3d: o, kind: "gis", priority: P,
        hit(ix) {
          const it = t.items[ix && ix.index != null ? ix.index : 0];
          if (!it) return null;
          return { title: (it.props && it.props.name) || "Design feature",
                   html: SBMM.popups.forGis(it.props || {}, it.geom), xyz: [it.x, it.y], chip: gisChip(it.props) };
        }
      };
      /* v15: a 3D label chip. Whatever built it said what it is about, so the
         card is that text — no lookup, and nothing to keep in step. */
      case "label": return {
        object3d: o, kind: "label", priority: 3,
        hit() { return { title: t.title || "Label", html: t.html || ("<b>" + esc(t.title || "") + "</b>") }; }
      };
      /* v58 (3b): ONE object that answers for itself, and one that answers
         per element. The tag carries what the 2D layer says about the same
         thing — its chip and its card, from the same functions — so a kind
         that is pickable in 2D needs no case of its own here:
           { kind: "card",  title, chip, html: () => string, xyz?, own? }
           { kind: "cards", at(i, hit) -> { title, chip, html, xyz?, own? } | null }
         `html` is a FUNCTION (or `at` returns one): the card is built when it
         is opened, as a Leaflet popup's is, not on every hover. For `cards`,
         `i` is the hit's vertex / segment / instance index and `hit` the whole
         record (`face` for a mesh with a face-to-owner array). */
      case "card": return {
        object3d: o, kind: "card", priority: t.priority != null ? t.priority : P,
        hit() { return { title: t.title || "", chip: asChip(t.chip), html: t.html, xyz: t.xyz, own: t.own }; }
      };
      case "cards": return {
        object3d: o, kind: "cards", priority: t.priority != null ? t.priority : P,
        hit(ix) {
          let r = null;
          try { r = t.at(ix && ix.index != null ? ix.index : 0, ix || {}); } catch (e) { r = null; }
          if (!r) return null;
          return { title: r.title || "", chip: asChip(r.chip), html: r.html, xyz: r.xyz, own: r.own };
        }
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
                   xyz: [rec.x, rec.y],
                   chip: asChip(SBMM.cultural.tip ? SBMM.cultural.tip(rec.feature, spec || { name: "Cultural resource" }) : null) };
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
    /* v17 §3: a fingertip is ~44 px across against a mouse cursor's 1, so the
       screen tolerance doubles under body.touch. It is still a SCREEN
       tolerance — the distance scaling above is what keeps it one. */
    const coarse = !!(SBMM.touch && SBMM.touch.on() && SBMM.touch.lastPointer() === "touch");
    const t = clamp(dist * (coarse ? 0.012 : 0.006), 3, coarse ? 180 : 90);
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
     it is the fallback, tested separately and only on a click.
     `raycastAll` is the same scan keeping every object the ray met — best
     first — for a click's "also here" row. */
  function scan(e, all) {
    if (!ctx || !reg.size) return all ? [] : null;
    setThresholds();
    ctx.raycaster.setFromCamera(ndc(e), ctx.camera);
    let best = null;
    const list = all ? [] : null;
    for (const entry of reg.values()) {
      if (!entry.object3d.visible) continue;
      HITS.length = 0;
      try { ctx.raycaster.intersectObject(entry.object3d, false, HITS); }
      catch (err) { continue; }
      if (!HITS.length) continue;
      /* v27: an object the fence clip box has cut away is not there to click */
      const V = SBMM.viewer3d, C0 = ctx.center ? ctx.center() : null;
      const cut = V && V.clipContains && C0 && !(entry.object3d.userData && entry.object3d.userData.noClip)
        ? q => V.clipContains(q.point.x + C0.CX, q.point.y + C0.CY) : null;
      const acc = entry.accept;
      const h = cut || acc ? HITS.find(q => !(cut && cut(q)) && !(acc && !acc(q))) : HITS[0];
      if (!h) continue;
      /* Priority first, distance second. Two objects the ray genuinely passes
         through at almost the same depth (a depth stick and its marker cap) are
         resolved by what the user is more likely to be aiming at. */
      const better = !best || entry.priority > best.entry.priority
          || (entry.priority === best.entry.priority && h.distance < best.hit.distance);
      if (!better && !all) continue;
      /* an InstancedMesh reports its instance, not an index */
      const got = { entry, hit: { distance: h.distance, index: h.index != null ? h.index : h.instanceId, point: h.point.clone(),
                                  face: h.faceIndex } };
      if (better) best = got;
      if (all) list.push(got);
    }
    if (!all) return best;
    return list.sort((a, b) => (b.entry.priority - a.entry.priority) || (a.hit.distance - b.hit.distance));
  }
  const raycast = e => scan(e, false);
  const raycastAll = e => scan(e, true);

  /* ------------------------------------------------------------------ */
  /* hover                                                               */
  /* ------------------------------------------------------------------ */
  let hoverRAF = 0, hoverEvt = null;
  /* v58: THE DWELL IS GONE. From 2026-09-08 a pointer that stopped for half a
     second opened the identify card by itself — in 3D only, the 2D map never
     did — because the tip said only a name. The chip now says what the card
     was opened to say (js/tip.js, and js/readout.js over bare ground), so a
     card opens on a click and on nothing else, in both views. */
  function onMove(e) {
    hoverEvt = e;
    if (hoverRAF) return;
    hoverRAF = requestAnimationFrame(() => { hoverRAF = 0; doHover(hoverEvt); });
  }
  function doHover(e) {
    if (!ctx || !ctx.isOpen() || !e) return;
    if (SBMM.tools.active()) { clearHover(); return; }   // a tool owns the cursor
    /* v24 §3: the hover raycast is the one per-frame-adjacent cost that does
       not live in js/viewer3d.js, so it reports itself into frameStats() */
    const _t = performance.now();
    const got = raycast(e);
    if (SBMM.viewer3d && SBMM.viewer3d.noteHover) SBMM.viewer3d.noteHover(performance.now() - _t);
    const id = got ? got.entry.id : null;
    /* v58: one FEATURE of a merged object is one hover, whichever of its
       segments or faces is under the pointer — so the chip is not rewritten
       and the highlight not rebuilt as the pointer runs along a boundary */
    const idx = got ? elemKey(got.entry.object3d, got.hit) : null;
    /* v53: a live surface answers for the point, on every move */
    if (got && got.entry.live) {
      if (hovered && !(hovered.live && hovered.id === id)) clearHover(true);
      let said = false;
      try { said = !!got.entry.live(got.hit, e); } catch (err) { said = false; }
      if (said) {
        if (liveNow && liveNow !== got.entry && liveNow.liveEnd) liveNow.liveEnd();
        liveNow = got.entry;
        hovered = { id, index: idx, obj: got.entry.object3d, live: true };
        ctx.dom.style.cursor = "crosshair";
        hideTip();
        return;
      }
      endLive();
      if (hovered && hovered.live) hovered = null;
      ctx.dom.style.cursor = "";
      return;
    }
    endLive();
    if (hovered && hovered.live) hovered = null;
    if (hovered && hovered.id === id && hovered.index === idx) { moveTip(e); return; }
    clearHover(true);
    if (!got) { ctx.dom.style.cursor = ""; return; }
    let info = null;
    try { info = got.entry.hit(got.hit); } catch (err) { info = null; }
    if (!info) { ctx.dom.style.cursor = ""; return; }
    hovered = { id, index: idx, obj: got.entry.object3d };
    highlight(got.entry.object3d, true, got.hit);
    ctx.dom.style.cursor = "pointer";
    showTip(info, e);
    ctx.requestRender();
  }
  let liveNow = null;
  function endLive() {
    if (!liveNow) return;
    const l = liveNow; liveNow = null;
    if (l.liveEnd) { try { l.liveEnd(); } catch (err) { /* a chip is a courtesy */ } }
  }
  function clearHover(quiet) {
    endLive();
    if (hovered) {
      if (!hovered.live) highlight(hovered.obj, false);
      hovered = null;
      if (!quiet) ctx.requestRender();
    }
    hideTip();
  }
  /* v58 (3b): THE HOVER LIGHTS THE FEATURE, NOT THE LAYER. A whole layer is
     often ONE object — every lot line in one LineSegments, every building in
     one mesh, every well in one Points — and recolouring its material turned
     the entire layer yellow when one feature was under the pointer. Where an
     object maps its elements to features (`userData.owner`: one entry per
     segment, or per face) or is a point cloud, the highlight is a separate
     object made from that ONE feature's own geometry; an object that IS one
     feature is still tinted in place, as before. Built when the hovered
     feature changes, never per move. */
  function elemKey(o, hit) {
    const own = o.userData && o.userData.owner;
    if (own && o.isLineSegments && hit.index != null) return "o" + own[Math.floor(hit.index / 2)];
    if (own && o.isMesh && !o.isInstancedMesh && hit.face != null) return "o" + own[hit.face];
    return hit.index;
  }
  const HL = 0xFFD34D;
  let hlObj = null;
  function dropHl() {
    if (!hlObj) return;
    if (hlObj.parent) hlObj.parent.remove(hlObj);
    hlObj.traverse(q => { if (q.geometry) q.geometry.dispose(); if (q.material) q.material.dispose(); });
    hlObj = null;
  }
  function elementHl(o, hit) {
    const g = o.geometry, pos = g && g.attributes && g.attributes.position, own = o.userData && o.userData.owner;
    if (!pos || !hit) return null;
    const A = pos.array, st = pos.itemSize || 3;
    let out = null;
    const take = (dst, v) => { dst.push(A[v * st], A[v * st + 1], A[v * st + 2]); };
    if (o.isPoints && pos.count > 1 && hit.index != null) {
      const P = []; take(P, hit.index);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
      const m0 = o.material || {};
      out = new THREE.Points(geo, new THREE.PointsMaterial({ color: HL, size: (m0.size || 6) * 1.8,
        sizeAttenuation: !!m0.sizeAttenuation, depthTest: false, transparent: true, opacity: 0.95 }));
    } else if (own && o.isLineSegments && hit.index != null) {
      const id = own[Math.floor(hit.index / 2)], P = [];
      for (let k = 0; k < own.length; k++) if (own[k] === id) { take(P, 2 * k); take(P, 2 * k + 1); }
      if (!P.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
      out = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: HL, depthTest: false, transparent: true, opacity: 0.95 }));
      /* where the layer is drawn with a width, so is its highlight */
      if (SBMM.lines3d && SBMM.lines3d.widen && o.material && o.material.visible === false) {
        out.userData.wideOpts = { width: 3.4, casing: 0 };
        try { SBMM.lines3d.widen(out); } catch (e) { /* the plain line is highlight enough */ }
      }
    } else if (own && o.isMesh && !o.isInstancedMesh && hit.face != null) {
      const id = own[hit.face], ix = g.index ? g.index.array : null, P = [];
      for (let f = 0; f < own.length; f++) if (own[f] === id)
        for (let c = 0; c < 3; c++) take(P, ix ? ix[3 * f + c] : 3 * f + c);
      if (!P.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
      out = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: HL, transparent: true, opacity: 0.42,
        depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
    }
    if (!out) return null;
    out.position.copy(o.position); out.quaternion.copy(o.quaternion); out.scale.copy(o.scale);
    out.renderOrder = 60;
    out.raycast = () => {};                       // a highlight is not a thing to pick
    out.userData.noClip = !!(o.userData && o.userData.noClip);
    return out;
  }
  /* An object that is ONE feature: tinted in place, without allocating — the
     colour/opacity change is done on the material already there, and the
     original values are stashed on the object the first time. */
  function highlight(o, on, hit) {
    if (!o) return;
    if (!on) dropHl();
    else if (hit) {
      dropHl();
      hlObj = elementHl(o, hit);
      if (hlObj && o.parent) { o.parent.add(hlObj); return; }
      hlObj = null;
    }
    if (!o.material) return;
    const m = o.material;
    if (on) {
      if (o.userData._hl) return;
      o.userData._hl = { opacity: m.opacity, transparent: m.transparent, color: m.color && m.color.getHex() };
      m.transparent = true;
      m.opacity = Math.min(1, (m.opacity == null ? 1 : m.opacity) * 0.55 + 0.45);
      if (m.color) m.color.setHex(HL);
      m.needsUpdate = true;
    } else if (o.userData._hl) {
      const s = o.userData._hl;
      m.opacity = s.opacity; m.transparent = s.transparent;
      if (m.color && s.color != null) m.color.setHex(s.color);
      m.needsUpdate = true;
      delete o.userData._hl;
    }
  }

  /* v58: the chip is js/tip.js's, the one the 2D map uses. `info.chip` is the
     kind's own chip markup — the same function the 2D layer's tooltip is built
     by, so a well reads the same in both views; `info.title` ("name · kind")
     is the two-line fallback. */
  let tipOn = false;
  function showTip(info, e) {
    const T = SBMM.tip;
    if (!T || !info || !(info.chip || info.title) || !e) { hideTip(); return; }
    let html;
    if (info.chip && typeof info.chip === "object") html = T.html(info.chip);          // { lead, kind, lines }
    else if (info.chip) html = `<div class="tpt"><div class="pkrich">${info.chip}</div></div>`;
    else {
      const txt = String(info.title), i = txt.indexOf(" · ");
      html = T.html({ lead: i > 0 ? txt.slice(0, i) : txt, kind: i > 0 ? txt.slice(i + 3) : "" });
    }
    tipOn = true;
    T.claim("feature", { x: e.clientX, y: e.clientY, view: "3d", html,
      key: "3d|" + (hovered ? hovered.id + "|" + hovered.index : "") });
  }
  function moveTip(e) { if (tipOn && e && SBMM.tip) SBMM.tip.moveTo(e.clientX, e.clientY); }
  function hideTip() { if (tipOn) { tipOn = false; if (SBMM.tip) SBMM.tip.release("feature"); } }

  /* ------------------------------------------------------------------ */
  /* the identify card                                                   */
  /* ------------------------------------------------------------------ */
  /* Anchored to the picked point in SCENE space, not to a screen position, so
     it follows the object as the camera moves instead of drifting off it. */
  function openCard(html, scenePoint, title) {
    closeCard();
    /* v58: a kind may hand over a FUNCTION — the card is built when it is
       opened, as a Leaflet popup's is */
    if (typeof html === "function") { try { html = html(); } catch (err) { console.error(err); html = ""; } }
    /* v58: in field mode the answer goes where a 2D tap's goes — the bottom
       card (js/field.js). A floating card anchored to a point of the scene is
       a desktop thing: on a phone it sat under the thumb that asked for it. */
    if (document.body.classList.contains("field") && SBMM.field && SBMM.field.card && SBMM.field.on && SBMM.field.on()) {
      SBMM.field.card(html);
      return;
    }
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
  /* v58: a press that closed the card. The click that follows it on bare
     ground does only that — it closed something (js/readout.js has the same
     rule for the 2D map). */
  let closedAt = -1e9;
  /* by the events' own clock, not by when they were handled (a slow frame in
     between must not change what the click means) */
  const evT = e => (e && typeof e.timeStamp === "number" && e.timeStamp > 0) ? e.timeStamp : performance.now();
  function awayHandler(e) {
    if (card && !card.contains(e.target)) { closeCard(); closedAt = evT(e); }
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
  /* opts.objectsOnly: answer a registered object or nothing; opts.terrainOnly:
     skip straight to the terrain card (js/viewer3d.js tests a draped sheet
     between the two). No opts is both, in that order, as before. */
  /* v58 (3b) — what a click does, the same as on the 2D map:
       · something with a card: its card, with the other things the ray met
         offered underneath ("also here");
       · the user's own drawing: it is SELECTED and the Inspector is its card —
         no floating card (in 2D there never was one). A photo keeps its
         picture, the fence strip its nearest boring, and field mode — where
         the Inspector is a parked bottom sheet — keeps the card;
       · bare ground: the card of the layer the ground is wearing where it has
         one (js/readout.js), else the Point card — unless the press closed a
         card, in which case it only did that. */
  const nameOf = info => { const t = String((info && info.title) || ""), k = t.indexOf(" · "); return k > 0 ? t.slice(0, k) : t; };
  function infoOf(got) {
    try { return got.entry.hit(got.hit); } catch (err) { console.error(err); return null; }
  }
  function openEntry(list, k) {
    const got = list[k], info = infoOf(got);
    if (!info) return false;
    if (info.own && info.featureId && !document.body.classList.contains("field")) {
      closeCard();
      SBMM.store.select(info.featureId);
      return true;
    }
    openCard(info.html, got.hit.point, info.title);
    if (info.featureId) SBMM.store.select(info.featureId);
    alsoHere(list, k, nameOf(info));
    return true;
  }
  /* the 2D popup's row (js/pick2d.js), for the ray's other hits */
  function alsoHere(list, k, self) {
    if (!card || list.length < 2) return;
    const seen = new Set([self]), others = [];
    for (let j = 0; j < list.length && others.length < 5; j++) {
      if (j === k) continue;
      const n = nameOf(infoOf(list[j]));
      if (!n || seen.has(n)) continue;
      seen.add(n); others.push({ j, n });
    }
    if (!others.length) return;
    const bar = document.createElement("div");
    bar.className = "pkalso";
    bar.innerHTML = `<span class="pkalsoh">Also here</span>` + others.map(o =>
      `<button type="button" data-pk="${o.j}" title="${esc(o.n)}">${esc(o.n)}</button>`).join("");
    card.querySelector(".p3body").appendChild(bar);
    bar.addEventListener("click", ev => {
      const b = ev.target.closest("button[data-pk]");
      if (!b) return;
      ev.stopPropagation();
      openEntry(list, +b.dataset.pk);
    });
    placeCard();
  }
  function click(e, opts) {
    if (!ctx) return false;
    opts = opts || {};
    if (!opts.terrainOnly) {
      const list = raycastAll(e);
      for (let k = 0; k < list.length; k++) if (openEntry(list, k)) return true;
    }
    if (opts.objectsOnly) return false;
    /* bare ground */
    if (evT(e) - closedAt < 700) return true;                   // the press closed a card: only that
    const p = ctx.pickWorld(e);
    if (!p) { closeCard(); return false; }
    const sp = ctx.pickScene(e);
    const c = SBMM.readout && SBMM.readout.cardAt ? SBMM.readout.cardAt(p[0], p[1], { view: "3d" }) : null;
    openCard(c ? c.html : SBMM.popups.forTerrain(p[0], p[1], p[2], "3d"), sp, c ? (c.title || "") : "Point");
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
    /* 44-px hit spheres under body.touch (§3) — twice the mouse radius, for
       the same reason the raycaster thresholds double */
    const coarse = !!(SBMM.touch && SBMM.touch.on() && SBMM.touch.lastPointer() === "touch");
    const r = clamp(ctx.camera.position.length() * (coarse ? 0.008 : 0.004), 3, coarse ? 80 : 40);
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
    /* capture throws for a pointer id the browser has no active pointer for,
       which is exactly what `touchDrag`'s synthetic event is */
    try { ctx.dom.setPointerCapture && ctx.dom.setPointerCapture(e.pointerId); } catch (err) {}
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
    /* v17 §3: hover is a mouse and a PEN (an M-series iPad's Pencil hovers);
       a finger has no hover at all, and a finger's press is how the orbit
       starts — so touch never enters the drag path here. It reaches the same
       code through `touchDrag` from js/viewer3d.js's long-press instead. */
    const notFinger = e => e.pointerType !== "touch";
    dom.addEventListener("pointermove", e => { if (notFinger(e)) onMove(e); });
    dom.addEventListener("pointerleave", () => clearHover());
    dom.addEventListener("pointerdown", e => { if (notFinger(e)) onDown(e); }, true);
    dom.addEventListener("pointermove", e => { if (notFinger(e)) onDrag(e); }, true);
    dom.addEventListener("pointerup", e => { if (notFinger(e)) onUp(e); }, true);
    dom.addEventListener("pointercancel", e => { if (notFinger(e)) onUp(e); }, true);
    document.addEventListener("keydown", onKey);
    SBMM.store.onSelect(() => editHandles());
    SBMM.store.onChange(() => { if (handleGroup) editHandles(); });
  }

  /* v17 §3 — dragging a vertex handle with a finger.
     A mouse gets this from a plain press, because a press that does not move
     is not an orbit. A finger's press IS how the orbit starts, so the gesture
     has to be asked for: js/viewer3d.js calls `start()` from the recogniser's
     long-press, and while it returns true the rig feeds `move()` instead of
     orbiting. The three below are the same onDown/onDrag/onUp the mouse uses,
     handed a synthetic event — one implementation of the edit, not two. */
  const touchDrag = {
    start(x, y) {
      if (!ctx || !ctx.isOpen() || !handleGroup) return false;
      onDown(synth(x, y));
      return !!dragging;
    },
    move(x, y) { if (dragging) onDrag(synth(x, y)); },
    end() { if (dragging) onUp(); },
    active: () => !!dragging
  };
  function synth(x, y) {
    return { clientX: x, clientY: y, button: 0, pointerId: 1,
             stopPropagation() {}, preventDefault() {} };
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

  /* v30: the POINT FEATURE under the pointer, as a snap — a tool clicked in
     3D on a well's dot gets the well head's own plan coordinates, not the
     terrain the ray happens to reach beside it. Points only (priority 3): a
     line or an outline is a surface the tool is drawing ACROSS, not a node. */
  function snapPoint(e) {
    const best = raycast(e);
    if (!best || best.entry.priority < 3) return null;
    let info = null;
    try { info = best.entry.hit(best.hit); } catch (err) { info = null; }
    if (!info || !info.xyz || !isFinite(info.xyz[0]) || !isFinite(info.xyz[1])) return null;
    return { x: info.xyz[0], y: info.xyz[1], name: info.title || "" };
  }

  return {
    /* for the harness: is something hovered, and is the highlight one
       feature's own geometry (true) or the object tinted in place (false) */
    hoverState: () => ({ hovered: !!hovered, live: !!(hovered && hovered.live), element: !!hlObj,
                         tinted: !!(hovered && hovered.obj && hovered.obj.userData && hovered.obj.userData._hl) }),
    register, unregister, registered, registerCad, attach, attached, syncScene, snapPoint,
    click, onCamera, closeCard, editHandles, stats, touchDrag, registerTem,
    /* the i-th 3D vertex handle's scene position — the harness needs somewhere
       real to put a finger, and the console needs somewhere to look */
    handlePos: i => {
      if (!handleGroup || !handleGroup.children[i]) return null;
      const p = handleGroup.children[i].position;
      return [p.x, p.y * 1, p.z * handleGroup.scale.z];
    },
    handleCount: () => (handleGroup ? handleGroup.children.length : 0),
    cardOpen: () => !!card,
    cardHtml: () => (card ? card.querySelector(".p3body").innerHTML : null)
  };
})();
