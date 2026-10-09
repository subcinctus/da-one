// Pure sky math for the Sky system (owned by ATMOSPHERE): sun path, day/night factors and the colour palette.
// No DOM, no renderer: importable and unit-testable in Node.
//
// Orientation: east = +X, west = -X, north = -Z, south = +Z (map drawn with north up).
// The sun follows a real diurnal arc for latitude LAT with declination DECL (a long summer-ish day):
// sunrise ~5:25, noon elevation ~72° to the south, sunset ~18:35. The moon sits opposite the sun.
import * as THREE from 'three';

export const LAT = 32 * Math.PI / 180;
export const DECL = 14 * Math.PI / 180;
const SIN_LAT = Math.sin(LAT), COS_LAT = Math.cos(LAT);
const SIN_DEC = Math.sin(DECL), COS_DEC = Math.cos(DECL);

/** Celestial north pole direction (the axis the sky rotates around). */
export const POLE = new THREE.Vector3(0, SIN_LAT, -COS_LAT);

export const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Wrap hours into [0, 24). */
export const wrapHours = (h) => ((h % 24) + 24) % 24;

/** Hour angle (radians) for a time of day: 0 at noon, + in the afternoon. */
export const hourAngle = (hours) => (hours - 12) / 24 * Math.PI * 2;

/** Unit vector pointing at the sun for `hours` (0..24). */
export function sunDirection(hours, out = new THREE.Vector3()) {
  const H = hourAngle(hours);
  const cH = Math.cos(H), sH = Math.sin(H);
  const east = -COS_DEC * sH;
  const up = SIN_LAT * SIN_DEC + COS_LAT * COS_DEC * cH;
  const north = COS_LAT * SIN_DEC - SIN_LAT * COS_DEC * cH;
  return out.set(east, up, -north).normalize();
}

/** Sun elevation (sine, i.e. sunDir.y) at a time of day. */
export const sunElevation = (hours) => SIN_LAT * SIN_DEC + COS_LAT * COS_DEC * Math.cos(hourAngle(hours));

/** 0 at day, 1 at night; smooth through dusk and dawn (driven by sun elevation). */
export const nightFactorFromElevation = (e) => 1 - smooth(-0.16, 0.12, e);

/** Sunrise / sunset hours (sun centre crossing the horizon). */
export function sunriseSunset() {
  const c = -(SIN_LAT * SIN_DEC) / (COS_LAT * COS_DEC);
  const H = Math.acos(Math.max(-1, Math.min(1, c)));
  const hrs = H / (Math.PI * 2) * 24;
  return { sunrise: 12 - hrs, sunset: 12 + hrs };
}

// ---------------------------------------------------------------------------------------------------------------
// Palette keyframes by sun elevation e (= sunDir.y). Colours are sRGB hex, converted once to linear THREE.Colors.
//   zen      sky zenith            hor     horizon (also fog + clear colour)
//   glow     sun-side horizon glow anti    anti-solar twilight belt (pink)
//   sunCol   sun disc tint / directional light colour
//   hemiSky  hemisphere sky colour hemiGnd hemisphere ground colour
//   cloud    cloud base colour     cloudShade  colour of cloud undersides
const KEYS = [
  { e: -1.0, zen: 0x01030a, hor: 0x060b19, glow: 0x000000, anti: 0x000000, sunCol: 0xff6a30, hemiSky: 0x3a4f8f, hemiGnd: 0x0d1019, cloud: 0x1c2234, cloudShade: 0x10141f },
  { e: -0.32, zen: 0x020611, hor: 0x08112a, glow: 0x000000, anti: 0x000000, sunCol: 0xff6a30, hemiSky: 0x3a4f8f, hemiGnd: 0x0d1019, cloud: 0x1f2538, cloudShade: 0x121624 },
  { e: -0.14, zen: 0x060d26, hor: 0x18204a, glow: 0x2e1638, anti: 0x0e0c26, sunCol: 0xff6a30, hemiSky: 0x44508e, hemiGnd: 0x11131d, cloud: 0x2b2c48, cloudShade: 0x161729 },
  { e: -0.05, zen: 0x152657, hor: 0x5a3c66, glow: 0xb2462a, anti: 0x3a2a55, sunCol: 0xff5a28, hemiSky: 0x6a5c94, hemiGnd: 0x1c1820, cloud: 0x6a4a66, cloudShade: 0x352a44 },
  { e: 0.02, zen: 0x2c4a8c, hor: 0xe58552, glow: 0xff6a2a, anti: 0x8f5f95, sunCol: 0xff7a36, hemiSky: 0xc69a9a, hemiGnd: 0x4a3a34, cloud: 0xffa98a, cloudShade: 0x8a5a78 },
  { e: 0.10, zen: 0x3f69b5, hor: 0xf1b58a, glow: 0xffa25a, anti: 0xb98aa8, sunCol: 0xffb070, hemiSky: 0xd9c2b2, hemiGnd: 0x6a5a4c, cloud: 0xffdcc4, cloudShade: 0xb59aa6 },
  { e: 0.24, zen: 0x3f7ccf, hor: 0xb5d2ee, glow: 0xffe2b0, anti: 0x9ab2d8, sunCol: 0xffe4c0, hemiSky: 0xd5e4f6, hemiGnd: 0x7f705e, cloud: 0xffffff, cloudShade: 0xc8d0dc },
  { e: 0.55, zen: 0x3576d6, hor: 0xb4d4f3, glow: 0xfff3d8, anti: 0x9ab8e0, sunCol: 0xfff3e2, hemiSky: 0xdbe9fb, hemiGnd: 0x857664, cloud: 0xffffff, cloudShade: 0xccd4e0 },
  { e: 1.0, zen: 0x2e6fd4, hor: 0xb0d2f4, glow: 0xfff6e4, anti: 0x9ab8e0, sunCol: 0xfff6ea, hemiSky: 0xdeebfc, hemiGnd: 0x887866, cloud: 0xffffff, cloudShade: 0xcdd5e2 },
];
const COLOR_FIELDS = ['zen', 'hor', 'glow', 'anti', 'sunCol', 'hemiSky', 'hemiGnd', 'cloud', 'cloudShade'];
const LIN_KEYS = KEYS.map((k) => {
  const o = { e: k.e };
  for (const f of COLOR_FIELDS) o[f] = new THREE.Color(k[f]);
  return o;
});

// Rain/overcast tints (sRGB): day grey and night grey.
const RAIN_DAY = new THREE.Color(0x8d959f);
const RAIN_NIGHT = new THREE.Color(0x0d0f14);
const RAIN_CLOUD_DAY = new THREE.Color(0x9298a2);
const RAIN_CLOUD_NIGHT = new THREE.Color(0x15171d);
const _tmp = new THREE.Color();

/** Allocate a palette state object (reuse it with computeSkyState to avoid per-frame allocations). */
export function makeSkyState() {
  const s = {
    elevation: 0, nightFactor: 0, golden: 0, rain: 0,
    sunGlowAmt: 0, antiAmt: 0, starAmt: 0, sunVisible: 0, moonVisible: 0,
    sunIntensity: 0, moonIntensity: 0, hemiIntensity: 0, lightLevel: 1,
    fogScale: 1, cloudOpacity: 0.8,
  };
  for (const f of COLOR_FIELDS) s[f] = new THREE.Color();
  s.fog = new THREE.Color();
  s.ground = new THREE.Color();
  return s;
}

/**
 * Fill `s` with the sky look for sun elevation `e` (sunDir.y) and rain amount 0..1.
 * All colours are linear (THREE.Color working space). Returns s.
 */
export function computeSkyState(e, rain = 0, s = makeSkyState()) {
  // keyframe blend
  let i = 0;
  while (i < LIN_KEYS.length - 2 && e > LIN_KEYS[i + 1].e) i++;
  const a = LIN_KEYS[i], b = LIN_KEYS[i + 1];
  const t = Math.min(1, Math.max(0, (e - a.e) / (b.e - a.e)));
  for (const f of COLOR_FIELDS) s[f].copy(a[f]).lerp(b[f], t);

  const night = nightFactorFromElevation(e);
  s.elevation = e;
  s.nightFactor = night;
  s.rain = rain;
  // golden hour: peaks when the sun sits on the horizon
  s.golden = smooth(-0.14, 0.0, e) * (1 - smooth(0.06, 0.26, e));
  s.sunGlowAmt = (0.28 + 0.9 * s.golden) * smooth(-0.16, -0.02, e) * (1 - rain * 0.85);
  s.antiAmt = s.golden * (1 - rain);
  s.starAmt = smooth(0.3, 0.92, night) * (1 - rain * 0.95);
  s.sunVisible = smooth(-0.07, 0.01, e) * (1 - rain * 0.9);
  s.moonVisible = smooth(-0.07, 0.03, -e) * (1 - rain * 0.85);

  // lights: physically-based intensities (three r155+ non-legacy lights: π ≈ full albedo)
  s.sunIntensity = 1.85 * smooth(0.0, 0.3, e) * (1 - rain * 0.7);
  s.moonIntensity = 0.75 * smooth(0.0, 0.3, -e) * (1 - rain * 0.6);
  s.hemiIntensity = (1.75 + 0.3 * smooth(-0.2, 0.25, e)) * (1 - rain * 0.15);
  // overall brightness hint 0..1 for unlit FX (smoke) and other systems
  s.lightLevel = Math.max(0.16, 1 - 0.84 * night) * (1 - rain * 0.3);

  if (rain > 0) {
    const dayAmt = 1 - night;
    _tmp.copy(RAIN_NIGHT).lerp(RAIN_DAY, dayAmt);
    const k = rain * 0.78;
    s.zen.lerp(_tmp, k);
    s.hor.lerp(_tmp, k);
    s.hemiSky.lerp(_tmp, k * 0.6);
    _tmp.copy(RAIN_CLOUD_NIGHT).lerp(RAIN_CLOUD_DAY, dayAmt);
    s.cloud.lerp(_tmp, rain * 0.85);
    s.cloudShade.copy(s.cloud).multiplyScalar(0.62);
  }
  s.fog.copy(s.hor);
  s.ground.copy(s.hor).multiplyScalar(0.82);
  s.fogScale = 1 - rain * 0.32;
  s.cloudOpacity = 0.8 + rain * 0.16;
  return s;
}

/** Format hours as "HH:MM". */
export function formatClock(hours) {
  const h = wrapHours(hours);
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}
