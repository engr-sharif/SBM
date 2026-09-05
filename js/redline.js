/* SBMM Site Explorer — REDLINE: freehand ink, on the map and on a drawing.
   docs/V17_TOUCH_SPEC.md §5a ("fully utilize the iPad pencil, that is a must").

   Everything else in this app is a MEASUREMENT — a distance, an area, a volume,
   a traced flow path — and every one of them is a small number of deliberate
   vertices. Redlining is the other half of how an engineer marks up a drawing:
   a circle round the thing that is wrong and an arrow to the note. The Pencil
   is what makes it worth having, and the two things that make it feel like a
   pencil rather than a polyline tool are:

     * EVENT RESOLUTION. `getCoalescedEvents()` hands back every pointer sample
       the OS captured between two frames — on an iPad that is 120-240 Hz
       against the 60 the render loop sees. Without it a fast stroke is a
       polygon; with it, it is a curve.
     * PRESSURE. `e.pressure` is 0-1 (0.5 for a finger or a mouse, which have
       none), and the width it drives is stored PER VERTEX so a stroke redrawn
       from a session file is the stroke that was made, not an average of it.

   An `ink` stroke is an ordinary store feature, and that is the whole design:
   it appears in My work, serialises into the session (v9, additive), exports to
   GeoJSON as a LineString and to DXF on a `REDLINE` layer, drapes in 3D, prints
   in the report, and is one undo entry per stroke. It carries the same
   `props.provenance` a sheet mark does when it was drawn on a drawing, so a
   circle drawn on C-107 knows which sheet it came off.

   Five places carry a FeatureGroup type in this app (js/tools.js `layerFor`,
   `applyStyle`, `redraw`, `relayer`, `rebuildFeature`) and `ink` is in all five,
   exactly as `flow` and `photo` are.

   NOT a raster. An ink stroke is geometry in State Plane feet, so it stays put
   when the map zooms, exports to CAD, and can be measured. A painted bitmap
   would do none of that. */
"use strict";

SBMM.redline = (function () {

  /* §5a: six swatches and an eraser. Red is the default because a redline is
     red — that is where the word comes from. */
  const SWATCHES = [
    ["#E4433A", "red"], ["#FF9A2E", "orange"], ["#FFD34D", "yellow"],
    ["#5FBF8F", "green"], ["#55C1FF", "blue"], ["#F0F4F6", "white"]
  ];
  const W_MIN = 1.5, W_MAX = 5;          // screen px at pressure 0 and 1
  const SIMPLIFY_PX = 0.5;               // ring-aware, on pen-up
  const STORE = "sbmm.redline.v1";

  let colour = SWATCHES[0][0];
  let eraser = false;
  let live = null;                       // the stroke in progress
  let palette = null;

  /* ================================================================== */
  /* preferences                                                         */
  /* ================================================================== */
  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(STORE) || "null");
      if (o && typeof o.colour === "string") colour = o.colour;
    } catch (e) {}
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify({ colour })); } catch (e) {} }

  /* ================================================================== */
  /* the feature                                                         */
  /* ================================================================== */
  /* Rebuilt from props and NEVER recomputed — the rule `flow` and `photo`
     already follow. A session load must not go looking for a pointer. */
  function mkInk(pts, name, props, spec) {
    const f = SBMM.tools.newFeature("ink", pts.map(p => p.slice()), name || "Redline",
      { group: (spec && spec.group) || "Redline", style: spec && spec.style, locked: spec && spec.locked });
    f.props = Object.assign({}, props || {});
    if (!Array.isArray(f.props.widths) || f.props.widths.length !== pts.length)
      f.props.widths = pts.map(() => 1);
    f.props.color = f.props.color || colour;
    build(f);
    return f;
  }

  /* One polyline per SEGMENT would be thousands of Leaflet layers, so a stroke
     is drawn as a small number of runs of similar width: the eye cannot see a
     0.2-px step and the map can draw 8 polylines. A constant-width stroke (a
     finger, a mouse) collapses to exactly one. */
  const WIDTH_BUCKETS = 6;
  function build(f) {
    if (!f.layer) return;
    f.layer.clearLayers();
    const W = f.props.widths || [];
    const col = (f.style && f.style.color) || f.props.color || colour;
    const sel = SBMM.store.selected === f.id;
    const base = f.props.scale || 1;
    /* the stored width is 0..1 (pressure, or a constant 0.55 for a finger);
       WIDTH_BUCKETS steps across it is finer than the eye resolves and coarse
       enough that a constant-width stroke collapses to ONE polyline */
    const bucket = w => Math.max(0, Math.min(WIDTH_BUCKETS - 1,
      Math.round((w == null ? 0.55 : w) * (WIDTH_BUCKETS - 1))));
    let run = [], last = null;
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      const px = W_MIN + (W_MAX - W_MIN) * (last / (WIDTH_BUCKETS - 1));
      L.polyline(run.map(p => [p[1], p[0]]), {
        pane: "drawings", color: sel ? "#FFD34D" : col,
        weight: Math.max(1, px * base) + (sel ? 1.5 : 0),
        opacity: 0.95, lineCap: "round", lineJoin: "round", interactive: true
      }).addTo(f.layer);
      run = [];
    };
    for (let i = 0; i < f.pts.length; i++) {
      const b = bucket(W[i]);
      if (last === null) last = b;
      if (b !== last) { run.push(f.pts[i]); flush(); last = b; }
      run.push(f.pts[i]);
    }
    flush();
    /* the click target: one invisible fat line over the whole stroke, so a
       stroke drawn at 1.5 px can still be selected with a thumb */
    L.polyline(f.pts.map(p => [p[1], p[0]]), {
      pane: "drawings", color: col, weight: 18, opacity: 0, interactive: true
    }).addTo(f.layer).on("click", ev => {
      L.DomEvent.stopPropagation(ev);
      if (eraser && SBMM.mode.current() === "redline") { erase(f); return; }
      SBMM.store.select(f.id);
    });
  }

  function erase(f) {
    if (!f || f.type !== "ink") return false;
    SBMM.tools.deleteFeature(f);
    toast("stroke erased");
    return true;
  }

  /* ================================================================== */
  /* capture                                                             */
  /* ================================================================== */
  /* `host` tells the capture where it is: the MAP (points come out as State
     Plane feet through Leaflet) or a SHEET window (points come out as sheet
     pixels, georeferenced through js/sheetmarks.js's affine exactly as a mark
     is). One capture, two coordinate systems, because a redline on a drawing
     and a redline on the map are the same act. */
  function begin(host, e) {
    live = {
      host, id: e.pointerId, pts: [], widths: [], type: e.pointerType,
      ghost: L.polyline([], { pane: "drawings", color: colour, weight: 2.5,
                              opacity: 0.95, lineCap: "round", lineJoin: "round",
                              interactive: false })
    };
    if (host.kind === "map") live.ghost.addTo(SBMM.map);
    add(e);
  }

  function widthOf(e) {
    /* a finger and a mouse report 0.5 (or 0) and have no pressure to give, so
       they draw at a constant middle width rather than a fake varying one */
    if (e.pointerType !== "pen") return 0.55;
    const p = (e.pressure == null || e.pressure <= 0) ? 0.5 : e.pressure;
    return Math.max(0.05, Math.min(1, p));
  }

  function add(e) {
    if (!live) return;
    /* EVERY sample the OS captured, not one per frame (§5a) */
    const list = (e.getCoalescedEvents && e.getCoalescedEvents().length)
      ? e.getCoalescedEvents() : [e];
    for (const s of list) {
      const p = live.host.toWorld(s.clientX, s.clientY);
      if (!p) continue;
      const n = live.pts.length;
      if (n && Math.abs(p[0] - live.pts[n - 1][0]) < 1e-9 && Math.abs(p[1] - live.pts[n - 1][1]) < 1e-9) continue;
      live.pts.push(p);
      live.widths.push(widthOf(s));
    }
    if (live.host.kind === "map") live.ghost.setLatLngs(live.pts.map(p => [p[1], p[0]]));
    else live.host.paint(live);
  }

  function end(cancel) {
    if (!live) return null;
    const L0 = live;
    live = null;
    if (L0.host.kind === "map" && L0.ghost) SBMM.map.removeLayer(L0.ghost);
    else if (L0.host.repaint) L0.host.repaint();
    if (cancel || L0.pts.length < 2) return null;

    /* simplify at half a SCREEN pixel, through the ring-aware simplifier —
       naive Douglas-Peucker collapses a closed loop, and a redline circle is
       the commonest closed loop anyone draws (CLAUDE.md, the first gotcha) */
    const tol = L0.host.pxToWorld(SIMPLIFY_PX);
    const keep = SBMM_COMPUTE.simplifyPath
      ? SBMM_COMPUTE.simplifyPath(L0.pts.map((p, i) => [p[0], p[1], i]), tol)
      : L0.pts.map((p, i) => [p[0], p[1], i]);
    const pts = keep.map(p => [p[0], p[1]]);
    const widths = keep.map(p => L0.widths[p[2]] == null ? 0.55 : L0.widths[p[2]]);

    const props = { color: colour, widths, pen: L0.type === "pen" };
    if (L0.host.provenance) props.provenance = L0.host.provenance(keep.map(p => p[2]), L0);
    if (L0.host.scale) props.scale = L0.host.scale();

    const f = mkInk(pts, "Redline", props, {});
    SBMM.undo.push("redline stroke",
      () => SBMM.store.remove(f),
      () => { SBMM.store.readd(f); build(f); });
    SBMM.store.emit();
    SBMM.store.autosave();
    return f;
  }

  /* ================================================================== */
  /* the map host                                                        */
  /* ================================================================== */
  const mapHost = {
    kind: "map",
    toWorld(x, y) {
      const p = SBMM.map.mouseEventToContainerPoint({ clientX: x, clientY: y });
      const ll = SBMM.map.containerPointToLatLng(p);
      return [ll.lng, ll.lat];
    },
    pxToWorld(px) { return px / Math.max(1e-6, Math.pow(2, SBMM.map.getZoom())); }
  };

  /* ================================================================== */
  /* the palette                                                         */
  /* ================================================================== */
  function ensurePalette() {
    if (palette) return palette;
    palette = document.createElement("div");
    palette.id = "inkPal";
    palette.hidden = true;
    palette.innerHTML = SWATCHES.map(([c, n]) =>
      `<button type="button" class="inksw" data-ink="${c}" title="${n}" style="background:${c}"></button>`).join("")
      + `<button type="button" class="inksw inkerase" data-ink="erase" title="Eraser — tap a stroke to delete it">⌫</button>`;
    document.body.appendChild(palette);
    palette.addEventListener("click", e => {
      const b = e.target.closest("[data-ink]");
      if (!b) return;
      if (b.dataset.ink === "erase") {
        eraser = !eraser;
        toast(eraser ? "eraser — tap a stroke to delete it" : "redline — draw with the pen or a finger");
      } else {
        colour = b.dataset.ink;
        eraser = false;
        save();
      }
      paintPalette();
    });
    return palette;
  }
  function paintPalette() {
    if (!palette) return;
    palette.querySelectorAll(".inksw").forEach(b => {
      const k = b.dataset.ink;
      b.classList.toggle("on", k === "erase" ? eraser : (!eraser && k === colour));
    });
  }
  function showPalette(on) {
    ensurePalette().hidden = !on;
    if (on) paintPalette();
  }

  /* ================================================================== */
  /* arming                                                              */
  /* ================================================================== */
  /* REDLINE is a MODE, like every other tool (docs/V9_SPEC.md §2): Esc returns
     to Navigate and tears it down, and the mode machine owns the highlight. */
  function arm(on) {
    if (on) {
      showPalette(true);
      /* a one-finger drag has to draw rather than pan while the tool is armed —
         the same trade the sketch's press-hold makes */
      if (SBMM.map.dragging && SBMM.map.dragging.enabled()) {
        SBMM.map._inkDragWas = true;
        SBMM.map.dragging.disable();
      }
      toast(eraser ? "eraser — tap a stroke to delete it"
                   : "redline — draw with the Pencil or a finger · Esc when done", 3600);
    } else {
      end(true);
      showPalette(false);
      if (SBMM.map._inkDragWas) { SBMM.map.dragging.enable(); SBMM.map._inkDragWas = false; }
    }
    return on;
  }
  function armed() { return SBMM.mode && SBMM.mode.current() === "redline"; }

  /* ================================================================== */
  function wire() {
    load();
    const host = SBMM.map && SBMM.map.getContainer && SBMM.map.getContainer();
    if (!host) return;

    host.addEventListener("pointerdown", e => {
      if (!armed() || eraser) return;
      if (e.pointerType === "touch" && SBMM.touch && SBMM.touch.penRecent()) return;  // palm
      if (live) return;
      e.preventDefault();
      begin(mapHost, e);
    }, true);
    host.addEventListener("pointermove", e => {
      if (!live || live.host.kind !== "map" || e.pointerId !== live.id) return;
      e.preventDefault();
      add(e);
    }, true);
    const up = e => {
      if (!live || live.host.kind !== "map" || e.pointerId !== live.id) return;
      end(e.type === "pointercancel");
    };
    host.addEventListener("pointerup", up, true);
    host.addEventListener("pointercancel", up, true);

    /* the mode machine turns the tool on and off; nothing else may */
    SBMM.events.on("mode", ({ from, to }) => {
      if (to === "redline") arm(true);
      else if (from === "redline") arm(false);
    });
  }

  return {
    wire, mkInk, build, arm, armed, erase,
    /* the sheet-window host is built by js/sheetmarks.js, which owns the
       affine; this is the capture it hands the strokes to */
    begin, add, end, live: () => live,
    colour: v => { if (v) { colour = v; eraser = false; save(); paintPalette(); } return colour; },
    eraser: v => { if (v !== undefined) { eraser = !!v; paintPalette(); } return eraser; },
    SWATCHES, showPalette, palette: () => palette
  };
})();
