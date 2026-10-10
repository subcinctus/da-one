// Far-field skyline proxies (WORLD-ENGINE, used by world.js).
//
// Chunks exist only inside the render radius and the chunk fog hides everything past fog.far, so from a helicopter
// or a rooftop the downtown towers beyond ~120 m simply are not there. This layer draws ONE InstancedMesh of boxes
// (tower tiers and large buildings, taken from the city plan) with a procedural window pattern and night-lit windows,
// visible only PAST the chunk fog's end:
//   - per fragment it fades in over [fog.far, fog.far + FADE_BAND]. Real chunk geometry is fully fogged from fog.far
//     on, so a proxy never doubles visible geometry and nothing pops when flying in: the proxy thins out to nothing
//     right where the real tower starts to emerge from the fog.
//   - its own haze (aerial perspective): an opaque silhouette mostly in the fog colour, like the fully fogged chunks
//     it continues, showing at most MAX_VIS of its facade and fading to pure fog by fog.far * FAR_K. Lit windows
//     (night) carry much further through the haze, like the chunk shader's glow-aware fog.
//   - drawn first among transparent objects (alpha only for the fade-in), writes depth so proxies occlude each other
//     correctly; no shadows, no raycasts.
//   - instances are re-packed only when the set of boxes that can be visible changes (no per-frame uploads).
// Budget: ~60 instances, 1 draw call, ~700 triangles.
import * as THREE from 'three';

const MIN_HEIGHT = 14;      // lots whose roof is lower than this above street level get no proxy
const MIN_COLS = 0.1;       // a roof level must cover this fraction of a lot's roof columns to become its own tier
const MAX_TIERS = 4;
const OUTSET = 0.6;         // proxies sit just outside the real facades (they overlay fully fogged chunk geometry)
const FADE_BAND = 28;       // metres past fog.far over which proxies fade in
const FAR_K = 3;            // proxies are fully hazed out at fog.far * FAR_K
const MAX_VIS = 0.22;       // how much of the facade shows through the haze right past the fade band (day)
const MAX_VIS_GLOW = 0.85;  // lit windows at night carry much further
const MIN_FOG_FAR = 48;     // shorter fog (underwater, storms): no skyline
const BOX_STRIDE = 7;       // x0, z0, x1, z1, y0, y1, color

/**
 * Proxy boxes for a city plan: Float32Array of [x0, z0, x1, z1, y0, y1, colorHex] per box (pure; usable in node).
 * Towers keep their setback tiers: one stacked box per significant roof level (bbox of the columns at least that
 * high), built from plan.roofAt, so the silhouette matches the real building.
 */
export function buildSkylineBoxes(plan, cityLevel) {
  const out = [];
  if (!plan || !Array.isArray(plan.lots) || typeof plan.roofAt !== 'function') return new Float32Array(0);
  for (const lot of plan.lots) {
    if (!lot || (lot.type !== 'tower' && lot.type !== 'building')) continue;
    if (!((lot.height || 0) >= MIN_HEIGHT)) continue;
    // roof levels inside the lot -> column counts
    const levels = new Map();
    let total = 0;
    for (let z = lot.z0; z < lot.z1; z++) {
      for (let x = lot.x0; x < lot.x1; x++) {
        const r = plan.roofAt(x, z);
        if (r == null || !(r > cityLevel)) continue;
        levels.set(r, (levels.get(r) || 0) + 1);
        total++;
      }
    }
    if (!total) continue;
    const keep = [...levels.entries()].filter((e) => e[1] >= total * MIN_COLS).map((e) => e[0]).sort((a, b) => a - b);
    // the top level always counts (its height is the building's height), even when it is a small crown
    const top = Math.max(...levels.keys());
    if (keep[keep.length - 1] !== top) keep.push(top);
    while (keep.length > MAX_TIERS) keep.splice(keep.length - 2, 1); // merge the smallest upper steps into the top
    if (keep[keep.length - 1] - cityLevel < MIN_HEIGHT) continue;
    let y0 = cityLevel;
    for (let k = 0; k < keep.length; k++) {
      const L = keep[k];
      // bbox of the columns whose roof is at least this level (for the top tier: of the previous tier's level, so a
      // stepped crown is represented by its base footprint)
      const need = k === keep.length - 1 && keep.length > 1 && levels.get(L) < total * MIN_COLS ? keep[k - 1] + 1 : L;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let z = lot.z0; z < lot.z1; z++) {
        for (let x = lot.x0; x < lot.x1; x++) {
          const r = plan.roofAt(x, z);
          if (r == null || r < need) continue;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1);
          z0 = Math.min(z0, z); z1 = Math.max(z1, z + 1);
        }
      }
      if (!(x1 > x0 && z1 > z0) || L <= y0) continue;
      let color = 0x9aa4ae;
      try { const c = plan.colorAt(Math.floor((x0 + x1) / 2), Math.floor((z0 + z1) / 2)); if (Number.isFinite(c)) color = c; } catch (e) { /* default */ }
      out.push(x0, z0, x1, z1, y0, L, color);
      y0 = L;
    }
  }
  return Float32Array.from(out);
}

const VERT_PARS = 'varying vec3 vSkP;\nvarying vec3 vSkN;\nvarying float vSkSeed;';
const VERT_MAIN = [
  '\tvec4 skW = vec4( transformed, 1.0 );',
  '#ifdef USE_INSTANCING',
  '\tskW = instanceMatrix * skW;',
  '\tvSkSeed = instanceMatrix[3].x * 0.731 + instanceMatrix[3].z * 1.379;',
  '#else',
  '\tvSkSeed = 0.0;',
  '#endif',
  '\tvSkP = ( modelMatrix * skW ).xyz;',
  '\tvSkN = objectNormal;',
].join('\n');

function fragPars(cityLevel) {
  return [
    'uniform float uGlow;',
    'uniform vec4 uSk;', // x: fade band, y: far factor, z: max visibility, w: max visibility of lit windows
    VERT_PARS,
    `#define SK_CITY_Y ${(+cityLevel).toFixed(1)}`,
    'float skHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }',
    'float skBand( float f, float a, float b, float w ) { return smoothstep( a - w, a + w, f ) * ( 1.0 - smoothstep( b - w, b + w, f ) ); }',
  ].join('\n');
}

const FRAG_COLOR = [
  // window grid on the side faces: 2 m columns, 4 m floors (the ground floor is a lobby: no grid)
  '\tfloat skSide = 1.0 - step( 0.5, abs( vSkN.y ) );',
  '\tfloat skU = abs( vSkN.x ) > 0.5 ? vSkP.z : vSkP.x;',
  '\tvec2 skC = vec2( skU * 0.5, ( vSkP.y - SK_CITY_Y ) * 0.25 );',
  '\tvec2 skF = fract( skC );',
  '#if __VERSION__ >= 300',
  '\tvec2 skFw = max( fwidth( skC ), vec2( 1e-4 ) );',
  '#else',
  '\tvec2 skFw = vec2( 0.05 );',
  '#endif',
  '\tfloat skWin = skBand( skF.x, 0.18, 0.82, skFw.x ) * skBand( skF.y, 0.3, 0.85, skFw.y );',
  // far away (several windows per pixel): settle on the average coverage instead of shimmering
  '\tskWin = mix( 0.35, skWin, 1.0 - smoothstep( 0.25, 0.5, max( skFw.x, skFw.y ) ) );',
  '\tskWin *= skSide * step( 1.0, skC.y );',
  '\tfloat skLit = step( skHash( floor( skC ) + vec2( vSkSeed, vSkSeed * 0.37 ) ), 0.34 );',
  '\tdiffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.06, 0.09, 0.13 ), skWin * 0.6 );',
].join('\n');

const FRAG_GLOW = [
  '\tfloat skGlow = skWin * skLit;',
  '\ttotalEmissiveRadiance += vec3( 1.0, 0.8, 0.5 ) * skGlow * uGlow;',
].join('\n');

const FRAG_FOG = [
  '#if defined( USE_FOG ) && !defined( FOG_EXP2 )',
  '\tfloat skFade = smoothstep( fogFar, fogFar + uSk.x, vFogDepth );',
  '\tfloat skHaze = smoothstep( fogFar, fogFar * uSk.y, vFogDepth );',
  '\tfloat skG = clamp( skGlow * step( 0.3, uGlow ), 0.0, 1.0 );',
  // aerial perspective: an opaque silhouette whose colour is mostly the fog colour (like the fogged chunks it
  // continues), with a little facade / window detail; alpha only fades it in past fog.far
  '\tgl_FragColor.rgb = mix( fogColor, gl_FragColor.rgb, ( 1.0 - skHaze ) * mix( uSk.z, uSk.w, skG ) );',
  '\tgl_FragColor.a = skFade;',
  '#else',
  '\tgl_FragColor.a = 0.0;',
  '#endif',
].join('\n');

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const noRaycast = () => {};

export class SkylineLayer {
  /**
   * plan: city plan (§4.1); cityLevel: street standing height; glowUniform: the chunk materials' uGlow uniform object
   * (shared, so the proxies' windows light up together with the real ones).
   */
  constructor(plan, cityLevel, glowUniform) {
    this.boxes = buildSkylineBoxes(plan, cityLevel);
    this.count = this.boxes.length / BOX_STRIDE;
    this.mesh = null;
    this.visibleCount = 0;
    /** Debug switch (game.debug.skyline(false)). */
    this.disabled = false;
    this._shown = new Uint8Array(this.count);
    this._sk = { value: new THREE.Vector4(FADE_BAND, FAR_K, MAX_VIS, MAX_VIS_GLOW) };
    if (!this.count) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    // drop the bottom face (group order px, nx, py, ny, pz, nz): never seen from outside
    const idx = Array.from(geo.index.array).filter((_, k) => k < 18 || k >= 24);
    geo.setIndex(idx);
    geo.clearGroups();
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, depthWrite: true, fog: true });
    mat.name = 'world.skyline';
    const glow = glowUniform || { value: 0 };
    const sk = this._sk;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGlow = glow;
      shader.uniforms.uSk = sk;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\n' + fragPars(cityLevel))
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_GLOW)
        .replace('#include <fog_fragment>', FRAG_FOG);
    };
    mat.customProgramCacheKey = () => 'blockcity-skyline-v1';
    const mesh = new THREE.InstancedMesh(geo, mat, this.count);
    mesh.name = 'world.skyline';
    mesh.count = 0;
    mesh.visible = false;           // update() shows it once there is a fog to fade from
    mesh.frustumCulled = false;     // one draw call spanning the whole city
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -800;        // farthest transparent layer: before water, glass, clouds and particles
    mesh.raycast = noRaycast;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < this.count; i++) mesh.setColorAt(i, _c.setHex(this.boxes[i * BOX_STRIDE + 6]));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh = mesh;
  }

  /**
   * Per frame: show the boxes that can have a fragment past fog.far (and before the haze swallows them). The fade
   * itself is per fragment in the shader; this only keeps the instance list small and re-uploads it on change.
   */
  update(camera, fog) {
    const mesh = this.mesh;
    if (!mesh) return;
    const far = fog && fog.isFog ? fog.far : 0;
    const on = !this.disabled && far >= MIN_FOG_FAR && !!camera;
    mesh.visible = on;
    if (!on) return;
    const cp = camera.position;
    const cx = cp.x, cy = cp.y, cz = cp.z;
    const hi = far * FAR_K + 2, hi2 = hi * hi, lo2 = (far - 1) * (far - 1);
    const b = this.boxes, shown = this._shown;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const o = i * BOX_STRIDE;
      const x0 = b[o] - OUTSET, z0 = b[o + 1] - OUTSET, x1 = b[o + 2] + OUTSET, z1 = b[o + 3] + OUTSET;
      const nx = x0 > cx ? x0 - cx : cx > x1 ? cx - x1 : 0;
      const nz = z0 > cz ? z0 - cz : cz > z1 ? cz - z1 : 0;
      const fx = Math.max(Math.abs(cx - x0), Math.abs(cx - x1)), fz = Math.max(Math.abs(cz - z0), Math.abs(cz - z1));
      const fy = Math.max(Math.abs(cy - b[o + 4]), Math.abs(cy - b[o + 5]));
      // fog depth is at least the horizontal distance and at most the 3D distance: conservative both ways
      const v = (nx * nx + nz * nz < hi2) && (fx * fx + fz * fz + fy * fy > lo2) ? 1 : 0;
      if (v !== shown[i]) { shown[i] = v; changed = true; }
    }
    if (changed) this._pack();
  }

  _pack() {
    const mesh = this.mesh, b = this.boxes, shown = this._shown;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (!shown[i]) continue;
      const o = i * BOX_STRIDE;
      const w = b[o + 2] - b[o] + OUTSET * 2, d = b[o + 3] - b[o + 1] + OUTSET * 2;
      const y0 = b[o + 4], h = b[o + 5] - y0 + (i + 1 < this.count && b[o + BOX_STRIDE + 4] === b[o + 5] ? 0 : OUTSET);
      _p.set((b[o] + b[o + 2]) / 2, y0, (b[o + 1] + b[o + 3]) / 2);
      _s.set(w, Math.max(0.1, h), d);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(n, _m);
      mesh.setColorAt(n, _c.setHex(b[o + 6]));
      n++;
    }
    mesh.count = n;
    this.visibleCount = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  stats() {
    return { boxes: this.count, visible: this.mesh && this.mesh.visible ? this.visibleCount : 0 };
  }

  dispose() {
    if (!this.mesh) return;
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose?.();
    this.mesh = null;
  }
}
