// Target dummy (COMBAT debug / shooting range): a standing humanoid entity that records every hit it takes,
// flinches, gets knocked back, falls over when "killed" and stands up again after a few seconds.
// Spawned with game.debug.spawnDummy(x, y, z, {health, yaw}); used by the combat smoke scenarios.
import * as THREE from 'three';
import { Humanoid, HUMANOID_HEIGHT, HUMANOID_RADIUS } from '../entities/humanoid.js';
import { moveBox } from '../core/physics.js';
import { PHYS } from '../core/config.js';

const LOOK = { skin: 0xd8a47f, hair: 0x3a2a1a, shirt: 0xf07a1a, pants: 0x3b3b3b, shoes: 0x111111, vest: 0xd0d0d0, sleeves: true };
const _move = {};

export class TargetDummy {
  constructor(game, x, y, z, opts = {}) {
    this.game = game;
    this.kind = 'prop';
    this.team = 'neutral';
    this.isDummy = true;
    this.position = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3();
    this.radius = HUMANOID_RADIUS;
    this.height = HUMANOID_HEIGHT;
    this.maxHealth = opts.health || 150;
    this.health = this.maxHealth;
    this.alive = true;
    this.hidden = false;
    this.yaw = Number.isFinite(opts.yaw) ? opts.yaw : 0;
    this.respawn = opts.respawn !== false;
    this.hits = [];
    this.deaths = 0;
    this.deadT = 0;
    this.humanoid = new Humanoid(LOOK);
    this.humanoid.root.position.copy(this.position);
    this.humanoid.root.rotation.y = this.yaw;
    game.scene.add(this.humanoid.root);
  }

  damage(amount, info = {}) {
    amount = Number(amount);
    if (!(amount > 0)) return;
    info = info || {};
    this.hits.push({ amount: +amount.toFixed(2), type: info.type || '?', headshot: !!info.headshot, weapon: info.weapon || null, t: this.game.time });
    if (this.hits.length > 200) this.hits.shift();
    if (!this.alive) return;
    this.health -= amount;
    this.humanoid.flash();
    this.game.events.emit('entityDamaged', { entity: this, amount, info });
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deaths++;
      this.deadT = 0;
      this.game.events.emit('entityKilled', { entity: this, info });
    }
  }

  knockback(impulse) {
    if (!impulse) return;
    this.velocity.add(impulse);
    this.velocity.y = Math.min(this.velocity.y, 12);
  }

  update(dt) {
    const w = this.game.world;
    const v = this.velocity;
    v.y = Math.max(-PHYS.TERMINAL_VELOCITY, v.y - PHYS.GRAVITY * dt);
    if (w) {
      try { moveBox(w, this.position, this.radius, this.alive ? this.height : 0.5, v, dt, {}, _move); } catch (e) { /* stub */ }
      if (_move.onGround) { const f = Math.exp(-dt * 8); v.x *= f; v.z *= f; }
    }
    if (!this.alive) {
      this.deadT += dt;
      if (this.respawn && this.deadT > 3) { this.alive = true; this.health = this.maxHealth; }
    }
    const h = this.humanoid;
    h.root.position.copy(this.position);
    h.root.rotation.y = this.yaw;
    h.animate(dt, { speed: 0, state: this.alive ? 'normal' : 'dead' });
  }

  dispose() {
    this.game.entities?.remove?.(this);
    this.humanoid.dispose();
  }
}
