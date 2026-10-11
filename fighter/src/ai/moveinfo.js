// AI-side view of the move library (FIGHTER.md §6): a cached, normalised timing / threat summary per move, and deck
// lookups. Pure (no THREE, no game), so the planner can be unit-tested in node. Reads the MOVES agent's exports
// defensively: the library may still be a stub, or a deck slot may name a move that does not exist yet.
import * as MV from '../combat/moves/index.js';

const STANCE_IDS = ['FR', 'FL', 'BR', 'BL'];
const CACHE = new WeakMap();
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/** The move table (id -> move); never null. */
export function movesTable() { return (MV && MV.MOVES) || {}; }
/** Named enemy decks (may be empty). */
export function enemyDecks() { return (MV && MV.ENEMY_DECKS) || {}; }
/** Optional phase-2 boss decks (may be empty). */
export function phase2Decks() { return (MV && MV.BOSS_PHASE2_DECKS) || {}; }

/** Move by id or object (null when unknown). */
export function moveById(id) {
  if (!id) return null;
  if (typeof id === 'object') return id;
  return movesTable()[id] || null;
}

/** A generic stand-in used when a slot names no known move (the combat module then plays its own fallback). */
const GENERIC = {};
function genericInfo(stance, kind) {
  const key = stance + kind;
  if (GENERIC[key]) return GENERIC[key];
  const heavy = kind === 'heavy';
  GENERIC[key] = {
    id: 'generic_' + key, move: null, start: stance, end: stance, weight: heavy ? 'medium' : 'light',
    height: heavy ? 'mid' : 'high', path: 'thrust', limb: 'handR', startup: heavy ? 0.3 : 0.18,
    firstHit: heavy ? 0.3 : 0.18, lastEnd: heavy ? 0.38 : 0.24, duration: heavy ? 0.74 : 0.5, cancel: heavy ? 0.42 : 0.3,
    chainIn: heavy ? 0.12 : 0.07, holdOut: 0.05, reach: heavy ? 1.9 : 1.6, arcHalf: 0.5, lunge: 0.3,
    damage: heavy ? 12 : 7, stamina: heavy ? 14 : 8, hits: 1, props: {}, brk: false, stop: false, knockdown: false,
    charge: false, duck: false, jump: false, strafe: false, signature: false, focus: false,
  };
  return GENERIC[key];
}

/**
 * Normalised info for a move object (cached): timing (firstHit, lastEnd, chainIn...), threat shape (reach, arcHalf,
 * height, path, limb) and properties as booleans. Mirrors combat/movedata.js closely enough for AI decisions.
 */
export function info(m) {
  if (!m || typeof m !== 'object') return null;
  let i = CACHE.get(m);
  if (i) return i;
  const startup = Math.max(0.03, num(m.startup, 0.22));
  const active = Math.max(0.02, num(m.active, 0.07));
  const recovery = Math.max(0, num(m.recovery, 0.3));
  const keys = Array.isArray(m.keys) ? m.keys : null;
  const keysEnd = keys && keys.length ? num(keys[keys.length - 1].t, 0) : 0;
  const duration = Math.max(startup + active + recovery, keysEnd, num(m.duration, 0));
  let firstHit = startup, lastEnd = startup + active, hits = 1;
  if (Array.isArray(m.hits) && m.hits.length) {
    firstHit = Infinity; lastEnd = 0; hits = m.hits.length;
    for (const h of m.hits) {
      const t = Math.max(0.02, num(h.t, startup));
      const e = t + Math.max(0.02, num(h.dur, active));
      if (t < firstHit) firstHit = t;
      if (e > lastEnd) lastEnd = e;
    }
  }
  const props = m.props || {};
  const chainRaw = num(m.chainIn, startup * 0.4);
  i = {
    id: m.id || 'move', move: m, start: STANCE_IDS.includes(m.start) ? m.start : 'FR',
    end: STANCE_IDS.includes(m.end) ? m.end : (STANCE_IDS.includes(m.start) ? m.start : 'FR'),
    weight: m.weight || 'light', height: m.height || 'mid', path: m.path || 'horizontal', limb: m.limb || 'handR',
    startup, firstHit, lastEnd: Math.min(lastEnd, duration), duration,
    cancel: Math.min(duration, num(m.cancel, lastEnd + 0.04)),
    chainIn: Math.max(0, Math.min(chainRaw, firstHit - 0.06)),
    holdOut: Math.max(0.02, Math.min(0.12, num(m.holdOut, 0.05))),
    reach: Math.max(0.6, num(m.reach, 1.6)), arcHalf: (Math.max(10, num(m.arc, 70)) * Math.PI) / 360,
    lunge: Math.max(0, num(m.lunge, 0.3)),
    damage: num(m.damage, 8), stamina: Math.max(0, num(m.stamina, 8)), hits, props,
    brk: !!props.break, stop: !!props.stop, knockdown: !!props.knockdown, charge: !!props.charge,
    duck: !!props.duck, jump: !!props.jump, strafe: !!props.strafe,
    signature: !!m.boss, focus: !!m.focus,
  };
  CACHE.set(m, i);
  return i;
}

/** Info of the move a deck plays from `stance` for 'light' (main) / 'heavy' (alt); falls back like combat does. */
export function deckInfo(deck, stance, kind) {
  const slot = deck && deck[stance];
  if (slot) {
    const m = moveById(kind === 'heavy' ? slot.alt : slot.main) || moveById(kind === 'heavy' ? slot.main : slot.alt);
    if (m) return info(m);
  }
  return genericInfo(STANCE_IDS.includes(stance) ? stance : 'FR', kind);
}

/** Which stance / slot of `deck` holds move `id` ({ stance, kind } or null). */
export function findInDeck(deck, id) {
  if (!deck || !id) return null;
  for (const st of STANCE_IDS) {
    const s = deck[st];
    if (!s) continue;
    if (s.main === id) return { stance: st, kind: 'light' };
    if (s.alt === id) return { stance: st, kind: 'heavy' };
  }
  return null;
}

/** Ids of the signature (boss: true) moves in a deck. */
export function signaturesOf(deck) {
  const out = [];
  if (!deck) return out;
  for (const st of STANCE_IDS) {
    const s = deck[st];
    if (!s) continue;
    for (const id of [s.main, s.alt]) { const m = moveById(id); if (m && m.boss && !out.includes(id)) out.push(id); }
  }
  return out;
}

/** Longest reach among the moves of a deck (spacing for circling / punishes). */
export function deckReach(deck) {
  let r = 0;
  for (const st of STANCE_IDS) for (const k of ['light', 'heavy']) r = Math.max(r, deckInfo(deck, st, k).reach);
  return r || 1.6;
}

export { STANCE_IDS };
