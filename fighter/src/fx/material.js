// Shared FX shader: one tiny material for every sprite, shard and trail ribbon. Vertices are written in WORLD space
// on the CPU (mesh matrix = identity), so a whole effect layer is one draw call.
// Premultiplied-alpha blending (ONE, ONE_MINUS_SRC_ALPHA) lets one draw call mix additive glints (alpha out = 0) and
// normal "over" puffs (alpha out = a): aShape.z = additive amount (1 additive .. 0 over).
// Shapes (aShape.x): 0 soft disc (y = core radius), 1 ring (y = inner radius), 2 diamond shard, 3 flash disc
// (hard core of radius y + soft halo), 4 ribbon (v across the strip, soft edges). Colours are display-space
// (no tone mapping / colour-space conversion), so white is exactly white: clean, never blown out.
import * as THREE from 'three';

const VERT = /* glsl */`
attribute vec2 aUv;
attribute vec4 aColor;
attribute vec4 aShape;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vShape;
void main() {
  vUv = aUv;
  vColor = aColor;
  vShape = aShape;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vShape;
void main() {
  float k = vShape.x;
  float a;
  if (k < 0.5) {
    float r = length(vUv);
    a = 1.0 - smoothstep(vShape.y, 1.0, r);
  } else if (k < 1.5) {
    float r = length(vUv);
    float w = fwidth(r) * 1.25;
    a = smoothstep(vShape.y - w, vShape.y + w, r) * (1.0 - smoothstep(1.0 - w * 2.0, 1.0, r));
  } else if (k < 2.5) {
    float d = abs(vUv.x) + abs(vUv.y);
    float w = fwidth(d) * 1.5;
    a = 1.0 - smoothstep(1.0 - w, 1.0, d);
  } else if (k < 3.5) {
    float r = length(vUv);
    float w = fwidth(r) * 1.25;
    a = (1.0 - smoothstep(vShape.y - w, vShape.y + w, r)) + 0.28 * (1.0 - smoothstep(vShape.y, 1.0, r));
  } else {
    float e = abs(vUv.y);
    float w = max(fwidth(e) * 1.5, 0.08);
    a = 1.0 - smoothstep(1.0 - w * 2.5, 1.0, e);
  }
  a *= vColor.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb * a, a * (1.0 - vShape.z));
}`;

/** The shared FX material (premultiplied blending, no depth write, depth tested so walls hide effects). */
export function makeFxMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
}

/** Mark the live part of a dynamic attribute for upload (r160 addUpdateRange, older updateRange fallback). */
export function markRange(attr, count) {
  if (typeof attr.clearUpdateRanges === 'function' && typeof attr.addUpdateRange === 'function') {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(1, count));
  } else if (attr.updateRange) {
    attr.updateRange.offset = 0;
    attr.updateRange.count = Math.max(1, count);
  }
  attr.needsUpdate = true;
}

/** Display-space RGB (0..1) of a THREE.Color or hex, written into out[0..2]. */
export function displayRGB(c, out) {
  let hex = 0xffffff;
  if (typeof c === 'number') hex = c;
  else if (c && typeof c.getHex === 'function') hex = c.getHex();
  out[0] = ((hex >> 16) & 255) / 255;
  out[1] = ((hex >> 8) & 255) / 255;
  out[2] = (hex & 255) / 255;
  return out;
}
