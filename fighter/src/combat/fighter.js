// Fighter: one combatant's simulation (state machine, stance, deck, stamina, guard, strings and the §6b combo flow,
// dodges, the three defensive styles, focus) plus driving its Animator. Hit resolution lives in hits.js; the
// Combat system steps fighters at 120 Hz and resolves contacts between them.
//
// COMBO FLOW (FIGHTER.md §6b), the heart of the feel:
//   standalone   : the move plays fully, recovery included, into 'stance:<end>'.
//   chained      : a light/heavy pressed any time during the attack is queued. At the end of the last active window
//                  the animator FREEZES the strike pose for move.holdOut (the form visibly lingers; a connected
//                  hit's hitstop counts toward it, never below HOLD_MIN = 3 frames), then the follow-up from the END
//                  stance's slot starts at moveTime = next.chainIn with a CHAIN_BLEND (0.06 s) cross-fade from the
//                  frozen pose: recovery skipped, wind-up shortened, never a teleport.
//   late chain   : pressed during the recovery -> no freeze (the pose is already relaxing): the follow-up cross-fades
//                  straight from the current pose. Late defensive cancels (after the strike) do the same.
//   string cap 3 : the third attack always plays its full recovery, then a short STRING_END lockout. A press made
//                  after its strike stays buffered and starts a new string when the lockout ends; presses made
//                  during its wind-up are dropped (mashing does not auto-start a new string).
//   defensive    : dodge / defend / guard after the cancel point skip the recovery with the same fast blend (a hold
//                  only when the cancel point is the strike end itself; later the pose is relaxing, so no freeze).
//   charge       : charge moves hold on moveInfo.chargeAt (the authored anticipation key) while the button is held,
//                  with a small alternating tremble; events chargeStart / chargeFull / chargeRelease / chargeCancel.
//
// INPUT BUFFER: presses age from the press (T.BUFFER), except presses made during a committed stretch (dodge, avoid,
// parry, absorb, recover, switch, an attack past its strike): those age from the moment their action becomes legal
// (lazily recorded in legalT at the first legal check), capped at T.BUFFER_MAX_WAIT in total. Stuns reset this.
import * as THREE from 'three';
import { clamp, damp, wrapAngle, angleDiff, yawTo } from '../core/math.js';
import { STANCES, STYLES } from '../data/stances.js';
import { T, FREE_STATES } from './constants.js';
import { moveInfo, slotMove, focusMove } from './movedata.js';

let NEXT_ID = 1;
const NEVER = 1e9;
const _tremble = { x: 0.3, z: 0.2 };   // charge tremble flinch direction (fighter space), x alternates sign
/** States that keep presses waiting for legality (see INPUT BUFFER above). */
const COMMITTED = { dodge: true, avoid: true, parry: true, absorb: true, recover: true, switch: true };
/** A committed state entered within this long of the previous stretch's end continues it (1.5 sim steps). */
const CONTIGUOUS = 0.0125;
/** Buffer key -> legality key. */
const LEGAL_KEY = { light: 'attack', heavy: 'attack', dodge: 'dodge', defend: 'defend', focus: 'focus', feint: 'feint', stance: 'stance' };

/** A fresh intent object (see FIGHTER.md §7 Intent). */
export function makeIntent() {
  return {
    moveX: 0, moveZ: 0, light: false, heavy: false, guard: false, dodge: false, dodgeDir: { x: 0, z: 0 },
    defend: false, stance: null, focus: false, charge: false, feint: false, lockTarget: null,
  };
}

/** Defensive ability of a style id ('parry' | 'absorb' | 'avoid'). */
export function styleAbility(style) {
  const s = STYLES[style];
  return s ? s.ability : 'parry';
}

export class Fighter {
  /**
   * @param {object} combat the Combat system
   * @param {object} o spawn options (team, name, boss, position, yaw, health, deck, style, stance, radius, height)
   */
  constructor(combat, o = {}) {
    this.combat = combat;
    this.game = combat.game;
    this.id = NEXT_ID++;
    this.team = o.team || 'enemy';
    this.name = o.name || (this.team === 'player' ? 'You' : 'Thug');
    this.boss = o.boss || null;
    this.archetype = o.ai || o.archetype || null;
    this.look = o.look || null;

    // body
    this.position = new THREE.Vector3(o.position ? +o.position.x || 0 : 0, 0, o.position ? +o.position.z || 0 : 0);
    this.yaw = typeof o.yaw === 'number' ? o.yaw : 0;
    this.velocity = new THREE.Vector3();
    this.radius = typeof o.radius === 'number' ? o.radius : 0.35;
    this.height = typeof o.height === 'number' ? o.height : 1.8;
    this.prevPosition = this.position.clone();
    this.prevYaw = this.yaw;
    this.locoVel = new THREE.Vector3();   // locomotion (damped)
    this.rootVel = new THREE.Vector3();   // root motion this step (lunge / dodge / avoid step)
    this.pushVel = new THREE.Vector3();   // knockback (decays)

    // health / resources
    this.baseMaxHealth = typeof o.health === 'number' && o.health > 0 ? o.health : (this.team === 'player' ? 100 : 60);
    this.maxHealth = this.baseMaxHealth;
    this.health = this.maxHealth;
    this.maxStamina = T.STAMINA_MAX;
    this.stamina = this.maxStamina;
    this.focus = 0;
    this.damageMult = typeof o.damageMult === 'number' ? o.damageMult : 1;
    this.god = false;

    // combat state
    this.stance = STANCES.includes(o.stance) ? o.stance : 'FR';
    this.deck = o.deck || null;
    this.style = STYLES[o.style] ? o.style : 'forsaken';
    this.state = 'idle';
    this.stateTime = 0;
    this.stateDur = 0;
    this.move = null;
    this.moveTime = 0;
    this.target = null;
    this.intent = makeIntent();
    this.alive = true;
    this.removed = false;

    // rendering / brain
    this.model = null;
    this.animator = null;
    this.ai = null;
    this.dummy = null;

    // attack in flight (reused object, no per-attack allocation)
    this.atk = {
      info: null, move: null, string: 0, phase: 'run', holdT: 0, holdDur: 0,
      next: null, nextT: 0, nextDir: { x: 0, z: 0 },
      win: -1, hitIds: [], anyContact: false, struck: false,
      chargeable: false, charging: false, chargeT: 0, chargeDone: false, chargePoint: 0, chargeMult: 1, chargeBreak: false,
      chargeFull: false, trembleT: 0, trembleSign: 1,
      focus: null, exhausted: false, chained: false, aim: null, aimYaw: null, startedAt: 0,
      struckAt: NEVER,   // sim time the last active window ended (the strike is done)
      stopServed: 0,     // hitstop already served on this attack's hits (counts toward the chain hold)
    };
    // input buffers (sim time of the last unconsumed press)
    this.buf = { light: -NEVER, heavy: -NEVER, dodge: -NEVER, defend: -NEVER, focus: -NEVER, feint: -NEVER };
    this.bufDodge = { x: 0, z: 0 };
    this.pendingStance = null;
    this.pendingStanceT = -NEVER;
    // committed stretches (see INPUT BUFFER): start time, flag, when the last one ended, when each action became legal
    this.lockT0 = NEVER;
    this._committed = false;
    this._uncommitT = -NEVER;
    this.legalT = { attack: -NEVER, dodge: -NEVER, defend: -NEVER, focus: -NEVER, feint: -NEVER, stance: -NEVER };

    // timers / windows
    this.lastSpend = -NEVER;
    this.counterUntil = -NEVER;
    this.absorbStored = 0;
    this.absorbHealUntil = -NEVER;
    this.absorbHits = 0;
    this.avoidKind = 'duck';
    this.avoidSuccess = false;
    this.parried = false;
    this.focusReadyUntil = -NEVER;  // REAL time
    this._focusPose = false;
    this.comboCount = 0;
    this.graceUntil = -NEVER;
    this.dodgeDir = new THREE.Vector3(0, 0, -1);
    this.iframes = false;
    this.rec = { attackAt: 0, defendAt: 0, guardAt: 0, dodgeAt: 0 };
    this.killer = null;
    this._staminaOutSent = false;
    this._stateSeen = 'idle';
    this._loco = { stance: this.stance, vx: 0, vz: 0, speed: 0, guard: false, locked: false, crouch: false, yaw: this.yaw, x: this.position.x, z: this.position.z };
    this._lookPos = new THREE.Vector3();
  }

  // ============================================================================================ queries

  /** True in idle / move / block. */
  isFree() { return !!FREE_STATES[this.state]; }
  /** True while blocking (guard up). */
  isGuarding() { return this.state === 'block' || this.state === 'blockstun'; }
  /** Same as isFree(): can start an attack / dodge / defence right now. */
  canAct() { return this.alive && !!FREE_STATES[this.state]; }
  /** True during an attack (any phase, incl. the chain hold). */
  isAttacking() { return this.state === 'attack'; }
  /** True while reeling (hitstun, stagger, guard broken, blockstun, knockdown, getup). */
  isStunned() {
    const s = this.state;
    return s === 'hitstun' || s === 'stagger' || s === 'guardbroken' || s === 'blockstun' || s === 'knockdown' || s === 'getup';
  }
  /** Horizontal distance to another fighter (or {position}). */
  distanceTo(o) { const p = o.position || o; return Math.hypot(p.x - this.position.x, p.z - this.position.z); }
  /** True while immune to hits (dodge i-frames, getup, knockdown, grace after long combos, dead). */
  get invulnerable() {
    if (!this.alive) return true;
    if (this.state === 'dodge') return this.iframes;
    if (this.state === 'getup' || this.state === 'knockdown') return true;
    return this.game.time < this.graceUntil;
  }
  /** Current attack phase: 'startup' | 'active' | 'recovery' | 'hold' | 'charge' | null. */
  get attackPhase() {
    if (this.state !== 'attack' || !this.atk.info) return null;
    const a = this.atk, info = a.info, t = this.moveTime;
    if (a.phase === 'hold') return 'hold';
    if (a.charging) return 'charge';
    if (t < info.firstStart) return 'startup';
    if (t < info.lastEnd) return 'active';
    return 'recovery';
  }
  /** Seconds until the next hit window of the current attack opens (0 while active), or -1. Charging counts as unknown (-1). */
  timeToHit() {
    if (this.state !== 'attack' || !this.atk.info || this.atk.charging) return -1;
    const hs = this.atk.info.hits, t = this.moveTime;
    for (let i = 0; i < hs.length; i++) {
      if (t < hs[i].t) return hs[i].t - t;
      if (t < hs[i].end) return 0;
    }
    return -1;
  }
  /** True while a focus press is armed (light = focus strike, heavy = focus sweep). */
  get focusReady() { return this.game.realTime < this.focusReadyUntil; }
  /** Normalised info of the current move (see movedata.moveInfo) or null. */
  get moveInfo() { return this.state === 'attack' ? this.atk.info : null; }
  /** Attack index in the current string (1..3) or 0. */
  get stringIndex() { return this.state === 'attack' ? this.atk.string : 0; }
  /** Defensive ability of this fighter's style. */
  get ability() { return styleAbility(this.style); }
  /** Move in this fighter's deck for the given stance and 'light' | 'heavy'. */
  slotMove(stance, kind) { return slotMove(this.deck, stance || this.stance, kind); }

  // ============================================================================================ public control

  /** Replace the combat deck (a reference is kept, so later edits to the object apply). */
  setDeck(deck) { this.deck = deck || null; }
  /** Set the stance immediately (debug / spawn). */
  setStance(st, silent = false) {
    if (!STANCES.includes(st) || st === this.stance) return;
    const from = this.stance;
    this.stance = st;
    if (!silent) this.game.events.emit('stanceChanged', { fighter: this, from, to: st });
  }
  /** Restore health (clamped). */
  heal(n) { if (this.alive) this.health = Math.min(this.maxHealth, this.health + Math.max(0, n)); }
  /** Recompute maxHealth from the base and a multiplier (age). Keeps the health ratio unless `refill`. */
  setHealthMult(mult = 1, refill = false) {
    const ratio = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    this.maxHealth = Math.max(1, Math.round(this.baseMaxHealth * mult));
    this.health = refill ? this.maxHealth : Math.min(this.maxHealth, Math.max(this.alive ? 1 : 0, Math.round(this.maxHealth * ratio)));
  }
  /** Bring a dead (or any) fighter back: full health, stamina, stands up with a getup (FIGHTER.md §9 revive). */
  revive(o = {}) {
    this.alive = true;
    this.killer = null;
    if (typeof o.healthMult === 'number') this.setHealthMult(o.healthMult, true);
    this.health = typeof o.health === 'number' ? Math.min(this.maxHealth, o.health) : this.maxHealth;
    this.stamina = this.maxStamina;
    this._staminaOutSent = false;
    this.comboCount = 0;
    this.pushVel.set(0, 0, 0);
    this._clearAttack();
    this._resetBuffers();
    if (o.getup === false) { this._stop(0.1); this._enter('idle'); } else this._getup();
  }
  /** Kill instantly (debug, scripted deaths). */
  kill(killer = null) { if (this.alive) { this.health = 0; this._die(killer); } }

  // ============================================================================================ step

  /** One 120 Hz simulation step (called by Combat). */
  step(dt) {
    const now = this.game.time;
    if (this.state !== this._stateSeen) this._adoptExternalState();
    // fields poked from outside (Flow revive / scripted damage): keep the state machine consistent
    if (this.state === 'dead' && this.alive && this.health > 0) this._getup();
    else if (this.alive && this.health <= 0) this._die(null);
    this._readIntent(now);
    this._updateTarget();
    this._timers(dt, now);
    this.rootVel.set(0, 0, 0);
    this.stateTime += dt;
    let speedMul = 0;
    switch (this.state) {
      case 'idle': case 'move': case 'block': speedMul = this._freeStep(dt); break;
      case 'attack': this._attackStep(dt); break;
      case 'recover': this._recoverStep(dt); break;
      case 'switch': speedMul = this._switchStep(dt); break;
      case 'dodge': this._dodgeStep(dt); break;
      case 'parry': this._parryStep(dt); break;
      case 'absorb': this._absorbStep(dt); break;
      case 'avoid': this._avoidStep(dt); break;
      case 'blockstun': speedMul = this._blockstunStep(dt); break;
      case 'hitstun': case 'stagger': case 'guardbroken': this._stunStep(dt); break;
      case 'knockdown': this._knockdownStep(dt); break;
      case 'getup': this._getupStep(dt); break;
      case 'dead': break;
      default: this._enter('idle'); break;
    }
    this._integrate(dt, speedMul);
    this._stateSeen = this.state;
  }

  /** Locomotion + look-at + animator update (after collisions). */
  animate(dt) {
    const an = this.animator;
    if (!an) return;
    const l = this._loco;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const v = this.velocity;
    l.stance = this.stance;
    l.vz = v.x * fx + v.z * fz;
    l.vx = v.x * -fz + v.z * fx;     // +x = right
    l.speed = Math.hypot(v.x, v.z);
    l.guard = this.isGuarding();
    l.locked = !!this.target;
    l.crouch = false;
    // sim-space facing and position: turn shuffle / look-at stay independent of the display rate
    l.yaw = this.yaw;
    l.x = this.position.x;
    l.z = this.position.z;
    try {
      if (typeof an.setLocomotion === 'function') an.setLocomotion(l);
      if (typeof an.lookAt === 'function') {
        const t = this.alive ? (this.target || (this.atk.aim && this.state === 'attack' ? this.atk.aim : null)) : null;
        if (t && t.alive) { this._lookPos.set(t.position.x, t.height * 0.85, t.position.z); an.lookAt(this._lookPos); } else an.lookAt(null);
      }
      if (typeof an.update === 'function') an.update(dt);
    } catch (e) {
      if (!this._animErr) { this._animErr = true; console.warn('[combat] animator error', e); }
    }
  }

  // ============================================================================================ intents & timers

  _readIntent(now) {
    const it = this.intent;
    if (it.light) { this.buf.light = now; it.light = false; }
    if (it.heavy) { this.buf.heavy = now; it.heavy = false; }
    if (it.dodge) {
      this.buf.dodge = now; it.dodge = false;
      const d = it.dodgeDir;
      this.bufDodge.x = d ? +d.x || 0 : 0; this.bufDodge.z = d ? +d.z || 0 : 0;
    }
    if (it.defend) { this.buf.defend = now; it.defend = false; }
    if (it.focus) { it.focus = false; this._focusPress(); }
    if (it.feint) { this.buf.feint = now; it.feint = false; }
    if (it.stance) {
      if (STANCES.includes(it.stance)) { this.pendingStance = it.stance; this.pendingStanceT = now; }
      it.stance = null;
    }
  }

  _updateTarget() {
    let t = this.intent.lockTarget || null;
    if (!t && this.team !== 'player') t = this.combat.defaultTargetFor(this);
    if (t && (!t.alive || t.removed || t === this)) t = null;
    this.target = t;
  }

  _timers(dt, now) {
    // stamina regeneration
    if (this.alive && this.stamina < this.maxStamina && now - this.lastSpend >= T.REGEN_DELAY && this.state !== 'attack') {
      const rate = T.REGEN * (this.isGuarding() ? T.REGEN_GUARD : 1);
      this.stamina = Math.min(this.maxStamina, this.stamina + rate * dt);
      if (this.stamina > 5) this._staminaOutSent = false;
    }
    // focus window expiry: drop the ready pose
    if (this._focusPose && this.game.realTime >= this.focusReadyUntil) {
      this._focusPose = false;
      if (this.isFree()) this._stop(0.12);
    }
    // pushes decay
    if (this.pushVel.x !== 0 || this.pushVel.z !== 0) {
      const k = Math.exp(-T.PUSH_DECAY * dt);
      this.pushVel.multiplyScalar(k);
      if (this.pushVel.lengthSq() < 1e-4) this.pushVel.set(0, 0, 0);
    }
  }

  /**
   * Age of a press made at `pressT` for legality key `lk`. Presses made during the current committed stretch age from
   * the moment the action became legal (never more than BUFFER_MAX_WAIT after the press). Call with mark = true only
   * where the action IS legal right now: the first such call since the stretch began records that moment in legalT.
   */
  _pressAge(lk, pressT, mark = true) {
    const now = this.game.time;
    if (pressT < this.lockT0 - 1e-6) return now - pressT;
    if (now - pressT > T.BUFFER_MAX_WAIT + 1e-6) return Infinity;
    let legal = this.legalT[lk];
    if (legal < this.lockT0 - 1e-6) {
      if (!mark) return 0;           // still waiting for legality: live
      legal = this.legalT[lk] = now;
    }
    return now - Math.max(pressT, legal);
  }
  _fresh(kind, window = T.BUFFER) { return this._pressAge(LEGAL_KEY[kind] || kind, this.buf[kind], false) <= window; }
  _take(kind, window = T.BUFFER) {
    if (this._pressAge(LEGAL_KEY[kind] || kind, this.buf[kind]) <= window) { this.buf[kind] = -NEVER; return true; }
    return false;
  }
  _pressedNow(kind) { return this.buf[kind] >= this.game.time - 1e-6; }
  _resetBuffers() {
    for (const k in this.buf) this.buf[k] = -NEVER;
    this.pendingStance = null;
    this.lockT0 = NEVER; this._committed = false; this._uncommitT = -NEVER;
  }

  /** Most recent buffered attack ('light' | 'heavy') within the buffer window, consumed. */
  _takeAttack() {
    const l = this.buf.light, h = this.buf.heavy;
    const lOk = this._pressAge('attack', l) <= T.BUFFER, hOk = this._pressAge('attack', h) <= T.BUFFER;
    if (!lOk && !hOk) return null;
    const kind = lOk && (!hOk || l >= h) ? 'light' : 'heavy';
    this.buf[kind] = -NEVER;
    return kind;
  }

  _spend(n) {
    if (!(n > 0)) return;
    this.stamina -= n;
    this.lastSpend = this.game.time;
    if (this.stamina <= 0) {
      this.stamina = 0;
      if (!this._staminaOutSent) { this._staminaOutSent = true; this.game.events.emit('staminaOut', { fighter: this }); }
    }
  }

  gainFocus(n) { this.focus = clamp(this.focus + n, 0, T.FOCUS_MAX); }

  // ============================================================================================ state plumbing

  _enter(state, dur = 0) {
    const now = this.game.time;
    if (COMMITTED[state]) {
      // a new committed stretch, unless one ended this step or the previous one (recover -> idle -> switch is one
      // stretch, so an attack buffered behind the switch still waits for the switch end)
      if (!this._committed && now - this._uncommitT > CONTIGUOUS) this.lockT0 = now;
      this._committed = true;
    } else if (FREE_STATES[state]) {
      if (this._committed) this._uncommitT = now;
      this._committed = false;   // lockT0 stays: presses from the stretch now age from their legal time
    } else {
      // attacks (until their strike ends) and reactions: presses age from the press again
      this._committed = false;
      this.lockT0 = NEVER;
      this._uncommitT = -NEVER;
    }
    this.state = state;
    this.stateTime = 0;
    this.stateDur = dur;
    this._stateSeen = state;
    if (state !== 'dodge') this.iframes = false;
  }

  _play(name, fade = 0.08, opts = null) {
    const an = this.animator;
    if (!an || typeof an.playAction !== 'function') return null;
    try {
      if (opts) { opts.fade = fade; return an.playAction(name, opts); }
      return an.playAction(name, { fade, fromCurrent: true });
    } catch (e) { return null; }
  }
  _stop(fade = 0.1) { const an = this.animator; if (an && typeof an.stopAction === 'function') { try { an.stopAction(fade); } catch (e) { /* ignore */ } } }
  _freeze(s) { const an = this.animator; if (an && typeof an.freezeAction === 'function') { try { an.freezeAction(s); } catch (e) { /* ignore */ } } }

  /** Someone outside Combat changed `state` directly (e.g. Flow revive). Give it sane timers. */
  _adoptExternalState() {
    const s = this.state;
    this._stateSeen = s;
    this.stateTime = 0;
    this.lockT0 = NEVER; this._committed = false; this._uncommitT = -NEVER;
    if (s !== 'attack') this._clearAttack();
    if (s === 'getup') {
      if (this.health > 0) this.alive = true;
      this.stateDur = T.GETUP_TIME; this._play('getup', 0.1);
    } else if (s === 'dead') {
      this.alive = false;
    } else if (s === 'attack' && !this.atk.info) {
      this._enter('idle');
    } else if (!FREE_STATES[s]) {
      this.stateDur = this.stateDur > 0 ? this.stateDur : 0.3;
    } else {
      this._stop(0.15);   // e.g. revived straight to idle: release the death / reaction pose
    }
  }

  _clearAttack() {
    const a = this.atk;
    if (a.charging && a.info) this.game.events.emit('chargeCancel', { fighter: this, move: a.move, charge: Math.min(1, a.chargeT / T.CHARGE_MAX) });
    a.info = null; a.move = null; a.string = 0; a.phase = 'run'; a.next = null; a.charging = false; a.focus = null; a.aim = null; a.aimYaw = null;
    this.move = null;
    this.moveTime = 0;
  }

  // ============================================================================================ free states

  _freeStep(dt) {
    if (this._freeActions()) return 0;
    const guard = !!this.intent.guard;
    const it = this.intent;
    const moving = Math.hypot(it.moveX, it.moveZ) > 0.1 || this.locoVel.lengthSq() > 0.04;
    const want = guard ? 'block' : moving ? 'move' : 'idle';
    if (want !== this.state) {
      if (want === 'block' && this._focusPose) { this._focusPose = false; this._stop(0.08); }
      this.state = want; this._stateSeen = want; this.stateTime = 0;
    }
    if (this.target) this._turnToward(this.target.position, guard ? T.TURN_BLOCK : T.TURN_LOCKED, dt);
    return guard ? T.GUARD_SPEED : 1;
  }

  /**
   * Buffered actions of a free state, in priority order: dodge, defend, stance switch, attack (focus moves included).
   * A live stance flick goes before a buffered attack (e.g. RT flick + X on the same frame): the attack stays buffered
   * through the switch (the switch continues the same committed stretch, so it ages from the switch end) and comes
   * out of the NEW stance when _switchStep finishes.
   */
  _freeActions() {
    return this._tryDodge(false) || this._tryDefend(false) || this._tryStance() || this._tryAttack();
  }

  _tryAttack() {
    const kind = this._takeAttack();
    if (!kind) return false;
    const fk = this._focusKindFor(kind);
    const m = fk ? focusMove(fk, this.stance) : slotMove(this.deck, this.stance, kind);
    this._startAttack(m, false, fk);
    return true;
  }

  _tryStance() {
    const st = this.pendingStance;
    if (!st) return false;
    this.pendingStance = null;
    if (this._pressAge('stance', this.pendingStanceT) > T.BUFFER || st === this.stance) return false;
    const from = this.stance;
    this.stance = st;
    this._spend(T.SWITCH_COST);
    if (this._focusPose) this._focusPose = false;
    this._play(`stance_switch_${from}_${st}`, 0.04);
    this._enter('switch', T.SWITCH_TIME);
    this.game.events.emit('stanceChanged', { fighter: this, from, to: st });
    return true;
  }

  _switchStep(dt) {
    if (this.target) this._turnToward(this.target.position, T.TURN_LOCKED, dt);
    // defensive actions may interrupt a switch; attacks wait for it (buffered)
    if (this._tryDodge(false) || this._tryDefend(false)) return 0;
    if (this.stateTime >= this.stateDur) {
      this._stop(0.06);
      this._enter('idle');
      if (!this._tryAttack()) this._tryStance();
    }
    return T.SWITCH_SPEED;
  }

  // ============================================================================================ attacks

  _focusKindFor(kind) {
    if (this.game.realTime >= this.focusReadyUntil) return null;
    if (kind === 'heavy' && this.focus >= T.FOCUS_SWEEP_COST) return 'sweep';
    if (kind === 'light' && this.focus >= T.FOCUS_STRIKE_COST) return 'strike';
    return null;
  }

  _focusPress() {
    if (!this.alive || this.focus < T.FOCUS_STRIKE_COST) {
      this.game.events.emit('focusDenied', { fighter: this, focus: this.focus });
      return;
    }
    this.focusReadyUntil = this.game.realTime + T.FOCUS_WINDOW;
    if (this.team === 'player' && typeof this.game.slowmo === 'function') this.game.slowmo(T.FOCUS_SLOWMO, T.FOCUS_WINDOW);
    this.game.events.emit('focusReady', { fighter: this, focus: this.focus });
    if (this.isFree()) { this._play('focus_ready', 0.08); this._focusPose = true; }
  }

  /**
   * Start an attack. chained = continuing a string (§6b): starts the track at chainIn, blending from the held pose.
   */
  _startAttack(m, chained, focusKind = null) {
    const info = moveInfo(m);
    const a = this.atk;
    const now = this.game.time;
    a.string = chained ? a.string + 1 : 1;
    a.info = info; a.move = m; a.phase = 'run'; a.holdT = 0; a.holdDur = 0;
    a.next = null; a.nextT = 0; a.win = -1; a.hitIds.length = 0; a.anyContact = false; a.struck = false;
    a.chargeable = !!info.props.charge && !focusKind;
    a.charging = false; a.chargeT = 0; a.chargeDone = false; a.chargeMult = 1; a.chargeBreak = false; a.chargeFull = false;
    a.trembleT = 0; a.trembleSign = 1;
    // the charge holds exactly on the authored anticipation extreme (moveInfo.chargeAt), never inside the strike
    a.chargePoint = clamp(info.chargeAt, (chained ? info.chainIn : 0) + 0.01, Math.max(0.01, info.firstStart - 0.04));
    a.struckAt = NEVER; a.stopServed = 0;
    a.focus = focusKind || null;
    a.exhausted = this.stamina <= 0;
    a.chained = !!chained;
    a.startedAt = now;
    a.aim = this.target || (this.team === 'player' ? this.combat.softTarget(this) : null);
    // unlocked with nobody in reach: the strike goes where the stick points
    const it = this.intent;
    a.aimYaw = !a.aim && Math.hypot(it.moveX, it.moveZ) > 0.3 ? Math.atan2(it.moveX, it.moveZ) : null;
    this.move = m;
    this.moveTime = chained ? info.chainIn : 0;
    this._focusPose = false;
    if (focusKind) {
      this.focus = Math.max(0, this.focus - (focusKind === 'sweep' ? T.FOCUS_SWEEP_COST : T.FOCUS_STRIKE_COST));
      this.focusReadyUntil = -NEVER;
    }
    this._spend(info.stamina);
    if (info.start && STANCES.includes(info.start)) this.stance = info.start;
    // the follow-up cross-fades from the exact (frozen) strike pose over CHAIN_BLEND: the "tiniest glimpse"
    if (chained) this._play(m, Math.max(T.CHAIN_BLEND_MIN, T.CHAIN_BLEND), { startAt: info.chainIn, fromCurrent: true });
    else this._play(m, T.ATTACK_FADE, { startAt: 0, fromCurrent: true });
    this._enter('attack');
    const ev = this.game.events;
    ev.emit('attackStart', { fighter: this, move: m, chained: !!chained, string: a.string, focus: a.focus });
    if (focusKind) ev.emit('focusAttack', { fighter: this, kind: focusKind, move: m });
  }

  /** Queue a follow-up press during an attack (the latest press wins). */
  _queue(kind) {
    const a = this.atk;
    a.next = kind;
    a.nextT = this.game.time;
    if (kind === 'dodge') { a.nextDir.x = this.bufDodge.x; a.nextDir.z = this.bufDodge.z; }
    this.buf[kind] = -NEVER;
  }

  _canChainAttack() {
    const a = this.atk;
    return a.string < T.STRING_MAX && !a.exhausted && !a.focus;
  }

  _attackStep(dt) {
    const a = this.atk, info = a.info;
    if (!info) { this._enter('idle'); return; }
    const now = this.game.time;
    // 1. new presses during the attack are queued for the chain point
    if (this._pressedNow('light')) this._queue('light');
    if (this._pressedNow('heavy')) this._queue('heavy');
    if (this._pressedNow('dodge')) this._queue('dodge');
    if (this._pressedNow('defend')) this._queue('defend');
    // 2. feint: guard tapped during the wind-up cancels the attack (half its stamina back)
    if (this._pressedNow('feint') && a.phase === 'run' && !a.focus && this.moveTime < info.firstStart) {
      this.buf.feint = -NEVER;
      this._feint();
      return;
    }
    // 3. facing
    const aim = this.target || a.aim;
    {
      const t = this.moveTime;
      const rate = a.phase === 'hold' ? T.TURN_RECOVER : t < info.firstStart ? T.TURN_STARTUP : t < info.lastEnd ? T.TURN_ACTIVE : T.TURN_RECOVER;
      if (aim && aim.alive) this._turnToward(aim.position, rate, dt);
      else if (a.aimYaw !== null && t < info.firstStart) this._turnTo(a.aimYaw, rate, dt);
    }
    // 4. the strike hold before a chained follow-up (§6b): the last form stays, then the next move starts
    if (a.phase === 'hold') {
      a.holdT += dt;
      if (a.holdT >= a.holdDur - 1e-6) this._doNext();
      return;
    }
    // 5. charge: the wind-up holds on its anticipation pose while the button is held (up to CHARGE_MAX). The move
    //    clock and the animator stop together, one step at a time, so the release resumes in sync with no hitch;
    //    a small alternating flinch makes the hold read as straining instead of a hang. Events: chargeStart,
    //    chargeFull (break earned: CHARGE_BREAK x CHARGE_MAX), chargeRelease (the strike goes), chargeCancel (hit / feint).
    // (the hold starts on the last step at or before chargePoint, so it never shows the first instant of the strike)
    if (a.chargeable && !a.chargeDone && this.moveTime + dt > a.chargePoint + 1e-6) {
      if (this.intent.charge && a.chargeT < T.CHARGE_MAX - 1e-6) {
        if (!a.charging) {
          a.charging = true;
          a.trembleT = 0;
          this.game.events.emit('chargeStart', { fighter: this, move: a.move, max: T.CHARGE_MAX });
        }
        a.chargeT = Math.min(T.CHARGE_MAX, a.chargeT + dt);
        this._freeze(dt);   // exactly this step (not longer): the animator stands still exactly while moveTime does
        a.trembleT -= dt;
        if (a.trembleT <= 0) {
          a.trembleT += T.CHARGE_TREMBLE_EVERY;
          const an = this.animator;
          if (an && typeof an.flinch === 'function') {
            _tremble.x = 0.3 * a.trembleSign;
            try { an.flinch(_tremble, T.CHARGE_TREMBLE); } catch (e) { /* optional */ }
          }
          a.trembleSign = -a.trembleSign;
        }
        // full = the charge now breaks guard (the cue goes out the moment break is earned, once)
        if (!a.chargeFull && a.chargeT >= T.CHARGE_MAX * T.CHARGE_BREAK - 1e-6) {
          a.chargeFull = true;
          this.game.events.emit('chargeFull', { fighter: this, move: a.move });
        }
        return;
      }
      a.charging = false;
      a.chargeDone = true;
      const k = Math.min(1, a.chargeT / T.CHARGE_MAX);
      a.chargeMult = 1 + T.CHARGE_DAMAGE * k;
      a.chargeBreak = k >= T.CHARGE_BREAK - 1e-6;
      if (a.chargeT > 0) this.game.events.emit('chargeRelease', { fighter: this, move: a.move, charge: k });
    }
    // 6. advance the move timeline
    const prev = this.moveTime;
    const t = (this.moveTime = prev + dt);
    this._lunge(info, t, dt);
    // active windows: trails + bookkeeping
    const hs = info.hits;
    for (let i = 0; i < hs.length; i++) {
      if (prev < hs[i].t && t >= hs[i].t) {
        this.game.fx?.trail?.(this, hs[i].limb, hs[i].dur + 0.06);
        this.game.events.emit('attackActive', { fighter: this, move: a.move, index: i, limb: hs[i].limb, dur: hs[i].dur });
      }
    }
    // end of the last active window: the strike is done, the fighter now flows into the END stance
    if (!a.struck && t >= info.lastEnd) {
      a.struck = true;
      a.struckAt = now;
      // from here on the attack is a committed stretch for the buffer: a stance flick (or, at the string cap, an
      // attack press) made after the strike waits for its legal time instead of expiring in the recovery
      this.lockT0 = now;
      this._committed = true;
      const from = this.stance;
      if (STANCES.includes(info.end) && info.end !== from) {
        this.stance = info.end;
        this.game.events.emit('stanceChanged', { fighter: this, from, to: info.end, byMove: true });
      }
      if (!a.anyContact) this.game.events.emit('attackWhiff', { fighter: this, move: a.move });
    }
    if (a.struck) {
      const next = a.next;
      // late = the strike ended steps ago and the pose is already relaxing into the recovery: no freeze, the
      // follow-up cross-fades (CHAIN_BLEND) straight from the current pose
      const late = t - info.lastEnd > dt * 1.5;
      if (next === 'light' || next === 'heavy') {
        if (this._canChainAttack()) {
          if (late) this._doNext();
          else this._beginHold(this._holdDur(info));
          return;
        }
        // string capped / exhausted / focus: a press made after the strike stays buffered and fires once attacks are
        // legal again (after the STRING_END lockout); presses from the wind-up / strike are dropped (no auto-restart)
        if (a.nextT >= a.struckAt - 1e-6) this.buf[next] = a.nextT;
        a.next = null;
      } else if (t >= info.cancel) {
        if ((next === 'dodge' || next === 'defend') && now - a.nextT > T.DEFENSIVE_QUEUE) a.next = null;
        if (!a.next && this.intent.guard) a.next = 'guard';
        if (a.next) {
          if (late) this._doNext();
          else this._beginHold(this._holdDur(info));
          return;
        }
      }
    }
    if (t >= info.duration) this._finishAttack();
  }

  /** Strike-form hold before an on-time follow-up: holdOut, minus the hitstop a connected hit already served. */
  _holdDur(info) {
    const a = this.atk;
    return a.anyContact ? Math.max(T.HOLD_MIN, info.holdOut - a.stopServed) : Math.max(T.HOLD_MIN, info.holdOut);
  }

  _beginHold(dur) {
    const a = this.atk;
    a.phase = 'hold';
    a.holdT = 0;
    a.holdDur = Math.max(0.016, dur);
    this._freeze(a.holdDur);
  }

  /** Execute the queued follow-up after the strike hold. */
  _doNext() {
    const a = this.atk;
    const k = a.next;
    a.next = null;
    a.phase = 'run';
    if (k === 'light' || k === 'heavy') {
      const fk = this._focusKindFor(k);
      const m = fk ? focusMove(fk, this.stance) : slotMove(this.deck, this.stance, k);
      this._startAttack(m, true, fk);
      return;
    }
    this._clearAttack();
    if (k === 'dodge') { this._startDodge(a.nextDir.x, a.nextDir.z, true); return; }
    if (k === 'defend') { this._startDefend(true); return; }
    // guard cancel: blend straight into the guard
    this._stop(T.CHAIN_BLEND);
    this._enter(this.intent.guard ? 'block' : 'idle');
  }

  _finishAttack() {
    const a = this.atk;
    const lock = (a.string >= T.STRING_MAX ? T.STRING_END : 0) + (a.exhausted ? T.EXHAUSTED_RECOVERY : 0);
    if (a.info && STANCES.includes(a.info.end)) this.stance = a.info.end;
    this._clearAttack();
    this._stop(0.1);
    // string end lockout: buffered presses / flicks made after the strike wait for it (committed stretch continues)
    if (lock > 0) this._recover(lock, NEVER, 0, 0, 0);
    else {
      this._enter('idle');
      // a stance flick made after the strike switches now (it waited through the recovery), then a press buffered
      // during the last recovery frames starts a new string
      this._freeActions();
    }
  }

  _feint() {
    const info = this.atk.info;
    this.stamina = Math.min(this.maxStamina, this.stamina + info.stamina * T.FEINT_REFUND);
    this.game.events.emit('feint', { fighter: this, move: this.atk.move });
    this._clearAttack();
    this._stop(0.08);
    this._recover(T.FEINT_RECOVERY, T.FEINT_ATTACK_AT, 0, 0, 0);
  }

  _lunge(info, t, dt) {
    const end = info.hits[0].end;
    if (t >= end || info.lunge <= 0) return;
    let sp = info.lunge / end;
    const aim = this.target || this.atk.aim;
    if (aim && aim.alive) {
      const dx = aim.position.x - this.position.x, dz = aim.position.z - this.position.z;
      const dist = Math.hypot(dx, dz);
      const contact = dist - aim.radius - this.radius;
      // stop at a natural striking distance instead of walking into the opponent
      if (contact < 0.2 || dist <= info.reach * 0.7) sp = 0;
      else {
        const gap = dist - info.reach * 0.85;     // magnetism: close a small gap so in-range-ish attacks connect
        if (gap > 0 && gap < 1.1 && t < info.firstStart) sp = Math.max(sp, Math.min(gap / Math.max(0.06, info.firstStart - t), 3.5));
        else if (gap < -0.4) sp *= 0.35;
      }
    }
    this.rootVel.x += Math.sin(this.yaw) * sp;
    this.rootVel.z += Math.cos(this.yaw) * sp;
  }

  // ============================================================================================ recover / switch

  /** Generic lockout. attackAt/defendAt/guardAt/dodgeAt = times within the state when those become allowed. */
  _recover(dur, attackAt, defendAt, guardAt, dodgeAt) {
    this._enter('recover', dur);
    const r = this.rec;
    r.attackAt = attackAt; r.defendAt = defendAt; r.guardAt = guardAt; r.dodgeAt = dodgeAt;
  }

  _recoverStep(dt) {
    const r = this.rec, t = this.stateTime;
    if (this.target) this._turnToward(this.target.position, T.TURN_RECOVER, dt);
    if (t >= r.dodgeAt && this._tryDodge(false)) return;
    if (t >= r.defendAt && this._tryDefend(false)) return;
    if (t >= r.attackAt && t < this.stateDur && this._tryAttack()) return;
    if (t >= r.guardAt && this.intent.guard && t < this.stateDur) { this._stop(0.08); this._enter('block'); return; }
    if (t >= this.stateDur) {
      this._stop(0.1);   // release whatever clip carried the recovery (dodge, parry...) back to locomotion
      this._enter(this.intent.guard ? 'block' : 'idle');
      this._freeStep(0);
    }
  }

  // ============================================================================================ dodge

  _tryDodge(chained) {
    if (!this._take('dodge')) return false;
    if (this.stamina <= 0) return false;
    this._startDodge(this.bufDodge.x, this.bufDodge.z, chained);
    return true;
  }

  _startDodge(dx, dz, chained) {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let len = Math.hypot(dx, dz);
    if (len < 0.25) { dx = -fx; dz = -fz; len = 1; }
    dx /= len; dz /= len;
    this.dodgeDir.set(dx, 0, dz);
    const f = dx * fx + dz * fz;
    const r = dx * -fz + dz * fx;
    const clip = Math.abs(f) >= Math.abs(r) ? (f > 0 ? 'dodge_forward' : 'dodge_back') : (r > 0 ? 'dodge_right' : 'dodge_left');
    this._spend(T.DODGE_COST);
    this._focusPose = false;
    this._play(clip, chained ? T.CHAIN_BLEND : 0.05);
    this._enter('dodge', T.DODGE_TIME);
    this.game.events.emit('dodge', { fighter: this, dir: clip.slice(6) });
    this.game.audio?.play?.('dodge', { position: this.position, volume: 0.7 });
  }

  _dodgeStep(dt) {
    const t = this.stateTime, u = clamp(t / T.DODGE_TIME, 0, 1);
    this.iframes = t >= T.DODGE_IFRAME_START && t <= T.DODGE_IFRAME_END;
    const v0 = (2 * T.DODGE_DIST) / T.DODGE_TIME;   // linear decay: distance = v0 * T / 2
    const sp = v0 * (1 - u);
    this.rootVel.x = this.dodgeDir.x * sp;
    this.rootVel.z = this.dodgeDir.z * sp;
    if (this.target) this._turnToward(this.target.position, T.TURN_DODGE, dt);
    if (t >= T.DODGE_TIME) {
      this.iframes = false;
      this._recover(T.DODGE_RECOVERY, T.DODGE_RECOVERY_ATTACK, 0.1, 0.1, T.DODGE_RECOVERY_DODGE);
    }
  }

  // ============================================================================================ defensive styles

  _tryDefend(chained) {
    if (!this._take('defend')) return false;
    this._startDefend(chained);
    return true;
  }

  _startDefend(chained) {
    const fade = chained ? T.CHAIN_BLEND : 0.04;
    const ab = this.ability;
    this._focusPose = false;
    if (ab === 'absorb') {
      this._spend(T.ABSORB_COST);
      this.absorbHits = 0;
      this._play('absorb', fade);
      this._enter('absorb', T.ABSORB_TIME);
    } else if (ab === 'avoid') {
      this._spend(T.AVOID_COST);
      // stick relative to facing: neutral = duck, back = jump, left / right = side step
      const it = this.intent;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const f = it.moveX * fx + it.moveZ * fz;
      const r = it.moveX * -fz + it.moveZ * fx;
      let kind = 'duck';
      if (Math.hypot(f, r) > 0.35) kind = Math.abs(r) > Math.abs(f) ? (r > 0 ? 'right' : 'left') : (f < 0 ? 'jump' : 'duck');
      this.avoidKind = kind;
      this.avoidSuccess = false;
      this._play('avoid_' + kind, fade);
      this._enter('avoid', T.AVOID_TIME[kind] || 0.35);
    } else {
      this._spend(T.PARRY_COST);
      this.parried = false;
      this._play('parry', fade);
      this._enter('parry', T.PARRY_WINDOW);
    }
    this.game.events.emit('defend', { fighter: this, kind: ab === 'avoid' ? 'avoid_' + this.avoidKind : ab });
  }

  _parryStep(dt) {
    if (this.target) this._turnToward(this.target.position, T.TURN_BLOCK, dt);
    if (this.stateTime >= T.PARRY_WINDOW) {
      // the window closed without a hit: vulnerable recovery
      this._recover(T.PARRY_FAIL, NEVER, NEVER, NEVER, NEVER);
      this.game.events.emit('parryFail', { fighter: this });
    }
  }

  /** Called by hits.js on a successful parry: the defender is free again at once. */
  _parrySuccess() {
    this.parried = true;
    this._enter('recover', 0.1);
    const r = this.rec; r.attackAt = 0; r.defendAt = 0; r.guardAt = 0; r.dodgeAt = 0;
  }

  _absorbStep(dt) {
    if (this.target) this._turnToward(this.target.position, T.TURN_BLOCK, dt);
    // a hit soaked = the counter is on: attacks may cancel the absorb
    if ((this.absorbHits > 0 || this.stateTime >= T.ABSORB_CANCEL_AFTER) && this._tryAttack()) return;
    if (this.stateTime >= this.stateDur) { this._stop(0.1); this._recover(0.12, 0, 0.06, 0, 0.06); }
  }

  _avoidStep(dt) {
    const t = this.stateTime;
    // side avoids slip a little sideways
    if (this.avoidKind === 'left' || this.avoidKind === 'right') {
      const u = clamp(t / T.AVOID_WINDOW, 0, 1);
      const sp = ((2 * T.AVOID_SIDE_DIST) / T.AVOID_WINDOW) * (1 - u);
      const sgn = this.avoidKind === 'right' ? 1 : -1;
      this.rootVel.x += -Math.cos(this.yaw) * sp * sgn;
      this.rootVel.z += Math.sin(this.yaw) * sp * sgn;
    }
    if (this.target) this._turnToward(this.target.position, T.TURN_DODGE, dt);
    if (this.avoidSuccess && this._tryAttack()) return;   // counter straight out of the slip
    if (t >= this.stateDur) { this._stop(0.1); this._enter('idle'); }
  }

  /** True while the avoid window is open. */
  get avoiding() { return this.state === 'avoid' && this.stateTime <= T.AVOID_WINDOW; }
  /** True while the parry window is open. */
  get parrying() { return this.state === 'parry' && this.stateTime <= T.PARRY_WINDOW; }

  // ============================================================================================ reactions (called by hits.js)

  _interrupt() {
    if (this.state === 'attack' && this.atk.info) {
      // stance: before the strike you are still in the start stance, after it in the end stance
      const info = this.atk.info;
      const st = this.moveTime >= info.lastEnd ? info.end : info.start;
      if (STANCES.includes(st)) this.stance = st;
    }
    this._clearAttack();
    this._focusPose = false;
  }

  enterHitstun(dur, clip) {
    const wasStunned = this.state === 'hitstun' || this.state === 'stagger';
    this.comboCount = wasStunned ? this.comboCount + 1 : 0;
    this._interrupt();
    this._play(clip, 0.03);
    this._enter('hitstun', dur);
  }

  enterStagger(dur, clip = 'parried') {
    const wasStunned = this.state === 'hitstun' || this.state === 'stagger';
    this.comboCount = wasStunned ? this.comboCount + 1 : 0;
    this._interrupt();
    this._play(clip, 0.04);
    this._enter('stagger', dur);
  }

  enterBlockstun(dur) {
    this._play('block_hit', 0.03);
    this._enter('blockstun', dur);
  }

  enterGuardBroken() {
    this._interrupt();
    this._play('guard_break', 0.04);
    this._enter('guardbroken', T.GUARDBREAK_TIME);
    this.game.events.emit('guardBroken', { fighter: this });
  }

  enterKnockdown() {
    this._interrupt();
    this.comboCount = 0;
    this._play('knockdown', 0.05);
    this._enter('knockdown', T.KNOCKDOWN_TIME);
    this.game.events.emit('knockdown', { fighter: this });
  }

  _die(killer) {
    this._interrupt();
    this.alive = false;
    this.health = 0;
    this.killer = killer || null;
    this.locoVel.set(0, 0, 0);
    this._play('death', 0.05);
    this._enter('dead');
    this.game.events.emit('fighterDied', { fighter: this, killer: killer || null });
  }

  _getup() {
    this._play('getup', 0.1);
    this._enter('getup', T.GETUP_TIME);
  }

  _blockstunStep(dt) {
    if (this.target) this._turnToward(this.target.position, T.TURN_BLOCK, dt);
    if (this.stateTime >= this.stateDur) {
      this._stop(0.08);
      this._enter(this.intent.guard ? 'block' : 'idle');
    }
    return 0.2;
  }

  _stunStep() {
    if (this.stateTime >= this.stateDur) {
      // a long juggle earns a short grace period so nobody gets locked forever
      if (this.comboCount + 1 >= T.COMBO_IMMUNITY_AT) this.graceUntil = this.game.time + T.COMBO_IMMUNITY;
      this.comboCount = 0;
      this._stop(0.12);
      this._enter(this.intent.guard ? 'block' : 'idle');
    }
  }

  _knockdownStep() { if (this.stateTime >= this.stateDur) this._getup(); }

  _getupStep() {
    if (this.stateTime >= this.stateDur) {
      this._stop(0.12);
      this.graceUntil = this.game.time + 0.15;
      this._enter('idle');
    }
  }

  // ============================================================================================ motion

  _turnTo(yawT, rate, dt) {
    const d = angleDiff(this.yaw, yawT);
    const m = rate * dt;
    this.yaw = wrapAngle(this.yaw + (d > m ? m : d < -m ? -m : d));
  }
  _turnToward(p, rate, dt) {
    const dx = p.x - this.position.x, dz = p.z - this.position.z;
    if (dx * dx + dz * dz < 1e-6) return;
    this._turnTo(yawTo(this.position.x, this.position.z, p.x, p.z), rate, dt);
  }

  /** Locomotion (speedMul > 0 in free-ish states), root motion and push, then the summed velocity. */
  _integrate(dt, speedMul) {
    let vx = 0, vz = 0;
    if (speedMul > 0 && this.alive) {
      const it = this.intent;
      let mx = +it.moveX || 0, mz = +it.moveZ || 0;
      let mag = Math.hypot(mx, mz);
      if (mag > 1) { mx /= mag; mz /= mag; mag = 1; }
      if (mag > 0.08) {
        const tgt = this.target;
        if (tgt) {
          // strafing relative to the target (facing is handled by the state)
          const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
          const f = mx * fx + mz * fz;
          const r = mx * -fz + mz * fx;
          let fs = f >= 0 ? T.WALK : T.BACK;
          // enemies may run to close a long gap
          if (this.team !== 'player' && f > 0.85 && mag > T.RUN_THRESHOLD && this.state === 'move') {
            const d = Math.hypot(tgt.position.x - this.position.x, tgt.position.z - this.position.z);
            if (d > T.ENEMY_RUN_DIST) fs = T.RUN;
          }
          const sf = f * fs, sr = r * T.STRAFE;
          vx = fx * sf + -fz * sr;
          vz = fz * sf + fx * sr;
        } else {
          // free movement: face where you go, run at full stick (unlocked)
          if (dt > 0) this._turnTo(Math.atan2(mx, mz), T.TURN_FREE, dt);
          const run = mag >= T.RUN_THRESHOLD && !this.intent.guard && this.state !== 'switch';
          const sp = run ? T.RUN : T.WALK * Math.min(1, mag * 1.15);
          vx = (mx / mag) * sp;
          vz = (mz / mag) * sp;
        }
        vx *= speedMul; vz *= speedMul;
      }
    }
    if (dt > 0) {
      const k = damp(T.ACCEL, dt);
      this.locoVel.x += (vx - this.locoVel.x) * k;
      this.locoVel.z += (vz - this.locoVel.z) * k;
      if (speedMul <= 0 && this.locoVel.lengthSq() < 1e-4) this.locoVel.set(0, 0, 0);
    }
    this.velocity.set(
      this.locoVel.x + this.rootVel.x + this.pushVel.x, 0,
      this.locoVel.z + this.rootVel.z + this.pushVel.z,
    );
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
  }

  /** Small debugging summary. */
  summary() {
    return {
      id: this.id, name: this.name, team: this.team, state: this.state, stance: this.stance, style: this.style,
      hp: +this.health.toFixed(1), maxHp: this.maxHealth, stamina: +this.stamina.toFixed(1), focus: +this.focus.toFixed(1),
      move: this.move ? this.move.id : null, moveTime: +this.moveTime.toFixed(3), phase: this.attackPhase,
      string: this.stringIndex, target: this.target ? this.target.id : null, alive: this.alive,
      pos: [+this.position.x.toFixed(2), +this.position.z.toFixed(2)], yaw: +this.yaw.toFixed(2),
    };
  }
}

