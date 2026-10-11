// Combat tuning. Seconds, metres, m/s, rad/s. One place to tweak the feel (Absolver: deliberate, weighty, readable).
const D = Math.PI / 180;

export const T = {
  // ---- combo flow (FIGHTER.md §6b): skip the recovery, hold the strike form, very fast blend into the follow-up
  CHAIN_BLEND: 0.06,        // cross-fade from the held strike pose into the follow-up (never below CHAIN_BLEND_MIN)
  CHAIN_BLEND_MIN: 0.04,
  HOLD_OUT: 0.05,           // default strike-pose hold when chaining out of a move
  HOLD_MIN: 0.025,          // the strike form always holds >= 3 frames; a connected hit's hitstop counts toward holdOut
                            // (a chain pressed during the recovery does not freeze at all: it blends on from the pose)
  CHAIN_MIN_LEAD: 0.06,     // a chained move always keeps >= this much wind-up before its first hit (readable)
  ATTACK_FADE: 0.08,        // blend into a fresh (non-chained) attack
  BUFFER: 0.2,              // input buffer outside of attacks. A press made during a committed stretch (dodge,
                            // defence, recovery, stance switch, an attack past its strike) ages from the moment that
                            // action becomes legal instead of from the press...
  BUFFER_MAX_WAIT: 0.6,     // ...but never waits longer than this in total (stale presses never fire)
  DEFENSIVE_QUEUE: 0.25,    // a dodge/defend pressed during an attack still fires at the chain point if this recent
  STRING_MAX: 3,
  STRING_END: 0.15,         // lockout after the third attack's full recovery
  EXHAUSTED_RECOVERY: 0.3,  // extra recovery for attacks thrown at 0 stamina

  // ---- locomotion
  WALK: 2.6, BACK: 1.8, STRAFE: 2.3, RUN: 4.2,
  GUARD_SPEED: 0.6,         // multiplier while guarding
  SWITCH_SPEED: 0.5,
  ACCEL: 14,                // velocity damping rate toward the desired speed
  RUN_THRESHOLD: 0.92,      // stick magnitude needed to run
  ENEMY_RUN_DIST: 5,        // enemies may run toward a target further than this
  TURN_FREE: 12, TURN_LOCKED: 10, TURN_STARTUP: 12, TURN_ACTIVE: 2, TURN_RECOVER: 5, TURN_BLOCK: 9, TURN_DODGE: 4,

  // ---- stamina
  STAMINA_MAX: 100, REGEN: 30, REGEN_DELAY: 0.6, REGEN_GUARD: 0.35,
  DODGE_COST: 12, AVOID_COST: 8, PARRY_COST: 5, ABSORB_COST: 8, SWITCH_COST: 5,

  // ---- dodge
  DODGE_TIME: 0.3, DODGE_DIST: 2.2, DODGE_IFRAME_START: 0.08, DODGE_IFRAME_END: 0.26,
  DODGE_RECOVERY: 0.25, DODGE_RECOVERY_ATTACK: 0.1, DODGE_RECOVERY_DODGE: 0.18,
  SWITCH_TIME: 0.18,

  // ---- defensive styles
  PARRY_WINDOW: 0.2, PARRY_FAIL: 0.35, PARRY_STAGGER: 0.7,
  ABSORB_TIME: 0.5, ABSORB_REDUCTION: 0.6, ABSORB_HEAL_WINDOW: 1.2, ABSORB_CANCEL_AFTER: 0.25,
  AVOID_WINDOW: 0.3,
  AVOID_TIME: { duck: 0.4, left: 0.35, right: 0.35, jump: 0.45 },
  AVOID_SIDE_DIST: 0.45,
  COUNTER_WINDOW: 0.4, COUNTER_MULT: 1.25,
  GUARD_REDUCTION: 0.8, GUARDBREAK_TIME: 0.8,
  GUARD_ARC: 100 * D,       // half-angle in front of the defender where guard / parry work (behind = fail)

  // ---- feints / charge
  FEINT_REFUND: 0.5, FEINT_RECOVERY: 0.12, FEINT_ATTACK_AT: 0.06,
  CHARGE_MAX: 0.6, CHARGE_DAMAGE: 0.6,
  CHARGE_BREAK: 0.98,       // charge fraction from which the strike gains `break` (chargeFull is emitted then)
  CHARGE_POINT: 0.65,       // fallback charge hold point (fraction of the first hit time) for moves without chargeAt
  CHARGE_TREMBLE: 0.6,      // flinch impulse (animator.flinch amount) of the straining tremble while a charge is held
  CHARGE_TREMBLE_EVERY: 0.08, // seconds between tremble impulses (alternating side)

  // ---- hit reactions
  KNOCKDOWN_TIME: 1.1, GETUP_TIME: 0.8,
  STAGGER_EXHAUSTED: 1.0,
  STOP_STUN_MULT: 1.4,
  COMBO_SCALE_STEP: 0.18, COMBO_SCALE_MIN: 0.4,
  COMBO_IMMUNITY_AT: 5, COMBO_IMMUNITY: 0.35, // after a long juggle the victim gets a short grace period
  ARMOR_FROM: 0.4,          // heavy moves ignore light non-stop hits after this fraction of their startup
  PUSH_DECAY: 10,           // push velocity decay rate (distance = v0 / rate)
  HIT_POINT_Y: { high: 1.55, mid: 1.1, low: 0.45 },

  // ---- focus (Sifu)
  FOCUS_MAX: 100, FOCUS_STRIKE_COST: 50, FOCUS_SWEEP_COST: 100,
  FOCUS_HIT: 4, FOCUS_DEFEND: 15, FOCUS_ABSORB: 10, FOCUS_BLOCK: 3,
  FOCUS_WINDOW: 0.6,        // real seconds after pressing focus during which light/heavy perform a focus move
  FOCUS_SLOWMO: 0.25,
  FOCUS_STRIKE_STUN: 1.1,

  // ---- hit feel
  HITSTOP: { light: 0.045, medium: 0.06, heavy: 0.085 },  // fallback per weight; moves carry their own `hitstop`
  HITSTOP_BLOCK: 0.03, HITSTOP_PARRY: 0.07, HITSTOP_KILL: 0.09, HITSTOP_FOCUS: 0.09, HITSTOP_ABSORB: 0.04,
  SHAKE: { light: 0.12, medium: 0.22, heavy: 0.4 },

  // ---- learning (Absolver)
  LEARN_BLOCK: 12, LEARN_DEFEND: 30,

  // ---- targeting
  LOCK_RANGE: 12, LOCK_ARC: 100 * D, SOFT_AIM_RANGE: 3, SOFT_AIM_ARC: 70 * D,
};

/** Ordered list of every fighter state (FIGHTER.md §7). */
export const STATES = ['idle', 'move', 'attack', 'recover', 'block', 'blockstun', 'hitstun', 'parry', 'absorb', 'avoid',
  'dodge', 'stagger', 'guardbroken', 'knockdown', 'getup', 'dead', 'switch'];

/** States in which a fighter acts freely (walk, guard, start attacks / dodges / defences / stance switches). */
export const FREE_STATES = { idle: true, move: true, block: true };
