/* SBMM Site Explorer — the Layer manager (docs/V9_SPEC.md §6).

   The Layers tree works in the app's vocabulary: "Limits of excavation",
   "Fences", "Block symbols". EA's drawings work in theirs: 110 CAD layer names
   like `C-SITE-TRNS-DYLIGHT-LOT25` and `V-TOPO-MAJR-TEXT`. Both are right, and
   a Civil 3D user needs the second one when the question is "what IS that line
   and which file did it come from".

   So this dialog is one level below the tree: search the CAD layer names,
   switch one on or off, recolour it, set its opacity, and read where it came
   from — source file, feature count, entity kinds, and a real entity handle you
   can type into AutoCAD to find the same object in EA's own drawing. "Reset to
   defaults" puts every override back and returns the 21 groups to their shipped
   visibility (with the R1 ruling on `exc` still applied — that is a default,
   not an override).

   Overrides live in js/cadnative.js, not here: closing the dialog must not
   forget them, and a group whose geometry is rendered later has to pick them
   up. */
"use strict";

SBMM.layerMan = (function () {

  let box = null, q = "", onlyOn = false;

  function open() {
    if (!SBMM.CadNative || !SBMM.CadNative.layers || !SBMM.CadNative.layers.length) {
      toast("this build has no native CAD payload to manage");
      return;
    }
    if (box) { box.querySelector("#lmQ").focus(); return; }
    box = document.createElement("div");
    box.className = "modal"; box.id = "layerMan";
    box.innerHTML = `<div class="mbox lmbox">
      <div class="mhd">Layer manager <span class="mut">— EA native CAD, ${SBMM.CadNative.layers.length} layers</span>
        <span class="spacer"></span>
        <button class="minib" id="lmReset" title="Undo every colour, opacity and visibility override and put the groups back to their shipped defaults">reset to defaults</button>
        <span class="ic x" id="lmX" title="Close (Esc)">✕</span></div>
      <div class="lmtools">
        <span class="lmsearch"><svg class="ic16"><use href="#i-search"/></svg>
          <input id="lmQ" placeholder="search layer, group or source file…" spellcheck="false" autocomplete="off"></span>
        <label class="mut"><input type="checkbox" id="lmOnly"> only layers that are on</label>
        <span class="spacer"></span>
        <span class="mut mono" id="lmCount"></span>
      </div>
      <div class="mbody lmbody"><table class="lmtable">
        <thead><tr>
          <th class="c-on" title="Show or hide this CAD layer"></th>
          <th>CAD layer</th><th>Group</th>
          <th class="num">Features</th><th>Colour</th><th>Opacity</th><th>Source</th>
        </tr></thead><tbody id="lmRows"></tbody></table></div>
      <div class="mfoot"><span class="mut">A layer's group has to be on for the layer to draw —
        the group is the row in the Layers tree; this is the layer inside it.</span></div>
    </div>`;
    document.body.appendChild(box);

    const shut = () => { document.removeEventListener("keydown", onKey, true); box.remove(); box = null; };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(); } };
    document.addEventListener("keydown", onKey, true);
    box.querySelector("#lmX").onclick = shut;
    box.addEventListener("click", e => { if (e.target === box) shut(); });
    box.querySelector("#lmQ").addEventListener("input", e => { q = e.target.value.trim().toLowerCase(); rows(); });
    box.querySelector("#lmOnly").addEventListener("change", e => { onlyOn = e.target.checked; rows(); });
    box.querySelector("#lmReset").onclick = () => {
      const n = SBMM.CadNative.resetLayerOverrides();
      rows();
      toast(n ? `${n} layer override${n === 1 ? "" : "s"} cleared — groups back to defaults` : "layers were already at their defaults");
    };
    rows();
    setTimeout(() => box.querySelector("#lmQ").focus(), 20);
  }

  function groupOn(gkey) {
    return SBMM.layerState.isOn(SBMM.CadNative.sectionOf(gkey), "cad_" + gkey);
  }

  function rows() {
    if (!box) return;
    const host = box.querySelector("#lmRows");
    const all = SBMM.CadNative.layers;
    const list = all.filter(l => {
      if (onlyOn && !(groupOn(l.group) && SBMM.CadNative.layerOverride(l.layer).on !== false)) return false;
      if (!q) return true;
      return l.layer.toLowerCase().includes(q)
        || (l.label || "").toLowerCase().includes(q)
        || (l.group || "").toLowerCase().includes(q)
        || (l.files || []).some(f => f.toLowerCase().includes(q));
    }).sort((a, b) => b.count - a.count || a.layer.localeCompare(b.layer));

    box.querySelector("#lmCount").textContent =
      `${list.length} of ${all.length} layers · ${fmt0(list.reduce((s, l) => s + l.count, 0))} features`;

    if (!list.length) {
      host.innerHTML = `<tr><td colspan="7" class="mut" style="padding:16px">No CAD layer matches “${esc(q)}”.</td></tr>`;
      return;
    }
    host.innerHTML = list.map(l => {
      const o = SBMM.CadNative.layerOverride(l.layer);
      const on = o.on !== false;
      const gOn = groupOn(l.group);
      const col = o.color || l.color || "#cccccc";
      const op = o.opacity == null ? 1 : o.opacity;
      const kinds = Object.entries(l.kinds || {}).map(([k, v]) => `${k} ${fmt0(v)}`).join(" · ");
      return `<tr data-ly="${esc(l.layer)}"${gOn ? "" : ' class="gdim"'}>
        <td class="c-on"><input type="checkbox" class="lmon"${on ? " checked" : ""}
          title="${on ? "Hide" : "Show"} ${esc(l.layer)}"></td>
        <td class="c-name"><b class="mono">${esc(l.layer)}</b>
          <i class="mut">${esc(kinds)}</i></td>
        <td class="c-grp"><button class="minib lmgrp" title="${gOn ? "Switch this group off" : "Switch this group on"} in the Layers tree">${esc(l.label)}</button>
          ${gOn ? "" : '<span class="mut lmoff" title="The group is off, so nothing on this layer draws">group off</span>'}</td>
        <td class="num mono">${fmt0(l.count)}</td>
        <td><input type="color" class="lmcol" value="${hexOf(col)}" title="Recolour this layer"></td>
        <td><input type="range" class="lmop" min="0" max="100" value="${Math.round(op * 100)}" title="Layer opacity"></td>
        <td class="c-src mut">${esc((l.files || []).join(", "))}
          <button class="minib lminfo" title="Source file, feature count and a real entity handle">info</button></td>
      </tr>`;
    }).join("");

    host.querySelectorAll("tr[data-ly]").forEach(tr => {
      const name = tr.dataset.ly;
      tr.querySelector(".lmon").onchange = e => {
        SBMM.CadNative.setLayerOverride(name, { on: e.target.checked });
      };
      tr.querySelector(".lmcol").oninput = e => SBMM.CadNative.setLayerOverride(name, { color: e.target.value });
      tr.querySelector(".lmop").oninput = e => SBMM.CadNative.setLayerOverride(name, { opacity: e.target.value / 100 });
      tr.querySelector(".lmgrp").onclick = () => {
        const info = SBMM.CadNative.layerInfo(name);
        const sec = SBMM.CadNative.sectionOf(info.group);
        SBMM.layerState.set(sec, "cad_" + info.group, { on: !groupOn(info.group) });
        rows();
      };
      tr.querySelector(".lminfo").onclick = () => info(name);
    });
  }

  /* Everything known about one layer, including a handle that can be typed into
     AutoCAD's own selection tools to find the same entity in EA's drawing. */
  function info(name) {
    const i = SBMM.CadNative.layerInfo(name);
    if (!i) { toast("no record for " + name); return; }
    const kinds = Object.entries(i.kinds).map(([k, v]) => `${k} ${fmt0(v)}`).join(" · ") || "—";
    const rows = [
      ["CAD layer", i.layer],
      ["UI group", i.label + " (" + i.group + ")"],
      ["Features", fmt0(i.count)],
      ["Entity kinds", kinds],
      ["Source file", i.file || (i.files || []).join(", ") || "—"],
      ["Also in", (i.files || []).length > 1 ? i.files.join(", ") : "—"],
      ["Sample handle", i.handle || "— (no handle recorded)"],
      ["Rendered", i.rendered ? "yes" : "not yet — the group has not been switched on"]
    ];
    const d = document.createElement("div");
    d.className = "modal"; d.style.zIndex = "5700";
    d.innerHTML = `<div class="mbox" style="width:460px">
      <div class="mhd">${esc(i.layer)}<span class="spacer"></span><span class="ic x" data-x="1">✕</span></div>
      <div class="mbody">${SBMM.popups.attrTable(rows)}
        <p class="mut" style="margin-top:8px">The handle is EA's own entity handle from the DWG —
        type it into AutoCAD to select the same object in the source drawing.</p></div>
      <div class="mfoot"><span class="spacer"></span>
        <button class="minib" data-copy="1">Copy handle</button>
        <button class="minib prim" data-x="1">Close</button></div></div>`;
    document.body.appendChild(d);
    const shut = () => { d.remove(); document.removeEventListener("keydown", k, true); };
    const k = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); shut(); } };
    document.addEventListener("keydown", k, true);
    d.addEventListener("click", e => {
      if (e.target === d || e.target.closest("[data-x]")) { shut(); return; }
      if (e.target.closest("[data-copy]")) {
        if (i.handle) copyText(i.handle, "handle " + i.handle + " copied");
        else toast("no handle was recorded for " + i.layer);
      }
    });
  }

  /* an <input type=color> needs #rrggbb and CAD colours arrive in every form */
  function hexOf(c) {
    if (!c) return "#cccccc";
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c.slice(1).split("").map(x => x + x).join("").toLowerCase();
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(",").map(Number);
      return "#" + p.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
    }
    return "#cccccc";
  }

  function wire() {
    const b = document.getElementById("layerManBtn");
    if (b) b.onclick = e => { e.stopPropagation(); open(); };
  }

  return { wire, open, isOpen: () => !!box };
})();
