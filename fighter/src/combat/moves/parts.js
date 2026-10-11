// Shared authoring parts for move keys (fighter frame: x = own left, y = up, z = toward the opponent).
import { STANCE_SPECS } from './stances-ref.js';
import { spec, rotY } from './posekit.js';

/** Neutral upright torso (override per key). */
export const N = { hips: [2, 0, 0], spine: [5, 0, 0], chest: [5, 0, 0] };
/** Planted feet of a stance. */
export const feetOf = (st) => ({ footR: STANCE_SPECS[st].footR, footL: STANCE_SPECS[st].footL });
/** Guard hands of a stance. */
export const handsOf = (st) => ({ handR: STANCE_SPECS[st].handR, handL: STANCE_SPECS[st].handL });
/** Torso of a stance. */
export const torsoOf = (st) => ({ hips: STANCE_SPECS[st].hips, spine: STANCE_SPECS[st].spine, chest: STANCE_SPECS[st].chest });

/** Hand guarding the chin (front-facing keys). */
export const chinR = { at: [-0.08, 1.46, 0.16], pole: [-0.7, -1, -0.2] };
export const chinL = { at: [0.08, 1.46, 0.16], pole: [0.7, -1, -0.2] };
/** Palm-heel wrist (fingers up) and pointed / flexed feet. */
export const PALM = [0, 0, 0];
export const WRIST_PALM = [-55, 0, 0];
export const TOES = 40;     // ankle pitch: instep / pointed foot
export const HEEL = -15;    // ankle pitch: flexed foot, heel / sole leading

/** A point given in a yawed body frame (deg) converted to the fighter frame. */
export const by = (yaw, x, y, z) => rotY(yaw, [x, y, z]);

/** Key spec helper: neutral torso + overrides. */
export const K = (...parts) => spec(N, ...parts);

/**
 * TRAILING foot of a stance switch (the foot that ends up on the other side of the body without stepping), planted at
 * fraction `f` of a steady slide + pivot from its `from`-stance spot to its `to`-stance spot. Moves give f = t / (time
 * of the hold key), so the foot slides at a constant rate (the lunge carries the body over it in the world) and stands
 * in the END stance in the frozen chain form. `pitch` is a minimum heel raise while it slides.
 */
export function trailFoot(from, to, side, f, pitch = 0) {
  const a = STANCE_SPECS[from]['foot' + side], b = STANCE_SPECS[to]['foot' + side];
  const k = Math.min(1, Math.max(0, f));
  const L = (x, y) => Math.round((x + (y - x) * k) * 1000) / 1000;
  return { at: [L(a.at[0], b.at[0]), 0, L(a.at[2], b.at[2])], yaw: L(a.yaw || 0, b.yaw || 0), pitch: Math.max(L(a.pitch || 0, b.pitch || 0), pitch) };
}
