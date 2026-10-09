// Sky visual building blocks (owned by ATMOSPHERE): gradient dome, square voxel sun + moon (with 8 phases), stars.
// Pure three.js (DataTextures, no canvas) so it also constructs in Node.
import * as THREE from 'three';

export const DOME_RADIUS = 900;
export const SUN_DISTANCE = 780;
export const STAR_RADIUS = 820;

// ---------------------------------------------------------------------------------------------------------------
// Dome
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const DOME_FRAG = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uGlow;
uniform vec3 uAnti;
uniform vec3 uMoonGlow;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uGlowAmt;
uniform float uAntiAmt;
uniform float uMoonAmt;
uniform float uFlash;
uniform float uUnder;
uniform vec3 uUnderColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float up = max(h, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.5));
  col = mix(col, uGround, 1.0 - smoothstep(-0.28, 0.0, h));
  // horizon band shared by the twilight effects
  float band = pow(1.0 - min(abs(h), 1.0), 5.0);
  vec2 hd = normalize(d.xz + vec2(1e-5));
  vec2 hs = normalize(uSunDir.xz + vec2(1e-5));
  float az = dot(hd, hs);
  float sd = max(dot(d, uSunDir), 0.0);
  // warm glow around the sun + along the horizon on the sun side
  col += uGlow * uGlowAmt * (pow(sd, 6.0) * 0.55 + pow(max(az, 0.0), 2.5) * band * 0.75 + pow(sd, 48.0) * 0.6);
  // pink anti-solar belt (belt of Venus) at twilight
  col += uAnti * uAntiAmt * pow(max(-az, 0.0), 1.5) * band * 0.55;
  // soft moon halo
  col += uMoonGlow * uMoonAmt * (pow(max(dot(d, uMoonDir), 0.0), 18.0) * 0.18 + pow(max(dot(d, uMoonDir), 0.0), 220.0) * 0.25);
  col += vec3(0.62, 0.66, 0.85) * uFlash;
  col = mix(col, uUnderColor, uUnder);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // ordered-ish dithering to hide 8-bit banding in the gradient
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor.rgb += (n - 0.5) / 255.0;
}`;

export function createDome() {
  const geo = new THREE.SphereGeometry(DOME_RADIUS, 32, 20);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uAnti: { value: new THREE.Color() },
      uMoonGlow: { value: new THREE.Color(0x8aa0d8) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uGlowAmt: { value: 0 },
      uAntiAmt: { value: 0 },
      uMoonAmt: { value: 0 },
      uFlash: { value: 0 },
      uUnder: { value: 0 },
      uUnderColor: { value: new THREE.Color(0x0b2a4a) },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'skyDome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
// Pixel-art textures (RGBA DataTextures, nearest filtering, sRGB).
function makeTex(w, h, fill) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fill(x, y);
      const i = ((h - 1 - y) * w + x) * 4; // DataTexture row 0 = bottom
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3] === undefined ? 255 : c[3];
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 32x32 square sun: a hot core with a 2px rim and a stepped square halo (additive: black = transparent). */
function sunTexture() {
  const N = 32, c = (N - 1) / 2;
  return makeTex(N, N, (x, y) => {
    const d = Math.max(Math.abs(x - c), Math.abs(y - c)); // Chebyshev distance -> square shapes
    if (d <= 4.5) return [255, 252, 228];
    if (d <= 6.5) return [255, 226, 128];
    // stepped halo (quantised to 2px bands for a pixel look)
    const q = Math.floor((d - 6.5) / 2) * 2;
    const k = Math.max(0, 1 - q / 9.5);
    const g = k * k * 0.62;
    return [Math.round(255 * g), Math.round(178 * g), Math.round(84 * g)];
  });
}

/** 128x16 moon strip: 8 phases (0 = full ... 4 = new), 16x16 each, a square moon with craters + faint halo. */
function moonTexture() {
  const F = 16, W = F * 8;
  const crater = new Set(['5,5', '6,5', '5,6', '9,8', '10,8', '9,9', '10,9', '7,10', '11,5', '6,11', '4,8']);
  return makeTex(W, F, (x, y) => {
    const k = Math.floor(x / F), lx = x % F, ly = y;
    const inCore = lx >= 3 && lx <= 12 && ly >= 3 && ly <= 12;
    if (!inCore) {
      const d = Math.max(Math.abs(lx - 7.5), Math.abs(ly - 7.5));
      const g = d < 7 ? 0.11 * (1 - (d - 5) / 2.5) : 0;
      const v = Math.max(0, g);
      return [Math.round(150 * v), Math.round(170 * v), Math.round(230 * v)];
    }
    const nx = (lx - 7.5) / 5; // -0.9..0.9 across the core
    let lit;
    if (k === 0) lit = true;
    else if (k === 4) lit = false;
    else if (k < 4) lit = nx < 1 - 2 * (k / 4) + 0.05;
    else lit = nx > 1 - 2 * ((k - 4) / 4) - 0.05;
    if (!lit) return [14, 16, 26];
    const base = crater.has(lx + ',' + ly) ? [168, 172, 190] : [226, 230, 240];
    const rim = lx === 3 || lx === 12 || ly === 3 || ly === 12;
    return rim ? [196, 200, 214] : base;
  });
}

function quad(size, map, color) {
  const mat = new THREE.MeshBasicMaterial({
    map, color, transparent: true, depthWrite: false, depthTest: true, fog: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function createSun() {
  const m = quad(150, sunTexture(), 0xffffff);
  m.name = 'sun';
  m.renderOrder = -900;
  return m;
}

export function createMoon() {
  const tex = moonTexture();
  tex.repeat.set(1 / 8, 1);
  const m = quad(78, tex, 0xffffff);
  m.name = 'moon';
  m.renderOrder = -900;
  return m;
}

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
/**
 * Place a celestial quad at `dist` along `dir` (relative to the sky root, which follows the camera),
 * facing the viewer, with its edges level with the horizon like a voxel-game sun.
 */
export function placeCelestial(mesh, dir, pole, dist) {
  _z.copy(dir).negate();                       // plane normal (+Z) looks back at the viewer
  _x.crossVectors(UP, _z);                     // keep the square's edges level with the horizon
  if (_x.lengthSq() < 1e-6) _x.crossVectors(pole, dir);
  _x.normalize();
  _y.crossVectors(_z, _x).normalize();
  mesh.matrix.makeBasis(_x, _y, _z);
  mesh.matrix.setPosition(dir.x * dist, dir.y * dist, dir.z * dist);
  mesh.matrixWorldNeedsUpdate = true;
}

// ---------------------------------------------------------------------------------------------------------------
// Stars: square points (pixel stars) that twinkle and rotate with the sky.
const STAR_VERT = /* glsl */`
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 rel = normalize(wp.xyz - cameraPosition);
  float tw = 0.72 + 0.28 * sin(uTime * (1.3 + aPhase * 2.1) + aPhase * 37.0);
  vAlpha = tw * smoothstep(-0.02, 0.22, rel.y);
  vColor = aColor;
  gl_PointSize = aSize * uPixelRatio;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const STAR_FRAG = /* glsl */`
uniform float uAmount;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a = uAmount * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <colorspace_fragment>
}`;

export function createStars(count = 1700, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pos = new Float32Array(count * 3), size = new Float32Array(count), phase = new Float32Array(count), col = new Float32Array(count * 3);
  const tint = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // uniform on the sphere
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos[i * 3] = r * Math.cos(th) * STAR_RADIUS;
    pos[i * 3 + 1] = u * STAR_RADIUS;
    pos[i * 3 + 2] = r * Math.sin(th) * STAR_RADIUS;
    const b = rnd();
    size[i] = b > 0.985 ? 3 : b > 0.9 ? 2 : 1.25;
    phase[i] = rnd();
    const k = rnd();
    tint.setHex(k < 0.15 ? 0xbcd2ff : k < 0.25 ? 0xffe2b8 : 0xffffff);
    const br = (b > 0.9 ? 1.0 : 0.55 + rnd() * 0.35);
    col[i * 3] = tint.r * br; col[i * 3 + 1] = tint.g * br; col[i * 3 + 2] = tint.b * br;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAmount: { value: 0 }, uPixelRatio: { value: 1 } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = 'stars';
  pts.frustumCulled = false;
  pts.renderOrder = -950;
  return pts;
}
