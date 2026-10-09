// HeliUnit: the police helicopter at 4+ stars (POLICE agent). The aircraft is a Vehicles 'police_heli' flown by
// the vehicles autopilot (vehicle.autopilot = {x, y, z} hover target, set here every frame). It circles 15-25 m
// around the player ~25 m up (higher over towers), sweeps the search area when the player is hidden, carries a
// door gunner (rifle every 2-3 s with line of sight) and points the Police searchlight at night. Can be shot down.
import * as THREE from 'three';
import { clamp } from '../core/math.js';
import { TUNE, HELI_HIT, MAX_HIT } from './police_const.js';
import { rand, aimShot, hdist, speedOf } from './police_util.js';
import { WORLD } from '../core/config.js';

const _o = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class HeliUnit {
  /** @param {Police} police  @param {Vehicle} vehicle a flying 'police_heli' */
  constructor(police, vehicle) {
    this.police = police;
    this.game = police.game;
    this.vehicle = vehicle;
    this.state = 'pursue';     // 'pursue' | 'search' | 'leave'
    this.stateT = 0;
    this.sees = false;
    this.losT = Math.random() * TUNE.LOS_INTERVAL;
    this.orbitA = Math.random() * Math.PI * 2;
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.orbitR = rand(16, 23);
    this.altT = 0;
    this.clearY = 0;
    this.shootT = rand(2.2, 3.2);
    this.sweepA = 0;
    this.lightX = vehicle.position.x; this.lightY = 28; this.lightZ = vehicle.position.z;
    this.removed = false;
    this.lost = false;
    const pl = this.game.player;
    this.distToPlayer = pl && pl.position ? hdist(vehicle.position, pl.position) : 999;
    this.blipPhase = 0;
    this.shooter = { kind: 'cop', team: 'police', alive: true, vehicle, position: vehicle.position, velocity: vehicle.velocity, height: 1.8, radius: 0.3 };
    vehicle.ai = this;
    vehicle.driver = 'ai';
    vehicle.sirenOn = true;
    vehicle.parked = false;
    vehicle.persistent = false;
    vehicle.autopilot = { x: vehicle.position.x, y: vehicle.position.y, z: vehicle.position.z };
    if (typeof vehicle.wake === 'function') vehicle.wake();
  }

  get carAlive() { const v = this.vehicle; return !!(v && !v.destroyed && !v.removed && v.ai === this); }

  // ---- vehicle hooks
  release(v) { if (!v || v === this.vehicle) this._detach(); }
  onCarjacked(v) { if (v === this.vehicle) this._detach(); }
  onDestroyed(v) {
    if (v !== this.vehicle) return;
    v.policeCrewLost = 2;
    this.police.onCarCrewKilled(this, 2);
    this._detach();
  }

  _detach() {
    const v = this.vehicle;
    if (!v) return;
    if (v.ai === this) { v.ai = null; if (v.driver === 'ai') v.driver = null; v.autopilot = null; }
    this.vehicle = null;
    this.shooter.alive = false;
    if (!this.lost) { this.lost = true; this.police.onHeliLost(this); }
  }

  dispose() {
    if (this.removed) return;
    this.removed = true;
    this.lost = true;
    const v = this.vehicle;
    if (v) {
      if (v.ai === this) { v.ai = null; v.autopilot = null; }
      if (v.driver !== 'player') {
        v.driver = null;
        if (!v.removed && this.game.vehicles && typeof this.game.vehicles.remove === 'function') {
          try { this.game.vehicles.remove(v); } catch (e) { /* ignore */ }
        }
      }
    }
    this.vehicle = null;
  }

  /** Highest obstacle top (standing height) around (x, z) within r metres (towers, mountains). */
  _obstacleTop(x, z, r) {
    const g = this.game, plan = g.generator && g.generator.plan;
    let top = WORLD.CITY_LEVEL;
    const sample = (sx, sz) => {
      let h = -1;
      if (plan) {
        const roof = typeof plan.roofAt === 'function' ? plan.roofAt(sx, sz) : null;
        const s = typeof plan.surfaceY === 'function' ? plan.surfaceY(sx, sz) : WORLD.CITY_LEVEL;
        h = Math.max(Number.isFinite(roof) ? roof : -1, Number.isFinite(s) ? s : -1);
      } else if (g.world && typeof g.world.columnTop === 'function') h = g.world.columnTop(sx, sz) + 1;
      if (h > top) top = h;
    };
    sample(x, z);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; sample(x + Math.cos(a) * r, z + Math.sin(a) * r); }
    return top;
  }

  update(dt) {
    const v = this.vehicle;
    if (!v || !this.carAlive) return;
    const P = this.police, g = this.game, pl = g.player;
    this.stateT += dt;
    this.shooter.position = v.position;
    const alivePlayer = !!(pl && pl.alive !== false && pl.position);
    const pp = alivePlayer ? (pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position) : null;
    if (pp) this.distToPlayer = hdist(v.position, pp);
    if (this.state !== 'leave') {
      if (P.wanted < 4 || !alivePlayer) { this.state = 'leave'; this.stateT = 0; }
      else this.state = P.knows || this.sees ? 'pursue' : 'search';
    }
    let cx, cz, baseY;
    if (this.state === 'leave') {
      // climb away from the player and vanish
      const ax = pp ? v.position.x - pp.x : Math.sin(v.yaw), az = pp ? v.position.z - pp.z : Math.cos(v.yaw);
      const l = Math.hypot(ax, az) || 1;
      v.autopilot.x = v.position.x + (ax / l) * 120;
      v.autopilot.z = v.position.z + (az / l) * 120;
      v.autopilot.y = Math.min(WORLD.HEIGHT + 20, Math.max(v.position.y + 10, 70));
      v.sirenOn = false;
      this._aimLight(dt, null);
      return;
    }
    v.sirenOn = true;
    if (this.state === 'pursue' && pp) {
      // lead fast targets a little so we keep up
      const pv = pl.inVehicle;
      const lead = pv ? 0.8 : 0.3;
      cx = pp.x + (pl.inVehicle ? pv.velocity.x : pl.velocity ? pl.velocity.x : 0) * lead;
      cz = pp.z + (pl.inVehicle ? pv.velocity.z : pl.velocity ? pl.velocity.z : 0) * lead;
      baseY = pp.y;
    } else {
      // sweep the search area in a slow figure around the last known position
      this.sweepA += dt * 0.18;
      const r = P.searchRadius() * 0.55;
      cx = P.lastKnown.x + Math.cos(this.sweepA) * r;
      cz = P.lastKnown.z + Math.sin(this.sweepA * 1.7) * r * 0.7;
      baseY = pp ? pp.y : WORLD.CITY_LEVEL;
    }
    const fast = pl && pl.inVehicle ? speedOf(pl.inVehicle) : 0;
    this.orbitA += dt * this.orbitDir * (fast > 12 ? 0.08 : 0.26);
    const R = this.orbitR + Math.sin(this.stateT * 0.33) * 4;
    const tx = cx + Math.cos(this.orbitA) * R, tz = cz + Math.sin(this.orbitA) * R;
    // altitude: ~25 m above the player, and well clear of towers / hills around the target and on the way
    this.altT -= dt;
    if (this.altT <= 0) {
      this.altT = 0.5;
      let top = this._obstacleTop(tx, tz, 14);
      const steps = 4;
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        top = Math.max(top, this._obstacleTop(v.position.x + (tx - v.position.x) * t, v.position.z + (tz - v.position.z) * t, 8));
      }
      this.clearY = top + 11;
    }
    const ty = clamp(Math.max(baseY + 25, this.clearY), WORLD.CITY_LEVEL + 12, WORLD.HEIGHT + 18);
    v.autopilot.x = tx; v.autopilot.y = ty; v.autopilot.z = tz;
    this._aimLight(dt, this.state === 'pursue' ? pp : null);
    this._gunner(dt, pp);
  }

  /** Searchlight target: the player when seen, otherwise a sweeping spot in the search area. */
  _aimLight(dt, pp) {
    const P = this.police, v = this.vehicle;
    let x, y, z;
    if (pp) { x = pp.x; y = pp.y; z = pp.z; }
    else {
      const t = this.stateT;
      const r = Math.min(P.searchRadius() * 0.5, 30);
      x = (this.state === 'leave' ? v.position.x : P.lastKnown.x) + Math.cos(t * 0.7) * r;
      z = (this.state === 'leave' ? v.position.z : P.lastKnown.z) + Math.sin(t * 0.9) * r;
      y = WORLD.CITY_LEVEL;
    }
    const k = Math.min(1, dt * (pp ? 6 : 1.5));
    this.lightX += (x - this.lightX) * k;
    this.lightY += (y - this.lightY) * k;
    this.lightZ += (z - this.lightZ) * k;
  }

  /** Door gunner: a rifle shot every 2-3 s with line of sight (lethal policy only). */
  _gunner(dt, pp) {
    const P = this.police, v = this.vehicle, g = this.game, pl = g.player;
    if (!pp || this.state !== 'pursue' || !this.sees || P.policy !== 'shoot') { this.shootT = Math.max(this.shootT, 0.8); return; }
    const d3 = Math.hypot(pp.x - v.position.x, pp.y - v.position.y, pp.z - v.position.z);
    if (d3 > TUNE.HELI_LOS_RANGE) return;
    this.shootT -= dt;
    if (this.shootT > 0) return;
    this.shootT = rand(2.0, 3.0);
    // the gunner sits in the side door facing the player
    const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
    const lr = (pp.x - v.position.x) * c - (pp.z - v.position.z) * s; // + = player on our left (local +x)
    const side = lr >= 0 ? 1 : -1;
    if (typeof v.localToWorld === 'function') v.localToWorld(side * 1.35, 0.9, 0.4, _o);
    else _o.set(v.position.x, v.position.y + 0.9, v.position.z);
    const base = HELI_HIT[Math.min(5, P.wanted)] || 0.2;
    const ts = pl.inVehicle ? speedOf(pl.inVehicle) : speedOf(pl);
    const hit = P.rollHit(Math.min(MAX_HIT, base * clamp(1 - ts / 22, 0.35, 1) * (pl.inVehicle ? 1.2 : 1)));
    aimShot(_o, pl, hit, _dir);
    try { g.combat?.fire?.(this.shooter, _o, _dir, 'rifle'); } catch (e) { /* combat stub */ }
  }
}
