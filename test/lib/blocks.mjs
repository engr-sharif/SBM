/* Named blocks for the browser harnesses (v18 §3).
   ------------------------------------------------------------------------
   test/e2e.mjs is 6,200 lines of flat top-level statements over one page and
   one accumulating scene. Every one of its sections already had a name in a
   comment — "9t. overtop + conduits" — but nothing could ADDRESS one, so a
   failure in the last section cost a full eleven-minute re-run.

   This gives the name a handle and nothing else:

     await block("9t. overtop + conduits", async () => { ...as before... },
                 { needs: ["pile1"] });

   and on every converted harness:

     --only <name,name>   run just these (exact, prefix, or substring)
     --from <name>        start here and run to the end
     --skip <name,name>   run everything except these
     --list               print the block names and exit (no browser)

   A block the harness cannot do without — booting the app, closing the
   browser — is declared { always: true } and runs whatever the selection is.

   Two rules make that safe:

   * A FULL RUN IS UNCHANGED. Blocks run in the order they are reached, inline,
     exactly as the statements did. Nothing is printed by this module unless a
     selection is active, so a full run's output is byte-for-byte what it was.
     That is the acceptance test for the conversion (v18 §3).
   * A SKIPPED BLOCK'S STATE IS A FIXTURE. State that later blocks need is
     declared once, with the code that makes it:

       S.define("pile1", async () => { ...draw and measure Pile 1... });
       await S.get("pile1");            // built on demand, cached after

     so `--only 9t` gets the app into the state 9t needs without running the
     forty blocks in front of it. A block that asks for a fixture nobody
     defined fails loudly, naming both.

   --list is answered by READING the harness file, before Playwright is even
   imported: this module is imported first (imports are hoisted), so it can
   print the names and exit without opening a browser.
   ------------------------------------------------------------------------ */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const listOf = n => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || "").split(",").map(s => s.trim()).filter(Boolean) : []; };
const one = n => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || "").trim() : ""; };

const ONLY = listOf("--only");
const SKIP = listOf("--skip");
const FROM = one("--from");
export const SELECTING = !!(ONLY.length || SKIP.length || FROM);

const norm = s => s.toLowerCase().replace(/\s+/g, " ").trim();
const matches = (name, pat) => {
  const a = norm(name), b = norm(pat);
  return a === b || a.startsWith(b) || a.includes(b);
};

/* the block names, read statically out of the harness itself */
export function names(file = process.argv[1]) {
  try {
    const src = readFileSync(file, "utf8");
    return [...src.matchAll(/\bblock\(\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\"/g, '"'));
  } catch (e) { return []; }
}

if (argv.includes("--list")) {
  const ns = names();
  console.log(`${ns.length} blocks in ${process.argv[1].split("/").pop()}:\n`);
  ns.forEach((n, i) => console.log(`  ${String(i + 1).padStart(3)}  ${n}`));
  console.log("\n  --only <name>   --from <name>   --skip <name>   (name, prefix or substring)");
  process.exit(0);
}

/* --from resolves against the static list, so "start here" knows the order */
const ALL = names();
let fromIdx = -1;
if (FROM) {
  fromIdx = ALL.findIndex(n => matches(n, FROM));
  if (fromIdx < 0) { console.log(`FAIL: --from ${FROM} matches no block in this harness`); process.exit(2); }
}
if (ONLY.length) {
  const unmatched = ONLY.filter(p => !ALL.some(n => matches(n, p)));
  if (unmatched.length) { console.log(`FAIL: --only ${unmatched.join(",")} matches no block in this harness`); process.exit(2); }
}

let seen = 0, ran = 0, skipped = 0;
export function wanted(name) {
  const i = ALL.indexOf(name);
  if (SKIP.some(p => matches(name, p))) return false;
  if (ONLY.length) return ONLY.some(p => matches(name, p));
  if (fromIdx >= 0) return i < 0 || i >= fromIdx;
  return true;
}

/* ---- the fixture store ------------------------------------------------- */
const made = new Map(), makers = new Map();
export const S = {
  define(key, make) { makers.set(key, make); return S; },
  set(key, v) { made.set(key, v); return v; },
  has(key) { return made.has(key); },
  /* get(key[, make]) — the cached value, or build it now from the same code
     the block that normally makes it uses. */
  async get(key, make) {
    if (made.has(key)) return made.get(key);
    const fn = make || makers.get(key);
    if (!fn) throw new Error(`blocks: fixture "${key}" was asked for and nobody defines it `
      + `(S.define("${key}", ...) beside the block that makes it)`);
    if (SELECTING) console.log(`[blocks] fixture: ${key}`);
    const v = await fn();
    made.set(key, v);
    return v;
  },
  async ensure(keys) { for (const k of keys || []) await S.get(k); }
};

/* ---- the block --------------------------------------------------------- */
export async function block(name, fn, opts = {}) {
  seen++;
  if (!opts.always && !wanted(name)) { skipped++; if (SELECTING) console.log(`[blocks] skip: ${name}`); return; }
  if (SELECTING) console.log(`[blocks] run: ${name}`);
  await S.ensure(opts.needs);
  ran++;
  return await fn();
}

export function stats() { return { seen, ran, skipped, selecting: SELECTING }; }
process.on("exit", () => { if (SELECTING) console.log(`[blocks] ${ran} run, ${skipped} skipped, of ${seen} reached`); });
export default { block, S, wanted, names, stats, SELECTING };
