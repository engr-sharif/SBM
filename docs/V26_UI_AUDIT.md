# v26 — the UI/UX audit, and the redesign it asks for

2026-09-26. The engineer: *"I'd like you to tell me what about the UI you like and
what you don't like. I think we can rethink the whole UI aspect of this webapp …
the boring logs view can use a bit more refinement as it's a bit hard to fully
digest … I want it to feel like an actual boring log … there also should be a
logout option on the top of the app … think about what layers and what is opened
right as the app is open. I want the experience to be inviting and welcoming."*

Two prototypes come with this document. Both are standalone pages that open over
`file://`, and both render from the real payloads:

| prototype | file | screenshots |
|---|---|---|
| **A. The shell and the first thirty seconds** | `docs/ux/home_v26.html` | `docs/ux/assets/mock_home.png` (before: `now_home.png`) |
| **B. The boring log as a log sheet** | `docs/ux/boring_log_v26.html?hole=SB-9` (any of the 44) | `mock_log_SB9.png`, `mock_log_SB7.png` (before: `now_log.png`) |

**Shipped with this round, not proposed:** the padlock in the top bar, and the
**idle lock** — 5 minutes by default, 15 / 30 / 60 or never from the same menu, a
30-second warning chip before it falls, and a reload after the limit asks for the
password too (`js/gate.js`, e2e block 1a).

---

## 1. The verdict

The app's **engine is excellent and its face is a control panel.** Every number
on screen is right, traceable and honest about its assumptions — that is rare and
it is the hard part. But the interface grew one round at a time, each round
adding its rows, buttons and cards to the place nearest to hand, and it now
presents **everything the app can do, all the time, at the same volume**. An
engineer opening it sees 20 top-bar buttons, an 80-row layer list, an empty
Inspector holding a third of the width, and a map with seven kinds of symbol on
it before they have asked a question.

The redesign keeps every capability and every rule (file://, three builds, the
voice, the tests' contracts) and changes **what is shown when**: the map is the
product, panels float over it and appear when they have something to say, a
single search box reaches everything, and each specialist view (the log, the
fence, the design storm) gets a layout designed for *that* content instead of a
results card.

---

## 2. What I like — keep all of it

1. **The gate.** The living contour field is the best-designed thing in the app:
   on-brand, calm, instantly says "terrain". It is the tone the rest should match.
2. **The dark, low-chroma palette and monospace tabular numerals.** It reads as an
   engineering instrument, and numbers line up.
3. **CAD-native interaction.** Mode HUD, status bar with SP coordinates /
   elevation / scale, OSNAP, POLAR, AutoCAD aliases, Esc always returns to
   Navigate. This is the right vocabulary for the audience and nothing else on the
   web does it.
4. **The voice rule.** Cards state the result; the method is one line. Keep it
   and extend it to layout (§6).
5. **One layer state, one mode machine, one popup builder.** The architecture is
   what makes a redesign possible without rewriting behaviour: the new chrome is a
   new *view* over the same state.
6. **The honesty.** Provisional values flagged, "not surveyed" instead of a
   guess, two contact statements shown side by side. The redesign must make these
   *more* visible (the "open items" pattern, §4), never less.

## 3. What I don't like — with the evidence

### The shell

1. **20 equal-weight buttons in the top bar** (`now_home.png`). Six modes, three
   menus, three views and seven data commands (plus overflow and help) carry the same size, weight and
   colour, and the right-hand cluster is icons with no labels (crosshair, flask,
   in, out, undo, redo, trash). Measuring, drawing, analysing and file handling
   are different jobs at different frequencies; the bar shows them as one list.
2. **Two docks and two rails take 44 % of a 1600-px screen**, and the right dock
   spends it saying *"No feature selected."* An inspector that is empty most of
   the time should not own a column.
3. **The command bar, the Go-to box, the layer search and the SHEETS picker are
   four separate searches.** A user has to know which box a thing lives in.
4. **Floating windows land on top of the map and hide it** (the log window, the
   sheet window, the fence). They behave like desktop windows in a web page —
   small title-bar buttons, manual resizing — rather than like views.

### The layers panel

5. **A wall of 80+ rows**, most of them EA CAD layers badged `CAD`, with
   sub-headings in 9-px grey capitals (contrast ≈ 4 : 1) and legends that dangle
   outside any row ("0.02 ac ■ 0.2 ac ■ 2 ac …" in `now_log.png`'s left dock).
6. **Every raster row carries an opacity slider** — permanently, for a control
   used once a week. It is why labels truncate ("Hillshade — mine…").
7. **Presets are a dropdown called "Presets…"**, and (fixed in v25) they used to
   switch off things silently. They are the most useful idea in the panel and the
   least visible.

### The map

8. **Grey no-data fills.** Each orthophoto and the site hillshade ship with a flat
   grey outside the photography, so the site opens as a patchwork of rectangles —
   the mine-area ortho as a hard grey-edged box inside the site ortho, and grey
   where Clear Lake should be. This is a *data* fix (an alpha channel), and it
   changes the first impression more than any CSS could (compare
   `map_clean.jpg`).
9. **Everything on at once.** Storm structures (44 cyan rings), CAD culvert
   boxes, sheet rectangles, DUs, piles, excavation limits, samples — seven symbol
   families at full strength, no hierarchy, no place names. The eye has nowhere to
   land and nothing says *where you are*.

### Cards and results

10. **Results cards are key/value lists in monospace, right-aligned and
    wrapping** ("Groundwater 32.0 ft bgs · perched · at / time of drilling").
    Tables inside cards overflow their width (the design-storm card clips its CN
    and "t peak" columns). A card is the right container for a *number*; it is
    the wrong one for a hydrograph, a strip log or a comparison table.

### The boring log (the deep one)

11. **It is a dark UI with a light sticker in it.** The graphic-log column is paper
    and everything around it is the app's dark panel, so the sheet reads as a
    widget, not as a log.
12. **The description is set in 9-px monospace capitals.** The description is the
    part an engineer actually reads, and it is the hardest text in the app to read.
13. **The facts that matter are scattered.** Native contact, bedrock, water and
    refusal are pills on the sheet, cells in a header strip and rows in a card;
    nothing says *what this hole found* in one glance.
14. **No lab profiles.** WC, LL/PI, fines, pH and N are chips beside a sample; the
    trend with depth — the reason to look at them — is not drawn.
15. **The hole picker is a text field and the Fence tab a grid of 44 checkboxes.**
    Choosing holes is the first step of every log task and it has the least design.
16. **Five small export buttons** (print, print all, print area, csv, png) sit at
    the same weight as the tabs.

### Everywhere

17. **No design system.** Button styles `minib`, `ltb`, `toolbtn`, chips, pills
    and three kinds of close ✕; font sizes from 8.5 to 22 px chosen per round; two
    type families mixed inside one line. The app looks assembled because it was.
18. **One toast element.** Refusals, confirmations and errors overwrite each
    other; there is no history and no undo-in-the-toast.
19. **Accessibility** (from the v25 review): 42 icon buttons with no
    `aria-label`, the toast is not `aria-live`, secondary text ≈ 4 : 1.

---

## 4. The first thirty seconds — what opens, and what is on

**Ruling (proposed):** the app opens on a **home state**, the whole site framed
between two floating panels, with the **curated default** below and a **welcome
card** on the right that goes away the moment anything is done (and stays away
for the session; `H` or the logo brings it back).

**Default layers on a first visit** (a remembered state still wins, as today):

| on | why |
|---|---|
| Imagery — the three orthos as **one seamless basemap** (3 in / 6 in / 1.5 ft, finest wins) | the site is recognisable in one look; no grey rectangles once the alpha fix lands |
| Clear Lake **painted as water** (the drainage module's `lakeRing()`) | orientation; the grey is currently the biggest visual lie on the map |
| Decision units, Limits of excavation | the two polygon sets the remedy is about |
| Soil borings 2025, **coloured by what they found** (waste / native / bedrock at surface) | the investigation's answer at a glance (Phase C §4.1, no ruling needed) |
| **Place labels** — Clear Lake, Herman Impoundment, Mine area, Residential lots, the piles by name | a map with no names is a picture |

| off by default (one tap away under a topic) | why |
|---|---|
| Storm structures and conduits | 44 rings dominate the map; they are a water task |
| EA CAD groups, sheet footprints, PDF boundaries | reference linework, not orientation |
| Hillshade | kept as a basemap choice; under imagery it only muddies |
| Samples | a chemistry task (their own topic, and the Samples table) |
| Survey contours | turn on with Terrain, or zoom-gated at z ≥ 2 |

**The welcome card** (`mock_home.png`, right): the site in one line, four
numbers (acres surveyed, borings, samples, lots to dig), **Pick up where you left
off** (the last three things touched — from the autosave, no new storage), six
**Start** tiles (Boring logs, Sheets, Volume, Water, Fence, Fly the site) and
**Open items** — the assumptions the app already tracks and the engineer has to
resolve (provisional rainfall, 18 contacts, missing inverts). That last list is
the "intelligent" part: the app telling you what it does not know yet.

**Fly the site** is a 20-second scripted 3D orbit (camera path over the tiles,
`prefers-reduced-motion` respected, any input stops it) — the one piece of
theatre worth having, because it *is* the site.

---

## 5. The shell — rebuilt

Proposal A (`home_v26.html`) in words:

- **One floating top bar**, 52 px, glass over the map: brand · **five task menus**
  (Navigate, Measure, Draw, Analyze, Water — each a dropdown of the tools it owns,
  labelled, with its key) · the **omnibox** · **2D / 3D / Split** as one
  segmented control · the **open-items chip** · the **padlock** (shipped) ·
  initials. File actions (import, export, session) move into the omnibox and a
  menu under the initials; undo/redo stay on the keyboard and in the omnibox, and
  surface as an **Undo** button *inside the toast* after anything destructive.
- **The omnibox replaces four searches**: places (DUs, lots, piles, ponds by
  name), coordinates (E,N or N,E — `parseCoord` already detects both), borings,
  sheets, layers and every command with its alias and description. `Ctrl K`,
  `/` and backtick all open it. Fuzzy, ranked by kind, keyboard-first; the
  command line stays for AutoCAD users as the omnibox's `>` mode.
- **Panels float** with 12-px margins and collapse to their title; the map is
  always full-bleed underneath. The layer panel is left; the **inspector is a
  contextual card** that appears next to the selection (the 3D identify card
  already works this way) and docks right only when pinned.
- **Status as a glass pill** at the bottom: E/N, elevation and its source, scale.
  OSNAP / POLAR chips appear only while a drafting tool is armed.
- **Specialist views take the stage, not a window.** The log, the fence, a sheet
  and the design-storm report open as a **full-stage view with a breadcrumb**
  (Map / Borings / SB-9) and a back arrow; the map is one keystroke away and the
  selection stays linked (hover a depth, the boring pulses on the map and in 3D).
  Side-by-side (log + map, sheet + map) is the existing Split, generalised.

## 6. Layers, rebuilt

- **Basemap as four picture tiles** (Imagery, Hillshade, Elevation tint, Plan) —
  one choice, not five checkboxes.
- **"On the map"** — only what is on, each with a switch, one line of what it is,
  and the legend swatch that *is* its symbology (the v16 swatches, kept). Opacity,
  zoom-to, solo and info move to the row's `⋯` menu.
- **"Add from"** — topic cards (Site framework, Residential design,
  Investigations, Water, Terrain, Cultural — *gated*, shown locked) that open a
  catalogue page with search. The 110 EA CAD layers live one level down, with the
  Layer manager, where a Civil 3D user expects them.
- **Views** (today's presets) are named cards with a thumbnail, and saving the
  current state is one button. A view never switches off My work (v25 rule).
- The legend is the list; the floating legend card goes.

## 7. Cards, results and reports

- **Card anatomy:** title · the **one number** that answers the question, large ·
  two or three supporting facts · the method line · actions as text buttons. Long
  tables and charts open as a **report view** (the stage, like the log), never in
  a 300-px card.
- **Proportional sans for words, mono only for numbers.** Right-aligned mono
  paragraphs go.
- **Pin and compare:** any card can be pinned; two pinned cards of one kind show
  as a comparison (two volumes, two scenarios, two holes).
- **Notification centre:** the toast keeps its place but gains a history (the bell
  that the open-items chip opens), and every destructive action's toast carries
  **Undo**.

## 8. The boring log — "feel like an actual boring log", then better

Prototype B (`boring_log_v26.html`) is the contract. Three columns:

**The sheet (centre) — a real log, on paper.** White sheet, black ink, gINT
conventions, so an engineer reads it without learning anything:

- **Header block** as a log has one: hole, waste area, location (E/N, datum),
  ground elevation, total depth and base elevation, drilling methods by interval
  with the rig, dates, driller, logger and checker, groundwater, sample counts,
  printed scale.
- **Columns, left to right:** elevation · depth · **class rail** (waste / native /
  bedrock, the logger's own contact) · samples (type, id, **recovery bar**) ·
  blows per 6 in · **SPT N as a profile** (connected dots, refusal in red at the
  right edge) · graphic log (USCS patterns tinted by class) · USCS · **material
  description in sentence case, the group name in bold** · laboratory chips (WC,
  LL/PI, fines, DD, strength; **pH below 4 outlined red**) and remarks.
- **Horizons as ruled lines** through the graphic columns with a label in the lab
  column: NATIVE, BEDROCK, and — where the logs disagree — a dashed **STRATA**
  line beside it (SB-7 in `mock_log_SB7.png` shows both, 22.0 and 25.0 ft).
  Groundwater as the ▼ symbol with depth and "ATD". The bottom of hole ruled
  heavy with the reason (refusal).
- **Descriptions never overprint.** The v24 lane rule stands; a description
  pushed down by the one above it gets a **leader** back to its stratum top.
- **The depth cursor** is a band across the whole sheet with a chip on the axis;
  the rail's *Depth cursor* card reads out the class, the stratum, the sample and
  every lab value at that depth, and — in the app — the same depth highlights on
  the 3D stick and in the fence.

**The navigator (left)** — all 44 holes grouped by waste area, each with a
**mini class bar** proportional to depth (waste / native / bedrock), total depth,
and an amber dot where the two contact statements differ; filters for *Contacts
differ*, *Water*, *Refusal*; search by id, area or USCS. Choosing holes for
Compare and Fence is ticking rows here, not a checkbox grid.

**The insight rail (right)** — the hole in one glance:
*What this hole found* (the three class intervals with thicknesses, water,
refusals); *Contact statements* (green when the remark and strata agree, amber
with both numbers when not); the *Depth cursor*; **Profiles** — SPT N, pH with
the acid band shaded, and WC against the PL–LL range, on one shared depth axis;
and a **locator** of all 44 holes with this one ringed.

**Beyond paper (the SOTA part), in build order:**

1. **Linked brushing** — the depth cursor drives the 3D stick, the fence and the
   map marker; selecting a stratum in any of them selects it in all.
2. **Compare on paper** — up to six holes on one elevation datum, the class bands
   *and* matched USCS units correlated between them (the v24 fence rules), with
   the same navigator ticks.
3. **Statistics across holes** — the rail's profiles for a *set*: N, pH and WC
   against depth for all holes in a waste area, with this hole highlighted; the
   waste thickness distribution by area.
4. **One sentence per hole**, generated from the record, not from a model: *"7.5 ft
   of tailings over stiff native clay; mudstone at 60 ft; perched water at 32 ft;
   refusal at 80 ft."* — shown under the title and in the map tooltip.
5. **Print is the sheet** — the same SVG at 1 in = 5 ft on Letter (the v23
   arithmetic), with continuation sheets; PDF through the browser.

## 9. The design system

- **Tokens** (one `:root`, light-paper variants for sheets): background, chrome,
  panel ×2, line ×2, ink ×2, muted ×2, accent, warn, bad, ok; the class palette
  (waste / native / bedrock / water) defined **once** and read everywhere.
- **Type:** one sans (Inter, bundled as a base64 `@font-face` — allowed, it is a
  payload, not a CDN; Segoe UI fallback on Windows) and one mono for numbers
  (JetBrains Mono, same way). **Five sizes**: 11 / 12.5 / 14 / 18 / 22, weights
  400 / 550 / 650.
- **Space** on a 4-px grid; radius 7 / 10 / 14; three elevations (flat, panel,
  floating).
- **Components**, one of each: button (primary / secondary / ghost / danger),
  segmented control, switch, chip, menu, card, table, tabs, toast, popover,
  empty state. The existing `minib`/`ltb`/chip variants map onto them.
- **Icons:** one 16/20-px stroke set (the current 40 symbols are the start),
  every icon button labelled for screen readers.
- **Motion:** 120–200 ms, ease-out, one spring for panels; everything off under
  `prefers-reduced-motion`.

## 10. Cartography

- **Ortho alpha** (build tools write WebP/PNG with an alpha channel, or a mask
  payload the overlay honours) and **Clear Lake as water**.
- **Hierarchy:** polygons as thin coloured strokes with 10 % fills; points small
  and haloed; labels with dark halos; the selected thing glows.
- **Density by zoom:** storm structures, CAD symbols and sample points appear
  from zoom 1–2 up; clusters below.
- **Colour-blind-safe class palette** checked in both themes (the dataviz rules).

## 11. 3D, mobile, accessibility — the short list

- **3D:** the same floating chrome; camera bookmarks; the fly-through; a
  clip-box/section plane for the fence and the sticks (v25 review item 20).
- **Phone and tablet:** the floating panels become the bottom sheets field mode
  already has; the omnibox is the phone's first control; the log's three columns
  become three swipeable cards (sheet, story, profiles).
- **Accessibility:** labels on every icon button, `aria-live` on the toast, tab
  roles, focus rings, 4.5 : 1 on all text, keyboard for every control.

---

## 12. The build plan

Each phase ships on its own and keeps every test contract; where a harness reads
a DOM id or a class that the redesign moves, the assertion **moves with it** (the
voice rule's rule: the fact survives, the words and selectors may change).

| phase | what | touches |
|---|---|---|
| **1. Foundation** | design tokens + type + component kit; ortho alpha + lake fill; curated first-visit defaults; place labels; the home/welcome card; the omnibox (search + commands + go-to) | `css/app.css` (new layer), `index.html`, `js/shell.js`, `js/cmdline.js`, `js/layers.js`, `tools/build_ortho_*` |
| **2. Boring logs v2** | prototype B into `js/borewin.js`: paper sheet, navigator, insight rail, profiles, linked cursor with 3D/fence, compare on paper, print | `js/borelogs.js` column renderer stays the one renderer |
| **3. Shell** | floating panels, task menus, contextual inspector, status pill, stage views with breadcrumbs, notification centre with Undo | `js/shell.js`, `js/results.js`, `js/features.js`, `js/popups.js` |
| **4. Layers** | basemap tiles, On the map, topic catalogue, Views | `js/layertree.js` (the v16 model is kept; the view changes) |
| **5. Cartography + 3D** | symbology hierarchy, zoom density, fly-through, bookmarks, clip box | `js/layers.js`, `js/viewer3d.js` |
| **6. Mobile + a11y pass** | bottom-sheet variants, swipeable log, the a11y list | CSS + `js/field.js`, `js/touch.js` |

**Recommended start:** Phase 1 and Phase 2 together — the foundation is what
makes everything after it cheap, and the log is the view you asked for by name.

## 13. Decisions I need from you

1. **Default layers** — the §4 table, as ruled, or changes to it.
2. **The welcome card** — on every visit, or first visit of the day only
   (my recommendation: first visit of the day; `H` brings it back).
3. **Fonts** — bundle Inter and JetBrains Mono (≈ 400 kB in the dists), or stay on
   the system fonts (Segoe UI on Windows looks close).
4. **Idle lock default** — 5 minutes is what shipped; say if the field team wants
   longer on phones.
