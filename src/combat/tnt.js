// Primed TNT (COMBAT): a lit TNT block that hops, falls with gravity, flashes white faster and faster, hisses,
// swells, then explodes (radius 4, power 3, damage 100). Registered as an entity (kind 'tnt') so explosions can
// fling it (chain reactions throw lit TNT around like in the block game). Shooting / hand-igniting a TNT block,
// or catching it in a blast, primes it.
import * as THREE from 'three';
import { B, BLOCKS } from '../world/blocks.js';
import { moveBox } from '../core/physics.js';
import { PHYS, WORLD } from '../core/config.js';

export const TNT_BLAST = { radius: 4, power: 3, damage: 100 };
const MAX_PRIMED = 72;
const MAX_LOOPS = 4;
const HALF = 0.49;
const FACE_TEX = ['side', 'side', 'top', 'bottom', 'side', 'side']; // BoxGeometry groups: +x -x +y -y +z -z

const _v = new THREE.Vector3();
const _move = {};

class PrimedTNT {
  constructor(mgr, x, y, z, fuse, source) {
    this.mgr = mgr;
    this.kind = 'tnt';
    this.team = 'neutral';
    this.position = new THREE.Vector3(x, y, z); // bottom-centre
    this.velocity = new THREE.Vector3();
    this.radius = HALF;
    this.height = HALF * 2;
    this.health = 1;
    this.maxHealth = 1;
    this.alive = true;
    this.hidden = false;
    this.fuse = fuse;
    this.fuseTotal = fuse;
    this.age = 0;
    this.source = source || null;
    this.inWater = false;
    this.onGround = false;
    this.sound = null;
    this.mesh = null;
    this._flash = false;
    this._sparkT = 0;
  }

  /** Already lit: bullets and blasts do not hurt it (blasts push it via knockback). */
  damage() {}

  /** Push (explosions, cars). */
  knockback(impulse) {
    if (!impulse) return;
    this.velocity.x += impulse.x * 0.85;
    this.velocity.y += Math.max(0, impulse.y || 0) * 0.85 + 1.5;
    this.velocity.z += impulse.z * 0.85;
    const h = Math.hypot(this.velocity.x, this.velocity.z);
    if (h > 18) { this.velocity.x *= 18 / h; this.velocity.z *= 18 / h; }
    this.velocity.y = Math.min(this.velocity.y, 14);
    this.onGround = false;
  }
}

export class TNTManager {
  constructor(combat) {
    this.combat = combat;
    this.game = combat.game;
    this.list = [];
    this._geo = null;
    this._geoAtlas = null;
    this._mat = null;
    this._matFlash = null;
    this._loops = 0;
  }

  get count() { return this.list.length; }

  _textures() { return this.game.world && this.game.world.textures; }

  /** Shared cube geometry: atlas-mapped TNT faces when the atlas exists, vertex-coloured fallback otherwise. */
  _ensureAssets() {
    const tex = this._textures();
    const atlas = tex && tex.atlasTexture ? tex.atlasTexture : null;
    if (this._geo && this._geoAtlas === atlas) return;
    if (this._geo) this._geo.dispose();
    if (this._mat) { this._mat.dispose(); this._matFlash.dispose(); }
    const g = new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2);
    const def = BLOCKS[B.TNT];
    let mapped = false;
    if (atlas && typeof tex.uvFor === 'function' && def) {
      try {
        const uv = g.attributes.uv;
        for (let f = 0; f < 6; f++) {
          const r = tex.uvFor(def.tex[FACE_TEX[f]]);
          if (!r || !Number.isFinite(r.u0)) throw new Error('no uv');
          for (let i = f * 4; i < f * 4 + 4; i++) {
            const u = uv.getX(i), v = uv.getY(i);
            uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
          }
        }
        uv.needsUpdate = true;
        mapped = true;
      } catch (e) { mapped = false; }
    }
    if (mapped) {
      this._mat = new THREE.MeshLambertMaterial({ map: atlas });
      this._matFlash = new THREE.MeshLambertMaterial({ map: atlas, emissive: 0xffffff, emissiveIntensity: 0.8 });
    } else {
      // red block with a white band (classic TNT look) in vertex colours
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      const red = new THREE.Color(0xc0392b), white = new THREE.Color(0xeeeeee);
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const c = Math.abs(y) < 0.18 ? white : red;
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this._mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      this._matFlash = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.8 });
    }
    this._geo = g;
    this._geoAtlas = atlas;
  }

  /**
   * Prime TNT at block (x,y,z). opts: {fuse (s), removeBlock (default true: only primes if the block there is TNT),
   * blast: Vector3 (explosion centre that lit it: launches it away), velocity}. Returns the entity or null.
   */
  prime(x, y, z, source, opts = {}) {
    const g = this.game, w = g.world;
    x |= 0; y |= 0; z |= 0;
    if (opts.removeBlock !== false) {
      if (!w || w.getBlock(x, y, z) !== B.TNT) return null;
      try { w.setBlock(x, y, z, 0); } catch (e) { return null; }
    }
    if (this.list.length >= MAX_PRIMED) return null;
    this._ensureAssets();
    const fuse = Number.isFinite(opts.fuse) ? Math.max(0.05, opts.fuse) : 3;
    const t = new PrimedTNT(this, x + 0.5, y + 0.5 - HALF, z + 0.5, fuse, source);
    // the classic little hop + a random nudge
    const a = Math.random() * Math.PI * 2;
    t.velocity.set(Math.cos(a) * 0.6, 4.2, Math.sin(a) * 0.6);
    if (opts.blast) {
      _v.set(x + 0.5, y + 0.5, z + 0.5).sub(opts.blast);
      const d = Math.max(0.5, _v.length());
      _v.divideScalar(d);
      const k = Math.min(7, 10 / d);
      t.velocity.x += _v.x * k; t.velocity.z += _v.z * k; t.velocity.y += Math.max(0, _v.y) * k * 0.6 + 2.5;
    }
    if (opts.velocity) t.velocity.add(opts.velocity);
    const mesh = new THREE.Mesh(this._geo, this._mat);
    mesh.castShadow = true;
    mesh.position.set(t.position.x, t.position.y + HALF, t.position.z);
    g.scene.add(mesh);
    t.mesh = mesh;
    this.list.push(t);
    g.entities?.add?.(t);
    this._startSound(t);
    return t;
  }

  _startSound(t) {
    const a = this.game.audio;
    if (!a) return;
    if (this._loops < MAX_LOOPS && typeof a.loop === 'function') {
      try {
        t.sound = a.loop('tnt_fuse', { position: t.mesh.position, volume: 0.9 });
        if (t.sound) this._loops++;
      } catch (e) { t.sound = null; }
    }
    if (!t.sound) a.play?.('tnt_fuse', { position: t.mesh.position, volume: 0.8 });
  }

  _stopSound(t) {
    if (t.sound) {
      try { t.sound.stop(); } catch (e) { /* ignore */ }
      t.sound = null;
      this._loops = Math.max(0, this._loops - 1);
    }
  }

  update(dt) {
    if (!this.list.length) return;
    const g = this.game, w = g.world;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      t.age += dt;
      t.fuse -= dt;
      // physics
      if (w) {
        const vel = t.velocity;
        if (t.inWater) { vel.y -= PHYS.WATER_GRAVITY * dt; vel.multiplyScalar(Math.exp(-PHYS.WATER_DRAG * dt)); }
        else vel.y = Math.max(-PHYS.TERMINAL_VELOCITY, vel.y - PHYS.GRAVITY * dt);
        try {
          moveBox(w, t.position, HALF, HALF * 2, vel, dt, {}, _move);
          t.onGround = _move.onGround;
          t.inWater = _move.inWater;
        } catch (e) { t.position.addScaledVector(vel, dt); }
        if (t.onGround) {
          const f = Math.exp(-dt * 7);
          vel.x *= f; vel.z *= f;
        } else {
          const f = Math.exp(-dt * 0.4);
          vel.x *= f; vel.z *= f;
        }
        if (t.position.y < -4) t.fuse = 0;
      }
      // visuals: flash rate rises as the fuse burns, swell at the end
      const m = t.mesh;
      m.position.set(t.position.x, t.position.y + HALF, t.position.z);
      const k = 1 - Math.max(0, t.fuse) / t.fuseTotal;
      const freq = 2.2 + k * k * 11;
      const flash = Math.sin(t.age * freq * Math.PI * 2) > (t.fuse < 0.5 ? -0.3 : 0.25);
      if (flash !== t._flash) { t._flash = flash; m.material = flash ? this._matFlash : this._mat; }
      const swell = t.fuse < 0.35 ? 1 + (1 - Math.max(0, t.fuse) / 0.35) * 0.16 : 1;
      m.scale.setScalar(swell);
      if (t.sound) { try { t.sound.setPosition(m.position); } catch (e) { /* ignore */ } }
      // fuse sparks + wisps of smoke from the top
      t._sparkT -= dt;
      if (t._sparkT <= 0) {
        t._sparkT = 0.09 + Math.random() * 0.06;
        _v.set(t.position.x, t.position.y + HALF * 2 + 0.05, t.position.z);
        try {
          g.fx?.burst?.(_v, { color: 0xffc040, count: 2, speed: 1.6, size: 0.05, life: 0.35, gravity: 6, glow: true });
          if (Math.random() < 0.5) g.fx?.smoke?.(_v, { amount: 0.6, color: 0x9a9a9a });
        } catch (e) { /* fx stub */ }
      }
      if (t.fuse <= 0) {
        this._remove(i);
        _v.set(t.position.x, t.position.y + HALF, t.position.z);
        // TNT that went off under water does not break blocks (only hurts and pushes)
        const power = t.inWater ? 0 : TNT_BLAST.power;
        this.combat.explode(_v.clone(), { radius: TNT_BLAST.radius, power, damage: TNT_BLAST.damage, source: t.source, weapon: 'tnt' });
      }
    }
  }

  _remove(i) {
    const t = this.list[i];
    this.list.splice(i, 1);
    t.alive = false;
    this._stopSound(t);
    if (t.mesh && t.mesh.parent) t.mesh.parent.remove(t.mesh);
    this.game.entities?.remove?.(t);
  }

  /** Remove every primed TNT without exploding. */
  clear() {
    for (let i = this.list.length - 1; i >= 0; i--) this._remove(i);
  }

  /** Make every primed TNT go off now (debug). */
  detonateAll() {
    for (const t of this.list) t.fuse = Math.min(t.fuse, 0.01);
  }
}

/** True if (x,y,z) is inside the world volume. */
export const inWorld = (x, y, z) => x >= 0 && z >= 0 && y >= 0 && x < WORLD.SIZE_X && z < WORLD.SIZE_Z && y < WORLD.HEIGHT;
