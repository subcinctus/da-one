// Police system (ARCHITECTURE.md §Police, POLICE agent): wanted level + heat, crime handling, dispatch of police
// cars / SWAT / helicopter / roadblocks by star level, GTA V style evasion (line of sight, search area, evade timer),
// BUSTED flow, sirens, minimap blips and debug helpers.
//
// Files: police_const (tuning), police_util (LOS, aiming), police_roads (road graph routing), police_car (cruisers),
// police_officer (cops on foot), police_heli (helicopter), police_crime (crime -> stars rules).
//
// Public API (contract): wanted (0-5), addHeat(points, reason), setWanted(n), clearWanted(), getBlips(out),
//   plus: searching (bool: police lost sight), isSearching, lastKnown {x, z}, evadeTimer (s until wanted clears),
//   heat, knows, policy ('none'|'arrest'|'shoot'|'hold'), busting, searchRadius(), reveal(), copWitness(pos),
//   copNear(pos, r), units() (debug snapshot).
// Debug: game.debug.setWanted(n), clearWanted(), policeStats(), spawnCop(dist), spawnPoliceCar(role).
import * as THREE from 'three';
import { clamp } from '../core/math.js';
import { WORLD } from '../core/config.js';
import { TUNE, LEVELS, carsFor, evadeSeconds, searchRadius, hitChance, MIN_HIT_GAP } from './police_const.js';
import { RoadNet } from './police_roads.js';
import { PoliceCar } from './police_car.js';
import { HeliUnit } from './police_heli.js';
import { Officer } from './police_officer.js';
import { CrimeLedger } from './police_crime.js';
import { losClear, pointInView, groundAt, isWaterAt, speedOf, playerArmed, playerAimPoint, rand, chance } from './police_util.js';

const _aim = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _down = new THREE.Vector3(0, -1, 0);
const RED = '#ff2d2d', BLUE = '#3b6dff';

export class Police {
  constructor(game) {
    this.game = game;
    /** Wanted level 0-5 (stars). */
    this.wanted = 0;
    /** Fractional heat: wanted = floor(heat). Crimes add heat; small offences accumulate. */
    this.heat = 0;
    /** True while wanted and no unit currently sees the player (HUD flashes the stars). */
    this.searching = false;
    /** Where the police last saw the player (centre of the search area). */
    this.lastKnown = { x: 0, z: 0 };
    /** Seconds left before the wanted level clears (counts down only while hidden). */
    this.evadeTimer = 0;
    /** The police currently know where the player is (seen within the last SEEN_GRACE seconds). */
    this.knows = false;
    /** How officers treat the suspect right now: 'none' | 'arrest' | 'shoot' | 'hold'. */
    this.policy = 'none';
    /** BUSTED sequence running. */
    this.busting = false;
    this.bustProgress = 0;
    this.seenT = -1e9;
    this.trackUntil = 0;
    this.levelT = 0;
    this.cars = [];
    this.officers = [];
    this.heli = null;
    this.roadblock = [];
    this.guards = [];
    this.roads = null;
    this.crimes = new CrimeLedger(this);
    this._bustT = 0;
    this._frozeByUs = false;
    this._tokens = new Set();
    this._incidentT = -1e9;
    this._incidentPts = 0;
    this._nextCarT = 0;
    this._nextSwatT = 0;
    this._nextHeliT = 0;
    this._nextRoadblockT = 0;
    this._patrolT = 8;
    this._guardT = 0;
    this._manageT = 0;
    this._slot = 0;
    this._copAttackT = -1e9;
    this._sirens = new Map();
    this._sep = { x: 0, z: 0 };
    this._ign = [null, null];
    this._spot = null;
    this._beam = null;
    this._deferred = [];
    this._hitAcc = 0;
    this._lastHitT = -1e9;
    this.stats = { cars: 0, officers: 0, helis: 0, roadblocks: 0, busts: 0, evasions: 0, shots: 0, hitRolls: 0, pSum: 0 };
  }

  get isSearching() { return this.searching; }

  // ============================================================================================ lifecycle

  init() {
    const g = this.game;
    const plan = g.generator && g.generator.plan;
    if (plan) {
      try { this.roads = new RoadNet(plan); } catch (e) { console.warn('[police] road graph unavailable', e); this.roads = null; }
    }
    if (g.player && g.player.position) { this.lastKnown.x = g.player.position.x; this.lastKnown.z = g.player.position.z; }
    const ev = g.events;
    ev.on('entityDamaged', (e) => this.crimes.onDamaged(e));
    ev.on('entityKilled', (e) => this.crimes.onKilled(e));
    ev.on('crime', (e) => this.crimes.onCrime(e));
    ev.on('gunfire', (e) => this.crimes.onGunfire(e));
    ev.on('explosion', (e) => this.crimes.onExplosion(e));
    ev.on('vehicleEnter', (e) => this.crimes.onVehicleEnter(e));
    ev.on('playerDied', () => this._onPlayerDied());
    this._buildSearchlight();
    this._installDebug();
  }

  _buildSearchlight() {
    const g = this.game;
    if (!g.scene) return;
    // kept in the scene at intensity 0 (never toggled) so no shader recompiles when the heli shows up
    const sp = new THREE.SpotLight(0xeef3ff, 0, 120, 0.22, 0.5, 1.25);
    sp.castShadow = false;
    const tgt = new THREE.Object3D();
    sp.target = tgt;
    g.scene.add(sp, tgt);
    this._spot = sp;
    this._spotTarget = tgt;
    const geo = new THREE.CylinderGeometry(0.06, 1, 1, 18, 1, true);
    geo.translate(0, -0.5, 0); // apex at the origin, opening toward -Y
    const mat = new THREE.MeshBasicMaterial({ color: 0xdfe9ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this._beam = new THREE.Mesh(geo, mat);
    this._beam.visible = false;
    this._beam.frustumCulled = false;
    this._beam.renderOrder = 3;
    g.scene.add(this._beam);
  }

  // ============================================================================================ public API

  /** Search-area radius for the current wanted level (m). */
  searchRadius() { return searchRadius(Math.max(1, this.wanted)); }

  /** Add heat from a crime. 1 point = 1 star. Returns the wanted level. */
  addHeat(points, reason = '', pos = null) {
    points = Number(points);
    const pl = this.game.player;
    if (!(points > 0) || !pl || pl.alive === false || this.busting) return this.wanted;
    const now = this.game.time || 0;
    if (now - this._incidentT > TUNE.INCIDENT_WINDOW) { this._incidentT = now; this._incidentPts = 0; }
    const p = Math.min(points, Math.max(0, TUNE.INCIDENT_CAP - this._incidentPts));
    if (p > 0) {
      this._incidentPts += p;
      this.heat = Math.min(5.999, Math.max(this.heat, this.wanted) + p);
      const lvl = Math.min(5, Math.floor(this.heat + 1e-6));
      if (lvl > this.wanted) this._setLevel(lvl, reason);
    }
    if (this.wanted > 0) this.reveal();
    void pos;
    return this.wanted;
  }

  /** Set the wanted level directly (0-5). */
  setWanted(n) {
    n = clamp(Math.round(Number(n) || 0), 0, 5);
    if (n === 0) { this.clearWanted(); return; }
    this.heat = n;
    if (n !== this.wanted) this._setLevel(n, 'set');
    this.reveal();
  }

  /** Clear the wanted level (Pay 'n' Spray, missions, busted, death). Units disperse. */
  clearWanted() {
    if (this.wanted === 0 && this.heat === 0) return;
    const prev = this.wanted;
    this.wanted = 0;
    this.heat = 0;
    this.searching = false;
    this.evadeTimer = 0;
    this.knows = false;
    this.levelT = 0;
    this.trackUntil = 0;
    this._incidentPts = 0;
    this._hitAcc = 0;
    if (prev !== 0) this.game.events.emit('wantedChanged', { level: 0, prev });
    this._disperse();
  }

  /**
   * The police learn the player's current position (crime reported, shots near cops, officer attacked...).
   * Dispatch keeps tracking the suspect for `track` seconds afterwards (radio reports), then sight is needed again.
   */
  reveal(track = TUNE.REPORT_TRACK) {
    if (this.wanted <= 0) return;
    const pl = this.game.player;
    if (!pl || !pl.position) return;
    const pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
    const now = this.game.time || 0;
    this.seenT = now;
    this.trackUntil = Math.max(this.trackUntil || 0, now + track);
    this.lastKnown.x = pp.x; this.lastKnown.z = pp.z;
    this.knows = true;
    this.searching = false;
  }

  /** Is a crime at pos witnessed by a cop (officer / crewed car within 40 m with line of sight, or the heli)? */
  copWitness(pos) {
    if (!pos) return false;
    const w = this.game.world, R = TUNE.WITNESS_RANGE;
    const ty = pos.y + 1.0;
    for (const o of this.officers) {
      if (!o.alive || o.removed || o.state === 'knocked') continue;
      const d = Math.hypot(o.position.x - pos.x, o.position.z - pos.z);
      if (d > R) continue;
      if (d < TUNE.SENSE_RANGE || losClear(w, o.position.x, o.position.y + 1.6, o.position.z, pos.x, ty, pos.z)) return true;
    }
    for (const c of this.cars) {
      const v = c.vehicle;
      if (!v || !c.carAlive || c.crew <= 0) continue;
      const d = Math.hypot(v.position.x - pos.x, v.position.z - pos.z);
      if (d > R) continue;
      if (d < 8 || losClear(w, v.position.x, v.position.y + 1.7, v.position.z, pos.x, ty, pos.z)) return true;
    }
    const h = this.heli && this.heli.vehicle;
    if (h && this.heli.carAlive) {
      const d = Math.hypot(h.position.x - pos.x, h.position.z - pos.z);
      if (d < 60 && losClear(w, h.position.x, h.position.y - 0.4, h.position.z, pos.x, ty, pos.z)) return true;
    }
    return false;
  }

  /** Any cop (officer, crewed car, heli) within r metres of pos? (hearing range: no line of sight needed) */
  copNear(pos, r) {
    if (!pos) return false;
    for (const o of this.officers) if (o.alive && !o.removed && Math.hypot(o.position.x - pos.x, o.position.z - pos.z) < r) return true;
    for (const c of this.cars) {
      const v = c.vehicle;
      if (v && c.carAlive && c.crew > 0 && Math.hypot(v.position.x - pos.x, v.position.z - pos.z) < r) return true;
    }
    const h = this.heli && this.heli.vehicle;
    return !!(h && this.heli.carAlive && Math.hypot(h.position.x - pos.x, h.position.z - pos.z) < r);
  }

  /** Any living pedestrian within r metres (they call the cops)? */
  civiliansNear(pos, r) {
    const list = this.game.peds && this.game.peds.list;
    if (!pos || !Array.isArray(list)) return false;
    for (const p of list) {
      if (!p || p.alive === false || !p.position || p.team === 'gang') continue;
      if (Math.hypot(p.position.x - pos.x, p.position.z - pos.z) < r) return true;
    }
    return false;
  }

  // ============================================================================================ heat / levels

  _setLevel(n, reason) {
    const g = this.game;
    const prev = this.wanted;
    if (n === prev) return;
    this.wanted = n;
    this.levelT = 0;
    if (prev === 0) {
      // fresh chase: dispatch at once from the crime scene
      const now = g.time || 0;
      this._nextCarT = now;
      this._nextSwatT = now;
      this._nextHeliT = now;
      this._nextRoadblockT = now + 6;
      this._tokens.clear();
      this.trackUntil = 0;
      this.reveal(TUNE.DISPATCH_TRACK);
    }
    if (n > prev) g.audio?.play?.('wanted_up', { volume: 1 });
    g.events.emit('wantedChanged', { level: n, prev, reason });
  }

  _evaded() {
    const g = this.game;
    const prev = this.wanted;
    this.wanted = 0;
    this.heat = 0;
    this.searching = false;
    this.evadeTimer = 0;
    this.knows = false;
    this.levelT = 0;
    this.trackUntil = 0;
    this._incidentPts = 0;
    this.stats.evasions++;
    g.events.emit('wantedChanged', { level: 0, prev, reason: 'evaded' });
    g.audio?.play?.('wanted_lost', { volume: 1 });
    g.hud?.notify?.('You lost the cops', { duration: 3.5 });
    this._disperse();
  }

  /** Chase over: units go home (despawned out of view). */
  _disperse() {
    this._tokens.forEach((o) => { o.hasToken = false; });
    this._tokens.clear();
    for (const c of this.cars) {
      if (!c.carAlive) continue;
      if (c.state === 'pursue' || c.state === 'search') c.setState('leave');
      else if (c.state === 'stopped' || c.state === 'roadblock') c.recall('leave');
    }
    for (const o of this.officers) {
      if (!o.alive || o.removed) continue;
      if (o.state === 'engage' || o.state === 'hold' || o.state === 'exit') {
        if (o.unit && o.unit.carAlive) o.setState('return');
        else o.setState(o.post ? 'guard' : 'leave');
      }
    }
    if (this.heli) this.heli.state = 'leave';
    this.roadblock.length = 0;
  }

  _onPlayerDied() {
    const pl = this.game.player;
    this.busting = false;
    this.bustProgress = 0;
    this._bustT = 0;
    if (this._frozeByUs && pl) { pl.frozen = false; this._frozeByUs = false; }
    this.clearWanted();
  }

  // ============================================================================================ frame

  /** Run fn after `delay` seconds of game time (staggered crew exits etc). */
  defer(delay, fn) { this._deferred.push({ t: (this.game.time || 0) + delay, fn }); }

  update(dt) {
    const g = this.game, pl = g.player;
    if (!pl || !pl.position) return;
    this.levelT += dt;
    if (this._deferred.length) {
      const now = g.time || 0;
      for (let i = this._deferred.length - 1; i >= 0; i--) {
        const d = this._deferred[i];
        if (d.t > now) continue;
        this._deferred.splice(i, 1);
        try { d.fn(); } catch (e) { console.warn('[police] deferred', e); }
      }
    }
    // partial heat (fractional offences) slowly cools down
    if (this.heat > this.wanted) this.heat = Math.max(this.wanted, this.heat - dt * 0.01);
    // shared hit accumulator bleeds off during lulls (no banked hit when the player leaves cover)
    if (this._hitAcc > 0) this._hitAcc = Math.max(0, this._hitAcc - dt * 0.12);
    this._updatePolicy();
    this._perceive(dt);
    this._evasion();
    this._manageT -= dt;
    if (this._manageT <= 0) {
      this._manageT = 0.5;
      try { this._manage(); } catch (e) { if (!this._manageErr) { this._manageErr = true; console.warn('[police] manage', e); } }
    }
    for (let i = this.cars.length - 1; i >= 0; i--) this.cars[i].update(dt);
    if (this.heli) this.heli.update(dt);
    for (let i = this.officers.length - 1; i >= 0; i--) {
      const o = this.officers[i];
      if (o.removed) { this.officers.splice(i, 1); continue; }
      o.update(dt);
    }
    this._bust(dt);
    this._updateSirens();
    this._updateSpot(dt);
  }

  _updatePolicy() {
    const g = this.game, pl = g.player;
    if (!pl || pl.alive === false || this.wanted <= 0) { this.policy = 'none'; return; }
    if (this.busting) { this.policy = 'hold'; return; }
    const lethal = (LEVELS[this.wanted] || LEVELS[1]).lethal;
    if (lethal === 'never') this.policy = 'arrest';
    else if (lethal === 'armed') {
      const now = g.time || 0;
      this.policy = playerArmed(g) || pl.inVehicle || now - this._copAttackT < 20 ? 'shoot' : 'arrest';
    } else this.policy = 'shoot';
  }

  // ---------------------------------------------------------------- perception (line of sight, ~4 Hz per unit)
  _perceive(dt) {
    const g = this.game, pl = g.player, w = g.world;
    const alive = pl.alive !== false;
    const pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
    playerAimPoint(pl, _aim);
    const headY = pl.inVehicle ? _aim.y : pl.position.y + 1.7;
    const canSee = (ex, ey, ez, range) => {
      if (!alive) return false;
      const d = Math.hypot(pp.x - ex, pp.z - ez);
      if (d > range) return false;
      if (d < TUNE.SENSE_RANGE && Math.abs(pp.y - ey) < 6) return true;
      return losClear(w, ex, ey, ez, _aim.x, _aim.y, _aim.z) || (!pl.inVehicle && losClear(w, ex, ey, ez, pp.x, headY, pp.z));
    };
    let seen = false;
    for (const c of this.cars) {
      const v = c.vehicle;
      if (!v || !c.carAlive || c.crew <= 0) { c.sees = false; continue; }
      c.losT -= dt;
      if (c.losT <= 0) {
        c.losT = TUNE.LOS_INTERVAL * (0.8 + Math.random() * 0.4);
        c.sees = canSee(v.position.x, v.position.y + 1.7, v.position.z, TUNE.LOS_RANGE);
      }
      if (c.sees && c.state !== 'leave') seen = true;
    }
    for (const o of this.officers) {
      if (!o.alive || o.removed || o.state === 'knocked') { o.los = false; continue; }
      o.losT -= dt;
      if (o.losT <= 0) {
        o.losT = TUNE.LOS_INTERVAL * (0.8 + Math.random() * 0.4);
        o.los = canSee(o.position.x, o.position.y + 1.6, o.position.z, TUNE.LOS_RANGE);
      }
      if (o.los && o.state !== 'leave') seen = true;
    }
    const h = this.heli;
    if (h && h.carAlive) {
      h.losT -= dt;
      if (h.losT <= 0) {
        h.losT = TUNE.LOS_INTERVAL * (0.8 + Math.random() * 0.4);
        const hv = h.vehicle;
        const d3 = Math.hypot(pp.x - hv.position.x, pp.y - hv.position.y, pp.z - hv.position.z);
        h.sees = alive && d3 <= TUNE.HELI_LOS_RANGE && canSee(hv.position.x, hv.position.y - 0.4, hv.position.z, TUNE.HELI_LOS_RANGE);
      }
      if (h.sees && h.state !== 'leave') seen = true;
    }
    if (this.wanted > 0 && (g.time || 0) < (this.trackUntil || 0)) seen = true;
    if (seen && this.wanted > 0 && alive && !this.busting) {
      this.seenT = g.time || 0;
      this.lastKnown.x = pp.x; this.lastKnown.z = pp.z;
    }
    this.knows = this.wanted > 0 && (g.time || 0) - this.seenT <= TUNE.SEEN_GRACE;
  }

  _evasion() {
    if (this.wanted <= 0) { this.searching = false; this.evadeTimer = 0; return; }
    const dur = evadeSeconds(this.wanted);
    if (this.busting) { this.searching = false; this.evadeTimer = dur; return; }
    const hidden = (this.game.time || 0) - this.seenT;
    this.searching = hidden > TUNE.SEEN_GRACE;
    this.evadeTimer = this.searching ? Math.max(0, dur - hidden) : dur;
    if (hidden >= dur) this._evaded();
  }

  // ---------------------------------------------------------------- dispatch / streaming (2 Hz)
  _manage() {
    const g = this.game, pl = g.player, now = g.time || 0;
    const pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
    const alive = pl.alive !== false;
    this._cleanup(pp, now);
    // drop stale attack tokens
    for (const o of this._tokens) if (!o.alive || o.removed || o.state !== 'engage') { this._tokens.delete(o); o.hasToken = false; }
    if (this.wanted > 0 && alive && !this.busting) {
      const L = LEVELS[this.wanted];
      const want = carsFor(this.wanted, this.levelT);
      let active = this._activeCars(false);
      // nearby units that were leaving (or patrolling) rejoin first
      if (active < want) {
        for (const c of this.cars) {
          if (active >= want) break;
          if (!c.carAlive || c.swat || c.crew <= 0) continue;
          if ((c.state === 'leave' || c.state === 'patrol') && c.distToPlayer < 160) { c.role = 'pursuit'; c.setState('pursue'); this.chirp(c); active++; }
        }
      }
      if (active < want && now >= this._nextCarT) {
        if (this._spawnCar(false, 'pursuit')) this._nextCarT = now + 0.4;
        else this._nextCarT = now + 1.5;
      }
      if (L.swat > 0 && this._activeCars(true) < L.swat && now >= this._nextSwatT) {
        if (this._spawnCar(true, 'pursuit')) this._nextSwatT = now + 1;
        else this._nextSwatT = now + 2;
      }
      if (L.heli > 0 && !this.heli && now >= this._nextHeliT) {
        if (!this._spawnHeli()) this._nextHeliT = now + 3;
      }
      if (L.roadblocks && pl.inVehicle && !this.roadblock.some((c) => c.carAlive && c.state === 'roadblock') && now >= this._nextRoadblockT) {
        if (!this._spawnRoadblock()) this._nextRoadblockT = now + 2.5;
      }
    } else if (this.wanted === 0 && alive && !this.busting) {
      this._ambient(pp, now);
    }
    this._manageGuards(pp, now);
  }

  /** Pursuing cruisers (or SWAT vans) currently in the chase. */
  _activeCars(swat) {
    let n = 0;
    for (const c of this.cars) {
      if (!c.carAlive || !!c.swat !== swat || c.role === 'roadblock' || c.role === 'patrol') continue;
      if (c.state === 'leave') continue;
      n++;
    }
    return n;
  }

  /** True if the chase is short of cruisers (roadblock units then join instead of leaving). */
  needsCars() { return this.wanted > 0 && this._activeCars(false) < carsFor(this.wanted, this.levelT); }

  /** Free slots for officers on foot. */
  footRoom() {
    let n = 0;
    for (const o of this.officers) if (o.alive && !o.removed && !o.post) n++;
    return Math.max(0, TUNE.MAX_FOOT_OFFICERS - n);
  }

  _cleanup(pp, now) {
    const g = this.game;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.removed || !c.vehicle) { this.cars.splice(i, 1); continue; }
      const v = c.vehicle;
      const d = c.distToPlayer;
      const inView = d < 190 && pointInView(g, v.position.x, v.position.y + 1, v.position.z, 190);
      let drop = false;
      if (c.state === 'leave' && c.officers.length === 0) drop = (d > 90 && !inView) || d > 170;
      else if (c.role === 'patrol' && c.state === 'patrol') {
        drop = d > 210 || (d > 120 && !inView && c.stateT > 80);
        if (drop) this._patrolT = now + rand(12, 25);
      } else if (d > TUNE.RELOCATE_DIST && !inView) {
        drop = true;
        if (this.wanted > 0) this._nextCarT = Math.min(this._nextCarT, now + 1.5);
      } else if (v.position.y < -10) drop = true;
      if (drop) { c.dispose(); this.cars.splice(i, 1); }
    }
    this.roadblock = this.roadblock.filter((c) => !c.removed && c.vehicle);
    if (this.heli) {
      const h = this.heli;
      if (h.removed || !h.vehicle) this.heli = null;
      else if (h.state === 'leave' && (h.distToPlayer > 140 || h.stateT > 25)) { h.dispose(); this.heli = null; }
      else if (h.distToPlayer > TUNE.RELOCATE_DIST + 40) { h.dispose(); this.heli = null; this._nextHeliT = now + 2; }
    }
    for (let i = this.officers.length - 1; i >= 0; i--) {
      const o = this.officers[i];
      if (o.removed) { this.officers.splice(i, 1); continue; }
      const d = o.distToPlayer;
      let drop = false;
      if (!o.alive) {
        const inView = d < 90 && pointInView(g, o.position.x, o.position.y + 0.5, o.position.z, 90);
        drop = o.deadT > 40 || (o.deadT > 15 && !inView) || d > 120;
      } else if (o.post) drop = d > 170;
      else if (o.state === 'leave' && !o.unit) {
        const inView = d < 90 && pointInView(g, o.position.x, o.position.y + 1, o.position.z, 90);
        drop = (d > 40 && !inView) || d > 110 || (o.stateT > 40 && !inView);
      } else if (d > TUNE.RELOCATE_DIST * 0.75) drop = !pointInView(g, o.position.x, o.position.y + 1, o.position.z, 200);
      if (drop) {
        o.despawn();
        this.officers.splice(i, 1);
        const gi = this.guards.indexOf(o);
        if (gi >= 0) this.guards.splice(gi, 1);
      }
    }
  }

  // ---------------------------------------------------------------- spawning
  /** Accept a spawn point: dry land, out of view, no vehicle on top of it. */
  _spawnOk(x, z, minD = 0) {
    const g = this.game;
    if (isWaterAt(g, x, z)) return false;
    if (x < 6 || z < 6 || x > WORLD.SIZE_X - 6 || z > WORLD.SIZE_Z - 6) return false;
    const y = groundAt(g, x, z);
    if (!(y > 0)) return false;
    if (pointInView(g, x, y + 1, z, 175)) return false;
    const vs = g.vehicles;
    if (vs && typeof vs.findNearest === 'function' && vs.findNearest({ x, y, z }, 7)) return false;
    const pl = g.player;
    if (minD > 0 && pl && Math.hypot(pl.position.x - x, pl.position.z - z) < minD) return false;
    return true;
  }

  _spawnPoint(minD, maxD) {
    const g = this.game, pl = g.player;
    let pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
    // while the player is hidden, reinforcements converge on the search area, not on the player
    const searchMin = this.searching && this.wanted > 0 ? 55 : 0;
    if (searchMin > 0) pp = { x: this.lastKnown.x, y: pp.y, z: this.lastKnown.z };
    const accept = (x, z) => this._spawnOk(x, z, searchMin);
    let pt = this.roads && this.roads.ok ? this.roads.spawnPoint(pp.x, pp.z, minD, maxD, accept, 70) : null;
    if (!pt && this.roads && this.roads.ok) pt = this.roads.spawnPoint(pp.x, pp.z, minD * 0.7, maxD * 1.5, accept, 70);
    if (!pt) {
      // countryside / no roads: open ground around the player, facing them
      for (let i = 0; i < 30 && !pt; i++) {
        const a = Math.random() * Math.PI * 2, r = rand(minD, maxD);
        const x = pp.x + Math.cos(a) * r, z = pp.z + Math.sin(a) * r;
        if (accept(x, z)) pt = { x, z, yaw: Math.atan2(pp.x - x, pp.z - z) };
      }
    }
    return pt;
  }

  _spawnCar(swat, role) {
    const g = this.game, vs = g.vehicles;
    if (!vs || typeof vs.spawn !== 'function') return this._spawnFootUnit(swat);
    const pt = role === 'patrol' ? this._spawnPoint(90, 140) : this._spawnPoint(TUNE.SPAWN_MIN, TUNE.SPAWN_MAX);
    if (!pt) return null;
    const y = groundAt(g, pt.x, pt.z);
    let v = null;
    try { v = vs.spawn(swat ? 'swat' : 'police', pt.x, y > 0 ? y : undefined, pt.z, pt.yaw, {}); } catch (e) { v = null; }
    if (!v) return this._spawnFootUnit(swat);
    const unit = new PoliceCar(this, v, { swat, role, slot: this._slot++ });
    if (role === 'pursuit') {
      // already responding: rolling, not parked
      v.velocity.x = Math.sin(pt.yaw) * 7;
      v.velocity.z = Math.cos(pt.yaw) * 7;
    }
    this.cars.push(unit);
    this.stats.cars++;
    return unit;
  }

  /** Fallback when there are no vehicles: two officers on foot appear out of view. */
  _spawnFootUnit(swat) {
    if (this.footRoom() < 2) return null;
    const pt = this._spawnPoint(45, 75);
    if (!pt) return null;
    const y = groundAt(this.game, pt.x, pt.z);
    if (!(y > 0)) return null;
    let n = 0;
    for (let i = 0; i < 2; i++) {
      const o = this.spawnOfficer(new THREE.Vector3(pt.x + i * 1.2, y, pt.z + i * 0.8), { swat, yaw: pt.yaw, state: 'engage' });
      if (o) n++;
    }
    return n ? { foot: true } : null;
  }

  _spawnHeli() {
    const g = this.game, vs = g.vehicles, pl = g.player;
    if (!vs || typeof vs.spawn !== 'function') return null;
    const pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
    // come in from behind the camera
    let a0 = Math.random() * Math.PI * 2;
    if (g.camera) { g.camera.getWorldDirection(_v); a0 = Math.atan2(-_v.z, -_v.x) + rand(-0.9, 0.9); }
    const r = 135;
    const x = clamp(pp.x + Math.cos(a0) * r, 12, WORLD.SIZE_X - 12), z = clamp(pp.z + Math.sin(a0) * r, 12, WORLD.SIZE_Z - 12);
    const y = Math.min(WORLD.HEIGHT + 12, Math.max(pp.y + 40, 70));
    let v = null;
    try { v = vs.spawn('police_heli', x, y, z, Math.atan2(pp.x - x, pp.z - z), { flying: true }); } catch (e) { v = null; }
    if (!v) return null;
    v.velocity.x = Math.sin(v.yaw) * 14;
    v.velocity.z = Math.cos(v.yaw) * 14;
    this.heli = new HeliUnit(this, v);
    this.stats.helis++;
    return this.heli;
  }

  /** 5 stars: two cruisers parked across the road ahead of the player's car, officers behind them. */
  _spawnRoadblock() {
    const g = this.game, vs = g.vehicles, pl = g.player, R = this.roads;
    const pv = pl.inVehicle;
    if (!pv || !R || !R.ok || !vs || typeof vs.spawn !== 'function') return false;
    const sp = speedOf(pv);
    if (sp < 8) return false;
    const hx = pv.velocity.x / sp, hz = pv.velocity.z / sp;
    // beyond the fog line first (pops in unseen), then closer sites that are out of view
    const site = R.roadblockSite(pv.position.x, pv.position.z, hx, hz, 98, 160) || R.roadblockSite(pv.position.x, pv.position.z, hx, hz, 70, 160);
    if (!site) return false;
    const y = groundAt(g, site.x, site.z);
    if (!(y > 0) || isWaterAt(g, site.x, site.z)) return false;
    if (pointInView(g, site.x, y + 1, site.z, 95)) return false;
    // clear the spot of traffic
    if (typeof vs.findNearest === 'function' && vs.findNearest({ x: site.x, y, z: site.z }, 8)) return false;
    const dx = Math.sin(site.yaw), dz = Math.cos(site.yaw);
    const rx = -dz, rz = dx;
    const half = 2.45;
    const units = [];
    for (let i = 0; i < 2; i++) {
      const k = i === 0 ? -half : half;
      const x = site.x + rx * k, z = site.z + rz * k;
      const yaw = site.yaw + Math.PI / 2 + (i === 0 ? 1 : -1) * rand(0.08, 0.3) + (i === 0 ? 0 : Math.PI);
      let v = null;
      try { v = vs.spawn('police', x, y, z, yaw, {}); } catch (e) { v = null; }
      if (!v) continue;
      const u = new PoliceCar(this, v, { role: 'roadblock', crew: 0, slot: this._slot++ });
      u.site = { x: site.x, z: site.z, yaw: site.yaw };
      v.driver = null;
      v.sirenOn = true;
      this.cars.push(u);
      units.push(u);
      // two officers take cover behind each car (further along the road, away from the oncoming player)
      for (let j = 0; j < 2 && this.footRoom() > 0; j++) {
        const lat = k + (j === 0 ? -1.2 : 1.2);
        const ox = site.x + rx * lat + dx * 3.2, oz = site.z + rz * lat + dz * 3.2;
        const oy = groundAt(g, ox, oz, y + 2);
        const o = this.spawnOfficer(new THREE.Vector3(ox, oy > 0 ? oy : y, oz), { unit: u, yaw: site.yaw + Math.PI, state: 'engage', cover: { x: ox, z: oz } });
        if (o) u.officers.push(o);
      }
    }
    if (!units.length) return false;
    this.roadblock = units;
    this._nextRoadblockT = (g.time || 0) + TUNE.ROADBLOCK_COOLDOWN;
    this.stats.roadblocks++;
    return true;
  }

  /** Spawn one officer entity (used by cars, roadblocks, guards, debug). */
  spawnOfficer(pos, opts = {}) {
    const g = this.game;
    let o = null;
    try { o = new Officer(this, pos, opts); } catch (e) { console.warn('[police] officer spawn failed', e); return null; }
    g.entities?.add?.(o);
    this.officers.push(o);
    this.stats.officers++;
    return o;
  }

  /** Officer left the world through a car door. */
  forgetOfficer(o) {
    const i = this.officers.indexOf(o);
    if (i >= 0) this.officers.splice(i, 1);
    this._tokens.delete(o);
  }

  // ---------------------------------------------------------------- ambient police (0 stars)
  _ambient(pp, now) {
    const g = this.game, plan = g.generator && g.generator.plan;
    const inCity = !!(plan && typeof plan.isCity === 'function' && plan.isCity(pp.x, pp.z));
    const patrol = this.cars.some((c) => c.carAlive && c.role === 'patrol');
    if (!patrol && inCity && now >= this._patrolT && g.player && !g.player.inVehicle?.isHeli) {
      if (!this._spawnCar(false, 'patrol')) this._patrolT = now + 4;
      else this._patrolT = now + 30;
    }
  }

  _manageGuards(pp, now) {
    const g = this.game, plan = g.generator && g.generator.plan;
    if (!plan || typeof plan.poisOfType !== 'function') return;
    const pois = plan.poisOfType('police') || [];
    let poi = null, bd = Infinity;
    for (const p of pois) { const d = Math.hypot(p.x - pp.x, p.z - pp.z); if (d < bd) { bd = d; poi = p; } }
    if (!poi) return;
    this.guards = this.guards.filter((o) => !o.removed);
    const living = this.guards.filter((o) => o.alive).length;
    if (this.wanted > 0 || this.busting || bd > 110 || living >= 2 || now < this._guardT) return;
    if (bd < 55 && pointInView(g, poi.x, (poi.y || WORLD.CITY_LEVEL) + 1, poi.z, 120)) return;
    // stand either side of the entrance, facing the street
    const s = Math.sin(poi.yaw), c = Math.cos(poi.yaw);
    for (let i = this.guards.length; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const x = poi.x - c * 2.8 * side - s * 0.6, z = poi.z + s * 2.8 * side - c * 0.6;
      const y = groundAt(g, x, z, (poi.y || WORLD.CITY_LEVEL) + 2);
      if (!(y > 0)) continue;
      const post = { x, y, z, yaw: poi.yaw + Math.PI };
      const o = this.spawnOfficer(new THREE.Vector3(x, y, z), { yaw: post.yaw, state: 'guard', post });
      if (o) this.guards.push(o);
    }
    this._guardT = now + 5;
  }

  // ---------------------------------------------------------------- unit callbacks
  onUnitLost(unit) {
    const now = this.game.time || 0;
    if (unit.role === 'patrol') { this._patrolT = now + 35; return; }
    if (unit.role === 'roadblock') return;
    if (unit.swat) this._nextSwatT = Math.max(this._nextSwatT, now + TUNE.RESPAWN_DELAY * 1.5);
    else this._nextCarT = Math.max(this._nextCarT, now + TUNE.RESPAWN_DELAY);
  }

  onHeliLost(h) {
    if (this.heli === h) this.heli = null;
    this._nextHeliT = (this.game.time || 0) + TUNE.HELI_RESPAWN;
    if (h && h.vehicle === null && this.game.player) this.game.hud?.notify?.('Police chopper down!', { duration: 2.5 });
  }

  onCarCrewKilled(unit, n) { void unit; void n; }

  onRam(unit, imp) {
    const v = unit.vehicle;
    if (v && imp > 10 && typeof v.honk === 'function' && chance(0.4)) v.honk(0.3);
  }

  /** A car keeps getting stuck: recycle it out of view, or let the crew continue on foot. */
  onUnitHopeless(unit) {
    const g = this.game, v = unit.vehicle, pl = g.player;
    if (!v) return;
    unit.stuckCount = 0;
    const inView = pointInView(g, v.position.x, v.position.y + 1, v.position.z, 150);
    if (!inView && unit.distToPlayer > 45) {
      unit.dispose();
      const i = this.cars.indexOf(unit);
      if (i >= 0) this.cars.splice(i, 1);
      if (this.wanted > 0) this._nextCarT = Math.min(this._nextCarT, (g.time || 0) + 1);
    } else if (pl && !pl.inVehicle && unit.distToPlayer < 70 && this.wanted > 0) unit.unload('exit');
  }

  onOfficerHurt(o, info) {
    if (info && info.source === this.game.player && this.wanted > 0 && o.distToPlayer < TUNE.LOS_RANGE * 1.3) this.reveal();
  }

  onCopAttacked(e, info) {
    void e; void info;
    this._copAttackT = this.game.time || 0;
  }

  onOfficerDown(o, info) {
    const g = this.game;
    this._tokens.delete(o);
    if (o.unit) {
      const i = o.unit.officers.indexOf(o);
      if (i >= 0) o.unit.officers.splice(i, 1);
      o.unit = null;
    }
    if (o.post) this._guardT = (g.time || 0) + 90;
    // dead cops drop their ammo (SWAT sometimes their SMG)
    const pk = g.pickups;
    if (pk && typeof pk.spawn === 'function') {
      const pos = { x: o.position.x + rand(-0.3, 0.3), y: o.position.y, z: o.position.z + rand(-0.3, 0.3) };
      try {
        if (o.swat && chance(0.4)) pk.spawn('weapon:smg', pos, 30, {});
        else pk.spawn(o.def.drop, pos, Math.round(rand(o.def.dropAmount[0], o.def.dropAmount[1])), {});
      } catch (e) { /* pickups stub */ }
    }
    void info;
  }

  chirp(unit) {
    const v = unit && unit.vehicle;
    if (v && unit.distToPlayer < 90) this.game.audio?.play?.('siren_chirp', { position: v.position, volume: 0.9 });
  }

  // ---------------------------------------------------------------- combat helpers (used by officers / cars / heli)
  takeToken(o) {
    if (this._tokens.has(o)) return true;
    const L = LEVELS[this.wanted] || LEVELS[0];
    if (this._tokens.size >= L.shooters) return false;
    this._tokens.add(o);
    o.hasToken = true;
    return true;
  }

  releaseToken(o) {
    this._tokens.delete(o);
    o.hasToken = false;
  }

  /** Probability that one shot from officer o (or a car passenger when o is null) hits. */
  shotHitChance(o, dist, aimT) {
    const L = LEVELS[this.wanted] || LEVELS[1];
    const pl = this.game.player;
    const base = L.hit + (o && o.def ? o.def.hitBonus : 0);
    const ts = pl.inVehicle ? speedOf(pl.inVehicle) : speedOf(pl);
    return hitChance(base, dist, ts, aimT, !!pl.inVehicle, !!pl.crouching);
  }

  /**
   * Decide whether one police shot with probability p hits the player. Shared across all shooters: a pseudo-random
   * accumulator spreads hits evenly (no lucky / unlucky streaks) and a minimum gap between hits prevents burst deaths.
   */
  rollHit(p) {
    const now = this.game.time || 0;
    this._hitAcc = (this._hitAcc || 0) + Math.max(0, p);
    if (this._hitAcc < 0.55 + Math.random() * 0.45) return false;
    if (now - (this._lastHitT || -1e9) < MIN_HIT_GAP[Math.min(5, this.wanted)]) return false;
    this._hitAcc = Math.max(0, this._hitAcc - 1);
    this._lastHitT = now;
    return true;
  }

  /** Is another police entity (officer or police vehicle) in the line of fire? */
  friendlyInLine(origin, dir, dist, selfOfficer, selfVehicle = null) {
    const ents = this.game.entities;
    if (!ents || typeof ents.raycast !== 'function') return false;
    this._ign[0] = selfOfficer || null;
    this._ign[1] = selfVehicle || null;
    let hit = null;
    try {
      hit = ents.raycast(origin, dir, Math.max(0, dist - 1.2), this._ign, (e) => e.team === 'police' && (e.alive !== false || e.kind === 'vehicle'));
    } catch (e) { hit = null; }
    return !!hit;
  }

  /** Push-apart velocity for an officer (other officers + the player). Returns a shared {x, z}. */
  separation(o) {
    const s = this._sep;
    s.x = 0; s.z = 0;
    for (const q of this.officers) {
      if (q === o || !q.alive || q.removed) continue;
      const dx = o.position.x - q.position.x, dz = o.position.z - q.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.81 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), k = ((0.9 - d) / 0.9) * 2.6;
      s.x += (dx / d) * k; s.z += (dz / d) * k;
    }
    const pl = this.game.player;
    if (pl && !pl.inVehicle && pl.position && pl.alive !== false) {
      const dx = o.position.x - pl.position.x, dz = o.position.z - pl.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.64 && d2 > 1e-6) { const d = Math.sqrt(d2), k = ((0.8 - d) / 0.8) * 3; s.x += (dx / d) * k; s.z += (dz / d) * k; }
    }
    return s;
  }

  // ---------------------------------------------------------------- BUSTED
  _bust(dt) {
    const g = this.game, pl = g.player;
    if (this.busting) {
      this._bustT += dt;
      pl.frozen = true;
      if (pl.velocity) { pl.velocity.x = 0; pl.velocity.z = 0; }
      if (this._bustT >= TUNE.BUST_FREEZE) this._finishBust();
      return;
    }
    if (this.wanted < 1 || pl.alive === false || pl.inVehicle) { this.bustProgress = Math.max(0, this.bustProgress - dt * 2); return; }
    // giving up = standing / walking slowly, crouching, or hands up (player.handsUp, if Player exposes it)
    const slow = speedOf(pl) < TUNE.BUST_SPEED || !!pl.crouching || !!pl.handsUp;
    let cop = null;
    if (slow) {
      for (const o of this.officers) {
        if (!o.alive || o.removed || o.state === 'knocked' || o.state === 'dead' || o.state === 'leave' || o.state === 'return') continue;
        if (Math.abs(o.position.y - pl.position.y) > 1.6) continue;
        if (Math.hypot(o.position.x - pl.position.x, o.position.z - pl.position.z) <= TUNE.BUST_RANGE) { cop = o; break; }
      }
    }
    if (cop) {
      this.bustProgress += dt;
      if (this.bustProgress > 0.25) g.hud?.prompt?.('Officer: "Freeze! You\'re under arrest!" - move to resist');
      if (this.bustProgress >= TUNE.BUST_TIME) this._startBust();
    } else this.bustProgress = Math.max(0, this.bustProgress - dt * 1.5);
  }

  _startBust() {
    const g = this.game, pl = g.player;
    this.busting = true;
    this._bustT = 0;
    this.bustProgress = 0;
    this._tokens.forEach((o) => { o.hasToken = false; o.burst = 0; });
    this._tokens.clear();
    this.policy = 'hold';
    pl.frozen = true;
    this._frozeByUs = true;
    if (pl.velocity) { pl.velocity.x = 0; pl.velocity.z = 0; }
    for (const o of this.officers) if (o.alive && !o.removed && o.distToPlayer < 35 && o.state !== 'knocked') o.setState('hold');
    g.audio?.play?.('siren_chirp', { position: pl.position, volume: 0.8 });
    this.stats.busts++;
    g.events.emit('busted', {});
  }

  _finishBust() {
    const g = this.game, pl = g.player, plan = g.generator && g.generator.plan;
    this.busting = false;
    this._bustT = 0;
    // nearest police station
    let poi = null, bd = Infinity;
    const pois = plan && typeof plan.poisOfType === 'function' ? plan.poisOfType('police') || [] : [];
    for (const p of pois) { const d = Math.hypot(p.x - pl.position.x, p.z - pl.position.z); if (d < bd) { bd = d; poi = p; } }
    const money = Number(pl.money) || 0;
    const fine = Math.floor(money * TUNE.BUST_FINE);
    try {
      if (typeof pl.respawn === 'function') pl.respawn(poi || (plan && plan.spawn) || null, 'busted');
    } catch (e) { console.warn('[police] respawn after bust failed', e); }
    try { g.inventory?.clearWeapons?.(); } catch (e) { /* inventory stub */ }
    if (fine > 0) { try { pl.addMoney?.(-fine, 'busted'); } catch (e) { /* player stub */ } }
    pl.frozen = false;
    this._frozeByUs = false;
    this.clearWanted();
    // the chase happened far away: remove it at once
    for (const c of this.cars) if (c.role !== 'patrol') c.dispose();
    this.cars = this.cars.filter((c) => !c.removed);
    if (this.heli) { this.heli.dispose(); this.heli = null; }
    for (const o of this.officers) if (!o.post) o.despawn();
    this.officers = this.officers.filter((o) => !o.removed);
    this.roadblock.length = 0;
    g.hud?.notify?.(fine > 0 ? `Busted! Weapons confiscated and fined $${fine.toLocaleString('en-US')}.` : 'Busted! Your weapons were confiscated.', { duration: 5 });
  }

  // ---------------------------------------------------------------- sirens + searchlight
  _updateSirens() {
    const au = this.game.audio;
    const chasing = this._chasing || (this._chasing = []);
    chasing.length = 0;
    for (const c of this.cars) {
      const v = c.vehicle;
      if (!v || !c.carAlive || v.driver !== 'ai' || !v.sirenOn || (c.state !== 'pursue' && c.state !== 'search')) continue;
      if (c.distToPlayer > 200) continue;
      chasing.push(c);
    }
    chasing.sort((a, b) => a.distToPlayer - b.distToPlayer);
    if (chasing.length > 3) chasing.length = 3;
    for (const [c, h] of this._sirens) {
      if (!chasing.includes(c)) { try { h.stop(); } catch (e) { /* ignore */ } this._sirens.delete(c); }
    }
    if (au && typeof au.siren === 'function') {
      for (const c of chasing) {
        if (this._sirens.has(c)) continue;
        let h = null;
        try { h = au.siren(); } catch (e) { h = null; }
        if (h) this._sirens.set(c, h);
      }
    }
    for (const [c, h] of this._sirens) { try { h.setPosition?.(c.vehicle.position); } catch (e) { /* ignore */ } }
  }

  /** Stop a unit's siren sound (crew got out, car lost, despawn). */
  stopSiren(unit) {
    const h = this._sirens.get(unit);
    if (!h) return;
    try { h.stop(); } catch (e) { /* ignore */ }
    this._sirens.delete(unit);
  }

  _updateSpot(dt) {
    const sp = this._spot, beam = this._beam, g = this.game;
    if (!sp) return;
    const h = this.heli;
    const night = g.sky && Number.isFinite(g.sky.nightFactor) ? g.sky.nightFactor : 0;
    if (!h || !h.carAlive || night < 0.3) {
      sp.intensity = 0;
      if (beam) beam.visible = false;
      return;
    }
    const k = clamp((night - 0.3) / 0.35, 0, 1);
    const v = h.vehicle;
    if (typeof v.localToWorld === 'function') v.localToWorld(0, -0.15, 2.4, _v); else _v.set(v.position.x, v.position.y - 0.2, v.position.z);
    sp.position.copy(_v);
    this._spotTarget.position.set(h.lightX, h.lightY, h.lightZ);
    this._spotTarget.updateMatrixWorld();
    const dx = h.lightX - _v.x, dy = h.lightY - _v.y, dz = h.lightZ - _v.z;
    const dist = Math.max(4, Math.hypot(dx, dy, dz));
    sp.distance = dist + 45;
    sp.angle = clamp(Math.atan(5 / dist), 0.07, 0.4);
    sp.intensity = 480 * k;
    if (beam) {
      beam.visible = true;
      beam.position.copy(_v);
      const r = Math.tan(sp.angle) * dist * 0.92;
      beam.scale.set(r, dist, r);
      _aim.set(dx / dist, dy / dist, dz / dist);
      _q.setFromUnitVectors(_down, _aim);
      beam.quaternion.copy(_q);
      beam.material.opacity = 0.11 * k * (0.9 + 0.1 * Math.sin((g.realTime || 0) * 13));
    }
    void dt;
  }

  // ============================================================================================ minimap

  /** Cop cars / officers as flashing red-blue dots, the heli as a triangle, the search area as a ring. */
  getBlips(out) {
    if (this.wanted <= 0 && !this.busting) return;
    const t = this.game.realTime || 0;
    const phase = Math.floor(t * 4);
    for (const c of this.cars) {
      const v = c.vehicle;
      if (!v || !c.carAlive) continue;
      out.push({ x: v.position.x, z: v.position.z, color: (phase + c.blipPhase) % 2 ? RED : BLUE, shape: 'dot', size: c.swat ? 5.5 : 4.8 });
    }
    for (const o of this.officers) {
      if (!o.alive || o.removed) continue;
      out.push({ x: o.position.x, z: o.position.z, color: (phase + (o.id & 1)) % 2 ? RED : BLUE, shape: 'dot', size: 3.2 });
    }
    const h = this.heli;
    if (h && h.carAlive) out.push({ x: h.vehicle.position.x, z: h.vehicle.position.z, color: phase % 2 ? RED : BLUE, shape: 'triangle', size: 7 });
    if (this.searching && this.wanted > 0) {
      out.push({ x: this.lastKnown.x, z: this.lastKnown.z, color: '#ff3b30', radius: this.searchRadius(), flash: true });
    }
  }

  // ============================================================================================ debug

  /** Snapshot of all units (debug / tests). */
  units() {
    const r1 = (n) => Math.round(n * 10) / 10;
    return {
      cars: this.cars.map((c) => ({
        role: c.role, state: c.state, swat: c.swat, crew: c.crew, onFoot: c.officers.length, mode: c.mode,
        dist: r1(c.distToPlayer), speed: c.vehicle ? r1(c.vehicle.speed) : null, sees: c.sees, alive: c.carAlive,
        pos: c.vehicle ? [r1(c.vehicle.position.x), r1(c.vehicle.position.y), r1(c.vehicle.position.z)] : null,
      })),
      officers: this.officers.map((o) => ({ state: o.state, alive: o.alive, swat: o.swat, dist: r1(o.distToPlayer), los: o.los, hp: Math.round(o.health), post: !!o.post })),
      heli: this.heli && this.heli.vehicle ? { state: this.heli.state, dist: r1(this.heli.distToPlayer), alt: r1(this.heli.vehicle.position.y), sees: this.heli.sees, hp: Math.round(this.heli.vehicle.health) } : null,
    };
  }

  _installDebug() {
    const g = this.game, d = g.debug, self = this;
    if (!d) return;
    /** Set the wanted level (0-5). */
    d.setWanted = (n) => { self.setWanted(n); return self.wanted; };
    d.clearWanted = () => { self.clearWanted(); return self.wanted; };
    /** Police state snapshot. */
    d.policeStats = () => ({
      wanted: self.wanted, heat: +self.heat.toFixed(2), searching: self.searching, knows: self.knows,
      evadeTimer: +self.evadeTimer.toFixed(2), lastKnown: { x: +self.lastKnown.x.toFixed(1), z: +self.lastKnown.z.toFixed(1) },
      policy: self.policy, busting: self.busting, bustProgress: +self.bustProgress.toFixed(2), tokens: self._tokens.size,
      searchRadius: self.wanted > 0 ? self.searchRadius() : 0, roads: !!(self.roads && self.roads.ok),
      counts: {
        cars: self.cars.filter((c) => c.carAlive).length, officers: self.officers.filter((o) => o.alive).length,
        corpses: self.officers.filter((o) => !o.alive).length, heli: !!(self.heli && self.heli.carAlive), roadblock: self.roadblock.length,
      },
      ...self.units(),
      crimes: self.crimes.log.slice(-10),
      stats: { ...self.stats },
    });
    /** Spawn an officer `dist` metres in front of the player (state 'engage' by default). */
    d.spawnCop = (dist = 6, opts = {}) => {
      const p = g.player;
      if (!p) return null;
      const yaw = g.cameraRig ? g.cameraRig.yaw : p.yaw || 0;
      const x = p.position.x + Math.sin(yaw) * dist, z = p.position.z + Math.cos(yaw) * dist;
      const y = groundAt(g, x, z, p.position.y + 3);
      const o = self.spawnOfficer(new THREE.Vector3(x, y > 0 ? y : p.position.y, z), { yaw: yaw + Math.PI, state: opts.state || 'engage', swat: !!opts.swat });
      return o ? o.id : null;
    };
    /** Spawn a police car unit now (role 'pursuit' | 'patrol'). */
    d.spawnPoliceCar = (role = 'pursuit', swat = false) => { const u = self._spawnCar(!!swat, role); return u && u.vehicle ? u.vehicle.position.toArray().map((n) => +n.toFixed(1)) : null; };
    d.spawnPoliceHeli = () => { const h = self._spawnHeli(); return !!h; };
    d.policeRoadblock = () => self._spawnRoadblock();
  }
}
