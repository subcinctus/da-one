// Move access + normalisation. Reads the MOVES agent's library defensively (it may still be a stub) and derives the
// runtime timing data Combat needs (hit windows, chain point, chainIn / holdOut per FIGHTER.md §6b). Never mutates the
// library: derived data is cached per move object. Missing moves fall back to a built-in jab / kick per stance so the
// game always stays playable.
import * as MV from './moves/index.js';
import { mergePoses } from '../anim/rig.js';
import { STANCES } from '../data/stances.js';
import { T } from './constants.js';

/** Read an export of the moves module by name (tolerates a stub that does not export it yet). */
function mv(name) { return MV ? MV[name] : undefined; }
const EMPTY_DECK = { FR: { main: null, alt: null }, FL: { main: null, alt: null }, BR: { main: null, alt: null }, BL: { main: null, alt: null } };

/** The move library (object id -> move). Never null. */
export function movesTable() { return mv('MOVES') || {}; }
/** Starter deck (or an empty deck that resolves to fallbacks). */
export function starterDeck() { return mv('STARTER_DECK') || EMPTY_DECK; }
/** Named enemy deck, or null. */
export function enemyDeck(name) { const d = mv('ENEMY_DECKS'); return (d && name && d[name]) || null; }
/** True when `id` is a real library move (not a built-in fallback). */
export function isLibraryMove(id) { return !!(id && movesTable()[id]); }

/** Look a move up by id (library first, then built-in fallbacks). */
export function getMove(id) {
  if (!id) return null;
  if (typeof id === 'object') return id.keys ? id : null;
  return movesTable()[id] || FALLBACK_BY_ID.get(id) || null;
}

/** The move in `deck[stance][main|alt]` ('light' -> main, 'heavy' -> alt). Falls back to a built-in move. */
export function slotMove(deck, stance, kind) {
  const slot = deck && deck[stance];
  const id = slot ? (kind === 'heavy' ? slot.alt : slot.main) : null;
  const m = getMove(id);
  if (m && m.keys && m.keys.length) return m;
  // alternate empty -> try main, and vice versa, before the built-in fallback
  const other = getMove(slot ? (kind === 'heavy' ? slot.main : slot.alt) : null);
  if (other && other.keys && other.keys.length) return other;
  return fallbackMove(stance, kind);
}

/** Focus move ('strike' | 'sweep') from FOCUS_MOVES, or a built-in fallback. */
export function focusMove(kind, stance) {
  const pickFn = mv('focusMoveFor');   // the library picks the left / right-lead variant for the stance
  let id = null;
  try { id = typeof pickFn === 'function' ? pickFn(kind, stance) : null; } catch (e) { id = null; }
  if (!id) { const f = mv('FOCUS_MOVES'); id = f && f[kind]; }
  const m = getMove(id);
  if (m && m.keys && m.keys.length) return m;
  return fallbackFocus(kind, stance || 'FR');
}

// ------------------------------------------------------------------------------------------------ normalisation

const INFO = new WeakMap();
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * Runtime timing for a move (cached). Fields: move, id, start, end, weight, height, path, limb, startup, active,
 * recovery, duration, hits [{t, dur, end, limb, damage}], firstStart, lastEnd, cancel, chainIn, holdOut, damage,
 * stamina, guardDamage, reach, arcHalf (rad), hitstun, blockstun, push, lunge, props, learn, boss.
 */
export function moveInfo(m) {
  let info = INFO.get(m);
  if (info) return info;
  const startup = Math.max(0.03, num(m.startup, 0.22));
  const active = Math.max(0.02, num(m.active, 0.07));
  const recovery = Math.max(0, num(m.recovery, 0.3));
  const keys = m.keys || [];
  const keysEnd = keys.length ? num(keys[keys.length - 1].t, 0) : 0;
  const duration = Math.max(startup + active + recovery, keysEnd, num(m.duration, 0));
  const damage = num(m.damage, 8);
  const limb = m.limb || 'handR';
  const hits = [];
  if (Array.isArray(m.hits) && m.hits.length) {
    for (const h of m.hits) {
      const t = Math.max(0.02, num(h.t, startup));
      const dur = Math.max(0.02, num(h.dur, active));
      hits.push({ t, dur, end: t + dur, limb: h.limb || limb, damage: num(h.damage, damage) });
    }
    hits.sort((a, b) => a.t - b.t);
  } else {
    hits.push({ t: startup, dur: active, end: startup + active, limb, damage });
  }
  const firstStart = hits[0].t;
  let lastEnd = 0;
  for (const h of hits) lastEnd = Math.max(lastEnd, h.end);
  const chainInRaw = num(m.chainIn, startup * 0.4);
  info = {
    move: m, id: m.id || 'move', name: m.name || m.id || 'Move',
    start: m.start || 'FR', end: m.end || m.start || 'FR',
    weight: m.weight || 'light', height: m.height || 'mid', path: m.path || 'horizontal', limb,
    startup, active, recovery, duration, hits, firstStart, lastEnd: Math.min(lastEnd, duration),
    cancel: Math.min(duration, num(m.cancel, lastEnd + 0.04)),
    // a chained move always keeps a little wind-up so the follow-up is readable, never a teleport
    chainIn: Math.max(0, Math.min(chainInRaw, firstStart - T.CHAIN_MIN_LEAD)),
    holdOut: Math.max(0.02, Math.min(0.12, num(m.holdOut, T.HOLD_OUT))),
    damage, stamina: Math.max(0, num(m.stamina, 8)), guardDamage: Math.max(0, num(m.guardDamage, damage * 1.4)),
    reach: Math.max(0.6, num(m.reach, 1.6)), arcHalf: (Math.max(10, num(m.arc, 70)) * Math.PI) / 360,
    hitstun: Math.max(0.05, num(m.hitstun, 0.3)), blockstun: Math.max(0.04, num(m.blockstun, 0.15)),
    push: Math.max(0, num(m.push, 0.3)), lunge: Math.max(0, num(m.lunge, 0.3)),
    props: m.props || {}, learn: num(m.learn, 0), boss: !!m.boss,
  };
  INFO.set(m, info);
  return info;
}

/** Index of the active hit window at move time t, or -1. */
export function activeWindow(info, t) {
  const hs = info.hits;
  for (let i = 0; i < hs.length; i++) if (t >= hs[i].t && t < hs[i].end) return i;
  return -1;
}

// ------------------------------------------------------------------------------------------------ built-in fallbacks

// main attacks loop through all four stances; alternates branch across
const FB_NEXT_LIGHT = { FR: 'FL', FL: 'BL', BL: 'BR', BR: 'FR' };
const FB_NEXT_HEAVY = { FR: 'BR', FL: 'FR', BL: 'FL', BR: 'BL' };
const FALLBACK_BY_ID = new Map();

function strikeTrack(start, end, timing, windup, strike) {
  const { startup, active, recovery } = timing;
  const dur = startup + active + recovery;
  return [
    { t: 0, pose: 'stance:' + start },
    { t: startup * 0.6, pose: mergePoses('stance:' + start, windup), ease: 'out' },
    { t: startup, pose: mergePoses('stance:' + start, strike), ease: 'snap' },
    { t: startup + active, pose: mergePoses('stance:' + start, strike), ease: 'linear' },
    { t: dur, pose: 'stance:' + end, ease: 'inOut' },
  ];
}

/** Built-in minimal attacks (used only when the deck slot / library is empty). */
export function fallbackMove(stance, kind) {
  const st = STANCES.includes(stance) ? stance : 'FR';
  const id = `fb_${kind === 'heavy' ? 'kick' : 'jab'}_${st}`;
  let m = FALLBACK_BY_ID.get(id);
  if (m) return m;
  const leadR = st.endsWith('R');
  const s = leadR ? 'R' : 'L';
  const sgn = leadR ? 1 : -1;
  if (kind === 'heavy') {
    const timing = { startup: 0.3, active: 0.08, recovery: 0.36 };
    const end = FB_NEXT_HEAVY[st];
    m = {
      id, name: 'Push Kick', desc: 'A plain push kick. It gets the job done.', start: st, end,
      weight: 'medium', height: 'mid', path: 'thrust', limb: 'foot' + s,
      ...timing, cancel: 0.42, damage: 12, stamina: 14, guardDamage: 18, reach: 1.9, arc: 50,
      hitstun: 0.42, blockstun: 0.2, push: 0.6, lunge: 0.35, chainIn: 0.12, holdOut: 0.05, props: {}, learn: 0,
      keys: strikeTrack(st, end, timing,
        { ['thigh' + s]: [-70, 0, 0], ['knee' + s]: [110, 0, 0], spine: [-6, 0, 0], ['shoulder' + s]: [-30, 0, 20 * sgn] },
        { ['thigh' + s]: [-92, 0, 0], ['knee' + s]: [8, 0, 0], ['ankle' + s]: [-20, 0, 0], spine: [-14, 0, 0], root: { fwd: 0.12 } }),
    };
  } else {
    const timing = { startup: 0.18, active: 0.06, recovery: 0.26 };
    const end = FB_NEXT_LIGHT[st];
    m = {
      id, name: 'Jab', desc: 'The first thing anyone learns. Still works.', start: st, end,
      weight: 'light', height: 'high', path: 'thrust', limb: 'hand' + s,
      ...timing, cancel: 0.3, damage: 7, stamina: 8, guardDamage: 10, reach: 1.6, arc: 60,
      hitstun: 0.32, blockstun: 0.14, push: 0.25, lunge: 0.3, chainIn: 0.07, holdOut: 0.05, props: {}, learn: 0,
      keys: strikeTrack(st, end, timing,
        { chest: [4, -10 * sgn, 0], ['shoulder' + s]: [-40, 0, 10 * sgn], ['elbow' + s]: [-120, 0, 0] },
        { chest: [6, 22 * sgn, 0], ['shoulder' + s]: [-88, 0, -6 * sgn], ['elbow' + s]: [-6, 0, 0], root: { fwd: 0.14 } }),
    };
  }
  m.duration = m.startup + m.active + m.recovery;
  FALLBACK_BY_ID.set(id, m);
  return m;
}

/** Built-in focus moves: an unblockable palm strike and a low sweep. */
export function fallbackFocus(kind, stance) {
  const st = STANCES.includes(stance) ? stance : 'FR';
  const id = `fb_focus_${kind}_${st}`;
  let m = FALLBACK_BY_ID.get(id);
  if (m) return m;
  if (kind === 'sweep') {
    const timing = { startup: 0.24, active: 0.1, recovery: 0.4 };
    m = {
      id, name: 'Focus Sweep', desc: 'Everything ends on the floor eventually.', start: st, end: st,
      weight: 'heavy', height: 'low', path: 'horizontal', limb: 'footR',
      ...timing, cancel: 0.5, damage: 16, stamina: 0, guardDamage: 30, reach: 2.0, arc: 160,
      hitstun: 0.6, blockstun: 0.3, push: 0.8, lunge: 0.4, props: { knockdown: true }, learn: 0,
      keys: strikeTrack(st, st, timing,
        { root: { up: -0.25 }, thighL: [-60, 0, 10], kneeL: [120, 0, 0], thighR: [-20, 0, -30], kneeR: [60, 0, 0], spine: [20, 0, 0] },
        { root: { up: -0.42, yaw: -40 }, thighL: [-80, 0, 10], kneeL: [140, 0, 0], thighR: [-30, 40, -75], kneeR: [5, 0, 0], spine: [25, -30, 0] }),
    };
  } else {
    const timing = { startup: 0.12, active: 0.07, recovery: 0.3 };
    m = {
      id, name: 'Focus Strike', desc: 'A palm to the sternum that ends arguments.', start: st, end: st,
      weight: 'heavy', height: 'mid', path: 'thrust', limb: 'handR',
      ...timing, cancel: 0.3, damage: 14, stamina: 0, guardDamage: 0, reach: 1.9, arc: 70,
      hitstun: 1.1, blockstun: 0.3, push: 0.9, lunge: 0.6, props: { stop: true }, learn: 0,
      keys: strikeTrack(st, st, timing,
        { chest: [0, -25, 0], shoulderR: [10, 0, -20], elbowR: [-130, 0, 0], root: { fwd: -0.05 } },
        { chest: [10, 30, 0], shoulderR: [-85, 0, 0], elbowR: [0, 0, 0], wristR: [-60, 0, 0], root: { fwd: 0.25 } }),
    };
  }
  m.duration = m.startup + m.active + m.recovery;
  FALLBACK_BY_ID.set(id, m);
  return m;
}
