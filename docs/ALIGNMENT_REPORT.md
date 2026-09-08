# Horizontal alignment audit — is the lidar topo shifted?

**Question (the engineer, 2026-09-08):** *"the sandbag dam that we did the survey on is
slightly to the WEST of the actual sandbag dam that we can make out on the lidar topo.
I wonder if the whole topo is slightly shifted towards the east."*

**Answer: the lidar is not shifted. The August-2026 survey is.** The dam the survey
measured is the same dam the January-2024 lidar and orthophoto show; the survey plots it
**13.4 ft WSW** of where it stands, and that displacement has the exact signature of
coordinates computed in **international feet on a grid defined in US survey feet**. Two
smaller, unrelated defects were found on the way and are recorded below: a real **half-cell
(0.5 ft) offset in `dem_site`** relative to the two 1-ft grids, and a **display-only
half-cell offset of the hillshade overlays**.

Everything here is measured. One command reproduces every number:

```
python3 tools/check_alignment.py            # ~40 s, ~2 GB peak, writes docs/alignment/*.jpg
python3 tools/check_alignment.py --quick    # skips the orthophoto tests
```

Sign convention throughout: **`(dx, dy)` is the vector you ADD to a position in source A to
land on the same physical feature in source B.** `dx > 0` means B is that far east of A.

---

## 1. The measurements

| # | A → B | dx (ft) | dy (ft) | magnitude | direction | uncertainty | method |
|---|---|---|---|---|---|---|---|
| 1 | `dem_site` → `dem_abp` | **−0.500** | **−0.501** | 0.708 ft | SW | ±0.01 (formal ±0.001; rms 0.043 ft, n = 106,720) | elevation gradient fit, 1-ft grid vs 2-ft grid over the same ground |
| 2 | `dem_abp` → `dem_res` | +0.0000 | +0.0000 | 0 | — | exact | same fit; both are direct cuts of one master, rms 0.0000 |
| 3 | EA existing TIN → `dem_abp` | **+0.312** | **−0.177** | 0.359 ft | ESE (bearing 120°) | ±0.14 / ±0.09 (sd over 41 tiles) | gradient fit, n = 73,587, rms 0.073 ft |
| 3b | EA existing TIN → `dem_res` | +0.227 | −0.149 | 0.272 ft | ESE | ±0.14 / ±0.09 | as above, n = 23,648 |
| 3c | EA existing TIN → `dem_site` | −0.368 | −0.692 | 0.784 ft | SW | ±0.14 / ±0.09 | as above — **exactly row 3 plus row 1**, which is what makes row 1 a real defect and not an artefact of the estimator |
| 4 | EA V-Base 5-ft contours → `dem_abp` | +0.258 | −0.087 | 0.272 ft | ESE | ±0.05 (spatially variable) | 446,288 drafted contour vertices with a Z, gradient fit, rms 0.205 ft |
| 5 | EA CAD buildings → `ortho_mine` (6 in) | **+0.15** | **−0.07** | 0.17 ft | ESE | 0.29 ft scatter, n = 894 | luminance-edge fit along each drafted line's normal |
| 5b | EA CAD buildings → `ortho_site` (1.5 ft) | +0.06 | −0.16 | 0.17 ft | SE | 0.52 ft scatter, n = 1,633 | as above |
| 5c | EA CAD road stripes / edges / concrete → ortho | −0.74…+0.18 | +0.30…+0.63 | ≤0.8 ft | — | 1.7–4.2 ft scatter | as above — **too fuzzy to be a measurement**, listed so nobody re-derives it |
| 6 | `ortho_mine` bright ridge → `dem_abp` top-hat ridge, AT the sandbag wall | +0.19 (E only) | n/a | 0.19 ft | — | robust sd (MAD) 1.24 ft over 15 rows, so ±0.32 ft on the median | per-row sub-pixel peak of the wall crest in each source |
| 7 | Aug-2026 survey → the lidar, free 2-parameter | **+13.25** | **+3.75** | **13.77 ft** | ENE (bearing 74°) | ±0.5 E / ±2 N | rms of (lidar z − surveyed z) over 10 shots: **1.543 → 0.372 ft** |
| 7b | Aug-2026 survey → the lidar, ONE parameter (a scale about the grid origin) | +12.9 | +4.3 | 13.6 ft | ENE | k−1 = **2.030e−6**, bootstrap 16–84 % **[1.92e−6, 2.21e−6]** | same misfit, one free parameter; rms 0.399 ft |
| — | *reference constant:* US survey foot / international foot − 1 | | | | | **2.000e−6** | exact, by definition (1 usft = 1200/3937 m) |

**Rows 1–6 say the same thing five ways: nothing in the repo's own georeferencing is out
by more than about a third of a foot, and what offsets exist point ESE, not east by any
amount a person could see.** Row 7 is two orders of magnitude larger and is the answer to
the engineer's question.

### Why row 5 is the important independent check

The lidar DEM and the orthophotos come from the same flight and the same processor, so
they cannot cross-check each other's absolute position. EA's CAD can: `V-BLDG-OTLN` is
drafted planimetry, and building outlines are the only class in the delivered CAD whose
edge-fit scatter is sub-foot (0.29 ft on the 6-inch ortho). It agrees with the surveyor's
imagery to **0.17 ft**. Combined with row 3, the whole package closes:

```
   EA CAD  --0.17 ft-->  surveyor's ortho
   EA CAD  --0.36 ft-->  lidar DEM             (row 3, via EA's own existing TIN)
   ortho   --0.19 ft-->  lidar DEM             (row 6, at the wall)
```

A 13 ft displacement of the lidar is not consistent with any of those.

### What was tried and does NOT work (so it is not tried again)

A general cross-correlation of the DEM against the orthophoto over open terrain is **not
diagnostic on this site**. `|NCC|` of the DEM top-hat against the ortho high-pass, over 14
windows chosen for maximum constructed relief, peaks at **0.05–0.36 with no consistent
offset** — a photograph's tone here is vegetation and material colour, not relief. Only
discrete features shared by both sources (row 6) carry the signal. `tools/check_alignment.py`
says so in place rather than printing a meaningless number.

---

## 2. The verdict on the sandbag wall

**The wall in the lidar and the wall in the survey are the same wall**, and the
January-2024 orthophoto settles it. `docs/alignment/wall_ortho.jpg` shows the 6-inch ortho
at the wall with the survey drawn twice: as delivered (red/yellow) and with the unit
correction applied (cyan/green).

- A bright white linear structure with visible individual bags runs NNW–SSE at
  **E 6,372,053–6,372,063, N 2,127,479–2,127,503**. It is in the imagery of the flight and
  it is a ridge in the DEM (top-hat +1.1 to +1.3 ft, crest 1,343.7–1,344.0 ft).
- The survey's wall outline **as delivered** sits at E 6,372,042–6,372,052 — on the road
  shoulder, on nothing.
- Corrected, the outline lands **on the bags**: same length (20.8 ft), same width (10.2 ft),
  same NNW–SSE axis (bearing 169°), same bend at its south end.

The elevations are the arithmetic behind the picture. Ten shots that can be compared —
the eight sandbag-wall shots and the two "top of water" shots; the eleven NW Pit shots read
the lidar's flat 1,342.80 ft water plane and carry no horizontal information — fit the
January-2024 lidar to **0.372 ft rms** at the free-fit shift and **1.543 ft** as delivered:

| shot | surveyed | lidar as delivered | Δ | lidar corrected | Δ |
|---|---|---|---|---|---|
| Water Level (top of water, Herman) | 1336.45 | 1339.01 | **+2.56** | **1336.58** | **+0.13** |
| Shore 2 (top of water, Herman) | 1336.44 | 1337.79 | **+1.35** | **1336.58** | **+0.14** |
| SB-144 top of sand bags | 1343.57 | 1344.61 | +1.04 | 1344.49 | +0.92 |
| SB-160 top of sand bags | 1343.54 | 1344.56 | +1.02 | 1343.61 | +0.07 |
| SB-176 top of sand bags | 1343.65 | 1345.20 | +1.55 | 1343.83 | +0.18 |
| SB-192 top of sand bags | 1344.25 | 1344.87 | +0.62 | 1344.13 | −0.12 |
| SB-208 / 217 / 226 / 234 toe | 1342.60–1343.40 | +1.08…+2.40 | | | +0.23…+0.52 |
| SD PIPE N invert | 1341.57 | 1344.66 | **+3.09** | 1342.42 | +0.85 |
| SD PIPE S invert | 1341.53 | 1344.80 | **+3.27** | 1342.25 | +0.71 |

The two water-surface shots are the sharpest evidence and they take **no part in any fit
that could bias them toward this answer**: corrected, they land on **1,336.58 ft** — the
lidar's own flat water return, the value `docs/V10_WATER_SPEC.md` already records for the
January-2024 impoundment surface — to 0.13 and 0.14 ft. As delivered they sit 1.35 and
2.56 ft up the bank. A survey that says the water fell 0.13 ft in thirty-one months is a
survey that agrees with the lidar; one that says it fell 2.56 ft while the shot sits on dry
ground is a survey that is in the wrong place.

The pipe inverts, corrected, sit 0.71–0.85 ft below the lidar surface at their own cells,
which is what a 24-inch pipe under a sandbag wall should look like. As delivered they sit
3.1–3.3 ft below it, which is what produced the v12 "sunken inlet" ruling (see §5).

### It is not a rebuilt wall

The alternative reading — that a new sandbag wall with two 24-inch pipes was built ~13 ft
west of an older one between January 2024 and August 2026 — would require the old wall's
cross-section to reproduce all ten new shots to 0.37 ft by coincidence, the old wall's
footprint to match the new one's outline in length, width, axis and bend, and the two
"top of water" shots to land on the January-2024 water plane by accident. It is also
inconsistent with row 3: EA's own existing-ground TIN, delivered June 2026, agrees with
the lidar to 0.36 ft over 41 tiles across the whole mine area, so nothing in that frame has
moved.

---

## 3. The mechanism: US survey feet vs international feet

The correction is **one parameter**, not two, and its fitted value is a physical constant.

Scaling every surveyed coordinate about the State Plane grid origin by `k` and minimising
the elevation misfit against the lidar gives

```
   k − 1 = 2.030e−6      bootstrap 16–84 %  [1.92e−6, 2.21e−6]      rms 0.399 ft
   (k = 1)                                                          rms 1.543 ft
   free 2-parameter shift (dx, dy)                                  rms 0.372 ft
```

`usft / ift − 1 = 2.000e−6` **exactly** — 1 US survey foot is 1200/3937 m, 1 international
foot is 0.3048 m. It lies inside the bootstrap interval, and the one free parameter
recovers essentially all of what two free parameters can (0.399 vs 0.372 ft).

At this site that ratio is **+12.74 ft in easting and +4.25 ft in northing** — the 3:1 ratio
the free fit also shows (13.25 : 3.75), because the easting is 6.37 M ft and the northing
2.13 M ft. It is the classic California State Plane blunder: a metric grid converted to feet
with 0.3048 instead of 1200/3937, or a projected CRS declared as ftUS and computed as ft.

**This is a strong hypothesis, not a proven fact.** What is proven is the displacement and
its direction; the unit ratio is the simplest mechanism that produces exactly that
displacement with no free parameters. It is confirmed or refuted by one question to the
surveyor (§7).

---

## 4. Two defects found on the way, both in this repo

### 4a. `dem_site` is half a cell south-west of the 1-ft grids — REAL, and it is ours

`tools/build_dems_from_master.py` builds the 2-ft site grid with `block_mean(master, 2)`.
Block *k* averages master nodes `2k` and `2k+1`, whose centroid is `x0 + 2k + 0.5`; the
metadata then labels that value `x0 + 2k`. So the content of `dem_site` sits **0.500 ft
south-west of its own labels**, and that is exactly what row 1 measures (−0.500, −0.501,
rms 0.043 ft over 106,720 points) with no third party involved. Row 3c is the same defect
seen through EA's TIN: 3c = 3 + row 1 to 0.004 ft.

Consequences: `SBMM.elev` inside the two 1-ft windows is unaffected (`dem_abp` wins the
stack there and is a direct cut), and all four Fig-2 pile footprints are inside `dem_abp`,
so **Pile 1's 278.4 yd³ golden is untouched**. Outside the 1-ft windows — most of the site,
which is where the drainage map, the accumulation, the design storm and the site-wide
contours run — every elevation is read half a foot off.

On the site's own slope distribution (`|∇z|` median 0.257, p90 0.558, p99 0.875 ft/ft on
the 2-ft grid) a 0.5 ft horizontal error is a vertical error of **median 0.13 ft, p90
0.28 ft, p99 0.44 ft**. It is inside the 0.5 ft the app already treats as its comparison
tolerance, and below the 2-ft grid's own half-cell relief, so it changes nothing anyone
reports — but it is a real error with a one-line cause.

### 4b. The hillshade overlays are drawn half a cell north-east — display only

`js/dem.js` `at()` is a NODE reader (sample *i* is the point `x0 + i·cell`) and
`js/dem.js` `bounds()` is an AREA rectangle (`x0 … x0 + w·cell`), one whole cell wider than
the node extent. `js/layers.js` draws `hs_abp.jpg` and `hs_site.jpg` over `bounds()`, so
each image pixel is displayed centred half a cell north-east of the node it was computed
from: **0.5 ft on the mine-area hillshade, 1.0 ft on the site hillshade** (and, since the
site DEM itself is 0.5 ft SW, a net 0.5 ft NE there). The orthophoto `.json` files carry
true corner bounds and are correct.

No kernel and no quantity reads a hillshade JPEG, so this is cosmetic — but it is half of
what "the topo looks slightly east" would look like on screen, and it is worth knowing
before anyone chases a shift that isn't in the data.

---

## 5. What the survey offset has already cost this app

Three existing behaviours are workarounds for it, sized to match:

- **The v12 "sunken inlet" ruling.** `js/storm.js` `findMouth()` exists because the lidar at
  the surveyed pipe inverts reads 1,344.66 / 1,344.80 — 3.1–3.3 ft above the surveyed
  invert — and it moves the kernel's pipe mouth **25.6 ft and 27.1 ft** to find a cell at or
  below the invert. With the survey corrected the lidar at those points reads 1,342.42 /
  1,342.25 (0.71–0.85 ft above the invert) and the nearest qualifying cell is **12–14 ft**
  away. The rule would still fire, at half the distance, and the recorded explanation —
  "the sandbag wall and the two pipes were built afterwards, into a regraded channel the
  lidar never saw" — is contradicted by §2: the lidar saw them.
- **The 25-ft tolerance in `js/water.js` `surveyFacts(ring)`.** The surveyed water-level
  shot is **4.4 ft OUTSIDE** EA's Herman Impoundment polygon as delivered and **9.1 ft
  inside** it corrected. The tolerance covers both, so this is supporting evidence rather
  than a broken behaviour — but the comment beside it attributes the miss to the GIS
  polygon, and that is not where the error is.
- **The 13.2 / 12.7 ft `pipe_to_main` / `pipe_to_main_s` links.** EA's drawn storm main ends
  13 ft west of the plotted pipe west ends. **Correcting the survey makes that gap 26.6 and
  26.1 ft**, because the pipes move east and EA's line does not. That is a consequence to
  weigh, not an argument against the correction: EA drew the storm main, the surveyor shot
  the pipes, and a 26-ft inferred link between two independent sources is not implausible —
  but it does mean the correction is not free.

---

## 6. If a fix is warranted — exactly what it is

**Nothing should be changed on the strength of this report alone.** Two of the three items
need an explicit decision, and one needs the surveyor first.

### Fix A — `dem_site`'s half cell (ours, small, needs a decision)

Two ways, and they are not equivalent:

1. **Correct the builder** — in `tools/build_dems_from_master.py`, the site metadata should
   read `x0 + cell/2`, `y0 + cell/2` (or `block_mean` should be replaced by nearest-node
   decimation, which keeps the SW-corner anchor the tile pyramid depends on). Requires the
   master raster off the user's machine and a full rebuild:
   `build_dems_from_master.py` → `build_chm_png.py` → `build_ortho_mine.py` →
   `build_data.py` → `build_tiles.py` → `build_dist.py`.
2. **Correct only the metadata** — add 0.5 to `x0`/`y0` in `data/dem_site.json` and its
   payload. No PNG changes. **But** `tools/build_tiles.py` anchors the whole tile pyramid at
   the site DEM's SW corner with `cell = 2**z`, and a 0.5 ft move breaks the "a tile pixel
   lands EXACTLY on a source grid node" invariant that `test/tiles.mjs` asserts at
   0.000000000 ft. Option 2 therefore forces a pyramid rebuild anyway.

**Goldens that would move:** everything computed on `dem_site` — the drainage map's outlet
areas, the accumulation identity, the Phase-2 design-storm table, the site contour set, and
any water analysis outside the two 1-ft windows. **Pile 1's 278.4 yd³ would NOT move** (it
is inside `dem_abp`). Expect sub-1 % changes; the mean-elevation × area proxy for the four
traced piles moves −9.3 to +7.4 yd³ for a 0.5 ft shift, and that proxy is an upper bound
because the perimeter-TIN base moves with the terrain. Per CLAUDE.md, any move of the Pile 1
golden needs the engineer's explicit decision; these do not touch it, but the drainage and
runoff regression numbers in `test/kernels.mjs` would have to be re-recorded.

### Fix B — the hillshade bounds (ours, cosmetic, cheap)

`js/layers.js` should draw `hs_site` / `hs_abp` over the node-extent rectangle expanded by
half a cell — `[y0 − cell/2, x0 − cell/2] … [y0 + (h − 0.5)·cell, x0 + (w − 0.5)·cell]` —
rather than over `Dem.bounds()`. Do **not** change `bounds()` itself: `js/viewer3d.js`,
`js/tiles.js` and several harnesses read it as the area rectangle it is. Two lines, no
payload rebuild, no golden moves.

### Fix C — the survey (theirs; ask before touching anything)

**Do not apply the 2.000e−6 scale to `data/survey_2026.json` or the `survey_2026` dataset on
the strength of this report.** The evidence is strong but the mechanism is inferred, and a
survey is a legal record. Ask the surveyor (§7); if they confirm, the fix is:

- add the unit correction to `tools/build_survey_2026.py` at the point where `TABULATED` is
  read (one multiply, `k = (1200/3937)/0.3048`), regenerate `data/survey_2026.json` and
  `data/datasets/survey_2026_points.csv` through `tools/add_dataset.py`, then
  `tools/build_storm_network.py` and `tools/build_data.py`;
- re-derive `pipe_to_main` / `pipe_to_main_s` (26.6 / 26.1 ft, above) and re-record the
  raindrop's 812.8 ft pipe length;
- re-run `findMouth` and re-record `mouth_moved_ft` (25.6 / 27.1 → ~12 / ~14 ft);
- re-record the v10 §10 / v13 stage numbers that depend on the pipe geometry. The
  ELEVATIONS do not move — 1,336.45 water, 1,341.53 / 1,341.57 inverts, 1,343.54 sandbag
  crest are all still what was shot — so the stage table itself is unchanged.

### What must NOT be done

- **Do not shift the lidar DEMs.** Five independent measurements put them within 0.36 ft of
  every other source in the repo. Moving them would break the agreement with EA's CAD, EA's
  TIN, the orthophotos and every registered design sheet at once.
- **Do not reproject EPSG:2226 → EPSG:6418.** The measured EA-vs-lidar offset is 0.36 ft
  (0.11 m). Published NAD83 realisation differences in California are ~0.02–0.10 m for
  HARN → CORS96/NSRS2007 and ~0.01–0.05 m for NSRS2007 → 2011; only the original
  NAD83(1986) is at the 0.3–1.5 m level. 0.36 ft says EA is on a modern realisation, which
  is what CLAUDE.md already records and what the "checked empirically, 0.3–1.8 ft" note
  means. `pyproj` is not installed on this build box and there is no network, so **no
  transformation was computed** — the ranges above are published magnitudes, quoted, not
  calculated. The unit ratio of §3 is a different thing entirely and is exact.

---

## 7. What to ask the surveyor

One question, and it decides everything:

> For the *Additional Limited Topographic Survey* (August 2026): what exactly is the
> projected CRS of the coordinates in Appendix 1 — the EPSG code, and specifically whether
> the linear unit is the **US survey foot** or the **international foot**? If the field data
> were reduced in metres and converted, which conversion factor was used
> (1200/3937 = 0.30480060960, or 0.3048)? Please also send the control points the survey was
> tied to, with their published coordinates and datum realisation.

And, for the aerial deliverable (which this audit finds consistent but never checks against
an external truth):

> For the January-30-2024 lidar and imagery: the LandXML's declared datum, realisation and
> epoch, and the ground control the flight was adjusted to.

Those two answers close this out. If the survey confirms international feet, Fix C is a
one-line change to a builder; if it does not, the 13.4 ft is still real and measured, and
the surveyor needs to know the wall does not plot where it stands.

---

## 8. Figures

| file | what it shows |
|---|---|
| `docs/alignment/wall_ortho.jpg` | The Jan-2024 6-inch ortho at the wall. Red/yellow = the survey as delivered, on the road shoulder. Cyan/green = the same survey with the unit correction, on the sandbag pile. |
| `docs/alignment/wall_dem.jpg` | The same window in `dem_abp` at 0.25 ft contours. The corrected outline sits on the lidar ridge; the delivered one sits on the ground west of it. |
| `docs/alignment/survey_misfit.jpg` | The misfit surface: rms of (lidar z − surveyed z) over the 10 usable shots as a function of (dE, dN). One clear minimum. The `ift→usft` marker is the zero-free-parameter prediction. |
| `docs/alignment/ea_tin_tiles.jpg` | EA's existing TIN vs the lidar, per 400-ft tile, arrows ×300. Consistently ~0.3 ft east and ~0.1 ft south, everywhere. |

## 9. Scope

This is an investigation. **No app code, no data payload, no `datajs/` file and no golden
was changed.** The only files added are `tools/check_alignment.py`, this report and the four
figures.
