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
3. **Redo** is not implemented (button shipped disabled).
4. **Boot ≈ 4.0–4.3 s** on a slow 2-core box; 3.4 s of it is vendor parse + DEM decode.
   Worker-side DEM decode is the next real win (an async job protocol is the prerequisite).
5. **Default-visibility hazard:** `DEFAULT_OVERRIDES` / `DEFAULT_LAYER_OFF` live in three
   places (`js/cadnative.js`, `tools/build_cad_native.py`, `data/design/cad_layer_map.json`).
   Consolidating them into the payload is a good small refactor.
6. `index.html` help prose still says "Residential remedy design" (group is now
   "Residential design (EA 2025)"); `test/perf.mjs` still references the removed 3D
   checkboxes. Cosmetic.
7. **C-102 and C-203 could be placed the way C-202 was** (`tools/register_sheet_native.py`,
   native polygon fitted to the plan linework + ortho confirmation). C-203's rectangle is
   symmetric, so watch the ambiguity.
8. Ideas he has floated for later: richer sample-result symbology by analyte/date, more
   datasets through `datasets.js` (it is the intended path for any new point data), and
   keeping the app the single place the construction team looks.

## Delivery procedure (what "ship it" means)

1. Four test runs pass: e2e + split3d on the folder build, then `python tools/build_dist.py`,
   then both on `dist/SBMM_Site_Explorer.html`. Golden Pile 1 = 278.4 yd³ fill / −48.1 net ±10.
2. Regenerate and **look at** `test/shots/` (`node test/v9_shots.mjs <abs path to index.html>`).
3. Copy `dist/SBMM_Site_Explorer.html` and this folder to
   `C:\Users\nawaz\WORK\SBMM\Site Explorer WebApp\` (the dist beside the `sbmm-site-explorer\`
   folder). Old versions go to `_to_delete\v<N>_<date>\`, never deleted by the tool.
4. Bump `RELEASE_NOTES_v<N>.md`, update CLAUDE.md / this file where behaviour changed.

## Source data that is NOT in this repo (on the user's machine)

- `SBMM\LiDAR and Aerial Survey Data\_staging\master_1ft.f32` (+ CHM) — the master rasters
  every DEM window is cut from (`tools/build_dems_from_master.py`).
- `SBMM\Residental RA Support\EA_ResidentialCleanupDesign\Final_NativeFiles_fromEA\` —
  EA's GIS zip (geodatabase) and FINAL DESIGN zip (DWGs, `.mms`, orthos). Converting the
  Civil 3D DWGs needs libredwg **git master**; release 0.13.3 cannot read them.
- `SBMM\Groundwater Sampling\SBMM Monitoring Wells.xlsx`, `SBMM\Geotechnical\...Location
  Coordinates20251210.xlsx` — the baked wells/borings datasets.
- The two Appendix A drawing-set PDFs (Final and 90 %) — sheet renders.
