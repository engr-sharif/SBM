# Agent rules — how to run this repo's tests without losing an afternoon

Ten rules. Every one of them is a mistake that has already cost a round.

1. **`node test/run.mjs --quick` after every edit** — preflight + the gesture unit
   harness + every kernel section but `drainage`, about a minute. The browser is for
   when that is green.
2. **Open a browser only through `test/run.mjs` or a harness** — both take the browser
   lock (`test/lib/lock.mjs`). Two software-GL renderers on a two-core box crash the
   compositor, and that looks like a test failure.
3. **Wait on the log's `EXIT=` line**, never on a process name:
   `until grep -q '^EXIT=' test/.logs/e2e-folder.log; do sleep 10; done`.
   `pgrep -f e2e.mjs` matches the waiting shell's own command line and waits for
   itself — that is the forty-minute bug.
4. **Commit before any run longer than a minute.** A crashed container loses the work,
   never the commit.
5. **Never `git add` a symlink.** `test/.cache` and `test/node_modules` are symlinks in
   an agent worktree; one got committed and broke the Pages build. `run.mjs --only check`
   fails on a tracked symlink.
6. **When a block fails, `--only` it**: `node test/e2e.mjs index.html folder --only 9t`
   (and `--list` to see the names). Re-running eleven minutes to reach block 40 is a
   choice, not a requirement.
7. **One Chromium per two cores.** `--parallel` defaults to `floor(cores/2)`; raise it
   only on a machine with the cores to spare.
8. **`SBMM_GPU=1` where there is a GPU** — the 3D blocks then render on it and the
   timeouts drop from 180 s to 60 s. It says in the log which path it got.
9. **Report from the log, with counts** — "345 checks, 0 FAIL, 3.7 min" and the step's
   log path. Never "tests pass" without a number, and never a number you did not read
   out of a log.
10. **Change how the harnesses run, never what they assert.** A harness edit that moves
    an assertion is a change to the contract and needs the planner, not a commit.

Full detail: `CLAUDE.md` "Running tests", `docs/V18_TESTINFRA_SPEC.md`.
