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

**Status: BUILT (2026-09-10), REFINED (v24, 2026-09-18).** The v24 pass is
recorded in place below under **v24** headings: zero text overlaps, proven by
`test/borewin_overlap.mjs` and gated by e2e block **9ah**; one typographic
scale; a header strip of six facts with the rest behind `more`; the column
headings in a band that does not scroll; the depth cursor's reading in that
strip, pinned by a click; Ctrl+wheel zoom about the pointer; hover, focus,
empty and disabled states; and a printed header that leads with the same six
facts in the same order.

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
  `north waste`), grouped by waste area, each entry showing a `mini` column,
  its total depth and its native contact. **v24:** `ArrowUp` / `ArrowDown`
  walk the list and `Enter` takes the highlighted row (a typeahead whose only
  key is Enter is a text box with a menu behind it); the current hole is
  highlighted; and the id chip in the title bar opens it as well as the field.
  *Deviation: `←` / `→` keep walking the holes rather than opening the picker —
  block 9af's contract is that the arrows walk holes, and silently rebinding a
  documented key is a user-facing regression this round was not asked for.*
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

1. **Header block** (fixed, above the scrolling drawing). **v24:** it leads
   with SIX labelled facts and nothing else — the hole id, its waste area, the
   ground elevation with the lidar Δ, the native contact, the bedrock top and
   the groundwater — because those are what a reader checks before reading a
   single stratum. The other ten (coordinates, dates, method, driller, logger,
   total depth, base, the strata reading, the contact's source) are one click
   away behind **more**; the printed sheet prints all of them on every page, in
   the same order. Under the facts sits the **depth-cursor readout** (§2.2) and
   under that the **column-heading band**: the same list `column()` prints on
   paper, drawn once by `SBMM.borelogs.headingBand()` into a strip that is a
   sibling of the scrolling body, so a reader 80 ft down a log still knows
   which column is which. Every heading carries its unit (`FT BGS`, `SAMPLE ·
   N`, `BLOWS/6″`, `PP tsf`, `pH 2–8 · 4`, `ELEV ft NAVD88`).
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

A **depth cursor** follows the pointer across every column. **v24:** it is a
full-width hairline and nothing else — its reading (`12.3 ft · 1,354.2 ft ·
CL mine waste · MC-2 N 15 · PP 1.50 @ 5.8`) is in the header strip, where it
cannot land on the drawing it describes, and **a click pins it** (the label
says so; a second click releases it). Hovering a stratum highlights the same
interval on the hole's 3D stick; clicking one flashes the boring on the map.

**v24 — the scale, and the states.** The scale menu stays and `+` / `−` stay;
**Ctrl+wheel** zooms about the pointer and holds the depth under it (measured
to 0.02 ft — the anchor's inverse mapping must include the drawing's own top
margin, or it walks `PADT/ppf` feet a step). Every control carries a hover and
a `:focus-visible` ring; Compare with nothing chosen shows an empty state with
its chip list and a *nearest four* button rather than a blank panel; and a
control with nothing to do — a PNG of a table, `print` on a tab that is not one
hole, `through N holes` with fewer than two ticked — is disabled rather than
silently inert.

**v24 — ZERO TEXT OVERLAPS, AND IT IS PROVEN.** Every per-depth annotation is
placed through a LANE (one running stack per column, in depth order, that
pushes the next box down and refuses when there is no room); what is refused is
ELIDED, with its reading kept in the shape's own `<title>` and in `csvFor()`,
never overprinted. The horizon sentences became short tags in the one lane that
carries no other text. `node test/borewin_overlap.mjs` sweeps all 44 holes at
560 / 900 / 1,240 px plus six Compare sets, the fence at three widths and the
heading band, measuring every rendered `<text>` by its client rectangle:
**1,475 overlapping pairs before this round, 0 after**. E2E block **9ah** is
the gate at 560 and 1,240 px.

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

**Status: BUILT (2026-09-10), EXTENDED (v24, 2026-09-18 — §3.4).**
`js/fence.js` (`SBMM.fence`), the Fence tab in
`js/borewin.js`, `SBMM.dxf.writeEntities`, the `fence` feature type through the
five FeatureGroup places in `js/tools.js`, a **Borings** My-work class row
appended to `CLASSES`, the `fence` mode, `FENCE` (`GEOSECTION`,
`FENCEDIAGRAM`), the 3D strip and the `fence` pick kind. E2E block **9ag**, one
assertion each in `test/e2e_field.mjs` and `test/e2e_phone.mjs`, shots
`test/fence_shots.mjs`. Deviations are noted in place below.

### 3.1 What it is

A **section through the subsurface along a line the engineer draws**, the
holes within a swath projected onto it, the lidar ground as the top, the
correlated horizons drawn between the holes. Feature type `fence` (a store
feature: serialises, undoes, exports, appears in My work under a new
*Borings* class row — appended, per the `CLASSES[4]` rule). Command `FENCE`
(aliases `GEOSECTION`, `FENCEDIAGRAM` — **not** `PROFILE`: that is the
elevation-profile command's own name, and an alias resolves first-match over one
flat table, so claiming it would have killed the profile tool silently); a button on the Fence tab; the sketch
engine draws the alignment exactly as a section set is drawn.

### 3.2 The drawing

- **Alignment** with CAD stationing (`0+00`, reuse `staLabel`), **swath** half
  width default 150 ft (a control, and `FENCE <ft>` sets it as the tool is
  armed); holes inside the swath are projected
  perpendicular onto the alignment and drawn at their station, each with its
  offset printed (`SB-9 · 42 ft L`).
- **Ground** along the alignment from the lidar (`SBMM.elev`, every 2 ft —
  `js/sections.js` samples the same way), drawn as the surface line; each
  hole's own ground elevation is a small tick on it, so a disagreement is
  visible.
- **Columns** at the `stick` tier, elevation-true, hanging from the ground.
- **Horizons**: the native contact, the bedrock top and the water level
  correlated between adjacent holes as straight segments, dashed where the
  next hole did not reach the horizon. Correlation is linear between
  neighbours and says so — it is the standard first fence, not an
  interpretation. *(v24 replaces the single shaded waste band with the class
  bands of §3.4.)*
- **Vertical exaggeration** slider (1×, 2×, 5×), the scale bar stating both.
  *Built as a three-way select rather than a slider: three values are three
  values, and a slider with three stops is a select wearing a costume.*
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

### 3.4 v24 — through the holes, and unit-level correlation

The engineer: *"the fence does kind of a poor job connecting different borings
together."* Two additions, both keeping the existing fence working.

**A fence THROUGH named holes.** `FENCE SB-9 SB-10 SB-11`, or ticking holes in
the Fence tab's list, builds the alignment as the polyline **hole to hole** —
each boring at its own vertex, station along the polyline, offset 0 — and there
is **no swath**, because the holes were named rather than caught. The feature
stores `props.through = [ids]` and `mkFence` re-derives from it, so a session
round trip rebuilds it with zero compute jobs; the map draws the alignment
through the holes with no band. The named holes are still *projected* onto the
current polyline, so an alignment the user later edits reports honest offsets.

**Unit-level correlation, on every fence.**

- **(a) The CLASS bands** — waste, native, bedrock, in that stratigraphic order
  — are correlated between adjacent holes as **filled polygons**: each band's
  top and base joined linearly to the next hole's, so the waste body reads as
  one shaded band of varying thickness, native beneath it, rock under that.
  **The band boundaries are the LOGGED CONTACTS and nothing else** (ground →
  the logger's native contact → the top of bedrock → the terminated depth):
  deriving them from the strata runs would put the app's quieter second answer
  beside the one it leads with everywhere, on the same drawing, for exactly the
  18 holes whose two statements disagree.
- **(b) Inside a class band the USCS units are matched in order** where both
  holes carry the same pattern family (`famOf`), by a longest common
  subsequence over the families — deterministic, never crossing two links, and
  it cannot match a sand to a clay. A thin line joins matched unit tops, solid
  where the full USCS symbols agree and **dashed where only the family does**.
  A unit present in one hole only **pinches out to a point at the midpoint of
  the span** (a dashed wedge). **A unit with no USCS family is neither matched
  nor pinched**: "described, not classified" is what the graphic log's hatch
  already says, and a wedge for it would claim the unit ends at mid-span, which
  is a statement about ground nobody drilled.
- **(c) A hole that did not reach a horizon** ends that band's polygon with a
  dashed edge, as before.

The rule is stated once on the drawing and once on the card: *class bands
correlated linearly between adjacent holes · units matched by USCS family ·
pinch-outs at mid-span · lidar ground Jan 2024*. The true hole-to-hole distance
is printed once per span. Exports: the CSV gains the class-band top and base
elevations per hole; the section DXF gains a **closed polyline per class band
per span** on `FENCE-BAND-WASTE` / `-NATIVE` / `-BEDROCK` — which is what a
drafter hatches — with the links and pinch-outs on `FENCE-UNITS`. The 3D strip
follows automatically: it is textured from the same SVG.

Acceptance (e2e **9ag**): `FENCE SB-9 SB-10 SB-11` gives three columns at
offset 0 with stations equal to the cumulative hole-to-hole distances (against
arithmetic the harness does itself); the band polygons are exactly one per
class both holes of a span state; every family one hole of a span carries and
the other does not appears as a pinch-out (a reference the harness computes
independently, because no matching rule could pair it); the DXF band layers
parse back through `js/dxf.js` as closed quadrilaterals; and a session round
trip rebuilds the through-fence with zero jobs.

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
| B **(built)** | the `fence` feature, the 2D drawing, the 3D strip, the three exports | e2e block **9ag**: a fence through SB-9/SB-10 finds the holes inside the swath at the right stations and offsets (±1 ft against a hand computation), the ground line agrees with `SBMM.elev` at every station, the contact correlation has one segment per neighbouring pair, the DXF parses back through `js/dxf.js` with the horizons on their layers, the 3D strip is drawn and tagged, and a session round trip rebuilds the fence with zero jobs |
| C | the colour-by control (C.1 now), the thickness raster and the base surface (after C.0) | the surface passes through the golden: a polygon around a single hole returns that hole's thickness × area within 2 %; every DU's volume card names its controlling borings |

`docs/HANDOFF.md` gets a decision row per ruling and the C.0 question in the
open items; CLAUDE.md gets a v23 section with the traps the build finds.
