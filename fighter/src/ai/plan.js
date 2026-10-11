// String planner (pure): picks which buttons an AI presses for its next string, following the Absolver flow graph.
// Each attack ends in a stance and the follow-up comes from THAT stance's slot, so a string is a walk through the
// deck: light/heavy at step i plays deck[stance_i][main/alt] and moves to its end stance. Up to 3 attacks.
// Scored on damage, signature use, mix-ups (height changes), what the player keeps doing (habits) and archetype
// taste, with seeded noise so the same situation does not always produce the same string. No allocations: results
// are written into a caller-owned `out` object.
import { deckInfo, STANCE_IDS } from './moveinfo.js';

const KINDS = ['light', 'heavy'];

/** Fresh output object for planString (allocate once per brain). */
export function makePlan() {
  return { kinds: ['light', 'light', 'light'], moves: [null, null, null], len: 0, switchTo: null, score: -Infinity, cost: 0 };
}

/**
 * Plan a string.
 * ctx: {
 *   deck, stance,            current deck + stance
 *   len,                     desired length 1..3 (shorter if stamina forbids)
 *   budget,                  stamina available for the whole string
 *   heavyBias,               -1..1 taste for alternates (heavy button)
 *   sigBias, sigOnly         bonus for signature (boss) moves; sigOnly forces the first move to be one
 *   habits: { block, parry, duck, jump, side, dodge, absorb }  0..1 rates of the player's defences
 *   dist,                    current distance to the target (prefers first moves that reach)
 *   fast,                    0..1 weight for quick first strikes (punishes / counters)
 *   allowSwitch, switchCost  consider starting from another stance (stance switch first)
 *   rng                      () => 0..1
 *   noise                    random score spread (default 3)
 *   recent                   ids of the last few moves it threw (variety penalty)
 * }
 * Returns out.len (0 when nothing affordable).
 */
export function planString(ctx, out) {
  out.len = 0; out.switchTo = null; out.score = -Infinity; out.cost = 0;
  const want = Math.max(1, Math.min(3, ctx.len | 0 || 1));
  const rng = ctx.rng || Math.random;
  const startStances = ctx.allowSwitch ? 4 : 1;
  for (let s = 0; s < startStances; s++) {
    const st0 = ctx.allowSwitch ? STANCE_IDS[s] : ctx.stance;
    const switching = st0 !== ctx.stance;
    const budget = (ctx.budget || 0) - (switching ? (ctx.switchCost || 5) : 0);
    for (let L = 1; L <= want; L++) {
      const combos = 1 << L;
      for (let bits = 0; bits < combos; bits++) {
        const sc = scoreSeq(ctx, st0, L, bits, budget, want, rng);
        if (sc === null) continue;
        const total = sc - (switching ? (ctx.switchPenalty ?? 5) : 0);
        if (total > out.score) {
          out.score = total;
          out.len = L;
          out.switchTo = switching ? st0 : null;
          let st = st0, cost = 0;
          for (let i = 0; i < L; i++) {
            const kind = KINDS[(bits >> i) & 1];
            const inf = deckInfo(ctx.deck, st, kind);
            out.kinds[i] = kind;
            out.moves[i] = inf;
            cost += inf.stamina;
            st = inf.end;
          }
          out.cost = cost;
        }
      }
    }
  }
  return out.len;
}

/** Score of one button sequence (bit i = 1 -> heavy), or null when unaffordable / not allowed. */
function scoreSeq(ctx, stance, L, bits, budget, want, rng) {
  const h = ctx.habits || NO_HABITS;
  let st = stance, cost = 0, score = 0, prevHeight = null;
  for (let i = 0; i < L; i++) {
    const kind = KINDS[(bits >> i) & 1];
    const m = deckInfo(ctx.deck, st, kind);
    cost += m.stamina;
    if (i === 0 && ctx.sigOnly && !m.signature) return null;
    // later hits of a string connect less often: weight them down a little
    const w = i === 0 ? 1 : i === 1 ? 0.85 : 0.7;
    let v = m.damage * w;
    if (m.signature) v += ctx.sigBias || 0;
    if (kind === 'heavy') v += (ctx.heavyBias || 0) * 4;
    // answer the player's habits (Absolver mind games)
    if (m.brk) v += 9 * h.block + 5 * h.absorb;
    if (m.height === 'high') v -= 7 * h.duck;
    if (m.height === 'low') v -= 7 * h.jump;
    if (m.path === 'thrust' || m.path === 'vertical') v -= 6 * h.side;
    if (m.path === 'horizontal') v += 3 * h.side;
    if (m.stop) v += 4 * h.parry;          // stop hits beat attack-happy / parry-happy players
    if (m.knockdown) v += 2;
    if (m.hits > 1) v += 2 * h.parry;      // doubles split the parry timing
    if (prevHeight && m.height !== prevHeight) v += 2.5;   // mix-ups
    // variety: what it just threw is worth less (the player has seen it)
    const rc = ctx.recent;
    if (rc) for (let r = 0; r < rc.length; r++) if (rc[r] === m.id) v -= i === 0 ? 4.5 : 2;
    if (i === 0) {
      // the opener has to reach, and quick ones are worth more when punishing
      if (ctx.dist > 0) v -= Math.max(0, ctx.dist - (m.reach + 0.9)) * 6;
      v -= (ctx.fast || 0) * m.firstHit * 40;
    }
    score += v;
    prevHeight = m.height;
    st = m.end;
  }
  if (cost > budget && L > 1) return null;
  if (cost > budget + 4) return null;
  score -= Math.abs(want - L) * 7;
  score += (rng() - 0.5) * 2 * (ctx.noise ?? 3);
  return score;
}

const NO_HABITS = { block: 0, parry: 0, duck: 0, jump: 0, side: 0, dodge: 0, absorb: 0 };

/** Weighted pick of a string length from weights [w1, w2, w3]. */
export function pickLength(weights, rng = Math.random) {
  const a = weights?.[0] || 0, b = weights?.[1] || 0, c = weights?.[2] || 0;
  const t = a + b + c;
  if (t <= 0) return 1;
  const r = rng() * t;
  return r < a ? 1 : r < a + b ? 2 : 3;
}

/**
 * The defensive answer to an incoming move for a given style ability (pure; used by brains and tests).
 * Returns 'duck' | 'jump' | 'left' | 'right' for avoids (Windfall), following combat's evasion rules.
 */
export function avoidKindFor(m) {
  if (!m) return 'duck';
  if (m.height === 'high') return 'duck';
  if (m.height === 'low') return 'jump';
  if (m.path === 'thrust' || m.path === 'vertical') return 'left';
  // horizontal mid: step toward the side the swing comes from (a right-limb swing is slipped by stepping right)
  return /R$/.test(m.limb || '') ? 'right' : 'left';
}
