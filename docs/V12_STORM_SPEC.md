# SBMM Site Explorer — v12 storm-drainage specification (authoritative)

Owner/decider: Fable (planner). Executor: one Opus agent (S). This document is
the contract: the agent implements what is written here and does not
re-decide it. Where something is not specified, choose the simplest option
consistent with CLAUDE.md and say so in the final report.

Hard constraints (CLAUDE.md): file:// only, plain script-tag JS, kernels in
`js/compute.js` are context-free, three builds (folder, full dist, field
dist), golden Pile 1 unchanged, every harness passes, browser harnesses one at
a time, every refusal raises a `toast()`. Nothing here is hydraulics: no
rainfall, no runoff, no pipe capacity, no time. A conduit is a **topological
shortcut with an elevation at each end**, and the cards say so.

---------------------------------------------------------------------------

## 0. What the user asked for, in his words

> those two pipes that we just imported in from the survey … if you see the
> layers in the cad files … you can see those pipes that connect to that
> outlet we surveyed … assume for now that they do work

> the frog and green pond … there is a culvert that runs along those top of
> grates that show up in "other/uncategorised" layer and also in the Block
> symbols which has the squares for the top of the grates and then it
> connects with that line that goes out to clearlake … make sure that you
> understand that frog and green pond are connected via pipe. so if they
> overflow you know where they go now … you didnt connect the discharge
> pipe from herman impoundment that we surveyed to the discharge pipes

He also gave thirteen spots (Spot 5 … Spot 17) that trace the line: Frog
Pond west shore → Green Pond east shore → the nine grate inlets along the
south side of the Herman Impoundment → the start of EA's drawn branch line.

## 1. What is in the CAD, and what the network is

Everything below was read out of `data/design/cad_native.json` (EA's
V-Base.dwg) and `data/design_gis.json` (the 33 `Storm structure` points of
the `util` layer, which `tools/build_design_gis.py` took from the
`V-STRM-STRC` block INSERTs). The blocks' own geometry sits on layer `0`
under the names **`STRM FES`** (flared end section — a culvert or pipe end,
23 of them), **`STRM INLET SQUARE`** (a grate drop inlet, 9) and
**`STRM INLET ROUND`** (1). Six short two-point lines on `V-STRM-MRKG`, each
across a `V-ROAD-GRVL` embankment between two FES, are culvert marks. The
storm line itself is on `V-STRM-STRC` (`E943C/D/E`, one 783-ft run drawn as
a double line with a centreline, plus `E943F/E9440` the 145-ft branch and
`E9441–E9444` on the same alignment). EA's CAD carries **no inverts, no
diameters, no materials** anywhere on this system; the only surveyed inverts
are Jacobs' two 24-in HDPE pipes at the sandbag wall (1341.57 / 1341.53 ft).

The network, upstream to downstream (all coordinates EPSG:6418 ft):

| id | from | to | source | note |
|---|---|---|---|---|
| `pond_culvert` | Frog Pond (the EAST pond) west shore, Spot 5 (6374418, 2127912) — **inferred node** | Spot 1 (6374343, 2127914) — **inferred node**, 75 ft west under the paved road; discharges overland into Green Pond (the west pond) | the engineer (Sep 2026) | the culvert between the two ponds; inverts unknown |
| `green_outlet` | `STRM FES` on Green Pond's west shore (6373928.8, 2127878.1) | grate Spot 8 (6373831.3, 2127919.1) | EA's FES + the engineer; **inferred line** | Green Pond's overflow, 106 ft, piped under the road into the road drain — not into the impoundment |
| `green_riser` | `STRM INLET ROUND` at Green Pond's NW corner (6373917.1, 2127966.3) | `STRM FES` (6373859.1, 2127987.9), discharging toward Herman | CAD culvert mark `E5D2D` (62 ft under the gravel road) | the pond's HIGH-LEVEL overflow: only water above the round inlet's rim goes to Herman |
| `road_drain_1..8` | grate Spot 8 (6373831.3, 2127919.1) → Spot 9 (6373657.8, 2127751.0) → 10 (6373483.9, 2127666.5) → 11 (6373149.3, 2127447.4) → 12 (6372938.3, 2127429.4) → 13 (6372790.9, 2127435.7) → 14 (6372491.9, 2127398.4) → 15 (6372095.0, 2127351.9) | the next grate | CAD structures; **alignment inferred straight between structures — EA drew no line here** | the culvert "along the top of the grates", 2,090 ft; one conduit per pair so a survey can fill inverts one by one |
| `road_drain_9` | grate Spot 15 | branch start (6371958.6, 2127426.4), a bend node with no structure | inferred straight | 157 ft |
| `branch` | branch start | junction grate `STRM INLET SQUARE` (6371825.8, 2127494.2) | CAD line `E943F` | 145 ft |
| `herman_pipe_n`, `herman_pipe_s` | the surveyed inverts at the wall (6372041.23, 2127486.62) / (6372041.79, 2127483.07), invert 1341.57 / 1341.53 | the plotted west ends (6372025.33, 2127481.72) / (6372025.85, 2127478.79) | Jacobs survey Aug 2026 (`data/survey_2026.json`) | 24 in corrugated HDPE, two barrels |
| `pipe_to_main` | the North pipe's plotted west end | the drawn storm line's east end (6372013.4, 2127476.1) | **inferred**: EA's line starts 13 ft west of the plotted pipe end | the connection the user asked for |
| `storm_main_upper` | storm line east end | junction grate | CAD `E943C` vertices from its east end to the junction | ~200 ft |
| `storm_main_lower` | junction grate | Clear Lake outfall (6371273.0, 2127487.9) — `outfall` node | CAD `E943C` vertices from the junction west | ~590 ft; the outfall is the end of the drawn line at the shore |
| `south_culvert` | `STRM FES` (6372740.6, 2127345.2) | `STRM FES` (6372717.9, 2127378.2) | CAD mark `E5D2E`, 40 ft under the south road | drains the ditch south of the road into Herman; not part of the grate chain |
| `culvert_*` | FES | FES | the other four `V-STRM-MRKG` marks (`E5D2B`, `E5D2C`, `E5D2F`, `E5D30`) and every pair of FES within 40 ft of each other with no mark | direction = downhill by lidar ground at the two ends |
| `lot25_yard` | catch basin (6370523.8, 2129507.2) | the pipe's west end (6370394.0, 2129568.2) | CAD `C-STRM-MAIN-PIPE` `378C6` (C-BASE, 171 ft) | the residential yard drain at Lot 25, unrelated to Herman |

Direction rule: a conduit's `from` is upstream. For the chain, `branch`,
`storm_main_*`, `pipe_to_main` and the pipes it is fixed by the user's
description and by the ground (1397 → 1352 → 1340 → 1333 ft). For every
other pair it is the higher lidar ground end → the lower.

Revised 2026-09-04 by the engineer ("i think there was some confusion"): flow goes
from Frog Pond (east) to Green Pond (west) through the culvert under the paved road
(Spot 5 → Spot 1); when Green Pond overflows it leaves through the FES on its west
shore to the Spot 8 grate and the road drain, and it does not overflow into the
impoundment; the round inlet at the pond's corner is the high-level overflow that
takes water under the road to Herman only if the pond gets that high. **Naming.** EA's geodatabase `water` layer has it right, and the engineer confirmed it (Sep 2026): **Frog Pond is the east pond** (E 6,374,450–6,374,726, floor 1,415 ft) and **Green Pond the west pond** (E 6,373,925–6,374,152, floor 1,391.6 ft). The storm network uses those names.

What the lidar says without the pipes: a raindrop at every one of the nine grates
runs overland into the impoundment or stays in the road ditch; the west pond's low
(1391.6 ft) fills 11.8 ft and spills over its own rim toward the round inlet's
basin; the east pond's low (1415 ft) spills north-east off the survey. With the
pipes assumed working the engineer's picture appears, and the difference between
the two answers is exactly the inverts he is going to survey.

## 2. Definitions (the accuracy contract)

- **Node**: a point with `kind ∈ {grate, round_inlet, fes, pipe_end,
  bend, junction, outfall, inferred}`, `x, y`, and two elevations: `rim_ft`
  (the lidar ground at the point, computed by the app on boot through
  `SBMM.elev`, never baked, so it follows the DEM stack) and `invert_ft`
  (surveyed or `null`). The two surveyed pipe nodes carry their inverts; no
  other node does yet.
- **Conduit**: `from` node → `to` node, `pts` (the alignment, straight or the
  CAD vertices), `length_ft` (from `pts`), `size_in`, `material`, `source ∈
  {cad_line, cad_mark, cad_pair, structures_chain, survey, inferred}`,
  `cad_handles`, `provenance`, and `status ∈ {assumed_working, broken}`
  (default `assumed_working`; the user said to assume they work).
- **Inlet**: the `from` node of a conduit whose kind is `grate`,
  `round_inlet` or `inferred` (Frog Pond's culvert end), or `pipe_end` for the
  surveyed pipes. Its **capture** is every cell within `captureFt` (default
  3 ft) of the node. An `fes` is never an inlet unless a conduit starts
  there (the `south_culvert` and the other culverts do, from their uphill
  FES).
- **Rim for the kernel**: `invert_ft` if surveyed else `rim_ft` (ground).
  Never invent a depth.
- **A sunken inlet** (ruling, 2026-09-04). The lidar is the January-2024
  flight. The sandbag wall and the two 24-in discharge pipes were surveyed in
  August 2026 and were built into a regraded channel the lidar never saw,
  which is why the 1-ft cells at the surveyed invert points read 1344.66 /
  1344.80 ft — that is the top of the sandbags. **An inlet whose surveyed
  `invert_ft` lies below the lidar ground at its own cell is a pipe mouth the
  lidar did not see, and it is connected to the water it was built to drain.**
  For such an inlet the point handed to the kernel (`ix, iy`) is the **nearest
  DEM cell at or below the invert within 30 ft** of the surveyed point; `rim`
  stays the surveyed invert; and the conduit record carries `mouth_moved_ft`
  so the popup and the card can say "inlet cell moved 25.6 ft to the channel
  floor the lidar sees". If no such cell is found within 30 ft the inlet stays
  where it was surveyed and the popup says that instead. This is a HOST rule —
  `SBMM.storm.conduitsFor`, mirrored in the harness's flattening — and needs
  no kernel change: the pond rule below then stops the Herman pond at the
  invert. `kind: "pipe_end"` with a non-null `invert_ft` is the only case
  today (it fires twice), but the rule is general: any inlet whose invert is
  below its ground.
- **The shortcut rule** (kernel): descent arriving on an inlet's capture
  cells leaves the ground: the run gains a **conduit leg** from the inlet to
  the conduit's `to` node (and on through any conduit that starts at that
  node, transitively, each conduit at most once per run) and continues by
  ordinary descent from the last outlet. A `to` node outside the current
  window ends the window with `reason: "conduit"` and `exit` = that node;
  the host re-centres there exactly as it does for `"window"`.
- **The pond rule** (kernel): an inlet inside a filling depression is a pour
  point at its rim. During the priority flood, the moment the rising level
  reaches an inlet cell's rim (the cell's own z, or the surveyed invert where
  one exists), the flood stops with the pond's `level` = that rim and its
  outlet is the conduit. Completion (every cell under the level) runs as
  now. A pond with a natural pour point lower than every inlet in it spills
  over the ground, as now.
- **An inlet is a sink in the filled DEM** (added 2026-09-04). `fillDem` is
  seeded with every capture cell at its conduit's rim (`F = max(z, rim)`), so
  the escape test knows a depression drained by a grate. Only when conduits are
  present; the no-conduit fill is unchanged to the bit. Without it a flood that
  arrives in one lobe of a two-lobe pond takes both lobes to the saddle before
  it finds the inlet in the other (Green Pond: 1,402.44 instead of 1,394.50).
- **A blocked pond** (the Herman ring in the overflow/pipe routes) keeps
  its rule: a route arriving in it ends there.
- **Disabled**: a conduit with `status: "broken"`, or the whole network when
  the "storm drains work" switch is off, is not passed to the kernel at all,
  so the analysis is exactly today's ground-only one. Ponds still form,
  grates are just ground.
- **Windows**: unchanged (§2 of the v10 spec). Conduits whose `from` node
  lies inside the window are passed; their `to` may be anywhere.

## 3. Data — `tools/build_storm_network.py` → `data/storm_network.json` → `datajs/d_storm_network.js`

Written by the planner before the agent starts (it is the judgement-heavy
part). The agent adds `"storm_network"` to `JSON_FILES` in
`tools/build_data.py`, the `<script src="datajs/d_storm_network.js">` tag
after `d_survey_2026.js` in `index.html`, and keeps it **in the field
build** (it is ~30 kB). Schema:

```
{ source, crs, built,
  nodes:    [{ id, kind, x, y, name, invert_ft|null, size_in|null, cad_block|null,
               cad_handle|null, provenance, note|null }],
  conduits: [{ id, from, to, pts:[[x,y],...], length_ft, size_in|null, material|null,
               source, cad_handles:[...], provenance, note|null, status }],
  layers:   [{ key, name, group:"storm", color, kind, count, provenance }]  // design_gis style
}
```

## 4. Kernel — `flowpath` gains `conduits` (js/compute.js, api VERSION 6)

`job.conduits = [{ id, ix, iy, rim, ox, oy, next }]` — inlet x/y, rim
elevation, outlet x/y, and `next` = the id of the conduit that starts at the
outlet node or null (the host flattens the graph so the kernel never needs
the node table). `job.captureFt` (default 3). Both optional: absent = today's
kernel to the bit (the harness asserts this on the §9.1 raindrop).

Implementation notes, which are rulings:
- Build `inletAt: Int32Array(n)` (−1 or conduit index) once, from the cells
  within `captureFt` of each inlet inside the window.
- Descent: after every move, `if (inletAt[cur] >= 0)` → follow the conduit
  chain: append a leg record `{ id, from:[x,y,z], to:[x,y,z], length_ft }`,
  mark the conduit used, and set `cur` to the outlet cell if it is inside
  the window; otherwise `reason = "conduit"`, `exit = [ox, oy]`, stop.
- Flood: when a popped cell has `inletAt >= 0` and `level >= rim`, the pond
  stops there: `outlet = that cell`, `via = conduit`. Track submerged inlets
  with `rim > level` and re-test them whenever `level` rises. Completion runs
  as now. After completion, `cur` follows the conduit as in descent.
- Output adds `legs: [...]` and `pipe_ft` (sum of leg lengths, NOT included
  in `length_ft`, which stays the overland length), and the vertex index
  where each leg starts (`legs[i].at`, into the simplified `pts`). Simplify
  each overland stretch separately so the inlet and outlet vertices survive.
- Effective elevation of a pond that drained through a conduit is its
  level, as for any pond. `fillDem`'s `F` is unchanged (a documented
  second-order effect: a depression drained by a grate still looks full to a
  neighbouring flood's escape test).

`overtop` and `catchment` are unchanged. The Herman pipe discharge route is a
raindrop dropped at the North pipe's plotted west end; that node is the inlet
of `pipe_to_main`, so with the network on the route reads pipes → storm main
→ outfall, and its card row says how far of it is in pipe.

## 5. Application

### 5.1 `js/storm.js` → `SBMM.storm` (modelled on `js/survey.js`)

- Reads `SBMM_DATA.storm_network`; boots without it (`console.warn`, every
  entry point returns empty / toasts).
- On boot computes `rim_ft` for every node from `SBMM.elev` (after
  `SBMM.dems` exist) and `fall_ft` for every conduit (rim/invert at `from`
  minus at `to`).
- Layers, under **Site framework** behind a sub-header "Storm drainage —
  EA CAD + Jacobs survey", three rows, default ON: *Storm structures (33)*,
  *Storm conduits — drawn in CAD (n)*, *Storm conduits — inferred (n)*.
  Structures: a small square glyph for a grate, a circle for the round
  inlet, a flared triangle for an FES, a hollow diamond for an inferred
  node, an outfall as a bar; conduits: a 2.5-px line with an arrowhead at
  the outlet, solid for CAD, dashed for inferred, both in one storm colour
  (`--storm`, a steel blue distinct from the water blue), and a red hatch
  when `status: "broken"`. Tooltips name the node/conduit; popups through a
  new `SBMM.popups.forStorm(node|conduit)` carry kind, provenance, rim
  (labelled "ground (lidar)"), invert ("not surveyed" when null), length,
  from → to, fall, size/material where known, status, and a **"broken /
  working" toggle** per conduit persisted in `localStorage["sbmm.storm.v1"]`.
- A master switch **"storm drains work"** (`SBMM.storm.enabled()`), default
  on, in the Water ▾ menu and on the raindrop mode HUD as a chip; the
  `STORM` command toggles it; persisted. Off = ground-only analyses.
- `SBMM.storm.conduitsFor(bbox)` → the kernel list for conduits whose `from`
  is inside `bbox`, `status` working, switch on; `[]` otherwise.
- 3D drape (lines + point sprites, same colour), osnap (nodes as points,
  conduits as paths), GeoJSON (`SBMM.io`) and DXF (`STORM-STRUCT`,
  `STORM-CONDUIT`, `STORM-INFERRED`) exports, Layer manager untouched.
- Field build: included; the rows and the switch work in field mode.

### 5.2 `js/water.js`

- `traceRun` passes `conduits: SBMM.storm.conduitsFor(win)` and
  `captureFt`; handles `reason: "conduit"` like `"window"` (re-centre on the
  outlet, count a hop). Legs accumulate in `props.legs` with the conduit id,
  name, length; `props.pipe_ft`; `props.length_ft` stays overland;
  `props.total_ft = length_ft + pipe_ft`; `props.storm = true|false` records
  whether the network was on.
- Rendering (`buildFlow`): overland stretches exactly as now (the animated
  SVG dash); each conduit leg as a straight dashed line in `--storm` with a
  small "in pipe" label at its midpoint at zoom ≥ 2, and a hollow marker at
  the inlet. In 3D the leg is a straight tube at the rim elevations.
- Card rows: "In pipes" (`pipe_ft`, the conduit names), "Total" when
  `pipe_ft > 0`, and a note line "storm drains assumed working (STORM to
  toggle)" or "ground only". A pond whose outlet is a conduit says so in its
  row ("drains to grate Spot 8 at 1397.4 ft").
- Herman card: the "Pipe discharge route" row becomes
  `"{total} ft · {pipe_ft} ft in pipe · Clear Lake outfall"` when the route
  ends at the outfall node; the route feature is named "… pipe discharge
  route (storm main)".
- `mkFlow` rebuilds legs from props and **never recomputes** (session
  round-trip spawns zero jobs; the e2e asserts it).

### 5.3 Docs

CLAUDE.md (a `storm.js` row, a "v12 storm drainage" section with the
definitions above, api VERSION 6), README ("Storm drainage" section with the
table of §1), HANDOFF (decision rows: assumed working, inferred alignments,
no inverts; open item: the manhole/invert survey and how to load it —
`tools/build_storm_network.py` reads an optional `data/storm_survey.csv`
of `id, invert_ft, rim_ft, size_in, material` and overrides), release notes
v9.8.

## 6. Acceptance

`test/kernels.mjs`, new section **`storm`** (the harness greps `runJob`'s
dispatch; `flowpath` is covered, this section covers its `conduits` path):
- The §9.1 raindrop with `conduits: []` and with the option absent gives
  bit-identical `pts`, `ponds`, `reason` (identity).
- A synthetic basin (a paraboloid pit with a natural pour point at +6 ft)
  with an inlet cell at +2 ft inside it and an outlet on the far slope: the
  pond level = the inlet rim ±1e-6, `legs.length === 1`, the run continues
  from the outlet, `pipe_ft` = the straight distance (identity).
- A slope with an inlet at 20 ft downhill of the drop: the run has one leg
  starting within `captureFt` of the inlet.
- An outlet outside the window: `reason === "conduit"`, `exit` = the outlet.
- Real network (`data/storm_network.json` through the same flattening the
  host does — mirror `SBMM.storm.conduitsFor` in the harness): a drop at
  the Spot 8 grate reaches the outfall node with `pipe_ft` = the chain's
  summed length ±0.5 ft and ends by overland descent at Clear Lake NoData
  near E 6,371,177 N 2,127,474; a drop at Frog Pond's low (the east pond, Spot 5)
  takes `pond_culvert`, fills Green Pond to its FES rim, takes `green_outlet` and
  the road drain and reaches the outfall; the same two drops with the network
  off reproduce today's answers (Herman / off the survey). Record the
  numbers as regression guards and say they were recorded.

`test/e2e.mjs`, block **"9v. storm"**: the three rows exist with the right
counts; a grate popup names `STRM INLET SQUARE` and EA's CAD; `DROP` at
Frog Pond's low creates a `flow` with `legs.length >= 2` ending near the
lake and the card shows "In pipes"; `STORM` off → the same drop ends off the
survey with no legs; the Herman analysis's pipe discharge route row reads
"in pipe" and the route ends at the outfall; a session round-trip restores
the legs with zero compute jobs; the 3D view shows the conduits (count of
tagged objects); GeoJSON export carries the network with `source` on every
feature; alias collisions 0. Field e2e: the rows and the switch exist.

Shots: `test/storm_shots.mjs` → `storm_2d.png` (the south-road chain with a
Frog Pond raindrop on it), `storm_3d.png`. Look at them.

Every harness passes on folder, full dist and field dist; golden unchanged.

## 7. Not in scope

Pipe capacity, HGL, surcharge, inlet efficiency, time of concentration,
rainfall — all of it waits for the invert survey and is a separate spec. Do
not compute a Manning flow from an assumed diameter. Do not shift EA's
structures to "fix" a 5-ft double-line offset. Do not make the network a
`SBMM.store` feature: it is read-only project data like the survey.
