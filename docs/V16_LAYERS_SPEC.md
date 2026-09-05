# SBMM Site Explorer — v16: the layers system (authoritative)

Owner/decider: Fable (planner). Executor: one Opus agent (L). This is the
contract. Hard constraints as in CLAUDE.md (file:// only, plain scripts, three
builds, every harness, browser harnesses one at a time, every refusal toasts,
no model names). `SBMM.layerState` stays the ONE model of "is this layer on";
this spec is about the VIEW of it and what a user can do with it.

---------------------------------------------------------------------------

## 0. What the user asked for, in his words

> now that the site is full with a lot of functionality and features, id like
> you to take a deep dive on improvement in presentation and management of the
> layers system, this should be SOTA

## 1. Where it stands

The Layers tab is six fixed sections written in `index.html` (`#baseLayers`,
an analysis sub-section, `#designLayers`, `#investLayers`, `#culturalLayers`,
`#myworkLayers`), filled by 25 `SBMM.addLayerRow` call sites across modules,
with ad-hoc sub-headers (`.lsub`, `.lgsub`) for storm drainage, drainage,
the survey, the sheets and the CAD groups. About 120 rows at full build:
readable by whoever wrote it, not by someone opening it for the first time.
The state model underneath (`js/layerstate.js`) is sound and stays; the
`addLayerRow` API stays as the way modules register a row, so no module has
to change how it registers. What changes is the tree that renders it.

## 2. The design (what "state of the art" means here — ArcGIS Pro / QGIS /
Felt-class layer management, in a 300-px dock)

### 2.1 A real tree — `js/layertree.js`, new; `SBMM.layerTree`

- Nested groups: the six §4 groups, each with named sub-groups declared by
  the registering module (`addLayerRow(group, label, layer, { sub: "Storm
  drainage — EA CAD + Jacobs survey", … })`). Existing `.lsub`/`.lgsub`
  headers become sub-groups. Sub-groups collapse/expand independently, and
  the open/closed state of every group and sub-group is remembered
  (`localStorage`, `sbmm.layertree.v1`).
- Every row: checkbox, a **legend swatch that draws the layer's actual
  symbology** (a line in its colour and dash, a filled polygon, a point glyph,
  a raster thumbnail for imagery/hillshade/isopach), the label, a count
  badge where the module gives one, and on hover a row toolbar: opacity
  (popover slider), **zoom to extent**, **solo** (isolate: everything else in
  the group off, click again to restore — alt-click on the checkbox does the
  same), **info** (a popover with provenance, source file, count, CRS note,
  the row's id, and for CAD groups a link that opens the Layer manager on
  that group).
- Group header: master checkbox (tri-state), "n of m on", collapse chevron,
  and a header toolbar: all on / all off / expand all / collapse all.
- **Drag to reorder** rows within a group and sub-group (pointer events,
  44-px targets in field mode). Order is DRAW ORDER: the tree writes the
  Leaflet z-order (`bringToFront` in tree order within the pane) and the 3D
  overlay order; persisted with the open/closed state and in the session
  file (`layers.order`), additively versioned.
- **Search**: a box at the top of the tab, fuzzy over label + sub-group +
  group + id; while typing the tree shows only matching rows with their
  ancestors expanded and the match highlighted; Esc clears; Enter toggles
  the first match. Keyboard: arrows move, Space toggles, Left/Right collapse
  and expand, `/` focuses search from anywhere in the tab.
- **Presets**: named layer states. Built-in: *Terrain* (base only), *Design
  review* (framework + design GIS + sheets), *Water & drainage* (framework +
  storm + drainage + water work), *Investigations*, *Field* (what the field
  build needs), *Everything on*. User presets: "save current as…", rename,
  delete; stored in `localStorage` and in the session file. A preset applies
  through `SBMM.layerState.set` in one batch (one `layers` event per group)
  and never touches the cultural group's acknowledgement (§7: it stays off
  unless the user ticks it himself).
- **Recently changed**: the last five rows toggled, as chips under the search
  box, one click to re-toggle.
- **A legend on the map**: a collapsible card in the map's bottom-left
  listing every visible row's swatch and label, grouped, with a "hide all
  except" per row; hidden in field mode behind the More sheet.

### 2.2 Presentation

- Row height 26 px desktop / 44 px field; group headers sticky within the
  scrolling pane; sub-group headers indented with a hairline; a CAD/GIS/
  survey/analysis badge per row (already partly there) in one consistent
  chip style; consistent iconography (an icon set inline as SVG symbols);
  counts monospace; hover states; focus rings for keyboard use.
- The six groups stay in §4 order. Sub-group order inside a group: as
  registered, then by user drag.
- Empty groups (field build: no CAD) show one greyed line saying why.

### 2.3 What does not change

`SBMM.layerState` semantics, ids, persistence rules (`persist:false` for
cultural), the `layers` event, `SBMM.addLayerRow`'s signature (extended, not
changed), the Layer manager dialog for CAD names, the cultural gate (it must
still intercept the click in the capture phase — the tree must not break
that; the e2e asserts the acknowledgement still appears), `SBMM.myWork`'s
class rows.

## 3. Acceptance

`test/e2e.mjs`, block "9z. layer tree": every row that existed before exists
after with the same `(group, id)` (dump before/after and compare); search
"storm" shows the three storm rows and their ancestors and nothing else;
solo on `storm_nodes` turns the other framework rows off and restores them;
drag reorder of two rows persists across a reload and changes draw order
(assert `bringToFront` order via the pane's canvas order or a probe);
presets apply and restore; a user preset survives a session round trip; the
cultural acknowledgement still appears on first enable; keyboard navigation
toggles a row; the legend lists exactly the visible rows; alias collisions 0.
Field e2e: the tree in the Layers sheet with 44-px rows, search works by
tap, the legend is in the More sheet. `test/audit.mjs` still records a toast
for every refusal. Shots: `test/layers_shots.mjs` → `layers_tree.png`,
`layers_search.png`, `layers_legend.png`. Every harness on all three builds;
golden unchanged.

## 4. Docs

CLAUDE.md (a `layertree.js` code-map row and a v16 section: the tree is a
view, the order rule, presets, the cultural-gate trap), README ("Layers"
section rewritten), HANDOFF (decision rows), release notes v9.12. No model
names.

## 5. Not in scope

Per-layer styling dialogs beyond opacity (the Layer manager covers CAD);
3D-specific visibility (there is one state); the map itself.
