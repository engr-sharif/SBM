# SBMM Site Explorer — v14 Phase 1: the drainage map (authoritative)

Owner/decider: Fable (planner). Executor: one Opus agent (D). This is the
contract for Phase 1 of `docs/V14_CATCHMENT_PROPOSAL.md` — the terrain-only
half. No rainfall, no runoff, no curve numbers, no time: the map says where
water goes, never how much. Decided by the engineer 2026-09-04 ("start
Phase 1").

Hard constraints (CLAUDE.md): file:// only, plain script-tag JS, context-free
kernels, three builds, golden Pile 1 unchanged, every harness passes, browser
harnesses one at a time, every refusal toasts, no model names in the repo.
Every v10/v12/v13 golden stays; `flowpath` and `overtop` are not touched.

---------------------------------------------------------------------------

## 1. What it is

**One label per cell: the outlet that cell drains to.** The same physics the
raindrop uses — steepest descent on effective elevation, ponds read at their
level, conduits as shortcuts with inlets as sinks — run once over the whole
site instead of from one click, so a raindrop dropped anywhere lands in the
catchment drawn under it. That agreement is the acceptance test.

## 2. Definitions

- **Sink** (a terminal outlet). One of:
  - `nodata` — the descent reaches a NoData cell. Split into **Clear Lake**
    (the NoData cell is inside, or within 10 ft of, EA's `Clear Lake` water
    polygon, passed as `lakeRing`) and **off-survey** (any other NoData or the
    window edge).
  - `inlet` — a conduit's capture cell (from the same flattened list
    `SBMM.storm.conduitsFor` builds, whole-site bbox; `captureFt` 3). Its
    **terminal** is the end of its chain: follow `next` until a conduit with
    no `next`; that last outlet node is the terminal (`outfall` for the road
    drain; the FES toward Herman for `green_riser`; the Herman pipe chain's
    terminal is the outfall). Water leaving a terminal node that is not
    `outfall`-kind continues by ordinary descent from the outlet cell — so
    `green_riser`'s water goes on into the impoundment, and the impoundment's
    water goes out through the pipes to the outfall. The kernel follows it;
    the terminal label is wherever it finally stops.
  - `pond` — a depression whose pour point is not reachable: the flood from
    it meets no escape below its level before the grid edge / NoData / cap.
    In practice: none on the site grid except at the window edge; the
    impoundment drains through its pipes; Frog and Green Ponds through their
    conduits. Kept for correctness and for windows.
- **Through-pond**: a depression the water crosses and leaves (Frog Pond,
  Green Pond, the impoundment, every puddle ≥ 0.25 ft deep). Not a sink, but
  the map needs them: "what drains INTO Green Pond" is the question he will
  ask most. So every cell also gets a **first-capture** label: the first
  through-pond or inlet its path reaches (or its terminal sink if none).
- **Effective elevation and descent**: exactly `flowpath`'s. Build `F` with
  `fillDem` seeded by the inlet capture cells at their rims (the v12 sink
  rule). Find ponds as the connected regions where `F > z + minPondDepth`
  (0.25 ft) at one `F` level... but define them the way `flowpath` does, by
  flooding from each pit to its pour point with the same escape test
  (`z < level − 1e-9 && F < level − 1e-6`) and the same inlet stop rule, so
  the pond levels are the raindrop's levels to the bit. Process pits in
  ascending `z`; a cell already in a pond is skipped.
- **Flow pointer**: for every cell, the cell it drains to: the steepest-drop
  8-neighbour on effective elevation (pond cells read as their pond's level;
  `drop > 1e-9`), the pond's outlet cell for a pond cell, the conduit's outlet
  cell for a capture cell (chain followed), NoData/edge terminates. Flats with
  no strictly lower neighbour and no pond: use the priority-flood parent
  (the cell that pushed it during `fillDem`) — record it in `fillDem` under a
  flag so the no-flag path is byte-identical.
- **Labelling**: resolve pointers with path compression (iterative, no
  recursion, `Int32Array`), giving `terminal[c]` and `first[c]`. Then
  polygons per label with `maskRings` (ring-aware simplify at half a cell),
  areas from cell counts, and per label: kind, name key (conduit id, pond
  index, `lake`, `off`), cells, area_ft2, longest flow path (ft, along the
  pointers, computed for the label's farthest cell), mean slope of its cells.

## 3. Kernel — `drainage` (js/compute.js, new `runJob` kind)

```
job:    { grid, conduits, captureFt, lakeRing, minPondDepth, stride }
result: { cell, stride, w, h,
          sinks:   [{ id, kind, x, y, name, cells, area_ft2, rings, longest_ft, meanSlope_pct, via }],
          ponds:   [{ id, level, depth_ft, cells, area_ft2, volume_ft3, rings, entry, outlet, via,
                      contributing_cells, contributing_area_ft2, contributing_rings }],
          labels:  Int32Array (terminal, decimated by `stride` for hover),
          first:   Int32Array (same),
          steps, ms }
```

- `stride` decimates the OUTPUT rasters only; the analysis runs on the grid
  it is given. The host runs the whole `dem_site` grid (2 ft, 21.6 M cells) on
  desktop and a `gridSpec` windowed at… no: the field build runs the site
  grid decimated 2× by the host (a 4-ft `subGrid` built with `strideFor`-style
  sampling, in `js/jobs.js`) and the card says "4-ft grid". The mine and
  residential 1-ft windows are NOT run site-wide (memory); the raindrop
  remains the 1-ft answer and the identity test tolerates that (below).
- Memory: `F`, pointers, two labels ≈ 5 × 4 B × 21.6 M = 430 MB peak in the
  worker. If the worker throws (out of memory), the host retries at 4 ft and
  the card says so. Budget: ≤ 20 s at 2 ft in the node harness, ≤ 6 s at 4 ft.
- Progress in five stages (fill, ponds, pointers, labels, polygons); cancel
  honoured between stages.
- `conduits` absent or empty ⇒ the ground-only map (the "storm drains work"
  switch off). The harness asserts the inlet sinks vanish and everything else
  is consistent.

## 4. Application — `js/drainage.js` → `SBMM.drainage`

- **Command** `DRAIN` (aliases `DRAINAGE`, `CATCH2`? no — `WATERSHEDS`), a
  Water ▾ menu entry "Drainage map", and a button on the raindrop HUD chip
  row. Runs the kernel once per session per switch state (on/off), cached in
  memory; re-runs when the switch or a conduit status changes (debounced,
  with a toast "drainage map is stale — recomputing").
- **Layers** under Site framework behind a sub-header "Drainage (lidar +
  storm drains)": *Catchments — by outlet* (default ON after the first run;
  the row is present from boot and the first tick runs the job), *Catchments
  — by first capture* (ponds and inlets; default off), *Flow paths* (the
  longest path per catchment, thin lines; default off). Polygons are
  translucent fills (opacity 0.28) with a 1.5-px edge, one colour per
  terminal kind and a per-outlet hue: Clear Lake direct (deep blue),
  the storm outfall (`--storm`), the impoundment (its own teal), each pond a
  green, off-survey grey. Labels at the centroid at zoom ≥ 1: name + acres.
- **Hover** brightens the catchment and shows a tooltip "→ {outlet} · {acres}
  ac". **Click** opens `SBMM.popups.forDrainage(label)`: outlet, acres, share
  of the surveyed site, longest flow path, mean slope, "drains through:
  {ponds/inlets on the way}" (from the first-capture chain), and an action
  **"show what drains here"** on any storm structure or pond popup
  (`forStorm`, the water polygon popup, the pond rows of a flow card) that
  highlights every catchment whose chain passes through it and prints the
  total acres in a results card.
- **Results card** "Drainage map": grid, cells, run time, a table of outlets
  with acres and share, sorted by area; copy as CSV; export GeoJSON (both
  layers, every feature carrying `outlet`, `kind`, `acres`, `source:
  "SBMM drainage v14"`); DXF layers `DRAIN-OUTLET`, `DRAIN-FIRST`, `DRAIN-PATH`.
- **3D**: the two polygon layers draped (the same draping the DUs use), the
  flow paths as draped lines. Hover/click through `pick3d` with the same popup.
- **Field build**: runs at 4 ft, the rows exist, the card says "4-ft grid".
- Read-only project analysis: not `SBMM.store` features, nothing serialises;
  the switch state and the "by first capture" choice persist with the layer
  state as usual.

## 5. Acceptance

`test/kernels.mjs`, new section **`drainage`** (the harness greps the
dispatch and will fail until this exists):
- **The identity**: 100 raindrops at fixed pseudo-random surveyed points over
  the site (seeded LCG, listed in the section so they are reproducible), each
  traced by `flowpath` with the same conduits on the same 2-ft site grid,
  chained across windows the way `traceRun` does (mirror it, as the storm
  section mirrors `conduitsFor`): the raindrop's terminal (its `reason` and
  end position mapped to a sink) equals `terminal[drop cell]` for ≥ 97 of
  100; print every disagreement with both answers and the reason. And every
  raindrop's `via` ponds/inlets, in order, are a subsequence of the
  first-capture chain.
- **Named catchments, recorded** (say so): acres draining to the Spot 8 grate,
  to each of the nine grates, into Frog Pond, into Green Pond, into the
  impoundment (direct + through Green Pond's riser), to the outfall
  (= the nine grates' union + the branch + the impoundment's, an identity
  within 0.5 %), direct to Clear Lake, off-survey. Sum of all sinks' cells =
  surveyed cells (identity).
- Frog Pond's and Green Pond's levels in `ponds` equal the raindrop's (1415.74
  via `pond_culvert`; 1394.50 via `green_outlet`) ±0.02; the impoundment's
  1341.54 via `herman_pipe_s`.
- Conduits off: no `inlet` sinks; the impoundment becomes… whatever the
  terrain says (record it: over the rim to the lake).
- Budget: ≤ 20 s at 2 ft, ≤ 6 s at 4 ft; the 4-ft map's outlet areas within
  3 % of the 2-ft map's for every sink over 1 acre (record).

`test/e2e.mjs` block **"9x. drainage"**: `DRAIN` builds the rows and the card
in under 30 s; the by-outlet layer has ≥ 12 polygons; hovering a point inside
the Spot 8 catchment tooltips "Grate inlet — Spot 8"; clicking the outfall
node's "show what drains here" highlights ≥ 10 catchments and prints acres
equal to the outfall row ±0.1; a raindrop at 20 of the harness's points ends
in the catchment under it (≥ 19); toggling `STORM` off re-runs and the inlet
catchments vanish; GeoJSON carries both layers with `outlet` on every
feature; 3D shows the draped polygons (count of tagged objects ≥ 12); alias
collisions 0; session round trip spawns zero jobs. Field e2e: the rows exist,
the card says 4-ft, the run completes in under 30 s on the Pixel 7 profile.
Shots: `test/drainage_shots.mjs` → `drainage_2d.png` (the whole site by
outlet), `drainage_click.png` (the outfall's contributing area highlighted),
`drainage_3d.png`. Look at them.

Every harness on folder, full dist and field dist; golden unchanged.

## 6. Docs

CLAUDE.md (a `drainage.js` code-map row; a "v14 Phase 1 — the drainage map"
section with the definitions and every trap you hit; the harness count), README
(a "Drainage map" section with the recorded acres table), HANDOFF (decision
rows: terrain-only, D8 = the raindrop's physics, the identity test; open item:
Phase 2 waits on the engineer's answers in `V14_CATCHMENT_PROPOSAL.md` §7),
release notes v9.10 (in the existing voice).

## 7. Not in scope

Rainfall, curve numbers, peaks, routing, capacity, a 2D solver. D-infinity
or MFD accumulation. Anything that changes `flowpath` or `overtop`.
