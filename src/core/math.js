// Math helpers + the global orientation convention.
//
// ORIENTATION CONVENTION (used everywhere):
//   Y is up. Yaw/heading angle θ (radians): forward = (sin θ, 0, cos θ). θ = 0 faces +Z.
//   right = (-cos θ, 0, sin θ). Turning RIGHT DECREASES θ. Mouse dx > 0 => θ -= dx * sens.
//   Pitch φ: positive looks UP. Look direction = (sin θ cos φ, sin φ, cos θ cos φ).
//   Models are built facing +Z, so object.rotation.y = θ orients them.
//   A THREE camera looks down its local -Z, so camera.rotation.set(φ, θ + π, 0) with order 'YXZ'.
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Frame-rate independent exponential smoothing factor: x = lerp(x, target, damp(rate, dt)). */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
/** Wrap angle to (-π, π]. */
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
/** Shortest signed difference b - a in (-π, π]. */
export const angleDiff = (a, b) => wrapAngle(b - a);
export const lerpAngle = (a, b, t) => a + angleDiff(a, b) * t;
export const dist2D = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

export function forwardFromYaw(yaw, out = new THREE.Vector3()) { return out.set(Math.sin(yaw), 0, Math.cos(yaw)); }
export function rightFromYaw(yaw, out = new THREE.Vector3()) { return out.set(-Math.cos(yaw), 0, Math.sin(yaw)); }
export function dirFromYawPitch(yaw, pitch, out = new THREE.Vector3()) {
  const c = Math.cos(pitch);
  return out.set(Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c);
}
/** Yaw that faces from (x0,z0) toward (x1,z1). */
export const yawTo = (x0, z0, x1, z1) => Math.atan2(x1 - x0, z1 - z0);

/** Deterministic PRNG (mulberry32). rng() -> [0,1). */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * rng()); // inclusive
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return rng;
}

/** Stateless integer hash -> [0,1). Good for deterministic per-coordinate decisions (tree placement etc.). */
export function hash2(x, z, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function hash3(x, y, z, seed = 0) { return hash2(Math.imul(x | 0, 31) + (y | 0), z, seed); }

/** Unseeded convenience randoms for cosmetic, non-deterministic things (particles, AI jitter). */
export const rand = (lo = 0, hi = 1) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
