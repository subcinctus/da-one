// Rain streaks (owned by ATMOSPHERE): a fixed LineSegments buffer whose drop positions are computed entirely in the
// vertex shader (wrapped in a box that follows the camera), so rain costs ~0 CPU per frame.
import * as THREE from 'three';

const BOX = 44;       // horizontal box size (m)
const HEIGHT = 34;    // vertical box size (m)

const VERT = /* glsl */`
attribute vec4 aSeed;   // x,z offset (0..1), phase (0..1), speed factor
attribute float aEnd;   // 0 = head, 1 = tail
uniform vec3 uCam;
uniform float uTime;
uniform vec2 uWind;
uniform float uLen;
varying float vAlpha;
void main() {
  float speed = 21.0 * aSeed.w;
  float fall = uTime * speed;
  float y = uCam.y + (fract(aSeed.z - fall / ${HEIGHT.toFixed(1)} - uCam.y / ${HEIGHT.toFixed(1)}) - 0.5) * ${HEIGHT.toFixed(1)};
  vec2 drift = uWind * (uTime);
  float x = uCam.x + (fract(aSeed.x - (uCam.x - drift.x) / ${BOX.toFixed(1)}) - 0.5) * ${BOX.toFixed(1)};
  float z = uCam.z + (fract(aSeed.y - (uCam.z - drift.y) / ${BOX.toFixed(1)}) - 0.5) * ${BOX.toFixed(1)};
  vec3 p = vec3(x, y, z);
  vec3 vel = normalize(vec3(uWind.x, -speed, uWind.y));
  p -= vel * uLen * aEnd;
  float d = length(p.xz - uCam.xz) / ${(BOX * 0.5).toFixed(1)};
  float dy = abs(p.y - uCam.y) / ${(HEIGHT * 0.5).toFixed(1)};
  vAlpha = (1.0 - smoothstep(0.55, 1.0, d)) * (1.0 - smoothstep(0.6, 1.0, dy)) * (1.0 - aEnd * 0.85);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  float a = uOpacity * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

export class Rain {
  constructor(count = 1400) {
    const seed = new Float32Array(count * 2 * 4);
    const end = new Float32Array(count * 2);
    const pos = new Float32Array(count * 2 * 3); // unused by the shader but required by three
    for (let i = 0; i < count; i++) {
      const sx = Math.random(), sz = Math.random(), ph = Math.random(), sp = 0.8 + Math.random() * 0.4;
      for (let k = 0; k < 2; k++) {
        const v = i * 2 + k;
        seed[v * 4] = sx; seed[v * 4 + 1] = sz; seed[v * 4 + 2] = ph; seed[v * 4 + 3] = sp;
        end[v] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.uniforms = {
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(2.5, 1.0) },
      uLen: { value: 1.25 },
      uColor: { value: new THREE.Color(0xa9b8cc) },
      uOpacity: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, fog: false,
    });
    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.name = 'rain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    this.time = 0;
  }

  /** amount 0..1 (already multiplied by "not under cover"), light 0..1 scene brightness. */
  update(dt, cam, amount, light) {
    this.time += dt;
    if (this.time > 3600) this.time -= 3600;
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uCam.value.copy(cam);
    u.uOpacity.value = 0.55 * amount;
    u.uColor.value.setRGB(0.42 + 0.3 * light, 0.47 + 0.32 * light, 0.56 + 0.32 * light);
    this.mesh.visible = amount > 0.01;
  }
}
