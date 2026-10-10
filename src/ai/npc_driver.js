// TrafficDriver: the AI brain of one traffic car (vehicle.ai). Drives only through vehicle.controls (§4.3).
// NPC agent. Owned by Traffic (src/ai/traffic.js).
//
// States:  drive    follow the lane route (pure pursuit), obey speed limits, slow for turns, yield at junctions,
//                   keep distance to anything ahead (cars, the player, peds), honk when blocked, overtake/lane-change
//          reverse  stuck recovery: back up with opposite steer, then re-path onto the nearest lane
//          stopped  hopeless / driver leaving: brake and wait (Traffic despawns it when out of sight)
// Panic (panicT > 0) is a modifier of 'drive': full throttle away from the danger, ignores right of way.
import * as THREE from 'three';
import { clamp } from '../core/math.js';
import { randomLook } from '../entities/humanoid.js';
import { nearestLane } from './nav.js';
import { isVisible, rand, chance } from './npc_util.js';

const _s = { x: 0, z: 0, tx: 0, tz: 0 };
const _s2 = { x: 0, z: 0, tx: 0, tz: 0 };
const _p = { s: 0, d: 0 };
const _nl = { lane: null, s: 0, d: 0 };
const _v = new THREE.Vector3();
const _q = [];

const COMFORT_DECEL = 3.6;   // m/s^2 used to plan slowing for turns / stop lines
const FOLLOW_DECEL = 4.5;    // m/s^2 assumed when computing safe following speed

/** People cars must never drive into (alive, not hidden). */
export function humanFilter(e) {
  return (e.kind === 'ped' || e.kind === 'cop' || e.kind === 'player') && e.alive !== false && !e.hidden;
}

export class TrafficDriver {
  /**
   * @param {Traffic} traffic owner system
   * @param {Vehicle} vehicle the car
   * @param {object} lane starting lane (nav.lanes entry)
   * @param {number} s arc length along the lane
   */
  constructor(traffic, vehicle, lane, s, opts = {}) {
    this.traffic = traffic;
    this.game = traffic.game;
    this.vehicle = vehicle;
    this.look = opts.look || randomLook();
    this.state = 'drive';
    this.released = false;
    this.route = [lane];
    this.s = s;
    this.lat = 0;
    /** personal speed factor (some drive faster) */
    // minimum turning radius at walking pace (bicycle model): buses / trucks cannot take tight right turns
    const d0 = vehicle.def || {};
    this.minRadius = (d0.wheelbase || 2.7) / Math.tan(Math.max(0.2, (d0.steer || 0.6) / 1.1));
    this.aggr = rand(0.88, 1.08) * (vehicle.type === 'taxi' ? 1.06 : vehicle.type === 'bus' || vehicle.type === 'truck' ? 0.85 : vehicle.type === 'sports' || vehicle.type === 'muscle' ? 1.08 : 1);
    this.vTarget = 0;
    this.vLimitDbg = 0;
    this.thinkT = Math.random() * 0.1;
    this.thinkDt = 0.1;
    // obstacle
    this.obsGap = Infinity; this.obsSpeed = 0; this.obsLat = 0; this.obsAcross = 0; this.obsRef = null; this.obsHuman = false;
    this.vFollow = Infinity;
    // timers / counters
    this.blockedT = 0; this.honkCd = rand(0, 1); this.stuckT = 0; this.reverseT = 0; this.revSteer = 1;
    this.stuckCount = 0; this.stuckDecay = 0; this.offPathT = 0; this.stoppedT = 0;
    this.panicT = 0; this.panicX = 0; this.panicZ = 0;
    this.latOffset = 0; this.latTarget = 0; this.overtakeT = 0; this.pullOverT = 0;
    this.lastSteer = 0;
    this.staticObsT = 0; this.staticRef = null; this.staticTryT = -9; // parked / abandoned car in the lane
    this.obsInLane = false;          // the obstacle sits in our lane corridor (not only in a manoeuvre's path)
    this.revThen = null;             // after reversing: 'pass' = try to go around what blocked us
    this.revCheckT = 0; this.bumpT = 0;
    this.passT = 0;                  // going around a static obstacle: tighter steering (short look-ahead)
    this.holdRef = null;             // backed off from this obstacle: wait ~6 m behind it (room to swing out)
    this.holdUntil = 0;
    this.ramCd = 0;
    this.exitT = -1; this.exitMood = null;
    // junction right of way
    this.arriveNode = -1; this.arriveT = 0; this.waitAxis = 0; this.resNode = -1; this.resConn = null; this.resT = 0;
    this.yielding = false; this.waitT = 0; this.queued = false; this.waitNode = -1;
    this.spawnT = this.game.time;
    this.traffic.nav && this.ensureRoute();
  }

  // ============================================================================================ contract hooks

  /** Vehicles calls this when the player steals the car: the driver is pulled out and flees or fights. */
  onCarjacked(vehicle) {
    if (this.released) return;
    const mood = chance(0.7) ? 'flee' : 'fight';
    this.traffic.spawnDriverPed(this, vehicle || this.vehicle, mood, { knocked: chance(0.55), jacked: true });
    this.release();
  }

  /** Stop controlling the car (vehicles takes over / the driver left). Safe to call twice. */
  release() {
    if (this.released) return;
    this.released = true;
    this.state = 'released';
    this.traffic.leaveJunctions(this);
  }

  /** Optional hook from Vehicles: vehicle-vehicle impact (imp ~ m/s). */
  onCollision(self, other, imp) {
    if (this.released || imp < 2.5) return;
    if (other && other.ai instanceof TrafficDriver && (self.id || 0) < (other.id || 0)) {
      const st = this.traffic._stats;
      st.aiCrashes = (st.aiCrashes || 0) + 1;
      st.lastCrash = { x: +self.position.x.toFixed(1), z: +self.position.z.toFixed(1), imp: +imp.toFixed(1), a: this.route[0].kind, b: other.ai.route[0].kind, ya: this.yielding, rn: this.resNode, rnb: other.ai.resNode };
    }
    const g = this.game;
    const byPlayer = other && (other.driver === 'player' || (g.vehicles && g.vehicles.playerVehicle === other));
    if (byPlayer) this.rammedByPlayer(imp, other);
    else if (imp > 6 && this.ramCd <= 0) { this.ramCd = 2; this.honk(0.6); }
  }

  /** Optional hook from Vehicles: our car blew up (driver dies with it). */
  onDestroyed() { this.release(); }

  // ============================================================================================ reactions

  rammedByPlayer(imp, other) {
    if (this.ramCd > 0 || this.exitT >= 0) return;
    this.ramCd = 3.5;
    if (chance(0.2) && Math.abs(this.vehicle.speed) < 12) {
      // the driver has had enough: stop and get out to fight
      this.exitT = 0.9;
      this.exitMood = 'fight';
      this.state = 'stopped';
      this.honk(0.9);
    } else {
      this.honk(imp > 8 ? 1.2 : 0.7);
      if (chance(0.35)) this.panic(other ? other.position.x : this.vehicle.position.x, other ? other.position.z : this.vehicle.position.z, rand(4, 7));
    }
  }

  /** Flee from (x, z) for `dur` seconds: full throttle, ignore right of way, honk. */
  panic(x, z, dur = rand(8, 12)) {
    if (this.released) return;
    const was = this.panicT > 0;
    this.panicT = Math.max(this.panicT, dur);
    this.panicX = x; this.panicZ = z;
    if (this.state === 'stopped' && this.exitT < 0 && this.stuckCount < 3) this.state = 'drive';
    if (!was) {
      this.honk(rand(0.5, 1.2));
      // re-plan the exits ahead so the route leads away from the danger
      if (this.route.length > 2) this.route.length = this.route[0].kind === 'lane' ? 1 : 2;
      this.ensureRoute();
    }
  }

  honk(seconds = 0.5) {
    const v = this.vehicle;
    if (typeof v.honk === 'function') v.honk(seconds);
    else this.game.audio?.play?.('horn', { position: v.position, volume: 0.8 });
  }

  // ============================================================================================ route

  /** Distance from the car to the end of the current route (m). */
  routeRemaining() {
    let t = -this.s;
    for (const p of this.route) t += p.len;
    return t;
  }

  /** Sample the route at arc length `s` measured from the start of route[0] (extrapolates past the end). */
  routeSample(s, out) {
    const r = this.route;
    let i = 0;
    while (i < r.length - 1 && s > r[i].len) { s -= r[i].len; i++; }
    return r[i].path.sample(s, out);
  }

  /** Route piece (lane or connection) at distance s along the route. */
  routePieceAt(s) {
    const r = this.route;
    let i = 0;
    while (i < r.length - 1 && s > r[i].len) { s -= r[i].len; i++; }
    return r[i];
  }

  ensureRoute() {
    const r = this.route;
    let total = this.routeRemaining();
    while ((total < 80 || r.length < 3) && r.length < 8) {
      const last = r[r.length - 1];
      if (last.kind === 'conn') { r.push(last.to); total += last.to.len; continue; }
      const c = this.pickConn(last);
      if (!c) break;
      r.push(c);
      total += c.len;
    }
  }

  pickConn(lane) {
    const opts = lane.out;
    if (!opts.length) return null;
    const v = this.vehicle, p = this.game.player;
    let bx = 0, bz = 0, bias = 0;
    if (this.panicT > 0) {
      bx = v.position.x - this.panicX; bz = v.position.z - this.panicZ;
      const l = Math.hypot(bx, bz) || 1; bx /= l; bz /= l; bias = 2.5;
    } else if (p) {
      // keep the city alive around the player: far cars prefer to head back toward them
      bx = p.position.x - v.position.x; bz = p.position.z - v.position.z;
      const l = Math.hypot(bx, bz) || 1;
      bias = l > 40 ? 1.0 : 0; bx /= l; bz /= l;
    }
    let total = 0;
    const w = _q;
    w.length = 0;
    for (const c of opts) {
      let k = c.turn === 'straight' ? 1.0 : c.turn === 'right' ? 0.75 : 0.65;
      if (c.to.deadEnd) k *= 0.01;
      if (bias) k *= Math.max(0.05, 1 + bias * (c.to.dx * bx + c.to.dz * bz));
      // too tight for this wheelbase (buses / trucks): only when there is no other way
      if (c.turn !== 'straight' && c.radius < this.minRadius * 0.9) k *= c.radius < this.minRadius * 0.6 ? 0.001 : 0.02;
      w.push(k);
      total += k;
    }
    let roll = Math.random() * total;
    for (let i = 0; i < opts.length; i++) { roll -= w[i]; if (roll <= 0) return opts[i]; }
    return opts[opts.length - 1];
  }

  /** Switch to a parallel lane (same road + direction). Returns true if done. */
  laneChange(force = false) {
    const cur = this.route[0];
    if (cur.kind !== 'lane' || cur.siblings.length < 2) return false;
    const rem = cur.len - this.s;
    if (rem < 18 && !force) return false;
    const opts = cur.siblings.filter((l) => l !== cur);
    const target = opts[Math.floor(Math.random() * opts.length)];
    if (!this.traffic.laneClear(this, target, this.s)) return false;
    // never cut across people: the sideways move must keep clear of everyone on the way
    if (!this.traffic.swerveClear(this, this.lat, target.offset - cur.offset, 30)) return false;
    this.route.length = 0;
    this.route.push(target);
    this.traffic.leaveJunctions(this);
    this.ensureRoute();
    return true;
  }

  /** Snap onto the nearest lane matching our heading (after being pushed around / reversing). */
  repath() {
    const v = this.vehicle;
    const nl = nearestLane(this.traffic.nav, v.position.x, v.position.z, v.yaw, 25, _nl)
      || nearestLane(this.traffic.nav, v.position.x, v.position.z, null, 25, _nl);
    if (!nl) return false;
    this.traffic.leaveJunctions(this);
    this.route.length = 0;
    this.route.push(nl.lane);
    this.s = nl.s;
    this.latOffset = this.latTarget = 0;
    this.ensureRoute();
    return true;
  }

  // ============================================================================================ per frame

  /** Called by Traffic every frame while the driver controls the car. */
  update(dt, near) {
    const v = this.vehicle, g = this.game;
    if (this.released) return;
    this.ramCd -= dt; this.honkCd -= dt;
    if (this.panicT > 0) this.panicT -= dt;
    this.advance();
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkDt = near ? 0.1 : 0.25;
      this.thinkT = this.thinkDt;
      this.think(this.thinkDt);
      if (this.released) return;
    }
    // the driver getting out (rammed): stop first, then step out
    if (this.exitT >= 0) {
      this.exitT -= dt;
      if (this.exitT < 0 && Math.abs(v.speed) < 1.5) {
        this.traffic.spawnDriverPed(this, v, this.exitMood || 'fight', { homeVehicle: v });
        this.release();
        v.controls.throttle = 0; v.controls.brake = 1; v.controls.steer = 0;
        return;
      }
      if (this.exitT < 0) this.exitT = 0.05;
    }
    this.control(dt, g);
  }

  /** Track progress along the route (projection), shifting finished pieces. */
  advance() {
    const v = this.vehicle, r = this.route;
    let piece = r[0];
    piece.path.project(v.position.x, v.position.z, _p);
    while (_p.s >= piece.len - 0.05 && r.length > 1) {
      this.onLeave(piece);
      r.shift();
      piece = r[0];
      piece.path.project(v.position.x, v.position.z, _p);
      this.onEnter(piece);
    }
    this.s = _p.s;
    this.lat = _p.d;
    this.ensureRoute();
  }

  onLeave(piece) {
    if (piece.kind === 'conn' && this.resNode === piece.node) this.traffic.unreserve(this);
  }

  onEnter(piece) {
    if (piece.kind === 'conn') {
      // entering the junction box without a reservation (e.g. panicking): claim it now
      if (this.traffic.nav.junctions[piece.node].junction && this.resNode !== piece.node) this.traffic.reserve(this, piece);
      this.traffic.leaveWaiting(this);
    } else if (piece.kind === 'lane') {
      this.arriveNode = -1;
      this.waitT = 0;
      // spread traffic over multi-lane roads
      if (piece.siblings.length > 1 && piece.len > 28 && this.panicT <= 0 && chance(0.3)) this.laneChange();
    }
  }

  // ============================================================================================ decisions

  think(tdt) {
    const g = this.game, v = this.vehicle, def = v.def, tr = this.traffic;
    const speed = v.speed;
    const panic = this.panicT > 0;
    if (this.state === 'reverse' || this.state === 'released') return;
    const halfL = def.size.l / 2;

    if (this.state === 'stopped') {
      this.vTarget = 0;
      // hopeless cars vanish once nobody is looking
      if (this.exitT < 0 && !isVisible(g, v.position.x, v.position.y + 1, v.position.z, 4)) tr.despawn(this);
      return;
    }

    // ---- 1. speed limit / current piece
    const cur = this.route[0];
    let vLimit = cur.kind === 'conn' && cur.turn !== 'straight' ? cur.speed * (panic ? 1.35 : 1) : cur.speed * this.aggr;
    if (panic) vLimit = Math.max(vLimit, def.maxSpeed * 0.82);
    vLimit = Math.min(vLimit, def.maxSpeed * 0.95);
    if (cur.kind === 'lane' && this.s < 0) vLimit = Math.min(vLimit, 6 + -this.s * 0.5); // still merging onto the lane

    // ---- 2. slow down for turns ahead
    let vCurve = Infinity;
    {
      let d = cur.len - this.s;
      for (let i = 1; i < this.route.length && d < 90; i++) {
        const p = this.route[i];
        if (p.kind === 'conn' && p.turn !== 'straight') {
          const vt = Math.min(p.speed, p.radius < this.minRadius ? 4 : 99) * (panic ? 1.35 : 1);
          const va = Math.sqrt(vt * vt + 2 * COMFORT_DECEL * Math.max(0, d - halfL * 0.5));
          if (va < vCurve) vCurve = va;
        }
        d += p.len;
      }
      // end of the route (dead end): stop
      const rem = this.routeRemaining();
      if (this.route[this.route.length - 1].kind === 'lane' && this.route[this.route.length - 1].out.length === 0) {
        vCurve = Math.min(vCurve, Math.sqrt(2 * COMFORT_DECEL * Math.max(0, rem - halfL - 1)));
      }
    }

    // ---- obstacles ahead (cars, player, peds): needed by the right-of-way logic too
    this.scanObstacles(panic);

    // ---- 3. right of way at the next junction
    let vYield = Infinity, stopD = Infinity;
    this.yielding = false;
    if (cur.kind === 'lane' && this.route.length > 1 && this.route[1].kind === 'conn') {
      const conn = this.route[1];
      const j = tr.nav.junctions[conn.node];
      const distEnd = cur.len - this.s;
      if (j.junction && this.resNode !== conn.node && distEnd < 32) {
        if (this.arriveNode !== conn.node) {
          this.arriveNode = conn.node;
          this.arriveT = g.time;
          this.waitAxis = conn.from.axis;
          this.waitT = 0;
          tr.addWaiting(this, conn.node);
        }
        stopD = distEnd - halfL - 0.3;
        const brakeD = speed > 0 ? (speed * speed) / (2 * 6.5) : 0;
        const committed = stopD < Math.max(0.4, brakeD * 0.7);
        // front of the queue = nothing (car) between us and the stop line; only those take part in "first come"
        this.queued = !!(this.obsRef && !this.obsHuman && this.obsGap < stopD + 1.5);
        // after a long wait the arrival order is ignored, but never a crossing car inside the box
        const free = panic || tr.canEnter(this, j, conn, this.waitT > 5);
        if (free) {
          if (stopD < 2 + Math.max(0, speed) * 0.7) tr.reserve(this, conn);
        } else if (stopD < -2.5) {
          tr.reserve(this, conn); // overshot past the crosswalk into the box: clear it
        } else {
          if (committed) vYield = 0; // too fast to stop at the line: brake hard (the crosswalk is the margin)
          this.yielding = true;
          vYield = Math.min(vYield, Math.sqrt(2 * 4 * Math.max(0, stopD)));
          if (stopD < 2) vYield = Math.min(vYield, stopD < 0.4 ? 0 : 1.2);
          if (Math.abs(speed) < 0.8 && stopD < 3) this.waitT += tdt;
        }
      }
    }

    // ---- 4. following distance
    let vFollow = Infinity;
    if (this.obsGap < Infinity) {
      const u = Math.max(0, this.obsSpeed);
      const minGap = this.obsHuman ? 2.6 : this.holdRef && this.obsRef === this.holdRef ? 6 : panic ? 1.0 : 2.0;
      const timeGap = panic ? 0.4 : 0.8;
      const desired = minGap + timeGap * Math.max(0, speed);
      const vGap = u + 0.6 * (this.obsGap - desired);
      const vKin = Math.sqrt(u * u + 2 * FOLLOW_DECEL * Math.max(0, this.obsGap - minGap));
      vFollow = Math.max(0, Math.min(vGap, vKin));
      if (this.obsGap < minGap * 0.6) vFollow = 0;
    }
    this.vFollow = vFollow;

    // ---- 5. sirens behind: pull over to the right and let them pass
    if (this.pullOverT > 0) this.pullOverT -= tdt;
    if (!panic && tr.sirenBehind(this)) this.pullOverT = 1.5;
    let vSiren = Infinity;
    if (this.pullOverT > 0) { vSiren = 3.5; if (this.overtakeT <= 0) this.latTarget = cur.kind === 'lane' ? 1.4 : 0; }
    else if (this.overtakeT <= 0) this.latTarget = 0;

    this.vLimitDbg = vLimit;
    this.vTarget = Math.max(0, Math.min(vLimit, vCurve, vYield, vFollow, vSiren));

    // ---- 6. blocked: honk, then go around / change lane. Waiting at a junction does not count, unless the thing in
    // front sits before the stop line (a parked / abandoned car near the corner would otherwise block forever)
    const blocked = vFollow < 1 && this.vTarget < 1 && (!this.yielding || this.obsGap < stopD - 1);
    if (blocked && Math.abs(speed) < 0.8) this.blockedT += tdt;
    else this.blockedT = Math.max(0, this.blockedT - tdt * 2);
    const ref = this.obsRef;
    const playerish = ref && (ref === g.player || ref.driver === 'player');
    if (this.blockedT > (playerish ? 1.3 : panic ? 0.6 : 2.5) && this.honkCd <= 0) {
      this.honk(rand(0.35, 0.9) * (panic ? 1.5 : 1));
      this.honkCd = panic ? rand(0.8, 1.6) : rand(2.5, 4.5);
    }
    if (this.overtakeT > 0) {
      this.overtakeT -= tdt;
      // abort the pass when something comes the other way
      if (ref && ref.yaw !== undefined && !this.obsHuman && this.obsGap < 30 &&
        Math.sin(ref.yaw) * Math.sin(v.yaw) + Math.cos(ref.yaw) * Math.cos(v.yaw) < -0.5) this.overtakeT = 0;
      if (this.overtakeT <= 0) this.latTarget = 0;
    }
    const other = ref && ref.ai instanceof TrafficDriver && !ref.ai.released ? ref.ai : null;
    // ---- a parked / abandoned / broken-down / player car sits in our lane: go around it (early, while still some way
    // back, when nobody is in it; after ~3 s for the player's car); too close to steer around -> back off first
    const staticCar = !!ref && !this.obsHuman && !!ref.def && !ref.isHeli &&
      (!ref.driver || ref.driver === 'player' || (ref.ai instanceof TrafficDriver && ref.ai.state === 'stopped')) &&
      Math.abs(ref.velocity.x) + Math.abs(ref.velocity.z) < 0.5;
    const hr = this.holdRef;
    if (hr && (g.time > this.holdUntil || hr.removed || Math.abs(hr.velocity.x) + Math.abs(hr.velocity.z) > 1)) this.holdRef = null;
    if (!staticCar || ref !== this.staticRef) { this.staticObsT = 0; this.staticTryT = -9; this.staticRef = staticCar ? ref : null; }
    else if (blocked && Math.abs(speed) < 0.8) this.staticObsT += tdt;
    if (staticCar && (this.obsInLane || this.obsGap < 4.5) && this.overtakeT <= 0 && g.time - this.staticTryT >= 1) {
      const patience = ref.driver === 'player' ? 3 : 0.5;
      const early = this.obsInLane && ref.driver !== 'player' && this.obsGap >= 5 && this.obsGap < 30 &&
        (!this.yielding || this.obsGap < stopD - 1);
      if (early || this.staticObsT > patience) {
        this.staticTryT = g.time;
        if (this.obsGap >= 4.5) {
          // only the stretch just past this one car has to be clear on the other side (oncoming traffic is still
          // projected forward by corridorClear)
          const len = ref.def.size ? ref.def.size.l : 5;
          if (this.obsInLane && (this.laneChange(true) || this.tryOvertake(Math.min(42, this.obsGap + len + 6)))) {
            this.blockedT = 0; this.passT = 5; this.holdRef = null;
          }
        } else if (this.staticObsT > patience + 1) { this.backOff(); return; }
      }
    }
    if (this.staticObsT > 9 && this.obsGap < 4.5) { this.backOff(); return; }
    // mutual block (head-on after an overtake, two cars nosed into each other): the one further off its lane,
    // or else the newer one, backs off and re-paths
    if (other && this.blockedT > 2.5 && other.obsRef === v && other.blockedT > 1.5) {
      const mine = Math.abs(this.lat - this.latOffset), theirs = Math.abs(other.lat - other.latOffset);
      if (mine > theirs + 0.3 || (Math.abs(mine - theirs) <= 0.3 && this.spawnT > other.spawnT)) {
        tr._stats.deadlocks = (tr._stats.deadlocks || 0) + 1;
        this.blockedT = 0;
        this.latTarget = 0; this.overtakeT = 0;
        this.startReverse(true);
        return;
      }
    }
    if (this.blockedT > (panic ? 1.5 : 4.5) && this.overtakeT <= 0) {
      const queue = other && other.state === 'drive' && (other.yielding || other.vTarget < 1 || other.blockedT > 0);
      const staticObs = this.obsSpeed < 0.5;
      const playerAhead = this.obsHuman && ref === g.player;
      // (static cars are handled above; vehicles closer than ~4 m cannot be steered around)
      if (!queue && staticObs && !playerAhead && !staticCar && (this.obsHuman || this.obsGap >= 4)) {
        // (both refuse when the sideways move would pass close to a person)
        if (!this.laneChange(true) && !this.tryOvertake() && this.obsHuman && this.blockedT > 7.5) {
          // someone stands in the lane right in front of us: back off first to make room for a wide berth
          this.backOff();
          return;
        }
      } else if (this.blockedT > 14 && !this.obsHuman) {
        // long jam behind something that never moves: back off and find another way
        this.blockedT = 0;
        this.startReverse(true);
        return;
      }
    }
    // slow vehicle ahead on a multi-lane road: change lanes
    if (!blocked && ref && !this.obsHuman && this.obsGap < 14 && this.obsSpeed < vLimit * 0.55 && cur.kind === 'lane' && chance(0.08)) this.laneChange();

    // ---- 7. stuck detection (throttle on, not moving, nothing in the way)
    const pushing = this.vTarget > 2 && !blocked;
    if (pushing && Math.abs(speed) < 0.5) this.stuckT += tdt; else this.stuckT = Math.max(0, this.stuckT - tdt);
    if (this.stuckDecay > 0) { this.stuckDecay -= tdt; if (this.stuckDecay <= 0) this.stuckCount = 0; }
    if (this.stuckT > 2.2) this.startReverse();

    // ---- 8. way off the route (pushed / spun out)
    if (Math.abs(this.lat - this.latOffset) > 6.5) this.offPathT += tdt; else this.offPathT = 0;
    if (this.offPathT > 1.8) {
      this.offPathT = 0;
      if (!this.repath()) this.giveUp();
    }
    // fell off the road (water, bridge edge)
    if (v.inWater || v.flooded) this.giveUp();
  }

  /** Pass what is ahead on the left. dist: how far the opposite side must be clear (default 42 m). */
  tryOvertake(dist = 42) {
    const v = this.vehicle;
    const myW = v.def.size.w / 2;
    const off = this.obsLat - (myW + this.obsAcross + 0.8);
    const lat = clamp(off, -5.5, -1.5);
    // corridorClear also refuses when anyone stands near the swerve (people are never driven around closely)
    if (!this.traffic.corridorClear(this, lat, dist)) return false;
    this.latTarget = lat;
    this.overtakeT = rand(4.5, 6);
    this.blockedT = 0;
    this.traffic._stats.overtakes = (this.traffic._stats.overtakes || 0) + 1;
    return true;
  }

  /** Too close behind something we want to pass: reverse straight back a few metres, then go around it. */
  backOff() {
    this.staticObsT = 0; this.staticTryT = -9; this.blockedT = 0;
    this.overtakeT = 0; this.latTarget = 0;
    this.revThen = 'pass';
    if (this.obsRef && !this.obsHuman) { this.holdRef = this.obsRef; this.holdUntil = this.game.time + 20; }
    this.startReverse(true);
    if (this.state === 'reverse') { this.revSteer = 0; this.reverseT = rand(2.1, 2.6); }
  }

  /** Back up with opposite steer, then re-path. soft: a deliberate manoeuvre (counts less toward giving up). */
  startReverse(soft = false) {
    const v = this.vehicle;
    this.stuckT = 0;
    this.stuckCount += soft ? 0.5 : 1;
    this.stuckDecay = 25;
    this.traffic._stats.reverses = (this.traffic._stats.reverses || 0) + 1;
    this.traffic._stats.lastReverse = { x: +v.position.x.toFixed(1), z: +v.position.z.toFixed(1), soft, piece: this.route[0].kind, type: v.type };
    if (this.stuckCount >= 4) { this.giveUp(); return; }
    this.state = 'reverse';
    this.reverseT = rand(1.3, 1.9);
    this.revSteer = -(Math.sign(this.lastSteer) || (Math.random() < 0.5 ? 1 : -1));
    this.traffic.leaveJunctions(this);
    if (Math.abs(v.speed) < 0.5 && this.honkCd <= 0) { this.honk(0.4); this.honkCd = 3; }
  }

  /** Something (a person or a vehicle) right behind the rear bumper: stop reversing. */
  rearBlocked() {
    const g = this.game, v = this.vehicle, def = v.def;
    const halfL = def.size.l / 2, halfW = def.size.w / 2;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const list = g.vehicles ? g.vehicles.list : null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === v || o.removed || (o.isHeli && !o.onGround)) continue;
        const rx = o.position.x - v.position.x, rz = o.position.z - v.position.z;
        const back = -(rx * fx + rz * fz);
        if (back < 0 || back > halfL + 9) continue;
        const od = o.def || def;
        const ext = Math.max(od.size.w, od.size.l) / 2;
        if (Math.abs(rx * -fz + rz * fx) > halfW + ext * 0.8) continue;
        if (back - halfL - ext < 0.9) return true;
      }
    }
    const ents = g.entities;
    if (ents && ents.query) {
      _v.set(v.position.x - fx * (halfL + 1.5), v.position.y + 1, v.position.z - fz * (halfL + 1.5));
      const found = ents.query(_v, 2.6, humanFilter, this.traffic._qOut);
      for (let i = 0; i < found.length; i++) {
        const e = found[i];
        const rx = e.position.x - v.position.x, rz = e.position.z - v.position.z;
        if (-(rx * fx + rz * fz) > halfL - 0.5 && Math.abs(rx * -fz + rz * fx) < halfW + 1.2) return true;
      }
    }
    return false;
  }

  /** Vehicles backstop: our car touched the player at low speed. Stop and wait. */
  onBumpedPerson() {
    if (this.released) return;
    this.bumpT = Math.max(this.bumpT, 1.2);
    this.overtakeT = 0; this.latTarget = 0;
    if (this.honkCd <= 0) { this.honk(0.5); this.honkCd = 2.5; }
  }

  /** Hopeless: stop and let Traffic remove the car when nobody watches. */
  giveUp() {
    if (this.state !== 'stopped') this.traffic._stats.giveUps = (this.traffic._stats.giveUps || 0) + 1;
    this.state = 'stopped';
    this.vTarget = 0;
    this.traffic.leaveJunctions(this);
  }

  // ============================================================================================ sensing

  scanObstacles(panic) {
    const g = this.game, v = this.vehicle, def = v.def;
    const px = v.position.x, pz = v.position.z, py = v.position.y;
    const halfL = def.size.l / 2, halfW = def.size.w / 2;
    const speed = Math.max(0, v.speed);
    const range = 12 + speed * 2.4;
    this.obsGap = Infinity; this.obsSpeed = 0; this.obsLat = 0; this.obsAcross = 0; this.obsRef = null; this.obsHuman = false;
    this.obsInLane = false;
    const midMove = Math.abs(this.lat - this.latOffset) > 0.6;
    // heading reference: path tangent here
    this.routeSample(Math.max(0, this.s), _s2);
    const hx = _s2.tx, hz = _s2.tz;
    const latOff = this.latOffset;
    const list = g.vehicles ? g.vehicles.list : null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === v || o.removed) continue;
        if (o.isHeli && !o.onGround) continue;
        const rx = o.position.x - px, rz = o.position.z - pz;
        const r2 = rx * rx + rz * rz;
        if (r2 > (range + 7) * (range + 7) || Math.abs(o.position.y - py) > 3.5) continue;
        const along = rx * hx + rz * hz;
        const od = o.def || def;
        const ohl = od.size.l / 2, ohw = od.size.w / 2;
        if (along < -ohl) continue;
        this.routeSample(this.s + Math.max(0, along), _s);
        const lat = (o.position.x - _s.x) * -_s.tz + (o.position.z - _s.z) * _s.tx;
        const c = Math.abs(Math.sin(o.yaw) * _s.tx + Math.cos(o.yaw) * _s.tz);
        const sn = Math.sqrt(Math.max(0, 1 - c * c));
        const across = ohw * c + ohl * sn, alongExt = ohl * c + ohw * sn;
        const gap = along - halfL - alongExt;
        const inLane = Math.abs(lat - latOff) <= halfW + across + 0.35;
        // mid-manoeuvre (lane change / overtake / pulling over): the body is still where it was, so also stop for
        // anything about to be hit by where the car actually is (the swing-out itself is planned by the pass checks)
        if (!inLane && !(midMove && gap < 1.2 && Math.abs(lat - this.lat) <= halfW + across)) continue;
        if (gap < this.obsGap && gap > -halfL) {
          this.obsGap = Math.max(0, gap);
          const ov = o.velocity;
          this.obsSpeed = ov ? ov.x * _s.tx + ov.z * _s.tz : 0;
          this.obsLat = lat; this.obsAcross = across; this.obsRef = o; this.obsHuman = false; this.obsInLane = inLane;
        }
      }
    }
    // people: the swept corridor between the lane offset, where the car actually is and where it is steering to
    // (overtakes / lane changes / pulling over), with a wide margin (never relaxed by panic)
    const ents = g.entities;
    if (ents && ents.query) {
      const look = Math.min(range, 6 + speed * 1.6);
      _v.set(px + hx * look * 0.5, py + 1, pz + hz * look * 0.5);
      const found = ents.query(_v, look * 0.5 + 3, humanFilter, this.traffic._qOut);
      const lo = Math.min(latOff, this.lat, this.latTarget), hi = Math.max(latOff, this.lat, this.latTarget);
      for (let i = 0; i < found.length; i++) {
        const e = found[i];
        const rx = e.position.x - px, rz = e.position.z - pz;
        const along = rx * hx + rz * hz;
        if (along < 0) continue;
        this.routeSample(this.s + along, _s);
        const lat = (e.position.x - _s.x) * -_s.tz + (e.position.z - _s.z) * _s.tx;
        const er = e.radius || 0.3;
        const m = halfW + er + 1.0;
        if (lat < lo - m || lat > hi + m) continue;
        // someone standing on the sidewalk beyond the kerb (right of a lane piece) is not in our way unless they are
        // stepping into the road: without this, a player waiting at the kerb would hold up the kerb lane forever
        const piece = this.routePieceAt(this.s + along);
        if (piece && piece.kind === 'lane' && piece.road && lat > piece.road.width / 2 - piece.offset + 0.1) {
          const ev = e.velocity;
          const vLat = ev ? ev.x * -_s.tz + ev.z * _s.tx : 0; // + = moving away from the road
          if (vLat > -0.5) continue;
        }
        if (panic && e.kind !== 'player' && speed > 8) continue; // panicking drivers plough on (never into the player)
        const gap = along - halfL - er;
        if (gap < this.obsGap) {
          this.obsGap = Math.max(0, gap);
          this.obsSpeed = 0;
          this.obsLat = lat; this.obsAcross = er; this.obsRef = e; this.obsHuman = true; this.obsInLane = true;
        }
      }
    }
  }

  // ============================================================================================ control

  control(dt, g) {
    const v = this.vehicle, c = v.controls, def = v.def;
    c.lift = 0;
    if (this.state === 'reverse') {
      this.reverseT -= dt;
      c.throttle = -0.75; c.brake = 0; c.handbrake = false; c.steer = this.revSteer;
      // never back into someone / something
      this.revCheckT -= dt;
      if (this.revCheckT <= 0) { this.revCheckT = 0.1; if (this.rearBlocked()) this.reverseT = Math.min(this.reverseT, 0); }
      if (this.reverseT <= 0) {
        this.state = 'drive';
        c.throttle = 0; c.brake = 1;
        const pass = this.revThen === 'pass';
        this.revThen = null;
        // after backing off to pass, keep the lane we are in (re-path only when pushed well off it)
        if ((!pass || Math.abs(this.lat - this.latOffset) > 2.5) && !this.repath()) { this.giveUp(); return; }
        if (pass) {
          // now there is room to go around what blocked us
          this.advance();
          this.scanObstacles(this.panicT > 0);
          const ref = this.obsRef;
          const len = !this.obsHuman && ref && ref.def && ref.def.size ? ref.def.size.l : 0;
          if (this.obsGap < 25 && this.obsInLane &&
            (this.laneChange(true) || this.tryOvertake(len ? Math.min(42, this.obsGap + len + 6) : 42))) { this.passT = 5; this.holdRef = null; }
        }
      }
      return;
    }
    if (this.state !== 'drive') {
      c.throttle = 0; c.brake = 1; c.steer = 0; c.handbrake = false;
      return;
    }
    const speed = v.speed, spd = Math.abs(speed);
    // smooth lateral offset (overtaking / pulling over)
    this.latOffset += (this.latTarget - this.latOffset) * Math.min(1, dt * 1.6);

    // ---- pure pursuit
    let L = 6 + 0.6 * spd;
    const r = this.route, cur = r[0];
    const turning = (cur.kind === 'conn' && cur.turn !== 'straight') ||
      (cur.kind === 'lane' && r.length > 1 && r[1].kind === 'conn' && r[1].turn !== 'straight' && cur.len - this.s < L);
    if (turning || this.passT > 0) L = Math.max(3.6, Math.min(L, 3 + 0.45 * spd));
    if (this.passT > 0) this.passT -= dt;
    // (long vehicles are kept off turns tighter than their turning circle by pickConn; in this vehicle model the body
    // pivots about its centre, so they run wide rather than cutting the inside kerb)
    this.routeSample(this.s + L, _s);
    const tx = _s.x - _s.tz * this.latOffset, tz = _s.z + _s.tx * this.latOffset;
    const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
    const dx = tx - v.position.x, dz = tz - v.position.z;
    const lx = -dx * cy + dz * sy;    // right
    const lz = dx * sy + dz * cy;     // forward
    const d2 = Math.max(1, lx * lx + lz * lz);
    let kappa = (2 * lx) / d2;
    if (lz < 0.5) kappa = (Math.sign(lx) || 1) * 0.3;
    const steerMax = (def.steer || 0.6) / (1 + spd / 21);
    let steer = Math.atan(kappa * (def.wheelbase || 2.7)) / steerMax;
    if (speed < -0.5) steer = -steer;
    steer = clamp(steer, -1, 1);
    c.steer = steer;
    this.lastSteer = steer;
    c.handbrake = false;

    // ---- speed
    let vT = this.vTarget;
    // emergency: something suddenly very close ahead (re-check every frame from the last scan)
    if (this.obsGap < 1.2 && speed > 1) vT = 0;
    // just nudged a person (Vehicles backstop): hold still for a moment
    if (this.bumpT > 0) { this.bumpT -= dt; vT = 0; }
    const err = vT - speed;
    if (vT < 0.25) {
      c.throttle = 0;
      c.brake = speed > 0.4 ? clamp(0.35 + speed * 0.08, 0, 1) : 1;
    } else if (err > 0.15) {
      c.throttle = clamp(0.06 + err * 0.32, 0, 1);
      c.brake = 0;
    } else if (err > -0.8) {
      c.throttle = 0.02; c.brake = 0;
    } else {
      c.throttle = 0;
      c.brake = clamp((-err - 0.4) * 0.3, 0, 1);
    }
  }

  /** Short state summary for debugging. */
  debugInfo() {
    const v = this.vehicle;
    return {
      type: v.type, state: this.state, speed: +v.speed.toFixed(1), vTarget: +this.vTarget.toFixed(1), lim: +this.vLimitDbg.toFixed(1),
      gap: Number.isFinite(this.obsGap) ? +this.obsGap.toFixed(1) : null, yielding: this.yielding, panic: this.panicT > 0,
      piece: this.route[0].kind, lat: +this.lat.toFixed(2), x: +v.position.x.toFixed(1), z: +v.position.z.toFixed(1),
    };
  }
}
