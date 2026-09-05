/* SBMM Site Explorer — FIELD MODE and the field capabilities (docs/V11_SPEC.md §4).

   Two separate things wear the word "field", and keeping them apart is the whole
   design:

     * the FIELD BUILD is a packaging decision — `python tools/build_dist.py
       --field` leaves four payloads out so the file opens on a phone. It is not
       this file's business; `SBMM.isField()` (js/util.js) is how anything asks.
     * FIELD MODE is a UI state. `body.field` is the ONE switch every style and
       behaviour keys off, `SBMM.field.on()` reports it, and `SBMM.events` emits
       `field` when it changes. It turns itself on by itself on a touch device
       with a narrow viewport, and it can be turned on or off anywhere (the
       FIELD command, the switch in the help panel, the More sheet).

   Desktop is untouched when `body.field` is absent. That is not an aspiration —
   it is what test/e2e.mjs proves, unchanged, on both the folder build and the
   full dist.

   Layout, in field mode (§4.3):
     top     a slim bar: the app mark, the current mode, a search button that
             opens the command bar full-width
     stage   the map fills the screen
     bottom  six big actions — Position, Inspect, Raindrop, Photo, Note,
             Layers — and a More sheet for the rest
     docks   Layers / My work / Sheets and Inspector / Results slide up from the
             bottom to 60 % height, one at a time, drag down to dismiss
     popups  the SAME HTML js/popups.js builds, in a full-width bottom card

   Capabilities (§4.4): Position (real geolocation, never fabricated), Photo (a
   new `photo` feature type with a small EXIF reader below), Note (the existing
   `text` feature through a big-button flow) and Samples nearby.

   Three things here are load-bearing and easy to undo by accident:

     * **`photo` is a feature type, built the way `flow` was.** It is rebuilt from
       props by `SBMM.tools.rebuildFeature` and NEVER recomputed, its layer is a
       FeatureGroup rebuilt by `buildPhoto` (so it is special-cased in
       `applyStyle`/`redraw` beside `dim`, `text` and `flow`), and every creation
       pushes an undo entry with BOTH closures.
     * **The "Field" My-work class row is APPENDED** — `SBMM.myWork.classOf`
       reads `CLASSES[4]` as "imported wins" and that index is load-bearing.
     * **A position is never invented.** No geolocation, a refusal, a timeout or
       an error all raise a toast and create nothing; the marker exists only
       while a fix exists. */
"use strict";

SBMM.field = (function () {

  const STORE = "sbmm_field_v1";
  const MAX_EDGE = 1600, JPEG_Q = 0.82, THUMB_EDGE = 160;

  let active = false;
  let built = false;                 // the field chrome exists in the DOM
  let watchId = null, follow = true;
  let posMarker = null, accCircle = null;
  let lastFix = null;                // {x, y, acc_ft, heading, t}
  let popupHook = null;

  /* ================================================================== */
  /* the switch                                                         */
  /* ================================================================== */
  function on() { return active; }

  /* Trigger (§4.3): a coarse pointer AND a narrow viewport at boot. A stored
     preference beats the sniff in both directions — someone who turned it off
     on their tablet meant it, and so did someone who turned it on at a desk. */
  function stored() {
    try { const v = localStorage.getItem(STORE); return v === "1" ? true : v === "0" ? false : null; }
    catch (e) { return null; }
  }
  function remember(v) { try { localStorage.setItem(STORE, v ? "1" : "0"); } catch (e) {} }
  function sniff() {
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    return coarse && window.innerWidth <= 900;
  }
  function autoDetect() {
    const s = stored();
    const want = s == null ? sniff() : s;
    if (want) set(true, { persist: false });
    return want;
  }

  function set(want, opts) {
    opts = opts || {};
    want = !!want;
    if (want === active) return active;
    active = want;
    if (active && !built) buildChrome();
    document.body.classList.toggle("field", active);
    if (!active) { closeSheet(); closeCard(); closeMore(); document.body.classList.remove("fovl"); }
    if (opts.persist !== false) remember(active);
    /* the map, the WebGL canvas and the sheet windows all just changed box */
    if (SBMM.shell) SBMM.shell.relayout();
    if (active) {
      /* §4.3: 3D opens at STANDARD detail on a phone — the high mesh is 1.5 M
         vertices and a phone GPU is not a workstation's */
      const d = document.getElementById("v3dDetail");
      if (d && d.value === "high") { d.value = "std"; d.dispatchEvent(new Event("change")); }
      paintMode();
      hookPopups(true);
    } else {
      hookPopups(false);
    }
    SBMM.events.emit("field", { on: active });
    return active;
  }
  function toggle() { const v = set(!active); toast(v ? "field mode on" : "field mode off"); return v; }

  /* ================================================================== */
  /* the chrome                                                         */
  /* ================================================================== */
  const ACTIONS = [
    ["position", "Position", "i-target", "Where I am — the device GPS, in State Plane feet"],
    ["inspect",  "Inspect",  "i-pin",    "Tap the ground for a point card"],
    ["raindrop", "Raindrop", "i-drop",   "Tap to trace where water runs from there"],
    ["photo",    "Photo",    "i-camera", "Take a photo and place it on the map"],
    ["note",     "Note",     "i-text",   "Tap the map and type a note"],
    ["layers",   "Layers",   "i-layers", "What is drawn"]
  ];
  const MORE = [
    ["distance", "Distance"], ["area", "Area"], ["samples", "Samples nearby"],
    ["sheets", "Sheets"], ["3d", "3D view"], ["mywork", "My work"],
    /* v16: the legend card is hidden on a phone screen by default — there is no
       corner to spare — so this is where it is reachable from */
    ["legend", "Legend"],
    ["results", "Results"], ["help", "Help"], ["lock", "Lock"], ["fieldoff", "Field mode off"]
  ];

  function ic(name) { return `<svg class="ic18"><use href="#${name}"/></svg>`; }

  function buildChrome() {
    built = true;

    const top = document.createElement("div");
    top.id = "fieldTop";
    top.innerHTML =
      `<span class="ftmark">SBMM</span>` +
      `<span class="ftmode" id="fieldModeName">Navigate</span>` +
      `<span class="spacer"></span>` +
      `<button class="ftbtn" id="fieldUndo" title="Undo the last action">${ic("i-undo")}</button>` +
      `<button class="ftbtn" id="fieldSearch" title="Command line">${ic("i-search")}</button>`;
    document.body.appendChild(top);

    const bar = document.createElement("div");
    bar.id = "fieldBar";
    bar.setAttribute("role", "toolbar");
    bar.innerHTML = ACTIONS.map(([k, label, icon, title]) =>
      `<button class="fbtn" data-fa="${k}" title="${esc(title)}">${ic(icon)}<span>${esc(label)}</span></button>`
    ).join("") +
      `<button class="fbtn" data-fa="more" title="Everything else">${ic("i-dots")}<span>More</span></button>`;
    document.body.appendChild(bar);
    bar.addEventListener("click", e => {
      const b = e.target.closest(".fbtn");
      if (b) doAction(b.dataset.fa);
    });

    const more = document.createElement("div");
    more.id = "fieldMore";
    more.hidden = true;
    more.innerHTML = `<div class="fmgrab"></div><div class="fmgrid">` +
      MORE.map(([k, label]) => `<button class="fmbtn" data-fa="${k}">${esc(label)}</button>`).join("") +
      `</div>`;
    document.body.appendChild(more);
    more.addEventListener("click", e => {
      const b = e.target.closest(".fmbtn");
      if (!b) return;
      closeMore();
      doAction(b.dataset.fa);
    });

    const card = document.createElement("div");
    card.id = "fieldCard";
    card.hidden = true;
    card.innerHTML = `<div class="fcgrab"></div><div class="fcbody"></div>`;
    document.body.appendChild(card);

    const scrim = document.createElement("div");
    scrim.id = "fieldScrim";
    scrim.hidden = true;
    scrim.addEventListener("click", () => { closeSheet(); closeMore(); closeCard(); });
    document.body.appendChild(scrim);

    document.getElementById("fieldSearch").onclick = () => SBMM.cmd.open(true);
    document.getElementById("fieldUndo").onclick = () => SBMM.undo.pop();

    /* the docks become bottom sheets; each gets a grab handle that dismisses */
    for (const id of ["leftdock", "rightdock"]) {
      const d = document.getElementById(id);
      if (!d || d.querySelector(".fsgrab")) continue;
      const g = document.createElement("div");
      g.className = "fsgrab";
      d.insertBefore(g, d.firstChild);
      wireDismiss(g, d, closeSheet);
    }
    wireDismiss(more.querySelector(".fmgrab"), more, closeMore);
    wireDismiss(card.querySelector(".fcgrab"), card, closeCard);

    /* the Mode HUD mirrors SBMM.mode; the slim top bar names the same thing */
    SBMM.events.on("mode", paintMode);
  }

  /* drag the grab handle down far enough and the sheet goes away */
  function wireDismiss(grab, panel, shut) {
    if (!grab) return;
    let y0 = null;
    grab.addEventListener("pointerdown", e => {
      y0 = e.clientY;
      try { grab.setPointerCapture(e.pointerId); } catch (err) {}
      panel.classList.add("dragging");
    });
    grab.addEventListener("pointermove", e => {
      if (y0 == null) return;
      const dy = Math.max(0, e.clientY - y0);
      panel.style.transform = `translateY(${dy}px)`;
    });
    const end = e => {
      if (y0 == null) return;
      const dy = Math.max(0, (e.clientY || 0) - y0);
      y0 = null;
      panel.classList.remove("dragging");
      panel.style.transform = "";
      if (dy > 90) shut();
    };
    grab.addEventListener("pointerup", end);
    grab.addEventListener("pointercancel", end);
  }

  function paintMode() {
    const el = document.getElementById("fieldModeName");
    if (el && SBMM.mode) el.textContent = SBMM.mode.label();
  }

  /* ================================================================== */
  /* the bottom sheets                                                  */
  /* ================================================================== */
  /* One at a time — a phone screen has room for exactly one. */
  let sheetOpen = null;
  function openSheet(which) {
    if (!active) return;
    if (sheetOpen === which) { closeSheet(); return; }
    closeMore(); closeCard();
    if (which === "layers" || which === "mywork" || which === "sheets") {
      SBMM.shell.setTab(which === "mywork" ? "features" : which, { expand: false });
      document.body.classList.remove("lcol");
      sheetOpen = "left";
    } else {
      SBMM.shell.setRightTab(which === "results" ? "results" : "inspector", { expand: false });
      document.body.classList.remove("rcol");
      sheetOpen = "right";
    }
    document.body.dataset.fsheet = sheetOpen;
    scrim(true);
    SBMM.shell.relayout();
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = null;
    delete document.body.dataset.fsheet;
    scrim(false);
    if (SBMM.shell) SBMM.shell.relayout();
  }
  function scrim(showIt) {
    const s = document.getElementById("fieldScrim");
    if (s) s.hidden = !showIt;
    syncOverlay();
  }
  /* `body.fovl` = something is up over the map. The Mode HUD hides under it —
     chrome talking over the thing the user just asked for is worse than no
     chrome at all. */
  function syncOverlay() {
    const up = !!sheetOpen
      || !!(document.getElementById("fieldMore") && !document.getElementById("fieldMore").hidden)
      || !!(document.getElementById("fieldCard") && !document.getElementById("fieldCard").hidden);
    document.body.classList.toggle("fovl", up);
  }
  function openMore() { const m = document.getElementById("fieldMore"); if (m) { closeSheet(); closeCard(); m.hidden = false; scrim(true); } }
  function closeMore() {
    const m = document.getElementById("fieldMore");
    if (m && !m.hidden) { m.hidden = true; if (!sheetOpen) scrim(false); else syncOverlay(); }
  }

  /* ================================================================== */
  /* popups become bottom cards                                         */
  /* ================================================================== */
  /* The card carries the SAME string js/popups.js builds — that is the only way
     "the same popup as the desktop" can be a fact about the code rather than a
     claim about two copies. Leaflet still creates the popup; we take its content
     and close it, so every existing bindPopup call site keeps working. */
  function hookPopups(onIt) {
    if (!SBMM.map) return;
    if (onIt && !popupHook) {
      popupHook = e => {
        const p = e.popup;
        /* Leaflet's content can be three things and this has to survive all of
           them: a string, a DOM node, or a FUNCTION (which is what a lazily
           built popup like the photo marker's registers — `getContent()` hands
           back the function itself, not what it returns). */
        let html = p.getContent();
        if (typeof html === "function") { try { html = html(p._source); } catch (err) { html = null; } }
        if (html && typeof html !== "string") html = html.outerHTML || html.innerHTML || null;
        if (!html && p._contentNode) html = p._contentNode.innerHTML;
        SBMM.map.closePopup(p);
        card(html);
      };
      SBMM.map.on("popupopen", popupHook);
    } else if (!onIt && popupHook) {
      SBMM.map.off("popupopen", popupHook);
      popupHook = null;
    }
  }
  /* v17 §5b: Position, Photo, Note and Samples-nearby are reachable in the
     TABLET profile too, through the top bar's Field menu — an iPad with
     cellular has GPS and a camera, and none of that is a phone-only idea. The
     card they answer with has no bottom sheet to live in outside field mode, so
     it goes where every other "what is this" answer goes: the Inspector. Same
     HTML, same builders, one more home. */
  function card(html) {
    if (!html) return null;
    if (!active || !built) {
      const body = document.getElementById("propsBody");
      if (!body) return null;
      body.innerHTML = html;
      if (SBMM.shell) SBMM.shell.setRightTab("inspector");
      return body;
    }
    const c = document.getElementById("fieldCard");
    c.querySelector(".fcbody").innerHTML = html;
    c.hidden = false;
    syncOverlay();
    return c;
  }
  function closeCard() {
    const c = document.getElementById("fieldCard");
    if (c && !c.hidden) { c.hidden = true; c.querySelector(".fcbody").innerHTML = ""; syncOverlay(); }
  }

  /* ================================================================== */
  /* the actions                                                        */
  /* ================================================================== */
  function doAction(k) {
    switch (k) {
      case "position": locate(); break;
      case "inspect": SBMM.mode.set("inspect"); break;
      case "raindrop": SBMM.mode.set("raindrop"); break;
      case "photo": photo(); break;
      case "note": note(); break;
      case "layers": openSheet("layers"); break;
      case "more": openMore(); break;
      case "distance": SBMM.mode.set("measure.distance"); break;
      case "area": SBMM.mode.set("measure.area"); break;
      case "samples": nearbySamples(); break;
      case "sheets": openSheet("sheets"); break;
      case "mywork": openSheet("mywork"); break;
      case "results": openSheet("results"); break;
      case "legend":
        if (!SBMM.layerTree) { toast("no legend in this build"); break; }
        toast(SBMM.layerTree.legend.toggle() ? "legend on" : "legend off");
        break;
      case "3d": SBMM.viewer3d.toggle(); break;
      case "help": { const h = document.getElementById("help"); if (h) h.style.display = "flex"; break; }
      case "lock": if (SBMM.gate) SBMM.gate.lock(); else toast("no password gate in this build"); break;
      case "fieldoff": set(false); toast("field mode off"); break;
      default: toast("nothing wired to " + k);
    }
  }

  /* ================================================================== */
  /* POSITION (§4.4)                                                    */
  /* ================================================================== */
  /* Never fabricate a position. Every way this can fail — no geolocation API,
     a refused permission, a timeout, a position the site affine cannot place —
     ends in a toast and no marker. */
  const NO_GEO = "position is not available in this browser — file:// pages need Chrome with location permission";

  function locate() {
    if (watchId != null) { stopLocate(); toast("position off"); return false; }
    if (!navigator.geolocation || !navigator.geolocation.watchPosition) { toast(NO_GEO, 6000); return false; }
    follow = true;
    let started = false;
    try {
      watchId = navigator.geolocation.watchPosition(p => {
        started = true;
        onFix(p);
      }, err => {
        stopLocate();
        toast(err && err.code === 1
          ? "location permission was refused — nothing is placed on the map"
          : "no position fix" + (err && err.message ? " — " + err.message : ""), 5200);
      }, { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
    } catch (e) { toast(NO_GEO, 6000); return false; }
    /* v17 §5b: the screen must not sleep while someone is walking a site with
       Position on. Feature-detected in js/touch.js and released by stopLocate. */
    if (SBMM.touch && SBMM.touch.keepAwake) SBMM.touch.keepAwake("position", true);
    toast("waiting for a position fix…");
    /* a watch that never calls back is the commonest real failure, and silence
       is the one answer this app must not give */
    setTimeout(() => { if (watchId != null && !started) toast("still waiting for a position fix…", 4000); }, 12000);
    return true;
  }

  function stopLocate() {
    if (SBMM.touch && SBMM.touch.keepAwake) SBMM.touch.keepAwake("position", false);
    if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch (e) {} }
    watchId = null;
    lastFix = null;
    for (const l of [posMarker, accCircle]) if (l) SBMM.map.removeLayer(l);
    posMarker = accCircle = null;
    const b = document.querySelector('#fieldBar .fbtn[data-fa="position"]');
    if (b) b.classList.remove("live");
  }

  const M_TO_USFT = 1 / 0.3048006096012192;

  function onFix(p) {
    const c = p && p.coords;
    if (!c || c.latitude == null) { toast("that fix carried no coordinates"); return; }
    const [x, y] = SBMM.fromLL(c.longitude, c.latitude);
    if (!isFinite(x) || !isFinite(y)) { toast("that position does not convert to this site's grid"); return; }
    const acc = c.accuracy == null ? null : c.accuracy * M_TO_USFT;
    lastFix = { x, y, acc_ft: acc, heading: (c.heading == null || isNaN(c.heading)) ? null : c.heading, t: Date.now() };
    drawFix();
    const b = document.querySelector('#fieldBar .fbtn[data-fa="position"]');
    if (b) b.classList.add("live");
  }

  /* The marker is a divIcon, NOT a circleMarker: the map runs `preferCanvas`,
     so a canvas vector has no DOM element and a `className` on it reaches
     nothing (the same trap that made `.sheetpulse` dead CSS — see CLAUDE.md).
     A real element is also what the pulse animation and the heading arrow need
     somewhere to live. The accuracy circle stays a canvas vector: it is a plain
     filled circle and nothing styles it by class. */
  function drawFix() {
    if (!lastFix || !SBMM.map) return;
    const { x, y, acc_ft, heading } = lastFix;
    const ll = [y, x];
    if (!posMarker) {
      posMarker = L.marker(ll, {
        pane: "drawings", zIndexOffset: 600, keyboard: false,
        icon: L.divIcon({ className: "fixmk", iconSize: [0, 0],
                          html: `<span class="fixhead"></span><span class="fixdot"></span>` })
      }).addTo(SBMM.map);
      posMarker.on("click", () => showFixCard());
    } else posMarker.setLatLng(ll);

    const el = posMarker.getElement();
    if (el) {
      const arrow = el.querySelector(".fixhead");
      if (arrow) {
        arrow.style.display = heading == null ? "none" : "block";
        if (heading != null) arrow.style.transform = `rotate(${heading.toFixed(0)}deg)`;
      }
    }

    if (acc_ft != null && acc_ft > 0) {
      if (!accCircle) accCircle = L.circle(ll, { pane: "drawings", radius: acc_ft, color: "#4FB3CE",
                                                 weight: 1, fillColor: "#4FB3CE", fillOpacity: .10,
                                                 interactive: false }).addTo(SBMM.map);
      else { accCircle.setLatLng(ll); accCircle.setRadius(acc_ft); }
    }
    if (follow) SBMM.map.setView(ll, Math.max(SBMM.map.getZoom(), 2), { animate: false });
  }

  /* The position card, and the FOLLOW toggle §4.4 asks for. It lives here rather
     than on the action bar because "keep the map on me" is a question you ask
     while looking at where you are, and the bar has no room for a seventh
     button that is only meaningful while a fix exists. */
  function showFixCard() {
    const f = lastFix;
    if (!f) { toast("no position fix yet"); return null; }
    const [z, src] = SBMM.elev(f.x, f.y);
    return card(`<b>Device position</b><br>` + SBMM.popups.attrTable([
      ["Easting (ft)", +f.x.toFixed(1)], ["Northing (ft)", +f.y.toFixed(1)],
      ["Ground (ft)", isNaN(z) ? null : +z.toFixed(1)], ["DEM source", src || null],
      ["Accuracy (ft)", f.acc_ft == null ? null : +f.acc_ft.toFixed(0)],
      ["Heading (°)", f.heading == null ? null : Math.round(f.heading)]
    ]) + `<span class="popcoord">WGS84 → State Plane through the site affine (±1 ft)</span>`
      + SBMM.popups.actions(
          SBMM.popups.btn(follow ? "following — tap to stop" : "follow me",
            () => { setFollow(null); toast(follow ? "the map follows you" : "the map stays put"); showFixCard(); },
            "Keep the map centred on the device position")
        + SBMM.popups.btn("drop a marker here",
            () => { const g = SBMM.tools.dropSpot(f.x, f.y);
                    SBMM.undo.push("drop " + (g.name || "spot"),
                      () => SBMM.store.remove(g), () => SBMM.store.readd(g));
                    SBMM.store.select(g.id); closeCard(); },
            "A spot elevation at where you are standing")
        + SBMM.popups.btn("stop", () => { stopLocate(); closeCard(); toast("position off"); },
            "Stop watching the device position")));
  }

  function setFollow(v) { follow = v == null ? !follow : !!v; if (follow) drawFix(); return follow; }
  function fix() { return lastFix ? Object.assign({}, lastFix) : null; }

  /* ================================================================== */
  /* PHOTO (§4.4) — a new store feature type                            */
  /* ================================================================== */
  function photo() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.setAttribute("capture", "environment");
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.addEventListener("change", async () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (!file) { toast("no photo taken"); return; }
      try { await addPhotoFile(file); }
      catch (e) { console.error(e); toast("that photo could not be read: " + e.message, 5000); }
    });
    inp.click();
    return inp;
  }

  /* The whole pipeline, exposed so the harness can drive it with a fixture. */
  async function addPhotoFile(file, opts) {
    opts = opts || {};
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const ex = readExif(u8) || {};
    const shot = await downscale(buf, file.type || "image/jpeg", ex.orientation || 1, jpegSize(u8));

    /* where it goes, in the order §4.4 sets: the EXIF position, then the device
       position, then the user's tap. Never a guess. */
    let x = null, y = null, source = null, acc = null;
    if (opts.at) { x = opts.at[0]; y = opts.at[1]; source = opts.source || "tap"; }
    else if (ex.lat != null && ex.lon != null) {
      const p = SBMM.fromLL(ex.lon, ex.lat);
      if (isFinite(p[0]) && isFinite(p[1])) { x = p[0]; y = p[1]; source = "exif"; }
    }
    if (x == null && lastFix) { x = lastFix.x; y = lastFix.y; source = "device"; acc = lastFix.acc_ft; }
    if (x == null) {
      toast("tap the map where this photo was taken");
      return await new Promise(res => {
        SBMM.draw.beginPick({
          count: 1,
          prompts: ["PHOTO — tap where the photo was taken"],
          onDone: pts => res(place(pts[0][0], pts[0][1], "tap", null)),
          onCancel: () => { toast("photo cancelled — nothing placed"); res(null); }
        });
      });
    }
    return place(x, y, source, acc);

    function place(px, py, src, accFt) {
      const f = mkPhoto([[px, py]], null, {
        img: shot.img, thumb: shot.thumb, taken: ex.taken || null,
        note: opts.note || "", source: src, accuracy_ft: accFt == null ? null : +accFt.toFixed(1),
        w: shot.w, h: shot.h
      });
      SBMM.undo.push("photo " + f.name, () => SBMM.store.remove(f), () => SBMM.store.readd(f));
      SBMM.store.select(f.id);
      SBMM.tools.zoomTo(f);
      toast("photo placed " + (src === "exif" ? "at its EXIF position"
        : src === "device" ? "at the device position" : "where you tapped"));
      return f;
    }
  }

  /* Downscale to <= MAX_EDGE on the long edge at JPEG_Q, and a <= THUMB_EDGE
     thumbnail beside it. The EXIF orientation is BAKED IN here, so nothing
     downstream — the marker, the popup, the 3D sprite, the export — has to know
     about it. */
  async function downscale(buf, type, orient, raw) {
    /* `imageOrientation: "none"` asks the decoder to hand back the pixels as
       stored, because this function applies the EXIF rotation itself. A decoder
       that ignores the option (or does not have it) applies the rotation first,
       and applying it twice is how a portrait photo comes out landscape and
       upside down — so if the bitmap does not match the size in the JPEG's own
       SOF header, the rotation has already happened and there is nothing left
       to do. */
    let bmp;
    try { bmp = await createImageBitmap(new Blob([buf], { type }), { imageOrientation: "none" }); }
    catch (e) { bmp = await createImageBitmap(new Blob([buf], { type })); }
    if (raw && raw.w && (bmp.width !== raw.w || bmp.height !== raw.h)) orient = 1;
    const swap = orient >= 5 && orient <= 8;
    const sw = swap ? bmp.height : bmp.width, sh = swap ? bmp.width : bmp.height;
    const draw = (edge, q) => {
      const k = Math.min(1, edge / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.save();
      /* the eight EXIF orientations, as the transform that undoes each */
      const T = {
        1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h],
        4: [1, 0, 0, -1, 0, h], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, w, 0],
        7: [0, -1, -1, 0, w, h], 8: [0, -1, 1, 0, 0, h]
      }[orient] || [1, 0, 0, 1, 0, 0];
      g.transform(T[0], T[1], T[2], T[3], T[4], T[5]);
      g.drawImage(bmp, 0, 0, swap ? h : w, swap ? w : h);
      g.restore();
      return { url: c.toDataURL("image/jpeg", q), w, h };
    };
    const full = draw(MAX_EDGE, JPEG_Q);
    const th = draw(THUMB_EDGE, 0.7);
    if (bmp.close) bmp.close();
    return { img: full.url, thumb: th.url, w: full.w, h: full.h };
  }

  /* ---- the feature ---- */
  function normPhoto(props, pts) {
    const p = Object.assign({}, props || {});
    if (!p.source) p.source = "tap";
    if (p.note == null) p.note = "";
    if (p.thumb == null && p.img) p.thumb = p.img;      // an import may carry only one
    return p;
  }

  /* the rebuildFeature hook — rebuilt from props, NEVER recomputed (a session or
     an import must not go looking for a camera) */
  function mkPhoto(pts, name, props, spec) {
    const f = SBMM.tools.newFeature("photo", pts.map(q => q.slice()),
      name || SBMM.tools.nextName("Photo"),
      { group: (spec && spec.group) || "Field", style: spec && spec.style, locked: spec && spec.locked });
    f.props = normPhoto(props, f.pts);
    buildPhoto(f);
    f.card = SBMM.results.card(f, f.name, photoRows(f));
    return f;
  }
  function photoRows(f) {
    const p = f.props || {};
    const [z] = SBMM.elev(f.pts[0][0], f.pts[0][1]);
    return [
      ["Placed", placedWord(p.source)],
      ["Taken", p.taken || "—"],
      ["Ground", isNaN(z) ? "—" : fmt(z, 1) + " ft"],
      ["SP E / N", fmt0(f.pts[0][0]) + " / " + fmt0(f.pts[0][1])]
    ];
  }
  function placedWord(s) {
    return s === "exif" ? "from the photo's own GPS tag"
      : s === "device" ? "at the device position" : "tapped on the map";
  }

  /* The layer is a FeatureGroup rebuilt on geometry / style / selection change —
     the same shape dim, text and flow use, which is why `photo` is special-cased
     in js/tools.js applyStyle and redraw. */
  function buildPhoto(f) {
    const g = f.layer;
    if (!g || !g.clearLayers) return;
    g.clearLayers();
    const p = f.props || {};
    const [x, y] = f.pts[0];
    const sel = SBMM.store.selected === f.id;
    const src = p.thumb || p.img || "";
    const mk = L.marker([y, x], {
      pane: "drawings", zIndexOffset: 350, keyboard: false,
      icon: L.divIcon({
        className: "photomk" + (sel ? " sel" : ""), iconSize: [46, 46], iconAnchor: [23, 46],
        html: `<span class="pmframe">${src ? `<img alt="" src="${src}">` : `<span class="pmno">no image</span>`}</span><span class="pmpin"></span>`
      })
    });
    mk.bindTooltip(f.name || "Photo", { direction: "top", className: "ctip", offset: [0, -48] });
    mk.bindPopup(() => SBMM.popups.forFeature(f), { className: "photopop", maxWidth: 330, autoPan: true });
    mk.addTo(g);
  }

  /* the popup body §4.4 asks for — the image full width, then the note and how
     it was placed. js/popups.js `forFeature` calls this so 2D, 3D and the field
     card all show one thing. */
  function popupBody(f) {
    const p = f.props || {};
    let h = "";
    if (p.img) h += `<div class="photofull"><img alt="${esc(f.name || "photo")}" src="${p.img}"></div>`;
    if (p.note) h += `<div class="photonote">${esc(p.note)}</div>`;
    h += SBMM.popups.attrTable([
      ["Taken", p.taken || null],
      ["Placed", placedWord(p.source)],
      ["Accuracy (ft)", p.accuracy_ft == null ? null : p.accuracy_ft]
    ]);
    return h;
  }

  /* ================================================================== */
  /* NOTE (§4.4)                                                        */
  /* ================================================================== */
  /* The existing `text` feature, through a big-button flow: type it, then tap —
     or take the device position and skip the tap. */
  function note() {
    ask("Note", "", txt => {
      if (!txt) { toast("note cancelled"); return; }
      const finish = (x, y) => {
        const f = SBMM.tools.mkText([[x, y]], txt);
        SBMM.undo.push("note", () => SBMM.store.remove(f), () => SBMM.store.readd(f));
        SBMM.store.select(f.id);
        toast("note placed");
      };
      if (lastFix) { finish(lastFix.x, lastFix.y); return; }
      toast("tap the map where the note goes");
      SBMM.draw.beginPick({
        count: 1,
        prompts: ["NOTE — tap where the note goes"],
        onDone: pts => finish(pts[0][0], pts[0][1]),
        onCancel: () => toast("note cancelled")
      });
    });
  }

  /* One big-target prompt, used by NOTE and by the photo-export question. It is
     a promise-free callback so it reads the same as SBMM.cmd.ask. */
  function ask(title, initial, done) {
    const box = document.createElement("div");
    box.className = "modal fmodal";
    box.innerHTML = `<div class="mbox fask">
      <div class="mhd">${esc(title)}<span class="spacer"></span><span class="ic x" id="fkX">✕</span></div>
      <div class="mbody"><textarea id="fkIn" rows="3" spellcheck="true"></textarea></div>
      <div class="mfoot"><button class="minib" id="fkNo">Cancel</button>
        <button class="minib pri" id="fkOk">Done</button></div></div>`;
    document.body.appendChild(box);
    const ta = box.querySelector("#fkIn");
    ta.value = initial || "";
    setTimeout(() => ta.focus(), 30);
    const shut = v => { document.removeEventListener("keydown", key, true); box.remove(); done(v); };
    const key = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(null); } };
    document.addEventListener("keydown", key, true);
    box.querySelector("#fkX").onclick = () => shut(null);
    box.querySelector("#fkNo").onclick = () => shut(null);
    box.querySelector("#fkOk").onclick = () => shut(ta.value.trim());
    box.addEventListener("click", e => { if (e.target === box) shut(null); });
    return box;
  }

  /* The GeoJSON question of §4.4: the points always go out; the images only if
     asked for, because twenty photos is twenty megabytes in a file somebody
     will try to open in ArcGIS. */
  function askPhotoExport(n) {
    return new Promise(res => {
      const box = document.createElement("div");
      box.className = "modal fmodal";
      box.id = "photoExportAsk";
      box.innerHTML = `<div class="mbox fask">
        <div class="mhd">Export ${n} photo${n === 1 ? "" : "s"}<span class="spacer"></span><span class="ic x" id="peX">✕</span></div>
        <div class="mbody"><label class="chk"><input type="checkbox" id="peImg"> include the images in the file</label>
          <div class="mut" style="margin-top:6px">Location, time, note and how each photo was placed always go out.
            The images are base64 inside the GeoJSON — a big file, and most GIS tools ignore it.</div></div>
        <div class="mfoot"><button class="minib" id="peNo">Cancel</button>
          <button class="minib pri" id="peOk">Export</button></div></div>`;
      document.body.appendChild(box);
      const shut = v => { box.remove(); res(v); };
      box.querySelector("#peX").onclick = () => shut(null);
      box.querySelector("#peNo").onclick = () => shut(null);
      box.querySelector("#peOk").onclick = () => shut({ images: box.querySelector("#peImg").checked });
    });
  }

  /* ================================================================== */
  /* SAMPLES NEARBY (§4.4)                                              */
  /* ================================================================== */
  function nearbySamples(n) {
    n = n || 20;
    const pts = (SBMM.samples || (window.SBMM_DATA && SBMM_DATA.points) || []).filter(p => p.x != null);
    if (!pts.length) { toast("no sample locations in this build"); return null; }
    const at = lastFix || centreOfMap();
    if (!at) { toast("no position yet — tap Position first, or pan the map"); return null; }
    const near = pts.map(p => Object.assign({ d: Math.hypot(p.x - at.x, p.y - at.y) }, p))
      .sort((a, b) => a.d - b.d).slice(0, n);
    const rows = near.map(p => `<div class="fnrow" data-x="${p.x}" data-y="${p.y}">
        <b>${esc(p.id)}</b><span class="mono">${fmt0(p.d)} ft</span>
        <span class="mut">Hg ${p.Hg == null ? "—" : p.Hg} · As ${p.As == null ? "—" : p.As}</span>
        ${p.exc ? '<span class="warnpill">exceeds</span>' : ""}</div>`).join("");
    const c = card(`<b>${near.length} nearest sample locations</b>
      <div class="mut">from ${lastFix ? "the device position" : "the centre of the map"}</div>
      <div class="fnlist">${rows}</div>`);
    if (c) c.addEventListener("click", e => {
      const r = e.target.closest(".fnrow");
      if (!r) return;
      SBMM.map.setView([+r.dataset.y, +r.dataset.x], Math.max(SBMM.map.getZoom(), 3));
      closeCard();
    }, { once: true });
    return near;
  }
  function centreOfMap() {
    if (!SBMM.map) return null;
    const c = SBMM.map.getCenter();
    return { x: c.lng, y: c.lat };
  }

  /* ================================================================== */
  /* EXIF — a small reader, no library (§4.4)                           */
  /* ================================================================== */
  /* Reads exactly what §4.4 asks for out of a JPEG's APP1 segment:
     Orientation (IFD0 0x0112), DateTimeOriginal (Exif IFD 0x9003) and the GPS
     IFD's latitude / longitude with their hemisphere refs. Anything it does not
     understand it skips; a file with no APP1, a truncated one, or a TIFF header
     that does not say II/MM returns null rather than throwing. */
  /* The width and height the JPEG itself declares, from the frame header — the
     size BEFORE any EXIF rotation. Used only to tell whether the decoder has
     already applied that rotation (see downscale). */
  function jpegSize(u8) {
    try {
      if (!u8 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
      let i = 2;
      while (i + 9 <= u8.length) {
        if (u8[i] !== 0xFF) { i++; continue; }
        const m = u8[i + 1];
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        if (m === 0xDA || m === 0xD9) return null;
        /* SOF0..SOF15, minus the three that are not frame headers */
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
          return { h: (u8[i + 5] << 8) | u8[i + 6], w: (u8[i + 7] << 8) | u8[i + 8] };
        i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
      }
      return null;
    } catch (e) { return null; }
  }

  function readExif(u8) {
    try {
      if (!u8 || u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;   // not a JPEG
      let i = 2;
      while (i + 4 <= u8.length) {
        if (u8[i] !== 0xFF) { i++; continue; }
        const marker = u8[i + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        if (marker === 0xDA || marker === 0xD9) return null;                        // image data — no APP1
        const len = (u8[i + 2] << 8) | u8[i + 3];
        if (len < 2) return null;
        if (marker === 0xE1 && i + 4 + 6 <= u8.length
            && u8[i + 4] === 0x45 && u8[i + 5] === 0x78 && u8[i + 6] === 0x69 && u8[i + 7] === 0x66)
          return readTiff(u8, i + 10);                                              // "Exif\0\0" then TIFF
        i += 2 + len;
      }
      return null;
    } catch (e) { return null; }
  }

  function readTiff(u8, base) {
    if (base + 8 > u8.length) return null;
    const le = u8[base] === 0x49 && u8[base + 1] === 0x49;
    const be = u8[base] === 0x4D && u8[base + 1] === 0x4D;
    if (!le && !be) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const u16 = o => dv.getUint16(o, le);
    const u32 = o => dv.getUint32(o, le);
    if (u16(base + 2) !== 42) return null;
    const ifd0 = base + u32(base + 4);
    const out = { orientation: 1, taken: null, lat: null, lon: null };

    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    function entries(off, fn) {
      if (off + 2 > u8.length) return;
      const n = u16(off);
      for (let k = 0; k < n; k++) {
        const e = off + 2 + k * 12;
        if (e + 12 > u8.length) return;
        const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        const bytes = (SIZE[type] || 1) * cnt;
        const at = bytes <= 4 ? e + 8 : base + u32(e + 8);
        fn(tag, type, cnt, at, bytes);
      }
    }
    const ascii = (at, cnt) => {
      let s = "";
      for (let k = 0; k < cnt && at + k < u8.length; k++) {
        const c = u8[at + k];
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    };
    const rat = at => {
      const num = u32(at), den = u32(at + 4);
      return den ? num / den : 0;
    };
    const dms = (at, cnt) => {
      if (cnt < 3) return null;
      return rat(at) + rat(at + 8) / 60 + rat(at + 16) / 3600;
    };

    let exifOff = 0, gpsOff = 0;
    entries(ifd0, (tag, type, cnt, at) => {
      if (tag === 0x0112) out.orientation = u16(at) || 1;
      else if (tag === 0x8769) exifOff = base + u32(at);
      else if (tag === 0x8825) gpsOff = base + u32(at);
    });
    if (exifOff) entries(exifOff, (tag, type, cnt, at) => {
      if (tag === 0x9003 || (tag === 0x0132 && !out.taken)) out.taken = normDate(ascii(at, cnt));
    });
    if (gpsOff) {
      let latRef = "N", lonRef = "E", lat = null, lon = null;
      entries(gpsOff, (tag, type, cnt, at) => {
        if (tag === 1) latRef = ascii(at, cnt) || "N";
        else if (tag === 2) lat = dms(at, cnt);
        else if (tag === 3) lonRef = ascii(at, cnt) || "E";
        else if (tag === 4) lon = dms(at, cnt);
      });
      if (lat != null && lon != null) {
        out.lat = /S/i.test(latRef) ? -lat : lat;
        out.lon = /W/i.test(lonRef) ? -lon : lon;
      }
    }
    return out;
  }
  /* EXIF writes "2026:09:04 11:22:33"; everything else in the app writes ISO */
  function normDate(s) {
    if (!s) return null;
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : s;
  }

  /* ================================================================== */
  function wire() {
    /* the help panel's switch (§4.3) */
    const h = document.getElementById("fieldSwitch");
    if (h) {
      h.checked = active;
      h.onchange = () => set(h.checked);
      SBMM.events.on("field", e => { h.checked = e.on; });
    }
    /* the map is only there to hook once it exists */
    if (active) hookPopups(true);

    /* Esc reaches the FRONT-MOST thing (CLAUDE.md): a bottom card or a sheet is
       in front of the map, so it goes first and the event stops there rather
       than also cancelling a sketch behind it. Capture phase, ahead of
       js/mode.js's bubble-phase Esc — and it does nothing at all unless field
       mode is on and something is actually up. */
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !active) return;
      const more = document.getElementById("fieldMore");
      const card = document.getElementById("fieldCard");
      if (more && !more.hidden) { closeMore(); e.stopPropagation(); e.preventDefault(); return; }
      if (card && !card.hidden) { closeCard(); e.stopPropagation(); e.preventDefault(); return; }
      if (sheetOpen) { closeSheet(); e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  return {
    wire, autoDetect, on, set, toggle, sniff,
    /* v17: js/touch.js follows the viewport across the phone/tablet line, but
       only where the user has expressed no preference — a stored choice is a
       decision and an orientation change must not overrule it */
    stored,
    /* position */
    locate, stopLocate, setFollow, following: () => follow, fix, watching: () => watchId != null,
    showFixCard,
    /* what is actually on the map right now — the harness asks this because the
       accuracy circle is a canvas vector with no DOM element to count */
    markers: () => ({ dot: !!posMarker, accuracy_ft: accCircle ? accCircle.getRadius() : null,
                      inCircle: !!(posMarker && accCircle) }),
    /* photo + note */
    photo, addPhotoFile, mkPhoto, buildPhoto, popupBody, photoRows, placedWord,
    note, ask, askPhotoExport, downscale,
    /* samples + chrome */
    nearbySamples, card, closeCard, openSheet, closeSheet, openMore, closeMore,
    sheetOpen: () => sheetOpen,
    /* exif */
    readExif, jpegSize,
    ACTIONS, MORE
  };
})();
