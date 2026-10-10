// Physical projectiles (COMBAT): bouncing grenades with a fuse and RPG rockets with a smoke trail.
// Both are simulated against the voxel world (swept, sub-stepped) and against entity boxes.
import * as THREE from 'three';
import { voxelRaycast } from '../core/physics.js';
import { PHYS } from '../core/config.js';
import { BLOCKS } from '../world/blocks.js';
import { WEAPONS } from '../data/weapons.js';
import { getWeaponModel } from './weaponModels.js';
import { bulletFilter } from './ballistics.js';

export const GRENADE = { restitution: 0.4, friction: 0.78, radius: 0.07, rollDrag: 3.2, upBoost: 4 };
const MAX_GRENADES = 24;
const MAX_ROCKETS = 16;

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1);

/** Solid test that tolerates a stub world. */
function solidAt(w, x, y, z) {
  try { return !!w.isSolid(Math.floor(x), Math.floor(y), Math.floor(z)); } catch (e) { return false; }
}
function liquidAt(w, x, y, z) {
  try { const d = BLOCKS[w.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))]; return !!(d && d.liquid); } catch (e) { return false; }
}

/**
 * Integrate a grenade-like point body one step through the voxel world with bounces.
 * state = {pos, vel, onGround, inWater}; returns impact speed of the hardest bounce this step (0 if none).
 * Pure function of (world, state, dt): also used by the trajectory preview.
 */
export function stepGrenade(w, s, dt) {
  const vel = s.vel, pos = s.pos, r = GRENADE.radius;
  s.inWater = liquidAt(w, pos.x, pos.y, pos.z);
  if (s.inWater) { vel.y -= PHYS.WATER_GRAVITY * dt; vel.multiplyScalar(Math.exp(-PHYS.WATER_DRAG * 1.4 * dt)); }
  else vel.y = Math.max(-PHYS.TERMINAL_VELOCITY, vel.y - PHYS.GRAVITY * dt);
  const speed = vel.length();
  const n = Math.max(1, Math.ceil((speed * dt) / 0.12));
  const h = dt / n;
  let impact = 0;
  s.onGround = false;
  for (let i = 0; i < n; i++) {
    // Y
    const ny = pos.y + vel.y * h;
    const oy = ny + (vel.y > 0 ? r : -r);
    if (solidAt(w, pos.x, oy, pos.z)) {
      const sp = Math.abs(vel.y);
      if (vel.y < 0) { pos.y = Math.floor(oy) + 1 + r + 1e-3; s.onGround = true; }
      else pos.y = Math.floor(oy) - r - 1e-3;
      vel.y = -vel.y * GRENADE.restitution;
      if (s.onGround && vel.y < 1.4) vel.y = 0;
      vel.x *= GRENADE.friction; vel.z *= GRENADE.friction;
      impact = Math.max(impact, sp);
    } else pos.y = ny;
    // X
    const nx = pos.x + vel.x * h;
    const ox = nx + (vel.x > 0 ? r : -r);
    if (solidAt(w, ox, pos.y, pos.z)) {
      const sp = Math.abs(vel.x);
      pos.x = vel.x > 0 ? Math.floor(ox) - r - 1e-3 : Math.floor(ox) + 1 + r + 1e-3;
      vel.x = -vel.x * GRENADE.restitution;
      vel.y *= GRENADE.friction; vel.z *= GRENADE.friction;
      impact = Math.max(impact, sp);
    } else pos.x = nx;
    // Z
    const nz = pos.z + vel.z * h;
    const oz = nz + (vel.z > 0 ? r : -r);
    if (solidAt(w, pos.x, pos.y, oz)) {
      const sp = Math.abs(vel.z);
      pos.z = vel.z > 0 ? Math.floor(oz) - r - 1e-3 : Math.floor(oz) + 1 + r + 1e-3;
      vel.z = -vel.z * GRENADE.restitution;
      vel.y *= GRENADE.friction; vel.x *= GRENADE.friction;
      impact = Math.max(impact, sp);
    } else pos.z = nz;
  }
  // resting on a floor: rolling friction
  if (!s.onGround && vel.y === 0 && solidAt(w, pos.x, pos.y - r - 0.02, pos.z)) s.onGround = true;
  if (s.onGround) {
    const f = Math.exp(-GRENADE.rollDrag * dt);
    vel.x *= f; vel.z *= f;
    if (Math.abs(vel.x) < 0.05) vel.x = 0;
    if (Math.abs(vel.z) < 0.05) vel.z = 0;
  }
  return impact;
}

export class Projectiles {
  constructor(combat) {
    this.combat = combat;
    this.game = combat.game;
    this.grenades = [];
    this.rockets = [];
    this._flameGeo = null;
    this._flameMat = null;
  }

  get count() { return this.grenades.length + this.rockets.length; }

  // -------------------------------------------------------------------------------------------- grenades

  /**
   * Throw a grenade from `origin` with unit `dir`. power = launch speed (default weapon throwSpeed 18).
   * Velocity = dir * power + up * 4 (+ some of the thrower's own velocity). Returns the grenade object.
   */
  throwGrenade(thrower, origin, dir, power) {
    const g = this.game;
    if (!origin || !dir) return null;
    if (this.grenades.length >= MAX_GRENADES) this._explodeGrenade(0);
    const def = WEAPONS.grenade;
    const sp = Number.isFinite(power) && power > 0 ? power : (def.throwSpeed || 18);
    _d.copy(dir);
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
    _d.normalize();
    const vel = new THREE.Vector3().copy(_d).multiplyScalar(sp);
    vel.y += GRENADE.upBoost;
    if (thrower && thrower.velocity && !thrower.inVehicle) vel.addScaledVector(thrower.velocity, 0.5);
    const mesh = getWeaponModel('grenade') || new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.08), new THREE.MeshLambertMaterial({ color: 0x3d5a2a }));
    mesh.scale.setScalar(1.35);
    const gr = {
      thrower: thrower || null,
      pos: new THREE.Vector3().copy(origin),
      vel,
      fuse: def.fuse || 2.5,
      age: 0,
      onGround: false,
      inWater: false,
      spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 14),
      bounceSndT: 0,
      mesh,
    };
    // never start inside a block: pull back toward the thrower's body if the hand is in a wall
    if (g.world && solidAt(g.world, gr.pos.x, gr.pos.y, gr.pos.z) && thrower && thrower.position) {
      gr.pos.set(thrower.position.x, thrower.position.y + 1.3, thrower.position.z);
    }
    mesh.position.copy(gr.pos);
    g.scene.add(mesh);
    this.grenades.push(gr);
    return gr;
  }

  _updateGrenades(dt) {
    const g = this.game, w = g.world;
    const ents = g.entities;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const gr = this.grenades[i];
      gr.age += dt;
      gr.fuse -= dt;
      gr.bounceSndT -= dt;
      const prevX = gr.pos.x, prevY = gr.pos.y, prevZ = gr.pos.z;
      if (w) {
        const impact = stepGrenade(w, gr, dt);
        if (impact > 2.2 && gr.bounceSndT <= 0) {
          gr.bounceSndT = 0.08;
          g.audio?.play?.('grenade_bounce', { position: gr.pos, volume: Math.min(1, 0.3 + impact / 14), pitch: 0.9 + Math.random() * 0.25 });
          if (impact > 5) { try { g.fx?.dust?.(gr.pos, { amount: 1 }); } catch (e) { /* fx */ } }
        }
      } else {
        gr.vel.y -= PHYS.GRAVITY * dt;
        gr.pos.addScaledVector(gr.vel, dt);
      }
      // bounce off people / cars
      if (ents && ents.raycast) {
        _d.set(gr.pos.x - prevX, gr.pos.y - prevY, gr.pos.z - prevZ);
        const len = _d.length();
        if (len > 1e-4) {
          _d.divideScalar(len);
          _v.set(prevX, prevY, prevZ);
          let eh = null;
          try { eh = ents.raycast(_v, _d, len + GRENADE.radius, gr.age < 0.35 ? gr.thrower : null, bulletFilter); } catch (e) { eh = null; }
          if (eh) {
            gr.pos.copy(eh.point).addScaledVector(_d, -0.08);
            gr.vel.multiplyScalar(-0.3);
            gr.vel.y = Math.max(gr.vel.y, 1);
            if (gr.bounceSndT <= 0) { gr.bounceSndT = 0.1; g.audio?.play?.('grenade_bounce', { position: gr.pos, volume: 0.5, pitch: 0.7 }); }
          }
        }
      }
      // visuals: tumble in the air, settle on the ground
      const m = gr.mesh;
      m.position.copy(gr.pos);
      const sp = gr.onGround ? Math.min(1, Math.hypot(gr.vel.x, gr.vel.z) / 3) : 1;
      m.rotation.x += gr.spin.x * dt * sp;
      m.rotation.y += gr.spin.y * dt * sp;
      m.rotation.z += gr.spin.z * dt * sp;
      if (gr.onGround && sp < 0.2) {
        m.rotation.x += (0 - m.rotation.x) * Math.min(1, dt * 8);
        m.rotation.z += (Math.PI / 2 - m.rotation.z) * Math.min(1, dt * 8);
      }
      if (gr.pos.y < -8) gr.fuse = 0;
      if (gr.fuse <= 0) this._explodeGrenade(i);
    }
  }

  _explodeGrenade(i) {
    const gr = this.grenades[i];
    if (!gr) return;
    this.grenades.splice(i, 1);
    if (gr.mesh.parent) gr.mesh.parent.remove(gr.mesh);
    const def = WEAPONS.grenade;
    const c = gr.pos.clone();
    if (gr.onGround) c.y += 0.3;
    this.combat.explode(c, {
      radius: def.blastRadius || 4.5,
      power: gr.inWater ? 0 : (def.blastPower || 3),
      damage: def.damage || 160,
      source: gr.thrower,
      weapon: 'grenade',
    });
  }

  // -------------------------------------------------------------------------------------------- rockets

  _ensureFlame() {
    if (this._flameGeo) return;
    this._flameGeo = new THREE.BoxGeometry(0.1, 0.1, 0.32);
    this._flameGeo.translate(0, 0, -0.16);
    this._flameMat = new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  }

  /**
   * Launch a rocket from `origin` along unit `dir`. opts: {ignore: entity[], weapon}. Returns the rocket.
   */
  launchRocket(shooter, origin, dir, opts = {}) {
    const g = this.game;
    if (!origin || !dir) return null;
    if (this.rockets.length >= MAX_ROCKETS) this._detonateRocket(0, this.rockets[0].pos);
    const def = WEAPONS[opts.weapon] || WEAPONS.rpg;
    this._ensureFlame();
    const group = new THREE.Group();
    const body = getWeaponModel('rocket');
    if (body) { body.scale.setScalar(1.35); group.add(body); }
    const flame = new THREE.Mesh(this._flameGeo, this._flameMat);
    flame.position.z = -0.36;
    flame.scale.setScalar(1.3);
    group.add(flame);
    const d = new THREE.Vector3().copy(dir).normalize();
    const r = {
      shooter: shooter || null,
      ignore: opts.ignore || (shooter ? [shooter] : null),
      pos: new THREE.Vector3().copy(origin),
      dir: d,
      speed: def.speed || 60,
      maxRange: def.range || 300,
      traveled: 0,
      age: 0,
      trailAcc: 0,
      def,
      mesh: group,
      flame,
    };
    group.position.copy(r.pos);
    group.quaternion.setFromUnitVectors(_z, d);
    g.scene.add(group);
    this.rockets.push(r);
    return r;
  }

  _updateRockets(dt) {
    const g = this.game, w = g.world, ents = g.entities;
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.age += dt;
      // ignition ramp: leaves the tube a bit slower, then the motor kicks in
      const sp = r.speed * (r.age < 0.12 ? 0.55 + (r.age / 0.12) * 0.45 : 1);
      const step = sp * dt;
      let vh = null, eh = null;
      if (w) { try { vh = voxelRaycast(w, r.pos, r.dir, step + 0.15, { hitNonSolid: false, hitLiquid: true }); } catch (e) { vh = null; } }
      if (ents && ents.raycast) {
        try { eh = ents.raycast(r.pos, r.dir, (vh ? vh.distance : step + 0.15) + 0.05, r.ignore, bulletFilter); } catch (e) { eh = null; }
      }
      // smoke trail (distance-spaced puffs) from the nozzle
      // the motor lights a few metres out of the tube (keeps the shooter's view clear), puffs grow with range
      const travel = eh ? eh.distance : vh ? vh.distance : step;
      if (r.traveled + travel > 2.5) r.trailAcc += travel;
      while (r.trailAcc > 0.55) {
        r.trailAcc -= 0.55;
        _v.copy(r.pos).addScaledVector(r.dir, travel - r.trailAcc - 0.45);
        const size = Math.min(0.34, 0.16 + r.traveled * 0.02);
        try {
          if (g.fx?.trail) g.fx.trail(_v, { size });
          else g.fx?.smoke?.(_v, { amount: 0.7, color: 0xaaaaaa });
        } catch (e) { /* fx stub */ }
      }
      if (eh) {
        _v.copy(eh.point).addScaledVector(r.dir, -0.15);
        this._detonateRocket(i, _v, eh.entity);
        continue;
      }
      if (vh) {
        _v.copy(vh.point).addScaledVector(r.dir, -0.3);
        const def = BLOCKS[vh.id];
        if (def && def.liquid) { try { g.fx?.splash?.(vh.point); } catch (e) { /* fx */ } }
        this._detonateRocket(i, _v);
        continue;
      }
      r.pos.addScaledVector(r.dir, step);
      r.traveled += step;
      r.mesh.position.copy(r.pos);
      // flicker the exhaust
      const f = 0.75 + Math.random() * 0.6;
      r.flame.scale.set(f, f, 0.7 + Math.random() * 0.9);
      if (r.traveled >= r.maxRange || r.pos.y < -5 || r.pos.y > 140) this._detonateRocket(i, r.pos);
    }
  }

  _detonateRocket(i, at, direct = null) {
    const r = this.rockets[i];
    if (!r) return;
    this.rockets.splice(i, 1);
    if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
    const def = r.def;
    // a direct hit on a car always finishes a good chunk of it
    if (direct && typeof direct.damage === 'function' && (direct.kind === 'vehicle' || direct.kind === 'heli')) {
      try { direct.damage(def.damage * 0.5, { type: 'explosion', source: r.shooter, point: at.clone(), dir: r.dir.clone(), weapon: def.id }); } catch (e) { /* ignore */ }
    }
    this.combat.explode(at.clone(), {
      radius: def.blastRadius || 5.5,
      power: def.blastPower || 4,
      damage: def.damage || 220,
      source: r.shooter,
      weapon: def.id,
    });
  }

  update(dt) {
    if (this.grenades.length) this._updateGrenades(dt);
    if (this.rockets.length) this._updateRockets(dt);
  }

  /** Remove everything in flight (no explosions). */
  clear() {
    for (const gr of this.grenades) if (gr.mesh.parent) gr.mesh.parent.remove(gr.mesh);
    for (const r of this.rockets) if (r.mesh.parent) r.mesh.parent.remove(r.mesh);
    this.grenades.length = 0;
    this.rockets.length = 0;
  }
}
