/* SBMM Site Explorer — built features in 3D (v43).

   EA's CAD carries the buildings as footprints, the fences as lines and the
   power poles as points, and until now the 3D view drew them as exactly that:
   an outline lying on the ground where a house stands, a line where a fence
   runs, a dot at the foot of a pole. This file stands them up.

     buildings   each footprint extruded from the ground to a height measured
                 by lidar (the canopy model inside the footprint, baked by
                 tools/build_trees.py), with a pitched roof where the footprint
                 is a plain rectangle, in the roof's own colour off the aerial
                 photograph (baked by the same tool)
     fences      a wire panel 4.5 ft high on posts every 8 ft, following the
                 ground
     poles       a pole and a crossarm at every point EA calls a power pole

   WHAT IS MEASURED AND WHAT IS NOT. A building's footprint is EA's, its
   height is the lidar's and its roof colour is the photograph's. Its roof
   SHAPE is not surveyed: a rectangle gets a gable along its long side, at a
   common pitch, and anything else a flat roof. A footprint the lidar finds
   nothing standing in stays the outline it was. A fence's line is EA's and its
   height is a typical one; a pole's position is EA's and its height is a
   typical one. js/popups.js says the same thing the 2D map says about each —
   nothing here adds an attribute.

   Everything a builder returns is one or two draw calls, carries the layer's
   own pick (the triangle a click hits maps back to EA's feature through
   `owner`), and is built once per overlay rebuild. Nothing asks for a frame. */
"use strict";

SBMM.built3d = (function () {

  const WALL = [0.60, 0.58, 0.53];          // linear: a light, warm wall
  const MIN_H = 5, MAX_AREA = 15000, EAVE_OUT = 1.3, GABLE_OUT = 1.0;
  const ROOF_DEFAULT = [0.20, 0.18, 0.17];
  const POLE_H = 34, FENCE_H = 4.5, POST_EVERY = 8;

  const srgb = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

  /* EA's geometry object -> { h_ft, rgb } (tools/build_trees.py) */
  let recs = null;
  function records() {
    if (recs) return recs;
    recs = new Map();
    const T = window.SBMM_DATA && SBMM_DATA.trees_site, G = window.SBMM_DATA && SBMM_DATA.design_gis;
    if (T && T.buildings && G && G.features)
      for (const b of T.buildings) { const f = G.features[b.feature]; if (f && f.geometry) recs.set(f.geometry, b); }
    return recs;
  }

  /* a triangle soup with a colour per vertex and an owner per triangle */
  function soup() {
    const pos = [], col = [], own = [];
    const tri = (a, b, c, k, o) => {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      col.push(k[0], k[1], k[2], k[0], k[1], k[2], k[0], k[1], k[2]);
      own.push(o);
    };
    const quad = (a, b, c, d, k, o) => { tri(a, b, c, k, o); tri(a, c, d, k, o); };
    const mesh = (matOpts) => {
      if (!own.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();                // non-indexed: one normal per face
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true, side: THREE.DoubleSide }, matOpts || {})));
      m.userData.owner = own.length < 65536 ? Uint16Array.from(own) : Uint32Array.from(own);
      return m;
    };
    return { tri, quad, mesh, count: () => own.length };
  }

  function cleanRing(ring) {
    const r = ring.map(q => [q[0], q[1]]);
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    let a = 0;
    for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
    if (a < 0) r.reverse();                    // counter-clockwise: the outside is to the right of every edge
    return { r, area: Math.abs(a / 2) };
  }

  /* the eave height and the roof's rise for a footprint. The baked height is
     the 75th percentile of the canopy model inside the footprint: the roof
     where the footprint is open to the sky, a tree where one overhangs it —
     which is what the clamp is for. */
  function heightsFor(rec, area, shortSide, pitched) {
    const h = rec && rec.h_ft > 0 ? rec.h_ft : 10;
    const small = area < 250;
    const rise = pitched ? Math.min(small ? 2.5 : 7, shortSide * 0.2) : 0;
    const eave = small ? clamp(h - rise / 2, 6.5, 10) : clamp(h - rise / 2, 7.5, 22);
    return { eave, rise };
  }

  /* items: js/designgis.js batch3d() lines of the `bldg` layer.
     -> { mesh, rest, n }: the solids, and the items that are not a footprint
        (open linework, inner rings), which the caller still drapes as lines */
  function buildings(items, ctx) {
    const R = records(), S = soup(), rest = [], used = [];
    for (const it of items) {
      const g = it.geom;
      if (!it.closed || !g || g.type !== "Polygon" || g.coordinates[0] !== it.ring) { rest.push(it); continue; }
      const { r, area } = cleanRing(it.ring);
      if (r.length < 3 || area < 20) { rest.push(it); continue; }
      const rec = R.get(g);
      /* NOT A BUILDING: a footprint the lidar finds nothing standing in, or
         one larger than any building on this site (EA's layer carries a
         3.9-acre enclosure outline). Those stay the outline they were. */
      if (area > MAX_AREA || (rec && !(rec.h_ft >= MIN_H))) { rest.push(it); continue; }
      const gz = r.map(q => ctx.elev(q[0], q[1]));
      const ok = gz.filter(z => !isNaN(z));
      if (!ok.length) { rest.push(it); continue; }
      const gmean = ok.reduce((a, b) => a + b, 0) / ok.length, gmin = Math.min(...ok);
      const P = r.map(q => [q[0] - ctx.CX, q[1] - ctx.CY]);
      const quadFoot = r.length === 4;
      const e01 = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), e12 = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
      const { eave, rise } = heightsFor(rec, area, Math.min(e01, e12), quadFoot);
      const zb = gmin - 1.5 - ctx.ZMID, ze = gmean + eave - ctx.ZMID, zr = ze + rise;
      const roof = rec && rec.rgb ? [srgb(rec.rgb[0]) * 0.9, srgb(rec.rgb[1]) * 0.9, srgb(rec.rgb[2]) * 0.9] : ROOF_DEFAULT;
      const wall = [WALL[0] * 0.88 + roof[0] * 0.12, WALL[1] * 0.88 + roof[1] * 0.12, WALL[2] * 0.88 + roof[2] * 0.12];
      const under = [roof[0] * 0.55, roof[1] * 0.55, roof[2] * 0.55];        // the underside of the eaves
      const o = used.length;
      used.push(it);
      const n = P.length;
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n];
        S.quad([a[0], a[1], zb], [b[0], b[1], zb], [b[0], b[1], ze], [a[0], a[1], ze], wall, o);
      }
      if (quadFoot && rise > 0.3) {
        /* a gable along the long side: the ridge joins the middles of the two
           short sides, and the roof oversails the walls — past the long walls
           down its own slope, past the gable ends level — because a roof that
           stops flush with the wall reads as a block, not a house */
        const s = e01 >= e12 ? 0 : 1;
        const p0 = P[s], p1 = P[(s + 1) % 4], p2 = P[(s + 2) % 4], p3 = P[(s + 3) % 4];
        const short = Math.min(e01, e12), small = area < 250;
        const eo = small ? 0.6 : EAVE_OUT, go = small ? 0.5 : GABLE_OUT;
        const drop = rise * eo / (short / 2);
        const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
        const u = unit(p0, p1);                         // along the ridge
        const out01 = [u[1], -u[0]];                    // counter-clockwise ring: the outside is to the right
        const u2 = unit(p2, p3), out23 = [u2[1], -u2[0]];
        const m12 = [(p1[0] + p2[0]) / 2 + u[0] * go, (p1[1] + p2[1]) / 2 + u[1] * go, zr];
        const m30 = [(p3[0] + p0[0]) / 2 - u[0] * go, (p3[1] + p0[1]) / 2 - u[1] * go, zr];
        const e = (p, o, k) => [p[0] + o[0] * eo + u[0] * go * k, p[1] + o[1] * eo + u[1] * go * k, ze - drop];
        const a0 = e(p0, out01, -1), a1 = e(p1, out01, 1), a2 = e(p2, out23, 1), a3 = e(p3, out23, -1);
        S.quad(a0, a1, m12, m30, roof, o);
        S.quad(a2, a3, m30, m12, roof, o);
        /* the undersides, a hand lower, so the oversail has a shadowed soffit rather than a paper edge */
        const lo = p => [p[0], p[1], p[2] - 0.35];
        S.quad(lo(a1), lo(a0), lo(m30), lo(m12), under, o);
        S.quad(lo(a3), lo(a2), lo(m12), lo(m30), under, o);
        const v = p => [p[0], p[1], ze];
        S.tri(v(p1), v(p2), [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, zr], wall, o);
        S.tri(v(p3), v(p0), [(p3[0] + p0[0]) / 2, (p3[1] + p0[1]) / 2, zr], wall, o);
      } else {
        const tris = THREE.ShapeUtils.triangulateShape(P.map(p => new THREE.Vector2(p[0], p[1])), []);
        /* a flat roof behind a low parapet: the walls run 1 ft past the roof deck */
        for (const t of tris) {
          let a = P[t[0]], b = P[t[1]], c = P[t[2]];
          if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) { const x = b; b = c; c = x; }
          S.tri([a[0], a[1], ze - 1], [b[0], b[1], ze - 1], [c[0], c[1], ze - 1], roof, o);
        }
      }
    }
    const mesh = S.mesh();
    if (mesh) {
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.pick = { kind: "gisSolid", items: used };
    }
    return { mesh, rest, n: used.length };
  }

  /* the wire of a fence: a tile of chain link with a top rail, mostly air */
  let wireTex = null;
  function wireTexture() {
    if (wireTex) return wireTex;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = "rgba(205,210,214,0.85)";
    g.lineWidth = 1.6;
    for (let k = -64; k <= 128; k += 16) {
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 64, 64); g.stroke();
      g.beginPath(); g.moveTo(k + 64, 0); g.lineTo(k, 64); g.stroke();
    }
    g.fillStyle = "rgba(190,196,200,1)";
    g.fillRect(0, 0, 64, 3);                               // the top rail
    wireTex = new THREE.CanvasTexture(c);
    wireTex.wrapS = THREE.RepeatWrapping; wireTex.wrapT = THREE.ClampToEdgeWrapping;
    wireTex.colorSpace = THREE.SRGBColorSpace;
    wireTex.anisotropy = 4;
    return wireTex;
  }

  /* items: batch3d() lines of the `fence` layer -> { group, n, posts, ft } */
  function fences(items, ctx) {
    const pos = [], uv = [], idx = [], own = [], posts = [];
    let ft = 0;
    items.forEach((it, o) => {
      const ring = it.closed ? it.ring.concat([it.ring[0]]) : it.ring;
      let run = [], d = 0;
      const flush = () => {
        if (run.length > 1) {
          const base = pos.length / 3;
          run.forEach(s => {
            pos.push(s[0], s[1], s[2] + 0.15, s[0], s[1], s[2] + FENCE_H);
            uv.push(s[3] / 2.5, 0, s[3] / 2.5, 1);
            posts.push(s);
          });
          for (let i = 0; i < run.length - 1; i++) {
            const a = base + i * 2;
            idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
            own.push(o, o);
          }
        }
        run = [];
      };
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i], b = ring[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.01) continue;
        const n = Math.max(1, Math.round(L / POST_EVERY));
        for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
          const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n, z = ctx.elev(x, y);
          if (k > 0 || i > 0) d += L / n;
          if (isNaN(z)) { flush(); continue; }         // a fence does not cross ground the lidar never saw
          run.push([x - ctx.CX, y - ctx.CY, z - ctx.ZMID, d]);
        }
        ft += L;
      }
      flush();
    });
    if (!idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const wire = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      map: wireTexture(), transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false }));
    wire.userData.owner = own.length < 65536 ? Uint16Array.from(own) : Uint32Array.from(own);
    wire.userData.pick = { kind: "gisSolid", items };
    wire.renderOrder = 2;
    const pg = new THREE.BoxGeometry(0.32, 0.32, 1);
    pg.translate(0, 0, 0.5);
    const pm = new THREE.InstancedMesh(pg, new THREE.MeshLambertMaterial({ color: 0x6f757a }), posts.length);
    const M = new THREE.Matrix4();
    posts.forEach((s, i) => { M.makeScale(1, 1, FENCE_H + 0.35); M.setPosition(s[0], s[1], s[2]); pm.setMatrixAt(i, M); });
    pm.instanceMatrix.needsUpdate = true;
    pm.castShadow = true;
    pm.frustumCulled = false;
    const group = new THREE.Group();
    group.add(wire); group.add(pm);
    return { group, wire, posts: pm, n: items.length, nPosts: posts.length, ft: Math.round(ft) };
  }

  /* points: batch3d() points of the `util` layer.
     -> { mesh, rest, n }: a pole at each power pole; every other point is left to the caller's dots */
  function poles(points, ctx) {
    const isPole = q => /power pole/i.test((q.props && q.props.name) || "");
    const P = points.filter(isPole), rest = points.filter(q => !isPole(q));
    if (!P.length) return { mesh: null, rest: points, n: 0 };
    const S = soup(), WOOD = [0.115, 0.085, 0.060], ARM = [0.095, 0.075, 0.055];
    const shaft = new THREE.CylinderGeometry(0.34, 0.5, POLE_H, 7, 1, false).toNonIndexed();
    shaft.rotateX(Math.PI / 2); shaft.translate(0, 0, POLE_H / 2);
    const arm = new THREE.BoxGeometry(8, 0.36, 0.45).toNonIndexed();
    arm.translate(0, 0, POLE_H - 2.2);
    const add = (geo, ox, oy, oz, ang, k, o) => {
      const a = geo.getAttribute("position").array, c = Math.cos(ang), s = Math.sin(ang);
      const v = i => [ox + a[i] * c - a[i + 1] * s, oy + a[i] * s + a[i + 1] * c, oz + a[i + 2]];
      for (let i = 0; i < a.length; i += 9) S.tri(v(i), v(i + 3), v(i + 6), k, o);
    };
    const used = [];
    P.forEach(q => {
      const z = ctx.elev(q.x, q.y);
      if (isNaN(z)) { rest.push(q); return; }
      /* the crossarm stands square to the line of poles: square to the nearest other pole */
      let best = Infinity, ang = 0;
      for (const w of P) {
        if (w === q) continue;
        const d = Math.hypot(w.x - q.x, w.y - q.y);
        if (d < best) { best = d; ang = Math.atan2(w.y - q.y, w.x - q.x) + Math.PI / 2; }
      }
      const o = used.length;
      used.push(q);
      add(shaft, q.x - ctx.CX, q.y - ctx.CY, z - ctx.ZMID - 0.5, 0, WOOD, o);
      add(arm, q.x - ctx.CX, q.y - ctx.CY, z - ctx.ZMID - 0.5, ang, ARM, o);
    });
    shaft.dispose(); arm.dispose();
    const mesh = S.mesh();
    if (mesh) { mesh.castShadow = true; mesh.userData.pick = { kind: "gisSolid", items: used, points: true }; }
    return { mesh, rest, n: used.length };
  }

  return { buildings, fences, poles, records, POLE_H, FENCE_H };
})();
