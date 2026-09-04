/* Unlocking the password gate for the browser harnesses.
   ------------------------------------------------------------------------
   Every harness opens the app cold, and since v9.3 the app is behind the
   password gate in js/gate.js. The gate is NOT weakened for tests — there is
   no test flag, no URL parameter and no shorter path through it. Instead a
   harness pre-seeds exactly the localStorage record a real unlock writes,
   before the first navigation, which is the same thing as "this browser has
   already been unlocked".

   The hash is read out of js/gate.js with a regex, so changing the password
   (tools/set_password.py) never touches the tests.

     import { unlock } from "./gate.mjs";
     const page = await browser.newPage(...);
     await unlock(page);            // BEFORE page.goto()
     await page.goto(...);
   ------------------------------------------------------------------------ */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GATE_KEY = "sbmm.gate.v1";

export function gateHash(repoRoot) {
  const src = readFileSync(resolve(repoRoot || resolve(HERE, ".."), "js/gate.js"), "utf8");
  const m = src.match(/var\s+HASH\s*=\s*"([0-9a-f]{64})"/);
  if (!m) throw new Error("test/gate.mjs: no HASH found in js/gate.js");
  return m[1];
}

/* Seed the remembered unlock. Must be called before the page navigates. */
export async function unlock(page, repoRoot) {
  const hash = gateHash(repoRoot);
  await page.addInitScript(([key, h]) => {
    try { localStorage.setItem(key, JSON.stringify({ h, t: Date.now() })); } catch (e) {}
  }, [GATE_KEY, hash]);
  return hash;
}

/* The salt, read from js/gate.js. */
export function gateSalt(repoRoot) {
  const src = readFileSync(resolve(repoRoot || resolve(HERE, ".."), "js/gate.js"), "utf8");
  const m = src.match(/var\s+SALT\s*=\s*"([^"]*)"/);
  if (!m) throw new Error("test/gate.mjs: no SALT found in js/gate.js");
  return m[1];
}

/* The plaintext, for the one e2e block that has to type it.
   It is deliberately NOT written here: the repo documents the current password
   in exactly one place (docs/HANDOFF.md, private repo) and this reads it from
   there — or from SBMM_GATE_PW if you would rather not have it on disk at all.
   Whatever it finds is checked against the hash in js/gate.js before it is
   handed back, so a stale line in HANDOFF.md fails loudly instead of quietly
   turning the gate assertion into "a wrong password is refused, twice". */
export function gatePassword(repoRoot) {
  const root = repoRoot || resolve(HERE, "..");
  let pw = process.env.SBMM_GATE_PW || "";
  if (!pw) {
    const doc = readFileSync(resolve(root, "docs/HANDOFF.md"), "utf8");
    const m = doc.match(/gate password is `([^`]+)`/);
    if (!m) throw new Error("test/gate.mjs: docs/HANDOFF.md does not carry the gate password");
    pw = m[1];
  }
  const want = gateHash(root);
  const got = createHash("sha256").update(gateSalt(root) + pw, "utf8").digest("hex");
  if (got !== want)
    throw new Error("test/gate.mjs: the documented password does not hash to js/gate.js's HASH — "
                  + "run tools/set_password.py, or fix docs/HANDOFF.md");
  return pw;
}
