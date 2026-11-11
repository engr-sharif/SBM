/* SBMM Site Explorer — results panel cards */
"use strict";

SBMM.results = (function () {
  function checkEmpty() {
    const body = $("resBody");
    if (!body.querySelector(".res") && !body.querySelector(".placeholder"))
      body.innerHTML = '<div class="placeholder">Pick a tool and draw on the map.</div>';
  }

  /* ---------------------------------------------------------------- */
  /* v59 — FOLDING. Cards are prepended and were never put away: after an
     afternoon the column was a dozen full cards deep and the one being read
     was somewhere in it. Now the newest card is open and the ones before it
     fold to their title and headline row; a click on a title opens or folds
     it. Nothing is removed and nothing is hidden from the CSV, the harnesses
     or a module holding the element — a folded card is the same element with
     most of it `display:none`.
       · a new card folds the others, except one the user opened by hand
         (`data-keep`) and the tool-option cards, which are controls;
       · selecting a feature opens its card;
       · the user's own click on a title is the last word on that card. */
  function fold(el, on, byUser) {
    if (!el || !el.classList || el.classList.contains("toolopt")) return;
    el.classList.toggle("folded", !!on);
    if (byUser) { if (on) delete el.dataset.keep; else el.dataset.keep = "1"; }
    const ch = el.querySelector('h4 [data-a="fold"]');
    if (ch) ch.title = on ? "Open this card" : "Fold this card to its headline";
  }
  function foldOthers(keepEl) {
    document.querySelectorAll("#resBody .res").forEach(el => {
      if (el !== keepEl && !el.dataset.keep && !el.classList.contains("sel")) fold(el, true);
    });
  }

  /* ---------------------------------------------------------------- */
  /* v59 — A CARD AS A WINDOW. The column is ~350 px wide and a card with a
     chart, a table or a strip log in it is read through a keyhole. The window
     button moves the card — the SAME element, so every module's reference to
     it and every listener on it still holds — into a floating window on the
     sheet-window chassis (`.shwin`: the 4000-4899 band, and js/mode.js already
     swallows the tool shortcuts while one has the focus), sized for reading.
     "Dock" or Esc puts it back at the top of the column. */
  const wins = new Map();                    // card element -> window element
  function stageBox() {
    return (SBMM.sheets && SBMM.sheets.stageBox) ? SBMM.sheets.stageBox()
      : { x: 8, y: 60, w: innerWidth - 16, h: innerHeight - 68 };
  }
  function titleOf(el) {
    const h = el.querySelector("h4");
    if (!h) return "Result";
    const n = h.querySelector(".rname");
    return (n ? n.textContent : h.childNodes[0] ? h.childNodes[0].textContent : h.textContent).trim() || "Result";
  }
  function toWindow(el) {
    if (!el || wins.has(el)) return wins.get(el) || null;
    fold(el, false);
    const b = stageBox(), w = Math.min(560, b.w - 24), h = Math.min(Math.round(b.h * 0.78), 760);
    const win = document.createElement("div");
    win.className = "shwin rswin";
    win.tabIndex = -1;
    win.innerHTML = `<div class="shbar"><span class="shtitle"></span><span style="flex:1"></span>`
      + `<button type="button" class="minib" data-rw="dock" title="Put this card back in the Results column (Esc)">dock</button></div>`
      + `<div class="rsbody"></div><div class="shgrip" title="Drag to resize"></div>`;
    win.querySelector(".shtitle").textContent = titleOf(el);
    win.style.cssText = `left:${Math.round(b.x + b.w - w - 28)}px;top:${Math.round(b.y + 18)}px;width:${w}px;height:${h}px;z-index:4880`;
    document.body.appendChild(win);
    win.querySelector(".rsbody").appendChild(el);
    el.classList.add("inwin");
    wins.set(el, win);
    win.querySelector('[data-rw="dock"]').onclick = () => toColumn(el);
    win.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.stopPropagation(); e.preventDefault(); toColumn(el);
    });
    /* the title bar moves it, the grip sizes it — the sheet windows' gestures */
    const bar = win.querySelector(".shbar"), grip = win.querySelector(".shgrip");
    const keepIn = () => {
      const q = stageBox();
      win.style.left = Math.round(Math.min(Math.max(win.offsetLeft, q.x), q.x + q.w - 80)) + "px";
      win.style.top = Math.round(Math.min(Math.max(win.offsetTop, q.y), q.y + q.h - 40)) + "px";
    };
    let mv = null, rz = null;
    bar.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      mv = { x: e.clientX, y: e.clientY, l: win.offsetLeft, t: win.offsetTop };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener("pointermove", e => {
      if (!mv) return;
      win.style.left = (mv.l + e.clientX - mv.x) + "px"; win.style.top = (mv.t + e.clientY - mv.y) + "px";
      keepIn();
    });
    bar.addEventListener("pointerup", () => { mv = null; });
    grip.addEventListener("pointerdown", e => {
      rz = { x: e.clientX, y: e.clientY, w: win.offsetWidth, h: win.offsetHeight };
      grip.setPointerCapture(e.pointerId); e.stopPropagation();
    });
    grip.addEventListener("pointermove", e => {
      if (!rz) return;
      const q = stageBox();
      win.style.width = Math.round(Math.min(Math.max(rz.w + e.clientX - rz.x, 320), q.x + q.w - win.offsetLeft - 6)) + "px";
      win.style.height = Math.round(Math.min(Math.max(rz.h + e.clientY - rz.y, 200), q.y + q.h - win.offsetTop - 6)) + "px";
    });
    grip.addEventListener("pointerup", () => { rz = null; });
    /* a card a module removed while it was out (a deleted feature, a cleared
       analysis) takes its window with it */
    const mo = new MutationObserver(() => {
      if (!win.querySelector(".rsbody > .res")) { mo.disconnect(); wins.delete(el); win.remove(); checkEmpty(); }
    });
    mo.observe(win.querySelector(".rsbody"), { childList: true });
    win._mo = mo;
    win.focus();
    checkEmpty();
    return win;
  }
  function toColumn(el) {
    const win = wins.get(el);
    if (!win) return;
    if (win._mo) win._mo.disconnect();
    wins.delete(el);
    el.classList.remove("inwin");
    const body = $("resBody"), ph = body.querySelector(".placeholder");
    if (ph) ph.remove();
    body.prepend(el);
    win.remove();
    foldOthers(el);
    if (SBMM.shell && SBMM.shell.showResults) SBMM.shell.showResults();
  }

  /* rows: [[label, value],...] or string note. Returns card element. */
  function card(f, title, rows) {
    const body = $("resBody");
    const ph = body.querySelector(".placeholder"); if (ph) ph.remove();
    const el = document.createElement("div"); el.className = "res"; el.dataset.fid = f ? f.id : "";
    const nameHtml = f
      ? `<span class="rname" contenteditable="true" spellcheck="false" title="Click to rename">${esc(f.name || title)}</span>`
      : esc(title);
    el.innerHTML = `<h4>${nameHtml}
      <span class="acts"><span class="ic" data-a="fold" title="Fold this card to its headline"></span>${f ? `<span class="ic" data-a="zoom" title="Zoom to this feature">⌖</span>
      <span class="ic" data-a="edit" title="Edit vertices">✎</span>` : ""}
      <span class="ic" data-a="win" title="Open this card in a window"></span>
      <span class="ic x" data-a="del" title="Remove">✕</span></span></h4>
      <div class="rows">${rowsHtml(rows)}</div>`;
    /* v59: the title row folds and opens the card; the window button lifts it
       out. Both glyphs come from CSS `content`, not text: a card's title is
       read as `h4.textContent` by a dozen harness blocks and by the CSV, and
       must stay the words it was (the layer tree's toolbar does the same). */
    /* the state is read at the PRESS: the press also selects the feature,
       and selecting opens its card — a click that then toggled what it found
       would fold the card the same gesture had just opened */
    let wasFolded = false;
    el.addEventListener("mousedown", () => { wasFolded = el.classList.contains("folded"); }, true);
    el.querySelector("h4").addEventListener("click", e => {
      if (e.target.classList.contains("rname") || (e.target.closest(".acts") && !e.target.closest('[data-a="fold"]'))) return;
      fold(el, !wasFolded, true);
    });
    el.querySelector('[data-a="win"]').onclick = () => { if (wins.has(el)) toColumn(el); else toWindow(el); };
    el.querySelector('[data-a="del"]').onclick = () => { f ? SBMM.tools.deleteFeature(f) : el.remove(); checkEmpty(); };
    if (f) {
      el.classList.toggle("sel", SBMM.store.selected === f.id);
      el.addEventListener("mousedown", e => {
        if (e.target.closest(".acts") || e.target.classList.contains("rname")) return;
        SBMM.store.select(f.id);
      });
      el.querySelector('[data-a="zoom"]').onclick = () => { SBMM.store.select(f.id); SBMM.tools.zoomTo(f); };
      el.querySelector('[data-a="edit"]').onclick = () => SBMM.tools.editFeature(f);
      const rn = el.querySelector(".rname");
      rn.addEventListener("blur", () => { f.name = rn.textContent.trim() || f.name; SBMM.store.emit(); SBMM.store.autosave(); });
      rn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); rn.blur(); } });
      if (f.layer && f.layer.on) {
        f.layer.on("mouseover", () => el.classList.add("hl"));
        f.layer.on("mouseout", () => el.classList.remove("hl"));
      }
    }
    stampBackend(el);
    $("resBody").prepend(el);
    foldOthers(el);
    /* §3: running a computation brings the Results tab forward */
    if (SBMM.shell && SBMM.shell.showResults) SBMM.shell.showResults();
    return el;
  }
  /* v21 (docs/V21_WASM_SPEC.md section 3): a card that came out of a kernel
     says which core computed it. A card built by a job's own `.then` is built
     microtasks after js/jobs.js records the job, so a completion inside the
     last window is that card's job; a card built with no recent job (a measure
     that needs no kernel) gets no stamp at all. */
  const CORE_WINDOW_MS = 2000;
  function stampBackend(el) {
    const st = SBMM.compute && SBMM.compute.stats;
    if (!st || !st.lastBackend || !st.lastDoneAt) return;
    if (performance.now() - st.lastDoneAt > CORE_WINDOW_MS) return;
    const d = document.createElement("div");
    d.className = "note core";
    d.dataset.backend = st.lastBackend;
    d.textContent = st.lastKind + " computed by the " +
      (st.lastBackend === "wasm" ? "WebAssembly core" : "JavaScript kernels") +
      " in " + st.lastMs + " ms";
    el.appendChild(d);
  }

  function rowsHtml(rows) {
    if (typeof rows === "string") return `<div class="note">${rows}</div>`;
    /* r[2], when present, is a tooltip on the row — v23 §1: the detail a
       reader may want lives in a title attribute, not in a paragraph. */
    return rows.map((r, i) => `<div class="rrow ${i === 0 ? "big" : ""}"${r[2] ? ` title="${String(r[2]).replace(/"/g, "&quot;")}"` : ""}><span>${r[0]}</span><b>${r[1]}</b></div>`).join("");
  }
  function setRows(el, rows) { el.querySelector(".rows").innerHTML = rowsHtml(rows); }
  function appendNote(el, txt) {
    const d = document.createElement("div"); d.className = "note"; d.textContent = txt; el.appendChild(d); return d;
  }

  /* everything currently on the panel -> CSV text */
  function csv() {
    let out = "item,metric,value\n";
    /* every card, wherever it is: folded ones and the ones out in a window too */
    document.querySelectorAll("#resBody .res, .rswin .res").forEach(el => {
      const t = el.querySelector("h4").textContent.replace(/[⌖✎✕▾▸⧉]/g, "").trim();
      el.querySelectorAll(".rrow").forEach(r => {
        out += `"${t}","${r.children[0].textContent}","${r.children[1].textContent}"\n`;
      });
    });
    return out;
  }
  /* selecting a feature opens its card */
  function wire() {
    if (wire.done || !SBMM.store || !SBMM.store.onSelect) return;
    wire.done = true;
    SBMM.store.onSelect(() => {
      const id = SBMM.store.selected;
      if (id == null) return;
      document.querySelectorAll("#resBody .res").forEach(el => { if (el.dataset.fid === String(id)) fold(el, false); });
    });
  }
  return { card, setRows, appendNote, checkEmpty, csv, stampBackend, wire, fold, toWindow, toColumn,
           windows: () => wins.size };
})();
