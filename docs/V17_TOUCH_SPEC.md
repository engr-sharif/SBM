# SBMM Site Explorer — v17: the iPad, and touch everywhere (authoritative)

Owner/decider: Fable (planner). Executor: one Opus agent (T). This is the
contract; the agent implements it and does not re-decide it. Hard constraints as
in CLAUDE.md (file:// only, plain scripts, three builds, every harness, golden
Pile 1, browser harnesses one at a time, every refusal toasts, no model names).
Field mode (`docs/V11_SPEC.md` §4, `body.field`) stays exactly as it is: this
spec is about the tablet and about touch as an INPUT, not about the phone
layout.

---------------------------------------------------------------------------

## 0. What the user asked for, in his words

> I've just got this app working on my iPad and I've saved to desktop so it
> looks like a real app that I love. […] I'd like you to build this app with
> functions that will work on the iPad size screens, it looks good now but I
> think we can make it sota when it comes to running on the iPad. Especially
> the 3d viewer to work better with pinch and zoom and other features of the
> iPad touch, make it sota compatible with touch devices when it detects them,
> pinch and zoom should work on the sheet viewer too and maybe be able to zoom
> in and use all the features of the sheet viewer too. Just because I didn't
> mention something explicitly regarding this I'd like you to take what I'm
> saying and use it as points for you to build into this app.

He runs the FOLDER build from GitHub Pages in Safari on an iPad, added to the
home screen (a standalone web app: no browser chrome, the full screen, its own
localStorage). An iPad in landscape is 1024–1366 px wide, so the v11 sniff
(coarse pointer AND ≤ 900 px) leaves it in the desktop layout — which is what
he sees and likes. What is missing is that the desktop layout assumes a mouse:
hover toolbars, right-click menus, wheel zoom, single-key shortcuts, 22-px
buttons, and gestures that only the phone build ever had.

## 1. Three profiles, one detector — `js/touch.js`, new; `SBMM.touch`

```
SBMM.touch.profile()   -> "desktop" | "tablet" | "phone"
SBMM.touch.on()        -> body.touch is set (tablet or phone)
SBMM.touch.override(v) -> "auto" | "on" | "off"  (Help switch, localStorage "sbmm.touch.v1")
SBMM.events.on("touch", ({profile}) => …)
SBMM.touch.gestures(el, handlers) -> a recogniser (below)
```

- **phone** = the v11 rule, unchanged: coarse pointer AND `innerWidth ≤ 900`
  → `body.field` (and `body.touch`).
- **tablet** = touch-capable AND `innerWidth > 900` → `body.touch` only: the
  desktop layout with touch affordances. Touch-capable means
  `matchMedia("(any-pointer: coarse)")` OR `navigator.maxTouchPoints > 1`
  (iPadOS reports a desktop UA; with a Magic Keyboard trackpad `pointer` is
  `fine` but `any-pointer` is still `coarse`). Never sniff the UA.
- **desktop** = everything else. `test/e2e.mjs` runs here and must not change.
- Re-evaluated on `resize` and `orientationchange` (debounced 150 ms): an iPad
  in Split View at 507 px becomes a phone and back — the v11 switch already
  handles the phone half; this spec adds the tablet half and the events.
- **Per-event, not per-profile, wherever an event has a pointer type.** A
  Surface with a mouse AND a screen, an iPad with a trackpad AND a finger, an
  Apple Pencil (`pointerType === "pen"` — precise, may hover on M2 iPads):
  gestures branch on `e.pointerType` (`touch`/`pen` → touch rules; `mouse` →
  today's rules) whatever the profile says. The profile only sizes chrome and
  chooses defaults.
- **The gesture recogniser** (one implementation, used by the 3D rig, the
  sheet viewer, the sketch loupe): tracks live touch/pen pointers in a Map,
  and reports `tap`, `doubletap` (≤ 300 ms, ≤ 20 px apart), `twofingertap`,
  `longpress` (500 ms, ≤ 8 px drift), `pan` (one finger, dx/dy with
  velocity), `pinch` (two fingers: scale about the midpoint, midpoint delta,
  twist angle), `flick` (pointer-up velocity for momentum), `end`. Mouse and
  pen-with-buttons never enter it except as `pen` taps. `touch-action: none`
  on every element it is attached to. Momentum is a decaying step per frame
  (`v *= 0.92`, stop under 0.02 px/ms), cancelled by any touch, and it must
  leave the 3D view's idle-render count at 0 once it settles.

## 2. The home-screen app (§ Pages build), and the offline copy

- `manifest.webmanifest` (name "SBMM Site Explorer", short_name "SBMM",
  `display: standalone`, `orientation: any`, `background_color`/`theme_color`
  from the theme, icons 192/512 + a maskable 512) linked from `index.html`;
  `<meta name="apple-mobile-web-app-capable" content="yes">`,
  `apple-mobile-web-app-status-bar-style` `black-translucent`,
  `apple-mobile-web-app-title` "SBMM", `theme-color`, and
  `<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">` (180 px).
  Icons in `icons/`, drawn by `tools/make_icons.py` (the gate's contour mark
  on the dark ground; Pillow; committed PNGs). `tools/build_dist.py` DROPS the
  `manifest` and icon links in both single-file builds (they would 404 beside
  a lone HTML file) and keeps the meta tags.
- Viewport: `width=device-width, initial-scale=1, viewport-fit=cover,
  interactive-widget=resizes-content`. Safe areas: the top bar, the docks, the
  status bar, the field action bar, the toast, the sheet windows and the 3D
  toolbar pad by `env(safe-area-inset-*)`; the layout uses `100dvh` (with the
  `100vh` fallback). `overscroll-behavior: none` on `html, body` (no
  rubber-band, no pull-to-refresh); `-webkit-touch-callout: none` and
  `user-select: none` on `#stage` and the chrome (inputs keep `text`);
  `touch-action: manipulation` on every button and control (no 300-ms delay,
  no double-tap page zoom); `touch-action: none` on the map container, the 3D
  canvas and the sheet views. Inputs ≥ 16 px under `body.touch` (iOS zooms
  the page on focus below that; the field CSS already does it — hoist the
  rule). Split View / Stage Manager / rotation: `SBMM.shell.relayout()` on
  `resize`, `orientationchange` and `visualViewport` `resize`; the command
  bar and any open modal stay above the on-screen keyboard (`visualViewport`
  height, not `innerHeight`).
- In Safari (not standalone) on a touch device, the Help panel shows a
  one-line "Add to Home Screen" hint with the Share-menu steps; standalone
  (`navigator.standalone` or `display-mode: standalone`) hides it.
- **The offline copy** — the one place `fetch` is allowed, and it is not the
  app: `sw.js`, a service worker, registered by `js/touch.js` ONLY when
  `location.protocol` is `http:`/`https:` and `navigator.serviceWorker`
  exists — never over `file://`, where nothing changes. It caches the app's
  OWN origin only. Opt-in, never automatic: a **"Make available offline"**
  button in Help (and the More sheet in field mode) asks the worker to
  precache every URL in `index.html` (it fetches `index.html` and reads the
  `<script src>`, `<link href>` and icon URLs — one list, no second copy of
  the script list to go stale), shows progress (n of m, MB), and ends in a
  status line "offline copy: ready · 130 MB · {date}" / "none" / "stale — an
  update is available, refresh to load it". Serving: `index.html` network-
  first (falls back to cache), everything else cache-first. A changed
  `index.html` marks the copy stale, toasts once, and the button becomes
  "Update offline copy"; "Remove offline copy" deletes the cache. Failures
  toast (quota, offline mid-precache). The e2e serves the folder build over a
  local `http` server to prove it (§6) — that server exists for the test only.
- The password gate is unchanged and is still a deterrent, not security; an
  offline copy on a device is the same thing as the dist file the team already
  double-clicks.

## 3. The 3D view on touch (`js/viewer3d.js`, the nav rig)

Today: one finger orbits, two fingers pinch-dolly and pan (v11). Make it the
gesture set of a native map:

| gesture | does |
|---|---|
| one finger drag | orbit (as today), with **momentum** on release |
| two-finger pinch | dolly **toward the midpoint under the fingers** (raycast the terrain at the midpoint once per gesture; the orbit target slides so that ground point stays under the fingers — not toward the orbit centre) |
| two-finger drag | pan (as today), with momentum |
| two-finger **twist** | rotate azimuth about the target by the twist angle |
| three-finger vertical drag | tilt (polar angle) |
| double-tap | centre on the point under the finger and dolly in ×0.6, eased (the existing easing) |
| two-finger tap | dolly out ×1.6, eased |
| tap | pick (as a click does) |
| long-press | the identify card for what is under the finger (hover has no touch equivalent) — and on a 3D vertex handle, begin a drag |
| pen | hover highlight when the pen hovers; a pen tap is a click |

- Vertex handles and pick tolerance: 44-px hit spheres and doubled raycaster
  thresholds under `body.touch`.
- An on-screen nav pad in the 3D toolbar under `body.touch` (44-px buttons,
  bottom-right, safe-area aware): dolly +/−, tilt up/down, north-reset on the
  compass, fit. The presets stay in the toolbar. Keys keep working with a
  hardware keyboard.
- Renderer pixel ratio capped at 2; tablets default to STANDARD detail like
  the phone, with HIGH selectable and remembered (an M-series iPad handles it;
  an A10 does not, and a remembered choice beats a guess).
- "Animate water" stays; momentum must not keep the render loop alive after
  it settles (`test/perf.mjs` idle renders 0).

## 4. The sheet viewer on touch (`js/sheets.js`, `js/sheetmarks.js`)

- Pinch zoom about the midpoint (the sheet point under the fingers stays
  put), two-finger pan, one-finger pan (as today) with momentum, double-tap
  zoom in ×2 at the point, two-finger tap out ×0.5. Wheel keeps working.
- Under `body.touch` a sheet window opens **maximised** to the stage (safe-
  area aware) with a restore button; a maximise button exists on every window
  in every profile. Title-bar move, the resize grip and every toolbar button
  are 44 px under `body.touch`; the window's buttons never overlap the drawing
  at 44 px (the toolbar wraps).
- **Marking and measuring by finger, precisely.** Placing a vertex on touch is
  press-and-hold: while the finger is down a **loupe** (a 2.5× magnified
  circle of the sheet, 120 px, offset above-left of the finger with a
  crosshair) shows exactly where the vertex will land, the finger can slide,
  and the vertex is placed where the finger LIFTS. A tap without a slide
  places immediately. Two fingers cancel the placement and become a pinch.
  A **Done / Undo vertex / Cancel** bar appears while a sketch is open under
  `body.touch` (Enter, Backspace and Esc have no touch equivalent), and
  double-tap finishes as it does today. Long-press a vertex handle to drag it
  (with the loupe); long-press a mark for its context actions (delete,
  properties, locate on map). The same loupe and bar serve the map (§5).
- Every sheet-window feature — page step, locate on map, the marks list,
  measure, mark, export — must be reachable by tap; the e2e walks them.

## 5. The map and the chrome on touch

- **Sketching**: the same press-hold-loupe placement, the same Done bar, on
  the map. Vertex edit handles 44 px; osnap glyphs 1.5× under `body.touch`;
  the snap radius in screen px scales the same way.
- **Long-press = right-click**, everywhere a `contextmenu` handler exists: the
  map context menu, a feature's menu, a vertex's menu. 500 ms, ≤ 8 px drift,
  cancelled by movement; Leaflet 1.9 does not synthesise it for touch, so the
  recogniser does.
- **Hover has a tap path.** The layer tree's row toolbar (v16) shows on a
  visible "⋯" button at the row's end under `body.touch`; a row's info popover
  carries what the `title` tooltips say; every other hover-only control in the
  app is audited and given a tap path (`test/audit.mjs` gets a touch pass
  listing each control and how it was reached).
- Buttons 44 px and the top bar one reflow stage narrower under
  `body.touch` (the four-stage narrowing is measured, not assumed; a taller
  bar is fine). Popup action buttons 44 px. Docks keep the desktop layout.
- Tooltips: on touch, a long-press on a toolbar button shows its tooltip as a
  toast-style chip (the title text, with the key in brackets) without firing
  it.
- The command bar: opens from a button in the top bar under `body.touch`
  (the backtick has no key), and stays above the on-screen keyboard.
- Text selection and the iOS callout never fire on the stage.

## 6. Acceptance

**`test/e2e_tablet.mjs`** (new; the tablet harness) on Playwright's
`iPad Pro 11` descriptor in LANDSCAPE (1194×834, DPR 2, touch) with Chromium
(WebKit is not installed here; do not try to install it), against the FOLDER
build served two ways: `file://` and a local static `http` server started by
the harness (for the manifest, the icons and the service worker). Sections:

1. boot: zero page errors, `profile === "tablet"`, `body.touch` on,
   `body.field` OFF; the manifest link, the four apple/theme metas, the icons
   resolve (http); `100dvh` layout and safe-area padding present; every
   toolbar button ≥ 44 px; the unlock by tap.
2. profiles: resize to 507 px → phone (field mode on), back to 1194 → tablet;
   portrait 834×1194 stays tablet and relayouts without error; the override
   switch forces desktop and back.
3. 3D: one-finger orbit; pinch dollies and the ground point under the
   midpoint stays under it (±3 % of the screen); two-finger drag pans; twist
   changes azimuth by the twist angle ±5°; three-finger drag tilts; double-tap
   centres and dollies in; two-finger tap dollies out; a flick leaves the
   camera moving for ≥ 3 frames and then the idle render count returns to 0;
   long-press opens the identify card on a DU; a vertex handle drags by
   long-press and the store updates.
4. sheets: opens maximised; pinch about a point keeps it put ±2 px; two-
   finger pan; double-tap zoom; a mark placed with the loupe visible during
   the press (screenshot it) and finished with Done georeferences within the
   sheet's existing tolerance; restore/maximise; the page step, locate, marks
   list, measure and export by tap.
5. map: long-press opens the context menu; a polygon sketched by taps + Done
   has the same area as the same polygon drawn by mouse clicks (±0.1 %); a
   vertex drag by touch moves it; the layer-tree row toolbar by "⋯"; a popup
   action by tap; the command bar from its button.
6. offline (http only): "Make available offline" precaches n ≥ 40 files and
   reports ready; `context.setOffline(true)`, reload → the app boots with zero
   errors and the DEM stack decodes; a changed `index.html` (the harness
   rewrites one byte in its served copy) → "stale" after the next load;
   "Remove offline copy" empties the cache. Over `file://`: no registration,
   no error, the button says why.

**Existing harnesses, unchanged and green** on all three builds: `test/e2e.mjs`
(desktop — this is the proof that the desktop is untouched), `split3d`,
`e2e_field` (the phone half is untouched too), `kernels` (no kernel work),
`perf` (idle 0). `test/audit.mjs` gains the touch pass. Shots:
`test/tablet_shots.mjs` → `tablet_map.png`, `tablet_3d.png`,
`tablet_sheet_loupe.png`, `tablet_layers.png`, `tablet_home_hint.png`; look at
them. Golden unchanged.

## 7. Docs

CLAUDE.md (code-map rows for `touch.js` and `sw.js`; a v17 section: the three
profiles, the per-event rule, the recogniser, the loupe, the offline copy and
the ONE fetch exemption, the traps you hit), README ("On an iPad" section: how
to add to the home screen, the offline copy, a gesture table for 3D, the
sheets and the map), HANDOFF (decision rows; an open item that GitHub Pages on
a private repo needs a paid plan — the engineer decides), release notes v9.14.
No model names.

## 8. Not in scope

A native wrapper; the phone layout (v11 stands); Android-specific work beyond
what the profiles give it for free; changing what the gate is.
