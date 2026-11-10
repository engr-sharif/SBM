/* SBMM Site Explorer — water in 3D (v42).

   Until now the 3D view had no water at all: Clear Lake was the flat backdrop
   plane showing through where the lidar has no ground, and the Herman
   impoundment and the ponds were whatever the aerial photo had painted on the
   lidar's flat return. This file gives every water body EA mapped a surface.

   WHERE THE SHORELINE COMES FROM. A water body is drawn as one flat sheet at
   its water level, a little larger than EA's polygon, and THE TERRAIN CUTS IT
   OFF: wherever the ground stands above the level, the ground is in front.
   So the shoreline is the level's own contour on the lidar — not a drafted
   outline that the lidar then disagrees with by a few feet all the way round.

   WHERE THE LEVEL COMES FROM. The lidar's own flat return inside the polygon
   (the commonest ground elevation there, where that is also the lowest),
   which is what the terrain mesh is drawn at, plus a few tenths of a foot so
   the sheet sits on it rather than in it. For Clear Lake, where the lidar has
   no ground at all, the same along the shoreline. A polygon with no flat
   return gets no sheet. These are DRAWING levels: the surveyed water levels
   the overtopping analysis reports are js/water.js's, and are not read here.

   WHAT IT LOOKS LIKE. One shader for every sheet: the SAME SKY the dome draws
   (js/atmos3d.js's function) reflected off a rippled normal through a Fresnel
   term, and the sun's glint. Clear Lake carries its own colour under that;
   an inland body is mostly see-through, because the aerial photograph draped
   on the lidar under it is the record of what colour that water really is.

   THE RIPPLES DO NOT RUN A CLOCK. Their phase is a uniform that advances only
   when a frame is being drawn anyway (tick()), so an idle view still renders
   nothing — the water moves while the camera moves and holds still when it
   does. The overtopping analysis's stage surface uses this material too
   (stageMaterial), so a flood stage looks like water rather than blue glass. */
"use strict";

SBMM.water3d = (function () {

  let cur = null;                  // { group, bodies, mats }
  const U_SHARED = { uSun: { value: new THREE.Vector3(0, 0.6, 0.8) }, uTime: { value: 0 } };
  let lastTick = 0, phase = 0;

  const VERT = `
    varying vec3 vWorld;
    #include <fog_pars_vertex>
    #include <clipping_planes_pars_vertex>
    void main() {
      vec4 w = modelMatrix * vec4( position, 1.0 );
      vWorld = w.xyz;
      vec4 mvPosition = viewMatrix * w;
      gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
      #include <fog_vertex>
    }`;

  function fragment() {
    return `
    uniform vec3 uSun; uniform float uTime;
    uniform vec3 uBody; uniform float uOpacity; uniform float uChop;
    uniform vec4 uEdge[3]; uniform float uEdgeN;
    varying vec3 vWorld;
    #include <fog_pars_fragment>
    #include <clipping_planes_pars_fragment>
    ${SBMM.atmos3d.GLSL_SKY_FN}
    /* the slope of a few crossing wave trains, in world feet. EACH TRAIN IS
       FADED BY ITS OWN FOOTPRINT: a wave shorter than about three pixels of
       the water it is drawn on cannot be drawn, only aliased — it came out as
       moire bands across the middle distance — so it is taken out there and
       the longer ones carry on. fp = feet of water per pixel. */
    float train( vec2 p, vec2 d, float k, float w, float t, float fp ) {
      return cos( dot( p, d ) * k + t * w ) * smoothstep( 2.5, 6.0, 6.2832 / ( k * fp ) );
    }
    vec2 ripple( vec2 p, float t, float fp ) {
      vec2 g = vec2( 0.0 );
      g += vec2(  0.26,  0.97 ) * train( p, vec2(  0.26,  0.97 ), 0.045, 0.55, t, fp ) * 0.30;
      g += vec2(  0.80,  0.60 ) * train( p, vec2(  0.80,  0.60 ), 0.210, 1.10, t, fp ) * 0.50;
      g += vec2( -0.45,  0.89 ) * train( p, vec2( -0.45,  0.89 ), 0.370, 1.55, t, fp ) * 0.34;
      g += vec2(  0.97, -0.24 ) * train( p, vec2(  0.97, -0.24 ), 0.930, 2.30, t, fp ) * 0.22;
      g += vec2( -0.71, -0.71 ) * train( p, vec2( -0.71, -0.71 ), 1.900, 3.10, t, fp ) * 0.14;
      return g;
    }
    float segDist( vec2 p, vec4 s ) {
      vec2 ab = s.zw - s.xy, ap = p - s.xy;
      return length( ap - ab * clamp( dot( ap, ab ) / max( dot( ab, ab ), 1e-6 ), 0.0, 1.0 ) );
    }
    void main() {
      #include <clipping_planes_fragment>
      vec3 V = normalize( cameraPosition - vWorld );
      float fp = max( length( dFdx( vWorld.xy ) ), length( dFdy( vWorld.xy ) ) );
      vec3 N = normalize( vec3( -ripple( vWorld.xy, uTime, fp ) * uChop, 1.0 ) );
      if ( V.z < 0.0 ) N = -N;                       /* seen from underneath */
      float cosV = max( dot( N, V ), 0.0 );
      float F = 0.03 + 0.97 * pow( 1.0 - cosV, 5.0 );
      vec3 R = reflect( -V, N ); R.z = abs( R.z );
      vec3 sky = atmosSky( R, uSun, 0.0 );
      /* the water's own colour, lit by how high the sun is */
      float day = 0.30 + 0.70 * smoothstep( -0.05, 0.45, uSun.z );
      vec3 col = mix( uBody * day, sky, F );
      /* the glint: the sun mirrored in the ripples */
      float gl = pow( max( dot( R, uSun ), 0.0 ), 220.0 );
      col += vec3( 1.0, 0.94, 0.82 ) * gl * 1.8;
      /* seen through at a steep angle, all mirror at a grazing one */
      float a = clamp( uOpacity + ( 1.0 - uOpacity ) * F + gl, 0.0, 1.0 );
      /* a sheet that ends where the MAPPING ends (the straight edges of EA's
         lake polygon, which are a drawing limit and not a shore) fades out
         there instead of stopping at a line */
      for ( int i = 0; i < 3; i++ ) {
        if ( float( i ) < uEdgeN ) a *= smoothstep( 0.0, 900.0, segDist( vWorld.xy, uEdge[ i ] ) );
      }
      gl_FragColor = vec4( col, a );
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;
  }

  /* the water's own colour (linear), how much of it shows looking straight
     down, and the ripple slope.
       lake   there is no photograph under Clear Lake (the lidar has no ground
              there), so the sheet carries the colour itself
       pond   the aerial photograph IS under an inland body — the lidar's flat
              return is draped with it — and it is the record of what colour
              that water is (the impoundment is not the colour of a pond). So
              the sheet is mostly a reflection and a ripple over the photograph
       stage  the overtopping analysis's flood stage: a result, so it stays the
              analysis blue and stays see-through enough to read the ground */
  const KIND = {
    lake: { body: [0.022, 0.075, 0.082], opacity: 0.94, chop: 0.060 },
    pond: { body: [0.030, 0.060, 0.058], opacity: 0.30, chop: 0.035 },
    stage: { body: [0.090, 0.400, 0.760], opacity: 0.42, chop: 0.035 }
  };
  function material(kind, edges) {
    const k = KIND[kind] || KIND.pond;
    const E = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
    (edges || []).slice(0, 3).forEach((e, i) => E[i].set(e[0], e[1], e[2], e[3]));
    return new THREE.ShaderMaterial({
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
        uSun: U_SHARED.uSun, uTime: U_SHARED.uTime,
        uBody: { value: new THREE.Vector3(k.body[0], k.body[1], k.body[2]) },
        uOpacity: { value: k.opacity }, uChop: { value: k.chop },
        uEdge: { value: E }, uEdgeN: { value: Math.min(3, (edges || []).length) }
      }),
      vertexShader: VERT, fragmentShader: fragment(),
      transparent: true, depthWrite: false, fog: true, clipping: true, toneMapped: false, side: THREE.DoubleSide,
      extensions: { derivatives: true },
      /* the sheet lies a few tenths of a foot over a flat lidar return: without
         this the two fight for the same depth from a few thousand feet away */
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6
    });
  }
  /* the overtopping stage surface is the same water (js/viewer3d.js setWaterStage) */
  function stageMaterial() { return SBMM.atmos3d ? material("stage") : null; }

  /* ------------------------------------------------------------------ */
  function polyArea(r) {
    let s = 0;
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }
  function inRing(r, x, y) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  /* EA's water polygons, once each (the geodatabase and the CAD both carry them) */
  function bodies() {
    const G = window.SBMM_DATA && SBMM_DATA.design_gis;
    if (!G || !G.features) return [];
    const out = [], seen = [];
    for (const f of G.features) {
      if (!f.properties || f.properties.layer !== "water" || !f.geometry || f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0];
      if (!ring || ring.length < 4) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of ring) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (seen.some(s => Math.abs(s[0] - cx) < 6 && Math.abs(s[1] - cy) < 6)) continue;
      seen.push([cx, cy]);
      const name = f.properties.name || "Water";
      out.push({ name, ring, box: [x0, y0, x1, y1], area: Math.abs(polyArea(ring)), lake: /clear lake/i.test(name) });
    }
    return out;
  }

  /* THE LEVEL A BODY IS DRAWN AT: the lidar's flat return — the commonest
     ground elevation (to a tenth of a foot) among the samples — and only when
     that flat is the LOWEST ground there. A polygon with no such flat (dry
     when it was flown, or over ground the lidar never saw) gets no sheet:
     drawing one would be inventing a water level.
     Inside a body the samples are a grid; for Clear Lake, where the lidar has
     no ground at all, they are walked along the shoreline EA drew. */
  function levelOf(b) {
    const zs = [];
    if (b.lake) {
      for (let i = 0; i < b.ring.length; i++) {
        const a = b.ring[i], c = b.ring[(i + 1) % b.ring.length], n = Math.max(1, Math.round(Math.hypot(c[0] - a[0], c[1] - a[1]) / 40));
        for (let k = 0; k < n; k++) {
          const z = SBMM.elev(a[0] + (c[0] - a[0]) * k / n, a[1] + (c[1] - a[1]) * k / n)[0];
          if (!isNaN(z)) zs.push(z);
        }
      }
    } else {
      const [x0, y0, x1, y1] = b.box, step = Math.max(2, Math.sqrt(b.area / 1200));
      for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
        if (!inRing(b.ring, x, y)) continue;
        const z = SBMM.elev(x, y)[0];
        if (!isNaN(z)) zs.push(z);
      }
    }
    if (zs.length < 8) return { level: NaN, why: "no lidar ground" };
    const bins = new Map();
    let mk = 0, mc = 0;
    for (const z of zs) { const k = Math.round(z * 10), c = (bins.get(k) || 0) + 1; bins.set(k, c); if (c > mc) { mc = c; mk = k; } }
    const mode = mk / 10;
    let flat = 0, below = 0;
    for (const z of zs) { if (Math.abs(z - mode) <= 0.3) flat++; else if (z < mode - 0.3) below++; }
    if (b.lake) return { level: mode, flat: flat / zs.length };
    if (flat / zs.length < 0.10 || below / zs.length > 0.05) return { level: NaN, why: "no flat water return in the lidar" };
    return { level: mode, flat: flat / zs.length };
  }

  /* grow a ring outwards a little, so the terrain — not the drafted outline —
     decides where the water ends */
  function grown(ring, by) {
    let cx = 0, cy = 0;
    for (const q of ring) { cx += q[0]; cy += q[1]; }
    cx /= ring.length; cy /= ring.length;
    return ring.map(q => { const dx = q[0] - cx, dy = q[1] - cy, d = Math.hypot(dx, dy) || 1; return [q[0] + dx / d * by, q[1] + dy / d * by]; });
  }
  /* the straight edges of a mapped lake: a drawing limit, not a shore */
  function straightEdges(ring, ctx) {
    const out = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 600) out.push([a[0] - ctx.CX, a[1] - ctx.CY, b[0] - ctx.CX, b[1] - ctx.CY]);
    }
    return out.slice(0, 3);
  }

  /* ctx: { CX, CY, ZMID, sunAz, sunEl } -> a Group, or null where there is nothing to draw */
  function build(ctx) {
    dispose();
    if (!SBMM.atmos3d) return null;
    const list = bodies();
    if (!list.length) return null;
    const group = new THREE.Group(), made = [], skipped = [];
    for (const b of list) {
      const L = levelOf(b);
      if (isNaN(L.level)) { skipped.push({ name: b.name, acres: +(b.area / 43560).toFixed(2), why: L.why }); continue; }
      const ring = b.lake ? b.ring : grown(b.ring, Math.min(14, Math.max(5, Math.sqrt(b.area) * 0.06)));
      const shape = new THREE.Shape(ring.map(q => new THREE.Vector2(q[0] - ctx.CX, q[1] - ctx.CY)));
      const geo = new THREE.ShapeGeometry(shape);
      const lift = b.lake ? 0.2 : 0.35;
      geo.translate(0, 0, L.level + lift - ctx.ZMID);
      const mesh = new THREE.Mesh(geo, material(b.lake ? "lake" : "pond", b.lake ? straightEdges(b.ring, ctx) : null));
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      mesh.userData.water = { name: b.name, level: +L.level.toFixed(2), drawnAt: +(L.level + lift).toFixed(2),
        acres: +(b.area / 43560).toFixed(2), lake: b.lake, flat: +L.flat.toFixed(2) };
      group.add(mesh);
      made.push(mesh.userData.water);
    }
    if (!made.length) return null;
    cur = { group, bodies: made, skipped };
    setSun(ctx.sunAz, ctx.sunEl);
    return group;
  }

  function setSun(az, el) { if (SBMM.atmos3d) SBMM.atmos3d.sunDir(az, Math.max(el, 1), U_SHARED.uSun.value); }

  /* called once per DRAWN frame: the ripples move with the frames, never on
     their own. A long pause between frames is not a long time for the water. */
  function tick(nowMs) {
    const dt = lastTick ? Math.min(0.12, Math.max(0, (nowMs - lastTick) / 1000)) : 0;
    lastTick = nowMs;
    phase += dt;
    U_SHARED.uTime.value = phase;
  }

  function dispose() {
    if (!cur) return;
    cur.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    cur = null;
  }
  function stats() { return cur ? { bodies: cur.bodies.length, list: cur.bodies, skipped: cur.skipped, phase: +phase.toFixed(3) } : null; }

  return { build, setSun, tick, dispose, stats, stageMaterial, bodies, levelOf };
})();
