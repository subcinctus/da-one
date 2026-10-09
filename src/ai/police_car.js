// PoliceCar: one police cruiser or SWAT van and its crew (POLICE agent). The vehicle itself belongs to Vehicles;
// this object is its `vehicle.ai` and drives it through `vehicle.controls` (§4.3).
//
// States:  patrol    ambient patrol at 0 stars (lane driving on the road graph, sirens off; witnesses crimes)
//          pursue    chase: road-graph routing when far, direct pure pursuit toward the predicted player position
//                    when close or in sight, ramming at 3+ stars, stopping ~11 m from a player on foot
//          search    the player is out of sight: drive to the last known position and sweep the search area
//          stopped   crew is out on foot (car parked with its light bar flashing)
//          recall    waiting for the crew to get back in (the player drove away)
//          roadblock parked across a road ahead of the player (5 stars)
//          leave     chase over: drive off with the siren off, Police despawns the car out of view
// Steering: pure pursuit on a look-ahead point; speed planning for corners / arrival / heading error; obstacle
// avoidance around other vehicles; stuck recovery (reverse arc, then re-path); never drives into water.
import * as THREE from 'three';
import { clamp, angleDiff, lerp, smoothstep } from '../core/math.js';
import { TUNE, LEVELS } from './police_const.js';
import { rand, chance, isWaterAt, hdist, speedOf, aimShot, groundAt, losClear, SOLID_BLOCKER } from './police_util.js';
import { boxCollides } from '../core/physics.js';

const _p = new THREE.Vector3();
const _o = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tgt = { x: 0, z: 0 };
const LANE_OFF = 1.8;

export class PoliceCar {
  /**
   * @param {Police} police
   * @param {Vehicle} vehicle a 'police' or 'swat' vehicle from Vehicles.spawn
   * @param {object} opts {swat, role: 'pursuit'|'patrol'|'roadblock', crew, slot}
   */
  constructor(police, vehicle, opts = {}) {
    this.police = police;
    this.game = police.game;
    this.vehicle = vehicle;
    this.swat = !!opts.swat;
    this.role = opts.role || 'pursuit';
    this.state = this.role === 'patrol' ? 'patrol' : this.role === 'roadblock' ? 'roadblock' : 'pursue';
    this.stateT = 0;
    this.crew = Number.isFinite(opts.crew) ? opts.crew : (this.swat ? 4 : 2);
    this.officers = [];
    this.slot = opts.slot || 0;
    this.blipPhase = Math.random() < 0.5 ? 0 : 1;
    // perception (Police fills these)
    this.sees = false;
    this.losT = Math.random() * TUNE.LOS_INTERVAL;
    // driving
    this.mode = 'route';
    this.path = [];
    this.wi = 0;
    this.pathT = 0;
    this.pathGoalX = 0; this.pathGoalZ = 0;
    this.goalX = vehicle.position.x; this.goalZ = vehicle.position.z;
    this.desired = 0;
    this.stopDist = 0;
    this.cornerSpeed = Infinity;
    this.obstacleSpeed = Infinity;
    this.avoidSide = 0; this.avoidT = 0;
    this.thinkT = 0;
    this.stuckT = 0; this.revT = 0; this.revSteer = 0; this.stuckCount = 0; this.stuckWindowT = 0;
    this.forceRouteT = 0;
    this.backoffT = 0;
    this.ramming = false;
    this.allowSlide = false;
    this.laneOff = LANE_OFF;
    // patrol / leave wandering
    this.pFrom = -1; this.pTo = -1;
    // search
    this.searchX = vehicle.position.x; this.searchZ = vehicle.position.z; this.searchT = 0;
    // crew
    this.recalling = false;
    this.recallT = 0;
    this.afterRecall = 'pursue';
    this.wantsCrew = false;
    // drive-by
    this.driveByT = rand(1.5, 3);
    this.driveByShots = 0;
    this.shooter = { kind: 'cop', team: 'police', alive: true, vehicle, position: vehicle.position, velocity: vehicle.velocity, height: 1.8, radius: 0.3 };
    // roadblock
    this.site = null;
    this.removed = false;
    this.lost = false;
    this.chirped = false;
    this.spawnT = this.game.time || 0;
    const pl = this.game.player;
    const pp = pl && pl.position ? (pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position) : null;
    this.distToPlayer = pp ? hdist(vehicle.position, pp) : 999;
    this._attach(vehicle);
  }

  _attach(v) {
    v.ai = this;
    v.driver = this.crew > 0 && this.state !== 'roadblock' ? 'ai' : null;
    v.parked = false;
    v.locked = false;
    v.sirenOn = this.state !== 'patrol';
    v.lightsOverride = null;
    v.persistent = false;
    if (typeof v.wake === 'function') v.wake();
  }

  /** The car exists and can still drive. */
  get carAlive() { const v = this.vehicle; return !!(v && !v.destroyed && !v.removed && v.ai === this); }

  // ============================================================================================ vehicle hooks

  /** Vehicles: the player took the car (or it is being cleaned up). Stop controlling it. */
  release(v) {
    if (v && v !== this.vehicle) return;
    this._detach();
  }

  /** Vehicles: the player is carjacking us. The crew is dragged out angry. */
  onCarjacked(v) {
    if (v !== this.vehicle) return;
    const n = this.crew;
    this.crew = 0;
    for (let i = 0; i < n; i++) {
      const o = this._spawnOfficerAtDoor(i, 'engage');
      if (o && i === 0) { o.setState('knocked'); o.knockT = 0.9; o.afterKnock = 'engage'; }
    }
    this._detach();
  }

  /** Vehicles: we blew up (or sank). Crew inside is lost. */
  onDestroyed(v) {
    if (v !== this.vehicle) return;
    v.policeCrewLost = this.crew;
    const n = this.crew;
    this.crew = 0;
    this.police.onCarCrewKilled(this, n);
    this._detach();
  }

  /** Vehicles: collision with another vehicle. Back off briefly after ramming the player. */
  onCollision(self, other, imp) {
    if (other && other.driver === 'player' && imp > 4) {
      this.backoffT = rand(0.5, 0.9);
      if (imp > 8) this.police.onRam(this, imp);
    }
  }

  _detach() {
    const v = this.vehicle;
    if (!v) return;
    if (v.ai === this) {
      v.ai = null;
      if (v.driver === 'ai') v.driver = null;
      const c = v.controls;
      if (c) { c.throttle = 0; c.steer = 0; c.brake = 1; c.handbrake = false; }
    }
    this.police.stopSiren(this);
    this.vehicle = null;
    this.shooter.alive = false;
    if (!this.lost) { this.lost = true; this.police.onUnitLost(this); }
    for (const o of this.officers) { o.unit = null; if (o.state === 'return') o.setState(this.police.wanted > 0 ? 'engage' : 'leave'); }
    this.officers.length = 0;
    this.recalling = false;
  }

  /** Remove the car from the world (Police despawn). Officers on foot stay. */
  dispose() {
    if (this.removed) return;
    this.removed = true;
    const v = this.vehicle;
    this.lost = true; // a despawn is not a loss
    this.police.stopSiren(this);
    if (v) {
      const playerDriving = v.driver === 'player';
      if (v.ai === this) v.ai = null;
      if (!playerDriving) {
        v.driver = null;
        if (!v.removed && this.game.vehicles && typeof this.game.vehicles.remove === 'function') {
          try { this.game.vehicles.remove(v); } catch (e) { /* ignore */ }
        }
      }
    }
    for (const o of this.officers) o.unit = null;
    this.officers.length = 0;
    this.vehicle = null;
  }

  // ============================================================================================ crew

  /** Door position for crew member i (0 driver, 1 passenger, 2/3 rear doors). Writes out. */
  doorPos(i, out) {
    const v = this.vehicle;
    const side = i % 2 === 0 ? 1 : -1;
    if (typeof v.getDoorPosition === 'function') v.getDoorPosition(out, side, 0.65);
    else {
      const s = Math.sin(v.yaw), c = Math.cos(v.yaw), w = (v.def ? v.def.size.w : 2) / 2 + 0.65;
      out.set(v.position.x + side * w * c, v.position.y, v.position.z - side * w * s);
    }
    if (i >= 2) { out.x -= Math.sin(v.yaw) * 1.6; out.z -= Math.cos(v.yaw) * 1.6; }
    return out;
  }

  /** Where officer o should run to board (closest door). */
  doorPoint(o, out) {
    const v = this.vehicle;
    if (!v) return out.copy(o.position);
    this.doorPos(0, out);
    const ax = out.x, az = out.z;
    this.doorPos(1, out);
    const d0 = (ax - o.position.x) ** 2 + (az - o.position.z) ** 2, d1 = (out.x - o.position.x) ** 2 + (out.z - o.position.z) ** 2;
    if (d0 < d1) out.set(ax, out.y, az);
    return out;
  }

  _spawnOfficerAtDoor(i, state) {
    const v = this.vehicle, g = this.game, w = g.world;
    if (!v) return null;
    this.doorPos(i, _p);
    let y = groundAt(g, _p.x, _p.z, v.position.y + 2);
    if (!(y > 0) || Math.abs(y - v.position.y) > 2.5) y = v.position.y;
    let ok = !w || typeof w.isSolid !== 'function' || !boxCollides(w, _p.x, y + 0.01, _p.z, 0.3, 1.8);
    if (!ok) {
      // try behind / in front of the car, then the roof
      const s = Math.sin(v.yaw), c = Math.cos(v.yaw), hl = (v.def ? v.def.size.l : 4.6) / 2 + 0.8;
      for (const k of [-1, 1]) {
        const x = v.position.x + s * hl * k + (i % 2 ? -0.6 : 0.6) * c, z = v.position.z + c * hl * k - (i % 2 ? -0.6 : 0.6) * s;
        const yy = groundAt(g, x, z, v.position.y + 2);
        if (yy > 0 && !boxCollides(w, x, yy + 0.01, z, 0.3, 1.8)) { _p.set(x, yy, z); y = yy; ok = true; break; }
      }
      if (!ok) { _p.set(v.position.x, v.position.y + (v.def ? v.def.size.h : 1.5) + 0.05, v.position.z); y = _p.y; }
    }
    _p.y = y;
    const yaw = v.yaw + (i % 2 === 0 ? Math.PI / 2 : -Math.PI / 2);
    const o = this.police.spawnOfficer(_p, { swat: this.swat, unit: this, yaw, state });
    if (o) this.officers.push(o);
    return o;
  }

  /** Crew gets out (car parked, light bar keeps flashing). */
  unload(state = 'exit') {
    const v = this.vehicle, g = this.game;
    if (!v || this.crew <= 0) return 0;
    const n = Math.min(this.crew, this.police.footRoom());
    if (n <= 0) return 0;
    // doors open one after another (also spreads the model-building cost over a few frames)
    this._spawnOfficerAtDoor(0, state);
    for (let i = 1; i < n; i++) {
      this.police.defer(0.14 * i + Math.random() * 0.08, () => {
        if (!this.removed && this.vehicle && !this.vehicle.destroyed) this._spawnOfficerAtDoor(i, state);
      });
    }
    this.crew -= n;
    v.driver = this.crew > 0 ? 'ai' : null;
    const c = v.controls;
    c.throttle = 0; c.steer = 0; c.brake = 1; c.handbrake = false;
    this.police.stopSiren(this);
    g.audio?.play?.('car_door', { position: v.position, volume: 0.8 });
    if (n > 1) setTimeout(() => { if (!this.removed) g.audio?.play?.('car_door', { position: v.position, volume: 0.7, pitch: 1.08 }); }, 160);
    this.setState('stopped');
    return n;
  }

  /** Call the crew back to the car; afterwards go to state `next`. */
  recall(next = 'pursue') {
    this.afterRecall = next;
    this.recalling = true;
    this.wantsCrew = true;
    this.recallT = 0;
    for (const o of this.officers) if (o.alive && o.state !== 'knocked') o.setState('return');
    this.setState('recall');
  }

  /** Officer reached the door: climb in. */
  board(o) {
    const i = this.officers.indexOf(o);
    if (i >= 0) this.officers.splice(i, 1);
    o.unit = null;
    o.despawn();
    this.police.forgetOfficer(o);
    this.crew++;
    const v = this.vehicle;
    if (v) this.game.audio?.play?.('car_door', { position: v.position, volume: 0.75, pitch: 0.95 });
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
    this.path.length = 0;
    this.wi = 0;
    this.pathT = 0;
    if (s === 'search') this.searchT = 0;
  }

  // ============================================================================================ frame

  update(dt) {
    const v = this.vehicle;
    this.stateT += dt;
    // forget dead / removed officers
    for (let i = this.officers.length - 1; i >= 0; i--) {
      const o = this.officers[i];
      if (o.removed || !o.alive) { this.officers.splice(i, 1); o.unit = null; }
    }
    if (!v || !this.carAlive) return;
    const pl = this.game.player;
    if (pl && pl.position) {
      const pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
      this.distToPlayer = hdist(v.position, pp);
    }
    this.shooter.position = v.position;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.2 + Math.random() * 0.06;
      this._think();
    }
    this.forceRouteT -= dt;
    this.backoffT -= dt;
    this.avoidT -= dt;
    const driving = v.driver === 'ai' && this.crew > 0 && (this.state === 'pursue' || this.state === 'search' || this.state === 'patrol' || this.state === 'leave');
    if (driving) this._drive(dt);
    else {
      const c = v.controls;
      c.throttle = 0; c.steer = 0; c.brake = 1; c.handbrake = false;
    }
    this._driveBy(dt);
  }

  // ============================================================================================ decisions

  _think() {
    const P = this.police, g = this.game, pl = g.player, v = this.vehicle;
    const alivePlayer = !!(pl && pl.alive !== false && pl.position);
    const pv = alivePlayer && pl.inVehicle && pl.inVehicle.position ? pl.inVehicle : null;
    const pp = alivePlayer ? (pv ? pv.position : pl.position) : null;
    const L = LEVELS[P.wanted] || LEVELS[1];
    this.stopDist = 0;
    this.ramming = false;
    this.allowSlide = false;
    this.laneOff = LANE_OFF;
    this.goalY = pp ? pp.y : v.position.y;
    v.sirenOn = this.state !== 'patrol' && this.state !== 'leave';
    switch (this.state) {
      case 'patrol':
        if (P.wanted > 0) { this.role = 'pursuit'; this.setState('pursue'); P.chirp(this); break; }
        this.desired = this._roadSpeed() * TUNE.PATROL_SPEED_K;
        this._wander(false);
        break;
      case 'pursue': {
        if (P.wanted <= 0 || !alivePlayer) { this.setState('leave'); break; }
        if (P.busting) { this.desired = 0; this.goalX = v.position.x; this.goalZ = v.position.z; this.mode = 'direct'; break; }
        if (!P.knows && !this.sees) { this.setState('search'); break; }
        const d = this.distToPlayer;
        const pvMoving = pv && (speedOf(pv) > 2.5 || pv.isHeli);
        this.pvSlowT = pv && !pvMoving ? (this.pvSlowT || 0) + 0.2 : 0;
        if (pv && this.pvSlowT < 1.6) {
          const ps = speedOf(pv);
          const lead = clamp(d / 30, 0.2, 1.1);
          if (L.ram && d < 35 && this.backoffT <= 0) {
            // ram: aim at where the car will be
            this.goalX = pp.x + pv.velocity.x * lead * 0.6;
            this.goalZ = pp.z + pv.velocity.z * lead * 0.6;
            this.desired = Math.min(L.speed, ps + 10);
            this.ramming = true;
          } else if (d < 35) {
            // tail: a point behind the player's car, offset by slot so the pack spreads out
            const s = Math.sin(pv.yaw), c = Math.cos(pv.yaw);
            const back = 8 + (this.slot % 3) * 4, side = ((this.slot % 2) * 2 - 1) * 2.2;
            this.goalX = pp.x - s * back - c * side + pv.velocity.x * 0.4;
            this.goalZ = pp.z - c * back + s * side + pv.velocity.z * 0.4;
            this.desired = clamp(ps + (d - 9) * 0.6, 6, L.speed);
            if (this.backoffT > 0) this.desired *= 0.6;
          } else {
            this.goalX = pp.x + pv.velocity.x * lead;
            this.goalZ = pp.z + pv.velocity.z * lead;
            this.desired = L.speed;
          }
          this.allowSlide = true;
        } else {
          // on foot (or sitting in a stopped car): pull up ~11 m away, spread around the player by slot
          const dx = v.position.x - pp.x, dz = v.position.z - pp.z, l = Math.hypot(dx, dz) || 1;
          const ang = Math.atan2(dz, dx) + ((this.slot % 4) - 1.5) * 0.42;
          let sx = pp.x + Math.cos(ang) * TUNE.STOP_DIST, sz = pp.z + Math.sin(ang) * TUNE.STOP_DIST;
          if (isWaterAt(g, sx, sz)) { sx = pp.x + (dx / l) * TUNE.STOP_DIST; sz = pp.z + (dz / l) * TUNE.STOP_DIST; }
          this.goalX = sx; this.goalZ = sz;
          this.desired = d > 70 ? L.speed : Math.max(10, L.speed * 0.75);
          this.stopDist = 0.5;
          this.allowSlide = d < 45;
          const slow = Math.abs(v.speed) < 2.5;
          const near = d < TUNE.EXIT_RANGE || (this.stuckCount >= 2 && d < 40);
          if (near && slow && P.footRoom() > 0) { this.unload('exit'); return; }
          if (near && P.footRoom() <= 0) { this.desired = 0; }
        }
        this._chooseMode();
        break;
      }
      case 'search': {
        if (P.wanted <= 0 || !alivePlayer) { this.setState('leave'); break; }
        if (P.knows || this.sees) { this.setState('pursue'); break; }
        this.searchT -= 0.2;
        const dS = Math.hypot(this.searchX - v.position.x, this.searchZ - v.position.z);
        if (this.searchT <= 0 || dS < 12) {
          const r = P.searchRadius();
          const first = this.stateT < 0.3 && Math.hypot(P.lastKnown.x - v.position.x, P.lastKnown.z - v.position.z) > r * 0.5;
          const q = first ? { x: P.lastKnown.x, z: P.lastKnown.z } : (P.roads ? P.roads.searchPoint(P.lastKnown.x, P.lastKnown.z, r * 0.85) : { x: P.lastKnown.x + rand(-r, r) * 0.6, z: P.lastKnown.z + rand(-r, r) * 0.6 });
          this.searchX = q.x; this.searchZ = q.z;
          this.searchT = rand(10, 16);
        }
        this.goalX = this.searchX; this.goalZ = this.searchZ;
        this.desired = Math.hypot(P.lastKnown.x - v.position.x, P.lastKnown.z - v.position.z) > P.searchRadius() ? L.speed * 0.85 : 14;
        this._chooseMode();
        break;
      }
      case 'stopped': {
        const away = this.officers.length === 0;
        if (away) {
          // nobody left outside (killed / joined other units): drive on with whoever is still inside
          if (this.crew > 0) { this.vehicle.driver = 'ai'; this.setState(P.wanted > 0 ? 'pursue' : 'leave'); } else this._detach();
          break;
        }
        if (P.wanted <= 0 || !alivePlayer) { this.recall('leave'); break; }
        if (P.busting) break;
        // the suspect drives off (or runs far): back to the car
        const dCar = this.distToPlayer;
        if ((pv && dCar > TUNE.RETURN_DIST) || (!pv && dCar > 60)) this.recall('pursue');
        else if (!P.knows && this.stateT > 8 && dCar > 30) this.recall('search');
        break;
      }
      case 'recall': {
        this.recallT += 0.2;
        const waiting = this.officers.some((o) => o.alive && !o.removed && o.state === 'return');
        const pursueAgain = P.wanted > 0 && alivePlayer;
        // the suspect came back on foot: abort, fight
        if (pursueAgain && !pv && this.distToPlayer < 14 && this.officers.length) {
          this.recalling = false; this.wantsCrew = false;
          for (const o of this.officers) if (o.state === 'return') o.setState('engage');
          this.setState('stopped');
          break;
        }
        if (!waiting || this.recallT > 9) {
          this.recalling = false; this.wantsCrew = false;
          for (const o of this.officers) { o.unit = null; if (o.state === 'return') o.setState(pursueAgain ? 'engage' : 'leave'); }
          this.officers.length = 0;
          if (this.crew > 0) {
            this.vehicle.driver = 'ai';
            this.setState(pursueAgain ? (this.afterRecall === 'leave' ? 'pursue' : this.afterRecall) : 'leave');
            if (this.role === 'roadblock') this.role = 'pursuit';
          } else this._detach();
        }
        break;
      }
      case 'roadblock': {
        const s = this.site;
        if (P.wanted <= 0 || !alivePlayer) { this.recall('leave'); break; }
        if (P.busting) break;
        if (s && pp) {
          const passed = (pp.x - s.x) * Math.sin(s.yaw) + (pp.z - s.z) * Math.cos(s.yaw);
          if (passed > 30 || this.stateT > TUNE.ROADBLOCK_LIFE || hdist(pp, s) > 170) this.recall(P.needsCars() ? 'pursue' : 'leave');
        }
        break;
      }
      case 'leave': {
        if (P.wanted > 0 && alivePlayer && this.distToPlayer < 150 && P.needsCars()) { this.role = 'pursuit'; this.setState('pursue'); break; }
        this.desired = this._roadSpeed() * 0.9;
        this._wander(true);
        break;
      }
      default: break;
    }
    if (this.state === 'pursue' || this.state === 'search' || this.state === 'patrol' || this.state === 'leave') this._scanObstacles();
  }

  _roadSpeed() {
    const P = this.police, v = this.vehicle;
    const q = P.roads && P.roads.ok ? P.roads.nearest(v.position.x, v.position.z, {}) : null;
    return q && q.geo ? clamp(q.geo.speed, 10, 22) : 14;
  }

  /** Direct pure pursuit when close / in sight (and no water in between), road routing otherwise. */
  _chooseMode() {
    const P = this.police, v = this.vehicle, g = this.game;
    const dGoal = Math.hypot(this.goalX - v.position.x, this.goalZ - v.position.z);
    let direct = !P.roads || !P.roads.ok || (this.forceRouteT <= 0 && (dGoal < 12 ||
      ((dGoal < TUNE.DIRECT_RANGE || (this.sees && dGoal < 70)) && this._lineDrivable())));
    if (direct && P.roads && P.roads.ok) {
      // no water on the straight line
      const steps = Math.min(12, Math.ceil(dGoal / 6));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (isWaterAt(g, v.position.x + (this.goalX - v.position.x) * t, v.position.z + (this.goalZ - v.position.z) * t)) { direct = false; break; }
      }
      // the goal itself is in water (player swimming): stop at the shore
      if (!direct && isWaterAt(g, this.goalX, this.goalZ)) {
        let lx = v.position.x, lz = v.position.z;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = v.position.x + (this.goalX - v.position.x) * t, z = v.position.z + (this.goalZ - v.position.z) * t;
          if (isWaterAt(g, x, z)) break;
          lx = x; lz = z;
        }
        this.goalX = lx; this.goalZ = lz;
        this.stopDist = 3;
        direct = Math.hypot(lx - v.position.x, lz - v.position.z) < TUNE.DIRECT_RANGE;
      }
    }
    if (direct) { this.mode = 'direct'; return; }
    this.mode = 'route';
    this.pathT -= 0.2;
    const moved = Math.hypot(this.goalX - this.pathGoalX, this.goalZ - this.pathGoalZ);
    if (!this.path.length || this.pathT <= 0 || moved > 15) this._replan();
  }

  /** No wall between the car and its goal (tested at bumper and roof height; either clear counts on hills). */
  _lineDrivable() {
    const v = this.vehicle, w = this.game.world;
    const gy = Number.isFinite(this.goalY) ? this.goalY : v.position.y;
    const x0 = v.position.x, y0 = v.position.y, z0 = v.position.z;
    if (losClear(w, x0, y0 + 0.8, z0, this.goalX, gy + 0.8, this.goalZ, SOLID_BLOCKER)) return true;
    return Math.abs(gy - y0) > 2.5 && losClear(w, x0, y0 + 2.2, z0, this.goalX, gy + 2.2, this.goalZ, SOLID_BLOCKER);
  }

  _replan() {
    const P = this.police, v = this.vehicle;
    this.path.length = 0;
    if (P.roads && P.roads.ok) P.roads.route(v.position.x, v.position.z, v.yaw, this.goalX, this.goalZ, this.path);
    else this.path.push(this.goalX, this.goalZ);
    this.wi = 0;
    this.pathT = 3;
    this.pathGoalX = this.goalX; this.pathGoalZ = this.goalZ;
    this._prevX = v.position.x; this._prevZ = v.position.z;
  }

  /** Patrol / leave: lane driving node to node (leave prefers routes away from the player). */
  _wander(away) {
    const P = this.police, v = this.vehicle, R = P.roads;
    this.mode = 'route';
    if (!R || !R.ok) { this.mode = 'direct'; this.goalX = v.position.x + Math.sin(v.yaw) * 30; this.goalZ = v.position.z + Math.cos(v.yaw) * 30; return; }
    if (this.pTo < 0 || !this.path.length) {
      const q = R.nearest(v.position.x, v.position.z, {});
      if (!q) return;
      const g = q.geo;
      const fwd = g.dx * Math.sin(v.yaw) + g.dz * Math.cos(v.yaw) >= 0;
      this.pFrom = fwd ? g.a : g.b; this.pTo = fwd ? g.b : g.a;
      this.path.length = 0;
      this.path.push(R.nodes[this.pTo].x, R.nodes[this.pTo].z);
      this.wi = 0;
      this._prevX = v.position.x; this._prevZ = v.position.z;
      this._extendWander(away);
    }
    // keep two nodes queued ahead
    if (this.path.length - this.wi * 2 < 6) this._extendWander(away);
    const last = this.path.length - 2;
    this.goalX = this.path[last]; this.goalZ = this.path[last + 1];
  }

  _extendWander(away) {
    const R = this.police.roads, pl = this.game.player;
    let nxt = R.patrolNext(this.pTo, this.pFrom);
    if (away && pl && pl.position) {
      // pick the exit that leads away from the player
      let best = nxt, bd = -Infinity;
      for (const e of R.adj[this.pTo] || []) {
        if (e.to === this.pFrom && (R.adj[this.pTo] || []).length > 1) continue;
        const n = R.nodes[e.to];
        const d = Math.hypot(n.x - pl.position.x, n.z - pl.position.z) + Math.random() * 20;
        if (d > bd) { bd = d; best = e.to; }
      }
      nxt = best;
    }
    if (nxt < 0) return;
    this.pFrom = this.pTo; this.pTo = nxt;
    this.path.push(R.nodes[nxt].x, R.nodes[nxt].z);
    // drop waypoints far behind
    if (this.wi >= 3) { this.path.splice(0, 2); this.wi--; }
  }

  /** Vehicles (and officers) in the corridor ahead: brake or swing around them. */
  _scanObstacles() {
    const v = this.vehicle, g = this.game, list = g.vehicles && g.vehicles.list;
    this.obstacleSpeed = Infinity;
    if (!list) return;
    const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
    const spd = Math.max(0, v.speed);
    const reach = 5 + spd * 1.05;
    const hw = (v.def ? v.def.size.w : 2) / 2;
    const pv = g.player && g.player.inVehicle;
    let bestLf = Infinity, side = 0, obSpeed = 0;
    for (const o of list) {
      if (o === v || o.isHeli) continue;
      const dx = o.position.x - v.position.x, dz = o.position.z - v.position.z;
      if (dx * dx + dz * dz > (reach + 6) * (reach + 6)) continue;
      if (Math.abs(o.position.y - v.position.y) > 3) continue;
      const lf = dx * s + dz * c, lr = dx * c - dz * s; // lr > 0: obstacle on our left (local +x)
      if (lf < 0.5 || lf > reach) continue;
      const ow = o.def ? Math.max(o.def.size.w, o.def.size.l * Math.abs(Math.sin(o.yaw - v.yaw))) / 2 : 1;
      if (Math.abs(lr) > hw + ow + 0.5) continue;
      if (o === pv && (this.ramming || this.state === 'pursue')) continue; // that is the target
      if (lf < bestLf) { bestLf = lf; side = lr >= 0 ? -1 : 1; obSpeed = Math.max(0, o.velocity.x * s + o.velocity.z * c); }
    }
    // our own officers / other cops on foot in front of the bumper
    for (const o of this.police.officers) {
      if (!o.alive || o.removed) continue;
      const dx = o.position.x - v.position.x, dz = o.position.z - v.position.z;
      const lf = dx * s + dz * c, lr = dx * c - dz * s;
      if (lf < 0.5 || lf > Math.min(reach, 14) || Math.abs(lr) > hw + 0.9) continue;
      if (lf < bestLf) { bestLf = lf; side = lr >= 0 ? -1 : 1; obSpeed = 0; }
    }
    if (bestLf === Infinity) return;
    const pursuing = this.state === 'pursue' || this.state === 'search';
    if (pursuing && bestLf > 5) {
      // weave around (cops use the oncoming lane)
      this.avoidSide = side;
      this.avoidT = 0.9;
      this.obstacleSpeed = obSpeed + (bestLf - 3) * 1.2;
    } else if (pursuing && bestLf > 2.6) {
      // too close to swerve at speed: creep past it on the other side
      this.avoidSide = side;
      this.avoidT = 1.0;
      this.obstacleSpeed = Math.max(obSpeed, 3.2);
    } else {
      // patrols queue behind traffic; close obstacles always brake
      this.obstacleSpeed = Math.max(0, obSpeed + (bestLf - 6) * 0.7);
      if (pursuing) { this.avoidSide = side; this.avoidT = 0.6; }
    }
  }

  // ============================================================================================ driving

  /** Look-ahead point along the route (lane-offset to the right). Updates cornerSpeed. Writes _tgt. */
  _pathTarget() {
    const v = this.vehicle, path = this.path;
    const n = path.length >> 1;
    const px = v.position.x, pz = v.position.z;
    this.cornerSpeed = Infinity;
    if (n === 0) { _tgt.x = this.goalX; _tgt.z = this.goalZ; return _tgt; }
    // advance past reached / overshot waypoints
    for (let guard = 0; guard < 4 && this.wi < n - 1; guard++) {
      const wx = path[this.wi * 2], wz = path[this.wi * 2 + 1];
      const ax = this.wi > 0 ? path[this.wi * 2 - 2] : this._prevX ?? px, az = this.wi > 0 ? path[this.wi * 2 - 1] : this._prevZ ?? pz;
      const sx = wx - ax, sz = wz - az, sl = Math.hypot(sx, sz) || 1;
      const t = ((px - ax) * sx + (pz - az) * sz) / sl;
      if (Math.hypot(wx - px, wz - pz) < 4.5 || t > sl - 1.0) this.wi++;
      else break;
    }
    // project onto the current segment and walk the look-ahead distance
    const L = clamp(6 + Math.abs(v.speed) * 0.55, 7, 22);
    let i = this.wi;
    let ax = i > 0 ? path[i * 2 - 2] : (this._prevX ?? px), az = i > 0 ? path[i * 2 - 1] : (this._prevZ ?? pz);
    let bx = path[i * 2], bz = path[i * 2 + 1];
    let sx = bx - ax, sz = bz - az, sl = Math.hypot(sx, sz) || 1;
    let t = clamp(((px - ax) * sx + (pz - az) * sz) / sl, 0, sl);
    let remain = L;
    let ux = sx / sl, uz = sz / sl;
    let qx = ax + ux * t, qz = az + uz * t;
    while (remain > 0) {
      const left = sl - t;
      if (remain <= left || i >= n - 1) { qx += ux * remain; qz += uz * remain; break; }
      remain -= left;
      i++;
      ax = bx; az = bz; bx = path[i * 2]; bz = path[i * 2 + 1];
      sx = bx - ax; sz = bz - az; sl = Math.hypot(sx, sz) || 1; ux = sx / sl; uz = sz / sl; t = 0;
      qx = ax; qz = az;
    }
    const lastSeg = i >= n - 1;
    const off = lastSeg && this.state === 'pursue' ? 0 : this.laneOff;
    // direction of the segment we are on (heading misalignment limits speed through turns)
    {
      const ci = Math.min(this.wi, n - 1);
      const cax = ci > 0 ? path[ci * 2 - 2] : (this._prevX ?? px), caz = ci > 0 ? path[ci * 2 - 1] : (this._prevZ ?? pz);
      const cdx = path[ci * 2] - cax, cdz = path[ci * 2 + 1] - caz, cl = Math.hypot(cdx, cdz);
      if (cl > 3) { this.segUx = cdx / cl; this.segUz = cdz / cl; } else { this.segUx = 0; this.segUz = 0; }
    }
    _tgt.x = qx - uz * off;
    _tgt.z = qz + ux * off;
    // corner ahead: slow down for turns at the current waypoint
    if (this.wi < n - 1) {
      const wx = path[this.wi * 2], wz = path[this.wi * 2 + 1];
      const nx = path[this.wi * 2 + 2], nz = path[this.wi * 2 + 3];
      const pax = this.wi > 0 ? path[this.wi * 2 - 2] : px, paz = this.wi > 0 ? path[this.wi * 2 - 1] : pz;
      const d1x = wx - pax, d1z = wz - paz, d2x = nx - wx, d2z = nz - wz;
      const l1 = Math.hypot(d1x, d1z) || 1, l2 = Math.hypot(d2x, d2z) || 1;
      const cosT = (d1x * d2x + d1z * d2z) / (l1 * l2);
      if (cosT < 0.85) {
        const turn = Math.acos(clamp(cosT, -1, 1));
        const vt = lerp(this.desired, TUNE.TURN_SPEED, clamp(turn / (Math.PI / 2), 0, 1)) * (turn > 2 ? 0.6 : 1);
        const dc = Math.hypot(wx - px, wz - pz);
        this.cornerSpeed = Math.sqrt(vt * vt + 2 * 13 * Math.max(0, dc - 7));
      }
    }
    return _tgt;
  }

  _drive(dt) {
    const v = this.vehicle, c = v.controls;
    const speed = v.speed;
    // stuck recovery: reverse arc swinging the nose toward the goal
    if (this.revT > 0) {
      this.revT -= dt;
      c.throttle = -1; c.brake = 0; c.handbrake = false; c.steer = this.revSteer;
      if (this.revT <= 0) { this.forceRouteT = this.stuckCount >= 2 ? 4 : 0; if (this.mode === 'route') this._replan(); }
      return;
    }
    let tx, tz;
    if (this.mode === 'direct') { tx = this.goalX; tz = this.goalZ; this.cornerSpeed = Infinity; }
    else { const q = this._pathTarget(); tx = q.x; tz = q.z; }
    const px = v.position.x, pz = v.position.z;
    if (this.avoidT > 0 && this.avoidSide !== 0) {
      // shift the aim point sideways (local +x is the car's left)
      const s = Math.sin(v.yaw), co = Math.cos(v.yaw), k = 3.4 * this.avoidSide;
      tx += co * k; tz -= s * k;
    }
    const want = Math.atan2(tx - px, tz - pz);
    const err = angleDiff(v.yaw, want);
    const ae = Math.abs(err);
    const goalDist = Math.hypot(this.goalX - px, this.goalZ - pz);
    let desired = this.desired;
    if (this.stopDist > 0) desired = Math.min(desired, Math.sqrt(Math.max(0, goalDist - this.stopDist) * 2 * 8.5));
    desired = Math.min(desired, this.cornerSpeed, this.obstacleSpeed);
    desired = Math.min(desired, lerp(desired, 5.5, smoothstep(0.3, 1.4, ae)));
    // still turning onto the current road: hold corner speed until lined up with it
    if (this.mode === 'route' && (this.segUx || this.segUz)) {
      const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
      const mis = Math.acos(clamp(sy * this.segUx + cy * this.segUz, -1, 1));
      if (mis > 0.35) desired = Math.min(desired, lerp(desired, TUNE.TURN_SPEED * 0.9, clamp((mis - 0.35) / 0.9, 0, 1)));
    }
    if (this.backoffT > 0 && this.ramming) desired = Math.min(desired, Math.max(0, speed - 4));
    // water just ahead: hard stop and take the roads
    const s = Math.sin(v.yaw), co = Math.cos(v.yaw);
    const look = 6 + Math.max(0, speed) * 0.6;
    if (isWaterAt(this.game, px + s * look, pz + co * look)) {
      desired = 0;
      if (this.mode === 'direct') { this.forceRouteT = 4; }
    }
    let steer = -err * 2.3 + (v.yawRate || 0) * 0.12;
    c.steer = clamp(steer, -1, 1);
    c.handbrake = false;
    if (speed > desired + 1.2) {
      c.throttle = 0;
      c.brake = clamp((speed - desired) / 5, 0.25, 1);
    } else {
      c.throttle = clamp((desired - speed) / 3 + 0.25, 0.15, 1);
      c.brake = 0;
    }
    if (desired < 0.4 && Math.abs(speed) < 0.8) { c.throttle = 0; c.brake = 1; }
    // power slide into sharp corners when chasing close (looks great, turns tight)
    if (this.allowSlide && this.mode === 'direct' && ae > 1.25 && speed > 12) {
      c.handbrake = true;
      c.throttle = 0.55;
      c.brake = 0;
    }
    // jammed behind traffic / other cruisers: bail out near the suspect, otherwise back up and go around
    if (this.obstacleSpeed < 1.5 && this.desired > 4) this.blockT = (this.blockT || 0) + dt;
    else this.blockT = Math.max(0, (this.blockT || 0) - dt);
    if (this.blockT > 2.6) {
      this.blockT = 0;
      const pl = this.game.player;
      const onFootNear = pl && !pl.inVehicle && this.distToPlayer < 35;
      if ((this.state === 'pursue' || this.state === 'search') && onFootNear && this.police.footRoom() > 0 && this.police.wanted > 0) { this.unload('exit'); return; }
      this.revT = rand(0.8, 1.2);
      this.revSteer = this.avoidSide || (Math.random() < 0.5 ? 1 : -1);
      this.avoidT = 2.2;
      return;
    }
    // stuck detection
    const wantMove = desired > 2.5 && c.throttle > 0.2;
    if (wantMove && Math.abs(speed) < 1.0) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    this.stuckWindowT -= dt;
    if (this.stuckWindowT <= 0) { this.stuckCount = 0; }
    if (this.stuckT > 1.1) {
      this.stuckT = 0;
      this.revT = rand(0.9, 1.5);
      this.revSteer = err > 0 ? 1 : -1;
      this.stuckCount++;
      this.stuckWindowT = 20;
      if (this.stuckCount >= 5) this.police.onUnitHopeless(this);
    }
  }

  // ============================================================================================ drive-by

  _driveBy(dt) {
    const P = this.police, v = this.vehicle, g = this.game, pl = g.player;
    if (!v || this.state !== 'pursue' || this.crew < 2 || P.policy !== 'shoot') return;
    const L = LEVELS[P.wanted];
    if (!L || !L.driveBy || !this.sees || this.distToPlayer > 32 || this.distToPlayer < 4) return;
    this.driveByT -= dt;
    if (this.driveByT > 0) return;
    if (this.driveByShots <= 0) this.driveByShots = chance(0.5) ? 2 : 1;
    this.driveByShots--;
    this.driveByT = this.driveByShots > 0 ? 0.25 : rand(1.6, 2.8);
    // lean out of the window on the side facing the player
    const pp = pl.inVehicle ? pl.inVehicle.position : pl.position;
    const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
    const lr = (pp.x - v.position.x) * c - (pp.z - v.position.z) * s; // + = player on our left (local +x)
    const side = lr >= 0 ? 1 : -1;
    const w = (v.def ? v.def.size.w : 2) / 2 + 0.2;
    v.localToWorld ? v.localToWorld(side * w, 1.25, 0.2, _o) : _o.set(v.position.x, v.position.y + 1.25, v.position.z);
    aimShot(_o, pl, true, _dir);
    if (P.friendlyInLine(_o, _dir, this.distToPlayer, null, v)) return;
    if (!P.rollHit(P.shotHitChance(null, this.distToPlayer, 1.5) * 0.55)) aimShot(_o, pl, false, _dir);
    try { g.combat?.fire?.(this.shooter, _o, _dir, 'pistol'); } catch (e) { /* combat stub */ }
  }
}

