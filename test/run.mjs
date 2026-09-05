#!/usr/bin/env node
/* THE RUNNER (v18 §1) — one entry point for every harness in this repo.
   ------------------------------------------------------------------------
     node test/run.mjs                      # the whole matrix, every build
     node test/run.mjs --quick              # the one-minute loop (§1.4)
     node test/run.mjs --only e2e:folder,tablet:http
     node test/run.mjs --builds folder,field
     node test/run.mjs --parallel 2         # browser slots (default floor(cores/2))
     node test/run.mjs --list               # every step and what it needs
     node test/run.mjs --shots              # add the screenshot scripts
     SBMM_GPU=1 node test/run.mjs           # the real GPU (test/lib/browser.mjs)

   What it is for: a round used to be a dozen commands typed in the right order
   with a build in the middle, one browser at a time, and a failure on block 40
   meant re-running from block 1. This declares the steps, their builds and
   their dependencies, runs the independent ones in parallel up to the number
   of BROWSER SLOTS (test/lib/lock.mjs — node-only steps never take one), and
   writes a log per step.

     test/.logs/<step>.log     every step's output, ending in EXIT=<code>
     test/.logs/PROGRESS       live start/done lines
     test/.logs/summary.json   the machine-readable result
     stdout                    the summary table

   WAIT ON A LOG, NEVER ON A PROCESS NAME:

     until grep -q '^EXIT=' test/.logs/e2e-folder.log; do sleep 10; done

   `pgrep -f e2e.mjs` matches the waiting shell's OWN command line and waits
   for itself — that is the 40-minute bug, and it is why this prints the log
   path for every step it starts.

   Exit code is non-zero if any step failed.
   ------------------------------------------------------------------------ */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, createWriteStream, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { acquire } from "./lib/lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const LOGS = resolve(HERE, ".logs");
const R = p => resolve(ROOT, p);
const NODE = process.execPath;
const PY = process.env.PYTHON || "python3";

const INDEX = R("index.html");
const DIST = R("dist/SBMM_Site_Explorer.html");
const FIELD = R("dist/SBMM_Site_Explorer_field.html");

/* ---- the steps ---------------------------------------------------------
   build:   which build the step exercises (none | folder | dist | field)
   browser: takes a browser slot
   needs:   step names that must have PASSED first
   matrix:  in the default run                                            */
const STEPS = [
  { name: "check",          build: "none",   browser: false, matrix: true,  needs: [],
    cmd: [NODE, [R("test/check.mjs")]], desc: "preflight: syntax, symlinks, aliases, script list (§1.3)" },
  { name: "kernels",        build: "none",   browser: false, matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/kernels.mjs")]], desc: "every compute kernel, node only (~3.7 min)" },
  { name: "touch_unit",     build: "none",   browser: false, matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/touch_unit.mjs")]], desc: "the v17 gesture recogniser, node only" },

  { name: "build:dist",     build: "dist",   browser: false, matrix: true,  needs: ["check"],
    cmd: [PY, [R("tools/build_dist.py")], { cwd: ROOT }], desc: "python tools/build_dist.py" },
  { name: "build:field",    build: "field",  browser: false, matrix: true,  needs: ["check"],
    cmd: [PY, [R("tools/build_dist.py"), "--field"], { cwd: ROOT }], desc: "python tools/build_dist.py --field" },

  { name: "e2e:folder",     build: "folder", browser: true,  matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/e2e.mjs"), INDEX, "folder"]], desc: "the desktop e2e over file://, folder build" },
  { name: "split3d:folder", build: "folder", browser: true,  matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/split3d.mjs"), INDEX, "folder"]], desc: "split-view 3D, folder build" },
  { name: "tablet:file",    build: "folder", browser: true,  matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/e2e_tablet.mjs"), INDEX, "tablet", "--skip", "6. the offline copy"]],
    desc: "the iPad harness over file:// (v17)" },
  { name: "tablet:http",    build: "folder", browser: true,  matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/e2e_tablet.mjs"), INDEX, "tablet-http", "--only", "6. the offline copy"]],
    desc: "the iPad harness over http:// — manifest, icons, service worker" },
  { name: "e2e:dist",       build: "dist",   browser: true,  matrix: true,  needs: ["build:dist"],
    cmd: [NODE, [R("test/e2e.mjs"), DIST, "dist"]], desc: "the desktop e2e against the single-file dist" },
  { name: "split3d:dist",   build: "dist",   browser: true,  matrix: true,  needs: ["build:dist"],
    cmd: [NODE, [R("test/split3d.mjs"), DIST, "dist"]], desc: "split-view 3D, dist" },
  { name: "field",          build: "field",  browser: true,  matrix: true,  needs: ["build:field"],
    cmd: [NODE, [R("test/e2e_field.mjs"), FIELD, "field"]], desc: "the Pixel 7 harness against the field dist" },

  { name: "perf",           build: "folder", browser: true,  matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/perf.mjs"), INDEX, "folder"]], desc: "3D / memory numbers (diagnostic, not pass-fail)" },
  { name: "audit",          build: "folder", browser: true,  matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/audit.mjs"), INDEX, "folder"]], desc: "every tool, command, dialog + its toasts" },
  { name: "audit2",         build: "folder", browser: true,  matrix: true,  needs: ["check"],
    cmd: [NODE, [R("test/audit2.mjs"), INDEX, "folder"]], desc: "sheet viewer, properties, split, report" },
  { name: "boot_time",      build: "folder", browser: true,  matrix: false, needs: ["check"],
    cmd: [NODE, [R("test/boot_time.mjs"), INDEX, "3"]], desc: "boot to first interaction + the stage table" },
];

/* the screenshot scripts: --shots, or --only shots:water. Not pass-fail —
   they are run so the pictures exist, and you look at them. */
const SHOTS = [
  ["v9",       [R("test/v9_shots.mjs"), INDEX],              "folder"],
  ["phaseB",   [R("test/phaseB_shots.mjs"), INDEX],          "folder"],
  ["water",    [R("test/water_shots.mjs"), INDEX],           "folder"],
  ["storm",    [R("test/storm_shots.mjs"), INDEX],           "folder"],
  ["drainage", [R("test/drainage_shots.mjs"), INDEX],        "folder"],
  ["runoff",   [R("test/runoff_shots.mjs"), INDEX],          "folder"],
  ["layers",   [R("test/layers_shots.mjs"), INDEX],          "folder"],
  ["v15",      [R("test/v15_shots.mjs"), INDEX],             "folder"],
  ["gate",     [R("test/gate_shots.mjs"), INDEX],            "folder"],
  ["tablet",   [R("test/tablet_shots.mjs"), INDEX],          "folder"],
  ["field",    [R("test/field_shots.mjs"), FIELD],           "field"],
];
for (const [n, args, build] of SHOTS)
  STEPS.push({ name: "shots:" + n, build, browser: true, matrix: false,
               needs: build === "field" ? ["build:field"] : ["check"],
               cmd: [NODE, args], desc: `screenshots — test/shots/ (look at them)` });

/* ---- arguments --------------------------------------------------------- */
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const list = n => (val(n) || "").split(",").map(s => s.trim()).filter(Boolean);

const ONLY = list("--only");
const BUILDS = list("--builds");
const WITH_SHOTS = flag("--shots");
const QUICK = flag("--quick");
const PARALLEL = Math.max(1, Number(val("--parallel") || Math.max(1, Math.floor(cpus().length / 2))));

if (flag("--list")) {
  console.log(`steps (default matrix marked *; browser steps take one of ${PARALLEL} slot(s))\n`);
  for (const s of STEPS)
    console.log(`  ${s.matrix ? "*" : " "} ${s.name.padEnd(16)} build=${s.build.padEnd(6)}`
      + ` ${(s.browser ? "browser" : "node   ")}`
      + ` needs=${(s.needs.join(",") || "-").padEnd(12)} ${s.desc}`);
  console.log("\n  --quick = check + touch_unit + kernels (every section but drainage)");
  process.exit(0);
}

mkdirSync(LOGS, { recursive: true });
const logName = n => resolve(LOGS, n.replace(/[:/]/g, "-") + ".log");
const t0 = Date.now();
const progress = line => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  appendFileSync(resolve(LOGS, "PROGRESS"), s + "\n");
  console.log(s);
};
writeFileSync(resolve(LOGS, "PROGRESS"), "");

/* ---- one step ---------------------------------------------------------- */
async function runStep(step) {
  const log = logName(step.name);
  const out = createWriteStream(log);
  let slot = null;
  if (step.browser) slot = await acquire(step.name, { wait: true, slots: PARALLEL });
  const started = Date.now();
  progress(`START ${step.name}  (log: ${log.replace(ROOT + "/", "")})`);
  const [bin, args, opts = {}] = step.cmd;
  const code = await new Promise(res => {
    const ch = spawn(bin, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, SBMM_SLOTS: String(PARALLEL), ...(slot ? { SBMM_LOCK_TOKEN: slot.token } : {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    ch.stdout.pipe(out, { end: false });
    ch.stderr.pipe(out, { end: false });
    ch.on("error", e => { out.write("SPAWN ERROR: " + e.message + "\n"); res(127); });
    ch.on("close", c => res(c == null ? 1 : c));
  });
  const ms = Date.now() - started;
  out.write(`EXIT=${code}\n`);
  await new Promise(r => out.end(r));
  if (slot) slot.release();
  const txt = readFileSync(log, "utf8");
  const firstFail = (txt.split("\n").find(l => /^\s*FAIL[: ]/.test(l)) || "").trim().slice(0, 110);
  progress(`${code === 0 ? "PASS " : "FAIL "} ${step.name}  ${(ms / 1000).toFixed(1)}s`
    + (firstFail ? `  ${firstFail}` : ""));
  return { name: step.name, build: step.build, ms, code, ok: code === 0, firstFail, log: log.replace(ROOT + "/", "") };
}

/* ---- --quick ----------------------------------------------------------- */
if (QUICK) {
  let sections = [];
  try {
    sections = execFileSync(NODE, [R("test/kernels.mjs"), "--list"], { encoding: "utf8" })
      .split("\n").map(s => s.trim()).filter(Boolean).filter(s => s !== "drainage");
  } catch (e) { sections = []; }
  const quick = [
    { name: "check", build: "none", browser: false, needs: [], cmd: [NODE, [R("test/check.mjs")]] },
    { name: "touch_unit", build: "none", browser: false, needs: [], cmd: [NODE, [R("test/touch_unit.mjs")]] },
    { name: "kernels:quick", build: "none", browser: false, needs: [],
      cmd: [NODE, [R("test/kernels.mjs"), ...(sections.length ? ["--only", sections.join(",")] : [])]] }
  ];
  const res = [];
  for (const s of quick) { const r = await runStep(s); res.push(r); if (!r.ok) break; }
  summarise(res);
}

/* ---- the matrix -------------------------------------------------------- */
let picked = STEPS.filter(s => (WITH_SHOTS ? true : s.matrix) || ONLY.length);
if (ONLY.length) picked = STEPS.filter(s => ONLY.includes(s.name));
if (BUILDS.length) picked = picked.filter(s => s.build === "none" || BUILDS.includes(s.build));

if (!picked.length) { console.log("run.mjs: no steps selected — try --list"); process.exit(2); }

/* pull in the dependencies a selection needs (a dist step needs its build) */
const byName = new Map(STEPS.map(s => [s.name, s]));
for (let grew = true; grew;) {
  grew = false;
  for (const s of [...picked])
    for (const d of s.needs)
      if (!picked.includes(byName.get(d))) { picked.push(byName.get(d)); grew = true; }
}
/* `check` is cheap and stops a matrix before a browser opens; keep it first */
picked.sort((a, b) => STEPS.indexOf(a) - STEPS.indexOf(b));

console.log(`\nSBMM test matrix — ${picked.length} step(s), ${PARALLEL} browser slot(s)`
  + `, ${process.env.SBMM_GPU === "1" ? "SBMM_GPU=1" : "software GL"}`
  + `\nlogs: test/.logs/  (wait on a log's EXIT= line, never on a process name)\n`);

const results = new Map();
const running = new Map();
const failed = new Set();

const ready = () => picked.filter(s =>
  !results.has(s.name) && !running.has(s.name) &&
  s.needs.every(d => !picked.some(p => p.name === d) || (results.has(d) && results.get(d).ok)));

const blocked = s => s.needs.some(d => failed.has(d));

for (;;) {
  for (const s of ready()) {
    if (blocked(s)) { results.set(s.name, { name: s.name, build: s.build, ms: 0, code: -1, ok: false, firstFail: "skipped — " + s.needs.filter(d => failed.has(d)).join(",") + " failed", log: "" }); failed.add(s.name); continue; }
    running.set(s.name, runStep(s).then(r => {
      running.delete(s.name); results.set(s.name, r); if (!r.ok) failed.add(s.name);
    }));
  }
  if (!running.size) {
    if (picked.every(s => results.has(s.name))) break;
    if (!ready().length) {           /* nothing left that can run */
      for (const s of picked) if (!results.has(s.name))
        { results.set(s.name, { name: s.name, build: s.build, ms: 0, code: -1, ok: false, firstFail: "not run", log: "" }); failed.add(s.name); }
      break;
    }
    continue;
  }
  await Promise.race(running.values());
}

summarise(picked.map(s => results.get(s.name)).filter(Boolean));

/* ---- the summary ------------------------------------------------------- */
function summarise(res) {
  const wall = Date.now() - t0;
  const w = Math.max(6, ...res.map(r => r.name.length));
  console.log("\n" + "step".padEnd(w) + "  build   wall     result");
  console.log("-".repeat(w + 32));
  for (const r of res)
    console.log(r.name.padEnd(w) + "  " + (r.build || "none").padEnd(6) + "  "
      + ((r.ms / 1000).toFixed(1) + "s").padStart(7) + "  " + (r.ok ? "PASS" : "FAIL")
      + (r.ok ? "" : "  " + (r.firstFail || `exit ${r.code}`)));
  const bad = res.filter(r => !r.ok);
  console.log("-".repeat(w + 32));
  console.log(`${res.length} step(s), ${res.length - bad.length} passed, ${bad.length} failed`
    + `, ${(wall / 1000 / 60).toFixed(1)} min wall`);
  writeFileSync(resolve(LOGS, "summary.json"), JSON.stringify({
    started: new Date(t0).toISOString(), wall_ms: wall, parallel: PARALLEL,
    gpu: process.env.SBMM_GPU === "1", steps: res
  }, null, 2));
  process.exit(bad.length ? 1 : 0);
}
