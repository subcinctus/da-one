// Brain: one enemy's decision making. Writes fighter.intent every 120 Hz sim step (FIGHTER.md §7 intent, §11 AI).
//
// Modes:   circle  (no attack token: hold a slot on the ring around the player, sway, taunt)
//          engage  (token: close to the planned opener's reach, wait out the cooldown)
//          windup  (the telegraph: stop, square up, optional stance switch, then the opener)
//          attack  (a planned string flowing stance to stance; follow-ups pressed during each strike so Combat
//                   chains them §6b-style; optional feint of the opener; charge holds)
//          backoff (step out after a string)   retreat (out of stamina)   taunt   stunned   phase (boss phase shift)
// Overlay: threat reactions to the player's attacks, decided after a 0.15-0.35 s reaction delay and executed with
//          imperfect timing (block / parry / avoid / absorb / dodge), counters after a successful defence, and whiff
//          punishes. The delay runs on a string clock (later hits of a string are timed from its opener, so they
//          can be answered), a read of an opener the player keeps repeating is answered at the 0.15 s fairness
//          floor, and an enemy squared up to a player who keeps swinging raises its guard now and then (pressure
//          guard: anticipation, dropped to attack). No allocations in update(): every scratch value lives on the
//          instance.
import { makeRng } from '../core/math.js';
import { info as moveInfoOf, deckReach, phase2Decks, signaturesOf } from './moveinfo.js';
import { makePlan, planString, pickLength, avoidKindFor } from './plan.js';
import { resolveProfile, BOSSES } from './archetypes.js';
import { BOSS_PHASE2, SPEAKERS, TAUNT_LINES } from '../levels/dialogue.js';

const FREE = { idle: true, move: true, block: true };
const DOWN = { knockdown: true, getup: true, dead: true };
const STUN = { hitstun: true, stagger: true, guardbroken: true, blockstun: true, knockdown: true, getup: true };
/** Fighter states from which a buffered counter press still comes out (parry recover, avoid / absorb counters). */
const COUNTER_OK = { idle: true, move: true, block: true, recover: true, avoid: true, absorb: true };
const ABILITY = { forsaken: 'parry', kahlt: 'absorb', windfall: 'avoid' };
/** Fairness floor (FIGHTER.md §11): no reaction is ever decided sooner than this after the attack starts. */
const REACT_FLOOR = 0.15;
/** Below this time-to-hit a reaction is simply too late (about one sim step: the guard / parry would not be up). */
const REACT_LATE = 0.01;
/** Share of block / dodge chance a fully smart fighter turns into its style ability against a read opener. */
const READ_SHIFT = 0.75;
/** Chance (x profile.smart) to feint-cancel its own wind-up to defend a strike that would land first (Absolver). */
const CANCEL_SMART = 0.6;

export class Brain {
  /**
   * @param {object} ai the AI system
   * @param {object} fighter the Fighter it drives
   * @param {string} archetype 'thug' | 'brawler' | 'swift' | 'heavy' | boss id
   * @param {number} seed RNG seed
   */
  constructor(ai, fighter, archetype, seed) {
    this.ai = ai;
    this.game = ai.game;
    this.fighter = fighter;
    const bossId = BOSSES[archetype] ? archetype : (fighter && BOSSES[fighter.boss] ? fighter.boss : null);
    this.bossId = bossId;
    this.archetype = bossId || archetype;
    this.phase = 0;
    this.profile = resolveProfile(this.archetype, 0, ai.chapterIndex);
    this.rng = makeRng(seed >>> 0);

    this.mode = 'circle';
    this.modeT = 0;
    this.modeDur = 0;
    this.dormant = false;
    this.wakeAt = -1;

    // attack token (crowd director)
    this.hasToken = false;
    this.tokenAt = -1e9;
    this.tokenRestUntil = 0;
    this.lastTokenEnd = ai.game.time || 0;
    this.stringsLeft = 0;
    this.nextStringAt = 0;
    this.stringsSinceSig = 0;

    // string plan
    this.plan = makePlan();
    this.planStance = 'FR';
    this.planIdx = 0;
    this.serial = 0;            // own attackStart counter
    this.followFor = -1;        // serial whose follow-up was already decided
    this.followLead = 0.04;
    this.pressedAt = -1;
    this.serialAtPress = 0;
    this.stringOn = false;
    this._phasePosed = false;
    this.feintThis = false;
    this.feintAt = 0;
    this.feinted = false;
    this.feintFollowed = false;
    this.chargeUntil = 0;
    this.urgentAt = -1;
    this.urgentFast = 0;
    this.telegraphSig = false;
    this.approachGuard = false;
    this.engageDist = 1.6;
    this.startDist = 1.9;

    // incoming threat (reaction overlay)
    this.th = { on: false, attacker: null, move: null, info: null, hitAt: 0, decideAt: 0, decided: false, choice: null,
      lead: 0, pressed: false, avoidKind: 'duck', side: 1, guardEnd: 0, keep: false, read: false, reactAt: 0,
      cancel: false, stringBy: null, stringT0: -1e9 };
    this.guardUntil = 0;
    this.pressGuardUntil = 0;   // pressure guard (anticipation while the player keeps swinging), dropped to attack
    this.lastHitAt = -1e9;
    this.hitsTaken = 0;

    // movement
    this.slotAngle = 0;
    this.slotRadius = 3.6;
    this.ringPick = this.rng();
    this._rel = 0;             // director scratch (bearing relative to the player's facing)
    this.swayDir = this.rng() < 0.5 ? -1 : 1;
    this.swayUntil = 0;
    this.tauntCool = 4 + this.rng() * 6;
    this.dist = 99;
    this._mx = 0;
    this._mz = 0;
    this._noSep = false;
    this.reach = 1.6;
    this._ctx = {
      deck: null, stance: 'FR', len: 1, budget: 100, heavyBias: 0, sigBias: 0, sigOnly: false, habits: ai.habits.rates,
      dist: 0, fast: 0, allowSwitch: false, switchCost: 5, switchPenalty: 5, rng: this.rng, noise: 3,
      recent: null, openers: null, lastOpenStance: null, sigLRU: null, sigMRU: null,
    };
    // defends = executed parry / avoid / absorb / dodge presses (abilities = the style ones); blocks = block choices;
    // reads = defensive choices made on a read opener; guards = pressure guards raised; turtles = guard after a combo
    this.stats = { strings: 0, attacks: 0, defends: 0, counters: 0, punishes: 0, feints: 0, abilities: 0, blocks: 0,
      reads: 0, guards: 0, turtles: 0, cancels: 0 };
    this.comboHits = 0;
    this.recent = ['', '', '', ''];
    this.recentIdx = 0;
    // own string openers, most recent first (the planner avoids repeating them), the stance the last one came from,
    // and when each signature was last thrown (signature-only strings rotate to the least recently used one)
    this.openers = ['', '', ''];
    this.lastOpenStance = null;
    this.sigIds = [];
    this.sigLast = {};
    this.hasSigs = false;
    this._phasePending = false;
    this._ctx.recent = this.recent;
    this._ctx.openers = this.openers;
    this.refreshReach();
  }

  /** Re-read deck-dependent data (after a deck swap). */
  refreshReach() {
    const deck = this.fighter && this.fighter.deck;
    this.reach = deckReach(deck);
    this.sigIds = signaturesOf(deck);
    this.hasSigs = this.sigIds.length > 0;
  }

  // ============================================================================================ public hooks

  /** Keep standing (encounter staging / boss intro) until wake(). */
  sleep() { this.dormant = true; this.wakeAt = -1; this._setMode('circle'); }
  /** Start fighting after `delay` sim seconds. */
  wake(delay = 0) {
    if (!this.dormant) return;
    if (delay > 0) { this.wakeAt = this.game.time + delay; return; }
    this.dormant = false;
    this.wakeAt = -1;
    this.nextStringAt = this.game.time + 0.4 + this.rng() * 0.6;
    this.lastTokenEnd = this.game.time;
    this._setMode('circle');
  }

  /** The player started an attack (attackStart). Schedules a reaction if the strike threatens this fighter. */
  onThreat(attacker, move, chained, now) {
    const f = this.fighter;
    if (!f.alive || this.dormant) return;
    const th = this.th, pr = this.profile;
    // string clock: when this attacker's current string began (even if its opener was not aimed at me)
    if (!chained || th.stringBy !== attacker) { th.stringBy = attacker; th.stringT0 = now; }
    const inf = moveInfoOf(move);
    if (!inf) return;
    const dx = f.position.x - attacker.position.x, dz = f.position.z - attacker.position.z;
    const d = Math.hypot(dx, dz);
    if (d > inf.reach + (f.radius || 0.35) + inf.lunge + 0.7) return;
    // aimed at me: locked on me, or I stand inside the swing's cone (with margin for turning)
    if (attacker.target !== f) {
      const ang = Math.abs(wrap(Math.atan2(dx, dz) - attacker.yaw));
      if (ang > inf.arcHalf + 0.45 && d > 1.0) return;
    }
    const st = f.state;
    // guard already up (or reeling behind it): holding it is not a reaction, so decide at once
    th.keep = now < this.guardUntil || this._pressGuardOn(now) || st === 'block' || st === 'blockstun';
    th.on = true;
    th.attacker = attacker;
    th.move = move;
    th.info = inf;
    th.hitAt = now + Math.max(0.02, inf.firstHit - (chained ? inf.chainIn : 0));
    // a read: the player keeps opening with this move, so it is answered at the fairness floor (Absolver: mix up)
    th.read = !!(this.ai.isRead && this.ai.isRead(inf.id));
    const react = th.read ? REACT_FLOOR : Math.max(REACT_FLOOR, pr.reaction[0] + this.rng() * (pr.reaction[1] - pr.reaction[0]));
    // later hits of a string are timed from its opener: the reaction to the string has already happened.
    // reactAt gates every defensive press; holding a guard that is already up is not a reaction (decided at once).
    th.reactAt = chained ? Math.max(now, th.stringT0 + react) : now + react;
    th.decideAt = th.keep ? now : th.reactAt;
    th.decided = false;
    th.choice = null;
    th.pressed = false;
    th.cancel = false;
  }

  /** One of this fighter's own attacks started (attackStart). */
  onOwnAttackStart(move, chained, now) {
    this.serial++;
    const inf = moveInfoOf(move);
    if (chained) this.planIdx++;
    else { this.planIdx = 0; this.feinted = false; }
    this.stats.attacks++;
    if (inf) {
      this.recent[this.recentIdx++ & 3] = inf.id;
      if (!chained) {
        const o = this.openers;
        for (let k = o.length - 1; k > 0; k--) o[k] = o[k - 1];
        o[0] = inf.id;
        this.lastOpenStance = inf.start;
      }
      if (inf.signature) { this.stringsSinceSig = 0; this.sigLast[inf.id] = now; }
    }
    // charge moves: hold the button through the charge point for a while
    if (inf && inf.charge) {
      const pr = this.profile;
      const hold = pr.charge[0] + this.rng() * (pr.charge[1] - pr.charge[0]);
      // combat holds the charge on the move's chargeAt (move time); a chained move starts its clock at chainIn
      const point = Math.max(0.01, inf.chargeAt - (chained ? inf.chainIn : 0));
      this.chargeUntil = hold > 0.05 ? now + point + hold : 0;
    } else this.chargeUntil = 0;
  }

  /** This fighter defended successfully: kind 'parry' | 'avoid' | 'absorb' | 'block' | 'dodge'. */
  onDefended(kind, now) {
    const pr = this.profile;
    let p = pr.counter;
    if (kind === 'block') p *= 0.4;
    else if (kind === 'dodge') p *= 0.6;
    if (this.rng() >= p) return;
    const lo = kind === 'avoid' ? 0.03 : kind === 'parry' ? 0.06 : kind === 'block' ? 0.12 : 0.05;
    this._urgent(now + lo + this.rng() * 0.08, 1);
    this.stats.counters++;
  }

  /** The player whiffed an attack (attackWhiff): punish chance when close enough. */
  onPlayerWhiff(now) {
    if (this.dormant || !this.fighter.alive || this.dist > this.reach + 1.2) return;
    if (this.rng() >= this.profile.punish) return;
    const pr = this.profile;
    this._urgent(now + pr.reaction[0] + this.rng() * (pr.reaction[1] - pr.reaction[0]) * 0.7, 1);
    this.stats.punishes++;
  }

  /** This fighter took a clean hit. */
  onHit(now) {
    // hits closer together than this belong to the same combo
    this.comboHits = now - this.lastHitAt < 0.8 ? this.comboHits + 1 : 1;
    this.lastHitAt = now;
    this.hitsTaken++;
    this.th.on = false;
    this.urgentAt = -1;
    if (this.dormant) this.wake(0);
    // after eating a combo, some turtle up for a moment (the player has to mix up / break the guard); one roll per combo
    if (this.comboHits === 2 && this.rng() < this.profile.block * 0.5) {
      this.guardUntil = Math.max(this.guardUntil, now + 0.45 + this.rng() * 0.5);
      this.stats.turtles++;
    }
  }

  /** Director granted / revoked the attack token. */
  grantToken(now) {
    if (this.hasToken) return;
    this.hasToken = true;
    this.tokenAt = now;
    const pr = this.profile;
    this.stringsLeft = pr.tokenStrings[0] + Math.floor(this.rng() * (pr.tokenStrings[1] - pr.tokenStrings[0] + 1));
    if (this.mode === 'circle' || this.mode === 'backoff') this._setMode('engage');
  }
  revokeToken(now, rest) {
    if (!this.hasToken) return;
    this.hasToken = false;
    this.lastTokenEnd = now;
    this.tokenRestUntil = now + (rest ?? this.profile.tokenRest);
    if (this.mode === 'engage' || this.mode === 'windup') this._setMode('circle');
  }

  // ============================================================================================ step

  /** Write fighter.intent for this sim step. */
  update(dt, now) {
    const f = this.fighter;
    const it = f.intent;
    this.modeT += dt;
    const p = this.ai.target(f);
    it.lockTarget = p;
    it.charge = false;
    this._mx = 0; this._mz = 0;
    if (!f.alive) { it.moveX = 0; it.moveZ = 0; it.guard = false; return; }
    if (this.dormant) {
      if (this.wakeAt >= 0 && now >= this.wakeAt) { this.wakeAt = -1; this.wake(0); }
      if (this.dormant) { it.moveX = 0; it.moveZ = 0; it.guard = false; return; }
    }
    if (!p) {
      // nobody to fight (player dead / gone): let go of everything and stand down
      if (this.stringOn) this._endString(now, false);
      if (this.mode !== 'circle' && this.mode !== 'taunt') this._setMode('circle');
      this.urgentAt = -1;
      it.moveX = 0; it.moveZ = 0; it.guard = false;
      this.th.on = false;
      return;
    }
    const dx = p.position.x - f.position.x, dz = p.position.z - f.position.z;
    const dist = Math.hypot(dx, dz) || 1e-3;
    this.dist = dist;
    const ux = dx / dist, uz = dz / dist;

    // boss phase 2 at 50%
    if (this.bossId && this.phase === 0 && f.health <= f.maxHealth * 0.5) this._enterPhase2(now);

    const st = f.state;
    const free = FREE[st] === true;
    let guard = false;

    // ---- reaction overlay (may own this step)
    if (this._threatStep(now, free)) {
      this._finish(it, now, guard);
      return;
    }

    // ---- urgent attacks (counters / punishes) bypass the telegraph-length wait but keep a short beat
    if (this.urgentAt >= 0 && now >= this.urgentAt && !((st === 'blockstun' || st === 'switch') && now - this.urgentAt < 0.35)) {
      this.urgentAt = -1;
      if (COUNTER_OK[st] && !DOWN[p.state] && this.ai.director.tryGrant(this, true, now)) {
        this._startUrgent(now, dist, st);
        if (this.mode === 'attack') { this._finish(it, now, guard); return; }
      }
    }

    // ---- stunned / not in control
    if (STUN[st] && this.mode !== 'attack' && this.mode !== 'phase') {
      if (this.mode !== 'stunned') this._setMode('stunned');
    }

    // ---- pressure guard (anticipation, not a reaction)
    if (this.mode === 'engage' || this.mode === 'circle') this._pressureGuard(dt, now, p, dist, free);

    switch (this.mode) {
      case 'circle': this._circle(dt, now, p, dist, ux, uz, free); break;
      case 'engage': guard = this._engage(dt, now, p, dist, ux, uz, free); break;
      case 'windup': this._windup(dt, now, p, dist, ux, uz, free); break;
      case 'attack': this._attack(dt, now, p, dist, st); break;
      case 'backoff': guard = this._backoff(dt, now, p, dist, ux, uz); break;
      case 'retreat': this._retreat(dt, now, p, dist, ux, uz); break;
      case 'taunt': this._taunt(dt, now, p, dist); break;
      case 'phase': this._phaseShift(dt, now, p, dist, ux, uz); break;
      case 'stunned':
      default:
        if (free) {
          // recovered: step out briefly, then back to work
          this._setMode('backoff');
          this.modeDur = 0.2 + this.rng() * 0.3;
        }
        break;
    }
    this._finish(it, now, guard);
  }

  _finish(it, now, guard) {
    // separation from allies so the crowd never stacks (not on the step an avoid reads the stick)
    if (this._noSep) this._noSep = false; else this._separate();
    let mx = this._mx, mz = this._mz;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    it.moveX = mx; it.moveZ = mz;
    it.guard = guard || this._pressGuardOn(now) || now < this.guardUntil;
  }

  _setMode(m, dur = 0) {
    this.mode = m; this.modeT = 0; this.modeDur = dur;
    if (m === 'engage') { this.plan.len = 0; this.approachGuard = this.rng() < this.profile.guardUp; }
  }

  // ============================================================================================ modes

  _circle(dt, now, p, dist, ux, uz, free) {
    const f = this.fighter, pr = this.profile;
    if (f.stamina < pr.staminaFloor) { this._setMode('retreat'); return; }
    if (this.hasToken) { this._setMode('engage'); return; }
    // hold the slot handed out by the director (an orbit position on the ring)
    const R = this.slotRadius;
    const tx = p.position.x + Math.sin(this.slotAngle) * R, tz = p.position.z + Math.cos(this.slotAngle) * R;
    const ex = tx - f.position.x, ez = tz - f.position.z;
    const ed = Math.hypot(ex, ez);
    if (ed > 0.45) {
      // walk around (tangential first) rather than through the player
      let sx = ex / ed, sz = ez / ed;
      const radial = sx * ux + sz * uz;          // > 0 means "toward the player"
      if (radial > 0.3 && dist < R + 0.5) { sx -= ux * radial; sz -= uz * radial; }
      const sp = Math.min(1, ed / 1.2) * Math.max(pr.circle, ed > 2.5 ? pr.speed : pr.circle);
      this._mx += sx * sp; this._mz += sz * sp;
    } else {
      // at the slot: sway sideways a little (alive, readable), keep the radius
      if (now >= this.swayUntil) { this.swayDir = -this.swayDir; this.swayUntil = now + 0.9 + this.rng() * 1.4; }
      const tsx = -uz * this.swayDir, tsz = ux * this.swayDir;
      this._mx += tsx * pr.circle * 0.45; this._mz += tsz * pr.circle * 0.45;
    }
    // the player walks into a circler: give ground, maybe guard
    if (dist < this.profile.ring[0] - 0.6) { this._mx -= ux * 0.6; this._mz -= uz * 0.6; }
    // taunt now and then (never while the player is close or attacking)
    this.tauntCool -= dt;
    if (this.tauntCool <= 0 && free) {
      this.tauntCool = 7 + this.rng() * 9;
      if (pr.taunt > 0 && dist > 3 && ed < 0.8 && this.rng() < 0.35 * pr.taunt && this.ai.claimTaunt(now, this)) {
        this._setMode('taunt', 1.3);
        const an = f.animator;
        try { if (an && typeof an.playAction === 'function') an.playAction('taunt', { fade: 0.15, fromCurrent: true }); } catch (e) { /* anim optional */ }
        if (this.rng() < 0.45 * pr.bark) this.ai.bark(f, TAUNT_LINES[Math.floor(this.rng() * TAUNT_LINES.length)], 'taunt');
      }
    }
  }

  _engage(dt, now, p, dist, ux, uz, free) {
    const f = this.fighter, pr = this.profile;
    if (!this.hasToken) { this._setMode('circle'); return false; }
    if (f.stamina < pr.staminaFloor) { this.ai.director.release(this, now); this._setMode('retreat'); return false; }
    // the player is on the floor: hover, never pile on (Sifu / Absolver manners)
    if (DOWN[p.state]) { this._keepAt(dist, ux, uz, 2.6, pr.speed * 0.6); return false; }
    if (this.plan.len === 0) { this._plan(now, dist, 0); if (this.plan.len === 0) { this._setMode('backoff', 0.6); return false; } }
    if (dist > this.startDist) {
      // close in (enemies run when far: stick fully forward), drifting toward its flank
      const sp = dist > 4.5 ? 1 : pr.speed;
      this._mx += ux * sp; this._mz += uz * sp;
      this._flankSteer(ux, uz, 0.55);
      if (this.modeT > 4.5 && dist > this.startDist + 2.5) { this.ai.director.release(this, now, 0.5); this._setMode('circle'); }
      return this.approachGuard && dist < 3.2;
    }
    if (now >= this.nextStringAt && free && this.ai.director.canOpen(this, now)) {
      this._beginWindup(now);
      return false;
    }
    // in range, cooling down: hold just outside the opener's reach, on its flank, and sidestep a little
    this._keepAt(dist, ux, uz, this.engageDist + 0.45, pr.speed * 0.8);
    if (!this._flankSteer(ux, uz, 0.5)) {
      if (now >= this.swayUntil) { this.swayDir = -this.swayDir; this.swayUntil = now + 0.6 + this.rng() * 0.9; }
      this._mx += -uz * this.swayDir * 0.3; this._mz += ux * this.swayDir * 0.3;
    }
    return this.approachGuard;
  }

  _beginWindup(now) {
    const pr = this.profile;
    this.pressGuardUntil = 0;   // the guard drops to attack (part of the read)
    const first = this.plan.moves[0];
    this.telegraphSig = !!(first && first.signature);
    const dur = (pr.telegraph[0] + this.rng() * (pr.telegraph[1] - pr.telegraph[0])) + (this.telegraphSig ? 0.12 : 0);
    this._setMode('windup', dur);
    this.ai.director.noteOpen(this, now);
    if (this.plan.switchTo && this.plan.switchTo !== this.fighter.stance) this.fighter.intent.stance = this.plan.switchTo;
    this.game.events.emit('enemyTelegraph', { fighter: this.fighter, move: first ? first.move : null, moveId: first ? first.id : null,
      signature: this.telegraphSig, duration: dur, heavy: !!(first && (first.weight === 'heavy' || first.brk)) });
  }

  _windup(dt, now, p, dist, ux, uz, free) {
    const f = this.fighter;
    if (DOWN[p.state] || !this.hasToken) { this._setMode(this.hasToken ? 'engage' : 'circle'); return; }
    if (dist > this.startDist + 1.3) { this._setMode('engage'); return; }
    // square up: drift into range, no guard (the drop of the guard is part of the read)
    if (dist > this.engageDist) { this._mx += ux * 0.5; this._mz += uz * 0.5; }
    const sw = this.plan.switchTo;
    if (sw && f.stance !== sw) {
      if (free && this.modeT > 0.25) f.intent.stance = sw;   // retry a lost switch request
      if (this.modeT > 1.0) { this.plan.switchTo = null; this._plan(now, dist, 0); }
      return;
    }
    if (this.modeT < this.modeDur || !free || now < this.guardUntil) return;
    // the stance may have changed since planning (a hit, a switch): re-plan from where we are
    if (f.stance !== (sw || this.planStance)) this._plan(now, dist, 0, false);
    this._pressOpener(now);
  }

  _pressOpener(now) {
    const pr = this.profile;
    this.pressGuardUntil = 0;
    if (this.plan.len <= 0) { this._setMode('backoff', 0.4); return; }
    this._press(this.plan.kinds[0]);
    this.pressedAt = now;
    this.serialAtPress = this.serial;
    this.planIdx = 0;
    this.followFor = -1;
    this.followLead = 0.01 + this.rng() * 0.07;
    this.feintThis = pr.feint > 0 && this.rng() < pr.feint && this.plan.moves[0] && this.plan.moves[0].firstHit > 0.16;
    this.feintAt = this.feintThis ? this.plan.moves[0].firstHit * (0.35 + this.rng() * 0.3) : 0;
    this.feintFollowed = false;
    this.stringOn = true;
    this.stats.strings++;
    this.stringsSinceSig++;
    this._setMode('attack');
  }

  _attack(dt, now, p, dist, st) {
    const f = this.fighter, it = f.intent;
    if (st === 'attack') {
      const inf = moveInfoOf(f.move);
      if (!inf) return;
      const mt = f.moveTime || 0;
      it.charge = now < this.chargeUntil;
      // feint the opener (guard tap during the wind-up), then attack for real right after
      if (this.feintThis && this.planIdx === 0 && mt >= this.feintAt && mt < inf.firstHit - 0.04) {
        it.feint = true;
        this.feintThis = false;
        this.feinted = true;
        this.stats.feints++;
        this.game.events.emit('aiFeint', { fighter: f, move: f.move });
        return;
      }
      // follow-up: pressed while the current strike lands, so the chain holds the strike form then flows on (§6b)
      const next = this.planIdx + 1;
      if (next < this.plan.len && this.followFor !== this.serial && mt >= inf.firstHit - this.followLead) {
        this.followFor = this.serial;
        if (this._shouldContinue(p, dist, next)) this._press(this.plan.kinds[next]);
        else this.plan.len = next;
      }
      return;
    }
    if (st === 'recover' && this.feinted && !this.feintFollowed) {
      // the real attack out of the feint: quick, from the same stance
      this.feintFollowed = true;
      this._plan(now, dist, 0.6, false);
      if (this.plan.len > 0) { this._press(this.plan.kinds[0]); this.followFor = -1; }
      return;
    }
    if (st === 'switch' || st === 'recover') return;
    if (FREE[st]) {
      // the opener may not have come out yet (one step of latency, or buffered behind a stance switch)
      if (this.serial === this.serialAtPress && now - this.pressedAt < 0.28) return;
      this._endString(now, false);
      return;
    }
    // interrupted (hit, parried, guard broken...)
    this._endString(now, true);
  }

  _shouldContinue(p, dist, idx) {
    const f = this.fighter;
    if (!p.alive || DOWN[p.state]) return false;
    const m = this.plan.moves[idx];
    if (!m) return false;
    if (f.stamina < m.stamina * 0.6) return false;
    if (dist > m.reach + m.lunge + 1.0) return false;
    // the player slipped away: sometimes press on anyway (pressure), sometimes reset
    if ((p.state === 'dodge' || p.state === 'avoid') && this.rng() < 0.5) return false;
    return true;
  }

  _endString(now, interrupted) {
    const pr = this.profile;
    this.stringOn = false;
    this.feintThis = false;
    this.chargeUntil = 0;
    this.plan.len = 0;
    this.nextStringAt = now + (pr.cooldown[0] + this.rng() * (pr.cooldown[1] - pr.cooldown[0])) * (1.25 - 0.5 * pr.aggression);
    if (this.hasToken) {
      this.stringsLeft--;
      if (this.stringsLeft <= 0 && !this.bossId) this.ai.director.release(this, now);
    }
    if (this._phasePending) { this._phasePending = false; this._setMode('phase', 1.25); return; }
    if (interrupted) { this._setMode('stunned'); return; }
    this._setMode('backoff', pr.backoff[0] + this.rng() * (pr.backoff[1] - pr.backoff[0]));
  }

  _backoff(dt, now, p, dist, ux, uz) {
    const f = this.fighter, pr = this.profile;
    // step out to a little beyond the opener's reach, strafing a touch
    const want = this.hasToken ? this.engageDist + 1.0 : pr.ring[0];
    if (dist < want) { this._mx -= ux * 0.75; this._mz -= uz * 0.75; }
    this._mx += -uz * this.swayDir * 0.3; this._mz += ux * this.swayDir * 0.3;
    if (this.modeT >= this.modeDur) {
      if (f.stamina < pr.staminaFloor) this._setMode('retreat');
      else this._setMode(this.hasToken ? 'engage' : 'circle');
    }
    return this.profile.guardUp > 0.3 && dist < 2.4 && f.stamina > 30;
  }

  _retreat(dt, now, p, dist, ux, uz) {
    const f = this.fighter, pr = this.profile;
    // out of breath: open the distance, guard down (it regenerates faster)
    if (this.hasToken && !this.bossId) this.ai.director.release(this, now);
    if (dist < pr.ring[1] + 0.3) { this._mx -= ux * 0.85; this._mz -= uz * 0.85; }
    this._mx += -uz * this.swayDir * 0.25; this._mz += ux * this.swayDir * 0.25;
    if (f.stamina >= pr.staminaResume) this._setMode(this.hasToken ? 'engage' : 'circle');
  }

  _taunt(dt, now, p, dist) {
    // stand and gesture; break off if the player comes close or swings
    if (this.modeT >= this.modeDur || dist < 2.4 || (p.state === 'attack' && dist < 3.6) || !FREE[this.fighter.state]) {
      if (this.modeT < this.modeDur && FREE[this.fighter.state]) {
        const an = this.fighter.animator;
        try { if (an && typeof an.stopAction === 'function') an.stopAction(0.12); } catch (e) { /* ignore */ }
      }
      this._setMode('circle');
    }
  }

  _phaseShift(dt, now, p, dist, ux, uz) {
    const f = this.fighter;
    // a breath between phases: step out, posture, then a new rhythm
    if (this.modeT < 0.35) { if (dist < 3.2) { this._mx -= ux; this._mz -= uz; } return; }
    if (!this._phasePosed && FREE[f.state]) {
      this._phasePosed = true;
      const an = f.animator;
      try { if (an && typeof an.playAction === 'function') an.playAction('taunt', { fade: 0.15, fromCurrent: true }); } catch (e) { /* ignore */ }
    }
    if (this.modeT >= this.modeDur) {
      const an = f.animator;
      try { if (an && typeof an.stopAction === 'function' && FREE[f.state]) an.stopAction(0.12); } catch (e) { /* ignore */ }
      this.nextStringAt = now + 0.2;
      this._setMode('engage');
    }
  }

  // ============================================================================================ reactions

  /**
   * Pressure guard: squared up (engage / circle) to a player who is in range, facing me and has swung within the
   * last 1.5 s, the guard comes up for 0.4-0.8 s at a rate of block x 0.5 per second. Respects the stamina floor;
   * dropped the moment this enemy decides to attack (_beginWindup / _pressOpener / _startUrgent).
   */
  /** The pressure guard is up (only ever written in engage / circle). */
  _pressGuardOn(now) { return now < this.pressGuardUntil && (this.mode === 'engage' || this.mode === 'circle'); }

  _pressureGuard(dt, now, p, dist, free) {
    const f = this.fighter, pr = this.profile;
    if (f.stamina < pr.staminaFloor) { this.pressGuardUntil = 0; return; }
    if (now < this.pressGuardUntil || !free) return;
    const ai = this.ai;
    if (now - (ai.playerAttackAt ?? -1e9) > 1.5) return;
    if (dist > (ai.playerReach || 1.6) + 0.4) return;
    if (p.target !== f) {
      const ang = Math.abs(wrap(Math.atan2(f.position.x - p.position.x, f.position.z - p.position.z) - p.yaw));
      if (ang > 0.7) return;
    }
    if (this.rng() < pr.block * 0.5 * dt) { this.pressGuardUntil = now + 0.4 + this.rng() * 0.4; this.stats.guards++; }
  }

  /** Returns true while a defensive action owns this step. */
  _threatStep(now, free) {
    const th = this.th;
    if (!th.on) return false;
    const a = th.attacker;
    const f = this.fighter;
    if (th.pressed) {
      // let the defensive state play out
      const s = f.state;
      if (s === 'parry' || s === 'avoid' || s === 'absorb' || s === 'dodge') return true;
      th.on = false;
      return false;
    }
    if (!a || !a.alive || a.state !== 'attack' || a.move !== th.move) { th.on = false; return false; }
    if (typeof a.timeToHit === 'function') {
      const t = a.timeToHit();
      if (t > 0) th.hitAt = now + t;
      else if (t === 0) th.hitAt = Math.min(th.hitAt, now);
      else if (th.hitAt < now + 0.05) th.hitAt = now + 0.05;   // charging: unknown, keep waiting
    }
    if (!th.decided) {
      if (now < th.decideAt - 1e-6) return false;
      th.decided = true;
      this._decide(now, free);
      if (th.cancel && !th.decided) return true;   // own wind-up feinted this step: defend from its recovery next
      if (th.choice) {
        if (th.read) this.stats.reads++;
        if (th.choice === 'block') this.stats.blocks++;
        if (this.mode === 'windup') this._setMode('engage');
      }
    }
    const c = th.choice;
    if (!c) return false;
    if (c === 'block') {
      this.guardUntil = Math.max(this.guardUntil, th.hitAt + th.guardEnd);
      if (now > th.hitAt + th.guardEnd) { th.on = false; return false; }
      return true;   // stand and block (guard written by _finish)
    }
    if (now >= th.hitAt - th.lead && now >= th.reactAt - 1e-6) {
      const ok = free || f.state === 'switch' || (th.cancel && f.state === 'recover');
      if (!ok) { th.on = false; return false; }   // got hit / busy meanwhile
      this._executeDefence(c);
      th.pressed = true;
      this.stats.defends++;
      if (c !== 'dodge') this.stats.abilities++;
    }
    return true;
  }

  _decide(now, free) {
    const th = this.th, f = this.fighter, pr = this.profile, inf = th.info;
    th.choice = null;
    const tth = th.hitAt - now;
    const st = f.state;
    // the feint recovery allows defend / guard at once (combat _feint), so a cancelled wind-up can still defend
    const canMove = free || st === 'switch' || (th.cancel && st === 'recover');
    const canBlock = canMove || st === 'blockstun';
    if (tth < REACT_LATE && !th.keep) return;   // simply too late
    if (!canBlock) {
      // busy attacking: trade, unless it is smart enough to feint its own wind-up (Absolver) to defend a strike that
      // lands before its own. Decided after the reaction delay like any reaction; the defence follows next step.
      if (st === 'attack' && !th.cancel && this._canCancel(tth) && this.rng() < pr.smart * CANCEL_SMART) {
        f.intent.feint = true;
        th.cancel = true;
        th.decided = false;
        th.decideAt = now;
        this.stats.cancels++;
        if (this.stringOn) this._endString(now, false);   // the string is over (and a counter can follow the defence)
      }
      return;
    }
    const ab = ABILITY[f.style] || 'parry';
    if (th.keep) {
      // already behind the guard: keep it, unless a guard breaker is coming and it can read that. Out of the guard
      // its style ability (parry / avoid / absorb from guard) is a reaction: pressed no sooner than reactAt, and
      // only when that still leaves time before the hit.
      const inTime = th.reactAt <= th.hitAt - REACT_LATE;
      // how sticky the guard is follows the archetype's taste for blocking (thugs block a little, brawlers turtle)
      let c = this.rng() < Math.min(0.9, 0.5 + pr.block + (th.read ? pr.readBlock || 0 : 0)) ? 'block' : null;
      const pAbKeep = pr.ability + (th.read ? (pr.block + pr.dodge) * pr.smart * READ_SHIFT : 0);
      if (canMove && inTime && !inf.brk && !(inf.focus && ab !== 'avoid') && f.stamina >= 10 && this.rng() < pAbKeep) c = ab;
      if (inf.brk && this.rng() < pr.smart) {
        c = canMove && inTime && (pr.dodge + pr.ability) > 0.1 && f.stamina >= 12 ? (ab === 'avoid' ? 'avoid' : 'dodge') : null;
        if (!c) { this.guardUntil = now; this.pressGuardUntil = 0; }   // drop the guard: eat the hit, not the break
      }
      if (c) this._setChoice(c, inf, pr);
      if (c && c !== 'block') this.guardUntil = Math.max(this.guardUntil, th.reactAt);   // guard stays up until then
      return;
    }
    let pAb = pr.ability, pBl = pr.block, pDo = pr.dodge;
    const smart = this.rng() < pr.smart;
    if (inf.focus) { pBl = 0; if (ab !== 'avoid') pAb = 0; }
    if (inf.brk) {
      if (smart) { pDo += pBl * 0.7; pBl = 0; if (ab === 'absorb') { pDo += pAb * 0.5; pAb = 0; } }
      else pBl *= 0.6;
    }
    // a read is met with the style ability (parry / avoid / absorb + counter) rather than a plain block or dodge,
    // the more so the smarter the fighter: same total chance to defend, a sharper answer
    if (th.read && !inf.brk && !(inf.focus && ab !== 'avoid')) {
      const k = pr.smart * READ_SHIFT;
      pAb += (pBl + pDo) * k; pBl *= 1 - k; pDo *= 1 - k;
      // some (thugs) also learn to just put the guard up against the opener they keep eating (read only)
      if (pBl > 0) pBl += pr.readBlock || 0;
    }
    if (f.stamina < 10) { pAb = 0; pDo = 0; }
    const r = this.rng();
    let c = null;
    if (r < pAb) c = ab;
    else if (r < pAb + pBl) c = 'block';
    else if (r < pAb + pBl + pDo) c = 'dodge';
    if (c && c !== 'block' && !canMove) c = null;
    if (!c && th.cancel) c = 'block';   // it gave up its own attack to defend: at least guard
    if (c) this._setChoice(c, inf, pr);
  }

  /** Can this fighter feint its own current attack to defend a strike landing in `tth` s (before its own hit)? */
  _canCancel(tth) {
    const f = this.fighter, a = f.atk, info = a && a.info;
    if (!info || a.phase !== 'run' || a.focus || this.feintThis) return false;
    if (f.moveTime >= info.firstStart - 0.03) return false;          // too late in the wind-up to feint
    if (f.stamina < 12) return false;
    const mine = typeof f.timeToHit === 'function' ? f.timeToHit() : -1;
    return mine < 0 || mine > tth + 0.02;                              // charging, or its strike would land second
  }

  _setChoice(c, inf, pr) {
    const th = this.th;
    const sk = 1 - (pr.timing || 0.5);
    const u = this.rng();
    if (c === 'parry') th.lead = 0.02 + u * (0.15 + sk * 0.2);          // window 0.20 s: late skill = early presses fail
    else if (c === 'avoid') { th.lead = 0.03 + u * (0.22 + sk * 0.2); th.avoidKind = avoidKindFor(inf); }
    else if (c === 'absorb') th.lead = 0.08 + u * (0.3 + sk * 0.25);
    else if (c === 'dodge') { th.lead = 0.09 + u * (0.13 + sk * 0.14); th.side = this.rng() < 0.5 ? -1 : 1; }
    else th.guardEnd = Math.max(0.12, inf.lastEnd - inf.firstHit) + 0.14;
    th.choice = c;
  }

  _executeDefence(c) {
    const f = this.fighter, it = f.intent, th = this.th, a = th.attacker;
    if (c === 'dodge') {
      // sidestep across the line of attack (back-step for thrusts sometimes)
      let ax = f.position.x - a.position.x, az = f.position.z - a.position.z;
      const d = Math.hypot(ax, az) || 1;
      ax /= d; az /= d;
      const back = th.info.path === 'thrust' && this.rng() < 0.35;
      it.dodgeDir.x = back ? ax : -az * th.side;
      it.dodgeDir.z = back ? az : ax * th.side;
      it.dodge = true;
      return;
    }
    if (c === 'avoid') {
      const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
      const k = th.avoidKind;
      // stick relative to facing (combat reads it on the same step): right = (-cos, sin)
      if (k === 'right') { this._mx = -fz; this._mz = fx; }
      else if (k === 'left') { this._mx = fz; this._mz = -fx; }
      else if (k === 'jump') { this._mx = -fx; this._mz = -fz; }
      else { this._mx = 0; this._mz = 0; }
      it.moveX = this._mx; it.moveZ = this._mz;
      this._noSep = true;
    }
    it.defend = true;
  }

  // ============================================================================================ attacks

  _urgent(at, fast) {
    if (this.urgentAt < 0 || at < this.urgentAt) { this.urgentAt = at; this.urgentFast = fast; }
  }

  _startUrgent(now, dist, st) {
    if (this.mode === 'attack' || this.mode === 'phase') return;
    this.pressGuardUntil = 0;
    this._plan(now, dist, this.urgentFast, false);
    if (this.plan.len <= 0) return;
    const first = this.plan.moves[0];
    if (first && dist > first.reach + first.lunge + 0.8) return;
    if (FREE[st]) {
      // a very short beat (the reaction delay already happened): readable, not frame-perfect
      this._setMode('windup', 0.05 + this.rng() * 0.05);
      this.ai.director.noteOpen(this, now);
      this.game.events.emit('enemyTelegraph', { fighter: this.fighter, move: first ? first.move : null, moveId: first ? first.id : null,
        signature: false, duration: this.modeDur, heavy: false, counter: true });
      return;
    }
    // counter straight out of a parry / avoid / absorb (combat buffers the press)
    this._pressOpener(now);
  }

  /** Plan the next string into this.plan. */
  _plan(now, dist, fast, allowSwitch = true) {
    const f = this.fighter, pr = this.profile, c = this._ctx;
    c.deck = f.deck;
    c.stance = f.stance;
    c.len = pickLength(pr.strings, this.rng);
    if (fast > 0.5 && c.len > 2) c.len = 2;
    c.budget = Math.max(0, f.stamina - pr.staminaFloor * 0.4);
    c.heavyBias = pr.heavyBias;
    c.sigBias = pr.sigBias || 0;
    c.sigOnly = !!this.bossId && this.stringsSinceSig >= 3 && fast < 0.5 && this.hasSigs;
    c.sigLRU = c.sigOnly ? this._sigLRU(false) : null;
    c.sigMRU = c.sigOnly ? this._sigLRU(true) : null;
    c.lastOpenStance = this.lastOpenStance;
    c.dist = dist;
    c.fast = fast;
    // a signature string may switch stance to reach the signature (both of Brick's live in BR)
    c.allowSwitch = allowSwitch && fast < 0.5 && (pr.allStances || c.sigOnly || this.rng() < pr.switch);
    c.switchPenalty = pr.allStances ? 2 : 6;
    c.noise = this.bossId ? 2.5 : 4;
    planString(c, this.plan);
    if (this.plan.len === 0 && c.sigOnly) { c.sigOnly = false; planString(c, this.plan); }
    this.planStance = this.plan.switchTo || f.stance;
    const first = this.plan.moves[0];
    const reach = first ? first.reach : 1.6;
    const tr = (this.ai.target(f) || f).radius || 0.35;
    this.engageDist = Math.max(1.0, reach * 0.82 + tr * 0.5);
    this.startDist = reach + tr + 0.2;
  }

  /** The signature in the deck thrown longest ago (never thrown counts as oldest), or with mru the latest one. */
  _sigLRU(mru) {
    const ids = this.sigIds;
    let best = null, bt = mru ? -Infinity : Infinity;
    for (let i = 0; i < ids.length; i++) {
      const t = this.sigLast[ids[i]];
      const v = typeof t === 'number' ? t : -1e9;
      if (mru ? v > bt : v < bt) { bt = v; best = ids[i]; }
    }
    return mru && bt <= -1e9 ? null : best;
  }

  _press(kind) {
    const it = this.fighter.intent;
    if (kind === 'heavy') it.heavy = true; else it.light = true;
  }

  /** Orbit toward the director's bearing (slotAngle) around the target; returns true while still moving there. */
  _flankSteer(ux, uz, k) {
    const th = Math.atan2(-ux, -uz);              // my bearing as seen from the target
    const e = wrap(this.slotAngle - th);
    if (Math.abs(e) < 0.12) return false;
    const s = Math.max(-1, Math.min(1, e * 1.3)) * k;
    this._mx += Math.cos(th) * s; this._mz += -Math.sin(th) * s;
    return true;
  }

  /** Hold a distance from the target (radial only). */
  _keepAt(dist, ux, uz, want, speed) {
    const e = dist - want;
    if (Math.abs(e) < 0.2) return;
    const k = Math.max(-1, Math.min(1, e * 1.4)) * speed;
    this._mx += ux * k; this._mz += uz * k;
  }

  _separate() {
    const f = this.fighter, bs = this.ai.brains;
    for (let i = 0; i < bs.length; i++) {
      const o = bs[i].fighter;
      if (o === f || !o.alive) continue;
      const dx = f.position.x - o.position.x, dz = f.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 2.9 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const k = ((1.7 - d) / 1.7) * 1.25;
      if (k <= 0) continue;
      this._mx += (dx / d) * k; this._mz += (dz / d) * k;
    }
  }

  // ============================================================================================ bosses

  _enterPhase2(now) {
    const f = this.fighter, id = this.bossId;
    this.phase = 1;
    this.profile = resolveProfile(id, 1, this.ai.chapterIndex);
    const d2 = phase2Decks()[id];
    if (d2) {
      if (typeof f.setDeck === 'function') f.setDeck(d2); else f.deck = d2;
      this.refreshReach();
    }
    f.stamina = f.maxStamina || 100;
    this.th.on = false;
    this.urgentAt = -1;
    this.stringsSinceSig = 3;   // open phase 2 with a signature
    this._phasePosed = false;
    if (this.mode !== 'attack') this._setMode('phase', 1.25);
    else this._phasePending = true;   // finish the string first
    const line = BOSS_PHASE2[id];
    const ev = this.game.events;
    ev.emit('bossPhase', { bossId: id, phase: 2, fighter: f, line: line ? line.text : null });
    if (line) this.ai.say(SPEAKERS[id] || f.name, line.text, line.mood, { bossId: id, phase: 2 });
    try { if (typeof this.game.slowmo === 'function') this.game.slowmo(0.45, 0.5); } catch (e) { /* core optional */ }
    try { this.game.cameraRig?.shake?.(0.25); } catch (e) { /* camera optional */ }
  }
}

function wrap(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
