# SBMM Site Explorer — v15: the 3D view, labels, and the overflow rule (authoritative)

Owner/decider: the planner. Executor: one agent (P). This is the contract;
the agent implements it and does not re-decide it. Hard constraints as in
CLAUDE.md (file:// only, plain scripts, context-free kernels, three builds, every
harness, golden Pile 1, browser harnesses one at a time, every refusal toasts, no
model names). Every v10–v14 golden stays.

---------------------------------------------------------------------------

## 0. What the user asked for, in his words

> when i view the overflow in 3d the labels for the rim labels are not adjusting
> to the level im looking at, i think we really need to revamp the overall
> function and usability and appearance of our model in 3d, very important that
> it looks and functions beautifully. again everything that works in 2d should
> function in 3d too.

> the frog pond issue was somewhat fixed, but it still shows overtopping and
> goes into the up north point, we have to assume that if the frog pond does
> overflow it will flow into green pond first not out and up north, and then
> green pond will handle the overflow and if that is full then it goes out to
> the culvert … out to clearlake, thats how the system was intended to be
> designed we will keep it that way for the purposes of this simulation

> when i use the overtopping of the pond feature, it puts the text inside like
> multiple times, i think you need to review why this is happening not just
> here but also as we work to clean up this site

## 1. The overflow rule (ruling, 2026-09-05): conduits first, the rim only on request

- When the overtopping analysis finds a **conduit spill below the rim spill**,
  the conduit IS the overflow: the first-discharge route is the only route
  traced and drawn by default. The rim spill stays in the card as a fact
  ("Rim spill (lidar) 1,416.04 ft · +0.30 ft above the culvert — not traced;
  the drains are assumed to handle it") and the rim band stays drawn, but
  **no rim overflow route is traced or shown** and no "overflow route" row
  claims water goes that way.
- A **"trace the rim overflow"** button on the card (and the slider's
  above-rim state) traces it on demand, labelled *what-if: culvert blocked*,
  drawn dashed in a distinct muted colour, and removed with the analysis.
- The level slider above the rim reads "above the rim · the drains are assumed
  to carry it (trace the rim overflow to see the what-if)".
- The rule is generic (a water body with any conduit spill). Herman: the pipes
  are the conduit spill (`csIsPipe`), so the surveyed pipe route is the
  overflow and the rim route becomes the on-demand what-if; the §10 rows and
  numbers are unchanged, only the default visibility of the rim route moves.
  The e2e's rim-route assertions change to assert it is absent by default and
  present after the button.
- Chained behaviour is already what the route shows: Frog Pond → culvert →
  Green Pond → its FES → the road drain → the outfall. Add to the Frog Pond
  card the chain in words: "→ Green Pond (fills to 1,394.50) → green outlet →
  road drain → Clear Lake outfall", built from the route's `legs` and `via`
  ponds, so the intended system reads as a sentence.

## 2. Labels — one engine for 2D, one for 3D, and no duplicates

### 2.1 Why the text stacks

Every `flow` feature draws its own permanent pond label, and the overtopping
analysis makes several flows over the same ponds (the first-discharge route,
the rim route, any raindrop the user dropped). Three labels with the same text
land on the same centroid. There is no collision handling anywhere on the map.

### 2.2 `SBMM.labels` (2D) — `js/labels.js`, new

- A registry of label elements: `SBMM.labels.add({ id, key, priority, latlng,
  el, owner })` / `remove(id)` / `removeOwner(owner)`. `key` is the dedupe
  key (e.g. `pond:<level>:<x>:<y>` rounded to a cell); two labels with the same
  key show once, the higher priority wins.
- After every `moveend`/`zoomend` and after any add/remove (debounced to one
  frame), a greedy placement pass in screen space: sort by priority, keep a
  label if its box does not overlap a kept box (2-px padding), else hide it
  (`visibility:hidden`, never removed). Priorities: spill/first-discharge
  markers 100, pond labels 60, drainage catchment labels 50, flow end labels 40,
  design depth call-outs 45, storm "in pipe" labels 30.
- Convert every permanent label to it: `pondlbl`, `flowend`, `spillmk`
  (all three kinds), `drainlbl`, `excdepth`, the storm "in pipe" labels, the
  drainage names. Tooltips (hover) are not labels and stay as they are.
- Zoom gating stays where it exists; the engine adds collision on top.
- Field mode: the same engine (a phone screen needs it more).

### 2.3 3D labels — `label3d` in `js/viewer3d.js`

- Replace the fixed text sprites with a label layer: each label is a
  camera-facing sprite with a thin leader line to its anchor, sized in screen
  pixels (constant on screen, not in world units; scale by distance in the
  render loop from a pre-allocated array, no allocation), with a translucent
  dark chip behind the text, and the same greedy collision pass per frame in
  screen space when the camera moved (≤ 60 labels, cheap).
- **The stage labels follow the slider.** `stageSpec()` builds them for the
  CURRENT level: a "water level 1,343.95 ft" label at the water surface's
  centroid; each rim low labelled with its state relative to the level —
  above the water: "rim low 2 · 1,344.34 · +0.39 ft to go" in amber; at or
  below: "rim low 2 · 1,344.34 · overtopped" in red; the conduit spill /
  pipes: "first discharge · pond culvert · 1,415.74 · discharging" (storm
  blue) once the level reaches its rim, "· +0.74 ft to go" before. Every
  slider step pushes a new spec; the viewer diffs by text and only rebuilds
  the changed sprites.
- Dim, text and pond labels in 3D go through the same layer (dedupe by key,
  as in 2D), so a pond crossed by three routes has one label in 3D too.

## 3. The 3D view — function and appearance

### 3.1 Parity: everything that works in 2D works in 3D

Build a **parity table** in the e2e (block "9y. 3D parity"): for every layer
row that is ON in `SBMM.layerState`, the 3D scene must contain at least one
object tagged with that row's `(group, id)` (add the tag where missing), and
the e2e prints the rows with none. Today's known gaps to close: cross-section
bands and their station lines (`sections`), the isopach legend context, EA's
PDF boundary layer, the survey contours' own colours, cultural layers (drawn,
with the stamp), the design-surface footprints (`surface` features), dataset
depth sticks (exist — verify), the drainage flow-path row. The table must come
back empty on the folder build with every group switched on.

### 3.2 Appearance

- **Lighting and sky**: a hemisphere light (sky/ground colours from the
  theme) plus one directional key light from the north-west at 35° elevation,
  soft, no shadows (software GL); a vertical gradient sky background; distance
  fog matched to the sky so the edge of the survey fades instead of ending in
  a hard line; a subtle ground plane below the terrain's minimum at the lake
  colour.
- **Terrain**: keep the mesh and the ortho drape; add a "sun angle" control
  (azimuth/elevation) in View settings that lights the hillshade-in-3D the way
  the 2D hillshade is lit; exaggeration slider stays.
- **Materials**: overlays get depth-tested polylines with a 1-px darker
  outline (two passes) so lines read against bright ortho; polygons keep a
  soft fill at 0.25 with a crisp edge; points as small lit spheres or sprites
  with a dark ring; selection is a brighter colour plus a pulsing halo (one
  scalar per frame, no allocation).
- **Chrome**: a compact 3D toolbar that survives `reflowBar`: view presets
  (top / north / south / east / west / isometric), "fit to selection",
  "look at (click a point)", a small elevation legend, the compass; keyboard:
  1–6 for presets, F to fit, arrows to orbit; double-click centres on the
  point under the cursor with an eased transition (existing easing).
- **Picking**: hover highlight and card already exist; add hover on the
  drainage catchments and the stage surface's rim-low sprites.

### 3.3 Field build

Everything above must work on the Pixel 7 profile; the parity block runs in
the field e2e with the field rows.

## 4. Acceptance

`test/kernels.mjs`: unchanged (no kernel work) — still passes.
`test/e2e.mjs`: (a) "9t" updated: Frog Pond's rim route absent by default,
present and dashed after the what-if button, the chain sentence on the card;
Herman: the pipe route present, the rim route absent by default, present after
the button; every §10 number unchanged. (b) A labels block: run Frog Pond's
overtopping plus a raindrop through Green Pond and assert exactly ONE visible
pond label per pond in 2D; pan/zoom and assert no two visible labels overlap;
the drainage layer on at full-site zoom shows no overlapping labels. (c) 3D:
open the Frog Pond analysis, set the slider below the culvert rim → the
culvert label says "to go", at the rim → "discharging"; the rim-low labels
flip to "overtopped" when the level passes them; label count in the scene
equals the visible-label count after collision (≤ registered); the parity
table is empty with every group on; view presets change the camera; the
"animate water" and sun controls exist. `test/perf.mjs`: idle renders still
0; the 3D frame cost with everything on within 20 % of today's (record both).
`test/e2e_field.mjs`: the parity block on the field rows, labels on the phone.
Shots: `test/v15_shots.mjs` → `3d_overview.png`, `3d_frog_stage.png`,
`3d_herman_stage.png`, `labels_2d.png`. Look at them.

## 5. Docs

CLAUDE.md (a v15 section: the overflow rule, the label engines, the parity
table and the 3D chrome; the code-map rows for `labels.js`), README (the
overtopping section's overflow paragraph; a "3D" section), HANDOFF (decision
rows), release notes v9.11. No model names.

## 6. Not in scope

Layers-panel work (`docs/V16_LAYERS_SPEC.md`), Phase 2 runoff
(`docs/V14_PHASE2_RUNOFF_SPEC.md`). Shadows and post-processing.
