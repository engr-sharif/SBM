/* SBMM Site Explorer — the sky and the light (v40).

   Before this the 3D view sat under a fixed dark gradient and was lit by two
   lights whose strengths had been chosen by eye: a sunlit, level piece of
   ground came out at about HALF the brightness of the photograph draped on
   it, and nothing cast a shadow.

   This file owns the daylight. Everything is a function of ONE input — where
   the sun is (the View settings' azimuth / elevation control) — so the sky,
   the colour and strength of the sunlight, the fill light from the sky, and
   the haze towards the horizon always agree with each other:

     sky(dir)        the dome's colour in a direction: deep blue overhead,
                     pale at the horizon, warm and bright around the sun, and
                     reddening as the sun gets low. Evaluated per pixel by the
                     dome's shader, and by horizonColour() in JavaScript with
                     the same numbers, so the fog is the horizon's own colour.
     light(el)       the sun's colour and strength and the sky fill, balanced
                     so that level ground in full sun renders at the albedo of
                     whatever is draped on it, and ground in shadow at about
                     half of that.

   It is an analytic sky, not a simulation: two colours per sun elevation and
   a glow around the sun. That is deliberate — it is a handful of arithmetic
   per pixel, it needs no lookup texture and no file, and it cannot produce a
   colour nobody chose.

   three r160 lights are physical (useLegacyLights is off): a Lambert surface
   returns albedo x irradiance / pi. The strengths below are in those units. */
"use strict";

SBMM.atmos3d = (function () {

  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  /* the palette, linear RGB. "day" is a sun well up; "low" is the last of it. */
  const ZEN_DAY = [0.105, 0.245, 0.60], ZEN_LOW = [0.035, 0.060, 0.170];
  const HOR_DAY = [0.560, 0.700, 0.860], HOR_LOW = [0.520, 0.300, 0.200];
  const SUN_DAY = [1.00, 0.955, 0.880], SUN_LOW = [1.00, 0.600, 0.330];

  /* sz = sin(sun elevation) */
  const dayness = sz => sstep(0.02, 0.42, sz);
  function zenith(sz) { return mix3(ZEN_LOW, ZEN_DAY, dayness(sz)); }
  function horizon(sz) { return mix3(HOR_LOW, HOR_DAY, dayness(sz)); }

  /* THE SKY AS A FUNCTION, shared: the dome draws it, and the water
     (js/water3d.js) reflects it — so a lake reflects the sky that is actually
     overhead, at whatever hour the sun control says it is. */
  const GLSL_SKY_FN = `
    vec3 atmosMix(vec3 a, vec3 b, float t) { return a + (b - a) * t; }
    vec3 atmosSky(vec3 v, vec3 sun, float disc) {
      float sz = sun.z;
      float day = smoothstep(0.02, 0.42, sz);
      vec3 zen = atmosMix(vec3(${ZEN_LOW.join(",")}), vec3(${ZEN_DAY.join(",")}), day);
      vec3 hor = atmosMix(vec3(${HOR_LOW.join(",")}), vec3(${HOR_DAY.join(",")}), day);
      vec3 sunc = atmosMix(vec3(${SUN_LOW.join(",")}), vec3(${SUN_DAY.join(",")}), day);
      float h = max(v.z, 0.0);
      /* overhead to horizon: most of the change happens in the lowest fifteen degrees */
      vec3 col = atmosMix(hor, zen, pow(h, 0.42));
      float mu = max(dot(v, sun), 0.0);
      /* the forward-scattering glow, wide and then tight, strongest low in the sky */
      col += sunc * (0.10 * pow(mu, 6.0) + 0.35 * pow(mu, 48.0)) * (1.0 - 0.55 * h);
      /* the disc */
      col += sunc * 6.0 * disc * smoothstep(0.99955, 0.99985, mu);
      /* under the horizon: the haze the fog fades the ground into, a little darker further down */
      if (v.z < 0.0) col = atmosMix(hor, hor * 0.72, clamp(-v.z * 4.0, 0.0, 1.0));
      return col;
    }`;
  const GLSL_SKY = `
    uniform vec3 uSun;
    varying vec3 vDir;
    ${GLSL_SKY_FN}
    void main() {
      gl_FragColor = vec4(atmosSky(normalize(vDir), uSun, 1.0), 1.0);
      #include <colorspace_fragment>
    }`;

  function buildSky(R) {
    const geo = new THREE.SphereGeometry(R, 32, 20);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: new THREE.Vector3(0, 0, 1) } },
      vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: GLSL_SKY,
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false
    });
    /* after the terrain and before anything transparent, for the reason the
       old dome was: a sky drawn first is a full-screen fill the terrain then
       paints over */
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1000;
    m.frustumCulled = false;
    m.userData.atmosSky = true;
    return m;
  }

  /* the unit vector TOWARDS the sun, scene axes (x east, y north, z up) */
  function sunDir(azDeg, elDeg, out) {
    const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
    return (out || new THREE.Vector3()).set(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
  }

  /* THE LIGHT for a sun at that elevation — v57.

     One rule sets its level: **level ground, in the sun, at the elevation the
     aerial photograph was taken (REF_EL), receives exactly pi** — so a Lambert
     surface there returns exactly its own colour. A roof takes the colour the
     photograph gave it, a tree the colour it was given from the photograph,
     and nothing is "0.77 of itself" (which is what v40's 2.7 / 1.15 came to
     once the sky's colour and the fill's direction were counted — it read as
     a quarter darker than the map).

     The SHAPE is v40's: the sun's share of the light on level ground is a
     little over half, so ground in shadow is a little under half its sunlit
     neighbour; a lower sun is weaker and warmer. Only the level moved.

     There is still no tone-mapping curve: the drapes are photographs and the
     analysis layers are colour scales. The photograph itself is not lit by
     these numbers at all — see relightUniforms() in js/viewer3d.js: it is
     shown as photographed and RE-lit by the ratio of this light to the light
     it was photographed in. */
  const REF_EL = 33;
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  function shape(elDeg) {
    const sz = Math.sin(elDeg * Math.PI / 180), day = dayness(sz);
    const sunc = mix3(SUN_LOW, SUN_DAY, day);
    const z = zenith(sz), h = horizon(sz);
    /* the fill is the sky's own colour, lifted towards white: a blue fill at
       full saturation turns every shadow navy */
    const sky = mix3([(z[0] + h[0]) / 2, (z[1] + h[1]) / 2, (z[2] + h[2]) / 2], [1, 1, 1], 0.55);
    const k = Math.max(sky[0], sky[1], sky[2]);
    return { sz, sunc, sky: [sky[0] / k, sky[1] / k, sky[2] / k],
             sunI: lerp(1.6, 2.7, sstep(0.05, 0.45, sz)), hemiI: lerp(0.85, 1.15, day) };
  }
  const LEVEL_K = (() => { const s = shape(REF_EL);
    return Math.PI / (s.sunI * lum(s.sunc) * s.sz + s.hemiI * lum(s.sky)); })();
  function light(elDeg) {
    const s = shape(elDeg);
    return {
      sun: new THREE.Color().setRGB(s.sunc[0], s.sunc[1], s.sunc[2]),
      sunIntensity: s.sunI * LEVEL_K,
      sky: new THREE.Color().setRGB(s.sky[0], s.sky[1], s.sky[2]),
      ground: new THREE.Color().setRGB(0.46, 0.43, 0.37),
      hemiIntensity: s.hemiI * LEVEL_K
    };
  }
  /* what level ground receives from that light, as a share of pi (1 at REF_EL) */
  function levelOf(elDeg) {
    const s = shape(elDeg);
    return LEVEL_K * (s.sunI * lum(s.sunc) * s.sz + s.hemiI * lum(s.sky)) / Math.PI;
  }

  function horizonColour(elDeg, out) {
    const h = horizon(Math.sin(elDeg * Math.PI / 180));
    return (out || new THREE.Color()).setRGB(h[0], h[1], h[2]);
  }

  return { buildSky, sunDir, light, levelOf, REF_EL, LEVEL_K, horizonColour, zenith, horizon, GLSL_SKY_FN,
           dayness: elDeg => dayness(Math.sin(elDeg * Math.PI / 180)) };
})();
