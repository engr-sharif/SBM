/* SBMM Site Explorer — results panel cards */
"use strict";

SBMM.results = (function () {
  function checkEmpty() {
    const body = $("resBody");
    if (!body.querySelector(".res") && !body.querySelector(".placeholder"))
      body.innerHTML = '<div class="placeholder">Pick a tool and draw on the map.</div>';
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
      <span class="acts">${f ? `<span class="ic" data-a="zoom" title="Zoom to this feature">⌖</span>
      <span class="ic" data-a="edit" title="Edit vertices">✎</span>` : ""}
      <span class="ic x" data-a="del" title="Remove">✕</span></span></h4>
      <div class="rows">${rowsHtml(rows)}</div>`;
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
    $("resBody").prepend(el);
    /* §3: running a computation brings the Results tab forward */
    if (SBMM.shell && SBMM.shell.showResults) SBMM.shell.showResults();
    return el;
  }
  function rowsHtml(rows) {
    if (typeof rows === "string") return `<div class="note">${rows}</div>`;
    return rows.map((r, i) => `<div class="rrow ${i === 0 ? "big" : ""}"><span>${r[0]}</span><b>${r[1]}</b></div>`).join("");
  }
  function setRows(el, rows) { el.querySelector(".rows").innerHTML = rowsHtml(rows); }
  function appendNote(el, txt) {
    const d = document.createElement("div"); d.className = "note"; d.textContent = txt; el.appendChild(d); return d;
  }

  /* everything currently on the panel -> CSV text */
  function csv() {
    let out = "item,metric,value\n";
    document.querySelectorAll("#resBody .res").forEach(el => {
      const t = el.querySelector("h4").textContent.replace(/[⌖✎✕]/g, "").trim();
      el.querySelectorAll(".rrow").forEach(r => {
        out += `"${t}","${r.children[0].textContent}","${r.children[1].textContent}"\n`;
      });
    });
    return out;
  }
  return { card, setRows, appendNote, checkEmpty, csv };
})();
