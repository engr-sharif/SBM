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
  let generation = 0, busy = false, again = false, inflight = null;
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
    #include <clipping_planes_pars_vertex>
    varying vec2 vUv;
    varying vec2 vSeeXY;
    void main() {
      vUv = uv;
      vSeeXY = (modelMatrix * vec4(position, 1.0)).xy;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
      #include <fog_vertex>
    }`;
  const FRAG = `
    precision highp float;
    #include <common>
    #include <fog_pars_fragment>
    #include <clipping_planes_pars_fragment>
    varying vec2 vUv;
    varying vec2 vSeeXY;
    uniform sampler2D uSeeTex; uniform vec4 uSeeBox; uniform float uSeeA;
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
      #include <clipping_planes_fragment>
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
      /* v51: see-through over the TEM survey only (uSeeA is 1 when the ground is solid) */
      gl_FragColor = vec4(col, uOpacity * mix(1.0, uSeeA, texture2D(uSeeTex, (vSeeXY - uSeeBox.xy) / uSeeBox.zw).r));
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
      }, seeUniforms()),
      fog: true,
      clipping: true                             // v27: the fence clip box
    });
    m.extensions = { derivatives: true };       // dFdx/dFdy for the contour width
    m.userData.seeMask = true;
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
  /* THE PYRAMID'S FLOOR IS NOT LEVEL 0 (v24). `cell = 2**z`, so z -1 is
     0.5 ft/px and z -2 is 0.25 ft/px, and tools/build_tiles.py cuts both over
     the 6-in mine ortho and the 3-in ABP crop. Capping k at `z` was what kept
     the drape's floor at 1 ft/px while the 2D map drew the same ground at 0.5
     and 0.25 — the "pixelated up close" report. The cap is the pyramid's own
     finest level now; `drapeK` still bounds the TEXTURE (256 * 2^k px, so
     1,024 px on a desktop exactly as in v22), which is why the memory does not
     move. */
  let _orthoFloor = null;
  function orthoFloor() {
    if (_orthoFloor == null) {
      const lv = SBMM.tiles.levels("ortho");      // coarsest first
      _orthoFloor = lv.length ? lv[lv.length - 1] : 0;
    }
    /* the PROFILE's floor as well as the pyramid's: js/viewer3d.js drapeFloor()
       keeps a tablet and a phone at v20's own z0 whatever the pyramid has, so
       the three touch harnesses go on measuring the app they measured */
    const pf = ctx && ctx.drapeFloor ? ctx.drapeFloor() : 0;
    return Math.max(_orthoFloor, pf);
  }
  function drapePlan(z, x, y) {
    if (!SBMM.tiles.levels("ortho").length) return null;
    const kMax = Math.min(ctx.drapeK ? ctx.drapeK() : 0, z - orthoFloor());
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

  /* Mipmaps, trilinear and the renderer's own anisotropy cap — stated rather
     than left to three's defaults, because the three of them together are what
     a drape at a grazing angle is made of and a future `minFilter = Linear`
     would look like a sharpening rather than the aliasing it is. Every drape
     here is 256, 512 or 1,024 px square, so mipmaps are always available. */
  function texFromImage(img) {
    const t = img instanceof HTMLCanvasElement ? new THREE.CanvasTexture(img) : new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = true;                    // image row 0 = north, uv v = 0 = south
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
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
      if (r.live || r.pin === generation) continue;      // on screen, or about to be
      geomCache.delete(r.key);
      geomBytes -= r.allBytes;
      stat.geomEvicted++;
      r.geom.dispose();
    }
  }
  /* `all` is detach()'s: the scene is going away, so every geometry goes with
     it. Without it a geometry that is ON SCREEN is left alone — disposing one
     out from under a drawn mesh makes three re-upload it on the next frame,
     which is not a crash and is not a cleared cache either. */
  function geomClear(all) {
    for (const [k, r] of geomCache) {
      if (!all && r.live) continue;
      r.geom.dispose();
      geomCache.delete(k);
      geomBytes -= r.allBytes;
    }
    if (all) { geomCache.clear(); geomBytes = 0; }
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
    /* WHAT THE SELECTION WAS GIVEN, because a selection that comes back as one
       root tile is otherwise unreadable. `H` is the clamp above: a canvas that
       has not been laid out reports a few pixels, and at 240 px the 64-ft root
       already meets a 2-px budget — so the view opens on the root and stays
       there until the next camera move. e2e block 9a-2's "high: 66049" (one
       257 x 257 tile) is exactly that, and js/viewer3d.js
       refreshTerrainForCamera() resizes and retries because of it. */
    stat.lastSelectH = H;
    stat.lastSelectTargetPx = +targetPx.toFixed(2);
    stat.lastSelectTiles = out.length;
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
  async function update(force, depth) {
    if (!ctx || !available()) return false;
    if (suspended) { again = true; return false; }
    if (busy) {
      /* A NON-FORCED call coalesces: the render loop asks on every settle and
         one rebuild is enough. A FORCED one must NOT be dropped — it is a
         rebuild somebody asked for (a detail change, a style change, opening
         the view) and its caller awaits it and then MEASURES what is drawn.
         Returning false there is how e2e block 9a-2 came back with
         "high: 66049 | standard: 0 | back to high: 0": rebuildTerrain() had
         detached the scene, its update(true) found the previous update still
         in flight, returned immediately, and the harness measured an empty
         terrain. So wait for the running one and go again. The depth guard is
         belt: two forced rebuilds racing each other would otherwise recurse. */
      again = true;
      if (!force || (depth || 0) > 4) return false;
      try { await inflight; } catch (e) { /* it never rejects */ }
      return update(force, (depth || 0) + 1);
    }
    busy = true;
    let settle = null;
    inflight = new Promise(r => { settle = r; });
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
      const meshP = new Map(), drapeP = new Map(), shadeP = new Map();
      blk(() => {
        for (const [k, t, rec] of loaded) {
          if (!rec || !rec.z32) continue;
          const gk = k + "|" + step;
          const have = geomCache.get(gk);
          if (!have) {
            meshP.set(k, Dem.tileMeshAsync(Object.assign(meshArgs(t[0], t[1], t[2], step),
                                                         { z32: rec.z32 })));
          } else {
            /* THIS BUILD IS GOING TO USE IT, so it must not be the next thing
               evicted: every geometry the loop below inserts calls geomTrim(),
               and an entry that was in the cache here and gone by the time its
               turn came used to be DROPPED FROM THE DRAWN SET — a hole in the
               ground that stayed until the camera moved, on any session that
               had filled the geometry budget. Pinned for the build, and the
               loop below builds it afresh if it is gone all the same. */
            have.used = ++geomClock; have.pin = myGen;
          }
          if (style === "ortho" || !gpuRaster) drapeP.set(k, drapeFetch(t[0], t[1], t[2]));
          if (shadeWanted()) shadeP.set(k, shadeFor(t[0], t[1], t[2], rec.z32).catch(() => null));
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
          /* no mesh was requested because the geometry was cached when this
             build began; if it has been evicted since, build it now */
          const m = await (meshP.get(k) ||
            Dem.tileMeshAsync(Object.assign(meshArgs(t[0], t[1], t[2], step), { z32: rec.z32 })));
          if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }
          if (!m) continue;
          stat.geomMisses++;
          gc = blk(() => {
            const g = geomFromMesh(m);
            const rec2 = Object.assign({ key: gk, used: ++geomClock, live: false }, g);
            geomCache.set(gk, rec2);
            geomBytes += rec2.allBytes;
            geomTrim();
            return rec2;
          });
        }
        const got = drapeP.has(k) ? await drapeP.get(k) : null;
        const shd = shadeP.has(k) ? await shadeP.get(k) : null;
        if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }
        const r = blk(() => {
          const o = { key: k, z: t[0], x: t[1], y: t[2], geom: gc.geom, verts: gc.verts,
                      side: gc.side, step, tris: gc.tris, zlo: gc.zlo, zhi: gc.zhi,
                      bytes: gc.bytes, gkey: gk, texPx: 0, ftPerPx: null, texBytes: 0 };
          if (style === "ortho" || !gpuRaster) {
            o.mat = groundMaterial(o);
          } else {
            o.demTex = demTexture(rec.z32, L.zmin != null ? L.zmin : 1325,
                                  L.step != null ? L.step : 0.02);
            o.mat = rasterMaterial(o, style);
          }
          o.mesh = new THREE.Mesh(gc.geom, o.mat);
          o.mesh.scale.z = ctx.exag();
          /* v40: the photo-draped ground throws and takes the sun's shadows.
             The shader rasters do not — a slope map with a shadow across it
             is a slope map with wrong values in it. */
          if (ctx.groundShadows && o.mat.isMeshLambertMaterial) ctx.groundShadows(o.mesh);
          /* whatever the ortho pyramid has for this tile; a missing drape
             leaves the mesh white rather than leaving the tile out */
          if (got) applyDrape(o, drapeCompose(t[0], t[1], t[2], got));
          if (shd) applyShade(o, shd);
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
      if (settle) settle();
      inflight = null;
      if (again) { again = false; setTimeout(() => update(), 0); }
    }
  }

  /* The GEOMETRY IS NOT DISPOSED HERE since v22: it belongs to the cache above,
     which is the whole point of the cache — a tile that leaves the drawn set
     and comes back a second later must cost nothing. Everything a record owns
     outright (its material, its drape texture, its DEM texture) is disposed. */
  /* ------------------------------------------------- v41: ground shading -- */
  /* THE PHOTO-DRAPED GROUND IS LIT PER PIXEL FROM THE LIDAR.

     The mesh is a level of detail (a 257 x 257 grid at best, far coarser in the
     distance) and until now its vertex normals were all the light had to go on:
     relief softened with distance, popped when a tile changed level, and at any
     range showed less of the ground than the lidar holds. Each tile now carries
     a 256 x 256 "shade" texture made from its own heights by Dem.tileShade —
     the surface normal in RGB, ambient occlusion in A — and the ground
     material reads the light from that. The geometry still decides where the
     surface IS; the lidar decides how it is LIT, at every level of detail.

     Three things are added to three's own Lambert shader through
     onBeforeCompile, and nothing is taken away (fog, shadows, the clip box and
     the see-through ground all go on working, because they are the same
     material):

       normal     from the shade texture, through normalMatrix — so the relief
                  slider, which scales the mesh in z, tilts the light with it;
       occlusion  the fill light is multiplied by A, and the direct light by
                  half of it: a gully is darker in the shade and still reads
                  in the sun;
       detail     within a few hundred feet the photograph runs out (half a
                  foot a pixel at best), so the albedo is broken up by two
                  octaves of tiling noise, in world feet so it does not swim,
                  scaled by WHAT THE GROUND IS — the land-cover raster: full on
                  grass, bare ground and mine waste, little on gravel, none on
                  pavement, roofs and water.

     Realistic rendering only (ctx.shade()). Standard, a phone and the field
     build keep the plain material — the same reason texBudget() is per
     profile. */
  const SHADE_A = 16;                 // apron, cells — the occlusion's reach
  const shadeCache = new Map();       // "z/x/y" -> { data: Uint8Array, used }
  const SHADE_KEEP = 180;
  let shadeClock = 0, noiseTex = null, coverTex = null, coverMeta = null;
  const shadeStat = { built: 0, hits: 0, apronPeek: 0, apronElev: 0 };
  function shadeWanted() { return !!(ctx && ctx.shade && ctx.shade()) && (style === "ortho" || !gpuRaster); }

  /* the tile's heights with an apron of the ground around it. A neighbouring
     tile that is already in the cache is read directly; where it is not, the
     apron comes from the analysis grids — a tile pixel IS a grid node at every
     level (the v20 rule), so the two agree to the bit and no seam can open
     along a level-of-detail boundary. */
  function shadePadded(z, x, y, z32) {
    const A = SHADE_A, P = N + 2 * A, zp = new Float32Array(P * P).fill(NaN);
    for (let j = 0; j < N; j++) zp.set(z32.subarray(j * N, j * N + N), (j + A) * P + A);
    const r = SBMM.tiles.rect(z, x, y), cell = SBMM.tiles.cellOf(z);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      /* the strip of the apron this neighbour covers, in padded coordinates */
      const i0 = dx < 0 ? 0 : dx > 0 ? A + N : A, i1 = dx < 0 ? A : dx > 0 ? P : A + N;
      const j0 = dy < 0 ? 0 : dy > 0 ? A + N : A, j1 = dy < 0 ? A : dy > 0 ? P : A + N;
      const nb = SBMM.tiles.peek("dem", z, x + dx, y + dy);
      if (nb && nb.z32 && nb.z32.length === N * N) {
        shadeStat.apronPeek++;
        for (let j = j0; j < j1; j++) {
          const sj = j - A - dy * N;
          for (let i = i0; i < i1; i++) zp[j * P + i] = nb.z32[sj * N + (i - A - dx * N)];
        }
      } else {
        shadeStat.apronElev++;
        for (let j = j0; j < j1; j++) {
          const Y = r[1] + (j - A) * cell;
          for (let i = i0; i < i1; i++) zp[j * P + i] = SBMM.elev(r[0] + (i - A) * cell, Y)[0];
        }
      }
    }
    return zp;
  }
  async function shadeFor(z, x, y, z32) {
    const key = z + "/" + x + "/" + y, hit = shadeCache.get(key);
    if (hit) { hit.used = ++shadeClock; shadeStat.hits++; return hit.data; }
    const data = await Dem.tileShadeAsync({ zp: shadePadded(z, x, y, z32), N, A: SHADE_A,
                                            cell: SBMM.tiles.cellOf(z), k: 2.0 });
    if (!data) return null;
    shadeStat.built++;
    shadeCache.set(key, { data, used: ++shadeClock });
    if (shadeCache.size > SHADE_KEEP) {
      const old = [...shadeCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, shadeCache.size - SHADE_KEEP);
      for (const [k] of old) shadeCache.delete(k);
    }
    return data;
  }
  function shadeTexture(data) {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }
  /* two octaves of value noise that tile, in R and G, mid-grey on average */
  function noiseTexture() {
    if (noiseTex) return noiseTex;
    const S = 256, d = new Uint8Array(S * S * 4);
    const lat = (seed, n) => { const a = new Float32Array(n * n); let h = seed >>> 0;
      for (let i = 0; i < a.length; i++) { h = (h * 1664525 + 1013904223) >>> 0; a[i] = h / 4294967296; } return a; };
    const sm = t => t * t * (3 - 2 * t);
    const oct = (L, n, u, v) => { const fx = u * n, fy = v * n, i = Math.floor(fx), j = Math.floor(fy), tx = sm(fx - i), ty = sm(fy - j);
      const a = L[(j % n) * n + (i % n)], b = L[(j % n) * n + ((i + 1) % n)], c = L[((j + 1) % n) * n + (i % n)], e = L[((j + 1) % n) * n + ((i + 1) % n)];
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty; };
    const LR = [lat(11, 8), lat(12, 16), lat(13, 32), lat(14, 64)], LG = [lat(21, 8), lat(22, 16), lat(23, 32), lat(24, 64)];
    const NN = [8, 16, 32, 64], W = [0.42, 0.28, 0.18, 0.12];
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      let r = 0, g = 0;
      for (let o = 0; o < 4; o++) { r += W[o] * oct(LR[o], NN[o], i / S, j / S); g += W[o] * oct(LG[o], NN[o], i / S, j / S); }
      const k = (j * S + i) * 4;
      d[k] = Math.round(clamp((r - 0.5) * 1.9 + 0.5, 0, 1) * 255);
      d[k + 1] = Math.round(clamp((g - 0.5) * 1.9 + 0.5, 0, 1) * 255);
      d[k + 2] = 128; d[k + 3] = 255;
    }
    const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
    return (noiseTex = t);
  }
  /* how much close-up detail each land-cover class takes, as a site-wide
     texture: the cover raster's own colours ARE its class palette, so a pixel
     is matched to the nearest class colour. Without the cover payload the
     texture is one grey texel and every surface takes the same detail. */
  const COVER_DETAIL = { nodata: 0.6, water: 0, paved: 0.08, roof: 0, gravel: 0.45, waste: 0.9, bare: 0.9, grass: 1, woods: 0.75 };
  function coverTexture() {
    if (coverTex) return coverTex;
    const flat = () => { const t = new THREE.DataTexture(new Uint8Array([200, 200, 200, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t; };
    coverTex = flat();
    const C = SBMM_DATA && SBMM_DATA.cover, url = SBMM_DATA && SBMM_DATA.cover_png;
    const o = SBMM.tiles.rect(SBMM.tiles.levels("dem")[0], 0, 0);
    coverMeta = { x0: o[0], y0: o[1], w: 1, h: 1, real: false };
    if (!C || !C.grid || !url || !Array.isArray(C.classes)) return coverTex;
    coverMeta = { x0: C.grid.x0, y0: C.grid.y0, w: C.grid.w * C.grid.cell, h: C.grid.h * C.grid.cell, real: false };
    const img = new Image();
    img.onload = () => {
      try {
        const W = Math.round(C.grid.w / 4), H = Math.round(C.grid.h / 4);
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        const g = cv.getContext("2d", { willReadFrequently: true });
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, W, H);
        const px = g.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H * 4);
        const pal = C.classes.map(c => [c.rgb[0], c.rgb[1], c.rgb[2], Math.round(255 * (COVER_DETAIL[c.key] == null ? 0.6 : COVER_DETAIL[c.key]))]);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const s2 = (j * W + i) * 4;
          let best = 0, bd = 1e9;
          for (let c = 0; c < pal.length; c++) {
            const dr = px[s2] - pal[c][0], dg = px[s2 + 1] - pal[c][1], db = px[s2 + 2] - pal[c][2], dd = dr * dr + dg * dg + db * db;
            if (dd < bd) { bd = dd; best = c; }
          }
          const k = ((H - 1 - j) * W + i) * 4;             // row 0 = south, so v = northing
          out[k] = out[k + 1] = out[k + 2] = pal[best][3]; out[k + 3] = 255;
        }
        /* a NEW texture, not a new image on the old one: the 1 x 1 placeholder's
           storage is immutable once uploaded. Every ground material reads the
           uniform object, so swapping its value reaches all of them. */
        const t2 = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
        t2.magFilter = THREE.LinearFilter; t2.minFilter = THREE.LinearFilter;
        t2.colorSpace = THREE.NoColorSpace; t2.needsUpdate = true;
        const old = coverTex;
        coverTex = t2; GROUND_U.uCover.value = t2;
        old.dispose();
        coverMeta.real = true;
        if (ctx) ctx.requestRender();
      } catch (e) { console.warn("ground detail: the land-cover raster could not be read", e); }
    };
    img.src = url;
    return coverTex;
  }
  /* the uniforms every ground material shares */
  /* v46 — WHERE THE SURVEY ENDS ON LAND, THE GROUND DISSOLVES. The lidar stops
     at a property line or a flight line, and the drawn ground used to stop
     with it: a cut edge standing over the backdrop, as if the hills ended at a
     cliff. This is a site-wide texture of HOW FAR INSIDE THE SURVEY a point
     is, 0 at the limit and 1 at EDGE_FT and beyond; the ground's shader thins
     the surface out against it with a screen-space dither, so the last few
     hundred feet fade into whatever is behind them.

     "The limit" is where the ground runs out ON LAND. Where it runs out at
     water — Clear Lake's shore — there is no fade: the shoreline is a real
     edge and the lake's own sheet meets it (js/water3d.js). So EA's water
     polygons count as inside. A dither, not blending: the ground keeps
     writing depth and stays in the opaque pass, so nothing about sorting,
     shadows or the see-through ground changes. */
  const EDGE_FT = 240, EDGE_CELL = 16;
  let edgeTex = null, edgeMeta = null;
  function edgeTexture() {
    if (edgeTex) return edgeTex;
    const flat = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    flat.needsUpdate = true;
    edgeTex = flat; edgeMeta = { x0: 0, y0: 0, w: 1, h: 1, real: false };
    const D = SBMM.demSite;
    if (!D || !D.m || !D.z) return edgeTex;
    try {
      const m = D.m, st = Math.max(1, Math.round(EDGE_CELL / m.cell)), cell = st * m.cell;
      const W = Math.floor(m.w / st), H = Math.floor(m.h / st);
      const inside = new Uint8Array(W * H);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++)
        if (!isNaN(D.z[(j * st) * m.w + i * st])) inside[j * W + i] = 1;
      /* EA's water bodies are inside too: rasterised by the 2D canvas, north up */
      const G = window.SBMM_DATA && SBMM_DATA.design_gis;
      if (G && G.features) {
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        const g = cv.getContext("2d", { willReadFrequently: true });
        g.fillStyle = "#fff"; g.strokeStyle = "#fff"; g.lineWidth = 7; g.lineJoin = "round";
        for (const f of G.features) {
          if (!f.properties || f.properties.layer !== "water" || !f.geometry || f.geometry.type !== "Polygon") continue;
          const r = f.geometry.coordinates[0];
          g.beginPath();
          r.forEach((q, k) => { const x = (q[0] - m.x0) / cell, y = H - (q[1] - m.y0) / cell; if (k) g.lineTo(x, y); else g.moveTo(x, y); });
          g.closePath(); g.fill();
          /* and a few cells past its outline: the lidar's water edge and EA's
             drafted shoreline do not meet exactly, and a 16-ft sliver of "no
             ground, no water" between them is a land limit to the transform —
             the shore then faded wherever the two disagreed */
          g.stroke();
        }
        const px = g.getImageData(0, 0, W, H).data;
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++)
          if (px[((H - 1 - j) * W + i) * 4] > 127) inside[j * W + i] = 1;
      }
      /* two-pass chamfer distance to the nearest cell that is not inside; the
         grid's own border is NOT a limit where the water runs off it */
      const BIG = 1e6, d = new Float32Array(W * H), A = 1, B = Math.SQRT2;
      for (let k = 0; k < d.length; k++) d[k] = inside[k] ? BIG : 0;
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const k = j * W + i; if (!d[k]) continue;
        let v = d[k];
        if (i > 0) v = Math.min(v, d[k - 1] + A);
        if (j > 0) { v = Math.min(v, d[k - W] + A); if (i > 0) v = Math.min(v, d[k - W - 1] + B); if (i < W - 1) v = Math.min(v, d[k - W + 1] + B); }
        d[k] = v;
      }
      for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
        const k = j * W + i; if (!d[k]) continue;
        let v = d[k];
        if (i < W - 1) v = Math.min(v, d[k + 1] + A);
        if (j < H - 1) { v = Math.min(v, d[k + W] + A); if (i < W - 1) v = Math.min(v, d[k + W + 1] + B); if (i > 0) v = Math.min(v, d[k + W - 1] + B); }
        d[k] = v;
      }
      const out = new Uint8Array(W * H);
      let faded = 0;
      for (let k = 0; k < d.length; k++) {
        const t = Math.min(1, d[k] * cell / EDGE_FT);
        out[k] = Math.round(255 * t * t * (3 - 2 * t));
        if (inside[k] && t < 1) faded++;
      }
      const t2 = new THREE.DataTexture(out, W, H, THREE.RedFormat, THREE.UnsignedByteType);
      t2.magFilter = THREE.LinearFilter; t2.minFilter = THREE.LinearFilter;
      t2.wrapS = t2.wrapT = THREE.ClampToEdgeWrapping;
      t2.colorSpace = THREE.NoColorSpace; t2.unpackAlignment = 1; t2.needsUpdate = true;
      edgeTex = t2; flat.dispose();
      /* texel k is centred on its cell, so the box runs half a cell past the first and last */
      edgeMeta = { x0: m.x0 - cell / 2, y0: m.y0 - cell / 2, w: W * cell, h: H * cell, real: true, W, H, cell,
                   fadedAcres: +(faded * cell * cell / 43560).toFixed(1), data: out };
    } catch (e) { console.warn("3D survey-edge fade:", e); }
    return edgeTex;
  }
  /* how far inside the survey a point is, 0..1 — for the harness */
  function edgeAt(x, y) {
    edgeTexture();
    if (!edgeMeta || !edgeMeta.real) return null;
    const i = clamp(Math.floor((x - edgeMeta.x0) / edgeMeta.cell), 0, edgeMeta.W - 1),
          j = clamp(Math.floor((y - edgeMeta.y0) / edgeMeta.cell), 0, edgeMeta.H - 1);
    return edgeMeta.data[j * edgeMeta.W + i] / 255;
  }

  const GROUND_U = { uNoise: { value: null }, uCover: { value: null }, uSite: { value: null },
                     uDetail: { value: null }, uAo: { value: 1 }, uEdge: { value: null }, uEdgeBox: { value: null } };
  /* v51 — SEE-THROUGH OVER THE TEM SURVEY ONLY. The 3D view owns one mask
     texture (how far inside the TEM survey a point is), its box in scene x/y
     and one alpha (ctx.seeUniforms(): 1 while the ground is solid). Every
     terrain material multiplies its OUTPUT alpha by mix(1, alpha, mask) — a
     no-op until the view switches the material's alphaToCoverage on, at which
     point the multisampled canvas keeps only that share of the ground's
     samples over the survey: the ground stays in the opaque pass, goes on
     writing depth and stays solid everywhere else. The alpha is written
     AFTER opaque_fragment because r160 forces an opaque material's alpha to
     1 there. `userData.seeMask` tells the view the material can do it. */
  let seeFallback = null;
  function seeUniforms() {
    if (ctx && ctx.seeUniforms) return ctx.seeUniforms();
    if (!seeFallback) {
      const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      seeFallback = { uSeeTex: { value: t }, uSeeBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uSeeA: { value: 1 } };
    }
    return seeFallback;
  }
  function seePatch(sh) {
    Object.assign(sh.uniforms, seeUniforms());
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vSeeXY;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n\tvSeeXY = ( modelMatrix * vec4( transformed, 1.0 ) ).xy;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uSeeTex; uniform vec4 uSeeBox; uniform float uSeeA;\nvarying vec2 vSeeXY;")
      .replace("#include <opaque_fragment>", `#include <opaque_fragment>
	gl_FragColor.a *= mix( 1.0, uSeeA, texture2D( uSeeTex, ( vSeeXY - uSeeBox.xy ) / uSeeBox.zw ).r );`);
  }
  function groundMaterial(o) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    mat.userData.seeMask = true;
    if (!shadeWanted()) {
      mat.onBeforeCompile = seePatch;
      mat.customProgramCacheKey = () => "sbmm-ground-std-v51";
      return mat;
    }
    if (!GROUND_U.uNoise.value) {
      GROUND_U.uNoise.value = noiseTexture();
      GROUND_U.uCover.value = coverTexture();
      GROUND_U.uSite.value = new THREE.Vector4(coverMeta.x0, coverMeta.y0, coverMeta.w, coverMeta.h);
      /* fade start, fade end (ft from the eye), strength */
      GROUND_U.uDetail.value = new THREE.Vector3(40, 420, 1.0);
      GROUND_U.uEdge.value = edgeTexture();
      /* the edge texture's box, in feet from the cover raster's corner (what uTile is in) */
      GROUND_U.uEdgeBox.value = new THREE.Vector4(coverMeta.x0 - edgeMeta.x0, coverMeta.y0 - edgeMeta.y0, edgeMeta.w, edgeMeta.h);
    }
    const r = SBMM.tiles.rect(o.z, o.x, o.y);
    const U = mat.userData.u = {
      uShade: { value: null }, uShadeK: { value: 0 },
      /* the tile's SW corner in feet from the cover raster's, and its size */
      uTile: { value: new THREE.Vector3(r[0] - coverMeta.x0, r[1] - coverMeta.y0, r[2] - r[0]) }
    };
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, GROUND_U, U);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vTileUv;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvTileUv = uv;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>
uniform sampler2D uShade; uniform float uShadeK; uniform vec3 uTile;
uniform sampler2D uNoise; uniform sampler2D uCover; uniform vec4 uSite; uniform vec3 uDetail; uniform float uAo;
uniform sampler2D uEdge; uniform vec4 uEdgeBox;
uniform mat3 normalMatrix;
varying vec2 vTileUv;`)
        .replace("#include <map_fragment>", `#include <map_fragment>
	{
		/* v46: the survey's edge on land. A screen-space dither against how far
		   inside the survey this fragment is; the lookup is unconditional (no
		   mips on that texture, but the rule is the rule) */
		float inS = texture2D( uEdge, ( uTile.xy + vTileUv * uTile.z + uEdgeBox.xy ) / uEdgeBox.zw ).r;
		float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
		if ( inS < 0.996 && inS < ign * 0.98 + 0.02 ) discard;
	}
	{
		vec2 wft = uTile.xy + vTileUv * uTile.z;
		float dEye = length( vViewPosition );
		float fade = ( 1.0 - smoothstep( uDetail.x, uDetail.y, dEye ) ) * texture2D( uCover, wft / uSite.zw ).r * uDetail.z;
		/* sampled UNCONDITIONALLY: a mip-mapped lookup inside a branch has no
		   defined derivatives, and a renderer is free to answer with the
		   smallest mip — one flat grey, i.e. no detail at all, with no error */
		/* two scales, in world feet: patches a few feet across and grain under
		   a foot. The texture's own contrast is spent by the time it has been
		   filtered down to a pixel, so it is stretched back out here. */
		float n = texture2D( uNoise, wft / 58.0 ).r * 0.5 + texture2D( uNoise, wft / 11.0 ).g * 0.5;
		diffuseColor.rgb *= mix( 1.0, 0.74 + 0.52 * smoothstep( 0.34, 0.66, n ), fade );
	}`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
	vec4 tShade = texture2D( uShade, vTileUv + vec2( ${(0.5 / N).toFixed(8)} ) );
	if ( uShadeK > 0.5 ) normal = normalize( normalMatrix * ( tShade.xyz * 2.0 - 1.0 ) );`)
        .replace("#include <aomap_fragment>", `#include <aomap_fragment>
	if ( uShadeK > 0.5 ) {
		float ao = mix( 1.0, tShade.a, uAo );
		reflectedLight.indirectDiffuse *= ao;
		reflectedLight.directDiffuse *= mix( 1.0, ao, 0.5 );
	}`);
      seePatch(sh);
    };
    mat.customProgramCacheKey = () => "sbmm-ground-v51";
    return mat;
  }
  function applyShade(r, data) {
    if (!data || !r.mat || !r.mat.userData.u) return;
    r.shadeTex = shadeTexture(data);
    r.mat.userData.u.uShade.value = r.shadeTex;
    r.mat.userData.u.uShadeK.value = 1;
  }
  /* what the shade texture says at a point of a drawn tile — for the harness */
  function shadeProbe(x, y) {
    let best = null;
    for (const r of drawn.values()) {
      const q = SBMM.tiles.rect(r.z, r.x, r.y);
      if (x < q[0] || x >= q[2] || y < q[1] || y >= q[3]) continue;
      if (!best || r.z < best.z) best = r;
    }
    const c = best && shadeCache.get(best.z + "/" + best.x + "/" + best.y);
    if (!best || !c || !best.shadeTex) return null;
    const cell = SBMM.tiles.cellOf(best.z), q = SBMM.tiles.rect(best.z, best.x, best.y);
    const i = clamp(Math.round((x - q[0]) / cell), 0, N - 1), j = clamp(Math.round((y - q[1]) / cell), 0, N - 1), o = (j * N + i) * 4;
    const d = c.data, nx = d[o] / 127.5 - 1, ny = d[o + 1] / 127.5 - 1, nz = d[o + 2] / 127.5 - 1;
    return { z: best.z, cell, tile: [best.x, best.y], n: [nx, ny, nz], ao: d[o + 3] / 255,
             slopePct: 100 * Math.hypot(nx, ny) / Math.max(nz, 1e-6) };
  }

  function dispose(r) {
    if (r.geom && !r.gkey) r.geom.dispose();
    if (r.mat) { if (r.mat.map) r.mat.map.dispose(); r.mat.dispose(); }
    if (r.demTex) r.demTex.dispose();
    if (r.shadeTex) r.shadeTex.dispose();
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
    geomClear(true);
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
    shadeProbe, edgeAt,
    /* the field itself, for whatever else has to fade with the ground (js/lines3d.js) */
    edgeField: () => { edgeTexture(); return edgeMeta && edgeMeta.real ? { tex: edgeTex, x0: edgeMeta.x0, y0: edgeMeta.y0, w: edgeMeta.w, h: edgeMeta.h } : null; }, edgeInfo: () => { edgeTexture(); return edgeMeta ? { real: edgeMeta.real, cell: edgeMeta.cell, w: edgeMeta.W, h: edgeMeta.H, fadeFt: EDGE_FT, fadedAcres: edgeMeta.fadedAcres } : null; },
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
        /* a rebuild in flight — a harness's "settled" must wait for it: the
           meshes build in a worker and the set swaps in (and renders) later */
        building: !!busy,
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
        shade: { on: shadeWanted(), tiles: [...drawn.values()].filter(r => r.shadeTex).length, cached: shadeCache.size,
                 built: shadeStat.built, hits: shadeStat.hits, apronPeek: shadeStat.apronPeek, apronElev: shadeStat.apronElev,
                 worker: Dem.shadeStats.worker, main: Dem.shadeStats.main, cover: !!(coverMeta && coverMeta.real) },
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
    clearGeomCache() { geomClear(false); },
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
