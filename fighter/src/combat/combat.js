// Combat system (game.combat): owns the fighters, steps them at 120 Hz (player controller / dummy brains -> fighter
// state machines -> hit resolution -> collisions + world bounds -> animators) and renders them interpolated (root
// position / yaw lerped here, joint poses via animator.render(alpha) every display frame).
// See FIGHTER.md §7 (rules), §6b (combo flow) and §8 (events). Fighter logic: fighter.js, contacts: hits.js.
import * as THREE from 'three';
import { lerpAngle, angleDiff, yawTo } from '../core/math.js';
import { createFighterModel } from '../anim/model.js';
import { Animator } from '../anim/animator.js';
import { STANCES, STYLES } from '../data/stances.js';
import { T } from './constants.js';
import { Fighter } from './fighter.js';
import { resolveHits } from './hits.js';
import { PlayerController } from './player.js';
import { DummyBrain } from './dummy.js';
import { movesTable, starterDeck, enemyDeck, moveInfo, getMove } from './movedata.js';

export { Fighter } from './fighter.js';

export class Combat {
  constructor(game) {
    this.game = game;
    /** All fighters (player + enemies), dead ones included until removed. */
    this.fighters = [];
    this.player = null;
    this.controller = new PlayerController(this);
    /** Remove dead enemies CORPSE_TIME s after death (they sink into the floor first). */
    this.corpseCleanup = true;
  }

  /** The move library (re-export of moves/index.js MOVES). */
  get MOVES() { return movesTable(); }

  init() {
    const g = this.game;
    g.player = null;
    // age changes the player's max health (Sifu)
    g.events.on('playerAged', () => {
      const p = this.player;
      if (p) p.setHealthMult(this.ageHealthMult(), !p.alive);
    });
    this._installDebug();
  }

  // ============================================================================================ spawning

  /**
   * Spawn a fighter. opts: { team, look, deck, style, position: {x, z}, yaw, health, ai, boss, name, stance, radius,
   * height, damageMult }. Team 'player' becomes game.player.
   */
  spawnFighter(opts = {}) {
    const g = this.game;
    const o = { ...opts };
    o.team = o.team === 'player' ? 'player' : 'enemy';
    const isPlayer = o.team === 'player';
    const look = typeof o.look === 'string' ? { preset: o.look } : (o.look || { preset: isPlayer ? 'player' : (o.boss || o.ai || 'thug') });
    o.look = look;
    const prog = g.flow && g.flow.progress;
    if (!o.deck) o.deck = isPlayer ? (prog && prog.deck) || starterDeck() : enemyDeck(o.boss) || enemyDeck(o.ai) || enemyDeck(look.preset) || starterDeck();
    if (!o.style) o.style = isPlayer ? (prog && prog.style) || 'forsaken' : 'forsaken';
    if (!STYLES[o.style]) o.style = 'forsaken';
    if (!o.stance) o.stance = firstStanceOf(o.deck);

    const body = BODY[look.preset];
    if (body) { if (typeof o.radius !== 'number') o.radius = body.radius; if (typeof o.height !== 'number') o.height = body.height; }
    const f = new Fighter(this, o);
    if (isPlayer) f.setHealthMult(this.ageHealthMult(), true);

    let model = null;
    try { model = createFighterModel(look); } catch (e) { console.error('[combat] createFighterModel failed', e); }
    f.model = model;
    if (model && model.root) {
      model.root.position.copy(f.position);
      model.root.rotation.y = f.yaw;
      g.scene.add(model.root);
      try { f.animator = new Animator(model); } catch (e) { console.error('[combat] Animator failed', e); f.animator = null; }
    }
    this.fighters.push(f);

    if (isPlayer) {
      if (this.player && this.player !== f && !this.player.removed) this.removeFighter(this.player);
      this.player = f;
      g.player = f;
      this.controller.reset();
    } else if (o.ai) {
      try {
        const b = g.ai && typeof g.ai.attach === 'function' ? g.ai.attach(f, o.ai) : null;
        if (b && !f.ai) f.ai = b;
      } catch (e) { console.error('[combat] ai.attach failed', e); }
    }
    // pose immediately so the first rendered frame is not a T-pose
    f.animate(0);
    return f;
  }

  /** Remove a fighter (scene, lists, AI). */
  removeFighter(f) {
    if (!f) return;
    const i = this.fighters.indexOf(f);
    if (i >= 0) this.fighters.splice(i, 1);
    f.removed = true;
    f.alive = false;
    const g = this.game;
    if (f.model) {
      if (f.model.root && f.model.root.parent) f.model.root.parent.remove(f.model.root);
      try { if (typeof f.model.dispose === 'function') f.model.dispose(); } catch (e) { /* ignore */ }
    }
    try { if (g.ai && typeof g.ai.detach === 'function') g.ai.detach(f); } catch (e) { /* ignore */ }
    if (this.controller.lockTarget === f) this.controller.lockTarget = null;
    for (const o of this.fighters) if (o.intent.lockTarget === f) o.intent.lockTarget = null;
    if (this.player === f) { this.player = null; g.player = null; }
  }

  /** Remove everyone. */
  clear() {
    while (this.fighters.length) this.removeFighter(this.fighters[this.fighters.length - 1]);
    this.player = null;
    this.game.player = null;
    this.controller.reset();
  }

  /** Revive a fighter where it lies (full health incl. age multiplier for the player, getup). */
  revive(f = this.player, o = {}) {
    if (!f) return null;
    f.revive({ healthMult: f === this.player ? this.ageHealthMult() : 1, ...o });
    return f;
  }

  // ============================================================================================ queries

  /** Number of living enemies. */
  enemiesAlive() {
    let n = 0;
    for (const f of this.fighters) if (f.team !== 'player' && f.alive) n++;
    return n;
  }
  /** Living enemies (new array; not for hot paths). */
  enemies() { return this.fighters.filter((f) => f.team !== 'player' && f.alive); }

  /** Nearest living opponent of `f` within maxDist (or null). */
  nearestEnemy(f, maxDist = Infinity) {
    if (!f) return null;
    let best = null, bd = maxDist * maxDist;
    for (const e of this.fighters) {
      if (e === f || e.team === f.team || !e.alive || e.removed) continue;
      const dx = e.position.x - f.position.x, dz = e.position.z - f.position.z;
      const d = dx * dx + dz * dz;
      if (d <= bd) { bd = d; best = e; }
    }
    return best;
  }

  /** Default target for AI fighters: the living player. */
  defaultTargetFor(f) {
    const p = this.player;
    if (f.team === 'player') return null;
    return p && p.alive && !p.removed ? p : null;
  }

  /**
   * Soft auto-aim for an unlocked player attack: the best enemy within SOFT_AIM_RANGE in front (facing or stick).
   */
  softTarget(f, range = T.SOFT_AIM_RANGE) {
    const it = f.intent;
    const stick = Math.hypot(it.moveX, it.moveZ) > 0.3;
    const aimYaw = stick ? Math.atan2(it.moveX, it.moveZ) : f.yaw;
    let best = null, bs = Infinity;
    for (const e of this.fighters) {
      if (e === f || e.team === f.team || !e.alive || e.removed) continue;
      const dx = e.position.x - f.position.x, dz = e.position.z - f.position.z;
      const d = Math.hypot(dx, dz);
      if (d > range + e.radius) continue;
      const ang = Math.abs(angleDiff(aimYaw, Math.atan2(dx, dz)));
      if (ang > T.SOFT_AIM_ARC && d > 1.2) continue;
      const s = d + ang * 1.5;
      if (s < bs) { bs = s; best = e; }
    }
    return best;
  }

  /** Age multipliers from Flow (default 1). */
  ageHealthMult() {
    const fl = this.game.flow;
    const m = fl && typeof fl.ageHealthMult === 'function' ? fl.ageHealthMult() : 1;
    return typeof m === 'number' && isFinite(m) && m > 0 ? m : 1;
  }
  ageDamageMult() {
    const fl = this.game.flow;
    const m = fl && typeof fl.ageDamageMult === 'function' ? fl.ageDamageMult() : 1;
    return typeof m === 'number' && isFinite(m) && m > 0 ? m : 1;
  }

  // ============================================================================================ loop

  fixedUpdate(dt) {
    const fs = this.fighters;
    this._stepFrame = this.game.frame;   // the controller read this frame's input (see update())
    if (!fs.length) return;
    const p = this.player;
    // 1. intents
    if (p && p.alive && !p.ai && !p.dummy) this.controller.update(dt, p);
    for (let i = 0; i < fs.length; i++) { const f = fs[i]; if (f.dummy) f.dummy.think(dt); }
    // 2. fighters
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      f.prevPosition.copy(f.position);
      f.prevYaw = f.yaw;
      f.step(dt);
    }
    // 3. contacts
    resolveHits(this);
    // 4. body collisions (circle push-out) + world bounds
    this._collide();
    const w = this.game.world;
    const clampFn = w && typeof w.clampPosition === 'function' ? w : null;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (clampFn) {
        try {
          const r = clampFn.clampPosition(f.position, f.radius);
          if (r && r !== f.position && typeof r.x === 'number') { f.position.x = r.x; f.position.z = r.z; }
        } catch (e) { /* world stub */ }
      }
      f.position.y = 0;
    }
    // 5. animation at sim rate
    for (let i = 0; i < fs.length; i++) fs[i].animate(dt);
    // 6. corpses sink away after a while
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = fs[i];
      if (f.alive || f.team === 'player' || !this.corpseCleanup) continue;
      f.deadTime = (f.deadTime || 0) + dt;
      if (f.deadTime > CORPSE_TIME + CORPSE_SINK) this.removeFighter(f);
    }
  }

  _collide() {
    const fs = this.fighters;
    for (let i = 0; i < fs.length; i++) {
      const a = fs[i];
      if (!a.alive || a.state === 'knockdown') continue;
      for (let j = i + 1; j < fs.length; j++) {
        const b = fs[j];
        if (!b.alive || b.state === 'knockdown') continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const min = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const push = (min - d);
        const nx = d2 > 1e-8 ? dx / d : 1, nz = d2 > 1e-8 ? dz / d : 0;
        // dodging fighters pass a little more freely; the player is slightly heavier than crowds
        const wa = a === this.player ? 0.4 : 0.5;
        a.position.x -= nx * push * wa; a.position.z -= nz * push * wa;
        b.position.x += nx * push * (1 - wa); b.position.z += nz * push * (1 - wa);
      }
    }
  }

  update(dt, alpha) {
    // stance flicks polled in frames that ran no sim step (hitstop) are kept for the next step
    const inp = this.game.input;
    if (inp && typeof inp.stanceFlick === 'function') {
      const fl = inp.stanceFlick();
      if (fl && this._stepFrame !== this.game.frame) this.controller.pendingStance = fl;
    }
    const a = alpha === undefined ? 1 : Math.max(0, Math.min(1, alpha));
    const fs = this.fighters;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      const root = f.model && f.model.root;
      if (!root) continue;
      root.position.lerpVectors(f.prevPosition, f.position, a);
      root.rotation.y = lerpAngle(f.prevYaw, f.yaw, a);
      if (!f.alive && f.deadTime > CORPSE_TIME) root.position.y = -0.6 * Math.min(1, (f.deadTime - CORPSE_TIME) / CORPSE_SINK);
      // joint poses at display rate: the animator blends its last two sim poses by the same alpha as the root
      const an = f.animator;
      if (an && typeof an.render === 'function') {
        try { an.render(a); } catch (e) {
          if (!f._renderErr) { f._renderErr = true; console.warn('[combat] animator.render error', e); }
        }
      }
    }
  }

  // ============================================================================================ debug

  _installDebug() {
    const g = this.game;
    const d = g.debug || (g.debug = {});
    const self = this;
    const front = (dist) => {
      const p = self.player;
      if (!p) return { x: 0, z: dist };
      return { x: p.position.x + Math.sin(p.yaw) * dist, z: p.position.z + Math.cos(p.yaw) * dist };
    };
    const faceYaw = (pos) => (self.player ? yawTo(pos.x, pos.z, self.player.position.x, self.player.position.z) : Math.PI);
    d.combat = this;
    /** Spawn an AI enemy: { archetype, x, z, look, deck, style, health, name, boss }. */
    d.spawnEnemy = (o = {}) => {
      const pos = typeof o.x === 'number' ? { x: o.x, z: o.z || 0 } : front(3.2);
      const archetype = o.archetype || 'thug';
      return self.spawnFighter({
        team: 'enemy', ai: archetype, boss: o.boss, look: o.look || { preset: o.boss || archetype, seed: o.seed },
        deck: o.deck, style: o.style, health: o.health, name: o.name || archetype, position: pos, yaw: faceYaw(pos),
      });
    };
    /** Training dummy (no AI system needed): { mode: 'idle'|'block'|'attack'|'parry'|'avoid'|'absorb', x, z, ... }. */
    d.dummy = (o = {}) => {
      const mode = o.mode || 'idle';
      const pos = typeof o.x === 'number' ? { x: o.x, z: o.z || 0 } : front(o.dist || 1.6);
      const style = o.style || (mode === 'avoid' ? 'windfall' : mode === 'absorb' ? 'kahlt' : 'forsaken');
      const f = self.spawnFighter({
        team: 'enemy', look: o.look || { preset: 'thug', seed: 7 }, deck: o.deck, style, health: o.health || 400,
        name: o.name || 'Dummy', position: pos, yaw: faceYaw(pos), stance: o.stance,
      });
      f.dummy = new DummyBrain(self, f, o);
      return f;
    };
    /** Player takes no damage. */
    d.god = (on = true) => { if (self.player) self.player.god = !!on; return !!on; };
    /** Snapshot of every fighter. */
    d.fighterState = () => self.fighters.map((f) => f.summary());
    /** Force the player's stance. */
    d.setStance = (st) => { if (self.player && STANCES.includes(st)) self.player.setStance(st); return self.player ? self.player.stance : null; };
    /** Spawn the player if Flow has not (tests). */
    d.spawnPlayer = (o = {}) => self.player || self.spawnFighter({ team: 'player', position: { x: o.x || 0, z: o.z || 0 }, yaw: o.yaw || 0, ...o });
    /** Normalised timing of a move id (chainIn, holdOut, windows...). */
    d.moveInfo = (id) => { const m = getMove(id); if (!m) return null; const i = moveInfo(m); return { ...i, move: undefined, keys: undefined }; };
  }
}

/** Body size per look preset (hit geometry + collisions). */
const BODY = {
  brawler: { radius: 0.4, height: 1.85 }, heavy: { radius: 0.42, height: 1.85 }, swift: { radius: 0.33, height: 1.76 },
  brick: { radius: 0.48, height: 2.0 }, madame_shu: { radius: 0.36, height: 1.72 }, mr_golden: { radius: 0.37, height: 1.84 },
};
/** Dead enemies lie for this long, then sink away and are removed (keeps draw calls low across rooms). */
const CORPSE_TIME = 10, CORPSE_SINK = 1.4;

function firstStanceOf(deck) {
  if (!deck) return 'FR';
  for (const st of STANCES) { const s = deck[st]; if (s && (s.main || s.alt)) return st; }
  return 'FR';
}
