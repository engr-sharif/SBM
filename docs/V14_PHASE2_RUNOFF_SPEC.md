# SBMM Site Explorer — v14 Phase 2: a design storm on the site (authoritative)

Owner/decider: Fable (planner). Executor: one Opus agent (R). Phase 2 of
`docs/V14_CATCHMENT_PROPOSAL.md`, built on the Phase 1 drainage map. Decided by
the engineer 2026-09-05: "go with your best assumptions and make the best
choices possible". Every assumption below is therefore a ruling, printed on the
card, and changeable in one dialog. Hard constraints as in CLAUDE.md.

---------------------------------------------------------------------------

## 1. The assumptions (rulings), all visible in the app

| what | ruling | why |
|---|---|---|
| Rainfall | NOAA Atlas 14 Volume 6, point precipitation frequency at 39.003 N, 122.663 W, baked by `tools/build_rainfall.py` from a CSV the planner or the engineer downloads from the PFDS (`data/atlas14_sbmm.csv`, the PFDS export format), with the download date and URL in the payload. Until that CSV exists the builder writes a **placeholder table flagged `provisional: true`** with these 24-h depths — 2-yr 3.3 in, 5-yr 4.2, 10-yr 5.3, 25-yr 6.4, 50-yr 7.3, 100-yr 8.3 — and 1-h depths 2-yr 0.55, 10-yr 0.85, 25-yr 1.05, 100-yr 1.45, and the card says **"provisional depths — replace with the Atlas 14 export"** in red until it is replaced | the app cannot fetch; the numbers must be citable |
| Storms offered | 2-, 10-, 25-, 100-year 24-hour; 25-year 1-hour for the pipes; a custom depth/duration | the report set |
| Temporal distribution | NRCS Type IA (TR-55, the Pacific coast type that covers Lake County) for the SCS hydrograph; a selectable Type I and Atlas-14-style uniform | a decision the engineer can flip in the dialog |
| Runoff volume | NRCS Curve Number (TR-55 / NEH-630 ch. 10), `Q = (P − 0.2S)² / (P + 0.8S)`, `S = 1000/CN − 10`, AMC II | the standard |
| Hydrologic soil group | **D for mine waste, tailings, waste piles, decision units and compacted fill; C for everything else** | no SSURGO or infiltration data on hand; stated on every card |
| Cover classes and CN (HSG C / D) | paved, concrete, roofs 98/98; gravel road 89/91; bare mine waste / disturbed 91/94; grass / weeds fair 79/84; woods / brush fair 73/79; open water 100/100 | TR-55 Table 2-2 |
| Cover raster | 2-ft site grid, from EA's layers in priority order: water polygons → buildings → paved roads/concrete → gravel roads → waste piles and DUs (mine waste) → canopy (CHM ≥ 6 ft, mine window) → the ortho (a green-excess index splits vegetated from bare; threshold recorded) → default grass/weeds; the engineer can draw an **override area** (an `area` feature with `props.cover`) that wins | data we have |
| Time of concentration | TR-55 segments along the catchment's longest flow path (from Phase 1): sheet flow ≤ 100 ft (Manning n by cover, 2-yr 24-h P), shallow concentrated (paved/unpaved), channel where the accumulation exceeds 5 acres (Manning n 0.035) | TR-55 ch. 3 |
| Peak flow | Rational `Q = C·i·A` for catchments ≤ 200 ac with `i` from the Atlas table at `Tc` (interpolated in log-log), C from the cover table (0.95 paved, 0.7 gravel, 0.6 mine waste, 0.35 grass, 0.25 woods, 1.0 water); SCS dimensionless unit hydrograph for every catchment (the whole-site answer); both reported, labelled | both standard; the card says which |
| Pond routing | level-pool (Modified Puls) through Frog, Green and Herman using the overtopping kernel's stage–storage and a broad-crested weir over the rim (`Q = 3.0·L·H^1.5`, L = the rim-low cluster width, H over the rim); conduits with a surveyed invert AND size get an orifice/pipe rating (none yet → the culvert passes its inflow, capped by nothing, and the card says "capacity unknown — survey pending") | half now, half after the invert survey |
| Clear Lake stage | free outfall | ruling |

## 2. What is built

- **`tools/build_rainfall.py`** → `data/rainfall.json` + `datajs/d_rainfall.js`
  (in the field build). Reads `data/atlas14_sbmm.csv` if present (the PFDS
  CSV: rows by duration, columns by ARI, with the upper/lower bounds), else
  writes the provisional table with `provisional: true`.
- **`tools/build_cover.py`** → `data/cover.png` (a 2-ft class raster over the
  site grid, PNG palette, ≤ 1 MB) + `data/cover.json` (the class table, the
  green-excess threshold, the source layers) + `datajs/i_cover_png.js` /
  `d_cover.js`. Built from the layers in §1; the app also rebuilds the class
  for any override area at runtime (no PNG rewrite: the kernel takes
  overrides as rings with a class).
- **Kernel `runoff`** (`js/compute.js`, api VERSION 9): for a set of catchment
  masks (from the Phase 1 label raster, decimated) and the cover raster,
  returns per catchment the area by cover class, the composite CN (area-
  weighted, HSG from the mine-waste mask), the runoff depth and volume for the
  chosen P, the Tc segments along the longest path, the Rational peak and the
  SCS unit-hydrograph peak and hydrograph (time series at 6-minute steps).
  Pure arithmetic over typed arrays; one job per storm.
- **Routing** (`js/runoff.js`, host): level-pool through the three ponds in
  chain order using `overtop`'s stage table (`storage_ft3` per level) and the
  weir rating; outputs peak stage, time to peak, whether it overtops the rim
  or discharges through the conduit first, outflow hydrograph passed to the
  next pond / catchment.
- **UI** — `js/runoff.js` → `SBMM.runoff`: the `STORM` command becomes a menu;
  new command `RAIN` (aliases `RUNOFF`, `DESIGNSTORM`) opens the **Design
  storm** dialog: storm picker, distribution, HSG rule, the CN table
  (editable), the override tool ("draw a cover area"), a "provisional
  rainfall" warning. Run → a *Design storm* results card: per catchment (the
  Phase 1 outlets and first-capture ponds/inlets) P, CN, Q (in), volume
  (ac-ft), Tc (min), Rational peak (cfs), SCS peak (cfs); the three ponds'
  routing rows (peak stage, freeboard, overtops? when?); a hydrograph chart
  per selected catchment (SVG, like the stage chart); CSV export; a report
  sheet (`js/report.js`) "Design storm — {storm}" with the assumptions table
  first. A *Cover* layer row under Site framework (the class raster as an
  image overlay with a legend) and a *Runoff depth* row (the per-catchment Q
  as a choropleth).
- **Field build**: the dialog and card work; the cover raster is in the field
  build (it is small).

## 3. Acceptance

`test/kernels.mjs` section `runoff`: (a) the CN arithmetic against TR-55's
worked example (P 4.0 in, CN 85 → Q 2.17 in; CN 70 → 1.33 in; identity to
0.01 in); (b) composite CN of a synthetic two-class catchment equals the
area-weighted value; (c) Tc segments on a synthetic 500-ft path reproduce the
TR-55 worksheet arithmetic; (d) the SCS unit hydrograph's volume equals Q·A
within 1 % and its peak equals `484·A·Q/Tp` (A in mi², Q in, Tp h) within 1 %;
(e) level-pool routing conserves volume (inflow − outflow = Δstorage) within
0.5 %; (f) the real site, 25-yr 24-h: recorded per-outlet volumes and peaks
(say so), the impoundment's routed peak stage against its 1341.55 pipe row
and 1343.84 rim, Frog and Green Ponds' peak stages and whether they overtop;
(g) the cover raster's class areas sum to the surveyed area and the paved
class area agrees with EA's paved polygons within 5 %.
`test/e2e.mjs` block "9aa. design storm": `RAIN` opens the dialog, a run on
the 25-yr 24-h produces the card with ≥ 4 catchment rows and the three pond
rows, the provisional warning shows (or not, if the CSV exists), an override
area changes a catchment's CN, the report opens, CSV exports, the cover and
runoff-depth rows draw, a session round trip keeps the override and spawns no
job. Field e2e: the dialog and the card. Shots: `test/runoff_shots.mjs` →
`runoff_card.png`, `runoff_cover.png`, `runoff_hydrograph.png`. Every
harness on all three builds; golden unchanged.

## 4. Docs

CLAUDE.md (v14 Phase 2 section: the rulings table, the kernel, the traps),
README ("Design storm" section with the assumptions table and the recorded
25-yr results), HANDOFF (decision rows; open items: replace the provisional
rainfall with the PFDS export — instructions; the invert survey for the pipe
ratings; SSURGO/infiltration if it turns up), release notes v9.13. No model
names.

## 5. Not in scope

A 2D rain-on-grid solver; continuous simulation; evaporation and seepage;
water quality.
