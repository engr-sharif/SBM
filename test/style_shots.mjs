/* The chrome, photographed — the proof for a stylesheet change that is meant
   to move no pixel (colour and type tokens replacing literals of the same
   value, dead rules removed).

     node test/style_shots.mjs [index.html] [outdir]

   Run it on the tree before the change and again after, and compare the two
   directories pixel for pixel: the target is zero differing pixels on every
   screen. Not pass-fail on its own — it only takes the pictures.

   DETERMINISM is the whole point, so: CSS animations and transitions are
   switched off by an injected sheet, the caret is hidden, fonts are awaited,
   the toast and the restore bar are cleared before every shot, each action
   gets a fixed settle, and the live WebGL canvas is HIDDEN (visibility, not
   removed) for the 3D-chrome shots — a software-GL frame is not guaranteed
   bit-stable from run to run, the DOM chrome over it is. Run the script
   twice on one tree before trusting a difference: a screen that differs
   between two runs of the same code says nothing about the change. */
import { launch, TIMEOUT } from "./lib/browser.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { unlock, lateSettled } from "./gate.mjs";

/* Both defaults from this checkout, never a hard-coded /home/user/SBM (an
   agent worktree would otherwise photograph somebody else's tree). */
const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const target = process.argv[2] || resolve(HERE, "..", "index.html");
const out = process.argv[3] || resolve(HERE, "shots", "style");
mkdirSync(out, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(TIMEOUT);
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await unlock(page);
await page.goto(pathToFileURL(resolve(target)).href);
await page.waitForSelector("#loading", { state: "hidden", timeout: 240000 });
await lateSettled(page);
await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
await page.evaluate(() => document.fonts.ready);

const wait = ms => page.waitForTimeout(ms);
const clean = () => page.evaluate(() => {
  const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  document.querySelectorAll(".restorebar").forEach(b => b.remove());
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
/* a shot of the whole viewport, or of the union of some elements' boxes */
async function shot(name, sels) {
  await clean();
  await wait(600);
  const opt = { path: out + "/" + name + ".png", animations: "disabled", caret: "hide" };
  if (sels) {
    const r = await page.evaluate(ss => {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const s of ss) for (const el of document.querySelectorAll(s)) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
      }
      if (x1 < x0) return null;
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      return { x: x0, y: y0, width: Math.min(innerWidth, Math.ceil(x1)) - x0, height: Math.min(innerHeight, Math.ceil(y1)) - y0 };
    }, sels);
    if (!r) { console.log("SKIP", name, "— nothing visible for", sels.join(", ")); return; }
    opt.clip = r;
  }
  await page.screenshot(opt);
  console.log("shot", name);
}
const run = c => page.evaluate(c => { SBMM.cmd.run(c); }, c);   // results can hold DOM nodes: return nothing
const hideGL = on => page.evaluate(on => {
  const c = document.getElementById("v3dCanvas"); if (c) c.style.visibility = on ? "hidden" : "";
}, on);

await page.evaluate(() => { SBMM.cmd.open(false); SBMM.store.select(null); });
await wait(3000);

/* 1. the app as it opens */
await shot("01_app");

/* 2. the Layers catalogue, three groups open */
await page.evaluate(() => {
  const tab = document.querySelector('#leftTabs [data-tab="layers"]');
  if (tab) tab.click();
  SBMM.layersPanel.show("catalog");
  [...document.querySelectorAll("#layers .lsec")].slice(0, 3).forEach(s => s.classList.remove("closed"));
  const p = document.querySelector("#layers"); if (p) p.scrollTop = 0;
});
await wait(800);
await shot("02_layers_catalog");
await page.evaluate(() => { SBMM.layersPanel.show("home"); });

/* 3-8. each top-bar menu open */
for (const [n, id] of [["03_menu_measure", "measureMenuBtn"], ["04_menu_draw", "drawMenuBtn"],
                       ["05_menu_design", "designMenuBtn"], ["06_menu_water", "waterMenuBtn"],
                       ["07_menu_data", "siteMenuBtn"], ["08_menu_file", "exportBtn"]]) {
  await page.evaluate(id => document.getElementById(id).click(), id);
  await wait(400);
  await shot(n);
  await page.evaluate(() => { SBMM.shell.closeMenus(); });
}

/* 9. the info page with both <details> open */
await page.evaluate(() => {
  document.getElementById("helpBtn").click();
  document.querySelectorAll("#help details").forEach(d => d.open = true);
});
await shot("09_help");
await page.evaluate(() => { document.getElementById("help").style.display = "none"; });

/* 10. results cards: the boring summary and SB-9's log */
await run("LOGS");
await wait(800);
await run("LOG SB-9");
await wait(1200);
await page.evaluate(() => { SBMM.shell.setRightTab("results"); const b = document.getElementById("resBody"); if (b) b.scrollTop = 0; });
await shot("10_results");

/* 11. the boring-log window */
await run("LOGWIN");
await wait(2000);
await shot("11_logwin");
await page.evaluate(() => { SBMM.borewin.close(); });
await wait(500);

/* 12. a Leaflet popup on a feature (the first point layer with a popup, in
   the map's own layer order — the same one every run) */
const pop = await page.evaluate(() => {
  let hit = null;
  SBMM.map.eachLayer(l => { if (!hit && l.getPopup && l.getPopup() && l.getLatLng && SBMM.map.getBounds().contains(l.getLatLng())) hit = l; });
  if (!hit) return null;
  hit.openPopup();
  return true;
});
await wait(1200);
if (pop) await shot("12_popup"); else console.log("SKIP 12_popup — no point layer with a popup in view");
await page.evaluate(() => { SBMM.map.closePopup(); });

/* 13. the command bar */
await page.evaluate(() => { SBMM.cmd.open(true); });
await wait(500);
await shot("13_cmdbar");
await page.evaluate(() => { SBMM.cmd.open(false); });

/* 14. the TEM workspace panel (it opens 3D behind it, so the canvas is hidden) */
await run("TEMWS");
await page.waitForFunction(() => SBMM.geophys.hasResult(), null, { timeout: 240000 });
await wait(4000);
await hideGL(true);
await shot("14_tem_workspace", ["#temWs"]);
await hideGL(false);
await page.evaluate(() => { SBMM.temws.off(); });
await wait(1500);

/* 15-16. the 3D toolbar and the View settings popover, the canvas hidden */
await page.evaluate(() => { if (document.getElementById("view3d").style.display !== "block") SBMM.viewer3d.toggle(); });
await page.waitForFunction(() => document.getElementById("view3d").style.display === "block"
  && document.getElementById("v3dStatus").textContent === "", null, { timeout: 240000 });
await wait(3000);
await hideGL(true);
await shot("15_3d_toolbar", ["#view3d .v3dbar"]);
await page.evaluate(() => document.getElementById("v3dViewSet").click());
await wait(600);
await shot("16_3d_viewsettings", ["#v3dViewPop"]);
await page.evaluate(() => { document.getElementById("v3dViewPop").classList.remove("on"); });
await hideGL(false);
await page.evaluate(() => { SBMM.viewer3d.toggle(); });
await wait(1500);

/* 17. the view chip, one setting off its default */
await page.evaluate(() => { SBMM.storm.setEnabled(false, true); if (SBMM.viewState.touch) SBMM.viewState.touch(); });
await wait(1500);
await page.evaluate(() => { const c = document.getElementById("viewChip"); if (c) c.click(); });
await wait(600);
await shot("17_view_chip", ["#status", "#viewPop"]);
await page.evaluate(() => { document.getElementById("viewPop").classList.remove("open"); SBMM.storm.setEnabled(true, true); });
await wait(800);

/* 18. a modal: RESET's confirm, then cancel */
await page.evaluate(() => { SBMM.viewState.confirmReset(); });
await wait(500);
await shot("18_modal");
await page.evaluate(() => document.getElementById("resetNo").click());

/* 20-21. a drawn area: its results card (rows + note), then the Inspector */
await page.evaluate(() => {
  const f = SBMM.tools.newFeature("area", [[6371400, 2128600], [6371700, 2128600], [6371700, 2128850], [6371400, 2128850]], "Area style");
  f.card = SBMM.results.card(f, f.name, []);   // what mkArea does: a feature brings its own card
  SBMM.tools.recompute(f);
  SBMM.shell.setRightTab("results");
  const b = document.getElementById("resBody"); if (b) b.scrollTop = 0;
});
await wait(1500);
await shot("20_area_card");
await page.evaluate(() => {
  const f = SBMM.store.features.find(x => x.name === "Area style");
  SBMM.store.select(f.id); SBMM.shell.setRightTab("inspector");
});
await wait(800);
await shot("21_inspector");
await page.evaluate(() => { SBMM.store.select(null); SBMM.shell.setRightTab("results"); });

/* 22. the samples table drawer */
await page.evaluate(() => { document.getElementById("tableBtn").click(); });
await wait(1200);
await shot("22_table");
await page.evaluate(() => { document.getElementById("tableBtn").click(); });
await wait(500);

/* 23. the layer manager dialog */
await page.evaluate(() => { SBMM.layerMan.open(); });
await wait(1200);
await shot("23_layerman");
await page.keyboard.press("Escape");
await wait(500);

/* 24. the omnibox with a result list (shot() would blur the box and close it) */
await page.evaluate(() => {
  const t = document.getElementById("toast"); if (t) t.classList.remove("show");
  const i = document.getElementById("omniIn"); i.focus(); i.value = "SB-1";
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await wait(1200);
await page.screenshot({ path: out + "/24_omnibox.png", animations: "disabled", caret: "hide" });
console.log("shot 24_omnibox");
await page.keyboard.press("Escape");
await page.evaluate(() => { const i = document.getElementById("omniIn"); i.value = ""; i.blur(); });
await wait(500);

/* 19. field mode with the Layers bottom sheet open */
await page.evaluate(() => { SBMM.field.set(true, { persist: false }); });
await wait(2000);
await page.evaluate(() => { SBMM.field.openSheet("layers"); });
await wait(1500);
await shot("19_field_layers");

await browser.close();
