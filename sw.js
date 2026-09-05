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

   Staleness: the FNV-1a hash of the served index.html is stored beside the
   cache. Every network-first fetch compares it; a difference posts {type:
   "stale"} to every client, which js/touch.js turns into one toast and a
   "Update offline copy" button. */

const CACHE = "sbmm-offline-v1";
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
async function precache(port) {
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
      say({ type: "error", message: "could not cache " + u.split("/").pop() + " — " + e.message });
      return;
    }
    done++;
    say({ type: "progress", done, total: urls.length, bytes });
  }
  const meta = { count: done, bytes, at: new Date().toISOString(), hash: hashOf(html) };
  await writeMeta(meta);
  say(Object.assign({ type: "done", ready: true }, meta));
}

async function status() {
  const m = await readMeta();
  if (!m) return { type: "status", ready: false, count: 0, bytes: 0 };
  return Object.assign({ type: "status", ready: true, stale: !!m.stale }, m);
}

/* --------------------------------------------------------------- */
/* lifecycle                                                        */
/* --------------------------------------------------------------- */
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(self.clients.claim()); });

self.addEventListener("message", e => {
  const d = e.data || {};
  const port = e.ports && e.ports[0];
  if (d.type === "precache") e.waitUntil(precache(port));
  else if (d.type === "status") e.waitUntil(status().then(s => port && port.postMessage(s)));
  else if (d.type === "clear") e.waitUntil(clearAll().then(r => port && port.postMessage(r)));
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
