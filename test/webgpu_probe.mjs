/* SBMM Site Explorer — the v20 §5 WebGPU feasibility probe.

   The spec asks one bounded question: can a WebGPU renderer live inside this
   app's constraints — no bundler, no fetch(), opens from a folder over file://
   AND as one HTML file? three.js ships its WebGPU renderer as ES modules only,
   so the question is really two: is there a WebGPU adapter here at all, and can
   an ES module be loaded in this app's two shipping shapes.

   This runs the same probe page over file:// and over http and prints both, so
   the finding in CLAUDE.md is a measurement rather than an opinion.

       node test/webgpu_probe.mjs

   It launches its own Chromium with --enable-unsafe-webgpu and the SwiftShader
   adapter, which is the only WebGPU there is on this box. */
import { launch } from "./lib/browser.mjs";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "fixtures", "webgpu_probe.html");

/* the same tiny static server the tablet harness uses, inline: node http + fs,
   no dependency */
const srv = http.createServer((req, res) => {
  const f = resolve(HERE, "fixtures", req.url.replace(/^\/+/, "").split("?")[0] || "webgpu_probe.html");
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(b);
  });
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const browser = await launch({
  args: ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader",
         "--enable-features=Vulkan,UseSkiaRenderer"]
});

async function run(url, label) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.SBMM_PROBE_DONE === true, null, { timeout: 30000 })
    .catch(() => {});
  const r = await page.evaluate(() => window.SBMM_PROBE || { failed: true });
  await page.close();
  console.log(`\n== ${label} (${url.split("/").slice(0, 3).join("/")}) ==`);
  console.log(JSON.stringify(r, null, 1));
  if (errs.length) console.log("  errors:", errs.slice(0, 4).join(" | "));
  return r;
}

const f = await run(pathToFileURL(PAGE).href, "file://  — the folder build and the single file");
const h = await run(`http://127.0.0.1:${port}/webgpu_probe.html`, "http://  — GitHub Pages and the offline copy");

console.log("\n== the finding ==");
console.log(" WebGPU adapter here      :", f.hasNavigatorGpu ? (f.adapter ? "yes" : "navigator.gpu but no adapter") : "no navigator.gpu");
console.log(" WGSL pipeline compiles   :", f.wgsl === undefined ? "n/a" : f.wgsl);
console.log(" file:// inline module    :", f.inlineModule);
console.log(" file:// <script src> mod :", f.moduleSrc);
console.log(" file:// import(blob:)    :", f.blobImport, f.blobImportErr ? "— " + f.blobImportErr : "");
console.log(" file:// import map + blob:", f.importMapBlob, f.importMapErr ? "— " + f.importMapErr : "");
console.log(" http   <script src> mod  :", h.moduleSrc);
console.log(" http   import(blob:)     :", h.blobImport);
console.log(" http   import map + blob :", h.importMapBlob);

await browser.close();
srv.close();
