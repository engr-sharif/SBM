# SBMM Site Explorer — v10 water specification (authoritative)

Owner/decider: Fable (planner). Executors: Opus agents A (compute kernels) and
B (application). This document is the contract: agents implement what is
written here and do not re-decide it. Where something is not specified, choose
the simplest option consistent with CLAUDE.md and note it in your final report.

Hard constraints (unchanged, see CLAUDE.md): file:// only (no fetch), plain
script-tag JS, kernels in `js/compute.js` are context-free (no DOM, no `SBMM`),
two builds (folder + dist), golden Pile 1 = 278.4 yd³ fill / −48.1 net ±10,
`test/e2e.mjs` + `test/split3d.mjs` pass on folder AND dist, run the browser
harnesses one at a time. Every failure the user can cause raises a `toast()`.

---------------------------------------------------------------------------

## 0. What the user asked for, in his words

> a rain drop marking to place to see where water would flow … we have all the
> topo … build that into it beautifully.

> the Herman impoundment … use the topo and predict if it overtops where that
> flow would go … something like a ring of elevations … visually see how it
> would overtop and where it would over top … beautifully and accurately, using
> the ground truth data.

Ground truth = the January-2024 lidar bare-earth grid the app already carries
(`SBMM.dems`: 1-ft mine window, 1-ft residential window, 2-ft site). Nothing
else is invented: no hydraulics, no rainfall, no seepage. Both tools are
**static terrain analyses**, and the cards say so.

## 1. The two tools

### 1.1 Raindrop (`raindrop` mode, key **R**, command `DROP`)

Click anywhere: a drop lands there and runs downhill by steepest descent over
the finest DEM covering it. Where it reaches a low point it **ponds**: the
depression fills to its pour point, the pond is drawn with its level, depth,
area and volume, and the drop continues from the pour point. It ends when it
reaches the edge of the surveyed terrain (Clear Lake or the survey limit), or
in a depression whose outlet is not inside the search window (a genuine sink),
or after the length cap. Every click makes another drop; the mode stays armed;
Esc returns to Navigate.

The result is an ordinary store feature of a **new type `flow`** — in the
My-work tree, the Inspector, sessions, GeoJSON/DXF, undo, 2D and 3D — with a
Results card carrying the numbers and an elevation profile of the run.

### 1.2 Overtopping (`OVERTOP` command; Water ▾ menu; the Herman polygon's popup)

For a water body — the Herman Impoundment by default, or any pond under a
click — find the elevation at which it first spills, **where** it spills, how
much water that takes, where the overflow goes, and the **ring of rim
elevations**: a band around the impoundment coloured by how far above the
spill each stretch of rim stands, with the low points ranked and labelled. A
level slider raises the water from today's surface to the spill and beyond;
at the spill the overflow route appears and runs downhill.

## 2. Definitions (the accuracy contract)

All of these are computed on ONE grid per analysis: the finest DEM that covers
the whole working window (`SBMM.demForBox`), never a mix. The card names the
grid ("1-ft lidar grid" / "2-ft lidar grid").

- **Descent.** D8 on cell centres: from a cell move to the 8-neighbour with the
  greatest drop per unit distance (`(z − zn) / dist`, dist = cell or cell·√2),
  strictly downhill (`drop > 1e-9`). A NoData neighbour is a **sink** (Clear
  Lake / survey limit): the trace ends there with reason `nodata`. Window edge:
  reason `window` (the host re-runs, §4.2).
- **Pond (fill-spill).** Every trace keeps a `pondId` grid (Int32, 0 = dry)
  and a pond table `{ level, outlet cell | null, cells, zmin }`, and uses the
  filled DEM `F` of its window (below). A cell with no lower neighbour is a
  pit. From it, priority-flood (min-heap on z): pop the lowest frontier cell
  u (skip it if it already has a pond id), raise the level to max(level,
  z_u), give u this pond's id. Then look at u's 8 neighbours v: a NoData v
  ends the trace (`nodata`, v appended as the last vertex); a dry v with
  `z_v < level` **and `F_v < level − 1e-6`** *escapes* — it drains to a sink
  strictly below the current level — and is the **outlet** (greatest drop per
  distance if several); the flood stops. Otherwise push u's dry non-NoData
  neighbours. A dry neighbour below the level with `F_v ≥ level` is *inside*
  this depression (every interior cell of a depression has `F` equal to its
  pour level — that equality is why the test must be strict: with `≤` the
  planner's reference "escaped" into a cell 0.02 ft under the pond's own
  surface and stopped there) and is simply flooded as the pop order reaches
  it. Popping a window-edge cell ends the trace with `window` (exit = that
  cell). Heap exhausted = `pond`.
  **Completion**: once the outlet is found, keep popping while the heap's
  minimum is ≤ level: a cell that escapes (same strict test) is a wall and is
  skipped; any other cell is under water — flood it and push its neighbours
  with `z ≤ level`. Never cross a wall. This makes the pond polygon the whole
  depression at its level, not just the cells popped on the way up.
  **Effective elevation**: descent reads a pond cell as its pond's *level*,
  never its floor; so from the outlet (which lies below the level) the pond is
  uphill and the drop cannot fall back in. When the steepest neighbour is a
  pond cell (a drop arriving from above), the drop enters it (that cell is a
  vertex) and continues from that pond's outlet (or ends with `pond` if the
  pond has none). Pond level = the level when the outlet was found; depth =
  level − min z; volume = Σ(level − z)·cell²; area = cells·cell². Ponds
  shallower than `minPondDepth` (default **0.25 ft**, the lidar noise floor)
  are crossed but not reported or drawn.
- **Flat.** A flat is a pit with a flat floor; the flood handles it (all cells
  pop at the same z, the outlet is the first frontier cell with a lower
  neighbour). No separate flat-routing code.
- **Filled DEM `F`** (both tools; computed once per window). Outside-in priority flood from the sinks
  (every NoData cell and every window-edge cell): pop lowest, `F = max(z,
  level of the cell it was reached from)`. Standard Barnes-2014 pit filling.
- **Water surface.** The impoundment's lidar surface is a flat plateau; its
  level `z0` = median z of the DEM cells inside the water polygon; the seed set
  = cells inside the polygon with |z − z0| ≤ `plateauTol` (0.3 ft). For a
  point seed: the 8-connected component of cells within ±`plateauTol` of the
  clicked z.
- **Spill (pour point) and rim lows.** Inside-out priority flood from the seed
  with a **sealed** frontier: pop lowest frontier cell c, level L = max(L, z_c),
  flood c, record `level[c] = L`. For each unflooded non-NoData neighbour n of
  c with `z_n < L`: if `F_n < L − 1e-6` water reaching n **escapes** (n drains
  to a sink strictly below L) — record c as a *spill cell* at level L and mark
  n as a wall (never flooded, never pushed); otherwise n lies inside the
  depression (`F_n = L` for every interior cell, so the test is strict) or in
  a local pit that fills before it can drain, and it is pushed normally. Continue until
  `L > primary + rimRange` (rimRange default **3 ft**) or the flooded count
  exceeds 60 % of the window (reason `window`, the host enlarges and retries).
  The **primary spill** is the first spill cell (lowest level); **freeboard** =
  primary level − z0; **storage to spill** = Σ(primary − z)·cell² over cells with
  `level ≤ primary`. **Rim lows** = 8-connected clusters of spill cells; per
  cluster: min level, lowest cell (x, y), cell count; sorted by level; the
  primary is rank 1. **Rim band** = flooded cells with `primary < level ≤
  primary + rimRange`, value = level − primary.
- **Stage table**: for L from z0 to primary + rimRange step `levelStep`
  (0.25 ft): area = cells with level ≤ L, storage = Σ(L − z) over them, and the
  outline of that set (§3.2). Above the primary the table describes the
  sealed flood, i.e. "if the low rim at ① were raised" — the card says so.
- **Overflow route** = a raindrop from the primary spill cell's lowest escaping
  neighbour (`primary.next`), with the impoundment's seed cells pre-marked as
  pond 1 with **no outlet** (`blockRing`), so a route that ever came back to
  the pond ends there with `pond` rather than re-entering it.
- **Catchment** (raindrop card action) = all cells whose D8 path over `F`
  reaches the drop cell: D8 directions on the filled DEM within the window,
  BFS upslope from the drop cell; area = cells·cell²; outline via the mask
  tracer. Reported as "contributing area (within the N-ft window)".

## 3. Kernels — `js/compute.js` (Agent A)

Context-free, typed arrays, progress callbacks, transferables, in the style of
`isopachGrid` / `pileWand`. Add to `runJob` and to `api`. Each returns
`{ result, transfer }`. Grid = the `gridSpec` object from `js/jobs.js`
(`x0,y0,cell,w,h,i0,j0,sw,sh,z`); use `gz`/`gridAt`; a NoData cell is NaN.
Implement one typed-array binary min-heap (Float64 keys, Int32 payload) shared
by the three kernels — no object allocation per push.

### 3.1 `flowpath`

```
job: { grid, x, y, minPondDepth = 0.25, maxSteps = 4e6, simplifyFt = null,
       blockRing = null /* [[x,y],...] in SP ft; cells inside start as pond 1, no outlet */ }
result: {
  pts: Float64Array [x0,y0,z0, x1,y1,z1, ...]   // cell centres along the run, simplified
                                              // (ring-aware simplifyPath, tol = simplifyFt ?? 0.6*cell,
                                              // applied to xy; z carried per kept vertex)
  n: number,                                  // vertices
  length_ft, fall_ft,                          // planimetric length; z(start) - z(end)
  reason: "nodata" | "window" | "pond" | "steps",
  end: [x, y, z],
  exit: [x, y] | null,                        // for "window": the edge cell centre
  ponds: [{ level, depth_ft, area_ft2, volume_ft3, cells,
            rings: [[[x,y],...], ...],        // traceMask at the pond's cells, simplified 0.5*cell
            entry: [x,y], outlet: [x,y]|null }],
  cell, steps
}
```
The path includes the entry into and the outlet out of each pond as vertices
(the run across the pond floor is not drawn — the pond polygon is). Ponds are
reported in trace order with their rings traced from the `pondId` grid at the
end (`traceMask` on each pond's own id).

### 3.2 `overtop`

```
job: { grid, seedRing | seedPoint:[x,y], plateauTol = 0.3, rimRange = 3,
       levelStep = 0.25, maxClusters = 12, outlineTol = null }
result: {
  z0, cell, seedCells, seedArea_ft2,
  primary: { level, x, y, next: [x,y] } | null,      // next = lowest escaping neighbour
  freeboard_ft, storage_ft3, area_ft2,               // at the primary level
  clusters: [{ rank, level, x, y, cells, above_ft }], // above_ft = level - primary
  stage: [{ level, area_ft2, storage_ft3, rings: [[[x,y],...],...] }],  // z0 .. primary+rimRange
  band: { nx, ny, x0, y0, cell, v: Float32Array },   // level - primary; NaN outside the band
  spillMask: { nx, ny, x0, y0, cell, v: Uint8Array },// 1 = spill cell (for the marker glow)
  reason: "ok" | "window" | "noseed" | "nospill"
}
```
`band`/`spillMask` are on the job grid's own cells over the window (row 0 =
south, like every other grid in this file). Rings from `traceMask` with tol
`outlineTol ?? 0.5*cell`, outer rings first. Progress: F flood 0–0.45, sealed
flood 0.45–0.85, stage/outlines 0.85–1.

### 3.3 `catchment`

```
job: { grid, x, y }
result: { area_ft2, cells, rings: [...], touchesEdge: boolean }
```
D8 on `F` (ties: first of the 8 in fixed order), BFS upslope from the drop
cell. `touchesEdge` = the catchment reaches the window edge (then the number
is a lower bound and the card says so).

### 3.4 Acceptance for Agent A

- `test/water_kernels.mjs`: a **node** harness (no browser) that loads
  `js/compute.js` through `vm`, reads the two fixtures the planner wrote
  (`<scratchpad>/fix_abp_window.{json,f32}` and
  `<scratchpad>/fix_herman_window.{json,f32}`; `.f32` = little-endian Float32
  rows south→north, `sw` per row, matching `gridSpec`'s `z`), runs
  `flowpath` at the fixture's `drop` and `overtop` with the Herman polygon from
  `data/design_gis.json`, and prints every number in §9 next to its reference.
  The harness is committed (with the fixture paths taken from argv) — it is
  the fast loop for anyone touching these kernels.
- Every §9 number reproduced within its tolerance.
- The existing kernels untouched; `api.VERSION` bumped to 4.
- Wall time in node on the 2-ft Herman window (1.5 M cells): `overtop` ≤ 4 s,
  `flowpath` ≤ 1 s for a 2,000-ft run, `catchment` ≤ 2 s.

## 4. Application — `js/water.js` → `SBMM.water` (Agent B)

New file, listed in `index.html` after `js/isopach.js`; `SBMM.water.wire()`
called from `js/boot.js` after `SBMM.sheetMarks.wire()`. Public API:

```
SBMM.water.dropAt(x, y, opts?)      -> Promise<feature>   // the raindrop
SBMM.water.mkFlow(pts, name, props, spec) -> feature      // rebuildFeature hook
SBMM.water.retrace(f)               -> Promise<feature>
SBMM.water.catchment(f)             -> Promise<feature>   // 'area' feature
SBMM.water.overtopHerman()          -> Promise
SBMM.water.overtopAt(x, y)          -> Promise            // point seed
SBMM.water.overtop({ ring, name } | { point:[x,y], name }) -> Promise
SBMM.water.clearOvertop()
SBMM.water.drapeSpec()              -> { url, bounds } | null   // the rim band for 3D
SBMM.water.active()                 -> current overtop result | null
SBMM.water.wire()
```

### 4.1 The `flow` feature type

- `type: "flow"`, `pts` = the run's xy vertices (what exports and the 3D line
  use), `props`: `{ drop:[x,y], drop_z, length_ft, fall_ft, grade_pct,
  end:{x,y,z,reason}, ponds:[{level, depth_ft, area_ft2, volume_ft3,
  rings}], zs:[...] (z per vertex, ≤ 600 samples, decimated evenly),
  dem:"1-ft"|"2-ft", minPondDepth, hops }`. Default `group: "Water"`.
- `SBMM.tools.rebuildFeature` dispatches `"flow"` → `SBMM.water.mkFlow`, which
  rebuilds from `props` **without recomputing** (sessions and imports must not
  spawn jobs on load). `styles.flow = { pane:"drawings", color:"#55C1FF",
  weight: 2.75 }`; `TYPE_META.flow = { label:"flow", full:"raindrop flow path",
  icon:"i-profile" }` (or a new `#i-drop` symbol if you add one to the sprite);
  `TYPE_FULL.flow`; `PROP_LABEL` for the new props; `COLORS.flow = 0x55C1FF`
  in `js/viewer3d.js`.
- Editing: vertex editing refused with a toast ("drag the raindrop to
  retrace"). The **drop marker is draggable**; `dragend` → `retrace(f)` keeps
  the feature id and card, pushes one undo entry restoring the previous
  `pts`/`props`.
- My work: a new class row **Water** (`mywork/water`) masks `flow` features
  (the six existing rows keep their ids; update the e2e's My-work count).
- Export: GeoJSON → the run as `LineString` with the scalar props, plus one
  `Polygon` per pond named `"<flow name> pond k"` with `parent`, `level`,
  `depth_ft`, `area_ft2`, `volume_ft3`; DXF → the run on the group layer
  (`WATER`), ponds as closed polylines on `WATER-PONDS`. Import of a
  `LineString` stays a `line` (a flow is computed, never imported).
- Popup (`SBMM.popups.forFeature`): the standard header plus rows Length,
  Fall, Grade, Ends, Ponds crossed; actions: "profile", "catchment",
  "retrace", "3D".

### 4.2 The trace (host side)

`dropAt(x, y)`: DEM = `SBMM.demAt(x, y)` (toast if none: "no surveyed terrain
under that point"). Window = square of half-size **700 ft on a 1-ft grid,
1,400 ft on the 2-ft grid** centred on the drop, `gridSpec(dem, bbox, 0)`.
Run `flowpath` with the status-bar label "Raindrop". While `reason ===
"window"` and hops < 8 and total length < 20,000 ft: re-run centred on
`exit`, DEM = `SBMM.demAt(exit)` (so a run that leaves the 1-ft window carries
on over the 2-ft grid; the card lists the grids it used), append the path
(drop the repeated first vertex) and the ponds. One feature, one card, at the
end. Cancel-safe: a second click while a trace is running queues a second
drop; each drop is its own job chain.

### 4.3 Rendering — this is the part that has to be beautiful

**2D (Leaflet, `preferCanvas`).**

- The run is the feature's own layer in the `drawings` pane (selection,
  hover, click all work as for every feature): a `layerGroup` of
  (a) a soft glow polyline `rgba(85,193,255,.32)` weight 9, non-interactive,
  (b) the core polyline `#55C1FF` weight 2.75 (this one is `f.layer`'s
  interactive path; selection paints it `#FFD34D` as usual),
  (c) one polygon per pond: fill `rgba(85,193,255,.28)`, stroke `#55C1FF`
  weight 1.5, `dashArray "4 4"`, tooltip "pond · 0.8 ft deep · 0.12 ac ·
  1,240 ft³ · level 1,352.4 ft",
  (d) the **drop marker**: a `divIcon` teardrop (inline SVG, 18×22 px, fill
  `#9FDCFF`, stroke `#0E1418` 1 px, a small white highlight), draggable,
  tooltip "raindrop — drag to retrace",
  (e) the **end marker**: a 10-px circle `divIcon` with a permanent label to
  the right in the app's mono face: `reaches Clear Lake / survey limit ·
  1,340 ft · −41.2 ft` | `ponds here — no outlet within 1,400 ft` |
  `stopped at the length cap`.
- **Flow animation**: a second, non-interactive copy of the core line in a
  new pane `water` (z-index 470, `L.svg({ pane:"water" })` renderer,
  `interactive:false`, `pointer-events:none` on the pane): `#DFF4FF` weight
  1.6, `dashArray "5 11"`, CSS `@keyframes flowdash { to { stroke-dashoffset:
  -16 } }` 0.9 s linear infinite on `.flowanim` paths. Zero JS per frame. The
  animation runs only while the feature is visible; it is dropped when the
  feature is hidden, and honours `prefers-reduced-motion` (static dashes).
  **Check the canvas pass-through** in `js/map.js`: the new pane must not eat
  pointer events (SVG panes do not by default; assert it in the e2e by
  clicking a DU through a drawn flow).
- **Pond labels** appear when the pond is ≥ 36 px across on screen (same zoom
  gating idea as the excavation depth labels).

**The overtop overlay** (lives while its card exists, like the isopach):

- Rim band: canvas → data-URL `L.imageOverlay` in the `analysis` pane,
  opacity .85. Ramp over `v = level − primary` in [0, rimRange]:
  `0 → #FF4D3D`, `0.5 ft → #FF8A3D`, `1.5 ft → #FFD166`, `rimRange →
  #FFF3B0` with alpha from 0.92 at 0 to 0.10 at rimRange, NaN transparent.
  Low rim glows hot, safe rim fades out. Legend on the card: a horizontal
  ramp bar labelled "at spill" … "+3 ft".
- Spill cells: painted on the same canvas as saturated `#FF2A1A` at alpha 1 so
  the exact overtopping cells are visible at any zoom.
- Rank markers: `divIcon` badges ①②③… (primary is a 22-px pulsing ring,
  CSS `@keyframes spillpulse` scaling a box-shadow ring; secondaries 16-px
  static) with permanent labels: primary `SPILL 1338.3 ft · +1.7 ft`,
  secondaries `② +2.4 ft · 1339.0`. Clicking a marker zooms the map to it.
- Water body at the slider level: one `area`-styled polygon (fill
  `rgba(85,193,255,.22)`, stroke `#55C1FF` 1.5) from the stage table's rings
  nearest the slider value; today's surface (z0) is drawn as a thin dashed
  outline for reference.
- The overflow route is a real `flow` feature named "<name> overflow route"
  (group "Water"), created by the analysis; the pond-at-spill outline is a
  real `area` feature named "<name> at spill <level> ft" with
  `props.overtop = { z0, spill, freeboard_ft, storage_ft3 }`. Both survive
  in the session; the band/markers/slider do not (they are recomputed by
  running the analysis again, ~2 s).
- **Slider** on the card: `<input type=range>` from z0 to primary + rimRange,
  step = levelStep, default = primary. Label: `water level 1338.25 ft ·
  +1.67 ft above today · 12.4 ac-ft to store`. Below the primary: the
  overflow route is hidden and the label says "no overflow". At/above: the
  route is shown, the label says "OVERFLOWS at ①". Above the primary the
  label adds "(if the rim at ① were raised)".

**3D (`js/viewer3d.js`).**

- `flow` features: the generic branch already drapes `pts`; add: each pond
  ring as a thin draped closed line (`0x55C1FF`, width 2) and the drop as a
  6-ft sphere (`0x9FDCFF`). Keep the pick registry contract (userData.pick).
- Rim band drape: generalise the isopach drape into a small list —
  `refreshDrapes()` iterating `[SBMM.isopach.drapeSpec, SBMM.water.drapeSpec]`
  with one mesh each (the isopach e2e assertions must keep passing; keep
  `refreshIsopach` as an alias that calls it).

### 4.4 Chrome

- **Top bar**: a `Water ▾` menu button (`id="waterMenuBtn"`, `#i-drop` icon —
  add a teardrop symbol to the sprite) after Design ▾. Menu `#waterMenu`:
  `Raindrop — trace where water flows <kbd>R</kbd>` (`data-m="raindrop"`),
  `Overtopping — Herman Impoundment…` (`data-a="overtop"`), `Overtopping — a
  pond under a click…` (`data-a="overtop-click"`, arms a one-shot click),
  separator, `Clear water overlays` (`data-a="water-clear"`). Wire it exactly
  like Draw ▾ / Design ▾ (`wireMenu`, the close-all selector list, the F7
  parent-button naming, the overflow menu at narrow widths — `js/shell.js`
  and `js/mode.js` both enumerate the menus; keep every list in step and
  re-check the 1280-px narrowing assertions in the e2e).
- **Mode** (`js/mode.js`): `raindrop: { label:"Raindrop", tool:"raindrop",
  cursor:"crosshair", key:"R", next:"click where the drop lands", more:"every
  click traces another drop" }`; `TOOL_HOME.raindrop = "raindrop"`.
  `js/tools.js`: `CLICK_TOOLS` gains `raindrop`; `mapClick` routes it to
  `SBMM.water.dropAt`; `START_TIP.raindrop`. Works from 3D through the
  existing `mapClick` bridge with no further change.
- **Commands** (`js/cmdline.js`): `DROP` (aliases `RAIN`, `RAINDROP`,
  `WATERDROP`, `FLOW`) → mode raindrop; `OVERTOP` (aliases `SPILL`, `POUR`) →
  `overtopHerman()`; `CATCH` (alias `WATERSHED`) → catchment of the selected
  flow. No alias may collide (the e2e fails on a duplicate).
- **Popups**: `forTerrain` gains a third action "trace a raindrop";
  `forGis` for a `water`-layer polygon gains "overtopping analysis" (calls
  `SBMM.water.overtop({ ring, name })`); `forFeature` for `flow` per §4.1.
- **Help** (`index.html`): a **Water** paragraph after Volume: what a raindrop
  does, what a pond means, what the overtopping analysis is and is not.
- **Results cards**:
  *Raindrop*: rows `Drop point` (E, N · Z), `Run length`, `Fall`, `Average
  grade`, `Ends` (reason sentence + E, N), `Ponds crossed` (n; then one row
  per pond up to 6: `pond k · level · depth · area · volume`), `Grid`;
  then the **profile sparkline**: inline SVG 300×64, x = distance, y = z,
  line `#55C1FF` 1.5 px, ponds shaded `rgba(85,193,255,.25)` between the
  floor and the level, axis ticks in the mono face at 10 px, the end labelled
  with its z; buttons `profile` (creates a `profile` feature along `pts` →
  the interactive chart), `catchment`, `retrace`, `3D`. Then the note:
  "Steepest-descent trace on the <grid> lidar bare earth; depressions fill to
  their pour point and the drop continues. No rainfall, infiltration or
  hydraulics — a terrain analysis, planning-level."
  *Overtopping*: rows `Water surface (lidar, Jan 2024)`, `Spill elevation`,
  `Freeboard`, `Spills at` (E, N + `zoom`), `Storage to spill` (ac-ft and
  ft³), `Area at spill` (ac), `Overflow route` (length, ends …, `zoom`),
  `Grid`; the **rim lows table** (rank badge, +ft, level, E N, zoom); the
  **slider**; the **stage-storage chart**: inline SVG 300×110, x = level
  (z0 … primary+rimRange), two lines — storage (ac-ft, `#55C1FF`) and area
  (ac, `#9FDCFF` dashed) on their own right/left axes — with a vertical
  `#FF4D3D` rule at the spill labelled "spill"; the band legend; buttons
  `hide overlay` / `show overlay`, `3D`, `clear`. Then the note: "Static
  spill analysis on the <grid> lidar bare earth: the water surface is the
  lidar's flat return over the pond (1336.6 ft), the spill is the lowest rim
  cell from which water drains away (pit-filled DEM), storage is geometric.
  No inflow, wave run-up, seepage or erosion — planning-level."
- **Layer state**: no new layer rows beyond `mywork/water`.
- **Session**: file version stays v7; `flow` is a new feature type dispatched
  by `rebuildFeature`; an older build skips it.

### 4.5 Acceptance for Agent B (the e2e additions, `test/e2e.mjs` "9h. water")

Write the assertions so they read the §9 reference numbers from constants at
the top of the block. Assert:

1. Mode: key `r` → `raindrop`; the Water ▾ button lights and reads
   "Raindrop ▾"; Esc → `navigate`; commands `DROP`, `OVERTOP`, `CATCH` exist;
   alias collisions still 0.
2. `SBMM.water.dropAt(6371600, 2128900)` (the §9.1 drop): a `flow` feature
   is added; `length_ft`, `fall_ft`, `end.reason`, end position and pond count
   match §9.1 within tolerance; `zs` is non-increasing except where a pond
   level is reported; the feature is in the My-work tree under Water; it is
   on the 2D map; `pick3d` lists it after opening 3D; GeoJSON export carries
   the LineString plus the pond polygons; serialise → remove → rebuild
   restores the same vertex count and props without running a job
   (`SBMM.compute` stats unchanged).
3. Pass-through: with that flow drawn, a click on a decision unit still opens
   the DU popup (extend the existing click-priority probe).
4. `SBMM.water.overtopHerman()`: z0, primary level, spill position (within
   15 ft), freeboard, storage to spill (±3 %), area at spill (±3 %), ≥ 3
   clusters within rimRange, the overflow route's `end.reason`, its end
   position (within 50 ft) and length (±10 %) — all per §9.2. The rim band
   overlay is on the map; the slider exists with min = z0 and default =
   primary; moving it below the primary hides the route, at the primary shows
   it; `drapeSpec()` is non-null and, with 3D open, `viewer3d.stats()` reports
   the drape; `clearOvertop()` removes the overlay and the drape but keeps the
   two features.
5. `catchment(f)` on the §9.1 flow returns an `area` feature with area within
   ±5 % of §9.1's reference.
6. No page errors in any of it; all previously existing assertions untouched
   except the My-work row count.

Also: `test/water_shots.mjs` (not pass/fail) writing `test/shots/water_drop.png`
(2D, a drop on the north mine slope, zoomed to the run), `water_drop_3d.png`,
`water_overtop.png` (2D, the Herman analysis framed with the band, markers and
the route) and `water_overtop_3d.png`. Look at them before reporting.

## 5. Docs (Agent B, last)

- `CLAUDE.md`: code-map row for `water.js`; a "v10 water" section with the
  definitions of §2 in short form, the kernel names, the window/chaining rule,
  the two gotchas (the global flooded mask; the `F`-based escape test and why
  the naive "lower neighbour" test reports a 0-ft freeboard on the Herman
  shoreline); `test/water_kernels.mjs` in the test list.
- `README.md`: a "Water — raindrop and overtopping" section (user-facing).
- `docs/HANDOFF.md`: decisions table rows (static analysis only; ponds ≥ 0.25
  ft; window sizes) and an open item ("hydraulics / rainfall are out of
  scope; ask before adding").
- `RELEASE_NOTES_v9.md`: a "v9.2 — water" section at the top.

## 6. Division of labour and order

- Agent A works only in `js/compute.js` and `test/water_kernels.mjs`.
- Agent B works everywhere else and may stub `SBMM.compute.run("flowpath"…)`
  against this spec until A lands; B integrates and runs the browser harnesses
  **one at a time** at the end (folder e2e, then split3d).
- The planner runs the dist build, all four harnesses on both builds, reviews
  the shots against §4.3, and ships.

## 7. Colours (add to `css/app.css :root`)

`--water:#55C1FF; --water2:#9FDCFF; --water3:#DFF4FF; --waterdim:rgba(85,193,255,.28);
--spill:#FF4D3D;` — nothing else in the app uses these hues, which is the point:
water reads as water everywhere it appears.

## 8. Things that are NOT in scope

Rainfall, runoff volumes, time, culverts, pipes, infiltration, wave run-up,
seepage through the impoundment dam, dam-break hydraulics, and any change to
the terrain source. If the user asks for any of them, that is a new spec.

## 9. Reference numbers (golden)

Computed by the planner with an independent Python implementation of §2 on the
same PNG-decoded grids (`scratchpad/herman_ref2.py`, `drop_ref.py`). Filled in
below before the agents were spawned.

### 9.1 Raindrop reference (1-ft mine grid `dem_abp`, window = drop ± 700 ft via `gridSpec(dem, bbox, 0)`)

Fixture: `/tmp/claude-0/-home-user-SBM/63f85d97-7536-5128-ab20-1c10e66fbf18/scratchpad/fix_swale_window.json` + `.f32` (1402 × 1402 cells, i0 431, j0 736);
reference JSON: `/tmp/claude-0/-home-user-SBM/63f85d97-7536-5128-ab20-1c10e66fbf18/scratchpad/drop_ref.json` (key `swale`, includes the unsimplified
path as `pts` every 3rd vertex and the catchment).

| quantity | reference | tolerance |
|---|---|---|
| drop | E 6371200.5, N 2128674.5 (cell centre) | — |
| z at the drop | 1358.44 ft | ±0.05 |
| reason | `nodata` (reaches Clear Lake) | exact |
| end (last vertex = the NoData cell) | E 6370884.5, N 2128611.5 | within 3 ft |
| last surveyed z on the run | 1326.10 ft | ±0.1 |
| run length (unsimplified cell-centre path) | 409.6 ft | simplified path within −3 % / +0.5 % |
| ponds ≥ 0.25 ft | 2 | exact |
| pond 1 | level 1330.96, depth 0.30, 12 cells, 1.4 ft³ | level ±0.03, cells ±2 |
| pond 2 | level 1329.76, depth 0.36, 19 cells, 2.5 ft³ | level ±0.03, cells ±2 |
| catchment of the drop (D8 on F) | 3,046 cells = 3,046 ft² | ±3 % |

(An earlier candidate, E 6371600 N 2128900, runs 1,069 ft into a 4.5-ft-deep,
1,878-cell pond and leaves the window — keep it as a manual check of window
chaining, not as a golden.)

### 9.2 Herman Impoundment reference (2-ft site grid `dem_site`, window = water-polygon bbox ± 800 ft)

Fixture: `/tmp/claude-0/-home-user-SBM/63f85d97-7536-5128-ab20-1c10e66fbf18/scratchpad/fix_herman_window.json` + `.f32` (1753 × 1204 cells, i0 1471, j0 1914);
reference JSON: `/tmp/claude-0/-home-user-SBM/63f85d97-7536-5128-ab20-1c10e66fbf18/scratchpad/herman_ref.json`. Seed ring = the `water`-layer polygon
named "Herman Impoundment" in `data/design_gis.json` (551 vertices).

| quantity | reference | tolerance |
|---|---|---|
| water surface z0 | 1336.58 ft | ±0.02 |
| seed cells | 223,969 (20.6 ac) | ±0.5 % |
| primary spill level | 1343.84 ft | ±0.05 |
| primary spill cell | E 6371927, N 2127693 | within 15 ft |
| `primary.next` | E 6371925, N 2127693 | within 6 ft |
| freeboard | 7.26 ft | ±0.05 |
| storage to spill | 6,881,929 ft³ = 157.99 ac-ft | ±3 % |
| area at spill | 22.83 ac | ±3 % |
| rim low ② | 1344.34 ft (+0.50) at E 6372015, N 2127571, 197 cells | level ±0.05, position within 20 ft |
| rim lows within +3 ft | 5 (1343.84, 1344.34, 1346.52, 1346.68, 1346.76) | count 4–6 |
| stage at 1340.08 | 21.73 ac, 74.19 ac-ft | ±3 % |
| stage at 1343.83 | 22.82 ac, 157.76 ac-ft | ±3 % |
| overflow route reason | `nodata` (reaches Clear Lake) | exact |
| overflow route end | E 6371177, N 2127473 | within 30 ft |
| overflow route length | 974 ft (unsimplified) | simplified within −3 % / +0.5 % |
| ponds on the route ≥ 0.25 ft | 6; the two real ones: level 1339.54 / 1.42 ft / 317 cells / 804 ft³ and 1337.24 / 1.56 ft / 367 cells / 1,307 ft³ | count ±1, levels ±0.03 |

The full stage table (every 0.25 ft from 1336.58 to 1346.83) is in the JSON.
