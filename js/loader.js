/* SBMM Site Explorer — the loading screen (v31).

   Before this the screen said "Loading terrain…" from the first byte to the
   last, in plain HTML that no code could touch until ~140 MB of payloads had
   downloaded and parsed — so a slow connection, a stalled one and a broken one
   all looked exactly alike. This file is the SECOND script in the page (right
   after js/gate.js), so it runs before anything heavy has arrived, and it
   reports what is really happening:

     1. the download — every script the page loads is in SIZES below, in page
        order, with its byte size (tools/stamp_sizes.py writes the block), so
        the bar is real megabytes, the rate is measured and the file on its way
        is named. Each one is seen arriving through the Resource Timing API and
        through its own `load` event (captured on document: a resource event
        does not bubble, and a load event never reaches window). Over file://
        the same rows are "reading"; in a single-file dist there is one file
        and the perf marks between its inline scripts say how far the parse
        has got.
     2. the payload check, 3. the four terrain grids decoding in their workers
        (each ticks with its own time, and the site grid is DRAWN as soon as it
        exists — the relief on the plate is the real ground, hillshaded and
        contoured here from a decimated read of the 2-ft DEM), 4. building the
        workbench — driven by js/boot.js through SBMM.loader.
     5. what is wrong, when something is: a file that failed (and its retry), a
        download that has gone quiet for longer than its size and the measured
        rate explain, or the boot's own "couldn't start" — each with Reload and
        Copy diagnostics.

   The password gate sits ABOVE this (z 9000 against 3000), and the payloads
   keep downloading underneath it while the password is typed. So the gate card
   carries a one-line copy of the progress (#gateLoad), and after an unlock the
   gate's reveal uncovers this screen only if the work is not finished yet.

   It never slows what it reports on: the background field draws at most ~24
   frames a second, not at all while the tab is hidden, and once under reduced
   motion; the relief is decimated to the plate's pixels; the plate's reveal is
   a transform (composited, so it moves even while the main thread parses).
   After boot it becomes a small chip that follows the deferred payloads
   (js/payloads.js) and goes away when they are in. */
(function () {
  "use strict";
  var SBMM = window.SBMM = window.SBMM || {};

  /* tools/stamp_sizes.py rewrites everything between the markers */
  /* SBMM_SIZES_BEGIN */
  var SIZES = [
    ["js/gate.js",33844,""],
    ["js/touch.js",62268,""],
    ["vendor/leaflet.js",147552,""],
    ["vendor/d3-delaunay.min.js",19071,""],
    ["vendor/three.bundle.js",676986,""],
    ["datajs/d_affine.js",206,""],
    ["datajs/tiles/index.js",42276,""],
    ["datajs/d_dem_site.js",148,""],
    ["datajs/d_dem_abp.js",147,""],
    ["datajs/d_dem_res.js",147,""],
    ["datajs/d_contours_site.js",848366,""],
    ["datajs/d_contours_abp.js",290984,""],
    ["datajs/d_dus.js",4240,""],
    ["datajs/d_piles.js",123872,""],
    ["datajs/d_points.js",16887,""],
    ["datajs/d_design_ea.js",126914,""],
    ["datajs/d_design_gis.js",486628,""],
    ["datajs/d_survey_2026.js",38714,""],
    ["datajs/d_storm_network.js",31383,""],
    ["datajs/d_rainfall.js",1816,""],
    ["datajs/d_cover.js",2874,""],
    ["datajs/i_cover_png.js",1238559,""],
    ["datajs/w_kernels.js",155759,""],
    ["datajs/d_ortho_abp.js",136,""],
    ["datajs/d_ortho_mine.js",125,""],
    ["datajs/d_ortho_site.js",137,""],
    ["datajs/i_dem_site_png.js",14024326,""],
    ["datajs/i_dem_abp_png.js",6991713,""],
    ["datajs/i_dem_res_png.js",3379841,""],
    ["datajs/i_hs_site_jpg.js",2715102,""],
    ["datajs/i_hs_abp_jpg.js",1995141,""],
    ["datajs/i_ortho_abp_jpg.js",1837724,""],
    ["datajs/i_ortho_mine_jpg.js",10849165,""],
    ["datajs/i_ortho_site_jpg.js",6900161,""],
    ["datajs/i_design_C102_png.js",1626253,""],
    ["datajs/i_design_C103_png.js",736141,""],
    ["datajs/i_design_C104_png.js",915349,""],
    ["datajs/i_design_C105_png.js",711893,""],
    ["datajs/i_design_C106_png.js",413785,""],
    ["datajs/i_design_C107_png.js",648309,""],
    ["datajs/i_design_C108_png.js",1536257,""],
    ["datajs/i_design_C109_png.js",1476377,""],
    ["datajs/i_design_C110_png.js",811161,""],
    ["datajs/i_design_C111_png.js",1512657,""],
    ["datajs/i_design_C112_png.js",917129,""],
    ["datajs/i_design_C201_png.js",1490945,""],
    ["datajs/i_design_C202_png.js",783581,""],
    ["datajs/i_design_C203_png.js",4409797,""],
    ["datajs/d_chm.js",140,"h"],
    ["datajs/i_chm_png.js",7170065,"h"],
    ["datajs/d_cad_native.js",836449,"h"],
    ["datajs/d_cad_native_lazy.js",21285369,"d"],
    ["datajs/d_cad_surfaces.js",18878,"h"],
    ["datajs/d_cad_surfaces_rasters.js",11310540,"d"],
    ["datajs/i_sheet_full_C101_jpg.js",1497810,"d"],
    ["datajs/i_sheet_full_C102_jpg.js",1603966,"d"],
    ["datajs/i_sheet_full_C103_jpg.js",1303202,"d"],
    ["datajs/i_sheet_full_C104_jpg.js",1628778,"d"],
    ["datajs/i_sheet_full_C105_jpg.js",1625686,"d"],
    ["datajs/i_sheet_full_C106_jpg.js",1380206,"d"],
    ["datajs/i_sheet_full_C107_jpg.js",1286934,"d"],
    ["datajs/i_sheet_full_C108_jpg.js",1665902,"d"],
    ["datajs/i_sheet_full_C109_jpg.js",1541234,"d"],
    ["datajs/i_sheet_full_C110_jpg.js",1450586,"d"],
    ["datajs/i_sheet_full_C111_jpg.js",1626566,"d"],
    ["datajs/i_sheet_full_C112_jpg.js",1583194,"d"],
    ["datajs/i_sheet_full_C201_jpg.js",1544030,"d"],
    ["datajs/i_sheet_full_C202_jpg.js",1509090,"d"],
    ["datajs/i_sheet_full_C203_jpg.js",1654262,"d"],
    ["datajs/i_sheet_full_C501_jpg.js",812454,"d"],
    ["datajs/i_sheet_full_C502_jpg.js",758194,"d"],
    ["datajs/i_sheet_full_C503_jpg.js",1037450,"d"],
    ["datajs/i_sheet_full_G001_jpg.js",596014,"d"],
    ["datajs/i_sheet_full_G002_jpg.js",861174,"d"],
    ["datajs/d_sheets_full.js",11970,""],
    ["datajs/d_datasets.js",158936,""],
    ["datajs/d_borings_logs.js",306668,""],
    ["datajs/d_lab_metals.js",122263,""],
    ["datajs/d_site_areas.js",3529,""],
    ["datajs/d_cultural.js",432634,""],
    ["js/compute.js",257925,""],
    ["js/util.js",11001,""],
    ["js/payloads.js",6772,""],
    ["js/jobs.js",17433,""],
    ["js/dem.js",30020,""],
    ["js/tiles.js",18195,""],
    ["js/proj.js",1236,""],
    ["js/state.js",15337,""],
    ["js/layerstate.js",12097,""],
    ["js/view.js",5321,""],
    ["js/popups.js",37509,""],
    ["js/watermark.js",5987,""],
    ["js/shell.js",19985,""],
    ["js/map.js",16513,""],
    ["js/labels.js",10220,""],
    ["js/pick2d.js",27134,""],
    ["js/backdrop.js",14733,""],
    ["js/layertree.js",59684,""],
    ["js/layers.js",29910,""],
    ["js/layerpanel.js",16982,""],
    ["js/cartography.js",11446,""],
    ["js/designea.js",21994,""],
    ["js/designgis.js",18717,""],
    ["js/survey.js",6186,""],
    ["js/siteareas.js",3382,""],
    ["js/cadnative.js",27515,""],
    ["js/sheets.js",32327,""],
    ["js/datasets.js",30460,""],
    ["js/borelogs.js",82524,""],
    ["js/labmetals.js",7981,""],
    ["js/borewin.js",88545,""],
    ["js/fence.js",56048,""],
    ["js/cultural.js",16482,""],
    ["js/analysis.js",8766,""],
    ["js/snap.js",22407,""],
    ["js/draw.js",25784,""],
    ["js/results.js",4505,""],
    ["js/tools.js",71758,""],
    ["js/cmdline.js",28979,""],
    ["js/omni.js",25643,""],
    ["js/dxf.js",24702,""],
    ["js/design.js",28301,""],
    ["js/sections.js",24708,""],
    ["js/report.js",46585,""],
    ["js/smartbound.js",24411,""],
    ["js/trees.js",15576,""],
    ["js/features.js",26208,""],
    ["js/io.js",13588,""],
    ["js/table.js",10481,""],
    ["js/terrain3d.js",48254,""],
    ["js/viewer3d.js",249560,""],
    ["js/pick3d.js",34123,""],
    ["js/sheetmarks.js",35474,""],
    ["js/redline.js",14317,""],
    ["js/mode.js",23732,""],
    ["js/layerman.js",10162,""],
    ["js/isopach.js",19514,""],
    ["js/storm.js",27628,""],
    ["js/water.js",121196,""],
    ["js/drainage.js",33616,""],
    ["js/runoff.js",61931,""],
    ["js/accum.js",26110,""],
    ["js/pipes.js",15903,""],
    ["js/scenarios.js",22564,""],
    ["js/wherewater.js",28944,""],
    ["js/refsurf.js",11474,""],
    ["js/sheetcards.js",7911,""],
    ["js/home.js",24679,""],
    ["js/field.js",44926,""],
    ["js/boot.js",15920,""]
  ];
  /* SBMM_SIZES_END */

  var SINGLE = !!window.SBMM_SINGLE_FILE;
  var LOCALFILE = location.protocol === "file:";
  var REDUCE = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* ---------------------------------------------------------------- */
  /* the download                                                      */
  /* ---------------------------------------------------------------- */
  var sizeOf = {}, order = [];
  SIZES.forEach(function (r) { sizeOf[r[0]] = r; order.push(r[0]); });
  var seen = {};                 // path -> ms it arrived
  var firstAt = 0, lastAt = 0;
  var failed = [];               // paths whose tag fired `error`

  function expected(path) {
    var r = sizeOf[path];
    if (!r) return false;
    if (r[2] === "d") return false;                          // after boot (js/payloads.js)
    if (r[2] === "h" && window.SBMM_HEAVY_SKIPPED === true) return false;   // a phone
    return true;
  }
  function pathOf(url) {
    try {
      var u = new URL(url, location.href);
      if (u.protocol === "data:" || u.protocol === "blob:") return null;
      var base = new URL(".", location.href).href;
      var s = u.href.split("?")[0].split("#")[0];
      return s.indexOf(base) === 0 ? decodeURI(s.slice(base.length)) : null;
    } catch (e) { return null; }
  }
  function arrive(path, t) {
    if (!path || seen[path] || !sizeOf[path] || failed.indexOf(path) >= 0) return;
    seen[path] = t || performance.now();
    if (!firstAt) firstAt = seen[path];
    lastAt = performance.now();
    schedule();
  }
  function totals() {
    var all = 0, got = 0, n = 0, k = 0;
    for (var i = 0; i < order.length; i++) {
      var p = order[i];
      if (!expected(p)) continue;
      all += sizeOf[p][1]; n++;
      if (seen[p]) { got += sizeOf[p][1]; k++; }
    }
    return { all: all, got: got, n: n, k: k };
  }
  /* bytes per second, averaged since the page started. A windowed rate is
     bursty here — the bytes of a 14 MB file are credited the moment it lands —
     and the average is what an ETA should be built on. */
  function rate() {
    if (!lastAt) return 0;
    return totals().got / Math.max(0.5, lastAt / 1000);
  }
  /* the first expected file, in page order, that has not arrived */
  function waitingOn() {
    for (var i = 0; i < order.length; i++)
      if (expected(order[i]) && !seen[order[i]]) return order[i];
    return null;
  }

  try {
    if (window.PerformanceObserver) {
      var po = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.initiatorType !== "script") return;
          /* a 404 is a resource entry too — it has not arrived, it has failed */
          if (e.responseStatus >= 400) return;
          arrive(pathOf(e.name), e.responseEnd || performance.now());
        });
      });
      po.observe({ type: "resource", buffered: true });
    }
  } catch (e) { /* the load events below are enough */ }
  /* on DOCUMENT, not window: an element's `load` stops at the document (the
     spec gives a load event no parent past it), so a capture listener on
     window never hears one — and over file:// there are no Resource Timing
     entries either, so this is the only signal a local copy gives */
  document.addEventListener("load", function (e) {
    var t = e && e.target;
    if (t && t.tagName === "SCRIPT" && t.src) arrive(pathOf(t.src));
  }, true);
  /* the scripts ahead of this one (js/gate.js) have run, so they arrived */
  try {
    for (var si = 0; si < document.scripts.length; si++)
      if (document.scripts[si].src) arrive(pathOf(document.scripts[si].src));
  } catch (e) {}
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (t && t.tagName === "SCRIPT" && t.src) {
      var p = pathOf(t.src);
      if (p && failed.indexOf(p) < 0) failed.push(p);
      if (p && seen[p]) delete seen[p];      // the resource entry may have come first
      schedule();
    }
  }, true);

  /* the names a person reads; anything else is "app code" or its file name */
  function nameOf(path) {
    if (!path) return "";
    var b = path.replace(/^.*\//, "").replace(/\.js$/, "");
    var N = {
      "leaflet": "map engine", "three.bundle": "3D engine", "d3-delaunay.min": "triangulation library",
      "i_dem_site_png": "site terrain · 2 ft", "i_dem_abp_png": "mine-area terrain · 1 ft",
      "i_dem_res_png": "residential terrain · 1 ft", "i_chm_png": "canopy model",
      "i_ortho_mine_jpg": "mine-area aerial · 6 in", "i_ortho_site_jpg": "site aerial · 1.5 ft",
      "i_ortho_abp_jpg": "ABP aerial · 3 in", "i_hs_site_jpg": "site hillshade",
      "i_hs_abp_jpg": "mine-area hillshade", "d_cad_native": "EA CAD", "d_cad_surfaces": "EA design surfaces",
      "d_contours_site": "survey contours", "d_contours_abp": "survey contours · 2 ft",
      "d_datasets": "datasets", "w_kernels": "compute core", "d_borings_logs": "boring logs",
      "d_design_gis": "EA design GIS", "d_design_ea": "EA sheet registrations", "d_cultural": "cultural layer",
      "i_cover_png": "land cover", "d_storm_network": "storm network", "d_lab_metals": "lab metals"
    };
    if (N[b]) return N[b];
    var m = /^i_design_(C\d+)_png$/.exec(b);
    if (m) return "EA sheet " + m[1].replace("C", "C-");
    if (/^js\//.test(path)) return "app code";
    return b.replace(/^[di]_/, "").replace(/_/g, " ");
  }
  function mb(b) { return b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " kB"; }
  function secs(s) { return s < 60 ? Math.max(1, Math.round(s)) + " s" : Math.floor(s / 60) + " min " + Math.round(s % 60) + " s"; }

  /* ---------------------------------------------------------------- */
  /* the stages                                                         */
  /* ---------------------------------------------------------------- */
  var STAGES = [
    { id: "net",     name: SINGLE || LOCALFILE ? "Read the files" : "Download", w: SINGLE ? 0.30 : LOCALFILE ? 0.35 : 0.70 },
    { id: "check",   name: "Check the data", w: 0.02 },
    { id: "terrain", name: "Decode the terrain", w: SINGLE || LOCALFILE ? 0.35 : 0.16 },
    { id: "build",   name: "Build the workbench", w: SINGLE || LOCALFILE ? 0.28 : 0.12 }
  ];
  var state = { net: "active", check: "wait", terrain: "wait", build: "wait" };
  var frac = { net: 0, check: 0, terrain: 0, build: 0 };
  var detail = { net: "", check: "", terrain: "", build: "" };
  var DEMS = [["dem_site", "site 2 ft"], ["dem_abp", "mine 1 ft"], ["dem_res", "residential 1 ft"], ["chm", "canopy"]];
  var dems = {};                 // name -> {ms, worker} | "skip"
  var demWant = 4;
  var phase = "load";            // load | done | failed
  var warnKind = null, warnText = "";
  var tStart = performance.now(), doneAt = 0;
  var BUILD_MARKS = ["wire-shell", "init-map", "build-layers", "wire-modules", "boot-done"];
  var READ_MARKS = ["vendor-js", "data-vectors", "data-rasters", "data-design-png", "data-sheet-jpg", "app-js"];

  function markSeen(name) {
    var m = window.SBMM_PERF && SBMM_PERF.marks;
    if (!m) return false;
    for (var i = 0; i < m.length; i++) if (m[i][0] === name) return true;
    return false;
  }

  function overall() {
    var p = 0;
    for (var i = 0; i < STAGES.length; i++) {
      var s = STAGES[i], f = state[s.id] === "done" ? 1 : state[s.id] === "wait" ? 0 : frac[s.id];
      p += s.w * Math.max(0, Math.min(1, f));
    }
    return Math.max(0, Math.min(1, p));
  }

  /* ---------------------------------------------------------------- */
  /* the DOM                                                            */
  /* ---------------------------------------------------------------- */
  var root = null, els = {}, built = false;
  var ICON_OK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8"/></svg>';
  var ICON_WARN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.2v4.6M8 11.2v.4"/></svg>';

  function buildDom() {
    root = document.getElementById("loading");
    if (!root) return false;
    built = true;
    root.classList.add("ldv31");
    root.setAttribute("aria-busy", "true");
    var stages = STAGES.map(function (s) {
      return '<li class="ldst" data-st="' + s.id + '" data-state="' + state[s.id] + '">' +
        '<span class="ldic" aria-hidden="true"></span>' +
        '<span class="ldname">' + s.name + '</span>' +
        '<span class="ldval mono"></span>' +
        (s.id === "net" ? '<div class="ldsub mono"></div>' : "") +
        (s.id === "terrain" ? '<div class="ldchips">' + DEMS.map(function (d) {
          return '<span class="ldchip" data-dem="' + d[0] + '"><i></i>' + d[1] + '<b class="mono"></b></span>';
        }).join("") + '</div>' : "") +
        '</li>';
    }).join("");
    root.innerHTML =
      '<canvas class="ldfield" aria-hidden="true"></canvas>' +
      '<div class="ldvig" aria-hidden="true"></div>' +
      '<div class="ldcard">' +
        '<div class="ldhead">' +
          '<svg class="ldlogo" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="14"/>' +
          '<path d="M6 17c4-5 7 1 10-3s5-4 8-2M6 21c4-4 7 1 10-2s5-3 8-1M7 12c3-3 6 0 9-2s4-3 7-2"/></svg>' +
          '<div><b>SBMM <span>Site Explorer</span></b><small>OU1 · Sulphur Bank Mercury Mine</small></div>' +
        '</div>' +
        '<div class="ldplate" aria-hidden="true">' +
          '<canvas class="ldrelief"></canvas>' +
          '<div class="ldveil"><i></i></div>' +
          '<div class="ldgrid"></div>' +
          '<div class="ldsweep"></div>' +
          '<span class="ldcap mono"></span>' +
        '</div>' +
        '<div class="ldbar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>' +
        '<div class="ldnums"><b class="mono ldpct">0%</b><span class="mono ldbytes"></span></div>' +
        '<ol class="ldstages">' + stages + '</ol>' +
        '<div id="loadMsg" class="ldmsg" role="status" aria-live="polite">' +
          (SINGLE ? "Reading the app…" : LOCALFILE ? "Reading the site data…" : "Downloading the site data…") + '</div>' +
        '<div class="ldwarn" hidden><div class="ldwtxt"></div><pre class="ldwdet" hidden></pre>' +
          '<div class="ldacts"><button type="button" data-ld="reload">Reload</button>' +
          '<button type="button" data-ld="copy">Copy diagnostics</button></div></div>' +
      '</div>';
    els = {
      field: root.querySelector(".ldfield"), relief: root.querySelector(".ldrelief"),
      plate: root.querySelector(".ldplate"), veil: root.querySelector(".ldveil"), cap: root.querySelector(".ldcap"),
      bar: root.querySelector(".ldbar"), barI: root.querySelector(".ldbar i"),
      pct: root.querySelector(".ldpct"), bytes: root.querySelector(".ldbytes"),
      msg: root.querySelector(".ldmsg"), warn: root.querySelector(".ldwarn"),
      wtxt: root.querySelector(".ldwtxt"), wdet: root.querySelector(".ldwdet"),
      sub: root.querySelector(".ldsub")
    };
    root.addEventListener("click", function (e) {
      var b = e.target && e.target.closest && e.target.closest("[data-ld]");
      if (!b) return;
      if (b.dataset.ld === "reload") location.reload();
      if (b.dataset.ld === "copy") copyDiag(b);
    });
    field.start();
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* painting — coalesced into one rAF, and a 1-s tick for the clock    */
  /* ---------------------------------------------------------------- */
  var pending = false, rateText = "";
  function schedule() {
    if (pending) return;
    pending = true;
    (window.requestAnimationFrame || setTimeout)(paint);
  }
  var tick = setInterval(function () { if (phase === "load") { watch(); schedule(); } else clearInterval(tick); }, 1000);

  function paint() {
    pending = false;
    if (!built && !buildDom()) return;
    var T = totals();
    if (SINGLE) {
      var k = 0;
      for (var i = 0; i < READ_MARKS.length; i++) if (markSeen(READ_MARKS[i])) k++;
      frac.net = k / READ_MARKS.length;
    } else frac.net = T.all ? T.got / T.all : 0;
    if (state.build === "active") {
      var b = 0;
      for (var j = 0; j < BUILD_MARKS.length; j++) if (markSeen(BUILD_MARKS[j])) b++;
      frac.build = Math.max(frac.build, b / BUILD_MARKS.length);
    }
    var n = 0;
    for (var d in dems) if (dems[d] !== "skip") n++;
    frac.terrain = demWant ? n / demWant : 0;

    /* the net stage's own words */
    if (SINGLE) {
      detail.net = state.net === "done" ? "done" : Math.round(frac.net * 100) + "%";
    } else {
      var r = rate(), left = T.all - T.got;
      detail.net = state.net === "done" ? mb(T.all) + (LOCALFILE || !lastAt ? "" : " · " + secs(lastAt / 1000))
        : mb(T.got) + " of " + mb(T.all);
      var sub = "";
      if (state.net !== "done") {
        var w = waitingOn();
        if (w) sub = (LOCALFILE ? "reading " : "receiving ") + nameOf(w) + " · " + mb(sizeOf[w][1]);
      }
      if (els.sub && els.sub.textContent !== sub) els.sub.textContent = sub;
      rateText = state.net !== "done" && !LOCALFILE && r > 0 && T.got > 0
        ? mb(r) + "/s · about " + secs(left / r) + " left" : "";
    }
    detail.terrain = n ? n + " of " + demWant : "";

    STAGES.forEach(function (s) {
      var li = root.querySelector('.ldst[data-st="' + s.id + '"]');
      if (!li) return;
      if (li.dataset.state !== state[s.id]) li.dataset.state = state[s.id];
      var v = li.querySelector(".ldval");
      if (v && v.textContent !== detail[s.id]) v.textContent = detail[s.id];
      var ic = li.querySelector(".ldic");
      var want = state[s.id] === "done" ? ICON_OK : state[s.id] === "warn" || state[s.id] === "fail" ? ICON_WARN : "";
      if (ic && ic.dataset.k !== state[s.id]) { ic.dataset.k = state[s.id]; ic.innerHTML = want; }
    });
    DEMS.forEach(function (d) {
      var c = root.querySelector('.ldchip[data-dem="' + d[0] + '"]');
      if (!c) return;
      var v = dems[d[0]];
      c.dataset.state = v === "skip" ? "skip" : v ? "done" : state.terrain === "active" ? "active" : "wait";
      var bEl = c.querySelector("b");
      var txt = v && v !== "skip" ? (v.ms >= 1000 ? (v.ms / 1000).toFixed(1) + " s" : Math.round(v.ms) + " ms") : "";
      if (bEl.textContent !== txt) bEl.textContent = txt;
    });

    var p = phase === "done" ? 1 : overall();
    var pc = Math.floor(p * 100);
    els.barI.style.width = (p * 100).toFixed(2) + "%";
    els.bar.setAttribute("aria-valuenow", String(pc));
    if (els.pct.textContent !== pc + "%") els.pct.textContent = pc + "%";
    var el = (performance.now() - tStart) / 1000;
    els.bytes.textContent = SINGLE || state.net === "done" ? secs(el)
      : rateText || (mb(T.got) + " / " + mb(T.all) + " · " + secs(el));
    els.plate.dataset.p = String(pc);
    gateLine(p, T);
  }

  /* ---------------------------------------------------------------- */
  /* is something wrong?                                                */
  /* ---------------------------------------------------------------- */
  function watch() {
    if (phase !== "load") return;
    var now = performance.now();
    var f = failed.filter(function (p) { return expected(p) && !seen[p]; });
    if (f.length) {
      warn("retry", nameOf(f[0]) + " (" + f[0] + ") failed to load" +
        (f.length > 1 ? " — and " + (f.length - 1) + " more" : "") +
        ". It is retried once the rest of the page is in.", false);
      return;
    }
    if (state.net !== "active" || SINGLE) { clearWarn("stall"); return; }
    var w = waitingOn();
    if (!w) return;
    var since = (now - (lastAt || 0)) / 1000;
    /* how long the file being waited on SHOULD take at the measured rate
       (2 MB/s assumed before there is one), with room for a slow patch */
    var r = rate() || 2e6;
    var expect = sizeOf[w][1] / Math.max(r, 2e5);
    var limit = Math.max(15, expect * 2.5 + 8);
    if (since > limit) {
      warn("stall", "Nothing has arrived for " + secs(since) + " — waiting on " + nameOf(w) + " (" +
        mb(sizeOf[w][1]) + "). The connection may have dropped; Reload starts again, and files already " +
        "downloaded come from the browser's cache.", true);
    } else if (since > Math.max(8, expect * 1.4 + 4)) {
      clearWarn("stall");
      if (els.msg) say("Slow connection — " + nameOf(w) + " is " + mb(sizeOf[w][1]) + ", still coming");
    } else clearWarn("stall");
  }
  function warn(kind, text, actions, det) {
    if (!built) buildDom();
    if (!els.warn) return;
    warnKind = kind; warnText = text;
    els.warn.hidden = false;
    els.warn.dataset.kind = kind;
    els.wtxt.textContent = text;
    els.wdet.hidden = !det; els.wdet.textContent = det || "";
    els.warn.querySelector(".ldacts").hidden = !actions;
    if (kind === "stall" || kind === "fail") say("");
    if (kind !== "fail" && state.net === "active") state.net = "warn";
    schedule();
  }
  function clearWarn(kind) {
    if (warnKind !== kind || !els.warn) return;
    warnKind = null;
    els.warn.hidden = true;
    if (state.net === "warn") state.net = "active";
  }
  function say(t) { if (els.msg && els.msg.textContent !== t) els.msg.textContent = t; }

  /* ---------------------------------------------------------------- */
  /* the gate's copy                                                    */
  /* ---------------------------------------------------------------- */
  function gateLine(p, T) {
    var card = document.getElementById("gateCard");
    if (!card) return;
    var g = document.getElementById("gateLoad");
    if (!g) {
      g = document.createElement("div");
      g.id = "gateLoad";
      g.innerHTML = '<div class="glbar"><i></i></div><span class="mono"></span>';
      var foot = card.querySelector(".gfoot");
      card.insertBefore(g, foot || null);
    }
    var t;
    if (phase === "failed") t = "Couldn't start — unlock to see why";
    else if (phase === "done") t = "Ready";
    else if (state.net !== "done" && !SINGLE) t = (LOCALFILE ? "Reading" : "Loading") + " site data · " + mb(T.got) + " of " + mb(T.all);
    else if (state.terrain === "active") t = "Decoding terrain…";
    else if (state.build === "active") t = "Building the workbench…";
    else t = "Loading…";
    g.dataset.state = phase;
    g.querySelector("i").style.transform = "scaleX(" + p.toFixed(4) + ")";
    var s = g.querySelector("span");
    if (s.textContent !== t) s.textContent = t;
  }

  /* ---------------------------------------------------------------- */
  /* the background — a slow contour field, the gate's language         */
  /* ---------------------------------------------------------------- */
  function hash2(ix, iy, s) {
    var n = (ix * 374761393 + iy * 668265263 + s * 1442695041) | 0;
    n = (n ^ (n >>> 13)) | 0; n = Math.imul(n, 1274126177); n = (n ^ (n >>> 16)) >>> 0;
    return n / 4294967295;
  }
  function vnoise(x, y, s) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  var field = (function () {
    var cv = null, cx = null, W = 0, H = 0, raf = 0, last = 0, on = false, CELL = 18, z = null, gw = 0, gh = 0;
    function size() {
      if (!cv) return;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth; H = window.innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gw = Math.ceil(W / CELL) + 2; gh = Math.ceil(H / CELL) + 2;
      z = new Float32Array(gw * gh);
    }
    function draw(t) {
      var i, j, k = 0;
      for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) {
        var x = i * 0.075, y = j * 0.075;
        z[k++] = 0.6 * vnoise(x + t * 0.011, y - t * 0.006, 7) + 0.4 * vnoise(x * 2.1 - t * 0.017, y * 2.1 + t * 0.009, 8)
          + 0.04 * Math.sin(t * 0.25);
      }
      cx.clearRect(0, 0, W, H);
      var thin = new Path2D(), idx = new Path2D(), STEP = 0.055;
      for (j = 0; j < gh - 1; j++) for (i = 0; i < gw - 1; i++) {
        var a = z[j * gw + i], b = z[j * gw + i + 1], c = z[(j + 1) * gw + i + 1], d = z[(j + 1) * gw + i];
        var lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
        for (var L = Math.ceil(lo / STEP); L <= Math.floor(hi / STEP); L++) {
          var v = L * STEP, x0 = (i - 1) * CELL, y0 = (j - 1) * CELL, pts = [];
          if ((a >= v) !== (b >= v)) pts.push(x0 + (v - a) / (b - a) * CELL, y0);
          if ((b >= v) !== (c >= v)) pts.push(x0 + CELL, y0 + (v - b) / (c - b) * CELL);
          if ((d >= v) !== (c >= v)) pts.push(x0 + (v - d) / (c - d) * CELL, y0 + CELL);
          if ((a >= v) !== (d >= v)) pts.push(x0, y0 + (v - a) / (d - a) * CELL);
          if (pts.length >= 4) {
            var p = L % 5 === 0 ? idx : thin;
            p.moveTo(pts[0], pts[1]); p.lineTo(pts[2], pts[3]);
            if (pts.length === 8) { p.moveTo(pts[4], pts[5]); p.lineTo(pts[6], pts[7]); }
          }
        }
      }
      cx.lineCap = "round";
      cx.strokeStyle = "rgba(124,208,230,.075)"; cx.lineWidth = 0.8; cx.stroke(thin);
      cx.strokeStyle = "rgba(124,208,230,.16)"; cx.lineWidth = 1.1; cx.stroke(idx);
    }
    function frame(now) {
      raf = 0;
      if (!on) return;
      if (!document.hidden && now - last > 41) { last = now; draw(now / 1000); }
      raf = requestAnimationFrame(frame);
    }
    return {
      start: function () {
        cv = root.querySelector(".ldfield");
        if (!cv) return;
        cx = cv.getContext("2d");
        size();
        window.addEventListener("resize", size);
        on = true;
        if (REDUCE) draw(0); else raf = requestAnimationFrame(frame);
      },
      stop: function () {
        on = false;
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener("resize", size);
      }
    };
  })();

  /* ---------------------------------------------------------------- */
  /* the relief on the plate — the real ground, as soon as it exists    */
  /* ---------------------------------------------------------------- */
  /* `into` (a canvas) draws the same relief somewhere else — the shots script
     uses it, since on a fast machine the plate is on screen for under a second */
  function preview(dem, into) {
    if (!into && !built && !buildDom()) return;
    if (!dem || !dem.z || !dem.m || !(into || els.relief)) return;
    var m = dem.m, cv = into || els.relief;
    var rect = into ? { width: into.width, height: into.height } : els.plate.getBoundingClientRect();
    var dpr = into ? 1 : Math.min(2, window.devicePixelRatio || 1);
    var PW = Math.max(120, Math.round((rect.width || 320) * dpr));
    var PH = Math.max(100, Math.round((rect.height || 220) * dpr));
    /* fit the grid into the plate, keeping its aspect */
    var s = Math.max(m.w / PW, m.h / PH);
    var w = Math.max(2, Math.floor(m.w / s)), h = Math.max(2, Math.floor(m.h / s));
    cv.width = PW; cv.height = PH;
    var cx = cv.getContext("2d");
    var img = cx.createImageData(w, h), px = img.data;
    var g = new Float32Array(w * h), lo = Infinity, hi = -Infinity, i, j;
    for (j = 0; j < h; j++) {
      var sr = Math.min(m.h - 1, Math.floor((h - 1 - j) * s));       // row 0 of z is SOUTH
      for (i = 0; i < w; i++) {
        var v = dem.z[sr * m.w + Math.min(m.w - 1, Math.floor(i * s))];
        g[j * w + i] = v;
        if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    var cell = s * (m.step || m.cell || 2), span = Math.max(1, hi - lo);
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      var k = j * w + i, z = g[k], o = k * 4;
      if (z !== z) { px[o + 3] = 0; continue; }
      var zl = g[k - (i > 0 ? 1 : 0)], zr = g[k + (i < w - 1 ? 1 : 0)];
      var zu = g[k - (j > 0 ? w : 0)], zd = g[k + (j < h - 1 ? w : 0)];
      if (zl !== zl) zl = z; if (zr !== zr) zr = z; if (zu !== zu) zu = z; if (zd !== zd) zd = z;
      /* Lambert against a sun in the north-west at 45°, the convention on
         every plan in this app; relief exaggerated 2× so a 2-ft grid read at
         this scale still has shape */
      var nx = -(zr - zl) / (2 * cell) * 2, ny = (zd - zu) / (2 * cell) * 2;
      var nl = Math.sqrt(nx * nx + ny * ny + 1);
      var sh = Math.max(0, (nx * -0.5 + ny * 0.5 + 0.7071) / nl);
      var e = (z - lo) / span;
      /* a cool hypsometric ramp (low teal-dark to high pale) under the shade */
      var k2 = 0.42 + 0.78 * sh;
      px[o]     = Math.min(255, Math.round((26 + 70 * e) * k2));
      px[o + 1] = Math.min(255, Math.round((58 + 92 * e) * k2));
      px[o + 2] = Math.min(255, Math.round((70 + 86 * e) * k2));
      px[o + 3] = 255;
    }
    var off = document.createElement("canvas");
    off.width = w; off.height = h;
    off.getContext("2d").putImageData(img, 0, 0);
    var ox = Math.floor((PW - w) / 2), oy = Math.floor((PH - h) / 2);
    cx.clearRect(0, 0, PW, PH);
    cx.drawImage(off, ox, oy);
    /* index contours at a round interval, from the same decimated grid */
    /* about a dozen contour levels over the site, at a round interval */
    var IV = [5, 10, 20, 25, 50, 100, 200].find(function (v) { return span / v <= 14; }) || 200;
    var path = new Path2D(), pathIx = new Path2D();
    for (j = 0; j < h - 1; j++) for (i = 0; i < w - 1; i++) {
      var a = g[j * w + i], b = g[j * w + i + 1], c = g[(j + 1) * w + i + 1], d = g[(j + 1) * w + i];
      if (a !== a || b !== b || c !== c || d !== d) continue;
      var l0 = Math.ceil(Math.min(a, b, c, d) / IV), l1 = Math.floor(Math.max(a, b, c, d) / IV);
      for (var L = l0; L <= l1; L++) {
        var lv = L * IV, q = [];
        if ((a >= lv) !== (b >= lv)) q.push(ox + i + (lv - a) / (b - a), oy + j);
        if ((b >= lv) !== (c >= lv)) q.push(ox + i + 1, oy + j + (lv - b) / (c - b));
        if ((d >= lv) !== (c >= lv)) q.push(ox + i + (lv - d) / (c - d), oy + j + 1);
        if ((a >= lv) !== (d >= lv)) q.push(ox + i, oy + j + (lv - a) / (d - a));
        if (q.length >= 4) {
          var pp = L % 5 === 0 ? pathIx : path;
          pp.moveTo(q[0], q[1]); pp.lineTo(q[2], q[3]);
          if (q.length === 8) { pp.moveTo(q[4], q[5]); pp.lineTo(q[6], q[7]); }
        }
      }
    }
    cx.lineJoin = "round";
    cx.strokeStyle = "rgba(160,226,240,.32)"; cx.lineWidth = 0.75 * dpr; cx.stroke(path);
    cx.strokeStyle = "rgba(190,236,246,.48)"; cx.lineWidth = 1.05 * dpr; cx.stroke(pathIx);
    if (into) return;
    if (els.cap) els.cap.textContent = Math.round(lo) + "–" + Math.round(hi) + " ft · " + IV + "-ft contours";
    /* the reveal is a transform on the veil — composited, so it moves even
       while the main thread is busy building the workbench */
    els.plate.classList.add("hasrelief");
  }

  /* ---------------------------------------------------------------- */
  /* diagnostics                                                        */
  /* ---------------------------------------------------------------- */
  function diag() {
    var T = totals();
    return {
      when: new Date().toISOString(),
      url: location.protocol + "//" + location.host + location.pathname,
      build: window.SBMM_BUILD || "full", singleFile: SINGLE, ua: navigator.userAgent,
      elapsed_s: +((performance.now() - tStart) / 1000).toFixed(1),
      phase: phase, stages: state, warning: warnKind ? warnText : null,
      bytes: { arrived: T.got, expected: T.all, files: T.k + " of " + T.n, rate_Bps: Math.round(rate()) },
      waitingOn: waitingOn(), failedScripts: failed.slice(),
      retried: (SBMM.retriedScripts || []).slice(),
      heavySkipped: window.SBMM_HEAVY_SKIPPED === true,
      deferred: SBMM.payloads ? SBMM.payloads.stats() : null,
      terrain: dems,
      perf: window.SBMM_PERF ? SBMM_PERF.report() : null,
      memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
    };
  }
  function copyDiag(btn) {
    var txt = JSON.stringify(diag(), null, 2);
    var ok = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy diagnostics"; }, 1600); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(ok, function () { fallback(txt); ok(); });
        return;
      }
    } catch (e) {}
    fallback(txt); ok();
  }
  function fallback(txt) {
    var ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    ta.remove();
  }

  /* ---------------------------------------------------------------- */
  /* after boot — the deferred payloads, as a chip                      */
  /* ---------------------------------------------------------------- */
  function lateChip() {
    var P = SBMM.payloads;
    if (!P || !SBMM.events || P.settled()) return;
    var chip = document.createElement("div");
    chip.id = "ldLate";
    chip.setAttribute("role", "status");
    chip.innerHTML = '<span class="ldspin" aria-hidden="true"></span><span class="lt"></span><i><b></b></i>';
    document.body.appendChild(chip);
    var t = chip.querySelector(".lt"), b = chip.querySelector("b"), cur = "EA CAD and drawings";
    var upd = function () {
      var s = P.stats();
      if (/cad_native_lazy/.test(s.loading || "")) cur = "EA CAD";
      else if (/cad_surfaces_rasters/.test(s.loading || "")) cur = "EA design surfaces";
      else if (/sheet_full_/.test(s.loading || "")) cur = "sheet drawings";
      t.textContent = "Loading " + cur + " · " + s.done + " of " + s.deferred;
      b.style.transform = "scaleX(" + (s.deferred ? s.done / s.deferred : 1).toFixed(3) + ")";
      chip.title = "Read on first use, so they load after the app is up: EA's CAD linework, " +
        "the recovered design surfaces and the full sheet drawings" +
        (s.failed.length ? " — " + s.failed.length + " failed" : "");
      if (s.settled) {
        chip.classList.add("out");
        setTimeout(function () { chip.remove(); }, 500);
        SBMM.events.off && SBMM.events.off("payload", upd);
      }
    };
    SBMM.events.on("payload", upd);
    upd();
  }

  /* ---------------------------------------------------------------- */
  /* the API js/boot.js drives                                          */
  /* ---------------------------------------------------------------- */
  SBMM.loader = {
    /* the page's scripts are all in: boot is running */
    booting: function () {
      if (state.net !== "done") state.net = "done";
      clearWarn("stall"); clearWarn("retry");
      state.check = "active";
      say("Checking the data…");
      schedule();
    },
    /* `want` = the terrain payloads this build will decode, by name */
    checked: function (want) {
      state.check = "done";
      state.terrain = "active";
      DEMS.forEach(function (d) { if (want && want.indexOf(d[0]) < 0) dems[d[0]] = "skip"; });
      demWant = DEMS.filter(function (d) { return dems[d[0]] !== "skip"; }).length || 1;
      say("Decoding the terrain grids in the background…");
      schedule();
    },
    dem: function (name, info) {
      dems[name] = { ms: info && info.ms || 0, worker: !!(info && info.worker) };
      if (name === "dem_site" && info && info.dem) {
        try { preview(info.dem); } catch (e) { console.warn("loader preview:", e); }
      }
      schedule();
    },
    terrainDone: function () {
      DEMS.forEach(function (d) { if (!dems[d[0]]) dems[d[0]] = "skip"; });
      state.terrain = "done";
      state.build = "active";
      say("Building the map, layers and tools…");
      schedule();
    },
    note: function (t) { say(t); },
    retrying: function (name, attempt) {
      warn("retry", "Retrying " + name + " (" + attempt + " of 2)…", false);
    },
    /* boot is done: fade, then get out of the way entirely */
    done: function () {
      phase = "done"; doneAt = performance.now();
      state.build = "done";
      clearWarn("retry"); clearWarn("stall");
      paint();
      if (root) {
        root.setAttribute("aria-busy", "false");
        root.classList.add("ldout");
        setTimeout(function () {
          root.style.display = "none";
          field.stop();
          root.innerHTML = "";
        }, REDUCE ? 0 : 520);
      }
      try { lateChip(); } catch (e) { console.error(e); }
    },
    fail: function (msg, det) {
      phase = "failed";
      if (!built) buildDom();
      if (root) root.dataset.phase = "failed";
      var gone = failed.filter(function (p) { return !seen[p]; });
      if (gone.length) det = "Did not load: " + gone.join(", ") + "\n\n" + (det || "");
      ["net", "check", "terrain", "build"].forEach(function (k) { if (state[k] === "active" || state[k] === "warn") state[k] = "fail"; });
      warn("fail", "Couldn't start — " + msg, true, det +
        (LOCALFILE ? "\n\nIf this is a copy of the folder build, check the whole folder came along " +
          "(js/, datajs/, vendor/). The single-file build has no such dependency." : ""));
      if (els.warn) els.warn.classList.add("loaderr");
      say("Stopped.");
      paint();
    },
    stats: function () { return diag(); },
    preview: preview
  };

  /* keep painting through the download even if nothing new arrives */
  schedule();
  if (document.readyState === "loading")
    document.addEventListener("readystatechange", schedule);
})();
