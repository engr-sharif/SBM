# SBMM Site Explorer — v21: the WASM compute core (authoritative)

Owner/decider: the planner. Executor: one agent (W). Decided by the
engineer 2026-09-05. Hard constraints as in CLAUDE.md: `file://`, no `fetch`
— the module bytes ship as a base64 `<script>` payload and are instantiated
from bytes; the Blob-URL worker contract stands; every golden stays; the
JavaScript kernels stay as the reference and the fallback. The box has
`rustc 1.94`, `cargo`, the `wasm32-unknown-unknown` target, `clang` and
`wasm-ld`; `wasm-opt` is absent (optional).

---------------------------------------------------------------------------

## 1. Why

The drainage map takes 9.5 s at 2 ft in JS (~500 MB of typed arrays), the
overtopping flood ~1 s, and Phase 3's accumulation and the future 1-ft
site-wide runs are multiples of that. The kernels are pure loops over typed
arrays — exactly what WebAssembly is for.

## 2. The crate — `wasm/sbmm-kernels/`

- Rust, `crate-type = ["cdylib"]`, `no_std` + `alloc` (or std with
  `panic = "abort"` and no I/O), **no wasm-bindgen JS glue that loads files**:
  plain `extern "C"` exports over linear memory (`alloc(n) -> ptr`,
  `free(ptr, n)`, one entry per kernel taking pointers/lengths and writing
  into caller-provided buffers), so the worker can `WebAssembly.instantiate`
  the bytes and call exports with typed-array views. Deterministic: no
  threads, no SIMD in v21 (a `--features simd` build is allowed as an extra
  artefact, never the default).
- **Ported, in this order, each with its own commit and its own harness
  identity**: `fillDem` (priority flood with the conduit seeding and the
  optional parent forest), `flowpath` descent + pond flood, `overtop` (sealed
  flood, rim lows, stage table), `drainage` (components, pointers, labels,
  the polygon tracing may stay in JS), the volume grid integration of the
  `volume` kernel, `contoursFromGrid` (marching squares + chaining), and
  `runoff`'s convolution. `simplifyPath` stays in JS (it is small and used
  on the main thread).
- **Identity is the acceptance**: for every ported kernel the harness runs
  the JS reference and the WASM build on the same job and requires
  bit-identical typed-array outputs where the arithmetic is integer or
  order-independent, and ≤ 1e-6 relative where floating summation order
  differs (say which per kernel, and why). Every existing golden (Pile 1
  278.4, the water §9/§10 numbers, the 100/100 drainage identity, the
  Phase 2 table) must pass on the WASM path too.

## 3. Delivery

- `tools/build_wasm.py`: `cargo build --release --target
  wasm32-unknown-unknown`, `wasm-opt -Oz` if present, then writes
  `datajs/w_kernels.js` (`SBMM_DATA.wasm_kernels = "<base64>"`, with the
  crate version and a content hash) — listed in `index.html`, inlined by
  `tools/build_dist.py`, **kept in the field build** (target < 400 kB).
  The compiled `.wasm` is NOT committed; the payload is, and the preflight
  (`test/check.mjs`) verifies the payload's hash matches the crate source
  (a small manifest), so a stale payload fails before a browser opens.
- `js/jobs.js`: the host decodes the base64 once (`atob` → bytes, transfer),
  hands the bytes to each compute worker at creation, the worker
  instantiates (feature-detected; instantiation failure ⇒ JS path, a
  `console.warn`, never an error); `SBMM.compute.backend()` reports
  `"wasm" | "js"`, every results card that came from a kernel says which,
  and Help gets a "force JavaScript kernels" switch remembered in
  `localStorage` (the e2e flips it and re-runs a golden both ways).
- `js/compute.js` gains a thin dispatch at the top of each ported `runJob`
  kind: `if (WASM && wasmOk) return kernel_wasm(job) else` the JS as today.
  The JS bodies are not edited (Agent A3 is adding kernels in this file in
  parallel; keep your edits to the dispatch and a new `wasm` section so
  the merge is trivial).

## 4. Targets (record before/after in README)

Drainage 2 ft ≤ 2.0 s (from 9.5), overtop Herman ≤ 0.25 s, volume grid
≥ 5×, contours ≥ 3×, on this box; memory: the typed arrays live in linear
memory, no second copy on the JS side beyond the outputs that leave the
worker (report peak worker heap via `performance.memory` where available).

## 5. Acceptance and docs

`test/kernels.mjs` runs every section on BOTH backends (a `--backend
js|wasm|both` flag, default both) and prints the identity per kernel and the
speed-up; `node test/run.mjs` green on all three builds; the field e2e
asserts the backend is `wasm` on the phone build; `SBMM_WASM=0` (or the Help
switch) forces JS and the matrix is green that way too. Docs: CLAUDE.md (a
v21 section: the crate, the bytes-not-files rule, the identity rule, how to
rebuild, the traps), README (the speed table), HANDOFF (a row: "Rust is a
build dependency for the kernels payload only; the app never needs it"),
release notes. No model names.

## 6. Not in scope

SIMD/threads as defaults; porting anything that runs on the main thread;
changing any kernel's definition.
