// Front-stance attacks: FR originals, their FL mirrors, and FL originals.
// Stance yaw reference: FR +25 / FL -25 / BR +145 / BL -145. A strike lands close to its END stance's yaw so a chained
// follow-up only has to blend a short way (FIGHTER.md §6b).
import { defineMove, mirrorMove } from './define.js';
import { K, feetOf, handsOf, chinR, chinL, TOES, HEEL } from './parts.js';

// ------------------------------------------------------------------------------------------------ FR originals

const jabHit = K({
  root: { yaw: 38, up: -0.08, fwd: 0.06 }, hips: [2, 4, 0], spine: [5, 4, 0], chest: [5, 10, 0],
  handR: { at: [-0.02, 1.48, 1.05], pole: [-0.8, -1, 0] }, handL: chinL,
  footR: { at: [-0.04, 0, 0.37], yaw: 15 }, footL: { at: [0.17, 0, -0.21], yaw: 45, pitch: 12 },
});
export const fr_snap_jab = defineMove({
  id: 'fr_snap_jab', name: 'Snap Jab', desc: 'A lead hand that asks a polite question and does not wait for the answer.',
  start: 'FR', end: 'FR', weight: 'light', height: 'high', path: 'thrust', limb: 'handR',
  startup: 0.15, active: 0.05, recovery: 0.24, damage: 6, stamina: 7, reach: 1.6, arc: 50,
  hitstun: 0.28, blockstun: 0.13, push: 0.25, lunge: 0.28, chainIn: 0.055, learn: 60,
  keys: [
    ['w0.5', K(feetOf('FR'), { root: { yaw: 21, up: -0.09 }, hips: [2, -6, 0], spine: [6, -6, 0], chest: [6, -8, 0],
      handR: { at: [-0.05, 1.37, 0.3], pole: [-0.6, -1, -0.1] }, handL: chinL,
      footR: { at: [-0.05, 0.04, 0.31], yaw: 10 } })],
    ['hit', jabHit],
    ['hold', jabHit],
    ['r0.35', K(handsOf('FR'), feetOf('FR'), { root: { yaw: 28, up: -0.075, fwd: 0.02 }, handR: { at: [-0.03, 1.43, 0.5], pole: [-0.6, -1, -0.1] } })],
  ],
});

const crossHit = K({
  root: { yaw: -30, up: -0.08, fwd: 0.06 }, hips: [2, -6, 0], spine: [6, -6, 0], chest: [6, -14, 0],
  handL: { at: [0.02, 1.48, 1.05], pole: [0.8, -1, 0] }, handR: chinR,
  footL: { at: [0.06, 0, 0.31], yaw: -10 }, footR: { at: [-0.16, 0, -0.22], yaw: -50, pitch: 18 },
});
export const fr_crossing_straight = defineMove({
  id: 'fr_crossing_straight', name: 'Crossing Straight', desc: 'The rear hand steps through the front door. Shoes optional.',
  start: 'FR', end: 'FL', weight: 'light', height: 'high', path: 'thrust', limb: 'handL',
  startup: 0.19, active: 0.06, recovery: 0.26, damage: 8, stamina: 8, reach: 1.75, arc: 50,
  hitstun: 0.3, blockstun: 0.15, push: 0.35, lunge: 0.5, chainIn: 0.07,
  keys: [
    ['w0.45', K(feetOf('FR'), { root: { yaw: 32, up: -0.1 }, spine: [6, 4, 0], chest: [6, 4, 0],
      handL: { at: [0.1, 1.42, 0.1], pole: [0.8, -1, -0.4] }, handR: { at: [-0.04, 1.42, 0.33] },
      footL: { at: [0.17, 0.02, -0.24], yaw: 45, pitch: 25 } })],
    ['w0.75', K({ root: { yaw: 4, up: -0.06, fwd: 0.03 }, spine: [6, -2, 0], chest: [6, -6, 0],
      handL: { at: [0.06, 1.45, 0.45], pole: [0.8, -1, 0] }, handR: chinR,
      footR: { at: [-0.05, 0, 0.12], yaw: 10, pitch: 10 }, footL: { at: [0.09, 0.14, 0.02] } })],
    ['hit', crossHit],
    ['hold', crossHit],
    ['r0.4', K(handsOf('FL'), feetOf('FL'), { root: { yaw: -28, up: -0.075 }, handL: { at: [0.03, 1.43, 0.52], pole: [0.6, -1, -0.1] } })],
  ],
});

const liverHit = K({
  root: { yaw: -22, up: -0.2, fwd: 0.06 }, hips: [6, -6, 0], spine: [14, -6, -6], chest: [8, -20, 0],
  handL: { at: [-0.06, 1.05, 0.66], pole: [1, 0.15, -0.1] }, handR: { at: [-0.06, 1.34, 0.26], pole: [-0.8, -1, 0] },
  footL: { at: [0.06, 0, 0.28], yaw: -15 }, footR: { at: [-0.18, 0, -0.22], yaw: -55, pitch: 15 },
});
export const fr_liver_hook = defineMove({
  id: 'fr_liver_hook', name: 'Liver Hook', desc: 'Dips under the high line and files a complaint with the liver.',
  start: 'FR', end: 'FL', weight: 'medium', height: 'mid', path: 'horizontal', limb: 'handL',
  startup: 0.26, active: 0.07, recovery: 0.32, damage: 12, stamina: 11, reach: 1.45, arc: 90,
  hitstun: 0.38, blockstun: 0.18, push: 0.45, lunge: 0.35, chainIn: 0.1,
  props: { duck: true },
  keys: [
    ['w0.5', K(feetOf('FR'), { root: { yaw: 30, up: -0.2, fwd: 0.02 }, hips: [6, 4, 0], spine: [14, 6, -8], chest: [8, 6, 0],
      handL: { at: [0.26, 1.08, 0.12], pole: [1, -0.4, -0.5] }, handR: { at: [-0.05, 1.33, 0.27], pole: [-0.8, -1, 0] },
      footL: { at: [0.17, 0.02, -0.22], yaw: 40, pitch: 22 } })],
    ['w0.8', K({ root: { yaw: 8, up: -0.21, fwd: 0.04 }, hips: [6, 0, 0], spine: [14, 0, -8], chest: [8, -6, 0],
      handL: { at: [0.22, 1.05, 0.35], pole: [1, 0, -0.4] }, handR: { at: [-0.05, 1.33, 0.27], pole: [-0.8, -1, 0] },
      footR: { at: [-0.05, 0, 0.1], yaw: 0 }, footL: { at: [0.1, 0.1, 0.08] } })],
    ['hit', liverHit],
    ['hold', liverHit],
    ['r0.4', K(handsOf('FL'), feetOf('FL'), { root: { yaw: -26, up: -0.11 }, spine: [8, -2, 0] })],
  ],
});

const gateHit = K({
  root: { yaw: 92, up: -0.03, fwd: -0.05 }, hips: [0, 0, 0], spine: [0, 0, -24], chest: [0, 0, -12],
  footR: { at: [0.0, 0.98, 1.1], pole: [1, 0.15, 0], ankle: [0, 0, 0] },
  footL: { at: [0.12, 0, -0.2], yaw: 165, pitch: 6 },
  handR: { at: [-0.06, 1.0, 0.62], pole: [0, 1, -0.4] }, handL: { at: [0.1, 1.42, 0.06], pole: [1, -1, -0.5] },
});
export const fr_gate_kick = defineMove({
  id: 'fr_gate_kick', name: 'Gate Kick', desc: 'A side kick that closes the distance like a door. A heavy one.',
  start: 'FR', end: 'BR', weight: 'medium', height: 'mid', path: 'thrust', limb: 'footR',
  startup: 0.29, active: 0.08, recovery: 0.36, damage: 13, stamina: 13, reach: 2.1, arc: 45,
  hitstun: 0.42, blockstun: 0.2, push: 0.9, lunge: 0.35, chainIn: 0.11,
  props: { stop: true },
  keys: [
    ['w0.45', K({ root: { yaw: 62, up: -0.07 }, spine: [4, 0, -4], chest: [4, 0, 0],
      footR: { at: [-0.04, 0.32, 0.22], pole: [0.2, 0.3, 1] }, footL: { at: [0.17, 0, -0.24], yaw: 110, pitch: 6 },
      handR: { at: [-0.03, 1.38, 0.32] }, handL: { at: [0.1, 1.43, 0.08] } })],
    ['w0.8', K({ root: { yaw: 90, up: -0.04, fwd: -0.03 }, hips: [0, 0, 0], spine: [0, 0, -12], chest: [0, 0, -6],
      footR: { at: [0.06, 0.62, 0.12], pole: [0.1, 0.4, 1], ankle: [-10, 0, 0] }, footL: { at: [0.13, 0, -0.21], yaw: 160, pitch: 6 },
      handR: { at: [-0.02, 1.3, 0.25], pole: [0, -1, -0.5] }, handL: { at: [0.1, 1.42, 0.06] } })],
    ['hit', gateHit],
    ['h0.45', gateHit, 'linear'],
    ['hold', K(gateHit, { root: { yaw: 98, up: -0.04, fwd: -0.03 }, spine: [0, 0, -16], chest: [0, 0, -8],
      footR: { at: [0.02, 0.72, 0.42], pole: [1, 0.3, 0.2], ankle: [-10, 0, 0] } }), 'out'],
    ['r0.35', K({ root: { yaw: 120, up: -0.06 }, spine: [2, -6, -8], chest: [4, -10, 0],
      footR: { at: [-0.02, 0.4, 0.42], pole: [0, 0.4, 1] }, footL: { at: [0.17, 0, -0.25], yaw: 160, pitch: 6 },
      handR: { at: [0.0, 1.42, 0.28] }, handL: { at: [0.15, 1.4, 0.04] } })],
  ],
});

const tbfHit = K({
  root: { yaw: -100, up: -0.08, fwd: 0.04, right: 0.04 }, spine: [4, 0, 0], chest: [4, -6, 0],
  handL: { at: [0.02, 1.52, 1.05], pole: [0, 1, -0.4] }, handR: { at: [0.04, 1.44, 0.06], pole: [-1, -1, 0] },
  footL: { at: [0.06, 0, 0.22], yaw: -95 }, footR: { at: [-0.17, 0, -0.2], yaw: -150, pitch: 10 },
});
export const fr_turning_backfist = defineMove({
  id: 'fr_turning_backfist', name: 'Turning Back Fist', desc: 'Steps off the line and lets the back of the hand do the talking.',
  start: 'FR', end: 'BL', weight: 'medium', height: 'high', path: 'horizontal', limb: 'handL',
  startup: 0.24, active: 0.07, recovery: 0.3, damage: 10, stamina: 10, reach: 1.7, arc: 100,
  hitstun: 0.36, blockstun: 0.17, push: 0.45, lunge: 0.4, chainIn: 0.09,
  props: { strafe: true },
  keys: [
    ['w0.4', K(feetOf('FR'), { root: { yaw: 36, up: -0.09 }, spine: [5, 4, 0], chest: [5, 6, 0],
      handL: { at: [-0.12, 1.38, 0.22], pole: [0.1, -0.2, 1] }, handR: { at: [-0.05, 1.42, 0.3] },
      footL: { at: [0.17, 0.05, -0.2], yaw: 40, pitch: 20 } })],
    ['w0.75', K({ root: { yaw: -40, up: -0.08, right: 0.12 }, spine: [5, 4, 0], chest: [5, 10, 0],
      handL: { at: [-0.06, 1.42, 0.24], pole: [0.2, 0, 1] }, handR: { at: [0.02, 1.44, 0.2] },
      footR: { at: [-0.06, 0, 0.18], yaw: -30, pitch: 10 }, footL: { at: [0.1, 0.12, 0.08] } })],
    ['hit', tbfHit],
    ['hold', tbfHit],
    ['r0.4', K(handsOf('BL'), feetOf('BL'), { root: { yaw: -128, up: -0.08 }, spine: [4, 6, 0], chest: [5, 10, 0],
      handL: { at: [0.0, 1.46, 0.45], pole: [0.6, -1, 0] } })],
  ],
});

const axeHit = K({
  root: { yaw: -6, up: -0.03, fwd: 0.04 }, hips: [-6, 0, 0], spine: [-8, 0, 0], chest: [-2, 0, 0],
  footL: { at: [0.06, 1.55, 1.0], pole: [0, 1, -0.4], ankle: [HEEL, 0, 0] },
  footR: { at: [-0.08, 0, 0.0], yaw: 20, pitch: 18 },
  handL: { at: [0.32, 1.12, 0.05], pole: [1, -1, 0] }, handR: { at: [-0.18, 1.28, 0.32], pole: [-1, -1, 0] },
});
const axeChop = K(axeHit, { footL: { at: [0.06, 0.52, 0.72], pole: [0, 0.4, 1], ankle: [0, 0, 0] }, spine: [4, 0, 0], chest: [6, 0, 0], root: { yaw: -14, up: -0.09, fwd: 0.06 },
  handL: { at: [0.2, 1.25, 0.15], pole: [1, -1, 0] }, handR: { at: [-0.12, 1.36, 0.3], pole: [-1, -1, 0] } });
export const fr_falling_axe = defineMove({
  id: 'fr_falling_axe', name: 'Falling Axe', desc: 'The rear heel goes up, considers its options, and comes down on your collarbone.',
  start: 'FR', end: 'FL', weight: 'heavy', height: 'high', path: 'vertical', limb: 'footL',
  startup: 0.42, active: 0.08, recovery: 0.48, damage: 18, stamina: 17, reach: 1.85, arc: 40,
  hitstun: 0.55, blockstun: 0.28, push: 0.8, lunge: 0.45, chainIn: 0.16,
  props: { break: true },
  keys: [
    ['w0.35', K(feetOf('FR'), { root: { yaw: 14, up: -0.1 }, spine: [8, 0, 0],
      handL: { at: [0.18, 1.3, 0.1], pole: [1, -1, -0.3] }, handR: { at: [-0.05, 1.4, 0.32] },
      footL: { at: [0.16, 0.2, -0.18], pole: [0.1, 0, 1], ankle: [10, 0, 0] } })],
    ['w0.72', K({ root: { yaw: 0, up: 0.0 }, hips: [-8, 0, 0], spine: [-10, 0, 0], chest: [-4, 0, 0],
      footL: { at: [0.1, 2.05, 0.45], pole: [0, 0.2, -1], ankle: [HEEL, 0, 0] },
      footR: { at: [-0.08, 0, 0.05], yaw: 20, pitch: 25 },
      handL: { at: [0.38, 1.25, -0.05], pole: [1, -1, 0] }, handR: { at: [-0.3, 1.35, 0.15], pole: [-1, -1, 0] } })],
    ['hit', axeHit],
    ['hold', axeChop],
    ['r0.3', K(handsOf('FL'), { root: { yaw: -22, up: -0.14, fwd: 0.03 }, spine: [10, 0, 0],
      footL: { at: [0.06, 0.0, 0.3], yaw: -10 }, footR: { at: [-0.15, 0, -0.2], yaw: -45, pitch: 20 } })],
  ],
});

const shinHit = K({
  root: { yaw: 52, up: -0.05 }, hips: [0, 22, 0], spine: [4, -10, 10], chest: [4, -14, 0],
  footR: { at: [0.1, 0.32, 0.78], pole: [-0.2, 1, 0.3], ankle: [TOES, 0, 0] },
  footL: { at: [0.15, 0, -0.22], yaw: 85, pitch: 10 },
  handR: { at: [-0.32, 1.18, -0.08], pole: [-1, -0.5, -0.5] }, handL: { at: [0.06, 1.45, 0.24] },
});
export const fr_shin_cutter = defineMove({
  id: 'fr_shin_cutter', name: 'Shin Cutter', desc: 'A lead-leg low kick. Calves remember it longer than heads do.',
  start: 'FR', end: 'FR', weight: 'light', height: 'low', path: 'horizontal', limb: 'footR',
  startup: 0.2, active: 0.06, recovery: 0.26, damage: 7, stamina: 8, reach: 1.7, arc: 80,
  hitstun: 0.3, blockstun: 0.14, push: 0.2, lunge: 0.15, chainIn: 0.075,
  keys: [
    ['w0.5', K(handsOf('FR'), { root: { yaw: 18, up: -0.09, fwd: -0.03 }, hips: [2, -4, 0], spine: [5, -6, 0], chest: [5, -8, 0],
      footR: { at: [-0.24, 0.22, 0.16], pole: [-1, 0.2, 0.6], ankle: [20, 0, 0] }, footL: { at: [0.17, 0, -0.25], yaw: 45, pitch: 8 } })],
    ['hit', shinHit],
    ['hold', K(shinHit, { footR: { at: [0.22, 0.3, 0.68], pole: [-0.2, 1, 0.3], ankle: [TOES, 0, 0] }, root: { yaw: 58, up: -0.05 } })],
    ['r0.45', K(handsOf('FR'), { root: { yaw: 30, up: -0.08 }, hips: [2, 0, 0],
      footR: { at: [-0.08, 0.12, 0.25], pole: [-0.3, 0.2, 1], ankle: [10, 0, 0] }, footL: { at: [0.17, 0, -0.25], yaw: 45, pitch: 8 } })],
  ],
});

const sbfHit = K({
  root: { yaw: 92, up: -0.07, fwd: 0.04 }, spine: [4, 0, 0], chest: [4, 6, 0],
  handR: { at: [-0.02, 1.52, 1.05], pole: [0, 1, -0.4] }, handL: { at: [0.02, 1.44, 0.0], pole: [1, -1, 0] },
  footR: { at: [-0.06, 0, 0.29], yaw: 80 }, footL: { at: [0.18, 0, -0.25], yaw: 140, pitch: 8 },
});
export const fr_snap_backfist = defineMove({
  id: 'fr_snap_backfist', name: 'Snap Back Fist', desc: 'Turns the shoulder away and the knuckles toward you. Very fast, slightly rude.',
  start: 'FR', end: 'BR', weight: 'light', height: 'high', path: 'horizontal', limb: 'handR',
  startup: 0.18, active: 0.06, recovery: 0.26, damage: 7, stamina: 8, reach: 1.65, arc: 90,
  hitstun: 0.3, blockstun: 0.14, push: 0.3, lunge: 0.25, chainIn: 0.07,
  keys: [
    ['w0.5', K(feetOf('FR'), { root: { yaw: 10, up: -0.09 }, spine: [5, -6, 0], chest: [5, -10, 0],
      handR: { at: [0.12, 1.4, 0.22], pole: [-0.2, -0.2, 1] }, handL: chinL })],
    ['hit', sbfHit],
    ['hold', sbfHit],
    ['r0.4', K(handsOf('BR'), feetOf('BR'), { root: { yaw: 126, up: -0.08 }, spine: [4, -8, 0], chest: [5, -12, 0],
      handR: { at: [0.0, 1.46, 0.45], pole: [-0.6, -1, 0] } })],
  ],
});

// ------------------------------------------------------------------------------------------------ FL mirrors

export const fl_snap_jab = mirrorMove(fr_snap_jab, { id: 'fl_snap_jab' });
export const fl_crossing_straight = mirrorMove(fr_crossing_straight, { id: 'fl_crossing_straight' });
export const fl_liver_hook = mirrorMove(fr_liver_hook, { id: 'fl_liver_hook' });
export const fl_gate_kick = mirrorMove(fr_gate_kick, { id: 'fl_gate_kick' });
export const fl_turning_backfist = mirrorMove(fr_turning_backfist, { id: 'fl_turning_backfist' });

// ------------------------------------------------------------------------------------------------ FL originals

const tsJab = K({
  root: { yaw: -38, up: -0.08, fwd: 0.05 }, hips: [2, -4, 0], spine: [5, -4, 0], chest: [5, -10, 0],
  handL: { at: [0.02, 1.48, 1.05], pole: [0.8, -1, 0] }, handR: chinR,
  footL: { at: [0.04, 0, 0.35], yaw: -15 }, footR: { at: [-0.17, 0, -0.21], yaw: -45, pitch: 12 },
});
const tsCross = K({
  root: { yaw: 30, up: -0.08, fwd: 0.07 }, hips: [2, 6, 0], spine: [6, 6, 0], chest: [6, 14, 0],
  handR: { at: [-0.02, 1.48, 1.05], pole: [-0.8, -1, 0] }, handL: chinL,
  footR: { at: [-0.06, 0, 0.31], yaw: 10 }, footL: { at: [0.16, 0, -0.22], yaw: 50, pitch: 18 },
});
export const fl_twin_sparrows = defineMove({
  id: 'fl_twin_sparrows', name: 'Twin Sparrows', desc: 'Jab, then the cross that was hiding behind it.',
  start: 'FL', end: 'FR', weight: 'light', height: 'high', path: 'thrust', limb: 'handR',
  startup: 0.15, active: 0.23, recovery: 0.26, damage: 11, stamina: 10, reach: 1.7, arc: 50,
  hitstun: 0.3, blockstun: 0.15, push: 0.35, lunge: 0.45, chainIn: 0.055,
  props: { double: true },
  hits: [{ t: 0.15, dur: 0.05, limb: 'handL', damage: 5 }, { t: 0.32, dur: 0.06, limb: 'handR', damage: 6 }],
  keys: [
    ['w0.5', K(feetOf('FL'), { root: { yaw: -21, up: -0.09 }, hips: [2, 6, 0], spine: [6, 6, 0], chest: [6, 8, 0],
      handL: { at: [0.05, 1.37, 0.3], pole: [0.6, -1, -0.1] }, handR: chinR })],
    [0.15, tsJab, 'snap'],
    [0.2, tsJab, 'linear'],
    [0.255, K({ root: { yaw: -6, up: -0.08, fwd: 0.06 }, spine: [6, 0, 0], chest: [6, -4, 0],
      handL: { at: [0.05, 1.42, 0.45], pole: [0.6, -1, -0.1] }, handR: { at: [-0.1, 1.42, 0.2], pole: [-0.8, -1, -0.3] },
      footL: { at: [0.05, 0, 0.14], yaw: -5, pitch: 8 }, footR: { at: [-0.09, 0.13, 0.0] } }), 'inOut'],
    [0.32, tsCross, 'snap'],
    [0.38, tsCross, 'linear'],
    ['r0.4', K(handsOf('FR'), feetOf('FR'), { root: { yaw: 27, up: -0.075 }, handR: { at: [-0.03, 1.43, 0.52], pole: [-0.6, -1, -0.1] } }), 'out'],
  ],
});

const wheelHit = K({
  root: { yaw: 90, up: -0.02, fwd: 0.02 }, hips: [0, 18, 0], spine: [-4, 0, -20], chest: [0, -6, -8],
  footR: { at: [0.16, 1.5, 0.92], pole: [-0.1, 1, 0.2], ankle: [TOES, 0, 0] },
  footL: { at: [0.06, 0, 0.27], yaw: 165, pitch: 15 },
  handR: { at: [-0.34, 1.0, -0.12], pole: [-1, 0, -0.5] }, handL: { at: [0.02, 1.48, 0.12], pole: [1, -1, 0] },
});
export const fl_wheel_kick = defineMove({
  id: 'fl_wheel_kick', name: 'Wheel Kick', desc: 'A rear roundhouse that keeps turning after it lands. So do you.',
  start: 'FL', end: 'BR', weight: 'medium', height: 'high', path: 'horizontal', limb: 'footR',
  startup: 0.31, active: 0.08, recovery: 0.36, damage: 14, stamina: 14, reach: 1.95, arc: 110,
  hitstun: 0.44, blockstun: 0.2, push: 0.7, lunge: 0.3, chainIn: 0.12,
  keys: [
    ['w0.4', K(handsOf('FL'), { root: { yaw: -12, up: -0.09 }, hips: [2, 4, 0], spine: [5, 4, 0], chest: [5, 4, 0],
      footL: { at: [0.05, 0, 0.27], yaw: 20 }, footR: { at: [-0.16, 0.05, -0.2], yaw: -30, pitch: 30 } })],
    ['w0.78', K({ root: { yaw: 35, up: -0.05 }, hips: [0, 20, 0], spine: [-2, -6, -12], chest: [0, -8, -4],
      footR: { at: [-0.42, 0.95, 0.12], pole: [0.1, 0.2, 1], ankle: [TOES, 0, 0] }, footL: { at: [0.05, 0, 0.27], yaw: 110, pitch: 12 },
      handR: { at: [-0.25, 1.2, -0.1], pole: [-1, -0.5, -0.5] }, handL: { at: [0.08, 1.46, 0.18] } })],
    ['hit', wheelHit],
    ['h0.45', K(wheelHit, { footR: { at: [0.34, 1.45, 0.8], pole: [-0.1, 1, 0.2], ankle: [TOES, 0, 0] }, root: { yaw: 94, up: -0.02 } }), 'linear'],
    ['hold', K(wheelHit, { root: { yaw: 104, up: -0.05 }, spine: [0, -4, -10], chest: [2, -8, -4],
      footR: { at: [0.12, 0.62, 0.3], pole: [0, 0.6, 1], ankle: [TOES, 0, 0] }, handR: { at: [-0.2, 1.2, 0.0], pole: [-1, -0.5, -0.5] } }), 'out'],
    ['r0.4', K({ root: { yaw: 128, up: -0.08 }, spine: [4, -10, 0], chest: [6, -14, 0],
      footR: { at: [-0.04, 0.28, 0.32], pole: [0, 0.3, 1] }, footL: { at: [0.18, 0, -0.2], yaw: 165, pitch: 8 },
      handR: { at: [0.02, 1.44, 0.26] }, handL: { at: [0.16, 1.4, 0.04] } })],
  ],
});

const elbowHit = K({
  root: { yaw: -125, up: -0.12, fwd: 0.06 }, hips: [2, 0, 0], spine: [4, 0, -4], chest: [6, -8, 0],
  handL: { at: [-0.36, 1.4, 0.14], pole: [0.2, 0, 1] }, handR: { at: [-0.16, 1.46, -0.14], pole: [-1, -1, 0] },
  footL: { at: [0.07, 0, 0.23], yaw: -120 }, footR: { at: [-0.2, 0, -0.26], yaw: -160, pitch: 8 },
});
export const fl_reverse_elbow = defineMove({
  id: 'fl_reverse_elbow', name: 'Reverse Elbow', desc: 'Turns its back on you, which is the point.',
  start: 'FL', end: 'BL', weight: 'light', height: 'high', path: 'thrust', limb: 'elbowL',
  startup: 0.17, active: 0.06, recovery: 0.26, damage: 8, stamina: 8, reach: 1.4, arc: 60,
  hitstun: 0.32, blockstun: 0.15, push: 0.4, lunge: 0.2, chainIn: 0.065,
  keys: [
    ['w0.5', K(feetOf('FL'), { root: { yaw: -12, up: -0.1 }, spine: [6, 6, 0], chest: [6, 10, 0],
      handL: { at: [-0.08, 1.36, 0.36], pole: [0.8, -0.6, -0.2] }, handR: chinR })],
    ['hit', elbowHit],
    ['hold', elbowHit],
    ['r0.4', K(handsOf('BL'), feetOf('BL'), { root: { yaw: -138, up: -0.09 }, spine: [4, 8, 0], chest: [6, 14, 0] })],
  ],
});

export const FRONT_MOVES = [
  fr_snap_jab, fr_crossing_straight, fr_liver_hook, fr_gate_kick, fr_turning_backfist, fr_falling_axe, fr_shin_cutter, fr_snap_backfist,
  fl_snap_jab, fl_crossing_straight, fl_liver_hook, fl_gate_kick, fl_turning_backfist, fl_twin_sparrows, fl_wheel_kick, fl_reverse_elbow,
];
