# v23 — Voice: the app talks to engineers

Status: **rule, 2026-09-09.** Applies to every card, note, popup, tooltip,
legend and dialog in the app, existing and new. The engineer:

> "The whole webapp has a lot of text overexplaining stuff. Most of the people
> using this app will know what this is about, so reduce the amount of
> explaining and any of the instructions on what to do. Like the text that
> comes up under the results sheet explaining all the work on the overtopping
> card — the spill analysis is 2-ft lidar grid, lidar bare earth, etc. — those
> could be at most a sentence. Know your audience: these will be engineers."

## 1. The rules

1. **A card states the result.** Numbers first, in the rows. The method is at
   most **one sentence** under them, and only where a reader could mistake
   what the number is (which grid, which datum, which survey). Nothing else.
2. **No instructions.** The app never tells the reader what to click or how a
   tool works in running text. A control explains itself through its label
   and its tooltip (sentence case, the shortcut in brackets). "Click a stratum
   to…", "use the slider to…", "drag to…" are deleted, not shortened.
3. **No defending the method.** "Static analysis over the pit-filled DEM with
   the escape test against F" is documentation, and it lives in `docs/` and
   CLAUDE.md, not on a card. A card may name the *source* (`lidar Jan 2024`,
   `Jacobs survey Aug 2026`, `OpenGround logs`) in two or three words.
3. **Assumptions are a compact line, not a paragraph.** `no inflow · no seepage
   · planning-level` reads; three sentences saying the same thing do not.
   The existing `PLANNING_NOTE` becomes exactly that form.
4. **Caveats that carry legal or safety weight stay, in one clause.** The
   cultural-resources stamp and acknowledgement, "interpreted — provisional",
   "planning-level, 2 significant figures", "not surveyed". They are kept
   because a wrong reading has a cost; they are kept SHORT for the same
   reason.
5. **A number nobody asked for is removed.** A second cross-check figure, a
   percentage agreement, a cell count: only where it changes what the reader
   does. If it is a diagnostic it goes behind an *info* tooltip or into the
   copy-CSV, not on the card.
6. **Popups: the fact, then the button.** The three summary lines and one row
   of actions. The attribute table follows without a heading.
7. **Legends and layer rows: the name and the unit.** Not what the layer is
   for.
8. **The info page (`#help`) keeps its note and its manual `<details>`**; the
   manual is where instructions belong, and it is closed by default.
9. **Tests read text.** Where an e2e assertion matches a sentence that is
   being shortened, the assertion moves with it — to the new wording, or
   better, to a `data-` attribute or a class the card carries (`data-grid`,
   `.warnpill`), so the words can change again without a harness edit. Never
   keep a sentence because a test reads it.

## 2. The worked example — the overtopping card

Before (five sentences, 90 words):

> Static spill analysis on the 1-ft lidar bare earth: today's water surface
> is the surveyed level (Jacobs, Aug 2026, 1,336.45 ft) over the lidar's
> water footprint (its flat return read 1,336.58 ft in Jan 2024); the first
> discharge is the surveyed 24-in pipes, the rim spill is the lidar's; the
> sandbag wall beside the pipes is surveyed at 1,343.54 ft, the lidar rim
> there reads higher (rim low ②) — the survey is the current truth for the
> wall itself. The spill is the lowest rim cell from which water drains away
> (pit-filled DEM), storage is geometric. Above the spill the table describes
> a sealed flood — what would happen if the low rim at ① were raised. No
> inflow, wave run-up, seepage or erosion — planning-level.

After (one line):

> 1-ft lidar (Jan 2024) · water level and pipe inverts from the Aug 2026 survey · static, no inflow · planning-level

The pipe-versus-rim story is already in the rows (first discharge, rim spill,
their levels); the "sealed flood above the spill" belongs in the slider's own
label; the wall's lidar-versus-survey note becomes an *info* tooltip on the
rim-low row it concerns.

## 3. Where to look

`grep -n "appendNote\|class=\"note" js/*.js` finds 44 notes across 17 files;
the heaviest are `js/runoff.js` (9), `js/scenarios.js` (5), `js/results.js`
(5), `js/water.js` (4), `js/smartbound.js` (4), `js/borelogs.js` (4). Beyond
the notes: the "what this is" paragraphs at the top of the design-storm and
where-the-water-goes cards, the popup builders in `js/popups.js`, the drainage
and accumulation cards, the pipe-capacity card, the isopach and volume cards,
the section panel, the first-run hint, the Mode HUD prompts (a prompt is an
instruction the tool needs — keep those to the minimum words: *click the
boundary · Enter to finish*), and the command-help table descriptions.

## 4. Acceptance

- Every `appendNote` in the app is one sentence or one `·`-separated line.
- No card, popup or note contains "click", "drag", "use the", "you can",
  "to see", "hover" (a grep the e2e runs over the DOM after opening each card
  the harness already opens).
- The e2e, field, phone and tablet harnesses pass with their text assertions
  moved, not deleted: every assertion that read a sentence still asserts the
  same *fact* through the new wording or a data attribute.
- `docs/HANDOFF.md` gains the decision row and CLAUDE.md a short "voice"
  section pointing here.
