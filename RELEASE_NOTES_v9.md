# SBMM Site Explorer — v9

Release notes, 2 September 2026. Author: Mohammad Sharif (Jacobs, Task 2.1.5).

Two files ship together and are built from the same source:

- **`SBMM_Site_Explorer.html`** — the single-file build (~132 MB). Double-click it.
  Everything is inside it: terrain, imagery, the drawings, the data. No server, no
  install, no network.
- **`sbmm-site-explorer/`** — the same app as a folder (`index.html` + `js/` +
  `datajs/` + `vendor/`). Use this one if you want to read or change the code, or
  to host it internally.

Both are offline-only by design. Nothing in this app calls out to the internet.

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
On the 11 registered sheets you can now **measure and mark directly on the paper**
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
