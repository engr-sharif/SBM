# v22 — resumable status (the planner's usage budget may end mid-round)

Read `docs/V22_SPEC.md` first. This file is the checklist a fresh session continues
from. Update it at every step; it is committed with the work.

Branch: `claude/webapp-onboarding-mavtzx` (reset to main before this round; main =
f2b73b9 v9.21). Every agent works in a git worktree under `.claude/worktrees/agent-<X>`
on branch `worktree-agent-<X>`, never pushes, never opens a PR; the planner merges the
worktree branch into the feature branch, runs `node test/run.mjs --quick`, pushes,
opens/updates the draft PR, waits for the Actions matrix (8 jobs), merges, resets the
branch to main.

| step | state | notes |
|---|---|---|
| spec written (`docs/V22_SPEC.md`) | done | evidence for §S is in the spec |
| S — three pipes + overflow follows them + slider rule | **done** (2026-09-08, worktree `agent-S`, branch `worktree-agent-S`) | 44 nodes / 27 conduits (17 CAD/survey, 10 inferred). Re-recorded: the raindrop's pipe_ft 812.8 → **812.2**, its chain `herman_pipe_s,herman_main_s`, the discharge route's legs `herman_pipe_s,herman_main_s,herman_pipe_n,herman_main_n`, the layer counts 15/12 → 17/10. UNCHANGED, which is the proof: `herman_pipe_s`'s through_area **37.90 ac**, the 100/100 raindrop identity, the §11.8 accumulation identity at 0.000 % on all three outlets, and the outlet areas 403.03 / 293.45 / 282.01 ac (0.01 ac moved between the lake and the outfall — see below). Commit list below |
| C — where the water goes | **done** (2026-09-08, worktree `agent-C`, branch `worktree-agent-C`) | The four areas at 2 ft: Clear Lake **403.03 ac**, the Herman impoundment **84.14**, Frog/Green **197.87**, off the survey **293.45** — sum **978.49**, the map's own site. The impoundment's catchment is 84.14 ac and NOT the drainage card's 37.90 (see below); the v19 accumulation at the same two barrels says 84.09 independently. Commit list below |
| G — desktop 3D drape / hitch / GPU | **in progress** (2026-09-08, worktree `agent-G`, branch `worktree-agent-G`) | the drape by texture budget, the mesh build off the main thread with a geometry cache, GPU detection, and the 2D hillshade check |

## Why it stopped here (2026-09-06)

The engineer's Max plan showed the weekly all-models budget at 93 % used and the
planner-model budget at 81 %, resetting Monday 7 PM. An agent round costs more than what was
left, so the round stopped after the spec, with nothing half-built: no worktree, no
open agent, branch = main + these two docs (PR #21, draft, docs only — merge it or
leave it; the code work goes on the same PR).

## Known flake still open — block 9z (the layer tree's draw order after a reload)

The docs-only matrix on this PR failed `e2e:folder` once with the recorded
signature (`{ dus: 456, piles: 467 }`, insertion order — the re-apply pass did not
run). v21's two app-side changes (trailing-edge `legendSoon`, the `boot` re-apply) did
NOT close it; it still fails about one run in three on the Actions runner. Not this
round's scope, but the next agent that touches `js/layertree.js` should instrument
WHEN the last `applyDrawOrder` ran relative to the last `layeradd` after the reload,
rather than add another debounce. The fixed re-run on this PR is the flake's own
re-run; a second failure on unchanged code is still the flake, not the docs.

## How to resume

1. `git status` / `git worktree list` — a worktree with commits is an agent's partial
   work; read its last commit messages and `test/.logs/PROGRESS` there.
2. If an agent's report never arrived, the worktree still has its commits: merge what
   is green (`--quick`, then the steps its files touch), or restart the agent with the
   spec section and "continue from the worktree".
3. The Actions matrix is the gate for every PR; local full matrices are optional.

## S — what shipped, and the two things the spec did not foresee (2026-09-08)

Commits on `worktree-agent-S`, oldest first:

| commit | what |
|---|---|
| `855f36e` | §S — the network rebuild in `tools/build_storm_network.py` → `data/storm_network.json` → `datajs/d_storm_network.js`: `herman_main_n` (E943E) and `herman_main_s` (E943C), `storm_main_upper/lower` on E943D, `pipe_to_main` / `pipe_to_main_s` / `storm_main_east` gone, one shared `outfall`, the dog-leg recorded as *drawn, purpose not established — ask EA*. The builder writes the payload itself, byte-identical to what `tools/build_data.py` would write from the JSON (checked) |
| `563190d` | §R.1 — `js/water.js` `legPolyline()`, the one lookup the 2D line, the un-draped 3D tube and the particle track all use; the 3D ground line split per stretch. §R.2 — the automatic rim overflow, `routes().rimAuto`, the card and slider wordings. Plus `parallelBarrels()` learning that two barrels can converge on an outlet NODE, with a same-length test |
| `fd5a36b` | §S — `js/storm.js` `mapConduits()`; `js/drainage.js` / `js/accum.js` share it; `test/kernels.mjs` §6.7/§6.8/§6.9 re-recorded, the identity classifier follows `next`, §11.1 asserts one outlet at the shared outfall |
| `c25e19f` | the e2e's storm and survey numbers re-recorded (blocks 9s, 9v) |
| `b0f7c76` | block 9t: the automatic rim overflow on Frog Pond, the three slider states on Herman |
| `b0832ab` | 9t leaves the analysis open for the 3D sub-block; the slider label names "the 24-in pipes" |
| (this one) | CLAUDE.md v12/v13 rewrite + a v22 section, README, HANDOFF, RELEASE_NOTES v9.22, V12_STORM_SPEC, this file |

**Two things the spec did not foresee, both recorded in CLAUDE.md's v22 section:**

1. **One `outfall` NODE is not one outlet.** The `drainage` kernel names an outlet
   sink after the LAST CONDUIT of the chain that reaches it (`"outfall:" + id`), so
   three conduits ending at the node gave three outlets with the same name and split
   the 282 ac three ways. `js/compute.js` was not editable this round, so the rule is
   the host's: `SBMM.storm.mapConduits()` names the TRUNK and points the others at it
   through `next`, which the kernel follows only to find where a chain ends.
2. **The counts are 44 nodes, not 42.** `storm_main_upper` is kept (the spec asks for
   that) and it needs a from-node, so `storm_main_east` is replaced by
   `storm_main_d_east` at E943D's east end. That is also the whole of the 0.01 ac that
   moved between the lake and the outfall: the node sits 2.4 ft south of the old one,
   so one 3-ft capture disc covers 109 different 2-ft cells.

**One more thing, from agent A's parallel finding**: the Aug-2026 survey may be
displaced ~13 ft WSW (international vs US survey feet). Nothing in §S hard-codes
the 12.8/12.7 ft gaps — the builder measures each from the two coordinates on
every run, says "measured at N ft as the survey is plotted today" in the note,
and raises if a barrel's plotted west end stops being nearest the CAD line it is
paired with. The survey data is untouched. A re-placement changes the two gap
lengths (and so `herman_main_*.length_ft` and the raindrop's 812.2 ft by about
the same amount); it changes nothing else in §S, because the rest of each
conduit is EA's polyline verbatim.

**A worktree trap worth the line**: `test/storm_shots.mjs` defaulted BOTH its
target and its output directory to a hard-coded `/home/user/SBM`, so run from a
worktree it photographed the planner's checkout and wrote into the planner's
`test/shots`. It now resolves both from the script's own location, the way
`test/hydro3_shots.mjs` has since v19 (which is where this was found the first
time). Six shots scripts still carry the constant — `drainage_shots`,
`gate_shots`, `runoff_shots`, `v15_shots`, `v15_smoke`, `water_shots` — and the
rule is now written down in CLAUDE.md's testing section.

**One local failure that is NOT this round's**: `e2e:folder` block *9a-2. detail
setting rebuilds the terrain at a different density* fails on this box, twice,
with `high: 66049 | standard: 0 | back to high: 0` — 66,049 is one 257x257 tile,
i.e. the v20 tile quadtree had only its root drawn by the time block 9a
measured. Run ALONE (`--only "9. 3D viewer,9a-2"`) the same block passes with
`high: 1,585,176 | standard: 166,410 | back: 1,585,176`. No flow feature exists
at that point in the run, so none of §R.1's viewer3d code has executed; it is
the v20 terrain LOD, which is agent G's section. The blocks this round touches
(9s, 9v, 9t) were run and pass.

Local runs (from the logs): `node test/run.mjs --quick` 4/4 PASS; `--only
e2e:folder,field,phone:http --wait` — `check` PASS, `build:field` PASS, `phone:http`
PASS 26.8 s, `field` PASS 128 s, `e2e:folder` see `test/.logs/e2e-folder.log`;
`node test/kernels.mjs --only drainage` 59 checks PASS (100/100 identity, §11.8
identity 0.000 %), `--only storm` 101 checks PASS, `--only water3d` 76 checks PASS.

## C — what shipped, and the one place the spec's arithmetic did not hold (2026-09-08)

Commits on `worktree-agent-C`, oldest first:

| commit | what |
|---|---|
| `9727bd7` | marked C in progress in this file |
| `8b7463a` | **the feature.** New `js/wherewater.js` (`SBMM.whereWater`); `{ mergeOutfalls: false }` on `js/storm.js` `mapConduits`; `lakeRing` exported from `js/drainage.js`; the 3D drape in `js/viewer3d.js`; `SBMM.popups.forWhereWater`; the `WHEREWATER` command and the Water ▾ entry; the export fold-ins (`js/io.js`, `js/dxf.js`); the design-storm card's *what this is* paragraph and its four class rows (`js/runoff.js`); the CSS; e2e block **9ac2** plus the 9y wait and the 9z allow-list entry |
| `4d17c10` | `test/kernels.mjs` **§11.9** inside the existing `drainage` section, and the docs (README's plain-language page, HANDOFF's two decision rows, CLAUDE.md's §C section and code-map row) |
| `f316a0a` | the field (block 15) and phone (block 4) assertions, and the v9.22 release-notes entry |
| `a8d168d` | `hermanTerminals()` walks the conduit list the run was given, not the raw network — a broken pipe shortens a chain and the kernel names the outlet after the earlier conduit |
| `6d77ee3` | block 9w asserts the Water menu in full, so the new entry is stated there |
| `27119bf` | the impoundment's one line reads as a sentence (the storm's own name ends in a comma) |

**The four areas, at 2 ft** (recorded in `DRAIN_REC`, asserted in §11.9 and in
block 9ac2): straight into Clear Lake **403.03 ac**, into the Herman impoundment
**84.14**, into Frog Pond / Green Pond **197.87**, off the surveyed ground
**293.45** — **978.49 ac**, which is the drainage map's own surveyed ground to
0.0001 ac. At 4 ft (the field build and any phone): 399.80 / 86.83 / 198.94 /
292.92 = 978.48.

### THE ONE DEVIATION, and it is the spec's own acceptance criterion

**The spec asks that "Herman's class area equals `through_area` of the
impoundment's outlet (`herman_pipe_s`, 37.90 ac) within 0.01 ac". It cannot, and
the same paragraph's other acceptance criterion is why.** `through_area` counts
the ground whose FIRST CAPTURE is the impoundment — the cells that reach it
without pausing in a smaller depression on the way. Measured on this site:

- 1,975 distinct first-capture labels carry the 978 acres;
- 38,994 lidar depressions, **1,945** of them deeper than the 0.25-ft noise
  floor, and only **60** of those are in the kernel's reported pond list;
- only **114 ac** of the site reaches a sink with no capture at all (29.9 into
  the lake, 84.3 off the survey).

So classing by first capture gives 29.9 + 37.9 + 17.1 + 84.3 ≈ 169 ac and leaves
**809 ac unassigned** — it cannot partition anything, and the partition is the
other half of the same acceptance paragraph. The two criteria are inconsistent on
this terrain.

**What shipped instead**: the class is the OUTLET, read at a finer naming, so the
partition is exact by construction; the impoundment's class is its **catchment**,
84.14 ac. Both numbers are printed — the card's impoundment sentence ends "of
which 37.90 ac reach it directly, the rest through smaller depressions on the
way" — and the spec's identity is asserted on the quantity it actually describes:
§11.9 and block 9ac2 both require `directIntoImpoundment()` to equal
`through_area("herman_pipe_s")` within 0.01 ac, and require the class to be
larger. The 84.14 is then checked against an INDEPENDENT kernel: the v19 flow
accumulation at the same two barrels is **84.09 ac** (0.05 %), which is the
strongest evidence available that the catchment is the right answer.

### Two more things the spec did not foresee

1. **EA's water polygons do not contain Frog Pond's or Green Pond's lowest
   lidar cell**, so `js/drainage.js` `pondName()` calls both "Depression · E …"
   and the class sentence would have said "the eastern ponds". The names come
   from the storm network's own node names ("Frog Pond outlet", "FES — Green Pond
   outlet (west shore)") matched against EA's water-layer NAMES — both halves
   data. `js/drainage.js` is left alone: fixing `pondName` would move rows on a
   card this round did not touch, and it is worth a line in a later round.
2. **`DRAIN_REC.max_acc_ac` (197.82) was described in a comment as "the last cell
   before the impoundment leaves through the surveyed south pipe".** It is not —
   the accumulation at that pipe is 84.09 ac. 197.82 is the ROAD DRAIN's trunk,
   and it is the same 197.87 ac §11.9 reports for the Frog/Green class, to the
   decimation. The comment is corrected; the recorded value is unchanged.

### One decision worth restating

**The class layer runs a second pass of the `drainage` kernel** (about 6 s in
node, 5-25 s in a worker; 2.7 s on the 4-ft field build) rather than deriving the
classes from the map's existing rasters. It was not a first choice: the map's own
`first` raster is decimated for display and its per-label areas exist only for
the 60 biggest ponds, so nothing exact can be assembled from it. The second pass
is the SAME kernel over the SAME ground with one flag changed, it costs the
kernel's own budget, and it buys an exact partition with the polygons traced for
free. §11.9 asserts the two runs agree cell for cell on the surveyed ground and
to 0.0001 ac on every outlet.

### The runs (2026-09-08, this box, software GL)

`node test/run.mjs` — the whole matrix, 19 steps, 21.2 min wall, **16 passed, 3
failed**. All three failures re-ran ALONE and passed, and all three are the
known load flakes rather than anything §C touched:

| step | in the matrix | alone |
|---|---|---|
| `e2e:folder` | FAIL — *detail rebuild not reversible*, `high: 66049 \| standard: 0` | **PASS** 849.7 s (`high: 1585176 \| standard: 166410 \| back: 1585176`) — the v20 terrain-LOD flake this file already records under §S |
| `terrain3d:folder` | FAIL — *an idle view renders nothing … got 2* | **PASS** 34.4 s |
| `tablet:file` | FAIL — *a long press on the terrain opened no identify card* | **PASS** 190.8 s (and `tablet:http`, the same harness, passed in the matrix) |

Everything else green first time, including **`e2e:dist` (1,173 s)** — block 9ac2
runs on the single-file build too and reports the same four areas to the
thousandth of an acre — `kernels` (456 s, every section on both cores),
`field` (132.7 s), `phone:http` (26.2 s), `perf`, `audit`, `audit2`,
`split3d:folder/dist`, `terrain3d:dist`, `tablet:http`.

Also run on their own during the round: `node test/run.mjs --quick` 4/4 PASS
(112 s); `node test/kernels.mjs --only drainage` **155 checks PASS in 296.7 s**
on both backends (§11.9's 20 checks included); `node test/e2e.mjs … --only
"9ac2"` and `--from "9w. water"` (19 blocks) both PASS.
