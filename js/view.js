/* SBMM Site Explorer — remembering where you were (planner ruling F11).

   Two views, one store. The 2D map's centre and zoom, and the 3D camera's
   orbit target and spherical offset, are written to localStorage as they
   change and read back on the next boot.

   Three rules, because a remembered view is a convenience and must never be
   the reason the app fails to open:

     * **Every read is guarded and every failure is silent.** localStorage
       throws in private windows and under some file:// policies; a stored
       value can be stale, from another site window, or written by an older
       build. Anything that is not a finite number inside the survey is
       discarded and the caller falls back to its own default framing.
     * **Writes are debounced and passive.** Panning the map fires `moveend`
       on every gesture and the 3D camera settles over ~30 frames; neither is
       allowed to touch localStorage more than once a second.
     * **It is per-browser convenience, not a record.** The session file is
       where a view belongs when it has to travel; nothing here is serialised
       into one, and clearing site data simply puts the defaults back. */
"use strict";

SBMM.view = (function () {

  const STORE = "sbmm_view_v9";
  const WRITE_MS = 900;

  let pending = null, timer = null;

  function read() {
    try {
      const o = JSON.parse(localStorage.getItem(STORE) || "null");
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }
  function write(patch) {
    pending = Object.assign(pending || read(), patch);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const o = pending; pending = null;
      try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) { /* file:// */ }
    }, WRITE_MS);
  }
  function num(v) { return typeof v === "number" && isFinite(v); }

  /* ------------------------------------------------------------------ */
  /* 2D                                                                  */
  /* ------------------------------------------------------------------ */
  /* A stored centre is only honoured if it is inside the survey: the app is a
     CRS.Simple map in State Plane feet, so a value from another origin would
     put the user in empty space with no landmark to navigate back from. */
  function restore2d() {
    const v = read().map2d;
    if (!v || !num(v.x) || !num(v.y) || !num(v.z)) return false;
    const b = SBMM.demSite.bounds();          // [[y0,x0],[y1,x1]]
    const pad = 4000;                          // a little outside is fine; another datum is not
    if (v.x < b[0][1] - pad || v.x > b[1][1] + pad || v.y < b[0][0] - pad || v.y > b[1][0] + pad) return false;
    const z = Math.max(SBMM.map.getMinZoom(), Math.min(SBMM.map.getMaxZoom(), v.z));
    try { SBMM.map.setView([v.y, v.x], z, { animate: false }); }
    catch (e) { return false; }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  /* The 3D camera is stored in the same survey terms the rest of the app uses
     — an orbit target in State Plane feet plus radius, bearing and pitch — not
     in scene coordinates, which move with the exaggeration slider and the
     scene's own centring constants. */
  function save3d(cam) {
    if (!cam || !num(cam.x) || !num(cam.y) || !num(cam.r)) return;
    write({ cam3d: { x: cam.x, y: cam.y, z: cam.z, r: cam.r, theta: cam.theta, phi: cam.phi } });
  }
  function stored3d() {
    const v = read().cam3d;
    if (!v || !num(v.x) || !num(v.y) || !num(v.r) || !num(v.theta) || !num(v.phi)) return null;
    const b = SBMM.demSite.bounds();
    if (v.x < b[0][1] - 4000 || v.x > b[1][1] + 4000 || v.y < b[0][0] - 4000 || v.y > b[1][0] + 4000) return null;
    return v;
  }

  /* ------------------------------------------------------------------ */
  function watch() {
    if (!SBMM.map) return;
    const save = () => {
      const c = SBMM.map.getCenter();
      write({ map2d: { x: c.lng, y: c.lat, z: SBMM.map.getZoom() } });
    };
    SBMM.map.on("moveend zoomend", save);
  }

  return { restore2d, watch, save3d, stored3d, read };
})();
