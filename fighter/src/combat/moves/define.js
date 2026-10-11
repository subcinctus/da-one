// Move definition helpers: fill frame-data defaults, bake key specs into rig poses, derive mirrored variants.
import { bake, mirrorKeyPose, mirrorLimb, MIRROR } from './posekit.js';
import { STANCE_SPECS, AUTHORED_UP } from './stances-ref.js';

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

/**
 * Default segment ease by the key it ends on: wind-up keys 'inOut'; the HIT key 'in' (the limb accelerates INTO contact:
 * contact speed = 2x the segment average, never the decelerating 'snap' that stops the limb before the hit);
 * keys inside the active window 'linear'; recovery 'out'. Follow-through 'hold' keys should pass 'out' explicitly.
 */
function defaultEase(t, m) {
  if (t < m.startup - 1e-4) return 'inOut';
  if (Math.abs(t - m.startup) < 1e-4) return 'in';
  if (t <= m.startup + m.active + 1e-4) return 'linear';
  return 'out';
}

/** Root height shift (registered stance height - authored reference height), blended start -> end over the move. */
function upShift(m, t) {
  const f = m.duration > 0 ? Math.min(1, Math.max(0, t / m.duration)) : 0;
  const a = (STANCE_SPECS[m.start]?.root?.up ?? AUTHORED_UP[m.start]) - AUTHORED_UP[m.start];
  const b = (STANCE_SPECS[m.end]?.root?.up ?? AUTHORED_UP[m.end]) - AUTHORED_UP[m.end];
  return a + (b - a) * f;
}

/** Bake a key spec with the root height shift applied (IK keeps planted feet on the floor). */
function bakeKey(spec, m, t) {
  if (typeof spec === 'string') return spec;
  const du = upShift(m, t);
  if (Math.abs(du) < 1e-6) return bake(spec);
  const r = spec.root || {};
  return bake({ ...spec, root: { ...r, up: (r.up || 0) + du } });
}

/**
 * Build a move from a definition. `def.keys` = [[time, spec | poseName, ease?], ...] for the keys BETWEEN the
 * stance ends; the first ('stance:<start>' at 0) and last ('stance:<end>' at duration) keys are added here.
 * Optional `def.freeFeet: ['footR']` exempts a deliberately skimming foot (a floor sweep) from the animator's
 * planted-foot pass for the whole move.
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
    keys.push({ t, pose: bakeKey(k[1], m, t), ease: k[2] || defaultEase(t, m) });
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
    ...(m.freeFeet ? { freeFeet: m.freeFeet.map(mirrorLimb) } : {}),
    mirrorOf: m.id,
    ...over,
  };
  return out;
}
