// Every contracted clip (FIGHTER.md §5), authored from the stance specs with IK so planted feet stay planted.
// Clips that start/end in a stance are generated per stance: '<name>@FR' etc. (FR/BR authored, FL/BL mirrored);
// '<name>' alone is the FR variant. The Animator picks '<name>@<current stance>' automatically.
// Track extras: hold (keep the last frame after the end: lying clips), look (head-aim weight 0..1), exitFade.
import { mirrorTrack } from './rig.js';
import { STANCE_SPEC, GUARD_SPEC, NEUTRAL_SPEC, POSES, STANCES } from './poses.js';
import { poseFromSpec, addSpec, lerpSpec, withSpec, lockArms, cloneSpec, ANKLE_H } from './ik.js';

const A = ANKLE_H;
const MIR = { FR: 'FL', BR: 'BL', FL: 'FR', BL: 'BR' };
const P = poseFromSpec;
/** Stance pose + delta with the arms riding along with the torso. */
const R = (st, d) => P(addSpec(lockArms(STANCE_SPEC[st], POSES['stance:' + st]), d));
/** Guard pose + delta (arms locked). */
const G = (st, d) => P(addSpec(lockArms(GUARD_SPEC[st], POSES['guard:' + st]), d));
/** Stance spec + delta with IK hands (hand deltas move the fists). */
const S = (st, d) => P(addSpec(STANCE_SPEC[st], d));
/** Build a track from [t, pose, ease] rows. */
const T = (duration, rows, extra = {}) => ({ duration, keys: rows.map(([t, pose, ease]) => ({ t, pose, ease: ease || 'inOut' })), ...extra });
const isBack = (st) => st[0] === 'B';

// ------------------------------------------------------------------------------------------------ reactions

function hitHigh(st) {
  return T(0.35, [
    [0, 'stance:' + st],
    [0.05, R(st, { root: { fwd: -0.08, up: -0.01 }, world: { spine: [-8, 0, 0], chest: [-11, 0, 4], neck: [-12, 0, 0], head: [-30, 0, 8] }, add: { shoulderL: [-10, 0, 8], shoulderR: [-12, 0, -8], elbowL: [14, 0, 0], elbowR: [14, 0, 0] } }), 'snap'],
    [0.16, R(st, { root: { fwd: -0.05 }, world: { spine: [-4, 0, 0], chest: [-5, 0, 2], head: [-12, 0, 3] }, add: { elbowL: [6, 0, 0], elbowR: [6, 0, 0] } }), 'out'],
    [0.35, 'stance:' + st],
  ], { look: 0.4 });
}

function hitMid(st) {
  return T(0.35, [
    [0, 'stance:' + st],
    [0.06, R(st, { root: { fwd: -0.06, up: -0.045 }, world: { spine: [13, 0, 0], chest: [10, 0, 0], head: [4, 0, 0] }, add: { shoulderL: [12, 0, -4], shoulderR: [12, 0, 4], elbowL: [-14, 0, 0], elbowR: [-14, 0, 0] } }), 'snap'],
    [0.18, R(st, { root: { fwd: -0.04, up: -0.03 }, world: { spine: [8, 0, 0], chest: [5, 0, 0] } }), 'out'],
    [0.35, 'stance:' + st],
  ], { look: 0.5 });
}

function hitLow(st) {
  return T(0.35, [
    [0, 'stance:' + st],
    [0.06, R(st, { root: { up: -0.13, fwd: -0.03 }, world: { hips: [0, 0, 7], spine: [7, 0, -4], chest: [4, 0, -3], head: [5, 0, 0] }, footR: { p: [0.03, 0, -0.04], pitch: 8 } }), 'snap'],
    [0.2, R(st, { root: { up: -0.08 }, world: { hips: [0, 0, 4], spine: [4, 0, -2] }, footR: { p: [0.015, 0, -0.02] } }), 'out'],
    [0.35, 'stance:' + st],
  ], { look: 0.5 });
}

function hitHeavy(st) {
  return T(0.6, [
    [0, 'stance:' + st],
    [0.05, R(st, { root: { fwd: -0.1, up: -0.02 }, world: { spine: [-10, 0, 0], chest: [-11, 0, 4], head: [-22, 0, 6] }, add: { shoulderL: [-16, 0, 12], shoulderR: [-16, 0, -12], elbowL: [20, 0, 0], elbowR: [20, 0, 0] } }), 'snap'],
    [0.19, R(st, { root: { fwd: -0.12, up: 0.0 }, world: { spine: [-8, 0, 0], chest: [-6, 0, 2], head: [-10, 0, 0] }, footL: { p: [0.02, 0.07, -0.2], pitch: 15 }, add: { shoulderL: [-8, 0, 8], shoulderR: [-8, 0, -8] } }), 'out'],
    [0.31, R(st, { root: { fwd: -0.08, up: -0.04 }, world: { spine: [-2, 0, 0] }, footL: { p: [0.01, 0, -0.16] }, footR: { p: [0.0, 0.07, -0.2], pitch: 12 } })],
    [0.44, R(st, { root: { up: -0.05 }, world: { spine: [5, 0, 0], chest: [2, 0, 0] }, footL: { p: [0, 0, -0.06] }, footR: { p: [0, 0, -0.08] } }), 'out'],
    [0.6, 'stance:' + st],
  ], { look: 0.3 });
}

function blockHit(st) {
  return T(0.2, [
    [0, 'guard:' + st],
    [0.04, G(st, { root: { fwd: -0.06, up: -0.015 }, world: { spine: [-4, 0, 0], chest: [-5, 0, 0], head: [-5, 0, 0] } }), 'snap'],
    [0.2, 'guard:' + st, 'out'],
  ], { look: 0.8, exitFade: 0.08 });
}

function guardBreak(st) {
  return T(0.8, [
    [0, 'guard:' + st],
    [0.07, R(st, { root: { fwd: -0.12 }, world: { spine: [-12, 0, 0], chest: [-12, 0, 0], head: [-16, 0, 0] }, add: { shoulderL: [-30, 0, 38], shoulderR: [-30, 0, -38], elbowL: [45, 0, 0], elbowR: [45, 0, 0] } }), 'snap'],
    [0.26, R(st, { root: { fwd: -0.1, up: -0.03 }, world: { spine: [-8, 0, 0], chest: [-6, 0, 0], head: [-8, 0, 0] }, add: { shoulderL: [-14, 0, 26], shoulderR: [-14, 0, -26], elbowL: [32, 0, 0], elbowR: [32, 0, 0] }, footL: { p: [0, 0, -0.12] } }), 'out'],
    [0.56, R(st, { root: { up: -0.06 }, world: { spine: [9, 0, 0], chest: [4, 0, 0], head: [-4, 0, 0] }, add: { shoulderL: [16, 0, 10], shoulderR: [16, 0, -10], elbowL: [28, 0, 0], elbowR: [28, 0, 0] }, footL: { p: [0, 0, -0.05] } })],
    [0.8, 'stance:' + st],
  ], { look: 0.4 });
}

function parried(st) {
  return T(0.7, [
    [0, 'stance:' + st],
    [0.06, R(st, { root: { fwd: -0.06, yaw: 16 }, world: { spine: [-6, 10, 0], chest: [-8, 14, 0], head: [-10, -12, 0] }, add: { shoulderR: [32, 0, -40], elbowR: [55, 0, 0], shoulderL: [-12, 0, 22], elbowL: [20, 0, 0] } }), 'snap'],
    [0.3, R(st, { root: { fwd: -0.1, yaw: 10, up: -0.04 }, world: { spine: [-3, 7, 0], chest: [-4, 10, 0], head: [-5, -8, 0] }, add: { shoulderR: [20, 0, -26], elbowR: [34, 0, 0], shoulderL: [-6, 0, 10] }, footL: { p: [0.0, 0, -0.1] } }), 'out'],
    [0.5, R(st, { root: { up: -0.05 }, world: { spine: [6, 0, 0] }, add: { shoulderR: [8, 0, -8], elbowR: [12, 0, 0] } })],
    [0.7, 'stance:' + st],
  ], { look: 0.4 });
}

// ------------------------------------------------------------------------------------------------ defence

function parry(st) {
  const b = isBack(st);
  return T(0.3, [
    [0, 'stance:' + st],
    [0.05, S(st, { handR: { p: [0.09, 0.08, 0.02] }, handL: { p: [0, 0.04, 0.02] }, world: { chest: [0, b ? 6 : 8, 0] } }), 'out'],
    [0.11, S(st, { root: { fwd: 0.02 }, handR: { p: [-0.17, 0.1, 0.07], wrist: [-10, 0, -35] }, handL: { p: [0.02, 0.02, 0.0] }, world: { chest: [0, b ? -10 : -12, 0] } }), 'snap'],
    [0.18, S(st, { handR: { p: [-0.14, 0.07, 0.05], wrist: [-10, 0, -25] }, world: { chest: [0, -8, 0] } }), 'out'],
    [0.3, 'stance:' + st],
  ], { look: 1 });
}

function absorb(st) {
  const brace = (k) => withSpec(addSpec(STANCE_SPEC[st], { root: { up: -0.06 * k }, world: { spine: [6 * k, 0, 0], chest: [5 * k, 0, 0], head: [4 * k, 0, 0] } }), {
    handR: { p: [0.05, 1.38 - 0.06 * k + 0.06, 0.27], wrist: [-20, 0, 20], pole: [-0.9, -0.8, -0.2] },
    handL: { p: [-0.06, 1.42 - 0.06 * k + 0.06, 0.25], wrist: [-20, 0, -20], pole: [0.9, -0.8, -0.2] },
  });
  return T(0.5, [
    [0, 'stance:' + st],
    [0.06, P(brace(1)), 'snap'],
    [0.4, P(brace(0.8)), 'linear'],
    [0.5, 'stance:' + st],
  ], { look: 0.9 });
}

function avoidDuck(st) {
  const duck = (k) => addSpec(STANCE_SPEC[st], {
    root: { up: -0.34 * k, fwd: 0.03 * k }, world: { hips: [16 * k, 0, 0], spine: [10 * k, 0, 0], neck: [-8 * k, 0, 0], head: [-14 * k, 0, 0] },
    handR: { p: [0, -0.28 * k, 0.02] }, handL: { p: [0, -0.3 * k, 0.02] },
  });
  return T(0.4, [
    [0, 'stance:' + st],
    [0.08, P(duck(1)), 'snap'],
    [0.25, P(duck(0.9)), 'linear'],
    [0.4, 'stance:' + st],
  ], { look: 1 });
}

/** dir: +1 = left (+X), -1 = right. */
function avoidSide(st, dir) {
  const slip = (k) => addSpec(STANCE_SPEC[st], {
    root: { right: -dir * 0.22 * k, up: -0.07 * k }, world: { spine: [3 * k, 0, -dir * 9 * k], chest: [0, 0, -dir * 6 * k], head: [0, 0, dir * 8 * k] },
    footL: { p: [dir * (dir > 0 ? 0.2 : 0.08) * k, 0, 0] }, footR: { p: [dir * (dir > 0 ? 0.08 : 0.2) * k, 0, 0] },
    handR: { p: [-dir * 0.2 * k, -0.06 * k, 0] }, handL: { p: [-dir * 0.2 * k, -0.06 * k, 0] },
  });
  return T(0.35, [
    [0, 'stance:' + st],
    [0.07, P(slip(1)), 'snap'],
    [0.21, P(slip(0.9)), 'linear'],
    [0.35, 'stance:' + st],
  ], { look: 1 });
}

function avoidJump(st) {
  const s = STANCE_SPEC[st];
  const tuck = (up, lift, pull) => addSpec(s, {
    root: { up }, world: { spine: [6, 0, 0] },
    footL: { p: [0, lift, -s.footL.p[2] * pull], pitch: lift > 0 ? 25 : 0 }, footR: { p: [0, lift * 0.85, -s.footR.p[2] * pull], pitch: lift > 0 ? 20 : 0 },
    handR: { p: [0, up * 0.7, 0] }, handL: { p: [0, up * 0.7, 0] },
  });
  return T(0.45, [
    [0, 'stance:' + st],
    [0.06, P(tuck(-0.09, 0, 0)), 'out'],
    [0.17, P(tuck(0.2, 0.34, 0.35)), 'out'],
    [0.27, P(tuck(0.17, 0.26, 0.3)), 'linear'],
    [0.36, P(tuck(-0.1, 0, 0)), 'in'],
    [0.45, 'stance:' + st],
  ], { look: 0.8 });
}

/** Dodge step (Combat moves the fighter ~2.2 m; the clip leads the body and returns its root offset to 0). */
function dodge(st, dx, dz) {
  const s = STANCE_SPEC[st];
  // the foot nearer the travel direction leads
  const dot = (f) => s[f].p[0] * dx + s[f].p[2] * dz;
  const lead = dot('footL') > dot('footR') ? 'footL' : 'footR', trail = lead === 'footL' ? 'footR' : 'footL';
  const lean = { spine: [dz * 10, 0, -dx * 12], chest: [dz * 4, 0, -dx * 5] };
  const k = (up, off, leadD, leadLift, trailD, trailLift, trailPitch) => addSpec(s, {
    root: { up, fwd: dz * off, right: -dx * off }, world: lean,
    [lead]: { p: [dx * leadD, leadLift, dz * leadD], pitch: leadLift > 0 ? 12 : 0 },
    [trail]: { p: [dx * trailD, trailLift, dz * trailD], pitch: trailPitch },
    handR: { p: [dx * 0.05, up * 0.8, dz * 0.05] }, handL: { p: [dx * 0.05, up * 0.8, dz * 0.05] },
  });
  return T(0.35, [
    [0, 'stance:' + st],
    [0.05, P(k(-0.07, 0.02, 0.06, 0.05, -0.04, 0, 10)), 'out'],
    [0.13, P(k(-0.14, 0.07, 0.24, 0.03, -0.14, 0.02, 28)), 'snap'],
    [0.23, P(k(-0.1, 0.04, 0.2, 0, 0.0, 0.06, 15)), 'linear'],
    [0.35, 'stance:' + st],
  ], { look: 0.9 });
}

// ------------------------------------------------------------------------------------------------ down / dead

/** End pose lying on the back (front stances) or on the face (back stances). */
function lyingPose(st, settle = 0) {
  const yaw = isBack(st) ? (st === 'BR' ? 170 : -170) : (st === 'FR' ? 12 : -12);
  if (!isBack(st)) {
    return P({
      root: { up: -0.835 + settle * 0.01, fwd: -0.55, yaw },
      hips: [-88, 0, 0], spine: [-3, 0, 0], chest: [-2, 0, 0], neck: [12, 0, 0], head: [10 - settle * 5, 22, 0],
      thighL: [-14, 4, 12], kneeL: [28, 0, 0], ankleL: [25, 0, 0],
      thighR: [-30, -6, -8], kneeR: [52, 0, 0], ankleR: [18, 0, 0],
      shoulderL: [-14, 0, 64], elbowL: [-22, 0, 0], wristL: [0, 0, 10],
      shoulderR: [-30, 0, -50], elbowR: [-40, 0, 0], wristR: [0, 0, -10],
    });
  }
  return P({
    root: { up: -0.85 + settle * 0.01, fwd: -0.6, yaw },
    hips: [86, 0, 0], spine: [2, 0, 0], chest: [2, 0, 0], neck: [-24, 30, 0], head: [-14, 34, 0],
    thighL: [4, 0, 10], kneeL: [20, 0, 0], ankleL: [60, 0, 0],
    thighR: [-2, 0, -6], kneeR: [12, 0, 0], ankleR: [60, 0, 0],
    shoulderL: [-150, 0, 18], elbowL: [-30, 0, 0],
    shoulderR: [8, 0, -14], elbowR: [-10, 0, 0],
  });
}

function knockdown(st) {
  const back = isBack(st);
  const yaw0 = STANCE_SPEC[st].root.yaw;
  const lie = lyingPose(st);
  const air = back ? P({
    root: { up: -0.32, fwd: -0.35, yaw: (yaw0 + lyingPose._yaw(st)) / 2 },
    hips: [42, 0, 0], spine: [10, 0, 0], chest: [8, 0, 0], neck: [-14, 0, 0], head: [-16, 0, 0],
    thighL: [24, 0, 6], kneeL: [40, 0, 0], thighR: [10, 0, -6], kneeR: [30, 0, 0], ankleL: [30, 0, 0], ankleR: [30, 0, 0],
    shoulderL: [-100, 0, 22], elbowL: [-30, 0, 0], shoulderR: [-90, 0, -24], elbowR: [-35, 0, 0],
  }) : P({
    root: { up: -0.36, fwd: -0.32, yaw: yaw0 * 0.5 },
    hips: [-52, 0, 0], spine: [-6, 0, 0], chest: [-4, 0, 0], neck: [14, 0, 0], head: [16, 0, 0],
    thighL: [-62, 0, 8], kneeL: [44, 0, 0], thighR: [-44, 0, -8], kneeR: [32, 0, 0], ankleL: [10, 0, 0], ankleR: [10, 0, 0],
    shoulderL: [-70, 0, 62], elbowL: [-30, 0, 0], shoulderR: [-60, 0, -66], elbowR: [-24, 0, 0],
  });
  const hit = R(st, back
    ? { root: { fwd: -0.14, up: 0.01 }, world: { spine: [16, 0, 0], chest: [8, 0, 0], head: [12, 0, 0] }, add: { shoulderL: [-30, 0, 20], shoulderR: [-30, 0, -20] } }
    : { root: { fwd: -0.15, up: 0.02 }, world: { spine: [-15, 0, 0], chest: [-12, 0, 0], head: [-18, 0, 0] }, add: { shoulderL: [-40, 0, 40], shoulderR: [-40, 0, -40], elbowL: [40, 0, 0], elbowR: [40, 0, 0] } });
  const bounce = withSpec(lie, { root: { ...lie.root, up: lie.root.up + 0.045 } });
  return T(1.0, [
    [0, 'stance:' + st],
    [0.08, hit, 'snap'],
    [0.32, air, 'in'],
    [0.5, lie, 'in'],
    [0.6, bounce, 'out'],
    [0.74, lie, 'in'],
    [1.0, lyingPose(st, 1), 'inOut'],
  ], { hold: true, look: 0 });
}
lyingPose._yaw = (st) => (isBack(st) ? (st === 'BR' ? 170 : -170) : (st === 'FR' ? 12 : -12));

/** Rise to stance `st` from lying on the back (prone = false) or on the face (prone = true). */
function getup(st, prone = isBack(st)) {
  const back = prone;
  const s = STANCE_SPEC[st];
  const lieSt = prone ? (st[1] === 'R' ? 'BR' : 'BL') : (st[1] === 'R' ? 'FR' : 'FL');
  const lie = lyingPose(lieSt, 1);
  const yaw0 = lyingPose._yaw(lieSt), yaw1 = s.root.yaw;
  let k1, k2;
  if (!back) {
    // sit up, knees up, hand pushing off the floor -> one knee -> stance
    k1 = P({
      root: { up: -0.66, fwd: -0.38, yaw: yaw0 }, hips: [-26, 0, 0], spine: [18, 0, 0], chest: [12, 0, 0], neck: [6, 0, 0], head: [6, 0, 0],
      footL: { p: [0.17, A, 0.02], yaw: 20 }, footR: { p: [-0.15, A, 0.08], yaw: -10 },
      shoulderR: [38, 0, -30], elbowR: [-8, 0, 0], wristR: [50, 0, 0],
      shoulderL: [-50, 0, 16], elbowL: [-70, 0, 0],
    });
    k2 = P({
      root: { up: -0.4, fwd: -0.14, yaw: (yaw0 + yaw1) / 2 }, hips: [14, 0, 0], spine: [16, 0, 0], chest: [8, 0, 0], neck: [-8, 0, 0], head: [-12, 0, 0],
      footR: { p: [-0.1, A, 0.18], yaw: 10 }, footL: { p: [0.16, 0.13, -0.36], yaw: 30, pitch: -10 },
      handR: { p: [-0.12, 1.0, 0.3] }, handL: { p: [0.1, 1.05, 0.22] },
    });
  } else {
    // push up from the floor -> kneel -> stance
    k1 = P({
      root: { up: -0.62, fwd: -0.42, yaw: yaw0 }, hips: [64, 0, 0], spine: [10, 0, 0], chest: [6, 0, 0], neck: [-26, 20, 0], head: [-22, 20, 0],
      thighL: [-60, 0, 8], kneeL: [118, 0, 0], ankleL: [50, 0, 0], thighR: [-48, 0, -8], kneeR: [106, 0, 0], ankleR: [50, 0, 0],
      shoulderL: [-72, 0, 12], elbowL: [-8, 0, 0], wristL: [60, 0, 0], shoulderR: [-70, 0, -12], elbowR: [-10, 0, 0], wristR: [60, 0, 0],
    });
    k2 = P({
      root: { up: -0.4, fwd: -0.2, yaw: (yaw0 + yaw1) / 2 }, hips: [16, 0, 0], spine: [12, 0, 0], chest: [8, 0, 0], neck: [-10, -30, 0], head: [-8, -30, 0],
      footR: { p: [-0.08, A, 0.16], yaw: yaw1 - 30 }, footL: { p: [0.14, 0.13, -0.34], yaw: yaw1, pitch: -10 },
      handR: { p: [0.0, 1.0, 0.25] }, handL: { p: [0.14, 0.98, 0.1] },
    });
  }
  const k3 = P(addSpec(s, { root: { up: -0.08 }, world: { spine: [6, 0, 0] } }));
  return T(0.8, [
    [0, lie],
    [0.22, k1, 'inOut'],
    [0.46, k2, 'inOut'],
    [0.66, k3, 'inOut'],
    [0.8, 'stance:' + st, 'out'],
  ], { look: 0.2, anchor: true });
}

function death(st) {
  const yaw0 = STANCE_SPEC[st].root.yaw;
  const jolt = R(st, { root: { fwd: -0.1 }, world: { spine: [-12, 0, 0], chest: [-8, 0, 0], head: [-22, 0, 0] }, add: { shoulderL: [-20, 0, 20], shoulderR: [-20, 0, -20], elbowL: [30, 0, 0], elbowR: [30, 0, 0] } });
  const kneel = P({
    root: { up: -0.5, fwd: -0.12, yaw: yaw0 }, hips: [6, 0, 0], spine: [16, 0, 4], chest: [12, 0, 2], neck: [16, 0, 0], head: [22, 0, 6],
    footL: { p: [0.14, 0.12, -0.38], yaw: yaw0, pitch: -40 }, footR: { p: [-0.14, 0.12, -0.34], yaw: yaw0, pitch: -40 },
    shoulderL: [12, 0, 6], elbowL: [-14, 0, 0], shoulderR: [8, 0, -8], elbowR: [-18, 0, 0],
  });
  const topple = P({
    root: { up: -0.68, fwd: 0.05, yaw: yaw0 + 10 }, hips: [48, 0, 14], spine: [12, 0, 6], chest: [8, 0, 0], neck: [10, 0, 0], head: [10, 20, 0],
    thighL: [-70, 0, 8], kneeL: [110, 0, 0], thighR: [-60, 0, -8], kneeR: [100, 0, 0], ankleL: [40, 0, 0], ankleR: [40, 0, 0],
    shoulderL: [-30, 0, 20], elbowL: [-20, 0, 0], shoulderR: [-20, 0, -14], elbowR: [-14, 0, 0],
  });
  const down = P({
    root: { up: -0.85, fwd: 0.25, yaw: yaw0 + 18 },
    hips: [86, 0, 4], spine: [2, 0, 0], chest: [2, 0, 0], neck: [-22, 34, 0], head: [-14, 36, 0],
    thighL: [10, 0, 10], kneeL: [24, 0, 0], ankleL: [60, 0, 0], thighR: [2, 0, -8], kneeR: [14, 0, 0], ankleR: [60, 0, 0],
    shoulderL: [10, 0, 16], elbowL: [-14, 0, 0], shoulderR: [14, 0, -12], elbowR: [-10, 0, 0],
  });
  const settle = withSpec(down, { root: { ...down.root, up: down.root.up + 0.03 } });
  return T(1.4, [
    [0, 'stance:' + st],
    [0.12, jolt, 'snap'],
    [0.5, kneel, 'inOut'],
    [0.86, topple, 'in'],
    [1.04, down, 'in'],
    [1.14, settle, 'out'],
    [1.4, down, 'inOut'],
  ], { hold: true, look: 0 });
}

// ------------------------------------------------------------------------------------------------ stance switches

function stanceSwitch(from, to) {
  const a = STANCE_SPEC[from], b = STANCE_SPEC[to];
  const mid = lerpSpec(a, b, 0.5);
  // the foot that travels most takes a small step
  const dist = (f) => Math.hypot(a[f].p[0] - b[f].p[0], a[f].p[2] - b[f].p[2]);
  const mover = dist('footL') > dist('footR') ? 'footL' : 'footR';
  mid[mover].p[1] += 0.055 + Math.min(0.03, dist(mover) * 0.05);
  mid[mover].pitch = (mid[mover].pitch || 0) + 12;
  mid.root.up -= 0.02;
  return T(0.18, [
    [0, 'stance:' + from],
    [0.085, P(mid), 'out'],
    [0.18, 'stance:' + to, 'inOut'],
  ], { look: 1, exitFade: 0.05 });
}

// ------------------------------------------------------------------------------------------------ focus / character

function focusReady(st) {
  const k = addSpec(STANCE_SPEC[st], { root: { up: -0.06 }, world: { chest: [-4, 0, 0], head: [3, 0, 0] }, handR: { p: [0, -0.06, 0.1], wrist: [20, 0, 0] }, handL: { p: [0, 0.02, 0.04] } });
  return T(0.6, [
    [0, 'stance:' + st],
    [0.14, P(k), 'snap'],
    [0.46, P(addSpec(k, { root: { up: -0.01 } })), 'linear'],
    [0.6, 'stance:' + st],
  ], { look: 1 });
}

function taunt(st) {
  const s = STANCE_SPEC[st];
  const beckon = (curl) => withSpec(addSpec(s, { root: { up: 0.02 }, world: { chest: [-4, 0, 0], head: [0, 0, 7] } }), {
    handR: { p: [-0.06, 1.3, 0.48], wrist: [-30 - curl * 50, 80, 0], pole: [-1, -0.6, 0] },
  });
  return T(1.3, [
    [0, 'stance:' + st],
    [0.22, P(beckon(0)), 'out'],
    [0.42, P(beckon(1)), 'inOut'],
    [0.6, P(beckon(0)), 'inOut'],
    [0.8, P(beckon(1)), 'inOut'],
    [1.0, P(beckon(0.2)), 'inOut'],
    [1.3, 'stance:' + st],
  ], { look: 1 });
}

const NEUTRAL_IK = (d) => addSpec(withSpec(NEUTRAL_SPEC, {}), d || {});

function victory(st) {
  const salute = (bow) => withSpec(NEUTRAL_IK({ world: { spine: [bow * 12, 0, 0], chest: [bow * 6, 0, 0], head: [bow * 6, 0, 0] } }), {
    handR: { p: [0.0, 1.27 - bow * 0.06, 0.24 + bow * 0.04], wrist: [-10, 0, 0], pole: [-0.9, -1, -0.2] },
    handL: { p: [0.025, 1.29 - bow * 0.06, 0.27 + bow * 0.04], wrist: [0, -50, 10], pole: [0.9, -1, -0.2] },
  });
  return T(1.6, [
    [0, 'stance:' + st],
    [0.35, P(salute(0)), 'inOut'],
    [0.8, P(salute(1)), 'inOut'],
    [1.25, P(salute(0)), 'inOut'],
    [1.6, P(salute(0)), 'linear'],
  ], { hold: true, look: 0.8 });
}

const NO_ARMS = (sp) => { for (const j of ['shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR']) delete sp[j]; return sp; };

function introTadao(st) {
  const glasses = (k) => NO_ARMS(withSpec(NEUTRAL_IK({ world: { head: [-3 * k, 0, 0] } }), {
    handR: { p: [-0.015, 1.6, 0.2], wrist: [-60, 0, 0], pole: [-1, -0.7, 0] }, handL: { p: [0.14, 1.0, 0.12], wrist: [0, 0, 0] },
  }));
  const bow = NO_ARMS(NEUTRAL_IK({ world: { spine: [14, 0, 0], chest: [6, 0, 0], head: [6, 0, 0] }, handR: { p: [-0.15, 0.92, 0.1] }, handL: { p: [0.15, 0.92, 0.1] } }));
  return T(1.8, [
    [0, 'neutral'],
    [0.4, P(glasses(0)), 'inOut'],
    [0.75, P(glasses(1)), 'inOut'],
    [1.15, P(bow), 'inOut'],
    [1.5, P(addSpec(STANCE_SPEC[st], { root: { up: 0.03 } })), 'inOut'],
    [1.8, 'stance:' + st, 'out'],
  ], { look: 0.6 });
}

function introShu(st) {
  const hips = (roll) => NO_ARMS(withSpec(NEUTRAL_IK({ world: { chest: [0, 0, roll], head: [0, 0, -roll * 1.4] } }), {
    handR: { p: [-0.2, 1.0, 0.04], wrist: [0, 0, 40], pole: [-1, 0, -0.6] }, handL: { p: [0.2, 1.0, 0.04], wrist: [0, 0, -40], pole: [1, 0, -0.6] },
  }));
  return T(1.8, [
    [0, 'neutral'],
    [0.35, P(hips(0)), 'inOut'],
    [0.75, P(hips(-8)), 'inOut'],
    [1.1, P(hips(6)), 'inOut'],
    [1.45, P(addSpec(STANCE_SPEC[st], { root: { up: 0.03 } })), 'inOut'],
    [1.8, 'stance:' + st, 'out'],
  ], { look: 0.8 });
}

function introBrick(st) {
  const flex = (k) => NO_ARMS(withSpec(NEUTRAL_IK({ root: { up: -0.04 * k }, world: { chest: [-6 * k, 0, 0], head: [-6 * k, 0, 0] }, footL: { p: [0.07, 0, 0] }, footR: { p: [-0.07, 0, 0] } }), {
    handL: { p: [0.42, 1.66 + 0.05 * k, 0.03], wrist: [-30 * k, 0, 0], pole: [1, -0.7, -0.3] },
    handR: { p: [-0.42, 1.66 + 0.05 * k, 0.03], wrist: [-30 * k, 0, 0], pole: [-1, -0.7, -0.3] },
  }));
  return T(1.9, [
    [0, 'neutral'],
    [0.4, P(flex(0)), 'out'],
    [0.62, P(flex(1)), 'snap'],
    [1.1, P(flex(0.85)), 'linear'],
    [1.5, P(addSpec(STANCE_SPEC[st], { root: { up: 0.03 } })), 'inOut'],
    [1.9, 'stance:' + st, 'out'],
  ], { look: 0.7 });
}

function introGolden(st) {
  const cuff = NO_ARMS(withSpec(NEUTRAL_IK({ world: { head: [6, 0, 0] } }), {
    handL: { p: [-0.06, 1.12, 0.22], wrist: [0, 0, 0] }, handR: { p: [-0.1, 1.06, 0.2], wrist: [-20, 0, 0] },
  }));
  const open = (k) => NO_ARMS(NEUTRAL_IK({
    world: { chest: [-5 * k, 0, 0], head: [-4 * k, 0, 0] },
    handL: { p: [0.5 * k + 0.14 * (1 - k), 1.15 + 0.15 * k, 0.15], wrist: [0, -60 * k, 0] }, handR: { p: [-0.5 * k - 0.14 * (1 - k), 1.15 + 0.15 * k, 0.15], wrist: [0, 60 * k, 0] },
  }));
  return T(2.0, [
    [0, 'neutral'],
    [0.4, P(cuff), 'inOut'],
    [0.75, P(cuff), 'linear'],
    [1.15, P(open(1)), 'inOut'],
    [1.55, P(open(0.9)), 'linear'],
    [2.0, 'stance:' + st, 'inOut'],
  ], { look: 0.6 });
}

// ------------------------------------------------------------------------------------------------ registration

/** Build every clip and hand it to `reg(name, track)`. Returns the list of base clip names. */
export function buildClips(reg) {
  const names = [];
  const perStance = (name, fn) => {
    names.push(name);
    for (const st of ['FR', 'BR']) {
      const tr = fn(st);
      tr.name = name;
      reg(`${name}@${st}`, tr);
      const m = mirrorTrack(tr);
      m.name = name;
      reg(`${name}@${MIR[st]}`, m);
      if (st === 'FR') reg(name, tr);
    }
  };
  /** Directional pair: the mirror of 'left' in an R stance is 'right' in the L stance. */
  const pair = (left, right, fn) => {
    names.push(left, right);
    for (const st of ['FR', 'BR']) {
      for (const [nm, other, sgn] of [[left, right, 1], [right, left, -1]]) {
        const tr = fn(st, sgn);
        tr.name = nm;
        reg(`${nm}@${st}`, tr);
        const m = mirrorTrack(tr);
        m.name = other;
        reg(`${other}@${MIR[st]}`, m);
        if (st === 'FR') reg(nm, tr);
      }
    }
  };
  perStance('hit_high', hitHigh);
  perStance('hit_mid', hitMid);
  perStance('hit_low', hitLow);
  perStance('hit_heavy', hitHeavy);
  perStance('block_hit', blockHit);
  perStance('guard_break', guardBreak);
  perStance('parried', parried);
  perStance('parry', parry);
  perStance('absorb', absorb);
  perStance('avoid_duck', avoidDuck);
  perStance('avoid_jump', avoidJump);
  pair('avoid_left', 'avoid_right', (st, s) => avoidSide(st, s));
  pair('dodge_left', 'dodge_right', (st, s) => dodge(st, s, 0));
  perStance('dodge_back', (st) => dodge(st, 0, -1));
  perStance('dodge_forward', (st) => dodge(st, 0, 1));
  perStance('knockdown', knockdown);
  perStance('getup', (st) => getup(st));
  perStance('getup_prone', (st) => getup(st, true));
  perStance('getup_supine', (st) => getup(st, false));
  perStance('death', death);
  perStance('focus_ready', focusReady);
  perStance('taunt', taunt);
  perStance('victory', victory);
  perStance('intro_tadao', introTadao);
  perStance('intro_madame_shu', introShu);
  perStance('intro_brick', introBrick);
  perStance('intro_mr_golden', introGolden);
  for (const a of STANCES) {
    for (const b of STANCES) {
      if (a === b) continue;
      const name = `stance_switch_${a}_${b}`;
      const tr = stanceSwitch(a, b);
      tr.name = name;
      reg(name, tr);
      names.push(name);
    }
  }
  return names;
}

export { cloneSpec };
