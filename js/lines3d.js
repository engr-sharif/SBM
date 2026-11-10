/* SBMM Site Explorer — lines in 3D with a width (v44).

   WebGL draws a line one pixel wide, whatever width is asked for, and it does
   not anti-alias it. So every boundary, contour, pipe and route in the 3D view
   was a one-pixel stair-step, and the only thing that kept a bright line
   readable over a bright photograph was a second copy of it 1.3 ft lower in
   dark grey (the v15 "drop shadow") — which reads as an outline from above
   and as a second line from the side.

   This file gives a line a WIDTH IN PIXELS that holds at any distance, a soft
   edge, and a dark CASING around it — the way a map draws a line that has to
   be read over a picture.

   HOW. A line object stays exactly what it was: a THREE.Line / LineSegments /
   LineLoop with its geometry, its userData (the layer tag, the pick record,
   the owner array) and its place in the scene. It simply stops DRAWING
   (`material.visible = false`) and gains one child — a mesh of one quad per
   segment, widened in the vertex shader perpendicular to the segment ON THE
   SCREEN. So:

     - the raycaster still hits the line object, and every pick kind that maps
       a segment index back to a feature goes on working untouched;
     - the block-9y parity table still counts the object it always counted;
     - disposing the line's group disposes the child with it.

   THE CHILD FOLLOWS ITS PARENT'S MATERIAL. Its colour uniform IS the parent
   material's colour object, and its opacity is copied from the parent's at
   each draw (`onBeforeRender`) — so the hover highlight in js/pick3d.js and
   the selection halo's pulse, both of which write to the parent's material,
   move the wide line with no code of their own.

   widen(root) converts every line under a root that has not been converted
   and is not flagged `userData.noWide`. It is called at the end of an overlay
   rebuild, so it costs nothing per frame and nothing here asks for a frame. */
"use strict";

SBMM.lines3d = (function () {

  const U = { uRes: { value: new THREE.Vector2(1, 1) }, uPR: { value: 1 } };
  let made = 0;

  const VERT = `
    #define AA_PX 0.75
    uniform vec2 uRes; uniform float uPR; uniform float uHalf;
    attribute vec3 aOther; attribute vec2 aParam; attribute float aDist;
    #ifdef WIDE_COLOR
      attribute vec3 aColor; varying vec3 vWideColor;
    #endif
    varying float vSide; varying float vDist;
    #include <fog_pars_vertex>
    #include <clipping_planes_pars_vertex>
    void trim( inout vec4 behind, in vec4 front ) {
      /* bring an end that is behind the eye up to the near plane, so the
         perspective divide does not throw it across the screen */
      float a = projectionMatrix[ 2 ][ 2 ], b = projectionMatrix[ 3 ][ 2 ];
      float nearZ = - 0.5 * b / a;
      float t = ( nearZ - front.z ) / ( behind.z - front.z );
      behind.xyz = mix( front.xyz, behind.xyz, t );
    }
    void main() {
      vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
      vec4 mvOther = modelViewMatrix * vec4( aOther, 1.0 );
      bool persp = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 );
      if ( persp ) {
        if ( mvPosition.z > 0.0 && mvOther.z < 0.0 ) trim( mvPosition, mvOther );
        else if ( mvOther.z > 0.0 && mvPosition.z < 0.0 ) trim( mvOther, mvPosition );
      }
      vec4 cp = projectionMatrix * mvPosition, co = projectionMatrix * mvOther;
      vec2 a = cp.xy / cp.w * uRes * 0.5, b = co.xy / co.w * uRes * 0.5;      /* pixels */
      vec2 d = b - a;
      float L = length( d );
      d = L > 1e-4 ? d / L : vec2( 1.0, 0.0 );
      if ( aParam.y > 0.5 ) d = -d;                    /* always from the segment's start to its end */
      vec2 n = vec2( -d.y, d.x );
      /* the quad is the line plus a fringe of AA_PX on each side for the soft
         edge to live in: without the fringe a one-pixel line has nowhere to
         fade and comes out at half strength or less */
      float h = uHalf * uPR + AA_PX;
      /* out to the side, and half a width past the end so two segments meet without a notch */
      vec2 off = n * aParam.x * h + d * ( aParam.y > 0.5 ? 1.0 : -1.0 ) * h * 0.5;
      gl_Position = cp;
      gl_Position.xy += off / ( uRes * 0.5 ) * cp.w;
      vSide = aParam.x;
      vDist = aDist;
      #ifdef WIDE_COLOR
        vWideColor = aColor;
      #endif
      #include <clipping_planes_vertex>
      #include <fog_vertex>
    }`;

  const FRAG = `
    #define AA_PX 0.75
    uniform vec3 uColor; uniform vec3 uCase; uniform float uOpacity; uniform float uCaseA;
    uniform float uHalf; uniform float uCore; uniform float uPR; uniform float uDash; uniform float uGap;
    #ifdef WIDE_COLOR
      varying vec3 vWideColor;
    #endif
    varying float vSide; varying float vDist;
    #include <fog_pars_fragment>
    #include <clipping_planes_pars_fragment>
    void main() {
      #include <clipping_planes_fragment>
      if ( uDash > 0.0 && mod( vDist, uDash + uGap ) > uDash ) discard;
      float d = abs( vSide ) * ( uHalf * uPR + AA_PX );        /* pixels from the centre line */
      /* coverage: full inside the width, falling to nothing across one pixel at its edge */
      float edge = clamp( uHalf * uPR + 0.5 - d, 0.0, 1.0 );
      float core = clamp( uCore * uPR + 0.5 - d, 0.0, 1.0 );
      vec3 base = uColor;
      #ifdef WIDE_COLOR
        base *= vWideColor;
      #endif
      gl_FragColor = vec4( mix( uCase, base, core ), uOpacity * edge * mix( uCaseA, 1.0, core ) );
      if ( gl_FragColor.a < 0.01 ) discard;
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;

  /* the segments of a line object as index pairs into its position attribute */
  function segmentsOf(o) {
    const g = o.geometry, pa = g.getAttribute("position");
    if (!pa || pa.count < 2) return null;
    const ix = g.index ? g.index.array : null, n = ix ? ix.length : pa.count;
    const at = i => ix ? ix[i] : i;
    const seg = [];
    if (o.isLineSegments) for (let i = 0; i + 1 < n; i += 2) seg.push(at(i), at(i + 1));
    else {
      for (let i = 0; i + 1 < n; i++) seg.push(at(i), at(i + 1));
      if (o.isLineLoop && n > 2) seg.push(at(n - 1), at(0));
    }
    return seg.length ? seg : null;
  }

  /* opts: { width (px, the coloured core), casing (px each side), casingColor, casingAlpha } */
  function wideFor(o, opts) {
    const seg = segmentsOf(o);
    if (!seg) return null;
    opts = opts || {};
    const m0 = o.material, g0 = o.geometry;
    const pa = g0.getAttribute("position").array;
    const ca = m0.vertexColors && g0.getAttribute("color") ? g0.getAttribute("color") : null;
    const la = g0.getAttribute("lineDistance") ? g0.getAttribute("lineDistance").array : null;
    const ns = seg.length / 2;
    const pos = new Float32Array(ns * 12), oth = new Float32Array(ns * 12), par = new Float32Array(ns * 8),
          dist = new Float32Array(ns * 4), col = ca ? new Float32Array(ns * 12) : null;
    const idx = ns * 4 > 65535 ? new Uint32Array(ns * 6) : new Uint16Array(ns * 6);
    let run = 0, prevB = -1;
    for (let s = 0; s < ns; s++) {
      const ia = seg[s * 2], ib = seg[s * 2 + 1];
      const ax = pa[ia * 3], ay = pa[ia * 3 + 1], az = pa[ia * 3 + 2], bx = pa[ib * 3], by = pa[ib * 3 + 1], bz = pa[ib * 3 + 2];
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      /* the distance along the line, for the dashes: the geometry's own where
         it has one, otherwise run up along each connected stretch */
      if (ia !== prevB) run = 0;
      const d0 = la ? la[ia] : run, d1 = la ? la[ib] : run + len;
      run += len; prevB = ib;
      for (let k = 0; k < 4; k++) {
        const end = k >= 2, v = s * 4 + k;
        pos[v * 3] = end ? bx : ax; pos[v * 3 + 1] = end ? by : ay; pos[v * 3 + 2] = end ? bz : az;
        oth[v * 3] = end ? ax : bx; oth[v * 3 + 1] = end ? ay : by; oth[v * 3 + 2] = end ? az : bz;
        par[v * 2] = k % 2 ? 1 : -1; par[v * 2 + 1] = end ? 1 : 0;
        dist[v] = end ? d1 : d0;
        if (col) { const i = end ? ib : ia; col[v * 3] = ca.getX(i); col[v * 3 + 1] = ca.getY(i); col[v * 3 + 2] = ca.getZ(i); }
      }
      const b = s * 4;
      idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], s * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aOther", new THREE.BufferAttribute(oth, 3));
    g.setAttribute("aParam", new THREE.BufferAttribute(par, 2));
    g.setAttribute("aDist", new THREE.BufferAttribute(dist, 1));
    if (col) g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    /* the quads are placed in the shader, so the bounds are the line's own */
    if (!g0.boundingSphere) g0.computeBoundingSphere();
    g.boundingSphere = g0.boundingSphere.clone();

    const w = opts.width != null ? opts.width : (m0.linewidth > 1 ? m0.linewidth : 1.7);
    const casing = opts.casing != null ? opts.casing : 1.1;
    const dashed = !!m0.isLineDashedMaterial;
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
        uRes: U.uRes, uPR: U.uPR,
        uColor: { value: m0.color },                       // the SAME colour object: a highlight on the line moves this
        uCase: { value: new THREE.Color(opts.casingColor != null ? opts.casingColor : 0x070B0E) },
        uCaseA: { value: opts.casingAlpha != null ? opts.casingAlpha : 0.62 },
        uOpacity: { value: m0.opacity == null ? 1 : m0.opacity },
        uHalf: { value: w / 2 + casing }, uCore: { value: w / 2 },
        uDash: { value: dashed ? m0.dashSize : 0 }, uGap: { value: dashed ? m0.gapSize : 0 }
      }),
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: m0.depthTest !== false,
      fog: m0.fog !== false, clipping: true, toneMapped: false, side: THREE.DoubleSide
    });
    if (col) mat.defines = { WIDE_COLOR: "" };
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = o.frustumCulled;
    mesh.renderOrder = o.renderOrder;
    mesh.userData.wide = true;
    if (o.userData && o.userData.noClip) mesh.userData.noClip = true;
    mesh.raycast = function () {};                            // the line itself answers a pick
    mesh.onBeforeRender = function () {
      const u = mat.uniforms.uOpacity;
      const v = m0.opacity == null ? 1 : m0.opacity;
      if (u.value !== v) u.value = v;
    };
    return mesh;
  }

  /* convert every line under root; -> how many were converted this call */
  function widen(root, opts) {
    if (!root) return 0;
    const todo = [];
    root.traverse(o => {
      if (!(o.isLine) || !o.geometry || !o.material || Array.isArray(o.material)) return;
      if (o.userData.noWide || o.userData._wide) return;
      todo.push(o);
    });
    let n = 0;
    for (const o of todo) {
      const per = o.userData.wideOpts ? Object.assign({}, opts, o.userData.wideOpts) : opts;
      let m = null;
      try { m = wideFor(o, per); } catch (e) { console.warn("wide line:", e); }
      if (!m) continue;
      o.material.visible = false;                              // the line stays, it just stops drawing
      o.userData._wide = m;
      o.add(m);
      n++;
    }
    made += n;
    return n;
  }

  /* put a root's lines back to plain GL lines (the lighter rendering) */
  function unwiden(root) {
    if (!root) return 0;
    const had = [];
    root.traverse(o => { if (o.userData && o.userData._wide) had.push(o); });
    for (const o of had) {
      const m = o.userData._wide;
      o.remove(m);
      m.geometry.dispose(); m.material.dispose();
      delete o.userData._wide;
      o.material.visible = true;
    }
    return had.length;
  }

  /* the drawing buffer's size in device pixels, and the pixel ratio the widths are scaled by */
  function setViewport(wPx, hPx, pixelRatio) {
    U.uRes.value.set(Math.max(1, wPx), Math.max(1, hPx));
    U.uPR.value = pixelRatio || 1;
  }
  function count(root) { let n = 0; if (root) root.traverse(o => { if (o.userData && o.userData.wide) n++; }); return n; }
  function stats() { return { made, res: [U.uRes.value.x, U.uRes.value.y], pr: U.uPR.value }; }

  return { widen, unwiden, wideFor, setViewport, count, stats };
})();
