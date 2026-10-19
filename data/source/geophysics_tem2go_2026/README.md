# TEM2Go geophysics survey, 2026 — as delivered

`SBMM_TEM2Go-visualization_v1.html` is the contractor's standalone viewer, kept
verbatim. It is the source, not part of the app: nothing in `index.html` loads it,
and it pulls three.js, fonts and imagery tiles from the internet, which the app
never does.

The data is the `const D = {...}` literal on one line of that file:

| key | contents |
|---|---|
| `id` | 1,032 sounding ids |
| `lat`, `lon` | WGS84 |
| `e`, `n` | UTM zone 10N, metres |
| `z` | ground elevation, metres |
| `top`, `bot` | 20 model layers, depth in metres (0–100 top, 1–120 bottom) |
| `r` | resistivity, ohm·m, 1,032 × 20, `r[i*20 + layer]` |

Checked against the app (not assumed): through `data/affine.json` the soundings
cover E 6,370,946–6,372,289 / N 2,127,097–2,128,638 (EPSG:6418, ~1,340 × 1,540 ft),
median spacing 15.4 ft, and every one lands on surveyed lidar. Sounding `z` minus
the Jan-2024 lidar is median −0.21 ft (p5 −0.79, p95 +0.54, worst −2.2 / +3.0).

The app's copy is built from this file by `tools/build_tem2026.py`
(`data/tem2026.json`, `datajs/d_tem2026.js`), and the `tem` kernel in
`js/compute.js` is a port of the viewer's interpolation that
`test/kernels.mjs --only tem` checks against this file's own script.
