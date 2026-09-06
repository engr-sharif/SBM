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
  /* v13 §3.1 — the animated flow. One THREE.Points per visible `flow` feature;
     every stretch's densified geometry and cumulative arc length is precomputed
     once per overlay rebuild, and the render loop only advances a scalar and
     writes into a pre-allocated position array (no per-frame allocation, no
     per-frame drapeZ). The loop asks for frames ONLY while a visible flow exists
     and the toggle is on, so test/perf.mjs's idle-render count stays 0. */
  let waterAnim = [], animOn = true, animT = 0, animLast = 0;
  const WATER_SPEED_FPS = 40;      // ground speed of a particle, ft/s
  const WATER_SPACING_FT = 20;     // spacing along the arc
  const WATER_FPS_MS = 32;         // ~30 fps
  /* v13 §3.2 — the overtopping stage surface, owned by js/water.js through
     setWaterStage() and cleared when the analysis closes. */
  let stageGroup = null, stageKey = null, stageInfo = null;
  /* last terrain raycast, keyed to the cursor position — raycasting a 1.5M-vertex mesh
     is the expensive part of hovering, so the wheel handler reuses the hover's result */
  let lastPick = { x: -1e9, y: -1e9, p: null, t: 0 };

  const requestRender = () => { needsRender = true; };

  /* ================================================================== */
  /* v15 §3.2 — the environment                                          */
  /* ================================================================== */
  /* A gradient sky, fog matched to its horizon so the edge of the survey fades
     into it instead of ending in a hard line, a lake-coloured plane under the
     terrain's lowest point so the model sits ON something, and a key light the
     user can swing — the 2D hillshade is lit from somewhere, and the 3D view
     should be lit from the same somewhere. */
  const SKY_TOP = 0x0B1A26, SKY_HORIZON = 0x22343E, SKY_BOTTOM = 0x080D10;
  const LAKE = 0x14303C;
  let skyMesh = null, envGroup = null, sunLight = null, hemiLight = null;
  let sunAz = 315, sunEl = 35;

  function buildSky() {
    const R = 30000;
    const geo = new THREE.SphereGeometry(R, 24, 16);
    const pos = geo.getAttribute("position");
    const col = new Float32Array(pos.count * 3);
    const top = new THREE.Color(SKY_TOP), hor = new THREE.Color(SKY_HORIZON),
          bot = new THREE.Color(SKY_BOTTOM), tmp = new THREE.Color();
    /* z/R is sin(elevation) in a z-up world whichever way the sphere's poles
       happen to run, so the gradient is vertical by construction */
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getZ(i) / R;
      if (t >= 0) tmp.copy(hor).lerp(top, Math.pow(t, 0.65));
      else tmp.copy(hor).lerp(bot, Math.pow(-t, 0.6));
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    /* Drawn AFTER the terrain and BEFORE anything transparent: it is opaque, so
       three puts it in the opaque queue where renderOrder decides, and with
       depth testing on (and depth writing off) its pixels fail wherever the
       terrain already wrote depth. A sky drawn first is a full-screen fill that
       the terrain then paints over — on software GL that is a frame's budget
       spent on pixels nobody sees. */
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, depthWrite: false, depthTest: true,
      fog: false, toneMapped: false }));
    m.renderOrder = 1000;
    m.frustumCulled = false;
    return m;
  }
  /* the dome rides with the camera, so it can be small enough to sit inside the
     far plane at any orbit radius */
  function updateSky() { if (skyMesh && camera) skyMesh.position.copy(camera.position); }

  function buildEnv() {
    const g = new THREE.Group();
    const zr = SBMM._zrSite || SBMM.demSite.zRange();
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(160000, 160000),
      new THREE.MeshBasicMaterial({ color: LAKE, fog: true, toneMapped: false }));
    pl.position.z = zr[0] - 25 - ZMID;      // pre-exaggeration; the group scales z
    /* after the terrain for the same reason as the sky: from any view above the
       ground the terrain is in front of it, so most of it is depth-rejected */
    pl.renderOrder = 900;
    g.add(pl);
    return g;
  }

  function applySun() {
    if (!sunLight) return;
    const az = sunAz * Math.PI / 180, el = sunEl * Math.PI / 180, d = 14000;
    /* azimuth is a compass bearing: the direction the light comes FROM */
    sunLight.position.set(Math.sin(az) * Math.cos(el) * d,
                          Math.cos(az) * Math.cos(el) * d,
                          Math.max(0.08, Math.sin(el)) * d);
    const lab = $("v3dSunVal");
    if (lab) lab.textContent = Math.round(sunAz) + "° / " + Math.round(sunEl) + "°";
    /* v20 §4: the shader rasters carry the sun as a uniform, so moving it
       relights the whole terrain without recomputing a single raster — which
       is what v15 asked for and what a CPU raster could never do */
    if (SBMM.terrain3d) SBMM.terrain3d.setSun(sunAz, sunEl);
    requestRender();
  }
  function setSun(az, el, remember) {
    if (az != null) sunAz = clamp(az, 0, 360);
    if (el != null) sunEl = clamp(el, 5, 85);
    applySun();
    if (remember !== false && SBMM.view && SBMM.view.pref) {
      SBMM.view.pref("sunAz", sunAz); SBMM.view.pref("sunEl", sunEl);
    }
  }
  const exag = () => parseFloat($("v3dExag").value);

  function strideFor(dem, maxDim) { return Math.max(1, Math.ceil(Math.max(dem.m.w, dem.m.h) / maxDim)); }

  /* v20 §3 — the quadtree terrain. `lodOn` says which of the two terrain
     builders owns the meshes: the tile quadtree in js/terrain3d.js, or the
     whole-DEM meshes below (still the fallback, and still what a build with no
     tile index gets). `terrainMeshes` holds the same {mesh, nx, ny, dem} shape
     either way, so the raycast, the relief slider and stats() do not branch. */
  let lodOn = false, lodDirty = false, lodMoveAt = 0, lodLast = 0;
  const LOD_SETTLE_MS = 140;
  /* the detail picker is a screen-space error budget now: 4 px / 2 px / 1 px.
     The two old values keep their names and their meaning (std is coarser than
     high) because they are a remembered preference and three harnesses read
     them. */
  function qualityPx() {
    const d = $("v3dDetail"), v = d ? d.value : "high";
    return v === "std" ? 4 : v === "ultra" ? 1 : 2;
  }
  function lodAvailable() {
    if (!SBMM.terrain3d || !SBMM.terrain3d.available()) return false;
    if (SBMM.view && SBMM.view.pref && SBMM.view.pref("terrainTiles") === false) return false;
    return true;
  }
  function lodContext() {
    return {
      scene, camera, renderer,
      center: () => ({ CX, CY, ZMID }),
      exag, requestRender, maxAniso,
      quality: qualityPx,
      zRange: () => SBMM._zrSite || SBMM.demSite.zRange(),
      onSwap: () => {
        terrainMeshes = SBMM.terrain3d.records();
        SBMM._v3dVerts = terrainMeshes.reduce((n, t) => n + t.nx * t.ny, 0);
      }
    };
  }

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
    tex.anisotropy = maxAniso();
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
    tex.flipY = true; tex.anisotropy = maxAniso();
    return { tex, bounds: [x0, y0, x1, y1] };
  }

  async function setStyle(kind) {
    if (lodOn) {
      await SBMM.terrain3d.setStyle(kind);
      terrainMeshes = SBMM.terrain3d.records();
      SBMM._v3dVerts = terrainMeshes.reduce((n, t) => n + t.nx * t.ny, 0);
      requestRender();
      return;
    }
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

  /* ================================================================== */
  /* v13 §3.1 — animated flow particles                                  */
  /* ================================================================== */
  /* A TRACK is one stretch of a run: an overland stretch draped on the terrain
     and resampled at 10 ft (the same density drapedLine uses), or a conduit leg,
     which is a straight line between its two ends at their own elevations and is
     NOT draped — the water is under the ground there. Each track carries its own
     cumulative arc length so the render loop can place a particle by a single
     binary search. */
  function makeTrack(pts, pipe, zA, zB) {
    const xs = [], ys = [], zs = [];
    if (pipe) {
      xs.push(pts[0][0] - CX, pts[1][0] - CX);
      ys.push(pts[0][1] - CY, pts[1][1] - CY);
      zs.push((zA == null ? drapeZ(pts[0][0], pts[0][1], 0) : zA - ZMID) + 1,
              (zB == null ? drapeZ(pts[1][0], pts[1][1], 0) : zB - ZMID) + 1);
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], d = dist2d(a, b), n = Math.max(1, Math.ceil(d / 10));
        for (let k = i === 1 ? 0 : 1; k <= n; k++) {
          const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
          xs.push(x - CX); ys.push(y - CY); zs.push(drapeZ(x, y, 4));
        }
      }
    }
    if (xs.length < 2) return null;
    const cum = new Float32Array(xs.length);
    for (let i = 1; i < xs.length; i++)
      cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const len = cum[cum.length - 1];
    if (!(len > 1)) return null;
    return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), zs: Float32Array.from(zs),
             cum, len, pipe: !!pipe };
  }

  /* the stretches of a run, split at each conduit leg exactly the way
     js/water.js buildFlow splits them for the 2D map */
  function flowTracks(f) {
    const p = f.props || {};
    const legs = (p.legs || []).filter(lg => lg.at != null && lg.at >= 0);
    const cuts = [...new Set(legs.map(lg => lg.at))].sort((a, b) => a - b);
    const out = [];
    let st = 0;
    for (const cut of cuts) {
      if (cut >= st && cut + 1 - st > 1) {
        const t = makeTrack(f.pts.slice(st, cut + 1), false);
        if (t) out.push(t);
      }
      st = cut + 1;
    }
    if (f.pts.length - st > 1) { const t = makeTrack(f.pts.slice(st), false); if (t) out.push(t); }
    for (const lg of legs) {
      if (!lg.from || !lg.to) continue;
      const t = makeTrack([lg.from, lg.to], true, lg.from_z, lg.to_z);
      if (t) out.push(t);
    }
    return out;
  }

  function addFlowParticles(f, sel) {
    const tracks = flowTracks(f);
    if (!tracks.length) return null;
    let N = 0;
    const counts = tracks.map(t => {
      const n = clamp(Math.round(t.len / WATER_SPACING_FT), 1, 400);
      N += n; return n;
    });
    if (!N) return null;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const pIdx = new Int32Array(N), pBase = new Float32Array(N);
    const water = new THREE.Color(sel ? 0xFFD34D : 0x55C1FF), storm = new THREE.Color(0x7FA7C9);
    let k = 0;
    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti], n = counts[ti], gap = t.len / n;
      const c = t.pipe ? storm : water;
      for (let i = 0; i < n; i++, k++) {
        pIdx[k] = ti; pBase[k] = i * gap;
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
        pos[k * 3] = t.xs[0]; pos[k * 3 + 1] = t.ys[0]; pos[k * 3 + 2] = t.zs[0];
      }
    }
    const g = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(pos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", attr);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const obj = new THREE.Points(g, new THREE.PointsMaterial({
      size: sel ? 9 : 6, vertexColors: true, sizeAttenuation: true,
      transparent: true, opacity: 0.95, depthWrite: false }));
    obj.frustumCulled = false;
    obj.visible = animOn;
    /* §3.3: NOT pickable — no userData.pick, so pick3d.syncScene() ignores it
       and the flow's own draped line stays the pick target. */
    overlayGroup.add(obj);
    waterAnim.push({ fid: f.id, obj, attr, pos, tracks, pIdx, pBase, n: N });
    return obj;
  }

  function stepWaterAnim(dt) {
    animT += dt * WATER_SPEED_FPS;
    for (let a = 0; a < waterAnim.length; a++) {
      const A = waterAnim[a], pos = A.pos;
      for (let k = 0; k < A.n; k++) {
        const t = A.tracks[A.pIdx[k]];
        let s = (A.pBase[k] + animT) % t.len;
        if (s < 0) s += t.len;
        let lo = 0, hi = t.cum.length - 1;
        while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (t.cum[m] <= s) lo = m; else hi = m; }
        const seg = t.cum[hi] - t.cum[lo];
        const u = seg > 1e-9 ? (s - t.cum[lo]) / seg : 0;
        pos[k * 3] = t.xs[lo] + (t.xs[hi] - t.xs[lo]) * u;
        pos[k * 3 + 1] = t.ys[lo] + (t.ys[hi] - t.ys[lo]) * u;
        pos[k * 3 + 2] = t.zs[lo] + (t.zs[hi] - t.zs[lo]) * u;
      }
      A.attr.needsUpdate = true;
    }
  }

  function setAnimWater(on) {
    animOn = !!on;
    for (const A of waterAnim) A.obj.visible = animOn;
    const el = $("v3dAnimWater");
    if (el && el.checked !== animOn) el.checked = animOn;
    if (SBMM.view && SBMM.view.pref) SBMM.view.pref("animWater", animOn);
    animLast = 0;
    requestRender();
  }

  /* ================================================================== */
  /* v13 §3.2 — the overtopping stage surface                            */
  /* ================================================================== */
  /* A filled polygon at the slider's level, holes honoured. maskRings hands the
     rings back largest-first with no hole flag, so nesting is worked out here:
     a ring contained by an odd number of others is a hole of the smallest ring
     that contains it. */
  function ringHas(r, x, y) {
    let inn = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inn = !inn;
    }
    return inn;
  }
  function absArea(r) {
    let s = 0;
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s) / 2;
  }
  function disposeStage() {
    if (!stageGroup) return;
    stageGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map && o.isMesh) o.material.map.dispose();
      if (o.material && o.isMesh) o.material.dispose();
    });
    if (scene) scene.remove(stageGroup);
    stageGroup = null; stageInfo = null;
    /* the stage labels are the label layer's, not this group's, and they are
       replaced by setWaterStage before this runs */
  }
  function setWaterStage(spec) {
    if (!scene) { stageKey = null; return; }
    /* v15 §2.3: the labels are their own layer now and they change on every
       slider step even when the flooded outline does not, so they are handed
       over BEFORE the geometry key decides whether the mesh needs rebuilding. */
    setLabels3d("stage", spec ? (spec.labels || []).map(l => ({
      key: "stage:" + (l.key || l.text), text: l.text, color: l.color,
      x: l.x, y: l.y, z: l.z, priority: l.priority == null ? 85 : l.priority,
      liftPx: l.liftPx,
      /* §3.2: the rim-low and first-discharge chips answer a click the way
         everything else in 3D does */
      pick: l.html ? { kind: "label", title: l.title || l.text, html: l.html } : undefined
    })) : []);
    if (spec && stageInfo) stageInfo.labels = (spec.labels || []).length;
    const key = spec ? spec.level.toFixed(3) + ":" + spec.rings.length + ":"
      + spec.rings.reduce((n, r) => n + r.length, 0) : null;
    if (key === stageKey) return;
    stageKey = key;
    disposeStage();
    if (!spec) { requestRender(); return; }
    const rings = (spec.rings || []).filter(r => r && r.length > 2);
    if (!rings.length) { stageKey = null; requestRender(); return; }
    const areas = rings.map(absArea);
    const depth = rings.map((r, i) => {
      let d = 0;
      for (let j = 0; j < rings.length; j++)
        if (j !== i && areas[j] > areas[i] && ringHas(rings[j], r[0][0], r[0][1])) d++;
      return d;
    });
    const shapes = [];
    for (let i = 0; i < rings.length; i++) {
      if (depth[i] % 2) continue;                       // a hole, handled below
      const sh = new THREE.Shape(rings[i].map(q => new THREE.Vector2(q[0] - CX, q[1] - CY)));
      for (let j = 0; j < rings.length; j++) {
        if (depth[j] !== depth[i] + 1) continue;
        /* the hole's immediate parent is the smallest containing ring */
        let par = -1;
        for (let m = 0; m < rings.length; m++)
          if (depth[m] === depth[i] && areas[m] > areas[j] && ringHas(rings[m], rings[j][0][0], rings[j][0][1])
              && (par < 0 || areas[m] < areas[par])) par = m;
        if (par !== i) continue;
        sh.holes.push(new THREE.Path(rings[j].map(q => new THREE.Vector2(q[0] - CX, q[1] - CY))));
      }
      shapes.push(sh);
    }
    if (!shapes.length) { stageKey = null; requestRender(); return; }
    const zc = spec.level - ZMID;
    const geo = new THREE.ShapeGeometry(shapes);
    geo.translate(0, 0, zc);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x55C1FF, transparent: true, opacity: 0.34, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false }));
    mesh.renderOrder = 5;
    const grp = new THREE.Group();
    grp.add(mesh);
    grp.scale.z = exag();
    scene.add(grp);
    stageGroup = grp;
    /* read the z back out of the geometry rather than repeating the arithmetic:
       the harness's "at level - ZMID" check then measures the mesh, not a
       number this function copied from its own input */
    const pa = geo.getAttribute("position");
    stageInfo = { level: spec.level, z: +pa.array[2].toFixed(4), rings: rings.length,
                  shapes: shapes.length, labels: (spec.labels || []).length,
                  verts: pa.count };
    requestRender();
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
      /* v15 §3.1: one sub-group per contour ROW, so the 3D view can show the
         10-ft site set without the 2-ft ABP set (and the parity table can tell
         which of the two is on screen). Before this both were drawn whenever
         either row was on. */
      const sub = new THREE.Group();
      sub.name = c.key;
      tag(sub, "base", c.key);
      for (const k of ["heavy", "light"]) {
        if (!seg[k].length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(seg[k], 3));
        sub.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
          color: c.color, transparent: true, opacity: k === "heavy" ? 0.85 : 0.45
        })));
      }
      if (sub.children.length) g.add(sub);
    }
    SBMM._v3dContourDrop = { kept, dropped };
    return g;
  }

  /* v15 §2.3: the world-sized text sprite is gone. Every 3D label now goes
     through the label layer below — screen-sized, chipped, deduped by key and
     collision-managed — because a world-sized sprite grows and shrinks with the
     camera and a fixed one cannot follow the slider. */

  /* ================================================================== */
  /* v15 §2.3 — the 3D label layer                                       */
  /* ================================================================== */
  /* The old stage sprites were sized in WORLD units and fixed in text, so they
     grew and shrank with the camera and went on saying "rim low 2 · 1,344.34 ft"
     however high the slider had pushed the water. This is a layer instead:

       * every label is a camera-facing chip SIZED IN SCREEN PIXELS (constant on
         screen at any range), with a thin leader down to the point it is about
         and a translucent dark chip behind the text;
       * the same greedy collision pass the 2D engine runs — by priority, in
         screen space — so a label that would land on another is hidden rather
         than smeared over it;
       * two sources (`overlay`, from rebuildOverlays, and `stage`, from
         js/water.js's stageSpec) merged and DEDUPED BY KEY, so a pond crossed by
         three routes has one label in 3D exactly as it has one in 2D;
       * a diff by text: a slider step rebuilds only the sprites whose words
         actually changed, and everything else keeps its texture.

     The per-frame path allocates nothing: the vectors, the ordering array and
     the kept-box array are module-level, each leader owns a 6-float position
     array written in place, and the chip textures are cached. */
  const LBL_PX = 15;              // chip height on screen, in px
  const LBL_LIFT_PX = 30;         // how far above its anchor the chip floats, px
  const LBL_MAX = 60;             // §2.3 — the collision pass is cheap at this size
  const LBL_PAD = 3;              // px of clearance between two kept chips
  let labelGroup = null;
  const labels3d = new Map();                 // key -> record
  const labelSrc = { overlay: [], stage: [] };
  const LV_A = new THREE.Vector3(), LV_T = new THREE.Vector3(), LV_P = new THREE.Vector3();
  const LV_R = new THREE.Vector3(), LV_U = new THREE.Vector3(), LV_F = new THREE.Vector3();
  const LBL_ORDER = [];
  let lblVisible = 0;

  /* the chips are cached by their words, and the cache is BOUNDED: a slider
     dragged across a 44-row stage table asks for a few hundred distinct
     strings, and an unbounded cache of canvas textures is a GPU leak */
  const chipCache = new Map();
  const CHIP_MAX = 140;
  function chipMaterial(text, colorCss) {
    const key = text + "|" + colorCss;
    let mat = chipCache.get(key);
    if (mat) { chipCache.delete(key); chipCache.set(key, mat); return mat; }   // LRU touch
    const fs = 34, padX = 15, padY = 10, rad = 11;
    const m = document.createElement("canvas").getContext("2d");
    m.font = `600 ${fs}px ui-monospace, Consolas, monospace`;
    const w = Math.max(12, Math.ceil(m.measureText(text).width) + padX * 2);
    const h = fs + padY * 2;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.beginPath();
    g.moveTo(rad, 1); g.lineTo(w - rad, 1); g.quadraticCurveTo(w - 1, 1, w - 1, rad);
    g.lineTo(w - 1, h - rad); g.quadraticCurveTo(w - 1, h - 1, w - rad, h - 1);
    g.lineTo(rad, h - 1); g.quadraticCurveTo(1, h - 1, 1, h - rad);
    g.lineTo(1, rad); g.quadraticCurveTo(1, 1, rad, 1); g.closePath();
    g.fillStyle = "rgba(10,15,19,.80)"; g.fill();
    g.strokeStyle = colorCss; g.lineWidth = 2.4; g.stroke();
    g.font = `600 ${fs}px ui-monospace, Consolas, monospace`;
    g.fillStyle = colorCss; g.textBaseline = "middle";
    g.fillText(text, padX, h / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    /* fog off: a label that fades out at distance is a label that stops doing
       its job, and the chips are screen-sized precisely so range does not
       matter to them */
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false,
                                     depthWrite: false, fog: false });
    mat.userData = { aspect: w / h };
    chipCache.set(key, mat);
    while (chipCache.size > CHIP_MAX) {
      const oldest = chipCache.keys().next().value;
      const om = chipCache.get(oldest);
      chipCache.delete(oldest);
      /* refcounted, not a boolean: two labels can carry the same words, and
         disposing a texture another sprite is still drawing leaves a blank chip */
      if (om && !(om.userData.uses > 0)) { if (om.map) om.map.dispose(); om.dispose(); }
    }
    return mat;
  }

  function disposeLabel(rec) {
    if (!rec) return;
    if (labelGroup) { labelGroup.remove(rec.sprite); labelGroup.remove(rec.leader); }
    rec.leader.geometry.dispose();
    rec.leader.material.dispose();
    if (rec.sprite.material)
      rec.sprite.material.userData.uses = Math.max(0, (rec.sprite.material.userData.uses || 1) - 1);
  }

  /* `owner` is "overlay" or "stage"; each replaces its own list wholesale */
  function setLabels3d(owner, list) {
    labelSrc[owner] = Array.isArray(list) ? list : [];
    syncLabels3d();
  }

  function syncLabels3d() {
    if (!scene) return;
    if (!labelGroup) {
      labelGroup = new THREE.Group();
      labelGroup.renderOrder = 20;
      scene.add(labelGroup);
    }
    const want = new Map();
    for (const src of ["overlay", "stage"]) {
      for (const l of labelSrc[src]) {
        if (!l || l.x == null || l.y == null || l.z == null || !l.text) continue;
        const k = l.key || (l.text + "|" + Math.round(l.x / 10) + "|" + Math.round(l.y / 10));
        const p = want.get(k);
        if (!p || (l.priority || 50) > (p.priority || 50)) want.set(k, l);
      }
    }
    let list = [...want];
    if (list.length > LBL_MAX) {
      list.sort((a, b) => (b[1].priority || 50) - (a[1].priority || 50));
      list.length = LBL_MAX;
    }
    const keep = new Set(list.map(e => e[0]));
    for (const [k, rec] of [...labels3d])
      if (!keep.has(k)) { disposeLabel(rec); labels3d.delete(k); }
    for (const [k, spec] of list) {
      const col = spec.color || "#DFF4FF";
      let rec = labels3d.get(k);
      if (rec && rec.text === spec.text && rec.color === col) {
        /* the diff: same words, same sprite — only the anchor and the tag move */
        rec.x = spec.x; rec.y = spec.y; rec.z = spec.z;
        rec.lift = spec.liftPx == null ? LBL_LIFT_PX : spec.liftPx;
        rec.priority = spec.priority == null ? 50 : spec.priority;
        rec.sprite.userData.pick = spec.pick || undefined;
        rec.sprite.userData.layer = spec.layer || undefined;
        continue;
      }
      if (rec) { disposeLabel(rec); labels3d.delete(k); }
      const mat = chipMaterial(spec.text, col);
      mat.userData.uses = (mat.userData.uses || 0) + 1;
      const sp = new THREE.Sprite(mat);
      sp.renderOrder = 22;
      sp.frustumCulled = false;
      if (spec.pick) sp.userData.pick = spec.pick;
      /* §3.1: a single-point text annotation's ONLY object in 3D is its chip,
         so the chip has to carry the layer tag or the parity table finds the
         row empty and is right to say so */
      if (spec.layer) sp.userData.layer = spec.layer;
      const lpos = new Float32Array(6);
      const lg = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(lpos, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      lg.setAttribute("position", attr);
      const ld = new THREE.Line(lg, new THREE.LineBasicMaterial({
        color: new THREE.Color(col), transparent: true, opacity: 0.5,
        depthTest: false, fog: false }));
      ld.renderOrder = 21;
      ld.frustumCulled = false;
      labelGroup.add(sp); labelGroup.add(ld);
      labels3d.set(k, { key: k, text: spec.text, color: col, x: spec.x, y: spec.y, z: spec.z,
                        lift: spec.liftPx == null ? LBL_LIFT_PX : spec.liftPx,
                        priority: spec.priority == null ? 50 : spec.priority,
                        sprite: sp, leader: ld, lpos, attr, aspect: mat.userData.aspect, vis: true });
    }
    requestRender();
  }

  /* Called from the render loop, immediately before the draw. No allocation:
     every vector is module-level and every leader writes into its own array. */
  function updateLabels3d() {
    if (!labelGroup || !labels3d.size || !camera || !renderer) { lblVisible = 0; return; }
    const dom = renderer.domElement;
    const W = dom.clientWidth || 1, H = dom.clientHeight || 1;
    const zx = exag();
    const tanH = Math.tan(camera.fov * Math.PI / 360);
    /* This runs BEFORE renderer.render, which is where three would otherwise
       refresh these two — without them the very first pass projects through an
       identity matrix and culls every label. Both are in-place. */
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.matrixWorld.extractBasis(LV_R, LV_U, LV_F);
    LBL_ORDER.length = 0;
    for (const rec of labels3d.values()) {
      LV_A.set(rec.x - CX, rec.y - CY, (rec.z - ZMID) * zx);
      LV_T.copy(LV_A).sub(camera.position);
      const dist = LV_T.length();
      const wpp = 2 * dist * tanH / H;                 // world units per screen px
      const hW = LBL_PX * wpp;
      rec.sprite.scale.set(hW * rec.aspect, hW, 1);
      rec.sprite.position.copy(LV_A).addScaledVector(LV_U, rec.lift * wpp);
      const lp = rec.lpos;
      lp[0] = LV_A.x; lp[1] = LV_A.y; lp[2] = LV_A.z;
      lp[3] = rec.sprite.position.x; lp[4] = rec.sprite.position.y; lp[5] = rec.sprite.position.z;
      rec.attr.needsUpdate = true;
      LV_P.copy(rec.sprite.position).project(camera);
      if (LV_P.z > 1 || LV_P.z < -1) { rec.sprite.visible = false; rec.leader.visible = false; continue; }
      rec.sx = (LV_P.x * 0.5 + 0.5) * W;
      rec.sy = (-LV_P.y * 0.5 + 0.5) * H;
      rec.hw = LBL_PX * rec.aspect / 2;
      rec.hh = LBL_PX / 2;
      if (rec.sx + rec.hw < -40 || rec.sx - rec.hw > W + 40
          || rec.sy + rec.hh < -40 || rec.sy - rec.hh > H + 40) {
        rec.sprite.visible = false; rec.leader.visible = false; continue;
      }
      rec.dist = dist;
      LBL_ORDER.push(rec);
    }
    LBL_ORDER.sort((a, b) => b.priority - a.priority || a.dist - b.dist);
    let n = 0;
    for (let i = 0; i < LBL_ORDER.length; i++) {
      const r = LBL_ORDER[i];
      let clash = false;
      for (let j = 0; j < n; j++) {
        const k = LBL_ORDER[j];
        if (Math.abs(r.sx - k.sx) < r.hw + k.hw + LBL_PAD
            && Math.abs(r.sy - k.sy) < r.hh + k.hh + LBL_PAD) { clash = true; break; }
      }
      r.sprite.visible = !clash;
      r.leader.visible = !clash;
      if (!clash) { /* compact the kept ones to the front so the inner loop is short */
        const t = LBL_ORDER[n]; LBL_ORDER[n] = r; LBL_ORDER[i] = t; n++;
      }
    }
    lblVisible = n;
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
    tag(mesh, "design", "sheets3d");
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
    ["water", () => SBMM.water && SBMM.water.drapeSpec && SBMM.water.drapeSpec()],
    /* v14 Phase 2: the land-cover class raster. It IS a raster over the ground,
       so in 3D it is a drape rather than an overlay — and it carries a `layer`
       tag, because a drape is added to the scene rather than to overlayGroup
       and an untagged one reads as "that row draws nothing in 3D" (§3.1). */
    ["cover", () => SBMM.runoff && SBMM.runoff.drapeSpec && SBMM.runoff.drapeSpec()],
    /* v19 §2: the flow-accumulation raster. Same reasoning as the cover class
       raster — it IS a raster over the ground — and it carries the same `layer`
       tag so the 3D-parity table can see the row draws something. */
    ["accum", () => SBMM.accum && SBMM.accum.drapeSpec && SBMM.accum.drapeSpec()]
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
      if (spec.layer) mesh.userData.layer = spec.layer;      // §3.1 parity
      scene.add(mesh);
      drapeMesh[name] = mesh;
    } catch (e) { console.error(name + " drape", e); }
    requestRender();
  }

  /* ================================================================== */
  /* v15 §3.1 — the parity tag                                           */
  /* ================================================================== */
  /* "Everything that works in 2D works in 3D" is only checkable if a 3D object
     can say WHICH layer row it belongs to. Every object built below carries
     `userData.layer = {g, l}` — the same (group, id) pair SBMM.layerState uses —
     and `layersDrawn()` reports the set, which is what the e2e's parity table
     compares against the rows that are on. */
  function tag(o, g, l) { if (o) o.userData.layer = { g, l }; return o; }
  /* the same thing when the caller already holds the row's "group/id" key */
  function tagKey(o, key) {
    if (!o || !key) return o;
    const i = String(key).indexOf("/");
    if (i > 0) o.userData.layer = { g: key.slice(0, i), l: key.slice(i + 1) };
    return o;
  }
  function tagAll(list, g, l) { for (const o of list) tag(o, g, l); return list; }

  /* §3.2 — a dark drop shadow under every overlay polyline, so a bright line
     still reads over a bright orthophoto. WebGL cannot widen a line, so an
     "outline" has to be geometry: the same polyline again, a foot and a bit
     lower and nearly black. All of them are merged into ONE LineSegments, so
     the whole effect costs one draw call rather than doubling the overlay's.
     The CAD bulk is deliberately excluded — 3,000 rings twice over is a frame
     budget, not a nicety. */
  const SHADOW_DZ = 1.3;
  function addShadow(sink, line) {
    if (!line || !line.geometry) return line;
    const pa = line.geometry.getAttribute("position");
    if (!pa || pa.count < 2) return line;
    const a = pa.array;
    for (let i = 0; i + 1 < pa.count; i++) {
      const k = i * 3;
      sink.push(a[k], a[k + 1], a[k + 2] - SHADOW_DZ,
                a[k + 3], a[k + 4], a[k + 5] - SHADOW_DZ);
    }
    return line;
  }

  /* §3.1 — draped reference linework, MERGED per layer. One draw call and one
     registry entry for a whole layer, with a segment→feature map so a click
     still names the right thing. Reference linework is resampled at 25 ft
     rather than drapedLine's 10: it is context, not a measured quantity, and
     halving its vertices is the difference between "the boundaries are there"
     and "the boundaries cost more than the design". */
  function drapedBatch(items, colorHex, off) {
    const verts = [], owner = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const ring = it.ring;
      if (!ring || ring.length < 2) continue;
      const P = it.closed ? ring.concat([ring[0]]) : ring;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], d = dist2d(a, b);
        const n = Math.max(1, Math.min(60, Math.ceil(d / 25)));
        for (let q = 0; q < n; q++) {
          const t0 = q / n, t1 = (q + 1) / n;
          const x0 = a[0] + (b[0] - a[0]) * t0, y0 = a[1] + (b[1] - a[1]) * t0;
          const x1 = a[0] + (b[0] - a[0]) * t1, y1 = a[1] + (b[1] - a[1]) * t1;
          verts.push(x0 - CX, y0 - CY, drapeZ(x0, y0, off == null ? 3 : off),
                     x1 - CX, y1 - CY, drapeZ(x1, y1, off == null ? 3 : off));
          owner.push(k);
        }
      }
    }
    if (!verts.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.9 }));
    o.userData.owner = owner;
    return o;
  }

  /* §3.2 — "polygons keep a soft fill with a crisp edge". A fill on draped
     ground has to follow the ground, so the ring is triangulated in plan and
     every vertex is then lifted to its own draped elevation — a TIN of the
     boundary, which is as close to the terrain as a boundary's own vertices can
     get. It is applied to the USER'S closed features only (`area`, `volume`):
     they are small and they are what he draws to measure. The site-wide
     polygons — decision units, piles, EA's 802 design features — keep their
     outline, because a translucent fill over the whole site is exactly the
     overdraw that costs a software-GL frame its budget. */
  function drapedFill(ring, colorHex, opacity) {
    if (!ring || ring.length < 3 || !THREE.ShapeUtils) return null;
    const pts2 = ring.map(p => new THREE.Vector2(p[0] - CX, p[1] - CY));
    let faces = null;
    try { faces = THREE.ShapeUtils.triangulateShape(pts2, []); } catch (e) { return null; }
    if (!faces || !faces.length) return null;
    const pos = new Float32Array(ring.length * 3);
    for (let i = 0; i < ring.length; i++) {
      pos[i * 3] = ring[i][0] - CX;
      pos[i * 3 + 1] = ring[i][1] - CY;
      pos[i * 3 + 2] = drapeZ(ring[i][0], ring[i][1], 1.2);
    }
    const idx = [];
    for (const f of faces) idx.push(f[0], f[1], f[2]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: opacity == null ? 0.25 : opacity,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    m.renderOrder = 2;
    return m;
  }

  /* §3.2 — points as small discs with a dark ring rather than hard squares.
     One shared texture, so it costs no extra draw call anywhere. */
  let dotTex = null;
  function dotTexture() {
    if (dotTex) return dotTex;
    const N = 64, c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    g.beginPath(); g.arc(N / 2, N / 2, N / 2 - 3, 0, Math.PI * 2);
    g.fillStyle = "#fff"; g.fill();
    g.lineWidth = 5; g.strokeStyle = "rgba(8,12,15,.92)"; g.stroke();
    dotTex = new THREE.CanvasTexture(c);
    dotTex.minFilter = THREE.LinearFilter;
    return dotTex;
  }
  function dotMaterial(opts) {
    return new THREE.PointsMaterial(Object.assign({
      map: dotTexture(), alphaTest: 0.35, transparent: true, sizeAttenuation: true
    }, opts || {}));
  }

  /* §3.2 — the selection halo. A wider, brighter ghost of the selected feature
     that pulses for a moment when the selection changes and then settles. It is
     BOUNDED on purpose: a halo that pulses for ever would ask for a frame for
     ever, and an idle 3D view that keeps rendering is the one thing this
     viewer's render-on-demand contract forbids. One scalar per frame, no
     allocation, and nothing at all once it has settled. */
  const HALO_MS = 1500;
  let haloMats = [], pulseUntil = 0, lastSel = null, haloSettled = false;

  let lastCadSkip = 0;          // so the drape-budget toast fires once, not per rebuild
  function rebuildOverlays() {
    if (!scene) return;
    if (overlayGroup) scene.remove(overlayGroup);
    overlayGroup = new THREE.Group();
    /* the particle streams live inside overlayGroup, so a rebuild throws the old
       ones away with it; the list has to go with them or the loop keeps writing
       into geometry nothing draws (v13 §3.1) */
    waterAnim = []; animLast = 0;
    haloMats = [];
    const zx = exag();
    /* v15: the drop-shadow sink and the label specs this pass collects */
    const SHW = [], OVL = [];
    if (LS("framework", "dus")) {
      const DU_COLOR = { "DU-1N": 0xE4796A, "DU-1S": 0xE4796A, "DU-2": 0x5B8FF9, "DU-3": 0x4FCE9B };
      for (const d of SBMM_DATA.dus)
        overlayGroup.add(tag(addShadow(SHW, drapedLine(d.ring, DU_COLOR[d.name] || 0xcccccc, true, 3)),
                             "framework", "dus"));
    }
    if (LS("framework", "piles")) {
      for (const p of SBMM_DATA.piles) {
        const traced = (p.name || "").includes("Fig 2");
        overlayGroup.add(tag(addShadow(SHW, drapedLine(p.ring, traced ? 0xE8B34B : 0x8BE04B, true, 3)),
                             "framework", "piles"));
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
        tag(addShadow(SHW, o), "design", "gis_" + ((r.props && r.props.layer) || "design"));
        overlayGroup.add(o);
      }
    }
    /* v15 §3.1: the rest of EA's geodatabase — the design LINES (daylight,
       grade, haul) and the boundary / existing-conditions layers, which
       rings3d() never returned. Merged per layer: 580 features, ~10 draw calls,
       and a click still names the feature it hit. */
    if (SBMM.designGIS && SBMM.designGIS.batch3d) {
      for (const b of SBMM.designGIS.batch3d()) {
        const col = new THREE.Color(b.color || "#cccccc").getHex();
        if (b.lines.length) {
          const o = drapedBatch(b.lines, col);
          if (o) {
            o.userData.pick = { kind: "gisBatch", items: b.lines };
            tag(o, "design", "gis_" + b.key);
            overlayGroup.add(o);
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
          overlayGroup.add(po);
        }
      }
    }
    /* the August-2026 survey linework (spec §10): the pipes, the sandbag wall
       and the pit contours, draped like the design polygons and pickable */
    if (SBMM.survey && SBMM.survey.lines3d) {
      for (const r of SBMM.survey.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        tag(addShadow(SHW, o), "invest", "survey_" + ((r.props && r.props.layer) || ""));
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
        tag(addShadow(SHW, o), "framework",
            (r.props && r.props.layer === "storm_inferred") ? "storm_inferred" : "storm_cad");
        overlayGroup.add(o);
      }
      const sp = SBMM.storm.points3d();
      if (sp.length) {
        const pos = [];
        for (const q of sp) pos.push(q.x - CX, q.y - CY, drapeZ(q.x, q.y, 5));
        const gg = new THREE.BufferGeometry();
        gg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        overlayGroup.add(tag(new THREE.Points(gg, dotMaterial({ size: 9, color: SC })),
                             "framework", "storm_nodes"));
      }
    }
    /* the drainage map (v14 §4): the catchment polygons draped like the DUs and
       the longest flow path of each drawn as it runs. Read-only analysis, so the
       pick card is the same popup the 2D map binds. */
    if (SBMM.drainage && SBMM.drainage.hasResult()) {
      /* rings3d hands back OPEN RUNS, not closed rings: a catchment boundary
         that reaches the survey limit has no ground under the rest of it, and a
         closed drape there stands up as a curtain (js/drainage.js groundRuns) */
      for (const r of SBMM.drainage.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), r.closed === true, 3);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        tag(addShadow(SHW, o), "framework",
            (r.props && r.props.layer === "DRAIN-OUTLET") ? "drain_outlet" : "drain_first");
        overlayGroup.add(o);
      }
      for (const r of SBMM.drainage.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 2);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        tag(addShadow(SHW, o), "framework", "drain_paths");
        overlayGroup.add(o);
      }
    }
    /* v19 §2: the stream network, draped like every other overlay line. A
       stream follows the ground by construction, but a link that ends at the
       survey limit still has its last vertex out over the water, so it goes
       through js/drainage.js groundRuns() like the catchment boundaries do. */
    if (SBMM.accum && SBMM.accum.lines3d) {
      for (const r of SBMM.accum.lines3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 3);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        tag(addShadow(SHW, o), "framework", "accum_streams");
        overlayGroup.add(o);
      }
    }
    /* the design storm (v14 Phase 2): the same catchment boundaries, coloured by
       this storm's runoff depth instead of by outlet, and picked with the same
       card the 2D choropleth opens. */
    if (SBMM.runoff && SBMM.runoff.rings3d) {
      for (const r of SBMM.runoff.rings3d()) {
        const o = drapedLine(r.ring, new THREE.Color(r.color).getHex(), false, r.width || 3);
        o.userData.pick = { kind: "gis", props: r.props, geom: r.geom };
        tag(addShadow(SHW, o), "framework", "runoff_depth");
        overlayGroup.add(o);
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
        tag(o, r.group || "design", "cad_" + (r.key || "misc"));
        overlayGroup.add(o);
      }
      if (skipped && skipped !== lastCadSkip) {
        toast(`3D: ${fmt0(skipped)} CAD lines beyond the ${fmt0(BUDGET)}-line drape budget are not shown — switch a group off in Layers`, 5200);
      }
      lastCadSkip = skipped;
    }
    if (SBMM.designEA && LS("design", "pdf_boundaries")) {
      const DCOL = { "area-validated": 0xFF6B4A, "unclassified": 0xE8B34B, "surveyed": 0x4FD2E8 };
      for (const r of SBMM.designEA.rings3d()) {
        const o = drapedLine(r.ring, DCOL[r.conf] || 0xcccccc, true, 3);
        /* §3.1: EA's PDF-derived boundaries were drawn in 3D but said nothing
           about themselves — a click found nothing and the parity table found
           no object for the row. Both are the same missing tag. */
        o.userData.pick = { kind: "gis",
          props: r.props || { name: "EA boundary", layer: "pdf_boundaries", confidence: r.conf },
          geom: r.geom || { type: "Polygon", coordinates: [r.ring] } };
        tag(addShadow(SHW, o), "design", "pdf_boundaries");
        overlayGroup.add(o);
      }
    }
    {
      const COLORS = { line: 0x4FB3CE, area: 0x4FB3CE, volume: 0x4FCE9B, profile: 0xC792EA,
                       dim: 0xE8B34B, text: 0xE8EEF1, flow: 0x55C1FF };
      /* every object a feature contributes carries its id, so a 3D click can
         select, inspect and edit exactly the feature a 2D click would (§8) */
      const own = (o, f) => {
        o.userData.pick = { kind: "feature", fid: f.id };
        tag(o, "mywork", SBMM.myWork.classOf(f));
        return o;
      };
      /* §3.2 — the selection's halo: the same geometry again, brighter, drawn
         through the terrain so the selected thing is findable from any angle */
      const halo = (o, col) => {
        if (!o || !o.geometry) return;
        const m = new THREE.LineBasicMaterial({ color: 0xFFF3B0, transparent: true,
          opacity: 0.34, depthTest: false, depthWrite: false });
        const h = new THREE.Line(o.geometry, m);
        h.renderOrder = 7;
        haloMats.push(m);
        overlayGroup.add(h);
      };
      for (const f of SBMM.store.features) {
        /* both masks: the feature's own visibility AND its My-work class row */
        if (!f.visible || !SBMM.myWork.shown(f)) continue;
        const sel = SBMM.store.selected === f.id;
        let col = COLORS[f.type] || 0xFFD34D;
        if (f.style && f.style.color) col = new THREE.Color(f.style.color).getHex();
        if (sel) col = 0xFFD34D;
        /* annotations: the geometry drapes as usual, the label rides above it as a sprite */
        const colCss = "#" + col.toString(16).padStart(6, "0");
        if (f.type === "dim" && f.pts.length > 1) {
          const o = own(addShadow(SHW, drapedLine(f.pts, col, false, sel ? 5 : 3.5)), f);
          overlayGroup.add(o);
          if (sel) halo(o);
          const mx = (f.pts[0][0] + f.pts[1][0]) / 2, my = (f.pts[0][1] + f.pts[1][1]) / 2;
          /* v15 §2.3: through the label layer, so it is screen-sized, chipped,
             deduped and collision-managed like every other label */
          OVL.push({ key: "dim:" + f.id, text: fmt(dist2d(f.pts[0], f.pts[1]), 1) + " ft",
                     color: colCss, x: mx, y: my, z: drapeZ(mx, my, 6) + ZMID,
                     priority: sel ? 70 : 55, pick: { kind: "feature", fid: f.id },
                     layer: { g: "mywork", l: SBMM.myWork.classOf(f) } });
          continue;
        }
        if (f.type === "text") {
          if (f.pts.length > 1) overlayGroup.add(own(addShadow(SHW, drapedLine(f.pts, col, false, 3)), f));
          const [tx, ty] = f.pts[0];
          /* the anchor itself, not just the chip. A single-point annotation's
             label can lose the 60-chip collision budget, and a feature that is
             ON and draws NOTHING is exactly what §3.1's parity table exists to
             catch — it is also what makes a text note clickable in 3D. */
          const anc = new THREE.Mesh(new THREE.SphereGeometry(sel ? 5 : 3.5, 8, 8),
            new THREE.MeshLambertMaterial({ color: col, emissive: sel ? 0x554400 : 0x000000 }));
          anc.position.set(tx - CX, ty - CY, drapeZ(tx, ty, 4));
          overlayGroup.add(own(anc, f));
          OVL.push({ key: "text:" + f.id, text: (f.props && f.props.text) || f.name || "text",
                     color: colCss, x: tx, y: ty, z: drapeZ(tx, ty, 6) + ZMID,
                     priority: sel ? 72 : 58, pick: { kind: "feature", fid: f.id },
                     layer: { g: "mywork", l: SBMM.myWork.classOf(f) } });
          continue;
        }
        /* v15 §3.1: a cross-section set is a baseline in 2D AND a cut line at
           every station with its chainage — in 3D it was the baseline alone */
        if (f.type === "sections" && f._sec) {
          const R2 = f._sec;
          overlayGroup.add(own(addShadow(SHW, drapedLine(f.pts, col, false, sel ? 4.5 : 3)), f));
          const every = R2.ns > 24 ? 4 : R2.ns > 12 ? 2 : 1;
          for (let st = 0; st < R2.ns; st++) {
            const a = [R2.cx[st] - R2.nx[st] * R2.half, R2.cy[st] - R2.ny[st] * R2.half];
            const b = [R2.cx[st] + R2.nx[st] * R2.half, R2.cy[st] + R2.ny[st] * R2.half];
            overlayGroup.add(own(addShadow(SHW, drapedLine([a, b], col, false, 2.5)), f));
            if (st % every === 0)
              OVL.push({ key: "sta:" + f.id + ":" + st,
                         text: SBMM.sections.staLabel ? SBMM.sections.staLabel(R2.sta[st])
                                                      : String(Math.round(R2.sta[st])),
                         color: colCss, x: b[0], y: b[1], z: drapeZ(b[0], b[1], 6) + ZMID,
                         priority: 35, pick: { kind: "feature", fid: f.id },
                         layer: { g: "mywork", l: SBMM.myWork.classOf(f) } });
          }
          continue;
        }
        /* v17 §5a: a redline is a draped line in its own ink colour, at the
           stroke's own mean width. It is deliberately NOT shadowed — a
           mark-up sits ON the drawing, and an outline under it would read as
           a second stroke. */
        if (f.type === "ink") {
          const ic = parseInt(String((f.props && f.props.color) || "#E4433A").slice(1), 16);
          const wmean = (f.props && f.props.widths && f.props.widths.length)
            ? f.props.widths.reduce((a, b) => a + b, 0) / f.props.widths.length : 0.55;
          overlayGroup.add(own(drapedLine(f.pts, ic, false, 1.5 + 3.5 * wmean + (sel ? 2 : 0)), f));
          continue;
        }
        /* v10: the run drapes like any line, and the two things that make it a
           WATER feature ride with it — each pond as a closed draped ring at its
           own level, and the drop itself as a small sphere you can pick. */
        if (f.type === "flow") {
          const pr = f.props || {};
          /* v15 §1: a what-if rim overflow is drawn as a hypothesis in 3D too */
          const wcol = pr.whatif ? 0x93A6B3 : col;
          const fl = own(addShadow(SHW, drapedLine(f.pts, wcol, false, sel ? 4.5 : 3)), f);
          overlayGroup.add(fl);
          if (sel) halo(fl);
          for (const pd of (pr.ponds || []))
            for (const ring of (pd.rings || []))
              if (ring && ring.length > 2) {
                overlayGroup.add(own(drapedLine(ring, 0x55C1FF, true, 2), f));
                /* one label per pond, keyed by cell and level: three routes
                   across the same pond share it (v15 §2.3) */
                const c = centroid(ring);
                OVL.push({ key: `pond:${pd.level.toFixed(2)}:${Math.round(c[0] / 10)}:${Math.round(c[1] / 10)}`,
                           text: fmt(pd.level, 1) + " ft · " + fmt(pd.depth_ft, 1) + " ft deep",
                           color: "#9FDCFF", x: c[0], y: c[1], z: pd.level, priority: 60,
                           pick: { kind: "feature", fid: f.id },
                           layer: { g: "mywork", l: SBMM.myWork.classOf(f) } });
              }
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
            new THREE.MeshLambertMaterial({ color: sel ? 0xFFD34D : 0x9FDCFF,
              emissive: sel ? 0x554400 : 0x11333F }));
          sp.position.set(dp[0] - CX, dp[1] - CY, drapeZ(dp[0], dp[1], 6));
          overlayGroup.add(own(sp, f));
          /* v13 §3.1: and the water moving along it */
          addFlowParticles(f, sel);
          continue;
        }
        if (f.type === "spot") {
          const [x, y] = f.pts[0];
          const s = new THREE.Mesh(new THREE.SphereGeometry(sel ? 9 : 6, 10, 10),
            new THREE.MeshLambertMaterial({ color: col, emissive: sel ? 0x554400 : 0x000000 }));
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
        const closed = f.type === "area" || f.type === "volume";
        const gen = own(addShadow(SHW, drapedLine(f.pts, col, closed, sel ? 4.5 : 3)), f);
        overlayGroup.add(gen);
        if (closed && f.pts.length < 400) {
          const fill = drapedFill(f.pts, col, sel ? 0.32 : 0.25);
          if (fill) overlayGroup.add(own(fill, f));
        }
        if (sel) halo(gen);
      }
    }
    /* design surfaces drape as a translucent shell over the terrain — only over the
       area they actually grade. Nodes where the design equals existing ground are
       dropped rather than drawn, which both removes the z-fighting a coincident
       sheet would cause and makes the cut/fill visible as a solid standing off the
       ground. The raster is decimated to keep the shell a few tens of thousands of
       triangles however fine the design grid is. */
    for (const f of SBMM.store.features) {
      if (f.type !== "surface" || f.visible === false) continue;
      if (!SBMM.myWork.shown(f)) continue;
      if (f.props && f.props.drape3d === false) continue;
      /* v15 §3.1: EA's four recovered surfaces (§5) are read-only `surface`
         features with NO `_surf` node grid — their elevations come from a
         raster read on demand — so the mesh branch skipped them and the 3D view
         showed nothing at all where 2D shows a footprint. Draw the footprint. */
      if (!f._surf) {
        if (!f.pts || f.pts.length < 3) continue;
        const o = drapedLine(f.pts, (f.style && f.style.color)
          ? new THREE.Color(f.style.color).getHex() : 0x4FD8E6, true, 4);
        o.userData.pick = { kind: "feature", fid: f.id };
        tag(addShadow(SHW, o), "mywork", SBMM.myWork.classOf(f));
        overlayGroup.add(o);
        const c = centroid(f.pts);
        OVL.push({ key: "surf:" + f.id, text: f.name || "design surface", color: "#7CD0E6",
                   x: c[0], y: c[1], z: drapeZ(c[0], c[1], 10) + ZMID, priority: 42,
                   pick: { kind: "feature", fid: f.id },
                   layer: { g: "mywork", l: SBMM.myWork.classOf(f) } });
        continue;
      }
      const m = designMesh(f);
      if (m) {
        m.userData.pick = { kind: "feature", fid: f.id };
        tag(m, "mywork", SBMM.myWork.classOf(f));
        overlayGroup.add(m);
      }
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
          const dots = new THREE.Points(g, dotMaterial({ size: spec.size * 1.25, color: c }));
          /* threeSpec() walks d.points in order, so a raycast index IS the
             record index — that is what lets a 3D click on a well marker open
             the very popup its 2D marker opens */
          dots.userData.pick = { kind: "dataset", dsId: spec.id };
          tagKey(dots, spec.rowKey);
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
          tagKey(stick, spec.rowKey);
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
      pointsObj = new THREE.Points(g, dotMaterial({ size: 16, vertexColors: true }));
      pointsObj.userData.pick = { kind: "sample" };
      tag(pointsObj, "invest", "samples");
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
      const tp = new THREE.Points(g, dotMaterial({ size: 12, color: 0x6FBF7F, opacity: .9 }));
      tp.userData.pick = { kind: "tree" };
      tag(tp, "base", "trees_detected");
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
        tag(addShadow(SHW, o), "cultural", (r.feature && r.feature.layer) || "cultural");
        overlayGroup.add(o);
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
        overlayGroup.add(cpo);
      }
    }
    /* v15 §3.1 — the computed contour set (js/analysis.js CONTOUR command). A
       contour's level IS its elevation, so no drape sampling is needed; one
       LineSegments per weight class, like the survey sets. */
    if (LS("base", "contours_custom") && SBMM.analysis && SBMM.analysis.customContours3d) {
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
          overlayGroup.add(tag(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({
            color: new THREE.Color(rec.color).getHex(), transparent: true,
            opacity: rec.heavy ? 0.85 : 0.5 })), "base", "contours_custom"));
        }
      }
    }

    /* v15 §3.2 — the whole drop shadow in one draw call */
    if (SHW.length) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute("position", new THREE.Float32BufferAttribute(SHW, 3));
      const sm = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({
        color: 0x0A1014, transparent: true, opacity: 0.55 }));
      sm.renderOrder = 1;
      overlayGroup.add(sm);
    }
    /* §3.1: the isopach heat map has no layer row of its own, so the only thing
       that can say the 3D drape IS the isopach is a label on it */
    if (drapeMesh.isopach && SBMM.isopach && SBMM.isopach.drapeSpec) {
      const sp2 = SBMM.isopach.drapeSpec();
      if (sp2 && sp2.bounds) {
        const bx = (sp2.bounds[0] + sp2.bounds[2]) / 2, by = (sp2.bounds[1] + sp2.bounds[3]) / 2;
        OVL.push({ key: "isopach", text: "isopach · design − ground (+ fill)", color: "#C792EA",
                   x: bx, y: by, z: drapeZ(bx, by, 24) + ZMID, priority: 44 });
      }
    }
    overlayGroup.scale.z = zx;
    scene.add(overlayGroup);
    /* v15 §2.3: this pass's labels, diffed by text against the ones already up */
    setLabels3d("overlay", OVL);
    /* §3.2: a bounded pulse when the selection changes — see HALO_MS */
    const selNow = SBMM.store.selected || null;
    if (haloMats.length && selNow !== lastSel) { pulseUntil = performance.now() + HALO_MS; haloSettled = false; }
    lastSel = selNow;
    /* hand the freshly built objects to the pick registry (§8) so a click in 3D
       opens the same popup a click in 2D does */
    if (SBMM.pick3d) SBMM.pick3d.syncScene();
    requestRender();
  }

  /* every (group, id) the scene currently draws something for — the v15 §3.1
     parity table's other half */
  function layersDrawn() {
    const out = {};
    if (!scene) return out;
    const add = t => { if (t) out[t.g + "/" + t.l] = (out[t.g + "/" + t.l] || 0) + 1; };
    for (const root of scene.children) {
      if (root === labelGroup) continue;          // counted by record, below
      root.traverse(o => {
        const t = o.userData && o.userData.layer;
        if (!t) return;
        /* a switched-off group is not drawn, and neither is anything under it */
        let vis = o.visible;
        for (let p = o.parent; p && vis; p = p.parent) vis = p.visible;
        if (vis) add(t);
      });
    }
    /* A label's `visible` is a per-FRAME decision — the collision pass, or the
       chip being off the side of the screen — not a statement about its layer.
       A text annotation the camera is not pointing at is still drawn by the 3D
       view, and for a single-point annotation the chip is the ONLY object it
       has, so the records are what the parity table must count. */
    for (const rec of labels3d.values())
      add(rec.sprite.userData && rec.sprite.userData.layer);
    return out;
  }

  /* mesh density: "high" is the default (smooth on decent hardware); "standard" is the
     fallback for weak machines. Changing it disposes the old geometry and rebuilds. */
  function detailMaxDim() {
    const d = $("v3dDetail");
    return d && d.value === "std" ? 640 : 1100;
  }

  async function rebuildTerrain(style) {
    /* the quadtree owns its own geometry — disposing it from here would pull
       the meshes out from under it */
    if (lodOn) { SBMM.terrain3d.detach(); lodOn = false; }
    else for (const t of terrainMeshes) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
    }
    terrainMeshes = [];
    if (lodAvailable()) {
      lodOn = true;
      SBMM.terrain3d.attach(lodContext());
      SBMM.terrain3d.setSun(sunAz, sunEl);
      await SBMM.terrain3d.setStyle(style || $("v3dStyle").value);
      await SBMM.terrain3d.update(true);
      terrainMeshes = SBMM.terrain3d.records();
      SBMM._v3dVerts = terrainMeshes.reduce((n, t) => n + t.nx * t.ny, 0);
      lodDirty = false;
      requestRender();
      return;
    }
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

    /* ---- touch (v11 §4.3, rebuilt for v17 §3) ----------------------
       v11 tracked live touch pointers here and turned two of them into a
       pinch. v17 replaces that with the ONE recogniser in js/touch.js — the
       same implementation the sheet viewer and the map sketch use, so a pinch
       means the same thing everywhere in the app — and adds the rest of the
       gesture set a native map has: momentum, twist, three-finger tilt,
       double-tap, two-finger tap, long-press.

       THE MOUSE PATH BELOW IS BYTE-FOR-BYTE WHAT IT WAS. Every handler in this
       rig now returns immediately for anything that is not a mouse, and the
       recogniser (which itself ignores `pointerType === "mouse"`) owns the
       rest. That is what makes "the desktop is untouched" a property of the
       code rather than a promise. */

    /* pan the camera plane by a screen delta — the same maths the right-drag
       pan uses, factored out so the pinch and the momentum can borrow it */
    function panBy(dx, dy) {
      const el = dom.clientHeight || 1;
      const k = 2 * st.sph.r * Math.tan((camera.fov * Math.PI / 180) / 2) / el;
      const right = new THREE.Vector3(), up = new THREE.Vector3();
      camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      st.targetDst.add(right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k)));
    }
    /* dolly by `k` about a FIXED scene point, keeping that point where it is on
       screen. Exactly the wheel's own maths (see the wheel handler); the pinch
       hands it the ground point under the two fingers' midpoint. */
    function dollyAbout(P, k) {
      const camDst = st.targetDst.clone().add(offsetOf(st.dst));
      const newCam = P.clone().add(camDst.sub(P).multiplyScalar(k));
      const newTgt = P.clone().add(st.targetDst.clone().sub(P).multiplyScalar(k));
      const off = newCam.clone().sub(newTgt);
      const r = clamp(off.length(), MINR, MAXR);
      st.targetDst.copy(newTgt);
      st.dst.r = r;
      st.dst.phi = clamp(Math.acos(clamp(off.z / (off.length() || 1), -1, 1)), PHI_MIN, PHI_MAX);
      st.dst.theta = Math.atan2(off.x, off.y);
    }
    /* the point the pinch dollies towards: the terrain under the midpoint, or
       — off the mesh — a point at the current orbit distance along that ray,
       which is what `pivotAt` already does for the wheel */
    function groundAt(x, y) { return pivotAt({ clientX: x, clientY: y }); }

    let glide = null;                   // the momentum handle, if one is running
    let navRec = null;                  // the gesture recogniser, for stats()
    const stopGlide = () => { if (glide) { glide.cancel(); glide = null; } };

    dom.addEventListener("pointerdown", e => {
      if (e.pointerType !== "mouse") { stopGlide(); return; }
      if (e.button === 2) e.preventDefault();
      /* capture is a convenience, not a requirement: it throws for a pointer id
         the browser has no active pointer for (a synthetic event, a pointer
         already released), and a throw here would leave the rig un-armed with
         no error the user could see */
      try { dom.setPointerCapture(e.pointerId); } catch (err) {}
      st.lastX = e.clientX; st.lastY = e.clientY;
      st.drag = e.button === 0 ? (st.mode === "fly" ? "look" : "orbit") : "pan";
    });
    dom.addEventListener("pointermove", e => {
      if (e.pointerType !== "mouse") return;
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
      if (e.pointerType !== "mouse") return;
      st.drag = null;
      try { dom.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    dom.addEventListener("pointerup", endDrag);
    dom.addEventListener("pointercancel", endDrag);

    /* ---- the gesture set (v17 §3) ----------------------------------
       Everything below is fed by js/touch.js's recogniser, which never sees a
       mouse. The handlers move the rig's DESTINATION state (`st.dst`,
       `st.targetDst`) and let the existing damping follow it, so a gesture and
       a preset button settle the same way. */
    if (SBMM.touch) {
      let pinchPivot = null;            // the ground point under the midpoint
      let mvx = 0, mvy = 0, mvt = 0;    // midpoint velocity, for the pan momentum
      let vtxDrag = false;              // a long-press landed on a 3D vertex handle
      const ev = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 1,
                              stopPropagation() {}, preventDefault() {} });

      /* A FINGER ON THE GLASS SUSPENDS TILE WORK (v20 §3).

         js/touch.js's recogniser decides what a gesture WAS from wall clock —
         a tap is pointerdown to pointerup within 300 ms — so any main-thread
         work running across a gesture can turn it into something else. The
         settle guard stops a rebuild STARTING under a finger; this stops one
         that started before the finger landed, which is the case that actually
         bit: test/e2e_tablet block 3's two-finger tap came 1.8 s after a
         double-tap, straight into the rebuild the double-tap's camera move had
         asked for, and measured 503 ms against a 300 ms window. It is on the
         canvas in the CAPTURE phase so it runs before the recogniser sees the
         event, and only for touch — a mouse cannot be mistimed this way. */
      dom.addEventListener("pointerdown", e => {
        if (e.pointerType === "touch" && lodOn && SBMM.terrain3d.suspend) SBMM.terrain3d.suspend();
      }, true);

      navRec = SBMM.touch.gestures(dom, {
        panstart() { stopGlide(); vtxDrag = false; },

        pan(g) {
          if (vtxDrag) { SBMM.pick3d.touchDrag.move(g.x, g.y); requestRender(); return; }
          /* §5a: a Pencil drag with a finger held down PANS — the Pencil's
             "modifier". The recogniser flags it; the two-finger gestures stay
             finger gestures. */
          if (g.modifier) { panBy(g.dx, g.dy); requestRender(); return; }
          if (st.mode === "fly") {
            st.yaw -= g.dx * 0.0028 * st.sens;
            st.pitch = clamp(st.pitch - g.dy * 0.0028 * st.sens, -1.45, 1.45);
            st.lookDirty = true;
          } else {
            st.dst.theta -= g.dx * 0.0055 * st.sens;
            st.dst.phi = clamp(st.dst.phi - g.dy * 0.0048 * st.sens, PHI_MIN, PHI_MAX);
          }
          requestRender();
        },

        panend(g) {
          if (vtxDrag) { SBMM.pick3d.touchDrag.end(); vtxDrag = false; return; }
          if (!g.flick || st.mode === "fly") return;
          /* momentum, and it MUST settle: js/touch.js decays v by 0.92 a frame
             and stops under 0.02 px/ms, so the render loop goes idle again and
             test/perf.mjs still counts 0 idle renders. */
          glide = SBMM.touch.momentum(g.vx, g.vy, (dx, dy) => {
            st.dst.theta -= dx * 0.0055 * st.sens;
            st.dst.phi = clamp(st.dst.phi - dy * 0.0048 * st.sens, PHI_MIN, PHI_MAX);
            requestRender();
          }, () => { glide = null; });
        },

        pinchstart(g) {
          stopGlide();
          vtxDrag = false;
          /* ONE raycast for the whole gesture (§3): re-picking the 1.5 M-vertex
             terrain on every pointermove is the difference between a pinch that
             tracks and a pinch that stutters */
          pinchPivot = groundAt(g.cx, g.cy);
          mvx = mvy = 0; mvt = performance.now();
        },

        pinch(g) {
          if (st.mode === "fly") return;
          if (pinchPivot && g.scale > 0.2 && g.scale < 5)
            dollyAbout(pinchPivot, 1 / g.scale);       // spread (scale > 1) = zoom in
          panBy(g.dcx, g.dcy);
          /* twist: the azimuth turns with the fingers, about the same target */
          if (Math.abs(g.twist) > 1e-4) st.dst.theta += g.twist;
          const t = performance.now(), dt = Math.max(1, t - mvt);
          mvx = mvx * 0.7 + (g.dcx / dt) * 0.3;
          mvy = mvy * 0.7 + (g.dcy / dt) * 0.3;
          mvt = t;
          requestRender();
        },

        pinchend() {
          pinchPivot = null;
          if (Math.hypot(mvx, mvy) < 0.15) return;
          glide = SBMM.touch.momentum(mvx, mvy, (dx, dy) => { panBy(dx, dy); requestRender(); },
            () => { glide = null; });
        },

        threestart() { stopGlide(); },
        three(g) {
          if (st.mode === "fly") return;
          st.dst.phi = clamp(st.dst.phi - g.dy * 0.0048 * st.sens, PHI_MIN, PHI_MAX);
          requestRender();
        },

        tap(g) { if (canvasClick) canvasClick(ev(g.x, g.y)); },

        doubletap(g) {
          const p = pickScene(ev(g.x, g.y));
          if (p) st.targetDst.copy(p);
          st.dst.r = clamp(st.dst.r * 0.6, MINR, MAXR);
          requestRender();
        },

        twofingertap() {
          st.dst.r = clamp(st.dst.r * 1.6, MINR, MAXR);
          requestRender();
        },

        end() {
          /* the gesture is over: let the tiles catch up with wherever it left
             the camera */
          if (lodOn && SBMM.terrain3d.resume) SBMM.terrain3d.resume();
          lodDirty = true; lodMoveAt = performance.now();
        },

        longpress(g) {
          /* a vertex handle first — dragging one is what the mouse gets from a
             plain press, and a finger has to ask for it */
          if (SBMM.pick3d && SBMM.pick3d.touchDrag.start(g.x, g.y)) {
            vtxDrag = true;
            toast("drag the vertex — lift to finish");
            return;
          }
          /* otherwise identify what is under the finger: hover has no touch
             equivalent, and this is where it went */
          if (SBMM.pick3d) SBMM.pick3d.click(ev(g.x, g.y));
        }
      });
    }

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
      /* v15: what the rig thinks the current gesture is, and how many TOUCH
         pointers it is tracking. A pinch that does not dolly is either "the
         second pointer never arrived" or "the arithmetic is wrong", and without
         these two numbers the harness cannot tell those apart.

         v17 kept both and re-pointed them: the `touches` Map they read is gone,
         because the rig's touch state IS js/touch.js's recogniser now. `st.drag`
         still answers for the mouse; the recogniser answers for a finger. */
      dragMode() { return (navRec && navRec.mode()) || st.drag; },
      touchCount() { return navRec ? navRec.count() : 0; },
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

  /* v17 §5b — the drape texture at a grazing angle is where this view looks
     cheap, and anisotropic filtering is the one line that fixes it. Ask the
     DEVICE for its maximum (an M-series iPad offers 16) rather than hard-coding
     4; capped at 16 because nothing above it is visible and every level costs
     texture bandwidth. Safe before the renderer exists — it returns the old
     constant, and every texture is built after init(). */
  let ctxLost = false;
  function maxAniso() {
    try {
      const m = renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy
        ? renderer.capabilities.getMaxAnisotropy() : 4;
      return Math.max(1, Math.min(16, m || 4));
    } catch (e) { return 4; }
  }

  /* The canvas click handler, assigned by init() below. It lives here rather
     than inside init()'s closure because the nav rig (makeNav) is a closure of
     its own and a TAP has to reach exactly the same code a click does. */
  let canvasClick = null;

  /* THE QUADTREE HAS TO MAKE PICKING CHEAPER, NOT DEARER (v20 §3).

     three tests every triangle of every mesh whose bounding sphere the ray
     touches. Thrown at all thirty tiles that is ~3 M triangle tests and about
     400 ms of BLOCKED MAIN THREAD — and that is not merely a stutter, because
     js/touch.js's recogniser classifies a tap by wall clock: the pinch pivot
     raycast happens on the second finger's `pointerdown`, so the 60 ms
     two-finger tap in test/e2e_tablet.mjs block 3 arrived at `up` measuring
     469 ms, past the 300 ms tap window, and silently stopped being a tap.
     (The whole-DEM build got away with three meshes.)

     So the tiles are ordered by where the ray ENTERS their bounding sphere and
     raycast one at a time, stopping as soon as the best hit so far is nearer
     than the next candidate's sphere. That is exact — a mesh whose bounds
     start beyond a hit cannot contain a nearer one — and it usually stops at
     the first tile. This is the pick the tiles were supposed to buy. */
  const _pickSph = new THREE.Sphere(), _pickPt = new THREE.Vector3();
  function raycastTerrain() {
    const list = [];
    for (const t of terrainMeshes) {
      const m = t.mesh, g = m.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (!g.boundingSphere) continue;
      m.updateMatrixWorld();
      _pickSph.copy(g.boundingSphere).applyMatrix4(m.matrixWorld);
      if (!raycaster.ray.intersectsSphere(_pickSph)) continue;
      /* distance to where the ray enters the sphere; 0 when the camera is
         inside it, which is the conservative answer */
      const d = raycaster.ray.intersectSphere(_pickSph, _pickPt)
        ? raycaster.ray.origin.distanceTo(_pickPt) : 0;
      list.push([d, m]);
    }
    list.sort((a, b) => a[0] - b[0]);
    let best = null;
    for (const [d, m] of list) {
      if (best && best.distance <= d) break;
      const hits = raycaster.intersectObject(m, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) best = hits[0];
    }
    return best;
  }

  /* raycast the terrain under a mouse/pointer event; returns a scene-space Vector3 */
  function pickScene(e) {
    if (!raycaster || !terrainMeshes.length) return null;
    const dom = renderer.domElement;
    const r = dom.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(p, camera);
    const hit = raycastTerrain();
    const out = hit ? hit.point.clone() : null;
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

  /* v15 §3.2 — "look at (click a point)". A one-shot arm rather than a mode:
     the next click on the terrain becomes the orbit target, with the rig's own
     easing, and anything else cancels it. */
  let lookArmed = false;
  function startLookAt() {
    if (!open) { toast("open the 3D view first"); return; }
    lookArmed = !lookArmed;
    const b = $("v3dLookAt");
    if (b) b.classList.toggle("active", lookArmed);
    toast(lookArmed ? "look at — click a point on the terrain to centre the view there"
                    : "look at — cancelled");
  }

  /* §3.2 — a small elevation legend. It reads the site DEM's own range and
     paints the hypsometric ramp the 2D elevation-tint layer uses, so the two
     views describe height with the same colours. */
  function paintElevLegend() {
    const host = $("v3dElevLeg");
    if (!host) return;
    const zr = SBMM._zrSite || SBMM.demSite.zRange();
    const stops = [];
    for (let i = 0; i < 6; i++) {
      const c = lerpRamp(RAMPS.hypso, i / 5);
      stops.push(`rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0}) ${(i / 5 * 100).toFixed(0)}%`);
    }
    host.innerHTML = `<span class="mono">${fmt0(zr[1])}</span>`
      + `<span class="elbar" style="background:linear-gradient(0deg,${stops.join(",")})"></span>`
      + `<span class="mono">${fmt0(zr[0])}</span>`;
    host.title = `Surveyed ground: ${fmt0(zr[0])}–${fmt0(zr[1])} ft (NAVD88). `
      + `The same hypsometric ramp the 2D elevation tint uses.`;
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

    /* WebGL2 where the device has it (three picks it by default), MSAA on, and
       the pixel ratio capped at 2 — an iPad reports 2, and 3 on a Pro would
       quadruple the fill rate for nothing anyone can see (v17 §5b). */
    renderer = new THREE.WebGLRenderer({ canvas: $("v3dCanvas"), antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    /* iPad Safari drops the WebGL context under memory pressure, and the
       default behaviour is a dead black canvas with no error anywhere. Prevent
       the default on loss (which is what allows a restore at all), rebuild from
       the store on restore, and SAY SO both times — a silent black rectangle is
       the one answer this app must not give. */
    {
      const cv = $("v3dCanvas");
      cv.addEventListener("webglcontextlost", e => {
        e.preventDefault();
        ctxLost = true;
        toast("the 3D view lost its graphics context — rebuilding…", 5000);
      }, false);
      cv.addEventListener("webglcontextrestored", async () => {
        ctxLost = false;
        try {
          texCache = {};
          await rebuildTerrain();
          await setStyle($("v3dStyle").value);
          rebuildOverlays();
          requestRender();
          toast("the 3D view is back");
        } catch (err) { console.error(err); toast("the 3D view could not be rebuilt — reopen it", 6000); }
      }, false);
    }
    scene = new THREE.Scene();
    /* the dome is what is actually seen; this is only what shows through it */
    scene.background = new THREE.Color(SKY_HORIZON);
    scene.fog = new THREE.Fog(SKY_HORIZON, 9000, 38000);

    camera = new THREE.PerspectiveCamera(55, 1, 5, 90000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -4000, 3200);
    /* the quadtree selects against the frustum, and the frustum is nonsense
       until the camera has been aimed once. nav overrides this on its first
       update; without it the opening selection sees an identity view matrix. */
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    hemiLight = new THREE.HemisphereLight(0xC9E2F0, 0x2B3238, 0.85);
    scene.add(hemiLight);
    sunLight = new THREE.DirectionalLight(0xFFF3DD, 1.15);
    scene.add(sunLight);
    {
      const az = SBMM.view && SBMM.view.pref ? SBMM.view.pref("sunAz") : undefined;
      const el = SBMM.view && SBMM.view.pref ? SBMM.view.pref("sunEl") : undefined;
      if (typeof az === "number") sunAz = az;
      if (typeof el === "number") sunEl = el;
    }
    applySun();
    skyMesh = buildSky();
    scene.add(skyMesh);
    envGroup = buildEnv();
    envGroup.scale.z = exag();
    scene.add(envGroup);

    raycaster = new THREE.Raycaster();
    nav = makeNav(renderer.domElement);
    nav.setFromCamera();
    /* the terrain is built AFTER the rig (v20 §3): the quadtree picks its
       levels from the frustum, so it needs the camera the user will actually
       be looking through, not the one three.js constructed */
    await rebuildTerrain("ortho");
    /* Hand the scene to the pick registry BEFORE the first rebuildOverlays, so
       the objects that rebuild makes are registered as it makes them (§8). */
    if (SBMM.pick3d) SBMM.pick3d.attach({
      renderer, camera, scene, raycaster,
      dom: renderer.domElement,
      overlayGroup: () => overlayGroup,
      labelGroup: () => labelGroup,
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
    /* v17 §3: a tap and a click do the same thing, so they call the same
       function. `SBMM.touch` routes a finger's tap here through the recogniser
       (the rig has already decided it was not an orbit), and the DOM `click`
       below is left to the mouse — a tap ALSO produces a synthetic click, and
       running both would pick twice and toggle "look at" straight off again.
       It is published on the module-level `canvasClick` because the nav rig is
       built in its own closure (`makeNav`) and cannot see into this one. */
    canvasClick = function (e) {
      if (lookArmed) {
        lookArmed = false;
        const lb = $("v3dLookAt"); if (lb) lb.classList.remove("active");
        const q = pickScene(e);
        if (q) { nav.setTarget(q); const w = pickWorld(e);
                 toast("centred on " + fmt0(w[0]) + " E, " + fmt0(w[1]) + " N · " + fmt(w[2], 1) + " ft"); }
        else toast("no surveyed terrain under that click — nothing to centre on");
        return;
      }
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
    };
    canvas.addEventListener("click", e => {
      if (SBMM.touch && SBMM.touch.touchRecent()) return;   // the tap already did it
      if (!wasClick(e)) return;                 // that was an orbit / look drag
      canvasClick(e);
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
      /* v13 §3.1: frames are requested ONLY while a visible flow exists and the
         toggle is on — with nothing on screen this branch never runs and the
         idle-render count stays 0 (test/perf.mjs). */
      if (animOn && waterAnim.length) {
        const now = performance.now();
        if (!animLast) animLast = now - WATER_FPS_MS;
        if (now - animLast >= WATER_FPS_MS) {
          stepWaterAnim(Math.min(0.25, (now - animLast) / 1000));
          animLast = now;
          needsRender = true;
        }
      } else animLast = 0;
      /* v15 §3.2: the selection halo pulses for HALO_MS after the selection
         changes and then settles — bounded on purpose, so an idle view is still
         an idle view (one scalar per frame, nothing allocated) */
      if (haloMats.length) {
        const nowH = performance.now();
        if (nowH < pulseUntil) {
          const k = 0.30 + 0.26 * (0.5 + 0.5 * Math.sin(nowH * 0.007));
          for (let i = 0; i < haloMats.length; i++) haloMats[i].opacity = k;
          needsRender = true;
        } else if (!haloSettled) {
          for (let i = 0; i < haloMats.length; i++) haloMats[i].opacity = 0.34;
          haloSettled = true; needsRender = true;
        }
      }
      const moved = nav.update();
      /* v20 §3, trap 4: the quadtree re-selects on a SETTLED camera, never per
         frame. update() returns without asking for a frame when the drawn set
         has not changed, which is what keeps an idle view at zero renders. */
      if (lodOn) {
        const nowL = performance.now();
        if (moved) {
          lodMoveAt = nowL; lodDirty = true;
          /* a long flight refines as it goes rather than only on arrival — the
             view is already redrawing, so this costs a selection and nothing
             else, and openAt() over the mine window otherwise sat at 64 ft for
             the whole descent */
          if (nowL - lodLast > 700) { lodLast = nowL; SBMM.terrain3d.update(); }
        } else if (lodDirty && nowL - lodMoveAt > LOD_SETTLE_MS
                   && !(nav.touchCount && nav.touchCount() > 0)) {
          /* never rebuild under the user's fingers: a gesture in progress is
             timed in wall clock by the recogniser, and a rebuild inside it
             changes what the gesture was */
          lodDirty = false; lodLast = nowL;
          SBMM.terrain3d.update();
        }
      }
      if (moved || needsRender) {
        needsRender = false;
        renderCount++;
        /* v15 §2.3/§3.2: both of these are per-DRAW, not per-rAF — nothing here
           asks for a frame, so an idle view still issues none */
        updateLabels3d();
        updateSky();
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
      if (lodOn) SBMM.terrain3d.setExag(zx);
      if (canopyMesh) canopyMesh.scale.z = zx;
      if (overlayGroup) overlayGroup.scale.z = zx;
      if (contourGroup) contourGroup.scale.z = zx;
      if (sketchObj) sketchObj.scale.z = zx;
      if (sheetGroup) sheetGroup.scale.z = zx;
      if (stageGroup) stageGroup.scale.z = zx;
      if (envGroup) envGroup.scale.z = zx;
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
      /* two BASE rows are overlay objects rather than terrain: the detected trees
         and the computed contour set (v15 §3.1) */
      if (ev.group === "base" && (ev.layer === "trees_detected" || ev.layer === "contours_custom"))
        queueOverlays();
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
      if (contourGroup) {
        contourGroup.visible = want;
        for (const sub of contourGroup.children)
          if (sub.name) sub.visible = SBMM.layerState.isOn("base", sub.name);
      }
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
        tag(canopyMesh, "base", "canopy");
        scene.add(canopyMesh);
        $("v3dStatus").textContent = "";
      }
      } finally { canopyBusy = false; }
      if (canopyMesh) canopyMesh.visible = true;
      requestRender();
    }

    const detSel = $("v3dDetail");
    if (detSel) detSel.onchange = async () => {
      /* v17 §3: remembered, in the same store the camera and the sun use. A
         remembered choice beats a guess — an M-series iPad handles the 1.5 M
         vertex mesh and an A10 does not, and only the owner knows which. */
      if (SBMM.view && SBMM.view.pref) SBMM.view.pref("detail", detSel.value);
      $("v3dStatus").textContent = "rebuilding terrain…";
      await new Promise(r => setTimeout(r, 30));
      await rebuildTerrain();
      await refreshTerrainForCamera();
      $("v3dStatus").textContent = "";
    };

    const lyBtn = $("v3dLayersBtn");
    if (lyBtn) lyBtn.onclick = () => SBMM.shell.setTab("layers");

    /* v13 §3.1: "animate water", default on, remembered in the same store the
       rest of the 3D view state uses (js/view.js). */
    {
      const rem = SBMM.view && SBMM.view.pref ? SBMM.view.pref("animWater") : undefined;
      animOn = rem === undefined ? true : !!rem;
      const aw = $("v3dAnimWater");
      if (aw) { aw.checked = animOn; aw.onchange = e => setAnimWater(e.target.checked); }
    }

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
    /* v17 §3: the on-screen nav pad. A hardware keyboard still has the arrow
       keys and a trackpad still has the wheel — this is the thumb's copy of
       them, and it is shown only under body.touch (css/app.css `.touchonly`). */
    document.querySelectorAll("#v3dNav [data-nav]").forEach(b => b.onclick = () => {
      const k = b.dataset.nav;
      if (k === "in") nav.st.dst.r = clamp(nav.st.dst.r * 0.72, 40, 60000);
      else if (k === "out") nav.st.dst.r = clamp(nav.st.dst.r * 1.4, 40, 60000);
      else if (k === "tiltup") nav.st.dst.phi = clamp(nav.st.dst.phi + 0.14, 0.02, 1.52);
      else if (k === "tiltdn") nav.st.dst.phi = clamp(nav.st.dst.phi - 0.14, 0.02, 1.52);
      requestRender();
    });
    $("v3dFrame").onclick = frameSelectionOrSite;
    if ($("v3dLookAt")) $("v3dLookAt").onclick = startLookAt;
    paintElevLegend();
    /* the sun, in View settings beside the rest of the view's own settings */
    {
      const a = $("v3dSunAz"), el = $("v3dSunEl");
      if (a) { a.value = String(sunAz); a.oninput = ev => setSun(parseFloat(ev.target.value), null); }
      if (el) { el.value = String(sunEl); el.oninput = ev => setSun(null, parseFloat(ev.target.value)); }
      applySun();
    }
    /* §3.2 — the keyboard. 1,2,4,5,6 are the view presets and Shift+3 is the
       south one: a bare 3 has toggled the whole 3D view since v1 and is in the
       help table, and silently re-binding a documented key is a regression the
       spec did not ask for. F likewise keeps meaning fly (it is in the tooltip
       and in the nav help), so FIT is Shift+F. Arrows orbit; Shift+arrows pan. */
    /* Keyed on e.code, not e.key: Shift+3 produces "#" on a US keyboard, and a
       preset that only works on some layouts is not a shortcut. Registered in
       the CAPTURE phase, because js/mode.js's document listener was registered
       first (at boot; this one is registered when 3D is first opened) and owns
       bare F for fly and bare 3 for open/close-3D — stopping the event here is
       the only way to claim Shift+F and Shift+3 without taking those away. */
    const PRESET_CODE = { Digit1: "top", Digit2: "n", Digit3: "s",
                          Digit4: "e", Digit5: "w", Digit6: "iso" };
    document.addEventListener("keydown", e => {
      if (!open || !nav) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector(".modal.on")) return;
      const pv = PRESET_CODE[e.code];
      if (pv && !(e.code === "Digit3" && !e.shiftKey)) {
        e.preventDefault(); e.stopPropagation();
        preset(pv);
        return;
      }
      if (e.code === "KeyF" && e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        frameSelectionOrSite();
        return;
      }
      const k = e.key;
      if (k.indexOf("Arrow") !== 0 || nav.mode() === "fly") return;
      e.preventDefault(); e.stopPropagation();
      const st = nav.st;
      if (e.shiftKey) {
        /* pan the target in the camera plane, a fixed fraction of the range */
        const step = st.dst.r * 0.06;
        const right = new THREE.Vector3(), up = new THREE.Vector3();
        camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
        const dx = k === "ArrowLeft" ? 1 : k === "ArrowRight" ? -1 : 0;
        const dy = k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0;
        st.targetDst.add(right.multiplyScalar(dx * step).add(up.multiplyScalar(dy * step)));
      } else {
        if (k === "ArrowLeft") st.dst.theta -= 0.13;
        else if (k === "ArrowRight") st.dst.theta += 0.13;
        else if (k === "ArrowUp") st.dst.phi = clamp(st.dst.phi - 0.09, PHI_MIN, PHI_MAX);
        else if (k === "ArrowDown") st.dst.phi = clamp(st.dst.phi + 0.09, PHI_MIN, PHI_MAX);
      }
      requestRender();
    }, true);
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
    /* and the water stage surface, if an overtopping analysis is open (v13 §3.2) */
    stageKey = null;
    setWaterStage(SBMM.water && SBMM.water.stageSpec ? SBMM.water.stageSpec() : null);
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
  /* v20 §3: the quadtree picks its levels from the camera, and nav.place()
     only sets the DESIRED state — the camera itself is written in the render
     loop. So opening the view has to step the rig once and re-select before it
     says it is ready, or the terrain that greets the user is the 64-ft root
     built against three.js's constructor camera and it refines a few seconds
     later. That was visible as e2e block 9a-2 reading 66,049 vertices for
     "high" and 1,585,176 for the same setting a moment afterwards. */
  async function refreshTerrainForCamera() {
    if (!lodOn || !nav || !camera) return;
    nav.update();
    camera.updateMatrixWorld();
    await SBMM.terrain3d.update(true);
    terrainMeshes = SBMM.terrain3d.records();
    SBMM._v3dVerts = terrainMeshes.reduce((n, t) => n + t.nx * t.ny, 0);
    lodDirty = false;
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
      await refreshTerrainForCamera();
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
    await refreshTerrainForCamera();
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
      /* v20 §3: which terrain builder owns the meshes, and what the quadtree
         is drawing — tiles, the finest level reached, triangles and bytes */
      terrainLod: lodOn,
      terrainQualityPx: qualityPx(),
      tiles: lodOn ? SBMM.terrain3d.stats() : null,
      tileCache: SBMM.tiles && SBMM.tiles.ready() ? SBMM.tiles.stats() : null,
      sceneObjects: scene ? scene.children.length : 0,
      contourDrawCalls: (() => {
        let n = 0;
        if (contourGroup) contourGroup.traverse(o => { if (o.isLineSegments) n++; });
        return n;
      })(),
      contourVerts: (() => {
        let n = 0;
        if (contourGroup) contourGroup.traverse(o => {
          if (o.geometry && o.geometry.getAttribute("position")) n += o.geometry.getAttribute("position").count;
        });
        return n;
      })(),
      contoursVisible: !!(contourGroup && contourGroup.visible),
      canopyVisible: !!(canopyMesh && canopyMesh.visible),
      isopachDraped: !!drapeMesh.isopach,
      waterDraped: !!drapeMesh.water,
      /* v13: the animated flow and the stage surface */
      waterAnimOn: animOn,
      waterAnim: waterAnim.map(a => ({ fid: a.fid, n: a.n, tracks: a.tracks.length,
                                       pipes: a.tracks.filter(t => t.pipe).length })),
      waterParticles: waterAnim.reduce((n, a) => n + a.n, 0),
      /* how far along its track the animation has walked, and where the first
         particle of the first stream is standing — the two things a harness can
         watch to prove the water is actually moving */
      waterAnimT: +animT.toFixed(3),
      waterSample: waterAnim.length
        ? [+waterAnim[0].pos[0].toFixed(3), +waterAnim[0].pos[1].toFixed(3),
           +waterAnim[0].pos[2].toFixed(3)] : null,
      waterStage: stageInfo, zmid: ZMID,
      /* v15: the label layer and the parity table */
      labels3d: labels3d.size,
      labelsVisible: lblVisible,
      labelTexts: [...labels3d.values()].filter(r => r.sprite.visible).map(r => r.text).sort(),
      layersDrawn: layersDrawn(),
      sun: { az: +sunAz.toFixed(1), el: +sunEl.toFixed(1) },
      sky: !!skyMesh, groundPlane: !!envGroup,
      cadDrapeBudgetSkipped: lastCadSkip,
      contourSegments: SBMM._v3dContourDrop || null,
      sheetDrapes: [...sheetMeshes.keys()].sort(),
      sheetDrapeVerts: [...sheetMeshes.values()].reduce(
        (n, m) => n + m.geometry.getAttribute("position").count, 0),
      sheetDrapesVisible: !!(sheetGroup && sheetGroup.visible),
      navMode: nav ? nav.mode() : null,
      navDrag: nav && nav.dragMode ? nav.dragMode() : null,
      navTouches: nav && nav.touchCount ? nav.touchCount() : 0,
      /* the orbit rig's target state — what a drag or a pinch actually moves.
         Reading the camera position instead would be reading the eased
         FOLLOWER, which lags a gesture by a few frames. */
      orbit: nav ? { theta: +nav.st.dst.theta.toFixed(4), phi: +nav.st.dst.phi.toFixed(4),
                     r: +nav.st.dst.r.toFixed(1) } : null,
      fov: camera ? camera.fov : null,
      cameraZ: camera ? +camera.position.z.toFixed(1) : null,
      renderOnDemand: true,
      renderCount, frameCount,
      /* v17 §5b — what the engineer reads back when something is slow */
      contextLost: ctxLost,
      webgl2: !!(renderer && renderer.capabilities && renderer.capabilities.isWebGL2),
      pixelRatio: renderer ? renderer.getPixelRatio() : null,
      anisotropy: renderer ? maxAniso() : null,
      gpuName: (function () {
        try {
          const gl = renderer && renderer.getContext();
          const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
        } catch (e) { return null; }
      })(),
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
    /* v13: the water stage surface (js/water.js owns the spec) and the
       "animate water" switch */
    setWaterStage: spec => { if (scene) setWaterStage(spec); },
    animateWater: on => { if (on === undefined) return animOn; setAnimWater(on); return animOn; },
    /* v15: the 3D label layer, the parity table and the sun */
    setLabels3d, labelsDrawn: () => [...labels3d.values()].map(r => ({ key: r.key, text: r.text,
      visible: r.sprite.visible, priority: r.priority })),
    layersDrawn,
    sun: (az, el) => { if (az === undefined && el === undefined) return { az: sunAz, el: sunEl };
                       setSun(az, el); return { az: sunAz, el: sunEl }; },
    lookAt: startLookAt,
    /* v17 §6 — three introspection hooks the tablet harness needs, and which
       are useful in the console for the same reason: there is otherwise no way
       to ask "what ground is under this screen point" or "where on screen is
       that ground now", which is exactly the question a pinch-toward-a-point
       has to be judged by. */
    worldAt(cx, cy) { return open ? pickWorld({ clientX: cx, clientY: cy }) : null; },
    screenAt(x, y, z) {
      if (!open || !camera || !renderer) return null;
      const v = new THREE.Vector3(x - CX, y - CY, (z - ZMID) * exag());
      v.project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height];
    },
    /* the orbit target in State Plane feet — what a pan actually moves */
    targetXY() { return nav ? [nav.st.targetDst.x + CX, nav.st.targetDst.y + CY] : null; },
    handleScreen(i) {
      if (!open || !SBMM.pick3d || !SBMM.pick3d.handlePos) return null;
      const p = SBMM.pick3d.handlePos(i);
      if (!p || !camera || !renderer) return null;
      const v = new THREE.Vector3(p[0], p[1], p[2]);
      v.project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height];
    },
    requestRender, reflowBar
  };
})();
