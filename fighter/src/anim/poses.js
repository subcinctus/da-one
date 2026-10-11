// Stance, guard and neutral poses + in-stance locomotion cycles, authored as IK specs and baked at load time.
// Stance shapes match the move library's reference (combat/moves/stances-ref.js: root yaw FR +25 / BR +145,
// root up -0.07) so every move starts and ends seamlessly on these poses.
import { registerPose, mirrorPose } from './rig.js';
import { poseFromSpec, mirrorSpec, addSpec, cloneSpec, ANKLE_H } from './ik.js';

const A = ANKLE_H;

/** Fighting stance specs. Front: chest to the opponent, lead foot forward. Back: turned away, peeking over the shoulder. */
export const STANCE_SPEC = {};
STANCE_SPEC.FR = {
  root: { yaw: 25, up: -0.095 },
  hips: [3, -3, 0], spine: [5, -5, 0], chest: [6, -6, 1],
  neck: [-4, -5, -1], head: [-6, -6, 0],
  footR: { p: [-0.07, A, 0.29], yaw: 12 },
  footL: { p: [0.19, A, -0.27], yaw: 44, pitch: 6 },
  handR: { p: [-0.03, 1.38, 0.37], wrist: [-8, 0, 0] },
  handL: { p: [0.08, 1.40, 0.16], wrist: [-8, 0, 0] },
};
STANCE_SPEC.BR = {
  root: { yaw: 145, up: -0.105 },
  hips: [3, -3, 0], spine: [5, -6, 0], chest: [8, -11, 2],
  neck: [-4, -56, 2], head: [-7, -64, 4],
  footR: { p: [-0.07, A, 0.24], yaw: 118 },
  footL: { p: [0.21, A, -0.29], yaw: 158, pitch: 6 },
  handR: { p: [0.02, 1.43, 0.25], wrist: [-10, 0, 0] },
  handL: { p: [0.17, 1.31, 0.02], wrist: [-10, 0, 0] },
};
STANCE_SPEC.FL = mirrorSpec(STANCE_SPEC.FR);
STANCE_SPEC.BL = mirrorSpec(STANCE_SPEC.BR);

/** Guard: fists up and tight, chin tucked. Same legs as the stance. */
export const GUARD_SPEC = {};
GUARD_SPEC.FR = addSpec(STANCE_SPEC.FR, {
  chest: [4, 0, 0], head: [5, 0, 0],
  handR: { p: [-0.01, 0.12, -0.06] }, handL: { p: [-0.03, 0.09, 0.03] },
});
GUARD_SPEC.BR = addSpec(STANCE_SPEC.BR, {
  chest: [4, 0, 0], head: [5, 0, 0],
  handR: { p: [0.0, 0.10, -0.03] }, handL: { p: [-0.06, 0.18, 0.06] },
});
GUARD_SPEC.FL = mirrorSpec(GUARD_SPEC.FR);
GUARD_SPEC.BL = mirrorSpec(GUARD_SPEC.BR);

/** Relaxed standing (out of combat). */
export const NEUTRAL_SPEC = {
  root: { up: -0.005 },
  hips: [0, 0, 0], spine: [-1, 0, 0], chest: [-1, 0, 0], neck: [2, 0, 0], head: [0, 0, 0],
  footL: { p: [0.115, A, 0.0], yaw: 9 },
  footR: { p: [-0.115, A, 0.02], yaw: -9 },
  shoulderL: [4, 0, 7], elbowL: [-14, 0, 0], wristL: [-6, 0, 4],
  shoulderR: [4, 0, -7], elbowR: [-14, 0, 0], wristR: [-6, 0, -4],
};

export const STANCES = ['FR', 'FL', 'BR', 'BL'];
export const POSES = {}; // baked: 'stance:FR', 'guard:FR', 'crouch:FR', 'neutral'

/** Register stance / guard / crouch / neutral poses (L stances are exact mirrors of the R ones). */
export function registerBasePoses() {
  for (const st of ['FR', 'BR']) {
    const m = st === 'FR' ? 'FL' : 'BL';
    const s = poseFromSpec(STANCE_SPEC[st]);
    const g = poseFromSpec(GUARD_SPEC[st]);
    const c = poseFromSpec(addSpec(STANCE_SPEC[st], { root: { up: -0.13 }, spine: [6, 0, 0], head: [-5, 0, 0] }));
    POSES['stance:' + st] = s; POSES['stance:' + m] = mirrorPose(s);
    POSES['guard:' + st] = g; POSES['guard:' + m] = mirrorPose(g);
    POSES['crouch:' + st] = c; POSES['crouch:' + m] = mirrorPose(c);
  }
  POSES.neutral = poseFromSpec(NEUTRAL_SPEC);
  for (const k of Object.keys(POSES)) registerPose(k, POSES[k]);
  return POSES;
}

// ------------------------------------------------------------------------------------------------ locomotion

/** Walk cycles: distance covered per cycle (both feet step once), swing fraction, keys per cycle. */
export const WALK = { stride: 1.05, swing: 0.42, keys: 8, lift: 0.075 };
export const RUN = { stride: 2.5, swing: 0.62, keys: 8, lift: 0.2 };
/** Direction unit vectors in the fighter frame [x (+left), z (+forward)]. */
export const DIRS = { F: [0, 1], B: [0, -1], L: [1, 0], R: [-1, 0] };

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * One in-stance walk cycle (looped, duration 1 = one cycle, linear keys). The right foot swings during
 * [0, swing), the left during [0.5, 0.5 + swing) in EVERY direction so cycles can be blended at the same phase.
 * Planted feet slide back at exactly the travel speed when playback rate = speed / WALK.stride.
 */
function walkCycle(st, dir) {
  const base = STANCE_SPEC[st];
  const [dx, dz] = DIRS[dir];
  const sw = WALK.swing, H = WALK.stride * (1 - sw) / 2;
  const keys = [];
  for (let i = 0; i < WALK.keys; i++) {
    const ph = i / WALK.keys;
    const s = cloneSpec(base);
    for (const f of ['footR', 'footL']) {
      const u = (ph - (f === 'footR' ? 0 : 0.5) + 1) % 1;
      let off, lift = 0, pitch = s[f].pitch || 0;
      if (u < sw) { const k = u / sw; off = -H + 2 * H * smooth(k); lift = Math.sin(Math.PI * k) * WALK.lift; pitch += Math.sin(Math.PI * k) * 10; }
      else off = H - 2 * H * ((u - sw) / (1 - sw));
      const p = s[f].p;
      s[f].p = [p[0] + dx * off, p[1] + lift, p[2] + dz * off];
      s[f].pitch = pitch;
    }
    const bob = 0.014 * Math.cos(4 * Math.PI * (ph - 0.21));
    s.root.up += bob - 0.01;
    for (const h of ['handR', 'handL']) s[h].p = [s[h].p[0], s[h].p[1] + bob * 0.8, s[h].p[2]];
    // lean into the travel (fighter space, so it reads the same in back stances)
    s.world = { spine: [dz * 3, 0, -dx * 3] };
    keys.push({ t: ph, pose: poseFromSpec(s), ease: 'linear' });
  }
  return { duration: 1, loop: true, keys, name: `walk_${st}_${dir}` };
}

/** Unlocked sprint: upright, arms pumping. Right foot swings during [0, swing). */
function runCycle() {
  const sw = RUN.swing, H = RUN.stride * (1 - sw) / 2;
  const keys = [];
  for (let i = 0; i < RUN.keys; i++) {
    const ph = i / RUN.keys;
    const s = {
      root: { up: -0.04 + 0.035 * Math.cos(4 * Math.PI * (ph - 0.31)), yaw: 0 },
      hips: [8, 6 * Math.cos(2 * Math.PI * ph), 0], spine: [5, -3 * Math.cos(2 * Math.PI * ph), 0], chest: [4, -5 * Math.cos(2 * Math.PI * ph), 0],
      neck: [-6, 0, 0], head: [-7, 0, 0],
    };
    for (const f of ['footR', 'footL']) {
      const side = f === 'footR' ? -1 : 1;
      const u = (ph - (f === 'footR' ? 0 : 0.5) + 1) % 1;
      let off, lift = 0, pitch = 0;
      if (u < sw) {
        const k = u / sw;
        off = -H + 2 * H * smooth(k);
        lift = Math.sin(Math.PI * Math.pow(k, 0.8)) * RUN.lift;
        pitch = 35 * Math.sin(Math.PI * k * 0.9) - 10 * k;
      } else { off = H - 2 * H * ((u - sw) / (1 - sw)); pitch = 0; }
      s[f] = { p: [side * 0.09, A + lift, off + 0.06], yaw: side * -4, pitch };
    }
    // arms opposite to legs: right arm forward while the left leg swings forward
    const sR = Math.sin(2 * Math.PI * (ph + 0.25));
    s.shoulderR = [40 * sR - 8, 0, -10]; s.elbowR = [-88 + 12 * sR, 0, 0]; s.wristR = [-10, 0, 0];
    s.shoulderL = [-40 * sR - 8, 0, 10]; s.elbowL = [-88 - 12 * sR, 0, 0]; s.wristL = [-10, 0, 0];
    keys.push({ t: ph, pose: poseFromSpec(s), ease: 'linear' });
  }
  return { duration: 1, loop: true, keys, name: 'run' };
}

/** Build all locomotion cycles: { walk: { FR: { F, B, L, R }, ... }, run }. L stances mirror R stances. */
export function buildLocomotion() {
  const walk = {};
  for (const st of ['FR', 'BR']) {
    walk[st] = {};
    for (const d of Object.keys(DIRS)) walk[st][d] = walkCycle(st, d);
  }
  // mirror: walking LEFT in FL is the mirror of walking RIGHT in FR. Mirroring also swaps which foot swings first,
  // so shift the mirrored cycle by half a phase to keep "right foot swings in [0, swing)" for every cycle.
  const mir = (track) => {
    const n = track.keys.length;
    const keys = track.keys.map((k, i) => ({ t: k.t, ease: 'linear', pose: mirrorPose(track.keys[(i + n / 2) % n].pose) }));
    return { duration: 1, loop: true, keys };
  };
  walk.FL = { F: mir(walk.FR.F), B: mir(walk.FR.B), L: mir(walk.FR.R), R: mir(walk.FR.L) };
  walk.BL = { F: mir(walk.BR.F), B: mir(walk.BR.B), L: mir(walk.BR.R), R: mir(walk.BR.L) };
  return { walk, run: runCycle() };
}
