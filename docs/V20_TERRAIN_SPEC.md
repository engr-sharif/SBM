# SBMM Site Explorer — v20: tiled terrain, on-demand payloads, GPU rendering (authoritative)

Owner/decider: the planner. Executor: one agent (P2). Decided by the
engineer 2026-09-05. Hard constraints as in CLAUDE.md, and one of them is the
whole difficulty here: **everything must open from a folder over `file://`
and from a single HTML file** — so "on demand" means injecting `<script src>`
tags, never `fetch`. Every golden stays; `js/compute.js` is not touched by
this round (Agent W owns it in `docs/V21_WASM_SPEC.md`); the runner is how the
matrix runs. `SBMM.elev / demAt / demForBox / dems` and `drapeZ` keep their
signatures — every consumer of terrain goes on working unchanged.

---------------------------------------------------------------------------

## 1. Why

Boot parses ~90 MB of base64 before the first paint, the 3D terrain is one
mesh per DEM decimated by `strideFor(dem, 640)` (so the 1-ft data is never
drawn at 1 ft), the ortho drape is one texture per DEM, and an iPad holds all
of it in memory at once. The engineer wants the whole site at the finest data
we have, and an app that grows with the next survey.

## 2. Tile pyramids — `tools/build_tiles.py` → `datajs/tiles/`

- **Source**: the same masters `tools/build_dems_from_master.py` and the
  ortho tools read today (where the master is absent on this box, build from
  the current `data/*.png`/`.jpg`, and say so in the payload's `source`).
- **Layout**: a quadtree per raster (`dem`, `ortho`, `hillshade`, `chm`,
  `cover`), levels from the finest cell size the data has (1 ft where the
  1-ft windows exist, 2 ft elsewhere) up to a 64-ft overview, **256 × 256
  tiles**, each tile one payload file `datajs/tiles/<layer>_<z>_<x>_<y>.js`
  setting `SBMM_TILES["<layer>/<z>/<x>/<y>"]` (DEM tiles as terrain-RGB PNG
  base64, the others JPEG/PNG base64), plus one index payload
  `datajs/tiles/index.js` (`SBMM_TILES.index`: bounds, levels, cell sizes,
  tile counts, NoData tiles listed so they are never requested, byte sizes).
  A tile is never larger than 200 kB.
- **The loader** (`js/tiles.js`, `SBMM.tiles`): `get(layer, z, x, y)` returns
  a promise; in the folder build it injects a `<script src="datajs/tiles/…">`
  tag (works over `file://`, over `http`, and inside the offline copy — the
  service worker's precache list gains the tile index and a "download all
  tiles" option); in the single-file builds every tile is already inlined
  and `get` resolves immediately. An LRU cache with a byte budget (default
  256 MB desktop, 96 MB `body.touch`), eviction by distance from the view,
  a request queue with priority by screen coverage, cancellation on view
  change. Decoding in the existing DEM decode workers (`js/dem.js` gains a
  tile path; the per-payload path stays for the fallback).
- **The seams**: `SBMM.elev/demAt/demForBox` keep answering from the SAME
  three whole-site grids as today (they are the analysis source and the
  goldens depend on them); tiles are the DISPLAY and 3D source. The two
  must agree: the harness samples 1,000 random surveyed points and requires
  the tile pyramid's finest level to equal the grid to the terrain-RGB step.

## 3. Level-of-detail terrain — `js/viewer3d.js` (the terrain half)

- A quadtree of tile meshes selected per frame by screen-space error
  (target 2 px), frustum culled, with skirts to hide cracks between levels,
  morphing optional; the finest level draws the 1-ft data at 1 ft inside
  the mine and residential windows. Each tile mesh carries its own drape
  texture from the ortho pyramid (anisotropy as v17); the "drape" selector
  (ortho / hillshade / slope / cover) switches the pyramid, not the mesh.
- NoData handling exactly as today (skip cells touching NoData; the
  coverage rule for the 1-ft holes in the 2-ft mesh becomes a per-tile
  rule: a coarse tile is not drawn where finer tiles cover it entirely).
- `drapeZ` and the overlay drape keep reading the analysis grids; the
  parity table, the labels, the water animation and the stage surface are
  untouched and must stay green.
- Memory budget: geometry + texture LRU with the same byte budget; the 3D
  perf harness reports tiles drawn, triangles, textures, bytes; idle
  renders stay 0; a view change requests frames only until the queue is
  empty.
- The detail selector (std / high) becomes "quality" (screen error 4 / 2 /
  1 px), remembered as today; phones default to 4.

## 4. GPU rendering of the analysis rasters (WebGL2)

Hillshade, slope, aspect and the display contours are computed in fragment
shaders from the DEM tiles (the sun-angle control of v15 then relights the
whole terrain live), replacing the CPU rasters for DISPLAY only. The
analytic contours (`contoursFromGrid`, exported to DXF) and every kernel stay
on the CPU and are the source of truth; the harness compares a shader
hillshade against the CPU hillshade on one tile (mean abs diff < 2/255).
Falls back to the CPU rasters when WebGL2 is absent, and says so.

## 5. WebGPU — a bounded feasibility step, then a decision

Spend at most one working day: can a WebGPU renderer run in this app's
constraints (no bundler, no `fetch`, opens over `file://` and as a single
file)? three.js ships its WebGPU renderer as ES modules only. Try an inline
`<script type="module">` with an inline import map over `file://` and inside
the single-file build; try Chromium's software WebGPU here
(`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`) for the harness.
If it works: a renderer switch (`SBMM.view.pref("renderer")`, default
WebGL2, WebGPU opt-in in View settings) with the WebGL2 path byte-for-byte
the default and every harness run on WebGL2. If it does not: write down
exactly why in CLAUDE.md and stop; the WebGL2 work above stands on its own.

## 6. Acceptance

Boot on the folder build parses < 12 MB of payload before the loader hides
(`test/boot_time.mjs` records the stage table before and after); the
single-file builds boot as today (they inline everything). 3D: the ABP at
quality 2 px draws 1-ft tiles (the harness reads `stats().tiles` and the
finest level drawn); triangles and bytes within the budget; `test/perf.mjs`
frame cost recorded before/after with everything on; idle renders 0; the
parity table unchanged; `split3d`, tablet, field all green. Goldens
unchanged (the analysis grids are not touched). Shots `test/terrain_shots.mjs`
→ `tiles_abp_1ft.png`, `tiles_site.png`, `gpu_hillshade.png`. Docs: CLAUDE.md
(the two sources rule: grids for analysis, tiles for display; the loader's
`<script>` injection; the budget; the WebGPU finding), README, HANDOFF,
release notes. No model names.

## 7. Not in scope

Any kernel; the offline copy beyond the tile precache option; the map's
2D tiles (Leaflet already tiles the orthos by zoom from the image overlays —
leave it, unless the same pyramid can feed it for free).
