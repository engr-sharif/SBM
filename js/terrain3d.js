/* SBMM Site Explorer — the quadtree terrain (v20 §3, §4).

   WHAT REPLACED WHAT
   ------------------
   Until v20 the 3D view built ONE mesh per DEM, decimated by
   strideFor(dem, 640 | 1100), and draped each with ONE texture — so the 1-ft
   data was never drawn at 1 ft (the ABP mesh sampled every 4th foot) and the
   ABP drape was an 11488 x 15528 canvas composited on the main thread. Here a
   quadtree of 256 x 256 tiles is selected per view by screen-space error, so
   the 1 ft data IS drawn at 1 ft when the camera is close enough to see it,
   each tile carries its own drape from the ortho pyramid, and the far half of
   the site costs a few hundred triangles instead of a million.

   The tiles come from SBMM.tiles, which answers over file://, over http and
   inside a single-file build. THE ANALYSIS GRIDS ARE NOT TOUCHED: SBMM.elev /
   demAt / demForBox / dems, drapeZ, every kernel and every golden go on
   reading the same three whole-site grids they always did. This file is the
   display source and nothing more (docs/V20_TERRAIN_SPEC.md §2, "the seams").

   SIX THINGS HERE ARE TRAPS
   -------------------------
   1. A TILE'S PIXELS DO NOT REACH ITS EDGE. Pixel i sits at x0 + i*cell, so
      pixel 255 is one cell short of the tile's east edge and two abutting
      tiles would leave a cell-wide HOLE between them, not a crack. The mesh is
      therefore 257 x 257: the extra row and column sit ON the tile edge and
      take the last pixel's value. Tiles then abut exactly and the only
      disagreement left is one cell of relief, which the skirts hide.
   2. THE DESCENT RULE IS "ALL FOUR CHILDREN EXIST", never "some do". That is
      the same coverage rule the old whole-DEM meshes used (a coarse mesh holed
      by the UNION of the finer windows) expressed per tile, and it is exact
      only because tools/build_tiles.py writes a level-0 tile only when the
      whole square is inside the 1-ft windows. test/tiles.mjs guards that.
   3. THE DRAWN SET IS SWAPPED WHOLE. A partially loaded set would draw a
      coarse tile over its own children (z-fighting) or leave a hole. So the
      new set is built beside the old one and the swap happens once every tile
      of it is in hand; until then the previous set stays on screen.
   4. THE SELECTION RUNS ON A SETTLED CAMERA, NOT PER FRAME. The render loop
      asks for a frame only when something moved; a per-frame reselect would
      make an idle view render for ever and test/perf.mjs fails exactly that.
      update() also returns without requesting a frame when the drawn set has
      not changed — the same reason.
   5. THE GPU RASTER IS DISPLAY ONLY. The shader computes hillshade, slope,
      aspect and display contours from the tile's own DEM; the analytic
      contours (contoursFromGrid, what goes into a DXF) and every kernel stay
      on the CPU and remain the source of truth. Without WebGL2 the CPU path
      answers instead and says so.
   6. THE DEM GOES TO THE GPU AS TERRAIN-RGB BYTES, not as a float texture.
      A float texture needs WebGL2 plus a filtering extension and buys nothing
      at NEAREST; the two bytes the app already encodes decode exactly in the
      shader, so the same texture works on WebGL1 and cannot disagree with
      js/dem.js about what a pixel means. */
"use strict";

SBMM.terrain3d = (function () {

  const N = 256;                    // tile pixels
  const MAX_TILES = 40;
  const MAX_VERTS = 3.2e6;

  /* QUALITY DRIVES TWO THINGS, AND IT HAS TO DRIVE BOTH.
     The level a tile is selected at is a function of the CAMERA, so at some
     views 4 px and 2 px legitimately pick the same set — and "standard is
     coarser than high" then stops being true, which e2e block 9a-2 asserts and
     which a user changing the setting is entitled to see. So the per-tile
     vertex stride is quality's too: standard samples every 2nd pixel of the
     tile (129 x 129), high and ultra every pixel (257 x 257). Since a coarser
     target can never select MORE tiles, standard is now strictly fewer
     vertices than high at every camera, by construction rather than by luck. */
  function meshStep(targetPx) { return targetPx >= 4 ? 2 : 1; }
  function vertsPerSide(step) { return N / step + 1; }

  let ctx = null;                   // set by attach()
  /* v20 §3, and the reason is in js/viewer3d.js at the call site: a finger on
     the glass suspends tile work, because js/touch.js's recogniser decides
     what a gesture WAS from wall clock, and work that started before the
     finger landed goes on blocking the thread after it. */
  let suspended = false;
  let style = "ortho";
  let sunAz = 315, sunEl = 35;
  const drawn = new Map();          // key -> record, what is in the scene now
  let generation = 0, busy = false, again = false;
  let lastSig = "";
  let webgl2 = false, gpuRaster = false, gpuNoted = false;
  let rampTex = {};
  /* `lastBuildMs` is WALL time across the whole build — it includes the yields
     between tiles and every await, so it is not the hitch. THE HITCH IS THE
     LONGEST SYNCHRONOUS SPAN, because that is what blocks a gesture and what a
     longtask observer sees, and it is measured here rather than inferred: the
     build yields between tiles, so each tile's own work is one span.
     `lastBuildBlockMs` is the largest of them and `lastBuildCpuMs` their sum
     (v22 §G — test/perf.mjs reports both before and after). */
  const stat = { selects: 0, swaps: 0, lastSelectMs: 0, lastBuildMs: 0, lastLoadMs: 0,
                 lastBuildBlockMs: 0, lastBuildCpuMs: 0, lastBuildTiles: 0,
                 lastDrapeMs: 0, geomHits: 0, geomMisses: 0, geomEvicted: 0,
                 raisedFor: 0, cpuFallbacks: 0 };

  const available = () => !!(SBMM.tiles && SBMM.tiles.ready() && SBMM.tiles.layerInfo("dem"));

  /* ------------------------------------------------------------- shaders -- */
  /* One material per tile, sharing one program. `uMode`: 0 hillshade,
     1 slope, 2 aspect, 3 elevation tint. The relief term is the same in all
     four so the sun control relights every style at once (v15 asked for that
     and the CPU rasters could never do it). */
  /* FOG ON A ShaderMaterial IS NOT FREE, and getting it wrong throws once per
     frame rather than looking wrong. `fog: true` makes three call
     refreshUniformsFog(), which writes `uniforms.fogColor.value` — and a
     ShaderMaterial's uniforms are ONLY what the author supplied, so without
     THREE.UniformsLib.fog merged in that is "Cannot read properties of
     undefined (reading 'value')" inside renderBufferDirect, every draw, in
     every shader drape style. (test/terrain_shots.mjs found it; the e2e never
     switches the drape to a shader style with the scene fog on.) The chunks
     below are three's own, so the terrain fades into the horizon exactly as
     the ortho drape and everything else in the scene does. */
  const VERT = `
    #include <common>
    #include <fog_pars_vertex>
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const FRAG = `
    precision highp float;
    #include <common>
    #include <fog_pars_fragment>
    varying vec2 vUv;
    uniform sampler2D uDem;
    uniform sampler2D uRamp;
    uniform float uCell, uZmin, uStep, uTexel, uZlo, uZhi, uContour, uOpacity;
    uniform float uSunAz, uSunEl;
    uniform int uMode;
    /* terrain-RGB, byte for byte the encoding js/dem.js decodes:
       v = R*256 + G, z = zmin + (v-1)*step, v == 0 is NoData */
    float zAt(vec2 uv) {
      vec4 c = texture2D(uDem, uv);
      float v = floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
      if (v < 0.5) return -1.0e9;
      return uZmin + (v - 1.0) * uStep;
    }
    vec3 hsl(float h, float s, float l) {
      vec3 k = mod(vec3(0.0, 8.0, 4.0) + h * 12.0, 12.0);
      return l - s * min(l, 1.0 - l) * clamp(min(k - 3.0, 9.0 - k), -1.0, 1.0);
    }
    void main() {
      float t = uTexel;
      float zc = zAt(vUv);
      if (zc < -1.0e8) discard;                      /* NoData is a hole, as in 2D */
      float zl = zAt(vUv + vec2(-t, 0.0)), zr = zAt(vUv + vec2(t, 0.0));
      float zd = zAt(vUv + vec2(0.0, -t)), zu = zAt(vUv + vec2(0.0, t));
      /* a NoData neighbour substitutes the centre — the same rule Dem.slopeAspect uses */
      zl = zl < -1.0e8 ? zc : zl; zr = zr < -1.0e8 ? zc : zr;
      zd = zd < -1.0e8 ? zc : zd; zu = zu < -1.0e8 ? zc : zu;
      float dzdx = (zr - zl) / (2.0 * uCell);
      float dzdy = (zu - zd) / (2.0 * uCell);
      float slope = atan(length(vec2(dzdx, dzdy)));           /* radians */
      float aspect = atan(dzdx, dzdy);                        /* 0 = +Y = grid north */
      if (aspect < 0.0) aspect += 6.2831853;
      float az = radians(uSunAz), el = radians(uSunEl);
      /* the standard hillshade: cos of the angle between the surface normal
         and the sun. azimuth is the direction the light comes FROM. */
      float hs = clamp(sin(el) * cos(slope)
                     + cos(el) * sin(slope) * cos(az - aspect), 0.0, 1.0);
      vec3 col;
      if (uMode == 0) {
        col = vec3(0.06, 0.07, 0.08) + vec3(0.94, 0.93, 0.92) * hs;
      } else if (uMode == 1) {
        col = texture2D(uRamp, vec2(clamp(degrees(slope) / 45.0, 0.0, 1.0), 0.5)).rgb;
        col *= 0.55 + 0.45 * hs;
      } else if (uMode == 2) {
        col = degrees(slope) < 0.5 ? vec3(0.431, 0.455, 0.475)
                                   : hsl(degrees(aspect) / 360.0, 0.55, 0.55);
        col *= 0.55 + 0.45 * hs;
      } else {
        col = texture2D(uRamp, vec2(clamp((zc - uZlo) / max(1e-6, uZhi - uZlo), 0.0, 1.0), 0.5)).rgb;
        col *= 0.5 + 0.5 * hs;
      }
      if (uContour > 0.0) {
        /* display contours, anti-aliased by the screen-space derivative of the
           elevation itself. The DXF contours are still contoursFromGrid's. */
        float f = abs(fract(zc / uContour - 0.5) - 0.5) * uContour;
        float w = max(1e-4, length(vec2(dFdx(zc), dFdy(zc))));
        col = mix(vec3(0.05, 0.06, 0.07), col, clamp(f / w - 0.5, 0.0, 1.0));
      }
      gl_FragColor = vec4(col, uOpacity);
      #include <fog_fragment>
    }`;

  const MODE = { hillshade: 0, slope: 1, aspect: 2, hypso: 3 };

  function ramp(name) {
    if (rampTex[name]) return rampTex[name];
    const stops = (typeof RAMPS !== "undefined" && RAMPS[name]) || [[0, 0, 0], [255, 255, 255]];
    const px = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const c = lerpRamp(stops, i / 255);
      px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
    }
    const t = new THREE.DataTexture(px, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    rampTex[name] = t;
    return t;
  }

  /* Float32 heights (row 0 = south) -> the terrain-RGB bytes the shader reads.
     A DataTexture's row 0 is v = 0, which is the south edge, so the array goes
     up as it is: the same way round as the mesh. */
  function demTexture(z32, zmin, step) {
    const px = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) {
      const v = z32[k];
      const q = isNaN(v) ? 0 : Math.max(0, Math.min(65535, Math.round((v - zmin) / step) + 1));
      px[k * 4] = q >> 8; px[k * 4 + 1] = q & 255; px[k * 4 + 2] = 0; px[k * 4 + 3] = 255;
    }
    const t = new THREE.DataTexture(px, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.NearestFilter;   // exact bytes, never a blend
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  function rasterMaterial(rec, kind) {
    const L = SBMM.tiles.layerInfo("dem") || {};
    const zr = ctx.zRange();
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
        uDem: { value: rec.demTex },
        uRamp: { value: ramp(kind === "slope" ? "slope" : "hypso") },
        uCell: { value: SBMM.tiles.cellOf(rec.z) },
        uZmin: { value: L.zmin != null ? L.zmin : 1325 },
        uStep: { value: L.step != null ? L.step : 0.02 },
        uTexel: { value: 1 / N },
        uZlo: { value: zr[0] }, uZhi: { value: zr[1] },
        uContour: { value: 0 },
        uOpacity: { value: 1 },
        uSunAz: { value: sunAz }, uSunEl: { value: sunEl },
        uMode: { value: MODE[kind] == null ? 0 : MODE[kind] }
      }),
      fog: true
    });
    m.extensions = { derivatives: true };       // dFdx/dFdy for the contour width
    return m;
  }

  /* ---------------------------------------------------------- the drape --- */
  /* The tile's own ortho, or the nearest coarser ancestor with the sub-window
     picked out through offset/repeat. Walking up rather than giving up is what
     lets the ortho pyramid stop at 2 ft over most of the site while the DEM
     goes to 1 ft. This is the FLOOR of the drape — whatever else happens there
     is imagery here — and drapePlan() below is what makes it sharp. */
  function orthoRef(z, x, y) {
    for (let k = 0; k <= 6; k++) {
      const za = z + k, xa = x >> k, ya = y >> k;
      if (!SBMM.tiles.levelInfo("ortho", za)) continue;
      if (SBMM.tiles.has("ortho", za, xa, ya)) return { z: za, x: xa, y: ya, k };
      /* only the site-wide levels are guaranteed; a missing one means no imagery */
    }
    return null;
  }

  /* v22 §G — the FINER ortho tiles that cover this terrain tile.

     `k` levels down means 4^k ortho tiles composited into one 256*2^k px
     image. k comes from the profile (js/viewer3d.js drapeK), and is then
     capped by the pyramid: the deepest level that exists AND has at least one
     tile over this square wins, so the mine window drapes from the 1-ft ortho
     and the rest of the site from the 2-ft one without either being asked for.
     Returns null when nothing finer than the tile's own level exists, and the
     single-texture path above answers instead. */
  function drapePlan(z, x, y) {
    if (!SBMM.tiles.levels("ortho").length) return null;
    const kMax = Math.min(ctx.drapeK ? ctx.drapeK() : 0, z);
    for (let k = kMax; k >= 1; k--) {
      const zf = z - k;
      if (!SBMM.tiles.levelInfo("ortho", zf)) continue;
      const n = 1 << k, list = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const fx = x * n + i, fy = y * n + j;
        if (SBMM.tiles.has("ortho", zf, fx, fy)) list.push([fx, fy, i, j]);
      }
      if (list.length) return { z: zf, k, n, list };
    }
    return null;
  }

  /* Fetch every image a drape needs. Async and started for the whole set at
     once, so the composite below is pure canvas work with nothing to wait for
     — the drawImage calls then land inside the build loop, which yields
     between tiles, instead of in one block after it. */
  async function drapeFetch(z, x, y) {
    if (style !== "ortho") return null;
    const plan = drapePlan(z, x, y), ref = orthoRef(z, x, y);
    const g = (zz, xx, yy) => SBMM.tiles.get("ortho", zz, xx, yy, { priority: 1 }).catch(() => null);
    const baseP = ref ? g(ref.z, ref.x, ref.y) : Promise.resolve(null);
    const fineP = plan ? Promise.all(plan.list.map(t => g(plan.z, t[0], t[1]))) : Promise.resolve([]);
    const [base, fine] = await Promise.all([baseP, fineP]);
    return { plan, ref, base, fine };
  }

  /* Compose one drape. SYNCHRONOUS on purpose — it is measured as one block.
     Canvas row 0 is the tile's NORTH edge, which is how the tile payloads are
     written and what texFromImage's flipY expects; tile y increases north, so
     a sub-tile at row j of the plan lands at canvas row (n - 1 - j). */
  function drapeCompose(z, x, y, got) {
    if (!got) return null;
    const { plan, ref, base, fine } = got;
    if (!plan || !fine.some(Boolean)) {
      /* nothing finer exists — the v20 path, one shared tile texture with the
         sub-window picked out, and no canvas allocated at all */
      if (!base || !base.img) return null;
      if (!base.tex) base.tex = texFromImage(base.img);
      const tex = base.tex.clone();
      tex.needsUpdate = true;
      const s = 1 / Math.pow(2, ref.k);
      tex.repeat.set(s, s);
      tex.offset.set((x - ref.x * Math.pow(2, ref.k)) * s, (y - ref.y * Math.pow(2, ref.k)) * s);
      return { tex, px: N, ftPerPx: SBMM.tiles.cellOf(ref.z), composed: false };
    }
    const side = N * plan.n;
    const cv = document.createElement("canvas");
    cv.width = cv.height = side;
    const g2 = cv.getContext("2d");
    /* the coarse ancestor first, stretched over the whole square, so a tile at
       the edge of the fine imagery has no hole in it */
    if (base && base.img) {
      const s = Math.pow(2, ref.k), sw = N / s;
      const sx = (x - ref.x * s) * sw;
      const sy = ((ref.y * s + s - 1) - y) * sw;
      try { g2.drawImage(base.img, sx, sy, sw, sw, 0, 0, side, side); } catch (e) { /* rounding */ }
    }
    for (let i = 0; i < plan.list.length; i++) {
      const t = plan.list[i], im = fine[i];
      if (!im || !im.img) continue;
      try { g2.drawImage(im.img, t[2] * N, (plan.n - 1 - t[3]) * N, N, N); } catch (e) { /* rounding */ }
    }
    return { tex: texFromImage(cv), px: side, ftPerPx: SBMM.tiles.cellOf(plan.z), composed: true };
  }

  function texFromImage(img) {
    const t = img instanceof HTMLCanvasElement ? new THREE.CanvasTexture(img) : new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = true;                    // image row 0 = north, uv v = 0 = south
    t.needsUpdate = true;
    t.anisotropy = ctx.maxAniso ? ctx.maxAniso() : 1;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  /* ------------------------------------------------------------ geometry -- */
  /* 257 x 257 (trap 1) plus a skirt: a copy of the border ring dropped below
     the surface, so the seam between two levels is covered by geometry rather
     than by luck.

     THE LOOP ITSELF MOVED OUT IN v22 §G. It is `demTileMeshMain` in js/dem.js
     now — ONE function, stringified into the tile-decode worker beside the
     terrain-RGB loop and called inline when there is no worker — so a tile's
     geometry is built off the main thread and there is no second
     implementation to drift from. What is left here is the part that has to be
     on the main thread: wrapping the typed arrays in a BufferGeometry (which
     copies nothing) and the cache. */
  function meshArgs(z, x, y, step) {
    const cell = SBMM.tiles.cellOf(z);
    const r = SBMM.tiles.rect(z, x, y);
    const { CX, CY, ZMID } = ctx.center();
    return { N, V: vertsPerSide(step), step, cell,
             x0: r[0] - CX, y0: r[1] - CY, zmid: ZMID,
             drop: Math.max(8, cell * step * 3) };
  }
  function geomFromMesh(m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(m.uv, 2));
    g.setAttribute("normal", new THREE.BufferAttribute(m.nrm, 3));
    g.setIndex(new THREE.BufferAttribute(m.idx.subarray(0, m.ni), 1));
    g.computeBoundingSphere();
    return { geom: g, verts: m.verts, side: m.side, tris: m.ni / 3, zlo: m.zlo, zhi: m.zhi,
             bytes: m.pos.byteLength, allBytes: m.pos.byteLength + m.uv.byteLength
                                               + m.nrm.byteLength + m.idx.byteLength };
  }
  /* the main-thread reference, kept for the harness and for a browser with no
     worker at all — the same function the worker runs */
  function buildGeometrySync(z32, z, x, y, step) {
    const m = Dem.tileMesh(Object.assign(meshArgs(z, x, y, step), { z32 }));
    return m ? geomFromMesh(m) : null;
  }

  /* THE GEOMETRY CACHE (v22 §G). A tile's geometry depends on the tile, the
     vertex stride and nothing else — not on the style, not on the drape, not
     on the camera — so returning to a view a moment later must rebuild
     nothing. Keyed by (z, x, y, step), evicted least-recently-used against a
     byte budget, and an entry that is IN THE DRAWN SET is never evicted (that
     would pull the geometry out from under a mesh on screen).

     It holds the BufferGeometry itself rather than the arrays, so a return
     costs neither the loop nor a re-upload to the GPU; the cache owns the
     disposal, which is why dispose() below leaves a cached geometry alone. */
  const geomCache = new Map();
  let geomBytes = 0, geomClock = 0, geomBudgetOverride = 0;
  function geomBudget() {
    if (geomBudgetOverride) return geomBudgetOverride;
    if (SBMM.lowMem && SBMM.lowMem()) return 40e6;
    return document.body.classList.contains("touch") ? 80e6 : 220e6;
  }
  function geomTrim() {
    const budget = geomBudget();
    if (geomBytes <= budget) return;
    const all = [...geomCache.values()].sort((a, b) => a.used - b.used);
    for (const r of all) {
      if (geomBytes <= budget * 0.85) break;
      if (r.live) continue;
      geomCache.delete(r.key);
      geomBytes -= r.allBytes;
      stat.geomEvicted++;
      r.geom.dispose();
    }
  }
  function geomClear() {
    for (const r of geomCache.values()) r.geom.dispose();
    geomCache.clear(); geomBytes = 0;
  }

  /* ----------------------------------------------------------- selection -- */
  /* THE DESCENT RULE, and getting it wrong is silent.

     On a NOT-partial level an absent child means the ground there is absent
     too — the parent is the same samples, coarser — so descending as soon as
     ONE child exists loses nothing and the empty quadrants are simply skipped.
     On a PARTIAL level (dem z0: written only where the 1-ft windows cover the
     whole square) an absent child means the FINE data does not reach there
     while the parent still has ground, so all four are required or a strip of
     terrain disappears.

     Requiring all four everywhere was tried first, and the quadtree then drew
     nothing but its 64-ft root: level 5 has three tiles, not four, because the
     fourth is entirely off the survey. tools/build_tiles.py sets `partial` and
     documents it; test/tiles.mjs guards the level-0 half of it. */
  function canDescend(z, x, y) {
    const cz = z - 1;
    const li = SBMM.tiles.levelInfo("dem", cz);
    if (!li) return false;
    const T = SBMM.tiles;
    const q = [[x * 2, y * 2], [x * 2 + 1, y * 2], [x * 2, y * 2 + 1], [x * 2 + 1, y * 2 + 1]];
    let n = 0;
    for (const [cx, cy] of q) if (T.has("dem", cz, cx, cy)) n++;
    return li.partial ? n === 4 : n > 0;
  }

  const _box = new THREE.Box3(), _v = new THREE.Vector3(), _m4 = new THREE.Matrix4();
  const _frustum = new THREE.Frustum();

  function select(targetPx) {
    const T = SBMM.tiles;
    const lv = T.levels("dem");                        // coarsest first
    const zMax = lv[0], zMin = lv[lv.length - 1];
    const cam = ctx.camera, zx = ctx.exag();
    const { CX, CY, ZMID } = ctx.center();
    const zr = ctx.zRange();
    /* A canvas that has not been laid out yet reports 0 or a few pixels, and
       every tile then satisfies the error bound: the selection comes back as
       the 64-ft root and the view opens on it until the settle timer refines
       it. Clamped, because a selection against a canvas that does not exist
       yet is a guess either way and the useful guess is the one that shows
       terrain. */
    const H = Math.max(240, ctx.renderer.domElement.height || 0);
    const halfTan = Math.tan(cam.fov * Math.PI / 360);
    cam.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const out = [];
    let overflow = false;

    function visit(z, x, y) {
      if (out.length > MAX_TILES) { overflow = true; return; }
      if (!T.has("dem", z, x, y)) return;
      const r = T.rect(z, x, y);
      /* a conservative box: the whole site's elevation range. It culls less
         than a per-tile range would and can never cull something visible,
         which is the only property that matters here. */
      _box.min.set(r[0] - CX, r[1] - CY, (zr[0] - ZMID) * zx - 60);
      _box.max.set(r[2] - CX, r[3] - CY, (zr[1] - ZMID) * zx + 60);
      if (!_frustum.intersectsBox(_box)) return;
      /* The distance the error is measured at is the tile's CENTRE, not its
         nearest corner. Measuring at the nearest corner gives a guaranteed
         bound and costs eight times the geometry for it: a 2,048-ft tile whose
         near corner is 300 ft away is subdivided although its far end is 2,000
         ft away, and the whole subtree is then drawn at full density. Measured
         here it was 2.58 M vertices at 2 px against an ideal of ~0.32 M for the
         viewport. The centre is what a quadtree terrain normally uses; the near
         edge of a tile is under-refined by at most the tile's own half-diagonal
         in distance, which is one level, and the skirts cover the seam. */
      _box.getCenter(_v);
      const d = Math.max(1, _v.distanceTo(cam.position));
      const err = T.cellOf(z) * (H * 0.5) / (halfTan * d);   // px per DEM cell
      if (err > targetPx && z - 1 >= zMin && canDescend(z, x, y)) {
        visit(z - 1, x * 2, y * 2); visit(z - 1, x * 2 + 1, y * 2);
        visit(z - 1, x * 2, y * 2 + 1); visit(z - 1, x * 2 + 1, y * 2 + 1);
        return;
      }
      out.push([z, x, y]);
    }
    const root = T.levelInfo("dem", zMax);
    for (const [x, y] of root.tiles) visit(zMax, x, y);
    /* A frustum that misses every root tile (the camera inside the terrain, or
       parked outside it) must not blank the view: fall back to the roots. */
    if (!out.length) for (const [x, y] of root.tiles) out.push([zMax, x, y]);
    const vs = vertsPerSide(meshStep(targetPx));
    if (out.length * vs * vs > MAX_VERTS) overflow = true;
    return { list: out, overflow };
  }

  /* -------------------------------------------------------------- update -- */
  /* THE HITCH IS THE LONGEST SYNCHRONOUS SPAN (v22 §G). update() is a chain of
     awaits, so every span between two of them is one main-thread block and
     `blk()` measures exactly those: the per-tile build, each drape, and the
     swap. Wall time is not the hitch — a build that yields can take a second
     and never block a gesture — and the sum is not either. test/perf.mjs reads
     both, and test/terrain3d.mjs asserts the maximum. */
  let _blkMax = 0, _blkSum = 0;
  function blkReset() { _blkMax = 0; _blkSum = 0; }
  function blk(fn) {
    const t = performance.now();
    const v = fn();
    const d = performance.now() - t;
    _blkSum += d; if (d > _blkMax) _blkMax = d;
    return v;
  }

  async function loadTile(z, x, y, prio) {
    const rec = await SBMM.tiles.get("dem", z, x, y, { priority: prio })
      .catch(e => (e && e.cancelled ? null : null));
    return rec;
  }

  function applyDrape(r, d) {
    if (!d) return;
    r.mat.map = d.tex;
    r.mat.needsUpdate = true;
    r.texPx = d.px;
    r.ftPerPx = d.ftPerPx;
    r.texBytes = d.px * d.px * 4;
  }

  /* Build (or re-use) the drawn set for the current camera. Resolves when the
     set is on screen; never rejects. */
  async function update(force) {
    if (!ctx || !available()) return false;
    if (suspended) { again = true; return false; }
    if (busy) { again = true; return false; }
    busy = true;
    const myGen = ++generation;
    try {
      let targetPx = ctx.quality();
      let sel = select(targetPx), guard = 0;
      while (sel.overflow && guard++ < 6) { targetPx *= 1.5; stat.raisedFor++; sel = select(targetPx); }
      stat.selects++;
      const step = meshStep(targetPx);
      const sig = style + "|" + targetPx + "|" + step + "|"
        + sel.list.map(t => t.join("/")).sort().join(",");
      if (!force && sig === lastSig) return false;

      const t0 = performance.now();
      /* priority by screen coverage: the finest (nearest) tiles first */
      const wanted = new Map();
      for (const [z, x, y] of sel.list) wanted.set(z + "/" + x + "/" + y, [z, x, y]);
      const need = [...wanted.entries()].filter(([k]) => !drawn.has(k));
      const loaded = await Promise.all(need.map(([k, t], i) =>
        loadTile(t[0], t[1], t[2], 1000 - t[0] * 100 - i).then(r => [k, t, r])));
      stat.lastLoadMs = +(performance.now() - t0).toFixed(1);
      if (myGen !== generation) return false;

      const t1 = performance.now();
      const built = new Map();
      const L = SBMM.tiles.layerInfo("dem") || {};
      blkReset();

      /* EVERYTHING THAT CAN BE ASKED FOR AT ONCE IS ASKED FOR AT ONCE, and
         only then is anything done with it (v22 §G):

           - the mesh for every tile that is not already in the geometry cache
             goes to the tile-decode worker pool, all of them started here so
             the pool pipelines while the main thread waits;
           - every image the drapes need is requested here too, so the canvas
             work below has nothing to await.

         The tile's Float32Array is NOT transferred — it belongs to
         SBMM.tiles' cache and transferring it would silently empty it;
         Dem.tileMeshAsync copies it (256 kB) and transfers the copy. */
      const meshP = new Map(), drapeP = new Map();
      blk(() => {
        for (const [k, t, rec] of loaded) {
          if (!rec || !rec.z32) continue;
          const gk = k + "|" + step;
          if (!geomCache.has(gk)) {
            meshP.set(k, Dem.tileMeshAsync(Object.assign(meshArgs(t[0], t[1], t[2], step),
                                                         { z32: rec.z32 })));
          }
          if (style === "ortho" || !gpuRaster) drapeP.set(k, drapeFetch(t[0], t[1], t[2]));
        }
      });

      /* YIELD BETWEEN TILES. Building 24 tiles of 257 x 257 in one loop blocks
         the main thread for most of a second, and a blocked main thread is not
         merely a stutter: js/touch.js's recogniser classifies a tap by the
         WALL-CLOCK gap between the first pointerdown and the last pointerup
         (tapMs 300, and the long-press timer at 500), so a gesture delivered
         across the block is not a tap any more. That is how a rebuild after a
         double-tap ate the two-finger tap that followed it — deterministically,
         with the same numbers every run (e2e_tablet block 3). One tile at a
         time, with a macrotask between, keeps the longest block to one tile —
         and since v22 a tile's own block is the wrapping and the drape
         composite, not the loop that made it. */
      let nb = 0;
      const td0 = performance.now();
      for (const [k, t, rec] of loaded) {
        if (nb++) {
          await new Promise(r => setTimeout(r, 0));
          if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }
        }
        if (!rec || !rec.z32) continue;
        const gk = k + "|" + step;
        let gc = geomCache.get(gk);
        if (gc) { gc.used = ++geomClock; stat.geomHits++; }
        else {
          const m = await (meshP.get(k) || Promise.resolve(null));
          if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }
          if (!m) continue;
          stat.geomMisses++;
          gc = blk(() => {
            const g = geomFromMesh(m);
            const rec2 = Object.assign({ key: gk, used: ++geomClock, live: false }, g);
            geomCache.set(gk, rec2);
            geomBytes += rec2.allBytes;
            return rec2;
          });
          geomTrim();
        }
        const got = drapeP.has(k) ? await drapeP.get(k) : null;
        if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }
        const r = blk(() => {
          const o = { key: k, z: t[0], x: t[1], y: t[2], geom: gc.geom, verts: gc.verts,
                      side: gc.side, step, tris: gc.tris, zlo: gc.zlo, zhi: gc.zhi,
                      bytes: gc.bytes, gkey: gk, texPx: 0, ftPerPx: null, texBytes: 0 };
          if (style === "ortho" || !gpuRaster) {
            o.mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
          } else {
            o.demTex = demTexture(rec.z32, L.zmin != null ? L.zmin : 1325,
                                  L.step != null ? L.step : 0.02);
            o.mat = rasterMaterial(o, style);
          }
          o.mesh = new THREE.Mesh(gc.geom, o.mat);
          o.mesh.scale.z = ctx.exag();
          /* whatever the ortho pyramid has for this tile; a missing drape
             leaves the mesh white rather than leaving the tile out */
          if (got) applyDrape(o, drapeCompose(t[0], t[1], t[2], got));
          return o;
        });
        if (r) built.set(k, r);
      }
      stat.lastDrapeMs = +(performance.now() - td0).toFixed(1);
      if (!(style === "ortho" || !gpuRaster)) {
        for (const r of drawn.values()) if (r.mat.uniforms) setRasterStyle(r);
      }
      if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }

      /* THE SWAP, whole (trap 3) */
      blk(() => {
        for (const [k, r] of drawn) {
          if (!wanted.has(k)) { ctx.scene.remove(r.mesh); dispose(r); drawn.delete(k); }
        }
        for (const [k, r] of built) { ctx.scene.add(r.mesh); drawn.set(k, r); }
        /* a geometry on screen is never evicted; everything else is fair game */
        for (const g of geomCache.values()) g.live = false;
        for (const r of drawn.values()) { const g = geomCache.get(r.gkey); if (g) g.live = true; }
      });
      stat.lastBuildMs = +(performance.now() - t1).toFixed(1);
      stat.lastBuildBlockMs = +_blkMax.toFixed(1);
      stat.lastBuildCpuMs = +_blkSum.toFixed(1);
      stat.lastBuildTiles = built.size;
      lastSig = sig;
      stat.swaps++;
      ctx.onSwap && ctx.onSwap();
      ctx.requestRender();
      return true;
    } catch (e) {
      console.warn("terrain quadtree update failed", e);
      return false;
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(() => update(), 0); }
    }
  }

  /* The GEOMETRY IS NOT DISPOSED HERE since v22: it belongs to the cache above,
     which is the whole point of the cache — a tile that leaves the drawn set
     and comes back a second later must cost nothing. Everything a record owns
     outright (its material, its drape texture, its DEM texture) is disposed. */
  function dispose(r) {
    if (r.geom && !r.gkey) r.geom.dispose();
    if (r.mat) { if (r.mat.map) r.mat.map.dispose(); r.mat.dispose(); }
    if (r.demTex) r.demTex.dispose();
  }

  function setRasterStyle(r) {
    if (!r.mat.uniforms) return;
    r.mat.uniforms.uMode.value = MODE[style] == null ? 0 : MODE[style];
    r.mat.uniforms.uRamp.value = ramp(style === "slope" ? "slope" : "hypso");
    r.mat.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- API --- */
  function attach(c) {
    ctx = c;
    const gl = c.renderer && c.renderer.capabilities;
    webgl2 = !!(gl && gl.isWebGL2);
    gpuRaster = webgl2 && SBMM.view && SBMM.view.pref
      ? (SBMM.view.pref("gpuRaster") !== false) : webgl2;
    if (!webgl2 && !gpuNoted) {
      gpuNoted = true;
      stat.cpuFallbacks++;
      console.warn("no WebGL2 — the derived terrain rasters fall back to the CPU pyramid");
    }
  }
  function detach() {
    for (const r of drawn.values()) { if (ctx) ctx.scene.remove(r.mesh); dispose(r); }
    drawn.clear(); lastSig = ""; generation++;
    /* the cached geometry is expressed in SCENE coordinates (it carries CX/CY
       and the elevation datum), so it does not outlive a detach */
    geomClear();
  }

  async function setStyle(kind) {
    if (kind === style) return;
    style = kind;
    if (!ctx) return;
    /* a style change replaces every material, so the whole set is rebuilt —
       and that is one rebuild, not one per tile per frame */
    for (const r of drawn.values()) { ctx.scene.remove(r.mesh); dispose(r); }
    drawn.clear(); lastSig = "";
    await update(true);
  }

  return {
    available, attach, detach, update, setStyle,
    /* Abandon whatever is in flight and refuse new work. generation++ makes
       the running update return at its next yield — which is why the build
       yields between tiles at all — and `again` makes resume() re-run it. */
    suspend() { if (suspended) return; suspended = true; generation++; },
    resume() { suspended = false; if (again) { again = false; update(); } },
    suspended: () => suspended,
    style: () => style,
    setExag(zx) { for (const r of drawn.values()) r.mesh.scale.z = zx; },
    setSun(az, el) {
      sunAz = az; sunEl = el;
      for (const r of drawn.values()) if (r.mat.uniforms) {
        r.mat.uniforms.uSunAz.value = az; r.mat.uniforms.uSunEl.value = el;
      }
    },
    setContours(ft) {
      for (const r of drawn.values()) if (r.mat.uniforms) r.mat.uniforms.uContour.value = ft || 0;
    },
    /* the records viewer3d keeps in `terrainMeshes`, in its own shape, so
       raycasting, the relief slider and stats() go on working unchanged */
    records() {
      return [...drawn.values()].map(r => ({ mesh: r.mesh, nx: r.side, ny: r.side,
                                             stride: r.step, dem: SBMM.demSite,
                                             tile: [r.z, r.x, r.y] }));
    },
    meshes() { return [...drawn.values()].map(r => r.mesh); },
    gpuRaster: () => gpuRaster,
    webgl2: () => webgl2,
    stats() {
      let verts = 0, tris = 0, bytes = 0, finest = 99, coarsest = -99;
      let texBytes = 0, texPxMax = 0, ftMin = Infinity, ftMax = 0, composed = 0;
      const byLevel = {};
      for (const r of drawn.values()) {
        verts += r.verts; tris += r.tris; bytes += r.bytes;
        finest = Math.min(finest, r.z); coarsest = Math.max(coarsest, r.z);
        byLevel[r.z] = (byLevel[r.z] || 0) + 1;
        texBytes += r.texBytes || 0;
        if (r.texPx > texPxMax) texPxMax = r.texPx;
        if (r.texPx > N) composed++;
        if (r.ftPerPx != null) { ftMin = Math.min(ftMin, r.ftPerPx); ftMax = Math.max(ftMax, r.ftPerPx); }
      }
      return {
        on: drawn.size > 0, tiles: drawn.size, verts, triangles: tris, bytes,
        finestLevel: drawn.size ? finest : null, finestCellFt: drawn.size ? Math.pow(2, finest) : null,
        coarsestLevel: drawn.size ? coarsest : null, byLevel,
        style, targetPx: ctx ? ctx.quality() : null,
        meshStep: ctx ? meshStep(ctx.quality()) : null,
        /* v22 §G — the drape, and what it costs. `texMB` is the raw drawn-set
           texture memory (a GPU adds about a third again for mipmaps);
           `drapeFtPerPx` is the picture's resolution on the ground, which is
           the number the pixelation complaint was about. */
        drapeK: ctx && ctx.drapeK ? ctx.drapeK() : 0,
        drapeTexPx: texPxMax, drapeComposed: composed,
        drapeFtPerPx: drawn.size && ftMax ? [ftMin, ftMax] : null,
        texBytes, texMB: +(texBytes / 1e6).toFixed(1),
        geomCacheTiles: geomCache.size, geomCacheMB: +(geomBytes / 1e6).toFixed(1),
        geomBudgetMB: +(geomBudget() / 1e6).toFixed(0),
        meshWorker: Dem.meshStats ? Dem.meshStats.worker : 0,
        meshMain: Dem.meshStats ? Dem.meshStats.main : 0,
        gpuRaster, webgl2, maxTiles: MAX_TILES, ...stat
      };
    },
    /* one row per drawn tile — its rectangle in State Plane feet, the DEM cell
       it was selected at and the ground resolution of the picture on it. The
       harness reads this to assert the drape over the mine window (v22 §G);
       there is no other way to ask "how sharp is the imagery there". */
    drawnTiles() {
      return [...drawn.values()].map(r => ({
        z: r.z, x: r.x, y: r.y, cellFt: SBMM.tiles.cellOf(r.z),
        rect: SBMM.tiles.rect(r.z, r.x, r.y),
        texPx: r.texPx, ftPerPx: r.ftPerPx, texBytes: r.texBytes,
        verts: r.verts, tris: r.tris
      }));
    },
    /* the harness sets a small budget to prove the cache evicts, and clears it
       to prove a cold rebuild still works */
    setGeomBudget(b) { geomBudgetOverride = b || 0; geomTrim(); },
    clearGeomCache() { geomClear(); },
    /* ---- the harness hooks (spec §4, §6) ------------------------------
       renderRasterTile() draws ONE tile through the same fragment shader into
       an offscreen target and reads it back; cpuHillshade() is the same
       formula in JS. The two are compared in test/terrain3d.mjs, which is what
       "display only, with the CPU as the fallback" has to mean if it is to be
       checkable at all. */
    async renderRasterTile(z, x, y, kind) {
      if (!ctx || !webgl2) return null;
      const rec = await SBMM.tiles.get("dem", z, x, y, { priority: 9999 }).catch(() => null);
      if (!rec || !rec.z32) return null;
      const L = SBMM.tiles.layerInfo("dem") || {};
      const zmin = L.zmin != null ? L.zmin : 1325, step = L.step != null ? L.step : 0.02;
      const tmp = { z, demTex: demTexture(rec.z32, zmin, step) };
      const mat = rasterMaterial(tmp, kind || "hillshade");
      const rt = new THREE.WebGLRenderTarget(N, N);
      const sc = new THREE.Scene();
      const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 10);
      cam.position.z = 1;
      sc.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat));
      const old = ctx.renderer.getRenderTarget();
      ctx.renderer.setRenderTarget(rt);
      ctx.renderer.clear();
      ctx.renderer.render(sc, cam);
      const px = new Uint8Array(N * N * 4);
      ctx.renderer.readRenderTargetPixels(rt, 0, 0, N, N, px);
      ctx.renderer.setRenderTarget(old);
      rt.dispose(); mat.dispose(); tmp.demTex.dispose();
      return { rgba: px, w: N, h: N };
    },
    async cpuHillshade(z, x, y, az, el) {
      const rec = await SBMM.tiles.get("dem", z, x, y, { priority: 9999 }).catch(() => null);
      if (!rec || !rec.z32) return null;
      const L = SBMM.tiles.layerInfo("dem") || {};
      const zmin = L.zmin != null ? L.zmin : 1325, step = L.step != null ? L.step : 0.02;
      const cell = SBMM.tiles.cellOf(z);
      const A = (az === undefined ? sunAz : az) * Math.PI / 180;
      const E = (el === undefined ? sunEl : el) * Math.PI / 180;
      /* the shader reads QUANTISED bytes, so the CPU reference must quantise
         the same way or the two differ by the encoding and not by the maths */
      const q = new Float32Array(N * N);
      for (let k = 0; k < N * N; k++) {
        const v = rec.z32[k];
        const n = isNaN(v) ? 0 : Math.max(0, Math.min(65535, Math.round((v - zmin) / step) + 1));
        q[k] = n === 0 ? NaN : zmin + (n - 1) * step;
      }
      const out = new Uint8Array(N * N * 4);
      const at = (i, j) => q[Math.max(0, Math.min(N - 1, j)) * N + Math.max(0, Math.min(N - 1, i))];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 4, zc = at(i, j);
        if (isNaN(zc)) { out[k + 3] = 0; continue; }
        const zl = isNaN(at(i - 1, j)) ? zc : at(i - 1, j), zr = isNaN(at(i + 1, j)) ? zc : at(i + 1, j);
        const zd = isNaN(at(i, j - 1)) ? zc : at(i, j - 1), zu = isNaN(at(i, j + 1)) ? zc : at(i, j + 1);
        const dx = (zr - zl) / (2 * cell), dy = (zu - zd) / (2 * cell);
        const sl = Math.atan(Math.hypot(dx, dy));
        let asp = Math.atan2(dx, dy); if (asp < 0) asp += 2 * Math.PI;
        const hs = Math.max(0, Math.min(1, Math.sin(E) * Math.cos(sl)
                                          + Math.cos(E) * Math.sin(sl) * Math.cos(A - asp)));
        const c = v => Math.round(Math.max(0, Math.min(255, v * 255)));
        out[k] = c(0.06 + 0.94 * hs); out[k + 1] = c(0.07 + 0.93 * hs);
        out[k + 2] = c(0.08 + 0.92 * hs); out[k + 3] = 255;
      }
      return { rgba: out, w: N, h: N };
    }
  };
})();
