# Handoff to Claude Code — read after CLAUDE.md

`CLAUDE.md` is the technical handover (constraints, tests, code map, gotchas, APIs) and
Claude Code reads it automatically. This file carries what CLAUDE.md does not: who the
user is, how he wants to work, the decisions that were made in conversation rather than
in code, and what comes next. It replaces re-reading the chat history that built v1–v9.

## The user and how he works

- **Nawaz (files author as "Mohammad Sharif" / "Mo Sharif", Jacobs).** Leads the
  residential remedy and Phase 1 construction at the Sulphur Bank Mercury Mine OU1
  Superfund site. Daily AutoCAD / Civil 3D / GIS user; this app is his digital twin of the
  site and his daily work tool, not a demo.
- **Working style he asked for:** the AI is the planner and *decision-maker* ("be the
  dictator on how you want this to flow"). Make the design calls, write them down
  (`docs/V9_SPEC.md` is the model), delegate grunt work to subagents when available, then
  *check the work against the plan* — screenshots, tests, numbers. Do not hand him a menu
  of design options to arbitrate; do bring him genuine findings (e.g. "the proposed-grade
  TIN is not in the files") and the one-line external action that resolves them.
- Wants SOTA features and smoothness; **file size is not a concern**; browser-based
  (Electron was considered and rejected); Windows desktop, double-click the single file.
- He reads reports on his phone sometimes — keep summaries short, lead with outcomes.

## Decisions made in conversation (not obvious from the code)

| decision | why |
|---|---|
| Stay browser-based, file:// double-click, one 130 MB HTML | Zero-install for the team; Electron rejected |
| Lidar bare-earth grid (Jan-30-2024 flight) is *the* terrain; CAD contours are display only | Survey-grade source; golden Pile 1 number guards it |
| Canopy only over the mine window | Only LAS tile A1 was ever delivered — a data limit, not a bug |
| EA native GIS/CAD (June 2026) supersedes the PDF-registered sheets | Exact geometry; PDF registration kept only as the record and for the sheet viewer |
| No reprojection between EPSG:2226 and 6418 | Verified empirically at 0.3–1.8 ft; the one exception is the cultural layers (26910 → 2226, different projection) |
| Lot 13 / Lot 15 CAD layer names are swapped; geometry wins | Flagged on the features, never "corrected" the other way |
| Cultural resources **included**, gated (off by default, acknowledgement, CONFIDENTIAL stamp, export gate) | User reversed the earlier exclusion; NHPA §304 / ARPA §9 still apply |
| No proposed-grade surface is synthesised from breaklines | It would invent the pad; ask EA for LandXML instead |
| Residential excavation surfaces are derived from EA's written depths | EA's design is depth-based (1 ft default, 6-in call-outs), so this *is* the design |
| Geodatabase polygons own "Limits of excavation"; CAD exc linework off by default (R1) | Avoids duplicate answers to one click |
| One layer state for 2D/3D/sheets/exports; no 3D checkboxes | §1 of the spec |
| Esc always returns to Navigate | Dead-button bug history |
| Watermark "Mo Sharif - Jacobs 2026" bottom-right, burned into exports | User request |
| C-202 registered from EA's native North Lobe polygon (v9.1), one affine per plan viewport; the raster and 3D drape are the grading plan | The PDF methods could not place it; the native polygon is the drawn boundary with every vertex surveyed |
| GitHub repo stays **private**; no CDNs, analytics or network calls | Site imagery + analytical results |
| **Surveyed levels override the lidar where they exist** (the Aug-2026 water level, pipe inverts and sandbag crest drive the Herman overtopping stages; the lidar still supplies the terrain) | A survey shot is a measurement of the thing; the lidar's flat return over water is a proxy for it, 0.13 ft off after 2.5 years |
| The Aug-2026 survey plot is georeferenced from its **own tabulated points**, scale locked, rotation zero | It is a CAD plot with three (two) surveyed points drawn as vectors: residuals 0.01–0.02 ft, no imagery needed |
| The water tools (v10) are **static terrain analyses only** — no rainfall, runoff, infiltration, seepage, wave run-up or time | He asked "use the topo and predict"; the topo is what the app has ground truth for, and a hydraulic answer dressed in the same UI would be believed |
| A pond is reported at **0.25 ft** depth and deeper | The lidar noise floor: a 0.1-ft "pond" on a 1-ft grid is a rounding artefact drawn as a water body |
| Raindrop windows are **±700 ft on a 1-ft grid, ±1,400 ft on the 2-ft**, re-centred on the exit for up to 8 hops / 20,000 ft | Big enough that most runs finish in one window; small enough that a click answers in about a second. The chaining is what keeps a long run honest across a grid change, and the card lists the grids it used |
| The overtopping overflow route runs on the **same grid and window as the analysis** | Retracing it on the finest DEM under the spill would be a second analysis wearing the first one's answer |
| **A field build is a THIRD output of the same source**, not a second app: `tools/build_dist.py --field`, one exclusion list, everything else identical | Two apps drift. One source with a packaging switch cannot |
| **The field build leaves out the 20 full-sheet plan renders**, the CHM, EA's design surfaces and EA's native CAD (~67 MB of 133) | The design *geometry* is what you need on a site walk; the paper, the tree tools, the isopach and 802 layers of drafting linework are a desk job. Everything that reads them says so rather than failing. If he asks for the sheets on the phone, the one line to change is `FIELD_EXCLUDE` in the builder |
| **Field mode is a UI state (`body.field`), separate from the field build** — it turns on by itself on a touch device ≤ 900 px, and `FIELD` toggles it anywhere, remembered | The full build on a tablet wants the same layout; the field build on a laptop does not. Tying the layout to the packaging would have got both wrong |
| A password screen in front of the app (v9.3), and it is a **deterrent, not security** | He asked for "something to deter someone from using it", explicitly not full security. Everything ships to the browser, so the check is in the file the browser reads — this stops a colleague, not an attacker |

## What was tried and dropped

- AI (SAM) segmentation of piles — model exports produced degenerate masks; dropped.
- Deferring the CHM decode off the boot path — traded boot time for a mid-interaction stall; reverted (see CLAUDE.md).
- Proxy-graphics recovery of Civil 3D surfaces — EA saved with PROXYGRAPHICS off; dead end, documented.
- A breakline-Delaunay "design surface" — refused on the merits (see decisions).

## Open items, in priority order

1. **Repository and North-lobe final grade.** Not in the delivered DWGs. Ask EA for a
   LandXML export (or a proposed-grade raster) of the 02.01 / 02.02 surfaces. Everything
   downstream (`surfaces.json` → `refsurf.js` → isopach, volumes, sections, 3D) accepts
   them with no code change; add a raster via `tools/build_cad_surfaces.py`.
2. **The four 0.5-ft (6-in) call-outs** have no model-space geometry in EA's CAD; markers
   sit at the sheet's excavation centroid with a "verify" note. If EA sends the leaders or
   a delineation, `addHalfFootCallouts()` is the single function to change.
3. ~~**Redo** is not implemented (button shipped disabled).~~ **Done (v9.4, v11 §1.)**
   `SBMM.undo` is two stacks; every push carries an undo AND a redo closure (a push
   without one reports itself in the console and is dropped), `SBMM.store.readd(f)` puts
   the same feature object back with the same id, the two buttons mirror the two stacks,
   and `Ctrl+Y` / `Ctrl+Shift+Z` / `REDO` step forward. The e2e block "9u. redo" is the
   contract. Since v9.7 every user-facing delete (results-card ✕, Features tree,
   Inspector, popup button, design-surface list) routes through
   `SBMM.tools.deleteFeature(f)`, so all of them undo.
4. ~~**Boot ≈ 4.0–4.3 s** on a slow 2-core box; worker-side DEM decode is the next real
   win.~~ **Done (v11 §3).** The four terrain payloads now decode in four dedicated
   workers started together (`Dem.loadAll` in `js/dem.js`, called from the loader in
   `js/boot.js`); only the `atob` stays on the main thread and the bytes are transferred,
   not copied. On the 2-core test box the terrain block went 1,246 ms → 683 ms and the
   `boot-done` mark 2.54 s → 1.66 s median, wall-to-first-interaction 4.49 s → 4.01 s.
   What is left of the boot is vendor parse (~0.6 s) and, in the dist only, parsing ~90 MB
   of base64 string literals — neither of which a worker can help with. The e2e asserts
   `SBMM.perf.demWorkers >= 3` and that the worker and main-thread decodes agree cell for
   cell; `SBMM.perf.demDecode` reports per-payload ms.
5. **Default-visibility hazard:** `DEFAULT_OVERRIDES` / `DEFAULT_LAYER_OFF` live in three
   places (`js/cadnative.js`, `tools/build_cad_native.py`, `data/design/cad_layer_map.json`).
   Consolidating them into the payload is a good small refactor.
6. ~~`index.html` help prose still says "Residential remedy design"; `test/perf.mjs` still
   references the removed 3D checkboxes.~~ **Done (v9.7).**
7. **C-102 and C-203 could be placed the way C-202 was** (`tools/register_sheet_native.py`,
   native polygon fitted to the plan linework + ortho confirmation). C-203's rectangle is
   symmetric, so watch the ambiguity.
8. **The pipes' capacity is not modelled.** The overtopping card says the pipes discharge
   from 1341.55 ft; how much they can pass, and whether the pond keeps rising with them
   flowing, is hydraulics (see the next item).
9. **Hydraulics and rainfall are out of scope** for the water tools, deliberately
   (see the decisions table). If he asks for runoff volumes, a design storm, culverts,
   pipes, a dam-break, or "how long would it take to fill" — **ask before adding**. Those
   need inflow data and a hydraulic model, neither of which is in this repo, and the
   honest first step is naming what would have to be brought in rather than extending a
   terrain analysis until it looks like one.
10. Ideas he has floated for later: richer sample-result symbology by analyte/date, more
   datasets through `datasets.js` (it is the intended path for any new point data), and
   keeping the app the single place the construction team looks.
11. ~~**Findings from the kernel harness (v11 §2)**~~ **All four fixed (v9.7)**, each with
   an identity check in `test/kernels.mjs`: (a) `contours` drops polylines shorter than a
   tenth of a sweep cell (43 sub-0.1-ft stubs gone from the 10-ft site set, 218 polylines
   from 262, nothing over 1 ft touched); (b) `contoursFromGrid` and `demRasterRGBA` honour
   a windowed `gridSpec` — proven identical to the standalone sub-grid; (c) TOE/CREST
   keeps a closed chain closed (`ptsFrom(..., keepClosed)`), so the drawn line and the
   card's Length are the same number; (d) `sections` dead-bands its end areas with the
   isopach's `isoTol` and returns the per-sample `tol` — the phantom fill on
   `res_excbottom` is 0.000 % (was 1.33 %), the tolerance there is ≤ 0.04 ft, and the cut
   it removes is bounded by the dead band itself (1.4 % of a 99.5 ft² cut on the harness
   alignment, which crosses mostly the 1-ft-to-0 transition at the limit of excavation).
12. **The sheet viewer has no touch zoom.** `js/sheets.js` zooms a floating sheet window
   with the WHEEL, and a phone has no wheel; panning and the window drag are pointer-based
   and already work. It does not bite in the FIELD build (the full-sheet renders are not in
   it, so no window opens), but it does on a tablet running the full build. The fix is the
   two-pointer pinch `js/viewer3d.js` now has, applied to `wireWindow`'s pointer handlers —
   an hour, and it needs a real tablet to judge.
13. **Storm drainage around Herman (investigated Sep 2026, nothing built).** EA's V-Base
   drawing carries the discharge system on `V-STRM-STRC` (not `C-SSWR-MAIN-PIPE`, which is
   one 18-ft segment far to the west): a 783-ft 24-in storm line from 30 ft west of the
   surveyed pipe outlets to the Clear Lake shore at E 6,371,273 N 2,127,488, plus a 145-ft
   branch from the south side of the gravel road at E 6,371,958 N 2,127,426. `V-STRM-MRKG`
   holds six two-point culvert marks, each crossing a `V-ROAD-GRVL` embankment; the two
   that matter both feed Herman, from the south road (40 ft, E 6,372,718 N 2,127,378) and
   from Green Pond (62 ft, E 6,373,859 N 2,127,988; Green Pond's low 1391.6 ft drains 641 ft
   overland into Herman and holds ~23 ac-ft before it spills). Frog Pond (low 1415 ft)
   spills north-east off the survey, not to Herman. Green and Frog Pond sit EAST of the
   impoundment, not south. No inverts or diameters in the CAD. Plan, once the manhole
   survey arrives (rim + invert per structure, diameter, material, connectivity): conduits
   as a flow feature (inlet, outlet, two inverts; raindrop/overtop/catchment treat one as
   a shortcut; per-conduit "assume broken" toggle), Manning full-flow capacity per pipe on
   the Herman card, and the storm line as the continuation of the pipe discharge route.

## The password gate (v9.3)

**The gate password is `Jacobs2026`.** This file is the only place it is written down —
not the README, not the release notes, not the code, and not a test. It is here because
this repo is private; if that ever changes, this line goes first.

- **It is a deterrent, not security, and it must never be described as security.** The
  whole app is in the file the browser opens, so anyone willing to read the source is
  past it in a minute. What it does is stop the file being *used* by someone it was
  passed to sideways — which is exactly what he asked for.
- `js/gate.js` holds a SHA-256 of `SALT + password`, never the password.
  `python tools/set_password.py "<new password>"` rewrites that hash (and this line),
  and prints what it did. Nothing else has to change — the tests read the hash out of
  `js/gate.js` themselves.
- An unlock is remembered per browser for 30 days (`localStorage["sbmm.gate.v1"]`).
  Typing `LOCK` (or `LOGOUT`) in the command bar forgets it and puts the screen back up.
  There is no URL-parameter bypass and no test flag — the harnesses pre-seed the same
  localStorage record a real unlock writes (`test/gate.mjs`).
- If he ever forgets it: the hash is in `js/gate.js`, so the password cannot be read back
  out. Set a new one with `tools/set_password.py` and rebuild the dist.

## Delivery procedure (what "ship it" means)

**Three outputs now, and all three are built and tested.** One browser harness at a time —
two software-GL renderers on this box crash the compositor.

1. `node test/kernels.mjs` (fast, no browser — 140 checks; run it first after any kernel or
   call-site change).
2. e2e + split3d on the **folder** build.
3. `python tools/build_dist.py` **and** `python tools/build_dist.py --field`.
4. e2e + split3d on `dist/SBMM_Site_Explorer.html`.
5. `node test/e2e_field.mjs dist/SBMM_Site_Explorer_field.html field` (Playwright's Pixel 7
   descriptor; add the full dist as a third argument for the boot comparison).
   Golden Pile 1 = 278.4 yd³ fill / −48.1 net ±10 in every one of them.
6. Regenerate and **look at** `test/shots/` — `node test/v9_shots.mjs <abs path to index.html>`
   and `node test/field_shots.mjs <abs path to the field dist>`.
7. Copy `dist/SBMM_Site_Explorer.html`, `dist/SBMM_Site_Explorer_field.html` and this folder
   to `C:\Users\nawaz\WORK\SBMM\Site Explorer WebApp\` (both dists beside the
   `sbmm-site-explorer\` folder). Old versions go to `_to_delete\v<N>_<date>\`, never
   deleted by the tool.
8. Bump `RELEASE_NOTES_v<N>.md`, update CLAUDE.md / this file where behaviour changed.

## Source data that is NOT in this repo (on the user's machine)

- `SBMM\LiDAR and Aerial Survey Data\_staging\master_1ft.f32` (+ CHM) — the master rasters
  every DEM window is cut from (`tools/build_dems_from_master.py`).
- `SBMM\Residental RA Support\EA_ResidentialCleanupDesign\Final_NativeFiles_fromEA\` —
  EA's GIS zip (geodatabase) and FINAL DESIGN zip (DWGs, `.mms`, orthos). Converting the
  Civil 3D DWGs needs libredwg **git master**; release 0.13.3 cannot read them.
- `SBMM\Groundwater Sampling\SBMM Monitoring Wells.xlsx`, `SBMM\Geotechnical\...Location
  Coordinates20251210.xlsx` — the baked wells/borings datasets.
- The two Appendix A drawing-set PDFs (Final and 90 %) — sheet renders.
