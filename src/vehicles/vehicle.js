// A single vehicle: entity (§3.3) + driving state + its voxel model. Physics lives in physics.js and the
// orchestration (input, enter/exit, effects, audio, streaming) in vehicles.js.
import * as THREE from 'three';
import { clamp, damp } from '../core/math.js';
import { VEHICLE_TYPES } from './types.js';
import { buildSamples } from './physics.js';
import {
  materials, acquireBody, releaseBody, glassGeometry, lightsGeometry, wheelGeometry, rotorGeometries,
  driverGeometry, getSpec, secondaryFor, LIGHT_COLORS, LIGHT_ROLES,
} from './models.js';

const _q = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _ex = new THREE.Vector3(1, 0, 0);
const _ey = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

// linear-space light colours per role: [off, on] (+ brake for tail)
const LIN = {};
for (const [role, [off, on]] of Object.entries(LIGHT_COLORS)) {
  _col.setHex(off); const a = [_col.r, _col.g, _col.b];
  _col.setHex(on); const b = [_col.r, _col.g, _col.b];
  LIN[role] = [a, b];
}
const DARK = [0.012, 0.011, 0.01];

/** Damage multipliers by damage type. */
const DMG_MULT = { explosion: 4, bullet: 1, melee: 0.35, fire: 1, vehicle: 1, fall: 1, drown: 0 };

export class Vehicle {
  /**
   * @param {Vehicles} sys owning system
   * @param {string} type key of VEHICLE_TYPES
   */
  constructor(sys, type, x, y, z, yaw, opts = {}) {
    const def = VEHICLE_TYPES[type] || VEHICLE_TYPES.sedan;
    this.sys = sys;
    this.game = sys.game;
    // ---- entity interface
    this.id = undefined;
    this.kind = def.kind === 'heli' ? 'heli' : 'vehicle';
    this.team = def.isPolice ? 'police' : 'neutral';
    this.position = new THREE.Vector3(x, y, z);
    this.velocity = new THREE.Vector3();
    this.radius = Math.max(def.size.w / 2, def.size.l * 0.35);
    this.height = def.size.h;
    this.maxHealth = def.health;
    this.health = Number.isFinite(opts.health) ? Math.min(def.health, opts.health) : def.health;
    this.alive = true;
    this.hidden = false;
    // ---- contract fields
    this.type = def.type;
    this.def = def;
    this.yaw = yaw || 0;
    this.speed = 0;
    this.controls = { throttle: 0, steer: 0, brake: 0, handbrake: false, lift: 0 };
    this.driver = null;
    this.ai = null;
    this.destroyed = false;
    this.onFire = false;
    this.isPolice = def.isPolice;
    this.isHeli = def.kind === 'heli';
    this.isBike = def.kind === 'bike';
    this.sirenOn = false;
    this.lightsOn = false;
    this.color = Number.isFinite(opts.color) ? opts.color : def.colors[Math.floor(Math.random() * def.colors.length)];
    this.color2 = secondaryFor(def.type, this.color);
    // ---- extras
    this.persistent = !!opts.persistent;
    this.parked = !!opts.parked;
    this.locked = !!opts.locked;
    this.owned = !!opts.owned;
    this.blip = opts.blip || null;
    this.lightsOverride = null;      // true/false forces headlights; null = automatic (night)
    this.autopilot = null;           // helicopters: {x,y,z} hover target for AI pilots
    this.everPlayer = false;
    // ---- dynamics
    this.yawRate = 0;
    this.steer = 0;                  // smoothed steer -1..1
    this.gripF = 1;
    this.surfGrip = 1;
    this.surfTrac = 1;
    this.slip = 0;
    this.cornerLoad = 0;
    this.burnout = false;
    this.braking = false;
    this.reversing = false;
    this.onGround = true;
    this.airTime = 0;
    this.inWater = false;
    this.flooded = false;
    this.floodT = 0;
    this.aLong = 0;
    this.rpm = 0.12;
    this.rotor = 0;
    this.tilt = 0;
    this.bank = 0;
    this.pitch = 0;
    this.roll = 0;
    this.sleeping = false;
    this.sleepT = 0;
    // per-frame collision results
    this.impact = 0; this.scrape = 0; this.touching = false; this.landImpact = 0; this.rotorStrike = 0;
    this.contactX = 0; this.contactZ = 0; this.contactNX = 0; this.contactNZ = 0;
    // damage / fx state
    this.fireT = 0;
    this.fireHandle = null;
    this.destroyedT = 0;
    this.lastAttacker = null;
    this.alarmT = 0;
    this.hornT = 0;
    this.spawnTime = sys.game.time || 0;
    // visual springs
    this.susp = 0; this.suspV = 0; this.dive = 0; this.bodyRoll = 0; this.lean = 0; this.tumble = 0; this.tumbleV = 0;
    this.visY = y;
    this.wheelSpin = 0;
    this.rotorAngle = 0;
    this.tailAngle = 0;
    this.enginePos = new THREE.Vector3();
    // collision samples / probe heights
    this.samples = buildSamples(def);
    this.gh = new Float32Array(this.samples.ground.length / 2);
    this.boundR = Math.hypot(def.size.w, def.size.l) / 2 + 0.05;
    this.skidPrev = null;
    this._lightKey = -1;
    this._buildMesh();
  }

  // ================================================================ entity API

  /** Forward unit vector (y = 0). */
  forward(out = new THREE.Vector3()) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  /** Right unit vector (y = 0). */
  right(out = new THREE.Vector3()) { return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw)); }

  /** World AABB of the rotated body. */
  getBox(out = new THREE.Box3()) {
    const s = Math.abs(Math.sin(this.yaw)), c = Math.abs(Math.cos(this.yaw));
    const hw = this.def.size.w / 2, hl = this.def.size.l / 2;
    const ex = hw * c + hl * s, ez = hw * s + hl * c;
    const p = this.position;
    out.min.set(p.x - ex, p.y, p.z - ez);
    out.max.set(p.x + ex, p.y + this.def.size.h, p.z + ez);
    return out;
  }

  /** Signed forward speed (m/s). */
  get forwardSpeed() { return this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw); }

  /** Take damage. info = {type, source, point?, dir?}. Explosions that empty the health bar blow it up at once. */
  damage(amount, info = {}) {
    if (!(amount > 0)) return;
    const g = this.game;
    info = info || {};
    if (this.destroyed) {
      if (info.type === 'explosion') this.wake();
      return;
    }
    let a = amount * (DMG_MULT[info.type] ?? 1) * (1 - (this.def.armor || 0));
    if (this.sys.godVehicle && this.driver === 'player') a = 0;
    if (!(a > 0)) return;
    this.health = Math.max(0, this.health - a);
    if (info.source && info.source !== this) this.lastAttacker = info.source;
    this.wake();
    if (info.type === 'bullet' && info.point && g.fx && Math.random() < 0.6) {
      try { g.fx.sparks(info.point, info.normal || (info.dir ? _p.copy(info.dir).negate() : null)); } catch (e) { /* fx stub */ }
    }
    g.events.emit('entityDamaged', { entity: this, amount: a, info });
    // bullets partly reach the (hidden) player through windows / on a bike
    if (info.type === 'bullet' && this.driver === 'player' && g.player && g.player.alive !== false && info.source !== g.player) {
      const through = this.isBike ? 0.8 : this.isHeli ? 0.15 : 0.25;
      try { g.player.damage?.(amount * through, { ...info, type: 'bullet' }); } catch (e) { /* player stub */ }
    }
    if (this.health <= 0) {
      if (info.type === 'explosion') this.sys.explodeVehicle(this, info.source || this.lastAttacker);
      else if (!this.onFire) this.sys.igniteVehicle(this, Math.min(4, this.def.kind === 'bike' ? 2.5 : 4));
    }
  }

  /** Physical push (explosions, rams). impulse ~ velocity change for a ~1.5 t object. */
  knockback(impulse) {
    if (!impulse) return;
    const k = clamp(1500 / this.def.mass, 0.12, 1.4) * 0.75;
    const v = this.velocity;
    v.x += impulse.x * k; v.z += impulse.z * k;
    v.y += Math.max(0, impulse.y || 0) * k * 0.8;
    const hs = Math.hypot(v.x, v.z);
    if (hs > 24) { v.x *= 24 / hs; v.z *= 24 / hs; }
    v.y = Math.min(v.y, 14);
    const mag = Math.hypot(impulse.x, impulse.y || 0, impulse.z);
    this.yawRate = clamp(this.yawRate + (Math.random() * 2 - 1) * mag * k * 0.12, -5, 5);
    if (v.y > 1.5) { this.onGround = false; this.tumbleV += (Math.random() < 0.5 ? -1 : 1) * Math.min(6, mag * k * 0.25); }
    this.knockT = this.game.time;
    this.wake();
  }

  /** Full repair: health, fire, smoke, burnt look (wreck stays destroyed only if already exploded). */
  repair() {
    this.health = this.maxHealth;
    if (this.fireHandle) { try { this.fireHandle.stop(); } catch (e) { /* ignore */ } this.fireHandle = null; }
    this.onFire = false;
    this.fireT = 0;
    if (this.destroyed) {
      this.destroyed = false;
      this.alive = true;
      this.flooded = false;
      this.floodT = 0;
      this._applyBody(false);
    }
  }

  /** Repaint (0xRRGGBB). */
  setColor(hex) {
    if (!Number.isFinite(hex)) return;
    this.color = hex >>> 0;
    this.color2 = secondaryFor(this.def.type, this.color);
    if (!this.destroyed) this._applyBody(false);
  }

  /** Honk for `seconds` (AI convenience). */
  honk(seconds = 0.4) {
    if (this.destroyed) return;
    if (this.hornT <= 0) this.game.audio?.play?.('horn', { position: this.position, volume: 0.9, pitch: this.def.kind === 'car' && this.def.mass > 3000 ? 0.7 : 1 });
    this.hornT = Math.max(this.hornT, seconds);
  }

  /** Wake from physics sleep. */
  wake() { this.sleeping = false; this.sleepT = 0; }

  /** World position of the driver door (left side), at standing height. */
  getDoorPosition(out = new THREE.Vector3(), side = 1, extra = 0.6) {
    const d = this.def, m = this.meta.driver || { z: 0 };
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const lx = side * (d.size.w / 2 + extra), lz = clamp(m.z, -d.size.l / 2 + 0.5, d.size.l / 2 - 0.5);
    return out.set(this.position.x + lx * cy + lz * sy, this.position.y, this.position.z - lx * sy + lz * cy);
  }

  /** Local point (model space) -> world. */
  localToWorld(lx, ly, lz, out = new THREE.Vector3()) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    return out.set(this.position.x + lx * cy + lz * sy, this.position.y + ly, this.position.z - lx * sy + lz * cy);
  }

  // ================================================================ model

  _buildMesh() {
    const M = materials();
    const def = this.def;
    const spec = getSpec(def.model);
    this.meta = spec.meta;
    const root = new THREE.Group();
    root.name = 'vehicle:' + def.type;
    const chassis = new THREE.Group();     // terrain pitch / roll (+ bike lean)
    const body = new THREE.Group();        // suspension bob, dive, body roll
    root.add(chassis);
    chassis.add(body);
    this.mesh = root;
    this.chassis = chassis;
    this.bodyGroup = body;

    this._bodyKey = null;
    this.bodyMesh = new THREE.Mesh(new THREE.BufferGeometry(), M.body);
    this.bodyMesh.castShadow = !!this.game.settings?.shadows;
    body.add(this.bodyMesh);
    this._applyBody(false);

    const gg = glassGeometry(def.model);
    if (gg) { this.glassMesh = new THREE.Mesh(gg, M.glass); this.glassMesh.renderOrder = 2; body.add(this.glassMesh); }
    this.lightsGeo = lightsGeometry(def.model);
    if (this.lightsGeo) { this.lightsMesh = new THREE.Mesh(this.lightsGeo, M.lights); body.add(this.lightsMesh); }

    // wheels: one InstancedMesh per vehicle (1 draw call for all wheels)
    const ws = def.wheels;
    if (ws.length) {
      const wg = wheelGeometry(ws[0].r, Math.max(...ws.map((w) => w.w)));
      this.wheelMesh = new THREE.InstancedMesh(wg, M.wheel, ws.length);
      this.wheelMesh.castShadow = !!this.game.settings?.shadows;
      chassis.add(this.wheelMesh);
      this._updateWheels(0);
      this.wheelMesh.computeBoundingSphere();
    }
    // helicopter rotors
    if (this.isHeli) {
      const rg = rotorGeometries(def.rotorRadius || 5);
      const m = this.meta;
      this.rotorMesh = new THREE.Mesh(rg.main, M.rotor);
      this.rotorMesh.position.set(m.rotor.x, m.rotor.y, m.rotor.z);
      this.tailRotorMesh = new THREE.Mesh(rg.tail, M.rotor);
      this.tailRotorMesh.position.set(m.tailRotor.x, m.tailRotor.y, m.tailRotor.z);
      body.add(this.rotorMesh, this.tailRotorMesh);
    }
    // seated driver figure (cars + helis; bikes use a full Humanoid rider from the system)
    if (!this.isBike) {
      this.driverMesh = new THREE.Mesh(driverGeometry(this._driverLook()), M.body);
      const d = this.meta.driver || { x: 0.4, y: 0.6, z: 0 };
      this.driverMesh.position.set(d.x, d.y, d.z);
      this.driverMesh.visible = false;
      body.add(this.driverMesh);
    }
    root.position.copy(this.position);
    root.rotation.y = this.yaw;
  }

  _driverLook() {
    const t = this.def.type;
    if (t === 'swat') return { shirt: 0x222222, hat: 0x1a1a1a, skin: 0xc68642, hair: 0x111111 };
    if (this.isPolice) return { shirt: 0x1c2f5e, hat: 0x14213d, skin: 0xd8a47f, hair: 0x1a1a1a };
    if (t === 'ambulance') return { shirt: 0xe8e8e8, skin: 0xe0ac69, hair: 0x4a2f1b };
    const SH = [0xc0392b, 0x2980b9, 0x27ae60, 0xf1c40f, 0x8e44ad, 0xecf0f1, 0x34495e, 0xe67e22];
    const SK = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
    const HR = [0x2b1b0e, 0x1a1a1a, 0x4a2f1b, 0xd6b25e, 0x9a9a9a];
    const r = (this.color * 2654435761) >>> 0;
    return { shirt: SH[r % SH.length], skin: SK[(r >>> 5) % SK.length], hair: HR[(r >>> 9) % HR.length] };
  }

  /** Swap the driver figure's look (e.g. the player took over). */
  setDriverLook(look) {
    if (!this.driverMesh) return;
    const old = this.driverMesh.geometry;
    this.driverMesh.geometry = driverGeometry(look || this._driverLook());
    if (old) old.dispose();
  }

  _applyBody(burnt) {
    const prev = this._bodyKey;
    const r = acquireBody(this.def.model, this.color, this.color2, burnt);
    this._bodyKey = r.key;
    this.bodyMesh.geometry = r.geo;
    if (prev) releaseBody(prev);
    if (this.glassMesh) this.glassMesh.visible = !burnt;
    if (this.wheelMesh) this.wheelMesh.material = burnt ? materials().wheelBurnt : materials().wheel;
    this._lightKey = -1;
  }

  /** Swap to the charred wreck model. */
  setBurnt() {
    this._applyBody(true);
    if (this.driverMesh) this.driverMesh.visible = false;
  }

  /** Release GPU resources owned by this vehicle (shared geometries are ref-counted / cached). */
  disposeMesh() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (this._bodyKey) { releaseBody(this._bodyKey); this._bodyKey = null; }
    if (this.lightsGeo) { this.lightsGeo.dispose(); this.lightsGeo = null; }
    if (this.wheelMesh) this.wheelMesh.dispose();
    if (this.driverMesh) this.driverMesh.geometry.dispose();
  }

  // ================================================================ per-frame visuals

  /** Sync the model to the simulation (called once per frame after physics). */
  syncVisual(dt, time, opts) {
    const root = this.mesh;
    const p = this.position;
    // vertical smoothing hides voxel step-ups (snaps on big jumps / teleports)
    if (Math.abs(p.y - this.visY) > 2.5 || !this.onGround) this.visY = p.y;
    else this.visY += (p.y - this.visY) * damp(22, dt);
    root.position.set(p.x, this.visY, p.z);
    root.rotation.y = this.yaw;

    // body dynamics: squat/dive, roll, suspension bob, bike lean, explosion tumble
    const vF = this.forwardSpeed;
    const aLat = -vF * this.yawRate;   // + = accelerating toward the right (turning right)
    const kb = damp(7, dt);
    if (this.isHeli) {
      this.dive += (0 - this.dive) * kb;
      this.bodyRoll += (0 - this.bodyRoll) * kb;
    } else if (this.isBike) {
      const leanT = this.onGround ? clamp(Math.atan(aLat / 14), -0.6, 0.6) : this.lean * 0.98;
      this.lean += (leanT - this.lean) * damp(8, dt);
      this.dive += (clamp(-this.aLong * 0.004, -0.06, 0.06) - this.dive) * kb;
    } else {
      this.dive += (clamp(-this.aLong * 0.0055, -0.065, 0.065) - this.dive) * kb;
      this.bodyRoll += (clamp(-aLat * 0.0065, -0.075, 0.075) - this.bodyRoll) * kb;
    }
    this.suspV += (-190 * this.susp - 15 * this.suspV) * dt;
    this.susp += this.suspV * dt;
    this.susp = clamp(this.susp, -0.22, 0.2);
    if (this.tumble !== 0 || this.tumbleV !== 0) {
      this.tumble += this.tumbleV * dt;
      if (this.onGround) { this.tumbleV *= Math.exp(-6 * dt); this.tumble *= Math.exp(-5 * dt); }
      if (Math.abs(this.tumble) < 1e-3 && Math.abs(this.tumbleV) < 1e-2) { this.tumble = 0; this.tumbleV = 0; }
    }
    this.chassis.rotation.set(this.pitch, 0, this.roll + (this.isBike ? this.lean : 0) + this.tumble, 'XYZ');
    this.bodyGroup.position.y = this.susp;
    this.bodyGroup.rotation.set(this.dive, 0, this.bodyRoll, 'XYZ');

    // wheels
    if (this.wheelMesh) {
      if (!this.destroyed) this.wheelSpin += (this.burnout ? 32 : vF / this.def.wheelRadius) * dt;
      this._updateWheels(this.onGround ? 0 : Math.min(0.12, this.airTime * 0.8));
    }
    // rotors
    if (this.isHeli && this.rotorMesh) {
      this.rotorAngle += this.rotor * 26 * dt;
      this.tailAngle += this.rotor * 42 * dt;
      this.rotorMesh.rotation.y = this.rotorAngle;
      this.tailRotorMesh.rotation.x = this.tailAngle;
    }
    // driver figure
    if (this.driverMesh) this.driverMesh.visible = !!this.driver && !this.destroyed && !(opts && opts.hideDriver);
    // engine smoke/fire anchor
    const e = this.meta.engine || { x: 0, y: this.def.size.h * 0.6, z: this.def.size.l * 0.3 };
    this.localToWorld(e.x, e.y + 0.1, e.z, this.enginePos);
    this._updateLights(time);
  }

  _updateWheels(droop) {
    const ws = this.def.wheels, im = this.wheelMesh;
    const steerVis = this.steer * Math.min(0.55, this.def.steer * 0.85);
    _qs.setFromAxisAngle(_ex, this.wheelSpin);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      _p.set(w.x, w.r - droop, w.z);
      if (w.steer) { _q.setFromAxisAngle(_ey, steerVis); _q.multiply(_qs); } else _q.copy(_qs);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(i, _m);
    }
    im.instanceMatrix.needsUpdate = true;
  }

  _updateLights(time) {
    const geo = this.lightsGeo;
    if (!geo) return;
    const dead = this.destroyed;
    const on = this.lightsOn && !dead;
    const siren = this.sirenOn && !dead;
    const phase = time * 2.3;
    const left = Math.sin(phase * Math.PI * 2) > 0;
    const strobe = (time * 18) % 1 < 0.62;
    const barR = siren && left && strobe, barB = siren && !left && strobe, barW = siren && (time * 7) % 1 < 0.3;
    const alarm = this.alarmT > 0 && !dead && (time * 2.5) % 1 < 0.5;
    const tail = this.braking ? 2 : on ? 1 : 0;
    const nav = this.isHeli && !dead;
    const beacon = nav && (time * 1.1) % 1 < 0.12;
    const search = this.isHeli && !dead && this.isPolice && (this.sirenOn || this.lightsOn);
    const headOn = on || alarm;
    const key = (headOn ? 1 : 0) | (tail << 1) | ((this.reversing && !dead) ? 8 : 0) | (alarm ? 16 : 0) | (barR ? 32 : 0) |
      (barB ? 64 : 0) | (barW ? 128 : 0) | (nav ? 256 : 0) | (beacon ? 512 : 0) | (search ? 1024 : 0) | (dead ? 2048 : 0) |
      (on ? 4096 : 0);
    if (key === this._lightKey) return;
    this._lightKey = key;
    const roles = geo.userData.roles;
    const arr = geo.attributes.color.array;
    const pick = (ri) => {
      if (dead) return DARK;
      switch (LIGHT_ROLES[ri]) {
        case 'head': return LIN.head[headOn ? 1 : 0];
        case 'tail': return tail === 2 ? LIN.brake[1] : LIN.tail[tail];
        case 'rev': return LIN.rev[this.reversing ? 1 : 0];
        case 'ind': return LIN.ind[alarm ? 1 : 0];
        case 'barR': return LIN.barR[barR ? 1 : 0];
        case 'barB': return LIN.barB[barB ? 1 : 0];
        case 'barW': return LIN.barW[barW ? 1 : 0];
        case 'sign': return LIN.sign[1];
        case 'navR': return LIN.navR[nav ? 1 : 0];
        case 'navG': return LIN.navG[nav ? 1 : 0];
        case 'strobe': return LIN.strobe[beacon ? 1 : 0];
        case 'search': return LIN.search[search ? 1 : 0];
        default: return DARK;
      }
    };
    let last = -1, c = DARK;
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] !== last) { last = roles[i]; c = pick(last); }
      arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2];
    }
    geo.attributes.color.needsUpdate = true;
  }
}
