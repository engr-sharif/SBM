/* The preflight (v18 §1.3) — every static check that can fail a matrix, in
   under ten seconds and without opening a browser.

     node test/check.mjs            # or: node test/run.mjs --only check

   Each check is a real failure this repo has had:

   1. syntax   — `node --check` every js/*.js, sw.js and test/*.mjs. A typo in
                 a module the dist inlines is otherwise found by an 11-minute
                 browser run.
   2. symlink  — no TRACKED symlink (git ls-files -s, mode 120000). An agent
                 worktree makes test/.cache and test/node_modules symlinks; one
                 got committed and broke the Pages build.
   3. worker   — no `</script` inside a function that is stringified into a
                 Blob worker (js/compute.js, js/dem.js's demDecodeWorkerMain):
                 tools/build_dist.py's js_safe would mangle it.
   4. aliases  — no duplicate command alias in js/cmdline.js. Aliases resolve
                 first-match over one flat table, so a duplicate silently kills
                 the later command's (REPORT's SHEET once shadowed SHEETS').
                 This is the same table test/e2e.mjs checks, read statically.
   5. scripts  — every js/*.js is in index.html's script list and every listed
                 script exists. A new file that is not listed is missing from
                 BOTH dists, silently.
   6. names    — no model name in the docs (the CLAUDE.md rule).

   Prints PASS/FAIL per check; any FAIL exits non-zero. */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const R = p => resolve(ROOT, p);
let fails = 0;
const ok   = (n, msg) => console.log(`PASS ${n} — ${msg}`);
const bad  = (n, msg, rows = []) => { fails++; console.log(`FAIL ${n} — ${msg}`); rows.slice(0, 12).forEach(r => console.log("     " + r)); };

/* 1. syntax ------------------------------------------------------------- */
{
  const files = [
    ...readdirSync(R("js")).filter(f => f.endsWith(".js")).map(f => "js/" + f),
    ...(existsSync(R("sw.js")) ? ["sw.js"] : []),
    ...readdirSync(R("test")).filter(f => f.endsWith(".mjs")).map(f => "test/" + f),
    ...readdirSync(R("test/lib")).filter(f => f.endsWith(".mjs")).map(f => "test/lib/" + f)
  ];
  const broken = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ["--check", R(f)], { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) {
      /* the useful line is the SyntaxError, not node's own stack tail */
      const err = String(e.stderr).split("\n").filter(Boolean);
      const msg = err.find(l => /Error/.test(l)) || err[err.length - 1] || "";
      const where = err.find(l => /^\/.*:\d+$/.test(l.trim())) || "";
      broken.push(`${f}: ${msg.trim()}${where ? "  (" + where.trim().split("/").pop() + ")" : ""}`);
    }
  }
  broken.length ? bad("syntax", `${broken.length} file(s) do not parse`, broken)
                : ok("syntax", `${files.length} files parse`);
}

/* 2. no tracked symlink ------------------------------------------------- */
{
  let out = "";
  try { out = execFileSync("git", ["ls-files", "-s"], { cwd: ROOT, encoding: "utf8" }); }
  catch (e) { out = ""; }
  const links = out.split("\n").filter(l => l.startsWith("120000")).map(l => l.split("\t").pop());
  links.length ? bad("symlink", `${links.length} tracked symlink(s) — this broke the Pages build once`, links)
               : ok("symlink", "no tracked symlinks");
}

/* 3. no </script inside a stringified worker function -------------------- */
{
  const rows = [];
  /* the body of a function, by brace counting from its header */
  const bodyOf = (src, header) => {
    const i = src.indexOf(header);
    if (i < 0) return null;
    let j = src.indexOf("{", i), depth = 0;
    for (let k = j; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") { depth--; if (!depth) return src.slice(i, k + 1); }
    }
    return src.slice(i);
  };
  const scan = (file, header) => {
    const body = bodyOf(readFileSync(R(file), "utf8"), header);
    if (body == null) { rows.push(`${file}: \`${header}\` not found — has it been renamed?`); return; }
    if (/<\/script/i.test(body)) rows.push(`${file}: ${header} contains </script`);
  };
  scan("js/compute.js", "function installWorker");
  scan("js/dem.js", "function demDecodeWorkerMain");
  rows.length ? bad("worker", "a Blob-worker function carries </script — js_safe would mangle it", rows)
              : ok("worker", "Blob-worker sources are clean");
}

/* 4. no duplicate command alias ----------------------------------------- */
{
  const src = readFileSync(R("js/cmdline.js"), "utf8");
  const re = /\{\s*n:\s*"([A-Z0-9]+)"\s*,\s*a:\s*\[([^\]]*)\]/g;
  const seen = new Map(), dup = [];
  let m, n = 0;
  while ((m = re.exec(src))) {
    n++;
    const cmd = m[1];
    for (const a of m[2].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean)) {
      if (seen.has(a)) dup.push(`${a}: ${seen.get(a)} shadows ${cmd}`); else seen.set(a, cmd);
    }
  }
  if (n < 20) bad("aliases", `only ${n} commands parsed out of js/cmdline.js — the table shape changed`);
  else if (dup.length) bad("aliases", `${dup.length} shadowed alias(es)`, dup);
  else ok("aliases", `${n} commands, ${seen.size} aliases, no collisions`);
}

/* 5. index.html's script list ------------------------------------------- */
{
  const html = readFileSync(R("index.html"), "utf8");
  const listed = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  const missing = listed.filter(p => !existsSync(R(p)));
  const jsFiles = readdirSync(R("js")).filter(f => f.endsWith(".js")).map(f => "js/" + f);
  const unlisted = jsFiles.filter(f => !listed.includes(f));
  if (missing.length || unlisted.length)
    bad("scripts", `${unlisted.length} js file(s) not in index.html, ${missing.length} listed file(s) missing`,
        [...unlisted.map(f => "not listed: " + f), ...missing.map(f => "listed but absent: " + f)]);
  else ok("scripts", `${jsFiles.length} js files all listed, ${listed.length} script tags all exist`);
}

/* 6. no model name in the docs ------------------------------------------ */
{
  const docs = ["CLAUDE.md", "README.md", "docs/HANDOFF.md"].filter(f => existsSync(R(f)));
  const names = /\b(opus|sonnet|haiku)\b/i;
  const rows = [];
  for (const f of docs)
    readFileSync(R(f), "utf8").split("\n").forEach((l, i) => { if (names.test(l)) rows.push(`${f}:${i + 1}: ${l.trim().slice(0, 90)}`); });
  rows.length ? bad("names", "a model name appears in the docs", rows)
              : ok("names", `${docs.length} doc files carry no model name`);
}

console.log(fails ? `\ncheck: ${fails} FAILED` : "\ncheck: all preflight checks passed");
process.exit(fails ? 1 : 0);
