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
| C — where the water goes | not started | after S |
| G — desktop 3D drape / hitch / GPU | not started | after C; droppable |

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
