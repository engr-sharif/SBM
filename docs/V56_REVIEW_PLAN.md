# v56–v60 — the review round: the plan

2026-11-11. The contract for the work that follows the app-wide review. Five
steps, in the order the engineer approved ("all, in that order"). Each step is
its own pull request (two where a step is two things), is planned here before a
line of it is written, and ends with its harness block, its section in
`CLAUDE.md` and before/after pictures.

**The measure of this round is not how much it adds.** Every step removes a way
the app surprises its user: a setting nobody can see, a photograph that looks
different in the other view, a pointer that answers differently from layer to
layer, a panel in the way, a layer switch that rebuilds the world.

## Rules that hold for every step

1. **No number moves.** No kernel is touched (`VERSION` stays 10), no golden
   moves, the terrain source does not change. A step that needs any of that
   stops and asks.
2. **The three builds pass.** Phone and field layouts keep v11's chrome: every
   chrome change is scoped `body:not(.field)` unless the step says otherwise,
   and `test/e2e_field.mjs` / `test/e2e_phone.mjs` are the proof.
3. **An assertion that read the old behaviour moves; it is never deleted.** The
   fact asserted survives.
4. **Measured before and after.** Each step names its number (below) and the
   harness that produces it. Software GL is all this box has; anything that
   depends on a real GPU says so and is confirmed on the engineer's machine.
5. **Looked at.** Before/after pictures of every screen a step changes go to
   `dist/preview/` and to the engineer with the build.
6. **Who does what.** The design, the core of each step and every verification
   are done by the planner. Separable, table-driven work (per-kind chip
   builders, mechanical token replacement, fixed pauses in harnesses, call-site
   moves) is handed to a second agent in its own worktree with a written brief,
   and nothing it produces lands before the planner has read the diff and run
   the blocks.

What was measured before planning is in three inventories (settings,
hover/click, style/layout) and one probe (2D vs 3D over the same ground); the
numbers quoted below come from them.

---

## Step 1 (v56) — nothing changes the view without saying so

**The problem, measured.** The app remembers 23 keys and 24 named view
preferences. Fourteen of them change what is drawn; six have no control at all
(`backdrop`, `pixelRatio`, `drapeK`, `drapeFloor`, `terrainTiles`,
`gpuRaster`); several are read only at boot. There is no reset. The hazy-ground
report, the hidden sheet drapes of v25 and the "remembered solid ground hides
the TEM" trap are the same defect: *state the user cannot see is changing what
the user sees.*

### 1a. One table — `js/viewstate.js` (`SBMM.viewState`)

One registry of every state that (i) changes what is drawn or what an analysis
answers, (ii) is not at the value this device opens with, and (iii) has no
indicator of its own on screen. A row is

```
{ id, where: "2d" | "3d" | "both", is() -> bool, say() -> "what it is now",
  undo() }        // undo acts at once, through the owning module's own setter
```

The rows (each read through the owning module's API, never a second copy of the
state):

| row | is non-default when | undo |
|---|---|---|
| ground | explicitly see-through or hidden; or remembered solid while a TEM layer is on | `setGround("auto")` |
| sun | moved off "as photographed" | `sunAsPhotographed()` |
| rendering | `standard` on a device whose default is `realistic` | `setQuality("realistic")` |
| water surfaces / point names / water animation | off | on |
| backdrop | off | on |
| rendering overrides | any of the five console-only prefs set | cleared, terrain rebuilt |
| storm drains | master off, or N conduits marked broken | on / all working |
| solo | a group is soloed (the record now survives a reload) | restore the rows it switched off |
| my work hidden | a class row off while it holds features | on |
| layer at 0 % | a row on with opacity under 15 % | 100 % |
| tree height filter | minimum above 6 ft | 6 ft |
| layout forced | field or touch override set against what the device is | automatic |

Deliberately **not** rows: anything with its own chip or pressed button (TEM
on, the clip box, fly mode, relief, drape style, mesh detail), layer on/off
(the panel shows it), force-JavaScript kernels (changes nothing drawn).

### 1b. The chip

A status-bar toggle beside OSNAP (`#viewChip`, the idiom the bar already has):
hidden when no row is active; otherwise `view · N` in amber. Its popover lists
each active row as one line — what it is now, and one **undo** — and **undo
all**. In 2D only the `2d`/`both` rows count. Not in field mode (no status
bar there); the reset below is.

Re-evaluation is event-driven: `layers`, `view`, `mode`, `tem`, `pit`, and a
new `pref` event emitted by `SBMM.view.pref` on a write. No polling, no frame.

### 1c. Reset to defaults

One action — Help → Settings → **Reset to defaults…**, and `RESET` — behind
one confirmation that says what goes back and what is kept:

- **Goes back to how the app first opens:** layers and their order, panels,
  every 3D view setting, snaps, the map position and camera, storm switches,
  forced layouts.
- **Kept:** drawings, imported data, saved 3D views, saved layer presets,
  scenarios, the unlock and the idle-lock setting, the offline copy.

It is a **reload**, on purpose: ten of the settings are read only at boot, and
a reset that leaves half the old state in memory is the defect this step
exists to remove. Sequence: stop the debounced writers (`SBMM.view`,
`layerState` — the inventory found a queued write undoes a cleared key);
rewrite each key keeping only the work inside it (`camBookmarks`; layer-tree
`presets`); strip `layers` from the autosaved session so its restore cannot
bring the old layer state back; drop the first-visit stamp so the curated
default layers are applied again; set a one-shot flag; reload. On the next
boot the flag restores the autosaved drawings without asking and says so in
one toast.

### 1d. The View settings box

It is anchored to the bottom of the stage and grows upward, so each release
pushed its top further off a 900-px window. It becomes a bounded panel:
`max-height` = the stage between the 3D bar and its own anchor, scrolling
inside, in four titled groups — *Look* (rendering, ground, sun, drape/relief/
detail when the bar parks them), *Show* (water, names, animation), *Camera*
(field of view, sensitivity, fly speed, keep above ground), *Saved views* —
with the renderer line and the diagnostics button as its foot. Every id stays.

### 1e. The small traps found on the way (same family, fixed here)

- Solo's "put it back" record is kept with the layer-tree record, so a reload
  no longer strands a soloed group.
- Field mode's programmatic "standard detail" no longer writes the preference.
- Double-clicking a dock grip also forgets the stored width.
- The write-only `sbmm_cmdseen` key goes.

**Found while building it, and fixed in the same step** (each is in
`CLAUDE.md` "v56"): a reload has been losing every drawing since v9 (a
boot-time step overwrote the autosave before the restore bar read it); with
the backdrop off the 3D world beyond the survey drew white; every 3D-bar
reflow left empty rows behind in the View settings box.

**Acceptance (e2e, new last block "9zz. view state and reset"; it reloads, so
it runs after 9z):** every row — set it, the chip counts it and names it, undo
clears it and the module's own getter agrees; chip hidden at defaults; a 2D
view does not count 3D rows; reset with a drawing, a saved view, a saved
preset and an imported dataset in place brings every row back to default and
keeps all four; the popover is inside a 1440x900 window with every control
reachable. `voiceCheck` on the popover. Field and phone: no chip, `RESET`
works.

**Risk.** The reset touches the keys the harnesses seed (`sbmm.home.v1`, the
gate). The block seeds them again after its reset; the gate keys are never
written.

---

## Step 2 (v57) — the 3D ground is the photograph

**The problem, measured** (`fid` probe: the 2D map and a straight-down 3D view
of the same ground at the same scale, registered by cross-correlation, the
photograph alone as the reference):

| | brightness (3D / photo) | sharpness, brightness-normalised | "as if blurred by" |
|---|---|---|---|
| mine area at 1 ft/px | 0.83 | 0.51 | 0.61 px |
| mine area at 0.5 ft/px (the photo's own scale) | 0.84 | 0.33 | 0.84 px |
| ABP at 0.25 ft/px | 0.64 | 0.79 | 0.66 px |
| the same with the lights flat and occlusion off | **1.01** | 0.44 / 0.30 / 0.57 | |
| ... and trilinear filtering off | 1.01 | 0.70 / 0.32 / 0.60 | 0.45 / 0.77 / 0.58 px |

The texture path is neutral (1.01), so **the darkness is the light**. The
softness is the filtering: the mip blend where the photograph is minified, and
two bilinear resamplings (photograph to tile lattice, tile to screen) at its
own scale. The single-file build cuts its tiles from the photographs in memory
and measures the same as the folder build's tile files, so the tile files are
not a cause.

**Five findings decide the design** (the last two were found building it).

1. **The photograph is already lit.** Over 3.9 million open-ground cells of the
   mine area, the photograph's brightness was regressed on the terrain's
   sun-facing term for suns all round the compass. The fit peaks at azimuth
   180 (an independent confirmation of "as photographed"), with a slope of 0.52
   in log-log, and a Lambert-plus-fill model keeps improving up to a direct
   share of 0.7 — i.e. the photograph carries terrain shading about as strong
   as the 3D light applies. Lighting the draped photograph therefore shades it
   twice: a north-facing bench came out at 0.64 of the map.
2. **The fill light points north.** three's hemisphere light takes its "sky"
   from its own position, the default is +y, and +y in this scene is north. A
   north-facing slope has been lit by the sky and level ground by half of it
   since v15.
3. **v40's "0.86 of its albedo" was 0.77** once the sky's colour and (2) are
   counted, which is 0.90 on screen before occlusion and slope take the rest.

4. **The 3D picture was stretched 5 %.** Since the chrome began floating over
   the stage the canvas has been drawn 838 rows tall and stretched to 880 by
   CSS — 5 % too tall, and resampled once more.
5. **Round the 3-in photograph's border the 6-in one was skipped.** A terrain
   tile straddling the crop's edge was draped from the 3-in tiles over a
   1 ft/px ancestor.

**The rule: with the sun where the photograph has it, the 3D ground IS the
photograph.**

**Result** (`test/terrain3d.mjs --only fidelity`): brightness 1.01 / 1.00 /
1.00 of the photograph (was 0.83 / 0.84 / 0.64); blur 0.41 / 0.51 / 0.34 px
(was 0.61 / 0.84 / 0.66).

**Design.**
- *The photograph is shown as photographed and RE-lit.* In the ground's
  shader the photograph's colour is multiplied by (the light now) / (the light
  it was photographed in), both evaluated on the same normal. At the
  photographed sun that ratio is exactly 1. Moving the sun brightens what turns
  toward it and darkens what turns away. Above 1 the ratio is rolled off (no
  burn-out); below it is floored at the fill.
- *Cast shadows and occlusion come in with the relight.* The photograph holds
  its own shadows — cast by the same trees and roofs — and its own occlusion.
  With the sun as photographed the shadow map stands down on the ground and
  the lidar's occlusion is not laid over the photograph's; both fade in as the
  sun moves off (fully by 18 degrees).
- *Everything that is not a photograph is lit by the light itself*, and the
  light is re-levelled by one rule: level ground in the sun, at the elevation
  the photograph was taken, receives exactly pi. Roofs, trees and solids then
  return their own colour, and sit at the photograph's brightness. The fill
  light points up.
- *The lookup.* A level-of-detail bias toward the sharper mip everywhere; and
  near the photograph's own scale (under two texels a pixel) a Catmull-Rom
  reconstruction of the top level instead of bilinear — realistic rendering
  only, WebGL2 only. The values are chosen by the probe, top-down and oblique.
- Unlit analysis drapes and the shader rasters are untouched. A drape that is
  not the photograph (hillshade, slope, elevation) is never "shown as
  photographed".

**Acceptance (`test/terrain3d.mjs --only fidelity`, both builds):** at the
photographed sun, three frames (mine area at 1 and 0.5 ft/px, ABP at 0.25):
brightness 0.97–1.03 of the photograph; blur-equivalent no worse than the
figure the probe finds for the new lookup (recorded in the block); 2D and 3D
registered within 1 ft. With the sun moved 120 degrees the same frame must
differ (the relight is in force) and stay within 0.6–1.25. Block 9f14's
light-balance assertion moves to the new rule; the fill light's direction is
asserted.

**Cannot be finished here:** frame time and the real look on the RTX machine.
The step ends with a request for one paste of *copy 3D diagnostics*.

---

## Step 3 (v58) — one "what is this"

**The problem, measured** (23 inconsistencies in the hover/click inventory; the
ones that decide the design): four different chip elements; the 2D chip shows
a layer's facts while the 3D tip shows only its id; 3D opens a card by itself
after 550 ms and 2D never does; a raster's value is at the pointer for the TEM
slice, in the status bar for accumulation, and nowhere for slope, aspect,
elevation, land cover and isopach; storm structures, decision units and piles
answer in 2D and not in 3D; six analysis layers answer in 3D as "Design
feature" through the wrong builder; bare ground answers a 3D click and not a
2D one; overlapping things can be cycled in 2D and not in 3D.

**The behaviour, the same in both views:**

| | what happens |
|---|---|
| **hover** | ONE chip at the pointer. Line 1: what it is (name · kind). Line 2: its fact (a value with units, a depth, a class). Optionally a small graphic (the boring's mini log, the TEM core). Nothing opens by itself — the 3D dwell card goes, because the chip now says what the card was opened to say. |
| **click** | a card: the same builder in both views (`js/popups.js`), a Leaflet popup in 2D and the identify card in 3D. Over several things: "also here" in both. |
| **click your own drawing** | selects it; the Inspector shows it. No floating card in either view. |
| **click bare ground** | the Point card (coordinates, elevation, slope, and the reading of every analysis raster that is on) in both views — unless the click closed something, in which case it only closes it. |
| **a raster under the pointer** | its value in the chip, in both views, when no feature is under the pointer. The topmost raster that is on answers. |

**Design.**
- **`SBMM.tip` (`js/tip.js`)** — one chip element, `#tip`, fixed on the body,
  one placement rule. Three kinds of source may want it, in this order:
  `feature` (something with a name: the 2D pick engine, a 3D object),
  `surface` (a 3D surface that reads differently at every point of itself: the
  TEM sheets) and `readout` (nothing with a name, but a layer that is on can
  be read here). A source CLAIMS the chip when it has something to say and
  RELEASES it when it has not; the chip shows the highest claim. Nobody has to
  know who else is talking, and the order two animation-frame callbacks run in
  cannot matter. `#pickTip`, `#pick3dTip`, `#temTip` and `#waterTip` are gone.
- **Inside a polygon the reading rides along.** A decision unit, a lot or a
  catchment covers most of the ground an engineer looks at a raster over, so
  "feature beats raster" alone would mean the raster almost never speaks. A
  feature claim from a polygon's INTERIOR is `soft`: the chip names the
  polygon and carries the top reading on a second line.
- **`SBMM.readout` (`js/readout.js`)** — one registry of what a layer reads at
  a point: `register({ id, order, row | on(ctx), at(x, y, ctx) -> { name,
  value, lines?, html?, rows?, rec? } })`, registered by the module that owns
  the data. The first reader that answers, in a fixed order (an open analysis,
  the TEM maps, cut/fill and isopach, accumulation and land cover, the
  drainage classes, trees, then the terrain's own slope / aspect / elevation /
  canopy), is the chip; every reader that answers is a row of the Point card.
  A reader is on while its row is — except that `ctx.view` lets it say
  otherwise: in 3D the ground wears ONE drape style, which is the 3D view's
  own choice, and the TEM is a set of surfaces under the ground that answer
  where the ray hits them, not where the ground above them is.
  2D asks at the pointer; 3D asks at the ground point the per-frame status
  raycast has already found (no second raycast). Navigate mode only.
- **The dwell goes.** The 3D card that opened by itself after 550 ms, and the
  2D water chip that waited 550 ms, are both replaced by the chip saying it at
  once.
- **Chip content parity** — each kind's chip is one named function, owned by
  the module that owns the layer, used by the 2D layer's tooltip and returned
  by the 3D pick's `hit()` as `chip`.

**3b — the click, and what 3D does not answer yet.**
- **A bare-ground click** is one handler in both views: the top reader's own
  card where it has one (the TEM probe, the water description, a tree),
  otherwise the Point card with every reading on it. A click that closed a
  popup or cleared a selection does only that. In 2D the card waits out a
  double-click.
- **Your own drawing** selects in both views; the 3D floating card for it
  goes (the Inspector is the card). A photo keeps its picture card and the
  fence strip its nearest-boring card; field mode keeps the card.
- **"Also here" and Tab** in 3D: the ray's other hits, as in 2D.
- **3D kinds** — storm structures, decision units and piles become pickable;
  drainage, where-the-water-goes, streams, runoff, storm conduits and the PDF
  boundaries answer with their own builders; the DU and pile popups move into
  `js/popups.js`.
- **Highlight** — the 3D hover highlights the feature, not the whole merged
  layer (a halo built from the feature's own segments or faces).
- **Piles of points at whole-site zoom** — where symbols overlap they are drawn
  as one symbol with a count; the chip names them and the click offers them
  ("also here"). Nothing becomes unpickable: the v26 rule (shrink, never hide a
  click target) stands, and the count is drawing only.
- Field mode's 3D card becomes the bottom card; a long press means the same
  in both views.

Two pull requests: 3a the chip, the readout registry and the dwell; 3b the
click parity, the 3D kinds and the piles.

**Acceptance (e2e blocks 9f24, 9f25):** a table of (kind, point) pairs — for
each, the chip text in 2D equals the chip text in 3D, and the card's heading
and rows are equal; every analysis raster that is on answers at the pointer in
both views with the value the module's own accessor gives; no card opens on a
3-second dwell in either view; bare-ground click opens the Point card in both
and a click that closes a card opens nothing; no chip reads "feature" or
"Design feature"; an idle pointer still renders nothing (9e). Voice: no chip
carries an instruction.

**Risk.** This is the step most likely to move existing assertions (9c, 9f6,
9f7, 9f9, 9t2, 9f12b). They move with the behaviour; the dwell-card assertions
become "the chip says it".

---

## Step 4 (v59) — the chrome gets out of the way, and is one thing

**The problem, measured.** Docks 277 + 357 px = 44 % of a 1440-px screen
(collapse is not remembered and has no key); result cards are prepended and
never fold, in a 357-px column; the same TEM settings live on a card and in the
workspace panel, the ground mode in three places; 254 distinct colour literals
(118 of them chrome) against a 24-colour role set; 31 font sizes; 16 legend
implementations drawn four ways, one of which shows the value under the
pointer.

**4a. Layout** (first pull request)
- Docks: collapse is remembered; `[` and `]` fold the left and right dock and
  `\` folds both (a "just the map" key). The right dock keeps hiding itself
  when it has nothing to show.
- Results: the newest card is open and older cards fold to their title row
  (one click unfolds; nothing is removed, and the CSV still walks every row).
  Every card gets a **window** button: the card moves into a floating window
  on the sheet-window chassis, sized for reading, and back.
- One home per setting: the TEM workspace panel owns the TEM settings on a
  desktop and the TEM cards become summaries with the exports (a phone, which
  has no workspace, keeps the controls on the card); the ground mode is
  controlled from View settings and the TEM panel, and only shown elsewhere.

**4b. One set of colours and sizes** (second pull request, in two commits that
are verified differently)
- *Commit 1 — no pixel moves.* The 24 role tokens and a 6-step type scale are
  defined; every literal that equals a token (within 3 per channel; tints as
  `rgba(var(--x-rgb), a)`, not `color-mix`, for the iPhone) is replaced.
  Proof: a screenshot set of 14 screens, pixel-identical before and after.
- *Commit 2 — the deliberate changes.* The ~55 colours and ~35 sizes that do
  not fit a token are each either given the nearest role or kept as a named
  exception; every changed screen is looked at side by side. Data colours
  (class palettes, ramps, symbology, the log paper) are not touched and are
  fenced off in one block of `:root`. Dead rules and the two broken `var()`
  references found by the inventory go.

**4c. One legend** (third pull request) — `SBMM.legend({ kind: "ramp" |
"classes", stops | classes, title, units, min, max })`, one SVG renderer, and
a marker at the value under the pointer fed by step 3's readout registry —
so every colour-scaled layer gains what only the TEM legend has today. The
layer-tree legend card shows a raster's real ramp. Moved first: analysis,
accumulation, runoff, where-the-water-goes, cut/fill, isopach, rim band, 3D
elevation; then the TEM legends; the tree legend's controls and the print
sheets' colour bars stay where they are.

*As built (4c):* the renderer is CSS gradients rather than SVG (no gradient
ids to collide, and a transparent stop is just a stop). Moved: slope, aspect,
elevation tint, canopy, accumulation, cut/fill, isopach, rim band, land cover,
where-the-water-goes and the 3D elevation scale. **Not moved:** the TEM
legends — they are the model for this one, already carry the marker, and also
carry the draggable range; moving them changes nothing a user sees. Making the
legend honest found one defect: the elevation tint's two images were stretched
over two different ranges, so one colour meant two elevations.

**Acceptance:** frame width at 1440 with both docks folded and one key; folded
cards keep their rows in the CSV; the pixel-identical proof for 4b commit 1;
for 4c, each legend's stops equal the ramp the raster was painted with, and
the marker sits at the value the readout reports.

---

## Step 5 (v60) — under the hood

**5a. A layer switch rebuilds that layer.** Today any project-layer switch in
3D runs one 1,067-line function that rebuilds every project layer (76–141 ms,
4,000–6,000 draped lines). The function becomes a table of builders keyed by
`(group, layer)`, each owning one `THREE.Group`; a `layers` event rebuilds or
hides only its own. Labels and the lighter rendering's drop shadows are
collected per layer and merged at the end as now. The builders move out of
`js/viewer3d.js` into their own file by family — which is the split the
handover notes ask for, made where it pays. **Acceptance:** block 9y's parity
table unchanged; toggling one layer drapes only that layer's lines
(`frameStats`), and the before/after milliseconds are recorded.

*5a, the design, written before any of it is built.*

The function is 1,100 lines of `if (PROJ && <row is on>) { build it }`, all
adding into one group through three module-level targets (`addG`, `SHW`,
`OVL`) and `ptCand`. Two pull requests, because they are verified differently:

1. **Sections, in place.** Each `if (PROJ && …)` becomes `if (SEC("id") && …)`.
   `SEC(id)` answers whether this pass wants that section and, when it does,
   removes and disposes the section's previous group, makes a new one, and
   points `addG` / `SHW` / `OVL` / `ptCand` at that section's own — so the
   bodies do not change by a character, and a section whose row is now off is
   left with an empty group. Three kinds of pass: everything (as now), the
   user's features only (as now), and a named set of sections (new: the
   features are not touched). The finish merges what the sections collected:
   the drop shadows of the lighter rendering, the labels, the point-name
   candidates; wide lines are made for the rebuilt sections only.
   A row maps to its section by one table; a row the table does not know, a
   group switch and a bulk restore are a full rebuild, which is always right.
   `refreshOverlays(section)` lets a module whose own data changed name its
   section; with no argument it is the full rebuild it always was.
   Fixed on the way, each measured: the handler rebuilding while 3D is closed;
   an opacity change rebuilding geometry; nothing being disposed when a group
   is replaced; four accessors asking a checkbox whether a layer is on.
2. **The move.** With the sections in place the project half moves to its own
   file with its bodies still unchanged: the file names what it uses from the
   viewer once, at the top. Proof: a digest of every section (objects,
   vertices, a checksum of positions and colours) is identical before and
   after, on the full scene.

*5a as built.* Both parts are done. Measured on a full scene (framework,
design and investigations on, software rendering): a single-row switch went
from 150–680 ms and ~810 draped lines to 1–50 ms and that row's lines; 26 rows
switched off and on by themselves cost 768 ms in all, with no full rebuild,
and the scene afterwards is the scene a full rebuild draws. The GPU geometry
count, which grew by about 740 on every switch and never came down (4,383 to
13,835 over thirteen switches), is flat. The move's digest is byte-identical
before and after.

What does not change: one `overlayGroup` root (the pick engine, the TEM depth
fast path, the relief slider and the parity table all walk it); the feature
half; the order sections are built in.

**5b. Cheaper tests.** The ~430 fixed pauses in `test/e2e.mjs` are replaced by
conditions, block by block, each block run three times under load before and
after; CI runs the preflight and the node harnesses on a draft's pushes and
the full matrix when the pull request is marked ready. **Acceptance:** runner
minutes per merge, before and after; no block slower.

*5b as built, and what was not built.* Measured before any of it: the fixed
pauses in `test/e2e.mjs` are 506 and add up to **369 seconds** (each counted
once) of a run that takes about two hours per build under software GL — some
5 %. The time is in the frames (one to four seconds each on a software
renderer) and in the compute jobs, not in the pauses. So the pauses were NOT
rewritten wholesale: it is weeks of block-by-block browser time for minutes.
What costs runner minutes is running eighteen jobs (about 230 runner-minutes,
measured on #72) on every push, and that is what changed: a draft gets the
one-minute `quick` job; the matrix runs when the pull request is marked ready.

**5c. The map first.** Measure first: how many of the 82 MB a first network
visit needs before the 2D map can be used. If the terrain grids can land
after the map — `SBMM.elev` answering "not yet" and every boot-time reader
waiting on one `SBMM.demReady` — the plan for it is written then, with the
list of readers, before any of it is built. It is last because it changes the
boot contract and is the one item here that may be decided against.

---

## What the engineer is asked for

- One paste of **View settings → copy 3D diagnostics** from the RTX machine
  after step 2 lands.
- Whether the GitHub Pages site is still public (it serves the gate password
  and the protected cultural file to anyone with the link).
