# SBMM Site Explorer

An in-browser terrain workbench for the Sulphur Bank Mercury Mine OU1 site, built on the
**30 January 2024 aerial topographic survey** — the lidar-derived 1-ft gridded surface and
the same-flight 3-inch orthophotography. Fully client-side — no server, no install, no
network needed.

## Two ways to run it

Three outputs, one source.

| | |
|---|---|
| **`dist/SBMM_Site_Explorer.html`** | One self-contained file (~133 MB — the full-resolution plan sheets and EA's native CAD are most of it). **Double-click it and it works** — on any computer, from a USB stick, from email. This is the copy to hand to the team. |
| **`dist/SBMM_Site_Explorer_field.html`** | The same app at **~65 MB**, for opening on a phone (`python tools/build_dist.py --field`). See [In the field](#in-the-field). |
| **This folder (`index.html`)** | The development layout — same app split into modules. Also opens by double-click, and hosts directly on GitHub Pages. This is the copy to iterate on with Claude Code. |

> **Why the old version hung on "Loading terrain…":** it loaded data with `fetch()`, which
> browsers block when a page is opened from disk (`file://`). This build loads everything
> through `<script>` payloads and base64 data-URLs (`datajs/`), which are always allowed —
> so double-clicking just works. There is also real error reporting now: if something does
> fail, the loader says what and why instead of spinning forever.

## Opening it — the password screen

The app asks for a password before it shows anything. Type it, press **Enter**, and the
survey drawing on the screen floods and the site surfaces up through it. Your browser
remembers the unlock for 30 days; typing `LOCK` (or `LOGOUT`) in the command bar forgets
it and puts the screen back up — useful before handing your laptop to someone.

This is a **deterrent, not security**, and it is not pretending otherwise: everything the
app needs is inside the file the browser opens, so the check lives there too. What it does
is stop the file being used by whoever it reaches sideways. The password itself is not
written anywhere in this repository except the private handover note; the app stores only a
SHA-256 of it, so a forgotten password is replaced (`python tools/set_password.py "New"`),
never recovered.

## In the field

The app has a **field mode**: the whole layout re-laid for a phone held in one hand on a
site walk. It switches itself on at start on a touch device with a narrow screen, and the
`FIELD` command (or the switch in Help) turns it on or off anywhere; your choice is
remembered. Nothing about the desktop layout changes without it.

- **A bottom action bar** — **Position**, **Inspect**, **Raindrop**, **Photo**, **Note**,
  **Layers**, and a **More** sheet with Distance, Area, Samples nearby, Sheets, 3D, My
  work, Results, Help, Lock and the way back out. Everything is a 44-px target and every
  control is at 16 px, which is the size below which iOS zooms the page under your thumb.
- **The docks become sheets** that slide up from the bottom to 60 % of the screen, one at a
  time, and drag down to dismiss. **Popups become full-width cards** at the bottom — the
  same content the desktop popup shows, in a shape you can read at arm's length.
- **Position** uses the browser's own geolocation, converts it through the site affine
  (±1 ft), and draws a pulsing marker inside its accuracy circle, with a heading arrow when
  the device reports one and follow-the-map on by default. If the browser has no
  geolocation, or you decline it, the app says so and places nothing — it never guesses
  where you are.
- **Photo** takes a picture with the phone camera, reads its EXIF orientation, time and GPS
  tag, downscales it to 1600 px, and puts it on the map — at its own GPS position, or at the
  device position, or where you tap, and the card says which. A photo is an ordinary
  feature: it appears in **My work** under a new **Field** class, it drapes in 3D as a
  billboard of itself, it survives a session file, and it exports to GeoJSON and DXF (the
  GeoJSON asks before it carries the images, because twenty photos is twenty megabytes).
- **Note** is the ordinary text annotation through a big-button flow, and **Samples
  nearby** lists the twenty nearest sample locations to where you are standing, one tap to
  fly to each.
- In 3D, one finger orbits and two fingers pan and pinch; the view opens at standard mesh
  detail, and the toolbar collapses to drape, frame and back.

### The field build

`python tools/build_dist.py --field` writes `dist/SBMM_Site_Explorer_field.html`, about
half the size of the full one, because four payloads are left out:

| left out | why |
|---|---|
| the 20 full-sheet plan renders (~27 MB) | the design *geometry* is still there, from EA's geodatabase; the paper is not |
| the canopy height model (~7 MB) | the tree tools are a desk job |
| EA's four recovered design surfaces (~11 MB) | so are the isopach and the design-base volumes |
| EA's native CAD (~22 MB) | 802 layers of drafting linework you do not read on a phone |

Everything else is unchanged: all three elevation grids, all the imagery, the design
geometry, the registered sheet overlays, the datasets, the August-2026 survey, the water
tools, the volume engine and the cultural layer (still gated). Every part of the app that
reads one of the four says plainly that it is not in this build rather than failing — the
Sheets tab still lists all twenty drawings, greyed, and the design-surfaces list says where
they went.

## On an iPad

The iPad gets the **desktop layout** — the docks, the top bar, the sheet windows — because
that is what fits on a 1194-px screen and what you already liked. What it also gets, from
v17, is everything the desktop layout assumed a mouse for. The app decides for itself: a
touch-capable screen wider than 900 px is a *tablet*, narrower is a *phone* (field mode),
and anything else is a desktop. **Help → Touch controls** overrides it in either direction
if the guess is ever wrong, and an iPad in Split View crosses the line and comes back on
its own.

**Add it to the home screen.** In Safari, tap the Share button, scroll to *Add to Home
Screen*, then Add. It opens full screen with no browser chrome, its own settings and its
own icon. Two things follow from that: it has no address bar, so **Help → Reload app** is
its refresh; and its storage is its own, so the password screen asks once more the first
time.

**Take it offline.** Over a web address (GitHub Pages, or an internal server) the Help
panel has **Make available offline** — one tap, a progress count, and the whole 130 MB
lives on the device. After that the app opens with no signal at all. When a new version is
deployed it says *stale — an update is available, refresh to load it*, and the button
becomes *Update offline copy*; *Remove offline copy* deletes it. This is the one place in
the app that touches the network, it only ever reads its own site, and it does nothing at
all when you open the app as a file.

**Gestures — the 3D view**

| gesture | does |
|---|---|
| one finger, drag | orbit, and it keeps going when you let go |
| two fingers, pinch | zoom **towards the point between your fingers** — that ground stays under them |
| two fingers, drag | pan |
| two fingers, twist | swing the view round by the angle you turned |
| three fingers, drag up / down | tilt |
| double-tap | centre there and zoom in · two-finger tap zooms out |
| tap | identify what you tapped |
| press and hold | the identify card — and on a vertex handle, start dragging it |
| the nav pad, bottom right | zoom in/out, tilt up/down · the compass resets north |

**Gestures — the sheet viewer.** A drawing opens **maximised** (there is a restore button
in its title bar, in every profile now). Pinch zooms about the point between your fingers,
two fingers pan, one finger pans, double-tap zooms in, two-finger tap zooms out. The
toolbar wraps rather than overlapping the drawing, and every button on the window is a
44-px target.

**Gestures — the map.** Press and hold is the right-click: the coordinate menu, a
feature's menu, a vertex's menu. Every layer row carries a visible **⋯** for the toolbar
that appears on hover on a desktop. Press and hold a button to read its tooltip (which is
where the keyboard shortcut is written) without firing it. The command line opens from its
own button in the top bar, and **Field ▾** puts Position, Photo, Note and Samples nearby
where you can reach them without switching to the phone layout.

**Placing a point precisely.** A fingertip covers the thing it is placing, so on touch a
vertex is *press, hold, slide, lift*: a magnifying **loupe** appears above and to the left
with a crosshair on the exact spot, you slide until it is right, and the point lands where
you lift your finger. A tap without a slide places straight away; two fingers cancel it and
become a pinch. While a sketch is open you get a **Done / Undo vertex / Cancel** bar,
because there is no Enter, Backspace or Esc key under a thumb. All of it works the same on
the map and inside a drawing.

**The Apple Pencil.** The Pencil is a precise pointer and is treated as one: a pen tap
places a vertex exactly where the tip is, with no loupe and mouse-sized snapping; hovering
the tip moves the object-snap glyphs and the 3D highlight, the way a mouse does; and your
palm is ignored while the tip is down. In 3D a pen drag orbits, a pen tap picks, and a pen
drag **with a finger held down** pans.

**Redlining.** `REDLINE` (also `MARKUP`, `INK`) is freehand ink, on the map and inside a
sheet window. Pressure drives the line width; six colours and an eraser sit in a palette at
the bottom; every stroke is one undo. A stroke is not a picture — it is a real feature in
State Plane feet, so it appears in My work, travels in the session file, exports to GeoJSON
and to DXF on a **REDLINE** layer, drapes over the terrain in 3D and prints in the report,
in its own colour. Scribble works in every text box in the app.

**Under the hood**, on an iPad: the 3D view runs WebGL2 with anisotropic filtering on the
terrain imagery (which is what a hillside seen edge-on needs), the mesh detail defaults to
*standard* on an older iPad and *high* on an M-series one and remembers whichever you
choose, the compute workers scale with the number of cores, a lost graphics context is
rebuilt instead of going black, the screen stays awake while Position or a long
calculation is running, exports go to the iPad **share sheet** (Files, AirDrop, Mail), and
a CSV, GeoJSON, DXF or session file dragged in from the Files app in Split View imports.
**Help** shows the build, the profile, the pixel ratio, the GPU and the worker count in one
line — read that back if anything is slow.

## What it does

**One workbench, organised by what you are doing.** The top bar carries the tools as
**modes** — Navigate, Inspect, Distance, Area, Volume, Section, plus Draw ▾ and Design ▾ —
exactly one is active at a time, a pill at the bottom of the screen says which and what it
is waiting for next, and **Esc always returns to Navigate**. Hold Space to pan without
leaving the mode you are in. The left dock is **Layers / My work / Sheets**; the right dock
is **Inspector / Results**, and selecting something brings the Inspector forward while
running a computation brings the Results forward. The pill knows which view you are in:
in 3D it names the orbit gestures rather than the pan ones, and in split it follows the
pane under the cursor. The **Sheets** tab is a card per drawing with a thumbnail and a lot
filter; while it is open the registered sheet extents are outlined on the map and the one
you are hovering lights up. Floating sheet windows stay inside the map area, so a drawing
never covers the Inspector you are reading it against. The app reopens where you left it —
the 2D view and the 3D camera are both remembered.

**One layer state.** A layer that is on is on in 2D, in 3D, in the sheet windows and in the
exports. The 3D view has no visibility checkboxes of its own — what it draws is whatever the
Layers tree says is showing. Layer choices are remembered between sessions and travel in the
session file, except the cultural group, which is off at every start by design.

**Layers — a real tree, in six groups** (v16). Base (imagery, hillshade, lidar contours,
canopy, slope, aspect), Site framework (decision units, waste piles, the storm network, the
drainage map, and the parcels, buildings, roads, fences, utilities, trees and survey blocks
from EA's CAD), Residential design (EA 2025) — curated design layers first, the per-sheet
drawing drapes last under a "Sheets (draped)" sub-header — Investigations (samples, wells,
borings, the 2026 survey, imported datasets), Cultural resources, and My work.

Inside a group, related rows sit in **named sub-groups** that collapse on their own —
*Storm drainage*, *Drainage (lidar + storm drains)*, *Survey — Aug 2026*, *Design areas*,
*Sheets (draped)*, *Design surfaces*, *Datasets*, *Contours*, *Terrain analysis* — and the
tree remembers which of them you left open. Each group header carries a master checkbox, a
count, "n of m on" and, on hover, all-on / all-off / expand-all / collapse-all.

Each **row** shows the layer's real symbology rather than a colour square: a line in its own
colour, weight and dash, a filled polygon, a point at its own size, a band for a raster. Hover
a row for its toolbar — **opacity**, **zoom to this layer**, **solo** (everything else in the
group off; click again to put it back — alt-click on the tick box does the same) and **info**
(what it is, where it came from, how many features, the CRS, and a link straight into the
Layer manager for a CAD row). Rows from EA's own CAD carry a **CAD** tag; counts are
monospace.

**Drag a row by its grip to reorder it, and that order is the draw order** — the row at the
top of a container draws on top of the ones below it. The order is remembered and travels in
the session file.

**Search** (the box at the top, or `/` anywhere in the tab) filters the whole tree as you
type, over the layer name, its sub-group, its group and its id; ancestors open themselves,
Esc clears, Enter toggles the first match. Arrow keys walk the tree, Space toggles a row,
Left/Right collapse and expand.

**Presets** are named layer states: *Terrain*, *Design review*, *Water & drainage*,
*Investigations*, *Field* and *Everything on*, plus any you save yourself (save, rename,
delete). Applying one is a single undoable action. **No preset ever switches on the cultural
group** — that stays something you tick yourself, with its acknowledgement. The last five
rows you changed sit as chips under the search box, one click to put one back.

A collapsible **legend card** in the map's bottom-left lists every layer that is currently
showing, grouped, with "only" beside each row to isolate it. On a phone it is off the map and
lives in the More sheet.

Layers that would drown the default view are off until you ask for them — sample results,
the 2-ft contour set (which also waits for you to zoom in far enough to read it), the drainage
map (its first tick runs the analysis) and the sheet footprints. The
**Layer manager** on the design group searches EA's 110 CAD layer names, toggles, recolours
and sets opacity per layer, and shows each one's source file, feature count and a real DWG
entity handle you can type into AutoCAD.

**Measure** — spot elevations, distances (with grade and climb/descent), areas, elevation
profiles (interactive chart, hover synced to the map, CSV export).

**Volume** — draw a footprint (or click any pile/DU outline for one-click volume) and it
integrates the terrain against a base surface: perimeter TIN (the ABP tech memo
Attachment E method), best-fit plane, lowest rim point, or a fixed elevation. Reports
cut and fill in yd³, tonnage at an adjustable density, truckloads, and an optional
color-coded **cut/fill depth map** on the terrain.

**Earthworks** — the grading and quantities suite described under *Earthworks* below:
named **design surfaces** (graded pads, sloped-plane pads, frozen copies of existing
ground) with computed **daylight lines**, cut/fill measured against a design rather than a
fitted base, an **auto-balance** solver for the pad elevation where cut equals fill,
an **uncertainty range** across five base surfaces, **cross-sections** at CAD stationing
with end-area volumes cross-checked against the grid, and a one-click **print-ready report
sheet**.

**Edit** — every drawn feature can be renamed and re-shaped afterwards (drag vertices,
click midpoints to insert, right-click to delete); measurements update live. Every action —
drawing, editing, modifying, pads, sections, smart boundaries, raindrops and deletes — is
undoable with Ctrl+Z (or `UNDO`) and redoable with Ctrl+Y / Ctrl+Shift+Z (or `REDO`), 100
steps each way; a redo puts the same feature back, with its id, its card and its geometry.

**Draft** — the CAD drafting layer described under *Drafting like AutoCAD* below: object
snaps, ortho and polar tracking, typed coordinate entry, a command line with AutoCAD
aliases, the OFFSET / MIRROR / ROTATE / MOVE / COPY / JOIN / EXPLODE modify set,
dimensions and text annotations, and DXF in and out.

**Design surfaces and isopach** — the four surfaces recovered from EA's own Civil 3D files
(existing ground, the borrow-area surface, the residential excavation bottom and finished
grade) are first-class read-only surfaces: use one as a volume base, cut sections against it,
drape it in 3D, or draw its **isopach** — the cut/fill thickness against the January-2024
lidar ground, blue where the design stands above the ground and red where it is below, with
the legend in feet, in 2D and draped in 3D. **Volume in polygon vs surface** measures any
polygon against any surface, and an excavation polygon offers **volume of this excavation**,
which shows area × depth and the raster method side by side so you can see the two agree.
The isopach reports the area that actually *changes* and its extent, not just the surface's
working footprint, and treats a difference as zero when it is smaller than the two rasters
can express — the terrain-RGB quantisation of each, plus, only where the ground is the 2-ft
site grid rather than the 1-ft mine grid, that grid's own interpolation error on the local
slope. On EA's excavation-bottom surface it reports 7,542 yd³ of cut against the 7,562 yd³
computed at build time from the raw lidar master, and essentially no fill — which is right,
because that design is existing ground minus a depth and existing ground everywhere else.

**3D** — full terrain viewer (Three.js): orthophoto / hillshade / slope / elevation drape,
adjustable relief exaggeration, everything the Layers tree is showing drawn over the terrain,
**survey contours draped on the terrain**, a **detail** setting for mesh density, coordinate +
elevation readout under the cursor, PNG snapshots. **⬓ split mode** puts 2D and 3D side by side,
Civil-3D style: every tool works in either view (clicks in 3D raycast onto the terrain
and feed the same drawing pipeline), and drawings, edits, and results stay live in both.

**Terrain data** — the surveyor's **lidar-derived 1-ft gridded surface** (LandXML, 14 tiles,
42.6 million points, 30 January 2024 flight). It is regridded to **2 ft across the entire
site** and kept at **1 ft over the mine area** — the footprint of the delivered point-cloud
tiles. This replaced the earlier contour-TIN build: the CAD 1-ft/2-ft topo polylines are now
carried only as reference contour layers, not as the elevation source.

The raw **7 GB LAS point cloud** (unclassified, point data record format 3, ~208 million
returns over the mine area) is **not yet integrated**. Because it is unclassified it mixes
ground with canopy and structures, so a future pass could derive a DSM / canopy height model
from it — the bare-earth surface used here comes from the surveyor's already-classified
LandXML grid instead.

The intermediate master raster (the whole LandXML surface rasterized to one 1-ft float32
grid, 9700 × 8900, NaN = nodata) is archived alongside the survey deliverables at
`LiDAR and Aerial Survey Data\_staging\master_1ft.f32` (and `.f32.zst` compressed).
Every terrain raster in `data/` is regenerated from it by
`tools/build_dems_from_master.py <path to master_1ft.f32>` — rerun that, then
`build_data.py` and `build_dist.py`, after any new survey delivery.

**Terrain analysis** — slope, aspect, and elevation-tint layers plus contours generated
at any interval, all computed in-browser from the DEM.

**3D contours** (the lidar contour rows in the Layers tree — since v9 one switch drives both
views) — the survey contour layers drawn
in the 3D scene. A contour's level *is* its elevation, so each line sits at a constant z and
needs no drape sampling; index contours (50 ft site / 10 ft mine area) are drawn heavier.
The whole set is merged into four `LineSegments` objects — about 42,000 segments in four draw
calls — so toggling it costs nothing at frame time. Segments that fall off the surveyed
surface, and the spurious straight "bridges" where a source polyline splices two disjoint
contour parts together (up to ~4,800 ft long), are dropped by checking each segment against
the DEM rather than by a length cutoff — the 10-ft site contours are legitimately coarse.

**3D detail** (`detail` in the 3D bar) — mesh density for the terrain surfaces:
**high** (default, ~1.56M vertices) or **standard** (~566k) for weaker machines. Changing it
disposes the old geometry and rebuilds both surfaces, then re-applies the current drape and
exaggeration. Contours, canopy, and overlays are unaffected.

**Canopy height (lidar)** — a 1-ft canopy-height model derived from the raw LAS point cloud
(208.3M returns): per-cell maximum first-return elevation minus the bare-earth surface, covering
the mine-area window only; it is available as a 2D analysis layer, a 3D canopy surface, in the
status bar, and on spot elevations, and its values are vegetation/structure height above ground
rather than terrain elevation. The shipped raster is **cleaned** — despeckled, pit-free closed,
and blurred only above 2 ft — see *Canopy v2 and the tree inventory* below for what that changes
and why. Rebuild with `tools/build_chm_png.py <path to chm_1ft.f32>` (`--raw` reproduces v1).

**Smart boundaries** — `WAND` delineates a waste pile by the memo's own top-hat method, `CBOUND`
traces the closed contour through a point, `TOE` finds slope break lines and `STANDS` polygonises
canopy for clearing limits. Every result is an ordinary editable feature. See *Smart boundary
tools* below.

**Tree inventory** — individual-tree detection over the canopy model: ~4,200 trees with height,
crown area and crown radius, drawn as a canvas dot layer and exportable as CSV.

**Samples** — filterable, sortable table of the 140 sampled locations (Hg/As thresholds,
source, exceedance), synced to the map, graduated symbology, CSV export.

**In / out** — export drawings as GeoJSON in **WGS84** (Google Earth, web GIS) or
**State Plane EPSG:6418** (CAD, ArcGIS), or as **DXF R12** in raw State Plane feet for
AutoCAD and Civil 3D; import GeoJSON (either CRS, auto-detected) and DXF by drag-drop or
the Import button; save/reload whole sessions as files; results panel to CSV; live
State Plane + lat/long + elevation readout; go-to-coordinate (`G`).

**Workbench layout** — one page, three docked regions around the map/3D stage. The **left
dock** has three tabs: *Layers* (the layer control), *Features* (a manager for everything you
have drawn — colour swatch, inline rename, show/hide, lock, zoom-to, delete, and folders you
can drag features between), and *Properties* (the selected feature's type, folder, style,
coordinate list and computed results, editable where it makes sense). The **right dock** holds
the results cards. Both docks collapse to their icon rail and drag-resize; the top bar groups
commands (measure · view · data) and degrades to icon-only, then to an overflow menu, as the
window narrows. Selecting is single-selection and shared by every view: click a drawing on the
map, or its row in Features, and it highlights on the map, in the results card and in 3D;
`Esc` clears it. The status bar carries a progress row (spinner · label · cancel) for
background jobs.

**Background compute (Web Workers)** — volume integration, the slope/aspect/elevation-tint and
canopy rasters, and computed contours all run off the UI thread. The kernels live in
`js/compute.js`, which is written context-free (plain functions over typed arrays, no DOM, no
`SBMM` globals). `js/jobs.js` builds the worker from a **Blob URL whose source it reconstructs
with `Function.prototype.toString()`** — the one technique that works both in the folder build
(where `fetch()` of a sibling file is blocked over `file://`) and in the single-file dist
(where `build_dist.py` has inlined the same text). Jobs ship transferable typed arrays and,
for volume, only the DEM sub-window the polygon's bounding box can reach — never the whole
terrain, and always a copy, since transferring the app's own arrays would detach them. Jobs
report progress, and superseded ones are cancelled (that is what makes live recompute while
dragging a vertex cheap). If `Worker` construction fails for any reason, every job falls back
to calling the *same* `SBMM_COMPUTE.runJob()` on the main thread, so the two paths cannot
disagree — the e2e test asserts the worker path is live, that nothing fell back, and that
Pile 1 still returns the validated number.

**3D navigation** — two modes. *Orbit* (default): left-drag orbits, right- or middle-drag
pans, the wheel dollies **toward the point under the cursor**, double-click sets the orbit
target, and everything damps toward its desired state. *Fly* (`F` or the **fly** button):
left-drag looks around, `W A S D` move, `Q`/`E` go down/up, `Shift` is 4×, and speed scales
with height above ground. In both modes the camera is kept at least 3 ft above the terrain
(in exaggerated units, so the clearance reads the same at any relief setting) — in orbit that
correction is folded back into the polar angle so the camera and the orbit state never
disagree. Over the view: a compass that rotates with the camera (click it for north-up),
Top/N/S/E/W/Iso presets, **Frame** (fits the selected feature, or the whole mine area), a
settings popover for field of view, mouse sensitivity and fly speed, and a `?` popover listing
the controls. The render loop is **on demand** — it only issues a draw call when the camera or
the scene is dirty, so an idle 3D view costs nothing (the e2e test asserts the idle view stops
rendering).

## Earthworks

Everything in this section answers the same question the ABP memo answers — *how much
material, and where does the work stop* — but for a design you are proposing rather than
for ground that is already there.

### Design surfaces

A **design surface** is a named elevation function over a region. It is an ordinary feature:
it lives in the Features tree, has a colour, a folder and a visibility toggle, shows up in
Properties, serialises into the session, and exports. Three kinds:

| Kind | What it is |
|---|---|
| **graded pad** (`PAD`) | flat pad at elevation *Z* inside the footprint, side slopes at a ratio H:V running **outward** until they daylight into existing ground — or **inward** as a batter contained by the footprint |
| **sloped-plane pad** (`GRADE`) | the same, but the pad is a plane at a typed grade (%) and direction (0° = east) |
| **existing-ground copy** (`EXIST`) | a frozen copy of the terrain under a polygon — the "before" surface to compare a later design against |

Pad elevation can be typed, or matched to the **lowest** or **mean** rim elevation of the
footprint. The list lives in a *Design surfaces* section of the Layers tab; the parameters
are editable both on the results card and in Properties, and changing any of them
regenerates the surface.

**Representation.** Each surface is rasterised to a **Float32 node grid at the local DEM
cell size** (1 ft over the mine area, 2 ft site-wide) over its footprint plus a slope apron,
computed in a worker and cached on the feature. The apron is sized from the rim relief and
the slope ratio, then the raster is coarsened if it would exceed ~260 k nodes. Everything
downstream — volume against a design base, cross-sections, the 3D drape — samples that one
raster, so there is exactly one definition of what the surface *is*. Lookup is
`SBMM.design.elev(surfId, x, y)`, bilinear, `NaN` outside the raster.

**The daylight line is not searched for — it falls out.** Outside the daylight line the
design surface *is* existing ground, because each apron node is clipped to it (a rising cut
slope takes `min(slope, ground)`, a falling fill slope takes `max(slope, ground)`). So
contouring |design − ground| at a small tolerance encloses precisely the graded area. The
tolerance matters: at a level of exactly zero there is no crossing to find, since the two
surfaces are *identical* out there rather than crossing. Rough ground makes the design graze
grade in dozens of places, so rings under 100 ft² are dropped as below the resolution the
surface is meaningful at, and the rest are ordered largest-first — the main limit-of-work is
always the first loop. The card reports how many were ignored.

Design surfaces draw their daylight line and an optional 1-ft **design contour** preview on
the map, and drape in 3D as a translucent shell — in **two passes**, because most of an
excavation's design surface lies *under* existing ground and a plain depth-tested mesh is
invisible exactly where the engineering is: the solid pass shows the design where it stands
above grade, and an x-ray pass ghosts the buried part through the terrain, the way a CAD
viewer shows a proposed surface.

### Volumes against a design surface

Every design surface appears in the volume card's base-surface dropdown as
*design surface: &lt;name&gt;*. The integration is the same worker kernel; only the base
changes. **The wording changes with it, and that is deliberate:** against a fitted base the
two integrals are "volume above / below base", but against a design surface the very same
sign means terrain standing above the design — material to **cut** — and terrain lying below
it — material to **fill**. The cut/fill depth map and its legend flip with the base for the
same reason. Getting that backwards on a drawing someone digs from would be a real error,
not a cosmetic one.

### Auto-balance

**`BAL`** (or *balance cut/fill* on the card) solves the pad elevation where cut equals
fill. `net(Z)` rises monotonically with `Z` — raising a pad can only add fill and remove cut
— so the solver bisects on `Z`, 40 iterations or 0.005 ft, whichever comes first, then
re-runs the surface at full resolution to confirm. `BAL 500` instead solves for a net of
500 yd³ (a surplus to haul off; negative for borrow to import). If the target lies outside
what the footprint can reach, the solver says so rather than returning a bracket end.

The bisection runs **inside one worker job**, not one job per iteration. Every iteration
shares the same expensive per-node preparation — ground elevation, distance to the
footprint, nearest-edge ground — and that preparation is what a job costs; re-shipping the
DEM window thirty times would cost far more than the arithmetic it saved. The job reports
progress per iteration. On the test pad it converges to **cut and fill within 0.2 %**.

### Uncertainty range

The base surface under a topographic volume is a modelling choice, not a measurement, which
is why the memo reports a range rather than a number. The **range** button on any volume
card re-integrates the same footprint against five bases in parallel — perimeter TIN (the
memo method, and the one quoted as *best*), perimeter TIN at 2× and ½× perimeter sampling
density, best-fit plane, and lowest rim point — and reports low / best / high with the
method list. Note that lowest-rim is deliberately an *outer* bound: on a pile sitting in a
bowl it can return several times the TIN volume, and the spread is the spread of the
modelling choice, not of the survey.

### Cross-sections

**`SEC`** takes an alignment (the selection, if a line is selected, or one you sketch) plus
a station interval and a swath width, and cuts perpendicular sections. Stationing is
CAD-conventional — `0+00`, `0+50`, `1+00` — with offsets running left(−) to right(+)
looking up-station. The map gets the cut lines and station labels; a bottom drawer gets
stacked section plots with a hover readout of offset, ground, design and Δ, cut/fill
shading, and an optional canopy line where the CHM covers the area.

Where a design surface is attached, each station carries **cut and fill end areas** (ft²,
trapezoid rule split at the zero crossing so cut and fill never mix), and the series is
totalled by the **average-end-area rule**. That total is then **cross-checked against a grid
integration of the same corridor** — a genuinely independent numerical method over the same
terrain and the same design, so agreement is evidence rather than a tautology. Both numbers
and their percentage difference are shown. On the test alignment (300 ft, 50-ft stations,
260-ft swath) they agree to **1.2 %**.

Sections export as CSV (station, offset, easting, northing, ground, design, Δ, canopy) and
onto the report sheet.

### Report sheets

**`REPORT`**, or the button on any volume, design-surface or section card, produces a
print-ready document — not a screenshot of a web page. Letter portrait, black on white,
Print → Save as PDF:

- a **title block**: feature name, sheet kind, project, prepared-by, date, task, and a
  second row carrying the coordinate system, the feature centroid in State Plane *and*
  lat/long, and the survey the terrain came from;
- **Figure 1**, composed rather than captured: the visible Leaflet image overlays are drawn
  into a canvas through their own georeferencing (the map is `CRS.Simple` with
  latlng = [northing, easting], so world → pixel is a plain affine), washed back, then the
  vector work is redrawn on top in print styling — footprint, daylight line, section cut
  lines with haloed station labels, context rings — with a surveying-convention **scale bar**
  and a **north arrow**;
- the **quantities table**, plus the design surface's own parameters when the quantities
  were measured against one, plus the low/best/high table if a range was run;
- a **sections sheet** where sections exist: every station plotted at a stated horizontal
  scale and a **stated vertical exaggeration**, because an unlabelled exaggerated section is
  a misleading drawing;
- the **method and caveat notes** — the same planning-level wording the memo uses.

The sheet opens in a same-origin iframe with Print, "open in a window" and "save .html"
buttons, rather than a popped window: popups get blocked, and over `file://` a written-into
window can lose its origin.

### Commands

| Command | Aliases | Does |
|---|---|---|
| `PAD` | `GRADING` | graded pad — flat Z with daylighting side slopes |
| `GRADE` | `SLOPEPAD` | sloped-plane pad — Z plus a typed grade and direction |
| `EXIST` | `EGCOPY` | freeze a copy of existing ground under a polygon |
| `BAL` | `BALANCE` | solve the pad elevation where cut = fill, or for a net yd³ target |
| `SURF` | `SURFACES` | list the design surfaces |
| `SEC` | `SECTIONS` `XS` | cross-sections along an alignment |
| `REPORT` | `RPT` `SHEET` | print-ready report sheet for the selection |

### Exports

Computed geometry goes out with the drawn geometry, because it is what the recipient
actually needs: daylight lines and section cut lines are added to **GeoJSON** (tagged
`tool: "daylight"` / `"section"`, sections carrying their station), and to **DXF** on the
conventional **`GRADING`** and **`SECTION`** layers, sections with a station label. Design
rasters and section samples are *not* serialised into session files — they are derived, and
regenerating them from the geometry and the parameters is both cheaper than storing them and
guaranteed current.

## Drafting like AutoCAD

Everything in this section is aimed at hands that already know Civil 3D. The point is
muscle memory: the same keys, the same aliases, the same order of prompts.

**Object snaps** (`OSNAP` in the status bar, `F3` toggles all, the ▴ opens the per-type
list). While you draw, edit a vertex, or run a modify command, the cursor snaps to
**endpoints**, **midpoints**, **intersections**, the **perpendicular foot** from the
previous vertex, and the **nearest point on a segment** — with AutoCAD's priority order
(endpoint beats intersection beats midpoint beats perpendicular beats nearest, closest
wins inside a tier). It snaps to everything on the map that has geometry: your own
drawings, the DU rings, the pile outlines, both survey contour layers, and the sample
points. Tolerance is 10 screen pixels converted through the zoom, so it feels identical
at any scale.

The static sources — about **56,600 segments** — are indexed once into a uniform grid
hash (250 ft cells), off the boot path, in roughly 20–30 ms; your drawings are re-indexed
on every store change, which is cheap because there are few of them. A hover therefore
costs only the cells the tolerance box touches. Intersections are computed pairwise, but
only among the handful of segments already inside that box, never globally.

The glyphs (□ endpoint, △ midpoint, ✕ intersection, ⊥ perpendicular, ○ nearest) are
painted on **one 2D canvas stretched over the map**, along with the tracking ray and its
readouts. Leaflet markers were the obvious alternative and the wrong one — a marker per
hover churns the DOM on every mouse move.

**Ortho and polar tracking.** Hold **Shift** while sketching to lock the segment to
0/90/180/270° from the last vertex; **`POLAR`** (or `F10`) locks it to 15° increments,
with a dashed tracking ray and a live angle-and-distance readout by the cursor. Object
snap always wins over both. Leaflet's shift-drag zoom box is disabled while a sketch is
live, so Shift means ortho and nothing else.

**Typed input.** During any sketch or modify command, typing a digit, `@`, `.` or `-`
opens a small dynamic-input box at the cursor with a live parse hint:

| you type | it means |
|---|---|
| `150` | 150 ft along the current cursor direction from the last vertex |
| `@150,75` | relative Δeast, Δnorth in feet |
| `@150<45` | relative polar — feet, then degrees CCW from east (`0°` = east, as in AutoCAD) |
| `150<45` | the same, tolerated without the `@` |
| `6371500,2128900` | absolute State Plane — also valid for the **first** vertex of a sketch |

`Enter` commits the vertex, `Esc` closes the box without cancelling the sketch. During
ROTATE a bare number is read as an angle in degrees instead of a distance.

**Command line** (the `CMD` button, `` ` `` or `Ctrl+K`). One collapsible line above the
status bar, with an autocomplete dropdown, `↑` history and `Tab` completion. Commands that
act on a drawing use the current selection, or ask you to click one; commands that need a
value either take it inline (`OFFSET 25`) or prompt for it on the same line.

| Command | Aliases | Does |
|---|---|---|
| `PLINE` | `PL` `LINE` `L` | polyline / distance sketch |
| `DIST` | `DI` `DISTANCE` | distance between points |
| `POLY` | `POLYGON` `AREA` `AR` | closed area sketch |
| `VOL` | `VOLUME` | volume footprint |
| `PROFILE` | `PR` | elevation profile |
| `ID` | `INSPECT` `SPOT` | spot elevation |
| `OFFSET` | `O` | parallel copy at a distance |
| `MIRROR` | `MI` | mirror about a 2-point axis |
| `ROTATE` | `RO` | rotate about a base point |
| `MOVE` / `COPY` | `M` / `CO` `CP` | base point → destination |
| `JOIN` / `EXPLODE` | `J` / `X` | join two lines / polygon → line |
| `ERASE` | `E` `DEL` | delete the selection |
| `DIM` | `DIMALIGNED` `DIMLINEAR` | aligned dimension |
| `TEXT` | `MTEXT` `TX` | annotation, optional leader |
| `DXFOUT` / `DXFIN` | `DXFEXPORT` / `DXFIMPORT` | DXF out / in |
| `SAVE` / `OPEN` | `SAVESESSION` / `LOAD` | session file out / in |
| `ZE` / `ZW` | `ZOOMEXTENTS` / `ZOOMWINDOW` | zoom extents / window |
| `3D` · `TABLE` · `OSNAP` · `POLAR` · `UNDO` · `CLEAR` | `VIEW3D` · `SAMPLES` · `OS` · `PO` · `U` | toggles |
| `HELP` | `?` `H` | the full reference sheet |

**Modify tools** run on the same event loop as the sketching engine — a fixed point count,
a live ghost the command supplies, `Esc` to bail — rather than a second interaction system.
All of them are undoable and all recompute their measurements afterwards.

*OFFSET* takes a distance and a click for the side. Polygons and open polylines are offset
per edge and joined with **miters**, bevelled past a 10× miter limit. The result is checked
before it is created: if the offset outline crosses itself, or the ring collapses through
itself, the command **refuses and says why** instead of producing a bow-tie.
*MIRROR* and *COPY* leave the original and add a copy; *ROTATE* and *MOVE* work in place.
*ROTATE* measures the angle of the rubber-band line from the base point, the way AutoCAD
does, and accepts a typed angle. *JOIN* stitches the selected line to a second one you
click, at whichever pair of endpoints is closest, and reports the gap it bridged.

**Dimensions and annotations** are feature types like any other — they appear in the
Features tree, carry style and folder, serialize, and export.

*DIM* is an aligned dimension between two clicked points: extension ticks, a dimension line,
solid arrowheads and the distance centred and rotated to the line, kept right-way-up. The
graphic furniture is sized in **screen pixels converted to map feet**, so a dimension reads
the same at every zoom; the Properties tab has a slider to offset the dimension line off the
measured points. Editing either endpoint re-measures live.
*TEXT* places a label at a click, with an optional second click for a **leader**. Its height
is in **map units** (feet, default 20) with 9–34 px clamps, so it scales with the map without
ever becoming unreadable or swamping the view.

In 3D both drape into the drawings overlay — the geometry as draped lines, the label as a
cheap cached canvas sprite above it.

**DXF round-trip** (`DXFOUT` / `DXFIN`, the Export menu, the Import button, or drag-drop).

*Out*: ASCII **DXF R12 (AC1009)** — deliberately the oldest, most universally readable
flavour, since nothing here needs anything newer. `POLYLINE`/`VERTEX`/`SEQEND` for lines and
polygons, `POINT` for spots, `TEXT` for annotations, and dimensions written as their
**exploded graphic** — lines plus a `TEXT` — because R12's `DIMENSION` entity needs a block
definition to render and degrades badly across readers, while exploded lines look identical
everywhere. Coordinates go out **raw, in State Plane feet (EPSG:6418)**: the same numbers the
project's AutoCAD drawings carry, so the file lands on the survey with no transform. Layers
come from each feature's folder, or its type (`SBMM-VOLUME`, `SBMM-DIM`, …), and layer
colours are the **nearest ACI index** — the palette is generated, not pasted: ACI 10–249 is
24 hues × 5 values × 2 saturations in exactly that order, so a nearest-RGB match lands on an
index whose real colour is the one that was matched.

*In*: R12 and 2000 ASCII — `LINE`, `LWPOLYLINE`, `POLYLINE`/`VERTEX`, `TEXT`/`MTEXT`,
`POINT`, `CIRCLE` (→ 32-segment polygon) and `ARC` (→ polyline), filed into `DXF/<layer>`
folders. Coordinates are **checked, never guessed**: values that read as latitude/longitude,
as small local model coordinates, or as metres cause the import to be refused with what it
saw, because silently misplacing a drawing by a thousand miles is worse than not importing
it. The e2e test exports a mixed feature set, re-imports it, and asserts the geometry comes
back within **0.01 ft** (it currently comes back exact).

**Keys** — `F3` object snap · `F10` polar · `Shift` ortho · `` ` ``/`Ctrl+K` command line ·
`N` dimension · `X` text · `Esc` cancels the innermost thing (typed input, then the command,
then the selection).

**Validation** — on the lidar surface the Pile 1 traced footprint returns **278.4 yd³ fill /
−48.1 net**, and `test/e2e.mjs` asserts that baseline to ±10 yd³. **The baseline moved with the
terrain source**: the earlier CAD-contour-derived surface returned 260.5 / −58.3 (the test
asserted ≈261 / −57) and the scipy analysis behind the ABP memo returned 262 / −58, so going
to the lidar surface shifts Pile 1 fill by about **7%** — still within the planning-level
tolerance the memo reports to two significant figures. The difference is real, not a
regression: the lidar grid resolves pile micro-relief that 1-ft contour interpolation
smoothed away. Anyone comparing new numbers to the memo should quote the surface they came
from.

**Earthworks agreement.** On a scripted 300 × 300 ft pad at the mean rim elevation
(6371400–6371700 E, 2128700–2129000 N, 1-ft grid), the auto-balance solver converges to
**cut and fill within 0.2 %**, and cross-sections along a 300-ft alignment at 50-ft stations
with a 260-ft swath total **1.2 % apart** from the grid integration of the same corridor by
the average-end-area rule. The uncertainty range over that footprint keeps the perimeter-TIN
result as *best*, so the memo baseline is unchanged by anything in this section — the e2e
test asserts all three.

Fixing the daylight line turned up a **latent bug in the contour kernel**: Douglas–Peucker
anchors on the first and last vertex, and a closed marching-squares ring closes *bit for
bit* (adjacent cells compute the shared edge crossing from the same two corner values), so
the baseline had zero length, every perpendicular distance came out 0 and the whole ring
collapsed to two coincident points. Closed contour rings — hilltops, depressions — were
therefore being silently dropped by `contoursFromGrid` too. Both now go through
`simplifyPath()`, which splits a ring at its farthest vertex first.

Grid sampling is checked against the master raster directly: (6371600, 2128900) reads
**1387.62 ft** on the 1-ft mine-area window and (6374000, 2126000) reads **1689.74 ft** on the
2-ft site grid, both matching a NumPy bilinear probe of the source raster to <0.01 ft — those
two probes also run inside `tools/build_dems_from_master.py`, which aborts if either drifts.
The e2e test additionally checks (6372000, 2130500) — about 1,100 ft north of the ABP, well
outside the *old* 1-ft window — now resolves on the **1-ft** grid. Note the mine-area window
is a rectangle over an irregular survey footprint: its western corner (e.g. 6370500, 2130500)
has no coverage and correctly returns no elevation rather than an interpolated guess.

## Smart boundary tools

Everything above measures a shape you drew. This section is about not having to draw
it. Each tool turns one click into an outline — and then gets out of the way: the
result is an **ordinary area or line feature**, with a name, a folder, a colour,
Properties, session persistence, DXF/GeoJSON export and the same vertex editor as
anything you sketched by hand. Nothing here is a layer you cannot touch afterwards.

That is deliberate. None of these methods is right every time, and the person looking
at the screen is the one who knows whether that mound is one pile or two. The tools
are a fast first outline, not an answer.

All four run their raster work in the compute worker, report progress, cancel
superseded jobs, and are undoable.

| Command | Aliases | Does |
|---|---|---|
| `WAND` | `PILEWAND` `MAGIC` | delineate a mound by morphological top-hat — the memo's method |
| `CBOUND` | `CONTOURBOUND` `CB` | trace the closed terrain contour through a clicked point |
| `TOE` | `CREST` `BREAKLINE` | the line where slope crosses a threshold |
| `STANDS` | `CANOPY` `CLEARING` | polygonise canopy stands over a height threshold |
| `TREES` | `TREE` `INVENTORY` | detect individual trees across the canopy window |

### Pile wand (`WAND`)

The ABP technical memo delineated the waste-rock piles by **morphological top-hat**:
open the DEM with a disc (r = 35 ft) to build a base surface that can slide under the
terrain everywhere but cannot climb into anything narrower than the disc, then take
the footprint as the closed **0.75-ft residual contour**, excluding rim faces steeper
than **0.30**. That method string is carried in `data/piles.json` on every pile part.
`WAND` *is* that method, run interactively.

Click a mound; the tool opens a local window, computes the residual, floods out from
the click, traces the mask with marching squares and hands back a simplified ring at
roughly one vertex per 3 ft. While the tool is armed the residual is washed over the
map, so you can see what a click will capture before you commit to it.

**Three things had to be got right, and each of them was wrong first:**

*The slope cutoff is load-bearing.* A waste pile is a low mound — a few feet of relief
over a hundred — but it sits against mine highwalls that are far steeper, and those
faces carry a large residual too, because a 35-ft disc cannot climb them either.
Without the cutoff the flood fill walks off the pile and up the hillside: it returned
**2× to 4×** the memo footprint on every pile tested. (The cutoff was also silently
inert at first — `job.slopeCut > 0` is `false` when the parameter is absent, so the
default was *no test at all*.)

*Slope has to be measured at landform scale.* At one 1-ft cell the "slope" of bare
waste rock is roughness, not landform, and reads over 0.30 nearly everywhere — so a
0.30 cutoff rejects the pile itself. Measured over a lag, it is a property of a face.

*The terrain is not the terrain the memo used.* The memo worked on a DEM interpolated
from 1-ft contours, which is smooth by construction; this app carries the raw lidar
grid, which resolves micro-relief the contours never had. Run against the raw grid the
0.75-ft threshold is unstable — the delineation either chokes off at the click or
leaks across the whole bench. A mean filter (18 ft by default) puts the surface back at
roughly the effective resolution the method was calibrated on, and it reproduces.
This is the same effect the README already records for volumes, where the lidar
baseline legitimately moved Pile 1 from 260.5 to 278.4 yd³ — it is simply much larger
for a footprint, because a threshold is a hard cut.

Against the memo's published part areas, with the shipped defaults:

| pile part | memo | wand | |
|---|---|---|---|
| Pile 1 | 0.184 ac | 0.068 ac | −63 % |
| Pile 2 | 0.321 ac | 0.422 ac | +32 % |
| Pile 3 part 1 | 0.184 ac | 0.225 ac | **+22 %** |
| Pile 3 part 2 | 0.164 ac | 0.225 ac | +37 % |
| Pile 4 part 3 | 0.180 ac | 0.201 ac | +12 % |

Four of five inside 40 %. Pile 1 is the outlier and the reason is structural: it is the
smallest pile at 0.184 ac — about a 50-ft radius — so an 18-ft smoothing radius is
comparable to the feature itself and flattens it. Turn the pre-smoothing down for
small mounds; every parameter is on the card.

Note also that the wand returns **one connected mound**. Where the memo split a pile
into parts, a single click returns whichever connected part-complex it hits — Pile 3
parts 1 and 2 are one region at this threshold, which is why both rows above show the
same number. The card says so when it happens.

A traced pile offers **one-click volume** on its card, against the perimeter TIN — the
memo's own base surface. The e2e test checks that number against the same footprint
integrated on an independently built TIN (quarter perimeter density): **0.5 % apart**.

### Contour-snap boundary (`CBOUND`)

Click a point and the closed terrain contour through it becomes an area — ponds,
benches, impoundments. Type an elevation, or let it take the clicked ground.

Two things this needed. First, taking the click's own elevation as the level is
**degenerate**: the click then lies exactly *on* the line being traced, and which side
it falls on is decided by rounding noise. That returned a 13-point speck on a 20-acre
impoundment. The level is nudged a hair above the clicked ground so the click is
strictly inside the ring that encloses it. Second, among the nest of rings that
encloses any click, it takes the **largest**, not the smallest — the innermost is a
puddle-sized artefact, the outermost is the pond you pointed at.

On the Herman impoundment (the flooded pit — a flat 1336.6-ft water plateau) it traces
**20.36 ac** against a 20.63 ac ground-truth measurement of the same plateau. That
feature also runs off the east edge of the 1-ft mine-area grid, so it exercises the
fall-back to the 2-ft site DEM; picking the wrong grid there silently truncates the
shoreline and nothing closes.

### Toe and crest lines (`TOE`)

Click on a slope and the line where the gradient crosses a threshold (15 % by default,
`CREST` for the other sense) becomes a line feature.

Kept honest about what it is: this is a **slope-magnitude contour**, not a
hydrologically conditioned break line. It finds where the ground changes steepness,
which is what a toe or a crest is, but it has no idea which side is uphill. The
gradient is computed on smoothed terrain over a lag for the same reason the wand needs
it — contouring the raw 1-ft gradient at 15 % shattered into **5,616 fragments**
averaging a few feet long, which is noise. Smoothed, the same click gives 44 chains and
a 154-ft line. Where several chains cross the threshold nearby, it takes the one
nearest the click and the toast says how many it passed over.

### Canopy stands (`STANDS`)

The clearing-limits tool. Sketch a polygon (or take the whole view), and canopy at or
above a threshold height (6 ft by default) is closed to bridge 1-cell gaps,
connected-component labelled, filtered by minimum area (500 ft²), and polygonised into
a **Canopy stands** folder with a total acreage.

Areas are reported as **canopy-cell area**, not ring area. A stand's outer ring encloses
internal clearings, so its ring area reads larger — on the test area, 10.28 ac of ring
around 9.36 ac of actual canopy. Quoting the ring area as canopy would overstate a
clearing quantity by a tenth, so both are carried and the card says which is which.

## Water — raindrop and overtopping

> **Herman Impoundment, with the survey in.** Today's water is the surveyed **1,336.45 ft**
> (Aug 2026). The first discharge is not the rim: it is the two 24-in pipes at invert
> **1,341.55 ft**, 5.10 ft up and 109 ac-ft away. The sandbag crest beside them is 1,343.54;
> the lidar rim spills at **1,343.84 ft**, 7.39 ft up and 161 ac-ft away, and the overflow
> runs 966 ft west to Clear Lake. The card shows all three stages, the slider snaps to them,
> and each has its own route.

Two static terrain analyses over the same January-2024 lidar bare earth the volumes come
from. Neither is hydraulics: there is no rainfall, runoff, infiltration, seepage, wave
run-up or time anywhere in either of them. They say what the ground shape implies, at
planning level, and every card says so.

### Raindrop (`R`, `DROP`, the Water ▾ menu, or "trace a raindrop" on any point card)

Click anywhere and a drop lands there and runs downhill by **steepest descent (D8)** over
the finest DEM that covers it — 1-ft over the mine window and the residential lots, 2-ft
elsewhere. Where the run reaches a low point it **ponds**: the depression is filled to its
pour point by a priority flood, the pond is drawn with its level, depth, area and volume,
and the drop carries on from the pour point. Descent reads a pond cell as its pond's
*level*, never its floor, so a drop that leaves a pond cannot fall back into it.

A pond is reported when it is deeper than **0.25 ft** — the lidar noise floor. Anything
shallower is crossed silently, because a "pond" 0.1 ft deep on a 1-ft grid is a rounding
artefact drawn as a water body.

The run ends in one of three ways, and the end marker says which:

| ends | what it means |
|---|---|
| `reaches Clear Lake / survey limit` | the next cell has no surveyed ground under it |
| `ponds here — no outlet within N ft` | a genuine sink: the depression's outlet is not inside the search window |
| `stopped at the length cap` | 20,000 ft or eight chained windows |

The window is a square **±700 ft on a 1-ft grid, ±1,400 ft on the 2-ft grid**, centred on
the drop. If the run leaves it, the host re-runs it centred on the exit cell, on whichever
DEM covers *that* point — so a run that starts on the 1-ft mine grid and leaves it carries
on over the 2-ft site grid, and the card lists every grid it used. One analysis is still
computed on one grid at a time; what changes at the seam is stated rather than blended.

The result is an ordinary feature of the new type **`flow`**: it is in My work under a new
**Water** class row, in the Inspector, in sessions, in GeoJSON (a `LineString` plus one
`Polygon` per pond) and DXF (`WATER` and `WATER-PONDS`), undoable, and drawn in both 2D and
3D. Its vertices are not editable — a flow path is traced, not drawn — but the **raindrop
marker is draggable**, and dropping it retraces in place, keeping the feature, its id and
its card, with one undo entry that puts the old run back.

Two actions on the card go further: **profile** turns the run into an ordinary elevation
profile feature with the interactive chart, and **catchment** floods upslope on the
pit-filled DEM to give everything that drains to the drop. A catchment that reaches the
edge of its window is reported as a lower bound and says so.

### The August-2026 survey

A Jacobs limited topographic survey of the Herman Impoundment water level, the two 24-inch
corrugated HDPE discharge pipes and their inverts, the sandbag wall beside them (top and
toe) and the Northwest Pit low is in the app: its 24 shots as the **Survey — Aug 2026**
dataset under Investigations, its linework (pipes, wall, pit contours) as five rows of its
own, snappable, draped in 3D and exported with everything else. The plot was placed from its
own tabulated points to 0.01–0.02 ft (`tools/build_survey_2026.py`). Click a pipe for its
invert and **trace discharge** — where water leaving the pipe runs.

### Storm drainage (v12)

The site has a drainage system, and until v12 the app did not know about it: a raindrop that
reached a grate walked past it. The **storm network** is now in the app as read-only project
data — 43 structures and 25 conduits assembled by `tools/build_storm_network.py` from EA's
V-Base drawing, the geodatabase's storm structures, Jacobs' August-2026 survey and the
project engineer's identification of the south-road drain. Three rows under **Site framework
→ Storm drainage**, on by default: *Storm structures* (43), *Storm conduits — drawn in CAD /
surveyed* (15) and *Storm conduits — inferred* (10). Click a structure or a pipe for what it
is, where it came from, its ground and its invert, its length and its fall.

| conduit | from → to | source | note |
|---|---|---|---|
| `pond_culvert` | Frog Pond's west shore (the **east** pond; Spot 5, **inferred — no CAD structure**) → Spot 1, 75 ft west, under the paved road | the engineer's spots | the culvert between the two ponds; discharges overland into Green Pond (the west pond). Inverts unknown |
| `green_outlet` | the `STRM FES` on Green Pond's west shore → the Spot 8 grate | EA's FES + the engineer | 106 ft, **inferred**: Green Pond's overflow, piped under the road into the road drain — not into the impoundment |
| `green_riser` | the `STRM INLET ROUND` at Green Pond's NW corner → an `STRM FES` discharging toward Herman | CAD culvert mark `E5D2D` | 62 ft under the gravel road; the pond's **high-level** overflow, above the FES |
| `road_drain_8_9` … `road_drain_14_15` | grate Spot 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 | EA's structures; **alignment inferred straight — EA drew no line here** | the culvert along the top of the grates, 1,895 ft in seven conduits so a survey can fill inverts one at a time |
| `road_drain_15_branch` | grate Spot 15 → the branch start (a bend, no structure) | inferred straight | 155 ft |
| `branch` | the branch start → the junction grate | CAD line `E943F` | 149 ft |
| `herman_pipe_n` / `herman_pipe_s` | the surveyed inverts at the sandbag wall (**1341.57 / 1341.53 ft**) → the plotted west ends | Jacobs survey, Aug 2026 | the two 24-in corrugated HDPE barrels |
| `pipe_to_main` | the North pipe's plotted west end → the east end of EA's drawn storm line | **inferred**: EA's line starts 13 ft west of the plotted pipe end | the connection he asked for |
| `storm_main_upper` | the storm line's east end → the junction grate | CAD `E943C` | 195 ft |
| `storm_main_lower` | the junction grate → the **Clear Lake outfall** | CAD `E943C` | 589 ft |
| `south_culvert` | `STRM FES` → `STRM FES` | CAD mark `E5D2E` | 40 ft under the south road, into Herman; not part of the grate chain |
| `culvert_*` | FES → FES | the other four `V-STRM-MRKG` marks, and every pair of flared ends within 40 ft with no mark | direction from the lidar ground at the two ends |
| `lot25_yard` | the Lot 25 catch basin → the pipe's west end | CAD `C-STRM-MAIN-PIPE` | 171 ft; the residential yard drain, unrelated to Herman |

**A conduit is a topological shortcut with an elevation at each end.** There is no capacity,
no hydraulic grade line, no surcharge and no time in any of this — EA's CAD carries no
inverts, no diameters and no materials anywhere on the system, and the only surveyed inverts
in existence are Jacobs' two pipes at the sandbag wall. A pipe's fall is reported where both
ends have an elevation and says "unknown — no invert" where they do not. Nothing is guessed:
`rim_ft` is the lidar ground at the structure, computed on boot so it follows the DEM stack,
and `invert_ft` is blank until somebody surveys it.

What it changes: **a raindrop that reaches within 3 ft of an inlet goes down the pipe**, and
a depression that fills to an inlet's rim drains through it instead of over its rim. The run
gains one *leg* per conduit — drawn as a straight dashed steel-blue line with an "in pipe"
label, and as a straight tube in 3D — and the card reports **In pipes** and **Total**
separately from **Run length**, which stays the overland distance. A pond drained by a grate
says so ("drains to Grate inlet — Spot 8 at 1,397.3 ft").

Two switches, both remembered: **`STORM`** (also the Water ▾ menu, and a chip on the
raindrop HUD) turns the whole network off, and every analysis is then exactly the
ground-only one it was in v11; and each conduit's popup has a **broken / working** toggle,
for the pipe you have just found collapsed. A disabled conduit is not passed to the analysis
at all.

Two answers worth having in front of you:

- A drop on the **Spot 8 grate**: 137 ft overland and **2,789 ft in pipe** — the seven
  road-drain conduits, the branch and EA's storm main — ending in Clear Lake at the outfall.
  With the drains off, the same drop runs 2,268 ft overland into the Herman Impoundment,
  fills it to 1,343.84 ft and spills over its rim.
- A drop at **Frog Pond's low** (the east pond): it takes the culvert under the paved road
  into Green Pond, which fills 3.1 ft to the FES on its west shore (1,394.50 ft), takes the
  pipe to the Spot 8 grate and the whole road drain to the Clear Lake outfall — **630 ft
  overland, 2,969 ft in pipe** through twelve conduits, never touching the impoundment. With
  the drains off it never leaves the north-east corner: it spills off the survey.
- **Naming.** EA's geodatabase `water` layer has it right, and the engineer confirmed it (Sep 2026): **Frog Pond is the east pond** (E 6,374,450–6,374,726, floor 1,415 ft) and **Green Pond the west pond** (E 6,373,925–6,374,152, floor 1,391.6 ft). The storm network uses those names.

The **Herman pipe discharge route** (on the overtopping card) now reads *"934 ft · 797 ft in
pipe · Clear Lake outfall"*: what leaves the surveyed 24-in pipes goes down EA's drawn storm
main to the lake rather than stopping at a stub of overland flow.

**A sunken pipe mouth.** The lidar is the January-2024 flight; the sandbag wall and the two
24-inch discharge pipes were surveyed in August 2026 and were built into a regraded channel
the lidar never saw. So the 1-ft cells at the surveyed invert points read 1,344.66 and
1,344.80 ft — the top of the sandbags, not the pipe — and a naive analysis would have the
impoundment go over its 1,343.84-ft rim while a 24-inch pipe two feet under the water
surface did nothing. The rule is: **an inlet whose surveyed invert lies below the lidar
ground at its own cell is a pipe mouth the lidar did not see**, and the analysis enters it at
the nearest cell the lidar *does* see at or below that invert, within 30 ft. Here that moves
the North pipe 25.6 ft and the South 27.1 ft, onto the channel floor at 1,341.5 ft; the rim
stays the surveyed invert, and the structure's popup and the raindrop's card both say the
inlet cell was moved and by how far. If nothing low enough is found within 30 ft the inlet
stays exactly where it was surveyed and the popup says so.

The consequence: **a drop inside the Herman Impoundment now ponds to 1,341.54 ft and leaves
through the surveyed South pipe**, the storm main and the outfall — 813 ft in pipe — instead
of filling 2.30 ft higher and spilling over the rim. That is the same first discharge the
overtopping card has reported since v10 (1,341.55 ft, the surveyed invert), so the raindrop
and the overtopping analysis now give the same answer about the impoundment. Switch the
drains off and the raindrop goes back to the rim: the difference between the two is exactly
what the survey bought.

### Overtopping (`OVERTOP`, the Water ▾ menu, or a water polygon's popup)

For a water body — the Herman Impoundment by default, or any pond under a click — this
answers where and at what level it first spills.

The **water surface** is not assumed: it is the lidar's own flat return over the pond.
`z0` is the median elevation of the DEM cells inside the water polygon, and the seed is
every cell within 0.3 ft of it. For Herman that is 223,894 cells — 20.6 ac at 1,336.58 ft.

From that seed a **sealed** priority flood raises the level. A neighbour below the current
level either lies inside the same depression (its pit-filled elevation equals the pour
level) and is flooded, or **escapes** — its filled elevation is strictly below the level,
so water reaching it drains away to a sink — and is sealed off as a wall while the cell
that touched it is recorded as a **spill cell**. The first spill cell is the answer:

| Herman Impoundment | |
|---|---|
| water surface (lidar, Jan 2024) | 1,336.58 ft |
| spill elevation | 1,343.84 ft |
| freeboard | 7.26 ft |
| spills at | E 6,371,926, N 2,127,692 |
| storage to spill | 158.0 ac-ft (6,881,929 ft³) |
| area at spill | 22.83 ac |
| rim lows within +3 ft | 5 (1,343.84 · 1,344.34 · 1,346.52 · 1,346.68 · 1,346.76) |
| overflow route | 966 ft, reaches Clear Lake |

The **escape test is against the pit-filled DEM, not against "is the neighbour lower"**,
and that distinction is the whole analysis. Every shoreline cell of a 20-acre pond has a
lower neighbour somewhere; testing for one reports a spill at the water's edge and a
freeboard of 0 ft. Testing whether that neighbour *drains to a sink below the current
level* is what separates the far side of the dam from a puddle inside the bowl.

Around the water the tool paints a **ring of rim elevations**: every rim cell within 3 ft
above the spill, coloured by how far above it stands — hot red at the spill, fading to pale
yellow at +3 ft — with the exact spill cells picked out in saturated red so they survive
any zoom. The low points are clustered, ranked ①②③ and labelled on the map and in a table
on the card; clicking either zooms to it. A **level slider** walks the water from today's
surface past the spill: below the spill the label reads "no overflow", at it the overflow
route appears and the label reads "OVERFLOWS at ①", and above it the label adds "(if the
rim at ① were raised)" — because above the spill the sealed flood is describing a *change
to the site*, not a prediction. A **stage–storage chart** plots storage in ac-ft and area
in ac against level, with the spill marked.

Two of the outputs are real features and survive in the session: the **overflow route**
(a `flow`, traced from the spill's lowest escaping neighbour with the impoundment itself
pre-marked as a pond with no outlet, so a route that curls back ends there rather than
climbing in) and the **pond at the spill level** (an `area` carrying the analysis on
`props.overtop`). The band, the markers and the slider are overlay, not data: they are
recomputed by running the analysis again, which takes a couple of seconds.

The overflow route is deliberately traced on the **same grid and window as the analysis
that produced it**. Retracing it on the finest DEM under the spill would be a second
analysis wearing the first one's answer.

#### First discharge — the storm network (v13)

A pond rarely spills over its rim first. If a storm inlet stands inside the rim, the water
leaves through it, and since v13 the overtopping analysis knows that: `overtop` takes the
same conduit list the raindrop takes, and during the sealed flood the **first inlet whose
rim the rising level reaches** is reported as the **conduit spill** — a "First discharge"
row above the rim spill, an exact stage row at that level, a "C" marker on the map, and its
own route, a raindrop dropped on the inlet with the network on. Submerged inlets are
tracked and re-tested as the level rises, exactly the way `flowpath` does it.

It is **added beside the rim analysis, never in place of it**. The flood itself is
untouched: the rim spill, the ranked rim lows, the band, the freeboard, the storage and the
0.25-ft stage buckets are the numbers they were, and `fillDem` is *not* seeded here (that is
the raindrop's rule). With the drains off, or in a build with no network, the analysis is
bit-identical to v10's — `test/kernels.mjs --only water3d` asserts that field by field.

| | first discharge | rim spill |
|---|---|---|
| **Frog Pond** (the east pond) | `pond_culvert` at **1,415.74 ft** (+0.74, 0.8 ac-ft) | 1,416.04 ft (+1.04) |
| **Green Pond** (the west pond) | `green_outlet` at **1,394.50 ft** (+2.90, 2.1 ac-ft) | 1,399.14 ft (+7.54) |
| **Herman Impoundment** | the surveyed 24-in pipes at **1,341.55 ft**, `via herman_pipe_s` | 1,343.84 ft |

Frog Pond is the case that prompted it. Its natural rim spill is ten feet from the culvert
inlet on its west shore and 0.30 ft above it, so the overflow route used to run *north* over
the ground. Now the first-discharge route takes the culvert under the paved road into Green
Pond, leaves through Green Pond's own FES, and runs the road drain to the Clear Lake
outfall — 2,969 ft of it in pipe. On Herman the conduit spill *is* the surveyed pipe
(1,341.53 against the survey's 1,341.55), so the surveyed row simply gains `via
herman_pipe_s`: one row, one marker, one route, no double-counting.

#### Conduits first — the rim overflow is a what-if (v15)

**When the water finds a conduit below the rim, the conduit IS the overflow.** Since v15 the
first-discharge route is the only route traced and drawn by default. The rim spill stays on
the card as a fact — *"Rim spill (lidar) 1,416.04 ft · +0.30 ft above pond culvert — not
traced; the drains are assumed to handle it"* — the rim band and the ranked rim lows are
drawn exactly as before, and the "Overflow route" row says **"not traced — the drains are
assumed to carry it"** rather than claiming water goes that way.

A **trace the rim overflow** button on the card traces it on demand. It is named for what
it assumes — *"Frog Pond rim overflow — what-if: pond culvert blocked"* — and drawn as a
hypothesis: dashed, in a muted slate (`#93A6B3`) that is neither the water blue nor the
storm blue, with no glow and no animation. It belongs to the analysis: pressing the button
again removes it, and so does closing the analysis. Above the rim the slider reads *"above
the rim · the drains are assumed to carry it (trace the rim overflow to see the what-if)"*.

The rule is generic — any water body with a conduit spill below its rim. On **Herman** the
conduit spill *is* the surveyed 24-in pipes, so the pipe route is the overflow and the rim
route becomes the what-if; every §10 number is unchanged, only the default visibility of the
rim route moved.

The chain reads back as a sentence, built from the route's own legs and the ponds it filled
on the way. Frog Pond's card says:

> → Green Pond (fills to 1,394.50) → green outlet → road drain → branch → storm main → Clear Lake outfall

The level slider snaps onto the conduit row as it does the surveyed ones. Below it the
first-discharge route does not show; from it, it does.

### Water in 3D (v13)

Every visible flow path carries a **particle stream** in 3D: dots spaced ~20 ft along the
arc, moving at 40 ft/s, draped on the terrain over each overland stretch and running
straight down each conduit leg in the storm colour, so the pipe visibly carries the water
underground. The geometry and the draped elevations are computed **once per overlay
rebuild**; the render loop only advances a scalar and writes into a pre-allocated array,
and it asks for frames *only* while a visible flow is on screen and **Animate water** (View
settings, default on, remembered) is ticked. With nothing flowing the 3D view still costs
zero renders when idle. The particles are not pickable — the flow's own draped line is
still what a click selects.

With an overtopping analysis open, the 3D view also draws the **water surface at the slider
level** as a translucent blue polygon at that elevation (holes honoured), with a label at
each rim low, at the conduit spill and at the surveyed pipes. Moving the slider moves the
surface; closing the analysis clears it.

## The 3D view (v15)

### Labels that say where the water is

The 3D labels are a **layer**, not fixed sprites. Each one is a chip sized in *screen*
pixels — the same size at any range — on a translucent dark plate, with a thin leader down
to the point it is about, and a greedy collision pass in screen space keeps them from
landing on each other (highest priority first, at most 60 at a time).

**The stage labels follow the slider.** Every step re-states what each one means at the
level you are looking at, and the viewer diffs them by text so only the chips whose words
changed are rebuilt:

| below the level | at or past it |
|---|---|
| `rim low 2 · 1,344.34 · +0.39 ft to go` (amber) | `rim low 2 · 1,344.34 · overtopped` (red) |
| `first discharge · pond culvert · 1,415.74 · +0.74 ft to go` | `… · discharging` (storm blue) |
| `water level 1,343.95 ft` at the water surface's centroid | |

Dimension values, text annotations, pond levels and the recovered design surfaces go
through the same layer and are **deduped by key**, so a pond crossed by three routes carries
one label in 3D exactly as it does in 2D.

### The same rule in 2D — `js/labels.js`

Every permanent label on the 2D map — pond levels, flow ends, the ranked rim-low markers,
catchment acreages, excavation depths, the "in pipe" labels — is registered with one engine.
It does two things: **dedupe by key** (two labels stating the same fact show once, the
higher priority wins) and a **greedy collision pass** after every move, zoom, add or remove
(highest priority first; a label whose box touches a kept one is hidden with
`visibility:hidden`, never removed, so it returns on its own when it fits again). Zoom gating
stays where it was; the engine adds collision on top. Field mode uses the same engine.

### Lighting, sky and materials

A vertical gradient sky with distance fog matched to its horizon, so the edge of the survey
fades into the sky instead of ending in a hard line; a lake-coloured plane below the
terrain's lowest point; a hemisphere light plus one directional key light. The key light's
**azimuth and elevation** are sliders in View settings (default 315° / 35°, remembered), so
the 3D relief can be lit the way the 2D hillshade is lit.

Overlay polylines carry a dark **drop shadow** a foot below them — merged into one
LineSegments, so the whole effect is a single draw call — which is what makes a bright line
readable over a bright orthophoto (WebGL cannot widen a line, so an outline has to be
geometry). Points are small discs with a dark ring rather than hard squares. Your own closed
features — areas and volume boundaries — gain a soft fill that follows the ground (the ring
is triangulated in plan and every vertex lifted to its own draped elevation); the site-wide
polygons keep their outline, because a translucent fill over the whole site is exactly the
overdraw a software-GL frame cannot afford. The selected
feature gains a brighter halo that **pulses for a second and a half** and then settles: a
halo that pulsed for ever would ask for a frame for ever, and an idle 3D view that keeps
rendering is exactly what this viewer's render-on-demand contract forbids.

### Chrome and keys

View presets (top / north / south / east / west / isometric), **Frame** (fit to the
selection, or the mine area), **Look at…** (arm it, then click a point to centre the view
there), the compass, and a small **elevation legend** showing the site's own range in the
hypsometric ramp the 2D elevation tint uses.

| key | |
|---|---|
| <kbd>1</kbd> <kbd>2</kbd> <kbd>4</kbd> <kbd>5</kbd> <kbd>6</kbd> | top / north / east / west / isometric |
| <kbd>Shift</kbd>+<kbd>3</kbd> | look from the south — a bare <kbd>3</kbd> opens and closes the 3D view, as it always has |
| <kbd>Shift</kbd>+<kbd>F</kbd> | fit to the selection — a bare <kbd>F</kbd> is fly mode, as it always has been |
| arrows | orbit · <kbd>Shift</kbd>+arrows pan |

### Parity — everything that works in 2D works in 3D

`test/e2e.mjs` block **"9y. 3D parity"** builds a table: for every layer row that is ON,
the 3D scene must contain at least one object tagged with that row's `(group, id)`. v15
closed the gaps it found — EA's PDF-derived boundaries (drawn but untagged and unpickable),
**EA's own geodatabase lines and its whole boundary and existing-conditions half** (daylight,
grade and haul lines, lot lines, the OU, parcels, the water bodies, buildings, roads, fences
and the utility points: 580 features that were on in 2D and simply absent in 3D — now merged
one draw call per layer, with the segment-to-feature map that keeps a click naming the right
thing), the two survey contour sets (both were drawn whenever *either* row was on), the computed
contour set, cross-section station lines and their chainages, EA's four recovered design
surfaces (read-only `surface` features with no node grid, so the mesh branch skipped them
entirely and drew nothing), the drainage flow-path row, and one cultural point cloud per
layer instead of one merged cloud.

Two kinds of row are exempt, and the table prints the reason beside each: the basemaps and
computed rasters, which in 3D **are** the terrain drape (one picker in the toolbar, the same
pixels); and EA's CAD **base map** groups — contours (3,159 rings), parcels (2,788), roads,
buildings, fences, trees, utilities, symbols (15,045) — which stay 2D-only, because every
ring in 3D is resampled against the DEM every 10 ft on every overlay rebuild and the
viewer's 3,000-ring drape budget exists for that reason. EA's **design** groups — limits of
excavation, daylight, grade, repository, borrow, staging, haul — are drawn.

### Where the numbers come from

Both tools are kernels in `js/compute.js` (`flowpath`, `overtop`, `catchment`), so they run
in a worker with progress and cancellation. They were validated against an independent
Python implementation of the same definitions over the same PNG-decoded grids:
`test/water_kernels.mjs` reproduces all 37 reference numbers in `docs/V10_WATER_SPEC.md` §9
in node, without a browser, and is the fast loop for anyone touching them.

## Drainage map — where every acre goes

> **The whole site, 978.5 surveyed acres, coloured by the outlet each square foot
> drains to.** Three answers and nothing else: **403.1 ac (41 %)** run overland
> into Clear Lake, **293.5 ac (30 %)** leave the surveyed ground at its edge, and
> **282.0 ac (29 %)** reach the Clear Lake outfall through the storm network —
> almost all of that by way of the Herman Impoundment and the two surveyed 24-in
> discharge pipes. Switch the drains off and the outfall's 282 acres split back
> to the lake (+118.2) and off-survey (+163.8): the impoundment fills to its
> 1,343.84-ft rim and spills over it instead.

Type `DRAIN` (or `DRAINAGE`, `WATERSHEDS`, `CATCHMENTS`), pick *Drainage map* from
the Water ▾ menu, or tick one of the three rows under **Drainage (lidar + storm
drains)** in Site framework. The first tick runs the analysis; after that it is
cached until the storm switch or a conduit's status changes, at which point it
says "drainage map is stale — recomputing" and re-runs itself.

**It is the raindrop's physics run once over the whole site instead of from one
click** — the same filled DEM with conduit inlets seeded at their rims, the same
escape test, ponds read at their level, conduits as topological shortcuts. That is
not a claim, it is the acceptance test: `test/kernels.mjs` drops **100 seeded
raindrops** at pseudo-random surveyed points, traces each one with the raindrop's
own kernel and its own window chaining, and requires it to land in the catchment
the map drew under it. **All 100 agree.**

**Terrain only.** No rainfall, no runoff, no curve numbers, no time. The map says
where water goes, never how much — rainfall and volumes are Phase 2 of
`docs/V14_CATCHMENT_PROPOSAL.md` and are not built.

### What it draws

| row | what it is |
|---|---|
| **Catchments — by outlet** | one translucent polygon per terminal outlet: Clear Lake direct (deep blue), the storm outfall (steel blue), off the survey (grey), a closed depression (green). Acreage labelled at the centroid |
| **Catchments — by first capture** | the first pond or storm inlet each square foot reaches on the way — "what drains INTO Green Pond", which is the question that gets asked most |
| **Flow paths** | the single longest flow path inside each catchment, drawn as it runs (a pipe leg drawn as the straight jump it is) |

Hover brightens a catchment and names its outlet and acres; a click opens a card
with the outlet, the acres, the share of the site, the longest flow path
(**overland** — a pipe is not ground), the mean slope, and the grid it was
computed on. Every storm structure and conduit popup gained **"show what drains
here"**, which highlights every catchment whose water passes through it and
prints the total. The results card carries the outlet table, `copy CSV`, GeoJSON
(`DRAIN-OUTLET` / `DRAIN-FIRST` / `DRAIN-PATH`, every feature carrying its
`outlet` and `acres`) and DXF on the same three layers. All of it drapes in 3D.

### The recorded answers

Site grid, 2 ft, storm drains assumed working:

| outlet | acres | share |
|---|---|---|
| Clear Lake — direct overland | 403.05 | 41.2 % |
| Off the surveyed ground | 293.45 | 30.0 % |
| Clear Lake outfall (storm network) | 282.00 | 28.8 % |
| **surveyed total** | **978.49** | **100 %** |

| first capture | level | contributing |
|---|---|---|
| Herman Impoundment (via `herman_pipe_s`) | 1,341.53 ft, 22.18 ac of water | 37.90 ac |
| Frog Pond, the east pond (via `pond_culvert`) | 1,415.74 ft | 14.52 ac |
| Green Pond, the west pond (via `green_outlet`) | 1,394.50 ft, 3.08 ft deep | 2.62 ac |
| `green_riser` (the high-level overflow to Herman) | — | 1.34 ac |
| `south_culvert` | — | 1.75 ac |
| the eight road-drain grates, between them | — | **0.019 ac** |

That last row is a finding, not a missing catchment. **The road ditch runs past
the grates into the impoundment**, which then discharges through the surveyed
pipes; a 3-ft capture disc only takes the flow lines that actually cross it. It is
the same picture v12 recorded from the other end ("a raindrop at every one of the
nine grates runs overland into the impoundment or stays in the road ditch"), and
it is the number the invert survey will change.

### What it costs

9.5 s over 21.6 M cells at 2 ft, 2.2 s at 4 ft, in a worker with progress and
cancellation. The field build runs it at **4 ft** and the card says so; its outlet
areas are within **1.33 %** of the 2-ft map's. A machine that cannot allocate the
2-ft arrays retries at 4 ft and toasts that it did. Nothing here is a drawn
feature: it does not serialise into a session, it is not undoable, and it is not
in the feature tree — it is a read-only analysis of the ground, like the storm
network it depends on.

## Design storm — how much water, and where it ends up

> **The 25-year 24-hour storm over the whole site: 6.4 in of rain, a composite
> curve number of 82, and 357 acre-feet of runoff.** 146 ac-ft of it reaches
> Clear Lake overland, 106 ac-ft goes through the storm network to the outfall
> and 104 ac-ft leaves the surveyed ground at its edge. **None of the three
> ponds overtops** — the Herman Impoundment rises 0.8 ft and never reaches its
> surveyed 1,341.55-ft discharge pipes; Frog Pond leaves through its culvert
> 0.29 ft below its rim; Green Pond is contained 1.4 ft below its outlet.
>
> **The rainfall depths are provisional until the NOAA Atlas 14 export is
> baked in, and the card says so in red.** Everything below moves with them.

Type `RAIN` (or `RUNOFF`, `DESIGNSTORM`) and the **Design storm** dialog opens:
pick the storm (2-, 10-, 25- or 100-year 24-hour, the 25-year 1-hour for the
pipes, or a custom depth and duration), the temporal distribution, the
hydrologic soil-group rule and the TR-55 segment lengths, then run it. This is
Phase 2 of the catchment work: **Phase 1 said where the water goes, this says
how much**, over Phase 1's own catchments — so the drainage map and the design
storm can never disagree about which ground drains where.

### Every number carries the assumption it rests on

The card prints them, the report sheet leads with them, and the dialog changes
them. Nothing here is hidden in the code:

| what | the assumption | why |
|---|---|---|
| Rainfall | NOAA Atlas 14 vol. 6 at 39.003 N, 122.663 W — **provisional depths until `data/atlas14_sbmm.csv` is baked** | the app has no network by design; the depths must be citable |
| Distribution | NRCS **Type IA** (the Pacific-coast type that covers Lake County); Type I and a uniform intensity are offered beside it | TR-55 |
| Runoff | NRCS curve number, `Q = (P − 0.2S)² / (P + 0.8S)`, `S = 1000/CN − 10`, AMC II | the method every drainage report in this county uses |
| Soil group | **D** for mine waste, tailings, waste piles, decision units and compacted fill; **C** for everything else | no SSURGO and no infiltration test on hand — the biggest assumption in the chain |
| Cover | a 2-ft class raster from EA's water, building and road layers, the decision units and waste piles, the canopy model and the orthophoto | the data we have |
| Time of concentration | TR-55 ch. 3 along Phase 1's longest flow path: sheet flow ≤ 100 ft, shallow concentrated, channel above 5 acres | TR-55 |
| Peak flow | **both**: Rational `Q = C·i·A` up to 200 ac, and an SCS unit hydrograph (peak rate factor 484) everywhere | two methods, not two attempts at one number |
| Pond routing | level-pool (Modified Puls) on the overtopping analysis's own stage–storage, a broad-crested weir over the rim; a conduit with no surveyed size or invert **passes its inflow** and says "capacity unknown — survey pending" | half of it is real now, half waits on the invert survey |
| Clear Lake | free outfall | a ruling |

### What it reports

Per catchment: the area by cover class, the composite curve number, the runoff
depth and volume, the time of concentration with its TR-55 segments, the
Rational peak (where the catchment is small enough for it) and the SCS peak
with its hydrograph. Per pond: the peak stage, the freeboard, the time to peak,
and whether it overtops its rim or leaves through a conduit first. `copy CSV`
takes the lot; **report** opens the printable sheet with the assumptions table
first, before a single quantity.

Two layer rows sit under **Design storm (rainfall + runoff)** in Site
framework: **Land cover** — the class raster with a legend that names each
class's curve number — and **Runoff depth**, the catchments shaded by the
runoff of the chosen storm. Draw an area, give it a cover class from the
dialog, and the storm counts it that way; the override is an ordinary drawn
feature, so it saves in the session with everything else.

### The recorded answers

25-year, 24-hour, 6.4 in, Type IA, over the 978.5 surveyed acres:

| catchment | acres | CN | Q | volume | Tc | Rational | SCS peak |
|---|---|---|---|---|---|---|---|
| Clear Lake — direct overland | 403.05 | 82.0 | 4.36 in | 146.49 ac-ft | 21.2 min | over 200 ac | 565 cfs |
| Off the surveyed ground | 293.45 | 81.0 | 4.25 in | 103.87 ac-ft | 6.0 min | over 200 ac | 429 cfs |
| Clear Lake outfall (storm network) | 281.99 | 83.6 | 4.53 in | 106.34 ac-ft | 17.1 min | over 200 ac | 425 cfs |
| **site** | **978.49** | **82.2** | — | **356.69 ac-ft** | — | — | **1,396 cfs** |

| pond | today | peak stage | outcome |
|---|---|---|---|
| Herman Impoundment | 1,336.45 ft (surveyed) | 1,337.27 ft | contained — 4.3 ft below the surveyed 1,341.55-ft discharge invert |
| Frog Pond (east) | 1,415.00 ft | 1,415.75 ft | leaves through the pond culvert at 1,415.74, 0.29 ft under its 1,416.04-ft rim |
| Green Pond (west) | 1,391.60 ft | 1,393.11 ft | contained — 1.4 ft below its outlet at 1,394.50 |

The cover raster behind those curve numbers, over the same 978.5 acres: grass
and weeds 660.9 ac, bare or disturbed 167.5, woods and brush 57.0, gravel road
37.8, open water 26.2, paved 11.9, mine waste 11.1, roofs 6.2.

**Nothing here is a rain-on-grid simulation.** There is no infiltration model
beyond the curve number, no seepage, no evaporation, no pipe capacity and no
continuous simulation — and the card says so in those words.

### Replacing the provisional rainfall (five minutes, no code)

Open the NOAA PFDS at `lat=39.0030&lon=-122.6630`, take the PDS-based
precipitation-frequency estimates in English units, save the CSV as
`data/atlas14_sbmm.csv`, and run `python tools/build_rainfall.py`. The red
warning disappears by itself, every number above moves with the new depths, and
the recorded values in `test/kernels.mjs` §12.5 need re-recording.

## Canopy v2 and the tree inventory

### The cleaned canopy model

The CHM is a per-cell maximum-return DSM minus ground, and raw it carries two
artefacts that every downstream consumer has to fight. `tools/build_chm_png.py` now
cleans it (pass `--raw` to reproduce the v1 raster exactly):

1. **despeckle** — a cell above zero whose eight neighbours are all zero is a bird, a
   powerline or a stray return. 4,305 cells, 0.06 % of positive cells.
2. **pit-free close** — grey-scale closing with a 3-ft disc, filling the cells where
   the laser found a gap through the foliage and reported near-ground height in the
   middle of a crown. This is what stops local-maximum tree detection finding two
   apexes on one tree.
3. **masked blur** — a 1.5-ft Gaussian applied *only* where height > 2 ft, with the
   weights themselves masked to that region. A plain blur would drag canopy height out
   over the clearing edge and inflate every stand polygon.

Morphology and blur are numpy-only, no scipy, so the tool runs anywhere numpy and
Pillow do.

| | coverage | p50 | p95 | max | > 2 ft | > 6 ft |
|---|---|---|---|---|---|---|
| raw (v1) | 70.17 % | 0.61 ft | 37.99 ft | 147.04 ft | 42.83 % | 33.52 % |
| cleaned (v2) | 70.17 % | 1.83 ft | 38.80 ft | 87.88 ft | 49.32 % | 37.41 % |

Coverage is unchanged, p95 moves 0.8 ft, and canopy over 6 ft grows 3.9 points — modest,
and concentrated where closing filled gaps inside crowns. The headline number is the
**maximum: 147 → 88 ft**. Only 11 cells in 7.8 million exceeded 100 ft in the raw grid;
those are noise, and an 88-ft conifer is a tree. The cleaned raster also compresses
better — `data/chm.png` fell from 7.72 MB to 5.38 MB.

### Individual tree detection

`TREES`, or the **Trees (detected)** row in the Layers tab. Two standard steps:

1. **Variable-window local maxima**, radius = max(4 ft, 0.35 × height) — the usual
   allometric rule, so a 10-ft sapling may stand 4 ft from its neighbour while an 80-ft
   conifer owns 28 ft.
2. **Marker-based region grow** — a simplified watershed. Cells are visited in
   descending height and each takes the label of its only labelled neighbour; a cell
   with two different labelled neighbours is a saddle and stays unassigned, and a cell
   below 0.3 × its apex height has fallen out of the crown. That is what keeps two
   touching crowns from merging into one enormous tree.

**4,179 trees** over the full mine-area window: median height 19 ft, tallest 83.6 ft,
median crown 401 ft² (radius 11.3 ft). Detection takes about 10 s.

It took 88 s first. The obvious implementation of an allometric window — quantise the
radius into bins and run one full-grid max filter per bin — is 28 passes over 11.1
million cells, and the vertical pass strides the array by its row width so it misses
cache on nearly every read. The shipped version runs **one** max filter at the smallest
radius the rule can ever ask for (4 ft): anything that is not a local maximum within 4
ft cannot be one within a larger window either, so that rejects almost everything for
two passes, and the survivors get an exact direct scan at their own radius that
early-exits on the first taller neighbour. Work is proportional to candidates rather
than cells, there is no radius quantisation left, and the output is **identical** —
same 4,179 trees, same statistics. 8.4× faster and more correct.

Rendering is built for far more than the site actually has. Trees are drawn on one
canvas — no DOM per tree, because 40,000 `<div>`s would make the tab unusable — and
pre-bucketed by height into the colour ramp's steps once at detection time, so painting
sets `fillStyle` ten times and issues `fillRect` per tree rather than changing state
per point. Repaints are rAF-throttled. Click near an apex for height, crown area, crown
radius, State Plane and lat/long; export the whole inventory as CSV.

Individual-tree detection from a 1-ft CHM is reliable for dominant, well-separated
crowns and merges or misses suppressed understorey. Read the count as a canopy
inventory, not a stem count.

### 3D canopy

The 3D canopy surface is built from the cleaned raster and coloured **by height** with
the canopy ramp (vertex colours — one attribute, no extra draw call) instead of flat
green. A single green tells you where vegetation is; the ramp tells you whether it is
8-ft brush or an 80-ft stand, which is the difference between a weed-trimmer and a crew
with a chipper. Opacity stays toggleable.

## AI segmentation — attempted, not shipped

Phase 4 included an experimental click-to-segment tool (`SEG`): click a feature in the
orthophoto and have a Segment-Anything-class model outline it. **It is not in this
build.** What was established is worth recording so nobody repeats it.

**What worked.** onnxruntime-web runs fully offline with the runtime vendored — no CDN
at runtime. Both MobileSAM ONNX exports tried loaded and ran over http: the encoder in
~2 s, a 1024-px tile encoding in ~4.5 s, and each subsequent click decoding in ~0.2 s
against the cached embedding, which is genuinely interactive.

**The `file://` problem, and its solution.** A page opened from disk gets the opaque
origin `null`, and Chrome refuses `fetch()`, `XMLHttpRequest` *and* ES-module imports of
sibling files — the same restriction that made the original version of this app hang on
"Loading terrain…". Three things *are* still permitted, and all three were verified
working from `file://` in this repo: `<script src>` tags, dynamic `import()` of a **Blob
URL**, and `WebAssembly.instantiate()` from **bytes**. Since onnxruntime exposes
`env.wasm.wasmPaths = { mjs }` and `env.wasm.wasmBinary`, and accepts a `Uint8Array`
model, the whole runtime can be fed from base64 `<script>` payloads with nothing
fetched. So `file://` was solvable, and not the reason this was dropped.

**What did not work: the models.** Two independent community MobileSAM ONNX re-exports
both produced degenerate masks on real imagery. The first saturated to a 100 % mask on
any input and reported IoU **> 1**, which is impossible — a broken export; feeding it
raw and normalised imagery produced near-identical embeddings, meaning it was
substantially ignoring its input. The second responded properly to prompts (IoU
0.70–0.91, varying sensibly with the click) but returned near-empty masks. Each
anonymous re-export bakes in its own preprocessing convention — NCHW vs HWC, raw 0-255
vs SAM's mean/std normalisation, its own coordinate scaling — with no authoritative
reference for which, and recovering that by search is open-ended.

That is where the budgeted effort ran out, so the tool, its 46 MB of vendored weights
and its command were removed rather than shipped half-working. A tool that draws
confident wrong outlines on a contaminated-site investigation is worse than no tool.
Anyone picking this up should start from an export they can verify against a reference
implementation, not from a model zoo search — and can reuse the `file://` findings above,
which are the genuinely reusable part.

`WAND` and `CBOUND` cover most of what `SEG` was for, work from the terrain rather than
from imagery, and are defensible in a way an image model is not.

## Design — EA residential cleanup

Two sources, and the newer one wins.

### Native geometry (v8) — the authority

In June 2026 EA delivered their **own GIS and CAD**, so the design no longer has to be
recovered from plots. `data/design_gis.json` (0.49 MB, **802 features in 14 layers**) is
built by `tools/build_design_gis.py` from:

* **`SBMM_ResidentialRD.gdb`** — an Esri file geodatabase (ArcGIS Pro 3.6.2) holding the
  design polygons: 14 limits of excavation, the EIC repository, both stockpiles, the
  staging / borrow / gravel areas and construction entrance, the two haul routes, the 32
  Elem Colony lots, the operable units, parcels and water.
* **`C-BASE.dwg` / `V-Base.dwg`** — the civil and existing-conditions CAD bases, converted
  DWG → DXF with **libredwg git master** (release 0.13.3 cannot read these Civil 3D files).
  These add the daylight lines, the grading breaklines, and the surveyed existing
  conditions: buildings, roads, fences, poles, wells and monuments.

Every feature carries its provenance string, and the layers appear in the Layers tab under
three sub-headings — *Design areas*, *Boundaries*, *Existing conditions*. The design areas
are on by default; the reference furniture is not.

**Coordinates.** The geodatabase is delivered as **EPSG:2226** (NAD83 / California zone 2,
US survey feet); the app works in **EPSG:6418** (NAD83(2011), same zone and units). Those
are different realisations of NAD83, so rather than assume they coincide, every native
excavation limit was compared against the *independently* registered PDF boundary for the
same area. They agree to **0.3–1.8 ft**, inside the registration's own residuals, so **no
reprojection is applied**.

**This validated the PDF registrations.** The two lines of evidence are unconnected — one
came from the sheets' printed node tables, the other from EA's database — so their
agreement is a real check. Per sheet, the best-matching boundary sits this far from native
design linework:

| sheet | C-103 | C-104 | C-105 | C-106 | C-107 | C-108 | C-109 | C-110 | C-111 | C-112 | C-201 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ft | 0.14 | 0.46 | 0.68 | 0.48 | 0.50 | 0.50 | 0.00 | 0.00 | 0.20 | 0.34 | see below |

No sheet needed re-fitting. C-201 looks like a 54 ft outlier on a centroid comparison and
is not one: its PDF-extracted polygon is a *larger enclosing* feature than the native
"East Temporary Stockpile" footprint (the native polygon lies 100% inside it), and that
polygon sits on **its own printed survey nodes to 0.37 ft**. Different feature, correct
registration.

**The four unregisterable sheets are now covered.** C-102 (staging area), C-202 (North
Lobe) and C-203 (borrow area) all have exact native geometry; C-101 is a site *index* sheet
and has no unique geometry to carry. The geometry was the point — and for C-202 the native
geometry then went on to place the raster too (see *Registering from native geometry* below).

**Excluded on purpose.** The geodatabase also contains `T22_0762_IsolateCurrent` and
`T22_0762_ResourceCurrentPly` — an archaeological survey of the Elem Indian Colony.
Archaeological site locations are confidential under NHPA §304 and ARPA §9, and this app is
a file that gets emailed around, so they are **not** baked in. The e2e test fails if they
ever appear. If they are ever needed it should be a separate, access-controlled deliverable
and a deliberate decision.

**No design surface, deliberately.** The proposed grade lives in Civil 3D
`AECC_TIN_SURFACE` objects plus two 89.5 MB external `.mms` stores — ZIP wrappers around a
proprietary `MMS01` binary (273 MB uncompressed). No open tool decodes them; libredwg drops
them silently, which is why a 104 MB `C-BASE.dwg` yields 425 entities. Rather than
reverse-engineer an undocumented format or fake a TIN from breaklines, the recoverable 3D
design linework ships as-is — daylight lines and grading breaklines, the latter carrying
real elevations (1404–1440 ft), shown in their popups. **If cut/fill against the EA design
grade is wanted, the right move is to ask EA for a LandXML surface export or a
proposed-grade raster**, which Civil 3D produces in one step.

### Sheet overlays and the PDF extraction

The design drawings are also integrated as georeferenced sheet overlays plus extracted
vector boundaries. **Eleven sheets** are registered. This is still how the sheet rasters and
the floating sheet viewer are placed, and it remains the method to use for a future sheet
set that arrives without native files — but its **boundary layer now defaults off**, and
each boundary the native geometry supersedes is labelled as such in its popup, with the
distance between the two shown.

**Source** — EA Engineering, Science, and Technology, *Appendix A. Engineering Drawings*,
Final Residential Design, **100% Plans for Construction, September 2025**, project 1578546
(19 sheets). Horizontal datum as printed on the sheets: NAD83 California State Plane II,
US survey foot; vertical NAVD 88.

**One sheet comes from a different set.** C-110 (Lot 31) does not exist in the Final
package — its numbering jumps C-109 → C-111 — so it is taken from the **90% Pre-Final
Design set (May 2025)**. That is a *superseded* design. It is flagged `design_set: "90%"`
on the sheet record and on every one of its features, badged in the Layers row, and must
never be read as part of the package being built. Corroborating detail: the Final set's
printed node numbering keeps C-110's gap (C-109 ends at node 46, C-110 uses 49–53, C-111
starts at 54), which is independent evidence the sheet was dropped rather than renumbered.

### Sheet inventory

| sheet | subject | page | registered |
|---|---|---|---|
| G-001 / G-002 | title, notes, legend | 1–2 | no — not plans |
| C-101 | site index (1 in = 200 ft) | 3 | **no** — see below |
| C-102 | staging area | 4 | **no** — no printed control at all |
| C-103 | Lot 13 | 5 | **yes** (added in this phase) |
| C-104 | Lot 15 | 6 | **yes** |
| C-105 | Lot 19 | 7 | **yes** |
| C-106 | Lot 25 | 8 | **yes** |
| C-107 | Southern Residence | 9 | **yes** (added in this phase) |
| C-108 | SW Lot | 10 | **yes** |
| C-109 | NW Lot | 11 | **yes** |
| C-110 | Lot 31 | — | **yes**, *from the 90% set* — absent from Final |
| C-111 | Lots 1, 5, 7 + EIC Repository | 12 | **yes** |
| C-112 | Lot 17 | 13 | **yes** |
| C-201 | East Temporary Stockpile | 14 | **yes** |
| C-202 | North Lobe grading | 15 | **yes** — from EA's native polygon, both plan viewports (v9.1) |
| C-203 | Borrow Source Demonstration Area | 16 | **no** — see below |
| C-501/502/503 | typical details and sections | 17–19 | no — not plan views |

Sheet subjects are read from the drawings' own title blocks (the 90% set titles every lot
sheet explicitly), not guessed. **"Registered" means placed on the map — every sheet in the
table, registered or not, is readable in full in the sheet viewer.**

### Registration

These drawings do **not** carry a GeoPDF viewport — the `/VP` present on every page is a
rectilinear *scale* measure (`/Subtype /RL`), not a `/GEO` one — and the sheets are **not
plan-north-up**: they are drafted on a rotated grid. That rotation is why a north-up
assumption fails on this set, and it is the single thing worth remembering about it.

Uniform scale always comes exactly from the sheet's own `/VP` measure. Two different
methods were used to recover rotation and translation, and **a sheet is kept only where two
independent lines of evidence agree**.

**Method 1 — ortho NCC + printed-node refine** (the eight v6 sheets). Rotation and
translation from normalised cross-correlation of the sheet's embedded aerial against the
app's orthophoto, then least squares on the survey coordinates the sheet prints in its lot
table. Kept when the free-affine rotation matches the NCC rotation to under 0.1° and the
recovered scale matches the declared `/VP` scale to better than 0.3%.

**Method 2 — node vote-fit + independent ortho confirmation** (C-103, C-107, C-110). This
is what recovered the sheets v6 could not place:

1. *Vote-fit.* Sweep rotation; at each rotation every (printed node, drawn vertex) pairing
   implies one translation, and the correct rotation is where all k nodes vote for the same
   offset. **Scale is locked to `/VP`**, which is the point: k nodes then give 2k equations
   against 3 unknowns, so a coincidental fit must satisfy 2k−3 redundant constraints. A
   *free* affine through 4 points has 6 parameters for 8 equations and fits almost anything —
   which is precisely how v6's confident-nonsense answers arose.
2. *Ortho confirmation.* The candidate is rendered into State Plane and correlated against
   the app orthophoto, which knows nothing of the printed table. What is scored is not the
   absolute correlation but **how far the imagery moves the sheet** from where the nodes put
   it.
3. Accepted only when the candidates passing both form a **single cluster** and no rival
   cluster does as well.

Calibrated on the eight sheets whose answer was already known: correct transforms score
agreement 0–2 ft, wrong ones 60–130 ft. Re-running the pipeline on C-104 reproduced v6's
independent affine to **1.37 ft**.

| sheet | plan scale | rotation | nodes | resid med / max (ft) | ortho agree (ft) | ortho peak / ratio |
|---|---|---|---|---|---|---|
| C-103 | 1 in = 10 ft | −28.00° | 4/4 | 0.00 / 0.01 | 1.3 | 0.159 / 2.37 |
| C-104 | 1 in = 10 ft | −44.92° | 4/4 | 0.05 / 0.10 | — | — |
| C-105 | 1 in = 10 ft | −0.09° | 5/5 | 0.13 / 0.18 | — | — |
| C-106 | 1 in = 10 ft | −0.06° | 3/3 | 0.00 / 0.00 | — | — |
| C-107 | 1 in = 10 ft | −90.00° | 4/4 | 0.01 / 0.01 | 1.6 | 0.364 / 3.84 |
| C-108 | 1 in = 20 ft | −22.51° | 7/7 | 0.16 / 0.25 | — | — |
| C-109 | 1 in = 20 ft | +22.51° | 12/12 | 0.05 / 0.11 | — | — |
| C-110 *(90%)* | 1 in = 10 ft | +22.50° | 5/5 | 0.01 / 0.01 | 0.9 | 0.343 / 4.51 |
| C-111 | 1 in = 20 ft | −22.47° | 11/11 | 0.21 / 0.76 | — | — |
| C-112 | 1 in = 10 ft | −45.01° | 9/9 | 0.06 / 0.15 | — | — |
| C-201 | 1 in = 30 ft | −30.02° | 8/8 | 0.66 / 1.19 | — | — |

The three new sheets each land on a clean drafting angle (−28.000°, −90.001°, +22.504°),
which is corroboration in itself; +22.5° is one of the rotations already known from this set.
C-107 and C-110 additionally carry a **third** independent check — the extracted boundary
reproduces the area the sheet prints in square feet (C-107: 3,422 vs 3,297 ft²; C-110:
1,569 vs 1,600 ft²), a scale check that neither the node table nor the imagery supplied.

#### Registering from native geometry — C-202

C-202 defeated both methods above (two printed nodes, two plan viewports on one page — the
account is kept in the next section), and EA's June-2026 native deliverable is what solved
it. The geodatabase polygon *Limit of excavation — North Lobe* is the heavy black boundary
drawn in **both** of the sheet's 1 in = 20 ft plans, and its two southern vertices *are*
the two printed nodes (81 and 82, to 0.02 ft). Eleven vertices of a distinctive shape give
22 equations against four unknowns — far more redundancy than any printed node table on
this set — and each viewport is solved on its own. `tools/register_sheet_native.py`:

1. **Coarse**: rotation swept through 360° at 1°, scale locked to the other 1 in = 20 ft
   sheets, translation by FFT correlation of the polygon outline against the sheet's heavy
   ink. C-202 answers at **exactly −90°** (north to the left, as its own north arrow says)
   with outline-on-ink 0.87 against 0.40 for the runner-up, and one peak per viewport.
2. **Refine, per viewport**: Nelder–Mead over rotation, scale and translation on the mean
   ink darkness along the outline (0.991 for both plans; a random placement scores 0.13).
   Then rotation is locked to the drafting angle and scale to the mean of the two free fits
   (0.171377 ft/px, −0.05 % from the other 1 in = 20 ft sheets) and only the translation is
   re-solved. Per-vertex residuals: **median 0.31 / max 1.06 ft** (grading plan),
   **0.48 / 1.03 ft** (planting plan).
3. **Independent confirmation**: the app's own orthophoto, which knows nothing about the
   sheet, rendered into each plan through the recovered transform and correlated with the
   sheet's embedded aerial. The imagery moves the grading plan **1.79 ft** and the planting
   plan **1.85 ft** (NCC 0.51 / 0.49 at the peak) — the same 0–2 ft agreement class as
   every accepted sheet, against 60–130 ft for a wrong registration.

The map raster (`design_C202.png`, 0.5 ft/px) is cut from the **grading plan** — two plans
of the same ground cannot both be draped, and the grading plan is the design. Both plans
are georeferenced in the sheet viewer: `sheets_full.json` carries one affine per viewport
with its pixel rectangle, a mark is placed through whichever plan it is made on, and a
click on the title block or the notes is refused rather than placed 290 ft off.
`tools/build_sheet_affine.py` leaves a record marked `affine_source: "native"` alone.

C-102 and C-203 are the obvious next candidates for the same method — both have exact
native polygons (the staging-area set and the 90 × 120 ft borrow rectangle). C-203's
rectangle is symmetric, so the ortho confirmation would have to break the four-fold
ambiguity rather than merely confirm; that is the one thing to watch.

#### Why three sheets are still not registered

Recorded so the work is not repeated:

* **C-102 (staging area)** — the sheet prints **no coordinate table at all**. With no ground
  control there is only one method available (imagery), and one method cannot meet the bar.
* **C-101 (site index, 1 in = 200 ft)** — ortho correlation returns **ratio 1.02**, i.e. a
  plateau with no peak, and at that placement the six printed nodes miss drawn vertices by
  2.85–280.94 ft. An index sheet is mostly sheet-boundary rectangles and text, so there is
  little that can correlate with imagery. Its plan is ~5,000 × 4,600 ft — nearly the whole
  ortho — so the search window barely fits.
* **C-202 (North Lobe grading)** — *now registered from native geometry, above; the record
  of why the PDF methods failed is kept.* Two problems. It prints only **two** nodes, so the
  table carries no redundancy: any vertex pair at the right separation yields a transform.
  And its `/VP` data shows **two separate plan viewports at 1 in = 20 ft** — they turned out
  to be two plans of the *same* ground (grading and restoration planting), but a single
  affine for the page is still wrong by construction. The ortho-first attempt
  returned peak 0.143 / ratio 1.40 (against 0.159–0.364 / 2.37–4.51 for the sheets that were
  accepted), and its "2 of 2 nodes within 1.5 ft" is worthless — at that sheet's linework
  density the chance of a node landing within 1.5 ft of *some* drawn vertex is **0.78**.
  Splitting it into its two viewports and solving each against the native polygon is what
  worked.
* **C-203 (Borrow Source Demonstration Area)** — the closest of the three to being solved,
  and the one to pick up first next time. Its printed nodes are a plain **90 × 120 ft
  axis-aligned rectangle**: so unspecific that the vote stage emits ~720,000 candidates and
  still had not converged after an hour, and a targeted search for a drawn 129.6 × 172.8 pt
  rectangle finds **none** — the rectangle is not drafted as a simple closed 4-vertex
  polyline. Ortho-first does give a strong lead: rotation **+30.000°** (a drafting angle this
  set already uses), peak 0.258 / ratio 2.44, and all four printed nodes landing within
  0.37–1.23 ft of drawn vertices (≈1.6% by chance at this sheet's linework density).
  **But the two methods do not converge**: least-squares refinement on those nodes pulls the
  sheet 5.85 ft and drops the ortho peak from 0.258 to 0.156. A ~6 ft disagreement is not the
  ~1 ft agreement required, so the sheet is excluded. The overlay looks plausible by eye, but
  it is a contour sheet over wooded ground where the eye cannot resolve a foot — which is
  exactly the situation the two-method rule exists for.

### What was extracted

`data/design_ea.json` → `datajs/d_design_ea.js`, 123 KB, **115 features**:

* **11 area-validated boundaries** — the extracted polygon's area reproduces the area the
  sheet itself prints in square feet, to 0.19–5.2%. This is the strongest available check and
  it validates registration and extraction together.
* **48 unclassified boundaries** — real drafted closed boundaries whose legend meaning could
  not be determined from the sheet text. Named "Sheet C-xxx (subject) boundary" rather than
  guessed at. Annotation callout borders, leader triangles and sliver artefacts are filtered.
* **3 surveyed node polygons + 53 surveyed nodes** — the polygon nodes printed in each sheet's
  coordinate table. These are exact State Plane values and depend on no registration. A node
  chain is drawn as a polygon only where its own area reproduces a printed area; otherwise the
  nodes are published as points, which is all that is actually known about them.

Eleven sheet rasters (`data/design/design_C*.png`, 8.4 MB) are rendered north-up in State
Plane at 0.5–1.0 ft/px with the paper background knocked out to transparency. The rotation is
baked in because `L.imageOverlay` cannot rotate. The printed coordinate table and any
detail/section viewport drawn at a scale other than the plan scale are blanked so the overlay
carries only the drawing. `tools/build_data.py` **globs** `data/design/` rather than listing
the files, so a newly registered sheet cannot be silently left out of the payload — but its
`datajs/i_design_Cxxx_png.js` must still be added to `index.html`'s script list.

Boundaries are indexed by the object-snap engine alongside the DUs, piles and contours, and
offer the same one-click perimeter-TIN volume as the DUs and piles. They are read-only
reference data — not features in `SBMM.store`, not editable.

### Sheets draped on the 3D terrain

Each registered sheet can be laid over the ground in 3D, the same way the ortho is. The
**3D** button on the sheet's Layers row builds a mesh over that sheet's footprint sampling
the DEM every 6 ft, textured with the sheet PNG and standing 2.5 ft above the surface; the
**Sheets draped in 3D** row in the Layers tree hides and shows them all at once. Meshes are built
lazily on first enable, disposed when switched off, and live in their own group so the
frequent overlay rebuild does not re-upload their textures. The per-sheet 3D toggle is
deliberately independent of the row's 2D checkbox.

Two things that had to be got right, both of them previously-recorded traps:

* **NoData.** `drapeZ` substitutes a mid-site elevation where the DEM has no data, which is
  correct for lines but ruinous for a surface: at the survey limit the drape hangs hundreds
  of feet off the ground and renders as a **vertical curtain**. Cells touching NoData are
  skipped, exactly as the terrain meshes do.
* **Transparency.** The material is unlit with `depthWrite` off, a high render order, and
  `alphaTest` so fully-clear paper never enters the blend — verified against both the terrain
  and the canopy layer, which is the hardest sorting case.

### The sheet viewer

The map overlay is a **crop** of each sheet's plan area, de-rotated into State Plane. That is
the right thing for an overlay and useless for reading the drawing: the title block, the
general notes, the legend, the section callouts and the detail bubbles all live outside the
plan viewport, and on site those are half of what you need.

So the app carries a second rendering of the same drawings — the whole 36×24 sheet exactly
as plotted, 4,200 px on the long edge (~117 dpi), JPEG, about 1 MB each — and shows it in a
floating window. **All 20 sheets are in it**, including the four plan sheets that are not
georeferenced and the general and detail sheets that are not plan views at all. Registration
is about where a drawing belongs on the ground; it has nothing to do with whether the drawing
is worth reading, and C-102's staging-area notes are wanted either way.

Four ways in, because the sheet you want is rarely reachable the same way twice:

* **click the sheet's footprint on the 2D map** when its overlay is switched on — the outline
  lights up under the cursor;
* the **⤢** button on the sheet's row in the Layers tab;
* **click the draped sheet in the 3D view**, when no drawing tool is armed;
* the **`SHEETS`** command — bare, it lists the whole set with a *placed* / *90%* marker on
  each; with an argument (`SHEETS C-106`) it opens that one.

The window animates up from wherever you asked for it (250 ms, scale + fade). Inside: wheel
zoom toward the cursor and drag to pan (both on a compositor transform, so it stays smooth at
4,200 px), **fit** / **1:1**, **‹ ›** to flip through the set in place, and **locate** to fly
the 2D map to that sheet's footprint and pulse it — disabled, with a reason in its tooltip, on
the sheets that have no footprint. Drag the title bar to move, the corner to resize. Several
windows can be open at once (cascaded, click to bring forward); `Esc` closes the top one with
the reverse animation. Keyboard: arrows pan, `+`/`−` zoom, `0` fits, `PgUp`/`PgDn` change sheet.

Regenerate the renders with `python tools/build_sheet_fulls.py` (needs the source PDFs), then
`build_data.py`. Sheet numbers and drawing titles are read from each sheet's own title block,
not typed in.

### Datasets — feeding anything into the twin

A **dataset** is a named list of points with arbitrary attributes. Once registered it behaves
like every other layer: a styled symbol layer, attribute popups, its own tab in the table
drawer, CSV re-export, inclusion in the GeoJSON and DXF exports and in the object snaps, and a
3D rendering. Nothing downstream is special-cased per dataset, so a new table is a data
problem rather than a code problem — that is the whole point of the module.

**Two ways in.**

*Imported* — the **add dataset…** button in the Site-wide section, the **`DATASET`** command,
or dropping a `.csv` on the map. A mapping dialog opens: the easting/northing (or
longitude/latitude) columns and an ID column are pre-selected from the header names and, when
those are unhelpful, from the magnitude of the values; State Plane ftUS versus WGS84 is decided
the same way GeoJSON import decides it, and can be forced. The dialog shows how many rows it
read, how many landed inside the site window, and the first point's coordinates *before*
anything reaches the map — a wrong column is visible rather than silently plotted in the wrong
county. Everything not used for coordinates or the ID becomes an attribute; numeric-looking
values are stored as numbers so the table sorts and the depth stick works. `N,E` given the
wrong way round is swapped. Imported datasets are written into the session file (v6) and into
localStorage autosave.

*Baked* — `data/datasets/ds_*.json`, compiled by `tools/build_data.py` into **one**
`SBMM_DATA.datasets` payload. One payload rather than one per dataset on purpose:
`index.html`'s script list is maintained by hand, and a per-dataset payload would be exactly
the trap the design-sheet glob already exists to avoid. To add one:

```
python tools/add_dataset.py wells.csv --name "Monitoring wells" --kind wells
python tools/build_data.py && python tools/build_dist.py
```

`add_dataset.py` applies the same column detection as the in-app importer and **prints what it
chose**, so a wrong guess is caught before it ships. It also warns when points fall outside the
site window.

**Kinds.** `generic`, `wells`, `borings`. A kind only changes defaults — the symbol, the order
attributes are listed in the popup, and whether a depth attribute is offered as a 3D stick.
Nothing branches on it structurally, so a kind that turns out to be wrong is a cosmetic mistake.

**In 3D**, a dataset draws as billboard dots at the collar plus, where it has a depth attribute
and sticks are enabled, a vertical line from the ground down to that depth. The stick is drawn
without depth testing and semi-transparent: it is below ground by definition, so with depth
testing on it sits inside the terrain mesh and is invisible — a depth attribute that draws
nothing. Seen through the ground it reads the way a fence diagram or a Civil 3D borehole does,
and it scales with the relief exaggeration like everything else.

**What ships baked, and where it came from.** Both were read straight off the project share;
nothing here is inferred from a PDF.

| dataset | n | source | depth attribute |
|---|---|---|---|
| Monitoring wells | 95 | `Groundwater Sampling\SBMM Monitoring Wells.xlsx`, sheet `WellConst` — construction table: TOC and ground elevation, install date, casing diameter and stickup, total depth, screen top/bottom (depth and elevation), lithology at screen | Total depth (ft), 69 of 95 |
| Soil borings (2025 geotech) | 44 | `Geotechnical\Sulphur Bank Test Pit Soil Borings Location Coordinates20251210.xlsx`, sheet `SB` for coordinates; depth drilled joined from `2025 Jacobs Investigation\Borings Schedule and Progress.xlsx`; interpreted waste depth and its basis from `Soil Profiles\SBMM_Field Interpretted Waste Depth.xlsx` | Total depth (ft), 37 of 44 |

Five well rows were dropped for having no usable coordinates. Both tables were **checked
against the terrain rather than trusted**: the tabulated ground elevation agrees with the 2024
lidar DEM to a **median of 0.3–0.4 ft** (borings 0.2 ft, worst 1.4 ft; wells 0.4 ft, 93 of 95
within 5 ft), and the borings' printed latitude/longitude reproduces their State Plane
coordinates to about 2 ft through the site affine — two independent confirmations that the
coordinates are real and in the CRS they claim. The e2e suite re-runs the DEM check on every
build.

### The Layers tab is organised by place

The tab grew out of the ABP volume analysis and still read like it — a flat run of headings in
the order the features were built. The work is now site-wide, so it is organised the way the
job is: **Basemap**, **Terrain & analysis**, **Mine area (OU1)**, **Residential — EA design**,
**Site-wide**. Each section is collapsible (the state persists), carries a count badge, and the
three area sections carry a colour accent. Above them, **Areas** flies both the 2D map and — if
it is open — the 3D camera to the mine window, the residential design extent (computed from the
registered sheets, so it follows the drawing set), or the whole survey.

`SBMM.addLayerRow(group, …)` is unchanged and every container id is unchanged; only which
section of the DOM each container sits in moved.

## Working on it (GitHub / Claude Code)

Push this whole folder to a **private** repo:

```
cd sbmm-site-explorer
git init -b main
git add .
git commit -m "SBMM Site Explorer v9"
git remote add origin https://github.com/<you>/sbmm-site-explorer.git
git push -u origin main
```

`.gitignore` keeps `dist/` (regenerate with `python tools/build_dist.py`), `node_modules`
and any raw survey/CAD files out. No file exceeds GitHub's 100 MB limit (largest payload
is 22 MB). Then open the folder in Claude Code — it reads `CLAUDE.md` automatically; that
file, `docs/HANDOFF.md` and `docs/V9_SPEC.md` are the complete handover, and
`docs/AGENT_RULES.md` is the ten-line version for an agent starting a round.

Tests: `cd test && npm install && npx playwright install chromium`, then everything goes
through **one runner** (v18): `node test/run.mjs --quick` is the ~50-second loop to run
after every edit (preflight + the gesture unit harness + every compute kernel but
`drainage`), and `node test/run.mjs` is the whole matrix — it builds both dists itself,
runs independent steps in parallel up to the browser slots, and writes a log per step
under `test/.logs/` ending in `EXIT=<code>` plus a summary table. One Chromium at a time
is enforced by a lock rather than asked for, `SBMM_GPU=1` renders on a real GPU where
there is one, and a failing block is re-run on its own with
`node test/e2e.mjs index.html folder --only 9t` (~48 s) instead of eleven minutes.
`.github/workflows/matrix.yml` runs the same steps on GitHub's runners, five jobs in
parallel, on every pull request.

Layout (v9 modules are listed in CLAUDE.md's code map; this is the original skeleton):

```
index.html          app shell — script list, icon sprite, UI skeleton
css/app.css         all styling (dark theme, CSS variables at top)
js/                 one concern per file:
  compute.js        CONTEXT-FREE compute kernels (volume integration, analysis
                    rasters, marching-squares contours). No DOM, no globals — this
                    is the file that becomes the Web Worker
  util.js           formatting, geometry helpers, color ramps, toasts
  jobs.js           worker pool + job protocol + status-bar progress (SBMM.compute)
  dem.js            DEM decode (terrain-RGB PNG) + bilinear sampling + slope/aspect
  proj.js           State Plane <-> WGS84 local affine
  state.js          feature store, selection, groups, undo/redo stacks, readd,
                    session autosave
  shell.js          dock tabs, collapse, drag-resize, top-bar overflow
  map.js            Leaflet init, layer-control rows, status bar, context menu, go-to
  layers.js         basemaps, survey contours, DUs, piles, sample points, and the
                    place-organised Layers tab (SBMM.layersUI: sections, count
                    badges, the Areas quick-nav)
  designea.js       EA residential design overlays: sheet rasters, extracted
                    boundaries, surveyed nodes, per-sheet 3D drape, footprint click
  sheets.js         the floating sheet viewer — all 20 plots, zoom/pan/drag/resize
  datasets.js       generic point datasets (baked + imported CSV): mapping dialog,
                    styled layers, popups, export, osnap, 3D dots and depth sticks
  smartbound.js     WAND / CBOUND / TOE / STANDS
  trees.js          individual tree detection over the CHM + the canvas dot layer
  analysis.js       slope/aspect/hypso/canopy rasters + computed contours (worker-backed)
  snap.js           object snaps: grid-hash indexes + the drafting overlay canvas
  draw.js           sketching, vertex editing, ortho/polar, typed input, pick engine
  results.js        results-panel cards
  tools.js          measurement implementations (volume engine, profile chart…),
                    the modify tools, and the DIM / TEXT annotation types
  design.js         design surfaces: graded/sloped pads, daylight lines, the
                    balance solver, the Surfaces list (SBMM.design.elev)
  sections.js       cross-sections: stationing, the sections drawer, end-area
                    volumes and the grid cross-check, section CSV
  report.js         print-ready report sheets: title block, composed figure with
                    scale bar and north arrow, quantities, sections sheet
  cmdline.js        the command line: alias table, autocomplete, ask/pick prompts
  dxf.js            DXF R12 export + R12/2000 import, generated ACI palette
  features.js       Features tab (feature manager tree) + Properties tab
  io.js             GeoJSON/session/CSV import-export
  table.js          table drawer: the sample table + one tab per dataset
  viewer3d.js       Three.js terrain viewer + dual-mode navigation rig
  boot.js           startup sequence + error reporting
data/               source data (JSON + PNG/JPG) — the GIS-usable originals
datajs/             GENERATED script-tag payloads — rebuild with tools/build_data.py
vendor/             Leaflet, d3-delaunay, Three.js bundle (no CDN, works offline)
tools/build_dems_from_master.py   master_1ft.f32 -> data/dem_*.png/.json + hs_*.jpg
tools/build_data.py   data/  -> datajs/
tools/build_dist.py   everything -> dist/SBMM_Site_Explorer.html
test/run.mjs        THE RUNNER — every harness, its build and its dependencies;
                    --quick, --only, --builds, --parallel, --list; logs in test/.logs/
test/check.mjs      the 3-second preflight the runner starts with (syntax, tracked
                    symlinks, Blob-worker sources, command aliases, the script list)
test/lib/browser.mjs  one Chromium launcher: CHROME_BIN, the browser lock, SBMM_GPU=1
test/lib/lock.mjs   the browser slot — one renderer at a time, by pid, with a name
test/lib/blocks.mjs named blocks and their fixtures: --only 9t instead of 11 minutes
test/e2e.mjs        Playwright end-to-end test incl. the memo volume validation,
                    the worker path, the workbench shell, the 3D nav rig, the
                    drafting core (snap, ortho/polar, typed input, command line,
                    OFFSET, dimensions, DXF round-trip) and the earthworks suite
                    (graded pad + daylight line, cut/fill vs a design surface,
                    auto-balance convergence, the uncertainty range, sections and
                    the end-area/grid cross-check, the report sheet, session v5)
test/split3d.mjs    split-view 3D test: drawing via 3D clicks, DEM selection by location
test/perf.mjs       boot / interaction / 3D / memory numbers (prints, does not assert)
test/audit.mjs      fresh-eyes walkthrough: every tool, command, dialog and overlay,
                    with the toasts each one raises (prints, does not assert)
test/audit2.mjs     the paths audit.mjs does not reach — sheet-viewer entry points,
                    Properties edits, split mode, the report page, tooltip sweep
test/shell_shot.mjs close-up screenshots of the shell chrome, for design review
test/nav_shot.mjs   close-up screenshots of the 3D navigation chrome
test/draft.mjs      focused drafting test (snap, typed input, DIM, OFFSET, DXF)
test/ops.mjs        focused modify-tool test (MIRROR/ROTATE/MOVE/COPY/JOIN/EXPLODE,
                    ortho + polar, the OFFSET self-intersection refusal)
test/draft_shot.mjs close-up screenshots of the drafting chrome (snap glyph,
                    dimension, command line, dynamic input)
test/earth.mjs      focused earthworks test (pad, balance, range, sections, report)
test/earth_shot.mjs screenshots of the earthworks chrome + the report sheets
test/earth3d_shot.mjs screenshot of a design surface draped in the 3D view
```

After changing `data/`: `python tools/build_data.py`.
After changing anything: `python tools/build_dist.py` to refresh the single-file build.

### Performance

Measured with `node test/perf.mjs <path> <label>` in headless Chromium under software GL —
absolute numbers on a real machine are better, the proportions are the point. Boot marks are
always collected; `SBMM.perf.report()` in the console prints them, or append `?perf` to the URL.

| | single file (94 MB) | folder build |
|---|---|---|
| Time to interactive, before the phase-C work | 4 579 ms | 3 972 ms |
| **Time to interactive now** | **3 367 ms** | **2 809 ms** |

Where the remaining time goes, and what moved:

- **Terrain decode: 2 444 → 1 272 ms**, and that is the whole of the saving. The DEMs are
  terrain-RGB PNGs carried as base64 data-URLs. Decoding one through `new Image()` +
  `await img.decode()` re-parses the base64 through the browser's resource loader — 1 168 ms
  for the 4850 × 4450 site grid alone. `atob` → `Blob` → `createImageBitmap` hands the bytes
  straight to an off-thread decoder and does the same work in about 290 ms. All three grids
  (site 657 ms, mine area 307 ms, canopy 307 ms) go through it; the old path is kept as a
  fallback, because boot is the one thing that must never fail.
- **Deferring the canopy model was tried and reverted.** Decoding the CHM after the loader
  cleared saved 548 ms of boot and spent it on a ~600 ms main-thread stall landing a second
  or two later, on top of whatever the user had already started doing — it turned up as a
  phantom 1.3 s "layer toggle" in the measurements. Splitting the work into bands did not
  help: most of the block is inside `createImageBitmap` decoding an 11.1-megapixel PNG,
  which does not divide on the main thread. A spinner that names the step it is on is not
  jank; a stall two seconds into a drag is. The seams for a future worker-side decode are
  left in place.
- **Base64 parsing: 1 236 ms, and inherent.** In the single-file build the browser has to scan
  ~90 MB of string literal before any of it can run: the terrain and imagery payloads are
  809 ms of that, the twenty full-sheet plots 300 ms, the design overlays 120 ms. That is the
  price of a file you can double-click, and it is not reducible without shipping less data.
- **Memory: 462 → 435 MB** of JS heap after boot, dominated by the decoded terrain — the
  three `Float32Array` grids are 175 MB of it and are not optional. The saving is the three
  terrain base64 strings, which are set to `null` once they have been turned into grids.
  Decoded imagery (the two hillshades and two orthos that are on by default) is another
  ~84 megapixels held outside the JS heap.
- **Boot is not finished when the loader clears.** Those four basemap images finish decoding
  in the second afterwards, and the garbage from the terrain decode is collected somewhere in
  there too. Nothing the user does is blocked for long, but interaction measurements taken
  through that window are meaningless — `test/perf.mjs` waits it out, and the phantom 1.3 s
  "layer toggle" that started this whole line of enquiry was exactly that mistake.
- **Interaction.** Status-bar elevation + canopy lookup, 500 samples: ~1 ms. Object-snap
  index over 58 522 segments and 332 points: 19–28 ms to build, ~0.5 ms a query at full-site
  zoom (the tolerance is in feet, so a zoomed-out query searches the widest radius it ever
  will). Toggling either survey contour layer — 290 and 243 polylines, 38 414 and 13 102
  vertices — 22–41 ms. Rendering the 95-well table: 16–22 ms. Opening a sheet in the viewer:
  11–27 ms.
- **3D.** Render-on-demand holds — an idle view issues **zero** renders. Ten build/dispose
  cycles of the canopy surface, the draped contours and the sheet drapes return the renderer's
  geometry count exactly to where it started; sheet textures are deliberately cached (11
  registered sheets, ~20 MB) so re-showing a drape does not re-upload.

**GitHub Pages:** Settings → Pages → deploy from branch, root. Keep the repo **private**
— it contains site imagery, terrain, and analytical results.

## The compute core (v21)

The heavy analyses — the drainage map, the overtopping flood, the raindrop, volumes,
contours — now run in a small compiled **WebAssembly** core when the browser has one.
The JavaScript kernels stay in the app as the reference and the fallback: they are what
every golden number was measured on, they are what runs if the module will not load, and
every results card says which of the two computed it and in how many milliseconds.
Help has a **Force JavaScript kernels** switch if you ever want to see for yourself.

Nothing is fetched. The module is ~100 kB of WebAssembly shipped as base64 in
`datajs/w_kernels.js`, exactly like the terrain and the imagery, so it works over
`file://`, in the folder build, in the full dist and in the field build alike. Rust is a
build dependency of that one payload; the app never needs it.

**Identity is the acceptance, and it is bit-identity, not a tolerance.** Every ported
kernel is run twice on the same job — once with the core forced off — and the two results
are compared field by field, typed arrays included, with NoData counted equal to NoData.
`node test/kernels.mjs` runs every section on **both** cores by default.

Before and after, node on the build box, measured as an A/B inside one run (the machine
was shared with two browser test matrices at the time, so read these as the shape of the
answer rather than as bench figures):

| kernel | job | JavaScript | WebAssembly | |
|---|---|---|---|---|
| `contours` | 400 × 400 analytic cone, 5 ft | 292 ms | **12 ms** | 24× |
| `contours` | 1,001 × 1,001 site window, 10 ft | 199 ms | **12 ms** | 17× |
| `volume` | Pile 1, perimeter TIN | 10 ms | **2 ms** | 5× |
| `overtop` | Herman + 19 conduits | 4,382 ms | **2,127 ms** | 2.1× |
| `fillDem` | Herman window, 1,757 × 1,208 | 1,357 ms | **634 ms** | 2.1× |
| `flowpath` | the §6.8 drop, chained, storm on | 4,431 ms | **2,345 ms** | 1.9× |
| `drainage` | the whole site, 4 ft (2,425 × 2,225) | 1,265 ms | **713 ms** | 1.8× |
| `drainage` | the whole site, 2 ft (4,850 × 4,450) | 5,490 ms | **3,749 ms** | 1.5× |
| 100 raindrops | the drainage identity, chained | 83.5 s | **58.7 s** | 1.4× |

The contour figures are the honest headline: the JavaScript chains marching-squares
segments through a `Map` keyed by a formatted string, and replacing that is exactly what
a compiled core is for. The water and drainage kernels are a different shape — priority
floods over millions of cells, bound by memory bandwidth rather than by arithmetic — and
halving them is what that shape gives. **The v21 spec asked for 2 s on the 2-ft drainage
map and it is not there**: at 21.6 million cells the kernel touches half a dozen
86-MB arrays several times each, and compiling the loops does not make the memory faster.

Two related notes, both measured. The FIRST 2-ft drainage run in a fresh worker is
~5.7 s rather than 3.7 s, because it pays for growing WebAssembly's linear memory to
about 600 MB; every run after it in the same worker is the faster number, and the app
re-runs this job whenever a storm switch moves. And an early version of the port was
*slower* than the JavaScript — it shadowed the storm-inlet capture distances in a
full-grid array where the JavaScript uses a sparse map, which cost 190 MB of allocation
and zeroing per run. A compiled core is not automatically faster; the memory it asks for
is part of the kernel.

## Data

| File | Contents |
|---|---|
| `data/dem_site.png/.json` | Site-wide 2-ft grid, 4850 × 4450, origin (6368100, 2122800) — 2 × 2 block mean of the lidar-derived 1-ft LandXML surface (42.6M points), terrain-RGB encoded (0.02 ft steps) |
| `data/dem_abp.png/.json` | 1-ft mine-area window, 2872 × 3882, origin (6370069, 2127238) — the surveyor's point-cloud tile footprint, terrain-RGB encoded (key kept as `dem_abp`) |
| `data/dem_res.png/.json` | 1-ft residential-lots window, 1550 × 4320, origin (6369890, 2126050) — the residential design bbox + a 60-ft working buffer; overlaps `dem_abp`, which wins the overlap. Added in v9 so every residential elevation, slope, section and excavation volume reads off 1-ft ground instead of the 2-ft site grid |
| `data/chm.png/.json` | 1-ft canopy-height model on the same grid as `dem_abp` — max first return minus bare earth, terrain-RGB encoded (0.05 ft steps, zmin 0); optional payload, the app boots without it |
| `data/hs_site.jpg` | Hillshade of the 2-ft site grid (az 315°, alt 45°, nodata → grey) |
| `data/hs_abp.jpg` | Hillshade of the 1-ft mine-area window, same styling (JPEG — replaced the older PNG) |
| `data/contours_*.json` | Survey contours — 10 ft site-wide, 2 ft ABP |
| `data/ortho_abp.jpg/.json` | Jan 2024 orthophoto, 3-in ABP crop |
| `data/ortho_mine.jpg/.json` | **6-in mine-area orthophoto**, 5744 × 7764, window E 6370069–6372941 / N 2127238–2131120 — see below |
| `data/ortho_site.jpg/.json` | Jan 2024 orthophoto, 1.5-ft site-wide |
| `data/dus.json` | Decision units rev7 (memo v6) |
| `data/piles.json` | Waste pile footprints — topographic + Figure-2 traced, with memo volumes |
| `data/points.json` | 140 sampled locations, validated Hg/As + exceedance flag |
| `data/affine.json` | Local State-Plane→WGS84 affine (±1 ft over the site) |

**The 6-inch mine-area orthophoto** is cut from the survey's full-resolution 3-inch GeoTIFF
tiles, `LiDAR and Aerial Survey Data\SBM - Aerial Imagery\2024-01-30 Sulphur Bank Mine 3in
Ortho_{A1,A2,B1,B2}.tif` (0.25 ft/px, LZW, RGBA, ~275–470 MB each). The mine-area window
falls entirely inside tile **A1** — its 19434 × 17814 px extent starts at
E 6368083.9277 / N 2131691.9237 — so no mosaicking was needed and only that one tile was read.
The window is box-averaged 0.25 ft → **0.5 ft/px** in a single geo-exact resample, giving
5744 × 7764 px at JPEG q82 (~8 MB). Roughly **74 % of the window has real 3-inch coverage**;
the remainder is outside the flight's collection footprint (mostly Clear Lake, west of the
shoreline) and is backfilled from the 1.5-ft site ortho, which carries the same no-data there.
Rebuild it with `tools/build_ortho_mine.py` (run against the tiles on the survey drive).

In the layer panel and on the 3D drape the three orthophotos are stacked finest-on-top —
site 1.5 ft → mine area 6 in → ABP 3 in — using explicit z-indexes rather than insertion order.

Coordinates: NAD83(2011) California State Plane Zone 2, US survey feet (EPSG:6418).
Elevations in feet, survey datum. DEMs are block-averaged from the surveyor's 1-ft gridded
LandXML surface (14 tiles, 42.6M points, 30 January 2024 flight); the contour layers still
come from the CAD topo (V-TOPO-MAJR/MINR/USER of *Sulphur Bank Mine Topo 1-30-2024.dwg*).

### The phase-C audit

The whole app was walked end to end — every tool, every command, every dialog and overlay —
by two scripted passes (`test/audit.mjs`, `test/audit2.mjs`) that record what each path does
*and what it says*. Silent refusals are the failure mode this app can least afford, so the
audit captures every toast and prints the ones that never came. What it found and what
changed:

- **A lit tool button could sit over a dead sketch engine.** Arming a measure tool opens an
  empty sketch straight away, so the first Esc cancelled *that* — leaving the button lit and
  the cursor a crosshair while clicks on the map did nothing at all, with no way out but
  re-picking the tool. Esc now scraps the shape and re-arms when the sketch had vertices, and
  leaves the tool when it was empty; a lit button always accepts a click.
- **Arming a tool said nothing.** The running readout only appeared after the first vertex —
  the one moment a new user needs the instruction was the one moment there wasn't one. Each
  tool now puts its own line on the map the instant it is armed.
- **`SHEET` opened the report, not the drawing set.** `REPORT` carried it as an alias and won
  the first-match lookup, silently killing `SHEETS`' own. Aliases are now asserted unique.
- **Toasts could be invisible.** The toast sat below the floating sheet windows and the
  modals, so a failure raised while one was open was reported to nobody. The overlay stack is
  now a documented band (windows 4000–4899, the sheet picker 5200, modals 5600, toasts 7000),
  and the windows re-stack inside their band instead of climbing without limit.
- **Esc did different things in different places.** The help modal, the command-line help and
  the report preview ignored it; the sheet viewer took it even while you were typing in a
  field. Every overlay closes on Esc now, front-most first, and none of them steal it from a
  text field.
- **A focused sheet window leaked the single-letter shortcuts** — pressing `3` while reading a
  drawing opened the 3D view behind it.
- **Repeated IDs lost points.** Dataset markers were keyed by ID, and real coordinate tables
  repeat them; the second point's marker replaced the first, so its table row pointed at the
  wrong dot. Repeats are now kept, addressed individually, and disclosed in the import preview
  before anything lands on the map.
- **The import dialog now reports what it dropped** — rows with unusable coordinates are
  counted in the preview *and* in the toast, so a partial import is never quiet. A CSV with no
  usable coordinates is refused outright rather than half-imported.
- **Two CSS rules were dead.** With `preferCanvas` a Leaflet vector has no DOM element, so the
  "locate" pulse never animated and the sheet footprint never showed its `zoom-in` cursor.
- `HELP` twice stacked two overlays; popups could be positioned off the top of a short window;
  a sheet window could cascade its resize grip off the bottom of the screen.

## Caveats

- Volumes are **neat in-place topographic quantities** — no bulking, no allowance for
  material below surrounding grade. Planning-level; report to two significant figures.
- The DEM is only as good as the survey: bare-earth from the January 2024 flight, with the
  usual lidar limits under dense canopy. The 2-ft site grid resolves features down to ~4 ft;
  the 1-ft mine-area window resolves ~2 ft.
- The Figure-2 pile outlines carry 10–30 ft of tracing uncertainty; the green topographic
  footprints are the measured ones.
- The tonnage line is a convenience calc (volume × the density you enter) — pick the
  density for the material at hand.

*Jacobs · SBMM OU1 · Task 2.1.5 · rebuilt August 2026*
