/* SBMM Site Explorer — local State Plane <-> WGS84 affine (±1 ft over the site) */
"use strict";

SBMM.toLL = function (x, y) {
  const a = SBMM.AFF;
  return [a.lon[0] * x + a.lon[1] * y + a.lon[2], a.lat[0] * x + a.lat[1] * y + a.lat[2]]; // [lon,lat]
};
SBMM.fromLL = function (lon, lat) {
  const a = SBMM.AFF;
  // solve [lon-c; lat-f] = [[a b];[d e]] [x;y]
  const A = a.lon[0], B = a.lon[1], C = a.lon[2];
  const D = a.lat[0], E = a.lat[1], F = a.lat[2];
  const det = A * E - B * D;
  const u = lon - C, v = lat - F;
  return [(E * u - B * v) / det, (A * v - D * u) / det]; // [x,y] SP ft
};
/* Parse a user coordinate string: "E, N" (State Plane ft) or "lat, lon" (WGS84).
   Returns [x, y] SP or null. */
SBMM.parseCoord = function (s) {
  const m = String(s).trim().split(/[\s,;]+/).map(Number).filter(v => !isNaN(v));
  if (m.length < 2) return null;
  let [a, b] = m;
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > 90) return SBMM.fromLL(b, a);      // lat, lon
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180 && Math.abs(a) > 90) return SBMM.fromLL(a, b);      // lon, lat
  if (a > 1e5 && b > 1e5) return a > 6e6 ? [a, b] : [b, a];                                       // E,N or N,E
  return null;
};
