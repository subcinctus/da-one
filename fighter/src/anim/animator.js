// Per-fighter animation: base layer (stance idle + breathing, in-stance walk / strafe / back-step cycles, sprint,
// guard on the upper body) + action layer (moves and clips as full-body overrides with cross-fades) + additive
// head/chest look-at and hit flinch, then cloth springs. Runs at sim rate (Combat calls update() in fixedUpdate).
// RENDER RATE: update() applies the new sim pose to the skeleton; render(alpha) (called by Combat.update once per
// displayed frame, after the root lerp) re-applies a blend of the last two sim poses (and cloth angles) so limbs move
// every displayed frame at 144 Hz and in slow motion. A fighter whose owner never calls render() still animates.
// SIM-SPACE INPUTS: setLocomotion({ yaw, x, z }) gives the fighter's sim yaw / position; when present the turn-in-place
// shuffle, look-at and flinchWorld use them instead of model.root (which is render-interpolated).
//
// COMBO FLOW (FIGHTER.md §6b): playAction ALWAYS cross-fades from the exact pose displayed last step (snapshot of the
// blended output, even when the previous action is frozen or mid-fade), can start a track part-way (startAt = chainIn)
// and blends root offsets / yaw (shortest arc) like the joints, so a chain is one continuous motion. freezeAction()
// holds the current pose (strike hold) without advancing time. Allocation-free per step.
import * as THREE from 'three';
import { PoseBuffer, sampleTrack, trackDuration, strikePointWorld, JOINT_INDEX } from './rig.js';
import { damp, smoothstep, wrapAngle, EASE } from '../core/math.js';
import { ensureAnimData, getClip, STANCE_BUF, GUARD_BUF, CROUCH_BUF, LOCO } from './registry.js';
import { WALK, RUN } from './poses.js';
import { ClothSim } from './cloth.js';
import { legFK, legIK, FOOT_BALL } from './ik.js';

/** Default cross-fade into a chained move (FIGHTER.md §6b CHAIN_BLEND). */
export const CHAIN_BLEND = 0.06;
const STANCE_OK = { FR: true, FL: true, BR: true, BL: true };
const UPPER = ['spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR'];
const DIRS = ['F', 'R', 'B', 'L']; // sectors by angle: 0 forward, +90 right, 180 back, -90 left
const HIPS = JOINT_INDEX.hips, SPINE = JOINT_INDEX.spine, CHEST = JOINT_INDEX.chest, NECK = JOINT_INDEX.neck, HEAD = JOINT_INDEX.head;
const CHAIN = [HIPS, SPINE, CHEST, NECK, HEAD];
const Y = new THREE.Vector3(0, 1, 0);
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Planted-foot pass (after the pose is final), while an action (move / clip) drives the body: a foot whose ball is
// near the floor may not travel more than FOOT_STEP per sim step over the ground (in sim/world space when Combat gives
// the sim pose, else fighter space), never less than the body itself moves (dodges / knockbacks keep their authored
// feet). It lags the sampled foot by at most FOOT_LAG and converges back at that rate, so a held foot never drifts
// away; lifted feet catch up. Locomotion (base layer) is never limited: any lag left dissolves over a few steps.
// Feet are also kept out of the floor. Two-bone IK (anim/ik.js) only on steps where a foot is corrected.
const FOOT_PLANT_H = 0.13;  // ball height (m): limited below (the play-test's 'planted' threshold)
const FOOT_CATCH = 5;       // above it, a lifted foot's lag decays per step by this much per metre of ball height
const FOOT_STEP = 0.027;    // max planted ball travel per 1/120 s step (m)
const FOOT_FAST_BODY = 0.036; // body travel per step (m) above which planted feet simply move with it (dodges, knockbacks)
const FOOT_LAG = 0.22;      // max distance between the displayed and the sampled ball (m)
const FOOT_FLOOR = -0.008;  // lowest ball / heel height (m) during actions (visible penetration only)
const FOOT_MIN_FIX = 0.002; // corrections smaller than this are skipped (2-bone IK is touchy near a straight leg)
const HEEL_DROP = 0.06;     // heel bottom below the ankle (m, unscaled)
const SIDES = ['L', 'R'];
const _ft = new THREE.Vector3();

// Foot-space interpolation (feet on or leaving / reaching the floor). Slerping joints between two poses whose root
// yaw differs (a turning key pair, or a chain cross-fade out of a held strike) swings a planted foot along an arc:
// 10-20 cm per step. When a foot is planted in EITHER pose, its ball is instead placed on the straight line between the
// two balls (its orientation slerped) and the leg is solved with IK, so planted feet slide / pivot exactly as authored
// and a foot leaving or reaching the floor (below FOOT_LINE_MAX_H) goes straight up / down. Between two track keys feet
// lifted in both keys keep the joint arcs; in a cross-fade (chains, clip changes) every foot below FOOT_LINE_MAX_H
// takes the straight line, so a foot folding into the next move never dips through the floor. Kicks keep their arcs.
const FOOT_LINE_MAX_H = 0.45; // above this ball height (either pose) a cross-fading foot keeps the joint-space arc
const _kA = new PoseBuffer(), _kB = new PoseBuffer(), _bf = new PoseBuffer();
const _ba = new THREE.Vector3(), _bb = new THREE.Vector3(), _bo = new THREE.Vector3();
const _fqa = new THREE.Quaternion(), _fqb = new THREE.Quaternion();
/** dst (already = blend(A, B, k) in joint space): feet re-placed in foot space (all = lifted ones too). s = scale. */
function plantBlend(dst, A, B, k, s, all = false) {
  if (!(k > 0 && k < 1)) return;
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i];
    let F = legFK(A, side, s);
    const pa = F.B.y < FOOT_PLANT_H;
    _ba.copy(F.B); _fqa.copy(F.qA);
    F = legFK(B, side, s);
    const pb = F.B.y < FOOT_PLANT_H;
    // feet lifted in both (track keys) and high feet (kicks) keep their joint arcs: a straight line through the hip
    // region would fold the leg violently
    if ((!all && !pa && !pb) || ((!pa || !pb) && Math.max(_ba.y, F.B.y) > FOOT_LINE_MAX_H)) continue;
    _bb.copy(F.B); _fqb.copy(F.qA);
    _ba.lerp(_bb, k); _fqa.slerp(_fqb, k);
    // ankle = ball - footRotation * ballOffset
    _bo.fromArray(FOOT_BALL).multiplyScalar(s).applyQuaternion(_fqa);
    _ft.copy(_ba).sub(_bo);
    legFK(dst, side, s);
    legIK(dst, side, s, _ft, _fqa);
  }
}
/** Foot-space interpolation of a (non-looping) track's planted feet between its two bracketing keys. */
function plantTrack(track, t, out, s) {
  const keys = track.keys;
  if (track.loop || !keys || keys.length < 2 || !(t > keys[0].t) || t >= keys[keys.length - 1].t) return;
  let i = 1;
  while (i < keys.length - 1 && t > keys[i].t) i++;
  const p = keys[i - 1], k = keys[i];
  const span = k.t - p.t;
  if (!(span > 1e-6)) return;
  const u = (EASE[k.ease || 'inOut'] || EASE.inOut)((t - p.t) / span);
  _kA.setPose(p.pose); _kB.setPose(k.pose);
  plantBlend(out, _kA, _kB, u, s);
}

// scratch (module level: single-threaded, never held across calls)
const _qP = new THREE.Quaternion();
const _qL = new THREE.Quaternion();
const _qT = new THREE.Quaternion();
const _qD = new THREE.Quaternion();
const _qF = new THREE.Quaternion();
const _qY = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'XYZ');
const _v = new THREE.Vector3();

const readQ = (buf, i, q) => { const o = i * 4; return q.set(buf.q[o], buf.q[o + 1], buf.q[o + 2], buf.q[o + 3]); };
const writeQ = (buf, i, q) => { const o = i * 4; buf.q[o] = q.x; buf.q[o + 1] = q.y; buf.q[o + 2] = q.z; buf.q[o + 3] = q.w; };

/** out = slerp(a, b, t) with root yaw interpolated along the shortest arc (never spins the long way). */
export function blendWrap(out, a, b, t) {
  const ya = a.root[3], yb = b.root[3];
  out.blend(a, b, t);
  out.root[3] = ya + wrapAngle(yb - ya) * t;
  return out;
}

/** Post-multiply a small local rotation (radians, XYZ) onto joint i of a buffer. */
function addLocal(buf, i, x, y, z) {
  if (!x && !y && !z) return;
  _e.set(x, y, z, 'XYZ');
  _qD.setFromEuler(_e);
  readQ(buf, i, _qL).multiply(_qD);
  writeQ(buf, i, _qL);
}

export class Animator {
  /** @param model result of createFighterModel() */
  constructor(model) {
    ensureAnimData();
    this.model = model || null;
    this.skel = model?.skeleton || null;
    this.stance = 'FR';
    this.loco = { stance: 'FR', vx: 0, vz: 0, speed: 0, guard: false, locked: true, crouch: false, hasSim: false, yaw: 0, x: 0, z: 0 };
    this.phase = 0;
    this.runPhase = 0;
    this.wLoco = 0; this.wRun = 0; this.wGuard = 0; this.wCrouch = 0; this.locoAngle = 0;
    this.time = 0;
    this.base = new PoseBuffer().copy(STANCE_BUF.FR);
    this.baseFrom = new PoseBuffer();
    this.baseFadeT = 1; this.baseFadeDur = 0.15;
    this._a = new PoseBuffer(); this._b = new PoseBuffer();
    this.act = new PoseBuffer();
    this.from = new PoseBuffer();
    this.mix = new PoseBuffer().copy(STANCE_BUF.FR);  // displayed pose before additives (snapshot source)
    this.out = new PoseBuffer().copy(STANCE_BUF.FR);  // displayed pose
    this.prevOut = new PoseBuffer().copy(this.out);   // previous sim step's pose (render interpolation)
    this._r = new PoseBuffer();                       // render-frame blend scratch
    this.layer = 'base';          // 'base' | 'action' | 'exit'
    this.action = null;           // current handle
    this.fadeT = 0; this.fadeDur = 0;
    this.freezeT = 0;
    this.exitFade = 0.1;
    // look-at
    this.lookTarget = new THREE.Vector3();
    this.lookObj = null; this.hasLook = false;
    this.lookW = 0; this.lookYaw = 0; this.lookPitch = 0;
    // flinch spring (fighter-space pitch / roll + root push)
    this.fp = 0; this.fr = 0; this.fvp = 0; this.fvr = 0;
    this.fo = 0; this.fvo = 0; this.foX = 0; this.foZ = 0;
    // cloth
    this.cloth = new ClothSim(model);
    this.prevRoot = new Float32Array(4);
    // planted-foot pass state: displayed ball XZ per foot (world when hasSim, else fighter space)
    this.feet = { L: { x: 0, z: 0, sx: 0, sz: 0 }, R: { x: 0, z: 0, sx: 0, sz: 0 }, init: false, px: 0, pz: 0, yaw: 0, sim: false };
    this.footPass = true;
    this._lastYaw = null;
    this.yawRate = 0;
    this.vel = new THREE.Vector3();
    if (this.skel) this.out.applyTo(this.skel);
  }

  // ---------------------------------------------------------------------------------------------- inputs

  /**
   * Called every sim step by Combat: { stance, vx, vz (local m/s, +x right, +z forward), speed, guard, locked, crouch,
   * yaw?, x?, z? (sim-space facing / position; optional, preferred over the render-interpolated model.root) }.
   */
  setLocomotion(o) {
    if (!o) return;
    const L = this.loco;
    if (typeof o.yaw === 'number' && Number.isFinite(o.yaw)) {
      L.hasSim = true; L.yaw = o.yaw;
      L.x = Number.isFinite(o.x) ? o.x : 0; L.z = Number.isFinite(o.z) ? o.z : 0;
    }
    if (o.stance && STANCE_OK[o.stance]) L.stance = o.stance;
    L.vx = +o.vx || 0;
    L.vz = +o.vz || 0;
    L.speed = typeof o.speed === 'number' ? Math.abs(o.speed) : Math.hypot(L.vx, L.vz);
    L.guard = !!o.guard;
    L.locked = o.locked !== false;
    L.crouch = !!o.crouch;
  }

  /**
   * Play a move (object with .keys) or a clip name as a full-body override. Always cross-fades from the pose shown last
   * step. opts: { fade = 0.06, speed = 1, loop = false, onEnd, startAt = 0, fromCurrent = true, hold }.
   * Returns { name, time, duration, done, speed, stop() }.
   */
  playAction(trackOrName, opts = {}) {
    let track = trackOrName;
    if (typeof trackOrName === 'string') {
      let name = trackOrName;
      if (name === 'getup') {
        // rise from however the body actually lies (knockdown on the back, death / back-stance falls on the face)
        const o = HIPS * 4, pitch = 2 * Math.atan2(this.mix.q[o], this.mix.q[o + 3]);
        if (pitch > 0.7) name = 'getup_prone'; else if (pitch < -0.7) name = 'getup_supine';
      }
      track = getClip(name, this.loco.stance) || getClip(trackOrName, this.loco.stance) || getClip(trackOrName, this.stance);
      if (!track) {
        if (!Animator._warned) Animator._warned = new Set();
        if (!Animator._warned.has(trackOrName)) { Animator._warned.add(trackOrName); console.warn('[anim] unknown clip', trackOrName); }
        track = { duration: 0.2, keys: [{ t: 0, pose: 'stance:' + this.loco.stance }], name: trackOrName };
      }
    }
    if (!track || !track.keys || !track.keys.length) track = { duration: 0.1, keys: [{ t: 0, pose: 'stance:' + this.loco.stance }], name: 'empty' };
    const self = this;
    const duration = trackDuration(track);
    const handle = {
      name: track.name || track.id || (typeof trackOrName === 'string' ? trackOrName : 'track'),
      track,
      time: Math.max(0, +opts.startAt || 0),
      duration,
      speed: typeof opts.speed === 'number' ? opts.speed : 1,
      loop: !!(opts.loop ?? track.loop),
      hold: !!(opts.hold ?? track.hold),
      look: typeof track.look === 'number' ? track.look : (track.startup !== undefined ? 0.6 : 0.8),
      exitFade: typeof opts.exitFade === 'number' ? opts.exitFade : (track.exitFade ?? 0.1),
      onEnd: typeof opts.onEnd === 'function' ? opts.onEnd : null,
      done: false,
      fresh: true,          // first update shows startAt itself (time == the caller's move clock on every step)
      ax: 0, ar: 0, ay: 0,
      stop(fade = 0.1) { if (self.action === handle) self.stopAction(fade); else handle.done = true; },
    };
    // snapshot the exact displayed pose (pre-additive) as the blend source
    if (opts.fromCurrent === false) this.from.copy(this.base); else this.from.copy(this.mix);
    if (track.anchor || opts.anchor) {
      // anchored clips start where the body is (root offset / yaw) and drift to their own root over the clip
      sampleTrack(track, handle.time, this._b);
      handle.ax = this.from.root[0] - this._b.root[0];
      handle.ar = this.from.root[1] - this._b.root[1];
      handle.ay = wrapAngle(this.from.root[3] - this._b.root[3]);
    }
    const fade = typeof opts.fade === 'number' ? opts.fade : CHAIN_BLEND;
    this.fadeDur = fade > 0 ? fade : 0;
    this.fadeT = 0;
    this.freezeT = 0;
    if (this.action && this.action !== handle && !this.action.done) this.action.done = true;
    this.action = handle;
    this.layer = 'action';
    return handle;
  }

  /** Hold the current action pose for `seconds` without advancing its time (strike hold, §6b). */
  freezeAction(seconds = 0.05) {
    if (this.layer === 'action') this.freezeT = Math.max(0, seconds);
  }

  /** Blend out of the current action back to the base layer. */
  stopAction(fade = 0.1) {
    if (this.layer === 'base') return;
    if (this.action) this.action.done = true;
    this.action = null;
    this.from.copy(this.mix);
    this.fadeT = 0;
    this.fadeDur = Math.max(0, fade);
    this.freezeT = 0;
    this.layer = this.fadeDur > 0 ? 'exit' : 'base';
  }

  /** Subtle head / chest aim. Pass a point (Vector3-like), an object with .position (tracked live), or null. */
  lookAt(target) {
    if (!target) { this.hasLook = false; this.lookObj = null; return; }
    if (target.position && typeof target.position.x === 'number') { this.lookObj = target; this.hasLook = true; return; }
    if (typeof target.x === 'number') { this.lookTarget.set(target.x, target.y || 0, target.z || 0); this.lookObj = null; this.hasLook = true; }
  }

  /**
   * Procedural hit flinch (additive). dirLocal: push direction in fighter space (+x right, +z forward), e.g.
   * {x: 0, z: -1} for a hit from the front. amount ~0.3 light .. 1 heavy.
   */
  flinch(dirLocal, amount = 0.5) {
    let x = dirLocal ? +dirLocal.x || 0 : 0, z = dirLocal ? +dirLocal.z || 0 : -1;
    const l = Math.hypot(x, z) || 1;
    x /= l; z /= l;
    const a = Math.min(1.5, Math.max(0, amount));
    this.fvp += z * a * 4.2;        // push forward -> lean forward (+X)
    this.fvr += x * a * 3.4;        // push to own right (-X axis) -> tilt right (+Z)
    this.fvo += a * 0.9;
    this.foX = x; this.foZ = z;
  }

  /** flinch() with a world-space direction (e.g. the `hit` event's dir). */
  flinchWorld(dirWorld, amount = 0.5) {
    if (!dirWorld || (!this.model && !this.loco.hasSim)) return;
    const yaw = this.loco.hasSim ? this.loco.yaw : this.model.root.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw);
    // world -> fighter: x' (left) = x cos - z sin, z' = x sin + z cos ; contract x is +right
    const lx = dirWorld.x * c - dirWorld.z * s, lz = dirWorld.x * s + dirWorld.z * c;
    _v.set(-lx, 0, lz);
    this.flinch(_v, amount);
  }

  /** World position of a STRIKE_POINT (handR, footL, ...) or joint. */
  strikePoint(name, out = new THREE.Vector3()) {
    if (!this.skel) return out.set(0, 0, 0);
    return strikePointWorld(this.skel, name, out);
  }

  /** Current stance pose name the base layer is in. */
  get currentStance() { return this.stance; }
  /** True while an action (move / clip) drives the body. */
  get busy() { return this.layer === 'action' && !!this.action && (!this.action.done || this.action.hold); }

  // ---------------------------------------------------------------------------------------------- step

  /** Advance at sim rate and apply to the skeleton. */
  update(dt) {
    if (!(dt > 0)) dt = 1 / 120;
    this.prevOut.copy(this.out);
    this.time += dt;
    this._updateBase(dt);
    this._updateAction(dt);
    this.out.copy(this.mix);
    this._additives(dt);
    if (this.skel && this.footPass) this._plantFeet(dt);
    if (this.skel) this.out.applyTo(this.skel);
    if (this.trace) this._traceStep();
    // body velocity for cloth: locomotion + root-offset motion (fighter space, x = own left)
    const r = this.out.root, pr = this.prevRoot;
    const inv = 1 / dt;
    let vx = -this.loco.vx + -(r[1] - pr[1]) * inv, vz = this.loco.vz + (r[0] - pr[0]) * inv, vy = (r[2] - pr[2]) * inv;
    const cl = 6;
    vx = vx > cl ? cl : vx < -cl ? -cl : vx; vz = vz > cl ? cl : vz < -cl ? -cl : vz; vy = vy > cl ? cl : vy < -cl ? -cl : vy;
    this.vel.x += (vx - this.vel.x) * 0.5; this.vel.y += (vy - this.vel.y) * 0.5; this.vel.z += (vz - this.vel.z) * 0.5;
    pr.set(r);
    if (this.skel) this.cloth.update(dt, this.out, this.vel.x, this.vel.y, this.vel.z);
    // decaying hit flash (sim rate is fine: it is a slow fade)
    const f = this.model && this.model._flash;
    if (f && f.t > 0) {
      f.t -= dt;
      const k = f.t > 0 ? f.t / f.dur : 0;
      this.model.setTint(f.color, f.amount * k * k);
    }
  }

  /**
   * Render-rate pose: re-apply slerp(previous sim pose, current sim pose, alpha) and the cloth angles to the skeleton.
   * Call once per displayed frame after the root lerp (alpha = the game's sim interpolation factor). No allocation.
   */
  render(alpha) {
    if (!this.skel) return;
    const a = alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;
    if (a >= 1) this.out.applyTo(this.skel);
    else blendWrap(this._r, this.prevOut, this.out, a).applyTo(this.skel);
    this.cloth.render(a);
  }

  _updateBase(dt) {
    const L = this.loco;
    if (L.stance !== this.stance) {
      // only cross-fade the base if it is (partly) visible; an action ending in the new stance already lands on it
      if (this.layer !== 'action') { this.baseFrom.copy(this.base); this.baseFadeT = 0; } else this.baseFadeT = this.baseFadeDur;
      this.stance = L.stance;
    }
    const st = this.stance;
    // turning in place: a small in-stance shuffle instead of sliding feet (sim yaw when Combat provides it)
    const root = this.model && this.model.root;
    if (L.hasSim || root) {
      const ry = L.hasSim ? L.yaw : root.rotation.y;
      let d = this._lastYaw === null ? 0 : wrapAngle(ry - this._lastYaw);
      if (d > 0.5 || d < -0.5) d = 0; // teleports / spawns
      this._lastYaw = ry;
      this.yawRate += (d / dt - this.yawRate) * damp(10, dt);
    }
    let sp = L.speed, vx = L.vx, vz = L.vz;
    const turn = this.yawRate > 0 ? this.yawRate : -this.yawRate;
    if (turn > 1.2 && sp < 0.6 && this.wRun < 0.1) {
      const ts = Math.min(1.1, (turn - 1.2) * 0.5);
      vx -= (this.yawRate > 0 ? 1 : -1) * ts;
      sp = Math.hypot(vx, vz);
    }
    this.wLoco += (smoothstep(0.08, 0.85, sp) - this.wLoco) * damp(14, dt);
    this.wRun += ((!L.locked && sp > 3.0 ? smoothstep(3.0, 3.9, sp) : 0) - this.wRun) * damp(9, dt);
    this.wGuard += ((L.guard ? 1 : 0) - this.wGuard) * damp(24, dt);
    this.wCrouch += ((L.crouch ? 1 : 0) - this.wCrouch) * damp(12, dt);
    this.phase = (this.phase + dt * sp / WALK.stride) % 1;
    this.runPhase = (this.runPhase + dt * sp / RUN.stride) % 1;

    const base = this.base;
    base.copy(STANCE_BUF[st]);
    if (this.wCrouch > 0.005) base.blend(base, CROUCH_BUF[st], this.wCrouch);
    // idle breathing + slow weight shift (fades out while walking)
    const idle = 1 - this.wLoco;
    if (idle > 0.01) {
      const t = this.time;
      const br = Math.sin(t * 1.85), ws = Math.sin(t * 1.23 + 0.7);
      addLocal(base, CHEST, -0.022 * br * idle, 0, 0);
      addLocal(base, NECK, 0.014 * br * idle, 0, 0);
      addLocal(base, HIPS, 0, 0, 0.012 * ws * idle);
      addLocal(base, SPINE, 0, 0, -0.01 * ws * idle);
      base.root[2] += 0.005 * br * idle;
      base.root[1] += 0.01 * ws * idle;
    }
    if (this.wLoco > 0.005) {
      // direction sector blend; angle measured from forward toward the right (+vx)
      if (sp > 0.05) this.locoAngle = Math.atan2(vx, vz);
      let a = this.locoAngle / (Math.PI / 2);
      if (a < 0) a += 4;
      const i0 = Math.floor(a) % 4, i1 = (i0 + 1) % 4, fr = a - Math.floor(a);
      const cyc = LOCO.walk[st];
      sampleTrack(cyc[DIRS[i0]], this.phase, this._a);
      if (fr > 0.001) { sampleTrack(cyc[DIRS[i1]], this.phase, this._b); this._a.blend(this._a, this._b, fr); }
      base.blend(base, this._a, this.wLoco * (1 - this.wCrouch * 0.5));
    }
    if (this.wRun > 0.005) {
      sampleTrack(LOCO.run, this.runPhase, this._b);
      blendWrap(base, base, this._b, this.wRun);
    }
    if (this.wGuard > 0.005) base.blendJoints(GUARD_BUF[st], this.wGuard * (1 - this.wRun), UPPER);
    if (this.baseFadeT < this.baseFadeDur) {
      this.baseFadeT += dt;
      const kb = ease(this.baseFadeT / this.baseFadeDur);
      _bf.copy(base);
      blendWrap(base, this.baseFrom, _bf, kb);
      if (this.skel && this.footPass) plantBlend(base, this.baseFrom, _bf, kb, this.skel.body.scale.x || 1);
    }
  }

  _updateAction(dt) {
    if (this.layer === 'base') { this.mix.copy(this.base); return; }
    if (this.layer === 'exit') {
      this.fadeT += dt;
      const k = this.fadeDur > 0 ? ease(this.fadeT / this.fadeDur) : 1;
      if (k >= 1) { this.layer = 'base'; this.mix.copy(this.base); }
      else {
        blendWrap(this.mix, this.from, this.base, k);
        if (this.skel && this.footPass) plantBlend(this.mix, this.from, this.base, k, this.skel.body.scale.x || 1, true);
      }
      return;
    }
    const a = this.action;
    if (!a) { this.layer = 'base'; this.mix.copy(this.base); return; }
    if (this.freezeT > 0) this.freezeT -= dt;
    else if (!(a.done && a.hold)) {
      // a freshly played action shows startAt on its first step (the caller set its own clock to startAt this step)
      if (!a.fresh) a.time += dt * a.speed;
      this.fadeT += dt;
    }
    a.fresh = false;
    let ended = false;
    if (!a.loop && a.time >= a.duration && !a.done) { a.done = true; ended = true; }
    const ts = a.loop ? a.time : (a.time < a.duration ? a.time : a.duration);
    sampleTrack(a.track, ts, this.act);
    if (this.skel && this.footPass) plantTrack(a.track, ts, this.act, this.skel.body.scale.x || 1);
    if (a.ax || a.ar || a.ay) {
      const w = 1 - ease(a.duration > 0 ? a.time / (a.duration * 0.85) : 1);
      this.act.root[0] += a.ax * w; this.act.root[1] += a.ar * w; this.act.root[3] += a.ay * w;
    }
    const k = this.fadeDur > 0 ? ease(this.fadeT / this.fadeDur) : 1;
    if (k < 1) {
      blendWrap(this.mix, this.from, this.act, k);
      if (this.skel && this.footPass) plantBlend(this.mix, this.from, this.act, k, this.skel.body.scale.x || 1, true);
    } else this.mix.copy(this.act);
    if (ended) {
      const cb = a.onEnd;
      if (!a.hold) this.stopAction(a.exitFade);
      if (cb) { try { cb(a); } catch (e) { console.error('[anim] onEnd error', e); } }
    }
  }

  _additives(dt) {
    const out = this.out;
    // ---- flinch spring
    const kS = 520, cS = 26;
    this.fvp += (-this.fp * kS - this.fvp * cS) * dt; this.fp += this.fvp * dt;
    this.fvr += (-this.fr * kS - this.fvr * cS) * dt; this.fr += this.fvr * dt;
    this.fvo += (-this.fo * 360 - this.fvo * 22) * dt; this.fo += this.fvo * dt;
    const fl = Math.abs(this.fp) + Math.abs(this.fr) > 1e-4;
    if (Math.abs(this.fo) > 1e-5) { out.root[0] += this.foZ * this.fo * 0.06; out.root[1] += this.foX * this.fo * 0.06; }

    // ---- look-at weight / angles
    const layerLook = this.layer === 'action' && this.action ? this.action.look : 1;
    let wantW = 0, wantYaw = this.lookYaw, wantPitch = 0;
    const root = this.model && this.model.root;
    const L = this.loco;
    if (this.hasLook && (root || L.hasSim)) {
      const tp = this.lookObj ? this.lookObj.position : this.lookTarget;
      const px = L.hasSim ? L.x : root.position.x, pz = L.hasSim ? L.z : root.position.z;
      const dx = tp.x - px, dz = tp.z - pz;
      const ry = L.hasSim ? L.yaw : root.rotation.y, c = Math.cos(ry), s = Math.sin(ry);
      const lx = dx * c - dz * s, lz = dx * s + dz * c; // fighter space (x = own left)
      // current head facing (fighter space)
      _qP.setFromAxisAngle(Y, out.root[3]);
      for (let i = 0; i < CHAIN.length; i++) _qP.multiply(readQ(out, CHAIN[i], _qL));
      _v.set(0, 0, 1).applyQuaternion(_qP);
      const headYaw = Math.atan2(_v.x, _v.z);
      const d = wrapAngle(Math.atan2(lx, lz) - headYaw);
      const ad = Math.abs(d);
      if (ad < 2.1) { wantW = layerLook * (ad > 1.5 ? 1 - (ad - 1.5) / 0.6 : 1); wantYaw = d > 1.1 ? 1.1 : d < -1.1 ? -1.1 : d; }
      let ty = tp.y;
      if (!this.lookObj && ty < 0.3) ty += 1.5; else if (this.lookObj) ty += 1.5;
      const scale = this.skel ? this.skel.body.scale.y : 1;
      const hy = (root ? root.position.y : 0) + (1.62 + out.root[2]) * scale;
      const hd = Math.max(0.5, Math.hypot(lx, lz));
      wantPitch = Math.atan2(ty - hy, hd);
      wantPitch = wantPitch > 0.45 ? 0.45 : wantPitch < -0.5 ? -0.5 : wantPitch;
    }
    const kl = damp(10, dt);
    this.lookW += (wantW - this.lookW) * kl;
    this.lookYaw += (wantYaw - this.lookYaw) * kl;
    this.lookPitch += (wantPitch - this.lookPitch) * kl;
    const ly = this.lookYaw * this.lookW, lp = this.lookPitch * this.lookW;
    const hasLook = Math.abs(ly) > 1e-4 || Math.abs(lp) > 1e-4;
    if (!fl && !hasLook) return;

    // ---- apply as fighter-space rotations down the spine chain (children follow their parents)
    _e.set(this.fp, 0, this.fr, 'XYZ');
    _qF.setFromEuler(_e);                      // full flinch rotation (fighter space)
    _qP.setFromAxisAngle(Y, out.root[3]);      // parent world of hips = body yaw
    _qP.multiply(readQ(out, HIPS, _qL));
    // spine: 35% flinch
    this._worldDelta(SPINE, 0.35, 0, fl);
    this._worldDelta(CHEST, 0.45, ly * 0.22, fl);
    this._worldDelta(NECK, 0, ly * 0.33, false);
    this._worldDelta(HEAD, 0.4, ly * 0.45, fl);
    if (hasLook) { addLocal(out, NECK, -lp * 0.4, 0, 0); addLocal(out, HEAD, -lp * 0.6, 0, 0); }
  }

  /** Planted-foot pass on `out` (see FOOT_* above). */
  _plantFeet(dt) {
    const L = this.loco, F = this.feet, s = this.skel.body.scale.x || 1;
    const sim = L.hasSim;
    const yaw = sim ? L.yaw : 0, px = sim ? L.x : 0, pz = sim ? L.z : 0;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    // how far the body itself travelled this step (planted feet move with a FAST body: dodges, knockbacks)
    let body = 0;
    if (F.init && F.sim === sim) {
      body = Math.hypot(px - F.px, pz - F.pz);
      if (body > 0.5 || Math.abs(wrapAngle(yaw - F.yaw)) > 0.8) F.init = false;   // teleport / respawn
    } else F.init = false;
    const reset = !F.init;
    F.init = true; F.sim = sim; F.px = px; F.pz = pz; F.yaw = yaw;
    const step = body > FOOT_FAST_BODY ? body * 1.1 : FOOT_STEP;
    const limit = this.layer !== 'base';
    // a move may exempt a deliberately skimming foot (floor sweeps: track.freeFeet = ['footR'])
    const free = this.layer === 'action' && this.action && this.action.track ? this.action.track.freeFeet : null;
    for (let i = 0; i < 2; i++) {
      const side = SIDES[i], st = F[side];
      const fk = legFK(this.out, side, s);
      // sampled ball in world (sim) space: model root rotation y = yaw, fighter x = own left
      const bx = px + fk.B.x * c + fk.B.z * sn, bz = pz - fk.B.x * sn + fk.B.z * c;
      const h = fk.B.y;
      if (reset || (free && free.indexOf(side === 'L' ? 'footL' : 'footR') >= 0)) { st.x = bx; st.z = bz; }
      else if (!limit) {
        // locomotion: no limit, the lag behind the sampled foot (if any) fades out
        st.x = bx + (st.x - st.sx) * 0.6; st.z = bz + (st.z - st.sz) * 0.6;
      } else if (h > FOOT_PLANT_H) {
        // lifted: the lag behind the sampled foot decays (faster the higher the foot is), never a one-step snap
        const keep = Math.max(0, Math.min(0.85, 1 - (h - FOOT_PLANT_H) * FOOT_CATCH));
        st.x = bx + (st.x - st.sx) * keep; st.z = bz + (st.z - st.sz) * keep;
      } else {
        // planted: travels at most `step` toward the sampled foot
        let dx = bx - st.x, dz = bz - st.z;
        const d = Math.hypot(dx, dz);
        if (d > step) { st.x += dx * (step / d); st.z += dz * (step / d); } else { st.x = bx; st.z = bz; }
        dx = st.x - bx; dz = st.z - bz;
        const lag = Math.hypot(dx, dz);
        if (lag > FOOT_LAG) { st.x = bx + dx * (FOOT_LAG / lag); st.z = bz + dz * (FOOT_LAG / lag); }
      }
      st.sx = bx; st.sz = bz;
      // correction back in fighter space
      const wx = st.x - bx, wz = st.z - bz;
      const fx = wx * c - wz * sn, fz = wx * sn + wz * c;
      const low = Math.min(h, fk.A.y - HEEL_DROP * s);
      const lift = limit && low < FOOT_FLOOR ? FOOT_FLOOR - low : 0;
      if (fx * fx + fz * fz < FOOT_MIN_FIX * FOOT_MIN_FIX && lift < FOOT_MIN_FIX) continue;
      _ft.set(fk.A.x + fx, fk.A.y + lift, fk.A.z + fz);
      legIK(this.out, side, s, _ft);
    }
  }

  /** Rotate joint j by (flinch * fk, yaw) in fighter space; _qP holds its parent's world rotation and is advanced. */
  _worldDelta(j, fk, yaw, useFlinch) {
    const out = this.out;
    readQ(out, j, _qL);
    if ((useFlinch && fk) || yaw) {
      if (useFlinch && fk) _qD.identity().slerp(_qF, fk); else _qD.identity();
      if (yaw) { _qY.setFromAxisAngle(Y, yaw); _qD.premultiply(_qY); }
      // local' = P^-1 * D * P * local
      _qT.copy(_qP).invert().multiply(_qD).multiply(_qP).multiply(_qL);
      writeQ(out, j, _qT);
      _qL.copy(_qT);
    }
    _qP.multiply(_qL);
  }

  // ---------------------------------------------------------------------------------------------- debug trace

  /**
   * Debug: record per-step motion (max joint rotation change in degrees, root offset change in metres, layer) and
   * action events, to verify chains never pop. Allocates once here; nothing per step.
   */
  enableTrace(steps = 720) {
    this.trace = { n: steps, i: 0, d: new Float32Array(steps * 3), prev: new PoseBuffer().copy(this.out), events: [] };
    const self = this;
    const pa = this.playAction.bind(this), fz = this.freezeAction.bind(this);
    this.playAction = (t, o = {}) => { self.trace.events.push({ step: self.trace.i, type: 'play', name: typeof t === 'string' ? t : (t && (t.id || t.name)), startAt: o.startAt || 0, fade: o.fade }); return pa(t, o); };
    this.freezeAction = (sec) => { self.trace.events.push({ step: self.trace.i, type: 'freeze', sec }); return fz(sec); };
    return this.trace;
  }

  _traceStep() {
    const T = this.trace, a = T.prev.q, b = this.out.q;
    let mx = 0;
    for (let i = 0; i < 17; i++) {
      const o = i * 4;
      const d = Math.abs(a[o] * b[o] + a[o + 1] * b[o + 1] + a[o + 2] * b[o + 2] + a[o + 3] * b[o + 3]);
      const ang = 2 * Math.acos(d > 1 ? 1 : d);
      if (ang > mx) mx = ang;
    }
    const r0 = T.prev.root, r1 = this.out.root;
    const k = (T.i % T.n) * 3;
    T.d[k] = mx * 57.29578;
    T.d[k + 1] = Math.hypot(r1[0] - r0[0], r1[1] - r0[1], r1[2] - r0[2]) + Math.abs(wrapAngle(r1[3] - r0[3])) * 0.3;
    T.d[k + 2] = this.layer === 'base' ? 0 : this.layer === 'exit' ? 2 : this.freezeT > 0 ? 3 : 1;
    T.prev.copy(this.out);
    T.i++;
  }

  /** Snap cloth springs (after spawning / teleporting the fighter). */
  resetSecondary() { this.cloth.reset(); this.prevRoot.set(this.out.root); this.prevOut.copy(this.out); this.vel.set(0, 0, 0); this.feet.init = false; }
}

