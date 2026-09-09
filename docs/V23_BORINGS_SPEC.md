# v23 — The borings: a log viewer, a fence diagram, and the waste base

Status: **contract, 2026-09-09.** Phase A is being built; B follows A; C waits on
one ruling (§C.0). Nothing here changes a kernel (`js/compute.js` `VERSION`
stays 10) and nothing here changes what `tools/build_borings.py` computes — the
payload is the record and this round is about *presenting* it.

## 0. Why, in the engineer's words

> "I really think we need to take this function from the soil borings and log
> and really develop a more useful feature than just plotting them on the
> results section … since it's some of the most important data I think we need
> to make sure it's better represented in the app … I want this beautifully and
> usefully done."

The 2025 investigation is 44 holes, 476 strata rows, 516 SPT drives, 774 lab
values, 41 water records, and a logged waste/native contact in every hole. It
is the only direct evidence of what is *under* the surface the rest of the app
models, and today it is a 300-px strip in a results card. This spec makes it a
first-class instrument with four faces:

| face | the question it answers | where |
|---|---|---|
| **the log** | what is in this hole, at what depth, at what elevation | a floating log window, and a printed log sheet |
| **compare** | how do these holes line up | side-by-side columns on one elevation datum |
| **the fence** | what is between the holes along this line | a section drawn through the lidar with the holes projected on it, in 2D and standing in 3D |
| **the site** | how thick is the waste here, and how much is there | the borings coloured by what they found, a thickness map, and an interpreted waste-base surface the volume tools can dig to |

The organising idea: **a boring is a column of facts at a point; the app's job
is to put that column on the ground it was drilled through, beside the other
columns, at true elevation, and let the engineer read it at the scale a log is
read at.** Every view is the same column renderer (§1) placed differently.

## 1. The column renderer — one implementation, every view

`SBMM.borelogs.column(h, opts)` returns an SVG `<g>` (or a string) for hole
`h` at a given **scale** (px per ft), **datum** (`"depth"` from ground, or
`"elev"` ft NAVD88 with a `zTop`/`zBot` window), and **width tier**. The four
views call it with different options; nothing draws a stratum twice.

### 1.1 Graphic log symbols (ASTM D2488 / USCS)

One SVG `<pattern>` per USCS group, defined once in a `<defs>` the window and the
report both include, tinted by the class colour (`--bl-waste` / `--bl-native` /
`--bl-rock` / `--bl-unknown`, from `css/app.css :root`, read through
`SBMM.borelogs.classColor()` — the palette lives once):

| USCS | pattern |
|---|---|
| GW, GP | large open circles (gravel), scattered |
| GM, GC, GP-GC, GW-GM … | gravel circles over the fines pattern of the second letter |
| SW, SP | fine dots (sand) |
| SM, SC, SW-SC, SP-SM … | dots over the fines pattern |
| ML | short horizontal dashes |
| CL | horizontal lines |
| MH | long dashes |
| CH | close horizontal lines |
| OL / OH / PT | organic: grass-tick marks |
| Bedrock (any) | brick / `MUDSTONE` = dashed brick |
| no USCS | class tint only, hatched diagonally, so the reader sees "described, not classified" |

The **class** is the tint and the **USCS** is the pattern, so waste that is a
clayey sand reads as orange-tinted SC and native SC reads green-tinted SC — the
two facts the log states, both visible, never conflated.

### 1.2 What a column shows, by width tier

| tier | px wide | used by | shows |
|---|---|---|---|
| `mini` | 36 | popups, hover tooltip, the table row | class band only, contact tick, water tick |
| `stick` | 90 | compare, fence | graphic log (pattern + tint), USCS symbol, contact lines, water, N-value ticks |
| `full` | 300+ | results card (as today) | the current strip log |
| `sheet` | fills the window | the log window, the printed page | everything in §2 |

### 1.3 Two axes, always

Every column at `stick` and above carries **depth (ft bgs)** on the left and
**elevation (ft NAVD88)** on the right. The elevation axis is `h.elev − depth`.
`h.elev` is the surveyed ground elevation from the coordinate spreadsheet; the
renderer also asks `SBMM.elev(h.x, h.y)` and shows the difference in the
header (`Δ lidar −0.4 ft`). A hole whose two elevations differ by more than
2 ft gets a warn pill; it is not "corrected" — it is reported.

## 2. Phase A — the log window and the log sheet

### 2.1 The window

A floating, resizable window on the **sheet-window chassis** (`js/sheets.js`'s
`.shwin`: title bar, ⤢ maximise, drag, resize grip, the 4000–4899 band, Esc,
opens maximised under `body.touch`, becomes a full-screen sheet under
`body.field`). New module `js/borewin.js` (`SBMM.borewin`), loaded after
`js/borelogs.js`. It is ONE window (opening another hole reuses it), with a
toolbar:

```
[ SB-9 ▾ ]  ‹ ›   Log · Compare · Fence · Site · Table    scale [1"=5' ▾]  datum [depth|elev]   print  csv  png  ✕
```

- The hole picker is a typeahead over ids and waste areas (`SB-9`, `9`,
  `north waste`), grouped by waste area, each entry showing a `mini` column.
- ‹ › walk the holes in id order; `←`/`→` do the same; `+`/`−` change the scale;
  `Home`/`End` scroll to top/bottom; `Esc` closes.
- Opening the window from a popup, the `LOG` command, the table row or a 3D
  stick pick opens the **Log** tab on that hole. `LOGS` opens the **Table** tab.
- The results-card strip (today's `SBMM.borelogs.open`) stays as the quick
  view, gains an **open in window** button, and loses nothing.

### 2.2 The Log tab — a log sheet, on screen

Drawn at a real scale: **1 in = 5 ft** default (96 px per inch → 19.2 px/ft;
SB-10 at 126 ft is 2,420 px tall and scrolls), with 1 in = 2, 5, 10, 20 ft on
the menu and pinch-to-zoom under touch. Layout, left to right, the way a log
sheet is laid out:

1. **Header block** (sticky at the top while scrolling): project, hole id,
   waste area, E/N (EPSG:6418), lat/long, ground elevation (+ the lidar Δ),
   total depth, dates, driller / contractor / rig, logged by, checked by, the
   OpenGround-offset sentence, and the contact sentence from today's card.
2. **Depth** axis (ft bgs, tick every 1 ft, label every 5).
3. **Elevation** axis.
4. **Method / casing** band (hand auger, sonic; casing intervals) as thin
   vertical bars.
5. **Sample column**: each SPT drive as a box over its interval with the
   reference (`SS-3`), its N in a bar scaled 0–50 with refusal as a full red
   bar reading `50/5"`, recovery % as a thin fill; Shelby (`ST`) and
   Modified-California (`MC`) tubes with their own glyphs.
6. **Blows / 6 in** as three small numbers beside the drive.
7. **Graphic log** (§1.1) — the widest column, with the contact lines across
   it: the logger's remark bold, the strata reading dashed where it differs,
   bedrock top, the interlayered note where waste is logged below native.
8. **USCS** symbol.
9. **Description**, wrapped to the column, full text — the whole reason for
   the width. Sub-rows (colour changes inside a stratum) indented.
10. **Tests** at depth: PP (tsf) on its 0–4.5 scale; **pH** on 2–8 with the
    red rule at 4; and a lab column with WC / LL / PI / fines / DD / Su / C /
    φ / Cc / Cr as compact `key value` chips at their sample depth, hover for
    the interval and the method.
11. **Water**: the standard triangle at the encountered level (open) and the
    static level (filled) with the date; perched marked.
12. **Remarks** column: the log notes at depth.

A **depth cursor** follows the pointer across every column: a horizontal rule
with `12.3 ft · 1,354.2 ft` on the axes and the stratum, N and the nearest test
highlighted. Hovering a stratum in the window highlights the same interval on
the hole's 3D stick and in any open fence; clicking a stratum flashes the
boring on the map.

### 2.3 The printed log sheet

`print` opens the report engine (`js/report.js`) with **one Letter page per
5 ft/in of hole** — the header block repeated on every page, "page 2 of 3",
a legend strip on the last page, the watermark burned in like every export.
`print all` produces all 44 in id order as one document; `print area`
produces one waste area. This is the appendix the team hands out, and it has
to look like one: black on white, the class tints kept, the USCS patterns
kept, monospace numerals.

### 2.4 The Compare tab

Pick two to six holes (from the picker, or "these holes" from a map
selection, or a whole waste area). Columns at the `stick` tier stand on ONE
elevation datum — the tallest ground at the top — spaced evenly, with **their
actual horizontal separation printed** between them (so the reader knows 60 ft
from 600 ft). Correlation lines join the native contact, the bedrock top and
the water level across neighbours, dashed where a hole did not reach that
horizon. This is the fence without the ground; it is what §3 draws on top of
the lidar.

### 2.5 The Table tab

Today's `LOGS` table, in the window at full width: every column it has, plus
waste area, ground elevation, bedrock elevation, contact elevation, logged by,
date; sortable, filterable by waste area; a `mini` column in each row; click
opens the Log tab. `copy CSV` unchanged.

### 2.6 Seams

- **Hover a boring on the map**: a tooltip with the `mini` column and the
  three summary lines (through `SBMM.touch`'s chip on touch).
- **The popup** keeps its lines and its button; the button opens the window.
- **The 3D stick pick card** carries the same button; hovering a stratum in
  the window highlights the segment on the stick (`SBMM.viewer3d.datasetSticks`
  already maps segments to records).
- **The table drawer's Borings tab** gains a log button per row.
- **The layer-tree hover toolbar covers the dataset row's own buttons** (the
  `⋯` menu and `⤢` zoom, `.dsgear`/`.dszoom`) exactly as it covered the sheet
  rows' 3D button before `.lyr:has(.d3d) .ltacts{right:46px}`. Same fix, one
  rule: the toolbar shifts left of any trailing `minib` the row carries
  (`.lyr:has(.dsgear) .ltacts`), and the e2e asserts the two boxes do not
  overlap.

## 3. Phase B — the fence diagram

### 3.1 What it is

A **section through the subsurface along a line the engineer draws**, the
holes within a swath projected onto it, the lidar ground as the top, the
correlated horizons drawn between the holes. Feature type `fence` (a store
feature: serialises, undoes, exports, appears in My work under a new
*Borings* class row — appended, per the `CLASSES[4]` rule). Command `FENCE`
(aliases `PROFILE`, `GEOSECTION`); a button on the Fence tab; the sketch
engine draws the alignment exactly as a section set is drawn.

### 3.2 The drawing

- **Alignment** with CAD stationing (`0+00`, reuse `staLabel`), **swath** half
  width default 150 ft (a control); holes inside the swath are projected
  perpendicular onto the alignment and drawn at their station, each with its
  offset printed (`SB-9 · 42 ft L`).
- **Ground** along the alignment from the lidar (`SBMM.elev`, every 2 ft —
  `js/sections.js` samples the same way), drawn as the surface line; each
  hole's own ground elevation is a small tick on it, so a disagreement is
  visible.
- **Columns** at the `stick` tier, elevation-true, hanging from the ground.
- **Horizons**: the native contact, the bedrock top and the water level
  correlated between adjacent holes as straight segments, dashed where the
  next hole did not reach the horizon; the waste band between the ground and
  the contact **shaded** in the waste tint at low opacity. Correlation is
  linear between neighbours and says so — it is the standard first fence, not
  an interpretation.
- **Vertical exaggeration** slider (1×, 2×, 5×), the scale bar stating both.
- The **cut on the map**: the alignment with the swath as a translucent band,
  the projected holes as ticks, hover on the fence highlights the hole on the
  map and vice versa.
- Exports: PNG (watermarked), CSV (station, offset, hole, ground, contact,
  bedrock, water), and **DXF of the fence in section coordinates** (X =
  station ft, Y = elevation ft; a layer per horizon, a layer per hole column,
  text for ids) — the thing that goes straight into a Civil 3D section view.

### 3.3 In 3D

The fence stands in the scene: the drawn fence is rendered to a canvas
texture and mapped on a vertical strip along the alignment (one quad per
alignment segment, from the ground down to the deepest hole − 10 ft), double
sided, `userData.layer` tagged for block 9y, pickable (`fence` kind, the pick
card names the hole nearest the hit). The terrain is drawn over it where the
strip is below ground, so it reads as a cut — set `renderOrder` and
`depthWrite` so the strip is visible from either side without z-fighting.

## 4. Phase C — the site: thickness, contact and the waste base

### C.0 The ruling this needs

The borings carry a **Waste area** attribute (South Waste Rock Pile 10, North
Waste Rock Pile 8, Northwest Pit 5, Waste Rock Dam 5, Old Mine Building 4,
Tailings Pile 2, West Waste Rock Pile 2, Disturbed Rock 1, none 7). The app
has the traced **piles** and the six **decision units**. An interpolated
thickness map must be clipped to *something* — a TIN across the whole site
would bridge the North and South piles through ground nobody drilled. The
ruling needed: **which polygons bound the interpolation** — the pile
polygons, the DUs, or a new set of "waste area" polygons the engineer draws.
Until then §4.2 and §4.3 are not built; §4.1 needs no ruling.

### 4.1 Colour the borings by what they found

The borings layer gains a **colour by** control (in the dataset's `⋯` menu and
on the Site tab): *class at surface · waste thickness · contact depth ·
contact elevation · bedrock depth · groundwater depth · logged by · date*.
Graduated symbols with a legend swatch in the layer tree (the tree's own
`swatch` API), value labels at zoom ≥ 2 through `SBMM.labels` (priority 45,
key `boring:<id>`), and the same colours on the 3D sticks' collars.

### 4.2 The thickness map (after C.0)

Waste thickness (ground − logged contact) interpolated inside each bounding
polygon from the holes it contains (natural-neighbour over a TIN of the holes
plus the polygon boundary sampled every 20 ft at the nearest-hole thickness;
IDW as the fallback where a polygon has fewer than three holes), drawn as a
raster layer under *Investigations* with a legend, **"interpreted from N
borings — provisional"** in its row title, and hover reading the value plus
the nearest hole. A polygon with no hole inside it is left blank, never
guessed.

### 4.3 The waste base surface (after C.0)

The same interpolation as **elevation** (lidar ground − interpolated depth) is
registered as a read-only `type:"surface"` feature exactly the way EA's
recovered surfaces are (`js/refsurf.js` pattern: locked, not serialised,
rebuilt on boot, `props.ref = true`), so the existing **volume, isopach and
cross-section tools take it with no special case**: draw any polygon, choose
*interpreted waste base* as the base, and the volume is the waste inside it;
run the isopach over a DU and the map is the waste thickness. The card names
the borings that controlled the surface inside the polygon and flags any
polygon that fewer than three holes constrain. This is the number the
investigation was drilled to produce; it is also the one to be most careful
with, which is why every card says *interpreted* and prints the hole count.

## 5. Build order and acceptance

| phase | ships | acceptance |
|---|---|---|
| A | `js/borewin.js`, the column renderer in `js/borelogs.js`, the report sheet, the seams, the toolbar fix | e2e block **9af**: the window opens on SB-9 with every column of §2.2 present at 1"=5'; both axes; the depth cursor reports the stratum under it; `←`/`→` walk holes; Compare draws four holes on one datum with correlation lines; the printed sheet paginates SB-10 to 3 pages with the header on each; the toolbar no longer overlaps `.dsgear` (bounding boxes disjoint); field and phone blocks open the window as a full-screen sheet; block 9e's idle contract holds with the window open |
| B | the `fence` feature, the 2D drawing, the 3D strip, the three exports | e2e block **9ag**: a fence through SB-9/SB-10 finds the holes inside the swath at the right stations and offsets (±1 ft against a hand computation), the ground line agrees with `SBMM.elev` at every station, the contact correlation has one segment per neighbouring pair, the DXF parses back through `js/dxf.js` with the horizons on their layers, the 3D strip is drawn and tagged, and a session round trip rebuilds the fence with zero jobs |
| C | the colour-by control (C.1 now), the thickness raster and the base surface (after C.0) | the surface passes through the golden: a polygon around a single hole returns that hole's thickness × area within 2 %; every DU's volume card names its controlling borings |

`docs/HANDOFF.md` gets a decision row per ruling and the C.0 question in the
open items; CLAUDE.md gets a v23 section with the traps the build finds.
