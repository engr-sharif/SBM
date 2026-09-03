/* SBMM Site Explorer — measuring and marking inside the floating sheet viewer.

   §9. The sheet viewer already shows all 20 plots at full size. This makes it
   the third synchronised view of the site rather than a picture of one:

     * a toolbar per window — Inspect, Distance, Area, Point, Line, Polygon,
       Note, and "locate" on the map or in 3D;
     * everything drawn becomes a normal feature in SBMM.store, so it appears in
       2D and in 3D the moment it is finished, shows up in the Features tree,
       serialises into the session, exports, and can be edited from any view;
     * conversely, the window draws the store's features back over the drawing
       through the inverse affine, so a line measured on the map is visible on
       the sheet it belongs to.

   Provenance. A mark made on a sheet carries where it was made:

       props.provenance = { source: "sheet", sheet: "C-107", px: [[u,v], ...] }

   The pixel coordinates are kept alongside the State Plane ones deliberately.
   They are the record of what was actually pointed at on the drawing, they
   survive a change of registration, and they are what lets the window redraw a
   mark exactly where it was put rather than round-tripping it through the
   affine twice.

   The affine
   ----------
   `data/sheets_full.json` carries, per sheet, `affine: {a,b,c,d,e,f}` mapping
   full-sheet render pixels (u = column, v = row, origin top-left) to EPSG:6418
   State Plane feet:

       x = a*u + b*v + c        y = d*u + e*v + f

   It was recovered by tools/build_sheet_affine.py — read that file for the
   method and its two independent checks. Nine of the twenty sheets have
   `affine: null`: the four that were never registered, plus the detail and
   general sheets, which have no plan at all. Those windows say "not
   georeferenced" and allow only a non-geo note, exactly as §9 requires — a
   dimension off an unplaced sheet would be a number with no meaning.

   Keyboard scoping
   ----------------
   Every key handler here is bound to the window element, not to the document.
   A sheet window takes focus (that is how its arrow keys pan), and the app's
   single-letter tool shortcuts are already suppressed while it has focus; the
   same has to be true in reverse, so Enter finishing a sheet polygon never
   also finishes a sketch on the map. */
"use strict";

SBMM.sheetMarks = (function () {

  const TOOLS = [
    ["inspect", "Inspect", "Click for the State Plane coordinate under the cursor"],
    ["distance", "Distance", "Measure a distance across the drawing"],
    ["area", "Area", "Measure an area on the drawing"],
    ["point", "Point", "Drop a point feature at this spot on the drawing"],
    ["line", "Line", "Draw a polyline on the drawing"],
    ["polygon", "Polygon", "Draw a polygon on the drawing"],
    ["note", "Note", "Leave a text note on the drawing"]
  ];
  const GEO_TOOLS = new Set(["inspect", "distance", "area", "point", "line", "polygon"]);

  /* per-window marking state, keyed by the sheet window's state object.
     `live` is the same set in insertion order, so onEscape() can find the
     front-most window that actually has something to cancel. */
  const S = new WeakMap();
  const live = new Set();

  /* ------------------------------------------------------------------ */
  /* the affine                                                          */
  /* ------------------------------------------------------------------ */
  function affineOf(sheet) {
    const D = window.SBMM_DATA && SBMM_DATA.sheets_full;
    if (!D || !Array.isArray(D.sheets)) return null;
    const s = D.sheets.find(x => x.sheet === sheet);
    return (s && s.affine) || null;
  }
  function georeferenced(sheet) { return !!affineOf(sheet); }

  /* full-sheet pixel -> State Plane feet */
  function toSP(sheet, u, v) {
    const A = affineOf(sheet);
    if (!A) return null;
    return [A.a * u + A.b * v + A.c, A.d * u + A.e * v + A.f];
  }
  /* State Plane feet -> full-sheet pixel (the inverse the overlay draws with) */
  function toPx(sheet, x, y) {
    const A = affineOf(sheet);
    if (!A) return null;
    const det = A.a * A.e - A.b * A.d;
    if (Math.abs(det) < 1e-15) return null;
    const dx = x - A.c, dy = y - A.f;
    return [(A.e * dx - A.b * dy) / det, (A.a * dy - A.d * dx) / det];
  }
  /* ground feet per sheet pixel — the scale a measurement is reported at */
  function ftPerPx(sheet) {
    const A = affineOf(sheet);
    return A ? (A.ft_per_px || Math.hypot(A.a, A.d)) : null;
  }

  /* ------------------------------------------------------------------ */
  /* attach to a sheet window                                            */
  /* ------------------------------------------------------------------ */
  /* Called by js/sheets.js from wireWindow(). Everything below hangs off the
     window's own element, so closing the window disposes of all of it. */
  function attach(st) {
    if (S.has(st)) return;
    const geo = georeferenced(st.sheet);
    const state = {
      st, tool: null, pts: [], cursor: null, geo,
      bar: null, canvas: null, ctx: null, msg: null
    };
    S.set(st, state);
    live.add(state);

    const bar = document.createElement("div");
    bar.className = "shtools";
    bar.innerHTML = TOOLS.map(([k, label, tip]) =>
      `<button class="sht" data-sht="${k}" title="${esc(tip)}">${esc(label)}</button>`).join("")
      + `<span class="vsep"></span>`
      + `<button class="sht" data-sht="locate-map" title="Fly the 2D map to this sheet's footprint">on map</button>`
      + `<button class="sht" data-sht="locate-3d" title="Frame this sheet's footprint in the 3D view">in 3D</button>`
      + `<span class="shmsg"></span>`;
    /* between the title bar and the drawing, where a drafting toolbar belongs */
    st.el.insertBefore(bar, st.view);
    state.bar = bar;
    state.msg = bar.querySelector(".shmsg");

    const cv = document.createElement("canvas");
    cv.className = "shmark";
    st.view.appendChild(cv);
    state.canvas = cv;
    state.ctx = cv.getContext("2d");

    if (!geo) {
      state.msg.className = "shmsg shnogeo";
      state.msg.textContent = "not georeferenced — notes only";
      bar.querySelectorAll("[data-sht]").forEach(b => {
        if (GEO_TOOLS.has(b.dataset.sht)) b.disabled = true;
      });
      bar.querySelector('[data-sht="locate-map"]').disabled = true;
      bar.querySelector('[data-sht="locate-3d"]').disabled = true;
    } else {
      const f = ftPerPx(st.sheet);
      state.msg.textContent = `1 px ≈ ${fmt(f, 3)} ft`;
    }

    bar.addEventListener("click", e => {
      const b = e.target.closest("[data-sht]");
      if (!b || b.disabled) return;
      const k = b.dataset.sht;
      if (k === "locate-map") { SBMM.sheets.locate(st.sheet); return; }
      if (k === "locate-3d") { locate3d(st.sheet); return; }
      setTool(state, state.tool === k ? null : k);
    });

    /* Marking clicks share the view with the viewer's own drag-to-pan. The pan
       handler is already installed and swallows nothing, so the rule here is
       the same one the 3D view uses: a press that ends within a few pixels is a
       click, anything further is a pan. */
    let down = null;
    st.view.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      down = [e.clientX, e.clientY, performance.now()];
    });
    st.view.addEventListener("pointerup", e => {
      if (!state.tool || !down) { down = null; return; }
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      const held = performance.now() - down[2];
      down = null;
      if (moved > 4 || held > 400) return;         // that was a pan
      onClick(state, e);
    });
    st.view.addEventListener("pointermove", e => {
      if (!state.tool) return;
      state.cursor = viewToPx(state, e);
      paint(state);
    });
    st.view.addEventListener("pointerleave", () => {
      if (!state.tool) return;
      state.cursor = null; paint(state);
    });
    st.view.addEventListener("dblclick", e => {
      if (!state.tool) return;
      e.preventDefault(); e.stopPropagation();
      finish(state);
    });

    /* Scoped to the window element — see the header note. */
    st.el.addEventListener("keydown", e => {
      const s = S.get(st);
      if (!s || !s.tool) return;
      if (e.key === "Escape") {
        e.stopPropagation(); e.preventDefault();
        if (s.pts.length) { s.pts = []; paint(s); status(s, "cancelled"); }
        else setTool(s, null);
        return;
      }
      if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); finish(s); return; }
      if (e.key === "Backspace" && s.pts.length) {
        e.stopPropagation(); e.preventDefault();
        s.pts.pop(); paint(s);
      }
    }, true);

    /* the overlay follows every zoom, pan and resize the viewer does */
    const repaint = () => paint(S.get(st));
    st.view.addEventListener("wheel", () => requestAnimationFrame(repaint), { passive: true });
    st.view.addEventListener("pointermove", () => { if (!state.tool) requestAnimationFrame(repaint); });
    st.el.addEventListener("pointerup", () => requestAnimationFrame(repaint));
    st.img.addEventListener("load", () => requestAnimationFrame(repaint));
    /* and every change to the store, so a feature drawn on the map appears here */
    const onStore = () => paint(S.get(st));
    SBMM.store.onChange(onStore);
    state.onStore = onStore;

    requestAnimationFrame(repaint);
  }

  /* js/sheets.js flips a window between sheets in place, so the marking state
     has to follow it rather than being rebuilt */
  function resheet(st) {
    const s = S.get(st);
    if (!s) return;
    s.geo = georeferenced(st.sheet);
    s.tool = null; s.pts = []; s.cursor = null;
    s.bar.querySelectorAll("[data-sht]").forEach(b => {
      b.classList.remove("on");
      const k = b.dataset.sht;
      b.disabled = !s.geo && (GEO_TOOLS.has(k) || k.startsWith("locate"));
    });
    if (!s.geo) {
      s.msg.className = "shmsg shnogeo";
      s.msg.textContent = "not georeferenced — notes only";
    } else {
      s.msg.className = "shmsg";
      s.msg.textContent = `1 px ≈ ${fmt(ftPerPx(st.sheet), 3)} ft`;
    }
    st.el.classList.remove("marking");
    paint(s);
  }

  function detach(st) {
    const s = S.get(st);
    if (!s) return;
    S.delete(st);
    live.delete(s);
    if (s.onStore) { SBMM.store.offChange(s.onStore); s.onStore = null; }
    s.tool = null;
    s.canvas = null;
  }

  /* ------------------------------------------------------------------ */
  /* geometry plumbing                                                   */
  /* ------------------------------------------------------------------ */
  /* The viewer draws the image with a CSS transform: translate(tx,ty) scale(k).
     So view-box coordinates map to image pixels by undoing exactly that. */
  function viewToPx(state, e) {
    const st = state.st;
    const r = st.view.getBoundingClientRect();
    return [(e.clientX - r.left - st.tx) / st.scale,
            (e.clientY - r.top - st.ty) / st.scale];
  }
  function pxToView(state, u, v) {
    const st = state.st;
    return [u * st.scale + st.tx, v * st.scale + st.ty];
  }

  function status(state, txt) {
    if (!state.msg) return;
    const base = state.geo ? `1 px ≈ ${fmt(ftPerPx(state.st.sheet), 3)} ft` : "not georeferenced — notes only";
    state.msg.textContent = txt ? txt : base;
  }

  function setTool(state, k) {
    state.tool = k;
    state.pts = [];
    state.cursor = null;
    state.bar.querySelectorAll("[data-sht]").forEach(b =>
      b.classList.toggle("on", b.dataset.sht === k));
    state.st.el.classList.toggle("marking", !!k);
    if (k) {
      state.st.el.focus({ preventScroll: true });
      status(state, PROMPT[k] || "");
    } else status(state, null);
    paint(state);
  }
  const PROMPT = {
    inspect: "click anywhere on the drawing",
    distance: "click each point · double-click or Enter to finish · Esc cancels",
    area: "click the boundary · double-click or Enter to close · Esc cancels",
    point: "click to place a point",
    line: "click each vertex · double-click or Enter to finish",
    polygon: "click each vertex · double-click or Enter to close",
    note: "click where the note goes"
  };

  /* ------------------------------------------------------------------ */
  /* clicks                                                              */
  /* ------------------------------------------------------------------ */
  function onClick(state, e) {
    const px = viewToPx(state, e);
    const st = state.st;
    if (px[0] < 0 || px[1] < 0 || px[0] > st.iw || px[1] > st.ih) return;

    if (state.tool === "inspect") {
      const sp = toSP(st.sheet, px[0], px[1]);
      if (!sp) { toast(st.sheet + " is not georeferenced"); return; }
      const [z] = SBMM.elev(sp[0], sp[1]);
      const [lo, la] = SBMM.toLL(sp[0], sp[1]);
      status(state, `${fmt0(sp[0])} E, ${fmt0(sp[1])} N`
        + (isNaN(z) ? "" : ` · ${fmt(z, 1)} ft`)
        + ` · ${la.toFixed(6)}, ${lo.toFixed(6)}`);
      state.pts = [px];
      paint(state);
      return;
    }
    if (state.tool === "point" || state.tool === "note") {
      state.pts = [px];
      commit(state);
      return;
    }
    state.pts.push(px);
    paint(state);
    if (state.tool === "distance" && state.pts.length >= 2) liveReadout(state);
  }

  function finish(state) {
    const need = (state.tool === "area" || state.tool === "polygon") ? 3 : 2;
    if (!state.pts.length) return;
    if (state.pts.length < need) { toast(`need at least ${need} points`); return; }
    commit(state);
  }

  function liveReadout(state) {
    const f = ftPerPx(state.st.sheet);
    if (!f) return;
    let d = 0;
    for (let i = 1; i < state.pts.length; i++)
      d += Math.hypot(state.pts[i][0] - state.pts[i - 1][0],
                      state.pts[i][1] - state.pts[i - 1][1]) * f;
    status(state, `${fmt(d, 1)} ft · ${state.pts.length} points · Enter finishes`);
  }

  /* ------------------------------------------------------------------ */
  /* commit — a sheet mark becomes an ordinary store feature             */
  /* ------------------------------------------------------------------ */
  function commit(state) {
    const st = state.st, tool = state.tool;
    const px = state.pts.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]);

    /* A note on an unregistered sheet is the one thing that has no ground
       position, so it cannot be a map feature. It is kept on the window and
       reported, rather than silently refused — a silent refusal is the one
       thing this app must not do. */
    if (!state.geo) {
      if (tool !== "note") { toast(st.sheet + " is not georeferenced — only notes can be added"); return; }
      const txt = prompt("Note on " + st.sheet + ":", "");
      if (txt == null || !txt.trim()) { setTool(state, null); return; }
      (state.notes = state.notes || []).push({ px: px[0], text: txt.trim() });
      toast("note kept on " + st.sheet + " — it has no place on the map, so it is not a feature");
      state.pts = [];
      paint(state);
      return;
    }

    const sp = px.map(p => toSP(st.sheet, p[0], p[1]));
    const prov = { source: "sheet", sheet: st.sheet, px };
    let f = null;
    if (tool === "point") {
      f = SBMM.tools.dropSpot(sp[0][0], sp[0][1]);
      f.name = st.sheet + " point";
    } else if (tool === "note") {
      const txt = prompt("Note on " + st.sheet + ":", "");
      if (txt == null || !txt.trim()) { setTool(state, null); return; }
      f = SBMM.tools.mkText([sp[0]], txt.trim(), { size_ft: 20 });
    } else if (tool === "distance" || tool === "line") {
      f = SBMM.tools.rebuildFeature({ type: "line", pts: sp,
        name: SBMM.tools.nextName(st.sheet + " line") });
    } else if (tool === "area" || tool === "polygon") {
      f = SBMM.tools.rebuildFeature({ type: "area", pts: sp,
        name: SBMM.tools.nextName(st.sheet + " area") });
    }
    if (!f) { setTool(state, null); return; }

    f.props = f.props || {};
    f.props.provenance = prov;
    f.group = f.group || ("Sheets/" + st.sheet);
    SBMM.store.addGroup("Sheets/" + st.sheet);
    SBMM.store.setGroup(f, "Sheets/" + st.sheet);
    SBMM.store.select(f.id);
    SBMM.store.emit();
    SBMM.store.autosave();

    state.pts = [];
    paint(state);
    const ff = ftPerPx(st.sheet);
    const len = sp.length > 1 ? lineLength(sp) : 0;
    toast(`${f.name} added from ${st.sheet}`
      + (len ? ` — ${fmt(len, 1)} ft` : "")
      + ` · it is on the map and in 3D now`, 3600);
    status(state, null);
    if (tool === "point" || tool === "note") setTool(state, null);
  }

  /* ------------------------------------------------------------------ */
  /* painting: the in-progress sketch, plus the store seen through the   */
  /* inverse affine                                                      */
  /* ------------------------------------------------------------------ */
  function paint(state) {
    if (!state || !state.canvas) return;
    const st = state.st, cv = state.canvas, g = state.ctx;
    const w = st.view.clientWidth, h = st.view.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    if (state.geo) paintStore(state, g);

    /* the in-progress sketch */
    const P = state.pts;
    if (P.length) {
      const closed = state.tool === "area" || state.tool === "polygon";
      const pv = P.map(p => pxToView(state, p[0], p[1]));
      g.lineWidth = 1.6;
      g.strokeStyle = "#FFD34D";
      g.setLineDash([6, 5]);
      g.beginPath();
      pv.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
      if (state.cursor) {
        const c = pxToView(state, state.cursor[0], state.cursor[1]);
        g.lineTo(c[0], c[1]);
        if (closed && pv.length > 1) g.lineTo(pv[0][0], pv[0][1]);
      } else if (closed && pv.length > 2) g.closePath();
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = "#1B2429";
      for (const p of pv) {
        g.beginPath(); g.arc(p[0], p[1], 3.5, 0, 6.2832);
        g.fill(); g.stroke();
      }
    }
  }

  /* Every store feature whose State Plane geometry falls on this sheet, drawn
     where the affine says it belongs. This is what makes the window a view of
     the model rather than a picture: a line measured on the map shows up on the
     drawing it crosses. */
  function paintStore(state, g) {
    const st = state.st;
    const W = st.iw, H = st.ih;
    const sel = SBMM.store.selected;
    g.lineWidth = 2;
    for (const f of SBMM.store.features) {
      if (f.visible === false || !f.pts || !f.pts.length) continue;
      if (f.type === "surface" || f.type === "sections") continue;
      const pv = [];
      let any = false;
      for (const p of f.pts) {
        const q = toPx(st.sheet, p[0], p[1]);
        if (!q) { pv.length = 0; break; }
        if (q[0] >= -50 && q[1] >= -50 && q[0] <= W + 50 && q[1] <= H + 50) any = true;
        pv.push(pxToView(state, q[0], q[1]));
      }
      if (!any || !pv.length) continue;
      const own = f.props && f.props.provenance && f.props.provenance.sheet === st.sheet;
      g.strokeStyle = f.id === sel ? "#FFD34D" : (own ? "#7CD0E6" : "rgba(124,208,230,.55)");
      g.fillStyle = g.strokeStyle;
      if (pv.length === 1) {
        g.beginPath(); g.arc(pv[0][0], pv[0][1], 4, 0, 6.2832); g.fill();
        if (f.type === "text" && f.props && f.props.text) {
          g.font = "12px Helvetica, Arial, sans-serif";
          g.fillText(f.props.text, pv[0][0] + 7, pv[0][1] - 5);
        }
        continue;
      }
      g.beginPath();
      pv.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
      if (f.type === "area" || f.type === "volume") g.closePath();
      g.stroke();
    }
  }

  /* ------------------------------------------------------------------ */
  function locate3d(sheet) {
    const s = SBMM.sheets.get(sheet);
    if (!s || !s.bounds) { toast(sheet + " has no footprint to frame"); return; }
    const [x0, y0, x1, y1] = s.bounds;
    const go = () => SBMM.viewer3d.frameBox(x0, y0, x1, y1);
    if (SBMM.viewer3d.isOpen()) go();
    else SBMM.viewer3d.openAt((x0 + x1) / 2, (y0 + y1) / 2).then(go, go);
  }

  /* Features that came off a sheet, for the report and for anything that wants
     to say where a number came from. */
  function fromSheet(sheet) {
    return SBMM.store.features.filter(f => {
      const p = f.props && f.props.provenance;
      return p && p.source === "sheet" && (!sheet || p.sheet === sheet);
    });
  }

  /* Esc arbitration, called from js/sheets.js's capture-phase handler. Returns
     true when a sheet window consumed the key, which is what stops the window
     from closing under a sketch. The topmost window wins, matching the z-order
     the user is looking at. */
  function onEscape() {
    let best = null;
    for (const s of live) {
      if (!s.tool && !s.pts.length) continue;
      if (!best || (+s.st.el.style.zIndex || 0) > (+best.st.el.style.zIndex || 0)) best = s;
    }
    if (!best) return false;
    if (best.pts.length) { best.pts = []; paint(best); status(best, "cancelled"); }
    else setTool(best, null);
    return true;
  }

  function wire() { /* nothing global — everything is per window */ }

  return { wire, attach, detach, resheet, onEscape, paint: st => paint(S.get(st)),
           affineOf, georeferenced, toSP, toPx, ftPerPx, fromSheet,
           activeCount: () => [...live].filter(s => s.tool).length,
           state: st => S.get(st) };
})();
