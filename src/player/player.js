// Player: the on-foot character entity. GTA-style camera-relative movement (walk / sprint / crouch-sneak / jump with
// coyote time + buffer / auto-step / swim / creative flight), fall + drowning damage, armor, health regen, death and
// hospital respawn, money, vehicle hand-off, entity push-out, footsteps. Mining/building/weapons live in
// interact.js; the camera in camera.js. See ARCHITECTURE.md §Player.
import * as THREE from 'three';
import { moveBox, boxCollides } from '../core/physics.js';
import { PHYS, WORLD } from '../core/config.js';
import { clamp, damp, wrapAngle, angleDiff, forwardFromYaw, rightFromYaw } from '../core/math.js';
import { entityBox } from '../core/entities.js';
import { BLOCKS, B } from '../world/blocks.js';
import { Humanoid, LOOKS, HUMANOID_HEIGHT, HUMANOID_RADIUS } from '../entities/humanoid.js';
import { WEAPONS } from '../data/weapons.js';
import { itemKey, TOOLS } from '../data/items.js';
import { Interact } from './interact.js';
import { ItemModels } from './models.js';
import { MOVE, CAM } from './tuning.js';

const JUMP_V = Math.sqrt(2 * PHYS.GRAVITY * (MOVE.jumpHeight + 0.02));
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _mv = new THREE.Vector3();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _near = [];

const approach = (cur, target, maxDelta) => (cur < target ? Math.min(target, cur + maxDelta) : Math.max(target, cur - maxDelta));
const isLiquid = (id) => !!(BLOCKS[id] && BLOCKS[id].liquid);

export class Player {
  constructor(game) {
    this.game = game;
    // ---- entity interface (core/entities.js)
    this.kind = 'player';
    this.team = 'player';
    this.position = new THREE.Vector3(256.5, WORLD.CITY_LEVEL, 256.5);
    this.velocity = new THREE.Vector3();
    this.radius = HUMANOID_RADIUS;
    this.height = HUMANOID_HEIGHT;
    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.maxArmor = 100;
    this.alive = true;
    this.hidden = false;
    // ---- state
    this.money = 500;
    /** body facing (model). The view direction is game.cameraRig.yaw/pitch. */
    this.yaw = 0;
    this.pitch = 0;
    this.inVehicle = null;
    this.humanoid = null;
    this.interact = null;
    this.onGround = false;
    this.inWater = false;
    this.headInWater = false;
    this.swimming = false;
    this.aiming = false;
    /** when true all movement/action input is ignored (BUSTED, cutscenes) */
    this.frozen = false;
    this.sprinting = false;
    this.crouching = false;
    this.flying = false;
    /** no damage (debug) */
    this.god = false;
    /** 0..1 remaining air while the head is under water (HUD may show bubbles) */
    this.breath = 1;
    this.horizontalSpeed = 0;
    /** metres walked on the ground (drives footsteps + view bob) */
    this.walkDist = 0;
    /** visual offset after an auto-step (camera/model catch up smoothly) */
    this.stepOffset = 0;
    /** 0..1 crouch blend */
    this.crouchT = 0;
    this.deathTime = 0;
    this.lastDamageTime = -1e9;
    this.lastActionTime = -1e9;
    this.lastFireTime = -1e9;
    /** optional fallback respawn point {x,y,z,yaw} (used when the plan has no hospital) */
    this.respawnPoint = null;

    this._out = {};
    this._coyote = 0;
    this._jumpBuf = 0;
    this._sinceJump = 1;
    this._lastSpaceT = -1;
    this._fallPeak = this.position.y;
    this._airTime = 0;
    this._stepAcc = 0;
    this._drownT = 0;
    this._bubbleT = 0;
    this._hurtSndT = 0;
    this._invulnT = 0;
    this._bustedT = 0;
    this._heldKey = null;
    this._wasInWater = false;
    this._standOn = null;
    this._vhit = { nx: 0, nz: 0, pen: 0 };
    this._hitWall = false;
    this._regenEmit = 0;
    this._respawning = false;
    this.models = null;
  }

  init() {
    const g = this.game;
    this.humanoid = new Humanoid(LOOKS.player);
    g.scene.add(this.humanoid.root);
    this.models = new ItemModels(g);
    this.interact = new Interact(g, this);
    this.interact.init();

    const spawn = g.generator && g.generator.plan && g.generator.plan.spawn;
    if (spawn) {
      this.yaw = Number.isFinite(spawn.yaw) ? spawn.yaw : 0;
      this.teleport(spawn.x, Number.isFinite(spawn.y) ? spawn.y : undefined, spawn.z);
    } else {
      this.teleport(this.position.x, undefined, this.position.z);
    }
    if (g.cameraRig) { g.cameraRig.yaw = this.yaw; g.cameraRig.snap?.(); }
    this._invulnT = 2;
    g.entities.add(this);

    const ev = g.events;
    ev.on('busted', () => {
      this._bustedT = 3.5;
      this.aiming = false;
      this.velocity.x = 0; this.velocity.z = 0;
      this.interact?.cancel();
    });
    ev.on('weaponFired', (e) => {
      if (e && e.byPlayer) { this.lastFireTime = g.realTime; this.lastActionTime = g.time; }
    });
    this._installDebug();
    ev.emit('healthChanged', { health: this.health, armor: this.armor });
  }

  // ================================================================== public API

  /** Eye position (first-person camera height, follows crouch + step smoothing). */
  getEyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y - this.stepOffset + CAM.eye - this.crouchT * CAM.crouchDrop, this.position.z);
  }

  /** Mark that the player just did something aimed (mine/place/punch/fire): body turns to the view. */
  noteAction() { this.lastActionTime = this.game.time; }

  /** Entity damage. Armor absorbs 60% of the damage until depleted. */
  damage(amount, info = {}) {
    amount = Number(amount);
    if (!this.alive || !(amount > 0)) return;
    if (this.god || this._invulnT > 0) return;
    info = info || {};
    const g = this.game;
    let absorbed = 0;
    if (this.armor > 0 && info.type !== 'drown') {
      absorbed = Math.min(this.armor, amount * 0.6);
      this.armor = Math.max(0, this.armor - absorbed);
    }
    const dmg = amount - absorbed;
    this.health = Math.max(0, this.health - dmg);
    this.lastDamageTime = g.time;
    g.hud?.flashDamage?.(clamp(amount / 35, 0.25, 1));
    if (this._hurtSndT <= 0) { g.audio?.play?.('hurt', { volume: clamp(0.5 + amount / 60, 0.5, 1) }); this._hurtSndT = 0.2; }
    this.humanoid?.flash?.();
    g.cameraRig?.shake?.(clamp(amount / 90, 0.06, 0.45));
    g.events.emit('healthChanged', { health: this.health, armor: this.armor });
    g.events.emit('entityDamaged', { entity: this, amount, info });
    if (this.health <= 0) this._die(info);
  }

  /** Push the player (explosions, car hits). */
  knockback(impulse) {
    if (!impulse || this.inVehicle) return;
    this.velocity.add(impulse);
    const h = Math.hypot(this.velocity.x, this.velocity.z);
    if (h > 22) { this.velocity.x *= 22 / h; this.velocity.z *= 22 / h; }
    this.velocity.y = clamp(this.velocity.y, -30, 14);
    if (this.velocity.y > 0.5) { this.onGround = false; this._coyote = 0; }
  }

  /** Respawn (death -> nearest hospital, busted -> police POI from Police, load -> saved position). */
  respawn(at = null, reason = 'death') {
    const g = this.game;
    if (this.inVehicle) this._ejectFromVehicle();
    let target = at;
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.z)) {
      target = this.nearestPOI('hospital') || this.respawnPoint || (g.generator && g.generator.plan && g.generator.plan.spawn) || { x: 256.5, z: 256.5 };
    }
    let yaw = Number.isFinite(target.yaw) ? target.yaw : this.yaw;
    if (target.type) yaw += Math.PI; // POIs face their entrance: walk out of the building
    this.alive = true;
    this.frozen = false;
    this._bustedT = 0;
    this._respawning = false;
    if (reason !== 'load' || this.health <= 0) this.health = this.maxHealth;
    if (reason === 'death') this.armor = 0;
    this.breath = 1;
    this.flying = false;
    this.aiming = false;
    this.deathTime = 0;
    this.velocity.set(0, 0, 0);
    this.teleport(target.x, Number.isFinite(target.y) ? target.y : undefined, target.z);
    this.yaw = wrapAngle(yaw);
    if (g.cameraRig) { g.cameraRig.yaw = this.yaw; g.cameraRig.pitch = -0.12; g.cameraRig.snap?.(); }
    const h = this.humanoid;
    if (h) { h.pose.rotation.set(0, 0, 0); h.pose.position.set(0, 0, 0); h.deadT = 0; h.setVisible(true); }
    this._invulnT = MOVE.respawnInvuln;
    this.interact?.cancel();
    g.events.emit('healthChanged', { health: this.health, armor: this.armor });
    g.events.emit('playerRespawned', { reason });
  }

  /** Move instantly (y omitted -> ground height). Unsticks from blocks. */
  teleport(x, y, z) {
    const g = this.game;
    if (z === undefined && y !== undefined && !Number.isFinite(z)) { z = y; y = undefined; }
    x = Number(x); z = Number(z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (y === undefined || y === null || !Number.isFinite(Number(y))) y = this._groundAt(x, z);
    this.position.set(x, Number(y), z);
    this._unstick();
    this.velocity.set(0, 0, 0);
    this._fallPeak = this.position.y;
    this._airTime = 0;
    this.stepOffset = 0;
    this.onGround = false;
    const v = this.inVehicle;
    if (v && v.position) { v.position.copy(this.position); if (v.velocity) v.velocity.set(0, 0, 0); }
    if (this.humanoid) this.humanoid.root.position.copy(this.position);
    g.cameraRig?.snap?.();
  }

  /** Add (or remove, negative) money. Never below 0. Returns the applied delta. */
  addMoney(delta, reason = '') {
    delta = Math.round(Number(delta) || 0);
    if (!delta) return 0;
    const before = this.money;
    this.money = Math.max(0, before + delta);
    const applied = this.money - before;
    if (applied !== 0) this.game.events.emit('moneyChanged', { money: this.money, delta: applied, reason });
    return applied;
  }

  canAfford(price) { return this.money >= price; }

  /** Set money to an absolute value (save/load). Emits moneyChanged. */
  setMoney(value, reason = 'load') {
    const v = Math.max(0, Math.round(Number(value) || 0));
    const delta = v - this.money;
    this.money = v;
    this.game.events.emit('moneyChanged', { money: v, delta, reason });
  }

  /** Set health / armor directly (save/load). Emits healthChanged. */
  setHealth(health, armor = this.armor) {
    this.health = clamp(Number(health) || 0, 1, this.maxHealth);
    this.armor = clamp(Number(armor) || 0, 0, this.maxArmor);
    this.game.events.emit('healthChanged', { health: this.health, armor: this.armor });
  }

  /** Snapshot for the save system. */
  serialize() {
    return {
      money: this.money, health: Math.round(this.health), armor: Math.round(this.armor),
      position: [+this.position.x.toFixed(2), +this.position.y.toFixed(2), +this.position.z.toFixed(2)],
      yaw: +this.yaw.toFixed(3),
      camMode: this.game.cameraRig ? this.game.cameraRig.mode : 'third',
    };
  }

  /** Restore a serialize() snapshot (teleports, emits money/health events + playerRespawned {reason:'load'}). */
  deserialize(o) {
    if (!o) return false;
    if (Number.isFinite(o.money)) this.setMoney(o.money, 'load');
    if (Number.isFinite(o.health)) this.setHealth(o.health, Number.isFinite(o.armor) ? o.armor : 0);
    if (o.camMode && this.game.cameraRig) this.game.cameraRig.setMode(o.camMode);
    const p = Array.isArray(o.position) ? { x: o.position[0], y: o.position[1], z: o.position[2] } : o.position;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) this.respawn({ x: p.x, y: p.y, z: p.z, yaw: Number.isFinite(o.yaw) ? o.yaw : this.yaw }, 'load');
    return true;
  }

  /** Heal n hp (default: full). Returns hp healed. */
  heal(n = this.maxHealth) {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, Number(n) || 0));
    if (this.health !== before) this.game.events.emit('healthChanged', { health: this.health, armor: this.armor });
    return this.health - before;
  }

  /** Add armor (cap 100). Returns armor added. */
  addArmor(n = this.maxArmor) {
    const before = this.armor;
    this.armor = Math.min(this.maxArmor, this.armor + Math.max(0, Number(n) || 0));
    if (this.armor !== before) this.game.events.emit('healthChanged', { health: this.health, armor: this.armor });
    return this.armor - before;
  }

  /** Optional fallback respawn point (e.g. the safehouse). */
  setRespawnPoint(p) { this.respawnPoint = p ? { x: p.x, y: p.y, z: p.z, yaw: p.yaw || 0 } : null; }

  /** Called by Vehicles on enter (vehicle) / exit (null, exitPos). */
  setInVehicle(vehicle, exitPos) {
    const g = this.game;
    if (vehicle) {
      this.inVehicle = vehicle;
      this.hidden = true;
      this.aiming = false;
      this.flying = false;
      this.sprinting = false;
      this.velocity.set(0, 0, 0);
      this.humanoid?.setVisible(false);
      this.interact?.cancel();
      if (vehicle.position) this.position.copy(vehicle.position);
      return;
    }
    const prev = this.inVehicle;
    this.inVehicle = null;
    this.hidden = false;
    this.humanoid?.setVisible(true);
    if (exitPos && Number.isFinite(exitPos.x)) this.position.set(exitPos.x, Number.isFinite(exitPos.y) ? exitPos.y : this.position.y, exitPos.z);
    else if (prev && prev.position) {
      const vy = Number.isFinite(prev.yaw) ? prev.yaw : 0;
      rightFromYaw(vy, _right);
      const w = ((prev.def && prev.def.size && prev.def.size.w) || 2) * 0.5 + 0.6;
      this.position.set(prev.position.x - _right.x * w, prev.position.y, prev.position.z - _right.z * w);
    }
    this._unstick();
    this.velocity.set(0, 0, 0);
    if (prev && Number.isFinite(prev.yaw)) this.yaw = prev.yaw;
    this._fallPeak = this.position.y;
    this.onGround = false;
    this.stepOffset = 0;
    if (this.humanoid) { this.humanoid.root.position.copy(this.position); this.humanoid.root.rotation.y = this.yaw; }
    g.cameraRig?.snap?.();
  }

  /** Nearest POI of a type ({x,y,z,yaw,...}) or null. */
  nearestPOI(type) {
    const plan = this.game.generator && this.game.generator.plan;
    let list = null;
    try { list = plan && typeof plan.poisOfType === 'function' ? plan.poisOfType(type) : (plan && plan.pois ? plan.pois.filter((p) => p.type === type) : null); } catch (e) { list = null; }
    if (!list || !list.length) return null;
    let best = null, bd = Infinity;
    for (const poi of list) {
      const d = (poi.x - this.position.x) ** 2 + (poi.z - this.position.z) ** 2;
      if (d < bd) { bd = d; best = poi; }
    }
    return best;
  }

  getBlips() { /* the HUD draws the player arrow itself */ }

  // ================================================================== update

  update(dt) {
    const g = this.game;
    this._hurtSndT -= dt;
    this._invulnT -= dt;
    if (this._bustedT > 0) this._bustedT -= dt;
    this.interact?.tick(dt);
    if (g.cameraRig) this.pitch = g.cameraRig.pitch;
    if (!this.alive) { this._updateDead(dt); return; }
    if (this.inVehicle) { this._updateInVehicle(dt); return; }
    this._updateMovement(dt);
    if (!this.alive) return; // died this frame (fall / void)
    this._updateVitals(dt);
    this.interact?.update(dt);
    this._updateModel(dt);
  }

  _updateInVehicle(dt) {
    const v = this.inVehicle;
    if (v && v.position) this.position.copy(v.position);
    if (v && v.velocity) this.velocity.copy(v.velocity);
    this.aiming = false;
    this.sprinting = false;
    this.horizontalSpeed = Math.abs(v && v.speed ? v.speed : 0);
    if (this.humanoid && this.humanoid.root.visible) this.humanoid.setVisible(false);
    this._regen(dt);
    const hud = this.game.hud;
    if (hud && hud.miningProgress != null) hud.miningProgress = null;
  }

  _updateDead(dt) {
    const g = this.game;
    this.deathTime += dt;
    // the body keeps falling / sliding to rest
    const k = Math.exp(-5 * dt);
    this.velocity.x *= k; this.velocity.z *= k;
    this.velocity.y = Math.max(-PHYS.TERMINAL_VELOCITY, this.velocity.y - PHYS.GRAVITY * dt);
    if (g.world) {
      const res = moveBox(g.world, this.position, this.radius, this.height, this.velocity, dt, {}, this._out);
      if (res.inWater) this.velocity.y = Math.max(this.velocity.y, -1);
    }
    if (this.humanoid) {
      this.humanoid.root.position.copy(this.position);
      this.humanoid.root.rotation.y = this.yaw;
      this.humanoid.animate(dt, { state: 'dead', speed: 0 });
    }
    if (this.deathTime >= MOVE.respawnDelay && !this._respawning) {
      this._respawning = true;
      const bill = this.addMoney(-MOVE.hospitalBill, 'hospital');
      this.respawn(null, 'death');
      if (bill < 0) g.hud?.notify?.('Hospital bill: -$' + (-bill), { duration: 3 });
    }
  }

  _updateMovement(dt) {
    const g = this.game, input = g.input, world = g.world;
    if (!world) return;
    const rig = g.cameraRig;
    const camYaw = rig ? rig.yaw : this.yaw;
    const frozen = this.frozen || this._bustedT > 0;
    const creative = !!(g.inventory && g.inventory.creative);
    const pos = this.position, vel = this.velocity;

    // ---------------- intents
    let ax = 0, ay = 0;
    if (!frozen) { const m = input.moveAxis(); ax = m.x; ay = m.y; }
    const jumpPressed = !frozen && input.pressed('jump');
    const jumpHeld = !frozen && input.down('jump');
    const sprintHeld = !frozen && input.down('sprint');
    const crouchHeld = !frozen && input.down('crouch');

    // creative flight: double-tap Space
    if (jumpPressed && creative) {
      const now = g.realTime;
      if (now - this._lastSpaceT < 0.3) {
        this.flying = !this.flying;
        this._lastSpaceT = -1;
        if (this.flying) vel.y = 0;
        g.hud?.notify?.(this.flying ? 'Flying (Space up, Shift down, Ctrl fast)' : 'Flight off', { duration: 1.5 });
      } else this._lastSpaceT = now;
    }
    if (!creative && this.flying) this.flying = false;

    forwardFromYaw(camYaw, _fwd);
    rightFromYaw(camYaw, _right);
    _wish.set(0, 0, 0).addScaledVector(_fwd, ay).addScaledVector(_right, ax);
    const wishLen = Math.min(1, _wish.length());
    const moving = wishLen > 0.05;
    if (moving) _wish.multiplyScalar(1 / Math.max(1e-6, _wish.length()));

    // water state (chest deep = swimming)
    const bx = Math.floor(pos.x), bz = Math.floor(pos.z);
    const chestWater = isLiquid(world.getBlock(bx, Math.floor(pos.y + 0.9), bz));
    const feetWater = isLiquid(world.getBlock(bx, Math.floor(pos.y + 0.2), bz));
    this.swimming = chestWater && !this.flying;

    // ---------------- stance
    this.crouching = crouchHeld && !this.flying && !this.swimming;
    this.crouchT += ((this.crouching ? 1 : 0) - this.crouchT) * damp(12, dt);
    const wasSprinting = this.sprinting;
    this.sprinting = sprintHeld && moving && !this.crouching && !this.aiming && !this.flying &&
      (this.onGround || this.swimming || wasSprinting);

    let speed;
    if (this.flying) speed = crouchHeld ? MOVE.flyFast : MOVE.fly;
    else if (this.swimming) speed = sprintHeld ? MOVE.swimFast : MOVE.swim;
    else if (this.crouching) speed = MOVE.crouch;
    else if (this.aiming) speed = MOVE.aimWalk;
    else if (this.sprinting) speed = MOVE.sprint;
    else speed = MOVE.walk;
    if (feetWater && !this.swimming && !this.flying) speed *= 0.8; // wading
    speed *= wishLen;

    // ---------------- horizontal velocity
    const tvx = moving ? _wish.x * speed : 0, tvz = moving ? _wish.z * speed : 0;
    let rate;
    if (this.flying) rate = moving ? 30 : 18;
    else if (this.swimming) rate = MOVE.accelWater;
    else if (this.onGround) rate = moving ? MOVE.accelGround : MOVE.decelGround;
    else rate = moving ? MOVE.accelAir : 0.6; // keep momentum in the air
    {
      const dvx = tvx - vel.x, dvz = tvz - vel.z;
      const dl = Math.hypot(dvx, dvz), maxStep = rate * dt;
      if (dl > maxStep && dl > 0) { vel.x += (dvx / dl) * maxStep; vel.z += (dvz / dl) * maxStep; }
      else { vel.x = tvx; vel.z = tvz; }
    }

    // ---------------- vertical
    if (this.onGround) this._coyote = MOVE.coyoteTime; else this._coyote -= dt;
    if (jumpPressed) this._jumpBuf = MOVE.jumpBuffer;
    this._sinceJump += dt;
    const preVy = vel.y;
    if (this.flying) {
      const tv = jumpHeld ? 8 : sprintHeld ? -8 : 0;
      vel.y = approach(vel.y, tv, 40 * dt);
    } else if (this.swimming) {
      if (vel.y < -2) vel.y *= Math.exp(-PHYS.WATER_DRAG * 2.5 * dt); // entering water: brake the fall
      if (jumpHeld) {
        const headOut = !this.headInWater;
        if (headOut && this._hitWall) vel.y = 8.6; // climb out onto the bank
        else vel.y = approach(vel.y, 3.4, 14 * dt);
      } else if (crouchHeld) vel.y = approach(vel.y, -3.0, 10 * dt);
      else vel.y = approach(vel.y, -0.9, PHYS.WATER_GRAVITY * dt);
      this._jumpBuf = 0;
    } else {
      vel.y = Math.max(-PHYS.TERMINAL_VELOCITY, vel.y - PHYS.GRAVITY * dt);
      const wantJump = this._jumpBuf > 0 || (jumpHeld && this.onGround && this._sinceJump > MOVE.autoJumpRepeat);
      if (wantJump && (this.onGround || this._coyote > 0) && this._sinceJump > 0.2) {
        vel.y = JUMP_V;
        if (this.sprinting && moving) { vel.x += _wish.x * 0.8; vel.z += _wish.z * 0.8; } // sprint-jump boost
        this._coyote = 0; this._jumpBuf = 0; this._sinceJump = 0;
        this.onGround = false;
        this._standOn = null;
        g.audio?.play?.('jump', { volume: 0.35 });
      }
    }
    this._jumpBuf -= dt;

    // ---------------- entity push-out / standing on vehicles
    let px = 0, pz = 0;
    this._standOn = null;
    const ents = g.entities;
    if (ents) {
      _v.set(pos.x, pos.y + this.height * 0.5, pos.z);
      const near = ents.query(_v, 7, null, _near);
      for (const e of near) {
        if (e === this || e.hidden) continue;
        if (e.kind === 'vehicle' || e.kind === 'heli') {
          const r = this._collideVehicle(e);
          if (r) {
            // solid: cancel the velocity into the vehicle, then push out of any remaining overlap
            const vn = vel.x * r.nx + vel.z * r.nz;
            if (vn < 0) { vel.x -= r.nx * vn; vel.z -= r.nz * vn; }
            const push = Math.min(8, r.pen * 16 + 0.5);
            px += r.nx * push; pz += r.nz * push;
          }
          continue;
        }
        if (e.alive === false || e.kind === 'tnt') continue;
        const dx = pos.x - e.position.x, dz = pos.z - e.position.z;
        const minD = this.radius + (e.radius || 0.3);
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD) continue;
        if (e.position.y >= pos.y + this.height || e.position.y + (e.height || 1.8) <= pos.y) continue;
        const d = Math.sqrt(d2);
        const nx = d > 1e-4 ? dx / d : Math.random() - 0.5, nz = d > 1e-4 ? dz / d : Math.random() - 0.5;
        const push = Math.min(4, (minD - d) * 10);
        px += nx * push; pz += nz * push;
      }
    }
    const so = this._standOn;
    if (so) {
      pos.y = so.top;
      if (vel.y < 0) vel.y = 0;
      const sv = so.vehicle.velocity;
      if (sv) { pos.x += sv.x * dt; pos.z += sv.z * dt; }
    }

    // ---------------- sneaking: never walk off a ledge
    if (this.crouching && this.onGround && !so) {
      if (vel.x !== 0 && !this._hasSupport(world, pos.x + vel.x * dt, pos.z)) vel.x = 0;
      if (vel.z !== 0 && !this._hasSupport(world, pos.x + vel.x * dt, pos.z + vel.z * dt)) vel.z = 0;
    }

    // ---------------- collide + move
    const autoStep = g.settings.autoJump !== false && !this.crouching && !this.flying && !this.swimming;
    _mv.set(vel.x + px, vel.y, vel.z + pz);
    const res = moveBox(world, pos, this.radius, this.height, _mv, dt, { stepHeight: autoStep ? 1 : 0 }, this._out);
    vel.y = _mv.y;
    if (res.hitX) vel.x = 0;
    if (res.hitZ) vel.z = 0;
    this._hitWall = res.hitX || res.hitZ;
    if (res.stepped > 0) this.stepOffset = Math.min(1.2, this.stepOffset + res.stepped);
    this.stepOffset *= Math.exp(-MOVE.stepSmooth * dt);
    if (this.stepOffset < 0.002) this.stepOffset = 0;

    const wasOnGround = this.onGround;
    this.onGround = res.onGround || !!so;
    this.inWater = res.inWater;
    this.headInWater = res.headInWater;
    if (this.flying && res.onGround && !jumpHeld) this.flying = false; // touching ground ends flight
    if (pos.y < -20) { this.damage(9999, { type: 'fall', source: null }); return; }

    // ---------------- splash
    if (this.inWater && !this._wasInWater && preVy < -3.5) {
      g.fx?.splash?.(_v.set(pos.x, pos.y + 0.6, pos.z));
      g.audio?.play?.('splash', { volume: clamp(-preVy / 14, 0.3, 1) });
    }
    this._wasInWater = this.inWater;

    // ---------------- falls
    if (this.flying || this.swimming || this.inWater) {
      this._fallPeak = pos.y;
      this._airTime = 0;
    } else if (!this.onGround) {
      if (this._fallPeak < pos.y) this._fallPeak = pos.y;
      this._airTime += dt;
    }
    if (this.onGround && !wasOnGround) {
      const fall = this._fallPeak - pos.y;
      if (fall > MOVE.fallSafe && !this.inWater) this.damage((fall - MOVE.fallSafe) * MOVE.fallDamagePerBlock, { type: 'fall', source: null });
      if (fall > 0.9) {
        g.audio?.play?.('land', { volume: clamp(fall / 6, 0.2, 1) });
        g.cameraRig?.landKick?.(clamp(fall / 7, 0.12, 1));
      }
      if (fall > 3) {
        g.cameraRig?.shake?.(Math.min(0.45, fall * 0.04));
        const below = world.getBlock(Math.floor(pos.x), Math.floor(pos.y - 0.5), Math.floor(pos.z));
        const bd = BLOCKS[below];
        if (bd && bd.solid) g.fx?.burst?.(_v.set(pos.x, pos.y + 0.05, pos.z), { color: bd.color, count: 8, speed: 2.5, size: 0.08, life: 0.5, gravity: 10 });
      }
      this._airTime = 0;
    }
    if (this.onGround) this._fallPeak = pos.y;

    // ---------------- facing, footsteps
    const hs = Math.hypot(vel.x, vel.z);
    this.horizontalSpeed = hs;
    const fp = !!(rig && rig.firstPerson);
    const acting = g.time - this.lastActionTime < 0.6 || g.realTime - this.lastFireTime < 0.6;
    let targetYaw = null, turn = MOVE.turnRate;
    if (this.aiming || fp || acting) { targetYaw = camYaw; turn = MOVE.turnRateAim; }
    else if (moving && hs > 0.3) targetYaw = Math.atan2(_wish.x, _wish.z);
    if (targetYaw !== null) this.yaw = wrapAngle(this.yaw + angleDiff(this.yaw, targetYaw) * damp(turn, dt));

    if (this.onGround && !this.flying && hs > 0.4) {
      this.walkDist += hs * dt;
      this._stepAcc += hs * dt;
      const stride = this.sprinting ? MOVE.strideSprint : this.crouching ? MOVE.strideCrouch : MOVE.stride;
      if (this._stepAcc >= stride) {
        this._stepAcc -= stride;
        const under = world.getBlock(Math.floor(pos.x), Math.floor(pos.y - 0.5), Math.floor(pos.z));
        g.audio?.play?.('footstep', {
          volume: this.crouching ? 0.12 : this.sprinting ? 0.5 : 0.33,
          pitch: 0.85 + Math.random() * 0.3,
          surface: BLOCKS[under] ? BLOCKS[under].key : undefined,
        });
      }
    } else if (this.swimming && hs > 0.8) {
      this._stepAcc += hs * dt;
      if (this._stepAcc > 2.4) { this._stepAcc = 0; g.audio?.play?.('splash', { volume: 0.12, pitch: 1.3 }); }
    }
  }

  /** Is there a block under the box at (x,z) (sneak edge test)? */
  _hasSupport(world, x, z) {
    return boxCollides(world, x, this.position.y - 0.6, z, this.radius - 0.02, 0.55);
  }

  /**
   * Oriented-box test against a vehicle. Sets this._standOn when the player is on its roof.
   * Returns {nx, nz, pen} (push-out normal + penetration) when overlapping its sides, else null.
   */
  _collideVehicle(v) {
    const pos = this.position, r = this._vhit;
    const size = (v.def && v.def.size) || v.size;
    if (!size || !v.position) {
      // unknown shape: use its AABB
      entityBox(v, _box);
      if (pos.x + this.radius <= _box.min.x || pos.x - this.radius >= _box.max.x || pos.z + this.radius <= _box.min.z || pos.z - this.radius >= _box.max.z) return null;
      if (pos.y >= _box.max.y - 0.45 && this.velocity.y <= 0.5) { this._standOn = { top: _box.max.y, vehicle: v }; return null; }
      if (pos.y + this.height <= _box.min.y || pos.y >= _box.max.y) return null;
      const cx = (_box.min.x + _box.max.x) / 2, cz = (_box.min.z + _box.max.z) / 2;
      const penX = (_box.max.x - _box.min.x) / 2 + this.radius - Math.abs(pos.x - cx);
      const penZ = (_box.max.z - _box.min.z) / 2 + this.radius - Math.abs(pos.z - cz);
      if (penX < penZ) { r.nx = Math.sign(pos.x - cx) || 1; r.nz = 0; r.pen = penX; }
      else { r.nx = 0; r.nz = Math.sign(pos.z - cz) || 1; r.pen = penZ; }
      return r;
    }
    const yaw = Number.isFinite(v.yaw) ? v.yaw : 0;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const dx = pos.x - v.position.x, dz = pos.z - v.position.z;
    const lf = dx * s + dz * c;          // along the vehicle's forward (sin, cos)
    const lr = -dx * c + dz * s;         // along its right (-cos, sin)
    const ex = size.w / 2 + this.radius, ez = size.l / 2 + this.radius;
    if (Math.abs(lr) >= ex || Math.abs(lf) >= ez) return null;
    const top = v.position.y + (size.h || 1.5);
    if (pos.y >= top - 0.45 && this.velocity.y <= 0.5) { this._standOn = { top, vehicle: v }; return null; }
    if (pos.y + this.height <= v.position.y || pos.y >= top) return null;
    const penR = ex - Math.abs(lr), penF = ez - Math.abs(lf);
    if (penR < penF) { const k = Math.sign(lr) || 1; r.nx = -c * k; r.nz = s * k; r.pen = penR; }
    else { const k = Math.sign(lf) || 1; r.nx = s * k; r.nz = c * k; r.pen = penF; }
    return r;
  }

  _updateVitals(dt) {
    const g = this.game;
    // drowning
    if (this.headInWater && !this.flying) {
      this.breath = Math.max(0, this.breath - dt / MOVE.breathTime);
      this._bubbleT -= dt;
      if (this._bubbleT <= 0) {
        this._bubbleT = 0.9 + Math.random() * 0.6;
        this.getEyePosition(_v);
        g.fx?.burst?.(_v, { color: 0xcfe8ff, count: 2, speed: 0.6, size: 0.05, life: 0.9, gravity: -3 });
      }
      if (this.breath <= 0) {
        this._drownT += dt;
        if (this._drownT >= 1) { this._drownT = 0; this.damage(MOVE.drownDps, { type: 'drown', source: null }); }
      }
    } else {
      this.breath = Math.min(1, this.breath + dt / 2.5);
      this._drownT = 0;
    }
    this._regen(dt);
  }

  _regen(dt) {
    const cap = this.maxHealth * MOVE.regenCap;
    if (this.health > 0 && this.health < cap && this.game.time - this.lastDamageTime > MOVE.regenDelay) {
      const before = Math.floor(this.health);
      this.health = Math.min(cap, this.health + MOVE.regenRate * dt);
      if (Math.floor(this.health) !== before) this.game.events.emit('healthChanged', { health: this.health, armor: this.armor });
    }
  }

  _updateModel(dt) {
    const h = this.humanoid;
    if (!h) return;
    const g = this.game;
    h.root.position.set(this.position.x, this.position.y - this.stepOffset, this.position.z);
    h.root.rotation.y = this.yaw;
    // held item (third person)
    const item = g.inventory ? g.inventory.getSelected() : null;
    const key = itemKey(item);
    if (key !== this._heldKey) {
      this._heldKey = key;
      h.setHeld(item && this.models ? this.models.get(item, 'world') : null);
    }
    let state = 'normal';
    if (this._bustedT > 0) state = 'hands_up';
    else if (this.swimming && !this.onGround) state = 'swim';
    else if (!this.onGround && !this.flying && this._airTime > 0.15) state = 'air';
    const def = item && item.kind === 'weapon' ? WEAPONS[item.id] : null;
    const gun = def && (def.kind === 'hitscan' || def.kind === 'projectile');
    const aimPose = !!gun && (this.aiming || g.realTime - this.lastFireTime < 0.6);
    h.animate(dt, {
      speed: this.flying ? 0 : this.horizontalSpeed,
      aiming: aimPose,
      aimPitch: g.cameraRig ? g.cameraRig.pitch : 0,
      state,
      crouch: this.crouching,
      twoHanded: def ? def.id !== 'pistol' : true,
    });
  }

  // ================================================================== internals

  _die(info) {
    const g = this.game;
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.deathTime = 0;
    this.aiming = false;
    this.flying = false;
    this.sprinting = false;
    this._respawning = false;
    this.interact?.cancel();
    if (this.inVehicle) this._ejectFromVehicle();
    if (this.humanoid) this.humanoid.setVisible(true);
    g.audio?.play?.('death');
    g.events.emit('entityKilled', { entity: this, info });
    g.events.emit('playerDied', { info });
  }

  _ejectFromVehicle() {
    const v = this.inVehicle;
    if (!v) return;
    const vs = this.game.vehicles;
    try { if (vs && typeof vs.exit === 'function') vs.exit(); } catch (e) { /* fall through */ }
    if (this.inVehicle) {
      if (v.driver === 'player') v.driver = null;
      this.setInVehicle(null);
    }
  }

  _groundAt(x, z) {
    const g = this.game;
    let y = -1;
    try { if (g.world && typeof g.world.findGround === 'function') y = g.world.findGround(x, z); } catch (e) { y = -1; }
    if (!(y > 0)) {
      try { const p = g.generator && g.generator.plan; if (p && typeof p.surfaceY === 'function') y = p.surfaceY(x, z); } catch (e) { y = -1; }
    }
    return y > 0 ? y : WORLD.CITY_LEVEL;
  }

  /** Move up out of solid blocks (spawned inside a wall / block placed on us). */
  _unstick() {
    const w = this.game.world;
    if (!w || typeof w.isSolid !== 'function') return;
    const p = this.position;
    for (let i = 0; i < 64 && boxCollides(w, p.x, p.y, p.z, this.radius, this.height); i++) p.y = Math.floor(p.y) + 1;
  }

  _installDebug() {
    const g = this.game, d = g.debug, self = this;
    if (!d) return;
    d.give = (kind, id, count) => {
      const inv = g.inventory;
      if (!inv) return false;
      if (kind === 'block') {
        const bid = typeof id === 'string' ? B[id.toUpperCase()] : id;
        return inv.addBlock(bid, count === undefined ? 64 : count);
      }
      if (kind === 'weapon') return inv.addWeapon(id, count);
      if (kind === 'ammo') return inv.addAmmo(id, count === undefined ? 60 : count);
      if (kind === 'tool') return TOOLS[id] ? inv.addItem({ kind: 'tool', id }) : false;
      if (kind === 'money' || kind === 'cash') return self.addMoney(count !== undefined ? count : (typeof id === 'number' ? id : 1000), 'debug');
      if (kind === 'armor') return self.addArmor(count !== undefined ? count : 100);
      if (kind === 'health') return self.heal(count !== undefined ? count : 100);
      return false;
    };
    d.god = (on = true) => { self.god = !!on; return self.god; };
    d.creative = (on = true) => { g.inventory?.setCreative?.(!!on); return !!(g.inventory && g.inventory.creative); };
    d.fly = (on = true) => { if (on) g.inventory?.setCreative?.(true); self.flying = !!on; return self.flying; };
    d.kill = () => self.damage(9999, { type: 'fall', source: null });
    d.look = (yaw, pitch) => { const r = g.cameraRig; if (!r) return; if (Number.isFinite(yaw)) r.yaw = yaw; if (Number.isFinite(pitch)) r.pitch = pitch; };
    d.camMode = (m) => { g.cameraRig?.setMode?.(m); return g.cameraRig && g.cameraRig.mode; };
    d.target = () => {
      const t = self.interact && self.interact.target;
      return t ? { x: t.x, y: t.y, z: t.z, id: t.id, name: BLOCKS[t.id] && BLOCKS[t.id].name, normal: t.normal.toArray(), distance: +t.distance.toFixed(2) } : null;
    };
    d.playerState = () => ({
      pos: self.position.toArray().map((v) => +v.toFixed(2)),
      vel: self.velocity.toArray().map((v) => +v.toFixed(2)),
      yaw: +self.yaw.toFixed(3), health: +self.health.toFixed(1), armor: +self.armor.toFixed(1), money: self.money,
      alive: self.alive, onGround: self.onGround, inWater: self.inWater, swimming: self.swimming, flying: self.flying,
      sprinting: self.sprinting, crouching: self.crouching, aiming: self.aiming, breath: +self.breath.toFixed(2),
      mining: self.interact && self.interact.mining ? { ...self.interact.mining, progress: +self.interact.progress.toFixed(2) } : null,
      cam: g.cameraRig ? { mode: g.cameraRig.mode, yaw: +g.cameraRig.yaw.toFixed(3), pitch: +g.cameraRig.pitch.toFixed(3), firstPerson: g.cameraRig.firstPerson } : null,
      selected: g.inventory ? g.inventory.getSelected() : null,
    });
  }
}
