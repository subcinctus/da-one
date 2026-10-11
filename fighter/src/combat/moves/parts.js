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
