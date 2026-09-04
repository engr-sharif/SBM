/* SBMM Site Explorer — context-free compute kernels.

   THIS FILE MUST STAY PURE. No DOM, no Leaflet, no THREE, no SBMM globals — only
   plain functions over typed arrays and JSON-ish parameter objects. That is what
   lets js/jobs.js turn it into a Web Worker with nothing but
   Function.prototype.toString(), which works identically in the folder build and in
   the single-file dist build (build_dist.py inlines this file verbatim, so the
   function source text is the same either way — no fetch(), no external worker file,
   nothing that file:// blocks).

   Everything here is a straight port of the math that used to live inline in
   js/tools.js (volume integration), js/analysis.js (rasters + marching squares) and
   js/dem.js (bilinear sampling, slope/aspect). Results are bit-for-bit the same, and
   because the synchronous fallback path calls these very same functions, the worker
   and no-worker paths can never disagree.

   Grid spec used throughout ("gspec"):
     { x0, y0, cell, w, h,      full-DEM origin/size — bounds + index semantics
       i0, j0, sw, sh,          window of the full grid actually shipped
       z }                      Float32Array(sw*sh), row-major, row 0 = y0 (south-up)
   Shipping a window keeps volume jobs small; i0/j0/sw/sh may cover the whole grid.
*/
"use strict";

var SBMM_COMPUTE = (function SBMMComputeModule() {
  "use strict";

  /* ============================ shared helpers ============================ */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function pointInPoly(x, y, p) {
    var inn = false;
    for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
      var xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inn = !inn;
    }
    return inn;
  }

  function lerpRamp(stops, t) {
    t = clamp(t, 0, 1);
    var n = stops.length - 1, f = t * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
    var a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  function hsl2rgb(h, s, l) {
    var f = function (n) {
      var k = (n + h * 12) % 12;
      return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }

  /* Douglas–Peucker, tolerance in ft (port of util.js simplifyLine) */
  function simplifyLine(pts, tol) {
    if (pts.length < 3) return pts;
    var keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var sp = stack.pop(), i0 = sp[0], i1 = sp[1];
      var a = pts[i0], b = pts[i1];
      var dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
      var dmax = -1, imax = -1;
      for (var i = i0 + 1; i < i1; i++) {
        var d = Math.abs(dx * (a[1] - pts[i][1]) - dy * (a[0] - pts[i][0])) / L;
        if (d > dmax) { dmax = d; imax = i; }
      }
      if (dmax > tol) { keep[imax] = 1; stack.push([i0, imax], [imax, i1]); }
    }
    var out = [];
    for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
    return out;
  }

  /* Douglas-Peucker over a path that may be a CLOSED ring.
     Plain DP anchors on the first and last vertex; when those are the same point —
     which is exactly what a closed marching-squares ring produces, bit for bit,
     because adjacent cells compute the shared edge crossing from the same two
     corner values — the baseline has zero length, every perpendicular distance
     comes out 0, nothing survives the recursion and the whole ring collapses to two
     coincident points. Splitting the ring at its farthest vertex first gives DP two
     well-formed open halves, which is the standard remedy. */
  function simplifyPath(pts, tol) {
    var n = pts.length;
    if (n < 5) return pts;
    var a = pts[0], b = pts[n - 1];
    if (Math.abs(a[0] - b[0]) > 1e-9 || Math.abs(a[1] - b[1]) > 1e-9) return simplifyLine(pts, tol);
    var far = 0, fd = -1;
    for (var i = 1; i < n - 1; i++) {
      var d = (pts[i][0] - a[0]) * (pts[i][0] - a[0]) + (pts[i][1] - a[1]) * (pts[i][1] - a[1]);
      if (d > fd) { fd = d; far = i; }
    }
    if (far < 2 || far > n - 3) return pts;
    var h1 = simplifyLine(pts.slice(0, far + 1), tol);
    var h2 = simplifyLine(pts.slice(far), tol);
    return h1.concat(h2.slice(1));
  }

  /* ======================= grid sampling (mirrors Dem) ==================== */
  function gz(g, i, j) {
    var ii = i - g.i0, jj = j - g.j0;
    if (ii < 0 || jj < 0 || ii >= g.sw || jj >= g.sh) return NaN;
    return g.z[jj * g.sw + ii];
  }
  function gridInside(g, x, y) {
    return x >= g.x0 && y >= g.y0 &&
           x <= g.x0 + (g.w - 1) * g.cell && y <= g.y0 + (g.h - 1) * g.cell;
  }
  /* bilinear — identical to Dem.at(), including its NoData "first valid corner" rule */
  function gridAt(g, x, y) {
    var fx = (x - g.x0) / g.cell, fy = (y - g.y0) / g.cell;
    var i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= g.w - 1 || j >= g.h - 1) return NaN;
    var a = gz(g, i, j), b = gz(g, i + 1, j), c = gz(g, i, j + 1), d = gz(g, i + 1, j + 1);
    if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) {
      var n = [a, b, c, d].filter(function (v) { return !isNaN(v); });
      return n.length ? n[0] : NaN;
    }
    var u = fx - i, v = fy - j;
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }
  /* mirrors SBMM.elev(): try each grid in the order jobs.js shipped them --
     finest first (mine-area 1 ft, residential 1 ft, then site 2 ft) */
  function elevOf(grids, x, y) {
    for (var k = 0; k < grids.length; k++) {
      var g = grids[k];
      if (!gridInside(g, x, y)) continue;
      var z = gridAt(g, x, y);
      if (!isNaN(z)) return z;
    }
    return NaN;
  }
  /* slope (deg) / aspect (deg, 0 = grid north cw) — port of Dem.slopeAspect */
  function slopeAspect(g, i, j) {
    var w = g.w;
    var zc = gz(g, i, j);
    if (isNaN(zc)) return [NaN, NaN];
    var zl = gz(g, Math.max(0, i - 1), j), zr = gz(g, Math.min(w - 1, i + 1), j);
    var zd = gz(g, i, Math.max(0, j - 1)), zu = gz(g, i, Math.min(g.h - 1, j + 1));
    var dzdx = ((isNaN(zr) ? zc : zr) - (isNaN(zl) ? zc : zl)) / (2 * g.cell);
    var dzdy = ((isNaN(zu) ? zc : zu) - (isNaN(zd) ? zc : zd)) / (2 * g.cell);
    var slope = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
    var aspect = Math.atan2(dzdx, dzdy) * 180 / Math.PI;
    if (aspect < 0) aspect += 360;
    return [slope, aspect];
  }

  /* ============================ base surfaces ============================= */
  /* Perimeter TIN with a uniform grid index — the ABP memo Attachment E method.
     The Delaunay triangulation itself is done by the host (d3-delaunay lives in
     vendor/ and is not worth inlining); we receive its `triangles` index array. */
  function tinBase(perim, tri) {
    var n = tri.length / 3;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var q = 0; q < perim.length; q++) {
      var p = perim[q];
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    var G = 32, gw = (x1 - x0) / G || 1, gh = (y1 - y0) / G || 1;
    var cells = new Array(G * G);
    for (var ci = 0; ci < G * G; ci++) cells[ci] = [];
    for (var t = 0; t < n; t++) {
      var a = perim[tri[3 * t]], b = perim[tri[3 * t + 1]], c = perim[tri[3 * t + 2]];
      var T = [a, b, c,
        Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]),
        Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1])];
      var i0 = clamp(Math.floor((T[3] - x0) / gw), 0, G - 1), i1 = clamp(Math.floor((T[5] - x0) / gw), 0, G - 1);
      var j0 = clamp(Math.floor((T[4] - y0) / gh), 0, G - 1), j1 = clamp(Math.floor((T[6] - y0) / gh), 0, G - 1);
      for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) cells[j * G + i].push(T);
    }
    return function (x, y) {
      var gi = clamp(Math.floor((x - x0) / gw), 0, G - 1), gj = clamp(Math.floor((y - y0) / gh), 0, G - 1);
      var bucket = cells[gj * G + gi];
      for (var k = 0; k < bucket.length; k++) {
        var T = bucket[k];
        if (x < T[3] || x > T[5] || y < T[4] || y > T[6]) continue;
        var a = T[0], b = T[1], c = T[2];
        var d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(d) < 1e-9) continue;
        var w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
        var w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
        var w3 = 1 - w1 - w2;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
        return w1 * a[2] + w2 * b[2] + w3 * c[2];
      }
      var best = 1e30, bz = NaN;   // outside hull: nearest perimeter sample
      for (var q2 = 0; q2 < perim.length; q2++) {
        var pp = perim[q2], dd = (pp[0] - x) * (pp[0] - x) + (pp[1] - y) * (pp[1] - y);
        if (dd < best) { best = dd; bz = pp[2]; }
      }
      return bz;
    };
  }

  function planeBase(perim) {
    var sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, n = perim.length;
    var x0 = perim[0][0], y0 = perim[0][1];
    for (var k = 0; k < perim.length; k++) {
      var p = perim[k], x = p[0] - x0, y = p[1] - y0, z = p[2];
      sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
    }
    var det = (sxx * (syy * n - sy * sy) - sxy * (sxy * n - sx * sy) + sx * (sxy * sy - syy * sx)) || 1e-9;
    var A = (sxz * (syy * n - sy * sy) - sxy * (syz * n - sy * sz) + sx * (syz * sy - syy * sz)) / det;
    var B = (sxx * (syz * n - sy * sz) - sxz * (sxy * n - sx * sy) + sx * (sxy * sz - syz * sx)) / det;
    var C = (sxx * (syy * sz - sy * syz) - sxy * (sxy * sz - sx * syz) + sxz * (sxy * sy - syy * sx)) / det;
    return function (x, y) { return A * (x - x0) + B * (y - y0) + C; };
  }

  /* ---- design-surface raster ("dgrid") -------------------------------------
     A named design surface rasterised to its own regular grid, NODE-based:
     node (i,j) sits exactly at (x0 + i*cell, y0 + j*cell). Sampling is bilinear
     and returns NaN outside the raster, which every consumer treats as "this
     design surface does not cover that cell" rather than as an elevation.      */
  function dgridAt(d, x, y) {
    var fx = (x - d.x0) / d.cell, fy = (y - d.y0) / d.cell;
    var i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= d.nx - 1 || j >= d.ny - 1) return NaN;
    var a = d.z[j * d.nx + i], b = d.z[j * d.nx + i + 1],
        c = d.z[(j + 1) * d.nx + i], e = d.z[(j + 1) * d.nx + i + 1];
    if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(e)) return NaN;
    var u = fx - i, v = fy - j;
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + e * u * v;
  }

  /* ========================= 1. volume integration ======================== */
  /* job: { poly: Float64Array(2n), perim: Float64Array(3m), tri: Uint32Array|null,
            baseMode: "tin"|"plane"|"fixed"|"lowest"|"design", fixedZ: Number,
            dgrid: {x0,y0,cell,nx,ny,z} (baseMode "design" only),
            step, bx0, by0, nx, ny, grids: [gspec, ...] }                      */
  function volumeGrid(job, onProgress) {
    var pts = [], i;
    for (i = 0; i < job.poly.length; i += 2) pts.push([job.poly[i], job.poly[i + 1]]);
    var perim = [];
    for (i = 0; i < job.perim.length; i += 3) perim.push([job.perim[i], job.perim[i + 1], job.perim[i + 2]]);

    var base;
    if (job.baseMode === "tin") base = tinBase(perim, job.tri);
    else if (job.baseMode === "plane") base = planeBase(perim);
    else if (job.baseMode === "design") {
      var dg = job.dgrid;
      base = function (x, y) { return dgridAt(dg, x, y); };
    }
    else { var fz = job.fixedZ; base = function () { return fz; }; }

    var grids = job.grids, step = job.step, nx = job.nx, ny = job.ny,
        bx0 = job.bx0, by0 = job.by0;
    var hGrid = new Float32Array(nx * ny); hGrid.fill(NaN);
    var fill = 0, cut = 0, n = 0, hmax = 0, hmin = 0, hsum = 0, zmin = 1e9, zmax = -1e9;
    var cellA = step * step;

    for (var jy = 0; jy < ny; jy++) {
      var y = by0 + step / 2 + jy * step;
      for (var ix = 0; ix < nx; ix++) {
        var x = bx0 + step / 2 + ix * step;
        if (!pointInPoly(x, y, pts)) continue;
        var z = elevOf(grids, x, y); if (isNaN(z)) continue;
        var b = base(x, y); if (isNaN(b)) continue;
        var h = z - b;
        hGrid[jy * nx + ix] = h;
        if (h > 0) { fill += h * cellA; hsum += h; if (h > hmax) hmax = h; }
        else { cut += -h * cellA; if (h < hmin) hmin = h; }
        if (z < zmin) zmin = z; if (z > zmax) zmax = z; n++;
      }
      if (onProgress && (jy & 31) === 31) onProgress((jy + 1) / ny);
    }
    return {
      result: { fill: fill, cut: cut, n: n, hmax: hmax, hmin: hmin, hsum: hsum,
                zmin: zmin, zmax: zmax, hGrid: hGrid, nx: nx, ny: ny },
      transfer: [hGrid.buffer]
    };
  }

  /* ---------------------- 1b. isopach (design − ground) -------------------
     The cut/fill thickness map of §5. `dgrid` is the design surface as a raster
     window (a user pad's node grid, or a §5 reference surface's own 1-ft
     raster); `grids` are the DEM windows underneath it. The sign convention is
     the one an earthworks drawing uses: design ABOVE ground is FILL (positive),
     design BELOW ground is CUT (negative), so the number under the cursor reads
     the same way as the legend.

     Decimation is by cell budget rather than by a fixed step, because the four
     delivered surfaces differ by 20x in area: eg_ea is 13.4 Mpx and
     res_excbottom 6.0 Mpx, and a fixed step would make one of them a postage
     stamp or the other a stall.                                              */
  /* ---- the comparison tolerance (planner ruling F9) ------------------------
     Two rasters never agree exactly, and the differences that are NOT the
     design are worth naming, because before this they were reported as fill:

       * QUANTISATION. Both surfaces are terrain-RGB PNGs on a 0.02 ft step,
         and both are sampled bilinearly between quantised nodes. Nothing
         below the sum of the two steps is a real elevation difference.
       * GRID RESOLUTION. `res_excbottom` is a 1 ft raster built from the 1 ft
         lidar master, but the app only carries 1 ft DEM inside the mine
         window; south and west of it the ground is the 2 ft site grid, which
         is a genuinely different surface on a slope. A 2 ft grid interpolated
         to a 1 ft query cannot resolve better than its own gradient times the
         resolution it is missing, so that is exactly the allowance made — and
         it is ZERO wherever the ground grid is already as fine as the design,
         which is most of the site.

     The allowance is `2 * |grad z| * (groundCell - designCell)`; the factor of
     two is the worst-case half-cell offset in each axis. It cannot eat real
     excavation: a 1 ft design cut would need a 50 % ground slope before the
     allowance reached even a quarter of it. */
  function isoTol(job, grids, x, y, dcell) {
    var q = (job.zstepDesign || 0) + (job.zstepGround || 0);
    var gc = groundCell(grids, x, y);
    if (!(gc > dcell)) return q;
    var e = elevOf(grids, x + gc, y), w = elevOf(grids, x - gc, y),
        n = elevOf(grids, x, y + gc), s = elevOf(grids, x, y - gc);
    if (e !== e || w !== w || n !== n || s !== s) return q;
    var gx = (e - w) / (2 * gc), gy = (n - s) / (2 * gc);
    return q + 2 * Math.sqrt(gx * gx + gy * gy) * (gc - dcell);
  }
  /* cell size of the FINEST grid that actually covers this point — gridsFor()
     ships them finest-first, which is also what elevOf relies on */
  function groundCell(grids, x, y) {
    for (var k = 0; k < grids.length; k++) {
      var g = grids[k];
      if (!gridInside(g, x, y)) continue;
      if (!isNaN(gridAt(g, x, y))) return g.cell;
    }
    return grids.length ? grids[grids.length - 1].cell : 1;
  }

  function isopachGrid(job, onProgress) {
    var d = job.dgrid, grids = job.grids;
    /* pointInPoly takes [[x,y],...]; the job ships the ring flat so its buffer
       can be transferred rather than copied */
    var poly = null, i;
    if (job.nPoly) {
      poly = [];
      for (i = 0; i < job.poly.length; i += 2) poly.push([job.poly[i], job.poly[i + 1]]);
    }
    var nPoly = poly ? poly.length : 0;
    var nx = d.nx, ny = d.ny, cell = d.cell, x0 = d.x0, y0 = d.y0;

    /* Two resolutions, deliberately.

       The VOLUMES are integrated at the surface's own cell size, up to a cap —
       they are the number someone digs from, and decimating the integral costs
       about 1 % against the build-time validation of res_excbottom.

       The PICTURE is decimated to a display budget, because a 13-megapixel
       overlay is a 50 MB data-URL for a heat map nobody can read at that
       density. `cell` in the result is the display cell; `intCell` is what the
       volumes were integrated at, and the card reports both. */
    var iStep = 1;
    while ((nx / iStep) * (ny / iStep) > (job.maxIntCells || 8000000)) iStep *= 2;
    var step = iStep;
    while ((nx / step) * (ny / step) > (job.maxCells || 700000)) step *= 2;

    var ox = Math.max(1, Math.floor(nx / step)), oy = Math.max(1, Math.floor(ny / step));
    var ocell = cell * step, icell = cell * iStep;
    var dz = new Float32Array(ox * oy);
    dz.fill(NaN);
    var cut = 0, fill = 0, n = 0, nChanged = 0, nEdge = 0, lo = Infinity, hi = -Infinity;
    var cellA = icell * icell;
    var every = step / iStep;                  // display sample every Nth integration cell
    /* bbox of the cells that actually differ — "compared over 15 ac" says
       nothing when 10 of those acres are a working buffer in which the design
       IS the ground by definition (F9) */
    var cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;

    var rows = Math.floor(ny / iStep);
    for (var jr = 0; jr < rows; jr++) {
      var jj = jr * iStep;
      var Y = y0 + jj * cell;
      var dj = (jr % every === 0) ? jr / every : -1;
      for (var ir = 0, cols = Math.floor(nx / iStep); ir < cols; ir++) {
        var ii = ir * iStep;
        var zd = d.z[jj * nx + ii];
        if (zd !== zd) continue;
        /* A cell whose 3x3 design neighbourhood touches nodata sits on the
           raster's own boundary, where the interpolation has nothing on one
           side to interpolate from. Those cells produced the isolated 1.37 ft
           "deepest fill" spike at the surface's south-west corner. */
        if (isoEdge(d, ii, jj, iStep)) { nEdge++; continue; }
        var X = x0 + ii * cell;
        if (nPoly && !pointInPoly(X, Y, poly)) continue;
        var zg = elevOf(grids, X, Y);
        if (zg !== zg) continue;
        var v = zd - zg;
        n++;
        if (Math.abs(v) <= isoTol(job, grids, X, Y, cell)) v = 0;
        if (v !== 0) {
          nChanged++;
          if (X < cx0) cx0 = X; if (X > cx1) cx1 = X;
          if (Y < cy0) cy0 = Y; if (Y > cy1) cy1 = Y;
          if (v > 0) fill += v * cellA; else cut += -v * cellA;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (dj >= 0 && ir % every === 0 && dj < oy) {
          var di = ir / every;
          /* a cell inside the tolerance is drawn as "no change", not as a
             faint blue smear over ten acres of untouched ground */
          if (di < ox) dz[dj * ox + di] = v === 0 ? NaN : v;
        }
      }
      if (onProgress && (jr & 31) === 31) onProgress((jr + 1) / rows);
    }
    return {
      result: { dz: dz, nx: ox, ny: oy, cell: ocell, x0: x0, y0: y0,
                step: step, intCell: icell,
                cut_ft3: cut, fill_ft3: fill, n: n,
                nChanged: nChanged, nEdge: nEdge,
                changedBox: nChanged ? [cx0, cy0, cx1, cy1] : null,
                lo: nChanged ? Math.min(lo, 0) : 0, hi: nChanged ? Math.max(hi, 0) : 0 },
      transfer: [dz.buffer]
    };
  }
  /* true when any node of the 3x3 neighbourhood (at the integration stride) is
     nodata, or when the neighbourhood runs off the raster entirely */
  function isoEdge(d, ii, jj, s) {
    if (ii - s < 0 || jj - s < 0 || ii + s >= d.nx || jj + s >= d.ny) return true;
    for (var dj = -s; dj <= s; dj += s)
      for (var di = -s; di <= s; di += s) {
        var z = d.z[(jj + dj) * d.nx + (ii + di)];
        if (z !== z) return true;
      }
    return false;
  }

  /* ====================== 2. analysis / drape rasters ===================== */
  /* job: { grid: gspec, stride, alpha, kind: "slope"|"aspect"|"hypso"|"canopy",
            ramp: [[r,g,b],...], zlo, zhi, nanColor: [r,g,b]|null }
     Returns RGBA rows north-first (canvas order), exactly like the old demRaster(). */
  function demRasterRGBA(job, onProgress) {
    var g = job.grid, s = job.stride || 1, alpha = job.alpha, kind = job.kind;
    /* the raster covers the WINDOW the spec ships (i0/j0/sw/sh), which is the
       whole grid when the caller passed no bbox. gz() takes full-grid indices,
       so the sweep runs over window cells and offsets them by i0/j0; a raster
       that sized itself from g.w/g.h would read NaN everywhere outside the
       window and paint the wrong place with no error. */
    var W = Math.floor((g.sw - 1) / s) + 1, H = Math.floor((g.sh - 1) / s) + 1;
    var px = new Uint8ClampedArray(W * H * 4);
    var ramp = job.ramp, nanColor = job.nanColor || null;
    var zlo = job.zlo, zhi = job.zhi, span = Math.max(1e-9, zhi - zlo);

    for (var j = 0; j < H; j++) {
      var outRow = H - 1 - j;                 // canvas row 0 = north
      var gj = g.j0 + Math.min(g.sh - 1, j * s);
      for (var i = 0; i < W; i++) {
        var k = (outRow * W + i) * 4;
        var gi = g.i0 + Math.min(g.sw - 1, i * s);
        var rgb = null;
        if (kind === "slope") {
          var sa = slopeAspect(g, gi, gj);
          rgb = isNaN(sa[0]) ? nanColor : lerpRamp(ramp, sa[0] / 45).map(Math.round);
        } else if (kind === "aspect") {
          var sa2 = slopeAspect(g, gi, gj);
          rgb = (isNaN(sa2[1]) || sa2[0] < 0.5) ? [110, 116, 121] : hsl2rgb(sa2[1] / 360, .55, .55);
        } else if (kind === "hypso") {
          var z = gz(g, gi, gj);
          rgb = isNaN(z) ? nanColor : lerpRamp(ramp, (z - zlo) / span).map(Math.round);
        } else {                              // canopy height model
          var hh = gz(g, gi, gj);
          rgb = (isNaN(hh) || hh <= 2) ? null : lerpRamp(ramp, hh / 100).map(Math.round);
        }
        if (!rgb) { px[k + 3] = 0; continue; }
        px[k] = rgb[0]; px[k + 1] = rgb[1]; px[k + 2] = rgb[2]; px[k + 3] = alpha;
      }
      if (onProgress && (j & 127) === 127) onProgress((j + 1) / H);
    }
    return { result: { rgba: px, W: W, H: H }, transfer: [px.buffer] };
  }

  /* ==================== 3. marching-squares contours ====================== */
  var frac = function (a, b, lv) { return Math.abs(b - a) < 1e-12 ? .5 : clamp((lv - a) / (b - a), 0, 1); };

  /* job: { grid: gspec, interval, stride, maxPts }
     Returns flat arrays (levels + offsets + coords) — much cheaper to structured-clone
     than a few hundred thousand two-element arrays. */
  function contoursFromGrid(job, onProgress) {
    var g = job.grid, interval = job.interval, s = job.stride;
    /* z is the WINDOW's array (sw x sh, row-major), so the sweep runs over the
       window and its origin is the window's south-west corner. For a whole-grid
       spec i0 = j0 = 0 and sw/sh = w/h, and nothing here changes. */
    var w = g.sw, h = g.sh, z = g.z, cell = g.cell;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var maxPts = job.maxPts || 500000;
    /* A polyline shorter than a tenth of a sweep cell is a STUB: two crossings
       of one cell that almost coincide, whose ends round into different 0.1-ft
       chaining keys from their neighbours' and so never join the ring they
       belong to. It draws as nothing on the map and is a junk entity in a DXF
       (43 of them, all under 0.1 ft, on the 10-ft site set). The floor is a
       tenth of a cell so that a real corner clip a few feet long survives. */
    var stubFt = cell * s * 0.1;
    var lo = Infinity, hi = -Infinity;
    for (var k = 0; k < z.length; k += 7) { var v = z[k]; if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }

    var levels = [], offsets = [0], coords = [];
    var totalPts = 0, truncated = false;
    var lv0 = Math.ceil(lo / interval) * interval;
    var nLev = Math.max(1, Math.floor((hi - lv0) / interval) + 1), levDone = 0;

    outer:
    for (var lv = lv0; lv <= hi; lv += interval) {
      var segs = new Map();
      var segList = [];
      for (var j = 0; j + s < h; j += s) {
        for (var i = 0; i + s < w; i += s) {
          var za = z[j * w + i], zb = z[j * w + i + s], zc = z[(j + s) * w + i + s], zd = z[(j + s) * w + i];
          if (isNaN(za) || isNaN(zb) || isNaN(zc) || isNaN(zd)) continue;
          var idx = 0;
          if (za >= lv) idx |= 1; if (zb >= lv) idx |= 2; if (zc >= lv) idx |= 4; if (zd >= lv) idx |= 8;
          if (idx === 0 || idx === 15) continue;
          var X = i * cell + X0, Y = j * cell + Y0, C = s * cell;
          var bot = [X + C * frac(za, zb, lv), Y], right = [X + C, Y + C * frac(zb, zc, lv)],
              top = [X + C * frac(zd, zc, lv), Y + C], left = [X, Y + C * frac(za, zd, lv)];
          switch (idx) {
            case 1: case 14: segList.push([left, bot]); break;
            case 2: case 13: segList.push([bot, right]); break;
            case 3: case 12: segList.push([left, right]); break;
            case 4: case 11: segList.push([right, top]); break;
            case 6: case 9: segList.push([bot, top]); break;
            case 7: case 8: segList.push([left, top]); break;
            case 5: segList.push([left, bot]); segList.push([right, top]); break;
            case 10: segList.push([bot, right]); segList.push([left, top]); break;
          }
        }
      }
      var key = function (p) { return (Math.round(p[0] * 10) + "," + Math.round(p[1] * 10)); };
      var e, a, b;
      for (e = 0; e < segList.length; e++) {
        a = segList[e][0]; b = segList[e][1];
        var ka = key(a), kb = key(b);
        if (!segs.has(ka)) segs.set(ka, []);
        if (!segs.has(kb)) segs.set(kb, []);
        segs.get(ka).push([a, b]); segs.get(kb).push([b, a]);
      }
      var used = new Set();
      for (e = 0; e < segList.length; e++) {
        var a0 = segList[e][0], b0 = segList[e][1];
        var id0 = key(a0) + "|" + key(b0);
        if (used.has(id0)) continue;
        var line = [a0, b0]; used.add(id0); used.add(key(b0) + "|" + key(a0));
        var guard = 0;
        var dirs = [1, 0];
        for (var di = 0; di < 2; di++) {
          var dirEnd = dirs[di];
          while (guard++ < 100000) {
            var end = dirEnd ? line[line.length - 1] : line[0];
            var pool = segs.get(key(end)) || [];
            var cand = null;
            for (var ci = 0; ci < pool.length; ci++) {
              if (!used.has(key(pool[ci][0]) + "|" + key(pool[ci][1]))) { cand = pool[ci]; break; }
            }
            if (!cand) break;
            used.add(key(cand[0]) + "|" + key(cand[1]));
            used.add(key(cand[1]) + "|" + key(cand[0]));
            if (dirEnd) line.push(cand[1]); else line.unshift(cand[1]);
          }
        }
        if (line.length >= 3) line = simplifyPath(line, cell * s * 0.3);
        var lineLen = 0;
        for (var ql = 1; ql < line.length; ql++)
          lineLen += Math.hypot(line[ql][0] - line[ql - 1][0], line[ql][1] - line[ql - 1][1]);
        if (line.length >= 2 && lineLen >= stubFt) {
          levels.push(lv);
          for (var q = 0; q < line.length; q++) { coords.push(line[q][0]); coords.push(line[q][1]); }
          offsets.push(coords.length / 2);
          totalPts += line.length;
        }
        if (totalPts > maxPts) { truncated = true; break outer; }
      }
      levDone++;
      if (onProgress) onProgress(Math.min(1, levDone / nLev));
    }
    var out = {
      levels: new Float64Array(levels),
      offsets: new Uint32Array(offsets),
      coords: new Float64Array(coords),
      truncated: truncated
    };
    return { result: out, transfer: [out.levels.buffer, out.offsets.buffer, out.coords.buffer] };
  }

  /* ==================== 4. design surfaces (grading) ====================== */
  /* A graded pad is defined by four things: a footprint polygon, a pad elevation
     (flat, or a plane at a typed grade and direction), a side-slope ratio H:V, and
     which way the slopes run — OUTWARD from the pad edge until they daylight into
     existing ground, or INWARD as a batter contained by the footprint.

     The whole surface is rasterised to a node grid. For every node we need the same
     four terrain-derived quantities no matter what pad elevation we later try:
     the ground elevation, the distance to the footprint boundary, whether the node
     is inside it, and the ground elevation at the nearest boundary point. Those are
     expensive (a full segment sweep per node) and completely independent of the pad
     elevation — so preparePad() computes them ONCE and evalPad() then re-solves the
     surface for any trial elevation in a single cheap pass. That is what makes the
     balance bisection affordable: 30 iterations cost one segment sweep, not 30.     */

  /* nearest point on the footprint + inside test, in one sweep over the segments */
  function polyNearest(x, y, sx, sy, n) {
    var best = 1e30, bx = 0, by = 0, inn = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = sx[i], yi = sy[i], xj = sx[j], yj = sy[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inn = !inn;
      var dx = xj - xi, dy = yj - yi;
      var L2 = dx * dx + dy * dy;
      var t = L2 > 0 ? ((x - xi) * dx + (y - yi) * dy) / L2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var px = xi + t * dx, py = yi + t * dy;
      var d2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (d2 < best) { best = d2; bx = px; by = py; }
    }
    return [Math.sqrt(best), bx, by, inn];
  }

  /* the pad plane's offset from its nominal elevation at (x,y) — 0 for a flat pad */
  function planeOffset(job, x, y) {
    if (job.kind !== "plane") return 0;
    var g = (job.gradePct || 0) / 100;
    var a = (job.gradeDirDeg || 0) * Math.PI / 180;
    return ((x - job.anchorX) * Math.cos(a) + (y - job.anchorY) * Math.sin(a)) * g;
  }

  /* terrain-derived, pad-elevation-independent node arrays */
  function preparePad(job, onProgress) {
    var nx = job.nx, ny = job.ny, cell = job.cell, x0 = job.x0, y0 = job.y0;
    var grids = job.grids, N = nx * ny;
    var sx = new Float64Array(job.poly.length / 2), sy = new Float64Array(job.poly.length / 2);
    for (var q = 0; q < sx.length; q++) { sx[q] = job.poly[q * 2]; sy[q] = job.poly[q * 2 + 1]; }
    var np = sx.length;

    var G = new Float32Array(N), D = new Float32Array(N), EG = new Float32Array(N);
    var IN = new Uint8Array(N), PO = new Float32Array(N), PEO = new Float32Array(N);
    for (var j = 0; j < ny; j++) {
      var y = y0 + j * cell;
      for (var i = 0; i < nx; i++) {
        var k = j * nx + i, x = x0 + i * cell;
        G[k] = elevOf(grids, x, y);
        var nr = polyNearest(x, y, sx, sy, np);
        D[k] = nr[0]; IN[k] = nr[3] ? 1 : 0;
        EG[k] = elevOf(grids, nr[1], nr[2]);
        PO[k] = planeOffset(job, x, y);
        PEO[k] = planeOffset(job, nr[1], nr[2]);
      }
      if (onProgress && (j & 15) === 15) onProgress(0.75 * (j + 1) / ny);
    }
    return { G: G, D: D, EG: EG, IN: IN, PO: PO, PEO: PEO, nx: nx, ny: ny, cell: cell,
             x0: x0, y0: y0, N: N };
  }

  /* Solve the design surface for one trial pad elevation.
     out (optional) receives the design elevation per node; the return value carries
     the earthwork quantities of design-vs-ground over the whole raster:
       cut  = terrain ABOVE design  (material to remove)
       fill = design ABOVE terrain  (material to place)                            */
  function evalPad(pre, job, padZ, out) {
    var N = pre.N, ratio = job.ratio > 0 ? job.ratio : 3, inward = job.side === "in";
    var existing = job.kind === "existing";
    var A = pre.cell * pre.cell;
    var cut = 0, fill = 0, n = 0, zmin = 1e30, zmax = -1e30;
    for (var k = 0; k < N; k++) {
      var g = pre.G[k];
      if (isNaN(g)) { if (out) out[k] = NaN; continue; }
      var z;
      if (existing) z = g;
      else if (!inward) {
        if (pre.IN[k]) z = padZ + pre.PO[k];
        else {
          var eZ = padZ + pre.PEO[k], d = pre.D[k], eg = pre.EG[k];
          if (isNaN(eg)) eg = g;
          /* pad edge below ground -> the slope climbs outward until it daylights;
             pad edge above ground -> it descends. Clipping to ground is what makes
             the daylight line emerge instead of having to be searched for. */
          if (eg >= eZ) { z = eZ + d / ratio; if (z > g) z = g; }
          else { z = eZ - d / ratio; if (z < g) z = g; }
        }
      } else {
        if (!pre.IN[k]) z = g;
        else {
          var pz = padZ + pre.PO[k], eg2 = pre.EG[k], d2 = pre.D[k];
          if (isNaN(eg2)) eg2 = g;
          if (eg2 >= pz) { z = eg2 - d2 / ratio; if (z < pz) z = pz; }
          else { z = eg2 + d2 / ratio; if (z > pz) z = pz; }
        }
      }
      if (out) out[k] = z;
      var h = g - z;
      if (h > 0) cut += h * A; else fill += -h * A;
      if (z < zmin) zmin = z; if (z > zmax) zmax = z;
      n++;
    }
    return { cut: cut, fill: fill, n: n, zmin: zmin, zmax: zmax };
  }

  /* marching squares at ONE level over a plain node array — used for the daylight
     line (|design − ground| at a small tolerance) and the design contour preview.
     Deliberately separate from contoursFromGrid(), whose validated behaviour over
     the terrain DEM is not worth risking for a bit of shared code. */
  function marchOne(z, nx, ny, cell, x0, y0, lv) {
    var segList = [];
    for (var j = 0; j + 1 < ny; j++) {
      for (var i = 0; i + 1 < nx; i++) {
        var za = z[j * nx + i], zb = z[j * nx + i + 1],
            zc = z[(j + 1) * nx + i + 1], zd = z[(j + 1) * nx + i];
        if (isNaN(za) || isNaN(zb) || isNaN(zc) || isNaN(zd)) continue;
        var idx = 0;
        if (za >= lv) idx |= 1; if (zb >= lv) idx |= 2; if (zc >= lv) idx |= 4; if (zd >= lv) idx |= 8;
        if (idx === 0 || idx === 15) continue;
        var X = x0 + i * cell, Y = y0 + j * cell, C = cell;
        var bot = [X + C * frac(za, zb, lv), Y], right = [X + C, Y + C * frac(zb, zc, lv)],
            top = [X + C * frac(zd, zc, lv), Y + C], left = [X, Y + C * frac(za, zd, lv)];
        switch (idx) {
          case 1: case 14: segList.push([left, bot]); break;
          case 2: case 13: segList.push([bot, right]); break;
          case 3: case 12: segList.push([left, right]); break;
          case 4: case 11: segList.push([right, top]); break;
          case 6: case 9: segList.push([bot, top]); break;
          case 7: case 8: segList.push([left, top]); break;
          case 5: segList.push([left, bot]); segList.push([right, top]); break;
          case 10: segList.push([bot, right]); segList.push([left, top]); break;
        }
      }
    }
    var key = function (p) { return Math.round(p[0] * 10) + "," + Math.round(p[1] * 10); };
    var segs = new Map(), e, a, b;
    for (e = 0; e < segList.length; e++) {
      a = segList[e][0]; b = segList[e][1];
      var ka = key(a), kb = key(b);
      if (!segs.has(ka)) segs.set(ka, []);
      if (!segs.has(kb)) segs.set(kb, []);
      segs.get(ka).push([a, b]); segs.get(kb).push([b, a]);
    }
    var used = new Set(), lines = [];
    for (e = 0; e < segList.length; e++) {
      var a0 = segList[e][0], b0 = segList[e][1];
      if (used.has(key(a0) + "|" + key(b0))) continue;
      var line = [a0, b0];
      used.add(key(a0) + "|" + key(b0)); used.add(key(b0) + "|" + key(a0));
      var guard = 0, dirs = [1, 0];
      for (var di = 0; di < 2; di++) {
        while (guard++ < 200000) {
          var end = dirs[di] ? line[line.length - 1] : line[0];
          var pool = segs.get(key(end)) || [], cand = null;
          for (var ci = 0; ci < pool.length; ci++)
            if (!used.has(key(pool[ci][0]) + "|" + key(pool[ci][1]))) { cand = pool[ci]; break; }
          if (!cand) break;
          used.add(key(cand[0]) + "|" + key(cand[1]));
          used.add(key(cand[1]) + "|" + key(cand[0]));
          if (dirs[di]) line.push(cand[1]); else line.unshift(cand[1]);
        }
      }
      if (line.length >= 3) line = simplifyPath(line, cell * 0.35);
      if (line.length >= 3) lines.push(line);
    }
    return lines;
  }
  function ringArea(l) {
    var a = 0;
    for (var i = 0; i < l.length; i++) {
      var p = l[i], q = l[(i + 1) % l.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  function packLines(lines) {
    var offsets = [0], coords = [];
    for (var i = 0; i < lines.length; i++) {
      for (var k = 0; k < lines[i].length; k++) { coords.push(lines[i][k][0]); coords.push(lines[i][k][1]); }
      offsets.push(coords.length / 2);
    }
    return { offsets: new Uint32Array(offsets), coords: new Float64Array(coords) };
  }

  /* job: { poly, kind:"pad"|"plane"|"existing", padZ, gradePct, gradeDirDeg,
           anchorX, anchorY, ratio, side:"out"|"in",
           x0, y0, cell, nx, ny, grids, contourInterval }                        */
  function designGrid(job, onProgress) {
    var pre = preparePad(job, onProgress);
    var z = new Float32Array(pre.N);
    var q = evalPad(pre, job, job.padZ, z);
    if (onProgress) onProgress(0.85);

    /* daylight line: where the design stops differing from existing ground.
       Contouring |design − ground| at a small tolerance gives a closed loop around
       everything that was actually graded — the tolerance matters because outside
       the daylight line the two surfaces are identical, so a level of exactly 0
       would find no crossing at all. */
    var diff = new Float32Array(pre.N);
    for (var k = 0; k < pre.N; k++) {
      var g = pre.G[k], d = z[k];
      diff[k] = (isNaN(g) || isNaN(d)) ? NaN : Math.abs(d - g);
    }
    var dl = job.kind === "existing" ? [] :
      marchOne(diff, pre.nx, pre.ny, pre.cell, pre.x0, pre.y0, 0.1);
    /* Rough ground makes the design graze existing grade in dozens of places, so the
       raw contour comes back as one real limit-of-work plus a scatter of specks a
       few cells across. Those are below the resolution the surface is meaningful at
       and drafting them would be noise, so anything under 100 ft² is dropped and the
       rest are ordered largest first — the main daylight line is then always dl[0]. */
    var dropped = 0;
    if (dl.length) {
      var minA = Math.max(100, 25 * pre.cell * pre.cell);
      var kept = [];
      for (var q0 = 0; q0 < dl.length; q0++) {
        if (ringArea(dl[q0]) >= minA) kept.push(dl[q0]); else dropped++;
      }
      kept.sort(function (a, b) { return ringArea(b) - ringArea(a); });
      dl = kept;
    }
    if (onProgress) onProgress(0.93);

    /* cheap design contours for the map preview */
    var ci = job.contourInterval || 0;
    var cont = [], clev = [];
    if (ci > 0 && isFinite(q.zmin) && isFinite(q.zmax)) {
      var lv0 = Math.ceil(q.zmin / ci) * ci;
      for (var lv = lv0; lv <= q.zmax; lv += ci) {
        var ls = marchOne(z, pre.nx, pre.ny, pre.cell, pre.x0, pre.y0, lv);
        for (var m = 0; m < ls.length; m++) { cont.push(ls[m]); clev.push(lv); }
        if (cont.length > 4000) break;
      }
    }
    var dlP = packLines(dl), cP = packLines(cont);
    var out = {
      z: z, nx: pre.nx, ny: pre.ny, cell: pre.cell, x0: pre.x0, y0: pre.y0,
      zmin: q.zmin, zmax: q.zmax, cut: q.cut, fill: q.fill, n: q.n,
      dlOffsets: dlP.offsets, dlCoords: dlP.coords, dlDropped: dropped,
      cOffsets: cP.offsets, cCoords: cP.coords, cLevels: new Float64Array(clev)
    };
    if (onProgress) onProgress(1);
    return { result: out, transfer: [z.buffer, dlP.offsets.buffer, dlP.coords.buffer,
                                     cP.offsets.buffer, cP.coords.buffer, out.cLevels.buffer] };
  }

  /* Solve the pad elevation that balances earthwork.
     net(Z) = fill(Z) − cut(Z) is monotonically increasing in Z (raising the pad can
     only add fill and remove cut), so plain bisection is both sound and quick. The
     whole search runs inside ONE job: the expensive part (preparePad) is shared by
     every iteration, and re-shipping the DEM window per iteration would cost more
     than the arithmetic it saved.
     job: designGrid's job + { targetNet_ft3, zLo, zHi, iters }                   */
  function balancePad(job, onProgress) {
    var pre = preparePad(job, onProgress);
    var target = job.targetNet_ft3 || 0;
    var lo = job.zLo, hi = job.zHi, iters = job.iters || 34;
    var fLo = evalPad(pre, job, lo, null), fHi = evalPad(pre, job, hi, null);
    var netLo = fLo.fill - fLo.cut, netHi = fHi.fill - fHi.cut;
    var history = [];
    var mid = (lo + hi) / 2, best = null;
    /* the bracket has to contain the target, or bisection is meaningless */
    if (!(netLo <= target && target <= netHi)) {
      return { result: { ok: false, netLo: netLo, netHi: netHi, zLo: lo, zHi: hi,
                         reason: "the target is outside what this footprint can reach" } };
    }
    for (var it = 0; it < iters; it++) {
      mid = (lo + hi) / 2;
      var f = evalPad(pre, job, mid, null);
      var net = f.fill - f.cut;
      best = { z: mid, cut: f.cut, fill: f.fill, net: net, n: f.n };
      history.push([mid, net]);
      if (net < target) lo = mid; else hi = mid;
      if (hi - lo < 0.005) break;
      if (onProgress) onProgress(0.75 + 0.25 * (it + 1) / iters);
    }
    var hist = new Float64Array(history.length * 2);
    for (var i = 0; i < history.length; i++) { hist[i * 2] = history[i][0]; hist[i * 2 + 1] = history[i][1]; }
    if (onProgress) onProgress(1);
    return { result: { ok: true, z: best.z, cut: best.cut, fill: best.fill, net: best.net,
                       n: best.n, iters: history.length, history: hist, target: target },
             transfer: [hist.buffer] };
  }

  /* ========================= 5. cross-sections ============================ */
  /* Perpendicular sections at a station interval along an alignment polyline.
     job: { align: Float64Array(2n), interval, width, offStep, grids,
            chm: [gspec]|null, dgrid: {…}|null }
     Every section shares one offset axis (−width/2 … +width/2), so the samples come
     back as flat ns×no arrays — one structured clone instead of a few hundred.    */
  function sectionsSample(job, onProgress) {
    var a = [], i;
    for (i = 0; i < job.align.length; i += 2) a.push([job.align[i], job.align[i + 1]]);
    var segLen = [], total = 0;
    for (i = 1; i < a.length; i++) {
      var d = Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]);
      segLen.push(d); total += d;
    }
    var interval = job.interval > 0 ? job.interval : 50;
    var half = (job.width > 0 ? job.width : 200) / 2;
    var offStep = job.offStep > 0 ? job.offStep : 2;
    var no = Math.floor(2 * half / offStep) + 1;
    var ns = Math.floor(total / interval) + 1;

    var sta = new Float64Array(ns), cx = new Float64Array(ns), cy = new Float64Array(ns);
    var dx_ = new Float64Array(ns), dy_ = new Float64Array(ns);
    var ground = new Float32Array(ns * no);
    var design = job.dgrid ? new Float32Array(ns * no) : null;
    var canopy = (job.chm && job.chm.length) ? new Float32Array(ns * no) : null;

    for (var s = 0; s < ns; s++) {
      var want = s * interval, acc = 0, si = 0;
      while (si < segLen.length - 1 && acc + segLen[si] < want) { acc += segLen[si]; si++; }
      var t = segLen[si] > 0 ? (want - acc) / segLen[si] : 0;
      if (t > 1) t = 1;
      var p0 = a[si], p1 = a[si + 1];
      var ux = (p1[0] - p0[0]) / (segLen[si] || 1), uy = (p1[1] - p0[1]) / (segLen[si] || 1);
      var X = p0[0] + (p1[0] - p0[0]) * t, Y = p0[1] + (p1[1] - p0[1]) * t;
      /* offsets run left(−) to right(+) looking up-station: normal is (−uy, ux) */
      var nxx = -uy, nyy = ux;
      sta[s] = want; cx[s] = X; cy[s] = Y; dx_[s] = nxx; dy_[s] = nyy;
      for (var o = 0; o < no; o++) {
        var off = -half + o * offStep;
        var px = X + nxx * off, py = Y + nyy * off, k = s * no + o;
        ground[k] = elevOf(job.grids, px, py);
        if (design) design[k] = dgridAt(job.dgrid, px, py);
        if (canopy) canopy[k] = elevOf(job.chm, px, py);
      }
      if (onProgress && (s & 7) === 7) onProgress((s + 1) / ns);
    }

    /* per-station cut / fill end areas vs the design surface (ft²), by the
       trapezoid rule across the offset axis.

       The same tolerance the isopach applies (ruling F9, isoTol): a ground /
       design difference inside the two rasters' quantisation steps, plus the
       slope-times-cell-mismatch allowance where the ground grid is coarser
       than the design, is treated as zero. Without it a section across
       res_excbottom on the 2-ft site DEM reported 1.3 % phantom fill on a
       surface that is all cut by construction. The PROFILE arrays are not
       touched — the drawing shows the rasters as they are; only the areas
       someone quotes are dead-banded — and `tol` is returned per sample so
       the host and the harness can see exactly what was applied. */
    var cutA = null, fillA = null, tol = null;
    if (design) {
      cutA = new Float64Array(ns); fillA = new Float64Array(ns);
      tol = new Float32Array(ns * no);
      var dcell = job.dgrid.cell || 1;
      for (var kt = 0; kt < ns * no; kt++) {
        var st = (kt - kt % no) / no, ot = kt % no;
        tol[kt] = isoTol(job, job.grids, cx[st] + dx_[st] * (-half + ot * offStep),
                                          cy[st] + dy_[st] * (-half + ot * offStep), dcell);
      }
      for (var ss = 0; ss < ns; ss++) {
        var c = 0, fl = 0;
        for (var oo = 0; oo + 1 < no; oo++) {
          var k1 = ss * no + oo, k2 = k1 + 1;
          var g1 = ground[k1], g2 = ground[k2], d1 = design[k1], d2 = design[k2];
          if (isNaN(g1) || isNaN(g2) || isNaN(d1) || isNaN(d2)) continue;
          var h1 = g1 - d1, h2 = g2 - d2;
          if (Math.abs(h1) <= tol[k1]) h1 = 0;
          if (Math.abs(h2) <= tol[k2]) h2 = 0;
          /* split the trapezoid at the zero crossing so cut and fill never mix */
          if (h1 >= 0 && h2 >= 0) c += (h1 + h2) / 2 * offStep;
          else if (h1 <= 0 && h2 <= 0) fl += (-h1 - h2) / 2 * offStep;
          else {
            var tt = h1 / (h1 - h2);
            var xa = tt * offStep, xb = offStep - xa;
            if (h1 > 0) { c += h1 / 2 * xa; fl += -h2 / 2 * xb; }
            else { fl += -h1 / 2 * xa; c += h2 / 2 * xb; }
          }
        }
        cutA[ss] = c; fillA[ss] = fl;
      }
    }
    var out = { ns: ns, no: no, offStep: offStep, half: half, interval: interval, total: total,
                sta: sta, cx: cx, cy: cy, nx: dx_, ny: dy_,
                ground: ground, design: design, canopy: canopy, cutA: cutA, fillA: fillA,
                tol: tol };
    var tr = [sta.buffer, cx.buffer, cy.buffer, dx_.buffer, dy_.buffer, ground.buffer];
    if (design) tr.push(design.buffer);
    if (canopy) tr.push(canopy.buffer);
    if (cutA) { tr.push(cutA.buffer); tr.push(fillA.buffer); tr.push(tol.buffer); }
    return { result: out, transfer: tr };
  }

  /* ==================== 7. morphology + smart boundaries ==================
     Everything in this section is raster work that used to be impossible to do
     interactively: a 35-ft-disc opening at 1-ft resolution is a 71x71 structuring
     element, and the naive loop is ~5000 comparisons per cell. Two standard tricks
     bring it down to a handful:

       • a sliding-window extremum over a row costs O(1) per element amortised
         (monotonic deque), not O(k);
       • a disc decomposes into one horizontal run per row offset, so a disc
         erosion is (2r+1) row-runs, and run *widths* repeat — the horizontal pass
         is computed once per distinct width and reused by every row offset that
         shares it.

     For r = 35 ft that is 36 horizontal passes and 71 vertical combines over the
     window instead of 5000 comparisons per cell — the difference between a tool
     that feels instant and one nobody would use twice. */

  /* sliding-window extremum along one line (offset/stride/length), window k odd.
     `dq` is a caller-supplied Int32Array scratch of at least `n` entries. */
  function slideExt(src, dst, off, stride, n, k, isMax, dq) {
    var rr = (k - 1) >> 1, head = 0, tail = 0, i, o;
    for (i = 0; i < n + rr; i++) {
      if (i < n) {
        var v = src[off + i * stride];
        if (isMax) { while (tail > head && src[off + dq[tail - 1] * stride] <= v) tail--; }
        else { while (tail > head && src[off + dq[tail - 1] * stride] >= v) tail--; }
        dq[tail++] = i;
      }
      o = i - rr;
      if (o >= 0) {
        while (dq[head] < o - rr) head++;
        dst[off + o * stride] = src[off + dq[head] * stride];
      }
    }
  }

  /* grey-scale disc erosion (isMax=false) or dilation (isMax=true), r in CELLS.
     NoData must already be replaced by the neutral sentinel (+Inf to erode,
     -Inf to dilate) so a hole neither eats into nor donates to a real value. */
  function discExt(src, out, tmp, w, h, r, isMax, dq, onProgress, p0, p1) {
    var SENT = isMax ? -Infinity : Infinity;
    out.fill(SENT);
    var rr = Math.max(1, Math.round(r)), dj, i, j;
    /* group row offsets by the width of their horizontal run */
    var widths = [], byW = {};
    for (dj = -rr; dj <= rr; dj++) {
      var hw = Math.floor(Math.sqrt(Math.max(0, r * r - dj * dj)));
      var k = 2 * hw + 1;
      if (!byW[k]) { byW[k] = []; widths.push(k); }
      byW[k].push(dj);
    }
    for (var q = 0; q < widths.length; q++) {
      var kk = widths[q], djs = byW[kk];
      for (j = 0; j < h; j++) slideExt(src, tmp, j * w, 1, w, kk, isMax, dq);
      for (var d = 0; d < djs.length; d++) {
        var off = djs[d];
        for (j = 0; j < h; j++) {
          var sj = j + off;
          if (sj < 0 || sj >= h) continue;
          var so = sj * w, oo = j * w;
          if (isMax) { for (i = 0; i < w; i++) { var a = tmp[so + i]; if (a > out[oo + i]) out[oo + i] = a; } }
          else { for (i = 0; i < w; i++) { var b = tmp[so + i]; if (b < out[oo + i]) out[oo + i] = b; } }
        }
      }
      if (onProgress) onProgress(p0 + (p1 - p0) * (q + 1) / widths.length);
    }
  }

  /* separable box mean over a (2r+1) square, NoData-aware (nodata cells neither
     contribute nor count, so a hole does not drag its neighbours toward zero) */
  function boxMean(z, w, h, r, outZ) {
    var n = w * h, i, j;
    var s = new Float64Array(n), c = new Float64Array(n),
        s2 = new Float64Array(n), c2 = new Float64Array(n);
    for (j = 0; j < h; j++) {
      var run = 0, cn = 0, off = j * w;
      for (i = 0; i < w; i++) {                      // horizontal running sum
        var add = z[off + i];
        if (!isNaN(add)) { run += add; cn++; }
        var drop = i - (2 * r + 1);
        if (drop >= 0) { var dv = z[off + drop]; if (!isNaN(dv)) { run -= dv; cn--; } }
        var o = i - r;
        if (o >= 0) { s[off + o] = run; c[off + o] = cn; }
      }
      for (i = Math.max(0, w - r); i < w; i++) {     // flush the tail
        var lo = Math.max(0, i - r), sum = 0, k2 = 0;
        for (var q = lo; q < w; q++) { var vq = z[off + q]; if (!isNaN(vq)) { sum += vq; k2++; } }
        s[off + i] = sum; c[off + i] = k2;
      }
    }
    for (i = 0; i < w; i++) {                        // vertical running sum
      var run2 = 0, cn2 = 0;
      for (j = 0; j < h; j++) {
        run2 += s[j * w + i]; cn2 += c[j * w + i];
        var dj2 = j - (2 * r + 1);
        if (dj2 >= 0) { run2 -= s[dj2 * w + i]; cn2 -= c[dj2 * w + i]; }
        var oj = j - r;
        if (oj >= 0) { s2[oj * w + i] = run2; c2[oj * w + i] = cn2; }
      }
      for (j = Math.max(0, h - r); j < h; j++) {
        var lo2 = Math.max(0, j - r), sm = 0, km = 0;
        for (var q2 = lo2; q2 < h; q2++) { sm += s[q2 * w + i]; km += c[q2 * w + i]; }
        s2[j * w + i] = sm; c2[j * w + i] = km;
      }
    }
    for (i = 0; i < n; i++) outZ[i] = isNaN(z[i]) ? NaN : (c2[i] > 0 ? s2[i] / c2[i] : NaN);
    return outZ;
  }

  /* top-hat residual: z - opening(z, disc r). The opening is the "base surface"
     the ABP memo's pile delineation uses — a surface that can slide under the
     terrain everywhere but cannot climb into anything narrower than the disc, so
     what it leaves behind is exactly the mound. */
  function topHatResidual(z, w, h, rCells, onProgress) {
    var n = w * h, i;
    var src = new Float32Array(n), tmp = new Float32Array(n), out = new Float32Array(n);
    var dq = new Int32Array(Math.max(w, h) + 4);
    for (i = 0; i < n; i++) src[i] = isNaN(z[i]) ? Infinity : z[i];
    discExt(src, out, tmp, w, h, rCells, false, dq, onProgress, 0, 0.42);   // erode
    for (i = 0; i < n; i++) src[i] = isFinite(out[i]) ? out[i] : -Infinity;
    discExt(src, out, tmp, w, h, rCells, true, dq, onProgress, 0.42, 0.84); // dilate
    var res = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var zv = z[i];
      res[i] = (isNaN(zv) || !isFinite(out[i])) ? NaN : zv - out[i];
    }
    return res;
  }

  /* Slope as a RATIO (rise/run) at node i,j, measured over a lag of L cells.

     L matters more than it looks. At L = 1 on a 1-ft lidar grid this measures
     cell-to-cell ROUGHNESS: bare waste rock reads over 0.30 almost everywhere, so a
     0.30 cutoff rejects the pile itself. The memo's cutoff is a property of a rim
     FACE — a slope you could stand a section on — and the memo measured it on a
     contour-interpolated surface that had no micro-relief to begin with. Measuring
     over a lag of roughly a rim-face width reproduces that quantity on lidar. */
  function slopeRatio(z, w, h, cell, i, j, L) {
    L = L || 1;
    var zc = z[j * w + i];
    if (isNaN(zc)) return NaN;
    var il = Math.max(0, i - L), ir = Math.min(w - 1, i + L);
    var jd = Math.max(0, j - L), ju = Math.min(h - 1, j + L);
    var zl = z[j * w + il], zr = z[j * w + ir];
    var zd = z[jd * w + i], zu = z[ju * w + i];
    if (isNaN(zl)) { zl = zc; il = i; } if (isNaN(zr)) { zr = zc; ir = i; }
    if (isNaN(zd)) { zd = zc; jd = j; } if (isNaN(zu)) { zu = zc; ju = j; }
    var dx = (ir - il) * cell, dy = (ju - jd) * cell;
    return Math.hypot(dx > 0 ? (zr - zl) / dx : 0, dy > 0 ? (zu - zd) / dy : 0);
  }

  /* trace a 0/1 mask into rings via marching squares at 0.5, largest ring first */
  function traceMask(mask, w, h, cell, X0, Y0, tol) {
    var f = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) f[i] = mask[i] ? 1 : 0;
    var lines = marchOne(f, w, h, cell, X0, Y0, 0.5);
    var rings = [];
    for (var k = 0; k < lines.length; k++) {
      var L = lines[k];
      if (L.length < 4) continue;
      var closed = Math.abs(L[0][0] - L[L.length - 1][0]) < 1e-6 && Math.abs(L[0][1] - L[L.length - 1][1]) < 1e-6;
      var R = tol ? simplifyPath(L, tol) : L;
      if (R.length < 4) continue;
      rings.push({ pts: R, area: ringArea(R), closed: closed });
    }
    rings.sort(function (a, b) { return b.area - a.area; });
    return rings;
  }

  /* ---- PILE WAND ------------------------------------------------------------
     job: { grid, mode:"wand"|"preview", r, thresh, cx, cy, slopeCut, tol,
            alpha, ramp }                                                        */
  function pileWand(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var n = w * h, i, j;
    /* Pre-smooth. The memo delineated on a DEM interpolated from 1-ft CONTOURS,
       which is smooth by construction; this app's terrain is the raw lidar grid,
       which resolves the waste-rock micro-relief the contours never carried. Run
       against the raw grid the 0.75-ft residual threshold and the 0.30 slope cutoff
       both measure roughness instead of landform, and the delineation is unstable —
       it either chokes off at the click or leaks across the whole bench. A light
       mean filter puts the surface back at roughly the effective resolution the
       memo's method was calibrated on, and the delineation reproduces. */
    var zf = g.z;
    var smR = Math.round((job.smooth == null ? 18 : job.smooth) / cell);
    if (smR > 0) { zf = new Float32Array(n); boxMean(g.z, w, h, smR, zf); }
    var res = topHatResidual(zf, w, h, Math.max(1, job.r / cell), onProgress);
    var thresh = job.thresh;

    if (job.mode === "preview") {
      /* an RGBA wash of the residual so the user can see what the click will grab
         BEFORE clicking: solid above the threshold, ghosted below it. */
      var px = new Uint8ClampedArray(n * 4), alpha = job.alpha == null ? 165 : job.alpha;
      for (j = 0; j < h; j++) {
        var outRow = h - 1 - j;                        // canvas row 0 = north
        for (i = 0; i < w; i++) {
          var v = res[j * w + i], k4 = (outRow * w + i) * 4;
          if (isNaN(v) || v <= 0.08) { px[k4 + 3] = 0; continue; }
          var t = clamp(v / Math.max(0.5, thresh * 4), 0, 1);
          var rgb = lerpRamp(job.ramp, t);
          px[k4] = rgb[0]; px[k4 + 1] = rgb[1]; px[k4 + 2] = rgb[2];
          px[k4 + 3] = v > thresh ? alpha : Math.round(alpha * 0.30);
        }
      }
      if (onProgress) onProgress(1);
      return { result: { rgba: px, W: w, H: h,
                         bx0: X0 - cell / 2, by0: Y0 - cell / 2,
                         bx1: X0 + (w - 0.5) * cell, by1: Y0 + (h - 0.5) * cell },
               transfer: [px.buffer] };
    }

    /* The memo's third clause — "slope > 0.30 rim face excluded" — is not cosmetic.
       A waste pile is a low mound (a few feet of relief over a hundred), but it sits
       against mine highwalls and cut banks that are far steeper. Those faces also
       carry a large top-hat residual, because a 35-ft disc cannot climb them either,
       so without this test the flood fill walks straight off the pile and up the
       hillside — it returned 2x to 4x the memo footprint on every pile until this
       went in. Excluding cells steeper than the cutoff puts a wall around the mound
       at the toe, which is where the delineation is supposed to stop. */
    /* the memo's cutoff, and a real default: `undefined > 0` is false, so reading
       this straight off the job silently meant "no slope test at all" */
    var slopeCut = job.slopeCut == null ? 0.30 : (job.slopeCut > 0 ? job.slopeCut : Infinity);
    var slopeLag = Math.max(1, Math.round((job.slopeLag == null ? 3 : job.slopeLag) / cell));
    var passable = new Uint8Array(n), nSteep = 0;
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      var kk2 = j * w + i;
      if (isNaN(res[kk2]) || res[kk2] <= thresh) continue;
      if (slopeRatio(zf, w, h, cell, i, j, slopeLag) > slopeCut) { nSteep++; continue; }
      passable[kk2] = 1;
    }

    /* flood fill from the click through cells whose residual clears the threshold */
    var ci = Math.round((job.cx - X0) / cell), cj = Math.round((job.cy - Y0) / cell);
    if (ci < 0 || cj < 0 || ci >= w || cj >= h) throw new Error("click is outside the terrain window");
    var start = cj * w + ci;
    if (isNaN(res[start])) throw new Error("no terrain data under the click");
    if (!passable[start]) {
      /* nudge to the best passable cell within 12 ft — clicking the flank of a mound,
         or a cell the slope test just excluded, is completely normal */
      var best = -1, bv = thresh, rad = Math.ceil(12 / cell);
      for (j = Math.max(0, cj - rad); j <= Math.min(h - 1, cj + rad); j++)
        for (i = Math.max(0, ci - rad); i <= Math.min(w - 1, ci + rad); i++) {
          var kk3 = j * w + i, vv = res[kk3];
          if (passable[kk3] && vv > bv) { bv = vv; best = kk3; }
        }
      if (best < 0) throw new Error("no mound here — residual under the click is " +
        (isNaN(res[start]) ? "nodata" : res[start].toFixed(2)) + " ft, threshold " +
        thresh.toFixed(2) + " ft" + (nSteep ? " (and the ground here is steeper than the " +
        (slopeCut * 100).toFixed(0) + "% rim cutoff)" : ""));
      start = best;
    }
    var mask = new Uint8Array(n), stack = new Int32Array(n), sp = 0, cells = 0;
    stack[sp++] = start; mask[start] = 1;
    while (sp > 0) {
      var p = stack[--sp]; cells++;
      var pi = p % w, pj = (p - pi) / w;
      if (pi > 0 && !mask[p - 1] && passable[p - 1]) { mask[p - 1] = 1; stack[sp++] = p - 1; }
      if (pi < w - 1 && !mask[p + 1] && passable[p + 1]) { mask[p + 1] = 1; stack[sp++] = p + 1; }
      if (pj > 0 && !mask[p - w] && passable[p - w]) { mask[p - w] = 1; stack[sp++] = p - w; }
      if (pj < h - 1 && !mask[p + w] && passable[p + w]) { mask[p + w] = 1; stack[sp++] = p + w; }
    }
    if (onProgress) onProgress(0.92);

    /* did the region run into the edge of the window? then the window was too small */
    var touchedEdge = false;
    for (i = 0; i < w; i++) if (mask[i] || mask[(h - 1) * w + i]) { touchedEdge = true; break; }
    if (!touchedEdge) for (j = 0; j < h; j++) if (mask[j * w] || mask[j * w + w - 1]) { touchedEdge = true; break; }

    var rings = traceMask(mask, w, h, cell, X0, Y0, job.tol || 1.0);
    if (!rings.length) throw new Error("the region traced no closed boundary");
    /* the ring the click sits inside, else the biggest */
    var pick = rings[0];
    for (var q = 0; q < rings.length; q++)
      if (pointInPoly(job.cx, job.cy, rings[q].pts)) { pick = rings[q]; break; }

    /* how much of that boundary sits on ground steeper than the memo's rim cutoff */
    var steep = 0, tot = 0, cut = job.slopeCut || 0.30;
    for (q = 0; q < pick.pts.length; q++) {
      var px2 = pick.pts[q], gi = Math.round((px2[0] - X0) / cell), gj = Math.round((px2[1] - Y0) / cell);
      if (gi < 1 || gj < 1 || gi >= w - 1 || gj >= h - 1) continue;
      var s = slopeRatio(zf, w, h, cell, gi, gj, slopeLag);
      if (isNaN(s)) continue;
      tot++; if (s > cut) steep++;
    }
    /* peak residual inside the footprint = how tall the mound stands over its base */
    var peak = 0;
    for (i = 0; i < n; i++) if (mask[i] && res[i] > peak) peak = res[i];

    var flat = new Float64Array(pick.pts.length * 2);
    for (q = 0; q < pick.pts.length; q++) { flat[q * 2] = pick.pts[q][0]; flat[q * 2 + 1] = pick.pts[q][1]; }
    if (onProgress) onProgress(1);
    return {
      result: { coords: flat, nPts: pick.pts.length, area: pick.area, cells: cells,
                cellArea: cells * cell * cell, peak: peak, rings: rings.length,
                steepPct: tot ? 100 * steep / tot : 0, touchedEdge: touchedEdge,
                closed: pick.closed },
      transfer: [flat.buffer]
    };
  }

  /* ---- CONTOUR-SNAP BOUNDARY ------------------------------------------------
     job: { grid, cx, cy, level, tol }                                           */
  function contourBoundary(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var level = job.level, sampled = NaN, autoLevel = (level == null || isNaN(level));
    if (autoLevel) {
      sampled = gridAt({ x0: g.x0, y0: g.y0, cell: cell, w: g.w, h: g.h, i0: g.i0, j0: g.j0, sw: w, sh: h, z: g.z },
                       job.cx, job.cy);
      if (isNaN(sampled)) throw new Error("no terrain data under the click");
      /* Taking the click's own elevation as the contour level is degenerate: the
         click then lies exactly ON the line being traced, so whether it counts as
         inside the ring is decided by rounding noise — which is why this returned a
         13-point speck on a 20-acre impoundment. Nudging the level a hair above the
         clicked ground puts the click strictly inside the ring that encloses it. */
      level = sampled + (job.levelEps == null ? 0.25 : job.levelEps);
    }
    /* A pond or a bench edge is a real contour; bare rough ground at an arbitrary
       level is not, and contouring the raw lidar there shatters into hundreds of
       tiny rings around individual cobbles. A light mean filter keeps the shoreline
       where it is (a flat water plateau is its own mean) while giving rough ground a
       contour that means something. */
    var zc = g.z;
    var smR2 = Math.round((job.smooth == null ? 3 : job.smooth) / cell);
    if (smR2 > 0) { zc = new Float32Array(w * h); boxMean(g.z, w, h, smR2, zc); }
    if (onProgress) onProgress(0.25);
    var lines = marchOne(zc, w, h, cell, X0, Y0, level);
    if (onProgress) onProgress(0.8);
    var closed = [], open = 0;
    for (var k = 0; k < lines.length; k++) {
      var L = lines[k];
      if (L.length < 4) continue;
      var isClosed = Math.abs(L[0][0] - L[L.length - 1][0]) < 1e-6 && Math.abs(L[0][1] - L[L.length - 1][1]) < 1e-6;
      if (!isClosed) { open++; continue; }
      var R = simplifyPath(L, job.tol || cell * 0.6);
      if (R.length < 4) continue;
      closed.push({ pts: R, area: ringArea(R) });
    }
    if (!closed.length)
      throw new Error("the " + level.toFixed(2) + "-ft contour does not close inside this window (" +
                      open + " open line" + (open === 1 ? "" : "s") + ") — try a different elevation or zoom out");
    closed.sort(function (a, b) { return b.area - a.area; });
    /* LARGEST ring that encloses the click. Not the smallest: on any real surface
       the click sits inside a nest of rings, and the innermost is a puddle-sized
       artefact while the outermost is the pond, the bench or the basin the user
       actually pointed at. */
    var pick = null;
    for (var q = 0; q < closed.length; q++)
      if (pointInPoly(job.cx, job.cy, closed[q].pts)) { pick = closed[q]; break; }
    var enclosing = !!pick;
    if (!pick) pick = closed[0];
    var flat = new Float64Array(pick.pts.length * 2);
    for (q = 0; q < pick.pts.length; q++) { flat[q * 2] = pick.pts[q][0]; flat[q * 2 + 1] = pick.pts[q][1]; }
    if (onProgress) onProgress(1);
    return { result: { coords: flat, nPts: pick.pts.length, area: pick.area, level: level,
                       sampled: sampled, autoLevel: autoLevel,
                       rings: closed.length, openLines: open, enclosing: enclosing },
             transfer: [flat.buffer] };
  }

  /* ---- TOE / CREST ----------------------------------------------------------
     job: { grid, cx, cy, thresh, tol }
     Contour the gradient-magnitude field at the threshold and keep the chain that
     passes nearest the click. Honest about what it is: a slope-magnitude contour,
     not a hydrologically conditioned break line.                                */
  function toeCrest(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    /* The gradient of a raw 1-ft lidar grid is dominated by cobble-scale roughness:
       contouring it at 15% shattered into 5,600 fragments averaging a few feet long,
       which is noise, not a toe line. Smoothing first — and measuring the gradient
       over a lag rather than cell to cell — makes this a LANDFORM slope, which is
       what a toe or a crest actually is. */
    var zs = g.z;
    var smR3 = Math.round((job.smooth == null ? 12 : job.smooth) / cell);
    if (smR3 > 0) { zs = new Float32Array(w * h); boxMean(g.z, w, h, smR3, zs); }
    var lag = Math.max(1, Math.round((job.lag == null ? 6 : job.lag) / cell));
    var sl = new Float32Array(w * h);
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) sl[j * w + i] = slopeRatio(zs, w, h, cell, i, j, lag);
      if (onProgress && (j & 63) === 63) onProgress(0.5 * (j + 1) / h);
    }
    var lines = marchOne(sl, w, h, cell, X0, Y0, job.thresh);
    if (onProgress) onProgress(0.85);
    if (!lines.length) throw new Error("slope never crosses " + (job.thresh * 100).toFixed(0) +
      "% inside this window — try a different threshold");
    /* nearest chain to the click, measured vertex-wise */
    var best = null, bestD = Infinity, total = 0, q, k;
    for (k = 0; k < lines.length; k++) {
      var L = lines[k];
      if (L.length < 3) continue;
      total++;
      var d = Infinity;
      for (q = 0; q < L.length; q++) {
        var dd = (L[q][0] - job.cx) * (L[q][0] - job.cx) + (L[q][1] - job.cy) * (L[q][1] - job.cy);
        if (dd < d) d = dd;
      }
      if (d < bestD) { bestD = d; best = L; }
    }
    if (!best) throw new Error("no usable slope break near the click");
    var R = simplifyPath(best, job.tol || cell * 0.8);
    var len = 0;
    for (q = 0; q + 1 < R.length; q++) len += Math.hypot(R[q + 1][0] - R[q][0], R[q + 1][1] - R[q][1]);
    var flat = new Float64Array(R.length * 2);
    for (q = 0; q < R.length; q++) { flat[q * 2] = R[q][0]; flat[q * 2 + 1] = R[q][1]; }
    if (onProgress) onProgress(1);
    return { result: { coords: flat, nPts: R.length, length: len, chains: total,
                       distFt: Math.sqrt(bestD) },
             transfer: [flat.buffer] };
  }

  /* ---- CANOPY STANDS --------------------------------------------------------
     job: { grid (CHM), poly|null, thresh, minArea, closeR, tol }                */
  function canopyStands(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var n = w * h, i, j;
    var pts = null;
    if (job.poly && job.poly.length >= 6) {
      pts = [];
      for (i = 0; i < job.poly.length; i += 2) pts.push([job.poly[i], job.poly[i + 1]]);
    }
    var mask = new Uint8Array(n);
    for (j = 0; j < h; j++) {
      var yy = Y0 + j * cell;
      for (i = 0; i < w; i++) {
        var v = g.z[j * w + i];
        if (isNaN(v) || v < job.thresh) continue;
        if (pts && !pointInPoly(X0 + i * cell, yy, pts)) continue;
        mask[j * w + i] = 1;
      }
    }
    if (onProgress) onProgress(0.25);

    /* binary close (dilate then erode) with a small disc — bridges the 1-cell gaps
       a max-return CHM always has inside a continuous canopy */
    var cr = job.closeR == null ? 1 : job.closeR;
    if (cr > 0) {
      var f = new Float32Array(n), o1 = new Float32Array(n), t1 = new Float32Array(n);
      var dq = new Int32Array(Math.max(w, h) + 4);
      for (i = 0; i < n; i++) f[i] = mask[i];
      discExt(f, o1, t1, w, h, cr, true, dq, null, 0, 0);
      discExt(o1, f, t1, w, h, cr, false, dq, null, 0, 0);
      for (i = 0; i < n; i++) mask[i] = f[i] > 0.5 ? 1 : 0;
      /* the close must never invent canopy where the CHM has no data at all */
      for (i = 0; i < n; i++) if (isNaN(g.z[i])) mask[i] = 0;
    }
    if (onProgress) onProgress(0.45);

    /* connected components (4-connected), area filter */
    var lab = new Int32Array(n), stack = new Int32Array(n), nLab = 0;
    var keep = [], dropped = 0, cellA = cell * cell;
    for (var s = 0; s < n; s++) {
      if (!mask[s] || lab[s]) continue;
      nLab++;
      var sp = 0, cnt = 0, i0 = w, i1 = -1, j0 = h, j1 = -1;
      stack[sp++] = s; lab[s] = nLab;
      while (sp > 0) {
        var p = stack[--sp]; cnt++;
        var pi = p % w, pj = (p - pi) / w;
        if (pi < i0) i0 = pi; if (pi > i1) i1 = pi;
        if (pj < j0) j0 = pj; if (pj > j1) j1 = pj;
        if (pi > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = nLab; stack[sp++] = p - 1; }
        if (pi < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = nLab; stack[sp++] = p + 1; }
        if (pj > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = nLab; stack[sp++] = p - w; }
        if (pj < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = nLab; stack[sp++] = p + w; }
      }
      if (cnt * cellA < job.minArea) { dropped++; continue; }
      keep.push({ lab: nLab, cnt: cnt, i0: i0, i1: i1, j0: j0, j1: j1 });
    }
    if (onProgress) onProgress(0.6);

    /* trace each kept component inside its own bounding box (+1 cell of margin,
       so the mask really does go to zero all the way round and the ring closes) */
    keep.sort(function (a, b) { return b.cnt - a.cnt; });
    var out = [], totCells = 0;
    for (var q = 0; q < keep.length; q++) {
      var c = keep[q];
      var bi0 = Math.max(0, c.i0 - 2), bi1 = Math.min(w - 1, c.i1 + 2);
      var bj0 = Math.max(0, c.j0 - 2), bj1 = Math.min(h - 1, c.j1 + 2);
      var bw = bi1 - bi0 + 1, bh = bj1 - bj0 + 1;
      var sub = new Uint8Array(bw * bh);
      var hsum = 0, hn = 0, hmax = 0;
      for (j = 0; j < bh; j++) for (i = 0; i < bw; i++) {
        var src = (bj0 + j) * w + (bi0 + i);
        if (lab[src] === c.lab) {
          sub[j * bw + i] = 1;
          var hv = g.z[src];
          if (!isNaN(hv)) { hsum += hv; hn++; if (hv > hmax) hmax = hv; }
        }
      }
      var rings = traceMask(sub, bw, bh, cell, X0 + bi0 * cell, Y0 + bj0 * cell, job.tol || cell * 0.9);
      if (!rings.length) continue;
      var R = rings[0].pts;
      var flat = new Float64Array(R.length * 2);
      for (i = 0; i < R.length; i++) { flat[i * 2] = R[i][0]; flat[i * 2 + 1] = R[i][1]; }
      totCells += c.cnt;
      out.push({ coords: flat, nPts: R.length, ringArea: rings[0].area,
                 cellArea: c.cnt * cellA, meanH: hn ? hsum / hn : 0, maxH: hmax });
      if (onProgress) onProgress(0.6 + 0.4 * (q + 1) / keep.length);
    }
    return { result: { stands: out, dropped: dropped, components: nLab,
                       totalArea: totCells * cellA, thresh: job.thresh },
             transfer: out.map(function (o) { return o.coords.buffer; }) };
  }

  /* ---- INDIVIDUAL TREE DETECTION -------------------------------------------
     job: { grid (CHM), minH, minCrown, maxTrees }

     Two standard steps, both kept honest about their approximations:

     1. variable-window local maxima. The window radius is the usual allometric
        rule, radius = max(4 ft, 0.35 x height): a 10-ft sapling is allowed to be
        4 ft from its neighbour, an 80-ft conifer owns 28 ft. Implemented by
        quantising the radius into integer bins and running ONE sliding-window
        max per bin (O(1) per cell per bin) rather than a per-cell neighbourhood
        scan. The window is a square, not a disc — at these radii the difference
        moves a handful of apexes and costs 30x less.

     2. marker-based region grow, which is a simplified watershed: cells are
        visited in descending height (counting sort on the height quantum, not a
        comparison sort) and each takes the label of its only labelled neighbour.
        A cell with two different labelled neighbours is a saddle between two
        crowns and stays unassigned; a cell below 0.3 x its apex height has fallen
        out of the crown and also stops. That is what keeps two touching crowns
        from merging into one enormous tree.                                     */
  function treeDetect(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var n = w * h, i, j, k;
    var z = g.z, minH = job.minH, cutFrac = job.cutFrac == null ? 0.3 : job.cutFrac;

    /* ---- 1. variable-window local maxima ----

       The allometric window makes the radius depend on the cell's own height, which
       rules out a single sliding-window pass. Quantising the radius into bins and
       running one full-grid max filter per bin works but is brutally slow: 28 bins x
       2 passes over 11.1M cells, and the vertical pass strides the array by its row
       width, so it misses cache on nearly every read. That took 88 s over the full
       CHM window.

       Instead: run ONE cheap max filter at the SMALLEST radius the rule can ever
       ask for (4 ft). Any cell that is not a local maximum within 4 ft cannot be a
       local maximum within a larger window either, so this rejects almost everything
       for the cost of two passes. The handful that survive then get an exact direct
       scan at their own radius, which early-exits as soon as it sees anything taller.
       No quantisation, exact answer, and the work is proportional to the number of
       candidates rather than to the number of cells. */
    var rMinC = Math.max(1, Math.round(4 / cell));
    var mx = new Float32Array(n), tmp = new Float32Array(n);
    var dq = new Int32Array(Math.max(w, h) + 4);
    for (i = 0; i < n; i++) tmp[i] = isNaN(z[i]) ? -Infinity : z[i];
    var kMin = 2 * rMinC + 1;
    for (j = 0; j < h; j++) slideExt(tmp, mx, j * w, 1, w, kMin, true, dq);
    for (i = 0; i < w; i++) slideExt(mx, tmp, i, w, h, kMin, true, dq);
    if (onProgress) onProgress(0.25);

    var seedI = [], seedH = [], nCand = 0;
    for (var p0 = 0; p0 < n; p0++) {
      var v0 = z[p0];
      if (isNaN(v0) || v0 < minH) continue;
      if (v0 < tmp[p0]) continue;                       // beaten inside 4 ft
      nCand++;
      var R = Math.max(1, Math.round(Math.max(4, 0.35 * v0) / cell));
      var pi0 = p0 % w, pj0 = (p0 - pi0) / w, beaten = false;
      if (R > rMinC) {
        var ja = Math.max(0, pj0 - R), jb = Math.min(h - 1, pj0 + R);
        var ia = Math.max(0, pi0 - R), ib = Math.min(w - 1, pi0 + R);
        for (var jj = ja; jj <= jb && !beaten; jj++) {
          var ro = jj * w;
          for (var ii = ia; ii <= ib; ii++) if (z[ro + ii] > v0) { beaten = true; break; }
        }
      }
      if (!beaten) { seedI.push(p0); seedH.push(v0); }
      if (onProgress && (p0 & 1048575) === 1048575) onProgress(0.25 + 0.30 * p0 / n);
    }
    mx = null; tmp = null;
    if (onProgress) onProgress(0.55);

    /* a plateau of equal height reports every one of its cells as a maximum; keep
       one per plateau by dropping a seed that already has a seed as a neighbour */
    var isSeed = new Uint8Array(n);
    for (k = 0; k < seedI.length; k++) isSeed[seedI[k]] = 1;
    var lab = new Int32Array(n);
    var apexI = [], apexH = [];
    for (k = 0; k < seedI.length; k++) {
      var p = seedI[k], pi = p % w, pj = (p - pi) / w, dup = false;
      for (var dj = -1; dj <= 1 && !dup; dj++) for (var di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        var qi = pi + di, qj = pj + dj;
        if (qi < 0 || qj < 0 || qi >= w || qj >= h) continue;
        var qp = qj * w + qi;
        if (isSeed[qp] && lab[qp]) { dup = true; break; }
      }
      if (dup) continue;
      apexI.push(p); apexH.push(seedH[k]);
      lab[p] = apexI.length;
    }
    if (onProgress) onProgress(0.62);
    var nTrees = apexI.length;
    if (!nTrees) throw new Error("no canopy maxima at or above " + minH + " ft in this window");

    /* ---- 2. marker-based region grow, descending height (counting sort) ---- */
    var QUANT = 0.05, growMin = minH * cutFrac;
    var maxV = 0;
    for (i = 0; i < n; i++) { var q2 = z[i]; if (!isNaN(q2) && q2 > maxV) maxV = q2; }
    var nb2 = Math.floor(maxV / QUANT) + 2, cnt = new Int32Array(nb2 + 1);
    var m = 0;
    for (i = 0; i < n; i++) {
      var v2 = z[i];
      if (isNaN(v2) || v2 < growMin) continue;
      cnt[Math.floor(v2 / QUANT)]++; m++;
    }
    var startAt = new Int32Array(nb2 + 1), acc = 0;
    for (k = nb2; k >= 0; k--) { startAt[k] = acc; acc += cnt[k]; }     // descending
    var ordIdx = new Int32Array(m), fillAt = startAt.slice();
    for (i = 0; i < n; i++) {
      var v3 = z[i];
      if (isNaN(v3) || v3 < growMin) continue;
      ordIdx[fillAt[Math.floor(v3 / QUANT)]++] = i;
    }
    if (onProgress) onProgress(0.72);

    var area = new Int32Array(nTrees + 1);
    for (k = 0; k < nTrees; k++) area[k + 1] = 1;
    for (k = 0; k < m; k++) {
      var pp = ordIdx[k];
      if (lab[pp]) continue;
      var hv2 = z[pp], ppi = pp % w, ppj = (pp - ppi) / w;
      var found = 0, multi = false;
      for (var dj2 = -1; dj2 <= 1 && !multi; dj2++) for (var di2 = -1; di2 <= 1; di2++) {
        if (!di2 && !dj2) continue;
        var ni = ppi + di2, nj = ppj + dj2;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        var L2 = lab[nj * w + ni];
        if (!L2) continue;
        if (!found) found = L2;
        else if (L2 !== found) { multi = true; break; }
      }
      if (!found || multi) continue;                       // background, or a saddle
      if (hv2 < cutFrac * apexH[found - 1]) continue;      // fallen out of the crown
      lab[pp] = found; area[found]++;
      if (onProgress && (k & 262143) === 262143) onProgress(0.72 + 0.26 * k / m);
    }

    /* ---- 3. pack the inventory ---- */
    var minCrown = job.minCrown == null ? 4 : job.minCrown, cellA = cell * cell;
    var keepIdx = [];
    for (k = 0; k < nTrees; k++) if (area[k + 1] * cellA >= minCrown) keepIdx.push(k);
    var N = keepIdx.length;
    var TX = new Float64Array(N), TY = new Float64Array(N),
        TH = new Float32Array(N), TA = new Float32Array(N), TR = new Float32Array(N);
    for (k = 0; k < N; k++) {
      var t = keepIdx[k], pI = apexI[t], pi2 = pI % w, pj2 = (pI - pi2) / w;
      TX[k] = X0 + pi2 * cell; TY[k] = Y0 + pj2 * cell;
      TH[k] = apexH[t];
      TA[k] = area[t + 1] * cellA;
      TR[k] = Math.sqrt(TA[k] / Math.PI);
    }
    if (onProgress) onProgress(1);
    return { result: { x: TX, y: TY, h: TH, area: TA, radius: TR, n: N,
                       maxima: nTrees, dropped: nTrees - N, minH: minH },
             transfer: [TX.buffer, TY.buffer, TH.buffer, TA.buffer, TR.buffer] };
  }

  /* ============================ job dispatch ============================= */
  /* The single entry point used by BOTH the worker and the synchronous fallback,
     so the two paths can never drift apart. Returns { result, transfer }. */
  /* ============================== WATER (v10) ==============================
     docs/V10_WATER_SPEC.md §2/§3 — the raindrop (steepest descent with fill-spill
     ponds), impoundment overtopping, and the contributing area of a drop. Three
     kernels over ONE window of ONE DEM (never a mix of grids, §2), sharing:

       * one typed-array binary min-heap — Float64 keys, Int32 payloads, nothing
         allocated per push;
       * fillDem() — the Barnes-2014 outside-in priority flood. F[c] is the level
         water at c must reach before it can leave the window, so `F[v] < level`
         is the exact test for "water arriving at v drains AWAY". This is the
         whole accuracy story of both tools: the naive test ("v is lower than the
         pond surface, so it spills there") reports a 0-ft freeboard on the shore
         of every impoundment, because the shoreline is full of cells a few
         inches below the water that drain nowhere;
       * the 8-neighbour order below, which is fixed. Descent and both floods take
         the FIRST best neighbour in this order and the heap breaks equal-key ties
         on the payload, so every number these kernels produce is deterministic —
         which matters on a quantised lidar grid, where exact elevation ties
         between adjacent cells are common rather than exotic.

     Cell (i,j) of the window is the DEM sample at X0 + i*cell, Y0 + j*cell
     (X0 = grid.x0 + grid.i0*cell): the sample is the CENTRE of the cell, so a
     raster of the window spans X0 - cell/2 .. X0 + (w - 0.5)*cell — the same
     convention pileWand's preview uses. Row 0 is south, like every grid here. */

  var W_DI = [-1, 0, 1, -1, 1, -1, 0, 1];
  var W_DJ = [1, 1, 1, 0, 0, -1, -1, -1];
  var W_SQ = 1.4142135623730951;
  var W_DD = [W_SQ, 1, W_SQ, 1, 1, W_SQ, 1, W_SQ];

  /* ---- shared min-heap ---------------------------------------------------
     The payload is the cell's NORTH-MAJOR index nmi = (h-1-j)*w + i, not the
     storage index j*w+i. Both identify the cell; using the north-major one makes
     the tie-break "top-left first", which is the order the reference implementation
     of §2 used, so the goldens in §9 are reproducible cell for cell. Decode with
     r = (nmi/w)|0; i = nmi - r*w; j = h-1-r.                                   */
  function heapNew(cap) {
    cap = Math.max(64, cap | 0);
    return { k: new Float64Array(cap), v: new Int32Array(cap), n: 0, topKey: 0 };
  }
  function heapClear(H) { H.n = 0; }
  function heapGrow(H) {
    var m = H.k.length * 2, k = new Float64Array(m), v = new Int32Array(m);
    k.set(H.k); v.set(H.v); H.k = k; H.v = v;
  }
  function heapPush(H, key, val) {
    if (H.n === H.k.length) heapGrow(H);
    var k = H.k, v = H.v, i = H.n++, p, tk, tv;
    k[i] = key; v[i] = val;
    while (i > 0) {
      p = (i - 1) >> 1;
      if (k[i] < k[p] || (k[i] === k[p] && v[i] < v[p])) {
        tk = k[p]; k[p] = k[i]; k[i] = tk;
        tv = v[p]; v[p] = v[i]; v[i] = tv;
        i = p;
      } else break;
    }
  }
  /* returns the payload; its key lands in H.topKey */
  function heapPop(H) {
    var k = H.k, v = H.v, n = --H.n, rv = v[0], i = 0, l, r, m, tk, tv;
    H.topKey = k[0];
    if (n > 0) {
      k[0] = k[n]; v[0] = v[n];
      for (;;) {
        l = i * 2 + 1; r = l + 1; m = i;
        if (l < n && (k[l] < k[m] || (k[l] === k[m] && v[l] < v[m]))) m = l;
        if (r < n && (k[r] < k[m] || (k[r] === k[m] && v[r] < v[m]))) m = r;
        if (m === i) break;
        tk = k[m]; k[m] = k[i]; k[i] = tk;
        tv = v[m]; v[m] = v[i]; v[i] = tv;
        i = m;
      }
    }
    return rv;
  }

  /* ---- filled DEM --------------------------------------------------------
     Outside-in priority flood from every sink — NoData cells and the window edge
     (§2 "Filled DEM F"). F = max(z, level of the cell it was reached from); NaN
     stays NaN. Barnes' FIFO refinement: a neighbour that is already at or below
     the current level joins a plain queue instead of the heap, which is the
     difference between ~2 s and ~0.4 s on a 2-million-cell window and cannot
     change a single value (F is the minimal maximum over all escape paths, so it
     does not depend on the order cells are settled in).                        */
  function fillDem(z, w, h, onProgress, p0, p1) {
    var n = w * h, F = new Float32Array(n), closed = new Uint8Array(n);
    var H = heapNew(1 << 15), q = new Int32Array(n), qh = 0, qt = 0;
    var i, j, k, t, ni, nj, vi, edge;
    for (i = 0; i < n; i++) F[i] = NaN;
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      k = j * w + i;
      if (isNaN(z[k])) { closed[k] = 1; continue; }
      edge = (i === 0 || j === 0 || i === w - 1 || j === h - 1);
      if (!edge) for (t = 0; t < 8; t++) {
        ni = i + W_DI[t]; nj = j + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        if (isNaN(z[nj * w + ni])) { edge = true; break; }
      }
      if (edge) { closed[k] = 1; F[k] = z[k]; heapPush(H, z[k], (h - 1 - j) * w + i); }
    }
    var done = 0, lev, c, ci, cj, nm, rr;
    while (H.n > 0 || qh < qt) {
      if (qh < qt) { c = q[qh++]; ci = c % w; cj = (c - ci) / w; lev = F[c]; }
      else {
        nm = heapPop(H); rr = (nm / w) | 0; ci = nm - rr * w; cj = h - 1 - rr;
        c = cj * w + ci; lev = H.topKey;
      }
      for (t = 0; t < 8; t++) {
        ni = ci + W_DI[t]; nj = cj + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        vi = nj * w + ni;
        if (closed[vi]) continue;
        closed[vi] = 1;
        if (z[vi] <= lev) { F[vi] = lev; q[qt++] = vi; }
        else { F[vi] = z[vi]; heapPush(H, z[vi], (h - 1 - nj) * w + ni); }
      }
      if (onProgress && ((++done & 32767) === 0)) onProgress(p0 + (p1 - p0) * (done / n));
    }
    if (onProgress) onProgress(p1);
    return F;
  }

  /* even-odd scanline rasterisation of a ring onto the window's cells. Same
     inclusion rule as pointInPoly() (a cell centre exactly on a crossing counts
     as inside on the left edge only), but 551 edges per ROW instead of per cell. */
  function ringMask(ring, w, h, cell, X0, Y0, mask) {
    if (!mask) mask = new Uint8Array(w * h);
    var np = ring.length, i, j;
    if (np < 3) return mask;
    var ymin = Infinity, ymax = -Infinity;
    for (i = 0; i < np; i++) { if (ring[i][1] < ymin) ymin = ring[i][1]; if (ring[i][1] > ymax) ymax = ring[i][1]; }
    var j0 = Math.max(0, Math.ceil((ymin - Y0) / cell)), j1 = Math.min(h - 1, Math.floor((ymax - Y0) / cell));
    var xs = [];
    for (j = j0; j <= j1; j++) {
      var py = Y0 + j * cell;
      xs.length = 0;
      for (i = 0; i < np; i++) {
        var a = ring[i], b = ring[(i + 1) % np];
        if ((a[1] > py) !== (b[1] > py)) xs.push((b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]);
      }
      if (xs.length < 2) continue;
      xs.sort(function (p, q) { return p - q; });
      for (var s = 0; s + 1 < xs.length; s += 2) {
        var ia = Math.max(0, Math.ceil((xs[s] - X0) / cell));
        var ib = Math.min(w - 1, Math.ceil((xs[s + 1] - X0) / cell) - 1);
        for (i = ia; i <= ib; i++) mask[j * w + i] = 1;
      }
    }
    return mask;
  }

  function medianOf(vals, m) {
    var a = vals.subarray(0, m);
    a.sort(function (p, q) { return p - q; });
    return m % 2 ? a[(m - 1) >> 1] : (a[m / 2 - 1] + a[m / 2]) / 2;
  }

  /* rings of a cell mask, traced in the mask's own bounding box (padded one cell
     so a ring that does not touch the window edge always closes) */
  function maskRings(mask, w, h, cell, X0, Y0, bb, tol) {
    var i0 = Math.max(0, bb[0] - 1), j0 = Math.max(0, bb[1] - 1);
    var i1 = Math.min(w - 1, bb[2] + 1), j1 = Math.min(h - 1, bb[3] + 1);
    var bw = i1 - i0 + 1, bh = j1 - j0 + 1;
    if (bw < 2 || bh < 2) return [];
    var sub = new Uint8Array(bw * bh), i, j;
    for (j = 0; j < bh; j++) for (i = 0; i < bw; i++) sub[j * bw + i] = mask[(j0 + j) * w + i0 + i];
    var rings = traceMask(sub, bw, bh, cell, X0 + i0 * cell, Y0 + j0 * cell, tol);
    var out = [];
    for (i = 0; i < rings.length; i++) out.push(rings[i].pts);
    return out;
  }

  /* ---- FLOWPATH ------------------------------------------------------------
     job: { grid, x, y, minPondDepth=0.25, maxSteps=4e6, simplifyFt=null,
            blockRing=null, plateauTol=0.3, blockLevel=null,
            conduits=null, captureFt=3 }

     v12 (docs/V12_STORM_SPEC.md §2/§4) — the storm network. A conduit is a
     TOPOLOGICAL SHORTCUT WITH AN ELEVATION AT EACH END, nothing more: no
     capacity, no hydraulic grade, no time. `job.conduits` is a flat list

         { id, ix, iy, rim, ox, oy, next, len }

     — the inlet's x/y, the rim the water has to reach to enter it, the outlet's
     x/y, the id of the conduit that starts AT that outlet node (or null), and
     the conduit's own drawn length. The host flattens the node graph into
     `next` so the kernel never needs the node table, and passes only conduits
     whose inlet lies inside this window; a chain that leaves the window ends it
     with reason "conduit" and the host re-centres on the outlet exactly as it
     does for "window".

     With `conduits` absent or empty NOT ONE LINE of this runs and the kernel is
     the v10 kernel to the bit — test/kernels.mjs's `storm` section proves that
     on the §9.1 raindrop.                                                      */
  function flowpath(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell, z = g.z, n = w * h;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var minDepth = job.minPondDepth == null ? 0.25 : job.minPondDepth;
    var maxSteps = job.maxSteps == null ? 4e6 : job.maxSteps;
    var i, j, t, ni, nj, vi;

    var F = fillDem(z, w, h, onProgress, 0, 0.55);
    var pondId = new Int32Array(n);
    var ponds = [null];                                    // 1-based, ponds[0] unused

    /* the impoundment, pre-marked as a pond with no outlet (§2 "Overflow route"):
       an overflow route that ever comes back to the water body ends there rather
       than climbing back in. Its cells are the water surface — inside the ring AND
       on the plateau — not merely inside the ring, or the dry bank inside the
       polygon would read as water and pull the route in. */
    if (job.blockRing && job.blockRing.length >= 3) {
      var bmask = ringMask(job.blockRing, w, h, cell, X0, Y0);
      var vals = new Float64Array(n), m = 0;
      for (i = 0; i < n; i++) if (bmask[i] && !isNaN(z[i])) vals[m++] = z[i];
      if (m) {
        var bz0 = job.blockLevel == null ? medianOf(vals, m) : job.blockLevel;
        var btol = job.plateauTol == null ? 0.3 : job.plateauTol;
        var P0 = { level: bz0, outlet: -1, entry: -1, zmin: bz0, count: 0, sumZ: 0,
                   bb: [w, h, -1, -1], blocked: true };
        ponds.push(P0);
        for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
          vi = j * w + i;
          if (!bmask[vi] || isNaN(z[vi]) || Math.abs(z[vi] - bz0) > btol) continue;
          pondId[vi] = 1; P0.count++;
        }
      }
    }

    /* ---- v12: the inlet index -------------------------------------------
       `inletAt` is the conduit index whose capture disc (captureFt, default 3 ft
       — a grate is a few feet across and the descent walks cell centres, so a
       disc rather than one cell is what makes the network reachable on a 2-ft
       grid at all) covers each cell, or -1. Where two discs overlap the NEAREST
       inlet wins, which is deterministic and independent of the order the host
       listed the conduits in. */
    var CD = (job.conduits && job.conduits.length) ? job.conduits : null;
    var inletAt = null, inletD = null, cdUsed = null, cdIx = null, capFt = 0;
    var cdSeen = null, cdCell = null;
    var legs = [], pipeFt = 0, ck, cii, cjj, crc;
    if (CD) {
      capFt = job.captureFt == null ? 3 : job.captureFt;
      inletAt = new Int32Array(n); inletD = new Float32Array(n);
      for (i = 0; i < n; i++) { inletAt[i] = -1; inletD[i] = Infinity; }
      cdUsed = new Uint8Array(CD.length);
      cdSeen = new Uint8Array(CD.length);
      cdCell = new Int32Array(CD.length);
      cdIx = {};
      for (ck = 0; ck < CD.length; ck++) cdIx[CD[ck].id] = ck;
      crc = Math.max(0, Math.ceil(capFt / cell));
      for (ck = 0; ck < CD.length; ck++) {
        var Ck = CD[ck];
        var ki = Math.round((Ck.ix - X0) / cell), kj = Math.round((Ck.iy - Y0) / cell);
        for (cjj = kj - crc; cjj <= kj + crc; cjj++) {
          if (cjj < 0 || cjj >= h) continue;
          for (cii = ki - crc; cii <= ki + crc; cii++) {
            if (cii < 0 || cii >= w) continue;
            var kdx = X0 + cii * cell - Ck.ix, kdy = Y0 + cjj * cell - Ck.iy;
            var kd = Math.sqrt(kdx * kdx + kdy * kdy);
            if (kd > capFt) continue;
            var kidx = cjj * w + cii;
            if (isNaN(z[kidx])) continue;
            if (kd < inletD[kidx]) { inletD[kidx] = kd; inletAt[kidx] = ck; }
          }
        }
      }
    }

    var si = Math.round((job.x - X0) / cell), sj = Math.round((job.y - Y0) / cell);
    if (si < 0 || sj < 0 || si >= w || sj >= h) throw new Error("the drop is outside the terrain window");
    var cur = sj * w + si;
    if (isNaN(z[cur])) throw new Error("no surveyed terrain under that point");

    /* The run is a list of OVERLAND STRETCHES: each conduit chain ends one and
       starts the next, so each stretch is simplified on its own and the inlet and
       outlet vertices survive Douglas-Peucker. With no conduits there is exactly
       one stretch and the arithmetic below is the v10 arithmetic. */
    var path = [cur], segs = [path], reason = null, steps = 0, exitIdx = -1, exitXY = null;
    var H = heapNew(1 << 14), stamp = new Int32Array(n), pushed;

    function effOf(idx) { var k = pondId[idx]; return k ? ponds[k].level : z[idx]; }

    /* the flood has flooded this cell: if it belongs to an unused conduit's
       capture disc, that conduit joins the pond's candidate list once, with the
       cell that reached it (which is therefore always a cell under water) */
    function reach(idx) {
      var kk = inletAt[idx];
      if (kk < 0 || cdUsed[kk]) return;
      if (!cdSeen[kk]) { cdSeen[kk] = 1; cdCell[kk] = idx; pend.push(kk); }
      /* the pour point is the flooded capture cell CLOSEST to the structure, so
         the leg leaves from the grate rather than from whichever corner of its
         capture disc the flood happened to reach first */
      else if (inletD[idx] < inletD[cdCell[kk]]) cdCell[kk] = idx;
    }

    /* Follow the conduit chain from `k0`, departing the ground at cell `fromIdx`.
       Appends one leg per conduit, marks each used (a conduit is used at most
       once per run) and returns the cell the water reappears in, or -1 when the
       last outlet is outside the window / on NoData — in which case `exitXY`
       carries the outlet and the caller ends the window with reason "conduit". */
    function followChain(k0, fromIdx) {
      var kk = k0, segIx = segs.length - 1;
      var fi = fromIdx % w, fj = (fromIdx - fromIdx % w) / w;
      var fx = X0 + fi * cell, fy = Y0 + fj * cell, fz = z[fromIdx];
      var oi = -1, oj = -1, ox = fx, oy = fy, inside = false, oz = NaN;
      while (kk >= 0 && !cdUsed[kk]) {
        var C1 = CD[kk];
        cdUsed[kk] = 1;
        ox = C1.ox; oy = C1.oy;
        oi = Math.round((ox - X0) / cell); oj = Math.round((oy - Y0) / cell);
        inside = oi >= 0 && oj >= 0 && oi < w && oj < h;
        oz = inside ? z[oj * w + oi] : NaN;
        var L = (C1.len != null && isFinite(C1.len)) ? C1.len : Math.hypot(ox - fx, oy - fy);
        legs.push({ id: C1.id, seg: segIx, at: -1, length_ft: L,
                    from: [fx, fy, isNaN(fz) ? null : fz],
                    to: [ox, oy, isNaN(oz) ? null : oz] });
        pipeFt += L;
        fx = ox; fy = oy; fz = oz;
        var nx = (C1.next != null && cdIx[C1.next] != null) ? cdIx[C1.next] : -1;
        kk = (nx >= 0 && !cdUsed[nx]) ? nx : -1;
      }
      if (inside && !isNaN(oz)) return oj * w + oi;
      exitXY = [ox, oy];
      return -1;
    }

    while (steps < maxSteps) {
      steps++;
      if (onProgress && (steps & 4095) === 0) onProgress(0.55 + 0.35 * Math.min(1, steps / 200000));
      i = cur % w; j = (cur - i) / w;
      if (i === 0 || j === 0 || i === w - 1 || j === h - 1) { reason = "window"; exitIdx = cur; break; }

      /* v12 §2 "the shortcut rule": descent standing on an inlet's capture cells
         leaves the ground. Tested at the TOP of the step, so a drop placed on an
         inlet (the Herman pipe discharge route starts on one) enters it rather
         than walking a cell away first. */
      if (CD && inletAt[cur] >= 0 && !cdUsed[inletAt[cur]]) {
        var oc = followChain(inletAt[cur], cur);
        if (oc < 0) { reason = "conduit"; break; }
        path = [oc]; segs.push(path); cur = oc;
        continue;
      }

      /* steepest descent on EFFECTIVE elevation: a pond cell reads as its pond's
         level, never its floor, so from an outlet (which lies below the level) the
         pond is uphill and the drop cannot fall back into it. */
      var ze = effOf(cur), bDrop = -1, bIdx = -1, nod = -1;
      for (t = 0; t < 8; t++) {
        ni = i + W_DI[t]; nj = j + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        vi = nj * w + ni;
        if (isNaN(z[vi])) { nod = vi; break; }
        var dr = (ze - effOf(vi)) / W_DD[t];
        if (dr > 1e-9 && dr > bDrop) { bDrop = dr; bIdx = vi; }
      }
      if (nod >= 0) { path.push(nod); reason = "nodata"; break; }

      if (bIdx >= 0) {
        var pk = pondId[bIdx];
        if (pk) {                                  /* arriving into an existing pond */
          path.push(bIdx);
          if (ponds[pk].outlet < 0) { reason = "pond"; break; }
          cur = ponds[pk].outlet; path.push(cur);
        } else { cur = bIdx; path.push(cur); }
        continue;
      }

      /* ---- a pit: flood it until water escapes (§2 "Pond (fill-spill)") ---- */
      var pid = ponds.length;
      var P = { level: z[cur], outlet: -1, entry: cur, zmin: z[cur], count: 0, sumZ: 0,
                bb: [w, h, -1, -1], blocked: false };
      ponds.push(P);
      heapClear(H);
      heapPush(H, z[cur], (h - 1 - j) * w + i); stamp[cur] = pid;
      var level = z[cur], outlet = -1, ui, uj, uidx, nm, rr;
      /* v12 §2 "the pond rule": an inlet inside a filling depression is a pour
         point at its rim. `pend` holds the CONDUIT indices the flood has reached
         but whose rim the level has not; they are re-tested on every rise, and
         each conduit enters the list once (with the first cell that reached it)
         so the list stays a handful of entries however big the flood is. */
      var pend = CD ? [] : null, viaInlet = -1, pi, prim;
      if (CD) for (pi = 0; pi < CD.length; pi++) cdSeen[pi] = 0;
      while (H.n > 0) {
        nm = heapPop(H); rr = (nm / w) | 0; ui = nm - rr * w; uj = h - 1 - rr;
        uidx = uj * w + ui;
        if (pondId[uidx]) continue;
        if (H.topKey > level) level = H.topKey;
        pondId[uidx] = pid;
        P.count++; P.sumZ += z[uidx];
        if (z[uidx] < P.zmin) P.zmin = z[uidx];
        if (ui < P.bb[0]) P.bb[0] = ui; if (uj < P.bb[1]) P.bb[1] = uj;
        if (ui > P.bb[2]) P.bb[2] = ui; if (uj > P.bb[3]) P.bb[3] = uj;
        if (ui === 0 || uj === 0 || ui === w - 1 || uj === h - 1) { reason = "window"; exitIdx = uidx; break; }

        /* The rim is the conduit's own (a surveyed invert where one exists),
           else the inlet cell's own ground — §2. The inlet is tested before the
           natural escape: on a tie the water the user told us about wins, and
           where the natural pour point is genuinely lower the flood stops there
           first anyway, at a lower level.

           An inlet counts as REACHED when the flood FLOODS ITS CELL — §4's
           ruling, and the only version in which the cell that triggers is by
           construction a cell the water is standing in. The consequence is worth
           knowing: a SURVEYED INVERT lower than the lidar ground around it can
           still be missed, because its cell is never popped. The Herman
           discharge pipes are exactly that — mouths at 1341.55 ft in ground the
           2-ft lidar reads at 1344.4-1344.9, above the 1343.84 rim spill — so
           the raindrop takes the impoundment over its rim while the overtopping
           tool, which is handed the surveyed levels explicitly
           (docs/V10_WATER_SPEC.md §10), discharges through the pipes first. That
           is a difference in what each tool was told, not a disagreement about
           the terrain, and it closes when the pipe mouths are surveyed. */
        if (CD) {
          reach(uidx);
          var bestRim = Infinity;
          for (pi = 0; pi < pend.length; pi++) {
            var pk = pend[pi];
            if (cdUsed[pk]) continue;
            prim = CD[pk].rim;
            if (prim == null || !isFinite(prim)) prim = z[cdCell[pk]];
            if (prim <= level + 1e-9 && prim < bestRim) { bestRim = prim; viaInlet = cdCell[pk]; }
          }
          if (viaInlet >= 0) { outlet = viaInlet; break; }
        }

        var eNod = -1, eIdx = -1, eDrop = -1;
        for (t = 0; t < 8; t++) {
          ni = ui + W_DI[t]; nj = uj + W_DJ[t];
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          vi = nj * w + ni;
          if (isNaN(z[vi])) { eNod = vi; break; }
          if (pondId[vi]) continue;
          /* ESCAPES: below the rising surface AND draining to a sink strictly
             below it. F_v === level for every cell of this depression, so the
             test on F must be strict — with `<=` the flood "escapes" into a cell
             a hundredth of a foot under its own water surface and stops there. */
          if (z[vi] < level - 1e-9 && F[vi] < level - 1e-6) {
            var ed = (level - z[vi]) / W_DD[t];
            if (ed > eDrop) { eDrop = ed; eIdx = vi; }
          }
        }
        if (eNod >= 0) { path.push(eNod); reason = "nodata"; break; }
        if (eIdx >= 0) { outlet = eIdx; break; }
        for (t = 0; t < 8; t++) {
          ni = ui + W_DI[t]; nj = uj + W_DJ[t];
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          vi = nj * w + ni;
          if (isNaN(z[vi]) || pondId[vi] || stamp[vi] === pid) continue;
          stamp[vi] = pid; heapPush(H, z[vi], (h - 1 - nj) * w + ni);
        }
      }
      /* completion: everything still under the pour level is under water unless it
         escapes (then it is a wall, and the flood never crosses it). Without this
         the polygon is only the cells the climb happened to pop, not the pond. */
      if (outlet >= 0) {
        while (H.n > 0 && H.k[0] <= level + 1e-9) {
          nm = heapPop(H); rr = (nm / w) | 0; ui = nm - rr * w; uj = h - 1 - rr;
          uidx = uj * w + ui;
          if (pondId[uidx]) continue;
          if (z[uidx] < level - 1e-9 && F[uidx] < level - 1e-6) continue;
          pondId[uidx] = pid;
          P.count++; P.sumZ += z[uidx];
          if (z[uidx] < P.zmin) P.zmin = z[uidx];
          if (ui < P.bb[0]) P.bb[0] = ui; if (uj < P.bb[1]) P.bb[1] = uj;
          if (ui > P.bb[2]) P.bb[2] = ui; if (uj > P.bb[3]) P.bb[3] = uj;
          for (t = 0; t < 8; t++) {
            ni = ui + W_DI[t]; nj = uj + W_DJ[t];
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            vi = nj * w + ni;
            if (isNaN(z[vi]) || pondId[vi] || stamp[vi] === pid) continue;
            if (z[vi] > level + 1e-9) continue;
            stamp[vi] = pid; heapPush(H, z[vi], (h - 1 - nj) * w + ni);
          }
        }
      }
      P.level = level; P.outlet = outlet;
      if (reason) break;
      if (outlet < 0) { reason = "pond"; break; }
      cur = outlet; path.push(cur);
      /* the pond drained through a grate, not over its rim: the run leaves the
         ground at the inlet cell it just stopped on and reappears at the outlet */
      if (viaInlet >= 0) {
        P.viaConduit = CD[inletAt[viaInlet]].id;
        var oc2 = followChain(inletAt[viaInlet], viaInlet);
        if (oc2 < 0) { reason = "conduit"; break; }
        path = [oc2]; segs.push(path); cur = oc2;
      }
    }
    if (!reason) reason = "steps";
    if (onProgress) onProgress(0.92);

    /* the run, as [x,y,z] triples; simplifyPath carries the third element
       through. `length_ft` and `lengthRaw_ft` are the OVERLAND length: the pipe
       is measured separately in `pipe_ft`, because the two are different
       quantities and adding them would hide the one the user is going to survey. */
    var tol = job.simplifyFt == null ? 0.6 * cell : job.simplifyFt;
    var raw = [], rawLen = 0, zEnd = NaN, k, sIx, sK;
    var sp = [], segLen = [];
    for (sIx = 0; sIx < segs.length; sIx++) {
      var segCells = segs[sIx], rawSeg = [];
      for (k = 0; k < segCells.length; k++) {
        i = segCells[k] % w; j = (segCells[k] - i) / w;
        var pz = z[segCells[k]];
        rawSeg.push([X0 + i * cell, Y0 + j * cell, pz]);
        if (!isNaN(pz)) zEnd = pz;
        if (k) rawLen += Math.hypot(rawSeg[k][0] - rawSeg[k - 1][0], rawSeg[k][1] - rawSeg[k - 1][1]);
      }
      for (k = 0; k < rawSeg.length; k++) raw.push(rawSeg[k]);
      var spSeg = tol > 0 ? simplifyPath(rawSeg, tol) : rawSeg;
      segLen.push(spSeg.length);
      for (k = 0; k < spSeg.length; k++) sp.push(spSeg[k]);
    }
    /* every leg departs from the LAST vertex of the stretch it ended, so the app
       can draw the pipe between pts[at] and the leg's own `to` and the vertex
       after it (in the next stretch) is the outlet */
    for (k = 0, sK = 0; k < legs.length; k++) {
      var end = 0;
      for (sIx = 0; sIx <= legs[k].seg && sIx < segLen.length; sIx++) end += segLen[sIx];
      legs[k].at = end - 1;
    }
    var pts = new Float64Array(sp.length * 3), len = 0;
    for (sIx = 0, k = 0; sIx < segLen.length; sIx++) {
      for (sK = 0; sK < segLen[sIx]; sK++, k++) {
        pts[k * 3] = sp[k][0]; pts[k * 3 + 1] = sp[k][1]; pts[k * 3 + 2] = sp[k][2];
        if (sK) len += Math.hypot(sp[k][0] - sp[k - 1][0], sp[k][1] - sp[k - 1][1]);
      }
    }

    var out = [];
    for (k = 1; k < ponds.length; k++) {
      var Q = ponds[k];
      if (Q.blocked || !Q.count) continue;
      var depth = Q.level - Q.zmin;
      if (depth < minDepth) continue;
      var ei = Q.entry % w, ej = (Q.entry - ei) / w;
      out.push({
        level: Q.level, depth_ft: depth, cells: Q.count,
        area_ft2: Q.count * cell * cell,
        volume_ft3: (Q.level * Q.count - Q.sumZ) * cell * cell,
        rings: pondRings(pondId, k, w, h, cell, X0, Y0, Q.bb),
        entry: [X0 + ei * cell, Y0 + ej * cell],
        outlet: Q.outlet < 0 ? null : [X0 + (Q.outlet % w) * cell, Y0 + (((Q.outlet - Q.outlet % w) / w)) * cell],
        via: Q.viaConduit || null
      });
    }
    var last = raw[raw.length - 1];
    if (onProgress) onProgress(1);
    return {
      result: {
        pts: pts, n: sp.length,
        length_ft: len, lengthRaw_ft: rawLen,
        fall_ft: raw[0][2] - zEnd,
        reason: reason,
        end: [last[0], last[1], last[2]],
        zEnd_ft: zEnd,
        exit: exitXY ? exitXY
          : (exitIdx < 0 ? null : [X0 + (exitIdx % w) * cell, Y0 + (((exitIdx - exitIdx % w) / w)) * cell]),
        ponds: out, cell: cell, steps: steps,
        legs: legs, pipe_ft: pipeFt
      },
      transfer: [pts.buffer]
    };
  }

  function pondRings(pondId, id, w, h, cell, X0, Y0, bb) {
    var i0 = Math.max(0, bb[0] - 1), j0 = Math.max(0, bb[1] - 1);
    var i1 = Math.min(w - 1, bb[2] + 1), j1 = Math.min(h - 1, bb[3] + 1);
    var bw = i1 - i0 + 1, bh = j1 - j0 + 1;
    if (bw < 2 || bh < 2) return [];
    var sub = new Uint8Array(bw * bh), i, j;
    for (j = 0; j < bh; j++) for (i = 0; i < bw; i++)
      sub[j * bw + i] = pondId[(j0 + j) * w + i0 + i] === id ? 1 : 0;
    var rings = traceMask(sub, bw, bh, cell, X0 + i0 * cell, Y0 + j0 * cell, 0.5 * cell), out = [];
    for (i = 0; i < rings.length; i++) out.push(rings[i].pts);
    return out;
  }

  /* ---- CATCHMENT -----------------------------------------------------------
     job: { grid, x, y }  — every cell whose D8 path over the FILLED dem reaches
     the drop cell (§2 "Catchment"). On F rather than z so a path is never lost in
     a puddle, which is the same reason the raindrop ponds instead of stopping.  */
  function catchment(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell, z = g.z, n = w * h;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var F = fillDem(z, w, h, onProgress, 0, 0.5);
    var i, j, t, ni, nj, vi, k;

    var down = new Int32Array(n);
    for (i = 0; i < n; i++) down[i] = -1;
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      k = j * w + i;
      if (isNaN(z[k])) continue;
      var best = -1, bd = 1e-9;
      for (t = 0; t < 8; t++) {
        ni = i + W_DI[t]; nj = j + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        vi = nj * w + ni;
        if (isNaN(z[vi])) continue;
        var d = (F[k] - F[vi]) / W_DD[t];
        if (d > bd) { bd = d; best = vi; }
      }
      down[k] = best;
    }
    if (onProgress) onProgress(0.75);

    var si = Math.round((job.x - X0) / cell), sj = Math.round((job.y - Y0) / cell);
    if (si < 0 || sj < 0 || si >= w || sj >= h) throw new Error("the point is outside the terrain window");
    var start = sj * w + si;
    if (isNaN(z[start])) throw new Error("no surveyed terrain under that point");

    var seen = new Uint8Array(n), stack = new Int32Array(n), sp = 0, cells = 0, edge = false;
    var bb = [w, h, -1, -1];
    seen[start] = 1; stack[sp++] = start;
    while (sp > 0) {
      var c = stack[--sp]; cells++;
      i = c % w; j = (c - i) / w;
      if (i === 0 || j === 0 || i === w - 1 || j === h - 1) edge = true;
      if (i < bb[0]) bb[0] = i; if (j < bb[1]) bb[1] = j;
      if (i > bb[2]) bb[2] = i; if (j > bb[3]) bb[3] = j;
      for (t = 0; t < 8; t++) {
        ni = i + W_DI[t]; nj = j + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        vi = nj * w + ni;
        if (seen[vi] || down[vi] !== c) continue;
        seen[vi] = 1; stack[sp++] = vi;
      }
    }
    if (onProgress) onProgress(0.9);
    var rings = maskRings(seen, w, h, cell, X0, Y0, bb, 0.5 * cell);
    if (onProgress) onProgress(1);
    return { result: { area_ft2: cells * cell * cell, cells: cells, rings: rings,
                       touchesEdge: edge, cell: cell }, transfer: [] };
  }

  /* ---- OVERTOP -------------------------------------------------------------
     job: { grid, seedRing | seedPoint:[x,y], plateauTol=0.3, rimRange=3,
            levelStep=0.25, maxClusters=12, outlineTol=null,
            z0Override=null,   // today's water surface from a survey, when the lidar plateau is stale
            levels=null }      // extra stage rows at exact elevations (a pipe invert, a crest)

     z0Override (spec §10): the seed set is still found from the lidar plateau
     (the water's footprint), but every seed cell is then treated as water whose
     ground is unknown and whose surface is z0Override: its level is z0Override,
     its storage counts (L - z0Override), and z0 / freeboard / the stage table
     start there. The lidar plateau is reported as z0_lidar.                    */
  function overtop(job, onProgress) {
    var g = job.grid, w = g.sw, h = g.sh, cell = g.cell, z = g.z, n = w * h;
    var X0 = g.x0 + g.i0 * cell, Y0 = g.y0 + g.j0 * cell;
    var pTol = job.plateauTol == null ? 0.3 : job.plateauTol;
    var rimRange = job.rimRange == null ? 3 : job.rimRange;
    var step = job.levelStep == null ? 0.25 : job.levelStep;
    var maxCl = job.maxClusters == null ? 12 : job.maxClusters;
    var i, j, t, ni, nj, vi, k;

    /* ---- the water surface (§2 "Water surface") --------------------------- */
    var seed = new Uint8Array(n), z0 = NaN, seedCells = 0;
    if (job.seedRing && job.seedRing.length >= 3) {
      var inside = ringMask(job.seedRing, w, h, cell, X0, Y0);
      var vals = new Float64Array(n), m = 0;
      for (i = 0; i < n; i++) if (inside[i] && !isNaN(z[i])) vals[m++] = z[i];
      if (m) {
        z0 = medianOf(vals, m);
        for (i = 0; i < n; i++)
          if (inside[i] && !isNaN(z[i]) && Math.abs(z[i] - z0) <= pTol) { seed[i] = 1; seedCells++; }
      }
    } else if (job.seedPoint) {
      var pi = Math.round((job.seedPoint[0] - X0) / cell), pj = Math.round((job.seedPoint[1] - Y0) / cell);
      if (pi >= 0 && pj >= 0 && pi < w && pj < h && !isNaN(z[pj * w + pi])) {
        z0 = z[pj * w + pi];
        var st = new Int32Array(n), sp2 = 0, s0 = pj * w + pi;
        seed[s0] = 1; seedCells = 1; st[sp2++] = s0;
        while (sp2 > 0) {
          var c0 = st[--sp2]; i = c0 % w; j = (c0 - i) / w;
          for (t = 0; t < 8; t++) {
            ni = i + W_DI[t]; nj = j + W_DJ[t];
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            vi = nj * w + ni;
            if (seed[vi] || isNaN(z[vi]) || Math.abs(z[vi] - z0) > pTol) continue;
            seed[vi] = 1; seedCells++; st[sp2++] = vi;
          }
        }
      }
    }
    if (!seedCells) {
      if (onProgress) onProgress(1);
      return { result: { z0: z0, cell: cell, seedCells: 0, seedArea_ft2: 0, primary: null,
                         freeboard_ft: NaN, storage_ft3: 0, area_ft2: 0, clusters: [], stage: [],
                         band: null, spillMask: null, reason: "noseed" }, transfer: [] };
    }

    var F = fillDem(z, w, h, onProgress, 0, 0.45);

    /* ---- the sealed inside-out flood (§2 "Spill (pour point) and rim lows") -
       Sealed: a neighbour water would escape through is a WALL — it is recorded
       as a spill and never flooded — so the flood keeps describing the
       impoundment as its rim is raised, instead of pouring out through the first
       gap and mapping the next valley.                                         */
    var flooded = new Uint8Array(n), wall = new Uint8Array(n), inHeap = new Uint8Array(n);
    var level = new Float32Array(n);
    for (i = 0; i < n; i++) level[i] = NaN;
    var H = heapNew(1 << 16);
    var nFlood = 0;
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      k = j * w + i;
      if (!seed[k]) continue;
      flooded[k] = 1; level[k] = z0; nFlood++;
      for (t = 0; t < 8; t++) {
        ni = i + W_DI[t]; nj = j + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        vi = nj * w + ni;
        if (flooded[vi] || inHeap[vi] || isNaN(z[vi])) continue;
        inHeap[vi] = 1; heapPush(H, z[vi], (h - 1 - nj) * w + ni);
      }
    }
    var z0lidar = z0;
    if (job.z0Override != null && !isNaN(job.z0Override)) {
      z0 = +job.z0Override;
      for (k = 0; k < n; k++) if (seed[k]) level[k] = z0;
    }
    var cur = z0, spills = [], primary = -1, primaryLevel = NaN, primaryNext = -1;
    var reason = "ok", cap = Math.floor(n * 0.6), nm, rr, ci, cj, cidx;
    while (H.n > 0) {
      nm = heapPop(H); rr = (nm / w) | 0; ci = nm - rr * w; cj = h - 1 - rr;
      cidx = cj * w + ci;
      if (flooded[cidx] || wall[cidx]) continue;
      if (H.topKey > cur) cur = H.topKey;
      var esc = false, bestN = -1;
      for (t = 0; t < 8; t++) {
        ni = ci + W_DI[t]; nj = cj + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        vi = nj * w + ni;
        if (flooded[vi] || isNaN(z[vi])) continue;
        if (z[vi] < cur - 1e-9 && F[vi] < cur - 1e-6) {
          esc = true; wall[vi] = 1;
          if (bestN < 0 || z[vi] < z[bestN]) bestN = vi;
        }
      }
      flooded[cidx] = 1; level[cidx] = cur; nFlood++;
      if (esc) {
        spills.push(cidx);
        if (primary < 0) { primary = cidx; primaryLevel = cur; primaryNext = bestN; }
      }
      for (t = 0; t < 8; t++) {
        ni = ci + W_DI[t]; nj = cj + W_DJ[t];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        vi = nj * w + ni;
        if (flooded[vi] || wall[vi] || inHeap[vi] || isNaN(z[vi])) continue;
        inHeap[vi] = 1; heapPush(H, z[vi], (h - 1 - nj) * w + ni);
      }
      if (primary >= 0 && cur > primaryLevel + rimRange) break;
      if (nFlood > cap) { reason = "window"; break; }
      if (onProgress && ((nFlood & 32767) === 0)) onProgress(0.45 + 0.40 * Math.min(1, nFlood / cap));
    }
    if (onProgress) onProgress(0.85);
    if (primary < 0) {
      return { result: { z0: z0, cell: cell, seedCells: seedCells, seedArea_ft2: seedCells * cell * cell,
                         primary: null, freeboard_ft: NaN, storage_ft3: 0, area_ft2: 0,
                         clusters: [], stage: [], band: null, spillMask: null,
                         reason: reason === "window" ? "window" : "nospill" }, transfer: [] };
    }

    /* ---- quantities at the primary spill ---------------------------------- */
    var sp = primaryLevel, area = 0, storage = 0, bb = [w, h, -1, -1], flist = [], fn = 0;
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      k = j * w + i;
      if (!flooded[k]) continue;
      flist.push(k);
      if (i < bb[0]) bb[0] = i; if (j < bb[1]) bb[1] = j;
      if (i > bb[2]) bb[2] = i; if (j > bb[3]) bb[3] = j;
      if (level[k] <= sp + 1e-9) {
        area++;
        var zg = seed[k] ? z0 : z[k];             // a water cell's ground is its surface
        if (zg < sp) storage += sp - zg;
      }
    }
    fn = flist.length;
    area *= cell * cell; storage *= cell * cell;

    /* ---- rim-low clusters (8-connected groups of spill cells) -------------- */
    var isSpill = new Uint8Array(n);
    for (k = 0; k < spills.length; k++) isSpill[spills[k]] = 1;
    var lab = new Int32Array(n), clusters = [], stk = new Int32Array(spills.length + 1);
    for (k = 0; k < spills.length; k++) {
      var s0i = spills[k];
      if (lab[s0i]) continue;
      var id = clusters.length + 1, sp3 = 0, cnt = 0, lo = s0i;
      lab[s0i] = id; stk[sp3++] = s0i;
      while (sp3 > 0) {
        var c1 = stk[--sp3]; cnt++;
        if (level[c1] < level[lo]) lo = c1;
        i = c1 % w; j = (c1 - i) / w;
        for (t = 0; t < 8; t++) {
          ni = i + W_DI[t]; nj = j + W_DJ[t];
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          vi = nj * w + ni;
          if (!isSpill[vi] || lab[vi]) continue;
          lab[vi] = id; stk[sp3++] = vi;
        }
      }
      clusters.push({ rank: 0, level: level[lo], x: X0 + (lo % w) * cell,
                      y: Y0 + (((lo - lo % w) / w)) * cell, cells: cnt, above_ft: level[lo] - sp });
    }
    clusters.sort(function (a, b) { return a.level - b.level; });
    clusters = clusters.slice(0, maxCl);
    for (k = 0; k < clusters.length; k++) clusters[k].rank = k + 1;

    /* ---- stage table (§2 "Stage table") ------------------------------------
       Area counts flooded cells with level <= L; storage adds max(0, L - z) over
       them — the max matters only for the seed, where a cell can stand up to
       plateauTol above today's water surface. Both are bucketed once and prefix
       summed, so 40-odd rows cost one pass instead of forty.                   */
    var nSteps = Math.max(1, Math.floor((sp + rimRange - z0) / step + 1e-9) + 1);
    var cA = new Float64Array(nSteps + 1), cN = new Float64Array(nSteps + 1), cZ = new Float64Array(nSteps + 1);
    for (k = 0; k < fn; k++) {
      var fc = flist[k], lv = level[fc], zc = seed[fc] ? z0 : z[fc];
      var ka = Math.ceil((lv - z0 - 1e-9) / step); if (ka < 0) ka = 0;
      if (ka <= nSteps) cA[ka]++;
      var act = lv > zc ? lv : zc;
      var kb = Math.ceil((act - z0 - 1e-9) / step); if (kb < 0) kb = 0;
      if (kb <= nSteps) { cN[kb]++; cZ[kb] += zc; }
    }
    var stage = [], aAcc = 0, nAcc = 0, zAcc = 0, a2 = cell * cell;
    var smask = new Uint8Array(n);
    var oTol = job.outlineTol == null ? 0.5 * cell : job.outlineTol;
    for (k = 0; k < nSteps; k++) {
      var L = z0 + k * step;
      aAcc += cA[k]; nAcc += cN[k]; zAcc += cZ[k];
      for (var q2 = 0; q2 < fn; q2++) if (level[flist[q2]] <= L + 1e-9) smask[flist[q2]] = 1;
      stage.push({ level: L, area_ft2: aAcc * a2, storage_ft3: (L * nAcc - zAcc) * a2,
                   rings: maskRings(smask, w, h, cell, X0, Y0, bb, oTol) });
      if (onProgress) onProgress(0.85 + 0.13 * (k + 1) / nSteps);
    }
    /* exact rows at the caller's own elevations (a pipe invert, a sandbag
       crest): a direct pass each, no bucketing, inserted in level order and
       flagged so the UI can tell them from the regular steps */
    var extra = job.levels || [];
    for (var e0 = 0; e0 < extra.length; e0++) {
      var Lx = +extra[e0];
      if (isNaN(Lx) || Lx < z0 - 1e-9) continue;
      var aX = 0, sX = 0, emask = new Uint8Array(n);
      for (k = 0; k < fn; k++) {
        var xc = flist[k];
        if (level[xc] > Lx + 1e-9) continue;
        aX++; emask[xc] = 1;
        var zgx = seed[xc] ? z0 : z[xc];
        if (zgx < Lx) sX += Lx - zgx;
      }
      var row = { level: Lx, area_ft2: aX * a2, storage_ft3: sX * a2, extra: true,
                  rings: maskRings(emask, w, h, cell, X0, Y0, bb, oTol) };
      var at = 0;
      while (at < stage.length && stage[at].level < Lx - 1e-9) at++;
      if (at < stage.length && Math.abs(stage[at].level - Lx) < 1e-9) stage[at] = row; else stage.splice(at, 0, row);
    }

    /* ---- the rim band and the spill cells --------------------------------- */
    var band = new Float32Array(n), sm = new Uint8Array(n);
    for (i = 0; i < n; i++) band[i] = NaN;
    for (k = 0; k < fn; k++) {
      var bc = flist[k], bl = level[bc];
      if (bl > sp + 1e-9 && bl <= sp + rimRange + 1e-9) band[bc] = bl - sp;
    }
    for (k = 0; k < spills.length; k++) sm[spills[k]] = 1;

    var px = primary % w, py = (primary - px) / w;
    var nx2 = primaryNext < 0 ? null : primaryNext % w;
    if (onProgress) onProgress(1);
    return {
      result: {
        z0: z0, z0_lidar: z0lidar, cell: cell, seedCells: seedCells, seedArea_ft2: seedCells * a2,
        primary: { level: sp, x: X0 + px * cell, y: Y0 + py * cell,
                   next: primaryNext < 0 ? null
                       : [X0 + nx2 * cell, Y0 + (((primaryNext - nx2) / w)) * cell] },
        freeboard_ft: sp - z0, storage_ft3: storage, area_ft2: area,
        clusters: clusters, stage: stage,
        /* x0/y0 are the CENTRE of cell (0,0); an image overlay of v spans
           x0-cell/2 .. x0+(nx-0.5)*cell (bx0..bx1 below), row 0 = south. */
        band: { nx: w, ny: h, x0: X0, y0: Y0, cell: cell, v: band,
                bx0: X0 - cell / 2, by0: Y0 - cell / 2,
                bx1: X0 + (w - 0.5) * cell, by1: Y0 + (h - 0.5) * cell },
        spillMask: { nx: w, ny: h, x0: X0, y0: Y0, cell: cell, v: sm },
        reason: reason
      },
      transfer: [band.buffer, sm.buffer]
    };
  }

  function runJob(kind, job, onProgress) {
    if (kind === "volume") return volumeGrid(job, onProgress);
    if (kind === "isopach") return isopachGrid(job, onProgress);
    if (kind === "raster") return demRasterRGBA(job, onProgress);
    if (kind === "contours") return contoursFromGrid(job, onProgress);
    if (kind === "design") return designGrid(job, onProgress);
    if (kind === "balance") return balancePad(job, onProgress);
    if (kind === "sections") return sectionsSample(job, onProgress);
    if (kind === "wand") return pileWand(job, onProgress);
    if (kind === "cbound") return contourBoundary(job, onProgress);
    if (kind === "toecrest") return toeCrest(job, onProgress);
    if (kind === "stands") return canopyStands(job, onProgress);
    if (kind === "trees") return treeDetect(job, onProgress);
    if (kind === "flowpath") return flowpath(job, onProgress);
    if (kind === "overtop") return overtop(job, onProgress);
    if (kind === "catchment") return catchment(job, onProgress);
    throw new Error("unknown compute job: " + kind);
  }

  /* Installed only inside the worker (see js/jobs.js workerSource()). */
  function installWorker(scope) {
    scope.onmessage = function (ev) {
      var msg = ev.data || {};
      var id = msg.id;
      if (msg.type === "ping") { scope.postMessage({ id: id, type: "pong" }); return; }
      var last = -1;
      var onProgress = function (p) {
        var q = Math.round(p * 20);
        if (q === last) return;
        last = q;
        scope.postMessage({ id: id, type: "progress", p: p });
      };
      try {
        var out = runJob(msg.kind, msg.job, onProgress);
        scope.postMessage({ id: id, type: "done", result: out.result }, out.transfer || []);
      } catch (e) {
        scope.postMessage({ id: id, type: "error", message: String((e && e.message) || e) });
      }
    };
  }

  var api = {
    VERSION: 6,
    runJob: runJob,
    volumeGrid: volumeGrid,
    isopachGrid: isopachGrid,
    demRasterRGBA: demRasterRGBA,
    contoursFromGrid: contoursFromGrid,
    simplifyPath: simplifyPath,
    designGrid: designGrid,
    balancePad: balancePad,
    sectionsSample: sectionsSample,
    pileWand: pileWand,
    contourBoundary: contourBoundary,
    toeCrest: toeCrest,
    canopyStands: canopyStands,
    treeDetect: treeDetect,
    flowpath: flowpath,
    overtop: overtop,
    catchment: catchment,
    fillDem: fillDem,
    topHatResidual: topHatResidual,
    discExt: discExt,
    dgridAt: dgridAt,
    installWorker: installWorker
  };
  api.moduleSource = SBMMComputeModule.toString();
  return api;
})();
