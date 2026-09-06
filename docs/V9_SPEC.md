# SBMM Site Explorer — v9 design specification (authoritative)

Owner/decider: the planner. Executors: agents A, B, C. This document is the
contract: agents implement what is written here and do not re-decide it. Where
something is not specified, choose the simplest option consistent with CLAUDE.md
and note it in your final report.

Hard constraints (unchanged, see CLAUDE.md): file:// only (no fetch), payloads as
`datajs/*.js` setting `SBMM_DATA[...]`, plain script-tag JS, two builds (folder +
`dist/SBMM_Site_Explorer.html`), golden Pile 1 = 278.4 yd³ fill / −48.1 net ±10,
tests `test/e2e.mjs` and `test/split3d.mjs` pass on folder AND dist.

---------------------------------------------------------------------------

## 1. Product principle

This is the **daily digital twin** for the residential remedy and Phase 1
construction lead. Everything in it is organised by *what the user is doing*
(navigating, inspecting, measuring, designing, reviewing drawings), not by which
file the data came from. One truth for layer state: **a layer that is on is on in
2D, 3D, the sheet viewer and exports.** There are no separate 3D checkboxes.

## 2. Tool-mode state machine (owner: Agent C, hooks by B)

Exactly one mode is active at a time; `SBMM.mode` holds it and fires
`SBMM.events.emit('mode', {from, to})`.

| mode | 2D behaviour | 3D behaviour | cursor | exit |
|---|---|---|---|---|
| `navigate` (default) | drag pan, wheel zoom, **click = identify** (popup on features/wells/borings/CAD/cultural; on empty terrain: coordinate card), hover tooltips | left-drag orbit, right/middle-drag pan, wheel zoom to cursor, dbl-click sets orbit target, **click = pick** (same popups), hover highlight | grab / grabbing | — |
| `inspect` (I) | click anywhere → point card: E, N, Z, lat/long, slope %, aspect, nearest features, copy button, "drop marker" | same, via terrain raycast | crosshair | Esc → navigate |
| `measure.distance` (M) | polyline, live segment + total labels | same on terrain | crosshair | Enter/dbl-click finish, Esc cancel → navigate |
| `measure.area` (A) | polygon, live area/perimeter | same | crosshair | as above |
| `volume` (V) | polygon → perimeter-TIN volume (existing engine) | same | crosshair | as above |
| `draw.point` (P) / `draw.line` (L) / `draw.polygon` (G) | feature creation into the shared store | same, vertices on terrain | crosshair | as above |
| `section` (S) | section line | same | crosshair | as above |
| `edit` | auto-entered when a vertex handle is grabbed; drag moves vertex; Delete removes vertex/feature | same with 3D handles | move | mouse-up returns to previous mode |
| `dimension` (N), `text` (X), `smartbound` (B), `pad` (D) | existing behaviours | — | crosshair | Esc |

Rules: **Esc always** cancels the in-progress sketch AND returns to `navigate` AND
clears the tool button highlight (no dead-button state). Space held = temporary
`navigate` pan in any mode. The **Mode HUD** (bottom-centre pill) shows the mode
name, the next expected input ("click first point", "Enter to finish"), and the
Esc hint; it updates on every step. Status bar (bottom-left) shows E N Z, lat/long,
scale, snap state at all times in both views.

## 3. Layout (owner: Agent C)

- **Top bar**: app title; primary tools as icon buttons with labels
  (Navigate · Inspect · Distance · Area · Volume · Section · Draw ▾ · Design ▾ ·
  Sheets · 3D/Split); right side: Go-to, Import, Export ▾, Undo/Redo, Help.
  Overflow into a "more" menu below 1200 px width.
- **Left dock** (tabs): **Layers**, **My work** (features tree), **Sheets** (20
  sheet cards with thumbnails, filter by lot).
- **Right dock** (tabs): **Inspector** (selected object properties/edit; replaces
  the left "props" pane) and **Results** (measurement/volume cards, CSV copy).
  Selecting anything switches to Inspector; running a computation switches to
  Results.
- **Stage**: 2D map, 3D view, or split (existing). The 3D toolbar keeps ONLY:
  style, vertical exaggeration, detail, snapshot, split/fly/frame/back. The
  DUs/piles/drawings/design/sheets/samples/datasets/contours/canopy checkboxes
  are removed — visibility comes from the Layers tree.
- **Bottom**: status bar left, Mode HUD centre, watermark bottom-right.
- **Command line** stays (toggle with `/`).
- Dark theme retained; consistent 8-px spacing; every icon has a label or tooltip.

## 4. Layers tree — digital-twin organisation and defaults (owner: Agent C)

Groups (in this order), each with master checkbox, opacity slider (where
applicable) and count. ● = ON by default, ○ = OFF by default.

1. **Base** — ● Orthoimagery (site + mine composite), ● Hillshade blend,
   ● Contours (lidar, major 5 ft; minor auto-hide by zoom), ○ Canopy (CHM),
   ○ Slope, ○ Aspect.
2. **Site framework** — ● OU / site boundary, ● Decision units, ○ Parcels,
   ○ Buildings, ○ Roads & paving, ○ Fences, ○ Utilities, ○ Drainage,
   ○ Trees (CAD), ○ Block symbols (survey points etc.).
3. **Residential remedy design (EA Final, 2025)** — ● Limits of excavation
   (styled by `depth_ft`: 1.0 ft solid red, 0.5 ft dashed orange; depth label at
   centroid), ● Daylight/transition, ● Grading breaklines, ● Repository,
   ● Haul/access, ○ Staging/stockpile, ○ ESC/BMPs, ○ Alignments,
   ● Annotation (excavation notes, callouts), ○ CAD contours (EA),
   ○ Sheets draped (per sheet), **Design surfaces** (see §5; ○ by default,
   listed individually with "use as design" action).
4. **Investigations** — ● Monitoring wells (95), ● Borings (44), ○ Sample
   results (symbolised by analyte), ○ Imported datasets (per dataset).
5. **Cultural resources — CONFIDENTIAL** — ○ Archaeological isolates, ○ Survey
   polygons (and any other GDB cultural layers). See §7.
6. **My work** — ● Drawings, ● Measurements, ● Sections, ● Design pads,
   ● Imported (GeoJSON/DXF/CSV).

Layer state is one object `SBMM.layerState[groupId][layerId] = {on, opacity}`;
2D (Leaflet), 3D (viewer3d) and sheets subscribe to `SBMM.events 'layers'`.

## 5. Design surfaces (owner: Agent A → C)

Finding (Agent A): EA's residential design is **depth-based**: "excavate work
area to one foot depth unless otherwise indicated", 6-in overrides near
structures/driplines, "provide 12 in of fill in unhatched areas inside the limits
of excavation and/or fill", "transition to existing grade at limits of fill". EA's
proposed-grade TINs, where they exist (repository 02.01, north lobe 02.02), live in
the libredwg-undecoded region of the DWGs; the storage format is now known
(stride-4 float64 records x,y,z,id64 at a per-object bit offset).

Surfaces to deliver, each as a terrain-RGB PNG raster at 1 ft over its footprint
bbox (same encoder/convention as `dem_abp`) + footprint polygon + metadata, in the
manifest `data/design/surfaces.json` (schema below):

| id | label | kind | method |
|---|---|---|---|
| `eg_ea` | EA existing ground (Civil 3D TIN) | existing | recovered from AECC_TIN_SURFACE records; validated vs lidar (mean 0.00, sd 0.16 ft) |
| `borrow_eg` | Borrow area existing ground (.mms) | existing | recovered from .mms store |
| `res_excbottom` | Residential excavation bottom | derived | lidar EG − `depth_ft` inside each excavation polygon (1.0 default, 0.5 overrides), EG elsewhere |
| `res_finish` | Residential finished grade | derived | = lidar EG (backfill to grade / 12-in fill in unhatched areas per notes) — document that this equals existing |
| `repo_fg`, `nlobe_fg` | Repository / North lobe final grade | proposed (if recovered) else derived | scan undecoded DWG blob for stride-4 records; classify proposed vs existing by residual vs lidar inside footprint; fallback: constrained Delaunay from 3D grading breaklines + daylight lines, clearly labelled `derived` |

`surfaces.json` schema:
```
{ "surfaces": [ { "id", "label", "kind": "existing|proposed|derived",
   "method", "source_files": [], "confidence": "high|medium|low",
   "raster": { "payload": "SBMM_DATA key", "x0","y0","w","h","step","zmin","zstep" },
   "footprint": [[x,y],...], "stats": { "n_pts", "mean_dz_vs_lidar", "sd_dz", "pct_within_0p5" },
   "volumes_vs_lidar_yd3": { "cut", "fill", "net" }, "notes": "" } ] }
```

App integration (C): reference surfaces are read-only surface features
(`type:'surface'`, `props.ref:true`) so `SBMM.design.elev()`, "volume vs
design", sections and 3D display all work unchanged. Add **Isopach** overlay:
cut/fill heat map (blue fill / red cut, legend in ft) of any design surface vs
lidar, in 2D and draped in 3D; and **"Volume in polygon vs surface"** action for
any polygon. Excavation polygons get an Inspector action "volume of this
excavation" (area × depth and raster method side by side).

## 6. Native CAD (owner: Agent A, done in v9 round 1; C wires the UI)

`js/cadnative.js` → `SBMM.CadNative` with 22,158 features / 110 layers / 21
groups, `data/design/cad_layer_map.json` maps CAD layer → UI group/label/style/
default. C renders these groups inside §4 groups 2 and 3 (not as a separate
"CAD" group), with a **Layer manager** dialog (search CAD layer names, toggle,
recolour, show source file/handle) reachable from the Residential design group
header. Lazy-parse heavy groups on first enable (already implemented).

## 7. Cultural resources (owner: Agent B)

Included by explicit user decision. Protected information (NHPA §304 / ARPA §9).
- Group off by default; first enable per session shows an acknowledgement dialog
  ("project team only; do not include in public documents") with "I understand".
- While any cultural layer is visible: red stamp "CONFIDENTIAL – CULTURAL
  RESOURCES (NHPA §304)" on map, 3D, snapshots and report figures.
- Exports containing cultural features require the same acknowledgement and add
  the stamp text to the file metadata/properties.
- e2e: assert group exists, is off, no cultural geometry before acknowledgement,
  visible after.

## 8. 3D picking and parity (owner: Agent B)

Registry API (B implements, A/C register):
```
SBMM.pick3d.register({ id, object3d, kind, priority, // points 3 > lines 2 > polys 1 > terrain 0
   hit(intersect) -> { title, html, featureId?, xyz } })
SBMM.pick3d.unregister(id)
```
Raycaster with Line/Points thresholds scaled by camera distance; hover highlight
+ tooltip; click (≤4 px, ≤200 ms) opens the same popup HTML as 2D in a floating
card anchored to the projected point; Esc/click-away closes. Terrain fallback:
coordinate card. Editing parity: place point / draw line & polygon / move vertex /
delete in 3D writes to `SBMM.store`, so 2D updates live and vice versa.

## 9. Sheet viewer measuring and marking (owner: Agent B)

Sheet windows get a toolbar: Inspect, Distance, Area, Point, Line, Polygon, Note,
plus "locate on map / in 3D". Sheet px ↔ State Plane via the sheet affine in
`data/sheets_full.json`; unregistered sheets show "not georeferenced" and only
allow non-geo notes. Marks become store features with
`props.provenance = {source:'sheet', sheet:'C-107', px:[[u,v],...]}`, appear in
2D/3D immediately, editable there; the sheet window draws store features inside
its extent through the inverse affine (third synchronised view).

## 10. Watermark (owner: Agent B)

"Mo Sharif - Jacobs 2026", bottom-right, 11 px, 55 % opacity, pointer-events
none, above map/3D, below dialogs/toasts; burned into every exported image (3D
snapshot, report figures, any canvas export). e2e asserts element + pixels.

## 11. Definition of done (Agent D / final)

- Both tests pass on folder and dist; golden number holds.
- Boot to first interaction ≤ 3.5 s on the test machine; no jank on hover.
- Visual audit shots: 2D default view, 3D default view, split, sheet window with
  marks, cultural acknowledgement, layer manager, isopach — saved to `test/shots/`.
- CLAUDE.md updated (mode machine, layer state, surfaces schema, pick3d API,
  cultural handling, CAD layer map); README refreshed; `docs/V9_SPEC.md` kept.
- Delivered to `C:\Users\nawaz\WORK\SBMM\Site Explorer WebApp\` (dist + repo
  folder) with sha256 verification.

---------------------------------------------------------------------------

## v9 status (Agent C, final)

### Done

**§1 Product principle.** One layer state: `SBMM.layerState[group][layer] = {on,
opacity}` in `js/layerstate.js`, with `SBMM.events` ('layers', 'mode'). Every
Leaflet row, the 3D viewer, the sheet drapes and the exports read it. The 3D
toolbar has no visibility checkboxes left; the e2e asserts that (`v3dCheckboxes
=== 0` and none of the nine old ids resolve).

**§2 Mode machine.** `js/mode.js`. Fourteen modes, the §2 cursor per mode on
`#stage[data-cursor]`, the Mode HUD bottom-centre naming the mode and the next
expected input, and the shortcuts as listed (I, M, A, V, P, L, G, S, N, X, B, D,
F fly, `/` command line, Space = temporary Navigate that keeps the sketch).
**Esc always returns to Navigate** — this is a behaviour change: before v9 an Esc
mid-sketch re-armed the same tool. Every `SBMM.tools.setTool` call still works and
reports to the mode machine through `syncFromTool`, so the command line, the
top-bar buttons and the keyboard land in identical states. Status bar shows E, N,
Z, lat/long, plan scale and snap state in both views (`SBMM.status.at` is called
by the 2D map and by the 3D hover alike).

**§3 Layout.** Top bar: mode buttons with labels, Draw ▾ and Design ▾ menus,
Sheets / 3D / Split, then Go-to, Samples, Import, Export ▾, Undo, Redo, Clear,
Help. Four-stage narrowing (shortcut chips → ghost labels → all labels →
overflow menu) so the primary tools stay labelled to well below 1200 px. Left
dock: Layers / My work / Sheets. Right dock: Inspector (absorbs the old left
"props" pane) / Results, with the §3 auto-switch. Dark theme kept; dead CSS
removed (`.dtitle`).

**§4 Layer tree.** The six groups in the spec's order, each with a master
checkbox (tri-state), a count and per-row opacity where it applies. Limits of
excavation are styled by `depth_ft` (1.0 ft solid red, 0.5 ft dashed orange, the
depth labelled at the centroid and hidden when zoomed out so fifteen identical
boxes do not pile up). The four unapplied 0.5-ft call-outs are orange markers
with the sheet, the note text and "region not delineated by EA — verify".
Persisted in localStorage and in the session file (v7), except the cultural group.

**§5 Design surfaces.** `js/refsurf.js` wraps the four recovered surfaces as
read-only `type:'surface'` features (`props.ref`), locked, not serialised,
re-created on boot, listed under Residential design → Design surfaces with kind
and confidence badges; `repo_fg` / `nlobe_fg` are listed greyed with their
remedy. `SBMM.design.elev()` and `gridSpecFor()` take a raster-backed path for
them, so the volume engine, cross-sections and the 3D drape work unchanged.
**Isopach** (`js/isopach.js` + an `isopach` kernel in `js/compute.js`): cut/fill
vs the lidar ground, blue fill / red cut, legend in feet, 2D canvas overlay and
3D drape. **Volume in polygon vs surface** for any polygon, and **volume of this
excavation** on an excavation polygon showing area × depth and the raster method
side by side.

**§6 Native CAD.** The 21 CAD groups are distributed into §4 groups 2 and 3 per
`cad_layer_map.json`; there is no separate "CAD" group. Layer manager
(`js/layerman.js`) from the design group header: search CAD layer / group /
source file, toggle, recolour, opacity, per-layer info (source file, feature
count, entity kinds, a real DWG handle), and "reset to defaults".

**§7 / §8 / §9 / §10** (Agent B) carried through the restructure unchanged; the
cultural group is now its own top-level §4 group with the acknowledgement, stamp
and export gate intact, and marked `persist:false` so a remembered checkbox can
never put protected geometry on the map before anyone is asked.

**Planner rulings.** R1 (geodatabase `exc` is the authority; CAD `exc` default
OFF in `js/cadnative.js` `DEFAULT_OVERRIDES`, in `tools/build_cad_native.py`
`LAYER_RULES` and in `cad_layer_map.json`; the strict C-106 e2e assertion
restored), R2, R3, R4, R5 (`SBMM.store.offChange`; `cadnative.popup` delegates to
`SBMM.popups.forCad`; the 3D CAD drape is on-demand per group against a
3,000-line budget with a toast; `tools/build_data.py` documents which payloads it
does not own), R6, R7, R8 all implemented.

### Deviations, and why

1. **The 0.5-ft call-out markers are at the sheet's excavation-polygon centroid,
   not at the leader tips.** The four call-outs survive only as PAPER-SPACE text
   (sheet + wording). Model space carries no 0.5-ft entity anywhere in the
   delivered CAD — every feature with a `depth_ft` is 1.0, and a text search for
   the call-out wording over model space returns nothing. There is no leader tip
   in any file we have, so the marker is anchored to the centroid of that sheet's
   own limit of excavation, offset clear of the depth label, and says so in its
   popup. `addHalfFootCallouts()` in `js/designgis.js` is the one function to
   change if EA ever sends the leaders as geometry.
2. **`draw.line` / `draw.polygon` share the sketch engine with
   `measure.distance` / `measure.area`.** They produce the same feature types
   (a line has a length, a polygon has an area), so a second engine would be two
   definitions of one thing. They are separate MODES — separate buttons, HUD
   text and highlight — over one implementation.
3. **Redo is a disabled button with a tooltip.** `SBMM.undo` is an undo stack of
   inverse closures; there are no redo closures to run, and inventing them was
   out of scope. The button is present and says why rather than being absent.
4. **Go-to lost its `G` shortcut** — §2 gives `G` to `draw.polygon`. The button
   and the `Go to` command line entry are unchanged.
5. **Waste piles sit in Site framework** (§4 group 2), which does not name them.
   They are site fabric like the decision units, and the alternative was a
   seventh group for one row.
6. **`res_excbottom` cut integrates to 7,632.9 yd³ against the manifest's
   7,561.9 (+0.94 %).** Not a defect: `tools/build_cad_surfaces.py` integrated
   against the raw lidar master, and the app integrates against the SHIPPED DEM,
   which is 1 ft only inside the mine-area window and 2 ft outside it, with both
   surfaces terrain-RGB quantised. The e2e asserts 1 %.
7. **The isopach draws at a display budget but integrates at the surface's own
   cell.** A 13-megapixel overlay is a 50 MB data-URL nobody can read; a
   decimated integral costs ~1 % on the number someone digs from. Both cell
   sizes are reported on the card.

### Open items

- **`repo_fg` / `nlobe_fg` remain unrecovered.** Ask EA for a LandXML export or
  a proposed-grade raster. Everything downstream is ready for them: drop the
  rasters in, add them to `surfaces.json`, and they appear as surfaces, volume
  bases, sections and isopachs with no code change.
- **The Redo stack** (deviation 3) is a real feature request, not a bug.
- **The 3D CAD drape budget is 3,000 lines.** Switching on the 3,159-feature CAD
  contour group alone exceeds it and toasts. Raising it needs instanced lines
  rather than a bigger number.
- **`test/perf.mjs` still drives the removed 3D checkboxes** in its layer-toggle
  loop; it is a diagnostic, not pass/fail, and its terrain and boot numbers are
  unaffected. Worth pointing at `SBMM.layerState` next time it is run in anger.

## v9 fix round (planner rulings F1–F11, Agent C)

A review of `test/shots/` against this spec produced eleven rulings. All eleven
are implemented; what follows is what each one turned out to be, because in
three cases the cause was not what the symptom looked like.

- **F1 — the green rectangles were not sheet footprints.** They are EA CAD layer
  `G-ANNO-SYMB`: fourteen closed rings, 230×310 to 751×771 ft, drafted in ACI
  green — the **sheet viewport frames**, drawn in model space so the drafter
  could see what each sheet would catch. §4 asks for the `anno` group to be ON
  (it also carries the excavation notes and call-outs), so the group stays on
  and the one layer goes off: `DEFAULT_LAYER_OFF` in `js/cadnative.js`, a
  per-*layer* sibling of the per-*group* `DEFAULT_OVERRIDES`, mirrored in
  `tools/build_cad_native.py` `LAYER_DEFAULT_OFF` and in
  `data/design/cad_layer_map.json` — the same three-places rule R1 established.
  `resetLayerOverrides()` re-seeds it, so "reset to defaults" means the app's
  defaults and not "everything on".
  Separately there is now a real **Sheet footprints (11)** layer
  (`js/designea.js`): the registered plan extents, dashed, labelled with the
  sheet number, click-to-open, **off by default**, shown automatically while the
  Sheets tab is open and highlighted on card hover or focus. That showing is a
  borrowed view, not a state change — the row's own checkbox still owns the
  layer, so leaving the tab puts the map back exactly as it was.
- **F2 — defaults.** `contours_site` (10 ft) ON as the major set; `contours_abp`
  (2 ft) OFF *and* zoom-gated through a new `SBMM.zoomGate(row, layer, minZoom,
  why)`: the row stays the user's, the geometry waits for zoom ≥ −1, and the row
  reads "— zoom in" while it waits. Sample results OFF; opening the Samples
  table switches them on, because a table whose rows do not appear on the map
  when you click them is a trap.
- **F3 — Terrain analysis** is a collapsible sub-section, closed by default,
  with a count of the rows it is hiding. Group open-defaults: base, framework,
  design, invest and mywork open; cultural and terrain-analysis closed. A stored
  choice always wins. (Class name `lgsub`, not `lsub` — `js/designgis.js` had
  already taken that one, which cost one boot hang to find out.)
- **F4 — CAD rows** are in the same face as every other row; a muted `CAD` tag
  after the label says what the monospace used to. The tag is a sibling of
  `.lbl`, not inside it, so a long name cannot eat its own badge. Six groups
  that duplicated a curated layer by name are renamed (`exc`, `du`, `haul`,
  `staging`, `tree`, `contour` → "… — CAD linework"); a row whose name already
  says CAD does not also wear the tag.
- **F5 — the Mode HUD is view-aware.** `MODES.navigate.next3d` carries the orbit
  wording; `SBMM.mode.view()` resolves 2D / 3D / (in split) whichever pane the
  pointer is over, defaulting to 2D. Tracked by a passive `pointerover` that
  repaints only when the answer changes. `js/viewer3d.js` emits a new
  `SBMM.events 'view'` on open, close and split.
- **F6 — the 3D toolbar at any width.** `reflowBar()` narrows in three stages,
  measured against the real right edge: button labels drop to icons; then the
  `.v3dopt` groups (drape, relief, detail) move whole into the existing View
  settings popover and the gear lights up; then, only if still needed, the
  "3D terrain" title and the coordinate/status readouts go — those are a second
  copy of what the status bar under the stage already shows for both views (§2).
  Verified with nothing clipped at 1600 full, 1280 full, 1600 split and 1280
  split; the e2e asserts the first three.
- **F7 — Draw ▾ / Design ▾** take the active mode's name and highlight while a
  mode from that menu is live ("Dimension ▾"), and revert on Esc.
- **F8 — floating sheet windows** are sized, placed and clamped against the
  **stage** box rather than the viewport, so they can no longer sit on the right
  dock and hide the Inspector. Clamped on open, drag, resize, and on any dock or
  window resize via `SBMM.sheets.clampAll()` from `shell.relayout()`.
- **F9 — the isopach's phantom fill.** `res_excbottom` is existing ground minus
  a depth inside the limits and existing ground everywhere else out to a 60 ft
  working buffer, so against the ground it is all cut and no fill *by
  construction*; it was reporting 180 yd³ of fill and a 1.37 ft "deepest fill".
  Measured causes, in order of size:
  1. **Grid resolution, not the design.** The surface is a 1 ft raster built
     from the 1 ft lidar master, but the app only carries 1 ft DEM inside the
     mine window; south and west of it the ground is the 2 ft site grid, which
     is a genuinely different surface on a slope. **Every yd³ of the fill was in
     that region** (0.0 yd³ came from the 1-ft window) and two thirds of it was
     nowhere near a raster edge.
  2. **Quantisation.** Both surfaces are terrain-RGB PNGs on a 0.02 ft step,
     both sampled bilinearly between quantised nodes.
  3. **The nodata boundary.** The 1.37 ft spike was a single cell at the
     raster's south-west corner, where the interpolation has nothing on one side.
  The kernel now (a) confirms it reads the finest DEM covering each cell —
  `gridsFor()` already ships them finest-first, so this was already true and is
  now asserted; (b) treats a difference as zero when it is below what the two
  rasters can express: the two 0.02 ft steps, plus — **only where the ground
  grid is coarser than the design raster** — `2·|∇z|·(cGround − cDesign)`, that
  grid's own interpolation error on the local slope, which is identically zero
  over the 1 ft window and so cannot touch a real excavation; and (c) excludes
  any cell whose 3×3 design neighbourhood touches nodata. "Compared over" now
  reports the **changed** area and its bounding box alongside the compared area.
  Result: **cut 7,542.3 yd³ against the build-time 7,561.9 — −0.26 %**; **fill
  0.6 yd³** (from 178.6), deepest fill 0.69 ft (from 1.37). The changed area,
  4.684 ac = 204,040 ft², reproduces EA's printed 204,303 ft² to **0.13 %**,
  which is an independent confirmation that what the isopach calls "changed" is
  exactly the limits of excavation. The e2e asserts all of it.
  **The 0.6 yd³ residual is real and is stated**: it is the 2-ft site grid
  disagreeing with the 1-ft master over the part of the working buffer the mine
  window does not reach. Shipping a 1 ft DEM over the southern residential lots
  would remove it; nothing in the app can.
- **F10 — the compass/nav cluster** gains a 30 px bottom margin so it clears the
  watermark. The watermark itself does not move (§10 fixes it).
- **F11 — `SBMM.view`** (new, `js/view.js`) remembers the 2D centre/zoom and the
  3D orbit camera in localStorage and restores them on boot. Every read is
  guarded, debounced and range-checked against the survey window; anything that
  is not a finite number inside it is discarded and the caller falls back to its
  own default framing. The 3D camera is stored in **survey terms** — a target in
  State Plane feet plus radius, bearing and pitch — because scene coordinates
  move with the exaggeration slider.

### Still open after the fix round

- **The 0.6 yd³ isopach residual** above — a data-resolution limit, not a bug.
- **Long CAD row names truncate at the default dock width** ("Decision units —
  CAD linework (…"). The tooltip carries the full name and the dock drags wider;
  a two-line layer row was judged worse than an ellipsis.
- **The 3D toolbar is already icon-only at 1600 px** when both docks are open,
  because the stage is then 878 px. That is the ruling's own ordering (labels
  before controls); it is not a clipping failure.

---------------------------------------------------------------------------

## v9 delivery round (planner rulings D1–D5, Agent D)

The last three items before the build went to the user's machine. D1 removes the
data-resolution limit F9 could only work around; D2 is three UI nits found by
looking at `test/shots/2d_default.png`.

### D1 — `dem_res`, a 1-ft DEM over the residential lots

`data/dem_res.png` + `dem_res.json`, payloads `datajs/d_dem_res.js` and
`datajs/i_dem_res_png.js` (3.4 MB), both in `index.html`'s script list. The
window is the residential design bbox plus a 60 ft working buffer —
**E 6,369,890–6,371,440 × N 2,126,050–2,130,370, 1,550 × 4,320 ft at 1 ft** —
cut from the same `master_1ft.f32` the other two DEMs come from, with the same
terrain-RGB encoding (`zmin` 1325.0, `step` 0.02, row 0 = north, `v = 0`
nodata). `tools/build_dems_from_master.py --only=res` rebuilds just this one and
round-trips the PNG against the master before it will write it (max |err| 0.0100
ft, exactly half a step). Half the window is nodata — it reaches out over Clear
Lake — which costs nothing: nodata is `#000000` and compresses away.

It **overlaps `dem_abp`** on purpose, and the overlap is decided rather than
avoided: `SBMM.dems` is one ordered list, `[dem_abp, dem_res, dem_site]`, and
everything that asks "what is the ground here" walks it in that order —
`SBMM.elev`, `SBMM.slopeAt`, `SBMM.demAt` / `SBMM.demForBox` (new; the volume,
design and smart-boundary jobs pick the finest DEM that covers the *whole*
footprint through them), `gridsFor()` in `js/jobs.js` (the stack the isopach
kernel receives), and the 3D terrain meshes. `dem_abp` first, not merely
finest-first: it is the older, more-exercised grid and every golden number was
measured on it, so nothing in the mine window can move.

The 3D viewer builds one mesh per DEM, coarsest first, each holed by every finer
window ahead of it. The hole test had to stop being "is this cell inside *the*
window": two overlapping rectangles make an L, and a coarse cell can straddle
the seam, lying wholly inside neither while lying wholly inside the union — that
cell drawn anyway is a ribbon of coarse mesh z-fighting the fine one along the
join. `coveredBy()` subtracts each rectangle from the remainder instead, which
is exact. The residential mesh drapes with the **site** texture: the site ortho
(1.5 ft), the site hillshade and the computed site rasters all cover that
window, and there is no finer imagery over the lots. What `dem_res` buys is mesh
geometry and elevations, not pixels.

**What it fixes.** 33 % of the `res_excbottom` / `res_finish` design rasters sat
on the 2-ft site grid; now none of it does. The isopach's last residual —
the 0.6 yd³ of fill F9 could only explain, not remove — is gone: **fill 0.0 yd³,
cut 7,556.1 yd³ against the build-time 7,561.9 (−0.08 %, was −0.26 %)**. The
e2e's tolerance is tightened from 1 % to 0.5 % and its fill bound from 5 yd³ to
0.5 to hold that. Note that Lot 25 and the other named lots were *already*
inside `dem_abp`: what gained 1-ft ground is the **southern residences** and the
western/southern working buffer. The e2e probes both — a point inside "Limit of
excavation — Southern Residence" where the two grids differ by 0.78 ft and must
now read 1-ft, and Lot 25, which must not move at all.

Boot cost: `dem-res` is a 6.7-megapixel PNG decode, and the boot-done median
moved 3.94 s → 4.06 s (+0.12 s), inside the +0.25 s the ruling allowed.

### D2 — three UI nits from `test/shots/2d_default.png`

**(a) The stray lines west of the lots** were three different things, only two of
them CAD:

- `G-ANNO-MATC` — AutoCAD **match lines**, 3 features, ACI 253 grey. The longest
  is a dead-straight 3,724 ft rule across the whole site at N 2,128,294. A match
  line is a paper device ("continues on the next sheet"); in model space it is
  indistinguishable from a survey or alignment line.
- `G-ANNO-DETL-PROP` — the **detail call-out** assembly, 14 features, ACI green:
  twelve 1–3 ft stubs and two 172 ft leaders, all parked at ~(6,369,42x,
  2,129,47x), about 1,700 ft west of the nearest lot, out in the lake. That is
  the short green segment at the far left.
  Both go into `DEFAULT_LAYER_OFF` beside `G-ANNO-SYMB`, in all three homes
  (`js/cadnative.js`, `tools/build_cad_native.py`, `data/design/cad_layer_map.json`).
- The **fan of thin grey diagonals** is not CAD at all: they are the survey
  contours (`base/contours_site`, on by default and staying on). The set runs
  out over Clear Lake and around the survey's own data boundary, where the app
  has no terrain: **7,627 of the 10-ft set's 38,414 vertices (20 %) sit on DEM
  NoData**, and the polylines that close around the boundary carry straight
  **chords** — the longest 4,766 ft — from where they left the terrain back to
  where they re-entered. `js/layers.js` now applies two tests, both exact rather
  than length heuristics, because a contour at z lies *on* the ground at z:
  a vertex with no terrain under it is dropped and breaks the run, and within a
  run any segment over 60 ft whose **midpoint** is over NoData is a closing
  chord and breaks it too. That leaves **451 polylines from 290 originals**, 30,701 of the
  38,414 vertices — fewer objects than the chord rule alone produced (2,146),
  because most of what that was cutting up was lake — and keeps every real segment; the longest
  survivor is 387 ft with a midpoint elevation of 1,329.9 against a level of
  1,330. Display only; `data/contours_site.json` is untouched. The 3D contour
  drape has done the equivalent since v8 (`BRIDGE_FT` / `TOL_FT`); it drops the
  segment, this splits the polyline, because in 2D the tooltip and the hit
  target belong to the run.
- **Still there and deliberately so**: one 175 ft hairline of `G-ANNO-TEXT` at
  the same spot in the lake — the underline of the same detail bubble. That
  layer carries EA's real text annotation as well (13 features across three
  drawings), so suppressing all of it to remove two leader lines would cost more
  than it saves. It is one search away in the Layer manager.

**(b) Curated layers before the sheets.** The design group is read top-down as
"what is the remedy here", and twenty `C-103 · Lot 13` rows at the top pushed
every authoritative layer below the fold. `js/layers.js` now builds
`designGIS` → `CadNative` → `designEA`, and `js/designea.js` emits its vector
boundaries and sheet footprints first, then a **`Sheets (draped)`** sub-header,
then the per-sheet raster rows, then the `Sheets draped in 3D` master switch
(moved out of `js/layers.js` to sit with the rows it governs). Nothing depended
on the old order: the curated "Limits of excavation" and the CAD "Limits of
excavation — CAD linework" are disambiguated by `RELABEL`, not by registration
order.

**(c)** The group title is **"Residential design (EA 2025)"** in `index.html`
and `js/layerstate.js` (both homes). Shortening the text was not enough on its
own: at the default dock width the header is 247 px, the title needs 194 and the
caret plus master checkbox take 38, so the count badge and the `manage…` button
(another 86) still pushed it onto three lines. `.lsectitle` is now
`white-space:nowrap` with no `min-width:0`, so its flex min-content size is the
whole string and the header (`flex-wrap:wrap`) drops the badge and the button to
a second line instead of wrapping the name. The cultural group opts back in to
wrapping — its title is 241 px and is a line of its own however the rest is
arranged.

The e2e asserts all of it: the title and that it occupies one line, the
sub-header's existence and that no sheet row precedes it, that the three paper-
annotation layers are off by default *and* stay off through
`resetLayerOverrides()`, that no drawn contour vertex sits on NoData and no
drawn segment over 60 ft crosses it, and that the split did not shatter the set
(a ceiling of 1,200 polylines against the 451 it produces).
