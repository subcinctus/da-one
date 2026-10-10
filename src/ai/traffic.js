// Traffic (ARCHITECTURE.md §Traffic, NPC agent): keeps ~18-26 AI cars driving the road network around the player.
//
//   - spawns cars 32-105 m away (inside the fog), out of the camera frustum, never overlapping, on random lanes of
//     nav (src/ai/nav.js; lanes heading toward the player preferred so cars flow past), weighted vehicle types with
//     random colours; denser downtown / midtown; unseen cars beyond 100 m are recycled (hard limit ~168 m)
//   - each car is driven by a TrafficDriver (src/ai/npc_driver.js) through vehicle.controls only
//   - right of way at junctions (first come, first served per crossing axis, with a deadlock timeout)
//   - reactions: gunfire / explosions -> panic; rammed or shot by the player -> honk / angry driver gets out /
//     bails out; carjacked -> the driver ped is spawned at the driver door (peds.spawnPed) and flees or fights
//
// Public API (beyond the contract): cars (active drivers), panicAt(pos, radius), adoptVehicle(vehicle, opts),
// stats(), count. Debug: game.debug.trafficStats(), spawnTraffic(n), carjackNearest(), trafficInfo().
import * as THREE from 'three';
import { VEHICLE_TYPES } from '../vehicles/vehicles.js';
import { randomLook } from '../entities/humanoid.js';
import { boxCollides } from '../core/physics.js';
import { getNav, nearestLane } from './nav.js';
import { TrafficDriver, humanFilter } from './npc_driver.js';
import { runNavSelfTest } from './npc_selftest.js';
import { isVisible, chunkReady, viewRadius, densityScale, weighted, rand, chance } from './npc_util.js';
import { clamp } from '../core/math.js';

const TYPES_CITY = [['sedan', 30], ['taxi', 12], ['van', 10], ['pickup', 9], ['muscle', 8], ['sports', 4], ['truck', 3], ['bus', 3]];
const TYPES_DOWNTOWN = [['sedan', 26], ['taxi', 24], ['van', 9], ['pickup', 5], ['muscle', 6], ['sports', 6], ['truck', 2], ['bus', 5]];
const TYPES_INDUSTRIAL = [['sedan', 18], ['taxi', 3], ['van', 16], ['pickup', 14], ['muscle', 7], ['sports', 2], ['truck', 12], ['bus', 1]];
const TYPES_HIGHWAY = [['sedan', 26], ['taxi', 3], ['van', 10], ['pickup', 16], ['muscle', 9], ['sports', 7], ['truck', 9], ['bus', 1]];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _nl = { lane: null, s: 0, d: 0 };
const _s = { x: 0, z: 0, tx: 0, tz: 0 };

/** Lateral offset after travelling d metres of a smooth (smoothstep) sideways move from a to b over ltr metres. */
function swerveLat(a, b, d, ltr) {
  const u = clamp(d / ltr, 0, 1);
  return a + (b - a) * u * u * (3 - 2 * u);
}

export class Traffic {
  constructor(game) {
    this.game = game;
    /** Active TrafficDrivers (each has .vehicle). */
    this.cars = [];
    /** Vehicles we spawned whose driver left (carjacked / bailed out): removed when far and unseen. */
    this.abandoned = [];
    this.nav = null;
    this.enabled = true;
    this._jst = new Map();      // nodeId -> {occ: TrafficDriver[], wait: TrafficDriver[]}
    this._nearLanes = [];
    this._nearT = 0;
    this._spawnCd = 0;
    this._cleanT = 0;
    this._qOut = [];
    this._qOut2 = [];
    this._looks = [];
    this._stats = { spawned: 0, despawned: 0, failedSpawns: 0, carjacks: 0, angry: 0, bailed: 0, honks: 0 };
    this._initialFill = true;
    this._ms = 0;
    this._msMax = 0;
  }

  init() {
    const g = this.game;
    const plan = g.generator && g.generator.plan;
    if (!plan || !plan.nodes || !plan.roads) return;
    this.nav = getNav(plan);
    for (let i = 0; i < 28; i++) this._looks.push(randomLook());
    const ev = g.events;
    ev.on('gunfire', (e) => { if (e && e.position) this.panicAt(e.position, 40, e.shooter); });
    ev.on('explosion', (e) => { if (e && e.position) this.panicAt(e.position, 42 + (e.radius || 4) * 2, e.source); });
    ev.on('entityDamaged', (e) => this._onDamaged(e));
    ev.on('playerRespawned', () => { this._initialFill = true; });
    this._installDebug();
    // populate right away so the title screen / first frame already has traffic
    try { this._fill(true); } catch (e) { console.warn('[traffic] initial fill failed', e); }
  }

  // ============================================================================================ public API

  /** Number of AI cars currently driving. */
  get count() { return this.cars.length; }

  /** Make every driver within `radius` of `pos` panic (flee at full throttle). */
  panicAt(pos, radius = 40, source = null) {
    const r2 = radius * radius;
    for (const d of this.cars) {
      const v = d.vehicle;
      if (v.ai !== d || d.released) continue;
      const dx = v.position.x - pos.x, dz = v.position.z - pos.z;
      if (dx * dx + dz * dz < r2) d.panic(pos.x, pos.z, rand(7, 11));
    }
  }

  /**
   * Put an AI driver into an existing (driverless) vehicle, e.g. an angry driver returning to their car.
   * opts: {look}. Returns the TrafficDriver or null.
   */
  adoptVehicle(vehicle, opts = {}) {
    const g = this.game;
    if (!this.nav || !vehicle || vehicle.removed || vehicle.destroyed || vehicle.isHeli) return null;
    if (vehicle.driver || vehicle === g.vehicles?.playerVehicle) return null;
    const nl = nearestLane(this.nav, vehicle.position.x, vehicle.position.z, vehicle.yaw, 14, _nl);
    if (!nl) return null;
    const d = new TrafficDriver(this, vehicle, nl.lane, nl.s, { look: opts.look });
    vehicle.ai = d;
    vehicle.driver = 'ai';
    vehicle.parked = false;
    vehicle.wake?.();
    vehicle.setDriverLook?.(d.look);
    this.cars.push(d);
    const i = this.abandoned.indexOf(vehicle);
    if (i >= 0) this.abandoned.splice(i, 1);
    return d;
  }

  stats() {
    let speed = 0, offRoad = 0, panicking = 0, yielding = 0, stopped = 0, reversing = 0;
    const plan = this.game.generator && this.game.generator.plan;
    const types = {};
    for (const d of this.cars) {
      const v = d.vehicle;
      speed += Math.abs(v.speed);
      if (plan && !plan.isRoad(v.position.x, v.position.z)) offRoad++;
      if (d.panicT > 0) panicking++;
      if (d.yielding) yielding++;
      if (d.state === 'stopped') stopped++;
      if (d.state === 'reverse') reversing++;
      types[v.type] = (types[v.type] || 0) + 1;
    }
    const n = this.cars.length;
    return {
      cars: n, target: this._target(), avgSpeed: n ? +(speed / n).toFixed(2) : 0, offRoad, panicking, yielding, stopped, reversing,
      abandoned: this.abandoned.length, types, msAvg: +this._ms.toFixed(3), msMax: +this._msMax.toFixed(2), ...this._stats,
    };
  }

  // ============================================================================================ update

  update(dt) {
    const t0 = performance.now();
    this._update(dt);
    const ms = performance.now() - t0;
    this._ms += (ms - this._ms) * 0.05;
    if (ms > this._msMax) this._msMax = ms;
  }

  _update(dt) {
    const g = this.game;
    if (!this.nav || !this.enabled || !g.vehicles) return;
    const focus = g.player && g.player.position ? g.player.position : g.camera.position;
    const R = viewRadius(g);
    const despawnR = Math.max(130, Math.min(180, R + 40)); // hard limit
    const recycleR = Math.min(100, despawnR - 10);           // unseen cars beyond this are recycled closer in
    const pv = g.vehicles.playerVehicle;

    // ---- drivers
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const d = this.cars[i], v = d.vehicle;
      if (v.removed) { this.cars.splice(i, 1); d.release(); continue; }
      if (d.released || v.ai !== d) {
        this.cars.splice(i, 1);
        d.release();
        if (!v.destroyed && !this.abandoned.includes(v)) this.abandoned.push(v);
        continue;
      }
      if (v.destroyed) { this.cars.splice(i, 1); d.release(); continue; }
      const dx = v.position.x - focus.x, dz = v.position.z - focus.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > despawnR * despawnR || v.position.y < 2) { this.despawn(d); continue; }
      // recycle unseen far cars that are not on their way back toward the player
      if (d2 > recycleR * recycleR && v !== pv && v.velocity.x * dx + v.velocity.z * dz > -2 * Math.sqrt(d2) &&
        !isVisible(g, v.position.x, v.position.y + 1, v.position.z, 4)) { this.despawn(d); continue; }
      // the car is burning / wrecked: the driver bails out and runs
      if ((v.onFire || v.health < v.maxHealth * 0.12) && d.exitT < 0) { this._bailOut(d, 'flee'); continue; }
      d.update(dt, d2 < 90 * 90);
    }

    // ---- abandoned cars (driver got out): remove when far and unseen
    for (let i = this.abandoned.length - 1; i >= 0; i--) {
      const v = this.abandoned[i];
      if (v.removed || v.ai) { this.abandoned.splice(i, 1); continue; }
      if (v.driver === 'player' || v === pv || v.persistent) continue;
      const dx = v.position.x - focus.x, dz = v.position.z - focus.z;
      const d2 = dx * dx + dz * dz;
      const lim = Math.max(90, despawnR * 0.7);
      if (d2 > lim * lim && !isVisible(g, v.position.x, v.position.y + 1, v.position.z, 4)) {
        this.abandoned.splice(i, 1);
        g.vehicles.remove(v);
      }
    }

    // ---- spawning
    this._nearT -= dt;
    if (this._nearT <= 0) { this._nearT = 1.2; this._refreshNearLanes(focus); }
    if (this._initialFill) { this._initialFill = false; this._fill(false); }
    this._spawnCd -= dt;
    if (this._spawnCd <= 0 && this.cars.length < this._target()) {
      const ok = this._trySpawn(focus, false);
      this._spawnCd = ok ? rand(0.25, 0.5) : 0.4;
    }

    // ---- junction bookkeeping
    this._cleanT -= dt;
    if (this._cleanT <= 0) { this._cleanT = 2; this._cleanJunctions(); }
  }

  _target() {
    const g = this.game;
    let n = 18 * densityScale(g);
    const night = g.sky ? g.sky.nightFactor || 0 : 0;
    n *= 1 - 0.25 * night;
    const p = g.player && g.player.position;
    const plan = g.generator && g.generator.plan;
    if (p && plan && plan.isCity && !plan.isCity(p.x, p.z)) n *= 0.6; // sparse countryside highways
    else if (p && plan && plan.districtAt && this._busyNear(p, plan)) n *= 1.4; // busy city centre
    return Math.round(Math.max(6, Math.min(26, n)));
  }

  /** Is the player in / right next to downtown or midtown? (5-point sample, refreshed at most once a second) */
  _busyNear(p, plan) {
    const t = this.game.time || 0;
    if (this._busyT !== undefined && t - this._busyT < 1 && Math.abs(t - this._busyT) < 5) return this._busy;
    this._busyT = t;
    let k = 0;
    for (const [ox, oz] of [[0, 0], [14, 0], [-14, 0], [0, 14], [0, -14]]) {
      const id = plan.districtAt(p.x + ox, p.z + oz)?.id;
      if (id === 'downtown' || id === 'midtown') k++;
    }
    this._busy = k >= 2;
    return this._busy;
  }

  _spawnRange() {
    const R = viewRadius(this.game);
    const rMax = Math.max(44, Math.min(105, R - 4));
    const rMin = Math.min(32, rMax - 12);
    return [rMin, rMax];
  }

  _refreshNearLanes(focus) {
    const [, rMax] = this._spawnRange();
    const out = this._nearLanes;
    out.length = 0;
    for (const l of this.nav.spawnLanes) {
      // distance from the focus to the lane segment
      let t = (focus.x - l.x0) * l.dx + (focus.z - l.z0) * l.dz;
      t = t < 0 ? 0 : t > l.len ? l.len : t;
      const dn = Math.hypot(focus.x - (l.x0 + l.dx * t), focus.z - (l.z0 + l.dz * t));
      if (dn > rMax) continue;
      out.push(l);
    }
  }

  /** Spawn cars until the target count (initial: closer and also in view). */
  _fill(initial) {
    const g = this.game;
    const focus = g.player && g.player.position ? g.player.position : g.camera.position;
    this._refreshNearLanes(focus);
    const want = this._target();
    let guard = 0;
    while (this.cars.length < want && guard++ < want * 3) this._trySpawn(focus, initial ? 'init' : 'fill');
  }

  /** One spawn attempt. mode: false (normal: out of view), 'fill' (any spot >= 30 m), 'init' (>= 22 m). */
  _trySpawn(focus, mode) {
    const g = this.game, lanes = this._nearLanes;
    if (!lanes.length) return false;
    let [rMin, rMax] = this._spawnRange();
    if (mode === 'init') rMin = 22; else if (mode === 'fill') rMin = Math.min(rMin, 34);
    for (let attempt = 0; attempt < 14; attempt++) {
      const lane = lanes[Math.floor(Math.random() * lanes.length)];
      if (lane.len < 8) continue;
      const s = rand(3, Math.max(3.5, lane.len - 6));
      const x = lane.x0 + lane.dx * s, z = lane.z0 + lane.dz * s;
      const d = Math.hypot(x - focus.x, z - focus.z);
      if (d < rMin || d > rMax) continue;
      // lanes heading toward the player get twice the weight: cars flow past instead of away (and the outer band
      // only takes cars heading in, which would otherwise be recycled again right away)
      const away = (focus.x - x) * lane.dx + (focus.z - z) * lane.dz < 0;
      if (away && (d > 92 || Math.random() < 0.5)) continue;
      // and the near ring (out of view) is preferred over the far one
      if (!mode && d > 64 && attempt < 10 && Math.random() < 0.45) continue;
      if (!chunkReady(g, x, z)) continue;
      const y = (g.generator.plan.surfaceY ? g.generator.plan.surfaceY(x, z) : 28);
      if (!mode && attempt < 10 && isVisible(g, x, y + 1, z, 4)) continue;
      const type = this._pickType(lane, x, z);
      const def = VEHICLE_TYPES[type];
      const len = def ? def.size.l : 4.5;
      if (lane.len < len + 4) continue;
      if (!this._spotFree(x, y, z, len)) continue;
      if (this._spawnCar(type, lane, s, x, y, z)) return true;
    }
    this._stats.failedSpawns++;
    return false;
  }

  _pickType(lane, x, z) {
    const plan = this.game.generator.plan;
    if (!lane.city) return weighted(TYPES_HIGHWAY);
    const dist = plan.districtAt ? plan.districtAt(x, z).id : '';
    if (dist === 'downtown' || dist === 'midtown') return weighted(TYPES_DOWNTOWN);
    if (dist === 'industrial' || dist === 'port') return weighted(TYPES_INDUSTRIAL);
    return weighted(TYPES_CITY);
  }

  _spotFree(x, y, z, len) {
    const g = this.game;
    for (const o of g.vehicles.list) {
      const ol = o.def ? o.def.size.l : 5;
      const need = len / 2 + ol / 2 + 3.5;
      const dx = o.position.x - x, dz = o.position.z - z;
      if (dx * dx + dz * dz < need * need && Math.abs(o.position.y - y) < 4) return false;
    }
    _v.set(x, y + 1, z);
    if (g.entities && g.entities.nearest && g.entities.nearest(_v, len / 2 + 2, (e) => e.kind !== 'vehicle' && e.kind !== 'heli')) return false;
    if (g.world && boxCollides(g.world, x, y + 0.3, z, 0.9, 1.4)) return false;
    return true;
  }

  _spawnCar(type, lane, s, x, y, z) {
    const g = this.game;
    const yaw = Math.atan2(lane.dx, lane.dz);
    const def = VEHICLE_TYPES[type];
    const color = def && def.colors && def.colors.length ? def.colors[Math.floor(Math.random() * def.colors.length)] : undefined;
    let v = null;
    try { v = g.vehicles.spawn(type, x, y, z, yaw, { color }); } catch (e) { console.warn('[traffic] spawn failed', e); return false; }
    if (!v) return false;
    const d = new TrafficDriver(this, v, lane, s, { look: this._looks[Math.floor(Math.random() * this._looks.length)] });
    v.ai = d;
    v.driver = 'ai';
    v.parked = false;
    v.setDriverLook?.(d.look);
    // roll in at a plausible speed when the road ahead is clear (from a standstill close to a junction, so the
    // driver can still stop at the line)
    const v0 = Math.min(lane.speed * 0.65, 10);
    if (lane.len - s > 22 && this._laneAheadClear(v, lane, s, 26)) v.velocity.set(lane.dx * v0, 0, lane.dz * v0);
    this.cars.push(d);
    this._stats.spawned++;
    return true;
  }

  _laneAheadClear(self, lane, s, dist) {
    for (const o of this.game.vehicles.list) {
      if (o === self) continue;
      const rx = o.position.x - lane.x0, rz = o.position.z - lane.z0;
      const t = rx * lane.dx + rz * lane.dz;
      const lat = rx * -lane.dz + rz * lane.dx; // lane x0/z0 already sit on the lane centre line
      if (t > s - 2 && t < s + dist && Math.abs(lat) < 2.6) return false;
    }
    return true;
  }

  /** Remove a traffic car (and its driver). */
  despawn(d) {
    const g = this.game, v = d.vehicle;
    const i = this.cars.indexOf(d);
    if (i >= 0) this.cars.splice(i, 1);
    d.release();
    if (!v.removed && v !== g.vehicles.playerVehicle && v.driver !== 'player') { v.ai = null; g.vehicles.remove(v); }
    this._stats.despawned++;
  }

  // ============================================================================================ drivers leaving cars

  /**
   * Spawn the driver as a pedestrian next to the driver door (left side) and leave the car.
   * mood: 'flee' | 'fight'. opts: {knocked, jacked, homeVehicle}.
   */
  spawnDriverPed(d, vehicle, mood, opts = {}) {
    const g = this.game;
    const v = vehicle || d.vehicle;
    const p = g.player;
    if (opts.jacked) this._stats.carjacks++;
    else if (mood === 'fight') this._stats.angry++;
    else this._stats.bailed++;
    if (!opts.jacked) {
      // the car is now driverless (when carjacked the Vehicles system hands it to the player)
      if (v.driver === 'ai') v.driver = null;
      if (v.ai === d) v.ai = null;
      v.controls.throttle = 0; v.controls.brake = 1; v.controls.steer = 0;
      g.audio?.play?.('car_door', { position: v.position, volume: 0.7 });
      if (!this.abandoned.includes(v)) this.abandoned.push(v);
    }
    if (!g.peds || typeof g.peds.spawnPed !== 'function') return null;
    const pos = this._doorSpot(v, _v2);
    const ped = g.peds.spawnPed(pos, {
      look: d.look, mood, team: 'civilian', target: p, persistent: false,
      yaw: v.yaw + Math.PI / 2, fromVehicle: v, knocked: !!opts.knocked, homeVehicle: opts.homeVehicle || null,
    });
    if (ped && opts.jacked && ped.velocity) {
      // dragged out of the seat: a shove away from the door
      const lx = Math.cos(v.yaw), lz = -Math.sin(v.yaw);
      ped.velocity.x += lx * 2.6; ped.velocity.z += lz * 2.6; ped.velocity.y += 2;
    }
    return ped;
  }

  _bailOut(d, mood) {
    const v = d.vehicle;
    d.state = 'stopped';
    this.spawnDriverPed(d, v, mood, { homeVehicle: null });
    d.release();
  }

  /** Free standing spot beside the driver door (falls back to the other side / behind). */
  _doorSpot(v, out) {
    const g = this.game, w = g.world;
    const sides = [[1, 0.55], [1, 1.2], [-1, 0.55], [0, 0]];
    for (const [side, extra] of sides) {
      if (side === 0) {
        const hl = (v.def ? v.def.size.l : 4.5) / 2 + 0.8;
        out.set(v.position.x - Math.sin(v.yaw) * hl, v.position.y, v.position.z - Math.cos(v.yaw) * hl);
      } else if (typeof v.getDoorPosition === 'function') v.getDoorPosition(out, side, extra);
      else {
        const hw = (v.def ? v.def.size.w : 2) / 2 + extra;
        out.set(v.position.x + side * Math.cos(v.yaw) * hw, v.position.y, v.position.z - side * Math.sin(v.yaw) * hw);
      }
      if (!w || !boxCollides(w, out.x, out.y + 0.05, out.z, 0.3, 1.75)) return out;
    }
    return out;
  }

  _onDamaged(e) {
    if (!e || !e.entity) return;
    const v = e.entity;
    const d = v.ai;
    if (!(d instanceof TrafficDriver) || d.released) return;
    const g = this.game, info = e.info || {};
    const src = info.source;
    const byPlayer = src && (src === g.player || src.driver === 'player');
    if (info.type === 'bullet' || info.type === 'explosion') {
      const sx = src && src.position ? src.position.x : v.position.x, sz = src && src.position ? src.position.z : v.position.z;
      // shot at: floor it, or bail out of a wrecked car
      if (v.health < v.maxHealth * 0.35 && chance(0.5) && Math.abs(v.speed) < 6) this._bailOut(d, 'flee');
      else d.panic(sx, sz, rand(8, 12));
    } else if (info.type === 'melee' && byPlayer) {
      d.rammedByPlayer(3, null);
    } else if (info.type === 'vehicle' && byPlayer) {
      d.rammedByPlayer(Math.min(20, (e.amount || 0) / 13 + 5), src.driver === 'player' ? src : g.vehicles?.playerVehicle);
    }
  }

  // ============================================================================================ junctions

  _st(nodeId) {
    let st = this._jst.get(nodeId);
    if (!st) { st = { occ: [], wait: [] }; this._jst.set(nodeId, st); }
    return st;
  }

  /**
   * May `me` enter junction j now (via conn)? Crossing cars inside the box always block; cars waiting at the front of
   * a crossing queue that arrived earlier block too, unless ignoreOrder (after a long wait).
   */
  canEnter(me, j, conn, ignoreOrder = false) {
    const st = this._jst.get(j.id);
    const axis = conn.from.axis;
    if (st) {
      for (const o of st.occ) {
        if (o === me || o.released || !o.resConn) continue;
        const oc = o.resConn;
        if (oc.from.axis !== axis) return false;
        const opposite = oc.from.dx * conn.from.dx + oc.from.dz * conn.from.dz < -0.5;
        if (opposite && (conn.turn === 'left') !== (oc.turn === 'left')) return false;
      }
      if (!ignoreOrder) {
        for (const w of st.wait) {
          if (w === me || w.released || w.resNode === j.id || w.queued) continue;
          if (w.waitAxis !== axis && w.arriveT < me.arriveT) return false;
        }
      }
    }
    // other vehicles (player, police, ...) crossing the box right now
    const b = j.box;
    for (const o of this.game.vehicles.list) {
      if (o === me.vehicle || (o.ai instanceof TrafficDriver && !o.ai.released) || o.destroyed) continue;
      const x = o.position.x, z = o.position.z;
      if (x < b.x0 - 2 || x > b.x1 + 2 || z < b.z0 - 2 || z > b.z1 + 2) continue;
      const vx = o.velocity.x, vz = o.velocity.z;
      if (vx * vx + vz * vz < 2.25) continue;
      if ((Math.abs(vx) > Math.abs(vz) ? 0 : 1) !== axis) return false;
    }
    return true;
  }

  reserve(me, conn) {
    if (me.resNode === conn.node) return;
    this.unreserve(me);
    this.leaveWaiting(me);
    this._st(conn.node).occ.push(me);
    me.resNode = conn.node;
    me.resConn = conn;
    me.resT = this.game.time;
  }

  unreserve(me) {
    if (me.resNode < 0) return;
    const st = this._jst.get(me.resNode);
    if (st) { const i = st.occ.indexOf(me); if (i >= 0) st.occ.splice(i, 1); }
    me.resNode = -1;
    me.resConn = null;
  }

  addWaiting(me, nodeId) {
    this.leaveWaiting(me);
    this._st(nodeId).wait.push(me);
    me.waitNode = nodeId;
  }

  leaveWaiting(me) {
    if (me.waitNode === undefined || me.waitNode < 0) return;
    const st = this._jst.get(me.waitNode);
    if (st) { const i = st.wait.indexOf(me); if (i >= 0) st.wait.splice(i, 1); }
    me.waitNode = -1;
  }

  leaveJunctions(me) {
    this.unreserve(me);
    this.leaveWaiting(me);
    me.arriveNode = -1;
  }

  _cleanJunctions() {
    const t = this.game.time;
    for (const st of this._jst.values()) {
      for (let i = st.occ.length - 1; i >= 0; i--) {
        const o = st.occ[i];
        if (o.released || t - o.resT > 12) { st.occ.splice(i, 1); if (!o.released) { o.resNode = -1; o.resConn = null; } }
      }
      for (let i = st.wait.length - 1; i >= 0; i--) {
        const o = st.wait[i];
        if (o.released || t - o.arriveT > 30) { st.wait.splice(i, 1); o.waitNode = -1; }
      }
    }
  }

  // ============================================================================================ queries used by drivers

  /** Is the parallel lane free around arc length s (for lane changes)? */
  laneClear(me, lane, s) {
    for (const o of this.game.vehicles.list) {
      if (o === me.vehicle) continue;
      const rx = o.position.x - lane.x0, rz = o.position.z - lane.z0;
      const t = rx * lane.dx + rz * lane.dz;
      const lat = rx * -lane.dz + rz * lane.dx;
      if (Math.abs(lat) < 2.2 && t > s - 10 && t < s + 14) return false;
    }
    return true;
  }

  /** Is the corridor at lateral offset `lat` (from our route) clear for `dist` metres ahead (overtaking)? */
  corridorClear(me, lat, dist) {
    const v = me.vehicle, halfW = v.def.size.w / 2;
    for (const o of this.game.vehicles.list) {
      if (o === v || o === me.obsRef) continue;
      const rx = o.position.x - v.position.x, rz = o.position.z - v.position.z;
      if (rx * rx + rz * rz > (dist + 25) * (dist + 25)) continue;
      me.routeSample(Math.max(0, me.s), _s);
      const along = rx * _s.tx + rz * _s.tz;
      if (along < -4 || along > dist + (o.velocity ? Math.max(0, -(o.velocity.x * _s.tx + o.velocity.z * _s.tz)) * 4.5 : 0)) continue;
      me.routeSample(me.s + Math.max(0, along), _s);
      const ol = (o.position.x - _s.x) * -_s.tz + (o.position.z - _s.z) * _s.tx;
      const ow = o.def ? Math.max(o.def.size.w, o.def.size.l * 0.5) / 2 : 1.2;
      if (Math.abs(ol - lat) < halfW + ow + 0.6) return false;
    }
    // never pass close to people (the player, peds, officers by a stopped cruiser)
    return this.swerveClear(me, me.lat, lat, dist);
  }

  /**
   * Is the sideways move from lateral `fromLat` to `toLat` (relative to me's route; + = right) clear of people over the
   * next `dist` metres? The move is modelled as a smooth transition over ~10 m of travel and the car body (length +
   * width) is swept along it. Required clearance: 1.2 m (the player: 3 m, i.e. ~4 m from the swerve path).
   */
  swerveClear(me, fromLat, toLat, dist) {
    const g = this.game, ents = g.entities, v = me.vehicle;
    if (!ents || !ents.query) return true;
    const halfW = v.def.size.w / 2, halfL = v.def.size.l / 2;
    const ltr = Math.max(10, Math.abs(v.speed || 0) * 1.8);
    me.routeSample(Math.max(0, me.s) + dist * 0.5, _s);
    _v.set(_s.x, v.position.y + 1, _s.z);
    const found = ents.query(_v, dist * 0.5 + halfL + 6, humanFilter, this._qOut2);
    if (!found.length) return true;
    me.routeSample(Math.max(0, me.s), _s);
    const hx = _s.tx, hz = _s.tz;
    for (let i = 0; i < found.length; i++) {
      const e = found[i];
      const rx = e.position.x - v.position.x, rz = e.position.z - v.position.z;
      const along = rx * hx + rz * hz;
      if (along < -halfL - 1.5 || along > dist + halfL) continue;
      me.routeSample(Math.max(0, me.s + along), _s);
      const el = (e.position.x - _s.x) * -_s.tz + (e.position.z - _s.z) * _s.tx;
      // car centre travel while its body overlaps the person's position along the route
      const a = swerveLat(fromLat, toLat, Math.max(0, along - halfL), ltr), b = swerveLat(fromLat, toLat, Math.max(0, along + halfL), ltr);
      const m = halfW + (e.radius || 0.3) + (e === g.player ? 3 : 1.2);
      if (el > Math.min(a, b) - m && el < Math.max(a, b) + m) return false;
    }
    return true;
  }

  /** A vehicle with its siren on is coming up behind `me`. */
  sirenBehind(me) {
    const v = me.vehicle;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    for (const o of this.game.vehicles.list) {
      if (!o.sirenOn || o === v || o.isHeli) continue;
      const rx = o.position.x - v.position.x, rz = o.position.z - v.position.z;
      const along = rx * fx + rz * fz;
      if (along > -4 || along < -45) continue;
      if (Math.abs(rx * -fz + rz * fx) > 7) continue;
      if (o.velocity.x * fx + o.velocity.z * fz > 3) return true;
    }
    return false;
  }

  // ============================================================================================ debug

  _installDebug() {
    const g = this.game, d = g.debug, self = this;
    if (!d) return;
    /** Traffic statistics: car count, average speed, off-road count, states. */
    d.trafficStats = () => self.stats();
    /** Per-car debug rows. */
    d.trafficInfo = () => self.cars.map((c) => c.debugInfo());
    /** Spawn n extra traffic cars (ignores the frustum; within the normal ring). */
    d.spawnTraffic = (n = 5) => {
      const focus = g.player.position;
      self._refreshNearLanes(focus);
      let k = 0;
      for (let i = 0; i < n * 4 && k < n; i++) if (self._trySpawn(focus, 'fill')) k++;
      return k;
    };
    /** Carjack the nearest traffic car (as Vehicles does on F): spawns the driver ped, gives the car to the player. */
    d.carjackNearest = (maxDist = 60) => {
      const p = g.player;
      let best = null, bd = maxDist;
      for (const c of self.cars) {
        const dd = c.vehicle.position.distanceTo(p.position);
        if (dd < bd) { bd = dd; best = c; }
      }
      if (!best) return null;
      const v = best.vehicle;
      if (g.vehicles.enter) g.vehicles.enter(v, { force: true });
      else { best.onCarjacked(v); best.release(); }
      return { type: v.type, dist: +bd.toFixed(1), driver: v.driver };
    };
    /** Panic all drivers around a point (defaults to the player). */
    d.trafficPanic = (radius = 60) => { self.panicAt(g.player.position, radius); return self.stats().panicking; };
    /** Run the navigation self-test against the live plan. */
    d.navSelfTest = () => runNavSelfTest(g.generator.plan);
  }
}
