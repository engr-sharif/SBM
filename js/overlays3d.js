/* =====================================================================
   js/overlays3d.js — the PROJECT HALF of the 3D overlay (v60, 5a)

   Every read-only layer the 3D view draws over the ground: the decision
   units, the piles, EA's GIS and CAD, the survey, the site areas, the TEM
   model and its interpretations, the storm network, the drainage maps, the
   datasets and their depth sticks, the samples, the trees, the cultural
   layers, the computed contours. Until v60 this was the middle of one
   1,100-line function in js/viewer3d.js.

   It is built in SECTIONS (see "a layer switch in 3D rebuilds that layer" in
   CLAUDE.md). js/viewer3d.js owns the pass: it decides which sections a pass
   wants, opens each one (SEC), and afterwards merges what the sections
   collected. This file is what goes INSIDE the sections, in two parts, with
   the user's own features (which stay in the viewer) built between them.

   The bodies were moved character for character. What they use from the
   viewer is named ONCE, in begin(): the toolkit (functions and constants),
   the values of this pass, and VIEWER — the five viewer variables a section
   writes. Nothing here keeps state between passes.
   ===================================================================== */
window.SBMM = window.SBMM || {};
SBMM.overlays3d = (function () {
  /* where the open section adds: its group, its drop-shadow sink, its labels,
     its point names — set by SEC() */
  let addG = null, SHW = null, OVL = null, ptCand = null;
  /* the viewer's toolkit */
  let LS, SECT, SHD, addShadow, dotMaterial, drapeZ, drapedBatch, drapedLine, edgeOn, quality, rowLayer, shadowsWanted, tag, tagKey, temTex, temTexture;
  /* this pass */
  let CX, CY, ZMID, camera, sunAz, sunEl, PROJ, wantedWith, wantsPrefix, zx, SEC, VIEWER;

  function begin(C, P) {
    ({ LS, SECT, SHD, addShadow, dotMaterial, drapeZ, drapedBatch, drapedLine, edgeOn, quality, rowLayer, shadowsWanted, tag, tagKey, temTex, temTexture } = C.tools);
    ({ CX, CY, ZMID, camera, sunAz, sunEl } = C.now());
    ({ PROJ, wantedWith, wantsPrefix, zx } = P);
    VIEWER = C.vars;
    SEC = id => {
      const S = P.SEC(id);
      if (!S) return false;
      addG = S.group; SHW = S.shw; OVL = S.ovl; ptCand = S.pts;
      return true;
    };
  }
  function end() { addG = SHW = OVL = ptCand = null; }

  /* the sections built BEFORE the user's features */
  function before() {
    if (SEC("dus") && LS("framework", "dus")) {
      const DU_COLOR = { "DU-1N": 0xE4796A, "DU-1S": 0xE4796A, "DU-2": 0x5B8FF9, "DU-3": 0x4FCE9B };
      const LY = SBMM.layers || {};
      SBMM_DATA.dus.forEach((d, di) => {
        const o = drapedLine(d.ring, DU_COLOR[d.name] || 0xcccccc, true, 3);
        /* v58: the 2D DU's chip and card, from the same two functions */
        o.userData.pick = { kind: "card", title: d.name + " · decision unit",
                            chip: LY.duTip ? LY.duTip(d) : d.name,
                            html: () => SBMM.popups.forDU(d, di) };
        addG.add(tag(addShadow(SHW, o), "framework", "dus"));
      });
    }
    if (SEC("piles") && LS("framework", "piles")) {
      const LY = SBMM.layers || {}, recs = LY.pileRecs || [];
      SBMM_DATA.piles.forEach((p, k) => {
        const traced = (p.name || "").includes("Fig 2");
        const o = drapedLine(p.ring, traced ? 0xE8B34B : 0x8BE04B, true, 3);
        /* v58: the label and pileIndex slot js/layers.js gave this pile, so
           the card is the 2D one byte for byte */
        const rec = recs[k];
        if (rec) o.userData.pick = { kind: "card", title: rec.label + " · waste pile",
                                     chip: LY.pileTip ? LY.pileTip(p, rec.label) : rec.label,
                                     html: () => SBMM.popups.forPile(p, rec.label, rec.idx) };
        addG.add(tag(addShadow(SHW, o), "framework", "piles"));
      });
    }
    /* No 3D "design" master any more: designGIS.rings3d() and CadNative.rings3d()
       already return only the layers whose rows are on, so the 3D view draws the
       design the Layers tree says is showing — nothing more, nothing less. */
    if (SEC("gis") && SBMM.designGIS) {
      for (const r of SBMM.designGIS.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), true, 3);
        /* userData.pick is what js/pick3d.js walks the overlay group for; it is
           the only thing that makes a 3D click able to say what it hit (§8) */
        /* v58: chip = the 2D layer's own tooltip (js/designgis.js tip) */
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom,
                            chip: SBMM.designGIS.tip ? SBMM.designGIS.tip(r.props || {}) : undefined };
        tag(addShadow(SHW, o), "design", "gis_" + ((r.props && r.props.layer) || "design"));
        addG.add(o);
      }
    }
    /* v15 §3.1: the rest of EA's geodatabase — the design LINES (daylight,
       grade, haul) and the boundary / existing-conditions layers, which
       rings3d() never returned. Merged per layer: 580 features, ~10 draw calls,
       and a click still names the feature it hit. */
    if (SBMM.designGIS && SBMM.designGIS.batch3d) {
      /* v43: the buildings, the fences and the power poles stand up
         (js/built3d.js) in place of the outline, the line and the dot */
      const B3 = SBMM.built3d, bctx = { CX, CY, ZMID, elev: (x, y) => SBMM.elev(x, y)[0] };
      /* v60: ONE SECTION PER LAYER ("gisb:<key>") — this is 15 merged layers
         and most of the project half's vertices. A row that went off hands
         back no batch, so its section is opened here and left empty. */
      const BUILT = { bldg: ["buildings"], fence: ["fences", "fencePosts", "fenceFt"], util: ["poles"] };
      const unbuilt = key => { if (VIEWER.builtInfo && BUILT[key]) for (const k of BUILT[key]) delete VIEWER.builtInfo[k]; };
      const batches = wantsPrefix("gisb:") ? SBMM.designGIS.batch3d() : [];
      if (PROJ) VIEWER.builtInfo = null;
      { const have = new Set(batches.map(b => "gisb:" + b.key));
        /* (only one that exists: the polygon layers have no batch at all) */
        for (const id of wantedWith("gisb:")) if (!have.has(id) && SECT.has(id) && SEC(id)) unbuilt(id.slice(5)); }
      for (const b of batches) {
        if (!SEC("gisb:" + b.key)) continue;
        unbuilt(b.key);
        const col = new THREE.Color(b.color || "#cccccc").getHex();
        if (B3) {
          try {
            if (b.key === "bldg") {
              const r = B3.buildings(b.lines, bctx);
              if (r.mesh) { tag(r.mesh, "design", "gis_bldg"); addG.add(r.mesh); b.lines = r.rest;
                            (VIEWER.builtInfo = VIEWER.builtInfo || {}).buildings = r.n; SHD.dirty = true; }
            } else if (b.key === "fence") {
              const r = B3.fences(b.lines, bctx);
              if (r) { tag(r.wire, "design", "gis_fence"); tag(r.posts, "design", "gis_fence"); addG.add(r.group); b.lines = [];
                       Object.assign(VIEWER.builtInfo = VIEWER.builtInfo || {}, { fences: r.n, fencePosts: r.nPosts, fenceFt: r.ft }); SHD.dirty = true; }
            } else if (b.key === "util") {
              const r = B3.poles(b.points, bctx);
              if (r.mesh) { tag(r.mesh, "design", "gis_util"); addG.add(r.mesh); b.points = r.rest;
                            (VIEWER.builtInfo = VIEWER.builtInfo || {}).poles = r.n; SHD.dirty = true; }
            }
          } catch (e) { console.warn("3D built features:", e); }
        }
        if (b.lines.length) {
          const o = drapedBatch(b.lines, col);
          if (o) {
            o.userData.pick = { kind: "gisBatch", items: b.lines };
            tag(o, "design", "gis_" + b.key);
            addG.add(o);
          }
        }
        if (b.points.length) {
          const pos = [];
          for (const q of b.points) pos.push(q.x - CX, q.y - CY, drapeZ(q.x, q.y, 4));
          const gg = new THREE.BufferGeometry();
          gg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          const po = new THREE.Points(gg, dotMaterial({ size: 8, color: col }));
          po.userData.pick = { kind: "gisPts", items: b.points };
          tag(po, "design", "gis_" + b.key);
          addG.add(po);
        }
      }
      if (VIEWER.builtInfo && !Object.keys(VIEWER.builtInfo).length) VIEWER.builtInfo = null;
    }
    /* the August-2026 survey linework (spec §10): the pipes, the sandbag wall
       and the pit contours, draped like the design polygons and pickable */
    if (SEC("survey") && SBMM.survey && SBMM.survey.lines3d) {
      for (const r of SBMM.survey.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom,
                            chip: SBMM.survey.tip ? SBMM.survey.tip(r.props || {}) : undefined };
        tag(addShadow(SHW, o), "invest", "survey_" + ((r.props && r.props.layer) || ""));
        addG.add(o);
      }
    }
    /* v28: the named site areas of SBMM.kmz, outlines draped like the survey */
    if (SEC("siteareas") && SBMM.siteAreas && SBMM.siteAreas.lines3d) {
      for (const r of SBMM.siteAreas.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom,
                            chip: SBMM.siteAreas.tip ? SBMM.siteAreas.tip(r.props || {}) : undefined };
        tag(addShadow(SHW, o), "invest", "site_areas");
        addG.add(o);
      }
    }
    /* v36: the 2026 TEM2Go soundings — a dot at the ground, coloured by the
       sounding's own model at the slice depth — and the depth slice as a sheet
       following the ground at that depth below it. The sheet is under the
       terrain by construction, so it carries noClip and reads through the
       fence clip box's trench. */
    if (SEC("tem") && SBMM.geophys) {
      const tp = SBMM.geophys.points3d();
      if (tp) {
        const pos = [], col = [], c = new THREE.Color();
        for (let i = 0; i < tp.x.length; i++) {
          pos.push(tp.x[i] - CX, tp.y[i] - CY, drapeZ(tp.x[i], tp.y[i], 3));
          c.set(tp.color[i]); col.push(c.r, c.g, c.b);
          const [zt] = SBMM.elev(tp.x[i], tp.y[i]);
          if (!isNaN(zt)) ptCand.push({ key: "pt:tem:" + tp.id[i], text: tp.id[i], x: tp.x[i], y: tp.y[i],
                                        z: zt + 3, color: "#E2BA14", priority: 18, liftPx: 16,
                                        layer: { g: "invest", l: "tem_soundings" } });
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        const po = new THREE.Points(g, dotMaterial({ size: 7, vertexColors: true }));
        po.userData.pick = { kind: "tem" };
        addG.add(tag(po, "invest", "tem_soundings"));
      }
      /* the contractor's "Sounding models": every sounding's own inverted
         model as a column of its layers, from the lidar ground down — ONE
         instanced box, one draw call, instance k = sounding k/nl, layer k%nl */
      const TC = SBMM.geophys.columns3d ? SBMM.geophys.columns3d() : null;
      if (TC) {
        const op = TC.opacity, n = TC.n * TC.nl;
        const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: op < 0.999, opacity: op }), n);
        const mtx = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), sc3 = new THREE.Vector3();
        const col = new THREE.Color();
        for (let i = 0; i < TC.n; i++) {
          const [zl] = SBMM.elev(TC.x[i], TC.y[i]), zg = isNaN(zl) ? TC.z[i] : zl;
          for (let l = 0; l < TC.nl; l++) {
            const k = i * TC.nl + l, th = TC.bot[l] - TC.top[l];
            v3.set(TC.x[i] - CX, TC.y[i] - CY, zg - (TC.top[l] + TC.bot[l]) / 2 - ZMID);
            sc3.set(TC.w, TC.w, th);
            mtx.compose(v3, q4, sc3);
            im.setMatrixAt(k, mtx);
            col.setRGB(TC.color[k * 3], TC.color[k * 3 + 1], TC.color[k * 3 + 2], THREE.SRGBColorSpace);
            im.setColorAt(k, col);
          }
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.renderOrder = 1;
        im.userData.noClip = true;
        im.userData.pick = { kind: "temcol" };
        addG.add(tag(im, "invest", "tem_soundings"));
      }
      /* v36 phase 4: the slice, the stack, the two sections and the voxels,
         from ONE spec the module memoises (SBMM.geophys.model3d) */
      const M = SBMM.geophys.model3d();
      const used = new Set();
      const texOf = cv => { used.add(cv); return temTexture(cv); };
      if (M) {
        const Rr = SBMM.geophys.result();
        const { nx, ny, dx, x0, y0, mask } = Rr;
        if (!VIEWER.temGround || VIEWER.temGround.R !== Rr) {
          const z = new Float32Array(nx * ny);
          for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
            const [zg] = SBMM.elev(x0 + ix * dx, y0 + iy * dx);
            z[iy * nx + ix] = isNaN(zg) ? NaN : zg;
          }
          VIEWER.temGround = { R: Rr, z };
        }
        const G = VIEWER.temGround.z, op = M.opacity;
        const matOf = cv => new THREE.MeshBasicMaterial({ map: texOf(cv), side: THREE.DoubleSide,
          transparent: op < 0.999, opacity: op, depthWrite: op >= 0.999 });
        const put = (m, order) => { m.renderOrder = order; m.userData.noClip = true; addG.add(tag(m, "invest", "tem_slice")); };
        /* a horizontal sheet following the ground at a depth below it */
        /* v52: or, with `elev`, a flat sheet AT that elevation */
        const sheet = (cv, depth, elev) => {
          const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
          for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
            const id = iy * nx + ix, zg = G[id];
            pos[id * 3] = x0 + ix * dx - CX; pos[id * 3 + 1] = y0 + iy * dx - CY;
            pos[id * 3 + 2] = elev != null ? elev - ZMID : (isNaN(zg) ? ZMID : zg) - depth - ZMID;
            uv[id * 2] = ix / (nx - 1); uv[id * 2 + 1] = iy / (ny - 1);
          }
          const ind = [];
          const ok = id => mask[id] && !isNaN(G[id]);
          for (let iy = 0; iy < ny - 1; iy++) for (let ix = 0; ix < nx - 1; ix++) {
            const q = iy * nx + ix, b2 = q + 1, c2 = q + nx, d2 = c2 + 1;
            if (ok(q) && ok(b2) && ok(c2) && ok(d2)) ind.push(q, b2, d2, q, d2, c2);
          }
          if (!ind.length) return null;
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
          g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
          g.setIndex(ind);
          const m = new THREE.Mesh(g, matOf(cv));
          put(m, 2);
          return m;
        };
        /* v53: every surface of the model answers for the point under the
           pointer (js/temprobe.js) — the tag says how it knows its depth */
        if (M.slice) { const m = sheet(M.slice.canvas, M.slice.depth, M.slice.elev);
          if (m) { m.userData.temSlice = true; m.userData.pick = { kind: "temsurf", what: "slice" }; } }
        for (const st of M.stack) { const m = sheet(st.canvas, st.depth); if (m) m.userData.pick = { kind: "temsurf", what: "stack", depth: st.depth }; }
        /* a vertical curtain from the ground down to the deepest layer */
        for (const sc of M.sections) {
          const n = sc.pts.length, NZ = 24, pos = [], uv = [], zg = [];
          for (let a2 = 0; a2 < n; a2++) { const [z] = SBMM.elev(sc.pts[a2][0], sc.pts[a2][1]); zg.push(z); }
          for (let a2 = 0; a2 < n; a2++) for (let k = 0; k <= NZ; k++) {
            const z = (isNaN(zg[a2]) ? ZMID : zg[a2]) - k / NZ * sc.dmax;
            pos.push(sc.pts[a2][0] - CX, sc.pts[a2][1] - CY, z - ZMID);
            uv.push(a2 / (n - 1), 1 - k / NZ);
          }
          const ind = [];
          for (let a2 = 0; a2 < n - 1; a2++) {
            if (!sc.ok[a2] || !sc.ok[a2 + 1] || isNaN(zg[a2]) || isNaN(zg[a2 + 1])) continue;
            for (let k = 0; k < NZ; k++) {
              const q = a2 * (NZ + 1) + k, r2 = q + NZ + 1;
              ind.push(q, r2, r2 + 1, q, r2 + 1, q + 1);
            }
          }
          if (!ind.length) continue;
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
          g.setIndex(ind);
          const sm = new THREE.Mesh(g, matOf(sc.canvas));
          sm.userData.pick = { kind: "temsurf", what: "section" };
          put(sm, 2);
        }
        /* the voxels: ONE instanced box, one draw call */
        const V = M.voxels;
        if (V && V.x.length) {
          const box = new THREE.BoxGeometry(1, 1, 1);
          const im = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff,
            transparent: op < 0.999, opacity: op }), V.x.length);
          const mtx = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), sc3 = new THREE.Vector3();
          const col = new THREE.Color(), s0 = V.size * 0.94;
          for (let i = 0; i < V.x.length; i++) {
            const ix = Math.round((V.x[i] - x0) / dx), iy = Math.round((V.y[i] - y0) / dx);
            const zg = G[iy * nx + ix];
            v3.set(V.x[i] - CX, V.y[i] - CY, (isNaN(zg) ? ZMID : zg) - V.depth[i] - ZMID);
            sc3.set(s0, s0, V.thick[i] * 0.98);
            mtx.compose(v3, q4, sc3);
            im.setMatrixAt(i, mtx);
            col.set(V.color[i]);
            im.setColorAt(i, col);
          }
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.userData.pick = { kind: "temsurf", what: "vox", vox: V };
          put(im, 1);
        }
      }
      /* v38: the TEM interpretations (js/teminterp.js) — the base of the
         waste as a surface below the ground, coloured by thickness; a stick
         from the ground down to it at each proposed boring; the conductive
         band as a flat sheet at its mid elevation, and the least-resistive
         route across it. Below ground by construction, so noClip, like the
         slice. */
      const TI = SBMM.teminterp && SBMM.teminterp.scene3d ? SBMM.teminterp.scene3d() : null;
      if (TI && TI.waste) {
        const Wd = TI.waste, wnx = Wd.nx, wny = Wd.ny, n = wnx * wny, op = Wd.opacity;
        const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), ok = new Uint8Array(n);
        for (let iy = 0; iy < wny; iy++) for (let ix = 0; ix < wnx; ix++) {
          const id = iy * wnx + ix, x = Wd.x0 + ix * Wd.dx, y = Wd.y0 + iy * Wd.dx, d = Wd.depth[id];
          const [zg] = SBMM.elev(x, y);
          ok[id] = isFinite(d) && !isNaN(zg) ? 1 : 0;
          pos[id * 3] = x - CX; pos[id * 3 + 1] = y - CY; pos[id * 3 + 2] = (ok[id] ? zg - d : ZMID) - ZMID;
          col[id * 3] = Wd.color[id * 3]; col[id * 3 + 1] = Wd.color[id * 3 + 1]; col[id * 3 + 2] = Wd.color[id * 3 + 2];
        }
        const ind = [];
        for (let iy = 0; iy < wny - 1; iy++) for (let ix = 0; ix < wnx - 1; ix++) {
          const q = iy * wnx + ix, b2 = q + 1, c2 = q + wnx, d2 = c2 + 1;
          if (ok[q] && ok[b2] && ok[c2] && ok[d2]) ind.push(q, b2, d2, q, d2, c2);
        }
        if (ind.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
          g.setAttribute("color", new THREE.BufferAttribute(col, 3));
          g.setIndex(ind);
          g.computeVertexNormals();
          const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide,
            transparent: op < 0.999, opacity: op, depthWrite: op >= 0.999 }));
          m.renderOrder = 2; m.userData.noClip = true;
          m.userData.pick = { kind: "teminterp", what: "waste" };
          addG.add(tag(m, "invest", "tem_waste"));
        }
        if (Wd.targets && Wd.targets.length) {
          const seg = [], dots = [];
          for (const t of Wd.targets) {
            const [zg] = SBMM.elev(t.x, t.y);
            if (isNaN(zg)) continue;
            seg.push(t.x - CX, t.y - CY, zg + 6 - ZMID, t.x - CX, t.y - CY, zg - t.depth - ZMID);
            dots.push(t.x - CX, t.y - CY, zg + 6 - ZMID);
          }
          if (seg.length) {
            const gs = new THREE.BufferGeometry();
            gs.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
            const ls = new THREE.LineSegments(gs, new THREE.LineBasicMaterial({ color: 0xF2D04B }));
            ls.renderOrder = 3; ls.userData.noClip = true;
            addG.add(tag(ls, "invest", "tem_waste"));
            const gd = new THREE.BufferGeometry();
            gd.setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));
            const po = new THREE.Points(gd, dotMaterial({ size: 10, color: 0xF2D04B }));
            po.userData.pick = { kind: "teminterp", what: "target" };
            addG.add(tag(po, "invest", "tem_waste"));
          }
        }
      }
      if (TI && TI.seep) {
        const Sd = TI.seep, snx = Sd.nx, sny = Sd.ny, n = snx * sny, op = Sd.opacity, zs = Sd.z - ZMID;
        const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
        for (let iy = 0; iy < sny; iy++) for (let ix = 0; ix < snx; ix++) {
          const id = iy * snx + ix;
          pos[id * 3] = Sd.x0 + ix * Sd.dx - CX; pos[id * 3 + 1] = Sd.y0 + iy * Sd.dx - CY; pos[id * 3 + 2] = zs;
          /* the canvas is a pixel run per NODE, so a node sits at its pixel's centre */
          uv[id * 2] = (ix + 0.5) / snx; uv[id * 2 + 1] = (iy + 0.5) / sny;
        }
        const okS = id => isFinite(Sd.ok[id]);
        const ind = [];
        for (let iy = 0; iy < sny - 1; iy++) for (let ix = 0; ix < snx - 1; ix++) {
          const q = iy * snx + ix, b2 = q + 1, c2 = q + snx, d2 = c2 + 1;
          if (okS(q) && okS(b2) && okS(c2) && okS(d2)) ind.push(q, b2, d2, q, d2, c2);
        }
        if (ind.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
          g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
          g.setIndex(ind);
          const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texOf(Sd.canvas), side: THREE.DoubleSide,
            transparent: true, opacity: op, depthWrite: false }));
          m.renderOrder = 2; m.userData.noClip = true;
          m.userData.pick = { kind: "teminterp", what: "seep" };
          addG.add(tag(m, "invest", "tem_seep"));
        }
        /* the route is THE result, so it is a tube (a GL line is one pixel)
           and it draws over the see-through ground rather than under it */
        if (Sd.route && Sd.route.length > 1) {
          const path = new THREE.CurvePath();
          for (let i = 1; i < Sd.route.length; i++) {
            const a = Sd.route[i - 1], b = Sd.route[i];
            path.add(new THREE.LineCurve3(new THREE.Vector3(a[0] - CX, a[1] - CY, zs + 1), new THREE.Vector3(b[0] - CX, b[1] - CY, zs + 1)));
          }
          const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(8, Sd.route.length * 3), 3.5, 6, false),
            new THREE.MeshBasicMaterial({ color: 0xF2D04B, transparent: true, opacity: 0.95, depthTest: false }));
          tube.renderOrder = 6; tube.userData.noClip = true;
          tube.userData.pick = { kind: "teminterp", what: "route" };
          addG.add(tag(tube, "invest", "tem_seep"));
        }
      }
      /* v54: a derived TEM map (js/temmaps.js) — an elevation per node and
         the map's own picture on it: an interval between depths follows the
         ground at its middle, between elevations it is level, a top-of-
         conductor map IS the surface. Under the ground, so noClip. */
      const TM = SBMM.temmaps && SBMM.temmaps.scene3d ? SBMM.temmaps.scene3d() : null;
      if (TM) {
        const mnx = TM.nx, mny = TM.ny, n = mnx * mny;
        const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
        for (let iy = 0; iy < mny; iy++) for (let ix = 0; ix < mnx; ix++) {
          const id = iy * mnx + ix, z = TM.z[id];
          pos[id * 3] = TM.x0 + ix * TM.dx - CX; pos[id * 3 + 1] = TM.y0 + iy * TM.dx - CY;
          pos[id * 3 + 2] = (z === z ? z : ZMID) - ZMID;
          /* the picture is `up` pixels a node, a node on a pixel's centre */
          uv[id * 2] = (ix * TM.up + 0.5) / TM.W; uv[id * 2 + 1] = (iy * TM.up + 0.5) / TM.H;
        }
        const okM = id => TM.z[id] === TM.z[id];
        const ind = [];
        for (let iy = 0; iy < mny - 1; iy++) for (let ix = 0; ix < mnx - 1; ix++) {
          const q = iy * mnx + ix, b2 = q + 1, c2 = q + mnx, d2 = c2 + 1;
          if (okM(q) && okM(b2) && okM(c2) && okM(d2)) ind.push(q, b2, d2, q, d2, c2);
        }
        if (ind.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
          g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
          g.setIndex(ind);
          const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texOf(TM.canvas), side: THREE.DoubleSide,
            transparent: true, opacity: TM.opacity, depthWrite: false }));
          m.renderOrder = 2; m.userData.noClip = true;
          m.userData.pick = { kind: "temmap" };
          addG.add(tag(m, "invest", "tem_map"));
        }
      }
      for (const [cv, t] of temTex) if (!used.has(cv)) { t.dispose(); temTex.delete(cv); }
    }
    /* the storm-drainage network (v12 §5.1): the conduits draped on the ground
       and a dot at every structure, in the storm colour rather than the water
       one — the pipes are infrastructure, the flow is the terrain's answer. */
    if (SEC("storm") && SBMM.storm && SBMM.storm.lines3d) {
      const SC = new THREE.Color(SBMM.storm.COLOR || "#7FA7C9").getHex();
      const ST = SBMM.storm;
      for (const r of ST.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        /* v58: the 2D conduit's chip and card (js/storm.js tipFor, forStorm);
           a status change refreshes the overlays, so the chip is current */
        const c = ST.conduit(r.props && r.props.id);
        o.userData.pick = c
          ? { kind: "card", title: ST.labelOf(c.id) + " · storm conduit",
              chip: ST.tipFor ? ST.tipFor(null, c) : undefined,
              html: () => SBMM.popups.forStorm(null, c) }
          : { kind: "gis", props: r.props, geom: r.geom };
        tag(addShadow(SHW, o), "framework",
            (r.props && r.props.layer === "storm_inferred") ? "storm_inferred" : "storm_cad");
        addG.add(o);
      }
      const sp = SBMM.storm.points3d();
      if (sp.length) {
        const pos = [];
        for (const q of sp) {
          pos.push(q.x - CX, q.y - CY, drapeZ(q.x, q.y, 5));
          const [ze] = SBMM.elev(q.x, q.y);
          if (!isNaN(ze)) ptCand.push({ key: "pt:storm:" + q.id, text: q.name || q.id, x: q.x, y: q.y, z: ze + 5,
                                        color: SBMM.storm.COLOR || "#7FA7C9", priority: 20, liftPx: 20,
                                        layer: { g: "framework", l: "storm_nodes" } });
        }
        const gg = new THREE.BufferGeometry();
        gg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const po = new THREE.Points(gg, dotMaterial({ size: 9, color: SC }));
        /* v58: one cloud, one answer per vertex — the 2D structure's chip and
           card (js/storm.js tipFor, forStorm), and its point to snap to */
        po.userData.pick = { kind: "cards", at(i) {
          const q = sp[i], n = q && ST.node(q.id);
          if (!n) return null;
          return { title: (n.name || n.id) + " · storm structure",
                   chip: ST.tipFor ? ST.tipFor(n, null) : undefined,
                   html: () => SBMM.popups.forStorm(n, null), xyz: [n.x, n.y] };
        } };
        addG.add(tag(po, "framework", "storm_nodes"));
      }
    }
    /* the drainage map (v14 §4): the catchment polygons draped like the DUs and
       the longest flow path of each drawn as it runs. Read-only analysis, so the
       pick card is the same popup the 2D map binds. */
    if (SEC("drainage") && SBMM.drainage && SBMM.drainage.hasResult()) {
      /* rings3d hands back OPEN RUNS, not closed rings: a catchment boundary
         that reaches the survey limit has no ground under the rest of it, and a
         closed drape there stands up as a curtain (js/drainage.js groundRuns) */
      const DR = SBMM.drainage;
      for (const r of DR.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), r.closed === true, 3);
        /* v58: the 2D catchment's chip and card (js/drainage.js tipFor, forDrainage) */
        const lbl = r.label;
        o.userData.pick = { kind: "card",
          title: ((r.props && r.props.outlet) || "Catchment") + " · catchment",
          chip: DR.tipFor ? DR.tipFor(r.rec || lbl) : undefined,
          html: () => SBMM.popups.forDrainage(lbl) };
        tag(addShadow(SHW, o), "framework",
            (r.props && r.props.layer === "DRAIN-OUTLET") ? "drain_outlet" : "drain_first");
        addG.add(o);
      }
      for (const r of DR.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        /* v58: the 2D path's chip (js/drainage.js pathTip); 2D has no card for a
           path, so the card is the catchment it is the longest path of */
        const lbl = r.label;
        o.userData.pick = { kind: "card",
          title: "Longest flow path · " + ((r.props && r.props.outlet) || ""),
          chip: DR.pathTip && r.sink ? DR.pathTip(r.sink) : undefined,
          html: () => SBMM.popups.forDrainage(lbl) };
        tag(addShadow(SHW, o), "framework", "drain_paths");
        addG.add(o);
      }
    }
    /* v22 §C: the four areas of "where does the water go", draped like the
       drainage catchments and through the same groundRuns rule, so a class
       boundary that reaches the survey limit stops there instead of standing
       up as a curtain over Clear Lake. */
    if (SEC("wherewater") && SBMM.whereWater && SBMM.whereWater.hasResult()) {
      const WW = SBMM.whereWater;
      for (const r of WW.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 3);
        /* v58: the 2D class's chip and card (js/wherewater.js tipFor, forWhereWater) */
        const cls = r.cls;
        o.userData.pick = { kind: "card",
          title: ((r.rec && r.rec.label) || "Where the water goes") + " · where the water goes",
          chip: WW.tipFor ? WW.tipFor(r.rec || cls) : undefined,
          html: () => SBMM.popups.forWhereWater(cls) };
        tag(addShadow(SHW, o), "framework", "where_water");
        addG.add(o);
      }
    }
    /* v19 §2: the stream network, draped like every other overlay line. A
       stream follows the ground by construction, but a link that ends at the
       survey limit still has its last vertex out over the water, so it goes
       through js/drainage.js groundRuns() like the catchment boundaries do. */
    if (SEC("accum") && SBMM.accum && SBMM.accum.lines3d) {
      for (const r of SBMM.accum.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 3);
        /* v58: the 2D link's chip and card (js/accum.js tipFor, forStream) */
        const st = r.stream;
        o.userData.pick = st
          ? { kind: "card", title: "Stream · order " + st.order,
              chip: SBMM.accum.tipFor ? SBMM.accum.tipFor(st) : undefined,
              html: () => SBMM.popups.forStream(st, SBMM.accum.result()) }
          : { kind: "gis", props: r.props, geom: r.geom };
        tag(addShadow(SHW, o), "framework", "accum_streams");
        addG.add(o);
      }
    }
    /* the design storm (v14 Phase 2): the same catchment boundaries, coloured by
       this storm's runoff depth instead of by outlet, and picked with the same
       card the 2D choropleth opens. */
    if (SEC("runoff") && SBMM.runoff && SBMM.runoff.rings3d) {
      for (const r of SBMM.runoff.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 3);
        /* v58: the 2D choropleth's chip and card (js/runoff.js tipFor, forRunoff) */
        const lbl = r.label, oc = r.outlet;
        o.userData.pick = { kind: "card",
          title: ((oc && oc.name) || "Catchment") + " · runoff depth",
          chip: oc && SBMM.runoff.tipFor ? SBMM.runoff.tipFor(oc) : undefined,
          html: () => SBMM.popups.forRunoff(lbl) };
        tag(addShadow(SHW, o), "framework", "runoff_depth");
        addG.add(o);
      }
    }
    /* EA native CAD design linework. designgis owns the authoritative polygons;
       these are the drafted lines around them, and they were previously visible
       in 2D only — which meant clicking one in 3D found nothing at all. */
    if (SEC("cad") && SBMM.CadNative && SBMM.CadNative.rings3d) {
      /* drapedLine resamples every ring against the DEM at 10 ft, so the cost is
         per RING, not per group. v9 drapes on demand — only the groups that are
         actually on — against a budget rather than a blanket cap of 400: with
         the reference furniture switched off (the default) the design linework
         is a few hundred rings and all of it draws, and someone who switches
         3,159 CAD contours on gets a straight answer instead of a silently
         truncated drawing. */
      const BUDGET = 3000;
      const rings = SBMM.CadNative.rings3d();
      let n = 0, skipped = 0;
      for (const r of rings) {
        if (!r.ring || r.ring.length < 2) continue;
        if (n >= BUDGET) { skipped++; continue; }
        n++;
        const o = drapedLine(r.ring, new THREE.Color(r.color || "#cccccc").getHex(), false, 3);
        /* rings3d hands back the feature's own coords array by reference, so the
           array identity is enough for pick3d to find the CAD record again */
        o.userData.pick = { kind: "cad", coords: r.ring };
        tag(o, r.group || "design", "cad_" + (r.key || "misc"));
        addG.add(o);
      }
      if (skipped && skipped !== VIEWER.lastCadSkip) {
        toast(`3D: ${fmt0(skipped)} CAD lines beyond the ${fmt0(BUDGET)}-line drape budget are not shown — switch a group off in Layers`, 5200);
      }
      VIEWER.lastCadSkip = skipped;
    }
    if (SEC("pdf") && SBMM.designEA && LS("design", "pdf_boundaries")) {
      const DCOL = { "area-validated": 0xFF6B4A, "unclassified": 0xE8B34B, "surveyed": 0x4FD2E8 };
      for (const r of SBMM.designEA.rings3d()) {
        const o = drapedLine(r.ring, DCOL[r.conf] || 0xcccccc, true, 3);
        /* §3.1: EA's PDF-derived boundaries were drawn in 3D but said nothing
           about themselves — a click found nothing and the parity table found
           no object for the row. Both are the same missing tag. */
        /* v58: the 2D boundary's chip and card (js/designea.js tip, popupPoly) */
        const EA = SBMM.designEA, pp = r.props || { name: "EA boundary", layer: "pdf_boundaries", confidence: r.conf };
        const ea = { _ea: { ring: r.ring, props: pp } };
        o.userData.pick = EA.tip && EA.popupPoly
          ? { kind: "card", title: (pp.name || "EA boundary") + " · EA PDF boundary",
              chip: EA.tip(pp), html: () => EA.popupPoly(ea) }
          : { kind: "gis", props: pp, geom: r.geom || { type: "Polygon", coordinates: [r.ring] } };
        tag(addShadow(SHW, o), "design", "pdf_boundaries");
        addG.add(o);
      }
    }
  }

  /* the sections built AFTER the user's features */
  function after() {
 SHW = null; OVL = null;

    /* datasets: a billboard dot per record, plus — where the dataset has a depth
       attribute and sticks are switched on — a vertical line from the ground down
       that depth. The stick is drawn in scene units and the group is z-scaled by
       the exaggeration slider like everything else, so a 40 ft boring stays 40 ft
       relative to the terrain it is standing in however hard the relief is pushed. */
    /* datasets: threeSpec() already returns only the datasets whose rows are on */
    if (SEC("datasets") && SBMM.datasets) {
      /* A boring's stick is the LOG, not a length (js/borelogs.js): where the
         2025 OpenGround logs give a class profile for this hole, the stick is
         drawn in segments coloured by that profile — waste, native, bedrock —
         with a cross at the native contact and a blue tick at the water level.
         The palette comes from SBMM.borelogs.classColor() rather than a copy
         here, because a duplicated palette is a palette that drifts, and the
         whole thing stays inside the SAME LineSegments: one object per dataset,
         one draw call, one pick registration. A dataset with no log (the wells,
         an imported CSV) keeps the plain single-colour stick it always had.

         DEVIATION, recorded: the spec asked for a "small disc/ring" at the
         contact. A disc is a second object with its own material and its own
         pick entry; a two-segment cross is the same reading inside the geometry
         that is already there, which is what "one object per dataset" costs. */
      const BL = (SBMM.borelogs && SBMM.borelogs.has()) ? SBMM.borelogs : null;
      const LM = (SBMM.labMetals && SBMM.labMetals.has()) ? SBMM.labMetals : null;
      for (const spec of SBMM.datasets.threeSpec()) {
        const pos = [], seg = [], scol = [], segPt = [];
        const c = new THREE.Color(spec.color);
        const tmp = new THREE.Color();
        /* one segment: two vertices, two colours, and the RECORD it belongs to
           so js/pick3d.js can still answer a click on it with the dataset popup */
        const put = (x, y, za, zb, col, i) => {
          seg.push(x, y, za, x, y, zb);
          scol.push(col.r, col.g, col.b, col.r, col.g, col.b);
          segPt.push(i);
        };
        const putH = (x0, y0, x1, y1, z, col, i) => {
          seg.push(x0, y0, z, x1, y1, z);
          scol.push(col.r, col.g, col.b, col.r, col.g, col.b);
          segPt.push(i);
        };
        spec.pts.forEach((p, pi) => {
          const [z0] = SBMM.elev(p.x, p.y);
          const z = (isNaN(z0) ? ZMID : z0) - ZMID;
          pos.push(p.x - CX, p.y - CY, z + 4);
          if (p.id != null && p.id !== "" && !isNaN(z0))
            ptCand.push({ key: "pt:" + spec.id + ":" + p.id + ":" + Math.round(p.x) + ":" + Math.round(p.y),
                          text: String(p.id), x: p.x, y: p.y, z: z0 + 4, color: spec.color,
                          priority: 20, liftPx: 20, layer: rowLayer(spec.rowKey) });
          if (!(spec.stick && p.depth > 0)) return;
          const X = p.x - CX, Y = p.y - CY;
          const prof = BL && p.id ? BL.profileOf(p.id) : null;
          if (!prof) {
            /* v28: a hole with metals by depth but no log (the 2025 test pits)
               shows Hg per sampled interval — above the ROD level, above the
               PMB level, below both — and the unsampled rest in its own colour */
            const hm = LM && p.id ? LM.hole(p.id) : null;
            if (!hm) { put(X, Y, z + 1, z - p.depth, c, pi); return; }
            let deep = 0;
            for (const iv of hm.intervals) {
              const a = Math.min(iv.top, p.depth), b = Math.min(iv.base, p.depth);
              if (b - a < 1e-6) continue;
              const lv = LM.level("Hg", iv.m.Hg);
              put(X, Y, z - a, z - b, tmp.set(lv === "rod" ? 0xE5584C : lv === "pmb" ? 0xE6A93F : 0x6DBB7A), pi);
              deep = Math.max(deep, b);
            }
            if (p.depth - deep > 0.05) put(X, Y, z - deep, z - p.depth, c, pi);
            return;
          }
          let deepest = 0;
          for (const r of prof) {
            const a = Math.min(r.top, p.depth), b = Math.min(r.base, p.depth);
            if (b - a < 1e-6) continue;
            put(X, Y, z - a, z - b, tmp.set(BL.classColor(r.cls)), pi);
            deepest = Math.max(deepest, b);
          }
          /* the strata stop where the logger stopped describing; the rest of the
             drilled depth is drawn, in the "not classed" grey, rather than left
             as a hole that looks shallower than it is */
          if (p.depth - deepest > 0.05)
            put(X, Y, z - deepest, z - p.depth, tmp.set(BL.classColor("unknown")), pi);
          const ct = BL.contactOf(p.id);
          if (ct && ct.native_contact != null && ct.native_contact <= p.depth) {
            const zc = z - ct.native_contact, k = tmp.set(BL.classColor("contact"));
            putH(X - 3, Y, X + 3, Y, zc, k, pi);
            putH(X, Y - 3, X, Y + 3, zc, k, pi);
          }
          const wl = BL.waterOf(p.id);
          if (wl && wl.encountered && wl.depth != null && wl.depth <= p.depth) {
            const k = tmp.set(0x55C1FF);
            putH(X - 2.5, Y, X + 2.5, Y, z - wl.depth, k, pi);
          }
        });
        if (pos.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          const dots = new THREE.Points(g, dotMaterial({ size: spec.size * 1.25, color: c }));
          /* threeSpec() walks d.points in order, so a raycast index IS the
             record index — that is what lets a 3D click on a well marker open
             the very popup its 2D marker opens */
          dots.userData.pick = { kind: "dataset", dsId: spec.id };
          tagKey(dots, spec.rowKey);
          addG.add(dots);
        }
        if (seg.length) {
          const g2 = new THREE.BufferGeometry();
          g2.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
          g2.setAttribute("color", new THREE.Float32BufferAttribute(scol, 3));
          /* The stick is below the ground by definition, so with depth testing on
             it is inside the terrain mesh and invisible — a depth attribute that
             draws nothing. Drawn without depth test and semi-transparent it reads
             as what it is: the hole seen through the ground, the way a fence
             diagram or a Civil 3D borehole does. */
          /* vertexColors, so the boring's own class profile and the plain
             single-colour stick of every other dataset live in one material;
             the base colour has to be white or it would tint them all */
          const stick = new THREE.LineSegments(g2, new THREE.LineBasicMaterial({
            /* .85 rather than the old .55: a one-pixel line at 55 % over a
               bright ortho washes out, and once the stick carries the LOG's
               own three colours the whole point of it is that they are
               distinguishable. It is still see-through, which is what says
               "below the ground". */
            color: 0xffffff, vertexColors: true,
            transparent: true, opacity: .85, depthTest: false, depthWrite: false
          }));
          stick.renderOrder = 2;
          stick.userData.noClip = true;        // v27: below ground, shown in the trench
          /* v47: the hole as a column — never thinner than 4 px, as wide as a
             2.4-ft column close up, shaded round, in its log's own colours */
          stick.userData.wideOpts = { width: 4, casing: 1, casingAlpha: 0.7, world: 1.2, round: true };
          /* the stick belongs to the same record as the dot above it — clicking
             the borehole, not just its cap, has to open the log */
          /* segPt[k] is the record the k-th SEGMENT belongs to — js/pick3d.js
             does idx[floor(vertexIndex / 2)], and a boring is many segments now
             rather than exactly one, so the mapping has to be built as the
             geometry is */
          stick.userData.pick = { kind: "dataset", dsId: spec.id, stick: true, idx: segPt };
          tagKey(stick, spec.rowKey);
          addG.add(stick);
        }
      }
    }

    if (SEC("samples") && LS("invest", "samples")) {
      const pos = [], col = [];
      for (const p of SBMM.samples) {
        pos.push(p.x - CX, p.y - CY, drapeZ(p.x, p.y, 4));
        const nm = p.id || p.name, [zs] = SBMM.elev(p.x, p.y);
        if (nm && !isNaN(zs))
          ptCand.push({ key: "pt:sample:" + nm, text: String(nm), x: p.x, y: p.y, z: zs + 4,
                        color: p.exc ? "#E4796A" : "#5FBF8F", priority: 20, liftPx: 20,
                        layer: { g: "invest", l: "samples" } });
        const c = new THREE.Color(p.exc ? 0xE4796A : 0x5FBF8F);
        col.push(c.r, c.g, c.b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      VIEWER.pointsObj = new THREE.Points(g, dotMaterial({ size: 16, vertexColors: true }));
      VIEWER.pointsObj.userData.pick = { kind: "sample" };
      tag(VIEWER.pointsObj, "invest", "samples");
      addG.add(VIEWER.pointsObj);
    }

    /* the trees (v39): each one drawn as a tree — js/trees3d.js. Instanced, so
       the whole site is a handful of draw calls; the levels of detail are
       dealt by treesRelod() from the render loop, in a frame that is being
       drawn anyway. */
    const td = SBMM.trees && SBMM.trees.data;
    const TREES = SEC("trees");
    if (TREES) VIEWER.treesOn = false;
    if (TREES && td && td.n && SBMM.trees3d && LS("base", "trees_detected")) {
      const tg = SBMM.trees3d.build(td, { CX, CY, ZMID, sunAz, sunEl, minShow: SBMM.trees.minShow(),
                                          light: quality() !== "realistic", castShadows: shadowsWanted(),
                                          /* v46: with the ground's edge fade, what stands on it fades too */
                                          edgeAt: edgeOn() ? SBMM.terrain3d.edgeAt : null });
      if (tg) {
        tag(tg, "base", "trees_detected");
        tg.traverse(o => { if (o !== tg) tag(o, "base", "trees_detected"); });
        addG.add(tg);
        VIEWER.treesOn = true;
        SBMM.trees3d.relod(camera.position, zx, true);
        SHD.dirty = true;
      }
    } else if (TREES && SBMM.trees3d) SBMM.trees3d.dispose();

    /* cultural resources (§7) — CONFIDENTIAL, drawn only while the group is on.
       Same draped-ring treatment as the design areas, plus a marker per isolate,
       in the layer's own red/amber so it reads as a restricted overlay rather
       than as more design furniture. The stamp element over the 3D canvas is
       put up by js/cultural.js; the snapshot gets it burned in. */
    if (SEC("cultural") && SBMM.cultural && SBMM.cultural.visible()) {
      for (const r of SBMM.cultural.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), true, 3);
        o.userData.pick = { kind: "cultural", feature: r.feature };
        tag(addShadow(SHW, o), "cultural", (r.feature && r.feature.layer) || "cultural");
        addG.add(o);
      }
      /* one cloud per LAYER, not one merged cloud: an object can only claim one
         layer row, and §3.1's table asks each row for its own object */
      const cp = SBMM.cultural.points3d();
      const byLay = new Map();
      for (const p of cp) {
        const k = p.layer || "cultural";
        if (!byLay.has(k)) byLay.set(k, []);
        byLay.get(k).push(p);
      }
      for (const [k, pts] of byLay) {
        const pos = [], col = [];
        for (const p of pts) {
          pos.push(p.x - CX, p.y - CY, drapeZ(p.x, p.y, 5));
          const c = new THREE.Color(p.color);
          col.push(c.r, c.g, c.b);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        const cpo = new THREE.Points(g, dotMaterial({ size: 18, vertexColors: true }));
        cpo.userData.pick = { kind: "culturalPt", pts };
        tag(cpo, "cultural", k);
        addG.add(cpo);
      }
    }
    /* v15 §3.1 — the computed contour set (js/analysis.js CONTOUR command). A
       contour's level IS its elevation, so no drape sampling is needed; one
       LineSegments per weight class, like the survey sets. */
    if (SEC("contours") && LS("base", "contours_custom") && SBMM.analysis && SBMM.analysis.customContours3d) {
      const cl = SBMM.analysis.customContours3d();
      if (cl.length) {
        const byCol = new Map();
        for (const c of cl) {
          const k = c.color + "|" + (c.heavy ? "h" : "l");
          if (!byCol.has(k)) byCol.set(k, { color: c.color, heavy: c.heavy, v: [] });
          const v = byCol.get(k).v, z = c.lv - ZMID + 1.5;
          for (let i = 1; i < c.pts.length; i++) {
            const a = c.pts[i - 1], b = c.pts[i];
            v.push(a[0] - CX, a[1] - CY, z, b[0] - CX, b[1] - CY, z);
          }
        }
        for (const rec of byCol.values()) {
          if (!rec.v.length) continue;
          const gg = new THREE.BufferGeometry();
          gg.setAttribute("position", new THREE.Float32BufferAttribute(rec.v, 3));
          addG.add(tag(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({
            color: new THREE.Color(rec.color).getHex(), transparent: true,
            opacity: rec.heavy ? 0.85 : 0.5 })), "base", "contours_custom"));
        }
      }
    }
  }

  return { begin, before, after, end,
           /* what this file takes from the viewer: test/check keeps the two in step */
           uses: { tools: ["LS","SECT","SHD","addShadow","dotMaterial","drapeZ","drapedBatch","drapedLine","edgeOn","quality","rowLayer","shadowsWanted","tag","tagKey","temTex","temTexture"], now: ["CX","CY","ZMID","camera","sunAz","sunEl"], pass: ["PROJ","wantedWith","wantsPrefix","zx"], vars: ["builtInfo","lastCadSkip","pointsObj","temGround","treesOn"] } };
})();
