# SBMM Site Explorer — Claude Code handover

Terrain workbench for the Sulphur Bank Mercury Mine OU1 Superfund site (Jacobs, Task 2.1.5).
A fully client-side web app: 2D map (Leaflet) + 3D terrain (Three.js) over the site's
lidar-derived survey, with CAD drafting, earthworks/volume analysis, smart boundary
tools, and a canopy/tree layer. The user (Nawaz) is an AutoCAD/Civil 3D user on an
environmental remediation team; features are modeled on that daily workflow.

**Start here:** this file (technical), then `docs/HANDOFF.md` (who the user is, how he
wants to work, decisions made in conversation, open items in priority order, the delivery
procedure), then `docs/V9_SPEC.md` (the v9 design contract and its status). Together they
replace the chat history that built v1–v9. `RELEASE_NOTES_v9.md` is the user-facing summary.

## The two hard constraints — never violate these

1. **Everything must work over `file://`, double-clicked, no server.** That means:
   - **No `fetch()`/XHR for app data, ever.** All data ships as `<script>` payloads
     (`datajs/*.js` setting `SBMM_DATA[...]`) with images as base64 data-URLs.
     (The original version of this app used fetch and hung forever on file:// — that
     bug is the reason this architecture exists.)
   - Web Workers are created from **Blob URLs**; the worker source comes from
     `Function.prototype.toString()` on the compute module (see `js/compute.js` +
     `js/jobs.js`) because a worker file can't be fetched over file://.
   - No ES modules, no bundler, no framework. Plain scripts listed in `index.html`.
2. **THREE builds from one source, all of them must pass tests:**
   - Folder build: `index.html` + `js/` + `datajs/` + `vendor/` (this repo, also
     GitHub-Pages hostable).
   - Single-file build: `python tools/build_dist.py` → `dist/SBMM_Site_Explorer.html`
     (~133 MB, everything inlined — the copy the team double-clicks; the 20 full-sheet
     plan renders are ~27 MB of that).
   - **Field build** (v11 §4.2): `python tools/build_dist.py --field` →
     `dist/SBMM_Site_Explorer_field.html` (~65 MB — the copy that opens on a phone).
     Same source, same inlining, ONE exclusion list in `FIELD_EXCLUDE`: the 20
     `i_sheet_full_*` renders, `i_chm_png` + `d_chm`, `d_cad_surfaces`, `d_cad_native`.
     Everything else stays, the sheet MANIFEST included.
     **Payload-tolerance rule: every module that reads an excluded payload must
     degrade with a row, a note or a toast — never an error, and never silence.**
     `js/sheets.js` keeps a render-less sheet in the index and refuses `open()` with a
     toast; `js/sheetcards.js` draws the card without a thumbnail; `js/refsurf.js`,
     `js/layerman.js`, `js/isopach.js`, `js/trees.js`, `js/smartbound.js` and
     `js/viewer3d.js` already say so. `test/e2e_field.mjs` asserts zero page errors at
     boot and that each refusal toasts.
     Both single-file builds stamp `window.SBMM_BUILD` (`"full"` / `"field"`), which
     `js/util.js` copies onto `SBMM_DATA.build`; ask it through `SBMM.isField()`.

     New JS files MUST be added to `index.html`'s script list or both dists silently
     lack them. Note: `build_dist.py` stamps the build *before* inlining because
     `js/report.js` contains a literal `</title>` inside a template string.

## Running tests (do this after every change)

```
cd test && npm install && npx playwright install chromium && cd ..   # once per machine
node test/e2e.mjs     /abs/path/index.html                folder
node test/e2e.mjs     /abs/path/dist/SBMM_Site_Explorer.html dist
node test/split3d.mjs /abs/path/index.html                folder
node test/split3d.mjs /abs/path/dist/SBMM_Site_Explorer.html dist
node test/e2e_field.mjs /abs/path/dist/SBMM_Site_Explorer_field.html field
node test/e2e_tablet.mjs /abs/path/index.html                tablet
```
`test/e2e_tablet.mjs` is the v17 harness: Playwright's **`iPad Pro 11 landscape`**
descriptor (1194x834, DPR 2, touch) against the FOLDER build, served BOTH ways —
`file://` for everything, and a static `http` server the harness starts itself
(node `http` + `fs`, no dependency) for the manifest, the icons and the service
worker. Chromium, because WebKit is not installed here. Its six sections are
§6's: boot and the profile, the profile switches, the 3D gesture set, the sheet
viewer, the map + the Pencil + the chrome, and the offline copy.
**`test/touch_unit.mjs` is the fast loop for it** — node, no browser, ~1 s, 56
checks over the gesture recogniser's arithmetic; run it after any change to
`js/touch.js` before you start a browser.
`test/e2e_field.mjs` is the third build's harness (v11 §4.5): Playwright's **`Pixel 7`**
descriptor (touch, 412x839, DPR 2.625) against the FIELD dist. It re-states the six
sections §4.5 names — boot, the gate (unlocked by TAP), terrain, the golden Pile 1 volume,
water and the survey — and adds the field-mode and field-capability assertions: the six
44-px actions, the Layers sheet opening and closing by tap, a popup arriving as a bottom
card, a raindrop by tap, Position refusing without a permission grant and landing within
2 ft with one, a photo from `test/fixtures/photo_exif.jpg` placed at its EXIF GPS ±2 ft and
surviving a session round trip, and a one-finger orbit / two-finger pinch in 3D. It is a
separate file rather than a build switch inside `test/e2e.mjs` **deliberately**: that file
is 4,200 lines of flat top-level statements over one shared page and one accumulating
scene, and it has to keep passing UNCHANGED on the other two builds. Pass the full dist as
a third argument to get the boot comparison. Optional fixture regeneration:
`python3 tools/make_photo_fixture.py`.
The harnesses use Playwright's own chromium unless `CHROME_BIN` points at one (the cloud
build box's `/opt/pw-browsers/...` path is tried first and skipped if absent); paths are
resolved through `pathToFileURL`, so Windows paths work. Runs are slow under software GL
(180 s default timeouts are intentional). All four must pass.
**`test/kernels.mjs` is the fast loop — a node harness, no browser, covering EVERY kernel
in `js/compute.js`'s `runJob`.** Run it after any change to `js/compute.js` or to a call
site that builds a job, before you reach for Playwright. Everything except `drainage` is
~48 s; the `drainage` section adds ~175 s of its own because its acceptance test is 100
chained raindrops (§11.4), so **`--only` everything else while you iterate and run the
whole thing before you ship**:
```
node test/kernels.mjs                  # every section (345 checks, ~3.7 min)
node test/kernels.mjs --only water     # one or more sections, comma-separated
node test/kernels.mjs --only drainage  # ~3 min on its own — the v14 identity
node test/kernels.mjs --list           # volume isopach raster contours design sections smart
                                       #   trees water storm water3d drainage
node test/water_kernels.mjs            # a thin alias for --only water
```
It loads `js/compute.js` through `vm.runInThisContext` (the module is context-free, which
is the whole point of it) plus `vendor/d3-delaunay.min.js` for the volume job's perimeter
TIN, and prints every check as `PASS/FAIL name got ref tolerance` with a per-kernel wall
time; any FAIL exits non-zero. Three rules govern it:

- **Each section builds its job the way the app builds it** and names the call site it
  mirrors (`js/tools.js` buildVolumeJob, `js/isopach.js` show, `js/design.js` jobFor,
  `js/smartbound.js` runWand/runCbound/runToe/runStands, `js/sections.js` regenerate,
  `js/analysis.js` demRaster/contoursFromDem, `js/trees.js` detect, `js/water.js`
  traceRun/overtop, `js/storm.js` conduitsFor). A harness that invents its own job proves the kernel runs,
  not that the app is right.
- **Every number has a provenance**: a published golden (Pile 1's 278.4 yd³, EA's printed
  excavation area, `docs/V10_WATER_SPEC.md` §9), an arithmetic identity (2πr for a cone's
  contour ring, a bilinear port for a section's ground, `cutA − fillA` = the plain
  trapezoid), or a value **recorded from this commit** — those say so in a comment and are
  labelled regression guards.
- **A new kernel gets a section here before it ships.** The harness greps `runJob`'s
  dispatch and fails on any kind it does not cover.
- **Every raster kernel honours a windowed `gridSpec`** (`i0/j0/sw/sh`), and the harness
  proves it by shipping the same ground both as a window of the site grid and as a
  standalone sub-grid and requiring identical output (`contours`, `raster`). Before v9.7
  `contoursFromGrid` and `demRasterRGBA` sized their sweep from `g.w/g.h` and silently read
  NaN outside the window; every caller happened to pass a whole grid. Do not reintroduce a
  `g.w`-sized sweep. Two more v9.7 rules live in the kernels: `contours` drops any polyline
  shorter than a tenth of a sweep cell (the sub-0.1-ft stubs marching squares leaves when
  two crossings round into different chaining keys — 43 of 262 on the 10-ft site set), and
  `sections` dead-bands its end areas with the isopach's `isoTol` (the same
  `zstepDesign`/`zstepGround` the isopach ships, from `js/sections.js`) and returns the
  per-sample `tol` so the harness can restate the cut−fill identity through it.

Terrain comes from `test/lib/terrain.mjs` — `loadDem` in `js/dem.js`'s exact layout,
`gridSpec`/`gridsFor` ported verbatim from `js/jobs.js`, `loadSurface` reading EA's design
rasters out of `datajs/d_cad_surfaces.js` — over `test/lib/png.mjs`, a decoder for the only
PNG this repo ships (8-bit RGB/RGBA, non-interlaced; anything else throws by name).
Decoded grids are cached under **`test/.cache/`** (gitignored, ~230 MB) keyed by the PNG's
size and mtime, which is the whole difference between a 2 s cold decode and a 0.2 s warm one — touch
a PNG and it misses. `test/fixtures/` holds the water references (`drop_ref.json`,
`herman_ref.json`) and the planner's two independent Python implementations
(`waterref.py`, `survey_stage_ref.py`), which are the tie-breakers when a definition is
unclear; the water windows are now cut from the real PNGs with `gridSpec` and the harness
asserts their shape before it asserts anything measured in them.
`test/water_shots.mjs` writes the four v10 water shots (raindrop 2D/3D, Herman
overtopping 2D/3D) into `test/shots/` and `test/storm_shots.mjs` the two v12 storm shots
(the south-road grate chain with a Frog Pond raindrop on it, and the network draped in 3D);
neither is pass-fail — look at them.
`test/drainage_shots.mjs` writes the three v14 drainage shots (drainage_2d — the whole
site by outlet, drainage_click — the outfall's contributing area highlighted, drainage_3d)
into `test/shots/`; not pass-fail — look at them.
`test/field_shots.mjs` writes the four v11 field shots (field_map, field_layers,
field_photo, field_3d) into `test/shots/` on the Pixel 7 descriptor; not pass-fail — look
at them.
`test/v9_shots.mjs` writes the §11 audit shots (2D, 3D, split, a sheet window with a mark,
the cultural acknowledgement, the Layer manager, the isopach) into `test/shots/`;
`test/phaseB_shots.mjs` writes the sheet-viewer / layers / dataset screenshots. Neither is
pass-fail — look at them. Four more diagnostics, none of them pass-fail — run them when you
have changed behaviour, and read the output:
```
node test/boot_time.mjs /abs/path/index.html 3     # boot to first interaction + the stage table
node test/perf.mjs   /abs/path/index.html folder   # 3D / memory numbers (its layer-toggle loop
                                                   #   drives SBMM.layerState, not checkboxes)
node test/audit.mjs  /abs/path/index.html folder   # every tool, command, dialog + its toasts
node test/audit2.mjs /abs/path/index.html folder   # sheet viewer, properties, split, report
```
**Run the browser harnesses one at a time.** Two software-GL renderers on a two-core box
crash the compositor ("Target crashed"), which looks like a test failure and is not one.

**Golden number:** Pile 1 (Fig 2 traced) perimeter-TIN volume = **278.4 yd³ fill /
−48.1 net** (±10). If a change moves it, the change is wrong (or you changed the
terrain source, which needs an explicit decision + README/test update).

## Coordinates & data

- CRS: NAD83(2011) California State Plane Zone 2, **US survey feet** (EPSG:6418).
  Leaflet runs `CRS.Simple` with `latlng = [Y, X]` (northing, easting). Elevations ft.
  WGS84 via a local affine (`data/affine.json`, ±1 ft): `SBMM.toLL/fromLL`.
- Terrain: **three DEMs, one ordered stack.** `data/dem_site` (2-ft grid, whole site),
  `data/dem_abp` (1-ft, "mine area" window E 6370069–6372941, N 2127238–2131120 — the
  key name is historical, the window is bigger than the ABP) and, since v9,
  `data/dem_res` (1-ft, the residential lots: E 6369890–6371440, N 2126050–2130370 =
  the residential design bbox + a 60-ft working buffer). Terrain-RGB PNG encoding:
  `v = R*256+G`, `z = zmin + (v−1)*step`, `v=0` nodata, PNG row 0 = north. Source: the
  surveyor's LandXML 1-ft lidar-derived bare-earth grid (Jan-30-2024 flight), NOT the
  CAD contours (those are display-only layers now).
  **`SBMM.dems` is the stack and the order is a decision: `[demAbp, demRes, demSite]`.**
  dem_abp and dem_res are both 1 ft and they overlap; dem_abp wins the tie because it
  is the older, more-exercised grid and every golden number was measured on it. Ask it
  through `SBMM.elev` / `SBMM.slopeAt` (per point), `SBMM.demAt(x,y)` (finest DEM with
  data there) or `SBMM.demForBox(bbox)` (finest DEM covering a whole footprint — what
  the volume, design and smart-boundary jobs need, so a quantity is never half 1-ft and
  half 2-ft). `gridsFor()` in `js/jobs.js` ships the same list, finest-first, to the
  workers; `js/compute.js` `elevOf` relies on that order. **Do not write new code that
  names two DEMs.** Adding a fourth window is a line in `SBMM.setDems()`.
- `data/chm` = canopy height model (1-ft, same grid as dem_abp), from the raw LAS
  point cloud, cleaned (despeckle + pit-free close + masked blur). Optional payload —
  the app must boot without it.
- Orthos: 3-in ABP crop, 6-in mine area, 1.5-ft site. Hillshades jpg.
- **Regeneration** (only when source data changes): the master rasters are NOT in the
  repo (too big). They live on the user's machine:
  `SBMM\LiDAR and Aerial Survey Data\_staging\master_1ft.f32` (ground) and the CHM f32.
  Pipeline order: `tools/build_dems_from_master.py` → `tools/build_chm_png.py` →
  `tools/build_ortho_mine.py` → `tools/build_data.py` (data/ → datajs/) →
  `tools/build_dist.py`. For normal code work you never touch this.
- Two more generators, both needing files off the user's machine and neither on the
  normal path: `tools/build_sheet_fulls.py` (full 36×24 sheet JPGs for the viewer, from
  the two Appendix A PDFs) and `tools/add_dataset.py` (a CSV → `data/datasets/ds_*.json`).

## Code map (`js/`, load order = `index.html`)

| file | owns |
|---|---|
| gate.js | **the password gate** — the FIRST script in `index.html`, before the vendor bundles and the payloads. Full-viewport cover at z 9000, SHA-256 check, remembered unlock, the animated contour field and the flood/reveal unlock |
| util.js | formatting, geometry helpers, ramps, toast; `$()` |
| touch.js | **the three touch profiles, the ONE gesture recogniser, the loupe, the Done bar and the offline copy (v17)** — `SBMM.touch`: `profile()` / `on()` / `override()` / `lastPointer()`, `gestures(el, handlers)`, `momentum`, the shared loupe and Done bar, long-press-as-right-click, the tooltip chip, the map's press-hold vertex placement, the wake lock, the device diagnostics and the `sw.js` client |
| redline.js | **freehand ink (v17 §5a)** — the `ink` store feature, event-resolution capture with `getCoalescedEvents`, pressure-driven width per vertex, the 6-swatch palette and eraser, the map host and (through `js/sheetmarks.js`) the sheet-window host; `SBMM.redline` |
| labels.js | **the 2D label engine (v15 §2.2)** — one registry for every permanent map label, dedupe by `key`, a greedy screen-space collision pass by priority, `visibility:hidden` never `display`, per-label zoom `gate()`; `SBMM.labels` |
| compute.js | **pure** compute kernels (volume grid, rasters, marching squares, ring-aware simplify) — no DOM, no SBMM; runs in workers |
| jobs.js | worker pool: progress, cancel, transferables; `SBMM.compute` |
| dem.js | DEM decode — the Blob-URL **decode worker** and `Dem.loadAll` (one worker per payload, all started together) with the main-thread path as the fallback — plus bilinear `at()`, slope/aspect; the DEM stack `SBMM.dems` / `setDems` / `demAt` / `demForBox`; `SBMM.elev`, `SBMM.slopeAt`, `SBMM.canopy` |
| proj.js | affine SP↔WGS84, coordinate parsing |
| state.js | feature store (select/groups/visible/locked), `readd`, **undo AND redo** (both closures required), sessions (v7; loads v2+) |
| layerstate.js | **`SBMM.layerState` — the one answer to "is this layer on"** — plus the `SBMM.events` bus ('layers', 'mode', 'view') |
| view.js | `SBMM.view` — remembers the 2D centre/zoom and the 3D orbit camera in localStorage and restores them on boot (guarded, debounced, range-checked) |
| mode.js | **`SBMM.mode` — the tool-mode state machine (§2)**: modes, cursor, Mode HUD, every single-key shortcut, Esc discipline, Space-to-pan; also `SBMM.status` (the status bar, written by both views) |
| shell.js | dock layout, left tabs (Layers/My work/Sheets), right tabs (Inspector/Results) + their auto-switch, four-stage topbar narrowing, job bar |
| map.js | Leaflet init, layer-row API `SBMM.addLayerRow` (a row is a VIEW onto `SBMM.layerState`), zoom-gated annotation, context menu |
| layertree.js | **`SBMM.layerTree` — the VIEW over `SBMM.layerState` (v16)**: sub-groups declared with `addLayerRow(..., {sub})`, legend swatches drawn from the layer's own symbology, the per-row hover toolbar (opacity / zoom to extent / solo / info), drag-to-reorder = draw order, fuzzy search, keyboard, presets, recently-changed chips, the legend card on the map |
| layers.js | basemaps, survey contours, DUs, piles, samples (+symbology); `SBMM.layersUI` — the six §4 groups, master checkboxes, count badges, Areas quick-nav; `SBMM.myWork` — the class mask over the user's own features |
| analysis.js | slope/aspect/hypso/canopy raster layers, custom contours |
| draw.js | sketch engine: vertex edit, ortho/polar, typed input (`@150<45`), 3D hooks |
| snap.js | object snaps (grid-hash index, glyph overlay canvas, F3) |
| cmdline.js | command bar (`` ` `` / Ctrl+K / `/`), 49 AutoCAD-alias commands (LOCK is one), all routed through `SBMM.mode` |
| results.js | result cards panel |
| tools.js | measure tools + volume engine (perimeter-TIN memo method + plane/rim/fixed/design bases, range, cut/fill map) + modify tools (offset/mirror/rotate/copy/move/join/explode) + dim/text |
| design.js | design surfaces: graded/sloped pads, daylight lines, auto-balance |
| sections.js | stationed cross-sections, end-area check, CSV |
| report.js | print-ready report sheets (browser Print → PDF) |
| smartbound.js | WAND (memo top-hat pile delineation), CBOUND (contour-snap), TOE, STANDS |
| trees.js | individual tree detection over CHM, canvas dot layer, CSV inventory |
| io.js | GeoJSON (WGS84 + EPSG:6418) / session / CSV import-export |
| dxf.js | DXF R12 export + R12/2000 import, raw SP ft |
| designea.js | EA residential design **from the PDFs**: sheet rasters, extracted boundaries, surveyed nodes, per-sheet 3D drape toggle, sheet-footprint click target (read-only project data, NOT `SBMM.store` features). Boundary layer defaults **off** since v8 |
| designgis.js | EA residential design **native geometry** (geodatabase + CAD) — 14 layers, the authority; supersedes designea's boundaries |
| sheets.js | floating sheet viewer — full uncropped plots of all 20 drawings, zoom/pan/drag/resize windows, SHEETS command, "locate on map" |
| datasets.js | generic point datasets (baked + imported CSV): mapping dialog, styled layers, popups, tables, CSV/GeoJSON/DXF export, osnap, 3D dots + depth sticks |
| table.js | table drawer: Samples tab (140 locations, Hg/As) + `SBMM.dsTable`, one tab per dataset |
| features.js | feature-manager tree (folders, eye, lock) |
| viewer3d.js | 3D: meshes, drapes, canopy, contours, orbit+fly nav, split mode, draw-in-3D |
| refsurf.js | EA's four recovered design surfaces as read-only `type:'surface'` store features (§5) — locked, not serialised, re-created on boot |
| isopach.js | isopach overlay (cut/fill vs lidar), volume-in-polygon-vs-surface, "volume of this excavation"; the comparison tolerance of F9 lives in `compute.js` `isoTol` |
| water.js | **v10 water, v13 conduit spill** — the raindrop (`flow` feature type, window chaining, ponds, catchment) and the overtopping analysis (rim band, ranked rim lows, level slider, stage–storage chart, overflow route, the surveyed stages of §10); `SBMM.water` |
| survey.js | the **August-2026 Jacobs survey** linework (`data/survey_2026.json`: the two 24-in HDPE discharge pipes, the sandbag wall, the NW Pit low) as read-only rows under Investigations; snap, 3D, export; `SBMM.survey` — the survey's 24 shots are a baked dataset, not this module |
| storm.js | **v12 storm drainage** — EA's storm structures and storm line, the six CAD culvert marks, Jacobs' two surveyed 24-in pipes and the south-road grate chain, as read-only project data (`data/storm_network.json`): three layer rows under Site framework, rims from `SBMM.elev` on boot, the "storm drains work" switch, per-conduit broken/working, snap, 3D, exports, and `conduitsFor(bbox)` — the list `js/water.js` hands the kernel; `SBMM.storm` |
| drainage.js | **v14 Phase 1 — the drainage map**: the `drainage` kernel run once over the whole site, three read-only layer rows under a *Drainage* sub-header in Site framework, the outlet table and its CSV/GeoJSON/DXF, "show what drains here" on any storm popup, the catchments draped in 3D; `SBMM.drainage` |
| runoff.js | **v14 Phase 2 — the design storm**: the `runoff` kernel over the Phase 1 catchments, the rainfall and land-cover payloads, the `RAIN` dialog, the results card with its hydrograph, level-pool routing of the three ponds through the `overtop` kernel's stage table, the report sheet, the CSV, and two layer rows (the cover raster with a CN legend, the runoff depth as a choropleth); `SBMM.runoff` |
| layerman.js | the Layer manager dialog: search / toggle / recolour / opacity / source + handle for EA's 110 CAD layer names |
| sheetcards.js | the Sheets tab — a card per drawing with a thumbnail derived on first open, filtered by lot |
| field.js | **field mode (`body.field`) and the field capabilities (§4)** — the trigger and `SBMM.field`, the slim top bar / bottom action bar / More sheet, docks as bottom sheets, popups as bottom cards, Position (`watchPosition`, never fabricated), Photo (the `photo` feature type + a small EXIF reader), Note, Samples nearby |
| popups.js | **the** popup builders — `SBMM.popups.forFeature/forDataset/forGis/forCad/forSample/forTree/forTerrain`. 2D binds them through Leaflet, 3D drops the same string into the pick card |
| watermark.js | the "Mo Sharif - Jacobs 2026" element AND the burn-in every canvas export goes through (`burn`, `burnWebGL`) |
| cultural.js | cultural resources (CONFIDENTIAL): off by default, acknowledgement gate, stamp, export gating |
| pick3d.js | 3D pick registry, hover, identify card, 3D vertex handles |
| sheetmarks.js | measuring and marking inside a sheet window; sheet px ↔ State Plane, one affine per plan viewport where a sheet has several (C-202) |
| boot.js | startup sequence, error reporting, first-run hint |

## Boot cost and the payload contract

Boot is dominated by two things and nothing else is worth chasing until they change:
**parsing the vendor bundles** and **parsing ~90 MB of base64 string literals** (dist only).
The terrain decode used to be the third, and since v11 it is not — it happens in workers.
`test/perf.mjs` and `test/boot_time.mjs` print the stage-by-stage numbers
(`SBMM.perf.report()` in the console, or append `?perf` to the URL — the marks are always
collected, they just stay quiet).

- **The four terrain payloads decode in four dedicated workers, started together** (v11,
  `js/dem.js` worker-side decode section + the loader in `js/boot.js`). `Dem.loadAll(names)`
  runs `atob` on the main thread — the string lives there and that is the only part that
  must — **transfers** the bytes, and the worker does `createImageBitmap` →
  `OffscreenCanvas` → `drawImage` → `getImageData` → the terrain-RGB → Float32 loop and
  transfers the `Float32Array` back. On this 2-core box that took the terrain block from
  1,246 ms to 683 ms and boot-done from a 2.54 s median to 1.66 s.
  - **The worker is built the way `js/jobs.js` builds the compute worker**:
    `demDecodeWorkerMain.toString()` into a Blob URL. That is the only technique that works
    in both builds — nothing can be fetched over `file://`, and `tools/build_dist.py`
    inlines `js/dem.js` verbatim so the function's source text is byte-identical. It is NOT
    the compute pool: no job protocol, no `js/compute.js`, one message each way. Keep
    `</script` out of that function's source (`js_safe` in the builder would mangle it) and
    keep it self-contained — no `SBMM`, no DOM.
  - **The loop was moved, not rewritten.** `Dem.load` is still there and is still the
    fallback (no `Worker`, no `OffscreenCanvas`/`createImageBitmap` — feature-detected
    *inside* the worker, which replies `{unsupported:true}` — a construction throw, an
    error, or a timeout). The e2e decodes a synthetic terrain-RGB PNG both ways and requires
    the two `Float32Array`s to agree cell for cell, NoData included.
  - **The release happens only once a `Float32Array` exists**, so a worker that fails still
    leaves the base64 string in place for the fallback to read.
  - `SBMM.perf.demWorkers` (payloads that really decoded in a worker; the e2e asserts ≥ 3)
    and `SBMM.perf.demDecode` (per payload: ms, worker, megapixels) are the diagnostics.
    The per-payload boot marks keep their old names — `dem-site`, `dem-abp`, `dem-res`,
    `chm` — but they now land in **completion** order, so the stage table's deltas are gaps
    between finishes, not per-payload costs. Read `SBMM.perf.demDecode` for those.
- **Never decode a data-URL through `new Image()` + `img.decode()`.** That path re-parses
  the base64 through the resource loader: 1168 ms for the 4850x4450 site DEM. `atob` →
  `Blob` → `createImageBitmap` does the same work in ~290 ms because the bytes are handed
  straight to an off-thread decoder. Both the worker and `Dem.context()` do this, with the
  old path kept as a last-resort fallback. This one change was ~1.5 s of the boot.
- **The CHM stays inside the loader — deferring it was tried and reverted.** Moving it off
  the boot path bought ~0.55 s of time-to-interactive and spent it on a ~0.6 s main-thread
  stall landing one to three seconds later, on whatever the user had already started (it
  showed up as a phantom "1.3 s layer toggle" in `test/perf.mjs`). It is now the third of
  four payloads to land inside the loader and costs the boot nothing extra, so there is
  nothing left to defer. The seams stay: everything that consumes canopy heights awaits
  `SBMM.chmReady` (an already-resolved promise), and the canopy Layers row is built by
  `SBMM.buildCanopyLayer()` rather than inline.
- **`SBMM_DATA.dem_site_png / dem_abp_png / dem_res_png / chm_png` are set to `null`
  once decoded** — 31 MB of string nothing reads twice. The *keys* stay (the dual-build
  contract), and the e2e asserts both halves of that. Do not add a second reader of those
  four. `dem_res` and the CHM are both optional payloads and the app boots without either;
  `Dem.loadAll` takes them as `optional` and a missing one is a `console.warn`, not a
  failed boot.
- Building the survey-contour polylines, the DUs, the piles and the samples is 40-60 ms
  total. It looks like the expensive part of boot and is not — measure before you move it.

## Hard-won gotchas (each of these was a real bug)

- **Closed rings + Douglas–Peucker**: naive DP collapses closed rings (first==last ⇒
  zero-length baseline). Use the ring-aware `simplifyPath` in compute.js everywhere.
- **Volume integration step is sized from the polygon BBOX**, not its area — sliver
  polygons (e.g. from 3D raycast clicks near the horizon) otherwise explode the loop.
- Worker job params: guard absent parameters with explicit defaults — `x > 0` is
  silently false for `undefined` (this once disabled the WAND slope cutoff entirely).
- 3D meshes: skip any cell touching DEM NoData (else cliff walls at survey limits);
  initialize mesh z-scale from the exaggeration slider; fine-mesh density via
  `strideFor(dem, 640)`.
- The WAND tool reproduces the ABP memo's top-hat method but needs an 18-ft DEM
  pre-smooth + lagged slope measurement on lidar terrain — don't "simplify" that away.
- Canopy exists only in the mine window (only LAS tile A1 was ever delivered); the app
  and tools must degrade gracefully outside it (they do — keep it that way).
- Contour-snap (CBOUND): never contour at the click's exact elevation (degenerate — the
  click sits on the line); it offsets slightly.
- **`preferCanvas` = one opaque `<canvas>` per pane, and the topmost one eats every pointer
  event.** So the moment anything exists in a higher pane — draw one line and the `drawings`
  pane appears — every interactive layer *below* it silently stops responding (DUs, piles,
  samples, design boundaries, dataset symbols, sheet footprints). Nothing errors. `map.js`
  now installs a capture-phase pass-through that hands the event down to the first canvas or
  marker below with something under the pointer. Do not add a new interactive pane without
  adding it there.
- **Two hoisted `function wire` declarations in one module leave only the last one.** In
  `sheets.js` a per-window `wire(st)` was shadowed by the module-level `wire()`: every button
  still worked (wired elsewhere) while wheel-zoom, pan, window drag and resize were never
  attached at all, with no error anywhere. Per-instance wiring is `wireWindow`.
- Sheet-footprint hit rectangles live in the **vectors** pane and call `bringToBack()`, which
  makes them the lowest-priority target in that canvas — a design boundary or sample point
  inside the footprint still wins the click. Only empty ground opens the sheet.
- A `MutationObserver` that watches a pane and then writes into it will spin forever. The
  layer-section count badges only write when the value actually changed, and disconnect around
  the write. The symptom was the app appearing to hang on the next background job.
- `page.evaluate(() => SBMM.sheets.open(...))` fails in Playwright — the returned state object
  holds DOM nodes. Wrap it in a block that returns nothing. `SBMM.layerTree.search(...)` is the
  same trap: it hands back the first matching row, which is a row ref holding DOM nodes.
- **`preferCanvas` also means a Leaflet vector has no DOM element**, so `className` on a path
  reaches nothing: `.sheetpulse` (the "locate" flash) and `.sheethit` (the footprint's
  `cursor: zoom-in`) were both dead CSS. Animate with `setStyle()` and set the cursor on the
  map container instead. Anything you want to style on a vector has to go through options.
- **Arming a measure tool opens an empty sketch immediately**, so `SBMM.draw.isDrawing()` is
  true the moment the button lights up. A plain `cancel()` on Esc therefore tore the sketch
  engine down while the button stayed lit and the cursor stayed a crosshair — after that,
  clicking the map did nothing, with no way out but re-picking the tool. Since v9 the rule is
  §2's: **Esc always cancels the sketch AND returns to Navigate AND clears the highlight**
  (`SBMM.mode.navigate()` tears the sketch, the pick and the edit down together), and
  `tools.mapClick` still starts a fresh sketch if it is ever handed a click with no sketch
  open. The pre-v9 behaviour (re-arm when the sketch had vertices) is gone; do not reinstate
  it, and note the e2e asserts the new contract.
- **Command aliases are resolved first-match over one flat table**, so a duplicate alias
  silently kills the later command's: `REPORT`'s `SHEET` alias shadowed `SHEETS`'. The e2e
  now fails on any duplicate — check before adding an alias.
- **Do not hang a Leaflet layer off a dataset point.** `d.points` is serialised verbatim into
  the session file and the localStorage autosave; a marker on the point makes the structure
  circular, `JSON.stringify` throws, and the autosave's `try/catch` swallows it. Marker
  lookups go through `d.markerOf` (a `Map` keyed by the point object) — needed because real
  coordinate tables repeat IDs, so the old id-keyed map lost points.
- **Overlay z-order is a documented band, not a free-for-all** (see the header comment in
  `css/app.css`). Floating sheet windows re-stack inside 4000-4899 rather than incrementing a
  counter, the SHEETS picker sits at 5200, modals at 5600, and the toast at 7000 — a toast
  behind a sheet window is an error report the user never sees. The e2e asserts the ordering.
- **`scrollIntoView` scrolls the PAGE, not just the pane** — and the page is
  `overflow:hidden`, which stops a *user* scrolling but not a programmatic one. Selecting a
  feature whose results card sat in a panel that was off-screen (in field mode the right
  dock is a bottom sheet, parked at `translateY(105%)`) scrolled the document 453 px, and
  every absolutely positioned thing in the app — the action bar, the status bar, the open
  sheet — moved with it. Nothing errored; the layout silently came apart, and
  `getBoundingClientRect()` disagreed with `getComputedStyle().top` by exactly the scroll.
  `scrollIntoPane()` in `js/util.js` is the fix: find the nearest scrollable ancestor and
  move ITS `scrollTop`/`scrollLeft`, or do nothing. Both call sites (`js/features.js`
  selection, `js/sections.js` station focus) go through it. Do not reintroduce
  `scrollIntoView` anywhere in this app.
- **Esc must reach the front-most thing.** `sheets.js` listens in the capture phase, so it
  bails out when a text field has focus or a modal is open; every modal (help, command help,
  the report, the dataset dialog) closes on Esc and stops propagation so it does not also
  cancel a sketch. A focused sheet window swallows the single-letter tool shortcuts —
  without that, pressing `3` while reading a drawing opened the 3D view behind it.

## The EA native deliverables (v8) — read this before the registration section

**EA delivered their own GIS and CAD in June 2026, and it supersedes everything the PDF
pass produced.** `data/design_gis.json` (0.49 MB, 802 features, 14 layers) is now the
authority for residential design geometry; `js/designgis.js` renders it;
`tools/build_design_gis.py` builds it and documents the sources. The PDF-derived
`design_ea.json` is kept — it is the record of how the sheets were registered, it still owns
every raster and the sheet viewer, and it holds the printed node tables — but its boundary
layer defaults **off** and each boundary with a native counterpart carries
`superseded_by` / `superseded_off_ft`.

- **CRS: the geodatabase says EPSG:2226 (NAD83 / CA zone 2 ftUS), the app is EPSG:6418
  (NAD83(2011)).** Different NAD83 realisations — not identical in general. They were
  checked *empirically*, not assumed: every native excavation limit was compared with the
  independently registered PDF boundary for the same area and agreed to **0.3–1.8 ft**. So
  no reprojection is applied. If a future deliverable disagrees by more than a couple of
  feet, revisit this — do not silently reproject, and do not "fix" it with a shift.
- **The four unregisterable sheets are solved by native geometry, not by registration.**
  C-102 (staging area), C-202 (North Lobe) and C-203 (borrow area) all have exact native
  polygons; C-101 is a site *index* sheet with no unique geometry of its own. The geometry
  is what mattered. Since v9.1 the native polygon has also *placed* C-202's raster (see
  "Registering from native geometry" below); C-101, C-102 and C-203 remain unplaced.
- **Geometry beats EA's layer names.** `C-SITE-DU-LOT-13` and `C-SITE-DU-LOT-15` are
  swapped in EA's CAD with respect to both the lot polygons and the sheet subjects. The
  builder labels from lot containment + the delivered sheet list and flags the conflict on
  the feature (`cad_layer_conflict`). Do not "correct" it the other way.
- **Cultural resources: excluded from THIS payload, included (gated) in the app.**
  The geodatabase also ships `T22_0762_IsolateCurrent` (19 pts) and
  `T22_0762_ResourceCurrentPly` (44 polys) — an archaeological survey of the Elem Indian
  Colony. They must never appear in `design_gis.json`, which goes out with every GeoJSON
  and DXF export unconditionally; **the e2e still fails if they do.** Since v9 they ship
  separately in `datajs/d_cultural.js` under the controlled-inclusion rules below.
- **EA's surfaces ARE now baked — the existing ones. There is still no proposed grade, and
  that is a finding, not a gap.** (This bullet replaces the v8 note that said none of it was
  reachable; half of that turned out to be wrong.) Civil 3D stores surface points as
  **stride-4 little-endian float64 records `(x, y, z, id64)` starting at an arbitrary BIT
  offset** in the object stream — in this project at `bit=1, byte=4`. Earlier attempts failed
  because they swept bit shifts *or* byte offsets, never the product of the two. libredwg
  derails on one object per file and emits the rest of `AcDbObjects` as one ~183.6 MB
  undecoded blob, and the records are in there in plain sight. Recovered and shipped:
  **955,387-point EA existing TIN** (byte-identical in C-BASE / 01.01 / 02.01 / 02.02 — they
  xref the same surface) and **933,112 points from the `.mms` store** (a ZIP whose single
  member is one DEFLATE stream; no `MMS01` reverse-engineering needed). Both validate against
  the lidar master at mean 0.00 / sd 0.16 ft and +0.12 / sd 0.34 ft, which is what proves the
  decode. See `tools/build_cad_surfaces.py` and the "Surfaces" section of
  `data/design/cad_native_report.md`.
- **No proposed-grade TIN exists in the delivered DWGs**, and this was searched exhaustively:
  all 64 (bit, byte) alignments over every byte of every blob and every decoded object's
  `unknown_bits` in C-BASE, 01.01, 02.01 and 02.02. Outside the one existing TIN the only
  hits are 200–500 point sets of dense 3D linework, all of them sitting *on* existing ground
  (the z=1441.0 cluster in the East Stockpile has lidar 1441.0 under it). Proxy graphics are
  dead too — every `AECC_*` preview blob is 676–688 B of `AcDbProxyEntity` header plus the
  UTF-16 class name, because EA saved with `PROXYGRAPHICS` off. `repo_fg` / `nlobe_fg` are
  therefore in `surfaces.json` under `not_recovered`. **If the design grade is genuinely
  needed, ask EA for a LandXML export or a proposed-grade raster** — a one-line request they
  can satisfy from Civil 3D. Still true, and still the rule: **do not synthesise a surface
  from the breaklines and call it the design** — the `grade` group is 47 features / 145
  vertices and `daylight` has a usable Z on 17 of 187, so a Delaunay over them would invent
  the whole pad.
- **The residential remedy is depth-based, not TIN-based**, and that is why `res_excbottom` /
  `res_finish` are legitimate rather than a fallback: EA's sheets say "EXCAVATE WORK AREA TO
  ONE FOOT DEPTH UNLESS OTHERWISE INDICATED", "PROVIDE 12in OF FILL IN ANY UNHATCHED AREA
  INSIDE THE LIMITS OF EXCAVATION AND/ OR FILL" and "TRANSITION TO EXISTING GRADE AT LIMITS
  OF FILL". So excavation bottom = existing − depth and finished grade = existing. The
  **geodatabase `exc` polygons are the authority for the limits** (they reproduce EA's
  printed areas to 0.02 %); EA's CAD draws the limits as open segments that never close, and
  its *closed* polygons on those layers are the small special-treatment sub-areas.
- **Design surfaces manifest**: `data/design/surfaces.json` (schema in `docs/V9_SPEC.md` §5),
  rasters `data/design/surf_*.png`, payload `datajs/d_cad_surfaces.js` — one file, one
  `SBMM_DATA` key per surface named by its `raster.payload`, plus the manifest under
  `cad_surfaces`. Terrain-RGB, the app's standard encoding. Read them through
  `SBMM.CadNative.surfaceElev(id, x, y)`; decoding is lazy and async, so **the first call for
  a surface returns NaN while it kicks the decode off** — `await SBMM.CadNative.surfaceReady(id)`
  when the value has to be right on the first try.
- **Rasterise a recovered TIN over its Delaunay triangulation, not by binning.** EA's TINs are
  ~3.7 ft point spacing; nearest-cell binning onto the 1 ft grid leaves **84 % nodata**, so
  `surfaceElev` returns NaN across most of the residential lots — a raster that looks like a
  surface and behaves like confetti. Interpolate, and drop triangles with an edge > 25 ft so
  the interpolation cannot bridge the concave parts of the (convex) Delaunay hull.
- Converting the DWGs needs **libredwg git master** (`dwg2dxf` 0.14.x, built at
  `/tmp/lw2/programs/dwg2dxf`); release 0.13.3 cannot decode these Civil 3D files.

## Registering an EA design sheet (read before touching `data/design_ea.json`)

**This method is now only for a sheet set that arrives without native files.** When EA
sends GIS/CAD, use it — it is exact, and it is how the four unregisterable sheets got
covered. The notes below stay because the next set may again be PDFs only.

12 sheets are registered; C-101, C-102 and C-203 are not, and README records exactly why
for each. If you attempt one of those, the traps below are the whole problem — unless the
sheet draws a polygon that exists in EA's geodatabase, in which case use the native method
at the end of this section instead.

- **`/VP` is an AutoCAD `/RL` *scale* measure, not GeoPDF `/GEO`.** It looks like
  georeferencing and is not. It does give the exact plan scale — use it, and *lock* it.
- **The sheets are drafted on rotated grids** (observed: 0, ±22.5, −28, −30, −45, −90°).
  Any north-up-locked fit produces confident nonsense.
- **Lock the scale, or the fit means nothing.** With scale fixed, k printed nodes give 2k
  equations against 3 unknowns. A *free* affine through 4 nodes has 6 parameters for 8
  equations and fits essentially anywhere — this is how v6 produced plausible-looking
  answers that were hundreds of feet wrong.
- **Never accept one method.** Two independent lines of evidence must land in the same
  place: the printed node table (vote-fit) and the app ortho (correlation). Calibrate on the
  already-known sheets first — correct transforms agree to 0–2 ft, wrong ones to 60–130 ft.
- **Correlation resolution matters.** At a fixed 2 ft/px a 1"=10' sheet becomes a ~140 px
  template and the peak is meaningless. Scale the render to ~1100 px, floor 0.4 ft/px.
- **Judge absolute NCC peak with care**: it *drops* as resolution rises. Score the
  *agreement* (how far the imagery moves the sheet), not the peak.
- Sheet subjects (which lot each sheet is) come from the 90% set's title blocks — the Final
  set does not name them all. Don't guess a lot number.
- **C-110 is 90% Pre-Final, not Final.** It is flagged `design_set` on the sheet and every
  feature, and badged in the UI. Keep it that way; it is a superseded design.
- Adding a sheet: `data/design/design_Cxxx.png` is globbed by `build_data.py`, but the
  resulting `datajs/i_design_Cxxx_png.js` **must** be added to `index.html`'s script list or
  the overlay is registered, rendered, and invisible.

### Registering from native geometry (v9.1 — how C-202 was placed)

`tools/register_sheet_native.py C-202`. When the plan draws a polygon that exists in
`data/design_gis.json`, that polygon is a node table with every vertex surveyed: C-202's
*Limit of excavation — North Lobe* has 11 vertices (22 equations against 4 unknowns) and
its two southern vertices are the sheet's two printed nodes to 0.02 ft. The tool sweeps
rotation with the scale locked, correlates the outline against the heavy ink, refines
per viewport, locks rotation to the drafting angle (−90°) and scale to the mean fit, and
then confirms independently against the app ortho (which knows nothing of the sheet):
accept only when the imagery moves the plan by the same 0–2 ft the accepted sheets show.
Numbers for C-202 are in README and in the sheet's `design_ea.json` record.

- **C-202 has two plan viewports of the same ground** (grading plan, planting plan). One
  affine for the page is wrong by construction, so `sheets_full.json` carries
  `viewports: [{name, px:[u0,v0,u1,v1], affine}]` beside the primary `affine`, and
  `js/sheetmarks.js` georeferences a pixel through the viewport it falls in, refuses a
  pixel on the title block with a toast, requires every point of one mark to sit on one
  plan, and paints the store into every viewport (clipped to its rectangle). The map
  raster and the 3D drape are the *grading* plan only — two plans of one footprint cannot
  both be draped. `affine_source: "native"` on the record tells `build_sheet_affine.py`
  to leave it alone (its crop-vs-page correlation would keep only the primary viewport).
- C-102 and C-203 are the next candidates: both have exact native polygons. C-203's is a
  symmetric 90 × 120 ft rectangle, so the ortho check has to break a four-fold ambiguity
  there rather than merely confirm.

## v9 additions (agent B: cultural resources, 3D picking, sheet marking, watermark)

### Cultural resources — protected information

Included by an explicit decision of the project lead; before v9 they were excluded
outright. Controlled inclusion, not free access:

- Payload `datajs/d_cultural.js` from `tools/build_cultural.py` (63 features, 2 layers,
  and a record of all 9 geodatabase layers it read). **This is the one place in the app
  that reprojects**: the two cultural layers are delivered in EPSG:26910 (UTM 10N,
  metres) — a different projection in different units, not another realisation of the
  same State Plane zone — so pyproj 26910 -> 2226 is required, and is not the "silent
  reprojection" the EA-deliverables section warns against. The builder gates on the
  result landing inside the site window.
- Group **off by default**; the first enable in a session raises an acknowledgement
  dialog. `js/cultural.js` gates it in the **capture phase** on the checkbox's `click`,
  because `SBMM.addLayerRow`'s own `change` handler would otherwise put the geometry on
  the map before anyone was asked. Declining reverts the checkbox.
- While any cultural layer is visible: a red NHPA s.304 stamp over the map and the 3D
  view, and the same stamp **burned into every exported canvas** (`SBMM.watermark`
  asks `SBMM.cultural.visible()` at burn time, never cached).
- Exports (`SBMM.io.exportGeoJSON`, `SBMM.report.open`, the 3D snapshot) call
  `SBMM.cultural.gateExport(what)` first; a gated GeoJSON carries
  `metadata.confidential` and every feature carries `confidential: true`.
- Read-only project data, like designgis/cadnative: nothing here is a `SBMM.store`
  feature and nothing serialises into a session.

### `SBMM.pick3d` — the 3D pick registry

```
SBMM.pick3d.register({ id, object3d, kind, priority,   // points 3 > lines 2 > polys 1 > terrain 0
                       hit(intersect) -> { title, html, featureId?, xyz } })
SBMM.pick3d.unregister(id)
```

- `js/viewer3d.js` tags every overlay object it builds with `userData.pick` and calls
  `SBMM.pick3d.syncScene()`; that turns the tags into registry rows and drops the
  previous batch. A module that builds its own 3D objects registers directly
  (`registerCad(object3d, feature)` is the ready-made hook for `js/cadnative.js`).
- The popup HTML comes from `js/popups.js`, the same function the 2D map binds — that
  is the only way "the same popup as 2D" can be guaranteed rather than asserted.
- **Click vs drag is 4 px / 200 ms.** The nav rig is a custom orbit controller that
  consumes the same left button, so both thresholds are needed: looser and a careful
  orbit reads as a pick, tighter and a trackpad pick misses, and a press-and-hold that
  ends where it started is a parked camera rather than a pick.
- Raycaster Line/Points thresholds scale with the orbit radius (`nav.st.sph.r`), which
  keeps the *screen* tolerance roughly constant. Hover allocates nothing per frame,
  never raycasts the 1.5 M-vertex terrain (that is click-only, as the fallback), and
  asks for a render only when the highlighted object actually changes.
- The identify card is anchored to a point in **scene** space and re-projected from the
  render loop, so it tracks the object instead of drifting. Esc closes it and stops
  there — it must not also reach the sketch engine.
- 3D vertex handles write through `SBMM.store` / `SBMM.tools.redraw+recompute`, so a
  3D edit and a 2D edit are the same edit. There is no separate 3D geometry model.

### Sheet marking, and the sheet affine that did not exist

`data/sheets_full.json` now carries a per-sheet `affine {a,b,c,d,e,f}` mapping
full-sheet render pixels (u = column, v = row, origin top-left) to EPSG:6418 feet:
`x = a*u + b*v + c`, `y = d*u + e*v + f`. It was **not** there before — the file was a
render index, and `design_ea.json`'s registration describes the *de-rotated crop*, not
the page. `tools/build_sheet_affine.py` recovers it: scale and rotation are already
known from the sheet's own registration, so only a translation is unknown, and phase
correlation of the re-rendered page against the crop's ink recovers it. 11 of 11
PDF-registered sheets came back (ncc 0.31-0.95) — C-202's comes from the native tool
instead and is kept by this one — each confirmed independently by mapping
EA's native geodatabase geometry for that sheet through the affine and requiring it to
land on the paper (79-100 %). A sheet that fails any gate gets `affine: null` and the
viewer refuses to georeference a mark on it — **a wrong affine is far worse than none.**

Marks made in a sheet window become ordinary store features carrying
`props.provenance = {source:"sheet", sheet:"C-107", px:[[u,v],...]}`. `rebuildFeature`
copies `props.provenance` across for every type, so the record survives a session
round-trip even though each branch rebuilds the computed props from geometry.

### Watermark

"Mo Sharif - Jacobs 2026", bottom-right of the stage, 11 px, 55 %, pointer-events none,
z-index 1400 (above map z 1 and 3D z 5, below the sheet windows at 4000). Every canvas
export goes through `SBMM.watermark.burn(canvas)` — or `burnWebGL(glCanvas)` for the 3D
snapshot, because a WebGL canvas has no 2D context to draw into. An element is not in a
PNG; if you add an export path, burn it there too.

## v9 additions (agent C: the shell, the layer state, the mode machine, the surfaces)

### One layer state — `SBMM.layerState` (§1/§4)

```
SBMM.layerState.define(group, id, { label, on, opacity, swatch, persist, apply(state) })
SBMM.layerState.set(group, id, { on?, opacity? })      // the ONE mutation point
SBMM.layerState.isOn(group, id) / opacity(group, id) / setGroup(group, on) / groupState(group)
SBMM.events.on("layers", ({group, layer, state}) => ...)   // layer === null = a group switch
SBMM.events.on("mode",   ({from, to}) => ...)
```

- Groups are the six of §4, in order: `base`, `framework`, `design`, `invest`,
  `cultural`, `mywork`. `js/map.js` maps the legacy `addLayerRow` group keys onto
  them (`terr`/`ana` → `base`, `proj` → `framework`, `data` → `invest`, …), so
  **modules keep calling `SBMM.addLayerRow` unchanged** and get a row that is a
  *view* onto this state rather than the state itself.
- **Do not read a checkbox to decide whether a layer is on.** The checkbox is a
  view. `SBMM.layerState.isOn(...)` is the answer, in 2D, in 3D, in the sheet
  windows and in the exports. There are no 3D visibility checkboxes any more.
- **Subscribers must diff.** `js/viewer3d.js` keys off `(group, layer)`: only
  `framework/design/invest/mywork/cultural` queue an overlay rebuild, and
  `base/contours_*`, `base/canopy` and `design/sheets3d` have their own
  handlers. Toggling an orthophoto must reach no 3D work at all.
- Persisted in localStorage AND in the session file, except rows defined with
  `persist: false` — which is exactly the cultural group, because §7 wants the
  acknowledgement once per session and a remembered checkbox would put protected
  geometry on the map before anyone was asked.
- A row whose `id` anything else addresses passes one explicitly (`dus`, `piles`,
  `samples`, `canopy`, `contours_site`, `contours_abp`, `trees_detected`,
  `sheets3d`, `pdf_boundaries`, `gis_*`, `cad_*`). Otherwise the id is a slug of
  the label, de-duplicated.
- "My work" rows are a CLASS MASK (`SBMM.myWork`), not a per-feature switch: both
  the class row and `f.visible` have to be true for a feature to draw, so hiding
  every measurement does not destroy the per-feature choices underneath.

### The mode machine — `SBMM.mode` (§2)

- One active mode; `SBMM.mode.set(name)` is the only way in, and it owns the
  cursor (`#stage[data-cursor]`), the button highlight and the Mode HUD.
- **`Esc` always returns to Navigate** — see the gotcha above. `Space` held is a
  temporary Navigate that leaves the sketch alone.
- The HUD mirrors `#sketchTip`, which the sketch engine already writes on every
  step, through a `MutationObserver`. `#sketchTip` is now `display:none` — it is
  the machine-readable prompt (and what the tests read); the HUD is the visible
  one. Two copies of "Area — click the boundary…" on one screen is one too many.
- `SBMM.tools.setTool()` still works from anywhere and reports in through
  `SBMM.mode.syncFromTool()`, so a command, a popup action and a keystroke all
  land in the same state. `TOOL_HOME` maps a bare tool name to its default mode,
  and is consulted only when the current mode does not already own that tool.
- `draw.line` / `draw.polygon` deliberately share the sketch engine with
  `measure.distance` / `measure.area` — same feature types, one implementation,
  separate modes.

### EA's design surfaces in the app — `SBMM.refSurf` (§5)

- The four recovered surfaces become read-only store features of type `surface`
  with `props.ref = true` and `props.refId = <manifest id>`. That is what makes
  the volume engine's design base, the cross-sections, the 3D drape and the
  Inspector work with them **with no special case**.
- Read-only means: locked, refused by `SBMM.store.remove`, absent from
  `serialize()`, absent from the GeoJSON/DXF exports and from the osnap index
  (their geometry is a footprint bbox, not drafted linework), absent from the
  "My work" tree — and re-created on boot so a session that measured against one
  still finds it.
- **They carry no `_surf` node grid.** `SBMM.design.elev()` and `gridSpecFor()`
  branch on `props.ref` and read the raster through
  `SBMM.CadNative.surfaceElev`; `gridSpecFor(id, bbox)` windows it so a job over
  one lot does not ship 13 megapixels. Decoding is lazy — **the first
  `surfaceElev` for a surface returns NaN** — so anything that must be right on
  the first try awaits `SBMM.refSurf.ready(id)` and shows a spinner or a toast.
- **Isopach** is a worker kernel (`isopach` in `js/compute.js`). It integrates at
  the surface's own cell size (capped at 8M cells) and *draws* at a display
  budget, and reports both numbers, because a decimated integral costs about 1 %
  on a quantity someone digs from. Sign convention: design minus ground, positive
  is FILL, the same way round as the legend.

### The Layer manager (§6)

`SBMM.CadNative` gained `layerInfo / layerOverride / setLayerOverride /
resetLayerOverrides` and an `objByLayer` index, so overrides survive the dialog
being closed and are re-applied when a group's geometry is rendered later. The
dialog works on EA's own 110 CAD layer NAMES, one level below the 21 UI groups —
that is the vocabulary a Civil 3D user has, and the level at which "what is that
line and which file is it from" gets answered.

### Ruling R1 — who owns "Limits of excavation"

The **geodatabase polygons** (`data/design_gis.json`, `js/designgis.js`) are the
authority: they close, they reproduce EA's printed areas to 0.02 %, and they are
styled by depth (1.0 ft solid red, 0.5 ft dashed orange, depth labelled at the
centroid). EA's CAD `exc` layers are the raw drafting linework for the same
limits — open segments plus small special-treatment sub-areas — and are **off by
default**, held in three places that must stay in step:
`js/cadnative.js` `DEFAULT_OVERRIDES`, `tools/build_cad_native.py` `LAYER_RULES`,
and `data/design/cad_layer_map.json`. The 21 MB payload bakes `default_on`, which
is why the load-time override exists rather than a regeneration.
The e2e guards it: a click on Lot 25 must be answered by a popup naming C-106.
The four 0.5-ft call-outs have **no model-space geometry anywhere in the
delivered CAD** — they are paper-space text — so their markers sit at the
centroid of that sheet's limit of excavation and say so.

### The fix round (planner rulings F1-F11) — the three that are gotchas

Full account in `docs/V9_SPEC.md` "v9 fix round". Three of them are traps that
will be walked into again:

- **Default visibility now has TWO levels, and both have three homes.**
  `DEFAULT_OVERRIDES` (per UI *group*, ruling R1) and `DEFAULT_LAYER_OFF` (per
  EA *CAD layer*, ruling F1) both live in `js/cadnative.js`, and both are
  mirrored in `tools/build_cad_native.py` (`LAYER_RULES` / `LAYER_DEFAULT_OFF`)
  and in `data/design/cad_layer_map.json`. Keep all of them in step; the 21 MB
  payload bakes `default_on`, which is why the load-time overrides exist rather
  than a regeneration. `resetLayerOverrides()` re-seeds `DEFAULT_LAYER_OFF`, so
  "reset to defaults" means the app's defaults, not "everything on".
  Three layers are currently suppressed, all of them paper annotation rather
  than anything on the ground: **`G-ANNO-SYMB`** (EA's sheet viewport frames,
  fourteen big green rectangles in model space — NOT sheet footprints; that is a
  separate real layer in `js/designea.js`), **`G-ANNO-MATC`** (three match
  lines, the longest a dead-straight 3,724 ft rule across the whole site at
  N 2,128,294) and **`G-ANNO-DETL-PROP`** (a detail call-out and its leader,
  parked ~1,700 ft west of the nearest lot, out in the lake).
- **`.lsub` was already taken.** `js/designgis.js` uses it for a sub-header, so
  the collapsible Terrain-analysis sub-section is `.lgsub` / `.lgsubb`. Reusing
  the name hung the boot with a null `querySelector` inside a `forEach`, which
  presents as "building workbench…" forever and no error.
- **Comparing two rasters of different resolution manufactures volume.** The
  isopach reported 180 yd³ of fill on a surface that is all cut by construction;
  every bit of it came from comparing the 1-ft design raster against the 2-ft
  site DEM outside the mine window, plus one nodata-edge spike. `isoTol` in
  `js/compute.js` is the fix: the two rasters' quantisation steps, plus
  `2·|∇z|·(cGround − cDesign)` — which is identically zero wherever the ground
  grid is already as fine as the design, so it cannot eat a real excavation.
  **Do not "simplify" this to a flat tolerance**; a flat one big enough to clear
  the 2-ft region would start eating shallow design cut in the 1-ft region.
  Cut is now 7,542.3 yd³ vs the build-time 7,561.9 (−0.26 %) and fill is 0.6.

## The delivery round (planner rulings D1–D5) — two more gotchas

Full account in `docs/V9_SPEC.md` "v9 delivery round". Beyond the DEM-stack rule
above, two things will be walked into again:

- **A coarse mesh must be holed by the UNION of the finer windows, not by each
  one in turn.** `dem_abp` and `dem_res` overlap, so their union is an L, and a
  coarse 3D cell can straddle the seam — wholly inside neither rectangle while
  wholly inside the union. Tested rectangle-by-rectangle it gets drawn anyway,
  and the result is a ~10 ft ribbon of site mesh z-fighting the 1-ft mesh along
  the join. `coveredBy()` in `js/viewer3d.js` subtracts each rectangle from the
  remainder, which is exact; the per-rectangle test is not.
- **A fifth of the survey contours are drawn where the app has no ground, and
  they are not CAD.** 7,627 of the 10-ft site set's 38,414 vertices sit on DEM
  NoData — the set runs out over Clear Lake and around the survey's own data
  boundary — and the polylines that close around that boundary carry straight
  chords, the longest 4,766 ft, which read as alignment lines drawn on open
  water. `js/layers.js` drops a vertex with no terrain under it (breaking the
  run) and breaks a run at any segment over 60 ft whose midpoint is NoData. A
  contour at z lies *on* the ground at z, so both tests are exact rather than
  length heuristics; the result is 451 polylines from 290 originals
  (30,701 of the 38,414 vertices kept), and the longest real segment kept is
  387 ft. `data/contours_site.json` is untouched —
  this is display only. The 3D drape has done the equivalent since v8
  (`BRIDGE_FT`/`TOL_FT`); keep the two in mind together if you touch either.
- Layer-tree order in the design group is now curated-first: `js/layers.js`
  builds `designGIS` → `CadNative` → `designEA`, and `designea.js` puts its
  per-sheet raster rows last under a `Sheets (draped)` sub-header with the
  `sheets3d` master switch. The e2e asserts no sheet row precedes that header.

## v10 water — the raindrop and the overtopping analysis

### The August-2026 survey and the Herman stages (spec §10)

`docs/Sulphur Bank Mine - Additional- (1).pdf` is a Jacobs limited topographic
survey: a CAD vector plot at 1 in = 8 ft (NW Pit inset 1 in = 16 ft), datum
CCS83 zone 2 USSF / NAVD88 = the app's CRS. `tools/build_survey_2026.py`
places it from its own five tabulated points with the scale LOCKED and rotation
zero (residuals 0.01 / 0.02 ft, plan scales recovered to 9.000 and 4.499
pt/ft) and writes the 24 shots as the baked dataset `survey_2026` (through
`tools/add_dataset.py`) and the 30 line features as `data/survey_2026.json`
(the `design_gis` layer schema, group `survey`), rendered by `js/survey.js`.
The labels on the plot are text-as-outlines, so the elevation beside each
survey circle was read off the plot and keyed by the circle's drawing index in
that tool — re-check the table if the PDF is re-issued.

What it changes in the overtopping analysis, and the two things not to undo:

- **The kernel takes `z0Override` and `levels`.** The seed set is still the
  lidar plateau (the water's footprint), but every seed cell is then water
  whose ground is unknown and whose surface is the surveyed level: its level
  is `z0Override`, its storage counts `L − z0Override`, and `z0`, the
  freeboard and the stage table start there; `z0_lidar` is reported beside
  it. `levels` adds exact stage rows (`extra: true`) at the pipe invert and the
  sandbag crest, computed by a direct pass rather than the 0.25-ft buckets.
  `js/water.js` `surveyFacts(ring)` reads the water level, the two inverts and
  the sandbag tops from the DATASET (never a constant), and applies them only
  when the surveyed water-level shot lies inside the ring being analysed.
- **The order of events is pipes, crest, rim.** Herman: surveyed water
  1336.45 ft (Aug 2026; the lidar's flat return read 1336.58 in Jan 2024);
  first discharge through the two 24-in HDPE pipes at invert 1341.55 ft,
  +5.10 ft, 109.2 ac-ft; the sandbag crest at 1343.54 (+7.09, 153.8 ac-ft);
  the lidar rim spill at 1343.84 (+7.39, 160.7 ac-ft). The slider walks the
  stage table by INDEX so it snaps onto the surveyed rows; the pipe discharge
  route (a raindrop from the plotted west end of the North pipe) shows from
  the pipe stage, the rim overflow route from the spill. `test/water_kernels.mjs`
  checks all of it (59 checks) against `scratchpad/survey_stage_ref.py`.

Contract: `docs/V10_WATER_SPEC.md`. Kernels `flowpath`, `overtop`, `catchment` in
`js/compute.js` (api VERSION 4, now 5 after the v9.7 fixes); host and UI in `js/water.js` (`SBMM.water`).
**Both tools are static terrain analyses over the lidar bare earth — no rainfall,
runoff, infiltration, seepage, wave run-up or time.** If the user asks for any of
those, that is a new spec, not an extension of this one.

The definitions, in short (§2 has them in full):

- **Descent** is D8 on cell centres, strictly downhill (`drop > 1e-9`), over ONE
  grid per analysis (`SBMM.demAt` / `SBMM.demForBox`). A NoData neighbour ends the
  run (`nodata`); the window edge ends it (`window`) and the *host* re-runs from
  the exit cell.
- **A pond** is a priority flood from a pit up to its pour point. Descent reads a
  pond cell as its pond's **level**, never its floor, so the drop leaving a pond
  cannot fall back in. Ponds shallower than **0.25 ft** (the lidar noise floor)
  are crossed but never reported or drawn.
- **The water surface** of an impoundment is the lidar's flat return: `z0` = the
  median z inside the polygon, seed = cells within `plateauTol` (0.3 ft) of it.
- **The spill** is found by a *sealed* inside-out flood: a neighbour below the
  current level that escapes is walled off and the cell that touched it is a spill
  cell. The **rim band** is every flooded cell between the spill and +3 ft.
- **Windows**: raindrop = a square ±700 ft on a 1-ft grid, ±1,400 ft on the 2-ft
  grid, re-centred on the exit for up to 8 hops / 20,000 ft. Overtopping = the
  water polygon's bbox ±800 ft, grown by 800 ft and retried on `reason:"window"`.

Four things here are traps:

- **The escape test is against the FILLED DEM `F`, not "is the neighbour lower".**
  Every shoreline cell of a 20-acre pond has a lower neighbour somewhere, so the
  naive test reports a spill at the water's edge and a **freeboard of 0 ft** on the
  Herman shoreline. The test that means something is `F_n < L − 1e-6`: does water
  reaching that neighbour drain to a sink *strictly below* the current level. And
  it must be strict — every interior cell of a depression has `F` exactly equal to
  its pour level, so `≤` lets the flood "escape" into a cell a hundredth of a foot
  under its own surface.
- **The sealed flood needs ONE global flooded/wall mask**, not a per-level one: a
  cell walled off at 1,343.8 ft must stay walled at 1,346 ft, or the flood pours
  through the spill it just found and the rim band becomes the whole valley.
- **The overflow route runs on the analysis's own grid and window**, passed in
  explicitly (`dropAt(x, y, { dem, window })`). The Herman spill sits inside the
  1-ft mine window, so the default DEM pick would retrace it on a different grid
  in a 1,400-ft box — a second analysis wearing the first one's answer, and one
  too small to hold the 1,900-ft impoundment it has to treat as blocked.
- **The animated flow line is SVG.** The map is `preferCanvas`, so a canvas vector
  has no DOM element and `className` on it reaches nothing (the same bug that made
  `.sheetpulse` dead CSS). `js/map.js` creates a `water` pane at z 470 with
  `pointer-events:none`, and `js/water.js` renders into it with its own `L.svg`
  renderer. That pane sits ABOVE `drawings`: if it ever became a canvas or took
  pointer events it would swallow every click on the map, and the e2e clicks a
  decision unit through a drawn flow to prove it does not.

Smaller notes: the kernels sample at `x0 + i*cell` (the app's `Dem.at` convention),
so kernel positions sit half a cell south-west of the spec's §9 reference labels —
0.71 ft on the 1-ft grid, 1.41 ft on the 2-ft; that is inside every §9 tolerance and
must not be "corrected". `flowpath` also returns `lengthRaw_ft` and `zEnd_ft` (the
last *surveyed* z — `end[2]` is NaN when the run stops on NoData). `overtop.band`
carries `bx0/by0/bx1/by1`, the exact image-overlay rectangle: `x0/y0` are cell
CENTRES, so recomputing the rectangle from them is half a cell wrong.

`flow` is a new feature type: `SBMM.tools.rebuildFeature` dispatches it to
`SBMM.water.mkFlow`, which rebuilds from `props` and **never recomputes** (loading a
session must not spawn compute jobs; the e2e asserts zero jobs across a round trip).
Its layer is a `FeatureGroup` rebuilt by `SBMM.water.buildFlow` on style/selection
change — the same shape `dim` and `text` already use, and why `flow` is special-cased
in `applyStyle` / `redraw`. Vertex editing is refused with a toast; the drop marker
is draggable and `dragend` retraces in place. My work gained a sixth class row,
**Water** — appended, because `SBMM.myWork.classOf` reads `CLASSES[4]` as "imported
wins" and that index is load-bearing.

## v12 storm drainage — the raindrop goes down the pipe

Contract: `docs/V12_STORM_SPEC.md`. Data `data/storm_network.json` +
`datajs/d_storm_network.js` (43 nodes, 25 conduits, ~27 kB, in the field build),
built by `tools/build_storm_network.py`; host `js/storm.js` (`SBMM.storm`);
kernel: `flowpath` gains `conduits` / `captureFt` (**api VERSION 6**).

**A conduit is a topological shortcut with an elevation at each end.** No
capacity, no hydraulic grade line, no surcharge, no time, no Manning — the
popups and the cards say so in those words. Pipe capacity waits for the invert
survey and is a separate spec (§7).

The definitions, in short (`docs/V12_STORM_SPEC.md` §2 has them in full):

- **Node**: `kind ∈ {grate, round_inlet, fes, pipe_end, bend, junction, outfall,
  inferred}`, `x, y`, and two elevations — `rim_ft`, the lidar ground, **computed
  on boot by `js/storm.js` from `SBMM.elev` and never baked**, so it follows the
  DEM stack; and `invert_ft`, surveyed or `null`. Only the two Jacobs pipe nodes
  at the sandbag wall have an invert. **Never invent one**: the popup says "not
  surveyed", the card says "unknown — no invert".
- **Rim for the kernel** = `invert_ft` if surveyed else `rim_ft`.
- **A sunken inlet** (ruling, 2026-09-04, spec §2). The lidar is the Jan-2024
  flight; the sandbag wall and the two 24-in pipes were built afterwards, into a
  regraded channel it never saw, which is why the 1-ft cells at the surveyed
  invert points read 1344.66 / 1344.80 — the top of the sandbags, not the pipe.
  **An inlet whose surveyed invert is below the lidar ground at its own cell is a
  pipe mouth the lidar did not see.** `js/storm.js` `findMouth()` then hands the
  kernel the **nearest DEM cell at or below the invert within 30 ft** of the
  surveyed point, keeps the surveyed invert as the rim, and records
  `mouth_moved_ft` (25.6 ft for the North pipe, 27.1 for the South) so the popup
  and the card say so. Nothing within 30 ft ⇒ the inlet stays put and the popup
  says *that*. It is a HOST rule — no kernel change — and the pond rule below
  then stops the Herman pond at the invert instead of taking it over the rim.
- **Inlet** = a conduit's `from` node; its **capture** is every cell within
  `captureFt` (**3 ft**, a ruling) of it. Where two discs overlap the nearest
  inlet wins, so the index does not depend on the order the host listed them.
- **The shortcut rule**: descent standing on a capture cell leaves the ground,
  gains a **leg** to the conduit's `to` node and on through whatever conduit
  starts there (`next`, transitively, **each conduit at most once per run** —
  the host carries the used set across windows), and continues by ordinary
  descent from the last outlet. An outlet outside the window ends it with
  `reason: "conduit"` and `exit` = that node; the host re-centres exactly as it
  does for `"window"`.
- **The pond rule**: during the priority flood, a popped cell that is a capture
  cell whose conduit's rim the level has reached stops the flood there — the
  pond's outlet is the conduit, and the pond reports `via`.
- **Disabled** means *not passed to the kernel at all*: a conduit marked
  `broken`, or the whole network with the "storm drains work" switch off. The
  analysis is then exactly the ground-only one — the e2e proves the two agree to
  0.01 ft.
- **`length_ft` stays overland and `pipe_ft` is separate** (`total_ft` is the
  sum). They are different quantities — one measured off the lidar, one off
  somebody's drawing — and adding them would hide the one he is going to survey.

Chrome: three layer rows under a **Storm drainage** sub-header in Site framework
(`storm_nodes` 43, `storm_cad` 15, `storm_inferred` 10, all default ON); the
`STORM` command and the Water ▾ menu toggle the master switch; a chip on the
raindrop Mode HUD shows its state; `SBMM.popups.forStorm(node, conduit)` builds
both popups and carries the per-conduit broken/working toggle. Preferences live
in `localStorage["sbmm.storm.v1"]` (`{enabled, status:{id:"broken"}}`).

Four things here are traps:

- **The kernel must be bit-identical with `conduits` absent or empty.** Every
  water golden in `test/kernels.mjs` and `test/e2e.mjs` was measured on the v10
  kernel, so the `storm` section asserts the §9.1 raindrop's `pts`, `ponds` and
  `reason` are identical both ways before it asserts anything else. Keep every
  new branch behind `if (CD)`.
- **A conduit hop does not repeat a vertex, a window hop does.** `js/water.js`
  `traceRun` drops the first vertex of each new window because it repeats the
  exit cell — but a conduit reappears at the OUTLET, which was never a vertex,
  so `skip` is 0 there. Get this wrong and every piped run loses its outlet.
- **The overland length is accumulated per window, not measured off the
  assembled polyline.** `lineLength(pts)` over a run with legs in it would count
  the pipe as ground. The kernel's per-window `length_ft` already excludes the
  jumps and consecutive windows share their join vertex, so the sum is exactly
  the old number when nothing went through a pipe.
- **A run with legs is not one polyline.** `buildFlow` splits `f.pts` at each
  `leg.at` and draws the ground per stretch, with the pipe drawn as itself (a
  straight dashed line in `--storm`, a hollow ring at the inlet, an "in pipe"
  label at zoom ≥ 2, a straight un-draped tube in 3D). One polyline through both
  would draw water running over the ground along the pipe, which is the one
  thing this must not say.

Two things about the ponds east of the impoundment (ruling, 2026-09-04, the
engineer's own reading of the site):

- **Naming.** EA's geodatabase `water` layer has it right, and the engineer confirmed it (Sep 2026): **Frog Pond is the east pond** (E 6,374,450–6,374,726, floor 1,415 ft) and **Green Pond the west pond** (E 6,373,925–6,374,152, floor 1,391.6 ft). The storm network uses those names.
- **Frog Pond (east) drains into Green Pond (west) through a short culvert under
  the paved road (`pond_culvert`, Spot 5 → Spot 1, 75 ft); Green Pond overflows
  through the `STRM FES` on its west shore, piped under the road to the Spot 8
  grate (`green_outlet`) and down the road drain to the Clear Lake outfall — it
  does NOT overflow into the impoundment.** The round inlet at Green Pond's NW
  corner (`green_riser`, ground 1,400.9) is the high-level overflow: only water
  above that rim goes under the road to Herman. Both are inferred conduits (EA
  drew the structures, not the pipes); `tools/build_storm_network.py` is the
  record.
- **An inlet is a SINK in the filled DEM.** `fillDem` takes the capture cells as
  seeds at their conduit's rim (`F = max(z, rim)`), built before the fill and only
  when conduits are present (the no-conduit fill is the v10 fill to the bit).
  Without it Green Pond's two lobes were one flood: the water arrives in the east
  lobe, and the escape test — which asks `F` — saw no drain in the west lobe, so
  the flood took both lobes to the 1,402.44-ft saddle and only then found the FES.
  With it the east lobe stops at its saddle (a 0.36-ft pond, no via) and the west
  lobe drains through the FES at its rim, 1,394.50 ft. The §6.6 harness case is
  the guard.

**The raindrop and the overtopping tool now agree about Herman**, which they did
not before the sunken-inlet rule: a drop inside the impoundment ponds to 1,341.54
(the lower surveyed invert is 1,341.53) and leaves through `herman_pipe_s` →
`pipe_to_main` → `storm_main_upper` → `storm_main_lower` → the outfall, 813.3 ft
in pipe, against the overtopping card's first discharge at 1,341.55. With the
drains off the same drop fills to the lidar rim at 1,343.84 and spills over it —
2.30 ft higher — which is exactly what the rule buys and what the e2e prints.

## v13 — the overtopping analysis honours the conduits, and water moves in 3D

Contract: `docs/V13_WATER3D_SPEC.md`. Kernel: `overtop` gains `conduits` / `captureFt`
(**api VERSION 7**); host in `js/water.js`; the animation and the stage surface in
`js/viewer3d.js`. Harness section `water3d` in `test/kernels.mjs`, e2e block
**"9t. overtop + conduits"**.

**The conduit spill.** `overtop` takes the same flat conduit record `flowpath` takes and
builds the same capture index. During the sealed inside-out flood the FIRST inlet whose rim
the rising level reaches is reported as `conduitSpill = {id, level, x, y, outlet, next,
mouth_moved_ft, stageLevel}`, with `freeboardConduit_ft` beside the rim's `freeboard_ft`
and one `extra` stage row at that level carrying `via: id`. Submerged inlets are tracked
and re-tested as the level rises, exactly as `flowpath` does.

Four things here are traps:

- **`fillDem` is NOT seeded in `overtop`.** Seeding it with the capture cells is the
  *flowpath* rule (v12); `F` is what the escape test asks, so seeding it here would move the
  rim spill, the freeboard, the storage, the band and every §9.2/§10 golden. The conduit
  spill is **added beside** the rim analysis and never in place of it, and the harness
  proves the identity field by field (primary, clusters, band bytes, spill mask, freeboard,
  storage, area, stage levels/areas/storage) on Frog Pond, Green Pond, Herman and an empty
  conduit list.
- **A stage row is merged, not duplicated.** A surveyed `levels` row within **0.1 ft** of
  the conduit level wins and gains `via` (Herman: the kernel's 1341.53 lands on the
  survey's 1341.55); a regular 0.25-ft step that coincides exactly is tagged rather than
  recomputed, so the table stays the no-conduit table. Only a level that matches neither
  inserts a row.
- **One route, not two.** The host traces a first-discharge route by dropping a raindrop ON
  the conduit spill's kernel cell with the network on and `blockRing` = the water body — but
  when the conduit spill IS the surveyed pipe (`facts.pipeInvert` within 0.1 ft) the v10
  pipe discharge route stands and nothing is traced again. `js/water.js` `ov.csIsPipe` is
  that test, and it also suppresses the second "C" marker and the second card row.
- **Block 9w of the e2e passes `storm:false`** as well as `survey:false`: it is the
  pure-lidar §9.2 reference, and it doubles as v13's "with the network off the analysis is
  bit-identical to today's".

Recorded numbers (regression guards, `test/kernels.mjs --only water3d`): Frog Pond
`pond_culvert` 1415.74 (rim spill 1416.04), Green Pond `green_outlet` 1394.50 (rim spill
1399.14), Herman `herman_pipe_s` merged onto the surveyed 1341.55 row (rim spill 1343.84,
44 stage rows either way).

**Water in 3D** (`js/viewer3d.js`). Two objects, and both have rules:

- **The particle stream.** One `THREE.Points` per visible `flow`, built inside
  `overlayGroup` (so a rebuild throws it away — `waterAnim` is reset there too). Each
  overland stretch is densified at 10 ft and draped ONCE per rebuild; each conduit leg is a
  straight two-point track at its own elevations. Particles are ~20 ft apart and move at
  ~40 ft/s; the render loop advances one scalar and writes into a pre-allocated
  `Float32Array` through a binary search on the cumulative arc length — **no per-frame
  allocation and no per-frame `drapeZ`**. It requests frames at ~30 fps **only while a
  visible flow exists and "animate water" is on**, which is what keeps `test/perf.mjs`'s
  idle-render count at 0. The particles carry no `userData.pick`, so §3.3's "not pickable"
  is a property of the code.
- **The stage surface.** `SBMM.viewer3d.setWaterStage({rings, level, labels} | null)`, owned
  by `js/water.js` (`SBMM.water.stageSpec()`, which `show()` also pulls so an analysis
  opened while 2D-only appears). One `ShapeGeometry` at `z = level − ZMID` with holes
  resolved by containment depth (`maskRings` sorts by area and flags nothing), plus a text
  sprite at each rim low, the conduit spill and the surveyed pipes. `applyLevel` pushes a
  new spec on every slider step; `clearOvertop` pushes `null`.
- The **"Animate water"** switch lives in the 3D *View settings* popover (`#v3dAnimWater`),
  defaults on, and is remembered through the new `SBMM.view.pref(key[, value])` — the same
  `localStorage` record the camera uses. It is in the field build too. It is NOT on the
  toolbar row itself: that row is measured and reflowed by `reflowBar()` at four widths, and
  a fifth control there is a layout problem for a switch nobody touches twice.

## v14 Phase 1 — the drainage map

Contract: `docs/V14_DRAINAGE_SPEC.md` (Phase 1 of `docs/V14_CATCHMENT_PROPOSAL.md`).
Kernel `drainage` in `js/compute.js` (**api VERSION 8**); host `js/drainage.js`
(`SBMM.drainage`); harness section `drainage` in `test/kernels.mjs`.

**ONE LABEL PER CELL: the outlet that cell drains to.** The same physics the
raindrop uses — the filled DEM with conduit inlets seeded at their rims, the same
escape test, ponds read at their level, conduits as topological shortcuts — run
once over the whole `dem_site` grid (4,850 × 4,450 = 21.6 M cells at 2 ft)
instead of from one click. **Terrain only: no rainfall, no runoff, no curve
numbers, no time.** The map says where water goes, never how much; every card
says so in those words, and Phase 2 of the proposal is where the rest lives.

The acceptance test is the identity, and it is the whole point of reusing the
raindrop's physics: 100 seeded pseudo-random surveyed points, each traced by
`flowpath` the way `js/water.js` traces it, must land in the catchment the label
raster draws under them. **100 of 100 agree.**

### The one ruling this kernel makes for itself

`flowpath` floods one pit at a time, in the order its descent meets them, and
never revisits a pond. Two consequences are invisible to a single drop and fatal
to a map, and both were hit:

- A small depression **A** that spills into ground a later, higher pond **B**
  takes over keeps its own lower level, so its pour point sits under B's water.
  Descent then leaves A at A's level, crosses B, leaves B at B's spill and —
  where that spill drains back towards A — enters A again. It is a genuine cycle;
  a raindrop only escapes it through `maxSteps`, a label raster cannot escape it
  at all. On this site it labelled **357 acres** "loop".
- A cell whose only downhill neighbour was a pond floor loses its drop when that
  pond fills, so it becomes a pit the first pass did not see. A drop meets those
  lazily; a map has to find every one.

Patching flowpath's order (lazy re-scans, a union-find over ponds) was tried and
made it worse — 500 acres of loop and a scatter of walled-in "no outlet" ponds.
**The ponds here are therefore the connected components of `F > z`** — the filled
DEM's own depressions, at the level `F` says they pour at. That is not a different
definition: Barnes' `F` IS the fixed point of flowpath's escape test (the minimal
level at which water at a cell drains to a sink strictly below it), and `fillDem`
is already seeded with every conduit inlet at its rim, so a depression drained by
a grate pours at the grate exactly as the raindrop's flood stops there. The only
visible difference is that **nested depressions merge into the outer one** —
which is also what flowpath itself reports when a drop happens to meet the outer
one first, and which is what the identity shows costs nothing: the terminal is
the same either way. The three named ponds come out at the raindrop's own levels
(Herman 1,341.53 via `herman_pipe_s`, Frog 1,415.74 via `pond_culvert`, Green
1,394.50 / 3.08 ft deep via `green_outlet` — the same 3.08 the §6.6 storm case
records).

### Why it is provably acyclic, and the two things that make it so

A pointer field over 21.6 M cells cannot be debugged by inspection, so it is
built to a rule instead: **`F` never rises along a pointer, and where `F` stays
equal the step always shortens the distance to the root of the priority flood's
own parent forest.** Both halves are needed:

- Steepest descent on effective elevation strictly decreases `F` (a non-pond cell
  has `F ≈ z`; its target is either lower ground or a pond whose level is below
  it).
- **A pond cell points at `parent[c]`, not at the pond's outlet.** The outside-in
  flood ENTERED the depression through its pour point, so `parent` inside it
  points back at that point cell by cell — and where the depression is drained by
  a grate the flood's SEED is the capture cell, so `parent` points at the pipe
  instead. Every pond cell is a descendant of the pour cell in that forest, so
  the step strictly shortens the path to a sink. Jumping straight to the outlet
  (which is what a raindrop does, and which is right for one run) is exactly what
  reintroduced the cycles.
- **A flat uses `parent[c]` too.** That is what the spec's flood-parent flag is
  for: a cell with no strictly lower effective neighbour and no pond has no D8
  direction of its own, and the flood's parent is by construction a step towards
  the sink it drains to. `fillDem` gained ONE optional out-parameter for it
  (`parentOut`); absent, not one value changes and not one extra byte is touched.

Only a conduit can break the rule (a pipe may discharge uphill), so the label
resolution keeps a cycle guard and reports a `loop` sink. On this site `loops`
and `flats` are **0 at 2 ft and at 4 ft** and the harness asserts it; `pondSinks`
counts the cells that drain nowhere at all, one on each grid.

**One trap inside that rule, and it was the field build that found it.** A
component one cell across — the filled DEM's rounding, not a depression — can be
reached by the flood from ground ABOVE its own level, and then `parent` points
uphill: the water leaves the pond, the cell it leaves to descends straight back
in, and the two point at each other. So the parent route is taken only while the
parent is in the same pond or its GROUND is at or below the pond's level;
otherwise the cell falls through to ordinary descent on effective elevation
(which strictly lowers it, so it cannot close a cycle) and, failing that, is
reported as the one-cell closed pit it is. It cost 0.005 acre at 4 ft and nothing
at 2 ft — which is the whole argument for asserting acyclicity at every
resolution the app actually ships, not only the one it was developed on.

### Four more traps

- **A Float32 `F` against a Float64 invert.** `rim <= level` fails by one ULP —
  1341.57 against 1341.5699462890625 — on exactly the cell the whole analysis
  turns on, and the impoundment then becomes a sink with 165 acres behind it
  rather than draining through the surveyed pipe. The comparison uses `RIM_EPS`
  (1e-3 ft, under the 0.02-ft terrain-RGB step), and a cell the flood SEEDED
  counts as an inlet by construction whatever the arithmetic says.
- **The pour level is the MINIMUM `F` over the component, not the maximum.** `F`
  is constant over a depression except where an inlet seeded it, and where TWO
  inlets seeded it — the two Herman discharge pipes at 1,341.53 and 1,341.57 —
  the water leaves at the lower. Taking the max reports the north pipe.
- **An inlet's own nearest cell is always a capture cell**, whatever `captureFt`
  says. 3 ft does not reach the centre of any 4-ft cell, so on the field build's
  4-ft run every capture disc came back empty and the map said the drains did not
  exist rather than that they did not work.
- **Areas are full-resolution cell counts; polygons are traced on the decimated
  raster.** Tracing 21.6 M cells per label costs more than the whole analysis, and
  decimating the areas with the outlines would quietly move the acreage someone
  reports. Both numbers are exact about what they are and the card names the grid.

**And one more the 3D view found.** A catchment boundary follows the edge of the
surveyed ground, so a good part of every big one has NO TERRAIN UNDER IT — and
`drapeZ` falls back to the middle of the site's elevation range there, which
drew each boundary as a 70-ft vertical curtain standing along the survey limit
and out over Clear Lake. `groundRuns()` in `js/drainage.js` applies exactly the
rule `js/layers.js` already applies to the survey contours — drop a vertex with
no ground under it, and break a run wherever the drape would cross open water —
and hands `rings3d()` OPEN RUNS rather than closed rings, which is what a
boundary that genuinely stops at the survey limit is. **Test the segment the way
`drapedLine` will walk it** (every 10 ft, its own resampling step), not just its
midpoint: both ends of a boundary running along the shore can be on surveyed
ground while the straight line between them cuts the corner across the lake, and
that one segment is enough to put the curtain back. Keep the three in mind
together: the survey contours, the v8 3D drape's `BRIDGE_FT`/`TOL_FT`, and this.

### What it costs, and what the app does with it

9.5 s at 2 ft and 2.2 s at 4 ft in node (budgets 20 s / 6 s); ~500 MB of typed
arrays in the worker at 2 ft, and a worker that cannot allocate them retries at
4 ft and toasts that it did. The field build runs at 4 ft by construction
(`SBMM.compute.subGrid`, new in `js/jobs.js`) and the card says "4-ft grid"; the
4-ft map's outlet areas are within **1.33 %** of the 2-ft map's.

The job runs **once per switch state and is cached** — the storm master switch or
a conduit going broken marks it stale, toasts "drainage map is stale —
recomputing" and re-runs debounced. Three rows sit under a **Drainage (lidar +
storm drains)** sub-header in Site framework, all default OFF with the first tick
running the job: *Catchments — by outlet*, *Catchments — by first capture* (ponds
and inlets), *Flow paths (longest per catchment)*. `DRAIN` (aliases `DRAINAGE`,
`WATERSHEDS`, `CATCHMENTS`), a Water ▾ entry and a chip on the raindrop Mode HUD
all reach it; `SBMM.popups.forDrainage(label)` is the popup and every storm node
and conduit popup gained **"show what drains here"**.

**A grate's catchment on this site is essentially nothing, and that is a finding,
not a bug.** The eight road-drain grates take 0.019 ac between them overland: the
road ditch runs *past* them into the impoundment, which then discharges through
the surveyed pipes. `through_area` on each inlet adds the ponds that pour into
it, which is how the water actually reaches most of them (`herman_pipe_s` 37.90
ac, `pond_culvert` 14.52 ac, `green_outlet` 2.62 ac).

## v15 — conduits first, two label engines, and the 3D view

Contract: `docs/V15_3D_POLISH_SPEC.md`. No kernel work (`VERSION` stays 8).
New file `js/labels.js`; the rest is `js/water.js`, `js/viewer3d.js`,
`js/pick3d.js` and the call sites that own a label. E2E blocks **9y (3D
parity)** and **9z (labels)**, plus the updated 9t/9v; shots
`test/v15_shots.mjs`.

### The overflow rule (ruling, 2026-09-05): conduits first, the rim on request

**When the overtopping analysis finds a conduit spill BELOW the rim spill, the
conduit is the overflow.** `ov.rimSuppressed` is that test, and it is generic —
Frog Pond's culvert, Green Pond's FES, Herman's surveyed 24-in pipes. What it
changes is *visibility and wording, never a number*:

- the rim overflow route is **not traced** (`ov.route` stays null); the seed
  cell, the analysis's own grid and its window are kept on `ov.rimSeed /
  rimDem / rimWindow / rimBlock` so the button can trace it later **on the same
  grid** (§2: one analysis, one grid);
- the card's rim row says so — "1,416.04 ft · +0.30 ft above pond culvert — not
  traced; the drains are assumed to handle it" — and the "Overflow route" row
  reads "not traced — the drains are assumed to carry it";
- the slider above the rim reads "above the rim · the drains are assumed to
  carry it (trace the rim overflow to see the what-if)";
- **"trace the rim overflow"** on the card traces it as a what-if named for what
  it assumes ("… — what-if: pond culvert blocked"), drawn dashed in `C.whatif`
  (`#93A6B3`) with no glow and no animation (`props.whatif`, honoured by
  `buildFlow` and by the 3D branch), and **owned by the analysis**: the button
  toggles it off and `clearOvertop` removes it. It is created with
  `dropAt(..., { noUndo: true })` on purpose — an undo entry pointing at a
  feature the analysis has since removed is worse than none.
- `SBMM.water.routes()` is the readable contract (`{rim, rimWhatIf,
  rimSuppressed, conduit, pipe, …}`); the e2e asserts through it rather than
  guessing from feature names other analyses also match.
- `chainSentence(route)` reads the intended system back as words from the
  route's own `legs` and the ponds that left through them (`via`), collapsing a
  run of consecutive legs of the same family into one: "→ Green Pond (fills to
  1,394.50) → green outlet → road drain → branch → storm main → Clear Lake
  outfall".

**Block 9w of the e2e passes `storm:false`, so it has no conduit spill and the
rim route is still traced there** — that is what keeps every §9.2 number and the
"the slider hides the route below the spill" assertions exactly as they were.

### `SBMM.labels` (2D) and the 3D label layer

Two engines, one idea: a label is a FACT, and a fact is shown once.

```
SBMM.labels.add({ id?, key, priority, latlng, el | marker, owner, gate? })
SBMM.labels.remove(id) / removeOwner(owner) / place() / refresh()
SBMM.labels.stats() / visible() / boxes() / count(owner)
```

- **Dedupe by `key`**, highest priority wins; then a **greedy collision pass**
  in screen space after every `moveend`/`zoomend`/add/remove (debounced to one
  frame), 2 px of padding. Priorities (§2.2): spill/first-discharge markers 100,
  pond 60, drainage 50, design depth 45, flow end 40, "in pipe" 30.
- **Hiding is `visibility:hidden`, never `display` and never removal** — the
  element keeps its box so the next pass can measure it without a reflow, and a
  label that stops colliding comes back on its own. **Do not put `display:none`
  on a label class**: the engine reads a box-less element as absent (which is
  exactly why the excavation labels' existing `#map.zoomfar` CSS gate still
  works and costs them nothing).
- A zero-size `divIcon` has no box of its own, so `boxOf()` measures the union
  of its CHILDREN. Every one of these labels is a zero-size icon.
- Zoom gating moved into `gate()` (pond labels at 36 px across, "in pipe" at
  zoom ≥ 2). A gated-out label does NOT occupy space.
- `owner` is how a label dies with its layer: `buildFlow` calls
  `removeOwner("flow:"+f.id)`, `clearOvertop` and `toggleOverlay` re-register
  `"overtop"`, `js/drainage.js` `clearLayers` drops `"drainage"`,
  `js/designgis.js` `buildLayer` drops `"gis:exc"`. A record whose element is
  detached is dropped on the next pass.

**3D (`js/viewer3d.js`, the label layer).** Screen-sized camera-facing chips with
a leader and a dark plate, `fog:false` (a label that fades out has stopped
working), two sources (`overlay` from `rebuildOverlays`, `stage` from
`SBMM.water.stageSpec()`), merged and deduped by key, capped at 60, **diffed by
text** so a slider step rebuilds only the chips whose words changed. The chip
material cache is an LRU of 140 — a slider dragged across a 44-row stage table
asks for hundreds of distinct strings and an unbounded canvas-texture cache is a
GPU leak. `updateLabels3d()` runs per DRAW, not per rAF, and allocates nothing:
module-level vectors, one 6-float array per leader, `LBL_ORDER` reused. It must
refresh `camera.matrixWorldInverse` itself — it runs *before* `renderer.render`,
which is where three would otherwise do it, and without that the first pass
projects through an identity matrix and culls every label.
`stageSpec()` states each label relative to the CURRENT slider level ("+0.39 ft
to go" / "overtopped" / "discharging") and steps the chips up the screen by
`liftPx` for the same reason the 2D markers step down the page.
**The world-sized `textSprite` is gone** — it grew with the camera and its text
was fixed, which is both halves of what the user reported.

### 3D parity (§3.1) — `userData.layer` and the table

Every object `rebuildOverlays` (and the contour, canopy and sheet builders)
makes carries `userData.layer = {g, l}` — the same `(group, id)`
`SBMM.layerState` uses — and `SBMM.viewer3d.stats().layersDrawn` reports the
set. E2E block **9y** turns every group on and requires each ON row to have an
object, printing the ones that do not. **A new 3D object gets a tag**, or the
table fails on the row it belongs to. Gaps closed in v15: EA's PDF boundaries
(drawn, untagged and unpickable), **`SBMM.designGIS.batch3d()`** — `rings3d()`
returned only the design group's POLYGONS, so EA's design LINES (daylight,
grade, haul) and the entire boundary / existing-conditions half (lots, OU,
parcels, water, buildings, roads, fences, utility points: 580 features) drew
nothing at all in 3D; they are now MERGED per layer by `drapedBatch()` into one
`LineSegments` each, with a segment→feature `owner` array so the new `gisBatch`
/ `gisPts` pick kinds still answer with the right popup — the two survey contour
sets (one sub-group
each — before this both drew whenever *either* row was on), the computed contour
set (`base/contours_custom`, an explicit id in `js/analysis.js`), cross-section
station lines and chainages, EA's four recovered design surfaces (they have no
`_surf` node grid, so the mesh branch skipped them and 3D drew nothing at all —
now the footprint), the drainage flow-path row, one cultural point cloud per
layer, and dataset rows tagged with `rowKey` (a dataset's row id is a slug of
its LABEL, not its dataset id).
Two exemptions, printed with their reasons: the basemaps and computed rasters
(in 3D they ARE the terrain drape) and EA's CAD **base map** groups (contours
3,159 rings, parcels 2,788, symbols 15,045 …), which stay 2D-only because every
ring is resampled against the DEM every 10 ft on every overlay rebuild — that is
what the 3,000-ring drape budget is for. The **design** CAD groups are drawn.

### 3D appearance (§3.2) — three things not to undo

- **The selection halo's pulse is BOUNDED (1.5 s after the selection changes).**
  A halo that pulses for ever asks for a frame for ever, and `test/e2e.mjs`
  block 9e fails an idle view that keeps rendering. One scalar per frame, no
  allocation, and nothing at all once it has settled.
- **The "outline" under an overlay line is geometry, and it is MERGED.** WebGL
  cannot widen a line, so the dark edge that makes a bright line readable over a
  bright ortho is the same polyline again 1.3 ft lower — all of them in ONE
  `LineSegments` (`SHW`), one draw call. The CAD bulk is deliberately excluded.
- **A draped polygon fill is a TIN of its own boundary**, and it is applied to
  the user's `area` / `volume` features only (`drapedFill`). A flat fill at the
  mean elevation floats or sinks over sloping ground; a fill over every
  site-wide polygon is the overdraw that costs a software-GL frame its budget.
- **The sky dome rides with the camera** (radius 30,000 ft, `depthTest:false`,
  `renderOrder -1000`), which is why it can be small enough to sit inside the
  far plane at any orbit radius; `updateSky()` is one `position.copy` per draw.
  The ground plane lives in `envGroup`, whose `scale.z` follows the
  exaggeration slider like every other group.

**Two traps the field build found, both worth the words.**

- **Every row added to `#v3dNav` grows it UPWARDS into the canvas.** The 3D
  canvas on a phone is 412 x 653; the nav column is anchored bottom-right. The
  v15 "Look at…" row (44 px) and the elevation legend (~120 px) took its top
  edge from y 542 to y 378 — past the middle — and the second finger of a
  two-finger pinch, which lands at the canvas centre, came down on a nav button
  instead of the model. Its `pointerdown` went to that button, the rig never saw
  a second touch pointer, `touches.size` stayed 1 and the pinch could not dolly.
  Nothing errored; `test/e2e_field.mjs`'s pinch assertion is what caught it.
  Both controls are now `display:none` under `body.field`, the legend is
  `pointer-events:none` because it is a legend, and `stats()` reports `navDrag`
  and `navTouches` so the next such failure can be read rather than guessed.
  **A new `#v3dNav` row goes behind the same rule** — v17's on-screen nav pad
  is the first one to, and it is a `body.touch:not(.field)` control for exactly
  this reason: on a phone the pinch and the double-tap already do zoom and tilt.
  v17 also re-pointed `navDrag`/`navTouches`, because the `touches` Map they
  read was replaced by js/touch.js's recogniser; they answer from
  `navRec.mode()` / `navRec.count()` now, and `st.drag` still answers for the
  mouse.
- **A feature whose only 3D object is a LABEL can lose the 60-chip budget.** A
  single-point `text` annotation drew nothing at all once its chip was capped or
  collided away — invisible in 3D and unpickable. It now also draws its anchor,
  and `layersDrawn()` counts label RECORDS rather than their per-frame `visible`
  flag (which is a collision/culling decision, not a statement about the layer).

**Keys (a deviation, decided here).** The spec asked for 1–6 and `F` to fit.
`3` has toggled the whole 3D view since v1 and `F` is fly mode — both are in the
nav help table and in the buttons' tooltips, and silently re-binding a
documented key is a user-facing regression the spec did not ask for. So: 1, 2,
4, 5, 6 are top/north/east/west/iso, **Shift+3** is south, **Shift+F** fits,
arrows orbit and Shift+arrows pan. The help table says so.

## v16 — the layer tree

Contract: `docs/V16_LAYERS_SPEC.md`. New file `js/layertree.js` (`SBMM.layerTree`),
loaded after `js/map.js` and before every module that registers a row. The
Layers tab markup in `index.html`, the `v16 layer tree` block at the end of
`css/app.css`, and one e2e block, **"9z. layer tree"**, which runs LAST because
it ends with a real `page.reload()`.

**`SBMM.layerState` did not change and is still the one answer to "is this layer
on".** The tree is the view: it decides which container a row lands in, decorates
the row, and offers new ways to move the state — it never becomes the state. Two
additive APIs were needed and are the only edits to `js/layerstate.js`:
`batch(list)` (many sets, one `layers` event per group that moved — the same
`{group, layer: null}` shape a master checkbox already emits) and `setExtra({save,
load})`, which is how the tree's own record travels in the session file.

**`SBMM.addLayerRow`'s signature is extended, never changed.** `opts.sub` names
the sub-group the row belongs to and `opts.subTitle` its tooltip; everything else
is what it always was. The five modules that used to append an ad-hoc `.lsub`
header into a host div and let their rows fall in underneath it — `js/storm.js`,
`js/drainage.js`, `js/survey.js`, `js/designea.js` (the sheet rows) and
`js/designgis.js` — now pass `sub:` instead, and that one option is the whole of
their diff. The sub-group container is `.lgsub` > `.subh.subtoggle.lsub` +
`.lgsubb`: the exact markup the Terrain-analysis sub-section has always used, so
`SBMM.layersUI.refreshCounts` and every selector that ever asked "is there a
sub-heading called Storm drainage in this group" keep working untouched.

Five things here will be walked into again:

- **The cultural gate must keep winning.** `js/cultural.js` intercepts the
  checkbox's `click` in the capture phase, so every switch the tree offers that
  could turn a row ON goes through `row.cb.click()` — the keyboard, the
  recently-changed chips, search-Enter — and never `layerState.set`. The bulk
  paths (solo, presets, the group all-on button) skip the `cultural` group
  outright, `snapshot()` excludes it, and solo refuses it with a toast. The
  recently-changed list never records a cultural row, because a chip is a
  one-click way back on. Block 9g still asserts the acknowledgement; block 9z
  asserts the other half.
- **Draw order is applied only to a container the user has actually reordered.**
  The app's existing z-order is deliberate — the three orthophotos carry explicit
  `zIndex` options, the sheet click rectangles call `bringToBack()` on add so only
  empty ground opens a drawing, each pane has its own band — and a blanket
  `bringToFront` pass at boot would silently undo all of it for nothing. So
  `applyDrawOrder(group)` returns 0 until `S.order` has an entry for one of that
  group's containers. Within one, the rows are walked bottom-up so the TOP row is
  brought forward last and ends up on top; a layer that must stay at the back says
  so with `options.sbmmBack` (the sheet hit rectangles do) and is put back rather
  than brought forward. The e2e probe is `SBMM.layerTree.drawIndex(group, id)` —
  a row's position in its canvas renderer's own `_drawFirst` chain, so the
  assertion is about the map, not about the DOM.
- **A swatch must not add a text node, and must not repaint on every event.** A
  row's `textContent` is read by several harnesses and by the legend, so the
  toolbar's four glyphs come from CSS `content` and the trailing "(140)" is moved
  into its own span *including its leading space* — the string is byte-identical.
  And the raster swatch's gradient id is derived from `(group, id)`, not a
  counter: a new id every repaint would make every `layers` event a real DOM
  write inside the pane the count-badge `MutationObserver` is watching.
- **The tree owns the open/closed record now.** `sbmm.layertree.v1` holds the
  open state of every group AND sub-group, the per-container row order, the user
  presets and the legend's own state; `js/layers.js` migrates the old
  `sbmm_layer_sections` key into it once and then reads and writes through
  `SBMM.layerTree.openState`. Terrain analysis is the one sub-group that starts
  closed (ruling F3) and that is `SUB_CLOSED_BY_DEFAULT` in `js/layertree.js`.
- **The session key is `layers._tree` and it is additive both ways.**
  `js/state.js` is untouched: `layerState.serialize()` folds the tree's record in
  under `_tree`, and `restore()` skips that key in its group loop and hands it to
  the extra. An old session has no `_tree` and restores exactly as before; a new
  session opened by an older build finds no layer called `_tree` and skips it.

Presets are `BUILTIN` in `js/layertree.js` — a rule per preset answering true /
false / null (leave alone) per row — plus whatever the user saves. Applying one is
ONE `SBMM.undo` entry with both closures (the before snapshot and the after
snapshot, captured at the moment the action completes). Search is fuzzy over
label + sub-group + group + id, which is why searching "storm" also shows the
drainage rows: their sub-group is *Drainage (lidar + storm drains)*. That is the
rule working, and block 9z asserts "every row shown really matches" rather than a
bare count.

**Shots:** `node test/layers_shots.mjs /abs/path/index.html` writes
`layers_tree.png`, `layers_search.png` and `layers_legend.png` into `test/shots/`;
not pass-fail — look at them. The baseline the acceptance test compares against is
`test/fixtures/layer_rows_pre_v16.json`, dumped from the pre-v16 build: every
`(group, id)` that existed before must exist after, and no row may be invented.

## v17 — the iPad: three profiles, one recogniser, the Pencil, and the hardware

Contract: `docs/V17_TOUCH_SPEC.md`. No kernel work (`VERSION` stays 8). New
files `js/touch.js`, `js/redline.js`, `sw.js`, `manifest.webmanifest`,
`icons/*` (drawn by `tools/make_icons.py`); the rest is the CSS `body.touch`
block, `js/viewer3d.js`, `js/sheets.js`, `js/sheetmarks.js`, `js/pick3d.js`,
`js/snap.js`, `js/shell.js`, `js/layertree.js` and `js/util.js`. Harnesses
`test/touch_unit.mjs` (node, no browser) and `test/e2e_tablet.mjs`; shots
`test/tablet_shots.mjs`; `test/audit.mjs` gained a touch pass.

**Three profiles, one class.** `phone` is the v11 rule unchanged (coarse pointer
AND `innerWidth <= 900`) and still owns `body.field`; `tablet` is touch-capable
AND wider than 900 — the desktop layout with touch affordances — and is
`body.touch` only; `desktop` is neither. `body.touch` is to v17 what
`body.field` is to v11: the ONE switch every style keys off, so
`test/e2e.mjs` passing unchanged IS the proof the desktop is untouched.
Touch-capable means `(any-pointer: coarse)` OR `maxTouchPoints > 1` — **never a
UA sniff**, because iPadOS reports a desktop UA. **The phone test is on the
LONGER edge of the viewport, not on its width**, and there is one file with the
rule in it: an iPad in PORTRAIT is 834 x 1194, so a width-only test reads it as
a phone and lays it out as one — the exact thing v17 exists to avoid, and the
first thing `test/e2e_tablet.mjs` caught. Split View at 507 x 834 has 834 as its
longer edge and IS a phone, which is what §1 asks for, and a Pixel 7 at 412 x 839
stays one. `js/field.js`'s own `sniff()` delegates to `SBMM.touch.sniff()` for
exactly this reason — the two must agree or boot puts a portrait iPad into the
phone layout while `profile()` calls it a tablet.

**And the size is `edge()`, not `innerWidth`: a page can force the layout
viewport WIDER THAN THE GLASS.** Ask this app at 507 x 834 and `innerWidth`
answers **828** — the top bar under `body.touch` carries 22 buttons at 44 px, its
min-content width is ~828, and the browser widens the layout viewport and scales
the page rather than clip it. So the app measured its own top bar and concluded
it was on a tablet, which is a self-fulfilling loop: stay a tablet, keep the wide
bar. `screen` alone is not the answer either — iPadOS reports the whole 1194-px
screen to a 507-px Split View pane. `edge()` takes the **smaller of the two on
each axis** and then the longer of those: a page can be laid out wider than the
glass, and the glass is never wider than the screen. `test/touch_unit.mjs` has
both cases in isolation. A stored `SBMM.field` preference
beats the viewport in both directions, so the resize handler only follows the
phone/tablet line when the user has expressed none.

**Per EVENT, not per profile.** `SBMM.touch.lastPointer()` returns
`"mouse" | "touch" | "pen"` from the last pointer event seen in a capture-phase
listener on `document`, and the hit tolerances read THAT: `js/snap.js`'s
`touchK()` and `js/pick3d.js`'s raycaster thresholds are 1.5x / 2x for a finger
and mouse-sized for a pen or a mouse on the same screen a second later.

Seven things here will be walked into again:

- **The recogniser is ONE implementation and it is DOM-free.**
  `SBMM.touch.recognizer(handlers, opts)` takes pointer-shaped records and calls
  handlers; `gestures(el, h)` is the thin part that wires real events to it.
  That is what lets `test/touch_unit.mjs` drive tap / double-tap / two-finger tap
  / long-press / pan / pinch / twist / three-finger / flick / palm / modifier
  arithmetic in node in under a second (56 checks). **Run it after any change to
  the recogniser, before you reach for Playwright.** Do not write a second pinch
  anywhere; the 3D rig, the sheet viewer and the map sketch all use this one, and
  v11's own pinch inside `js/viewer3d.js` was DELETED rather than kept beside it.
- **`gestures(el, h)` calls `setPointerCapture` on `el`, so it must never be
  attached to the MAP CONTAINER.** Capturing there redirects every subsequent
  pointer event away from Leaflet's own marker elements, and a vertex handle is
  a draggable marker — it would stop dragging by finger the moment the container
  captured. `js/touch.js` `wireMap()` therefore builds a `recognizer(...)`
  directly and feeds it from its own capture-phase listeners: the same gesture
  semantics, no capture. The 3D canvas and a sheet view own their pointers
  outright, so they use `gestures` as it comes.
- **A browser delivers one pointermove at a time**, so a two-finger gesture
  arrives as a pair of half-transformed frames. Each `pinch` event reports the
  frame it saw: `scale`/`dcx`/`twist` are since the LAST move and `totalScale`/
  `totalTwist` since the gesture began. A test that expects one atomic
  transform per pair of moves is wrong about the browser, not about the code.
- **Momentum MUST settle.** `v *= 0.92` per frame, stop under 0.02 px/ms — about
  55 frames — and nothing asks for a frame after that. A momentum that keeps
  requesting frames leaves the 3D view rendering for ever and `test/perf.mjs`
  fails an idle view that still renders. The e2e asserts the render count stops
  moving after a flick.
- **Pinch-dolly raycasts ONCE per gesture.** `pinchstart` picks the terrain under
  the midpoint and every `pinch` dollies about that fixed scene point with
  exactly the wheel's own maths (`dollyAbout`), plus `panBy(dcx, dcy)` for the
  midpoint's own motion. Re-picking a 1.5 M-vertex mesh per pointermove is the
  difference between a pinch that tracks and one that stutters.
- **A tap also produces a `click`.** The 3D canvas's click handler is factored
  into a module-level `canvasClick` that both the DOM `click` (mouse) and the
  recogniser's `tap` call; the DOM handler bails on `SBMM.touch.touchRecent()`
  so a tap never picks twice. The nav rig is built in its own closure
  (`makeNav`), which is why `canvasClick` is module-level and not inside
  `init()`.
- **The loupe is not decoration.** A fingertip is ~44 px across and sits ON the
  point it is placing, so a tap cannot place a vertex on a 1 in = 20 ft drawing.
  Press-and-hold shows a 2.5x, 120-px circle above-left with a crosshair on the
  exact point, the finger slides, and the vertex lands where it LIFTS. It is ONE
  canvas shared by the map and every sheet window; the map's source is a
  `snapshot()` of the pane canvases taken ONCE per press (there is no
  html2canvas here and never will be), the sheet's is `st.img` directly. Two
  fingers cancel the placement and become a pinch. A PEN skips all of it — a
  Pencil tip is exactly where it looks.
- **`Enter`, `Backspace` and `Esc` do not exist under a thumb**, so a sketch open
  under `body.touch` gets the Done bar (Done / Undo vertex / Cancel), one shared
  element driven by `js/touch.js` for the map and `js/sheetmarks.js` for a sheet
  window. The touch furniture — loupe, Done bar, tooltip chip, ink palette —
  lives in a new **4900-4999** band, above the sheet windows (a loupe behind the
  drawing it magnifies is useless) and below the picker, the modals and the
  toast. It is in the stacking comment at the top of `css/app.css`.

### The Pencil (§5a)

- **Palm rejection is one question, asked in one place.** While a pen pointer is
  down, or within 150 ms of it having been, a `touch` pointer is not a gesture:
  the recogniser records it as a MODIFIER instead of dropping it, because "pen
  drag with a finger held" IS a gesture — the 3D pan — and the handler reads
  `g.modifier` to tell the two apart.
- **Pen hover is a real hover**, so `js/pick3d.js` lets `pen` into the hover and
  drag paths and keeps only `touch` out. A finger's press is how the orbit
  starts, which is why a finger reaches a 3D vertex handle through
  `SBMM.pick3d.touchDrag` from the rig's long-press instead — the same
  onDown/onDrag/onUp the mouse uses, handed a synthetic event.
- **REDLINE** (`MARKUP`, `INK`) is freehand ink and a MODE like every other tool.
  `getCoalescedEvents()` is what makes a fast stroke a curve rather than a
  polygon; `e.pressure` drives a width stored PER VERTEX so a stroke reloaded
  from a session is the stroke that was made. The stroke is simplified on
  pen-up through the **ring-aware** `simplifyPath` (a redline circle is the
  commonest closed loop anyone draws, and naive DP collapses one). `ink` is in
  all five FeatureGroup places (`layerFor`, `applyStyle`, `redraw`, `relayer`,
  `rebuildFeature`), exports to GeoJSON as a LineString and to DXF on a
  **`REDLINE`** layer (one layer whatever folder it was drawn into — "freeze the
  redlines" needs one name), drapes in 3D **unshadowed** (a mark-up sits ON the
  drawing), and prints in the report in its own colour rather than the quiet grey
  every other background feature gets.
- **Two things the spec asked for that are deliberately NOT what shipped, both
  because `test/e2e.mjs` has to pass unchanged**, and both one line plus one
  harness edit away: (i) the session integer is still **8**, not 9 — the `ink`
  type is additive by the same mechanism every bump before it used, nothing
  reads the number to decide anything, and `test/e2e.mjs` asserts `=== 8` in
  three places; (ii) a redline joins the **Drawings** My-work class rather than
  getting a "Redline" row of its own, because block 9z baselines every
  `(group, id)` against `test/fixtures/layer_rows_pre_v16.json` and fails on an
  invented row. Both are noted in the code at the line that would change.

### The hardware (§5b)

- Anisotropic filtering on the drape textures comes from
  `renderer.capabilities.getMaxAnisotropy()` capped at 16, not the old constant 4
  — the ortho at a grazing angle is where the 3D view looked cheap.
- **A WebGL context loss is recovered, not a black rectangle.** iPad Safari drops
  contexts under memory pressure; `webglcontextlost` prevents the default (which
  is what makes a restore possible at all), `webglcontextrestored` rebuilds the
  terrain, the drape and the overlays from the store, and both toast.
- The compute pool is `max(2, min(8, hardwareConcurrency - 1))` — an M-series
  iPad has 8-10 cores and was being given one worker. A two-core build box still
  gets two.
- **`download()` in `js/util.js` is the one place every export passes through**,
  so `navigator.share({files})` goes there: on a touch device with a shareable
  file it opens the iPad share sheet, and `<a download>` is the fallback on every
  refusal except `AbortError` (the user closing the sheet is not a failure and
  must not toast). Add an export path and it gets the share sheet for free.
- Position and Photo are reachable in the TABLET profile through the top bar's
  **Field ▾** menu — the same `js/field.js` functions, one more entry point — and
  `SBMM.field.card()` falls back to the Inspector when there is no bottom sheet
  to put it in.
- A screen wake lock is held while Position is on or a job is in flight
  (`SBMM.touch.keepAwake(reason, on)`, reference-counted, re-acquired on
  `visibilitychange` because the browser takes it away when the tab is hidden).

### The offline copy — the ONE `fetch()` exemption

`sw.js` is the only file in this repo that may call `fetch`, and it is not the
app. `js/touch.js` registers it **only when `location.protocol` is `http:` or
`https:`** — over `file://` nothing registers, nothing fetches, and the Help
button says why. It caches its own origin only. The precache list is read out of
`index.html` AT PRECACHE TIME (its `<script src>`, `<link href>` and the icon
set), never restated in the worker, because a second copy of a 90-line script
list goes stale the first time a module is added. `index.html` is served
network-first (a deployed change wins) and everything else cache-first; the
FNV-1a hash of the served `index.html` is stored beside the cache, and a
difference posts `{type:"stale"}` to every client, which becomes one toast and an
"Update offline copy" button. `tools/build_dist.py` DROPS the `manifest` and
icon `<link>`s from both single-file builds — beside a lone HTML file they are
guaranteed 404s — and keeps the apple/theme meta tags, which carry no URL.

## Undo and redo (v9.4) — the both-closures rule and `readd`

`SBMM.undo` is two stacks of `{ desc, undo, redo }`, 100 deep each way:

```
SBMM.undo.push(desc, undoFn, redoFn)   // BOTH closures are required
SBMM.undo.pop() / redo() / canUndo() / canRedo() / labels() / clear()
SBMM.undo.onChange(fn)                 // after every push/pop/redo/clear, and once on subscribe
SBMM.undo.drop(n, desc)                // forget trailing entries WITHOUT running them
```

- **A push without a `redoFn` is a bug, not a style.** It reports itself in the console and
  the entry is DROPPED — an action that can be undone and not redone is worse than one that
  cannot be undone, because the button lies about it. Every push site in the app passes two
  closures; adding a new one means writing the inverse, not omitting it.
- **A push clears the redo stack.** A new action after an undo forks history and the
  abandoned branch is gone.
- **Capture the "after" state at the moment the action completes**, never lazily at redo
  time — otherwise a later edit walks into an older entry's redo. This is why the vertex
  drag in `js/draw.js` and the 3D handle in `js/pick3d.js` push on drag*end* (with the
  before captured at drag*start*) rather than on drag start, and why `js/water.js`'s
  retrace copies the new run beside the old one. And every restore closure hands over a
  **fresh copy** of the point array: a drag writes through `f.pts` in place, so handing back
  the stored array would let the next drag quietly rewrite history.
- **`SBMM.store.readd(f)` is the redo of "a feature appeared", and the undo of a delete.**
  It re-inserts the SAME object with the SAME id, so selection, provenance, the results card
  and anything holding a reference survive. It works because `remove()` DETACHES and never
  destroys: the Leaflet layer, the `extraLayers` (cut/fill overlay, design raster, section
  band) and the card element are all still on the object. Only a feature whose layer was
  thrown away needs a new one, and that comes from `SBMM.tools.relayer(f, true)` — the same
  builder `newFeature` uses — with **nothing recomputed**. Do not make `remove()` null any
  of that.
- **The sketch's own per-vertex entries die with the sketch.** `js/draw.js`'s teardown calls
  `SBMM.undo.drop(work.undos, "add vertex")`; the finished feature gets one "draw Line 3"
  entry from the tool's `onFinish`. Undo after drawing removes the shape, not its last
  vertex.
- Deleting is an action: `SBMM.tools.deleteFeature(f)` removes and pushes the entry, and is
  what `ERASE`, the 3D Delete key, the results-card ✕, the Features-tree and Inspector
  deletes, the popup's delete button and the design-surface list's delete all call (v9.7).
  **A new user-facing delete path calls `deleteFeature`, never `SBMM.store.remove`** — the
  only direct `remove` calls left are inside undo/redo closures.
- The two buttons are a view onto the two stacks (`js/boot.js`, through `onChange`):
  disabled when their stack is empty, titled with the entry's description. Keys are
  `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` in `js/draw.js`, under the same guards (not while
  typing; the gate stops every key ahead of them in the capture phase). The e2e block
  **"9u. redo"** is the contract.

## The password gate (v9.3) — a deterrent, not security

`js/gate.js` puts a password screen in front of the app. **Never describe it as
security and never build anything on top of it as if it were.** The whole app is in
the file the browser opens; the check is in that same file. It stops the workbook
being *used* by whoever the file gets passed to sideways, which is exactly what it
was asked to do.

- **It is the FIRST script in `index.html`**, before `vendor/leaflet.js` and before the
  ~130 MB of `datajs` payloads, so it paints before anything else is parsed. The app
  boots underneath it — the gate covers and blocks, it does not pause boot, and it does
  not touch the `#loading` logic (loader z 3000, gate z 9000).
- **z-index 9000** — the one thing above the toast (7000); it is in the stacking comment
  at the top of `css/app.css`, where all of this lives.
- **The check is `SHA-256(SALT + password)`** against a hex constant in `js/gate.js`.
  The plaintext is not in the app, not in the tests and not in the README —
  `docs/HANDOFF.md` carries it, once, because the repo is private.
  `python tools/set_password.py "<new>"` rewrites the hash (and that line) and tells
  you to rebuild the dist. `crypto.subtle` is used where it exists; a pure-JS SHA-256
  is the fallback, and `test/gate.mjs` checks it against node's crypto.
- **A remembered unlock** is `localStorage["sbmm.gate.v1"] = {h: <hash>, t: <ms>}`, good
  for 30 days. `LOCK` / `LOGOUT` in the command bar clears it and puts the screen back.
  **There is no URL-parameter bypass and no test flag** — adding one would be the whole
  point thrown away.
- **Keys are stopped in the capture phase on `document`**, and because gate.js is the
  first script its listener is the first one registered on that node, so
  `stopImmediatePropagation()` there beats the capture-phase handlers in `cmdline.js`,
  `layerman.js`, `cultural.js` and every bubble-phase one in `mode.js` / `sheets.js`.
  Typing still works: stopping propagation does not stop the browser's default action.
  Pointer and wheel are stopped in the capture phase on the gate element, with the
  button wired by delegation on that same node (a capture `stopPropagation` blocks
  descendants, not siblings — a listener on the button itself would never fire).
- **The harnesses do not weaken it.** `test/gate.mjs` exports `unlock(page)`, which
  `page.addInitScript`s the same localStorage record a real unlock writes, reading the
  hash out of `js/gate.js` with a regex. Every harness that calls `page.goto` calls it
  first. `test/e2e.mjs` then opens a SECOND page *without* the token and asserts the
  whole contract; `test/gate_shots.mjs` writes `test/shots/gate.png` and
  `gate_unlock.png` (not pass-fail — look at them).
- **Three traps.** (i) `cmdline.js` opens the command bar by itself on a browser's
  *first* visit and calls `inp.focus()` while doing it — a few seconds into boot, i.e.
  while someone is already typing their password. Stopping a key's propagation does not
  stop its default action, so without the capture-phase **focus trap** in `gate.js` the
  password goes into the command bar behind the gate and Enter submits an empty field.
  The same auto-open means a fresh-context assertion about "the backtick did not open
  the command bar" has to close it first. (ii) `page.waitForTimeout` overshoots by
  400–800 ms on a busy software-GL page, which is why the mid-unlock screenshot has
  nothing between the wait and the shutter — an `evaluate()` in there photographed the
  app instead of the animation. (iii) `#gate` sets `user-select:none`, so the password
  input has to set it back to `text`.

## Conventions

- Keep the dark theme tokens in `css/app.css` `:root`; monospace tabular numerals for
  all numbers. Volumes reported to 2 significant figures with the planning-level
  caveat (the wording exists in tools.js/report.js — reuse it).
- Everything user-drawn is a feature in `SBMM.store` and must: appear in the feature
  manager, serialize in sessions (additively versioned), export to GeoJSON (and DXF
  where geometry allows), be undoable, and recompute on vertex edit.
- Session files (.sbmm.json) must stay backward compatible — old files always load.
  Now **v8**: adds the `photo` feature type (v11 §4.4 — a session with photos is big, and
  that is accepted; the GeoJSON export asks before it carries the images). v7 added the
  layer state (`layers`); v6 added imported datasets. Baked datasets are
  never serialised, and neither are EA's reference design surfaces or the cultural layer
  state — they ship with the app, so a stale copy in a session file must not win, and §7
  wants the cultural acknowledgement asked once per session rather than remembered.
- New recurring data goes through `js/datasets.js`, not a new bespoke layer module.
  `data/datasets/ds_*.json` are merged into ONE `datajs/d_datasets.js` payload, so adding
  one needs no new `<script>` tag — unlike design sheets, which still do.
- Heavy loops (>~1 ms) go through `SBMM.compute` jobs with progress + cancellation.
- File author metadata on generated documents: "Mohammad Sharif".
- Every failure the user can cause must raise a `toast()` — a silent refusal is the one thing
  this app must not do. `test/audit.mjs` records the toasts each path raises; if a probe there
  prints an empty toast list for a refusal, that is the bug.
- Tooltips are sentence case and name the shortcut in brackets where there is one.

## Field mode and the `photo` feature (v11 §4)

`body.field` is the ONE switch, `SBMM.field.on()` reports it, `SBMM.events` emits `field`.
It turns itself on at boot on a coarse pointer with a viewport <= 900 px (a stored
preference beats the sniff either way), and `FIELD` / the Help switch / the More sheet
toggle it anywhere. **Everything field-mode is behind `body.field` in CSS and behind
`if (active)` in `js/field.js`, which is what makes "desktop is untouched" a property of
the code rather than a promise** — `test/e2e.mjs` is the proof, unchanged.

Four things here will be walked into again:

- **`photo` was added the way `flow` was, and the same five places carry it.**
  `js/tools.js` `layerFor` returns an empty `L.featureGroup` for it, `applyStyle` and
  `redraw` both dispatch to `SBMM.field.buildPhoto`, `relayer(f, true)` rebuilds it, and
  `rebuildFeature` sends it to `SBMM.field.mkPhoto` — which rebuilds from `props` and
  **never recomputes**. Adding a fifth FeatureGroup type means touching all five.
- **The "Field" My-work class row is APPENDED**, like "Water" before it, because
  `SBMM.myWork.classOf` reads `CLASSES[4]` as "imported wins" and that index is
  load-bearing.
- **A Leaflet popup's content can be a FUNCTION.** The photo marker registers one
  (`bindPopup(() => SBMM.popups.forFeature(f))`) so the picture is built at open time, and
  `getContent()` hands back the function rather than the HTML. The field card's
  `popupopen` hook resolves all three shapes — string, node, function — because getting
  that wrong renders `function () {…}` into the card with no error anywhere.
- **There is ONE toast element**, so two refusals raised in the same task overwrite each
  other and only the last is ever seen. A test that drives several refusals has to leave a
  gap between them (`test/e2e_field.mjs` does); so does any code path that means to tell
  the user two things.

Position (`SBMM.field.locate`) is `navigator.geolocation.watchPosition`, feature-detected,
converted through `SBMM.fromLL` (the ±1 ft affine — the marker's card says so).
**It never fabricates a position**: no API, a refused permission, an error or a silent
watch all raise a toast, and the marker exists only while a fix does. The EXIF reader in
`js/field.js` is ~90 lines over the JPEG APP1 / TIFF layout and reads exactly three things
(orientation, DateTimeOriginal, GPS lat/long); `tools/make_photo_fixture.py` writes the
fixture it is tested against and documents the byte layout.

The 3D nav rig gained touch: `js/viewer3d.js` tracks live TOUCH pointers in a Map, and
while there are two the drag becomes a pinch (spread dollies, the moving midpoint pans).
Mouse and pen never enter that map, so the desktop rig is byte-for-byte the same gesture
it was. `#v3dCanvas` carries `touch-action:none` or the browser takes a two-finger drag
for a page scroll before the rig sees it.

## Sensitivity

The repo contains site imagery, terrain, and analytical sample results for an active
Superfund project. Keep the GitHub repo **private**. Don't add analytics, external
CDNs, or any network calls.

## v14 Phase 2 — the design storm

Contract: `docs/V14_PHASE2_RUNOFF_SPEC.md` (Phase 2 of
`docs/V14_CATCHMENT_PROPOSAL.md`). Kernel `runoff` in `js/compute.js`
(**api VERSION 9**); host `js/runoff.js` (`SBMM.runoff`); builders
`tools/build_rainfall.py` and `tools/build_cover.py`; harness section `runoff`
in `test/kernels.mjs`; e2e block **"9aa. design storm"**.

Phase 1 said where the water goes. This says **how much, in a design storm**,
over Phase 1's own catchments — so the two can never disagree about which
ground drains where. **Every number rests on an assumption, and every
assumption is a ruling of the spec's §1 table**: it is printed on the card,
printed first on the report sheet, and changeable in one dialog (`RAIN`).

### The chain, and where each link lives

| link | method | where |
|---|---|---|
| rainfall | NOAA Atlas 14 vol. 6 point estimates at 39.003 N, 122.663 W | `tools/build_rainfall.py` → `SBMM_DATA.rainfall` |
| land cover | 2-ft class raster, EA's layers + the CHM + the ortho | `tools/build_cover.py` → `SBMM_DATA.cover` / `cover_png` |
| runoff volume | NRCS curve number, `Q = (P − 0.2S)²/(P + 0.8S)`, AMC II | `runoff` kernel |
| time of concentration | TR-55 ch. 3 segments along Phase 1's longest flow path | `runoff` kernel |
| peak flow | Rational to 200 ac **and** an SCS unit hydrograph everywhere | `runoff` kernel |
| pond routing | level-pool (Modified Puls) on the `overtop` kernel's stage table | `js/runoff.js` `routeOne` |

**`RAIN` is the design storm now, not the raindrop.** It was an alias of `DROP`
until v9.13; an alias belongs to exactly one command (a duplicate silently kills
the later one and the e2e fails on it), and the raindrop keeps `RAINDROP`,
`WATERDROP` and `FLOW`. `RUNOFF` and `DESIGNSTORM` are the new aliases.

### Six things here are traps

- **A step of the order of Tp misses the unit hydrograph's peak.** At Tc = 6 min
  (Tp = 0.116 h) a 6-minute step reads the peak 4 % low, which would put the
  kernel outside its own acceptance test. The kernel therefore picks **one time
  base for the whole site**, no coarser than a **tenth of the shortest Tp** it
  was given, and reports it on every hydrograph (`hydro.dt_min`). One base is
  also what lets the site total be the plain sum of the catchment hydrographs —
  and it is why `routeOne` must take the INFLOW's own `dt_min`, not the outlet
  run's: the two jobs are given different catchments and pick different steps.
- **The unit hydrograph's shape is not a taste.** Peak rate factor 484 is
  exactly the statement that the dimensionless curve integrates to 4/3, and
  `UH_SHAPE = 3.6969` is the root of that (solve `∫u^m e^{m(1−u)}du = 4/3`).
  The ordinates are then normalised to one inch over the catchment, so
  "volume = Q·A" is true by construction and "peak = 484·A·Q/Tp" follows from
  the shape. Both are asserted in `test/kernels.mjs` §12.3; change `m` and both
  break, which is the point.
- **The spec's own worked example is wrong in one cell, and the equation wins.**
  §3(a) prints Q = 2.17 in for P = 4.0 / CN = 85. That does not satisfy
  `Q = (P − 0.2S)²/(P + 0.8S)` — the equation gives **2.458**, and 2.17 is the
  answer for CN ≈ 81.4. The harness restates the equation and says so in place;
  the spec's other number (CN 70 → 1.33) agrees exactly.
- **Areas come from Phase 1, class shares from the label raster.** The
  drainage map's areas are full-resolution cell counts and its label raster is
  decimated for display, so the kernel takes `area_ft2` from the record and only
  the class FRACTIONS from the raster. Mixing them would quietly move an
  acreage someone digs from.
- **There is no flow-accumulation raster in this app**, so TR-55's "channel flow
  where the accumulation exceeds 5 acres" is applied with the upstream area
  approximated as `catchment area × (path length above the point / total path
  length)` — linear in path length, monotone, stated on the card and in the
  report. It puts a 280-acre catchment into channel flow almost at once and
  never puts a half-acre one there, which is the behaviour the rule is for. A
  real accumulation raster is a Phase 3 item, not a bug fix.
- **A pond is routed off its EA water polygon, not off a point.** `stageTable`
  applies the August-2026 survey only when the seed is a RING containing the
  surveyed water-level shot (`js/water.js` `surveyFacts`), so a point seed would
  route the impoundment off the lidar's January-2024 water surface and lose the
  1,341.55-ft pipe row the card is checked against. `waterRingAt()` in
  `js/runoff.js` finds the polygon; failing that it falls back to the point.

### The cover raster

`tools/build_cover.py` paints one class per 2-ft site cell in the spec's
priority order — grass by default, then the ortho's green-excess split, canopy
(CHM ≥ 6 ft), mine waste (the DUs, the traced piles, EA's repository and staging
polygons), gravel roads, paved roads, buildings, open water — and writes
`data/cover.png` **as an 8-bit RGB image whose colours ARE the class palette**.
Not indexed: the map draws that PNG directly as its own legend, and
`test/lib/png.mjs` decodes 8-bit RGB/RGBA and nothing else, so an indexed PNG
would be unreadable in the node harness. Two consequences to keep in mind:

- **EA draws roads as LINES**, so a paved surface has to be given a width;
  `ROAD_HALF_FT` (8 ft) is that assumption and `data/cover.json` records it
  beside an independent analytic estimate of the paved footprint, which is what
  the harness checks the rasteriser against.
- **The hydrologic soil group is a property of the CLASS** (D for the mine-waste
  class, C for everything else — the spec's ruling), which is why "bare /
  disturbed" and "mine waste" are two classes with the same curve numbers: they
  differ only in the letter, and the letter is the biggest assumption in the
  chain.

### Payload tolerance

`d_rainfall.js`, `d_cover.js` and `i_cover_png.js` are all in the **field
build** (they are small, and without the cover raster every curve number would
be a guess). If either is absent the module still builds a row and refuses with
a toast — `SBMM.runoff.build()` returns early when both are missing, the cover
row becomes "Land cover (not in this build)", and `run()` toasts and returns
null rather than throwing.

### What it found, recorded from this commit

On the **provisional** 25-year 24-hour depth (6.4 in, NRCS Type IA) over the
Phase 1 catchments sampled at 8 ft — `node test/kernels.mjs --only runoff`,
69 checks in 12.7 s:

| catchment | acres | CN | Q | volume | Tc | SCS peak |
|---|---|---|---|---|---|---|
| Clear Lake — direct overland | 403.05 | 82.0 | 4.36 in | 146.49 ac-ft | 21.2 min | 565 cfs |
| Off the surveyed ground | 293.45 | 81.0 | 4.25 in | 103.87 ac-ft | 6.0 min | 429 cfs |
| Clear Lake outfall (storm network) | 281.99 | 83.6 | 4.53 in | 106.34 ac-ft | 17.1 min | 425 cfs |
| **site** | **978.49** | **82.2** | — | **356.69 ac-ft** | — | **1,396 cfs** |

**No catchment gets a Rational peak, and that is the rule working**: all three
are over the 200-acre limit, so the card reports "not reported above 200 ac"
rather than a number the method does not support.

**None of the three ponds overtops.** The impoundment rises 0.82 ft
(1,336.45 → 1,337.27) and never reaches its surveyed 1,341.55-ft discharge
invert; Frog Pond leaves through the pond culvert at 1,415.75, 0.29 ft under
its 1,416.04-ft rim; Green Pond is contained 1.4 ft below its FES. Those are
the answers for THIS storm on THESE depths — the whole table moves when the
Atlas 14 export replaces the provisional one, and the harness numbers have to
be re-recorded with it.

### The one acceptance check that could not be run as written

Spec §3(g) asks that "the paved class area agrees with EA's paved polygons
within 5 %". **EA has no paved polygons** — it draws roads as LINES, two of
them per road — so a length × width reference double counts every road while
the raster merges the overlap, clips to the surveyed ground and is overpainted
by buildings and water. The comparison is one-sided by construction and is
−16.7 % here, all of it explainable and none of it about placement. So the
harness tests placement directly — **a point every 10 ft along every EA paved
road line must read `paved`, and 4,206 of 4,206 eligible points do** — and
keeps the area comparison beside it as the one-sided identity it is, with the
reasons printed. Do not "fix" this by widening the tolerance; the area number
is not the question.
