// Shared skeleton + pose system. Owned by core. Used by the ANIM agent (model + animator) and the MOVES agent
// (move keyframes). See FIGHTER.md §Rig for the rotation cheat-sheet.
//
// HIERARCHY (fighter faces +Z; the character's LEFT is +X, RIGHT is -X; all lengths metres):
//   root (Group: world position + yaw, owned by the Fighter)
//    └ body (Group: per-pose root offset {fwd, right, up, yaw})
//       └ hips ─ spine ─ chest ─ neck ─ head
//          │             ├ shoulderL ─ elbowL ─ wristL
//          │             └ shoulderR ─ elbowR ─ wristR
//          ├ thighL ─ kneeL ─ ankleL
//          └ thighR ─ kneeR ─ ankleR
// Limbs hang straight down (-Y) in the rest pose; feet point +Z.
//
// POSE (authoring format, DEGREES): { jointName: [x, y, z], ..., root: { fwd, right, up, yaw } }
//   Euler order 'XYZ' (three.js default). Missing joints = rest (0,0,0). root offsets in metres, yaw in degrees.
// TRACK (a move or a clip): { duration, loop?, keys: [{ t, pose, ease? }] }
//   t in seconds; pose = pose object or a registered name ('stance:FR'); ease (name from core/math EASE) shapes the
//   segment that ENDS at this key (default 'inOut').
import * as THREE from 'three';
import { EASE, DEG } from '../core/math.js';

export const JOINTS = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR',
  'thighL', 'kneeL', 'ankleL', 'thighR', 'kneeR', 'ankleR'];
export const JOINT_INDEX = Object.fromEntries(JOINTS.map((j, i) => [j, i]));

export const PARENT = {
  hips: 'body', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulderL: 'chest', elbowL: 'shoulderL', wristL: 'elbowL',
  shoulderR: 'chest', elbowR: 'shoulderR', wristR: 'elbowR',
  thighL: 'hips', kneeL: 'thighL', ankleL: 'kneeL',
  thighR: 'hips', kneeR: 'thighR', ankleR: 'kneeR',
};

/** Joint position relative to its parent (metres), rest pose. Standing height ~1.78 m. */
export const OFFSET = {
  hips: [0, 0.98, 0], spine: [0, 0.10, 0], chest: [0, 0.20, 0], neck: [0, 0.24, 0], head: [0, 0.09, 0],
  shoulderL: [0.18, 0.18, 0], elbowL: [0, -0.28, 0], wristL: [0, -0.25, 0],
  shoulderR: [-0.18, 0.18, 0], elbowR: [0, -0.28, 0], wristR: [0, -0.25, 0],
  thighL: [0.095, -0.05, 0], kneeL: [0, -0.44, 0], ankleL: [0, -0.42, 0],
  thighR: [-0.095, -0.05, 0], kneeR: [0, -0.44, 0], ankleR: [0, -0.42, 0],
};
/** Segment lengths beyond the last joints (for meshes / hit points): hand 0.09, foot 0.22 forward, head 0.2 tall. */
export const EXTENT = { hand: 0.09, foot: 0.22, head: 0.22 };

/** Striking points: joint + local offset (hand tip, foot tip, elbow, knee, head). Used for trails and hit checks. */
export const STRIKE_POINTS = {
  handL: ['wristL', [0, -0.08, 0]], handR: ['wristR', [0, -0.08, 0]],
  footL: ['ankleL', [0, -0.04, 0.16]], footR: ['ankleR', [0, -0.04, 0.16]],
  elbowL: ['elbowL', [0, 0, 0]], elbowR: ['elbowR', [0, 0, 0]],
  kneeL: ['kneeL', [0, 0, 0.06]], kneeR: ['kneeR', [0, 0, 0.06]],
  head: ['head', [0, 0.1, 0.05]],
};

// ------------------------------------------------------------------------------------------------ skeleton

/**
 * Build the joint hierarchy. Returns { root, body, joints: {name: THREE.Bone}, bones: [body, ...JOINTS order] }.
 * Meshes are attached by the ANIM agent (recommended: one rigid-skinned SkinnedMesh bound to `bones`).
 */
export function createSkeleton() {
  const root = new THREE.Group();
  root.name = 'fighter';
  // joints are THREE.Bone so a single rigid-skinned SkinnedMesh can render a whole fighter in one draw call
  const body = new THREE.Bone();
  body.name = 'body';
  root.add(body);
  const joints = { body };
  for (const name of JOINTS) {
    const j = new THREE.Bone();
    j.name = name;
    j.position.fromArray(OFFSET[name]);
    j.rotation.order = 'XYZ';
    joints[name] = j;
  }
  for (const name of JOINTS) joints[PARENT[name]].add(joints[name]);
  const bones = [body, ...JOINTS.map((n) => joints[n])];
  return { root, body, joints, bones };
}

const _v = new THREE.Vector3();
/** World position of a strike point (see STRIKE_POINTS) or joint name. Call after the skeleton's matrices are current. */
export function strikePointWorld(skel, name, out = new THREE.Vector3()) {
  const sp = STRIKE_POINTS[name];
  if (sp) {
    const j = skel.joints[sp[0]];
    j.updateWorldMatrix(true, false);
    return out.fromArray(sp[1]).applyMatrix4(j.matrixWorld);
  }
  const j = skel.joints[name];
  j.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(j.matrixWorld);
}

// ------------------------------------------------------------------------------------------------ pose authoring

const REGISTRY = new Map();
/** Register a named pose (e.g. 'stance:FR', 'guard:FR'). */
export function registerPose(name, pose) { REGISTRY.set(name, pose); _compiled.delete(pose); return pose; }
export function getPose(name) { return REGISTRY.get(name) || null; }
export function hasPose(name) { return REGISTRY.has(name); }
export function poseNames() { return [...REGISTRY.keys()]; }
export function resolvePose(p) {
  if (typeof p === 'string') {
    const r = REGISTRY.get(p);
    if (!r) { if (!resolvePose._warned) resolvePose._warned = new Set(); if (!resolvePose._warned.has(p)) { resolvePose._warned.add(p); console.warn('[rig] unknown pose', p); } return EMPTY; }
    return r;
  }
  return p || EMPTY;
}
const EMPTY = {};

/** Mirror a pose left<->right (swap L/R joints, negate Y/Z rotations, negate root right & yaw). */
export function mirrorPose(pose) {
  const p = resolvePose(pose);
  const out = {};
  for (const k of Object.keys(p)) {
    if (k === 'root') continue;
    const m = k.endsWith('L') ? k.slice(0, -1) + 'R' : k.endsWith('R') ? k.slice(0, -1) + 'L' : k;
    const v = p[k];
    out[m] = [v[0], -v[1], -v[2]];
  }
  if (p.root) out.root = { fwd: p.root.fwd || 0, right: -(p.root.right || 0), up: p.root.up || 0, yaw: -(p.root.yaw || 0) };
  return out;
}

/** Shallow-merge poses: later poses override joints of earlier ones (handy to derive a key from a stance). */
export function mergePoses(...poses) {
  const out = {};
  for (const p of poses) {
    const r = resolvePose(p);
    for (const k of Object.keys(r)) out[k] = k === 'root' ? { ...(out.root || {}), ...r.root } : r[k];
  }
  return out;
}

/** Mirror a whole track (for left/right variants of a move). */
export function mirrorTrack(track) {
  return { ...track, keys: track.keys.map((k) => ({ ...k, pose: mirrorPose(k.pose) })) };
}

// ------------------------------------------------------------------------------------------------ pose buffers

const N = JOINTS.length;
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'XYZ');
const _compiled = new WeakMap();

/** Compile a degree pose into a Float32Array of quaternions (N*4) + root [fwd, right, up, yawRad]. Cached. */
function compile(pose) {
  let c = _compiled.get(pose);
  if (c) return c;
  const q = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const v = pose[JOINTS[i]];
    if (v) { _e.set(v[0] * DEG, v[1] * DEG, v[2] * DEG, 'XYZ'); _q.setFromEuler(_e); } else _q.identity();
    q[i * 4] = _q.x; q[i * 4 + 1] = _q.y; q[i * 4 + 2] = _q.z; q[i * 4 + 3] = _q.w;
  }
  const r = pose.root || {};
  c = { q, root: [r.fwd || 0, r.right || 0, r.up || 0, (r.yaw || 0) * DEG] };
  _compiled.set(pose, c);
  return c;
}

/** A blendable pose: quaternion per joint + root offset. Allocation-free operations. */
export class PoseBuffer {
  constructor() { this.q = new Float32Array(N * 4); this.root = new Float32Array(4); this.setRest(); }
  setRest() { for (let i = 0; i < N; i++) { this.q[i * 4] = 0; this.q[i * 4 + 1] = 0; this.q[i * 4 + 2] = 0; this.q[i * 4 + 3] = 1; } this.root.fill(0); return this; }
  copy(o) { this.q.set(o.q); this.root.set(o.root); return this; }
  /** Set from an authoring pose (object or registered name). */
  setPose(pose) { const c = compile(resolvePose(pose)); this.q.set(c.q); this.root.set(c.root); return this; }
  /** this = slerp(a, b, t). a/b are PoseBuffers. */
  blend(a, b, t) {
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      _qa.set(a.q[o], a.q[o + 1], a.q[o + 2], a.q[o + 3]);
      _qb.set(b.q[o], b.q[o + 1], b.q[o + 2], b.q[o + 3]);
      _qa.slerp(_qb, t);
      this.q[o] = _qa.x; this.q[o + 1] = _qa.y; this.q[o + 2] = _qa.z; this.q[o + 3] = _qa.w;
    }
    for (let k = 0; k < 4; k++) this.root[k] = a.root[k] + (b.root[k] - a.root[k]) * t;
    return this;
  }
  /** Move this pose toward `b` by t (in-place slerp). */
  lerpTo(b, t) { return this.blend(this, b, t); }
  /** Blend only the listed joints toward b (e.g. upper-body guard over legs). */
  blendJoints(b, t, names) {
    for (const name of names) {
      const o = JOINT_INDEX[name] * 4;
      _qa.set(this.q[o], this.q[o + 1], this.q[o + 2], this.q[o + 3]);
      _qb.set(b.q[o], b.q[o + 1], b.q[o + 2], b.q[o + 3]);
      _qa.slerp(_qb, t);
      this.q[o] = _qa.x; this.q[o + 1] = _qa.y; this.q[o + 2] = _qa.z; this.q[o + 3] = _qa.w;
    }
    return this;
  }
  /** Apply to a skeleton from createSkeleton(). */
  applyTo(skel) {
    const j = skel.joints;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      j[JOINTS[i]].quaternion.set(this.q[o], this.q[o + 1], this.q[o + 2], this.q[o + 3]);
    }
    // root offset in fighter-local space: +Z forward, +X = character's left (so right -> -X)
    skel.body.position.set(-this.root[1], this.root[2], this.root[0]);
    skel.body.rotation.set(0, this.root[3], 0);
    return this;
  }
}

const _A = new PoseBuffer();
const _B = new PoseBuffer();
/**
 * Sample a TRACK at time t (seconds) into `out` (PoseBuffer). Loops when track.loop. Before the first key -> first key;
 * after the last key -> last key. Each segment is eased by the destination key's `ease` (default 'inOut').
 */
export function sampleTrack(track, t, out) {
  const keys = track.keys;
  if (!keys || !keys.length) return out.setRest();
  const dur = track.duration || keys[keys.length - 1].t;
  if (track.loop && dur > 0) t = ((t % dur) + dur) % dur;
  if (t <= keys[0].t) return out.setPose(keys[0].pose);
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    if (t <= k.t) {
      const p = keys[i - 1];
      const span = Math.max(1e-6, k.t - p.t);
      const ease = EASE[k.ease || 'inOut'] || EASE.inOut;
      _A.setPose(p.pose); _B.setPose(k.pose);
      return out.blend(_A, _B, ease((t - p.t) / span));
    }
  }
  if (track.loop) { // wrap last -> first
    const p = keys[keys.length - 1], k = keys[0];
    const span = Math.max(1e-6, dur - p.t);
    _A.setPose(p.pose); _B.setPose(k.pose);
    return out.blend(_A, _B, (EASE[k.ease || 'inOut'] || EASE.inOut)((t - p.t) / span));
  }
  return out.setPose(keys[keys.length - 1].pose);
}

/** Track duration (explicit or last key time). */
export const trackDuration = (track) => track.duration || (track.keys && track.keys.length ? track.keys[track.keys.length - 1].t : 0);
