// Load-time pose authoring for the ANIM module: compact SPECS (IK targets + joint angles) baked into rig poses.
//
// A spec (fighter frame: x = own LEFT, y = up from the ground, z = toward the opponent; angles in degrees):
//   root:  { fwd, right, up, yaw }
//   hips / spine / chest / neck / head / any joint: [x, y, z]  local Euler (rig convention, FIGHTER.md §4)
//   world: { hips|spine|chest|neck|head: [x, y, z] }  extra rotation applied in FIGHTER space (before limb IK),
//          e.g. world.chest = [-10, 0, 0] leans the chest away from the opponent whatever the stance twist.
//   footL/footR: { p: [x, y, z] ankle position, yaw, pitch (+ toes down), roll, pole: [x,y,z] (fighter space) }
//   handL/handR: { p: [x, y, z] fist centre, wrist: [x,y,z], pole: [x,y,z] (chest space; default down/out/back) }
//   add:   { joint: [x, y, z] }  local rotation post-multiplied after everything (small additive tweaks).
// Never used per frame: allocations here are fine.
import * as THREE from 'three';
import { createSkeleton, JOINTS } from './rig.js';
import { DEG } from '../core/math.js';

/** Ankle height above the ground for a planted foot (rest pose ankle is 0.07 m up). */
export const ANKLE_H = 0.075;
const AXIAL = ['hips', 'spine', 'chest', 'neck', 'head'];
const LIMBS = {
  footL: { upper: 'thighL', mid: 'kneeL', end: 'ankleL', a: 0.44, b: 0.42, bend: 1, side: 1 },
  footR: { upper: 'thighR', mid: 'kneeR', end: 'ankleR', a: 0.44, b: 0.42, bend: 1, side: -1 },
  // forearm + fist: the target is the fist centre (wrist + ~0.06 m), like the move library's kit
  handL: { upper: 'shoulderL', mid: 'elbowL', end: 'wristL', a: 0.28, b: 0.31, bend: -1, side: 1 },
  handR: { upper: 'shoulderR', mid: 'elbowR', end: 'wristR', a: 0.28, b: 0.31, bend: -1, side: -1 },
};
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

let SK = null;
const sk = () => SK || (SK = createSkeleton());

function qDeg(a, q = new THREE.Quaternion()) {
  _e.set((a[0] || 0) * DEG, (a[1] || 0) * DEG, (a[2] || 0) * DEG, 'XYZ');
  return q.setFromEuler(_e);
}

function worldRotate(s, name, deg) {
  const j = s.joints[name];
  s.root.updateMatrixWorld(true);
  const P = j.parent.getWorldQuaternion(new THREE.Quaternion());
  const R = qDeg(deg);
  // local' = P^-1 * R * P * local  (rotate the joint's world orientation by R, fighter space)
  const m = P.clone().invert().multiply(R).multiply(P);
  j.quaternion.premultiply(m);
}

function solveLimb(s, key, f) {
  const L = LIMBS[key];
  const J = s.joints;
  const up = J[L.upper], mid = J[L.mid], end = J[L.end];
  s.root.updateMatrixWorld(true);
  const P = up.parent.getWorldQuaternion(new THREE.Quaternion());
  const Pinv = P.clone().invert();
  const jp = up.getWorldPosition(new THREE.Vector3());
  const D = new THREE.Vector3().fromArray(f.p).sub(jp);
  const a = L.a, b = L.b;
  const d = Math.min(Math.max(D.length(), Math.abs(a - b) + 0.02), (a + b) * 0.998);
  const cosG = Math.min(1, Math.max(-1, (a * a + b * b - d * d) / (2 * a * b)));
  const bend = Math.PI - Math.acos(cosG);
  // end point in the upper bone's frame (before its rotation)
  const v = new THREE.Vector3(0, -a - b * Math.cos(bend), -L.bend * b * Math.sin(bend)).normalize();
  const Dl = D.clone().applyQuaternion(Pinv).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(v, Dl);
  // pole: where the knee / elbow should point
  let pole;
  if (L.bend > 0) {
    const yaw = (f.yaw || 0) * DEG;
    pole = f.pole ? new THREE.Vector3().fromArray(f.pole) : new THREE.Vector3(Math.sin(yaw) + L.side * 0.15, 0.05, Math.cos(yaw));
  } else {
    const cq = J.chest.getWorldQuaternion(new THREE.Quaternion());
    pole = new THREE.Vector3().fromArray(f.pole || [L.side * 0.7, -1, -0.35]).applyQuaternion(cq);
  }
  pole.applyQuaternion(Pinv);
  const m = new THREE.Vector3(0, -a, 0).applyQuaternion(q);
  const mp = m.clone().addScaledVector(Dl, -m.dot(Dl));
  const pp = pole.clone().addScaledVector(Dl, -pole.dot(Dl));
  let ang = 0;
  if (mp.lengthSq() > 1e-10 && pp.lengthSq() > 1e-10) ang = Math.atan2(Dl.dot(new THREE.Vector3().crossVectors(mp, pp)), mp.dot(pp));
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(Dl, ang + (f.swivel || 0) * DEG));
  up.quaternion.copy(q);
  mid.quaternion.setFromAxisAngle(X, L.bend * bend);
  up.updateMatrixWorld(true);
  if (L.bend > 0) {
    _e.set((f.pitch || 0) * DEG, (f.yaw || 0) * DEG, (f.roll || 0) * DEG, 'YXZ');
    const Qd = new THREE.Quaternion().setFromEuler(_e);
    const Mq = mid.getWorldQuaternion(new THREE.Quaternion()).invert();
    end.quaternion.copy(Mq.multiply(Qd));
  } else if (f.wrist) qDeg(f.wrist, end.quaternion);
  else end.quaternion.identity();
}

/** Bake a spec into a rig pose (degrees). */
export function poseFromSpec(spec) {
  const s = sk();
  const J = s.joints;
  for (const n of JOINTS) J[n].quaternion.identity();
  const r = spec.root || {};
  s.body.position.set(-(r.right || 0), r.up || 0, r.fwd || 0);
  s.body.quaternion.setFromAxisAngle(Y, (r.yaw || 0) * DEG);
  for (const n of JOINTS) if (Array.isArray(spec[n])) qDeg(spec[n], J[n].quaternion);
  if (spec.world) for (const n of AXIAL) if (spec.world[n]) worldRotate(s, n, spec.world[n]);
  for (const k of ['footL', 'footR']) if (spec[k] && spec[k].p) solveLimb(s, k, spec[k]);
  for (const k of ['handL', 'handR']) if (spec[k] && spec[k].p) solveLimb(s, k, spec[k]);
  if (spec.add) for (const n of JOINTS) if (spec.add[n]) J[n].quaternion.multiply(qDeg(spec.add[n]));
  const out = { root: { fwd: r4(r.fwd || 0), right: r4(r.right || 0), up: r4(r.up || 0), yaw: r2(r.yaw || 0) } };
  for (const n of JOINTS) {
    const q = J[n].quaternion;
    if (Math.abs(q.w) > 0.99999) continue;
    _e.setFromQuaternion(q, 'XYZ');
    out[n] = [r2(_e.x / DEG), r2(_e.y / DEG), r2(_e.z / DEG)];
  }
  return out;
}

/** Fighter-frame position of a joint (or joint + local offset) for a baked pose. QA / tests. */
export function jointPos(pose, name, offset = [0, 0, 0]) {
  const s = sk();
  for (const n of JOINTS) qDeg(pose[n] || [0, 0, 0], s.joints[n].quaternion);
  const r = pose.root || {};
  s.body.position.set(-(r.right || 0), r.up || 0, r.fwd || 0);
  s.body.quaternion.setFromAxisAngle(Y, (r.yaw || 0) * DEG);
  s.root.updateMatrixWorld(true);
  return new THREE.Vector3().fromArray(offset).applyMatrix4(s.joints[name].matrixWorld).toArray().map(r4);
}

// ------------------------------------------------------------------------------------------------ spec algebra

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const cloneSpec = (s) => JSON.parse(JSON.stringify(s));

/** base + delta: numbers and arrays add, objects recurse, keys missing in base are copied. */
export function addSpec(base, delta) {
  const out = cloneSpec(base);
  if (!delta) return out;
  for (const k of Object.keys(delta)) {
    const d = delta[k], b = out[k];
    if (b === undefined) out[k] = cloneSpec(d);
    else if (typeof d === 'number' && typeof b === 'number') out[k] = b + d;
    else if (Array.isArray(d) && Array.isArray(b)) out[k] = b.map((x, i) => x + (d[i] || 0));
    else if (isObj(d) && isObj(b)) out[k] = addSpec(b, d);
    else out[k] = cloneSpec(d);
  }
  return out;
}

/** Shallow-ish override: later specs replace keys (root merges). */
export function withSpec(base, over) {
  const out = cloneSpec(base);
  for (const k of Object.keys(over || {})) out[k] = k === 'root' ? { ...(out.root || {}), ...over.root } : cloneSpec(over[k]);
  return out;
}

/** Linear blend of two specs with the same shape (missing numbers count as 0). */
export function lerpSpec(a, b, t) {
  const out = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
    if (typeof x === 'number' || typeof y === 'number') out[k] = (x || 0) + ((y || 0) - (x || 0)) * t;
    else if (Array.isArray(x) || Array.isArray(y)) {
      const xa = x || [0, 0, 0], ya = y || [0, 0, 0];
      out[k] = xa.map((v, i) => v + ((ya[i] || 0) - v) * t);
    } else if (isObj(x) || isObj(y)) out[k] = lerpSpec(x || {}, y || {}, t);
    else out[k] = t < 0.5 ? x : y;
  }
  return out;
}

const swapLR = (k) => (/L$/.test(k) ? k.slice(0, -1) + 'R' : /R$/.test(k) ? k.slice(0, -1) + 'L' : k);

/** Mirror a spec left <-> right. */
export function mirrorSpec(s) {
  const out = {};
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (k === 'root') { out.root = { ...v, right: -(v.right || 0), yaw: -(v.yaw || 0) }; continue; }
    if (k === 'world' || k === 'add') { out[k] = mirrorSpec(v); continue; }
    const m = swapLR(k);
    if (Array.isArray(v)) out[m] = [v[0], -v[1], -v[2]];
    else if (isObj(v)) {
      const o = cloneSpec(v);
      if (o.p) o.p = [-o.p[0], o.p[1], o.p[2]];
      if (o.pole) o.pole = [-o.pole[0], o.pole[1], o.pole[2]];
      if (o.wrist) o.wrist = [o.wrist[0], -o.wrist[1], -o.wrist[2]];
      if (typeof o.yaw === 'number') o.yaw = -o.yaw;
      if (typeof o.roll === 'number') o.roll = -o.roll;
      if (typeof o.swivel === 'number') o.swivel = -o.swivel;
      out[m] = o;
    } else out[m] = v;
  }
  return out;
}

/** Replace IK hands by the joint angles of an already-baked pose, so the arms ride along with the torso. */
export function lockArms(spec, pose) {
  const out = cloneSpec(spec);
  delete out.handL; delete out.handR;
  for (const j of ['shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR']) out[j] = (pose[j] || [0, 0, 0]).slice();
  return out;
}
