# SBMM Site Explorer — v13: overtopping through conduits, and water in 3D (authoritative)

Owner/decider: the planner. Executor: one agent (W). This document is
the contract; the agent implements what is written here and does not re-decide
it. Where something is not specified, choose the simplest option consistent
with CLAUDE.md and say so in the final report.

Hard constraints (CLAUDE.md): file:// only, plain script-tag JS, kernels in
`js/compute.js` are context-free, three builds, golden Pile 1 unchanged, every
harness passes, browser harnesses one at a time, every refusal toasts, no
model names in the repo. Every v10 §9/§10 and v12 golden stays: this spec adds
to the overtopping result, it does not move the rim spill, the stage table or
the Herman rows.

---------------------------------------------------------------------------

## 0. What the user asked for, in his words

> why does frog pond when i try the overflow tool it goes off to the north of
> the site rather then flowing into green pond and then when green pond
> overflows it goes to the culvert pipe … green pond works great … but frog
> pond still needs to flow into green pond. not up north to the site.

> id love for the all the water overflow and features like raindrop, all to
> work and function in 3d too, i really like the animation you put showing the
> direction of water flowing, that would be great to have in 3d aswel.

## 1. The defect, precisely

`overtop` (js/compute.js) knows nothing about conduits. On Frog Pond it finds
the natural rim spill at **1416.04 ft** at (6,374,410, 2,127,918) — ten feet
from the culvert inlet at Spot 5 (6,374,418, 2,127,912), whose rim is
**1415.74 ft** — and the host traces the overflow route from the spill's
`next` cell (6,374,410, 2,127,920), which lies outside the culvert's 3-ft
capture disc, so the route runs north over the ground. The raindrop gets it
right because `flowpath` has the conduit rule; the overtopping tool does not.
Green Pond: natural spill 1399.14 ft on its south side against the FES rim of
1394.48 ft; the same defect, hidden because the raindrop is what he tried.

## 2. Definitions added to the overtopping analysis

- **Conduit spill.** `overtop` takes `conduits` and `captureFt` exactly as
  `flowpath` does (same flat record `{id, ix, iy, rim, ox, oy, next, len,
  mouth_moved_ft}`, same capture index). During the sealed inside-out flood,
  when a flooded cell is a capture cell and the current level `cur >= rim`
  (track submerged inlets whose rim is still above `cur`, re-test as `cur`
  rises, as `flowpath` does), the FIRST such inlet is recorded as
  `conduitSpill = { id, level: rim, x, y, cell, outlet:[ox,oy] }`. The flood
  **continues unchanged**: the rim spill, `primary`, `clusters`, `band`,
  `spillMask`, `freeboard_ft`, `storage_ft3` and the 0.25-ft `stage` buckets
  are exactly what they are today. Do NOT seed `fillDem` here (that is the
  `flowpath` rule); `overtop`'s `F` is untouched, so every §9.2/§10 number is
  untouched.
- **Stage row for the conduit.** One `extra: true` row at `conduitSpill.level`
  with `via: id`, computed by the same direct pass the §10 `levels` rows use.
  If a surveyed `levels` row lies within 0.1 ft of it, the surveyed row wins,
  gains `via`, and no second row is added (Herman: the surveyed 1341.55 row
  gains `via: "herman_pipe_s"`; the kernel's 1341.5x is not shown twice).
- **Freeboard to first discharge**: `freeboardConduit_ft = conduitSpill.level −
  z0` beside the existing rim `freeboard_ft`.
- **Conduit route** (host): a raindrop dropped ON `conduitSpill` (its kernel
  cell) with the network on and `blockRing` = the water body, so its first leg
  is the conduit and it continues down the chain. Named
  `"{name} first-discharge route ({conduit label})"`. For Herman this is the
  same thing today's `pipe discharge route` is; keep ONE route — when
  `facts.outlet` exists and the conduit spill is the surveyed pipe (within
  0.1 ft), the surveyed route stands and the kernel's is not traced again.
- **Card**: a "First discharge" row ABOVE "Rim spill": `"through {conduit label}
  at {level} ft · +{level − z0} ft · {storage} ac-ft"` (storage from the
  conduit stage row), and the rim spill row keeps its wording. The level
  slider snaps onto the conduit row like it does the surveyed rows; below the
  conduit level neither route shows, from the conduit level the conduit route
  shows, from the rim spill the rim route shows too. A 2D marker at the
  conduit spill (badge "C", like the pipe badge "P").
- **With the network off** the analysis is bit-identical to today's (the
  harness asserts it on Herman and Frog Pond).

Expected, and to be recorded: Frog Pond — first discharge via `pond_culvert`
at 1415.74 (+0.74), rim spill 1416.04 (+1.04) unchanged, first-discharge route
= pond_culvert → Green Pond → green_outlet → the road drain → outfall → Clear
Lake. Green Pond — via `green_outlet` at 1394.48 (+2.88), rim spill 1399.14
unchanged. Herman — `via: herman_pipe_s` on the surveyed 1341.55 row, nothing
else changes.

## 3. Water in 3D

The 3D view (`js/viewer3d.js`) already drapes a flow's polyline, its pond
rings and its conduit legs, and drapes the rim band through `drapeSpec()`.
What it lacks is the motion, and the overtopping analysis's stage.

### 3.1 The animated flow (the thing he asked for)

- Every visible `flow` feature gets a **particle stream**: one `THREE.Points`
  (or sprites) per feature, particles spaced ~20 ft along the arc length of
  each overland stretch, advancing at a constant ground speed (~40 ft/s in
  model units, so a 1,000-ft run is 25 s), draped at the terrain plus a small
  lift, in the water colour (`0x55C1FF`, brighter and larger when the feature
  is selected). Conduit legs get their own particles in the storm colour
  (`--storm`, `0x7FA7C9`) moving inlet → outlet along the straight leg, so the
  pipe visibly carries the water underground.
- Implementation rules: precompute each stretch's cumulative arc length and
  draped z once per overlay rebuild (no per-frame allocation, no per-frame
  `drapeZ`); advance a per-particle parameter in the render loop; while any
  flow is visible and the 3D view is open the loop requests frames at ~30 fps
  through the existing on-demand render path (`requestRender`), and stops
  requesting when none is visible — `test/perf.mjs`'s idle-render count must
  stay 0 with no flow on screen.
- A toolbar toggle **"animate water"** (default on; remembered in the same
  localStorage the 3D prefs use) and the `FIELD` build leaves it on (particles
  are cheap; the terrain is the cost).

### 3.2 The overtopping stage in 3D (and 2D)

- The kernel's `stage` rows gain `rings` (the outline(s) of the flooded area at
  that level, from `maskRings` over `level[k] <= L`), so a water surface can be
  drawn at any stage row. Simplify with the existing ring-aware simplify at
  half a cell.
- 3D draws the **water surface at the slider level** as a translucent blue
  filled polygon (`THREE.ShapeGeometry`, holes honoured) at `z = L − ZMID`,
  updated when the slider moves (`applyLevel` calls into the viewer), plus a
  labelled sprite at each rim low ("rim low 1 · 1343.84 ft") and at the
  conduit spill and pipe marker, and the routes as flows (they already are).
- 2D draws the same polygon as a light fill in the `water` pane (SVG, like the
  flow line), under the rim band, following the slider. The band raster and
  the legend are unchanged.
- `refreshDrapes()` stays the hook for the rim band; the stage surface is an
  overlay object owned by the water module through a small
  `SBMM.viewer3d.setWaterStage(spec|null)` (`{rings, level}`), so closing the
  analysis clears it.

### 3.3 Picking

The particle stream and the stage surface are not pickable; the flow's own
draped line stays the pick target (registry unchanged).

## 4. Acceptance

`test/kernels.mjs`:
- `overtop` on Frog Pond with the real network (mirror `SBMM.storm.conduitsFor`
  the way the storm section does): `conduitSpill.id === "pond_culvert"`,
  `level` 1415.74 ±0.05, `primary.level` 1416.04 ±0.05 and every other field
  identical to the no-conduit run (identity, field by field: primary, clusters,
  band bytes, stage levels/areas/storage apart from the one extra row).
- Green Pond: `via green_outlet` at 1394.48 ±0.05; `primary` 1399.14 ±0.05.
- Herman (§9.2 window, surveyed `levels` as §10): all §9.2/§10 checks pass
  unchanged; the 1341.55 row carries `via: "herman_pipe_s"`; no duplicate row.
- `stage[i].rings` exist, are closed, and the ring area at the rim spill row
  equals `area_ft2` within 2 %.
- With `conduits: []` and absent: bit-identical to today (band, stage, primary).

`test/e2e.mjs` block **"9t. overtop + conduits"**: `OVERTOP` on Frog Pond →
card "First discharge through … pond_culvert … 1,415.74"; the first-discharge
route's legs begin with `pond_culvert` and end at the outfall (reason nodata
near E 6,371,177 N 2,127,474), and it does NOT end north (assert the end's
northing < 2,128,000); the rim route still exists and is unchanged. Green Pond
likewise via `green_outlet`. Herman card unchanged (the §10 assertions stay
verbatim) and shows `via herman_pipe_s` on the pipe row. Slider: below the
conduit level no route visible; at it the conduit route visible. 3D: open 3D
with a flow on screen → over 1 s `renderCount` increases by ≥ 15 and the
feature's particle object exists with n ≥ 10; delete the flow → no renders in
the next second; with the overtop analysis open the stage surface mesh exists
at `level − ZMID` ±0.01 and moves when the slider is set to another row; the
toggle off stops the frames. Field e2e: the toggle exists and the 3D still
opens. Shots: `test/water_shots.mjs` gains `frog_overtop_2d.png` and
`frog_overtop_3d.png` (the culvert route into Green Pond, the stage surface).

Every harness on folder, full dist and field dist; golden unchanged.

## 5. Docs

CLAUDE.md (a "v13" section: the conduit spill definition, the 3D particle
rules, the stage rings), README (the overtopping section: first discharge
row; a "Water in 3D" paragraph), HANDOFF (decision rows; open item: the
overtopping tool now honours conduits — the raindrop and the overtopping
analysis agree on Frog Pond and Green Pond as they do on Herman), release
notes v9.9. V12 spec: a one-line pointer to this file under §2.

## 6. Not in scope

Rainfall, catchments, runoff, pipe capacity (a separate proposal,
`docs/V14_CATCHMENT_PROPOSAL.md`). Do not touch `flowpath`'s behaviour.
