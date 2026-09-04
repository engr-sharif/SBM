# SBMM Site Explorer — v11 specification: hygiene and the field (authoritative)

Owner/decider: Fable (planner). Executors: Opus agents R (redo), K (kernel
harness), D (worker-side terrain decode), F (field mode and the field build).
This document is the contract: agents implement what is written here and do
not re-decide it. Where it is silent, choose the simplest option consistent
with CLAUDE.md and list the choice in your report.

Hard constraints (unchanged, see CLAUDE.md): file:// only, no fetch, no
modules, no CDNs; every new JS file in `index.html`'s script list; two builds
from one source; golden Pile 1 = 278.4 yd³ fill / −48.1 net ±10; `test/e2e.mjs`
and `test/split3d.mjs` pass on folder and dist; browser harnesses run ONE at a
time; every failure the user can cause raises a toast; the password gate is
never weakened (harnesses unlock through `test/gate.mjs`).

Order of work and why: R and K and D run in parallel (disjoint files; only R
and D need the browser, and R has it first). F starts after R and D have
landed, because it rewrites the layout those two touch.

---------------------------------------------------------------------------

## 1. Redo (Agent R)

### 1.1 The contract

`js/state.js`:

```
SBMM.undo.push(desc, undoFn, redoFn)   // BOTH closures are required
SBMM.undo.pop()                        // runs undoFn, moves the entry to the redo stack
SBMM.undo.redo()                       // runs redoFn, moves the entry back
SBMM.undo.canUndo() / canRedo() / labels() -> { undo: desc|null, redo: desc|null }
SBMM.undo.onChange(fn)                 // fired after every push / pop / redo / clear
```

- A `push` clears the redo stack (a new action after an undo forks history;
  the abandoned branch is gone, which is what every editor does).
- A `push` without a `redoFn` throws in the console and is treated as a bug:
  every one of the 21 existing call sites (`js/design.js` 2, `js/draw.js` 4,
  `js/pick3d.js` 1, `js/sections.js` 1, `js/smartbound.js` 3, `js/tools.js`
  6, `js/water.js` 4) gets a real redo closure.
- Stack depth 100 each way. Entries are `{ desc, undo, redo }`.
- `pop()` and `redo()` toast `undid: …` / `redid: …`; both are no-ops with a
  toast when empty.

### 1.2 Re-adding a removed feature

Most undo entries are "remove this feature"; their redo is "put it back", and
undo of a delete is the same operation. Add `SBMM.store.readd(f)`: re-inserts
the SAME feature object with the SAME id (so selection, provenance and any
card reference survive), rebuilds its Leaflet layer through the type's
builder (`SBMM.tools` `layerFor` / `buildFlow` for `flow` / the design and
sections builders — reuse what `rebuildFeature` uses, without recomputing),
restores its card if it had one (or rebuilds it from `props` for the types
that carry a card), emits, autosaves. `remove()` already keeps the object;
make sure it does not null anything `readd` needs.

Per-site rule of thumb:

| action | undo | redo |
|---|---|---|
| create a feature (draw, wand, raindrop, pad, sections, sheet mark, drop spot) | `store.remove(f)` | `store.readd(f)` |
| delete a feature | `store.readd(f)` | `store.remove(f)` |
| edit vertices (drag, insert, delete a vertex, 3D handle) | restore `ptsBefore`, `redraw + recompute` | restore `ptsAfter`, same |
| move / copy / rotate / mirror / offset / join / explode | the inverse geometry, or remove the created copy | the forward geometry, or readd |
| retrace a raindrop (drag the drop) | restore previous `pts/props`, rebuild | restore the new ones |
| pad / surface parameter change | restore previous props, regenerate | restore new props, regenerate |

Capture the "after" state at the moment the action completes (not lazily at
undo time), so redo cannot pick up a later edit.

### 1.3 Chrome

- `#redoBtn` enabled/disabled from `canRedo()`, `#undoBtn` from `canUndo()`,
  via `SBMM.undo.onChange`; titles carry the entry's description ("Redo:
  retrace Raindrop 3"). Tooltip wording per CLAUDE.md conventions.
- Keys: `Ctrl+Y` and `Ctrl+Shift+Z` redo (where `Ctrl+Z` is handled in
  `js/draw.js`, same guard rules: not while typing, not inside the gate).
- Command `REDO` (aliases `RE`, `Y`) in `js/cmdline.js`; check the alias
  table for collisions (the e2e fails on one).
- Help text: the Undo/Redo line in `index.html`; `README` one sentence;
  `HANDOFF` open item 3 closed; `RELEASE_NOTES` v9.4 line; CLAUDE.md
  (state.js row, and a short "undo/redo" note: the both-closures rule and
  `readd`).

### 1.4 Acceptance (e2e block "9u. redo")

Cycles asserted with the store's feature count, ids and vertex arrays, and
the two buttons' `disabled` state after every step:

1. draw a line → undo → redo (same id, same pts, on the map, card back) → undo.
2. drag a vertex (`SBMM.draw` or a direct `pts` edit through the same path the
   handle uses) → undo restores the old vertex → redo restores the new one.
3. delete a feature → undo brings it back with the same id → redo deletes it.
4. a raindrop → undo removes it (and its animated pane copy) → redo brings
   it back drawn.
5. a graded pad → undo → redo → the design surface regenerates.
6. after undo, a NEW action clears the redo stack (button disabled, `redo()`
   toasts).
7. `Ctrl+Y` redoes; `REDO` command exists; alias collisions still 0.
8. No page errors.

---------------------------------------------------------------------------

## 2. The kernel harness (Agent K)

### 2.1 Why

`test/water_kernels.mjs` proved the shape: node, no browser, seconds, every
golden number beside its reference. Extend it to EVERY kernel in
`js/compute.js`, and make it self-contained — today it reads fixtures out of
the planner's scratchpad, which no other machine has.

### 2.2 What to build (all under `test/`, no new npm dependencies)

- `test/lib/png.mjs`: a PNG decoder for what this repo ships — 8-bit RGB and
  RGBA, non-interlaced — using `node:zlib` `inflateSync` and the five PNG
  filters. Return `{ w, h, channels, data: Uint8Array }`.
- `test/lib/terrain.mjs`: `loadDem(name)` reads `data/<name>.json` +
  `data/<name>.png` and returns `{ m, z }` in EXACTLY `js/dem.js`'s layout
  (terrain-RGB `v = R*256+G`, `z = zmin + (v−1)*step`, `v = 0` → NaN, PNG row
  0 = north, internal array south-up); `gridSpec(dem, bbox, pad)` ported
  verbatim from `js/jobs.js` (also `gridsFor`); `loadSurface(id)` reads the
  design-surface raster out of `datajs/d_cad_surfaces.js` (regex the base64
  data-URL for that surface's payload key from `data/design/surfaces.json`)
  and decodes it the same way. Cache decoded grids on disk under
  `test/.cache/` (gitignored) keyed by the PNG's size and mtime, so a run is
  seconds after the first.
- `test/kernels.mjs`: loads `js/compute.js` through `vm.runInThisContext`
  (as the water harness does), builds each job exactly as the app builds it
  (read the call sites: `js/tools.js` volume, `js/isopach.js`,
  `js/analysis.js` raster/contours, `js/design.js` design/balance,
  `js/sections.js`, `js/smartbound.js` wand/cbound/toecrest/stands,
  `js/trees.js`), runs it, and prints every check as `PASS/FAIL name got ref
  tolerance`, non-zero exit on any FAIL, per-kernel wall time. Fold the water
  checks in (move `test/water_kernels.mjs`'s body into it as a section, keep
  that file as a thin alias that runs the water section only), reading the
  water references from `test/fixtures/drop_ref.json` /
  `herman_ref.json` (now in the repo) and cutting the windows from the real
  PNGs with `gridSpec` (the swale window is `drop ± 700 ft` on `dem_abp`
  with pad 0; the Herman window is the water polygon's bbox ± 800 ft on
  `dem_site`, pad 0 — reproduce `test/water_kernels.mjs`'s fixture shapes
  exactly and assert the same numbers).

### 2.3 The goldens (from the shipped e2e; tolerances are the e2e's)

| kernel | case | reference |
|---|---|---|
| `volume` | Pile 1 (Fig 2) ring from `data/piles.json`, perimeter-TIN base, the app's job | fill 278.4 yd³ / net −48.1, ±10 (the golden) |
| `isopach` | `res_excbottom` vs the DEM stack (`gridsFor`) | cut 7,556.1 yd³ ±0.5 %, fill ≤ 0.5, changed area 203,975 ft² ±0.5 %, deepest fill ≤ 0.7 |
| `raster` slope/aspect | a synthetic 200×200 plane at 10 % grade facing 135° | slope 10.0 % ±0.05 everywhere inside the border, aspect 135° ±0.5 |
| `raster` hypso | a real window | min/max equal the window's z min/max ±step |
| `contours` | a synthetic cone (apex 100 ft, radius 400 ft, 1-ft cells) at 10-ft intervals | each ring's length = 2πr within 1 %; ring count 9 |
| `contours` | the real 2-ft site window over the mine area at 10 ft | polyline count within ±5 % of what the app builds (record it) |
| `wand` | Pile 3 as the e2e does it | 0.2248 ac ±2 %, 51 vertices ±5, closed |
| `toecrest`, `cbound`, `stands` | the e2e's own cases | stands: 7 stands, 3.81 ac, tallest 72.3 ft (±1 stand, ±2 %) |
| `trees` | the e2e's 800×800 window | 548 trees ±2 %, median height 27.9 ±0.2, max 72.3 ±0.1 |
| `design` + `balance` | a 200-ft square pad over a real window; balance solves the level where cut = fill | balanced net within 1 % of the larger of cut/fill; the pad regenerated at that level reports the same |
| `sections` | a 300-ft line across a real window | sampled z equals the harness's own bilinear `Dem.at` port within 0.02 ft at every station |
| `flowpath` / `overtop` / `catchment` | the 59 water checks | unchanged |

Where a reference above is not yet pinned (the contour count, the pad case),
run once, record the number in the harness with a comment saying it was
recorded from this commit, and assert it thereafter — that is a regression
guard, and it is labelled as one.

### 2.4 Acceptance

- `node test/kernels.mjs` passes on this machine in under 90 s cold and under
  30 s warm; `node test/water_kernels.mjs` still passes.
- `test/package.json` scripts: `kernels`, `water`.
- CLAUDE.md test section: the harness, the decoder, the cache; the fixtures
  directory; the rule that a new kernel gets a section here before it ships.

---------------------------------------------------------------------------

## 3. Worker-side terrain decode (Agent D)

### 3.1 The problem, precisely

`Dem.load` (`js/dem.js`) does `atob → Blob → createImageBitmap` (already
off-thread) and then `drawImage + getImageData` (86 MB copy for the site DEM)
and the terrain-RGB → Float32 loop ON THE MAIN THREAD, for four payloads
(`dem_site`, `dem_abp`, `dem_res`, `chm`) one after another. That is the
"building workbench" wait. `test/boot_time.mjs` prints the stage table.

### 3.2 The design

- A dedicated decode worker, built the way `js/jobs.js` builds the compute
  worker: the worker's source is `Function.prototype.toString()` of a
  self-contained function in `js/dem.js` (no `SBMM`, no DOM), turned into a
  Blob URL. It is NOT the compute pool and does not touch `js/compute.js` or
  the job protocol.
- Main thread per payload: `atob` the base64 into a `Uint8Array` (the only
  main-thread cost, ~40 ms for 14 MB), `postMessage` it with
  **transfer**, plus `{ w, h, zmin, step }`.
- Worker: `createImageBitmap(new Blob([bytes], {type:"image/png"}))`,
  `OffscreenCanvas(w, h)` 2D context with `willReadFrequently`, `drawImage`,
  `getImageData`, the terrain-RGB loop producing the south-up `Float32Array`
  EXACTLY as `Dem.load` does now (move the loop, do not rewrite it), then
  `postMessage({ z }, [z.buffer])`. Also return `nodata` count if the app
  reads it.
- Parallelism: one worker per payload, all four started together
  (`Promise.all`), so the decodes overlap on a multi-core box; the loader text
  still names the step ("decoding terrain · 3 of 4").
- Fallback: if `Worker`, `OffscreenCanvas` or `createImageBitmap` is missing
  in the worker (feature-detect inside the worker and reply `{ unsupported:
  true }`), fall back to the existing main-thread path unchanged. Both paths
  must produce identical `z` arrays (assert in the e2e by decoding one small
  payload both ways and comparing).
- Keep: `SBMM_DATA[name + "_png"] = null` once decoded; the `SBMM.chmReady`
  contract; the DEM stack order; `Dem.pixels()` for anything else that calls
  it.
- Record `SBMM.perf.demWorkers = n` (how many payloads decoded in workers)
  and per-payload marks so `test/perf.mjs` / `boot_time.mjs` show them.

### 3.3 Acceptance

- `node test/boot_time.mjs /home/user/SBM/index.html 3` before and after (run
  the "before" first, on the untouched tree, and keep both tables in the
  report). Target: boot-done median improves by ≥ 0.8 s on this box; the
  loader never shows a blank stage.
- e2e: `SBMM.perf.demWorkers === 4` in the folder build (assert ≥ 3 so the
  optional `dem_res` cannot fail it); the decoded-both-ways comparison; every
  existing terrain/golden assertion untouched and green; dist build green.
- CLAUDE.md "Boot cost" section rewritten to describe the worker decode and
  to retire the "prerequisite" note; HANDOFF open item 4 closed.

---------------------------------------------------------------------------

## 4. Field mode and the field build (Agent F — after R and D)

### 4.1 What the user asked for

> a field mode when using the phone browser, so it knows when a mobile
> browser is being used and adjusts the whole UI to be SOTA … when it comes
> to being used on the browser.

Planner's ruling: two things, not one. A **field build** small enough to open
on a phone, and a **field mode** UI that switches on by itself on a touch
device and can be turned on anywhere.

### 4.2 The field build

- `python tools/build_dist.py --field` → `dist/SBMM_Site_Explorer_field.html`.
  Same source, same inlining, one exclusion list: the 20 `i_sheet_full_*`
  renders (27 MB), `i_chm_png` + `d_chm` (7 MB), `d_cad_surfaces` (11 MB),
  `d_cad_native` (22 MB). Everything else stays: the three DEMs, all
  imagery, the design-sheet overlays (`i_design_*`), the native design GIS,
  the datasets, the survey, the cultural payload (still gated). Target
  ≤ 65 MB; report the size.
- The build stamps `SBMM_DATA.build = "field"` (the full build stamps
  `"full"`) so the app can say what it is.
- **Every module tolerates its payload being absent** with a row or a note
  that says "not in the field build", never an error: the sheet viewer and
  Sheets tab (no renders → cards without thumbnails, "open" disabled with a
  toast), canopy rows and STANDS/TREES (no CHM → rows absent, commands
  toast), the design surfaces / isopach (no `cad_surfaces` → the surfaces
  list says so), the CAD groups and Layer manager (no `cad_native` → groups
  absent, `LAYERS` toasts). Grep for every reader of those four payloads.
- Tests: `test/e2e_field.mjs` runs the FULL e2e's boot, gate, terrain, golden
  volume, water and survey sections against the field build (factor the e2e
  into sections that can be skipped by build; do not fork the file), plus
  the field-mode assertions of §4.4. Both dists are built and tested in the
  delivery procedure (HANDOFF).

### 4.3 Field mode — the UI

Trigger: `matchMedia("(pointer: coarse)")` AND viewport width ≤ 900 px at
boot, or the `FIELD` command / a "Field mode" switch in the help panel and the
overflow menu, persisted in localStorage. `body.field` is the one switch
every style and behaviour keys off; `SBMM.field.on()` reports it; the
`SBMM.events` bus emits `field`.

Layout in field mode (design tokens stay the app's; 8-px grid; 44-px minimum
hit targets; 16-px base font in controls so iOS does not zoom the page):

- **Top**: a slim bar with the app mark, the current mode name, and a search
  button that opens the command bar full-width.
- **Stage**: the map fills the screen. Attribution/watermark stay. The 3D
  view opens at **standard** detail and the 3D toolbar collapses to style +
  frame + back; the orbit rig must work with touch (one-finger orbit,
  two-finger pan/pinch — verify `js/viewer3d.js`'s nav rig uses pointer
  events; add touch handling if it does not).
- **Bottom action bar**, six big buttons with labels: **Position**,
  **Inspect**, **Raindrop**, **Photo**, **Note**, **Layers**, and a **More**
  sheet with Distance, Area, Samples, Sheets, 3D, Lock, Field mode off.
- **Docks become sheets**: Layers / My work / Sheets and Inspector / Results
  slide up from the bottom to 60 % height, drag to dismiss, one at a time.
- **Popups become bottom cards** (full width, big text, the same HTML from
  `js/popups.js`); actions are full-width buttons.
- The Mode HUD moves above the action bar; the status bar shows E N Z only;
  the command line is reachable from the search button.
- Toasts bottom-centre above the bar, larger.
- Desktop mode is untouched when `body.field` is absent — the existing e2e
  is the proof.

### 4.4 Field capabilities

- **Position** (`SBMM.field.locate()`): `navigator.geolocation.watchPosition`
  where the browser allows it (feature-detect; on refusal or absence toast
  "position is not available in this browser — file:// pages need Chrome
  with location permission"). WGS84 → State Plane via `SBMM.fromLL` (the
  ±1 ft affine — say so in the marker's popup). A pulsing position marker
  with an accuracy circle in feet, a heading arrow when the device gives
  one, and a **follow** toggle that keeps the map centred. Never fabricate
  a position; the marker exists only while a fix exists.
- **Photo** (`SBMM.field.photo()`): `<input type="file" accept="image/*"
  capture="environment">`; downscale to ≤ 1600 px on the long edge, JPEG
  0.82, as a data URL; read EXIF (orientation, DateTimeOriginal, GPS
  lat/long) from the JPEG's APP1 with a small parser in `js/field.js`; place
  the photo at the EXIF position if present, else at the device position,
  else ask the user to tap the map. A new feature type **`photo`**: point
  geometry, `props: { img, thumb (≤160 px), taken, note, source:
  "exif"|"device"|"tap", accuracy_ft }`, `group: "Field"`, drawn as a small
  framed thumbnail marker, popup shows the image full-width with the note,
  time and how it was placed; in 3D a billboard sprite of the thumb; My work
  gets a **Field** class row; sessions carry it (a session with photos is
  big — that is accepted; the export dialog says so); GeoJSON exports the
  point with `taken`, `note`, `source` and, behind a checkbox, the image.
- **Note** (`SBMM.field.note()`): the existing `text` feature through a
  big-button flow: tap the map (or use the device position), type, done.
- **Samples nearby**: the Samples table filtered to the 20 nearest the
  device position, one tap each to fly there.
- **Raindrop / Inspect** are the existing modes with the field chrome.

### 4.5 Acceptance

- `test/e2e_field.mjs` on the field build at Playwright's `Pixel 7` device
  descriptor (touch, 412 × 915, DPR 2.6): boot ≤ the full build's on this
  box + 1 s; the gate works with touch; `body.field` is on by itself; the six
  buttons exist with ≥ 44-px targets; the Layers sheet opens and closes by
  tap; a raindrop by tap creates a `flow` feature; Position without a
  geolocation grant toasts and creates nothing; with Playwright's
  `context.setGeolocation` + permission granted, the marker appears within
  the accuracy circle; a photo via `setInputFiles` with a JPEG fixture that
  carries EXIF GPS (generate the fixture with a short Python script under
  `tools/`, committed as `test/fixtures/photo_exif.jpg`) lands at the EXIF
  position ±2 ft, has a thumb, survives a session round-trip, and exports;
  the 3D view opens and a touch drag orbits; the full desktop e2e still
  passes unchanged.
- Shots: `test/field_shots.mjs` → `field_map.png`, `field_layers.png`,
  `field_photo.png`, `field_3d.png`. Look at them.
- Docs: CLAUDE.md (field.js row; the two-build rule; the payload-tolerance
  rule), README (a "In the field" section), HANDOFF (delivery procedure now
  builds and tests both dists; decision rows), release notes.

---------------------------------------------------------------------------

## 5. Out of scope

Hydraulics (unchanged). A server or sync of any kind. Push notifications.
Native app wrappers. A different map framework.
