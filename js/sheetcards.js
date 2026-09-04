/* SBMM Site Explorer — the Sheets tab (docs/V9_SPEC.md §3).

   Twenty drawing cards in the left dock, each with a thumbnail, the sheet
   number, what it shows and which lot it belongs to; filter by lot; click one
   to open it in the floating viewer js/sheets.js already provides.

   Thumbnails are made on FIRST OPEN of the tab, not at build time and not at
   boot. The full-sheet renders are ~27 MB of JPEG between them and each one is
   a 4000 px page; drawing twenty of those into 168 px canvases costs about a
   fifth of a second, once, and only for someone who actually opens the tab.
   Doing it at build time would have meant twenty more payload files and twenty
   more <script> tags in index.html for a picture the app can derive.

   They are decoded through createImageBitmap for the same reason js/dem.js is
   (see CLAUDE.md): `new Image()` on a data-URL re-parses the base64 through the
   resource loader, and twenty sheets is exactly where that becomes visible. */
"use strict";

SBMM.sheetCards = (function () {

  const TH_W = 168;
  let made = false, lot = "";
  const thumbs = new Map();          // sheet -> data URL

  function all() { return (SBMM.sheets && SBMM.sheets.index()) || []; }

  /* The lot a sheet is about, from the subject line EA's own title blocks
     carry ("Lot 25", "Lots 1, 5 and 7", "North Lobe"). Sheets with no lot fall
     under "general" rather than being hidden by a lot filter. */
  function lotOf(s) {
    const t = (s.subject || s.title || "");
    const m = /\bLots?\s*([0-9]+(?:\s*,\s*[0-9]+)*(?:\s*(?:and|&)\s*[0-9]+)?)/i.exec(t);
    if (m) return "Lot " + m[1].replace(/\s*(and|&)\s*/i, ", ").replace(/\s+/g, " ");
    if (/north\s*lobe/i.test(t)) return "North Lobe";
    if (/borrow/i.test(t)) return "Borrow area";
    if (/staging/i.test(t)) return "Staging area";
    if (/repositor/i.test(t)) return "Repository";
    if (/southern\s*residence/i.test(t)) return "Southern Residence";
    if (/southwest/i.test(t)) return "Southwest Lot";
    if (/northwest/i.test(t)) return "Northwest Lot";
    return "General";
  }

  async function thumbOf(s) {
    if (thumbs.has(s.sheet)) return thumbs.get(s.sheet);
    try {
      const url = s.url;
      const comma = url.indexOf(",");
      const bin = atob(url.slice(comma + 1));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const type = /^data:([^;]+)/.exec(url);
      const bmp = await createImageBitmap(new Blob([u8], { type: type ? type[1] : "image/jpeg" }));
      const h = Math.max(1, Math.round(TH_W * bmp.height / bmp.width));
      const c = document.createElement("canvas");
      c.width = TH_W; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, TH_W, h);
      g.drawImage(bmp, 0, 0, TH_W, h);
      bmp.close && bmp.close();
      const out = c.toDataURL("image/jpeg", 0.72);
      thumbs.set(s.sheet, out);
      return out;
    } catch (e) {
      thumbs.set(s.sheet, null);
      return null;
    }
  }

  function render() {
    const host = document.getElementById("sheetCards");
    if (!host) return;
    const list = all().filter(s => !lot || lotOf(s) === lot);
    const cnt = document.getElementById("shPaneCount");
    if (cnt) cnt.textContent = `${list.length} of ${all().length}`;
    if (!list.length) {
      host.innerHTML = `<div class="pnone">No sheet for that lot.</div>`;
      return;
    }
    /* A card with no render still earns its place: the FIELD build ships the
       manifest without the 20 page JPEGs, so the tab lists the whole drawing
       set, shows an empty frame instead of a thumbnail, and says why. Clicking
       it raises the toast js/sheets.js `open()` already writes. */
    host.innerHTML = list.map(s => `
      <div class="shcard${s.url ? "" : " norender"}" data-sheet="${esc(s.sheet)}" tabindex="0"
           title="${s.url ? "Open " + esc(s.sheet) + " — " + esc(s.title || "")
                          : esc(s.sheet) + " — no full-sheet render in this build"}">
        <div class="shthumb">${s.url
          ? `<img alt="${esc(s.sheet)} thumbnail" src="${thumbs.get(s.sheet) || ""}">`
          : `<span class="shnone">no render<br>in this build</span>`}</div>
        <div class="shmeta">
          <div class="shhead"><b>${esc(s.sheet)}</b>
            ${s.design_set === "90%" ? '<span class="warnpill">90%</span>' : ""}
            ${!s.url ? '<span class="dimpill" title="The full-sheet plan renders are left out of the field build; the design geometry is not">no render</span>'
              : s.registered ? '<span class="okpill" title="Georeferenced — this sheet is placed on the map">placed</span>'
                           : '<span class="dimpill" title="Not georeferenced: readable here, not placed on the map">viewer only</span>'}
          </div>
          <i>${esc(s.subject || s.title || "")}</i>
          ${lotOf(s) === (s.subject || "") ? "" : `<span class="mut">${esc(lotOf(s))}</span>`}
        </div>
      </div>`).join("");
    host.querySelectorAll(".shcard").forEach(c => {
      const openIt = () => SBMM.sheets.open(c.dataset.sheet);
      c.onclick = openIt;
      c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } };
      /* hovering a card lights that sheet's footprint on the map, so the
         answer to "where is this one?" needs no click at all (F1). Focus does
         the same thing, for the keyboard. */
      const hot = on => SBMM.designEA && SBMM.designEA.hotFootprint
        && SBMM.designEA.hotFootprint(on ? c.dataset.sheet : null);
      c.onmouseenter = () => hot(true);
      c.onmouseleave = () => hot(false);
      c.onfocus = () => hot(true);
      c.onblur = () => hot(false);
    });
  }

  /* Built on first open of the tab (js/shell.js calls this), then cached. */
  async function ensure() {
    if (made) { render(); return; }
    made = true;
    const list = all();
    const sel = document.getElementById("shLotFilter");
    if (sel) {
      const lots = [...new Set(list.map(lotOf))].sort((a, b) => {
        const na = /^Lot (\d+)/.exec(a), nb = /^Lot (\d+)/.exec(b);
        if (na && nb) return +na[1] - +nb[1];
        if (na) return -1;
        if (nb) return 1;
        return a.localeCompare(b);
      });
      sel.innerHTML = `<option value="">all</option>`
        + lots.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
      sel.onchange = () => { lot = sel.value; render(); };
    }
    render();                      // frames first, pictures as they arrive
    for (const s of list) {
      if (!s.url) continue;              // nothing to derive a thumbnail from
      await thumbOf(s);
      const img = document.querySelector(`.shcard[data-sheet="${CSS.escape(s.sheet)}"] img`);
      if (img && thumbs.get(s.sheet)) img.src = thumbs.get(s.sheet);
    }
  }

  function wire() {
    const b = document.getElementById("sheetsTopBtn");
    if (b) b.onclick = () => { SBMM.shell.setTab("sheets"); };
  }

  return { wire, ensure, render, lotOf, thumbs };
})();
