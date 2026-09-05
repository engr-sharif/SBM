# SBMM Site Explorer — v18: the test infrastructure (authoritative)

Owner/decider: Fable (planner). Executor: one Opus agent (M). This is the
contract. It changes HOW the harnesses run, never WHAT they assert: every
assertion line every harness prints today must be printed, identically, after
this round. Hard constraints as in CLAUDE.md.

---------------------------------------------------------------------------

## 0. Why

The engineer asked why a round takes "hours and hours". Measured on the cloud
box (2 cores, no GPU, software GL): a desktop e2e is ~11 min, a full matrix
40–70 min, ONE browser can run at a time, and a harness that fails on block 40
re-runs from block 1. Three agents queued behind one browser slot; one agent
sat 40 min in a wait loop that matched its own shell; a committed symlink broke
the Pages build. He also has a GPU machine of his own and wants it used, and he
wants the agents "optimised".

## 1. One runner — `test/run.mjs`

```
node test/run.mjs                      # the whole matrix, every build
node test/run.mjs --quick              # the one-minute loop (§1.4)
node test/run.mjs --only e2e:folder,tablet:http
node test/run.mjs --builds folder,field
node test/run.mjs --parallel 2         # browser slots (default: floor(cores/2), min 1)
node test/run.mjs --list               # step names and what each needs
SBMM_GPU=1 node test/run.mjs           # real GPU (§2)
```

- **Steps**, each with a name, the build it needs, whether it needs the
  browser, and a command: `check` (§1.3 preflight), `kernels`, `touch_unit`,
  `build:dist`, `build:field`, `e2e:folder`, `split3d:folder`, `tablet:file`,
  `tablet:http`, `e2e:dist`, `split3d:dist`, `field`, `perf`, `audit`,
  `audit2`, `shots:*` (each shots script). Dependencies are declared (a dist
  step waits for its build) and the scheduler runs independent steps in
  parallel up to `--parallel` browser slots; node-only steps (`kernels`,
  `touch_unit`, `check`) never take a slot.
- **Per-step logs** in `test/.logs/<step>.log` (gitignored) ending in
  `EXIT=<code>`, a live `test/.logs/PROGRESS` (start/done lines with times), a
  final summary table on stdout (step, build, wall time, PASS/FAIL, the first
  FAIL line), and `test/.logs/summary.json`. Exit non-zero on any failure.
- **The browser lock**: `test/lib/lock.mjs` — `acquire(name)` takes
  `test/.logs/browser.lock` (pid, name, started; `N` slots when `--parallel`),
  refuses with a readable message naming the holder if a LIVE pid holds every
  slot, `--wait` waits. EVERY browser harness calls it at start (through the
  shared launcher, §2) so an agent cannot start a second Chromium by accident;
  the runner takes the slots on the harnesses' behalf.
- **Waiting is on files, never on process names.** The runner and the docs say
  so: `until grep -q '^EXIT=' log`, never `pgrep -f <name>` (the pattern is in
  the waiting shell's own argv and matches itself — the 40-minute bug).

### 1.3 Preflight (`check`, node-only, < 10 s)

`node --check` every `js/*.js`, `sw.js`, `test/*.mjs`; no tracked symlink
(`git ls-files -s` mode 120000 — the Pages failure); no `</script` inside any
function that is stringified into a Blob worker (`js/compute.js`,
`demDecodeWorkerMain`); no duplicate command alias (the same table the e2e
checks, run statically); every `js/*.js` file is in `index.html`'s script list
and every listed script exists; the three doc files carry no model name (the
CLAUDE.md rule, grep for the known names). A preflight failure stops the matrix
before a browser is opened.

### 1.4 `--quick` — the one-minute loop

`check` + `touch_unit` + `kernels --only <every section but drainage>`. What an
agent runs after every edit; the browser is for when that is green.

## 2. One launcher, and the GPU switch — `test/lib/browser.mjs`

Every harness launches Chromium through `launch(opts)` here (the `CHROME_BIN`
logic exists in each file today; move it, do not copy it). It acquires the lock
(§1), applies the descriptor (`Pixel 7`, `iPad Pro 11 landscape`, desktop), and
honours **`SBMM_GPU=1`**: drop the SwiftShader flags and pass
`--use-gl=angle --use-angle=default --ignore-gpu-blocklist
--enable-gpu-rasterization` (Windows: `--use-angle=d3d11`), so a machine with a
GPU renders the 3D blocks on it. Print the renderer string
(`WEBGL_debug_renderer_info`) once at launch so a log says which path ran.
Headless stays the default; `SBMM_HEADED=1` opens a window. Timeouts stay at
180 s under software GL and drop to 60 s when the GPU path is on (the whole
point of the switch is that they can).

## 3. Block selection — `test/lib/blocks.mjs`

`block(name, fn, { needs: [...] })` registers a named block; the file runs them
in order. Flags on every browser harness: `--only <name,name>`, `--from <name>`,
`--skip <name>`, `--list`. A skipped block's state is a **fixture**: a block
that needs something an earlier block made asks `S.get("pile1", make)` for it,
and the fixture is built on demand from the same code the block used. Convert
`test/e2e.mjs` (its blocks already carry names like "9t. overtop + conduits"),
`test/e2e_field.mjs` and `test/e2e_tablet.mjs`. Acceptance for the conversion
is mechanical: a full run's assertion/summary lines (everything except
timings and memory numbers) must be IDENTICAL to a run of the file before the
conversion — record both under `test/.logs/` and diff them in the report.
`--only 9t` must run in under two minutes on the cloud box.

## 4. GitHub Actions — the matrix on GitHub's runners

`.github/workflows/matrix.yml`: on `pull_request` and on `workflow_dispatch`,
a job per browser step from §1 (folder e2e, dist e2e + split3d, field, tablet
both ways, perf/audit) on `ubuntu-latest`, Playwright's Chromium from cache,
`test/run.mjs --only <step>`, logs and `test/shots/*.png` uploaded as
artifacts, the summary as the job summary. Five jobs in parallel put the whole
matrix at roughly the length of its slowest step. Free while the repository is
public; on a private repository it spends Actions minutes, and the workflow
says so in a comment. The `Pages` deployment is untouched.

## 5. The agents' rules — `docs/AGENT_RULES.md`, linked from CLAUDE.md

Ten lines, no more: run `test/run.mjs --quick` after every edit; the browser
only through the runner or a harness (both take the lock); wait on the log's
`EXIT=` line; commit before any run longer than a minute; never track a
symlink; never `pgrep` for your own harness; report from the log, with counts;
one Chromium per two cores; `SBMM_GPU=1` where there is a GPU; when a block
fails, `--only` it. CLAUDE.md's "Running tests" section is rewritten around
the runner (the individual commands stay documented as what the runner runs).

## 6. Acceptance

The full matrix through `test/run.mjs` on the cloud box is green on all three
builds with every harness's assertion output identical to before (the diff in
the report); `--only 9t` under two minutes; the lock refuses a second harness
with the holder's name; `check` catches a planted symlink, a planted duplicate
alias and a planted missing script tag (test each, then remove the plant);
`SBMM_GPU=1` runs here (it falls back to software GL when no GPU exists and
says so); the workflow file validates (`actionlint` if available, else a
careful read) and is triggered once by `workflow_dispatch` after merge, with
its result reported.

## 7. Not in scope

Any change to what a harness asserts; any app code (`js/`) beyond zero.
