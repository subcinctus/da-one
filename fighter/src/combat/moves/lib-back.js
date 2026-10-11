// Back-stance attacks: BR originals, their BL mirrors, and BL originals.
// In a back stance the fighter is turned away (BR yaw +145: right shoulder and right foot toward the opponent).
// Unwinding moves turn toward the front; spinning moves (BR <-> BL) go all the way round through the front.
// Motion rules: see lib-front.js (yaw carried by the wind-up, <= 15 deg per 1/120 s step; support foot fixed from the
// last wind-up key to the hit; stepping feet lifted flat above their landing spot; follow-through 'hold' keys).
// Spins: coil 'inOut', spin up 'in', cruise 'linear', and reach the hit 'linear' (the body is already turning fast).
import { defineMove, mirrorMove } from './define.js';
import { K, feetOf, handsOf, chinR, by, trailFoot, WRIST_PALM, TOES, HEEL } from './parts.js';

// ------------------------------------------------------------------------------------------------ BR originals

// BR -> FR: the feet stay and pivot; the right fist whips out as the body unwinds
const whipFeet = { footR: { at: [-0.07, 0, 0.27], yaw: 60 }, footL: { at: [0.19, 0, -0.26], yaw: 110, pitch: 8 } };
const whipHit = K(whipFeet, {
  root: { yaw: 74, up: -0.07, fwd: 0.04 }, spine: [4, 0, 0], chest: [4, 4, 0],
  handR: { at: [-0.04, 1.52, 1.05], pole: [0, 1, -0.4] }, handL: { at: [0.16, 1.45, 0.02], pole: [1, -1, 0] },
});
export const br_whip_fist = defineMove({
  id: 'br_whip_fist', name: 'Whip Fist', desc: 'Unwinds from the back stance with the knuckles leading. A short story, told quickly.',
  start: 'BR', end: 'FR', weight: 'light', height: 'high', path: 'horizontal', limb: 'handR',
  startup: 0.17, active: 0.06, recovery: 0.26, damage: 7, stamina: 7, reach: 1.65, arc: 90,
  hitstun: 0.3, blockstun: 0.14, push: 0.3, lunge: 0.2, chainIn: 0.065,
  keys: [
    ['w0.3', K(feetOf('BR'), { root: { yaw: 151, up: -0.09 }, spine: [5, -10, 0], chest: [6, -14, 0],
      handR: { at: [0.06, 1.44, 0.22], pole: [-0.2, 0.4, -0.4] }, handL: { at: by(151, 0.08, 1.4, 0.18) } })],
    ['w0.58', K({ root: { yaw: 116, up: -0.08 }, spine: [5, -8, 0], chest: [6, -10, 0],
      handR: { at: [0.12, 1.44, 0.22], pole: [0, 1, -0.4] }, handL: { at: by(116, 0.08, 1.4, 0.18) },
      footR: { at: [-0.07, 0, 0.26], yaw: 90 }, footL: { at: [0.2, 0, -0.27], yaw: 136, pitch: 7 } }), 'in'],
    ['w0.68', K(whipFeet, { root: { yaw: 101, up: -0.08, fwd: 0.02 }, spine: [5, -5, 0], chest: [5, -6, 0],
      handR: { at: [0.1, 1.46, 0.3], pole: [0, 1, -0.4] }, handL: { at: [0.16, 1.44, 0.04] } }), 'linear'],
    ['hit', whipHit, 'in'],
    ['hold', K(whipHit, { root: { yaw: 68, up: -0.07, fwd: 0.08 }, chest: [4, 0, 0],
      handR: { at: [-0.1, 1.52, 1.08], pole: [0, 1, -0.4] } }), 'out'],
    ['r0.4', K(handsOf('FR'), feetOf('FR'), { root: { yaw: 42, up: -0.075 }, handR: { at: [-0.03, 1.45, 0.5], pole: [-0.6, -1, 0] } })],
  ],
});

const muleFootL = { at: [0.15, 0, -0.25], yaw: 172, pitch: 6 };
const muleHit = K({
  root: { yaw: 172, up: -0.02, fwd: -0.04 }, hips: [6, 0, 0], spine: [22, 0, 0], chest: [10, -12, 0],
  footR: { at: [-0.04, 0.95, 1.08], pole: [0, -1, 0.1], ankle: [0, 0, 0] },
  footL: muleFootL,
  handR: { at: by(172, -0.12, 1.15, 0.3), pole: [0, -1, 0] }, handL: { at: by(172, 0.12, 1.25, 0.3), pole: [0, -1, 0] },
});
export const br_mule_kick = defineMove({
  id: 'br_mule_kick', name: 'Mule Kick', desc: 'Straight back, heel first. No need to look; it is in the name.',
  start: 'BR', end: 'BR', weight: 'medium', height: 'mid', path: 'thrust', limb: 'footR',
  startup: 0.27, active: 0.08, recovery: 0.34, damage: 13, stamina: 12, reach: 2.1, arc: 45,
  hitstun: 0.42, blockstun: 0.2, push: 1.0, lunge: 0.2, chainIn: 0.1,
  props: { stop: true },
  keys: [
    ['w0.25', K(handsOf('BR'), { root: { yaw: 152, up: -0.08 }, hips: [2, 0, 0], spine: [6, -6, 0], chest: [6, -14, 0],
      footR: { at: [-0.06, 0.24, 0.22], flat: true, yaw: 120, pitch: 15 }, footL: { at: [0.19, 0, -0.27], yaw: 165, pitch: 6 } })],
    ['w0.5', K({ root: { yaw: 162, up: -0.06 }, hips: [4, 0, 0], spine: [10, -4, 0], chest: [8, -12, 0],
      footR: { at: by(162, -0.1, 0.5, 0.15), pole: by(162, 0, 0.3, 1), ankle: [0, 0, 0] }, footL: muleFootL,
      handR: { at: by(162, -0.1, 1.38, 0.25) }, handL: { at: by(162, 0.1, 1.38, 0.22) } })],
    ['w0.72', K({ root: { yaw: 167, up: -0.05 }, hips: [5, 0, 0], spine: [16, -2, 0], chest: [9, -12, 0],
      footR: { at: by(167, -0.08, 0.52, -0.32), pole: by(167, 0, -1, 0.2), ankle: [0, 0, 0] }, footL: muleFootL,
      handR: { at: by(167, -0.11, 1.3, 0.28) }, handL: { at: by(167, 0.11, 1.32, 0.26) } })],
    ['hit', muleHit],
    ['h0.45', K(muleHit, { root: { yaw: 173, up: -0.02, fwd: -0.01 }, spine: [25, 0, 0] }), 'out'],
    ['hold', K(muleHit, { root: { yaw: 160, up: -0.05, fwd: -0.02 }, spine: [16, 0, 0], chest: [8, -14, 0],
      footR: { at: by(160, -0.1, 0.58, -0.3), pole: by(160, 0, 0.3, 1), ankle: [0, 0, 0] } }), 'inOut'],
    ['r0.4', K({ root: { yaw: 155, up: -0.07 }, spine: [8, -8, 0], chest: [6, -16, 0],
      footR: { at: by(155, -0.1, 0.45, 0.1), pole: by(155, 0, 0.2, 1), ankle: [10, 0, 0] }, footL: { at: [0.19, 0, -0.27], yaw: 165, pitch: 6 },
      handR: { at: [0.02, 1.45, 0.25] }, handL: { at: [0.16, 1.4, 0.02] } })],
  ],
});

// full turn on the right foot (it stays under the body and pivots round); the left leg swings round heel first
const heelTrail = (f) => trailFoot('BR', 'BL', 'R', f, 12);   // f = t / 0.48 (hold)
const heelHit = K({
  root: { yaw: -108, up: -0.02 }, hips: [0, 0, 0], spine: [-2, 0, 18], chest: [0, 0, 8],
  footL: { at: [0.02, 1.55, 0.98], pole: [0, 1, 0.2], ankle: [HEEL, 0, 0], reach: 0.97 },
  footR: heelTrail(0.833),
  handR: { at: [-0.32, 1.18, -0.1], pole: [-1, 0, -0.5] }, handL: { at: [0.02, 1.4, 0.1], pole: [1, -1, 0] },
});
export const br_spinning_heel = defineMove({
  id: 'br_spinning_heel', name: 'Spinning Heel', desc: 'Goes all the way round to make its point. The point is the heel.',
  start: 'BR', end: 'BL', weight: 'heavy', height: 'high', path: 'horizontal', limb: 'footL',
  startup: 0.4, active: 0.08, recovery: 0.46, damage: 19, stamina: 18, reach: 2.0, arc: 140,
  hitstun: 0.6, blockstun: 0.28, push: 1.2, lunge: 0.35, chainIn: 0.14,
  props: { knockdown: true, break: true },
  keys: [
    ['w0.3', K(feetOf('BR'), { root: { yaw: 156, up: -0.12 }, spine: [8, -8, 0], chest: [6, -14, 0],
      handR: { at: [0.04, 1.42, 0.22] }, handL: { at: [0.18, 1.38, 0.0] } })],
    ['w0.48', K({ root: { yaw: 110, up: -0.1 }, spine: [6, -6, 2], chest: [4, -10, 0],
      footR: heelTrail(0.4), footL: { at: [0.22, 0.26, -0.24], flat: true, yaw: 120, pitch: 12 },
      handR: { at: by(110, -0.1, 1.38, 0.2) }, handL: { at: by(110, 0.18, 1.36, 0.1) } }), 'in'],
    ['w0.68', K({ root: { yaw: 20, up: -0.06 }, spine: [2, 0, 6], chest: [2, -4, 0],
      footR: heelTrail(0.567), footL: { at: [0.36, 0.5, -0.14], pole: by(20, 0.4, 0.3, 1), ankle: [10, 0, 0] },
      handR: { at: [-0.25, 1.3, 0.05] }, handL: { at: [0.18, 1.35, 0.2] } }), 'linear'],
    ['w0.88', K({ root: { yaw: -74, up: -0.03 }, hips: [0, 0, 0], spine: [-2, 0, 14], chest: [0, 0, 6],
      footR: heelTrail(0.733), footL: { at: [0.78, 1.25, 0.38], pole: [0.3, 1, 0], ankle: [HEEL, 0, 0], reach: 0.97 },
      handR: { at: [-0.3, 1.22, -0.05], pole: [-1, 0, -0.5] }, handL: { at: [0.08, 1.38, 0.14], pole: [1, -1, 0] } }), 'linear'],
    ['hit', heelHit, 'linear'],
    ['h0.45', K(heelHit, { footL: { at: [-0.2, 1.5, 0.88], pole: [0, 1, 0.2], ankle: [HEEL, 0, 0], reach: 0.97 }, root: { yaw: -116, up: -0.02 }, footR: heelTrail(0.908) }), 'out'],
    ['hold', K(heelHit, { root: { yaw: -124, up: -0.05 }, spine: [0, 0, 10], chest: [2, 4, 4], footR: heelTrail(1),
      footL: { at: [-0.02, 0.66, 0.36], pole: [0, 0.6, 1], ankle: [10, 0, 0] }, handR: { at: [-0.25, 1.25, -0.05] } }), 'inOut'],
    ['r0.38', K({ root: { yaw: -138, up: -0.1 }, spine: [4, 6, 0], chest: [6, 12, 0],
      footL: { at: [0.06, 0.24, 0.26], pole: [0, 0.3, 1] }, footR: { at: [-0.18, 0, -0.24], yaw: -165, pitch: 8 },
      handL: { at: [-0.02, 1.45, 0.25] }, handR: { at: [-0.16, 1.4, 0.02] } })],
  ],
});

// BR -> FL in one quick turn: the left foot steps round to the front while the right stays put in the world (the
// lunge carries the body over it) and pivots into the FL rear foot; the palm extends during the last part of the turn
const palmTrail = (f) => trailFoot('BR', 'FL', 'R', f, 10);   // f = t / 0.25 (hold)
const palmHit = K({
  root: { yaw: -16, up: -0.1, fwd: 0.06 }, hips: [2, -4, 0], spine: [6, -6, 0], chest: [6, -12, 0],
  handL: { at: [0.02, 1.26, 1.02], pole: [0.8, -1, 0], wrist: WRIST_PALM }, handR: chinR,
  footL: { at: [0.06, 0, 0.3], yaw: -10 }, footR: palmTrail(0.76),
});
export const br_reverse_palm = defineMove({
  id: 'br_reverse_palm', name: 'Reverse Palm', desc: 'Turns around and returns the favour, palm first.',
  start: 'BR', end: 'FL', weight: 'light', height: 'mid', path: 'thrust', limb: 'handL',
  startup: 0.19, active: 0.06, recovery: 0.26, damage: 8, stamina: 8, reach: 1.65, arc: 55,
  hitstun: 0.32, blockstun: 0.15, push: 0.5, lunge: 0.4, chainIn: 0.07,
  keys: [
    ['w0.35', K({ root: { yaw: 106, up: -0.1 }, spine: [6, -8, 0], chest: [6, -10, 0],
      handL: { at: by(96, 0.2, 1.1, 0.04), pole: by(96, 0.3, -0.4, -1) }, handR: { at: by(106, -0.06, 1.45, 0.22) },
      footR: palmTrail(0.266), footL: { at: [0.2, 0.3, -0.24], flat: true, yaw: 120, pitch: 10 } }), 'in'],
    ['w0.52', K({ root: { yaw: 62, up: -0.095, fwd: 0.015 }, spine: [6, -6, 0], chest: [6, -8, 0],
      handL: { at: by(55, 0.19, 1.13, 0.16), pole: by(55, 0.35, -0.45, -1) }, handR: { at: by(62, -0.07, 1.45, 0.21) },
      footR: palmTrail(0.395), footL: { at: [0.15, 0.33, 0.02], flat: true, yaw: 55, pitch: 10 } }), 'linear'],
    ['w0.7', K({ root: { yaw: 18, up: -0.09, fwd: 0.03 }, spine: [6, -4, 0], chest: [6, -6, 0],
      handL: { at: by(14, 0.18, 1.16, 0.3), pole: by(14, 0.4, -0.5, -1), wrist: WRIST_PALM }, handR: { at: by(18, -0.08, 1.45, 0.2) },
      footR: palmTrail(0.532), footL: { at: [0.07, 0.22, 0.25], flat: true, yaw: -10, pitch: 4 } }), 'linear'],
    ['hit', palmHit, 'linear'],
    ['hold', K(palmHit, { root: { yaw: -21, up: -0.1, fwd: 0.09 }, chest: [6, -17, 0],
      handL: { at: [0.03, 1.27, 1.09], pole: [0.8, -1, 0], wrist: WRIST_PALM }, footR: palmTrail(1) }), 'out'],
    ['r0.4', K(handsOf('FL'), feetOf('FL'), { root: { yaw: -24, up: -0.08 }, handL: { at: [0.04, 1.4, 0.5], pole: [0.6, -1, 0] } })],
  ],
});

const dragonFootL = { at: [0.22, 0, -0.1], yaw: 100, pitch: 10 };
const dragonHit = K({
  root: { yaw: 50, up: -0.45 }, hips: [10, 0, 0], spine: [22, 0, 0], chest: [8, 0, 0],
  footR: { at: [0.0, 0.1, 1.05], pole: [0, 1, 0], ankle: [-10, 0, 0] },
  footL: dragonFootL,
  handL: { at: [0.34, 0.36, 0.12], pole: [1, 0, -0.5] }, handR: { at: [-0.12, 0.98, 0.32], pole: [-1, -1, 0] },
});
export const br_dragon_tail = defineMove({
  id: 'br_dragon_tail', name: 'Dragon Tail', desc: 'Drops under everything and takes the floor with it.',
  start: 'BR', end: 'FR', weight: 'medium', height: 'low', path: 'horizontal', limb: 'footR',
  startup: 0.3, active: 0.08, recovery: 0.4, damage: 11, stamina: 13, reach: 1.95, arc: 150,
  hitstun: 0.5, blockstun: 0.2, push: 0.6, lunge: 0.1, chainIn: 0.11,
  props: { knockdown: true, duck: true },
  keys: [
    ['w0.2', K(handsOf('BR'), { root: { yaw: 147, up: -0.18 }, hips: [4, 0, 0], spine: [8, -6, 0], chest: [7, -12, 0],
      footL: { at: [0.21, 0, -0.28], yaw: 158, pitch: 8 }, footR: { at: [-0.05, 0.3, 0.2], flat: true, yaw: 118, pitch: 10 } })],
    ['w0.33', K(handsOf('BR'), { root: { yaw: 147, up: -0.28 }, hips: [7, 0, 0], spine: [14, -6, 0], chest: [8, -11, 0],
      footL: { at: [0.2, 0, -0.27], yaw: 158, pitch: 9 }, footR: { at: by(147, -0.28, 0.34, 0.3), flat: true, yaw: 150, pitch: 10 } }), 'linear'],
    ['w0.45', K({ root: { yaw: 146, up: -0.36 }, hips: [10, 0, 0], spine: [20, -6, 0], chest: [8, -10, 0],
      footL: { at: [0.2, 0, -0.26], yaw: 158, pitch: 10 }, footR: { at: by(146, -0.42, 0.26, 0.32), pole: [0, 1, 0], ankle: [0, 0, 0] },
      handL: { at: by(150, 0.24, 0.78, 0.25), pole: by(150, 1, -0.4, -0.5) }, handR: { at: by(150, -0.1, 1.12, 0.3) } })],
    ['w0.65', K({ root: { yaw: 118, up: -0.45 }, hips: [10, 0, 0], spine: [23, -3, 0], chest: [8, -6, 0],
      footL: { at: [0.21, 0, -0.18], yaw: 140, pitch: 10 }, footR: { at: by(118, -0.6, 0.12, 0.5), pole: [0, 1, 0], ankle: [-5, 0, 0] },
      handL: { at: by(118, 0.3, 0.4, 0.2), pole: by(118, 1, 0, -0.5) }, handR: { at: by(118, -0.12, 1.0, 0.32) } }), 'in'],
    ['w0.85', K({ root: { yaw: 80, up: -0.46 }, hips: [10, 0, 0], spine: [24, 0, 0], chest: [8, -4, 0],
      footL: dragonFootL, footR: { at: by(80, -0.62, 0.1, 0.66), pole: [0, 1, 0], ankle: [-5, 0, 0] },
      handL: { at: by(80, 0.32, 0.38, 0.18), pole: by(80, 1, 0, -0.5) }, handR: { at: by(80, -0.12, 0.98, 0.32) } }), 'linear'],
    ['hit', dragonHit, 'in'],
    ['h0.4', K(dragonHit, { root: { yaw: 40, up: -0.45 }, footR: { at: [-0.25, 0.1, 0.98], pole: [0, 1, 0], ankle: [-10, 0, 0] } }), 'out'],
    ['hold', K(dragonHit, { root: { yaw: 30, up: -0.3 }, hips: [6, 0, 0], spine: [14, 0, 0], chest: [6, 0, 0],
      footR: { at: [-0.12, 0.26, 0.42], flat: true, yaw: 15, pitch: 8 }, footL: { at: [0.2, 0, -0.12], yaw: 60, pitch: 8 },
      handL: { at: [0.22, 0.95, 0.25], pole: [1, -0.6, -0.4] }, handR: { at: [-0.1, 1.2, 0.34], pole: [-1, -1, 0] } }), 'inOut'],
    ['r0.45', K({ root: { yaw: 26, up: -0.2 }, spine: [10, 0, 0],
      footR: { at: [-0.06, 0.05, 0.38], yaw: 10 }, footL: { at: [0.18, 0, -0.24], yaw: 50, pitch: 8 },
      handR: { at: [-0.04, 1.3, 0.38] }, handL: { at: [0.08, 1.33, 0.18] } })],
  ],
});

const bellHit = K({
  root: { yaw: 112, up: -0.12, fwd: 0.06 }, hips: [6, 0, 0], spine: [16, 0, 0], chest: [8, -8, 0],
  handR: { at: [-0.02, 1.3, 0.85], pole: [-0.3, 1, -0.6] }, handL: { at: by(112, 0.1, 1.3, 0.25), pole: [1, -1, 0] },
  footR: { at: [-0.07, 0, 0.28], yaw: 100 }, footL: { at: [0.2, 0, -0.27], yaw: 150, pitch: 8 },
});
export const br_temple_bell = defineMove({
  id: 'br_temple_bell', name: 'Temple Bell', desc: 'An overhead hammer fist. Hold it and the whole monastery hears it.',
  start: 'BR', end: 'BR', weight: 'heavy', height: 'high', path: 'vertical', limb: 'handR',
  startup: 0.4, active: 0.08, recovery: 0.46, damage: 17, stamina: 16, reach: 1.6, arc: 50,
  hitstun: 0.55, blockstun: 0.26, push: 0.7, lunge: 0.3, chainIn: 0.15, chargeAt: 'w0.62',
  props: { charge: true },
  keys: [
    ['w0.62', K({ root: { yaw: 132, up: 0.0 }, hips: [-4, 0, 0], spine: [-10, -6, 0], chest: [-4, -10, 0],
      handR: { at: [-0.08, 2.0, 0.0], pole: [-1, 0.2, -0.3] }, handL: { at: [0.18, 1.38, 0.1] },
      footR: { at: [-0.07, 0.22, 0.25], flat: true, yaw: 110, pitch: 8 }, footL: { at: [0.2, 0, -0.27], yaw: 150, pitch: 8 } })],
    ['hit', bellHit],
    ['hold', K(bellHit, { handR: { at: [-0.02, 1.02, 0.74], pole: [-0.3, 1, -0.6] }, spine: [22, 0, 0], root: { yaw: 112, up: -0.15, fwd: 0.06 } }), 'out'],
    ['r0.4', K(handsOf('BR'), feetOf('BR'), { root: { yaw: 136, up: -0.1 }, spine: [8, -10, 0], chest: [6, -16, 0] })],
  ],
});

const kneeHit = K({
  root: { yaw: -14, up: 0.16, fwd: 0.08 }, hips: [-4, 0, 0], spine: [-4, 0, 0], chest: [6, 0, 0],
  footL: { at: [0.08, 0.86, 0.16], pole: [0, 0.4, 1], ankle: [TOES, 0, 0] },
  footR: { at: [-0.12, 0.42, -0.36], pole: [0, -0.3, 1], ankle: [TOES, 0, 0] },
  handL: { at: [0.1, 1.32, 0.58], pole: [1, -0.4, 0] }, handR: { at: [-0.1, 1.32, 0.58], pole: [-1, -0.4, 0] },
});
export const br_flying_knee = defineMove({
  id: 'br_flying_knee', name: 'Flying Knee', desc: 'Leaves the ground briefly, and your guard permanently.',
  start: 'BR', end: 'FL', weight: 'medium', height: 'mid', path: 'vertical', limb: 'kneeL',
  startup: 0.3, active: 0.08, recovery: 0.36, damage: 13, stamina: 13, reach: 1.45, arc: 60,
  hitstun: 0.44, blockstun: 0.2, push: 0.6, lunge: 0.55, chainIn: 0.11,
  props: { jump: true },
  keys: [
    ['w0.3', K(feetOf('BR'), { root: { yaw: 128, up: -0.16 }, hips: [6, 0, 0], spine: [12, -8, 0], chest: [6, -10, 0],
      handR: { at: by(128, -0.15, 1.2, -0.1) }, handL: { at: by(128, 0.15, 1.2, -0.12) } })],
    ['w0.55', K({ root: { yaw: 70, up: -0.12, fwd: 0.02 }, hips: [4, 0, 0], spine: [8, -4, 0], chest: [4, -4, 0],
      footR: { at: [-0.08, 0, 0.12], yaw: 50, pitch: 20 }, footL: { at: [0.21, 0, -0.27], yaw: 100, pitch: 30 },
      handR: { at: by(70, -0.15, 1.3, 0.15) }, handL: { at: by(70, 0.15, 1.3, 0.12) } })],
    ['w0.78', K({ root: { yaw: 18, up: 0.08, fwd: 0.04 }, hips: [-2, 0, 0], spine: [2, 0, 0],
      footL: { at: [0.15, 0.34, -0.17], pole: [0, 0.4, 1], ankle: [TOES, 0, 0] }, footR: { at: [-0.1, 0.32, 0.02], flat: true, yaw: 20, pitch: 30 },
      handL: { at: [0.14, 1.45, 0.42] }, handR: { at: [-0.14, 1.45, 0.42] } })],
    ['hit', kneeHit],
    ['hold', K(kneeHit, { root: { yaw: -18, up: 0.17, fwd: 0.11 }, chest: [10, 0, 0],
      footL: { at: [0.08, 0.92, 0.22], pole: [0, 0.4, 1], ankle: [TOES, 0, 0] },
      handL: { at: [0.1, 1.24, 0.52], pole: [1, -0.4, 0] }, handR: { at: [-0.1, 1.24, 0.52], pole: [-1, -0.4, 0] } }), 'out'],
    ['r0.35', K(handsOf('FL'), { root: { yaw: -22, up: -0.14, fwd: 0.04 }, spine: [8, 0, 0],
      footL: { at: [0.05, 0, 0.3], yaw: -10 }, footR: { at: [-0.17, 0.04, -0.25], yaw: -40, pitch: 15 } })],
  ],
});

// the same full turn as the spinning heel, with the left fist leading
const sbfTrail = (f) => trailFoot('BR', 'BL', 'R', f, 10);   // f = t / 0.37 (hold)
const sbfHit = K({
  root: { yaw: -102, up: -0.08, fwd: 0.04 }, spine: [4, 0, 0], chest: [4, -6, 0],
  handL: { at: [0.02, 1.52, 1.05], pole: [0, 1, -0.4] }, handR: { at: [0.04, 1.44, 0.06], pole: [-1, -1, 0] },
  footL: { at: [0.06, 0, 0.22], yaw: -95 }, footR: sbfTrail(0.811),
});
export const br_spinning_backfist = defineMove({
  id: 'br_spinning_backfist', name: 'Spinning Back Fist', desc: 'A full turn for one knuckle. Worth it.',
  start: 'BR', end: 'BL', weight: 'medium', height: 'high', path: 'horizontal', limb: 'handL',
  startup: 0.3, active: 0.07, recovery: 0.32, damage: 12, stamina: 12, reach: 1.75, arc: 120,
  hitstun: 0.4, blockstun: 0.18, push: 0.55, lunge: 0.35, chainIn: 0.11,
  keys: [
    ['w0.25', K(feetOf('BR'), { root: { yaw: 150, up: -0.09 }, spine: [5, -10, 0], chest: [6, -14, 0],
      handL: { at: by(150, -0.12, 1.38, 0.2), pole: by(150, 0, -0.2, 1) }, handR: { at: [0.02, 1.45, 0.25] } })],
    ['w0.45', K({ root: { yaw: 110, up: -0.09 }, spine: [5, -6, 0], chest: [6, -8, 0],
      handL: { at: by(110, -0.12, 1.38, 0.2), pole: by(110, 0, -0.2, 1) }, handR: { at: by(110, -0.08, 1.44, 0.15) },
      footR: sbfTrail(0.365), footL: { at: [0.2, 0.26, -0.24], flat: true, yaw: 120, pitch: 10 } }), 'in'],
    ['w0.68', K({ root: { yaw: 5, up: -0.08, fwd: 0.03 }, spine: [5, 4, 0], chest: [5, 8, 0],
      handL: { at: by(5, -0.12, 1.42, 0.22), pole: by(5, 0, 0.6, 1) }, handR: { at: by(5, -0.08, 1.44, 0.15) },
      footR: sbfTrail(0.551), footL: { at: [0.2, 0.27, 0.04], flat: true, yaw: 20, pitch: 8 } }), 'linear'],
    ['w0.84', K({ root: { yaw: -70, up: -0.08, fwd: 0.04 }, spine: [5, 4, 0], chest: [5, 8, 0],
      handL: { at: [-0.12, 1.46, 0.3], pole: [0, 1, -0.4] }, handR: { at: by(-70, -0.06, 1.44, 0.14) },
      footR: sbfTrail(0.681), footL: { at: [0.07, 0.22, 0.2], flat: true, yaw: -85, pitch: 4 } }), 'linear'],
    ['hit', sbfHit, 'in'],
    ['hold', K(sbfHit, { root: { yaw: -108, up: -0.08, fwd: 0.07 }, chest: [4, -10, 0],
      handL: { at: [-0.04, 1.52, 1.08], pole: [0, 1, -0.4] }, footR: sbfTrail(1) }), 'out'],
    ['r0.4', K(handsOf('BL'), feetOf('BL'), { root: { yaw: -130, up: -0.08 }, spine: [4, 6, 0], chest: [5, 10, 0],
      handL: { at: [0.0, 1.46, 0.45], pole: [0.6, -1, 0] } })],
  ],
});

// ------------------------------------------------------------------------------------------------ BL mirrors

export const bl_whip_fist = mirrorMove(br_whip_fist, { id: 'bl_whip_fist' });
export const bl_mule_kick = mirrorMove(br_mule_kick, { id: 'bl_mule_kick' });
export const bl_spinning_heel = mirrorMove(br_spinning_heel, { id: 'bl_spinning_heel' });
export const bl_reverse_palm = mirrorMove(br_reverse_palm, { id: 'bl_reverse_palm' });
export const bl_dragon_tail = mirrorMove(br_dragon_tail, { id: 'bl_dragon_tail' });
export const bl_spinning_backfist = mirrorMove(br_spinning_backfist, { id: 'bl_spinning_backfist' });

// ------------------------------------------------------------------------------------------------ BL originals

const scKick1 = K({
  root: { yaw: -6, up: 0.14, fwd: 0.06 }, hips: [-8, 0, 0], spine: [-6, 0, 0], chest: [4, 0, 0],
  footL: { at: [0.08, 1.12, 1.0], pole: [0, 1, 0.3], ankle: [5, 0, 0] },
  footR: { at: [-0.1, 0.5, -0.12], pole: [0, 0.2, 1], ankle: [TOES, 0, 0] },
  handL: { at: [0.3, 1.18, -0.08], pole: [1, 0, -0.5] }, handR: { at: [-0.12, 1.42, 0.3] },
});
const scKick2 = K({
  root: { yaw: 22, up: 0.12, fwd: 0.08 }, hips: [-8, 0, 0], spine: [-6, 0, 0], chest: [4, 0, 0],
  footR: { at: [-0.06, 1.15, 1.0], pole: [0, 1, 0.3], ankle: [5, 0, 0] },
  footL: { at: [0.12, 0.48, -0.12], pole: [0, 0.2, 1], ankle: [TOES, 0, 0] },
  handR: { at: [-0.3, 1.18, -0.08], pole: [-1, 0, -0.5] }, handL: { at: [0.12, 1.42, 0.3] },
});
export const bl_scissor_kicks = defineMove({
  id: 'bl_scissor_kicks', name: 'Scissor Kicks', desc: 'Two front kicks, one jump, zero landing plan.',
  start: 'BL', end: 'FR', weight: 'medium', height: 'mid', path: 'thrust', limb: 'footR',
  startup: 0.28, active: 0.2, recovery: 0.34, damage: 14, stamina: 15, reach: 1.9, arc: 50,
  hitstun: 0.4, blockstun: 0.2, push: 0.7, lunge: 0.5, chainIn: 0.1,
  props: { jump: true, double: true },
  hits: [{ t: 0.28, dur: 0.05, limb: 'footL', damage: 6 }, { t: 0.42, dur: 0.06, limb: 'footR', damage: 8 }],
  keys: [
    ['w0.3', K(feetOf('BL'), { root: { yaw: -128, up: -0.16 }, hips: [6, 0, 0], spine: [12, 8, 0], chest: [6, 10, 0],
      handL: { at: by(-128, 0.15, 1.2, -0.1) }, handR: { at: by(-128, -0.15, 1.2, -0.12) } })],
    ['w0.52', K({ root: { yaw: -84, up: -0.13, fwd: 0.02 }, hips: [5, 0, 0], spine: [9, 5, 0], chest: [6, 5, 0],
      footL: { at: [0.07, 0, 0.24], yaw: -75, pitch: 30 }, footR: { at: [-0.2, 0.28, -0.26], flat: true, yaw: -110, pitch: 20 },
      handL: { at: by(-84, 0.15, 1.24, 0.0) }, handR: { at: by(-84, -0.15, 1.24, 0.0) } }), 'in'],
    ['w0.7', K({ root: { yaw: -30, up: 0.08, fwd: 0.03 }, hips: [-4, 0, 0], spine: [-2, 0, 0],
      footL: { at: [0.1, 0.72, 0.26], pole: [0, 0.4, 1], ankle: [TOES, 0, 0] }, footR: { at: [-0.12, 0.3, -0.2], flat: true, yaw: -30, pitch: 25 },
      handL: { at: [0.2, 1.3, 0.1] }, handR: { at: [-0.14, 1.42, 0.3] } }), 'linear'],
    [0.28, scKick1, 'in'],
    [0.33, K(scKick1, { root: { yaw: -2, up: 0.15, fwd: 0.1 }, footL: { at: [0.08, 1.2, 1.1], pole: [0, 1, 0.3], ankle: [5, 0, 0] },
      footR: { at: [-0.1, 0.42, 0.0], pole: [0, 0.3, 1], ankle: [TOES, 0, 0] } }), 'out'],
    [0.37, K({ root: { yaw: 8, up: 0.16, fwd: 0.07 }, hips: [-6, 0, 0], spine: [-4, 0, 0],
      footL: { at: [0.12, 0.6, 0.2], pole: [0, 0.4, 1], ankle: [TOES, 0, 0] }, footR: { at: [-0.1, 0.7, 0.25], pole: [0, 0.4, 1], ankle: [TOES, 0, 0] },
      handL: { at: [0.14, 1.4, 0.25] }, handR: { at: [-0.2, 1.3, 0.1] } }), 'inOut'],
    [0.42, scKick2, 'linear'],
    [0.45, K(scKick2, { root: { yaw: 24, up: 0.12, fwd: 0.1 }, footR: { at: [-0.06, 1.18, 1.06], pole: [0, 1, 0.3], ankle: [5, 0, 0] } }), 'out'],
    [0.48, K(scKick2, { root: { yaw: 24, up: 0.06, fwd: 0.07 }, footR: { at: [-0.06, 0.62, 0.42], pole: [0, 0.6, 1], ankle: [TOES, 0, 0] } }), 'inOut'],
    ['r0.35', K(handsOf('FR'), { root: { yaw: 24, up: -0.14, fwd: 0.04 }, spine: [8, 0, 0],
      footR: { at: [-0.06, 0, 0.3], yaw: 10 }, footL: { at: [0.18, 0.03, -0.25], yaw: 42, pitch: 15 } }), 'out'],
  ],
});

// BL -> FL: the feet stay and pivot; the left foot stamps forward with the palm
const ironFootR = { at: [-0.21, 0, -0.26], yaw: -90, pitch: 8 };
const ironHit = K({
  root: { yaw: -34, up: -0.16, fwd: 0.08 }, hips: [2, -6, 0], spine: [6, -6, 0], chest: [6, -14, 0],
  handL: { at: [0.02, 1.2, 1.02], pole: [0.8, -1, 0], wrist: WRIST_PALM }, handR: { at: [-0.24, 1.0, -0.08], pole: [-1, -0.2, -1] },
  footL: { at: [0.07, 0, 0.33], yaw: -15 }, footR: ironFootR,
});
export const bl_iron_palm = defineMove({
  id: 'bl_iron_palm', name: 'Iron Palm', desc: 'Sinks, breathes, and delivers. Hold it longer and it brings friends.',
  start: 'BL', end: 'FL', weight: 'heavy', height: 'mid', path: 'thrust', limb: 'handL',
  startup: 0.38, active: 0.08, recovery: 0.44, damage: 16, stamina: 15, reach: 1.7, arc: 50,
  hitstun: 0.55, blockstun: 0.26, push: 1.1, lunge: 0.4, chainIn: 0.14, chargeAt: 'w0.68',
  props: { charge: true },
  keys: [
    ['w0.4', K({ root: { yaw: -122, up: -0.19 }, hips: [4, 0, 0], spine: [6, 6, 0], chest: [4, 8, 0],
      handL: { at: by(-122, 0.22, 1.02, -0.08), pole: by(-122, 0.6, -0.3, -1) }, handR: { at: by(-122, -0.05, 1.42, 0.25) },
      footL: { at: [0.07, 0, 0.25], yaw: -110 }, footR: { at: [-0.21, 0, -0.27], yaw: -140, pitch: 6 } })],
    ['w0.68', K({ root: { yaw: -66, up: -0.2 }, hips: [4, -2, 0], spine: [6, 2, 0], chest: [4, 2, 0],
      handL: { at: by(-66, 0.22, 1.0, -0.1), pole: by(-66, 0.6, -0.3, -1) }, handR: { at: by(-66, -0.05, 1.42, 0.25) },
      footL: { at: [0.07, 0.22, 0.28], flat: true, yaw: -40, pitch: 6 }, footR: ironFootR })],
    ['hit', ironHit],
    ['hold', K(ironHit, { root: { yaw: -40, up: -0.16, fwd: 0.13 }, chest: [6, -18, 0],
      handL: { at: [0.03, 1.21, 1.09], pole: [0.8, -1, 0], wrist: WRIST_PALM } }), 'out'],
    ['r0.4', K(handsOf('FL'), feetOf('FL'), { root: { yaw: -26, up: -0.1 }, handL: { at: [0.04, 1.36, 0.5], pole: [0.6, -1, 0] } })],
  ],
});

export const BACK_MOVES = [
  br_whip_fist, br_mule_kick, br_spinning_heel, br_reverse_palm, br_dragon_tail, br_temple_bell, br_flying_knee, br_spinning_backfist,
  bl_whip_fist, bl_mule_kick, bl_spinning_heel, bl_reverse_palm, bl_dragon_tail, bl_spinning_backfist, bl_scissor_kicks, bl_iron_palm,
];
