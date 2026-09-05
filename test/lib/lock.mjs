/* The browser lock (v18 §1).
   ------------------------------------------------------------------------
   ONE Chromium per browser slot. Two software-GL renderers on a two-core box
   crash the compositor, which looks like a test failure and is not one — so
   every browser harness takes a slot before it launches (through
   test/lib/browser.mjs, which calls this for you) and an agent cannot start a
   second one by accident.

   The lock is a JSON file, test/.logs/browser.lock:

     { "slots": 1, "holders": [ { "token", "pid", "name", "started" } ] }

   A holder whose pid is gone is pruned on sight (a harness killed with ^C
   must not block the box for ever). The critical section is a directory
   created with mkdir, which is atomic on every filesystem this repo runs on.

     import { acquire } from "./lock.mjs";
     const slot = await acquire("e2e:folder");   // throws if every slot is held
     ...
     slot.release();                             // also runs on process exit

   Slots come from SBMM_SLOTS (the runner sets it from --parallel); the default
   is 1, which is what an agent running a harness by hand should get.

   The runner takes a slot on a step's behalf and passes SBMM_LOCK_TOKEN in the
   child's environment; a harness that sees a token knows its slot is already
   held and does not take a second one.
   ------------------------------------------------------------------------ */
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync as mkd } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOGS = resolve(HERE, "../.logs");
const LOCK = resolve(LOGS, "browser.lock");
const MUTEX = resolve(LOGS, ".lock.mutex");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

function slots() { return Math.max(1, Number(process.env.SBMM_SLOTS || 1) || 1); }

function readState() {
  try {
    const st = JSON.parse(readFileSync(LOCK, "utf8"));
    st.holders = (st.holders || []).filter(h => alive(h.pid));
    return st;
  } catch (e) { return { slots: slots(), holders: [] }; }
}

async function withMutex(fn) {
  mkd(LOGS, { recursive: true });
  for (let i = 0; i < 600; i++) {
    try { mkdirSync(MUTEX); }
    catch (e) { await sleep(50); continue; }
    try { return fn(); } finally { try { rmSync(MUTEX, { recursive: true }); } catch (e) {} }
  }
  /* 30 s of a stuck mutex means a process died inside the critical section */
  try { rmSync(MUTEX, { recursive: true }); } catch (e) {}
  return fn();
}

export function describeHolders() {
  const st = readState();
  return st.holders.map(h => `${h.name} (pid ${h.pid}, since ${h.started})`).join("; ") || "nobody";
}

/* Take a browser slot. Throws a readable error naming the holder when every
   slot is taken and { wait: true } was not asked for. */
export async function acquire(name, opts = {}) {
  const wait = opts.wait || process.argv.includes("--wait");
  const n = opts.slots || slots();
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const deadline = Date.now() + (opts.timeoutMs || 60 * 60 * 1000);

  for (;;) {
    const got = await withMutex(() => {
      const st = readState();
      st.slots = n;
      if (st.holders.length >= n) return null;
      st.holders.push({ token, pid: process.pid, name, started: new Date().toISOString() });
      writeFileSync(LOCK, JSON.stringify(st, null, 2));
      return token;
    });
    if (got) break;
    const who = describeHolders();
    if (!wait)
      throw new Error(`browser lock: all ${n} slot(s) are held by ${who} — `
        + `wait for its log's EXIT= line, run with --wait, or raise --parallel. `
        + `(test/.logs/browser.lock)`);
    if (Date.now() > deadline) throw new Error(`browser lock: waited an hour for ${who}`);
    await sleep(3000);
  }

  const slot = { token, name, release: () => release(token) };
  const off = () => { try { releaseSync(token); } catch (e) {} };
  process.on("exit", off);
  process.on("SIGINT", () => { off(); process.exit(130); });
  process.on("SIGTERM", () => { off(); process.exit(143); });
  return slot;
}

export function releaseSync(token) {
  try {
    const st = readState();
    st.holders = st.holders.filter(h => h.token !== token);
    writeFileSync(LOCK, JSON.stringify(st, null, 2));
  } catch (e) {}
}

export async function release(token) { await withMutex(() => releaseSync(token)); }

/* For the runner: it holds slots on its children's behalf. */
export function tokenFromEnv() { return process.env.SBMM_LOCK_TOKEN || ""; }
export function held() { return readState().holders; }
