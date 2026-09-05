# SBMM Site Explorer — v9

Release notes, 2 September 2026. Author: Mohammad Sharif (Jacobs, Task 2.1.5).

Three files ship together and are built from the same source:

- **`SBMM_Site_Explorer.html`** — the single-file build (~133 MB). Double-click it.
  Everything is inside it: terrain, imagery, the drawings, the data. No server, no
  install, no network.
- **`SBMM_Site_Explorer_field.html`** — the same app at **~65 MB**, for the phone
  (new in v9.6, below).
- **`sbmm-site-explorer/`** — the same app as a folder (`index.html` + `js/` +
  `datajs/` + `vendor/`). Use this one if you want to read or change the code, or
  to host it internally.

All three are offline-only by design. Nothing in this app calls out to the internet.

---

## v9.16 — the heavy analyses run in a compiled core

The drainage map, the overtopping flood, the raindrop, volumes and contours are loops
over millions of grid cells, and they were the slowest thing in the app. They now run in
a small compiled **WebAssembly** core when your browser has one, which every browser on
your desk and on the iPad does.

**Nothing about the answers changed, and that is checked rather than claimed.** The
original JavaScript calculations are still in the app — they are the reference, and they
are what runs if the compiled core will not load for any reason. Every calculation is run
BOTH ways on the same job and the two results are compared number for number, including
the rasters, before anything ships: **every one of them is bit-for-bit identical**. Pile
1 still comes out at 278.5 yd³ against the published 278.4, computed by the new core.

What you will notice: contours redraw in a blink rather than a beat, the drainage map and
the overtopping analysis finish in roughly half the time, and a volume is instant. On the
build box, measured side by side in one run:

| | before | after | |
|---|---|---|---|
| contours over the site window | 199 ms | **12 ms** | 16× |
| the Herman overtopping flood, drains on | 4.4 s | **2.1 s** | 2.1× |
| the raindrop, chained through the storm network | 4.4 s | **2.3 s** | 1.9× |
| the drainage map, whole site at 2 ft | 5.5 s | **3.7 s** | 1.5× |
| the drainage map, whole site at 4 ft (the phone) | 1.3 s | **0.7 s** | 1.8× |
| a volume over a traced pile | 10 ms | **2 ms** | 5× |

The drainage map is the one that gained least, and it is worth saying why rather than
leaving it looking like a disappointment: at 2 ft that map is 21.6 million cells and the
work is moving half a dozen 86-megabyte arrays around, not arithmetic. Compiling the
loops does not make the memory faster. It is a real 1.5×, and the first run after you
open the app is a little slower again while the core claims the memory it needs.

Every results card now says which of the two computed it and in how many milliseconds, so
you can see it for yourself; Help has a **Force JavaScript kernels** switch if you ever
want to compare. It works in all three copies of the app — the folder, the single file and
the field build — because the core ships inside the file the same way the terrain and the
imagery do. Nothing is downloaded, and the app still makes no network calls at all.

---

## v9.15 — the tests, made quick

You asked why a round takes "hours and hours". Measured on the cloud box: a desktop
end-to-end run is eleven minutes, the full matrix forty to seventy, only one browser can
run at a time, and a failure in the last section meant running the first forty again from
the top. None of that was about the app — it was about how the tests were run. So this
release changes that, and **nothing about what any test checks**: every assertion line the
harnesses printed before this release is printed, identically, after it.

**One command.** `node test/run.mjs` now runs the whole thing: it builds both single-file
copies, runs every harness against the right build in the right order, runs the
independent ones side by side where the machine has the cores, writes a log for each one
and prints a table at the end saying which passed, how long each took, and the first
failing line of any that did not.

**A one-minute loop to work in.** `node test/run.mjs --quick` — a preflight, the gesture
tests and every calculation kernel except the slow drainage one — is what gets run after
every edit. The browser is only for when that is green.

**A preflight that costs three seconds.** Before any browser opens, the runner checks the
things that have actually broken this project before: a file that does not parse, a
command shortcut that quietly shadows another one, a new module missing from the app's
script list (which would drop it silently out of both single-file builds), and a symlink
committed by accident — the one that broke the GitHub Pages copy of the site.

**A failing section can be re-run on its own.** Every section of the big harnesses now has
a name, and `--only 9t` runs just that one: forty-eight seconds instead of eleven minutes.
A full run is unchanged, and that was the acceptance test for the change.

**Two browsers can no longer collide.** Starting a second one while the first is running
used to crash the renderer and look like a test failure; it is now refused, by name, with
the pid of the run that is holding it.

**Your GPU machine, used.** `SBMM_GPU=1` runs the same tests on a real graphics card
instead of the software renderer this box has — and the time limits drop from three
minutes to one because they can. On a machine without one it says so rather than
pretending.

**And the tests run on GitHub too.** Every pull request now runs the matrix on GitHub's
own machines, five jobs at once, with the logs and screenshots attached to the run.

---

## v9.14 — the iPad, the Pencil, and touch everywhere

You said the app was already working on your iPad, that you had saved it to the home
screen, and that you wanted it to be *properly* good there — especially the 3D view, and
pinch-and-zoom in the sheet viewer. Then you said the Pencil was a must. Here is all of it.

**The iPad keeps the layout you liked.** It is not switched into the phone layout — the
docks, the top bar and the floating sheet windows all stay. What changes is everything
that quietly assumed a mouse. The app works out for itself whether it is on a desktop, a
tablet or a phone (and an iPad in Split View crosses that line and comes back on its own);
**Help → Touch controls** overrides it if the guess is ever wrong.

**The 3D view now handles like a map.** One finger orbits and keeps drifting when you let
go. Two fingers pinch to zoom **towards the point between them** — that patch of ground
stays under your fingers instead of the view sliding off to the orbit centre — drag to
pan, and twist to swing the view round by the angle you turned. Three fingers tilt.
Double-tap centres and zooms in; a two-finger tap zooms out. A press and hold identifies
what is under your finger, and on a vertex handle it starts dragging it. There is a
four-button nav pad in the corner for zoom and tilt.

**The sheet viewer opens maximised and pinches properly.** Pinch about a point and that
point stays put; two fingers pan, one finger pans, double-tap zooms in, two-finger tap
zooms out. Every button on the window is a full-size target and the toolbar wraps rather
than sitting on top of the drawing. There is a maximise/restore button on every window now,
on the desktop too.

**Placing a point precisely, with a finger.** Your fingertip covers the thing you are
placing, so on touch a vertex is *press, hold, slide, lift*: a magnifying **loupe**
appears with a crosshair on the exact spot, you slide until it is right, and the point
lands where you lift. A **Done / Undo vertex / Cancel** bar appears while you are drawing,
because there is no Enter or Esc key under a thumb. Same on the map and inside a drawing.
Press and hold is the right-click everywhere, every layer row has a visible **⋯** for the
tools that appear on hover on a desktop, and holding a button shows its tooltip (which is
where the keyboard shortcut is written) without firing it.

**The Apple Pencil.** The Pencil is treated as what it is — a precise pointer. A pen tap
places a vertex exactly where the tip is, with no loupe and the same snapping a mouse gets.
Hovering the tip moves the object-snap glyphs and the 3D highlight. Your palm is ignored
while the tip is down. In 3D a pen drag orbits, a pen tap picks, and a pen drag with a
finger held down pans.

**Redlining, new.** `REDLINE` (or `MARKUP`, or `INK`) is freehand ink, on the map **and**
inside a sheet window — a circle round the thing that is wrong and an arrow to the note.
Pressure drives the line width, there are six colours and an eraser, and every stroke is
one undo. A stroke is not a picture: it is a real feature in State Plane feet, so it
appears in My work, travels in the session file, exports to GeoJSON and to DXF on a
**REDLINE** layer, drapes over the terrain in 3D, and prints in the report in its own
colour. Scribble works in every text box.

**A real home-screen app, and an offline copy.** Added to the home screen it opens full
screen with its own icon and no browser chrome. Over a web address, **Help → Make
available offline** downloads the whole thing to the device in one tap, with a progress
count — after that it opens with no signal at all, tells you when a new version has been
deployed, and lets you remove it again. (Opened as a plain file, as you do today, nothing
changes and the button says why.) There is one thing to decide about this: GitHub Pages
will not serve a private repository on the free plan, and this repository must stay
private — so a web address means either a paid GitHub plan or an internal Jacobs host.
Everything else in this release works exactly the same double-clicked.

**Using the iPad properly.** The 3D view runs WebGL2 with anisotropic filtering on the
terrain imagery, which is what a hillside seen edge-on actually needs. Mesh detail defaults
to standard on an older iPad and high on an M-series one, and remembers whichever you pick.
The compute workers scale with the number of cores instead of being fixed at one. A lost
graphics context — which iPad Safari does under memory pressure — is rebuilt and says so,
instead of leaving a black rectangle. The screen stays awake while Position or a long
calculation is running. Exports go to the iPad **share sheet** (Files, AirDrop, Mail), and
a CSV, GeoJSON, DXF or session file dragged in from the Files app in Split View imports.
**Position**, **Photo**, **Note** and **Samples nearby** are now reachable from a
**Field ▾** menu in the top bar, without switching to the phone layout. And Help shows the
build, the profile, the pixel ratio, the GPU and the worker count on one line — read that
back if anything ever feels slow.

**Nothing about the desktop changed.** That is not a hope: the desktop test suite is the
same file it was, and it passes unchanged, which is what proves it.

---

## v9.13 — a design storm on the site

Phase 1 (v9.10) told you where every acre of the site drains to. This tells you **how
much water gets there in a storm** — over the same catchments, so the two can never
disagree about which ground drains where. You said "go with your best assumptions and
make the best choices possible", so every assumption is made, **printed on the card,
printed first on the report sheet, and changeable in one dialog**.

**Type `RAIN`** (or `RUNOFF`, `DESIGNSTORM`). Pick the storm — 2-, 10-, 25- or
100-year 24-hour, the 25-year 1-hour for a pipe check, or a custom depth and duration —
and run it.

### What comes back, for the 25-year 24-hour storm

6.4 inches of rain, a composite curve number of 82 over the 978.5 surveyed acres, and
**357 acre-feet of runoff**:

| catchment | acres | CN | runoff | volume | Tc | peak (SCS) |
|---|---|---|---|---|---|---|
| Clear Lake — direct overland | 403.05 | 82 | 4.36 in | 146.5 ac-ft | 21 min | 565 cfs |
| Off the surveyed ground | 293.45 | 81 | 4.25 in | 103.9 ac-ft | 6 min | 429 cfs |
| Clear Lake outfall (the storm network) | 281.99 | 84 | 4.53 in | 106.3 ac-ft | 17 min | 425 cfs |
| **the whole site** | **978.49** | **82** | — | **356.7 ac-ft** | — | **1,396 cfs** |

**None of the three ponds overtops in this storm.** The Herman Impoundment rises
0.8 ft, from the surveyed 1,336.45 to 1,337.27 — four and a half feet below the
1,341.55-ft invert of the two 24-in discharge pipes, so the storm never reaches them.
Frog Pond fills 0.75 ft and leaves through the pond culvert at 1,415.74, a third of a
foot below its rim. Green Pond is contained a foot and a half below its outlet. Each
pond is routed properly — level-pool (Modified Puls) through the same stage–storage
table the overtopping tool draws, with a broad-crested weir over the rim.

### The assumptions, and where each one came from

- **Rainfall — NOAA Atlas 14, and it is PROVISIONAL until you or I bake the export in.**
  The app has no network by design, so the depths ship as a payload. Right now they are
  my approximate values for this location and **the card says so in red**. Fixing it is
  five minutes and no code: pull the point estimates for 39.003 N, 122.663 W from the
  NOAA PFDS, save the CSV as `data/atlas14_sbmm.csv`, run `tools/build_rainfall.py`.
  Every number above moves with the real depths, and the warning disappears by itself.
- **Runoff — NRCS curve number** (TR-55), `Q = (P − 0.2S)²/(P + 0.8S)`, AMC II. The
  method every drainage report in this county is written with.
- **Soil group — D for mine waste, tailings, waste piles, decision units and compacted
  fill; C for everything else.** There is no SSURGO and no infiltration test on hand.
  This is the biggest assumption in the whole chain and it is on every card and sheet.
- **Land cover — a 2-ft raster built from what we already have**: EA's water, building
  and road layers, the decision units and traced waste piles, the canopy height model,
  and the orthophoto (a green-excess index splits bare ground from vegetated). Over the
  surveyed site: grass 661 ac, bare or disturbed 167, woods 57, gravel road 38, water
  26, paved 12, mine waste 11, roofs 6. **Draw an area, give it a cover class, and the
  storm counts it that way** — the override saves with the session like anything else
  you draw.
- **Time of concentration — TR-55 chapter 3** along the longest flow path the drainage
  map already found: sheet flow for the first 100 ft, then shallow concentrated, then
  channel.
- **Peak flow — both methods, labelled.** Rational (`Q = C·i·A`) for a culvert check up
  to 200 acres, and an SCS unit hydrograph everywhere. On this site all three catchments
  are over 200 acres, so the card says "not reported above 200 ac" rather than giving
  you a number the method does not support.
- **Pipe capacity — not modelled, and it says so.** A conduit with no surveyed size or
  invert passes its inflow and the card reads "capacity unknown — survey pending". When
  you survey the inverts, that is the one thing that changes.

### What you get out of it

A results card with the catchment table, the pond routing rows, every assumption
underneath and a hydrograph you can switch between catchments; `copy CSV` for all of it;
and a **report sheet** (Print → PDF) that leads with the assumptions table before a
single quantity. Two new layer rows under **Design storm (rainfall + runoff)** in Site
framework: the land-cover raster with a legend naming each class's curve number, and the
runoff depth as a shaded map.

One small change to a keyboard habit: **`RAIN` now opens the design storm**, not the
raindrop. The raindrop keeps `DROP`, `RAINDROP`, `WATERDROP` and `FLOW` — a command
alias can only belong to one command.

**What this is not:** a rain-on-grid simulation. No infiltration model beyond the curve
number, no seepage, no evaporation, no pipe capacity, no continuous simulation. It is a
planning-level drainage calculation of the kind a site report is written with, and it
tells you which assumption every number rests on.

## v9.12 — the layers system

You asked for the layers to be managed and presented properly, now that there are about
120 of them. The Layers tab is a real tree.

**Sub-groups.** Related rows sit together in a named sub-group that collapses on its own —
*Storm drainage*, *Drainage (lidar + storm drains)*, *Survey — Aug 2026*, *Design areas*,
*Boundaries*, *Existing conditions*, *Sheets (draped)*, *Design surfaces — EA* and
*— mine*, *Drawing set*, *Datasets*, *Contours — lidar survey*, *Terrain analysis*. Each
one carries its own count, and the tree remembers what you left open.

**A row now looks like what it draws.** The colour square is gone: a line layer shows a
line in its own colour, weight and dash pattern; a polygon layer shows a filled polygon; a
point layer a point at its own size; imagery a band. It is the same symbology Leaflet was
given, read off the layer itself, so it cannot drift out of step with the map.

**Hover a row** for four buttons: opacity, **zoom to this layer**, **solo** (everything else
in that group off — click solo again and the group comes back exactly as it was; alt-click
the tick box does the same), and **info** — what the layer is, where it came from, how many
features, the CRS, and for a CAD row a link straight into the Layer manager on that group.

**Drag a row by its grip and the drawing order follows.** The row at the top of a list is
drawn on top of the ones under it. Your order is remembered, and it travels in the session
file, so a session you send someone opens looking the way you left it.

**Search** — the box at the top, or press `/` anywhere in the tab. It filters the whole
tree as you type, over the layer name, its sub-group, its group and its internal id; the
groups holding a match open themselves and everything else gets out of the way. Esc clears
it, Enter toggles the first match. The arrow keys walk the tree, Space toggles a row, and
Left/Right collapse and expand.

**Presets** — named layer states, applied in one click: *Terrain*, *Design review*,
*Water & drainage*, *Investigations*, *Field*, *Everything on*, and any you save yourself.
Applying one is a single undo, so you can always get back. **A preset never switches on the
cultural resources group** — that group is still something you tick yourself, and it still
asks you first. The last five rows you changed sit as chips under the search box.

**A legend on the map.** Bottom-left, collapsible: every layer that is currently showing,
with its symbol, grouped, and an "only" button beside each to isolate it. On the phone it is
off the map by default and lives in the More sheet, so it never eats the screen.

Each group header gained "n of m on" and, on hover, all on / all off / expand all / collapse
all. Rows are 44 px in field mode, so all of it works with a thumb.

Nothing about what a layer IS changed: the same rows, the same names, the same ids, the same
one answer to "is this layer on" in 2D, in 3D, in the sheet windows and in the exports.

## v9.11 — the overflow follows the pipes, and the 3D view

Three things you asked for, in your words.

**"if the frog pond does overflow it will flow into green pond first not out and up
north."** It does now, and nothing says otherwise. When the analysis finds a storm
inlet below the rim — Frog Pond's culvert, Green Pond's FES, Herman's surveyed 24-in
pipes — that conduit **is** the overflow, and it is the only route drawn. The rim spill
is still on the card as a fact:

> Rim spill (lidar) — 1,416.04 ft · +0.30 ft above pond culvert — not traced; the drains
> are assumed to handle it

…and the rim band and the ranked rim lows are painted exactly as before. What is gone is
the blue line running north over the ground, and the row that used to claim water went
that way now reads *"not traced — the drains are assumed to carry it"*. The chain reads
back as a sentence built from the route itself:

> → Green Pond (fills to 1,394.50) → green outlet → road drain → branch → storm main →
> Clear Lake outfall

If you want to see what happens with the culvert blocked, there is a **trace the rim
overflow** button on the card. It draws that route dashed, in a muted grey that is
neither the water blue nor the storm blue, and names it *what-if: pond culvert blocked*.
It belongs to the analysis: press the button again, or clear the analysis, and it goes.
No number moved — Herman's 1,336.45 / 1,341.55 / 1,343.54 / 1,343.84 sequence and every
storage figure are exactly what they were.

**"the labels for the rim labels are not adjusting to the level im looking at."** The 3D
labels are a proper layer now: chips that stay the same size on screen at any range, on a
dark plate, with a leader down to the thing they are about — and they **restate
themselves at every step of the slider**:

| below the level | at or past it |
|---|---|
| rim low 2 · 1,344.34 · **+0.39 ft to go** | rim low 2 · 1,344.34 · **overtopped** |
| first discharge · pond culvert · 1,415.74 · **+0.74 ft to go** | · **discharging** |

plus *water level 1,343.95 ft* on the water surface itself.

**"it puts the text inside like multiple times."** It did, and it was not only there.
Every permanent label on the map — pond levels, flow ends, the ranked rim markers,
catchment acreages, excavation depths, the "in pipe" tags — now goes through one engine
that does two things: it shows the **same fact once** however many features state it, and
it **stops two labels landing on each other**, keeping the more important one and hiding
the other until it fits again. The 3D view does the same. On the phone too.

**And the 3D view generally.** A gradient sky with the horizon fog matched to it, so the
edge of the survey fades instead of stopping dead; a lake-coloured ground under the
model; a **sun azimuth and elevation** you can swing in View settings, so the relief can
be lit the way the 2D hillshade is lit. Lines carry a dark shadow a foot beneath them,
which is what makes them readable over the orthophoto; points are discs with a dark ring
instead of hard squares; the selected thing gets a halo that pulses for a moment. **Look
at…** centres the view on a point you click, there is an elevation legend, and the number
keys 1, 2, 4, 5, 6 (and Shift+3) snap to the six views — <kbd>3</kbd> still opens and
closes 3D and <kbd>F</kbd> is still fly mode, so nothing you already use has moved.
Shift+F fits to what is selected.

Under all of that: a **parity table** now runs in the test suite. For every layer switched
on, the 3D scene has to contain something for it. That found and fixed a list of things
that were on in 2D and simply absent in 3D — EA's PDF-traced boundaries, the two survey
contour sets (both drew whenever either was ticked), the computed contour set,
cross-section station lines and chainages, EA's four recovered design surfaces, the
drainage flow paths, and the cultural layers' points. The two things that stay 2D-only
are the basemap rasters (in 3D those *are* the terrain drape) and EA's 22,000-entity CAD
base map, which the 3D view cannot resample on every redraw; the design layers are drawn.

---

## v9.10 — the drainage map

You asked me to "start thinking about catchment areas for the entire site, like
simulating rainfall and where those would go". That is three questions with three
different levels of assumption, and this is the first of them — the one the lidar can
answer on its own.

**Type `DRAIN`** (or pick *Drainage map* from the Water ▾ menu, or tick a row under
**Drainage (lidar + storm drains)** in Site framework). About ten seconds later the whole
site is coloured by the outlet each square foot drains to:

| where it goes | acres | share |
|---|---|---|
| Clear Lake, overland | 403.1 | 41 % |
| off the surveyed ground | 293.5 | 30 % |
| the Clear Lake outfall, through the storm network | 282.0 | 29 % |
| **surveyed total** | **978.5** | |

Switch the storm drains off (`STORM`) and the map re-computes itself: the outfall's 282
acres split back to the lake and off-survey, because the impoundment then fills to its
1,343.84-ft rim and spills over it instead of leaving through the two 24-in pipes. That
difference — 282 acres of the site — is the same thing the invert survey will settle.

**It is the raindrop, run everywhere at once.** Same terrain, same filled DEM, same
ponds, same pipes. A drop dropped anywhere on the map lands in the catchment drawn under
it, and the test suite proves it a hundred times over rather than assuming it.

Three layers, and a second question answered beside the first:

- **Catchments — by outlet.** Where it finally ends up.
- **Catchments — by first capture.** The first pond or storm inlet it reaches on the way
  — "what drains into Green Pond" is 2.6 acres, into Frog Pond 14.5, into the Herman
  Impoundment 37.9.
- **Flow paths.** The longest single path inside each catchment, drawn as it runs.

Hover a catchment and it brightens and names itself. Click it for the acres, the share of
the site, the longest flow path (overland — a pipe is measured separately, as it has been
since v9.8), the mean slope and the grid. Every storm structure and pipe popup gained
**"show what drains here"**, which lights up everything upstream of it and totals the
acres. The card copies as CSV and exports as GeoJSON and DXF on `DRAIN-OUTLET`,
`DRAIN-FIRST` and `DRAIN-PATH`, and all of it drapes in 3D.

**One number here is worth knowing before you rely on it:** the eight road-drain grates
along the south side take **0.019 acres between them** overland. That is not a bug in the
map — the road ditch runs *past* them into the impoundment, which is exactly what v9.8
found from the other end when a raindrop at every one of the nine grates ran overland into
the impoundment or stayed in the ditch. It is one of the things the invert survey will
change.

**What it is not.** There is no rainfall in it, no runoff, no curve numbers, no time and
no pipe capacity. It says where water goes, never how much. How much — a design storm, a
runoff volume, a peak flow, whether a pond fills — is real hydrology with real assumptions
attached, and I have written it up as a proposal (`docs/V14_CATCHMENT_PROPOSAL.md`) rather
than building it: the assumptions are yours to make, and there are five of them waiting
for you in §7.

On the phone the same map runs at 4 ft instead of 2 (the card says so); its outlet acreages
are within 1.3 % of the desktop's.

---

## v9.9 — the overflow tool goes down the pipe, and water moves in 3D

Two things you asked for.

**Frog Pond flows into Green Pond now.** The overflow tool knew nothing about the storm
drains — it only ever looked for the low point of the rim — so on Frog Pond it found the
natural rim spill at 1,416.04 ft, ten feet from the culvert inlet on the west shore and
0.30 ft above it, and sent the overflow north over the ground. The raindrop had the pipe
rule since v9.8; the overtopping analysis has it now:

- The card carries a **First discharge** row above the rim spill: *"through pond culvert at
  1,415.74 ft · +0.74 ft · 0.82 ac-ft"*, with a **C** marker on the map at the inlet and its
  own **first-discharge route** — the culvert under the paved road into Green Pond, out
  through Green Pond's flared end, down the road drain, 2,969 ft of it in pipe, to the Clear
  Lake outfall. Green Pond does the same at its own flared end, 1,394.50 ft, 4.6 ft below
  its natural rim.
- **The level slider snaps onto it.** Below the first discharge neither route is drawn; at
  it the pipe route appears; at the rim spill the overland overflow joins it.
- **Herman is unchanged and says one more thing.** Its first discharge is still the two
  surveyed 24-in pipes at 1,341.55 ft, and that row now names the pipe it goes through
  (`via herman_pipe_s`). Nothing is listed or traced twice. Every rim number — spill
  1,343.84 ft, freeboard 7.39 ft, 161 ac-ft to spill — is exactly what it was.
- Switch the drains off (`STORM`) and the analysis is the terrain's alone again, to the
  last decimal.

**Water moves in 3D.** Every flow path on screen — a raindrop, an overflow route, a
first-discharge route — carries a stream of particles running along it at about 40 ft/s,
draped on the ground where the water is on the ground and running straight down the pipe,
in the storm colour, where it is not. With an overtopping analysis open the 3D view also
draws the **water surface at the slider's level** as a translucent sheet at that elevation,
labelled at each rim low and at the pipes; move the slider and the water moves. There is an
**Animate water** switch in the 3D View settings (on by default, remembered) — and with no
flow on screen the 3D view still costs nothing when it is sitting still.

---

## v9.8 — the storm drains

Until now a raindrop that reached a grate walked straight past it. The site's drainage
system is now in the app — **43 structures and 25 conduits**, from EA's V-Base drawing, the
geodatabase's storm structures, the August-2026 Jacobs survey and your own identification of
the culvert along the top of the grates — and the water uses it.

- **Three new layers**, on by default, under *Site framework → Storm drainage*: the
  structures (grates, round inlets, flared ends, the two surveyed pipe ends, the Clear Lake
  outfall), the conduits EA drew or Jacobs surveyed, and the conduits inferred from the
  structures. Each pipe carries an arrowhead at its outlet so you can read which way the
  water goes. Click anything for what it is, where it came from, its ground and its invert,
  its length and its fall.
- **A raindrop that reaches within 3 ft of an inlet goes down the pipe**, and a hollow that
  fills to an inlet's rim drains through it instead of over the rim. The run is drawn with
  the pipe as a pipe — a straight dashed steel-blue leg with an "in pipe" label, and a
  straight tube in 3D — and the card reports **In pipes** and **Total** beside **Run
  length**, which stays the distance over the ground. A pond drained by a grate says which
  one ("drains to Grate inlet — Spot 8 at 1,397.3 ft").
- **A drop on the Spot 8 grate** now runs 137 ft over the ground and **2,789 ft in pipe** —
  the seven road-drain conduits, the branch, and EA's storm main — and ends at the Clear
  Lake outfall. With the drains switched off it does what v11 did: 2,268 ft overland into
  the Herman Impoundment, which fills to 1,343.84 ft and spills over its rim.
- **Frog Pond and Green Pond are connected the way you described.** Frog Pond (the east
  pond) drains through the culvert under the paved road into Green Pond; Green Pond overflows
  through the flared end on its west shore, piped to the Spot 8 grate and down the road drain
  to the outfall — never into the impoundment. A drop at Frog Pond's low: **630 ft over the
  ground and 2,969 ft in pipe**, twelve conduits, ending in Clear Lake. The round inlet at
  Green Pond's corner is the high-level overflow to Herman, and it only takes water above its
  rim.
- **The Herman discharge pipes are connected to the storm main.** The *Pipe discharge route*
  row on the overtopping card now reads **"934 ft · 797 ft in pipe · Clear Lake outfall"**
  instead of stopping at a stub of overland flow.
- **`STORM`** (also in the Water ▾ menu, and a chip on the raindrop prompt) switches the
  whole network off, and every analysis is then exactly the ground-only one. Each conduit's
  popup has its own **broken / working** toggle for the pipe you have just found collapsed.
  Both are remembered between sessions.
- The network snaps like any other linework, drapes in 3D, and goes out with the GeoJSON and
  the DXF (on `STORM-STRUCT`, `STORM-CONDUIT` and `STORM-INFERRED`). It is in the field
  build too — it is 27 kB.

**What this is not.** A conduit here is a topological shortcut with an elevation at each
end. There is no pipe capacity, no hydraulic grade line, no surcharge and no time in any of
it, and the popups say so. EA's CAD carries no inverts, no diameters and no materials
anywhere on this system; the only surveyed inverts in existence are your two 24-in pipes at
the sandbag wall. Every other structure uses the lidar ground and says **"not surveyed"**
where an invert should be — nothing is guessed. When the manhole survey arrives it drops
straight in: a CSV of `id, invert_ft, rim_ft, size_in, material`, one line to rebuild, no
code.

**The sunken pipe mouth.** The lidar is the January-2024 flight; the sandbag wall and the two
24-inch pipes were surveyed in August 2026 and were built into a regraded channel it never
saw. The 1-ft cells at your surveyed invert points read 1,344.66 and 1,344.80 ft — the top of
the sandbags, not the pipe. So the app treats **an inlet whose surveyed invert is below the
lidar ground at its own cell as a pipe mouth the lidar did not see**, and enters it at the
nearest cell the lidar *does* see at or below that invert, within 30 ft — 25.6 ft for the
North pipe, 27.1 ft for the South, onto the channel floor at 1,341.5 ft. The rim stays your
surveyed invert, and both the structure's popup and the raindrop's card say the inlet cell
was moved and by how much. Nothing is invented: the invert is yours, the cell is one the
lidar measured, and if there is nothing low enough within 30 ft the inlet stays where you
surveyed it and the popup says that instead.

What it changes: **a drop inside the Herman Impoundment now ponds to 1,341.54 ft and leaves
through the South pipe, the storm main and the outfall — 813 ft in pipe** — rather than
filling 2.30 ft higher and going over the rim. That is the same first discharge the
overtopping card has shown since v9.2 (1,341.55 ft), so the raindrop and the overtopping
analysis now agree about the impoundment. Switch the drains off and the raindrop goes back to
the rim, which is the honest before-and-after of the survey.

## v9.7 — seven small things put right

- **Every delete undoes.** The ✕ on a results card, the bin in the Features tree and the
  Inspector, the delete button in a popup and the one in the design-surface list all go
  through the same action ERASE uses, so Ctrl+Z brings the feature back whichever way you
  removed it.
- **TOE and CREST** keep a line that goes all the way round a pile closed, and the Length
  on the card is now the length of the line you see (it read 2 ft long before).
- **Cross-sections** no longer report phantom fill against EA's excavation-bottom surface
  outside the mine window: the end areas use the same resolution-aware tolerance the
  isopach has used since v9, and the section card is unchanged otherwise.
- **Contour exports** no longer carry the sub-0.1-ft two-vertex fragments marching
  squares left behind (43 of them in the 10-ft site set); nothing longer than a foot
  changed.
- Two raster kernels now honour a windowed grid, which nothing used yet and the first
  caller would have found the hard way.
- The help panel names the design group correctly, and the performance diagnostic drives
  the layer state rather than checkboxes that no longer exist.

## v9.6 — the app in the field

**A field mode, and a field build.** Two things, because they answer two different
questions.

**Field mode** re-lays the whole app for a phone held in one hand on a site walk. It comes
on by itself when the app is opened on a touch device with a narrow screen, and the `FIELD`
command — or the switch in Help — turns it on or off anywhere; what you choose is
remembered. Nothing about the desktop layout changes without it.

Across the bottom: **Position · Inspect · Raindrop · Photo · Note · Layers**, and a
**More** sheet with Distance, Area, Samples nearby, Sheets, 3D, My work, Results, Help,
Lock and the way back out. The panels come up as sheets you slide away with a thumb, popups
arrive as full-width cards at the bottom, and every target is thumb-sized. In 3D one finger
orbits and two fingers pan and pinch.

- **Position** shows where you are standing, on the map, with the accuracy circle the phone
  reports and a heading arrow when it has one — converted into the site's State Plane
  coordinates through the same ±1 ft affine everything else uses. If the browser will not
  give a position, or you decline it, the app tells you and puts nothing on the map. It
  never guesses.
- **Photo** takes a picture and puts it on the map. It reads the photo's own GPS tag and
  places it there; failing that, at where you are standing; failing that, where you tap —
  and the card says which of the three it was, along with when the picture was taken. A
  photo is an ordinary drawing after that: it is in **My work** under a new **Field**
  heading, it stands up in the 3D view as a small billboard of itself, it saves in a
  session file, and it exports to GeoJSON and DXF. The GeoJSON asks first whether to carry
  the pictures themselves, because twenty photos is twenty megabytes.
- **Note** is the ordinary annotation through a big-button flow — type it, tap where it
  goes — and **Samples nearby** lists the twenty nearest sample locations to where you are,
  one tap to fly to each.

**The field build** (`SBMM_Site_Explorer_field.html`) is the same app, about half the size,
so it will open on a phone. Four things are left out of it: the twenty full-page plan
renders, the canopy model, EA's recovered design surfaces and EA's native CAD — the paper
and the desk work. Everything else is exactly the app you know: all three elevation grids,
all the imagery, the design geometry, the sheet overlays, the sample and well data, the
August-2026 survey, the water tools and the volume engine. Anywhere one of the four is
needed, the app says plainly that it is not in this build — the Sheets tab still lists all
twenty drawings, greyed — rather than failing.

Pile 1 still measures 278.4 yd³ of fill and −48.1 net, in all three builds.

---

## v9.5 — the app opens faster

The terrain now decodes in the background. The three elevation grids and the canopy model
used to be unpacked one after another on the same thread that draws the screen, which is
what the "building workbench" pause was; they are now unpacked side by side, off that
thread, and the loader counts them off as they land. On the slow two-core machine the tests
run on, the app is ready in **1.7 seconds instead of 2.5**, and the terrain step itself
went from 1.25 s to 0.68 s. Nothing about the terrain changed — the elevations are
bit-for-bit the ones the app has always read, and the tests prove it by unpacking a grid
both ways and comparing every cell.

---

## v9.4 — redo

The Redo button works. Everything you do — drawing, dragging a vertex, the modify
commands, a graded pad, a set of sections, a smart boundary, a raindrop, a delete — can now
be stepped back with **Ctrl+Z** (or `UNDO`) and stepped forward again with **Ctrl+Y**,
**Ctrl+Shift+Z** or the new `REDO` command, a hundred steps each way. Both buttons say what
they will do: "Redo: retrace Raindrop 3". A redo brings back the *same* drawing — its name,
its results card, its folder and its id — not a copy of it, so anything that referred to it
still does. Starting something new after an undo drops the branch you left, the way every
editor does. Deleting a feature with `ERASE` is now undoable too.

---

## v9.3 — the password screen

The app now opens on a password screen: the site's own topography, drawn live and drifting,
with one field on it. Enter the password and the drawing floods with water while the card
dissolves into it, then the ground surfaces through the flood along a contour line and the
workbench is there — about a second and a half, and it is skipped entirely for anyone whose
system asks for reduced motion. Your browser remembers you for 30 days; `LOCK` (or `LOGOUT`)
in the command bar forgets it again.

It is a **deterrent, not security**. Everything this app needs is inside the file you
double-click, so the check is in there too and anyone determined enough to read the source
is past it. What it stops is the file being *used* by whoever it gets passed to. The
password is never stored — only a SHA-256 of it — so it can be changed
(`python tools/set_password.py`) but never read back out.

## v9.2a — the August-2026 survey in the app

The Jacobs survey of the Herman Impoundment water level, the two 24-inch discharge pipes
and their inverts, the sandbag wall and the Northwest Pit low is in: 24 shots as a dataset,
the pipes, wall and pit contours as their own layers, placed from the survey's own
coordinates to a hundredth of a foot. The Herman overtopping card now starts from the
surveyed water (1,336.45 ft) and shows the real order of events: the pipes discharge first
(invert 1,341.55 ft, +5.10 ft), then the sandbag crest (1,343.54), then the lidar rim
(1,343.84). The slider snaps to each stage, the pipes get their own discharge route, and a
pipe's popup offers "trace discharge".

## v9.2 — water: raindrops and overtopping

Two new tools, both reading the same January-2024 lidar ground the volumes come from.

**Raindrop** — press <kbd>R</kbd> (or `DROP`, or the new **Water ▾** menu, or "trace a
raindrop" on any point card) and click anywhere. A drop lands there and runs downhill,
on the 1-ft grid where there is one and the 2-ft grid elsewhere. Where it reaches a low
point it **ponds**: the hollow fills to its pour point, the pond is drawn with its level,
depth, area and volume, and the drop carries on out of it. The run ends where the ground
runs out (Clear Lake or the edge of the survey), in a hollow with no way out, or at the
length cap — and the label at the end says which. Every click makes another drop; the
mode stays armed until <kbd>Esc</kbd>.

The run is an ordinary drawing: it is in **My work** under a new **Water** row, it has a
results card with the numbers and a profile of the run, it saves in the session, and it
exports to GeoJSON and DXF (the ponds go out too, on `WATER-PONDS`). **Drag the raindrop
marker** and it retraces from wherever you dropped it. The card also offers **profile**
(the full interactive elevation chart) and **catchment** (everything that drains to that
point).

**Overtopping** — `OVERTOP`, the Water menu, or the popup on any water polygon. For the
Herman Impoundment it answers: it spills at **1,343.84 ft**, which is **7.26 ft** of
freeboard over today's water at 1,336.58 ft; getting there takes **158 ac-ft** and the
pond grows to **22.8 ac**; it goes over the rim at E 6,371,926 / N 2,127,692 and the
overflow runs **966 ft** to Clear Lake.

Around the water it paints a **ring of rim elevations** — hot red where the rim is at the
spill, fading to pale yellow 3 ft above it — with the exact overtopping cells picked out
and the low points **ranked ①②③** on the map and in a table you can zoom from. Five rim
lows sit within 3 ft of the spill. A **slider** walks the water level from today's surface
past the spill: below it the card says "no overflow", at it the overflow route appears,
and above it the card is explicit that it is now describing what would happen *if the low
rim were raised*. A stage–storage chart plots storage and area against level.

The overflow route and the pond at the spill level become real features and stay in the
session; the coloured band and the markers are overlay and come back by running the
analysis again.

**What these tools are not.** There is no rainfall, no runoff volume, no infiltration, no
seepage through the dam and no time in any of it. They are terrain analyses: they say
where the ground shape sends water and at what elevation it goes over, at planning level,
from survey-grade ground truth. Anything involving a storm, a flow rate or a dam break is
a different kind of model and would need inflow data this app does not have.

Every number above is reproduced by an independent implementation of the same definitions
written before the code was — 49 checks in `test/water_kernels.mjs`.

---

## v9.1 — 3 September 2026

**C-202 (North Lobe Grading) is now placed on the map and drapes in 3D.** It was the one
plan sheet with a drawing but no drape: it prints only two survey nodes and draws the lobe
twice (grading plan and restoration planting plan), which defeated both registration
methods. EA's native geodatabase polygon for the North Lobe is that drawn boundary with
every vertex surveyed, so the sheet was placed by fitting the polygon to the linework of
each plan — vertex residuals under half a foot median, rotation exactly −90° — and confirmed
independently against the orthophoto, which moves each plan by 1.8 ft, the same agreement
the other eleven sheets show. The draped raster is the grading plan. In the sheet viewer
both plans are georeferenced: a mark is placed through whichever plan it is made on, and
the title block and notes are refused. Twelve sheets are placed; C-101, C-102 and C-203 are
not.

---

## What is new in v9

### EA's native CAD, all of it

All **22,158 features on 110 CAD layers** from EA's June 2026 native delivery are
in the app, grouped into 21 readable layers (limits of excavation, daylight and
transition, grading breaklines, repository, haul routes, erosion control,
drainage, parcels, buildings, utilities, survey blocks…). Click any of them for a
popup that names the layer, the drawing file it came from and its CAD handle.

A **Layer manager** (the `manage…` button on the Residential design group, or the
`LAYERS` command) works at the level a Civil 3D user actually thinks in — EA's own
110 layer *names*, not our 21 groups. Search, toggle, recolour, set opacity, see
which drawing each layer came from and how many features are on it. "Reset to
defaults" means the app's defaults, not "everything on".

### EA's existing-ground surfaces, recovered — and a finding

EA's Civil 3D surfaces were recovered from the native drawings: a **955,387-point
existing-ground TIN** (identical in four drawings, which is itself a cross-check)
and **933,112 points** from the external surface store. Both validate against the
January 2024 lidar at mean 0.00 ft / sd 0.16 ft and +0.12 / sd 0.34 — which is
what proves the decode is right rather than plausible.

**There is no proposed-grade TIN in the delivered DWGs.** This was searched
exhaustively, and it is a finding rather than a gap: EA saved with proxy graphics
off, so the repository and north-lobe final grades are simply not in what was
delivered. **If those grades are needed, ask EA for a LandXML export or a
proposed-grade raster** — a one-line request they can satisfy from Civil 3D. The
app deliberately does *not* invent a surface from the breaklines and call it the
design.

Where the residential remedy is concerned this does not matter, because that
remedy is **depth-based, not TIN-based**: EA's sheets say "excavate work area to
one foot depth unless otherwise indicated". So the app carries two derived
surfaces built from EA's own polygons and EA's written depths over the lidar bare
earth — excavation bottom and finished grade — and labels them as derived.

### Isopach and excavation volumes

Pick a design surface and get a **cut/fill heat map against the lidar ground**,
with the volumes, the area that actually changes and its bounding box. Or click a
limit of excavation and ask for "volume of this excavation", which reports
area × depth and the raster method side by side so you can see them agree.

The excavation-bottom surface integrates to **7,556 yd³ of cut, 0.0 fill** —
0.08 % from the number computed at build time against the raw lidar master, and
the changed area reproduces EA's printed 204,303 ft² to 0.13 %.

### 1-ft terrain over the residential lots

The app used to carry 1-ft lidar only over the mine area; the residential lots
south and west of it fell back to the 2-ft site grid. **`dem_res`** is a new 1-ft
window over the residential design area plus a 60-ft working buffer, so every
residential elevation, slope, section and excavation volume is now read off 1-ft
ground. (This is what removed the last of the isopach's phantom fill.)

### Cultural resources — confidential, and gated

The archaeological survey of the Elem Indian Colony (63 features) is included by
an explicit decision of the project lead, under controlled access: **off by
default**, an acknowledgement dialog on the first enable in each session, a red
NHPA §304 stamp over the map and the 3D view while any of it is visible, and that
same stamp **burned into every exported image**. Exports carry a confidentiality
flag on the file and on every feature. Treat anything that comes out of this layer
accordingly.

### 3D parity

The 3D view is no longer read-only. Click anything in 3D — a design line, a
sample, a tree, a dataset point, the ground — and get **the same popup the 2D map
gives you**, because it is literally the same code. Drag a vertex in 3D and it is
the same edit as dragging it in 2D: one geometry model, one undo stack.

### Drawings: measure and mark on the sheet

All 20 plan sheets open in floating windows you can zoom, pan, drag and resize.
On the registered sheets (12 since v9.1) you can now **measure and mark directly on the paper**
and have it land on the map in State Plane feet — a per-sheet page-to-ground
transform was recovered for this. A sheet that could not be georeferenced honestly
refuses to place a mark rather than placing it wrongly.

There is also a **Sheets tab** with a card per drawing, filterable by lot, and
footprints that outline themselves on the map while you browse.

### Shell, modes and layers

- **One tool mode at a time**, with a Mode HUD that tells you what the current
  tool wants next. **Esc always returns to Navigate** — it cancels the sketch,
  clears the selection and puts the cursor back, from anywhere.
- **One answer to "is this layer on"**: layer state is shared by the 2D map, the
  3D view, the sheet windows and the exports. There are no separate 3D layer
  checkboxes any more.
- Six layer groups in a fixed reading order, with master switches, counts and an
  Areas quick-nav (mine / residential / full site). The Residential design group
  lists the curated design layers first and the per-sheet drawing drapes last.
- The app remembers where you were — 2D centre and zoom, and the 3D camera —
  and opens there next time.
- Every exported image carries the **"Mo Sharif - Jacobs 2026"** watermark.

---

## Known limits — read these before relying on a number

1. **No final grade for the repository or the north lobe.** Not recovered because
   it is not in the delivered DWGs (see above). Volumes against those two are
   *not* available; ask EA for a LandXML export or a proposed-grade raster.
2. **Four 0.5-ft depth call-outs are unlocated.** Their text exists only in paper
   space in EA's CAD — there is no model-space geometry for them anywhere in the
   delivery — so their markers sit at the centroid of that sheet's limit of
   excavation and say so in the popup. Do not read a position off them.
3. **No redo.** There is an undo stack (Ctrl+Z) and it is honest about it: the
   redo button explains rather than pretending.
4. **C-110 is from the 90 % Pre-Final set**, not the Final set. It is badged as
   such everywhere it appears. It is a superseded design; do not build from it.
5. **Volumes are planning-level.** They are reported to two significant figures
   with that caveat attached, and the app shows you the uncertainty range and the
   method it used. They are not a substitute for a surveyed quantity.
6. **EA's CAD layer names for Lots 13 and 15 are swapped** with respect to both
   the lot polygons and the sheet subjects. The app labels from geometry and
   flags the conflict on the feature. Believe the geometry.
7. **Canopy heights exist only over the mine area** — only one lidar tile was
   ever delivered. Tools that use canopy degrade gracefully outside it.
8. **CRS**: everything is NAD83(2011) California State Plane Zone 2, US survey
   feet (EPSG:6418). EA's geodatabase is EPSG:2226; the two were compared
   empirically over every excavation limit and agree to 0.3–1.8 ft, so nothing is
   reprojected. The one exception is the cultural layer, which is delivered in
   UTM 10N metres and genuinely must be reprojected.

---

## Sensitivity

This package contains site imagery, terrain, analytical sample results and
confidential cultural-resource locations for an active Superfund project. Keep it
inside the project team. The code repository stays private.
