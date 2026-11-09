/* SBMM Site Explorer — trees in 3D (v39).

   Before this the 3D view drew the canopy as ONE draped sheet coloured by
   height and one dot per tree. This file draws each tree: a trunk and a crown
   sized from that tree's own lidar measurements (height, crown radius), in
   one of three forms the crown's shape decides (broadleaf / conifer / brush),
   coloured from the orthophoto under it, with a soft shadow on the ground
   that follows the sun control.

   HOW IT STAYS CHEAP.

     * INSTANCED. Every tree of one form at one level of detail is a single
       THREE.InstancedMesh — nine draw calls for the whole site, plus one for
       the shadows, however many thousand trees there are.
     * THREE LEVELS OF DETAIL, chosen by distance from the camera with a cap on
       how many trees may be at each (NEAR / MID in LIMITS): ~570 triangles
       near, ~90 further out, ~24 beyond that. The levels are re-dealt only
       when the camera has travelled (relod()), inside a frame that is being
       drawn anyway — it never asks for a frame of its own, so an idle view
       still renders nothing.
     * NO TEXTURES AND NO FILES. The three forms are generated here from a few
       seeded lobes; the variety between trees is the instance's own scale,
       rotation and colour.

   The geometry is in unit space — crown radius 1, height 1, base at z = 0 —
   and the instance matrix carries the tree's radius and height, so a tree is
   as wide and as tall as the lidar says it is. The group it is added to
   carries the relief exaggeration like every other overlay, so trees stretch
   with the terrain they stand on.

   The far level is not pickable (a tree two thousand feet away is a few
   pixels); the near and mid levels answer a click with the tree's popup. */
"use strict";

SBMM.trees3d = (function () {

  const NAMES = ["broadleaf", "conifer", "brush"];
  const LIMITS = {
    full: { near: 700, nearFt: 700, mid: 4500, midFt: 3200 },
    light: { near: 0, nearFt: 0, mid: 1200, midFt: 1500 }
  };

  let cur = null;          // the live build: { group, td, sets, shadow, ... }

  /* ------------------------------------------------------------------ */
  /* small deterministic helpers                                          */
  /* ------------------------------------------------------------------ */
  function hash(i, k) {
    let h = (i * 374761393 + k * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function lump(x, y, z, ph) {
    return 0.50 * Math.sin(x * 3.1 + ph) * Math.sin(y * 2.7 + ph * 1.7)
         + 0.30 * Math.sin(z * 4.3 + ph * 0.6) * Math.sin(x * 1.9 - ph)
         + 0.20 * Math.sin((x + y + z) * 5.3 + ph * 2.1);
  }

  /* a unit icosphere, indexed, so normals come out smooth */
  function icosphere(detail) {
    const t = (1 + Math.sqrt(5)) / 2;
    let pos = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
               t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
    let idx = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
               3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
    const norm = () => {
      for (let i = 0; i < pos.length; i += 3) {
        const l = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
        pos[i] /= l; pos[i + 1] /= l; pos[i + 2] /= l;
      }
    };
    norm();
    for (let d = 0; d < detail; d++) {
      const mid = new Map(), out = [];
      const m = (a, b) => {
        const key = a < b ? a * 65536 + b : b * 65536 + a;
        let v = mid.get(key);
        if (v == null) {
          v = pos.length / 3;
          pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
          mid.set(key, v);
        }
        return v;
      };
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i], b = idx[i + 1], c = idx[i + 2];
        const ab = m(a, b), bc = m(b, c), ca = m(c, a);
        out.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
      }
      idx = out;
      norm();
    }
    return { pos, idx };
  }

  /* collects parts into one indexed geometry with a shade colour per vertex */
  function Parts() {
    const P = [], C = [], I = [];
    return {
      /* a lumpy ellipsoid: centre, radii, lumpiness, phase, shade(z01) -> [r,g,b] */
      blob(detail, cx, cy, cz, rx, ry, rz, amp, ph, shade) {
        const s = icosphere(detail), base = P.length / 3;
        for (let i = 0; i < s.pos.length; i += 3) {
          const x = s.pos[i], y = s.pos[i + 1], z = s.pos[i + 2];
          let k = 1 + amp * lump(x * 2.1, y * 2.1, z * 2.1, ph) + amp * 0.45 * lump(x * 5.2, y * 5.2, z * 5.2, ph + 4);
          /* a crown is flatter underneath than on top */
          const zz = z < 0 ? z * 0.72 : z;
          P.push(cx + x * rx * k, cy + y * ry * k, cz + zz * rz * k);
          /* a mottle per vertex: foliage is clumps of lit and shaded leaf, and a
             smooth gradient over a smooth blob reads as a balloon */
          const c = shade((z + 1) / 2, x, y), m = 0.86 + 0.28 * hash(i + base * 7, 17 + Math.round(ph * 10));
          C.push(c[0] * m, c[1] * m, c[2] * m);
        }
        for (let i = 0; i < s.idx.length; i++) I.push(base + s.idx[i]);
      },
      /* a tapered n-gon column from z0 to z1 */
      column(n, r0, r1, z0, z1, col, bend) {
        const base = P.length / 3;
        for (let k = 0; k <= 1; k++)
          for (let i = 0; i < n; i++) {
            const a = i / n * Math.PI * 2, r = k ? r1 : r0;
            P.push(Math.cos(a) * r + (k ? (bend || 0) : 0), Math.sin(a) * r, k ? z1 : z0);
            C.push(col[0] * (k ? 1 : 0.8), col[1] * (k ? 1 : 0.8), col[2] * (k ? 1 : 0.8));
          }
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          I.push(base + i, base + j, base + n + i, base + j, base + n + j, base + n + i);
        }
      },
      /* one tier of a conifer: a ragged skirt from a ring up to a point */
      tier(n, r, z0, z1, droop, ph, shade) {
        const base = P.length / 3;
        for (let i = 0; i < n; i++) {
          const a = i / n * Math.PI * 2 + ph;
          const k = 1 + 0.16 * Math.sin(i * 2.4 + ph * 3) + 0.08 * Math.sin(i * 5.1 + ph);
          P.push(Math.cos(a) * r * k, Math.sin(a) * r * k, z0 - droop * (0.6 + 0.4 * Math.sin(i * 1.7 + ph)));
          const c = shade(0); C.push(c[0], c[1], c[2]);
        }
        /* an inner ring a little way up and in, so the skirt has a belly */
        for (let i = 0; i < n; i++) {
          const a = (i + 0.5) / n * Math.PI * 2 + ph;
          P.push(Math.cos(a) * r * 0.58, Math.sin(a) * r * 0.58, z0 + (z1 - z0) * 0.36);
          const c = shade(0.5); C.push(c[0], c[1], c[2]);
        }
        P.push(0, 0, z1);
        { const c = shade(1); C.push(c[0], c[1], c[2]); }
        const top = base + 2 * n;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          I.push(base + i, base + j, base + n + i, base + j, base + n + j, base + n + i);
          I.push(base + n + i, base + n + j, top);
        }
        /* closed underneath, darker: the shaded inside of the tier */
        const ctr = P.length / 3;
        P.push(0, 0, z0 + (z1 - z0) * 0.10);
        { const c = shade(0); C.push(c[0] * 0.55, c[1] * 0.55, c[2] * 0.55); }
        for (let i = 0; i < n; i++) I.push(base + (i + 1) % n, base + i, ctr);
      },
      geometry() {
        /* normalise to the unit box: widest point at radius 1, top at z = 1 */
        let rmax = 0, zmax = 0;
        for (let i = 0; i < P.length; i += 3) {
          rmax = Math.max(rmax, Math.hypot(P[i], P[i + 1]));
          zmax = Math.max(zmax, P[i + 2]);
        }
        for (let i = 0; i < P.length; i += 3) { P[i] /= rmax; P[i + 1] /= rmax; P[i + 2] /= zmax; }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
        g.setIndex(I);
        g.computeVertexNormals();
        return g;
      }
    };
  }

  const TRUNK = [0.52, 0.41, 0.33];
  /* foliage shade: dark underneath and inside, full colour on top */
  /* Dark underneath and inside, a little over full colour on top. With the
     v40 lighting a level sunlit surface returns its albedo, so these sit
     around 1 (before v40 the scene ran at half brightness and they were
     doubled to compensate). */
  const leaf = (lo, hi) => z01 => {
    const s = 0.42 + 0.86 * (lo + (hi - lo) * Math.pow(clamp(z01, 0, 1), 0.8));
    return [s, s * 1.02, s * 0.96];
  };

  /* form f at level of detail lod (0 near, 1 mid, 2 far) */
  function geometryFor(f, lod) {
    const p = Parts();
    if (f === 0) {                                   // broadleaf: a trunk and a lobed dome
      if (lod === 0) {
        p.column(7, 0.085, 0.055, 0, 0.50, TRUNK, 0.02);
        p.blob(2, 0, 0, 0.64, 0.86, 0.86, 0.36, 0.17, 1.3, leaf(0.50, 1.04));
        p.blob(1, 0.44, 0.10, 0.56, 0.52, 0.50, 0.25, 0.20, 2.9, leaf(0.46, 0.96));
        p.blob(1, -0.30, 0.38, 0.60, 0.50, 0.52, 0.27, 0.20, 5.1, leaf(0.48, 1.0));
        p.blob(1, -0.14, -0.44, 0.52, 0.54, 0.50, 0.24, 0.20, 7.7, leaf(0.44, 0.94));
      } else if (lod === 1) {
        p.column(4, 0.085, 0.055, 0, 0.50, TRUNK);
        p.blob(1, 0, 0, 0.62, 1, 1, 0.38, 0.20, 1.3, leaf(0.50, 1.02));
      } else {
        p.column(3, 0.085, 0.06, 0, 0.45, TRUNK);
        p.blob(0, 0, 0, 0.62, 1, 1, 0.38, 0, 0, leaf(0.55, 1.0));
      }
    } else if (f === 1) {                            // conifer: a tall trunk and stacked skirts
      const sh = leaf(0.52, 1.0);
      if (lod === 0) {
        p.column(6, 0.07, 0.02, 0, 0.92, TRUNK);
        p.tier(11, 1.00, 0.22, 0.52, 0.035, 0.0, sh);
        p.tier(10, 0.80, 0.40, 0.68, 0.030, 0.9, sh);
        p.tier(9, 0.60, 0.56, 0.82, 0.025, 1.7, sh);
        p.tier(8, 0.40, 0.70, 0.93, 0.020, 2.6, sh);
        p.tier(7, 0.22, 0.83, 1.00, 0.015, 3.3, sh);
      } else if (lod === 1) {
        p.column(4, 0.07, 0.02, 0, 0.9, TRUNK);
        p.tier(7, 1.00, 0.22, 0.58, 0.03, 0.0, sh);
        p.tier(6, 0.66, 0.50, 0.82, 0.025, 1.2, sh);
        p.tier(5, 0.34, 0.74, 1.00, 0.02, 2.3, sh);
      } else {
        p.column(3, 0.07, 0.03, 0, 0.3, TRUNK);
        p.tier(5, 1.00, 0.20, 1.00, 0.0, 0.0, sh);
      }
    } else {                                         // brush: a low ragged mound, no trunk
      if (lod === 0) {
        p.blob(1, 0, 0, 0.42, 0.95, 0.95, 0.55, 0.24, 3.7, leaf(0.50, 1.0));
        p.blob(1, 0.40, -0.22, 0.30, 0.55, 0.55, 0.36, 0.22, 6.4, leaf(0.46, 0.94));
      } else if (lod === 1) {
        p.blob(1, 0, 0, 0.40, 1, 1, 0.56, 0.20, 3.7, leaf(0.50, 1.0));
      } else {
        p.blob(0, 0, 0, 0.40, 1, 1, 0.56, 0, 0, leaf(0.55, 1.0));
      }
    }
    return p.geometry();
  }

  /* a soft round shadow: dark in the middle, nothing at the rim. Twelve
     triangles — there is one per tree, and at twenty-four thousand trees a
     finer disc costs more triangles than the trees themselves. */
  function shadowGeometry() {
    const n = 12, P = [0, 0, 0], C = [0, 0, 0, 0.46], I = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      P.push(Math.cos(a), Math.sin(a), 0);
      C.push(0, 0, 0, 0);
    }
    for (let i = 0; i < n; i++) I.push(0, 1 + i, 1 + (i + 1) % n);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(C, 4));
    g.setIndex(I);
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* colour                                                              */
  /* ------------------------------------------------------------------ */
  /* ONE colour rule, shared with the 2D crowns: SBMM.trees.rgbOf (the ortho
     sets the hue and the variety, the form sets the base). Here it is only
     converted into the renderer's working colour space. */
  const TC = new THREE.Color(), RGB = [0, 0, 0];
  function colourOf(td, i, out) {
    SBMM.trees.rgbOf(td, i, RGB);
    return out.setRGB(RGB[0] / 255, RGB[1] / 255, RGB[2] / 255, THREE.SRGBColorSpace);
  }

  /* ------------------------------------------------------------------ */
  /* build                                                               */
  /* ------------------------------------------------------------------ */
  /* td: SBMM.trees.data. ctx: { CX, CY, ZMID, sunAz, sunEl, light, minShow } */
  function build(td, ctx) {
    dispose();
    if (!td || !td.n) return null;
    const n = td.n, lim = ctx.light ? LIMITS.light : LIMITS.full;
    const group = new THREE.Group();

    /* per tree, once: ground height, ground normal, scene position */
    if (!td._gz || td._gz.length !== n) {
      const gz = new Float32Array(n), nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const x = td.x[i], y = td.y[i], [z] = SBMM.elev(x, y);
        gz[i] = z;
        const d = Math.max(3, td.radius[i] * 0.6);
        const [ze] = SBMM.elev(x + d, y), [zw] = SBMM.elev(x - d, y), [zn] = SBMM.elev(x, y + d), [zs] = SBMM.elev(x, y - d);
        let nx = 0, ny = 0;
        if (!isNaN(ze) && !isNaN(zw)) nx = -(ze - zw) / (2 * d);
        if (!isNaN(zn) && !isNaN(zs)) ny = -(zn - zs) / (2 * d);
        const l = Math.hypot(nx, ny, 1);
        nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = 1 / l;
      }
      td._gz = gz; td._nrm = nrm;
    }

    const count = [0, 0, 0];
    const show = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (isNaN(td._gz[i]) || td.h[i] < ctx.minShow) continue;
      show[i] = 1; count[td.form ? td.form[i] : 0]++;
    }

    const sets = [];        // sets[form][lod] = { mesh, idx }
    for (let f = 0; f < 3; f++) {
      const row = [];
      for (let lod = 0; lod < 3; lod++) {
        const cap = lod === 0 ? Math.min(count[f], lim.near) : lod === 1 ? Math.min(count[f], lim.mid) : count[f];
        if (!cap) { row.push(null); continue; }
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
        const mesh = new THREE.InstancedMesh(geometryFor(f, lod), mat, cap);
        mesh.count = 0;
        mesh.frustumCulled = false;                  // one mesh spans the site
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, TC.setRGB(1, 1, 1));      // allocates instanceColor
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        const idx = new Int32Array(cap);
        mesh.userData.treeIdx = idx;
        mesh.userData.treeLod = lod; mesh.userData.treeForm = NAMES[f];
        if (lod < 2) mesh.userData.pick = { kind: "tree" };
        /* v40: a tree throws a shadow and does not take one — a shadow map
           across a few hundred triangles of crown is acne, and the crown's own
           shading already says which side the sun is on */
        mesh.castShadow = !!ctx.castShadows;
        group.add(mesh);
        row.push({ mesh, idx });
      }
      sets.push(row);
    }

    let shadow = null;
    const total = count[0] + count[1] + count[2];
    /* the soft discs are the shadow where there is no shadow map (standard
       rendering); with one, the trees cast their own */
    if (total && !ctx.castShadows) {
      shadow = new THREE.InstancedMesh(shadowGeometry(), new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }), total);
      shadow.frustumCulled = false;
      shadow.renderOrder = 1;
      shadow.userData.treeShadow = true;
      group.add(shadow);
    }

    cur = { group, td, sets, shadow, show, lim, CX: ctx.CX, CY: ctx.CY, ZMID: ctx.ZMID,
            lodAt: null, counts: [0, 0, 0], total, sun: [ctx.sunAz, ctx.sunEl] };
    layShadows();
    return group;
  }

  /* ------------------------------------------------------------------ */
  /* levels of detail                                                    */
  /* ------------------------------------------------------------------ */
  const M = new THREE.Matrix4();
  function matrixFor(td, i, c) {
    const r = td.radius[i], h = td.h[i];
    const a = hash(i, 1) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    const sx = r * (0.92 + 0.16 * hash(i, 2)), sy = r * (0.92 + 0.16 * hash(i, 3));
    const e = M.elements;
    e[0] = ca * sx; e[1] = sa * sx; e[2] = 0; e[3] = 0;
    e[4] = -sa * sy; e[5] = ca * sy; e[6] = 0; e[7] = 0;
    e[8] = 0; e[9] = 0; e[10] = h; e[11] = 0;
    e[12] = td.x[i] - c.CX; e[13] = td.y[i] - c.CY; e[14] = td._gz[i] - c.ZMID - 0.4; e[15] = 1;
    return M;
  }

  /* deal every tree to a level by its distance from the camera. camPos is in
     scene units; zx is the relief exaggeration the group is drawn at. Returns
     true when the deal was redone (the caller is already drawing a frame). */
  function relod(camPos, zx, force) {
    const c = cur;
    if (!c) return false;
    if (!force && c.lodAt) {
      const moved = Math.hypot(camPos.x - c.lodAt[0], camPos.y - c.lodAt[1], camPos.z - c.lodAt[2]);
      /* re-deal once the camera has gone a fifth of the way across the near ring */
      if (moved < Math.max(40, c.lodDist * 0.2)) return false;
    }
    const td = c.td, n = td.n, lim = c.lim;
    const d = c.dist || (c.dist = new Float32Array(n));
    /* a histogram of distances finds the two cut-offs in one pass, no sort */
    const NB = 48, hist = new Int32Array(NB), top = Math.max(lim.midFt, 1);
    let dmin = Infinity;
    for (let i = 0; i < n; i++) {
      if (!c.show[i]) continue;
      const dx = td.x[i] - c.CX - camPos.x, dy = td.y[i] - c.CY - camPos.y,
            dz = (td._gz[i] - c.ZMID) * zx - camPos.z;
      const di = Math.sqrt(dx * dx + dy * dy + dz * dz);
      d[i] = di;
      if (di < dmin) dmin = di;
      if (di < top) hist[Math.floor(di / top * NB)]++;
    }
    let nearCut = 0, midCut = 0, acc = 0;
    for (let b = 0; b < NB; b++) {
      acc += hist[b];
      const edge = (b + 1) / NB * top;
      if (acc <= lim.near && edge <= lim.nearFt) nearCut = edge;
      if (acc <= lim.mid) midCut = edge;
    }
    const fill = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
      if (!c.show[i]) continue;
      const f = td.form ? td.form[i] : 0, row = c.sets[f];
      let lod = d[i] < nearCut ? 0 : d[i] < midCut ? 1 : 2;
      /* a level that is full, or was never built, hands the tree down */
      while (lod < 2 && (!row[lod] || fill[f][lod] >= row[lod].idx.length)) lod++;
      const s = row[lod];
      if (!s) continue;
      const k = fill[f][lod]++;
      s.idx[k] = i;
      s.mesh.setMatrixAt(k, matrixFor(td, i, c));
      s.mesh.setColorAt(k, colourOf(td, i, TC));
    }
    c.counts = [0, 0, 0];
    for (let f = 0; f < 3; f++)
      for (let lod = 0; lod < 3; lod++) {
        const s = c.sets[f][lod];
        if (!s) continue;
        s.mesh.count = fill[f][lod];
        s.mesh.instanceMatrix.needsUpdate = true;
        if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true;
        s.mesh.boundingSphere = null; s.mesh.boundingBox = null;   // the raycast recomputes them
        c.counts[lod] += fill[f][lod];
      }
    c.lodAt = [camPos.x, camPos.y, camPos.z];
    c.lodDist = Math.max(nearCut, isFinite(dmin) ? dmin : 0, 200);
    c.relods = (c.relods || 0) + 1;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* shadows                                                             */
  /* ------------------------------------------------------------------ */
  /* One soft ellipse per tree, lying on the ground's own slope, thrown away
     from the sun and stretched by how low the sun is. */
  function layShadows() {
    const c = cur;
    if (!c || !c.shadow) return;
    const td = c.td, n = td.n;
    const az = c.sun[0] * Math.PI / 180, el = clamp(c.sun[1], 8, 85) * Math.PI / 180;
    /* the light comes FROM the azimuth, so the shadow falls the other way */
    const ux = -Math.sin(az), uy = -Math.cos(az), cot = 1 / Math.tan(el);
    const e = M.elements;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!c.show[i]) continue;
      const r = td.radius[i], h = td.h[i];
      const nx = td._nrm[i * 3], ny = td._nrm[i * 3 + 1], nz = td._nrm[i * 3 + 2];
      const reach = Math.min(h * 0.55 * cot, r * 2.4);            // how far the crown's shadow is thrown
      const a = r * 1.05 + reach * 0.5, b = r * 1.05;
      /* u = the throw direction laid into the ground plane, v = n x u */
      let tx = ux, ty = uy, tz = -(nx * ux + ny * uy) / nz;
      const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
      const vx = ny * tz - nz * ty, vy = nz * tx - nx * tz, vz = nx * ty - ny * tx;
      const cx = td.x[i] + ux * reach * 0.5, cy = td.y[i] + uy * reach * 0.5;
      const zc = td._gz[i] + tz / Math.max(1e-6, Math.hypot(tx, ty)) * reach * 0.5;
      e[0] = tx * a; e[1] = ty * a; e[2] = tz * a; e[3] = 0;
      e[4] = vx * b; e[5] = vy * b; e[6] = vz * b; e[7] = 0;
      e[8] = nx; e[9] = ny; e[10] = nz; e[11] = 0;
      e[12] = cx - c.CX; e[13] = cy - c.CY; e[14] = zc - c.ZMID + 0.8; e[15] = 1;
      c.shadow.setMatrixAt(k++, M);
    }
    c.shadow.count = k;
    c.shadow.instanceMatrix.needsUpdate = true;
  }
  function setSun(az, el) {
    if (!cur) return;
    cur.sun = [az, el];
    layShadows();
  }

  function dispose() {
    if (!cur) return;
    cur.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
    cur = null;
  }

  function stats() {
    if (!cur) return null;
    let tris = 0;
    cur.group.traverse(o => {
      if (o.isInstancedMesh && o.geometry.index) tris += o.geometry.index.count / 3 * o.count;
    });
    return { trees: cur.total, near: cur.counts[0], mid: cur.counts[1], far: cur.counts[2],
             shadows: cur.shadow ? cur.shadow.count : 0, triangles: Math.round(tris),
             relods: cur.relods || 0, light: cur.lim === LIMITS.light };
  }

  return { build, relod, setSun, dispose, stats, geometryFor, colourOf, NAMES };
})();
