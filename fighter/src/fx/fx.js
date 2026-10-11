// FX system (system `fx`, FIGHTER.md §10): subtle, Absolver-like hit effects only. No fog / bloom / post.
//   trail(fighter, limb, duration)   tapered limb ribbon (also armed automatically from 'attackStart' over each hit's
//                                    strike segment: wind-up extreme -> end of the hit window; stops on the §6b hold)
//   hit(point, dir, heavy, opts)     2-3 frame white flash + 4-10 tiny angular shards along dir; heavy: thin ring
//   block(point, opts)               small grey-blue spark (guard break: + ring)
//   parry(point, opts)               crisp bright flash, thin rings, a short time-scale dip (player involved)
//   absorb(point, opts)              inward jade pulse
//   avoid(fighter)                   single faint afterimage of the pose the fighter slipped out of
//   focus(fighter)                   screen-edge vignette pulse (DOM overlay)
//   death(fighter)                   brief fade of the mask colour (restored on revive)
//   dust(point, amount)              tiny puff, only where a body lands (knockdown / death)
//   learned(fighter)                 jade ground ring + rising streaks
//   glint(fighter, limb, alpha)      0.12 s faint sparkle on a limb: the wind-up tell of guard breakers / knockdowns
//                                    ('enemyTelegraph' heavy / break / knockdown) and of a full charge ('chargeFull')
// Draw calls: sprites 1 + trails 1 + ghosts (0-2, only while visible) <= 4. Everything pooled; zero per-frame
// allocations. FX listens to combat events itself; combat may also call trail() directly (it does, per hit window).
// Emits 'bodyLanded' { fighter, point, kind: 'knockdown' | 'death' } when a falling body reaches the floor (audio).
import * as THREE from 'three';
import { SpriteField } from './sprites.js';
import { TrailField } from './trails.js';
import { GhostPool } from './ghost.js';
import { Vignette } from './vignette.js';
import { COLORS, HIT, flash, star, ring, shards, puff, inward, rising, glint } from './recipes.js';
import { displayRGB } from './material.js';

/** Trail look per move weight. Trails start at the strike segment (last key before the hit); 2 x lead is the fallback. */
const TRAIL = {
  light: { lead: 0.07, life: 0.12, width: 0.044, alpha: 0.8 },
  medium: { lead: 0.09, life: 0.13, width: 0.054, alpha: 0.84 },
  heavy: { lead: 0.12, life: 0.16, width: 0.068, alpha: 0.88 },
};
const LEG = /^(foot|knee)/;
/** Dust tint per chapter (gym: chalk, which also puffs on hits). */
const DUST = {
  laundromat: [0.86, 0.86, 0.82], market: [0.56, 0.6, 0.62], gym: [0.95, 0.95, 0.93], tower: [0.82, 0.78, 0.7],
};
const MASK_DIM = new THREE.Color(0x55585e);

/** Start of the strike segment that lands at move time `t`: the last key before it, else t - 2 x lead. */
function strikeFrom(m, t, lead) {
  const keys = m && m.keys;
  let from = -1;
  if (Array.isArray(keys)) {
    for (let i = 0; i < keys.length; i++) {
      const kt = keys[i] && keys[i].t;
      if (typeof kt === 'number' && kt < t - 1e-4 && kt > from) from = kt;
    }
  }
  return from >= 0 ? from : Math.max(0, t - 2 * lead);
}
const MAX_WATCH = 8;

export class FX {
  constructor(game) {
    this.game = game;
    this.sprites = null;
    this.trails = null;
    this.ghosts = null;
    this.vignette = new Vignette();
    this.chapter = null;
    this._lastSim = 0;
    this._focusOn = false;
    /** Tests: freeze particle / ghost aging (geometry still rebuilds) to screenshot a 3-frame flash. */
    this.freeze = false;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._rgb = [1, 1, 1];
    this._to = { life: 0.12, width: 0.04, alpha: 0.6, r: 1, g: 1, b: 1 };
    // landing watchers (knockdown / death dust + 'bodyLanded')
    this._watch = [];
    for (let i = 0; i < MAX_WATCH; i++) this._watch.push({ f: null, t: 0, max: 0.6, kind: 'knockdown', y0: 1 });
    // dying masks
    this._masks = [];
    for (let i = 0; i < MAX_WATCH; i++) this._masks.push({ f: null, t: 0, mat: null, base: new THREE.Color(1, 1, 1) });
    this._landEvt = { fighter: null, point: new THREE.Vector3(), kind: 'knockdown' };
    // reusable option bags for event handlers (no allocation per combat event)
    this._ho = { weight: 'light', counter: false, killed: false, focus: null, defender: null };
    this._bo = { broken: false, dir: null, weight: 'light', player: false, pierced: false, dodge: false, force: false };
  }

  init() {
    const g = this.game;
    this.sprites = new SpriteField(256);
    this.trails = new TrailField();
    this.ghosts = new GhostPool(2);
    g.scene.add(this.sprites.mesh);
    g.scene.add(this.trails.mesh);
    this.vignette.mount();
    this._wire();
    this._installDebug();
  }

  // ============================================================================================ public API

  /**
   * Limb trail on `fighter` following STRIKE_POINT `limb` for `duration` seconds of sim time. While the fighter is
   * attacking, emission never runs past the move's last active frame (no ribbon along the withdrawal).
   */
  trail(fighter, limb, duration = 0.12) {
    if (!this.trails || !fighter || !fighter.animator) return;
    const info = fighter.state === 'attack' && fighter.atk ? fighter.atk.info : null;
    if (info && typeof info.lastEnd === 'number' && typeof fighter.moveTime === 'number') {
      const left = info.lastEnd - fighter.moveTime;
      if (left <= 0) return;
      if (duration > left) duration = left;
    }
    const l = limb || (fighter.move && fighter.move.limb) || 'handR';
    this._trailLook(fighter, (fighter.move && fighter.move.weight) || 'light', l);
    this.trails.extend(fighter, l, duration, this.game.time, this._to);
  }

  /**
   * Impact: flash + shards along dir (+ ring when heavy). opts: { weight, counter, killed, focus, defender }.
   * point / dir: Vector3-like (dir may be null).
   */
  hit(point, dir, heavy = false, opts = null) {
    const F = this.sprites;
    if (!F || !point) return;
    const o = opts || this._to;
    const weight = (opts && opts.weight) || (heavy ? 'heavy' : 'light');
    const H = HIT[weight] || HIT.light;
    const x = point.x, y = point.y, z = point.z;
    let dx = dir ? dir.x : 0, dy = dir ? dir.y || 0 : 0, dz = dir ? dir.z : 0;
    if (!(dx * dx + dz * dz > 1e-6)) { const a = Math.random() * 6.283; dx = Math.sin(a); dz = Math.cos(a); }
    const counter = !!(opts && opts.counter), killed = !!(opts && opts.killed), focus = !!(opts && opts.focus);
    const big = counter || killed || focus;
    flash(F, x, y, z, H.flash * (big ? 1.15 : 1), H.life * (big ? 1.2 : 1), COLORS.white, 0.95);
    star(F, x, y, z, dx, dy, dz, H.star * (big ? 1.2 : 1), 0.011, H.life * 1.1, COLORS.white, 0.95);
    const n = H.n0 + Math.floor(Math.random() * (H.n1 - H.n0 + 1)) + (big ? 2 : 0);
    shards(F, x, y, z, dx, dy, dz, Math.min(10, n), H.s0, H.s1, 0.55, H.len, H.width, 0.16, COLORS.shard, 0.95, 0.22);
    if (H.ring || killed || focus) {
      const l = Math.hypot(dx, dy, dz) || 1;
      ring(F, x, y, z, dx / l, dy / l, dz / l, 0.06, weight === 'heavy' ? 0.5 : 0.4, 0.016, 0.18, focus ? COLORS.jadeLight : COLORS.white, 0.5);
    }
    if (this.chapter === 'gym') {
      for (let k = 0; k < 2; k++) puff(F, x, y, z, dx * 0.6 + (Math.random() - 0.5) * 0.4, 0.25 + Math.random() * 0.2, dz * 0.6 + (Math.random() - 0.5) * 0.4, 0.05, 0.26, 0.5, DUST.gym, 0.32);
    }
    const d = o && o.defender;
    if (d && d.model && typeof d.model.flash === 'function') {
      // emissive is linear: a little goes a long way on dark cloth (0.05 ~ +25% sRGB on black)
      try { d.model.flash(0xffffff, weight === 'heavy' || big ? 0.08 : weight === 'medium' ? 0.06 : 0.045, 0.06); } catch (e) { /* optional */ }
    }
  }

  /** Small grey-blue spark (opts: { broken, dir, weight }). */
  block(point, opts = null) {
    const F = this.sprites;
    if (!F || !point) return;
    const x = point.x, y = point.y, z = point.z;
    const broken = !!(opts && opts.broken);
    const dir = opts && opts.dir;
    let dx = dir ? -dir.x : 0, dz = dir ? -dir.z : 0;
    if (!(dx * dx + dz * dz > 1e-6)) { dx = 0; dz = 0; }
    flash(F, x, y, z, broken ? 0.13 : 0.085, broken ? 0.06 : 0.045, COLORS.block, 0.8, 0.9);
    shards(F, x, y, z, dx, 0.35, dz, broken ? 7 : 3 + (Math.random() < 0.5 ? 1 : 0), 2.4, 4.4, 1.0, 0.05, 0.008, 0.11, COLORS.block, 0.9, 0.3, 4);
    if (broken) ring(F, x, y, z, 0, 0, 0, 0.08, 0.45, 0.018, 0.2, COLORS.block, 0.6);
  }

  /** Crisp parry flash + thin rings; a short time-scale dip when the player is involved (opts.player). */
  parry(point, opts = null) {
    const F = this.sprites;
    if (!F || !point) return;
    const x = point.x, y = point.y, z = point.z;
    const dir = opts && opts.dir;
    flash(F, x, y, z, 0.15, 0.065, COLORS.parry, 1, 0.95);
    star(F, x, y, z, dir ? dir.x : 1, 0.3, dir ? dir.z : 0, 0.3, 0.01, 0.08, COLORS.parry, 1);
    ring(F, x, y, z, 0, 0, 0, 0.05, 0.55, 0.012, 0.2, COLORS.parry, 0.9);
    ring(F, x, y, z, 0, 0, 0, 0.04, 0.34, 0.008, 0.16, COLORS.parry, 0.5, { delay: 0.035 });
    // sparks skate off sideways (perpendicular to the strike)
    const px = dir ? -dir.z : 1, pz = dir ? dir.x : 0;
    shards(F, x, y, z, px, 0.15, pz, 2, 3, 5, 0.5, 0.06, 0.007, 0.12, COLORS.parry, 0.95, 0.1, 2);
    shards(F, x, y, z, -px, 0.15, -pz, 2, 3, 5, 0.5, 0.06, 0.007, 0.12, COLORS.parry, 0.95, 0.1, 2);
    const g = this.game;
    if (opts && opts.player && g.settings && g.settings.hitPause !== false && typeof g.slowmo === 'function' && !(g.timeScale < 0.99)) {
      g.slowmo(0.5, 0.16);
    }
  }

  /** Inward jade pulse (opts: { pierced, dir }). */
  absorb(point, opts = null) {
    const F = this.sprites;
    if (!F || !point) return;
    const x = point.x, y = point.y, z = point.z;
    if (opts && opts.pierced) {
      flash(F, x, y, z, 0.16, 0.05, COLORS.jadeLight, 0.85, 0.9);
      const dir = opts.dir;
      shards(F, x, y, z, dir ? dir.x : 0, 0.2, dir ? dir.z : 0, 4, 3, 5.5, 0.7, 0.07, 0.01, 0.14, COLORS.jadeLight, 0.9, 0.2);
      return;
    }
    ring(F, x, y, z, 0, 0, 0, 0.5, 0.07, 0.02, 0.22, COLORS.jade, 0.75, { fadeIn: 0.3, fadePow: 0.8, grow: 1.5 });
    inward(F, x, y, z, 5, 0.45, 0.2, 0.06, 0.008, COLORS.jadeLight, 0.75);
    puff(F, x, y, z, 0, 0, 0, 0.06, 0.2, 0.18, COLORS.jadeLight, 0.35, 1, 0.12);
  }

  /** Afterimage of the pose `fighter` slipped out of (avoid / dodge). */
  avoid(fighter, opts = null) {
    if (!this.ghosts || !fighter) return false;
    const now = this.game.time;
    const a = opts && opts.dodge ? 0.22 : 0.3;
    if (this.ghosts.reveal(fighter, now, a, 0.32)) return true;
    return !!(opts && opts.force) && this.ghosts.show(fighter, this.game.scene, now, a, 0.32);
  }

  /** Focus: subtle screen-edge vignette pulse (sustained while the focus slow motion runs). */
  focus(fighter) {
    if (fighter && fighter !== this.game.player) return;
    this.vignette.kick(0.9);
    this._focusOn = true;
  }

  /** Fade the mask colour of a dying fighter (restored automatically if it comes back alive). */
  death(fighter) {
    const mat = fighter && fighter.model && fighter.model.materials && fighter.model.materials[1];
    if (!mat || !mat.color) return;
    let slot = null;
    for (const m of this._masks) if (m.f === fighter) { slot = m; break; }
    if (!slot) for (const m of this._masks) if (!m.f) { slot = m; break; }
    if (!slot) return;
    if (slot.f !== fighter) slot.base.copy(mat.color);
    slot.f = fighter; slot.t = 0; slot.mat = mat;
  }

  /** Tiny dust puff where something lands (amount ~0.5..1.2). */
  dust(point, amount = 1) {
    const F = this.sprites;
    if (!F || !point) return;
    const col = DUST[this.chapter] || COLORS.dust;
    const n = amount > 0.8 ? 4 : 3;
    const y = Math.max(0.04, (point.y || 0) + 0.04);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 6.283 + Math.random() * 0.8;
      const ox = Math.cos(a), oz = Math.sin(a);
      puff(F, point.x + ox * 0.18, y, point.z + oz * 0.18, ox * (0.6 + Math.random() * 0.4), 0.12, oz * (0.6 + Math.random() * 0.4),
        0.08, 0.36 * amount, 0.5 + Math.random() * 0.12, col, 0.24);
    }
  }

  /** Learned-move flourish around a fighter (the player). */
  learned(fighter) {
    const F = this.sprites;
    const f = fighter || this.game.player;
    if (!F || !f || !f.position) return;
    const x = f.position.x, y = f.position.y || 0, z = f.position.z;
    ring(F, x, y + 0.04, z, 0, 1, 0, 0.2, 1.1, 0.03, 0.7, COLORS.jade, 0.6, { grow: 2.5, pull: 0 });
    ring(F, x, y + 0.05, z, 0, 1, 0, 0.1, 0.8, 0.015, 0.6, COLORS.jadeLight, 0.4, { delay: 0.12, pull: 0 });
    rising(F, x, y, z, 8, 0.45, 0.2, 1.2, 1.4, 2.2, 0.12, 0.01, 0.45, COLORS.jadeLight, 0.7);
    puff(F, x, y + 1.15, z, 0, 0.1, 0, 0.1, 0.45, 0.35, COLORS.jadeLight, 0.2, 1);
  }

  /** Faint 0.12 s glint on `fighter`'s striking limb (telegraph of a guard breaker / knockdown, full charge). */
  glint(fighter, limb, alpha = 0.55) {
    const F = this.sprites;
    const an = fighter && fighter.animator;
    if (!F || !an || typeof an.strikePoint !== 'function') return;
    const p = an.strikePoint(limb || 'handR', this._v);
    if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return;
    const v = fighter.velocity;
    glint(F, p.x, p.y, p.z, v ? v.x || 0 : 0, v ? v.z || 0 : 0, 0.085, 0.12, COLORS.glint, alpha);
  }

  /** Kahlt heal: a little jade sparkle on the healer. */
  heal(fighter) {
    const F = this.sprites;
    if (!F || !fighter || !fighter.position) return;
    const p = fighter.position;
    rising(F, p.x, p.y || 0, p.z, 4, 0.3, 0.8, 1.4, 0.8, 1.4, 0.07, 0.008, 0.35, COLORS.jadeLight, 0.6);
    puff(F, p.x, (p.y || 0) + 1.15, p.z, 0, 0.05, 0, 0.08, 0.3, 0.25, COLORS.jade, 0.18, 1);
  }

  // ============================================================================================ events

  _wire() {
    const ev = this.game.events;
    if (!ev || typeof ev.on !== 'function') return;
    const on = (n, fn) => ev.on(n, (e) => fn(e || {}));
    const isPlayer = (a, b) => { const p = this.game.player; return !!p && (a === p || b === p); };
    on('attackStart', (e) => this._onAttack(e));
    on('hit', (e) => {
      if (!e.point) return;
      const o = this._ho;
      o.weight = e.weight || (e.move && e.move.weight) || (e.heavy ? 'heavy' : 'light');
      o.counter = !!e.counter; o.killed = !!e.killed; o.focus = e.focus || null; o.defender = e.defender || null;
      this.hit(e.point, e.dir, !!e.heavy, o);
      o.defender = null;
    });
    on('blocked', (e) => {
      if (!e.point) return;
      const o = this._bo;
      o.broken = !!e.guardBroken; o.dir = this._dir(e.attacker, e.defender); o.weight = (e.move && e.move.weight) || 'light';
      this.block(e.point, o);
    });
    on('parried', (e) => {
      if (!e.point) return;
      const o = this._bo;
      o.dir = this._dir(e.attacker, e.defender); o.player = isPlayer(e.attacker, e.defender);
      this.parry(e.point, o);
    });
    on('absorbed', (e) => {
      if (!e.point) return;
      const o = this._bo;
      o.pierced = !!e.pierced; o.dir = this._dir(e.attacker, e.defender);
      this.absorb(e.point, o);
    });
    on('absorbHeal', (e) => this.heal(e.fighter));
    // wind-up tells: only guard breakers / knockdowns / heavy strings (the AI flags heavy = heavy weight or break)
    on('enemyTelegraph', (e) => {
      const m = e.move, pr = m && m.props;
      if (e.counter || !e.fighter || !(e.heavy || (pr && (pr.break || pr.knockdown)))) return;
      this.glint(e.fighter, (m && m.limb) || 'handR', 0.5);
    });
    on('chargeFull', (e) => { if (e.fighter) this.glint(e.fighter, (e.move && e.move.limb) || 'handR', 0.6); });
    on('defend', (e) => { if (e.fighter && typeof e.kind === 'string' && e.kind.startsWith('avoid')) this.ghosts.arm(e.fighter, this.game.scene, this.game.time); });
    on('dodge', (e) => { if (e.fighter) this.ghosts.arm(e.fighter, this.game.scene, this.game.time); });
    on('avoided', (e) => { if (e.defender) { const o = this._bo; o.dodge = e.kind === 'dodge'; o.force = false; this.avoid(e.defender, o); } });
    on('knockdown', (e) => this._watchLanding(e.fighter, 'knockdown'));
    on('fighterDied', (e) => { if (e.fighter) { this.death(e.fighter); this._watchLanding(e.fighter, 'death'); } });
    on('focusReady', (e) => this.focus(e.fighter));
    on('focusAttack', (e) => { if (e.fighter === this.game.player) this.vignette.kick(0.7); });
    on('learned', () => this.learned(this.game.player));
    on('chapterStart', (e) => { this.chapter = e.chapterId || this.chapter; });
    on('worldLoaded', (e) => { this.chapter = e.chapterId || this.chapter; this.sprites.clear(); this.trails.clear(); });
  }

  _dir(a, d) {
    if (!a || !d || !a.position || !d.position) return null;
    const v = this._v2.set(d.position.x - a.position.x, 0, d.position.z - a.position.z);
    const l = v.length();
    return l > 1e-4 ? v.multiplyScalar(1 / l) : null;
  }

  _trailLook(f, weight, limb) {
    const T = TRAIL[weight] || TRAIL.light;
    const o = this._to;
    const leg = LEG.test(limb || '');
    o.life = T.life; o.width = T.width * (leg ? 1.18 : 1); o.alpha = T.alpha;
    const acc = f.model && f.model.accent;
    displayRGB(acc || 0xe8e4da, this._rgb);
    o.r = this._rgb[0]; o.g = this._rgb[1]; o.b = this._rgb[2];
    return T;
  }

  _onAttack(e) {
    const f = e.fighter, m = e.move;
    if (!f || !m || !f.animator || !this.trails) return;
    const info = f.atk && f.atk.move === m ? f.atk.info : null;
    const weight = e.focus ? 'heavy' : m.weight || 'light';
    const start = e.chained && info ? info.chainIn || 0 : 0;
    const hits = info && info.hits && info.hits.length ? info.hits : (Array.isArray(m.hits) && m.hits.length ? m.hits : null);
    // each window is armed over its strike segment: from the last key before the hit (the wind-up extreme) to the
    // end of the hit window, so the ribbon traces the strike arc, not the wind-up or the withdrawal
    if (hits) {
      for (let k = 0; k < hits.length && k < 3; k++) {
        const h = hits[k];
        const limb = h.limb || m.limb || 'handR';
        const T = this._trailLook(f, weight, limb);
        const t = typeof h.t === 'number' ? h.t : m.startup || 0.2;
        const end = typeof h.end === 'number' ? h.end : t + (typeof h.dur === 'number' ? h.dur : m.active || 0.07);
        this.trails.arm(f, m, limb, Math.max(start, strikeFrom(m, t, T.lead)), end, this._to);
      }
    } else {
      const limb = m.limb || 'handR';
      const T = this._trailLook(f, weight, limb);
      const t = typeof m.startup === 'number' ? m.startup : 0.2;
      this.trails.arm(f, m, limb, Math.max(start, strikeFrom(m, t, T.lead)), t + (typeof m.active === 'number' ? m.active : 0.07), this._to);
    }
  }

  _watchLanding(f, kind) {
    if (!f) return;
    // already on the floor (died while knocked down): no second puff
    if (f.animator && typeof f.animator.strikePoint === 'function' && f.position) {
      const p = f.animator.strikePoint('hips', this._v);
      if (p.y - (f.position.y || 0) < 0.4) return;
    }
    let w = null;
    for (const x of this._watch) if (x.f === f) { w = x; break; }
    if (!w) for (const x of this._watch) if (!x.f) { w = x; break; }
    if (!w) w = this._watch[0];
    w.f = f; w.t = 0; w.kind = kind; w.max = kind === 'death' ? 0.85 : 0.6;
  }

  _updateLandings(simDt) {
    for (const w of this._watch) {
      const f = w.f;
      if (!f) continue;
      if (f.removed || !f.position) { w.f = null; continue; }
      w.t += simDt;
      let landed = w.t >= w.max;
      const p = this._v;
      let hy = -1;
      if (f.animator && typeof f.animator.strikePoint === 'function') {
        f.animator.strikePoint('hips', p);
        hy = p.y - (f.position.y || 0);
        if (w.t > 0.12 && hy < 0.36) landed = true;
      }
      if (!landed) continue;
      // dust under the hips (or the feet position)
      if (hy >= 0 && isFinite(p.x)) p.y = f.position.y || 0; else p.set(f.position.x, f.position.y || 0, f.position.z);
      this.dust(p, w.kind === 'death' ? 0.9 : 1);
      const ev = this._landEvt;
      ev.fighter = f; ev.point.copy(p); ev.kind = w.kind;
      w.f = null;
      try { this.game.events.emit('bodyLanded', ev); } catch (e) { /* listeners are guarded by the bus */ }
    }
  }

  _updateMasks(dt) {
    for (const m of this._masks) {
      const f = m.f;
      if (!f) continue;
      if (f.removed) { m.f = null; m.mat = null; continue; }
      if (f.alive) { if (m.mat) m.mat.color.copy(m.base); m.f = null; m.mat = null; continue; }
      if (m.t >= 1.2) continue;
      m.t = Math.min(1.2, m.t + dt);
      const k = m.t / 1.2;
      m.mat.color.copy(m.base).lerp(MASK_DIM, k * k * (3 - 2 * k) * 0.75);
    }
  }

  // ============================================================================================ frame

  update(dt) {
    const g = this.game, cam = g.camera;
    if (!cam || !this.sprites) return;
    cam.updateMatrixWorld();
    const simDt = Math.min(0.1, Math.max(0, g.time - this._lastSim));
    this._lastSim = g.time;
    if (this.sprites.mesh.parent !== g.scene) g.scene.add(this.sprites.mesh);
    if (this.trails.mesh.parent !== g.scene) g.scene.add(this.trails.mesh);
    // particles run on real time (the flash plays through the hitstop freeze), a little slower in slow motion
    const ts = typeof g.timeScale === 'number' ? g.timeScale : 1;
    const fdt = this.freeze ? 0 : dt;
    this.sprites.update(fdt * (ts < 1 ? 0.45 + 0.55 * ts : 1), cam);
    this.trails.update(this.freeze ? 0 : simDt, g.time, cam);
    this.ghosts.update(fdt);
    this._updateLandings(simDt);
    this._updateMasks(dt);
    if (this._focusOn && !(ts < 0.9)) this._focusOn = false;
    if (!this.freeze) this.vignette.update(dt, this._focusOn ? 0.75 : 0);
  }

  /** Tests: advance particles / trails / ghosts by `seconds` without a sim step (then freeze for a screenshot). */
  debugAdvance(seconds) {
    const cam = this.game.camera;
    cam.updateMatrixWorld();
    this.sprites.update(seconds, cam);
    this.ghosts.update(seconds);
  }

  /** Counters for tests / perf HUD. */
  stats() {
    const s = this.sprites, t = this.trails;
    const ghosts = this.ghosts ? this.ghosts.visible : 0;
    return {
      sprites: s ? s.count : 0, spawned: s ? s.spawned : 0, trails: t ? t.active : 0, ghosts,
      drawCalls: (s && s.mesh.visible ? 1 : 0) + (t && t.mesh.visible ? 1 : 0) + ghosts,
      vignette: +this.vignette.opacity.toFixed(3), chapter: this.chapter,
    };
  }

  _installDebug() {
    const g = this.game;
    const d = g.debug || (g.debug = {});
    const self = this;
    /**
     * Trigger an effect in front of the player: 'hit' | 'medium' | 'heavy' | 'counter' | 'kill' | 'block' |
     * 'guardbreak' | 'parry' | 'absorb' | 'pierce' | 'avoid' | 'dust' | 'focus' | 'learned' | 'heal' | 'trail' |
     * 'glint' | 'death' | 'all'. opts: { x, y, z } world point override, { fighter } for avoid / death / trail.
     */
    d.fx = (kind = 'hit', opts = {}) => {
      const p = g.player;
      const yaw = p ? p.yaw : 0;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const pt = new THREE.Vector3(
        typeof opts.x === 'number' ? opts.x : (p ? p.position.x : 0) + fx * 0.75,
        typeof opts.y === 'number' ? opts.y : 1.35,
        typeof opts.z === 'number' ? opts.z : (p ? p.position.z : 0) + fz * 0.75);
      const dir = new THREE.Vector3(fx, 0, fz);
      const f = opts.fighter || p;
      switch (kind) {
        case 'hit': self.hit(pt, dir, false, { weight: 'light' }); break;
        case 'medium': self.hit(pt, dir, false, { weight: 'medium' }); break;
        case 'heavy': self.hit(pt, dir, true, { weight: 'heavy' }); break;
        case 'counter': self.hit(pt, dir, false, { weight: 'medium', counter: true }); break;
        case 'kill': self.hit(pt, dir, true, { weight: 'heavy', killed: true }); break;
        case 'block': self.block(pt, { dir }); break;
        case 'guardbreak': self.block(pt, { dir, broken: true }); break;
        case 'parry': self.parry(pt, { dir }); break;
        case 'absorb': self.absorb(pt, { dir }); break;
        case 'pierce': self.absorb(pt, { dir, pierced: true }); break;
        case 'avoid': if (f) self.avoid(f, { force: true }); break;
        case 'dust': self.dust(new THREE.Vector3(pt.x, 0, pt.z), 1); break;
        case 'focus': self.focus(p); break;
        case 'learned': self.learned(p); break;
        case 'heal': self.heal(p); break;
        case 'trail': if (f) self.trail(f, opts.limb || 'handR', opts.duration || 0.3); break;
        case 'glint': if (f) self.glint(f, opts.limb || 'handR'); break;
        case 'death': if (opts.fighter) self.death(opts.fighter); break;
        case 'all':
          for (const k of ['hit', 'medium', 'heavy', 'counter', 'kill', 'block', 'guardbreak', 'parry', 'absorb', 'pierce', 'avoid', 'dust', 'focus', 'learned', 'heal', 'trail']) d.fx(k, opts);
          break;
        default: return { error: 'unknown fx ' + kind };
      }
      return self.stats();
    };
    d.fxStats = () => self.stats();
    d.fxSystem = self;
  }
}
