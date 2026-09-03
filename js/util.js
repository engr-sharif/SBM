/* SBMM Site Explorer — utilities */
"use strict";
window.SBMM = window.SBMM || {};
/* boot timing marks are installed by index.html's head script; stub them if that
   ever goes missing so nothing here has to null-check */
window.SBMM_PERF = window.SBMM_PERF || { marks: [], mark: function () {}, report: function () { return []; } };
SBMM.perf = window.SBMM_PERF;

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v == null || isNaN(v) ? "—" :
  v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt0 = v => v == null || isNaN(v) ? "—" : Math.round(v).toLocaleString("en-US");
const sig2 = v => {
  if (!isFinite(v)) return "—";
  if (v === 0) return "0";
  const m = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 1);
  return (Math.round(v / m) * m).toLocaleString("en-US");
};
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function polyArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function polyPerimeter(p) { let s = 0; for (let i = 0; i < p.length; i++) s += dist2d(p[i], p[(i + 1) % p.length]); return s; }
function lineLength(p) { let s = 0; for (let i = 1; i < p.length; i++) s += dist2d(p[i - 1], p[i]); return s; }
function pointInPoly(x, y, p) {
  let inn = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inn = !inn;
  }
  return inn;
}
function centroid(p) {
  let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; }
  return [x / p.length, y / p.length];
}
function samplePerimeter(p, step) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], d = dist2d(a, b), n = Math.max(1, Math.round(d / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
/* Douglas–Peucker simplification, tolerance in ft */
function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const a = pts[i0], b = pts[i1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
    let dmax = -1, imax = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs(dx * (a[1] - pts[i][1]) - dy * (a[0] - pts[i][0])) / L;
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > tol) { keep[imax] = 1; stack.push([i0, imax], [imax, i1]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* small toast */
function toast(msg, ms = 2600) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
}
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function copyText(s, okMsg) {
  const done = () => toast(okMsg || "copied to clipboard");
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(s).then(done, () => fallbackCopy(s, done));
  else fallbackCopy(s, done);
}
function fallbackCopy(s, done) {
  const ta = document.createElement("textarea");
  ta.value = s; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("copy failed — see console"); console.log(s); }
  ta.remove();
}
/* color ramps: t in [0,1] -> [r,g,b] */
function lerpRamp(stops, t) {
  t = clamp(t, 0, 1);
  const n = stops.length - 1, f = t * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
const RAMPS = {
  slope: [[46, 89, 58], [122, 168, 82], [222, 199, 84], [226, 133, 62], [204, 66, 57], [131, 54, 122]],
  hypso: [[38, 84, 105], [64, 130, 109], [141, 166, 92], [216, 187, 122], [190, 138, 96], [236, 232, 227]],
  heat:  [[38, 74, 110], [56, 136, 156], [116, 196, 145], [222, 199, 84], [226, 133, 62], [204, 66, 57]],
  cutfill: [[178, 60, 50], [226, 133, 62], [240, 236, 228], [92, 156, 196], [40, 84, 140]], /* cut red -> fill blue */
  canopy: [[230, 225, 205], [140, 180, 110], [60, 130, 70], [20, 80, 45]] /* low scrub -> tall tree */
};
