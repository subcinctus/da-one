// LAST STANCE move library (FIGHTER.md §6 / §6b).
//   MOVES          id -> move (player library + boss signatures + focus attacks)
//   STARTER_DECK   the player's first deck (main attacks loop FR -> BR -> FL -> BL)
//   STARTER_EXTRA  moves a new run has learned but not equipped (one per stance; consumers fall back to [])
//   ENEMY_DECKS    thug, brawler, swift, heavy, tadao, madame_shu, brick, mr_golden
//   FOCUS_MOVES    { strike, sweep } (right-lead ids; focusMoveFor(kind, stance) picks the side)
//   COMBO_ROUTES   named showcase strings for the UI
// Every move: first key 'stance:<start>' at 0, last key 'stance:<end>' at duration; chainIn / holdOut drive the
// Sloclap-style chaining (hold the strike form, skip the recovery, enter the next move mid wind-up with a 0.06 s blend).
import { getPose } from '../../anim/rig.js';
import { FRONT_MOVES } from './lib-front.js';
import { BACK_MOVES } from './lib-back.js';
import { BOSS_MOVE_LIST, FOCUS_MOVE_LIST, BOSS_OWNER } from './lib-boss.js';
import { REFERENCE_STANCES, STANCE_YAW, registerReferenceStances } from './stances-ref.js';
import { CHAIN_BLEND, HOLD_OUT } from './define.js';
import { STARTER_DECK, STARTER_EXTRA, ENEMY_DECKS, BOSS_PHASE2_DECKS, COMBO_ROUTES, routeInputs } from './decks.js';
import { attachMoves } from './debug.js';

export { CHAIN_BLEND, HOLD_OUT, STARTER_DECK, STARTER_EXTRA, ENEMY_DECKS, BOSS_PHASE2_DECKS, COMBO_ROUTES, BOSS_OWNER, REFERENCE_STANCES, STANCE_YAW, registerReferenceStances };

/** Focus attacks (FIGHTER.md §7): strike = unblockable fast stun, sweep = knockdown. */
export const FOCUS_MOVES = { strike: 'focus_still_water', sweep: 'focus_uprooting' };
const FOCUS_LEFT = { strike: 'focus_still_water_l', sweep: 'focus_uprooting_l' };
/** Focus move id for a stance: left-lead stances (FL/BL) use the mirrored variant so the blend stays short. */
export const focusMoveFor = (kind, stance) => ((stance === 'FL' || stance === 'BL') ? FOCUS_LEFT[kind] : FOCUS_MOVES[kind]) || FOCUS_MOVES.strike;

// ------------------------------------------------------------------------------------------------ root calibration
// The keys between the stance ends were authored against REFERENCE_STANCES. If the registered 'stance:*' poses use
// a slightly different root (yaw / crouch / offset), the in-between keys are shifted by a linearly interpolated root
// delta so the wind-up leaves the real start stance and the recovery lands on the real end stance with no pop.
// Lazy and cached per (start pose, end pose) object: one Map lookup per sample, no per-frame allocation.
const ROOT_KEYS = ['fwd', 'right', 'up', 'yaw'];
const rootDelta = (st) => {
  const reg = getPose('stance:' + st);
  const ref = REFERENCE_STANCES[st];
  if (!reg || !ref || reg === ref) return null;
  const a = reg.root || {}, b = ref.root || {};
  const d = ROOT_KEYS.map((k) => (a[k] || 0) - (b[k] || 0));
  return d.some((v) => Math.abs(v) > 1e-4) ? d : null;
};
function calibrated(m) {
  const c = m._cal;
  if (c.sn === undefined || c.st !== m.start || c.et !== m.end) { c.st = m.start; c.et = m.end; c.sn = 'stance:' + m.start; c.en = 'stance:' + m.end; }
  const s = getPose(c.sn), e = getPose(c.en);
  if (c.s === s && c.e === e) return c.keys;
  c.s = s; c.e = e;
  const ds = rootDelta(m.start), de = rootDelta(m.end);
  if (!ds && !de) { c.keys = c.ref; return c.keys; }
  const z = [0, 0, 0, 0], a = ds || z, b = de || z, dur = m.duration || 1;
  c.keys = c.ref.map((k) => {
    if (typeof k.pose === 'string') return k;
    const f = Math.min(1, Math.max(0, k.t / dur));
    const r = k.pose.root || {};
    const root = {};
    ROOT_KEYS.forEach((name, i) => { root[name] = (r[name] || 0) + a[i] + (b[i] - a[i]) * f; });
    return { ...k, pose: { ...k.pose, root } };
  });
  return c.keys;
}

function finalize(m) {
  const ref = m.keys;
  delete m.keys;
  Object.defineProperty(m, '_cal', { value: { ref, keys: ref, s: undefined, e: undefined }, enumerable: false, writable: true });
  Object.defineProperty(m, 'keys', { get() { return calibrated(this); }, set(v) { this._cal = { ref: v, keys: v, s: undefined, e: undefined }; }, enumerable: true, configurable: true });
  Object.defineProperty(m, 'authoredKeys', { get() { return this._cal.ref; }, enumerable: false });
  return m;
}

const ALL = [...FRONT_MOVES, ...BACK_MOVES, ...BOSS_MOVE_LIST, ...FOCUS_MOVE_LIST].map(finalize);

/** Every move by id. */
export const MOVES = Object.fromEntries(ALL.map((m) => [m.id, m]));
/** Learnable player moves (excludes boss signatures and focus attacks), grouped order FR, FL, BR, BL. */
export const PLAYER_MOVE_IDS = ALL.filter((m) => !m.boss && !m.focus).map((m) => m.id);
/** Boss signature move ids. */
export const BOSS_MOVE_IDS = BOSS_MOVE_LIST.map((m) => m.id);

/** Move by id (null when unknown). */
export const getMove = (id) => MOVES[id] || null;
/** Player-library moves starting in `stance` (optionally including boss / focus moves). */
export function movesFrom(stance, { boss = false, focus = false } = {}) {
  return ALL.filter((m) => m.start === stance && (boss || !m.boss) && (focus || !m.focus));
}
/** True when a player may learn / slot this move. */
export const isLearnable = (id) => !!MOVES[id] && !MOVES[id].boss && !MOVES[id].focus;
/** Total track length (startup + active + recovery). */
export const moveDuration = (m) => (m ? m.duration : 0);
/** End of the move's last hit window: where the strike form is frozen for `holdOut` when chaining (§6b). */
export const lastActiveEnd = (m) => (m ? m.hits.reduce((t, h) => Math.max(t, h.t + h.dur), 0) : 0);
/** Time of the first hit (the move's real strike moment). */
export const firstHitTime = (m) => (m ? m.hits[0].t : 0);

/**
 * Chain timing for prev -> next (§6b): hold prev's strike pose from `holdFrom` for `hold` s, then play `next`
 * from `startAt` blending over `blend`; `strikeIn` = seconds from the start of the blend to next's first hit.
 */
export function chainTiming(prev, next) {
  const startAt = next ? next.chainIn : 0;
  return {
    holdFrom: lastActiveEnd(prev), hold: prev ? prev.holdOut : HOLD_OUT.light,
    startAt, blend: CHAIN_BLEND, strikeIn: next ? firstHitTime(next) - startAt : 0,
  };
}

/** Sanitise a deck: unknown ids or slots whose move starts in another stance fall back to `fallback`'s slot. */
export function validateDeck(deck, fallback = STARTER_DECK) {
  const out = {};
  for (const st of ['FR', 'FL', 'BR', 'BL']) {
    out[st] = {};
    for (const slot of ['main', 'alt']) {
      const id = deck?.[st]?.[slot];
      out[st][slot] = MOVES[id] && MOVES[id].start === st ? id : fallback?.[st]?.[slot] ?? null;
    }
  }
  return out;
}

/** UI helper: which button plays each step of a COMBO_ROUTE with `deck` ('main' | 'alt' | null). */
export const comboRouteInputs = (route, deck) => routeInputs(route, deck, MOVES);

attachMoves({ MOVES, STARTER_DECK, ENEMY_DECKS, FOCUS_MOVES, COMBO_ROUTES, CHAIN_BLEND });

export { installMovesDebug, movePreview, previewTimes } from './debug.js';
export { validateLibrary, stanceGraph } from './validate.js';
