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
  const stat = { selects: 0, swaps: 0, lastSelectMs: 0, lastBuildMs: 0, lastLoadMs: 0,
                 raisedFor: 0, cpuFallbacks: 0 };

  const available = () => !!(SBMM.tiles && SBMM.tiles.ready() && SBMM.tiles.layerInfo("dem"));

  /* ------------------------------------------------------------- shaders -- */
  /* One material per tile, sharing one program. `uMode`: 0 hillshade,
     1 slope, 2 aspect, 3 elevation tint. The relief term is the same in all
     four so the sun control relights every style at once (v15 asked for that
     and the CPU rasters could never do it). */
  const VERT = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const FRAG = `
    precision highp float;
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
      uniforms: {
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
      },
      fog: true
    });
    m.extensions = { derivatives: true };       // dFdx/dFdy for the contour width
    return m;
  }

  /* ---------------------------------------------------------- the drape --- */
  /* The tile's own ortho, or the nearest coarser ancestor with the sub-window
     picked out through offset/repeat. Walking up rather than giving up is what
     lets the ortho pyramid stop at 2 ft over most of the site while the DEM
     goes to 1 ft. */
  function orthoRef(z, x, y) {
    for (let k = 0; k <= 6; k++) {
      const za = z + k, xa = x >> k, ya = y >> k;
      if (!SBMM.tiles.levelInfo("ortho", za)) continue;
      if (SBMM.tiles.has("ortho", za, xa, ya)) return { z: za, x: xa, y: ya, k };
      /* only the site-wide levels are guaranteed; a missing one means no imagery */
    }
    return null;
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
     than by luck. */
  function buildGeometry(z32, z, x, y, step) {
    const cell = SBMM.tiles.cellOf(z);
    const r = SBMM.tiles.rect(z, x, y);
    const { CX, CY, ZMID } = ctx.center();
    const V = vertsPerSide(step);
    /* the extra row and column sit ON the tile edge and repeat the last
       sample, so two tiles at the same level abut exactly (trap 1) */
    const zAt = (i, j) => z32[Math.min(N - 1, j * step) * N + Math.min(N - 1, i * step)];
    const nv = V * V;
    const pos = new Float32Array((nv + 4 * V) * 3);
    const uv = new Float32Array((nv + 4 * V) * 2);
    let lo = Infinity, hi = -Infinity, good = 0;
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = j * V + i;
        const zz = zAt(i, j);
        const px = r[0] + i * step * cell, py = r[1] + j * step * cell;
        pos[k * 3] = px - CX; pos[k * 3 + 1] = py - CY;
        pos[k * 3 + 2] = (isNaN(zz) ? ZMID : zz) - ZMID;
        uv[k * 2] = i / (V - 1); uv[k * 2 + 1] = j / (V - 1);
        if (!isNaN(zz)) { good++; if (zz < lo) lo = zz; if (zz > hi) hi = zz; }
      }
    }
    if (!good) return null;
    /* THE INDEX IS A TYPED ARRAY, NOT A PUSHED JS ARRAY, and the normals are
       computed from the height field rather than by traversing the triangles.
       Both are the same numbers; both were costing ~320 ms PER TILE, and a
       tile build is not a background job — it lands between a user's fingers.
       That is not a figure of speech: the two-finger tap in test/e2e_tablet
       block 3 measured 503 ms from pointerdown to pointerup against a 300 ms
       tap window, and a long-task observer showed seven back-to-back tasks of
       625-674 ms, which is this loop in 2-tile chunks. */
    const maxTri = (V - 1) * (V - 1) * 2 + 4 * (V - 1) * 2;
    const idx = new Uint32Array(maxTri * 3);
    let ni = 0;
    for (let j = 0; j < V - 1; j++) {
      for (let i = 0; i < V - 1; i++) {
        /* skip any quad touching NoData — the rule the whole-DEM meshes used,
           and the reason the survey limit is an edge rather than a cliff wall */
        if (isNaN(zAt(i, j)) || isNaN(zAt(i + 1, j)) ||
            isNaN(zAt(i, j + 1)) || isNaN(zAt(i + 1, j + 1))) continue;
        const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
        idx[ni++] = a; idx[ni++] = b; idx[ni++] = d;
        idx[ni++] = a; idx[ni++] = d; idx[ni++] = c;
      }
    }
    if (!ni) return null;
    /* the skirt: four strips, each vertex a copy of its border neighbour
       dropped by a few cells */
    const drop = Math.max(8, cell * step * 3);
    let s = nv;
    const edge = [
      { get: i => i, step: 1 },                    // south, j = 0
      { get: i => (V - 1) * V + i, step: 1 },      // north
      { get: j => j * V, step: 1 },                // west
      { get: j => j * V + (V - 1), step: 1 }       // east
    ];
    for (let e = 0; e < 4; e++) {
      const base = s;
      for (let i = 0; i < V; i++) {
        const src = edge[e].get(i);
        pos[(base + i) * 3] = pos[src * 3];
        pos[(base + i) * 3 + 1] = pos[src * 3 + 1];
        pos[(base + i) * 3 + 2] = pos[src * 3 + 2] - drop;
        uv[(base + i) * 2] = uv[src * 2];
        uv[(base + i) * 2 + 1] = uv[src * 2 + 1];
      }
      for (let i = 0; i < V - 1; i++) {
        const a = edge[e].get(i), b = edge[e].get(i + 1);
        if (isNaN(zAt(a % V, (a / V) | 0)) || isNaN(zAt(b % V, (b / V) | 0))) continue;
        const c = base + i, d = base + i + 1;
        if (e === 0 || e === 3) { idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; idx[ni++] = a; idx[ni++] = d; idx[ni++] = b; }
        else { idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; idx[ni++] = a; idx[ni++] = b; idx[ni++] = d; }
      }
      s += V;
    }
    /* Normals straight off the height field: a heightfield vertex's normal is
       (-dz/dx, -dz/dy, 1) normalised, by central differences over the same
       samples the positions came from. That is 66 k iterations against
       computeVertexNormals' 131 k triangle cross-products plus a second
       normalising pass over every vertex, and it needs no triangle traversal
       at all. The z scale is applied to the OBJECT, and three transforms
       normals by the normal matrix, so these are computed unscaled exactly as
       computeVertexNormals did. */
    const nrm = new Float32Array((nv + 4 * V) * 3);
    const sx = step * cell;
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = j * V + i;
        const zc = zAt(i, j);
        if (isNaN(zc)) { nrm[k * 3 + 2] = 1; continue; }
        let zl = zAt(Math.max(0, i - 1), j), zr = zAt(Math.min(V - 1, i + 1), j);
        let zd = zAt(i, Math.max(0, j - 1)), zu = zAt(i, Math.min(V - 1, j + 1));
        if (isNaN(zl)) zl = zc; if (isNaN(zr)) zr = zc;
        if (isNaN(zd)) zd = zc; if (isNaN(zu)) zu = zc;
        const dx = (zr - zl) / (2 * sx), dy = (zu - zd) / (2 * sx);
        const inv = 1 / Math.hypot(dx, dy, 1);
        nrm[k * 3] = -dx * inv; nrm[k * 3 + 1] = -dy * inv; nrm[k * 3 + 2] = inv;
      }
    }
    /* the skirt copies its border neighbour's normal — it is a curtain, and a
       curtain lit differently from the edge it hangs off is a visible seam */
    for (let e = 0, sbase = nv; e < 4; e++, sbase += V) {
      for (let i = 0; i < V; i++) {
        const src = edge[e].get(i), dst = sbase + i;
        nrm[dst * 3] = nrm[src * 3];
        nrm[dst * 3 + 1] = nrm[src * 3 + 1];
        nrm[dst * 3 + 2] = nrm[src * 3 + 2];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx.subarray(0, ni), 1));
    g.computeBoundingSphere();
    return { geom: g, verts: nv, side: V, tris: ni / 3, zlo: lo, zhi: hi };
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
  async function loadTile(z, x, y, prio) {
    const rec = await SBMM.tiles.get("dem", z, x, y, { priority: prio })
      .catch(e => (e && e.cancelled ? null : null));
    return rec;
  }

  async function drapeFor(z, x, y) {
    if (style !== "ortho") return null;
    const ref = orthoRef(z, x, y);
    if (!ref) return null;
    const t = await SBMM.tiles.get("ortho", ref.z, ref.x, ref.y, { priority: 1 })
      .catch(() => null);
    if (!t || !t.img) return null;
    if (!t.tex) t.tex = texFromImage(t.img);
    return { tex: t.tex, k: ref.k, x, y, rx: ref.x, ry: ref.y };
  }

  function applyDrape(mat, d, z, x, y) {
    if (!d) return;
    const tex = d.tex.clone();
    tex.needsUpdate = true;
    const s = 1 / Math.pow(2, d.k);
    tex.repeat.set(s, s);
    tex.offset.set((x - d.rx * Math.pow(2, d.k)) * s, (y - d.ry * Math.pow(2, d.k)) * s);
    mat.map = tex;
    mat.needsUpdate = true;
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
      /* YIELD BETWEEN TILES. Building 24 tiles of 257 x 257 in one loop blocks
         the main thread for most of a second, and a blocked main thread is not
         merely a stutter: js/touch.js's recogniser classifies a tap by the
         WALL-CLOCK gap between the first pointerdown and the last pointerup
         (tapMs 300, and the long-press timer at 500), so a gesture delivered
         across the block is not a tap any more. That is how a rebuild after a
         double-tap ate the two-finger tap that followed it — deterministically,
         with the same numbers every run (e2e_tablet block 3). One tile at a
         time, with a macrotask between, keeps the longest block to one tile. */
      let nb = 0;
      for (const [k, t, rec] of loaded) {
        if (nb++) {
          await new Promise(r => setTimeout(r, 0));
          if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }
        }
        if (!rec || !rec.z32) continue;
        const g = buildGeometry(rec.z32, t[0], t[1], t[2], step);
        if (!g) continue;
        const r = { key: k, z: t[0], x: t[1], y: t[2], geom: g.geom, verts: g.verts,
                    side: g.side, step, tris: g.tris, zlo: g.zlo, zhi: g.zhi,
                    bytes: g.geom.getAttribute("position").array.byteLength };
        if (style === "ortho" || !gpuRaster) {
          r.mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        } else {
          r.demTex = demTexture(rec.z32, L.zmin != null ? L.zmin : 1325,
                                L.step != null ? L.step : 0.02);
          r.mat = rasterMaterial(r, style);
        }
        r.mesh = new THREE.Mesh(g.geom, r.mat);
        r.mesh.scale.z = ctx.exag();
        built.set(k, r);
      }
      /* whatever the ortho pyramid has for these tiles; a missing drape leaves
         the mesh white rather than leaving the tile out */
      if (style === "ortho" || !gpuRaster) {
        await Promise.all([...built.values()].map(async r => {
          const d = await drapeFor(r.z, r.x, r.y);
          applyDrape(r.mat, d, r.z, r.x, r.y);
        }));
      } else {
        for (const r of drawn.values()) if (r.mat.uniforms) setRasterStyle(r);
      }
      if (myGen !== generation) { for (const r of built.values()) dispose(r); return false; }
      stat.lastBuildMs = +(performance.now() - t1).toFixed(1);

      /* THE SWAP, whole (trap 3) */
      for (const [k, r] of drawn) {
        if (!wanted.has(k)) { ctx.scene.remove(r.mesh); dispose(r); drawn.delete(k); }
      }
      for (const [k, r] of built) { ctx.scene.add(r.mesh); drawn.set(k, r); }
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

  function dispose(r) {
    if (r.geom) r.geom.dispose();
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
      const byLevel = {};
      for (const r of drawn.values()) {
        verts += r.verts; tris += r.tris; bytes += r.bytes;
        finest = Math.min(finest, r.z); coarsest = Math.max(coarsest, r.z);
        byLevel[r.z] = (byLevel[r.z] || 0) + 1;
      }
      return {
        on: drawn.size > 0, tiles: drawn.size, verts, triangles: tris, bytes,
        finestLevel: drawn.size ? finest : null, finestCellFt: drawn.size ? Math.pow(2, finest) : null,
        coarsestLevel: drawn.size ? coarsest : null, byLevel,
        style, targetPx: ctx ? ctx.quality() : null,
        meshStep: ctx ? meshStep(ctx.quality()) : null,
        gpuRaster, webgl2, maxTiles: MAX_TILES, ...stat
      };
    },
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
