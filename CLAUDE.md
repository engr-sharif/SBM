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
2. **Two builds from one source, both must pass tests:**
   - Folder build: `index.html` + `js/` + `datajs/` + `vendor/` (this repo, also
     GitHub-Pages hostable).
   - Single-file build: `python tools/build_dist.py` → `dist/SBMM_Site_Explorer.html`
     (~94 MB, everything inlined — the copy the team double-clicks; the 20 full-sheet
     plan renders are ~27 MB of that).
     New JS files MUST be added to `index.html`'s script list or the dist silently
     lacks them. Note: `build_dist.py` stamps the build *before* inlining because
     `js/report.js` contains a literal `</title>` inside a template string.

## Running tests (do this after every change)

```
cd test && npm install && npx playwright install chromium && cd ..   # once per machine
node test/e2e.mjs     /abs/path/index.html                folder
node test/e2e.mjs     /abs/path/dist/SBMM_Site_Explorer.html dist
node test/split3d.mjs /abs/path/index.html                folder
node test/split3d.mjs /abs/path/dist/SBMM_Site_Explorer.html dist
```
The harnesses use Playwright's own chromium unless `CHROME_BIN` points at one (the cloud
build box's `/opt/pw-browsers/...` path is tried first and skipped if absent); paths are
resolved through `pathToFileURL`, so Windows paths work. Runs are slow under software GL
(180 s default timeouts are intentional). All four must pass.
`test/v9_shots.mjs` writes the §11 audit shots (2D, 3D, split, a sheet window with a mark,
the cultural acknowledgement, the Layer manager, the isopach) into `test/shots/`;
`test/phaseB_shots.mjs` writes the sheet-viewer / layers / dataset screenshots. Neither is
pass-fail — look at them. Four more diagnostics, none of them pass-fail — run them when you
have changed behaviour, and read the output:
```
node test/boot_time.mjs /abs/path/index.html 3     # boot to first interaction + the stage table
node test/perf.mjs   /abs/path/index.html folder   # 3D / memory numbers (its layer-toggle loop
                                                   #   still drives the removed 3D checkboxes)
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
| util.js | formatting, geometry helpers, ramps, toast; `$()` |
| compute.js | **pure** compute kernels (volume grid, rasters, marching squares, ring-aware simplify) — no DOM, no SBMM; runs in workers |
| jobs.js | worker pool: progress, cancel, transferables; `SBMM.compute` |
| dem.js | DEM decode + bilinear `at()`, slope/aspect; the DEM stack `SBMM.dems` / `setDems` / `demAt` / `demForBox`; `SBMM.elev`, `SBMM.slopeAt`, `SBMM.canopy` |
| proj.js | affine SP↔WGS84, coordinate parsing |
| state.js | feature store (select/groups/visible/locked), undo, sessions (v7; loads v2+) |
| layerstate.js | **`SBMM.layerState` — the one answer to "is this layer on"** — plus the `SBMM.events` bus ('layers', 'mode', 'view') |
| view.js | `SBMM.view` — remembers the 2D centre/zoom and the 3D orbit camera in localStorage and restores them on boot (guarded, debounced, range-checked) |
| mode.js | **`SBMM.mode` — the tool-mode state machine (§2)**: modes, cursor, Mode HUD, every single-key shortcut, Esc discipline, Space-to-pan; also `SBMM.status` (the status bar, written by both views) |
| shell.js | dock layout, left tabs (Layers/My work/Sheets), right tabs (Inspector/Results) + their auto-switch, four-stage topbar narrowing, job bar |
| map.js | Leaflet init, layer-row API `SBMM.addLayerRow` (a row is a VIEW onto `SBMM.layerState`), zoom-gated annotation, context menu |
| layers.js | basemaps, survey contours, DUs, piles, samples (+symbology); `SBMM.layersUI` — the six §4 groups, master checkboxes, count badges, Areas quick-nav; `SBMM.myWork` — the class mask over the user's own features |
| analysis.js | slope/aspect/hypso/canopy raster layers, custom contours |
| draw.js | sketch engine: vertex edit, ortho/polar, typed input (`@150<45`), 3D hooks |
| snap.js | object snaps (grid-hash index, glyph overlay canvas, F3) |
| cmdline.js | command bar (`` ` `` / Ctrl+K / `/`), 48 AutoCAD-alias commands, all routed through `SBMM.mode` |
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
| layerman.js | the Layer manager dialog: search / toggle / recolour / opacity / source + handle for EA's 110 CAD layer names |
| sheetcards.js | the Sheets tab — a card per drawing with a thumbnail derived on first open, filtered by lot |
| popups.js | **the** popup builders — `SBMM.popups.forFeature/forDataset/forGis/forCad/forSample/forTree/forTerrain`. 2D binds them through Leaflet, 3D drops the same string into the pick card |
| watermark.js | the "Mo Sharif - Jacobs 2026" element AND the burn-in every canvas export goes through (`burn`, `burnWebGL`) |
| cultural.js | cultural resources (CONFIDENTIAL): off by default, acknowledgement gate, stamp, export gating |
| pick3d.js | 3D pick registry, hover, identify card, 3D vertex handles |
| sheetmarks.js | measuring and marking inside a sheet window; sheet px ↔ State Plane, one affine per plan viewport where a sheet has several (C-202) |
| boot.js | startup sequence, error reporting, first-run hint |

## Boot cost and the payload contract

Boot is dominated by two things and nothing else is worth chasing until they change:
**decoding the terrain PNGs** and **parsing ~90 MB of base64 string literals** (dist only).
`test/perf.mjs` prints the stage-by-stage numbers (`SBMM.perf.report()` in the console, or
append `?perf` to the URL — the marks are always collected, they just stay quiet).

- **Never decode a data-URL through `new Image()` + `img.decode()`.** That path re-parses
  the base64 through the resource loader: 1168 ms for the 4850x4450 site DEM. `atob` →
  `Blob` → `createImageBitmap` does the same work in ~290 ms because the bytes are handed
  straight to an off-thread decoder. `Dem.pixels()` does this, with the old path kept as a
  fallback. This one change was ~1.5 s of the boot.
- **The CHM stays inside the loader — deferring it was tried and reverted.** Moving it off
  the boot path bought ~0.55 s of time-to-interactive and spent it on a ~0.6 s main-thread
  stall landing one to three seconds later, on whatever the user had already started (it
  showed up as a phantom "1.3 s layer toggle" in `test/perf.mjs`). Banding both the
  `getImageData` and the `drawImage` did not fix it: most of the block is inside
  `createImageBitmap` decoding an 11.1-megapixel PNG, which does not divide. Doing it
  properly means a worker, and the job protocol in `compute.js` is synchronous — an async
  kernel is the prerequisite. The seams are all still in place for that: everything that
  consumes canopy heights awaits `SBMM.chmReady` (now an already-resolved promise), and the
  canopy Layers row is built by `SBMM.buildCanopyLayer()` rather than inline.
- **`SBMM_DATA.dem_site_png / dem_abp_png / dem_res_png / chm_png` are set to `null`
  once decoded** — 31 MB of string nothing reads twice. The *keys* stay (the dual-build
  contract), and the e2e asserts both halves of that. Do not add a second reader of those
  four. `dem_res` costs ~0.12 s of boot (a 6.7-megapixel PNG); `dem_res` and the CHM are
  both optional payloads and the app boots without either.
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
  holds DOM nodes. Wrap it in a block that returns nothing.
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

## Conventions

- Keep the dark theme tokens in `css/app.css` `:root`; monospace tabular numerals for
  all numbers. Volumes reported to 2 significant figures with the planning-level
  caveat (the wording exists in tools.js/report.js — reuse it).
- Everything user-drawn is a feature in `SBMM.store` and must: appear in the feature
  manager, serialize in sessions (additively versioned), export to GeoJSON (and DXF
  where geometry allows), be undoable, and recompute on vertex edit.
- Session files (.sbmm.json) must stay backward compatible — old files always load.
  Now **v7**: adds the layer state (`layers`). v6 added imported datasets. Baked datasets are
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

## Sensitivity

The repo contains site imagery, terrain, and analytical sample results for an active
Superfund project. Keep the GitHub repo **private**. Don't add analytics, external
CDNs, or any network calls.
