# SBMM Site Explorer — v22: the three pipes, the overflow that follows them, the desktop 3D, and "where does the water go" (authoritative)

Owner/decider: the planner. Executors: agents S (storm + overflow), C (catchments),
G (graphics), in that order, one at a time. Decided by the engineer 2026-09-06 after
using the app on the desktop and the phone. Hard constraints as in CLAUDE.md: `file://`,
no `fetch`, the three builds, every golden stays unless a ruling below moves it (and
then the harness is re-recorded WITH the reason, never silently). The runner is how
the matrix runs; `docs/AGENT_RULES.md` applies.

`docs/STATUS_v22.md` is the resumable checklist for this round: the planner's usage
budget may run out mid-round, and a fresh session continues from that file.

---------------------------------------------------------------------------

## S. The Herman discharge pipes do NOT merge — three pipes lie in one trench (ruling)

**The engineer (2026-09-06):** "the two overflow outlets that you have merging into
one, that's not the case, we have two pipes that run in parallel with each other that
take the overflow from the two overflow pipes out to Clear Lake … there are three pipes
that flow along that channel, the two for the Herman impoundment and one that is used
by the Frog and Green pond overflow — that's the far south one, which you have solved."

**The CAD agrees, and the network builder misread it.** `data/design/cad_native.json`,
layer `V-STRM-STRC`, from the sandbag wall to the Clear Lake shore:

| handle | vertices | length | east end (E, N) | west end (E, N) |
|---|---|---|---|---|
| E943E (north) | 22 | 783.9 ft | 6372012.9, 2127478.4 | 6371271.6, 2127489.8 |
| E943C (middle) | 22 | 783.0 ft | 6372013.4, 2127476.1 | 6371273.0, 2127487.9 |
| E943D (south) | 22 | 782.0 ft | 6372014.0, 2127473.7 | 6371274.4, 2127485.9 |

The three are **2.35 ft apart** — the outside diameter of 24-in corrugated HDPE (~28 in).
`tools/build_storm_network.py` took them for "a 24-in double line with a centreline"
(one pipe) and built `storm_main_upper/lower` on E943C alone, with BOTH surveyed barrels
joined into it through `pipe_to_main` / `pipe_to_main_s`. A 24-in double line would be
2.0 ft wide in total; this trench is 4.7 ft wide. Three pipes, side by side.

Which is which: the North barrel's plotted west end (6372025.3, 2127481.7) is 12.8 ft
from E943E's east end; the South barrel's (6372025.8, 2127478.8) is 12.7 ft from E943C's.
The road drain's branch (E943F / E9440, a double line 2.6 ft wide, 145 ft) arrives at the
`junction` grate 190 ft west of the wall, which leaves **E943D for the Frog/Green road
drain** — the engineer's "far south one". Everything the engineer said matches the
drawing.

**Rebuild the network (`tools/build_storm_network.py` → `data/storm_network.json` →
`datajs/d_storm_network.js`):**

- `herman_main_n`: `herman_pipe_n_end` → `outfall`, geometry = the 12.8 ft inferred gap
  + E943E verbatim, `size_in: 24`, `source: "cad_line"`, handles `["E943E"]`, and the
  gap noted as inferred (as `pipe_to_main`'s note does today).
- `herman_main_s`: `herman_pipe_s_end` → `outfall`, the 12.7 ft gap + E943C verbatim.
- `storm_main_upper` / `storm_main_lower` move to **E943D** (split at the junction as
  today). Nothing feeds `storm_main_upper` any more — keep it, drawn, as the CAD draws
  it, with a note saying so; the road drain's chain is `… → branch → junction →
  storm_main_lower → outfall`, unchanged in ids.
- `pipe_to_main` and `pipe_to_main_s` are **gone**. `storm_main_east` is gone.
- **ONE `outfall` node**, where the three west ends meet (they are within 2.9 ft of
  each other; put it at E943C's west end, as today). All three conduits end there.
  This is deliberate: the drainage map labels by outlet, and one outfall keeps
  *Clear Lake outfall (storm network)* one catchment (281.99 ac) and the §11.8
  accumulation identity untouched. Three outfall nodes would split a number the
  engineer already reads.
- The dog-leg E9441/E9442 → E9443/E9444 (a double line from the junction north-west then
  south-west to the shore) is NOT in the network today and stays out; record it in the
  builder's notes as "drawn, purpose not established — ask EA" rather than guessing.
- Counts become 44 → **42 nodes** (`storm_main_east` gone; check) and 27 → **27
  conduits** (two removed, two added). Say the real numbers in the docs.

**What moves, and what must not:**

- The raindrop out of the impoundment: `herman_pipe_s` (16.5) → `herman_main_s`
  (12.7 + 783.0) = **812.2 ft** in pipe, from 812.8. The chain ids in `test/e2e.mjs`
  blocks 9t/9v and `test/kernels.mjs` `storm`/`water3d` change accordingly; re-record.
- `pipeChainRoute()`: the spine is the South chain (lower invert), the North chain is
  a `parallel: true` leg for its WHOLE length now, not 13 ft. `parallelBarrels()`
  and `firstDischargeWords()` ("through the two 24-in pipes") must still say two
  pipes; `chainSentence` should read "→ two 24-in pipes → Clear Lake outfall".
- Drainage map: `through_area` of `herman_pipe_s` (37.90 ac), the three outlet areas
  and the 100/100 identity are unchanged by construction (same inlets, same outfall
  cell). Assert that explicitly in the harness — it is the proof the rebuild is right.
- Every `pipe_ft` / label that named the storm main for Herman's water (popups, cards,
  README, HANDOFF, CLAUDE.md v12/v13 sections) is updated. The v12 paragraph that
  explains the one-conduit-per-barrel decision is rewritten to this ruling.

## R. The overflow follows the pipes, and the rim overflow appears when the slider reaches the rim

Two things the engineer saw in the overtopping analysis (his screenshot, the pipe
discharge route at 1,341.55 "discharging"):

1. **A pipe leg is drawn as a straight line between its two nodes**, so the route
   leaves the drawn pipe wherever the CAD bends, and looks like "its own flow". Every
   conduit leg — 2D (`js/water.js` `buildFlow` (c2)), 3D (the un-draped tube in
   `js/viewer3d.js`) and the particle stream — must follow the conduit's OWN
   polyline (`SBMM.storm.conduit(id).pts`, EA's CAD geometry), start to end. The
   kernel's leg record does not change (it carries ids); the host looks the geometry
   up. The "in pipe · N ft" label sits at the polyline's midpoint by length.
2. **The rule of the slider (replaces v15's "rim on request"):**
   - below the first conduit invert: no route;
   - from the conduit level up: the pipe discharge route (the chain of §S, both
     barrels, animated), exactly as now;
   - **from the rim spill level up: the rim overflow raindrop is traced automatically
     and shown BESIDE the pipe route**, from the rim spill cell, on the analysis's own
     grid and window, blocked from re-entering the water body, with the storm network
     ON (a raindrop over the rim may well meet the road drain). It is a normal `flow`
     (solid, animated, not the dashed what-if), captioned "over the rim at 1,343.84 ft";
     it disappears again when the slider drops below the rim. The what-if button stays
     for the drains-blocked question, drawn dashed as today.
   - 3D: the stage surface and both routes; the particle stream runs on both.
   - `SBMM.water.routes()` gains `rimAuto`; e2e 9t asserts the three slider states on
     Herman (below invert / above invert / above rim) and that the rim route's first
     vertex is the spill cell.

## G. The desktop 3D: hitching while moving, and a pixelated drape (measured, not felt)

The engineer: "graphics are rendering a bit slow when I move around … the entire site
topo looks a bit pixelated when zooming in … seems like the desktop isn't taking full
advantage of the GPU". Two causes are already visible in the code:

- **The drape is at the DEM tile's own level.** `orthoRef()` in `js/terrain3d.js`
  takes the ortho tile at the same `z` as the terrain tile (or coarser). At the
  default `std` quality most of the view is 4–8 ft tiles, so the imagery is drawn at
  4–8 ft per pixel — the old whole-DEM drape was 0.25 ft/px over the mine window
  (178 MP). That is the pixelation. Rule: **the drape level is chosen by a TEXTURE
  budget, not by the mesh level** — `k` levels finer than the DEM tile where the
  ortho pyramid has them, so a 256-cell tile carries a `256·2^k` px image:
  desktop k = 2 (1024 px, ~1 ft/px on an 4-ft tile, 0.5 on 2 ft), tablet k = 1,
  phone k = 0 (which is today's, and inside `texBudget()`). A finer drape than the
  ortho pyramid has falls back to the finest that exists. GPU memory at `high` on a
  desktop stays under ~150 MB of textures (24 tiles × 1024² × 4 B); report it in
  `stats()`.
- **Tile meshes are built on the main thread when the camera settles** (P2 measured
  the build at 1,447 ms after his fixes), which is the hitch after every move. Move
  the vertex/normal/skirt build into the pooled decode worker (`js/dem.js` already
  hands a tile's Float32Array back — build the positions/normals/index there and
  transfer them), keep the coarse parent drawn until the children's buffers are in
  hand (already the rule), and **cache built geometry by tile key** (an LRU of
  geometry bytes, same budget idea as the tile cache) so returning to a view rebuilds
  nothing. Selection runs on a settled camera as today.
- **A real GPU is detected and used.** `WEBGL_debug_renderer_info` names the
  renderer; anything that is not SwiftShader / llvmpipe / "Software" is a GPU. On a
  GPU: default quality `high` (2 px) the first time (a remembered preference still
  wins), anisotropy at the max, the drape budget above, and pixel ratio up to 2. The
  Help line and `stats()` say which renderer was found. `SBMM_GPU=1` in the harness
  is unchanged.
- Also check the 2D map at high zoom: if the pixelation is the 2-ft hillshade JPEG
  showing through at zoom ≥ 3 inside the mine window (where a 1-ft hillshade
  exists), the layer order or the zoom gate is wrong; say what was found either way.
- Acceptance: `test/terrain3d.mjs` records texture ft/px per drawn tile and asserts
  ≤ 1 ft/px over the mine window at `high` on the desktop profile; `test/perf.mjs`
  records the hitch (longest main-thread task after a camera move) before/after and
  it must fall by half; idle renders stay 0; block 9e unchanged; tablet and phone
  harnesses green; `SBMM_GPU=1 node test/run.mjs --only terrain3d:folder,perf` is
  what the engineer runs on his own GPU, and README says so.

## C. "Where does the water go" — the three areas the engineer asked for

The engineer: "I don't quite understand how the rainfall system works … we basically
need an area that overland-flows right into Clear Lake, then the area whose flow goes
into the Herman impoundment, and another area that flows away from the site elsewhere,
so we can understand the catchment for the Herman impoundment."

The kernels already know this; the presentation does not say it. Build ONE view that
does, on top of Phase 1's label rasters (no kernel change):

- A layer row **Where the water goes** under *Drainage* (Site framework), default OFF,
  with exactly these classes, each one colour, each with acres in the legend:
  1. **Straight into Clear Lake** — overland, no pond, no pipe (by-outlet lake minus
     the ponds' contributing areas).
  2. **Into the Herman impoundment** — everything whose first capture is the
     impoundment pond or either 24-in barrel's inlet (this is *the catchment of the
     impoundment*; it then leaves through the two pipes to the lake).
  3. **Into Frog Pond / Green Pond** — first capture is either pond or its culvert /
     FES / riser (leaves through the road drain to the lake).
  4. **Off the surveyed ground** — the off-survey outlet (and anything that leaves the
     site elsewhere).
  Ponds themselves and the road-drain grates' 0.02 ac ride with the class they feed.
- A results card with the four acreages, and one plain-language sentence per class
  ("37.9 ac drain into the Herman impoundment and leave through the two 24-in pipes
  to Clear Lake …"), a "show in 3D" that drapes the four classes, CSV/GeoJSON of the
  four polygons, and the card says which grid (2 ft / 4 ft) it was drawn on.
- The design-storm card (`RAIN`) gains a one-paragraph "what this is" at the top and
  a row per class above: rainfall depth × the class's runoff volume, so the
  impoundment's inflow for the storm is one line ("the impoundment receives N ac-ft
  in the 25-yr 24-h storm and rises 0.82 ft") — which is the number he was looking
  for. README/HANDOFF get a plain-language page: what Phase 1 / 2 / 3 each answer,
  in the engineer's words, with the three areas first.
- Acceptance: the four classes partition the surveyed ground exactly (sum = Phase 1's
  site total, no cell in two classes); Herman's class area equals `through_area` of
  the impoundment's outlet within 0.01 ac; e2e block "9ac2. where the water goes"
  turns the row on, reads the four acres, and asserts the partition; field/phone: the
  row exists and the card opens.

## Order, and what each agent must not touch

S first (data + water.js + tests + docs), then C (drainage.js + a card + docs), then G
(terrain3d/tiles/viewer3d/dem + harnesses). S and C are correctness; G is polish and
carries the most risk, so it goes last and can be dropped if the budget ends. No agent
edits `js/compute.js` kernels. No model names anywhere.
