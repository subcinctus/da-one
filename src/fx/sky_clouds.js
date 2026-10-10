// Blocky voxel cloud layer (owned by ATMOSPHERE). Flat 4-block-thick cells on a 12-block grid, picked from noise,
// merged into one geometry (internal faces culled), drifting with the wind and re-centred around the camera.
// Rendered with a depth pre-pass so the semi-transparent shell shows only its nearest surface.
import * as THREE from 'three';
import { Noise } from '../core/noise.js';

export const CLOUD_Y = 110;
export const CLOUD_CELL = 12;
export const CLOUD_THICK = 4;
const WINDOW = 50;              // cells per side of the built window (600 m)
const HALF = WINDOW / 2;
const RECENTER = 7;             // rebuild when the camera drifts this many cells from the window centre
const MAX_QUADS = WINDOW * WINDOW * 6;

const VERT = /* glsl */`
attribute float shade;
uniform vec3 uCam;
varying float vShade;
varying float vDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vShade = shade;
  vDist = length(wp.xz - uCam.xz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uFog;
uniform float uOpacity;
uniform float uNear;
uniform float uFar;
varying float vShade;
varying float vDist;
void main() {
  vec3 c = mix(uBottom, uTop, vShade);
  float f = smoothstep(uNear, uFar, vDist);
  c = mix(c, uFog, f * 0.8);
  gl_FragColor = vec4(c, uOpacity * (1.0 - f));
  #include <colorspace_fragment>
}`;

export class CloudLayer {
  constructor(seed = 1) {
    this.noise = new Noise((seed ^ 0x5eed) >>> 0);
    this.coverage = 0.3;        // 0..1 target sky coverage
    this._builtCoverage = -1;
    this.drift = 0;             // metres the cloud field has moved along +X
    this.windSpeed = 1.6;       // m/s
    this._ci = 1e9; this._cj = 1e9; // window centre (cloud-space cell indices)
    this.quads = 0;

    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_QUADS * 4 * 3);
    this.shade = new Float32Array(MAX_QUADS * 4);
    const idx = new Uint32Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4, i = q * 6;
      idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2; idx[i + 3] = v; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
    }
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.shadeAttr = new THREE.BufferAttribute(this.shade, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('shade', this.shadeAttr);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.uniforms = {
      uCam: { value: new THREE.Vector3() },
      uTop: { value: new THREE.Color(1, 1, 1) },
      uBottom: { value: new THREE.Color(0.75, 0.78, 0.82) },
      uFog: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uOpacity: { value: 0.8 },
      uNear: { value: 160 },
      uFar: { value: 300 },
    };
    const depthMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      colorWrite: false, depthWrite: true, transparent: true, fog: false,
    });
    const colorMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, fog: false,
    });
    this.group = new THREE.Group();
    this.group.name = 'clouds';
    const pre = new THREE.Mesh(geo, depthMat);
    const main = new THREE.Mesh(geo, colorMat);
    pre.frustumCulled = main.frustumCulled = false;
    pre.renderOrder = 5; main.renderOrder = 6;
    this.group.add(pre, main);
    this.group.position.y = CLOUD_Y;
  }

  /** Is the cloud-space cell (i,j) occupied at a given coverage? */
  occupied(i, j, coverage = this.coverage) {
    const n = this.noise;
    const v = 0.62 * n.noise2(i * 0.085, j * 0.085) + 0.38 * n.noise2(i * 0.21 + 31.7, j * 0.21 - 17.3);
    const threshold = 0.36 - coverage * 0.72;
    return v > threshold;
  }

  _rebuild(ci, cj) {
    this._ci = ci; this._cj = cj;
    this._builtCoverage = this.coverage;
    const cov = this.coverage;
    const occ = new Uint8Array((WINDOW + 2) * (WINDOW + 2));
    const W2 = WINDOW + 2;
    for (let b = 0; b < W2; b++) {
      for (let a = 0; a < W2; a++) {
        occ[a + b * W2] = this.occupied(ci - HALF - 1 + a, cj - HALF - 1 + b, cov) ? 1 : 0;
      }
    }
    const P = this.pos, S = this.shade;
    let q = 0;
    const C = CLOUD_CELL, T = CLOUD_THICK;
    const push = (x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, sh) => {
      const o = q * 12;
      P[o] = x0; P[o + 1] = y0; P[o + 2] = z0;
      P[o + 3] = x1; P[o + 4] = y1; P[o + 5] = z1;
      P[o + 6] = x2; P[o + 7] = y2; P[o + 8] = z2;
      P[o + 9] = x3; P[o + 10] = y3; P[o + 11] = z3;
      const s = q * 4;
      S[s] = S[s + 1] = S[s + 2] = S[s + 3] = sh;
      q++;
    };
    for (let b = 1; b <= WINDOW; b++) {
      for (let a = 1; a <= WINDOW; a++) {
        if (!occ[a + b * W2]) continue;
        const x0 = (ci - HALF - 1 + a) * C, z0 = (cj - HALF - 1 + b) * C, x1 = x0 + C, z1 = z0 + C;
        // top (+Y) and bottom (-Y); CCW seen from the outside
        push(x0, T, z0, x0, T, z1, x1, T, z1, x1, T, z0, 1.0);
        push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1, 0.0);
        if (!occ[a + 1 + b * W2]) push(x1, 0, z0, x1, T, z0, x1, T, z1, x1, 0, z1, 0.62); // +X
        if (!occ[a - 1 + b * W2]) push(x0, 0, z1, x0, T, z1, x0, T, z0, x0, 0, z0, 0.62); // -X
        if (!occ[a + (b + 1) * W2]) push(x1, 0, z1, x1, T, z1, x0, T, z1, x0, 0, z1, 0.48); // +Z
        if (!occ[a + (b - 1) * W2]) push(x0, 0, z0, x0, T, z0, x1, T, z0, x1, 0, z0, 0.48); // -Z
      }
    }
    this.quads = q;
    this.geometry.setDrawRange(0, q * 6);
    this.posAttr.needsUpdate = true;
    this.shadeAttr.needsUpdate = true;
    this.geometry.boundingSphere = null;
  }

  /**
   * dt: seconds of simulated time (0 when only re-applying colours). cam: camera world position.
   * look: { top, bottom, fog: THREE.Color, opacity, fadeNear, fadeFar }.
   */
  update(dt, cam, look) {
    this.drift += this.windSpeed * dt;
    if (this.drift > 1e6) this.drift -= 1e6;
    this.group.position.x = this.drift;
    const ci = Math.floor((cam.x - this.drift) / CLOUD_CELL);
    const cj = Math.floor(cam.z / CLOUD_CELL);
    const covChanged = Math.abs(this.coverage - this._builtCoverage) > 0.04;
    if (Math.abs(ci - this._ci) > RECENTER || Math.abs(cj - this._cj) > RECENTER || covChanged) this._rebuild(ci, cj);
    const u = this.uniforms;
    u.uCam.value.copy(cam);
    if (look) {
      u.uTop.value.copy(look.top);
      u.uBottom.value.copy(look.bottom);
      u.uFog.value.copy(look.fog);
      u.uOpacity.value = look.opacity;
      u.uNear.value = look.fadeNear;
      u.uFar.value = look.fadeFar;
    }
  }

  dispose() {
    this.geometry.dispose();
    for (const m of this.group.children) m.material.dispose();
  }
}
