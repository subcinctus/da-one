// Pose authoring kit for the move library (load-time only, never per frame).
//
// Moves are authored as compact SPECS that are baked into plain rig poses (degrees, FIGHTER.md §4) when the module
// loads. A spec may give joints directly (`chest: [x, y, z]`) and/or IK targets in the FIGHTER frame
// (x = fighter's own left, y = up from the ground, z = toward the opponent):
//   handR: [x, y, z] | { at: [x, y, z], pole: [x, y, z], wrist: [x, y, z] }   fist centre; pole = where the elbow points
//   footL: [x, y, z] | { at, pole, ankle | pitch, yaw }                        ankle position; pole = where the knee points
//   root:  { fwd, right, up, yaw }   look: false disables the automatic head aim at the opponent
// Planted feet (y <= 0.1) are flattened on the ground; lifted feet keep a natural pointed foot unless `ankle` is given.
// A planted foot pitched more than PLANT_PITCH (heel raised) pivots on the ball of the foot: the ankle rises and shifts so
// the ball stays where the flat foot's ball was. Lifted feet are kept above the floor (ball and heel >= FLOOR_CLEAR).
import * as THREE from 'three';
import { createSkeleton, mirrorPose, JOINTS } from '../../anim/rig.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ANKLE_H = 0.075; // ankle height above the ground for a planted foot
const BALL = [0, -0.04, 0.16]; // ball of the foot in the ankle frame (rig STRIKE_POINTS foot*)
const HEEL_DROP = 0.06;        // heel bottom below the ankle
const FLOOR_CLEAR = 0.015;     // lifted feet: ball / heel stay at least this high
const PLANT_PITCH = 8;         // planted feet: pitch up to this keeps the ankle at ANKLE_H (matches anim/ik.js stances)
/** Ball-of-foot height drop and horizontal reach (ankle frame -> ground frame) for a foot pitched `p` degrees. */
const ballDrop = (p) => -BALL[1] * Math.cos(p * D2R) + BALL[2] * Math.sin(p * D2R);
const ballReach = (p) => BALL[2] * Math.cos(p * D2R) + BALL[1] * Math.sin(p * D2R);

const LIMBS = {
  L: {
    leg: { upper: 'thighL', lower: 'kneeL', end: 'ankleL', parent: 'hips', a: 0.44, b: 0.42 },
    arm: { upper: 'shoulderL', lower: 'elbowL', end: 'wristL', parent: 'chest', a: 0.28, b: 0.31 },
  },
  R: {
    leg: { upper: 'thighR', lower: 'kneeR', end: 'ankleR', parent: 'hips', a: 0.44, b: 0.42 },
    arm: { upper: 'shoulderR', lower: 'elbowR', end: 'wristR', parent: 'chest', a: 0.28, b: 0.31 },
  },
};

let SK = null;
const skel = () => SK || (SK = createSkeleton());
const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'XYZ');
const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _s = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _k = new THREE.Vector3();
const _o = new THREE.Vector3();

const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const setRot = (bone, deg) => { bone.rotation.set((deg[0] || 0) * D2R, (deg[1] || 0) * D2R, (deg[2] || 0) * D2R, 'XYZ'); };
const toDeg = (q) => { _e.setFromQuaternion(q, 'XYZ'); return [r1(_e.x * R2D), r1(_e.y * R2D), r1(_e.z * R2D)]; };

/** Rotate a fighter-frame point/direction by `yaw` degrees about Y (+ = toward the fighter's left). */
export function rotY(yaw, p) {
  const c = Math.cos(yaw * D2R), s = Math.sin(yaw * D2R);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

/**
 * Two-bone IK in the parent's local space. `target` and `pole` are fighter-frame; writes the upper joint Euler and
 * the hinge angle into `pose`. kind 'leg': knee bends +X (shin back). kind 'arm': elbow bends -X (forearm forward).
 */
function solveLimb(pose, limb, kind, target, pole, reachK) {
  const sk = skel();
  const parent = sk.joints[limb.parent];
  const upper = sk.joints[limb.upper];
  parent.updateWorldMatrix(true, false);
  _mi.copy(parent.matrixWorld).invert();
  _t.fromArray(target).applyMatrix4(_mi).sub(upper.position); // joint -> target in parent space
  _q.setFromRotationMatrix(_m.extractRotation(parent.matrixWorld)).invert();
  _p.fromArray(pole).applyQuaternion(_q).normalize();

  const a = limb.a, b = limb.b;
  let d = _t.length();
  const dir = _t.clone().normalize();
  d = Math.min(Math.max(d, Math.abs(a - b) + 0.02), (a + b) * reachK);
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  // pole perpendicular to the target line
  _k.copy(_p).addScaledVector(dir, -_p.dot(dir));
  if (_k.lengthSq() < 1e-6) _k.set(0, 0, kind === 'leg' ? 1 : -1).addScaledVector(dir, -dir.z * (kind === 'leg' ? 1 : -1));
  _k.normalize();
  _u.copy(dir).multiplyScalar(cosA).addScaledVector(_k, sinA).normalize();     // upper bone direction
  _s.copy(dir).multiplyScalar(d).addScaledVector(_u, -a).normalize();          // lower bone direction
  // rest frame: bone along -Y. Z' = side the lower bone bends toward (leg: -Z, arm: +Z)
  _y.copy(_u).negate();
  _z.copy(_s).addScaledVector(_u, -_s.dot(_u));
  if (_z.lengthSq() < 1e-6) _z.copy(_k).multiplyScalar(kind === 'leg' ? 1 : -1);
  else if (kind === 'leg') _z.negate();
  _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  _q2.setFromRotationMatrix(_m);
  pose[limb.upper] = toDeg(_q2);
  const bend = Math.acos(Math.min(1, Math.max(-1, _u.dot(_s)))) * R2D;
  pose[limb.lower] = [r1(kind === 'leg' ? bend : -bend), 0, 0];
  setRot(upper, pose[limb.upper]);
  setRot(sk.joints[limb.lower], pose[limb.lower]);
}

/** Ankle so the foot is flat (or pitched by `pitch`, + = toes down) and points along fighter-frame `yaw`. */
function solveAnkle(pose, limb, yaw, pitch) {
  const sk = skel();
  const knee = sk.joints[limb.lower];
  knee.updateWorldMatrix(true, false);
  _q.setFromRotationMatrix(_m.extractRotation(knee.matrixWorld)).invert();
  _e.set(pitch * D2R, yaw * D2R, 0, 'YXZ');
  _q2.setFromEuler(_e);
  _q.multiply(_q2);
  pose[limb.end] = toDeg(_q);
  setRot(sk.joints[limb.end], pose[limb.end]);
}

/** Fighter-frame yaw (deg) a joint's local +Z points to (projected on the ground). */
function jointYaw(name) {
  const j = skel().joints[name];
  j.updateWorldMatrix(true, false);
  _o.set(0, 0, 1).applyQuaternion(_q.setFromRotationMatrix(_m.extractRotation(j.matrixWorld)));
  return Math.atan2(_o.x, _o.z) * R2D;
}

const normLimbSpec = (v) => (Array.isArray(v) ? { at: v } : v);

/** Fighter-frame height of a point given in a joint's frame (scratch skeleton, current rotations). */
function footPointY(name, offset) {
  const sk = skel();
  sk.root.updateMatrixWorld(true);
  return _o.fromArray(offset).applyMatrix4(sk.joints[name].matrixWorld).y;
}

/** Bake a spec into a rig pose (degrees). Pure; result is a fresh object. */
export function bake(spec) {
  if (typeof spec === 'string') return spec;
  const sk = skel();
  const pose = {};
  for (const j of JOINTS) if (Array.isArray(spec[j])) pose[j] = spec[j].slice();
  const r = spec.root || {};
  pose.root = { fwd: r.fwd || 0, right: r.right || 0, up: r.up || 0, yaw: r.yaw || 0 };
  // reset scratch skeleton
  for (const j of JOINTS) setRot(sk.joints[j], pose[j] || [0, 0, 0]);
  sk.body.position.set(-pose.root.right, pose.root.up, pose.root.fwd);
  sk.body.rotation.set(0, pose.root.yaw * D2R, 0);
  sk.root.updateMatrixWorld(true);

  // automatic head aim at the opponent (+Z) unless neck/head are authored
  if (spec.look !== false && !spec.neck && !spec.head) {
    const twist = pose.root.yaw + (pose.hips?.[1] || 0) + (pose.spine?.[1] || 0) + (pose.chest?.[1] || 0);
    const pitch = (pose.hips?.[0] || 0) + (pose.spine?.[0] || 0) + (pose.chest?.[0] || 0);
    const tilt = (pose.hips?.[2] || 0) + (pose.spine?.[2] || 0) + (pose.chest?.[2] || 0);
    let need = -twist;
    while (need > 180) need -= 360;
    while (need < -180) need += 360;
    need = Math.max(-100, Math.min(100, need));
    pose.neck = [r1(-pitch * 0.35), r1(need * 0.45), r1(-tilt * 0.4)];
    pose.head = [r1(-pitch * 0.3 + (spec.nod || 0)), r1(need * 0.55), r1(-tilt * 0.3)];
    setRot(sk.joints.neck, pose.neck);
    setRot(sk.joints.head, pose.head);
  }

  for (const side of ['L', 'R']) {
    const f = normLimbSpec(spec['foot' + side]);
    const limb = LIMBS[side].leg;
    if (f && !Array.isArray(spec[limb.upper])) {
      const planted = f.at[1] <= 0.1;
      const at = planted ? [f.at[0], ANKLE_H + Math.max(0, f.at[1]), f.at[2]] : f.at.slice();
      if (planted && (f.pitch || 0) > PLANT_PITCH) {
        // heel raise: pivot on the ball (it stays where a PLANT_PITCH foot's ball is)
        at[1] += ballDrop(f.pitch) - ballDrop(PLANT_PITCH);
        if (typeof f.yaw === 'number') {
          const dz = ballReach(PLANT_PITCH) - ballReach(f.pitch);
          at[0] += Math.sin(f.yaw * D2R) * dz; at[2] += Math.cos(f.yaw * D2R) * dz;
        }
      }
      // default knee pole: forward of the hips, slightly outward
      const pole = f.pole || rotY(pose.root.yaw + (pose.hips?.[1] || 0), [side === 'L' ? 0.25 : -0.25, 0.1, 1]);
      const solveFoot = () => {
        sk.root.updateMatrixWorld(true);
        solveLimb(pose, limb, 'leg', at, pole, f.reach || 0.995);
        if (Array.isArray(f.ankle)) { pose[limb.end] = f.ankle.slice(); setRot(sk.joints[limb.end], pose[limb.end]); }
        else if (planted || f.flat) solveAnkle(pose, limb, f.yaw ?? jointYaw(limb.lower), f.pitch || 0);
        else { pose[limb.end] = [f.pitch ?? 30, 0, 0]; setRot(sk.joints[limb.end], pose[limb.end]); }
      };
      solveFoot();
      // keep a lifted foot out of the floor: raise the ankle target until ball and heel clear it
      for (let it = 0; it < 3 && !planted; it++) {
        const low = Math.min(footPointY(limb.end, BALL), footPointY(limb.end, [0, 0, 0]) - HEEL_DROP);
        if (low >= FLOOR_CLEAR - 1e-4) break;
        at[1] += FLOOR_CLEAR - low;
        solveFoot();
      }
    }
    const h = normLimbSpec(spec['hand' + side]);
    const arm = LIMBS[side].arm;
    if (h && !Array.isArray(spec[arm.upper])) {
      const pole = h.pole || rotY(pose.root.yaw + (pose.hips?.[1] || 0) + (pose.spine?.[1] || 0) + (pose.chest?.[1] || 0),
        [side === 'L' ? 0.6 : -0.6, -1, -0.35]);
      sk.root.updateMatrixWorld(true);
      solveLimb(pose, arm, 'arm', h.at, pole, h.reach || 0.985);
      pose[arm.end] = Array.isArray(h.wrist) ? h.wrist.slice() : [0, 0, 0];
    }
  }
  pose.root = { fwd: r3(pose.root.fwd), right: r3(pose.root.right), up: r3(pose.root.up), yaw: r1(pose.root.yaw) };
  return pose;
}

/** Shallow spec merge (later wins; root objects merge). Use to derive keys from a base spec. */
export function spec(...parts) {
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    for (const k of Object.keys(p)) out[k] = k === 'root' ? { ...(out.root || {}), ...p.root } : p[k];
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ mirroring

export const MIRROR = { FR: 'FL', FL: 'FR', BR: 'BL', BL: 'BR' };
const mirrorName = (s) => (typeof s === 'string' ? s.replace(/(L|R)$/, (c) => (c === 'L' ? 'R' : 'L')) : s);
/** Mirror a key pose: registered stance names map to the mirrored stance, objects are mirrored (L<->R). */
export function mirrorKeyPose(p) {
  if (typeof p === 'string') {
    const m = /^(stance|guard):(FR|FL|BR|BL)$/.exec(p);
    return m ? `${m[1]}:${MIRROR[m[2]]}` : p;
  }
  return mirrorPose(p);
}
export const mirrorLimb = mirrorName;

/** Fighter-frame world position of a STRIKE_POINT / joint for a baked pose (tests & QA). */
export function poseJointPos(pose, name, offset = [0, 0, 0]) {
  const sk = skel();
  for (const j of JOINTS) setRot(sk.joints[j], pose[j] || [0, 0, 0]);
  const r = pose.root || {};
  sk.body.position.set(-(r.right || 0), r.up || 0, r.fwd || 0);
  sk.body.rotation.set(0, (r.yaw || 0) * D2R, 0);
  sk.root.updateMatrixWorld(true);
  return _o.fromArray(offset).applyMatrix4(sk.joints[name].matrixWorld).toArray().map(r3);
}
