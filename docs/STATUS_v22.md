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
| S — three pipes + overflow follows them + slider rule | not started | agent S — **start here Monday after the 7 PM reset**; one agent in a worktree, spec §S + §R, addendum: never push, report with the re-recorded numbers |
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
