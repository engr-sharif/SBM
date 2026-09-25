# v25 review — where the workbench stands, and what makes it state of the art

2026-09-25. A whole-app audit: the 3D view and the drapes; drafting and earthworks;
samples, borings and water; architecture, boot and the shell. Four read-only reviews
ran in parallel. Every finding below was checked in the code, and the ones marked
**fixed** are in this commit.

---

## 0. Act on this first — not code

**The GitHub Pages site serves the whole repository to anyone with the URL.** From a
machine with no GitHub login, `https://engr-sharif.github.io/SBM/` returned HTTP 206
(served) for `index.html`, `CLAUDE.md`, `docs/HANDOFF.md` and
`datajs/d_cultural.js`, checked 2026-09-25.

- `docs/HANDOFF.md` carries the gate password in plain text, so the gate protects
  nothing on that site.
- `d_cultural.js` is the NHPA s.304-protected archaeological survey. The app gates
  it behind an acknowledgement, but the file itself is public.
- The sample results, the terrain and the imagery of an active Superfund site are
  public too.

What to do, in order:

1. Turn Pages off, or restrict it (GitHub Enterprise private Pages, or an internal
   Jacobs host). HANDOFF open item "0a" already lists the options.
2. Rotate the gate password (`python tools/set_password.py "<new>"`), and keep the
   new one out of the repository.
3. Treat anything that was on Pages as disclosed. Whether the cultural-resources
   exposure needs reporting under the project's confidentiality terms is a question
   for the project lead.

---

## 1. Fixed in this round

### "The 3D draping of the sheets is not working"

The drape code worked, but the drapes were being **hidden** without any message:

| cause | effect | fix |
|---|---|---|
| Four of the six built-in layer presets, a solo, and the Design group checkbox all switch off the hidden row *Sheets draped in 3D*. That state is saved in localStorage. | From then on the per-sheet **3D** button lit up and nothing was drawn, with no message. | Clicking **3D** now switches the master back on and says so. While the master is off, pressed buttons are struck through and their tooltip says why. Presets no longer switch it off. |
| A 3D click inside a draped sheet's rectangle opened the sheet before anything else was tested. | Once a sheet was draped, clicking a DU, boring or storm node on it opened the drawing instead of the object's card. | Order is now: a registered object, then the sheet, then the terrain card. |
| `syncSheets` waited for the texture inline. | Toggling during the decode left a drape stuck on, or an orphaned copy nobody could remove. | One build per sheet at a time, and the wanted state is re-read when the build finishes. |
| The drape sat a fixed 2.5 ft above the ground, with no depth offset. | Up to 2 % of a sheet was buried (worst 10 ft) under the coarse terrain tiles drawn far away. | Added `polygonOffset`, as the design meshes already use. |
| Draped sheets were forgotten on reload. | Every session started with none. | Remembered in `SBMM.view.pref("sheetDrapes")`. |
| Sheet row labels | The opacity slider and two buttons squeezed every label to "C-…". The hover toolbar covered the ⤢ open button. | The slider is gone from sheet rows (the hover toolbar has one). The toolbar sits clear of both buttons. |

### Other defects found and fixed

- **Presets hid your own work.** Built-in presets turned every *My work* class
  off, and that was saved. The next day a new drawing or volume card simply did
  not appear. A built-in preset may now switch *My work* on, never off.
- **Snap followed layers that were switched off.** The 2-ft ABP contours, the
  sample points and the superseded PDF boundaries are all off by default, but
  they were in the snap index. Every contour vertex counted as an endpoint, which
  is the top snap priority, so in the mine area the cursor jumped to invisible
  vertices a few feet apart. Each snap candidate now carries its layer, and a
  layer that is off does not snap.
- **The DU volume button measured the wrong polygon.** DU-1S and DU-2 each have
  two parts with the same name. The popup looked the DU up by name, so clicking
  the small part measured the big one. It now passes the polygon's index. The
  popup's area also subtracts DU-3's two holes.
- **Autosave failed silently.** Both autosaves swallowed every error. Field photos
  are stored inside the session, so about a dozen of them fill browser storage;
  after that nothing was saved and nothing was said. Now the first failure toasts
  and names the fix (export the session file).
- **Station labels at fractional stations.** 1399.6 ft printed as "13+100".
  The station is now rounded before it is split into hundreds and remainder.
- **3D felt heavy under the pointer.** Every mousemove, orbit drags included, ran
  a brute-force raycast of every drawn terrain tile for the coordinate readout.
  It is now one raycast per frame, and none while a button is held.
- **Errors after boot were silent.** An uncaught error or an Error rejection now
  toasts (rate-limited) and points at the console.
- **3D elevations came from the drawn mesh.** The status bar and the point card
  printed the elevation of whichever terrain tile happened to be drawn (up to
  ~10 ft off on a far tile), labelled "1-ft DEM". They now read `SBMM.elev`, which
  is the v20 rule that tiles never supply a number.

---

## 2. The gaps, ranked by what they cost the engineer

S / M / L is rough effort. Items marked ✱ need a decision or data from the site team.

### Tier 1 — the construction and remediation workflow

This is what would make the app "the single place the construction team looks"
(HANDOFF item 10).

1. **Surfaces as data (L).** Today every volume is lidar against a base. `EXIST`
   freezes the same lidar. No LandXML import exists, and CSV import reads E/N but
   never Z. So none of these can be done:
   - the volume of a stockpile from a new survey;
   - as-built against design (the 1-ft excavation-bottom check per lot);
   - lift-by-lift progress over time.

   Build: import LandXML surfaces, CSV points (PNEZD) and 3D DXF as a
   `type:'surface'` TIN, and compare any surface with any other. The isopach, the
   volume engine and the sections already accept a surface, so the maths is done.
2. **Exports that Civil 3D can use (M).**
   - Every DXF vertex is written at z = 0, including pad outlines and daylight
     lines whose elevation is known.
   - There is no LandXML export and no PNEZD point export.
   - DXF import drops Z, arcs (bulges), blocks and inserts, and does not say how
     many entities it skipped.
3. **Cleanup goals and confirmation sampling (M–L) ✱.**
   - Samples carry a yes/no "exceeds RG" flag, but the goal itself is not stated
     anywhere in the app (from the data it looks like Hg ≈ 200 mg/kg and
     As ≈ 6 mg/kg).
   - There are no statistics per DU or per lot: no count, maximum, mean, 95 % UCL
     or exceedance fraction.
   - There is no status per excavation lot (planned → excavated → confirmation
     sampled → pass/fail → backfilled), and no confirmation grid inside each
     geodatabase `exc` polygon.

   *Needed from the team:* the Hg/As levels that apply (residential RAL / PRG, and
   whether an ecological level applies too).
4. **Quantity takeoff (M).**
   - One command should produce cut/fill for every DU, lot, pile or excavation limit
     against a chosen base, with a swell/shrink factor, as one CSV.
   - The Results CSV is scraped from card text today: rounded, thousands commas,
     unescaped quotes.
   - Report sheets fit the figure to Letter portrait. There are no 11×17 or 22×34
     sheets drawn to a stated scale with a title block.
5. **Field capture that closes open items (S each).**
   - A "record invert / rim / size" form on a storm structure's popup that writes
     exactly `data/storm_survey.csv` (HANDOFF 0a).
   - A "settle this contact" column on `LOGS` that writes a file the borings builder
     reads (HANDOFF 0b).
   - Photos in IndexedDB, not localStorage (see the autosave fix above).
   - Structured field notes: sample ID, depth, XRF reading.

### Tier 2 — CAD parity for a Civil 3D user

6. **The same letters mean different things on the map and in the command bar
   (S).** On the map M = Distance and X = Text; in the command bar M = MOVE and
   X = EXPLODE. Enter on an empty bar does not repeat the last command. Command
   search matches names only, so typing `EXPORT` finds nothing.
7. **Selection is one feature at a time (L).** There is no window or crossing
   select and no shift-click, so MOVE, ERASE or changing the layer of a DXF import
   means doing it feature by feature.
8. **Missing edit commands (M–L).** TRIM, EXTEND, FILLET, BREAK, STRETCH, SCALE,
   ARRAY and PEDIT are absent, and a line cannot be closed into an area. JOIN
   bridges any gap, however large.
9. **Typed input reads E,N only (S).** Surveyors write N,E. `SBMM.parseCoord`
   already detects a swapped order and lat/long, but typed input does not use it.
   Bearings (N45°E), station/offset and typed Z are absent.
10. **Undo gaps (S).** Imports, Clear All, and property edits (name, colour, layer,
    a pad's Z, slope or grade) cannot be undone. Opening a session merges it into
    what is already there, so opening it twice duplicates everything.
11. **Drafting in 3D has no snaps (M).** A 3D click goes straight to the raw
    raycast point, with no object snap, ortho, polar or typed input.
12. **Quantities that are not planimetric (M).** There is no 3D surface area (for
    cap, liner or hydroseed quantities), no per-segment bearing table and no
    spot-elevation or slope labels. Auto-balance solves raw cut = fill, with no
    compaction factor.

### Tier 3 — intelligence: an app that knows what it does not know

13. **A site-status panel (S–M).** One card listing every open assumption the app
    already tracks separately:
    - the rainfall is still provisional;
    - 18 of the 44 boring contacts disagree;
    - 26 of 27 conduits have no invert;
    - the August-2026 survey may be in international feet (~13 ft WSW);
    - the design grade was never delivered;
    - the payload is stale.

    Each line links to where it is resolved. This is what turns a set of tools into
    a site model.
14. **Import guardrails (S).** Check every imported coordinate set against known
    features and warn about:
    - international vs US survey feet (a scale of 2 ppm, measurable over a 1-mile
      site);
    - swapped N/E;
    - a constant offset between datums.

    The ALIGNMENT_REPORT shows the risk is real.
15. **Interpolated surfaces with uncertainty (M–L) ✱.** IDW and ordinary kriging,
    each with a variance map:
    - for Hg and As, clipped to the DUs;
    - for waste thickness from the borings, blocked on the C.0 ruling about which
      polygons bound it.

    The variance map shows where the 140 samples are too thin, which is where the
    next samples should go.
16. **Smart defaults (S each).**
    - Suggest the volume base when a footprint sits on a design surface.
    - Offer to close a polyline whose ends nearly meet.
    - Colour the borings by what they found (Phase C §4.1, no ruling needed).
    - Colour any dataset by an attribute.
    - After a scenario run, restore the storm switches the user had before; today
      they stay changed.
17. **Sediment and mercury load to Clear Lake (M) ✱.** RUSLE per outlet class, from
    the existing cover raster, curve numbers and flow accumulation, multiplied by
    the interpolated Hg concentration. It needs soil erodibility (K) from SSURGO,
    which is already open item 0a.

### Tier 4 — the 3D view

18. **Composite the sheets and site rasters into the tile drape (M–L).** A
    floating mesh can never match every level of detail. A texture layer on the
    tiles cannot sink or float. This also fixes the cover and accumulation
    rasters, which are 320-px meshes: 0.7 % of them buried by up to 12.8 ft, and
    2 % floating more than 6 ft in valley bottoms.
19. **EA's reference surfaces as surfaces (M).** They draw only as a footprint.
    `designMesh` already has the solid + x-ray pattern to show the excavation
    bottom and finish grade against the lidar.
20. **Clip box and section plane (M).** Nothing uses `clippingPlanes`. The fence,
    the boring sticks and the buried design cannot be seen without cutting.
21. **Smoothness (S).** The per-mousemove terrain raycast is fixed (section 1).
    Still open: `preserveDrawingBuffer: true` costs every frame on a desktop GPU,
    and the quadtree's error metric is cell size only, so tiles pop in without
    morphing.
22. **Output (S–M each).** Named camera views, an orthographic plan/elevation
    camera, snapshots above screen resolution, a flythrough export, and lines
    thicker than 1 px (`Line2`).

### Tier 5 — platform and code health

23. **Offline copies keep old code (M).** `sw.js` detects staleness only from a
    hash of `index.html`, and every module is served cache-first. So an iPad can
    run old JavaScript indefinitely, or new HTML over old modules.
24. **A shared session does not reproduce an analysis (M).**
    - The storm switch and the broken-conduit states live only in localStorage, not
      in the session file.
    - The session records no build id.
    - The app shows no build id anywhere, so a bug report cannot say which version
      it came from.
25. **Boot is all-or-nothing (S).** About 45 module wires sit in one `try`, so one
    module throwing means "Couldn't start". (The post-boot error toast is fixed,
    section 1.)
26. **Worker crash fallback (S).** After a worker dies, `jobs.js` reruns the job on
    the main thread with buffers it has already transferred away (zero-length
    arrays), so the result is silently wrong or empty.
27. **Heavy layers rerun at every boot (S).** A drainage, accumulation or runoff
    row left on starts a 7–10 s, ~500 MB job on the next boot.
28. **The folder build parses ~67 MB of payload that is off by default (M).** That
    is the full-sheet renders, the 18 MB of sheet overlays and the native CAD.
    `js/tiles.js` already shows how to load a script on demand over `file://`.
29. **`viewer3d.js` (L).** It is 4,300 lines: `rebuildOverlaysInner` is 737 of
    them, and it reaches into 42 other modules. A registration API for 3D builders
    (the way `pick3d.register` works) would stop every new data module having to
    edit it.
30. **The preflight could check more (S).** Add to `test/check.mjs`:
    - `FIELD_EXCLUDE` against `SBMM_HEAVY`;
    - the three homes of `DEFAULT_LAYER_OFF`;
    - `FIELD_STORE` against `STORE`.

    Separately, `--quick` takes 3.4 min, not the documented 50 s, because every
    kernel runs on both backends.
31. **Accessibility (M).** The toast (the app's only error channel) has no
    `aria-live`. 42 icon buttons have no `aria-label`. The `--mut2` text colour is
    about 4.0:1 contrast at 9.5–11 px.

---

## 3. Recommended order

**v25 — construction control.** Items 1 and 2 plus the per-lot half of item 3:
- import an as-built survey (CSV / LandXML / 3D DXF) as a surface;
- compare it to EA's excavation bottom and finish grade, lot by lot;
- produce the pay quantity table;
- export LandXML and 3D DXF back to Civil 3D.

This is the daily construction question for the residential remedy, and every
piece of maths it needs already exists.

**v26 — remediation chemistry.** Item 3 (the goals, the statistics, the lot status
board) and item 15 (interpolation with variance), then the Tier 3 panel (item 13).

**v27 — CAD parity.** Items 6–12, starting with the key conflict, multi-select and
typed N,E, which cost the most friction per day.

The Tier 4 and Tier 5 items go into each round where they touch the same code. The
two that are not optional are **23** (stale offline code) and **25** (visible errors),
because both hide failures from the user.

### Questions only the site team can answer

- **Hosting:** Pages off, private Pages, or an internal host (section 0).
- **Cleanup levels:** the Hg and As numbers the confirmation samples are judged
  against.
- **C.0:** which polygons bound the waste-thickness interpolation (the piles, the
  DUs, or new waste-area polygons).
- **The August-2026 survey units:** US survey feet or international feet.
