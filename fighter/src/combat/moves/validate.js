// Library validation: schema, frame data, combo-flow graph, decks and pose QA (forward kinematics at key times).
// Pure; used by the node test (.smoke/moves/validate.mjs) and game.debug.validateMoves(). Returns a list of issues.
import * as THREE from 'three';
import { createSkeleton, PoseBuffer, sampleTrack, strikePointWorld, STRIKE_POINTS } from '../../anim/rig.js';
import { STANCE_YAW, REFERENCE_STANCES } from './stances-ref.js';

const STANCES = ['FR', 'FL', 'BR', 'BL'];
const ENUM = {
  weight: ['light', 'medium', 'heavy'], height: ['high', 'mid', 'low'], path: ['horizontal', 'vertical', 'thrust'],
};
const PROPS = ['break', 'stop', 'double', 'charge', 'duck', 'jump', 'strafe', 'knockdown'];
const STARTUP = { light: [0.14, 0.22], medium: [0.24, 0.32], heavy: [0.34, 0.5] };
const NUM_FIELDS = ['startup', 'active', 'recovery', 'cancel', 'damage', 'stamina', 'guardDamage', 'reach', 'arc', 'hitstun',
  'blockstun', 'push', 'lunge', 'chainIn', 'holdOut', 'duration'];
const EPS = 1e-6;

/** Stance graph: from each stance, the set of stances reachable in one move. */
export function stanceGraph(moves) {
  const g = Object.fromEntries(STANCES.map((s) => [s, new Set()]));
  for (const m of moves) g[m.start]?.add(m.end);
  return g;
}

/** Validate the whole library. opts: { MOVES, STARTER_DECK, ENEMY_DECKS, FOCUS_MOVES, COMBO_ROUTES, poseQA } */
export function validateLibrary(opts) {
  const { MOVES, STARTER_DECK, ENEMY_DECKS, FOCUS_MOVES, COMBO_ROUTES, poseQA = true } = opts;
  const issues = [];
  const bad = (id, msg) => issues.push(`${id}: ${msg}`);
  const all = Object.values(MOVES);
  const player = all.filter((m) => !m.boss && !m.focus);

  for (const m of all) {
    const id = m.id;
    if (MOVES[id] !== m) bad(id, 'id does not match its key');
    for (const f of ['name', 'desc', 'start', 'end', 'weight', 'height', 'path', 'limb']) if (typeof m[f] !== 'string' || !m[f]) bad(id, `missing ${f}`);
    for (const f of NUM_FIELDS) if (typeof m[f] !== 'number' || !Number.isFinite(m[f])) bad(id, `missing number ${f}`);
    if (!STANCES.includes(m.start) || !STANCES.includes(m.end)) bad(id, 'bad stance');
    for (const k of Object.keys(ENUM)) if (!ENUM[k].includes(m[k])) bad(id, `bad ${k} ${m[k]}`);
    if (!STRIKE_POINTS[m.limb]) bad(id, `bad limb ${m.limb}`);
    if (typeof m.props !== 'object') bad(id, 'props missing');
    for (const p of Object.keys(m.props || {})) if (!PROPS.includes(p)) bad(id, `unknown prop ${p}`);
    if (typeof m.boss !== 'boolean') bad(id, 'boss flag missing');
    if (typeof m.learn !== 'number') bad(id, 'learn missing');
    const dur = m.startup + m.active + m.recovery;
    if (Math.abs(dur - m.duration) > 1e-3) bad(id, 'duration != startup+active+recovery');
    if (m.cancel < m.startup + m.active - EPS) bad(id, `cancel ${m.cancel} < startup+active`);
    if (m.cancel > dur) bad(id, 'cancel after the end');
    if (!(m.chainIn > 0 && m.chainIn < m.startup)) bad(id, `chainIn ${m.chainIn} not in (0, startup)`);
    if (!(m.holdOut >= 0.03 && m.holdOut <= 0.09)) bad(id, `holdOut ${m.holdOut} not in [0.03, 0.09]`);
    if (!m.focus) {
      const [lo, hi] = STARTUP[m.weight] || [0, 9];
      if (m.startup < lo - EPS || m.startup > hi + EPS) bad(id, `startup ${m.startup} outside ${m.weight} range`);
      if (m.damage < 5 || m.damage > 22) bad(id, `damage ${m.damage}`);
      if (m.stamina < 6 || m.stamina > 20) bad(id, `stamina ${m.stamina}`);
      if (m.reach < 1.3 || m.reach > 2.4) bad(id, `reach ${m.reach}`);
      if (m.weight === 'heavy' && m.recovery < 0.42) bad(id, 'heavy recovery too short to punish');
    }
    // hits
    if (!Array.isArray(m.hits) || !m.hits.length) bad(id, 'no hits');
    else {
      if (Math.abs(m.hits[0].t - m.startup) > 1e-3) bad(id, 'first hit is not at startup');
      const last = m.hits.reduce((t, h) => Math.max(t, h.t + h.dur), 0);
      if (last > m.startup + m.active + 1e-3) bad(id, 'hit window beyond startup+active');
      for (const h of m.hits) {
        if (h.t < 0 || h.t + h.dur > dur + EPS) bad(id, 'hit outside duration');
        if (!STRIKE_POINTS[h.limb]) bad(id, `bad hit limb ${h.limb}`);
      }
      if (m.props?.double && m.hits.length < 2) bad(id, 'double without two hits');
      if (!m.props?.double && m.hits.length > 1) bad(id, 'multiple hits without double');
    }
    // keys
    const keys = m.keys;
    if (!Array.isArray(keys) || keys.length < 4) bad(id, 'too few keys');
    else {
      if (keys[0].t !== 0 || keys[0].pose !== 'stance:' + m.start) bad(id, 'first key must be stance:<start> at 0');
      const lk = keys[keys.length - 1];
      if (Math.abs(lk.t - m.duration) > 1e-3 || lk.pose !== 'stance:' + m.end) bad(id, 'last key must be stance:<end> at duration');
      for (let i = 1; i < keys.length; i++) if (keys[i].t < keys[i - 1].t - EPS) bad(id, 'keys not sorted');
      for (const k of keys) if (k.t < -EPS || k.t > m.duration + EPS) bad(id, 'key outside duration');
      for (const h of m.hits) if (!keys.some((k) => Math.abs(k.t - h.t) < 1e-3)) bad(id, `no key at hit time ${h.t}`);
      if (!keys.some((k) => k.t > 0 && k.t < m.startup - EPS)) bad(id, 'no anticipation key');
      if (m.chargeAt !== undefined && !(m.chargeAt > 0 && m.chargeAt < m.startup)) bad(id, 'chargeAt outside startup');
    }
  }

  // library shape
  if (player.length < 28 || player.length > 32) issues.push(`library: ${player.length} player moves (want 28-32)`);
  const g = stanceGraph(player);
  for (const st of STANCES) {
    const n = player.filter((m) => m.start === st).length;
    if (n < 6) issues.push(`library: only ${n} moves start in ${st}`);
    if (g[st].size < 3) issues.push(`library: ${st} starters reach only ${[...g[st]].join(',')}`);
  }
  for (const a of STANCES) {
    for (const b of STANCES) {
      if (a === b) continue;
      const two = g[a].has(b) || [...g[a]].some((x) => g[x].has(b));
      if (!two) issues.push(`library: ${b} not reachable from ${a} within 2 moves`);
    }
  }
  for (const p of PROPS) {
    const n = player.filter((m) => m.props?.[p]).length;
    if (n < 2) issues.push(`library: property ${p} covered ${n}x (want >= 2)`);
  }
  for (const k of ['height', 'path']) for (const v of ENUM[k]) if (!player.some((m) => m[k] === v)) issues.push(`library: no ${k} ${v}`);
  const bosses = {};
  for (const m of all.filter((x) => x.boss)) bosses[m.id.split('_')[0]] = (bosses[m.id.split('_')[0]] || 0) + 1;
  if (all.filter((x) => x.boss).length < 8) issues.push('library: fewer than 8 boss moves');

  // decks
  const checkDeck = (name, deck) => {
    for (const st of STANCES) {
      for (const slot of ['main', 'alt']) {
        const id = deck?.[st]?.[slot];
        if (!MOVES[id]) issues.push(`deck ${name}: ${st}.${slot} unknown ${id}`);
        else if (MOVES[id].start !== st) issues.push(`deck ${name}: ${st}.${slot} ${id} starts in ${MOVES[id].start}`);
      }
    }
  };
  checkDeck('STARTER', STARTER_DECK);
  for (const [n, d] of Object.entries(ENEMY_DECKS || {})) checkDeck(n, d);
  for (const n of ['thug', 'brawler', 'swift', 'heavy', 'tadao', 'madame_shu', 'brick', 'mr_golden']) if (!ENEMY_DECKS?.[n]) issues.push(`deck ${n} missing`);
  const starterIds = STANCES.flatMap((s) => [STARTER_DECK[s]?.main, STARTER_DECK[s]?.alt]);
  if (new Set(starterIds).size !== 8) issues.push('STARTER_DECK: needs 8 different moves');
  if (starterIds.some((id) => MOVES[id]?.boss || MOVES[id]?.focus)) issues.push('STARTER_DECK: contains boss/focus moves');
  // main loop visits all four stances
  let st = 'FR';
  const seen = new Set([st]);
  for (let i = 0; i < 8; i++) { const id = STARTER_DECK[st]?.main; if (!MOVES[id]) break; st = MOVES[id].end; seen.add(st); }
  if (seen.size < 4) issues.push(`STARTER_DECK: main loop only visits ${[...seen].join(',')}`);
  if (!MOVES[FOCUS_MOVES?.strike] || !MOVES[FOCUS_MOVES?.sweep]) issues.push('FOCUS_MOVES ids missing');
  for (const r of COMBO_ROUTES || []) {
    if (!r.moves?.length || r.moves.length > 3) issues.push(`route ${r.id}: 1-3 moves`);
    for (let i = 0; i < r.moves.length; i++) {
      const m = MOVES[r.moves[i]];
      if (!m) { issues.push(`route ${r.id}: unknown ${r.moves[i]}`); continue; }
      if (i > 0 && MOVES[r.moves[i - 1]] && MOVES[r.moves[i - 1]].end !== m.start) issues.push(`route ${r.id}: ${m.id} does not start where the previous move ends`);
    }
  }

  if (poseQA) issues.push(...poseIssues(all));
  return issues;
}

// ------------------------------------------------------------------------------------------------ pose QA

const QA_H = { high: [1.2, 2.1], mid: [0.6, 1.5], low: [-0.1, 0.75] };
let _qa = null;
function qaRig() {
  if (_qa) return _qa;
  _qa = { sk: createSkeleton(), pb: new PoseBuffer(), v: new THREE.Vector3() };
  return _qa;
}
const wrap = (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; };

/** Sample a move at t and return { yaw, point(limb), footY } in the fighter frame. */
export function sampleMoveFK(m, t) {
  const { sk, pb, v } = qaRig();
  sampleTrack(m, t, pb);
  pb.applyTo(sk);
  sk.root.updateMatrixWorld(true);
  const yaw = pb.root[3] * 180 / Math.PI;
  const point = (name) => strikePointWorld(sk, name, v).toArray();
  const footY = Math.min(strikePointWorld(sk, 'footL', v).y, strikePointWorld(sk, 'footR', v).y,
    strikePointWorld(sk, 'ankleL', v).y - 0.06, strikePointWorld(sk, 'ankleR', v).y - 0.06);
  return { yaw, point, footY };
}

/** FK checks against the reference stances: strike reach/height at each hit, strike yaw vs end stance, chainIn yaw. */
export function poseIssues(moves) {
  const issues = [];
  const { sk } = qaRig();
  if (!sk) return issues;
  for (const m of moves) {
    for (const h of m.hits) {
      const s = sampleMoveFK(m, h.t);
      const p = s.point(h.limb);
      const height = h.height || m.height;
      const [lo, hi] = QA_H[height];
      if (p[2] < (/elbow|knee/.test(h.limb) ? 0.35 : 0.45)) issues.push(`${m.id}: ${h.limb} only ${p[2].toFixed(2)} m forward at hit ${h.t}`);
      if (p[1] < lo || p[1] > hi) issues.push(`${m.id}: ${h.limb} at height ${p[1].toFixed(2)} for a ${height} attack (hit ${h.t})`);
    }
    const lastHit = m.hits[m.hits.length - 1];
    const strikeYaw = sampleMoveFK(m, lastHit.t).yaw;
    const dEnd = Math.abs(strikeYaw - STANCE_YAW[m.end]);
    if (dEnd > 70) issues.push(`${m.id}: strike yaw ${strikeYaw.toFixed(0)} is ${dEnd.toFixed(0)} deg from ${m.end} (chained blends would whip)`);
    const chainYaw = sampleMoveFK(m, m.chainIn).yaw;
    const dStart = Math.abs(chainYaw - STANCE_YAW[m.start]);
    if (dStart > 45) issues.push(`${m.id}: chainIn yaw ${chainYaw.toFixed(0)} is ${dStart.toFixed(0)} deg from ${m.start}`);
    for (const k of m.keys) {
      const s = sampleMoveFK(m, k.t);
      if (s.footY < -0.04) issues.push(`${m.id}: foot ${s.footY.toFixed(2)} below ground at ${k.t}`);
    }
  }
  return issues;
}

/** Reference stance poses are registered? (QA needs them to sample the first/last keys.) */
export const qaReady = () => !!REFERENCE_STANCES;
