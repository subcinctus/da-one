// Move definition helpers: fill frame-data defaults, bake key specs into rig poses, derive mirrored variants.
import { bake, mirrorKeyPose, mirrorLimb, MIRROR } from './posekit.js';

/** Cross-fade used when an attack chains into the next (FIGHTER.md §6b). */
export const CHAIN_BLEND = 0.06;
/** Default strike-pose hold when chaining out of a move, by weight. */
export const HOLD_OUT = { light: 0.045, medium: 0.055, heavy: 0.065 };
const LEARN = { light: 80, medium: 120, heavy: 170 };
const HITSTOP = { light: 0.045, medium: 0.06, heavy: 0.085 };

const rt = (v) => Math.round(v * 1000) / 1000;

/**
 * Key time shorthand: number = seconds; 'hit' = startup; 'hold' = end of the active window;
 * 'w0.55' = 55% of startup (wind-up); 'r0.4' = 40% into the recovery; 'h0.5' = 50% into the active window.
 */
function keyTime(t, m) {
  if (typeof t === 'number') return t;
  if (t === 'hit') return m.startup;
  if (t === 'hold') return m.startup + m.active;
  const f = parseFloat(t.slice(1));
  if (t[0] === 'w') return m.startup * f;
  if (t[0] === 'h') return m.startup + m.active * f;
  if (t[0] === 'r') return m.startup + m.active + m.recovery * f;
  throw new Error('bad key time ' + t);
}

function defaultEase(t, m) {
  if (t < m.startup - 1e-4) return 'inOut';
  if (Math.abs(t - m.startup) < 1e-4) return 'snap';
  if (t <= m.startup + m.active + 1e-4) return 'linear';
  return 'out';
}

/**
 * Build a move from a definition. `def.keys` = [[time, spec | poseName, ease?], ...] for the keys BETWEEN the
 * stance ends; the first ('stance:<start>' at 0) and last ('stance:<end>' at duration) keys are added here.
 */
export function defineMove(def) {
  const m = { ...def };
  m.props = { ...(def.props || {}) };
  m.duration = rt(m.startup + m.active + m.recovery);
  m.cancel = rt(def.cancel ?? (m.startup + m.active + 0.04));
  m.chainIn = rt(def.chainIn ?? m.startup * 0.4);
  m.holdOut = def.holdOut ?? HOLD_OUT[m.weight] ?? 0.05;
  m.guardDamage = def.guardDamage ?? Math.round(m.damage * (m.props.break ? 1.8 : 1.35));
  m.hitstop = def.hitstop ?? HITSTOP[m.weight];
  m.learn = def.boss ? 0 : (def.learn ?? LEARN[m.weight]);
  m.boss = !!def.boss;
  m.hits = (def.hits || [{ t: m.startup, dur: m.active, limb: m.limb, damage: m.damage }])
    .map((h) => ({ t: rt(keyTime(h.t, m)), dur: rt(h.dur), limb: h.limb || m.limb, damage: h.damage ?? m.damage, ...(h.height ? { height: h.height } : {}) }));
  const keys = [{ t: 0, pose: 'stance:' + m.start }];
  for (const k of def.keys) {
    const t = rt(keyTime(k[0], m));
    keys.push({ t, pose: bake(k[1]), ease: k[2] || defaultEase(t, m) });
  }
  keys.push({ t: m.duration, pose: 'stance:' + m.end, ease: def.endEase || 'inOut' });
  keys.sort((a, b) => a.t - b.t);
  m.keys = keys;
  if (def.chargeAt !== undefined) m.chargeAt = rt(keyTime(def.chargeAt, m));
  return m;
}

/** Mirror a defined move (left/right variant): stances, limbs and poses swap sides. `over` overrides fields. */
export function mirrorMove(m, over = {}) {
  const out = {
    ...m,
    start: MIRROR[m.start], end: MIRROR[m.end],
    limb: mirrorLimb(m.limb),
    hits: m.hits.map((h) => ({ ...h, limb: mirrorLimb(h.limb) })),
    keys: m.keys.map((k) => ({ ...k, pose: mirrorKeyPose(k.pose) })),
    props: { ...m.props },
    mirrorOf: m.id,
    ...over,
  };
  return out;
}
