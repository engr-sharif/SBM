# SBMM Site Explorer — v19: hydrology Phase 3 (authoritative)

Owner/decider: Fable (planner). Executor: one Opus agent (A3). Phase 3 of
`docs/V14_CATCHMENT_PROPOSAL.md`, on top of Phase 1 (the drainage map,
`docs/V14_DRAINAGE_SPEC.md`) and Phase 2 (the design storm,
`docs/V14_PHASE2_RUNOFF_SPEC.md`). Decided by the engineer 2026-09-05
("3, 10, 11 … work on this now"). Hard constraints as in CLAUDE.md; every
v10–v18 golden stays; the runner (`test/run.mjs`) is how the matrix is run.
A separate agent (H) is landing "Herman's two pipes carry the flow" first
(§1); merge `claude/webapp-onboarding-mavtzx` when it does and build on it.

---------------------------------------------------------------------------

## 1. Already ruled, landing separately (Agent H)

Both 24-in HDPE pipes are the impoundment's discharge, in parallel, into the
storm main; the overtopping's pipe route is the conduit chain, not a raindrop
from a pipe end; no water on the ground between the wall and the outfall.
Phase 3 takes that network as given.

## 2. Flow accumulation — kernel `accum` (api VERSION 10)

- **Input**: the filled DEM `F` and the pointer field the `drainage` kernel
  already builds (reuse `fillDem` with the same conduit seeding and the same
  parent forest; do not write a second fill), the conduit list, `captureFt`.
- **Method**: D-infinity (Tarboton 1997) proportions over `F`, with the
  pointer field as the tie-breaker on flats and inside ponds (so accumulation
  is provably acyclic for the same reason the labels are), conduits as
  shortcuts (everything reaching a capture cell is delivered to the conduit's
  outlet and continues), ponds pass their inflow through at their outlet.
  Also expose plain D8 accumulation (`method: "d8"`) because the identity
  test below is exact only for D8.
- **Output**: `acc` (Float32Array, contributing area in ft² per cell,
  decimated by `stride` for display, full-resolution values at the requested
  probe points), `sca` (specific catchment area), `streams` (polylines above
  a threshold area, default **5 ac**, with Strahler order), `channelMask`.
- **Identity (acceptance)**: D8 accumulation at each Phase 1 outlet's pour
  cell equals that outlet's Phase 1 `area_ft2` to 0.5 %; D-inf at the same
  cells within 3 %; the accumulation is monotone along every longest flow
  path of Phase 1; every stream polyline ends in a sink or a conduit.
- **App**: two rows under *Drainage* (Site framework): *Flow accumulation*
  (log-scaled raster, legend in acres) and *Streams (≥ 5 ac)* (lines with
  order-scaled weight, hover shows upstream acres, in 3D draped). Hover on
  the accumulation raster reads "upstream area 12.4 ac" in the status bar.
- **Phase 2 uses it**: the TR-55 channel-flow test in the `runoff` kernel
  reads the real accumulation along the longest path (replacing the linear
  proxy CLAUDE.md records as a Phase 3 item); `Tc` and the peaks are
  re-recorded in `test/kernels.mjs` and README with the change explained.

## 3. Pipe hydraulics — kernel `hydraulics` (host-driven, small)

Until the invert survey arrives, provisional and said so in red, like the
rainfall.

- **Data**: conduits gain `diameter_in` (the two Jacobs pipes are 24 in;
  everything else `null` until surveyed), `slope` from the inverts where both
  ends are surveyed, else from the lidar rims (flagged `provisional`),
  `n` Manning (0.012 HDPE / 0.013 RCP / 0.024 CMP, by `material` where the
  CAD says one, else `null`). `data/storm_survey.csv` intake format
  documented (`node_id, invert_ft, rim_ft, diameter_in, material, date,
  source`), read by `tools/build_storm_network.py` when present.
- **Method**: Manning full-flow capacity `Q = (1.49/n) A R^(2/3) S^(1/2)`
  per conduit; inlet capacity for grates (HEC-22, on-grade and sag forms,
  with the grate size where the CAD gives one, else "unknown"); a
  steady-state HGL/EGL pass node to node for a given inflow set (the Phase 2
  design-storm peaks at the first-capture points), energy losses by
  Manning friction plus a 0.5 entrance loss, surcharge flagged where the
  HGL rises above the rim.
- **App**: per-conduit `capacity_cfs`, `Q_peak_cfs` for the chosen storm,
  `ratio`, HGL at each node; the storm popups gain these rows; the conduit
  layer can be coloured by capacity ratio (green < 0.8, amber < 1, red
  surcharged); a *Pipe capacity* results card; "unknown — survey pending"
  wherever a diameter or slope is missing; nothing invented.
- **Acceptance**: Manning against a textbook case (24-in, n 0.012, S 0.005 →
  record the value and cite the formula), HEC-22 against its worked example,
  the HGL energy balance closes at every node (Σ losses = ΔEGL within 1e-6),
  a surcharge is flagged when the inflow exceeds capacity by construction.

## 4. Scenarios — `js/scenarios.js` (`SBMM.scenarios`)

- A scenario is a named record: storm (id or custom P/duration),
  distribution, HSG rule, CN overrides, cover override areas, the storm
  master switch, per-conduit broken set, a blocked-conduit list (what-if),
  the survey stages on/off, and (when Phase 2's design surfaces exist) a
  proposed surface id. Stored in the session (additive key `scenarios`),
  listed in a *Scenarios* card with run / duplicate / rename / delete.
- **Compare**: pick 2–4 scenarios → one table: per pond peak stage,
  freeboard, overtops (y/n, when), outfall peak (cfs) and volume, worst pipe
  ratio; a map diff of two scenarios highlighting catchments whose outlet
  changed and ponds whose peak stage changed by > 0.1 ft; a report sheet
  "Scenarios — {names}" with the assumptions of each.
- **Command** `SCENARIO` (aliases `SCENARIOS`, `WHATIF`); the Water ▾ menu.
- Every run goes through the existing kernels; a scenario never invents a
  number that the dialog could not produce by hand.

## 5. Acceptance and docs

`test/kernels.mjs` sections `accum` and `hydraulics` (the dispatch grep
fails until they exist); e2e block **"9ab. accumulation + pipes"** (rows
draw, hover reads acres, the outfall's accumulation equals its catchment,
a capacity ratio appears on a pipe popup, a scenario pair compares and
round-trips a session with zero jobs); field e2e: the rows exist and the
scenario card works on a phone. `node test/run.mjs` green on all three
builds. Shots `test/hydro3_shots.mjs` → `accum_2d.png`, `streams_3d.png`,
`pipe_capacity.png`, `scenario_compare.png`. Docs: CLAUDE.md (a v19
section: the D-inf rule on flats/ponds, the identity, the provisional
hydraulics, the scenario record; the code-map rows), README (a "Phase 3"
section with the recorded numbers), HANDOFF (decision rows; open item: the
invert survey CSV), release notes. No model names.

## 6. Not in scope

Unsteady (dynamic wave) pipe routing; 2D rain-on-grid; groundwater.
