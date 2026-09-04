# SBMM Site Explorer — v14 proposal: catchments, rainfall and runoff (for decision, nothing built)

Status: **proposal**. Written 2026-09-04 at the engineer's request ("start
thinking about catchment areas for the entire site, like simulating rainfall
and where those would go … let me know the SOTA ways of handling this")
before any change is made. Decisions needed are in §7.

---------------------------------------------------------------------------

## 1. What the app can already do, and what the question actually is

Already in the kernels: steepest-descent (D8) routing over the lidar, the
Barnes priority-flood filled DEM, fill-and-spill ponds with their stage–storage,
storm conduits as shortcuts with inlets as sinks, the catchment of one point
(upslope BFS from a drop), and the overtopping analysis of a water body with its
rim lows and stage table. All of it is **static terrain analysis**: where water
goes, never how much or how fast.

"Where does rain falling anywhere on the site go" is three questions, and they
have different answers and different levels of assumption:

| question | needs | assumption load |
|---|---|---|
| A. Which outlet does each square foot of the site drain to, and how big is each catchment? | the terrain and the conduits, nothing else | none — it is the lidar's answer |
| B. How much water reaches each outlet in a design storm (volume, peak)? | rainfall depths, a runoff model, land cover, soils | moderate, all of it standard and citable |
| C. Does a pond fill and overtop, when, and does a pipe keep up? | B plus stage–storage (have it) and outlet ratings (pipes need the invert survey) | as B, plus pipe sizes/inverts |

A is pure geometry and should be built first; it is what he sees on the map.
B and C are hydrology and hydraulics at the level a site drainage report is
written at; they are where the assumptions live and where the card has to say
so in words.

## 2. Question A — the drainage map (recommended first)

**Method: D8 flow direction over the filled DEM, then label propagation from
every sink.** This is the standard (O'Callaghan & Mark 1984; Jenson &
Domingue 1988) for basin delineation, it is deterministic, and it is *exactly
the model the raindrop already uses*, so the drainage map and a raindrop never
disagree. The alternatives — D-infinity (Tarboton 1997) and multiple-flow-
direction (Quinn 1991; Freeman 1991) — spread flow across neighbours and give
better-looking flow-accumulation maps on smooth hillslopes, but they produce
fractional contributing areas and fuzzy basin edges; they are the right tool
for a "wetness index" layer, not for "this acre drains to that grate".

- **Sinks** are what the lidar and the network say they are: every conduit inlet
  (its capture cells, at its rim), every pond that stays a pond at the site's
  natural spill (a depression whose pour point leaves through a conduit is a
  through-flow, not a sink), Clear Lake and the survey boundary (NoData), and
  the impoundment (a pond with the pipes as its outlet — so its catchment is
  everything that reaches it, and its outflow joins the storm main).
- **Delineation**: one priority flood over the whole site grid, D8 on the
  filled surface with ponds read at their level (as `flowpath` does), then a
  reverse BFS from each sink labelling every cell that drains to it. Output: a
  `Uint32` label raster, one polygon per catchment (the existing `maskRings`),
  its area from the cell count, and per catchment the outlet it feeds and the
  path length to it. Nested catchments fall out of the conduit graph: the road
  drain's nine grates each have their own, and the outfall's catchment is their
  union plus Herman's plus the branch's.
- **Cost**: the 2-ft site grid is 4,850 × 4,450 = 21.6 M cells; a priority
  flood plus D8 plus labelling in a worker on typed arrays is a few seconds
  and is done once and cached (the field build can run it at 4 ft, 5.4 M
  cells, and say so). The mine and residential windows can be recomputed at
  1 ft when he zooms in, the way the raindrop picks its grid.
- **What he sees**: a *Drainage* layer under Site framework — catchments as
  translucent fills, one colour per terminal outlet (Clear Lake direct, the
  storm outfall, Herman, each pond, off-survey), boundaries as thin lines,
  labels with acres; hover highlights a catchment and its outlet; clicking a
  grate, a pond or the outfall lights up everything that drains to it, with a
  table (acres, share of the site, longest flow path, mean slope). Draped in
  3D. "Storm drains work" off gives the ground-only map. A raindrop dropped
  anywhere agrees with the colour under it, by construction, and the e2e
  proves it at a hundred random points.

## 3. Question B — a design storm on the site

Two standard, citable methods fit a client-side planning tool; the choice is
by catchment size and by what the number is for.

**Runoff volume: NRCS Curve Number (TR-55 / NEH-630 ch. 10).**
`Q = (P − 0.2S)² / (P + 0.8S)`, `S = 1000/CN − 10` (inches). It is the method
every site drainage report in this county uses, its inputs are two tables, and
it degrades honestly: a CN is a stated assumption, not a fitted parameter.
Curve numbers by cover and hydrologic soil group (HSG), the ones this site
needs:

| cover (from the data we have) | source layer | CN, HSG C | CN, HSG D |
|---|---|---|---|
| paved road, concrete, roofs | `V-ROAD-ASPH/CONC`, `V-SITE-CONC`, `V-BLDG-*` | 98 | 98 |
| gravel road | `V-ROAD-GRVL` | 89 | 91 |
| bare mine waste / tailings / disturbed ground | the DU and waste-pile polygons | 91 | 94 |
| grass / weeds, fair condition | ortho (vegetated, no canopy) | 79 | 84 |
| woods / brush, fair | CHM ≥ 6 ft (mine window), ortho elsewhere | 73 | 79 |
| open water | EA `water` polygons | 100 (rain lands on the pond) | 100 |

HSG is the soil's infiltration class. NRCS SSURGO (Web Soil Survey) carries it
for the native soils around the site; mine waste and compacted fill are not in
SSURGO and are conventionally taken as **D** (very low infiltration), native
ground here as **C** unless the survey says otherwise. Those two letters are
the biggest assumption in the whole chain and the card will print them.
Green-Ampt infiltration (Ks, suction head, porosity) is the physically based
alternative; it needs soil parameters the 2025 borings do not give, so it is
for later, if ever.

**Rainfall: NOAA Atlas 14, Volume 6 (California), point precipitation
frequency for the site coordinates (≈ 39.003 N, 122.663 W).** The app cannot
fetch it (no network); a builder bakes the table once, with its date and the
PFDS URL, and the dialog lets him pick the return period and duration. The
24-hour depths at this location are roughly 3.3 in (2-yr), 5.3 in (10-yr),
6.4 in (25-yr) and 8.3 in (100-yr) — **to be pulled and confirmed from the
PFDS, not typed from memory**. Temporal distribution: NOAA Atlas 14's own
distribution for the region, or NRCS Type I/IA as the TR-55 map places Lake
County; a decision, see §7.

**Peak flow and hydrograph.** For catchments under ~200 acres the Rational
method (`Q = C·i·A` with Atlas 14 intensities at the time of concentration)
is the accepted answer for a pipe or culvert check; for the whole site and for
routing through the ponds, the SCS dimensionless unit hydrograph with the
time of concentration by TR-55 segments (sheet flow, shallow concentrated,
channel — the flow-path lengths and slopes come straight out of the D8
raster). Both are in HEC-HMS; both are a few hundred lines of arithmetic
here. Report both where they both apply, and say which is which.

## 4. Question C — routing through the ponds and pipes

Level-pool (Modified Puls) routing: inflow hydrograph from §3, the pond's
stage–storage (the overtopping kernel already computes it), and an outlet
rating — a broad-crested weir over the rim (have the rim and its length), and
for a conduit an orifice/pipe rating that needs the invert, diameter and
material **from the survey he is planning**. Output per storm: peak stage,
whether the pond overtops and when, peak outflow, and the same thing for the
next pond down the chain (Frog → Green → the road drain → the outfall). Pipe
capacity by Manning full-flow with the surveyed size and slope, compared with
the peak from §3. Nothing here is built until the inverts exist; the weir
half can be built now.

## 5. What is not recommended (yet)

A 2D shallow-water "rain-on-grid" model (HEC-RAS 2D, LISFLOOD-FP, TUFLOW, the
GPU solvers) is the state of the art for *seeing* a storm move across a
site, and it is possible in a worker or WebGL at 8–16-ft cells. It is not the
right first tool here: it needs a Manning-n raster and an infiltration model
to be more than an animation, sub-second timesteps at 2 ft, and calibration
nobody has data for. If he wants the picture after A–C exist, it is a
bounded optional phase: the same catchment inputs, coarse cells, and a card
that says it is illustrative.

## 6. Phases, in order, each shippable on its own

1. **Drainage map** (A): the label raster, catchment polygons and areas, the
   layer, hover/click, 3D drape, CSV/GeoJSON export, kernel harness with the
   identity "a raindrop lands in the catchment it was dropped in". No
   assumptions. The largest and most useful step, and it needs nothing from
   him.
2. **Design storm** (B): land-cover raster from the layers in §3 with an
   editable override (draw an area, assign a cover), the CN and HSG tables in
   an assumptions dialog, the Atlas 14 table baked by a builder, per-catchment
   runoff volume and peak, a report sheet. Every number carries its CN, HSG,
   P and method.
3. **Routing** (C): weir routing now; pipe ratings when the invert survey
   lands (the same CSV as `tools/build_storm_network.py` reads).
4. **Storm animation** (§5), optional.

## 7. Decisions needed from the engineer

1. Go ahead with Phase 1 now? (Recommended: yes — it is terrain only.)
2. HSG: take mine waste, tailings and compacted fill as **D** and native ground
   as **C**, until SSURGO or a site infiltration test says otherwise?
3. Which storms matter for the report: 2-, 10-, 25- and 100-year, 24-hour?
   Any shorter durations for the pipes (e.g. the 25-year 1-hour)?
4. Temporal distribution: NOAA Atlas 14 regional, or NRCS Type I/IA?
5. Is there any infiltration or soils data from the 2025 geotech programme
   (the borings dataset has 44 locations) that should replace the HSG guess?
6. Clear Lake's stage at the outfall is ignored (free outfall) — agreed?
