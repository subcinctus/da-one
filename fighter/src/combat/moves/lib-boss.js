// Boss signature moves (boss: true, never learnable) and the focus attacks (FIGHTER.md §7 Focus).
import { defineMove, mirrorMove } from './define.js';
import { K, feetOf, handsOf, chinL, by, WRIST_PALM, HEEL } from './parts.js';

// ------------------------------------------------------------------------------------------------ Tadao (FR)

const ciHip = { R: { at: [-0.2, 1.03, 0.04], pole: [-0.4, -0.3, -1] }, L: { at: [0.2, 1.03, -0.02], pole: [0.4, -0.3, -1] } };
const ciHit1 = K({
  root: { yaw: 40, up: -0.12, fwd: 0.05 }, hips: [2, 6, 0], spine: [6, 4, 0], chest: [6, 10, 0],
  handR: { at: [-0.02, 1.22, 1.04], pole: [-0.8, -1, 0], wrist: WRIST_PALM }, handL: ciHip.L,
  footR: { at: [-0.05, 0, 0.33], yaw: 15 }, footL: { at: [0.18, 0, -0.24], yaw: 45, pitch: 8 },
});
const ciHit2 = K({
  root: { yaw: 4, up: -0.12, fwd: 0.08 }, hips: [2, -6, 0], spine: [6, -4, 0], chest: [6, -12, 0],
  handL: { at: [0.02, 1.26, 1.04], pole: [0.8, -1, 0], wrist: WRIST_PALM }, handR: ciHip.R,
  footR: { at: [-0.05, 0, 0.33], yaw: 15 }, footL: { at: [0.18, 0, -0.24], yaw: 45, pitch: 8 },
});
export const tadao_compound_interest = defineMove({
  id: 'tadao_compound_interest', name: 'Compound Interest', desc: 'Two palms. The second one is the interest, and it compounds.',
  start: 'FR', end: 'FR', weight: 'medium', height: 'mid', path: 'thrust', limb: 'handL', boss: true,
  startup: 0.24, active: 0.2, recovery: 0.3, damage: 15, stamina: 12, reach: 1.7, arc: 50,
  hitstun: 0.36, blockstun: 0.18, push: 0.6, lunge: 0.35, chainIn: 0.095,
  props: { double: true },
  hits: [{ t: 0.24, dur: 0.05, limb: 'handR', damage: 6 }, { t: 0.38, dur: 0.06, limb: 'handL', damage: 9 }],
  keys: [
    ['w0.5', K(feetOf('FR'), { root: { yaw: 16, up: -0.13 }, spine: [6, -4, 0], handR: ciHip.R, handL: ciHip.L })],
    [0.24, ciHit1, 'snap'],
    [0.29, ciHit1, 'linear'],
    [0.33, K(ciHit1, { root: { yaw: 22, up: -0.12, fwd: 0.06 }, chest: [6, 0, 0],
      handR: { at: [-0.2, 1.08, 0.18], pole: [-0.4, -0.3, -1] }, handL: { at: [0.16, 1.12, 0.3], pole: [0.6, -1, -0.3] } }), 'inOut'],
    [0.38, ciHit2, 'snap'],
    [0.44, ciHit2, 'linear'],
    ['r0.4', K(handsOf('FR'), feetOf('FR'), { root: { yaw: 18, up: -0.09 } }), 'out'],
  ],
});

const feeHit = K({
  root: { yaw: -24, up: -0.1, fwd: 0.05 }, hips: [4, -4, 0], spine: [14, -6, 0], chest: [6, -12, 0],
  handL: { at: [0.0, 1.45, 0.88], pole: [0.7, 0.7, -0.3] }, handR: { at: [-0.1, 1.3, 0.2], pole: [-1, -1, 0] },
  footL: { at: [0.06, 0, 0.31], yaw: -10 }, footR: { at: [-0.17, 0, -0.22], yaw: -50, pitch: 15 },
});
export const tadao_late_fee = defineMove({
  id: 'tadao_late_fee', name: 'Late Fee', desc: 'Arrives later than expected. Costs more than expected.',
  start: 'FR', end: 'FL', weight: 'heavy', height: 'high', path: 'vertical', limb: 'handL', boss: true,
  startup: 0.44, active: 0.08, recovery: 0.48, damage: 19, stamina: 16, reach: 1.7, arc: 50,
  hitstun: 0.55, blockstun: 0.28, push: 0.8, lunge: 0.45, chainIn: 0.17, chargeAt: 'w0.6',
  props: { charge: true, break: true },
  keys: [
    ['w0.6', K(feetOf('FR'), { root: { yaw: 40, up: -0.03 }, hips: [0, 6, 0], spine: [-6, 6, 0], chest: [-2, 8, 0],
      handL: { at: [0.34, 1.95, -0.16], pole: [1, 0.2, -0.6] }, handR: { at: [-0.04, 1.45, 0.62], pole: [-0.6, -1, 0] },
      footL: { at: [0.17, 0.02, -0.24], yaw: 45, pitch: 25 } })],
    ['hit', feeHit],
    ['hold', K(feeHit, { handL: { at: [0.0, 1.18, 0.8], pole: [0.7, 0.7, -0.3] }, spine: [18, -6, 0] })],
    ['r0.4', K(handsOf('FL'), feetOf('FL'), { root: { yaw: -24, up: -0.09 } })],
  ],
});

// ------------------------------------------------------------------------------------------------ Madame Shu (FL)

const wokHit = K({
  root: { yaw: -102, up: 0.0 }, hips: [-4, 0, 0], spine: [-6, 0, 16], chest: [-2, 0, 6],
  footL: { at: [0.08, 1.72, 0.95], pole: [0, 1, 0], ankle: [0, 0, 0] },
  footR: { at: [-0.04, 0, -0.04], yaw: -170, pitch: 22 },
  handR: { at: [-0.55, 1.42, -0.12], pole: [0, 1, -0.3] }, handL: { at: [0.32, 1.42, 0.3], pole: [0, 1, -0.3] },
});
export const shu_wok_toss = defineMove({
  id: 'shu_wok_toss', name: 'Wok Toss', desc: 'A spinning crescent kick with the wrist action of forty years at the stove.',
  start: 'BR', end: 'BL', weight: 'heavy', height: 'high', path: 'horizontal', limb: 'footL', boss: true,
  startup: 0.42, active: 0.09, recovery: 0.48, damage: 20, stamina: 18, reach: 2.1, arc: 150,
  hitstun: 0.6, blockstun: 0.3, push: 1.3, lunge: 0.4, chainIn: 0.15,
  props: { knockdown: true },
  keys: [
    ['w0.3', K(feetOf('BR'), { root: { yaw: 160, up: -0.12 }, spine: [8, -8, 0], chest: [6, -14, 0],
      handR: { at: [0.04, 1.42, 0.22] }, handL: { at: [0.18, 1.38, 0.0] } })],
    ['w0.68', K({ root: { yaw: 30, up: -0.04 }, spine: [-2, 0, 10], chest: [0, -4, 0],
      footR: { at: [-0.05, 0, 0.05], yaw: 40, pitch: 18 }, footL: { at: [0.6, 0.95, -0.1], pole: [0, 1, 0], ankle: [0, 0, 0] },
      handR: { at: [-0.45, 1.35, 0.1], pole: [0, 1, -0.3] }, handL: { at: [0.35, 1.4, 0.15], pole: [0, 1, -0.3] } })],
    ['hit', wokHit],
    ['h0.45', K(wokHit, { footL: { at: [-0.25, 1.68, 0.86], pole: [0, 1, 0], ankle: [0, 0, 0] }, root: { yaw: -112, up: 0.0 } }), 'linear'],
    ['hold', K(wokHit, { root: { yaw: -126, up: -0.04 }, spine: [0, 0, 10], chest: [0, 4, 4],
      footL: { at: [-0.05, 0.72, 0.38], pole: [0, 0.6, 1], ankle: [10, 0, 0] } }), 'out'],
    ['r0.38', K({ root: { yaw: -138, up: -0.12 }, spine: [6, 6, 0], chest: [6, 12, 0],
      footL: { at: [0.06, 0.26, 0.26], pole: [0, 0.3, 1] }, footR: { at: [-0.18, 0, -0.24], yaw: -165, pitch: 8 },
      handL: { at: [-0.02, 1.45, 0.25] }, handR: { at: [-0.16, 1.4, 0.02] } })],
  ],
});

const orderHit = K({
  root: { yaw: 30, up: -0.06, fwd: 0.03 }, hips: [-2, 8, 0], spine: [-4, 4, 0], chest: [2, 6, 0],
  footR: { at: [-0.04, 0.42, 1.02], pole: [-0.7, 1, 0], ankle: [HEEL, 0, 0] },
  footL: { at: [0.06, 0, 0.12], yaw: 45, pitch: 8 },
  handR: { at: [-0.3, 1.12, 0.05], pole: [-1, -0.3, -0.5] }, handL: chinL,
});
export const shu_last_order = defineMove({
  id: 'shu_last_order', name: 'Last Order', desc: 'The kitchen is closing. So is your knee.',
  start: 'FL', end: 'FR', weight: 'medium', height: 'low', path: 'thrust', limb: 'footR', boss: true,
  startup: 0.26, active: 0.07, recovery: 0.34, damage: 13, stamina: 11, reach: 1.85, arc: 45,
  hitstun: 0.45, blockstun: 0.2, push: 0.5, lunge: 0.35, chainIn: 0.1,
  props: { stop: true },
  keys: [
    ['w0.5', K(handsOf('FL'), { root: { yaw: 2, up: -0.06 }, spine: [4, 0, 0],
      footR: { at: [-0.1, 0.6, 0.1], pole: [-0.2, 0.3, 1], ankle: [-10, 0, 0] }, footL: { at: [0.05, 0, 0.25], yaw: 20 } })],
    ['hit', orderHit],
    ['hold', orderHit],
    ['r0.4', K(handsOf('FR'), { root: { yaw: 26, up: -0.1 },
      footR: { at: [-0.05, 0.0, 0.3], yaw: 10 }, footL: { at: [0.16, 0, -0.2], yaw: 45, pitch: 12 } })],
  ],
});

// ------------------------------------------------------------------------------------------------ Brick (BR)

const liftHit = K({
  root: { yaw: 28, up: -0.17, fwd: 0.08 }, hips: [8, 0, 0], spine: [22, 0, 0], chest: [10, 0, 0],
  handR: { at: [-0.04, 1.5, 0.84], pole: [-1, 0.4, 0] }, handL: { at: [0.04, 1.5, 0.84], pole: [1, 0.4, 0] },
  footR: { at: [-0.09, 0, 0.32], yaw: 15 }, footL: { at: [0.22, 0, -0.24], yaw: 50, pitch: 6 },
});
export const brick_deadlift = defineMove({
  id: 'brick_deadlift', name: 'Deadlift', desc: 'He lifts with his legs. You land on your back.',
  start: 'BR', end: 'FR', weight: 'heavy', height: 'high', path: 'vertical', limb: 'handR', boss: true,
  startup: 0.48, active: 0.1, recovery: 0.56, damage: 22, stamina: 20, reach: 1.75, arc: 60,
  hitstun: 0.6, blockstun: 0.32, push: 1.2, lunge: 0.4, chainIn: 0.22,
  props: { break: true, knockdown: true },
  keys: [
    ['w0.35', K({ root: { yaw: 122, up: -0.38 }, hips: [22, 0, 0], spine: [22, -4, 0], chest: [6, -6, 0],
      footR: { at: [-0.08, 0, 0.22], yaw: 110 }, footL: { at: [0.24, 0, -0.26], yaw: 150 },
      handR: { at: by(122, -0.03, 0.66, 0.4), pole: by(122, -1, 0, -0.2) }, handL: { at: by(122, 0.03, 0.66, 0.4), pole: by(122, 1, 0, -0.2) } })],
    ['w0.78', K({ root: { yaw: 62, up: 0.0 }, hips: [-4, 0, 0], spine: [-12, 0, 0], chest: [-6, 0, 0],
      footR: { at: [-0.08, 0, 0.26], yaw: 60, pitch: 10 }, footL: { at: [0.22, 0, -0.25], yaw: 100, pitch: 15 },
      handR: { at: by(62, -0.05, 2.1, -0.02), pole: by(62, -1, 0.2, 0) }, handL: { at: by(62, 0.05, 2.1, -0.02), pole: by(62, 1, 0.2, 0) } })],
    ['hit', liftHit],
    ['hold', K(liftHit, { handR: { at: [-0.04, 1.12, 0.8], pole: [-1, 0.4, 0] }, handL: { at: [0.04, 1.12, 0.8], pole: [1, 0.4, 0] }, spine: [28, 0, 0] })],
    ['r0.45', K(handsOf('FR'), feetOf('FR'), { root: { yaw: 26, up: -0.12 }, spine: [10, 0, 0] })],
  ],
});

const benchHit = K({
  root: { yaw: -12, up: -0.11, fwd: 0.1 }, hips: [4, 0, 0], spine: [12, 0, 0], chest: [4, -4, 0],
  handR: { at: [-0.16, 1.3, 1.02], pole: [-1, -0.6, 0], wrist: WRIST_PALM }, handL: { at: [0.16, 1.3, 1.02], pole: [1, -0.6, 0], wrist: WRIST_PALM },
  footL: { at: [0.07, 0, 0.33], yaw: -10 }, footR: { at: [-0.18, 0, -0.22], yaw: -45, pitch: 20 },
});
export const brick_bench_press = defineMove({
  id: 'brick_bench_press', name: 'Bench Press', desc: 'Two hands, full extension, no spotter.',
  start: 'BR', end: 'FL', weight: 'medium', height: 'mid', path: 'thrust', limb: 'handL', boss: true,
  startup: 0.32, active: 0.08, recovery: 0.4, damage: 14, stamina: 13, reach: 1.7, arc: 70,
  hitstun: 0.5, blockstun: 0.24, push: 1.6, lunge: 0.45, chainIn: 0.12,
  props: { stop: true },
  keys: [
    ['w0.5', K(feetOf('BR'), { root: { yaw: 122, up: -0.13 }, spine: [6, -6, 0], chest: [4, -8, 0],
      handR: { at: by(114, -0.14, 1.28, 0.14), pole: by(114, -0.6, -0.4, -1) }, handL: { at: by(114, 0.14, 1.28, 0.14), pole: by(114, 0.6, -0.4, -1) } })],
    ['w0.8', K({ root: { yaw: 36, up: -0.12, fwd: 0.04 }, spine: [8, 0, 0], chest: [4, 0, 0],
      handR: { at: by(36, -0.14, 1.28, 0.2), pole: by(36, -0.6, -0.4, -1) }, handL: { at: by(36, 0.14, 1.28, 0.2), pole: by(36, 0.6, -0.4, -1) },
      footR: { at: [-0.07, 0, 0.12], yaw: 20, pitch: 10 }, footL: { at: [0.1, 0.17, 0.04] } })],
    ['hit', benchHit],
    ['hold', benchHit],
    ['r0.4', K(handsOf('FL'), feetOf('FL'), { root: { yaw: -22, up: -0.09 } })],
  ],
});

// ------------------------------------------------------------------------------------------------ Mr. Golden (BL, every stance)

const htKick = K({
  root: { yaw: 172, up: -0.02, fwd: -0.04 }, hips: [6, 0, 0], spine: [22, 0, 0], chest: [10, -12, 0],
  footR: { at: [-0.04, 1.05, 1.08], pole: [0, -1, 0.1], ankle: [0, 0, 0] },
  footL: { at: [0.12, 0, -0.24], yaw: 175, pitch: 8 },
  handR: { at: by(172, -0.12, 1.15, 0.3), pole: [0, -1, 0] }, handL: { at: by(172, 0.12, 1.25, 0.3), pole: [0, -1, 0] },
});
const htSweep = K({
  root: { yaw: -100, up: -0.45 }, hips: [10, 0, 0], spine: [22, 0, 0], chest: [8, 0, 0],
  footL: { at: [0.0, 0.1, 1.05], pole: [0, 1, 0], ankle: [-10, 0, 0] },
  footR: { at: [-0.06, 0, -0.18], yaw: -80, pitch: 10 },
  handR: { at: by(-100, -0.3, 0.36, 0.15), pole: by(-100, -1, 0, -0.5) }, handL: { at: by(-100, 0.12, 0.98, 0.32), pole: by(-100, 1, -1, 0) },
});
export const golden_hostile_takeover = defineMove({
  id: 'golden_hostile_takeover', name: 'Hostile Takeover', desc: 'A spinning back kick to open negotiations, a sweep to close them.',
  start: 'BR', end: 'BL', weight: 'heavy', height: 'mid', path: 'horizontal', limb: 'footL', boss: true,
  startup: 0.34, active: 0.42, recovery: 0.42, damage: 22, stamina: 20, reach: 2.0, arc: 120,
  hitstun: 0.55, blockstun: 0.3, push: 1.1, lunge: 0.35, chainIn: 0.13,
  props: { double: true, knockdown: true },
  hits: [{ t: 0.34, dur: 0.06, limb: 'footR', damage: 10, height: 'mid' }, { t: 0.68, dur: 0.08, limb: 'footL', damage: 12, height: 'low' }],
  keys: [
    ['w0.55', K({ root: { yaw: 165, up: -0.06 }, hips: [4, 0, 0], spine: [12, -4, 0], chest: [8, -12, 0],
      footR: { at: by(165, -0.1, 0.55, 0.22), pole: by(165, 0, 0.2, 1), ankle: [0, 0, 0] }, footL: { at: [0.16, 0, -0.26], yaw: 170, pitch: 6 },
      handR: { at: by(165, -0.1, 1.38, 0.25) }, handL: { at: by(165, 0.1, 1.38, 0.22) } })],
    [0.34, htKick, 'snap'],
    [0.4, htKick, 'linear'],
    [0.5, K({ root: { yaw: 118, up: -0.36 }, hips: [12, 0, 0], spine: [20, -6, 0], chest: [8, -8, 0],
      footR: { at: [-0.04, 0, 0.12], yaw: 120, pitch: 6 }, footL: { at: by(118, 0.45, 0.1, -0.2), pole: [0, 1, 0], ankle: [0, 0, 0] },
      handR: { at: by(118, -0.25, 0.42, 0.2), pole: by(118, -1, 0, -0.5) }, handL: { at: by(118, 0.12, 1.05, 0.3) } }), 'out'],
    [0.6, K(htSweep, { root: { yaw: 0, up: -0.46 }, footL: { at: by(0, 0.75, 0.1, 0.45), pole: [0, 1, 0], ankle: [-5, 0, 0] },
      handR: { at: by(0, -0.3, 0.38, 0.15), pole: by(0, -1, 0, -0.5) }, handL: { at: by(0, 0.12, 1.0, 0.32) } }), 'inOut'],
    [0.68, htSweep, 'snap'],
    [0.72, K(htSweep, { root: { yaw: -108, up: -0.45 }, footL: { at: [-0.25, 0.1, 0.98], pole: [0, 1, 0], ankle: [-10, 0, 0] } }), 'linear'],
    [0.76, K(htSweep, { root: { yaw: -120, up: -0.3 }, hips: [6, 0, 0], spine: [14, 0, 0], chest: [6, 0, 0],
      footL: { at: [-0.36, 0.12, 0.8], pole: [0, 1, 0], ankle: [-10, 0, 0] },
      handR: { at: by(-120, -0.22, 0.95, 0.25), pole: by(-120, -1, -0.6, -0.4) }, handL: { at: by(-120, 0.1, 1.2, 0.34) } }), 'out'],
    ['r0.42', K({ root: { yaw: -140, up: -0.18 }, spine: [10, 6, 0], chest: [6, 10, 0],
      footL: { at: [0.06, 0.05, 0.24], yaw: -120 }, footR: { at: [-0.2, 0, -0.26], yaw: -160, pitch: 8 },
      handL: { at: [-0.02, 1.38, 0.25] }, handR: { at: [-0.16, 1.36, 0.02] } }), 'out'],
  ],
});

const shakeHit = K({
  root: { yaw: 30, up: -0.1, fwd: 0.09 }, hips: [2, 6, 0], spine: [8, 6, 0], chest: [6, 12, 0],
  handR: { at: [-0.02, 1.3, 1.04], pole: [-0.8, -1, 0], wrist: WRIST_PALM }, handL: { at: by(30, 0.12, 1.0, -0.24), pole: by(30, 1, 0, -0.4) },
  footR: { at: [-0.05, 0, 0.33], yaw: 15 }, footL: { at: [0.16, 0, -0.22], yaw: 45, pitch: 15 },
});
export const golden_handshake = defineMove({
  id: 'golden_handshake', name: 'Golden Handshake', desc: 'Generous terms. Non-negotiable. Mind the step.',
  start: 'BL', end: 'FR', weight: 'medium', height: 'mid', path: 'thrust', limb: 'handR', boss: true,
  startup: 0.27, active: 0.07, recovery: 0.4, damage: 15, stamina: 12, reach: 1.75, arc: 55,
  hitstun: 0.5, blockstun: 0.24, push: 1.5, lunge: 0.5, chainIn: 0.1,
  props: { stop: true, knockdown: true },
  keys: [
    ['w0.45', K(feetOf('BL'), { root: { yaw: -100, up: -0.07 }, spine: [4, 4, 0], chest: [4, 8, 0],
      handR: { at: [0.02, 1.06, 0.52], pole: [-0.5, -1, 0] }, handL: { at: by(-88, 0.12, 1.0, -0.24), pole: by(-88, 1, 0, -0.4) } })],
    ['w0.8', K({ root: { yaw: -22, up: -0.08, fwd: 0.04 }, spine: [6, 0, 0], chest: [6, 4, 0],
      handR: { at: [-0.1, 1.15, 0.45], pole: [-0.6, -1, 0] }, handL: { at: by(-22, 0.12, 1.0, -0.24), pole: by(-22, 1, 0, -0.4) },
      footL: { at: [0.08, 0, 0.12], yaw: -20, pitch: 10 }, footR: { at: [-0.08, 0.12, 0.02] } })],
    ['hit', shakeHit],
    ['hold', shakeHit],
    ['r0.4', K(handsOf('FR'), feetOf('FR'), { root: { yaw: 26, up: -0.08 } })],
  ],
});

// ------------------------------------------------------------------------------------------------ focus attacks

const swHit = K({
  root: { yaw: 42, up: -0.15, fwd: 0.1 }, hips: [2, 6, 0], spine: [6, 6, 0], chest: [6, 12, 0],
  handR: { at: [-0.02, 1.26, 1.04], pole: [-0.8, -1, 0], wrist: WRIST_PALM }, handL: { at: [0.22, 1.02, -0.06], pole: [0.4, -0.3, -1] },
  footR: { at: [-0.05, 0, 0.4], yaw: 15 }, footL: { at: [0.19, 0, -0.25], yaw: 50, pitch: 8 },
});
export const focus_still_water = defineMove({
  id: 'focus_still_water', name: 'Still Water', desc: 'Focus strike. Nothing moves, then everything stops.',
  start: 'FR', end: 'FR', weight: 'medium', height: 'mid', path: 'thrust', limb: 'handR', focus: true,
  startup: 0.16, active: 0.06, recovery: 0.3, damage: 10, stamina: 0, guardDamage: 0, reach: 1.9, arc: 70,
  hitstun: 1.1, blockstun: 0.2, push: 0.5, lunge: 0.5, chainIn: 0.06, learn: 0,
  props: { stop: true },
  keys: [
    ['w0.5', K(feetOf('FR'), { root: { yaw: 14, up: -0.17 }, spine: [6, -4, 0], chest: [6, -8, 0],
      handR: { at: [-0.16, 1.2, 0.08], pole: [-0.5, -0.4, -1] }, handL: { at: [0.06, 1.38, 0.42], pole: [0.6, -1, 0] } })],
    ['hit', swHit],
    ['hold', swHit],
    ['r0.4', K(handsOf('FR'), feetOf('FR'), { root: { yaw: 30, up: -0.1 } })],
  ],
});

const upHit = K({
  root: { yaw: -40, up: -0.45 }, hips: [10, 0, 0], spine: [22, 0, 0], chest: [8, 0, 0],
  footL: { at: [0.0, 0.1, 1.05], pole: [0, 1, 0], ankle: [-10, 0, 0] },
  footR: { at: [-0.2, 0, 0.0], yaw: -20, pitch: 10 },
  handR: { at: [-0.34, 0.36, 0.12], pole: [-1, 0, -0.5] }, handL: { at: [0.12, 0.98, 0.32], pole: [1, -1, 0] },
});
export const focus_uprooting = defineMove({
  id: 'focus_uprooting', name: 'Uprooting', desc: 'Focus sweep. The floor and the opponent are introduced.',
  start: 'FR', end: 'FL', weight: 'heavy', height: 'low', path: 'horizontal', limb: 'footL', focus: true,
  startup: 0.24, active: 0.08, recovery: 0.42, damage: 14, stamina: 0, guardDamage: 0, reach: 2.0, arc: 160,
  hitstun: 0.6, blockstun: 0.3, push: 0.8, lunge: 0.3, chainIn: 0.09, learn: 0,
  props: { knockdown: true },
  keys: [
    ['w0.5', K({ root: { yaw: 30, up: -0.42 }, hips: [10, 0, 0], spine: [22, 4, 0], chest: [8, 4, 0],
      footR: { at: [-0.12, 0, 0.18], yaw: 20 }, footL: { at: [0.5, 0.1, -0.2], pole: [0, 1, 0], ankle: [0, 0, 0] },
      handR: { at: [-0.3, 0.38, 0.2], pole: [-1, 0, -0.5] }, handL: { at: [0.1, 1.0, 0.32] } })],
    ['hit', upHit],
    ['h0.4', K(upHit, { root: { yaw: -48, up: -0.45 }, footL: { at: [0.25, 0.1, 0.98], pole: [0, 1, 0], ankle: [-10, 0, 0] } }), 'linear'],
    ['hold', K(upHit, { root: { yaw: -40, up: -0.3 }, hips: [6, 0, 0], spine: [14, 0, 0], chest: [6, 0, 0],
      footL: { at: [0.36, 0.12, 0.8], pole: [0, 1, 0], ankle: [-10, 0, 0] }, footR: { at: [-0.2, 0, -0.06], yaw: -40, pitch: 8 },
      handR: { at: [-0.22, 0.95, 0.25], pole: [-1, -0.6, -0.4] }, handL: { at: [0.1, 1.2, 0.34], pole: [1, -1, 0] } }), 'out'],
    ['r0.45', K(handsOf('FL'), { root: { yaw: -26, up: -0.2 }, spine: [10, 0, 0],
      footL: { at: [0.06, 0.04, 0.34], yaw: -10 }, footR: { at: [-0.18, 0, -0.22], yaw: -50, pitch: 8 } })],
  ],
});
export const focus_still_water_l = mirrorMove(focus_still_water, { id: 'focus_still_water_l' });
export const focus_uprooting_l = mirrorMove(focus_uprooting, { id: 'focus_uprooting_l' });

export const BOSS_MOVE_LIST = [
  tadao_compound_interest, tadao_late_fee, shu_wok_toss, shu_last_order,
  brick_deadlift, brick_bench_press, golden_hostile_takeover, golden_handshake,
];
export const FOCUS_MOVE_LIST = [focus_still_water, focus_uprooting, focus_still_water_l, focus_uprooting_l];
/** Which boss owns each signature move. */
export const BOSS_OWNER = {
  tadao_compound_interest: 'tadao', tadao_late_fee: 'tadao', shu_wok_toss: 'madame_shu', shu_last_order: 'madame_shu',
  brick_deadlift: 'brick', brick_bench_press: 'brick', golden_hostile_takeover: 'mr_golden', golden_handshake: 'mr_golden',
};
