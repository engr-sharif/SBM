/* SBMM Site Explorer — the offline copy (docs/V17_TOUCH_SPEC.md §2).

   THIS FILE IS THE ONE PLACE IN THE REPO THAT MAY CALL fetch(), and it is not
   the app. CLAUDE.md's first hard constraint — no fetch/XHR for app data,
   because the app has to run from file:// — is about the page. A service
   worker cannot exist over file:// at all: js/touch.js registers this only
   when location.protocol is http: or https:, which in practice means GitHub
   Pages or the harness's own static server. Over file:// nothing here runs and
   nothing changes.

   It caches its OWN ORIGIN ONLY. Every URL it touches is derived from the
   app's own index.html, resolved against this worker's scope, and any URL that
   resolves off-origin is dropped. There are no CDNs in this app and this must
   not become the place one arrives.

   ONE LIST, NOT TWO. The precache list is read out of index.html at precache
   time — the <script src>, <link href> and icon URLs it actually carries —
   rather than being restated here, because a second copy of a 90-line script
   list is a copy that goes stale the first time a module is added.

   Serving: index.html network-first (so a deployed change is picked up the
   moment the device is online), everything else cache-first (the payloads are
   ~130 MB and never change without index.html changing).

   The terrain tiles (v20) are NOT in the list index.html carries: they are
   injected on demand by js/tiles.js, so index.html names only the 30 kB tile
   INDEX. "Download the terrain tiles too" is therefore an explicit opt-in —
   {type:"precache", tiles:true} — which reads that index out of the payload it
   just cached and adds every tile file it names, 64 MB on top of the app. The
   list still comes from the shipped payload rather than from a second copy
   here, for the same reason the script list does.

   Staleness: the FNV-1a hash of the served index.html is stored beside the
   cache. Every network-first fetch compares it; a difference posts {type:
   "stale"} to every client, which js/touch.js turns into one toast and a
   "Update offline copy" button. */

const CACHE = "sbmm-offline-v1";
const STASH = "sbmm-stash-v1";
const META = "sbmm-offline-meta-v1";
const INDEX = new URL("index.html", self.registration ? self.registration.scope : self.location.href).href;

/* --------------------------------------------------------------- */
/* the metadata record, kept as a fake Response inside its own cache */
/* --------------------------------------------------------------- */
async function readMeta() {
  try {
    const c = await caches.open(META);
    const r = await c.match("meta");
    if (!r) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function writeMeta(m) {
  const c = await caches.open(META);
  await c.put("meta", new Response(JSON.stringify(m), { headers: { "Content-Type": "application/json" } }));
  return m;
}
async function clearAll() {
  await caches.delete(CACHE);
  await caches.delete(META);
  haveCopy = false;
  return { type: "cleared" };
}

/* FNV-1a over the text — cheap, and it notices the one byte the harness
   rewrites, which a Content-Length comparison would not. */
function hashOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

/* --------------------------------------------------------------- */
/* the URL list, read out of index.html                             */
/* --------------------------------------------------------------- */
function urlsFrom(html, baseHref) {
  const out = [];
  const push = u => {
    if (!u) return;
    let abs;
    try { abs = new URL(u, baseHref).href; } catch (e) { return; }
    if (new URL(abs).origin !== self.location.origin) return;   // own origin only
    if (out.indexOf(abs) < 0) out.push(abs);
  };
  let m;
  const re1 = /<script[^>]+src="([^"]+)"/g;
  while ((m = re1.exec(html))) push(m[1]);
  const re2 = /<link[^>]+href="([^"]+)"/g;
  while ((m = re2.exec(html))) push(m[1]);
  const re3 = /<img[^>]+src="([^"]+)"/g;
  while ((m = re3.exec(html))) push(m[1]);
  /* v19.1 — the heavy payloads are NOT <script src> tags in the page: a phone
     never parses them, so index.html carries them as one array that its own
     loader document.writes. Read the same array (that is what the markers are
     for) so the offline copy of a tablet or a desktop is still complete. */
  const heavy = /SBMM_HEAVY_BEGIN\s*\*\/\s*window\.SBMM_HEAVY\s*=\s*\[([\s\S]*?)\]/.exec(html);
  if (heavy) {
    const re4 = /"([^"]+)"/g;
    while ((m = re4.exec(heavy[1]))) push(m[1]);
  }
  /* the icons the manifest names, and the manifest itself, are <link>s above;
     the maskable icon is only in the manifest, so add the folder's own set */
  for (const n of ["icons/icon-192.png", "icons/icon-512.png",
                   "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"]) push(n);
  push(baseHref);            // index.html itself
  return out;
}

/* --------------------------------------------------------------- */
/* precache                                                         */
/* --------------------------------------------------------------- */
/* Every tile payload the pyramid's own index names. Read out of the shipped
   datajs/tiles/index.js rather than restated here — one list, not two. */
async function tileUrls(baseHref) {
  const u = new URL("datajs/tiles/index.js", baseHref).href;
  let txt;
  try {
    const r = await fetch(u, { cache: "reload" });
    if (!r.ok) return [];
    txt = await r.text();
  } catch (e) { return []; }
  const m = txt.match(/SBMM_TILES\.index=([\s\S]+);\s*$/);
  if (!m) return [];
  let idx;
  try { idx = JSON.parse(m[1]); } catch (e) { return []; }
  const out = [];
  for (const layer of Object.keys(idx.layers || {})) {
    const L = idx.layers[layer];
    for (const z of Object.keys(L.levels || {})) {
      for (const t of L.levels[z].tiles || []) {
        out.push(new URL(`datajs/tiles/${layer}_${z}_${t[0]}_${t[1]}.js`, baseHref).href);
      }
    }
  }
  return out;
}

async function precache(port, withTiles) {
  const say = o => { try { port && port.postMessage(o); } catch (e) {} };
  let html;
  try {
    const r = await fetch(INDEX, { cache: "reload" });
    if (!r.ok) throw new Error("index.html: HTTP " + r.status);
    html = await r.text();
  } catch (e) {
    say({ type: "error", message: "could not read index.html — " + e.message });
    return;
  }
  const urls = urlsFrom(html, INDEX);
  if (withTiles) for (const u of await tileUrls(INDEX)) if (urls.indexOf(u) < 0) urls.push(u);
  const cache = await caches.open(CACHE);
  let done = 0, bytes = 0;
  /* Serially, on purpose: this is 130 MB over somebody's site wifi, and forty
     parallel requests for 8 MB payloads is how a tablet runs out of memory. */
  for (const u of urls) {
    try {
      const res = u === INDEX
        ? new Response(html, { headers: { "Content-Type": "text/html" } })
        : await fetch(u, { cache: "reload" });
      if (!res || (res.status && res.status !== 200)) throw new Error("HTTP " + (res && res.status));
      const buf = await res.clone().arrayBuffer();
      bytes += buf.byteLength;
      await cache.put(u, res);
    } catch (e) {
      /* a missing TILE is a hole in the pyramid, not a broken app: the loader
         falls back to a coarser level or to synthesis. A missing anything else
         means the copy would not open, and that has to stop. */
      if (u.indexOf("/tiles/") >= 0) { say({ type: "progress", done, total: urls.length, bytes, skipped: u }); continue; }
      say({ type: "error", message: "could not cache " + u.split("/").pop() + " — " + e.message });
      return;
    }
    done++;
    say({ type: "progress", done, total: urls.length, bytes });
  }
  const meta = { count: done, bytes, tiles: !!withTiles, at: new Date().toISOString(), hash: hashOf(html) };
  await writeMeta(meta);
  haveCopy = true;
  say(Object.assign({ type: "done", ready: true }, meta));
}

async function status() {
  const m = await readMeta();
  if (!m) return { type: "status", ready: false, count: 0, bytes: 0 };
  return Object.assign({ type: "status", ready: true, stale: !!m.stale }, m);
}

/* --------------------------------------------------------------- */
/* v35 — the content-hash stash: keep each data file, re-download    */
/* only what a deploy changed                                        */
/* --------------------------------------------------------------- */
/* GitHub Pages stamps every file's ETag with the DEPLOY time, so after any
   deploy the browser's own cache revalidates all 140 MB and gets every byte
   again, changed or not. This keeps the data files (datajs/, vendor/) in a
   cache of their own, each under the content hash tools/stamp_sizes.py wrote
   into index.html's SBMM_HASHES block, and answers a request from it ONLY when
   the hash in the index.html just served still matches. Everything else —
   a file not kept, a file whose hash moved, the app's own js/ — is left to the
   browser, which fetches it natively (no respondWith) exactly as before.

   Filling it never downloads anything the page did not: js/touch.js posts
   {type:"stash", files} once boot and the late payloads are in, naming the
   files THIS page loaded with their hashes, and each is read with
   cache:"force-cache" — the browser's own HTTP cache, the copy it just used.
   A body is kept only if its SHA-256 matches the hash it was named with, so a
   deploy landing mid-visit cannot pin a stale file under a new hash. Entries
   the current index.html no longer names, or names with another hash, are
   dropped on the same pass.

   This is NOT the offline copy and never decides "offline": while an offline
   copy exists the code below this section answers everything as it did. */
let want = null;          // {path: hash} out of the last index.html served
let wantReady = null;     // its parse, which a stashed request waits on
let kept = null;          // {path: hash} of what STASH holds
let keptLoad = null;
let stashing = false;
const SCOPE = new URL("./", INDEX).href;

function relPath(href) {
  const s = href.split("?")[0].split("#")[0];
  return s.indexOf(SCOPE) === 0 ? decodeURI(s.slice(SCOPE.length)) : null;
}
function hashesFrom(html) {
  const m = /SBMM_HASHES_BEGIN \*\/\s*window\.SBMM_HASHES\s*=\s*(\{[\s\S]*?\})\s*;\s*\/\* SBMM_HASHES_END/.exec(html);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (e) { return {}; }
}
async function loadKept() {
  const c = await caches.open(META);
  const r = await c.match("stash");
  kept = r ? await r.json() : {};
  return kept;
}
function ensureKept() { if (!keptLoad) keptLoad = loadKept().catch(() => (kept = {})); return keptLoad; }
async function saveKept() {
  const c = await caches.open(META);
  await c.put("stash", new Response(JSON.stringify(kept), { headers: { "Content-Type": "application/json" } }));
}
async function sha12(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d).slice(0, 6), b => ("0" + b.toString(16)).slice(-2)).join("");
}

async function stash(files, all, port) {
  const say = o => { try { port && port.postMessage(o); } catch (e) {} };
  if (stashing) { say({ type: "stash", busy: true }); return; }
  stashing = true;
  let added = 0, dropped = 0, bytes = 0, skipped = 0, error = null;
  try {
    await ensureKept();
    const cache = await caches.open(STASH);
    const allow = all && typeof all === "object" ? all : null;
    /* drop what the current page no longer names, or names differently */
    if (allow) {
      for (const p of Object.keys(kept)) {
        if (allow[p] === kept[p]) continue;
        await cache.delete(new URL(p, SCOPE).href);
        delete kept[p]; dropped++;
      }
    }
    for (const f of files || []) {
      const p = f && f.path, h = f && f.hash;
      if (!p || !h || kept[p] === h) continue;
      if (allow && allow[p] !== h) { skipped++; continue; }
      const url = new URL(p, SCOPE).href;
      if (new URL(url).origin !== self.location.origin) continue;
      let buf, type;
      try {
        const r = await fetch(url, { cache: "force-cache" });
        if (!r.ok) { skipped++; continue; }
        type = r.headers.get("Content-Type") || "text/javascript";
        buf = await r.arrayBuffer();
      } catch (e) { skipped++; continue; }
      if ((await sha12(buf)) !== h) { skipped++; continue; }   // not the file the hash names
      try {
        await cache.put(url, new Response(buf, { headers: { "Content-Type": type } }));
      } catch (e) {
        error = "the browser refused more storage (" + (e && e.name || "error") + ") after " + added + " files";
        break;
      }
      kept[p] = h; added++; bytes += buf.byteLength;
      await saveKept();
    }
    await saveKept();
  } catch (e) { error = e && e.message || String(e); }
  stashing = false;
  say({ type: "stash", added, dropped, skipped, bytes, kept: Object.keys(kept || {}).length, error });
}

async function stashStatus() {
  await ensureKept();
  return { type: "stashStatus", kept: Object.keys(kept).length, files: Object.assign({}, kept),
           want: want ? Object.keys(want).length : null };
}

/* --------------------------------------------------------------- */
/* lifecycle                                                        */
/* --------------------------------------------------------------- */
/* Whether an offline copy exists, cached in memory so the fetch handler can
   decide SYNCHRONOUSLY. Until one does, the worker does not answer a request
   at all: the browser fetches natively, with its own streaming and memory
   handling. Routing a 14 MB payload through respondWith() + fetch() inside
   the worker is a known way to lose it on iOS, and it bought nothing — with
   no copy there was never a cache hit to serve. null = not read yet. */
let haveCopy = null;
async function refreshHaveCopy() {
  const m = await readMeta();
  haveCopy = !!(m && m.count);
  return haveCopy;
}

self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(Promise.all([self.clients.claim(), refreshHaveCopy(), ensureKept()])); });
/* every start, not only an activation: a worker the browser stopped and woke
   again for a request has lost both records */
refreshHaveCopy().catch(() => {});

self.addEventListener("message", e => {
  const d = e.data || {};
  const port = e.ports && e.ports[0];
  if (d.type === "precache") e.waitUntil(precache(port, !!d.tiles));
  else if (d.type === "status") e.waitUntil(status().then(s => port && port.postMessage(s)));
  else if (d.type === "clear") e.waitUntil(clearAll().then(r => port && port.postMessage(r)));
  else if (d.type === "stash") e.waitUntil(stash(d.files, d.all, port));
  else if (d.type === "stashStatus") e.waitUntil(stashStatus().then(s => port && port.postMessage(s)));
});

async function tellClients(msg) {
  const all = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of all) { try { c.postMessage(msg); } catch (e) {} }
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;             // never off-origin
  if (haveCopy === false) { stashFetch(e, req, url); return; } // no offline copy: the stash, else natively
  if (haveCopy === null) {
    /* a fresh worker instance: read the record once, and answer THIS request
       the slow way rather than guess. A navigation is the normal way a worker
       wakes (the app opened the next day), so it also reads the stash's
       hashes on the way past — otherwise a cold start would never hit it. */
    if (req.mode === "navigate") {
      ensureKept();
      let done;
      wantReady = new Promise(r => { done = r; });
      e.respondWith((async () => {
        await refreshHaveCopy();
        if (haveCopy) {
          done();
          const hit = await (await caches.open(CACHE)).match(req, { ignoreSearch: true });
          return hit || fetch(req);
        }
        let res;
        try { res = await fetch(req); }
        catch (err) { done(); throw err; }
        res.clone().text().then(t => { want = hashesFrom(t); done(); }, () => { want = null; done(); });
        return res;
      })());
      return;
    }
    e.respondWith((async () => {
      await refreshHaveCopy();
      if (!haveCopy) return fetch(req);
      const c = await caches.open(CACHE);
      const hit = await c.match(req, { ignoreSearch: true });
      return hit || fetch(req);
    })());
    return;
  }

  const isIndex = url.href === INDEX || url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");

  if (isIndex) {
    /* network-first: a deployed change wins, and the cached copy is the
       fallback that makes the app open on a plane */
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const txt = await res.clone().text();
        const m = await readMeta();
        if (m && m.hash && m.hash !== hashOf(txt) && !m.stale) {
          await writeMeta(Object.assign({}, m, { stale: true }));
          tellClients({ type: "stale" });
        }
        return res;
      } catch (err) {
        const c = await caches.open(CACHE);
        const hit = await c.match(INDEX);
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});


/* v35 — with no offline copy: index.html goes to the network as it always did
   (its hashes are read on the way past), and a data file is answered from the
   stash only when the hash just served names exactly the copy kept. Anything
   not kept is never touched — the browser fetches it natively. */
function stashFetch(e, req, url) {
  const isIndex = req.mode === "navigate" || url.href === INDEX || url.pathname.endsWith("/index.html");
  if (isIndex) {
    ensureKept();
    let done;
    wantReady = new Promise(r => { done = r; });
    e.respondWith((async () => {
      let res;
      try { res = await fetch(req); }
      catch (err) { done(); want = null; throw err; }
      res.clone().text().then(t => { want = hashesFrom(t); done(); }, () => { want = null; done(); });
      return res;
    })());
    return;
  }
  if (!kept || !wantReady) return;                 // nothing known about this visit
  const p = relPath(url.href);
  if (!p || !kept[p]) return;                       // never kept: native
  if (want && want[p] !== kept[p]) return;          // known to have changed: native
  e.respondWith((async () => {
    await wantReady;
    if (want && want[p] === kept[p]) {
      const hit = await (await caches.open(STASH)).match(new URL(p, SCOPE).href);
      if (hit) return hit;
    }
    return fetch(req);                              // changed under us, or evicted
  })());
}
