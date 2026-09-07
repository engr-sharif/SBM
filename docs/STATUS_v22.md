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
| S — three pipes + overflow follows them + slider rule | not started | agent S |
| C — where the water goes | not started | after S |
| G — desktop 3D drape / hitch / GPU | not started | after C; droppable |

## How to resume

1. `git status` / `git worktree list` — a worktree with commits is an agent's partial
   work; read its last commit messages and `test/.logs/PROGRESS` there.
2. If an agent's report never arrived, the worktree still has its commits: merge what
   is green (`--quick`, then the steps its files touch), or restart the agent with the
   spec section and "continue from the worktree".
3. The Actions matrix is the gate for every PR; local full matrices are optional.
