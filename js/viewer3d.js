/* SBMM Site Explorer — 3D terrain viewer (Three.js).
   Scene units are State Plane feet, z-up, positions relative to site center.

   Navigation is a purpose-built dual-mode rig (js has no OrbitControls dependency any
   more): ORBIT — left-drag orbits, right/middle-drag pans, the wheel dollies toward the
   point under the cursor, double-click re-targets; FLY — left-drag looks, WASD/QE move
   at a speed that scales with height above ground. Both modes damp toward a desired
   state and both keep the camera at least 3 ft above the terrain (in exaggerated units,
   so the clearance looks the same at any relief setting).

   The render loop is on demand: it only calls renderer.render() when the camera or the
   scene is actually dirty, so an idle 3D view costs nothing. */
"use strict";

SBMM.viewer3d = (function () {
  let inited = false, open = false, split = false;
  let renderer, scene, camera, raycaster, nav;
  let terrainMeshes = [], overlayGroup = null, pointsObj = null, sketchObj = null;
  let canopyMesh = null;   // kept out of terrainMeshes so picking stays on bare earth
  let contourGroup = null; // survey contours, built lazily on first check then just toggled
  let CX = 0, CY = 0, ZMID = 0;
  let texCache = {};
  let needsRender = true, rafId = 0, renderCount = 0, frameCount = 0;
  /* last terrain raycast, keyed to the cursor position — raycasting a 1.5M-vertex mesh
     is the expensive part of hovering, so the wheel handler reuses the hover's result */
  let lastPick = { x: -1e9, y: -1e9, p: null, t: 0 };

  const requestRender = () => { needsRender = true; };
  const exag = () => parseFloat($("v3dExag").value);

  function strideFor(dem, maxDim) { return Math.max(1, Math.ceil(Math.max(dem.m.w, dem.m.h) / maxDim)); }

  /* The rectangle a finer DEM occupies, in State Plane feet — a coarser mesh
     punches a hole here so the two do not z-fight. */
  function demRect(dem) {
    const m = dem.m;
    return [m.x0, m.y0, m.x0 + (m.w - 1) * m.cell, m.y0 + (m.h - 1) * m.cell];
  }

  /* Is rectangle `c` wholly covered by the UNION of `rects`? Testing each rect
     on its own is not enough once there is more than one: the 1-ft windows
     overlap, so their union is an L and a coarse cell can straddle the seam,
     lying wholly inside neither while being wholly inside the union. Such a cell
     drawn anyway is a ribbon of coarse mesh z-fighting the fine one along the
     join. Subtracting each rect from the remainder settles it exactly. */
  function subtractRect(a, r) {
    if (r[2] <= a[0] || r[0] >= a[2] || r[3] <= a[1] || r[1] >= a[3]) return [a];
    const out = [];
    if (a[1] < r[1]) out.push([a[0], a[1], a[2], r[1]]);
    if (a[3] > r[3]) out.push([a[0], r[3], a[2], a[3]]);
    const y0 = Math.max(a[1], r[1]), y1 = Math.min(a[3], r[3]);
    if (y1 > y0) {
      if (a[0] < r[0]) out.push([a[0], y0, r[0], y1]);
      if (a[2] > r[2]) out.push([r[2], y0, a[2], y1]);
    }
    return out;
  }
  function coveredBy(c, rects) {
    let rem = [c];
    for (const r of rects) {
      const next = [];
      for (const a of rem) for (const p of subtractRect(a, r)) next.push(p);
      rem = next;
      if (!rem.length) return true;
    }
    return false;
  }

  /* `skipRects` are the windows a FINER mesh already covers. Before v9 there was
     exactly one (the mine area) and it was a boolean; the residential 1-ft window
     made it a list. The rule is the stack's rule: the finest mesh that covers a
     cell draws it, so dem_site skips both 1-ft windows and dem_res skips the part
     of itself dem_abp overlaps (SBMM.dems puts dem_abp first). */
  function buildTerrain(dem, stride, skipRects) {
    const m = dem.m, s = stride;
    const nx = Math.floor((m.w - 1) / s) + 1, ny = Math.floor((m.h - 1) / s) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const uv = new Float32Array(nx * ny * 2);
    let k = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const gi = Math.min(m.w - 1, i * s), gj = Math.min(m.h - 1, j * s);
        const x = m.x0 + gi * m.cell, y = m.y0 + gj * m.cell;
        let z = dem.atGrid(gi, gj);
        if (isNaN(z)) z = ZMID;
        pos[k * 3] = x - CX; pos[k * 3 + 1] = y - CY; pos[k * 3 + 2] = z - ZMID;
        k++;
      }
    }
    const idx = [];
    const skips = (skipRects || []).filter(Boolean);
    const G = (i, j) => dem.atGrid(Math.min(m.w - 1, i * s), Math.min(m.h - 1, j * s));
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        /* skip any cell touching NoData — prevents cliff-wall artifacts at survey limits */
        if (isNaN(G(i, j)) || isNaN(G(i + 1, j)) || isNaN(G(i, j + 1)) || isNaN(G(i + 1, j + 1))) continue;
        if (skips.length) {
          const gi = i * s, gj = j * s;
          const x = m.x0 + gi * m.cell, y = m.y0 + gj * m.cell;
          const xe = x + s * m.cell, ye = y + s * m.cell;
          if (coveredBy([x, y, xe, ye], skips)) continue;
        }
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, b, d, a, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return { geom: g, nx, ny, stride: s, dem };
  }

  function setUVs(t, texBounds) {
    const { geom, nx, ny, stride: s, dem } = t;
    const m = dem.m, uv = geom.getAttribute("uv");
    const [tx0, ty0, tx1, ty1] = texBounds;
    let k = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const gi = Math.min(m.w - 1, i * s), gj = Math.min(m.h - 1, j * s);
      const x = m.x0 + gi * m.cell, y = m.y0 + gj * m.cell;
      uv.setXY(k++, clamp((x - tx0) / (tx1 - tx0), 0, 1), clamp((y - ty0) / (ty1 - ty0), 0, 1));
    }
    uv.needsUpdate = true;
  }

  /* Which texture set a mesh drapes with. Only two exist: the site rasters and
     the mine-area ones. The residential 1-ft mesh takes the SITE texture — the
     site ortho (1.5 ft), the site hillshade and the computed site rasters all
     cover that window, and there is no finer imagery over the lots to use. What
     dem_res buys is mesh geometry and elevations, not pixels. */
  function whichFor(dem) { return dem === SBMM.demAbp ? "abp" : "site"; }

  async function texture(kind, which) {   // which: "site" | "abp"
    const key = kind + "_" + which;
    if (texCache[key]) return texCache[key];
    let url = null, bounds = null;
    const dem = which === "site" ? SBMM.demSite : SBMM.demAbp;
    const db = dem.bounds();  // [[y0,x0],[y1,x1]]
    if (kind === "ortho") {
      if (which === "site" && SBMM_DATA.ortho_site_jpg && SBMM_DATA.ortho_site.x0) {
        const o = SBMM_DATA.ortho_site; url = SBMM_DATA.ortho_site_jpg; bounds = [o.x0, o.y0, o.x1, o.y1];
      } else if (which === "abp" && SBMM_DATA.ortho_abp_jpg) {
        /* the 3-in ABP ortho doesn't cover the whole ABP DEM — composite it over the
           site ortho (or hillshade) so mesh edges don't smear */
        const out = await compositeAbpOrtho(db);
        texCache[key] = out;
        return out;
      } else return texture("hillshade", which);
    } else if (kind === "hillshade") {
      url = which === "site" ? (SBMM_DATA.hs_site_jpg || SBMM_DATA.hs_site_png) : (SBMM_DATA.hs_abp_jpg || SBMM_DATA.hs_abp_png);
      bounds = [db[0][1], db[0][0], db[1][1], db[1][0]];
    } else {   // computed slope / hypso — same worker kernel as the 2D analysis layers
      const spec = SBMM.analysis.specFor(kind, dem);
      spec.nanColor = [70, 76, 80];
      url = await SBMM.analysis.demRaster(dem, spec, 255, dem === SBMM.demSite ? 2 : 1,
        `3D drape — ${SBMM.analysis.KIND_NAME[kind] || kind} (${which === "site" ? "site" : "mine area"})`);
      bounds = [db[0][1], db[0][0], db[1][1], db[1][0]];
    }
    const tex = await new Promise((res, rej) => new THREE.TextureLoader().load(url, res, undefined, rej));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;             // image row 0 = north = max Y; uv v=0 at min Y
    tex.anisotropy = 4;
    const out = { tex, bounds };
    texCache[key] = out;
    return out;
  }

  async function compositeAbpOrtho(db) {
    // db = ABP dem bounds [[y0,x0],[y1,x1]]; canvas at 4 px/ft (ortho native ~3 in/px)
    const x0 = db[0][1], y0 = db[0][0], x1 = db[1][1], y1 = db[1][0];
    const ppf = 4;
    const c = document.createElement("canvas");
    c.width = Math.round((x1 - x0) * ppf); c.height = Math.round((y1 - y0) * ppf);
    const g = c.getContext("2d");
    const put = (img, b) => {   // b = [bx0,by0,bx1,by1] in SP ft; canvas row 0 = north
      const px = (b[0] - x0) * ppf, pw = (b[2] - b[0]) * ppf;
      const py = (y1 - b[3]) * ppf, ph = (b[3] - b[1]) * ppf;
      g.drawImage(img, px, py, pw, ph);
    };
    const load = url => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    if (SBMM_DATA.ortho_site_jpg && SBMM_DATA.ortho_site.x0) {
      const o = SBMM_DATA.ortho_site;
      put(await load(SBMM_DATA.ortho_site_jpg), [o.x0, o.y0, o.x1, o.y1]);
    } else {
      put(await load(SBMM_DATA.hs_abp_jpg || SBMM_DATA.hs_abp_png), [x0, y0, x1, y1]);
    }
    /* finest imagery last: site (1.5 ft) → mine area (6 in) → ABP (3 in) */
    if (SBMM_DATA.ortho_mine && SBMM_DATA.ortho_mine.x0 && SBMM_DATA.ortho_mine_jpg) {
      const om = SBMM_DATA.ortho_mine;
      put(await load(SBMM_DATA.ortho_mine_jpg), [om.x0, om.y0, om.x1, om.y1]);
    }
    const o = SBMM_DATA.ortho_abp;
    put(await load(SBMM_DATA.ortho_abp_jpg), [o.x0, o.y0, o.x1, o.y1]);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true; tex.anisotropy = 4;
    return { tex, bounds: [x0, y0, x1, y1] };
  }

  async function setStyle(kind) {
    for (const t of terrainMeshes) {
      const which = whichFor(t.dem);
      const { tex, bounds } = await texture(kind, which);
      setUVs(t, bounds);
      t.mesh.material.map = tex;
      t.mesh.material.needsUpdate = true;
    }
    requestRender();
  }

  function drapeZ(x, y, off = 2) { const [z] = SBMM.elev(x, y); return (isNaN(z) ? ZMID : z) - ZMID + off; }
  function drapedLine(pts, color, closed, off = 2, width) {
    const dense = [];
    const P = closed ? [...pts, pts[0]] : pts;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], d = dist2d(a, b), n = Math.max(1, Math.ceil(d / 10));
      for (let k2 = 0; k2 <= n; k2++) {
        const x = a[0] + (b[0] - a[0]) * k2 / n, y = a[1] + (b[1] - a[1]) * k2 / n;
        dense.push(new THREE.Vector3(x - CX, y - CY, drapeZ(x, y, off)));
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(dense);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, linewidth: width || 1 }));
  }

  /* Survey contour lines in 3D. No drape sampling is needed — a contour's level IS its
     elevation, so every vertex sits at a constant z. ~40k vertices total, so each
     (layer, weight) class is merged into ONE LineSegments object (4 draw calls, not
     thousands of Line objects). Colors match the 2D layers. */
  function buildContourGroup() {
    const g = new THREE.Group();
    let dropped = 0, kept = 0;
    /* Some source polylines splice disjoint contour parts together, leaving straight
       "bridge" segments up to ~4800 ft long. Flat on a 2D map they are easy to miss;
       in 3D they hang in mid-air. A plain length cutoff would also delete real geometry
       (the 10-ft site contours are genuinely coarse — median vertex spacing 33 ft), so
       the test is physical instead: a real contour segment lies on terrain at its own
       level. Drop a segment whose ends have no terrain, or whose midpoint elevation
       disagrees with the contour level. */
    const BRIDGE_FT = 150, TOL_FT = 20;
    const onTerrain = (x, y) => { const z = SBMM.elev(x, y)[0]; return isNaN(z) ? null : z; };
    for (const c of [{ key: "contours_site", color: 0x6E8593, mod: 50 },
                     { key: "contours_abp", color: 0x87A9B8, mod: 10 }]) {
      const data = SBMM_DATA[c.key];
      if (!data) continue;
      const seg = { heavy: [], light: [] };
      for (const [lv, pts] of data) {
        if (!pts || pts.length < 2) continue;
        const arr = seg[lv % c.mod === 0 ? "heavy" : "light"];
        const z = lv - ZMID + 1.5;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          if (onTerrain(a[0], a[1]) === null || onTerrain(b[0], b[1]) === null) { dropped++; continue; }
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > BRIDGE_FT) {
            const zm = onTerrain((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
            if (zm === null || Math.abs(zm - lv) > TOL_FT) { dropped++; continue; }
          }
          kept++;
          arr.push(a[0] - CX, a[1] - CY, z, b[0] - CX, b[1] - CY, z);
        }
      }
      for (const k of ["heavy", "light"]) {
        if (!seg[k].length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(seg[k], 3));
        g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
          color: c.color, transparent: true, opacity: k === "heavy" ? 0.85 : 0.45
        })));
      }
    }
    SBMM._v3dContourDrop = { kept, dropped };
    return g;
  }

  /* cheap text sprite for draped annotations — canvas texture, cached by content */
  const spriteCache = new Map();
  function textSprite(str, colorHex, worldH) {
    const key = str + "|" + colorHex;
    let mat = spriteCache.get(key);
    if (!mat) {
      const pad = 8, fs = 44;
      const m = document.createElement("canvas").getContext("2d");
      m.font = `600 ${fs}px ui-monospace, Consolas, monospace`;
      const w = Math.ceil(m.measureText(str).width) + pad * 2;
      const c = document.createElement("canvas");
      c.width = Math.max(8, w); c.height = fs + pad * 2;
      const g = c.getContext("2d");
      g.font = `600 ${fs}px ui-monospace, Consolas, monospace`;
      g.fillStyle = "rgba(14,20,24,.72)";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#" + colorHex.toString(16).padStart(6, "0");
      g.textBaseline = "middle";
      g.fillText(str, pad, c.height / 2);
      const tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
      mat.userData = { aspect: c.width / c.height };
      spriteCache.set(key, mat);
    }
    const s = new THREE.Sprite(mat);
    const h = worldH || 34;
    s.scale.set(h * mat.userData.aspect, h, 1);
    return s;
  }

  /* One texture per photo feature, decoded once. The image is a data URL, so
     the load is synchronous-ish but still async: the sprite goes into the scene
     grey and asks for one more frame when the pixels arrive. */
  const photoTex = new Map();          // feature id -> {tex, aspect}
  function photoSprite(f, sel) {
    const src = (f.props && (f.props.thumb || f.props.img)) || null;
    if (!src) return null;
    let rec = photoTex.get(f.id);
    if (!rec || rec.src !== src) {
      const img = new Image();
      rec = { src, tex: new THREE.Texture(img), aspect: 1 };
      img.onload = () => {
        rec.tex.needsUpdate = true;
        rec.aspect = img.width / Math.max(1, img.height);
        requestRender();
      };
      img.src = src;
      rec.tex.minFilter = THREE.LinearFilter;
      photoTex.set(f.id, rec);
    }
    const mat = new THREE.SpriteMaterial({ map: rec.tex, transparent: true,
      color: sel ? 0xFFF0C0 : 0xFFFFFF, depthTest: true });
    const sp = new THREE.Sprite(mat);
    const h = sel ? 58 : 46;
    sp.scale.set(h * rec.aspect, h, 1);
    return sp;
  }

  function designMesh(f) {
    const s = f._surf;
    /* rebuildOverlays() runs on every selection change; sampling ~48k ground
       elevations each time would make clicking feel sticky, so the geometry is
       cached on the raster itself and thrown away whenever the surface is
       regenerated (which replaces f._surf wholesale) */
    if (s._geom) return meshesFor(f, s._geom);
    const stride = Math.max(1, Math.ceil(Math.max(s.nx, s.ny) / 220));
    const nx = Math.floor((s.nx - 1) / stride) + 1, ny = Math.floor((s.ny - 1) / stride) + 1;
    if (nx < 2 || ny < 2) return null;
    const pos = new Float32Array(nx * ny * 3);
    const good = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const si = Math.min(s.nx - 1, i * stride), sj = Math.min(s.ny - 1, j * stride);
        const x = s.x0 + si * s.cell, y = s.y0 + sj * s.cell;
        const dz = s.z[sj * s.nx + si];
        const k = j * nx + i;
        const [gz] = SBMM.elev(x, y);
        pos[k * 3] = x - CX; pos[k * 3 + 1] = y - CY;
        pos[k * 3 + 2] = (isNaN(dz) ? ZMID : dz) - ZMID;
        /* keep only the graded part: a node that matches existing ground is not
           part of the design any reader cares about, and drawing it would fight
           the terrain mesh for the same depth */
        good[k] = (!isNaN(dz) && (isNaN(gz) || Math.abs(dz - gz) > 0.12)) ? 1 : 0;
      }
    }
    const idx = [];
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        if (!(good[a] && good[b] && good[c] && good[d])) continue;
        idx.push(a, c, b, b, c, d);
      }
    }
    if (!idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    s._geom = g;
    return meshesFor(f, g);
  }

  function meshesFor(f, g) {
    const col = (f.style && f.style.color) ? new THREE.Color(f.style.color).getHex() : 0x4FD8E6;
    /* Two passes, because most of an excavation's design surface lies UNDER existing
       ground and a plain depth-tested mesh is therefore invisible exactly where the
       engineering is. The solid pass shows the design where it stands above grade
       (fill); the x-ray pass ignores depth and ghosts the buried part through the
       terrain — the same convention a CAD viewer uses for a proposed surface. */
    const grp = new THREE.Group();
    const solid = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      color: col, transparent: true, opacity: 0.62, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2
    }));
    solid.renderOrder = 3;
    const xray = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false
    }));
    xray.renderOrder = 4;
    grp.add(solid); grp.add(xray);
    return grp;
  }

  /* ---------------- design sheets draped on the terrain ----------------
     Each registered plan sheet is a north-up State-Plane-aligned PNG with the
     paper knocked out to transparency, so it can be laid over the ground the
     same way the ortho is. One small mesh per sheet, sampling the DEM across
     the sheet's own footprint, is enough: the sheets cover a few hundred feet,
     not the whole site.

     These live in their own group rather than in overlayGroup because
     overlayGroup is thrown away and rebuilt on every checkbox change, and
     re-uploading sheet textures on each of those would be wasteful. Meshes are
     built lazily on first enable and disposed when switched off. */

  const SHEET_STEP_FT = 6;      // DEM sample spacing across the drape
  const SHEET_OFF_FT = 2.5;     // stand-off above the ground, pre-exaggeration
  const wantSheets = new Set();
  let sheetGroup = null;
  const sheetMeshes = new Map();
  const sheetTex = new Map();

  /* §1/§4: 3D visibility IS layer visibility. Nothing in this file owns a
     checkbox any more; every one of these reads the one state. */
  const LS = (g, l) => SBMM.layerState.isOn(g, l);
  function sheetsOn() { return LS("design", "sheets3d"); }

  function sheetRaster(name) {
    const D = window.SBMM_DATA && SBMM_DATA.design_ea;
    const s = D && D.sheets && D.sheets[name];
    const r = s && s.raster;
    if (!r) return null;
    const url = SBMM_DATA["design_" + name.replace(/-/g, "") + "_png"];
    return url ? { r, url } : null;
  }

  async function buildSheetMesh(name) {
    const got = sheetRaster(name);
    if (!got) return null;
    const { r, url } = got;
    let tex = sheetTex.get(name);
    if (!tex) {
      tex = await new Promise((res, rej) =>
        new THREE.TextureLoader().load(url, res, undefined, rej));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = true;            // PNG row 0 = north = max Y; uv v=0 at min Y
      tex.anisotropy = 4;
      sheetTex.set(name, tex);
    }
    const nx = clamp(Math.ceil((r.x1 - r.x0) / SHEET_STEP_FT) + 1, 2, 400);
    const ny = clamp(Math.ceil((r.y1 - r.y0) / SHEET_STEP_FT) + 1, 2, 400);
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    const bad = new Uint8Array(nx * ny);      // vertex sits on DEM NoData
    let k = 0, u = 0, n = 0;
    for (let j = 0; j < ny; j++) {
      const fy = j / (ny - 1), y = r.y0 + (r.y1 - r.y0) * fy;
      for (let i = 0; i < nx; i++) {
        const fx = i / (nx - 1), x = r.x0 + (r.x1 - r.x0) * fx;
        const [z] = SBMM.elev(x, y);
        bad[n++] = isNaN(z) ? 1 : 0;
        pos[k++] = x - CX; pos[k++] = y - CY;
        pos[k++] = (isNaN(z) ? ZMID : z) - ZMID + SHEET_OFF_FT;
        uv[u++] = fx; uv[u++] = fy;
      }
    }
    /* Drop any cell touching NoData. Substituting a mid-site elevation there
       instead (which is what drapeZ does, correctly, for lines) leaves the
       drape hanging hundreds of feet off the real ground at the survey limit
       and draws it as a vertical curtain — the same failure the terrain meshes
       avoid by skipping NoData cells. */
    const idx = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (bad[a] || bad[b] || bad[c] || bad[d]) continue;
      idx.push(a, c, b, b, c, d);
    }
    if (!idx.length) return null;             // nothing of this sheet is on terrain
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    /* Unlit, so the drawing reads as a drawing and not as shaded ground.
       depthWrite off + a high renderOrder keeps the transparent paper from
       punching holes in the terrain or the canopy behind it; alphaTest drops
       the fully-clear pixels outright so they never enter the blend at all. */
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: true,
      alphaTest: 0.02, side: THREE.DoubleSide, toneMapped: false
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 3;
    mesh.userData.sheet = name;      // so a click on the drape can name the sheet
    return mesh;
  }

  function disposeSheetMesh(name) {
    const m = sheetMeshes.get(name);
    if (!m) return;
    if (sheetGroup) sheetGroup.remove(m);
    m.geometry.dispose();
    m.material.dispose();          // the texture is cached and shared, keep it
    sheetMeshes.delete(name);
  }

  async function syncSheets() {
    if (!scene) return;            // desired state is replayed when 3D opens
    if (!sheetGroup) {
      sheetGroup = new THREE.Group();
      sheetGroup.scale.z = exag();
      scene.add(sheetGroup);
    }
    for (const n of [...sheetMeshes.keys()]) if (!wantSheets.has(n)) disposeSheetMesh(n);
    for (const n of wantSheets) {
      if (sheetMeshes.has(n)) continue;
      try {
        const m = await buildSheetMesh(n);
        if (m) { sheetMeshes.set(n, m); sheetGroup.add(m); }
      } catch (e) { console.error("sheet drape " + n, e); toast("3D sheet failed: " + n); }
    }
    sheetGroup.visible = sheetsOn();
    requestRender();
  }

  function sheetDrape(name, on) {
    if (on) wantSheets.add(name); else wantSheets.delete(name);
    return syncSheets();
  }

  /* ---------------- isopach drape (§5) ----------------
     The same trick as a sheet drape: one small mesh sampling the DEM across the
     overlay's own footprint, textured with the heat map js/isopach.js already
     painted for the 2D map. Reusing that PNG is the point — one picture, one
     legend, two views, and no second colour ramp to keep in step. */
  /* Since v10 there is more than one of these — the isopach heat map and the
     water tool's rim band — so the mechanism is a small LIST rather than one
     named mesh. One mesh per source, keyed on the source's own URL and bounds
     so a repaint that changes nothing costs nothing. `refreshIsopach` stays as
     an alias: it is what js/isopach.js and the e2e both call. */
  const DRAPES = [
    ["isopach", () => SBMM.isopach && SBMM.isopach.drapeSpec && SBMM.isopach.drapeSpec()],
    ["water", () => SBMM.water && SBMM.water.drapeSpec && SBMM.water.drapeSpec()]
  ];
  const drapeMesh = {}, drapeKey = {};
  function refreshDrapes() { return Promise.all(DRAPES.map(d => syncDrape(d[0], d[1]))); }
  function refreshIsopach() { return refreshDrapes(); }
  async function syncDrape(name, specOf) {
    let spec = null;
    try { spec = specOf(); } catch (e) { spec = null; }
    const key = spec ? spec.url.length + ":" + spec.bounds.join(",") : null;
    if (key === drapeKey[name]) return;
    drapeKey[name] = key;
    const old = drapeMesh[name];
    if (old) {
      scene.remove(old);
      old.geometry.dispose();
      if (old.material.map) old.material.map.dispose();
      old.material.dispose();
      delete drapeMesh[name];
    }
    if (!spec || !scene) { requestRender(); return; }
    const [x0, y0, x1, y1] = spec.bounds;
    try {
      const tex = await new Promise((res, rej) =>
        new THREE.TextureLoader().load(spec.url, res, undefined, rej));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = true;
      const nx = clamp(Math.ceil((x1 - x0) / 12) + 1, 2, 320);
      const ny = clamp(Math.ceil((y1 - y0) / 12) + 1, 2, 320);
      const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
      const bad = new Uint8Array(nx * ny);
      let k = 0, u = 0, n = 0;
      for (let j = 0; j < ny; j++) {
        const fy = j / (ny - 1), y = y0 + (y1 - y0) * fy;
        for (let i = 0; i < nx; i++) {
          const fx = i / (nx - 1), x = x0 + (x1 - x0) * fx;
          const [z] = SBMM.elev(x, y);
          bad[n++] = isNaN(z) ? 1 : 0;
          pos[k++] = x - CX; pos[k++] = y - CY;
          pos[k++] = (isNaN(z) ? ZMID : z) - ZMID + 3.5;
          uv[u++] = fx; uv[u++] = fy;
        }
      }
      const idx = [];
      for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        if (bad[a] || bad[b] || bad[c] || bad[d]) continue;
        idx.push(a, c, b, b, c, d);
      }
      if (!idx.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, alphaTest: 0.02,
        side: THREE.DoubleSide, toneMapped: false
      }));
      mesh.renderOrder = 4;
      mesh.scale.z = exag();
      scene.add(mesh);
      drapeMesh[name] = mesh;
    } catch (e) { console.error(name + " drape", e); }
    requestRender();
  }

  let lastCadSkip = 0;          // so the drape-budget toast fires once, not per rebuild
  function rebuildOverlays() {
    if (!scene) return;
    if (overlayGroup) scene.remove(overlayGroup);
    overlayGroup = new THREE.Group();
    const zx = exag();
    if (LS("framework", "dus")) {
      const DU_COLOR = { "DU-1N": 0xE4796A, "DU-1S": 0xE4796A, "DU-2": 0x5B8FF9, "DU-3": 0x4FCE9B };
      for (const d of SBMM_DATA.dus) overlayGroup.add(drapedLine(d.ring, DU_COLOR[d.name] || 0xcccccc, true, 3));
    }
    if (LS("framework", "piles")) {
      for (const p of SBMM_DATA.piles) {
        const traced = (p.name || "").includes("Fig 2");
        overlayGroup.add(drapedLine(p.ring, traced ? 0xE8B34B : 0x8BE04B, true, 3));
      }
    }
    /* No 3D "design" master any more: designGIS.rings3d() and CadNative.rings3d()
       already return only the layers whose rows are on, so the 3D view draws the
       design the Layers tree says is showing — nothing more, nothing less. */
    if (SBMM.designGIS) {
      for (const r of SBMM.designGIS.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), true, 3);
        /* userData.pick is what js/pick3d.js walks the overlay group for; it is
           the only thing that makes a 3D click able to say what it hit (§8) */
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        overlayGroup.add(o);
      }
    }
    /* the August-2026 survey linework (spec §10): the pipes, the sandbag wall
       and the pit contours, draped like the design polygons and pickable */
    if (SBMM.survey && SBMM.survey.lines3d) {
      for (const r of SBMM.survey.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        overlayGroup.add(o);
      }
    }
    /* the storm-drainage network (v12 §5.1): the conduits draped on the ground
       and a dot at every structure, in the storm colour rather than the water
       one — the pipes are infrastructure, the flow is the terrain's answer. */
    if (SBMM.storm && SBMM.storm.lines3d) {
      const SC = new THREE.Color(SBMM.storm.COLOR || "#7FA7C9").getHex();
      for (const r of SBMM.storm.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        overlayGroup.add(o);
      }
      const sp = SBMM.storm.points3d();
      if (sp.length) {
        const pos = [];
        for (const q of sp) pos.push(q.x - CX, q.y - CY, drapeZ(q.x, q.y, 5));
        const gg = new THREE.BufferGeometry();
        gg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        overlayGroup.add(new THREE.Points(gg,
          new THREE.PointsMaterial({ size: 7, color: SC, sizeAttenuation: true })));
      }
    }
    /* EA native CAD design linework. designgis owns the authoritative polygons;
       these are the drafted lines around them, and they were previously visible
       in 2D only — which meant clicking one in 3D found nothing at all. */
    if (SBMM.CadNative && SBMM.CadNative.rings3d) {
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
        overlayGroup.add(o);
      }
      if (skipped && skipped !== lastCadSkip) {
        toast(`3D: ${fmt0(skipped)} CAD lines beyond the ${fmt0(BUDGET)}-line drape budget are not shown — switch a group off in Layers`, 5200);
      }
      lastCadSkip = skipped;
    }
    if (SBMM.designEA && LS("design", "pdf_boundaries")) {
      const DCOL = { "area-validated": 0xFF6B4A, "unclassified": 0xE8B34B, "surveyed": 0x4FD2E8 };
      for (const r of SBMM.designEA.rings3d())
        overlayGroup.add(drapedLine(r.ring, DCOL[r.conf] || 0xcccccc, true, 3));
    }
    {
      const COLORS = { line: 0x4FB3CE, area: 0x4FB3CE, volume: 0x4FCE9B, profile: 0xC792EA,
                       dim: 0xE8B34B, text: 0xE8EEF1, flow: 0x55C1FF };
      /* every object a feature contributes carries its id, so a 3D click can
         select, inspect and edit exactly the feature a 2D click would (§8) */
      const own = (o, f) => { o.userData.pick = { kind: "feature", fid: f.id }; return o; };
      for (const f of SBMM.store.features) {
        /* both masks: the feature's own visibility AND its My-work class row */
        if (!f.visible || !SBMM.myWork.shown(f)) continue;
        const sel = SBMM.store.selected === f.id;
        let col = COLORS[f.type] || 0xFFD34D;
        if (f.style && f.style.color) col = new THREE.Color(f.style.color).getHex();
        if (sel) col = 0xFFD34D;
        /* annotations: the geometry drapes as usual, the label rides above it as a sprite */
        if (f.type === "dim" && f.pts.length > 1) {
          overlayGroup.add(own(drapedLine(f.pts, col, false, sel ? 5 : 3.5), f));
          const mx = (f.pts[0][0] + f.pts[1][0]) / 2, my = (f.pts[0][1] + f.pts[1][1]) / 2;
          const sp = textSprite(fmt(dist2d(f.pts[0], f.pts[1]), 1) + " ft", col, 30);
          sp.position.set(mx - CX, my - CY, drapeZ(mx, my, 22));
          overlayGroup.add(own(sp, f));
          continue;
        }
        if (f.type === "text") {
          if (f.pts.length > 1) overlayGroup.add(own(drapedLine(f.pts, col, false, 3), f));
          const [tx, ty] = f.pts[0];
          const sp = textSprite((f.props && f.props.text) || f.name || "text", col,
            clamp((f.props && f.props.size_ft) || 20, 8, 120));
          sp.position.set(tx - CX, ty - CY, drapeZ(tx, ty, 26));
          overlayGroup.add(own(sp, f));
          continue;
        }
        /* v10: the run drapes like any line, and the two things that make it a
           WATER feature ride with it — each pond as a closed draped ring at its
           own level, and the drop itself as a small sphere you can pick. */
        if (f.type === "flow") {
          overlayGroup.add(own(drapedLine(f.pts, col, false, sel ? 4.5 : 3), f));
          const pr = f.props || {};
          for (const pd of (pr.ponds || []))
            for (const ring of (pd.rings || []))
              if (ring && ring.length > 2)
                overlayGroup.add(own(drapedLine(ring, 0x55C1FF, true, 2), f));
          /* v12: a conduit leg is a STRAIGHT line between its two ends at their
             own elevations — not draped, because the water is under the ground
             there and a draped line would draw a pipe following the hill it
             passes beneath. */
          for (const lg of (pr.legs || [])) {
            if (!lg.from || !lg.to) continue;
            const za = lg.from_z == null ? drapeZ(lg.from[0], lg.from[1], 0) : lg.from_z - ZMID;
            const zb = lg.to_z == null ? drapeZ(lg.to[0], lg.to[1], 0) : lg.to_z - ZMID;
            const gg = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(lg.from[0] - CX, lg.from[1] - CY, za + 1),
              new THREE.Vector3(lg.to[0] - CX, lg.to[1] - CY, zb + 1)]);
            overlayGroup.add(own(new THREE.Line(gg, new THREE.LineBasicMaterial(
              { color: 0x7FA7C9, transparent: true, opacity: .95 })), f));
          }
          const dp = pr.drop || f.pts[0];
          const sp = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 12),
            new THREE.MeshBasicMaterial({ color: sel ? 0xFFD34D : 0x9FDCFF }));
          sp.position.set(dp[0] - CX, dp[1] - CY, drapeZ(dp[0], dp[1], 6));
          overlayGroup.add(own(sp, f));
          continue;
        }
        if (f.type === "spot") {
          const [x, y] = f.pts[0];
          const s = new THREE.Mesh(new THREE.SphereGeometry(sel ? 9 : 6, 10, 10),
            new THREE.MeshBasicMaterial({ color: col }));
          s.position.set(x - CX, y - CY, drapeZ(x, y, 4));
          overlayGroup.add(own(s, f));
          continue;
        }
        /* v11 §4.4 — a field photo stands on the ground as a billboard of its
           own thumbnail, so "what does it look like there" is answerable from
           the model. The texture is cached per feature: a sprite is rebuilt on
           every overlay pass and re-decoding a data URL each time would cost
           more than the whole overlay. */
        if (f.type === "photo") {
          const [x, y] = f.pts[0];
          const sp = photoSprite(f, sel);
          if (sp) { sp.position.set(x - CX, y - CY, drapeZ(x, y, 34)); overlayGroup.add(own(sp, f)); }
          const st = new THREE.Mesh(new THREE.SphereGeometry(sel ? 6 : 4, 8, 8),
            new THREE.MeshBasicMaterial({ color: sel ? 0xFFD34D : 0xE8B34B }));
          st.position.set(x - CX, y - CY, drapeZ(x, y, 4));
          overlayGroup.add(own(st, f));
          continue;
        }
        overlayGroup.add(own(drapedLine(f.pts, col, f.type === "area" || f.type === "volume", sel ? 4.5 : 3), f));
      }
    }
    /* design surfaces drape as a translucent shell over the terrain — only over the
       area they actually grade. Nodes where the design equals existing ground are
       dropped rather than drawn, which both removes the z-fighting a coincident
       sheet would cause and makes the cut/fill visible as a solid standing off the
       ground. The raster is decimated to keep the shell a few tens of thousands of
       triangles however fine the design grid is. */
    for (const f of SBMM.store.features) {
      if (f.type !== "surface" || !f._surf || f.visible === false) continue;
      if (!SBMM.myWork.shown(f)) continue;
      if (f.props && f.props.drape3d === false) continue;
      const m = designMesh(f);
      if (m) { m.userData.pick = { kind: "feature", fid: f.id }; overlayGroup.add(m); }
    }

    /* datasets: a billboard dot per record, plus — where the dataset has a depth
       attribute and sticks are switched on — a vertical line from the ground down
       that depth. The stick is drawn in scene units and the group is z-scaled by
       the exaggeration slider like everything else, so a 40 ft boring stays 40 ft
       relative to the terrain it is standing in however hard the relief is pushed. */
    /* datasets: threeSpec() already returns only the datasets whose rows are on */
    if (SBMM.datasets) {
      for (const spec of SBMM.datasets.threeSpec()) {
        const pos = [], seg = [];
        const c = new THREE.Color(spec.color);
        for (const p of spec.pts) {
          const [z0] = SBMM.elev(p.x, p.y);
          const z = (isNaN(z0) ? ZMID : z0) - ZMID;
          pos.push(p.x - CX, p.y - CY, z + 4);
          if (spec.stick && p.depth > 0)
            seg.push(p.x - CX, p.y - CY, z + 1, p.x - CX, p.y - CY, z - p.depth);
        }
        if (pos.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          const dots = new THREE.Points(g,
            new THREE.PointsMaterial({ size: spec.size, color: c, sizeAttenuation: true }));
          /* threeSpec() walks d.points in order, so a raycast index IS the
             record index — that is what lets a 3D click on a well marker open
             the very popup its 2D marker opens */
          dots.userData.pick = { kind: "dataset", dsId: spec.id };
          overlayGroup.add(dots);
        }
        if (seg.length) {
          const g2 = new THREE.BufferGeometry();
          g2.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
          /* The stick is below the ground by definition, so with depth testing on
             it is inside the terrain mesh and invisible — a depth attribute that
             draws nothing. Drawn without depth test and semi-transparent it reads
             as what it is: the hole seen through the ground, the way a fence
             diagram or a Civil 3D borehole does. */
          const stick = new THREE.LineSegments(g2, new THREE.LineBasicMaterial({
            color: c, transparent: true, opacity: .55, depthTest: false, depthWrite: false
          }));
          stick.renderOrder = 2;
          /* the stick belongs to the same record as the dot above it — clicking
             the borehole, not just its cap, has to open the log */
          stick.userData.pick = { kind: "dataset", dsId: spec.id, stick: true,
                                  idx: spec.pts.map((p, i) => i).filter(i => spec.pts[i].depth > 0) };
          overlayGroup.add(stick);
        }
      }
    }

    if (LS("invest", "samples")) {
      const pos = [], col = [];
      for (const p of SBMM.samples) {
        pos.push(p.x - CX, p.y - CY, drapeZ(p.x, p.y, 4));
        const c = new THREE.Color(p.exc ? 0xE4796A : 0x5FBF8F);
        col.push(c.r, c.g, c.b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      pointsObj = new THREE.Points(g, new THREE.PointsMaterial({ size: 14, vertexColors: true, sizeAttenuation: true }));
      pointsObj.userData.pick = { kind: "sample" };
      overlayGroup.add(pointsObj);
    }

    /* detected trees, when the canopy detector has been run. One billboard per
       tree at crown top, so the 3D view can answer "what is that tree" the same
       way the 2D dot layer does. */
    const td = SBMM.trees && SBMM.trees.data;
    if (td && td.n && LS("base", "trees_detected")) {
      const pos = [];
      for (let i = 0; i < td.n; i++) {
        const [z0] = SBMM.elev(td.x[i], td.y[i]);
        pos.push(td.x[i] - CX, td.y[i] - CY, (isNaN(z0) ? ZMID : z0) - ZMID + td.h[i]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const tp = new THREE.Points(g, new THREE.PointsMaterial({
        size: 10, color: 0x6FBF7F, sizeAttenuation: true, transparent: true, opacity: .8 }));
      tp.userData.pick = { kind: "tree" };
      overlayGroup.add(tp);
    }

    /* cultural resources (§7) — CONFIDENTIAL, drawn only while the group is on.
       Same draped-ring treatment as the design areas, plus a marker per isolate,
       in the layer's own red/amber so it reads as a restricted overlay rather
       than as more design furniture. The stamp element over the 3D canvas is
       put up by js/cultural.js; the snapshot gets it burned in. */
    if (SBMM.cultural && SBMM.cultural.visible()) {
      for (const r of SBMM.cultural.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), true, 3);
        o.userData.pick = { kind: "cultural", feature: r.feature };
        overlayGroup.add(o);
      }
      const cp = SBMM.cultural.points3d();
      if (cp.length) {
        const pos = [], col = [];
        for (const p of cp) {
          pos.push(p.x - CX, p.y - CY, drapeZ(p.x, p.y, 5));
          const c = new THREE.Color(p.color);
          col.push(c.r, c.g, c.b);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        const cpo = new THREE.Points(g, new THREE.PointsMaterial({
          size: 16, vertexColors: true, sizeAttenuation: true }));
        cpo.userData.pick = { kind: "culturalPt", pts: cp };
        overlayGroup.add(cpo);
      }
    }
    overlayGroup.scale.z = zx;
    scene.add(overlayGroup);
    /* hand the freshly built objects to the pick registry (§8) so a click in 3D
       opens the same popup a click in 2D does */
    if (SBMM.pick3d) SBMM.pick3d.syncScene();
    requestRender();
  }

  /* mesh density: "high" is the default (smooth on decent hardware); "standard" is the
     fallback for weak machines. Changing it disposes the old geometry and rebuilds. */
  function detailMaxDim() {
    const d = $("v3dDetail");
    return d && d.value === "std" ? 640 : 1100;
  }

  async function rebuildTerrain(style) {
    for (const t of terrainMeshes) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
    }
    terrainMeshes = [];
    const maxDim = detailMaxDim();
    /* One mesh per DEM, coarsest first, each one holed by every finer window
       ahead of it in SBMM.dems. Built in reverse stack order so the loop below
       adds the fine meshes last. */
    const stack = SBMM.dems.slice().reverse();      // site, res, abp
    const built = [];
    for (let k = 0; k < stack.length; k++) {
      const finer = stack.slice(k + 1).map(demRect);   // the windows above it
      built.push(buildTerrain(stack[k], strideFor(stack[k], maxDim), finer));
    }
    const zx0 = exag();
    for (const t of built) {
      t.mesh = new THREE.Mesh(t.geom, new THREE.MeshLambertMaterial({ color: 0xffffff }));
      t.mesh.scale.z = zx0;                 // match the slider's current value
      scene.add(t.mesh);
      terrainMeshes.push(t);
    }
    /* textures are cached, so re-applying the current drape is cheap */
    await setStyle(style || $("v3dStyle").value);
    SBMM._v3dVerts = terrainMeshes.reduce((n, t) => n + t.nx * t.ny, 0);
    requestRender();
  }

  /* ==================================================================== */
  /* navigation rig                                                       */
  /* ==================================================================== */
  const MINR = 40, MAXR = 60000, PHI_MAX = Math.PI * 0.495, PHI_MIN = 0.012;
  const CLEAR_FT = 3;                 // minimum real clearance above the ground

  function groundSceneZ(sx, sy) {
    const [z] = SBMM.elev(sx + CX, sy + CY);
    return isNaN(z) ? null : z - ZMID;
  }

  function makeNav(dom) {
    const st = {
      mode: "orbit",
      target: new THREE.Vector3(), targetDst: new THREE.Vector3(),
      sph: { r: 5200, theta: 0, phi: 1.0 },
      dst: { r: 5200, theta: 0, phi: 1.0 },
      yaw: 0, pitch: -0.35,            // fly-mode look
      keys: new Set(),
      drag: null, lastX: 0, lastY: 0,
      sens: 1, flySpeed: 1, clampGround: true,
      dampRate: 13, lastT: performance.now(), moving: false
    };

    /* ---- spherical <-> cartesian (z-up) ---- */
    function offsetOf(s) {
      const sp = Math.sin(s.phi), cp = Math.cos(s.phi);
      return new THREE.Vector3(s.r * sp * Math.sin(s.theta), s.r * sp * Math.cos(s.theta), s.r * cp);
    }
    function setFromCamera() {
      const off = camera.position.clone().sub(st.targetDst);
      st.dst.r = clamp(off.length(), MINR, MAXR);
      st.dst.phi = clamp(Math.acos(clamp(off.z / (st.dst.r || 1), -1, 1)), PHI_MIN, PHI_MAX);
      st.dst.theta = Math.atan2(off.x, off.y);
      st.sph = { ...st.dst };
      st.target.copy(st.targetDst);
    }

    /* ---- terrain clamp ---- */
    function clampOrbit() {
      if (!st.clampGround) return;
      const zx = exag();
      const g = groundSceneZ(camera.position.x, camera.position.y);
      if (g == null) return;
      const minZ = (g + CLEAR_FT) * zx;
      if (camera.position.z >= minZ) return;
      /* lift the camera and fold the correction back into the polar angle so the
         orbit state and the actual camera never disagree */
      const off = camera.position.clone().sub(st.target);
      const r = off.length() || 1;
      const nz = clamp(minZ - st.target.z, -r * 0.999, r * 0.999);
      const horiz = Math.sqrt(Math.max(0, r * r - nz * nz));
      const hlen = Math.hypot(off.x, off.y) || 1;
      off.set(off.x / hlen * horiz, off.y / hlen * horiz, nz);
      camera.position.copy(st.target).add(off);
      const phi = clamp(Math.acos(clamp(nz / r, -1, 1)), PHI_MIN, PHI_MAX);
      st.sph.phi = phi;
      if (st.dst.phi > phi) st.dst.phi = phi;
    }
    function clampFly() {
      if (!st.clampGround) return;
      const zx = exag();
      const g = groundSceneZ(camera.position.x, camera.position.y);
      if (g == null) return;
      const minZ = (g + CLEAR_FT) * zx;
      if (camera.position.z < minZ) camera.position.z = minZ;
    }
    function heightAboveGroundFt() {
      const zx = exag();
      const g = groundSceneZ(camera.position.x, camera.position.y);
      if (g == null) return 500;
      return Math.max(1, camera.position.z / zx - g);
    }

    /* ---- per-frame update; returns true when something actually moved ---- */
    function update() {
      const now = performance.now();
      const dt = Math.min(0.3, (now - st.lastT) / 1000);
      st.lastT = now;
      let moved = false;

      if (st.mode === "fly") {
        const sp = flyStep(dt);
        if (sp) moved = true;
        clampFly();
        const fwd = dirFromYawPitch();
        st.targetDst.copy(camera.position).addScaledVector(fwd, Math.max(300, st.dst.r * 0.5));
        st.target.copy(st.targetDst);
        camera.lookAt(st.targetDst);
        if (st.lookDirty) { moved = true; st.lookDirty = false; }
      } else {
        /* frame-rate-independent damping: the same wall-clock settle time whether the
           GPU is doing 120 fps or software GL is doing 2 */
        const d = 1 - Math.exp(-st.dampRate * dt);
        let dth = st.dst.theta - st.sph.theta;
        while (dth > Math.PI) dth -= 2 * Math.PI;
        while (dth < -Math.PI) dth += 2 * Math.PI;
        const dph = st.dst.phi - st.sph.phi;
        const dr = st.dst.r - st.sph.r;
        const dt3 = st.targetDst.clone().sub(st.target);
        const near = Math.abs(dth) < 1e-5 && Math.abs(dph) < 1e-5 &&
                     Math.abs(dr) < Math.max(0.02, st.sph.r * 1e-5) && dt3.lengthSq() < 1e-4;
        if (near) {
          if (st.moving) {
            st.sph.theta = st.dst.theta; st.sph.phi = st.dst.phi; st.sph.r = st.dst.r; st.target.copy(st.targetDst); moved = true; st.moving = false;
            /* the camera has come to rest — remember where (F11). Only on
               settle, so an orbit gesture writes once and not per frame; the
               store debounces on top of that. */
            saveCamera();
          }
        } else {
          st.sph.theta += dth * d; st.sph.phi += dph * d; st.sph.r += dr * d;
          st.target.addScaledVector(dt3, d);
          moved = true; st.moving = true;
        }
        if (moved || st.forceApply) {
          st.sph.phi = clamp(st.sph.phi, PHI_MIN, PHI_MAX);
          st.sph.r = clamp(st.sph.r, MINR, MAXR);
          camera.position.copy(st.target).add(offsetOf(st.sph));
          clampOrbit();
          camera.up.set(0, 0, 1);
          camera.lookAt(st.target);
          st.forceApply = false;
        }
      }
      return moved;
    }

    function dirFromYawPitch() {
      const cp = Math.cos(st.pitch);
      return new THREE.Vector3(Math.sin(st.yaw) * cp, Math.cos(st.yaw) * cp, Math.sin(st.pitch)).normalize();
    }
    function flyStep(dt) {
      if (!st.keys.size) return false;
      const fwd = dirFromYawPitch();
      const right = new THREE.Vector3(fwd.y, -fwd.x, 0).normalize();
      const base = clamp(heightAboveGroundFt() * 1.1, 25, 2600) * st.flySpeed;
      const mult = st.keys.has("shift") ? 4 : 1;
      const v = base * mult * dt;
      const mv = new THREE.Vector3();
      if (st.keys.has("w")) mv.addScaledVector(fwd, v);
      if (st.keys.has("s")) mv.addScaledVector(fwd, -v);
      if (st.keys.has("d")) mv.addScaledVector(right, v);
      if (st.keys.has("a")) mv.addScaledVector(right, -v);
      if (st.keys.has("e")) mv.z += v;
      if (st.keys.has("q")) mv.z -= v;
      if (mv.lengthSq() === 0) return false;
      camera.position.add(mv);
      return true;
    }

    /* ---- input ---- */
    function ndc(e) {
      const r = dom.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }
    /* terrain point under the cursor, or a fallback point at the current orbit distance */
    function pivotAt(e) {
      const p = (Math.abs(e.clientX - lastPick.x) < 3 && Math.abs(e.clientY - lastPick.y) < 3 &&
                 performance.now() - lastPick.t < 4000)
        ? (lastPick.p && lastPick.p.clone())
        : pickScene(e);
      if (p) return p;
      const dir = new THREE.Vector3();
      raycaster.setFromCamera(ndc(e), camera);
      dir.copy(raycaster.ray.direction);
      return camera.position.clone().addScaledVector(dir, st.sph.r);
    }

    /* ---- touch (v11 §4.3) ------------------------------------------
       The rig is pointer-based, so ONE finger already orbits. What it did not
       have is the second finger: a two-finger gesture arrived as two competing
       one-finger drags and the camera lurched. `touches` tracks the live touch
       pointers, and while there are two of them the drag becomes a PINCH —
       spread/pinch dollies, moving the midpoint pans — which is the gesture
       every map on a phone has taught the user to expect. Mouse and pen are
       untouched: they never enter this map. */
    const touches = new Map();          // pointerId -> {x, y}
    let pinch = null;                   // {d, cx, cy}
    const pinchOf = () => {
      const a = [...touches.values()];
      if (a.length < 2) return null;
      return { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y),
               cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2 };
    };
    /* pan the camera plane by a screen delta — the same maths the right-drag
       pan uses, factored out so the pinch can borrow it */
    function panBy(dx, dy) {
      const el = dom.clientHeight || 1;
      const k = 2 * st.sph.r * Math.tan((camera.fov * Math.PI / 180) / 2) / el;
      const right = new THREE.Vector3(), up = new THREE.Vector3();
      camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      st.targetDst.add(right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k)));
    }

    dom.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" && e.button === 2) e.preventDefault();
      /* capture is a convenience, not a requirement: it throws for a pointer id
         the browser has no active pointer for (a synthetic event, a pointer
         already released), and a throw here would leave the rig un-armed with
         no error the user could see */
      try { dom.setPointerCapture(e.pointerId); } catch (err) {}
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) { pinch = pinchOf(); st.drag = "pinch"; return; }
      }
      st.lastX = e.clientX; st.lastY = e.clientY;
      st.drag = e.button === 0 ? (st.mode === "fly" ? "look" : "orbit") : "pan";
    });
    dom.addEventListener("pointermove", e => {
      if (e.pointerType === "touch" && touches.has(e.pointerId))
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (st.drag === "pinch") {
        const now = pinchOf();
        if (!now || !pinch) return;
        if (now.d > 4 && pinch.d > 4) {
          const r = clamp(st.dst.r * (pinch.d / now.d), MINR, MAXR);
          st.dst.r = r;
        }
        panBy(now.cx - pinch.cx, now.cy - pinch.cy);
        pinch = now;
        requestRender();
        return;
      }
      if (!st.drag) return;
      const dx = e.clientX - st.lastX, dy = e.clientY - st.lastY;
      st.lastX = e.clientX; st.lastY = e.clientY;
      if (!dx && !dy) return;
      if (st.drag === "orbit") {
        st.dst.theta -= dx * 0.0055 * st.sens;
        st.dst.phi = clamp(st.dst.phi - dy * 0.0048 * st.sens, PHI_MIN, PHI_MAX);
      } else if (st.drag === "look") {
        st.yaw -= dx * 0.0028 * st.sens;
        st.pitch = clamp(st.pitch - dy * 0.0028 * st.sens, -1.45, 1.45);
        st.lookDirty = true;
      } else {
        /* pan in the camera plane, scaled so a pixel drags the same ground distance
           regardless of how far out we are */
        const el = dom.clientHeight || 1;
        const k = 2 * st.sph.r * Math.tan((camera.fov * Math.PI / 180) / 2) / el;
        const right = new THREE.Vector3(), up = new THREE.Vector3();
        camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
        const mv = right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k));
        st.targetDst.add(mv);
      }
      requestRender();
    });
    const endDrag = e => {
      if (e.pointerType === "touch") {
        touches.delete(e.pointerId);
        if (touches.size === 1) {
          /* one finger lifted out of a pinch: carry on orbiting from where the
             other one is, rather than jumping by the gap between them */
          const a = [...touches.values()][0];
          st.lastX = a.x; st.lastY = a.y;
          st.drag = st.mode === "fly" ? "look" : "orbit";
          pinch = null;
          try { dom.releasePointerCapture(e.pointerId); } catch (err) {}
          return;
        }
        pinch = null;
      }
      st.drag = null;
      try { dom.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    dom.addEventListener("pointerup", endDrag);
    dom.addEventListener("pointercancel", endDrag);

    dom.addEventListener("wheel", e => {
      e.preventDefault();
      const steps = clamp(e.deltaY / 100, -3, 3);
      const k = Math.pow(1.16, steps);          // >1 = zoom out
      if (st.mode === "fly") {
        /* in fly mode the wheel slides the camera along the view ray, at a stride that
           scales with height above ground like the WASD speed does */
        const stride = clamp(heightAboveGroundFt() * 0.45, 25, 2200) * st.flySpeed;
        camera.position.addScaledVector(dirFromYawPitch(), -steps * stride);
        clampFly();
        st.lookDirty = true;
        requestRender();
        return;
      }
      /* dolly toward the cursor: shrink both the camera and the target toward the
         picked point, which keeps whatever is under the pointer under the pointer */
      const P = pivotAt(e);
      const camDst = st.targetDst.clone().add(offsetOf(st.dst));
      const newCam = P.clone().add(camDst.sub(P).multiplyScalar(k));
      const newTgt = P.clone().add(st.targetDst.clone().sub(P).multiplyScalar(k));
      const off = newCam.clone().sub(newTgt);
      const r = clamp(off.length(), MINR, MAXR);
      st.targetDst.copy(newTgt);
      st.dst.r = r;
      st.dst.phi = clamp(Math.acos(clamp(off.z / (off.length() || 1), -1, 1)), PHI_MIN, PHI_MAX);
      st.dst.theta = Math.atan2(off.x, off.y);
      requestRender();
    }, { passive: false });

    /* keyboard for fly mode */
    const KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
    function keyOK(t) { return !(t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable); }
    document.addEventListener("keydown", ev => {
      if (!open || st.mode !== "fly" || !keyOK(ev.target)) return;
      const k = ev.key.toLowerCase();
      if (KEYS.has(k)) { st.keys.add(k); ev.preventDefault(); }
      if (ev.key === "Shift") st.keys.add("shift");
    });
    document.addEventListener("keyup", ev => {
      const k = ev.key.toLowerCase();
      if (KEYS.has(k)) st.keys.delete(k);
      if (ev.key === "Shift") st.keys.delete("shift");
    });
    window.addEventListener("blur", () => st.keys.clear());

    /* ---- public rig API ---- */
    return {
      st,
      update,
      setMode(m) {
        if (m === st.mode) return;
        if (m === "fly") {
          const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
          st.yaw = Math.atan2(fwd.x, fwd.y);
          st.pitch = Math.asin(clamp(fwd.z, -1, 1));
          st.keys.clear();
        } else {
          st.targetDst.copy(camera.position).addScaledVector(dirFromYawPitch(), Math.max(400, st.dst.r));
          setFromCamera();
        }
        st.mode = m;
        st.lookDirty = true;
        requestRender();
      },
      mode() { return st.mode; },
      /* place the camera: target point + spherical offset */
      place(tgt, r, theta, phi, instant) {
        st.targetDst.copy(tgt);
        st.dst.r = clamp(r, MINR, MAXR);
        st.dst.theta = theta; st.dst.phi = clamp(phi, PHI_MIN, PHI_MAX);
        if (instant) { st.target.copy(tgt); st.sph = { ...st.dst }; }
        st.forceApply = true;
        if (st.mode === "fly") this.setMode("orbit");
        requestRender();
      },
      setTarget(v) { st.targetDst.copy(v); requestRender(); },
      target() { return st.targetDst; },
      /* the orbit state in the rig's own terms, for persistence (F11) */
      orbitState() {
        return { tx: st.targetDst.x, ty: st.targetDst.y, tz: st.targetDst.z,
                 r: st.dst.r, theta: st.dst.theta, phi: st.dst.phi };
      },
      /* "north-up" = north points up the screen, i.e. the camera looks NORTH, which
         puts it south of the target (theta measures the camera's bearing FROM the
         target: theta = 0 is due north of it, looking south). */
      northUp() {
        if (st.mode === "fly") { st.yaw = 0; st.lookDirty = true; }
        else st.dst.theta = Math.PI;   // the damping picks the short way round
        requestRender();
      },
      azimuth() {
        const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
        return Math.atan2(fwd.x, fwd.y);
      },
      setFromCamera
    };
  }

  /* raycast the terrain under a mouse/pointer event; returns a scene-space Vector3 */
  function pickScene(e) {
    if (!raycaster || !terrainMeshes.length) return null;
    const dom = renderer.domElement;
    const r = dom.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(p, camera);
    const hits = raycaster.intersectObjects(terrainMeshes.map(t => t.mesh));
    const out = hits.length ? hits[0].point.clone() : null;
    lastPick = { x: e.clientX, y: e.clientY, p: out, t: performance.now() };
    return out;
  }
  /* Raycast only the sheet drapes. Returns true when one was hit and opened. */
  function pickSheet(e) {
    if (!raycaster || !sheetGroup || !sheetGroup.visible || !sheetMeshes.size) return false;
    const dom = renderer.domElement, r = dom.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hits = raycaster.intersectObjects([...sheetMeshes.values()]);
    if (!hits.length) return false;
    const name = hits[0].object.userData.sheet;
    if (!name || !SBMM.sheets) return false;
    SBMM.sheets.open(name, { origin: { x: e.clientX, y: e.clientY } });
    return true;
  }

  /* same pick, expressed in State Plane feet + true elevation */
  function pickWorld(e) {
    const h = pickScene(e);
    if (!h) return null;
    return [h.x + CX, h.y + CY, h.z / exag() + ZMID];
  }

  /* ==================================================================== */
  function updateCompass() {
    const rose = $("v3dRose");
    if (!rose || !nav) return;
    const deg = -nav.azimuth() * 180 / Math.PI;
    rose.setAttribute("transform", `rotate(${deg.toFixed(2)} 50 50)`);
  }

  function frameBox(x0, y0, x1, y1) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const [z] = SBMM.elev(cx, cy);
    const zc = ((isNaN(z) ? ZMID : z) - ZMID) * exag();
    const rad = Math.max(120, Math.hypot(x1 - x0, y1 - y0) / 2);
    const r = rad / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.25;
    nav.place(new THREE.Vector3(cx - CX, cy - CY, zc), r, nav.st.dst.theta, Math.min(nav.st.dst.phi, 1.05));
  }
  function frameSelectionOrSite() {
    const f = SBMM.store.selectedFeature();
    if (f && f.pts && f.pts.length) {
      const xs = f.pts.map(p => p[0]), ys = f.pts.map(p => p[1]);
      const pad = f.type === "spot" ? 200 : 0;
      frameBox(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad);
      toast("framed “" + (f.name || f.type) + "”");
      return;
    }
    const m = SBMM.demAbp.m;
    frameBox(m.x0, m.y0, m.x0 + (m.w - 1) * m.cell, m.y0 + (m.h - 1) * m.cell);
  }
  const PRESETS = {
    top: [0, PHI_MIN + 0.004], n: [0, 1.12], s: [Math.PI, 1.12],
    e: [Math.PI / 2, 1.12], w: [-Math.PI / 2, 1.12], iso: [-0.62, 0.95]
  };
  function preset(name) {
    const p = PRESETS[name]; if (!p) return;
    nav.place(nav.st.targetDst.clone(), nav.st.dst.r, p[0], p[1]);
  }

  function popover(id, others) {
    const el = $(id);
    const on = !el.classList.contains("on");
    others.forEach(o => $(o).classList.remove("on"));
    el.classList.toggle("on", on);
  }

  /* ==================================================================== */
  async function init() {
    if (inited) return;
    $("v3dStatus").textContent = "building terrain mesh…";
    await new Promise(r => setTimeout(r, 30));

    const mS = SBMM.demSite.m;
    CX = mS.x0 + mS.w * mS.cell / 2; CY = mS.y0 + mS.h * mS.cell / 2;
    SBMM._zrSite = SBMM._zrSite || SBMM.demSite.zRange();
    SBMM._zrAbp = SBMM._zrAbp || SBMM.demAbp.zRange();
    ZMID = (SBMM._zrSite[0] + SBMM._zrSite[1]) / 2;

    renderer = new THREE.WebGLRenderer({ canvas: $("v3dCanvas"), antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0A0F12);
    scene.fog = new THREE.Fog(0x0A0F12, 15000, 40000);

    camera = new THREE.PerspectiveCamera(55, 1, 5, 90000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -4000, 3200);

    scene.add(new THREE.HemisphereLight(0xcfe4ee, 0x2a2f33, 0.95));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.15);
    sun.position.set(-4000, -3000, 5000);
    scene.add(sun);

    await rebuildTerrain("ortho");

    raycaster = new THREE.Raycaster();
    nav = makeNav(renderer.domElement);
    nav.setFromCamera();
    /* Hand the scene to the pick registry BEFORE the first rebuildOverlays, so
       the objects that rebuild makes are registered as it makes them (§8). */
    if (SBMM.pick3d) SBMM.pick3d.attach({
      renderer, camera, scene, raycaster,
      dom: renderer.domElement,
      overlayGroup: () => overlayGroup,
      terrainMeshes: () => terrainMeshes.map(t => t.mesh),
      exag, requestRender,
      camDist: () => (nav ? nav.st.sph.r : 1000),
      center: () => ({ CX, CY, ZMID }),
      pickWorld, pickScene,
      isOpen: () => open
    });
    rebuildOverlays();

    const canvas = renderer.domElement;
    /* Click vs drag. The nav rig is a custom orbit/fly controller that consumes
       the same left button a pick uses, so "was that a click or the start of an
       orbit" has to be decided here or the two fight: §8 fixes the threshold at
       ≤4 px of travel and ≤200 ms held. Anything looser and a slow, careful
       orbit registers as a pick; anything tighter and a pick on a trackpad
       misses. Time matters as much as distance — a press-and-hold that ends
       where it started is a parked camera, not a pick. */
    const CLICK_PX = 4, CLICK_MS = 200;
    let downAt = null;
    canvas.addEventListener("mousedown", e => downAt = [e.clientX, e.clientY, performance.now()]);
    const wasClick = e => !downAt
      || (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) <= CLICK_PX
          && performance.now() - downAt[2] <= CLICK_MS);
    canvas.addEventListener("mousemove", e => {
      const p = pickWorld(e);
      $("v3dCoord").textContent = p ? `${fmt0(p[0])} E, ${fmt0(p[1])} N · ${fmt(p[2], 1)} ft` : "";
      /* the status bar reads the same numbers in both views (§2) — it is one
         bar under one stage, so it must not go stale the moment 3D is opened */
      if (p && SBMM.status) SBMM.status.at(p[0], p[1], p[2]);
      /* live rubber preview while sketching in 3D */
      if (p && SBMM.tools.active() && SBMM.draw.isDrawing()) SBMM.draw.previewAt(p[0], p[1]);
    });
    canvas.addEventListener("click", e => {
      if (!wasClick(e)) return;                 // that was an orbit / look drag
      const t = SBMM.tools.active();
      /* No tool armed: a click on a draped sheet opens that sheet's full drawing.
         Only the sheet meshes are tested, and only when the group is visible, so
         this can never steal a click from the terrain or from a drawing tool.
         Failing that, the pick registry answers — the same popup 2D would show,
         or a coordinate card on bare terrain (§8). */
      if (!t) {
        if (pickSheet(e)) return;
        if (SBMM.pick3d && SBMM.pick3d.click(e)) return;
        return;
      }
      const p = pickWorld(e);
      if (p) SBMM.tools.mapClick(p[0], p[1]);   // same pipeline as 2D — draw in either view
    });
    canvas.addEventListener("dblclick", e => {
      if (SBMM.tools.active() && SBMM.draw.isDrawing()) { SBMM.draw.finishSketch(); return; }
      const p = pickScene(e);
      if (p) nav.setTarget(p);
    });
    canvas.addEventListener("contextmenu", e => {
      e.preventDefault();                       // right-drag is pan; never show the OS menu
      if (SBMM.tools.active() && SBMM.draw.isDrawing()) SBMM.draw.removeLastVertex();
    });

    /* live sync: any store change (draw/edit/delete/rename in either view) refreshes 3D */
    SBMM.store.onChange(() => { if (open) rebuildOverlays(); });
    SBMM.store.onSelect(() => { if (open) rebuildOverlays(); });

    /* render on demand: idle views cost nothing */
    function loop() {
      if (!open) { rafId = 0; return; }
      rafId = requestAnimationFrame(loop);
      frameCount++;
      const moved = nav.update();
      if (moved || needsRender) {
        needsRender = false;
        renderCount++;
        renderer.render(scene, camera);
        updateCompass();
        /* the identify card is pinned to a point in the scene, so it has to be
           re-projected whenever the camera moves (§8) */
        if (SBMM.pick3d) SBMM.pick3d.onCamera();
      }
    }
    SBMM._v3dLoop = () => { if (!rafId) loop(); };

    /* ---------------- controls wiring ---------------- */
    $("v3dStyle").onchange = () => setStyle($("v3dStyle").value);
    $("v3dExag").oninput = () => {
      const zx = exag();
      terrainMeshes.forEach(t => t.mesh.scale.z = zx);
      if (canopyMesh) canopyMesh.scale.z = zx;
      if (overlayGroup) overlayGroup.scale.z = zx;
      if (contourGroup) contourGroup.scale.z = zx;
      if (sketchObj) sketchObj.scale.z = zx;
      if (sheetGroup) sheetGroup.scale.z = zx;
      for (const k in drapeMesh) drapeMesh[k].scale.z = zx;
      $("v3dExagVal").textContent = zx.toFixed(1) + "×";
      nav.st.forceApply = true;
      requestRender();
    };
    /* ---- one layer state, one subscription (§1/§4) ------------------
       The 3D toolbar no longer carries visibility checkboxes; what is drawn
       here is whatever the Layers tree says is on. The subscription DIFFS by
       group and layer on purpose: switching an orthophoto must not rebuild the
       design overlays, and switching a design layer must not rebuild the
       terrain. Anything not named below reaches no 3D work at all. */
    const OVERLAY_GROUPS = { framework: 1, design: 1, invest: 1, mywork: 1, cultural: 1 };
    const SPECIAL = {
      "design/sheets3d": () => {
        if (sheetGroup) { sheetGroup.visible = sheetsOn(); requestRender(); }
        else if (sheetsOn()) syncSheets();
      },
      "base/contours_site": () => syncContours(),
      "base/contours_abp": () => syncContours(),
      "base/canopy": () => syncCanopy()
    };
    let overlayQueued = false;
    function queueOverlays() {
      if (overlayQueued) return;
      overlayQueued = true;
      /* several rows can change in one gesture (a group master checkbox is
         exactly that), and each rebuild walks every visible ring */
      requestAnimationFrame(() => { overlayQueued = false; rebuildOverlays(); });
    }
    SBMM.events.on("layers", ev => {
      if (!scene) return;                       // 3D not open: replayed on open
      if (!ev || (!ev.group && !ev.layer)) {    // bulk restore: everything
        queueOverlays(); SPECIAL["design/sheets3d"](); syncContours(); syncCanopy(); return;
      }
      const key = ev.group + "/" + ev.layer;
      if (SPECIAL[key]) { SPECIAL[key](); return; }
      if (ev.layer === null) {                  // a group master switch
        if (OVERLAY_GROUPS[ev.group]) queueOverlays();
        if (ev.group === "base") { syncContours(); syncCanopy(); }
        if (ev.group === "design") SPECIAL["design/sheets3d"]();
        return;
      }
      if (OVERLAY_GROUPS[ev.group]) queueOverlays();
      if (ev.group === "base" && ev.layer === "trees_detected") queueOverlays();
    });

    /* survey contours — built once on first need, then just shown/hidden */
    async function syncContours() {
      const want = SBMM.layerState.isOn("base", "contours_site")
                || SBMM.layerState.isOn("base", "contours_abp");
      if (want && !contourGroup) {
        $("v3dStatus").textContent = "building contours…";
        await new Promise(r => setTimeout(r, 30));
        contourGroup = buildContourGroup();
        contourGroup.scale.z = exag();
        scene.add(contourGroup);
        $("v3dStatus").textContent = "";
      }
      if (contourGroup) contourGroup.visible = want;
      requestRender();
    }

    /* lidar canopy surface (ground + CHM) — built once, then just toggled */
    let canopyBusy = false;
    async function syncCanopy() {
      const want = SBMM.layerState.isOn("base", "canopy");
      if (!want) { if (canopyMesh) { canopyMesh.visible = false; requestRender(); } return; }
      if (canopyBusy) return;
      canopyBusy = true;
      try {
        if (!SBMM.chm && SBMM.chmReady) { $("v3dStatus").textContent = "waiting for the canopy model…"; await SBMM.chmReady; $("v3dStatus").textContent = ""; }
        if (!SBMM.chm) { toast("this build has no canopy height model"); return; }
        if (!canopyMesh) {
        $("v3dStatus").textContent = "building canopy mesh…";
        await new Promise(r => setTimeout(r, 30));
        const gnd = SBMM.demAbp, c = SBMM.chm, cm = c.m, gm = gnd.m;
        /* the CHM shares the mine-area DEM's grid exactly, so ground is a direct index */
        const same = cm.w === gm.w && cm.h === gm.h && cm.x0 === gm.x0 && cm.y0 === gm.y0 && cm.cell === gm.cell;
        const surf = {
          m: cm,
          atGrid: (i, j) => {
            const h = c.atGrid(i, j);
            if (isNaN(h) || h < 2) return NaN;          // NaN-skip clips the mesh to vegetation
            const z = same ? gnd.atGrid(i, j) : SBMM.elev(cm.x0 + i * cm.cell, cm.y0 + j * cm.cell)[0];
            return isNaN(z) ? NaN : z + h;
          }
        };
        const t = buildTerrain(surf, strideFor(surf, 640), false);
        /* Colour the canopy by HEIGHT rather than painting it one flat green. A
           single green tells you where vegetation is; the ramp tells you what kind
           — 8-ft brush and an 80-ft conifer stand are the difference between a
           weed-trimmer and a crew with a chipper, and that is the question anyone
           looking at a clearing limit is actually asking. Vertex colours, so it
           costs one attribute and no extra draw call. */
        {
          const pos = t.geom.getAttribute("position"), nv = pos.count;
          const col = new Float32Array(nv * 3);
          const st = t.stride, cmw = cm.w, cmh = cm.h;
          const nxv = t.nx;
          for (let v = 0; v < nv; v++) {
            const iv = v % nxv, jv = (v - iv) / nxv;
            const gi = Math.min(cmw - 1, iv * st), gj = Math.min(cmh - 1, jv * st);
            const hv = c.atGrid(gi, gj);
            const rgb = lerpRamp(RAMPS.canopy, isNaN(hv) ? 0 : clamp((hv - 6) / (60 - 6), 0, 1));
            col[v * 3] = rgb[0] / 255; col[v * 3 + 1] = rgb[1] / 255; col[v * 3 + 2] = rgb[2] / 255;
          }
          t.geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
        }
        canopyMesh = new THREE.Mesh(t.geom, new THREE.MeshLambertMaterial({
          vertexColors: true, transparent: true, opacity: 0.85, side: THREE.DoubleSide
        }));
        canopyMesh.scale.z = exag();
        scene.add(canopyMesh);
        $("v3dStatus").textContent = "";
      }
      } finally { canopyBusy = false; }
      if (canopyMesh) canopyMesh.visible = true;
      requestRender();
    }

    const detSel = $("v3dDetail");
    if (detSel) detSel.onchange = async () => {
      $("v3dStatus").textContent = "rebuilding terrain…";
      await new Promise(r => setTimeout(r, 30));
      await rebuildTerrain();
      $("v3dStatus").textContent = "";
    };

    const lyBtn = $("v3dLayersBtn");
    if (lyBtn) lyBtn.onclick = () => SBMM.shell.setTab("layers");

    /* replay the whole state the first time the view is built, so opening 3D
       shows what 2D has been showing all along */
    SBMM.viewer3d._syncAll = () => { syncContours(); syncCanopy(); SPECIAL["design/sheets3d"](); };
    /* Snapshot. The mark and (when cultural layers are on) the confidentiality
       stamp are burned into the PNG, not overlaid on screen: an exported image
       that leaves the project without them is exactly what §7 and §10 exist to
       prevent. A WebGL canvas has no 2D context, so the pixels are copied into
       one that does and the export is taken from there. */
    $("v3dSnap").onclick = async () => {
      if (SBMM.cultural && !(await SBMM.cultural.gateExport("snapshot"))) {
        toast("snapshot cancelled");
        return;
      }
      renderer.render(scene, camera);
      const out = SBMM.watermark.burnWebGL(renderer.domElement);
      out.toBlob(b => download("sbmm_3d_view.png", b));
    };
    $("v3dClose").onclick = close;
    $("v3dSplit").onclick = toggleSplit;
    $("v3dFly").onclick = () => toggleFly();
    $("v3dGoto2d").onclick = () => { const c = SBMM.map.getCenter(); flyTo(c.lng, c.lat); };

    /* navigation chrome */
    document.querySelectorAll("#v3dNav [data-view]").forEach(b => b.onclick = () => preset(b.dataset.view));
    $("v3dFrame").onclick = frameSelectionOrSite;
    $("v3dCompass").onclick = () => nav.northUp();
    $("v3dViewSet").onclick = e => { e.stopPropagation(); popover("v3dViewPop", ["v3dHelpPop"]); };
    $("v3dNavHelp").onclick = e => { e.stopPropagation(); popover("v3dHelpPop", ["v3dViewPop"]); };
    const closePops = () => { $("v3dViewPop").classList.remove("on"); $("v3dHelpPop").classList.remove("on"); };
    $("v3dCanvas").addEventListener("pointerdown", closePops);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closePops(); });
    $("v3dFov").oninput = e => {
      camera.fov = parseFloat(e.target.value);
      camera.updateProjectionMatrix();
      $("v3dFovVal").textContent = e.target.value + "°";
      requestRender();
    };
    $("v3dSens").oninput = e => { nav.st.sens = parseFloat(e.target.value); $("v3dSensVal").textContent = (+e.target.value).toFixed(1) + "×"; };
    $("v3dSpeed").oninput = e => { nav.st.flySpeed = parseFloat(e.target.value); $("v3dSpeedVal").textContent = (+e.target.value).toFixed(1) + "×"; };
    $("v3dClampTerrain").onchange = e => { nav.st.clampGround = e.target.checked; requestRender(); };

    window.addEventListener("resize", resize);

    inited = true;
    $("v3dStatus").textContent = "";
    requestRender();
  }

  function toggleFly(force) {
    if (!nav) return;
    const on = force != null ? force : nav.mode() !== "fly";
    nav.setMode(on ? "fly" : "orbit");
    $("v3dFly").classList.toggle("active", on);
    if (on) toast("fly mode — drag to look · W A S D move · Q/E down/up · Shift 4× · F to leave");
  }

  /* ------------------------------------------------------------------ */
  /* the 3D toolbar, at any width (F6)                                    */
  /* ------------------------------------------------------------------ */
  /* The bar was a single non-wrapping row, so at 1600 px in full 3D the
     snapshot button, the coordinate readout and "back to 2D" were simply cut
     off the right-hand edge, and in split — half the width — it lost the
     relief slider and the detail picker as well. Nothing errored; the controls
     were just not there.

     Two stages, in the order that costs the user least:
       1. drop the button LABELS to icons (the tooltips still name them),
       2. move the three `.v3dopt` controls — drape, relief, detail — into the
          View settings popover, which is where settings about the view already
          live, and light the gear so it is visible that they went somewhere.
     Measured against the real right edge of the last control, the same way
     js/shell.js measures the top bar. */
  function reflowBar() {
    const el = $("view3d");
    if (!el || el.style.display === "none") return;
    const bar = el.querySelector(".v3dbar");
    const host = $("v3dOptHost"), last = $("v3dClose"), gear = $("v3dViewSet");
    if (!bar || !host || !last) return;

    /* put everything back, then narrow only as far as needed */
    const parked = [...host.querySelectorAll(".v3dopt")];
    for (const o of parked) bar.insertBefore(o, bar.querySelector(".spacer") || last);
    host.hidden = true;
    bar.classList.remove("compact", "compact2");
    if (gear) gear.classList.remove("hasopt");

    const fits = () => last.getBoundingClientRect().right <= bar.getBoundingClientRect().right - 6;
    if (fits()) return;

    bar.classList.add("compact");
    if (fits()) return;

    /* park in reverse bar order so the last, least-used control goes first */
    const opts = [...bar.querySelectorAll(".v3dopt")].reverse();
    for (const o of opts) {
      const lbl = document.createElement("div");
      lbl.className = "optrow";
      lbl.innerHTML = `<span class="optlbl">${esc(o.dataset.optlabel || "")}</span>`;
      lbl.appendChild(o);
      host.appendChild(lbl);
      host.hidden = false;
      if (gear) gear.classList.add("hasopt");
      if (fits()) return;
    }

    /* Last resort, and the cheapest thing on the bar to lose: the "3D terrain"
       title and the coordinate / status readouts. The status bar under the
       stage already carries E, N, Z and the job state for BOTH views (§2), so
       these are a second copy, and a second copy is what you drop first. */
    bar.classList.add("compact2");
  }

  function resize() {
    if (!open || !renderer) return;
    const el = $("view3d");
    reflowBar();
    const bar = el.querySelector(".v3dbar");
    const bh = bar ? bar.offsetHeight : 40;
    el.style.setProperty("--v3dbarH", bh + "px");   // the bar wraps on narrow docks
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight - bh);
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    requestRender();
  }

  async function show() {
    $("view3d").style.display = "block";
    open = true;
    /* the 2D overlay canvases (object snap, tree dots) are stretched over the whole
       stage, not parented to the map, so a full-screen 3D view does not cover them —
       tree dots were painting over the sky. CSS hides them off this class; split mode
       keeps them, halved, because the 2D map is still there. */
    document.body.classList.add("v3don");
    if (SBMM.trees) SBMM.trees.repaint();
    try {
      await init();
    } catch (e) {
      console.error(e);
      $("v3dStatus").textContent = "3D failed: " + e.message + " (WebGL blocked?)";
      return;
    }
    rebuildOverlays();
    /* an isopach or a rim band painted while the 3D view was SHUT still has to
       appear when it opens; init() only runs once, so replaying it belongs here
       with the rest of the deferred state rather than there */
    refreshDrapes();
    syncSheets();          // replay any sheet drapes enabled while 2D-only
    /* and replay the rest of the layer state: contours, canopy and the sheet
       master may all have been toggled while the 3D view did not exist */
    if (SBMM.viewer3d._syncAll) SBMM.viewer3d._syncAll();
    resize();
    SBMM._v3dLoop();
    announce();
  }
  function close() {
    open = false;
    document.body.classList.remove("v3don");
    if (SBMM.trees) SBMM.trees.repaint();
    if (split) toggleSplit();
    if (nav && nav.mode() === "fly") toggleFly(false);
    $("view3d").style.display = "none";
    $("view3dBtn").classList.remove("active");
    announce();
  }
  /* Which view is on screen is not only this module's business: the Mode HUD
     has to say "drag to orbit" in 3D and "drag to pan" in 2D (F5), and the
     toolbar reflow has to re-measure when the pane changes width (F6). */
  function announce() {
    if (SBMM.events) SBMM.events.emit("view", { open: open, split: split });
  }
  function toggleSplit() {
    split = !split;
    document.body.classList.toggle("v3dsplit", split);
    $("v3dSplit").classList.toggle("active", split);
    if (SBMM.trees) SBMM.trees.repaint();
    SBMM.map.invalidateSize();
    if (open) resize();
    announce();
    if (split) toast("split mode — draw with any tool in either view; results stay live in both");
  }
  /* in-progress sketch shown in 3D (called from the draw engine) */
  function updateSketch(pts, closed, cursor) {
    if (!inited || !open) return;
    if (sketchObj) { scene.remove(sketchObj); sketchObj = null; }
    if (!pts || !pts.length) { requestRender(); return; }
    const P = cursor ? [...pts, cursor] : pts;
    if (P.length < 2) { requestRender(); return; }
    sketchObj = drapedLine(P, 0xFFD34D, closed && P.length > 2, 3.5);
    sketchObj.material.transparent = true; sketchObj.material.opacity = .9;
    sketchObj.scale.z = exag();
    scene.add(sketchObj);
    requestRender();
  }
  async function toggle() {
    if (open) close();
    else {
      $("view3dBtn").classList.add("active");
      const c = SBMM.map.getCenter();
      await show();
      /* where the camera was last time, if it is still a sane place to stand
         (F11); otherwise frame whatever the 2D map is looking at, as before */
      if (!restoreCamera()) flyTo(c.lng, c.lat);
    }
  }
  /* ---- camera persistence (F11) ----
     Stored in survey terms — a target in State Plane feet plus radius, bearing
     and pitch — because scene coordinates move with the exaggeration slider
     and with the scene's centring constants, so a scene-space camera restored
     at a different relief setting points at the sky. */
  function restoreCamera() {
    if (!nav || !SBMM.view) return false;
    const v = SBMM.view.stored3d();
    if (!v) return false;
    try {
      nav.place(new THREE.Vector3(v.x - CX, v.y - CY, drapeZ(v.x, v.y, 0) * exag()),
                v.r, v.theta, v.phi, true);
      return true;
    } catch (e) { return false; }
  }
  function saveCamera() {
    if (!nav || !SBMM.view || !nav.orbitState) return;
    const s = nav.orbitState();
    if (!s) return;
    SBMM.view.save3d({ x: s.tx + CX, y: s.ty + CY, z: s.tz,
                       r: s.r, theta: s.theta, phi: s.phi });
  }
  function flyTo(x, y) {
    if (!nav) return;
    const zx = exag();
    const z = drapeZ(x, y, 0) * zx;
    /* exactly the framing the previous rig produced: camera 900 ft east and 1400 ft
       south of the target, 1000 ft above it (r 1941.65, azimuth 147.3 deg, polar 59.0 deg) */
    nav.place(new THREE.Vector3(x - CX, y - CY, z), 1941.649, 2.570255, 1.029758, true);
  }
  async function openAt(x, y) {
    $("view3dBtn").classList.add("active");
    await show(); flyTo(x, y);
  }
  /* camera position in survey terms: State Plane feet + true elevation (un-exaggerated) */
  function cameraWorld() {
    if (!camera) return null;
    return { x: camera.position.x + CX, y: camera.position.y + CY, z: camera.position.z / exag() + ZMID };
  }

  /* introspection hook — used by the test harness and handy in the console */
  function stats() {
    return {
      detail: $("v3dDetail") ? $("v3dDetail").value : null,
      terrainVerts: terrainMeshes.reduce((n, t) => n + t.nx * t.ny, 0),
      sceneObjects: scene ? scene.children.length : 0,
      contourDrawCalls: contourGroup ? contourGroup.children.length : 0,
      contourVerts: contourGroup
        ? contourGroup.children.reduce((n, o) => n + o.geometry.getAttribute("position").count, 0) : 0,
      contoursVisible: !!(contourGroup && contourGroup.visible),
      canopyVisible: !!(canopyMesh && canopyMesh.visible),
      isopachDraped: !!drapeMesh.isopach,
      waterDraped: !!drapeMesh.water,
      cadDrapeBudgetSkipped: lastCadSkip,
      contourSegments: SBMM._v3dContourDrop || null,
      sheetDrapes: [...sheetMeshes.keys()].sort(),
      sheetDrapeVerts: [...sheetMeshes.values()].reduce(
        (n, m) => n + m.geometry.getAttribute("position").count, 0),
      sheetDrapesVisible: !!(sheetGroup && sheetGroup.visible),
      navMode: nav ? nav.mode() : null,
      /* the orbit rig's target state — what a drag or a pinch actually moves.
         Reading the camera position instead would be reading the eased
         FOLLOWER, which lags a gesture by a few frames. */
      orbit: nav ? { theta: +nav.st.dst.theta.toFixed(4), phi: +nav.st.dst.phi.toFixed(4),
                     r: +nav.st.dst.r.toFixed(1) } : null,
      fov: camera ? camera.fov : null,
      cameraZ: camera ? +camera.position.z.toFixed(1) : null,
      renderOnDemand: true,
      renderCount, frameCount,
      /* GPU resource counters — used by the leak check in test/perf.mjs */
      gpu: renderer ? {
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs ? renderer.info.programs.length : null
      } : null
    };
  }
  return {
    toggle, openAt, flyTo, isOpen: () => open, updateSketch, stats, resize, cameraWorld,
    toggleFly, isFly: () => !!(nav && nav.mode() === "fly"),
    navMode: () => (nav ? nav.mode() : null),
    preset, frame: frameSelectionOrSite, frameBox, northUp: () => nav && nav.northUp(),
    refreshOverlays: () => { if (open) rebuildOverlays(); },
    refreshIsopach: () => { if (open) refreshDrapes(); },
    refreshDrapes: () => { if (open) refreshDrapes(); },
    sheetDrape, sheetDrapeNames: () => [...wantSheets].sort(),
    requestRender, reflowBar
  };
})();
