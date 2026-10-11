// Reference fighting stances the move keys are authored against (FIGHTER.md §4, data/stances.js).
// The ANIM agent owns the real 'stance:*' poses; these are the shapes every move's wind-up and recovery assume:
//   FR  right foot forward, facing, root yaw +25 (right side bladed forward)
//   FL  mirror of FR, root yaw -25
//   BR  back turned, right shoulder + right foot toward the opponent, root yaw +145, looking over the right shoulder
//   BL  mirror of BR, root yaw -145
// Root yaw is interpolated linearly by the rig, so the sign convention matters: + = turned to the fighter's left.
// Exported so ANIM/debug tools can adopt or compare; registerReferenceStances() only fills names that are missing.
import { bake, spec } from './posekit.js';
import { hasPose, registerPose, mirrorPose } from '../../anim/rig.js';

/** Stance root yaw (degrees) the move library assumes. */
export const STANCE_YAW = { FR: 25, FL: -25, BR: 145, BL: -145 };
export const STANCE_UP = -0.07;

/** Spec of the FR stance (fighter frame: x = own left, z = toward the opponent). */
export const FR_SPEC = {
  root: { yaw: 25, up: STANCE_UP },
  hips: [2, -4, 0], spine: [5, -6, 0], chest: [5, -8, 0],
  footR: { at: [-0.05, 0, 0.27], yaw: 10 },
  footL: { at: [0.17, 0, -0.25], yaw: 40, pitch: 8 },
  handR: { at: [-0.03, 1.4, 0.38], pole: [-0.5, -1, -0.1] },
  handL: { at: [0.07, 1.43, 0.17], pole: [0.6, -1, -0.2] },
};

/** Spec of the BR stance: turned away, right shoulder toward the opponent, peeking over it. */
export const BR_SPEC = {
  root: { yaw: 145, up: STANCE_UP - 0.01 },
  hips: [2, -6, 0], spine: [4, -12, 0], chest: [6, -18, 0],
  footR: { at: [-0.06, 0, 0.21], yaw: 120 },
  footL: { at: [0.2, 0, -0.27], yaw: 160, pitch: 6 },
  handR: { at: [0.02, 1.45, 0.25], pole: [-0.4, -1, 0.3] },
  handL: { at: [0.16, 1.4, 0.02], pole: [0.7, -1, -0.3] },
};

const FR = bake(FR_SPEC);
const BR = bake(BR_SPEC);
/** Baked reference stance poses (rig degrees). */
export const REFERENCE_STANCES = { FR, FL: mirrorPose(FR), BR, BL: mirrorPose(BR) };

/** Fighter-frame specs for each stance (FL/BL are mirrored specs, handy as key bases). */
const mirrorSpec = (s) => {
  const out = {};
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (k === 'root') { out.root = { ...v, yaw: -(v.yaw || 0), right: -(v.right || 0) }; continue; }
    const m = k.endsWith('L') ? k.slice(0, -1) + 'R' : k.endsWith('R') ? k.slice(0, -1) + 'L' : k;
    if (Array.isArray(v)) out[m] = /^(hand|foot)/.test(k) ? [-v[0], v[1], v[2]] : [v[0], -v[1], -v[2]];
    else if (v && typeof v === 'object') {
      const o = { ...v };
      if (o.at) o.at = [-o.at[0], o.at[1], o.at[2]];
      if (o.pole) o.pole = [-o.pole[0], o.pole[1], o.pole[2]];
      if (typeof o.yaw === 'number') o.yaw = -o.yaw;
      out[m] = o;
    } else out[m] = v;
  }
  return out;
};
export { mirrorSpec };
export const STANCE_SPECS = { FR: FR_SPEC, FL: mirrorSpec(FR_SPEC), BR: BR_SPEC, BL: mirrorSpec(BR_SPEC) };
/** Derive a key spec from a stance spec with overrides. */
export const fromStance = (st, ...over) => spec(STANCE_SPECS[st], ...over);

/** Register the reference stances (and guard aliases) ONLY for names nobody registered yet (debug / tests). */
export function registerReferenceStances() {
  let n = 0;
  for (const st of Object.keys(REFERENCE_STANCES)) {
    if (!hasPose('stance:' + st)) { registerPose('stance:' + st, REFERENCE_STANCES[st]); n++; }
    if (!hasPose('guard:' + st)) { registerPose('guard:' + st, REFERENCE_STANCES[st]); n++; }
  }
  return n;
}
