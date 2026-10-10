// FX (owned by ATMOSPHERE, see ARCHITECTURE.md §FX / §4.5): pooled voxel particles, explosions, muzzle flashes,
// tracers, blood, sparks, smoke, fire, splashes, bullet impacts (+ decals) and short light flashes.
//
// API: burst(pos, {color, count, speed, size, life, gravity, glow}), blockBreak(x, y, z, id), explosion(pos, radius),
//      muzzleFlash(pos, dir), tracer(from, to, color?), blood(pos, dir), sparks(pos, normal), smoke(pos, {amount, color}),
//      fire(pos, duration) -> {stop(), setPosition(v), setIntensity(k), active}, splash(pos), impact(point, normal, blockId)
// Extras: dust(pos, {amount, color}), trail(pos, {color, size}), flash(pos, {color, intensity, distance, duration}),
//         debris(pos, color, count), clear(), stats().
import * as THREE from 'three';
import { BLOCKS } from '../world/blocks.js';
import {
  ParticlePool, ParticleSpec, createSolidMaterial, createGlowMaterial, createSmokeMaterial, createFireMaterial,
} from './particles.js';
import { LightPool, Tracers, MuzzleFlashes, Decals } from './fx_extras.js';

const MAX_DIST = 150;
const MAX_DIST2 = MAX_DIST * MAX_DIST;
const _c = new THREE.Color();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const rnd = (a, b) => a + Math.random() * (b - a);
// Fire palette in LINEAR space (what instance colours expect): hot yellow #ffd23c, orange #ff7a14, ember red #b3200a.
const HOT_G = 0.64, HOT_B = 0.045, ORANGE_G = 0.2, ORANGE_B = 0.008, EMBER_R = 0.45, EMBER_G = 0.016, EMBER_B = 0.003;

/** Read any colour-ish value (number, '#hex', THREE.Color, {r,g,b}) into _c. Returns false if unusable. */
function readColor(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') { _c.setHex(v); return true; }
  if (typeof v === 'string') { try { _c.set(v); return true; } catch (e) { return false; } }
  if (typeof v === 'object' && typeof v.r === 'number') {
    if (v.isColor) _c.copy(v); else _c.setRGB(v.r > 1 ? v.r / 255 : v.r, v.g > 1 ? v.g / 255 : v.g, v.b > 1 ? v.b / 255 : v.b);
    return true;
  }
  return false;
}

/** Random unit vector into `out`. */
function randDir(out) {
  const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
  return out.set(r * Math.cos(th), u, r * Math.sin(th));
}

class Emitter {
  constructor() { this.pos = new THREE.Vector3(); this.gen = 0; this.reset(); }
  /** Reset state. `gen` is NOT reset: it only grows, so handles to a recycled emitter go stale. */
  reset() {
    this.active = false; this.kind = ''; this.ref = null; this.age = 0; this.duration = Infinity; this.stopping = false;
    this.acc0 = 0; this.acc1 = 0; this.acc2 = 0; this.intensity = 1; this.light = null; this.radius = 1;
    return this;
  }
}

export class FX {
  constructor(game) {
    this.game = game;
    this.enabled = true;
    this.spec = new ParticleSpec();
    this.emitters = [];
    for (let i = 0; i < 48; i++) this.emitters.push(new Emitter());
    this.root = null;
  }

  init() {
    const scene = this.game.scene;
    this.root = new THREE.Group();
    this.root.name = 'fx';
    this.solid = new ParticlePool(1500, createSolidMaterial(), 'solid');
    this.glow = new ParticlePool(400, createGlowMaterial(), 'glow');
    this.firePool = new ParticlePool(400, createFireMaterial(), 'fire');
    this.smokePool = new ParticlePool(360, createSmokeMaterial(), 'smoke');
    this.tracers = new Tracers(64);
    this.flashes = new MuzzleFlashes(8);
    this.decals = new Decals(140);
    this.root.add(this.solid.mesh, this.firePool.mesh, this.glow.mesh, this.smokePool.mesh, this.tracers.mesh, this.flashes.group, this.decals.mesh);
    scene.add(this.root);
    this.lights = new LightPool(scene, 3);

    const d = this.game.debug;
    if (d) {
      d.fx = (name = 'explosion', ...args) => this._debugFx(name, ...args);
      d.fxStats = () => this.stats();
    }
  }

  // ------------------------------------------------------------------------------------------------ helpers
  _cam() { return this.game.camera ? this.game.camera.position : null; }

  /** True when `pos` is close enough to the camera to bother spawning effects. */
  _near(pos, extra = 0) {
    if (!this.enabled || !this.solid || !pos) return false;
    const c = this._cam();
    if (!c) return true;
    const dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z;
    const lim = MAX_DIST + extra;
    return dx * dx + dy * dy + dz * dz <= (extra ? lim * lim : MAX_DIST2);
  }

  /** Block colour (linear) into _c, from world textures when available, else the registry colour. */
  _blockColor(id) {
    let ok = false;
    try {
      const t = this.game.world && this.game.world.textures;
      if (t && typeof t.getColor === 'function') ok = readColor(t.getColor(id));
    } catch (e) { ok = false; }
    if (!ok) _c.setHex((BLOCKS[id] && BLOCKS[id].color) || 0x888888);
    return _c;
  }

  _emitter() {
    for (const e of this.emitters) if (!e.active) { e.reset(); e.active = true; e.gen++; return e; }
    return null;
  }

  // ------------------------------------------------------------------------------------------------ API
  /** Generic cube burst. opts: {color, count=12, speed=4, size=0.15, life=0.8, gravity=18, glow=false, spread=1}. */
  burst(pos, opts = {}) {
    if (!this._near(pos)) return;
    const count = Math.min(200, Math.max(1, Math.round(opts.count ?? 12)));
    const speed = opts.speed ?? 4, size = opts.size ?? 0.15, life = opts.life ?? 0.8, grav = opts.gravity ?? 18;
    if (!readColor(opts.color)) _c.setHex(0xffffff);
    const r = _c.r, g = _c.g, b = _c.b;
    const glow = !!opts.glow;
    const pool = glow ? this.glow : this.solid;
    const s = this.spec;
    for (let i = 0; i < count; i++) {
      s.reset();
      randDir(_d);
      const sp = speed * rnd(0.4, 1.1);
      s.x = pos.x; s.y = pos.y; s.z = pos.z;
      s.vx = _d.x * sp; s.vy = Math.abs(_d.y) * sp * 0.8 + speed * 0.35; s.vz = _d.z * sp;
      s.gravity = grav; s.drag = 0.6; s.life = life * rnd(0.7, 1.2);
      s.size0 = size * rnd(0.7, 1.3); s.size1 = glow ? s.size0 * 0.4 : s.size0 * 0.3; s.sizePow = 2;
      const k = rnd(0.85, 1.15);
      s.r = r * k; s.g = g * k; s.b = b * k;
      s.spin = 8; s.collide = !glow; s.bounce = 0.35;
      pool.emit(s);
    }
  }

  /** Small cubes in the block's colour bursting out of a broken block. */
  blockBreak(x, y, z, blockId) {
    _t1.set(x + 0.5, y + 0.5, z + 0.5);
    if (!this._near(_t1)) return;
    const col = this._blockColor(blockId);
    const r = col.r, g = col.g, b = col.b;
    const def = BLOCKS[blockId];
    const plant = def && def.shape === 'cross';
    const n = plant ? 9 : 16;
    const s = this.spec;
    for (let i = 0; i < n; i++) {
      s.reset();
      const ox = Math.random(), oy = Math.random(), oz = Math.random();
      s.x = x + 0.1 + ox * 0.8; s.y = y + 0.1 + oy * 0.8; s.z = z + 0.1 + oz * 0.8;
      s.vx = (ox - 0.5) * rnd(2.5, 5); s.vy = rnd(1.5, 4.5); s.vz = (oz - 0.5) * rnd(2.5, 5);
      s.gravity = 22; s.drag = 0.4; s.life = rnd(0.55, 1.15);
      s.size0 = plant ? rnd(0.06, 0.1) : rnd(0.1, 0.19); s.size1 = s.size0 * 0.35; s.sizePow = 3;
      const k = rnd(0.72, 1.18);
      s.r = r * k; s.g = g * k; s.b = b * k;
      s.spin = 9; s.collide = true; s.bounce = 0.32;
      this.solid.emit(s);
    }
    // a little dust puff
    if (!plant) {
      for (let i = 0; i < 2; i++) {
        s.reset();
        s.x = x + 0.5 + rnd(-0.3, 0.3); s.y = y + 0.4; s.z = z + 0.5 + rnd(-0.3, 0.3);
        s.vx = rnd(-0.5, 0.5); s.vy = rnd(0.3, 0.9); s.vz = rnd(-0.5, 0.5);
        s.drag = 1.5; s.life = rnd(0.5, 0.8); s.size0 = 0.45; s.size1 = 0.9;
        s.r = r * 0.6 + 0.3; s.g = g * 0.6 + 0.3; s.b = b * 0.6 + 0.3; s.alpha = 0.35; s.fadeStart = 0.2;
        this.smokePool.emit(s);
      }
    }
  }

  /** Big boom: light flash, fireball, sparks, debris, smoke column, ground dust ring and camera shake. */
  explosion(pos, radius = 4) {
    if (!pos) return;
    const R = Math.max(1, Math.min(14, Number(radius) || 4));
    const big = Math.max(0.5, Math.min(2.4, R / 4));
    this._shake(pos, R);
    if (!this._near(pos, 40)) return;
    const s = this.spec;
    const px = pos.x, py = pos.y, pz = pos.z;

    this.lights?.flash(px, py + 1.2, pz, 0xffa24a, 1600 * big, R * 7 + 8, 0.32, 5);

    // core fireball: a cluster of big voxel blobs that pop in, burn orange -> red and collapse
    for (let i = 0; i < 12; i++) {
      s.reset();
      randDir(_d);
      const rr = R * rnd(0.05, 0.35);
      s.x = px + _d.x * rr; s.y = py + Math.abs(_d.y) * rr + 0.4; s.z = pz + _d.z * rr;
      s.vx = _d.x * R * 0.6; s.vy = 1.8 + Math.abs(_d.y) * R * 0.5; s.vz = _d.z * R * 0.6;
      s.drag = 2.6; s.gravity = -1; s.life = rnd(0.55, 0.95);
      s.size0 = R * rnd(0.3, 0.52); s.size1 = R * 0.05; s.popIn = 0.08; s.sizePow = 1.6;
      // inner cubes burn white-hot -> yellow, outer ones orange -> ember red
      const inner = rr < R * 0.18;
      if (inner) { s.r = 1.0; s.g = 0.85; s.b = 0.35; s.r1 = 1.0; s.g1 = ORANGE_G; s.b1 = ORANGE_B; }
      else { const hot = Math.random(); s.r = rnd(0.85, 1.0); s.g = ORANGE_G + (HOT_G - ORANGE_G) * hot; s.b = HOT_B * hot; s.r1 = EMBER_R; s.g1 = EMBER_G; s.b1 = EMBER_B; }
      s.colorPow = 0.9;
      s.spin = 1.5; s.rot0 = 0.35;
      this.firePool.emit(s);
    }
    // flame chunks flying outward
    const nFire = Math.round(30 * big);
    for (let i = 0; i < nFire; i++) {
      s.reset();
      randDir(_d);
      _d.y = Math.abs(_d.y) * 0.9 + 0.1;
      const sp = R * rnd(2, 4.6);
      s.x = px; s.y = py + 0.4; s.z = pz;
      s.vx = _d.x * sp; s.vy = _d.y * sp; s.vz = _d.z * sp;
      s.drag = 3.4; s.gravity = -1.5; s.life = rnd(0.5, 1.05);
      s.size0 = rnd(0.45, 1.0) * big; s.size1 = 0.06; s.popIn = 0.06; s.sizePow = 1.2;
      s.r = 1.0; s.g = rnd(ORANGE_G, HOT_G); s.b = rnd(0, HOT_B); s.r1 = EMBER_R; s.g1 = EMBER_G; s.b1 = EMBER_B; s.colorPow = 0.8;
      s.spin = 4; s.rot0 = 0.6;
      this.firePool.emit(s);
    }
    // bright additive heart: a flash that reads at night (additive would wash out to white against a day sky)
    const dark = 1 - 0.85 * (this.game.sky && typeof this.game.sky.lightLevel === 'number' ? this.game.sky.lightLevel : 1);
    for (let i = 0; i < 3; i++) {
      s.reset();
      s.x = px + rnd(-0.4, 0.4); s.y = py + 0.8 + rnd(0, 0.5); s.z = pz + rnd(-0.4, 0.4);
      s.life = rnd(0.12, 0.2); s.size0 = R * 0.4; s.size1 = R * 0.55; s.popIn = 0.15;
      s.r = 1 * dark; s.g = 0.45 * dark; s.b = 0.1 * dark;
      this.glow.emit(s);
    }
    // sparks
    const nSpark = Math.round(22 * big);
    for (let i = 0; i < nSpark; i++) {
      s.reset();
      randDir(_d);
      _d.y = Math.abs(_d.y) * 0.8 + 0.2;
      const sp = rnd(13, 26);
      s.x = px; s.y = py + 0.5; s.z = pz;
      s.vx = _d.x * sp; s.vy = _d.y * sp; s.vz = _d.z * sp;
      s.gravity = 18; s.drag = 1.2; s.life = rnd(0.5, 1.15);
      s.size0 = 0.07; s.size1 = 0.04; s.stretch = 0.06;
      s.r = 1.0; s.g = 0.7; s.b = 0.2; s.r1 = 1.0; s.g1 = 0.18; s.b1 = 0.01;
      this.glow.emit(s);
    }
    // debris: ground colour + charcoal
    let gid = 0;
    const w = this.game.world;
    if (w && w.getBlock) {
      for (let dy = 1; dy <= 3 && !gid; dy++) {
        const id = w.getBlock(Math.floor(px), Math.floor(py) - dy, Math.floor(pz));
        if (id && BLOCKS[id] && BLOCKS[id].solid) gid = id;
      }
    }
    const gc = this._blockColor(gid || 2);
    const gr = gc.r, gg = gc.g, gb = gc.b;
    const nDeb = Math.round(26 * big);
    for (let i = 0; i < nDeb; i++) {
      s.reset();
      randDir(_d);
      _d.y = Math.abs(_d.y) * 1.2 + 0.35;
      _d.normalize();
      const sp = rnd(6, 15) * Math.sqrt(big);
      s.x = px + rnd(-0.5, 0.5); s.y = py + 0.5; s.z = pz + rnd(-0.5, 0.5);
      s.vx = _d.x * sp; s.vy = _d.y * sp; s.vz = _d.z * sp;
      s.gravity = 24; s.drag = 0.25; s.life = rnd(2.6, 4.6);
      s.size0 = rnd(0.16, 0.42); s.size1 = s.size0 * 0.5; s.sizePow = 4;
      if (Math.random() < 0.35) { const k = rnd(0.08, 0.16); s.r = k; s.g = k; s.b = k; }
      else { const k = rnd(0.6, 1.05); s.r = gr * k; s.g = gg * k; s.b = gb * k; }
      s.spin = 14; s.collide = true; s.bounce = 0.38;
      this.solid.emit(s);
    }
    // black smoke ball that thickens as the fireball dies
    for (let i = 0; i < Math.round(9 * big); i++) {
      s.reset();
      randDir(_d);
      _d.y = Math.abs(_d.y);
      const sp = rnd(2.5, 5.5);
      s.x = px; s.y = py + 0.8 + R * 0.25; s.z = pz;
      s.vx = _d.x * sp; s.vy = _d.y * sp + 1.5; s.vz = _d.z * sp;
      s.drag = 1.8; s.gravity = -0.6; s.life = rnd(1.4, 2.4);
      s.size0 = R * rnd(0.16, 0.26); s.size1 = R * rnd(0.42, 0.6); s.popIn = 0.12; s.sizePow = 0.6;
      const k = rnd(0.08, 0.15);
      s.r = k; s.g = k; s.b = k; s.r1 = 0.32; s.g1 = 0.31; s.b1 = 0.3;
      s.alpha = 0.8; s.fadeStart = 0.35; s.fadeIn = 0.3; s.spin = 0.15; s.rot0 = 0.12;
      this.smokePool.emit(s);
    }
    // ground dust ring (when there is ground nearby)
    let groundY = null;
    if (w && w.isSolid) {
      for (let dy = 0; dy <= 3; dy++) if (w.isSolid(Math.floor(px), Math.floor(py) - dy, Math.floor(pz))) { groundY = Math.floor(py) - dy + 1; break; }
    }
    if (groundY !== null) {
      const nRing = Math.round(16 * big);
      for (let i = 0; i < nRing; i++) {
        s.reset();
        const a = (i / nRing) * Math.PI * 2 + rnd(-0.15, 0.15);
        const sp = rnd(8, 13) * Math.sqrt(big);
        s.x = px + Math.cos(a) * 0.6; s.y = groundY + 0.35; s.z = pz + Math.sin(a) * 0.6;
        s.vx = Math.cos(a) * sp; s.vy = rnd(0.2, 1.2); s.vz = Math.sin(a) * sp;
        s.drag = 3.2; s.life = rnd(0.9, 1.5);
        s.size0 = 0.5 * big; s.size1 = 1.5 * big; s.sizePow = 0.7;
        s.r = gr * 0.45 + 0.3; s.g = gg * 0.45 + 0.28; s.b = gb * 0.45 + 0.26;
        s.alpha = 0.5; s.fadeStart = 0.25; s.spin = 0.2; s.rot0 = 0.1;
        this.smokePool.emit(s);
      }
    }
    // rising smoke column for a few seconds
    const e = this._emitter();
    if (e) {
      e.kind = 'column'; e.pos.set(px, py, pz); e.duration = 1.9; e.intensity = big; e.radius = R; e.age = -0.2;
    }
  }

  /** Bright additive star at the muzzle + a very short light. */
  muzzleFlash(pos, dir) {
    if (!this._near(pos) || !dir) return;
    this.flashes.add(pos, dir, 0.42);
    this.lights?.flash(pos.x, pos.y, pos.z, 0xffc070, 55, 9, 0.06, 1);
    // two tiny sparks
    const s = this.spec;
    for (let i = 0; i < 2; i++) {
      s.reset();
      randDir(_d).multiplyScalar(0.35).add(dir);
      const sp = rnd(8, 14);
      s.x = pos.x; s.y = pos.y; s.z = pos.z;
      s.vx = _d.x * sp; s.vy = _d.y * sp; s.vz = _d.z * sp;
      s.gravity = 10; s.life = rnd(0.08, 0.16); s.size0 = 0.035; s.size1 = 0.02; s.stretch = 0.05;
      s.r = 1; s.g = 0.8; s.b = 0.4;
      this.glow.emit(s);
    }
  }

  /** Streak from muzzle to impact. color = hex (default warm yellow). */
  tracer(from, to, color) {
    if (!from || !to) return;
    if (!this._near(from) && !this._near(to)) return;
    if (!readColor(color)) _c.setRGB(1.0, 0.82, 0.45);
    this.tracers.add(from.x, from.y, from.z, to.x, to.y, to.z, _c.r * 1.4, _c.g * 1.4, _c.b * 1.4);
  }

  /** Red voxel spray along `dir` (hit direction) + a little mist. */
  blood(pos, dir) {
    if (!this._near(pos)) return;
    const s = this.spec;
    const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : 0;
    for (let i = 0; i < 13; i++) {
      s.reset();
      randDir(_d);
      const sp = rnd(1.5, 5);
      s.x = pos.x; s.y = pos.y; s.z = pos.z;
      s.vx = dx * sp + _d.x * 1.8; s.vy = dy * sp + _d.y * 1.8 + 1.5; s.vz = dz * sp + _d.z * 1.8;
      s.gravity = 20; s.drag = 0.8; s.life = rnd(0.5, 1.1);
      s.size0 = rnd(0.05, 0.12); s.size1 = s.size0 * 0.6; s.sizePow = 3;
      const k = rnd(0.55, 1.0);
      s.r = 0.55 * k; s.g = 0.02 * k; s.b = 0.02 * k;
      s.spin = 6; s.collide = true; s.bounce = 0.05;
      this.solid.emit(s);
    }
    for (let i = 0; i < 2; i++) {
      s.reset();
      s.x = pos.x + dx * 0.2; s.y = pos.y + dy * 0.2; s.z = pos.z + dz * 0.2;
      s.vx = dx * 1.2; s.vy = 0.2; s.vz = dz * 1.2;
      s.drag = 3; s.life = rnd(0.25, 0.4); s.size0 = 0.22; s.size1 = 0.55;
      s.r = 0.4; s.g = 0.01; s.b = 0.01; s.alpha = 0.45; s.fadeStart = 0.2;
      this.smokePool.emit(s);
    }
  }

  /** Bright streak sparks bouncing off a surface. */
  sparks(pos, normal) {
    if (!this._near(pos)) return;
    const s = this.spec;
    const nx = normal ? normal.x : 0, ny = normal ? normal.y : 1, nz = normal ? normal.z : 0;
    const n = 9 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      s.reset();
      randDir(_d);
      _d.x += nx * 1.3; _d.y += ny * 1.3 + 0.3; _d.z += nz * 1.3;
      _d.normalize();
      const sp = rnd(5, 12);
      s.x = pos.x + nx * 0.03; s.y = pos.y + ny * 0.03; s.z = pos.z + nz * 0.03;
      s.vx = _d.x * sp; s.vy = _d.y * sp; s.vz = _d.z * sp;
      s.gravity = 22; s.drag = 0.9; s.life = rnd(0.2, 0.5);
      s.size0 = rnd(0.03, 0.055); s.size1 = 0.02; s.stretch = 0.045;
      s.r = 1.0; s.g = 0.72; s.b = 0.25; s.r1 = 1.0; s.g1 = 0.2; s.b1 = 0.02;
      this.glow.emit(s);
    }
  }

  /**
   * Smoke puffs. opts: {amount = 3 (puffs this call; the fractional part is a probability), color = dark grey}.
   * For continuous smoke call it every frame with a small amount (~0.15-0.3). Throttles itself when the pool fills.
   */
  smoke(pos, opts = {}) {
    if (!this._near(pos)) return;
    const fill = this.smokePool.count / this.smokePool.cap;
    if (fill > 0.55 && Math.random() < (fill - 0.55) / 0.45) return;
    let amount = opts.amount ?? 3;
    let n = Math.floor(amount);
    if (Math.random() < amount - n) n++;
    if (n <= 0) return;
    n = Math.min(n, 30);
    if (!readColor(opts.color)) _c.setRGB(0.2, 0.2, 0.21);
    const r = _c.r, g = _c.g, b = _c.b;
    const s = this.spec;
    for (let i = 0; i < n; i++) {
      s.reset();
      s.x = pos.x + rnd(-0.3, 0.3); s.y = pos.y + rnd(-0.1, 0.2); s.z = pos.z + rnd(-0.3, 0.3);
      s.vx = rnd(-0.4, 0.4) + 0.35; s.vy = rnd(1.1, 2.2); s.vz = rnd(-0.4, 0.4) + 0.15;
      s.drag = 0.5; s.gravity = -0.3; s.life = rnd(1.6, 2.6);
      s.size0 = rnd(0.35, 0.6); s.size1 = rnd(1.4, 2.1); s.popIn = 0.08; s.sizePow = 0.7;
      const k = rnd(0.85, 1.15);
      s.r = r * k; s.g = g * k; s.b = b * k; s.r1 = r * 0.6 + 0.16; s.g1 = g * 0.6 + 0.16; s.b1 = b * 0.6 + 0.16;
      s.alpha = 0.6; s.fadeStart = 0.3; s.spin = 0.2; s.rot0 = 0.15;
      this.smokePool.emit(s);
    }
  }

  /**
   * Looping fire (burning cars etc). `pos` may be a live Vector3 the caller keeps updating: the fire follows it.
   * duration in seconds (0/undefined/Infinity = until stop()). Returns {stop(), setPosition(v), setIntensity(k), active}.
   */
  fire(pos, duration) {
    const e = this._emitter();
    const dead = { stop() {}, setPosition() {}, setIntensity() {}, get active() { return false; } };
    if (!e || !pos) return dead;
    e.kind = 'fire';
    e.ref = (pos && pos.isVector3) ? pos : null;
    e.pos.set(pos.x || 0, pos.y || 0, pos.z || 0);
    e.duration = duration > 0 && Number.isFinite(duration) ? duration : Infinity;
    const gen = e.gen;
    const fx = this;
    return {
      stop() { if (e.gen === gen && e.active) { e.stopping = true; fx._releaseLight(e); } },
      setPosition(v) { if (e.gen === gen && v) { e.ref = null; e.pos.set(v.x, v.y, v.z); } },
      setIntensity(k) { if (e.gen === gen) e.intensity = Math.max(0.1, Math.min(3, k)); },
      get active() { return e.gen === gen && e.active && !e.stopping; },
    };
  }

  /** Water splash: droplets + foam ring. */
  splash(pos) {
    if (!this._near(pos)) return;
    const s = this.spec;
    const sy = pos.y;
    for (let i = 0; i < 20; i++) {
      s.reset();
      const a = Math.random() * Math.PI * 2, rr = rnd(0.5, 2.6);
      s.x = pos.x + Math.cos(a) * 0.2; s.y = sy + 0.05; s.z = pos.z + Math.sin(a) * 0.2;
      s.vx = Math.cos(a) * rr; s.vy = rnd(3, 7.5); s.vz = Math.sin(a) * rr;
      s.gravity = 24; s.drag = 0.3; s.life = 1.6; s.killBelow = sy - 0.4;
      s.size0 = rnd(0.07, 0.15); s.size1 = s.size0 * 0.7;
      const k = rnd(0.85, 1.1);
      s.r = 0.62 * k; s.g = 0.8 * k; s.b = 0.98 * k; s.spin = 5;
      this.solid.emit(s);
    }
    for (let i = 0; i < 10; i++) {
      s.reset();
      const a = (i / 10) * Math.PI * 2;
      s.x = pos.x + Math.cos(a) * 0.4; s.y = sy + 0.05; s.z = pos.z + Math.sin(a) * 0.4;
      s.vx = Math.cos(a) * rnd(1.5, 2.8); s.vy = rnd(0.1, 0.6); s.vz = Math.sin(a) * rnd(1.5, 2.8);
      s.drag = 2.5; s.life = rnd(0.6, 1.0); s.size0 = 0.3; s.size1 = 0.75; s.sizePow = 0.7;
      s.r = 0.9; s.g = 0.95; s.b = 1.0; s.alpha = 0.55; s.fadeStart = 0.2;
      this.smokePool.emit(s);
    }
  }

  /** Bullet hitting a block: chips in the block colour, a dust puff, sparks on hard blocks, and a bullet hole. */
  impact(point, normal, blockId) {
    if (!this._near(point)) return;
    const def = BLOCKS[blockId];
    const nx = normal ? normal.x : 0, ny = normal ? normal.y : 1, nz = normal ? normal.z : 0;
    const col = this._blockColor(blockId || 2);
    const r = col.r, g = col.g, b = col.b;
    const s = this.spec;
    const n = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      s.reset();
      randDir(_d);
      _d.x += nx * 1.5; _d.y += ny * 1.5 + 0.4; _d.z += nz * 1.5;
      _d.normalize();
      const sp = rnd(2, 5.5);
      s.x = point.x + nx * 0.05; s.y = point.y + ny * 0.05; s.z = point.z + nz * 0.05;
      s.vx = _d.x * sp; s.vy = _d.y * sp; s.vz = _d.z * sp;
      s.gravity = 22; s.drag = 0.6; s.life = rnd(0.4, 0.8);
      s.size0 = rnd(0.05, 0.1); s.size1 = s.size0 * 0.4; s.sizePow = 2;
      const k = rnd(0.7, 1.15);
      s.r = r * k; s.g = g * k; s.b = b * k; s.spin = 10; s.collide = true; s.bounce = 0.3;
      this.solid.emit(s);
    }
    s.reset();
    s.x = point.x + nx * 0.15; s.y = point.y + ny * 0.15; s.z = point.z + nz * 0.15;
    s.vx = nx * 0.8; s.vy = ny * 0.8 + 0.3; s.vz = nz * 0.8;
    s.drag = 2.2; s.life = rnd(0.5, 0.8); s.size0 = 0.18; s.size1 = 0.6; s.sizePow = 0.6;
    s.r = r * 0.55 + 0.3; s.g = g * 0.55 + 0.3; s.b = b * 0.55 + 0.3; s.alpha = 0.45; s.fadeStart = 0.15;
    this.smokePool.emit(s);
    const hard = def && (def.tool === 'pickaxe' || def.hardness >= 3) && !def.liquid;
    if (hard && Math.random() < 0.75) {
      for (let i = 0; i < 4; i++) {
        s.reset();
        randDir(_d);
        _d.x += nx * 1.6; _d.y += ny * 1.6 + 0.2; _d.z += nz * 1.6;
        _d.normalize();
        const sp = rnd(6, 11);
        s.x = point.x; s.y = point.y; s.z = point.z;
        s.vx = _d.x * sp; s.vy = _d.y * sp; s.vz = _d.z * sp;
        s.gravity = 20; s.life = rnd(0.12, 0.3); s.size0 = 0.035; s.size1 = 0.02; s.stretch = 0.04;
        s.r = 1; s.g = 0.85; s.b = 0.5; s.r1 = 1; s.g1 = 0.45; s.b1 = 0.1;
        this.glow.emit(s);
      }
    }
    // bullet hole on solid, non-glass, non-plant blocks with an axis-aligned face normal
    if (def && def.solid && !def.transparent && !def.cutout && def.shape === 'cube' && normal) {
      const ax = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
      if (ax > 0.99 && ax < 1.01) {
        const bx = Math.floor(point.x - nx * 0.01), by = Math.floor(point.y - ny * 0.01), bz = Math.floor(point.z - nz * 0.01);
        this.decals.add(point.x, point.y, point.z, nx, ny, nz, rnd(0.1, 0.15), 22, bx, by, bz, 0.1);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ extras
  /** Light-coloured low dust (tyre smoke, landings, mining). opts: {amount = 2, color = light grey}. */
  dust(pos, opts = {}) {
    if (!this._near(pos)) return;
    const amount = opts.amount ?? 2;
    let n = Math.floor(amount);
    if (Math.random() < amount - n) n++;
    if (!readColor(opts.color)) _c.setRGB(0.72, 0.7, 0.68);
    const r = _c.r, g = _c.g, b = _c.b;
    const s = this.spec;
    for (let i = 0; i < Math.min(n, 20); i++) {
      s.reset();
      s.x = pos.x + rnd(-0.25, 0.25); s.y = pos.y + 0.15; s.z = pos.z + rnd(-0.25, 0.25);
      s.vx = rnd(-0.8, 0.8); s.vy = rnd(0.3, 1.0); s.vz = rnd(-0.8, 0.8);
      s.drag = 1.6; s.life = rnd(0.8, 1.4); s.size0 = rnd(0.3, 0.5); s.size1 = rnd(1.1, 1.6); s.sizePow = 0.6;
      s.r = r; s.g = g; s.b = b; s.alpha = 0.42; s.fadeStart = 0.2; s.spin = 0.3; s.rot0 = 0.2;
      this.smokePool.emit(s);
    }
  }

  /** Rocket/projectile trail: one smoke puff + one ember per call (call every frame while flying). */
  trail(pos, opts = {}) {
    if (!this._near(pos)) return;
    const s = this.spec;
    s.reset();
    s.x = pos.x + rnd(-0.05, 0.05); s.y = pos.y + rnd(-0.05, 0.05); s.z = pos.z + rnd(-0.05, 0.05);
    s.vx = rnd(-0.3, 0.3); s.vy = rnd(0.2, 0.6); s.vz = rnd(-0.3, 0.3);
    s.drag = 1.2; s.life = rnd(1.2, 1.9); s.size0 = (opts.size ?? 0.35); s.size1 = s.size0 * 3.2; s.sizePow = 0.6; s.popIn = 0.05;
    if (readColor(opts.color)) { s.r = _c.r; s.g = _c.g; s.b = _c.b; } else { s.r = 0.62; s.g = 0.6; s.b = 0.58; }
    s.alpha = 0.6; s.fadeStart = 0.15; s.spin = 0.6; s.rot0 = 0.4;
    this.smokePool.emit(s);
    s.reset();
    s.x = pos.x; s.y = pos.y; s.z = pos.z;
    s.vx = rnd(-0.6, 0.6); s.vy = rnd(-0.6, 0.6); s.vz = rnd(-0.6, 0.6);
    s.life = rnd(0.12, 0.22); s.size0 = 0.22; s.size1 = 0.05;
    s.r = 1; s.g = 0.75; s.b = 0.3; s.r1 = 1; s.g1 = 0.3; s.b1 = 0.05;
    this.glow.emit(s);
  }

  /** Pooled point-light flash. opts: {color = 0xffaa55, intensity = 300, distance = 18, duration = 0.2}. */
  flash(pos, opts = {}) {
    if (!this._near(pos)) return;
    this.lights?.flash(pos.x, pos.y, pos.z, opts.color ?? 0xffaa55, opts.intensity ?? 300, opts.distance ?? 18, opts.duration ?? 0.2, opts.priority ?? 2);
  }

  /** Coloured debris cubes (e.g. vehicle parts). */
  debris(pos, color = 0x444444, count = 12) {
    this.burst(pos, { color, count, speed: 7, size: 0.22, life: 2.2, gravity: 24 });
  }

  /** Remove all live particles and effects. */
  clear() {
    this.solid?.clear(); this.glow?.clear(); this.firePool?.clear(); this.smokePool?.clear();
    for (const e of this.emitters) { this._releaseLight(e); e.reset(); }
  }

  stats() {
    return {
      solid: this.solid?.count || 0, fire: this.firePool?.count || 0, glow: this.glow?.count || 0, smoke: this.smokePool?.count || 0,
      tracers: this.tracers?.count || 0, decals: this.decals?.count || 0,
      emitters: this.emitters.filter((e) => e.active).length,
      lights: this.lights ? this.lights.lights.filter((l) => l.intensity > 0).length : 0,
    };
  }

  // ------------------------------------------------------------------------------------------------ internals
  _shake(pos, R) {
    const c = this._cam();
    const rig = this.game.cameraRig;
    if (!c || !rig || typeof rig.shake !== 'function') return;
    const d = Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z);
    const k = Math.min(1, Math.max(0, 1.15 - d / (R * 9)));
    if (k > 0.02) { try { rig.shake(k); } catch (e) { /* camera stub */ } }
  }

  _releaseLight(e) {
    if (e.light) { this.lights?.release(e.light); e.light = null; }
  }

  _updateEmitters(dt) {
    const s = this.spec;
    for (const e of this.emitters) {
      if (!e.active) continue;
      e.age += dt;
      if (e.ref) e.pos.copy(e.ref);
      const p = e.pos;
      if (e.kind === 'column') {
        // smoke column: dense at first, thinning out
        if (e.age > e.duration) { e.reset(); continue; }
        if (e.age < 0 || !this._near(p, 40)) continue; // negative age = start delay
        const rate = 16 * e.intensity * (1 - e.age / e.duration) + 3;
        e.acc0 += rate * dt;
        while (e.acc0 >= 1) {
          e.acc0 -= 1;
          s.reset();
          const R = e.radius;
          s.x = p.x + rnd(-0.4, 0.4) * R * 0.4; s.y = p.y + rnd(0.5, 1.5); s.z = p.z + rnd(-0.4, 0.4) * R * 0.4;
          s.vx = rnd(-0.6, 0.6) + 0.4; s.vy = rnd(2.8, 5.2); s.vz = rnd(-0.6, 0.6) + 0.2;
          s.drag = 0.55; s.gravity = -0.4; s.life = rnd(2.2, 3.4);
          s.size0 = rnd(0.6, 0.9) * e.intensity; s.size1 = rnd(2.2, 3.0) * e.intensity; s.sizePow = 0.6; s.popIn = 0.08;
          const k = rnd(0.1, 0.18);
          s.r = k; s.g = k; s.b = k * 0.98; s.r1 = 0.38; s.g1 = 0.37; s.b1 = 0.36;
          s.alpha = 0.66; s.fadeStart = 0.35; s.fadeIn = 0.15; s.spin = 0.15; s.rot0 = 0.12;
          this.smokePool.emit(s);
        }
        continue;
      }
      if (e.kind === 'fire') {
        if (e.stopping || e.age > e.duration) { this._releaseLight(e); e.reset(); continue; }
        const near = this._near(p);
        if (!near) { if (e.light) this._releaseLight(e); continue; }
        const I = e.intensity;
        // our light may have been stolen by a higher-priority flash (explosion)
        if (e.light && !e.light.userData.hold) e.light = null;
        if (!e.light && this.lights) e.light = this.lights.flash(p.x, p.y + 0.8, p.z, 0xff7a2a, 26 * I, 14, 1, 1, true, e.ref || e.pos, 0.45);
        // flames
        e.acc0 += 30 * I * dt;
        while (e.acc0 >= 1) {
          e.acc0 -= 1;
          s.reset();
          s.x = p.x + rnd(-0.55, 0.55) * I; s.y = p.y + rnd(0, 0.3); s.z = p.z + rnd(-0.55, 0.55) * I;
          s.vx = rnd(-0.35, 0.35); s.vy = rnd(1.6, 3.2); s.vz = rnd(-0.35, 0.35);
          s.drag = 0.8; s.gravity = -1; s.life = rnd(0.35, 0.75);
          s.size0 = rnd(0.25, 0.45) * Math.sqrt(I); s.size1 = 0.03; s.popIn = 0.1;
          s.r = 1.0; s.g = rnd(ORANGE_G, HOT_G); s.b = rnd(0, HOT_B); s.r1 = EMBER_R; s.g1 = EMBER_G; s.b1 = EMBER_B; s.colorPow = 0.8;
          s.spin = 2; s.rot0 = 0.3;
          this.firePool.emit(s);
        }
        // embers
        e.acc1 += 3.5 * I * dt;
        while (e.acc1 >= 1) {
          e.acc1 -= 1;
          s.reset();
          s.x = p.x + rnd(-0.4, 0.4); s.y = p.y + 0.6; s.z = p.z + rnd(-0.4, 0.4);
          s.vx = rnd(-0.8, 0.8); s.vy = rnd(2.5, 4.5); s.vz = rnd(-0.8, 0.8);
          s.drag = 0.4; s.gravity = 0.6; s.life = rnd(0.9, 1.6); s.size0 = 0.05; s.size1 = 0.03;
          s.r = 1; s.g = 0.35; s.b = 0.03; s.r1 = 0.7; s.g1 = 0.05; s.b1 = 0;
          this.glow.emit(s);
        }
        // smoke
        e.acc2 += 6.5 * I * dt;
        while (e.acc2 >= 1) {
          e.acc2 -= 1;
          s.reset();
          s.x = p.x + rnd(-0.4, 0.4); s.y = p.y + rnd(0.9, 1.4); s.z = p.z + rnd(-0.4, 0.4);
          s.vx = rnd(-0.3, 0.3) + 0.3; s.vy = rnd(1.6, 2.6); s.vz = rnd(-0.3, 0.3) + 0.1;
          s.drag = 0.45; s.gravity = -0.3; s.life = rnd(1.8, 2.8);
          s.size0 = rnd(0.35, 0.55) * Math.sqrt(I); s.size1 = rnd(1.4, 2.0) * Math.sqrt(I); s.popIn = 0.1; s.sizePow = 0.6;
          const k = rnd(0.1, 0.16);
          s.r = k; s.g = k; s.b = k; s.r1 = 0.3; s.g1 = 0.29; s.b1 = 0.28;
          s.alpha = 0.6; s.fadeStart = 0.3; s.fadeIn = 0.15; s.spin = 0.15; s.rot0 = 0.12;
          this.smokePool.emit(s);
        }
      }
    }
  }

  update(dt) {
    if (!this.solid) return;
    const world = this.game.world && this.game.world.isSolid ? this.game.world : null;
    const light = this.game.sky && typeof this.game.sky.lightLevel === 'number' ? this.game.sky.lightLevel : 1;
    this._updateEmitters(dt);
    this.solid.update(dt, world, 1);
    this.glow.update(dt, null, 1);
    this.firePool.update(dt, null, 1);
    this.smokePool.update(dt, null, 0.12 + 0.88 * light);
    this.tracers.update(dt);
    this.flashes.update(dt);
    this.decals.update(dt, world);
    this.lights.update(dt);
  }

  // ------------------------------------------------------------------------------------------------ debug
  _debugFx(name, ...args) {
    const cam = this.game.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const at = _t1.copy(cam.position).addScaledVector(dir, 10);
    const w = this.game.world;
    if (w && w.findGround) { const gy = w.findGround(Math.floor(at.x), Math.floor(at.z)); if (gy > 0 && Math.abs(gy - at.y) < 20) at.y = gy + 0.1; }
    const p = new THREE.Vector3().copy(at);
    switch (name) {
      case 'explosion': this.explosion(p, args[0] ?? 5); break;
      case 'fire': { const h = this.fire(p, args[0] ?? 6); return h.active; }
      case 'smoke': this.smoke(p, { amount: args[0] ?? 8 }); break;
      case 'blood': this.blood(p.setY(p.y + 1), dir); break;
      case 'sparks': this.sparks(p, _n.set(0, 1, 0)); break;
      case 'splash': this.splash(p); break;
      case 'blockBreak': this.blockBreak(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), args[0] ?? 3); break;
      case 'impact': this.impact(p, _n.set(0, 1, 0), args[0] ?? 13); break;
      case 'muzzle': this.muzzleFlash(_t2.copy(cam.position).addScaledVector(dir, 2), dir); break;
      case 'tracer': this.tracer(_t2.copy(cam.position).addScaledVector(dir, 1).setY(cam.position.y - 0.3), p); break;
      case 'burst': this.burst(p, { color: args[0] ?? 0x33ccff, count: 30, glow: true }); break;
      case 'dust': this.dust(p, { amount: 6 }); break;
      default: return 'unknown fx ' + name;
    }
    return this.stats();
  }
}
