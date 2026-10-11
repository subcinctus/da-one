// Gradient sky dome: one draw call, follows the camera, drawn first with no depth write.
// Top / horizon / bottom gradient plus a soft sun (or moon) disc and halo. No fog, no post.
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 bottom;
uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunSize; uniform float haloK; uniform float midH;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col;
  if (h >= 0.0) {
    float t1 = smoothstep(0.0, midH, h);
    float t2 = smoothstep(midH, 1.0, h);
    col = mix(mix(horizon, mid, t1), top, t2);
  } else {
    col = mix(horizon, bottom, smoothstep(0.0, 0.25, -h));
  }
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 6.0) * 0.18 + pow(s, 48.0) * 0.35) * haloK;
  col = mix(col, sunColor * 1.6, smoothstep(1.0 - sunSize * 1.2, 1.0 - sunSize, s));
  // tiny dither against banding (not a post effect)
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export function createSky() {
  const uniforms = {
    top: { value: new THREE.Color(0x7fb6e0) }, mid: { value: new THREE.Color(0xbfdcef) },
    horizon: { value: new THREE.Color(0xf3e6cf) }, bottom: { value: new THREE.Color(0xd9d0c0) },
    sunDir: { value: new THREE.Vector3(0.5, 0.5, 0.5).normalize() }, sunColor: { value: new THREE.Color(0xfff1d6) },
    sunSize: { value: 0.0012 }, haloK: { value: 1 }, midH: { value: 0.35 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = true;
  /** Apply a chapter palette's sky block. */
  mesh.userData.apply = (sky, sunDir) => {
    uniforms.top.value.set(sky.top); uniforms.mid.value.set(sky.mid ?? sky.top);
    uniforms.horizon.value.set(sky.horizon); uniforms.bottom.value.set(sky.bottom);
    uniforms.sunColor.value.set(sky.sun ?? 0xffffff);
    uniforms.sunSize.value = sky.sunSize ?? 0.0012;
    uniforms.haloK.value = sky.halo ?? 1;
    uniforms.midH.value = sky.midH ?? 0.35;
    uniforms.sunDir.value.copy(sunDir).normalize();
    if (sky.sunDirOverride) uniforms.sunDir.value.set(...sky.sunDirOverride).normalize();
  };
  return mesh;
}
