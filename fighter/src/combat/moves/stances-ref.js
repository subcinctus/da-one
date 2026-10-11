// Reference fighting stances the move keys are authored against (FIGHTER.md §4, data/stances.js).
// The ANIM agent owns the real 'stance:*' poses; these are the shapes every move's wind-up and recovery assume:
//   FR  right foot forward, facing, root yaw +25 (right side bladed forward)
//   FL  mirror of FR, root yaw -25
//   BR  back turned, right shoulder + right foot toward the opponent, root yaw +145, looking over the right shoulder
//   BL  mirror of BR, root yaw -145
// Root yaw is interpolated linearly by the rig, so the sign convention matters: + = turned to the fighter's left.
// Exported so ANIM/debug tools can adopt or compare; registerReferenceStances() only fills names that are missing.
//
// The root height, torso and planted feet are taken from the registered anim stances (anim/poses.js STANCE_SPEC) so the
// root calibration in index.js is a no-op and in-between keys keep their feet on the floor. Keys were authored against
// the older reference heights (AUTHORED_UP); defineMove shifts each key's root by the difference at BAKE time, so IK
// re-plants the feet instead of the whole body (feet included) sinking at runtime.
import { bake, spec } from './posekit.js';
import { hasPose, registerPose, mirrorPose } from '../../anim/rig.js';
import { STANCE_SPEC as ANIM_STANCE } from '../../anim/poses.js';

/** Stance root yaw (degrees) the move library assumes. */
export const STANCE_YAW = { FR: 25, FL: -25, BR: 145, BL: -145 };
/** Root height of the registered front stance. */
export const STANCE_UP = ANIM_STANCE.FR.root.up;
/** Root heights the move keys were originally authored against (front / back stances). */
export const AUTHORED_UP = { FR: -0.07, FL: -0.07, BR: -0.08, BL: -0.08 };

const plant = (f) => ({ at: [f.p[0], 0, f.p[2]], yaw: f.yaw || 0, ...(f.pitch ? { pitch: f.pitch } : {}) });

/** Spec of the FR stance (fighter frame: x = own left, z = toward the opponent). */
export const FR_SPEC = {
  root: { yaw: 25, up: ANIM_STANCE.FR.root.up },
  hips: ANIM_STANCE.FR.hips.slice(), spine: ANIM_STANCE.FR.spine.slice(), chest: ANIM_STANCE.FR.chest.slice(),
  footR: plant(ANIM_STANCE.FR.footR),
  footL: plant(ANIM_STANCE.FR.footL),
  handR: { at: ANIM_STANCE.FR.handR.p.slice(), pole: [-0.5, -1, -0.1] },
  handL: { at: ANIM_STANCE.FR.handL.p.slice(), pole: [0.6, -1, -0.2] },
};

/** Spec of the BR stance: turned away, right shoulder toward the opponent, peeking over it. */
export const BR_SPEC = {
  root: { yaw: 145, up: ANIM_STANCE.BR.root.up },
  hips: ANIM_STANCE.BR.hips.slice(), spine: ANIM_STANCE.BR.spine.slice(), chest: ANIM_STANCE.BR.chest.slice(),
  footR: plant(ANIM_STANCE.BR.footR),
  footL: plant(ANIM_STANCE.BR.footL),
  handR: { at: ANIM_STANCE.BR.handR.p.slice(), pole: [-0.4, -1, 0.3] },
  handL: { at: ANIM_STANCE.BR.handL.p.slice(), pole: [0.7, -1, -0.3] },
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
