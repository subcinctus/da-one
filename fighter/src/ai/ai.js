// AI system (game.ai, FIGHTER.md §11): owns the enemy brains, the crowd director and a light model of the player's
// defensive habits. Runs before Combat in the update order, so the intents it writes are read in the same sim step.
//
//   attach(fighter, archetype)   brain for 'thug' | 'brawler' | 'swift' | 'heavy' | 'tadao' | 'madame_shu' | 'brick' |
//                                'mr_golden' (returns it; also stored as fighter.ai)
//   detach(fighter)              configure(fighter, { dormant, wakeDelay })     wake(fighter, delay)
//   setDifficulty(chapterIndex)  brainOf(fighter)   stats()
// Events listened to: attackStart (threats / own strings), attackWhiff (punishes), hit, blocked, parried, avoided,
// absorbed (counters + habits), knockdown (barks). Emitted: enemyTelegraph, aiFeint, bossPhase, dialogue.
import { Brain } from './brain.js';
import { Director } from './director.js';
import { deckReach } from './moveinfo.js';
import { ARCHETYPES, BOSSES, resolveProfile } from './archetypes.js';
import { KNOCKDOWN_LINES, lineDuration } from '../levels/dialogue.js';

const HABIT_KEYS = ['block', 'parry', 'duck', 'jump', 'side', 'dodge', 'absorb'];

/** Rolling model of how the player defends (rates 0..1), read by the string planner. */
class Habits {
  constructor() {
    this.counts = { block: 0, parry: 0, duck: 0, jump: 0, side: 0, dodge: 0, absorb: 0 };
    this.rates = { block: 0, parry: 0, duck: 0, jump: 0, side: 0, dodge: 0, absorb: 0 };
    this.seen = 0;
    this._t = 0;
  }
  reset() { for (const k of HABIT_KEYS) { this.counts[k] = 0; this.rates[k] = 0; } this.seen = 0; }
  add(k) { if (k in this.counts) { this.counts[k] += 1; this._recompute(); } }
  attack() { this.seen += 1; this._recompute(); }
  _recompute() {
    const n = Math.max(5, this.seen);
    for (let i = 0; i < HABIT_KEYS.length; i++) { const k = HABIT_KEYS[i]; this.rates[k] = Math.min(1, this.counts[k] / n); }
  }
  /** Forget slowly (habits from a minute ago matter less). */
  step(dt) {
    this._t += dt;
    if (this._t < 0.5) return;
    const k = Math.exp(-this._t / 25);
    this._t = 0;
    for (let i = 0; i < HABIT_KEYS.length; i++) this.counts[HABIT_KEYS[i]] *= k;
    this.seen *= k;
    this._recompute();
  }
}

export class AI {
  constructor(game) {
    this.game = game;
    /** Live brains (one per AI fighter). */
    this.brains = [];
    this.director = new Director(this);
    this.habits = new Habits();
    /** The player's last 4 string openers (move ids): an opener in here is a read (answered at the 0.15 s floor). */
    this.reads = ['', '', '', ''];
    this._readIdx = 0;
    /** Sim time of the player's last attackStart, and the reach of its deck (pressure guard). */
    this.playerAttackAt = -1e9;
    this.playerReach = 1.6;
    this.chapterIndex = 1;
    this.enabled = true;
    this._seed = 1337;
    this._tauntUntil = 0;
    this._barkUntil = 0;
    this._taunter = null;
    this._errored = false;
  }

  init() {
    const g = this.game;
    const seed = parseInt(g.params?.get?.('seed') || '', 10);
    if (isFinite(seed)) this._seed = seed >>> 0;
    const ev = g.events;
    if (ev && typeof ev.on === 'function') {
      ev.on('attackStart', (e) => this._onAttackStart(e));
      ev.on('attackWhiff', (e) => this._onWhiff(e));
      ev.on('hit', (e) => this._onHit(e));
      ev.on('blocked', (e) => this._onDefence(e, 'block'));
      ev.on('parried', (e) => this._onDefence(e, 'parry'));
      ev.on('absorbed', (e) => { if (!e?.pierced) this._onDefence(e, 'absorb'); });
      ev.on('avoided', (e) => this._onDefence(e, e?.kind === 'dodge' ? 'dodge' : 'avoid', e?.kind));
      ev.on('knockdown', (e) => this._onKnockdown(e));
      ev.on('chapterStart', () => { this.habits.reset(); this.resetReads(); });
    }
    this._installDebug();
  }

  // ============================================================================================ brains

  /** Attach a brain to an AI fighter. Returns the brain (also fighter.ai). */
  attach(fighter, archetype = 'thug') {
    if (!fighter) return null;
    this.detach(fighter);
    if (!fighter.intent) fighter.intent = makeIntentShim();
    const id = BOSSES[archetype] || ARCHETYPES[archetype] ? archetype : (BOSSES[fighter.boss] ? fighter.boss : 'thug');
    const brain = new Brain(this, fighter, id, (this._seed * 7919 + (fighter.id || this.brains.length + 1) * 104729) >>> 0);
    // defensive style from the archetype unless the spawner chose something else than the default
    const prof = brain.profile;
    if (prof.style && (!fighter.style || fighter.style === 'forsaken')) fighter.style = prof.style;
    // debug spawns of bosses without explicit health get boss health
    if (brain.bossId && (fighter.maxHealth || 0) <= 60) {
      fighter.baseMaxHealth = fighter.maxHealth = fighter.health = Math.round(prof.health * prof.healthScale);
    }
    if (fighter.damageMult === 1 || typeof fighter.damageMult !== 'number') fighter.damageMult = +(prof.damage * prof.damageScale).toFixed(3);
    fighter.ai = brain;
    this.brains.push(brain);
    return brain;
  }

  /** Remove a fighter's brain (Combat calls this from removeFighter). */
  detach(fighter) {
    const i = this.brains.findIndex((b) => b.fighter === fighter);
    if (i < 0) return;
    const b = this.brains[i];
    if (b.hasToken) b.hasToken = false;
    this.brains.splice(i, 1);
    if (fighter.ai === b) fighter.ai = null;
  }

  /** The brain driving a fighter, or null. */
  brainOf(fighter) {
    for (let i = 0; i < this.brains.length; i++) if (this.brains[i].fighter === fighter) return this.brains[i];
    return null;
  }

  /** Encounter-side options: { dormant: bool, wakeDelay: s }. */
  configure(fighter, o = {}) {
    const b = this.brainOf(fighter);
    if (!b) return null;
    if (o.dormant) b.sleep();
    else if (o.dormant === false) b.wake(o.wakeDelay || 0);
    return b;
  }

  /** Wake a dormant brain after `delay` sim seconds. */
  wake(fighter, delay = 0) { const b = this.brainOf(fighter); if (b) b.wake(delay); return !!b; }

  /** Chapter difficulty (1..4): brains attached afterwards use it. */
  setDifficulty(index = 1) { this.chapterIndex = Math.max(1, Math.min(4, index | 0 || 1)); }

  /** True when the player opened one of its last 4 strings with move `id` (the enemies have seen it coming). */
  isRead(id) {
    const r = this.reads;
    for (let i = 0; i < r.length; i++) if (r[i] === id) return true;
    return false;
  }

  /** Forget the player's openers (new chapter). */
  resetReads() { for (let i = 0; i < this.reads.length; i++) this.reads[i] = ''; this._readIdx = 0; this.playerAttackAt = -1e9; }

  /** The living player, or null. */
  target(f) {
    const p = this.game.player;
    if (!p || !p.alive || p.removed || p === f) return null;
    return p;
  }

  // ============================================================================================ loop

  fixedUpdate(dt) {
    if (!this.enabled || !this.brains.length) return;
    const now = this.game.time;
    this.habits.step(dt);
    this.director.update(dt, now, this.target(null));
    const bs = this.brains;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (b.fighter.removed) continue;
      try { b.update(dt, now); } catch (e) {
        if (!this._errored) { this._errored = true; console.error('[ai] brain update', e); }
      }
    }
  }

  // ============================================================================================ events

  _onAttackStart(e) {
    const f = e && e.fighter;
    if (!f || !e.move) return;
    const now = this.game.time;
    if (f === this.game.player) {
      this.playerAttackAt = now;
      if (!e.chained) this.playerReach = deckReach(f.deck);
      // threats are judged against the openers seen BEFORE this one, then this opener joins the ring
      for (let i = 0; i < this.brains.length; i++) this.brains[i].onThreat(f, e.move, !!e.chained, now);
      if (!e.chained && e.move.id) this.reads[this._readIdx++ & 3] = e.move.id;
      return;
    }
    const b = f.ai && f.ai.fighter === f ? f.ai : this.brainOf(f);
    if (b && typeof b.onOwnAttackStart === 'function') {
      b.onOwnAttackStart(e.move, !!e.chained, now);
      if (b.ai === this && this.target(f)) this.habits.attack();
    }
  }

  _onWhiff(e) {
    if (!e || e.fighter !== this.game.player) return;
    const now = this.game.time;
    for (let i = 0; i < this.brains.length; i++) this.brains[i].onPlayerWhiff(now);
  }

  _onHit(e) {
    if (!e) return;
    const d = e.defender;
    if (d && d !== this.game.player) { const b = this.brainOf(d); if (b) b.onHit(this.game.time); }
  }

  _onDefence(e, kind, sub) {
    if (!e) return;
    const p = this.game.player;
    if (e.defender === p) {
      // the player's habits (what the planner should answer)
      if (kind === 'avoid') this.habits.add(sub === 'duck' ? 'duck' : sub === 'jump' ? 'jump' : 'side');
      else this.habits.add(kind);
      return;
    }
    const b = this.brainOf(e.defender);
    if (b && e.attacker === p) b.onDefended(kind, this.game.time);
  }

  _onKnockdown(e) {
    const p = this.game.player;
    if (!e || e.fighter !== p) return;
    // rare dry line from the nearest enemy
    if (Math.random() > 0.3) return;
    let best = null, bd = 6;
    for (const b of this.brains) if (b.fighter.alive && !b.dormant && !b.bossId && b.dist < bd) { bd = b.dist; best = b; }
    if (best) this.bark(best.fighter, KNOCKDOWN_LINES[Math.floor(Math.random() * KNOCKDOWN_LINES.length)], 'dry');
  }

  // ============================================================================================ talk

  /** One taunt at a time across the crowd. */
  claimTaunt(now, brain) {
    if (now < this._tauntUntil) return false;
    this._tauntUntil = now + 4;
    this._taunter = brain;
    return true;
  }

  /** A sparing one-liner from a regular enemy (global cooldown). Returns true when said. */
  bark(fighter, text, mood = 'dry') {
    const now = this.game.time;
    if (!text || now < this._barkUntil) return false;
    this._barkUntil = now + 14;
    this.say(fighter?.name || 'Thug', text, mood, { bark: true, fighter });
    return true;
  }

  /** Emit a 'dialogue' line (menus show it). */
  say(speaker, text, mood = 'calm', extra = null) {
    const payload = { speaker, text, mood, duration: lineDuration(text), block: false };
    if (extra) Object.assign(payload, extra);
    this.game.events.emit('dialogue', payload);
  }

  // ============================================================================================ debug

  /** Snapshot for tests / the debug overlay. */
  stats() {
    const d = this.director;
    const modes = {};
    const list = [];
    for (const b of this.brains) {
      const f = b.fighter;
      modes[b.mode] = (modes[b.mode] || 0) + 1;
      list.push({ id: f.id, name: f.name, arch: b.archetype, boss: b.bossId, phase: b.phase + 1, mode: b.mode,
        token: b.hasToken, dormant: b.dormant, state: f.state, hp: Math.round(f.health), stamina: Math.round(f.stamina),
        dist: +b.dist.toFixed(2), stance: f.stance, ...b.stats });
    }
    return {
      brains: this.brains.length, alive: this.brains.filter((b) => b.fighter.alive).length, chapterIndex: this.chapterIndex,
      maxAttackers: d.maxAttackers, tokens: d.tokenCount(), attackingNow: d.attackingNow, peakAttacking: d.peakAttacking,
      peakTokens: d.peakTokens, modes, habits: { ...this.habits.rates }, list,
    };
  }

  _installDebug() {
    const g = this.game;
    const dbg = g.debug || (g.debug = {});
    dbg.ai = this;
    /** AI snapshot: tokens, modes, peak simultaneous attackers, per-brain stats. */
    dbg.aiStats = () => this.stats();
    /** Resolved personality of an archetype / boss (phase 0 / 1) for a chapter. */
    dbg.aiProfile = (id, phase = 0, chapter = this.chapterIndex) => resolveProfile(id, phase, chapter);
    /** Pause / resume every brain (enemies stand still). */
    dbg.aiEnabled = (on = true) => { this.enabled = !!on; if (!on) for (const b of this.brains) { const it = b.fighter.intent; it.moveX = it.moveZ = 0; it.guard = false; } return this.enabled; };
  }
}

function makeIntentShim() {
  return { moveX: 0, moveZ: 0, light: false, heavy: false, guard: false, dodge: false, dodgeDir: { x: 0, z: 0 },
    defend: false, stance: null, focus: false, charge: false, feint: false, lockTarget: null };
}
